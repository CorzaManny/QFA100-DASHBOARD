// ACARS on the flight deck: the datalink, on the tablet.
//
// This page is laid out the way an ACARS/DCDU is used rather than the way the
// protocol is shaped, because the order things appear in is what makes it
// safe. An uplink that is waiting on a WILCO goes at the very top, always,
// above everything else on the page: a clearance left unanswered is the one
// mistake here that reaches other aeroplanes. Then the station and who we are
// logged on to; then the message window; then the things the crew sends.
//
// Everything it shows comes from js/acars.js, which polls while this page is
// open and nowhere else. Nothing is kept between visits: a clearance is true
// for as long as the flight is, and one restored from storage with the bridge
// not even running would be worse than an empty screen.
//
// The Hoppie logon code is never shown, and never read by the app at all. An
// admin sets it in Admin -> Settings, and the database only ever hands it to
// the bridge. See supabase/acars.sql.

import { esc, zulu, icon, rerender } from '../ui.js';
import { canEdit, canUseVpilot, currentSector, teamAircraft, teamCallsign } from '../ops.js';
import {
  watchAcars,
  acarsPicture,
  acarsReady,
  acarsKnown,
  acarsOnline,
  acarsLive,
  acarsFault,
  acarsAtcUnit,
  acarsLogonPending,
  acarsAwaitingReply,
  acarsPrinter,
  acarsCanPrint,
  acarsTimes,
  sendTelex,
  sendCompany,
  requestInfo,
  requestPdc,
  logonAtc,
  logoffAtc,
  replyToAtc,
  requestFromAtc,
  sendPosition,
  sendProgress,
  pingHoppie,
  pollNow,
  printAgain,
  testPrinter,
} from '../acars.js';

// Which tab is on top. Module state rather than store.js, like vPilot.
let tab = 'atc';
// What has been typed but not sent, so switching tabs does not eat a
// half-written request. In memory only.
const drafts = new Map();
// The last thing the bridge or Hoppie said about something it refused, in
// their own words - they are what the crew needs to hear, so they are shown
// verbatim.
let error = '';
let note = '';
// Which button is waiting on the sim PC, so it can be disabled while it waits.
let busy = '';

const draft = (key) => drafts.get(key) ?? '';

// ---- The messages that are waiting on an answer ----
//
// The whole reason this page exists in the shape it does. A CPDLC instruction
// with a WILCO outstanding is shown first, big, and cannot be scrolled past.

function awaiting() {
  const owed = acarsAwaitingReply();
  if (!owed.length) return '';
  return `
    <section class="acars-owed" aria-live="assertive">
      ${owed
        .map((m) => {
          const answers = (m.answers || []).filter(Boolean);
          return `
        <article class="acars-owed-msg">
          <header>
            <span class="badge warn">REPLY REQUIRED</span>
            <span class="acars-owed-from">${esc(m.from_station || '')}</span>
            <span class="tiny">${zulu(m.at)}${m.msg_no != null ? ` · MSG ${esc(m.msg_no)}` : ''}</span>
          </header>
          <p class="acars-owed-body">${esc(m.body || '')}</p>
          <div class="btn-row">
            ${answers
              .map(
                (a) => `<button class="btn ${a === 'WILCO' || a === 'AFFIRM' || a === 'ROGER' ? 'primary' : a === 'STANDBY' ? '' : 'danger'}"
                  type="button" data-act="reply" data-mrn="${esc(m.msg_no)}" data-answer="${esc(a)}"
                  ${busy === `reply${m.msg_no}${a}` ? 'disabled' : ''}>${esc(a)}</button>`,
              )
              .join('')}
            ${
              acarsCanPrint()
                ? `<button class="btn ghost" type="button" data-act="print" data-ref="${esc(
                    m.reference,
                  )}" title="Print this again">${icon('file')}</button>`
                : ''
            }
          </div>
        </article>`;
        })
        .join('')}
    </section>`;
}

// ---- The station ----

