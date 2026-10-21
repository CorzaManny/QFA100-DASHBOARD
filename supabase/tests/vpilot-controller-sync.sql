-- Run after vpilot.sql as the database owner. All changes are rolled back.
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
