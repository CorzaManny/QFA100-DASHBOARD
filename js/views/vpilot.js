// vPilot on the flight deck: vPilot's own window, on the tablet.
//
// The radio lives on the sim PC, which nobody in the cockpit can reach once
// the flight is under way - the pilot flying has a yoke in front of them, not
// a keyboard. So this page is deliberately a copy of vPilot's own layout: the
// buttons along the top, who is in range down the left, the message window
// with its tabs on the right. Somebody who knows vPilot knows this page.
//
// Everything it shows comes from js/vpilot.js, which polls while this page is
// open and nowhere else. Nothing is kept: a frequency is true for as long as
// vPilot is running, and "COM1 120.500" restored from last week, with vPilot
// not even open, would be worse than an empty box. The page starts blank on
// every visit, by design.
//
// Push-to-talk is deliberately absent, here and in the plugin: a "PTT on"
// whose "off" was lost on a flaky connection would leave a microphone keyed
// on a live VATSIM frequency.

import { esc, zulu, icon, rerender } from '../ui.js';
import { canUseVpilot, teamCallsign } from '../ops.js';
import {
  watchVpilot,
  wakeVpilot,
  vpilotPicture,
  vpilotReady,
  vpilotKnown,
  vpilotRadios,
  vpilotOnline,
  vpilotCidMismatch,
  vpilotHas,
  sendRadio,
  sendPrivate,
  requestMetar,
  requestAtis,
  setModeC,
  squawkIdent,
  openChat,
  closeChat,
  connectVpilot,
  connectAsObserver,
  disconnectVpilot,
  resyncVpilot,
} from '../vpilot.js';

// Which message tab is on top: 'messages', or the callsign of an open private
// chat. Module state rather than store.js, like everything else about vPilot.
let tab = 'messages';
// What has been typed in each tab but not sent yet, so switching to a private
// chat and back does not eat a half-written transmission. In memory only.
const drafts = new Map();
// The last thing vPilot said about a command it refused, in vPilot's own
// words. They are what a pilot needs to hear, so they are shown verbatim.
let error = '';
// Which button is waiting on vPilot, so it can be disabled while it waits.
let busy = '';

// ---- Who is in range ----
// vPilot groups the controller list by what the callsign ends in, and so does
// this. The order is vPilot's: the big airspace first, the ground last.

const GROUPS = [
  ['Center', /_CTR$|_FSS$/],
  ['Approach/Departure', /_APP$|_DEP$/],
  ['Tower', /_TWR$/],
  ['Ground', /_GND$/],
  ['Ramp', /_RMP$/],
  ['Clearance Delivery', /_DEL$/],
  ['ATIS', /_ATIS$/],
];

// Anything that matches none of the above. vPilot calls them observers, and
// so does the heading, but it is really "everybody else": a supervisor, a
// sweatbox session, a controller with an unusual suffix.
const OBSERVERS = 'Observers';

function grouped(controllers) {
  const out = new Map(GROUPS.map(([name]) => [name, []]));
  out.set(OBSERVERS, []);
  for (const c of controllers) {
    const callsign = String(c.callsign || '').toUpperCase();
    const hit = GROUPS.find(([, pattern]) => pattern.test(callsign));
    out.get(hit ? hit[0] : OBSERVERS).push(c);
  }
  return out;
}

function controllerList() {
  const { controllers } = vpilotPicture();
  if (!controllers.length) {
    return `<p class="vp-empty">${
      vpilotOnline() ? 'Nobody in range.' : 'Nothing to show until vPilot is talking to the EFB.'
    }</p>`;
  }
  const out = [];
  for (const [name, members] of grouped(controllers)) {
    if (!members.length) continue;
    out.push(`<div class="vp-group">${esc(name)}</div>`);
    for (const c of members) {
      const callsign = String(c.callsign || '').toUpperCase();
      // The frequency the plugin formatted, or the raw number turned into one
      // here if this vPilot only reported the number.
      const freq = c.frequency || '';
      // A controller's real name is one of the extras a vPilot update can
      // take away, so it is shown when it is there and skipped when it is not.
      const who = vpilotHas('names') && c.real_name ? c.real_name : '';
      out.push(`
        <button class="vp-ctl" type="button" data-act="chat" data-callsign="${esc(callsign)}"
          title="Open a private chat with ${esc(callsign)}">
          <span class="vp-ctl-callsign">${esc(callsign)}</span>
          <span class="vp-ctl-freq">${esc(freq)}</span>
          ${who ? `<span class="vp-ctl-name tiny">${esc(who)}</span>` : ''}
        </button>`);
    }
  }
  return out.join('');
}

