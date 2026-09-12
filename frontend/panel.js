/*
 * Virtual LED matrix panel — emulates TheFlightWall hardware.
 *
 * The real device is an ESP32 driving WS2812B panels through Adafruit GFX:
 * a framebuffer of individually addressed LEDs, a bitmap font, one flight on
 * screen at a time, cycling on a timer. This does the same thing on a canvas —
 * text is rasterized to one bit per LED and written into a pixel buffer, then
 * every LED is drawn as a physical dot. No styled HTML text anywhere.
 *
 * Two documented hardware configurations, selected with ?model=
 *   mini (default) — the retail FlightWall Mini: 128x64, 320x160mm, ~2.5mm pitch
 *   oss            — the DIY build in TheFlightWall_OSS: 160x32, twenty 16x16
 *                    panels in a 10x2 grid, 3 text lines and a border, no logo
 * The retail WideScreen's resolution isn't published, so it isn't guessed at here.
 */

const MODELS = {
  mini: {
    W: 128, H: 64, tile: 16, padX: 1,   // 21 chars at 6px/char is the full width
    // the logo squares off against the full height of the three text lines and
    // runs right up to them, which buys 28x28 of logo instead of 26x26
    logo: { x: 2, y: 3, size: 28 },
    lines: [3, 13, 23],
    bottom: [40, 52],
    border: false,
    routeSep: '-',
  },
  oss: {
    W: 160, H: 32, tile: 16, padX: 4,
    logo: null,
    lines: [4, 13, 22],   // three 8px lines inside the border, as the firmware centers them
    bottom: null,
    border: true,
    routeSep: '>',
  },
};

const CFG = {
  PAGE_MS: 4000,      // how long each bottom-pane page holds
  MAX_FLIGHTS: 10,    // the retail models cap at 5; busy airspace justifies more
  SKIP_GROUND: true,  // the device supports altitude filtering; parked jets are dull
  POLL_MS: 5000,
  STALE_AFTER_S: 90,  // how long to keep showing the last good data if the feed drops
};

const QS = new URLSearchParams(location.search);
const M = MODELS[QS.get('model')] || MODELS.mini;
const debugParam = QS.get('debug');   // null means "whatever the backend says"
let debugSettled = false;
const W = M.W, H = M.H;

const C_TEXT = 0xeaf4ff;
const C_VAL = 0x66d9ff;

const cvs = document.getElementById('panel');
const ctx = cvs.getContext('2d');

const fb = new Uint32Array(W * H);   // 0 = LED off
let pitch = 8;
let gridCanvas = null;               // pre-rendered unlit LED grid

/* ---------- framebuffer primitives ---------- */

function clear() { fb.fill(0); }

function setPx(x, y, color) {
  x |= 0; y |= 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  fb[y * W + x] = color | 0x1000000;  // high bit marks "lit", so black is drawable
}

function drawRect(x, y, w, h, color) {
  for (let i = 0; i < w; i++) { setPx(x + i, y, color); setPx(x + i, y + h - 1, color); }
  for (let i = 0; i < h; i++) { setPx(x, y + i, color); setPx(x + w - 1, y + i, color); }
}

/* ---------- bitmap text: the firmware's own font, one bit per LED ---------- */

// glcdfont is 5 columns per glyph, drawn in a 6x8 cell (1px gutter), same as
// Adafruit_GFX at size 1. No rasterizing, no antialiasing, no thresholding.
const CHAR_W = 6;
const CHAR_H = 8;

function drawText(x, y, text, color) {
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 32 || code > 126) code = 63;   // glcdfont's upper range isn't Latin-1
    const gx = x + i * CHAR_W;
    for (let col = 0; col < 5; col++) {
      const bits = GLCD_FONT[code * 5 + col];
      if (!bits) continue;
      for (let row = 0; row < 8; row++) {
        if (bits & (1 << row)) setPx(gx + col, y + row, color);
      }
    }
  }
  return text.length * CHAR_W;
}

function textW(text) { return text.length * CHAR_W; }

function fitText(text, maxW) {
  let t = String(text);
  while (t.length > 1 && textW(t) > maxW) t = t.slice(0, -1);
  return t;
}

function drawRuns(x, y, runs) {
  let cx = x;
  for (const [text, color] of runs) cx += drawText(cx, y, text, color);
}

function drawCentered(y, text, color) {
  drawText(Math.round((W - textW(text)) / 2), y, text, color);
}

