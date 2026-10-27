// Operational logic: airports, distances, the VATSIM feed, schedule maths.

import { state, save } from './store.js';
import {
  configured,
  getSession,
  loadAll,
  saveBriefing,
  saveSettings,
  fetchTaf,
  fetchAirportDocs,
  withRouteOptions,
  hasRouteOptions,
  setRouteLeg,
  fetchChecklistStatus,
  putNormalChecklists,
  fetchOpsChat,
  sendOpsMessage,
  fetchSimStatus,
} from './api.js';
import { rulesOf, seatsFor, isBoc, blockHours, problems } from './autoroster.js';
import { OFFICIAL_SCHEDULE } from './data/schedule.js';
import { CTWO_DEFAULTS } from './data/ctwo.js';
import { DEFAULT_NORMAL_CHECKLISTS } from './data/checklists.js';
import { running as runningOf, reportAt as reportAtOf } from './running.js';

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

// The bundled copy, put into the same shape the database rows come back in, so
// the alternative routes read the same whichever source the schedule came from.
const BUNDLED = OFFICIAL_SCHEDULE.map((s) => withRouteOptions({ ...s, leg: 'A' }));

// The official WorldFlight schedule. The database re-reads
// planning.worldflight.center every six hours and keeps a copy (see
// supabase/worldflight.sql), so the app follows the real programme without
// anyone running anything. Until that is set up, the copy the app ships with
// is used instead. Nothing is applied to the team's schedule automatically: an
// admin sees what differs and presses the button.
export const officialSchedule = () => (state.official?.length ? state.official : BUNDLED);

// When the database last read the WorldFlight site, and whether it worked.
// null when this database is not watching it.
export const officialCheck = () => state.officialCheck || null;
export const watchingSchedule = () => !!state.official?.length;

const sameTime = (a, b) => new Date(a).getTime() === new Date(b).getTime();

export function scheduleDrift() {
  const byFlight = new Map(state.sectors.map((s) => [s.flight, s]));
  const list = officialSchedule();
  const official = new Set(list.map((o) => o.flight));
  const added = [];
  const changed = [];
  for (const o of list) {
    const s = byFlight.get(o.flight);
    if (!s) {
      added.push(o);
      continue;
    }
    const fields = [];
    // Compared option by option, never against whichever one the team has
    // chosen to fly: WorldFlight publishes both, so flying B is not a change
    // to put right.
    if (s.optA.dep !== o.optA.dep) fields.push({ what: 'Departure airport', was: s.optA.dep, now: o.optA.dep });
    if (s.optA.arr !== o.optA.arr) fields.push({ what: 'Arrival airport', was: s.optA.arr, now: o.optA.arr });
    if ((s.optA.route || '') !== (o.optA.route || '')) {
      fields.push({ what: 'Route', was: s.optA.route || 'none', now: o.optA.route || 'none', long: true });
    }
    // Only where the database can hold an alternative; otherwise it could
    // never be applied and the schedule would read as changed for ever.
    if (hasRouteOptions()) {
      const altWas = s.optB ? `${s.optB.dep} → ${s.optB.arr}` : 'none';
      const altNow = o.optB ? `${o.optB.dep} → ${o.optB.arr}` : 'none';
      if (altWas !== altNow) fields.push({ what: 'Alternative route', was: altWas, now: altNow });
      else if (s.optB && (s.optB.route || '') !== (o.optB.route || '')) {
        fields.push({ what: 'Alternative route', was: s.optB.route || 'none', now: o.optB.route || 'none', long: true });
      }
    }
    if (!sameTime(s.std, o.std)) fields.push({ what: 'Departs', was: s.std, now: o.std, time: true });
    if (!sameTime(s.sta, o.sta)) fields.push({ what: 'Arrives', was: s.sta, now: o.sta, time: true });
    if ((s.window || 0) !== (o.window || 0)) {
      fields.push({ what: 'Departure window', was: `${s.window || 0} min`, now: `${o.window || 0} min` });
    }
    if (fields.length) changed.push({ sector: s, official: o, fields });
  }
  // Sectors the team has added themselves are left alone, only pointed out.
  const extra = state.sectors.filter((s) => !official.has(s.flight));
  return { added, changed, extra, total: added.length + changed.length };
}

// ---- Alternative routes ----

// The runs of sectors WorldFlight publishes two ways round, and which way the
// team is flying each of them. In 2026 there are two: SKBO to DNMM either via
// TBPB and GVAC or via TTPP and GVSV, and EINN to EHAM either via EGSS or EGKB.
//
// A run has to be flown one way or the other all through. Taking WF2619 to
// TTPP and then WF2620 out of TBPB would leave the aeroplane in the wrong
// ocean, so sectors are gathered into a run while both ways round still join
// up end to end, and the choice is made for the run rather than the sector.
export function routeOptions() {
  const runs = [];
  let run = null;
  for (const s of sortedSectors()) {
    if (!s.optB) {
      run = null;
      continue;
    }
    const prev = run?.at(-1);
    if (prev && prev.optA.arr === s.optA.dep && prev.optB.arr === s.optB.dep) {
      run.push(s);
      continue;
    }
    run = [s];
    runs.push(run);
  }
  return runs.map((sectors) => {
    const path = (key) => [sectors[0][key].dep, ...sectors.map((s) => s[key].arr)];
    const legs = new Set(sectors.map((s) => s.leg));
    return {
      id: sectors[0].flight,
      flights: sectors.map((s) => s.flight),
      sectors,
      // 'mixed' should not happen - the whole run goes over in one call - but
      // it is shown rather than hidden if something ever leaves it half done.
      leg: legs.size === 1 ? [...legs][0] : 'mixed',
      A: path('optA'),
      B: path('optB'),
    };
  });
}

// The run a sector belongs to, or null for the great majority that have no
// alternative. The choice is offered on each of the run's own sectors rather
// than gathered up somewhere, but it is still the run that moves.
export const routeOptionFor = (flight) => routeOptions().find((r) => r.flights.includes(flight)) || null;

// Switching a run over. The database moves every sector of it at once and
// clears any flight plan imported for the route being left behind; the crew,
// the report times and the rest of each briefing stay where they are.
export async function chooseRouteLeg(flights, leg) {
  const moved = await setRouteLeg(flights, leg);
  await syncTeam();
  return moved;
}

// ---- Accounts and roster ----

export const DUTIES = ['Captain', 'First Officer', 'Relief Pilot', 'Observer'];

