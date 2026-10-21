// vPilot on the flight deck: what the radio on the pilot's PC is doing, and
// driving it from the EFB.
//
// A plugin inside vPilot keeps the vpilot_* tables up to date through the
// vpilot-plugin Edge Function; the tables are in supabase/vpilot.sql and the
// plugin is its own repository. This module is the app's side of it: it polls
// the picture while something is watching, and sends commands back.
//
// Nothing here is kept in store.js, unlike the rest of the app. A radio
// frequency and a message window are true for as long as vPilot is running
// and no longer, and reading a week-old picture out of localStorage on a cold
// start would be worse than having none: the panel would say the aeroplane
// was on 120.5 when vPilot is not even open. So it lives in this module and
// starts empty.
//
// Push-to-talk is deliberately absent, here and in the plugin: a "PTT on"
// whose "off" was lost on a flaky connection would leave a microphone keyed
// on a live frequency.

import {
  configured,
  fetchVpilot,
  fetchVpilotResult,
  vpilotCommand,
  vpilotForgetPlugin,
  vpilotResync,
} from './api.js';
import { teamAircraft, teamCallsign, teamSelcal, teamVatsimCid } from './ops.js';

// Two seconds while a panel is open: the message window and the frequencies
// are worth that, and the TX/RX lights flicker far faster than any polling
// could follow anyway.
const POLL_MS = 2000;
// The plugin talks to the EFB at least every 25 s, so a longer silence than
// this means vPilot, or the PC, has gone without saying goodbye.
const STALE_AFTER_MS = 70000;
// How long to wait for vPilot's own answer to a command.
const ANSWER_MS = 20000;
const ANSWER_POLL_MS = 500;

// null for link until the first read answers; null after it means this
// database has no vpilot.sql, and the app leaves vPilot out.
let picture = { link: null, messages: [], controllers: [] };
let known = false;
const watchers = new Set();
let timer = null;
let reading = null;

// ---------- The picture ----------

export const vpilotPicture = () => picture;

// False until supabase/vpilot.sql has been run, so a view can leave itself
// out entirely rather than showing an empty radio.
export const vpilotReady = () => known && !!picture.link;

// Whether the first read has come back at all. vpilotKnown() without
// vpilotReady() is the one case worth a word to an admin: the database has no
// vPilot tables yet.
export const vpilotKnown = () => known;

// The plugin is talking to the EFB. Worked out from when it was last heard
// rather than trusted from the row, so a PC that lost power reads as gone.
export function vpilotOnline() {
  const link = picture.link;
  if (!link?.online || !link.last_seen_at) return false;
  return Date.now() - new Date(link.last_seen_at).getTime() < STALE_AFTER_MS;
}

// The team flies the whole event on one VATSIM account, so a vPilot connected
// under a different CID is worth saying out loud: it means the sim PC is
// logged in as somebody's personal account, and the flight will not show up as
// the team's. Returns the CID vPilot is actually using, or null when it
// matches the team's (or nothing is set to compare).
export function vpilotCidMismatch() {
  const flying = String(picture.link?.cid || '').trim();
  const team = teamVatsimCid();
  if (!flying || !team || flying === team) return null;
  return flying;
}

// Which of the extras this vPilot gives up: radios, radio-activity, notices,
// sent, names, voice, tabs. They come from vPilot's internals rather than its
// plugin API, so a vPilot update can take them away and the panel should hide
// that part of itself instead of showing nothing.
export const vpilotHas = (feature) => !!picture.link?.features?.includes(feature);

// vPilot gives a frequency as its own 25 kHz code, in kHz, or in Hz,
// depending which part of vPilot the number came from.
export function vpilotFrequency(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value === 0) return null;
  if (value > 1000000) return (value / 1000000).toFixed(3);
  if (value > 100000) return (value / 1000).toFixed(3);
  return ((value + 100000) / 1000).toFixed(3);
}

// A squawk is four octal digits; vPilot keeps it as a number.
export function vpilotSquawk(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return String(value).padStart(4, '0').slice(-4);
}

// The radio stack, out of the jsonb that holds it exactly as vPilot reported.
export function vpilotRadios() {
  const radios = picture.link?.radios || {};
  const lights = picture.link?.com_activity || {};
  const com = (n) => ({
    frequency: vpilotFrequency(radios[`com${n}`]),
    tx: !!radios[`com${n}Tx`],
    rx: !!radios[`com${n}Rx`],
    transmitting: !!lights[`com${n}`]?.tx,
    receiving: !!lights[`com${n}`]?.rx,
  });
  return {
    com1: com(1),
    com2: com(2),
    squawk: picture.link?.squawk ? vpilotSquawk(picture.link.squawk) : null,
    modeC: picture.link?.mode_c ?? null,
    ident: picture.link?.ident ?? null,
    voiceConnected: picture.link?.voice_connected ?? null,
  };
}

