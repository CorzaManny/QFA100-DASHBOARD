-- Changes a pilot has to confirm before they carry on using the app.
--
-- Run this in the SQL Editor after schema.sql. Safe to run again.
--
-- A roster that moves under somebody is worse than no roster at all: the crew
-- read it once, in the morning, and then fly the day from memory. So anything
-- that changes what one person is doing - put on a sector, taken off one,
-- another seat, a new report time, or the sector itself moving - writes a row
-- in here. The app will not let them past it until they have read it and
-- pressed the button, and ops can see who has.
--
-- This counts changes they caused themselves too. Taking somebody else's
-- sector in a swap is exactly when a pilot has the day in their head wrong,
-- so being made to read what they have just taken on is the point rather than
-- an oversight.
--
-- sector_id deliberately carries no foreign key: a sector being deleted takes
-- its roster entries with it, and the row that says so has to outlive both.

create table if not exists public.crew_changes (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  sector_id  uuid,
  flight     text not null default '',
  kind       text not null check (kind in ('added', 'removed', 'duty', 'report', 'sector')),
  headline   text not null,
  detail     text not null default '',
  by_name    text not null default '',   -- who made it, where anybody did
  created_at timestamptz not null default now(),
  seen_at    timestamptz
);

create index if not exists crew_changes_waiting_idx on public.crew_changes (user_id) where seen_at is null;

alter table public.crew_changes enable row level security;

-- Written by the triggers below and cleared by confirm_changes, both security
-- definer, so nobody writes this table directly.
grant select on public.crew_changes to authenticated;

-- A person reads their own. Ops read everybody's, because "who has not seen
-- it yet" is the half of this that matters to the desk.
drop policy if exists "own or ops read changes" on public.crew_changes;
create policy "own or ops read changes" on public.crew_changes
  for select to authenticated using (user_id = auth.uid() or public.can_edit());

-- Only the people who fly are stopped. A cockpit tablet is a shared account
-- with no roster of its own, and an ops controller cannot be locked out of
-- the board they are working.
create or replace function public.confirms_changes(who uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles where id = who and role in ('admin', 'dispatcher', 'pilot', 'observer')
  );
$$;

-- ---------- Writing them down ----------

create or replace function public.note_crew_change(
  who uuid, sector uuid, flight_no text, kind text, headline text, detail text default ''
)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.confirms_changes(who) then return; end if;
  insert into public.crew_changes (user_id, sector_id, flight, kind, headline, detail, by_name)
  values (who, sector, coalesce(flight_no, ''), kind, headline, coalesce(detail, ''),
          coalesce((select display_name from public.profiles where id = auth.uid()), ''));
end;
$$;

-- Somebody's own roster changing. The same shape as notify_roster_change in
-- supabase/notifications.sql, which sends the push; this writes the thing they
-- have to confirm. Nothing is written while the roster is still a draft, and
-- nothing about a sector that has already gone.
create or replace function public.crew_change_roster()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  entry public.roster%rowtype;
  s     record;
begin
  if tg_op = 'DELETE' then entry := old; else entry := new; end if;
  if not public.roster_published() then return entry; end if;
  select * into s from public.sectors where id = entry.sector_id;
  if s.id is null or s.std < now() then return entry; end if;

  if tg_op = 'DELETE' then
    perform public.note_crew_change(old.user_id, s.id, s.flight, 'removed',
      format('You are off %s', s.flight),
      format('%s to %s on %s is no longer yours.', s.dep, s.arr, to_char(s.std, 'DD Mon HH24:MI"Z"')));
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.note_crew_change(new.user_id, s.id, s.flight, 'added',
      format('You are on %s', s.flight),
      format('%s to %s as %s, off %s. Report %s.', s.dep, s.arr, new.duty,
             to_char(s.std, 'DD Mon HH24:MI"Z"'), to_char(new.report_at, 'DD Mon HH24:MI"Z"')));
    return new;
  end if;

  -- A swap or a drag in the Landscape view hands the seat to somebody else:
  -- two people's days change, so both are told.
  if new.user_id <> old.user_id then
    perform public.note_crew_change(old.user_id, s.id, s.flight, 'removed',
      format('You are off %s', s.flight),
      format('%s to %s on %s has gone to %s.', s.dep, s.arr, to_char(s.std, 'DD Mon HH24:MI"Z"'),
             coalesce((select display_name from public.profiles where id = new.user_id), 'somebody else')));
    perform public.note_crew_change(new.user_id, s.id, s.flight, 'added',
      format('You are on %s', s.flight),
      format('%s to %s as %s, off %s. Report %s.', s.dep, s.arr, new.duty,
             to_char(s.std, 'DD Mon HH24:MI"Z"'), to_char(new.report_at, 'DD Mon HH24:MI"Z"')));
    return new;
  end if;

  if new.duty <> old.duty then
    perform public.note_crew_change(new.user_id, s.id, s.flight, 'duty',
      format('%s: you are now %s', s.flight, new.duty),
      format('Was %s. %s to %s on %s.', old.duty, s.dep, s.arr, to_char(s.std, 'DD Mon HH24:MI"Z"')));
  end if;

  if new.report_at <> old.report_at then
    perform public.note_crew_change(new.user_id, s.id, s.flight, 'report',
      format('%s: report %s', s.flight, to_char(new.report_at, 'HH24:MI"Z"')),
      format('Was %s. %s to %s, off %s.', to_char(old.report_at, 'DD Mon HH24:MI"Z"'),
             s.dep, s.arr, to_char(s.std, 'DD Mon HH24:MI"Z"')));
  end if;
  return new;
