// Sector schedule: list, and an add/edit form (times in UTC).

import { state, save, uid, loadOfficialSchedule } from '../store.js';
import { esc, zulu, zdate, span, depWindow, isoDate, isoTime, icao, icon, rerender } from '../ui.js';
import { sortedSectors, currentSector, isMine, crewNames, simbriefPlanUrl } from '../ops.js';

function list() {
  const now = Date.now();
  const cur = currentSector(now);
  const sectors = sortedSectors();
  let day = '';
  const rows = sectors
    .map((s) => {
      const d = zdate(s.std);
      const header = d !== day ? `<div class="list-day">${(day = d)}</div>` : '';
      const status =
        s === cur
          ? '<span class="badge ok">ACTIVE</span>'
          : new Date(s.sta) < now
            ? '<span class="badge mute">DONE</span>'
            : isMine(s)
              ? '<span class="badge warn">YOU</span>'
              : '';
      return `${header}
        <a class="row ${new Date(s.sta) < now && s !== cur ? 'past' : ''}" href="#/schedule/${esc(s.id)}">
          <div class="row-main">
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} ${status}</div>
            <div class="sub">${esc(s.flight)} · ${esc(s.crew.join(', ') || 'Crew not assigned')}</div>
          </div>
          <div class="right">
            <div class="row-t">${zulu(s.std)}</div>
            <div class="sub">${s.window ? `${depWindow(s)} · ` : `${zulu(s.sta)} · `}${span(new Date(s.sta) - new Date(s.std))}</div>
          </div>
        </a>`;
    })
    .join('');

  return `
    <div class="page-head"><h1>Schedule</h1>
      <a class="btn primary" href="#/schedule/new">${icon('plus')} Add sector</a></div>
    <section class="card list">${rows || '<p class="note">No sectors yet. Add your first one.</p>'}</section>
    <p class="tiny center">All times UTC. WorldFlight sectors show the middle of the departure window, then the window and block time.</p>
    <div class="btn-row"><button class="btn ghost" data-act="official">Reload official WorldFlight schedule</button></div>`;
}

function form(id) {
  const existing = state.sectors.find((s) => s.id === id);
  if (id !== 'new' && !existing) return `<p class="note">Sector not found.</p><a class="btn ghost" href="#/schedule">Back</a>`;
  const last = sortedSectors().at(-1);
  // A new sector defaults to continuing on from the last one.
  const std = existing?.std || (last ? new Date(new Date(last.sta).getTime() + state.profile.turnaround * 60000) : new Date());
  const sta = existing?.sta || new Date(new Date(std).getTime() + 2 * 3600000);
  const s = existing || { flight: state.profile.callsign, dep: last?.arr || '', arr: '', crew: [], notes: '' };

  return `
    <div class="page-head"><a class="back" href="#/schedule">${icon('back')} Schedule</a></div>
    <form class="card form" data-form="sector">
      <h2>${existing ? `${esc(s.dep)} → ${esc(s.arr)}` : 'New sector'}</h2>
      ${existing?.window ? `<p class="note">Official departure window <strong>${depWindow(s)}</strong>. The time below is the middle of it.</p>` : ''}
      <div class="grid2">
        <label class="field">Departure (ICAO)<input name="dep" required maxlength="4" autocapitalize="characters" value="${esc(s.dep)}" placeholder="YSSY"></label>
        <label class="field">Arrival (ICAO)<input name="arr" required maxlength="4" autocapitalize="characters" value="${esc(s.arr)}" placeholder="YBBN"></label>
      </div>
      <label class="field">Flight number / callsign<input name="flight" required value="${esc(s.flight)}"></label>
      <div class="grid2">
        <label class="field">Departure date (UTC)<input type="date" name="stdDate" required value="${isoDate(std)}"></label>
        <label class="field">Departure time (UTC)<input type="time" name="stdTime" required value="${isoTime(std)}"></label>
        <label class="field">Arrival date (UTC)<input type="date" name="staDate" required value="${isoDate(sta)}"></label>
        <label class="field">Arrival time (UTC)<input type="time" name="staTime" required value="${isoTime(sta)}"></label>
      </div>
      <label class="field">Crew (comma separated)<input name="crew" list="crew-names" value="${esc(s.crew.join(', '))}" placeholder="Corey, Sam"></label>
      <datalist id="crew-names">${crewNames().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label class="field">Route<textarea name="route" rows="2" autocapitalize="characters" placeholder="Optional. Sent to SimBrief when you plan the sector.">${esc(s.route || '')}</textarea></label>
      <label class="field">Handover / sector notes<textarea name="notes" rows="3" placeholder="Anything the next crew should know">${esc(s.notes)}</textarea></label>
      <p class="form-error" hidden></p>
      <div class="btn-row">
        <button class="btn primary" type="submit">Save sector</button>
        ${existing ? '<button class="btn danger" type="button" data-act="remove">Delete</button>' : ''}
      </div>
    </form>
    ${
      existing
        ? `<section class="card">
            <h2>Prepare this sector</h2>
            <div class="btn-col">
              <a class="btn ghost" href="${esc(simbriefPlanUrl(s))}" target="_blank" rel="noopener">Plan in SimBrief ${icon('external')}</a>
              <a class="btn ghost" href="#/airports/${esc(s.dep)}">${esc(s.dep)} departure briefing</a>
              <a class="btn ghost" href="#/airports/${esc(s.arr)}">${esc(s.arr)} arrival briefing</a>
            </div>
          </section>`
        : ''
    }`;
}

export function render(args) {
  return args[0] ? form(args[0]) : list();
}

const currentId = () => decodeURIComponent(location.hash.split('/')[2] || '');

export const forms = {
  sector(data, formEl) {
    const std = new Date(`${data.get('stdDate')}T${data.get('stdTime')}:00Z`);
    const sta = new Date(`${data.get('staDate')}T${data.get('staTime')}:00Z`);
    const dep = icao(data.get('dep'));
    const arr = icao(data.get('arr'));
    const error = formEl.querySelector('.form-error');
    const problem =
      dep.length !== 4 || arr.length !== 4
        ? 'Airports need 4-letter ICAO codes, e.g. YSSY.'
        : isNaN(std) || isNaN(sta)
          ? 'Enter both departure and arrival date and time.'
          : sta <= std
            ? 'Arrival must be after departure.'
            : '';
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
    const id = currentId();
    const sector = state.sectors.find((s) => s.id === id) || { id: uid() };
    Object.assign(sector, {
      dep,
      arr,
      flight: String(data.get('flight')).trim().toUpperCase(),
      std: std.toISOString(),
      sta: sta.toISOString(),
      crew: String(data.get('crew'))
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      route: String(data.get('route')).trim().toUpperCase(),
      notes: String(data.get('notes')).trim(),
    });
    if (!state.sectors.includes(sector)) state.sectors.push(sector);
    save();
    location.hash = '#/schedule';
  },
};

export const actions = {
  remove() {
    if (!confirm('Delete this sector?')) return;
    state.sectors = state.sectors.filter((s) => s.id !== currentId());
    save();
    location.hash = '#/schedule';
  },
  official() {
    if (!confirm('Reload the official WorldFlight schedule? Times and routes are reset to the published ones. Crew, notes and any sectors you added are kept.')) return;
    loadOfficialSchedule();
    rerender();
  },
};
