// ACARS and CPDLC on the flight deck: the datalink station on the sim PC,
// and driving it from the EFB.
//
// The station itself is in the bridge (bridge/Integrations/AcarsIntegration.cs
// in the vpilot-plugin repository). It has to be: Hoppie's endpoint sends no
// CORS headers, so a browser cannot call it at all, and the receipt printer
// is on that PC anyway. The bridge polls Hoppie, keeps the CPDLC thread,
// prints what arrives and reports all of it through the vpilot-plugin Edge
// Function; the acars_* tables are in supabase/acars.sql.
//
// So this module is the app's side of it, and it is deliberately the same
// shape as js/vpilot.js: it polls while a panel is open, sends commands back,
// and keeps nothing. A clearance is true for as long as the flight is, and a
// CPDLC uplink restored from localStorage on a cold start - with the bridge
// not even running - would be worse than an empty screen. It starts empty on
// every visit, by design.
//
// The Hoppie logon code is never read by this module, or by any other part of
// the app. An admin writes it and the database only ever hands it to the
// bridge. See supabase/acars.sql.

import { acarsCommand, configured, fetchAcars, fetchVpilotResult } from './api.js';
import { teamCallsign } from './ops.js';

// Two seconds while a panel is open, like vPilot: a clearance arriving is
// worth that. The bridge polls Hoppie every 45-75 s as Hoppie asks, so this
// is never the slow part.
const POLL_MS = 2000;
// The bridge talks to the EFB at least every 25 s. A longer silence than this
// means the sim PC has gone without saying goodbye.
const STALE_AFTER_MS = 70000;
// How long to wait for the bridge's own answer to a command. Longer than
// vPilot's, because a Hoppie request may take its full 15 s timeout before
// the bridge can say anything.
const ANSWER_MS = 30000;
const ANSWER_POLL_MS = 500;

// null for state until the first read answers; null after it means this
// database has no acars.sql and the app leaves ACARS out.
let picture = { state: null, messages: [] };
let known = false;
const watchers = new Set();
let timer = null;
let reading = null;

// ---------- The picture ----------

export const acarsPicture = () => picture;

// False until supabase/acars.sql has been run, so a view can leave itself out
// entirely rather than showing a dead panel.
export const acarsReady = () => known && !!picture.state;

// Whether the first read has come back at all. acarsKnown() without
// acarsReady() is the one case worth a word to an admin: the database has no
// ACARS tables yet.
export const acarsKnown = () => known;

// The station can talk: switched on, with a logon code and a callsign, and
// the bridge is actually there to do it.
export const acarsLive = () => !!picture.state?.live && acarsOnline();

// Whether a Hoppie logon code is set at all.
export const acarsConfigured = () => !!picture.state?.configured;

export const acarsEnabled = () => !!picture.state?.enabled;

// The bridge is talking to the EFB. Worked out from when the station last
// said anything rather than trusted from the row, so a sim PC that lost power
// reads as gone. The ACARS row is only written when the bridge reports, which
// makes updated_at the right thing to measure.
export function acarsOnline() {
  const at = picture.state?.updated_at;
  if (!at) return false;
  return Date.now() - new Date(at).getTime() < STALE_AFTER_MS;
}

// The CPDLC unit this flight is logged on to, or null.
export const acarsAtcUnit = () => picture.state?.atc_unit || null;

// A unit that has been asked for a logon and has not answered yet. A
// controller who does not provide CPDLC simply never answers, and the bridge
// gives up after five minutes.
export const acarsLogonPending = () => picture.state?.logon_pending || null;

// The message numbers of uplinks still waiting on an answer from the crew.
// This is the one thing on the page that is genuinely urgent.
export const acarsOwing = () => picture.state?.owing || [];

// The receipt printer, as the bridge finds it: which one, how wide, whether
// Windows can see it, and what went wrong last.
export const acarsPrinter = () => picture.state?.printer || {};

// Whether anything can be printed at all, so a Print button can be left out
// rather than offered and refused.
export const acarsCanPrint = () => !!acarsPrinter().enabled;

// OUT, OFF, ON and IN as the bridge reported them.
export const acarsTimes = () => picture.state?.times || {};

// Hoppie's own words when it last refused something - "illegal logon code" is
// the common one. Shown verbatim, because it is what an admin needs to act on.
export const acarsTrouble = () => picture.state?.trouble || null;

// The uplinks that are waiting on an answer, newest first, with the answers
// each one allows. What the ATC tab puts at the top.
export function acarsAwaitingReply() {
  const owing = new Set(acarsOwing().map(Number));
  if (!owing.size) return [];
  return picture.messages
    .filter((m) => m.direction === 'uplink' && m.msg_no != null && owing.has(Number(m.msg_no)))
    .reverse();
}

// ---------- Keeping it up to date ----------

async function read() {
  try {
    picture = await fetchAcars();
    known = true;
  } catch {
    // Offline, or signed out. The last picture stands; acarsOnline() will go
    // false by itself once it is old enough.
  }
  for (const watcher of watchers) {
    try {
      watcher(picture);
    } catch {
      // A view that throws while drawing must not stop the next poll.
    }
  }
}

