"""Optional real flight times from FlightAware's AeroAPI.

Everything else FlightBoard knows about a flight is a static lookup: the route
is a callsign-to-airports table and the ETA is distance over ground speed.
AeroAPI knows the actual departure and the estimated arrival, at a price: it is
metered, so this module is built around not spending money by accident.

  * Off unless FLIGHTBOARD_AEROAPI_KEY is set. Nothing here runs without it.
  * Only the aircraft nearest home are ever asked about (the ones a display is
    actually showing), each at most once per cache window.
  * A monthly dollar cap, kept on disk so a restart does not reset it. When it
    is reached the module goes quiet until the calendar month rolls over.
  * Every failure - a bad key, no subscription, no credit, a rate limit, the
    network being down - degrades to "no AeroAPI data" and the board carries on
    with its own estimates. Nothing here can blank or slow the display: the poll
    loop only ever reads a cache, and the lookups happen in a worker.
"""

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import config

log = logging.getLogger("flightboard.aeroapi")

BASE_URL = "https://aeroapi.flightaware.com/aeroapi"

# States a display or the debug band can report. "ok" and "idle" are healthy;
# the rest say why nothing is being fetched.
OK = "ok"
OFF = "off"                  # no key configured
BAD_KEY = "bad-key"          # 401: the key is wrong or revoked
NO_ACCESS = "no-access"      # 403: the account's plan does not cover this
NO_CREDIT = "no-credit"      # 402: billing or credit problem on the account
BUDGET = "budget"            # our own monthly cap is reached
LIMITED = "rate-limited"     # 429: too many calls a minute; brief backoff
DOWN = "unreachable"         # network trouble or a 5xx; brief backoff

# How long each kind of failure pauses lookups. Account problems get a long
# pause, since asking again in a minute cannot fix them - but not forever, so
# topping up credit or fixing a key heals without a restart.
_PAUSE_S = {BAD_KEY: 3600, NO_ACCESS: 3600, NO_CREDIT: 3600, LIMITED: 90, DOWN: 60}

# The free Personal tier allows 10 calls a minute, so 7 seconds apart is safe.
_MIN_GAP_S = 7.0

_MAX_QUEUE = 50

_cache: dict[str, dict] = {}         # ident -> {"data": {...} | None, "ts": float}
_queue: asyncio.Queue = asyncio.Queue()
_queued: set[str] = set()
_status = {"state": OK if config.AEROAPI_KEY else OFF, "detail": None,
           "until": 0.0, "last_ok": None}
_usage = {"month": None, "calls": 0, "spent": 0.0}


def enabled():
    return bool(config.AEROAPI_KEY)


# --- the monthly budget ------------------------------------------------------

def _this_month():
    return datetime.now(timezone.utc).strftime("%Y-%m")


def _load_usage():
    try:
        raw = json.loads(Path(config.AEROAPI_USAGE_FILE).read_text(encoding="utf-8"))
        _usage.update(month=raw["month"], calls=int(raw["calls"]),
                      spent=float(raw["spent"]))
    except (OSError, ValueError, KeyError, TypeError):
        pass                        # first run, or unreadable: start from nothing


def _save_usage():
    try:
        path = Path(config.AEROAPI_USAGE_FILE)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(_usage), encoding="utf-8")
        tmp.replace(path)           # a crash mid-write never leaves half a file
    except OSError as e:
        # Losing the count is the one failure that could overspend, so say so.
        log.warning("could not save AeroAPI usage to %s: %s",
                    config.AEROAPI_USAGE_FILE, e)


def _roll_month():
    if _usage["month"] != _this_month():
        _usage.update(month=_this_month(), calls=0, spent=0.0)
        _save_usage()


def _within_budget():
    _roll_month()
    return _usage["spent"] + config.AEROAPI_CALL_COST <= config.AEROAPI_MONTHLY_CAP


# --- what the rest of the app reads -----------------------------------------

