-- Changes the password both cockpit tablets sign in with.
-- Edit the line marked below, then paste this whole file into the Supabase
-- SQL Editor and press Run. The tablets stay signed in until they sign out.
create extension if not exists pgcrypto with schema extensions;

update auth.users
set encrypted_password = extensions.crypt('flightdeck', extensions.gen_salt('bf')),  -- <= the new password
    updated_at = now()
where email in ('captain@qfa100.efb', 'first_officer@qfa100.efb');
