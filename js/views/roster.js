// Roster: which accounts fly which sectors, their duty and report time.
// Everyone can read it; admins build it.

import { state } from '../store.js';
import { saveRoster, deleteRoster, configured } from '../api.js';
import { esc, zulu, zdate, depWindow, isoDate, isoTime, icon, rerender } from '../ui.js';
import { sortedSectors, crewOf, person, me, isAdmin, DUTIES, syncTeam } from '../ops.js';

let error = '';

const name = (id) => esc(person(id)?.display_name || 'Unknown');
const when = (t) => `${zdate(t)} ${zulu(t)}`;

function noAccounts() {
  return `
    <div class="page-head"><h1>Roster</h1></div>
    <section class="card">
      <p class="note">The roster is linked to user accounts, and this app is not connected to its database yet. Follow "Set up accounts" in the README, then everyone signs in and can be rostered here.</p>
    </section>`;
}

function list() {
  const now = Date.now();
  const sectors = sortedSectors();
  const byId = new Map(sectors.map((s) => [s.id, s]));
  const myId = me()?.id;

  const mine = state.roster
    .filter((r) => r.user_id === myId && byId.has(r.sector_id))
    .map((r) => ({ r, s: byId.get(r.sector_id) }))
    .sort((a, b) => new Date(a.s.std) - new Date(b.s.std));
  const myRows = mine
    .map(
      ({ r, s }) => `
      <a class="row ${new Date(s.sta) < now ? 'past' : ''}" href="#/roster/${esc(s.id)}">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} <span class="badge warn">${esc(r.duty.toUpperCase())}</span></div>
          <div class="sub">${esc(s.flight)} · Report <strong>${when(r.report_at)}</strong></div>
          ${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ''}
        </div>
        <div class="right">
          <div class="row-t">${zulu(s.std)}</div>
          <div class="sub">${zdate(s.std)}</div>
        </div>
      </a>`,
    )
    .join('');

  let day = '';
  const allRows = sectors
    .map((s) => {
      const d = zdate(s.std);
      const header = d !== day ? `<div class="list-day">${(day = d)}</div>` : '';
      const crew = crewOf(s);
      return `${header}
        <a class="row ${new Date(s.sta) < now ? 'past' : ''}" href="#/roster/${esc(s.id)}">
          <div class="row-main">
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)}</div>
            <div class="sub">${esc(s.flight)} · ${zulu(s.std)}</div>
            ${crew.map((r) => `<div class="sub crew-line">${name(r.user_id)} · ${esc(r.duty)} · report ${zulu(r.report_at)}</div>`).join('')}
          </div>
          <div class="right">${crew.length ? '' : '<span class="badge bad">NO CREW</span>'} ${icon('chevron')}</div>
        </a>`;
    })
    .join('');

  const uncrewed = sectors.filter((s) => new Date(s.sta) > now && !crewOf(s).length).length;
  return `
    <div class="page-head"><h1>Roster</h1></div>
    <section class="card list">
      <div class="card-head"><div class="tiny">MY ROSTER · ${esc((me()?.display_name || '').toUpperCase())}</div>
        <span class="badge ${mine.length ? 'info' : 'mute'}">${mine.length} SECTOR${mine.length === 1 ? '' : 'S'}</span></div>
      ${myRows || '<p class="note">You are not rostered on any sectors yet.</p>'}
    </section>
    <section class="card list">
      <div class="card-head"><div class="tiny">FULL ROSTER</div>
        ${uncrewed ? `<span class="badge warn">${uncrewed} WITHOUT CREW</span>` : '<span class="badge ok">ALL CREWED</span>'}</div>
      ${allRows || '<p class="note">No sectors in the schedule yet.</p>'}
    </section>
    <p class="tiny center">All times UTC. ${isAdmin() ? 'Open a sector to roster crew.' : 'Team admins build the roster.'}</p>`;
}

function detail(id) {
  const s = state.sectors.find((x) => x.id === id);
  if (!s) return `<p class="note">Sector not found.</p><a class="btn ghost" href="#/roster">Back</a>`;
  const admin = isAdmin();
  const crew = crewOf(s);
  const report = new Date(new Date(s.std).getTime() - state.profile.reportLead * 60000);

  const rows = crew
    .map(
      (r) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${name(r.user_id)} <span class="badge warn">${esc(r.duty.toUpperCase())}</span></div>
          <div class="sub">Report <strong>${when(r.report_at)}</strong>${r.notes ? ` · ${esc(r.notes)}` : ''}</div>
        </div>
        ${admin ? `<button class="btn danger small" data-act="remove" data-id="${esc(r.id)}">Remove</button>` : ''}
      </div>`,
    )
    .join('');

  const options = state.people
    .map((p) => `<option value="${esc(p.id)}">${esc(p.display_name)}${crew.some((r) => r.user_id === p.id) ? ' (already rostered)' : ''}</option>`)
    .join('');

  return `
    <div class="page-head"><a class="back" href="#/roster">${icon('back')} Roster</a></div>
    <section class="card list">
      <div class="card-head"><div>
        <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
        <div class="sub">${esc(s.flight)} · Departs ${when(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
      </div></div>
      ${rows || '<p class="note">No crew rostered on this sector yet.</p>'}
    </section>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${
      admin
        ? `<form class="card form" data-form="assign">
            <h2>Roster someone on this sector</h2>
            <label class="field">Team member<select name="user" required><option value="">Select…</option>${options}</select></label>
            <label class="field">Duty<select name="duty">${DUTIES.map((d) => `<option>${d}</option>`).join('')}</select></label>
            <div class="grid2">
              <label class="field">Report date (UTC)<input type="date" name="date" required value="${isoDate(report)}"></label>
              <label class="field">Report time (UTC)<input type="time" name="time" required value="${isoTime(report)}"></label>
            </div>
            <label class="field">Note for this person (optional)<input name="notes" maxlength="200" placeholder="e.g. Taking over mid-flight at top of descent"></label>
            <p class="tiny">Report time starts ${state.profile.reportLead} minutes before departure. Rostering someone who is already on this sector updates their entry.</p>
            <div class="btn-row"><button class="btn primary" type="submit">Add to roster</button></div>
          </form>`
        : '<p class="tiny center">Team admins build the roster.</p>'
    }
    <a class="btn ghost" href="#/schedule/${esc(s.id)}">Sector details</a>`;
}

export function render(args) {
  const out = !configured ? noAccounts() : args[0] ? detail(args[0]) : list();
  error = '';
  return out;
}

const currentId = () => decodeURIComponent(location.hash.split('/')[2] || '');

async function change(work) {
  try {
    await work();
    await syncTeam();
  } catch (err) {
    error = err.message;
  }
  if (location.hash.startsWith('#/roster')) rerender();
}

export const forms = {
  assign(data, formEl) {
    const report = new Date(`${data.get('date')}T${data.get('time')}:00Z`);
    if (isNaN(report)) return;
    formEl.querySelector('[type=submit]').disabled = true;
    return change(() =>
      saveRoster({
        sector_id: currentId(),
        user_id: data.get('user'),
        duty: data.get('duty'),
        report_at: report.toISOString(),
        notes: String(data.get('notes')).trim(),
      }),
    );
  },
};

export const actions = {
  remove(el) {
    if (!confirm('Remove this person from the sector?')) return;
    el.disabled = true;
    return change(() => deleteRoster(el.dataset.id));
  },
};
