#!/usr/bin/env python3
"""
Fetch logo artwork for carriers the bulk archives don't serve well.

Most airlines are covered by github.com/Jxck-S/airline-logos. A few are not:
their entry there is a long wordmark that turns to mush at 28px, while a good
compact mark exists somewhere else - a phone app icon, or the original vector on
Wikipedia. This fetches those specific files. It is a short hand-checked list,
not a crawler.

    python tools/fetch_logo_art.py [--out logo-sources/fetched] [--force]

Then put that directory FIRST, so it wins wherever it has something:

    python3 tools/make_logos.py logo-sources/fetched \
        /tmp/logosrc/airline-logos-main/flightaware_logos \
        ... --size 28 --out frontend/logos.js

Most of these need cropping to the part that reads; see CROPS in make_logos.py,
whose entries name this directory.

Not everything can be fetched. nyc.gov, for one, answers a plain client with
403 and a browser with the file, so NYPD's logo is hand-saved into
logo-sources/custom instead. This tool is not going to claim to be a browser to
get round that.

A note on what doesn't work, so nobody repeats it: an airline's *favicon* looks
like the ideal source, being a mark its owner already had to make legible at 16
pixels. In practice they are rarely marks. Flexjet's is a generic aeroplane that
would identify any carrier equally. Check what you get in /logos.html before
adding an entry.

Same licensing note as make_logos.py: these are trademarks. Generating them for
your own display is one thing, committing them is another, which is why the
output path is gitignored.
"""

import argparse
import io
import os
import urllib.request

# ICAO code -> a hand-checked URL for artwork that reduces well.
SOURCES = {
    # NetJets' archive entry is its wordmark. Its phone app icon is the livery
    # swoosh instead: three bands that stay distinct at 28px.
    "EJA": "https://play-lh.googleusercontent.com/z_CwsPUEEAXJ03cLTjwuoGW7GCBGSwosXJhQBbu61wHwGHdf-qgmOiLSs_mqK4RIRDxSFYH0qatjnvN66en6sg=s512",
    # Flexjet, likewise: the original vector, cropped to the swoosh that closes
    # the wordmark. Wikimedia renders SVGs to PNG on request.
    "LXJ": "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b3/Flexjet_Logo.svg/1920px-Flexjet_Logo.svg.png",
    # PlaneSense. The archive only has them in a directory this project does not
    # use, as a banner whose wordmark is rejected as too sparse - at which point
    # the fallback chain reaches past them and lands on Cobalt, a different
    # airline. Their own 180px icon is the roundel alone and needs no crop.
    "CNS": "https://www.planesense.com/wp-content/uploads/2023/07/plane-sense-favicon.png",
    # VistaJet. Every archive copy is the wordmark, 2% ink once reduced. Its own
    # logo does contain the red Vista "V", but no rectangular crop isolates it:
    # the grey letters interleave with the V horizontally, so squaring about it
    # drags in "sta" on one side and "et" on the other. Their favicon is the V
    # alone on transparency at 48px, which is the second time a favicon has been
    # the right answer after PlaneSense - so check, despite the note below.
    "VJT": "https://www.vistajet.com/favicon.ico",
    # Galistair. The archive has them only as a 4.25:1 banner - a grey wordmark
    # beside a small red glyph - and squaring about that glyph drags in the first
    # letter of the wordmark. Their favicon is the glyph alone, a white infinity
    # on a crimson tile, which is also what their newer tails carry. That crimson
    # is a coloured field rather than a pale one, so strip_pale_field leaves it
    # be and GTR is listed in KNOCK_COLOURED_BG in make_logos.py to take it off.
    "GTR": "https://flygalistair.com/wp-content/uploads/2022/08/cropped-favicon-GTR_InfiniteAviation-192x192.jpg",
    # Hyperion Aviation (Malta). Their favicon is the black ring-and-swoosh
    # symbol, which would land on a glaring light tile; the white logo on their
    # own dark header carries the same symbol above the wordmark, so that is the
    # source, and CROPS in make_logos.py keeps only the symbol. It is white ink
    # on a transparent field, so it is listed in KEEP_PALE below.
    "HYP": "https://hyperion.aero/wp-content/uploads/2024/02/Hyperion-Logo-White.png",
    # Condor. The bulk archive's art is the same circled-condor symbol but
    # downsampled from something small, so it lights the whole tile as a grey
    # glare. This is their own newsroom download instead: black ink, 592x592,
    # squared off the right-hand end of the wordmark+symbol lockup, in
    # CROPS below. Black ink on a stripped white field lifts to white
    # automatically in make_logos.build() (the same path a pure-black
    # silhouette always takes), so this needs no KEEP_PALE entry.
    "CFG": "https://condor-newsroom.condor.com/fileadmin/dam/condor/Pictures_Pages/"
           "Download/00_Logo___Branding/Condor_Logo.png",
}

# Art whose ink is itself white or pale, on a field that is already transparent.
# strip_pale_field would take that ink for a white background and erase it.
KEEP_PALE = {"HYP"}

UA = "FlightBoard/1.0 (+https://github.com/gonzalu/FlightBoard)"
PALE = 228          # a channel at or above this counts as part of a white field


def strip_pale_field(img):
    """Clear a white field that reaches the border, keeping white *inside* a mark.

    App icons ship as art on a white tile with rounded, transparent corners.
    make_logos only strips a background from art that is fully opaque, so that
    white would otherwise survive as ink and light the whole tile. Flooding in
    from the edge removes the field without touching, say, white lettering
    enclosed by a coloured shape.
    """
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    seen = bytearray(w * h)
    stack = [(x, y) for x in range(w) for y in (0, h - 1)]
    stack += [(x, y) for y in range(h) for x in (0, w - 1)]
    while stack:
        x, y = stack.pop()
        if not (0 <= x < w and 0 <= y < h):
            continue
        i = y * w + x
        if seen[i]:
            continue
        r, g, b, a = px[x, y]
        if a >= 128 and not (r >= PALE and g >= PALE and b >= PALE):
            continue                        # real ink: stop flooding here
        seen[i] = 1
        if a:
            px[x, y] = (r, g, b, 0)
        # only queue neighbours not already dealt with: pushing blindly peaked
        # at 64 MB of stack on a 1920px source, which is a lot to ask of a Pi 3
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx]:
                stack.append((nx, ny))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="logo-sources/fetched")
    ap.add_argument("--force", action="store_true",
                    help="re-fetch even when the file is already there")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    from PIL import Image

    for code, url in sorted(SOURCES.items()):
        dest = os.path.join(args.out, code + ".png")
        if os.path.exists(dest) and not args.force:
            print(f"{code}: already have it")
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                raw = r.read()
            img = Image.open(io.BytesIO(raw)).convert("RGBA")
            if code not in KEEP_PALE:
                img = strip_pale_field(img)
            img.save(dest)
            print(f"{code}: {img.width}x{img.height} -> {dest}")
        except Exception as e:
            print(f"{code}: failed ({e})")


if __name__ == "__main__":
    main()
