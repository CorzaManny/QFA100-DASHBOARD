// The door. Everything that changed on this person's roster, and nothing else
// on screen until they have said they have read it.
//
// A pilot reads the roster once and then flies the day from memory, so a
// change nobody acknowledged is worse than no roster at all. The app will not
// go anywhere else while one is waiting: see locked() in js/app.js, which puts
// this page up in place of whatever the address bar asks for. It covers
// changes they caused themselves too - taking somebody's sector in a swap is
// exactly the moment a day is in somebody's head wrong.
//
// Ops staff are never held here. They see the same list on the Ops board, with
// everybody else's, and confirm their own from there; locking the desk out of
// the board it works would make a bad day worse.

import { esc, ago, icon, rerender } from '../ui.js';
import { myChanges, confirmMyChanges, me } from '../ops.js';

let busy = false;
let error = '';

// A word for each kind, so the list reads as a list of things rather than a
// list of sentences. The headline from the database says the rest.
const KINDS = {
  added: ['ADDED', 'bad'],
  removed: ['TAKEN OFF', 'warn'],
  duty: ['NEW SEAT', 'warn'],
  report: ['REPORT TIME', 'warn'],
  sector: ['SECTOR MOVED', 'warn'],
};

function change(c) {
  const [label, kind] = KINDS[c.kind] || ['CHANGED', 'warn'];
  return `
    <div class="row">
      <div class="row-main">
        <div class="row-t">${esc(c.headline)} <span class="badge ${kind}">${label}</span></div>
        ${c.detail ? `<div class="sub">${esc(c.detail)}</div>` : ''}
        <div class="tiny">${c.by_name ? `${esc(c.by_name)} · ` : ''}${ago(new Date(c.created_at).getTime())}</div>
      </div>
    </div>`;
}

export function render() {
  const list = myChanges();
  const one = list.length === 1;
  return `
    <div class="confirm">
      <div class="page-head"><h1>Your roster has changed</h1>
        <span class="badge warn">${list.length} ${one ? 'CHANGE' : 'CHANGES'}</span></div>
      <section class="card list">
        <p class="note warn">${icon('alert')} Read ${
          one ? 'this' : 'these'
        } before you carry on. The rest of the app is waiting on it.</p>
        ${list.map(change).join('')}
        ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
        <div class="btn-row">
          <button class="btn primary" type="button" data-act="confirm" ${busy ? 'disabled' : ''}>${
            busy ? 'Confirming…' : `I have read ${one ? 'this' : 'all of this'}`
          }</button>
        </div>
        <p class="tiny">Confirming is recorded, so the ops desk can see you know. Anything that changes after this asks you again.</p>
      </section>
      <p class="tiny center">Signed in as ${esc(
        me()?.display_name || '',
      )}. If any of this looks wrong, confirm it and then call the ops desk.</p>
    </div>`;
}

export const actions = {
  async confirm() {
    if (busy) return;
    busy = true;
    error = '';
    rerender();
    try {
      await confirmMyChanges();
    } catch (err) {
      error = err.message;
    }
    busy = false;
    rerender();
  },
};
