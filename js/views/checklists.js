// Interactive 737 checklists. Works fully offline; progress is saved on the device.

import { state, save } from '../store.js';
import { esc, icon, rerender } from '../ui.js';
import { CHECKLIST_KINDS, NON_NORMAL_CHECKLISTS } from '../data/checklists.js';
import { saveChecklistStatus } from '../api.js';
import {
  me,
  syncChecklistStatus,
  teamChecklistStatus,
  normalChecklists,
  checklistsEditable,
  saveNormalChecklists,
} from '../ops.js';

const done = (cl) => cl.items.filter((_, i) => state.checks[cl.id]?.[cl.progressKeys?.[i] ?? i]).length;
// Complete on this device, or completed on the other EFB account and synced
// down - either way it shows as done, without touching this device's own
// ticks (see syncCompletion below for what gets shared and when).
const localComplete = (cl) => (cl.native ? !!state.checks[cl.id]?.branchComplete : done(cl) === cl.items.length);
const complete = (cl) => localComplete(cl) || !!teamChecklistStatus(cl.id)?.complete;
// Complete on the other EFB, but not ticked on this device at all - the
// checklist really was completed, so it should look it: every box ticked
// and the counter full, not a green badge over a page of empty checkboxes.
const syncedOnly = (cl) => !localComplete(cl) && !!teamChecklistStatus(cl.id)?.complete;
const displayDone = (cl) => (syncedOnly(cl) ? cl.items.length : done(cl));
const trail = [];

// ---- Editing the normal checklists, admin only ----
// What an admin has open in the editor, as its own copy of the checklist:
// { id, name, items, after, isNew }. Nothing reaches the team until Save, so
// Cancel really does leave the checklist as it was. Non-normal checklists are
// the extracted QRH and never open here.
let draft = null;
let editBusy = false;
let editError = '';
let editNotice = '';
// Where to put the cursor after a redraw: { i, what }, what being 'challenge'
// for a row just added, or 'up'/'down' for the button that just moved one.
let focusAfter = null;

// A new checklist's id. It keys that checklist's progress on every device and
// its completion in the team database, so it is made once from the name and
// then left alone - renaming a checklist never changes it.
function newChecklistId(name, taken) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'checklist';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// Reads whatever is typed in the editor back into the draft. Adding, removing
// and moving a row all redraw the page, which replaces every input, so this
// runs first and no unsaved typing is lost.
function captureDraft() {
  const form = document.getElementById('view')?.querySelector('[data-form="saveChecklist"]');
  if (!draft || !form) return;
  draft.name = form.querySelector('[name="name"]').value;
  draft.after = form.querySelector('[name="after"]')?.value ?? draft.after;
  draft.items = [...form.querySelectorAll('[data-item]')].map((row) => [
    row.querySelector('[name="challenge"]').value,
    row.querySelector('[name="response"]').value,
  ]);
}

// Saving goes to the team database and nowhere else - there is no local copy
// worth keeping - so the editor waits on it and says what happened. The draft
// has already been captured, so a redraw mid-save shows the typing back.
async function runEdit(work) {
  if (editBusy) return;
  editBusy = true;
  editError = '';
  rerender();
  try {
    await work();
  } catch (err) {
    editError = `Could not save: ${err.message}`;
  }
  editBusy = false;
  if (location.hash.startsWith('#/checklists')) rerender();
}

