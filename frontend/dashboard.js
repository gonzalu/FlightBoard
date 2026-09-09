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

/* ---------- airline logos (same pixel art the LED panel uses) ---------- */

function airlineKey(callsign) {
  const m = /^([A-Z]{3})\d/.exec((callsign || '').trim());
  if (!m || typeof LOGOS === 'undefined') return null;
  // regionals wear their mainline partner's tail — see logo-aliases.js
  const code = (typeof LOGO_ALIASES !== 'undefined' && LOGO_ALIASES[m[1]]) || m[1];
  return LOGOS[code] ? code : null;
}

// Canvases are emitted by renderCards and filled here, once the markup is in
// the DOM. Drawn at native 26px and upscaled by CSS so the pixels stay crisp.
function paintLogos() {
  if (typeof LOGOS === 'undefined') return;
  for (const cv of cardsEl.querySelectorAll('canvas.logo')) {
    const logo = LOGOS[cv.dataset.code];
    if (!logo) continue;
    const g = cv.getContext('2d');
    const img = g.createImageData(LOGO_SIZE, LOGO_SIZE);
    for (let i = 0; i < logo.d.length; i++) {
      const ch = logo.d.charCodeAt(i);
      const o = i * 4;
      if (ch === 48) continue;                       // '0' = transparent
      const c = logo.p[(ch <= 57 ? ch - 48 : ch - 87) - 1];
      img.data[o] = (c >> 16) & 255;
      img.data[o + 1] = (c >> 8) & 255;
      img.data[o + 2] = c & 255;
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
}

/* ---------- radar ---------- */

function sizeRadar() {
  const dpr = window.devicePixelRatio || 1;
  const box = Math.max(200, Math.min(radarPane.clientWidth, radarPane.clientHeight) - 16);
  radarSize = box;
  canvas.style.width = canvas.style.height = box + 'px';
  canvas.width = canvas.height = Math.round(box * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawRadar() {
  const w = radarSize, cx = w / 2, cy = w / 2;
  const maxR = w / 2 - 24;
  const range = rangeNm || latest.max_range_nm || 40;

  ctx.clearRect(0, 0, w, w);

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
  rangeLabelEl.textContent = `range ${r < 8 ? r.toFixed(1) : Math.round(r)} nm — scroll to zoom, double-click to reset`;
}

/* ---------- tiles ---------- */

// How many tiles actually fit, so a 4K window fills with aircraft and a laptop
// doesn't clip a half row.
function tileCapacity() {
  const cols = Math.max(1, Math.floor((cardsEl.clientWidth + GAP) / (TILE_MIN_W + GAP)));
  const rows = Math.max(1, Math.floor((cardsEl.clientHeight + GAP) / (TILE_H + GAP)));
  return cols * rows;
}

function renderCards(aircraft) {
  const shown = aircraft.slice(0, tileCapacity());
  cardsEl.innerHTML = shown.map(ac => {
    const r = ac.route || {};
    const info = ac.aircraft_info || {};
    const from = r.from || {}, to = r.to || {};
    const color = statusColor(ac);
    const eta = fmtEta(r.eta_min);
    const code = airlineKey(ac.flight);
    const mark = code
      ? `<canvas class="logo" data-code="${code}" width="${LOGO_SIZE}" height="${LOGO_SIZE}"></canvas>`
      : PLANE;

    const routeLine = (r.origin && r.destination)
      ? `${esc(r.origin)}-${esc(r.destination)}` +
        (from.city && to.city ? `  ${esc(from.city)} &rarr; ${esc(to.city)}` : '')
      : `brg ${Math.round(ac.bearing_deg)}&deg;`;

    const metrics = ac.on_ground
      ? `On ground &middot; ${ac.gs > 2 ? 'Taxiing' : 'Stationary'}`
      : `Alt:${fmtAlt(ac.alt_baro)} Spd:${fmtSpd(ac.gs)} Trk:${fmtTrk(ac.track)} Vr:${fmtVr(ac.baro_rate)}`;

    const bar = r.progress != null
      ? `<div class="bar"><i style="width:${(r.progress * 100).toFixed(1)}%"></i></div>`
      : '';

    return `
      <div class="card">
        <div class="icon" style="background:${color}22;color:${color}">${mark}</div>
        <div class="lines">
          <div class="toprow">
            <span>${identLink(ac)}</span>
            <span>${ac.distance_nm.toFixed(1)}NM${ac.source ? ` &middot; ${esc(ac.source)}` : ''}</span>
          </div>
          <div class="l1">${esc(flightTitle(ac))}</div>
          <div class="l2">${routeLine}</div>
          <div class="l3">${esc(info.type || info.registration || '')}${eta ? ` &middot; in ${eta}` : ''}</div>
          <div class="l4">${metrics}</div>
          ${bar}
        </div>
      </div>`;
  }).join('');

  paintLogos();
  countEl.textContent = `${shown.length} of ${aircraft.length} aircraft`;
}

const PLANE = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M2 16l7-2 5-8 2 1-3 7 6-1 2 2-7 3 1 4-2 1-3-5-6 2z" fill="currentColor"/>
</svg>`;

/* ---------- data ---------- */

async function poll() {
  try {
    const res = await fetch('/api/aircraft');
    const data = await res.json();
    latest = data;
    if (rangeNm === null) { rangeNm = data.max_range_nm; updateRangeLabel(); }

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
