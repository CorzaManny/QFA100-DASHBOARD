// All app data lives in this one object, saved to the device's localStorage.

import { OFFICIAL_SCHEDULE } from './data/schedule.js';
import { configured } from './api.js';

const KEY = 'qfa100-ops.v1';

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// The schedule bundled with the app. Used until the team database has been
// read, and on its own when no database is connected (preview mode).
export function officialSectors() {
  return OFFICIAL_SCHEDULE.map((s) => ({ id: s.flight, ...s, notes: '' }));
}

function defaults() {
  return {
    profile: { callsign: 'QFA100', simbrief: '', statusUrl: '', turnaround: 45, aircraft: 'B738' },
    preview: false, // using the app without accounts because no database is connected
    sectors: officialSectors(), // copy of the team database's sectors
    roster: [], // copy of the team database's roster: { id, sector_id, user_id, duty, report_at, notes }
    people: [], // copy of the team's accounts: { id, display_name, vatsim_cid, role }
    defects: [],
    defectSeq: 0,
    notes: {}, // airport briefing notes by ICAO
    metar: {}, // last METAR by ICAO: { text, at }
    checks: {}, // checklist progress by checklist id
    ofp: null, // last imported SimBrief OFP summary
    track: null, // last VATSIM sample for the team aircraft
  };
}

function load() {
  const base = defaults();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && typeof saved === 'object') {
      const merged = { ...base, ...saved, profile: { ...base.profile, ...saved.profile } };
      // Sectors now come from the team database. Drop anything an earlier
      // version of the app stored on the device, and anything cached while
      // no database is connected.
      if (!configured || merged.sectors.some((sec) => 'crew' in sec || sec.sample)) {
        merged.sectors = base.sectors;
        merged.roster = [];
        merged.people = [];
      }
      return merged;
    }
  } catch {
    // unreadable or blocked storage: start fresh
  }
  return base;
}

export const state = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full or unavailable; the app still works for this session
  }
}

export function resetAll() {
  Object.assign(state, defaults());
  save();
}

// The tech log and airport notes still live on each device, so they can be
// passed around as a file. The schedule and roster come from the database.
export function exportData() {
  const { defects, defectSeq, notes } = state;
  return JSON.stringify({ app: 'qfa100-ops', version: 2, defects, defectSeq, notes }, null, 2);
}

export function importData(text) {
  const data = JSON.parse(text);
  if (data.app !== 'qfa100-ops') {
    throw new Error('Not a QFA100 Ops export file');
  }
  state.defects = Array.isArray(data.defects) ? data.defects : [];
  state.defectSeq = Number(data.defectSeq) || state.defects.length;
  state.notes = data.notes && typeof data.notes === 'object' ? data.notes : {};
  save();
}
