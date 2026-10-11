// Airport briefings: facts, live METAR, runways, team notes, chart links.

import { state, save } from '../store.js';
import { esc, ago, icao, icon } from '../ui.js';
import { airport, sortedSectors, nextSector, fetchMetar } from '../ops.js';

function list() {
  const next = nextSector(Date.now(), !!state.profile.name.trim()) || nextSector();
  const codes = [...new Set(sortedSectors().flatMap((s) => [s.dep, s.arr]))];
  const rows = codes
    .map((code) => {
      const a = airport(code);
      const tag =
        next?.dep === code
          ? '<span class="badge warn">NEXT DEP</span>'
          : next?.arr === code
            ? '<span class="badge info">NEXT ARR</span>'
            : '';
      return `<a class="row" href="#/airports/${esc(code)}">
        <div class="row-main">
          <div class="row-t">${esc(code)} ${tag}</div>
          <div class="sub">${esc(a ? `${a.name}, ${a.country}` : 'Not in airport database')}</div>
        </div>
        <div class="right">${state.notes[code] ? '<span class="badge mute">NOTES</span>' : ''} ${icon('chevron')}</div>
      </a>`;
    })
    .join('');
  return `
    <div class="page-head"><h1>Airport Briefings</h1></div>
    <form class="card form inline" data-form="lookup">
      <label class="field">Look up any airport<input name="code" required maxlength="4" autocapitalize="characters" placeholder="ICAO, e.g. NZQN"></label>
      <button class="btn primary" type="submit">Open</button>
    </form>
    <section class="card list">
      <div class="card-head"><div class="tiny">AIRPORTS ON YOUR SCHEDULE</div></div>
      ${rows || '<p class="note">Add sectors to the schedule to see their airports here.</p>'}
    </section>`;
}

function metarBlock(code) {
  const m = state.metar[code];
  return m
    ? `<pre class="metar">${esc(m.text)}</pre><div class="tiny">Fetched ${ago(m.at)} from VATSIM</div>`
    : '<p class="note">Loading METAR…</p>';
}

function detail(code) {
  const a = airport(code);
  const runways = a?.runways.length
    ? `<table class="table"><thead><tr><th>Runway</th><th>Length</th><th>Surface</th></tr></thead><tbody>${a.runways
        .map((r) => {
          const [ends, len, surface] = r.split(' ');
          const ft = Number(len);
          return `<tr><td>${esc(ends)}</td><td>${ft ? `${Math.round(ft * 0.3048)} m / ${ft} ft` : '—'}</td><td>${esc(surface || '—')}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '<p class="note">No runway data.</p>';
  return `
    <div class="page-head"><a class="back" href="#/airports">${icon('back')} Briefings</a></div>
    <section class="card">
      <div class="card-head"><div><div class="apt">${esc(code)}</div>
        <div class="sub">${esc(a ? `${a.name} · ${a.city}, ${a.country}` : 'Not in airport database')}</div></div>
        ${a ? `<span class="badge info">ELEV ${a.elev} FT</span>` : ''}</div>
      <div class="btn-row">
        <a class="btn ghost" href="https://charts.navigraph.com/airport/${esc(code)}" target="_blank" rel="noopener">Navigraph Charts ${icon('external')}</a>
        <a class="btn ghost" href="https://chartfox.org/${esc(code)}" target="_blank" rel="noopener">ChartFox ${icon('external')}</a>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Weather</h2>
        <button class="icon-btn" data-act="metar" aria-label="Refresh METAR">${icon('refresh')}</button></div>
      <div id="metar">${metarBlock(code)}</div>
    </section>
    <section class="card"><h2>Runways</h2>${runways}</section>
    <form class="card form" data-form="notes">
      <h2>Team notes</h2>
      <label class="field">Scenery issues, taxi routing, local procedures, gotchas
        <textarea name="notes" rows="6" placeholder="e.g. Default scenery has no gates on the international apron. Expect the RNP approach to 16R.">${esc(state.notes[code] || '')}</textarea></label>
      <div class="btn-row"><button class="btn primary" type="submit">Save notes</button><span class="saved tiny" hidden>Saved</span></div>
    </form>`;
}

export function render(args) {
  const code = icao(args[0]);
  return code.length === 4 ? detail(code) : list();
}

const currentCode = () => icao(decodeURIComponent(location.hash.split('/')[2] || ''));

async function loadMetar(root, code) {
  const box = root.querySelector('#metar');
  try {
    await fetchMetar(code);
  } catch (err) {
    if (currentCode() !== code || !box.isConnected) return;
    const cached = state.metar[code];
    box.innerHTML = `${cached ? metarBlock(code) : ''}<p class="note warn">Could not update METAR (${esc(err.message)}).</p>`;
    return;
  }
  if (currentCode() === code && box.isConnected) box.innerHTML = metarBlock(code);
}

export function mounted(root, args) {
  const code = icao(args[0]);
  if (code.length !== 4) return;
  const cached = state.metar[code];
  if (!cached || Date.now() - cached.at > 5 * 60000) loadMetar(root, code);
}

export const forms = {
  lookup(data) {
    const code = icao(data.get('code'));
    if (code.length === 4) location.hash = `#/airports/${code}`;
  },
  notes(data, formEl) {
    const code = currentCode();
    const text = String(data.get('notes')).trim();
    if (text) state.notes[code] = text;
    else delete state.notes[code];
    save();
    formEl.querySelector('.saved').hidden = false;
  },
};

export const actions = {
  metar(el) {
    loadMetar(el.closest('main'), currentCode());
  },
};
