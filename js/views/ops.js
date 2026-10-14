// The ops board: everything that needs doing before the next few sectors go,
// on one page. Who is still to report and when, which sectors are short of
// pilots, which have no flight plan yet, and the weather where they are going.
//
// Nothing here is new information; it is the rest of the app gathered up so
// ops staff do not have to walk four pages to find out what is behind.

import { state } from '../store.js';
import { esc, zulu, zdate, span, ago, simLocal, icon, rerender } from '../ui.js';
import { countdown } from './dash.js';
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
} from '../ops.js';

// How far ahead the board looks. Beyond this it is planning, not operating.
const AHEAD_HOURS = 24;
const onOps = () => location.hash.startsWith('#/ops');

const name = (id) => esc(person(id)?.display_name || 'Unknown');
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

export function render() {
  if (!canEdit()) {
    return `<div class="page-head"><h1>Ops board</h1></div>
      <section class="card"><p class="note">This page is for admins, dispatchers and operations.</p></section>`;
  }
  const now = Date.now();
  return `
    <div class="page-head"><h1>Ops board</h1>
      <span class="badge ${isDraft() ? 'warn' : 'ok'}">ROSTER ${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span></div>
    ${
      biddingOn() && biddingOpen(now)
        ? `<p class="note warn">${icon('alert')} Bidding is open until <strong>${when(
            bidsCloseAt(),
          )}</strong>. The roster cannot be published until it closes.</p>`
        : ''
    }
    ${summary(now)}
    ${reports(now)}
    ${crewing(now)}
    ${planning(now)}
    ${airports(now)}
    <p class="tiny center">Everything here looks ${AHEAD_HOURS} hours ahead, except crewing, which looks at the whole schedule.</p>`;
}

// The weather is the only thing this page has to go and get.
export function mounted() {
  if (!canEdit()) return;
  const now = Date.now();
  const codes = [];
  for (const s of soon(now)) {
    for (const code of [s.dep, s.arr]) if (!codes.includes(code)) codes.push(code);
  }
  const stale = codes.slice(0, 8).filter((c) => !state.metar[c] || now - state.metar[c].at > 10 * 60000);
  if (!stale.length) return;
  Promise.allSettled(stale.map((c) => fetchMetar(c))).then(() => onOps() && rerender());
}