/* ---------- airline tail fin ---------- */

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

// A listed wordmark is only usable once every letter in it has been drawn, so
// a half-finished face falls back to artwork rather than printing a gap.
function wordmarkFor(key) {
  if (typeof WORDMARKS === 'undefined' || !key) return null;
  const text = WORDMARKS[key];
  if (!text) return null;
  for (const ch of text) if (!WORDMARK_FONT[ch]) return null;
  return text;
}

// Proportional: each glyph advances by its own column count, plus one of
// tracking. That is what fits a seven-letter name across 28 LEDs.
function drawWordmark(box, text, color) {
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
        if (row[c] === '#') setPx(cx + c, top + r, color);
      }
    }
    cx += glyph[0].length;
  }
}

// A wordmark if one is listed, else the generated logo, else a tail fin.
// What drawLogo last did, for the debug overlay. Reported rather than
// re-derived: a second copy of this decision would drift and then mislead.
let lastLogo = {};

function drawLogo(box, key, base, accent) {
  const words = wordmarkFor(key);
  if (words) {
    lastLogo.how = 'wordmark';
    drawWordmark(box, words, accent);
    return;
  }
  const logo = typeof LOGOS !== 'undefined' && key ? LOGOS[key] : null;
  if (!logo) {
    lastLogo.how = 'tail fin (no mark held)';
    drawFin(box, base, accent);
    return;
  }
  lastLogo.how = 'pixel mark';
  const s = LOGO_SIZE;
  const ox = box.x + ((box.size - s) >> 1);
  const oy = box.y + ((box.size - s) >> 1);
  for (let i = 0; i < logo.d.length; i++) {
    const ch = logo.d.charCodeAt(i);
    if (ch === 48) continue;                       // '0' = LED off
    const pi = (ch <= 57 ? ch - 48 : ch - 87) - 1; // 0-9 then a-f
    setPx(ox + (i % s), oy + ((i / s) | 0), logo.p[pi]);
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

function drawFin(box, base, accent) {
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
      setPx(x + xx, y + yy, color);
    }
    const leadCov = first - lead;
    if (leadCov > FIN_EDGE_FLOOR) {
      setPx(x + first - 1, y + yy, fadeToUnlit(color, leadCov));
    }
    const trailCov = trail - last;
    if (trailCov > FIN_EDGE_FLOOR && last + 1 < size) {
      setPx(x + last + 1, y + yy, fadeToUnlit(color, trailCov));
    }
  }
}

/* ---------- value formatting, matching the device's readout style ---------- */

