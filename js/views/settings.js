// Settings: your account, the team's accounts, and this device's options.

import { state, save, exportData, importData, resetAll } from '../store.js';
import { configured, getSession, signOut, updateProfile } from '../api.js';
import { esc, icon, rerender } from '../ui.js';
import { me, isAdmin, canEdit, roleName, syncTeam, clearTeam, myNotify, myNotifyKinds } from '../ops.js';
import { pushProblem, pushEnabled, enablePush, disablePush, deviceLabel, testNotification } from '../push.js';

let message = '';
let problem = '';
// Found when the page is drawn, because asking the browser takes a moment.
let notifications = null;

function account() {
  if (!configured) {
    return `<section class="card"><h2>Account</h2>
      <p class="note">Accounts are not connected yet, so this device is in preview mode. See "Set up accounts" in the README.</p></section>`;
  }
  const p = me();
  return `
    <form class="card form" data-form="account">
      <div class="card-head"><h2>Your account</h2>
        <span class="badge ${p?.role === 'admin' ? 'warn' : 'info'}">${esc(roleName(p?.role).toUpperCase())}</span></div>
      <p class="note">Signed in as <strong>${esc(getSession()?.email || '')}</strong></p>
      <label class="field">Name on the roster<input name="name" required maxlength="60" value="${esc(p?.full_name || p?.display_name || '')}"></label>
      <p class="tiny">Everyone sees your first name and last initial, e.g. John S.</p>
      <div class="btn-row">
        <button class="btn primary" type="submit">Save account</button>
        <button class="btn ghost" type="button" data-act="signout">Sign out</button>
      </div>
    </form>`;
}

// Notifications are per device: a phone, an iPad, the computer at the sim.
// Each one has to be turned on where it is.
function notificationsCard() {
  if (!configured) return '';
  const blocked = pushProblem();
  const on = notifications === true;
  return `
    <section class="card">
      <div class="card-head"><h2>Notifications</h2>
        <span class="badge ${on ? 'ok' : 'mute'}">${on ? 'ON FOR THIS DEVICE' : 'OFF'}</span></div>
      <p class="note">Tells you when the roster is published, when your own sectors change, when a delay moves your report time, and when it is nearly time to report. ${
        on ? 'Turn it on separately on every device you want told.' : 'Nothing else is sent.'
      }</p>
      ${blocked ? `<p class="note warn">${icon('alert')} ${esc(blocked)}</p>` : ''}
      <div class="btn-row">
        ${
          blocked
            ? ''
            : on
              ? `<button class="btn ghost" data-act="pushOff">Turn off on ${esc(deviceLabel())}</button>
                 <button class="btn ghost" data-act="pushTest">Show me one</button>`
              : `<button class="btn primary" data-act="pushOn">Turn on for ${esc(deviceLabel())}</button>`
        }
      </div>
    </section>
    ${notificationChoices()}`;
}

// What this person is told, and how early. These follow the person, not the
// device, so they are the same on their phone and their iPad.
function notificationChoices() {
  const n = myNotify();
  const box = (key, label) =>
    `<label class="check"><input type="checkbox" name="${key}" ${n[key] ? 'checked' : ''}> ${label}</label>`;
  return `
    <form class="card form" data-form="notify">
      <h2>Notification settings</h2>
      ${myNotifyKinds().map(([key, label]) => box(key, label)).join('')}
      <div class="grid2">
        <label class="field">Remind me this long before I report (minutes)
          <input type="number" name="reportMinutes" min="0" max="1440" step="5" required value="${esc(n.reportMinutes)}">
          <span class="tiny">0 = no reminder</span></label>
        <label class="field">Tell me about a delay over (minutes)
          <input type="number" name="delayMinutes" min="0" max="1440" step="5" required value="${esc(n.delayMinutes)}">
          <span class="tiny">How far my report time must move</span></label>
      </div>
      <div class="btn-row"><button class="btn primary" type="submit">Save what I am told</button></div>
    </form>`;
}

function adminLink() {
  if (!configured || !canEdit()) return '';
  return `
    <section class="card">
      <h2>Admin</h2>
      <p class="note">Build the roster${isAdmin() ? ' and manage team roles' : ''}.</p>
      <a class="btn ghost" href="#/admin">Open the Admin section</a>
    </section>`;
}

