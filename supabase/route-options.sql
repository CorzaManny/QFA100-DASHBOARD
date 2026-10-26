-- The sectors WorldFlight publishes two ways round, and which way the team flies.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- A few sectors each year offer a choice: WorldFlight publishes the same
-- departure time and block time twice, once per route, and a team flies one of
-- them. In 2026 there are two such runs - SKBO to DNMM either via TBPB and
-- GVAC or via TTPP and GVSV, and EINN to EHAM either via EGSS or via EGKB.
--
-- Both are kept on the one sector row, so there is nothing to roster twice:
-- dep/arr/route is option A, alt_dep/alt_arr/alt_route is option B, and leg
-- says which of them the team is flying. Switching a run over therefore keeps
-- its crew, its report times, its handover and its notes exactly where they
-- are - the aeroplane is simply going somewhere else.
--
-- Afterwards, run supabase/worldflight.sql again: that is what reads the
-- alternatives off the WorldFlight site and fills the columns below. Teams
-- loading the bundled programme get them from supabase/schedule.sql instead.

-- ---------- Where the choice is kept ----------

-- Null alt_dep means this sector has only one route, which is almost all of them.
alter table public.sectors add column if not exists alt_dep text;
alter table public.sectors add column if not exists alt_arr text;
alter table public.sectors add column if not exists alt_route text not null default '';
alter table public.sectors add column if not exists leg text not null default 'A';

alter table public.sectors drop constraint if exists sectors_leg_check;
alter table public.sectors add constraint sectors_leg_check check (leg in ('A', 'B'));

-- An alternative is either there in full or not at all; half of one would
-- leave the app with a route to nowhere.
alter table public.sectors drop constraint if exists sectors_alt_check;
alter table public.sectors add constraint sectors_alt_check check (
  (alt_dep is null and alt_arr is null)
  or (alt_dep ~ '^[A-Z0-9]{4}$' and alt_arr ~ '^[A-Z0-9]{4}$')
);

-- A sector with no alternative can only be on option A.
update public.sectors set leg = 'A' where alt_dep is null and leg <> 'A';

-- ---------- Choosing a route ----------

-- Sets the whole run at once. A run is picked out by the app and passed in as
-- the sector numbers it is made of, because the choice cannot be made one
-- sector at a time: flying WF2619 to TTPP and then WF2620 out of TBPB would
-- leave the aeroplane in the wrong ocean.
--
-- The imported flight plan is dropped for every sector that actually changed -
-- it was built for the other route's airports, so keeping it would brief the
-- crew on a flight they are no longer making. Everything else in the briefing
-- is kept. Returns how many sectors of the run are now on the chosen route.
create or replace function public.set_route_leg(flights text[], new_leg text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  moved integer;
begin
  if not public.can_edit() then
    -- Whoever may edit the schedule: an admin or dispatcher, and operations
    -- too where supabase/operations-role.sql has been run.
    raise exception 'Only someone who can edit the schedule may choose the route';
  end if;
  if new_leg is null or new_leg not in ('A', 'B') then
    raise exception 'The route has to be A or B';
  end if;
  if flights is null or array_length(flights, 1) is null then
    raise exception 'Say which sectors the run is made of';
  end if;

  -- Only sectors that have an alternative, and are not already on that route.
  with picked as (
    update public.sectors
    set leg = new_leg
    where flight = any (flights) and alt_dep is not null and leg <> new_leg
    returning id
  )
  update public.briefings b
  set ofp = null, ofp_by = '', ofp_at = null, updated_at = now()
  where b.sector_id in (select id from picked) and b.ofp is not null;

  -- How many sectors of the run are now on the chosen route, which is what the
  -- app tells the team. It is not row_count above: that counts the briefings
  -- cleared, and most sectors have no imported plan to clear.
  select count(*) into moved
  from public.sectors
  where flight = any (flights) and alt_dep is not null and leg = new_leg;

  return moved;
end;
$$;

revoke execute on function public.set_route_leg(text[], text) from anon, public;
grant execute on function public.set_route_leg(text[], text) to authenticated;
