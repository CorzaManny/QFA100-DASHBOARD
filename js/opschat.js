// The ops chat: one thread between the flight deck tablets and whichever of
// the ops controllers is on shift.
//
// It is a panel beside the page rather than a page of its own, open on every
// screen, because a question from the flight deck never waits for somebody to
// navigate somewhere. It docks over the right edge like the Twitch chat does,
// and only one of the two is ever out at a time - see the 'app:panel' event
// below and js/app.js.
//
// The shift roster behind "who is on" is built in Admin (Admin -> Ops Desk);
// the tables are in supabase/ops-chat.sql.

import { state, save } from './store.js';
import { esc, zulu, zdate, icon } from './ui.js';
import {
  canOpsChat,
  opsDeskReady,
  opsOnShift,
  nextOpsShift,
  person,
  syncOpsChat,
  sendToOps,
  unreadOps,
  markOpsRead,
} from './ops.js';
import { getSession } from './api.js';

// Calling the controller on shift. Nothing is wired up yet on purpose: put the
// team's call link in here - a Discord voice channel, a Jitsi room, even a
// tel: number - and the Call button in the panel comes alive, opening it in a
// new window. Empty, the button is there but plainly switched off.
const CALL_LINK = '';

const OPEN_KEY = 'qfa100-ops-chat-open';

const panel = document.getElementById('opspanel');
const toggle = document.getElementById('ops-toggle');
const unreadDot = document.getElementById('ops-unread');
const shiftStrip = document.getElementById('ops-shift');
const log = document.getElementById('ops-log');
const compose = document.getElementById('ops-compose');
const text = document.getElementById('ops-text');
const callBtn = document.getElementById('ops-call');

let open = false;
try {
  // Closed until asked for: unlike the Twitch chat this one has nothing to
  // show most of the time, and on a tablet it would be sitting on top of it.
  open = localStorage.getItem(OPEN_KEY) === '1';
} catch {
  // storage unavailable; start closed
}
let sending = false;
let error = '';

// True when this account has an ops thread at all: the cockpit tablets and the
// ops controllers, and only once the database has the tables for it.
const available = () => canOpsChat() && opsDeskReady();

const name = (userId) => {
  const p = person(userId);
  return p ? p.display_name : 'Unknown';
};

// "CAPTAIN", "COREY M" - who said it, in the flight deck's own shorthand. The
// name the database stamped on the message is the fallback, for a message from
// somebody who has since left the team.
const said = (m) => (m.user_id && person(m.user_id)?.display_name) || m.sender || 'Unknown';

function shiftLine() {
  const on = opsOnShift();
  if (!on) {
    const next = nextOpsShift();
    return `
      <span class="badge warn">NOBODY ON SHIFT</span>
      <span class="tiny">${
        next ? `${esc(name(next.user_id))} from ${zulu(next.starts_at)} ${zdate(next.starts_at)}` : 'No shifts rostered'
      }</span>`;
  }
  const mine = on.userId === getSession()?.userId;
  return `
    <span class="badge ok">${mine ? 'YOU ARE ON SHIFT' : 'ON SHIFT'}</span>
    <span class="ops-who">${esc(name(on.userId))}</span>
    <span class="tiny">${
      on.taken ? `took the desk ${zulu(on.since)}` : `until ${zulu(on.until)}`
    }</span>`;
}

function messages() {
  if (!state.opsChat.length) {
    return `<p class="note">Nothing said yet. Whatever is typed here reaches whoever is on the ops desk, and stays in the thread for the controller who takes over.</p>`;
  }
  const mine = getSession()?.userId;
  let day = '';
  return state.opsChat
    .map((m) => {
      const at = new Date(m.sent_at).getTime();
      const stamp = zdate(at);
      const rule = stamp === day ? '' : `<div class="ops-day">${esc(stamp)}</div>`;
      day = stamp;
      return `${rule}
        <div class="ops-msg${m.user_id === mine ? ' mine' : ''}">
          <div class="ops-msg-who"><span>${esc(said(m))}</span><span class="tiny">${zulu(at)}</span></div>
          <div class="ops-msg-body">${esc(m.body)}</div>
        </div>`;
    })
    .join('');
}

// Rewrites the panel's contents. The box being typed in is never touched, so
// a message arriving mid-sentence does not take the sentence with it.
export function paint() {
  const can = available();
  document.body.classList.toggle('ops-chat', can);
  document.body.classList.toggle('ops-open', can && open);
  if (!can) return;
  shiftStrip.innerHTML = shiftLine();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.innerHTML = `${messages()}${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}`;
  // Follow the conversation, unless the reader has scrolled back to look at
  // something earlier.
  if (atBottom) log.scrollTop = log.scrollHeight;
  const unread = open ? 0 : unreadOps();
  unreadDot.textContent = unread > 9 ? '9+' : String(unread);
  unreadDot.hidden = !unread;
  toggle.classList.toggle('has-unread', !!unread);
  callBtn.disabled = !CALL_LINK;
  callBtn.title = CALL_LINK ? 'Call the ops controller' : 'Calling is not connected yet';
  compose.querySelector('button[type=submit]').disabled = sending;
}

export function setOpen(next) {
  open = next;
  try {
    localStorage.setItem(OPEN_KEY, next ? '1' : '0');
  } catch {
    // storage unavailable; the choice just will not be remembered
  }
  if (next) {
    // Only one panel over the right edge at a time.
    window.dispatchEvent(new CustomEvent('app:panel', { detail: 'ops' }));
    markOpsRead();
    syncOpsChat().then(paint);
  }
  paint();
  if (next) text.focus();
}

toggle.addEventListener('click', () => setOpen(true));
document.getElementById('ops-close').addEventListener('click', () => setOpen(false));
window.addEventListener('app:panel', (e) => {
  if (e.detail !== 'ops' && open) setOpen(false);
});

// Everything read as soon as the panel is looked at, and again whenever the
// reader comes back to it.
log.addEventListener('scroll', () => {
  if (open && log.scrollHeight - log.scrollTop - log.clientHeight < 60) markOpsRead();
});

callBtn.addEventListener('click', () => {
  if (CALL_LINK) window.open(CALL_LINK, '_blank', 'noopener');
});

async function send() {
  const body = text.value.trim();
  if (!body || sending) return;
  sending = true;
  error = '';
  paint();
  try {
    await sendToOps(body);
    text.value = '';
    markOpsRead();
  } catch (err) {
    // The words stay in the box so they can be sent again.
    error = `Not sent: ${err.message}`;
  }
  sending = false;
  paint();
  log.scrollTop = log.scrollHeight;
}

compose.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

// Enter sends, as it does everywhere else people chat; shift+Enter is a new
// line, for a message with a list in it.
text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// The thread polls itself: the ten-second team sync is too slow for a
// conversation, and too slow to notice the unread count. Open, it reads every
// five seconds; closed, every fifteen, which is only to keep the badge honest.
let ticks = 0;
setInterval(async () => {
  if (!available() || document.visibilityState !== 'visible' || !navigator.onLine) return;
  ticks += 1;
  if (!open && ticks % 3) return;
  if (await syncOpsChat()) {
    if (open) markOpsRead();
    paint();
  }
}, 5000);

// Reading the thread is also what marks it read, so coming back to a tablet
// with the panel already open clears the badge.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !available()) return;
  if (open) markOpsRead();
  syncOpsChat().then(paint);
});

// state.chatSeen is kept on the device; saving it is what makes the badge
// survive a reload.
window.addEventListener('pagehide', () => {
  if (open) markOpsRead();
  save();
});
