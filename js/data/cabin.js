// Invented cabin crew names, for the duty report only.
//
// WorldFlight is flown by the pilots in the room; there is no cabin crew to
// roster, so nobody is ever named in these seats and the duty sheet prints
// with half a crew list. This is the pool those seats are filled from, and
// the sheet marks them as invented wherever it prints them - see cabinCrew()
// in ops.js for how a sector draws four of them, and duty.js for how it says
// they are simulated. Nothing else in the app knows about them: they are
// never rostered, never counted, and never have a user account.
//
// The count is prime on purpose. cabinCrew() picks its four by stepping
// through this list at a hashed stride, and with a prime length every stride
// is coprime with it, so the four it lands on can never repeat a name. Keep
// it prime if you add or remove any - 31, 37 and 41 are all fine.
export const CABIN_NAMES = [
  'Marisa Vance',
  'Tom Ngata',
  'Priya Raman',
  'Dane Okafor',
  'Hugh Brennan',
  'Alina Petrova',
  'Jarrah Willis',
  'Sofia Mendes',
  'Grace Tuilagi',
  'Ben Castellano',
  'Noor Haddad',
  'Kirra Dalton',
  'Elliot Shaw',
  'Mei Lin Chau',
  'Rafael Duarte',
  'Tess Lindqvist',
  'Omar Khalil',
  'Bronwyn Teague',
  'Daniel Osei',
  'Saoirse Keane',
  'Yuki Tanaka',
  'Felix Hartmann',
  'Amira Siddiqui',
  'Caleb Rangi',
  'Ines Moreau',
  'Lachlan Pryor',
  'Thandiwe Mbeki',
  'Marco Bellini',
  'Hana Jelinek',
  'Isaac Pereira',
  'Georgia Winton',
];
