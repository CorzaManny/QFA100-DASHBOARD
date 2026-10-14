// Dashboard: current flight status, your next sector, aircraft status.

import { state } from '../store.js';
import { esc, zulu, zdate, span, ago, depWindow, simLocal, icon, rerender } from '../ui.js';
import { round5 } from '../running.js';
import { saveActual } from '../api.js';
import {
  briefingOf,
  currentSector,
  nextSector,
  upcomingSector,
  running,
  reportAt,
  canLog,
  syncTeam,
  refreshTrack,
  airport,
  isMine,
  myDuty,
  crewLabel,
  crewOf,
  person,
  isAdmin,
  canEdit,
  scheduleDrift,
  isDraft,
  isEfb,
  me,
  teamCallsign,
  pendingPeople,
  pendingPickups,
  claimedSwaps,
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
  const cs = esc(teamCallsign());
  const sim = t?.source === 'SIM';
  const usingApi = !!state.profile.statusUrl.trim();
  const head = (badge) => `
    <div class="card-head">
      <div class="tiny">CURRENT FLIGHT STATUS · ${esc(t?.callsign || teamCallsign())}</div>
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

function sectorCard(now, run) {
  const mine = nextSector(now, true);
  const s = mine || nextSector(now);
  if (!s) {
    return `<section class="card"><div class="card-head"><h2>Next sector</h2></div>
      <p class="note">No upcoming sectors in the schedule.</p>
      <a class="btn ghost" href="#/schedule">Open schedule</a></section>`;
  }
  const duty = mine ? myDuty(mine) : null;
  const row = run.times.get(s.id);
  const moved = run.trusted && row && Math.abs(row.delay) >= 5 * 60000 && !row.on;
  const report = duty && moved ? reportAt(duty, row) : duty?.report_at;
  return `
    <section class="card">
      <div class="card-head">
        <h2>${mine ? 'Your next rostered sector' : 'Next sector'}</h2>
        ${moved && row.delay > 0 ? `<span class="badge warn">${span(row.delay)} LATE</span>` : `<span class="badge info">${zdate(s.std)}</span>`}
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
              <span><strong>Report ${zdate(report)} ${zulu(report)} · ${simLocal(report)}</strong>
                <span class="sub" data-until="${esc(new Date(report).toISOString())}" data-verb="Report">${countdown(report, now, 'Report')}</span>
                ${moved ? `<span class="sub">Moved by the delay. Published report time ${zulu(duty.report_at)}.</span>` : ''}</span>
            </div>${duty.notes ? `<p class="note"><strong>Roster note:</strong> ${esc(duty.notes)}</p>` : ''}`
          : ''
      }
      ${
        moved
          ? `<p class="note warn">${icon('alert')} Expect to go about <strong>${zulu(round5(row.estOff))}</strong>, ${lateWords(row.delay)}${
              row.basis === 'live' ? ', from the live aircraft position' : ''
            }.</p>`
          : ''
      }
      <div class="tiny">${s.window ? `DEPARTURE WINDOW ${depWindow(s)} · ` : ''}SIM LOCAL ${simLocal(s.std)}</div>
      ${s.notes ? `<p class="note"><strong>Sector notes:</strong> ${esc(s.notes)}</p>` : ''}
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

// "35 minutes behind" is only worth printing when somebody stamped a time or
// the aeroplane is being tracked; see js/running.js.
const lateWords = (ms) =>
  `${span(Math.abs(ms))} ${ms < 0 ? 'ahead of' : 'behind'} the published schedule`;

function runningBanner(run) {
  if (!run.late) return '';
  const r = run.late;
  return `<a class="banner ${r.delay > 0 ? 'warn' : 'info'}" href="#/schedule">${icon('refresh')}
    <span><strong>Running ${lateWords(r.delay)}</strong> · ${esc(r.sector.flight)} ${
      r.state === 'airborne' ? `lands about ${zulu(round5(r.estOn))}` : `now about ${zulu(round5(r.estOff))}`
    }</span>${icon('chevron')}</a>`;
}

// The stamp box being corrected, as "<sector id>|<field>".
let picking = '';

// Off blocks and on blocks: two boxes. Tap an empty one and it records the
// time now. Tap a filled one to correct it or clear it.
function stamps(row) {
  if (!canLog() || !row) return '';
  const s = row.sector;
  const box = (field, label, t, ready) => {
    const key = `${s.id}|${field}`;
    if (picking === key) return timePicker(s, field, label, t);
    if (t) {
      return `
        <button class="stamp-box done" data-act="pick" data-key="${esc(key)}">
          <span class="tiny">${label}</span>
          <strong>${zulu(t)}</strong>
          <span class="tiny">Tap to change</span>
        </button>`;
    }
    return `
      <button class="stamp-box" data-act="stamp" data-sector="${esc(s.id)}" data-field="${field}" ${ready ? '' : 'disabled'}>
        <span class="tiny">${label}</span>
        <strong>—</strong>
        <span class="tiny">${ready ? 'Tap to stamp now' : 'After off blocks'}</span>
      </button>`;
  };
  return `
    <div class="tiny">${esc(s.flight)} ${esc(s.dep)} → ${esc(s.arr)}</div>
    <div class="stamps">
      ${box('off_blocks', 'Off blocks', row.off, true)}
      ${box('on_blocks', 'On blocks', row.on, !!row.off)}
    </div>
    ${row.off && row.delay ? `<div class="tiny ${row.delay > 0 ? 'warn-text' : 'ok-text'}">${lateWords(row.delay)}</div>` : ''}`;
}

// Correcting a stamped time: four digits in Zulu, e.g. 1435.
function timePicker(sector, field, label, at) {
  return `
    <form class="stamp-box editing" data-form="pickTime">
      <input type="hidden" name="sector" value="${esc(sector.id)}">
      <input type="hidden" name="field" value="${field}">
      <input type="hidden" name="near" value="${new Date(at).getTime()}">
      <label class="tiny" for="stamp-${field}">${label} (Zulu)</label>
      <input id="stamp-${field}" name="time" inputmode="numeric" autocomplete="off" maxlength="5" required value="${zulu(at).replace(/\D/g, '')}">
      <div class="btn-row">
        <button class="btn primary small" type="submit">Save</button>
        <button class="btn ghost small" type="button" data-act="pick" data-key="">Cancel</button>
        <button class="btn danger small" type="button" data-act="unstamp" data-sector="${esc(sector.id)}" data-field="${field}">Clear</button>
      </div>
    </form>`;
}

function crewRow(s, now, label, run) {
  const crew = crewOf(s);
  const row = run?.times.get(s.id);
  const moved = run?.trusted && row && Math.abs(row.delay) >= 5 * 60000 && !row.on;
  return `
    <section class="card">
      <div class="card-head"><h2>${label}</h2><span class="badge info">${zdate(s.std)}</span></div>
      <a class="sector-link" href="#/schedule/${esc(s.id)}">
        <div>
          <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
          <div class="sub">${esc(s.flight)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
        </div>
        <div class="right">
          <div class="big">${zulu(s.std)}</div>
          <div class="sub" data-until="${esc(s.std)}">${countdown(s.std, now)}</div>
        </div>
      </a>
      ${moved ? `<p class="note warn">${icon('alert')} Expect to go about <strong>${zulu(round5(row.estOff))}</strong>, ${lateWords(row.delay)}.</p>` : ''}
      <div class="list">
        ${
          crew.length
            ? crew
                .map(
                  (r) => `
            <div class="row">
              <div class="row-main">
                <div class="row-t">${esc(person(r.user_id)?.display_name || 'Unknown')}</div>
                <div class="sub">${esc(r.duty)}${r.notes ? ` · ${esc(r.notes)}` : ''}</div>
              </div>
              <div class="right"><div class="sub">report ${zulu(moved ? reportAt(r, row) : r.report_at)}${
                moved ? ' *' : ''
              }</div></div>
            </div>`,
                )
                .join('')
            : '<p class="note">Nobody rostered on this sector yet.</p>'
        }
      </div>
      <div class="tiny">${moved && crew.length ? 'REPORT TIMES MARKED * ARE MOVED BY THE DELAY · ' : ''}SIM LOCAL ${simLocal(s.std)}${
        s.notes ? ` · ${esc(s.notes)}` : ''
      }</div>
    </section>`;
}

// What a cockpit tablet shows: the aeroplane, who is flying it now, and who
// takes it next. No personal roster, because the tablet is not a person.
function flightDeck(now, run) {
  const cur = currentSector(now);
  const next = nextSector(now);
  const stamping = run.airborne || run.next;
  return `
    ${
      stamping
        ? `<section class="card">
            <div class="card-head"><h2>Times</h2>${
              run.trusted && run.late ? `<span class="badge ${run.late.delay > 0 ? 'warn' : 'info'}">${span(Math.abs(run.late.delay))} ${run.late.delay > 0 ? 'LATE' : 'EARLY'}</span>` : ''
            }</div>
            <p class="note">Tap a box as it happens and it records the time now. Every later report time and departure is worked out from them.</p>
            ${stamps(stamping)}
          </section>`
        : ''
    }
    ${cur ? crewRow(cur, now, 'Flying now', run) : ''}
    ${next ? crewRow(next, now, cur ? 'Next crew' : 'Next sector', run) : ''}
    ${
      !cur && !next
        ? `<section class="card"><h2>Next sector</h2><p class="note">No upcoming sectors in the schedule.</p>
            <a class="btn ghost" href="#/schedule">Open schedule</a></section>`
        : ''
    }`;
}

function approvalBanner() {
  const waiting = isAdmin() ? pendingPeople().length : 0;
  if (!waiting) return '';
  return `<a class="banner info" href="#/admin/people">${icon('alert')}
    <span><strong>${waiting} account${waiting === 1 ? '' : 's'}</strong> waiting for your approval</span>${icon('chevron')}</a>`;
}

// Swaps somebody has taken and empty seats somebody has asked for, waiting
// for an admin or dispatcher to agree.
function requestsBanner() {
  const waiting = canEdit() ? claimedSwaps().length + pendingPickups().length : 0;
  if (!waiting) return '';
  return `<a class="banner info" href="#/admin">${icon('alert')}
    <span><strong>${waiting} roster request${waiting === 1 ? '' : 's'}</strong> waiting for you to agree</span>${icon('chevron')}</a>`;
}

// The official WorldFlight schedule is checked for changes without anyone
// asking; this is where ops staff find out.
function scheduleBanner() {
  if (!canEdit() || !state.sectors.length) return '';
  const { total } = scheduleDrift();
  if (!total) return '';
  return `<a class="banner warn" href="#/schedule/edit">${icon('calendar')}
    <span><strong>WorldFlight schedule changed</strong> · ${total} sector${total === 1 ? '' : 's'} differ from the official one</span>${icon('chevron')}</a>`;
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
  const run = running(now);
  const next = upcomingSector(now);
  const resume = nextIncomplete();
  const open = state.defects.filter((d) => d.status !== 'RECTIFIED').length;
  const o = next ? briefingOf(next.id).ofp : null;
  return `
    ${approvalBanner()}
    ${requestsBanner()}
    ${runningBanner(run)}
    ${scheduleBanner()}
    ${statusBanner()}
    ${liveCard(now)}
    ${isEfb() ? flightDeck(now, run) : sectorCard(now, run)}
    <div class="tiles">
      ${tile('#/checklists', 'checks', '737 Checklists', resume ? `Resume: ${resume.name}` : 'All complete')}
      ${tile('#/airports', 'pin', 'Airport Briefings', next ? `${next.dep} · ${next.arr}` : 'All airports')}
      ${tile('#/techlog', 'wrench', 'Tech Log', open ? `${open} active defect${open > 1 ? 's' : ''}` : 'No active defects')}
      ${tile('#/brief', 'file', 'Sector Briefing', next ? `${next.dep} → ${next.arr} · ${o ? 'OFP imported' : 'no OFP yet'}` : 'OFP, notes, handover')}
    </div>`;
}

export function mounted() {
  poll();
}

export const forms = {
  // A time typed in Zulu (1435 or 14:35), on whichever day the sector is
  // flying. A time more than half a day from the one it replaces has rolled
  // over midnight, so the day moves with it.
  async pickTime(data, formEl) {
    const near = Number(data.get('near'));
    const digits = String(data.get('time')).replace(/\D/g, '').padStart(4, '0');
    const h = Number(digits.slice(0, 2));
    const m = Number(digits.slice(2, 4));
    if (digits.length !== 4 || h > 23 || m > 59) {
      alert('Type the time as four digits in Zulu, e.g. 1435.');
      return;
    }
    const at = new Date(near);
    at.setUTCHours(h, m, 0, 0);
    const drift = at - near;
    if (drift > 12 * 3600000) at.setUTCDate(at.getUTCDate() - 1);
    if (drift < -12 * 3600000) at.setUTCDate(at.getUTCDate() + 1);
    formEl.querySelector('[type=submit]').disabled = true;
    picking = '';
    try {
      await saveActual(data.get('sector'), { [data.get('field')]: at.toISOString(), by_name: me()?.display_name || '' });
      await syncTeam();
    } catch (err) {
      alert(`Could not save that time: ${err.message}`);
    }
    rerender();
  },
};

export const actions = {
  refresh: () => poll(true),

  // Opens or closes the box for correcting a stamped time.
  pick(el) {
    picking = el.dataset.key || '';
    rerender();
  },

  // One tap, one timestamp: the time now. Every later sector follows from it.
  async stamp(el) {
    el.disabled = true;
    picking = '';
    try {
      await saveActual(el.dataset.sector, { [el.dataset.field]: new Date().toISOString(), by_name: me()?.display_name || '' });
      await syncTeam();
    } catch (err) {
      alert(`Could not save that time: ${err.message}`);
    }
    rerender();
  },

  // Clears one stamped time. Clearing off blocks clears on blocks with it.
  async unstamp(el) {
    const off = el.dataset.field === 'off_blocks';
    if (!confirm(off ? 'Clear off blocks (and on blocks)?' : 'Clear on blocks?')) return;
    el.disabled = true;
    picking = '';
    try {
      await saveActual(el.dataset.sector, { ...(off ? { off_blocks: null } : {}), on_blocks: null, by_name: me()?.display_name || '' });
      await syncTeam();
    } catch (err) {
      alert(`Could not clear that time: ${err.message}`);
    }
    rerender();
  },
};