function stationCard() {
  const s = acarsPicture().state;
  const unit = acarsAtcUnit();
  const pending = acarsLogonPending();
  const printer = acarsPrinter();
  const times = acarsTimes();

  // One fault, named, from js/acars.js - which compares what an admin asked
  // for against what the bridge actually has. The badges below are only its
  // short form; the banner says what to do about it.
  const fault = acarsFault();
  const BADGES = {
    'bridge-gone': '<span class="badge warn">SIM PC NOT CONNECTED</span>',
    'no-code': '<span class="badge warn">NO LOGON CODE</span>',
    'not-reaching-bridge': '<span class="badge bad">NOT REACHING SIM PC</span>',
    off: '<span class="badge mute">OFF</span>',
    'not-picked-up': '<span class="badge warn">NOT PICKED UP</span>',
    'no-callsign': '<span class="badge warn">NO CALLSIGN</span>',
    'hoppie-refused': '<span class="badge bad">REFUSED</span>',
    'not-ready': '<span class="badge warn">NOT READY</span>',
  };
  const badge = fault
    ? BADGES[fault.code] || '<span class="badge warn">NOT READY</span>'
    : '<span class="badge ok">ACARS</span>';

  return `
    <section class="card acars-station">
      <div class="card-head">
        <h2>Datalink</h2>
        ${badge}
      </div>

      ${
        fault
          ? `<div class="acars-fault ${fault.code === 'off' ? '' : 'bad'}">
              <p class="acars-fault-title">${fault.code === 'off' ? '' : icon('alert')} ${esc(fault.title)}</p>
              <p class="acars-fault-detail">${esc(fault.detail)}</p>
              <p class="acars-fault-fix"><strong>What to do:</strong> ${esc(fault.fix)}</p>
            </div>`
          : ''
      }

      <dl class="acars-facts">
        <div><dt>Callsign</dt><dd>${esc(s?.callsign || '—')}</dd></div>
        <div><dt>Current ATC</dt><dd>${
          unit
            ? `<strong>${esc(unit)}</strong>`
            : pending
              ? `<span class="tiny">asking ${esc(pending)}…</span>`
              : '—'
        }</dd></div>
        <div><dt>Last poll</dt><dd>${s?.last_polled_at ? zulu(s.last_polled_at) : '—'}</dd></div>
        <div><dt>Printer</dt><dd>${
          !printer.enabled
            ? '<span class="tiny">none</span>'
            : printer.found
              ? `${esc(printer.printer || '')} <span class="tiny">${esc(printer.columns || '')} col</span>`
              : `<span class="badge warn">NOT FOUND</span>`
        }</dd></div>
      </dl>

      ${
        printer.enabled && printer.trouble
          ? `<p class="note warn">${icon('alert')} The printer last said: ${esc(printer.trouble)}</p>`
          : ''
      }

      <dl class="acars-times">
        ${['out', 'off', 'on', 'in']
          .map(
            (k) =>
              `<div><dt>${k.toUpperCase()}</dt><dd>${times[k] ? zulu(times[k]) : '—'}</dd></div>`,
          )
          .join('')}
      </dl>

      <div class="btn-row">
        ${
          unit
            ? `<button class="btn danger" type="button" data-act="logoff" ${
                busy === 'logoff' ? 'disabled' : ''
              }>Log off ${esc(unit)}</button>`
            : ''
        }
        <button class="btn" type="button" data-act="poll" ${busy === 'poll' ? 'disabled' : ''}>Check now</button>
        <button class="btn ghost" type="button" data-act="ping" ${busy === 'ping' ? 'disabled' : ''}>Test the link</button>
        <button class="btn ghost" type="button" data-act="position" ${
          busy === 'position' ? 'disabled' : ''
        }>Send position</button>
        <button class="btn ghost" type="button" data-act="progress" ${
          busy === 'progress' ? 'disabled' : ''
        }>Send progress</button>
        ${
          printer.enabled
            ? `<button class="btn ghost" type="button" data-act="testPrint" ${
                busy === 'testPrint' ? 'disabled' : ''
              }>Test the printer</button>`
            : ''
        }
      </div>
    </section>`;
}

// ---- The message window ----

// What a message is called on screen. The kind the bridge reported, which is
// what was asked for rather than the "telex" it may have arrived as.
const KINDS = {
  cpdlc: 'CPDLC',
  telex: 'TELEX',
  progress: 'PROGRESS',
  position: 'POSITION',
  posreq: 'POSN REQ',
  inforeq: 'REQUEST',
  metar: 'METAR',
  taf: 'TAF',
  shorttaf: 'TAF',
  vatatis: 'ATIS',
  peatis: 'ATIS',
  ivaoatis: 'ATIS',
  ping: 'PING',
  notice: 'BRIDGE',
  company: 'COMPANY',
};

