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
-- What this person wants to be notified about, and how early. Empty means the
-- team's defaults; see supabase/notifications.sql.
alter table public.profiles add column if not exists notify jsonb not null default '{}'::jsonb;
alter table public.profiles drop constraint if exists profiles_id_fkey;

-- Roles:
--   pending     a new account waiting for an admin to approve it; sees nothing
--   admin       everything, including changing other people's roles
--   dispatcher  edits the schedule and the roster
--   pilot       can be rostered to fly; reads everything
--   observer    reads everything; can only be rostered as an observer
--   efb         a shared cockpit tablet: keeps the tech log, cannot be rostered
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending', 'admin', 'dispatcher', 'pilot', 'observer', 'efb'));
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

-- A cockpit tablet is a shared account, not a crew member, so it can never
-- appear on the roster.
create or replace function public.no_tablet_on_roster()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.profiles where id = new.user_id and role = 'efb') then
    raise exception 'An EFB tablet account cannot be rostered onto a sector';
  end if;
  return new;
end;
$$;

drop trigger if exists roster_no_tablet on public.roster;
create trigger roster_no_tablet
  before insert or update on public.roster
  for each row execute function public.no_tablet_on_roster();

-- True for entries placed by the Auto roster button, so they can be cleared
-- and re-run without touching anyone rostered by hand.
alter table public.roster add column if not exists auto boolean not null default false;

-- A sector somebody cannot fly after all, offered to the rest of the team.
-- open -> claimed -> approved, or withdrawn by the person who offered it, or
-- sent back to open if an admin turns the claim down.
create table if not exists public.swaps (
  id         uuid primary key default gen_random_uuid(),
  roster_id  uuid not null references public.roster (id) on delete cascade,
  from_user  uuid not null references public.profiles (id) on delete cascade,
  claimed_by uuid references public.profiles (id) on delete set null,
  state      text not null default 'open' check (state in ('open', 'claimed', 'approved', 'withdrawn')),
  reason     text not null default '',
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists swaps_open_idx on public.swaps (state);

-- What actually happened: the times the flight deck stamped for each sector.
-- The published schedule in public.sectors is never changed, so the plan and
-- the running of the day are both kept.
create table if not exists public.sector_actuals (
  sector_id  uuid primary key references public.sectors (id) on delete cascade,
  off_blocks timestamptz,
  on_blocks  timestamptz,
  skipped    boolean not null default false,
  by_name    text not null default '',
  updated_at timestamptz not null default now()
);

-- Team-wide settings: one row. While the roster is a draft only admins and
-- dispatchers can see it. rules holds the duty limits edited in the app.
create table if not exists public.settings (
  id           integer primary key default 1 check (id = 1),
  roster_state text not null default 'draft' check (roster_state in ('draft', 'published')),
  rules        jsonb not null default '{}'::jsonb
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- The one SimBrief account the whole team imports flight plans from.
alter table public.settings add column if not exists simbrief text not null default '';

-- The shared briefing for each sector: the imported flight plan, the team's
-- notes, WorldFlight's page and notes, and the crew's handover to the next crew.
create table if not exists public.briefings (
  sector_id  uuid primary key references public.sectors (id) on delete cascade,
  notes      text not null default '',
  wf_url     text not null default '',
  wf_notes   text not null default '',
  handover   text not null default '',
  ofp        jsonb,
  ofp_by     text not null default '',
  ofp_at     timestamptz,
  updated_at timestamptz not null default now()
);

-- Each person's availability for each sector, used by Auto roster.
create table if not exists public.preferences (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  sector_id  uuid not null references public.sectors (id) on delete cascade,
  choice     text not null check (choice in ('prefer', 'available', 'unavailable')),
  updated_at timestamptz not null default now(),
  primary key (user_id, sector_id)
);

-- The aircraft's tech log, shared by the whole team. mel_item is the number of
-- the MEL entry a defect was checked against (e.g. 21-01-01-01), if any.
create sequence if not exists public.techlog_seq;

create table if not exists public.techlog (
  id          uuid primary key default gen_random_uuid(),
  ref         text not null default ('WF-' || lpad(nextval('public.techlog_seq')::text, 3, '0')),
  reported_at timestamptz not null default now(),
  created_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  reporter    text not null default '',
  sector      text not null default '',
  system      text not null default '',
  description text not null,
  status      text not null default 'OPEN' check (status in ('OPEN', 'DEFERRED', 'RECTIFIED')),
  mel_item    text not null default '',
  mel_cat     text not null default '',
  due_at      timestamptz,
  restriction text not null default '',
  action      text not null default '',
  aog         boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- What happened to each tech log entry and who did it. Written by the
-- database itself (see log_techlog_change below), never by the app.
create table if not exists public.techlog_history (
  id        uuid primary key default gen_random_uuid(),
  defect_id uuid not null references public.techlog (id) on delete cascade,
  at        timestamptz not null default now(),
  by_name   text not null default '',
  event     text not null,
  detail    text not null default ''
);

create index if not exists techlog_history_defect_idx on public.techlog_history (defect_id);

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

-- Everyone approved except observers and the tablets may write a briefing.
create or replace function public.can_report()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'dispatcher', 'pilot', 'efb'));
$$;

-- The tech log is kept on the flight deck: the cockpit tablets write it, and
-- admins and dispatchers can correct it. Pilots read it and tell the tablet.
create or replace function public.can_log()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'dispatcher', 'efb'));
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

