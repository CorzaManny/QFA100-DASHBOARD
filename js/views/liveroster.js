// Live roster: a Gantt-style timeline of who is on duty, sector by sector, so
// ops staff can see the whole team's day at a glance instead of reading it one
// sector at a time. A sub-view of the Ops board, not a route of its own.
//
// Tap a bar to open a quick crew editor for that sector; drag a bar onto
// another row to move that duty to them, the same write the Admin roster
// uses, just reached from the timeline instead of a dropdown list.

import { state } from '../store.js';
import { saveRoster, deleteRoster } from '../api.js';
import { problems } from '../autoroster.js';
import { esc, zulu, zdate, simClock, simLocal, icon, rerender } from '../ui.js';
import {
  rosterable,
  running,
  reportAt,
  person,
  crewOf,
  seats,
  openSeats,
  wouldBreak,
  defaultReport,
  syncTeam,
  prefOf,
  rules,
  PILOT_DUTIES,
} from '../ops.js';

// Everything this person is currently rostered to fly, for the duty-rule
// check: the same read the Admin roster's "Duty rules" card uses.
function flownBy(userId) {
  const byId = new Map(state.sectors.map((s) => [s.id, s]));
  return state.roster
    .filter((r) => r.user_id === userId && PILOT_DUTIES.includes(r.duty) && byId.has(r.sector_id))
    .map((r) => byId.get(r.sector_id));
}

// Whether someone has, in effect, said they cannot fly a sector: either they
// marked it unavailable, or the team requires an answer and they gave none.
// The same rule the Admin roster's candidate list uses.
const cantFly = (userId, sectorId) => {
  const choice = prefOf(userId, sectorId);
  return choice === 'unavailable' || (!choice && !rules().unmarkedAvailable);
};
const cantFlyReason = (userId, sectorId) =>
  prefOf(userId, sectorId) === 'unavailable' ? "Said they can't fly this sector" : 'Has not said they are available';

// One screen's worth of the timeline: a day either side of "now" by default,
// moved a day at a time.
const WINDOW_HOURS = 24;
const PX_PER_HOUR = 100;
const MINUTE = 60000;
const HOUR = 60 * MINUTE;

// How far the window has been moved from today, in whole days.
let dayOffset = 0;
// 'zulu' or 'local': which clock the hour labels and ranges are read in.
let timeMode = 'zulu';
// The sector whose crew is open for a quick edit, if any.
let editingSectorId = null;
let error = '';

function windowRange() {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const start = base.getTime() + dayOffset * 24 * HOUR - 3 * HOUR;
  return { start, end: start + WINDOW_HOURS * HOUR };
}

// Every rosterable person, in the team's own order, with whatever duty rows
// fall in this window attached. Nobody drops off the list for having nothing
// on today, and nobody moves row as the window changes or a leg is reassigned.
function crewRows(start, end) {
  const run = running();
  const bySector = new Map(state.sectors.map((s) => [s.id, s]));
  const byPerson = new Map();
  for (const entry of state.roster) {
    const sector = bySector.get(entry.sector_id);
    if (!sector) continue;
    const row = run.times.get(sector.id);
    const from = run.trusted && row ? reportAt(entry, row) : new Date(entry.report_at).getTime();
    const to = run.trusted && row ? row.estOn : new Date(sector.sta).getTime();
    if (to < start || from > end) continue;
    const slot = { entry, sector, from, to, state: row?.state || 'later', conflict: cantFly(entry.user_id, sector.id) };
    if (!byPerson.has(entry.user_id)) byPerson.set(entry.user_id, []);
    byPerson.get(entry.user_id).push(slot);
  }
  const r = rules();
  return rosterable().map((p) => {
    const bars = (byPerson.get(p.id) || []).sort((a, b) => a.from - b.from);
    // Whatever duty rule their whole rostered load breaks, same check the
    // Admin roster's "Duty rules" card makes: not pinned to one leg, since a
    // rest or duty-hours break is really about the pair or the run of them.
    const flies = bars.some((b) => PILOT_DUTIES.includes(b.entry.duty));
    const ruleBreaks = flies ? problems(flownBy(p.id), r) : [];
    for (const b of bars) if (PILOT_DUTIES.includes(b.entry.duty)) b.ruleBreaks = ruleBreaks;
    return { p, bars, unavail: unavailBlocks(p, start, end, bars) };
  });
}