export const me = () => state.people.find((p) => p.id === getSession()?.userId) || null;
// What each role may do is enforced by the database; these only decide what to show.
export const ROLES = {
  pending: ['Awaiting approval', 'A new account; sees nothing until an admin approves it'],
  admin: ['Admin', 'Everything, including changing roles'],
  dispatcher: ['Dispatcher', 'Edits the schedule and the roster, and flies'],
  operations: ['Operations', 'Everything a dispatcher does, but does not fly'],
  pilot: ['Pilot', 'Can be rostered to fly'],
  observer: ['Observer', 'Read only; can only be rostered as an observer'],
  efb: ['EFB tablet', 'A shared cockpit tablet: keeps the tech log, cannot be rostered'],
};
export const roleName = (role) => (ROLES[role] || ROLES.pilot)[0];
export const isAdmin = () => me()?.role === 'admin';
export const isPending = () => me()?.role === 'pending';
// An account an admin made, still carrying the placeholder address it was
// created with. Nothing else in the app opens until the person replaces it.
export const needsSetup = () => !!me()?.must_setup;
export const pendingPeople = () => state.people.filter((p) => p.role === 'pending');
export const canEdit = () => ['admin', 'dispatcher', 'operations'].includes(me()?.role);
// Ops staff run the roster but are never on it, so they are never asked for
// availability and never offered a seat.
export const isOps = () => me()?.role === 'operations';
export const flies = (role) => ['admin', 'dispatcher', 'pilot'].includes(role);
// A tablet left in the cockpit, signed in to a shared account. It shows the
// whole team's flying rather than one person's, and keeps the tech log.
export const isEfb = () => me()?.role === 'efb';
// Who may write in the tech log: the cockpit tablets, and ops staff correcting it.
export const canLog = () => !configured || ['admin', 'dispatcher', 'operations', 'efb'].includes(me()?.role);
export const person = (id) => state.people.find((p) => p.id === id) || null;

// What each person is told, and how early. Anything they have not chosen falls
// back to the team's rules, so a new account gets sensible behaviour.
export const NOTIFY_KINDS = [
  ['roster', 'The roster is published, or my sectors change'],
  ['delay', 'A delay moves my report time'],
  ['report', 'A reminder before I report'],
  ['opschat', 'A message in the ops chat from the other side'],
  ['opscall', 'Somebody calls me in the ops chat'],
];

// The ops chat lines are only offered to the people who have a thread, so a
// pilot is not asked about one they cannot read.
const OPS_CHAT_KINDS = ['opschat', 'opscall'];
export const myNotifyKinds = () =>
  NOTIFY_KINDS.filter(([key]) => !OPS_CHAT_KINDS.includes(key) || canOpsChat());

export function myNotify() {
  const chosen = me()?.notify || {};
  const r = rules();
  return {
    roster: chosen.roster !== false,
    delay: chosen.delay !== false,
    report: chosen.report !== false,
    opschat: chosen.opschat !== false,
    opscall: chosen.opscall !== false,
    reportMinutes: Number.isFinite(chosen.reportMinutes) ? chosen.reportMinutes : r.reportReminderMinutes,
    delayMinutes: Number.isFinite(chosen.delayMinutes) ? chosen.delayMinutes : r.delayNoticeMinutes,
  };
}

// Everyone rostered on a sector, in seat order.
export function crewOf(sector) {
  return state.roster
    .filter((r) => r.sector_id === sector.id)
    .sort((a, b) => DUTIES.indexOf(a.duty) - DUTIES.indexOf(b.duty));
}

// Every sector needs a Captain and a First Officer; long ones also need a
// relief pilot, which is a team rule.
export const MIN_PILOTS = 2;
export const PILOT_DUTIES = ['Captain', 'First Officer', 'Relief Pilot'];
export const seats = (sector) => seatsFor(sector, rules());
export const pilotsNeeded = (sector) => seats(sector).length;
export const needsRelief = (sector) => seats(sector).includes('Relief Pilot');
export const pilotsShort = (sector) =>
  Math.max(0, pilotsNeeded(sector) - crewOf(sector).filter((r) => PILOT_DUTIES.includes(r.duty)).length);

// How much one person is flying: sectors in each seat, block hours and
// back-of-clock sectors. Used to keep the roster even.
export function workload(userId) {
  const byId = new Map(state.sectors.map((s) => [s.id, s]));
  const r = rules();
  const out = { total: 0, hours: 0, boc: 0 };
  for (const duty of PILOT_DUTIES) out[duty] = 0;
  for (const entry of state.roster) {
    if (entry.user_id !== userId || !PILOT_DUTIES.includes(entry.duty)) continue;
    const sector = byId.get(entry.sector_id);
    if (!sector) continue;
    out.total += 1;
    out[entry.duty] += 1;
    out.hours += blockHours(sector);
    if (isBoc(sector, r)) out.boc += 1;
  }
  return out;
}

// Everyone who can be put on a sector at all: a tablet is not a person.
export const rosterable = () => state.people.filter((p) => !['pending', 'operations', 'efb'].includes(p.role));

// Which duty rules taking on one more sector would break for somebody. Empty
// when it breaks none, or when they are already on it.
export function wouldBreak(userId, sector) {
  const byId = new Map(state.sectors.map((s) => [s.id, s]));
  const mine = state.roster
    .filter((r) => r.user_id === userId && PILOT_DUTIES.includes(r.duty) && byId.has(r.sector_id))
    .map((r) => byId.get(r.sector_id));
  if (mine.some((x) => x.id === sector.id)) return [];
  const before = problems(mine, rules());
  return problems([...mine, sector], rules()).filter((text) => !before.includes(text));
}

// ---- Bidding ----

// An admin can set a moment when availability closes and the roster is built.
// With it switched off, nothing below applies and availability stays open.
export const biddingOn = () => !!state.settings?.bidding_enabled && !!state.settings?.bids_close_at;
export const bidsCloseAt = () => (biddingOn() ? new Date(state.settings.bids_close_at) : null);
export const biddingOpen = (now = Date.now()) => biddingOn() && now < bidsCloseAt().getTime();
export const biddingClosed = (now = Date.now()) => biddingOn() && now >= bidsCloseAt().getTime();
// Who may still change availability: everybody until bidding closes, and ops
// staff afterwards, because a late phone call still has to be dealt with.
export const canBid = () => !biddingClosed() || canEdit();

// ---- Picking up an empty seat ----

// null until supabase/pickups.sql has been run.
export const pickupsOn = () => Array.isArray(state.pickups);
export const pendingPickups = () => (state.pickups || []).filter((p) => p.state === 'pending');
// Pilot seats on a sector that nobody is rostered in.
export const openSeats = (sector) => seats(sector).filter((duty) => !crewOf(sector).some((r) => r.duty === duty));
// Who may ask for a seat: anybody who flies, once the roster is published.
export const canPickUp = () => configured && !isDraft() && flies(me()?.role) && pickupsOn();

// ---- Giving a sector away ----

export const swaps = () => state.swaps || [];
export const openSwaps = () => swaps().filter((w) => w.state === 'open');
export const claimedSwaps = () => swaps().filter((w) => w.state === 'claimed');
// The offer still live against a roster entry, if there is one.
export const swapFor = (rosterId) => swaps().find((w) => w.roster_id === rosterId && ['open', 'claimed'].includes(w.state)) || null;
// The sector an offer is about, and who is on it.
export const swapEntry = (swap) => state.roster.find((r) => r.id === swap.roster_id) || null;
export function swapSector(swap) {
  const entry = swapEntry(swap);
  return entry ? state.sectors.find((s) => s.id === entry.sector_id) || null : null;
}

