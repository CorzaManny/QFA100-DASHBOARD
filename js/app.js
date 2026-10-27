// App shell: sign-in gate, hash routing, event delegation, clock, screen wake lock.

import { esc, zulu, simClock, zdate, span } from './ui.js';
import { state } from './store.js';
import { configured, getSession, keepSignedIn, useEmailLink, signOut } from './api.js';
import {
  loadAirports,
  syncTeam,
  canEdit,
  isPending,
  needsSetup,
  isEfb,
  isOps,
  me,
  clearTeam,
  roleName,
  currentSector,
  upcomingSector,
  running,
  airport,
  distNm,
  teamAircraftName,
  canUseVpilot,
} from './ops.js';
import * as opschat from './opschat.js';
import * as scratch from './scratch.js';
import * as login from './views/login.js';
import * as roster from './views/roster.js';
import * as duty from './views/duty.js';
import * as admin from './views/admin.js';
import * as availability from './views/availability.js';
import * as dash from './views/dash.js';
import * as checklists from './views/checklists.js';
import * as schedule from './views/schedule.js';
import * as techlog from './views/techlog.js';
import * as airports from './views/airports.js';
import * as brief from './views/brief.js';
import * as ctwo from './views/ctwo.js';
import * as settings from './views/settings.js';
import * as progress from './views/progress.js';
import * as opsboard from './views/ops.js';
import * as stream from './views/stream.js';
import * as vpilot from './views/vpilot.js';
import * as acars from './views/acars.js';
import * as gsx from './views/gsx.js';

const ROUTES = { dashboard: dash, checklists, schedule, roster, duty, techlog, airports, brief, dispatch: brief, ctwo, settings, admin, availability, progress, ops: opsboard, stream, vpilot, acars, gsx };
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

const flightbar = document.getElementById('flightbar');

// The flight deck's own strip under the top bar: which flight, which leg,
// and whether it is running to time. Shown on every page for an EFB tablet
// (see the .efb body class), not just the Dashboard, so it stays visible
// while flicking between the tech log, checklists and briefings in flight.
function updateFlightBar() {
  const s = currentSector() || upcomingSector();
  if (!s) {
    flightbar.innerHTML = '';
    return;
  }
  const dep = airport(s.dep);
  const arr = airport(s.arr);
  const dist = dep && arr ? Math.round(distNm(dep.lat, dep.lon, arr.lat, arr.lon)) : null;
  const t = state.track;
  const live = !!t?.online;
  const run = running();
  const status = run.trusted && run.late
    ? { cls: run.late.delay > 0 ? 'warn' : 'info', label: `${span(Math.abs(run.late.delay))} ${run.late.delay > 0 ? 'LATE' : 'EARLY'}` }
    : { cls: 'ok', label: 'ON SCHEDULE' };
  flightbar.innerHTML = `
    <div class="fb-left">
      <div class="fb-flight">${esc(s.flight)}</div>
      <div class="fb-sub">
        <span class="tiny">${esc(teamAircraftName())}</span>
        <span class="badge ${live ? 'ok' : 'mute'} fb-vatsim">${t?.source === 'SIM' ? 'SIMULATOR' : 'VATSIM'}</span>
      </div>
    </div>
    <div class="fb-route">
      <div class="fb-apt"><div class="fb-code">${esc(s.dep)}</div><div class="tiny">${esc(dep?.city || '')}</div></div>
      <div class="fb-arrow-wrap">
        <span class="tiny">${span(new Date(s.sta) - new Date(s.std))}</span>
        <svg class="fb-arrow" viewBox="0 0 80 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 8h72M66 2l8 6-8 6"/></svg>
        <span class="tiny">${dist != null ? `${dist} NM` : ''}</span>
      </div>
      <div class="fb-apt"><div class="fb-code">${esc(s.arr)}</div><div class="tiny">${esc(arr?.city || '')}</div></div>
    </div>
    <div class="fb-right">
      <div class="fb-time"><div class="tiny">STD</div><div class="fb-time-v">${simClock(s.std)}</div></div>
      <div class="fb-time"><div class="tiny">STA</div><div class="fb-time-v">${simClock(s.sta)}</div></div>
      <div class="fb-time"><div class="tiny">DATE</div><div class="fb-time-v">${zdate(s.std)} ${new Date(s.std).getUTCFullYear()}</div></div>
      <span class="badge ${status.cls} fb-status">${esc(status.label)}</span>
    </div>`;
}

// ---- Chat panel ----
// The Twitch chat beside the page for an EFB tablet, open on every screen
// rather than only the Stream page - see js/views/stream.js, which leaves the
// chat out of its own card for an EFB account so there is only ever one
// connection. The iframe is built once per channel and left alone after
// that: a render() here never touches it, so it is never reconnected just
// because the crew changed pages.
const chatpanel = document.getElementById('chatpanel');
const chatBody = chatpanel.querySelector('.chatpanel-body');
const chatToggle = document.getElementById('chat-toggle');
const CHAT_OPEN_KEY = 'qfa100-chat-open';
let chatOpen = true;
try {
  chatOpen = localStorage.getItem(CHAT_OPEN_KEY) !== '0';
} catch {
  // storage unavailable; default to open
}
let chatChannel = undefined; // the channel the iframe currently points at

function setChatOpen(open) {
  chatOpen = open;
  document.body.classList.toggle('chat-open', open);
  try {
    localStorage.setItem(CHAT_OPEN_KEY, open ? '1' : '0');
  } catch {
    // storage unavailable; the choice just will not be remembered next visit
  }
  // The two panels share the right edge, so opening this one puts the ops
  // chat away - see js/opschat.js, which answers the same event.
  if (open) window.dispatchEvent(new CustomEvent('app:panel', { detail: 'chat' }));
}

