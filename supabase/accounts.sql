-- Accounts are made by an admin. Nobody signs themselves up, and there are no
-- test accounts any more.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- An admin makes an account with a name, a role and a password to pass on. The
-- account starts with a placeholder address nobody can be emailed at, so the
-- first thing the person does when they sign in is put in their own email and
-- choose their own password.
--
-- Also turn sign-ups off in the dashboard: Authentication -> Sign In /
-- Providers -> Email, and switch off "Allow new users to sign up". This file
-- closes the door inside the app; that setting closes it at the server.

create extension if not exists pgcrypto with schema extensions;

-- True while an account still has the address an admin created it with.
alter table public.profiles add column if not exists must_setup boolean not null default false;

-- ---------- Test accounts are gone ----------

delete from public.profiles where is_test;
drop function if exists public.add_test_account(text, text);
drop function if exists public.remove_test_account(uuid);

-- ---------- Making an account ----------

-- Returns { email, password }: the two things to pass on to the person. The
-- email is a placeholder at a domain that can never exist, so nothing is ever
-- sent to it; they replace it the first time they sign in.
create or replace function public.create_account(
  display_name  text,
  account_role  text default 'pilot',
  temp_password text default null
)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  who  text := btrim(coalesce(display_name, ''));
  pw   text := coalesce(nullif(btrim(temp_password), ''), encode(extensions.gen_random_bytes(6), 'hex'));
  uid  uuid := gen_random_uuid();
  slug text;
  addr text;
  col  text;
begin
  if not public.is_admin() then raise exception 'Only admins can create accounts'; end if;
  if who = '' then raise exception 'Give the person a name'; end if;
  if account_role not in ('admin', 'dispatcher', 'pilot', 'observer') then
    raise exception 'Unknown role';
  end if;
  if length(pw) < 8 then raise exception 'The password needs at least 8 characters'; end if;

  slug := btrim(lower(regexp_replace(who, '[^a-zA-Z0-9]+', '.', 'g')), '.');
  if slug = '' then slug := 'pilot'; end if;
  addr := slug || '.' || substr(uid::text, 1, 4) || '@qfa100.invalid';

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    addr, extensions.crypt(pw, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', who), now(), now()
  );
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (
    addr, uid,
    jsonb_build_object('sub', uid::text, 'email', addr, 'email_verified', true),
    'email', now(), now()
  );

  -- Supabase reads these columns as plain text, so one left empty makes signing
  -- in fail with "Database error querying schema".
  foreach col in array array[
    'confirmation_token', 'recovery_token', 'email_change', 'email_change_token_new',
    'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token'
  ]
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = col
    ) then
      execute format('update auth.users set %I = coalesce(%I, '''') where id = $1', col, col) using uid;
    end if;
  end loop;

  -- The trigger on auth.users has already made a profile, waiting for approval.
  -- An account an admin made by hand is approved by definition.
  update public.profiles
  set display_name = who, role = account_role, must_setup = true
  where id = uid;

  return jsonb_build_object('email', addr, 'password', pw);
end;
$$;

-- ---------- The first time somebody signs in ----------

-- Swaps the placeholder address for the person's own, and the password the
-- admin gave them for one only they know. Only their own account, and only
-- while it is still waiting to be set up.
create or replace function public.finish_setup(new_email text, new_password text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
declare
  addr text := lower(btrim(coalesce(new_email, '')));
  uid  uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.profiles where id = uid and must_setup) then
    raise exception 'This account has already been set up';
  end if;
  if addr !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'That does not look like an email address';
  end if;
  if addr like '%@qfa100.invalid' then
    raise exception 'Use your own email address';
  end if;
  if length(coalesce(new_password, '')) < 8 then
    raise exception 'The password needs at least 8 characters';
  end if;
  if exists (select 1 from auth.users where lower(email) = addr and id <> uid) then
    raise exception 'Another account already uses that email address';
  end if;

  update auth.users
  set email = addr,
      encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
      email_confirmed_at = now(),
      updated_at = now()
  where id = uid;

  update auth.identities
  set provider_id = addr,
      identity_data = jsonb_set(coalesce(identity_data, '{}'::jsonb), '{email}', to_jsonb(addr), true),
      updated_at = now()
  where user_id = uid and provider = 'email';

  update public.profiles set must_setup = false where id = uid;
end;
$$;

revoke execute on function public.create_account(text, text, text) from anon, public;
grant execute on function public.create_account(text, text, text) to authenticated;
revoke execute on function public.finish_setup(text, text) from anon, public;
grant execute on function public.finish_setup(text, text) to authenticated;
