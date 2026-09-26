import os
from pathlib import Path

# Settings are read from three places, first match wins:
#
#   1. the real environment  - a systemd unit, a container, `export` in a shell
#   2. flightboard.env       - a file of KEY=value lines beside this checkout
#   3. the defaults below
#
# The file exists so that running by hand doesn't mean re-exporting your
# coordinates every session. It is deliberately the format systemd's
# EnvironmentFile= reads, so the installed service and a manual `uvicorn` run
# share one file rather than each having somewhere different to look. The
# environment still wins, which is what lets you override a single setting for
# a single run without editing anything.
#
# Copy flightboard.env.example to flightboard.env to start. It holds your
# location, so it is gitignored.
ENV_FILE = Path(
    os.environ.get(
        "FLIGHTBOARD_ENV_FILE",
        Path(__file__).resolve().parent.parent / "flightboard.env",
    )
)


def _load_env_file(path):
    """Parse KEY=value lines. Not a shell: no expansion, no multi-line values."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}                       # absent is the normal case, not an error
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):  # tolerated: people paste these from a shell
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        if not sep:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


_from_file = _load_env_file(ENV_FILE)


def _get(name, default):
    """Environment, then the file, then the built-in default."""
    if name in os.environ:
        return os.environ[name]
    if name in _from_file:
        return _from_file[name]
    return default


# Which file the settings came from, if any, so the startup log can say so
# rather than leaving you to guess which of the three won.
CONFIG_SOURCE = str(ENV_FILE) if _from_file else None

# One or more dump1090-fa / readsb / piaware receivers, comma separated.
#
# All of them are polled and their aircraft merged, so overlapping receivers
# just widen your coverage: if one drops off the network the others carry the
# display. When the same aircraft is seen by several, the freshest position
# wins. Order doesn't matter.
#
#   FLIGHTBOARD_RECEIVERS="http://pi-roof.local/skyaware/data/aircraft.json,http://pi-desk.local/skyaware/data/aircraft.json"
#
# Paths by receiver software:
#   piaware / dump1090-fa  /skyaware/data/aircraft.json
#   tar1090                /tar1090/data/aircraft.json
#   readsb / dump1090      /data/aircraft.json
RECEIVERS = [
    u.strip()
    for u in _get(
        "FLIGHTBOARD_RECEIVERS",
        "http://localhost/skyaware/data/aircraft.json",
    ).split(",")
    if u.strip()
]

# Your location. Set these in flightboard.env (see README) rather than
# hardcoding - approximate coordinates (a few decimal places) are plenty.
HOME_LAT = float(_get("FLIGHTBOARD_HOME_LAT", "0.0"))
HOME_LON = float(_get("FLIGHTBOARD_HOME_LON", "0.0"))

# Range moved to filters.json, alongside the altitude band, because both answer
# the same question and that file reloads itself. This only exists to notice the
# old setting still lying around and say where it went.
MOVED_TO_FILTERS = [
    name for name in ("FLIGHTBOARD_MAX_RANGE_NM",)
    if name in os.environ or name in _from_file
]


# An airport this close to home counts as "local", which is what turns a route
# into "Arriving from ..." / "Departing to ..." instead of naming both ends.
LOCAL_AIRPORT_NM = float(_get("FLIGHTBOARD_LOCAL_AIRPORT_NM", "30"))

# Cap on how many aircraft the API returns (closest N). Clients take what they
# need from this: the LED panel cycles the closest 5, the dashboard fills the
# window. Raising it costs nothing extra in lookups, since enrichment already
# runs for everything in range.
MAX_AIRCRAFT = int(_get("FLIGHTBOARD_MAX_AIRCRAFT", "60"))

# How often to poll the skyaware feed, in seconds.
POLL_INTERVAL = float(_get("FLIGHTBOARD_POLL_INTERVAL", "2"))

# Look up registration/type/route from the free adsbdb.com API. Results are
# cached in memory for ENRICH_TTL seconds so we don't hammer it.
ENABLE_ENRICH = _get("FLIGHTBOARD_ENABLE_ENRICH", "1") == "1"
ENRICH_TTL = float(_get("FLIGHTBOARD_ENRICH_TTL", "3600"))

# A lookup that found nothing is retried far sooner than one that succeeded. A
# hit is a fact about an aircraft and keeps for an hour; a miss might only mean
# the service was briefly unreachable, and caching that for an hour leaves an
# aircraft blank all afternoon when the answer was there all along.
ENRICH_FAIL_TTL = float(_get("FLIGHTBOARD_ENRICH_FAIL_TTL", "300"))

# Real departure and arrival times from FlightAware's AeroAPI. Optional, metered,
# and off until a key is set. See "Real flight times" in the README.
#
# The cap is in dollars, counted here rather than asked of FlightAware, and kept
# in a file so a restart does not reset it. Set it below what you are willing to
# spend: feeders get a monthly credit, non-feeders on the free tier get less.
AEROAPI_KEY = _get("FLIGHTBOARD_AEROAPI_KEY", "").strip()
AEROAPI_MONTHLY_CAP = float(_get("FLIGHTBOARD_AEROAPI_MONTHLY_CAP", "5"))
# What one lookup is counted as costing. FlightAware set 0.005 for a flight
# lookup when this was checked against a real account's usage page (733 lookups,
# $3.67). It is a setting because they set the price, not us.
AEROAPI_CALL_COST = float(_get("FLIGHTBOARD_AEROAPI_CALL_COST", "0.005"))
# How many of the nearest aircraft are looked up: the ones a display is showing.
AEROAPI_NEAREST = int(_get("FLIGHTBOARD_AEROAPI_NEAREST", "5"))
# How long a flight's answer is reused. The arrival it holds is a clock time, not
# a countdown, so the minutes shown keep falling correctly between lookups; only
# a change in the estimate itself is missed. An hour keeps the spend modest.
AEROAPI_TTL = float(_get("FLIGHTBOARD_AEROAPI_TTL", "3600"))
AEROAPI_USAGE_FILE = _get(
    "FLIGHTBOARD_AEROAPI_USAGE_FILE",
    str(Path(__file__).resolve().parent.parent / "data" / "aeroapi-usage.json"),
)

# A history of what the board has seen, kept for the /metrics.html page. Samples
# are held in memory and written every METRICS_FLUSH seconds rather than as they
# arrive, so a Pi's SD card is not worn by a write a minute. Minute samples are
# kept METRICS_RAW_DAYS days and rolled up to hourly ones, which are kept a year,
# so the file stops growing, at roughly 30 MB for a busy site, however long it
# runs.
METRICS = _get("FLIGHTBOARD_METRICS", "1") == "1"
METRICS_FILE = _get(
    "FLIGHTBOARD_METRICS_FILE",
    str(Path(__file__).resolve().parent.parent / "data" / "metrics.sqlite"),
)
METRICS_FLUSH = float(_get("FLIGHTBOARD_METRICS_FLUSH", "600"))
METRICS_RAW_DAYS = int(_get("FLIGHTBOARD_METRICS_RAW_DAYS", "7"))

# Show the diagnostic bands above and below the panel by default. Any display
# can override it per URL with ?debug=1 or ?debug=0, which is usually what you
# want: debug the board on a laptop while the cast TV stays clean.
DEBUG = _get("FLIGHTBOARD_DEBUG", "0") == "1"

PORT = int(_get("FLIGHTBOARD_PORT", "8090"))
