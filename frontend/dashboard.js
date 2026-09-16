/*
 * Multi-aircraft dashboard: the counterpart to the LED panel emulation.
 * Not a hardware replica — it uses the whole window, which on a 4K display
 * means a lot more aircraft than a 128x64 panel could ever show.
 */

const POLL_MS = 2000;
const TILE_MIN_W = 300;
const TILE_H = 132;
const GAP = 12;

const canvas = document.getElementById('radar');
const ctx = canvas.getContext('2d');
const radarPane = document.getElementById('radarPane');
const cardsEl = document.getElementById('cards');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const clockEl = document.getElementById('clock');
const rangeLabelEl = document.getElementById('rangeLabel');

const LED = '#eaf6ff';
const DIM = '#4a5d66';
const GREEN = '#39ff6a';
const PINK = '#ff3f5f';
const BLUE = '#3aa7ff';

let sweep = 0;
let latest = { aircraft: [], max_range_nm: 40, sources: [] };
let rangeNm = null;          // null until the first response sets it
let radarSize = 600;

function statusColor(ac) {
  if (ac.on_ground) return DIM;
  if (ac.baro_rate > 200) return GREEN;
  if (ac.baro_rate < -200) return PINK;
  return BLUE;
}

/* ---------- formatting, matching the panel ---------- */

const fmtAlt = ft => ft == null ? 'N/A'
  : Math.abs(ft) >= 1000 ? (ft / 1000).toFixed(1) + 'k ft' : Math.round(ft) + ' ft';
const fmtSpd = kt => kt == null ? 'N/A' : Math.round(kt) + 'kt';
const fmtTrk = d => d == null ? 'N/A' : Math.round(d) + 'deg';
const fmtVr = fpm => fpm == null ? 'N/A'
  : (fpm > 0 ? '+' : '') + Math.round(fpm) + 'fpm';

