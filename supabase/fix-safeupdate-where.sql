-- Fix: every UPDATE and DELETE the API runs needs a WHERE clause.
--
-- PostgREST's login role is started with the safeupdate extension
-- (session_preload_libraries = supautils, safeupdate), so an UPDATE or DELETE
-- with no WHERE clause raises as soon as it is reached - even inside a
-- security definer function, and even when the table is empty. Run the same
-- statement in the SQL editor and it works, which is why this hid for a day.
--
-- What it broke: vpilot_ingest cleared the controller list with a bare
-- "delete from public.vpilot_controllers", on hello, vpilot-here,
-- disconnected and session-ended. The function raised, PostgREST answered
-- 500, the Edge Function turned that into 503, and the whole batch rolled
-- back. The bridge keeps the rejected batch and retries it for ever, so from
-- the first VATSIM disconnect onwards nothing vPilot said ever reached the
-- EFB again: no new controllers, none removed, and the connection state stuck
-- on whatever it was.
--
-- Also here, while the plugin is resyncing: a hello that says vPilot is not on
-- VATSIM now clears the callsign and CID, so a resync after logging out stops
-- showing the last flight.
--
-- And set_normal_checklists, which replaced the list the same bare way, so
-- saving the normal checklists from Admin failed too.
--
-- Safe to run again. Paste it into the Supabase SQL editor.
-- The rest of supabase/vpilot.sql and supabase/normal-checklists.sql carry the
-- same change, so running those files instead does the same job.

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

    end if;
    -- Anything else is from a newer plugin than this EFB: ignored on purpose.
  end loop;

  -- The window keeps the last thousand lines.
  delete from public.vpilot_messages
   where id <= coalesce((select max(id) from public.vpilot_messages), 0) - 1000;

  return (select instance from public.vpilot_link where id = 1);
end;
$$;

create or replace function public.vpilot_forget_plugin()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can forget the vPilot plugin';
  end if;

  update public.vpilot_plugin_secret set key_sha256 = null, claimed_at = null where id = 1;

  update public.vpilot_link
     set instance = gen_random_uuid(), online = false, last_seen_at = null,
         plugin_version = null, features = '{}', connected = false,
         callsign = null, cid = null, type_code = null, selcal = null,
         observer_mode = null, radios = '{}', squawk = null, mode_c = null,
         ident = null, com_activity = '{}', voice_connected = null,
         chat_tabs = '{}', updated_at = now()
   where id = 1;

  delete from public.vpilot_controllers where true;
  delete from public.vpilot_messages where true;
  delete from public.vpilot_commands where true;
  update public.sim_status set status = null, updated_at = now() where id = 1;
end;
$$;

create or replace function public.set_normal_checklists(payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change the normal checklists';
  end if;
  if jsonb_typeof(payload) <> 'array' then
    raise exception 'Expected a list of checklists';
  end if;
  if jsonb_array_length(payload) = 0 then
    raise exception 'Keep at least one normal checklist';
  end if;

  -- Replace rather than merge: the app always sends the whole list, so a
  -- checklist missing from it is one the admin deleted. Position comes from
  -- the order they arrive in, which is the order the flight deck flies them.
  -- "where true" rather than a bare delete: PostgREST's role loads
  -- safeupdate, which refuses an UPDATE or DELETE with no WHERE clause.
  delete from public.normal_checklists where true;
  insert into public.normal_checklists (id, name, position, items, updated_at)
  select
    coalesce(trim(entry ->> 'id'), ''),
    coalesce(trim(entry ->> 'name'), ''),
    ord,
    coalesce(entry -> 'items', '[]'::jsonb),
    now()
  from jsonb_array_elements(payload) with ordinality as listed(entry, ord);

  -- Checked after the insert rather than before: it is all one transaction,
  -- so raising here rolls the replacement back and the team keeps the list
  -- it had.
  if exists (select 1 from public.normal_checklists where id = '' or name = '') then
    raise exception 'Every checklist needs an id and a name';
  end if;
  if exists (select 1 from public.normal_checklists where jsonb_typeof(items) <> 'array') then
    raise exception 'A checklist''s items must be a list';
  end if;
end;
$$;
