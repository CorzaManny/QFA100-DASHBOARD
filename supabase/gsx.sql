-- Apply after vpilot.sql. This migration also upgrades its ingest and command functions.
begin;
create table if not exists public.gsx_status (
  id integer primary key check (id = 1),
  connected boolean not null default false,
  trouble text,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.gsx_status (id) values (1) on conflict (id) do nothing;
alter table public.gsx_status enable row level security;
revoke all on public.gsx_status from public, anon, authenticated;
grant select on public.gsx_status to authenticated;
drop policy if exists "the flight deck reads GSX" on public.gsx_status;
create policy "the flight deck reads GSX" on public.gsx_status for select to authenticated using (public.can_use_vpilot());

create or replace function public.gsx_ingest_event(e jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  observed timestamptz;
begin
  if e->>'type' <> 'gsx-state' then return; end if;
  if jsonb_typeof(e->'state') is distinct from 'object' then return; end if;
  begin
    observed := (e->>'observedAt')::timestamptz;
  exception when others then return;
  end;
  if observed is null then return; end if;
  insert into public.gsx_status (id, connected, trouble, state, updated_at)
  values (1, coalesce(public.vpilot_flag(e->'connected'), false), left(e->>'trouble', 1000), e->'state', least(observed, now()))
  on conflict (id) do update set connected = excluded.connected, trouble = excluded.trouble, state = excluded.state, updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.gsx_ingest_event(jsonb) from public, anon, authenticated;
grant execute on function public.gsx_ingest_event(jsonb) to service_role;

create or replace function public.gsx_check_command(kind text, given jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if kind not in ('gsx-menu-open', 'gsx-menu-close', 'gsx-menu-pick', 'gsx-simbrief') then
    raise exception 'Unknown GSX command';
  end if;
  if not exists (select 1 from public.gsx_status where id = 1 and connected and updated_at > now() - interval '15 seconds') then
    raise exception 'GSX is disconnected or its status is stale';
  end if;
  if kind = 'gsx-menu-pick' then
    if jsonb_typeof(given->'index') is distinct from 'number' or coalesce(given->>'index', '') !~ '^[0-9]{1,4}$'
       or length(coalesce(given->>'menuToken', '')) <> 44 then
      raise exception 'Invalid GSX menu choice';
    end if;
  end if;
end;
$$;
revoke all on function public.gsx_check_command(text,jsonb) from public, anon, authenticated;

create or replace function public.vpilot_ingest(events jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  e jsonb;
  kind text;
  radio text;
  light text;
  who text;
begin
  update public.vpilot_link set online = true, last_seen_at = now(), updated_at = now() where id = 1;

  for e in select value from jsonb_array_elements(coalesce(events, '[]'::jsonb))
  loop
    kind := e->>'type';

    if kind = 'hello' then
      -- A hello starts a fresh snapshot. Controllers absent from that
      -- snapshot must disappear, including deletions missed during an outage.
      delete from public.vpilot_controllers where true;
      update public.vpilot_link
         set plugin_version = e->>'pluginVersion',
             features = coalesce((
               select array_agg(f.value order by f.ord)
               from jsonb_array_elements_text(coalesce(e->'features', '[]'::jsonb))
                 with ordinality as f(value, ord)), '{}'),
             updated_at = now()
       where id = 1;
      -- A plugin that has only just started never wanted what was queued
      -- before it was there.
      update public.vpilot_commands
         set delivered_at = now(), result_at = now(), ok = false,
             error = 'vPilot restarted before this was sent'
       where delivered_at is null;
      -- As for vpilot-here below: the hello is what says vPilot is logged out.
      if public.vpilot_flag(e->'connected') is false then
        update public.vpilot_link
           set connected = false, callsign = null, cid = null, type_code = null,
               selcal = null, observer_mode = null, updated_at = now()
         where id = 1;
      end if;

    elsif kind = 'vpilot-here' then
      -- The bridge translates the plugin's hello to vpilot-here. The
      -- controller-added events that follow rebuild its current list.
      delete from public.vpilot_controllers where true;
      -- The plugin says in its hello whether vPilot is on VATSIM, and sends
      -- the 'connected' event itself in the same batch when it is. An
      -- explicit false is the only thing that says "logged out" after a
      -- resync, so without this the EFB would keep showing the callsign of a
      -- flight that ended hours ago. The bridge's own vpilot-here carries no
      -- flag and leaves this alone.
      if public.vpilot_flag(e->'connected') is false then
        update public.vpilot_link
           set connected = false, callsign = null, cid = null, type_code = null,
               selcal = null, observer_mode = null, updated_at = now()
         where id = 1;
      end if;

    elsif kind = 'sim' then
      insert into public.sim_status (id, status, updated_at)
      values (1, e->'status', now())
      on conflict (id) do update
        set status = excluded.status, updated_at = now();

    elsif kind = 'sim-gone' then
      update public.sim_status set status = null, updated_at = now() where id = 1;

    elsif kind = 'connected' then
      update public.vpilot_link
         set connected = true,
             cid = e->>'cid',
             callsign = e->>'callsign',
             type_code = e->>'typeCode',
             selcal = e->>'selcalCode',
             observer_mode = public.vpilot_flag(e->'observerMode'),
             updated_at = now()
       where id = 1;

    elsif kind = 'disconnected' then
      update public.vpilot_link
         set connected = false, callsign = null, cid = null, type_code = null,
             selcal = null, observer_mode = null, updated_at = now()
       where id = 1;
      delete from public.vpilot_controllers where true;

    elsif kind in ('session-ended', 'vpilot-gone') then
      -- vPilot has closed. Its message window has gone, so the EFB's mirror
      -- of it goes too rather than sitting there looking live. With a bridge,
      -- the upstream link and simulator may still be running.
      update public.vpilot_link
         set online = (kind = 'vpilot-gone'), connected = false, callsign = null, cid = null,
             type_code = null, selcal = null, observer_mode = null,
             radios = '{}', squawk = null, mode_c = null, ident = null,
             com_activity = '{}', voice_connected = null, chat_tabs = '{}',
             updated_at = now()
       where id = 1;
      delete from public.vpilot_controllers where true;
      delete from public.vpilot_messages where true;

    elsif kind in ('radio', 'radio-sent') then
      insert into public.vpilot_messages (kind, from_callsign, body, frequencies)
      values (kind, e->>'from', coalesce(e->>'message', ''), public.vpilot_frequencies(e->'frequencies'));

    elsif kind in ('private', 'broadcast', 'server') then
      insert into public.vpilot_messages (kind, from_callsign, body)
      values (kind, e->>'from', coalesce(e->>'message', ''));

    elsif kind = 'private-sent' then
      insert into public.vpilot_messages (kind, from_callsign, to_callsign, body)
      values (kind, e->>'from', e->>'to', coalesce(e->>'message', ''));

    elsif kind = 'notice' then
      insert into public.vpilot_messages (kind, body, level)
      values ('notice', coalesce(e->>'message', ''), coalesce(nullif(e->>'level', ''), 'info'));

    elsif kind = 'metar' then
      insert into public.vpilot_messages (kind, body)
      values ('metar', coalesce(e->>'metar', ''));

    elsif kind = 'atis' then
      insert into public.vpilot_messages (kind, from_callsign, body)
      values ('atis', e->>'from', coalesce((
        select string_agg(l.value, E'\n' order by l.ord)
        from jsonb_array_elements_text(coalesce(e->'lines', '[]'::jsonb))
          with ordinality as l(value, ord)), ''));

    elsif kind = 'selcal' then
      insert into public.vpilot_messages (kind, from_callsign, body, frequencies)
      values ('selcal', e->>'from', '', public.vpilot_frequencies(e->'frequencies'));

    elsif kind = 'controller-added' then
      insert into public.vpilot_controllers
        (callsign, frequency, frequency_raw, latitude, longitude, updated_at)
      values (
        upper(coalesce(e->>'callsign', '')),
        public.vpilot_frequency(public.vpilot_number(e->'frequency')),
        public.vpilot_number(e->'frequency'),
        public.vpilot_float(e->'latitude'),
        public.vpilot_float(e->'longitude'),
        now())
      on conflict (callsign) do update
        set frequency = excluded.frequency,
            frequency_raw = excluded.frequency_raw,
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            updated_at = now();

    elsif kind = 'controller-frequency' then
      update public.vpilot_controllers
         set frequency = public.vpilot_frequency(public.vpilot_number(e->'frequency')),
             frequency_raw = public.vpilot_number(e->'frequency'),
             updated_at = now()
       where callsign = upper(coalesce(e->>'callsign', ''));

    elsif kind = 'controller-deleted' then
      delete from public.vpilot_controllers where callsign = upper(coalesce(e->>'callsign', ''));

    elsif kind = 'real-name' then
      -- vPilot sends one of these for anybody you talk to; only the
      -- controller list has anywhere to put a name.
      update public.vpilot_controllers
         set real_name = nullif(e->>'name', ''), updated_at = now()
       where callsign = upper(coalesce(e->>'callsign', ''));

    elsif kind = 'radios' then
      update public.vpilot_link
         set radios = e - 'type'::text,
             squawk = nullif(e->>'squawk', ''),
             mode_c = public.vpilot_flag(e->'modeC'),
             ident = public.vpilot_flag(e->'ident'),
             updated_at = now()
       where id = 1;

    elsif kind = 'com-activity' then
      radio := case when coalesce(e->>'radio', '') like '%2%' then 'com2' else 'com1' end;
      light := case when lower(coalesce(e->>'kind', '')) = 'rx' then 'rx' else 'tx' end;
      update public.vpilot_link
         set com_activity =
               (case when jsonb_typeof(com_activity) = 'object' then com_activity else '{}'::jsonb end)
               || jsonb_build_object(radio,
                    coalesce(com_activity->radio, '{}'::jsonb)
                    || jsonb_build_object(light, coalesce(to_jsonb(public.vpilot_flag(e->'on')), 'false'::jsonb))),
             updated_at = now()
       where id = 1;

    elsif kind = 'voice' then
      update public.vpilot_link
         set voice_connected = public.vpilot_flag(e->'connected'), updated_at = now()
       where id = 1;

    elsif kind = 'chat-tabs' then
      update public.vpilot_link
         set chat_tabs = coalesce((
               select array_agg(upper(t.value) order by t.ord)
               from jsonb_array_elements_text(coalesce(e->'tabs', '[]'::jsonb))
                 with ordinality as t(value, ord)), '{}'),
             updated_at = now()
       where id = 1;

    elsif kind = 'chat-opened' then
      -- Shown at once, a second before the tab scan would report it.
      who := upper(nullif(btrim(coalesce(e->>'callsign', '')), ''));
      if who is not null then
        update public.vpilot_link
           set chat_tabs = case when who = any(chat_tabs) then chat_tabs else chat_tabs || who end,
               updated_at = now()
         where id = 1;
      end if;

    elsif kind = 'command-result' then
      update public.vpilot_commands
         set ok = public.vpilot_flag(e->'ok'),
             error = nullif(e->>'error', ''),
             result_at = now()
       where seq = public.vpilot_number(e->'id');

    elsif kind = 'gsx-state' then
      if to_regprocedure('public.gsx_ingest_event(jsonb)') is not null then
        perform public.gsx_ingest_event(e);
      end if;

    elsif kind like 'acars-%' then
      -- The datalink station, which lives in supabase/acars.sql. Handled
      -- there rather than here so the ACARS events can grow without anybody
      -- editing the radio's ingest, which is the part that must not break.
      --
      -- Guarded, because acars.sql is a separate file and may not have been
      -- run: a database with no ACARS tables must ignore these events, not
      -- raise on them. A raise here would take the whole batch down and wedge
      -- the bridge, which would retry that same batch for ever - and that
      -- batch is usually carrying the radio.
      if to_regprocedure('public.acars_ingest_event(jsonb)') is not null then
        perform public.acars_ingest_event(e);
      end if;

    end if;
    -- Anything else is from a newer plugin than this EFB: ignored on purpose.
  end loop;

  -- The window keeps the last thousand lines.
  delete from public.vpilot_messages
   where id <= coalesce((select max(id) from public.vpilot_messages), 0) - 1000;

  return (select instance from public.vpilot_link where id = 1);
end;
$$;

create or replace function public.vpilot_command(kind text, args jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  given jsonb := coalesce(args, '{}'::jsonb);
  queued bigint;
  live boolean;
  seen timestamptz;
begin
  if not public.can_use_vpilot() then
    raise exception 'Only the flight deck and ops can use vPilot';
  end if;

  -- The bridge routes a command by its prefix (see bridge/Bridge.cs), so
  -- "acars-" goes to the datalink station and everything unprefixed goes to
  -- vPilot. Each set is checked by whichever file owns it.
  if kind like 'acars-%' then
    -- acars.sql may not have been run, in which case nothing can carry these
    -- out and saying so beats queueing one that is silently never collected.
    if to_regprocedure('public.acars_known_command(text)') is null then
      raise exception 'This EFB is not set up for ACARS (supabase/acars.sql has not been run)';
    end if;
    if not public.acars_known_command(kind) then
      raise exception 'The bridge does not know "%"', kind;
    end if;
    perform public.acars_check_command(kind, given);
  elsif kind like 'gsx-%' then
    if to_regprocedure('public.gsx_check_command(text,jsonb)') is null then
      raise exception 'GSX is not set up. Apply supabase/gsx.sql';
    end if;
    perform public.gsx_check_command(kind, given);
  elsif kind is null or kind not in (
    'connect', 'connect-observer', 'disconnect', 'radio', 'private',
    'metar', 'atis', 'mode-c', 'ident', 'open-chat', 'close-chat')
  then
    raise exception 'The vPilot plugin does not know "%"', coalesce(kind, '');
  end if;

  -- Said now, rather than after a minute of nobody collecting it.
  select online, last_seen_at into live, seen from public.vpilot_link where id = 1;
  if not coalesce(live, false) or coalesce(seen, 'epoch'::timestamptz) < now() - interval '90 seconds' then
    -- online here means the bridge is talking to the EFB, which is what both
    -- the radio and ACARS actually depend on. Said in whichever terms the
    -- crew is looking at.
    if kind like 'acars-%' then
      raise exception 'The simulator PC is not connected to the EFB';
    end if;
    raise exception 'vPilot is not connected to the EFB';
  end if;

  if kind in ('radio', 'private') and coalesce(btrim(given->>'message'), '') = '' then
    raise exception 'There is no message to send';
  end if;
  if kind = 'private' and coalesce(btrim(given->>'to'), '') = '' then
    raise exception 'There is nobody to send that to';
  end if;
  if kind = 'metar' and coalesce(btrim(given->>'station'), '') = '' then
    raise exception 'There is no station to ask about';
  end if;
  if kind in ('atis', 'open-chat', 'close-chat') and coalesce(btrim(given->>'callsign'), '') = '' then
    raise exception 'There is no callsign';
  end if;
  if kind in ('connect', 'connect-observer') and coalesce(btrim(given->>'callsign'), '') = '' then
    raise exception 'There is no callsign to connect with';
  end if;

  insert into public.vpilot_commands (type, args, requested_by)
  values (kind, given, auth.uid())
  returning seq into queued;

  return queued;
end;
$$;
commit;
