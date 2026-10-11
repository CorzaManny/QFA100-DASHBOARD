// All app data lives in this one object, saved to the device's localStorage.

import { OFFICIAL_SCHEDULE } from './data/schedule.js';

const KEY = 'qfa100-ops.v1';
const MIN = 60000;

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// The official schedule with empty crew, ready for the team to fill in.
export function officialSectors() {
  return OFFICIAL_SCHEDULE.map((s) => ({ id: uid() + s.flight, ...s, crew: [], notes: '' }));
}

// Refresh sectors from the official schedule, keeping the crew and notes
// already entered against each WF sector and any sectors the team added.
export function loadOfficialSchedule() {
  const mine = new Map(state.sectors.map((s) => [s.flight, s]));
  const official = officialSectors().map((s) => {
    const old = mine.get(s.flight);
    return old ? { ...s, id: old.id, crew: old.crew, notes: old.notes } : s;
  });
  const flights = new Set(official.map((s) => s.flight));
  state.sectors = [...official, ...state.sectors.filter((s) => !s.sample && !flights.has(s.flight))];
  save();
}

function defaults() {
  return {
    profile: { name: '', callsign: 'QFA100', simbrief: '', turnaround: 45, aircraft: 'B738' },
    sectors: officialSectors(),
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
      // Earlier versions shipped placeholder sectors; swap them for the real schedule.
      if (merged.sectors.some((sec) => sec.sample)) {
        merged.sectors = [...base.sectors, ...merged.sectors.filter((sec) => !sec.sample)];
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

// Team data worth passing between devices (not personal progress or caches).
export function exportData() {
  const { sectors, defects, defectSeq, notes } = state;
  return JSON.stringify({ app: 'qfa100-ops', version: 1, sectors, defects, defectSeq, notes }, null, 2);
}

export function importData(text) {
  const data = JSON.parse(text);
  if (data.app !== 'qfa100-ops' || !Array.isArray(data.sectors)) {
    throw new Error('Not a QFA100 Ops export file');
  }
  state.sectors = data.sectors;
  state.defects = Array.isArray(data.defects) ? data.defects : [];
  state.defectSeq = Number(data.defectSeq) || state.defects.length;
  state.notes = data.notes && typeof data.notes === 'object' ? data.notes : {};
  save();
}
