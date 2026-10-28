-- Report-time moves, proposed by the running delay and decided by ops.
--
-- Run this in the SQL Editor after schema.sql and notifications.sql. Safe to
-- run again.
--
-- The app used to move a report time by itself: whatever delay the day was
-- running was laid over the published report time, and that was the time the
-- pilot saw. It was never wrong, and it was never decided by anybody either -
-- one stamped time in Jakarta quietly moved the moment somebody three sectors
-- later would set an alarm for, and there was nobody to ask about it.
--
-- So the estimate only raises a question now. A delay big enough to matter
-- puts a row in front of the ops controller on shift, who approves it, puts
-- their own time in instead, or leaves the published time alone. Until one of
-- those happens the roster's report_at is what everybody reports at, exactly
-- as published.
--
-- One row per roster entry, kept for as long as the sector is still to go.
-- Only the rows in state 'pending' are a question; the app reads those and
-- nothing else. The rest are the bookkeeping that stops the same question
-- being asked twice:
--
--   anchor_off      the departure estimate the current report_at is lined up
--                   with. The published std to begin with, and whatever the
--                   estimate was the moment somebody last set a report time.
--                   A move is measured from here, so approving one does not
--                   leave the next tick measuring the same delay again.
--   aligned_report  the report_at that alignment was made for. When these
--                   stop matching, somebody has set a report time outside
--                   this file - the Admin roster editor, usually - and the
--                   row re-anchors itself to the estimate in front of them
--                   when they did it.
--   asked_off       the estimate behind the last question put to ops. Nothing
--                   is asked again until the estimate has moved another
--                   threshold's worth past it, so leaving a delay alone does
--                   not mean being asked about the same twenty minutes a
--                   minute later.

create table if not exists public.report_shifts (
  roster_id       uuid primary key references public.roster (id) on delete cascade,
  sector_id       uuid not null references public.sectors (id) on delete cascade,
  state           text not null default 'settled' check (state in ('pending', 'settled')),
  anchor_off      timestamptz not null,
  aligned_report  timestamptz not null,
  asked_off       timestamptz,
  proposed_at     timestamptz,                -- what is being asked for, while pending
  published_at    timestamptz,                -- the report time it would replace
  est_off         timestamptz,                -- the estimate behind it, kept fresh
  delay_minutes   integer not null default 0,
  raised_at       timestamptz,
  decided_by      uuid references public.profiles (id) on delete set null,
  decided_at      timestamptz,
  decided_report  timestamptz                 -- the time ops set, or null if they left it
);

create index if not exists report_shifts_pending_idx on public.report_shifts (state);
create index if not exists report_shifts_sector_idx on public.report_shifts (sector_id);

alter table public.report_shifts enable row level security;

-- Written only by the functions below, all of them security definer, so there
-- is no write policy: the table is read-only to everyone who can read it.
grant select on public.report_shifts to authenticated;

drop policy if exists "members read report shifts" on public.report_shifts;
create policy "members read report shifts" on public.report_shifts
  for select to authenticated using (public.is_member());

-- Estimates are a guess, so a proposed time is to the nearest five minutes,
-- the same as every other estimate the app draws. A report time somebody set
-- is left exactly where they put it.
create or replace function public.round5(t timestamptz)
returns timestamptz language sql immutable as $$
  select to_timestamp(round(extract(epoch from t) / 300) * 300);
$$;

-- ---------- Raising one ----------

-- Called from push_tick every ten seconds. Looks at what the day is actually
-- doing and keeps this table in step with it:
--
--   * a move worth a decision, on a sector close enough to matter, goes
--     pending and tells the ops controllers once, per sector rather than per
--     seat - three pilots on one aeroplane are one decision;
--   * a pending row follows the estimate silently, so what ops approve is the
--     latest figure rather than the one from twenty minutes ago;
--   * a pending row whose delay has come back in settles itself, because the
--     question has answered itself and nobody should have to clear it;
--   * a settled row asks again only when the estimate has moved another
--     threshold's worth since the last question.
--
-- Rows for sectors that have gone are deleted, so what is left is only ever
-- about sectors still to fly.
create or replace function public.raise_report_shifts()
returns integer language plpgsql security definer set search_path = public as $$
declare
  threshold integer;
  within_   integer;
  r         record;
  x         public.report_shifts%rowtype;
  anchor    timestamptz;
  suggested timestamptz;
  move      numeric;
  raised    uuid[] := '{}';
  sector    uuid;
  info      record;
  made      integer := 0;
