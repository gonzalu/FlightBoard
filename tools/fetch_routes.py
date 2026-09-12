#!/usr/bin/env python3
"""
Build a local route database from Virtual Radar Server's standing data.

VRS keeps a community-curated table of callsigns, airports and airlines, and
corrections go in through its own site, so it tracks real schedules far better
than a general lookup API does. On a sample checked against FlightAware it got
three of four routes exactly right where the free API got none.

    python3 tools/fetch_routes.py [--out data/standing-data.sqlite]

Roughly 22 MB of CSV becomes a SQLite file the backend queries per callsign. It
is SQLite rather than a dict because there are 620,000 routes: holding those in
memory would cost more than a Pi 3 has to spare, while an indexed lookup costs
nothing. Nothing is fetched at display time, so the board keeps naming routes
correctly with the internet down and your receivers up.

Data is CC0 from github.com/vradarserver/standing-data, mirrored hourly by
adsb.lol. Corrections go to https://sdm.virtualradarserver.co.uk/Edit - if the
board shows a route you know is wrong, that is where to fix it for everybody.
"""

import argparse
import csv
import io
import os
import sqlite3
import sys
import urllib.request

MIRROR = "https://vrs-standing-data.adsb.lol"
UPSTREAM = "https://raw.githubusercontent.com/vradarserver/standing-data/main"
SOURCES = {
    "routes": f"{MIRROR}/routes.csv",
    "airports": f"{MIRROR}/airports.csv",
    # the hourly mirror doesn't carry this one, so take it from upstream
    "airlines": f"{UPSTREAM}/airlines/schema-01/airlines.csv",
}
UA = "FlightBoard/1.0 (+https://github.com/gonzalu/FlightBoard)"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read().decode("utf-8-sig")


def rows(text):
    return csv.DictReader(io.StringIO(text))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/standing-data.sqlite")
    args = ap.parse_args()
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    tmp = args.out + ".new"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("""
        PRAGMA journal_mode = OFF;
        PRAGMA synchronous = OFF;
        CREATE TABLE routes   (callsign TEXT PRIMARY KEY, codes TEXT NOT NULL);
        CREATE TABLE airports (icao TEXT PRIMARY KEY, name TEXT, iata TEXT,
                               city TEXT, lat REAL, lon REAL);
        CREATE TABLE airlines (icao TEXT PRIMARY KEY, name TEXT);
    """)
    counts = {}
    try:
        text = fetch(SOURCES["routes"])
        data = [(r["Callsign"].strip().upper(), r["AirportCodes"].strip())
                for r in rows(text) if r.get("Callsign") and r.get("AirportCodes")]
        db.executemany("INSERT OR REPLACE INTO routes VALUES (?,?)", data)
        counts["routes"] = len(data)

        text = fetch(SOURCES["airports"])
        data = [(r["ICAO"].strip().upper(), r["Name"], r["IATA"].strip().upper(),
                 r["Location"], float(r["Latitude"]), float(r["Longitude"]))
                for r in rows(text)
                if r.get("ICAO") and r.get("Latitude") and r.get("Longitude")]
        db.executemany("INSERT OR REPLACE INTO airports VALUES (?,?,?,?,?,?)", data)
        counts["airports"] = len(data)

        text = fetch(SOURCES["airlines"])
        data = [(r["ICAO"].strip().upper(), r["Name"])
                for r in rows(text) if r.get("ICAO") and r.get("Name")]
        db.executemany("INSERT OR REPLACE INTO airlines VALUES (?,?)", data)
        counts["airlines"] = len(data)

        db.commit()
    except Exception as e:
        db.close()
        os.remove(tmp)
        print(f"failed: {e}", file=sys.stderr)
        return 1
    db.close()

    # swap in only once it is complete, so a failed run never leaves a
    # half-built database where the backend expects a working one
    os.replace(tmp, args.out)
    size = os.path.getsize(args.out) / 1e6
    print(f"wrote {args.out}: " +
          ", ".join(f"{n:,} {k}" for k, n in counts.items()) +
          f", {size:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
