/*
 * The metrics page: a table of headline numbers and a set of small charts,
 * drawn as plain SVG so there is nothing to load and nothing to go stale.
 *
 * Everything comes from one call, /api/metrics?range=..., which the backend
 * answers from its own history (backend/metrics.py). The page only draws it.
 */
'use strict';

const WINDOW_S = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400, '1y': 365 * 86400 };
// Same order and colours as the receiver dots on the panel, so a colour means the
// same receiver on every page.
const RX_COLORS = ['#ff4040', '#40ff40', '#5c86ff', '#ffb020', '#ff4cf0', '#40ffd0'];
const REFRESH_MS = 60000;

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
let range = (location.hash || '').slice(1);
if (!WINDOW_S[range]) range = '24h';
let data = null;
let rxOrder = [];

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmt(v, digits = 1) {
  return v == null ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });
}
function rxColor(name) {
  const i = rxOrder.indexOf(name);
  return RX_COLORS[i >= 0 ? i : rxOrder.length] || '#8090a0';
}
// The top of an axis that is split into four, chosen so every gridline lands on
// a round number: 30 becomes 40 (10, 20, 30, 40), never 50 (12.5, 25, 37.5).
function niceMax(v) {
  if (!(v > 0)) return 4;
  const q = v / 4, p = Math.pow(10, Math.floor(Math.log10(q)));
  for (const m of [1, 2, 5, 10]) if (q <= m * p) return 4 * m * p;
  return 40 * p;
}

/* ---- time axis ---------------------------------------------------------- */

