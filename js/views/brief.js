// The briefing for one sector, shared by the whole team: the flight plan, the
// aircraft's defects, the handover from the crew before, the team's notes and
// WorldFlight's own page and notes.

import { state } from '../store.js';
import { esc, zulu, zdate, simLocal, span, ago, icon, rerender } from '../ui.js';
import {
  sortedSectors,
  upcomingSector,
  currentSector,
  crewLabel,
  canEdit,
  canSetSimbrief,
  canReport,
  sharedLog,
  me,
  simbriefPlanUrl,
  fetchOfp,
  fetchMetar,
  fetchTafFor,
  briefingOf,
  saveBrief,
  simbriefId,
  syncTeam,
  estimateArrivalDelay,
  delayOf,
  setChosenDelay,
  DELAY_BANDS,
} from '../ops.js';

const WF_SCHEDULE = 'https://planning.worldflight.center/schedule';
const TEXT_FIELDS = ['notes', 'wf_url', 'wf_notes', 'handover'];

let busy = false;
let error = '';
let notice = '';
let delayLoading = false;
// The text card being edited, as "<sector id>:<card>". Every card reads until
// someone presses its Edit button.
let editing = '';
// Which cards are collapsed, by key. Survives a rerender the same way
// editing/busy do, since the whole page is rebuilt from scratch each time.
let collapsed = new Set();
// The TAF read for an airport (loading/ok/none/off/error) and why, same idea
// as the Airport Briefings page but tracked for two airports at once.
let tafState = {};
let tafError = {};

const isLink = (url) => /^https?:\/\/\S+$/i.test(url || '');

// The sector in the address, otherwise the next one to depart.
function sectorFor(args) {
  const sectors = sortedSectors();
  return sectors.find((s) => s.id === args[0]) || upcomingSector() || currentSector() || sectors.at(-1) || null;
}

const hhmm = (secs) =>
  secs == null ? '—' : `${String(Math.floor(secs / 3600)).padStart(2, '0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`;

const kv = (label, value) => `<div class="kv"><span>${label}</span><strong>${value}</strong></div>`;

// Every card on this page can be folded away, so a pilot who only wants the
// weather and the OFP is not scrolling past everything else to get there.
const isOpen = (key) => !collapsed.has(key);
const toggleBtn = (key) => {
  const open = isOpen(key);
  return `<button type="button" class="icon-btn chevron-btn${open ? ' open' : ''}" data-act="toggleCard" data-card="${esc(
    key,
  )}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'}">${icon('chevron')}</button>`;
};

// METAR and TAF for an airport, read the same way the Airport Briefings page
// reads them, so a sector's weather is on the Briefing itself and a pilot
// does not have to leave it just to check.
function metarBlock(code) {
  const m = state.metar[code];
  return m
    ? `<pre class="metar">${esc(m.text)}</pre><div class="tiny">${ago(m.at)} from VATSIM</div>`
    : '<p class="note">Loading METAR…</p>';
}

function tafBlock(code) {
  const t = state.taf[code];
  if (t?.text) {
    const text = t.text.replace(/\s+/g, ' ').replace(/ (FM\d|BECMG|TEMPO|INTER|PROB)/g, '\n  $1');
    return `<pre class="metar">${esc(text)}</pre><div class="tiny">${ago(t.at)} · forecast</div>`;
  }
  const st = tafState[code];
  if (st === 'loading') return '<p class="note">Loading TAF…</p>';
  if (st === 'off') {
    return '<p class="note">Forecasts are not switched on for this team yet. An admin runs <code>supabase/weather.sql</code> once, in Supabase.</p>';
  }
  if (st === 'error') return `<p class="note warn">${icon('alert')} Could not read the forecast (${esc(tafError[code] || '')}).</p>`;
  return `<p class="note">${esc(code)} does not publish a TAF.</p>`;
}

function weatherCard(s) {
  const open = isOpen('weather');
  const airport = (code, label) => `
    <div class="wx-col">
      <div class="wx-col-head"><span class="apt">${esc(code)}</span><span class="badge mute">${label}</span></div>
      <div class="tiny">METAR</div>${metarBlock(code)}
      <div class="tiny">TAF</div>${tafBlock(code)}
    </div>`;
  return `
    <section class="card">
      <div class="card-head"><h2>Weather</h2>${toggleBtn('weather')}</div>
      ${open ? `<div class="wx-grid">${airport(s.dep, 'DEPARTURE')}${airport(s.arr, 'ARRIVAL')}</div>` : ''}
    </section>`;
}