function fmtAlt(ft) {
  if (ft == null) return '--';
  // kept tight: at 6px/char the Mini fits 20 characters across
  return Math.abs(ft) >= 1000 ? (ft / 1000).toFixed(1) + 'kft' : Math.round(ft) + 'ft';
}
function fmtSpd(kt) { return kt == null ? 'N/A' : Math.round(kt) + 'kt'; }
function fmtTrk(deg) { return deg == null ? 'N/A' : Math.round(deg) + 'deg'; }
function fmtVr(fpm) {
  // N/A rather than a fabricated zero, and ft/s like the retail unit: at
  // 6px/char it's what fits on one 128px line
  if (fpm == null) return 'N/A';
  const fps = Math.round(fpm / 60);
  return (fps > 0 ? '+' : '') + fps + 'ft/s';
}
function fmtEta(min) {
  if (min == null || min < 0) return null;
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}min` : `${h}hr`;
}

// "Delta 1620" rather than just "Delta". The number is the half you actually
// look up, so when the two won't fit together it is the airline that gives way,
// never the number: plain truncation dropped it entirely and left "Cathay
// Pacific" identifying three flights at once.
function flightTitle(airline, callsign, maxW) {
  const short = airline ? shortenAirline(airline) : '';
  if (!short) return callsign;
  const number = /^[A-Z]{3}(\w+)$/.exec(callsign);   // DAL1620 -> 1620
  if (!number) return fitText(short, maxW);
  const tail = ' ' + number[1];
  if (textW(short + tail) <= maxW) return short + tail;
  // shed whole trailing words first, which reads better than a chopped one:
  // "Air Canada Jazz 538" becomes "Air Canada 538", not "Air Canada Ja 538"
  const words = short.split(' ');
  while (words.length > 1) {
    words.pop();
    const candidate = words.join(' ') + tail;
    if (textW(candidate) <= maxW) return candidate;
  }
  return fitText(words[0], maxW - textW(tail)) + tail;
}

// Company suffixes on an owner's name. Deliberately not shortenAirline, which
// strips a trailing "Air" or "Airways" and would render Korean Air as "Korean".
function shortenOwner(name) {
  return (name || '')
    .replace(/,?\s+(Inc|L\.?L\.?C|Ltd|Co|Corp|Corporation|Holdings|Trust(ee)?)\.?$/i, '')
    .trim();
}

function shortenAirline(name) {
  return name
    .replace(/\s+(Air Lines|Airlines|Airways|Airline|Aviation|Air)\b.*$/i, '')
    .replace(/\s+(Inc|LLC|Ltd|Co)\.?$/i, '')
    .trim();
}

/* ---------- frame composition ---------- */

const TEXT_X = M.logo ? M.logo.x + M.logo.size + 2 : M.padX;

// Prefer the airport's name, but fall back to its city rather than hacking a
// word in half: "Ronald Reagan Washington National" truncates to "Ronald Reagan
// Washing", where "Washington" says the same thing and fits.
function airportLabel(a) {
  const avail = W - M.padX * 2;
  if (a.short && textW(a.short) <= avail) return a.short;
  if (a.city && textW(a.city) <= avail) return a.city;
  // A municipality is sometimes two towns, "Cincinnati / Covington", which
  // overruns by one character. Close up the spaces around the slash before
  // giving either of them up: CVG is Cincinnati to a passenger and Covington
  // to anyone who knows where the code came from, and both then fit.
  const pair = (a.city || '').replace(/\s*\/\s*/g, '/');
  if (pair && textW(pair) <= avail) return pair;
  // Still over, so keep the first town, which is the one usually said aloud.
  const first = pair.split('/')[0];
  if (first && textW(first) <= avail) return first;
  // Nothing fits, so chop the city rather than the official name: "Cincinnati
  // / Covingt" still reads as a place, "Cincinnati Northern K" reads as nothing.
  return fitText(a.city || a.short || '', avail);
}

// The bottom pane rotates through however many pages this aircraft can fill.
// The retail unit does the same: top three lines hold, the bottom two change.
function bottomPages(ac) {
  if (ac.on_ground) {
    return [[['On ground', C_TEXT], [ac.gs > 2 ? 'Taxiing' : 'Stationary', C_VAL]]];
  }

  const pages = [[
    [['Alt:', C_TEXT], [fmtAlt(ac.alt_baro), C_VAL], [',Spd:', C_TEXT], [fmtSpd(ac.gs), C_VAL]],
    [['Trk:', C_TEXT], [fmtTrk(ac.track), C_VAL], [',Vr:', C_TEXT], [fmtVr(ac.baro_rate), C_VAL]],
  ]];

  // Who owns it, which for a light aircraft or a bizjet is often the only
  // identity there is: no airline, no route, just a registration until now.
  // Skipped when the airline is known, because then it only repeats line 1 and
  // spends a slot in the rotation saying "American" under "American 2723".
  // Shorten only when it doesn't fit, the way airportLabel does. Trimming by
  // default turns "Helicopters Inc" into a bare "Helicopters", which says less
  // than the name it replaced.
  const ownerRaw = ((ac.aircraft_info || {}).owner || '').trim();
  const owner = textW(ownerRaw) <= W - M.padX * 2 ? ownerRaw : shortenOwner(ownerRaw);
  if (owner && !(ac.route && ac.route.airline)) {
    pages.push([['Operated by', C_TEXT], [owner, C_VAL]]);
  }

  const r = ac.route;
  if (!r) return pages;
  const from = r.from || {}, to = r.to || {};

  if (r.phase === 'arriving' && from.city) {
    pages.push([['Arriving from', C_TEXT], [from.city, C_VAL]]);
  } else if (r.phase === 'departing' && to.city) {
    pages.push([['Departing to', C_TEXT], [to.city, C_VAL]]);
  }
  if (from.short && to.short) {
    pages.push([[airportLabel(from), C_TEXT], [airportLabel(to), C_TEXT]]);
  }
  const eta = fmtEta(r.eta_min);
  if (eta && to.short) {
    pages.push([['Arriving in ' + eta, C_VAL], [airportLabel(to), C_TEXT]]);
  }
  return pages;
}

// One dot per aircraft in the rotation, in the empty band between the aircraft
// type and the metrics. Bright = on screen now, mid = still to come this pass,
// dim = already shown. Answers "how many is it cycling, and where am I".
// Deliberately not top-right: line 1 runs to x~122 and would lose characters.
// All three stay countable — knowing the fleet size is the point, so even
// "already shown" has to survive a TV's black level.
const DOT_CURRENT = 0x66d9ff;
const DOT_PENDING = 0x5c8799;
const DOT_SEEN = 0x2b4654;

function drawCycleDots() {
  if (flights.length < 2) return;
  const shown = Math.min(flights.length, 14);
  const pitch = 3;
  const x0 = W - M.padX - (shown * pitch - (pitch - 1));
  for (let i = 0; i < shown; i++) {
    const a = flights[i];
    const colour = a.hex === showingHex ? DOT_CURRENT
      : seenThisPass.has(a.hex) ? DOT_SEEN
      : DOT_PENDING;
    setPx(x0 + i * pitch, 35, colour);
  }
}

// Flown portion solid green, the rest a dim dotted rail — as on the real panel.
function drawProgress(fraction) {
  const y = H - 2;
  const end = Math.round(fraction * (W - M.padX * 2));
  for (let i = 0; i < W - M.padX * 2; i++) {
    if (i < end) setPx(M.padX + i, y, 0x39ff6a);
    else if (i % 2 === 0) setPx(M.padX + i, y, 0x14304a);
  }
}

function buildFlightFrame(ac, page) {
  lastLogo = {};          // a model with no logo box must not report the last one's
  clear();
  if (M.border) drawRect(0, 0, W, H, C_TEXT);

  const airline = (ac.route && ac.route.airline) || '';
  const info = ac.aircraft_info || {};
  // Plenty of aircraft transmit a position and no ident at all - bizjets and
  // police helicopters especially, but airliners do it too. The registration is
  // the identity worth reading, and the lookups nearly always have one, so fall
  // back to the raw hex only when even that is unknown.
  const callsign = ac.flight || info.registration || ac.hex.toUpperCase();

  if (M.logo) {
    // Deliberately ac.flight, not callsign: callsign falls back to the hex when
    // an aircraft transmits no ident, and a hex looks exactly like a callsign to
    // airlineKey - "ACB1F5" reads as the airline "ACB". Those are the aircraft
    // that most need the operator lookup, so mis-keying them is the worst case.
    const fromCallsign = airlineKey(ac.flight || '');
    const key = fromCallsign || operatorKey(info);
    const rawPrefix = (/^([A-Z]{3})\d/.exec((ac.flight || '').trim()) || [])[1];
    lastLogo = {
      key,
      how: null,                                   // filled in by drawLogo
      alias: fromCallsign && rawPrefix !== key ? rawPrefix : null,
      via: fromCallsign ? 'callsign prefix'
         : !key ? null
         : (info.operator_code && key ===
             ((typeof LOGO_ALIASES !== 'undefined' && LOGO_ALIASES[info.operator_code])
              || info.operator_code)) ? 'operator code'
         : 'owner name',
    };
    // With no airline, hash the registered owner rather than falling back to
    // one grey for everybody. A quarter of the traffic over a city is general
    // aviation, and every last aircraft of it drew the same tile: an NYPD
    // helicopter looked exactly like a Cessna. Hashing the owner gives each
    // operator its own stable colour instead.
    const identity = airline || info.owner || '';
    const [base, accent] =
      (typeof AIRLINE_COLORS !== 'undefined' && AIRLINE_COLORS[key])
      || (identity ? hashColors(identity) : [0x243039, 0x51707f]);
    drawLogo(M.logo, key, base, accent);
  }

  const availW = W - TEXT_X - M.padX;
  const title = flightTitle(airline, callsign, availW);
  const route = (ac.route && ac.route.origin && ac.route.destination)
    ? `${ac.route.origin}${M.routeSep}${ac.route.destination}`
    : `${ac.distance_nm.toFixed(1)}NM`;
  // hexdb often gives a bare model number - "429", "407", "G450" - which means
  // nothing on its own, so name the maker too where there's room. adsbdb's
  // "CRJ 900 ER NG" already reads fine and is too long to prefix anyway.
  const maker = info.manufacturer && info.type
    && !info.type.toUpperCase().includes(info.manufacturer.toUpperCase())
      ? `${info.manufacturer} ${info.type}` : '';
  const model = (maker && textW(maker) <= availW) ? maker : info.type;
  // line 1 already carries the callsign, so don't repeat it here
  const detail = model || (info.registration !== callsign ? info.registration : '') || '';

  drawText(TEXT_X, M.lines[0], fitText(title, availW), C_TEXT);
  drawText(TEXT_X, M.lines[1], fitText(route, availW), C_TEXT);
  if (detail) drawText(TEXT_X, M.lines[2], fitText(detail, availW), C_TEXT);

  if (!M.bottom) return;

  const pages = bottomPages(ac);
  const rows = pages[page % pages.length];
  rows.forEach((row, i) => {
    // a row is either a plain [text, color] or a list of coloured runs
    const runs = Array.isArray(row[0]) ? row : [row];
    drawRuns(M.padX, M.bottom[i], runs.map(([t, c]) => [fitText(t, W - M.padX * 2), c]));
  });

  drawCycleDots();
  if (ac.route && ac.route.progress != null) drawProgress(ac.route.progress);
}

function buildMessageFrame(lines) {
  lastLogo = {};
  clear();
  if (M.border) drawRect(0, 0, W, H, C_TEXT);
  const pitch = CHAR_H + 2;
  const top = Math.round((H - lines.length * pitch) / 2);
  lines.forEach((line, i) => drawCentered(top + i * pitch, fitText(line, W - 8), C_TEXT));
}

/* ---------- LED rendering ---------- */

function layoutCanvas() {
  // measure the stage, not the window: with the debug bands mounted the panel
  // has less height to work with, and it should shrink rather than overflow
  const stage = document.getElementById('stage');
  const availW = stage.clientWidth || window.innerWidth;
  const availH = stage.clientHeight || window.innerHeight;
  pitch = Math.max(2, Math.floor(Math.min(
    (availW * 0.94) / W,
    (availH * 0.90) / H,
  )));
  cvs.width = W * pitch;
  cvs.height = H * pitch;
  buildGrid();
  render();
}

// The unlit LEDs never change, so bake them once and blit.
function buildGrid() {
  gridCanvas = document.createElement('canvas');
  gridCanvas.width = cvs.width;
  gridCanvas.height = cvs.height;
  const g = gridCanvas.getContext('2d');
  g.fillStyle = '#020202';
  g.fillRect(0, 0, gridCanvas.width, gridCanvas.height);

  // Unlit LEDs, kept very dark: on a monitor #121212 reads as texture, but on a
  // TV with a mediocre black level the whole panel washes out to grey.
  const r = Math.max(0.6, pitch * 0.26);
  g.fillStyle = '#0a0a0a';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      g.beginPath();
      g.arc(x * pitch + pitch / 2, y * pitch + pitch / 2, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 1;
  for (let x = M.tile; x < W; x += M.tile) {
    g.beginPath(); g.moveTo(x * pitch, 0); g.lineTo(x * pitch, cvs.height); g.stroke();
  }
  for (let y = M.tile; y < H; y += M.tile) {
    g.beginPath(); g.moveTo(0, y * pitch); g.lineTo(cvs.width, y * pitch); g.stroke();
  }
}

function render() {
  ctx.drawImage(gridCanvas, 0, 0);

  const r = Math.max(0.8, pitch * 0.34);
  ctx.shadowBlur = pitch * 0.9;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = fb[y * W + x];
      if (!v) continue;
      const css = '#' + (v & 0xffffff).toString(16).padStart(6, '0');
      ctx.fillStyle = css;
      ctx.shadowColor = css;
      ctx.beginPath();
      ctx.arc(x * pitch + pitch / 2, y * pitch + pitch / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;
}

/* ---------- data + cycling ---------- */

/*
 * Rotation is tracked by aircraft identity, never by list position.
 *
 * The list is re-sorted by distance every poll and aircraft enter and leave it
 * constantly, so an integer cursor into it is meaningless: when a contact
 * overtakes another or drops out, the cursor lands somewhere arbitrary, often
 * on a flight that was just shown. Instead, remember which hex codes this pass
 * has already displayed and always advance to the nearest one it hasn't. A
 * repeat within a pass then can't happen, and nothing gets skipped either.
 */
let flights = [];
let showingHex = null;       // which aircraft is on screen, by identity
let seenThisPass = new Set();
let page = 0;
let lastPage = 0;
let feedState = 'loading';   // loading | ok | nofeed | nolink
let homeUnset = false;       // backend has no location, so nothing is ever near
let build = null;            // frontend fingerprint, for self-updating

function current() {
  return flights.find(a => a.hex === showingHex) || null;
}

/** Nearest aircraft this pass hasn't shown yet; starts a new pass when spent. */
function advance() {
  if (!flights.length) {
    showingHex = null;
    return;
  }
  let next = flights.find(a => !seenThisPass.has(a.hex));
  if (!next) {
    seenThisPass.clear();
    next = flights[0];
  }
  seenThisPass.add(next.hex);
  showingHex = next.hex;
  page = 0;
}

let lastData = null;

async function poll() {
  try {
    const res = await fetch('/api/aircraft' + (Debug.on ? '?debug=1' : ''));
    const data = await res.json();
    lastData = data;

    // The URL wins if it says anything, so one display can be debugged while
    // the cast TV stays clean. Otherwise take the backend's configured default.
    if (debugParam === null && data.debug_default != null && !debugSettled) {
      debugSettled = true;
      Debug.set(data.debug_default);
    }

    // A cast page never reloads by itself: the Chromecast loads this URL once
    // and renders it for months, so a deploy would otherwise never reach the
    // TV. The backend fingerprints the frontend files; if that changes under
    // us, pick up the new build.
    if (data.build) {
      if (build && data.build !== build) {
        location.reload();
        return;
      }
      build = data.build;
    }

    // With no location configured every aircraft sits thousands of miles from
    // 0,0 and is filtered out. Worth calling out separately: "No aircraft in
    // range" is true but sends you looking at a receiver that is working fine.
    homeUnset = !!data.home && !data.home.lat && !data.home.lon;

    const all = data.aircraft || [];
    flights = (CFG.SKIP_GROUND ? all.filter(a => !a.on_ground) : all)
      .slice(0, CFG.MAX_FLIGHTS);

    // forget aircraft that have left, so a pass doesn't end early forever
    const present = new Set(flights.map(a => a.hex));
    for (const hex of [...seenThisPass]) if (!present.has(hex)) seenThisPass.delete(hex);

    // if whatever was on screen has gone, move on rather than showing a blank
    if (!current()) advance();

    // Ride out a brief receiver dropout on the last good data rather than
    // blanking the wall; only give up once it's genuinely stale.
    const stale = data.age_s == null || data.age_s > CFG.STALE_AFTER_S;
    feedState = (data.last_error && stale) ? 'nofeed' : 'ok';
  } catch (e) {
    feedState = 'nolink';
  }
  paint();
}

// Page through this aircraft's bottom-pane pages, then move to the next one.
function tick() {
  if (feedState !== 'ok' || !flights.length) return;
  if (Date.now() - lastPage < CFG.PAGE_MS) return;
  lastPage = Date.now();

  const ac = current();
  const pageCount = ac && M.bottom ? bottomPages(ac).length : 1;
  page += 1;
  if (page >= pageCount) advance();
  paint();
}

function paint() {
  const ac = current();
  if (feedState === 'loading') buildMessageFrame(['...']);
  else if (feedState === 'nolink') buildMessageFrame(['NO LINK', 'backend down']);
  else if (feedState === 'nofeed') buildMessageFrame(['NO FEED', 'check receiver']);
  else if (homeUnset) buildMessageFrame(['NO LOCATION', 'set home lat/lon']);
  else if (!ac) buildMessageFrame(['No aircraft', 'in range']);
  else buildFlightFrame(ac, page);
  render();
  // after the frame, never before: lastLogo is written by drawLogo, so reading
  // it first reports the previous aircraft's logo under this one's callsign
  if (Debug.on) {
    const pageCount = ac && M.bottom ? bottomPages(ac).length : 1;
    Debug.update(lastData, ac, {page, pageCount, shown: flights.length, logo: lastLogo});
  }
}

async function start() {
  layoutCanvas();
  paint();
  await poll();
  setInterval(poll, CFG.POLL_MS);
  setInterval(tick, 250);
}

window.addEventListener('resize', layoutCanvas);

// d toggles the overlay, c copies it. Both matter on a wall display: the
// interesting aircraft is usually gone by the time you have found a keyboard,
// and reading a fault back over the phone is worse than pasting it.
document.addEventListener('keydown', e => {
  if (e.key === 'd') { Debug.set(!Debug.on); paint(); poll(); }
  if (e.key === 'c' && Debug.on) Debug.copy();
});

if (debugParam !== null) Debug.set(debugParam !== '0');
start();
