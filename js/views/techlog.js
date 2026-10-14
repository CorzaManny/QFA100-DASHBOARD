// Aircraft technical log, shared by the team, with the MEL built in: pick the
// system and item that failed to see whether the aircraft can go with it.
// Defects stay with the aircraft and carry over between sectors.

import { state, save, uid } from '../store.js';
import { saveDefect, deleteDefect } from '../api.js';
import { esc, zulu, zdate, icon, rerender } from '../ui.js';
import { currentSector, sortedSectors, me, sharedLog, syncTeam, canEdit, canLog, isEfb, crewOf, rosterable, person, teamCallsign, teamAircraft } from '../ops.js';
import {
  loadMel,
  melReady,
  melSource,
  chapters,
  chapterLabel,
  chapterByLabel,
  melEntry,
  melItems,
  melOptions,
  melTop,
  melPath,
  melNotes,
  melProcedures,
  PROCEDURES,
  searchMel,
  optionLabel,
  CATEGORIES,
  dueFor,
} from '../mel.js';

// Things that can break but are not in the MEL's chapters.
const OTHER_SYSTEMS = ['Simulator / Add-on', 'Other'];
const STATUS = { OPEN: 'bad', DEFERRED: 'warn', RECTIFIED: 'ok' };
const TABS = [
  ['OPEN', 'Open'],
  ['DEFERRED', 'Deferred'],
  ['RECTIFIED', 'Rectified'],
];
const TAB_EMPTY = {
  OPEN: 'Nothing open.',
  DEFERRED: 'Nothing deferred.',
  RECTIFIED: 'Nothing has been rectified yet.',
};
const ORDER = { OPEN: 0, DEFERRED: 1, RECTIFIED: 2 };

let draft = null; // the form as typed so far, kept while the MEL drop-downs redraw it: { key, values }
let look = { system: '', melTop: '', melItem: '' }; // the MEL lookup page's selection
let error = '';
let busy = false;
let tab = 'OPEN'; // which status the list is showing

