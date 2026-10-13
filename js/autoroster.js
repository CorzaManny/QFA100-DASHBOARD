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
  maxSectors: 0, // per person for the whole event; 0 = no limit
  reliefOverHours: 6, // sectors longer than this also need a relief pilot; 0 = never
  unmarkedAvailable: true, // everyone counts as available until they say otherwise
  turnaroundMinutes: 45, // the least time on the ground between two sectors
  taxiInMinutes: 5, // from overhead the arrival airport to on blocks, for live estimates
  reportReminderMinutes: 90, // notify this long before someone reports; 0 = never
  delayNoticeMinutes: 20, // notify when a delay moves a report time by this much; 0 = never
  reportLeadMinutes: 45, // report this long before the departure window opens
  firstReportLeadMinutes: 60, // ...and this long before the first sector of the event
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
    const hours = (sta(duty.at(-1)) - std(first)) / HOUR + rules.reportLeadMinutes / 60;
    if (hours > rules.maxDutyHours) {
      out.push(`${hours.toFixed(1)} hour duty from ${first.flight} (limit ${rules.maxDutyHours})`);
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

// Fill the empty Captain and First Officer seats on sectors that have not
// departed. Anyone already rostered is left exactly where they are.
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

  for (const s of upcoming) {
    const crew = [...roster, ...added].filter((r) => r.sector_id === s.id);
    for (const seat of seatsFor(s, rules)) {
      if (crew.some((r) => r.duty === seat)) continue;

      let best = null;
      let bestScore = Infinity;
      for (const p of pilots) {
        if (crew.some((r) => r.user_id === p.id)) continue;
        const want = choice.get(`${p.id}|${s.id}`);
        if (want === 'unavailable' || (!want && !rules.unmarkedAvailable)) continue;
        const mine = flying.get(p.id);
        // Adding this sector must not break a rule, or make a break worse.
        const before = problems(mine, rules);
        if (problems([...mine, s], rules).some((text) => !before.includes(text))) continue;

        // Lower is better. Even out the number of sectors first, then the time in
        // each seat, then the hours flown; honour requests, and keep a crew together
        // across back-to-back sectors to cut down handovers.
        const hours = mine.reduce((sum, x) => sum + blockHours(x), 0);
        const continues = mine.some((x) => sta(x) <= std(s) && std(s) - sta(x) < rules.restHours * HOUR);
        const score =
          mine.length * 3 +
          count(p.id, seat) * 2 +
          hours * 0.1 -
          (want === 'prefer' ? 4 : 0) -
          (continues ? 2 : 0) +
          (want ? 0 : 1);
        if (score < bestScore) {
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
    }
  }
  return { added, gaps };
}
