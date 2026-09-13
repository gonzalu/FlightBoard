#!/usr/bin/env python3
"""Print the systemd units with your account and paths already filled in.

The installer knows both answers without asking: `id -un` gives the account,
and this file's own location gives the checkout. There is no question to put in
a prompt, so there isn't one.

It prints to stdout rather than writing to /etc, so you see exactly what is
about to be installed and root is only involved for the part that needs it:

    python3 tools/make-units.py backend | sudo tee /etc/systemd/system/flightboard-backend.service
    python3 tools/make-units.py cast --device "Kitchen TV" --url http://10.0.1.128:8090/ \
        | sudo tee /etc/systemd/system/flightboard-cast.service

Two values it genuinely cannot work out are the Chromecast's friendly name and
a URL the stick can reach, so `cast` asks for them on the command line and
refuses to emit a half-filled unit. Everything else is derived.
"""

import argparse
import getpass
import os
import socket
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNITS = {"backend": "flightboard-backend.service",
         "cast": "flightboard-cast.service",
         "timer": "flightboard-cast.timer"}


def local_ip():
    """This host's address on the network the default route uses.

    Not for binding - the backend already listens on everything - but as the
    address to suggest for the cast URL, since a Chromecast pins itself to
    Google's DNS and will not resolve a name from your own router.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))       # TEST-NET-1: routed nowhere, sends nothing
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()


def fill(name, user, root, device=None, url=None):
    path = os.path.join(root, UNITS[name])
    with open(path, encoding="utf-8") as f:
        text = f.read()
    # the longer pattern first: the path contains the user placeholder
    text = text.replace("/home/YOUR-USER/flightboard", root)
    text = text.replace("YOUR-USER", user)
    if device is not None:
        text = text.replace("YOUR-CHROMECAST", device)
    if url is not None:
        text = text.replace("http://YOUR-SERVER-IP:8090/", url)
    return text


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("unit", nargs="?", default="backend",
                    choices=sorted(UNITS) + ["all"],
                    help="which unit to print (default: backend)")
    ap.add_argument("--user", default=getpass.getuser(),
                    help="account to run as (default: whoever is running this)")
    ap.add_argument("--dir", default=ROOT,
                    help="checkout path (default: where this script lives)")
    ap.add_argument("--device", help="Chromecast friendly name, as `catt scan` reports it")
    ap.add_argument("--url", help="panel URL the Chromecast should load; use an IP")
    args = ap.parse_args()

    root = os.path.abspath(args.dir)
    if not os.path.isdir(os.path.join(root, "backend")):
        sys.exit(f"{root} does not look like a FlightBoard checkout")

    names = sorted(UNITS) if args.unit == "all" else [args.unit]
    if "cast" in names and not (args.device and args.url):
        ip = local_ip()
        sys.exit(
            "the cast unit needs --device and --url, which nothing can guess:\n"
            "  --device  the Chromecast's friendly name, from `.venv/bin/catt scan`\n"
            "  --url     the panel URL the stick loads. Use this host's IP address"
            + (f", probably http://{ip}:8090/" if ip else "")
            + "\n            (a Chromecast ignores your DHCP resolver, so a hostname"
              " will not work)")

    for i, name in enumerate(names):
        if len(names) > 1:
            print(f"{'#' * 76}\n# {UNITS[name]}\n{'#' * 76}" if i else
                  f"{'#' * 76}\n# {UNITS[name]}\n{'#' * 76}")
        sys.stdout.write(fill(name, args.user, root, args.device, args.url))


if __name__ == "__main__":
    main()
