// Operational logic: airports, distances, the VATSIM feed, schedule maths.

import { state, save } from './store.js';
import { configured, getSession, loadAll, saveBriefing } from './api.js';
import { rulesOf } from './autoroster.js';

const VATSIM_FEED = 'https://data.vatsim.net/v3/vatsim-data.json';
const EARTH_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;

let airports = null;
let airportsLoading = null;

export function loadAirports() {
  airportsLoading ??= fetch('js/data/airports.json')
    .then((r) => r.json())
    .then((data) => (airports = data))
    .catch(() => (airportsLoading = null));
  return airportsLoading;
}

export function airport(code) {
  const a = airports?.[code];
  if (!a) return null;
  const [name, city, country, lat, lon, elev, rwys] = a;
  return { icao: code, name, city, country, lat, lon, elev, runways: rwys ? rwys.split('|') : [] };
}

export function distNm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.sqrt(h));
}

// ---- Schedule ----

export const byStd = (a, b) => new Date(a.std) - new Date(b.std);

export function sortedSectors() {
  return [...state.sectors].sort(byStd);
}

// ---- Accounts and roster ----

export const DUTIES = ['Captain', 'First Officer', 'Relief Pilot', 'Observer'];

export const me = () => state.people.find((p) => p.id === getSession()?.userId) || null;
// What each role may do is enforced by the database; these only decide what to show.
export const ROLES = {
  pending: ['Awaiting approval', 'A new account; sees nothing until an admin approves it'],
  admin: ['Admin', 'Everything, including changing roles'],
  dispatcher: ['Dispatcher', 'Edits the schedule and the roster'],
  pilot: ['Pilot', 'Can be rostered to fly'],
  observer: ['Observer', 'Read only; can only be rostered as an observer'],
};
export const roleName = (role) => (ROLES[role] || ROLES.pilot)[0];
export const isAdmin = () => me()?.role === 'admin';
export const isPending = () => me()?.role === 'pending';
export const pendingPeople = () => state.people.filter((p) => p.role === 'pending');
export const canEdit = () => ['admin', 'dispatcher'].includes(me()?.role);
export const person = (id) => state.people.find((p) => p.id === id) || null;

// Everyone rostered on a sector, in seat order.
export function crewOf(sector) {
  return state.roster
    .filter((r) => r.sector_id === sector.id)
    .sort((a, b) => DUTIES.indexOf(a.duty) - DUTIES.indexOf(b.duty));
}

// Every sector needs at least this many pilots on the roster.
export const MIN_PILOTS = 2;
export const PILOT_DUTIES = ['Captain', 'First Officer', 'Relief Pilot'];
export const pilotsShort = (sector) =>
  Math.max(0, MIN_PILOTS - crewOf(sector).filter((r) => PILOT_DUTIES.includes(r.duty)).length);

// Report time offered when rostering: a set time before the departure window
// opens, longer for the first sector of the event. Both are team rules.
export function defaultReport(sector) {
  const first = sortedSectors()[0];
  const r = rules();
  const lead = first && first.id === sector.id ? r.firstReportLeadMinutes : r.reportLeadMinutes;
  return new Date(new Date(sector.std).getTime() - lead * 60000);
}

export function crewLabel(sector) {
  const crew = crewOf(sector);
  return crew.length ? crew.map((r) => person(r.user_id)?.display_name || 'Unknown').join(', ') : 'No crew rostered';
}

// My roster entry for a sector, or null if I'm not on it.
export function myDuty(sector) {
  const id = getSession()?.userId;
  return (id && state.roster.find((r) => r.sector_id === sector.id && r.user_id === id)) || null;
}

export const isMine = (sector) => !!myDuty(sector);

// Duty rules and roster state, shared by the whole team.
export const rules = () => rulesOf(state.settings);
export const isDraft = () => state.settings?.roster_state === 'draft';

// Someone's availability choice for a sector: 'prefer', 'available', 'unavailable' or undefined.
export const prefOf = (userId, sectorId) =>
  state.prefs.find((p) => p.user_id === userId && p.sector_id === sectorId)?.choice;

// Forget the team's data on this device when someone signs out.
export function clearTeam() {
  Object.assign(state, { roster: [], people: [], prefs: [], history: [], briefings: [], defects: state.defects.filter((d) => !d.shared), sharedLog: false });
  save();
}

// True when the tech log is the team's shared one rather than this device's own.
export const sharedLog = () => configured && !!getSession() && state.sharedLog;

