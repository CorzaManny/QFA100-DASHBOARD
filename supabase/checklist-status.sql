-- Checklist completion, shared between the two flight-deck tablets. Only the
-- fact that a checklist is complete is shared, not the tick-by-tick progress
-- (which stays per-device, in local storage) so one tablet's in-progress
-- ticks never overwrite the other's.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.

create table if not exists public.checklist_status (
  checklist_id text primary key,
  complete     boolean not null default false,
  completed_by text not null default '',
  completed_at timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.checklist_status enable row level security;
revoke all on public.checklist_status from anon;
grant select, insert, update on public.checklist_status to authenticated;

-- Everyone reads it; the same roles that stamp sector actuals (the flight
-- deck tablets, dispatchers and admins) write it.
drop policy if exists "members read checklist status" on public.checklist_status;
create policy "members read checklist status" on public.checklist_status
  for select to authenticated using (public.is_member());

drop policy if exists "flight deck writes checklist status" on public.checklist_status;
create policy "flight deck writes checklist status" on public.checklist_status
  for all to authenticated using (public.can_log()) with check (public.can_log());
