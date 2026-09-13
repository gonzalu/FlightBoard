/*
 * Marks: what badge an aircraft gets, and how to draw it.
 *
 * This exists because the two views had drifted. The LED panel grew wordmarks,
 * an operator-code lookup, a tail fin fallback and a helicopter, while the
 * dashboard kept a simplified copy of the logo lookup and got none of them. Two
 * implementations of one decision only agree on the day the second is written.
 *
 * Painting takes a `px(x, y, color)` callback rather than a canvas or a
 * framebuffer, so the panel writes into its LED grid and the dashboard into an
 * ImageData without either knowing about the other.
 */

/* ---------- which badge ---------- */

function airlineKey(callsign) {
  const m = /^([A-Z]{3})\d/.exec((callsign || '').trim());
  if (!m) return null;
  // regionals wear their mainline partner's tail — see logo-aliases.js
  return (typeof LOGO_ALIASES !== 'undefined' && LOGO_ALIASES[m[1]]) || m[1];
}

/*
 * A logo key for an aircraft whose callsign carries no airline prefix.
 *
 * Two ways in. hexdb reports an operator's ICAO code, which covers anything
 * with a real one - a NetJets bizjet flying as N741QS is still EJA, and the
 * mark already exists. Failing that, the registered owner's name is matched
 * against OPERATOR_LOGOS for the operators that have no code at all: police,
 * air ambulance, tour flights.
 */

/*
 * A logo key for an aircraft whose callsign carries no airline prefix.
 *
 * Two ways in. hexdb reports an operator's ICAO code, which covers anything
 * with a real one - a NetJets bizjet flying as N741QS is still EJA, and the
 * mark already exists. Failing that, the registered owner's name is matched
 * against OPERATOR_LOGOS for the operators that have no code at all: police,
 * air ambulance, tour flights.
 */
function operatorKey(info) {
  // That code is not always an operator. For light aircraft hexdb frequently
  // puts the *type* there instead, so a Bell 429 arrives as "B429" and a 407 as
  // "B407". Only trust it when it names a mark we actually hold, which lets the
  // rubbish fall through to the owner's name below instead of blocking it.
  if (info.operator_code) {
    const code = (typeof LOGO_ALIASES !== 'undefined' && LOGO_ALIASES[info.operator_code])
      || info.operator_code;
    const known = (typeof LOGOS !== 'undefined' && LOGOS[code])
      || (typeof WORDMARKS !== 'undefined' && WORDMARKS[code]);
    if (known) return code;
  }
  const owner = (info.owner || '').toUpperCase();
  if (!owner || typeof OPERATOR_LOGOS === 'undefined') return null;
  // longest match first, so a specific entry beats a broader one
  const names = Object.keys(OPERATOR_LOGOS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (owner.includes(name)) return OPERATOR_LOGOS[name];
  }
  return null;
}

// A listed wordmark is only usable once every letter in it has been drawn, so
// a half-finished face falls back to artwork rather than printing a gap.
function wordmarkFor(key) {
  if (typeof WORDMARKS === 'undefined' || !key) return null;
  const text = WORDMARKS[key];
  if (!text) return null;
  for (const ch of text) if (!WORDMARK_FONT[ch]) return null;
  return text;
}

/**
 * Is this a rotorcraft?
 *
 * The ICAO species from doc 8643 decides whenever we have it. It is keyed on
 * the type designator and it is a published fact.
 *
 * The ADS-B emitter category is only a fallback, because it is whatever was
 * typed into the transponder and is demonstrably wrong in the wild: of four
 * aircraft claiming A7 over this receiver, one was a Challenger 601. So a known
 * species overrules the claim in both directions.
 *
 * The gap this leaves is an aircraft with a type code nobody recognises AND a
 * mis-set category, which stays wrong. Nothing available fixes that: a model
 * *name* cannot be used, since "407" is a Bell helicopter and "737" is a
 * Boeing, and no rule tells them apart.
 */
function isRotorcraft(ac, info) {
  const sp = info && info.species;
  if (sp) return sp === 'H' || sp === 'G';   // helicopter or gyrocopter
  return ac.category === 'A7';               // the aircraft's own claim, unverified
}

/* ---------- colours ---------- */

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

