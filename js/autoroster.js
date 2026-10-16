// Duty rules and the Auto roster fill. Pure functions: nothing here reads or
// saves app data, so the rules can be reasoned about (and tested) on their own.

import { simHour, simDay } from './ui.js';

const HOUR = 3600000;
const PILOT_SEATS = ['Captain', 'First Officer'];
const PILOT_DUTIES = ['Captain', 'First Officer', 'Relief Pilot'];
const PILOT_ROLES = ['admin', 'dispatcher', 'pilot'];

// The team's rules, editable in Admin → Rules. These are the starting values.
export const DEFAULT_RULES = {
  restHours: 6, // a break at least this long ends a duty
  maxSectorsPerDuty: 1, // sectors flown before a rest is required
  maxDutyHours: 12, // report to the end of the last sector
  bocStart: 0, // back of the clock: sim local hour it starts...
  bocEnd: 5, // ...and ends
  maxBoc: 2, // back-of-clock sectors per person for the whole event; 0 = no limit
  bocEveryDays: 2, // at most one back-of-clock sector every this many days; 0 = no limit
  maxConsecutiveBoc: 0, // back-of-clock sectors flown back-to-back in one duty, before a rest; 0 = no limit
  maxDutyHoursBoc: 0, // duty limit when any sector in it is back-of-clock; 0 = use maxDutyHours
  maxSectors: 0, // per person for the whole event; 0 = no limit
  reliefOverHours: 6, // sectors longer than this also need a relief pilot; 0 = never
  unmarkedAvailable: true, // everyone counts as available until they say otherwise
  turnaroundMinutes: 45, // the least time on the ground between two sectors
  taxiInMinutes: 5, // from overhead the arrival airport to on blocks, for live estimates
  reportReminderMinutes: 90, // notify this long before someone reports; 0 = never
  delayNoticeMinutes: 20, // notify when a delay moves a report time by this much; 0 = never
  reportLeadMinutes: 45, // report this long before the departure window opens
  firstReportLeadMinutes: 60, // ...and this long before the first sector of the event

  // How Auto roster weighs one eligible pilot against another for an empty
  // seat. Need not add to 100; they are normalised when used, so moving one
  // slider is enough. All 0 falls back to filling seats in schedule order.
  weightHours: 35, // being further below their availability-adjusted fair share of hours
  weightPreference: 25, // having asked for or said they are available for this sector
  weightDesirability: 20, // having had fewer of the sought-after sectors so far
  weightContinuity: 15, // already flying the sector just before or after this one
  weightVariety: 5, // having flown less often with whoever else is already on this sector
};

export const rulesOf = (settings) => ({ ...DEFAULT_RULES, ...(settings?.rules || {}) });

const std = (s) => new Date(s.std).getTime();
const sta = (s) => new Date(s.sta).getTime();
const byStd = (a, b) => std(a) - std(b);
export const blockHours = (s) => (sta(s) - std(s)) / HOUR;

// The seats a sector is rostered from. Long sectors also carry a relief pilot.
export const seatsFor = (sector, rules) =>
  rules.reliefOverHours > 0 && blockHours(sector) > rules.reliefOverHours ? [...PILOT_SEATS, 'Relief Pilot'] : PILOT_SEATS;

// A sector is back-of-clock if any part of it is flown inside the window,
// in sim local time. The window may run past midnight (e.g. 23 to 5).
export function isBoc(sector, rules) {
  const inside = (h) =>
    rules.bocStart <= rules.bocEnd ? h >= rules.bocStart && h < rules.bocEnd : h >= rules.bocStart || h < rules.bocEnd;
  if (rules.bocStart === rules.bocEnd) return false;
  for (let t = std(sector); t < sta(sector); t += HOUR / 4) {
    if (inside(simHour(t))) return true;
  }
  return inside(simHour(sta(sector) - 1));
}

// Which night a sector belongs to: midday to midday in sim local time, so a
// 2300 departure and an 0030 departure a little later are the same night.
const night = (sector) => simDay(std(sector) - 12 * HOUR);

// How sought-after a sector is, 0 to 1: longer sectors are more sought after
// up to a point, back-of-clock ones less so. A rough, automatic stand-in for
// asking everyone to rank every sector by hand.
const clamp01 = (n) => Math.max(0, Math.min(1, n));
export const desirability = (sector, rules) => clamp01(blockHours(sector) / 10 - (isBoc(sector, rules) ? 0.35 : 0));

