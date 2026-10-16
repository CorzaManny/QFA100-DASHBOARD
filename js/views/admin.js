// Admin section: build the roster and manage team roles.
// Admins and dispatchers edit the roster; only admins change roles.

import { state } from '../store.js';
import {
  saveRoster,
  deleteRoster,
  setRole,
  createAccount,
  removeAccount,
  saveSettings,
  saveRosterMany,
  clearAutoRoster,
  clearRosterFor,
  decideSwap,
  clearActuals,
  decidePickup,
} from '../api.js';
import { DEFAULT_RULES, planRoster, problems, isBoc } from '../autoroster.js';
import { esc, zulu, zdate, depWindow, simLocal, span, isoDate, isoTime, icon, rerender } from '../ui.js';
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
  pilotsNeeded,
  needsRelief,
  seats,
  workload,
  flyers,
  rosterable,
  claimedSwaps,
  openSwaps,
  swapSector,
  swapEntry,
  wouldBreak,
  defaultReport,
  pendingPickups,
  rules,
  teamCallsign,
  teamAircraft,
  teamSimbrief,
  canSetSimbrief,
  teamAirframe,
  simbriefPlanUrl,
  isDraft,
  biddingOn,
  biddingOpen,
  bidsCloseAt,
  prefOf,
  PILOT_DUTIES,
  syncTeam,
  pendingPeople,
} from '../ops.js';
import { renderRoster, mountedRoster, rosterActions, rosterChanges } from './liveroster.js';

let error = '';
let result = '';
let gapNote = '';
let filter = 'all';
// Which of the Roster tab's two views is showing: the sector list, or the
// Landscape view timeline.
let rosterView = 'list';
// Wider main column while the timeline needs the room; app.js reads this.
export const wide = (args) => rosterView === 'timeline' && (!args[0] || args[0] === 'auto');

const when = (t) => `${zdate(t)} ${zulu(t)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A password worth giving somebody: easy to read out, hard to guess.
const newPassword = () => `qfa${Math.random().toString(36).slice(2, 8)}${Math.floor(Math.random() * 90 + 10)}`;
// The account just made, shown once so the admin can pass it on.
let madeAccount = null;
let suggestedPassword = newPassword();
const name = (id) => esc(person(id)?.display_name || 'Unknown');
const sectorCount = (userId) => state.roster.filter((r) => r.user_id === userId).length;

// "4 sectors · 2 CA, 1 FO, 1 RP", for a drop-down or a line of text.
const SEAT_SHORT = { Captain: 'CA', 'First Officer': 'FO', 'Relief Pilot': 'RP' };
function tally(load) {
  const seated = Object.entries(SEAT_SHORT)
    .filter(([duty]) => load[duty])
    .map(([duty, short]) => `${load[duty]} ${short}`)
    .join(', ');
  return `${load.total} sector${load.total === 1 ? '' : 's'}${seated ? ` · ${seated}` : ''}`;
}

function tabs(active) {
  const tab = (key, href, label) => `<a class="${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  const waiting = pendingPeople().length;
  return `
    <div class="page-head"><h1>Admin</h1>
      <span class="badge ${isDraft() ? 'warn' : 'ok'}">ROSTER ${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span></div>
    <nav class="seg on-card tabs5">
      ${tab('roster', '#/admin', 'Roster')}
      ${tab('balance', '#/admin/balance', 'Balance')}
      ${canSetSimbrief() ? tab('simbrief', '#/admin/simbrief', 'SimBrief') : ''}
      ${isAdmin() ? tab('rules', '#/admin/rules', 'Settings') : ''}
      ${isAdmin() ? tab('people', '#/admin/people', `People${waiting ? ` (${waiting})` : ''}`) : ''}
    </nav>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${result ? `<p class="note ok">${esc(result)}</p>` : ''}`;
}

// What someone is already rostered to fly, for the duty-rule checks.
const flownBy = (userId) => {
  const byId = new Map(state.sectors.map((x) => [x.id, x]));
  return state.roster
    .filter((r) => r.user_id === userId && PILOT_DUTIES.includes(r.duty) && byId.has(r.sector_id))
    .map((r) => byId.get(r.sector_id));
};

