-- vPilot on the flight deck: what vPilot is saying and doing on the pilot's
-- PC, and the radio driven back from the EFB.
-- Run after schema.sql and operations-role.sql in the Supabase SQL Editor.
-- Safe to run again.
--
-- A plugin inside vPilot (vpilot-plugin/, a separate repository) talks to one
-- endpoint, supabase/functions/vpilot-plugin, with a key it makes on its first
-- run:
--
--   POST .../vpilot-plugin           { events: [...] }  -> { instance }
--   GET  .../vpilot-plugin?after=N                      -> { instance, commands }
--
-- The GET is held open up to 25 s, so vPilot picks a command up about a second
-- after the EFB asks for it without the EFB holding a socket of its own.
--
-- Six things live here:
--   vpilot_plugin_secret  the hash of the first plugin key that connects
--   vpilot_link           one row: vPilot and VATSIM as they are now
--   sim_status            one row: the bridge's simulator status document
--   vpilot_messages       vPilot's message window, mirrored
--   vpilot_controllers    who is on frequency nearby
--   vpilot_commands       the queue the other way, and what vPilot made of it
--
-- The event handling is all in here rather than in the Edge Function, so a
-- batch of events either lands whole or not at all and the flight deck never
-- sees half of what vPilot said.
--
-- Push-to-talk is deliberately absent, here and in the plugin: a "PTT on"
-- whose "off" was lost on a flaky connection would leave a microphone keyed
-- on a live frequency.
--
-- Every delete in here says "where true" even when it means every row.
-- PostgREST's role loads the safeupdate extension, which refuses an UPDATE or
-- DELETE with no WHERE clause, so a bare "delete from ..." raises as soon as
-- the Edge Function calls this - taking the whole batch with it and wedging
-- the plugin, which retries that same batch for ever. Keep the condition.

-- Who may watch the radio and drive it. The same people who may report a
-- defect - the flight deck tablets, the pilots and ops - and deliberately its
-- own function rather than can_report(), so changing who keeps the tech log
-- never quietly changes who can transmit on VATSIM. Observers are left out:
-- the jumpseat does not work the radio.
create or replace function public.can_use_vpilot()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'dispatcher', 'operations', 'pilot', 'efb')
  );
$$;

-- ---------- Reading what vPilot reports ----------

-- vPilot gives a frequency as its own 25 kHz code, in kHz, or in Hz,
-- depending which part of vPilot the number came from. All of them come out
-- as '120.500'.
create or replace function public.vpilot_frequency(raw bigint)
returns text language sql immutable as $$
  select case
    when raw is null then null
    when raw > 1000000 then trim(to_char(raw / 1000000.0, 'FM999990.000'))
    when raw > 100000  then trim(to_char(raw / 1000.0, 'FM999990.000'))
    else trim(to_char((raw + 100000) / 1000.0, 'FM999990.000'))
  end;
$$;