def _parse_time(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _pick(flights):
    """The flight that is airborne now, out of AeroAPI's recent-and-upcoming list.

    A callsign is reused every day, so the list holds yesterday's, today's and
    tomorrow's. Only one has taken off and not yet landed.
    """
    for f in flights or []:
        if f.get("actual_off") and not f.get("actual_on") and not f.get("cancelled"):
            return f
    return None


def _summarise(f):
    """The handful of fields the board uses, as epoch seconds."""
    out = {
        "off": _parse_time(f.get("actual_off")),
        "sched_off": _parse_time(f.get("scheduled_off")),
        "sched_in": _parse_time(f.get("scheduled_in")),
        "eta": _parse_time(f.get("estimated_in") or f.get("estimated_on")),
    }
    if out["eta"] and out["sched_in"]:
        out["delay_min"] = round((out["eta"] - out["sched_in"]) / 60)
    return out


def get(ident):
    """What AeroAPI said about this flight, or None. Never blocks, never spends."""
    hit = _cache.get(ident)
    return hit["data"] if hit else None


def wanted(idents):
    """Ask for these flights if they are not already known or being fetched.

    Called with the aircraft nearest home only, so the money goes on flights
    someone can actually see.
    """
    if not enabled() or not _serving():
        return
    now = time.time()
    for ident in idents:
        hit = _cache.get(ident)
        if hit and now - hit["ts"] < config.AEROAPI_TTL:
            continue
        if ident in _queued or len(_queued) >= _MAX_QUEUE:
            continue
        _queued.add(ident)
        _queue.put_nowait(ident)


def _serving():
    """False while paused for a failure or a spent budget."""
    if _status["until"] and time.time() < _status["until"]:
        return False
    if not _within_budget():
        _status.update(state=BUDGET,
                       detail=f"${_usage['spent']:.2f} of ${config.AEROAPI_MONTHLY_CAP:.2f} used")
        return False
    if _status["state"] in (BUDGET, LIMITED, DOWN, BAD_KEY, NO_ACCESS, NO_CREDIT):
        _status.update(state=OK, detail=None, until=0.0)     # a pause has run out
    return True


def status():
    """Everything a display or debug band needs, safe to serialise."""
    _roll_month()
    return {
        "enabled": enabled(),
        "state": _status["state"],
        "detail": _status["detail"],
        "month": _usage["month"],
        "calls": _usage["calls"],
        "spent": round(_usage["spent"], 3),
        "cap": config.AEROAPI_MONTHLY_CAP,
        "cached": sum(1 for v in _cache.values() if v["data"]),
    }


# --- the worker --------------------------------------------------------------

def _fail(state, detail):
    first = _status["state"] != state
    _status.update(state=state, detail=detail,
                   until=time.time() + _PAUSE_S[state])
    # once per change of state, not once per lookup: a dead key would otherwise
    # write a warning every seven seconds
    if first:
        log.warning("AeroAPI paused (%s): %s. Carrying on with FlightBoard's own "
                    "estimates; retrying in %d min.",
                    state, detail, _PAUSE_S[state] // 60)


_FAILED = object()


async def _fetch(client, ident):
    """One lookup: the summary, None for "they know of no such flight", or
    _FAILED when the call itself did not work (status says why)."""
    try:
        r = await client.get(f"{BASE_URL}/flights/{ident}",
                             headers={"x-apikey": config.AEROAPI_KEY},
                             params={"max_pages": 1}, timeout=10)
    except httpx.HTTPError as e:
        _fail(DOWN, f"{type(e).__name__}: {e}")
        return _FAILED

    code = r.status_code
    if code == 200:
        # Only a 200 is billed, so only a 200 counts against the cap.
        _roll_month()
        _usage["calls"] += 1
        _usage["spent"] += config.AEROAPI_CALL_COST
        _save_usage()
        _status.update(state=OK, detail=None, until=0.0, last_ok=time.time())
        try:
            f = _pick(r.json().get("flights"))
        except ValueError:
            return _FAILED
        return _summarise(f) if f else None
    if code == 401:
        _fail(BAD_KEY, "the API key was rejected")
    elif code == 402:
        _fail(NO_CREDIT, "the account has no credit or a billing problem")
    elif code == 403:
        _fail(NO_ACCESS, "the account's plan does not include this")
    elif code == 429:
        try:
            wait = int(r.headers.get("retry-after", ""))
        except ValueError:
            wait = _PAUSE_S[LIMITED]
        _status.update(state=LIMITED, detail="too many requests",
                       until=time.time() + max(wait, 5))
    elif code >= 500:
        _fail(DOWN, f"AeroAPI answered {code}")
    else:
        # 404 and friends: this flight is unknown to them, which is an answer,
        # not a fault. Cache the emptiness so we do not ask again straight away.
        log.debug("AeroAPI %s for %s", code, ident)
        return None
    return _FAILED


async def worker():
    """Drains the queue, one lookup at a time, no faster than the plan allows."""
    _load_usage()
    _roll_month()
    log.info("AeroAPI enabled: cap $%.2f a month, $%.2f used so far in %s",
             config.AEROAPI_MONTHLY_CAP, _usage["spent"], _usage["month"])
    async with httpx.AsyncClient() as client:
        while True:
            ident = await _queue.get()
            _queued.discard(ident)
            try:
                if not _serving():
                    continue        # dropped, not deferred: it is re-wanted next poll
                data = await _fetch(client, ident)
                # A failure is not an answer about the flight; caching it as
                # "nothing" would hide a good result for a whole TTL.
                if data is not _FAILED:
                    _cache[ident] = {"data": data, "ts": time.time()}
            except Exception:
                log.exception("AeroAPI worker error for %s", ident)
            finally:
                _queue.task_done()
            await asyncio.sleep(_MIN_GAP_S)