// Everything wrong with one person's set of sectors, as plain sentences.
export function problems(sectors, rules) {
  const list = [...sectors].sort(byStd);
  const out = [];
  let duty = [];

  const endDuty = () => {
    if (!duty.length) return;
    const first = duty[0];
    if (duty.length > rules.maxSectorsPerDuty) {
      out.push(`${duty.length} sectors without a rest from ${first.flight} (limit ${rules.maxSectorsPerDuty})`);
    }
    // A duty that touches back-of-clock hours can carry its own, shorter
    // limit, separate from an ordinary daytime duty's.
    const boc = duty.filter((s) => isBoc(s, rules));
    const hours = (sta(duty.at(-1)) - std(first)) / HOUR + rules.reportLeadMinutes / 60;
    const dutyLimit = boc.length && rules.maxDutyHoursBoc > 0 ? rules.maxDutyHoursBoc : rules.maxDutyHours;
    if (hours > dutyLimit) {
      out.push(`${hours.toFixed(1)} hour duty from ${first.flight} (limit ${dutyLimit}${boc.length ? ', back-of-clock' : ''})`);
    }
    // Back-of-clock sectors flown one after another in the same duty, not
    // the spacing between separate back-of-clock duties (that's bocEveryDays).
    if (rules.maxConsecutiveBoc > 0) {
      let run = 0;
      for (const s of duty) {
        run = isBoc(s, rules) ? run + 1 : 0;
        if (run > rules.maxConsecutiveBoc) {
          out.push(`${run} back-of-clock sectors in a row from ${first.flight} (limit ${rules.maxConsecutiveBoc})`);
          break;
        }
      }
    }
    duty = [];
  };

  list.forEach((s, i) => {
    const prev = list[i - 1];
    if (prev) {
      const gap = std(s) - sta(prev);
      if (gap < 0) out.push(`${prev.flight} and ${s.flight} overlap`);
      if (gap >= rules.restHours * HOUR) endDuty();
    }
    duty.push(s);
  });
  endDuty();

  const boc = list.filter((s) => isBoc(s, rules));
  if (rules.maxBoc > 0 && boc.length > rules.maxBoc) {
    out.push(`${boc.length} back-of-clock sectors (limit ${rules.maxBoc})`);
  }
  if (rules.bocEveryDays > 1) {
    boc.forEach((s, i) => {
      const prev = boc[i - 1];
      if (prev && night(s) - night(prev) < rules.bocEveryDays) {
        out.push(`back-of-clock sectors ${prev.flight} and ${s.flight} are too close (one every ${rules.bocEveryDays} days)`);
      }
    });
  }

  if (rules.maxSectors > 0 && list.length > rules.maxSectors) {
    out.push(`${list.length} sectors in total (limit ${rules.maxSectors})`);
  }
  return out;
}

// Each pilot's fair share of the hours still to crew, in proportion to how
// much of the schedule they have said they can fly. A blank counts as
// available when the team's rule says it should.
function fairTargets(pilots, upcoming, rules, choice) {
  const totalSeatHours = upcoming.reduce((sum, s) => sum + blockHours(s) * seatsFor(s, rules).length, 0);
  const avail = new Map();
  let totalAvail = 0;
  for (const p of pilots) {
    let h = 0;
    for (const s of upcoming) {
      const want = choice.get(`${p.id}|${s.id}`);
      if (want === 'unavailable' || (!want && !rules.unmarkedAvailable)) continue;
      h += blockHours(s);
    }
    avail.set(p.id, h);
    totalAvail += h;
  }
  const target = new Map();
  for (const p of pilots) target.set(p.id, totalAvail > 0 ? (avail.get(p.id) / totalAvail) * totalSeatHours : 0);
  return target;
}

// The average desirability of the sectors each pilot could fly at all, so
// "fewer sought-after sectors than usual" is judged against their own
// opportunities rather than against sectors they were never going to get.
function eligibleDesirability(pilots, upcoming, rules, choice) {
  const out = new Map();
  for (const p of pilots) {
    const scores = upcoming
      .filter((s) => {
        const want = choice.get(`${p.id}|${s.id}`);
        return want !== 'unavailable' && (want || rules.unmarkedAvailable);
      })
      .map((s) => desirability(s, rules));
    out.set(p.id, scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5);
  }
  return out;
}

