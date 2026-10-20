// Calling, inside the app: the flight deck and the ops controller on shift can
// talk to each other without either of them leaving the EFB.
//
// The audio goes straight between the two devices (WebRTC). Supabase Realtime
// carries only the handshake - an offer, an answer and a list of the network
// paths each end can be reached on - and the whole exchange takes about a
// second. Nothing is recorded and nothing passes through a server.
//
// Ringing somebody needs their app to be running, which is the one thing a web
// app cannot get around: a closed app cannot be woken the way a phone call
// wakes a phone. So calling also asks the database to send a notification -
// "Ops is calling" - which lands within about ten seconds and opens the panel
// when it is tapped. See ring_ops() in supabase/ops-call.sql.

import { state } from './store.js';
import { esc, icon } from './ui.js';
import { canOpsChat, opsDeskReady, person, shortName, sideOf, whoToCall } from './ops.js';
import { getSession, ringOps } from './api.js';
import { channel } from './realtime.js';
import { startRing, stopRing, endTone } from './tone.js';

// How a call finds a path between two devices. The public STUN servers are
// enough on most home and office connections: they only tell each end what its
// own address looks like from outside.
//
// A phone on mobile data behind carrier NAT often has no direct path at all,
// and then the call needs a relay to go through instead. Put TURN credentials
// in here and that is what happens; Cloudflare gives them away, and any coturn
// will do. Without one, a call between two such devices will say it could not
// connect rather than quietly failing.
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
// e.g. { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
const TURN = null;

const TOPIC = 'ops-call';
const RING_SECONDS = 45;

const audio = document.getElementById('ops-call-audio');

let line = null; // the Realtime channel, opened the first time it is wanted
let lineProblem = '';
let onChange = () => {};

// The call in progress, or null. state is one of:
//   'out'        ringing somebody
//   'in'         somebody is ringing us
//   'connecting' they answered; the two ends are finding each other
//   'talking'    audio both ways
let call = null;
let timer = null;

const uuid = () =>
  crypto.randomUUID?.() ||
  `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`;

const myId = () => getSession()?.userId;
const named = (id) => (person(id)?.role === 'efb' ? person(id)?.display_name : shortName(person(id)?.display_name)) || 'Unknown';
const sideWord = (id) => (sideOf(id) === 'ops' ? 'ops desk' : 'flight deck');

// ---- The signalling channel ----

export function listen() {
  if (line || !canOpsChat() || !opsDeskReady()) return;
  line = channel(TOPIC, {
    message: (event, payload) => {
      if (event !== 'signal') return;
      // Everything on the channel reaches everybody on it, so each end picks
      // out what is addressed to it and ignores the rest.
      if (Array.isArray(payload?.to) && !payload.to.includes(myId())) return;
      signal(payload).catch(() => fail('Something went wrong with the call.'));
    },
    status: (what) => {
      lineProblem = what === 'joined' || what === 'down' ? '' : what;
      onChange();
    },
  });
}

// Called when the app comes back to the front: a socket a phone put to sleep
// is no use for being rung on.
export const wake = () => line?.wake();

const say = (kind, extra = {}) =>
  line?.send('signal', { kind, callId: call?.id, from: myId(), ...extra });

// ---- Starting, answering, ending ----

async function microphone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This device cannot use its microphone in the app.');
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

function peerConnection() {
  const pc = new RTCPeerConnection({ iceServers: TURN ? [...ICE_SERVERS, TURN] : ICE_SERVERS });
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate && call?.peer) say('ice', { to: [call.peer], candidate: e.candidate.toJSON() });
  });
  pc.addEventListener('track', (e) => {
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {
      // Answering was the gesture that allows this, so a refusal here is odd;
      // the call is still up, and the card says so.
    });
  });
  pc.addEventListener('connectionstatechange', () => {
    if (!call) return;
    if (pc.connectionState === 'connected' && call.state !== 'talking') {
      call.state = 'talking';
      call.since = Date.now();
      stopRing();
      onChange();
    }
    if (pc.connectionState === 'failed') {
      fail(
        TURN
          ? 'The call could not find a path between the two devices.'
          : 'No direct path between the two devices. On mobile data this usually needs a relay; see TURN in js/opscall.js.',
      );
    }
    if (pc.connectionState === 'disconnected' && call.state === 'talking') {
      // Give it a moment: a phone changing from wifi to mobile data recovers.
      setTimeout(() => {
        if (call && pc.connectionState === 'disconnected') hangUp();
      }, 6000);
    }
  });
  return pc;
}