begin
  if not public.roster_published() then return 0; end if;
  select round(coalesce((rules ->> 'delayNoticeMinutes')::numeric, 20))::integer,
         round(coalesce((rules ->> 'delayNoticeWithinHours')::numeric, 6))::integer
    into threshold, within_ from public.settings limit 1;
  threshold := coalesce(threshold, 20);
  within_ := coalesce(within_, 6);
  if threshold <= 0 or within_ <= 0 then return 0; end if;

  -- A sector that has gone, or been skipped, has nothing left to decide.
  delete from public.report_shifts sh
  using public.sectors s left join public.sector_actuals a on a.sector_id = s.id
  where s.id = sh.sector_id
    and (a.off_blocks is not null or coalesce(a.skipped, false) or s.std < now() - interval '1 hour');

  for r in
    select rt.*
    from public.report_times rt
    left join public.sector_actuals a on a.sector_id = rt.sector_id
    where a.off_blocks is null
      and not coalesce(a.skipped, false)
      and rt.std > now()
      and rt.report_at <= now() + make_interval(hours => within_)
  loop
    select * into x from public.report_shifts where roster_id = r.roster_id;

    -- First sight of this entry: its report time is lined up with the
    -- published schedule, which is what it was rostered against.
    if x.roster_id is null then
      insert into public.report_shifts (roster_id, sector_id, anchor_off, aligned_report, est_off, delay_minutes)
      values (r.roster_id, r.sector_id, r.std, r.report_at, r.est_off, r.delay_minutes)
      returning * into x;
    -- Somebody has set this report time outside this file - the Admin roster
    -- editor, or a swap bringing an entry's own time with it. They did it
    -- looking at the estimate in front of them, so that is what it is now
    -- lined up with, and the delay already in it is not asked about again.
    elsif x.aligned_report <> r.report_at then
      update public.report_shifts
      set anchor_off = r.est_off, aligned_report = r.report_at, asked_off = r.est_off,
          state = 'settled', proposed_at = null, published_at = null,
          est_off = r.est_off, delay_minutes = r.delay_minutes
      where roster_id = r.roster_id
      returning * into x;
    end if;

    anchor := x.anchor_off;
    suggested := public.round5(r.report_at + (r.est_off - anchor));
    move := abs(extract(epoch from (suggested - r.report_at)));

    if x.state = 'pending' then
      if move >= threshold * 60 then
        -- Still worth asking: follow the estimate, quietly.
        update public.report_shifts
        set proposed_at = suggested, published_at = r.report_at, est_off = r.est_off,
            delay_minutes = r.delay_minutes
        where roster_id = r.roster_id;
      else
        -- The delay has come back in. Nothing to decide any more.
        update public.report_shifts
        set state = 'settled', proposed_at = null, published_at = null, asked_off = r.est_off,
            est_off = r.est_off, delay_minutes = r.delay_minutes
        where roster_id = r.roster_id;
      end if;
    elsif move >= threshold * 60
      and (x.asked_off is null or abs(extract(epoch from (r.est_off - x.asked_off))) >= threshold * 60) then
      update public.report_shifts
      set state = 'pending', proposed_at = suggested, published_at = r.report_at, asked_off = r.est_off,
          est_off = r.est_off, delay_minutes = r.delay_minutes, raised_at = now(),
          decided_by = null, decided_at = null, decided_report = null
      where roster_id = r.roster_id;
      if not (r.sector_id = any (raised)) then raised := raised || r.sector_id; end if;
      made := made + 1;
    else
      -- Nothing to ask; keep the figures fresh for whoever looks.
      update public.report_shifts
      set est_off = r.est_off, delay_minutes = r.delay_minutes
      where roster_id = r.roster_id;
    end if;
  end loop;

  -- One word per sector, not one per seat.
  foreach sector in array raised loop
    select s.flight, s.dep, s.arr, s.std, sh.est_off, sh.delay, sh.seats into info
    from public.sectors s
    cross join lateral (
      select max(est_off) as est_off, max(delay_minutes) as delay, count(*) as seats
      from public.report_shifts where sector_id = sector and state = 'pending'
    ) sh
    where s.id = sector;
    continue when info.flight is null or info.seats = 0;

    perform public.notify(
      p.id, 'delay',
      format('%s report times need a decision', info.flight),
      format('Running %s min %s. %s seat%s to decide, %s to %s on %s.',
             abs(info.delay), case when info.delay > 0 then 'late' else 'early' end,
             info.seats, case when info.seats = 1 then '' else 's' end,
             info.dep, info.arr, to_char(info.std, 'DD Mon')),
      '#/ops',
      format('shift-%s-%s-%s', sector, to_char(info.est_off, 'YYYYMMDDHH24MI'), p.id),
      7200
    )
    from public.profiles p
    where p.role in ('admin', 'dispatcher', 'operations') and not p.is_test;
  end loop;
  return made;
