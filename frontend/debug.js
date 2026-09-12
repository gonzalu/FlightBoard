/*
 * Debug overlay: two text bands, above and below the LED panel.
 *
 * The panel itself is a 128x64 grid of dots. That is a wonderful thing to look
 * at and a hopeless place to answer "why does it say that?", so the diagnostics
 * live outside it as plain selectable text - dense, copyable, and costing the
 * panel not one LED.
 *
 * Everything here is reported by the code that actually ran, never re-derived.
 * A second implementation of "which logo would this aircraft get" would drift
 * from the first one the week after it was written, and then quietly lie.
 *
 * Off by default. Turn it on with ?debug=1, with FLIGHTBOARD_DEBUG=1 in
 * flightboard.env, or by pressing d. Press c to copy the whole thing.
 */
const Debug = (() => {
  let on = false;
  let top = null, bottom = null;
  let flash = null, flashUntil = 0;
  let lastSeen = null, lastShown = 0;

  function mount() {
    if (top) return;
    top = document.createElement('pre');
    bottom = document.createElement('pre');
    top.className = bottom.className = 'dbg';
    document.body.insertBefore(top, document.getElementById('stage'));
    document.body.appendChild(bottom);
  }

  function pad(s, n) { return String(s == null ? '-' : s).padEnd(n); }
  function nn(v, s) { return v == null ? '-' : v + (s || ''); }

  /** "N453AA (adsbdb)" - the value and who supplied it. */
  /** "hit  41s old  asked vrs, adsbdb" - or just "cold", which says it all. */
  function cacheLine(m) {
    m = m || {};
    if (!m.state || m.state === 'cold' || m.state === 'queued') return pad(m.state || '-', 12);
    return `${pad(m.state, 12)} ${nn(m.age_s, 's')} old   asked ${(m.asked || []).join(', ') || '-'}`;
  }

  function field(info, src, name) {
    const v = info[name];
    if (!v) return null;
    return `${name} ${v}` + (src[name] ? ` (${src[name]})` : '');
  }

  function systemLines(d, shown) {
    if (!d) return ['waiting for the backend'];
    const g = d.debug || {};
    const db = g.local_db || {};
    const c = g.cache || {};
    const recv = (d.sources || []).map(s =>
      s.ok ? `${s.name} ok ${s.aircraft}`
           : `${s.name} FAILED ${String(s.error || '').split('\n')[0].slice(0, 110)}`
    ).join('   |   ') || 'none configured';

    const lines = [
      `build ${pad(d.build, 10)} poll ${nn(d.age_s, 's')} ago   home ${d.home.lat},${d.home.lon}` +
      `   range ${d.max_range_nm}nm   rotating ${shown} of ${(d.aircraft || []).length} in range` +
      `   (backend caps at ${nn(g.max_aircraft)})`,
      `receivers   ${recv}`,
      `enrich ${g.enrich_enabled ? 'on' : 'OFF'}   cache ${nn(c.entries)} ` +
      `(${nn(c.hits)} hit / ${nn(c.misses)} miss)   queued ${nn(c.queued)}   ` +
      `ttl ${nn(g.enrich_ttl_s, 's')} hit / ${nn(g.enrich_fail_ttl_s, 's')} miss`,
      db.present
        ? `local db    routes ${db.routes} · aircraft ${nn(db.aircraft)} · airports ${db.airports}` +
          ` · airlines ${db.airlines} · countries ${nn(db.code_blocks)}`
        : `local db    NOT BUILT - run tools/fetch_standing_data.py (online lookups only)`,
      `settings    ${nn(g.settings_from)}`,
    ];
    if (d.filters_error) lines.push(`FILTERS BROKEN  ${d.filters_error}`);
    if (d.last_error) lines.push(`last error  ${d.last_error}`);
    if (flash && Date.now() < flashUntil) lines.push(`>> ${flash}`);
    return lines;
  }

  function aircraftLines(ac, snap) {
    if (!ac) return ['no aircraft on screen'];
    const dbg = ac._debug || {};
    const info = ac.aircraft_info || {};
    const t = dbg.type || {}, r = dbg.route || {};
    const tsrc = t.src || {}, lines = [];

    lines.push(
      `${ac.hex.toUpperCase()}   ident ${ac.flight ? '"' + ac.flight + '"' : '(none transmitted)'}` +
      `   via ${nn(ac.source)}   ${ac.distance_nm}nm brg ${ac.bearing_deg}deg` +
      `   alt ${ac.on_ground ? 'ground' : nn(ac.alt_baro, 'ft')}` +
      `   gs ${ac.gs == null ? '-' : Math.round(ac.gs) + 'kt'}` +
      `   vr ${nn(ac.baro_rate, 'fpm')}   sq ${nn(ac.squawk)}` +
      `   page ${snap.page + 1}/${snap.pageCount}`);

    // airframe
    const got = ['registration', 'type', 'manufacturer', 'owner', 'operator_code']
      .map(n => field(info, tsrc, n)).filter(Boolean);
    lines.push(`airframe    ${cacheLine(t)}`);
    lines.push(got.length ? `            ${got.join('   ')}`
                          : `            nothing known about this airframe`);

    // route
    const rt = ac.route || {};
    const det = dbg.detour;
    lines.push(`route       ` +
               (dbg.route === null || dbg.route === undefined
                 ? 'not looked up - the aircraft transmits no ident'
                 : cacheLine(r)) +
               (rt.airline ? `   airline ${rt.airline}` : ''));
    if (rt.origin || rt.destination) {
      lines.push(`            ${nn(rt.origin)} > ${nn(rt.destination)}` +
                 (rt.progress != null ? `   ${Math.round(rt.progress * 100)}% flown` : '') +
                 (rt.eta_min != null ? `   eta ${rt.eta_min}min` : '') +
                 (rt.phase ? `   ${rt.phase}` : ''));
    }
    if (dbg.guard) {
      lines.push(`            guard ${dbg.guard}` + (det
        ? `   via ${det.via_nm}nm / direct ${det.direct_nm}nm = ${det.ratio}` : ''));
    }

    // logo - reported by drawLogo, not guessed at
    const L = snap.logo || {};
    lines.push(`logo        ` + (L.key
      ? `${L.key} from ${L.via}` +
        (L.alias ? ` (alias of ${L.alias})` : '') +
        `   drew ${L.how}`
      : `no key   drew ${nn(L.how)}   ` +
        (info.operator_code
          ? `(operator code ${info.operator_code}` +
            `${tsrc.operator_code ? ' from ' + tsrc.operator_code : ''} names no mark we ` +
            `hold - the lookups often put the aircraft TYPE in that field` +
            `${info.owner ? `, and "${info.owner}" is not in OPERATOR_LOGOS` : ''})`
          : info.owner
            ? `(no airline prefix in the ident, and "${info.owner}" is not in OPERATOR_LOGOS)`
            : `(no airline prefix in the ident, and no operator or owner to fall back on)`)));
    return lines;
  }

  /*
   * Copy without navigator.clipboard.
   *
   * That API exists only in a secure context. The board is served over plain
   * HTTP to the LAN - http://ollamator:8090, neither https nor localhost - so
   * on the machine you actually read the board from it is undefined and the
   * copy silently does nothing. execCommand is deprecated and works here,
   * which is the entire argument for using it.
   */
  function copyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);   // iOS wants the explicit range
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  return {
    get on() { return on; },
    set(v) {
      on = !!v;
      document.body.classList.toggle('debug', on);
      if (on) mount();
      if (top) top.style.display = bottom.style.display = on ? '' : 'none';
      if (typeof layoutCanvas === 'function') layoutCanvas();
    },
    update(data, ac, snap) {
      if (!on || !top) return;
      lastSeen = data; lastShown = snap.shown;
      top.textContent = systemLines(data, snap.shown).join('\n');
      bottom.textContent = aircraftLines(ac, snap).join('\n');
    },
    text() { return top ? top.textContent + '\n\n' + bottom.textContent : ''; },

    /** Copy both bands, and say so on screen: a silent copy is unprovable. */
    copy() {
      if (!top) return;
      const body = this.text();
      const done = ok => {
        flash = ok ? `copied ${body.length} characters`
                   : 'copy FAILED - select the text and use ctrl+c';
        flashUntil = Date.now() + 2500;
        top.textContent = systemLines(lastSeen, lastShown).join('\n');
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(body)
          .then(() => done(true), () => done(copyText(body)));
      } else {
        done(copyText(body));
      }
    },
  };
})();