// Everyone who can be rostered in a pilot's seat.
export const flyers = () => state.people.filter((p) => flies(p.role));

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
  Object.assign(state, { roster: [], people: [], prefs: [], history: [], briefings: [], actuals: [], swaps: [], pickups: null, official: [], officialCheck: null, checklistStatus: [], normalChecklists: null, checkRev: {}, opsShifts: null, opsDesk: null, opsChat: [], chatSeen: 0, defects: state.defects.filter((d) => !d.shared), sharedLog: false });
  save();
}

// True when the tech log is the team's shared one rather than this device's own.
export const sharedLog = () => configured && !!getSession() && state.sharedLog;

// Names are shown as first name and last initial: "John Smith" -> "John S".
// The cockpit tablets keep their names. full_name keeps what was typed, for
// editing it and for telling two people apart in Admin -> People.
export function shortName(full) {
  const words = String(full || '').trim().split(/\s+/).filter(Boolean);
  return words.length > 1 ? `${words[0]} ${words.at(-1)[0].toUpperCase()}` : words[0] || '';
}
const withShortName = (p) => ({ ...p, full_name: p.display_name, display_name: p.role === 'efb' ? p.display_name : shortName(p.display_name) });

// Pull the latest schedule, roster, accounts and tech log from the team database.
// On failure the copy already on the device stays in use.
export async function syncTeam() {
  if (!configured || !getSession()) return false;
  try {
    const { defects, official, opsChat, ...team } = await loadAll();
    Object.assign(state, team);
    state.people = (state.people || []).map(withShortName);
    // opsShifts and opsDesk stay null when this database has no ops desk, so
    // the panel knows to leave itself out; the thread is a list either way.
    state.opsChat = opsChat || [];
    // null means the database has no official schedule table; keep the copy
    // the app ships with rather than blanking it.
    state.official = official || [];
    if (defects) {
      // Entries written before the tech log was shared stay on this device
      // until someone uploads them from the Tech Log page.
      state.localDefects = [...state.localDefects, ...state.defects.filter((d) => !d.shared)];
      state.defects = defects;
    }
    state.sharedLog = !!defects;
    dropStaleChecklistTicks();
    save();
    return true;
  } catch {
    return false;
  }
}

// A narrow, fast poll of just checklist_status - the Checklists page uses
// this to see the other EFB's completion within a couple of seconds, rather
// than waiting on the full ten-second team sync (which pulls everything).
export async function syncChecklistStatus() {
  if (!configured || !getSession()) return false;
  try {
    state.checklistStatus = await fetchChecklistStatus();
    save();
    return true;
  } catch {
    return false;
  }
}

// ---- The ops desk ----
// Who the flight deck should be talking to, and the thread they talk in. The
// shift roster itself is built in Admin; see supabase/ops-chat.sql.

// The cockpit tablets and the controllers who work the ops desk. A dispatcher
// builds the roster and the schedule but does not answer the flight deck, so
// they are left out along with the pilots reading their own roster and the
// observers; none of them sees the panel at all.
//
// This mirrors in_ops_chat() in supabase/ops-chat.sql, which is what actually
// enforces it - change one and re-run the other.
export const canOpsChat = () => ['admin', 'operations', 'efb'].includes(me()?.role);

// ---- vPilot ----
// Who may watch the radio and drive it. The same people who may report a
// defect - the flight deck tablets, the pilots and ops - and deliberately its
// own list rather than canOpsChat(), so changing who answers the ops desk
// never quietly changes who can transmit on VATSIM. Observers are left out:
// the jumpseat does not work the radio.
//
// This mirrors can_use_vpilot() in supabase/vpilot.sql exactly. The database
// is what actually enforces it; this is so the app can leave the panel out
// rather than show a radio that answers every press with "not allowed".
export const canUseVpilot = () => ['admin', 'dispatcher', 'operations', 'pilot', 'efb'].includes(me()?.role);

// Which side of the thread somebody is on. The controllers are one side and
// the flight deck the other, and that is the basis for the badges in the
// thread, for which messages make a sound, for who a call rings, and for who
// can be put on a shift at all. Everybody here must also be in canOpsChat(),
// or a question would be sent to somebody with no panel to answer in.
export const OPS_DESK_ROLES = ['admin', 'operations'];
export const sideOf = (userId) => (OPS_DESK_ROLES.includes(person(userId)?.role) ? 'ops' : 'deck');

// Who a call from this account should ring: the controller holding the desk if
// the flight deck is calling, every controller when nobody holds it so a call
// is never made to an empty chair, and both tablets when ops calls them.
export function whoToCall() {
  const myId = getSession()?.userId;
  const ids = (list) => list.filter((p) => p.id !== myId).map((p) => p.id);
  if (sideOf(myId) === 'ops') return ids(state.people.filter((p) => p.role === 'efb'));
  const on = opsOnShift();
  if (on?.userId && on.userId !== myId) return [on.userId];
  return ids(state.people.filter((p) => OPS_DESK_ROLES.includes(p.role)));
}

// False until supabase/ops-chat.sql has been run, which is how the app knows
// to leave the whole feature out rather than show an empty panel.
export const opsDeskReady = () => configured && !!getSession() && state.opsShifts !== null;

const shiftsByStart = () =>
  [...(state.opsShifts || [])].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

// Who should be answering right now, as { userId, since, until, taken }, or
// null if nobody is on. Somebody who has taken the desk off the roster holds
// it until they hand it back - or until the next rostered shift begins, which
// is the moment the roster is worth more than a note from hours ago.
export function opsOnShift(now = Date.now()) {
  const shifts = shiftsByStart();
  const rostered = shifts.find((s) => new Date(s.starts_at) <= now && now < new Date(s.ends_at)) || null;
  const desk = state.opsDesk;
  if (desk?.user_id && desk.taken_at) {
    const took = new Date(desk.taken_at).getTime();
    const handedOver = shifts.some((s) => {
      const starts = new Date(s.starts_at).getTime();
      return starts > took && starts <= now;
    });
    if (!handedOver) return { userId: desk.user_id, since: took, until: null, taken: true };
  }
  if (!rostered) return null;
  return {
    userId: rostered.user_id,
    since: new Date(rostered.starts_at).getTime(),
    until: new Date(rostered.ends_at).getTime(),
    taken: false,
  };
}

// The next shift due to start, so the desk can say who is coming and when.
export const nextOpsShift = (now = Date.now()) =>
  shiftsByStart().find((s) => new Date(s.starts_at) > now) || null;

export const onOpsDeskNow = () => opsOnShift()?.userId === getSession()?.userId;

