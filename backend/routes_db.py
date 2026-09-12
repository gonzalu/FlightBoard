"""Route lookups from the local Virtual Radar Server standing-data database.

Built by tools/fetch_routes.py. Queried per callsign with no network call at
all, which is the point: it is faster than any API, it cannot rate-limit, and
the board keeps naming routes when the internet is down and the receivers are
not.

Reopened when the file changes, so refreshing the data needs no restart.
"""

import logging
import os
import sqlite3
from pathlib import Path

log = logging.getLogger("flightboard")

DB_FILE = Path(
    os.environ.get(
        "FLIGHTBOARD_ROUTES_DB",
        Path(__file__).resolve().parent.parent / "data" / "standing-data.sqlite",
    )
)

_conn = None
_stamp = None


def _db():
    """The open database, reopened if the file has been rebuilt, or None."""
    global _conn, _stamp
    try:
        st = DB_FILE.stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        stamp = None
    if stamp != _stamp:
        _stamp = stamp
        if _conn is not None:
            _conn.close()
            _conn = None
        if stamp is not None:
            try:
                _conn = sqlite3.connect(f"file:{DB_FILE}?mode=ro", uri=True,
                                        check_same_thread=False)
                n = _conn.execute("SELECT count(*) FROM routes").fetchone()[0]
                log.info("route database: %s, %d routes", DB_FILE, n)
            except Exception as e:
                log.warning("could not open %s (%s)", DB_FILE, e)
                _conn = None
    return _conn


def available():
    return _db() is not None


def lookup(callsign):
    """Raw record for a callsign, or None.

    Returns the ICAO airport codes as stored plus a record per airport, leaving
    it to the caller to decide what to do with a multi-leg route.
    """
    db = _db()
    if not db or not callsign:
        return None
    try:
        row = db.execute("SELECT codes FROM routes WHERE callsign = ?",
                         (callsign.strip().upper(),)).fetchone()
        if not row:
            return None
        codes = [c.strip().upper() for c in row[0].split("-") if c.strip()]
        airports = []
        for icao in codes:
            a = db.execute(
                "SELECT icao, name, iata, city, lat, lon FROM airports WHERE icao = ?",
                (icao,)).fetchone()
            airports.append(dict(zip(("icao", "name", "iata", "city", "lat", "lon"), a))
                            if a else None)
        airline = None
        prefix = callsign.strip().upper()[:3]
        if prefix.isalpha():
            r = db.execute("SELECT name FROM airlines WHERE icao = ?", (prefix,)).fetchone()
            airline = r[0] if r else None
        return {"codes": codes, "airports": airports, "airline": airline}
    except Exception as e:
        log.debug("route lookup failed for %s: %s", callsign, e)
        return None
