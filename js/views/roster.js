// Roster: which accounts fly which sectors, their duty and report time.
// Read-only here; admins and dispatchers build it in the Admin section.

import { state } from '../store.js';
import { configured, offerSector, claimSwap, withdrawSwap, requestPickup, withdrawPickup } from '../api.js';
import { esc, zulu, zdate, depWindow, simLocal, icon, rerender } from '../ui.js';
import {
  sortedSectors, crewOf, person, me, canEdit, pilotsShort, pilotsNeeded, needsRelief, isDraft,
  MIN_PILOTS, rules, isEfb, openSwaps, swapFor, swapSector, swapEntry, wouldBreak, syncTeam,
  canPickUp, openSeats, pendingPickups,
} from '../ops.js';

let busy = '';
let error = '';
let offering = '';

const name = (id) => esc(person(id)?.display_name || 'Unknown');
const when = (t) => `${zdate(t)} ${zulu(t)}`;

function needBadge(s) {
  const short = pilotsShort(s);
  if (!short) return '';
  return `<span class="badge ${short >= pilotsNeeded(s) ? 'bad' : 'warn'}">NEEDS ${short} PILOT${short === 1 ? '' : 'S'}</span>`;
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
      ${
        isEfb()
          ? '<p class="note">It appears here once ops publish it.</p>'
          : `<p class="note">Tell the team which sectors you would like and which you cannot fly. The roster appears here once it is published.</p>
            <a class="btn primary" href="#/availability">Set my availability</a>`
      }
    </section>`;
}

// What somebody who cannot fly a sector has put up for the rest of the team.
function coverCard() {
  const myId = me()?.id;
  const open = openSwaps().filter((w) => swapSector(w) && new Date(swapSector(w).sta) > Date.now());
  if (!open.length) return '';
  const rows = open
    .map((w) => {
      const s = swapSector(w);
      const entry = swapEntry(w);
      const mine = w.from_user === myId;
      const onIt = state.roster.some((r) => r.sector_id === s.id && r.user_id === myId);
      const breaks = mine || onIt ? [] : wouldBreak(myId, s);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} <span class="badge warn">${esc((entry?.duty || '').toUpperCase())}</span></div>
          <div class="sub">${esc(s.flight)} · ${when(s.std)} · ${simLocal(s.std)}</div>
          <div class="sub">${mine ? 'You offered this' : `${name(w.from_user)} cannot fly it`}${w.reason ? ` · ${esc(w.reason)}` : ''}</div>
          ${breaks.map((t) => `<div class="sub warn-text">${icon('alert')} ${esc(t)}</div>`).join('')}
        </div>
        <div class="right">
          ${
            mine
              ? `<button class="btn ghost small" data-act="withdraw" data-id="${esc(w.id)}" ${busy === w.id ? 'disabled' : ''}>Keep it</button>`
              : onIt
                ? '<span class="tiny">You are on this sector</span>'
                : `<button class="btn ${breaks.length ? 'ghost' : 'primary'} small" data-act="claim" data-id="${esc(w.id)}" ${busy === w.id ? 'disabled' : ''}>Take it</button>`
          }
        </div>
      </div>`;
    })
    .join('');
  return `
    <section class="card list slot-card short">
      <div class="card-head"><div class="tiny">COVER NEEDED</div><span class="badge warn">${open.length}</span></div>
      ${rows}
      <p class="tiny">Taking a sector tells an admin, who agrees it before the roster changes. Anything that would break a duty rule is marked, and you can still take it.</p>
    </section>`;
}

// Asking for an empty seat on one sector: a button per seat, or the request
// already made and a way to take it back.
function seatButtons(s) {
  const myId = me()?.id;
  if (state.roster.some((r) => r.sector_id === s.id && r.user_id === myId)) return '';
  const asked = pendingPickups().find((p) => p.sector_id === s.id && p.user_id === myId);
  if (asked) {
    return `<div class="btn-row"><span class="badge info">ASKED FOR ${esc(asked.duty.toUpperCase())}</span>
      <button class="btn ghost small" data-act="unpick" data-id="${esc(asked.id)}" ${busy === asked.id ? 'disabled' : ''}>Cancel</button></div>`;
  }
  return `<div class="btn-row">${openSeats(s)
    .map(
      (duty) =>
        `<button class="btn primary small" data-act="pick" data-sector="${esc(s.id)}" data-duty="${esc(duty)}" ${busy === s.id ? 'disabled' : ''}>Fly as ${esc(duty)}</button>`,
    )
    .join('')}</div>`;
}