// Messages this device has not seen, not counting its own. The marker is kept
// per device rather than in the database: each tablet has its own idea of what
// it has read, and nobody needs a read receipt.
export const unreadOps = () => {
  const seen = state.chatSeen || 0;
  const mine = getSession()?.userId;
  return state.opsChat.filter((m) => new Date(m.sent_at).getTime() > seen && m.user_id !== mine).length;
};

// Everything up to the newest message counts as read.
export function markOpsRead() {
  const newest = state.opsChat.at(-1);
  state.chatSeen = newest ? new Date(newest.sent_at).getTime() : Date.now();
  save();
}

// When a sector got under way: the time it actually left the blocks if that
// was stamped, and its published departure until then.
const sectorBegan = (sector) => new Date(actualOf(sector.id)?.off_blocks || sector.std).getTime();

// The sectors in the order they actually got under way, each with the moment
// it did. One walk along this says which leg any moment in the past belongs
// to - the ops thread uses it to show where one sector ended and the next
// began, so a question read hours later still has a leg attached to it.
export const sectorTimeline = () =>
  sortedSectors()
    .filter((s) => !actualOf(s.id)?.skipped)
    .map((sector) => ({ sector, began: sectorBegan(sector) }))
    .sort((a, b) => a.began - b.began);

// A narrow poll of just the thread, for while the panel is open: the ten-second
// team sync is too slow for a conversation.
export async function syncOpsChat() {
  if (!opsDeskReady()) return false;
  try {
    state.opsChat = await fetchOpsChat();
    save();
    return true;
  } catch {
    return false;
  }
}