function editorCard(list) {
  const rows = draft.items
    .map(([challenge, response], i) => `
      <div class="cl-edit-row" data-item data-i="${i}">
        <input name="challenge" value="${esc(challenge)}" placeholder="Oxygen" aria-label="Item ${i + 1} challenge" maxlength="80">
        <input name="response" value="${esc(response)}" placeholder="Tested, 100%" aria-label="Item ${i + 1} response" maxlength="80">
        <div class="cl-edit-tools">
          <button class="btn ghost cl-edit-tool" type="button" data-act="moveItem" data-i="${i}" data-dir="-1" aria-label="Move item ${i + 1} up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button class="btn ghost cl-edit-tool" type="button" data-act="moveItem" data-i="${i}" data-dir="1" aria-label="Move item ${i + 1} down" ${i === draft.items.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
          <button class="btn ghost cl-edit-tool" type="button" data-act="removeItem" data-i="${i}" aria-label="Remove item ${i + 1}">${icon('trash')}</button>
        </div>
      </div>`)
    .join('');
  // Somewhere to put it in the run. The checklist being edited is left out:
  // it cannot follow itself.
  const others = list.filter((cl) => cl.id !== draft.id);
  return `
    <form class="card form cl-edit" data-form="saveChecklist">
      <div class="card-head">
        <h2>${draft.isNew ? 'New checklist' : `Edit ${esc(draft.name || 'checklist')}`}</h2>
        <span class="badge warn">ADMIN</span>
      </div>
      <p class="note">The challenge one pilot calls, and the response the other reads back. This is the whole team's checklist: it changes on every device, for everyone.</p>
      <div class="grid2">
        <label class="field">Name<input name="name" value="${esc(draft.name)}" placeholder="Before Taxi" maxlength="40" required></label>
        <label class="field">Runs after
          <select name="after">
            <option value="" ${draft.after ? '' : 'selected'}>First, before everything</option>
            ${others.map((cl) => `<option value="${esc(cl.id)}" ${draft.after === cl.id ? 'selected' : ''}>${esc(cl.name)}</option>`).join('')}
          </select>
          <span class="tiny">Where it sits in the run, and what the Next button reaches.</span>
        </label>
      </div>
      <div class="cl-edit-items">
        <div class="cl-edit-head"><span>Challenge</span><span>Response</span><span></span></div>
        ${rows || '<p class="note">No items yet. Add the first one below.</p>'}
      </div>
      <div class="btn-row">
        <button class="btn ghost" type="button" data-act="addItem">${icon('plus')} Add an item</button>
      </div>
      <p class="form-error" ${editError ? '' : 'hidden'}>${esc(editError)}</p>
      <p class="tiny">Saving clears this checklist's ticks everywhere and marks it not complete: once the wording changes, nobody has read out this version of it yet.</p>
      <div class="btn-row">
        <button class="btn primary" type="submit" ${editBusy ? 'disabled' : ''}>${draft.isNew ? 'Add checklist' : 'Save checklist'}</button>
        <button class="btn ghost" type="button" data-act="cancelEdit" ${editBusy ? 'disabled' : ''}>Cancel</button>
      </div>
      ${
        draft.isNew || list.length < 2
          ? ''
          : `<div class="btn-row"><button class="btn danger" type="button" data-act="deleteChecklist" ${editBusy ? 'disabled' : ''}>${icon('trash')} Delete this checklist</button></div>`
      }
    </form>`;
}

// The admin's own row of buttons under a normal checklist. Deliberately
// below the crew's buttons and plainly labelled, so nobody flying a sector
// reaches for it by accident.
function editBar(cl) {
  if (!checklistsEditable()) return '';
  return `
    <div class="btn-row cl-admin">
      <button class="btn ghost" data-act="editChecklist">${icon('pencil')} Edit ${esc(cl.name)}</button>
      <button class="btn ghost" data-act="addChecklist">${icon('plus')} Add a checklist</button>
    </div>
    <p class="tiny center">You are an admin: these change the normal checklists for the whole team.</p>`;
}

// Only the fact a checklist is complete is shared between the two EFB
// accounts, not every tick - so broadcast fires once on the transition to
// complete (and once back, on an explicit reset), never on every toggle.
// The local cache is updated straight away: without this, resetting a
// checklist that the *other* EFB had marked complete left complete(cl)
// reading the stale cached status as still true until the next poll caught up.
function syncCompletion(cl, isComplete) {
  const existing = (state.checklistStatus ??= []).find((c) => c.checklist_id === cl.id);
  if (existing) existing.complete = isComplete;
  else state.checklistStatus.push({ checklist_id: cl.id, complete: isComplete });
  save();
  saveChecklistStatus(cl.id, {
    complete: isComplete,
    completed_by: isComplete ? me()?.display_name || '' : '',
    completed_at: isComplete ? new Date().toISOString() : null,
  })
    .then(syncChecklistStatus)
    .catch(() => {});
}

