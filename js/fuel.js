// The fuel plan's maths: the imported OFP is the fixed baseline (never
// recalculated), and the pilot's draft only adds fuel on top of it. Pure
// functions, same role running.js plays for the schedule - nothing here
// reads state or touches the page, so the numbers can be worked out (and
// checked) on their own.

// Typical 737-800 structural limits (winglets). No per-registration data
// exists anywhere in this app, so every B738 sector uses the same figures;
// treat them as a sensible default, not this aircraft's certified weights.
export const LIMITS = {
  B738: { mzfw: 62732, mtow: 79015, mlw: 66360, maxFuel: 26022 },
};

export const limitsFor = (type) => LIMITS[String(type || '').toUpperCase()] || LIMITS.B738;

// How many kilograms one minute of flight burns, from the OFP's own trip
// fuel and estimated time enroute. null when either figure is missing, which
// is what gates offering the minutes-based quick-add buttons at all.
export function burnRatePerMin(ofp) {
  if (!ofp?.tripFuel || !ofp?.ete) return null;
  return ofp.tripFuel / (ofp.ete / 60);
}

export function minutesToKg(ofp, minutes) {
  const rate = burnRatePerMin(ofp);
  return rate == null ? null : Math.round(minutes * rate);
}

// The revised figures, given the OFP baseline and the pilot's draft
// ({ discretionary_kg, taxi_kg }). Extra fuel is never assumed to survive the
// flight unburned in full - revisedLdw is a clearly-labelled estimate, not a
// recalculated performance figure.
export function fuelPlan(ofp, draft = {}) {
  if (!ofp) return null;
  const plannedTaxi = ofp.taxiFuel ?? 0;
  const taxi = draft.taxi_kg ?? plannedTaxi;
  const discretionary = draft.discretionary_kg || 0;
  const plannedBlock = ofp.blockFuel ?? null;
  const revisedBlock = plannedBlock == null ? null : plannedBlock + discretionary + (taxi - plannedTaxi);
  const revisedTakeoffFuel = revisedBlock == null ? null : revisedBlock - taxi;
  const zfw = ofp.zfw ?? null;
  const revisedTow = zfw == null || revisedTakeoffFuel == null ? null : zfw + revisedTakeoffFuel;
  const revisedLdw = ofp.ldw == null ? null : ofp.ldw + discretionary;
  return { plannedBlock, revisedBlock, plannedTaxi, taxi, discretionary, revisedTakeoffFuel, zfw, revisedTow, revisedLdw };
}

// Percentage of a limit used, clamped so a badly out-of-range figure does not
// blow out a bar past 100% of its track.
export function utilisation(value, limit) {
  if (value == null || !limit) return null;
  return Math.max(0, Math.min(150, Math.round((value / limit) * 100)));
}

// Checked only in kilograms - the limits table has no lb conversion, and
// every figure above is computed in whatever unit the OFP itself used.
export const checkable = (ofp) => (ofp?.units || 'kgs') === 'kgs';

// Every limit the plan is checked against, each with its own verdict: true
// when fine, false when exceeded. Submission is blocked on any false.
export function limitChecks(ofp, plan, limits) {
  if (!plan || !checkable(ofp)) return [];
  return [
    { label: 'Zero fuel weight', value: plan.zfw, limit: limits.mzfw },
    { label: 'Takeoff weight', value: plan.revisedTow, limit: limits.mtow },
    { label: 'Landing weight (estimate)', value: plan.revisedLdw, limit: limits.mlw },
    { label: 'Fuel tank capacity', value: plan.revisedBlock, limit: limits.maxFuel },
  ].map((c) => ({ ...c, pct: utilisation(c.value, c.limit), ok: c.value == null || c.value <= c.limit }));
}