function ofpSummary(o, b) {
  const u = esc(String(o.units || 'kgs').toUpperCase());
  const w = (v) => (v == null ? '—' : `${Number(v).toLocaleString('en-AU')} ${u}`);
  return `
    <div class="route">
      <div><div class="apt">${esc(o.dep)}</div><div class="tiny">${o.depRwy ? `RWY ${esc(o.depRwy)}` : ''}</div></div>
      <div class="route-mid">${icon('plane', 'plane')}<div class="tiny">${hhmm(o.ete)} ENROUTE</div></div>
      <div class="right"><div class="apt">${esc(o.arr)}</div><div class="tiny">${o.arrRwy ? `RWY ${esc(o.arrRwy)}` : ''}</div></div>
    </div>
    <pre class="metar">${esc(o.route || 'No route in OFP')}</pre>
    <div class="kvs">
      ${kv('Aircraft', esc([o.acft, o.reg].filter(Boolean).join(' · ') || '—'))}
      ${kv('Alternate', esc(o.altn || '—'))}
      ${kv('Cruise', o.cruise ? `FL${Math.round(o.cruise / 100)}` : '—')}
      ${kv('Cost index', esc(o.costIndex || '—'))}
      ${kv('Scheduled out', o.schedOut ? `${zdate(o.schedOut)} ${zulu(o.schedOut)}` : '—')}
      ${kv('Passengers', esc(o.pax ?? '—'))}
    </div>
    <h3>Fuel</h3>
    <div class="kvs">
      ${kv('Block', w(o.blockFuel))}${kv('Trip', w(o.tripFuel))}${kv('Taxi', w(o.taxiFuel))}
      ${kv('Alternate', w(o.altnFuel))}${kv('Reserve', w(o.reserveFuel))}
    </div>
    <h3>Weights</h3>
    <div class="kvs">${kv('ZFW', w(o.zfw))}${kv('TOW', w(o.tow))}${kv('LDW', w(o.ldw))}</div>
    ${isLink(o.pdf) ? `<a class="btn ghost" href="${esc(o.pdf)}" target="_blank" rel="noopener">Open full OFP (PDF) ${icon('external')}</a>` : ''}
    <div class="tiny">Imported ${b.ofp_at ? ago(new Date(b.ofp_at).getTime()) : ''}${b.ofp_by ? ` by ${esc(b.ofp_by)}` : ''}${
      o.generated ? ` · generated ${zdate(o.generated)} ${zulu(o.generated)}` : ''
    }</div>`;
}

