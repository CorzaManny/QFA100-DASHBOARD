// Sector schedule: the flying programme. Who flies each sector lives in the Roster.
// Sectors are stored in the team database. Everyone reads it the same way;
// admins and dispatchers change it from edit mode.

import { state } from '../store.js';
import { saveSector, deleteSector, clearActuals } from '../api.js';
import { esc, zulu, zdate, span, ago, depWindow, simLocal, isoDate, isoTime, icao, icon, rerender } from '../ui.js';
import { sortedSectors, currentSector, isMine, canEdit, crewLabel, simbriefPlanUrl, delayOf, syncTeam, scheduleDrift, officialCheck, watchingSchedule, running, canLog, actualOf, rules } from '../ops.js';
import { round5 } from '../running.js';
import { saveActual } from '../api.js';

let applying = '';
let applyError = '';

// What WorldFlight has changed since the team's schedule was set. The app
// checks on its own; applying it is still a decision someone makes.
// Where the official schedule came from and when it was last read.
function checkedLine() {
  const check = officialCheck();
  if (!check) {
    return watchingSchedule()
      ? ''
      : 'Compared with the copy the app was built with. To check the WorldFlight site itself every six hours, run supabase/worldflight.sql.';
  }
  if (!check.ok) {
    return `The last check of the WorldFlight site failed ${ago(new Date(check.checked_at))}: ${check.note || 'no reason given'}. The schedule below is the one it read before that.`;
  }
  return `Read from the WorldFlight site ${ago(new Date(check.checked_at))}. It is checked again every six hours.`;
}