function autoPanels() {
  const now = Date.now();
  const upcoming = sortedSectors().filter((x) => new Date(x.std) > now);
  const r = rules();
  const pilots = flyers();
  const answered = pilots.filter((p) => upcoming.some((x) => prefOf(p.id, x.id)));
  const autoCount = state.roster.filter((x) => x.auto).length;
  const empty = upcoming.reduce((n, x) => n + seats(x).filter((seat) => !crewOf(x).some((c) => c.duty === seat)).length, 0);

  const responses = pilots
    .map((p) => {
      const n = { prefer: 0, available: 0, unavailable: 0, none: 0 };
      for (const x of upcoming) n[prefOf(p.id, x.id) || 'none'] += 1;
      return `
      <a class="row" href="#/availability/${esc(p.id)}">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}</div>
          <div class="sub">${n.prefer} prefer · ${n.available} available · ${n.unavailable} can't · ${n.none} ${r.unmarkedAvailable ? 'not said' : 'blank'}</div>
        </div>
        <div class="right">${
          n.none === upcoming.length
            ? `<span class="badge ${r.unmarkedAvailable ? 'mute' : 'warn'}">${r.unmarkedAvailable ? 'ALL AVAILABLE' : 'NO ANSWER'}</span>`
            : ''
        } ${icon('chevron')}</div>
      </a>`;
    })
    .join('');

  const breaks = pilots
    .map((p) => [p, problems(flownBy(p.id), r)])
    .filter(([, list]) => list.length)
    .map(([p, list]) => `<div class="row"><div class="row-main"><div class="row-t">${esc(p.display_name)}</div>${list.map((t) => `<div class="sub">${esc(t)}</div>`).join('')}</div></div>`)
    .join('');

  return [
    `<section class="card">
      <div class="card-head"><h2>Roster state</h2><span class="badge ${isDraft() ? 'warn' : 'ok'}">${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span></div>
      <p class="note">${
        isDraft()
          ? 'The roster is a draft. Pilots cannot see it; they can only fill in their availability. Publish it when it is ready.'
          : 'The roster is published and everyone can see it. Move it back to draft to hide it while you rework it.'
      }</p>
      ${
        isDraft() && biddingOpen()
          ? `<p class="note warn">${icon('alert')} Bidding is open until <strong>${zdate(bidsCloseAt())} ${zulu(
              bidsCloseAt(),
            )}</strong>. The roster can be published once it closes.</p>`
          : ''
      }
      <button class="btn ${isDraft() ? 'primary' : 'ghost'}" data-act="state" data-state="${isDraft() ? 'published' : 'draft'}" ${
        isDraft() && biddingOpen() ? 'disabled' : ''
      }>${isDraft() ? 'Publish roster' : 'Move back to draft'}</button>
    </section>`,
    `<section class="card">
      <h2>Auto roster</h2>
      <p class="note"><strong>${empty}</strong> empty pilot seats on ${upcoming.length} upcoming sectors${
        r.reliefOverHours > 0 ? `, counting a relief pilot on sectors over ${r.reliefOverHours} hours` : ''
      }. Auto roster fills them from everyone's availability and the rules. Anyone you have already rostered stays exactly where they are.</p>
      <div class="btn-row">
        <button class="btn primary" data-act="auto" ${empty ? '' : 'disabled'}>Auto roster the gaps</button>
        <button class="btn danger" data-act="clearAuto" ${autoCount ? '' : 'disabled'}>Clear ${autoCount} auto-rostered</button>
      </div>
      ${gapNote ? `<p class="note warn">${icon('alert')} ${esc(gapNote)}</p>` : ''}
      <p class="tiny">To keep somebody on a particular sector, roster them below first: Auto roster never moves anyone. Clearing removes only what it placed.</p>
    </section>`,
    `<section class="card list">
      <div class="card-head"><div class="tiny">AVAILABILITY RECEIVED</div><span class="badge ${answered.length === pilots.length ? 'ok' : r.unmarkedAvailable ? 'mute' : 'warn'}">${answered.length} OF ${pilots.length}</span></div>
      ${responses || '<p class="note">No pilots yet.</p>'}
      <p class="tiny">Open someone to see or set their availability for them.</p>
    </section>`,
    `<section class="card list">
      <div class="card-head"><div class="tiny">RULE CHECK</div><span class="badge ${breaks ? 'bad' : 'ok'}">${breaks ? 'BREAKS FOUND' : 'ALL WITHIN RULES'}</span></div>
      ${breaks || '<p class="note">Nobody on the roster breaks a duty rule.</p>'}
    </section>`,
  ];
}

// How evenly the flying is shared out, and who is carrying what.
function balancePage() {
  const pilots = flyers();
  const loads = pilots
    .map((p) => ({ p, load: workload(p.id) }))
    .sort((a, b) => b.load.total - a.load.total || a.p.display_name.localeCompare(b.p.display_name));
  const flying = loads.filter((x) => x.load.total);
  const spread = (pick) => {
    const values = flying.map((x) => pick(x.load));
    return values.length ? Math.max(...values) - Math.min(...values) : 0;
  };
  const r = rules();
  const total = loads.reduce((n, x) => n + x.load.total, 0);
  const rows = loads
    .map(
      ({ p, load }) => `
      <tr class="${load.total ? '' : 'dim'}">
        <td>${esc(p.display_name)}</td>
        <td class="num">${load.total}</td>
        <td class="num">${load.Captain}</td>
        <td class="num">${load['First Officer']}</td>
        <td class="num">${load['Relief Pilot']}</td>
        <td class="num">${load.hours.toFixed(1)}</td>
        <td class="num">${load.boc}</td>
      </tr>`,
    )
    .join('');
  const gap = (label, value, within) =>
    `<span class="badge ${value <= within ? 'ok' : 'warn'}">${label}: ${value <= within ? 'even' : `${value} apart`}</span>`;

  return `
    ${tabs('balance')}
    <section class="card">
      <h2>Share of the flying</h2>
      <p class="note">${plural(total, 'pilot seat')} rostered across ${plural(flying.length, 'pilot')}. A roster is fair when the totals, and the Captain and First Officer counts, are within one or two of each other.</p>
      <div class="chips">
        ${gap('Sectors', spread((l) => l.total), 1)}
        ${gap('Captain', spread((l) => l.Captain), 1)}
        ${gap('First Officer', spread((l) => l['First Officer']), 1)}
        ${gap('Back of clock', spread((l) => l.boc), 1)}
      </div>
      <div class="mel-scroll">
        <table class="tally">
          <thead><tr><th>Pilot</th><th class="num">Sec</th><th class="num">CA</th><th class="num">FO</th><th class="num">RP</th><th class="num">Hrs</th><th class="num">BOC</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7">No pilots yet.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="tiny">Sec sectors, CA Captain, FO First Officer, RP relief pilot, Hrs block hours, BOC back-of-clock sectors (${String(r.bocStart).padStart(2, '0')}00 to ${String(r.bocEnd).padStart(2, '0')}00 sim local). Hours are block time. Past sectors are counted too.</p>
    </section>`;
}

// Wipes every stamped off and on block time, e.g. after testing the stamp
// buttons. The published schedule is never touched.
function resetTimesCard() {
  const stamped = (state.actuals || []).filter((a) => a.off_blocks || a.on_blocks || a.skipped).length;
  return `
    <section class="card">
      <div class="card-head"><h2>Off and on block times</h2><span class="badge ${stamped ? 'warn' : 'mute'}">${stamped} STAMPED</span></div>
      <p class="note">Clears every off and on block time stamped so far, so every sector goes back to its published times. Use it after testing the stamp buttons. The schedule itself is not changed.</p>
      <div class="btn-row"><button class="btn danger" data-act="clearAllTimes" ${stamped ? '' : 'disabled'}>Clear all stamped times</button></div>
    </section>`;
}

