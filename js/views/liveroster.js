// Live roster: a Gantt-style timeline of who is on duty, sector by sector,
// so ops staff can see the whole team's day at a glance instead of reading
// it one sector at a time. Ops only — pilots already have their own roster.

import { state } from '../store.js';
import { esc, zulu, zdate, icon, rerender } from '../ui.js';
import {
  canEdit,
  rosterable,
  running,
  reportAt,
  isDraft,
} from '../ops.js';

// One screen's worth of the timeline: a day either side of "now" by default,
// moved a day at a time.
const WINDOW_HOURS = 24;
const PX_PER_HOUR = 90;
const MINUTE = 60000;
const HOUR = 60 * MINUTE;

// How far the window has been moved from today, in whole days.
let dayOffset = 0;

function windowRange() {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const start = base.getTime() + dayOffset * 24 * HOUR - 3 * HOUR;
  return { start, end: start + WINDOW_HOURS * HOUR };
}

// Everyone who could be on a sector, with the duty rows that fall in this
// window attached, worst (earliest) first.
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
    const bar = { entry, sector, from, to, state: row?.state || 'later' };
    if (!byPerson.has(entry.user_id)) byPerson.set(entry.user_id, []);
    byPerson.get(entry.user_id).push(bar);
  }
  const rows = [];
  for (const p of rosterable()) {
    const bars = (byPerson.get(p.id) || []).sort((a, b) => a.from - b.from);
    if (bars.length) rows.push({ p, bars });
  }
  rows.sort((a, b) => a.bars[0].from - b.bars[0].from || a.p.display_name.localeCompare(b.p.display_name));
  return rows;
}

const left = (t, start) => Math.max(0, ((t - start) / HOUR) * PX_PER_HOUR);
const width = (from, to, start, end) =>
  Math.max(6, ((Math.min(to, end) - Math.max(from, start)) / HOUR) * PX_PER_HOUR);

function hourTicks(start, end) {
  const out = [];
  const first = Math.ceil(start / HOUR) * HOUR;
  for (let t = first; t < end; t += HOUR) out.push(t);
  return out;
}

function dayLabel(t) {
  const d = new Date(t);
  return d.getUTCHours() === 0 ? zdate(t) : '';
}

function header(start, end) {
  const ticks = hourTicks(start, end);
  const marks = ticks
    .map((t) => {
      const day = dayLabel(t);
      return `<div class="lr-tick" style="left:${left(t, start)}px">
        ${day ? `<div class="lr-day">${esc(day)}</div>` : ''}
        <div class="lr-hour">${esc(zulu(t))}</div>
      </div>`;
    })
    .join('');
  const now = Date.now();
  const nowMark =
    now >= start && now <= end
      ? `<div class="lr-now-line" style="left:${left(now, start)}px"><span>NOW</span></div>`
      : '';
  return `<div class="lr-head-track" style="width:${((end - start) / HOUR) * PX_PER_HOUR}px">${marks}${nowMark}</div>`;
}

// A single CSS variable, set once on the grid, that every row's track reads
// to draw its own slice of the same "now" line without redoing the sum per row.
function nowLeftVar(start, end) {
  const now = Date.now();
  return now >= start && now <= end ? `${left(now, start)}px` : '-9999px';
}

function barClass(bar) {
  if (bar.state === 'done') return 'done';
  if (bar.state === 'airborne') return 'live';
  return 'plan';
}

function bar(b, start, end) {
  const s = b.sector;
  const title = `${s.flight} · ${s.dep} → ${s.arr} · ${esc(b.entry.duty)}\n${zulu(b.from)}–${zulu(b.to)}Z`;
  return `<a class="lr-bar ${barClass(b)}" style="left:${left(Math.max(b.from, start), start)}px;width:${width(
    b.from,
    b.to,
    start,
    end,
  )}px" href="#/roster/${esc(s.id)}" title="${esc(title)}">
    <span class="lr-bar-t">${esc(s.flight)}</span>
    <span class="lr-bar-s">${esc(s.dep)}–${esc(s.arr)}</span>
  </a>`;
}

function row({ p, bars }, start, end) {
  return `
    <div class="lr-row">
      <div class="lr-name"><span class="lr-avatar">${esc(initials(p.display_name))}</span>${esc(p.display_name)}</div>
      <div class="lr-track" style="width:${((end - start) / HOUR) * PX_PER_HOUR}px">
        ${bars.map((b) => bar(b, start, end)).join('')}
      </div>
    </div>`;
}

function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '··';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words.at(-1)[0]).toUpperCase();
}

export function render() {
  if (!canEdit()) {
    return `<div class="page-head"><h1>Live roster</h1></div>
      <section class="card"><p class="note">This page is for admins, dispatchers and operations.</p></section>`;
  }
  const { start, end } = windowRange();
  const rows = crewRows(start, end);
  return `
    <div class="page-head">
      <h1>Live roster</h1>
      <span class="badge ${isDraft() ? 'warn' : 'ok'}">ROSTER ${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span>
    </div>
    <section class="card lr-card">
      <div class="lr-toolbar">
        <div class="tiny">${esc(zdate(start))} – ${esc(zdate(end - MINUTE))}</div>
        <div class="btn-row">
          <button class="btn ghost small" data-act="today">Today</button>
          <button class="btn ghost small icon-btn" data-act="prev" aria-label="Previous day">${icon('back')}</button>
          <button class="btn ghost small icon-btn" data-act="next" aria-label="Next day">${icon('chevron')}</button>
        </div>
      </div>
      ${
        rows.length
          ? `<div class="lr-scroll" id="lr-scroll">
              <div class="lr-grid" style="--now-left:${nowLeftVar(start, end)}">
                <div class="lr-headrow">
                  <div class="lr-corner">Name</div>
                  ${header(start, end)}
                </div>
                ${rows.map((r) => row(r, start, end)).join('')}
              </div>
            </div>
            <p class="tiny">Each bar is a report-to-debrief duty period; it follows the running delay once the day is live. Tap a bar to open that sector.</p>`
          : `<p class="note">Nobody is rostered in this window.</p>`
      }
    </section>`;
}

export const actions = {
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
};

// Bring "now" into view instead of leaving the operator to scroll for it.
export function mounted() {
  if (!canEdit()) return;
  const el = document.getElementById('lr-scroll');
  if (!el) return;
  const { start } = windowRange();
  const now = Date.now();
  if (now < start) return;
  el.scrollLeft = Math.max(0, left(now, start) - 120);
}
