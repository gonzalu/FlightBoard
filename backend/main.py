import asyncio
import hashlib
import logging
import math
import re
import time
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import config, filters

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("flightboard")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

_state = {"aircraft": [], "updated": 0.0, "last_error": None, "sources": []}

# Enrichment is looked up out of band: the poll loop only ever reads this cache,
# so a burst of unknown aircraft can never stall the position feed.
_enrich_cache: dict[str, dict] = {}
_lookup_queue: asyncio.Queue = asyncio.Queue()
_queued: set[str] = set()
_MAX_QUEUE = 500


def haversine_nm(lat1, lon1, lat2, lon2):
    r_nm = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r_nm * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    x = math.sin(dlambda) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlambda)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _enqueue(key):
    if key in _queued or len(_queued) >= _MAX_QUEUE:
        return
    _queued.add(key)
    _lookup_queue.put_nowait(key)


def _enrichment(key):
    """Stale-while-revalidate: keep showing what we know while it refreshes.

    Returning None on a stale entry would blank the airline and route off the
    panel for as long as the refetch takes, which looks like data loss.
    """
    hit = _enrich_cache.get(key)
    if hit is None:
        _enqueue(key)
        return None
    if time.time() - hit["ts"] >= config.ENRICH_TTL:
        _enqueue(key)
    return hit["data"]


def _ascii(s):
    """The panel's bitmap font is ASCII only, so fold accents and dashes."""
    if not s:
        return s
    s = s.replace("–", "-").replace("—", "-").replace("’", "'")
    s = unicodedata.normalize("NFKD", s)
    return s.encode("ascii", "ignore").decode("ascii").strip()


def _short_airport(name):
    """'John F Kennedy International Airport' -> 'John F Kennedy Intl'."""
    if not name:
        return None
    s = re.sub(r"\s+Airport$", "", name.strip())
    return _ascii(re.sub(r"\bInternational\b", "Intl", s))


def _airport(a):
    if not a:
        return None
    return {
        "iata": a.get("iata_code"),
        "short": _short_airport(a.get("name")),
        "city": _ascii(a.get("municipality")),
        "lat": a.get("latitude"),
        "lon": a.get("longitude"),
    }


def _parse_route(body):
    route = body.get("response", {}).get("flightroute")
    if not route:
        return None
    return {
        "origin": (route.get("origin") or {}).get("iata_code"),
        "destination": (route.get("destination") or {}).get("iata_code"),
        "airline": _ascii((route.get("airline") or {}).get("name")),
        "from": _airport(route.get("origin")),
        "to": _airport(route.get("destination")),
    }


def _parse_aircraft(body):
    ac = body.get("response", {}).get("aircraft")
    if not ac:
        return None
    return {
        "registration": ac.get("registration"),
        "type": ac.get("type"),
        "manufacturer": ac.get("manufacturer"),
        # adsbdb carries these too, and taking them here means an aircraft is
        # named and badged even when hexdb has never heard of its hex.
        "owner": _ascii(ac.get("registered_owner")),
        "operator_code": (ac.get("registered_owner_operator_flag_code")
                          or "").strip().upper() or None,
    }


def _parse_hexdb_route(body):
    """hexdb.io route: {"flight": "JBU211", "route": "EWR-RSW"}.

    Only a two-airport route is usable. A multi-leg string like "ATL-DAB-ATL"
    doesn't say which leg the aircraft is on, and guessing would put the wrong
    airport on the board. There are no airport records either, only codes, so
    a route from here has no names, no distance and no ETA.
    """
    parts = [p.strip().upper()
             for p in (body.get("route") or "").split("-") if p.strip()]
    if len(parts) != 2:
        return None
    return {
        "origin": parts[0],
        "destination": parts[1],
        "airline": None,
        "from": None,
        "to": None,
    }