// The aeroplane, the team's SimBrief account and the addresses the app talks
// to SimBrief on. Admins and operations only: this is the team's identity,
// not everyday roster work.
function simbriefPage() {
  if (!canSetSimbrief()) {
    return `${tabs('roster')}<section class="card"><p class="note">The aeroplane and SimBrief are set by an admin or operations.</p></section>`;
  }
  const s = state.settings || {};
  return `
    ${tabs('simbrief')}
    <form class="card form" data-form="aircraft">
      <h2>The aeroplane</h2>
      <p class="note">One callsign, one aircraft and one SimBrief account for the whole team. Everybody's app follows these; nobody sets their own.</p>
      <div class="grid2">
        <label class="field">VATSIM callsign<input name="callsign" required autocapitalize="characters" maxlength="10" value="${esc(teamCallsign())}">
          <span class="tiny">Tracked on the Dashboard, and sent to SimBrief as the callsign</span></label>
        <label class="field">Aircraft type (ICAO)<input name="aircraft" required autocapitalize="characters" maxlength="4" value="${esc(teamAircraft())}">
          <span class="tiny">Used for SimBrief and the tech log</span></label>
      </div>
      <label class="field">Team SimBrief username or Pilot ID<input name="simbrief" autocapitalize="none" autocorrect="off" value="${esc(teamSimbrief())}" placeholder="Not set yet">
        <span class="tiny">The one account every flight plan is imported from</span></label>
      <label class="field">Custom airframe (optional)<input name="airframe" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(teamAirframe())}" placeholder="e.g. 123456_1582090020">
        <span class="tiny">The airframe's <strong>internal ID</strong>, from Aircraft in the team's SimBrief account. Set it and SimBrief plans with that aeroplane's own weights, layout and registration instead of a generic ${esc(teamAircraft())}. Leave it empty to use the type above.</span></label>
      <div class="btn-row"><button class="btn primary" type="submit">Save the aeroplane</button></div>
    </form>
    <section class="card">
      <h2>What this looks like</h2>
      <p class="note">The next sector, as <strong>Plan in SimBrief</strong> would open it:</p>
      <pre class="metar">${esc(example())}</pre>
    </section>`;
}

// The real link for the next sector, so a change can be seen before it is used.
function example() {
  const next = sortedSectors().find((x) => new Date(x.std) > Date.now()) || sortedSectors()[0];
  return next ? simbriefPlanUrl(next) : 'No sectors in the schedule yet.';
}

function rulesPage() {
  // The aeroplane, the duty rules and the stamped times belong to the whole
  // team, so they are an admin's to change rather than a dispatcher's.
  if (!isAdmin()) {
    return `${tabs('roster')}<section class="card"><p class="note">The team's settings are changed by an admin.</p></section>`;
  }
  const r = rules();
  const num = (name, label, hint, step = 1) =>
    `<label class="field">${label}<input type="number" name="${name}" min="0" step="${step}" required value="${esc(r[name])}"><span class="tiny">${hint}</span></label>`;
  return `
    ${tabs('rules')}
    ${resetTimesCard()}
    <form class="card form" data-form="bidding">
      <div class="card-head"><h2>Bidding</h2><span class="badge ${
        biddingOn() ? (biddingOpen() ? 'warn' : 'ok') : 'mute'
      }">${biddingOn() ? (biddingOpen() ? 'OPEN' : 'CLOSED') : 'OFF'}</span></div>
      <p class="note">Give the team a deadline for their availability. Until it passes everyone can bid and the roster cannot be published; after it, availability is sealed and you build the roster from it. Ops staff can still change somebody's availability afterwards.</p>
      <label class="check"><input type="checkbox" name="enabled" ${state.settings?.bidding_enabled ? 'checked' : ''}> Use a bidding deadline</label>
      <div class="grid2">
        <label class="field">Bidding closes, date (UTC)<input type="date" name="closeDate" value="${
          state.settings?.bids_close_at ? isoDate(state.settings.bids_close_at) : ''
        }"></label>
        <label class="field">Bidding closes, time (UTC)<input type="time" name="closeTime" value="${
          state.settings?.bids_close_at ? isoTime(state.settings.bids_close_at) : ''
        }"></label>
      </div>
      <p class="form-error" hidden></p>
      <div class="btn-row"><button class="btn primary" type="submit">Save bidding</button></div>
      <p class="tiny">${
        biddingOn()
          ? biddingOpen()
            ? `Everyone sees a banner counting down to ${zdate(bidsCloseAt())} ${zulu(bidsCloseAt())}.`
            : 'Bidding has closed. Availability is sealed and the roster can be published.'
          : 'Switched off: availability can be changed at any time and the roster can be published whenever you like.'
      }</p>
    </form>
    <form class="card form" data-form="rules">
      <h2>Duty rules</h2>
      <p class="note">Auto roster follows these, and the rule check flags anyone rostered by hand who breaks them. They apply to the whole team.</p>
      <div class="grid2">
        ${num('restHours', 'Minimum rest (hours)', 'A break this long ends a duty', 0.5)}
        ${num('maxSectorsPerDuty', 'Sectors per duty', 'Before a rest is needed')}
        ${num('maxDutyHours', 'Longest duty (hours)', 'Report to last arrival', 0.5)}
        ${num('maxSectors', 'Sectors per person', 'For the event; 0 = no limit')}
        ${num('reliefOverHours', 'Relief pilot over (hours)', 'Sectors longer than this carry three pilots; 0 = never', 0.5)}
      </div>
      <h3>Running on the day</h3>
      <div class="grid2">
        ${num('turnaroundMinutes', 'Minimum turnaround (minutes)', 'On the ground between two sectors', 5)}
        ${num('taxiInMinutes', 'Taxi in (minutes)', 'Landing to on blocks, for live estimates')}
      </div>
      <p class="tiny">These two work out how a late sector moves the ones after it. The published schedule is never changed.</p>
      <h3>Notifications</h3>
      <div class="grid2">
        ${num('reportReminderMinutes', 'Remind before report (minutes)', '0 = no reminder', 5)}
        ${num('delayNoticeMinutes', 'Tell about a delay over (minutes)', 'How far a report time must move', 5)}
      </div>
      <p class="tiny">Only people who have turned notifications on, on a device, are sent anything. See <a href="#/settings">Settings</a>.</p>
      <h3>Back of the clock (sim local time)</h3>
      <div class="grid2">
        ${num('bocStart', 'Starts at hour', '0 to 23')}
        ${num('bocEnd', 'Ends at hour', '0 to 23')}
      </div>
      <div class="grid2">
        ${num('maxBoc', 'Back-of-clock sectors per person', 'For the whole event; 0 = no limit')}
        ${num('bocEveryDays', 'One back of clock every (days)', '2 = never on consecutive nights; 0 = no limit')}
      </div>
      <p class="tiny">A sector is back of clock if any of it is flown in that window. A night runs midday to midday, sim local time.</p>
      <h3>Report time</h3>
      <div class="grid2">
        ${num('reportLeadMinutes', 'Minutes before departure', 'Before the window opens', 5)}
        ${num('firstReportLeadMinutes', 'First sector of the event', 'Minutes before departure', 5)}
      </div>
      <label class="check"><input type="checkbox" name="unmarkedAvailable" ${r.unmarkedAvailable ? 'checked' : ''}> Everyone is available unless they say otherwise</label>
      <div class="btn-row">
        <button class="btn primary" type="submit">Save rules</button>
        <button class="btn ghost" type="button" data-act="resetRules">Back to defaults</button>
      </div>
    </form>`;
}

