#!/usr/bin/env python3
"""
Turn a directory of airline logo images into pixel art for the LED panel.

Input:  <src>/<ICAO>.png  (e.g. DAL.png, AAL.png) — any size, any aspect
Output: frontend/logos.js — a palette-indexed bitmap per airline

The panel keys logos off the ICAO prefix of the callsign (DAL2106 -> DAL), so
name the files accordingly. Anything without a logo falls back to the generated
tail fin, so a partial set is fine.

    python tools/make_logos.py <src-dir> [more-dirs...] [--size 26] [--out ...]

Give several directories in priority order and a later one is used whenever an
earlier one's art doesn't survive the reduction — Republic's FlightAware logo is
a thin script wordmark, but radarbox has it as a navy square with a starred "R".

Note on licensing: airline logos are trademarked. Generating these for your own
display is one thing; committing the output to a public repo is another. The
default output path is gitignored for that reason.
"""

import argparse
import json
import os
import sys

from PIL import Image, ImageEnhance

PALETTE_CHARS = "0123456789abcdef"   # index 0 means "LED off"
MAX_COLORS = len(PALETTE_CHARS) - 1

# Logos are drawn for one of two backgrounds and it isn't always the same one.
# Ink an unlit panel would swallow gets composited onto a light tile with every
# LED lit. Everything else is knocked out on black, which is what an LED sign
# actually looks like, so that is the case to prefer.
#
# The measure is the ink's HSV *value*, not its luminance, and that distinction
# is the whole game. By luminance a saturated navy or a deep red counts as dark,
# which exiled two thirds of all carriers to a grey tile - jetBlue, FedEx, El Al
# and UPS among them. But value is exactly what lift_ink can raise, and lifting a
# saturated colour gives back a bright brand colour that belongs on black. Only
# ink that is *both* dim and washed out - a plain black wordmark, a thin grey
# line drawing - is past rescuing and genuinely needs a light tile.
LIGHT_INK_VALUE = 115          # ink dimmer than this (HSV value) may want a light tile
LIGHT_INK_SAT = 180            # ...but only when it is this desaturated as well
LIGHT_BG = (208, 208, 208)     # not pure white; a full tile of white LEDs glares

# A mark reduced to a handful of stray dots reads as noise, and the generated
# tail fin the panel falls back to looks better. Measured on the ink, so it
# applies to both treatments.
MIN_INK_COVERAGE = 0.08

# Carriers whose automatic background choice we override, to "dark" or "light".
#
# Empty, and worth saying why. It used to name six airlines - Delta, American,
# Endeavor, Air Canada, Jazz, jetBlue - that the old luminance rule pushed onto a
# grey tile against all sense. Every one of them chooses black on its own now. A
# table that exists only to correct a bad measure is evidence the measure is
# wrong: fix the measure and the table empties itself.
BACKGROUND = {
    # Midwest Aviation is a navy tail fin: dim (value 57) and only moderately
    # saturated (98), so the rule reasonably calls for a light tile. It is worth
    # overriding rather than loosening the rule, because the shape is unusually
    # forgiving of lifting - a large solid area whose red leading edge and ring
    # of stars survive it. Catching it by threshold would mean dropping the
    # saturation limit below 98, which moves 60 other carriers with it.
    "MWT": "dark",
}

# Ink dimmer than this (HSV value, not luminance, so saturated reds aren't
# touched) is lifted when it has to sit on an unlit panel. This is the same
# thing airlines do when they publish a dark-background version of a mark:
# jetBlue's navy wordmark becomes a light blue.
LIFT_BELOW_V = 150
LIFT_TARGET_V = 225

# Carriers whose solid *coloured* background should be removed rather than kept
# as a tile. A white background is always removed without asking; a coloured one
# usually IS brand colour worth keeping, so stripping it is opt-in.
#
# Empty by default, and it's worth saying why. JetBlue was in here, fed from the
# airline's own white-on-royal-blue lockup, which knocked out to crisp white
# type. It looked fine in isolation but threw the brand colour away: the plain
# pipeline takes FlightAware's navy wordmark, forces it dark and lets lift_ink
# raise it to a proper JetBlue blue, which reads better on the panel. Prefer the
# ordinary path over a special case.
KNOCK_COLOURED_BG = set()

