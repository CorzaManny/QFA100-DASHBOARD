// Fuel & Load: the pilot's revision of the sector's imported OFP. The OFP
// stays the fixed baseline (see js/fuel.js) - this page only adds fuel on
// top of it, checks the result against structural limits, and saves a
// draft/submitted/accepted request with a revision history.

import { esc, zulu, zdate, icon, rerender } from '../ui.js';
import { kv } from './brief.js';
import { burnRatePerMin, minutesToKg, fuelPlan, limitsFor, limitChecks } from '../fuel.js';
import {
  sortedSectors,
  upcomingSector,
  currentSector,
  briefingOf,
  fuelRequestOf,
  saveFuel,
  canReport,
  canEdit,
  teamAircraft,
  me,
} from '../ops.js';

const REASONS = ['ATC delays', 'Weather', 'Holding', "Captain's discretion", 'Other'];

let busy = false;
let error = '';
let notice = '';

// The draft being edited, reset whenever the sector in the address changes -
// quick-add taps and field edits only touch this, so they don't spam the
// network; Save draft / Submit request are what actually persist it.
let draftSector = null;
let draft = { discretionary_kg: 0, taxi_kg: null, reason: '', unit: 'min' };

function freshDraft(saved) {
  return {
    discretionary_kg: saved?.discretionary_kg || 0,
    taxi_kg: saved?.taxi_kg ?? null,
    reason: saved?.reason || '',
    unit: 'min',
  };
}

function ensureDraft(sectorId, saved) {
  if (draftSector !== sectorId) {
    draftSector = sectorId;
    draft = freshDraft(saved);
  }
}

// The sector in the address, otherwise the next one to depart - same choice
// brief.js makes.
function sectorFor(args) {
  const sectors = sortedSectors();
  return sectors.find((s) => s.id === args[0]) || upcomingSector() || currentSector() || sectors.at(-1) || null;
}

const currentOfp = () => briefingOf(draftSector).ofp;

function weightBar(c, unitsLabel) {
  const cls = c.pct == null ? '' : c.pct > 100 ? 'bad' : c.pct >= 90 ? 'warn' : 'ok';
  return `
    <div class="weight-row">
      <div class="weight-head"><span>${esc(c.label)}</span><span class="tiny">${
        c.value != null ? `${Math.round(c.value).toLocaleString('en-AU')} / ${c.limit.toLocaleString('en-AU')} ${unitsLabel}` : '—'
      }</span></div>
      <div class="bar"><div class="${cls}" style="width:${Math.min(100, c.pct ?? 0)}%"></div></div>
    </div>`;
}

