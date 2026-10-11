// App shell: sign-in gate, hash routing, event delegation, clock, screen wake lock.

import { zulu } from './ui.js';
import { state } from './store.js';
import { configured, getSession } from './api.js';
import { loadAirports, syncTeam, canEdit } from './ops.js';
import * as login from './views/login.js';
import * as roster from './views/roster.js';
import * as admin from './views/admin.js';
import * as dash from './views/dash.js';
import * as checklists from './views/checklists.js';
import * as schedule from './views/schedule.js';
import * as techlog from './views/techlog.js';
import * as airports from './views/airports.js';
import * as dispatch from './views/dispatch.js';
import * as settings from './views/settings.js';

const ROUTES = { dashboard: dash, checklists, schedule, roster, techlog, airports, dispatch, settings, admin };
const root = document.getElementById('view');
const clock = document.getElementById('clock');
let route = { name: 'dashboard', args: [], view: dash };

function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function parse() {
  const [name, ...args] = location.hash.replace(/^#\/?/, '').split('/').map(safeDecode);
  const key = ROUTES[name] ? name : 'dashboard';
  return { name: key, args, view: ROUTES[key] };
}

// With a database connected everyone signs in first. Without one, the login
// page explains that and offers a preview on this device.
const locked = () => (configured ? !getSession() : !state.preview);

function render() {
  const gate = locked();
  document.body.classList.toggle('locked', gate);
  document.body.classList.toggle('editor', !gate && canEdit());
  route = gate ? { name: 'login', args: [], view: login } : parse();
  root.innerHTML = route.view.render(route.args);
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.classList.toggle('on', tab.dataset.tab === route.name);
  }
  route.view.mounted?.(root, route.args);
  wakeLock();
}

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) route.view.actions?.[el.dataset.act]?.(el, e);
});

root.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) route.view.changes?.[el.dataset.change]?.(el, e);
});

root.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  route.view.forms?.[form.dataset.form]?.(new FormData(form), form);
});

window.addEventListener('app:render', render);
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

// Keep the screen on while a checklist is open.
let lock = null;
async function wakeLock() {
  const want = route.name === 'checklists' && document.visibilityState === 'visible';
  if (want && !lock && navigator.wakeLock) {
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch {
      // not allowed right now (e.g. low battery); carry on without it
    }
  } else if (!want && lock) {
    lock.release();
  }
}

function tick() {
  const now = Date.now();
  clock.textContent = zulu(now);
  for (const el of root.querySelectorAll('[data-until]')) {
    el.textContent = dash.countdown(el.dataset.until, now, el.dataset.verb);
  }
}

setInterval(tick, 1000);
setInterval(() => {
  if (route.name === 'dashboard' && !locked() && document.visibilityState === 'visible') dash.poll();
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  wakeLock();
  sync();
  if (route.name === 'dashboard') dash.poll();
});

// Don't redraw underneath someone who has already started typing.
const quietRender = () => {
  if (!root.querySelector('form:focus-within, select:focus')) render();
};

// Keep the schedule and roster in step with the team database.
async function sync() {
  if (locked() || document.visibilityState !== 'visible') return;
  await syncTeam();
  // A sign-in that has ended sends the user back to the login page.
  if (locked()) render();
  else quietRender();
}

render();
tick();
loadAirports().then(quietRender);
sync();
setInterval(sync, 2 * 60000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