// Sectors in the window this person said they can't fly (or have not said
// they can, when the team requires an answer), and are not already on.
function unavailBlocks(p, start, end, bars) {
  const busy = new Set(bars.map((b) => b.sector.id));
  const out = [];
  for (const s of state.sectors) {
    if (busy.has(s.id) || !cantFly(p.id, s.id)) continue;
    const from = new Date(s.std).getTime();
    const to = new Date(s.sta).getTime();
    if (to < start || from > end) continue;
    out.push({ p, sector: s, from, to });
  }
  return out;
}

const left = (t, start) => Math.max(0, ((t - start) / HOUR) * PX_PER_HOUR);
const widthPx = (from, to, start, end) =>
  Math.max(6, ((Math.min(to, end) - Math.max(from, start)) / HOUR) * PX_PER_HOUR);
const trackWidth = (start, end) => ((end - start) / HOUR) * PX_PER_HOUR;

function hourTicks(start, end) {
  const out = [];
  const first = Math.ceil(start / HOUR) * HOUR;
  for (let t = first; t < end; t += HOUR) out.push(t);
  return out;
}

// The hour label, in whichever clock is selected.
const hourText = (t) => (timeMode === 'zulu' ? zulu(t) : simClock(t));
const rangeText = (start, end) =>
  timeMode === 'zulu' ? `${zdate(start)} – ${zdate(end - MINUTE)} UTC` : `${simLocal(start)} – ${simLocal(end - MINUTE)}`;

function header(start, end) {
  const ticks = hourTicks(start, end);
  const marks = ticks
    .map((t) => {
      const day = new Date(t).getUTCHours() === 0 ? zdate(t) : '';
      return `<div class="lr-tick" style="left:${left(t, start)}px">
        ${day ? `<div class="lr-day">${esc(day)}</div>` : ''}
        <div class="lr-hour">${esc(hourText(t))}</div>
      </div>`;
    })
    .join('');
  const now = Date.now();
  const nowMark =
    now >= start && now <= end
      ? `<div class="lr-now-line" style="left:${left(now, start)}px"><span>NOW</span></div>`
      : '';
  return `<div class="lr-head-track" style="width:${trackWidth(start, end)}px">${marks}${nowMark}</div>`;
}

// A single CSS variable, set once on the grid, that every row's track reads
// to draw its own slice of the same "now" line without redoing the sum per row.
function nowLeftVar(start, end) {
  const now = Date.now();
  return now >= start && now <= end ? `${left(now, start)}px` : '-9999px';
}

function barClass(b) {
  if (b.state === 'done') return 'done';
  if (b.state === 'airborne') return 'live';
  return 'plan';
}

function bar(b, start, end) {
  const s = b.sector;
  const ruleBreaks = b.ruleBreaks || [];
  // Can't-fly (red) outranks a duty-rule break (orange) when a bar is both;
  // either way the tooltip says what is actually wrong.
  const flag = b.conflict ? 'conflict' : ruleBreaks.length ? 'rule-break' : '';
  const warnings = [
    ...(b.conflict ? [cantFlyReason(b.entry.user_id, s.id)] : []),
    ...ruleBreaks,
  ];
  const title = `${s.flight} · ${s.dep} → ${s.arr} · ${b.entry.duty}\n${hourText(b.from)}–${hourText(b.to)} · tap to edit crew, drag onto another row to move it${
    warnings.length ? `\n⚠ ${warnings.join('\n⚠ ')}` : ''
  }`;
  return `<div class="lr-bar ${barClass(b)}${flag ? ` ${flag}` : ''}" style="left:${left(
    Math.max(b.from, start),
    start,
  )}px;width:${widthPx(b.from, b.to, start, end)}px" role="button" tabindex="0" draggable="true" data-act="editSector" data-sector="${esc(
    s.id,
  )}" data-roster="${esc(b.entry.id)}" title="${esc(title)}">
    <span class="lr-bar-t">${flag ? icon('alert') : ''}${esc(s.flight)} · ${esc(s.dep)}–${esc(s.arr)}</span>
    <span class="lr-bar-s">${esc(b.entry.duty)}</span>
  </div>`;
}

// A sector this person said they can't fly, drawn on their row so ops can see
// it without opening their availability. Not a roster row, so not draggable.
function unavailBlock(u, start, end) {
  const s = u.sector;
  const title = `${s.flight} · ${s.dep} → ${s.arr}\n${cantFlyReason(u.p.id, s.id)}`;
  return `<div class="lr-unavail" style="left:${left(Math.max(u.from, start), start)}px;width:${widthPx(
    u.from,
    u.to,
    start,
    end,
  )}px" title="${esc(title)}">
    <span class="lr-unavail-s">CAN'T FLY</span>
  </div>`;
}

