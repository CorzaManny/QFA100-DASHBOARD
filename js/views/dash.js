// Flight Deck: live aircraft position, your next sector, aircraft status.

import { state } from '../store.js';
import { esc, zulu, zdate, span, ago, depWindow, icon, rerender } from '../ui.js';
import { currentSector, nextSector, turnaroundRisk, refreshTrack, airport, isMine } from '../ops.js';
import { nextIncomplete } from './checklists.js';

const POLL_MS = 60000;
let busy = false;
let lastPoll = 0;

const onDeck = () => !/^#\/(checklists|schedule|techlog|airports|dispatch|settings)/.test(location.hash);

export async function poll(force = false) {
  if (busy || (!force && Date.now() - lastPoll < POLL_MS - 5000)) return;
  busy = true;
  lastPoll = Date.now();
  if (force) rerender();
  await refreshTrack();
  busy = false;
  if (onDeck()) rerender();
}

const level = (alt) => (alt >= 10000 ? `FL${Math.round(alt / 100)}` : `${Math.round(alt / 10) * 10} FT`);
const city = (code) => esc(airport(code)?.city || airport(code)?.name || '');

export function countdown(iso, now = Date.now()) {
  const d = new Date(iso) - now;
  return d >= 0 ? `Departs in ${span(d)}` : `Scheduled ${span(d)} ago`;
}

function routeRow(dep, arr, pct) {
  const bar =
    pct == null
      ? ''
      : `<div class="bar"><div style="width:${pct}%"></div></div><div class="tiny">${pct}% COMPLETE</div>`;
  return `
    <div class="route">
      <div><div class="apt">${esc(dep || '----')}</div><div class="tiny">${city(dep)}</div></div>
      <div class="route-mid">${icon('plane', 'plane')}${bar}</div>
      <div class="right"><div class="apt">${esc(arr || '----')}</div><div class="tiny">${city(arr)}</div></div>
    </div>`;
}

function metric(label, value) {
  return `<div class="metric"><div class="tiny">${label}</div><div class="metric-v">${value}</div></div>`;
}

function liveCard(now) {
  const t = state.track;
  const cs = esc(state.profile.callsign);
  const head = (badge) => `
    <div class="card-head">
      <div class="tiny">AIRCRAFT POSITION · ${cs}</div>
      <div class="head-right">${badge}
        <button class="icon-btn ${busy ? 'spin' : ''}" data-act="refresh" aria-label="Refresh VATSIM data">${icon('refresh')}</button>
      </div>
    </div>`;

  if (t?.online) {
    const pct = t.total ? Math.max(0, Math.min(100, Math.round((1 - t.remaining / t.total) * 100))) : null;
    const cur = currentSector(now);
    return `
      <section class="card">
        ${head(`<span class="badge ok">VATSIM ONLINE</span>`)}
        <div class="chips"><span class="badge info">${esc(t.phase)}</span>${
          cur && isMine(cur) ? '<span class="badge warn">YOUR SECTOR</span>' : ''
        }</div>
        ${routeRow(t.dep, t.arr, pct)}
        <div class="metrics">
          ${metric('ALTITUDE', level(t.alt))}
          ${metric('GROUND SPEED', `${t.gs} KT`)}
          ${metric('EST. ARRIVAL', t.eta ? zulu(t.eta) : '—')}
          ${metric('TO GO', t.remaining != null ? `${Math.round(t.remaining)} NM` : '—')}
        </div>
        <div class="tiny">Updated ${ago(t.at)} · ETA is a straight-line estimate from VATSIM ground speed${
          t.pilotName ? ` · Flown by ${esc(t.pilotName)}` : ''
        }</div>
      </section>`;
  }

  if (t?.at) {
    return `
      <section class="card">
        ${head(`<span class="badge warn">POSITION STALE</span>`)}
        ${routeRow(t.dep, t.arr, null)}
        <p class="note warn">${icon('alert')} ${cs} is no longer on VATSIM. Last seen ${ago(t.at)} at ${level(t.alt)}, ${t.gs} kt${
          t.remaining != null ? `, ${Math.round(t.remaining)} NM from ${esc(t.arr)}` : ''
        }. This may be a disconnect, not a landing.</p>
      </section>`;
  }

  const msg = !t
    ? 'Checking VATSIM…'
    : t.error
      ? esc(t.error)
      : t.prefiled
        ? `${cs} has a flight plan prefiled but is not connected yet.`
        : `${cs} is not connected to VATSIM right now.`;
  return `
    <section class="card">
      ${head(`<span class="badge mute">${!t ? 'CHECKING' : t.error ? 'NO DATA' : 'OFFLINE'}</span>`)}
      <p class="note">${msg}</p>
      <div class="tiny">Tracking callsign ${cs}. Change it in Settings.</div>
    </section>`;
}