function hashColors(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  const hue = h % 360;
  return [hsl(hue, 55, 28), hsl(hue, 85, 62)];
}

/* ---------- painters ---------- */

// Proportional: each glyph advances by its own column count, plus one of
// tracking. That is what fits a seven-letter name across 28 LEDs.
function paintWordmark(px, box, text, color) {
  const { x, y, size } = box;
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += WORDMARK_FONT[text[i]][0].length + (i ? 1 : 0);
  }
  let cx = x + ((size - width) >> 1);
  const top = y + ((size - WORDMARK_ROWS) >> 1);
  for (let i = 0; i < text.length; i++) {
    const glyph = WORDMARK_FONT[text[i]];
    if (i) cx += 1;
    for (let r = 0; r < glyph.length; r++) {
      const row = glyph[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] === '#') px(cx + c, top + r, color);
      }
    }
    cx += glyph[0].length;
  }
}

// A swept vertical stabilizer, drawn whenever there's no logo for the carrier.
//
// Both edges rake, and that is the whole trick. Earlier versions pinned the
// trailing edge to the right of the tile on every row, which builds a right
// triangle glued to the edge: it reads as a striped wedge, not a tail. A real
// fin leans, so the trailing edge has to lean with the leading one.
//
// The four fractions below are measured off airline marks that already look
// right at this size. Four of them agreed to within a couple of percent, which
// makes this a convention worth copying rather than one artist's taste.
const FIN = {
  LEAD_TOP: 0.71,      // leading edge at the tip, as a fraction of tile width
  LEAD_BOTTOM: 0.00,   // ...and where it meets the root
  TRAIL_TOP: 0.96,     // trailing edge at the tip
  TRAIL_BOTTOM: 0.79,  // ...and at the root
  BAND: [0.50, 0.72],  // accent stripe, as fractions of fin height
};

// Both raked edges land between LEDs, and rounding them to whole LEDs is what
// makes the staircase. An LED panel can dim an individual LED, though, so light
// the one the edge passes through in proportion to how much of it is covered.
//
// It fades towards UNLIT rather than towards black. Black is not "off" here:
// the grid canvas paints unlit LEDs at #0a0a0a, so a lit-but-black LED comes out
// *darker* than its neighbours and punches a hole in the edge instead of
// softening it.
const UNLIT = 0x0a0a0a;
const FIN_EDGE_FLOOR = 0.06;   // below this the LED isn't worth lighting at all

function fadeToUnlit(color, f) {
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const u = (UNLIT >> shift) & 255;
    const c = (color >> shift) & 255;
    out |= Math.round(u + (c - u) * f) << shift;
  }
  return out;
}

function paintFin(px, box, base, accent) {
  const { x, y, size } = box;
  const span = size - 1;
  if (span <= 0) return;
  for (let yy = 0; yy < size; yy++) {
    const t = yy / span;
    const lead = size * (FIN.LEAD_TOP + (FIN.LEAD_BOTTOM - FIN.LEAD_TOP) * t);
    const trail = size * (FIN.TRAIL_TOP + (FIN.TRAIL_BOTTOM - FIN.TRAIL_TOP) * t);
    const color = t > FIN.BAND[0] && t < FIN.BAND[1] ? accent : base;

    const first = Math.ceil(lead);
    const last = Math.floor(trail);
    for (let xx = Math.max(0, first); xx <= Math.min(last, size - 1); xx++) {
      px(x + xx, y + yy, color);
    }
    const leadCov = first - lead;
    if (leadCov > FIN_EDGE_FLOOR) {
      px(x + first - 1, y + yy, fadeToUnlit(color, leadCov));
    }
    const trailCov = trail - last;
    if (trailCov > FIN_EDGE_FLOOR && last + 1 < size) {
      px(x + last + 1, y + yy, fadeToUnlit(color, trailCov));
    }
  }
}

/*
 * A helicopter, drawn instead of a tail fin when the aircraft is a rotorcraft.
 *
 * A swept fin says "airliner" as loudly as it says "no logo", and over a city
 * that is wrong a good part of the time: police, air ambulance, news and tour
 * traffic is most of what flies low and slow, and almost none of it has a mark.
 *
 * Drawn as a side view because that is the only angle where a helicopter is
 * unmistakable at this size. The recognisable part is not the cabin, it is the
 * relationship between a long thin rotor, a small body and a boom reaching
 * away from it - earlier attempts with a bigger cabin read as a submarine.
 *
 * '#' takes the operator's base colour, '+' the accent, which puts the colour
 * on the tail fin where an airline would brand it.
 */