function needBadge(s) {
  const short = pilotsShort(s);
  return short
    ? `<span class="badge warn">NEEDS ${short} PILOT${short === 1 ? '' : 'S'}</span>`
    : '<span class="badge ok">CREWED</span>';
}

// Everyone who could take a seat on one sector: what they said about it, what
// they are already flying, and every duty rule rostering them would break.
function candidates(s) {
  const r = rules();
  return flyers()
    .map((p) => {
      const mine = flownBy(p.id);
      const already = mine.some((x) => x.id === s.id);
      // What this sector costs them: the rules broken with it that are not
      // already broken without it. Works the same whether they are on it or not.
      const without = already ? mine.filter((x) => x.id !== s.id) : mine;
      const base = problems(without, r);
      const choice = prefOf(p.id, s.id) || 'none';
      const breaks = problems(already ? mine : [...mine, s], r).filter((text) => !base.includes(text));
      const said = choice === 'unavailable' || (choice === 'none' && !r.unmarkedAvailable);
      return {
        p,
        choice,
        load: workload(p.id),
        breaks,
        already,
        // Why Auto roster would pass them over. Rostering them by hand still works.
        blocked: said || breaks.length > 0,
        reason: said
          ? choice === 'unavailable'
            ? "They said they can't fly this sector"
            : 'They have not said they are available'
          : '',
      };
    })
    .sort((a, b) => a.load.total - b.load.total || a.p.display_name.localeCompare(b.p.display_name));
}

// The drop-down groups, in the order they are offered. What a blank means
// depends on the team's rule, so the wording follows it.
const groups = () => [
  ['prefer', 'Asked for this sector'],
  ['available', 'Said they are available'],
  ['none', rules().unmarkedAvailable ? 'Available (has not said)' : 'Has not answered'],
  ['unavailable', "Said they can't fly it"],
];

// One seat's drop-down, with the candidates grouped by what they told us.
function seat(s, duty, fit) {
  const crew = crewOf(s);
  const holder = crew.find((r) => r.duty === duty);
  const elsewhere = new Set(crew.filter((r) => r.duty !== duty).map((r) => r.user_id));
  const options = groups().map(([key, label]) => {
    const rows = fit
      .filter((f) => f.choice === key && (!elsewhere.has(f.p.id) || f.p.id === holder?.user_id))
      .map(
        (f) =>
          `<option value="${esc(f.p.id)}" ${f.p.id === holder?.user_id ? 'selected' : ''}>${esc(f.p.display_name)} · ${tally(f.load)}${
            f.breaks.length ? ' · breaks a rule' : ''
          }</option>`,
      )
      .join('');
    return rows ? `<optgroup label="${label}">${rows}</optgroup>` : '';
  }).join('');
  // Anyone already in the seat who is not a flyer (an observer, say) must stay listed.
  const odd =
    holder && !fit.some((f) => f.p.id === holder.user_id)
      ? `<option value="${esc(holder.user_id)}" selected>${name(holder.user_id)}</option>`
      : '';
  const chosen = holder && fit.find((f) => f.p.id === holder.user_id);
  return `<label class="field">${duty}
    <select data-change="seat" data-sector="${esc(s.id)}" data-duty="${duty}">
      <option value="">Not assigned</option>${odd}${options}
    </select>
    ${
      chosen
        ? `<span class="tiny ${chosen.breaks.length ? 'warn-text' : ''}">${tally(chosen.load)}${
            chosen.breaks.length ? ` · ${esc(chosen.breaks[0])}` : ` · ${chosen.choice === 'none' ? blankWord() : CHOICE_WORDS[chosen.choice]}`
          }</span>`
        : ''
    }</label>`;
}

const CHOICE_WORDS = { prefer: 'asked for this sector', available: 'available', unavailable: "can't fly it", none: 'has not answered' };
const blankWord = () => (rules().unmarkedAvailable ? 'available until they say otherwise' : 'has not answered');

// Somebody has offered a sector and somebody else has taken it: all that is
// left is for ops to agree.
// Pilots asking for an empty seat, waiting for an admin or dispatcher.
function pickupRows() {
  return pendingPickups()
    .map((p) => {
      const s = state.sectors.find((x) => x.id === p.sector_id);
      if (!s) return '';
      const breaks = wouldBreak(p.user_id, s);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(s.flight)} · ${esc(s.dep)} → ${esc(s.arr)} <span class="badge warn">${esc(p.duty.toUpperCase())}</span></div>
          <div class="sub"><strong>${name(p.user_id)}</strong> wants the empty seat · ${when(s.std)}</div>
          ${breaks.map((t) => `<div class="sub warn-text">${icon('alert')} ${esc(t)}</div>`).join('')}
        </div>
        <div class="btn-row">
          <button class="btn ghost small" data-act="pickupNo" data-id="${esc(p.id)}">Turn down</button>
          <button class="btn primary small" data-act="pickupYes" data-id="${esc(p.id)}">Agree</button>
        </div>
      </div>`;
    })
    .join('');
}

function swapsCard() {
  const waiting = claimedSwaps().filter((w) => swapSector(w));
  const open = openSwaps().filter((w) => swapSector(w));
  const pickups = pickupRows();
  const toAgree = waiting.length + pendingPickups().length;
  if (!toAgree && !open.length) return '';
  const rows = waiting
    .map((w) => {
      const s = swapSector(w);
      const entry = swapEntry(w);
      const breaks = wouldBreak(w.claimed_by, s);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(s.flight)} · ${esc(s.dep)} → ${esc(s.arr)} <span class="badge warn">${esc((entry?.duty || '').toUpperCase())}</span></div>
          <div class="sub">${name(w.from_user)} → <strong>${name(w.claimed_by)}</strong> · ${when(s.std)}</div>
          ${w.reason ? `<div class="sub">${esc(w.reason)}</div>` : ''}
          ${breaks.map((t) => `<div class="sub warn-text">${icon('alert')} ${esc(t)}</div>`).join('')}
        </div>
        <div class="btn-row">
          <button class="btn ghost small" data-act="swapNo" data-id="${esc(w.id)}">Turn down</button>
          <button class="btn primary small" data-act="swapYes" data-id="${esc(w.id)}">Agree</button>
        </div>
      </div>`;
    })
    .join('');
  const waitingList = open
    .map((w) => {
      const s = swapSector(w);
      return `<div class="row"><div class="row-main">
        <div class="row-t">${esc(s.flight)} · ${esc(s.dep)} → ${esc(s.arr)}</div>
        <div class="sub">${name(w.from_user)} cannot fly it. Nobody has taken it yet.</div>
      </div><div class="right"><a class="tiny" href="#/admin/sector/${esc(s.id)}">Roster it</a></div></div>`;
    })
    .join('');
  return `
    <section class="card list ${toAgree ? 'slot-card short' : ''}">
      <div class="card-head"><div class="tiny">SWAPS AND PICKUPS</div>
        <span class="badge ${toAgree ? 'warn' : 'mute'}">${toAgree ? `${toAgree} TO AGREE` : `${open.length} WAITING FOR COVER`}</span></div>
      ${rows}${pickups}${waitingList}
      <p class="tiny">Agreeing a swap moves the sector to the person taking it and tells them both. Agreeing a pickup rosters the pilot in the empty seat. A rule it would break is shown, and you can agree anyway.</p>
    </section>`;
}