end;
$$;

-- ---------- Deciding one ----------

-- Approving writes the report time onto the roster entry, which is the only
-- report time anything else reads. report is the controller's own time when
-- they have typed one, and the proposal when they have not. Either way the row
-- is now lined up with the estimate they were looking at, so the same delay is
-- never put in front of them twice.
create or replace function public.approve_report_shift(entry uuid, report timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  sh    public.report_shifts%rowtype;
  when_ timestamptz;
begin
  if not public.can_edit() then raise exception 'Only ops staff can move a report time'; end if;
  select * into sh from public.report_shifts where roster_id = entry;
  if sh.roster_id is null or sh.state <> 'pending' then
    raise exception 'That report time is not waiting on a decision';
  end if;
  when_ := coalesce(report, sh.proposed_at);
  if when_ is null then raise exception 'Give a report time'; end if;

  -- This is what tells the pilot, and what holds them until they have
  -- confirmed it; see supabase/crew-confirm.sql.
  update public.roster set report_at = when_ where id = entry;
  update public.report_shifts
  set state = 'settled', anchor_off = coalesce(sh.est_off, sh.anchor_off), aligned_report = when_,
      asked_off = sh.est_off, proposed_at = null, published_at = null,
      decided_by = auth.uid(), decided_at = now(), decided_report = when_
  where roster_id = entry;
  return when_;
end;
$$;

-- Every seat on one sector in a single press, since that is how a delay
-- actually arrives. Each entry keeps the lead it was rostered with, so they
-- move together but not onto the same minute.
create or replace function public.approve_sector_report_shifts(sector uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r      record;
  count_ integer := 0;
begin
  if not public.can_edit() then raise exception 'Only ops staff can move a report time'; end if;
  for r in select roster_id from public.report_shifts where sector_id = sector and state = 'pending' loop
    perform public.approve_report_shift(r.roster_id);
    count_ := count_ + 1;
  end loop;
  return count_;
end;
$$;

-- Leaving the published time alone. The estimate behind the question is
-- remembered as the mark the next one is measured against, so waving a delay
-- away does not mean being asked about the same twenty minutes again.
create or replace function public.dismiss_report_shift(entry uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  sh public.report_shifts%rowtype;
begin
  if not public.can_edit() then raise exception 'Only ops staff can decide a report time'; end if;
  select * into sh from public.report_shifts where roster_id = entry;
  if sh.roster_id is null or sh.state <> 'pending' then
    raise exception 'That report time is not waiting on a decision';
  end if;
  update public.report_shifts
  set state = 'settled', asked_off = sh.est_off, proposed_at = null, published_at = null,
      decided_by = auth.uid(), decided_at = now(), decided_report = null
  where roster_id = entry;
end;
$$;

create or replace function public.dismiss_sector_report_shifts(sector uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r      record;
  count_ integer := 0;
begin
  if not public.can_edit() then raise exception 'Only ops staff can decide a report time'; end if;
  for r in select roster_id from public.report_shifts where sector_id = sector and state = 'pending' loop
    perform public.dismiss_report_shift(r.roster_id);
    count_ := count_ + 1;
  end loop;
  return count_;
end;
$$;

revoke all on function public.raise_report_shifts() from public, anon, authenticated;
revoke all on function public.approve_report_shift(uuid, timestamptz),
                      public.approve_sector_report_shifts(uuid),
                      public.dismiss_report_shift(uuid),
                      public.dismiss_sector_report_shifts(uuid)
  from public, anon;
grant execute on function public.approve_report_shift(uuid, timestamptz),
                         public.approve_sector_report_shifts(uuid),
                         public.dismiss_report_shift(uuid),
                         public.dismiss_sector_report_shifts(uuid)
  to authenticated;

-- notified_report belonged to the old automatic notice, which told somebody
-- their report time had moved because the estimate had. Nothing moves a report
-- time now but an ops controller, and changing the roster entry is what tells
-- the pilot.
drop table if exists public.notified_report;

-- Run it once now, and see what is waiting.
select public.raise_report_shifts() as raised;

select p.display_name, s.flight, sh.state, sh.published_at, sh.proposed_at, sh.delay_minutes
from public.report_shifts sh
join public.roster ro on ro.id = sh.roster_id
join public.profiles p on p.id = ro.user_id
join public.sectors s on s.id = sh.sector_id
order by sh.state, s.std;
