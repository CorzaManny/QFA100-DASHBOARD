// App shell: sign-in gate, hash routing, event delegation, clock, screen wake lock.

import { zulu, simClock } from './ui.js';
import { state } from './store.js';
import { configured, getSession, useEmailLink, signOut } from './api.js';
import { loadAirports, syncTeam, canEdit, isPending, needsSetup, isEfb, isOps, me, clearTeam, roleName } from './ops.js';
import * as login from './views/login.js';
import * as roster from './views/roster.js';
import * as admin from './views/admin.js';
import * as availability from './views/availability.js';
import * as dash from './views/dash.js';
import * as checklists from './views/checklists.js';
import * as schedule from './views/schedule.js';
import * as techlog from './views/techlog.js';
import * as airports from './views/airports.js';
import * as brief from './views/brief.js';
import * as settings from './views/settings.js';
import * as progress from './views/progress.js';
import * as opsboard from './views/ops.js';
import * as stream from './views/stream.js';
import * as liveroster from './views/liveroster.js';

const ROUTES = { dashboard: dash, checklists, schedule, roster, techlog, airports, brief, dispatch: brief, settings, admin, availability, progress, ops: opsboard, stream, liveroster };
const root = document.getElementById('view');
const clock = document.getElementById('clock');
const clockSim = document.getElementById('clock-sim');
const brand = document.querySelector('.brand .tiny');
const whoBtn = document.getElementById('who-btn');
const whoMenu = document.getElementById('who-menu');

// Initials for the avatar: first name and surname, or the first two letters
// of a single name.
function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '··';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words.at(-1)[0]).toUpperCase();
}

const closeMenu = () => {
  whoMenu.hidden = true;
  whoBtn.setAttribute('aria-expanded', 'false');
};

whoBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = whoMenu.hidden;
  whoMenu.hidden = !open;
  whoBtn.setAttribute('aria-expanded', String(open));
});
// Anywhere else, and the menu is done with.
document.addEventListener('click', (e) => {
  if (!whoMenu.hidden && !e.target.closest('.who')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
document.getElementById('who-out').addEventListener('click', async () => {
  closeMenu();
  if (!confirm('Sign out of QFA100 Ops on this device?')) return;
  await signOut();
  clearTeam();
  location.hash = '#/dashboard';
  render();
});
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
  // A cockpit tablet has no availability of its own.
  const key = ROUTES[name] && !(name === 'availability' && (isEfb() || isOps())) ? name : 'dashboard';
  return { name: key, args, view: ROUTES[key] };
}

// With a database connected everyone signs in first. Without one, the login
// page explains that and offers a preview on this device.
// Signed-in accounts still waiting for an admin's approval stay on that page too.
// Someone choosing a new password from a reset email stays there until it is done.
const locked = () =>
  login.resetting() || (configured ? !getSession() || isPending() || needsSetup() : !state.preview);

function render() {
  const gate = locked();
  document.body.classList.toggle('locked', gate);
  document.body.classList.toggle('editor', !gate && canEdit());
  document.body.classList.toggle('efb', !gate && isEfb());
  // A tablet says so, and which of the two it is, so nobody mistakes one for
  // their own device.
  brand.textContent =
    !gate && isEfb()
      ? `FLIGHT DECK · ${(me()?.display_name || 'TABLET').toUpperCase()}`
      : 'WORLDFLIGHT · 737 OPERATIONS';
  // The avatar says who is signed in; the menu holds the two places that are
  // theirs rather than the team's.
  closeMenu();
  const who = gate ? null : me();
  document.getElementById('who-initials').textContent = initials(who?.display_name);
  document.getElementById('who-name').textContent = who?.display_name || '';
  document.getElementById('who-role').textContent = who ? roleName(who.role).toUpperCase() : '';
  document.getElementById('who-admin').hidden = gate || !canEdit();
  route = gate ? { name: 'login', args: [], view: login } : parse();
  root.innerHTML = route.view.render(route.args);
  for (const tab of document.querySelectorAll('.tabs a[data-tab]')) {
    tab.classList.toggle('on', tab.dataset.tab === (route.name === 'airports' ? 'brief' : route.name));
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
  clockSim.textContent = simClock(now);
  for (const el of root.querySelectorAll('[data-until]')) {
    el.textContent = dash.countdown(el.dataset.until, now, el.dataset.verb);
  }
}

setInterval(tick, 1000);
setInterval(() => {
  if (['dashboard', 'ops', 'liveroster'].includes(route.name) && !locked() && document.visibilityState === 'visible') dash.poll();
}, 15000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  wakeLock();
  sync();
  if (['dashboard', 'ops', 'liveroster'].includes(route.name)) dash.poll();
});

// True when a form on the page holds something that has not been saved.
function unsaved() {
  for (const el of root.querySelectorAll('form input, form textarea, form select')) {
    if (el.type === 'hidden' || el.type === 'file') continue;
    if (el.type === 'checkbox' || el.type === 'radio') {
      if (el.checked !== el.defaultChecked) return true;
    } else if (el.tagName === 'SELECT') {
      // With no option marked as chosen, a drop-down starts on its first one.
      const start = Math.max(0, [...el.options].findIndex((o) => o.defaultSelected));
      if (el.selectedIndex !== start) return true;
    } else if (el.value !== el.defaultValue) return true;
  }
  return false;
}

// Don't redraw underneath someone who is typing or has unsaved changes.
const quietRender = () => {
  if (!root.querySelector('form:focus-within, select:focus') && !unsaved()) render();
};

// Everything that comes from the team database, to tell whether a sync changed anything.
const teamData = () =>
  JSON.stringify([
    state.sectors, state.roster, state.people, state.settings, state.prefs, state.defects, state.history, state.briefings,
    state.actuals, state.swaps, state.pickups, state.official, state.officialCheck,
  ]);

// Keep this device in step with the team database: other people's changes
// appear by themselves within a few seconds, without reloading.
let syncing = false;
async function sync() {
  if (syncing || document.visibilityState !== 'visible' || !navigator.onLine) return;
  syncing = true;
  const before = locked();
  const data = teamData();
  await syncTeam();
  syncing = false;
  // A sign-in that has ended goes back to the login page, and an account
  // that has just been approved leaves the waiting page.
  if (locked() !== before) render();
  else if (teamData() !== data) quietRender();
}

// A link from an email comes back with a sign-in in the address rather than a page name.
const link = new URLSearchParams(location.hash.slice(1));
if (link.has('access_token') || link.has('error_description')) {
  history.replaceState(null, '', location.pathname);
  login.emailLink(link, () => useEmailLink(link));
}

render();
tick();
loadAirports().then(quietRender);
sync();
setInterval(sync, 10000);
window.addEventListener('online', sync);

// Updates install themselves. Every minute (and whenever the app comes back to
// the front) it asks whether a new version has been published; one has when
// sw.js has changed, which is why CACHE in sw.js is bumped with every release.
// The new version takes over in the background and the page reloads itself at
// the next quiet moment, never while someone is typing or has unsaved changes.
if ('serviceWorker' in navigator) {
  // Only a page that was already running an older version reloads, not the
  // very first visit.
  const hadVersion = !!navigator.serviceWorker.controller;
  let updated = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadVersion) updated = true;
  });
  setInterval(() => {
    if (updated && !root.querySelector('form:focus-within, select:focus') && !unsaved()) location.reload();
  }, 2000);
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      const check = () => navigator.onLine && reg.update().catch(() => {});
      setInterval(check, 60000);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    })
    .catch(() => {});
}