// The toggle between the sector-by-sector list and the Landscape view timeline.
function rosterToggle() {
  return `<nav class="seg ops-toggle" aria-label="Roster view">
    <button type="button" class="${rosterView === 'list' ? 'on' : ''}" data-act="viewList">List</button>
    <button type="button" class="${rosterView === 'timeline' ? 'on' : ''}" data-act="viewTimeline">Landscape</button>
  </nav>`;
}

// The list of sectors to roster. Open one to crew it.
function rosterEditor() {
  if (rosterView === 'timeline') {
    // Publishing and Auto roster matter just as much from here, so they come
    // along rather than forcing a trip back to the list for them.
    const [state_, auto_] = autoPanels();
    return `${tabs('roster')}${rosterToggle()}${state_}${auto_}${renderRoster()}`;
  }

  const now = Date.now();
  const upcoming = sortedSectors().filter((s) => new Date(s.sta) > now);
  const short = upcoming.filter(pilotsShort);
  // Sectors already flown, newest first: the logbook follows the roster, so
  // this is where a seat somebody else actually sat in gets put right.
  const flown = sortedSectors()
    .filter((s) => new Date(s.sta) <= now)
    .reverse();
  const shown = filter === 'short' ? short : filter === 'flown' ? flown : upcoming;
  const r = rules();

  let day = '';
  const rows = shown
    .map((s) => {
      const header = zdate(s.std) === day ? '' : `<div class="list-day">${(day = zdate(s.std))}</div>`;
      const crew = crewOf(s);
      const keen = candidates(s).filter((f) => f.choice === 'prefer').length;
      return `${header}
      <a class="row" href="#/admin/sector/${esc(s.id)}">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)}</div>
          <div class="sub">${esc(s.flight)} · ${zulu(s.std)} · ${simLocal(s.std)} · ${span(new Date(s.sta) - new Date(s.std))}${
            isBoc(s, r) ? ' · back of clock' : ''
          }</div>
          ${
            crew.length
              ? crew.map((c) => `<div class="sub crew-line">${name(c.user_id)} · ${esc(c.duty)}</div>`).join('')
              : '<div class="sub crew-line">Nobody rostered yet</div>'
          }
          ${keen ? `<div class="sub">${plural(keen, 'pilot')} asked for this sector</div>` : ''}
        </div>
        <div class="right stack">
          ${needBadge(s)}
          ${needsRelief(s) ? '<span class="badge info">3 PILOTS</span>' : ''}
          ${icon('chevron')}
        </div>
      </a>`;
    })
    .join('');

  const [state_, auto_, received_, check_] = autoPanels();
  // Starting again. Sectors already flown are left alone: emptying those would
  // throw away the record of who flew them, which the logbook is built from.
  const liveIds = upcoming.map((s) => s.id);
  const liveSeats = state.roster.filter((x) => liveIds.includes(x.sector_id)).length;
  const reset = `
    <section class="card">
      <h2>Start the roster again</h2>
      <p class="note">Takes everyone off every sector that has not been flown yet, whoever put them there and whether Auto roster or a person did it. Sectors already flown keep their crew, so the logbook stays true.</p>
      <div class="btn-row">
        <button class="btn danger" data-act="clearRoster" ${liveSeats ? '' : 'disabled'}>Clear the whole roster (${liveSeats})</button>
      </div>
      <p class="tiny">This cannot be undone, and nobody is told. If the roster is published, consider moving it back to draft first so the team does not watch it empty out.</p>
    </section>`;
  const empty =
    filter === 'flown' ? 'No sectors have been flown yet.' : 'Every upcoming sector has its pilots.';
  return `
    ${tabs('roster')}
    ${rosterToggle()}
    ${state_}
    ${auto_}
    ${swapsCard()}
    <section class="card">
      <div class="card-head">
        <div class="note"><strong>${short.length}</strong> of ${upcoming.length} upcoming sectors are missing a pilot. Every sector needs ${MIN_PILOTS}${
          r.reliefOverHours > 0 ? `, and ${MIN_PILOTS + 1} when it is longer than ${r.reliefOverHours} hours` : ''
        }.</div>
      </div>
      <div class="seg three">
        <button type="button" class="${filter === 'all' ? 'on' : ''}" data-act="filter" data-filter="all">Upcoming</button>
        <button type="button" class="${filter === 'short' ? 'on' : ''}" data-act="filter" data-filter="short">Needs pilots (${short.length})</button>
        <button type="button" class="${filter === 'flown' ? 'on' : ''}" data-act="filter" data-filter="flown">Flown (${flown.length})</button>
      </div>
      <p class="tiny">Open a sector to crew it. Each sector page lists every pilot, what they said about it, what they are already flying and any duty rule that would be broken by rostering them.${
        filter === 'flown'
          ? ' These have already been flown: changing the crew here corrects the logbook, and nobody is notified.'
          : ''
      }</p>
    </section>
    <section class="card list">${rows || `<p class="note">${empty}</p>`}</section>
    ${received_}
    ${check_}
    ${reset}`;
}

