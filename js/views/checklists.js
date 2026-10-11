// Interactive 737 checklists. Works fully offline; progress is saved on the device.

import { state, save } from '../store.js';
import { esc, icon, rerender } from '../ui.js';
import { CHECKLISTS } from '../data/checklists.js';

const done = (cl) => cl.items.filter((_, i) => state.checks[cl.id]?.[i]).length;
const complete = (cl) => done(cl) === cl.items.length;

export function nextIncomplete() {
  return CHECKLISTS.find((cl) => !complete(cl)) || null;
}

function active(args) {
  return CHECKLISTS.find((cl) => cl.id === args[0]) || nextIncomplete() || CHECKLISTS[0];
}

export function render(args) {
  const cl = active(args);
  const idx = CHECKLISTS.indexOf(cl);
  const next = CHECKLISTS[idx + 1];
  const isDone = complete(cl);

  const chips = CHECKLISTS.map(
    (c) => `<a class="chip ${c === cl ? 'on' : ''} ${complete(c) ? 'done' : ''}" href="#/checklists/${c.id}">
      ${complete(c) ? icon('check') : ''}${esc(c.name)}</a>`,
  ).join('');

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
    <nav class="chip-row" aria-label="Checklists">${chips}</nav>
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
    </div>
    <p class="tiny center">Boeing 737NG normal checklists. For flight simulation use only.</p>`;
}

export function mounted(root) {
  root.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

export const actions = {
  toggle(el) {
    const cl = active(location.hash.split('/').slice(2));
    const marks = (state.checks[cl.id] ??= []);
    marks[Number(el.dataset.i)] = !marks[Number(el.dataset.i)];
    save();
    rerender();
  },
  reset() {
    delete state.checks[active(location.hash.split('/').slice(2)).id];
    save();
    rerender();
  },
  resetAll() {
    if (!confirm('Reset every checklist for a new flight?')) return;
    state.checks = {};
    save();
    location.hash = `#/checklists/${CHECKLISTS[0].id}`;
    rerender();
  },
};
