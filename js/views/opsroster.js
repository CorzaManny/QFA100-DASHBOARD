// The ops desk's shift roster, drawn and worked the way the Landscape view
// works: one row per controller, a day of hours across the top, and a bar for
// every shift. A sub-view of Admin → Ops Desk, not a route of its own.
//
// Rostering is dragging. Drag across empty track to put a shift there, drag a
// bar's end to make it longer or shorter, drag the bar itself to move it or to
// hand it to the controller on the row above. Everything lands on the quarter
// hour, and nothing is written until the finger or the mouse comes up.
//
// The strip above the rows is what the roster is actually for: where somebody
// has the desk, and where nobody does. A gap there at 0300 is the whole reason
// anyone opens this page, and reading it off a list of start and end times is
// what made that hard.

import { state } from '../store.js';
import { saveOpsShift, deleteOpsShift } from '../api.js';
import { esc, zulu, zdate, simClock, simLocal, isoDate, isoTime, icon, rerender } from '../ui.js';
import { OPS_DESK_ROLES, person, syncTeam, opsShifts, running, flyingBetween } from '../ops.js';
import {
  MINUTE,
  HOUR,
  DAY,
  PX_PER_HOUR,
  simOffsetMinutes,
  localDateLabel,
  daysSpanning,
  left,
  widthPx,
  trackWidth,
  timeAt,
  snap,
  hourTicks,
} from './timeline.js';

// The shortest shift worth having, and so the smallest a drag can make one.
const MIN_SHIFT = 30 * MINUTE;

// An admin is the one account that can both fly a sector and take the ops
// desk, which makes it the one account that can be rostered to answer the
// flight deck from inside it. Nobody does that deliberately; it happens
// because the two rosters are built on different pages, days apart. So a shift
// that lands on one of that person's own duty periods is flagged wherever it
// is drawn, and dragging one there asks first.
//
// It is never refused. A controller may know perfectly well that they are
// rostered as an observer on a sector they can answer the radio through, and
// the roster is theirs to write.
const clashWords = (list) =>
  list
    .map(({ sector, entry, from, to }) => `${sector.flight} as ${entry.duty}, ${spanText(from, to)}`)
    .join('; ');

// Which day is showing, by index into shiftDays(). null means "whichever day
// 'now' falls in", worked out fresh so it follows the clock until somebody
// picks a day by hand.
let dayIndex = null;
// 'zulu' or 'local': which clock the hours are read in. The controllers live
// in Sydney and the roster is written in Zulu, so both have to be here.
let timeMode = 'zulu';
// The shift open in the editor card, if any.
let editingId = null;
let error = '';
// Where the timeline is scrolled to, kept across renders, so a save or a
// background sync does not throw whoever is rostering back to midnight.
let scrollAt = null;
let scrollKey = '';
// True while a drag is writing, so the page is not redrawn underneath it.
let saving = false;

const controllers = () => state.people.filter((p) => OPS_DESK_ROLES.includes(p.role));
const shiftsOf = (userId) => opsShifts().filter((s) => s.user_id === userId);
const ms = (t) => new Date(t).getTime();

// Every day the roster touches: the shifts themselves, and the sectors, so
// the desk can be rostered against the flying before a single shift exists.
// Today only when there is nothing at all to span - a roster has to start
// somewhere, and until the schedule is loaded that is today.
//
// Today deliberately does not join the list otherwise. It used to, and days
// before the event that put "Day 1" on an empty date nobody is flying, so
// opening the page showed a blank grid and the roster somebody had built was
// two taps away on a day they had no reason to look at.
function shiftDays() {
  const offsetMs = timeMode === 'local' ? simOffsetMinutes() * MINUTE : 0;
  const times = opsShifts().flatMap((s) => [ms(s.starts_at), ms(s.ends_at) - MINUTE]);
  for (const s of state.sectors) times.push(ms(s.std));
  return daysSpanning(times, offsetMs);
}