function fmtEta(min) {
  if (min == null || min < 0) return null;
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}min` : `${h}hr`;
}

function shortenAirline(name) {
  return name
    .replace(/\s+(Air Lines|Airlines|Airways|Airline|Aviation|Air)\b.*$/i, '')
    .replace(/\s+(Inc|LLC|Ltd|Co)\.?$/i, '')
    .trim();
}

function flightTitle(ac) {
  const airline = (ac.route && ac.route.airline) || '';
  const callsign = ac.flight || ac.hex.toUpperCase();
  const short = airline ? shortenAirline(airline) : '';
  if (!short) return callsign;
  const n = /^[A-Z]{3}(\w+)$/.exec(callsign);
  return n ? `${short} ${n[1]}` : short;
}

// The callsign comes off the air, so it only reaches the DOM if it looks like one.
function identLink(ac) {
  const ident = (ac.flight || '').trim();
  if (!/^[A-Z0-9]{2,8}$/.test(ident)) return ac.hex;
  return `<a href="https://www.flightaware.com/live/flight/${ident}" target="_blank" rel="noopener noreferrer">${ident}</a>`;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- badges, shared with the LED panel via marks.js ---------- */

// The art is 28x28 and CSS upscales it, so the pixels stay hard.
const MARK_PX = 28;

// Redrawing a canvas 30 times a minute for a mark that has not changed is
// wasted work and makes the tile flicker, so a signature says when it has.
function markSignature(ac, info) {
  const m = markFor(ac, info);
  return `${m.kind}:${m.key || ''}:${m.text || ''}`;
}

function drawMarkInto(iconEl, ac, info, color) {
  const m = markFor(ac, info);
  const cv = document.createElement('canvas');
  cv.className = 'logo';
  cv.width = cv.height = MARK_PX;
  const g = cv.getContext('2d');
  const img = g.createImageData(MARK_PX, MARK_PX);
  const px = (x, y, c) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= MARK_PX || y >= MARK_PX) return;
    const o = (y * MARK_PX + x) * 4;
    img.data[o] = (c >> 16) & 255;
    img.data[o + 1] = (c >> 8) & 255;
    img.data[o + 2] = c & 255;
    img.data[o + 3] = 255;
  };
  const airline = (ac.route && ac.route.airline) || '';
  const [base, accent] = markColors(m.key, airline || info.owner || '');
  paintMark(px, { x: 0, y: 0, size: MARK_PX }, m, base, accent);
  g.putImageData(img, 0, 0);
  iconEl.appendChild(cv);
}

/* ---------- basemap ---------- */

/*
 * Land, lakes, borders and airports beneath the radar, when
 * tools/make_basemap.py has written frontend/basemap.js. Without that file the
 * radar is exactly as it always was.
 *
 * Every point in the file is already nautical miles east and north of home,
 * which is precisely how the aircraft are placed, so drawing the map is nothing
 * but a scale and the two cannot drift apart at any zoom.
 *
 * The map only changes when you zoom or resize, so it is traced once onto an
 * offscreen canvas and that is stamped under each frame, rather than walking
 * thousands of points sixty times a second.
 */
const MAP_LAND = '#0a1317';
const MAP_SHORE = '#1d3440';
const MAP_BORDER = '#1a2a33';
const MAP_AIRPORT = '#b08d4a';
const MAP_FONT = '10px Doto, monospace';

let mapCache = null;

const haveBasemap = () => typeof BASEMAP !== 'undefined' && !!BASEMAP;

// A map made for somewhere else would draw the coast in the wrong place with
// complete confidence, which is worse than drawing nothing.
function basemapFitsHome() {
  const h = latest.home, m = BASEMAP.home;
  if (!h) return false;
  const north = (h.lat - m.lat) * 60;
  const east = (h.lon - m.lon) * 60 * Math.cos(h.lat * Math.PI / 180);
  return Math.hypot(north, east) < 1;
}

function drawBasemap(w, cx, cy, maxR, range) {
  if (!haveBasemap() || !basemapFitsHome()) return;
  const dpr = window.devicePixelRatio || 1;
  // Font status is part of the key so labels drawn in the fallback font, before
  // Doto has loaded, are redrawn once it has.
  const key = `${w}|${dpr}|${range}|${liveMap ? 'live' : ''}|${document.fonts ? document.fonts.status : ''}`;
  if (!mapCache || mapCache.key !== key) {
    const cv = (mapCache && mapCache.canvas) || document.createElement('canvas');
    cv.width = cv.height = Math.round(w * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintBasemap(g, cx, cy, maxR, range);
    mapCache = { key, canvas: cv };
  }
  ctx.drawImage(mapCache.canvas, 0, 0, w, w);
}

function paintBasemap(g, cx, cy, maxR, range) {
  const k = maxR / range;
  const trace = (pts, close) => {
    g.moveTo(cx + pts[0] * k, cy - pts[1] * k);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(cx + pts[i] * k, cy - pts[i + 1] * k);
    if (close) g.closePath();
  };

  // With the live map showing, the ground beneath is its job, not ours.
  if (!liveMap) {
    g.save();
    g.beginPath();
    g.arc(cx, cy, maxR, 0, Math.PI * 2);
    g.clip();
    g.lineWidth = 1;
    g.lineJoin = 'round';

    g.beginPath();
    for (const ring of BASEMAP.land || []) trace(ring, true);
    g.fillStyle = MAP_LAND;
    g.fill();
    g.strokeStyle = MAP_SHORE;
    g.stroke();

    // Lakes are cut out of the land rather than painted over it, so they show
    // the same water the sea does.
    g.beginPath();
    for (const ring of BASEMAP.lakes || []) trace(ring, true);
    g.globalCompositeOperation = 'destination-out';
    g.fill();
    g.globalCompositeOperation = 'source-over';
    g.stroke();

    // State lines dashed; borders between countries a little bolder.
    g.strokeStyle = MAP_BORDER;
    g.setLineDash([4, 3]);
    g.beginPath();
    for (const line of BASEMAP.states || []) trace(line, false);
    g.stroke();
    g.lineWidth = 1.5;
    g.setLineDash([8, 3]);
    g.beginPath();
    for (const line of BASEMAP.countries || []) trace(line, false);
    g.stroke();
    g.restore();
  }

  // Airports sit on top. Labels are placed nearest first and dropped where they
  // would land on another label, the home marker or a ring's distance.
  const taken = [[cx - 6, cy - 6, 12, 12]];
  for (let i = 1; i <= 4; i++) taken.push([cx + 2, cy - (maxR * i) / 4 - 13, 32, 12]);
  const clear = b => !taken.some(t =>
    b[0] < t[0] + t[2] && t[0] < b[0] + b[2] && b[1] < t[1] + t[3] && t[1] < b[1] + b[3]);

  g.font = MAP_FONT;
  g.textBaseline = 'middle';
  g.strokeStyle = g.fillStyle = MAP_AIRPORT;
  for (const [code, e, n] of BASEMAP.airports || []) {
    if (Math.hypot(e, n) > range) continue;
    const x = cx + e * k, y = cy - n * k;
    g.beginPath();
    g.arc(x, y, 2.5, 0, Math.PI * 2);
    g.stroke();
    const tw = g.measureText(code).width;
    for (const [lx, ly] of [[x + 6, y], [x - 6 - tw, y], [x - tw / 2, y - 10], [x - tw / 2, y + 10]]) {
      const box = [lx - 1, ly - 6, tw + 2, 12];
      if (!clear(box)) continue;
      taken.push(box);
      g.fillText(code, lx, ly);
      break;
    }
  }
}

/*
 * An optional live map underneath, off unless the URL says ?map=live.
 *
 * The map above is deliberately coarse: Natural Earth has a point about every
 * 0.9 nm, which is fine at 40 nm and blocky at 4. This draws the same ground
 * from OpenStreetMap instead, in OpenFreeMap's copy of the Dark Matter style,
 * and stays sharp to the last nautical mile. The cost is that the browser
 * showing the dashboard needs the internet and asks a third party for tiles,
 * which is why nothing here happens unless you ask for it.
 *
 * Streets below motorway class are switched off and the place names dimmed, so
 * the map stays a backdrop and the traffic stays the brightest thing on it.
 * Coastline, borders, motorways and runways are what remain. The airports are
 * still ours, drawn over the top from basemap.js.
 *
 * It is a plain DOM layer behind the canvas, sized to the radar circle and
 * centred on home, so the two agree without any compositing. Aircraft keep the
 * projection they have always had: at 40 nm that puts them within two pixels of
 * where the map itself would draw them.
 */
const LIVE_MAP = new URLSearchParams(location.search).get('map') === 'live';
const LIVE_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const LIVE_LIB_JS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.1/dist/maplibre-gl.js';
const LIVE_LIB_JS_SRI = 'sha384-/L1njH4bbgNt9Uk3HwJ272N9fxJzRBQCxhtwGkZiqgl+Nxpq2ETUNZhNMNV1RgyW';
const LIVE_LIB_CSS = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.1/dist/maplibre-gl.css';
const LIVE_LIB_CSS_SRI = 'sha384-Nq6PQ+9vJPvw7U/VfDELyrWoGQMsy0gi6QShhaSrGzkpF5KkM40csg2leky+YMTd';
// Side streets, railways, buildings and their names. Everything the radar can
// actually navigate by - motorways, coast, borders, runways - stays.
const LIVE_HIDE = [
  'highway_path', 'highway_minor', 'highway_major_casing', 'highway_major_inner',
  'highway_major_subtle', 'highway_name_other', 'railway', 'railway_dashline',
  'railway_minor', 'railway_minor_dashline', 'railway_transit',
  'railway_transit_dashline', 'building', 'road_oneway', 'road_oneway_opposite',
  'road_pier', 'road_area_pier',
];
const LIVE_PLACE_OPACITY = 0.45;

let liveMap = null;        // the map itself, once it has really loaded
let livePane = null;       // the div it lives in
let liveZoom = null;       // last zoom pushed, so it only moves when it must

function loadAsset(tag, attrs) {
  return new Promise((resolve, reject) => {
    const el = Object.assign(document.createElement(tag), attrs);
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('could not load ' + (attrs.src || attrs.href)));
    document.head.appendChild(el);
  });
}

// The scale the radar is drawing at, expressed the way a web map wants it.
function liveZoomFor(range) {
  const maxR = radarSize / 2 - 24;
  const metresPerPixel = (range * 1852) / maxR;
  return Math.log2(40075016.686 * Math.cos(latest.home.lat * Math.PI / 180) / (512 * metresPerPixel));
}

// Required by the licence on the tiles, and it belongs on the map itself.
function addMapCredit() {
  const el = document.createElement('div');
  el.id = 'mapCredit';
  el.innerHTML =
    '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> ' +
    '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a>';
  radarPane.appendChild(el);
}

async function initLiveMap() {
  livePane = document.createElement('div');
  livePane.id = 'liveMap';
  radarPane.appendChild(livePane);
  sizeRadar();
  try {
    await Promise.all([
      loadAsset('link', { rel: 'stylesheet', href: LIVE_LIB_CSS, integrity: LIVE_LIB_CSS_SRI, crossOrigin: 'anonymous' }),
      loadAsset('script', { src: LIVE_LIB_JS, integrity: LIVE_LIB_JS_SRI, crossOrigin: 'anonymous' }),
    ]);
    const map = new maplibregl.Map({
      container: livePane,
      style: LIVE_STYLE,
      center: [latest.home.lon, latest.home.lat],
      zoom: liveZoomFor(rangeNm || latest.max_range_nm || 40),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    // A tab the browser is not drawing gets no animation frames, so the map
    // cannot finish loading in one; that is not a failure, and it completes on
    // its own when the tab comes back. So the wait is only given a deadline
    // while the tab is actually visible, for the case where the style or the
    // tiles never arrive at all.
    await new Promise((resolve, reject) => {
      let timer = null;
      const arm = () => {
        clearTimeout(timer);
        if (!document.hidden) timer = setTimeout(() => giveUp(), 20000);
      };
      const settle = fn => (...args) => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', arm);
        fn(...args);
      };
      const giveUp = settle(() => reject(new Error('the map did not load')));
      document.addEventListener('visibilitychange', arm);
      arm();
      map.once('load', settle(resolve));
      map.once('error', settle(e => reject(new Error((e && e.error && e.error.message) || 'tiles unavailable'))));
    });
    for (const layer of map.getStyle().layers) {
      if (LIVE_HIDE.includes(layer.id)) map.setLayoutProperty(layer.id, 'visibility', 'none');
      else if (layer.id.startsWith('place_')) map.setPaintProperty(layer.id, 'text-opacity', LIVE_PLACE_OPACITY);
    }
    liveMap = map;
    mapCache = null;          // the drawn-in land has to come back off
    addMapCredit();
    updateRangeLabel();
  } catch (e) {
    // Anything at all going wrong just leaves the built-in map in place.
    console.warn('live map unavailable, keeping the built-in one:', e.message);
    livePane.remove();
    livePane = null;
  }
}

function syncLiveMap(range) {
  if (!liveMap) return;
  const zoom = liveZoomFor(range);
  if (zoom === liveZoom) return;
  liveMap.jumpTo({ center: [latest.home.lon, latest.home.lat], zoom });
  liveZoom = zoom;
}

/* ---------- radar ---------- */

function sizeRadar() {
  const dpr = window.devicePixelRatio || 1;
  const box = Math.max(200, Math.min(radarPane.clientWidth, radarPane.clientHeight) - 16);
  radarSize = box;
  canvas.style.width = canvas.style.height = box + 'px';
  canvas.width = canvas.height = Math.round(box * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (livePane) {
    // exactly the radar circle: same centre, same radius, so the map and the
    // rings cannot disagree about where anything is
    const d = box - 48;
    livePane.style.width = livePane.style.height = d + 'px';
    livePane.style.left = canvas.offsetLeft + 24 + 'px';
    livePane.style.top = canvas.offsetTop + 24 + 'px';
    if (liveMap) { liveMap.resize(); liveZoom = null; }
  }
}

function drawRadar() {
  const w = radarSize, cx = w / 2, cy = w / 2;
  const maxR = w / 2 - 24;
  const range = rangeNm || latest.max_range_nm || 40;

  syncLiveMap(range);
  ctx.clearRect(0, 0, w, w);
  drawBasemap(w, cx, cy, maxR, range);

  ctx.strokeStyle = '#1a2732';
  ctx.lineWidth = 1;
  ctx.font = '10px Doto, monospace';
  for (let i = 1; i <= 4; i++) {
    const r = (maxR * i) / 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = DIM;
    ctx.fillText(`${(range * i / 4).toFixed(range < 8 ? 1 : 0)}nm`, cx + 3, cy - r - 3);
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy - maxR); ctx.lineTo(cx, cy + maxR);
  ctx.moveTo(cx - maxR, cy); ctx.lineTo(cx + maxR, cy);
  ctx.stroke();

  const rad = (sweep * Math.PI) / 180;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, maxR, rad - 0.45, rad);
  ctx.closePath();
  ctx.fillStyle = 'rgba(58,167,255,0.07)';
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = LED;
  ctx.fillRect(cx - 2, cy - 2, 4, 4);

  for (const ac of latest.aircraft) {
    if (ac.distance_nm > range) continue;
    const r = (ac.distance_nm / range) * maxR;
    const b = (ac.bearing_deg * Math.PI) / 180;
    const x = cx + r * Math.sin(b);
    const y = cy - r * Math.cos(b);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((ac.track || 0) * Math.PI / 180);
    ctx.fillStyle = statusColor(ac);
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#8fa8b8';
    ctx.font = '10px Doto, monospace';
    ctx.fillText(ac.flight || ac.hex, x + 7, y + 3);
  }

  sweep = (sweep + 1.2) % 360;
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const max = (latest.max_range_nm || 40) * 1.5;
  const next = (rangeNm || latest.max_range_nm || 40) * (e.deltaY > 0 ? 1.15 : 1 / 1.15);
  rangeNm = Math.max(1, Math.min(max, next));
  updateRangeLabel();
}, { passive: false });

canvas.addEventListener('dblclick', () => {
  rangeNm = latest.max_range_nm || 40;
  updateRangeLabel();
});

function updateRangeLabel() {
  const r = rangeNm || latest.max_range_nm || 40;
  const note = liveMap ? ' · live map'
    : !haveBasemap() || !latest.home ? ''
    : !basemapFitsHome() ? ' · map is for another home: rerun tools/make_basemap.py'
    : r > BASEMAP.radius_nm ? ` · map ends at ${BASEMAP.radius_nm} nm`
    : '';
  rangeLabelEl.textContent =
    `range ${r < 8 ? r.toFixed(1) : Math.round(r)} nm — scroll to zoom, double-click to reset${note}`;
}

/* ---------- tiles ---------- */

// How many tiles actually fit, so a 4K window fills with aircraft and a laptop
// doesn't clip a half row.
function tileCapacity() {
  const cols = Math.max(1, Math.floor((cardsEl.clientWidth + GAP) / (TILE_MIN_W + GAP)));
  const rows = Math.max(1, Math.floor((cardsEl.clientHeight + GAP) / (TILE_H + GAP)));
  return cols * rows;
}

/*
 * Cards are keyed by hex and kept alive between polls.
 *
 * They used to be rebuilt with innerHTML every two seconds, which had a cost
 * that is invisible in a screenshot and maddening in use: the FlightAware link
 * under your cursor was a different DOM node by the time the mouse button came
 * up, so the click landed on nothing. Reusing the element fixes that outright.
 *
 * Order still follows distance, nearest first, because that is what you want
 * when you glance at it. But reordering is suspended while the pointer is over
 * the list - the text keeps updating, the tiles just stop moving - because
 * aiming at a link that is being re-sorted underneath you is a losing game.
 */
const cardByHex = new Map();
let frozen = false;

cardsEl.addEventListener('pointerenter', () => { frozen = true; });
cardsEl.addEventListener('pointerleave', () => { frozen = false; });

function cardShell() {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="icon"></div>
    <div class="lines">
      <div class="toprow"><span class="ident"></span><span class="dist"></span></div>
      <div class="l1"></div><div class="l2"></div><div class="l3"></div><div class="l4"></div>
      <div class="barwrap"></div>
    </div>`;
  return el;
}

