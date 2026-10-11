// Aircraft technical log with simulated MEL-style deferrals.
// Defects stay with the aircraft and carry over between sectors.

import { state, save, uid } from '../store.js';
import { esc, zulu, zdate, icon } from '../ui.js';
import { currentSector, me } from '../ops.js';

const SYSTEMS = [
  'Air conditioning / Pressurization',
  'Autoflight',
  'Avionics / Navigation',
  'Cabin',
  'Communications',
  'Electrical',
  'Engines / APU',
  'Flight controls',
  'Fuel',
  'Hydraulics',
  'Landing gear / Brakes',
  'Lights',
  'Simulator / Add-on',
  'Other',
];
const STATUS = { OPEN: 'bad', DEFERRED: 'warn', RECTIFIED: 'ok' };
const ORDER = { OPEN: 0, DEFERRED: 1, RECTIFIED: 2 };

function list() {
  const defects = [...state.defects].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.at - a.at);
  const active = defects.filter((d) => d.status !== 'RECTIFIED').length;
  const rows = defects
    .map(
      (d) => `
      <a class="row ${d.status === 'RECTIFIED' ? 'past' : ''}" href="#/techlog/${esc(d.id)}">
        <div class="row-main">
          <div class="row-t">${esc(d.ref)} · ${esc(d.desc)}</div>
          <div class="sub">${esc(d.system)} · ${zdate(d.at)} ${zulu(d.at)}${d.sector ? ` · ${esc(d.sector)}` : ''}${
            d.by ? ` · ${esc(d.by)}` : ''
          }</div>
          ${d.status === 'DEFERRED' && d.restriction ? `<div class="sub">Restriction: ${esc(d.restriction)}</div>` : ''}
        </div>
        <div class="right stack">
          <span class="badge ${STATUS[d.status]}">${d.status}</span>
          ${d.aog && d.status !== 'RECTIFIED' ? '<span class="badge bad">AOG</span>' : ''}
          ${d.status === 'DEFERRED' && d.mel ? `<span class="badge mute">CAT ${esc(d.mel)}</span>` : ''}
        </div>
      </a>`,
    )
    .join('');
  return `
    <div class="page-head"><h1>Tech Log</h1>
      <a class="btn primary" href="#/techlog/new">${icon('plus')} Report defect</a></div>
    <section class="card list">
      <div class="card-head"><div class="tiny">${esc(state.profile.callsign)} · ${esc(state.profile.aircraft)}</div>
        <span class="badge ${active ? 'warn' : 'ok'}">${active ? `${active} ACTIVE` : 'SERVICEABLE'}</span></div>
      ${rows || '<p class="note">No defects recorded. Report anything that breaks or is not modelled.</p>'}
    </section>
    <p class="tiny center">Simulated deferrals only. Categories are team-defined and are not a real Boeing MEL.</p>`;
}

function form(id) {
  const existing = state.defects.find((d) => d.id === id);
  if (id !== 'new' && !existing) return `<p class="note">Defect not found.</p><a class="btn ghost" href="#/techlog">Back</a>`;
  const cur = currentSector();
  const d = existing || {
    system: '',
    desc: '',
    by: me()?.display_name || '',
    sector: cur ? `${cur.dep}-${cur.arr}` : '',
    status: 'OPEN',
    mel: '',
    restriction: '',
    action: '',
    aog: false,
  };
  const opt = (v, sel, label = v) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`;
  return `
    <div class="page-head"><a class="back" href="#/techlog">${icon('back')} Tech Log</a></div>
    <form class="card form" data-form="defect">
      <h2>${existing ? esc(d.ref) : 'Report a defect'}</h2>
      <label class="field">System<select name="system" required>
        <option value="">Select…</option>${SYSTEMS.map((s) => opt(s, d.system)).join('')}</select></label>
      <label class="field">Defect description<textarea name="desc" rows="3" required placeholder="e.g. Weather radar not displaying returns">${esc(d.desc)}</textarea></label>
      <div class="grid2">
        <label class="field">Reported by<input name="by" value="${esc(d.by)}"></label>
        <label class="field">Sector<input name="sector" value="${esc(d.sector)}" placeholder="YSSY-YBBN"></label>
      </div>
      <div class="grid2">
        <label class="field">Status<select name="status">
          ${opt('OPEN', d.status, 'Open')}${opt('DEFERRED', d.status, 'Deferred (simulated MEL)')}${opt('RECTIFIED', d.status, 'Rectified')}</select></label>
        <label class="field">Deferral category<select name="mel">
          ${opt('', d.mel, 'Not assigned')}${['A', 'B', 'C', 'D'].map((c) => opt(c, d.mel, `Category ${c}`)).join('')}</select></label>
      </div>
      <label class="field">Operational restriction<input name="restriction" value="${esc(d.restriction)}" placeholder="e.g. Avoid forecast thunderstorms en route"></label>
      <label class="field">Rectification action<textarea name="action" rows="2" placeholder="What fixed it, or why it was deferred">${esc(d.action)}</textarea></label>
      <label class="check"><input type="checkbox" name="aog" ${d.aog ? 'checked' : ''}> Aircraft unserviceable until fixed (AOG)</label>
      <div class="btn-row">
        <button class="btn primary" type="submit">${existing ? 'Save changes' : 'Add to tech log'}</button>
        ${existing ? '<button class="btn danger" type="button" data-act="remove">Delete</button>' : ''}
      </div>
    </form>`;
}

export function render(args) {
  return args[0] ? form(args[0]) : list();
}

const currentId = () => decodeURIComponent(location.hash.split('/')[2] || '');

export const forms = {
  defect(data) {
    const id = currentId();
    let d = state.defects.find((x) => x.id === id);
    if (!d) {
      state.defectSeq += 1;
      d = { id: uid(), ref: `WF-${String(state.defectSeq).padStart(3, '0')}`, at: Date.now() };
      state.defects.push(d);
    }
    const text = (k) => String(data.get(k) ?? '').trim();
    Object.assign(d, {
      system: text('system'),
      desc: text('desc'),
      by: text('by'),
      sector: text('sector').toUpperCase(),
      status: text('status'),
      mel: text('mel'),
      restriction: text('restriction'),
      action: text('action'),
      aog: data.get('aog') === 'on',
    });
    save();
    location.hash = '#/techlog';
  },
};

export const actions = {
  remove() {
    if (!confirm('Delete this tech log entry?')) return;
    state.defects = state.defects.filter((d) => d.id !== currentId());
    save();
    location.hash = '#/techlog';
  },
};
