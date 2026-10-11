// Admin section: build the roster and manage team roles.
// Admins and dispatchers edit the roster; only admins change roles.

import { state } from '../store.js';
import { saveRoster, deleteRoster, setRole } from '../api.js';
import { esc, zulu, zdate, depWindow, isoDate, isoTime, icon, rerender } from '../ui.js';
import {
  sortedSectors,
  crewOf,
  person,
  me,
  isAdmin,
  canEdit,
  ROLES,
  DUTIES,
  MIN_PILOTS,
  pilotsShort,
  defaultReport,
  REPORT_LEAD,
  FIRST_REPORT_LEAD,
  syncTeam,
} from '../ops.js';

// The two seats every sector is rostered from on the quick editor.
const SEATS = ['Captain', 'First Officer'];

let error = '';
let filter = 'all';

const when = (t) => `${zdate(t)} ${zulu(t)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const name = (id) => esc(person(id)?.display_name || 'Unknown');
const sectorCount = (userId) => state.roster.filter((r) => r.user_id === userId).length;

function tabs(active) {
  const tab = (key, href, label) => `<a class="${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  return `
    <div class="page-head"><h1>Admin</h1></div>
    ${isAdmin() ? `<nav class="seg on-card">${tab('roster', '#/admin', 'Roster')}${tab('people', '#/admin/people', 'People and roles')}</nav>` : ''}
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}`;
}

function needBadge(s) {
  const short = pilotsShort(s);
  return short
    ? `<span class="badge warn">NEEDS ${short} PILOT${short === 1 ? '' : 'S'}</span>`
    : '<span class="badge ok">CREWED</span>';
}

function seat(s, duty) {
  const crew = crewOf(s);
  const holder = crew.find((r) => r.duty === duty);
  const options = state.people
    // Observers are not offered a pilot's seat, unless one already holds it.
    .filter((p) => p.role !== 'observer' || p.id === holder?.user_id)
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === holder?.user_id ? 'selected' : ''}>${esc(p.display_name)} (${sectorCount(p.id)})</option>`,
    )
    .join('');
  return `<label class="field">${duty}
    <select data-change="seat" data-sector="${esc(s.id)}" data-duty="${duty}">
      <option value="">Not assigned</option>${options}
    </select></label>`;
}

function rosterEditor() {
  const now = Date.now();
  const upcoming = sortedSectors().filter((s) => new Date(s.sta) > now);
  const short = upcoming.filter(pilotsShort);
  const shown = filter === 'short' ? short : upcoming;

  const cards = shown
    .map((s) => {
      const others = crewOf(s).filter((r) => !SEATS.includes(r.duty));
      return `
      <section class="card slot-card ${pilotsShort(s) ? 'short' : 'ok'}">
        <div class="card-head">
          <div>
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)}</div>
            <div class="sub">${esc(s.flight)} · ${when(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
          </div>
          ${needBadge(s)}
        </div>
        <div class="slots">${seat(s, 'Captain')}${seat(s, 'First Officer')}</div>
        ${others.length ? `<div class="sub">Also: ${others.map((r) => `${name(r.user_id)} (${esc(r.duty)})`).join(', ')}</div>` : ''}
        <a class="tiny" href="#/admin/sector/${esc(s.id)}">Report times, notes, relief pilots and observers</a>
      </section>`;
    })
    .join('');

  return `
    ${tabs('roster')}
    <section class="card">
      <div class="card-head">
        <div class="note"><strong>${short.length}</strong> of ${upcoming.length} upcoming sectors have fewer than ${MIN_PILOTS} pilots.</div>
      </div>
      <div class="seg">
        <button type="button" class="${filter === 'all' ? 'on' : ''}" data-act="filter" data-filter="all">All sectors</button>
        <button type="button" class="${filter === 'short' ? 'on' : ''}" data-act="filter" data-filter="short">Needs pilots (${short.length})</button>
      </div>
      <p class="tiny">Pick a name to roster them; it saves straight away. The number after each name is how many sectors they already have. Report time is set to ${REPORT_LEAD} minutes before the departure window opens (${FIRST_REPORT_LEAD} for the first sector) and can be changed per person.</p>
    </section>
    ${cards || '<p class="note center">Every upcoming sector has its pilots.</p>'}`;
}