function people() {
  if (!isAdmin()) return `${tabs('roster')}<p class="note">Only admins can change roles.</p>`;
  const myId = me()?.id;
  const waiting = pendingPeople()
    .map(
      (p) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}</div>
          <div class="sub">${p.full_name && p.full_name !== p.display_name ? `${esc(p.full_name)} · ` : ''}Waiting for approval</div>
        </div>
        <div class="btn-row">
          <button class="btn danger small" data-act="reject" data-id="${esc(p.id)}" data-name="${esc(p.display_name)}">Reject</button>
          <button class="btn primary small" data-act="approve" data-id="${esc(p.id)}">Approve</button>
        </div>
      </div>`,
    )
    .join('');
  const rows = state.people
    .filter((p) => p.role !== 'pending')
    .map(
      (p) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}${p.id === myId ? ' <span class="badge mute">YOU</span>' : ''}${
            p.must_setup ? ' <span class="badge warn">NOT SET UP</span>' : ''
          }</div>
          <div class="sub">${p.full_name && p.full_name !== p.display_name ? `${esc(p.full_name)} · ` : ''}${plural(sectorCount(p.id), 'sector')} rostered</div>
        </div>
        <div class="btn-row">
          <select class="role-select" data-change="role" data-id="${esc(p.id)}" aria-label="Role for ${esc(p.display_name)}" ${p.id === myId ? 'disabled' : ''}>
            ${Object.entries(ROLES)
              .map(([key, [label]]) => `<option value="${key}" ${p.role === key ? 'selected' : ''}>${label}</option>`)
              .join('')}
          </select>
          ${p.id === myId ? '' : `<button class="btn danger small" data-act="reject" data-id="${esc(p.id)}" data-name="${esc(p.display_name)}">Remove</button>`}
        </div>
      </div>`,
    )
    .join('');
  return `
    ${tabs('people')}
    ${
      waiting
        ? `<section class="card list slot-card short">
            <div class="card-head"><div class="tiny">WAITING FOR APPROVAL</div><span class="badge warn">${pendingPeople().length}</span></div>
            ${waiting}
            <p class="tiny">Approving makes them a Pilot. Only approve people you recognise; until then they cannot see anything. Rejecting deletes the account.</p>
          </section>`
        : ''
    }
    <section class="card list">
      <div class="card-head"><div class="tiny">TEAM ACCOUNTS</div><span class="badge mute">${state.people.length - pendingPeople().length}</span></div>
      ${rows}
    </section>
    ${newAccount()}
    <section class="card">
      <h2>What each role can do</h2>
      <dl class="legend">${Object.values(ROLES)
        .map(([label, what]) => `<dt>${label}</dt><dd>${what}</dd>`)
        .join('')}</dl>
      <p class="tiny">You cannot change or remove your own account, so there is always at least one admin. New accounts wait for approval. Remove deletes someone's account for good and takes them off every sector they were rostered on.</p>
    </section>`;
}

// Nobody signs themselves up, so this is how somebody joins the team. What it
// gives back is shown once, for the admin to pass on; the person replaces both
// the first time they sign in.
function newAccount() {
  return `
    <form class="card form" data-form="account">
      <h2>Add a team member</h2>
      <p class="note">Makes an account and gives you an email and password to pass on. They put in their own email and choose their own password the first time they sign in. Nothing is emailed to anybody.</p>
      <div class="grid2">
        <label class="field">Name on the roster<input name="name" required maxlength="60" autocomplete="off" placeholder="e.g. John Smith"></label>
        <label class="field">Role<select name="role">
          ${['pilot', 'dispatcher', 'observer', 'admin']
            .map((key) => `<option value="${key}" ${key === 'pilot' ? 'selected' : ''}>${ROLES[key][0]}</option>`)
            .join('')}
        </select></label>
      </div>
      <label class="field">Password to give them<input name="password" required minlength="8" autocomplete="off" value="${esc(suggestedPassword)}">
        <span class="tiny">At least 8 characters. They choose their own as soon as they sign in.</span></label>
      <div class="btn-row"><button class="btn primary" type="submit">Make the account</button></div>
      ${
        madeAccount
          ? `<div class="made">
              <div class="tiny">PASS THESE ON TO ${esc(madeAccount.name.toUpperCase())}</div>
              <div class="kvs">
                <div class="kv"><span>Email</span><strong>${esc(madeAccount.email)}</strong></div>
                <div class="kv"><span>Password</span><strong>${esc(madeAccount.password)}</strong></div>
              </div>
              <p class="tiny">Shown once. If you lose them, delete the account below and make it again.</p>
            </div>`
          : ''
      }
    </form>`;
}

