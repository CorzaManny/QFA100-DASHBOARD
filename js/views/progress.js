// The logbook: how far round the world the aeroplane has got, and who flew
// what. Everything here is worked out from the schedule, the roster
// and the times the flight deck stamped, so there is nothing extra to keep up
// to date.

import { state } from '../store.js';
import { esc, zulu, zdate, span, icon, rerender } from '../ui.js';
import { loadWorld, mapSvg, worldReady } from '../map.js';
import { sortedSectors, actualOf, airport, crewOf, person, me, canEdit, distNm, PILOT_DUTIES } from '../ops.js';

const HOUR = 3600000;
const onProgress = () => location.hash.startsWith('#/progress');

// A sector counts as flown once the flight deck stamps on blocks. One that is
// past its arrival time without a stamp is taken as flown too, so the figures
// still read true when somebody forgets; one marked as not flown never counts.
function flownState(s, now) {
  const a = actualOf(s.id);
  if (a?.skipped) return 'skipped';
  if (a?.on_blocks) return 'done';
  if (a?.off_blocks) return 'flying';
  return new Date(s.sta) < now ? 'done' : new Date(s.std) < now ? 'flying' : 'later';
}

// Block time: what it really took when both times were stamped, otherwise what
// the schedule says it should take.
function blockMs(s) {
  const a = actualOf(s.id);
  if (a?.off_blocks && a?.on_blocks) {
    const ms = new Date(a.on_blocks) - new Date(a.off_blocks);
    if (ms > 0) return ms;
  }
  return new Date(s.sta) - new Date(s.std);
}

const legNm = (s) => {
  const dep = airport(s.dep);
  const arr = airport(s.arr);
  return dep && arr ? distNm(dep.lat, dep.lon, arr.lat, arr.lon) : 0;
};

const hours = (ms) => (ms / HOUR).toFixed(1);
const nm = (n) => Math.round(n).toLocaleString('en-AU');

function tally(now) {
  const sectors = sortedSectors();
  let doneCount = 0;
  let doneNm = 0;
  let totalNm = 0;
  let doneMs = 0;
  const airports = new Set();
  let flying = null;
  for (const s of sectors) {
    const st = flownState(s, now);
    const d = legNm(s);
    totalNm += d;
    if (st === 'done') {
      doneCount += 1;
      doneNm += d;
      doneMs += blockMs(s);
      airports.add(s.dep);
      airports.add(s.arr);
    }
    if (st === 'flying') flying = s;
  }
  const next = sectors.find((s) => flownState(s, now) === 'later');
  return { sectors, doneCount, doneNm, totalNm, doneMs, airports, flying, next };
}

function progressMap(t, now) {
  if (!worldReady()) return '<p class="note">Loading the map…</p>';
  const legs = [];
  for (const s of t.sectors) {
    const from = airport(s.dep);
    const to = airport(s.arr);
    if (!from || !to) continue;
    const st = flownState(s, now);
    legs.push({ from, to, done: st === 'done', active: st === 'flying' });
  }
  if (!legs.length) return '<p class="note">No sectors with known airports yet.</p>';
  const start = airport(t.sectors[0].dep);
  const marks = start ? [{ lon: start.lon, lat: start.lat, label: start.icao, kind: 'dep' }] : [];
  // The aeroplane is only drawn when it is actually being tracked.
  const live = state.track;
  const plane =
    live?.online && live.lat != null && live.lon != null ? { lon: live.lon, lat: live.lat, hdg: live.hdg } : null;
  if (plane) {
    const here = airport(live.arr);
    if (here) marks.push({ lon: here.lon, lat: here.lat, label: here.icao, kind: 'arr' });
  }
  return `<div class="map-wrap">${mapSvg({
    legs,
    marks,
    plane,
    height: 520,
    pad: 46,
    title: 'The route around the world',
  })}</div>`;
}

// How far round the world, rather than how far flown: a lap of the planet at
// the latitudes actually flown, so a detour does not read as extra progress.
function lapPercent(t) {
  if (!t.totalNm) return 0;
  return Math.max(0, Math.min(100, Math.round((t.doneNm / t.totalNm) * 100)));
}

function stat(label, value, sub = '') {
  return `<div class="kv"><span>${label}</span><strong>${value}</strong>${sub ? `<span class="tiny">${sub}</span>` : ''}</div>`;
}

function headline(t, now) {
  const pct = lapPercent(t);
  const where = t.flying
    ? `<strong>${esc(t.flying.flight)}</strong> ${esc(t.flying.dep)} → ${esc(t.flying.arr)} is in the air`
    : t.next
      ? `Next up: <strong>${esc(t.next.flight)}</strong> ${esc(t.next.dep)} → ${esc(t.next.arr)} at ${zulu(t.next.std)} on ${zdate(t.next.std)}`
      : t.doneCount
        ? 'Every sector has been flown. The aeroplane is home.'
        : 'The event has not started yet.';
  return `
    <section class="card">
      <div class="card-head"><h2>Around the world</h2>
        <span class="badge ${pct >= 100 ? 'ok' : 'info'}">${pct}% COMPLETE</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
      <p class="note">${where}</p>
      ${progressMap(t, now)}
      <div class="kvs">
        ${stat('Sectors flown', `${t.doneCount} / ${t.sectors.length}`)}
        ${stat('Distance flown', `${nm(t.doneNm)} NM`, `of ${nm(t.totalNm)} NM`)}
        ${stat('Block time', `${hours(t.doneMs)} h`)}
        ${stat('Airports visited', String(t.airports.size))}
      </div>
    </section>`;
}