function fillCard(el, ac) {
  const r = ac.route || {};
  const info = ac.aircraft_info || {};
  const from = r.from || {}, to = r.to || {};
  const color = statusColor(ac);
  const eta = fmtEta(r.eta_min);

  const icon = el.querySelector('.icon');
  icon.style.background = color + '22';
  icon.style.color = color;
  const wanted = markSignature(ac, info);
  if (icon.dataset.sig !== wanted) {          // only redraw when it changes
    icon.dataset.sig = wanted;
    icon.innerHTML = '';
    drawMarkInto(icon, ac, info, color);
  }

  const ident = (ac.flight || '').trim();
  const identEl = el.querySelector('.ident');
  const identWanted = /^[A-Z0-9]{2,8}$/.test(ident) ? ident : ac.hex;
  if (identEl.dataset.v !== identWanted) {
    identEl.dataset.v = identWanted;
    identEl.innerHTML = identLink(ac);
  }

  const routeLine = (r.origin && r.destination)
    ? `${esc(r.origin)}-${esc(r.destination)}` +
      (from.city && to.city ? `  ${esc(from.city)} &rarr; ${esc(to.city)}` : '')
    : `brg ${Math.round(ac.bearing_deg)}&deg;`;

  const metrics = ac.on_ground
    ? `On ground &middot; ${ac.gs > 2 ? 'Taxiing' : 'Stationary'}`
    : `Alt:${fmtAlt(ac.alt_baro)} Spd:${fmtSpd(ac.gs)} Trk:${fmtTrk(ac.track)} Vr:${fmtVr(ac.baro_rate)}`;

  // Registration earns its place: for anything without an airline callsign it
  // is the only identity there is, and it is what you type into a lookup.
  const reg = info.registration ? esc(info.registration) : '';
  const type = esc(info.type || '');
  const l3 = [reg, type].filter(Boolean).join(' &middot; ') +
             (eta ? `${reg || type ? ' &middot; ' : ''}in ${eta}` : '');

  set(el, '.dist', `${ac.distance_nm.toFixed(1)}NM${ac.source ? ` &middot; ${esc(ac.source)}` : ''}`);
  set(el, '.l1', esc(flightTitle(ac)));
  set(el, '.l2', routeLine);
  set(el, '.l3', l3);
  set(el, '.l4', metrics);

  const bw = el.querySelector('.barwrap');
  if (r.progress != null) {
    let i = bw.querySelector('i');
    if (!i) { bw.innerHTML = '<div class="bar"><i></i></div>'; i = bw.querySelector('i'); }
    i.style.width = (r.progress * 100).toFixed(1) + '%';
  } else if (bw.firstChild) {
    bw.innerHTML = '';
  }
}

