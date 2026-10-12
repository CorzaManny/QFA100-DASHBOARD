// Aircraft technical log, shared by the team, with the MEL built in: pick the
// system and item that failed to see whether the aircraft can go with it.
// Defects stay with the aircraft and carry over between sectors.

import { state, save, uid } from '../store.js';
import { saveDefect, deleteDefect } from '../api.js';
import { esc, zulu, zdate, icon, rerender } from '../ui.js';
import { currentSector, me, sharedLog, syncTeam, canEdit } from '../ops.js';
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
  optionLabel,
  CATEGORIES,
  dueFor,
} from '../mel.js';

// Things that can break but are not in the MEL's chapters.
const OTHER_SYSTEMS = ['Simulator / Add-on', 'Other'];
const STATUS = { OPEN: 'bad', DEFERRED: 'warn', RECTIFIED: 'ok' };
const ORDER = { OPEN: 0, DEFERRED: 1, RECTIFIED: 2 };

let draft = null; // the form as typed so far, kept while the MEL drop-downs redraw it: { key, values }
let look = { system: '', melTop: '', melItem: '' }; // the MEL lookup page's selection
let error = '';
let busy = false;

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
      ${cat ? `<p class="tiny">${cat.text}.</p>` : ''}
    </div>`;
}

const sourceNote = () =>
  `<p class="tiny center">${esc(melSource() || 'FAA MMEL Boeing 737')}, items for a passenger 737-800. For flight simulation only.</p>`;

function lookup() {
  return `
    <div class="page-head"><a class="back" href="#/techlog">${icon('back')} Tech Log</a></div>
    <section class="card form">
      <h2>MEL lookup</h2>
      <p class="note">Check whether the aircraft can go with something inoperative, without adding it to the tech log.</p>
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
  const rows = defects
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
      <a class="btn primary" href="#/techlog/new">${icon('plus')} Report defect</a></div></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${waiting()}
    <section class="card list">
      <div class="card-head"><div class="tiny">${esc(state.profile.callsign)} · ${esc(state.profile.aircraft)}</div>
        <span class="badge ${active ? 'warn' : 'ok'}">${active ? `${active} ACTIVE` : 'SERVICEABLE'}</span></div>
      ${rows || '<p class="note">No defects recorded. Report anything that breaks or is not modelled.</p>'}
    </section>
    <p class="tiny center">${
      sharedLog() ? 'Shared with the whole team.' : 'Saved on this device only.'
    } Deferrals follow the FAA 737 MMEL and are for flight simulation only.</p>`;
  error = '';
  return out;
}

function form(id) {
  const existing = state.defects.find((d) => d.id === id);
  if (id !== 'new' && !existing) return `<p class="note">Defect not found.</p><a class="btn ghost" href="#/techlog">Back</a>`;
  const cur = currentSector();
  const base = existing
    ? { ...existing, melTop: melTop(existing.melItem) }
    : {
        system: '',
        desc: '',
        by: me()?.display_name || '',
        sector: cur ? `${cur.dep}-${cur.arr}` : '',
        status: 'OPEN',
        melTop: '',
        melItem: '',
        restriction: '',
        action: '',
        aog: false,
      };
  const d = draft?.key === id ? { ...base, ...draft.values } : base;
  const systems = [...chapters().map(chapterLabel), ...OTHER_SYSTEMS];
  // An entry written before the MEL was added may name a system that is no longer offered.
  if (d.system && !systems.includes(d.system)) systems.push(d.system);
  const out = `
    <div class="page-head"><a class="back" href="#/techlog">${icon('back')} Tech Log</a></div>
    <form class="card form" data-form="defect">
      <h2>${existing ? esc(existing.ref) : 'Report a defect'}</h2>
      <label class="field">Defect description<textarea name="desc" rows="3" required placeholder="e.g. Weather radar not displaying returns">${esc(d.desc)}</textarea></label>
      <div class="grid2">
        <label class="field">Reported by<input name="by" value="${esc(d.by)}"></label>
        <label class="field">Sector<input name="sector" value="${esc(d.sector)}" placeholder="YSSY-YBBN"></label>
      </div>
      <label class="field">System<select name="system" required data-change="system">
        <option value="">Select…</option>${systems.map((s) => opt(s, d.system)).join('')}</select></label>
      ${melPicker(d)}
      <label class="field">Status<select name="status">
        ${opt('OPEN', d.status, 'Open')}${opt('DEFERRED', d.status, 'Deferred (flying with it)')}${opt('RECTIFIED', d.status, 'Rectified')}</select></label>
      <label class="field">Operational restriction<input name="restriction" value="${esc(d.restriction)}" placeholder="e.g. Stay at or below FL250"></label>
      <label class="field">Rectification action<textarea name="action" rows="2" placeholder="What fixed it, or why it was deferred">${esc(d.action)}</textarea></label>
      <label class="check"><input type="checkbox" name="aog" ${d.aog ? 'checked' : ''}> Aircraft unserviceable until fixed (AOG)</label>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      <div class="btn-row">
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : existing ? 'Save changes' : 'Add to tech log'}</button>
        ${existing && (canEdit() || !sharedLog()) ? '<button class="btn danger" type="button" data-act="remove">Delete</button>' : ''}
      </div>
    </form>
    ${sourceNote()}`;
  error = '';
  return out;
}

export function render(args) {
  if (draft && draft.key !== args[0]) draft = null;
  if (args[0] === 'mel') return lookup();
  return args[0] ? form(args[0]) : list();
}

export function mounted() {
  if (!melReady()) loadMel().then(() => location.hash.startsWith('#/techlog') && melReady() && rerender());
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

export const actions = {
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