// Ticks are chosen from how much time is shown, not from which button was
// pressed: a year view of a week-old install has a week to label.
function timeTicks(t0, t1) {
  const out = [];
  const d = new Date(t0 * 1000);
  const days = (t1 - t0) / 86400;
  if (days <= 2) {
    d.setMinutes(0, 0, 0);
    d.setHours(Math.ceil(d.getHours() / 4) * 4);
    for (; d.getTime() / 1000 <= t1; d.setHours(d.getHours() + 4))
      out.push([d.getTime() / 1000, d.getHours().toString().padStart(2, '0') + ':00']);
  } else if (days <= 60) {
    d.setHours(24, 0, 0, 0);
    const step = days <= 9 ? 1 : days <= 20 ? 2 : 5;
    for (; d.getTime() / 1000 <= t1; d.setDate(d.getDate() + step))
      out.push([d.getTime() / 1000, d.toLocaleDateString(undefined,
        days <= 9 ? { weekday: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' })]);
  } else {
    d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
    for (; d.getTime() / 1000 <= t1; d.setMonth(d.getMonth() + 1))
      out.push([d.getTime() / 1000, d.toLocaleDateString(undefined, { month: 'short' })]);
  }
  return out;
}

// The left edge of a chart: the start of the window, or the first sample if the
// history is shorter than that, so a young install fills the chart.
function windowStart(t1, lists) {
  let first = Infinity;
  for (const pts of lists) if (pts && pts.length) first = Math.min(first, pts[0][0]);
  const full = t1 - WINDOW_S[range];
  return Number.isFinite(first) ? Math.max(full, first - data.bucket_s) : full;
}

function stamp(ts) {
  const d = new Date(ts * 1000);
  return data.bucket_s >= 7200
    ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// Charts are drawn at the width they are shown at, so their text stays the size
// it was written at instead of shrinking with a narrow card.
function width(host) {
  return Math.max(300, Math.round(host.clientWidth) || 760);
}

/* ---- the tooltip -------------------------------------------------------- */

const tip = $('tip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.left = Math.min(x + 14, innerWidth - w - 8) + 'px';
  tip.style.top = (y + 14) + 'px';
}
function hideTip() { tip.hidden = true; }

/* ---- a line chart ------------------------------------------------------- */

/*
 * series: [{label, color, pts: [[ts, value], ...]}]. A gap in the samples breaks
 * the line rather than being drawn across, because a line through a missing hour
 * is a claim about that hour.
 */
function lineChart(host, series, opts = {}) {
  series = series.filter(s => s.pts && s.pts.length);
  host.innerHTML = '';
  if (!series.length) { host.innerHTML = '<div class="empty">No samples for this range yet.</div>'; return; }

  const W = width(host), H = opts.height || 180, M = { l: 40, r: 10, t: 8, b: 22 };
  const t1 = data.generated, t0 = windowStart(t1, series.map(s => s.pts));
  const hi = Math.max(...series.map(s => Math.max(...s.pts.map(p => p[1]))));
  const y1 = opts.max != null ? opts.max : niceMax(hi);
  const y0 = opts.min != null ? opts.min : 0;
  const X = t => M.l + (t - t0) / (t1 - t0) * (W - M.l - M.r);
  const Y = v => H - M.b - (v - y0) / (y1 - y0) * (H - M.t - M.b);
  const digits = opts.digits != null ? opts.digits : 1;

  const root = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
                           'aria-label': opts.label || '' }, host);
  const grid = el('g', { class: 'grid' }, root);
  for (let i = 0; i <= 4; i++) {
    const v = y0 + (y1 - y0) * i / 4;
    el('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v) }, grid);
    el('text', { x: M.l - 6, y: Y(v) + 3, 'text-anchor': 'end' }, root).textContent =
      (opts.unit === '%' ? Math.round(v) + '%' : fmt(v, y1 < 8 ? 1 : 0));
  }
  for (const [t, label] of timeTicks(t0, t1)) {
    el('line', { x1: X(t), x2: X(t), y1: M.t, y2: H - M.b, stroke: '#0e161c' }, grid);
    el('text', { x: X(t), y: H - 6, 'text-anchor': 'middle' }, root).textContent = label;
  }

  const gap = data.bucket_s * 2.5;
  for (const s of series) {
    let seg = [];
    const flush = () => {
      if (seg.length === 1) el('circle', { cx: X(seg[0][0]), cy: Y(seg[0][1]), r: 1.6, fill: s.color }, root);
      if (seg.length > 1) {
        const path = seg.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('');
        if (opts.area && s === series[0])
          el('path', { d: path + `L${X(seg[seg.length - 1][0]).toFixed(1)} ${Y(y0)}L${X(seg[0][0]).toFixed(1)} ${Y(y0)}Z`,
                       fill: s.color, 'fill-opacity': .13 }, root);
        el('path', { d: path, fill: 'none', stroke: s.color, 'stroke-width': s.dim ? 1 : 1.6,
                     'stroke-opacity': s.dim ? .55 : 1, 'stroke-linejoin': 'round' }, root);
      }
      seg = [];
    };
    for (const p of s.pts) {
      if (seg.length && p[0] - seg[seg.length - 1][0] > gap) flush();
      seg.push(p);
    }
    flush();
  }

  const cursor = el('line', { class: 'hover', y1: M.t, y2: H - M.b, visibility: 'hidden' }, root);
  const cap = el('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: 'transparent' }, root);
  cap.addEventListener('mousemove', ev => {
    const box = root.getBoundingClientRect();
    const t = t0 + ((ev.clientX - box.left) / box.width * W - M.l) / (W - M.l - M.r) * (t1 - t0);
    const rows = [];
    let at = null;
    for (const s of series) {
      let best = null;
      for (const p of s.pts) if (best === null || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      if (best && Math.abs(best[0] - t) <= data.bucket_s * 1.5) {
        rows.push(`<i style="background:${s.color};display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:6px"></i>` +
                  `${esc(s.label)}: <b>${fmt(best[1], digits)}${opts.unit || ''}</b>`);
        at = best[0];
      }
    }
    if (at === null) { cursor.setAttribute('visibility', 'hidden'); hideTip(); return; }
    cursor.setAttribute('x1', X(at)); cursor.setAttribute('x2', X(at));
    cursor.setAttribute('visibility', 'visible');
    showTip(`<div>${esc(stamp(at))}</div>` + rows.join('<br>'), ev.clientX, ev.clientY);
  });
  cap.addEventListener('mouseleave', () => { cursor.setAttribute('visibility', 'hidden'); hideTip(); });

  if (series.length > 1 || opts.legend) {
    const lg = document.createElement('div');
    lg.className = 'legend';
    lg.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
    host.appendChild(lg);
  }
}

/* ---- a bar chart -------------------------------------------------------- */

function barChart(host, labels, values, opts = {}) {
  host.innerHTML = '';
  if (!values.length || values.every(v => !v)) { host.innerHTML = '<div class="empty">Not enough history yet.</div>'; return; }
  const W = width(host), H = 160, M = { l: 34, r: 6, t: 8, b: 22 };
  const top = niceMax(Math.max(...values));
  const bw = (W - M.l - M.r) / values.length;
  const Y = v => H - M.b - v / top * (H - M.t - M.b);
  const root = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': opts.label || '' }, host);
  const grid = el('g', { class: 'grid' }, root);
  for (let i = 0; i <= 4; i++) {
    const v = top * i / 4;
    el('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v) }, grid);
    el('text', { x: M.l - 5, y: Y(v) + 3, 'text-anchor': 'end' }, root).textContent = fmt(v, top < 8 ? 1 : 0);
  }
  values.forEach((v, i) => {
    const r = el('rect', { x: M.l + i * bw + 1, y: Y(v), width: Math.max(1, bw - 2), height: H - M.b - Y(v),
                           fill: opts.color || '#3aa7ff', 'fill-opacity': .85, rx: 1 }, root);
    el('title', {}, r).textContent = `${labels[i]}: ${fmt(v, 1)}`;
    if (i % (opts.every || 1) === 0)
      el('text', { x: M.l + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle' }, root).textContent = opts.tick ? opts.tick(labels[i], i) : labels[i];
  });
}

/* ---- the up/down strips ------------------------------------------------- */

function uptimeStrips(host, names) {
  host.innerHTML = '';
  const rows = names.map(n => ({ n, pts: data.series[`rx:${n}:up`] || [] })).filter(r => r.pts.length);
  if (!rows.length) { host.innerHTML = '<div class="empty">No receiver history yet.</div>'; return; }
  const W = width(host), L = 84, RH = 16, GAP = 8, H = rows.length * (RH + GAP) + 18;
  const t1 = data.generated, t0 = windowStart(t1, rows.map(r => r.pts));
  const X = t => L + (t - t0) / (t1 - t0) * (W - L - 6);
  const bw = Math.max(1, data.bucket_s / (t1 - t0) * (W - L - 6));
  const root = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Receiver up or down over time' }, host);
  rows.forEach((r, i) => {
    const y = i * (RH + GAP) + 2;
    el('text', { x: 0, y: y + 12 }, root).textContent = r.n.length > 12 ? r.n.slice(0, 11) + '…' : r.n;
    el('rect', { x: L, y, width: W - L - 6, height: RH, fill: '#0b1116' }, root);
    for (const [ts, avg] of r.pts) {
      const c = avg >= 0.98 ? '#39ff6a' : avg > 0 ? '#ffb020' : '#ff3f5f';
      const b = el('rect', { x: X(ts) - bw / 2, y, width: bw + .4, height: RH, fill: c, 'fill-opacity': avg >= 0.98 ? .55 : .95 }, root);
      el('title', {}, b).textContent = `${stamp(ts)}: ${Math.round(avg * 100)}% up`;
    }
  });
  for (const [t, label] of timeTicks(t0, t1))
    el('text', { x: X(t), y: H - 3, 'text-anchor': 'middle' }, root).textContent = label;
}

/* ---- tables and tiles --------------------------------------------------- */

function tiles(s) {
  const t = (v, k) => `<div class="tile"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  $('tiles').innerHTML = s
    ? t(fmt(s.aircraft_now, 0), 'IN RANGE NOW') + t(fmt(s.aircraft_avg_24h), 'AVERAGE, 24H') +
      t(fmt(s.aircraft_peak_24h, 0), 'PEAK, 24H') + t(fmt(s.unique_today, 0), 'DISTINCT TODAY') +
      t(fmt(s.unique_7d, 0), 'DISTINCT, 7 DAYS') + t(fmt(s.unique_30d, 0), 'DISTINCT, 30 DAYS')
    : '';
}

function listTable(host, rows, head) {
  if (!rows.length) { host.innerHTML = '<div class="empty">Nothing recorded yet.</div>'; return; }
  const top = Math.max(...rows.map(r => r.n));
  host.innerHTML = `<table><tr><th>${head}</th><th></th><th class="n">AIRCRAFT</th></tr>` +
    rows.map(r => `<tr><td>${esc(r.label)}${r.sub ? ` <span class="sub">${esc(r.sub)}</span>` : ''}</td>` +
      `<td class="barcell"><span class="bar" style="width:${Math.round(r.n / top * 100)}%"></span></td>` +
      `<td class="n">${fmt(r.n, 0)}</td></tr>`).join('') + '</table>';
}

function receiverTable(s) {
  const host = $('tReceivers');
  if (!s.receivers.length) { host.innerHTML = '<div class="empty">No receiver history yet.</div>'; return; }
  host.innerHTML = '<table><tr><th>RECEIVER</th><th class="n">UPTIME</th><th class="n">AVG SEEN</th>' +
    '<th class="n">PEAK SEEN</th><th class="n">FARTHEST, 24H</th><th class="n">FARTHEST, EVER*</th></tr>' +
    s.receivers.map(r => {
      const cls = r.uptime_24h == null ? '' : r.uptime_24h >= 99 ? 'good' : r.uptime_24h >= 90 ? 'warn' : 'bad';
      return `<tr><td><span class="dot" style="background:${rxColor(r.name)}"></span>${esc(r.name)}</td>` +
        `<td class="n ${cls}">${r.uptime_24h == null ? '–' : r.uptime_24h.toFixed(1) + '%'}</td>` +
        `<td class="n">${fmt(r.aircraft_avg_24h)}</td><td class="n">${fmt(r.aircraft_peak_24h, 0)}</td>` +
        `<td class="n">${r.range_24h == null ? '–' : fmt(r.range_24h, 0) + ' nm'}</td>` +
        `<td class="n">${r.range_best == null ? '–' : fmt(r.range_best, 0) + ' nm'}</td></tr>`;
    }).join('') + '</table>';
}

function lookupTable(s) {
  const rows = s.health.lookups;
  $('tLookups').innerHTML = rows.length
    ? '<table><tr><th>SOURCE</th><th class="n">ANSWERED</th><th class="n">FAILED</th><th class="n">FAIL RATE</th></tr>' +
      rows.map(r => {
        const cls = r.fail_pct == null ? '' : r.fail_pct < 3 ? 'good' : r.fail_pct < 10 ? 'warn' : 'bad';
        return `<tr><td>${esc(r.source)}</td><td class="n">${fmt(r.ok, 0)}</td><td class="n">${fmt(r.fail, 0)}</td>` +
               `<td class="n ${cls}">${r.fail_pct == null ? '–' : r.fail_pct + '%'}</td></tr>`;
      }).join('') + '</table>' +
      `<p class="sub" style="margin:10px 0 0">A source answering "not found" counts as answered; only timeouts and server errors count as failures. Cache hit rate, 24h average: ${s.health.hit_pct_24h == null ? '–' : s.health.hit_pct_24h.toFixed(0) + '%'}.</p>`
    : '<div class="empty">No lookups recorded yet.</div>';

  const a = s.health.aeroapi;
  $('aeroCard').hidden = !(a && a.enabled);
  if (a && a.enabled) {
    const pct = a.cap ? Math.min(100, a.spent / a.cap * 100) : 0;
    const cls = a.state === 'ok' ? 'good' : a.state === 'budget' ? 'warn' : 'bad';
    $('tAero').innerHTML = `<table><tr><td>State</td><td class="n ${cls}">${esc(a.state)}${a.detail ? ' (' + esc(a.detail) + ')' : ''}</td></tr>` +
      `<tr><td>Spent in ${esc(a.month)}</td><td class="n">$${a.spent} of $${a.cap}</td></tr>` +
      `<tr><td>Lookups</td><td class="n">${fmt(a.calls, 0)}</td></tr></table>` +
      `<div style="height:8px;background:#0b1116;border-radius:2px;margin-top:12px"><div style="height:8px;width:${pct}%;background:${pct > 85 ? 'var(--pink)' : 'var(--green)'};border-radius:2px"></div></div>`;
  }
}

/* ---- putting it together ------------------------------------------------ */

function pts(name, which) {
  return (data.series[name] || []).map(p => [p[0], p[which]]);
}

function render() {
  const s = data.summary;
  const notice = $('notice');
  notice.hidden = true;
  if (!data.enabled) {
    notice.hidden = false;
    notice.textContent = 'Metrics are switched off. Set FLIGHTBOARD_METRICS=1 in flightboard.env and restart the backend to record them.';
    $('tiles').innerHTML = '';
    return;
  }
  if (data.error) {
    notice.hidden = false;
    notice.textContent = 'The backend could not write its history to disk (' + data.error + '). What it collected is held in memory and it will keep trying.';
  }
  if (!s) {
    notice.hidden = false;
    notice.textContent = 'Nothing recorded yet. The first samples are written about a minute and a half after the backend starts, then every ' + Math.round(data.flush_s / 60) + ' minutes.';
  }
  const names = s ? s.receivers.map(r => r.name) : [];
  const ordered = rxOrder.filter(n => names.includes(n)).concat(names.filter(n => !rxOrder.includes(n)));

  tiles(s);
  lineChart($('cAircraft'), [
    { label: 'average', color: '#eaf6ff', pts: pts('aircraft', 1) },
    ...(data.bucket_s > 60 ? [{ label: 'peak', color: '#3aa7ff', dim: true, pts: pts('aircraft', 2) }] : []),
  ], { area: true, label: 'Aircraft in range over time' });

  if (s) {
    const off = Math.round(-new Date().getTimezoneOffset() / 60);
    const hours = Array(24).fill(0);
    for (const [h, v] of s.by_hour_utc) hours[((h + off) % 24 + 24) % 24] = v;
    barChart($('cHours'), hours.map((_, i) => i.toString().padStart(2, '0') + ':00'), hours,
             { color: '#39ff6a', every: 3, tick: l => l.slice(0, 2), label: 'Average aircraft by hour of day' });
    barChart($('cDaily'), s.daily_unique.map(d => d[0]), s.daily_unique.map(d => d[1]),
             { color: '#3aa7ff', every: 2, tick: l => l.slice(5), label: 'Distinct aircraft per day' });
    listTable($('tAirlines'), s.top_airlines.map(a => ({ label: a[1], sub: a[1] !== a[0] ? a[0] : '', n: a[2] })), 'AIRLINE');
    listTable($('tTypes'), s.top_types.map(t => ({ label: t[0], n: t[1] })), 'TYPE');
    receiverTable(s);
    lookupTable(s);
  } else {
    for (const id of ['cHours', 'cDaily', 'tAirlines', 'tTypes', 'tReceivers', 'tLookups'])
      $(id).innerHTML = '<div class="empty">Nothing recorded yet.</div>';
  }

  uptimeStrips($('cUptime'), ordered);
  lineChart($('cRxAircraft'), ordered.map(n => ({ label: n, color: rxColor(n), pts: pts(`rx:${n}:aircraft`, 1) })), { label: 'Aircraft per receiver' });
  lineChart($('cRxRange'), ordered.map(n => ({ label: n, color: rxColor(n), pts: pts(`rx:${n}:maxnm`, 2) })), { unit: ' nm', digits: 0, label: 'Farthest aircraft per receiver' });
  lineChart($('cHit'), [{ label: 'hit rate', color: '#39ff6a', pts: pts('enrich:hit_pct', 1) }], { unit: '%', max: 100, digits: 0, label: 'Lookup cache hit rate' });
  const srcs = s ? s.health.lookups.map(l => l.source) : [];
  lineChart($('cFail'), srcs.map((n, i) => ({ label: n, color: ['#ff3f5f', '#ffb020', '#3aa7ff'][i % 3], pts: pts(`lookup:${n}:fail`, 1) })), { digits: 2, label: 'Failed lookups' });

  const ago = data.last_flush ? Math.round((data.generated - data.last_flush) / 60) : null;
  $('foot').innerHTML =
    'Sampled every minute and written to disk every ' + Math.round(data.flush_s / 60) + ' minutes' +
    (ago == null ? '' : ' (last write ' + (ago < 1 ? 'under a minute' : ago + ' min') + ' ago)') +
    (s && s.oldest ? '; history goes back to ' + new Date(s.oldest * 1000).toLocaleDateString() : '') +
    '. Charts lag by up to one write. Times are your local time; the day boundary for distinct-aircraft counts is UTC.<br>' +
    '* Range is limited to the distance you have configured the board to show, so it measures your receivers up to that distance, not their absolute reach.';
}

async function load() {
  try {
    const r = await fetch('/api/metrics?range=' + range, { cache: 'no-store' });
    data = await r.json();
  } catch (e) {
    const n = $('notice');
    n.hidden = false;
    n.textContent = 'Cannot reach the backend, so this page cannot update.';
    return;
  }
  render();
}

async function start() {
  for (const b of document.querySelectorAll('#ranges button')) {
    b.addEventListener('click', () => {
      range = b.dataset.range;
      location.hash = range;
      mark();
      load();
    });
  }
  mark();
  try {                    // receiver order comes from the config, as on the panel
    const d = await (await fetch('/api/aircraft', { cache: 'no-store' })).json();
    rxOrder = (d.sources || []).map(s => s.name);
  } catch (e) { /* alphabetical is fine */ }
  await load();
  setInterval(load, REFRESH_MS);
}
function mark() {
  for (const b of document.querySelectorAll('#ranges button'))
    b.setAttribute('aria-pressed', b.dataset.range === range ? 'true' : 'false');
}
let resizing = 0;
addEventListener('resize', () => {
  clearTimeout(resizing);
  resizing = setTimeout(() => { if (data) render(); }, 150);
});
start();
