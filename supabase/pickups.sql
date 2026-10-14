-- Picking up an empty seat. Once the roster is published, a pilot can ask to
-- fill a seat nobody is rostered in; an admin or dispatcher agrees it before
-- the roster changes, the same way as a swap.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.

-- pending -> approved or declined, or withdrawn by the pilot who asked.
create table if not exists public.pickups (
  id         uuid primary key default gen_random_uuid(),
  sector_id  uuid not null references public.sectors (id) on delete cascade,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  duty       text not null check (duty in ('Captain', 'First Officer', 'Relief Pilot')),
  state      text not null default 'pending' check (state in ('pending', 'approved', 'declined', 'withdrawn')),
  note       text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pickups_state_idx on public.pickups (state);

-- Everyone on the team can see the requests; they only change through the
-- three functions below.
alter table public.pickups enable row level security;
revoke all on public.pickups from anon;
grant select on public.pickups to authenticated;
drop policy if exists "members read pickups" on public.pickups;
create policy "members read pickups" on public.pickups
  for select to authenticated using (public.is_member());

-- Ask to fly an empty seat on a sector that has not gone yet.
create or replace function public.request_pickup(sector uuid, seat text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  s   public.sectors%rowtype;
  new_id uuid;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'dispatcher', 'pilot')) then
    raise exception 'Only pilots can pick up a sector';
  end if;
  if not public.roster_published() then raise exception 'The roster has not been published yet'; end if;
  select * into s from public.sectors where id = sector;
  if s.id is null then raise exception 'That sector no longer exists'; end if;
  if s.std < now() then raise exception 'That sector has already gone'; end if;
  if seat not in ('Captain', 'First Officer', 'Relief Pilot') then raise exception 'Unknown seat'; end if;
  if exists (select 1 from public.roster where sector_id = sector and duty = seat) then
    raise exception 'Somebody is already rostered in that seat';
  end if;
  if exists (select 1 from public.roster where sector_id = sector and user_id = auth.uid()) then
    raise exception 'You are already on that sector';
  end if;
  if exists (select 1 from public.pickups where sector_id = sector and user_id = auth.uid() and state = 'pending') then
    raise exception 'You have already asked for that sector';
  end if;

  insert into public.pickups (sector_id, user_id, duty) values (sector, auth.uid(), seat)
  returning pickups.id into new_id;

  perform public.tell(t.id, 'roster', format('%s: %s wants a seat', s.flight,
      (select display_name from public.profiles where id = auth.uid())),
    format('%s to %s as %s on %s. It needs an admin or dispatcher to agree.', s.dep, s.arr, seat,
           to_char(s.std, 'DD Mon HH24:MI"Z"')),
    '#/admin', 'pickup-' || new_id || '-' || t.id)
  from public.profiles t
  where t.role in ('admin', 'dispatcher') and t.id <> auth.uid() and not t.is_test;
  return new_id;
end;
$$;

-- Take back a request that has not been decided yet.
create or replace function public.withdraw_pickup(pickup uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  p public.pickups%rowtype;
begin
  select * into p from public.pickups where id = pickup;
  if p.id is null or p.state <> 'pending' then raise exception 'That request is already settled'; end if;
  if p.user_id <> auth.uid() and not public.can_edit() then
    raise exception 'Only the pilot who asked, or an admin, can take it back';
  end if;
  update public.pickups set state = 'withdrawn', updated_at = now() where id = pickup;
end;
$$;

-- An admin or dispatcher agrees, which rosters the pilot in the seat, or turns
-- it down. report is the report time the app works out from the duty rules.
create or replace function public.decide_pickup(pickup uuid, agree boolean, why text default '', report timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  p record;
begin
  if not public.can_edit() then raise exception 'Only admins and dispatchers can agree a pickup'; end if;
  select pk.*, s.flight, s.dep, s.arr, s.std into p
  from public.pickups pk join public.sectors s on s.id = pk.sector_id
  where pk.id = pickup;
  if p.id is null or p.state <> 'pending' then raise exception 'That request is already settled'; end if;

  if agree then
    if exists (select 1 from public.roster where sector_id = p.sector_id and duty = p.duty) then
      raise exception 'Somebody is already rostered in that seat';
    end if;
    if exists (select 1 from public.roster where sector_id = p.sector_id and user_id = p.user_id) then
      raise exception 'They are already on that sector';
    end if;
    insert into public.roster (sector_id, user_id, duty, report_at, auto)
    values (p.sector_id, p.user_id, p.duty, coalesce(report, p.std - interval '60 minutes'), false);
    update public.pickups set state = 'approved', note = coalesce(why, ''), updated_at = now() where id = pickup;
    perform public.tell(p.user_id, 'roster', format('%s is yours', p.flight),
      format('%s to %s as %s on %s.', p.dep, p.arr, p.duty, to_char(p.std, 'DD Mon HH24:MI"Z"')),
      '#/roster', 'pickup-done-' || pickup);

    -- Anyone else waiting on the same seat has missed out.
    perform public.tell(o.user_id, 'roster', format('%s has been filled', p.flight),
      format('The %s seat went to somebody else.', p.duty), '#/roster', 'pickup-no-' || o.id)
    from public.pickups o
    where o.sector_id = p.sector_id and o.duty = p.duty and o.state = 'pending' and o.id <> pickup;
    update public.pickups set state = 'declined', note = 'The seat was filled', updated_at = now()
    where sector_id = p.sector_id and duty = p.duty and state = 'pending' and id <> pickup;
  else
    update public.pickups set state = 'declined', note = coalesce(why, ''), updated_at = now() where id = pickup;
    perform public.tell(p.user_id, 'roster', format('%s: not this time', p.flight),
      case when coalesce(why, '') = '' then 'Your request for the seat was turned down.' else why end,
      '#/roster', 'pickup-no-' || pickup);
  end if;
end;
$$;

revoke execute on function public.request_pickup(uuid, text) from anon, public;
grant execute on function public.request_pickup(uuid, text) to authenticated;
revoke execute on function public.withdraw_pickup(uuid) from anon, public;
grant execute on function public.withdraw_pickup(uuid) to authenticated;
revoke execute on function public.decide_pickup(uuid, boolean, text, timestamptz) from anon, public;
grant execute on function public.decide_pickup(uuid, boolean, text, timestamptz) to authenticated;
