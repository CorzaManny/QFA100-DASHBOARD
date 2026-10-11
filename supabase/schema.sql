-- QFA100 Ops database: accounts, schedule and roster.
-- Paste this whole file into the Supabase SQL Editor and press Run.
-- It is safe to run again; it will not delete any data.

-- ---------- Tables ----------

-- One row per account, created automatically when someone signs up.
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  vatsim_cid   text,
  role         text not null default 'pilot' check (role in ('pilot', 'admin')),
  created_at   timestamptz not null default now()
);

-- Every sector the aircraft flies.
create table if not exists public.sectors (
  id             uuid primary key default gen_random_uuid(),
  flight         text not null unique,
  dep            text not null check (dep ~ '^[A-Z0-9]{4}$'),
  arr            text not null check (arr ~ '^[A-Z0-9]{4}$'),
  std            timestamptz not null,
  sta            timestamptz not null check (sta > std),
  dep_window_min integer,          -- minutes either side of std that departure is allowed
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

-- ---------- Helper functions ----------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Creates the profile when an account is created. The very first account
-- becomes the admin so there is always someone who can build the roster.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles) then 'pilot' else 'admin' end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Admins promote or demote other accounts through this, never by editing the table.
create or replace function public.set_role(target uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles';
  end if;
  if new_role not in ('pilot', 'admin') then
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

-- ---------- Who may do what ----------
-- Signed-in members can read everything. Only admins change the schedule and
-- roster. Members can edit their own name and VATSIM CID, but not their role.

alter table public.profiles enable row level security;
alter table public.sectors  enable row level security;
alter table public.roster   enable row level security;

revoke all on public.profiles, public.sectors, public.roster from anon;
-- Stated explicitly because newer Supabase projects do not grant these by default.
-- The policies below still decide which rows each person can touch.
grant select on public.profiles, public.sectors, public.roster to authenticated;
grant insert, update, delete on public.sectors, public.roster to authenticated;
revoke insert, update, delete on public.profiles from authenticated;
grant update (display_name, vatsim_cid) on public.profiles to authenticated;

drop policy if exists "members read profiles" on public.profiles;
create policy "members read profiles" on public.profiles
  for select to authenticated using (true);

drop policy if exists "members edit own profile" on public.profiles;
create policy "members edit own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "members read sectors" on public.sectors;
create policy "members read sectors" on public.sectors
  for select to authenticated using (true);

drop policy if exists "admins write sectors" on public.sectors;
create policy "admins write sectors" on public.sectors
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "members read roster" on public.roster;
create policy "members read roster" on public.roster
  for select to authenticated using (true);

drop policy if exists "admins write roster" on public.roster;
create policy "admins write roster" on public.roster
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