// Pull the latest schedule, roster, accounts and tech log from the team database.
// On failure the copy already on the device stays in use.
export async function syncTeam() {
  if (!configured || !getSession()) return false;
  try {
    const { defects, ...team } = await loadAll();
    Object.assign(state, team);
    if (defects) {
      // Entries written before the tech log was shared stay on this device
      // until someone uploads them from the Tech Log page.
      state.localDefects = [...state.localDefects, ...state.defects.filter((d) => !d.shared)];
      state.defects = defects;
    }
    state.sharedLog = !!defects;
    save();
    return true;
  } catch {
    return false;
  }
}

// The sector being flown now: the one the live aircraft has filed if we can
// see it on VATSIM, otherwise whichever one the clock says should be airborne.
export function currentSector(now = Date.now()) {
  const sectors = sortedSectors();
  const t = state.track;
  if (t?.online && t.dep && t.arr) {
    const filed = sectors.filter((s) => s.dep === t.dep && s.arr === t.arr);
    if (filed.length) {
      return filed.reduce((a, b) => (Math.abs(new Date(a.std) - now) <= Math.abs(new Date(b.std) - now) ? a : b));
    }
  }
  return sectors.find((s) => new Date(s.std) <= now && now <= new Date(s.sta)) || null;
}

export function nextSector(now = Date.now(), mineOnly = false) {
  const cur = currentSector(now);
  return (
    sortedSectors().find((s) => s !== cur && new Date(s.std) > now && (!mineOnly || isMine(s))) || null
  );
}

// If the aircraft's estimated arrival plus the team's minimum turnaround runs
// past the following sector's scheduled departure, that departure is at risk.
// The sector to prepare for: my next rostered one, else the team's next.
export const upcomingSector = (now = Date.now()) => nextSector(now, true) || nextSector(now);

export function turnaroundRisk(now = Date.now()) {
  const t = state.track;
  const cur = currentSector(now);
  if (!t?.online || !t.eta || !cur) return null;
  const sectors = sortedSectors();
  const following = sectors[sectors.indexOf(cur) + 1];
  if (!following) return null;
  const earliest = t.eta + state.profile.turnaround * 60000;
  const late = earliest - new Date(following.std);
  return late > 0 ? { sector: following, earliest, late } : null;
}

// ---- Live VATSIM tracking ----

function phaseOf(sample, depApt, arrApt, vs) {
  if (sample.groundspeed < 40) {
    const near = (a) => a && distNm(sample.latitude, sample.longitude, a.lat, a.lon) < 8;
    if (near(arrApt)) return 'ARRIVED';
    if (near(depApt)) return 'AT DEPARTURE';
    return 'ON GROUND';
  }
  if (vs == null) return 'AIRBORNE';
  if (vs > 300) return 'CLIMB';
  if (vs < -300) return 'DESCENT';
  return 'CRUISE';
}

// ---- Simulator status API (see docs/API.md) ----

export const SIM_PHASES = [
  'PREFLIGHT', 'TAXI_OUT', 'TAKEOFF', 'CLIMB', 'CRUISE', 'DESCENT', 'APPROACH', 'LANDING', 'TAXI_IN', 'ARRIVED',
];
// A simulator report older than this is shown as stale rather than live.
const SIM_STALE_MS = 2 * 60000;

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const time = (v) => (typeof v === 'string' && !isNaN(Date.parse(v)) ? Date.parse(v) : null);
const code = (v) => (typeof v === 'string' ? v.trim().toUpperCase().slice(0, 4) : '');