const CHIP_H = 36;
const CHIP_GAP = 6;
const chipTop = (lane) => 8 + lane * (CHIP_H + CHIP_GAP);
const unrosteredHeight = (lanes) => (lanes ? 16 + lanes * CHIP_H + (lanes - 1) * CHIP_GAP : 54);

// An unfilled seat, somewhere in the window: not tied to a roster row at all,
// just a sector and a duty it still needs. Dragged onto a crew row, it fills
// it; dropped back here, nothing happens because it was never filled.
//
// Drawn on the timeline rather than listed, so it reads in line with every
// other duty; packed into lanes like overlapping appointments, so two seats
// open on the same sector at once stack instead of hiding each other.
function openSeatChips(start, end) {
  const list = [];
  for (const s of state.sectors) {
    const from = new Date(s.std).getTime();
    const to = new Date(s.sta).getTime();
    if (to < start || from > end) continue;
    for (const duty of openSeats(s)) list.push({ sector: s, duty, from, to, lane: 0 });
  }
  list.sort((a, b) => a.from - b.from);
  const laneEnds = [];
  for (const c of list) {
    let lane = laneEnds.findIndex((endsAt) => endsAt <= c.from);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = c.to;
    c.lane = lane;
  }
  return { list, lanes: laneEnds.length };
}

function chip(c, start, end) {
  const s = c.sector;
  const title = `${s.flight} · ${s.dep} → ${s.arr} needs a ${c.duty}\nDrag onto a crew row to roster them, or tap to pick from a list.`;
  return `<div class="lr-chip" style="left:${left(Math.max(c.from, start), start)}px;width:${widthPx(
    c.from,
    c.to,
    start,
    end,
  )}px;top:${chipTop(c.lane)}px" role="button" tabindex="0" draggable="true" data-act="editSector" data-sector="${esc(
    s.id,
  )}" data-open-sector="${esc(s.id)}" data-open-duty="${esc(c.duty)}" title="${esc(title)}">
    <span class="lr-chip-flight">${esc(s.flight)} · ${esc(s.dep)}–${esc(s.arr)}</span>
    <span class="lr-chip-duty">${esc(c.duty)}</span>
  </div>`;
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '··';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words.at(-1)[0]).toUpperCase();
}

function row({ p, bars, unavail }, start, end) {
  return `
    <div class="lr-row">
      <div class="lr-name"><span class="lr-avatar">${esc(initials(p.display_name))}</span>${esc(p.display_name)}</div>
      <div class="lr-track" style="width:${trackWidth(start, end)}px" data-user="${esc(p.id)}">
        ${unavail.map((u) => unavailBlock(u, start, end)).join('')}
        ${bars.map((b) => bar(b, start, end)).join('')}
      </div>
    </div>`;
}

// What this candidate said about this sector, for the quick editor's
// dropdown: the same words and priority order as the Admin roster's list.
const CHOICE_RANK = { prefer: 0, available: 1, none: 2, unavailable: 3 };
const CHOICE_WORD = {
  prefer: 'asked for this sector',
  available: 'available',
  unavailable: "can't fly it",
};
function choiceLabel(userId, sectorId) {
  const choice = prefOf(userId, sectorId) || 'none';
  if (choice === 'none') return rules().unmarkedAvailable ? 'available (has not said)' : 'has not answered';
  return CHOICE_WORD[choice];
}

// The crew-quick-edit card: every seat the sector needs, with a dropdown each,
// the same write the Admin roster makes, just a tap away from the timeline.
function modal() {
  if (!editingSectorId) return '';
  const s = state.sectors.find((x) => x.id === editingSectorId);
  if (!s) return '';
  const crew = crewOf(s);
  const candidates = [...rosterable()].sort(
    (a, b) =>
      (CHOICE_RANK[prefOf(a.id, s.id) || 'none'] ?? 2) - (CHOICE_RANK[prefOf(b.id, s.id) || 'none'] ?? 2) ||
      a.display_name.localeCompare(b.display_name),
  );
  const seatFields = seats(s)
    .map((duty) => {
      const holder = crew.find((r) => r.duty === duty);
      const elsewhere = new Set(crew.filter((r) => r.duty !== duty).map((r) => r.user_id));
      const options = candidates
        .filter((p) => !elsewhere.has(p.id) || p.id === holder?.user_id)
        .map(
          (p) =>
            `<option value="${esc(p.id)}" ${p.id === holder?.user_id ? 'selected' : ''}>${esc(p.display_name)} · ${esc(
              choiceLabel(p.id, s.id),
            )}</option>`,
        )
        .join('');
      return `<label class="field">${esc(duty)}
        <select data-change="quickSeat" data-sector="${esc(s.id)}" data-duty="${esc(duty)}">
          <option value="">Not assigned</option>${options}
        </select>
      </label>`;
    })
    .join('');
  return `
    <div class="lr-modal-backdrop" data-act="closeModal">
      <div class="lr-modal" data-act="none">
        <div class="card-head">
          <h2>${esc(s.flight)} · ${esc(s.dep)} → ${esc(s.arr)}</h2>
          <button class="btn ghost small" type="button" data-act="closeModal">${icon('chevron')} Close</button>
        </div>
        <p class="tiny">${esc(zdate(s.std))} · ${esc(zulu(s.std))}–${esc(zulu(s.sta))}Z</p>
        ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
        <div class="lr-modal-seats">${seatFields}</div>
        <p class="tiny">Changes save immediately. Dragging a bar onto another row does the same thing, and dragging it into Unrostered clears the seat.</p>
      </div>
    </div>`;
}