function officialChanges() {
  if (!canEdit() || !state.sectors.length) return '';
  const { added, changed, extra, total } = scheduleDrift();
  const when = (t) => `${zdate(t)} ${zulu(t)}`;
  const line = (f) => `${f.what}: ${f.time ? `${when(f.was)} → ${when(f.now)}` : `${esc(f.was)} → ${esc(f.now)}`}`;
  if (!total) {
    return `<p class="tiny center">${icon('check')} The team's schedule matches the official WorldFlight one${
      extra.length ? `, apart from ${extra.length} sector${extra.length === 1 ? '' : 's'} of your own (${extra.map((s) => esc(s.flight)).join(', ')})` : ''
    }. ${esc(checkedLine())}</p>`;
  }
  const all = [
    ...changed.map(
      (c) => `
      <div class="row"><div class="row-main">
        <div class="row-t">${esc(c.official.flight)} · ${esc(c.official.dep)} → ${esc(c.official.arr)}</div>
        ${c.fields.map((f) => `<div class="sub ${f.long ? 'crew-line' : ''}">${line(f)}</div>`).join('')}
      </div></div>`,
    ),
    ...added.map(
      (o) => `
      <div class="row"><div class="row-main">
        <div class="row-t">${esc(o.flight)} · ${esc(o.dep)} → ${esc(o.arr)} <span class="badge info">NEW</span></div>
        <div class="sub">Departs ${when(o.std)} · arrives ${when(o.sta)}</div>
      </div></div>`,
    ),
  ];
  const rows = all.slice(0, 12).join('') + (all.length > 12 ? `<p class="tiny">…and ${all.length - 12} more.</p>` : '');

  return `
    <section class="card list slot-card short">
      <div class="card-head"><div class="tiny">OFFICIAL SCHEDULE HAS CHANGED</div>
        <span class="badge warn">${total} SECTOR${total === 1 ? '' : 'S'}</span></div>
      <p class="note">WorldFlight has published ${changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'}` : ''}${
        changed.length && added.length ? ' and ' : ''
      }${added.length ? `${added.length} new sector${added.length === 1 ? '' : 's'}` : ''} since the team's schedule was set. Applying this keeps every roster entry, note and briefing where it is.</p>
      <p class="tiny">${esc(checkedLine())}</p>
      ${rows}
      ${applyError ? `<p class="note warn">${icon('alert')} ${esc(applyError)}</p>` : ''}
      <div class="btn-row">
        <button class="btn primary" data-act="applyOfficial" ${applying ? 'disabled' : ''}>${
          applying || `Update ${total} sector${total === 1 ? '' : 's'}`
        }</button>
      </div>
      ${
        extra.length
          ? `<p class="tiny">${extra.map((s) => esc(s.flight)).join(', ')} ${extra.length === 1 ? 'is' : 'are'} not in the official schedule. Sectors of your own are never touched or removed.</p>`
          : ''
      }
    </section>`;
}

// A one-line pointer, in view mode, to official changes waiting in edit mode.
function changesHint() {
  if (!canEdit() || !state.sectors.length) return '';
  const { total } = scheduleDrift();
  if (!total) return '';
  return `<a class="banner warn" href="#/schedule/edit">${icon('calendar')}
    <span><strong>WorldFlight schedule changed</strong> · ${total} sector${total === 1 ? '' : 's'} to review</span>${icon('chevron')}</a>`;
}

// Everyone sees the schedule to read it. Admins and dispatchers switch to edit
// mode (#/schedule/edit) to add sectors or take in official changes.
function list(editing) {
  const now = Date.now();
  const cur = currentSector(now);
  const run = running(now);
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
      const row = run.times.get(s.id);
      // The published time always stays on screen; the estimate sits under it.
      const moved = run.trusted && row && Math.abs(row.delay) >= 5 * 60000 && !row.on;
      return `${header}
        <a class="row ${new Date(s.sta) < now && s !== cur ? 'past' : ''}" href="#/schedule/${esc(s.id)}${editing ? '/edit' : ''}">
          <div class="row-main">
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} ${status}${
              row?.off ? ` <span class="badge mute">OFF ${zulu(row.off)}</span>` : ''
            }</div>
            <div class="sub">${esc(s.flight)} · ${simLocal(s.std)}</div>
            <div class="sub">${esc(crewLabel(s))}</div>
          </div>
          <div class="right">
            <div class="row-t ${moved ? 'dim-time' : ''}">${zulu(s.std)}</div>
            ${
              moved
                ? `<div class="row-t ${row.delay > 0 ? 'warn-text' : 'ok-text'}">${zulu(round5(row.estOff))}</div>`
                : `<div class="sub">${s.window ? `${depWindow(s)} · ` : `${zulu(s.sta)} · `}${span(new Date(s.sta) - new Date(s.std))}</div>`
            }
          </div>
        </a>`;
    })
    .join('');

  return `
    <div class="page-head"><h1>${editing ? 'Edit WF Schedule' : 'WF Schedule'}</h1>
      ${
        editing
          ? `<div class="btn-row"><a class="btn ghost" href="#/schedule/new">${icon('plus')} Add sector</a>
              <a class="btn primary" href="#/schedule">Done</a></div>`
          : canEdit()
            ? '<a class="btn ghost" href="#/schedule/edit">Edit</a>'
            : ''
      }</div>
    ${editing ? `${officialChanges()}<p class="tiny center">Tap a sector to change it.</p>` : changesHint()}
    <section class="card list">${rows || '<p class="note">No sectors in the schedule yet.</p>'}</section>
    <p class="tiny center">Times are Zulu, with sim local (Sydney) time under each sector. WorldFlight sectors show when the departure window opens, then the window and block time.${
      run.trusted && run.late ? ' A second time under a departure is what it is really expected to be, worked out from the times stamped on the flight deck.' : ''
    }</p>`;
}

// What actually happened, for correcting a stamp made at the wrong moment or
// entering one nobody made at the time.
function actualsForm(s) {
  const a = actualOf(s.id) || {};
  const row = running().times.get(s.id);
  const field = (name, label, value) => `
    <div class="grid2">
      <label class="field">${label} date (UTC)<input type="date" name="${name}Date" value="${value ? isoDate(value) : ''}"></label>
      <label class="field">${label} time (UTC)<input type="time" name="${name}Time" value="${value ? isoTime(value) : ''}"></label>
    </div>`;
  return `
    <form class="card form" data-form="actuals">
      <div class="card-head"><h2>What actually happened</h2>${
        a.off_blocks && row ? `<span class="badge ${row.delay > 0 ? 'warn' : 'ok'}">${row.delay > 0 ? `${span(row.delay)} LATE` : 'ON TIME'}</span>` : ''
      }</div>
      <p class="note">The flight deck stamps these as they happen; this is for fixing one afterwards. Leave both empty for a sector that has not gone yet. The published times above never change.</p>
      ${field('off', 'Off blocks', a.off_blocks)}
      ${field('on', 'On blocks', a.on_blocks)}
      <label class="check"><input type="checkbox" name="skipped" ${a.skipped ? 'checked' : ''}> This sector was not flown</label>
      <p class="form-error" hidden></p>
      <div class="btn-row"><button class="btn primary" type="submit">Save times</button>
        <a class="btn ghost" href="#/schedule/${esc(s.id)}">Cancel</a></div>
    </form>`;
}

// The off and on block times, to read. Ops staff and the cockpit tablet can
// correct them from here.
function actualsCard(s) {
  const a = actualOf(s.id) || {};
  const row = running().times.get(s.id);
  if (!canLog() && !a.off_blocks && !a.on_blocks && !a.skipped) return '';
  const when = (t) => (t ? `${zdate(t)} ${zulu(t)}` : '—');
  return `
    <section class="card">
      <div class="card-head"><h2>What actually happened</h2>${
        a.skipped
          ? '<span class="badge mute">NOT FLOWN</span>'
          : a.off_blocks && row
            ? `<span class="badge ${row.delay > 0 ? 'warn' : 'ok'}">${row.delay > 0 ? `${span(row.delay)} LATE` : 'ON TIME'}</span>`
            : ''
      }</div>
      <div class="kvs">${kv('Off blocks', when(a.off_blocks))}${kv('On blocks', when(a.on_blocks))}</div>
      ${
        canLog()
          ? `<div class="btn-row"><a class="btn ghost" href="#/schedule/${esc(s.id)}/times">Correct times</a>${
              a.off_blocks || a.on_blocks || a.skipped ? '<button class="btn danger" data-act="clearTimes">Clear times</button>' : ''
            }</div>`
          : ''
      }
    </section>`;
}

const kv = (label, value) => `<div class="kv"><span>${label}</span><strong>${value}</strong></div>`;

// A sector to read: what everyone sees, admins included.
function view(s) {
  return `
    <div class="page-head"><a class="back" href="#/schedule">${icon('back')} WF Schedule</a>
      ${canEdit() ? `<a class="btn ghost" href="#/schedule/${esc(s.id)}/edit">Edit</a>` : ''}</div>
    <section class="card">
      <h2>${esc(s.dep)} → ${esc(s.arr)}</h2>
      <div class="kvs">
        ${kv('Flight', esc(s.flight))}
        ${kv('Departs', `${zdate(s.std)} ${zulu(s.std)}`)}
        ${s.window ? kv('Departure window', depWindow(s)) : ''}
        ${kv('Arrives', `${zdate(s.sta)} ${zulu(s.sta)}`)}
        ${kv('Block time', span(new Date(s.sta) - new Date(s.std)))}
        ${kv('Sim local', esc(simLocal(s.std)))}
      </div>
      ${s.route ? `<h3>Route</h3><p class="mel-text">${esc(s.route)}</p>` : ''}
      ${s.notes ? `<h3>Notes</h3><p class="mel-text">${esc(s.notes)}</p>` : ''}
    </section>
    ${actualsCard(s)}
    <section class="card">
      <h2>Crew</h2>
      <p class="note">${esc(crewLabel(s))}</p>
      <a class="btn ghost" href="#/roster/${esc(s.id)}">Open roster for this sector</a>
    </section>
    <section class="card">
      <h2>Prepare this sector</h2>
      <div class="btn-col">
        <a class="btn primary" href="#/brief/${esc(s.id)}">Open the briefing</a>
        <a class="btn ghost" href="${esc(simbriefPlanUrl(s, delayOf(s.id)?.chosen))}" target="_blank" rel="noopener">Plan in SimBrief ${icon('external')}</a>
        <a class="btn ghost" href="#/airports/${esc(s.dep)}">${esc(s.dep)} departure briefing</a>
        <a class="btn ghost" href="#/airports/${esc(s.arr)}">${esc(s.arr)} arrival briefing</a>
      </div>
    </section>`;
}

function detail(id, mode) {
  const existing = state.sectors.find((s) => s.id === id);
  const admin = canEdit();
  if (!existing && !(id === 'new' && admin)) {
    return `<p class="note">Sector not found.</p><a class="btn ghost" href="#/schedule">Back</a>`;
  }
  if (existing && mode === 'times' && canLog()) {
    return `<div class="page-head"><a class="back" href="#/schedule/${esc(id)}">${icon('back')} ${esc(existing.dep)} → ${esc(existing.arr)}</a></div>
      ${actualsForm(existing)}`;
  }
  if (existing && !(mode === 'edit' && admin)) return view(existing);
  const last = sortedSectors().at(-1);
  // A new sector defaults to continuing on from the last one.
  const std = existing?.std || (last ? new Date(new Date(last.sta).getTime() + rules().turnaroundMinutes * 60000) : new Date());
  const sta = existing?.sta || new Date(new Date(std).getTime() + 2 * 3600000);
  const s = existing || { flight: '', dep: last?.arr || '', arr: '', route: '', notes: '' };

  return `
    <div class="page-head"><a class="back" href="#/schedule/edit">${icon('back')} Edit WF Schedule</a></div>
    <form class="card form" data-form="sector">
      <h2>${existing ? `${esc(s.dep)} → ${esc(s.arr)}` : 'New sector'}</h2>
      ${existing?.window ? `<p class="note">Official departure window <strong>${depWindow(s)}</strong>. The time below is when it opens.</p>` : ''}
      <fieldset>
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
        <label class="field">Sector notes<textarea name="notes" rows="3" placeholder="Shown on the Dashboard and the sector's briefing">${esc(s.notes)}</textarea></label>
      </fieldset>
      <p class="form-error" hidden></p>
      <div class="btn-row">
        <button class="btn primary" type="submit">Save sector</button>
        <a class="btn ghost" href="${existing ? `#/schedule/${esc(s.id)}` : '#/schedule/edit'}">Cancel</a>
        ${existing ? '<button class="btn danger" type="button" data-act="remove">Delete</button>' : ''}
      </div>
    </form>`;
}

export function render(args) {
  if (!args[0]) return list(false);
  if (args[0] === 'edit') return canEdit() ? list(true) : list(false);
  return detail(args[0], args[1]);
}

const currentId = () => decodeURIComponent(location.hash.split('/')[2] || '');

function fail(formEl, text) {
  const error = formEl.querySelector('.form-error');
  error.textContent = text;
  error.hidden = false;
}

export const forms = {
  async actuals(data, formEl) {
    const at = (name) => {
      const date = data.get(`${name}Date`);
      const time = data.get(`${name}Time`);
      if (!date || !time) return null;
      const t = new Date(`${date}T${time}:00Z`);
      return isNaN(t) ? null : t.toISOString();
    };
    const button = formEl.querySelector('[type=submit]');
    button.disabled = true;
    try {
      await saveActual(currentId(), {
        off_blocks: at('off'),
        on_blocks: at('on'),
        skipped: data.get('skipped') === 'on',
      });
      await syncTeam();
      location.hash = `#/schedule/${currentId()}`;
    } catch (err) {
      button.disabled = false;
      fail(formEl, `Could not save: ${err.message}`);
    }
  },

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
      location.hash = id === 'new' ? '#/schedule/edit' : `#/schedule/${id}`;
    } catch (err) {
      button.disabled = false;
      fail(formEl, `Could not save: ${err.message}`);
    }
  },
};