function loadSummaryCard(plan, checks, unitsLabel) {
  const w = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('en-AU')} ${unitsLabel}`);
  const allOk = checks.every((c) => c.ok);
  return `
    <section class="card">
      <div class="card-head"><h2>Load summary</h2>
        <span class="badge ${checks.length ? (allOk ? 'ok' : 'bad') : 'mute'}">${
          checks.length ? (allOk ? 'WITHIN LIMITS' : 'OVER A LIMIT') : 'LIMITS NOT CHECKED'
        }</span>
      </div>
      <div class="kvs">
        ${kv('Zero fuel weight', w(plan.zfw))}
        ${kv('Takeoff weight', w(plan.revisedTow))}
        ${kv('Landing weight (est.)', w(plan.revisedLdw))}
      </div>
      ${
        checks.length
          ? checks.map((c) => weightBar(c, unitsLabel)).join('')
          : '<p class="tiny">Structural limits are only checked when the OFP is in kilograms.</p>'
      }
    </section>`;
}

function breakdownCard(ofp, plan, rate, unitsLabel) {
  const canEditFuel = canReport();
  const w = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('en-AU')} ${unitsLabel}`);
  const quickAmounts = draft.unit === 'min' ? [5, 10, 15, 30] : [100, 250, 500, 1000];
  const quickBtns = quickAmounts
    .map(
      (amt) =>
        `<button type="button" class="btn ghost small" data-act="addFuel" data-amount="${amt}" ${busy ? 'disabled' : ''}>+${amt}${
          draft.unit === 'min' ? ' min' : ' kg'
        }</button>`,
    )
    .join('');
  const discretionaryShown = draft.unit === 'min' && rate ? Math.round(draft.discretionary_kg / rate) : draft.discretionary_kg;
  const delta = plan.plannedBlock != null && plan.revisedBlock != null ? plan.revisedBlock - plan.plannedBlock : null;

  return `
    <section class="card">
      <div class="card-head"><h2>Fuel breakdown</h2></div>
      <div class="kvs">
        ${kv('Trip fuel', w(ofp.tripFuel))}
        ${kv('Alternate fuel', w(ofp.altnFuel))}
        ${kv('Reserve fuel', w(ofp.reserveFuel))}
      </div>

      <label class="field">Taxi fuel (${unitsLabel})
        <input type="number" inputmode="decimal" min="0" step="1" data-change="taxi" value="${plan.taxi}" ${canEditFuel ? '' : 'disabled'}>
      </label>
      <div class="tiny">Planned ${w(ofp.taxiFuel)}</div>

      <h3>Discretionary fuel</h3>
      ${
        canEditFuel
          ? `<div class="seg">
          <button type="button" class="${draft.unit === 'min' ? 'on' : ''}" data-act="unit" data-unit="min" ${rate == null ? 'disabled' : ''}>Minutes</button>
          <button type="button" class="${draft.unit === 'kg' ? 'on' : ''}" data-act="unit" data-unit="kg">Kilograms</button>
        </div>
        ${rate == null && draft.unit !== 'kg' ? '<p class="tiny">No burn rate in the OFP (trip fuel or time enroute missing) - add fuel in kilograms instead.</p>' : ''}
        <label class="field">${draft.unit === 'min' ? 'Additional minutes' : 'Additional kilograms'}
          <input type="number" inputmode="decimal" min="0" step="${draft.unit === 'min' ? 1 : 10}" data-change="discretionary" value="${discretionaryShown}">
        </label>
        <div class="btn-row">${quickBtns}<button type="button" class="btn ghost small" data-act="resetFuel" ${busy ? 'disabled' : ''}>Reset to plan</button></div>`
          : ''
      }
      <div class="tiny">Equivalent additional fuel: <strong>${w(draft.discretionary_kg)}</strong>${
        rate ? ` · burn rate ${rate.toFixed(1)} ${unitsLabel}/min, from the OFP` : ''
      }</div>

      <h3>Block fuel</h3>
      <div class="kvs">
        ${kv('Planned', w(plan.plannedBlock))}
        ${kv('Revised', w(plan.revisedBlock))}
        ${kv('Change', delta == null ? '—' : `${delta >= 0 ? '+' : ''}${w(delta)}`)}
      </div>
    </section>`;
}

