import { esc, rerender } from '../ui.js';
import { canUseVpilot, isEfb } from '../ops.js';
import { gsxPicture, gsxOnline, watchGsx, gsxCommand } from '../gsx.js';

let unwatch = null;
let signature = '';
let busy = false;
let error = '';
let note = '';
const allowed = () => isEfb() && canUseVpilot();
const readable = (v) => {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(readable).filter(Boolean).join(' · ');
  return Object.entries(v).filter(([k]) => !/html|icon|svg/i.test(k))
    .map(([k, x]) => `${k}: ${readable(x)}`).join(' · ');
};

export function render() {
  if (!allowed()) return '<section class="card"><div class="card-head"><h2>GSX</h2></div><p class="note">GSX is available to the flight deck on an EFB device.</p></section>';
  const { row, fault } = gsxPicture();
  const live = gsxOnline();
  const s = row?.state || {};
  const disabled = !live || busy ? 'disabled' : '';
  const entries = Array.isArray(s.menu?.entries) ? s.menu.entries : [];
  const services = Object.entries(s.services || {});
  return `<div class="gsx-page">
    <section class="card"><div class="card-head"><h2>GSX Ground Services</h2><span class="badge">${live ? 'Connected' : 'Disconnected'}</span></div>
      <p class="note">${esc(live ? 'Live GSX menu and turnaround status' : fault || row?.trouble || 'Waiting for the bridge. Enable the Remote control server in GSX Settings.')}</p>
      ${error ? `<p class="gsx-error" role="alert">${esc(error)}</p>` : ''}
      ${note ? `<p class="note" role="status">${esc(note)}</p>` : ''}
      <div class="btn-row"><button class="btn" data-act="open" ${disabled}>Open GSX menu</button>
      <button class="btn" data-act="close" ${disabled}>Close menu</button>
      <button class="btn" data-act="simbrief" ${disabled}>Reload SimBrief</button></div>
    </section>
    <section class="card"><div class="card-head"><h3>${esc(s.menu?.title || 'Services')}</h3></div>
      ${s.message ? `<p class="note">${esc(readable(s.message))}</p>` : ''}
      <div class="gsx-menu">${live && s.menuShown ? entries.map((label, index) => label == null || label === '' ? '' :
        `<button class="btn gsx-option" data-act="pick" data-index="${index}" data-token="${esc(s.menuToken)}" ${disabled || (s.menu.disabled?.[index] ? 'disabled' : '')}>${esc(label)}</button>`).join('') :
        '<p class="note">Open the GSX menu to request boarding, deboarding, catering, fuel or pushback. Follow the choices GSX offers for this aircraft and stand.</p>'}</div>
      ${s.prompt ? `<p class="note">GSX is asking for text: ${esc(s.prompt.title)}. Complete this prompt in the simulator.</p>` : ''}
    </section>
    ${live && services.length ? `<section class="card"><div class="card-head"><h3>Turnaround status</h3></div><dl class="gsx-services">${services.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(readable(value))}</dd></div>`).join('')}</dl></section>` : ''}
    ${live && s.simbrief ? `<section class="card"><div class="card-head"><h3>SimBrief</h3></div><p class="note">${esc(readable(s.simbrief))}</p></section>` : ''}
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
  if (!location.hash.startsWith('#/gsx')) { unwatch?.(); unwatch = null; error = ''; note = ''; }
});
async function send(type, args) {
  if (!allowed() || busy) return;
  busy = true; error = ''; note = ''; rerender();
  try {
    const result = await gsxCommand(type, args);
    if (!result.ok) error = result.error || 'GSX refused the command.';
    else note = 'GSX accepted the command.';
  } finally { busy = false; rerender(); }
}
export const actions = {
  open: () => send('gsx-menu-open'),
  close: () => send('gsx-menu-close'),
  simbrief: () => send('gsx-simbrief'),
  pick: (el) => send('gsx-menu-pick', { index: Number(el.dataset.index), menuToken: el.dataset.token }),
};
