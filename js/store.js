// All app data lives in this one object, saved to the device's localStorage.

const KEY = 'qfa100-ops.v1';
const MIN = 60000;

const SAMPLE_LEGS = [
  ['YSSY', 'YBBN', 90],
  ['YBBN', 'YBCS', 140],
  ['YBCS', 'AYPY', 100],
  ['AYPY', 'WAAA', 220],
  ['WAAA', 'WSSS', 160],
  ['WSSS', 'VTBS', 140],
];

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// A demo schedule anchored to "now" so the dashboard has something to show.
function sampleSectors() {
  let t = Math.floor((Date.now() - 40 * MIN) / (5 * MIN)) * 5 * MIN;
  return SAMPLE_LEGS.map(([dep, arr, mins], i) => {
    const std = t;
    const sta = t + mins * MIN;
    t = sta + 45 * MIN;
    return {
      id: uid() + i,
      flight: 'QFA100',
      dep,
      arr,
      std: new Date(std).toISOString(),
      sta: new Date(sta).toISOString(),
      crew: i % 2 ? ['Pilot C', 'Pilot D'] : ['Pilot A', 'Pilot B'],
      notes: '',
      sample: true,
    };
  });
}

function defaults() {
  return {
    profile: { name: '', callsign: 'QFA100', simbrief: '', turnaround: 45, aircraft: 'B738' },
    sectors: sampleSectors(),
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
      return { ...base, ...saved, profile: { ...base.profile, ...saved.profile } };
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
