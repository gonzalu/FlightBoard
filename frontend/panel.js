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

const M = MODELS[new URLSearchParams(location.search).get('model')] || MODELS.mini;
const W = M.W, H = M.H;

const C_TEXT = 0xeaf4ff;
const C_VAL = 0x66d9ff;

// Tail-fin colors by ICAO airline prefix. Brand colors, not logo artwork.
const AIRLINE_COLORS = {
  UAL: [0x1a3a8f, 0x4aa3ff], AAL: [0x8c99a6, 0xd42b3a], DAL: [0x0b2c5c, 0xc8102e],
  SWA: [0x1d3d78, 0xf9b612], JBU: [0x143d7a, 0x39a3ff], ASA: [0x0b3b5c, 0x2ec4b6],
  NKS: [0x2a2a2a, 0xffe600], FFT: [0x0b5c3b, 0x39d98a], RPA: [0x1f4e79, 0x8fb8de],
  EDV: [0x0b2c5c, 0xc8102e], SKW: [0x2b4a6f, 0x9ab8d6], ENY: [0x8c99a6, 0xd42b3a],
  ASH: [0x1f4e79, 0x8fb8de], UPS: [0x3b2314, 0xc8a165], FDX: [0x4d148c, 0xff6600],
  GTI: [0x1f3b6b, 0x6f9fd8], BAW: [0x1d3557, 0xc8102e], DLH: [0x14202e, 0xf9b612],
  AFR: [0x102a54, 0xc8102e], KLM: [0x1a5fa8, 0x7fc4ff], VIR: [0x6b1030, 0xff3f6f],
  ACA: [0x8c1220, 0xff5a6a], JAL: [0x8c1220, 0xff4a5a], ANA: [0x123a6b, 0x5fa8ff],
  UAE: [0x1d3557, 0xd4af37], EJA: [0x1a2b44, 0xc9a227], KAL: [0x1a4f8f, 0x6fb7ff],
  ELY: [0x123a6b, 0x4a90d9], THY: [0x8c1220, 0xe03a4a], QTR: [0x5c0632, 0xa81f5c],
  IBE: [0x8c1220, 0xf2b705], SWR: [0x8c1220, 0xff5a6a], EIN: [0x0b5c3b, 0x39d98a],
  AMX: [0x0b2c5c, 0xe03a4a], AVA: [0x8c1220, 0xe03a4a], CMP: [0x123a6b, 0x5fa8ff],
  ITY: [0x0b3b5c, 0x2ec4b6], LOT: [0x123a6b, 0x5fa8ff], SVA: [0x0b5c3b, 0x39d98a],
};

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

// Real logo if tools/make_logos.py has generated one, otherwise a tail fin.
function drawLogo(box, key, base, accent) {
  const logo = typeof LOGOS !== 'undefined' && key ? LOGOS[key] : null;
  if (!logo) {
    drawFin(box, base, accent);
    return;
  }
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

function flightTitle(airline, callsign) {
  const short = airline ? shortenAirline(airline) : '';
  if (!short) return callsign;
  const number = /^[A-Z]{3}(\w+)$/.exec(callsign);   // DAL1620 -> 1620
  return number ? `${short} ${number[1]}` : short;
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
  return fitText(a.short || a.city || '', avail);
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
  clear();
  if (M.border) drawRect(0, 0, W, H, C_TEXT);

  const airline = (ac.route && ac.route.airline) || '';
  const info = ac.aircraft_info || {};
  const callsign = ac.flight || ac.hex.toUpperCase();

  if (M.logo) {
    const key = airlineKey(callsign);
    const [base, accent] = AIRLINE_COLORS[key]
      || (airline ? hashColors(airline) : [0x243039, 0x51707f]);
    drawLogo(M.logo, key, base, accent);
  }

  // "Delta 1620" rather than just "Delta": the flight number is the thing you
  // actually look up, and without it the callsign appeared nowhere on the panel
  const title = flightTitle(airline, callsign);
  const route = (ac.route && ac.route.origin && ac.route.destination)
    ? `${ac.route.origin}${M.routeSep}${ac.route.destination}`
    : `${ac.distance_nm.toFixed(1)}NM`;
  // line 1 already carries the callsign, so don't repeat it here
  const detail = info.type || (info.registration !== callsign ? info.registration : '') || '';

  const availW = W - TEXT_X - M.padX;
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
  clear();
  if (M.border) drawRect(0, 0, W, H, C_TEXT);
  const pitch = CHAR_H + 2;
  const top = Math.round((H - lines.length * pitch) / 2);
  lines.forEach((line, i) => drawCentered(top + i * pitch, fitText(line, W - 8), C_TEXT));
}

/* ---------- LED rendering ---------- */

function layoutCanvas() {
  pitch = Math.max(2, Math.floor(Math.min(
    (window.innerWidth * 0.94) / W,
    (window.innerHeight * 0.90) / H,
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

async function poll() {
  try {
    const res = await fetch('/api/aircraft');
    const data = await res.json();

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
}

async function start() {
  layoutCanvas();
  paint();
  await poll();
  setInterval(poll, CFG.POLL_MS);
  setInterval(tick, 250);
}

window.addEventListener('resize', layoutCanvas);
start();