def _parse_hexdb_aircraft(body):
    """hexdb.io aircraft record.

    RegisteredOwners is the reason this source is worth asking at all: it is
    frequently the only identity a general-aviation aircraft has, and those are
    a quarter of the traffic over a city.
    """
    if not body.get("Registration") and not body.get("Type"):
        return None
    return {
        "registration": body.get("Registration"),
        "type": _ascii(body.get("Type")),
        "manufacturer": _ascii(body.get("Manufacturer")),
        "owner": _ascii(body.get("RegisteredOwners")),
        # The operator's ICAO code, which is how an aircraft with no airline
        # prefix in its callsign can still be drawn with its airline's mark: a
        # NetJets bizjet flying as N741QS reports EJA here.
        "operator_code": (body.get("OperatorFlagCode") or "").strip().upper() or None,
    }


def _sources(kind, value):
    """Where to look something up, in order, stopping at the first answer.

    adsbdb first because it returns full airport records, which is what gives
    the board place names, a progress bar and an ETA. hexdb second because it
    knows aircraft adsbdb has never heard of - light aircraft and bizjets,
    mostly - and answers with an owner where nothing else will.

    A route stops at the first answer, since adsbdb's is strictly richer. An
    aircraft record is *merged* across both: adsbdb has the better type and
    manufacturer, but only hexdb carries the registered owner, so stopping
    early would silently throw away the one field worth adding.
    """
    if kind == "route":
        return (
            (f"https://api.adsbdb.com/v0/callsign/{value}", _parse_route),
            (f"https://hexdb.io/api/v1/route/iata/{value}", _parse_hexdb_route),
        )
    return (
        (f"https://api.adsbdb.com/v0/aircraft/{value}", _parse_aircraft),
        (f"https://hexdb.io/api/v1/aircraft/{value}", _parse_hexdb_aircraft),
    )


# A route lookup is a static callsign-to-route mapping, not a live flight plan,
# and airlines reuse flight numbers. Measured on live traffic, a genuine route
# puts the aircraft within a few percent of the direct line between its two
# airports; a wrong one leaves it hundreds or thousands of miles off. Both
# thresholds must be exceeded before a route is thrown away.
ROUTE_DETOUR_RATIO = 1.25
ROUTE_DETOUR_NM = 100.0


def _route_fits(leg, lat, lon):
    """Whether this aircraft can plausibly be flying this route.

    SWA1304 is San Francisco to Los Angeles in the database, and was also, one
    afternoon, something at 25 ft over New York. Comparing the distance flown
    via the aircraft against the direct route catches that: 1.00 to 1.06 for
    every genuine route measured, 1.51 and up for every wrong one.
    """
    a, b = leg.get("from"), leg.get("to")
    if not a or not b or a.get("lat") is None or b.get("lat") is None:
        return True                      # no coordinates, nothing to check
    direct = haversine_nm(a["lat"], a["lon"], b["lat"], b["lon"])
    if direct < 1:
        return True
    via = (haversine_nm(lat, lon, a["lat"], a["lon"])
           + haversine_nm(lat, lon, b["lat"], b["lon"]))
    return via - direct <= ROUTE_DETOUR_NM or via / direct <= ROUTE_DETOUR_RATIO


# Feet per minute past which an aircraft is unambiguously going somewhere.
CLIMB_FPM = 500


