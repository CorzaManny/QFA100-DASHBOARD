-- Fuel & Load: the pilot's revision of the imported OFP's fuel figures - extra
-- fuel in minutes or kilograms, an adjusted taxi allowance, a reason, and a
-- draft/submitted/accepted status with a revision history. One row per
-- sector, the same shape as briefings and sector_actuals.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.

create table if not exists public.fuel_requests (
  sector_id        uuid primary key references public.sectors (id) on delete cascade,
  discretionary_kg numeric not null default 0,
  taxi_kg          numeric,              -- null = use the OFP's own taxi figure
  reason           text not null default '',
  status           text not null default 'draft' check (status in ('draft', 'submitted', 'accepted')),
  history          jsonb not null default '[]'::jsonb,
  by_name          text not null default '',
  updated_at       timestamptz not null default now()
);

alter table public.fuel_requests enable row level security;
revoke all on public.fuel_requests from anon;
grant select, insert, update on public.fuel_requests to authenticated;

-- Members read it; the same roles who write the briefing write the fuel
-- request too (public.can_report(): admin, dispatcher, pilot, efb).
drop policy if exists "members read fuel requests" on public.fuel_requests;
create policy "members read fuel requests" on public.fuel_requests
  for select to authenticated using (public.is_member());

drop policy if exists "crew add fuel requests" on public.fuel_requests;
create policy "crew add fuel requests" on public.fuel_requests
  for insert to authenticated with check (public.can_report());

drop policy if exists "crew update fuel requests" on public.fuel_requests;
create policy "crew update fuel requests" on public.fuel_requests
  for update to authenticated using (public.can_report()) with check (public.can_report());
