// Availability: each person says which sectors they want, can do, or cannot do.
// Auto roster reads these. Admins and dispatchers can fill it in for someone else.

import { state, save } from '../store.js';
import { savePrefs, deletePref } from '../api.js';
import { esc, zulu, zdate, span, simLocal, icon, rerender } from '../ui.js';
import { sortedSectors, me, person, canEdit, prefOf, rules, isDraft, syncTeam } from '../ops.js';
import { isBoc } from '../autoroster.js';

const CHOICES = [
  ['prefer', 'Prefer'],
  ['available', 'Available'],
  ['unavailable', "Can't"],
];

let error = '';

// Whose availability this page is showing: someone else's only for editors.
function target(args) {
  const other = args[0] && canEdit() ? person(args[0]) : null;
  return other || me();
}

const upcoming = () => sortedSectors().filter((s) => new Date(s.std) > Date.now());

export function render(args) {
  const who = target(args);
  if (!who) return '<p class="note">Sign in to set your availability.</p>';
  const own = who.id === me()?.id;
  const r = rules();
  const sectors = upcoming();
  const counts = { prefer: 0, available: 0, unavailable: 0, none: 0 };

  const rows = sectors
    .map((s) => {
      const choice = prefOf(who.id, s.id);
      counts[choice || 'none'] += 1;
      const buttons = CHOICES.map(
        ([key, label]) =>
          `<button type="button" class="${choice === key ? `on ${key}` : ''}" data-act="choose" data-sector="${esc(s.id)}" data-choice="${key}" aria-pressed="${choice === key}">${label}</button>`,
      ).join('');
      return `
        <div class="avail">
          <div class="row-main">
            <div class="row-t">${esc(s.dep)} → ${esc(s.arr)} ${isBoc(s, r) ? '<span class="badge warn">BACK OF CLOCK</span>' : ''}</div>
            <div class="sub">${esc(s.flight)} · ${zdate(s.std)} ${zulu(s.std)} · <strong>${simLocal(s.std)}</strong> · ${span(new Date(s.sta) - new Date(s.std))}</div>
          </div>
          <div class="seg three">${buttons}</div>
        </div>`;
    })
    .join('');

  const out = `
    <div class="page-head">
      <a class="back" href="${own ? '#/roster' : '#/admin/auto'}">${icon('back')} ${own ? 'Roster' : 'Admin'}</a>
    </div>
    <section class="card">
      <h2>${own ? 'My availability' : `Availability for ${esc(who.display_name)}`}</h2>
      <p class="note">Mark each sector. <strong>Prefer</strong> means you would like it, <strong>Available</strong> means you can fly it, <strong>Can't</strong> means do not roster you. Tap a choice again to clear it. ${
        r.unmarkedAvailable
          ? 'Sectors left blank count as available.'
          : 'Sectors left blank count as <strong>not available</strong>.'
      }</p>
      <div class="chips">
        <span class="badge ok">${counts.prefer} PREFER</span>
        <span class="badge info">${counts.available} AVAILABLE</span>
        <span class="badge bad">${counts.unavailable} CAN'T</span>
        <span class="badge mute">${counts.none} BLANK</span>
      </div>
      ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
      ${
        counts.none
          ? `<button class="btn ghost" data-act="fill" data-user="${esc(who.id)}">Mark the ${counts.none} blank sectors as Available</button>`
          : ''
      }
      ${!isDraft() ? '<p class="tiny">The roster has been published. Changes here only matter if an admin runs Auto roster again.</p>' : ''}
    </section>
    <section class="card list">${rows || '<p class="note">No upcoming sectors.</p>'}</section>
    <p class="tiny center">Times are Zulu and sim local (Sydney). Back of clock is ${String(r.bocStart).padStart(2, '0')}00 to ${String(r.bocEnd).padStart(2, '0')}00 local${r.maxBoc ? `, and nobody is rostered on more than ${r.maxBoc} of those` : ''}.</p>`;
  error = '';
  return out;
}

const currentArgs = () => location.hash.split('/').slice(2).map(decodeURIComponent);

async function send(work) {
  try {
    await work();
  } catch (err) {
    // Put back whatever the database really holds.
    error = `Could not save: ${err.message}`;
    await syncTeam();
    if (location.hash.startsWith('#/availability')) rerender();
  }
}

export const actions = {
  // Shows the change at once, then saves it.
  choose(el) {
    const who = target(currentArgs());
    const sectorId = el.dataset.sector;
    const choice = el.dataset.choice;
    const clearing = prefOf(who.id, sectorId) === choice;
    state.prefs = state.prefs.filter((p) => !(p.user_id === who.id && p.sector_id === sectorId));
    if (!clearing) state.prefs.push({ user_id: who.id, sector_id: sectorId, choice });
    save();
    rerender();
    return send(() =>
      clearing ? deletePref(who.id, sectorId) : savePrefs([{ user_id: who.id, sector_id: sectorId, choice }]),
    );
  },
  fill(el) {
    const userId = el.dataset.user;
    const rows = upcoming()
      .filter((s) => !prefOf(userId, s.id))
      .map((s) => ({ user_id: userId, sector_id: s.id, choice: 'available' }));
    if (!rows.length) return;
    state.prefs.push(...rows);
    save();
    rerender();
    return send(() => savePrefs(rows));
  },
};