// Published sectors with seats nobody is rostered in, for pilots to ask for.
function openSeatsCard() {
  if (!canPickUp()) return '';
  const now = Date.now();
  const myId = me()?.id;
  const open = sortedSectors().filter((s) => new Date(s.std) > now && openSeats(s).length);
  if (!open.length) return '';
  const rows = open
    .map((s) => {
      const onIt = state.roster.some((r) => r.sector_id === s.id && r.user_id === myId);
      const breaks = onIt ? [] : wouldBreak(myId, s);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} ${needBadge(s)}</div>
          <div class="sub">${esc(s.flight)} · ${when(s.std)} · ${simLocal(s.std)}</div>
          ${breaks.map((t) => `<div class="sub warn-text">${icon('alert')} ${esc(t)}</div>`).join('')}
          ${onIt ? '<div class="sub">You are on this sector</div>' : seatButtons(s)}
        </div>
      </div>`;
    })
    .join('');
  return `
    <section class="card list">
      <div class="card-head"><div class="tiny">OPEN SEATS</div><span class="badge warn">${open.length} SECTOR${open.length === 1 ? '' : 'S'}</span></div>
      ${rows}
      <p class="tiny">Ask for a seat and an admin or dispatcher agrees it before you are rostered. Anything that would break a duty rule is marked, and you can still ask.</p>
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
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)}${needsRelief(s) ? ' <span class="badge info">3 PILOTS</span>' : ''}</div>
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
      ${isEfb() ? '' : '<a class="btn ghost" href="#/availability">My availability</a>'}
      ${canEdit() ? '<a class="btn primary" href="#/admin">Edit roster</a>' : ''}
    </div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${isEfb() ? '' : coverCard()}
    ${openSeatsCard()}
    ${
      isEfb()
        ? ''
        : `<section class="card list">
            <div class="card-head"><div class="tiny">MY ROSTER · ${esc((me()?.display_name || '').toUpperCase())}</div>
              <span class="badge ${mine.length ? 'info' : 'mute'}">${mine.length} SECTOR${mine.length === 1 ? '' : 'S'}</span></div>
            ${myRows || '<p class="note">You are not rostered on any sectors yet.</p>'}
          </section>`
    }
    <section class="card list">
      <div class="card-head"><div class="tiny">FULL ROSTER</div>
        ${short ? `<span class="badge warn">${short} NEED PILOTS</span>` : '<span class="badge ok">ALL CREWED</span>'}</div>
      ${allRows || '<p class="note">No sectors in the schedule yet.</p>'}
    </section>
    <p class="tiny center">All times UTC. Every sector needs ${MIN_PILOTS} pilots${
      rules().reliefOverHours > 0 ? `, and a relief pilot as well when it is longer than ${rules().reliefOverHours} hours` : ''
    }.</p>`;
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
  const myEntry = crewOf(s).find((r) => r.user_id === me()?.id);
  const offer = myEntry ? swapFor(myEntry.id) : null;
  const gone = new Date(s.std) < Date.now();

  return `
    <div class="page-head"><a class="back" href="#/roster">${icon('back')} Roster</a></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    <section class="card list">
      <div class="card-head"><div>
        <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
        <div class="sub">${esc(s.flight)} · Departs ${when(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
      </div>${needBadge(s)}</div>
      ${rows || '<p class="note">No crew rostered on this sector yet.</p>'}
    </section>
    ${myEntry && !gone ? giveAway(s, myEntry, offer) : ''}
    ${
      canPickUp() && !gone && !myEntry && openSeats(s).length
        ? `<section class="card"><h2>Open seat${openSeats(s).length === 1 ? '' : 's'}</h2>
            <p class="note">Ask to fly it. An admin or dispatcher agrees it before you are rostered.</p>
            ${wouldBreak(me()?.id, s).map((t) => `<p class="note warn">${icon('alert')} ${esc(t)}</p>`).join('')}
            ${seatButtons(s)}</section>`
        : ''
    }
    <div class="btn-col">
      ${canEdit() ? `<a class="btn primary" href="#/admin/sector/${esc(s.id)}">Edit this sector's crew</a>` : ''}
      <a class="btn ghost" href="#/schedule/${esc(s.id)}">Sector details</a>
    </div>`;
}

// Handing back a sector you are on, and what happens to it afterwards.
function giveAway(s, entry, offer) {
  if (offer) {
    const taken = offer.state === 'claimed';
    return `
      <section class="card">
        <div class="card-head"><h2>You offered this sector</h2>
          <span class="badge ${taken ? 'ok' : 'warn'}">${taken ? 'SOMEONE WILL TAKE IT' : 'WAITING'}</span></div>
        <p class="note">${
          taken
            ? `${name(offer.claimed_by)} has offered to fly it. An admin agrees it before the roster changes, and you both get told.`
            : 'The team can see it on the Roster page. You are still rostered until somebody takes it and an admin agrees.'
        }${offer.reason ? ` Your reason: ${esc(offer.reason)}` : ''}</p>
        <button class="btn ghost" data-act="withdraw" data-id="${esc(offer.id)}" ${busy === offer.id ? 'disabled' : ''}>Keep this sector after all</button>
      </section>`;
  }
  if (offering !== entry.id) {
    return `
      <section class="card">
        <h2>Cannot make it?</h2>
        <p class="note">Offer the sector to the rest of the team. You stay on it until somebody takes it and an admin agrees, so nothing is left uncovered.</p>
        <button class="btn ghost" data-act="offer" data-id="${esc(entry.id)}">I cannot fly this</button>
      </section>`;
  }
  return `
    <form class="card form" data-form="offer">
      <h2>Offer ${esc(s.flight)} to the team</h2>
      <input type="hidden" name="entry" value="${esc(entry.id)}">
      <label class="field">Why, so people know (optional)<input name="reason" maxlength="120" placeholder="e.g. Work has moved, cannot be at the sim"></label>
      <div class="btn-row">
        <button class="btn primary" type="submit" ${busy === entry.id ? 'disabled' : ''}>Offer it</button>
        <button class="btn ghost" type="button" data-act="offer" data-id="">Cancel</button>
      </div>
    </form>`;
}

async function act(id, work) {
  busy = id;
  error = '';
  rerender();
  try {
    await work();
    await syncTeam();
  } catch (err) {
    error = err.message;
  }
  busy = '';
  rerender();
}

export const actions = {
  pick(el) {
    const { sector, duty } = el.dataset;
    if (!confirm(`Ask to fly this sector as ${duty}? An admin or dispatcher agrees it first.`)) return;
    return act(sector, () => requestPickup(sector, duty));
  },
  unpick(el) {
    const id = el.dataset.id;
    return act(id, () => withdrawPickup(id));
  },
  offer(el) {
    offering = el.dataset.id;
    rerender();
  },
  claim(el) {
    const id = el.dataset.id;
    if (!confirm('Take this sector? An admin agrees it before the roster changes.')) return;
    return act(id, () => claimSwap(id));
  },
  withdraw(el) {
    const id = el.dataset.id;
    if (!confirm('Keep this sector and take the offer down?')) return;
    return act(id, () => withdrawSwap(id));
  },
};

export const forms = {
  offer(data) {
    const entry = String(data.get('entry'));
    offering = '';
    return act(entry, () => offerSector(entry, String(data.get('reason')).trim()));
  },
};

export function render(args) {
  if (!configured) return noAccounts();
  if (isDraft() && !canEdit()) return draft();
  return args[0] ? detail(args[0]) : list();
}
