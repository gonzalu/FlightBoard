#!/usr/bin/env python3
"""Draw your coastline, lakes, borders and airports under the dashboard radar.

    python3 tools/make_basemap.py

Writes frontend/basemap.js for the home in flightboard.env. The dashboard picks
it up by itself; without the file the radar is exactly as it was.

The geography is Natural Earth at 1:10m, which is public domain. About 13 MB is
downloaded and none of it is kept. Only what lies near home is written out, and
it is already projected into nautical miles east and north of home, so the
browser does no geography at all: it scales and draws. That is also why this is
data and not a picture. The radar zooms from 1 nm out to one and a half times
your range, and an image would blur badly across that.

Airports are the ones with an IATA code in data/standing-data.sqlite, when that
has been built. The standing data says nothing about how big an airport is, but
an IATA code is a good stand-in for "an airport you would recognise", and it
leaves out the hundreds of heliports and private strips that would bury them.

The file is specific to one home, so it is generated and gitignored rather than
shipped. Run it again if you move.
"""

import argparse
import io
import json
import math
import os
import sqlite3
import struct
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from backend import config, filters, routes_db       # noqa: E402  settings only, no web stack
from backend.geo import bearing_deg, haversine_nm    # noqa: E402  the formulas aircraft use

UA = "FlightBoard/1.0 (+https://github.com/gonzalu/FlightBoard)"
NATURAL_EARTH = "https://naciscdn.org/naturalearth/10m/"
POLYGONS = {
    "land": "physical/ne_10m_land.zip",
    "lakes": "physical/ne_10m_lakes.zip",
}
LINES = {
    "states": "cultural/ne_10m_admin_1_states_provinces_lines.zip",
    "countries": "cultural/ne_10m_admin_0_boundary_lines_land.zip",
}
OUT = os.path.join(ROOT, "frontend", "basemap.js")


def fetch(path):
    req = urllib.request.Request(NATURAL_EARTH + path, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except OSError as e:
        sys.exit("could not download %s%s: %s" % (NATURAL_EARTH, path, e))


def overlaps(a, b):
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def shapefile_parts(blob, box):
    """Each part - a polyline run or a polygon ring - that comes near box, as
    [(lon, lat), ...], read straight out of the downloaded zip.

    Records and parts both carry a bounding box ahead of their points, so the
    rest of the world is skipped without building a single coordinate. That is
    what keeps reading a whole planet workable on a Raspberry Pi.
    """
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        data = zf.read(next(n for n in zf.namelist() if n.endswith(".shp")))
    pos = 100                                                    # file header
    while pos + 8 <= len(data):
        length = struct.unpack_from(">i", data, pos + 4)[0] * 2  # in 16-bit words
        rec, pos = pos + 8, pos + 8 + length
        if struct.unpack_from("<i", data, rec)[0] not in (3, 5):  # polyline, polygon
            continue
        if not overlaps(struct.unpack_from("<4d", data, rec + 4), box):
            continue
        nparts, npoints = struct.unpack_from("<2i", data, rec + 36)
        starts = struct.unpack_from("<%di" % nparts, data, rec + 44)
        base = rec + 44 + 4 * nparts
        for i, start in enumerate(starts):
            stop = starts[i + 1] if i + 1 < nparts else npoints
            xy = struct.unpack_from("<%dd" % (2 * (stop - start)), data, base + 16 * start)
            xs, ys = xy[0::2], xy[1::2]
            if overlaps((min(xs), min(ys), max(xs), max(ys)), box):
                yield list(zip(xs, ys))


def clip_ring(ring, box):
    """Sutherland-Hodgman against the box. A ring that leaves the box and comes
    back is joined along the box edge, which is further out than the radar ever
    shows, so the join is never seen."""
    x0, y0, x1, y1 = box

    def at_x(x):
        return lambda p, q: (x, p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]))

    def at_y(y):
        return lambda p, q: (p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]), y)

    for keep, meet in ((lambda p: p[0] >= x0, at_x(x0)), (lambda p: p[0] <= x1, at_x(x1)),
                       (lambda p: p[1] >= y0, at_y(y0)), (lambda p: p[1] <= y1, at_y(y1))):
        if not ring:
            break
        out, prev = [], ring[-1]
        for cur in ring:
            if keep(cur):
                if not keep(prev):
                    out.append(meet(prev, cur))
                out.append(cur)
            elif keep(prev):
                out.append(meet(prev, cur))
            prev = cur
        ring = out
    return ring


def clip_line(line, box):
    """The runs of a polyline inside the box, each carried one vertex past the
    edge at either end so it reaches the edge rather than stopping short."""
    x0, y0, x1, y1 = box
    runs, cur = [], None
    for i, (x, y) in enumerate(line):
        if x0 <= x <= x1 and y0 <= y <= y1:
            if cur is None:
                cur = [line[i - 1]] if i else []
            cur.append((x, y))
        elif cur is not None:
            cur.append((x, y))
            runs.append(cur)
            cur = None
    if cur is not None:
        runs.append(cur)
    return runs


