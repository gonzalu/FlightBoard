<p align="center">
  <img src="img/panel-endpoints.png" width="720">
</p>

<div align="center">

# ✈️ FlightBoard

**A dot-matrix LED flight board for your TV, driven by your own ADS-B receiver.**

</div>

FlightBoard turns any browser — and any TV with a Chromecast or a spare Raspberry
Pi — into a live aviation display showing the aircraft overhead right now:
airline, flight number, route, aircraft type, altitude, speed, track and vertical
rate, one flight at a time.

It reads **your own receiver**. If you already run PiAware, dump1090-fa, readsb
or tar1090, you have everything you need. No cloud flight API, no subscription,
no per-query billing, no account.

It isn't styled to *look* like an LED panel — it emulates one. There's a real
framebuffer, text is drawn from the same Adafruit GFX bitmap font the hardware
uses, and every dot you see is an individually addressed LED.

---

- [✈️ FlightBoard](#️-flightboard)
  * [What it looks like](#what-it-looks-like)
  * [Requirements](#requirements)
    + [You need a working ADS-B feeder first](#you-need-a-working-ads-b-feeder-first)
    + [Everything else](#everything-else)
  * [Install](#install)
    + [1. Clone it](#1-clone-it)
    + [2. Create the Python environment](#2-create-the-python-environment)
    + [3. Point it at your receiver and your location](#3-point-it-at-your-receiver-and-your-location)
    + [4. Try it](#4-try-it)
    + [5. Run it at boot](#5-run-it-at-boot)
  * [Airline logos (optional)](#airline-logos-optional)
  * [Getting it onto a TV](#getting-it-onto-a-tv)
    + [Option A — Chromecast](#option-a--chromecast)
    + [Option B — Raspberry Pi on HDMI](#option-b--raspberry-pi-on-hdmi)
    + [Option C — just a browser](#option-c--just-a-browser)
  * [Configuration reference](#configuration-reference)
  * [How it works](#how-it-works)
  * [Troubleshooting](#troubleshooting)
  * [Acknowledgements](#acknowledgements)
  * [License](#license)

---

## What it looks like

The panel shows one aircraft at a time. The top three lines hold steady while the
bottom two rotate through whatever that flight can tell you.

| | |
|---|---|
| ![metrics](img/panel-metrics.png) | ![endpoints](img/panel-endpoints.png) |
| **Live ADS-B metrics** | **Both ends of the route** |
| ![relative](img/panel-relative.png) | ![eta](img/panel-eta.png) |
| **Arriving from / departing to**, when one end is your local airport | **Estimated arrival**, with a progress bar |

There's a second view at `/dashboard` for when you have a big screen and want
everything at once — a zoomable radar plus a tile per aircraft, as many as fit
the window:

![dashboard](img/dashboard.png)

And a third at `/?model=oss` that reproduces the 160×32 geometry of the
[TheFlightWall_OSS](https://github.com/AxisNimble/TheFlightWall_OSS) DIY build:

![oss](img/panel-oss.png)

Running on an otherwise-dead TV, cast from a Chromecast:

![on the TV](img/on-the-tv.jpg)

---

## Requirements

### You need a working ADS-B feeder first

> **This project does not set up an ADS-B receiver, and does not cover it.** It
> assumes you already have one running and serving its JSON feed on your network.

If you're not there yet, start with FlightAware's PiAware guide (or the
ADSBexchange / readsb equivalents), get your receiver decoding and showing
aircraft on its own map, and come back. You'll know you're ready when a URL like
this returns JSON full of aircraft, in a browser or with `curl`:

```
http://YOUR-PI.local/skyaware/data/aircraft.json
```

| Receiver software | Path |
|---|---|
| PiAware / dump1090-fa | `/skyaware/data/aircraft.json` |
| tar1090 | `/tar1090/data/aircraft.json` |
| readsb / dump1090 | `/data/aircraft.json` |

Any of these work. If your receiver produces the standard `aircraft.json`, so
does FlightBoard.

### Everything else

- A machine that stays on, running Linux, with Python **3.9+**. A Raspberry Pi 3
  or better is plenty — including the same Pi that's already running your
  receiver.
- **About 150 MB of free disk.** The install is ~50 MB of Python packages, and
  you want headroom. Check with `df -h /` before you start — a Pi that's been
  feeding for months is often fuller than you'd think. If you're short, the
  usual culprits are logs:
  ```bash
  sudo journalctl --vacuum-size=50M     # systemd journal
  sudo du -xh --max-depth=1 /var/log | sort -rh | head
  ```
  Feeder daemons can be spectacularly chatty — on the Pi this was tested on,
  `fr24feed` had quietly written 1.6 GB of logs with no rotation.
- A display: a Chromecast, a Pi wired to a TV, or just a browser tab.
- Internet access is **optional**. Without it you lose airline names, routes and
  aircraft types. Altitude, speed, track, position and distance all still work.

---

## Install

### 1. Clone it

```bash
git clone https://github.com/gonzalu/FlightBoard.git ~/flightboard
cd ~/flightboard
```

### 2. Create the Python environment

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
```

> **If `python3 -m venv` fails** with *"ensurepip is not available"*, install the
> venv package first. The name varies by distro:
> - Raspberry Pi OS / Debian: `sudo apt install python3-venv`
> - Ubuntu: `sudo apt install python3-venv`, or a versioned name such as
>   `sudo apt install python3.12-venv` if apt tells you to

### 3. Point it at your receiver and your location

Two things must be right or you'll get an empty board: the **receiver URL** and
**your coordinates**. Everything is filtered by distance from where you are, so
if the location is wrong, nothing is ever "nearby".

```bash
export FLIGHTBOARD_RECEIVERS="http://YOUR-PI.local/skyaware/data/aircraft.json"
export FLIGHTBOARD_HOME_LAT="40.8834"
export FLIGHTBOARD_HOME_LON="-73.9103"
```

Approximate coordinates are fine — three or four decimals off any map. This only
centres the radar and sets the range filter, and it stays on your machine.

**More than one receiver?** List them comma separated. They're all polled and
merged, deduplicated by aircraft, so a second receiver both widens coverage and
keeps the board alive when the first drops off:

```bash
export FLIGHTBOARD_RECEIVERS="http://pi-roof.local/skyaware/data/aircraft.json,http://pi-desk.local/skyaware/data/aircraft.json"
```

### 4. Try it

```bash
.venv/bin/uvicorn backend.main:app --host 0.0.0.0 --port 8090
```

Open `http://YOUR-SERVER:8090/` in a browser. Give it a few seconds — airline and
route lookups fill in progressively after the first aircraft appear.

| URL | View |
|---|---|
| `/` | the LED panel (128×64) |
| `/?model=oss` | the DIY 160×32 build's geometry |
| `/dashboard` | multi-aircraft radar and tiles |
| `/api/aircraft` | raw JSON, useful for debugging |

### 5. Run it at boot

```bash
sudo cp flightboard-backend.service /etc/systemd/system/
sudoedit /etc/systemd/system/flightboard-backend.service   # fill in the CHANGEME lines
sudo systemctl daemon-reload
sudo systemctl enable --now flightboard-backend
systemctl status flightboard-backend
```

The unit file has an `EDIT THESE` block covering the user, install path, your
coordinates and your receivers.

---

## Airline logos (optional)

Out of the box, carriers are drawn as a swept tail fin in their brand colours.
For real airline logos, generate them from artwork you supply:

```bash
.venv/bin/pip install Pillow
curl -sL https://codeload.github.com/Jxck-S/airline-logos/tar.gz/refs/heads/main | tar -xz
.venv/bin/python tools/make_logos.py \
    airline-logos-main/flightaware_logos \
    airline-logos-main/radarbox_logos \
    airline-logos-main/radarbox_banners \
    --size 28 --out frontend/logos.js
```

Reload the page and airlines appear with their own marks. Files are matched by
**ICAO code** (`DAL.png`, `AAL.png`) because that's the prefix FlightBoard reads
off the callsign. Later directories act as fallbacks, used only when earlier
artwork can't survive being reduced to a 28 px square.

A few knobs at the top of `tools/make_logos.py`, all one-line entries:

| | |
|---|---|
| `BACKGROUND` | force a carrier onto black or onto a light tile |
| `CROPS` | use a square region of a wider logo |
| `KNOCK_COLOURED_BG` | strip a solid colour background |
| `LIGHT_INK_THRESHOLD` | where the automatic light/dark decision sits |

`frontend/logo-aliases.js` maps a callsign prefix to another carrier's logo,
which is how regional airlines get their mainline partner's tail.

> ⚠️ **Airline logos are trademarks of their airlines.** `frontend/logos.js` is
> generated locally and is **gitignored on purpose** — please don't commit
> artwork into a public fork. Generating it for your own display is one thing;
> redistributing it is another.

---

## Getting it onto a TV

### Option A — Chromecast

The stick loads the page and renders it itself, so no computer has to stay awake
driving the picture.

```bash
.venv/bin/pip install catt
.venv/bin/catt scan
.venv/bin/catt -d "Living Room TV" cast_site "http://YOUR-SERVER:8090/"
```

To have it re-establish itself after a reboot or power blip:

```bash
sudo cp flightboard-cast.service flightboard-cast.timer /etc/systemd/system/
sudoedit /etc/systemd/system/flightboard-cast.service   # user, device name, URL
sudo systemctl daemon-reload
sudo systemctl enable --now flightboard-cast.timer
```

The watchdog checks every five minutes and only re-casts an **idle** Chromecast —
if you're watching something else on that TV, it leaves you alone.

> `cast_site` relies on the DashCast receiver, which isn't a documented Google
> feature. It works on classic Chromecast sticks and Chromecast Ultra. It does
> **not** work on Chromecast with Google TV. If it ever stops working, Option B
> is the durable answer.

### Option B — Raspberry Pi on HDMI

The most robust option, and it needs no casting protocol at all. Any spare Pi,
Raspberry Pi OS Lite, and Chromium in kiosk mode:

```bash
sudo apt install chromium-browser cage
cage -- chromium-browser --kiosk --noerrdialogs --disable-infobars \
     --check-for-update-interval=31536000 http://YOUR-SERVER:8090/
```

Add that as a systemd service to start at boot. `cec-utils` can also switch the
TV on and off on a schedule over HDMI-CEC, which makes it feel built in.

### Option C — just a browser

Open the URL and press F11. Perfectly good on a spare monitor.

---

## Configuration reference

All settings are environment variables, read at startup.

| Variable | Default | What it does |
|---|---|---|
| `FLIGHTBOARD_RECEIVERS` | *(see below)* | Comma-separated receiver JSON URLs. All are polled and merged. |
| `FLIGHTBOARD_HOME_LAT` | `0.0` | Your latitude. **Set this.** |
| `FLIGHTBOARD_HOME_LON` | `0.0` | Your longitude. **Set this.** |
| `FLIGHTBOARD_MAX_RANGE_NM` | `40` | Ignore aircraft further away than this. |
| `FLIGHTBOARD_LOCAL_AIRPORT_NM` | `30` | An airport this close counts as "local", which turns a route into *Arriving from…* / *Departing to…* |
| `FLIGHTBOARD_MAX_AIRCRAFT` | `60` | Cap on how many aircraft the API returns. |
| `FLIGHTBOARD_POLL_INTERVAL` | `2` | Seconds between receiver polls. |
| `FLIGHTBOARD_ENABLE_ENRICH` | `1` | Set `0` to disable adsbdb lookups and run fully offline. |
| `FLIGHTBOARD_ENRICH_TTL` | `3600` | Seconds to cache an airline/route/type lookup. |
| `FLIGHTBOARD_PORT` | `8090` | Port. |

Display behaviour lives in `CFG` at the top of `frontend/panel.js`: `PAGE_MS`
(how long each bottom page holds), `MAX_FLIGHTS` (how many aircraft to cycle
through), `SKIP_GROUND` (whether to include aircraft on the ground).

---

## How it works

```
your receiver(s) ──aircraft.json──> FlightBoard backend ──/api/aircraft──> panel / dashboard
                                           │
                                           └── adsbdb.com  (optional: airline, route, type)
```

The **backend** polls every receiver every couple of seconds, merges the aircraft
(freshest position wins on duplicates), works out distance and bearing from your
location, and serves both the API and the frontend from one origin.

Airline, route and aircraft type come from [adsbdb](https://www.adsbdb.com/) —
free, no key. Those lookups run in a **background worker**, never inside the poll
loop, so a burst of unknown aircraft can't stall the position feed. Results are
cached, including negative ones, and served stale while they refresh.

The **panel** is a genuine emulation. `frontend/glcdfont.js` is the Adafruit GFX
classic 5×7 bitmap font — the same table the hardware draws with — blitted one
bit per LED into a framebuffer, which is then drawn as physical dots with the
unlit LEDs still visible between them. At 6 px per character a 128 px panel fits
21 characters, and that constraint is why the readouts are written the way they
are.

---

## Troubleshooting

**The board says "No aircraft in range"**
Almost always the coordinates. Check `FLIGHTBOARD_HOME_LAT` / `_LON` are set and
aren't still `0.0` — that's a spot in the Atlantic, so nothing will ever be
nearby. Then check `curl http://YOUR-SERVER:8090/api/aircraft`, and try widening
`FLIGHTBOARD_MAX_RANGE_NM`.

**It says "NO FEED"**
The backend can't reach a receiver. Test the URL directly with `curl`. The API's
`sources` field reports each receiver separately, so you can see which one is
down. The board keeps showing the last good data for 90 seconds before giving up,
so brief network blips don't blank the display.

**Airlines and routes are missing, but altitude and speed are fine**
That's adsbdb being unreachable, or the aircraft genuinely being unknown — GA
aircraft have no airline. Check outbound internet, or set
`FLIGHTBOARD_ENABLE_ENRICH=0` if you meant to run offline.

**`catt scan` finds nothing**
The Chromecast has to be powered on and on the same subnet — discovery is mDNS
and doesn't cross VLANs. Some managed switches and access points block multicast.

**Everything works but the display never changes**
Browsers throttle timers in background tabs. Make it the foreground tab, or use
kiosk mode.

---

## Acknowledgements

- **[TheFlightWall](https://theflightwall.com/)** for the original idea, and
  [TheFlightWall_OSS](https://github.com/AxisNimble/TheFlightWall_OSS) for the
  firmware that documents how the real panel is laid out and drawn. FlightBoard
  is an independent project inspired by it — not affiliated with, endorsed by, or
  a product of TheFlightWall.
- **[Adafruit](https://github.com/adafruit/Adafruit-GFX-Library)** for the GFX
  library, whose classic 5×7 bitmap font (BSD licensed) is embedded here as
  `frontend/glcdfont.js`.
- **[adsbdb](https://www.adsbdb.com/)** for a genuinely free, keyless API for
  airline, route and aircraft lookups.
- **[Jxck-S/airline-logos](https://github.com/Jxck-S/airline-logos)** for
  collecting airline logo artwork by ICAO code.
- **[catt](https://github.com/skorokithakis/catt)** and
  **[pychromecast](https://github.com/home-assistant-libs/pychromecast)** for
  making Chromecasts scriptable.
- Everyone feeding **FlightAware**, **ADSBexchange** and friends — this project is
  only interesting because you already run a receiver.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

The embedded Adafruit GFX font is BSD licensed and remains © Adafruit. Airline
logos processed by `tools/make_logos.py` are trademarks of their respective
airlines and are not distributed with this project.
