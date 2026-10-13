// Settings: your account, the team's accounts, and this device's options.

import { state, save, exportData, importData, resetAll } from '../store.js';
import { configured, getSession, signOut, updateProfile } from '../api.js';
import { esc, icon, rerender } from '../ui.js';
import { me, isAdmin, canEdit, roleName, syncTeam, clearTeam } from '../ops.js';

let message = '';
let problem = '';

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
      <div class="grid2">
        <label class="field">Name on the roster<input name="name" required maxlength="60" value="${esc(p?.display_name || '')}"></label>
        <label class="field">VATSIM CID (optional)<input name="cid" inputmode="numeric" maxlength="10" value="${esc(p?.vatsim_cid || '')}"></label>
      </div>
      <div class="btn-row">
        <button class="btn primary" type="submit">Save account</button>
        <button class="btn ghost" type="button" data-act="signout">Sign out</button>
      </div>
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
  const p = state.profile;
  const out = `
    <div class="page-head"><h1>Settings</h1></div>
    ${message ? `<p class="note ok">${esc(message)}</p>` : ''}
    ${problem ? `<p class="note warn">${icon('alert')} ${esc(problem)}</p>` : ''}
    ${account()}
    ${adminLink()}
    <form class="card form" data-form="profile">
      <h2>This device</h2>
      <div class="grid2">
        <label class="field">VATSIM callsign to track<input name="callsign" required autocapitalize="characters" value="${esc(p.callsign)}"></label>
        <label class="field">Aircraft type (ICAO)<input name="aircraft" required autocapitalize="characters" maxlength="4" value="${esc(p.aircraft)}"></label>
      </div>
      <label class="field">SimBrief username or Pilot ID<input name="simbrief" autocapitalize="none" autocorrect="off" value="${esc(p.simbrief)}"></label>
      <label class="field">Simulator status API address (optional)<input name="statusUrl" type="url" inputmode="url" autocapitalize="none" autocorrect="off" value="${esc(p.statusUrl)}" placeholder="https://…/status"></label>
      <p class="tiny">When set, the Dashboard reads the aircraft's position straight from the simulator and only falls back to VATSIM if that fails. Leave blank to use VATSIM.</p>
      <div class="btn-row"><button class="btn primary" type="submit">Save device settings</button></div>
    </form>
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
  account(data) {
    return attempt(
      () =>
        updateProfile(me().id, {
          display_name: String(data.get('name')).trim(),
          vatsim_cid: String(data.get('cid')).trim() || null,
        }),
      'Account saved.',
    );
  },
  profile(data) {
    const p = state.profile;
    const callsign = String(data.get('callsign')).trim().toUpperCase();
    const statusUrl = String(data.get('statusUrl')).trim();
    if (callsign !== p.callsign || statusUrl !== p.statusUrl) state.track = null;
    Object.assign(p, {
      callsign,
      aircraft: String(data.get('aircraft')).trim().toUpperCase(),
      simbrief: String(data.get('simbrief')).trim(),
      statusUrl,
    });
    save();
    message = 'Device settings saved.';
    rerender();
  },
};

export const actions = {
  async signout() {
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