// Puts the line down and clears up, whatever state it was in.
function tidy() {
  stopRing();
  if (timer) clearTimeout(timer);
  timer = null;
  call?.mic?.getTracks().forEach((t) => t.stop());
  try {
    call?.pc?.close();
  } catch {
    // already closed
  }
  audio.srcObject = null;
  call = null;
  onChange();
}

function fail(why) {
  const had = !!call;
  tidy();
  lineProblem = why;
  if (had) endTone();
  onChange();
}

export async function startCall() {
  if (call) return;
  lineProblem = '';
  listen();
  const to = whoToCall();
  if (!to.length) {
    lineProblem = sideOf(myId()) === 'ops' ? 'No flight deck tablet is signed in.' : 'No ops controller to call.';
    return onChange();
  }
  if (!line?.joined) {
    lineProblem = lineProblem || 'Not connected to the call channel yet. Try again in a moment.';
    return onChange();
  }
  let mic;
  try {
    mic = await microphone();
  } catch (err) {
    lineProblem = /denied|not allowed/i.test(err.message)
      ? 'The microphone is not allowed on this device. Allow it for this site and try again.'
      : err.message;
    return onChange();
  }
  // Ring first and negotiate afterwards: the handshake is between two
  // devices, and until somebody picks up there is no second device to make it
  // with. The extra step across a WebSocket costs a fraction of a second.
  call = { id: uuid(), state: 'out', mic, pc: null, peer: null, ringing: to, pending: [], muted: false, since: 0 };
  say('ring', { to, fromName: named(myId()), fromSide: sideOf(myId()) });
  // The doorbell, for a phone with the app shut.
  ringOps(call.id).catch(() => {
    // No notifications on this database, or the file has not been run: the
    // call still rings every app that is open.
  });
  timer = setTimeout(() => {
    if (call?.state === 'out') {
      say('cancel', { to: call.ringing });
      fail('No answer.');
    }
  }, RING_SECONDS * 1000);
  onChange();
}

export async function answer() {
  if (call?.state !== 'in') return;
  let mic;
  try {
    mic = await microphone();
  } catch (err) {
    say('decline', { to: [call.peer] });
    return fail(
      /denied|not allowed/i.test(err.message)
        ? 'The microphone is not allowed on this device. Allow it for this site and try again.'
        : err.message,
    );
  }
  stopRing();
  call.mic = mic;
  call.state = 'connecting';
  // Whoever picked up first gets the call; the caller tells the others.
  say('pickup', { to: [call.peer] });
  if (timer) clearTimeout(timer);
  timer = null;
  onChange();
}

export function decline() {
  if (!call) return;
  say('decline', { to: [call.peer || ''].filter(Boolean) });
  tidy();
}

export function hangUp() {
  if (!call) return;
  say('bye', { to: [call.peer, ...(call.ringing || [])].filter(Boolean) });
  endTone();
  tidy();
}

export function toggleMute() {
  if (!call?.mic) return;
  call.muted = !call.muted;
  call.mic.getAudioTracks().forEach((t) => (t.enabled = !call.muted));
  onChange();
}

// ---- What the other end says ----