-- A JSON value that may be a bool, "True" from .NET, or a number.
create or replace function public.vpilot_flag(value jsonb)
returns boolean language sql immutable as $$
  select case
    when value is null or jsonb_typeof(value) = 'null' then null
    when jsonb_typeof(value) = 'boolean' then (value #>> '{}')::boolean
    when jsonb_typeof(value) = 'number' then (value #>> '{}')::numeric <> 0
    when lower(value #>> '{}') in ('true', '1', 'on', 'yes') then true
    when lower(value #>> '{}') in ('false', '0', 'off', 'no') then false
    else null
  end;
$$;

create or replace function public.vpilot_number(value jsonb)
returns bigint language sql immutable as $$
  select case
    when value is null or jsonb_typeof(value) = 'null' then null
    when (value #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then trunc((value #>> '{}')::numeric)::bigint
    else null
  end;
$$;

create or replace function public.vpilot_float(value jsonb)
returns double precision language sql immutable as $$
  select case
    when value is null or jsonb_typeof(value) = 'null' then null
    when (value #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then (value #>> '{}')::double precision
    else null
  end;
$$;

create or replace function public.vpilot_frequencies(value jsonb)
returns text[] language sql immutable as $$
  select case
    when value is null or jsonb_typeof(value) <> 'array' then null
    else (
      select array_agg(public.vpilot_frequency(trunc(f.freq::numeric)::bigint) order by f.ord)
      from jsonb_array_elements_text(value) with ordinality as f(freq, ord)
      where f.freq ~ '^-?[0-9]+(\.[0-9]+)?$'
    )
  end;
$$;

-- ---------- The plugin's key ----------
-- The first plugin to connect claims the EFB; every other key is refused
-- until an admin forgets it. RLS on with no policies at all, so only the Edge
-- Function's service role ever reads this: the key is a bearer credential for
-- the team's live radio.

create table if not exists public.vpilot_plugin_secret (
  id         smallint primary key default 1,
  key_sha256 text,
  claimed_at timestamptz,
  constraint vpilot_plugin_secret_single check (id = 1)
);

insert into public.vpilot_plugin_secret (id) values (1) on conflict (id) do nothing;

alter table public.vpilot_plugin_secret enable row level security;
revoke all on public.vpilot_plugin_secret from anon, authenticated;

-- ---------- vPilot as it is now ----------
-- One row, like settings and ops_desk. `instance` is how the plugin is told
-- the EFB has forgotten: it resends everything it knows and restarts its
-- command numbering when this changes (see vpilot_resync).

create table if not exists public.vpilot_link (
  id              smallint primary key default 1,
  instance        uuid not null default gen_random_uuid(),
  -- The plugin, not VATSIM.
  online          boolean not null default false,
  last_seen_at    timestamptz,
  plugin_version  text,
  features        text[] not null default '{}',
  -- VATSIM.
  connected       boolean not null default false,
  callsign        text,
  cid             text,
  type_code       text,
  selcal          text,
  observer_mode   boolean,
  -- vPilot's radio stack, exactly as vPilot reported it; the app formats it.
  radios          jsonb not null default '{}',
  squawk          text,
  mode_c          boolean,
  ident           boolean,
  -- The TX/RX lights: {"com1":{"tx":false,"rx":true},"com2":{...}}.
  com_activity    jsonb not null default '{}',
  voice_connected boolean,
  chat_tabs       text[] not null default '{}',
  updated_at      timestamptz not null default now(),
  constraint vpilot_link_single check (id = 1)
);

insert into public.vpilot_link (id) values (1) on conflict (id) do nothing;

alter table public.vpilot_link enable row level security;
revoke all on public.vpilot_link from anon;
grant select on public.vpilot_link to authenticated;

drop policy if exists "the flight deck reads vPilot" on public.vpilot_link;
create policy "the flight deck reads vPilot" on public.vpilot_link
  for select to authenticated using (public.can_use_vpilot());

-- ---------- The simulator, shared with every device ----------

create table if not exists public.sim_status (
  id         smallint primary key default 1 check (id = 1),
  status     jsonb,
  updated_at timestamptz not null default now()
);

insert into public.sim_status (id) values (1) on conflict (id) do nothing;

alter table public.sim_status enable row level security;
revoke all on public.sim_status from anon, authenticated;
grant select on public.sim_status to authenticated;

drop policy if exists "the flight deck reads the simulator" on public.sim_status;
create policy "the flight deck reads the simulator" on public.sim_status
  for select to authenticated using (public.can_use_vpilot());

-- ---------- vPilot's message window ----------

create table if not exists public.vpilot_messages (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  kind          text not null,
  from_callsign text,
  to_callsign   text,
  body          text not null default '',
  frequencies   text[],
  -- Notices only: info, warning or error, as vPilot classed it.
  level         text,
  constraint vpilot_messages_kind check (kind in (
    'radio', 'private', 'broadcast', 'metar', 'atis', 'selcal',
    'notice', 'server', 'radio-sent', 'private-sent'))
);

create index if not exists vpilot_messages_at_idx on public.vpilot_messages (at desc);

alter table public.vpilot_messages enable row level security;
revoke all on public.vpilot_messages from anon;
grant select on public.vpilot_messages to authenticated;

drop policy if exists "the flight deck reads the radio" on public.vpilot_messages;
create policy "the flight deck reads the radio" on public.vpilot_messages
  for select to authenticated using (public.can_use_vpilot());

-- ---------- Who is on frequency ----------

create table if not exists public.vpilot_controllers (
  callsign      text primary key,
  frequency     text,
  frequency_raw bigint,
  latitude      double precision,
  longitude     double precision,
  real_name     text,
  updated_at    timestamptz not null default now()
);

alter table public.vpilot_controllers enable row level security;
revoke all on public.vpilot_controllers from anon;
grant select on public.vpilot_controllers to authenticated;

drop policy if exists "the flight deck reads controllers" on public.vpilot_controllers;
create policy "the flight deck reads controllers" on public.vpilot_controllers
  for select to authenticated using (public.can_use_vpilot());

-- ---------- The queue the other way ----------
-- Nothing is inserted here directly: vpilot_command checks the type against
-- the eleven the plugin understands first, so a command vPilot cannot carry
-- out never reaches it.

create table if not exists public.vpilot_commands (
  seq          bigint generated always as identity primary key,
  type         text not null,
  args         jsonb not null default '{}',
  requested_by uuid references public.profiles (id) on delete set null,
  requested_at timestamptz not null default now(),
  -- When vPilot picked it up, and what vPilot made of it.
  delivered_at timestamptz,
  result_at    timestamptz,
  ok           boolean,
  error        text
);

create index if not exists vpilot_commands_pending_idx
  on public.vpilot_commands (seq) where delivered_at is null;

alter table public.vpilot_commands enable row level security;
revoke all on public.vpilot_commands from anon;
grant select on public.vpilot_commands to authenticated;

drop policy if exists "the flight deck reads its commands" on public.vpilot_commands;
create policy "the flight deck reads its commands" on public.vpilot_commands
  for select to authenticated using (public.can_use_vpilot());

-- ---------- The endpoint's own three calls ----------
-- Only the Edge Function may call these: execute is revoked from anon and
-- authenticated at the bottom of this file.

-- The instance id, or null to refuse this key.
create or replace function public.vpilot_authenticate(key_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  known text;
begin
  if key_hash is null or key_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  -- Locked, so two plugins starting together cannot both claim the EFB.
  select key_sha256 into known from public.vpilot_plugin_secret where id = 1 for update;

  if known is null then
    update public.vpilot_plugin_secret set key_sha256 = key_hash, claimed_at = now() where id = 1;
  elsif known <> key_hash then
    return null;
  end if;

  return (select instance from public.vpilot_link where id = 1);
end;
$$;

-- Everything vPilot has reported since the last call, in order.
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

-- One poll of the queue: hands out what vPilot has not seen, marks it sent,
-- and fails anything the plugin was not there to collect.
create or replace function public.vpilot_take_commands(after bigint, limit_to integer default 50)
returns table (id bigint, type text, args jsonb)
language plpgsql security definer set search_path = public as $$
begin
  -- Aliased, because this function's own output column is called id and
  -- plpgsql would read an unqualified one as that variable.
  update public.vpilot_link l set online = true, last_seen_at = now() where l.id = 1;

  return query
  with stale as (
    update public.vpilot_commands c
       set delivered_at = now(), result_at = now(), ok = false,
           error = 'vPilot did not pick this up in time'
     where c.delivered_at is null
       and c.requested_at <= now() - interval '60 seconds'
    returning c.seq
  ), fresh as (
    select c.seq
      from public.vpilot_commands c
     where c.delivered_at is null
       and c.seq > coalesce(after, 0)
       and c.requested_at > now() - interval '60 seconds'
     order by c.seq
     limit greatest(coalesce(limit_to, 50), 1)
     for update skip locked
  )
  update public.vpilot_commands c
     set delivered_at = now()
    from fresh f
   where c.seq = f.seq
  returning c.seq, c.type, c.args;
end;
$$;

-- ---------- What the app calls ----------

-- Drives vPilot. Returns the command's id; vPilot's own answer lands on that
-- row (ok, error) a moment later.
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

-- Makes the plugin resend everything it knows: a new instance id is how it is
-- told the EFB has forgotten.
create or replace function public.vpilot_resync()
returns uuid language plpgsql security definer set search_path = public as $$
declare
  fresh uuid;
begin
  if not public.can_use_vpilot() then
    raise exception 'Only the flight deck and ops can use vPilot';
  end if;
  update public.vpilot_link set instance = gen_random_uuid(), updated_at = now()
   where id = 1
  returning instance into fresh;
  return fresh;
end;
$$;

-- Lets a different vPilot install claim the EFB, and clears what the last one
-- said. An admin job: the key being forgotten is what stops anybody else's
-- plugin taking the team's radio.
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

-- ---------- Who may call what ----------

revoke all on function public.vpilot_authenticate(text) from public, anon, authenticated;
revoke all on function public.vpilot_ingest(jsonb) from public, anon, authenticated;
revoke all on function public.vpilot_take_commands(bigint, integer) from public, anon, authenticated;
grant execute on function public.vpilot_authenticate(text) to service_role;
grant execute on function public.vpilot_ingest(jsonb) to service_role;
grant execute on function public.vpilot_take_commands(bigint, integer) to service_role;

revoke all on function public.vpilot_command(text, jsonb) from anon;
revoke all on function public.vpilot_resync() from anon;
revoke all on function public.vpilot_forget_plugin() from anon;
grant execute on function public.vpilot_command(text, jsonb) to authenticated;
grant execute on function public.vpilot_resync() to authenticated;
grant execute on function public.vpilot_forget_plugin() to authenticated;