function messageWindow() {
  const { messages } = acarsPicture();
  if (!messages.length) {
    return `<p class="acars-empty">${
      acarsLive() ? 'Nothing sent or received yet.' : 'Nothing to show until the datalink is up.'
    }</p>`;
  }
  // Newest at the bottom, like every other message window in the app, and
  // scrolled there on arrival - see mounted().
  return messages
    .map((m) => {
      const up = m.direction === 'uplink';
      const kind = KINDS[m.kind] || String(m.kind || '').toUpperCase();
      return `
      <article class="acars-msg ${up ? 'up' : 'down'}">
        <header>
          <span class="acars-kind">${esc(kind)}</span>
          <span class="acars-who">${esc(up ? m.from_station || '' : `→ ${m.to_station || ''}`)}</span>
          <span class="tiny">${zulu(m.at)}</span>
          ${m.msg_no != null ? `<span class="tiny">MSG ${esc(m.msg_no)}</span>` : ''}
          ${
            m.printed === false
              ? `<span class="badge warn" title="${esc(m.print_error || 'The printer refused it')}">NOT PRINTED</span>`
              : ''
          }
        </header>
        <pre class="acars-body">${esc(m.body || '')}</pre>
        ${
          acarsCanPrint()
            ? `<button class="btn ghost tiny-btn" type="button" data-act="print" data-ref="${esc(
                m.reference,
              )}">Print</button>`
            : ''
        }
      </article>`;
    })
    .join('');
}

// ---- What the crew sends ----

const TABS = [
  ['atc', 'ATC'],
  ['telex', 'Telex'],
  ['weather', 'Weather'],
  ['clearance', 'Clearance'],
];

// The tabs this account may actually see.
const tabsOpen = () => TABS.filter(([, , shown]) => !shown || shown());

// The requests a crew actually sends, as buttons rather than free text: the
// wording CPDLC expects is fussy, and a controller client that cannot parse a
// request simply ignores it.
// Each one is the start of the request, for the crew to finish with the level
// or the waypoint. The wording is what the controller clients parse.
const REQUESTS = [
  ['Climb', 'REQUEST CLB TO FL'],
  ['Descend', 'REQUEST DES TO FL'],
  ['Direct', 'REQUEST DIRECT TO '],
  ['Heading', 'REQUEST HEADING '],
  ['Speed', 'REQUEST '],
];

function sendPanel() {
  // An account that loses the ops role mid-session must not be left looking
  // at a tab it may no longer use; the database would refuse the send
  // anyway, but the form should not be there to fill in.
  if (!tabsOpen().some(([key]) => key === tab)) tab = 'atc';

  const unit = acarsAtcUnit();
  const sector = currentSector();
  const ready = acarsLive();

  const tabs = `
    <div class="acars-tabs" role="tablist">
      ${tabsOpen().map(
        ([key, label]) =>
          `<button class="acars-tab ${tab === key ? 'on' : ''}" type="button" role="tab"
            aria-selected="${tab === key}" data-act="tab" data-tab="${key}">${esc(label)}</button>`,
      ).join('')}
    </div>`;

  let body = '';

  if (tab === 'atc') {
    body = `
      ${
        unit
          ? `<p class="note ok">${icon('check')} Logged on to <strong>${esc(unit)}</strong>.</p>`
          : `<form class="acars-row" data-form="logon">
              <label class="field">Log on to<input name="to" autocapitalize="characters" maxlength="12"
                placeholder="e.g. YMML_CTR" value="${esc(draft('logon'))}" data-change="draft" data-key="logon"></label>
              <button class="btn primary" type="submit" ${!ready || busy === 'logon' ? 'disabled' : ''}>Log on</button>
            </form>
            <p class="tiny">Check in by voice first. A controller who does not provide CPDLC will never answer, and the bridge gives up after five minutes.</p>`
      }
      ${
        unit
          ? `
        <div class="btn-row acars-requests">
          ${REQUESTS.map(
            ([label, prefix]) =>
              `<button class="btn" type="button" data-act="fill" data-prefix="${esc(prefix)}">${esc(label)}</button>`,
          ).join('')}
        </div>
        <form class="acars-row" data-form="request">
          <label class="field">Request to ${esc(unit)}
            <textarea name="message" rows="2" autocapitalize="characters"
              placeholder="e.g. REQUEST CLB TO FL380" data-change="draft" data-key="request">${esc(
                draft('request'),
              )}</textarea></label>
          <button class="btn primary" type="submit" ${!ready || busy === 'request' ? 'disabled' : ''}>Send</button>
        </form>`
          : ''
      }`;
  } else if (tab === 'telex') {
    body = `
      <form class="acars-row" data-form="telex">
        <label class="field">To<input name="to" autocapitalize="characters" maxlength="12"
          placeholder="e.g. QFA200 or EGLL" value="${esc(draft('telexTo'))}" data-change="draft" data-key="telexTo"></label>
        <label class="field">Message
          <textarea name="message" rows="3" placeholder="Free text" data-change="draft" data-key="telex">${esc(
            draft('telex'),
          )}</textarea></label>
        <button class="btn primary" type="submit" ${!ready || busy === 'telex' ? 'disabled' : ''}>Send</button>
      </form>`;
  } else if (tab === 'weather') {
    // Four buttons rather than a form with four submitters: FormData does
    // not carry which button was pressed, and the one thing this panel has
    // to get right is which of the four was asked for.
    body = `
      <div class="acars-row">
        <label class="field">Station<input autocapitalize="characters" maxlength="4"
          placeholder="${esc(sector?.arr || 'ICAO')}" value="${esc(draft('wx'))}"
          data-change="draft" data-key="wx"></label>
        <div class="btn-row">
          ${[
            ['metar', 'METAR', 'primary'],
            ['taf', 'TAF', ''],
            ['shorttaf', 'Short TAF', ''],
            ['vatatis', 'ATIS', ''],
          ]
            .map(
              ([request, label, cls]) =>
                `<button class="btn ${cls}" type="button" data-act="weather" data-request="${request}"
                  ${!ready || busy === request ? 'disabled' : ''}>${esc(label)}</button>`,
            )
            .join('')}
        </div>
      </div>
      <p class="tiny">Hoppie answers these straight away rather than on a poll, so the reply lands in the window within a second or two.</p>`;
  } else {
    body = `
      <form class="card-form acars-pdc" data-form="pdc">
        <div class="grid2">
          <label class="field">To<input name="to" autocapitalize="characters" maxlength="12"
            placeholder="${esc(sector?.dep || 'e.g. EGKK')}" value="${esc(draft('pdcTo'))}"
            data-change="draft" data-key="pdcTo"></label>
          <label class="field">ATIS letter<input name="atis" autocapitalize="characters" maxlength="1"
            placeholder="e.g. C" value="${esc(draft('pdcAtis'))}" data-change="draft" data-key="pdcAtis"></label>
          <label class="field">Stand<input name="stand" maxlength="8"
            placeholder="e.g. 49" value="${esc(draft('pdcStand'))}" data-change="draft" data-key="pdcStand"></label>
          <label class="field">Free text<input name="freetext" maxlength="60"
            placeholder="Optional" value="${esc(draft('pdcFree'))}" data-change="draft" data-key="pdcFree"></label>
        </div>
        <p class="tiny">Sent as ${esc(teamCallsign() || 'the flight')} ${esc(
          teamAircraft() || '',
        )}${sector ? ` from ${esc(sector.dep)} to ${esc(sector.arr)}` : ''}, which is what the roster says this sector is.</p>
        <button class="btn primary" type="submit" ${!ready || busy === 'pdc' ? 'disabled' : ''}>Request clearance</button>
      </form>`;
  }

  return `<section class="card acars-send">${tabs}<div class="acars-tabbody">${body}</div></section>`;
}

// ---- The page ----

function companyPanel() {
  if (!canEdit()) return '';
  return `<section class="card acars-send">
    <h2>Message flight deck</h2>
    <form class="card-form" data-form="company">
      <label class="field">ACARS company message
        <textarea name="message" rows="4" maxlength="900" required
          placeholder="e.g. SLOT REVISED 1420Z. EXPECT STAND 32 ON ARRIVAL."
          data-change="draft" data-key="company">${esc(draft('company'))}</textarea></label>
      <p class="tiny">Up to 900 characters. ${
        acarsOnline()
          ? acarsCanPrint() && acarsPrinter().found
            ? 'Sends to the flight deck ACARS window and requests a strip from the receipt printer.'
            : 'Sends to the flight deck ACARS window. The printer is unavailable, so a strip cannot be confirmed.'
          : 'The simulator PC is disconnected. The message will be saved for the crew to read in ACARS; it will not print automatically later.'
      }</p>
      <button class="btn primary" type="submit" ${busy === 'company' ? 'disabled' : ''}>${busy === 'company' ? 'Sending…' : 'Send to flight deck'}</button>
    </form>
  </section>`;
}

export function render() {
  if (!canUseVpilot()) {
    return `<section class="card"><h2>ACARS</h2>
      <p class="note">The datalink is open to the flight deck and ops only.</p></section>`;
  }
  // No acars.sql in this database: say so rather than showing a dead page.
  if (acarsKnown() && !acarsReady()) {
    return `<section class="card"><h2>ACARS</h2>
      <p class="note">This database has no ACARS tables yet. Run
      <strong>supabase/acars.sql</strong> in the Supabase SQL Editor, then set the Hoppie
      logon code in <strong>Admin → Settings</strong>.</p></section>`;
  }

  return `
    <div class="acars">
      ${awaiting()}
      ${error ? `<p class="note warn acars-error">${icon('alert')} ${esc(error)}</p>` : ''}
      ${note ? `<p class="note ok">${icon('check')} ${esc(note)}</p>` : ''}
      ${companyPanel()}
      ${stationCard()}
      <section class="card acars-window">
        <div class="card-head"><h2>Messages</h2></div>
        <div class="acars-log" id="acars-log">${messageWindow()}</div>
      </section>
      ${sendPanel()}
    </div>`;
}

let unwatch = null;
// What was on screen when it was last drawn, so an unchanged poll does not
// redraw the page for nothing.
let painted = '';

function stop() {
  unwatch?.();
  unwatch = null;
  painted = '';
}

// What the page actually shows. The bridge stamps acars_state on every
// report, so comparing the whole picture would call everything a change.
const signature = (p) =>
  JSON.stringify([
    p.state && {
      live: p.state.live,
      enabled: p.state.enabled,
      configured: p.state.configured,
      callsign: p.state.callsign,
      // The four the fault diagnosis reads. Without these the banner would
      // go on saying "not reaching the simulator PC" after a redeploy had
      // fixed it, because nothing else on the row would have changed.
      told: p.state.told,
      code_set: p.state.code_set,
      wanted_enabled: p.state.wanted_enabled,
      wanted_at: p.state.wanted_at,
      atc_unit: p.state.atc_unit,
      logon_pending: p.state.logon_pending,
      owing: p.state.owing,
      times: p.state.times,
      trouble: p.state.trouble,
      printer: p.state.printer,
      last_polled_at: p.state.last_polled_at,
    },
    p.messages.length,
    p.messages[p.messages.length - 1]?.reference ?? null,
  ]);

function onPicture(picture) {
  // Signed out, or drawn away: let go of the poll rather than redrawing a
  // page that is no longer here.
  if (!document.querySelector('.acars')) {
    stop();
    return;
  }
  // Don't redraw underneath somebody who is typing a request: the whole
  // page is replaced on render, and that would lose a half-written
  // clearance request. app.js has the same rule for its background syncs.
  if (document.activeElement?.closest?.('.acars-send')) return;
  const now = signature(picture);
  if (now === painted) return;
  painted = now;
  rerender();
}

export function mounted(root) {
  // rerender() brings us straight back through here, so this must not start
  // anything: watchAcars() reads immediately, and that read ends in
  // onPicture(), which rerenders. Registering again - or waking the poll
  // again - would make that a loop that never lets go of the main thread.
  // One watcher for as long as the page is up; hashchange below drops it.
  if (!unwatch) {
    painted = signature(acarsPicture());
    unwatch = watchAcars(onPicture);
  }

  // The window sits at the newest message, which is the one that matters.
  const log = root.querySelector('#acars-log');
  if (log) log.scrollTop = log.scrollHeight;
}

// Leaving the page. The panel check in onPicture() catches the rest, but the
// poll should stop when the crew navigates away, not two seconds later.
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/acars')) stop();
});

// Whatever the crew types is kept as it is typed, so a redraw - a clearance
// arriving mid-sentence - cannot eat it.
export const changes = {
  draft(el) {
    drafts.set(el.dataset.key, el.value);
  },
};

// Runs one thing, shows whatever the bridge or Hoppie said about it, and
// leaves the button disabled while it waits.
async function doing(which, work, said) {
  busy = which;
  error = '';
  note = '';
  rerender();
  const { ok, error: why } = await work();
  busy = '';
  if (ok) note = said || '';
  else error = why || 'The simulator PC would not do that.';
  rerender();
}

export const actions = {
  tab(el) {
    tab = el.dataset.tab;
    error = '';
    note = '';
    rerender();
  },

  // A reply to a CPDLC instruction. No confirm dialog on purpose: WILCO is
  // the answer a crew gives with a clearance in front of them and a
  // controller waiting, and a second tap to confirm is exactly the delay that
  // makes people stop using it.
  reply(el) {
    const mrn = el.dataset.mrn;
    const answer = el.dataset.answer;
    doing(`reply${mrn}${answer}`, () => replyToAtc(mrn, answer), `${answer} sent.`);
  },

  logoff() {
    doing('logoff', logoffAtc, 'Logged off.');
  },

  poll() {
    doing('poll', pollNow, 'Asked Hoppie.');
  },

  ping() {
    doing('ping', pingHoppie, 'Hoppie answered. The logon code is good.');
  },

  position() {
    doing('position', sendPosition, 'Position sent.');
  },

  progress() {
    doing('progress', sendProgress, 'Progress sent.');
  },

  testPrint() {
    doing('testPrint', testPrinter, 'A test strip has been sent to the printer.');
  },

  print(el) {
    const message = acarsPicture().messages.find((m) => m.reference === el.dataset.ref);
    doing(`print${el.dataset.ref}`, () => printAgain(message), 'Sent to the printer.');
  },

  weather(el) {
    const request = el.dataset.request;
    const icao = draft('wx');
    doing(request, () => requestInfo(request, icao), 'Asked Hoppie.');
  },

  // Puts the start of a request in the box for the crew to finish, rather
  // than sending a half-made one.
  fill(el) {
    drafts.set('request', el.dataset.prefix);
    rerender();
    const box = document.querySelector('[data-key="request"]');
    if (box) {
      box.focus();
      box.selectionStart = box.selectionEnd = box.value.length;
    }
  },
};

export const forms = {
  logon(data) {
    doing('logon', () => logonAtc(data.get('to')), 'Logon requested.');
  },

  request(data) {
    const message = String(data.get('message') || '');
    doing('request', async () => {
      const result = await requestFromAtc(message);
      if (result.ok) drafts.delete('request');
      return result;
    }, 'Request sent.');
  },

  company(data) {
    if (busy === 'company') return;
    const message = String(data.get('message') || '').trim();
    if (!canEdit() || !message || [...message].length > 900) {
      error = !canEdit() ? 'Only ops can send a company message to the crew.' : 'Enter a message of 1 to 900 characters.';
      note = '';
      rerender();
      return;
    }
    doing('company', async () => {
      const result = await sendCompany(message);
      if (result.ok) drafts.delete('company');
      return result;
    }, 'Sent to the crew.');
  },

  telex(data) {
    const to = String(data.get('to') || '');
    const message = String(data.get('message') || '');
    doing('telex', async () => {
      const result = await sendTelex(to, message);
      if (result.ok) drafts.delete('telex');
      return result;
    }, 'Telex sent.');
  },

  pdc(data) {
    const sector = currentSector();
    doing(
      'pdc',
      () =>
        requestPdc(data.get('to'), {
          callsign: teamCallsign(),
          type: teamAircraft(),
          dep: sector?.dep || data.get('to'),
          arr: sector?.arr || '',
          stand: data.get('stand'),
          atis: data.get('atis'),
          freetext: data.get('freetext'),
        }),
      'Clearance requested.',
    );
  },
};