def _leg(route, lat, lon, gs, vertical_rate=None):
    """Per-aircraft view of a cached route: progress, ETA and which end is home.

    Returns a new dict rather than annotating the cached one, which is shared
    and must not accumulate a particular aircraft's position.
    """
    a, b = route.get("from"), route.get("to")
    out = {
        "origin": route.get("origin"),
        "destination": route.get("destination"),
        "airline": route.get("airline"),
        "from": {k: a[k] for k in ("iata", "short", "city")} if a else None,
        "to": {k: b[k] for k in ("iata", "short", "city")} if b else None,
    }
    if not a or not b or a["lat"] is None or b["lat"] is None:
        return out

    total = haversine_nm(a["lat"], a["lon"], b["lat"], b["lon"])
    if total < 1:
        return out
    # measured from what's left, not from how far it's come: an aircraft
    # vectored off the direct track can exceed the origin-to-destination
    # distance and would otherwise read as 100% with 20 minutes still to fly
    remaining = haversine_nm(lat, lon, b["lat"], b["lon"])
    out["progress"] = round(max(0.0, min(1.0, 1 - remaining / total)), 3)
    # remaining/groundspeed is only honest when the current speed resembles the
    # rest of the flight. A climbing aircraft is far below cruise, and the error
    # compounds with distance: JFK-FRA read 11h44 at 285kt on departure, against
    # a real 7h. So demand a more representative speed the further there is to
    # go, and say nothing rather than quote a number that's hours out.
    # (AeroAPI's estimated_in would replace all of this with a real figure.)
    if gs and gs > 40:
        plausible = remaining <= 150 or gs >= 320 or (remaining <= 1000 and gs >= 250)
        if plausible:
            out["eta_min"] = round(remaining / gs * 60)

    # The aircraft's own vertical rate outranks the route on which way it is
    # going. A Seoul-Anchorage-JFK-Brussels cargo run has JFK at both ends of
    # the day, so the route alone cannot say whether this is the arrival or the
    # departure - but nothing three minutes from landing climbs at 2,500 fpm.
    climbing = vertical_rate is not None and vertical_rate > CLIMB_FPM
    descending = vertical_rate is not None and vertical_rate < -CLIMB_FPM
    if climbing:
        out.pop("progress", None)      # both are measured towards a destination
        out.pop("eta_min", None)       # this aircraft is demonstrably leaving

    home = (config.HOME_LAT, config.HOME_LON)
    if not climbing and haversine_nm(b["lat"], b["lon"], *home) <= config.LOCAL_AIRPORT_NM:
        out["phase"] = "arriving"
    elif not descending and haversine_nm(a["lat"], a["lon"], *home) <= config.LOCAL_AIRPORT_NM:
        out["phase"] = "departing"
    return out


async def _enrich_worker():
    async with httpx.AsyncClient() as client:
        while True:
            key = await _lookup_queue.get()
            _queued.discard(key)
            kind, value = key.split(":", 1)
            data = None
            for url, parse in _sources(kind, value):
                got = None
                try:
                    r = await client.get(url, timeout=5)
                    if r.status_code == 200:
                        got = parse(r.json())
                except Exception as e:
                    log.debug("lookup failed for %s at %s: %s", key, url, e)
                await asyncio.sleep(0.15)   # spaced out, and both are free services
                if not got:
                    continue
                if data is None:
                    data = got
                else:
                    for field, value_ in got.items():      # fill gaps only
                        if value_ and not data.get(field):
                            data[field] = value_
                if kind == "route":
                    break
            # negative results are cached too, so we don't re-ask every cycle
            _enrich_cache[key] = {"data": data, "ts": time.time()}
            _lookup_queue.task_done()


def _receiver_name(url):
    """Short label for a receiver, used in logs and the API's sources field."""
    host = urlparse(url).hostname or url
    # the first label is meaningless for an IP: 10.0.1.60 would become "10",
    # and every receiver on the same subnet would report under one name
    if ":" in host or re.fullmatch(r"[\d.]+", host):
        return host
    return host.split(".")[0]


# Fastest recorded ground speed for an airliner is around 800 kt, a 747 riding
# an exceptional jet stream. Below the transition altitude nothing civil comes
# close, and US airspace caps most traffic at 250 kt there anyway.
MAX_GS_KT = 800.0
MAX_GS_LOW_KT = 450.0
LOW_ALTITUDE_FT = 10000


def _plausible_speed(gs, altitude):
    """Ground speed the aircraft could actually be doing, or None.

    Corrupted ADS-B surfaces as absurd figures: a Delta A321 was reported at
    784 kt over the Bronx at 7,350 ft, and the number moved every poll. Same
    principle as the ETA guard below - say nothing rather than print a figure
    that is certainly wrong.
    """
    if gs is None or gs < 0:
        return None
    ceiling = (MAX_GS_LOW_KT if altitude is not None and altitude < LOW_ALTITUDE_FT
               else MAX_GS_KT)
    return gs if gs <= ceiling else None