const HELICOPTER = [
  '............................',
  '............................',
  '............................',
  '............................',
  '............................',
  '............................',
  '.##########################.',
  '.##########################.',
  '........##..................',
  '........##..................',
  '........##...........+++....',
  '.......#####.........+++....',
  '.....#########.......+++....',
  '....###########......+++....',
  '...#################+++.....',
  '...#################+++.....',
  '...#################+++.....',
  '....###########.............',
  '.....#########..............',
  '.......#####................',
  '...#........#...............',
  '...#........#...............',
  '################............',
  '............................',
  '............................',
  '............................',
  '............................',
  '............................',
];

function paintHelicopter(px, box, base, accent) {
  for (let r = 0; r < HELICOPTER.length; r++) {
    for (let c = 0; c < HELICOPTER[r].length; c++) {
      const ch = HELICOPTER[r][c];
      if (ch === '#') px(box.x + c, box.y + r, base);
      else if (ch === '+') px(box.x + c, box.y + r, accent);
    }
  }
}

/** The generated 28x28 pixel art for a carrier, painted through `px`. */
function paintLogoArt(px, box, logo) {
  const s = LOGO_SIZE;
  const ox = box.x + ((box.size - s) >> 1);
  const oy = box.y + ((box.size - s) >> 1);
  for (let i = 0; i < logo.d.length; i++) {
    const ch = logo.d.charCodeAt(i);
    if (ch === 48) continue;                       // '0' = LED off
    const pi = (ch <= 57 ? ch - 48 : ch - 87) - 1; // 0-9 then a-f
    px(ox + (i % s), oy + ((i / s) | 0), logo.p[pi]);
  }
}

/**
 * The single decision both views make: which badge, and drawn how.
 *
 * Returns {kind, key, via}. kind is one of 'logo', 'wordmark', 'helicopter' or
 * 'fin'. `via` says how the key was reached, which is what debug mode reports.
 */
function markFor(ac, info) {
  info = info || {};
  const fromCallsign = airlineKey(ac.flight || '');
  const key = fromCallsign || operatorKey(info);
  const rawPrefix = (/^([A-Z]{3})\d/.exec((ac.flight || '').trim()) || [])[1];
  const via = fromCallsign ? 'callsign prefix'
    : !key ? null
    : (info.operator_code && key ===
        ((typeof LOGO_ALIASES !== 'undefined' && LOGO_ALIASES[info.operator_code])
         || info.operator_code)) ? 'operator code'
    : 'owner name';
  const alias = fromCallsign && rawPrefix !== key ? rawPrefix : null;

  if (wordmarkFor(key)) return { kind: 'wordmark', key, via, alias, text: WORDMARKS[key] };
  if (typeof LOGOS !== 'undefined' && key && LOGOS[key])
    return { kind: 'logo', key, via, alias, logo: LOGOS[key] };
  return { kind: isRotorcraft(ac, info) ? 'helicopter' : 'fin', key, via, alias };
}

/** Colours for a badge: an airline's own if we have them, else hashed. */
function markColors(key, identity) {
  return (typeof AIRLINE_COLORS !== 'undefined' && AIRLINE_COLORS[key])
      || (identity ? hashColors(identity) : [0x243039, 0x51707f]);
}

/**
 * Draw whatever markFor decided, and say what was drawn.
 *
 * The return value is the string debug mode reports, which is why it comes from
 * here rather than being worked out again by the caller: a second description
 * of this decision would eventually describe something else.
 */
function paintMark(px, box, mark, base, accent) {
  switch (mark.kind) {
    case 'wordmark':   paintWordmark(px, box, mark.text, accent); return 'wordmark';
    case 'logo':       paintLogoArt(px, box, mark.logo);          return 'pixel mark';
    case 'helicopter': paintHelicopter(px, box, base, accent);    return 'helicopter (no mark held)';
    default:           paintFin(px, box, base, accent);           return 'tail fin (no mark held)';
  }
}
