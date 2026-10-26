// Airport briefings: facts, live METAR, runways, team notes, chart links.

import { state, save } from '../store.js';
import { esc, ago, icao, icon, zulu, zdate, rerender } from '../ui.js';
import { airport, sortedSectors, upcomingSector, fetchMetar, fetchTafFor, fetchStations, fetchDocsFor } from '../ops.js';

// The airport whose team notes are open for editing. They read until then.
let editing = '';
// What the last read of the forecast did: loading, ok, none, off (the database
// has no weather.sql) or error.
let tafState = '';
let tafError = '';
// The same, for WorldFlight's airport documents; off means the database has no
// airport-docs.sql.
let docsState = '';
let docsError = '';

function list() {
  const next = upcomingSector();
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

// The forecast. tafState is what the last read did, so a missing TAF reads as
// "this airport does not publish one" rather than a silent blank.
function tafBlock(code) {
  const t = state.taf[code];
  if (t?.text) {
    // A TAF is published as one long line; the FM and BECMG groups are where
    // it changes, so each one starts a new line to make it readable.
    const text = t.text.replace(/\s+/g, ' ').replace(/ (FM\d|BECMG|TEMPO|INTER|PROB)/g, '\n  $1');
    return `<pre class="metar">${esc(text)}</pre><div class="tiny">Fetched ${ago(t.at)} · forecast</div>`;
  }
  if (tafState === 'loading') return '<p class="note">Loading TAF…</p>';
  if (tafState === 'off') {
    return `<p class="note">Forecasts are not switched on for this team yet. An admin runs <code>supabase/weather.sql</code> once, in Supabase.</p>`;
  }
  if (tafState === 'error') return `<p class="note warn">${icon('alert')} Could not read the forecast (${esc(tafError)}).</p>`;
  return `<p class="note">${esc(code)} does not publish a TAF.</p>`;
}

// WorldFlight's own documents for an airport: the pilot briefing written by
// the team controlling it, and whatever charts they publish alongside it.
// Shared with the sector Briefing page, so what the last read did is passed in
// rather than read from this module's own state.
const DOC_BADGE = { PDF: 'info', IMAGE: 'mute' };

export function docsBlock(code, status, errMessage = '') {
  const got = state.docs[code];
  const rows = (got?.list || [])
    .map((d) => {
      const sub = [d.scope, d.by && `uploaded by ${d.by}`, d.updated && `updated ${zdate(d.updated)}`]
        .filter(Boolean)
        .map((part) => esc(part))
        .join(' · ');
      return `<a class="row" href="${esc(d.url)}" target="_blank" rel="noopener">
        <div class="row-main">
          <div class="row-t">${esc(d.name)}</div>
          ${sub ? `<div class="sub">${sub}</div>` : ''}
        </div>
        <div class="right">${
          d.type ? `<span class="badge ${DOC_BADGE[d.type] || 'mute'}">${esc(d.type)}</span> ` : ''
        }${icon('external')}</div>
      </a>`;
    })
    .join('');
  if (rows) return `${rows}<div class="tiny">From the WorldFlight planning site · read ${ago(got.at)}</div>`;
  if (status === 'loading') return '<p class="note">Looking for WorldFlight’s documents…</p>';
  if (status === 'off') {
    return '<p class="note">WorldFlight’s airport documents are not switched on for this team yet. An admin runs <code>supabase/airport-docs.sql</code> once, in Supabase.</p>';
  }
  if (status === 'error') {
    return `<p class="note warn">${icon('alert')} Could not read WorldFlight’s documents (${esc(errMessage)}).</p>`;
  }
  return `<p class="note">WorldFlight has not published anything for ${esc(code)} yet. The controlling team usually puts their briefing up in the days before the event.</p>`;
}

// Who is working the airport on VATSIM, and the ATIS they are putting out.
function vatsimBlock(code) {
  const s = state.stations[code];
  if (!s) return '<p class="note">Checking VATSIM…</p>';
  if (!s.controllers.length && !s.atis.length) {
    return `<p class="note">Nobody is controlling ${esc(code)} on VATSIM right now.</p>
      <div class="tiny">Checked ${ago(s.at)} · an area controller signed on under a regional name is not counted</div>`;
  }
  const rows = s.controllers
    .map(
      (c) => `<div class="row"><div class="row-main">
          <div class="row-t">${esc(c.callsign)}</div>
          <div class="sub">${esc(c.name)}${c.since ? ` · on since ${zulu(new Date(c.since))}` : ''}</div>
        </div><div class="right"><span class="badge info">${esc(c.frequency)}</span></div></div>`,
    )
    .join('');
  const atis = s.atis
    .map(
      (a) => `<div class="atis">
        <div class="card-head"><div class="tiny">${esc(a.callsign)}${a.code ? ` · INFO ${esc(a.code)}` : ''}</div>
          <span class="badge info">${esc(a.frequency)}</span></div>
        ${a.text ? `<pre class="metar">${esc(a.text)}</pre>` : '<p class="note">No text published.</p>'}
      </div>`,
    )
    .join('');
  const how = (s.prefixes || []).map((p) => `${esc(p)}_`).join(' and ');
  return `${rows}${atis}<div class="tiny">Checked ${ago(s.at)}${how ? ` · callsigns starting ${how}` : ''}</div>`;
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
    <section class="card list">
      <div class="card-head"><div><h2>WorldFlight briefing</h2>
        <div class="tiny">Published by the team controlling ${esc(code)}</div></div>
        <button class="icon-btn" data-act="docs" aria-label="Refresh WorldFlight documents">${icon('refresh')}</button></div>
      <div id="wfdocs">${docsBlock(code, docsState, docsError)}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Weather</h2>
        <button class="icon-btn" data-act="metar" aria-label="Refresh weather">${icon('refresh')}</button></div>
      <div class="tiny">METAR</div>
      <div id="metar">${metarBlock(code)}</div>
      <div class="tiny">TAF</div>
      <div id="taf">${tafBlock(code)}</div>
    </section>
    <section class="card list">
      <div class="card-head"><h2>On VATSIM</h2>
        <button class="icon-btn" data-act="stations" aria-label="Refresh VATSIM stations">${icon('refresh')}</button></div>
      <div id="stations">${vatsimBlock(code)}</div>
    </section>
    <section class="card"><h2>Runways</h2>${runways}</section>
    ${
      editing === code
        ? `<form class="card form" data-form="notes">
            <h2>Team notes</h2>
            <label class="field">Scenery issues, taxi routing, local procedures, gotchas
              <textarea name="notes" rows="6" placeholder="e.g. Default scenery has no gates on the international apron. Expect the RNP approach to 16R.">${esc(state.notes[code] || '')}</textarea></label>
            <div class="btn-row"><button class="btn primary" type="submit">Save notes</button>
              <button class="btn ghost" type="button" data-act="edit" data-code="">Cancel</button></div>
          </form>`
        : `<section class="card">
            <div class="card-head"><h2>Team notes</h2>
              <button class="btn ghost" data-act="edit" data-code="${esc(code)}">${state.notes[code] ? 'Edit' : 'Add'}</button></div>
            ${state.notes[code] ? `<p class="mel-text">${esc(state.notes[code])}</p>` : '<p class="note">No notes for this airport yet.</p>'}
          </section>`
    }`;
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

async function loadTaf(root, code) {
  const box = root.querySelector('#taf');
  tafState = 'loading';
  tafError = '';
  if (box?.isConnected) box.innerHTML = tafBlock(code);
  try {
    const got = await fetchTafFor(code);
    tafState = got == null ? 'off' : got.text ? 'ok' : 'none';
  } catch (err) {
    tafState = 'error';
    tafError = err.message;
  }
  if (currentCode() === code && box?.isConnected) box.innerHTML = tafBlock(code);
}

async function loadDocs(root, code, force = false) {
  const box = root.querySelector('#wfdocs');
  docsState = 'loading';
  docsError = '';
  if (box?.isConnected) box.innerHTML = docsBlock(code, docsState, docsError);
  try {
    const got = await fetchDocsFor(code, force);
    docsState = got == null ? 'off' : got.list.length ? 'ok' : 'none';
  } catch (err) {
    docsState = 'error';
    docsError = err.message;
  }
  if (currentCode() === code && box?.isConnected) box.innerHTML = docsBlock(code, docsState, docsError);
}

async function loadStations(root, code) {
  const box = root.querySelector('#stations');
  try {
    await fetchStations(code);
  } catch (err) {
    if (currentCode() !== code || !box?.isConnected) return;
    box.innerHTML = `<p class="note warn">${icon('alert')} Could not read VATSIM (${esc(err.message)}).</p>`;
    return;
  }
  if (currentCode() === code && box?.isConnected) box.innerHTML = vatsimBlock(code);
}

export function mounted(root, args) {
  const code = icao(args[0]);
  if (code.length !== 4) return;
  const cached = state.metar[code];
  if (!cached || Date.now() - cached.at > 5 * 60000) loadMetar(root, code);
  const taf = state.taf[code];
  tafState = taf?.text ? 'ok' : '';
  if (!taf || Date.now() - taf.at > 15 * 60000) loadTaf(root, code);
  const st = state.stations[code];
  if (!st || Date.now() - st.at > 60000) loadStations(root, code);
  // Documents are uploaded over days, not minutes, so the list is only reread
  // after two hours - the same window the database itself keeps one for.
  const docs = state.docs[code];
  docsState = docs ? (docs.list.length ? 'ok' : 'none') : '';
  if (!docs || Date.now() - docs.at > 2 * 3600000) loadDocs(root, code);
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
    editing = '';
    rerender();
  },
};

export const actions = {
  edit(el) {
    editing = el.dataset.code;
    rerender();
  },
  metar(el) {
    const root = el.closest('main');
    loadMetar(root, currentCode());
    loadTaf(root, currentCode());
  },
  stations(el) {
    loadStations(el.closest('main'), currentCode());
  },
  docs(el) {
    loadDocs(el.closest('main'), currentCode(), true);
  },
};
