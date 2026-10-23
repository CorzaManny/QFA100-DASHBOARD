-- Run after vpilot.sql as the database owner. All changes are rolled back.
--
-- What this cannot catch: PostgREST's role loads the safeupdate extension,
-- so an UPDATE or DELETE with no WHERE clause raises when the API calls
-- these functions but not when the owner runs them here. Every delete in
-- vpilot.sql names a condition for that reason - if you take one out, this
-- test still passes and the flight deck goes quiet instead.
begin;

do $$
begin
  perform public.vpilot_ingest('[
    {"type":"controller-added","callsign":"SY_TWR","frequency":120500},
    {"type":"controller-added","callsign":"SY_GND","frequency":121700},
    {"type":"controller-deleted","callsign":"SY_TWR"}
  ]'::jsonb);
  if exists (select 1 from public.vpilot_controllers where callsign = 'SY_TWR') then
    raise exception 'Controller deletion did not remove SY_TWR';
  end if;

  perform public.vpilot_ingest('[
    {"type":"controller-added","callsign":"SY_TWR","frequency":120500},
    {"type":"vpilot-here"},
    {"type":"controller-added","callsign":"SY_GND","frequency":121700}
  ]'::jsonb);
  if (select count(*) from public.vpilot_controllers) <> 1
     or not exists (select 1 from public.vpilot_controllers where callsign = 'SY_GND') then
    raise exception 'Bridge snapshot retained stale controllers or lost the current list';
  end if;

  perform public.vpilot_ingest('[{"type":"hello"}]'::jsonb);
  if exists (select 1 from public.vpilot_controllers) then
    raise exception 'Hello retained stale controllers';
  end if;

  -- A resync while vPilot is logged out: the hello's own flag is the only
  -- thing that says so, and the EFB must stop showing the last flight.
  perform public.vpilot_ingest('[
    {"type":"connected","callsign":"QFA100","cid":"1234567"},
    {"type":"vpilot-here","connected":false}
  ]'::jsonb);
  if exists (select 1 from public.vpilot_link where connected or callsign is not null or cid is not null) then
    raise exception 'A resync with vPilot logged out kept the last flight';
  end if;

  -- A resync that says nothing about VATSIM (the bridge's own) leaves it be.
  perform public.vpilot_ingest('[
    {"type":"connected","callsign":"QFA100"},
    {"type":"vpilot-here"}
  ]'::jsonb);
  if exists (select 1 from public.vpilot_link where not connected or callsign is null) then
    raise exception 'A resync with no VATSIM flag dropped the connection';
  end if;

  perform public.vpilot_ingest('[
    {"type":"connected","callsign":"QFA100"},
    {"type":"controller-added","callsign":"SY_TWR","frequency":120500},
    {"type":"vpilot-gone"}
  ]'::jsonb);
  if exists (select 1 from public.vpilot_controllers)
     or exists (select 1 from public.vpilot_link where connected or callsign is not null or not online) then
    raise exception 'vpilot-gone did not clear vPilot while preserving the bridge link';
  end if;

  perform public.vpilot_ingest('[{"type":"session-ended"}]'::jsonb);
  if exists (select 1 from public.vpilot_link where online) then
    raise exception 'Direct plugin session-ended left the link online';
  end if;
end;
$$;

rollback;
