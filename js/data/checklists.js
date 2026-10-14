import { NON_NORMAL_QRH } from './non-normal.js';

// Boeing 737NG normal checklists, challenge → response.
// FOR FLIGHT SIMULATION USE ONLY. Edit this file to match your team's
// add-on and SOPs: each item is ['Challenge', 'Response'].

// Checklists are grouped: the normal ones you run every sector, the
// non-normal ones for a failure, and the memory items that are actioned
// before anybody opens a book. Add to the last two by giving a checklist
// kind: 'non-normal' or kind: 'memory'.
export const CHECKLIST_KINDS = [
  ['normal', 'Normal'],
  ['non-normal', 'Non-normal'],
  ['memory', 'Memory items'],
];

export const CHECKLISTS = [
  {
    id: 'preflight',
    name: 'Preflight',
    kind: 'normal',
    items: [
      ['Oxygen', 'Tested, 100%'],
      ['NAVIGATION transfer and DISPLAY switches', 'NORMAL, AUTO'],
      ['Window heat', 'On'],
      ['Pressurization mode selector', 'AUTO'],
      ['Flight instruments', 'Heading ___, Altimeter ___'],
      ['Parking brake', 'Set'],
      ['Engine start levers', 'CUTOFF'],
    ],
  },
  {
    id: 'before-start',
    name: 'Before Start',
    kind: 'normal',
    items: [
      ['Flight deck door', 'Closed and locked'],
      ['Fuel', '___ KGS, Pumps ON'],
      ['Passenger signs', '___'],
      ['Windows', 'Locked'],
      ['MCP', 'V2 ___, HDG ___, ALT ___'],
      ['Takeoff speeds', 'V1 ___, VR ___, V2 ___'],
      ['CDU preflight', 'Completed'],
      ['Rudder and aileron trim', 'Free and 0'],
      ['Taxi and takeoff briefing', 'Completed'],
      ['ANTI COLLISION light', 'ON'],
    ],
  },
  {
    id: 'before-taxi',
    name: 'Before Taxi',
    kind: 'normal',
    items: [
      ['Generators', 'On'],
      ['Probe heat', 'On'],
      ['Anti-ice', '___'],
      ['Isolation valve', 'AUTO'],
      ['ENGINE START switches', 'CONT'],
      ['Recall', 'Checked'],
      ['Autobrake', 'RTO'],
      ['Engine start levers', 'IDLE detent'],
      ['Flight controls', 'Checked'],
      ['Ground equipment', 'Clear'],
    ],
  },
  {
    id: 'before-takeoff',
    name: 'Before Takeoff',
    kind: 'normal',
    items: [
      ['Flaps', '___, Green light'],
      ['Stabilizer trim', '___ Units'],
    ],
  },
  {
    id: 'after-takeoff',
    name: 'After Takeoff',
    kind: 'normal',
    items: [
      ['Engine bleeds', 'On'],
      ['Packs', 'AUTO'],
      ['Landing gear', 'UP and OFF'],
      ['Flaps', 'UP, No lights'],
    ],
  },
  {
    id: 'descent',
    name: 'Descent',
    kind: 'normal',
    items: [
      ['Pressurization', 'LAND ALT ___'],
      ['Recall', 'Checked'],
      ['Autobrake', '___'],
      ['Landing data', 'VREF ___, Minimums ___'],
      ['Approach briefing', 'Completed'],
    ],
  },
  {
    id: 'approach',
    name: 'Approach',
    kind: 'normal',
    items: [['Altimeters', '___']],
  },
  {
    id: 'landing',
    name: 'Landing',
    kind: 'normal',
    items: [
      ['ENGINE START switches', 'CONT'],
      ['Speedbrake', 'ARMED'],
      ['Landing gear', 'Down'],
      ['Flaps', '___, Green light'],
    ],
  },
  {
    id: 'shutdown',
    name: 'Shutdown',
    kind: 'normal',
    items: [
      ['Fuel pumps', 'Off'],
      ['Probe heat', 'Auto'],
      ['Hydraulic panel', 'Set'],
      ['Flaps', 'UP'],
      ['Parking brake', '___'],
      ['Engine start levers', 'CUTOFF'],
      ['Weather radar', 'Off'],
    ],
  },
  {
    id: 'secure',
    name: 'Secure',
    kind: 'normal',
    items: [
      ['IRSs', 'OFF'],
      ['Emergency exit lights', 'OFF'],
      ['Window heat', 'OFF'],
      ['Packs', 'OFF'],
    ],
  },
];

// Native non-normal actions retain source numbering and explicit navigation.
export const NON_NORMAL_CHECKLISTS = NON_NORMAL_QRH.procedures.map((procedure) => ({
  ...procedure,
  id: `qrh-${procedure.id}`,
  name: procedure.title,
  kind: 'non-normal',
  native: true,
  items: procedure.blocks.filter((block) => block.type === 'action').map((block) => [block.text, '']),
}));
CHECKLISTS.push(...NON_NORMAL_CHECKLISTS);
export { NON_NORMAL_QRH };
