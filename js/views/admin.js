// Admin section: build the roster and manage team roles.
// Admins and dispatchers edit the roster; only admins change roles.

import { state } from '../store.js';
import {
  saveRoster,
  deleteRoster,
  setRole,
  addTestAccount,
  removeTestAccount,
  saveSettings,
  saveRosterMany,
  clearAutoRoster,
} from '../api.js';
import { DEFAULT_RULES, planRoster, problems } from '../autoroster.js';
import { esc, zulu, zdate, depWindow, simLocal, isoDate, isoTime, icon, rerender } from '../ui.js';
import {
  sortedSectors,
  crewOf,
  person,
  me,
  isAdmin,
  canEdit,
  ROLES,
  DUTIES,
  MIN_PILOTS,
  pilotsShort,
  defaultReport,
  rules,
  isDraft,
  prefOf,
  PILOT_DUTIES,
  syncTeam,
  pendingPeople,
} from '../ops.js';

// The two seats every sector is rostered from on the quick editor.
const SEATS = ['Captain', 'First Officer'];

let error = '';
let result = '';
let gapNote = '';
let filter = 'all';

const when = (t) => `${zdate(t)} ${zulu(t)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const name = (id) => esc(person(id)?.display_name || 'Unknown');
const sectorCount = (userId) => state.roster.filter((r) => r.user_id === userId).length;

function tabs(active) {
  const tab = (key, href, label) => `<a class="${active === key ? 'on' : ''}" href="${href}">${label}</a>`;
  const waiting = pendingPeople().length;
  return `
    <div class="page-head"><h1>Admin</h1>
      <span class="badge ${isDraft() ? 'warn' : 'ok'}">ROSTER ${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span></div>
    <nav class="seg on-card tabs4">
      ${tab('roster', '#/admin', 'Roster')}
      ${tab('auto', '#/admin/auto', 'Auto roster')}
      ${tab('rules', '#/admin/rules', 'Rules')}
      ${isAdmin() ? tab('people', '#/admin/people', `People${waiting ? ` (${waiting})` : ''}`) : ''}
    </nav>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${result ? `<p class="note ok">${esc(result)}</p>` : ''}`;
}

// Pilots Auto roster may use, with what they have told us and what they fly.
const flyers = () => state.people.filter((p) => ['admin', 'dispatcher', 'pilot'].includes(p.role));
const flownBy = (userId) => {
  const byId = new Map(state.sectors.map((x) => [x.id, x]));
  return state.roster
    .filter((r) => r.user_id === userId && PILOT_DUTIES.includes(r.duty) && byId.has(r.sector_id))
    .map((r) => byId.get(r.sector_id));
};

function autoPage() {
  const now = Date.now();
  const upcoming = sortedSectors().filter((x) => new Date(x.std) > now);
  const r = rules();
  const pilots = flyers();
  const answered = pilots.filter((p) => upcoming.some((x) => prefOf(p.id, x.id)));
  const autoCount = state.roster.filter((x) => x.auto).length;
  const empty = upcoming.reduce((n, x) => n + SEATS.filter((seat) => !crewOf(x).some((c) => c.duty === seat)).length, 0);

  const responses = pilots
    .map((p) => {
      const n = { prefer: 0, available: 0, unavailable: 0, none: 0 };
      for (const x of upcoming) n[prefOf(p.id, x.id) || 'none'] += 1;
      return `
      <a class="row" href="#/availability/${esc(p.id)}">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}${p.is_test ? ' <span class="badge info">TEST</span>' : ''}</div>
          <div class="sub">${n.prefer} prefer · ${n.available} available · ${n.unavailable} can't · ${n.none} blank</div>
        </div>
        <div class="right">${n.none === upcoming.length ? '<span class="badge warn">NO ANSWER</span>' : ''} ${icon('chevron')}</div>
      </a>`;
    })
    .join('');

  const breaks = pilots
    .map((p) => [p, problems(flownBy(p.id), r)])
    .filter(([, list]) => list.length)
    .map(([p, list]) => `<div class="row"><div class="row-main"><div class="row-t">${esc(p.display_name)}</div>${list.map((t) => `<div class="sub">${esc(t)}</div>`).join('')}</div></div>`)
    .join('');

  return `
    ${tabs('auto')}
    <section class="card">
      <div class="card-head"><h2>Roster state</h2><span class="badge ${isDraft() ? 'warn' : 'ok'}">${isDraft() ? 'DRAFT' : 'PUBLISHED'}</span></div>
      <p class="note">${
        isDraft()
          ? 'The roster is a draft. Pilots cannot see it; they can only fill in their availability. Publish it when it is ready.'
          : 'The roster is published and everyone can see it. Move it back to draft to hide it while you rework it.'
      }</p>
      <button class="btn ${isDraft() ? 'primary' : 'ghost'}" data-act="state" data-state="${isDraft() ? 'published' : 'draft'}">${isDraft() ? 'Publish roster' : 'Move back to draft'}</button>
    </section>
    <section class="card">
      <h2>Auto roster</h2>
      <p class="note"><strong>${empty}</strong> empty Captain and First Officer seats on ${upcoming.length} upcoming sectors. Auto roster fills them from everyone's availability and the rules. Anyone you have already rostered stays exactly where they are.</p>
      <div class="btn-row">
        <button class="btn primary" data-act="auto" ${empty ? '' : 'disabled'}>Auto roster the gaps</button>
        <button class="btn danger" data-act="clearAuto" ${autoCount ? '' : 'disabled'}>Clear ${autoCount} auto-rostered</button>
      </div>
      ${gapNote ? `<p class="note warn">${icon('alert')} ${esc(gapNote)}</p>` : ''}
      <p class="tiny">To pin someone to a sector, roster them on the Roster tab first. Clearing removes only what Auto roster placed.</p>
    </section>
    <section class="card list">
      <div class="card-head"><div class="tiny">AVAILABILITY RECEIVED</div><span class="badge ${answered.length === pilots.length ? 'ok' : 'warn'}">${answered.length} OF ${pilots.length}</span></div>
      ${responses || '<p class="note">No pilots yet.</p>'}
      <p class="tiny">Open someone to see or set their availability for them.</p>
    </section>
    <section class="card list">
      <div class="card-head"><div class="tiny">RULE CHECK</div><span class="badge ${breaks ? 'bad' : 'ok'}">${breaks ? 'BREAKS FOUND' : 'ALL WITHIN RULES'}</span></div>
      ${breaks || '<p class="note">Nobody on the roster breaks a duty rule.</p>'}
    </section>`;
}

function rulesPage() {
  const r = rules();
  const num = (name, label, hint, step = 1) =>
    `<label class="field">${label}<input type="number" name="${name}" min="0" step="${step}" required value="${esc(r[name])}"><span class="tiny">${hint}</span></label>`;
  return `
    ${tabs('rules')}
    <form class="card form" data-form="rules">
      <h2>Duty rules</h2>
      <p class="note">Auto roster follows these, and the rule check flags anyone rostered by hand who breaks them. They apply to the whole team.</p>
      <div class="grid2">
        ${num('restHours', 'Minimum rest (hours)', 'A break this long ends a duty', 0.5)}
        ${num('maxSectorsPerDuty', 'Sectors per duty', 'Before a rest is needed')}
        ${num('maxDutyHours', 'Longest duty (hours)', 'Report to last arrival', 0.5)}
        ${num('maxSectors', 'Sectors per person', 'For the event; 0 = no limit')}
      </div>
      <h3>Back of the clock (sim local time)</h3>
      <div class="grid2">
        ${num('bocStart', 'Starts at hour', '0 to 23')}
        ${num('bocEnd', 'Ends at hour', '0 to 23')}
      </div>
      ${num('maxBoc', 'Back-of-clock sectors per person', 'For the whole event; 0 = no limit. A sector counts if any of it is flown in that window')}
      <h3>Report time</h3>
      <div class="grid2">
        ${num('reportLeadMinutes', 'Minutes before departure', 'Before the window opens', 5)}
        ${num('firstReportLeadMinutes', 'First sector of the event', 'Minutes before departure', 5)}
      </div>
      <label class="check"><input type="checkbox" name="unmarkedAvailable" ${r.unmarkedAvailable ? 'checked' : ''}> Treat sectors a pilot left blank as available</label>
      <div class="btn-row">
        <button class="btn primary" type="submit">Save rules</button>
        <button class="btn ghost" type="button" data-act="resetRules">Back to defaults</button>
      </div>
    </form>`;
}

function needBadge(s) {
  const short = pilotsShort(s);
  return short
    ? `<span class="badge warn">NEEDS ${short} PILOT${short === 1 ? '' : 'S'}</span>`
    : '<span class="badge ok">CREWED</span>';
}

function seat(s, duty) {
  const crew = crewOf(s);
  const holder = crew.find((r) => r.duty === duty);
  const options = state.people
    // Observers and unapproved accounts are not offered a pilot's seat,
    // unless one already holds it.
    .filter((p) => !['observer', 'pending'].includes(p.role) || p.id === holder?.user_id)
    .map(
      (p) =>
        `<option value="${esc(p.id)}" ${p.id === holder?.user_id ? 'selected' : ''}>${esc(p.display_name)} (${sectorCount(p.id)})</option>`,
    )
    .join('');
  return `<label class="field">${duty}
    <select data-change="seat" data-sector="${esc(s.id)}" data-duty="${duty}">
      <option value="">Not assigned</option>${options}
    </select></label>`;
}

function rosterEditor() {
  const now = Date.now();
  const upcoming = sortedSectors().filter((s) => new Date(s.sta) > now);
  const short = upcoming.filter(pilotsShort);
  const shown = filter === 'short' ? short : upcoming;

  const cards = shown
    .map((s) => {
      const others = crewOf(s).filter((r) => !SEATS.includes(r.duty));
      return `
      <section class="card slot-card ${pilotsShort(s) ? 'short' : 'ok'}">
        <div class="card-head">
          <div>
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)}</div>
            <div class="sub">${esc(s.flight)} · ${when(s.std)} · ${simLocal(s.std)}</div>
          </div>
          ${needBadge(s)}
        </div>
        <div class="slots">${seat(s, 'Captain')}${seat(s, 'First Officer')}</div>
        ${others.length ? `<div class="sub">Also: ${others.map((r) => `${name(r.user_id)} (${esc(r.duty)})`).join(', ')}</div>` : ''}
        <a class="tiny" href="#/admin/sector/${esc(s.id)}">Report times, notes, relief pilots and observers</a>
      </section>`;
    })
    .join('');

  return `
    ${tabs('roster')}
    <section class="card">
      <div class="card-head">
        <div class="note"><strong>${short.length}</strong> of ${upcoming.length} upcoming sectors have fewer than ${MIN_PILOTS} pilots.</div>
      </div>
      <div class="seg">
        <button type="button" class="${filter === 'all' ? 'on' : ''}" data-act="filter" data-filter="all">All sectors</button>
        <button type="button" class="${filter === 'short' ? 'on' : ''}" data-act="filter" data-filter="short">Needs pilots (${short.length})</button>
      </div>
      <p class="tiny">Pick a name to roster them; it saves straight away. The number after each name is how many sectors they already have. Report time is set to ${rules().reportLeadMinutes} minutes before the departure window opens (${rules().firstReportLeadMinutes} for the first sector) and can be changed per person.</p>
    </section>
    ${cards || '<p class="note center">Every upcoming sector has its pilots.</p>'}`;
}

function people() {
  if (!isAdmin()) return `${tabs('roster')}<p class="note">Only admins can change roles.</p>`;
  const myId = me()?.id;
  const waiting = pendingPeople()
    .map(
      (p) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}${p.is_test ? ' <span class="badge info">TEST</span>' : ''}</div>
          <div class="sub">Signed up and waiting${p.vatsim_cid ? ` · CID ${esc(p.vatsim_cid)}` : ''}</div>
        </div>
        <button class="btn primary small" data-act="approve" data-id="${esc(p.id)}">Approve</button>
      </div>`,
    )
    .join('');
  const rows = state.people
    .filter((p) => p.role !== 'pending')
    .map(
      (p) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}${p.id === myId ? ' <span class="badge mute">YOU</span>' : ''}${p.is_test ? ' <span class="badge info">TEST</span>' : ''}</div>
          <div class="sub">${plural(sectorCount(p.id), 'sector')} rostered${p.vatsim_cid ? ` · CID ${esc(p.vatsim_cid)}` : ''}</div>
        </div>
        <select class="role-select" data-change="role" data-id="${esc(p.id)}" aria-label="Role for ${esc(p.display_name)}" ${p.id === myId ? 'disabled' : ''}>
          ${Object.entries(ROLES)
            .filter(([key]) => !(p.is_test && key === 'admin'))
            .map(([key, [label]]) => `<option value="${key}" ${p.role === key ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select>
      </div>`,
    )
    .join('');
  return `
    ${tabs('people')}
    ${
      waiting
        ? `<section class="card list slot-card short">
            <div class="card-head"><div class="tiny">WAITING FOR APPROVAL</div><span class="badge warn">${pendingPeople().length}</span></div>
            ${waiting}
            <p class="tiny">Approving makes them a Pilot. Only approve people you recognise; until then they cannot see anything.</p>
          </section>`
        : ''
    }
    <section class="card list">
      <div class="card-head"><div class="tiny">TEAM ACCOUNTS</div><span class="badge mute">${state.people.length - pendingPeople().length}</span></div>
      ${rows}
    </section>
    ${testAccounts()}
    <section class="card">
      <h2>What each role can do</h2>
      <dl class="legend">${Object.values(ROLES)
        .map(([label, what]) => `<dt>${label}</dt><dd>${what}</dd>`)
        .join('')}</dl>
      <p class="tiny">You cannot change your own role, so there is always at least one admin. New accounts wait for approval; set someone back to "Awaiting approval" to remove their access.</p>
    </section>`;
}

