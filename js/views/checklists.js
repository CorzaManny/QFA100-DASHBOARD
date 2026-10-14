// Interactive 737 checklists. Works fully offline; progress is saved on the device.

import { state, save } from '../store.js';
import { esc, icon, rerender } from '../ui.js';
import { CHECKLISTS, CHECKLIST_KINDS, NON_NORMAL_QRH } from '../data/checklists.js';

const done = (cl) => cl.items.filter((_, i) => state.checks[cl.id]?.[i]).length;
const complete = (cl) => !cl.referenceOnly && done(cl) === cl.items.length;
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
      <span class="chip-n">${c.referenceOnly ? 'Draft' : `${done(c)} / ${c.items.length}`}</span></a>`,
    )
    .join('');

  const shell = (body) => `
    <nav class="seg tabs4 on-card" aria-label="Kind of checklist">${kinds}</nav>
    ${kind === 'non-normal' ? `<label class="qrh-search">Find a non-normal checklist
      <input type="search" data-qrh-search placeholder="Search title or condition…" autocomplete="off">
      <span class="tiny" data-qrh-count>${group.length} procedures · review draft</span>
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

  if (cl.referenceOnly) {
    const pages = cl.source_page_text.map((page) => `<details class="qrh-source">
      <summary>Source text · PDF page ${esc(page.pdf_page)}${page.printed_page ? ` · ${esc(page.printed_page)}` : ''}</summary>
      <pre class="metar">${esc(page.text)}</pre>
    </details>`).join('');
    const steps = cl.steps.map((step) => `<li class="qrh-step">
      <div class="qrh-step-head"><strong>Step ${esc(step.number)}</strong><span class="tiny">PDF p. ${esc(step.source_pdf_page)} · Unverified</span></div>
      <p>${esc(step.raw_text)}</p>
      ${step.flags.length ? `<span class="tiny">Review flags: ${step.flags.map((flag) => esc(flag.replaceAll('_', ' '))).join(' · ')}</span>` : ''}
    </li>`).join('');
    return shell(`<section class="card cl">
      <div class="card-head"><h2>${esc(cl.name)}</h2><span class="badge mute">Review draft</span></div>
      <p class="note qrh-notice">Unverified extraction · simulation/reference only. Step order, completeness, notes and decision paths require manual review. No automatic branching or completion tracking.</p>
      ${cl.condition ? `<p class="qrh-condition">${esc(cl.condition)}</p>` : ''}
      <p class="tiny">${esc(NON_NORMAL_QRH.source.title)} · ${esc(NON_NORMAL_QRH.source.document_id)} · PDF pages ${cl.source_pages.map(esc).join(', ')}</p>
      <ol class="qrh-steps">${steps || '<li>No steps extracted. Consult the source text below.</li>'}</ol>
      <h3>Source page text</h3>
      <p class="tiny">Retained extraction includes notes and decision text that may be missing from the steps. Compare with the original PDF images when reviewing.</p>
      ${pages}
      <p class="tiny">${esc(NON_NORMAL_QRH.source.source_notice)}</p>
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

export function mounted(root) {
  root.querySelector('.chip.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  root.querySelector('[data-qrh-search]')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    let count = 0;
    root.querySelectorAll('.chip').forEach((chip, i) => {
      const cl = ofKind('non-normal')[i];
      const match = `${cl.name} ${cl.condition || ''}`.toLowerCase().includes(query);
      chip.hidden = !match;
      if (match) count++;
    });
    root.querySelector('[data-qrh-count]').textContent = count ? `${count} procedures · review draft` : 'No matching procedures';
  });
}

export const actions = {
  toggle(el) {
    const { cl } = active(location.hash.split('/').slice(2));
    if (!cl || cl.referenceOnly) return;
    const marks = (state.checks[cl.id] ??= []);
    marks[Number(el.dataset.i)] = !marks[Number(el.dataset.i)];
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
    save();
    location.hash = `#/checklists/${CHECKLISTS[0].id}`;
    rerender();
  },
};