def _excluded(rules, hexid, flight, altitude):
    """The exclusions that need only what the aircraft broadcasts.

    Kept separate from the rest so it can run before enrichment: an aircraft
    hidden by hex, airline or altitude then costs no lookups at all. Rules that
    need a lookup first - registration, type, airport - are applied below.
    """
    if hexid and hexid.lower() in rules.hex:
        return True
    if rules.airlines:
        prefix = re.match(r"^([A-Z]{3})\d", flight)
        if prefix and prefix.group(1) in rules.airlines:
            return True
    # An unknown altitude is not a reason to hide an aircraft that is otherwise
    # in range: absent data shouldn't act like a filter nobody configured.
    if altitude is not None:
        if not rules.min_ft <= altitude <= rules.max_ft:
            return True
    return False


def _entry(ac):
    """One aircraft from a receiver, or None if it is out of range or excluded."""
    lat, lon = ac.get("lat"), ac.get("lon")
    if lat is None or lon is None:
        return None
    rules = filters.current()
    dist = haversine_nm(config.HOME_LAT, config.HOME_LON, lat, lon)
    if dist > rules.range_nm:
        return None

    flight = (ac.get("flight") or "").strip()
    alt_raw = ac.get("alt_baro")
    on_ground = alt_raw == "ground"
    altitude = 0 if on_ground else alt_raw
    if _excluded(rules, ac.get("hex"), flight, altitude):
        return None

    entry = {
        "hex": ac.get("hex"),
        "flight": flight,
        "lat": lat,
        "lon": lon,
        "alt_baro": altitude,
        "on_ground": on_ground,
        "gs": _plausible_speed(ac.get("gs"), altitude),
        "track": ac.get("track"),
        "baro_rate": ac.get("baro_rate"),
        "squawk": ac.get("squawk"),
        "category": ac.get("category"),
        "distance_nm": round(dist, 1),
        "bearing_deg": round(bearing_deg(config.HOME_LAT, config.HOME_LON, lat, lon)),
    }
    if config.ENABLE_ENRICH:
        if flight:
            route = _enrichment(f"route:{flight}")
            if route:
                leg = _leg(route, lat, lon, entry["gs"], ac.get("baro_rate"))
                if rules.hides_route(leg):
                    return None
                # A route the aircraft cannot be on is worse than no route: it
                # is a confident, specific, wrong answer on the display.
                #
                # Only the airports are wrong, though. The airline comes from
                # the callsign prefix and is still right, so keep it: throwing
                # the whole record away cost line 1 its name and turned
                # "Southwest 1304" back into "SWA1304".
                if _route_fits(route, lat, lon):
                    entry["route"] = leg
                elif leg.get("airline"):
                    entry["route"] = {"airline": leg["airline"], "origin": None,
                                      "destination": None, "from": None, "to": None}
                    log.debug("dropped airports for %s (%s-%s), kept the airline",
                              flight, route.get("origin"), route.get("destination"))
        if entry["hex"]:
            info = _enrichment(f"type:{entry['hex']}")
            if info:
                reg = (info.get("registration") or "").upper()
                if reg and reg in rules.registrations:
                    return None
                if rules.hides_type(info.get("type")):
                    return None
                entry["aircraft_info"] = info
    return entry


async def _poll_loop():
    async with httpx.AsyncClient() as client:

        async def fetch(url):
            r = await client.get(url, timeout=5)
            r.raise_for_status()
            return r.json()

        while True:
            results = await asyncio.gather(
                *(fetch(u) for u in config.RECEIVERS), return_exceptions=True
            )

            merged = {}      # hex -> (position age, entry); freshest sighting wins
            sources = []
            for url, result in zip(config.RECEIVERS, results):
                name = _receiver_name(url)
                if isinstance(result, Exception):
                    log.warning("receiver %s failed: %s", name, result)
                    sources.append({"name": name, "ok": False, "error": str(result), "aircraft": 0})
                    continue
                seen = 0
                for ac in result.get("aircraft", []):
                    entry = _entry(ac)
                    if entry is None:
                        continue
                    seen += 1
                    age = ac.get("seen_pos", ac.get("seen", 999)) or 0
                    current = merged.get(entry["hex"])
                    if current is None or age < current[0]:
                        entry["source"] = name
                        merged[entry["hex"]] = (age, entry)
                sources.append({"name": name, "ok": True, "aircraft": seen})

            if any(s["ok"] for s in sources):
                out = sorted((e for _, e in merged.values()), key=lambda a: a["distance_nm"])
                _state["aircraft"] = out[: config.MAX_AIRCRAFT]
                _state["updated"] = time.time()
                _state["last_error"] = None
            else:
                _state["last_error"] = "; ".join(
                    f"{s['name']}: {s['error']}" for s in sources
                ) or "no receivers configured"
            _state["sources"] = sources

            await asyncio.sleep(config.POLL_INTERVAL)