function testAccounts() {
  const tests = state.people.filter((p) => p.is_test);
  const rows = tests
    .map(
      (p) => `
      <div class="row">
        <div class="row-main">
          <div class="row-t">${esc(p.display_name)}</div>
          <div class="sub">${esc(ROLES[p.role]?.[0] || p.role)} · ${plural(sectorCount(p.id), 'sector')} rostered</div>
        </div>
        <button class="btn danger small" data-act="removeTest" data-id="${esc(p.id)}">Remove</button>
      </div>`,
    )
    .join('');
  return `
    <form class="card form" data-form="test">
      <div class="card-head"><h2>Test accounts</h2><span class="badge ${tests.length ? 'info' : 'mute'}">${tests.length}</span></div>
      <p class="note">Stand-in team members for trying out the roster and roles. Nobody can sign in as one, and everyone on the team sees them until you remove them.</p>
      <div class="grid2">
        <label class="field">Name<input name="name" required maxlength="60" value="Test Pilot ${tests.length + 1}"></label>
        <label class="field">Role<select name="role">
          ${['pilot', 'dispatcher', 'observer', 'pending'].map((key) => `<option value="${key}">${ROLES[key][0]}</option>`).join('')}
        </select></label>
      </div>
      <div class="btn-row">
        <button class="btn primary" type="submit">Add test account</button>
        <button class="btn ghost" type="button" data-act="addFour">Add 4 test pilots</button>
      </div>
      ${rows ? `<div class="list">${rows}</div><button class="btn danger" type="button" data-act="removeTests">Remove all ${tests.length} test accounts</button>` : ''}
    </form>`;
}

