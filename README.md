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
  * [Better routes (optional)](#better-routes-optional)
  * [A map under the radar (optional)](#a-map-under-the-radar-optional)
    + [A sharper map, live from OpenStreetMap](#a-sharper-map-live-from-openstreetmap)
  * [Getting it onto a TV](#getting-it-onto-a-tv)
    + [Option A — Chromecast](#option-a--chromecast)
    + [Option B — Raspberry Pi on HDMI](#option-b--raspberry-pi-on-hdmi)
    + [Option C — just a browser](#option-c--just-a-browser)
  * [Keeping it up to date](#keeping-it-up-to-date)
  * [Hiding traffic you don't want](#hiding-traffic-you-dont-want)
  * [Customising the logos](#customising-the-logos)
  * [Configuration reference](#configuration-reference)
  * [Helicopters](#helicopters)
  * [The direction arrow](#the-direction-arrow)
  * [Which receiver saw it](#which-receiver-saw-it)
  * [How it works](#how-it-works)
  * [Debug mode](#debug-mode)
  * [Troubleshooting](#troubleshooting)
  * [Uninstalling](#uninstalling)
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
everything at once — a radar you can zoom (scroll) and pan (drag), plus a tile
per aircraft, as many as fit the window. Double-click the radar to put it back:

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
sudo apt install -y git        # a stock Ubuntu desktop does not have it
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
cp flightboard.env.example flightboard.env
nano flightboard.env
```

How far out to look isn't here: that's `range_nm` in `filters.json`, covered in
[Hiding traffic you don't want](#hiding-traffic-you-dont-want).

The three lines that matter, with the author's own as a worked example:

```
FLIGHTBOARD_HOME_LAT=40.8834
FLIGHTBOARD_HOME_LON=-73.9103
FLIGHTBOARD_RECEIVERS=http://YOUR-PI.local/skyaware/data/aircraft.json
```

Approximate coordinates are fine — three or four decimals off any map. They only
centre the radar and set the range filter, and they stay on your machine:
`flightboard.env` is gitignored because it holds your location.

**You only write this down once.** Both ways of starting the board read this
same file: the manual run in step 4 and the systemd service in step 5. There is
no second copy to keep in step.

Settings are read from three places, and the first one that has an answer wins:

| Source | Beats |
|---|---|
| the environment | everything below |
| `flightboard.env` | the defaults |
| built-in defaults | nothing |

That order is what makes a one-off change easy. Putting `NAME=value` in front of
a command is shell syntax for *run this once, with that set* — nothing is
edited, nothing persists, and the next start is back to whatever the file says:

```bash
FLIGHTBOARD_MAX_AIRCRAFT=200 .venv/bin/uvicorn backend.main:app
```

**More than one receiver?** List them comma separated. They're all polled and
merged, deduplicated by aircraft, so a second receiver both widens coverage and
keeps the board alive when the first drops off:

```
FLIGHTBOARD_RECEIVERS=http://pi-roof.local/skyaware/data/aircraft.json,http://pi-desk.local/skyaware/data/aircraft.json
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
| `/logos.html` | every generated airline logo, searchable |
| `/api/aircraft` | raw JSON, useful for debugging |

### 5. Run it at boot

**Stop the manual run from step 4 first** — Ctrl+C in that terminal. Both bind
port 8090, and the failure is a confusing one: the service cannot start, retries
every five seconds forever, and the board keeps working the whole time because
the manual process is still answering. It looks like it worked.

The unit needs your account name and the path you cloned to. You do not have to
type them, because `make-units.py` already knows both:

```bash
python3 tools/make-units.py backend | sudo tee /etc/systemd/system/flightboard-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now flightboard-backend
systemctl status flightboard-backend
```

It prints to standard output rather than writing to `/etc` itself, so you see
exactly what is about to be installed. Your coordinates and receivers are not in
there — they stay in `flightboard.env`, which the unit reads with
`EnvironmentFile=`.

<details><summary>Filling it in by hand instead</summary>

Needed when the service should run as a **different account** than the one
installing, which is the one thing a script cannot work out.

```bash
sudo cp flightboard-backend.service /etc/systemd/system/
sudoedit /etc/systemd/system/flightboard-backend.service   # the YOUR-USER lines
sudo systemctl daemon-reload
sudo systemctl enable --now flightboard-backend
```

Check it saved. `sudoedit` installs your changes only if the editor exits
cleanly, and says nothing at all when it doesn't:

```bash
grep -c YOUR-USER /etc/systemd/system/flightboard-backend.service   # must print 0
```
</details>

See [Keeping it up to date](#keeping-it-up-to-date) for what a later change
needs, and what it doesn't.

---

## Airline logos (optional)

Out of the box, carriers are drawn as a swept tail fin in their brand colours,
or as a helicopter if the aircraft is a rotorcraft.
That is a deliberate fallback, not a broken state, and a board that never runs
this section still looks finished.

For real airline logos, one block:

```bash
sudo apt install -y python3-pil        # Debian's prebuilt Pillow
python3 tools/fetch_logo_art.py        # three marks the bulk archive does badly
mkdir -p /tmp/logosrc && cd /tmp/logosrc
curl -sL https://codeload.github.com/Jxck-S/airline-logos/tar.gz/refs/heads/main | tar -xz
cd ~/flightboard
python3 tools/make_logos.py \
    logo-sources/custom logo-sources/fetched \
    /tmp/logosrc/airline-logos-main/flightaware_logos \
    /tmp/logosrc/airline-logos-main/radarbox_logos \
    /tmp/logosrc/airline-logos-main/radarbox_banners \
    /tmp/logosrc/airline-logos-main/avcodes_banners \
    /tmp/logosrc/airline-logos-main/fr24_banners \
    --size 28 --out frontend/logos.js
rm -rf /tmp/logosrc                    # 70 MB of source artwork, no longer needed
```

About a minute, even on a Pi 3, for roughly 3,135 marks and 2.8 MB. No restart
needed: the frontend fingerprint changes and every display picks it up itself.

The last two directories are last on purpose. They are the lowest priority, so
they only fill gaps: `avcodes_banners` gains about 1,450 carriers and
`fr24_banners` another 35, and between them they change not one mark the first
three already produced.

The first two directories hold hand-supplied and hand-fetched artwork. Neither
ships in a clone, and the generator says so and carries on when they are
missing. Listing them costs nothing and means the same command works before and
after you add your own.

Expect two kinds of note. Some carriers have no usable artwork and fall back to
tail fins; `--verbose` names them. And a couple named in the generator's own
tables need a local file, so a board that differs from its source says so rather
than drifting quietly.

**Open `/logos.html` to see what you got.** Every mark, exactly as the panel
draws it, filterable by code and by background treatment. Far easier than
waiting for a carrier to fly over.

To fix a carrier that came out badly, add one the archive doesn't have, or give
a police or air-ambulance operator its own badge, see
[Customising the logos](#customising-the-logos).

> ⚠️ **Airline logos are trademarks of their airlines.** `frontend/logos.js` is
> generated locally and is **gitignored on purpose** — please don't commit
> artwork into a public fork. Generating it for your own display is one thing;
> redistributing it is another.

---

## Better routes (optional)

Out of the box, routes come from [adsbdb](https://www.adsbdb.com/) and
[hexdb.io](https://hexdb.io/). Both are free and keyless, and both are static
callsign-to-route mappings with no notion of today. Airlines reuse flight
numbers, so a fair number of them are simply for a different flight: measured
against live traffic here, between one in seven and one in three were wrong.

Virtual Radar Server publishes a community-curated version of the same thing,
corrected continuously by the people running receivers. Checked against
FlightAware on four flights the free API got all four wrong and this got three
right. It also knows aircraft the APIs have never heard of.

```bash
python3 tools/fetch_standing_data.py
```

That builds `data/standing-data.sqlite`, about 30 MB in a couple of seconds,
holding 620,000 routes, 34,000 airports, 5,900 airlines, 17,000 airframes and
the ICAO address blocks that say which country an aircraft is registered in.
Every lookup is then local: **no network call, no rate limit, no key**, and the
board keeps naming flights when the internet is down and your receivers are
not. It is SQLite rather than a table in memory so that a Pi 3 can hold it.

The data is CC0. Re-run the tool whenever you like; the upstream mirror
refreshes hourly, though routes change slowly enough that weekly is plenty.

**If the board shows a route you know is wrong**, fix it for everybody at
[the SDM site](https://sdm.virtualradarserver.co.uk/Edit). That is what makes
this database better than the alternatives, and it only stays that way because
people correct it.

Sources are tried local first, then adsbdb, then hexdb, and whatever comes back
still has to pass the plausibility check described in *How it works* - none of
them know what day it is.

---

## A map under the radar (optional)

The radar on `/dashboard` can draw the coastline, lakes, borders and nearby
airports under the traffic. It is kept very muted so the aircraft stay the
brightest thing on it, and it makes it easy to see whether a plane is over the
water or over town.

```bash
python3 tools/make_basemap.py
```

That writes `frontend/basemap.js` for the home in `flightboard.env`. It takes a
few seconds and downloads about 13 MB, none of which is kept. Reload the
dashboard to see it. Without the file, the radar looks exactly as it always did.

Airports come from the local database, so build that first (see
[Better routes](#better-routes-optional)) or the map has none. Only airports
with an IATA code are drawn. Within 60 nm of the author's receiver that is 16 of
435 airfields, and most of the rest are heliports.

**Run it again if you move.** The map is cut to your location, and the dashboard
won't draw a map made for somewhere else; the range note in the header says so
instead. It also tells you if you zoom out past the edge of the map, which can
happen after widening `range_nm` a long way.

The geography is [Natural Earth](https://www.naturalearthdata.com/) at 1:10m. It
is public domain, covers the whole world, and has enough detail for the normal
view. Zoomed in to a few nm it gets blocky, because around New York it has a
point only about every 0.9 nm. A finer US Census outline was tried and rejected
because it draws the Hudson River as land.

**Changing its colours.** They are the four lines starting `const MAP_` in
`frontend/dashboard.js`. Edit the colour codes, save, and reload the dashboard;
nothing needs regenerating or restarting.

| Line | What it colours | Default |
|---|---|---|
| `MAP_LAND` | the land | `#0a1317` |
| `MAP_SHORE` | coastlines and lake shores | `#1d3440` |
| `MAP_BORDER` | state and country borders | `#1a2a33` |
| `MAP_AIRPORT` | airport rings and codes | `#b08d4a` |

Keep them dimmer than the aircraft, which are drawn on top and should stay the
brightest thing on the radar. Because `dashboard.js` comes with FlightBoard, read
[Keeping it up to date](#keeping-it-up-to-date) before your next `git pull`.

### A sharper map, live from OpenStreetMap

Natural Earth is coarse close in. Below about 10 nm the coast turns to angles,
because it only has a point every 0.9 nm or so. The dashboard can draw the same
ground from OpenStreetMap instead, in the
[Dark Matter](https://openmaptiles.org/styles/dark-matter/) style, which stays
sharp all the way in. **It is the default.** To keep the built-in map and make
no request to any map service, add `?map=static` to the dashboard address:

```
http://YOUR-HOST:8090/dashboard.html?map=static
```

That is per display, like `?debug=1`. With `?map=static` nothing here is fetched:
no map library, no tiles.

- **It needs the internet and WebGL** on whatever browser is showing the
  dashboard. The tiles come from [OpenFreeMap](https://openfreemap.org/), which
  asks for no key and sets no limits. If anything fails to load, the built-in
  map is drawn instead, exactly as before.
- **Dark water, lighter land.** The style ships with the water a step lighter
  than the land, which reads as the ground being a hole. The three lines
  starting `const LIVE_` in `frontend/dashboard.js` (`LIVE_WATER`, `LIVE_LAND`,
  `LIVE_PARK`) set the colours; edit, save and reload. Keep the land dimmer than
  the aircraft.
- **Roads, railways and boundaries are switched off** and the place names
  dimmed, so the map stays a backdrop: land, water, the names, and runway
  shapes close in.
- **Your airports are still drawn on top** from `basemap.js`, so build that as
  well or you get the map without them.
- **The credit in the corner is required** by the licence on the data. Leave it
  where it is.
- The map library is fetched from a CDN, pinned to one version and checked
  against a hash.

---

## Getting it onto a TV

### Option A — Chromecast

The stick loads the page and renders it itself, so no computer has to stay awake
driving the picture.

Two steps, in order. The first proves it works and tells you your Chromecast's
exact name; the second keeps it working.

**1. Cast it once, by hand.**

```bash
.venv/bin/pip install catt
.venv/bin/catt scan
```

`catt scan` prints the friendly name and address of every Chromecast it can
find. Use that name exactly — you need it again in step 2 — and cast to it:

```bash
.venv/bin/catt -d "YOUR-CHROMECAST" cast_site "http://YOUR-SERVER-IP:8090/"
```

> **Use the IP address, not a hostname.** A Chromecast pins itself to Google's
> DNS servers and ignores the resolver your DHCP hands out, so a name from your
> own router resolves fine everywhere else and fails on the stick. If the
> server's address can move, give it a DHCP reservation.

> `catt` prints *Casting…* as soon as the receiver accepts the URL, before it
> has tried to load anything. That message is not proof the page came up. Look
> at the TV.

**2. Have it re-establish itself** after a reboot, a power blip, or someone
casting something else and stopping.

```bash
python3 tools/make-units.py cast --device "YOUR-CHROMECAST" --url "http://YOUR-SERVER-IP:8090/" \
    | sudo tee /etc/systemd/system/flightboard-cast.service
sudo cp flightboard-cast.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now flightboard-cast.timer
```

The watchdog runs every five minutes and only re-casts an **idle** Chromecast —
if you're watching something else on that TV, it leaves you alone. Check it
found the right device:

```bash
journalctl -u flightboard-cast.service -n 5
```

`Kitchen TV: showing FlightBoard` is what success looks like. If the name
matches nothing it says so and lists what it did find, and the unit fails
rather than passing quietly.

<details><summary>Filling the cast unit in by hand instead</summary>

```bash
sudo cp flightboard-cast.service flightboard-cast.timer /etc/systemd/system/
sudoedit /etc/systemd/system/flightboard-cast.service
```

**Quote the device name.** `Environment=` takes a *space-separated list* of
assignments, so an unquoted two-word name sets the device to its first word and
throws the rest away:

```
Environment="FLIGHTBOARD_CAST_DEVICE=Kitchen TV"     ← right
Environment=FLIGHTBOARD_CAST_DEVICE=Kitchen TV       ← sets it to "Kitchen"
```
</details>

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

## Keeping it up to date

Most of the time this is the whole thing, and the restart is harmless when it
wasn't needed:

```bash
cd ~/flightboard && git pull && sudo systemctl restart flightboard-backend
```

What actually needs what:

| Changed | What's needed |
|---|---|
| anything in `frontend/` | nothing at all — see *Displays update themselves* below |
| anything in `backend/` | `sudo systemctl restart flightboard-backend` |
| `flightboard.env` | a restart; settings are read once, at startup |
| `flightboard-backend.service` | re-install it, `sudo systemctl daemon-reload`, then a restart. `tools/make-units.py backend` prints the filled-in file |
| `flightboard-cast.service` | same, then `sudo systemctl restart flightboard-cast.timer` |
| `tools/make_logos.py`, `tools/fetch_logo_art.py` | regenerate the logos — see below |
| `tools/fetch_standing_data.py` | rebuild the local database: `python3 tools/fetch_standing_data.py` |
| `tools/make_basemap.py`, or where home is | re-run `python3 tools/make_basemap.py`, then reload the dashboard |

**If you've edited a file that came with FlightBoard**, such as the map colours
in `frontend/dashboard.js` or `CFG` in `frontend/panel.js`, a `git pull` that
changes the same file stops with *Your local changes to the following files
would be overwritten by merge*. Add `--autostash`: git sets your edits aside,
updates, and puts them back.

```bash
cd ~/flightboard && git pull --autostash && sudo systemctl restart flightboard-backend
```

If the update changed the very lines you edited, git still finishes but says
*Applying autostash resulted in conflicts*. The file then holds both versions
between `<<<<<<<` and `>>>>>>>` lines, the page it belongs to stops working, and
the next `git pull` refuses. Take the new version of the file git named, and make
your change again:

```bash
cd ~/flightboard
git stash show -p                            # shows what you had changed
git checkout HEAD -- frontend/dashboard.js   # the new file, conflict cleared
git stash drop                               # once your change is back in
```

**`frontend/logos.js` does not arrive with a `git pull`.** It is generated from
artwork you fetch locally and is gitignored, so when the generator changes your
existing copy stays exactly as it was and the new marks never appear. That is
the one update that isn't automatic.

Pull first. The generator's own tables ship in `tools/make_logos.py`, so running
a newer command against an older generator quietly produces the older result:

```bash
cd ~/flightboard && git pull
python3 tools/fetch_logo_art.py
mkdir -p /tmp/logosrc && cd /tmp/logosrc
curl -sL https://codeload.github.com/Jxck-S/airline-logos/tar.gz/refs/heads/main | tar -xz
cd ~/flightboard
python3 tools/make_logos.py logo-sources/custom logo-sources/fetched \
    /tmp/logosrc/airline-logos-main/flightaware_logos \
    /tmp/logosrc/airline-logos-main/radarbox_logos \
    /tmp/logosrc/airline-logos-main/radarbox_banners \
    /tmp/logosrc/airline-logos-main/avcodes_banners \
    /tmp/logosrc/airline-logos-main/fr24_banners \
    --size 28 --out frontend/logos.js
rm -rf /tmp/logosrc                    # 70 MB of source artwork, no longer needed
```

Check the free space first if this is a long-running feeder Pi. No restart
afterwards: `logos.js` is a frontend file like any other.

**Displays update themselves.** A cast page loads its URL once and would
otherwise render the same build for months, so `/api/aircraft` carries a
fingerprint of the whole `frontend/` directory and the panel reloads when it
changes. New files count as well as changed ones, so a Chromecast picks up a
release that adds a script without being re-cast. The fingerprint is computed
per request, which is why a frontend change needs no restart.

**The standing-data database is not in the repository either**, for the same
reason as the logos: it is generated and large. A clone has the tool but no
database, and falls back to the online lookups until you run it:

```bash
python3 tools/fetch_standing_data.py
```

To watch the backend the way you would a foreground `uvicorn`:

```bash
journalctl -u flightboard-backend -f
```

---

## Hiding traffic you don't want

Busy airspace puts a lot on the board that you may not care about. Copy the
example and edit your own copy, which is gitignored:

```bash
cp filters.example.json filters.json
```

```json
{
  "exclude": {
    "hex": ["a1b2c3"],
    "airlines": ["SWA", "FDX"],
    "registrations": ["N123AB"],
    "types": ["CRJ"],
    "airports": ["LGA"]
  },
  "range_nm": 40,
  "altitude_ft": { "min": 3000, "max": null }
}
```

Every section is optional and an empty list hides nothing. **Range lives here
too**, rather than in `flightboard.env`, because it answers the same question as
the altitude band and it is the setting you actually adjust while watching, so
it belongs in the file that re-reads itself.

| Section | Matches |
|---|---|
| `hex` | ICAO 24-bit address, exactly |
| `airlines` | the ICAO prefix of the callsign, so `SWA` catches `SWA3010` |
| `registrations` | tail number, exactly |
| `types` | **substring**, so `CRJ` catches `CRJ 900`, `CRJ-900` and `CRJ 900 LR NG` alike |
| `airports` | IATA code at *either* end of the route |
| `altitude_ft` | `min` and `max` in feet; `null` for no limit |
| `range_nm` | how far out to look, in nautical miles (default `40`) |

Check an edit before wondering why nothing happened. JSON is unforgiving and
every value has to be a quoted string, so `["LGA"]` and never `[LGA]`:

```bash
python3 -m backend.filters
```

It prints what is being hidden, or the exact line of the problem and a non-zero
exit code.

**It is re-read whenever the file changes**, so edit it and the board catches up
within a poll. Nothing to restart. Save a syntax error and the last rules that
parsed stay in force, with a note in the log, rather than every filter vanishing
because of a stray comma.

Two things worth knowing. Aircraft on the ground report as 0 feet, so a `min` of
`1` drops them, and an aircraft reporting no altitude at all is kept rather than
hidden, since missing data shouldn't act like a filter you didn't ask for. And
`hex`, `airlines` and `altitude_ft` match what the aircraft broadcasts, so they
cost nothing, while `registrations`, `types` and `airports` need a lookup first
and may let an aircraft show for a moment before it disappears.

The startup log says what is being hidden, which is the first place to look when
something you expected doesn't appear.

---

## Customising the logos

Read this on the day a carrier looks wrong, not while you are installing.

### Where artwork comes from

`make_logos.py` takes source directories in order and matches files by **ICAO
code** — `DAL.png`, `AAL.png` — because that is the prefix read off a callsign.
Earlier directories win; later ones are fallbacks, used when earlier artwork
cannot survive being reduced to a 28 px square.

| directory | holds |
|---|---|
| `logo-sources/custom` | anything you supply by hand |
| `logo-sources/fetched` | written by `tools/fetch_logo_art.py` |
| the three archive directories | ~1,650 marks from Jxck-S/airline-logos |

`tools/fetch_logo_art.py` is a short hand-checked list, not a crawler. It
currently pulls three carriers the bulk archive serves badly: NetJets' app icon,
Flexjet's original vector, and PlaneSense's site icon. Each is then cropped to
the part that reads at this size.

### Carrying your own artwork between machines

Hand-supplied artwork stays on the machine it was made on, because
`logo-sources/` is gitignored. Keeping it in a private repository of your own
means a second board is one clone away instead of a pile of `scp`.

**1. Create a private repository.** Anywhere you like; GitHub's own
[Create a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)
walks through it. Name it whatever you want. Tick **Private**, and do not add a
README — an empty repository is what the next step wants.

**2. Upload the artwork to the top level of it.** Drag the files onto the
repository page in a browser and commit. Files must sit in the **root**, not in
a folder: the generator lists one directory and does not look inside
subdirectories.

**3. On each board, clone it into place before generating.**

```bash
cd ~/flightboard
git clone https://github.com/YOUR-GITHUB-USER/YOUR-LOGO-REPO.git logo-sources/custom
```

Then run the generator as normal. It looks there first, so the board comes out
identical to the one the artwork was made on.

**A private repository will not clone with your GitHub password.** Git password
authentication was switched off in 2021, so an https clone prompts for a
username and password and then refuses whatever you type:

```
remote: Invalid username or token. Password authentication is not supported
```

Use a **deploy key** instead. It is a read-only SSH key belonging to that one
repository — nothing else on your account — which is exactly what a board wants,
and it needs no interactive login at all. On the board:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/flightboard-logos -N ""
cat ~/.ssh/flightboard-logos.pub
```

Paste that into the repository's **Settings → Deploy keys → Add deploy key**,
leave "Allow write access" unticked, then tell ssh to use it:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-logos
  HostName github.com
  User git
  IdentityFile ~/.ssh/flightboard-logos
EOF

git clone git@github-logos:YOUR-GITHUB-USER/YOUR-LOGO-REPO.git logo-sources/custom
```

A personal access token works too, used in place of the password, but it grants
far more than one repository and has to be renewed. The deploy key is one per
board, revocable on its own, and read-only.

**4. To update the artwork later, pull — do not clone again.** Add or change
files in the repository, by dragging them onto the repository page in a browser
and committing. Then on each board:

```bash
cd ~/flightboard/logo-sources/custom && git pull
```

Re-running the clone from step 3 does not work a second time, because the
directory is no longer empty:

```
fatal: destination path 'logo-sources/custom' already exists and is not an empty directory
```

Nothing was harmed if you tried it — git refuses before touching anything.

That pull affects only the nested repository. `logo-sources/` is gitignored by
FlightBoard itself, so `git -C ~/flightboard status` stays clean and pulling
artwork can never collide with a FlightBoard update. The two repositories simply
do not see each other.

New artwork does not reach the panel until `logos.js` is rebuilt from it, with
the generator command in *Regenerating the logos* above. Until then the board
keeps showing whatever the last build produced — including, confusingly, the old
version of a file you have just replaced.

**A public repository pulls with no credentials; a private one does not.** If you
started public and later switch the repository to private, every board that
cloned over https stops pulling until it has the deploy key described above. Set
the key up first, then flip the repository — in that order, or the breakage
arrives days later looking like something else.

<details><summary>Doing it from the command line instead</summary>

The directory is inside your checkout but gitignored, so a repository of its own
nested there is expected rather than a mistake.

```bash
cd ~/flightboard/logo-sources/custom
git init && git add . && git commit -m "artwork for my board"
gh repo create YOUR-LOGO-REPO --private --source=. --push
```

`--source` wants a repository that already exists, so the `git init` comes
first. Without the GitHub CLI, create the empty repository in a browser and
finish with `git remote add origin …` and `git push -u origin main`.
</details>

**Keep the repository private.** Moving trademarked artwork somewhere else does
not change what it is, and police, ambulance and government insignia carry
restrictions of their own on top of ordinary trademark. Private costs nothing,
works the same, and is the difference between storing something and publishing
it.

### What a clean clone cannot reproduce

Where a better source exists inside the archive it is named in `PREFER_SOURCE`
rather than copied, and that does travel. What is left needs a local file:

| carrier | what it needs |
|---|---|
| NYPD | their header logo from nyc.gov, which answers a plain client with 403 |
| GPD | Tradewind's mark redrawn by hand at 28×28, since no reduction of it works. Named in `REQUIRE_SOURCE`, so without the file it draws a tail fin rather than the archive's version, which lights every LED in the tile |

Run the generator and it reports any table entry it could not satisfy.

### The override tables

All one-line entries at the top of `tools/make_logos.py`:

| | |
|---|---|
| `BACKGROUND` | force a carrier onto black or onto a light tile |
| `CROPS` | use a square region of a wider logo |
| `PREFER_SOURCE` | prefer one archive directory's version over another's |
| `REQUIRE_SOURCE` | accept a carrier's artwork **only** from one directory, and draw a fin otherwise |
| `PREFER_TAIL_FIN` | reject the artwork outright and draw a fin instead |
| `KNOCK_COLOURED_BG` | strip a solid colour background |
| `LIGHT_INK_VALUE` / `LIGHT_INK_SAT` | where the automatic light/dark decision sits |

Almost every carrier ends up knocked out on black, which is what an LED sign
looks like. A light tile — every LED lit, the mark composited on top — is the
exception, reserved for ink that is both dim and washed out, like a plain black
wordmark.

Colour is not the same as brightness here, and that distinction is the whole
rule. A saturated navy or a deep red *looks* dark but reads beautifully once its
brightness is lifted, so the decision is made on the ink's HSV **value**, not its
luminance. Deciding on luminance sent 53% of carriers to glaring grey tiles;
deciding on value sends 6%.

### Hand-drawing a mark

A 28×28 source is passed through untouched, so a mark drawn at exactly that size
bypasses the fitting entirely. Pair it with a `REQUIRE_SOURCE` entry, or the
generator will quietly take the archive's version when yours is absent and
report nothing wrong — it did, after all, find artwork. Worth knowing, because for some logos nothing
else works: Tradewind's survived being redrawn by hand and survived no reduction
at all. This is the same reason the panel uses a real bitmap font rather than a
rasterised webfont.

### Regional airlines and operators that aren't airlines

`frontend/logo-aliases.js` maps a callsign prefix to another carrier's logo,
which is how regionals wear their mainline partner's tail.

Police, air ambulance, tour and survey aircraft fly under a bare registration,
so there is no callsign prefix to key a logo off. Two things cover them:

- **Where the operator has a real ICAO code**, the lookups report it and the
  normal path takes over by itself. That is how a NetJets bizjet flying as
  `N741QS` gets the NetJets mark. The code is only trusted when it names a mark
  actually held, because the lookups frequently put the *aircraft type* in that
  field: a Bell 407 arrives as `B407` and an AS350 as `AS50`.
- **Where it has no code at all**, map part of the registered owner's name:

```js
const OPERATOR_LOGOS = {
  'NEW YORK CITY POLICE': 'NYPD',
};
```

Then drop `NYPD.png` into `logo-sources/custom` and regenerate. The name is
matched as an uppercase substring of the owner and the longest match wins, so a
partial name is enough. Keep entries specific: `POLICE` alone would put one
badge on every force in the country.

### Wordmarks

Some carriers' marks are just their name, and a seven-letter wordmark reduced to
28 px gets four pixels a letter and runs together. No source resolution fixes
that. `frontend/wordmarks.js` draws those as type instead, which stays sharp and
is what an LED sign would really do. jetBlue ships as the worked example.

Reach for it only when a carrier genuinely has no compact symbol anywhere, since
the panel already prints the airline's name beside the tile and a wordmark says
it twice. An entry is only the text; the colour comes from `AIRLINE_COLORS`.

It carries its own **narrow proportional face**, 2 to 4 columns a glyph, because
`glcdfont` is fixed at 6: "jetBlue" would want 42 columns and has 28.
Proportionally it fits with a column spare. The face holds only the letters the
entries use, and a wordmark naming a letter that hasn't been drawn falls back to
artwork rather than rendering a gap — so adding a carrier means adding its
missing glyphs. They are written as pictures, so that is done by eye.

---

## Configuration reference

All settings are read at startup from, in order: the environment, then
`flightboard.env` beside the checkout, then the defaults below. Put yours in the
file and use the environment to override one for a single run. Which aircraft
you *hide* is separate, and lives in `filters.json` — see
[Hiding traffic you don't want](#hiding-traffic-you-dont-want).

| Variable | Default | What it does |
|---|---|---|
| `FLIGHTBOARD_RECEIVERS` | *(see below)* | Comma-separated receiver JSON URLs. All are polled and merged. |
| `FLIGHTBOARD_HOME_LAT` | `0.0` | Your latitude. **Set this.** |
| `FLIGHTBOARD_HOME_LON` | `0.0` | Your longitude. **Set this.** |
| *(range moved)* | | How far out to look is `range_nm` in `filters.json`, not a variable here. |
| `FLIGHTBOARD_LOCAL_AIRPORT_NM` | `30` | An airport this close counts as "local", which turns a route into *Arriving from…* / *Departing to…* |
| `FLIGHTBOARD_MAX_AIRCRAFT` | `60` | Cap on how many aircraft the API returns. |
| `FLIGHTBOARD_POLL_INTERVAL` | `2` | Seconds between receiver polls. |
| `FLIGHTBOARD_ENABLE_ENRICH` | `1` | Set `0` to disable adsbdb and hexdb lookups and run fully offline. |
| `FLIGHTBOARD_ENRICH_TTL` | `3600` | Seconds to cache an airline/route/type lookup. |
| `FLIGHTBOARD_ENRICH_FAIL_TTL` | `300` | Seconds to cache a lookup that found *nothing*. Shorter on purpose: a hit is a fact about an aircraft, a miss is often just a service having a bad minute. |
| `FLIGHTBOARD_DEBUG` | `0` | `1` shows the diagnostic bands on every display. Any single display can override it with `?debug=1` or `?debug=0` — see [Debug mode](#debug-mode). |
| `FLIGHTBOARD_PORT` | `8090` | Port. |

Display behaviour lives in `CFG` at the top of `frontend/panel.js`: `PAGE_MS`
(how long each bottom page holds), `MAX_FLIGHTS` (how many aircraft to cycle
through), `SKIP_GROUND` (whether to include aircraft on the ground).

---

### Helicopters

An aircraft with no logo is drawn as a swept tail fin, which says "airliner" as
loudly as it says "no logo". Over a city that is wrong a good part of the time,
because police, air ambulance, news and tour traffic is most of what flies low
and slow and almost none of it has a mark. Those get a helicopter instead, in
the same operator-hashed colours.

Two independent tests, because neither alone is enough:

- The **ADS-B emitter category**, where `A7` is the aircraft's own claim to be a
  rotorcraft. Authoritative when present, and frequently absent.
- The **ICAO species** from doc 8643, keyed on the type designator and carried
  in the local database as `model_types.species`. `H` is a helicopter and `G` a
  gyrocopter. Exact whenever any source gives us a type code at all, and all
  three do.

Nothing is inferred from a model *name*, because nothing can be: "407" is a Bell
helicopter and "737" is a Boeing, and no rule tells them apart. Of the 16,873
airframes in the local database, 693 are helicopters by this test.

A rotorcraft that *does* have a mark still gets its mark. The helicopter is a
fallback, exactly like the fin.

---

### The direction arrow

At the right-hand end of line 2, one glyph says which way an aircraft is going
in both dimensions at once.

|  | closing on you | neither | moving away |
|---|---|---|---|
| **climbing** | ↖ | ↑ | ↗ |
| **level** | ← | ▯ | → |
| **descending** | ↙ | ↓ | ↘ |

The middle column is for something with no horizontal direction worth naming:
under 30 knots. Straight up and down are a helicopter or a VTOL going vertically;
the tall rectangle with a red centre is one holding station, which over a city is
usually police or a news crew.

Closing or opening needs no history. The aircraft's track is compared against the
bearing from it back to you, and within a right angle of that it is coming your
way. Exact and instant, where measuring distance over time would lag a poll and
jitter on every update.

Nothing is drawn for an aircraft on the ground, or one not reporting a vertical
rate — about a third of them, and a guess would be worse than a blank.

---

### Which receiver saw it

With more than one feeder configured, a row of coloured dots sits at the left of
the band between the aircraft type and the metrics — the same band the cycle
dots occupy at the right. One dot per receiver. **Lit** means that receiver can
see the aircraft on screen right now; **dim** means it is configured but cannot.

Where two feeders' coverage overlaps, expect both lit. That is the common case
rather than a fault: the same aircraft is genuinely being received twice, and
saying so is more useful than picking a winner. A receiver that is down sees
nothing, so its dot simply stays dim.

**The dots read left to right in the order you list them in
`FLIGHTBOARD_RECEIVERS`.** Reorder that variable and the dots reorder with it.
That variable lives in `flightboard.env`, which the service reads once at
startup — unlike `filters.json`, it does not reload itself, so restart the
backend after changing it.

Ordering them by address instead was the obvious idea and does not survive
contact with a real config: a receiver named by hostname has no address here
until something resolves it, so the order would be meaningful on the boards that
use IP addresses and arbitrary on the ones that don't. One rule that behaves the
same everywhere beats a better rule that only sometimes applies.

Colours are fixed by position — red, green, blue, amber, magenta, teal, and a
hash of the receiver's name past that. They are stable across reloads and across
boards, which is what makes them learnable at a glance, but **the colour belongs
to the slot rather than to the receiver**: reorder `FLIGHTBOARD_RECEIVERS` and a
feeder changes colour along with its place in the row. Appending a receiver to
the end leaves the existing ones as they were; inserting one in the middle shifts
the colour of every receiver after it.

Nothing on the panel labels which dot is which: with two or three feeders you
learn them in a day. Past that you would want a legend, and there is nowhere on
a 128×64 panel to put one — if you run that many receivers, open an issue and
say what would actually help.

Mini model only. The 160×32 `oss` layout has no bottom band to put them in.

---

## How it works

```
your receiver(s) ──aircraft.json──> FlightBoard backend ──/api/aircraft──> panel / dashboard
                                           │
                                           ├── standing-data.sqlite  (local: routes, no network)
                                           ├── adsbdb.com  (optional: airline, route, type)
                                           └── hexdb.io    (optional: owner, and the gaps)
```

The **backend** polls every receiver every couple of seconds, merges the aircraft
(freshest position wins on duplicates), works out distance and bearing from your
location, and serves both the API and the frontend from one origin.

Airline, route and aircraft type come from [adsbdb](https://www.adsbdb.com/),
with [hexdb.io](https://hexdb.io/) behind it. Both are free and keyless. Those
lookups run in a **background worker**, never inside the poll loop, so a burst
of unknown aircraft can't stall the position feed. Results are cached, including
negative ones, and served stale while they refresh.

Routes and airframes are looked up locally first, in the Virtual Radar Server
standing data if you have built it, and only then online. The two are treated
differently: a route the local database knows is taken as final, while an
airframe is merged with whatever the online sources add, because none of the
three is a superset of the others. The local copy is the only one that knew a
JetBlue A220 and an American A321XLR delivered this year; adsbdb was the only
one that knew a 1998 Delta 767 that has been flying the whole time. A multi-stop route is resolved to
the leg the aircraft is actually flying by picking the pair of airports it sits
most nearly between, which is how a Seoul-Anchorage-JFK-Brussels cargo run shows
the right half of itself.

The two online sources are combined differently on purpose. A **route** stops at the
first answer, because adsbdb returns full airport records and that is what gives
the board place names, a progress bar and an ETA, while hexdb returns bare
codes. An **aircraft record** is *merged* across both, because adsbdb has the
better type and manufacturer but only hexdb carries the registered owner.

That owner matters more than it sounds. Roughly a quarter of the traffic over a
city is general aviation broadcasting a tail number with no airline at all, and
until it arrives the board has nothing to say about any of them. With it, a
helicopter over the Bronx reads *Operated by / Helicopters Inc* rather than
nothing. The page is skipped for airliners, where it would only repeat the name
already on the line above.

The **panel** is a genuine emulation. `frontend/glcdfont.js` is the Adafruit GFX
classic 5×7 bitmap font — the same table the hardware draws with — blitted one
bit per LED into a framebuffer, which is then drawn as physical dots with the
unlit LEDs still visible between them. At 6 px per character a 128 px panel fits
21 characters, and that constraint is why the readouts are written the way they
are.

---

## Debug mode

The panel is 128×64 dots. That is a lovely thing to look at and a hopeless place
to answer *why does it say that?*, so debug mode puts the answer in plain text
above and below it, outside the LEDs.

Add `?debug=1` to the URL, or press **d**. Press **c** to copy the whole thing
to the clipboard, which is the fastest way to hand someone a fault.

```
build a1b2c3  poll 1s ago   home 40.8834,-73.9103   range 40nm   rotating 10 of 25 in range
receivers   pi60 FAILED Client error '404 Not Found' for url '…'   |   pi22 ok 21
enrich on   cache 143 (118 hit / 25 miss)   queued 0   ttl 3600s hit / 300s miss
local db    routes 620255 · aircraft 16873 · airports 34115 · airlines 5904 · countries 811
settings    /home/pi/FlightBoard/flightboard.env
```

The top band is the whole system: which receivers answered, how stale the data
is, what the caches hold, whether the local database was ever built. The bottom
band is the aircraft currently on screen, field by field, each tagged with the
source that supplied it:

```
AA8548   ident "N777ZA"   via pi22   11.7nm brg 206deg   alt 1300ft   gs 113kt   page 1/2
airframe    hit          41s old   asked vrs, adsbdb, hexdb
            registration N777ZA (vrs)   type 407 GX (vrs)   manufacturer Bell (adsbdb)
            owner Zip Aviation (adsbdb)   operator_code B407 (hexdb)
route       cold
logo        no key   drew tail fin (no mark held)   (operator code B407 names no mark we
            hold - hexdb often puts the aircraft type there, and "Zip Aviation" is not in
            OPERATOR_LOGOS)
```

That last line is the one worth having. *Why did this aircraft get a plain tail
fin?* is otherwise a bisect through three lookup services, two alias tables and
a generated logo file, and here it is a sentence.

Two things are deliberate. The URL parameter beats the configured default, so a
laptop can run in debug while the cast TV stays clean. And nothing in the bands
is recomputed for display: the logo line is reported by the code that drew the
logo, because a second implementation of that decision would drift from the
first one and then quietly lie to you.

---

## Troubleshooting

**Start here.** Open the board with `?debug=1` on the end of the URL, or press
**d**. The top band names every receiver and whether it answered, how stale the
data is, whether the local database was built, and which settings file was
read — which is most of this section answered in one glance. Press **c** to copy
the whole thing. See [Debug mode](#debug-mode).

**The service won't start, but the board works anyway**
A manual `uvicorn` from step 4 is still running and holding port 8090. The
service cannot bind, retries every five seconds forever, and the board keeps
working because the manual process is answering. `systemctl status
flightboard-backend` shows the truth. Ctrl+C the manual run.

**The unit still says `YOUR-USER` after you edited it**
`sudoedit` installs your changes only when the editor exits cleanly, and says
nothing when it doesn't. Check with
`grep -c YOUR-USER /etc/systemd/system/flightboard-backend.service`, which must
print `0`. Generating the unit with `tools/make-units.py` avoids this entirely.

**A receiver shows FAILED in the debug band**
Read the error next to its name. *All connection attempts failed* is usually a
hostname that doesn't resolve or a receiver that's off; a *404* means the host
is up but the path is wrong for its software. Check the URL from the machine
running FlightBoard, not from your laptop:
`curl -s -o /dev/null -w '%{http_code}\n' <the URL from flightboard.env>`

**Every aircraft draws a tail fin**
`frontend/logos.js` has not been generated. Debug mode says so outright on the
logo line. See [Airline logos](#airline-logos-optional). This is a fallback, not
a fault — the board is fine without it.

**The generator says a source directory does not exist**
Expected on a clean clone. `logo-sources/custom` and `logo-sources/fetched` are
gitignored and hold artwork you supply. It skips them and carries on.

**The TV shows an error page instead of the board**
The cast URL is a hostname. A Chromecast pins itself to Google's DNS and ignores
the resolver DHCP gives it, so names from your own router don't resolve on the
stick. Use the IP address.

**`catt` says "Casting…" but the TV shows nothing**
That message means the receiver accepted the URL, not that the page loaded. Look
at the TV, or ask the stick what it thinks it is showing:
`journalctl -u flightboard-cast.service -n 5`

**The cast watchdog runs but never re-casts**
Almost always the device name. In the unit it must be **quoted**, because
`Environment=` splits on spaces and an unquoted `Kitchen TV` sets the device to
`Kitchen`. The watchdog now says so and fails the unit rather than passing
quietly, so `systemctl status flightboard-cast` will tell you.

**The board says "NO LOCATION"**
`FLIGHTBOARD_HOME_LAT` / `_LON` aren't set, so home is `0.0, 0.0` in the
Atlantic and nothing is ever nearby. The backend says the same thing on startup,
along with the receivers it will poll. Note that a receiver reports `ok` here
regardless — it is being read perfectly well, its aircraft are just all being
filtered out by distance.

**The board says "No aircraft in range"**
Your location is set, so this is genuine. Check
`curl http://YOUR-SERVER:8090/api/aircraft`, confirm the coordinates are really
yours and not transposed, and try widening `range_nm` in `filters.json`.

**A filter isn't taking effect**
The file almost certainly didn't parse, in which case the last rules that *did*
parse stay in force and yours are ignored. Run `python3 -m backend.filters` to
see the offending line. `/api/aircraft` also carries a `filters_error` field,
null when the file is good. The commonest mistake is an unquoted value: JSON
needs `["LGA"]`, not `[LGA]`.

**It says "NO FEED"**
The backend can't reach a receiver. Test the URL directly with `curl`. The API's
`sources` field reports each receiver separately, so you can see which one is
down. The board keeps showing the last good data for 90 seconds before giving up,
so brief network blips don't blank the display.

**Airlines and routes are missing, but altitude and speed are fine**
That's both lookup services being unreachable, or the aircraft genuinely being
unknown — GA
aircraft have no airline. Check outbound internet, or set
`FLIGHTBOARD_ENABLE_ENRICH=0` if you meant to run offline.

**`catt scan` finds nothing**
The Chromecast has to be powered on and on the same subnet — discovery is mDNS
and doesn't cross VLANs. Some managed switches and access points block multicast.

**The dashboard radar has no map**
Either `frontend/basemap.js` hasn't been generated — see
[A map under the radar](#a-map-under-the-radar-optional) — or it was made for a
different home, in which case the header says *map is for another home*. Either
way, run `python3 tools/make_basemap.py` and reload the page.

**Everything works but the display never changes**
Browsers throttle timers in background tabs. Make it the foreground tab, or use
kiosk mode.

---

## Uninstalling

Nothing here writes outside its own directory, `/etc/systemd/system`, and
whatever you put in `/etc/sudoers.d`. Removing it is four commands.

```bash
sudo systemctl disable --now flightboard-cast.timer flightboard-backend
sudo rm -f /etc/systemd/system/flightboard-backend.service \
           /etc/systemd/system/flightboard-cast.service \
           /etc/systemd/system/flightboard-cast.timer
sudo systemctl daemon-reload
rm -rf ~/flightboard
```

Four things inside that directory are yours rather than the project's, and are
the four you would be annoyed to lose. Copy them out first if you might come
back:

| | |
|---|---|
| `flightboard.env` | your coordinates and receivers |
| `filters.json` | what you hide |
| `frontend/logos.js` | generated, and it can take real effort to reproduce |
| `data/standing-data.sqlite` | rebuildable in seconds, so only for convenience |

```bash
mkdir -p ~/flightboard-keep
cp flightboard.env filters.json frontend/logos.js ~/flightboard-keep/
```

Nothing is left behind. No files outside those paths, no cron entries, no
packages beyond what you installed by hand — `git`, `python3-venv` and
`python3-pil` if they were not already there. The Chromecast keeps showing the
last page it was given until you stop the cast or it reboots:

```bash
.venv/bin/catt -d "YOUR-CHROMECAST" stop
```

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
- **[Virtual Radar Server](https://www.virtualradarserver.co.uk/)** for the
  community-curated [standing data](https://github.com/vradarserver/standing-data)
  of routes, airports and airlines, released CC0, and for the
  [SDM site](https://sdm.virtualradarserver.co.uk/Edit) where anyone can correct
  it. Mirrored hourly by [adsb.lol](https://github.com/adsblol/vrs-standing-data).
  It is better than every alternative here because people fix it.
- **[hexdb.io](https://hexdb.io/)** for the same, free and keyless, and for
  knowing the light aircraft and bizjets nobody else does. Adding it as a second
  source was an idea taken from
  [biohead's fork](https://github.com/biohead/TheFlightWall_OSS) of
  TheFlightWall_OSS.
- **[Jxck-S/airline-logos](https://github.com/Jxck-S/airline-logos)** for
  collecting airline logo artwork by ICAO code.
- **[Natural Earth](https://www.naturalearthdata.com/)** for the public-domain
  coastlines, lakes and borders under the dashboard radar.
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
