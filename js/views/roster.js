// Roster: which accounts fly which sectors, their duty and report time.
// Read-only here; admins and dispatchers build it in the Admin section.

import { state, save } from '../store.js';
import { configured, offerSector, claimSwap, withdrawSwap, requestPickup, withdrawPickup } from '../api.js';
import { esc, zulu, zdate, span, depWindow, simLocal, simClock, simDateLabel, icon, dutyBadge, dutyClass, rerender } from '../ui.js';
import {
  sortedSectors, crewOf, person, me, canEdit, pilotsShort, pilotsNeeded, needsRelief, isDraft,
  MIN_PILOTS, rules, isEfb, isOps, openSwaps, swapFor, swapSector, swapEntry, wouldBreak, syncTeam,
  canPickUp, openSeats, pendingPickups, workload, prefOf, defaultReport,
} from '../ops.js';

let busy = '';
let error = '';
let offering = '';

const name = (id) => esc(person(id)?.display_name || 'Unknown');
const when = (t) => `${zdate(t)} ${zulu(t)}`;

// The roster is planned in Zulu but flown by people living in Sydney, so
// neither time is the right one for everybody. The UTC/LOCAL button says which
// one this device leads with; the other is always kept beside it, so nothing
// is ever hidden and no time can be read as the wrong one - every one of them
// carries its own Z or AEDT. The choice is saved on the device.
const localTimes = () => state.rosterTimes === 'local';

// Day and time: "01 NOV 1245Z" or "SUN 2345 AEDT".
const stamp = (t) => (localTimes() ? simLocal(t) : when(t));
// The same moment the other way round, for the line beside it.
const other = (t) => (localTimes() ? when(t) : simLocal(t));
// Time on its own: "1245Z" or "2345 AEDT".
const clock = (t) => (localTimes() ? simClock(t) : zulu(t));
const otherClock = (t) => (localTimes() ? zulu(t) : simClock(t));
// Day on its own, for a list's date headings: "01 NOV" in whichever zone.
const dayOf = (t) => (localTimes() ? simDateLabel(t) : zdate(t));

function tzToggle() {
  const loc = localTimes();
  return `<nav class="seg tz-toggle" aria-label="Show times in">
    <button type="button" class="${loc ? '' : 'on'}" data-act="tz" data-tz="utc" aria-pressed="${!loc}">UTC</button>
    <button type="button" class="${loc ? 'on' : ''}" data-act="tz" data-tz="local" aria-pressed="${loc}">Local</button>
  </nav>`;
}

// Duty runs from signing on to on blocks at the far end - the same two ends
// the team's duty-hours rule measures between - so a pilot can see how long
// they are on for and when they are released without working it out. Sign-off
// is given in Zulu and then in sim local time, because that is where they are
// sitting. signOn is a roster entry's report time, or what it would be for a
// seat nobody is in yet.
function dutyLine(signOn, sector, withSignOn = false) {
  const off = new Date(sector.sta);
  const on = new Date(signOn);
  if (isNaN(on) || isNaN(off)) return '';
  return `<div class="sub duty-line">${withSignOn ? `Sign on <strong>${clock(on)}</strong> · ` : ''}Duty <strong>${span(
    off - on,
  )}</strong> · Sign off <strong>${clock(off)}</strong> · ${otherClock(off)}</div>`;
}

// The break between two of my own sectors: from being released at the end of
// one to signing on for the next. Back-to-back sectors flown in the same duty
// leave no gap at all, so nothing is drawn for them - only a real break shows,
// which is the point of it.
function offDuty(prevSector, nextSignOn, now) {
  const from = new Date(prevSector.sta).getTime();
  const to = new Date(nextSignOn).getTime();
  if (!(to > from)) return '';
  return `<div class="off-duty${to < now ? ' past' : ''}">${icon('deck')} Off duty for ${span(to - from)}
    <span class="off-when">${clock(from)} → ${clock(to)}</span></div>`;
}

function needBadge(s) {
  const short = pilotsShort(s);
  if (!short) return '';
  return `<span class="badge ${short >= pilotsNeeded(s) ? 'bad' : 'warn'}">NEEDS ${short} PILOT${short === 1 ? '' : 'S'}</span>`;
}

