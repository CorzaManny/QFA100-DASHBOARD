-- The Operations role: ops staff who run the roster but do not fly.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- They can do everything a dispatcher can: build the roster, edit the
-- schedule, agree swaps and seat pickups, keep the tech log. What they cannot
-- do is be rostered on a sector, so the app never asks them for availability
-- and never offers them a seat.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'admin', 'dispatcher', 'operations', 'pilot', 'observer', 'efb'));

-- Admins, dispatchers and operations may change the schedule and roster.
create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'dispatcher', 'operations')
  );
$$;

-- They write briefings too.
create or replace function public.can_report()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'dispatcher', 'operations', 'pilot', 'efb')
  );
$$;

-- And correct the tech log.
create or replace function public.can_log()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'dispatcher', 'operations', 'efb')
  );
$$;

-- An admin may give somebody the role.
create or replace function public.set_role(target uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles';
  end if;
  if new_role not in ('pending', 'admin', 'dispatcher', 'operations', 'pilot', 'observer', 'efb') then
    raise exception 'Unknown role';
  end if;
  if target = auth.uid() and new_role <> 'admin' then
    raise exception 'You cannot remove your own admin role';
  end if;
  update public.profiles set role = new_role where id = target;
end;
$$;

revoke execute on function public.set_role(uuid, text) from anon, public;
grant execute on function public.set_role(uuid, text) to authenticated;

-- An admin may make an account with it. Everything else in create_account is
-- unchanged; only the list of roles it will accept is wider.
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
  if account_role not in ('admin', 'dispatcher', 'operations', 'pilot', 'observer') then
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

  update public.profiles
  set display_name = who, role = account_role, must_setup = true
  where id = uid;

  return jsonb_build_object('email', addr, 'password', pw);
end;
$$;

revoke execute on function public.create_account(text, text, text) from anon, public;
grant execute on function public.create_account(text, text, text) to authenticated;

-- Cover wanted on a sector is ops business as much as the pilots', so they are
-- told about it too. They still cannot take it: only people who fly can.
create or replace function public.offer_sector(entry uuid, why text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r        record;
  new_swap uuid;
begin
  select ro.*, s.flight, s.dep, s.arr, s.std into r
  from public.roster ro join public.sectors s on s.id = ro.sector_id
  where ro.id = entry;
  if r.id is null then raise exception 'That roster entry no longer exists'; end if;
  if r.user_id <> auth.uid() then raise exception 'You can only offer a sector you are on'; end if;
  if r.std < now() then raise exception 'That sector has already gone'; end if;
  if exists (select 1 from public.swaps where roster_id = entry and state in ('open', 'claimed')) then
    raise exception 'That sector is already offered';
  end if;

  insert into public.swaps (roster_id, from_user, reason) values (entry, auth.uid(), coalesce(why, ''))
  returning swaps.id into new_swap;

  perform public.tell(p.id, 'roster', format('%s needs cover', r.flight),
    format('%s to %s on %s. %s', r.dep, r.arr, to_char(r.std, 'DD Mon HH24:MI"Z"'),
           case when coalesce(why, '') = '' then 'Open it to take it.' else why end),
    '#/roster', 'swap-open-' || new_swap || '-' || p.id)
  from public.profiles p
  where p.role in ('admin', 'dispatcher', 'operations', 'pilot') and p.id <> auth.uid() and not p.is_test;
  return new_swap;
end;
$$;