// Write only when it changed, so the DOM is not touched 30 times a second for
// text that is identical.
function set(el, sel, html) {
  const n = el.querySelector(sel);
  if (n && n.innerHTML !== html) n.innerHTML = html;
}

function renderCards(aircraft) {
  const shown = aircraft.slice(0, tileCapacity());
  const present = new Set();

  for (const ac of shown) {
    present.add(ac.hex);
    let el = cardByHex.get(ac.hex);
    if (!el) {
      el = cardShell();
      cardByHex.set(ac.hex, el);
      cardsEl.appendChild(el);
    }
    fillCard(el, ac);
  }

  for (const [hex, el] of cardByHex) {
    if (!present.has(hex)) { el.remove(); cardByHex.delete(hex); }
  }

  // Re-sorting moves existing nodes rather than replacing them, so a link
  // survives the move. Skipped entirely while the pointer is over the list.
  if (!frozen) {
    for (const ac of shown) {
      const el = cardByHex.get(ac.hex);
      if (el) cardsEl.appendChild(el);
    }
  }

  countEl.textContent = `${shown.length} of ${aircraft.length} aircraft` +
                        (frozen ? ' · order held' : '');
}

/* ---------- data ---------- */

async function poll() {
  try {
    const res = await fetch('/api/aircraft');
    const data = await res.json();
    latest = data;
    if (rangeNm === null) { rangeNm = data.max_range_nm; updateRangeLabel(); }
    if (LIVE_MAP && !livePane && data.home) initLiveMap();

    const stale = data.age_s == null || data.age_s > 90;
    const live = !(data.last_error && stale);
    const srcs = (data.sources || []).map(s => `${s.name}:${s.ok ? s.aircraft : 'down'}`).join('  ');
    statusEl.textContent = live
      ? `live  ${srcs}${data.last_error ? '  (degraded)' : ''}`
      : `no feed — ${data.last_error}`;
    statusEl.className = live ? '' : 'err';

    renderCards(data.aircraft);
  } catch (e) {
    statusEl.textContent = 'backend unreachable';
    statusEl.className = 'err';
  }
}

function loop() {
  drawRadar();
  requestAnimationFrame(loop);
}

function onResize() {
  sizeRadar();
  renderCards(latest.aircraft);
}

window.addEventListener('resize', onResize);
sizeRadar();
updateRangeLabel();
poll();
setInterval(poll, POLL_MS);
setInterval(() => clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false }), 1000);
requestAnimationFrame(loop);
