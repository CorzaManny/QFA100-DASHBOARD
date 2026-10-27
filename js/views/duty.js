// Duty Report: the printable sheet a pilot takes to the flight deck.
//
// One duty period per sheet - the next one by default - with the back-to-back
// sectors in it summarised at the top, then a box per sector carrying the
// flight, its times, the aeroplane and who is in each seat, and otherwise
// left empty to be written on in flight. It prints through the browser's own
// print dialogue, so the same button saves it as a PDF.

import { state } from '../store.js';
import { configured } from '../api.js';
import { esc, zdate, zulu, span, simLocal, icon, rerender } from '../ui.js';
import {
  me, person, crewOf, openSeats, briefingOf, canEdit, isDraft, DUTIES,
  teamCallsign, teamAircraft, teamRego, airport,
} from '../ops.js';

// Which duty period is on the sheet, by the id of the sector it starts with.
// Empty means the next one.
let chosen = '';

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (t) => {
  const d = new Date(t);
  return isNaN(d) ? '' : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

// Zulu days since the epoch, for counting how many midnights a duty crosses.
const utcDay = (t) => Math.floor(new Date(t).getTime() / 86400000);

// A time on the sheet, with the day marked when the duty has run past
// midnight Zulu - otherwise a duty that lands at 01:20 reads as landing
// before it left.
function at(t, base) {
  const off = utcDay(t) - utcDay(base);
  return `${hhmm(t)}${off > 0 ? `<sup>+${off}</sup>` : ''}`;
}

// My sectors, split into duty periods. A real break - time between being
// released at the end of one sector and signing on for the next - starts a
// new period; sectors flown back-to-back inside the same duty stay together.
// This is the same gap the Team Roster draws as "off duty".
function myPeriods() {
  const byId = new Map(state.sectors.map((s) => [s.id, s]));
  const myId = me()?.id;
  const mine = state.roster
    .filter((r) => r.user_id === myId && byId.has(r.sector_id))
    .map((r) => ({ r, s: byId.get(r.sector_id) }))
    .sort((a, b) => new Date(a.s.std) - new Date(b.s.std));
  const periods = [];
  for (const leg of mine) {
    const current = periods.at(-1);
    if (current && new Date(leg.r.report_at) <= new Date(current.at(-1).s.sta)) current.push(leg);
    else periods.push([leg]);
  }
  return periods;
}

// The period on the sheet: the one picked, or the next one still to be flown,
// or - once the event is over - the last one there was.
function periodFor(periods) {
  const now = Date.now();
  return (
    periods.find((p) => p[0].s.id === chosen) ||
    periods.find((p) => new Date(p.at(-1).s.sta) >= now) ||
    periods.at(-1) ||
    null
  );
}

const signOn = (period) => new Date(period[0].r.report_at);
const signOff = (period) => new Date(period.at(-1).s.sta);

// A duty period's own name, for the picker.
const periodLabel = (p) =>
  `${zdate(p[0].r.report_at)} · ${p[0].s.dep} → ${p.at(-1).s.arr} · ${p.length} sector${p.length === 1 ? '' : 's'}`;

// An airport's name with the words every airport's name ends in taken off
// it: on a line this narrow "Sydney Kingsford Smith" says more than
// "Sydney Kingsford Smith International Air" would. A bare "Field" is left
// alone, because in a name like Love Field it is the name.
const shortName = (name) =>
  name.replace(
    /\s+(?:International|Regional|Municipal|National|Domestic)?\s*(?:Airport|Airfield|Airstrip|Airpark|Aerodrome|Air\s+Base)$/i,
    '',
  ) || name;

// An airport the way it goes in a sector box: the code, which is what gets
// read out and typed in, with where it actually is underneath - the airport
// short and the country it is in as its two-letter code. The codes come from
// the roster and the rest from js/data/airports.json, which app.js loads at
// startup and rerenders after, so a code it does not carry prints on its own.
function apt(code) {
  const a = airport(code);
  const where = a && [shortName(a.name), a.country].filter(Boolean).join(' · ');
  return `<span class="duty-apt"><span class="duty-apt-icao">${esc(code)}</span>${
    where ? `<span class="duty-apt-name">${esc(where)}</span>` : ''
  }</span>`;
}

const SEAT = { Captain: 'CPT', 'First Officer': 'FO', 'Relief Pilot': 'RP', Observer: 'OBS' };

// Every seat on a sector in seat order, filled or not: an empty one is a line
// to write a name on rather than a seat left off the sheet.
function seatRows(sector) {
  const rows = [
    ...crewOf(sector).map((r) => ({ duty: r.duty, id: r.user_id })),
    ...openSeats(sector).map((duty) => ({ duty, id: null })),
  ];
  return rows.sort((a, b) => DUTIES.indexOf(a.duty) - DUTIES.indexOf(b.duty));
}

// The aeroplane for a sector. The team flies the one aeroplane all week, so
// the registration is the team's rather than the sector's: this sector's own
// OFP if it has one, otherwise the rego off whatever OFP has been imported
// elsewhere, which is the same airframe and so the same aeroplane. It is left
// blank to be written in only when no plan has been imported at all.
function aircraft(sector) {
  const ofp = briefingOf(sector.id).ofp;
  return { type: ofp?.acft || teamAircraft(), rego: ofp?.reg || teamRego() };
}

// The block at the top: every sector of the duty on one line, the way the
// roster hands it over.
function summary(period) {
  const base = signOn(period);
  const rows = period
    .map(({ s }) => {
      const ac = aircraft(s);
      return `<tr>
        <td class="l">${esc(s.flight)}</td>
        <td>${at(s.std, base)}</td>
        <td>${esc(s.dep)}</td>
        <td>${esc(s.arr)}</td>
        <td>${at(s.sta, base)}</td>
        <td>${esc(ac.type)}</td>
        <td>${esc(ac.rego)}</td>
      </tr>`;
    })
    .join('');
  return `<table class="duty-summary">
    <thead><tr><th class="l">ACTIVITY</th><th>START</th><th>DEP</th><th>ARR</th><th>END</th><th>ACTYPE</th><th>REGO</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// One sector: its line of figures, who is flying it, and the rest of the box
// left clear for whatever gets written down on the way.
function sectorBox(leg, base, myId) {
  const { s } = leg;
  const ac = aircraft(s);
  const crew = seatRows(s)
    .map(
      (row) => `<div class="duty-seat">
        <span class="duty-seat-duty">${esc(SEAT[row.duty] || row.duty)}</span>
        <span class="duty-seat-name${row.id && row.id === myId ? ' mine' : ''}">${esc(
          row.id ? person(row.id)?.display_name || 'Unknown' : '',
        )}</span>
      </div>`,
    )
    .join('');
  return `<section class="duty-box">
    <div class="duty-box-head">
      <div class="duty-f"><span class="duty-f-k">FLT NUMBER</span><span class="duty-f-v">${esc(s.flight)}</span></div>
      <div class="duty-f"><span class="duty-f-k">ETD</span><span class="duty-f-v">${at(s.std, base)}</span></div>
      <div class="duty-f"><span class="duty-f-k">DEP</span><span class="duty-f-v">${apt(s.dep)}</span></div>
      <div class="duty-f"><span class="duty-f-k">ARR</span><span class="duty-f-v">${apt(s.arr)}</span></div>
      <div class="duty-f"><span class="duty-f-k">ETA</span><span class="duty-f-v">${at(s.sta, base)}</span></div>
      <div class="duty-f"><span class="duty-f-k">A/C</span><span class="duty-f-v">${esc(ac.type)}</span></div>
      <div class="duty-f"><span class="duty-f-k">REGO</span><span class="duty-f-v">${esc(ac.rego)}</span></div>
    </div>
    <div class="duty-box-body">
      <div class="duty-crew">${crew}</div>
    </div>
  </section>`;
}

function sheet(period) {
  const base = signOn(period);
  const myId = me()?.id;
  const on = signOn(period);
  const off = signOff(period);
  return `<div class="duty-sheet">
    <header class="duty-sheet-head">
      <div>
        <div class="duty-title">DUTY REPORT</div>
        <div class="duty-sub">${esc(teamCallsign())} · WORLDFLIGHT · ALL TIMES ZULU</div>
      </div>
      <div class="duty-who">
        <div class="duty-who-name">${esc(me()?.display_name || '')}</div>
        <div class="duty-sub">${esc(zdate(on))} ${new Date(on).getUTCFullYear()}</div>
      </div>
    </header>
    <div class="duty-signline">
      <span>SIGN ON <strong>${hhmm(on)}</strong></span>
      <span>SIGN OFF <strong>${at(off, base)}</strong></span>
      <span>DUTY <strong>${span(off - on)}</strong></span>
      <span>SECTORS <strong>${period.length}</strong></span>
    </div>
    ${summary(period)}
    ${period.map((leg) => sectorBox(leg, base, myId)).join('')}
  </div>`;
}

function picker(periods, period) {
  if (periods.length < 2) return '';
  return `<label class="field duty-pick noprint">Duty period
    <select data-change="period">
      ${periods
        .map((p) => `<option value="${esc(p[0].s.id)}" ${p === period ? 'selected' : ''}>${esc(periodLabel(p))}</option>`)
        .join('')}
    </select>
  </label>`;
}

export function render() {
  if (!configured) {
    return `<div class="page-head"><h1>Duty Report</h1></div>
      <section class="card"><p class="note">The duty report is built from the team's roster, and this app is not connected to its database yet.</p></section>`;
  }
  if (isDraft() && !canEdit()) {
    return `<div class="page-head"><h1>Duty Report</h1><span class="badge warn">DRAFT</span></div>
      <section class="card"><p class="note">The roster is still being put together. Your duty report appears here once ops publish it.</p>
      <a class="btn ghost" href="#/roster">Team Roster</a></section>`;
  }
  const periods = myPeriods();
  const period = periodFor(periods);
  if (!period) {
    return `<div class="page-head"><h1>Duty Report</h1></div>
      <section class="card"><p class="note">You are not rostered on any sectors yet, so there is no duty to report. Once you are, this page prints the sheet for it.</p>
      <a class="btn ghost" href="#/roster">Team Roster</a></section>`;
  }
  const on = signOn(period);
  return `<div class="page-head noprint"><a class="back" href="#/roster">${icon('back')} Team Roster</a></div>
    <div class="btn-row noprint">
      <button type="button" class="btn primary" data-act="print">${icon('file')} Print this sheet</button>
      ${picker(periods, period)}
    </div>
    <p class="note noprint">Sign on <strong>${zulu(on)}</strong> · ${simLocal(on)} in Sydney. Only the sheet below prints; everything else on the page is left off it. Choosing "Save as PDF" in the print dialogue keeps a copy instead.</p>
    ${sheet(period)}`;
}

export const actions = {
  print() {
    window.print();
  },
};

export const changes = {
  period(el) {
    chosen = el.value;
    rerender();
  },
};