function ofpCard(s, b) {
  const id = simbriefId();
  const delay = delayOf(s.id);
  const open = isOpen('ofp');
  return `
    <section class="card">
      <div class="card-head"><h2>Flight plan (OFP)</h2>
        <div class="head-right">
          <span class="badge ${b.ofp ? 'ok' : 'mute'}">${b.ofp ? 'IMPORTED' : 'NOT IMPORTED'}</span>
          ${toggleBtn('ofp')}
        </div>
      </div>
      ${
        open
          ? `${b.ofp ? ofpSummary(b.ofp, b) : '<p class="note">Nobody has imported the flight plan for this sector yet.</p>'}
      ${
        canReport()
          ? `${
              id
                ? `<p class="note">Import takes the latest plan generated by the team's SimBrief account <strong>${esc(id)}</strong> and saves it here for everyone.</p>`
                : '<p class="note">No SimBrief account is set yet, so there is nothing to import from.</p>'
            }
            <div class="btn-row">
              ${id ? `<button class="btn primary" data-act="importOfp" ${busy ? 'disabled' : ''}>${busy ? 'Importing…' : b.ofp ? 'Import again' : 'Import latest OFP'}</button>` : ''}
              <a class="btn ghost" href="${esc(simbriefPlanUrl(s, delay?.chosen))}" target="_blank" rel="noopener">Plan in SimBrief${
                delay?.chosen ? ` (+${delay.chosen}m fuel)` : ''
              } ${icon('external')}</a>
            </div>`
          : ''
      }
      ${
        id
          ? ''
          : canSetSimbrief()
            ? '<p class="tiny">No team SimBrief account yet. Set it in <a href="#/admin/simbrief">Admin → SimBrief</a> and everyone imports the same flight plan.</p>'
            : '<p class="tiny">No team SimBrief account yet. An admin or operations sets it in Admin → SimBrief.</p>'
      }`
          : ''
      }
    </section>`;
}

const WX_BADGE = { VFR: 'ok', MVFR: 'info', IFR: 'warn', LIFR: 'bad' };
const BAND_BADGE = { Light: 'ok', Moderate: 'info', Busy: 'warn', High: 'bad', Severe: 'severe' };

const tile = (value, label, sub) =>
  `<div class="cgf-tile"><div class="cgf-n">${value}</div><div class="tiny">${label}</div>${sub ? `<div class="tiny mute">${esc(sub)}</div>` : ''}</div>`;

// A small inline chart of predicted arrivals either side of our ETA, binned
// from the same real VATSIM traffic the tiles above are counted from — the
// bucket holding our own ETA is picked out in the brand colour.
function trafficChart(d) {
  const buckets = d.buckets || [];
  if (!buckets.length) return '';
  const w = 600;
  const h = 132;
  const padT = 18;
  const padB = 20;
  const innerH = h - padT - padB;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const barW = w / buckets.length;
  const gap = Math.min(4, barW * 0.15);
  const ownIdx = buckets.findIndex((b) => b.own);
  const bars = buckets
    .map((b, i) => {
      const bh = b.count ? Math.max(3, (b.count / max) * innerH) : 1;
      const x = i * barW + gap / 2;
      const bw = Math.max(1, barW - gap);
      const y = padT + (innerH - bh);
      const label = b.own || i % 2 === 0 ? esc(zulu(b.at)) : '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${
        b.own ? 'var(--accent)' : 'var(--info)'
      }"><title>${b.count} arriving around ${esc(zulu(b.at))}</title></rect>${
        label ? `<text x="${(x + bw / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle" class="cgf-tick">${label}</text>` : ''
      }`;
    })
    .join('');
  const ownX = ownIdx >= 0 ? (ownIdx * barW + barW / 2).toFixed(1) : null;
  const summary = buckets.map((b) => `${esc(zulu(b.at))}: ${b.count}`).join(', ');
  return `
    <svg class="cgf-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Predicted arrivals by time — ${summary}">
      <line x1="0" y1="${h - padB}" x2="${w}" y2="${h - padB}" class="cgf-base"/>
      ${bars}
      ${
        ownX != null
          ? `<line x1="${ownX}" y1="14" x2="${ownX}" y2="${h - padB}" class="cgf-eta-line"/>
             <text x="${ownX}" y="10" text-anchor="middle" class="cgf-eta-label">YOUR ETA</text>`
          : ''
      }
    </svg>
    <div class="cgf-legend">
      <span><i class="cgf-dot info"></i>Other traffic</span>
      <span><i class="cgf-dot accent"></i>Your ETA</span>
    </div>`;
}

// What ATC traffic and the destination's forecast weather suggest for
// holding or sequencing around our ETA, fed into the "Plan in SimBrief" link
// below as extra fuel. The slider lets the crew take more or less than the
// recommendation; SimBrief turns whatever is chosen into an actual fuel load.
function delayCard(s) {
  const d = delayOf(s.id);
  const open = isOpen('congestion');
  if (!d) {
    return `
      <section class="card">
        <div class="card-head"><h2>Destination congestion forecast</h2>
          <div class="head-right">
            <button class="icon-btn" data-act="delay" aria-label="Refresh">${icon('refresh')}</button>
            ${toggleBtn('congestion')}
          </div>
        </div>
        ${open ? `<p class="note">${delayLoading ? `Checking VATSIM traffic and the forecast for ${esc(s.arr)}…` : 'Not checked yet.'}</p>` : ''}
      </section>`;
  }
  return `
    <section class="card cgf-card">
      <div class="card-head">
        <div><h2>Destination congestion forecast</h2>
          <div class="tiny">Predicted traffic at ${esc(d.dest)} around your ETA, ${zulu(d.eta)}</div></div>
        <div class="head-right">
          <button class="icon-btn" data-act="delay" aria-label="Refresh">${icon('refresh')}</button>
          ${toggleBtn('congestion')}
        </div>
      </div>
      ${
        open
          ? `<div class="cgf-head">
        <span class="badge ${BAND_BADGE[d.band] || 'mute'} cgf-band">${esc(d.band.toUpperCase())} CONGESTION</span>
        <div class="cgf-score"><strong>${d.score}</strong><span>/100</span><div class="tiny">Congestion score</div></div>
      </div>
      <div class="cgf-tiles">
        ${tile(d.arrivals, 'Predicted arrivals', '±45 min of ETA')}
        ${tile(d.departures, 'Filed to depart', `on the ground at ${d.dest} now`)}
        ${tile(esc(d.atc.label), 'ATC coverage', d.atc.detail)}
        ${tile(
          d.weather ? `<span class="badge ${WX_BADGE[d.weather] || 'mute'}">${d.weather}</span>` : '—',
          'Weather at ETA',
          d.weatherSource ? `from the ${d.weatherSource}` : 'unavailable',
        )}
      </div>
      ${trafficChart(d)}
      <div class="cgf-fuel">
        <div class="cgf-fuel-n"><strong>${d.chosen}</strong><span>minutes</span></div>
        <div class="tiny">Holding/traffic fuel sent to SimBrief · recommended ${d.minutes} min for ${esc(d.band).toLowerCase()} congestion</div>
        <input type="range" name="holdFuel" data-change="holdFuel" min="0" max="90" step="5" value="${d.chosen}" aria-label="Holding/traffic fuel, in minutes">
        <div class="cgf-scale">
          ${DELAY_BANDS.map(
            (b) =>
              `<span class="${BAND_BADGE[b.label]}${b.minutes === d.minutes ? ' on' : ''}">${b.minutes}m<br>${b.label}</span>`,
          ).join('')}
        </div>
      </div>
      <div class="tiny">Checked ${ago(d.at)}${d.feedOk ? '' : ' · VATSIM feed unavailable, traffic not counted'}</div>`
          : ''
      }
    </section>`;
}