// Only explicit "Choose one" groups are mutually exclusive. Numbered steps
// following a decision remain available, including shared jump destinations.
const decisionsCache = new WeakMap();
export function branchGroups(cl) {
  if (decisionsCache.has(cl)) return decisionsCache.get(cl);
  const groups = [];
  cl.blocks.forEach((block, start) => {
    if (!/^Choose one:$/i.test(block.text)) return;
    let end = cl.blocks.findIndex((next, i) => i > start && next.number !== null);
    if (end < 0) end = cl.blocks.length;
    const candidates = cl.blocks.slice(start + 1, end).filter((next) => next.type === 'branch' && next.number === null);
    if (!candidates.length) return;
    const depth = candidates[0].indent;
    const headers = candidates.filter((next) => next.indent === depth);
    if (headers.length < 2) return;
    const options = headers.map((header, i) => {
      const first = cl.blocks.indexOf(header);
      const last = i + 1 < headers.length ? cl.blocks.indexOf(headers[i + 1]) : end;
      return { id: header.id, blocks: cl.blocks.slice(first, last).map((next) => next.id) };
    });
    groups.push({ id: block.id, options });
  });
  // Explicit complementary conditions such as "controllable / uncontrollable"
  // also appear as numbered steps, outside a Choose one heading.
  const covered = new Set(groups.flatMap((group) => group.options.flatMap((option) => option.blocks)));
  const conditionKey = (text) => text.toLowerCase().replace(/^if /, '').replace(/:$/, '')
    .replace(/\bnot /g, '').replace(/\bun(?=[a-z])/g, '').trim();
  cl.blocks.forEach((block, start) => {
    if (covered.has(block.id) || block.type !== 'branch' || !/^If /i.test(block.text)) return;
    const second = cl.blocks.findIndex((next, i) => i > start && !covered.has(next.id)
      && next.type === 'branch' && /^If /i.test(next.text) && next.text !== block.text
      && conditionKey(next.text) === conditionKey(block.text));
    if (second < 0) return;
    let end = cl.blocks.findIndex((next, i) => i > second && next.number !== null);
    if (end < 0) end = cl.blocks.length;
    const options = [
      { id: block.id, blocks: cl.blocks.slice(start, second).map((next) => next.id) },
      { id: cl.blocks[second].id, blocks: cl.blocks.slice(second, end).map((next) => next.id) },
    ];
    options.forEach((option) => option.blocks.forEach((id) => covered.add(id)));
    groups.push({ id: block.id, options });
  });
  decisionsCache.set(cl, groups);
  return groups;
}

function branchState(cl) {
  const choices = state.checks[cl.id]?.choices || {};
  const blocks = new Map();
  for (const group of branchGroups(cl)) {
    const selected = choices[group.id];
    for (const option of group.options) {
      for (const id of option.blocks) blocks.set(id, {
        group: group.id, option: option.id, header: id === option.id,
        selected: selected === option.id, inactive: !!selected && selected !== option.id,
      });
    }
  }
  return blocks;
}

// Patch existing controls so ticking or choosing never rebuilds the page,
// scrolls the sidebar into view, or moves keyboard focus.
function updateNative(cl) {
  const root = document.getElementById('view');
  if (!root) return;
  const branches = branchState(cl);
  root.querySelectorAll('[data-qrh-block]').forEach((row) => {
    const branch = branches.get(row.dataset.qrhBlock);
    row.classList.toggle('qrh-muted', !!branch?.inactive);
    row.querySelectorAll('button').forEach((button) => {
      const choosing = button.dataset.act === 'chooseBranch';
      button.disabled = !choosing && !!branch?.inactive;
      if (choosing || button.dataset.act === 'toggle') {
        const on = choosing ? !!branch?.selected : !!state.checks[cl.id]?.[button.dataset.i];
        button.classList.toggle('on', on);
        button.setAttribute('aria-pressed', String(on));
        button.querySelector('.cl-box').innerHTML = on ? icon('check') : '';
      }
    });
  });
  const badge = root.querySelector('[data-qrh-progress]');
  if (badge) {
    badge.textContent = complete(cl) ? 'Branch complete' : `${done(cl)} items checked`;
    badge.classList.toggle('ok', complete(cl));
    badge.classList.toggle('mute', !complete(cl));
  }
  const chip = root.querySelector('.chip.on');
  if (chip) {
    chip.classList.toggle('done', complete(cl));
    chip.querySelector('.chip-n').textContent = `${displayDone(cl)} / ${cl.items.length}`;
  }
}