end;
$$;

drop trigger if exists crew_changes_roster on public.roster;
create trigger crew_changes_roster after insert or update or delete on public.roster
  for each row execute function public.crew_change_roster();

-- The sector itself moving: WorldFlight republishing the programme, or ops
-- changing a time or an airport. Everybody rostered on it has to read that.
create or replace function public.crew_change_sector()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r      record;
  parts  text[] := '{}';
  detail text;
begin
  if not public.roster_published() then return new; end if;
  if new.std < now() and old.std < now() then return new; end if;

  if new.dep <> old.dep or new.arr <> old.arr then
    parts := parts || format('%s to %s, was %s to %s', new.dep, new.arr, old.dep, old.arr);
  end if;
  if new.std <> old.std then
    parts := parts || format('off %s, was %s',
      to_char(new.std, 'DD Mon HH24:MI"Z"'), to_char(old.std, 'DD Mon HH24:MI"Z"'));
  end if;
  if new.sta <> old.sta then
    parts := parts || format('in %s, was %s',
      to_char(new.sta, 'DD Mon HH24:MI"Z"'), to_char(old.sta, 'DD Mon HH24:MI"Z"'));
  end if;
  if cardinality(parts) = 0 then return new; end if;
  detail := array_to_string(parts, '. ');
  detail := upper(left(detail, 1)) || substr(detail, 2) || '.';

  for r in select user_id from public.roster where sector_id = new.id loop
    perform public.note_crew_change(r.user_id, new.id, new.flight, 'sector',
      format('%s has changed', new.flight), detail);
  end loop;
  return new;
end;
$$;

drop trigger if exists crew_changes_sector on public.sectors;
create trigger crew_changes_sector after update on public.sectors
  for each row execute function public.crew_change_sector();

-- ---------- Confirming them ----------

-- Everything waiting on this person, or just the rows given. Returns how many
-- were cleared, so the app can say so.
create or replace function public.confirm_changes(ids bigint[] default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  cleared integer;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  update public.crew_changes
  set seen_at = now()
  where user_id = auth.uid() and seen_at is null and (ids is null or id = any (ids));
  get diagnostics cleared = row_count;
  return cleared;
end;
$$;

revoke all on function public.note_crew_change(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.confirm_changes(bigint[]) from public, anon;
grant execute on function public.confirm_changes(bigint[]) to authenticated;
grant execute on function public.confirms_changes(uuid) to authenticated;

-- Changes confirmed a week ago are no use to anybody. Tidied nightly where
-- the project has pg_cron (notifications.sql turns it on), and once now
-- either way.
delete from public.crew_changes where seen_at < now() - interval '7 days';

do $$
begin
  perform cron.unschedule('crew-changes-tidy')
  where exists (select 1 from cron.job where jobname = 'crew-changes-tidy');
  perform cron.schedule('crew-changes-tidy', '45 3 * * *',
    $job$ delete from public.crew_changes where seen_at < now() - interval '7 days' $job$);
exception when undefined_table or undefined_function or invalid_schema_name then
  null;  -- no pg_cron in this project; the delete above is all there is
end;
$$;