// Fill the empty Captain and First Officer seats on sectors that have not
// departed. Anyone already rostered is left exactly where they are.
//
// Seats are filled a rank at a time: every Captain seat first, then every
// First Officer seat, then relief pilots. When there are not enough pilots to
// go round, that leaves as few sectors as possible with nobody at all.
//
// Among everyone eligible for a seat - available, and not breaking a duty
// rule - the best candidate is the one scoring highest on a weighted mix of
// how far below their fair share of hours they are, whether they asked for
// or are available for this sector, whether they have had fewer of the
// sought-after sectors than they could have, whether they are already
// flying the sector next to this one, and how little they have already
// flown with whoever else is on it. The weights are the team's own
// (Admin → Settings); all candidates score equally if every weight is 0,
// so the first eligible pilot in schedule order is taken.
//
//   sectors, roster, people, prefs: the team's data
//   reportFor(sector): the Date a newly rostered person should report
//
// Returns { added: [roster rows to save], gaps: [{ sector, seat }] }.
export function planRoster({ sectors, roster, people, prefs, rules, now, reportFor }) {
  const byId = new Map(sectors.map((s) => [s.id, s]));
  const pilots = people.filter((p) => PILOT_ROLES.includes(p.role));
  const choice = new Map(prefs.map((p) => [`${p.user_id}|${p.sector_id}`, p.choice]));

  // What each pilot is already flying, and how often in each seat.
  const flying = new Map(pilots.map((p) => [p.id, []]));
  const seated = new Map(pilots.map((p) => [p.id, {}]));
  const count = (id, duty) => seated.get(id)[duty] || 0;
  for (const r of roster) {
    if (!PILOT_DUTIES.includes(r.duty) || !flying.has(r.user_id) || !byId.has(r.sector_id)) continue;
    flying.get(r.user_id).push(byId.get(r.sector_id));
    seated.get(r.user_id)[r.duty] = count(r.user_id, r.duty) + 1;
  }

  const added = [];
  const gaps = [];
  const upcoming = sectors.filter((s) => std(s) > now).sort(byStd);
  const target = fairTargets(pilots, upcoming, rules, choice);
  const eligibleDesire = eligibleDesirability(pilots, upcoming, rules, choice);

  // How many sectors two pilots have already shared, kept up to date as
  // seats fill so this run spreads pairings too, not just the roster it
  // started from.
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const pairs = new Map();
  const addPair = (a, b) => pairs.set(pairKey(a, b), (pairs.get(pairKey(a, b)) || 0) + 1);
  for (const s of sectors) {
    const crew = roster.filter((r) => r.sector_id === s.id && PILOT_DUTIES.includes(r.duty));
    for (let i = 0; i < crew.length; i++) for (let j = i + 1; j < crew.length; j++) addPair(crew[i].user_id, crew[j].user_id);
  }

  const wSum = rules.weightHours + rules.weightPreference + rules.weightDesirability + rules.weightContinuity + rules.weightVariety;
  const w =
    wSum > 0
      ? {
          hours: rules.weightHours / wSum,
          pref: rules.weightPreference / wSum,
          desire: rules.weightDesirability / wSum,
          continuity: rules.weightContinuity / wSum,
          variety: rules.weightVariety / wSum,
        }
      : { hours: 0, pref: 0, desire: 0, continuity: 0, variety: 0 };

  for (const seat of PILOT_DUTIES) {
    for (const s of upcoming) {
      if (!seatsFor(s, rules).includes(seat)) continue;
      const crew = [...roster, ...added].filter((r) => r.sector_id === s.id);
      if (crew.some((r) => r.duty === seat)) continue;
      const partners = crew.map((r) => r.user_id);

      let best = null;
      let bestScore = -Infinity;
      for (const p of pilots) {
        if (crew.some((r) => r.user_id === p.id)) continue;
        const want = choice.get(`${p.id}|${s.id}`);
        if (want === 'unavailable' || (!want && !rules.unmarkedAvailable)) continue;
        const mine = flying.get(p.id);
        // Adding this sector must not break a rule, or make a break worse.
        const before = problems(mine, rules);
        if (problems([...mine, s], rules).some((text) => !before.includes(text))) continue;

        const hours = mine.reduce((sum, x) => sum + blockHours(x), 0);
        const myTarget = target.get(p.id) || 0;
        const hoursScore = myTarget > 0 ? clamp01(1 - hours / myTarget) : hours === 0 ? 1 : 0;

        const prefScore = want === 'prefer' ? 1 : want === 'available' ? 0.6 : rules.unmarkedAvailable ? 0.4 : 0.2;

        const received = mine.length ? mine.reduce((sum, x) => sum + desirability(x, rules), 0) / mine.length : null;
        const desireScore = received === null ? 0.5 : clamp01(0.5 + ((eligibleDesire.get(p.id) ?? 0.5) - received));

        const continues = mine.some((x) => sta(x) <= std(s) && std(s) - sta(x) < rules.restHours * HOUR);
        const continuityScore = continues ? 1 : 0;

        const sharedBefore = partners.length
          ? partners.reduce((sum, id) => sum + (pairs.get(pairKey(id, p.id)) || 0), 0) / partners.length
          : 0;
        const varietyScore = clamp01(1 - sharedBefore / 3);

        // Everything above is the team's own weighting; this tiny nudge only
        // ever breaks an otherwise exact tie, to keep Captain and First
        // Officer time roughly even for someone who flies both.
        const score =
          w.hours * hoursScore +
          w.pref * prefScore +
          w.desire * desireScore +
          w.continuity * continuityScore +
          w.variety * varietyScore -
          count(p.id, seat) * 0.0001;
        if (score > bestScore) {
          best = p;
          bestScore = score;
        }
      }

      if (!best) {
        gaps.push({ sector: s, seat });
        continue;
      }
      const entry = {
        sector_id: s.id,
        user_id: best.id,
        duty: seat,
        report_at: reportFor(s).toISOString(),
        notes: '',
        auto: true,
      };
      added.push(entry);
      crew.push(entry);
      flying.get(best.id).push(s);
      seated.get(best.id)[seat] = count(best.id, seat) + 1;
      for (const id of partners) addPair(id, best.id);
    }
  }
  gaps.sort((a, b) => byStd(a.sector, b.sector) || PILOT_DUTIES.indexOf(a.seat) - PILOT_DUTIES.indexOf(b.seat));
  return { added, gaps };
}
