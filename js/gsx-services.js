export const SERVICES = [
  { id: 'aerobridge', label: 'Aerobridge', detail: 'Operate the passenger jetway', match: /\b(?:jetways?|aero[\s-]?bridges?|jet[\s-]?bridges?)\b/i, art: 'M12 26h18v49H12z M30 36h42v19H30z M39 36v19 M51 36v19 M63 36v19 M72 31h15v30H72z M76 61v14 M68 75h17 M17 36h7 M17 48h7 M17 60h7' },
  { id: 'stairs', label: 'Stairs', detail: 'Call the passenger stairs', match: /\b(?:stairs?|staircases?|airstairs?)\b/i, art: 'M17 66h65v8H17z M25 55h14v11 M39 44h14v22 M53 33h14v33 M67 25h16v41 M22 49l48-32h14 M25 78a5 5 0 1 0 0 .1 M76 78a5 5 0 1 0 0 .1' },
  { id: 'deboarding', label: 'Deboarding', detail: 'Help passengers on their way', match: /\b(?:request\s+)?deboarding\b/i, art: 'M16 26h50v42H16z M22 34h38v17H22z M26 68v9 M56 68v9 M72 49h16 M81 42l7 7-7 7 M25 59h6 M50 59h6' },
  { id: 'boarding', label: 'Boarding', detail: 'Welcome passengers aboard', match: /\b(?:request\s+)?boarding\b/i, art: 'M18 63h64v8H18z M26 52h48v11H26z M35 40h31v12H35z M45 28h15v12H45z M63 20h22v7H63z M74 27v25 M22 76a5 5 0 1 0 0 .1 M78 76a5 5 0 1 0 0 .1' },
  { id: 'catering', label: 'Catering', detail: 'Refresh the cabin supplies', match: /\b(?:request\s+)?catering\b/i, art: 'M14 28h47v35H14z M61 43h17l10 13v14H14v-7 M66 48h9l6 9H66z M29 70a7 7 0 1 0 0 .1 M75 70a7 7 0 1 0 0 .1 M24 39h27 M37 34v20' },
  { id: 'fuel', label: 'Refuelling', detail: 'Call the fuel truck', match: /\b(?:request\s+)?(?:refuel(?:ling|ing)?|fuel(?:\s+truck)?)\b/i, art: 'M14 40h43v25H14z M57 45h19l12 14v11H14v-5 M64 50h9l7 9H64z M28 70a7 7 0 1 0 0 .1 M75 70a7 7 0 1 0 0 .1 M35 22c-13 16-13 23 0 23s13-7 0-23z' },
  { id: 'pushback', label: 'Pushback', detail: 'Get ready to leave the stand', match: /\b(?:request\s+|prepare\s+for\s+)?push[\s-]?back\b/i, art: 'M14 49h41v20H14z M25 36h21v13 M30 41h11 M55 60h29 M84 53v14 M25 70a7 7 0 1 0 0 .1 M47 70a7 7 0 1 0 0 .1 M64 25h22 M71 18l-7 7 7 7' },
];

// Match only a service request, never a cancellation or a nested menu choice.
export function serviceChoice(state, service) {
  if (!state?.menuShown || !state.menuToken || !Array.isArray(state.menu?.entries)) return null;
  const matches = state.menu.entries.flatMap((label, index) =>
    typeof label === 'string' && service.match.test(label) &&
    (!['boarding', 'deboarding'].includes(service.id) || !/\b(?:stairs?|staircases?|airstairs?|jetways?)\b/i.test(label)) &&
    !/\b(?:cancel|stop|abort|interrupt|restart|continue|direction|left|right)\b/i.test(label)
      ? [{ index, disabled: !!state.menu.disabled?.[index], menuToken: state.menuToken }] : []);
  return matches.length === 1 ? matches[0] : null;
}
