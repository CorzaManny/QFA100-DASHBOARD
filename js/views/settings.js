// Settings: who you are, which aircraft to track, and moving data between devices.

import { state, save, exportData, importData, resetAll } from '../store.js';
import { esc, icon, rerender } from '../ui.js';
import { crewNames } from '../ops.js';

let message = '';

export function render() {
  const p = state.profile;
  const out = message;
  message = '';
  return `
    <div class="page-head"><h1>Settings</h1></div>
    <form class="card form" data-form="profile">
      <h2>You and the aircraft</h2>
      <label class="field">Your name (as written on the schedule)<input name="name" list="crew-names" value="${esc(p.name)}" placeholder="e.g. Corey"></label>
      <datalist id="crew-names">${crewNames().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <div class="grid2">
        <label class="field">VATSIM callsign to track<input name="callsign" required autocapitalize="characters" value="${esc(p.callsign)}"></label>
        <label class="field">Aircraft type (ICAO)<input name="aircraft" required autocapitalize="characters" maxlength="4" value="${esc(p.aircraft)}"></label>
      </div>
      <div class="grid2">
        <label class="field">SimBrief username or Pilot ID<input name="simbrief" autocapitalize="none" autocorrect="off" value="${esc(p.simbrief)}"></label>
        <label class="field">Minimum turnaround (minutes)<input name="turnaround" type="number" min="0" max="600" required value="${esc(p.turnaround)}"></label>
      </div>
      <div class="btn-row"><button class="btn primary" type="submit">Save settings</button></div>
    </form>
    ${out ? `<p class="note ok">${esc(out)}</p>` : ''}
    <section class="card">
      <h2>Share with the team</h2>
      <p class="note">The schedule, tech log and airport notes are stored on this device. Export them to a file and have teammates import it to get the same data.</p>
      <div class="btn-row">
        <button class="btn ghost" data-act="export">Export team data</button>
        <label class="btn ghost">Import team data<input type="file" accept="application/json,.json" data-file="import" hidden></label>
      </div>
    </section>
    <section class="card">
      <h2>Install as an app</h2>
      <p class="note"><strong>iPhone / iPad:</strong> open this page in Safari, tap Share, then "Add to Home Screen".</p>
      <p class="note"><strong>Android:</strong> open in Chrome, tap the ⋮ menu, then "Install app" or "Add to Home screen".</p>
      <p class="note">Once installed it opens full screen and the checklists work without a connection.</p>
    </section>
    <section class="card">
      <h2>Reset</h2>
      <p class="note">Erases everything stored on this device, including the schedule, tech log, notes and checklist progress.</p>
      <button class="btn danger" data-act="reset">${icon('alert')} Erase all data on this device</button>
    </section>`;
}

export function mounted(root) {
  root.querySelector('[data-file="import"]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Importing replaces the schedule, tech log and airport notes on this device. Continue?')) return;
    try {
      importData(await file.text());
      message = 'Team data imported.';
    } catch (err) {
      message = `Import failed: ${err.message}`;
    }
    rerender();
  });
}

export const forms = {
  profile(data) {
    const p = state.profile;
    const callsign = String(data.get('callsign')).trim().toUpperCase();
    if (callsign !== p.callsign) state.track = null;
    Object.assign(p, {
      name: String(data.get('name')).trim(),
      callsign,
      aircraft: String(data.get('aircraft')).trim().toUpperCase(),
      simbrief: String(data.get('simbrief')).trim(),
      turnaround: Math.max(0, Number(data.get('turnaround')) || 0),
    });
    save();
    message = 'Settings saved.';
    rerender();
  },
};

export const actions = {
  export() {
    const url = URL.createObjectURL(new Blob([exportData()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `qfa100-ops-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  reset() {
    if (!confirm('Erase all QFA100 Ops data on this device? This cannot be undone.')) return;
    resetAll();
    message = 'All data erased. The official WorldFlight schedule has been reloaded.';
    rerender();
  },
};
