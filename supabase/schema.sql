-- QFA100 Ops database: accounts, schedule and roster.
-- Paste this whole file into the Supabase SQL Editor and press Run.
-- It is safe to run again; it will not delete any data.

-- ---------- Tables ----------

-- One row per account, created automatically when someone signs up.
create table if not exists public.profiles (
  id           uuid primary key,   -- same id as the sign-in account; test accounts have none
  display_name text not null,
  vatsim_cid   text,
  role         text not null default 'pending',
  is_test      boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Test accounts are profiles with no sign-in behind them, so profiles are no
-- longer tied to auth.users by a foreign key; a trigger below removes a
-- profile when its sign-in account is deleted instead.
alter table public.profiles add column if not exists is_test boolean not null default false;
alter table public.profiles drop constraint if exists profiles_id_fkey;

-- Roles:
--   pending     a new account waiting for an admin to approve it; sees nothing
--   admin       everything, including changing other people's roles
--   dispatcher  edits the schedule and the roster
--   pilot       can be rostered to fly; reads everything
--   observer    reads everything; can only be rostered as an observer
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'admin', 'dispatcher', 'pilot', 'observer'));
alter table public.profiles alter column role set default 'pending';

-- Every sector the aircraft flies.
create table if not exists public.sectors (
  id             uuid primary key default gen_random_uuid(),
  flight         text not null unique,
  dep            text not null check (dep ~ '^[A-Z0-9]{4}$'),
  arr            text not null check (arr ~ '^[A-Z0-9]{4}$'),
  std            timestamptz not null,
  sta            timestamptz not null check (sta > std),
  dep_window_min integer,          -- how long after std the departure window stays open
  route          text not null default '',
  notes          text not null default ''
);

-- Who is rostered on which sector, and when they report.
create table if not exists public.roster (
  id         uuid primary key default gen_random_uuid(),
  sector_id  uuid not null references public.sectors (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  duty       text not null default 'Captain'
             check (duty in ('Captain', 'First Officer', 'Relief Pilot', 'Observer')),
  report_at  timestamptz not null,
  notes      text not null default '',
  created_at timestamptz not null default now(),
  unique (sector_id, user_id)
);

create index if not exists roster_user_idx on public.roster (user_id);

-- True for entries placed by the Auto roster button, so they can be cleared
-- and re-run without touching anyone rostered by hand.
alter table public.roster add column if not exists auto boolean not null default false;

-- Team-wide settings: one row. While the roster is a draft only admins and
-- dispatchers can see it. rules holds the duty limits edited in the app.
create table if not exists public.settings (
  id           integer primary key default 1 check (id = 1),
  roster_state text not null default 'draft' check (roster_state in ('draft', 'published')),
  rules        jsonb not null default '{}'::jsonb
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Each person's availability for each sector, used by Auto roster.
create table if not exists public.preferences (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  sector_id  uuid not null references public.sectors (id) on delete cascade,
  choice     text not null check (choice in ('prefer', 'available', 'unavailable')),
  updated_at timestamptz not null default now(),
  primary key (user_id, sector_id)
);

-- ---------- Helper functions ----------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- True once an admin has approved the account (any role except pending).
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role <> 'pending');
$$;

-- Admins and dispatchers may change the schedule and roster.
create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'dispatcher'));
$$;

create or replace function public.roster_published()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.settings where roster_state = 'published');
$$;

-- Creates the profile when an account is created. The very first account
-- becomes the admin; everyone after that waits for an admin's approval.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles) then 'pending' else 'admin' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_deleted_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.profiles where id = old.id;
  return old;
end;
$$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public.handle_deleted_user();

-- Test accounts: stand-in team members an admin can create to try out the
-- roster. Nobody can sign in as one.
create or replace function public.add_test_account(account_name text, account_role text default 'pilot')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  new_id uuid := gen_random_uuid();
begin
  if not public.is_admin() then
    raise exception 'Only admins can add test accounts';
  end if;
  if account_role not in ('pending', 'dispatcher', 'pilot', 'observer') then
    raise exception 'Test accounts cannot have that role';
  end if;
  if coalesce(trim(account_name), '') = '' then
    raise exception 'Give the test account a name';
  end if;
  insert into public.profiles (id, display_name, role, is_test)
  values (new_id, trim(account_name), account_role, true);
  return new_id;
