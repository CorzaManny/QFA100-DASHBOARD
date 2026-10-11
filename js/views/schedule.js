// Sector schedule: the flying programme. Who flies each sector lives in the Roster.
// Sectors are stored in the team database; admins and dispatchers can change them.

import { state } from '../store.js';
import { saveSector, deleteSector } from '../api.js';
import { esc, zulu, zdate, span, depWindow, simLocal, isoDate, isoTime, icao, icon } from '../ui.js';
import { sortedSectors, currentSector, isMine, canEdit, crewLabel, simbriefPlanUrl, syncTeam } from '../ops.js';

function list() {
  const now = Date.now();
  const cur = currentSector(now);
  let day = '';
  const rows = sortedSectors()
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
            <div class="sub">${esc(s.flight)} · ${simLocal(s.std)}</div>
            <div class="sub">${esc(crewLabel(s))}</div>
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
      ${canEdit() ? `<a class="btn primary" href="#/schedule/new">${icon('plus')} Add sector</a>` : ''}</div>
    <section class="card list">${rows || '<p class="note">No sectors in the schedule yet.</p>'}</section>
    <p class="tiny center">Times are Zulu, with sim local (Sydney) time under each sector. WorldFlight sectors show when the departure window opens, then the window and block time.</p>`;
}

function detail(id) {
  const existing = state.sectors.find((s) => s.id === id);
  const admin = canEdit();
  if (!existing && !(id === 'new' && admin)) {
    return `<p class="note">Sector not found.</p><a class="btn ghost" href="#/schedule">Back</a>`;
  }
  const last = sortedSectors().at(-1);
  // A new sector defaults to continuing on from the last one.
  const std = existing?.std || (last ? new Date(new Date(last.sta).getTime() + state.profile.turnaround * 60000) : new Date());
  const sta = existing?.sta || new Date(new Date(std).getTime() + 2 * 3600000);
  const s = existing || { flight: '', dep: last?.arr || '', arr: '', route: '', notes: '' };
  const lock = admin ? '' : 'disabled';

  return `
    <div class="page-head"><a class="back" href="#/schedule">${icon('back')} Schedule</a></div>
    <form class="card form" data-form="sector">
      <h2>${existing ? `${esc(s.dep)} → ${esc(s.arr)}` : 'New sector'}</h2>
      ${existing?.window ? `<p class="note">Official departure window <strong>${depWindow(s)}</strong>. The time below is when it opens.</p>` : ''}
      <fieldset ${lock}>
        <div class="grid2">
          <label class="field">Departure (ICAO)<input name="dep" required maxlength="4" autocapitalize="characters" value="${esc(s.dep)}" placeholder="YSSY"></label>
          <label class="field">Arrival (ICAO)<input name="arr" required maxlength="4" autocapitalize="characters" value="${esc(s.arr)}" placeholder="YBBN"></label>
        </div>
        <label class="field">Sector / flight number<input name="flight" required value="${esc(s.flight)}" placeholder="WF2644"></label>
        <div class="grid2">
          <label class="field">Departure date (UTC)<input type="date" name="stdDate" required value="${isoDate(std)}"></label>
          <label class="field">Departure time (UTC)<input type="time" name="stdTime" required value="${isoTime(std)}"></label>
          <label class="field">Arrival date (UTC)<input type="date" name="staDate" required value="${isoDate(sta)}"></label>
          <label class="field">Arrival time (UTC)<input type="time" name="staTime" required value="${isoTime(sta)}"></label>
        </div>
        <label class="field">Route<textarea name="route" rows="2" autocapitalize="characters" placeholder="Optional. Sent to SimBrief when you plan the sector.">${esc(s.route)}</textarea></label>
        <label class="field">Handover / sector notes<textarea name="notes" rows="3" placeholder="Anything the next crew should know">${esc(s.notes)}</textarea></label>
      </fieldset>
      <p class="form-error" hidden></p>
      ${
        admin
          ? `<div class="btn-row">
              <button class="btn primary" type="submit">Save sector</button>
              ${existing ? '<button class="btn danger" type="button" data-act="remove">Delete</button>' : ''}
            </div>`
          : '<p class="tiny">Only admins and dispatchers can change the schedule.</p>'
      }
    </form>
    ${
      existing
        ? `<section class="card">
            <h2>Crew</h2>
            <p class="note">${esc(crewLabel(s))}</p>
            <a class="btn ghost" href="#/roster/${esc(s.id)}">Open roster for this sector</a>
          </section>
          <section class="card">
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
  return args[0] ? detail(args[0]) : list();
}

const currentId = () => decodeURIComponent(location.hash.split('/')[2] || '');

function fail(formEl, text) {
  const error = formEl.querySelector('.form-error');
  error.textContent = text;
  error.hidden = false;
}

export const forms = {
  async sector(data, formEl) {
    const std = new Date(`${data.get('stdDate')}T${data.get('stdTime')}:00Z`);
    const sta = new Date(`${data.get('staDate')}T${data.get('staTime')}:00Z`);
    const dep = icao(data.get('dep'));
    const arr = icao(data.get('arr'));
    const problem =
      dep.length !== 4 || arr.length !== 4
        ? 'Airports need 4-letter ICAO codes, e.g. YSSY.'
        : isNaN(std) || isNaN(sta)
          ? 'Enter both departure and arrival date and time.'
          : sta <= std
            ? 'Arrival must be after departure.'
            : '';
    if (problem) return fail(formEl, problem);

    const id = currentId();
    const button = formEl.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await saveSector(
        {
          dep,
          arr,
          flight: String(data.get('flight')).trim().toUpperCase(),
          std: std.toISOString(),
          sta: sta.toISOString(),
          route: String(data.get('route')).trim().toUpperCase(),
          notes: String(data.get('notes')).trim(),
        },
        id === 'new' ? null : id,
      );
      await syncTeam();
      location.hash = '#/schedule';
    } catch (err) {
      button.disabled = false;
      fail(formEl, `Could not save: ${err.message}`);
    }
  },
};

export const actions = {
  async remove(el) {
    if (!confirm('Delete this sector? Its roster entries are deleted too.')) return;
    try {
      await deleteSector(currentId());
      await syncTeam();
      location.hash = '#/schedule';
    } catch (err) {
      fail(el.closest('form'), `Could not delete: ${err.message}`);
    }
  },
};
