// How the relay is actually running: the times the flight deck has stamped,
// what the aircraft is doing now, and when each remaining sector is really
// likely to get away. Pure functions: nothing here reads or writes app data.
//
// The published schedule is never changed. std stays the time WorldFlight
// published; everything below is an estimate laid over the top of it, worked
// out again from scratch every time the screen is drawn.

const MINUTE = 60000;

const ms = (t) => (t ? new Date(t).getTime() : null);
const byStd = (a, b) => ms(a.std) - ms(b.std);

// Estimates are a guess, so they are shown to the nearest five minutes. Times
// somebody stamped are left exactly as they are.
export const round5 = (t) => Math.round(t / (5 * MINUTE)) * 5 * MINUTE;

// Is the live feed talking about this sector, and recently enough to believe?
function liveArrival(sector, track, now, rules) {
  if (!track?.online || !track.eta) return null;
  if (track.dep && track.arr && (track.dep !== sector.dep || track.arr !== sector.arr)) return null;
  if (track.at && now - track.at > 5 * MINUTE) return null;
  // The feed estimates the airport; the schedule counts on-blocks.
  return track.eta + rules.taxiInMinutes * MINUTE;
}

// Every sector with what we know and what we think, in schedule order:
//
//   off, on       what the flight deck stamped, or null
//   estOff, estOn when it really left and lands, as far as anyone can tell
//   delay         estOff - std, so negative means early
//   basis         'actual' | 'live' | 'plan' - the strongest thing behind it
//   state         'done' | 'airborne' | 'next' | 'later' | 'skipped'
//
// The chain: a sector is not expected away before its planned time - the
// middle of its window, with half of it still in hand either side - and
// cannot leave until the aeroplane is back on the ground and turned round. Slack in the
// schedule therefore absorbs a delay instead of passing it on, which is the
// whole reason this is worked out sector by sector rather than as one number.
export function runningTimes({ sectors, actuals, track, rules, now = Date.now() }) {
  const stamped = new Map((actuals || []).map((a) => [a.sector_id, a]));
  const out = new Map();
  let prevOn = null;
  let seenAirborne = false;

  for (const s of [...sectors].sort(byStd)) {
    const a = stamped.get(s.id) || {};
    const std = ms(s.std);
    const block = ms(s.sta) - std;
    const off = ms(a.off_blocks);
    const on = ms(a.on_blocks);

    if (a.skipped) {
      out.set(s.id, { sector: s, off, on, estOff: std, estOn: ms(s.sta), delay: 0, basis: 'actual', state: 'skipped' });
      continue;
    }

    const ready = prevOn == null ? std : prevOn + rules.turnaroundMinutes * MINUTE;
    const estOff = off ?? Math.max(std, ready);
    const live = on ? null : liveArrival(s, track, now, rules);
    const estOn = on ?? live ?? estOff + block;

    const state = on
      ? 'done'
      : off || (live && !seenAirborne)
        ? 'airborne'
        : seenAirborne || estOff > now
          ? 'next'
          : 'later';
    if (state === 'airborne') seenAirborne = true;

    out.set(s.id, {
      sector: s,
      off,
      on,
      estOff,
      estOn,
      delay: estOff - std,
      basis: off || on ? 'actual' : live ? 'live' : 'plan',
      state,
    });
    prevOn = estOn;
  }
  return out;
}

// The one number people ask for: how far behind the programme is running, and
// which sector carries it. Anything under this is not worth a word on screen.
const WORTH_SAYING = 10 * MINUTE;

export function running({ sectors, actuals, track, rules, now = Date.now() }) {
  const times = runningTimes({ sectors, actuals, track, rules, now });
  const rows = [...times.values()];

  // The delay that matters is the next sector still to leave, because that is
  // the one people are about to report for.
  const ahead = rows.filter((r) => r.state !== 'skipped' && r.estOff >= now - 60 * MINUTE && !r.on);
  const next = ahead.find((r) => r.state === 'airborne') || ahead[0] || null;
  const airborne = rows.find((r) => r.state === 'airborne') || null;

  // Say nothing unless somebody stamped a time recently or the aeroplane is
  // being tracked; otherwise the published schedule is the best we have and an
  // estimate would only be the plan wearing a different colour.
  const fresh = rows.some((r) => (r.off || r.on) && now - (r.on || r.off) < 12 * 60 * MINUTE);
  const trusted = fresh || (!!track?.online && !!track?.eta);

  return {
    times,
    next,
    airborne,
    trusted,
    delay: next ? next.delay : 0,
    late: trusted && next && Math.abs(next.delay) >= WORTH_SAYING ? next : null,
  };
}

// What a sector's crew should really report, keeping whatever lead each person
// was given when they were rostered.
export function reportAt(entry, row) {
  const planned = ms(entry.report_at);
  if (!row || row.basis === 'plan') return planned;
  const lead = ms(row.sector.std) - planned;
  return round5(row.estOff - lead);
}