end;
$$;

-- Removes one test account, or all of them when target is null. Their roster
-- entries go with them. Real accounts are never touched.
create or replace function public.remove_test_account(target uuid default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can remove test accounts';
  end if;
  delete from public.profiles where is_test and (target is null or id = target);
end;
$$;

revoke execute on function public.add_test_account(text, text) from anon, public;
grant execute on function public.add_test_account(text, text) to authenticated;
revoke execute on function public.remove_test_account(uuid) from anon, public;
grant execute on function public.remove_test_account(uuid) to authenticated;

-- Admins promote or demote other accounts through this, never by editing the table.
create or replace function public.set_role(target uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles';
  end if;
  if new_role not in ('pending', 'admin', 'dispatcher', 'pilot', 'observer') then
    raise exception 'Unknown role';
  end if;
  if target = auth.uid() and new_role <> 'admin' then
    raise exception 'You cannot remove your own admin role';
  end if;
  if new_role = 'admin' and exists (select 1 from public.profiles where id = target and is_test) then
    raise exception 'A test account cannot be an admin';
  end if;
  update public.profiles set role = new_role where id = target;
end;
$$;

revoke execute on function public.set_role(uuid, text) from anon, public;
grant execute on function public.set_role(uuid, text) to authenticated;

-- ---------- Who may do what ----------
-- Accounts waiting for approval can see only their own profile.
-- Approved members can read everything. Admins and dispatchers change the
-- schedule and roster. Members can edit their own name and VATSIM CID, but
-- not their role; only admins change roles, through set_role().

alter table public.profiles enable row level security;
alter table public.sectors  enable row level security;
alter table public.roster   enable row level security;
alter table public.settings enable row level security;
alter table public.preferences enable row level security;

revoke all on public.profiles, public.sectors, public.roster, public.settings, public.preferences from anon;
-- Stated explicitly because newer Supabase projects do not grant these by default.
-- The policies below still decide which rows each person can touch.
grant select on public.profiles, public.sectors, public.roster to authenticated;
grant insert, update, delete on public.sectors, public.roster to authenticated;
grant select, update on public.settings to authenticated;
grant select, insert, update, delete on public.preferences to authenticated;
revoke insert, update, delete on public.profiles from authenticated;
grant update (display_name, vatsim_cid) on public.profiles to authenticated;

drop policy if exists "members read profiles" on public.profiles;
create policy "members read profiles" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_member());

drop policy if exists "members edit own profile" on public.profiles;
create policy "members edit own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "members read sectors" on public.sectors;
create policy "members read sectors" on public.sectors
  for select to authenticated using (public.is_member());

drop policy if exists "admins write sectors" on public.sectors;
drop policy if exists "editors write sectors" on public.sectors;
create policy "editors write sectors" on public.sectors
  for all to authenticated using (public.can_edit()) with check (public.can_edit());

drop policy if exists "members read roster" on public.roster;
-- A draft roster is visible to admins and dispatchers only.
create policy "members read roster" on public.roster
  for select to authenticated using (public.can_edit() or (public.is_member() and public.roster_published()));

drop policy if exists "admins write roster" on public.roster;
drop policy if exists "editors write roster" on public.roster;
create policy "editors write roster" on public.roster
  for all to authenticated using (public.can_edit()) with check (public.can_edit());

drop policy if exists "members read settings" on public.settings;
create policy "members read settings" on public.settings
  for select to authenticated using (public.is_member());

drop policy if exists "editors change settings" on public.settings;
create policy "editors change settings" on public.settings
  for update to authenticated using (public.can_edit()) with check (public.can_edit());

-- People see and set their own availability; admins and dispatchers see
-- everyone's and can set it on someone's behalf.
drop policy if exists "read availability" on public.preferences;
create policy "read availability" on public.preferences
  for select to authenticated using (user_id = auth.uid() or public.can_edit());

drop policy if exists "set availability" on public.preferences;
create policy "set availability" on public.preferences
  for all to authenticated
  using ((user_id = auth.uid() and public.is_member()) or public.can_edit())
  with check ((user_id = auth.uid() and public.is_member()) or public.can_edit());
