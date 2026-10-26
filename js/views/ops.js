// The ops board: everything that needs doing before the next few sectors go,
// on one page. Who is still to report and when, which sectors are short of
// pilots, which have no flight plan yet, and the weather where they are going.
//
// Nothing here is new information; it is the rest of the app gathered up so
// ops staff do not have to walk four pages to find out what is behind.

import { state } from '../store.js';
import { decideSwap, decidePickup } from '../api.js';
import { esc, zulu, zdate, span, ago, simLocal, icon, rerender } from '../ui.js';
import { round5 } from '../running.js';
import { countdown, poll } from './dash.js';
import {
  sortedSectors,
  crewOf,
  person,
  pilotsShort,
  pilotsNeeded,
  seats,
  canEdit,
  briefingOf,
  running,
  reportAt,
  airport,
  fetchMetar,
  teamSimbrief,
  pendingPickups,
  claimedSwaps,
  isDraft,
  biddingOn,
  biddingOpen,
  bidsCloseAt,
  teamCallsign,
  scheduleDrift,
  swapSector,
  swapEntry,
  wouldBreak,
  defaultReport,
  syncTeam,
} from '../ops.js';
import { renderRoster, mountedRoster, rosterActions, rosterChanges } from './liveroster.js';
import { sendCompany, syncAcars, acarsKnown, acarsReady, acarsOnline, acarsCanPrint, acarsPrinter } from '../acars.js';

// How far ahead the board looks. Beyond this it is planning, not operating.
const AHEAD_HOURS = 24;
const onOps = () => location.hash.startsWith('#/ops');

const name = (id) => esc(person(id)?.display_name || 'Unknown');
// Something is being agreed or turned down; the button waits rather than
// letting it be pressed twice.
let busy = '';
let error = '';
let note = '';
// A company message half written. Kept here so a redraw - the live position
// poll is the usual one - does not take the sentence with it.
let companyDraft = '';
// Which of the board's two views is showing: the status cards, or the Live
// Roster timeline.
let view = 'board';
// Wider main column while the timeline needs the room; app.js reads this.
export const wide = () => view === 'roster';
const when = (t) => `${zdate(t)} ${zulu(t)}`;

const upcoming = (now) => sortedSectors().filter((s) => new Date(s.std) > now);
const soon = (now) => upcoming(now).filter((s) => new Date(s.std) - now < AHEAD_HOURS * 3600000);

// A sector is planned once somebody has imported its flight plan.
const planned = (s) => !!briefingOf(s.id).ofp;

function tile(n, label, href, kind) {
  return `<a class="ops-tile ${n ? kind : 'ok'}" href="${href}">
    <div class="ops-n">${n}</div><div class="tiny">${label}</div></a>`;
}

// The one line that says whether anything needs doing at all.
function summary(now) {
  const list = soon(now);
  const short = upcoming(now).filter(pilotsShort).length;
  const toPlan = list.filter((s) => !planned(s)).length;
  const requests = claimedSwaps().length + pendingPickups().length;
  const defects = state.defects.filter((d) => d.status !== 'RECTIFIED').length;
  return `
    <div class="ops-tiles">
      ${tile(short, short === 1 ? 'SECTOR SHORT' : 'SECTORS SHORT', '#/admin', 'bad')}
      ${tile(toPlan, 'TO PLAN', '#/brief', 'warn')}
      ${tile(requests, requests === 1 ? 'REQUEST' : 'REQUESTS', '#/admin', 'warn')}
      ${tile(defects, defects === 1 ? 'DEFECT' : 'DEFECTS', '#/techlog', 'warn')}
    </div>`;
}

