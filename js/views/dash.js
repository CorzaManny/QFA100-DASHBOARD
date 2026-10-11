// Dashboard: current flight status, your next sector, aircraft status.

import { state } from '../store.js';
import { esc, zulu, zdate, span, ago, depWindow, simLocal, icon, rerender } from '../ui.js';
import {
  currentSector,
  nextSector,
  upcomingSector,
  turnaroundRisk,
  refreshTrack,
  airport,
  isMine,
  myDuty,
  crewLabel,
  isAdmin,
  canEdit,
  isDraft,
  pendingPeople,
} from '../ops.js';
import { nextIncomplete } from './checklists.js';

// The simulator API is cheap to read; the VATSIM feed is large, so poll it less.
const pollMs = () => (state.profile.statusUrl.trim() ? 15000 : 60000);
let busy = false;
let lastPoll = 0;

const onDashboard = () => !location.hash || location.hash.startsWith('#/dashboard');

export async function poll(force = false) {
  if (busy || (!force && Date.now() - lastPoll < pollMs() - 5000)) return;
  busy = true;
  lastPoll = Date.now();
  if (force) rerender();
  await refreshTrack();
  busy = false;
  if (onDashboard()) rerender();
}

const knots = (gs) => (gs == null ? '—' : `${Math.round(gs)} KT`);
const level = (alt) => (alt == null ? '—' : alt >= 10000 ? `FL${Math.round(alt / 100)}` : `${Math.round(alt / 10) * 10} FT`);
const city = (code) => esc(airport(code)?.city || airport(code)?.name || '');

export function countdown(iso, now = Date.now(), verb = 'Departs') {
  const d = new Date(iso) - now;
  if (d >= 0) return `${verb} in ${span(d)}`;
  return verb === 'Report' ? `Report time was ${span(d)} ago` : `Scheduled ${span(d)} ago`;
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
  const sim = t?.source === 'SIM';
  const usingApi = !!state.profile.statusUrl.trim();
  const head = (badge) => `
    <div class="card-head">
      <div class="tiny">CURRENT FLIGHT STATUS · ${esc(t?.callsign || state.profile.callsign)}</div>
      <div class="head-right">${badge}
        <button class="icon-btn ${busy ? 'spin' : ''}" data-act="refresh" aria-label="Refresh flight status">${icon('refresh')}</button>
      </div>
    </div>`;
  // Shown when the simulator API is configured but VATSIM had to stand in for it.
  const fallback = t?.simError
    ? `<p class="note warn">${icon('alert')} Simulator API problem (${esc(t.simError)}). Showing VATSIM instead.</p>`
    : '';

  if (t?.online) {
    const pct = t.total ? Math.max(0, Math.min(100, Math.round((1 - t.remaining / t.total) * 100))) : null;
    const cur = currentSector(now);
    const extra = [
      t.hdg != null ? metric('HEADING', `${String(Math.round(t.hdg) % 360).padStart(3, '0')}°`) : '',
      t.vs != null ? metric('VERTICAL SPEED', `${t.vs > 0 ? '+' : ''}${Math.round(t.vs / 50) * 50} FPM`) : '',
      t.ias != null ? metric('AIRSPEED', `${Math.round(t.ias)} KT${t.mach ? ` · M${t.mach.toFixed(2).replace(/^0/, '')}` : ''}`) : '',
      t.fuelKg != null ? metric('FUEL ON BOARD', `${Math.round(t.fuelKg).toLocaleString('en-AU')} KG`) : '',
    ].join('');
    const etaNote = !t.eta
      ? 'No ETA yet'
      : sim && !t.etaEstimated
        ? 'ETA from the simulator'
        : 'ETA is a straight-line estimate from ground speed';
    return `
      <section class="card">
        ${head(`<span class="badge ok">${sim ? 'SIMULATOR LIVE' : 'VATSIM ONLINE'}</span>`)}
        <div class="chips"><span class="badge info">${esc(t.phase)}</span>${
          t.flight ? `<span class="badge mute">${esc(t.flight)}</span>` : ''
        }${cur && isMine(cur) ? '<span class="badge warn">YOUR SECTOR</span>' : ''}</div>
        ${routeRow(t.dep, t.arr, pct)}
        <div class="metrics">
          ${metric('ALTITUDE', level(t.alt))}
          ${metric('GROUND SPEED', knots(t.gs))}
          ${metric('EST. ARRIVAL', t.eta ? zulu(t.eta) : '—')}
          ${metric('TO GO', t.remaining != null ? `${Math.round(t.remaining)} NM` : '—')}
          ${extra}
        </div>
        ${fallback}
        <div class="tiny">Updated ${ago(t.at)} · ${etaNote}${t.pilotName ? ` · Flown by ${esc(t.pilotName)}` : ''}</div>
      </section>`;
  }

  if (t?.at) {
    const why = sim
      ? t.at > now
        ? 'The simulator report is dated in the future, so it cannot be trusted as live.'
        : `The simulator has not reported since ${zdate(t.at)} ${zulu(t.at)} (${ago(t.at)}).`
      : `${cs} is no longer on VATSIM. Last seen ${ago(t.at)}.`;
    return `
      <section class="card">
        ${head(`<span class="badge warn">POSITION STALE</span>`)}
        ${routeRow(t.dep, t.arr, null)}
        <p class="note warn">${icon('alert')} ${why} Last position ${level(t.alt)}, ${knots(t.gs)}${
          t.remaining != null ? `, ${Math.round(t.remaining)} NM from ${esc(t.arr)}` : ''
        }. This may be a disconnect, not a landing.</p>
        ${fallback}
      </section>`;
  }

  const msg = !t
    ? 'Checking for the aircraft…'
    : t.error
      ? esc(t.error)
      : t.prefiled
        ? `${cs} has a flight plan prefiled but is not connected yet.`
        : `${cs} is not connected to VATSIM right now.`;
  return `
    <section class="card">
      ${head(`<span class="badge mute">${!t ? 'CHECKING' : t.error ? 'NO DATA' : 'OFFLINE'}</span>`)}
      <p class="note">${msg}</p>
      ${fallback}
      <div class="tiny">${
        usingApi ? 'Reading the simulator status API, with VATSIM as backup.' : `Tracking callsign ${cs} on VATSIM.`
      } Change this in <a href="#/settings">Settings</a>.</div>
    </section>`;
}