// Everyone who could fly this sector, with what they said, what they are
// already flying, and every rule that stands in the way. Nothing here stops
// you rostering someone anyway.
function whoCanFly(s, fit) {
  const r = rules();
  const list = seats(s);
  const crew = crewOf(s);
  const rank = (f) => (f.already ? 0 : f.choice === 'unavailable' ? 3 : f.breaks.length ? 2 : 1);
  const rows = [...fit]
    .sort((a, b) => rank(a) - rank(b) || a.load.total - b.load.total || a.p.display_name.localeCompare(b.p.display_name))
    .map((f) => {
      const here = crew.find((c) => c.user_id === f.p.id);
      const buttons = list
        .map(
          (duty) =>
            `<button class="btn small ${here?.duty === duty ? 'primary' : 'ghost'}" data-act="assign" data-sector="${esc(s.id)}" data-duty="${duty}" data-user="${esc(f.p.id)}">${SEAT_SHORT[duty]}</button>`,
        )
        .join('');
      const why = [here ? '' : f.reason, ...f.breaks].filter(Boolean);
      return `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(f.p.display_name)}${here ? ` <span class="badge ok">${esc(here.duty)}</span>` : ''}${
            f.choice === 'prefer' ? ' <span class="badge info">ASKED FOR IT</span>' : ''
          }${f.choice === 'unavailable' ? ' <span class="badge bad">CAN\'T</span>' : ''}</div>
          <div class="sub">${tally(f.load)} · ${f.load.hours.toFixed(1)} h · ${plural(f.load.boc, 'back-of-clock sector')}</div>
          ${here ? '<div class="sub">Rostered on this sector.</div>' : ''}
          ${
            why.length
              ? why.map((text) => `<div class="sub warn-text">${icon('alert')} ${esc(text)}</div>`).join('')
              : here
                ? ''
                : `<div class="sub ok-text">Free to fly it · ${f.choice === 'none' ? blankWord() : CHOICE_WORDS[f.choice]}</div>`
          }
        </div>
        <div class="btn-row">${buttons}</div>
      </div>`;
    })
    .join('');

  const free = fit.filter((f) => !f.blocked && !f.already).length;
  const broken = fit.filter((f) => !f.already && f.breaks.length).length;
  return `
    <section class="card list">
      <div class="card-head"><div class="tiny">WHO CAN FLY THIS</div><span class="badge ${free ? 'ok' : 'warn'}">${free} FREE</span></div>
      ${rows || '<p class="note">No pilots on the team yet.</p>'}
      <p class="tiny">${
        broken
          ? `${plural(broken, 'pilot')} would break a duty rule, so Auto roster skips them. The reason is listed against each name, and you can still roster them by pressing a seat.`
          : 'Press a seat to roster someone, or press it again to take them out. Auto roster skips anyone with a reason listed against their name.'
      } Rules are set in <a href="#/admin/rules">Admin → Settings</a>. Back of clock is ${String(r.bocStart).padStart(2, '0')}00 to ${String(r.bocEnd).padStart(2, '0')}00 sim local.</p>
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
  const options = rosterable()
    .filter((p) => !crew.some((r) => r.user_id === p.id))
    .map((p) => `<option value="${esc(p.id)}">${esc(p.display_name)} · ${plural(sectorCount(p.id), 'sector')}</option>`)
    .join('');

  const r = rules();
  const list = seats(s);
  const fit = candidates(s);
  const others = crew.filter((x) => !list.includes(x.duty));
  const order = sortedSectors();
  const at = order.findIndex((x) => x.id === s.id);
  const step = (x, label) => (x ? `<a class="btn ghost small" href="#/admin/sector/${esc(x.id)}">${label}</a>` : '');

  return `
    <div class="page-head"><a class="back" href="#/admin">${icon('back')} Roster</a>
      <div class="btn-row">${step(order[at - 1], 'Previous')}${step(order[at + 1], 'Next')}</div>
    </div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    <section class="card slot-card ${pilotsShort(s) ? 'short' : 'ok'}">
      <div class="card-head">
        <div>
          <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
          <div class="sub">${esc(s.flight)} · ${span(new Date(s.sta) - new Date(s.std))}</div>
        </div>
        <div class="right stack">
          ${needBadge(s)}
          ${needsRelief(s) ? '<span class="badge info">RELIEF PILOT</span>' : ''}
          ${isBoc(s, r) ? '<span class="badge warn">BACK OF CLOCK</span>' : ''}
        </div>
      </div>
      <dl class="legend">
        <dt>Departs</dt><dd>${when(s.std)} · ${simLocal(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</dd>
        <dt>Arrives</dt><dd>${when(s.sta)} · ${simLocal(s.sta)}</dd>
        <dt>Report</dt><dd>${when(defaultReport(s).toISOString())} unless changed per person</dd>
        ${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ''}
      </dl>
      <div class="slots">${list.map((duty) => seat(s, duty, fit)).join('')}</div>
      ${others.length ? `<div class="sub">Also on board: ${others.map((x) => `${name(x.user_id)} (${esc(x.duty)})`).join(', ')}</div>` : ''}
    </section>
    ${whoCanFly(s, fit)}
    <section class="card">
      <div class="card-head"><h2>Report times and notes</h2><span class="badge mute">${crew.length}</span></div>
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
  else if (args[0] === 'auto') out = rosterEditor();
  else if (args[0] === 'balance') out = balancePage();
  else if (args[0] === 'rules') out = rulesPage();
  else if (args[0] === 'simbrief') out = simbriefPage();
  else if (args[0] === 'sector') out = sectorCrew(args[1]);
  else out = rosterEditor();
  error = '';
  result = '';
  gapNote = '';
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

// Put someone in a seat, swap them, or clear it. Rules are not enforced here:
// an admin may roster whoever they like, and the rule check will say so.
async function setSeat(s, duty, userId) {
  const crew = crewOf(s);
  const holder = crew.find((r) => r.duty === duty);
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
    auto: false,
  });
}

export const changes = {
  seat(el) {
    const s = state.sectors.find((x) => x.id === el.dataset.sector);
    for (const select of el.closest('.card').querySelectorAll('select')) select.disabled = true;
    return change(() => setSeat(s, el.dataset.duty, el.value));
  },
  role(el) {
    const who = person(el.dataset.id)?.display_name;
    if (el.value === 'admin' && !confirm(`Make ${who} an admin? Admins can change everyone's roles.`)) {
      return rerender();
    }
    el.disabled = true;
    return change(() => setRole(el.dataset.id, el.value));
  },
  ...rosterChanges,
};

export const forms = {
  bidding(data, formEl) {
    const enabled = data.get('enabled') === 'on';
    const date = data.get('closeDate');
    const time = data.get('closeTime');
    const at = date && time ? new Date(`${date}T${time}:00Z`) : null;
    const error = formEl.querySelector('.form-error');
    if (enabled && (!at || isNaN(at))) {
      error.textContent = 'Give the date and time bidding closes, or switch bidding off.';
      error.hidden = false;
      return;
    }
    formEl.querySelector('[type=submit]').disabled = true;
    return change(async () => {
      await saveSettings({ bidding_enabled: enabled, bids_close_at: at ? at.toISOString() : null });
      result = enabled ? 'Bidding deadline saved.' : 'Bidding switched off.';
    });
  },

  // Anything the team has set that is not a duty rule, such as the aeroplane,
  // is kept as it is rather than wiped by saving this form.
  rules(data) {
    const next = { ...(state.settings?.rules || {}), unmarkedAvailable: data.get('unmarkedAvailable') === 'on' };
    for (const key of Object.keys(DEFAULT_RULES)) {
      if (key === 'unmarkedAvailable') continue;
      const value = Number(data.get(key));
      next[key] = isFinite(value) && value >= 0 ? value : DEFAULT_RULES[key];
    }
    next.bocStart = Math.min(23, Math.floor(next.bocStart));
    next.bocEnd = Math.min(23, Math.floor(next.bocEnd));
    return change(async () => {
      await saveSettings({ rules: next });
      result = 'Rules saved.';
    });
  },
  aircraft(data) {
    const callsign = String(data.get('callsign')).trim().toUpperCase();
    const aircraft = String(data.get('aircraft')).trim().toUpperCase();
    return change(async () => {
      await saveSettings({
        rules: { ...(state.settings?.rules || {}), callsign, aircraft, airframe: String(data.get('airframe')).trim() },
        simbrief: String(data.get('simbrief')).trim(),
      });
      // The next look at the feed should use the new callsign.
      state.track = null;
      result = 'Saved. Everyone sees this.';
    });
  },
  account(data, formEl) {
    const who = String(data.get('name')).trim();
    formEl.querySelector('[type=submit]').disabled = true;
    return change(async () => {
      const made = await createAccount(who, data.get('role'), String(data.get('password')));
      madeAccount = { name: who, email: made?.email || '', password: made?.password || '' };
      // The next account needs a password of its own.
      suggestedPassword = newPassword();
      result = `Account made for ${who}.`;
    });
  },
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
        auto: false,
      }),
    );
  },
};

