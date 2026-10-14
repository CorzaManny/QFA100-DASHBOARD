-- Bidding: a deadline for everyone's availability, set by an admin.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- While bidding is open, pilots say which sectors they want. At the moment it
-- closes, availability is sealed and the roster is built from it. The roster
-- cannot be published before then, so nobody is rostered off half the bids.
--
-- The whole thing is optional: with bidding switched off the app behaves as it
-- always has, and availability can be changed at any time.

alter table public.settings add column if not exists bidding_enabled boolean not null default false;
alter table public.settings add column if not exists bids_close_at timestamptz;

-- Is bidding switched on, and has the deadline passed?
create or replace function public.bidding_closed()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select bidding_enabled and bids_close_at is not null and now() >= bids_close_at
     from public.settings where id = 1),
    false
  );
$$;

-- Once bidding closes, availability is sealed. Ops staff can still change it
-- for somebody, because a late phone call still has to be dealt with.
drop policy if exists "set availability" on public.preferences;
create policy "set availability" on public.preferences
  for all to authenticated
  using ((user_id = auth.uid() and public.is_member()) or public.can_edit())
  with check (
    ((user_id = auth.uid() and public.is_member()) and not public.bidding_closed())
    or public.can_edit()
  );

-- The roster is not published until bidding has closed: publishing earlier
-- would roster people off bids that are still coming in.
create or replace function public.guard_roster_publish()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.roster_state = 'published'
     and coalesce(old.roster_state, 'draft') <> 'published'
     and new.bidding_enabled
     and new.bids_close_at is not null
     and now() < new.bids_close_at
  then
    raise exception 'Bidding is open until %. The roster can be published once it closes.',
      to_char(new.bids_close_at at time zone 'UTC', 'DD Mon HH24:MI"Z"');
  end if;
  return new;
end;
$$;

drop trigger if exists on_settings_publish on public.settings;
create trigger on_settings_publish
  before update on public.settings
  for each row execute function public.guard_roster_publish();

grant execute on function public.bidding_closed() to authenticated;