function sectorCard(now) {
  const mine = nextSector(now, true);
  const s = mine || nextSector(now);
  if (!s) {
    return `<section class="card"><div class="card-head"><h2>Next sector</h2></div>
      <p class="note">No upcoming sectors in the schedule.</p>
      <a class="btn ghost" href="#/schedule">Open schedule</a></section>`;
  }
  const duty = mine ? myDuty(mine) : null;
  const risk = turnaroundRisk(now);
  const atRisk = risk && risk.sector === s;
  return `
    <section class="card">
      <div class="card-head">
        <h2>${mine ? 'Your next rostered sector' : 'Next sector'}</h2>
        ${atRisk ? '<span class="badge bad">DELAY LIKELY</span>' : `<span class="badge info">${zdate(s.std)}</span>`}
      </div>
      <a class="sector-link" href="#/schedule/${esc(s.id)}">
        <div>
          <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
          <div class="sub">${esc(s.flight)} · ${esc(crewLabel(s))}</div>
        </div>
        <div class="right">
          <div class="big">${zulu(s.std)}</div>
          <div class="sub" data-until="${esc(s.std)}">${countdown(s.std, now)}</div>
        </div>
      </a>
      ${
        duty
          ? `<div class="report">
              <span class="badge warn">${esc(duty.duty.toUpperCase())}</span>
              <span><strong>Report ${zdate(duty.report_at)} ${zulu(duty.report_at)} · ${simLocal(duty.report_at)}</strong>
                <span class="sub" data-until="${esc(duty.report_at)}" data-verb="Report">${countdown(duty.report_at, now, 'Report')}</span></span>
            </div>${duty.notes ? `<p class="note"><strong>Roster note:</strong> ${esc(duty.notes)}</p>` : ''}`
          : ''
      }
      ${
        atRisk
          ? `<p class="note warn">${icon('alert')} Aircraft ETA ${zulu(state.track.eta)} plus a ${state.profile.turnaround} min turnaround puts departure at about ${zulu(risk.earliest)}, ${span(risk.late)} late.</p>`
          : ''
      }
      <div class="tiny">${s.window ? `DEPARTURE WINDOW ${depWindow(s)} · ` : ''}SIM LOCAL ${simLocal(s.std)}</div>
      ${s.notes ? `<p class="note"><strong>Handover notes:</strong> ${esc(s.notes)}</p>` : ''}
      ${
        mine
          ? ''
          : state.preview
            ? '<div class="tiny">Accounts are not set up yet, so this is the team\'s next sector.</div>'
            : isDraft() && !canEdit()
              ? '<div class="tiny">The roster is still a draft. <a href="#/availability">Set your availability</a> so you can be rostered.</div>'
              : '<div class="tiny">You are not rostered on an upcoming sector, so this is the team\'s next one. See the <a href="#/roster">Roster</a>.</div>'
      }
    </section>`;
}

function approvalBanner() {
  const waiting = isAdmin() ? pendingPeople().length : 0;
  if (!waiting) return '';
  return `<a class="banner info" href="#/admin/people">${icon('alert')}
    <span><strong>${waiting} account${waiting === 1 ? '' : 's'}</strong> waiting for your approval</span>${icon('chevron')}</a>`;
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
  const next = upcomingSector(now);
  const resume = nextIncomplete();
  const open = state.defects.filter((d) => d.status !== 'RECTIFIED').length;
  const o = state.ofp;
  return `
    ${approvalBanner()}
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
