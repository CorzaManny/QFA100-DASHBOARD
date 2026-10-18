// The stream: Twitch chat beside the flight deck, and things worth saying.
//
// The chat is Twitch's own embed in an iframe. It needs a parent parameter
// naming the exact host it is embedded on, so that is read off the address bar
// rather than written down anywhere: the same code then works on the team's
// domain, on GitHub Pages and on a laptop.
//
// The talking points are half worked out from what the app already knows --
// where the aeroplane is, how far round the world the team has got, what it is
// carrying -- and half whatever ops have typed in. A quiet cockpit at 3am is
// easier with a list in front of you.

import { state } from '../store.js';
import { saveSettings } from '../api.js';
import { esc, zulu, zdate, span, icon, rerender } from '../ui.js';
import {
  sortedSectors,
  currentSector,
  nextSector,
  crewOf,
  person,
  airport,
  actualOf,
  briefingOf,
  running,
  canEdit,
  isEfb,
  teamCallsign,
  teamAircraft,
  syncTeam,
} from '../ops.js';

let editing = false;
let error = '';

// Also read by app.js, which keeps the chat itself in a panel beside the page
// for an EFB tablet - see updateChatPanel() there.
export const channel = () => (state.settings?.twitch_channel || '').trim().replace(/^.*twitch\.tv\//i, '').replace(/[/?#].*$/, '');
const topics = () =>
  (state.settings?.stream_topics || '')
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);

// Things worth saying, worked out from what is going on right now. Each is a
// prompt rather than a script: a fact the crew can run with.
function suggested(now) {
  const out = [];
  const all = sortedSectors();
  const cur = currentSector(now) || nextSector(now);
  const flown = all.filter((s) => {
    const a = actualOf(s.id);
    return a?.skipped ? false : !!a?.on_blocks || new Date(s.sta) < now;
  }).length;

  if (all.length) {
    const n = cur ? all.findIndex((s) => s.id === cur.id) + 1 : flown;
    out.push(`This is sector ${n} of ${all.length}. ${flown} flown, ${all.length - flown} to go.`);
  }
  if (cur) {
    const dep = airport(cur.dep);
    const arr = airport(cur.arr);
    if (arr) {
      out.push(
        `Where we are going: ${arr.name}, ${arr.city}, ${arr.country}. Field elevation ${arr.elev} ft${
          arr.runways.length ? `, ${arr.runways.length} runway${arr.runways.length === 1 ? '' : 's'}` : ''
        }.`,
      );
    }
    if (dep && arr) out.push(`${cur.dep} to ${cur.arr} is ${span(new Date(cur.sta) - new Date(cur.std))} of block time.`);
    const crew = crewOf(cur).map((r) => `${person(r.user_id)?.display_name || 'Unknown'} as ${r.duty}`);
    if (crew.length) out.push(`On the flight deck: ${crew.join(', ')}.`);
    const m = state.metar[cur.arr];
    if (m) out.push(`The weather we are going into: ${m.text}`);
    const b = briefingOf(cur.id);
    if (b.wf_notes) out.push(`WorldFlight's notes for this sector: ${b.wf_notes.slice(0, 200)}`);
    if (b.ofp?.blockFuel) {
      out.push(`We are carrying ${Math.round(b.ofp.blockFuel).toLocaleString('en-AU')} kg of fuel, planned on SimBrief.`);
    }
  }
  const run = running(now);
  if (run.late) {
    out.push(
      `We are running ${span(Math.abs(run.late.delay))} ${run.late.delay > 0 ? 'behind' : 'ahead of'} the published schedule, and how that is being caught up.`,
    );
  }
  const defects = state.defects.filter((d) => d.status !== 'RECTIFIED');
  if (defects.length) {
    out.push(`What we are carrying: ${defects[0].ref}, ${defects[0].desc}${defects[0].restriction ? `, with ${defects[0].restriction}` : ''}.`);
  }
  const next = nextSector(now);
  if (next && next.id !== cur?.id) {
    out.push(`Coming up next: ${next.dep} to ${next.arr}, away at ${zulu(next.std)} on ${zdate(next.std)}.`);
  }
  out.push(`The aeroplane: a ${teamAircraft()} flying as ${teamCallsign()}, one aeroplane around the world.`);
  return out;
}