function defectsCard() {
  const active = state.defects.filter((d) => d.status !== 'RECTIFIED');
  const aog = active.some((d) => d.aog);
  const rows = active
    .map(
      (d) => `
      <a class="row" href="#/techlog/${esc(d.id)}">
        <div class="row-main">
          <div class="row-t">${esc(d.ref)} · ${esc(d.desc)}</div>
          ${d.restriction ? `<div class="sub">Restriction: <strong>${esc(d.restriction)}</strong></div>` : ''}
          ${d.melItem ? `<div class="sub">MEL ${esc(d.melItem)}${d.due ? ` · fix by ${zdate(d.due)}` : ''}</div>` : ''}
        </div>
        <div class="right stack"><span class="badge ${d.status === 'OPEN' ? 'bad' : 'warn'}">${d.status}</span>
          ${d.aog ? '<span class="badge bad">AOG</span>' : ''}</div>
      </a>`,
    )
    .join('');
  const open = isOpen('defects');
  return `
    <section class="card list">
      <div class="card-head"><div class="tiny">AIRCRAFT STATUS</div>
        <div class="head-right">
          <span class="badge ${aog ? 'bad' : active.length ? 'warn' : 'ok'}">${aog ? 'UNSERVICEABLE' : active.length ? `${active.length} DEFECT${active.length > 1 ? 'S' : ''}` : 'SERVICEABLE'}</span>
          ${toggleBtn('defects')}
        </div>
      </div>
      ${open ? rows || '<p class="note">No open or deferred defects in the tech log.</p>' : ''}
    </section>`;
}

// A card of text everyone reads. The crew press Edit to change it. collapseKey
// folds it away like every other card; editing always shows in full.
function textCard(sectorId, collapseKey, title, help, fields) {
  const key = `${sectorId}:${fields[0].name}`;
  if (!canReport() || editing !== key) {
    const open = isOpen(collapseKey);
    const shown = fields.filter((f) => f.value);
    return `
      <section class="card">
        <div class="card-head"><h2>${title}</h2>
          <div class="head-right">
            ${canReport() ? `<button class="btn ghost" data-act="edit" data-card="${esc(key)}">${shown.length ? 'Edit' : 'Add'}</button>` : ''}
            ${toggleBtn(collapseKey)}
          </div>
        </div>
        ${
          open
            ? shown
                .map((f) =>
                  f.url && isLink(f.value)
                    ? `<p class="note"><a href="${esc(f.value)}" target="_blank" rel="noopener">${esc(f.value)}</a></p>`
                    : `<p class="mel-text">${esc(f.value)}</p>`,
                )
                .join('') || '<p class="note">Nothing here yet.</p>'
            : ''
        }
      </section>`;
  }
  return `
    <form class="card form" data-form="save">
      <h2>${title}</h2>
      ${help ? `<p class="note">${help}</p>` : ''}
      ${fields
        .map((f) =>
          f.url
            ? `<label class="field">${f.label}<input name="${f.name}" type="url" inputmode="url" autocapitalize="none" autocorrect="off" value="${esc(f.value)}" placeholder="${esc(f.placeholder)}"></label>`
            : `<label class="field">${f.label}<textarea name="${f.name}" rows="${f.rows || 4}" placeholder="${esc(f.placeholder)}">${esc(f.value)}</textarea></label>`,
        )
        .join('')}
      <div class="btn-row">
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Save</button>
        <button class="btn ghost" type="button" data-act="edit" data-card="">Cancel</button>
      </div>
    </form>`;
}

