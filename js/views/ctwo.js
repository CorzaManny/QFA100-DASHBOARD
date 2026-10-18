// CTWO+ Briefing: a simple briefing to help the crew identify key
// information, threats and actions before a Departure or an Arrival -
// Charts, Terrain, Weather, Operational, Threats. The points themselves are
// edited by an admin (see ctwoItems/saveCtwoItems in ops.js) and apply to
// every sector's briefing for that leg; what is ticked and marked complete
// is kept per sector, per leg.

import { state } from '../store.js';
import { esc, zulu, zdate, ago, icon, rerender } from '../ui.js';
import { CTWO_LEGS, CTWO_SECTIONS } from '../data/ctwo.js';
import {
  sortedSectors,
  upcomingSector,
  currentSector,
  crewLabel,
  canReport,
  isAdmin,
  ctwoItems,
  saveCtwoItems,
  ctwoOf,
  saveCtwoProgress,
  fetchMetar,
  fetchTafFor,
} from '../ops.js';

let busy = false;
let error = '';
let notice = '';
// "<leg>:<section>" of the item list currently open for editing, admin only.
let editing = '';

const sectionOf = (key) => CTWO_SECTIONS.find((sec) => sec.key === key);
const legOf = (key) => CTWO_LEGS.find((l) => l.key === key) || CTWO_LEGS[0];

// The sector in the address, otherwise the next one to depart - same choice
// the Briefing page makes.
function sectorFor(args) {
  const sectors = sortedSectors();
  return sectors.find((s) => s.id === args[0]) || upcomingSector() || currentSector() || sectors.at(-1) || null;
}

