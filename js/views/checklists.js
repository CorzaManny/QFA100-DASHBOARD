// Interactive 737 checklists. Works fully offline; progress is saved on the device.

import { state, save } from '../store.js';
import { esc, icon, rerender } from '../ui.js';
import { CHECKLISTS, CHECKLIST_KINDS } from '../data/checklists.js';

const done = (cl) => cl.items.filter((_, i) => state.checks[cl.id]?.[i]).length;
const complete = (cl) => cl.native ? !!state.checks[cl.id]?.branchComplete : done(cl) === cl.items.length;
let pendingBlock = null;
const trail = [];

function focusBlock(id) {
  const target = document.getElementById(`qrh-${id}`);
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target?.focus({ preventScroll: true });
}
const ofKind = (kind) => CHECKLISTS.filter((cl) => (cl.kind || 'normal') === kind);

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

  const chips = group
    .map(
      (c) => `<a class="chip ${c === cl ? 'on' : ''} ${complete(c) ? 'done' : ''}" href="#/checklists/${c.id}">
      <span class="chip-t">${complete(c) ? icon('check') : ''}${esc(c.name)}</span>
      <span class="chip-n">${done(c)} / ${c.items.length}</span></a>`,
    )
    .join('');

  const shell = (body) => `
    <nav class="seg tabs4 on-card" aria-label="Kind of checklist">${kinds}</nav>
    ${kind === 'non-normal' ? `<label class="qrh-search">Find a non-normal checklist
      <input type="search" data-qrh-search placeholder="Search title, system or condition…" autocomplete="off">
      <span class="tiny" data-qrh-count>${group.length} checklists</span>
    </label>` : ''}
    <div class="cl-layout ${chips ? '' : 'solo'} ${kind === 'non-normal' ? 'qrh-layout' : ''}">
      ${chips ? `<nav class="chip-row" aria-label="Checklists">${chips}</nav>` : ''}
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
    const blocks = cl.blocks.map((block) => {
      const index = block.type === 'action' ? actionIndex++ : null;
      const on = index !== null && !!state.checks[cl.id]?.[index];
      const label = block.number !== null ? `<span class="qrh-number">${esc(block.number)}</span>` : '';
      const content = block.type === 'action'
        ? `<button class="qrh-check ${on ? 'on' : ''}" data-act="toggle" data-i="${index}" data-block="${block.id}" aria-pressed="${on}">
          <span class="cl-box">${on ? icon('check') : ''}</span>${label}<span>${esc(block.text)}</span>
        </button>`
        : `<div class="qrh-text">${label}<span>${esc(block.text)}</span></div>`;
      const links = block.links.map((link) => `<button class="btn ghost" data-act="follow" data-checklist="qrh-${esc(link.checklist)}" data-block="${esc(link.block || '')}" data-from="${block.id}">${esc(link.label)} ${icon('chevron')}</button>`).join('');
      return `<div id="qrh-${block.id}" tabindex="-1" class="qrh-block qrh-${block.type}" style="--qrh-indent:${block.indent || 0}">
        ${content}${links ? `<div class="qrh-links">${links}</div>` : ''}
        ${block.type === 'end' ? `<button class="btn ghost" data-act="finishBranch">Mark this branch complete</button>` : ''}
      </div>`;
    }).join('');
    const back = trail.at(-1);
    return shell(`<section class="card cl">
      <div class="card-head"><h2>${esc(cl.name)}</h2><span class="badge ${complete(cl) ? 'ok' : 'mute'}">${complete(cl) ? 'Branch complete' : `${done(cl)} items checked`}</span></div>
      <p class="tiny">${esc(cl.section)} · For flight simulation only. Extracted text requires review.</p>
      ${back ? `<button class="btn ghost" data-act="returnChecklist">Return to ${esc(back.name)}</button>` : ''}
      <p class="note">Choose the applicable branch. Tap actions to check them off; use the links to move to a step or another checklist. Progress is saved on this device.</p>
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
  const block = pendingBlock || args[1];
  pendingBlock = null;
  if (block) requestAnimationFrame(() => requestAnimationFrame(() => focusBlock(block)));
  root.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  root.querySelector('[data-qrh-search]')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    let count = 0;
    root.querySelectorAll('.chip').forEach((chip, i) => {
      const cl = ofKind('non-normal')[i];
      const match = `${cl.name} ${cl.section || ''} ${cl.condition || ''}`.toLowerCase().includes(query);
      chip.hidden = !match;
      if (match) count++;
    });
    root.querySelector('[data-qrh-count]').textContent = count ? `${count} checklists` : 'No matching procedures';
  });
}

export const actions = {
  toggle(el) {
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl) return;
    const marks = (state.checks[cl.id] ??= cl.native ? {} : []);
    marks[Number(el.dataset.i)] = !marks[Number(el.dataset.i)];
    if (cl.native) {
      delete marks.branchComplete;
      pendingBlock = el.dataset.block;
    }
    save();
    rerender();
  },
  follow(el) {
    const { cl } = active(location.hash.split('/').slice(2));
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
  finishBranch() {
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl.native) return;
    const marks = (state.checks[cl.id] ??= {});
    marks.branchComplete = true;
    save();
    rerender();
  },
  reset() {
    delete state.checks[active(location.hash.split('/').slice(2)).cl?.id];
    save();
    rerender();
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
