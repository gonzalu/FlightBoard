#!/usr/bin/env python3
"""Re-cast the FlightBoard panel if the Chromecast has stopped showing it.

`catt cast_site` hands the URL to the DashCast receiver and the stick renders it
on its own, which survives most things but not the Chromecast rebooting or
losing power. Run periodically by flightboard-cast.timer.

Configure with environment variables, or edit the defaults below:

    FLIGHTBOARD_CAST_DEVICE   Chromecast friendly name, as shown by `catt scan`
    FLIGHTBOARD_URL           the panel URL the stick should load

Two things worth knowing if you're adapting this:

* `catt status` is no use as the health check. For a cast_site session it
  reports only volume, so a script grepping it for the URL would never match and
  would re-cast on every run, restarting the display every few minutes. The
  receiver's own status text is the real signal - it's the page's <title>.

* If something else is playing on that TV, leave it alone. Only an idle
  Chromecast gets the panel pushed back onto it, so casting YouTube to the same
  device doesn't turn into a fight with this timer.
"""

import os
import subprocess
import sys

import pychromecast

DEVICE = os.environ.get("FLIGHTBOARD_CAST_DEVICE", "YOUR-CHROMECAST")
URL = os.environ.get("FLIGHTBOARD_URL", "http://localhost:8090/")
EXPECT_TITLE = "FlightBoard"          # the panel's <title>

# catt lives alongside the interpreter running this, i.e. in the same venv
CATT = os.path.join(sys.prefix, "bin", "catt")

# A name that can never match is a different thing from a TV someone switched
# off, and they deserve different exit codes: the first should show up as a
# failed unit, the second should stay quiet and try again in five minutes.
UNMATCHED = "unmatched"

BACKDROP_APP_ID = "E8C28D3C"
IDLE_APPS = {None, "", BACKDROP_APP_ID, getattr(pychromecast, "IDLE_APP_ID", BACKDROP_APP_ID)}


def receiver_state():
    """(status_text, app_id) for the device, or None if it isn't reachable.

    When the name matches nothing, say what discovery *did* find. A TV someone
    unplugged and a device name that will never match look identical otherwise,
    and the second one stays silently broken until the day the cast drops.
    """
    casts, browser = pychromecast.get_listed_chromecasts(
        friendly_names=[DEVICE], timeout=20
    )
    try:
        if not casts:
            seen, b2 = pychromecast.get_chromecasts(timeout=10)
            names = sorted(c.name for c in seen)
            pychromecast.discovery.stop_discovery(b2)
            if names and DEVICE not in names:
                print(f"{DEVICE!r} matches nothing. Found: {', '.join(names)}. "
                      f"Set FLIGHTBOARD_CAST_DEVICE to one of those.")
                return UNMATCHED
            return None
        cast = casts[0]
        cast.wait(timeout=20)
        return (cast.status.status_text or "").strip(), cast.status.app_id
    finally:
        pychromecast.discovery.stop_discovery(browser)


def main():
    state = receiver_state()
    if state is UNMATCHED:
        return 1                      # misconfigured, and systemd should say so
    if state is None:
        print(f"{DEVICE}: not on the network, nothing to do")
        return 0

    title, app_id = state
    if title == EXPECT_TITLE:
        print(f"{DEVICE}: showing {title}")
        return 0
    if app_id not in IDLE_APPS:
        print(f"{DEVICE}: busy with {title or app_id!r}, leaving it alone")
        return 0

    print(f"{DEVICE}: idle, re-casting {URL}")
    return subprocess.call([CATT, "-d", DEVICE, "cast_site", URL])


if __name__ == "__main__":
    sys.exit(main())
