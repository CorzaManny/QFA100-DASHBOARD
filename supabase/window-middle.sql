-- Move every sector from the opening of its departure window to the middle.
--
-- The schedule used to plan against the moment the WorldFlight window opened,
-- which left the whole window ahead of the team and nothing behind it: a
-- sector that got away late was late against its own plan from the first
-- minute. Planning against the middle puts half the window either side, so an
-- hour lost is an hour the schedule can absorb rather than carry.
--
-- Nothing about the published window changes. dep_window_min is still the
-- whole window; it is now centred on std rather than starting there.
--
-- Run ONCE, after tools/build_schedule.py has been re-run and the new
-- supabase/worldflight.sql has been applied. The guard below refuses a second
-- run, because the shift is relative and running it twice would move the
-- schedule an hour too far.
--
-- Report times move with the sectors. Each person keeps the lead they were
-- rostered with - a 45-minute report stays 45 minutes before the departure
-- it belongs to - so everybody signs on an hour later than the published
-- roster currently says. Tell the team before running this.
--
-- Times the flight deck has stamped (sector_actuals) are left exactly as they
-- are: they are a record of what happened, not a plan.

begin;

do $$
begin
  if (select min(std) from public.sectors) <> timestamptz '2026-10-31 20:00:00+00' then
    raise exception
      'Sectors do not start at the 2026 window-opening time (first std is %). '
      'This migration has probably already run; it must not run twice.',
      (select min(std) from public.sectors);
  end if;
end $$;

-- Report times first, while the sectors still hold the old std: the shift is
-- the same for every entry on a sector, so each person's own lead survives it.
update public.roster r
set report_at = r.report_at + make_interval(mins => coalesce(s.dep_window_min, 0) / 2)
from public.sectors s
where s.id = r.sector_id;

update public.sectors
set std = std + make_interval(mins => coalesce(dep_window_min, 0) / 2),
    sta = sta + make_interval(mins => coalesce(dep_window_min, 0) / 2);

-- The checker's copy of the published schedule, so the Schedule page does not
-- immediately report all 43 sectors as having drifted. Re-running
-- supabase/worldflight.sql rebuilds this from the WorldFlight page with the
-- new reading and would land on the same times, but it runs on a six-hourly
-- cron and the team would see the alarm until it did.
--
-- Guarded on its own state rather than the sectors', so it does not matter
-- which of the two files is run first: whichever has already moved this table
-- leaves it alone here.
do $$
begin
  if (select min(std) from public.official_schedule) = timestamptz '2026-10-31 20:00:00+00' then
    update public.official_schedule
    set std = std + make_interval(mins => coalesce(dep_window_min, 0) / 2),
        sta = sta + make_interval(mins => coalesce(dep_window_min, 0) / 2);
  end if;
end $$;

commit;

-- What it did, to read back in the SQL editor.
select
  (select min(std) from public.sectors)            as first_departure,
  (select max(sta) from public.sectors)            as last_arrival,
  (select count(*) from public.sectors)            as sectors,
  (select count(*) from public.roster)             as report_times_moved,
  (select count(*) from public.roster r join public.sectors s on s.id = r.sector_id
    where r.report_at >= s.std)                    as reports_not_before_departure;
