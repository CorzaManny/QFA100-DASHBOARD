// Connection to the team's Supabase project (accounts, schedule, roster).
// Copy both values from Supabase: Project Settings → API.
// The "anon public" key is designed to be published; never put the
// "service_role" key here.

export const SUPABASE_URL = 'https://robydzjjanyhsmtjrhog.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_294YXJrzcL-PXagMXnAFog_PM3CsjJH';

// The two tablets that live in the cockpit sign in by name instead of an email
// address. supabase/schema.sql creates these accounts; the app turns the name
// typed on the login page into the address behind it.
export const EFB_DOMAIN = 'qfa100.efb';
export const EFB_LOGINS = ['captain', 'first_officer'];

// The team's public key for notifications, from supabase/notifications.sql.
// Like the key above it is meant to be public; the private half of the pair
// lives only in the database. Leave it empty to turn notifications off.
export const PUSH_PUBLIC_KEY = 'BBQNk0GT1-Fa1AgSql6WRll_GHErZz6o8picqXFW65tNfiRRNBc0OvcGaf0X7WfZUujkX25tRhodSEK2oTdEChE';