// Only one read in flight, however many views ask at once.
export function syncAcars() {
  reading ??= read().finally(() => (reading = null));
  return reading;
}

function tick() {
  if (!watchers.size) return;
  syncAcars();
}

// A view calls this while it is on screen and calls what it returns when it
// goes away. Polling runs only while somebody is watching, so ACARS costs
// nothing on the pages that do not show it.
export function watchAcars(onPicture) {
  if (!configured) return () => {};
  watchers.add(onPicture);
  if (!timer) timer = setInterval(tick, POLL_MS);
  syncAcars();
  return () => {
    watchers.delete(onPicture);
    if (!watchers.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// A tablet left on the flight deck spends hours with the screen off. Polling
// for clearances nobody is looking at is pure battery, so it stops with the
// screen and picks up where it left off.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    } else if (watchers.size && !timer) {
      timer = setInterval(tick, POLL_MS);
      syncAcars();
    }
  });
}

export const wakeAcars = () => (watchers.size ? syncAcars() : Promise.resolve());

// ---------- Driving it ----------

// Queues a command and waits for what the bridge made of it, so a button can
// report Hoppie's own words - "illegal logon code", "callsign already in
// use" - rather than a hopeful tick.
async function run(kind, args = {}) {
  let seq;
  try {
    seq = await acarsCommand(kind, args);
  } catch (err) {
    // Everything vpilot_command refuses outright: not allowed, the sim PC not
    // connected, nothing to send, an ACARS command the bridge does not know.
    return { ok: false, error: err.message };
  }

  const until = Date.now() + ANSWER_MS;
  for (;;) {
    let row;
    try {
      row = await fetchVpilotResult(seq);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (row?.result_at) {
      // The picture is a poll behind after anything that changes the station.
      syncAcars();
      return { ok: !!row.ok, error: row.error || null };
    }
    if (Date.now() >= until) return { ok: false, error: 'The simulator PC did not answer' };
    await new Promise((done) => setTimeout(done, ANSWER_POLL_MS));
  }
}

const station = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---- Telex and weather ----

export const sendTelex = (to, message) => run('acars-telex', { to: station(to), message });

// METAR, TAF, short TAF, and the ATIS from whichever network. Hoppie answers
// these immediately rather than on a poll, so the reply is usually in the
// window by the time the button finishes.
export const requestInfo = (request, icao) =>
  run('acars-info', { request: String(request || '').toLowerCase(), icao: station(icao) });

export const requestMetar = (icao) => requestInfo('metar', icao);
export const requestTaf = (icao) => requestInfo('taf', icao);
export const requestAtis = (icao) => requestInfo('vatatis', icao);

// A pre-departure clearance. The bridge builds the request in the shape the
// controller clients expect; pass body to send something else entirely.
export const requestPdc = (to, fields = {}) =>
  run('acars-pdc', {
    to: station(to),
    callsign: station(fields.callsign || teamCallsign()),
    type: station(fields.type),
    dep: station(fields.dep),
    arr: station(fields.arr),
    stand: String(fields.stand ?? '').trim(),
    atis: String(fields.atis ?? '').trim(),
    freetext: String(fields.freetext ?? '').trim(),
    ...(fields.body ? { body: String(fields.body) } : {}),
  });

// ---- CPDLC ----

export const logonAtc = (to) => run('acars-logon', { to: station(to) });
export const logoffAtc = () => run('acars-logoff');

// WILCO, UNABLE, STANDBY, ROGER, AFFIRM, NEGATIVE. The uplink is named by its
// own message number and the bridge works out the rest, so nothing here has
// to build a CPDLC packet.
export const replyToAtc = (msgNo, answer, message = '') =>
  run('acars-reply', {
    mrn: Number(msgNo),
    answer: String(answer || '').toUpperCase(),
    ...(message.trim() ? { message: message.trim() } : {}),
  });

// A request to the unit this flight is logged on to: a level, a direct, free
// text. The wording is the crew's; the bridge only carries it.
export const requestFromAtc = (message, to = '') =>
  run('acars-request', { message: String(message ?? '').trim(), ...(to ? { to: station(to) } : {}) });

// ---- Reports ----

export const sendPosition = () => run('acars-position');
export const sendProgress = () => run('acars-progress');

// ---- The station itself ----

// Checks the link and the logon code without registering this station as
// online, which is what makes it safe to do before a flight.
export const pingHoppie = () => run('acars-ping');

// Asks Hoppie now rather than waiting out the interval.
export const pollNow = () => run('acars-poll');

// ---- The printer ----

// Prints a message again. A message the bridge still remembers is named by
// its reference; anything older is reprinted by sending the text back, which
// is what the window is showing anyway.
export function printAgain(message) {
  if (!message) return Promise.resolve({ ok: false, error: 'There is nothing to print' });
  return run('acars-print', {
    reference: message.reference || '',
    text: message.body || '',
    from: message.from_station || '',
    kind: message.kind || 'telex',
  });
}

export const testPrinter = () => run('acars-test-print');