// ---- The buttons and the radio stack along the top ----

// A lamp: dim when the radio is set that way, lit when it is actually passing
// something. Without the radio-activity extra the flicker never arrives, so
// the lamp just reports how the radio is set and never lights.
const lamp = (label, armed, live) =>
  `<span class="vp-lamp${armed ? ' armed' : ''}${live ? ' live' : ''}">${label}</span>`;

function comRow(name, com) {
  return `
    <div class="vp-com">
      <span class="vp-com-name">${name}</span>
      <span class="vp-com-freq${com.frequency ? '' : ' off'}">${esc(com.frequency || '---.---')}</span>
      ${lamp('TX', com.tx, com.transmitting)}
      ${lamp('RX', com.rx, com.receiving)}
    </div>`;
}

function head() {
  const link = vpilotPicture().link;
  const radios = vpilotRadios();
  const online = vpilotOnline();
  const connected = !!link?.connected;
  const wrongCid = vpilotCidMismatch();

  // link.online means the bridge is talking, not that vPilot is open, so a
  // radio panel can look live with vPilot closed. Being connected to VATSIM
  // is the honest signal for now; the precise one arrives with the plugin's
  // vpilot-here/vpilot-gone events.
  const badge = !online
    ? '<span class="badge mute">NO PLUGIN</span>'
    : connected
      ? `<span class="badge ok">${esc(link.observer_mode ? 'OBSERVING' : 'CONNECTED')}</span>`
      : '<span class="badge warn">NOT CONNECTED</span>';

  const buttons = `
    <div class="vp-buttons">
      ${
        connected
          ? `<button class="vp-btn" type="button" data-act="disconnect" ${busy ? 'disabled' : ''}>Disconnect</button>`
          : `<button class="vp-btn" type="button" data-act="connect" ${busy || !online ? 'disabled' : ''}>Connect</button>
             <button class="vp-btn" type="button" data-act="observe" ${busy || !online ? 'disabled' : ''}
               title="Connect as an observer, with no aeroplane">Observer</button>`
      }
      <button class="vp-btn${radios.modeC ? ' on' : ''}" type="button" data-act="modec"
        ${busy || !connected ? 'disabled' : ''} title="Mode C: transponder on and reporting altitude">Mode C</button>
      <button class="vp-btn${radios.ident ? ' on' : ''}" type="button" data-act="ident"
        ${busy || !connected ? 'disabled' : ''} title="Squawk ident">Ident</button>
      <button class="vp-btn" type="button" data-act="resync" ${busy ? 'disabled' : ''}
        title="Make the plugin resend everything it knows">${icon('refresh')}</button>
    </div>`;

  // The squawk and the callsign are what vPilot shows in the middle of its
  // own window, and they are the two things worth a glance from the other
  // seat: the wrong callsign is the whole sector flown as somebody else.
  const identity = `
    <div class="vp-identity">
      <span class="vp-callsign">${esc(link?.callsign || teamCallsign() || '--------')}</span>
      <span class="vp-squawk">${esc(radios.squawk || '----')}</span>
      ${badge}
    </div>`;

  // The radio stack. vPilot reports it as part of its own internals, so a
  // vPilot that does not offer it leaves the boxes empty rather than absent:
  // a missing COM row reads as "no radio", which is worse than "unknown".
  const stack = `
    <div class="vp-stack">
      ${comRow('COM1', radios.com1)}
      ${comRow('COM2', radios.com2)}
    </div>`;

  return `
    ${buttons}
    ${identity}
    ${stack}
    ${
      wrongCid
        ? `<p class="vp-alert">${icon('alert')} vPilot is signed in as CID ${esc(
            wrongCid,
          )}, not the team's. This sector will be flown on a personal account.</p>`
        : ''
    }`;
}

// ---- The message window ----

const KIND_LABEL = {
  metar: 'METAR',
  atis: 'ATIS',
  selcal: 'SELCAL',
  server: 'SERVER',
  broadcast: 'BROADCAST',
};

// Which messages belong on the tab that is on top. Private messages live in
// their own tab when one is open for that callsign, and fall back into the
// main window when none is - a private from somebody with no tab is still
// something the crew has to see.
function forTab(messages, which, tabs) {
  if (which === 'messages') {
    return messages.filter((m) => {
      if (m.kind !== 'private' && m.kind !== 'private-sent') return true;
      const who = (m.kind === 'private' ? m.from_callsign : m.to_callsign) || '';
      return !tabs.includes(who.toUpperCase());
    });
  }
  return messages.filter((m) => {
    if (m.kind !== 'private' && m.kind !== 'private-sent') return false;
    const who = (m.kind === 'private' ? m.from_callsign : m.to_callsign) || '';
    return who.toUpperCase() === which;
  });
}

function line(m) {
  const at = zulu(m.at);
  const kind = m.kind;
  // Notices carry vPilot's own severity; everything else is classed by kind.
  const cls = kind === 'notice' ? `notice ${m.level || 'info'}` : kind;
  const freqs = m.frequencies?.length ? ` <span class="vp-freq">${esc(m.frequencies.join(', '))}</span>` : '';

  let who = '';
  if (kind === 'radio' || kind === 'private') who = `${esc(m.from_callsign || '')}: `;
  else if (kind === 'radio-sent') who = `${esc(m.from_callsign || teamCallsign() || 'YOU')}: `;
  else if (kind === 'private-sent') who = `${esc(m.to_callsign || '')}: `;
  else if (KIND_LABEL[kind]) who = `${KIND_LABEL[kind]}${m.from_callsign ? ` ${esc(m.from_callsign)}` : ''}: `;

  // A METAR or an ATIS is several lines of fixed-width weather, so it keeps
  // its own line breaks rather than being folded into a sentence.
  const body = kind === 'metar' || kind === 'atis' ? `<span class="vp-pre">${esc(m.body)}</span>` : esc(m.body);

  return `<div class="vp-line ${cls}"><span class="vp-at">[${esc(at)}]</span>${freqs} <span class="vp-who">${who}</span>${body}</div>`;
}

function logLines() {
  const { messages, link } = vpilotPicture();
  const tabs = (link?.chat_tabs || []).map((t) => String(t).toUpperCase());
  const shown = forTab(messages, tab, tabs);
  if (!shown.length) {
    return `<p class="vp-empty">${
      tab === 'messages'
        ? vpilotOnline()
          ? 'Nothing said yet.'
          : 'Nothing has been heard from vPilot. Start vPilot on the sim PC.'
        : 'Nothing said in this chat yet.'
    }</p>`;
  }
  return shown.map(line).join('');
}

function tabsBar() {
  const link = vpilotPicture().link;
  // The open private chats are vPilot's own, so closing one here closes it in
  // vPilot too - the two windows stay the same window.
  const open = (link?.chat_tabs || []).map((t) => String(t).toUpperCase());
  const btn = (key, label, closable) => `
    <span class="vp-tab${tab === key ? ' on' : ''}">
      <button type="button" data-act="tab" data-tab="${esc(key)}">${esc(label)}</button>
      ${closable ? `<button class="vp-tab-x" type="button" data-act="closetab" data-callsign="${esc(key)}" title="Close this chat" aria-label="Close chat with ${esc(label)}">×</button>` : ''}
    </span>`;
  return [btn('messages', 'Messages', false), ...open.map((c) => btn(c, c, true))].join('');
}

// What the box at the bottom does when Enter is pressed, which is not the
// same on every tab: the main window transmits on the radio, a private chat
// sends to that callsign.
const composePlaceholder = () =>
  tab === 'messages' ? 'Transmit on the tuned frequency, or .metar YSSY' : `Private message to ${tab}`;

// ---- The page ----

export function render() {
  // The database decides this too (can_use_vpilot in supabase/vpilot.sql);
  // leaving the page out is so nobody is handed a radio that answers every
  // press with "not allowed".
  if (!canUseVpilot()) {
    return `<div class="page-head"><h1>vPilot</h1></div>
      <section class="card"><p class="note">The radio is for the flight deck, the pilots and ops.</p></section>`;
  }
  // No vpilot.sql in this database: there is nothing to show and nothing that
  // would work, so the page says so once rather than drawing a dead radio.
  if (vpilotKnown() && !vpilotReady()) {
    return `<div class="page-head"><h1>vPilot</h1></div>
      <section class="card"><p class="note">vPilot is not set up on this database yet. An admin runs
        <strong>supabase/vpilot.sql</strong> and deploys the <strong>vpilot-plugin</strong> function.</p></section>`;
  }
  return `
    <div class="page-head"><h1>vPilot</h1>
      <span class="tiny">The radio on the sim PC</span></div>
    <section class="card vp" id="vpilot">
      <div class="vp-head" id="vp-head">${head()}</div>
      <div class="vp-body">
        <aside class="vp-side">
          <div class="vp-side-head">Controllers In Range:</div>
          <div class="vp-controllers" id="vp-controllers">${controllerList()}</div>
        </aside>
        <div class="vp-main">
          <div class="vp-tabs" id="vp-tabs">${tabsBar()}</div>
          <div class="vp-log" id="vp-log">${logLines()}</div>
          <form class="vp-compose" data-form="say" autocomplete="off">
            <input id="vp-text" name="text" type="text" placeholder="${esc(composePlaceholder())}"
              aria-label="${esc(composePlaceholder())}" maxlength="255">
            <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>Send</button>
          </form>
        </div>
      </div>
      <p class="vp-error" id="vp-error" ${error ? '' : 'hidden'}>${error ? `${icon('alert')} ${esc(error)}` : ''}</p>
      <p class="tiny vp-hint">Tap a controller to open a private chat. In the main window
        <strong>.metar YSSY</strong>, <strong>.atis YSSY_TWR</strong>, <strong>.chat QFA2</strong> and
        <strong>.msg QFA2 hello</strong> do what they do in vPilot. There is no push-to-talk: this
        panel types, it does not key the microphone.</p>
    </section>`;
}

// ---- Keeping it live ----
// app.js has a mounted() hook but nothing for leaving a page, so this view
// lets go of the poll itself. Two things stop it: the address leaving #/vpilot,
// and the panel no longer being in the page (signed out, or rendered away).

let unwatch = null;

function stop() {
  unwatch?.();
  unwatch = null;
}

// Redraws the parts that change, rather than the whole page: a poll landing
// mid-sentence must not take the sentence with it, so the box being typed in
// is never touched.
function paint() {
  const panel = document.getElementById('vpilot');
  if (!panel) {
    stop();
    return;
  }
  // The tables went away underneath us, or this is the first read and there
  // are none: the page itself is now wrong, so redraw the lot.
  if (vpilotKnown() && !vpilotReady()) {
    stop();
    rerender();
    return;
  }
  // A chat vPilot has closed takes its tab with it.
  const open = (vpilotPicture().link?.chat_tabs || []).map((t) => String(t).toUpperCase());
  if (tab !== 'messages' && !open.includes(tab)) tab = 'messages';

  document.getElementById('vp-head').innerHTML = head();
  document.getElementById('vp-controllers').innerHTML = controllerList();
  document.getElementById('vp-tabs').innerHTML = tabsBar();

  const log = document.getElementById('vp-log');
  // Follow the conversation, unless the reader has scrolled back to look at
  // something earlier.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.innerHTML = logLines();
  if (atBottom) log.scrollTop = log.scrollHeight;

  const box = document.getElementById('vp-text');
  box.placeholder = composePlaceholder();
  box.setAttribute('aria-label', composePlaceholder());

  const problem = document.getElementById('vp-error');
  problem.innerHTML = error ? `${icon('alert')} ${esc(error)}` : '';
  problem.hidden = !error;
  for (const b of panel.querySelectorAll('button[type=submit]')) b.disabled = !!busy;
}

export function mounted() {
  // A re-render brings us back through here, so let go of the old poll before
  // starting another: watchers are a Set of functions, and this one is the
  // same function every time, but the timer should not be left to chance.
  stop();
  if (!document.getElementById('vpilot')) return;
  unwatch = watchVpilot(paint);
  // Switching tabs leaves the draft behind, so put back whatever was typed
  // here last.
  const box = document.getElementById('vp-text');
  box.value = drafts.get(tab) || '';
  box.addEventListener('input', () => drafts.set(tab, box.value));
}

// Leaving the page. The panel check in paint() catches the rest, but a poll
// should stop when the crew navigates away, not two seconds later.
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/vpilot')) stop();
});

// ---- Driving it ----

// Every action resolves to { ok, error } where error is vPilot's own words.
// They are shown exactly as vPilot said them: "No COM radio is set to
// transmit, or the avionics are off." is what a pilot needs to hear, and
// rewording it would only make it vaguer.
async function run(name, fn) {
  if (busy) return;
  busy = name;
  error = '';
  paint();
  let result;
  try {
    result = await fn();
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  busy = '';
  error = result?.ok ? '' : result?.error || 'vPilot did not answer.';
  await wakeVpilot();
  paint();
}

export const actions = {
  tab(el) {
    const next = el.dataset.tab;
    if (next === tab) return;
    const box = document.getElementById('vp-text');
    // The half-written line stays with the tab it was written on.
    drafts.set(tab, box.value);
    tab = next;
    paint();
    box.value = drafts.get(next) || '';
    box.focus();
  },
  chat(el) {
    const callsign = el.dataset.callsign;
    const box = document.getElementById('vp-text');
    if (box) drafts.set(tab, box.value);
    // Switch to it straight away: vPilot will confirm the tab on the next
    // poll, and waiting two seconds to see the chat open feels broken.
    tab = callsign;
    run('chat', () => openChat(callsign));
  },
  closetab(el) {
    const callsign = el.dataset.callsign;
    if (tab === callsign) tab = 'messages';
    drafts.delete(callsign);
    run('closetab', () => closeChat(callsign));
  },
  connect: () => run('connect', () => connectVpilot()),
  observe: () => run('observe', () => connectAsObserver()),
  disconnect: () => run('disconnect', () => disconnectVpilot()),
  modec: () => run('modec', () => setModeC(!vpilotRadios().modeC)),
  ident: () => run('ident', () => squawkIdent()),
  resync: () => run('resync', () => resyncVpilot()),
};

// vPilot's own dot-commands, so the box at the bottom behaves the way it does
// on the PC. Anything else typed is a transmission.
function command(text) {
  const [word, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  switch (word.toLowerCase()) {
    case 'metar':
      return arg ? () => requestMetar(arg) : null;
    case 'atis':
      return arg ? () => requestAtis(arg) : null;
    case 'chat':
      if (!arg) return null;
      tab = arg.toUpperCase();
      return () => openChat(arg);
    case 'msg': {
      const [to, ...words] = arg.split(/\s+/);
      const body = words.join(' ');
      return to && body ? () => sendPrivate(to, body) : null;
    }
    default:
      return null;
  }
}

export const forms = {
  say(data, form) {
    const text = String(data.get('text') || '').trim();
    if (!text || busy) return;
    const box = form.querySelector('#vp-text');
    let fn;
    if (text.startsWith('.')) {
      fn = command(text);
      if (!fn) {
        // A mistyped command keeps its words, so it can be corrected rather
        // than typed again from the start.
        error = `${text.split(/\s+/)[0]} needs something after it, or is not one of .metar .atis .chat .msg`;
        paint();
        return;
      }
    } else {
      // Which tab this was typed on decides where it goes, and it is read now
      // rather than when vPilot answers: a reply landing mid-send must not
      // redirect a transmission.
      const where = tab;
      fn = () => (where === 'messages' ? sendRadio(text) : sendPrivate(where, text));
    }
    // The words leave the box as they are sent, as they do in vPilot. If the
    // send fails the error says so, verbatim; there is no half-sent
    // transmission to rescue.
    box.value = '';
    drafts.delete(tab);
    run('say', fn);
  },
};
