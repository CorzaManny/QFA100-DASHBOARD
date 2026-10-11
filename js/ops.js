// Operational logic: airports, distances, the VATSIM feed, schedule maths.

import { state, save } from './store.js';

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

export function isMine(sector) {
  const me = state.profile.name.trim().toLowerCase();
  return !!me && sector.crew.some((c) => c.trim().toLowerCase() === me);
}

export function crewNames() {
  return [...new Set(state.sectors.flatMap((s) => s.crew))].filter(Boolean).sort();
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

export async function refreshTrack() {
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
    state.track = { ...last, callsign, online: false, prefiled, error: null, checkedAt: now };
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
  if (prev?.online && prev.callsign === callsign && prev.at && now - prev.at < 5 * 60000 && now - prev.at > 20000) {
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
  return `https://dispatch.simbrief.com/options/custom?${q}`;
}

export async function fetchOfp() {
  const id = state.profile.simbrief.trim();
  if (!id) throw new Error('Add your SimBrief username in Settings first');
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
  state.ofp = {
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
  save();
  return state.ofp;
}