function sectorCrew(id) {
  const s = state.sectors.find((x) => x.id === id);
  if (!s) return `<p class="note">Sector not found.</p><a class="btn ghost" href="#/admin">Back</a>`;
  const crew = crewOf(s);
  const duties = (selected) => DUTIES.map((d) => `<option ${d === selected ? 'selected' : ''}>${d}</option>`).join('');

  const entries = crew
    .map(
      (r) => `
      <form class="crew-edit" data-form="entry">
        <input type="hidden" name="user" value="${esc(r.user_id)}">
        <div class="row-t">${name(r.user_id)}</div>
        <label class="field">Duty<select name="duty">${duties(r.duty)}</select></label>
        <div class="grid2">
          <label class="field">Report date (UTC)<input type="date" name="date" required value="${isoDate(r.report_at)}"></label>
          <label class="field">Report time (UTC)<input type="time" name="time" required value="${isoTime(r.report_at)}"></label>
        </div>
        <label class="field">Note for this person<input name="notes" maxlength="200" value="${esc(r.notes)}"></label>
        <div class="btn-row">
          <button class="btn ghost" type="submit">Save changes</button>
          <button class="btn danger" type="button" data-act="remove" data-id="${esc(r.id)}">Remove</button>
        </div>
      </form>`,
    )
    .join('');

  const report = defaultReport(s);
  const options = state.people
    .filter((p) => p.role !== 'pending' && !crew.some((r) => r.user_id === p.id))
    .map((p) => `<option value="${esc(p.id)}">${esc(p.display_name)} · ${plural(sectorCount(p.id), 'sector')}</option>`)
    .join('');

  return `
    <div class="page-head"><a class="back" href="#/admin">${icon('back')} Admin</a></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    <section class="card">
      <div class="card-head"><div>
        <div class="big">${esc(s.dep)} → ${esc(s.arr)}</div>
        <div class="sub">${esc(s.flight)} · Departs ${when(s.std)}${s.window ? ` · window ${depWindow(s)}` : ''}</div>
      </div>${needBadge(s)}</div>
      ${entries || '<p class="note">No crew rostered on this sector yet.</p>'}
    </section>
    <form class="card form" data-form="entry">
      <h2>Add someone to this sector</h2>
      <label class="field">Team member<select name="user" required><option value="">Select…</option>${options}</select></label>
      <label class="field">Duty<select name="duty">${duties(crew.length ? (crew.some((r) => r.duty === 'First Officer') ? 'Relief Pilot' : 'First Officer') : 'Captain')}</select></label>
      <div class="grid2">
        <label class="field">Report date (UTC)<input type="date" name="date" required value="${isoDate(report)}"></label>
        <label class="field">Report time (UTC)<input type="time" name="time" required value="${isoTime(report)}"></label>
      </div>
      <label class="field">Note for this person (optional)<input name="notes" maxlength="200" placeholder="e.g. Taking over at top of descent"></label>
      <div class="btn-row"><button class="btn primary" type="submit">Add to roster</button></div>
    </form>`;
}