export function renderRoster() {
  const { start, end } = windowRange();
  const rows = crewRows(start, end);
  return `
    <section class="card lr-card">
      <div class="lr-toolbar">
        <div class="tiny">${esc(rangeText(start, end))}</div>
        <div class="btn-row">
          <button class="btn ${timeMode === 'zulu' ? 'primary' : 'ghost'} small" type="button" data-act="timeZulu">UTC</button>
          <button class="btn ${timeMode === 'local' ? 'primary' : 'ghost'} small" type="button" data-act="timeLocal">Local</button>
        </div>
        <div class="btn-row">
          <button class="btn ghost small" type="button" data-act="today">Today</button>
          <button class="icon-btn" type="button" data-act="prev" aria-label="Previous day">${icon('back')}</button>
          <button class="icon-btn" type="button" data-act="next" aria-label="Next day">${icon('chevron')}</button>
        </div>
      </div>
      ${rows.some((r) => r.bars.length) ? '' : '<p class="note" style="margin:0 16px 14px">Nobody has a sector in this window; the full team is listed below.</p>'}
      ${
        rows.length
          ? `<div class="lr-scroll" id="lr-scroll">
              <div class="lr-grid" style="--now-left:${nowLeftVar(start, end)}">
                <div class="lr-headrow">
                  <div class="lr-corner">Name</div>
                  ${header(start, end)}
                </div>
                ${unrosteredRow(start, end)}
                ${rows.map((r) => row(r, start, end)).join('')}
              </div>
            </div>
            <p class="tiny">Each bar is a report-to-debrief duty period, and follows the running delay once the day is live. Tap a bar to edit the crew, drag it onto another row to move that duty to them, or drag it up into Unrostered to clear the seat.</p>`
          : `<p class="note">Nobody is rostered in this window.</p>`
      }
    </section>
    ${modal()}`;
}

// Every empty seat in the window, drawn in its own row at the same place on
// the timeline as the sector it belongs to: drag a chip down onto a crew row
// to fill it, or drag a bar up into this row to clear it.
function unrosteredRow(start, end) {
  const { list: chips, lanes } = openSeatChips(start, end);
  return `
    <div class="lr-row lr-row-unrostered">
      <div class="lr-name">Unrostered${chips.length ? ` <span class="badge warn">${chips.length}</span>` : ''}</div>
      <div class="lr-track" id="lr-unrostered" style="width:${trackWidth(start, end)}px;height:${unrosteredHeight(
        lanes,
      )}px">
        ${chips.map((c) => chip(c, start, end)).join('')}
      </div>
    </div>`;
}

// Put someone in a seat, swap them, or clear it. Rules are not enforced here:
// ops may roster whoever they like, and the quick editor says what it would break.
async function setSeat(sector, duty, userId) {
  const crew = crewOf(sector);
  const holder = crew.find((r) => r.duty === duty);
  if (holder && holder.user_id !== userId) await deleteRoster(holder.id);
  if (!userId) return;
  const existing = crew.find((r) => r.user_id === userId);
  await saveRoster({
    sector_id: sector.id,
    user_id: userId,
    duty,
    report_at: existing?.report_at || defaultReport(sector).toISOString(),
    notes: existing?.notes || '',
    auto: false,
  });
}

// Duty rules a move would break, plus what the person said about the sector,
// so dragging someone in asks about both before it saves.
function warningsFor(userId, sector) {
  const out = [...wouldBreak(userId, sector)];
  if (cantFly(userId, sector.id)) out.push(cantFlyReason(userId, sector.id));
  return out;
}