# Carriers whose artwork is rejected outright, so they fall back to the
# generated tail fin. Not every mark can survive 28 pixels: Tradewind's is a
# ring of ten tiny aircraft and Slate's a fine line drawing, and both reduce to
# scattered specks on a glaring pale tile. The fin is plainly better.
#
# This has to be judged by eye. The obvious proxy - how much of the tile is ink
# rather than background - does not work: Tradewind measures 20% and Spirit,
# which reads perfectly, measures 19%. What separates them is connected strokes
# against scattered detail, and that is not worth trying to measure.
# Look at /logos.html and trust your eyes.
PREFER_TAIL_FIN = {
    # Tradewind was here until its mark was redrawn by hand at 28x28 rather
    # than reduced to it; see the pass-through in build() below.
    "SGX",   # Slate Aviation - fine line art on white
}

# Carriers with no usable square mark, where a square region of a wider logo
# works instead. The fractions are (x0, y0, x1, y1) of that specific directory's
# artwork, squared about their centre, so the directory is named alongside them.
CROPS = {
    # Endeavor's own logo is a thin script wordmark; the thick right-hand tip of
    # its twin swooshes survives the reduction where the whole mark doesn't.
    "EDV": ("radarbox_banners", (0.72, 0.02, 1.00, 0.55)),
    # Two carriers whose usable art comes from tools/fetch_logo_art.py rather
    # than the bulk archive, and which are all crop.
    #
    # NetJets: its app icon is the livery swoosh on a white tile. The fetcher
    # removes the tile; this trims the empty corners so the bands fill the frame.
    "EJA": ("fetched", (0.05, 0.30, 0.95, 0.95)),
    # Flexjet: a full-height square off the right end of the original vector,
    # which puts the tip of the swoosh in the corner and lets the sweep run out
    # to the bottom left. Clear of the lettering, which ends at 0.78.
    "LXJ": ("fetched", (0.836, 0.00, 1.00, 1.00)),
    # NYPD, hand-saved into logo-sources/custom from their own site: the shield
    # is far too detailed to reduce, the lettering beside it is not. Keeping
    # only the letters gives a mark that still reads at 28px.
    "NYPD": ("custom", (0.312, 0.28, 1.00, 0.71)),
    # PlaneSense: the roundel on the left of their banner, without the wordmark
    # beside it. Hand-copied into logo-sources/custom from the archive's
    # fr24_banners, which is NOT in the default source list and should not be:
    # it disagrees with avcodes_banners about who CNS is, and the whole-banner
    # version is rejected as too sparse, so the chain silently substitutes
    # Cobalt - a different airline entirely.
    "CNS": ("custom", (0.000, 0.00, 0.160, 1.00)),
}

# Worth recording a thing that did NOT work, so nobody spends the afternoon on
# it twice. An airline's favicon or phone-app icon looks like the ideal source,
# being a mark its owner already had to make legible at 16 pixels. In practice
# they mostly aren't marks at all: Flexjet's is a generic aeroplane that would
# identify any carrier equally, and NetJets ships a crop of its livery stripes
# as both favicon and app icon. Where an airline genuinely has no compact
# symbol, setting the name as type beats hunting for one - see
# frontend/wordmarks.js.


def load_rgba(path, code=None):
    img = Image.open(path).convert("RGBA")
    if img.split()[-1].getextrema()[0] != 255:
        return img                      # already carries real transparency

    # Fully opaque, so the artwork includes its own background. A white one
    # carries no information and always goes. A coloured one usually IS brand
    # colour worth keeping (Republic's navy tile, United's blue), so removing it
    # is opt-in per carrier.
    px = img.load()
    w, h = img.size
    corners = [px[1, 1], px[w - 2, 1], px[1, h - 2], px[w - 2, h - 2]]
    bg = corners[0][:3]
    dist = lambda c: sum(abs(c[i] - bg[i]) for i in range(3))
    if any(dist(c) > 30 for c in corners):
        return img                      # no uniform background to remove

    if min(bg) < 235 and code not in KNOCK_COLOURED_BG:
        return img                      # keep the coloured tile

    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if dist((r, g, b)) <= 40:   # tolerance covers JPEG ringing
                px[x, y] = (r, g, b, 0)
    return img