export function render() {
  const out = `
    <div class="page-head"><h1>Settings</h1></div>
    ${message ? `<p class="note ok">${esc(message)}</p>` : ''}
    ${problem ? `<p class="note warn">${icon('alert')} ${esc(problem)}</p>` : ''}
    ${account()}
    ${notificationsCard()}
    ${adminLink()}
    <section class="card">
      <h2>Airport notes and tech log backup</h2>
      <p class="note">Airport notes are still stored on each device. Export them to a file and have teammates import it to get the same notes. The file also holds a backup copy of the tech log; the schedule, roster and tech log themselves sync automatically.</p>
      <div class="btn-row">
        <button class="btn ghost" data-act="export">Export</button>
        <label class="btn ghost">Import<input type="file" accept="application/json,.json" data-file="import" hidden></label>
      </div>
    </section>
    <section class="card">
      <h2>Install as an app</h2>
      <p class="note"><strong>iPhone / iPad:</strong> open this page in Safari, tap Share, then "Add to Home Screen".</p>
      <p class="note"><strong>Android:</strong> open in Chrome, tap the ⋮ menu, then "Install app" or "Add to Home screen".</p>
      <p class="note">Once installed it opens full screen and the checklists work without a connection.</p>
    </section>
    <section class="card">
      <h2>Reset this device</h2>
      <p class="note">Erases the airport notes, checklist progress and device settings stored here. Your account, the schedule, the roster and the team's tech log are not affected.</p>
      <button class="btn danger" data-act="reset">${icon('alert')} Erase data on this device</button>
    </section>`;
  message = '';
  problem = '';
  return out;
}

export function mounted(root) {
  // Ask the browser whether this device is already subscribed, then redraw if
  // the answer is not what the page assumed.
  if (configured && !pushProblem()) {
    pushEnabled().then((on) => {
      if (on !== notifications) {
        notifications = on;
        if (location.hash.startsWith('#/settings')) rerender();
      }
    });
  }
  root.querySelector('[data-file="import"]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Importing replaces the airport notes on this device. Tech log entries in the file can then be uploaded from the Tech Log page. Continue?')) return;
    try {
      importData(await file.text());
      message = 'Imported.';
    } catch (err) {
      problem = `Import failed: ${err.message}`;
    }
    rerender();
  });
}

async function attempt(work, done) {
  try {
    await work();
    await syncTeam();
    message = done;
  } catch (err) {
    problem = err.message;
  }
  if (location.hash.startsWith('#/settings')) rerender();
}

export const forms = {
  notify(data) {
    const minutes = (name) => Math.max(0, Math.min(1440, Math.round(Number(data.get(name)) || 0)));
    // Only the boxes this person was shown are read back, so a kind that is
    // not theirs to choose keeps whatever it was rather than being switched
    // off by a form that never offered it.
    const next = { ...(me().notify || {}) };
    for (const [key] of myNotifyKinds()) next[key] = data.get(key) === 'on';
    next.reportMinutes = minutes('reportMinutes');
    next.delayMinutes = minutes('delayMinutes');
    return attempt(
      () => updateProfile(me().id, { notify: next }),
      'Saved. This applies on every device you are signed in on.',
    );
  },
  account(data) {
    return attempt(
      () =>
        updateProfile(me().id, {
          display_name: String(data.get('name')).trim(),
        }),
      'Account saved.',
    );
  },
};

export const actions = {
  async pushOn(el) {
    el.disabled = true;
    message = '';
    problem = '';
    try {
      await enablePush();
      notifications = true;
      message = `Notifications are on for ${deviceLabel()}.`;
    } catch (err) {
      problem = err.message;
    }
    rerender();
  },
  async pushOff(el) {
    el.disabled = true;
    try {
      await disablePush();
      notifications = false;
      message = 'Notifications are off for this device.';
    } catch (err) {
      problem = err.message;
    }
    rerender();
  },
  async pushTest(el) {
    el.disabled = true;
    try {
      await testNotification();
    } catch (err) {
      problem = err.message;
      rerender();
    }
    el.disabled = false;
  },
  async signout() {
    if (!confirm('Sign out of QFA100 Ops on this device?')) return;
    await signOut();
    clearTeam();
    rerender();
  },
  export() {
    const url = URL.createObjectURL(new Blob([exportData()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `qfa100-ops-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async reset() {
    if (!confirm('Erase the data stored on this device? This cannot be undone.')) return;
    const preview = state.preview;
    resetAll();
    state.preview = preview;
    save();
    await syncTeam();
    message = 'Device data erased.';
    rerender();
  },
};
