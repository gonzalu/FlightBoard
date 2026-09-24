"""A history of what FlightBoard has seen and how healthy its inputs are.

Three kinds of number, all cheap to gather because the poll loop already has them:

  traffic    aircraft in range, and which distinct aircraft, airlines and types
  receivers  whether each was up, how many aircraft it saw, its farthest one
  health     the lookup cache, failures from adsbdb and hexdb, AeroAPI spend

Kept in SQLite beside the other generated data, sized like a round-robin
database: one sample a minute for RAW_DAYS days, rolled up to one an hour for a
year, so the file stops growing however long it runs. Measured with three busy
receivers that is about 10 MB of minutes, and roughly 20 MB more once a year of
hours and of distinct aircraft has accumulated.

Nothing here can affect the board. Samples are collected in memory and written by
a worker in a thread every METRICS_FLUSH seconds - a Pi's SD card does not need a
write a minute - and every failure is logged once and swallowed.
"""

import asyncio
import logging
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from . import aeroapi, config, routes_db

log = logging.getLogger("flightboard.metrics")

SAMPLE_S = 60                      # one sample a minute
HOURLY_KEEP_DAYS = 400
_MAX_PENDING = 20000               # samples held if the disk is failing

SCHEMA = """
CREATE TABLE IF NOT EXISTS minute (
    ts INTEGER, series TEXT, value REAL, PRIMARY KEY (series, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hour (
    ts INTEGER, series TEXT, avg REAL, min REAL, max REAL, n INTEGER,
    PRIMARY KEY (series, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS hexes (
    day TEXT, hex TEXT, airline TEXT, type TEXT, PRIMARY KEY (day, hex)) WITHOUT ROWID;
"""

# Series are named "aircraft", "rx:<receiver>:<up|aircraft|maxnm>",
# "lookup:<source>:<ok|fail>", "enrich:<hit_pct|queued>", "aeroapi:<spent|calls>".
# ":" separates because a receiver's name can be an IP address, full of dots.

_pending: list = []                # (ts, series, value) awaiting a flush
_hexes: dict = {}                  # today's aircraft -> {"airline", "type"}
_dirty: set = set()                # hexes new or improved since the last flush
_day = None
_last_sample = 0.0
_run_max: dict = {}                # receiver -> farthest nm since the last sample
_lookups: dict = {}                # source -> [answered, failed], cumulative
_last_lookups: dict = {}
_state = {"error": None, "last_flush": None, "warned": False}