def fit_square(img, size):
    """Trim to content, then letterbox into size x size preserving aspect."""
    box = img.split()[-1].getbbox()
    if box:
        img = img.crop(box)
    scale = min(size / img.width, size / img.height)
    w = max(1, round(img.width * scale))
    h = max(1, round(img.height * scale))
    img = img.resize((w, h), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, ((size - w) // 2, (size - h) // 2))
    return out


def lift_ink(img):
    """Brighten dark ink so it reads on black, preserving hue and saturation."""
    alpha = img.split()[-1]
    h, s, v = img.convert("RGB").convert("HSV").split()
    vals = [p for p, a in zip(v.getdata(), alpha.getdata()) if a >= 128]
    if not vals:
        return img
    mean_v = sum(vals) / len(vals)
    if mean_v >= LIFT_BELOW_V:
        return img
    if mean_v < 1:
        # Pure black ink, which scaling cannot lift: any multiple of zero is
        # zero, and dividing by it throws. Set the value outright instead, so a
        # black silhouette becomes a white one, which is the only way it can
        # show at all on a panel whose "off" is also black.
        v = v.point(lambda p: LIFT_TARGET_V)
    else:
        factor = LIFT_TARGET_V / mean_v
        v = v.point(lambda p: min(255, int(p * factor)))
    out = Image.merge("HSV", (h, s, v)).convert("RGB").convert("RGBA")
    out.putalpha(alpha)
    return out


def ink_stats(img):
    """Mean HSV value and saturation of the opaque pixels, and their coverage."""
    _, s, v = img.convert("RGB").convert("HSV").split()
    alpha = img.split()[-1]
    total = val = sat = 0
    for sv, vv, a in zip(s.getdata(), v.getdata(), alpha.getdata()):
        if a >= 128:
            total += 1
            val += vv
            sat += sv
    if not total:
        return 255.0, 0.0, 0.0
    return val / total, sat / total, total / (img.width * img.height)


def encode(img, size, on_light):
    """Palette-index the image; returns (palette_ints, index_string)."""
    flat = Image.new("RGB", (size, size), LIGHT_BG if on_light else (0, 0, 0))
    flat.paste(img, (0, 0), img)
    flat = ImageEnhance.Color(flat).enhance(1.3)   # LEDs want saturated color

    q = flat.quantize(colors=MAX_COLORS, method=Image.MEDIANCUT)
    # a simple logo can quantize to fewer than MAX_COLORS, so size the palette
    # off what we actually got rather than assuming a full one
    raw = (q.getpalette() or [])[: MAX_COLORS * 3]
    palette = [(raw[i * 3] << 16) | (raw[i * 3 + 1] << 8) | raw[i * 3 + 2]
               for i in range(len(raw) // 3)]

    idx = list(q.getdata())
    alpha = list(img.split()[-1].getdata())
    top = len(palette)
    chars = []
    for i, a in enumerate(alpha):
        # on a light tile the background is part of the logo, so it stays lit
        lit = (on_light or a >= 128) and idx[i] < top
        chars.append(PALETTE_CHARS[idx[i] + 1] if lit else PALETTE_CHARS[0])
    return palette, "".join(chars)


def square_crop(img, frac):
    """A square region about the centre of a fractional box."""
    w, h = img.size
    x0, y0, x1, y1 = frac[0] * w, frac[1] * h, frac[2] * w, frac[3] * h
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = max(x1 - x0, y1 - y0) / 2
    box = (round(cx - side), round(cy - side), round(cx + side), round(cy + side))
    out = Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), (0, 0, 0, 0))
    out.paste(img.crop(box), (0, 0))
    return out


def build(path, size, code):
    """Render one source image, or raise/return None if it isn't usable."""
    if code in PREFER_TAIL_FIN:
        return None, "artwork reduces to noise at this size; tail fin is better"
    src = load_rgba(path, code)

    # Art that already arrives at exactly the target size is taken as drawn:
    # no crop, no rescale, no lift. Someone handing over a 28x28 tile has placed
    # every LED deliberately, and everything below would undo that - fit_square
    # alone would crop it to its ink and scale it back up. This is the escape
    # hatch for marks that cannot be reduced and have to be drawn instead.
    if src.size == (size, size):
        palette, data = encode(src, size, False)
        if data.count("0") == len(data):
            return None, "hand-drawn tile is empty"
        return {"p": palette, "d": data, "_light": False}, None

    # Art still fully opaque at this point brought its own background - Republic's
    # navy tile, United's blue. That block is part of the mark, so neither the
    # light tile nor the lift applies: both would repaint a colour the airline chose.
    own_bg = src.split()[-1].getextrema()[0] == 255
    crop = CROPS.get(code)
    if crop and os.path.basename(os.path.dirname(path)) == crop[0]:
        src = square_crop(src, crop[1])
    img = fit_square(src, size)
    value, saturation, coverage = ink_stats(img)
    if coverage < MIN_INK_COVERAGE:
        return None, f"too sparse ({coverage:.0%} ink)"
    override = BACKGROUND.get(code)
    if override:
        on_light = override == "light"
    elif own_bg:
        on_light = False
    else:
        on_light = value < LIGHT_INK_VALUE and saturation < LIGHT_INK_SAT
    if not on_light and not own_bg:
        img = lift_ink(img)
    palette, data = encode(img, size, on_light)
    if data.count("0") == len(data):
        return None, "empty after processing"
    return {"p": palette, "d": data, "_light": on_light}, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="+",
                    help="one or more directories of <ICAO>.png, in priority order; "
                         "a later directory is tried when an earlier one's art is unusable")
    ap.add_argument("--size", type=int, default=26, help="pixel size (default 26)")
    ap.add_argument("--out", default="frontend/logos.js")
    ap.add_argument("--verbose", action="store_true",
                    help="list every rejected logo and why, rather than a count")
    args = ap.parse_args()

    # code -> candidate paths, in the order the directories were given
    candidates = {}
    for directory in args.src:
        for name in sorted(os.listdir(directory)):
            stem, ext = os.path.splitext(name)
            if ext.lower() not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
                continue
            candidates.setdefault(stem.upper(), []).append(os.path.join(directory, name))

    logos, skipped, light, rescued = {}, [], 0, 0
    for code, paths in sorted(candidates.items()):
        reason = "no source"
        for depth, path in enumerate(paths):
            try:
                logo, reason = build(path, args.size, code)
            except Exception as e:
                logo, reason = None, str(e)
            if logo:
                light += 1 if logo.pop("_light") else 0
                rescued += 1 if depth else 0
                logos[code] = logo
                break
        else:
            skipped.append(f"{code}: {reason}")

    lines = [
        "/*",
        " * Airline logos as LED pixel art, generated by tools/make_logos.py.",
        f" * {args.size}x{args.size}, palette-indexed; '0' means the LED stays off.",
        " * Trademarked artwork - generated locally, not committed.",
        " */",
        f"const LOGO_SIZE = {args.size};",
        "const LOGOS = {",
    ]
    for code in sorted(logos):
        lines.append(f'  {code}: {json.dumps(logos[code], separators=(",", ":"))},')
    lines.append("};")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    size_kb = os.path.getsize(args.out) / 1024
    print(f"wrote {args.out}: {len(logos)} logos "
          f"({light} on a light tile, {len(logos) - light} on black, "
          f"{rescued} from a fallback source), {size_kb:.0f} KB")

    # Rejections are normal and expected - obscure carriers whose artwork can't
    # survive the reduction fall back to a generated tail fin. Listing every one
    # makes a healthy run look like a failure, so summarise unless asked.
    if skipped:
        if args.verbose:
            for s in skipped:
                print("  skipped", s, file=sys.stderr)
        else:
            print(f"{len(skipped)} carriers had no usable artwork and will use a "
                  f"tail fin instead (--verbose to list them)")


if __name__ == "__main__":
    main()