export function render(args) {
  const s = sectorFor(args);
  if (!s) return '<div class="page-head"><h1>Briefing</h1></div><p class="note">There are no sectors in the schedule yet.</p>';
  const sectors = sortedSectors();
  const prev = sectors[sectors.findIndex((x) => x.id === s.id) - 1];
  const b = briefingOf(s.id);
  const out = `
    <div class="page-head"><h1>Briefing</h1></div>
    ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
    ${notice ? `<p class="note ok">${esc(notice)}</p>` : ''}
    <section class="card">
      <label class="field">Sector<select data-change="sector">
        ${sectors
          .map((x) => `<option value="${esc(x.id)}" ${x.id === s.id ? 'selected' : ''}>${esc(x.dep)} → ${esc(x.arr)} · ${zdate(x.std)} ${zulu(x.std)}</option>`)
          .join('')}</select></label>
      <div class="kvs">
        ${kv('Flight', esc(s.flight))}
        ${kv('Departs', `${zdate(s.std)} ${zulu(s.std)}`)}
        ${kv('Sim local', esc(simLocal(s.std)))}
        ${kv('Block time', span(new Date(s.sta) - new Date(s.std)))}
      </div>
      <p class="note"><strong>Crew:</strong> ${esc(crewLabel(s))}</p>
      ${s.route ? `<pre class="metar">${esc(s.route)}</pre>` : ''}
      ${s.notes ? `<p class="note"><strong>Sector notes:</strong> ${esc(s.notes)}</p>` : ''}
      <div class="btn-row">
        <a class="btn ghost" href="#/airports/${esc(s.dep)}">${esc(s.dep)} briefing</a>
        <a class="btn ghost" href="#/airports/${esc(s.arr)}">${esc(s.arr)} briefing</a>
      </div>
    </section>
    ${weatherCard(s)}
    ${defectsCard()}
    ${
      prev
        ? `<section class="card">
            <div class="card-head"><h2>Handover from ${esc(prev.dep)} → ${esc(prev.arr)}</h2>${toggleBtn('handoverPrev')}</div>
            ${
              isOpen('handoverPrev')
                ? `<div class="sub">${esc(crewLabel(prev))}</div>
            ${briefingOf(prev.id).handover ? `<p class="mel-text">${esc(briefingOf(prev.id).handover)}</p>` : '<p class="note">The crew before has not left a handover yet.</p>'}`
                : ''
            }
          </section>`
        : ''
    }
    ${delayCard(s)}
    ${ofpCard(s, b)}
    ${textCard(s.id, 'notes', 'Team notes', 'Anything the team wants the crew of this sector to know.', [
      { name: 'notes', label: 'Notes', value: b.notes || '', placeholder: 'e.g. Expect holding into WSSS, ATC is busy' },
    ])}
    <section class="card">
      <div class="card-head"><h2>WorldFlight</h2>${toggleBtn('worldflight')}</div>
      ${
        isOpen('worldflight')
          ? `<div class="btn-row">
        ${isLink(b.wf_url) ? `<a class="btn primary" href="${esc(b.wf_url)}" target="_blank" rel="noopener">Official page for this sector ${icon('external')}</a>` : ''}
        <a class="btn ghost" href="${WF_SCHEDULE}" target="_blank" rel="noopener">WorldFlight schedule ${icon('external')}</a>
      </div>`
          : ''
      }
    </section>
    ${textCard(s.id, 'wfnotes', "WorldFlight's page and briefing notes", "Paste the address of WorldFlight's page for this sector, and their briefing notes, so nobody has to go looking.", [
      { name: 'wf_url', label: 'Official page address', value: b.wf_url || '', placeholder: 'https://…', url: true },
      { name: 'wf_notes', label: "WorldFlight's briefing notes", value: b.wf_notes || '', placeholder: 'Paste their notes for this sector', rows: 6 },
    ])}
    ${textCard(s.id, 'handoverNext', 'Handover to the next crew', 'Written by this sector’s crew: fuel state, quirks, what is already set up. It shows on the next sector’s briefing.', [
      { name: 'handover', label: 'Handover notes', value: b.handover || '', placeholder: 'e.g. Parked gate 54, APU running, 6.2 t on board' },
    ])}
    <p class="tiny center">${sharedLog() ? 'Saved for the whole team.' : 'Saved on this device only.'}</p>`;
  error = '';
  notice = '';
  return out;
}

