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

-- ---------- Testing it before the event ----------
--
-- This cannot be tried on the real schedule while the event is still days
-- away, and the reason is worth knowing: every sector's expected departure is
-- in the future, so a departure old enough to be past the three minute grace
-- can never be within two hours of one. Both halves are working as intended
-- and together they match nothing.
--
-- So the test uses a sector of its own, sitting in the past, and deletes it
-- afterwards. sector_actuals and roster both cascade from sectors, so the
-- delete at step 6 takes the whole test with it. Run each step on its own and
-- do not leave step 2 in place with the bridge running - it will overwrite
-- sim_status within a couple of seconds, which is the bridge doing its job.
--
--   1. A sector that was expected away an hour ago. Being the earliest in the
--      schedule, nothing chains into it, so its expected departure is its std.
-- insert into public.sectors (flight, dep, arr, std, sta)
-- values ('ZZTEST', 'YSSY', 'NZAA', now() - interval '1 hour', now() + interval '1 hour');
--
--   2. Stand in for the bridge: the aeroplane went when that sector was due
--      and arrived ten minutes ago, both old enough to be past the grace.
-- update public.sim_status
-- set status = coalesce(status, '{}'::jsonb) || jsonb_build_object('blocks', jsonb_build_object(
--       'out', to_char(now() - interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
--       'off', to_char(now() - interval '50 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
--       'on',  to_char(now() - interval '15 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
--       'in',  to_char(now() - interval '10 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
--       'touchdownFpm', 138)),
--     updated_at = now()
-- where id = 1;
--
--   3. Take them. Answers 2 - one for each time written.
-- select public.autostamp_tick() as stamped;
--
--   4. And they should be against ZZTEST, said to be the simulator's.
-- select s.flight, a.off_blocks, a.on_blocks, a.by_name
-- from public.sectors s join public.sector_actuals a on a.sector_id = s.id
-- where s.flight = 'ZZTEST';
--
--   5. The rule that matters: a stamp of somebody's own is never overwritten.
--      This throws away what step 3 took, puts a departure in by hand five
--      minutes off the simulator's, and runs it again. It answers 1, not 2:
--      off blocks is left exactly as it was put in, by_name still says
--      'A Pilot', and only on blocks is filled in beside it.
-- delete from public.sector_actuals
-- where sector_id = (select id from public.sectors where flight = 'ZZTEST');
-- insert into public.sector_actuals (sector_id, off_blocks, by_name)
-- select id, now() - interval '55 minutes', 'A Pilot'
-- from public.sectors where flight = 'ZZTEST';
-- select public.autostamp_tick() as stamped;
-- select a.off_blocks, a.on_blocks, a.by_name
-- from public.sector_actuals a
-- join public.sectors s on s.id = a.sector_id
-- where s.flight = 'ZZTEST';
--
--   6. Put everything back. The sector takes its actuals with it, and
--      clearing the blocks stops the next tick acting on a made-up arrival.
-- delete from public.sectors where flight = 'ZZTEST';
-- update public.sim_status set status = status - 'blocks', updated_at = now() where id = 1;