function requestCard(exceeded, unitsLabel, saved) {
  const status = saved?.status || 'draft';
  const statusBadge = { draft: 'mute', submitted: 'info', accepted: 'ok' }[status];
  const history = Array.isArray(saved?.history) ? saved.history : [];
  const canSubmit = canReport();
  return `
    <section class="card">
      <div class="card-head"><h2>Final fuel request</h2><span class="badge ${statusBadge}">${status.toUpperCase()}</span></div>
      ${
        canSubmit
          ? `<label class="field">Reason for additional fuel
          <select data-change="reason">
            ${REASONS.map((r) => `<option value="${esc(r)}" ${draft.reason === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
          </select>
        </label>`
          : draft.reason
            ? `<p class="note"><strong>Reason:</strong> ${esc(draft.reason)}</p>`
            : ''
      }
      ${exceeded ? `<p class="note warn">${icon('alert')} This exceeds a structural limit - submitting is blocked until it's back within limits.</p>` : ''}
      ${
        canSubmit
          ? `<div class="btn-row">
          <button class="btn ghost" data-act="saveDraft" ${busy ? 'disabled' : ''}>Save draft</button>
          <button class="btn primary" data-act="submit" ${busy || exceeded ? 'disabled' : ''}>Submit request</button>
          ${status === 'submitted' && canEdit() ? `<button class="btn ghost" data-act="accept" ${busy ? 'disabled' : ''}>Mark accepted</button>` : ''}
        </div>`
          : ''
      }
      ${
        history.length
          ? `<h3>Revision history</h3>
        <div class="list">${history
          .slice()
          .reverse()
          .map(
            (h) => `
          <div class="row">
            <div class="row-main">
              <div class="row-t">${esc(String(h.status || '').toUpperCase())}${h.reason ? ` · ${esc(h.reason)}` : ''}</div>
              <div class="sub">${esc(h.by || 'Unknown')} · ${zdate(h.at)} ${zulu(h.at)}</div>
            </div>
            <div class="right"><div class="sub">+${Math.round(h.discretionary_kg || 0).toLocaleString('en-AU')} ${unitsLabel}</div></div>
          </div>`,
          )
          .join('')}</div>`
          : ''
      }
    </section>`;
}

export function render(args) {
  const s = sectorFor(args);
  if (!s) return `<div class="page-head"><h1>Fuel &amp; Load</h1></div><p class="note">There are no sectors in the schedule yet.</p>`;
  const sectors = sortedSectors();
  const b = briefingOf(s.id);
  const ofp = b.ofp;
  const saved = fuelRequestOf(s.id);
  ensureDraft(s.id, saved);

  const header = `
    <div class="page-head"><h1>Fuel &amp; Load</h1></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}
    <section class="card">
      <h2>${esc(s.dep)} → ${esc(s.arr)}</h2>
      <label class="field">Sector<select data-change="sector">
        ${sectors
          .map((x) => `<option value="${esc(x.id)}" ${x.id === s.id ? 'selected' : ''}>${esc(x.dep)} → ${esc(x.arr)} · ${zdate(x.std)} ${zulu(x.std)}</option>`)
          .join('')}</select></label>
      <div class="kvs">
        ${kv('Flight', esc(s.flight))}
        ${kv('Aircraft', esc(teamAircraft()))}
        ${kv('Departs', `${zdate(s.std)} ${zulu(s.std)}`)}
      </div>
    </section>`;

  if (!ofp) {
    return `${header}
      <section class="card">
        <p class="note">No flight plan imported for this sector yet. Import the OFP on the <a href="#/brief/${esc(
          s.id,
        )}">Sector Briefing</a> page, then come back here to adjust the fuel.</p>
      </section>`;
  }

  const plan = fuelPlan(ofp, draft);
  const limits = limitsFor(teamAircraft());
  const checks = limitChecks(ofp, plan, limits);
  const exceeded = checks.some((c) => !c.ok);
  const rate = burnRatePerMin(ofp);
  const unitsLabel = esc(String(ofp.units || 'kgs').toUpperCase());

  return `
    ${header}
    ${loadSummaryCard(plan, checks, unitsLabel)}
    ${breakdownCard(ofp, plan, rate, unitsLabel)}
    ${requestCard(exceeded, unitsLabel, saved)}`;
}

async function run(work, done) {
  if (busy) return;
  busy = true;
  rerender();
  try {
    await work();
    notice = done;
  } catch (err) {
    error = `Could not save: ${err.message}`;
  }
  busy = false;
  if (location.hash.startsWith('#/fuel')) rerender();
}

function historyEntry(status) {
  return {
    at: new Date().toISOString(),
    by: me()?.display_name || '',
    status,
    discretionary_kg: draft.discretionary_kg || 0,
    taxi_kg: draft.taxi_kg,
    reason: draft.reason || '',
  };
}

async function persist(sectorId, status) {
  const saved = fuelRequestOf(sectorId);
  const history = [...(Array.isArray(saved?.history) ? saved.history : []), historyEntry(status)];
  await saveFuel(sectorId, {
    discretionary_kg: draft.discretionary_kg || 0,
    taxi_kg: draft.taxi_kg,
    reason: draft.reason || '',
    status,
    history,
    by_name: me()?.display_name || '',
  });
}

export const changes = {
  sector(el) {
    location.hash = `#/fuel/${encodeURIComponent(el.value)}`;
  },
  taxi(el) {
    const v = Number(el.value);
    draft.taxi_kg = isNaN(v) ? null : v;
    rerender();
  },
  discretionary(el) {
    const v = Number(el.value);
    if (isNaN(v) || v < 0) return rerender();
    draft.discretionary_kg = draft.unit === 'min' ? minutesToKg(currentOfp(), v) ?? 0 : v;
    rerender();
  },
  reason(el) {
    draft.reason = el.value;
    rerender();
  },
};

export const actions = {
  unit(el) {
    draft.unit = el.dataset.unit;
    rerender();
  },
  addFuel(el) {
    const amt = Number(el.dataset.amount);
    const kg = draft.unit === 'min' ? minutesToKg(currentOfp(), amt) ?? amt : amt;
    draft.discretionary_kg = (draft.discretionary_kg || 0) + kg;
    rerender();
  },
  resetFuel() {
    draft.discretionary_kg = 0;
    draft.taxi_kg = null;
    rerender();
  },
  saveDraft() {
    const id = draftSector;
    return run(() => persist(id, 'draft'), 'Saved as a draft.');
  },
  submit() {
    const id = draftSector;
    return run(() => persist(id, 'submitted'), 'Fuel request submitted.');
  },
  accept() {
    const id = draftSector;
    return run(() => persist(id, 'accepted'), 'Fuel request accepted.');
  },
};
