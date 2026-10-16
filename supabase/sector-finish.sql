-- Finishing a sector: fuel remaining/used at the gate, and the moment the
-- flight deck closed the sector out. Off/on blocks already live on
-- sector_actuals; this just adds what "Finish sector" captures.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.

alter table public.sector_actuals add column if not exists fuel_remaining numeric;
alter table public.sector_actuals add column if not exists fuel_used numeric;
alter table public.sector_actuals add column if not exists completed_at timestamptz;
