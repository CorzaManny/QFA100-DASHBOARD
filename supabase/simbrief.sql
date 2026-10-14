-- Who may change the aeroplane and the team's SimBrief account.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- The callsign, the aircraft type, the custom airframe and the SimBrief
-- account are the team's identity rather than everyday roster work, so they
-- are an admin's or operations' to set. Everything else on the settings row
-- stays open to dispatchers.

create or replace function public.can_set_simbrief()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'operations')
  );
$$;

create or replace function public.guard_simbrief()
returns trigger language plpgsql set search_path = public as $$
begin
  if (
    new.simbrief is distinct from old.simbrief
    or (new.rules -> 'callsign') is distinct from (old.rules -> 'callsign')
    or (new.rules -> 'aircraft') is distinct from (old.rules -> 'aircraft')
    or (new.rules -> 'airframe') is distinct from (old.rules -> 'airframe')
  ) and not public.can_set_simbrief() then
    raise exception 'Only admins and operations can change the aeroplane and the SimBrief account';
  end if;
  return new;
end;
$$;

drop trigger if exists on_settings_simbrief on public.settings;
create trigger on_settings_simbrief
  before update on public.settings
  for each row execute function public.guard_simbrief();

grant execute on function public.can_set_simbrief() to authenticated;