function chatCard() {
  const name = channel();
  if (!name) {
    return `
      <section class="card">
        <h2>Twitch chat</h2>
        <p class="note">No channel set yet.${
          canEdit() ? ' Put the team’s Twitch name in below and the chat appears here.' : ' Ops staff set it on this page.'
        }</p>
      </section>`;
  }
  // parent has to be the exact host this page is served from, so it is read
  // off the address bar. darkpopout is undocumented but keeps the chat dark.
  const src = `https://www.twitch.tv/embed/${encodeURIComponent(name)}/chat?parent=${encodeURIComponent(
    location.hostname,
  )}&darkpopout`;
  return `
    <section class="card chat-card">
      <div class="card-head"><h2>Twitch chat</h2>
        <a class="btn ghost small" href="https://www.twitch.tv/${esc(name)}" target="_blank" rel="noopener">Open on Twitch ${icon(
          'external',
        )}</a></div>
      <iframe class="chat" title="Twitch chat for ${esc(name)}" src="${esc(src)}"
        sandbox="allow-storage-access-by-user-activation allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"></iframe>
      <p class="tiny">Chat needs a connection; it will not load with the aeroplane offline.</p>
    </section>`;
}

function topicsCard(now) {
  const mine = topics();
  const auto = suggested(now);
  return `
    <section class="card">
      <div class="card-head"><h2>Things to talk about</h2>${
        canEdit() && !editing ? '<button class="btn ghost small" data-act="edit">Edit the team’s list</button>' : ''
      }</div>
      ${
        editing
          ? `<form class="form" data-form="topics">
              <label class="field">One topic per line<textarea name="topics" rows="8" placeholder="e.g. Mention the fundraising link&#10;Thank the controllers who have been with us">${esc(
                (state.settings?.stream_topics || '').trim(),
              )}</textarea></label>
              ${error ? `<p class="note warn">${icon('alert')} ${esc(error)}</p>` : ''}
              <div class="btn-row">
                <button class="btn primary" type="submit">Save</button>
                <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
              </div>
            </form>`
          : `${
              mine.length
                ? `<div class="tiny">FROM OPS</div><ul class="topics">${mine.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
                : ''
            }
            <div class="tiny">RIGHT NOW</div>
            <ul class="topics" data-topics-auto>${auto.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
            <p class="tiny">The second list is worked out from the schedule, the roster, the tech log and the weather, so it keeps up with the flight.</p>`
      }
    </section>`;
}

function channelCard() {
  if (!canEdit()) return '';
  return `
    <form class="card form" data-form="channel">
      <h2>Twitch channel</h2>
      <p class="note">The channel name on its own, not the whole address: for <strong>twitch.tv/qantas100</strong> it is <strong>qantas100</strong>. The chat shows on the flight deck tablets.</p>
      <label class="field">Channel<input name="channel" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(
        channel(),
      )}" placeholder="Not set yet"></label>
      <div class="btn-row"><button class="btn primary" type="submit">Save channel</button></div>
    </form>`;
}

export function render() {
  if (!isEfb() && !canEdit()) {
    return `<div class="page-head"><h1>Stream</h1></div>
      <section class="card"><p class="note">The stream page is for the flight deck tablets and ops staff.</p></section>`;
  }
  const now = Date.now();
  // An EFB tablet already carries the chat in the panel beside the page (see
  // app.js), open on every screen - embedding it again here would just be a
  // second Twitch connection fighting the first for the same chat.
  const out = `
    <div class="page-head"><h1>Stream</h1></div>
    ${
      isEfb()
        ? `<section class="card"><p class="note">Chat is in the panel on the right. Use its tab to show or hide it.</p></section>`
        : chatCard()
    }
    ${topicsCard(now)}
    ${channelCard()}`;
  error = '';
  return out;
}

// Called instead of a full rerender when the background sync notices team
// data has changed while this page is open. The Twitch chat iframe lives in
// the same tree a full render would replace, which reloads it for no reason;
// patching just the auto-generated topics in place keeps the chat connected.
// True means "handled, no full render needed"; anything else falls back to one.
export function liveUpdate() {
  if (!location.hash.startsWith('#/stream') || editing) return false;
  const list = document.querySelector('[data-topics-auto]');
  if (!list) return false;
  list.innerHTML = suggested(Date.now()).map((t) => `<li>${esc(t)}</li>`).join('');
  return true;
}

export const actions = {
  edit() {
    editing = true;
    rerender();
  },
  cancel() {
    editing = false;
    error = '';
    rerender();
  },
};

async function save(fields, done) {
  try {
    await saveSettings(fields);
    await syncTeam();
    editing = false;
  } catch (err) {
    error = `Could not save: ${err.message}`;
  }
  done?.();
  rerender();
}

export const forms = {
  topics(data, formEl) {
    formEl.querySelector('[type=submit]').disabled = true;
    return save({ stream_topics: String(data.get('topics')).trim() });
  },
  channel(data, formEl) {
    formEl.querySelector('[type=submit]').disabled = true;
    // Paste the whole address and the channel is taken out of it.
    const typed = String(data.get('channel')).trim().replace(/^.*twitch\.tv\//i, '').replace(/[/?#].*$/, '');
    return save({ twitch_channel: typed });
  },
};