def project(points, lat0, lon0):
    """[(lon, lat), ...] -> [east, north, east, north, ...] in nm from home.

    This is exactly how the radar places an aircraft: distance d on bearing b is
    drawn d*sin(b) across and d*cos(b) up. Same formulas, same answer, so the
    coast and the traffic over it agree at every zoom.
    """
    out = []
    for lon, lat in points:
        d = haversine_nm(lat0, lon0, lat, lon)
        b = math.radians(bearing_deg(lat0, lon0, lat, lon))
        out += (round(d * math.sin(b), 2), round(d * math.cos(b), 2))
    return out


def airports(lat0, lon0, radius, box):
    db_file = routes_db.DB_FILE
    if not db_file.exists():
        print("note: no airports on the map - %s has not been built "
              "(tools/fetch_standing_data.py builds it)" % db_file, file=sys.stderr)
        return []
    x0, y0, x1, y1 = box
    try:
        db = sqlite3.connect(db_file.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            rows = db.execute("SELECT iata, lat, lon FROM airports WHERE iata <> '' "
                              "AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
                              (y0, y1, x0, x1)).fetchall()
        finally:
            db.close()
    except sqlite3.Error as e:
        print("note: no airports on the map - could not read %s: %s" % (db_file, e),
              file=sys.stderr)
        return []
    out = []
    for iata, lat, lon in rows:
        d = haversine_nm(lat0, lon0, lat, lon)
        if d <= radius:
            b = math.radians(bearing_deg(lat0, lon0, lat, lon))
            out.append([iata, round(d * math.sin(b), 2), round(d * math.cos(b), 2)])
    return sorted(out, key=lambda a: math.hypot(a[1], a[2]))


def main():
    ap = argparse.ArgumentParser(
        description="Draw coastline, lakes, borders and airports under the dashboard radar.")
    ap.add_argument("--lat", type=float, default=config.HOME_LAT,
                    help="centre latitude (default: FLIGHTBOARD_HOME_LAT)")
    ap.add_argument("--lon", type=float, default=config.HOME_LON,
                    help="centre longitude (default: FLIGHTBOARD_HOME_LON)")
    ap.add_argument("--radius", type=float,
                    help="nm around home to include (default: the radar's widest zoom, "
                         "plus a margin)")
    ap.add_argument("--out", default=OUT, help="default: frontend/basemap.js")
    args = ap.parse_args()
    if args.lat == 0 and args.lon == 0:
        sys.exit("home is 0,0 - set FLIGHTBOARD_HOME_LAT and FLIGHTBOARD_HOME_LON "
                 "in flightboard.env first")

    # The dashboard zooms out to 1.5x the range; a margin beyond that means the
    # edge of the map is never on screen.
    widest = filters.current().range_nm * 1.5
    radius = args.radius or math.ceil(widest * 1.1)
    dlat = radius / 60.0 * 1.1
    dlon = radius / (60.0 * max(0.2, math.cos(math.radians(args.lat)))) * 1.1
    box = (args.lon - dlon, args.lat - dlat, args.lon + dlon, args.lat + dlat)

    out = {"home": {"lat": args.lat, "lon": args.lon}, "radius_nm": radius}
    points = 0
    for name, path in list(POLYGONS.items()) + list(LINES.items()):
        blob = fetch(path)
        shapes = []
        for part in shapefile_parts(blob, box):
            if name in POLYGONS:
                ring = clip_ring(part, box)
                pieces, least = ([ring] if len(ring) >= 3 else []), 3
            else:
                pieces, least = clip_line(part, box), 2
            for piece in pieces:
                flat = project(piece, args.lat, args.lon)
                if len(flat) >= 2 * least:
                    shapes.append(flat)
        out[name] = shapes
        points += sum(len(s) for s in shapes) // 2
        print("%-9s %5.1f MB downloaded, %d near home" % (name, len(blob) / 1e6, len(shapes)))
    out["airports"] = airports(args.lat, args.lon, radius, box)

    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write("/* Generated by tools/make_basemap.py for %.4f,%.4f within %g nm.\n"
                " * Natural Earth 1:10m, public domain. Specific to this home. */\n"
                "const BASEMAP = %s;\n"
                % (args.lat, args.lon, radius, json.dumps(out, separators=(",", ":"))))

    print("wrote %s: %g nm around %.4f,%.4f, %d airports, %d points, %d KB"
          % (os.path.relpath(args.out, ROOT), radius, args.lat, args.lon,
             len(out["airports"]), points, os.path.getsize(args.out) // 1024))


if __name__ == "__main__":
    main()