function sectorCard(now) {
  const hasName = !!state.profile.name.trim();
  const mine = hasName ? nextSector(now, true) : null;
  const s = mine || nextSector(now);
  if (!s) {
    return `<section class="card"><div class="card-head"><h2>Next sector</h2></div>
      <p class="note">No upcoming sectors in the schedule.</p>
      <a class="btn ghost" href="#/schedule">Open schedule</a></section>`;
  }
  const risk = turnaroundRisk(now);
  const atRisk = risk && risk.sector === s;
  return `
    <section class="card">
      <div class="card-head">
        <h2>${mine ? 'Your next sector' : 'Next sector'}</h2>
        ${atRisk ? '<span class="badge bad">DELAY LIKELY</span>' : `<span class="badge info">${zdate(s.std)}</span>`}
      </div>
      <a class="sector-link" href="#/schedule/${esc(s.id)}">
        <div>
          <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
          <div class="sub">${esc(s.flight)} · ${esc(s.crew.join(', ') || 'Crew not assigned')}</div>
        </div>
        <div class="right">
          <div class="big">${zulu(s.std)}</div>
          <div class="sub" data-until="${esc(s.std)}">${countdown(s.std, now)}</div>
        </div>
      </a>
      ${
        atRisk
          ? `<p class="note warn">${icon('alert')} Aircraft ETA ${zulu(state.track.eta)} plus a ${state.profile.turnaround} min turnaround puts departure at about ${zulu(risk.earliest)}, ${span(risk.late)} late.</p>`
          : ''
      }
      ${s.window ? `<div class="tiny">DEPARTURE WINDOW ${depWindow(s)}</div>` : ''}
      ${s.notes ? `<p class="note"><strong>Handover notes:</strong> ${esc(s.notes)}</p>` : ''}
      ${
        hasName
          ? mine
            ? ''
            : '<div class="tiny">You have no upcoming sectors assigned, so this is the team\'s next one.</div>'
          : '<div class="tiny">Set your name in <a href="#/settings">Settings</a> to see your own sectors here.</div>'
      }
    </section>`;
}

function statusBanner() {
  const open = state.defects.filter((d) => d.status !== 'RECTIFIED');
  if (!open.length) return '';
  const aog = open.some((d) => d.aog);
  const deferred = open.filter((d) => d.status === 'DEFERRED').length;
  const parts = [];
  if (open.length - deferred) parts.push(`${open.length - deferred} open`);
  if (deferred) parts.push(`${deferred} deferred`);
  return `<a class="banner ${aog ? 'bad' : 'warn'}" href="#/techlog">${icon('wrench')}
    <span><strong>${aog ? 'AIRCRAFT UNSERVICEABLE' : 'Tech log'}</strong> · ${parts.join(', ')} defect${open.length > 1 ? 's' : ''}</span>${icon('chevron')}</a>`;
}

function tile(href, ic, title, sub) {
  return `<a class="tile" href="${href}">${icon(ic)}<div class="tile-t">${title}</div><div class="tiny">${esc(sub)}</div></a>`;
}

export function render() {
  const now = Date.now();
  const next = nextSector(now, !!state.profile.name.trim()) || nextSector(now);
  const resume = nextIncomplete();
  const open = state.defects.filter((d) => d.status !== 'RECTIFIED').length;
  const o = state.ofp;
  return `
    ${statusBanner()}
    ${liveCard(now)}
    ${sectorCard(now)}
    <div class="tiles">
      ${tile('#/checklists', 'checks', '737 Checklists', resume ? `Resume: ${resume.name}` : 'All complete')}
      ${tile('#/airports', 'pin', 'Airport Briefings', next ? `${next.dep} · ${next.arr}` : 'All airports')}
      ${tile('#/techlog', 'wrench', 'Tech Log', open ? `${open} active defect${open > 1 ? 's' : ''}` : 'No active defects')}
      ${tile('#/dispatch', 'file', 'SimBrief OFP', o ? `${o.dep} → ${o.arr}` : 'Not imported')}
    </div>`;
}

export function mounted() {
  poll();
}

export const actions = {
  refresh: () => poll(true),
};