// ---------- Keeping it up to date ----------

async function read() {
  try {
    picture = await fetchVpilot();
    known = true;
  } catch {
    // Offline, or signed out. The last picture stands; vpilotOnline() will
    // go false by itself once it is old enough.
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
export function syncVpilot() {
  reading ??= read().finally(() => (reading = null));
  return reading;
}

function tick() {
  if (!watchers.size) return;
  syncVpilot();
}

// A view calls this while it is on screen and calls what it returns when it
// goes away. Polling runs only while somebody is watching, so vPilot costs
// nothing on the pages that do not show it.
//
// app.js has a mounted() hook but nothing for leaving a page, so a view that
// watches has to let go itself. A page that only shows the state as it stands
// wants syncVpilot() in mounted() and a rerender, not this.
export function watchVpilot(onPicture) {
  if (!configured) return () => {};
  watchers.add(onPicture);
  if (!timer) timer = setInterval(tick, POLL_MS);
  syncVpilot();
  return () => {
    watchers.delete(onPicture);
    if (!watchers.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

// A tablet left on the flight deck spends hours with the screen off. Polling
// a radio nobody is looking at is pure battery, so it stops with the screen
// and picks up where it left off.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    } else if (watchers.size && !timer) {
      timer = setInterval(tick, POLL_MS);
      syncVpilot();
    }
  });
}

// A panel coming back to the front wants the picture now, not in two seconds.
export const wakeVpilot = () => (watchers.size ? syncVpilot() : Promise.resolve());

// ---------- Driving it ----------

// Queues a command and waits for what vPilot made of it, so a button can
// report vPilot's own words - "No COM radio is set to transmit, or the
// avionics are off." - rather than a hopeful tick.
async function run(kind, args = {}) {
  let seq;
  try {
    seq = await vpilotCommand(kind, args);
  } catch (err) {
    // Everything vpilot_command refuses outright: not allowed, vPilot not
    // connected, nothing to send.
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
      // The picture is a poll behind after anything that changes vPilot.
      syncVpilot();
      return { ok: !!row.ok, error: row.error || null };
    }
    if (Date.now() >= until) return { ok: false, error: 'vPilot did not answer' };
    await new Promise((done) => setTimeout(done, ANSWER_POLL_MS));
  }
}

const icao = (value) => String(value ?? '').trim().toUpperCase();

export const sendRadio = (message) => run('radio', { message });
export const sendPrivate = (to, message) => run('private', { to: icao(to), message });
export const requestMetar = (station) => run('metar', { station: icao(station) });
export const requestAtis = (callsign) => run('atis', { callsign: icao(callsign) });
export const setModeC = (on) => run('mode-c', { on: !!on });
export const squawkIdent = () => run('ident');
export const openChat = (callsign) => run('open-chat', { callsign: icao(callsign) });
export const closeChat = (callsign) => run('close-chat', { callsign: icao(callsign) });

// Connecting vPilot to VATSIM from the EFB. Defaults to the aeroplane the
// team is flying (Admin -> Settings), because that is what it always is; pass
// something else only to override it for one connect.
//
// The account is whatever vPilot itself is signed in as: the plugin API takes
// a callsign, a type and a SELCAL, and nothing else. See vpilotCidMismatch().
export const connectVpilot = (callsign, typeCode, selcal) =>
  run('connect', {
    callsign: icao(callsign || teamCallsign()),
    typeCode: icao(typeCode || teamAircraft()),
    selcal: icao(selcal || teamSelcal()),
  });
export const connectAsObserver = (callsign) => run('connect-observer', { callsign: icao(callsign || teamCallsign()) });
export const disconnectVpilot = () => run('disconnect');

// Makes the plugin resend everything it knows, for a picture that looks wrong.
export async function resyncVpilot() {
  try {
    await vpilotResync();
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Lets a different vPilot install claim the EFB: the key the first plugin
// claimed it with is forgotten, and the next plugin to connect takes it.
// Admin only, because that key is what stops anybody else's vPilot taking the
// team's radio.
export async function forgetVpilotPlugin() {
  try {
    await vpilotForgetPlugin();
    await syncVpilot();
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
