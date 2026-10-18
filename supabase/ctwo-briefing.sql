-- CTWO+ Briefing: adds one column to the existing briefings table for each
-- sector's progress through the Departure and Arrival CTWO+ briefings (which
-- points are ticked, and which sections are marked complete). The points
-- themselves are edited by an admin and kept in settings.rules.ctwo, which
-- needs no migration since that column already exists.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.

alter table public.briefings add column if not exists ctwo jsonb not null default '{}'::jsonb;