async function simTrack(url) {
  const now = Date.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json().catch(() => {
    throw new Error('response is not JSON');
  });
  const p = d?.position || {};
  const at = time(d?.updatedAt);
  const lat = num(p.latitude);
  const lon = num(p.longitude);
  if (at == null) throw new Error('response has no valid updatedAt');
  if (lat == null || lon == null) throw new Error('response has no position');

  await loadAirports();
  const cur = currentSector(now);
  const dep = code(d.sector?.departure) || cur?.dep || '';
  const arr = code(d.sector?.arrival) || cur?.arr || '';
  const depApt = airport(dep);
  const arrApt = airport(arr);
  const gs = num(p.groundSpeedKt) ?? 0;
  const vs = num(p.verticalSpeedFpm);

  // Use the simulator's own figures when it sends them, otherwise estimate.
  let remaining = num(d.progress?.distanceRemainingNm);
  let estimated = false;
  if (remaining == null && arrApt) remaining = distNm(lat, lon, arrApt.lat, arrApt.lon);
  const flown = num(d.progress?.distanceFlownNm);
  const total =
    flown != null && remaining != null
      ? flown + remaining
      : depApt && arrApt
        ? distNm(depApt.lat, depApt.lon, arrApt.lat, arrApt.lon)
        : null;
  let eta = time(d.progress?.eta);
  if (eta == null && remaining != null && gs >= 80) {
    eta = at + (remaining / gs) * 3600000;
    estimated = true;
  }

  const onGround = typeof p.onGround === 'boolean' ? p.onGround : gs < 40;
  state.track = {
    source: 'SIM',
    callsign: typeof d.callsign === 'string' ? d.callsign.toUpperCase() : state.profile.callsign,
    // Also catches a timestamp from the future (a wrong clock or leftover test data).
    online: Math.abs(now - at) < SIM_STALE_MS,
    prefiled: false,
    error: null,
    simError: null,
    at,
    checkedAt: now,
    pilotName: typeof d.crew?.pilotFlying === 'string' ? d.crew.pilotFlying : '',
    lat,
    lon,
    alt: num(p.altitudeFt),
    gs: num(p.groundSpeedKt),
    hdg: num(p.headingDeg),
    vs,
    ias: num(p.indicatedAirspeedKt),
    mach: num(p.mach),
    fuelKg: num(d.fuel?.onBoardKg),
    dep,
    arr,
    altn: code(d.sector?.alternate),
    flight: typeof d.sector?.flight === 'string' ? d.sector.flight : '',
    route: '',
    acft: typeof d.aircraft?.type === 'string' ? d.aircraft.type : '',
    total,
    remaining,
    eta,
    etaEstimated: estimated,
    phase: SIM_PHASES.includes(d.phase)
      ? d.phase.replace('_', ' ')
      : num(p.groundSpeedKt) == null && typeof p.onGround !== 'boolean'
        ? 'PHASE UNKNOWN'
        : phaseOf({ latitude: lat, longitude: lon, groundspeed: onGround ? 0 : Math.max(gs, 40) }, depApt, arrApt, vs),
  };
  save();
  return state.track;
}

// The simulator's own API is the first choice; VATSIM is the fallback.
export async function refreshTrack() {
  const url = state.profile.statusUrl.trim();
  if (!url) return vatsimTrack();
  let sim = null;
  let problem = 'the last simulator report is out of date';
  try {
    sim = await simTrack(url);
    if (sim.online) return sim;
  } catch (err) {
    problem = err.message;
  }
  const track = await vatsimTrack();
  if (sim && !track.online) {
    // Nothing live anywhere: the simulator's last report is the best we have.
    state.track = sim;
    save();
    return sim;
  }
  track.simError = problem;
  return track;
}