function focusBlock(id) {
  const target = document.getElementById(`qrh-${id}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target?.focus({ preventScroll: true });
}
// The normal ones are the team's own, so they are asked for rather than read
// from a fixed list; the non-normal ones are the extracted QRH and never change.
const ofKind = (kind) => (kind === 'non-normal' ? NON_NORMAL_CHECKLISTS : normalChecklists());
const allChecklists = () => [...normalChecklists(), ...NON_NORMAL_CHECKLISTS];

function systemLabel(cl) {
  const labels = {
    'Miscellaneous': 'General & emergencies',
    'Evacuation': 'General & emergencies',
    'Engine Fire on the Ground Checklist': 'Fire Protection',
    'Airplane Gen., Emer. Equip., Doors, Windows': 'Doors, windows & emergency equipment',
  };
  return labels[cl.section] || cl.section || 'General & emergencies';
}

export function checklistGroups(checklists) {
  const groups = new Map();
  for (const cl of checklists) {
    const label = systemLabel(cl);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(cl);
  }
  return [...groups].sort(([a], [b]) => a === 'General & emergencies' ? -1 : b === 'General & emergencies' ? 1 : a.localeCompare(b))
    .map(([label, entries]) => ({ label, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) }));
}


// What the Dashboard offers to resume: only the ones flown every sector.
export function nextIncomplete() {
  return ofKind('normal').find((cl) => !complete(cl)) || null;
}

// Which group and which checklist the address is asking for. #/checklists/<id>
// opens one; #/checklists/kind/<kind> opens a group that may be empty.
function active(args) {
  if (args[0] === 'kind') {
    const kind = args[1] || 'normal';
    return { kind, cl: ofKind(kind)[0] || null };
  }
  const cl = allChecklists().find((c) => c.id === args[0]) || nextIncomplete() || normalChecklists()[0];
  return { kind: cl?.kind || 'normal', cl: cl || null };
}

export function render(args) {
  const { kind, cl } = active(args);
  const group = ofKind(kind);
  // A draft belongs to the checklist it was opened from. Walking away - to
  // another checklist, or to the non-normal tab - closes the editor rather
  // than carrying it somewhere it does not belong.
  if (draft && (kind !== 'normal' || (!draft.isNew && draft.id !== cl?.id))) draft = null;
  // Shown once, on the render that follows a save.
  const saved = editNotice;
  editNotice = '';

  const kinds = CHECKLIST_KINDS.map(([key, label]) => {
    const first = ofKind(key)[0];
    const href = first ? `#/checklists/${first.id}` : `#/checklists/kind/${key}`;
    return `<a class="${key === kind ? 'on' : ''}" href="${href}">${esc(label)}</a>`;
  }).join('');

  const chip = (c) => `<a class="chip ${c.id === cl?.id ? 'on' : ''} ${complete(c) ? 'done' : ''}" data-checklist-id="${esc(c.id)}" href="#/checklists/${c.id}" ${c.id === cl?.id ? 'aria-current="page"' : ''}>
      <span class="chip-t">${esc(c.name)}</span>
      <span class="chip-n">${displayDone(c)} / ${c.items.length}</span></a>`;
  const chips = group.map(chip).join('');
  const library = kind === 'non-normal'
    ? `<nav class="qrh-library" aria-label="Non-normal checklists by system">${checklistGroups(group).map(({ label, entries }) => `
      <details class="qrh-system" ${entries.includes(cl) ? 'open' : ''}>
        <summary><span>${esc(label)}</span><span class="tiny" data-system-count>${entries.length}</span></summary>
        <div class="qrh-system-list">${entries.map(chip).join('')}</div>
      </details>`).join('')}</nav>`
    : `<nav class="chip-row" aria-label="Checklists">${chips}</nav>`;

  const shell = (body) => `
    <nav class="seg tabs4 on-card" aria-label="Kind of checklist">${kinds}</nav>
    ${saved ? `<p class="note ok">${esc(saved)}</p>` : ''}
    ${kind === 'non-normal' ? `<label class="qrh-search">Find a non-normal checklist
      <input type="search" data-qrh-search placeholder="Search title, system or condition…" autocomplete="off">
      <span class="tiny" data-qrh-count>${group.length} checklists</span>
    </label>` : ''}
    <div class="cl-layout ${chips ? '' : 'solo'} ${kind === 'non-normal' ? 'qrh-layout' : ''}">
      ${chips ? library : ''}
      <div class="cl-main">${body}</div>
    </div>`;

  // The editor takes over the main column, with the list still beside it so
  // an admin can see where the checklist being edited sits in the run.
  if (draft && checklistsEditable()) {
    return `${shell(editorCard(group))}
    <p class="tiny center">Boeing 737NG checklists. For flight simulation use only.</p>`;
  }

  if (!cl) {
    return `${shell(`<section class="card">
        <h2>${esc(CHECKLIST_KINDS.find(([k]) => k === kind)?.[1] || '')} checklists</h2>
        <p class="note">None added yet. They live in <code>js/data/checklists.js</code>: give a checklist
          <code>kind: '${esc(kind)}'</code> and it appears here.</p>
      </section>`)}
    <p class="tiny center">Boeing 737NG checklists. For flight simulation use only.</p>`;
  }

  if (cl.native) {
    let actionIndex = 0;
    const branches = branchState(cl);
    const blocks = cl.blocks.map((block) => {
      const index = block.type === 'action' ? (block.check_index ?? actionIndex++) : null;
      const on = index !== null && !!state.checks[cl.id]?.[index];
      const branch = branches.get(block.id);
      const label = block.number !== null ? `<span class="qrh-number">${esc(block.number)}.</span> ` : '';
      const [challenge, ...responseParts] = block.text.split(' — ');
      const response = responseParts.join(' — ');
      const choosing = branch?.header;
      const disabled = branch?.inactive && !choosing;
      const content = block.type === 'action' || choosing
        ? `<button class="cl-item qrh-check ${choosing ? 'qrh-option' : ''} ${(choosing ? branch.selected : on) ? 'on' : ''}"
            data-act="${choosing ? 'chooseBranch' : 'toggle'}" data-i="${index}" data-block="${block.id}"
            ${choosing ? `data-group="${branch.group}" data-option="${branch.option}"` : ''}
            aria-pressed="${!!(choosing ? branch.selected : on)}" ${disabled ? 'disabled' : ''}>
          <span class="cl-box">${(choosing ? branch.selected : on) ? icon('check') : ''}</span>
          <span class="cl-ch">${label}${esc(choosing ? block.text : challenge)}</span>
          ${response && !choosing ? `<span class="cl-re">${esc(response)}</span>` : ''}
        </button>`
        : `<div class="qrh-text">${label}<span>${esc(block.text)}</span></div>`;
      const links = block.links.map((link) => `<button class="btn ghost" data-act="follow" data-checklist="qrh-${esc(link.checklist)}" data-block="${esc(link.block || '')}" data-from="${block.id}" ${disabled ? 'disabled' : ''}>${esc(link.label)} ${icon('chevron')}</button>`).join('');
      return `<div id="qrh-${block.id}" data-qrh-block="${block.id}" tabindex="-1" class="qrh-block qrh-${block.type} ${branch?.inactive ? 'qrh-muted' : ''}">
        ${content}${links ? `<div class="qrh-links">${links}</div>` : ''}
        ${block.type === 'end' ? `<button class="btn ghost qrh-finish" data-act="finishBranch" ${disabled ? 'disabled' : ''}>Mark this branch complete</button>` : ''}
      </div>`;
    }).join('');
    const back = trail.at(-1);
    return shell(`<section class="card cl qrh-card">
      <div class="card-head"><h2>${esc(cl.name)}</h2><span data-qrh-progress aria-live="polite" class="badge ${complete(cl) ? 'ok' : 'mute'}">${complete(cl) ? 'Branch complete' : `${done(cl)} items checked`}</span></div>
      <p class="tiny">${esc(cl.section)} · For flight simulation only. Extracted text requires review.</p>
      ${back ? `<button class="btn ghost" data-act="returnChecklist">Return to ${esc(back.name)}</button>` : ''}
      <p class="note">Select the applicable option, then check off each action. Other options grey out. Progress is saved on this device.</p>
      <div class="qrh-blocks">${blocks}</div>
      <div class="btn-row"><button class="btn ghost" data-act="reset">Reset this checklist</button>
        <button class="btn ghost" data-act="resetAll">New flight: reset all</button></div>
    </section>`);
  }

  const idx = group.findIndex((c) => c.id === cl.id);
  const next = group[idx + 1];
  const isDone = complete(cl);
  const teamStatus = teamChecklistStatus(cl.id);
  const teamOnly = syncedOnly(cl);

  const items = cl.items
    .map(([challenge, response], i) => {
      const on = teamOnly || !!state.checks[cl.id]?.[i];
      return `<button class="cl-item ${on ? 'on' : ''}" data-act="toggle" data-i="${i}" aria-pressed="${on}" ${teamOnly ? 'disabled' : ''}>
        <span class="cl-box">${on ? icon('check') : ''}</span>
        <span class="cl-ch">${esc(challenge)}</span>
        <span class="cl-re">${esc(response)}</span>
      </button>`;
    })
    .join('');

  return `
    ${shell(`
    <section class="card cl">
      <div class="card-head">
        <h2>${esc(cl.name)} Checklist</h2>
        <span class="badge ${isDone ? 'ok' : 'mute'}">${displayDone(cl)} / ${cl.items.length}</span>
      </div>
      <div class="cl-items">${items}</div>
      ${teamOnly ? `<p class="tiny">Completed on the other EFB${teamStatus.completed_by ? ` by ${esc(teamStatus.completed_by)}` : ''}.</p>` : ''}
      <div class="cl-foot ${isDone ? 'done' : ''}">
        <div class="cl-status">${isDone ? `${esc(cl.name).toUpperCase()} CHECKLIST COMPLETE` : 'Tap each item as it is called'}</div>
        ${
          next
            ? `<a class="btn ${isDone ? 'primary' : 'ghost'}" href="#/checklists/${next.id}">Next: ${esc(next.name)} ${icon('chevron')}</a>`
            : ''
        }
      </div>
    </section>
    <div class="btn-row">
      <button class="btn ghost" data-act="reset">Reset this checklist</button>
      <button class="btn ghost" data-act="resetAll">New flight: reset all</button>
    </div>
    ${editBar(cl)}`)}
    <p class="tiny center">Boeing 737NG checklists. For flight simulation use only.</p>`;
}