def _log_config():
    """Report the two settings an empty board is almost always down to."""
    if config.CONFIG_SOURCE:
        log.info("settings from %s", config.CONFIG_SOURCE)
    log.info("home %.4f,%.4f, showing aircraft within %g nm",
             config.HOME_LAT, config.HOME_LON, filters.current().range_nm)
    for url in config.RECEIVERS:
        log.info("receiver %s -> %s", _receiver_name(url), url)
    for name in config.MOVED_TO_FILTERS:
        log.warning("%s is no longer read: range lives in filters.json now, as "
                    "\"range_nm\". Remove it from flightboard.env to stop this notice.",
                    name)
    hidden = filters.current().active()
    log.info("hiding: %s", hidden) if hidden else log.info(
        "hiding nothing (%s)", filters.FILTERS_FILE)
    if (config.HOME_LAT, config.HOME_LON) == (0.0, 0.0):
        log.warning(
            "FLIGHTBOARD_HOME_LAT and FLIGHTBOARD_HOME_LON are not set, so home is "
            "0,0 in the Atlantic. Every aircraft will measure further than %g nm "
            "away and the board will stay empty however healthy the receiver is. "
            "Copy flightboard.env.example to flightboard.env and set them there.",
            filters.current().range_nm)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _log_config()
    tasks = [asyncio.create_task(_poll_loop())]
    if config.ENABLE_ENRICH:
        tasks.append(asyncio.create_task(_enrich_worker()))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
# logos.js is ~1 MB of palette-indexed text and compresses to a fraction of that
app.add_middleware(GZipMiddleware, minimum_size=1024)


def _build_id():
    """Fingerprint of the frontend files, so a display can notice a redeploy.

    A cast page never reloads on its own: the Chromecast loads the URL once and
    renders it for months, so an update would otherwise never reach the TV
    without re-casting by hand. The panel compares this against what it started
    with and reloads itself when it changes.

    Deliberately computed per request rather than at startup, because updating
    the frontend usually doesn't involve restarting the backend at all.
    """
    try:
        stamps = [
            f"{p.name}:{p.stat().st_mtime_ns}"
            for p in sorted(FRONTEND_DIR.glob("*"))
            if p.is_file()
        ]
    except OSError:
        return "unknown"
    digest = hashlib.sha1("|".join(stamps).encode()).hexdigest()
    return digest[:12]


@app.get("/api/aircraft")
async def get_aircraft():
    return {
        "home": {"lat": config.HOME_LAT, "lon": config.HOME_LON},
        # null unless filters.json failed to parse, in which case nothing is
        # being hidden and the reason belongs somewhere the operator will see it
        "filters_error": filters.error(),
        "max_range_nm": filters.current().range_nm,
        "build": _build_id(),
        "updated": _state["updated"],
        # seconds since the last good poll, computed server-side so the panel
        # doesn't have to trust that its clock agrees with this host's
        "age_s": round(time.time() - _state["updated"], 1) if _state["updated"] else None,
        "last_error": _state["last_error"],
        "sources": _state["sources"],
        "aircraft": _state["aircraft"],
    }


@app.middleware("http")
async def always_revalidate(request, call_next):
    # Without this the browser heuristically caches panel.js and a long-running
    # display keeps rendering an old build after a redeploy. ETags still make
    # the revalidation a cheap 304.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/dashboard")
async def dashboard():
    return RedirectResponse("/dashboard.html")


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
