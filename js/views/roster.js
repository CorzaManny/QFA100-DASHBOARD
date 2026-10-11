// Roster: which accounts fly which sectors, their duty and report time.
// Read-only here; admins and dispatchers build it in the Admin section.

import { state } from '../store.js';
import { configured } from '../api.js';
import { esc, zulu, zdate, depWindow, simLocal, icon } from '../ui.js';
import { sortedSectors, crewOf, person, me, canEdit, pilotsShort, isDraft, MIN_PILOTS } from '../ops.js';

const name = (id) => esc(person(id)?.display_name || 'Unknown');
const when = (t) => `${zdate(t)} ${zulu(t)}`;

function needBadge(s) {
  const short = pilotsShort(s);
  if (!short) return '';
  return `<span class="badge ${short === MIN_PILOTS ? 'bad' : 'warn'}">NEEDS ${short} PILOT${short === 1 ? '' : 'S'}</span>`;
}

function noAccounts() {
  return `
    <div class="page-head"><h1>Roster</h1></div>
    <section class="card">
      <p class="note">The roster is linked to user accounts, and this app is not connected to its database yet. Follow "Set up accounts" in the README, then everyone signs in and can be rostered here.</p>
    </section>`;
}

// While the roster is a draft, pilots only get the availability page.
function draft() {
  return `
    <div class="page-head"><h1>Roster</h1><span class="badge warn">DRAFT</span></div>
    <section class="card">
      <h2>The roster is being put together</h2>
      <p class="note">Tell the team which sectors you would like and which you cannot fly. The roster appears here once it is published.</p>
      <a class="btn primary" href="#/availability">Set my availability</a>
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
          <div class="sub">${esc(s.flight)} · Report <strong>${when(r.report_at)}</strong> · ${simLocal(r.report_at)}</div>
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
      return `${header}
        <a class="row ${new Date(s.sta) < now ? 'past' : ''}" href="#/roster/${esc(s.id)}">
          <div class="row-main">
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)}</div>
            <div class="sub">${esc(s.flight)} · ${zulu(s.std)}</div>
            ${crewOf(s)
              .map((r) => `<div class="sub crew-line">${name(r.user_id)} · ${esc(r.duty)} · report ${zulu(r.report_at)}</div>`)
              .join('')}
          </div>
          <div class="right">${needBadge(s)} ${icon('chevron')}</div>
        </a>`;
    })
    .join('');

  const short = sectors.filter((s) => new Date(s.sta) > now && pilotsShort(s)).length;
  return `
    <div class="page-head"><h1>Roster</h1>
      ${isDraft() ? '<span class="badge warn">DRAFT · NOT VISIBLE TO PILOTS</span>' : ''}</div>
    <div class="btn-row">
      <a class="btn ghost" href="#/availability">My availability</a>
      ${canEdit() ? '<a class="btn primary" href="#/admin">Edit roster</a>' : ''}
    </div>
    <section class="card list">
      <div class="card-head"><div class="tiny">MY ROSTER · ${esc((me()?.display_name || '').toUpperCase())}</div>
        <span class="badge ${mine.length ? 'info' : 'mute'}">${mine.length} SECTOR${mine.length === 1 ? '' : 'S'}</span></div>
      ${myRows || '<p class="note">You are not rostered on any sectors yet.</p>'}
    </section>
    <section class="card list">
      <div class="card-head"><div class="tiny">FULL ROSTER</div>
        ${short ? `<span class="badge warn">${short} NEED PILOTS</span>` : '<span class="badge ok">ALL CREWED</span>'}</div>
      ${allRows || '<p class="note">No sectors in the schedule yet.</p>'}
    </section>
    <p class="tiny center">All times UTC. Every sector needs at least ${MIN_PILOTS} pilots.</p>`;
}

function detail(id) {
  const s = state.sectors.find((x) => x.id === id);
  if (!s) return `<p class="note">Sector not found.</p><a class="btn ghost" href="#/roster">Back</a>`;
  const rows = crewOf(s)
    .map(
      (r) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${name(r.user_id)} <span class="badge warn">${esc(r.duty.toUpperCase())}</span></div>
          <div class="sub">Report <strong>${when(r.report_at)}</strong>${r.notes ? ` · ${esc(r.notes)}` : ''}</div>
        </div>
      </div>`,
    )
    .join('');
  return `
    <div class="page-head"><a class="back" href="#/roster">${icon('back')} Roster</a></div>
    <section class="card list">
      <div class="card-head"><div>
        <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
        <div class="sub">${esc(s.flight)} · Departs ${when(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
      </div>${needBadge(s)}</div>
      ${rows || '<p class="note">No crew rostered on this sector yet.</p>'}
    </section>
    <div class="btn-col">
      ${canEdit() ? `<a class="btn primary" href="#/admin/sector/${esc(s.id)}">Edit this sector's crew</a>` : ''}
      <a class="btn ghost" href="#/schedule/${esc(s.id)}">Sector details</a>
    </div>`;
}

export function render(args) {
  if (!configured) return noAccounts();
  if (isDraft() && !canEdit()) return draft();
  return args[0] ? detail(args[0]) : list();
}
