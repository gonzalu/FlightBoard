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

PORT = int(_get("FLIGHTBOARD_PORT", "8090"))
