// Boeing 737NG normal checklists, challenge → response.
// FOR FLIGHT SIMULATION USE ONLY. Edit this file to match your team's
// add-on and SOPs: each item is ['Challenge', 'Response'].

export const CHECKLISTS = [
  {
    id: 'preflight',
    name: 'Preflight',
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
    items: [
      ['Flaps', '___, Green light'],
      ['Stabilizer trim', '___ Units'],
    ],
  },
  {
    id: 'after-takeoff',
    name: 'After Takeoff',
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
    items: [['Altimeters', '___']],
  },
  {
    id: 'landing',
    name: 'Landing',
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
    items: [
      ['IRSs', 'OFF'],
      ['Emergency exit lights', 'OFF'],
      ['Window heat', 'OFF'],
      ['Packs', 'OFF'],
    ],
  },
];
