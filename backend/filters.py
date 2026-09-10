"""Which aircraft to hide, re-read from filters.json whenever it changes.

Deliberately separate from config.py, which is read once at startup. That is
right for a port or a receiver URL, where changing it means a restart anyway.
Filters are the opposite: they are the setting you fiddle with while watching
the board, so editing the file is enough and the display catches up on the next
poll. It is also the natural place for a settings page to write to later.

A malformed file keeps the last rules that parsed and logs why, rather than
dropping every filter because of a stray comma.
"""

import json
import logging
import os
from pathlib import Path

log = logging.getLogger("flightboard")

FILTERS_FILE = Path(
    os.environ.get(
        "FLIGHTBOARD_FILTERS_FILE",
        Path(__file__).resolve().parent.parent / "filters.json",
    )
)

INFINITY = float("inf")


class Rules:
    """The parsed contents of filters.json. Empty means nothing is hidden."""

    __slots__ = ("hex", "airlines", "registrations", "types", "airports",
                 "min_ft", "max_ft")

    def __init__(self, data=None):
        data = data or {}
        exclude = data.get("exclude") or {}
        self.hex = _as_set(exclude.get("hex"), lower=True)
        self.airlines = _as_set(exclude.get("airlines"))
        self.registrations = _as_set(exclude.get("registrations"))
        # Types are matched as substrings, because the same airframe arrives as
        # "CRJ 900", "CRJ 900 LR NG" or "CRJ-900" depending on the source. One
        # entry of "CRJ" hides the lot, which is what anyone actually wants.
        self.types = _as_set(exclude.get("types"))
        # An airport hides flights at either end of the route, by IATA code.
        self.airports = _as_set(exclude.get("airports"))
        band = data.get("altitude_ft") or {}
        self.min_ft = _as_number(band.get("min"), 0.0)
        self.max_ft = _as_number(band.get("max"), INFINITY)

    def active(self):
        """Human-readable summary of what is being hidden, or None."""
        parts = []
        for label, values in (("hex", self.hex), ("airlines", self.airlines),
                              ("registrations", self.registrations),
                              ("types", self.types), ("airports", self.airports)):
            if values:
                parts.append(f"{label} {','.join(sorted(values))}")
        if self.min_ft > 0 or self.max_ft != INFINITY:
            hi = "any" if self.max_ft == INFINITY else f"{self.max_ft:g}"
            parts.append(f"altitude {self.min_ft:g}..{hi} ft")
        return "; ".join(parts) or None

    def hides_type(self, type_name):
        """Substring match, so "CRJ" catches every variant spelling."""
        if not self.types or not type_name:
            return False
        upper = type_name.upper()
        return any(t in upper for t in self.types)

    def hides_route(self, route):
        """True if either end of the route is an excluded airport."""
        if not self.airports or not route:
            return False
        ends = {str(route.get("origin") or "").upper(),
                str(route.get("destination") or "").upper()}
        return bool(ends & self.airports)



def _as_set(values, lower=False):
    if not isinstance(values, (list, tuple)):
        return frozenset()
    out = (str(v).strip().lower() if lower else str(v).strip().upper() for v in values)
    return frozenset(v for v in out if v)


def _as_number(value, default):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


_rules = Rules()
_stamp = None            # (mtime_ns, size) of the file the rules came from
_error = None            # why the file was rejected, if it was
_complained = False      # so a broken file doesn't log on every poll


def error():
    """Why the file was last rejected, or None. Reported by /api/aircraft,
    because a filter file that silently does nothing is worse than one that
    obviously does nothing."""
    return _error


def current():
    """The active rules, re-reading the file if it has changed on disk."""
    global _rules, _stamp, _error, _complained
    try:
        st = FILTERS_FILE.stat()
        stamp = (st.st_mtime_ns, st.st_size)
    except OSError:
        stamp = None                      # no file is the normal case
    if stamp == _stamp:
        return _rules
    _stamp = stamp
    if stamp is None:
        _rules, _error, _complained = Rules(), None, False
        return _rules
    try:
        data = json.loads(FILTERS_FILE.read_text(encoding="utf-8"))
        _rules = Rules(data)
        _error, _complained = None, False
        log.info("filters reloaded: %s", _rules.active() or "nothing hidden")
    except Exception as e:
        # keep whatever last parsed: a typo shouldn't silently unhide everything
        _error = f"{FILTERS_FILE.name}: {e}"
        if not _complained:
            log.warning("%s could not be read (%s); keeping the previous filters",
                        FILTERS_FILE, e)
            _complained = True
    return _rules


if __name__ == "__main__":
    # `python3 -m backend.filters` — check the file before wondering why the
    # board ignored it. Editing JSON by hand and getting no feedback is how a
    # bare LGA instead of "LGA" costs an afternoon.
    import sys
    logging.basicConfig(level=logging.CRITICAL)
    rules = current()
    print(FILTERS_FILE)
    if error():
        print("  INVALID: " + error())
        print("  Nothing is being hidden. Values must be quoted: [\"LGA\"], not [LGA].")
        sys.exit(1)
    print("  hiding: " + (rules.active() or "nothing"))
