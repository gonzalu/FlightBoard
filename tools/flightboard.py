#!/usr/bin/env python3
"""
Keep a FlightBoard install up to date without remembering the recipe.

    python3 tools/flightboard.py              a menu
    python3 tools/flightboard.py update       pull, then do whatever that needs
    python3 tools/flightboard.py status       what is running and what is stale

`update` looks at what is about to change and at what is already out of date on
this machine, prints the steps it thinks are needed, asks once, and runs them.
Nothing here is new: every step is a command from the README's "Keeping it up
to date", in the order that section gives them. What it takes off your hands is
knowing which of them apply.

Run it with the system python3, not the .venv one: the logo generator needs
Pillow, which the backend's environment does not have. Standard library only
otherwise, so it works on a Pi.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
sys.path[:0] = [str(ROOT), str(TOOLS)]

UNIT = "flightboard-backend"
ARCHIVE_URL = "https://codeload.github.com/Jxck-S/airline-logos/tar.gz/refs/heads/main"
# In priority order, after logo-sources/custom and logo-sources/fetched.
ARCHIVE_DIRS = ["flightaware_logos", "radarbox_logos", "radarbox_banners",
                "avcodes_banners", "fr24_banners"]
LOGO_SIZE = 28

LOGOS_JS = ROOT / "frontend" / "logos.js"
LOGOS_PREV = ROOT / "logo-sources" / "logos.js.prev"
STANDING_DB = ROOT / "data" / "standing-data.sqlite"
BASEMAP_JS = ROOT / "frontend" / "basemap.js"

LOGO_TOOLS = ("tools/make_logos.py", "tools/fetch_logo_art.py")
# What each generated file is built from. A file records a fingerprint of these
# when it is built, so "is it stale" is a question about content, not about
# file times, which a fresh checkout or a comment-only change would disturb.
BUILDERS = {
    "logos": [TOOLS / "make_logos.py", TOOLS / "fetch_logo_art.py"],
    "database": [TOOLS / "fetch_standing_data.py"],
    "basemap": [TOOLS / "make_basemap.py"],
}
PRODUCTS = {"logos": LOGOS_JS, "database": STANDING_DB, "basemap": BASEMAP_JS}
STAMPS = ROOT / "data" / ".built.json"
UNIT_FILES = ("flightboard-backend.service", "flightboard-cast.service",
              "flightboard-cast.timer")


# --- small helpers ----------------------------------------------------------

def say(msg=""):
    print(msg, flush=True)


def run(cmd, check=True, **kw):
    """Run a command with its output on the terminal, so a sudo prompt works."""
    say("  $ " + " ".join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], cwd=ROOT, check=check, **kw)


def out(cmd):
    """A command's stdout, or None if it could not run or failed."""
    try:
        r = subprocess.run([str(c) for c in cmd], cwd=ROOT, capture_output=True,
                           text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def git(*args):
    return out(["git", *args])


def confirm(question, assume_yes):
    if assume_yes:
        return True
    if not sys.stdin.isatty():
        say("Not a terminal, so nothing to ask: pass --yes to go ahead.")
        return False
    try:
        return input(f"{question} [Y/n] ").strip().lower() in ("", "y", "yes")
    except EOFError:
        say("")
        say("No answer, so nothing was done. Pass --yes to go ahead unattended.")
        return False


def mtime(path):
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return None


def age(path):
    t = mtime(path)
    if t is None:
        return "missing"
    days = (time.time() - t) / 86400
    return f"{days:.0f} days old" if days >= 1 else "less than a day old"


def fingerprint(key):
    h = hashlib.sha1()
    for f in BUILDERS[key]:
        try:
            h.update(f.read_bytes())
        except OSError:
            pass
    return h.hexdigest()[:12]


def stamps():
    try:
        return json.loads(STAMPS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def record_built(key):
    known = stamps()
    known[key] = fingerprint(key)
    STAMPS.parent.mkdir(parents=True, exist_ok=True)
    STAMPS.write_text(json.dumps(known, indent=1), encoding="utf-8")


def builder_changed(key):
    """Why a generated file is out of date, or None if it is current.

    Only for things this install has built: nobody is asked to start using
    logos, the database or the map. An install built before fingerprints existed
    is judged once by file times, and stamped when it is next rebuilt.
    """
    product = PRODUCTS[key]
    if not product.exists():
        return None
    known = stamps().get(key)
    if known is not None:
        return None if known == fingerprint(key) else "its builder changed since it was built"
    newest = max((mtime(f) or 0) for f in BUILDERS[key])
    return "older than its builder" if (mtime(product) or 0) < newest else None


def logo_count(path):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return 0
    return len(re.findall(r'^  \w+: \{"p"', text, re.M))


# --- what the backend is doing ---------------------------------------------

def service_installed():
    return out(["systemctl", "cat", UNIT]) is not None


def service_started():
    """When the running backend started, as epoch seconds, or None."""
    stamp = out(["systemctl", "show", UNIT, "-p", "ActiveEnterTimestamp",
                 "--value", "--timestamp=unix"])
    if stamp and stamp.startswith("@"):
        return float(stamp[1:])
    text = out(["systemctl", "show", UNIT, "-p", "ActiveEnterTimestamp", "--value"])
    epoch = out(["date", "-d", text, "+%s"]) if text else None
    return float(epoch) if epoch else None


def newest_backend_change():
    files = list((ROOT / "backend").glob("*.py"))
    try:
        from backend import config
        files.append(Path(config.ENV_FILE))
    except Exception:
        files.append(ROOT / "flightboard.env")
    times = [t for t in (mtime(f) for f in files) if t]
    return max(times) if times else None


def api():
    """The backend's own answer, with debug detail, or None if it is not up."""
    try:
        from backend import config
        port = config.PORT
    except Exception:
        port = 8090
    try:
        with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/api/aircraft?debug=1", timeout=5) as r:
            return json.load(r)
    except Exception:
        return None


# --- what needs doing -------------------------------------------------------

def stale_logo_recipes():
    """Fetched artwork whose recipe has changed since it was downloaded."""
    fetched = ROOT / "logo-sources" / "fetched"
    if not fetched.is_dir():
        return []
    try:
        import fetch_logo_art as fla
    except ImportError:
        return []
    try:
        known = json.loads((fetched / ".recipes.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        known = {}
    return [c for c in fla.SOURCES if known.get(c) != fla.recipe(c)]


def needed(incoming):
    """Ordered (key, why) steps, from what is incoming and what is stale here.

    Only things this install actually uses are considered: someone who never
    built the logos, the database or the map is not asked to start now.
    """
    steps = {}
    inc = set(incoming)

    def want(key, why):
        steps.setdefault(key, why)

    if "backend/requirements.txt" in inc:
        want("deps", "backend/requirements.txt changed")

    for key, files in (("logos", LOGO_TOOLS),
                       ("database", ("tools/fetch_standing_data.py",)),
                       ("basemap", ("tools/make_basemap.py",))):
        if not PRODUCTS[key].exists():
            continue
        if inc & set(files):
            want(key, "its builder is about to change")
        why = builder_changed(key)
        if why:
            want(key, why)
    if LOGOS_JS.exists() and stale_logo_recipes():
        want("logos", "fetched artwork is out of date: "
                      + ", ".join(stale_logo_recipes()))

    if service_installed():
        started, changed = service_started(), newest_backend_change()
        if any(f.startswith("backend/") for f in inc):
            want("restart", "backend code changed")
        elif started and changed and changed > started:
            want("restart", "backend code or flightboard.env is newer than the "
                            "running process")

    order = ["deps", "logos", "database", "basemap", "restart"]
    return [(k, steps[k]) for k in order if k in steps]


LABELS = {
    "deps": "install backend dependencies",
    "logos": "rebuild the airline logos",
    "database": "rebuild the local database",
    "basemap": "rebuild the radar map",
    "restart": "restart the backend",
}


# --- the steps --------------------------------------------------------------

def step_deps():
    pip = ROOT / ".venv" / "bin" / "pip"
    if not pip.exists():
        say("  no .venv found; install backend/requirements.txt yourself")
        return
    run([pip, "install", "-q", "-r", ROOT / "backend" / "requirements.txt"])


def step_logos():
    try:
        import PIL  # noqa: F401
    except ImportError:
        raise SystemExit("The logo generator needs Pillow. Run this with the "
                         "system python3 (pip install pillow), not the .venv one.")
    run([sys.executable, TOOLS / "fetch_logo_art.py"])

    tmp = Path(tempfile.mkdtemp(prefix="logosrc-"))
    try:
        say("  downloading the logo archive (about 70 MB)...")
        with urllib.request.urlopen(urllib.request.Request(
                ARCHIVE_URL, headers={"User-Agent": "FlightBoard/1.0 "
                "(+https://github.com/gonzalu/FlightBoard)"}), timeout=120) as r:
            with tarfile.open(fileobj=r, mode="r|gz") as tf:
                try:
                    tf.extractall(tmp, filter="data")
                except TypeError:            # Python before 3.12 has no filter
                    tf.extractall(tmp)
        base = tmp / "airline-logos-main"
        dirs = [base / d for d in ARCHIVE_DIRS]
        images = sum(len(list(d.glob("*.png"))) for d in dirs if d.is_dir())
        # Without its archive the generator would happily build a logos.js from
        # a handful of files and wipe the board's logos with no error at all.
        if not all(d.is_dir() for d in dirs) or images < 2000:
            raise SystemExit(f"The archive looks incomplete ({images} images), so "
                             "logos.js has been left alone.")

        built = tmp / "logos.js"
        run([sys.executable, TOOLS / "make_logos.py",
             ROOT / "logo-sources" / "custom", ROOT / "logo-sources" / "fetched",
             *dirs, "--size", LOGO_SIZE, "--out", built])
        new, old = logo_count(built), logo_count(LOGOS_JS)
        if old and new < old * 0.9:
            raise SystemExit(f"The new logos.js has {new} logos against {old} now, "
                             "which is too big a drop to trust. Left alone.")
        if LOGOS_JS.exists():
            LOGOS_PREV.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(LOGOS_JS, LOGOS_PREV)
        shutil.copy2(built, LOGOS_JS)
        record_built("logos")
        say(f"  logos.js: {new} logos (was {old}); the old one is kept at "
            f"{LOGOS_PREV.relative_to(ROOT)}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def step_database():
    run([sys.executable, TOOLS / "fetch_standing_data.py"])
    record_built("database")


def step_basemap():
    run([sys.executable, TOOLS / "make_basemap.py"])
    record_built("basemap")
    say("  reload the dashboard to see the new map")


def step_restart():
    if not service_installed():
        say(f"  the {UNIT} service is not installed here; restart your uvicorn by hand")
        return
    run(["sudo", "systemctl", "restart", UNIT])
    for _ in range(20):
        time.sleep(1)
        if api():
            say("  backend is answering again")
            return
    say("  the backend did not answer within 20 seconds: "
        f"journalctl -u {UNIT} -n 30")


STEPS = {"deps": step_deps, "logos": step_logos, "database": step_database,
         "basemap": step_basemap, "restart": step_restart}


# --- commands ---------------------------------------------------------------

def cmd_update(args):
    if git("rev-parse", "--git-dir") is None:
        raise SystemExit("This is not a git checkout, so there is nothing to pull.")
    say("Checking for updates...")
    run(["git", "fetch", "--quiet"], check=False)
    behind = int(git("rev-list", "--count", "HEAD..@{u}") or 0)
    incoming = (git("diff", "--name-only", "HEAD..@{u}") or "").split() if behind else []

    if behind:
        say(f"\n{behind} new commit(s):")
        say(git("log", "--oneline", "HEAD..@{u}") or "")
    steps = needed(incoming)
    if not behind and not steps:
        say("Up to date, and nothing is stale.")
        return
    say("\nThis will:")
    if behind:
        say("  - pull the new commits (your own edits are set aside and put back)")
    for key, why in steps:
        say(f"  - {LABELS[key]}  ({why})")
    for name in UNIT_FILES:
        if name in incoming:
            say(f"\nNote: {name} changed. Installing it is not automatic; see "
                "'Keeping it up to date' in the README.")
    if args.dry_run:
        say("\n(dry run: nothing was changed)")
        return
    if not confirm("\nGo ahead?", args.yes):
        return

    if behind:
        say("\nPulling...")
        run(["git", "pull", "--autostash"])
        if any(l[:2] in ("UU", "AA", "DU", "UD") for l in
               (git("status", "--porcelain") or "").splitlines()):
            raise SystemExit("\nThe pull left conflict markers where you had edited "
                             "a shipped file. Nothing else was run. The README's "
                             "'Keeping it up to date' explains how to clear it.")
    for key, _ in steps:
        say(f"\n== {LABELS[key]}")
        STEPS[key]()
    say("\nDone.")
    cmd_status(args)


def cmd_status(_args=None):
    say("FlightBoard status")
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    head = git("log", "-1", "--format=%h %s")
    say(f"  code       {branch}  {head}")
    behind = git("rev-list", "--count", "HEAD..@{u}")
    say(f"  updates    {'unknown (no upstream)' if behind is None else f'{behind} commit(s) behind'}"
        "  (run 'update' to check afresh)")
    dirty = git("status", "--porcelain", "--untracked-files=no")
    if dirty:
        say(f"  edited     {len(dirty.splitlines())} shipped file(s) changed locally")

    if service_installed():
        state = out(["systemctl", "is-active", UNIT]) or "not active"
        say(f"  service    {UNIT}: {state}")
    else:
        say(f"  service    {UNIT}: not installed here")

    d = api()
    if d is None:
        say("  backend    not answering")
    else:
        rx = ", ".join(f"{s['name']} {'ok' if s['ok'] else 'DOWN'}" for s in d["sources"])
        say(f"  backend    {len(d['aircraft'])} aircraft in range; receivers: {rx}")
        aero = ((d.get("debug") or {}).get("aeroapi") or {})
        if aero.get("enabled"):
            say(f"  aeroapi    {aero['state']}  ${aero['spent']} of ${aero['cap']} "
                f"in {aero['month']}, {aero['calls']} calls")
    steps = needed([])
    say(f"  logos      {logo_count(LOGOS_JS)} logos, {age(LOGOS_JS)}" if LOGOS_JS.exists()
        else "  logos      not built (optional)")
    say(f"  database   {age(STANDING_DB)}" if STANDING_DB.exists()
        else "  database   not built (optional)")
    say(f"  map        {age(BASEMAP_JS)}" if BASEMAP_JS.exists()
        else "  map        not built (optional)")
    if steps:
        say("\nOut of date here:")
        for key, why in steps:
            say(f"  - {LABELS[key]}  ({why})")
    else:
        say("\nNothing is out of date on this machine.")


def cmd_step(key):
    def go(args):
        say(f"== {LABELS[key]}")
        STEPS[key]()
    return go


def cmd_logs(_args):
    try:
        run(["journalctl", "-u", UNIT, "-f"], check=False)
    except KeyboardInterrupt:
        pass


def menu(args):
    items = [
        ("Update (pull, then do whatever is needed)", cmd_update),
        ("Status", cmd_status),
        ("Rebuild the airline logos", cmd_step("logos")),
        ("Rebuild the local database", cmd_step("database")),
        ("Restart the backend", cmd_step("restart")),
        ("Watch the log", cmd_logs),
    ]
    while True:
        say("\nFlightBoard maintenance")
        for i, (label, _) in enumerate(items, 1):
            say(f"  {i}) {label}")
        say("  q) Quit")
        choice = input("> ").strip().lower()
        if choice in ("q", "quit", ""):
            return
        if choice.isdigit() and 1 <= int(choice) <= len(items):
            say()
            try:
                items[int(choice) - 1][1](args)
            except subprocess.CalledProcessError as e:
                say(f"\nThat step failed (exit {e.returncode}); see above.")
        else:
            say("Pick a number, or q.")


def main():
    ap = argparse.ArgumentParser(description="Maintain a FlightBoard install.")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--yes", "-y", action="store_true",
                        help="do not ask before running the planned steps")
    common.add_argument("--dry-run", action="store_true",
                        help="show the plan for 'update' and stop")
    sub = ap.add_subparsers(dest="command")
    for name, fn in (("update", cmd_update), ("status", cmd_status),
                     ("logos", cmd_step("logos")), ("database", cmd_step("database")),
                     ("basemap", cmd_step("basemap")), ("restart", cmd_step("restart")),
                     ("logs", cmd_logs)):
        sub.add_parser(name, parents=[common]).set_defaults(fn=fn)
    args = ap.parse_args()
    args.yes, args.dry_run = getattr(args, "yes", False), getattr(args, "dry_run", False)
    try:
        (getattr(args, "fn", None) or menu)(args)
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"\nA step failed (exit {e.returncode}); see above.")
    except KeyboardInterrupt:
        raise SystemExit("\nInterrupted.")


if __name__ == "__main__":
    main()