// Who reports next, with the countdown running against the real time including
// any delay, not the published one.
function reports(now) {
  const run = running(now);
  const rows = [];
  for (const s of soon(now)) {
    const row = run.times.get(s.id);
    for (const r of crewOf(s)) {
      const at = run.trusted && row ? reportAt(r, row) : new Date(r.report_at).getTime();
      rows.push({ s, r, at, moved: run.trusted && row && Math.abs(at - new Date(r.report_at)) >= 5 * 60000 });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  if (!rows.length) {
    return `<section class="card"><h2>Reporting next</h2>
      <p class="note">Nobody is due to report in the next ${AHEAD_HOURS} hours.</p></section>`;
  }
  const list = rows
    .slice(0, 10)
    .map(
      ({ s, r, at, moved }) => `
      <a class="row" href="#/roster/${esc(s.id)}">
        <div class="row-main">
          <div class="row-t">${name(r.user_id)} <span class="badge warn">${esc(r.duty.toUpperCase())}</span></div>
          <div class="sub">${esc(s.flight)} · ${esc(s.dep)} → ${esc(s.arr)} · reports ${zulu(at)}${
            moved ? ' (moved by the delay)' : ''
          }</div>
        </div>
        <div class="right">
          <div class="row-t" data-until="${esc(new Date(at).toISOString())}" data-verb="Report">${countdown(
            at,
            now,
            'Report',
          )}</div>
          <div class="sub">${simLocal(at)}</div>
        </div>
      </a>`,
    )
    .join('');
  return `
    <section class="card list">
      <div class="card-head"><h2>Reporting next</h2><span class="badge info">${rows.length}</span></div>
      ${list}
      <p class="tiny">Counting down to the real report time, which moves with the running delay.</p>
    </section>`;
}

// Sectors still short of pilots, worst first: the ones about to go matter most.
function crewing(now) {
  const short = upcoming(now).filter(pilotsShort);
  if (!short.length) {
    return `<section class="card">
      <div class="card-head"><h2>Crewing</h2><span class="badge ok">ALL CREWED</span></div>
      <p class="note">Every upcoming sector has its pilots.</p></section>`;
  }
  const rows = short
    .slice(0, 12)
    .map((s) => {
      const need = pilotsShort(s);
      const have = crewOf(s).filter((r) => seats(s).includes(r.duty));
      const missing = seats(s).filter((d) => !have.some((r) => r.duty === d));
      return `
      <a class="row" href="#/admin/sector/${esc(s.id)}">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} <span class="badge ${
            need >= pilotsNeeded(s) ? 'bad' : 'warn'
          }">NEEDS ${need}</span></div>
          <div class="sub">${esc(s.flight)} · ${when(s.std)} · ${simLocal(s.std)}</div>
          <div class="sub">No ${missing.map((d) => esc(d.toLowerCase())).join(', no ')}</div>
        </div>
        <div class="right"><div class="sub" data-until="${esc(s.std)}">${countdown(s.std, now)}</div>${icon('chevron')}</div>
      </a>`;
    })
    .join('');
  return `
    <section class="card list">
      <div class="card-head"><h2>Crewing</h2><span class="badge warn">${short.length} SHORT</span></div>
      ${rows}
      ${short.length > 12 ? `<p class="tiny">…and ${short.length - 12} more.</p>` : ''}
      ${isDraft() ? '<p class="tiny">The roster is still a draft, so pilots cannot see any of this yet.</p>' : ''}
    </section>`;
}

// Which of the sectors about to go still have no flight plan.
function planning(now) {
  const list = soon(now);
  if (!list.length) {
    return `<section class="card"><h2>Flight plans</h2>
      <p class="note">No sectors due in the next ${AHEAD_HOURS} hours.</p></section>`;
  }
  const rows = list
    .slice(0, 10)
    .map((s) => {
      const b = briefingOf(s.id);
      const ok = planned(s);
      return `
      <a class="row" href="#/brief/${esc(s.id)}">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} <span class="badge ${ok ? 'ok' : 'warn'}">${
            ok ? 'PLANNED' : 'NO PLAN'
          }</span></div>
          <div class="sub">${esc(s.flight)} · ${when(s.std)}</div>
          <div class="sub">${
            ok
              ? `Imported ${b.ofp_at ? ago(new Date(b.ofp_at).getTime()) : ''}${b.ofp_by ? ` by ${esc(b.ofp_by)}` : ''}`
              : teamSimbrief()
                ? 'Nobody has imported the OFP yet'
                : 'No team SimBrief account set'
          }</div>
        </div>
        <div class="right">${icon('chevron')}</div>
      </a>`;
    })
    .join('');
  return `
    <section class="card list">
      <div class="card-head"><h2>Flight plans</h2><span class="badge ${
        list.every(planned) ? 'ok' : 'warn'
      }">${list.filter(planned).length} OF ${list.length}</span></div>
      ${rows}
    </section>`;
}

// The airports the aeroplane is about to use, in the order it uses them.
function airports(now) {
  const codes = [];
  for (const s of soon(now)) {
    for (const code of [s.dep, s.arr]) if (!codes.includes(code)) codes.push(code);
  }
  if (!codes.length) return '';
  const rows = codes
    .slice(0, 8)
    .map((code) => {
      const a = airport(code);
      const m = state.metar[code];
      return `
      <a class="row" href="#/airports/${esc(code)}">
        <div class="row-main">
          <div class="row-t">${esc(code)}<span class="sub"> · ${esc(a?.city || a?.name || '')}</span></div>
          ${
            m
              ? `<pre class="metar">${esc(m.text)}</pre><div class="tiny">${ago(m.at)}</div>`
              : '<div class="sub">Loading weather…</div>'
          }
        </div>
        <div class="right">${icon('chevron')}</div>
      </a>`;
    })
    .join('');
  return `
    <section class="card list">
      <div class="card-head"><h2>Weather</h2><span class="badge info">NEXT ${Math.min(codes.length, 8)} AIRPORTS</span></div>
      ${rows}
      <p class="tiny">METAR from VATSIM. Open an airport for its forecast, who is controlling it and the team's notes.</p>
    </section>`;
}

// Where the aeroplane is, and whether the day is running to time. The ops
// board should answer that without anybody opening the Dashboard.
function aircraft(now) {
  const t = state.track;
  const run = running(now);
  const cs = esc(teamCallsign());
  const late = run.late;
  const lateLine = late
    ? `<p class="note ${late.delay > 0 ? 'warn' : ''}">${late.delay > 0 ? icon('alert') : ''} Running <strong>${span(
        Math.abs(late.delay),
      )} ${late.delay > 0 ? 'behind' : 'ahead of'}</strong> the published schedule · ${esc(late.sector.flight)} ${
        late.state === 'airborne' ? `lands about ${zulu(round5(late.estOn))}` : `now about ${zulu(round5(late.estOff))}`
      }</p>`
    : run.trusted
      ? '<p class="note">Running to the published schedule.</p>'
      : '<p class="note">Nothing stamped and nothing tracked yet, so the published schedule is the best there is.</p>';

  if (!t?.online) {
    const why = t?.at
      ? `Last seen ${ago(t.at)}${t.dep ? `, ${esc(t.dep)} → ${esc(t.arr)}` : ''}.`
      : t?.prefiled
        ? 'A flight plan is filed but nobody is connected yet.'
        : 'Not connected right now.';
    return `
      <section class="card">
        <div class="card-head"><h2>${cs}</h2><span class="badge ${t?.at ? 'warn' : 'mute'}">${
          t?.at ? 'POSITION STALE' : 'OFFLINE'
        }</span></div>
        <p class="note">${why}</p>
        ${lateLine}
      </section>`;
  }
  const pct = t.total ? Math.max(0, Math.min(100, Math.round((1 - t.remaining / t.total) * 100))) : null;
  return `
    <section class="card">
      <div class="card-head"><h2>${cs} · ${esc(t.dep || '----')} → ${esc(t.arr || '----')}</h2>
        <span class="badge ok">${t.source === 'SIM' ? 'SIMULATOR LIVE' : 'VATSIM ONLINE'}</span></div>
      ${pct == null ? '' : `<div class="bar"><div style="width:${pct}%"></div></div>`}
      <div class="kvs">
        <div class="kv"><span>Phase</span><strong>${esc(t.phase || '—')}</strong></div>
        <div class="kv"><span>Altitude</span><strong>${
          t.alt == null ? '—' : t.alt >= 10000 ? `FL${Math.round(t.alt / 100)}` : `${Math.round(t.alt / 10) * 10} FT`
        }</strong></div>
        <div class="kv"><span>Ground speed</span><strong>${t.gs == null ? '—' : `${Math.round(t.gs)} KT`}</strong></div>
        <div class="kv"><span>To go</span><strong>${t.remaining == null ? '—' : `${Math.round(t.remaining)} NM`}</strong></div>
        <div class="kv"><span>Est. arrival</span><strong>${t.eta ? zulu(t.eta) : '—'}</strong></div>
      </div>
      ${lateLine}
      <div class="tiny">Updated ${ago(t.at)}${t.pilotName ? ` · flown by ${esc(t.pilotName)}` : ''}</div>
    </section>`;
}

// Swaps somebody has taken and seats somebody has asked for, with the buttons
// to settle them, so the board is worked from rather than only read.
function requests() {
  const swaps = claimedSwaps().filter((w) => swapSector(w));
  const pickups = pendingPickups().filter((p) => state.sectors.some((x) => x.id === p.sector_id));
  if (!swaps.length && !pickups.length) return '';
  const warn = (breaks) => breaks.map((t) => `<div class="sub warn-text">${icon('alert')} ${esc(t)}</div>`).join('');

  const swapRows = swaps
    .map((w) => {
      const s = swapSector(w);
      const entry = swapEntry(w);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(s.flight)} · ${esc(s.dep)} → ${esc(s.arr)} <span class="badge warn">${esc(
            (entry?.duty || '').toUpperCase(),
          )}</span></div>
          <div class="sub">${name(w.from_user)} → <strong>${name(w.claimed_by)}</strong> · ${when(s.std)}</div>
          ${w.reason ? `<div class="sub">${esc(w.reason)}</div>` : ''}
          ${warn(wouldBreak(w.claimed_by, s))}
        </div>
        <div class="btn-row">
          <button class="btn ghost small" data-act="no" data-kind="swap" data-id="${esc(w.id)}" ${
            busy === w.id ? 'disabled' : ''
          }>Turn down</button>
          <button class="btn primary small" data-act="yes" data-kind="swap" data-id="${esc(w.id)}" ${
            busy === w.id ? 'disabled' : ''
          }>Agree</button>
        </div>
      </div>`;
    })
    .join('');

  const pickupRows = pickups
    .map((p) => {
      const s = state.sectors.find((x) => x.id === p.sector_id);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(s.flight)} · ${esc(s.dep)} → ${esc(s.arr)} <span class="badge warn">${esc(
            p.duty.toUpperCase(),
          )}</span></div>
          <div class="sub"><strong>${name(p.user_id)}</strong> wants the empty seat · ${when(s.std)}</div>
          ${warn(wouldBreak(p.user_id, s))}
        </div>
        <div class="btn-row">
          <button class="btn ghost small" data-act="no" data-kind="pickup" data-id="${esc(p.id)}" ${
            busy === p.id ? 'disabled' : ''
          }>Turn down</button>
          <button class="btn primary small" data-act="yes" data-kind="pickup" data-id="${esc(p.id)}" ${
            busy === p.id ? 'disabled' : ''
          }>Agree</button>
        </div>
      </div>`;
    })
    .join('');

  return `
    <section class="card list slot-card short">
      <div class="card-head"><div class="tiny">WAITING FOR YOU</div>
        <span class="badge warn">${swaps.length + pickups.length}</span></div>
      ${swapRows}${pickupRows}
      <p class="tiny">Agreeing a swap moves the sector across; agreeing a pickup rosters them in the empty seat. A duty rule it would break is shown, and you can agree anyway.</p>
    </section>`;
}

// The state of the aeroplane itself. An aircraft that cannot fly is the
// loudest thing on this page, not a number in a tile.
function defects() {
  const open = state.defects.filter((d) => d.status !== 'RECTIFIED');
  if (!open.length) return '';
  const aog = open.some((d) => d.aog);
  const rows = open
    .map(
      (d) => `
      <a class="row" href="#/techlog/${esc(d.id)}">
        <div class="row-main">
          <div class="row-t">${esc(d.ref)} · ${esc(d.desc)}</div>
          ${d.restriction ? `<div class="sub">Restriction: <strong>${esc(d.restriction)}</strong></div>` : ''}
          ${d.melItem ? `<div class="sub">MEL ${esc(d.melItem)}${d.due ? ` · fix by ${zdate(d.due)}` : ''}</div>` : ''}
        </div>
        <div class="right stack"><span class="badge ${d.status === 'OPEN' ? 'bad' : 'warn'}">${esc(d.status)}</span>
          ${d.aog ? '<span class="badge bad">AOG</span>' : ''}</div>
      </a>`,
    )
    .join('');
  return `
    <section class="card list ${aog ? 'slot-card short' : ''}">
      <div class="card-head"><div class="tiny">AIRCRAFT STATUS</div>
        <span class="badge ${aog ? 'bad' : 'warn'}">${aog ? 'UNSERVICEABLE' : `${open.length} OPEN`}</span></div>
      ${aog ? `<p class="note warn">${icon('alert')} <strong>The aircraft is unserviceable.</strong> It cannot fly until the defect below is cleared or deferred.</p>` : ''}
      ${rows}
    </section>`;
}

// The tech log sits at the foot of the page, which is the right place for a
// deferred defect and the wrong one for an aeroplane that cannot fly. So that
// one case keeps a line at the top.
function aogBanner() {
  const aog = state.defects.filter((d) => d.status !== 'RECTIFIED' && d.aog);
  if (!aog.length) return '';
  return `<a class="banner bad" href="#/techlog">${icon('alert')}
    <span><strong>Aircraft unserviceable</strong> · ${esc(aog[0].ref)} ${esc(aog[0].desc)}${
      aog.length > 1 ? ` and ${aog.length - 1} more` : ''
    }</span>${icon('chevron')}</a>`;
}

// WorldFlight moving the programme is ops work, so it belongs here too.
function official() {
  if (!state.sectors.length) return '';
  const { total, changed, added } = scheduleDrift();
  if (!total) return '';
  return `<a class="banner warn" href="#/schedule/edit">${icon('calendar')}
    <span><strong>WorldFlight has changed the schedule</strong> · ${
      changed.length ? `${changed.length} sector${changed.length === 1 ? '' : 's'} moved` : ''
    }${changed.length && added.length ? ', ' : ''}${
      added.length ? `${added.length} new` : ''
    } · open to review and apply</span>${icon('chevron')}</a>`;
}

// The status cards: everything the board showed before the Landscape view
// timeline joined it as a second view.
// Ops to the crew. The datalink itself is worked from the cockpit, but this
// one message goes the other way, so it lives here rather than on a page ops
// have no other reason to open. It is not queued for the simulator PC: it is
// written straight into the window both sides read, and the printer is asked
// separately, so it works with the sim switched off (see sendCompany in
// js/acars.js and supabase/acars.sql).
function company() {
  // The first read has come back and this database has no ACARS tables, so
  // there is nothing to send with. Say nothing rather than offer a dead form.
  if (acarsKnown() && !acarsReady()) return '';
  const sending = busy === 'company';
  const online = acarsOnline();
  return `
    <section class="card acars-send">
      <div class="card-head"><h2>Message the flight deck</h2>
        <span class="badge ${online ? 'ok' : 'mute'}">${online ? 'DATALINK UP' : 'SIM PC OFFLINE'}</span></div>
      <form class="card-form" data-form="company">
        <label class="field">ACARS company message
          <textarea name="message" rows="3" maxlength="900" required
            placeholder="e.g. SLOT REVISED 1420Z. EXPECT STAND 32 ON ARRIVAL."
            data-change="companyDraft">${esc(companyDraft)}</textarea></label>
        <p class="tiny">Up to 900 characters. ${
          online
            ? acarsCanPrint() && acarsPrinter().found
              ? 'Goes to the flight deck ACARS window and asks the receipt printer for a strip.'
              : 'Goes to the flight deck ACARS window. The printer is unavailable, so a strip cannot be confirmed.'
            : 'The simulator PC is disconnected. The message is saved for the crew to read in ACARS; it will not print automatically later.'
        } Company traffic takes 10 to 75 seconds to go through, as it would on the real network.</p>
        <button class="btn primary" type="submit" ${sending ? 'disabled' : ''}>${
          sending ? 'Transmitting…' : 'Send to flight deck'
        }</button>
      </form>
    </section>`;
}

function board(now) {
  return `
    ${
      biddingOn() && biddingOpen(now)
        ? `<p class="note warn">${icon('alert')} Bidding is open until <strong>${when(
            bidsCloseAt(),
          )}</strong>. The roster cannot be published until it closes.</p>`
        : ''
    }
    ${aogBanner()}
    ${official()}
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${note ? `<p class="note ok">${icon('check')} ${esc(note)}</p>` : ''}
    ${summary(now)}
    ${aircraft(now)}
    ${company()}
    ${requests()}
    ${reports(now)}
    ${crewing(now)}
    ${planning(now)}
    ${airports(now)}
    ${defects()}
    <p class="tiny center">Everything here looks ${AHEAD_HOURS} hours ahead, except crewing, which looks at the whole schedule.</p>`;
}

export function render() {
  if (!canEdit()) {
    return `<div class="page-head"><h1>Ops board</h1></div>
      <section class="card"><p class="note">This page is for admins, dispatchers and operations.</p></section>`;
  }
  const now = Date.now();
  return `
    <div class="page-head"><h1>Ops board</h1>
      <span class="badge ${isDraft() ? 'warn' : 'ok'}">ROSTER ${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span></div>
    <nav class="seg seg-inline" aria-label="Ops board view">
      <button type="button" class="${view === 'board' ? 'on' : ''}" data-act="viewBoard">Overview</button>
      <button type="button" class="${view === 'roster' ? 'on' : ''}" data-act="viewRoster">Landscape</button>
    </nav>
    ${view === 'roster' ? renderRoster() : board(now)}`;
}

async function settle(id, work) {
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
  yes(el) {
    const { id, kind } = el.dataset;
    if (kind === 'swap') return settle(id, () => decideSwap(id, true));
    const p = pendingPickups().find((x) => x.id === id);
    const s = p && state.sectors.find((x) => x.id === p.sector_id);
    return settle(id, () => decidePickup(id, true, '', s ? defaultReport(s).toISOString() : null));
  },
  no(el) {
    const { id, kind } = el.dataset;
    const why = prompt('Turn this down? You can say why (optional).', '');
    if (why === null) return;
    return settle(id, () => (kind === 'swap' ? decideSwap(id, false, why) : decidePickup(id, false, why)));
  },
  viewBoard() {
    view = 'board';
    rerender();
  },
  viewRoster() {
    view = 'roster';
    rerender();
  },
  ...rosterActions,
};

export const changes = {
  companyDraft(el) {
    companyDraft = el.value;
  },
  ...rosterChanges,
};

export const forms = {
  company(data) {
    if (busy) return;
    const message = String(data.get('message') || '').trim();
    if (!message || [...message].length > 900) {
      error = 'Enter a message of 1 to 900 characters.';
      note = '';
      return rerender();
    }
    companyDraft = message;
    busy = 'company';
    error = '';
    note = '';
    rerender();
    // sendCompany answers with the database's own words rather than throwing,
    // so a refusal - not ops, nothing typed, too long for one strip - is shown
    // as it was given.
    return sendCompany(message)
      .then((result) => {
        if (result.ok) {
          companyDraft = '';
          note = 'Company message sent to the flight deck.';
        } else {
          error = result.error;
        }
      })
      .catch((err) => {
        error = err.message;
      })
      .finally(() => {
        busy = '';
        if (onOps()) rerender();
      });
  },
};

// The weather is the only thing the Overview has to go and get; the Live
// Roster needs its own drag-and-drop wired up once it is in the DOM.
// The datalink is read once when the board opens, so the composer can say
// whether the simulator PC is actually there. The board does not sit on the
// station the way the flight deck's ACARS page does; the send itself reports
// what really happened either way.
let acarsRead = false;

export function mounted(root) {
  if (!canEdit()) return;
  if (!acarsRead) {
    acarsRead = true;
    syncAcars()
      .catch(() => {})
      .then(() => onOps() && rerender());
  }
  poll();
  if (view === 'roster') {
    mountedRoster(root);
    return;
  }
  const now = Date.now();
  const codes = [];
  for (const s of soon(now)) {
    for (const code of [s.dep, s.arr]) if (!codes.includes(code)) codes.push(code);
  }
  const stale = codes.slice(0, 8).filter((c) => !state.metar[c] || now - state.metar[c].at > 10 * 60000);
  if (!stale.length) return;
  Promise.allSettled(stale.map((c) => fetchMetar(c))).then(() => onOps() && rerender());
}