-- Adds a line to a defect's history whenever it is reported or changed.
create or replace function public.log_techlog_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who  text;
  what text;
  note text := '';
begin
  select display_name into who from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then
    what := 'Reported';
    who := coalesce(who, new.reporter);
    if new.status <> 'OPEN' then note := initcap(new.status); end if;
  elsif new.status is distinct from old.status then
    what := case new.status when 'DEFERRED' then 'Deferred' when 'RECTIFIED' then 'Rectified' else 'Reopened' end;
    note := case new.status
      when 'DEFERRED' then concat_ws(' · ', nullif('MEL ' || new.mel_item, 'MEL '), nullif(new.restriction, ''))
      when 'RECTIFIED' then new.action
      else '' end;
  elsif (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return new;  -- saved without changing anything
  else
    what := 'Edited';
  end if;
  insert into public.techlog_history (defect_id, by_name, event, detail)
  values (new.id, coalesce(who, ''), what, coalesce(note, ''));
  return new;
end;
$$;

drop trigger if exists techlog_history_trigger on public.techlog;
create trigger techlog_history_trigger
  after insert or update on public.techlog
  for each row execute function public.log_techlog_change();

-- Rejects a sign-up or removes a member: deletes the account completely, so
-- the person can no longer sign in. Their roster entries go with them.
create or replace function public.remove_account(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can remove accounts';
  end if;
  if target = auth.uid() then
    raise exception 'You cannot remove your own account';
  end if;
  delete from auth.users where id = target;
  delete from public.profiles where id = target;
end;
$$;

revoke execute on function public.remove_account(uuid) from anon, public;
grant execute on function public.remove_account(uuid) to authenticated;

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

-- ---------- Giving a sector away ----------

-- Sends a notification if supabase/notifications.sql has been run, and does
-- nothing if it has not, so swaps work either way.
create or replace function public.tell(
  target uuid, kind text, title text, body text, url text, dedupe text
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.notify(uuid,text,text,text,text,text,integer)') is not null then
    execute 'select public.notify($1, $2, $3, $4, $5, $6, $7)'
      using target, kind, title, body, url, dedupe, 86400;
  end if;
end;
$$;

-- Offer a sector you are rostered on. Only your own, only once, and only one
-- that has not already gone.
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
  where p.role in ('admin', 'dispatcher', 'pilot') and p.id <> auth.uid() and not p.is_test;
  return new_swap;
end;
$$;

-- Take a sector somebody has offered. An admin still has to agree.
create or replace function public.claim_swap(swap uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  w record;
begin
  select sw.*, ro.sector_id, s.flight, s.dep, s.arr, s.std into w
  from public.swaps sw
  join public.roster ro on ro.id = sw.roster_id
  join public.sectors s on s.id = ro.sector_id
  where sw.id = swap;
  if w.id is null or w.state <> 'open' then raise exception 'That offer is no longer open'; end if;
  if w.from_user = auth.uid() then raise exception 'That is your own sector'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'dispatcher', 'pilot')) then
    raise exception 'Only pilots can take a sector';
  end if;
  if exists (select 1 from public.roster where sector_id = w.sector_id and user_id = auth.uid()) then
    raise exception 'You are already on that sector';
  end if;

  update public.swaps set state = 'claimed', claimed_by = auth.uid(), updated_at = now() where id = swap;

  perform public.tell(t.id, 'roster', format('%s is covered', w.flight),
    format('%s offered to take %s to %s. It needs an admin to agree.',
           (select display_name from public.profiles where id = auth.uid()), w.dep, w.arr),
    '#/admin', 'swap-claim-' || swap || '-' || t.id)
  from public.profiles t
  where t.id = w.from_user or t.role in ('admin', 'dispatcher');
end;
$$;

-- Take back an offer, whether or not somebody has claimed it.
create or replace function public.withdraw_swap(swap uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  w public.swaps%rowtype;
begin
  select * into w from public.swaps where id = swap;
  if w.id is null or w.state in ('approved', 'withdrawn') then raise exception 'That offer is already settled'; end if;
  if w.from_user <> auth.uid() and not public.can_edit() then
    raise exception 'Only the person who offered it, or an admin, can take it back';
  end if;
  update public.swaps set state = 'withdrawn', updated_at = now() where id = swap;
end;
$$;

-- An admin agrees to the swap, which moves the sector, or turns it down,
-- which puts it back on offer.
create or replace function public.decide_swap(swap uuid, agree boolean, why text default '')
returns void language plpgsql security definer set search_path = public as $$
declare
  w record;
begin
  if not public.can_edit() then raise exception 'Only admins and dispatchers can agree a swap'; end if;
  select sw.*, ro.sector_id, ro.duty, s.flight, s.dep, s.arr, s.std into w
  from public.swaps sw
  join public.roster ro on ro.id = sw.roster_id
  join public.sectors s on s.id = ro.sector_id
  where sw.id = swap;
  if w.id is null or w.state <> 'claimed' then raise exception 'That offer has not been claimed'; end if;

  if agree then
    update public.roster set user_id = w.claimed_by, auto = false where id = w.roster_id;
    update public.swaps set state = 'approved', note = coalesce(why, ''), updated_at = now() where id = swap;
    perform public.tell(w.claimed_by, 'roster', format('%s is yours', w.flight),
      format('%s to %s as %s on %s.', w.dep, w.arr, w.duty, to_char(w.std, 'DD Mon HH24:MI"Z"')),
      '#/roster', 'swap-done-' || swap || '-' || w.claimed_by);
    perform public.tell(w.from_user, 'roster', format('%s has been taken', w.flight),
      format('%s is flying it. You are off that sector.',
             (select display_name from public.profiles where id = w.claimed_by)),
      '#/roster', 'swap-done-' || swap || '-' || w.from_user);
  else
    update public.swaps set state = 'open', claimed_by = null, note = coalesce(why, ''), updated_at = now()
    where id = swap;
    perform public.tell(w.claimed_by, 'roster', format('%s is still open', w.flight),
      case when coalesce(why, '') = '' then 'Your offer to take it was turned down.' else why end,
      '#/roster', 'swap-no-' || swap || '-' || now()::date);
  end if;
end;
$$;

revoke all on function public.tell(uuid, text, text, text, text, text) from public, anon, authenticated;

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
  if new_role not in ('pending', 'admin', 'dispatcher', 'pilot', 'observer', 'efb') then
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
alter table public.swaps enable row level security;
alter table public.sector_actuals enable row level security;
alter table public.techlog  enable row level security;
alter table public.techlog_history enable row level security;
alter table public.briefings enable row level security;

revoke all on public.profiles, public.sectors, public.roster, public.settings, public.preferences, public.techlog, public.techlog_history, public.briefings from anon;
-- Stated explicitly because newer Supabase projects do not grant these by default.
-- The policies below still decide which rows each person can touch.
grant select on public.profiles, public.sectors, public.roster to authenticated;
grant insert, update, delete on public.sectors, public.roster to authenticated;
grant select, update on public.settings to authenticated;
grant select, insert, update, delete on public.preferences to authenticated;
-- Swaps are only ever changed through the four functions below, so the app
-- may read them but not write them.
grant select on public.swaps to authenticated;
grant select, insert, update, delete on public.sector_actuals to authenticated;
grant select, insert, update, delete on public.techlog to authenticated;
grant usage on sequence public.techlog_seq to authenticated;
grant select on public.techlog_history to authenticated;
grant select, insert, update on public.briefings to authenticated;
revoke insert, update, delete on public.profiles from authenticated;
grant update (display_name, vatsim_cid, notify) on public.profiles to authenticated;

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

drop policy if exists "members read swaps" on public.swaps;
create policy "members read swaps" on public.swaps
  for select to authenticated using (public.is_member());

-- Everyone reads the actual times; the flight deck stamps them, the same
-- people who keep the tech log.
drop policy if exists "members read actuals" on public.sector_actuals;
create policy "members read actuals" on public.sector_actuals
  for select to authenticated using (public.is_member());

drop policy if exists "flight deck stamps actuals" on public.sector_actuals;
create policy "flight deck stamps actuals" on public.sector_actuals
  for all to authenticated using (public.can_log()) with check (public.can_log());

-- Members read the tech log; the cockpit tablets, dispatchers and admins write
-- in it; only admins and dispatchers can delete an entry.
drop policy if exists "members read techlog" on public.techlog;
create policy "members read techlog" on public.techlog
  for select to authenticated using (public.is_member());

drop policy if exists "crew add to techlog" on public.techlog;
create policy "crew add to techlog" on public.techlog
  for insert to authenticated with check (public.can_log());

drop policy if exists "crew update techlog" on public.techlog;
create policy "crew update techlog" on public.techlog
  for update to authenticated using (public.can_log()) with check (public.can_log());

drop policy if exists "editors delete techlog" on public.techlog;
create policy "editors delete techlog" on public.techlog
  for delete to authenticated using (public.can_edit());

drop policy if exists "members read techlog history" on public.techlog_history;
create policy "members read techlog history" on public.techlog_history
  for select to authenticated using (public.is_member());

-- Members read briefings; pilots, dispatchers and admins write them.
drop policy if exists "members read briefings" on public.briefings;
create policy "members read briefings" on public.briefings
  for select to authenticated using (public.is_member());

drop policy if exists "crew add briefings" on public.briefings;
create policy "crew add briefings" on public.briefings
  for insert to authenticated with check (public.can_report());

drop policy if exists "crew update briefings" on public.briefings;
create policy "crew update briefings" on public.briefings
  for update to authenticated using (public.can_report()) with check (public.can_report());

-- ---------- Flight deck tablets ----------
-- Two accounts that belong to the app rather than to a person, for the tablets
-- that stay in the cockpit. They sign in on the app's login page by name:
--
--     captain          first_officer
--
-- and share one password. Set it in the SQL Editor before you press Run, not
-- in the file itself: this repository is public. The password below only
-- applies the first time, when the accounts do not exist yet; after that,
-- change it with supabase/efb-password.sql.
--
-- Running this file again does not touch a password you have already changed.
create extension if not exists pgcrypto with schema extensions;

do $$
declare
  password constant text := 'change-me';   -- <= the tablets' password
  tablet record;
  uid uuid;
begin
  for tablet in
    select * from (values
      ('captain@qfa100.efb', 'Captain EFB'),
      ('first_officer@qfa100.efb', 'First Officer EFB')
    ) as t (email, display_name)
  loop
    select id into uid from auth.users where email = tablet.email;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data, created_at, updated_at
      ) values (
        '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
        tablet.email, extensions.crypt(password, extensions.gen_salt('bf')), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_build_object('display_name', tablet.display_name), now(), now()
      );
      insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
      values (
        tablet.email, uid,
        jsonb_build_object('sub', uid::text, 'email', tablet.email, 'email_verified', true),
        'email', now(), now()
      );
    end if;
    insert into public.profiles (id, display_name, role)
    values (uid, tablet.display_name, 'efb')
    on conflict (id) do update set display_name = excluded.display_name, role = 'efb';
  end loop;
exception when others then
  raise warning 'Could not create the flight deck tablet accounts (%). Everything else was set up. Create them by hand in Authentication -> Users with the addresses captain@qfa100.efb and first_officer@qfa100.efb, then set their role to EFB tablet in Admin.', sqlerrm;
end $$;

-- Supabase reads these columns as plain text, so a row created by hand with
-- them left empty makes signing in fail with "Database error querying schema".
-- This fills in anything missing, for these accounts and any other.
do $$
declare
  col text;
begin
  foreach col in array array[
    'confirmation_token', 'recovery_token', 'email_change', 'email_change_token_new',
    'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token'
  ]
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'auth' and table_name = 'users' and column_name = col
    ) then
      execute format('update auth.users set %I = %L where %I is null', col, '', col);
    end if;
  end loop;
end $$;