def _utc_day(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def lookup(source, answered):
    """Count one call to an online source. A 404 is an answer; a timeout is not."""
    _lookups.setdefault(source, [0, 0])[0 if answered else 1] += 1


def _airline(entry):
    m = re.match(r"^([A-Z]{3})\d", entry.get("flight") or "")
    return m.group(1) if m else None


def observe(entries, sources, enrich_cache, queued):
    """Called after every poll. Cheap: bookkeeping, and a sample once a minute."""
    try:
        _observe(entries, sources, enrich_cache, queued)
    except Exception as e:
        if not _state["warned"]:
            _state["warned"] = True
            log.warning("metrics collection failed (%s: %s); the board is unaffected",
                        type(e).__name__, e)


def _observe(entries, sources, enrich_cache, queued):
    global _day, _last_sample
    now = time.time()
    day = _utc_day(now)
    if day != _day:                # a new UTC day starts a new set of aircraft
        _hexes.clear()
        _dirty.clear()
        _day = day

    for a in entries:
        hexid = a.get("hex")
        if not hexid:
            continue
        airline = _airline(a)
        typ = (a.get("aircraft_info") or {}).get("type_code")
        known = _hexes.get(hexid)
        if known is None:
            _hexes[hexid] = {"airline": airline, "type": typ}
            _dirty.add(hexid)
        else:
            # Enrichment arrives after the first sighting, so fill blanks later
            # rather than recording an aircraft as unknown forever.
            if airline and not known["airline"]:
                known["airline"] = airline
                _dirty.add(hexid)
            if typ and not known["type"]:
                known["type"] = typ
                _dirty.add(hexid)
        for name in a.get("seen_by") or ():
            if a["distance_nm"] > _run_max.get(name, 0.0):
                _run_max[name] = a["distance_nm"]

    if now - _last_sample < SAMPLE_S:
        return
    _last_sample = now
    ts = int(now)
    add = lambda series, value: _pending.append((ts, series, float(value)))

    add("aircraft", len(entries))
    for s in sources:
        add(f"rx:{s['name']}:up", 1 if s["ok"] else 0)
        add(f"rx:{s['name']}:aircraft", s.get("aircraft", 0))
        if s["name"] in _run_max:
            add(f"rx:{s['name']}:maxnm", _run_max[s["name"]])
    _run_max.clear()

    if enrich_cache:
        hits = sum(1 for v in enrich_cache.values() if v["data"])
        add("enrich:hit_pct", 100.0 * hits / len(enrich_cache))
    add("enrich:queued", queued)
    for source, (ok, fail) in _lookups.items():
        last_ok, last_fail = _last_lookups.get(source, (0, 0))
        add(f"lookup:{source}:ok", ok - last_ok)
        add(f"lookup:{source}:fail", fail - last_fail)
        _last_lookups[source] = (ok, fail)
    if aeroapi.enabled():
        st = aeroapi.status()
        add("aeroapi:spent", st["spent"])
        add("aeroapi:calls", st["calls"])

    if len(_pending) > _MAX_PENDING:          # the disk has been failing a while
        del _pending[: len(_pending) - _MAX_PENDING]


# --- writing -----------------------------------------------------------------

def _connect():
    # data/ does not exist on an install that never built the standing database
    Path(config.METRICS_FILE).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(config.METRICS_FILE, timeout=10)
    db.executescript(SCHEMA)
    return db


def _write(samples, hex_rows, now):
    db = _connect()
    try:
        db.executemany("INSERT OR REPLACE INTO minute VALUES (?,?,?)",
                       [(ts, name, v) for ts, name, v in samples])
        db.executemany(
            "INSERT INTO hexes VALUES (?,?,?,?) ON CONFLICT(day, hex) DO UPDATE SET "
            "airline = COALESCE(excluded.airline, airline), "
            "type = COALESCE(excluded.type, type)", hex_rows)
        # Roll the last couple of hours up again each time; replacing is idempotent
        # and means a restart mid-hour never loses part of an hour.
        since = (int(now) // 3600 - 2) * 3600
        db.execute(
            "INSERT OR REPLACE INTO hour SELECT ts / 3600 * 3600, series, avg(value), "
            "min(value), max(value), count(*) FROM minute WHERE ts >= ? "
            "GROUP BY ts / 3600, series", (since,))
        db.execute("DELETE FROM minute WHERE ts < ?",
                   (int(now) - config.METRICS_RAW_DAYS * 86400,))
        db.execute("DELETE FROM hour WHERE ts < ?",
                   (int(now) - HOURLY_KEEP_DAYS * 86400,))
        db.execute("DELETE FROM hexes WHERE day < ?",
                   (_utc_day(now - HOURLY_KEEP_DAYS * 86400),))
        db.commit()
    finally:
        db.close()


async def flush_now():
    """Write what has been collected. Failure keeps it for the next attempt."""
    global _pending
    samples, _pending = _pending, []
    rows = [(_day, h, _hexes[h]["airline"], _hexes[h]["type"])
            for h in list(_dirty) if h in _hexes]
    _dirty.clear()
    if not samples and not rows:
        return
    try:
        await asyncio.to_thread(_write, samples, rows, time.time())
        _state.update(error=None, last_flush=time.time())
    except Exception as e:
        _pending = samples + _pending
        _dirty.update(r[1] for r in rows)
        if _state["error"] is None:
            log.warning("could not write metrics to %s (%s: %s); keeping them in "
                        "memory and trying again", config.METRICS_FILE,
                        type(e).__name__, e)
        _state["error"] = f"{type(e).__name__}: {e}"


async def worker():
    log.info("metrics: recording to %s, written every %g s, minute samples kept "
             "%d days", config.METRICS_FILE, config.METRICS_FLUSH,
             config.METRICS_RAW_DAYS)
    await asyncio.sleep(min(90.0, config.METRICS_FLUSH))   # a first look soon after start
    while True:
        await flush_now()
        await asyncio.sleep(config.METRICS_FLUSH)


# --- reading -----------------------------------------------------------------

# range -> (table, bucket seconds, window seconds). Buckets keep any window near
# 300 points, which is as many as a chart can show.
RANGES = {
    "24h": ("minute", 300, 86400),
    "7d": ("minute", 1800, 7 * 86400),
    "30d": ("hour", 7200, 30 * 86400),
    "1y": ("hour", 86400, 365 * 86400),
}


def _series(db, rng, now):
    table, bucket, window = RANGES[rng]
    since = int(now) - window
    if table == "minute":
        rows = db.execute(
            "SELECT series, ts / ? * ?, avg(value), max(value) FROM minute "
            "WHERE ts >= ? GROUP BY series, ts / ?", (bucket, bucket, since, bucket))
    else:
        rows = db.execute(
            "SELECT series, ts / ? * ?, sum(avg * n) / sum(n), max(max) FROM hour "
            "WHERE ts >= ? GROUP BY series, ts / ?", (bucket, bucket, since, bucket))
    out: dict = {}
    for series, ts, avg, peak in rows:
        out.setdefault(series, []).append([ts, round(avg, 2), round(peak, 2)])
    for points in out.values():
        points.sort()
    return out


def _scalar(db, sql, args=()):
    row = db.execute(sql, args).fetchone()
    return row[0] if row and row[0] is not None else None


def _summary(db, now):
    day = 86400
    since24, since7 = int(now) - day, int(now) - 7 * day
    today = _utc_day(now)
    s = {
        "aircraft_now": _scalar(db, "SELECT value FROM minute WHERE series='aircraft' "
                                    "ORDER BY ts DESC LIMIT 1"),
        "aircraft_avg_24h": _scalar(db, "SELECT avg(value) FROM minute WHERE "
                                        "series='aircraft' AND ts >= ?", (since24,)),
        "aircraft_peak_24h": _scalar(db, "SELECT max(value) FROM minute WHERE "
                                         "series='aircraft' AND ts >= ?", (since24,)),
        "unique_today": _scalar(db, "SELECT count(*) FROM hexes WHERE day = ?", (today,)),
        "unique_7d": _scalar(db, "SELECT count(*) FROM (SELECT DISTINCT hex FROM hexes "
                                 "WHERE day >= ?)", (_utc_day(now - 6 * day),)),
        "unique_30d": _scalar(db, "SELECT count(*) FROM (SELECT DISTINCT hex FROM hexes "
                                  "WHERE day >= ?)", (_utc_day(now - 29 * day),)),
        "oldest": _scalar(db, "SELECT min(ts) FROM hour") or
                  _scalar(db, "SELECT min(ts) FROM minute"),
    }
    s["daily_unique"] = [[d, n] for d, n in db.execute(
        "SELECT day, count(*) FROM hexes WHERE day >= ? GROUP BY day ORDER BY day",
        (_utc_day(now - 13 * day),))]

    def top(column, limit=8):
        rows = db.execute(
            f"SELECT {column}, count(*) FROM (SELECT DISTINCT hex, {column} FROM hexes "
            f"WHERE day >= ? AND {column} IS NOT NULL) GROUP BY {column} "
            "ORDER BY 2 DESC LIMIT ?", (_utc_day(now - 6 * day), limit))
        return [[k, n] for k, n in rows]

    s["top_airlines"] = [[k, routes_db.airline_name(k) or k, n] for k, n in top("airline")]
    s["top_types"] = top("type")
    s["by_hour_utc"] = [
        [h, round(a, 2)] for h, a in db.execute(
            "SELECT ts / 3600 % 24, avg(value) FROM minute WHERE series='aircraft' "
            "AND ts >= ? GROUP BY ts / 3600 % 24 ORDER BY 1", (since7,))]

    names = sorted({r[0].split(":")[1] for r in db.execute(
        "SELECT DISTINCT series FROM minute WHERE series LIKE 'rx:%:up'")})
    receivers = []
    for n in names:
        q = lambda field, agg: _scalar(
            db, f"SELECT {agg}(value) FROM minute WHERE series=? AND ts >= ?",
            (f"rx:{n}:{field}", since24))
        best = max(filter(None, [
            _scalar(db, "SELECT max(value) FROM minute WHERE series=?", (f"rx:{n}:maxnm",)),
            _scalar(db, "SELECT max(max) FROM hour WHERE series=?", (f"rx:{n}:maxnm",)),
        ]), default=None)
        up = q("up", "avg")
        receivers.append({
            "name": n,
            "uptime_24h": None if up is None else round(100 * up, 2),
            "aircraft_avg_24h": q("aircraft", "avg"),
            "aircraft_peak_24h": q("aircraft", "max"),
            "range_24h": q("maxnm", "max"),
            "range_best": best,
        })
    s["receivers"] = receivers

    health = {"hit_pct_24h": _scalar(db, "SELECT avg(value) FROM minute WHERE "
                                         "series='enrich:hit_pct' AND ts >= ?", (since24,))}
    lookups = []
    for src in sorted({r[0].split(":")[1] for r in db.execute(
            "SELECT DISTINCT series FROM minute WHERE series LIKE 'lookup:%'")}):
        tot = lambda kind: _scalar(db, "SELECT sum(value) FROM minute WHERE series=? "
                                       "AND ts >= ?", (f"lookup:{src}:{kind}", since24)) or 0
        ok, fail = tot("ok"), tot("fail")
        lookups.append({"source": src, "ok": int(ok), "fail": int(fail),
                        "fail_pct": round(100 * fail / (ok + fail), 2) if ok + fail else None})
    health["lookups"] = lookups
    if aeroapi.enabled():
        health["aeroapi"] = aeroapi.status()
    s["health"] = health
    return s


def query(rng):
    """Everything the metrics page draws, in one answer."""
    if not config.METRICS:
        return {"enabled": False}
    rng = rng if rng in RANGES else "24h"
    out = {"enabled": True, "range": rng, "bucket_s": RANGES[rng][1],
           "generated": int(time.time()), "flush_s": config.METRICS_FLUSH,
           "last_flush": _state["last_flush"], "error": _state["error"]}
    try:
        db = sqlite3.connect(f"file:{config.METRICS_FILE}?mode=ro", uri=True, timeout=10)
    except sqlite3.Error:
        out.update(series={}, summary=None)     # nothing written yet: a new install
        return out
    try:
        now = time.time()
        out["series"] = _series(db, rng, now)
        out["summary"] = _summary(db, now)
    except sqlite3.Error as e:
        out.update(series={}, summary=None, error=str(e))
    finally:
        db.close()
    return out
