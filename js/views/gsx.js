import { esc, rerender } from '../ui.js';
import { canUseVpilot, isEfb } from '../ops.js';
import { gsxPicture, gsxOnline, watchGsx, gsxCommand, syncGsx } from '../gsx.js';
import { SERVICES, serviceChoice } from '../gsx-services.js';

let unwatch = null;
let signature = '';
let busy = false;
let error = '';
let note = '';
let showChoices = false;
const allowed = () => isEfb() && canUseVpilot();

export function render() {
  if (!allowed()) return '<section class="card"><div class="card-head"><h2>GSX</h2></div><p class="note">GSX is available to the flight deck on an EFB device.</p></section>';
  const live = gsxOnline();
  const s = gsxPicture().row?.state || {};
  const disabled = !live || busy ? 'disabled' : '';
  const entries = Array.isArray(s.menu?.entries) ? s.menu.entries : [];
  return `<div class="gsx-page">
    <section class="card gsx-header"><div class="card-head"><div><div class="tiny">GROUND OPERATIONS</div><h2>At your service</h2></div><span class="badge ${live ? 'ok' : 'mute'}">${live ? 'Connected' : 'Offline'}</span></div>
      <p class="note">${live ? 'Your next turnaround starts here. Choose a service below.' : 'Connect GSX on the simulator PC to request ground services.'}</p>
      ${error ? `<p class="gsx-error" role="alert">${esc(error)}</p>` : ''}
      ${note ? `<p class="note" role="status">${esc(note)}</p>` : ''}
    </section>
    <div class="gsx-service-grid">${SERVICES.map(service => `<button class="gsx-service-card" data-act="service" data-service="${service.id}" ${disabled}>
      <span class="gsx-art gsx-art-${service.id}"><svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="50" cy="50" r="43" fill="currentColor" opacity=".06" stroke="none"/><path d="${service.art}"/></svg></span>
      <span class="gsx-service-copy"><strong>${service.label}</strong><span>${service.detail}</span></span><span class="gsx-service-arrow" aria-hidden="true">?</span>
    </button>`).join('')}</div>
    ${showChoices && live && s.menuShown ? `<section class="card"><div class="card-head"><h3>${esc(s.menu?.title || 'Choose an option')}</h3></div>
      <div class="gsx-menu">${entries.map((label, index) => typeof label !== 'string' || !label.trim() ? '' :
        `<button class="btn gsx-option" data-act="pick" data-index="${index}" data-token="${esc(s.menuToken)}" ${disabled || (s.menu.disabled?.[index] ? 'disabled' : '')}>${esc(label)}</button>`).join('')}</div>
      ${s.prompt ? '<p class="note">Complete the text entry in the simulator to continue.</p>' : ''}
    </section>` : ''}
    <section class="card"><div class="btn-row"><button class="btn ghost" data-act="open" ${disabled}>More GSX options</button>
      <button class="btn ghost" data-act="simbrief" ${disabled}>Reload SimBrief</button>
      ${showChoices ? `<button class="btn ghost" data-act="close" ${disabled}>Close options</button>` : ''}</div></section>
  </div>`;
}
export function mounted() {
  if (!allowed() || unwatch) return;
  unwatch = watchGsx(() => {
    const next = JSON.stringify([gsxPicture(), gsxOnline()]);
    if (next !== signature) { signature = next; rerender(); }
  });
}
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/gsx')) { unwatch?.(); unwatch = null; error = ''; note = ''; showChoices = false; }
});
async function checked(type, args) {
  const result = await gsxCommand(type, args);
  if (!result.ok) throw new Error(result.error || 'GSX could not complete the request.');
}
async function perform(work) {
  if (!allowed() || busy || !gsxOnline()) return;
  busy = true; error = ''; note = ''; rerender();
  try { await work(); }
  catch (e) { error = e.message; }
  finally { busy = false; rerender(); }
}
async function requestService(id) {
  const service = SERVICES.find(s => s.id === id);
  if (!service) return;
  return perform(async () => {
    showChoices = false;
    note = `Requesting ${service.label.toLowerCase()}…`;
    await checked('gsx-menu-open');
    // The command result can arrive before the next two-second GSX snapshot.
    const until = Date.now() + 6500;
    let choice = null;
    do {
      await syncGsx();
      choice = serviceChoice(gsxPicture().row?.state, service);
      if (choice) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < until && gsxOnline());
    if (!choice || choice.disabled) {
      showChoices = true;
      note = '';
      throw new Error(`${service.label} is not currently offered by GSX. Check the available options below.`);
    }
    await checked('gsx-menu-pick', { index: choice.index, menuToken: choice.menuToken });
    showChoices = true;
    note = `${service.label} requested. If GSX needs another choice, select it below.`;
    await syncGsx();
  });
}
export const actions = {
  service: el => requestService(el.dataset.service),
  open: () => perform(async () => { await checked('gsx-menu-open'); showChoices = true; await syncGsx(); }),
  close: () => perform(async () => { await checked('gsx-menu-close'); showChoices = false; }),
  simbrief: () => perform(async () => { await checked('gsx-simbrief'); note = 'SimBrief reload requested.'; }),
  pick: el => perform(async () => {
    await checked('gsx-menu-pick', { index: Number(el.dataset.index), menuToken: el.dataset.token });
    note = 'Selection sent to GSX.';
    await syncGsx();
  }),
};