async function vatsimTrack() {
  const callsign = state.profile.callsign.trim().toUpperCase();
  const prev = state.track;
  const now = Date.now();
  let feed;
  try {
    const res = await fetch(VATSIM_FEED, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    feed = await res.json();
  } catch (err) {
    state.track = { ...(prev || {}), error: `VATSIM feed unavailable (${err.message})`, checkedAt: now };
    return state.track;
  }

  const pilot = feed.pilots?.find((p) => p.callsign?.toUpperCase() === callsign);
  if (!pilot) {
    const prefiled = feed.prefiles?.some((p) => p.callsign?.toUpperCase() === callsign);
    // Keep the last known position so a disconnect reads as "stale", not "landed".
    const last = prev?.callsign === callsign ? prev : {};
    state.track = { ...last, callsign, online: false, prefiled, error: null, simError: null, checkedAt: now };
    save();
    return state.track;
  }

  await loadAirports();
  const fp = pilot.flight_plan || {};
  const cur = currentSector(now);
  const dep = fp.departure || cur?.dep || '';
  const arr = fp.arrival || cur?.arr || '';
  const depApt = airport(dep);
  const arrApt = airport(arr);

  let vs = null;
  if (prev?.online && prev.source === 'VATSIM' && prev.callsign === callsign && prev.at && now - prev.at < 5 * 60000 && now - prev.at > 20000) {
    vs = ((pilot.altitude - prev.alt) / (now - prev.at)) * 60000;
  } else if (prev?.callsign === callsign && now - (prev?.at || 0) <= 20000) {
    vs = prev.vs ?? null;
  }

  let total = null;
  let remaining = null;
  let eta = null;
  if (arrApt) {
    remaining = distNm(pilot.latitude, pilot.longitude, arrApt.lat, arrApt.lon);
    if (depApt) total = distNm(depApt.lat, depApt.lon, arrApt.lat, arrApt.lon);
    if (pilot.groundspeed >= 80) eta = now + (remaining / pilot.groundspeed) * 3600000;
  }

  state.track = {
    source: 'VATSIM',
    callsign,
    online: true,
    prefiled: false,
    error: null,
    at: now,
    checkedAt: now,
    pilotName: pilot.name || '',
    lat: pilot.latitude,
    lon: pilot.longitude,
    alt: pilot.altitude,
    gs: pilot.groundspeed,
    hdg: pilot.heading,
    vs,
    dep,
    arr,
    altn: fp.alternate || '',
    route: fp.route || '',
    acft: fp.aircraft_short || '',
    total,
    remaining,
    eta,
    phase: phaseOf(pilot, depApt, arrApt, vs),
  };
  save();
  return state.track;
}

// ---- Weather ----

export async function fetchMetar(code) {
  const res = await fetch(`https://metar.vatsim.net/${encodeURIComponent(code)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error('No METAR available');
  state.metar[code] = { text, at: Date.now() };
  save();
  return state.metar[code];
}

// ---- SimBrief ----

export function simbriefPlanUrl(sector) {
  const m = /^([A-Z]{3})(\d.*)$/.exec(sector.flight.toUpperCase());
  const q = new URLSearchParams({ orig: sector.dep, dest: sector.arr, type: state.profile.aircraft || 'B738' });
  if (m) {
    q.set('airline', m[1]);
    q.set('fltnum', m[2]);
  }
  if (sector.route) q.set('route', sector.route);
  return `https://dispatch.simbrief.com/options/custom?${q}`;
}

// The latest flight plan generated by a SimBrief account, cut down to what a briefing needs.
// id: SimBrief username or Pilot ID.
export async function fetchOfp(id) {
  const key = /^\d+$/.test(id) ? 'userid' : 'username';
  const res = await fetch(`https://www.simbrief.com/api/xml.fetcher.php?${key}=${encodeURIComponent(id)}&json=1`, {
    cache: 'no-store',
  });
  const d = await res.json().catch(() => null);
  if (!d || !d.origin) {
    throw new Error(d?.fetch?.status || `SimBrief returned HTTP ${res.status}`);
  }
  const num = (v) => (v == null || v === '' || isNaN(v) ? null : Number(v));
  const str = (v) => (typeof v === 'string' ? v : '');
  return {
    fetchedAt: Date.now(),
    generated: num(d.params?.time_generated) ? num(d.params.time_generated) * 1000 : null,
    units: str(d.params?.units) || 'kgs',
    callsign: str(d.atc?.callsign) || str(d.general?.icao_airline) + str(d.general?.flight_number),
    dep: str(d.origin?.icao_code),
    depRwy: str(d.origin?.plan_rwy),
    arr: str(d.destination?.icao_code),
    arrRwy: str(d.destination?.plan_rwy),
    altn: str(d.alternate?.icao_code),
    route: str(d.general?.route),
    cruise: num(d.general?.initial_altitude),
    costIndex: str(d.general?.costindex),
    acft: str(d.aircraft?.icaocode),
    reg: str(d.aircraft?.reg),
    ete: num(d.times?.est_time_enroute),
    schedOut: num(d.times?.sched_out) ? num(d.times.sched_out) * 1000 : null,
    blockFuel: num(d.fuel?.plan_ramp),
    tripFuel: num(d.fuel?.enroute_burn),
    taxiFuel: num(d.fuel?.taxi),
    reserveFuel: num(d.fuel?.reserve),
    altnFuel: num(d.fuel?.alternate_burn),
    pax: num(d.weights?.pax_count),
    zfw: num(d.weights?.est_zfw),
    tow: num(d.weights?.est_tow),
    ldw: num(d.weights?.est_ldw),
    pdf: str(d.files?.directory) && str(d.files?.pdf?.link) ? d.files.directory + d.files.pdf.link : '',
  };
}

// ---- Briefings ----

// Pilots, dispatchers and admins write briefings and the tech log; observers only read.
export const canReport = () => !configured || ['admin', 'dispatcher', 'pilot'].includes(me()?.role);

export const briefingOf = (sectorId) => state.briefings.find((b) => b.sector_id === sectorId) || {};

// Saves part of a sector's briefing for the whole team (or on this device in preview mode).
export async function saveBrief(sectorId, fields) {
  if (configured && getSession()) {
    await saveBriefing(sectorId, fields);
    await syncTeam();
    return;
  }
  const existing = state.briefings.find((b) => b.sector_id === sectorId);
  if (existing) Object.assign(existing, fields);
  else state.briefings.push({ sector_id: sectorId, ...fields });
  save();
}

// The SimBrief account flight plans come from: the team's shared one once an
// admin has set it, otherwise this person's own from Settings.
export const teamSimbrief = () => (state.settings?.simbrief || '').trim();
export const simbriefId = () => teamSimbrief() || state.profile.simbrief.trim();
