// Default CTWO+ Briefing content. A CTWO+ briefing walks the crew through
// Charts, Terrain, Weather, Operational and Threats for one leg (Departure or
// Arrival). The wording below is only the starting point: an admin can
// replace any section's points from the CTWO+ Briefing page itself, and every
// sector's briefing follows whatever list is current - see ctwoItems() in
// ops.js.

export const CTWO_LEGS = [
  { key: 'departure', label: 'Departure Briefing', airport: 'dep' },
  { key: 'arrival', label: 'Arrival Briefing', airport: 'arr' },
];

export const CTWO_SECTIONS = [
  { key: 'charts', label: 'Charts', letter: 'C', help: 'Review the key chart information for this leg.' },
  { key: 'terrain', label: 'Terrain', letter: 'T', help: 'Review terrain and obstacle considerations.' },
  { key: 'weather', label: 'Weather', letter: 'W', help: 'Review current and forecast weather.' },
  { key: 'operational', label: 'Operational', letter: 'O', help: 'Aircraft, procedures and NOTAMs.' },
  { key: 'threats', label: 'Threats', letter: '+', help: 'Identify threats for this phase of flight and agree how to mitigate them.' },
];

export const CTWO_DEFAULTS = {
  departure: {
    charts: ['Expected runway and alternates', 'SID and initial route', 'Taxi route and airport layout', 'Any restrictions or chart notes'],
    terrain: ['MSA and minimum sector altitude', 'Significant obstacles', 'Terrain within the departure area', 'Any terrain related restrictions'],
    weather: ['Current METAR and forecast (TAF)', 'Wind, visibility and cloud', 'Significant weather (CB, turbulence, icing)', 'Weather impact to the departure'],
    operational: ['Aircraft status and any open defects', 'SOPs and company procedures for this sector', 'NOTAMs affecting the departure', 'Fuel and performance considerations'],
    threats: ['Identify threats for this phase of flight', 'Agree mitigation for each threat', 'Briefed to the whole crew', 'Any additional hazards'],
  },
  arrival: {
    charts: ['Expected runway and alternates', 'STAR and approach to be flown', 'Taxi route and airport layout', 'Any restrictions or chart notes'],
    terrain: ['MSA and minimum sector altitude', 'Significant obstacles', 'Terrain within the arrival area', 'Any terrain related restrictions'],
    weather: ['Current METAR and forecast (TAF)', 'Wind, visibility and cloud', 'Significant weather (CB, turbulence, icing)', 'Weather impact to the arrival'],
    operational: ['Aircraft status and any open defects', 'SOPs and company procedures for this sector', 'NOTAMs affecting the arrival', 'Fuel and performance considerations'],
    threats: ['Identify threats for this phase of flight', 'Agree mitigation for each threat', 'Briefed to the whole crew', 'Any additional hazards'],
  },
};