const currentSectorId = () => sectorFor(location.hash.split('/').slice(2).map(decodeURIComponent))?.id;

// Checks VATSIM traffic and the destination weather as soon as the briefing
// opens, so the SimBrief link already carries the extra fuel by the time
// anyone presses it. Re-checks on request from the refresh button.
function loadDelay(s) {
  if (delayLoading) return;
  delayLoading = true;
  estimateArrivalDelay(s)
    .catch(() => {})
    .finally(() => {
      delayLoading = false;
      if (currentSectorId() === s.id) rerender();
    });
}

// METAR for both airports if it's more than five minutes old, TAF if more
// than fifteen — the same staleness windows the Airport Briefings page uses.
// mounted() runs on every rerender (toggling a card, dragging the slider),
// not just on first opening the page, so each fetch is guarded against
// being fired again while it's still in flight.
const wxLoading = new Set();

function loadWx(s) {
  for (const code of [s.dep, s.arr]) {
    const m = state.metar[code];
    const mKey = `${code}:metar`;
    if (!wxLoading.has(mKey) && (!m || Date.now() - m.at > 5 * 60000)) {
      wxLoading.add(mKey);
      fetchMetar(code)
        .catch(() => {})
        .finally(() => {
          wxLoading.delete(mKey);
          if (currentSectorId() === s.id) rerender();
        });
    }
    const t = state.taf[code];
    const tKey = `${code}:taf`;
    if (!wxLoading.has(tKey) && (!t || Date.now() - t.at > 15 * 60000)) {
      wxLoading.add(tKey);
      tafState[code] = 'loading';
      fetchTafFor(code)
        .then((got) => {
          tafState[code] = got == null ? 'off' : got.text ? 'ok' : 'none';
        })
        .catch((err) => {
          tafState[code] = 'error';
          tafError[code] = err.message;
        })
        .finally(() => {
          wxLoading.delete(tKey);
          if (currentSectorId() === s.id) rerender();
        });
    }
  }
}

export function mounted(root, args) {
  const s = sectorFor(args);
  if (!s) return;
  const cached = delayOf(s.id);
  if (!delayLoading && (!cached || Date.now() - cached.at > 5 * 60000)) loadDelay(s);
  loadWx(s);
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
  if (location.hash.startsWith('#/brief') || location.hash.startsWith('#/dispatch')) rerender();
}

export const changes = {
  sector(el) {
    location.hash = `#/brief/${encodeURIComponent(el.value)}`;
  },
  holdFuel(el) {
    setChosenDelay(currentSectorId(), Number(el.value));
    rerender();
  },
};

export const forms = {
  save(data) {
    const fields = {};
    for (const name of TEXT_FIELDS) {
      if (data.has(name)) fields[name] = String(data.get(name)).trim();
    }
    if (fields.wf_url && !isLink(fields.wf_url)) {
      error = 'The page address has to start with https://';
      return rerender();
    }
    return run(async () => {
      await saveBrief(currentSectorId(), fields);
      editing = '';
    }, 'Saved.');
  },
};

export const actions = {
  edit(el) {
    editing = el.dataset.card;
    error = '';
    rerender();
  },
  delay() {
    const s = sortedSectors().find((x) => x.id === currentSectorId());
    if (!s || delayLoading) return;
    loadDelay(s);
    rerender();
  },
  toggleCard(el) {
    const key = el.dataset.card;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    rerender();
  },
  importOfp() {
    const s = sortedSectors().find((x) => x.id === currentSectorId());
    return run(async () => {
      const o = await fetchOfp(simbriefId()).catch((err) => {
        throw new Error(`SimBrief said: ${err.message}`);
      });
      if (o.dep !== s.dep || o.arr !== s.arr) {
        throw new Error(`the latest SimBrief plan is ${o.dep} → ${o.arr}, not ${s.dep} → ${s.arr}. Generate this sector in SimBrief, then import again.`);
      }
      await saveBrief(s.id, { ofp: o, ofp_by: me()?.display_name || '', ofp_at: new Date().toISOString() });
    }, 'Flight plan imported for the whole team.');
  },
};