// Before the event, its first day; after it, its last; otherwise the one
// "now" falls in.
function currentDayIndex(days) {
  if (dayIndex != null) return Math.min(Math.max(dayIndex, 0), days.length - 1);
  const now = Date.now();
  const idx = days.findIndex((d) => now < d + DAY);
  return idx === -1 ? days.length - 1 : Math.max(idx, 0);
}

// Which day of the list a moment falls on, so a shift somewhere else in the
// event can be jumped to rather than hunted for.
const dayOf = (t, days) => days.findIndex((d) => t >= d && t < d + DAY);

function windowRange() {
  const days = shiftDays();
  const idx = currentDayIndex(days);
  const start = days[idx];
  return { start, end: start + DAY, days, idx };
}

const hourText = (t) => (timeMode === 'zulu' ? zulu(t) : simClock(t));
const rangeText = (start, end) =>
  timeMode === 'zulu' ? `${zdate(start)} UTC` : `${simLocal(start)} – ${simLocal(end - MINUTE)}`;
const spanText = (from, to) => `${hourText(from)}–${hourText(to)}`;
const lengthText = (from, to) => {
  const mins = Math.round((to - from) / MINUTE);
  const h = Math.floor(mins / 60);
  return h ? `${h}h${mins % 60 ? ` ${mins % 60}m` : ''}` : `${mins}m`;
};

function header(start, end) {
  const dateLabel = timeMode === 'local' ? localDateLabel : zdate;
  const marks = hourTicks(start, end)
    .map(
      (t) => `<div class="lr-tick" style="left:${left(t, start)}px">
        ${t === start ? `<div class="lr-day">${esc(dateLabel(t))}</div>` : ''}
        <div class="lr-hour">${esc(hourText(t))}</div>
      </div>`,
    )
    .join('');
  const now = Date.now();
  const nowMark =
    now >= start && now <= end
      ? `<div class="lr-now-line" style="left:${left(now, start)}px"><span>NOW</span></div>`
      : '';
  return `<div class="lr-head-track" style="width:${trackWidth(start, end)}px">${marks}${nowMark}</div>`;
}

function nowLeftVar(start, end) {
  const now = Date.now();
  return now >= start && now <= end ? `${left(now, start)}px` : '-9999px';
}