// Polls checklist_status every couple of seconds, but only while the
// Checklists page is actually open - the other EFB's completion then shows
// up in a couple of seconds instead of waiting on the ten-second team sync.
// Stops itself the moment the page is left, rather than running forever.
let statusPoll = null;
let polling = false;
function pollStatus() {
  if (!location.hash.startsWith('#/checklists')) {
    clearInterval(statusPoll);
    statusPoll = null;
    return;
  }
  if (polling || document.visibilityState !== 'visible') return;
  polling = true;
  const before = JSON.stringify(state.checklistStatus);
  syncChecklistStatus()
    .then((ok) => {
      if (ok && JSON.stringify(state.checklistStatus) !== before && location.hash.startsWith('#/checklists')) rerender();
    })
    .finally(() => (polling = false));
}

export function mounted(root, args = []) {
  if (!statusPoll) statusPoll = setInterval(pollStatus, 2000);
  // A redraw replaces every input, so the editor puts the cursor back where
  // the admin was working: in the row just added, or on the button that just
  // moved one, so it can be pressed again straight away.
  if (focusAfter) {
    const { i, what } = focusAfter;
    focusAfter = null;
    const row = root.querySelector(`[data-item][data-i="${i}"]`);
    const button = row?.querySelector(`[data-act="moveItem"][data-dir="${what === 'up' ? -1 : 1}"]`);
    const target = what === 'challenge' || !button || button.disabled ? row?.querySelector('[name="challenge"]') : button;
    target?.focus();
  }
  const block = args[1];
  if (block) requestAnimationFrame(() => requestAnimationFrame(() => focusBlock(block)));
  const library = root.querySelector('.qrh-library');
  if (library) {
    const selected = library.querySelector('.chip.on');
    if (selected) library.scrollTop = selected.offsetTop - library.offsetTop;
  } else root.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  root.querySelector('[data-qrh-search]')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    let count = 0;
    const byId = new Map(ofKind('non-normal').map((cl) => [cl.id, cl]));
    root.querySelectorAll('.chip').forEach((chip) => {
      const cl = byId.get(chip.dataset.checklistId);
      const match = `${cl.name} ${systemLabel(cl)} ${cl.section || ''} ${cl.condition || ''}`.toLowerCase().includes(query);
      chip.hidden = !match;
      if (match) count++;
    });
    root.querySelectorAll('.qrh-system').forEach((system) => {
      const matches = [...system.querySelectorAll('.chip')].filter((chip) => !chip.hidden).length;
      system.hidden = matches === 0;
      system.querySelector('[data-system-count]').textContent = matches;
      system.open = query ? matches > 0 : !!system.querySelector('.chip.on');
    });
    root.querySelector('[data-qrh-count]').textContent = count ? `${count} checklists` : 'No matching procedures';
  });
}