function noAccounts() {
  return `
    <div class="page-head"><h1>Team Roster</h1></div>
    <section class="card">
      <p class="note">The roster is linked to user accounts, and this app is not connected to its database yet. Follow "Set up accounts" in the README, then everyone signs in and can be rostered here.</p>
    </section>`;
}

// While the roster is a draft, pilots only get the availability page.
function draft() {
  return `
    <div class="page-head"><h1>Team Roster</h1><span class="badge warn">DRAFT</span></div>
    <section class="card">
      <h2>The roster is being put together</h2>
      ${
        isEfb() || isOps()
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
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} ${dutyBadge(entry?.duty)}</div>
          <div class="sub">${esc(s.flight)} · ${stamp(s.std)} · ${other(s.std)}</div>
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

// Empty seats on one sector, drawn as dashed slots where the crew would be.
// Tap one to ask for it; one already asked for can be cancelled.
function seatButtons(s) {
  const myId = me()?.id;
  if (state.roster.some((r) => r.sector_id === s.id && r.user_id === myId)) return '';
  const asked = pendingPickups().find((p) => p.sector_id === s.id && p.user_id === myId);
  const slot = (duty) =>
    asked?.duty === duty
      ? `<button class="seat-slot asked" data-act="unpick" data-id="${esc(asked.id)}" ${busy === asked.id ? 'disabled' : ''}>
          <span><span class="seat-duty ${dutyClass(duty)}">${esc(duty)}</span> Asked for, waiting for ops</span><span class="seat-go">Cancel</span></button>`
      : `<button class="seat-slot" data-act="pick" data-sector="${esc(s.id)}" data-duty="${esc(duty)}" ${busy === s.id || asked ? 'disabled' : ''}>
          <span><span class="seat-duty ${dutyClass(duty)}">${esc(duty)}</span> Open seat</span><span class="seat-go">${asked ? '' : `Ask to fly ${icon('chevron')}`}</span></button>`;
  return `<div class="seat-slots">${openSeats(s).map(slot).join('')}</div>`;
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
        <div class="row-main grow">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} ${needBadge(s)}</div>
          <div class="sub">${esc(s.flight)} · ${stamp(s.std)} · ${other(s.std)}</div>
          ${dutyLine(defaultReport(s), s, true)}
          ${crewOf(s)
            .map((r) => `<div class="sub crew-line">${esc(r.duty)} · ${name(r.user_id)}</div>`)
            .join('')}
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

const stat = (label, value, sub = '', cls = '') =>
  `<div class="kv"><span>${label}</span><strong class="${cls}">${value}</strong>${sub ? `<span class="tiny">${sub}</span>` : ''}</div>`;

// Of the sectors you asked for (Prefer, in Availability), how many you
// actually got - how well your bids did, not how many you answered. Not
// shown until the roster is published: while it is still a draft, nothing
// has actually been decided yet for a success rate to mean anything.
function myStats(myId, sectors) {
  const load = workload(myId);
  const tiles = [stat('Flight hours', load.hours.toFixed(1)), stat('Sectors', String(load.total))];
  if (!isDraft()) {
    const requested = sectors.filter((s) => prefOf(myId, s.id) === 'prefer');
    const got = requested.filter((s) => state.roster.some((r) => r.user_id === myId && r.sector_id === s.id));
    const pct = requested.length ? Math.round((got.length / requested.length) * 100) : null;
    const sub = requested.length ? `${got.length} of ${requested.length} requested sectors` : 'Nothing asked for yet';
    tiles.push(stat('Preferences', pct === null ? '—' : `${pct}%`, sub, pct === null ? '' : pct === 100 ? 'ok-text' : 'warn-text'));
  }
  return `<div class="my-stats"><div class="kvs">${tiles.join('')}</div></div>`;
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
    .map(({ r, s }, i) => {
      const prev = mine[i - 1];
      return `
      ${prev ? offDuty(prev.s, r.report_at, now) : ''}
      <a class="row ${new Date(s.sta) < now ? 'past' : ''}" href="#/roster/${esc(s.id)}">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} ${dutyBadge(r.duty)}</div>
          <div class="sub">${esc(s.flight)} · Report <strong>${stamp(r.report_at)}</strong> · ${other(r.report_at)}</div>
          ${dutyLine(r.report_at, s)}
          ${r.notes ? `<div class="sub">${esc(r.notes)}</div>` : ''}
        </div>
        <div class="right">
          <div class="row-t">${clock(s.std)}</div>
          <div class="sub">${dayOf(s.std)}</div>
        </div>
      </a>`;
    })
    .join('');

  let day = '';
  const allRows = sectors
    .map((s) => {
      const d = dayOf(s.std);
      const header = d !== day ? `<div class="list-day">${(day = d)}</div>` : '';
      return `${header}
        <a class="row ${new Date(s.sta) < now ? 'past' : ''}" href="#/roster/${esc(s.id)}">
          <div class="row-main">
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)}${needsRelief(s) ? ' <span class="badge info">3 PILOTS</span>' : ''}</div>
            <div class="sub">${esc(s.flight)} · ${clock(s.std)}</div>
            ${crewOf(s)
              .map((r) => `<div class="sub crew-line">${name(r.user_id)} · ${esc(r.duty)} · report ${clock(r.report_at)}</div>`)
              .join('')}
          </div>
          <div class="right">${needBadge(s)} ${icon('chevron')}</div>
        </a>`;
    })
    .join('');

  const short = sectors.filter((s) => new Date(s.sta) > now && pilotsShort(s)).length;
  return `
    <div class="page-head"><h1>Team Roster</h1>
      ${isDraft() ? '<span class="badge warn">DRAFT · NOT VISIBLE TO PILOTS</span>' : ''}</div>
    <div class="btn-row">
      ${isEfb() || isOps() ? '' : '<a class="btn ghost" href="#/availability">My availability</a>'}
      ${canEdit() ? '<a class="btn primary" href="#/admin">Edit roster</a>' : ''}
      ${tzToggle()}
    </div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${isEfb() ? '' : coverCard()}
    ${
      isEfb()
        ? ''
        : `<section class="card list">
            <div class="card-head"><div class="tiny">MY ROSTER · ${esc((me()?.display_name || '').toUpperCase())}</div>
              <span class="badge ${isDraft() ? 'warn' : 'ok'}">${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span></div>
            ${myStats(myId, sectors)}
            ${myRows || '<p class="note">You are not rostered on any sectors yet.</p>'}
          </section>
          ${openSeatsCard()}`
    }
    <section class="card list">
      <div class="card-head"><div class="tiny">FULL ROSTER</div>
        ${short ? `<span class="badge warn">${short} NEED PILOTS</span>` : '<span class="badge ok">ALL CREWED</span>'}</div>
      ${allRows || '<p class="note">No sectors in the schedule yet.</p>'}
    </section>
    <p class="tiny center">${
      localTimes() ? 'Times lead with sim local (Sydney), Zulu beside them.' : 'Times lead with Zulu, sim local (Sydney) beside them.'
    } Every sector needs ${MIN_PILOTS} pilots${
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
          <div class="row-t">${name(r.user_id)} ${dutyBadge(r.duty)}</div>
          <div class="sub">Report <strong>${stamp(r.report_at)}</strong> · ${other(r.report_at)}${r.notes ? ` · ${esc(r.notes)}` : ''}</div>
        </div>
      </div>`,
    )
    .join('');
  const myEntry = crewOf(s).find((r) => r.user_id === me()?.id);
  const offer = myEntry ? swapFor(myEntry.id) : null;
  const gone = new Date(s.std) < Date.now();

  return `
    <div class="page-head"><a class="back" href="#/roster">${icon('back')} Team Roster</a>${tzToggle()}</div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    <section class="card list">
      <div class="card-head"><div>
        <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
        <div class="sub">${esc(s.flight)} · Departs ${stamp(s.std)} · ${other(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
      </div>${needBadge(s)}</div>
      ${rows || '<p class="note">No crew rostered on this sector yet.</p>'}
      ${
        canPickUp() && !gone && !myEntry && openSeats(s).length
          ? `${wouldBreak(me()?.id, s).map((t) => `<div class="sub warn-text">${icon('alert')} ${esc(t)}</div>`).join('')}
            ${seatButtons(s)}
            <p class="tiny">Ask for an open seat and an admin or dispatcher agrees it before you are rostered.</p>`
          : ''
      }
    </section>
    ${myEntry && !gone ? giveAway(s, myEntry, offer) : ''}
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
  tz(el) {
    state.rosterTimes = el.dataset.tz === 'local' ? 'local' : 'utc';
    save();
    rerender();
  },
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
