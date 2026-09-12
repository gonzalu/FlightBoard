#!/usr/bin/env python3
"""
Build a local database from Virtual Radar Server's standing data.

VRS keeps community-curated tables of callsigns, aircraft, airports, airlines
and ICAO address blocks, corrected through its own site by the people running
receivers. It is better than the free lookup APIs and it is better in the way
that matters: checked against FlightAware, it got three routes of four right
where adsbdb got none, and it knows recently delivered airframes the APIs have
never heard of.

    python3 tools/fetch_standing_data.py [--out data/standing-data.sqlite]

One 6 MB tarball becomes a SQLite file the backend queries locally. SQLite
rather than tables in memory because there are 620,000 routes, which will not
fit in a Pi 3's spare memory while an indexed lookup costs nothing. Nothing is
fetched at display time, so the board keeps naming flights when the internet is
down and your receivers are not.

CC0, from github.com/vradarserver/standing-data. If the board shows something
you know is wrong, correct it for everybody at
https://sdm.virtualradarserver.co.uk/Edit and it reaches every user downstream.
"""

import argparse
import csv
import io
import os
import sqlite3
import sys
import tarfile
import urllib.request

TARBALL = "https://codeload.github.com/vradarserver/standing-data/tar.gz/refs/heads/main"
UA = "FlightBoard/1.0 (+https://github.com/gonzalu/FlightBoard)"

SCHEMA = """
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE routes      (callsign TEXT PRIMARY KEY, codes TEXT NOT NULL);
    CREATE TABLE airports    (icao TEXT PRIMARY KEY, name TEXT, iata TEXT,
                              city TEXT, lat REAL, lon REAL);
    CREATE TABLE airlines    (icao TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE aircraft    (icao TEXT PRIMARY KEY, registration TEXT, model TEXT,
                              manufacturer TEXT, operator TEXT, airline_code TEXT,
                              year_built TEXT);
    CREATE TABLE code_blocks (start INTEGER, finish INTEGER, country TEXT,
                              military INTEGER);
    CREATE INDEX code_blocks_start ON code_blocks (start, finish);
"""


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/standing-data.sqlite")
    args = ap.parse_args()
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    print("downloading standing data...")
    req = urllib.request.Request(TARBALL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=300) as r:
        blob = r.read()
    print(f"  {len(blob) / 1e6:.1f} MB")

    tmp = args.out + ".new"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript(SCHEMA)
    counts = {k: 0 for k in ("routes", "airports", "airlines", "aircraft", "code_blocks")}

    # Each table is a pile of small CSVs sharded by prefix, so stream the
    # tarball once and dispatch by path rather than extracting to disk first.
    handlers = {
        "routes/": ("routes", "INSERT OR REPLACE INTO routes VALUES (?,?)",
                    lambda r: (r["Callsign"].strip().upper(), r["AirportCodes"].strip())
                    if r.get("Callsign") and r.get("AirportCodes") else None),
        "airports/": ("airports", "INSERT OR REPLACE INTO airports VALUES (?,?,?,?,?,?)",
                      lambda r: (r["ICAO"].strip().upper(), r["Name"],
                                 (r["IATA"] or "").strip().upper(), r["Location"],
                                 num(r["Latitude"]), num(r["Longitude"]))
                      if r.get("ICAO") and num(r.get("Latitude")) is not None else None),
        "airlines/": ("airlines", "INSERT OR REPLACE INTO airlines VALUES (?,?)",
                      lambda r: (r["ICAO"].strip().upper(), r["Name"])
                      if r.get("ICAO") and r.get("Name") else None),
        "aircraft/": ("aircraft", "INSERT OR REPLACE INTO aircraft VALUES (?,?,?,?,?,?,?)",
                      lambda r: (r["ICAO"].strip().upper(), r["Registration"],
                                 r["Model"], r["Manufacturer"], r["Operator"],
                                 (r["AirlineCode"] or "").strip().upper(),
                                 r["YearBuilt"]) if r.get("ICAO") else None),
        "code-blocks/": ("code_blocks", "INSERT INTO code_blocks VALUES (?,?,?,?)",
                         lambda r: (int(r["Start"], 16), int(r["Finish"], 16),
                                    r["CountryISO2"], 1 if r["IsMilitary"] == "1" else 0)
                         if r.get("Start") and r.get("Finish") else None),
    }

    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
        for member in tar:
            if not member.isfile() or not member.name.endswith(".csv"):
                continue
            rest = member.name.split("/", 1)[1] if "/" in member.name else member.name
            for prefix, (table, stmt, shape) in handlers.items():
                if not rest.startswith(prefix):
                    continue
                f = tar.extractfile(member)
                if f is None:
                    break
                text = f.read().decode("utf-8-sig", "replace")
                batch = [t for t in (shape(row) for row in csv.DictReader(io.StringIO(text)))
                         if t is not None]
                if batch:
                    db.executemany(stmt, batch)
                    counts[table] += len(batch)
                break
    db.commit()
    db.close()

    # swap in only once complete, so a failed run never leaves a half-built
    # database where the backend expects a working one
    os.replace(tmp, args.out)
    print(f"wrote {args.out}: " + ", ".join(f"{n:,} {k}" for k, n in counts.items())
          + f", {os.path.getsize(args.out) / 1e6:.0f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