export const actions = {
  pickupYes(el) {
    const p = pendingPickups().find((x) => x.id === el.dataset.id);
    const s = p && state.sectors.find((x) => x.id === p.sector_id);
    el.disabled = true;
    return change(async () => {
      await decidePickup(el.dataset.id, true, '', s ? defaultReport(s).toISOString() : null);
      result = 'Agreed. They are on the roster and have been told.';
    });
  },
  pickupNo(el) {
    const why = prompt('Turn this request down? You can say why (optional).', '');
    if (why === null) return;
    el.disabled = true;
    return change(async () => {
      await decidePickup(el.dataset.id, false, why);
      result = 'Turned down. They have been told.';
    });
  },
  swapYes(el) {
    el.disabled = true;
    return change(async () => {
      await decideSwap(el.dataset.id, true);
      result = 'Swap agreed. Both of them have been told.';
    });
  },
  swapNo(el) {
    const why = prompt('Turn this swap down? You can say why (optional).', '');
    if (why === null) return;
    el.disabled = true;
    return change(async () => {
      await decideSwap(el.dataset.id, false, why);
      result = 'Turned down. The sector is open for somebody else.';
    });
  },

  // Roster someone straight from the "who can fly this" list, rules or no
  // rules. Pressing the seat they already hold takes them off the sector.
  assign(el) {
    const s = state.sectors.find((x) => x.id === el.dataset.sector);
    const here = crewOf(s).find((c) => c.user_id === el.dataset.user);
    for (const button of el.closest('.row').querySelectorAll('button')) button.disabled = true;
    if (here?.duty === el.dataset.duty) return change(() => deleteRoster(here.id));
    return change(() => setSeat(s, el.dataset.duty, el.dataset.user));
  },
  state(el) {
    const publish = el.dataset.state === 'published';
    if (publish && !confirm('Publish the roster? Everyone on the team will be able to see it.')) return;
    el.disabled = true;
    return change(async () => {
      await saveSettings({ roster_state: el.dataset.state });
      result = publish ? 'Roster published.' : 'Roster moved back to draft.';
    });
  },
  auto(el) {
    el.disabled = true;
    return change(async () => {
      const { added, gaps } = planRoster({
        sectors: state.sectors,
        roster: state.roster,
        people: state.people,
        prefs: state.prefs,
        rules: rules(),
        now: Date.now(),
        reportFor: defaultReport,
      });
      if (added.length) await saveRosterMany(added);
      result = `Auto roster filled ${plural(added.length, 'seat')}.`;
      if (gaps.length) {
        const list = gaps.slice(0, 8).map((g) => `${g.sector.flight} ${g.seat}`).join(', ');
        gapNote = `${plural(gaps.length, 'seat')} could not be filled within the rules and availability: ${list}${gaps.length > 8 ? ', and more' : ''}.`;
      }
    });
  },
  // Emptying the roster is hard to undo and easy to press by accident, so it
  // asks twice: once for the numbers, once for the word.
  clearRoster(el) {
    const ids = sortedSectors()
      .filter((s) => new Date(s.sta) > Date.now())
      .map((s) => s.id);
    const seats = state.roster.filter((r) => ids.includes(r.sector_id));
    if (!seats.length) return;
    if (
      !confirm(
        `Take all ${seats.length} people off the ${ids.length} sectors that have not been flown? Sectors already flown keep their crew. This cannot be undone.`,
      )
    ) {
      return;
    }
    if ((prompt('Type CLEAR to empty the roster.', '') || '').trim().toUpperCase() !== 'CLEAR') return;
    el.disabled = true;
    return change(async () => {
      await clearRosterFor(ids);
      result = `Roster cleared: ${plural(seats.length, 'seat')} emptied.`;
    });
  },
  clearAuto(el) {
    if (!confirm('Remove everyone Auto roster placed? People you rostered by hand stay.')) return;
    el.disabled = true;
    return change(async () => {
      await clearAutoRoster();
      result = 'Auto-rostered seats cleared.';
    });
  },
  resetRules() {
    if (!confirm('Put every rule back to its default?')) return;
    return change(async () => {
      await saveSettings({ rules: {} });
      result = 'Rules reset to defaults.';
    });
  },
  reject(el) {
    const count = sectorCount(el.dataset.id);
    const rostered = count ? ` They come off the ${plural(count, 'sector')} they are rostered on.` : '';
    if (!confirm(`Delete the account for ${el.dataset.name}? They will not be able to sign in, and this cannot be undone.${rostered}`)) return;
    el.disabled = true;
    return change(() => removeAccount(el.dataset.id));
  },
  clearAllTimes(el) {
    if (!confirm('Clear every off and on block time for every sector? This cannot be undone.')) return;
    el.disabled = true;
    return change(() => clearActuals(null));
  },
  approve(el) {
    el.disabled = true;
    return change(() => setRole(el.dataset.id, 'pilot'));
  },
  filter(el) {
    filter = el.dataset.filter;
    rerender();
  },
  remove(el) {
    if (!confirm('Remove this person from the sector?')) return;
    el.disabled = true;
    return change(() => deleteRoster(el.dataset.id));
  },
  viewList() {
    rosterView = 'list';
    rerender();
  },
  viewTimeline() {
    rosterView = 'timeline';
    rerender();
  },
  ...rosterActions,
};

// The Landscape view timeline needs its drag-and-drop wired up once it is in
// the DOM; nothing else on this page needs a mount step.
export function mounted(root, args = []) {
  if (rosterView === 'timeline' && (!args[0] || args[0] === 'auto')) mountedRoster(root);
}
