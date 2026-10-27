-- Off blocks and on blocks, stamped by the simulator when nobody stamped them.
--
-- Run after supabase/vpilot.sql and supabase/notifications.sql in the Supabase
-- SQL Editor. Safe to run again.
--
-- ---- Why ----
--
-- Everything about how the day is running is worked out from two times per
-- sector: off blocks and on blocks. Report times move by them, the delay
-- notices go out off them, the loadsheet is timed from them, and every later
-- sector's estimate is chained through them. Until now they existed only
-- because somebody tapped a button on the Dashboard, and a sector nobody
-- stamped was taken to have run exactly to schedule - so a delay quietly
-- disappeared from everything the database drives, while the screen showed
-- the truth from the live feed.
--
-- The bridge knows these times by itself now. It watches the simulator about
-- once a second and works out OUT, OFF, ON and IN from it - see BlockTimes in
-- the vpilot-plugin repository - and puts them in sim_status along with the
-- rest of the aeroplane's state. This reads them back and fills in what the
-- crew did not.
--
-- ---- The rules it follows ----
--
--   * A human stamp always wins. Nothing here ever overwrites one, and a time
--     corrected by hand stays corrected.
--   * The crew get first refusal: a time is left alone for three minutes
--     after the event, which is long enough for whoever is flying to stamp it
--     themselves.
--   * by_name says 'Simulator', so the Dashboard shows plainly which times
--     were stamped and which were taken.
--   * The times are attributed to one sector by matching when the aeroplane
--     actually went against when this sector was expected to go, inside two
--     hours. That matters: with a sector nobody stamped sitting unfinished in
--     the schedule, the obvious rule - "the first sector still waiting for an
--     arrival" - would put the aeroplane's current times onto the sector
--     before it.

-- ---------- Filling in what nobody stamped ----------

create or replace function public.autostamp_tick()
returns integer language plpgsql security definer set search_path = public as $fn$
declare
  -- Long enough for the crew to stamp it themselves if they are going to.
  grace  constant interval := interval '3 minutes';
  -- How far the simulator's departure may be from the one this sector was
  -- expected to make and still be the same sector.
  near   constant double precision := 7200;
  blocks jsonb;
  fresh  timestamptz;
  out_at timestamptz;
  in_at  timestamptz;
  target uuid;
  made   integer := 0;
  -- Fuel at each end of the sector, as the simulator had it. Kilograms:
  -- SimConnect is asked for kilograms and the sector's own OFP decides what
  -- the crew are shown, so this converts rather than assuming they match.
  fuel_out numeric;
  fuel_in  numeric;
  per_kg   numeric;
begin
  select status -> 'blocks', updated_at into blocks, fresh
  from public.sim_status where id = 1;

  -- No bridge, an older bridge that does not report these, or a simulator
  -- that has not been read for a quarter of an hour: nothing to take.
  if blocks is null or fresh is null or fresh < now() - interval '15 minutes' then
    return 0;
  end if;

  out_at := nullif(blocks ->> 'out', '')::timestamptz;
  in_at  := nullif(blocks ->> 'in', '')::timestamptz;
  -- Without a departure there is nothing to match a sector on, so there is
  -- nothing that can safely be written.
  if out_at is null then return 0; end if;

  select s.id into target
  from public.sectors s
  left join public.sector_actuals a on a.sector_id = s.id
  join public.sector_running() run on run.sector_id = s.id
  where a.on_blocks is null
    and not coalesce(a.skipped, false)
    and abs(extract(epoch from (coalesce(a.off_blocks, run.est_off) - out_at))) < near
  order by abs(extract(epoch from (coalesce(a.off_blocks, run.est_off) - out_at)))
  limit 1;

  if target is null then return 0; end if;

  fuel_out := nullif(blocks ->> 'fuelOutKg', '')::numeric;
  fuel_in  := nullif(blocks ->> 'fuelInKg', '')::numeric;
  -- Pounds if that is what the sector was planned in, kilograms otherwise.
  select case when lower(coalesce(b.ofp ->> 'units', 'kgs')) like 'lb%'
              then 2.20462 else 1 end
    into per_kg
  from public.briefings b where b.sector_id = target;
  per_kg := coalesce(per_kg, 1);

  -- Off blocks. The `where` on the conflict is what makes a human stamp
  -- untouchable: with a time already there the update matches nothing.
  if now() - out_at > grace then
    insert into public.sector_actuals (sector_id, off_blocks, by_name, updated_at)
    values (target, out_at, 'Simulator', now())
    on conflict (sector_id) do update
      set off_blocks = excluded.off_blocks,
          by_name = excluded.by_name,
          updated_at = now()
      where sector_actuals.off_blocks is null;
    if found then made := made + 1; end if;
  end if;

  -- And on blocks, which the bridge only reports once the aeroplane is
  -- plainly parked rather than held short - engines shut down, or the park
  -- brake set and five minutes without moving.
  if in_at is not null and now() - in_at > grace then
    insert into public.sector_actuals (sector_id, on_blocks, by_name, updated_at)
    values (target, in_at, 'Simulator', now())
    on conflict (sector_id) do update
      set on_blocks = excluded.on_blocks,
          by_name = case when sector_actuals.off_blocks is null
                         then excluded.by_name
                         else sector_actuals.by_name end,
          updated_at = now()
      where sector_actuals.on_blocks is null;
    if found then made := made + 1; end if;
  end if;

  -- The fuel figures, for the Finish sector form to open with. Only ever
  -- filled in where nobody has typed anything and the sector has not been
  -- finished: after that the numbers are the crew's and are left alone, which
  -- is the same rule the two times above follow.
  if fuel_in is not null then
    update public.sector_actuals
    set fuel_remaining = coalesce(fuel_remaining, round(fuel_in * per_kg)),
        fuel_used = coalesce(
          fuel_used,
          case when fuel_out is not null and fuel_out >= fuel_in
               then round((fuel_out - fuel_in) * per_kg) end),
        updated_at = now()
    where sector_id = target
      and completed_at is null
      and (fuel_remaining is null or fuel_used is null);
    if found then made := made + 1; end if;
  end if;

  return made;