const opt = (v, sel, label = v) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`;
const currentId = () => decodeURIComponent(location.hash.split('/')[2] || '');

// ---- MEL ----

// The item and option drop-downs for the chosen system, then the verdict.
function melPicker(sel) {
  const chapter = chapterByLabel(sel.system);
  if (!sel.system) return '';
  if (!chapter) {
    return OTHER_SYSTEMS.includes(sel.system)
      ? '<p class="note">Not an aircraft system, so the MEL does not apply. The team decides whether to fly with it.</p>'
      : '';
  }
  if (!melReady()) return '<p class="note">Loading the MEL…</p>';
  const options = melOptions(sel.melTop);
  return `
    <label class="field">MEL item<select name="melTop" data-change="melTop">
      ${opt('', sel.melTop, 'Not in the MEL / not checked')}
      ${melItems(chapter.ata)
        .map((t) => opt(t.id, sel.melTop, `${t.id} · ${t.title}`))
        .join('')}</select></label>
    ${
      options.length > 1
        ? `<label class="field">Which applies<select name="melItem" data-change="melItem">
            ${opt('', sel.melItem, `Select one of ${options.length}…`)}
            ${options.map((e) => opt(e.id, sel.melItem, optionLabel(e))).join('')}</select></label>`
        : `<input type="hidden" name="melItem" value="${esc(sel.melItem)}">`
    }
    ${verdict(sel, chapter)}`;
}

const count = (n) => (n === '-' ? 'varies' : n);

function verdict(sel, chapter) {
  if (!sel.melTop) {
    return `
      <div class="mel bad">
        <div class="card-head"><strong>Not in the MEL</strong><span class="badge bad">NO GO</span></div>
        <p class="note">If the failed ${esc(chapter.title.toLowerCase())} equipment is not listed above, the MEL gives no relief: it has to work before departure. Passenger comfort items that do not affect safety are the exception.</p>
      </div>`;
  }
  const e = melEntry(sel.melItem);
  if (!e) return '<p class="note">Choose which one applies to see the conditions.</p>';
  const conditional = e.rem || e.m || e.o;
  const cat = CATEGORIES[e.cat];
  return `
    <div class="mel ${conditional ? 'warn' : 'ok'}">
      <div class="card-head"><strong>MEL ${esc(e.id)}</strong>
        <span class="badge ${conditional ? 'warn' : 'ok'}">${conditional ? 'GO IF CONDITIONS MET' : 'GO'}</span></div>
      <div class="sub">${melPath(e.id).map(esc).join(' › ')}</div>
      <div class="chips">
        <span class="badge mute">CAT ${esc(e.cat)}</span>
        <span class="badge mute">INSTALLED ${esc(count(e.inst))}</span>
        <span class="badge mute">REQUIRED ${esc(count(e.req))}</span>
        ${e.m ? '<span class="badge info">(M) MAINTENANCE PROCEDURE</span>' : ''}
        ${e.o ? '<span class="badge info">(O) CREW PROCEDURE</span>' : ''}
      </div>
      <p class="mel-text">${e.rem ? esc(e.rem) : 'May be inoperative. No conditions listed.'}</p>
      ${melNotes(e.id).map((note) => `<p class="mel-text sub">${esc(note)}</p>`).join('')}
      ${cat ? `<p class="tiny">${cat.text}.</p>` : ''}
      ${procedures(e)}
    </div>`;
}

// The (O) and (M) procedures, folded away until wanted.
function procedures(e) {
  const found = melProcedures(e.id);
  if (!found) {
    return e.m || e.o ? '<p class="tiny">The MEL calls for a procedure here, but does not print one for this item.</p>' : '';
  }
  return `
    ${found.from !== e.id ? `<p class="tiny">Procedures are listed under MEL ${esc(found.from)}.</p>` : ''}
    ${found.sections
      .map(([kind, text]) => `<details class="mel-proc"><summary>${PROCEDURES[kind] || 'Notes'}</summary>${procedureText(text)}</details>`)
      .join('')}`;
}

// Procedure text: one paragraph or step per line; lines with " | " are table rows.
function procedureText(text) {
  const out = [];
  let rows = [];
  const flush = () => {
    if (rows.length) out.push(`<div class="mel-scroll"><table class="mel-table">${rows.join('')}</table></div>`);
    rows = [];
  };
  for (const line of text.split('\n')) {
    if (line.includes(' | ')) {
      rows.push(`<tr>${line.split(' | ').map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`);
    } else {
      flush();
      const step = /^(\d{1,2}[.)]|[A-Za-z][.)])\s/.test(line);
      const loud = /^(NOTE|CAUTION|WARNING)\b/.test(line);
      out.push(`<p class="${step ? 'step' : loud ? 'loud' : ''}">${esc(line)}</p>`);
    }
  }
  flush();
  return out.join('');
}

// A search box that fills in the drop-downs. The results are drawn as you type (see mounted).
const searchBox = () => `
  <label class="field">Search the MEL<input id="mel-search" type="search" autocomplete="off" autocapitalize="none" placeholder="e.g. radar, APU, pack, 34-15"></label>
  <div id="mel-results" class="list"></div>`;

function searchResults(query) {
  const found = searchMel(query);
  if (query.trim().length < 2) return '';
  if (!found.length) return '<p class="note">Nothing in the MEL matches that. Try another word, or pick the system below.</p>';
  return found
    .map((e) => {
      const path = melPath(e.id);
      return `
      <button type="button" class="row" data-act="pick" data-id="${esc(e.id)}">
        <div class="row-main">
          <div class="row-t">${esc(e.id)} · ${esc(path[0] || '')}</div>
          ${path.length > 1 ? `<div class="sub">${path.slice(1).map(esc).join(' › ')}</div>` : ''}
        </div>
        <span class="badge mute">CAT ${esc(e.cat)}</span>
      </button>`;
    })
    .join('');
}

const sourceNote = () =>
  `<p class="tiny center">${esc(melSource() || 'Boeing 737-800 MEL. For flight simulation only.')}</p>`;

function lookup() {
  return `
    <div class="page-head"><a class="back" href="#/techlog">${icon('back')} Tech Log</a></div>
    <section class="card form">
      <h2>MEL lookup</h2>
      <p class="note">Check whether the aircraft can go with something inoperative, without adding it to the tech log.</p>
      ${searchBox()}
      <label class="field">System<select name="system" data-change="system">
        <option value="">Select…</option>${chapters()
          .map((c) => opt(chapterLabel(c), look.system))
          .join('')}</select></label>
      ${melReady() ? melPicker(look) : '<p class="note">Loading the MEL…</p>'}
    </section>
    ${sourceNote()}`;
}

// ---- Log ----

function waiting() {
  const n = state.localDefects.length;
  if (!sharedLog() || !n) return '';
  return `
    <section class="card">
      <h2>${n} ${n === 1 ? 'entry' : 'entries'} saved on this device only</h2>
      <p class="note">These were written before the tech log was shared. Upload them so the whole team sees them, or discard them.</p>
      <div class="btn-row">
        <button class="btn primary" data-act="upload" ${busy ? 'disabled' : ''}>${busy ? 'Uploading…' : 'Upload to the team log'}</button>
        <button class="btn ghost" data-act="discard">Discard</button>
      </div>
    </section>`;
}

function list() {
  const defects = [...state.defects].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.at - a.at);
  const active = defects.filter((d) => d.status !== 'RECTIFIED').length;
  const count = (status) => defects.filter((d) => d.status === status).length;
  // Land on whichever tab has something in it, so the page is never empty
  // for no reason.
  if (!count(tab)) tab = ['OPEN', 'DEFERRED', 'RECTIFIED'].find(count) || 'OPEN';
  const rows = defects
    .filter((d) => d.status === tab)
    .map((d) => {
      const deferred = d.status === 'DEFERRED';
      const overdue = deferred && d.due && d.due < Date.now();
      return `
      <a class="row ${d.status === 'RECTIFIED' ? 'past' : ''}" href="#/techlog/${esc(d.id)}">
        <div class="row-main">
          <div class="row-t">${esc(d.ref)} · ${esc(d.desc)}</div>
          <div class="sub">${esc(d.system)} · ${zdate(d.at)} ${zulu(d.at)}${d.sector ? ` · ${esc(d.sector)}` : ''}${
            d.by ? ` · ${esc(d.by)}` : ''
          }</div>
          ${d.melItem ? `<div class="sub">MEL ${esc(d.melItem)}${deferred && d.due ? ` · fix by ${zdate(d.due)}` : ''}</div>` : ''}
          ${deferred && d.restriction ? `<div class="sub">Restriction: ${esc(d.restriction)}</div>` : ''}
        </div>
        <div class="right stack">
          <span class="badge ${STATUS[d.status]}">${d.status}</span>
          ${d.aog && d.status !== 'RECTIFIED' ? '<span class="badge bad">AOG</span>' : ''}
          ${overdue ? '<span class="badge bad">OVERDUE</span>' : deferred && d.mel ? `<span class="badge mute">CAT ${esc(d.mel)}</span>` : ''}
        </div>
      </a>`;
    })
    .join('');
  const out = `
    <div class="page-head"><h1>Tech Log</h1>
      <div class="btn-row"><a class="btn ghost" href="#/techlog/mel">MEL</a>
      ${canLog() ? `<a class="btn primary" href="#/techlog/new">${icon('plus')} Report defect</a>` : ''}</div></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${waiting()}
    <nav class="seg tabs4" aria-label="Tech log">
      ${TABS.map(
        ([status, label]) =>
          `<button type="button" class="${tab === status ? 'on' : ''}" data-act="tab" data-tab="${status}">${label}${
            count(status) ? ` (${count(status)})` : ''
          }</button>`,
      ).join('')}
    </nav>
    <section class="card list">
      <div class="card-head"><div class="tiny">${esc(teamCallsign())} · ${esc(teamAircraft())}</div>
        <span class="badge ${active ? 'warn' : 'ok'}">${active ? `${active} ACTIVE` : 'SERVICEABLE'}</span></div>
      ${rows || `<p class="note">${TAB_EMPTY[tab]}${canLog() && tab === 'OPEN' ? ' Report anything that breaks or is not modelled.' : ''}</p>`}
    </section>
    <p class="tiny center">${
      sharedLog() ? 'Shared with the whole team.' : 'Saved on this device only.'
    } ${canLog() ? '' : 'Entries are made on the flight deck tablet. '}Deferrals follow the 737 MEL - FOR FLIGHT SIMULATION ONLY.</p>`;
  error = '';
  return out;
}

// The "Reported by" field. On a shared log it is a list of the team, so a
// cockpit tablet can name whoever found the defect.
function reportedBy(value) {
  const names = rosterable().map((p) => p.display_name);
  if (!names.length) return `<label class="field">Reported by<input name="by" value="${esc(value)}"></label>`;
  if (value && !names.includes(value)) names.unshift(value);
  return `<label class="field">Reported by<select name="by">
    ${opt('', value, 'Nobody named')}${names.map((n) => opt(n, value)).join('')}</select></label>`;
}

function form(id) {
  const existing = state.defects.find((d) => d.id === id);
  if (id !== 'new' && !existing) return `<p class="note">Defect not found.</p><a class="btn ghost" href="#/techlog">Back</a>`;
  const cur = currentSector();
  // A tablet is not a person, so it offers the crew flying now instead.
  const onBoard = cur ? crewOf(cur).map((c) => person(c.user_id)?.display_name).filter(Boolean) : [];
  const mine = isEfb() ? onBoard[0] || '' : me()?.display_name || '';
  const base = existing
    ? { ...existing, melTop: melTop(existing.melItem) }
    : {
        system: '',
        desc: '',
        by: mine,
        sector: cur ? `${cur.dep}-${cur.arr}` : '',
        status: 'OPEN',
        melTop: '',
        melItem: '',
        restriction: '',
        action: '',
        aog: false,
      };
  const d = draft?.key === id ? { ...base, ...draft.values } : base;
  // The schedule's sectors, in order. An entry may name one that has since changed.
  const sectors = sortedSectors().map((x) => [`${x.dep}-${x.arr}`, `${x.dep} → ${x.arr} · ${zdate(x.std)}`]);
  if (d.sector && !sectors.some(([v]) => v === d.sector)) sectors.push([d.sector, d.sector]);
  const systems = [...chapters().map(chapterLabel), ...OTHER_SYSTEMS];
  // An entry written before the MEL was added may name a system that is no longer offered.
  if (d.system && !systems.includes(d.system)) systems.push(d.system);
  const history = existing ? state.history.filter((h) => h.defect_id === existing.id) : [];
  const out = `
    <div class="page-head"><a class="back" href="#/techlog">${icon('back')} Tech Log</a></div>
    ${
      existing && existing.status !== 'RECTIFIED' && canLog()
        ? `<form class="card form" data-form="rectify">
            <div class="card-head"><h2>${esc(existing.ref)} fixed?</h2><span class="badge ${STATUS[existing.status]}">${existing.status}</span></div>
            <label class="field">What fixed it<input name="action" required placeholder="e.g. Sim restarted, radar tested OK"></label>
            <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Mark rectified</button>
          </form>`
        : ''
    }
    <form class="card form" data-form="defect">
      <h2>${existing ? esc(existing.ref) : 'Report a defect'}</h2>
      ${canLog() ? '' : `<p class="note">${icon('alert')} The tech log is kept on the flight deck tablet. Tell the crew what you found and they will enter it. You can read everything here.</p>`}
      <fieldset ${canLog() ? '' : 'disabled'}>
      <label class="field">Defect description<textarea name="desc" rows="3" required placeholder="e.g. Weather radar not displaying returns">${esc(d.desc)}</textarea></label>
      <div class="grid2">
        ${reportedBy(d.by)}
        <label class="field">Sector<select name="sector">
          ${opt('', d.sector, 'Not on a sector')}${sectors.map(([v, label]) => opt(v, d.sector, label)).join('')}</select></label>
      </div>
      ${searchBox()}
      <label class="field">System<select name="system" required data-change="system">
        <option value="">Select…</option>${systems.map((s) => opt(s, d.system)).join('')}</select></label>
      ${melPicker(d)}
      <label class="field">Status<select name="status">
        ${opt('OPEN', d.status, 'Open')}${opt('DEFERRED', d.status, 'Deferred (flying with it)')}${opt('RECTIFIED', d.status, 'Rectified')}</select></label>
      <label class="field">Operational restriction<input name="restriction" value="${esc(d.restriction)}" placeholder="e.g. Stay at or below FL250"></label>
      <label class="field">Rectification action<textarea name="action" rows="2" placeholder="What fixed it, or why it was deferred">${esc(d.action)}</textarea></label>
      <label class="check"><input type="checkbox" name="aog" ${d.aog ? 'checked' : ''}> Aircraft unserviceable until fixed (AOG)</label>
      </fieldset>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      ${
        canLog()
          ? `<div class="btn-row">
              <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : existing ? 'Save changes' : 'Add to tech log'}</button>
              ${existing && (canEdit() || !sharedLog()) ? '<button class="btn danger" type="button" data-act="remove">Delete</button>' : ''}
            </div>`
          : ''
      }
    </form>
    ${
      history.length
        ? `<section class="card list">
            <div class="card-head"><div class="tiny">HISTORY</div></div>
            ${history
              .map(
                (h) => `
              <div class="row"><div class="row-main">
                <div class="row-t">${esc(h.event)}${h.by_name ? ` · ${esc(h.by_name)}` : ''}</div>
                <div class="sub">${zdate(h.at)} ${zulu(h.at)}${h.detail ? ` · ${esc(h.detail)}` : ''}</div>
              </div></div>`,
              )
              .join('')}
          </section>`
        : ''
    }
    ${sourceNote()}`;
  error = '';
  return out;
}

export function render(args) {
  if (draft && draft.key !== args[0]) draft = null;
  if (args[0] === 'mel') return lookup();
  return args[0] ? form(args[0]) : list();
}

export function mounted(root) {
  if (!melReady()) loadMel().then(() => location.hash.startsWith('#/techlog') && melReady() && rerender());
  const box = root.querySelector('#mel-search');
  if (!box) return;
  box.addEventListener('input', () => {
    root.querySelector('#mel-results').innerHTML = searchResults(box.value);
  });
  // Enter in the search box must not submit the defect form around it.
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
}

// Everything the form holds, as plain values.
function read(data) {
  const text = (k) => String(data.get(k) ?? '').trim();
  return {
    system: text('system'),
    desc: text('desc'),
    by: text('by'),
    sector: text('sector').toUpperCase(),
    status: text('status'),
    melTop: text('melTop'),
    melItem: text('melItem'),
    restriction: text('restriction'),
    action: text('action'),
    aog: data.get('aog') === 'on',
  };
}

// The selection a drop-down belongs to: the lookup page's, or the form's
// (remembering what has been typed, since choosing redraws the page).
function selection(el) {
  if (currentId() === 'mel') return look;
  draft = { key: currentId(), values: read(new FormData(el.form)) };
  return draft.values;
}

export const changes = {
  system(el) {
    Object.assign(selection(el), { system: el.value, melTop: '', melItem: '' });
    rerender();
  },
  melTop(el) {
    const options = melOptions(el.value);
    Object.assign(selection(el), { melTop: el.value, melItem: options.length === 1 ? options[0].id : '' });
    rerender();
  },
  melItem(el) {
    selection(el).melItem = el.value;
    rerender();
  },
};

async function send(work) {
  busy = true;
  rerender();
  try {
    await work();
    await syncTeam();
    busy = false;
    return true;
  } catch (err) {
    busy = false;
    error = `Could not save: ${err.message}`;
    rerender();
    return false;
  }
}

export const forms = {
  async defect(data) {
    if (busy) return;
    const id = currentId();
    const existing = state.defects.find((x) => x.id === id);
    const { melTop: top, ...fields } = read(data);
    const entry = top ? melEntry(fields.melItem) : null;
    if (top && !entry) {
      draft = { key: id, values: { ...fields, melTop: top } };
      error = 'Choose which MEL option applies, or set the MEL item to "Not in the MEL".';
      return rerender();
    }
    const at = existing?.at || Date.now();
    const d = {
      ...fields,
      at,
      melItem: entry?.id || '',
      mel: entry?.cat || '',
      due: entry && fields.status === 'DEFERRED' ? dueFor(entry.cat, at) : null,
    };
    if (sharedLog()) {
      draft = { key: id, values: { ...fields, melTop: top } };
      if (!(await send(() => saveDefect(d, existing?.id)))) return;
    } else if (existing) {
      Object.assign(existing, d);
    } else {
      state.defectSeq += 1;
      state.defects.push({ id: uid(), ref: `WF-${String(state.defectSeq).padStart(3, '0')}`, ...d });
    }
    save();
    draft = null;
    location.hash = '#/techlog';
  },
};

// The quick way to close a defect: just say what fixed it.
forms.rectify = async (data) => {
  const existing = state.defects.find((x) => x.id === currentId());
  if (busy || !existing) return;
  const d = { ...existing, status: 'RECTIFIED', action: String(data.get('action')).trim(), aog: false, due: null };
  if (sharedLog()) {
    if (!(await send(() => saveDefect(d, existing.id)))) return;
  } else {
    Object.assign(existing, d);
  }
  save();
  draft = null;
  location.hash = '#/techlog';
};

export const actions = {
  tab(el) {
    tab = el.dataset.tab;
    rerender();
  },
  // A search result: set the drop-downs to it.
  pick(el) {
    const id = el.dataset.id;
    const chapter = chapters().find((c) => id.startsWith(`${c.ata}-`));
    Object.assign(selection(el), { system: chapterLabel(chapter), melTop: melTop(id), melItem: id });
    rerender();
  },
  async remove() {
    if (busy || !confirm('Delete this tech log entry?')) return;
    const id = currentId();
    if (sharedLog()) {
      if (!(await send(() => deleteDefect(id)))) return;
    } else {
      state.defects = state.defects.filter((d) => d.id !== id);
    }
    save();
    location.hash = '#/techlog';
  },
  // Copies this device's old entries into the shared log, oldest first.
  async upload() {
    if (busy) return;
    const old = [...state.localDefects].sort((a, b) => a.at - b.at);
    const done = await send(async () => {
      for (const d of old) {
        await saveDefect(d);
        state.localDefects = state.localDefects.filter((x) => x !== d);
        save();
      }
    });
    if (done) rerender();
  },
  discard() {
    if (!confirm('Discard the entries saved only on this device?')) return;
    state.localDefects = [];
    save();
    rerender();
  },
};