// Admins only, and normal checklists only. The database refuses anyone else
// (see set_normal_checklists), so these guards are about not offering what
// will not work rather than about keeping anyone out.
export const forms = {
  saveChecklist() {
    if (!draft || !checklistsEditable()) return;
    captureDraft();
    const name = draft.name.trim();
    // A row left completely blank is one the admin added and did not use, so
    // it is dropped rather than complained about.
    const items = draft.items
      .map(([challenge, response]) => [challenge.trim(), response.trim()])
      .filter(([challenge, response]) => challenge || response);
    const fail = (message) => {
      editError = message;
      rerender();
    };
    if (!name) return fail('Give the checklist a name.');
    if (!items.length) return fail('Give the checklist at least one item.');
    if (items.some(([challenge]) => !challenge)) {
      return fail('Every item needs a challenge. A response can be left blank if there is nothing to read back.');
    }

    const list = normalChecklists();
    const id = draft.isNew ? newChecklistId(name, new Set(allChecklists().map((cl) => cl.id))) : draft.id;
    const others = list.filter((cl) => cl.id !== id);
    // "Runs after" names the checklist it follows; nothing means it goes first.
    const after = draft.after ? others.findIndex((cl) => cl.id === draft.after) : -1;
    const at = draft.after ? (after < 0 ? others.length : after + 1) : 0;
    const next = [...others.slice(0, at), { id, name, items }, ...others.slice(at)];
    const wasNew = draft.isNew;

    return runEdit(async () => {
      await saveNormalChecklists(next);
      // Ticks are kept by item position, so once the wording moves they no
      // longer mean anything: the sync above drops this device's own (see
      // dropStaleChecklistTicks), and this clears the team's completion so
      // the other EFB is not told a checklist nobody has read is complete.
      if (!wasNew) syncCompletion({ id }, false);
      draft = null;
      editNotice = wasNew ? `${name} added for the whole team.` : `${name} saved for the whole team.`;
      location.hash = `#/checklists/${id}`;
    });
  },
};

