import os

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
    for u in os.environ.get(
        "FLIGHTBOARD_RECEIVERS",
        "http://localhost/skyaware/data/aircraft.json",
    ).split(",")
    if u.strip()
]

# Your location. Set these via environment variables (see README) rather than
# hardcoding — approximate coordinates (a few decimal places) are plenty.
HOME_LAT = float(os.environ.get("FLIGHTBOARD_HOME_LAT", "0.0"))
HOME_LON = float(os.environ.get("FLIGHTBOARD_HOME_LON", "0.0"))

# Only show aircraft within this radius (nautical miles).
MAX_RANGE_NM = float(os.environ.get("FLIGHTBOARD_MAX_RANGE_NM", "40"))

# An airport this close to home counts as "local", which is what turns a route
# into "Arriving from ..." / "Departing to ..." instead of naming both ends.
LOCAL_AIRPORT_NM = float(os.environ.get("FLIGHTBOARD_LOCAL_AIRPORT_NM", "30"))

# Cap on how many aircraft the API returns (closest N). Clients take what they
# need from this: the LED panel cycles the closest 5, the dashboard fills the
# window. Raising it costs nothing extra in lookups, since enrichment already
# runs for everything in range.
MAX_AIRCRAFT = int(os.environ.get("FLIGHTBOARD_MAX_AIRCRAFT", "60"))

# How often to poll the skyaware feed, in seconds.
POLL_INTERVAL = float(os.environ.get("FLIGHTBOARD_POLL_INTERVAL", "2"))

# Look up registration/type/route from the free adsbdb.com API. Results are
# cached in memory for ENRICH_TTL seconds so we don't hammer it.
ENABLE_ENRICH = os.environ.get("FLIGHTBOARD_ENABLE_ENRICH", "1") == "1"
ENRICH_TTL = float(os.environ.get("FLIGHTBOARD_ENRICH_TTL", "3600"))

PORT = int(os.environ.get("FLIGHTBOARD_PORT", "8090"))