end;
$fn$;

revoke all on function public.autostamp_tick() from public, anon, authenticated;

-- ---------- The clock ----------

select cron.unschedule('autostamp-tick') where exists (select 1 from cron.job where jobname = 'autostamp-tick');
select cron.schedule('autostamp-tick', '30 seconds', $job$ select public.autostamp_tick() $job$);

-- Run it once now and see what it says.
select public.autostamp_tick() as stamped_now;

-- ---------- Looking at it ----------
--
--   What the bridge currently makes of the aeroplane:
-- select updated_at, status -> 'blocks' as blocks from public.sim_status where id = 1;
--
--   Which times are the crew's and which were taken from the simulator:
-- select s.flight, s.dep, s.arr, a.off_blocks, a.on_blocks, a.by_name, a.updated_at
-- from public.sectors s join public.sector_actuals a on a.sector_id = s.id
-- order by s.std;
--
--   And which sector the times would be attributed to right now:
-- select s.flight, coalesce(a.off_blocks, run.est_off) as expected_away,
--        (select nullif(status -> 'blocks' ->> 'out', '')::timestamptz
--         from public.sim_status where id = 1) as actually_away
-- from public.sectors s
-- left join public.sector_actuals a on a.sector_id = s.id
-- join public.sector_running() run on run.sector_id = s.id
-- where a.on_blocks is null and not coalesce(a.skipped, false)
-- order by s.std;

-- ---------- Testing it ----------
--
-- Two blocks. Paste the first one in, press Run, look at the row it gives
-- back. Paste the second one in to tidy up. Nothing else to do.
--
-- It needs a sector of its own because the real ones are all still in the
-- future, and this only ever stamps a sector the aeroplane has already flown.
--
-- Do not leave the first block sitting there with the bridge running: it
-- overwrites sim_status within seconds, which is the bridge doing its job.
--
-- ---- 1. Run this ----
--
-- insert into public.sectors (flight, dep, arr, std, sta)
-- values ('ZZTEST', 'YSSY', 'NZAA', now() - interval '1 hour', now() + interval '1 hour');
--
-- update public.sim_status
-- set status = coalesce(status, '{}'::jsonb) || jsonb_build_object('blocks', jsonb_build_object(
--       'out', to_char(now() - interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
--       'in',  to_char(now() - interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
--     updated_at = now()
-- where id = 1;
--
-- select public.autostamp_tick() as times_taken;
--
-- select a.off_blocks, a.on_blocks, a.by_name
-- from public.sector_actuals a
-- join public.sectors s on s.id = a.sector_id
-- where s.flight = 'ZZTEST';
--
-- You should get one row, with both times filled in and by_name reading
-- Simulator. That is the whole thing working.
--
-- ---- 2. Then run this ----
--
-- delete from public.sectors where flight = 'ZZTEST';
-- update public.sim_status set status = status - 'blocks', updated_at = now() where id = 1;
--
-- ---- If you want to see a pilot's own stamp survive ----
--
-- Between the two blocks, run this. It puts a departure in by hand, five
-- minutes off the simulator's, and asks again. off_blocks keeps your time and
-- by_name keeps your name; only on_blocks is filled in.
--
-- update public.sector_actuals set off_blocks = now() - interval '55 minutes',
--                                 on_blocks = null, by_name = 'A Pilot'
-- where sector_id = (select id from public.sectors where flight = 'ZZTEST');
-- select public.autostamp_tick();
-- select off_blocks, on_blocks, by_name from public.sector_actuals
-- where sector_id = (select id from public.sectors where flight = 'ZZTEST');