export const actions = {
  async clearTimes(el) {
    if (!confirm('Clear the off and on block times for this sector? It goes back to the published times.')) return;
    el.disabled = true;
    try {
      await clearActuals(currentId());
      await syncTeam();
    } catch (err) {
      alert(`Could not clear the times: ${err.message}`);
    }
    rerender();
  },
  // Bring the team's schedule in line with the official one, sector by sector.
  async applyOfficial() {
    const { added, changed, total } = scheduleDrift();
    if (!total || applying) return;
    if (!confirm(`Update ${total} sector${total === 1 ? '' : 's'} to match the official WorldFlight schedule? Rosters and notes are kept.`)) return;
    applying = 'Updating…';
    applyError = '';
    rerender();
    const fields = (o) => ({
      flight: o.flight,
      dep: o.dep,
      arr: o.arr,
      std: o.std,
      sta: o.sta,
      dep_window_min: o.window || null,
      route: o.route || '',
    });
    try {
      for (const c of changed) await saveSector(fields(c.official), c.sector.id);
      for (const o of added) await saveSector(fields(o), null);
      await syncTeam();
    } catch (err) {
      applyError = `Could not update: ${err.message}`;
    }
    applying = '';
    rerender();
  },
  async remove(el) {
    if (!confirm('Delete this sector? Its roster entries are deleted too.')) return;
    try {
      await deleteSector(currentId());
      await syncTeam();
      location.hash = '#/schedule/edit';
    } catch (err) {
      fail(el.closest('form'), `Could not delete: ${err.message}`);
    }
  },
};