// Where somebody has the desk in this window, as merged spans, and therefore
// where nobody does. Overlapping shifts are allowed on purpose - two
// controllers covering the same hours is a real thing - so this works on the
// union of them rather than counting shifts.
function coverage(start, end) {
  const spans = opsShifts()
    .map((s) => [Math.max(ms(s.starts_at), start), Math.min(ms(s.ends_at), end)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  const covered = [];
  for (const [from, to] of spans) {
    const last = covered.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else covered.push([from, to]);
  }
  const gaps = [];
  let at = start;
  for (const [from, to] of covered) {
    if (from > at) gaps.push([at, from]);
    at = Math.max(at, to);
  }
  if (at < end) gaps.push([at, end]);
  return { covered, gaps };
}

function coverRow(start, end) {
  const { covered, gaps } = coverage(start, end);
  const block = (from, to, kind) =>
    `<div class="os-cover ${kind}" style="left:${left(from, start)}px;width:${widthPx(from, to, start, end)}px"
      title="${kind === 'gap' ? 'Nobody on the desk' : 'Covered'} ${esc(spanText(from, to))}">${
        kind === 'gap' && to - from >= 90 * MINUTE ? `<span>${esc(spanText(from, to))}</span>` : ''
      }</div>`;
  const uncovered = gaps.reduce((n, [from, to]) => n + (to - from), 0);
  return `
    <div class="lr-row os-row-cover">
      <div class="lr-name">Desk cover${
        uncovered ? ` <span class="badge bad">${esc(lengthText(0, uncovered))} OPEN</span>` : ' <span class="badge ok">ALL DAY</span>'
      }</div>
      <div class="lr-track os-track-cover" style="width:${trackWidth(start, end)}px">
        ${covered.map(([from, to]) => block(from, to, 'on')).join('')}
        ${gaps.map(([from, to]) => block(from, to, 'gap')).join('')}
      </div>
    </div>`;
}

// What is being flown while the desk is being rostered. Not editable here -
// it is the reason the shifts are shaped the way they are, so it reads as a
// backdrop rather than a row of its own.
function sectorMarks(start, end) {
  return state.sectors
    .filter((s) => ms(s.sta) >= start && ms(s.std) <= end)
    .map(
      (s) =>
        `<div class="os-sector" style="left:${left(Math.max(ms(s.std), start), start)}px;width:${widthPx(
          ms(s.std),
          ms(s.sta),
          start,
          end,
        )}px" title="${esc(s.flight)} ${esc(s.dep)} → ${esc(s.arr)}, ${esc(spanText(ms(s.std), ms(s.sta)))}">
          <span>${esc(s.flight)} ${esc(s.dep)}–${esc(s.arr)}</span>
        </div>`,
    )
    .join('');
}

// This controller's own duty periods, on their own row: the hours they cannot
// answer the flight deck in, because they are flying it. Drawn before the
// shifts rather than only flagged afterwards, so the roster is written around
// them in the first place.
function flyingBlocks(duties, start, end) {
  return duties
    .map(
      (d) =>
        `<div class="os-flying" style="left:${left(Math.max(d.from, start), start)}px;width:${widthPx(
          d.from,
          d.to,
          start,
          end,
        )}px" title="${esc(
          `Flying ${d.sector.flight} ${d.sector.dep} → ${d.sector.arr} as ${d.entry.duty}, ${spanText(d.from, d.to)}`,
        )}"><span>${esc(d.sector.flight)} · ${esc(d.entry.duty.toUpperCase())}</span></div>`,
    )
    .join('');
}

function bar(shift, start, end, clash) {
  const from = ms(shift.starts_at);
  const to = ms(shift.ends_at);
  const now = Date.now();
  const kind = to < now ? 'done' : from <= now ? 'live' : 'plan';
  const title = `${spanText(from, to)} · ${lengthText(from, to)}${shift.notes ? `\n${shift.notes}` : ''}${
    clash.length ? `\n⚠ On the desk while flying ${clashWords(clash)}` : ''
  }
Drag the middle to move it, an end to make it longer or shorter, or onto another row to hand it over. Tap for the exact times.`;
  return `<div class="lr-bar os-bar ${kind}${clash.length ? ' clash' : ''}" style="left:${left(
    Math.max(from, start),
    start,
  )}px;width:${widthPx(from, to, start, end)}px" role="button" tabindex="0" data-shift="${esc(
    shift.id,
  )}" title="${esc(title)}">
    <span class="os-handle left" data-edge="start" aria-hidden="true"></span>
    <span class="lr-bar-t">${clash.length ? icon('alert') : ''}${esc(spanText(from, to))}</span>
    <span class="lr-bar-s">${
      clash.length ? `Flying ${esc(clash[0].sector.flight)}` : `${esc(lengthText(from, to))}${
        shift.notes ? ` · ${esc(shift.notes)}` : ''
      }`
    }</span>
    <span class="os-handle right" data-edge="end" aria-hidden="true"></span>
  </div>`;
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '··';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words.at(-1)[0]).toUpperCase();
}

function row(p, start, end, run) {
  const mine = shiftsOf(p.id)
    .filter((s) => ms(s.ends_at) > start && ms(s.starts_at) < end)
    .map((sh) => ({ sh, clash: flyingBetween(p.id, ms(sh.starts_at), ms(sh.ends_at), run) }));
  const hours = mine.reduce(
    (n, { sh }) => n + (Math.min(ms(sh.ends_at), end) - Math.max(ms(sh.starts_at), start)),
    0,
  );
  const duties = flyingBetween(p.id, start, end, run);
  const clashes = mine.filter(({ clash }) => clash.length).length;
  return `
    <div class="lr-row">
      <div class="lr-name"><span class="lr-avatar">${esc(initials(p.display_name))}</span>${esc(p.display_name)}
        ${clashes ? '<span class="badge bad" title="On the desk while flying">FLYING</span>' : ''}
        ${hours ? `<span class="tiny os-hours">${esc(lengthText(0, hours))}</span>` : ''}</div>
      <div class="lr-track os-track" style="width:${trackWidth(start, end)}px" data-user="${esc(p.id)}">
        ${sectorMarks(start, end)}
        ${flyingBlocks(duties, start, end)}
        ${mine.map(({ sh, clash }) => bar(sh, start, end, clash)).join('')}
      </div>
    </div>`;
}

// The exact times, for a shift that has to start at 0545 and cannot be
// dragged there, and the only place a shift is deleted from.
function editor() {
  if (!editingId) return '';
  const shift = opsShifts().find((s) => s.id === editingId);
  if (!shift) return '';
  const clash = flyingBetween(shift.user_id, ms(shift.starts_at), ms(shift.ends_at), running());
  return `
    <div class="lr-modal-backdrop" data-act="closeShift">
      <div class="lr-modal" data-act="none">
        <div class="card-head">
          <h2>${esc(person(shift.user_id)?.display_name || 'Shift')}</h2>
          <button class="btn ghost small" type="button" data-act="closeShift">${icon('chevron')} Close</button>
        </div>
        ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
        ${
          clash.length
            ? `<p class="note warn">${icon(
                'alert',
              )} <strong>${esc(person(shift.user_id)?.display_name || 'They')} is flying this shift.</strong> ${esc(
                clashWords(clash),
              )}. Somebody has to answer the flight deck, and it cannot be whoever is in it.</p>`
            : ''
        }
        <form class="card-form" data-form="opsShiftEdit">
          <input type="hidden" name="id" value="${esc(shift.id)}">
          <label class="field">Controller<select name="user" required>
            ${controllers()
              .map(
                (p) =>
                  `<option value="${esc(p.id)}" ${p.id === shift.user_id ? 'selected' : ''}>${esc(
                    p.full_name || p.display_name,
                  )}</option>`,
              )
              .join('')}
          </select></label>
          <div class="grid2">
            <label class="field">Starts, date (UTC)<input type="date" name="startDate" required value="${isoDate(
              shift.starts_at,
            )}"></label>
            <label class="field">Starts, time (UTC)<input type="time" name="startTime" required value="${isoTime(
              shift.starts_at,
            )}"></label>
            <label class="field">Ends, date (UTC)<input type="date" name="endDate" required value="${isoDate(
              shift.ends_at,
            )}"></label>
            <label class="field">Ends, time (UTC)<input type="time" name="endTime" required value="${isoTime(
              shift.ends_at,
            )}"></label>
          </div>
          <label class="field">Note (optional)<input name="notes" maxlength="120" value="${esc(
            shift.notes || '',
          )}" placeholder="e.g. covering the Pacific legs"></label>
          <p class="form-error" hidden></p>
          <div class="btn-row">
            <button class="btn primary" type="submit">Save the shift</button>
            <button class="btn danger" type="button" data-act="delShiftBar" data-id="${esc(shift.id)}">Remove</button>
          </div>
        </form>
        <p class="tiny">${esc(simLocal(shift.starts_at))} to ${esc(simLocal(shift.ends_at))} in Sydney.</p>
      </div>
    </div>`;
}

function daySelect(days, idx, flagged) {
  const dateLabel = timeMode === 'local' ? localDateLabel : zdate;
  const options = days
    .map(
      (d, i) =>
        `<option value="${i}" ${i === idx ? 'selected' : ''}>Day ${i + 1} · ${esc(dateLabel(d))}${
          flagged.has(i) ? ' ⚠' : ''
        }</option>`,
    )
    .join('');
  return `<select data-change="shiftDay" aria-label="Day">${options}</select>`;
}

export function renderOpsTimeline() {
  const { start, end, days, idx } = windowRange();
  const people = controllers();
  const run = running();
  // Every shift anywhere on the roster whose controller is flying it - not
  // only the ones on the day showing, because a clash two days out is still
  // the desk unanswered and the day picker is no place to hide it.
  const clashing = opsShifts().filter(
    (sh) => flyingBetween(sh.user_id, ms(sh.starts_at), ms(sh.ends_at), run).length,
  );
  if (!people.length) {
    return `
      <section class="card">
        <div class="card-head"><h2>Shift roster</h2></div>
        <p class="note">Nobody has a role that can take the desk yet. An admin gives somebody <strong>Operations</strong> in Admin → People, and they appear here with a row of their own.</p>
      </section>`;
  }
  return `
    <section class="card lr-card">
      <div class="card-head os-head">
        <h2>Shift roster</h2>
        <span class="badge mute">${opsShifts().length} ${opsShifts().length === 1 ? 'SHIFT' : 'SHIFTS'}</span>
        ${
          clashing.length
            ? `<span class="badge bad">${clashing.length} ON THE DESK WHILE FLYING</span>`
            : ''
        }
      </div>
      <p class="note os-head-note">Who is answering the flight deck, and when. The crew see the name at the top of their ops chat; they never see this page.</p>
      <div class="lr-toolbar">
        <div class="btn-row">
          ${daySelect(days, idx, new Set(clashing.map((sh) => dayOf(ms(sh.starts_at), days))))}
          <button class="btn ghost small" type="button" data-act="shiftToday">Today</button>
        </div>
        <div class="tiny">${esc(rangeText(start, end))}</div>
        <div class="btn-row">
          <button class="btn ${timeMode === 'zulu' ? 'primary' : 'ghost'} small" type="button" data-act="shiftZulu">UTC</button>
          <button class="btn ${timeMode === 'local' ? 'primary' : 'ghost'} small" type="button" data-act="shiftLocal">Local</button>
        </div>
      </div>
      ${error ? `<p class="note warn" style="margin:0 16px 14px">${icon('alert')} ${esc(error)}</p>` : ''}
      ${
        clashing.length
          ? `<p class="note warn" style="margin:0 16px 10px">${icon('alert')} <strong>${
              clashing.length === 1 ? 'A shift is' : `${clashing.length} shifts are`
            } rostered on somebody who is flying ${
              clashing.length === 1 ? 'it' : 'them'
            }.</strong> Somebody has to answer the flight deck, and it cannot be whoever is in it. Open one to see it:</p>
            <div class="btn-row os-jump">${clashing
              .map(
                (sh) =>
                  `<button class="btn ghost small" type="button" data-act="shiftGoDay" data-day="${dayOf(
                    ms(sh.starts_at),
                    days,
                  )}">${esc(person(sh.user_id)?.display_name || 'Somebody')} · ${esc(
                    zdate(sh.starts_at),
                  )} ${esc(spanText(ms(sh.starts_at), ms(sh.ends_at)))}</button>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="lr-scroll" id="os-scroll">
        <div class="lr-grid" style="--now-left:${nowLeftVar(start, end)}">
          <div class="lr-headrow">
            <div class="lr-corner">Controller</div>
            ${header(start, end)}
          </div>
          ${coverRow(start, end)}
          ${people.map((p) => row(p, start, end, run)).join('')}
        </div>
      </div>
      ${
        opsShifts().some((sh) => ms(sh.ends_at) > start && ms(sh.starts_at) < end)
          ? ''
          : `<p class="note" style="margin:10px 16px 0">Nothing is rostered on this day. Drag across a row to put a shift there${
              days.length > 1 ? ', or pick another day above' : ''
            }.</p>`
      }
      <p class="tiny">Drag across an empty row to roster a shift, drag either end of a bar to change when it starts or finishes, and drag the middle to move it - onto another row to hand it over. Times land on the quarter hour, Escape gives up on a drag, and tapping a bar opens the exact times, a note and Remove. The faint blocks behind are the sectors being flown, so the desk can be rostered against the flying. On a touch screen a finger still scrolls the timeline, so drawing a new shift by dragging wants a mouse or a stylus - or type it in below.</p>
      <p class="tiny">A controller who also flies - an admin, usually - has their own duty periods hatched in red on their row, report time to on blocks. A shift drawn across one is flagged, because somebody has to answer the flight deck and it cannot be whoever is in it. It is a flag and not a refusal: you can roster it anyway, and the app will ask once.</p>
    </section>
    ${editor()}`;
}

// ---- Writing ----

const iso = (t) => new Date(t).toISOString();

async function write(work) {
  saving = true;
  error = '';
  try {
    await work();
    await syncTeam();
  } catch (err) {
    error = err.message;
  }
  saving = false;
  rerender();
}

const saveShift = (fields, id) => write(() => saveOpsShift(fields, id));

export const opsTimelineActions = {
  shiftToday() {
    dayIndex = null;
    rerender();
  },
  // Straight to the day a flagged shift is on, from the warning at the top.
  shiftGoDay(el) {
    const day = Number(el.dataset.day);
    if (Number.isFinite(day) && day >= 0) dayIndex = day;
    rerender();
  },
  shiftZulu() {
    timeMode = 'zulu';
    rerender();
  },
  shiftLocal() {
    timeMode = 'local';
    rerender();
  },
  closeShift() {
    editingId = null;
    error = '';
    rerender();
  },
  delShiftBar(el) {
    if (!confirm('Remove this shift from the roster?')) return;
    editingId = null;
    return write(() => deleteOpsShift(el.dataset.id));
  },
  none() {},
};

export const opsTimelineChanges = {
  shiftDay(el) {
    dayIndex = Number(el.value);
    rerender();
  },
};

export const opsTimelineForms = {
  opsShiftEdit(data, formEl) {
    const problem = formEl.querySelector('.form-error');
    const at = (date, time) => new Date(`${data.get(date)}T${data.get(time)}:00Z`);
    const starts = at('startDate', 'startTime');
    const ends = at('endDate', 'endTime');
    const say = (msg) => {
      problem.textContent = msg;
      problem.hidden = false;
    };
    if (isNaN(starts) || isNaN(ends)) return say('Give the date and time the shift starts and ends.');
    if (ends <= starts) return say('The shift has to end after it starts.');
    problem.hidden = true;
    editingId = null;
    return saveShift(
      {
        user_id: String(data.get('user') || ''),
        starts_at: starts.toISOString(),
        ends_at: ends.toISOString(),
        notes: String(data.get('notes') || '').trim(),
      },
      String(data.get('id')),
    );
  },
};

// How many shifts anywhere on the roster are rostered on somebody who is
// flying them. Admin puts a mark on the Ops Desk tab when this is not zero, so
// the one thing on this page nobody should have to go looking for is visible
// from the rest of the section.
export function opsClashCount() {
  const run = running();
  return opsShifts().filter(
    (sh) => flyingBetween(sh.user_id, ms(sh.starts_at), ms(sh.ends_at), run).length,
  ).length;
}

// True while a drag is in flight or a write is going out, so app.js's
// background sync does not redraw the bar somebody is holding.
export const opsTimelineBusy = () => saving || !!drag;

// ---- Dragging ----
//
// Pointer events rather than HTML5 drag-and-drop: this needs the geometry all
// the way through the gesture, not just where it was dropped, and it has to
// work the same under a finger on the iPad at the desk. The bar is moved by
// hand while the gesture runs and written once at the end, so a drag never
// waits on the network and a bad one can be given up on by pressing Escape.

let drag = null;

// How far the pointer has travelled, as a whole number of quarter hours.
const stepOf = (dx) => snap((dx / PX_PER_HOUR) * HOUR);

// What the gesture would make of the shift, as [from, to]. Moving keeps the
// length exactly and shifts both ends by the same step, so a shift that starts
// at 0545 still does; dragging an end lands on the quarter hour itself.
function dragTimes(d) {
  const step = stepOf(d.dx);
  if (d.kind === 'move') return [d.from + step, d.to + step];
  if (d.kind === 'start') return [Math.min(snap(d.from + step), d.to - MIN_SHIFT), d.to];
  if (d.kind === 'end') return [d.from, Math.max(snap(d.to + step), d.from + MIN_SHIFT)];
  // A new shift, drawn from where the pointer went down to where it is now.
  const other = snap(timeAt(d.originPx + d.dx, d.start));
  return [Math.min(d.anchor, other), Math.max(d.anchor, other)];
}

function paint(el, from, to, start, end) {
  el.style.left = `${left(Math.max(from, start), start)}px`;
  el.style.width = `${widthPx(from, to, start, end)}px`;
  const t = el.querySelector('.lr-bar-t');
  const s = el.querySelector('.lr-bar-s');
  if (t) t.textContent = spanText(from, to);
  if (s) s.textContent = lengthText(from, to);
}

// Which controller's row the pointer is over, so a bar can be handed across.
function rowUnder(x, y) {
  const el = document.elementFromPoint(x, y)?.closest('.os-track');
  return el?.dataset.user || null;
}

function endDrag(commit, x, y) {
  const d = drag;
  drag = null;
  if (!d) return;
  d.ghost.classList.remove('os-dragging');
  if (d.kind === 'new') d.ghost.remove();
  for (const t of document.querySelectorAll('.os-track')) t.classList.remove('drop-target');
  window.removeEventListener('pointermove', d.onMove);
  window.removeEventListener('pointerup', d.onUp);
  window.removeEventListener('pointercancel', d.onCancel);
  window.removeEventListener('keydown', d.onKey);

  // A gesture that never moved anything leaves the page exactly as it was, so
  // it is not redrawn. That matters on a touch screen: a finger laid on a row
  // to scroll the timeline arrives here as a cancelled drag, and redrawing
  // would reset the scroll and kill the fling half way through.
  if (!d.moved) {
    if (!commit || d.kind === 'new') return;
    editingId = d.id;
    error = '';
    return rerender();
  }
  if (!commit) return rerender();
  const [from, to] = dragTimes(d);
  if (to - from < MIN_SHIFT) return rerender();
  // Only moving a whole shift hands it over. A resize, or a new bar being
  // drawn, keeps the row it started in however far the pointer wandered up
  // the page while it was doing it.
  const user = (d.kind === 'move' && x != null && rowUnder(x, y)) || d.user;
  // Putting somebody on the desk while they are flying is asked about at the
  // moment it is done, rather than only shown in red afterwards.
  const clash = flyingBetween(user, from, to, running());
  if (
    clash.length &&
    !confirm(
      `${person(user)?.display_name || 'They'} would be on the desk while flying ${clashWords(
        clash,
      )}.\n\nRoster it anyway?`,
    )
  ) {
    return rerender();
  }
  if (d.kind === 'new') {
    return saveShift({ user_id: user, starts_at: iso(from), ends_at: iso(to), notes: '' });
  }
  const shift = opsShifts().find((s) => s.id === d.id);
  if (!shift) return rerender();
  return saveShift(
    { user_id: user, starts_at: iso(from), ends_at: iso(to), notes: shift.notes || '' },
    d.id,
  );
}

function startDrag(e, opts) {
  const { start, end } = windowRange();
  drag = { ...opts, start, end, dx: 0, moved: false };
  drag.ghost.classList.add('os-dragging');
  drag.onMove = (ev) => {
    if (!drag) return;
    drag.dx = ev.clientX - opts.clientX;
    if (Math.abs(drag.dx) > 3) drag.moved = true;
    const [from, to] = dragTimes(drag);
    paint(drag.ghost, from, to, start, end);
    // Dragging a whole shift onto somebody else's row says so while it is
    // still in the air, rather than only once it lands.
    const over = rowUnder(ev.clientX, ev.clientY);
    for (const t of document.querySelectorAll('.os-track')) {
      t.classList.toggle('drop-target', drag.kind === 'move' && drag.moved && !!over && t.dataset.user === over && over !== opts.user);
    }
  };
  drag.onUp = (ev) => endDrag(true, ev.clientX, ev.clientY);
  drag.onCancel = () => endDrag(false);
  drag.onKey = (ev) => {
    if (ev.key === 'Escape') endDrag(false);
  };
  window.addEventListener('pointermove', drag.onMove);
  window.addEventListener('pointerup', drag.onUp);
  window.addEventListener('pointercancel', drag.onCancel);
  window.addEventListener('keydown', drag.onKey);
}

export function mountedOpsTimeline(root) {
  const scroll = root.querySelector('#os-scroll');
  if (!scroll) return;
  const { start, end } = windowRange();
  const key = `${start}|${timeMode}`;
  if (key !== scrollKey) {
    const now = Date.now();
    scrollKey = key;
    scrollAt = { left: now >= start && now <= end ? Math.max(0, left(now, start) - 140) : 0, top: 0 };
  }
  scroll.scrollLeft = scrollAt.left;
  scroll.scrollTop = scrollAt.top;
  scroll.addEventListener(
    'scroll',
    () => {
      scrollAt = { left: scroll.scrollLeft, top: scroll.scrollTop };
    },
    { passive: true },
  );

  for (const el of root.querySelectorAll('.os-bar')) {
    el.addEventListener('pointerdown', (e) => {
      if (drag || e.button) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture?.(e.pointerId);
      const shift = opsShifts().find((s) => s.id === el.dataset.shift);
      if (!shift) return;
      const edge = e.target.closest('.os-handle')?.dataset.edge;
      startDrag(e, {
        kind: edge === 'start' ? 'start' : edge === 'end' ? 'end' : 'move',
        id: shift.id,
        user: shift.user_id,
        from: ms(shift.starts_at),
        to: ms(shift.ends_at),
        clientX: e.clientX,
        ghost: el,
      });
    });
    // A keyboard is not a pointer, so the bar still opens its editor.
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      editingId = el.dataset.shift;
      rerender();
    });
  }

  for (const track of root.querySelectorAll('.os-track')) {
    track.addEventListener('pointerdown', (e) => {
      if (drag || e.button) return;
      e.preventDefault();
      const rect = track.getBoundingClientRect();
      const originPx = e.clientX - rect.left;
      const anchor = snap(timeAt(originPx, start));
      // A bar drawn in place, which the gesture then stretches. It is the
      // same markup a saved shift gets, so what is being made looks like
      // what will be there.
      const ghost = document.createElement('div');
      ghost.className = 'lr-bar os-bar plan os-ghost';
      ghost.innerHTML = '<span class="lr-bar-t"></span><span class="lr-bar-s"></span>';
      ghost.style.left = `${left(anchor, start)}px`;
      ghost.style.width = '6px';
      track.appendChild(ghost);
      startDrag(e, {
        kind: 'new',
        user: track.dataset.user,
        anchor,
        originPx,
        from: anchor,
        to: anchor,
        clientX: e.clientX,
        ghost,
      });
    });
  }
}