export async function sendToOps(body) {
  await sendOpsMessage(body.trim());
  await syncOpsChat();
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

// The sector to prepare for: my next rostered one, else the team's next.
export const upcomingSector = (now = Date.now()) => nextSector(now, true) || nextSector(now);

// How the day is actually running: stamped times, the live feed and the
// knock-on effect on everything still to come. See js/running.js.
export const running = (now = Date.now()) =>
  runningOf({ sectors: state.sectors, actuals: state.actuals || [], track: state.track, rules: rules(), now });

// What one sector's crew should really report, given the running.
export const reportAt = reportAtOf;

// The times stamped for a sector, if any.
export const actualOf = (sectorId) => (state.actuals || []).find((a) => a.sector_id === sectorId) || null;

// Whether, and by whom, a checklist has been marked complete by either EFB
// account — from supabase/checklist-status.sql. null until that migration
// has been run.
export const teamChecklistStatus = (checklistId) =>
  (state.checklistStatus || []).find((c) => c.checklist_id === checklistId) || null;

// ---- The normal checklists ----

// The normal checklists the flight deck taps through, Preflight to Secure,
// in the order they are flown: the team's own set once an admin has edited
// them, otherwise the ones the app ships with. rev is when the team last
// changed one, which is how a device knows its ticks are out of date (see
// dropStaleChecklistTicks below).
//
// Non-normal checklists are not here. They are the extracted QRH, with their
// own numbering and branches, and the app does not let anyone reword them.
//
// Rebuilt only when the team's list actually changes - a sync replaces the
// array, so comparing it is enough. The Checklists page asks for this a dozen
// times in a render, and handing back the same array each time keeps the
// checklists it holds comparable by identity as well as by id.
let normalCache = { from: null, list: null };

export function normalChecklists() {
  const team = state.normalChecklists;
  if (!Array.isArray(team) || !team.length) return DEFAULT_NORMAL_CHECKLISTS;
  if (normalCache.from === team) return normalCache.list;
  normalCache = { from: team, list: builtFrom(team) };
  return normalCache.list;
}

function builtFrom(team) {
  return team.map((row) => ({
    id: row.id,
    name: row.name,
    kind: 'normal',
    rev: row.updated_at || '',
    items: (Array.isArray(row.items) ? row.items : []).map((item) => [String(item?.[0] ?? ''), String(item?.[1] ?? '')]),
  }));
}

// Rewording the checklists the crew reads out is an admin's job, not a
// dispatcher's - the database enforces it too, in set_normal_checklists.
// Without a database there is no team to save them for, so the editor stays
// out of the way rather than offering to change one device's copy.
export const canEditChecklists = () => configured && !!getSession() && isAdmin();

// Whether this database has the table at all. Until the migration is run the
// whole team flies the bundled checklists and there is nothing to edit.
export const checklistsEditable = () => canEditChecklists() && Array.isArray(state.normalChecklists);

// Saves the whole list, in the order given: position comes from the order, so
// moving a checklist is the same save as renaming one. The team database is
// the only copy, so this waits on it and then pulls the list back.
export async function saveNormalChecklists(list) {
  await putNormalChecklists(
    list.map((cl) => ({
      id: cl.id,
      name: String(cl.name || '').trim(),
      items: (cl.items || []).map(([challenge, response]) => [String(challenge ?? '').trim(), String(response ?? '').trim()]),
    })),
  );
  await syncTeam();
}

// Ticks are kept by item position, on each device. Once an admin changes a
// checklist those positions mean something else, so a page of ticks against
// the old wording - or worse, a full counter over items nobody has read -
// would be a lie. Each device drops its own progress for a checklist the
// first time it sees a newer version of it. Deleted checklists go the same
// way, so their ticks do not sit in storage forever.
function dropStaleChecklistTicks() {
  if (!Array.isArray(state.normalChecklists)) return;
  const revs = (state.checkRev ??= {});
  const live = new Map(state.normalChecklists.map((row) => [row.id, row.updated_at || '']));
  for (const id of Object.keys(revs)) {
    if (!live.has(id)) {
      delete revs[id];
      delete state.checks[id];
    }
  }
  for (const [id, rev] of live) {
    if (revs[id] === rev) continue;
    // Nothing ticked against a version this device has not seen before: note
    // the version and leave the ticks be, so a first sync after signing in
    // does not wipe a checklist somebody is halfway through.
    if (revs[id] !== undefined) delete state.checks[id];
    revs[id] = rev;
  }
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
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json().catch(() => {
    throw new Error('response is not JSON');
  });
  return parseSimTrack(d);
}

async function parseSimTrack(d) {
  const now = Date.now();
  const p = d?.position || {};
  const at = time(d?.updatedAt);
  const lat = num(p.latitude);
  const lon = num(p.longitude);
  if (at == null) throw new Error('response has no valid updatedAt');
  if (lat == null || lon == null) throw new Error('response has no position');

  await loadAirports();
  const cur = currentSector(now);
  const callsign = typeof d.callsign === 'string' ? d.callsign.trim().toUpperCase() : teamCallsign();
  let filed = null;
  if (!code(d.sector?.departure) || !code(d.sector?.arrival)) {
    try {
      const feed = await vatsimFeed();
      const matches = (p) => p.callsign?.toUpperCase() === callsign;
      filed = feed.pilots?.find(matches)?.flight_plan || feed.prefiles?.find(matches)?.flight_plan;
    } catch {
      // Simulator tracking still works when the public flight plan is unavailable.
    }
  }
  const dep = code(d.sector?.departure) || code(filed?.departure) || cur?.dep || '';
  const arr = code(d.sector?.arrival) || code(filed?.arrival) || cur?.arr || '';
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
    callsign,
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
    // Suppress wind-induced IAS while stationary on the ground.
    ias: p.onGround === true && num(p.groundSpeedKt) != null && Math.abs(p.groundSpeedKt) < 1
      ? 0
      : num(p.indicatedAirspeedKt),
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

// Prefer the bridge's shared report, then the local status URL, then VATSIM.
export async function refreshTrack() {
  const url = state.profile.statusUrl.trim();
  let sim = null;
  let problem = null;
  if (configured && getSession()) {
    try {
      const status = await fetchSimStatus();
      if (status) {
        sim = await parseSimTrack(status);
        if (sim.online) return sim;
        problem = 'the last simulator report is out of date';
      }
    } catch {
      // An unavailable database or an older schema must not stop tracking.
    }
  }
  if (url) {
    try {
      const local = await simTrack(url);
      if (local.online) return local;
      if (!sim || local.at > sim.at) sim = local;
      problem = 'the last simulator report is out of date';
    } catch (err) {
      problem = err.message;
    }
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

// The whole VATSIM feed is a few megabytes, and the dashboard and the airport
// pages both want it, so one copy is kept for a few seconds and shared.
let feedCache = null;

async function vatsimFeed() {
  if (feedCache && Date.now() - feedCache.at < 20000) return feedCache.data;
  const res = await fetch(VATSIM_FEED, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  feedCache = { at: Date.now(), data };
  return data;
}

// Who is controlling an airport right now, and what its ATIS says.
//
// There is no one way VATSIM names a station. Much of the world uses the whole
// ICAO code (EGLL_TWR), the United States drops the country letter (KDFW ->
// DFW_TWR) and Australia uses the two-letter local code (YSSY -> SY_TWR).
// Sydney uses both at once: YSSY_ATIS alongside SY_TWR. So every form is
// matched and the results merged.
//
// A callsign only counts if it also ends in a position worked at the airport
// itself, which is what keeps a short code like SY_ from sweeping up something
// unrelated. Area control is left out on purpose: an enroute sector is not an
// airport station, and its frequency moves about and is often not published.
const POSITION = /_(DEL|GND|TWR|APP|DEP|ATIS)$/;

function stationsFor(list, icao, seen) {
  const out = [];
  for (const c of list || []) {
    const callsign = String(c.callsign || '').toUpperCase();
    if (!POSITION.test(callsign) || seen.has(callsign)) continue;
    const prefix = [icao, icao.slice(1), icao.slice(2)]
      .filter((p) => p.length >= 2)
      .find((p) => callsign.startsWith(`${p}_`));
    if (!prefix) continue;
    seen.add(callsign);
    out.push({ c, prefix });
  }
  return out;
}

export async function fetchStations(code) {
  const icao = String(code || '').toUpperCase();
  const feed = await vatsimFeed();
  const seen = new Set();
  const prefixes = new Set();
  const keep = (hit) => {
    prefixes.add(hit.prefix);
    return hit.c;
  };

  const atis = stationsFor(feed.atis, icao, seen)
    .map(keep)
    .map((a) => ({
      callsign: a.callsign,
      frequency: a.frequency || '',
      code: a.atis_code || '',
      text: (a.text_atis || []).join(' ').replace(/\s+/g, ' ').trim(),
    }));
  const controllers = stationsFor(
    (feed.controllers || []).filter((c) => (c.facility ?? 0) > 0),
    icao,
    seen,
  )
    .map(keep)
    .map((c) => ({
      callsign: c.callsign,
      frequency: c.frequency || '',
      name: c.name || '',
      since: c.logon_time || '',
    }));

  state.stations[icao] = { atis, controllers, prefixes: [...prefixes], at: Date.now() };
  save();
  return state.stations[icao];
}

async function vatsimTrack() {
  const callsign = teamCallsign();
  const prev = state.track;
  const now = Date.now();
  let feed;
  try {
    feed = await vatsimFeed();
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

// The forecast for an airport, read through the team database because the
// source does not let a browser read it directly. null means supabase/
// weather.sql has not been run, so there are no forecasts to show.
export async function fetchTafFor(code) {
  if (!configured || !getSession()) return null;
  const text = await fetchTaf(code);
  if (text == null) return null;
  state.taf[code] = { text: String(text).trim(), at: Date.now() };
  save();
  return state.taf[code];
}

// ---- WorldFlight's airport documents ----

// The documents the team controlling an airport has published on the
// WorldFlight planning site: their pilot briefing, and often an aerodrome or
// parking chart drawn for the event. Read through the team database for the
// same reason as the TAF - the planning site does not let a browser read its
// own listing - and the documents themselves are opened straight from there.
// null means supabase/airport-docs.sql has not been run.
export async function fetchDocsFor(code, force = false) {
  if (!configured || !getSession()) return null;
  const list = await fetchAirportDocs(code, force);
  if (list == null) return null;
  state.docs[code] = { list: Array.isArray(list) ? list : [], at: Date.now() };
  save();
  return state.docs[code];
}

export async function fetchMetar(code) {
  const res = await fetch(`https://metar.vatsim.net/${encodeURIComponent(code)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error('No METAR available');
  state.metar[code] = { text, at: Date.now() };
  save();
  return state.metar[code];
}

// A rough read of a METAR or one period of a TAF: just enough to say whether
// conditions are likely to slow arrivals down, not a full decode. 'VFR' |
// 'MVFR' | 'IFR' | 'LIFR', the categories controllers themselves think in
// terms of, or null if nothing usable was found.
function wxTokens(text) {
  return String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
}

// Visibility, as either metres (ICAO, a bare four-digit group) or statute
// miles (the US and a few others), which can be one token ("3SM", "1/2SM")
// or two ("1" "1/2SM" meaning 1 1/2). Scans the whole group rather than
// anchoring on the wind, so it reads a TAF change group as well as a METAR.
function visibilityNm(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'CAVOK') return 10;
    if (/^\d{4}$/.test(t)) return t === '9999' ? 10 : Number(t) / 1852;
    if (/SM$/.test(t)) {
      const frac = /^M?(\d+)\/(\d+)SM$/.exec(t);
      if (frac) return (/^\d+$/.test(tokens[i - 1] || '') ? Number(tokens[i - 1]) : 0) + Number(frac[1]) / Number(frac[2]);
      const whole = /^M?(\d+)SM$/.exec(t);
      if (whole) return Number(whole[1]);
    }
  }
  return null;
}

// The lowest broken or overcast layer (or vertical visibility); scattered and
// few are not a ceiling.
function ceilingFt(tokens) {
  let min = null;
  for (const t of tokens) {
    const m = /^(?:BKN|OVC|VV)(\d{3})$/.exec(t);
    if (m) min = min == null ? Number(m[1]) * 100 : Math.min(min, Number(m[1]) * 100);
  }
  return min;
}

const WX_ORDER = ['VFR', 'MVFR', 'IFR', 'LIFR'];
const visCategory = (nm) => (nm == null || nm > 5 ? 'VFR' : nm >= 3 ? 'MVFR' : nm >= 1 ? 'IFR' : 'LIFR');
const ceilCategory = (ft) => (ft == null || ft > 3000 ? 'VFR' : ft >= 1000 ? 'MVFR' : ft >= 500 ? 'IFR' : 'LIFR');

function categoryOf(tokens) {
  if (tokens.includes('CAVOK')) return 'VFR';
  const vis = visibilityNm(tokens);
  const ceil = ceilingFt(tokens);
  if (vis == null && ceil == null) return null;
  return WX_ORDER[Math.max(WX_ORDER.indexOf(visCategory(vis)), WX_ORDER.indexOf(ceilCategory(ceil)))];
}

export function metarCategory(text) {
  return text ? categoryOf(wxTokens(text)) : null;
}

// A TAF day-hour (e.g. "15" "08" from "1508/1510") as a real timestamp. TAFs
// only give the day of the month, so the one nearest the reference time (the
// moment it was read) is the right one, the same trick METAR/TAF decoders
// always use to cross a month end.
function tafDate(day, hour, min, ref) {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day, hour, min || 0));
  const DAY = 86400000;
  if (d - ref > 15 * DAY) d.setUTCMonth(d.getUTCMonth() - 1);
  else if (ref - d > 15 * DAY) d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

// Splits a TAF into its FM groups (a clean restatement of conditions) and
// BECMG groups (a change, inheriting whatever it does not restate); TEMPO and
// PROB groups are a temporary excursion, not the prevailing forecast, so they
// are left out of what a sector's crew plans fuel against.
const TAF_GROUP = /^(FM\d{6}|BECMG|TEMPO|PROB\d{2})$/;

function tafGroups(tokens) {
  const groups = [];
  let cur = { kind: 'BASE', tokens: [] };
  for (const t of tokens) {
    if (TAF_GROUP.test(t)) {
      groups.push(cur);
      cur = t.startsWith('FM') ? { kind: 'FM', at: t.slice(2), tokens: [] } : { kind: t === 'BECMG' ? 'BECMG' : 'SKIP', tokens: [] };
    } else {
      cur.tokens.push(t);
    }
  }
  groups.push(cur);
  return groups;
}

// The prevailing visibility and ceiling over time, as a list of periods
// covering the TAF's whole validity. ref anchors the day-hour groups to a
// real month.
function tafSegments(text, ref) {
  const tokens = wxTokens(text);
  const validIdx = tokens.findIndex((t) => /^\d{4}\/\d{4}$/.test(t));
  if (validIdx < 0) return null;
  const [vFrom, vTo] = tokens[validIdx].split('/');
  const start = tafDate(Number(vFrom.slice(0, 2)), Number(vFrom.slice(2, 4)), 0, ref);
  const end = tafDate(Number(vTo.slice(0, 2)), Number(vTo.slice(2, 4)), 0, ref);

  const segments = [];
  let vis = null;
  let ceil = null;
  let segStart = start;
  const closeAt = (at) => {
    if (at > segStart) segments.push({ start: segStart, end: at, vis, ceil });
    segStart = at;
  };

  for (const g of tafGroups(tokens.slice(validIdx + 1))) {
    if (g.kind === 'SKIP') continue;
    if (g.kind === 'BASE') {
      vis = visibilityNm(g.tokens);
      ceil = ceilingFt(g.tokens);
      continue;
    }
    const at =
      g.kind === 'FM'
        ? tafDate(Number(g.at.slice(0, 2)), Number(g.at.slice(2, 4)), Number(g.at.slice(4, 6)), ref)
        : (() => {
            const period = g.tokens.find((t) => /^\d{4}\/\d{4}$/.test(t));
            return period ? tafDate(Number(period.slice(0, 2)), Number(period.slice(2, 4)), 0, ref) : null;
          })();
    if (at == null) continue;
    closeAt(at);
    const newVis = visibilityNm(g.tokens);
    const newCeil = ceilingFt(g.tokens);
    if (g.kind === 'FM') {
      vis = newVis;
      ceil = newCeil;
    } else {
      if (newVis != null) vis = newVis;
      if (newCeil != null) ceil = newCeil;
    }
  }
  closeAt(end);
  return segments;
}

// The category forecast for one moment, from whichever TAF period covers it;
// clamped to the nearest period for a time outside the TAF's own validity.
function tafCategoryAt(text, atTime, ref = new Date()) {
  const segments = tafSegments(text, ref);
  if (!segments?.length) return null;
  const hit =
    segments.find((s) => atTime >= s.start && atTime < s.end) ||
    (atTime < segments[0].start ? segments[0] : segments[segments.length - 1]);
  if (hit.vis == null && hit.ceil == null) return null;
  return WX_ORDER[Math.max(WX_ORDER.indexOf(visCategory(hit.vis)), WX_ORDER.indexOf(ceilCategory(hit.ceil)))];
}

// What a sector's crew should plan fuel against: the TAF read for the moment
// they are expected to land, since that is what the holding is for, not what
// the weather happens to be doing right now. Falls back to the current METAR
// where there is no TAF (supabase/weather.sql not run, or none published).
async function weatherAt(code, atTime) {
  const taf = await fetchTafFor(code).catch(() => null);
  const tafText = taf?.text ?? state.taf[code]?.text ?? null;
  if (tafText) {
    const category = tafCategoryAt(tafText, atTime);
    if (category) return { category, source: 'TAF' };
  }
  const metar = await fetchMetar(code).catch(() => null);
  const metarText = metar?.text ?? state.metar[code]?.text ?? null;
  return { category: metarCategory(metarText), source: metarText ? 'METAR' : null };
}

// ---- Anticipated delay (holding / traffic fuel) ----

// How far either side of our own ETA still counts as "around the same
// time", the width of a bar on the traffic chart, and how far either side of
// it the chart reaches. None of this is exact; it is a sensible-rules
// estimate, the same spirit as auto roster.
const ARRIVAL_WINDOW_MIN = 45;
const BUCKET_MIN = 30;
const CHART_SPAN_MIN = 120;

// The bands a destination's traffic is sorted into, and the extra fuel that
// goes with each, in minutes. Weather pushes a destination up a band: worse
// conditions mean more spacing between arrivals for the same number of them.
export const DELAY_BANDS = [
  { max: 9, minutes: 15, label: 'Light' },
  { max: 19, minutes: 30, label: 'Moderate' },
  { max: 29, minutes: 45, label: 'Busy' },
  { max: 39, minutes: 60, label: 'High' },
  { max: Infinity, minutes: 90, label: 'Severe' },
];
const WEATHER_BAND_BUMP = { VFR: 0, MVFR: 0, IFR: 1, LIFR: 2 };
const WEATHER_SCORE = { VFR: 0, MVFR: 8, IFR: 20, LIFR: 35 };

function bandFor(arrivals, weather) {
  const base = DELAY_BANDS.findIndex((b) => arrivals <= b.max);
  return Math.min(DELAY_BANDS.length - 1, base + (weather ? WEATHER_BAND_BUMP[weather] : 0));
}

// A 0-100 read of the same thing, for the headline badge: how far through
// "every slot full" the traffic count is, nudged by the weather.
function congestionScore(arrivals, weather) {
  const raw = (arrivals / 45) * 75 + (weather ? WEATHER_SCORE[weather] : 0);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

// Full / partial / unstaffed, from who is on frequency at the airport
// (see fetchStations). Holding is worked by ATC; an airport nobody is
// controlling falls back to everyone self-sequencing over the radio.
function atcCoverage(stations) {
  const positions = new Set(
    (stations?.controllers || [])
      .map((c) => /_(DEL|GND|TWR|APP|DEP)$/.exec(c.callsign.toUpperCase())?.[1])
      .filter(Boolean),
  );
  if (!positions.size) return { label: 'Unstaffed', detail: 'No ATC online' };
  if (positions.has('APP') && (positions.has('TWR') || positions.has('DEP'))) return { label: 'Full', detail: 'Approach + Tower' };
  return { label: 'Partial', detail: [...positions].sort().join(' + ') };
}

// Our own best guess at when this sector lands: the running estimate if the
// day is being tracked, otherwise simply the published arrival.
function expectedEta(sector, now = Date.now()) {
  const row = running(now).times.get(sector.id);
  return row?.estOn ?? new Date(sector.sta).getTime();
}

// Who else is at the same airport around the same time, worked out the same
// way the Dashboard works out our own ETA: straight-line distance over
// present ground speed. A prefiled flight with nobody connected yet has no
// position to work an ETA from, so it is not counted; it would be guesswork
// on top of a guess. Departures have no equivalent "ETD" on VATSIM, so what
// is counted there is simply who is on the ground at the airport, filed to
// leave it, right now.
//
// buckets covers the chart: every arrival with an ETA within CHART_SPAN_MIN
// of ours, sorted into BUCKET_MIN-wide slots either side of it.
async function trafficAround(dest, eta) {
  const feed = await vatsimFeed();
  await loadAirports();
  const arrApt = airport(dest);
  const own = teamCallsign();
  const bucketMs = BUCKET_MIN * 60000;
  const counts = new Map();
  let arrivals = 0;
  let departures = 0;

  for (const p of feed.pilots || []) {
    if (p.callsign?.toUpperCase() === own) continue;
    const fp = p.flight_plan;
    if (!fp) continue;
    const onGround = !p.groundspeed || p.groundspeed < 40;
    if (onGround && fp.departure?.toUpperCase() === dest) departures++;
    if (!arrApt || fp.arrival?.toUpperCase() !== dest || onGround || p.groundspeed < 80) continue;
    const remaining = distNm(p.latitude, p.longitude, arrApt.lat, arrApt.lon);
    const otherEta = Date.now() + (remaining / p.groundspeed) * 3600000;
    if (Math.abs(otherEta - eta) <= ARRIVAL_WINDOW_MIN * 60000) arrivals++;
    if (Math.abs(otherEta - eta) <= CHART_SPAN_MIN * 60000) {
      const key = Math.round(otherEta / bucketMs) * bucketMs;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const etaBucket = Math.round(eta / bucketMs) * bucketMs;
  const buckets = [];
  for (let at = etaBucket - CHART_SPAN_MIN * 60000; at <= etaBucket + CHART_SPAN_MIN * 60000; at += bucketMs) {
    buckets.push({ at, count: counts.get(at) || 0, own: at === etaBucket });
  }
  return { arrivals, departures, buckets };
}

// Predicts how much holding or sequencing a sector is likely to pick up, from
// who else is arriving at the same airport around the same time and what the
// TAF expects the weather to be doing there when we land, and saves it so
// SimBrief can be asked to plan the extra fuel for it. The crew's own choice
// of how much to actually take (delay.chosen) survives a refresh; only a
// first look at a sector sets it to the recommendation.
export async function estimateArrivalDelay(sector) {
  const dest = sector.arr;
  const eta = expectedEta(sector);
  const prev = state.delay[sector.id];

  let arrivals = 0;
  let departures = 0;
  let buckets = [];
  let feedOk = true;
  try {
    ({ arrivals, departures, buckets } = await trafficAround(dest, eta));
  } catch {
    feedOk = false;
  }

  const stations = await fetchStations(dest).catch(() => state.stations[dest] || null);
  const { category: weather, source: weatherSource } = await weatherAt(dest, eta);

  const band = DELAY_BANDS[bandFor(arrivals, weather)];
  const result = {
    sectorId: sector.id,
    dest,
    eta,
    arrivals,
    departures,
    buckets,
    weather,
    weatherSource,
    atc: atcCoverage(stations),
    band: band.label,
    minutes: band.minutes,
    score: congestionScore(arrivals, weather),
    chosen: prev?.chosen ?? band.minutes,
    feedOk,
    at: Date.now(),
  };
  state.delay[sector.id] = result;
  save();
  return result;
}

export const delayOf = (sectorId) => state.delay[sectorId] || null;

// The crew's own pick from the Briefing's slider, in place of the
// recommendation, for however much holding fuel they actually want to carry.
export function setChosenDelay(sectorId, minutes) {
  const d = state.delay[sectorId];
  if (!d) return;
  d.chosen = Math.max(0, Math.min(90, Math.round(minutes / 5) * 5));
  save();
}

// ---- SimBrief ----

// Opens SimBrief with the sector filled in: the team's callsign (QFA100, not the
// WorldFlight sector number), and the scheduled departure date, time and block
// time, all in UTC. extraMinutes, from estimateArrivalDelay, is sent as extra
// fuel in minutes, which SimBrief turns into a weight itself.
export function simbriefPlanUrl(sector, extraMinutes) {
  const callsign = teamCallsign();
  // The airframe wins when there is one: SimBrief then uses that aeroplane's
  // own weights and layout rather than a generic one of the type.
  const q = new URLSearchParams({ orig: sector.dep, dest: sector.arr, type: teamAirframe() || teamAircraft(), callsign });
  const m = /^([A-Z]{3})(\d+[A-Z]?)$/.exec(callsign);
  if (m) {
    q.set('airline', m[1]);
    q.set('fltnum', m[2]);
  }
  const std = new Date(sector.std);
  if (!isNaN(std)) {
    const pad = (n) => String(n).padStart(2, '0');
    const mon = 'JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC'.substr(std.getUTCMonth() * 3, 3);
    q.set('date', `${pad(std.getUTCDate())}${mon}${pad(std.getUTCFullYear() % 100)}`);
    q.set('deph', pad(std.getUTCHours()));
    q.set('depm', pad(std.getUTCMinutes()));
    const block = Math.round((new Date(sector.sta) - std) / 60000);
    if (block > 0) {
      q.set('steh', pad(Math.floor(block / 60)));
      q.set('stem', pad(block % 60));
    }
  }
  if (sector.route) q.set('route', sector.route);
  if (extraMinutes > 0) {
    q.set('addedfuel', String(Math.round(extraMinutes)));
    q.set('addedfuel_units', 'min');
    q.set('addedfuel_label', 'HOLD/TFC');
  }
  return `${SIMBRIEF_PLAN}?${q}`;
}

// The latest flight plan generated by a SimBrief account, cut down to what a briefing needs.
// id: SimBrief username or Pilot ID.
export async function fetchOfp(id) {
  const key = /^\d+$/.test(id) ? 'userid' : 'username';
  const res = await fetch(`${SIMBRIEF_FETCH}?${key}=${encodeURIComponent(id)}&json=1`, {
    cache: 'no-store',
  });
  const d = await res.json().catch(() => null);
  if (!d || !d.origin) {
    throw new Error(d?.fetch?.status || `SimBrief returned HTTP ${res.status}`);
  }
  const num = (v) => (v == null || v === '' || isNaN(v) ? null : Number(v));
  const str = (v) => (typeof v === 'string' ? v : '');
  // The fixes along the filed route, lat/lon each, so the dashboard map can
  // draw the actual route rather than a straight dep-arr line. SimBrief gives
  // one object when there is a single fix and an array otherwise.
  const fixes = d.navlog?.fix ? (Array.isArray(d.navlog.fix) ? d.navlog.fix : [d.navlog.fix]) : [];
  const navlog = fixes
    .map((f) => ({ ident: str(f.ident), lon: num(f.pos_long), lat: num(f.pos_lat) }))
    .filter((f) => f.lon != null && f.lat != null);
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
    navlog,
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

// Everyone except observers writes briefings; the cockpit tablet does too,
// since the handover is written on the flight deck.
export const canReport = () => !configured || ['admin', 'dispatcher', 'operations', 'pilot', 'efb'].includes(me()?.role);

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

// ---- CTWO+ Briefing ----

// A section's points, in the team's own wording if an admin has set any,
// otherwise the defaults every team starts with.
export function ctwoItems(leg, section) {
  const custom = state.settings?.rules?.ctwo?.[leg]?.[section];
  return Array.isArray(custom) && custom.length ? custom : CTWO_DEFAULTS[leg][section];
}

// Saves one section's points for the whole team, for every sector's briefing
// to follow. Only an admin does this - see isAdmin() - so it always goes to
// the team database; there is nothing useful to keep locally in preview mode.
export async function saveCtwoItems(leg, section, items) {
  const rulesNext = { ...(state.settings?.rules || {}) };
  const ctwo = { ...(rulesNext.ctwo || {}) };
  ctwo[leg] = { ...(ctwo[leg] || {}), [section]: items };
  rulesNext.ctwo = ctwo;
  await saveSettings({ rules: rulesNext });
  await syncTeam();
}

// One sector's progress through a leg's briefing: which points are ticked and
// which sections have been marked complete. Kept with the sector's briefing.
export const ctwoOf = (sectorId, leg) => briefingOf(sectorId).ctwo?.[leg] || {};

// Updates this device's copy straight away - ticking a box should never wait
// on a round trip - then sends it on to the team database in the background.
// Other devices pick it up on the next sync a few seconds later, the same as
// any other change nobody is actively watching for.
export function saveCtwoProgress(sectorId, leg, legState) {
  const existing = state.briefings.find((b) => b.sector_id === sectorId);
  const ctwo = { ...(existing?.ctwo || {}), [leg]: legState };
  if (existing) existing.ctwo = ctwo;
  else state.briefings.push({ sector_id: sectorId, ctwo });
  save();
  if (configured && getSession()) return saveBriefing(sectorId, { ctwo }).catch(() => {});
}

// One aeroplane, one callsign, one SimBrief account for the whole team. They
// are kept with the team's settings so everyone's app agrees; an admin changes
// them in Admin -> Rules. The fallbacks are only for preview mode, before a
// database is connected.
export const teamCallsign = () => (state.settings?.rules?.callsign || 'QFA100').trim().toUpperCase();
export const teamAircraft = () => (state.settings?.rules?.aircraft || 'B738').trim().toUpperCase();
export const teamSimbrief = () => (state.settings?.simbrief || '').trim();
// A reader's name for the team's ICAO aircraft type, for the flight deck
// header bar. Falls back to the ICAO code itself for anything not listed.
const AIRCRAFT_NAMES = {
  B737: '737-700', B738: '737-800', B739: '737-900', B37M: '737 MAX 8',
  A319: 'A319', A320: 'A320', A321: 'A321', A20N: 'A320neo', A21N: 'A321neo',
  B77W: '777-300ER', B788: '787-8', B789: '787-9', B78X: '787-10', A388: 'A380',
};
export const teamAircraftName = () => AIRCRAFT_NAMES[teamAircraft()] || teamAircraft();
// Where SimBrief lives. If SimBrief ever moves these, it is a code change.
const SIMBRIEF_PLAN = 'https://dispatch.simbrief.com/options/custom';
const SIMBRIEF_FETCH = 'https://www.simbrief.com/api/xml.fetcher.php';

// A custom airframe saved in the team's SimBrief account: its own weights,
// layout and registration. SimBrief takes the airframe's internal id in place
// of the aircraft type, so one or the other goes in the same field.
export const teamAirframe = () => (state.settings?.rules?.airframe || '').trim();

// The team's registration. SimBrief keeps it on the airframe, not on the
// flight, so every OFP the team generates comes back with the same one - and
// there is no way to ask SimBrief for an airframe on its own, only for a plan
// made with it. So the rego is read from whichever OFP was imported most
// recently and then stands for the whole event: import one on any sector and
// every sector knows the aeroplane. Empty until somebody imports a plan, or
// if the airframe in SimBrief has no registration set against it.
export function teamRego() {
  return (
    state.briefings
      .map((b) => b.ofp)
      .filter((o) => o?.reg)
      .sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0))[0]?.reg || ''
  ).trim().toUpperCase();
}

// The one VATSIM account the team flies the whole event on, and the SELCAL
// vPilot connects with. Kept here beside the callsign because they are the
// same kind of thing - the aeroplane's identity, not a person's - and set in
// Admin -> Settings.
//
// The CID is here to be checked against, not used to log in: vPilot holds the
// VATSIM credentials in its own settings and nothing in the EFB can change
// them. The password is never stored anywhere in this app.
export const teamVatsimCid = () => String(state.settings?.rules?.vatsimCid || '').trim();
export const teamSelcal = () => String(state.settings?.rules?.selcal || '').trim().toUpperCase();
// The aeroplane and the SimBrief account are the team's identity, so they are
// an admin's or operations' to set, not everyday roster work.
export const canSetSimbrief = () => ['admin', 'operations'].includes(me()?.role);
export const simbriefId = () => teamSimbrief();
