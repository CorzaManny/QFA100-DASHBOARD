-- Changes the password both cockpit tablets sign in with.
--
-- This repository is public, so do not type your real password into this file
-- and commit it. Paste the file into the Supabase SQL Editor, change the
-- password there, and press Run.
create extension if not exists pgcrypto with schema extensions;

update auth.users
set encrypted_password = extensions.crypt('PUT-THE-NEW-PASSWORD-HERE', extensions.gen_salt('bf')),
    updated_at = now()
where email in ('captain@qfa100.efb', 'first_officer@qfa100.efb');

-- Check it worked: both rows should come back, with a profile and the efb role.
select u.email, p.display_name, p.role, u.email_confirmed_at is not null as confirmed,
       exists (select 1 from auth.identities i where i.user_id = u.id) as has_identity
from auth.users u left join public.profiles p on p.id = u.id
where u.email in ('captain@qfa100.efb', 'first_officer@qfa100.efb');