export function render(args) {
  let out;
  if (!canEdit()) {
    out = `<div class="page-head"><h1>Admin</h1></div>
      <section class="card"><p class="note">This section is for team admins and dispatchers. Ask an admin if you need access.</p></section>`;
  } else if (args[0] === 'people') out = people();
  else if (args[0] === 'auto') out = autoPage();
  else if (args[0] === 'rules') out = rulesPage();
  else if (args[0] === 'sector') out = sectorCrew(args[1]);
  else out = rosterEditor();
  error = '';
  result = '';
  gapNote = '';
  return out;
}

async function change(work) {
  try {
    await work();
  } catch (err) {
    error = err.message;
  }
  await syncTeam();
  if (location.hash.startsWith('#/admin')) rerender();
}

const currentSectorId = () => decodeURIComponent(location.hash.split('/')[3] || '');

export const changes = {
  // Quick editor: put someone in a seat, swap them, or clear it.
  seat(el) {
    const s = state.sectors.find((x) => x.id === el.dataset.sector);
    const duty = el.dataset.duty;
    const userId = el.value;
    const crew = crewOf(s);
    const holder = crew.find((r) => r.duty === duty);
    for (const select of el.closest('.card').querySelectorAll('select')) select.disabled = true;
    return change(async () => {
      if (holder && holder.user_id !== userId) await deleteRoster(holder.id);
      if (!userId) return;
      // Someone already on this sector keeps their report time and note.
      const existing = crew.find((r) => r.user_id === userId);
      await saveRoster({
        sector_id: s.id,
        user_id: userId,
        duty,
        report_at: existing?.report_at || defaultReport(s).toISOString(),
        notes: existing?.notes || '',
        auto: false,
      });
    });
  },
  role(el) {
    const who = person(el.dataset.id)?.display_name;
    if (el.value === 'admin' && !confirm(`Make ${who} an admin? Admins can change everyone's roles.`)) {
      return rerender();
    }
    el.disabled = true;
    return change(() => setRole(el.dataset.id, el.value));
  },
};

