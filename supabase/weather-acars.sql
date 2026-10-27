-- The flight deck's weather, off Hoppie.
--
-- Run after supabase/acars.sql in the Supabase SQL Editor. Safe to run again.
--
-- ---- What changed ----
--
-- Asking for a METAR, a TAF or the ATIS used to go to Hoppie: the EFB queued
-- an "acars-info" command, the bridge asked Hoppie's inforeq service, and
-- Hoppie answered out of its own copy of the weather. The bridge now fetches
-- it from the same sources the rest of this app uses instead - VATSIM for the
-- METAR and the ATIS, aviationweather.gov for the TAF, which is the very
-- source supabase/weather.sql reads - and prints it on the flight deck
-- printer.
--
-- Three reasons, in the order they bit:
--
--   * Hoppie's weather is its own cache, not the source. A METAR printed on
--     the pedestal could differ from the one on the airport page in the same
--     hand, which is the kind of disagreement nobody can settle mid-sector.
--   * It needed a Hoppie logon code to work at all. No code, or Hoppie down
--     for the evening, meant no weather - and weather is wanted at the
--     briefing, before the datalink is anybody's concern.
--   * It was courtesy traffic on somebody else's server for something we can
--     read ourselves.
--
-- ---- What this file does ----
--
-- Only one thing: loosens what "acars-info" is allowed to ask for, and stops
-- the refusal blaming Hoppie for a command Hoppie is no longer part of.
--
-- The command keeps its name on purpose. It is already in
-- acars_known_command(), every tablet already sends it, and the bridge now
-- routes it to its own weather station - so a tablet that has not been
-- reloaded since the change keeps working, and gets better weather than it
-- did. Nothing in the queue, the message window or the printing path needed
-- to change: the bridge reports a fetched METAR as the same acars-message any
-- uplink is, tagged source "wx".
--
-- ---- One thing this deliberately does NOT fix ----
--
-- acars_ingest_event() does not write acars_messages.source for an
-- acars-message event, so every row the bridge reports takes the column's
-- default of 'hoppie' - a fetched METAR included, and PMDG's GFO traffic
-- before it. The bridge does send the right value ("wx", or "gfo"); the
-- ingest drops it.
--
-- Nothing misbehaves because of it: the message window reads the kind, not
-- the source, so a METAR still shows as a METAR. But it is exactly the lie
-- the column was added to prevent, and it wants fixing in the arm of
-- acars_ingest_event() that inserts an acars-message rather than here -
-- that function is long, and replacing it whole from this file would risk
-- overwriting drift in the live database with a copy taken from acars.sql.
--
-- ---- Order of deployment ----
--
-- Run this BEFORE deploying the app, because the app now asks for 'atis'
-- rather than Hoppie's 'vatatis' and this is what permits it. The older names
-- are still accepted, so running this early breaks nothing.

-- What each ACARS command needs before it is worth sending. Replaced whole
-- rather than patched: it is one function, and a diff of a CASE arm is harder
-- to read than the arm itself.
create or replace function public.acars_check_command(kind text, given jsonb)
returns void language plpgsql immutable as $$
begin
  if kind = 'acars-telex' then
    if coalesce(btrim(given->>'to'), '') = '' then
      raise exception 'There is nobody to send that to';
    end if;
    if coalesce(btrim(given->>'message'), '') = '' then
      raise exception 'There is no message to send';
    end if;

  elsif kind = 'acars-pdc' then
    if coalesce(btrim(given->>'to'), '') = '' then
      raise exception 'There is no station to ask for a clearance';
    end if;

  elsif kind = 'acars-info' then
    -- 'atis' is what the app asks for now. Hoppie's three names for the same
    -- thing - one per network, back when the answer came from Hoppie - are
    -- still taken, because a tablet left open since before the change still
    -- sends one of them and the bridge maps them all to the one ATIS there
    -- now is. See Weather.Known() in the vpilot-plugin repository.
    if coalesce(btrim(lower(given->>'request')), '') not in
       ('metar', 'taf', 'shorttaf', 'atis', 'vatatis', 'peatis', 'ivaoatis') then
      raise exception 'The bridge cannot fetch "%"', coalesce(given->>'request', '');
    end if;
    if coalesce(btrim(given->>'icao'), '') = '' then
      raise exception 'There is no station to ask about';
    end if;

  elsif kind = 'acars-logon' then
    if coalesce(btrim(given->>'to'), '') = '' then
      raise exception 'There is no ATC unit to log on to';
    end if;

  elsif kind = 'acars-reply' then
    if coalesce(btrim(upper(given->>'answer')), '') not in
       ('WILCO', 'UNABLE', 'STANDBY', 'ROGER', 'AFFIRM', 'NEGATIVE') then
      raise exception '"%" is not a CPDLC answer', coalesce(given->>'answer', '');
    end if;
    if given->>'mrn' is null then
      raise exception 'There is no message to answer';
    end if;

  elsif kind = 'acars-request' then
    if coalesce(btrim(given->>'message'), '') = '' then
      raise exception 'There is no request to send';
    end if;

  elsif kind = 'acars-print' then
    if coalesce(btrim(given->>'reference'), '') = ''
       and coalesce(btrim(given->>'text'), '') = '' then
      raise exception 'There is nothing to print';
    end if;
  end if;
end;
$$;
