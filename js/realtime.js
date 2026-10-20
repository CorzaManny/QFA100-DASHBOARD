// A small client for Supabase Realtime, which carries the handshake for a call
// between two devices in about a second. The chat itself is still polled; this
// is only for the things that cannot wait.
//
// Realtime speaks Phoenix channels over a WebSocket: JSON frames with a topic,
// an event, a payload and a reference number. There is no library here - the
// app has no build step and nothing installed - so the half dozen frames it
// needs are written out below.
//
// The channel is private, which means Realtime checks a policy on
// realtime.messages before letting anybody join (see supabase/ops-call.sql).
// Without that the handshake would be open to anyone holding the publishable
// key, which is in js/config.js for all to read.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { getSession } from './api.js';

const SOCKET_URL = `${SUPABASE_URL.trim().replace(/\/+$/, '').replace(/^http/, 'ws')}/realtime/v1/websocket`;
const HEARTBEAT_MS = 25000;
// Backs off to half a minute: a device in a hangar with no signal should not
// sit there hammering a socket it cannot open.
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

// name: the topic, shared by everyone on it. handlers: { message, status }.
// message is called with (event, payload) for anything broadcast by somebody
// else; status with 'joined', 'down', or a refusal in words.
export function channel(name, handlers = {}) {
  const topic = `realtime:${name}`;
  let ws = null;
  let ref = 0;
  let joinRef = '';
  let beat = null;
  let retry = null;
  let attempt = 0;
  let joined = false;
  let closed = false;

  const nextRef = () => String((ref += 1));

  const frame = (event, payload, t = topic) => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ topic: t, event, payload, ref: nextRef() }));
    return true;
  };

  const stopBeat = () => {
    if (beat) clearInterval(beat);
    beat = null;
  };

  function open() {
    if (closed) return;
    const token = getSession()?.access;
    if (!token) return schedule();
    try {
      ws = new WebSocket(`${SOCKET_URL}?apikey=${encodeURIComponent(SUPABASE_ANON_KEY)}&vsn=1.0.0`);
    } catch {
      return schedule();
    }

    ws.addEventListener('open', () => {
      joinRef = nextRef();
      // private: true is what makes Realtime check the policy. The access
      // token is who the policy is checked against - the publishable key in
      // the address only gets as far as the door.
      ws.send(
        JSON.stringify({
          topic,
          event: 'phx_join',
          payload: {
            config: { broadcast: { self: false }, presence: { key: '' }, private: true },
            access_token: getSession()?.access,
          },
          ref: joinRef,
        }),
      );
      stopBeat();
      beat = setInterval(() => {
        if (!frame('heartbeat', {}, 'phoenix')) return;
        // The socket outlives an access token, so the new one is handed over
        // as it is renewed rather than waiting for the join to be refused.
        const now = getSession()?.access;
        if (now && now !== token) frame('access_token', { access_token: now });
      }, HEARTBEAT_MS);
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // not ours to understand
      }
      if (msg.event === 'phx_reply' && msg.ref === joinRef) {
        if (msg.payload?.status === 'ok') {
          joined = true;
          attempt = 0;
          handlers.status?.('joined');
        } else {
          // Nearly always the policy: either supabase/ops-call.sql has not
          // been run, or this account is not allowed on the channel. Closing
          // the socket puts it on the same backing-off retry as a dropped
          // connection, so an expired token recovers by itself while a
          // missing policy is not hammered.
          joined = false;
          handlers.status?.(msg.payload?.response?.reason || 'The call channel would not accept this account.');
          ws.close();
        }
        return;
      }
      // What everybody else on the channel sends.
      if (msg.event === 'broadcast') handlers.message?.(msg.payload?.event, msg.payload?.payload);
    });

    const dropped = () => {
      stopBeat();
      if (joined) handlers.status?.('down');
      joined = false;
      schedule();
    };
    ws.addEventListener('close', dropped);
    ws.addEventListener('error', () => ws.close());
  }

  function schedule() {
    if (closed || retry) return;
    const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, wait);
  }

  open();

  return {
    // Everyone else on the channel gets this; the sender does not.
    send: (event, payload) => frame('broadcast', { type: 'broadcast', event, payload }),
    get joined() {
      return joined;
    },
    // A socket a phone put to sleep comes back the moment it is needed.
    wake() {
      if (closed || joined || ws?.readyState === WebSocket.CONNECTING) return;
      if (retry) {
        clearTimeout(retry);
        retry = null;
      }
      attempt = 0;
      open();
    },
    close() {
      closed = true;
      stopBeat();
      if (retry) clearTimeout(retry);
      ws?.close();
    },
  };
}
