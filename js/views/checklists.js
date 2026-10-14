// Interactive 737 checklists. Works fully offline; progress is saved on the device.

import { state, save } from '../store.js';
import { esc, icon, rerender } from '../ui.js';
import { CHECKLISTS, CHECKLIST_KINDS } from '../data/checklists.js';

const done = (cl) => cl.items.filter((_, i) => state.checks[cl.id]?.[cl.progressKeys?.[i] ?? i]).length;
const complete = (cl) => cl.native ? !!state.checks[cl.id]?.branchComplete : done(cl) === cl.items.length;
const trail = [];

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
    chip.querySelector('.chip-n').textContent = `${done(cl)} / ${cl.items.length}`;
  }
}

function focusBlock(id) {
  const target = document.getElementById(`qrh-${id}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target?.focus({ preventScroll: true });
}
const ofKind = (kind) => CHECKLISTS.filter((cl) => (cl.kind || 'normal') === kind);

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
  const cl = CHECKLISTS.find((c) => c.id === args[0]) || nextIncomplete() || CHECKLISTS[0];
  return { kind: cl?.kind || 'normal', cl: cl || null };
}

export function render(args) {
  const { kind, cl } = active(args);
  const group = ofKind(kind);

  const kinds = CHECKLIST_KINDS.map(([key, label]) => {
    const first = ofKind(key)[0];
    const href = first ? `#/checklists/${first.id}` : `#/checklists/kind/${key}`;
    return `<a class="${key === kind ? 'on' : ''}" href="${href}">${esc(label)}</a>`;
  }).join('');

  const chip = (c) => `<a class="chip ${c === cl ? 'on' : ''} ${complete(c) ? 'done' : ''}" data-checklist-id="${esc(c.id)}" href="#/checklists/${c.id}" ${c === cl ? 'aria-current="page"' : ''}>
      <span class="chip-t">${esc(c.name)}</span>
      <span class="chip-n">${done(c)} / ${c.items.length}</span></a>`;
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
    ${kind === 'non-normal' ? `<label class="qrh-search">Find a non-normal checklist
      <input type="search" data-qrh-search placeholder="Search title, system or condition…" autocomplete="off">
      <span class="tiny" data-qrh-count>${group.length} checklists</span>
    </label>` : ''}
    <div class="cl-layout ${chips ? '' : 'solo'} ${kind === 'non-normal' ? 'qrh-layout' : ''}">
      ${chips ? library : ''}
      <div class="cl-main">${body}</div>
    </div>`;

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

  const idx = group.indexOf(cl);
  const next = group[idx + 1];
  const isDone = complete(cl);

  const items = cl.items
    .map(([challenge, response], i) => {
      const on = !!state.checks[cl.id]?.[i];
      return `<button class="cl-item ${on ? 'on' : ''}" data-act="toggle" data-i="${i}" aria-pressed="${on}">
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
        <span class="badge ${isDone ? 'ok' : 'mute'}">${done(cl)} / ${cl.items.length}</span>
      </div>
      <div class="cl-items">${items}</div>
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
    </div>`)}
    <p class="tiny center">Boeing 737NG checklists. For flight simulation use only.</p>`;
}

export function mounted(root, args = []) {
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

export const actions = {
  toggle(el) {
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl || el.disabled) return;
    const marks = (state.checks[cl.id] ??= cl.native ? {} : []);
    marks[Number(el.dataset.i)] = !marks[Number(el.dataset.i)];
    if (cl.native) {
      delete marks.branchComplete;
      const branch = branchState(cl).get(el.dataset.block);
      if (branch) (marks.choices ??= {})[branch.group] = branch.option;
    }
    save();
    if (cl.native) updateNative(cl);
    else rerender();
  },
  chooseBranch(el) {
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl?.native) return;
    const group = branchGroups(cl).find((item) => item.id === el.dataset.group);
    if (!group?.options.some((option) => option.id === el.dataset.option)) return;
    const marks = (state.checks[cl.id] ??= {});
    const choices = (marks.choices ??= {});
    if (choices[group.id] === el.dataset.option) delete choices[group.id];
    else choices[group.id] = el.dataset.option;
    delete marks.branchComplete;
    save();
    updateNative(cl);
  },
  follow(el) {
    if (el.disabled) return;
    const { cl } = active(location.hash.split('/').slice(2));
    const branch = branchState(cl).get(el.dataset.from);
    if (branch) {
      const marks = (state.checks[cl.id] ??= {});
      (marks.choices ??= {})[branch.group] = branch.option;
      delete marks.branchComplete;
      save();
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
    updateNative(cl);
  },
  reset() {
    const { cl } = active(location.hash.split('/').slice(2));
    delete state.checks[cl?.id];
    save();
    if (cl?.native) updateNative(cl);
    else rerender();
  },
  resetAll() {
    if (!confirm('Reset every checklist for a new flight?')) return;
    state.checks = {};
    trail.length = 0;
    save();
    location.hash = `#/checklists/${CHECKLISTS[0].id}`;
    rerender();
  },
};