// #/ctwo/<sectorId>/<leg>/<section>
const argsFromHash = () => location.hash.replace(/^#\/ctwo\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);

const sectionStatus = (prog, key) => {
  const sec = prog[key];
  if (sec?.complete) return 'complete';
  if (sec?.checked && Object.values(sec.checked).some(Boolean)) return 'started';
  return 'not-started';
};
const STATUS_LABEL = { complete: 'COMPLETE', started: 'STARTED', 'not-started': 'NOT STARTED' };
const STATUS_BADGE = { complete: 'ok', started: 'info', 'not-started': 'mute' };

function sectorHead(s) {
  const sectors = sortedSectors();
  return `
    <section class="card">
      <h2>${esc(s.dep)} → ${esc(s.arr)}</h2>
      ${
        sectors.length > 1
          ? `<label class="field">Sector<select data-change="sector">
        ${sectors
          .map((x) => `<option value="${esc(x.id)}" ${x.id === s.id ? 'selected' : ''}>${esc(x.dep)} → ${esc(x.arr)} · ${zdate(x.std)} ${zulu(x.std)}</option>`)
          .join('')}</select></label>`
          : ''
      }
      <div class="kvs">
        <div class="kv"><span>Flight</span><strong>${esc(s.flight)}</strong></div>
        <div class="kv"><span>Departs</span><strong>${zdate(s.std)} ${zulu(s.std)}</strong></div>
        <div class="kv"><span>Arrives</span><strong>${zdate(s.sta)} ${zulu(s.sta)}</strong></div>
      </div>
      <p class="note"><strong>Crew:</strong> ${esc(crewLabel(s))}</p>
    </section>`;
}

// ---- Opening page: #/ctwo or #/ctwo/<sectorId> ----

function renderOpening(s) {
  return `
    <div class="page-head"><h1>CTWO+ Briefing</h1></div>
    <p class="note">A simple briefing to help identify key information, threats and actions. Go through Charts, Terrain, Weather, Operational and Threats for each leg.</p>
    ${sectorHead(s)}
    <div class="ctwo-legs">
      ${CTWO_LEGS.map((leg) => {
        const prog = ctwoOf(s.id, leg.key);
        const done = CTWO_SECTIONS.filter((sec) => prog[sec.key]?.complete).length;
        const status = done === CTWO_SECTIONS.length ? 'complete' : done ? 'started' : 'not-started';
        return `
        <a class="ctwo-leg-card" href="#/ctwo/${esc(s.id)}/${leg.key}">
          <span class="ctwo-leg-icon">${icon('plane', 'plane')}</span>
          <span class="ctwo-leg-main">
            <span class="ctwo-leg-t">${esc(leg.label)}</span>
            <span class="tiny">${esc(s[leg.airport])}</span>
          </span>
          <span class="badge ${STATUS_BADGE[status]}">${status === 'complete' ? 'COMPLETE' : `${done} / ${CTWO_SECTIONS.length}`}</span>
          ${icon('chevron')}
        </a>`;
      }).join('')}
    </div>`;
}

// ---- Section overview: #/ctwo/<sectorId>/<leg> ----

function renderOverview(s, legKey) {
  const leg = legOf(legKey);
  const prog = ctwoOf(s.id, legKey);
  const done = CTWO_SECTIONS.filter((sec) => prog[sec.key]?.complete).length;
  const allDone = done === CTWO_SECTIONS.length;

  const rows = CTWO_SECTIONS.map((sec) => {
    const status = sectionStatus(prog, sec.key);
    return `
    <a class="ctwo-row" href="#/ctwo/${esc(s.id)}/${legKey}/${sec.key}">
      <span class="ctwo-dot ctwo-${sec.key}">${status === 'complete' ? icon('check') : esc(sec.letter)}</span>
      <span class="ctwo-row-main">
        <span class="ctwo-row-t">${esc(sec.label)}</span>
        <span class="tiny">${esc(sec.help)}</span>
      </span>
      <span class="badge ${STATUS_BADGE[status]}">${STATUS_LABEL[status]}</span>
      ${icon('chevron')}
    </a>`;
  }).join('');

  if (allDone) {
    return `
      <div class="page-head"><h1>${esc(leg.label)}</h1></div>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      ${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}
      <section class="card ctwo-complete">
        <span class="ctwo-complete-icon">${icon('check')}</span>
        <h2>Briefing Complete</h2>
        <p class="note">All sections reviewed and discussed.</p>
        <div class="ctwo-sections">${rows}</div>
        <div class="btn-row">
          <button class="btn primary" data-act="save" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save briefing'} ${icon('check')}</button>
          <a class="btn ghost" href="#/brief/${esc(s.id)}">Back to Flight</a>
        </div>
      </section>`;
  }

  return `
    <div class="page-head"><h1>${esc(leg.label)}</h1></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    <section class="card ctwo-overview">
      <h2>${esc(leg.label)}</h2>
      <p class="note">Go through each section and discuss the key points.</p>
      <div class="ctwo-sections">${rows}</div>
      <button class="btn primary ctwo-start" data-act="start" data-leg="${legKey}">${done ? 'Continue briefing' : 'Start Briefing'} ${icon('chevron')}</button>
    </section>
    <p class="tiny center"><a href="#/ctwo/${esc(s.id)}">${esc(s.dep)} → ${esc(s.arr)}</a></p>`;
}

// ---- Weather embed, for the Weather section only ----

function metarBlock(code) {
  const m = state.metar[code];
  return m
    ? `<pre class="metar">${esc(m.text)}</pre><div class="tiny">${ago(m.at)} from VATSIM</div>`
    : '<p class="note">Loading METAR…</p>';
}

function tafBlock(code) {
  const t = state.taf[code];
  if (t?.text) {
    const text = t.text.replace(/\s+/g, ' ').replace(/ (FM\d|BECMG|TEMPO|INTER|PROB)/g, '\n  $1');
    return `<pre class="metar">${esc(text)}</pre><div class="tiny">${ago(t.at)} · forecast</div>`;
  }
  return '<p class="note">No TAF read yet.</p>';
}

function weatherEmbed(code) {
  return `
    <div class="ctwo-wx">
      <div class="ctwo-wx-head"><span class="apt">${esc(code)}</span></div>
      <div class="tiny">METAR</div>${metarBlock(code)}
      <div class="tiny">TAF</div>${tafBlock(code)}
    </div>`;
}

// ---- Section detail: #/ctwo/<sectorId>/<leg>/<section> ----

function templateEditor(legKey, sec) {
  const items = ctwoItems(legKey, sec.key);
  const key = `${legKey}:${sec.key}`;
  if (editing !== key) {
    return `<button class="btn ghost" data-act="editTemplate" data-leg="${legKey}" data-section="${sec.key}">Edit points (admin)</button>`;
  }
  return `
    <form class="card form ctwo-edit" data-form="saveTemplate" data-leg="${legKey}" data-section="${sec.key}">
      <h3>Edit ${esc(sec.label)} points</h3>
      <p class="note">One point per line. This changes every sector's ${esc(legOf(legKey).label.toLowerCase())} for the whole team.</p>
      <label class="field">Points<textarea name="items" rows="${Math.max(4, items.length + 1)}">${esc(items.join('\n'))}</textarea></label>
      <div class="btn-row">
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Save points</button>
        <button class="btn ghost" type="button" data-act="cancelEdit">Cancel</button>
      </div>
    </form>`;
}

function renderSection(s, legKey, sectionKey) {
  const leg = legOf(legKey);
  const sec = sectionOf(sectionKey);
  if (!sec) return renderOverview(s, legKey);
  const items = ctwoItems(legKey, sec.key);
  const prog = ctwoOf(s.id, legKey);
  const secProg = prog[sec.key] || { checked: {}, complete: false };
  const code = s[leg.airport];

  const rows = items
    .map(
      (text, i) => `
      <button class="cl-item ${secProg.checked?.[i] ? 'on' : ''}" data-act="toggleItem" data-leg="${legKey}" data-section="${sec.key}" data-i="${i}"
        aria-pressed="${!!secProg.checked?.[i]}" ${canReport() ? '' : 'disabled'}>
        <span class="cl-box">${secProg.checked?.[i] ? icon('check') : ''}</span>
        <span class="cl-ch">${esc(text)}</span>
      </button>`,
    )
    .join('');

  return `
    <div class="page-head"><h1>${esc(sec.label)}</h1></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}
    <section class="card ctwo-section">
      <div class="ctwo-section-head">
        <span class="ctwo-dot lg ctwo-${sec.key}">${esc(sec.letter)}</span>
        <div>
          <h2>${esc(sec.label)}</h2>
          <p class="tiny">${esc(sec.help)}</p>
        </div>
      </div>
      <div class="cl-items ctwo-items">${rows}</div>
      ${sec.key === 'weather' ? weatherEmbed(code) : ''}
      ${
        sec.key === 'charts' || sec.key === 'terrain'
          ? `<a class="row ctwo-link" href="#/airports/${esc(code)}">
              <div class="row-main"><div class="row-t">${sec.key === 'charts' ? `View ${esc(leg.label)} (${esc(code)})` : `${esc(code)} airport briefing`}</div>
              <div class="sub">${sec.key === 'charts' ? 'Runway, SID/STAR and airport charts' : 'MSA, obstacles, terrain'}</div></div>
              <div class="right">${icon('external')}</div>
            </a>`
          : ''
      }
      ${isAdmin() ? templateEditor(legKey, sec) : ''}
      <div class="btn-row">
        <a class="btn ghost" href="#/ctwo/${esc(s.id)}/${legKey}">Back</a>
        <button class="btn primary" data-act="complete" data-leg="${legKey}" data-section="${sec.key}" ${busy || !canReport() ? 'disabled' : ''}>Mark as Complete ${icon('check')}</button>
      </div>
    </section>`;
}

export function render(args) {
  const s = sectorFor(args);
  if (!s) return '<div class="page-head"><h1>CTWO+ Briefing</h1></div><p class="note">There are no sectors in the schedule yet.</p>';
  const [, legKey, sectionKey] = args;
  const out = !legKey
    ? renderOpening(s)
    : sectionKey
      ? renderSection(s, legKey, sectionKey)
      : renderOverview(s, legKey);
  error = '';
  notice = '';
  return out;
}

const stillHere = (s, legKey) => {
  const here = argsFromHash();
  return sectorFor(here)?.id === s.id && here[1] === legKey && here[2] === 'weather';
};

export function mounted(root, args) {
  const s = sectorFor(args);
  if (!s) return;
  const [, legKey, sectionKey] = args;
  if (sectionKey !== 'weather') return;
  const code = s[legOf(legKey).airport];
  if (!state.metar[code] || Date.now() - state.metar[code].at > 5 * 60000) {
    fetchMetar(code).catch(() => {}).finally(() => stillHere(s, legKey) && rerender());
  }
  if (!state.taf[code] || Date.now() - state.taf[code].at > 15 * 60000) {
    fetchTafFor(code).catch(() => {}).finally(() => stillHere(s, legKey) && rerender());
  }
}

async function run(work) {
  if (busy) return;
  busy = true;
  rerender();
  try {
    await work();
  } catch (err) {
    error = `Could not save: ${err.message}`;
  }
  busy = false;
  if (location.hash.startsWith('#/ctwo')) rerender();
}

export const changes = {
  sector(el) {
    location.hash = `#/ctwo/${encodeURIComponent(el.value)}`;
  },
};

export const forms = {
  saveTemplate(data, form) {
    const leg = form.dataset.leg;
    const section = form.dataset.section;
    const items = String(data.get('items') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!items.length) {
      error = 'Give at least one point.';
      return rerender();
    }
    return run(async () => {
      await saveCtwoItems(leg, section, items);
      editing = '';
      notice = 'Points saved for the whole team.';
    });
  },
};

export const actions = {
  start(el) {
    const s = sectorFor(argsFromHash());
    const leg = el.dataset.leg;
    const prog = ctwoOf(s.id, leg);
    const next = CTWO_SECTIONS.find((sec) => !prog[sec.key]?.complete) || CTWO_SECTIONS[0];
    location.hash = `#/ctwo/${encodeURIComponent(s.id)}/${leg}/${next.key}`;
  },
  toggleItem(el) {
    if (el.disabled) return;
    const s = sectorFor(argsFromHash());
    const { leg, section, i } = el.dataset;
    const prog = ctwoOf(s.id, leg);
    const current = prog[section] || { checked: {}, complete: false };
    const next = { ...prog, [section]: { ...current, checked: { ...current.checked, [i]: !current.checked?.[i] } } };
    run(() => saveCtwoProgress(s.id, leg, next));
  },
  complete(el) {
    const s = sectorFor(argsFromHash());
    const { leg, section } = el.dataset;
    const items = ctwoItems(leg, section);
    const checked = {};
    items.forEach((_, i) => (checked[i] = true));
    const prog = ctwoOf(s.id, leg);
    const next = { ...prog, [section]: { checked, complete: true } };
    run(async () => {
      await saveCtwoProgress(s.id, leg, next);
      location.hash = `#/ctwo/${encodeURIComponent(s.id)}/${leg}`;
    });
  },
  save() {
    notice = 'Briefing saved.';
    rerender();
  },
  editTemplate(el) {
    editing = `${el.dataset.leg}:${el.dataset.section}`;
    error = '';
    rerender();
  },
  cancelEdit() {
    editing = '';
    rerender();
  },
};