export const forms = {
  rules(data) {
    const next = { unmarkedAvailable: data.get('unmarkedAvailable') === 'on' };
    for (const key of Object.keys(DEFAULT_RULES)) {
      if (key === 'unmarkedAvailable') continue;
      const value = Number(data.get(key));
      next[key] = isFinite(value) && value >= 0 ? value : DEFAULT_RULES[key];
    }
    next.bocStart = Math.min(23, Math.floor(next.bocStart));
    next.bocEnd = Math.min(23, Math.floor(next.bocEnd));
    return change(async () => {
      await saveSettings({ rules: next });
      result = 'Rules saved.';
    });
  },
  test(data, formEl) {
    formEl.querySelector('[type=submit]').disabled = true;
    return change(() => addTestAccount(String(data.get('name')).trim(), data.get('role')));
  },
  // Used both to add someone and to edit an existing entry.
  entry(data, formEl) {
    const report = new Date(`${data.get('date')}T${data.get('time')}:00Z`);
    if (isNaN(report)) return;
    formEl.querySelector('[type=submit]').disabled = true;
    return change(() =>
      saveRoster({
        sector_id: currentSectorId(),
        user_id: data.get('user'),
        duty: data.get('duty'),
        report_at: report.toISOString(),
        notes: String(data.get('notes')).trim(),
        auto: false,
      }),
    );
  },
};

