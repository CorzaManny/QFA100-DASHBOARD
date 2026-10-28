// The maths behind the two Gantt-style timelines: the Landscape view of who is
// flying what (js/views/liveroster.js) and the ops desk's own shift roster
// (js/views/opsroster.js). Pure functions - hours to pixels, pixels back to
// hours, and which midnight a day starts on in whichever clock is showing.
//
// It lives on its own because both timelines have to agree about it to the
// pixel: a bar drawn by one set of sums and dragged by another lands somewhere
// nobody asked for.

import { SIM_TZ } from '../ui.js';

export const MINUTE = 60000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// One hour of timeline. Wide enough that a 40-minute sector is still a bar you
// can read and grab, which is what decides it.
export const PX_PER_HOUR = 100;

// Sydney's current offset from UTC, in minutes: a short relay does not cross a
// daylight-saving change, so one offset for the whole event is accurate
// enough, and far simpler than redoing it per instant.
const SIM_TZ_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: SIM_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
export function simOffsetMinutes(t = Date.now()) {
  const p = Object.fromEntries(SIM_TZ_FORMAT.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - t) / MINUTE);
}

// "31 OCT" in Sydney's calendar, to label a day by the date it actually is
// there - zdate's UTC date would be wrong once the day starts at local
// midnight, which can fall on the previous UTC date.
const SIM_DATE_LABEL = new Intl.DateTimeFormat('en-GB', { timeZone: SIM_TZ, day: '2-digit', month: 'short' });
export const localDateLabel = (t) => SIM_DATE_LABEL.format(new Date(t)).toUpperCase().replace(',', '');

// Midnight on or before t, in whichever clock is selected: UTC midnight for
// Zulu, Sydney midnight for Local. Shift into that clock's frame, floor to a
// day, then shift back - so the grid always starts right on midnight,
// whichever one is showing, instead of UTC midnight relabelled.
export function dayStart(t, offsetMs) {
  return Math.floor((t + offsetMs) / DAY) * DAY - offsetMs;
}

// Every calendar day a set of instants touches, earliest first, in whichever
// clock is selected. With nothing to show, today is the only day.
export function daysSpanning(times, offsetMs) {
  if (!times.length) return [dayStart(Date.now(), offsetMs)];
  const first = dayStart(Math.min(...times), offsetMs);
  const last = dayStart(Math.max(...times), offsetMs);
  const days = [];
  for (let t = first; t <= last; t += DAY) days.push(t);
  return days;
}

export const left = (t, start) => Math.max(0, ((t - start) / HOUR) * PX_PER_HOUR);
export const widthPx = (from, to, start, end) =>
  Math.max(6, ((Math.min(to, end) - Math.max(from, start)) / HOUR) * PX_PER_HOUR);
export const trackWidth = (start, end) => ((end - start) / HOUR) * PX_PER_HOUR;

// Pixels back to a moment: the other direction, for anything dragged.
export const timeAt = (px, start) => start + (px / PX_PER_HOUR) * HOUR;

// Dragged times land on a quarter of an hour. A shift roster written by hand
// never says 0843, and a bar that can stop anywhere is harder to line up with
// the one before it than one that cannot.
export const SNAP = 15 * MINUTE;
export const snap = (t) => Math.round(t / SNAP) * SNAP;

export function hourTicks(start, end) {
  const out = [];
  const first = Math.ceil(start / HOUR) * HOUR;
  for (let t = first; t < end; t += HOUR) out.push(t);
  return out;
}