window.addEventListener('app:panel', (e) => {
  if (e.detail !== 'chat' && chatOpen) setChatOpen(false);
});

function updateChatPanel(efb) {
  document.body.classList.toggle('chat-open', efb && chatOpen);
  if (!efb) return;
  const name = stream.channel();
  if (name === chatChannel) return;
  chatChannel = name;
  chatBody.innerHTML = name
    ? `<iframe class="chat" title="Twitch chat for ${esc(name)}" src="https://www.twitch.tv/embed/${encodeURIComponent(
        name,
      )}/chat?parent=${encodeURIComponent(location.hostname)}&darkpopout"
        sandbox="allow-storage-access-by-user-activation allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"></iframe>`
    : '<p class="note">No Twitch channel set yet. Ops staff set it on the Stream page.</p>';
}

chatToggle.addEventListener('click', () => setChatOpen(true));
document.getElementById('chat-close').addEventListener('click', () => setChatOpen(false));

function render() {
  // Rendering replaces the whole page, which drops the page's scroll
  // position. A render is usually something changing under somebody who is
  // reading or editing, not a move to another page, so put them back where
  // they were; hashchange scrolls to the top itself, after this.
  const wasAt = window.scrollY;
  const gate = locked();
  document.body.classList.toggle('locked', gate);
  document.body.classList.toggle('editor', !gate && canEdit());
  const efb = !gate && isEfb();
  document.body.classList.toggle('efb', efb);
  // The vPilot tab, for the accounts the radio is open to. The page itself
  // checks again, and so does the database (can_use_vpilot in
  // supabase/vpilot.sql); this is only what puts the tab in the nav.
  document.body.classList.toggle('vpilot', !gate && canUseVpilot());
  if (efb) updateFlightBar();
  else flightbar.innerHTML = '';
  updateChatPanel(efb);
  // The ops chat lives outside the page a render replaces, so it only needs
  // telling that who is signed in, or who is on shift, may have changed.
  opschat.paint();
  // The scratchpad likewise: it only needs telling which account's pad to
  // show. What has been written on it is never touched by a render.
  scratch.paint();
  // A tablet says so, and which of the two it is, so nobody mistakes one for
  // their own device.
  brand.textContent = efb ? `FLIGHT DECK · ${(me()?.display_name || 'TABLET').toUpperCase()}` : 'WORLDFLIGHT · 737 OPERATIONS';
  // The avatar says who is signed in; the menu holds the two places that are
  // theirs rather than the team's.
  closeMenu();
  const who = gate ? null : me();
  document.getElementById('who-initials').textContent = initials(who?.display_name);
  document.getElementById('who-name').textContent = who?.display_name || '';
  document.getElementById('who-role').textContent = who ? roleName(who.role).toUpperCase() : '';
  document.getElementById('who-admin').hidden = gate || !canEdit();
  route = gate ? { name: 'login', args: [], view: login } : parse();
  // A page can ask for more room than a normal card column gives it - the
  // Live Roster timeline, wherever it is showing, is the only one that does.
  document.body.classList.toggle('wide', !!route.view.wide?.(route.args));
  root.innerHTML = route.view.render(route.args);
  for (const tab of document.querySelectorAll('.tabs a[data-tab]')) {
    tab.classList.toggle('on', tab.dataset.tab === (route.name === 'airports' ? 'brief' : route.name));
  }
  route.view.mounted?.(root, route.args);
  if (window.scrollY !== wasAt) window.scrollTo(0, wasAt);
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

// An EFB tablet keeps its flight deck header bar live wherever it is in the
// app, not just on the Dashboard or Ops Board, so the live track is read on
// every page for one of those devices.
function pollTrack() {
  if (!(['dashboard', 'ops'].includes(route.name) || isEfb()) || locked() || document.visibilityState !== 'visible') return;
  dash.poll().then(() => isEfb() && updateFlightBar());
}

setInterval(tick, 1000);
setInterval(pollTrack, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  wakeLock();
  sync();
  pollTrack();
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

// Don't redraw underneath someone who is typing or has unsaved changes. A
// view can offer liveUpdate() to patch itself in place instead of a full
// render - the Stream page uses it so a background sync does not reload the
// Twitch chat iframe, which a full root.innerHTML replace would do.
const quietRender = () => {
  if (root.querySelector('form:focus-within, select:focus') || unsaved()) return;
  if (route.view.liveUpdate?.()) return;
  render();
};

// Everything that comes from the team database, to tell whether a sync changed anything.
const teamData = () =>
  JSON.stringify([
    state.sectors, state.roster, state.people, state.settings, state.prefs, state.defects, state.history, state.briefings,
    state.actuals, state.swaps, state.pickups, state.official, state.officialCheck, state.checklistStatus,
    // An admin rewording a checklist reaches the flight deck the same way
    // anything else does, within a few seconds and without a reload.
    state.normalChecklists,
    // The ops shift roster and who has the desk, but not the thread itself:
    // the chat panel repaints on its own, and a new message is no reason to
    // redraw the page underneath it.
    state.opsShifts, state.opsDesk,
  ]);

// Keep this device in step with the team database: other people's changes
// appear by themselves within a few seconds, without reloading.
let syncing = false;
async function sync() {
  if (syncing || document.visibilityState !== 'visible' || !navigator.onLine) return;
  syncing = true;
  // Renew the sign-in before asking for data, so coming back to the app after
  // days away does not meet a login page.
  await keepSignedIn();
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