export const actions = {
  state(el) {
    const publish = el.dataset.state === 'published';
    if (publish && !confirm('Publish the roster? Everyone on the team will be able to see it.')) return;
    el.disabled = true;
    return change(async () => {
      await saveSettings({ roster_state: el.dataset.state });
      result = publish ? 'Roster published.' : 'Roster moved back to draft.';
    });
  },
  auto(el) {
    el.disabled = true;
    return change(async () => {
      const { added, gaps } = planRoster({
        sectors: state.sectors,
        roster: state.roster,
        people: state.people,
        prefs: state.prefs,
        rules: rules(),
        now: Date.now(),
        reportFor: defaultReport,
      });
      if (added.length) await saveRosterMany(added);
      result = `Auto roster filled ${plural(added.length, 'seat')}.`;
      if (gaps.length) {
        const list = gaps.slice(0, 8).map((g) => `${g.sector.flight} ${g.seat}`).join(', ');
        gapNote = `${plural(gaps.length, 'seat')} could not be filled within the rules and availability: ${list}${gaps.length > 8 ? ', and more' : ''}.`;
      }
    });
  },
  clearAuto(el) {
    if (!confirm('Remove everyone Auto roster placed? People you rostered by hand stay.')) return;
    el.disabled = true;
    return change(async () => {
      await clearAutoRoster();
      result = 'Auto-rostered seats cleared.';
    });
  },
  resetRules() {
    if (!confirm('Put every rule back to its default?')) return;
    return change(async () => {
      await saveSettings({ rules: {} });
      result = 'Rules reset to defaults.';
    });
  },
  addFour(el) {
    el.disabled = true;
    const start = state.people.filter((p) => p.is_test).length;
    return change(async () => {
      for (let i = 1; i <= 4; i++) await addTestAccount(`Test Pilot ${start + i}`, 'pilot');
    });
  },
  removeTest(el) {
    if (!confirm('Remove this test account and its roster entries?')) return;
    el.disabled = true;
    return change(() => removeTestAccount(el.dataset.id));
  },
  removeTests(el) {
    if (!confirm('Remove every test account and their roster entries? Real accounts are not affected.')) return;
    el.disabled = true;
    return change(() => removeTestAccount(null));
  },
  approve(el) {
    el.disabled = true;
    return change(() => setRole(el.dataset.id, 'pilot'));
  },
  filter(el) {
    filter = el.dataset.filter;
    rerender();
  },
  remove(el) {
    if (!confirm('Remove this person from the sector?')) return;
    el.disabled = true;
    return change(() => deleteRoster(el.dataset.id));
  },
};