async function signal(msg) {
  const { kind } = msg;

  if (kind === 'ring') {
    // Already busy, or ringing somebody ourselves: let them know rather than
    // leaving them listening to nothing.
    if (call) return line?.send('signal', { kind: 'decline', callId: msg.callId, from: myId(), to: [msg.from] });
    call = { id: msg.callId, state: 'in', peer: msg.from, peerName: msg.fromName, pc: null, pending: [], muted: false, since: 0 };
    startRing();
    timer = setTimeout(() => {
      if (call?.state === 'in') fail('Missed a call.');
    }, RING_SECONDS * 1000);
    return onChange();
  }

  if (!call || msg.callId !== call.id) return;

  if (kind === 'pickup' && call.state === 'out') {
    // The first to answer takes it; the rest are told to stop ringing.
    call.peer = msg.from;
    call.state = 'connecting';
    const others = call.ringing.filter((id) => id !== msg.from);
    if (others.length) say('taken', { to: others });
    call.ringing = [];
    call.pc = peerConnection();
    call.mic.getTracks().forEach((t) => call.pc.addTrack(t, call.mic));
    const offer = await call.pc.createOffer();
    await call.pc.setLocalDescription(offer);
    say('offer', { to: [call.peer], sdp: call.pc.localDescription });
    return onChange();
  }

  if (kind === 'taken') {
    // Somebody else got there first.
    return tidy();
  }

  if (kind === 'offer' && call.state === 'connecting') {
    call.pc = peerConnection();
    call.mic.getTracks().forEach((t) => call.pc.addTrack(t, call.mic));
    await call.pc.setRemoteDescription(msg.sdp);
    for (const c of call.pending.splice(0)) await call.pc.addIceCandidate(c).catch(() => {});
    const reply = await call.pc.createAnswer();
    await call.pc.setLocalDescription(reply);
    return say('answer', { to: [call.peer], sdp: call.pc.localDescription });
  }

  if (kind === 'answer' && call.pc && !call.pc.currentRemoteDescription) {
    await call.pc.setRemoteDescription(msg.sdp);
    for (const c of call.pending.splice(0)) await call.pc.addIceCandidate(c).catch(() => {});
    return;
  }

  if (kind === 'ice') {
    // A path can arrive before the description it belongs to; it waits.
    if (call.pc?.remoteDescription) await call.pc.addIceCandidate(msg.candidate).catch(() => {});
    else call.pending.push(msg.candidate);
    return;
  }

  if (kind === 'decline') {
    if (call.state !== 'out') return tidy();
    call.ringing = call.ringing.filter((id) => id !== msg.from);
    // Still ringing somebody else; only give up when nobody is left.
    if (call.ringing.length) return onChange();
    return fail('The call was declined.');
  }

  if (kind === 'cancel' || kind === 'bye') {
    endTone();
    return tidy();
  }
}

// ---- The card in the panel ----

export const busy = () => !!call;
export const problem = () => lineProblem;
export const clearProblem = () => {
  lineProblem = '';
};
export const onCallChange = (fn) => (onChange = fn);

// How long it has been going, for the card. Counted here rather than with a
// timer of its own: the panel already repaints every second for the clock.
export function elapsed() {
  if (!call?.since) return '';
  const s = Math.floor((Date.now() - call.since) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function card() {
  if (!call) return '';
  const who = call.peer ? `${named(call.peer)} · ${sideWord(call.peer)}` : call.peerName || 'the other side';
  if (call.state === 'in') {
    return `
      <div class="ops-call ringing">
        <div class="ops-call-who"><span class="ops-call-label">INCOMING CALL</span>${esc(
          call.peerName || who,
        )}</div>
        <div class="ops-call-btns">
          <button class="btn primary" data-call="answer">Answer</button>
          <button class="btn danger" data-call="decline">Decline</button>
        </div>
      </div>`;
  }
  const label = call.state === 'out' ? 'CALLING' : call.state === 'connecting' ? 'CONNECTING' : 'ON THE LINE';
  return `
    <div class="ops-call">
      <div class="ops-call-who"><span class="ops-call-label">${label}</span>${esc(who)}
        <span class="ops-call-timer" data-call-timer>${elapsed()}</span></div>
      <div class="ops-call-btns">
        ${
          call.state === 'talking'
            ? `<button class="btn ghost" data-call="mute">${call.muted ? 'Unmute' : 'Mute'}</button>`
            : ''
        }
        <button class="btn danger" data-call="hangup">${call.state === 'talking' ? 'End' : 'Cancel'}</button>
      </div>
    </div>`;
}

export const actions = { answer, decline, hangup: hangUp, mute: toggleMute };

// The timer moves without a repaint: rebuilding the whole thread every second
// to shift two digits would be absurd.
setInterval(() => {
  if (call?.state !== 'talking') return;
  const el = document.querySelector('[data-call-timer]');
  if (el) el.textContent = elapsed();
}, 1000);