export const actions = {
  editChecklist() {
    const { kind, cl } = active(location.hash.split('/').slice(2));
    if (!cl || kind !== 'normal' || !checklistsEditable()) return;
    const list = normalChecklists();
    const at = list.findIndex((c) => c.id === cl.id);
    draft = {
      id: cl.id,
      name: cl.name,
      items: cl.items.map(([challenge, response]) => [challenge, response]),
      after: at > 0 ? list[at - 1].id : '',
      isNew: false,
    };
    editError = '';
    rerender();
  },
  addChecklist() {
    if (!checklistsEditable()) return;
    // A new one starts at the end of the run, which is where most additions
    // belong; "Runs after" moves it if not.
    draft = { id: '', name: '', items: [['', '']], after: normalChecklists().at(-1)?.id || '', isNew: true };
    editError = '';
    focusAfter = null;
    rerender();
  },
  addItem() {
    if (!draft) return;
    captureDraft();
    draft.items.push(['', '']);
    focusAfter = { i: draft.items.length - 1, what: 'challenge' };
    rerender();
  },
  removeItem(el) {
    if (!draft) return;
    captureDraft();
    draft.items.splice(Number(el.dataset.i), 1);
    rerender();
  },
  moveItem(el) {
    if (!draft) return;
    captureDraft();
    const from = Number(el.dataset.i);
    const to = from + Number(el.dataset.dir);
    if (to < 0 || to >= draft.items.length) return;
    [draft.items[from], draft.items[to]] = [draft.items[to], draft.items[from]];
    focusAfter = { i: to, what: Number(el.dataset.dir) < 0 ? 'up' : 'down' };
    rerender();
  },
  cancelEdit() {
    draft = null;
    editError = '';
    rerender();
  },
  deleteChecklist() {
    const list = normalChecklists();
    if (!draft || draft.isNew || !checklistsEditable() || list.length < 2) return;
    if (!confirm(`Delete the ${draft.name} checklist for the whole team?`)) return;
    const gone = draft.id;
    const next = list.filter((cl) => cl.id !== gone);
    return runEdit(async () => {
      await saveNormalChecklists(next);
      // Its completion would otherwise sit in the team database forever,
      // and come back if an admin ever adds a checklist by the same name.
      syncCompletion({ id: gone }, false);
      delete state.checks[gone];
      save();
      draft = null;
      editNotice = 'Checklist deleted.';
      location.hash = `#/checklists/${next[0].id}`;
    });
  },
  toggle(el) {
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl || el.disabled) return;
    const was = localComplete(cl);
    const marks = (state.checks[cl.id] ??= cl.native ? {} : []);
    marks[Number(el.dataset.i)] = !marks[Number(el.dataset.i)];
    if (cl.native) {
      delete marks.branchComplete;
      const branch = branchState(cl).get(el.dataset.block);
      if (branch) (marks.choices ??= {})[branch.group] = branch.option;
    }
    save();
    if (!cl.native && localComplete(cl) !== was) syncCompletion(cl, !was);
    if (cl.native) updateNative(cl);
    else rerender();
  },
  chooseBranch(el) {
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl?.native) return;
    const group = branchGroups(cl).find((item) => item.id === el.dataset.group);
    if (!group?.options.some((option) => option.id === el.dataset.option)) return;
    const was = localComplete(cl);
    const marks = (state.checks[cl.id] ??= {});
    const choices = (marks.choices ??= {});
    if (choices[group.id] === el.dataset.option) delete choices[group.id];
    else choices[group.id] = el.dataset.option;
    delete marks.branchComplete;
    save();
    if (was) syncCompletion(cl, false);
    updateNative(cl);
  },
  follow(el) {
    if (el.disabled) return;
    const { cl } = active(location.hash.split('/').slice(2));
    const branch = branchState(cl).get(el.dataset.from);
    if (branch) {
      const was = localComplete(cl);
      const marks = (state.checks[cl.id] ??= {});
      (marks.choices ??= {})[branch.group] = branch.option;
      delete marks.branchComplete;
      save();
      if (was) syncCompletion(cl, false);
      updateNative(cl);
    }
    if (el.dataset.checklist === cl.id) {
      focusBlock(el.dataset.block);
      return;
    }
    trail.push({ id: cl.id, name: cl.name, block: el.dataset.from });
    location.hash = `#/checklists/${el.dataset.checklist}${el.dataset.block ? `/${el.dataset.block}` : ''}`;
  },
  returnChecklist() {
    const previous = trail.pop();
    if (previous) location.hash = `#/checklists/${previous.id}/${previous.block}`;
  },
  finishBranch(el) {
    if (el?.disabled) return;
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl.native) return;
    const marks = (state.checks[cl.id] ??= {});
    marks.branchComplete = true;
    save();
    syncCompletion(cl, true);
    updateNative(cl);
  },
  reset() {
    const { cl } = active(location.hash.split('/').slice(2));
    const was = cl && complete(cl);
    delete state.checks[cl?.id];
    if (was) syncCompletion(cl, false);
    save();
    if (cl?.native) updateNative(cl);
    else rerender();
  },
  resetAll() {
    if (!confirm('Reset every checklist for a new flight?')) return;
    // Clears the shared completion too - otherwise any checklist the other
    // EFB had finished (or this one, before this device last synced) kept
    // showing as done, since complete() also reads the cached team status.
    for (const cl of allChecklists()) {
      if (complete(cl)) syncCompletion(cl, false);
    }
    state.checks = {};
    trail.length = 0;
    save();
    location.hash = `#/checklists/${normalChecklists()[0].id}`;
    rerender();
  },
};