async function moveDuty(rosterId, targetUserId) {
  const entry = state.roster.find((r) => r.id === rosterId);
  if (!entry || entry.user_id === targetUserId) return;
  const sector = state.sectors.find((s) => s.id === entry.sector_id);
  if (!sector) return;
  const warnings = warningsFor(targetUserId, sector);
  if (
    warnings.length &&
    !confirm(`Moving this to ${person(targetUserId)?.display_name || 'them'}: ${warnings.join(', ')}. Move anyway?`)
  ) {
    return;
  }
  error = '';
  try {
    await setSeat(sector, entry.duty, targetUserId);
    await syncTeam();
  } catch (err) {
    error = err.message;
  }
  rerender();
}

// An open seat, dragged from Unrostered onto somebody's row: roster them in it.
async function fillSeat(sectorId, duty, targetUserId) {
  const sector = state.sectors.find((s) => s.id === sectorId);
  if (!sector || !targetUserId) return;
  const warnings = warningsFor(targetUserId, sector);
  if (
    warnings.length &&
    !confirm(`Rostering ${person(targetUserId)?.display_name || 'them'}: ${warnings.join(', ')}. Roster them anyway?`)
  ) {
    return;
  }
  error = '';
  try {
    await setSeat(sector, duty, targetUserId);
    await syncTeam();
  } catch (err) {
    error = err.message;
  }
  rerender();
}

// A bar, dragged off the timeline into Unrostered: take them off the sector.
async function unassign(rosterId) {
  if (!state.roster.some((r) => r.id === rosterId)) return;
  error = '';
  try {
    await deleteRoster(rosterId);
    await syncTeam();
  } catch (err) {
    error = err.message;
  }
  rerender();
}

export const rosterActions = {
  prev() {
    dayOffset -= 1;
    rerender();
  },
  next() {
    dayOffset += 1;
    rerender();
  },
  today() {
    dayOffset = 0;
    rerender();
  },
  timeZulu() {
    timeMode = 'zulu';
    rerender();
  },
  timeLocal() {
    timeMode = 'local';
    rerender();
  },
  editSector(el) {
    editingSectorId = el.dataset.sector;
    error = '';
    rerender();
  },
  closeModal() {
    editingSectorId = null;
    error = '';
    rerender();
  },
  none() {},
};

export const rosterChanges = {
  quickSeat(el) {
    const s = state.sectors.find((x) => x.id === el.dataset.sector);
    if (!s) return;
    el.disabled = true;
    error = '';
    return setSeat(s, el.dataset.duty, el.value)
      .then(syncTeam)
      .catch((err) => {
        error = err.message;
      })
      .then(rerender);
  },
};

// Drag payloads are plain strings, "entry:<rosterId>" for a bar already on
// the timeline or "open:<sectorId>:<duty>" for a chip out of Unrostered.
const dragEntry = (id) => `entry:${id}`;
const dragOpen = (sectorId, duty) => `open:${sectorId}:${duty}`;
function parseDrag(raw) {
  const [kind, a, duty] = raw.split(':');
  if (kind === 'entry') return { kind, rosterId: a };
  if (kind === 'open') return { kind, sectorId: a, duty };
  return null;
}

function acceptDrop(zone) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('drop-target');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop-target'));
}

// Bring "now" into view, and wire up the drag-and-drop that the click
// delegation in app.js does not cover.
export function mountedRoster(root) {
  const scroll = root.querySelector('#lr-scroll');
  if (scroll) {
    const { start } = windowRange();
    const now = Date.now();
    if (now >= start) scroll.scrollLeft = Math.max(0, left(now, start) - 140);
  }
  for (const b of root.querySelectorAll('.lr-bar')) {
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', dragEntry(b.dataset.roster));
      e.dataTransfer.effectAllowed = 'move';
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => b.classList.remove('dragging'));
  }
  for (const c of root.querySelectorAll('.lr-chip')) {
    c.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', dragOpen(c.dataset.openSector, c.dataset.openDuty));
      e.dataTransfer.effectAllowed = 'move';
      c.classList.add('dragging');
    });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  }
  for (const t of root.querySelectorAll('.lr-track')) {
    acceptDrop(t);
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      t.classList.remove('drop-target');
      const drag = parseDrag(e.dataTransfer.getData('text/plain') || '');
      if (!drag) return;
      if (drag.kind === 'entry') moveDuty(drag.rosterId, t.dataset.user);
      else fillSeat(drag.sectorId, drag.duty, t.dataset.user);
    });
  }
  const unzone = root.querySelector('#lr-unrostered');
  if (unzone) {
    acceptDrop(unzone);
    unzone.addEventListener('drop', (e) => {
      e.preventDefault();
      unzone.classList.remove('drop-target');
      const drag = parseDrag(e.dataTransfer.getData('text/plain') || '');
      if (drag?.kind === 'entry') unassign(drag.rosterId);
    });
  }
}