// Who has flown what. Only sectors that have actually been flown are counted,
// so it fills up as the event runs rather than showing the plan.
function logbook(now) {
  const flown = sortedSectors().filter((s) => flownState(s, now) === 'done');
  const byPilot = new Map();
  for (const s of flown) {
    for (const r of crewOf(s)) {
      if (!PILOT_DUTIES.includes(r.duty)) continue;
      const p = person(r.user_id);
      if (!p) continue;
      const row = byPilot.get(p.id) || { p, sectors: 0, ms: 0, nm: 0, duties: {}, legs: [] };
      row.sectors += 1;
      row.ms += blockMs(s);
      row.nm += legNm(s);
      row.duties[r.duty] = (row.duties[r.duty] || 0) + 1;
      row.legs.push({ s, duty: r.duty });
      byPilot.set(p.id, row);
    }
  }
  const rows = [...byPilot.values()].sort((a, b) => b.ms - a.ms || a.p.display_name.localeCompare(b.p.display_name));
  if (!rows.length) {
    return `<section class="card"><h2>Crew hours</h2>
      <p class="note">Nobody has flown a sector yet. Each one fills in here as it is flown.</p></section>`;
  }
  const short = { Captain: 'CPT', 'First Officer': 'FO', 'Relief Pilot': 'RLF' };
  const myId = me()?.id;
  const body = rows
    .map(
      (r) => `
      <tr${r.p.id === myId ? ' class="mine"' : ''}>
        <td>${esc(r.p.display_name)}${r.p.id === myId ? ' <span class="badge mute">YOU</span>' : ''}</td>
        <td class="num">${r.sectors}</td>
        <td class="num">${hours(r.ms)}</td>
        <td class="num">${nm(r.nm)}</td>
        <td>${PILOT_DUTIES.filter((d) => r.duties[d])
          .map((d) => `${short[d]}&nbsp;${r.duties[d]}`)
          .join(' · ')}</td>
      </tr>`,
    )
    .join('');
  return `
    <section class="card">
      <div class="card-head"><h2>Crew hours</h2><span class="badge info">${rows.length} PILOT${rows.length === 1 ? '' : 'S'}</span></div>
      <table class="table logbook">
        <thead><tr><th>Pilot</th><th class="num">Sectors</th><th class="num">Hours</th><th class="num">NM</th><th>Seats</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <p class="tiny">The logbook follows the roster: whoever is rostered in a seat is counted as having flown it. Block time is what the flight deck stamped, or the scheduled time where nobody stamped one.${
        canEdit() ? ' If somebody else really sat in the seat, change it in <a href="#/admin/auto">Admin → Roster → Flown</a>.' : ''
      }</p>
    </section>`;
}

// The signed-in pilot's own sectors, newest first.
function mine(now) {
  const myId = me()?.id;
  if (!myId) return '';
  const legs = sortedSectors()
    .filter((s) => flownState(s, now) === 'done' && crewOf(s).some((r) => r.user_id === myId))
    .reverse();
  if (!legs.length) return '';
  const rows = legs
    .map((s) => {
      const duty = crewOf(s).find((r) => r.user_id === myId)?.duty || '';
      const a = actualOf(s.id);
      return `<div class="row">
        <div class="row-main">
          <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} <span class="badge warn">${esc(duty.toUpperCase())}</span></div>
          <div class="sub">${esc(s.flight)} · ${zdate(s.std)}${a?.off_blocks ? ` · off ${zulu(a.off_blocks)}` : ''}${
            a?.on_blocks ? ` · on ${zulu(a.on_blocks)}` : ''
          }${a?.fuel_used != null ? ` · ${Number(a.fuel_used).toLocaleString('en-AU')} fuel used` : ''}</div>
        </div>
        <div class="right"><div class="row-t">${span(blockMs(s))}</div><div class="sub">${nm(legNm(s))} NM</div></div>
      </div>`;
    })
    .join('');
  const totalMs = legs.reduce((sum, s) => sum + blockMs(s), 0);
  return `
    <section class="card list">
      <div class="card-head"><div class="tiny">MY SECTORS</div>
        <span class="badge info">${legs.length} · ${hours(totalMs)} H</span></div>
      ${rows}
    </section>`;
}

export function render() {
  const now = Date.now();
  const t = tally(now);
  if (!t.sectors.length) {
    return `<div class="page-head"><h1>Logbook</h1></div>
      <section class="card"><p class="note">No sectors in the schedule yet.</p></section>`;
  }
  return `
    <div class="page-head"><h1>Logbook</h1></div>
    ${headline(t, now)}
    ${mine(now)}
    ${logbook(now)}
    <p class="tiny center">A sector counts as flown once on blocks is stamped on the flight deck, or once its arrival time has passed.</p>`;
}

export function mounted() {
  if (!worldReady()) loadWorld().then(() => onProgress() && rerender());
}