function people() {
  if (!isAdmin()) return `${tabs('roster')}<p class="note">Only admins can change roles.</p>`;
  const myId = me()?.id;
  const rows = state.people
    .map(
      (p) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}${p.id === myId ? ' <span class="badge mute">YOU</span>' : ''}</div>
          <div class="sub">${plural(sectorCount(p.id), 'sector')} rostered${p.vatsim_cid ? ` · CID ${esc(p.vatsim_cid)}` : ''}</div>
        </div>
        <select class="role-select" data-change="role" data-id="${esc(p.id)}" aria-label="Role for ${esc(p.display_name)}" ${p.id === myId ? 'disabled' : ''}>
          ${Object.entries(ROLES)
            .map(([key, [label]]) => `<option value="${key}" ${p.role === key ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select>
      </div>`,
    )
    .join('');
  return `
    ${tabs('people')}
    <section class="card list">
      <div class="card-head"><div class="tiny">TEAM ACCOUNTS</div><span class="badge mute">${state.people.length}</span></div>
      ${rows}
    </section>
    <section class="card">
      <h2>What each role can do</h2>
      <dl class="legend">${Object.values(ROLES)
        .map(([label, what]) => `<dt>${label}</dt><dd>${what}</dd>`)
        .join('')}</dl>
      <p class="tiny">You cannot change your own role, so there is always at least one admin. New accounts start as Pilot.</p>
    </section>`;
}

function sectorCrew(id) {
  const s = state.sectors.find((x) => x.id === id);
  if (!s) return `<p class="note">Sector not found.</p><a class="btn ghost" href="#/admin">Back</a>`;
  const crew = crewOf(s);
  const duties = (selected) => DUTIES.map((d) => `<option ${d === selected ? 'selected' : ''}>${d}</option>`).join('');

  const entries = crew
    .map(
      (r) => `
      <form class="crew-edit" data-form="entry">
        <input type="hidden" name="user" value="${esc(r.user_id)}">
        <div class="row-t">${name(r.user_id)}</div>
        <label class="field">Duty<select name="duty">${duties(r.duty)}</select></label>
        <div class="grid2">
          <label class="field">Report date (UTC)<input type="date" name="date" required value="${isoDate(r.report_at)}"></label>
          <label class="field">Report time (UTC)<input type="time" name="time" required value="${isoTime(r.report_at)}"></label>
        </div>
        <label class="field">Note for this person<input name="notes" maxlength="200" value="${esc(r.notes)}"></label>
        <div class="btn-row">
          <button class="btn ghost" type="submit">Save changes</button>
          <button class="btn danger" type="button" data-act="remove" data-id="${esc(r.id)}">Remove</button>
        </div>
      </form>`,
    )
    .join('');

  const report = defaultReport(s);
  const options = state.people
    .filter((p) => !crew.some((r) => r.user_id === p.id))
    .map((p) => `<option value="${esc(p.id)}">${esc(p.display_name)} · ${plural(sectorCount(p.id), 'sector')}</option>`)
    .join('');

  return `
    <div class="page-head"><a class="back" href="#/admin">${icon('back')} Admin</a></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    <section class="card">
      <div class="card-head"><div>
        <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
        <div class="sub">${esc(s.flight)} · Departs ${when(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
      </div>${needBadge(s)}</div>
      ${entries || '<p class="note">No crew rostered on this sector yet.</p>'}
    </section>
    <form class="card form" data-form="entry">
      <h2>Add someone to this sector</h2>
      <label class="field">Team member<select name="user" required><option value="">Select…</option>${options}</select></label>
      <label class="field">Duty<select name="duty">${duties(crew.length ? (crew.some((r) => r.duty === 'First Officer') ? 'Relief Pilot' : 'First Officer') : 'Captain')}</select></label>
      <div class="grid2">
        <label class="field">Report date (UTC)<input type="date" name="date" required value="${isoDate(report)}"></label>
        <label class="field">Report time (UTC)<input type="time" name="time" required value="${isoTime(report)}"></label>
      </div>
      <label class="field">Note for this person (optional)<input name="notes" maxlength="200" placeholder="e.g. Taking over at top of descent"></label>
      <div class="btn-row"><button class="btn primary" type="submit">Add to roster</button></div>
    </form>`;
}

export function render(args) {
  let out;
  if (!canEdit()) {
    out = `<div class="page-head"><h1>Admin</h1></div>
      <section class="card"><p class="note">This section is for team admins and dispatchers. Ask an admin if you need access.</p></section>`;
  } else if (args[0] === 'people') out = people();
  else if (args[0] === 'sector') out = sectorCrew(args[1]);
  else out = rosterEditor();
  error = '';
  return out;
}

async function change(work) {
  try {
    await work();
  } catch (err) {
    error = err.message;
  }
  await syncTeam();
  if (location.hash.startsWith('#/admin')) rerender();
}

const currentSectorId = () => decodeURIComponent(location.hash.split('/')[3] || '');

export const changes = {
  // Quick editor: put someone in a seat, swap them, or clear it.
  seat(el) {
    const s = state.sectors.find((x) => x.id === el.dataset.sector);
    const duty = el.dataset.duty;
    const userId = el.value;
    const crew = crewOf(s);
    const holder = crew.find((r) => r.duty === duty);
    for (const select of el.closest('.card').querySelectorAll('select')) select.disabled = true;
    return change(async () => {
      if (holder && holder.user_id !== userId) await deleteRoster(holder.id);
      if (!userId) return;
      // Someone already on this sector keeps their report time and note.
      const existing = crew.find((r) => r.user_id === userId);
      await saveRoster({
        sector_id: s.id,
        user_id: userId,
        duty,
        report_at: existing?.report_at || defaultReport(s).toISOString(),
        notes: existing?.notes || '',
      });
    });
  },
  role(el) {
    const who = person(el.dataset.id)?.display_name;
    if (el.value === 'admin' && !confirm(`Make ${who} an admin? Admins can change everyone's roles.`)) {
      return rerender();
    }
    el.disabled = true;
    return change(() => setRole(el.dataset.id, el.value));
  },
};

export const forms = {
  // Used both to add someone and to edit an existing entry.
  entry(data, formEl) {
    const report = new Date(`${data.get('date')}T${data.get('time')}:00Z`);
    if (isNaN(report)) return;
    formEl.querySelector('[type=submit]').disabled = true;
    return change(() =>
      saveRoster({
        sector_id: currentSectorId(),
        user_id: data.get('user'),
        duty: data.get('duty'),
        report_at: report.toISOString(),
        notes: String(data.get('notes')).trim(),
      }),
    );
  },
};

export const actions = {
  filter(el) {
    filter = el.dataset.filter;
    rerender();
  },
  remove(el) {
    if (!confirm('Remove this person from the sector?')) return;
    el.disabled = true;
    return change(() => deleteRoster(el.dataset.id));
  },
};
