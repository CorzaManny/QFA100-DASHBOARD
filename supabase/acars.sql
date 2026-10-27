-- ACARS and CPDLC on the flight deck: the datalink station on the simulator
-- PC, mirrored here, and driven back from the EFB.
-- Run after schema.sql, operations-role.sql and vpilot.sql in the Supabase
-- SQL Editor. Safe to run again.
--
-- The station itself lives in the bridge (bridge/Integrations/AcarsIntegration.cs
-- in the vpilot-plugin repository), because Hoppie's endpoint sends no CORS
-- headers and a browser cannot call it at all - and because the receipt
-- printer is on that PC anyway. The bridge polls Hoppie, keeps the CPDLC
-- thread, prints what arrives, and reports all of it here through the same
-- vpilot-plugin Edge Function it already uses. The EFB reads these tables and
-- queues commands back through vpilot_command(), exactly as it drives the
-- radio.
--
-- Four things live here:
--   acars_secret    the Hoppie logon code: write-only to admins, readable
--                   only by the Edge Function's service role
--   acars_state     one row: the station as it is now
--   acars_messages  every uplink and downlink
--   the ingest and command handling for all of it
--
-- ---- Why the logon code is in a table of its own ----
--
-- It is a bearer credential for the team's datalink. Anybody holding it can
-- send messages as this flight. settings.rules would have been the obvious
-- place - that is where the VATSIM CID lives - but every signed-in account
-- can read settings, which would put the code on every tablet and in the
-- network traffic of every page load. So it goes here, with RLS on and no
-- policies at all, and the only ways to it are:
--
--   acars_set_logon()      an admin writes it, and never reads it back
--   acars_bridge_config()  the service role reads it, for the one bridge
--                          that has already proved itself with its own key
--
-- The bridge never writes it to disk. See the comment at the top of
-- bridge/BridgeConfig.cs, which deliberately has no place for it.
--
-- Every delete in here says "where true" even when it means every row.
-- PostgREST's role loads the safeupdate extension, which refuses an UPDATE or
-- DELETE with no WHERE clause, so a bare "delete from ..." raises as soon as
-- the Edge Function calls this - taking the whole batch with it and wedging
-- the bridge, which retries that same batch for ever. Keep the condition.

-- ---------- The logon code ----------

create table if not exists public.acars_secret (
  id          smallint primary key default 1,
  -- Hoppie's logon code, as issued to the team's account.
  hoppie_code text,
  -- The callsign this flight logs on to Hoppie as. Not secret, but it belongs
  -- with the code: the two are only ever used together, and a code with the
  -- wrong callsign is a station nobody can reach.
  callsign    text,
  -- The crew's switch. ACARS off means the bridge does not poll Hoppie at
  -- all, which is the right state between sectors.
  enabled     boolean not null default false,
  set_by      uuid references public.profiles (id) on delete set null,
  set_at      timestamptz,
  constraint acars_secret_single check (id = 1)
);

insert into public.acars_secret (id) values (1) on conflict (id) do nothing;

-- RLS on with no policies at all, like vpilot_plugin_secret: only the Edge
-- Function's service role ever reads this row.
alter table public.acars_secret enable row level security;
revoke all on public.acars_secret from anon, authenticated;

-- ---------- The station as it is now ----------

-- ---- Two writers, two sets of columns ----
--
-- This table has two writers and they must not share a column. Everything
-- from `enabled` down to `times` is **the bridge's**, overwritten wholesale
-- every time it reports. The `wanted_*` and `code_set` columns below are **an
-- admin's**, written only by acars_set_logon(), and the bridge never touches
-- them.
--
-- They were shared once, and it went exactly as that always does: saving the
-- logon code set `enabled` to true, and twenty seconds later the bridge's own
-- heartbeat - which had never been told anything, because the Edge Function
-- was too old to pass the code down - wrote it back to false and erased the
-- evidence. The EFB then said "ACARS is off", which was true of the bridge and
-- useless to the admin who had just switched it on.
--
-- Kept apart, the disagreement between the two is the diagnosis: what the EFB
-- was told to do, beside what the simulator PC actually has.
create table if not exists public.acars_state (
  id            smallint primary key default 1 check (id = 1),
  -- What the bridge last said about itself. The bridge owns all of these.
  enabled       boolean not null default false,
  -- A logon code is set. Never the code itself.
  configured    boolean not null default false,
  callsign      text,
  -- Switched on, with a code and a callsign: able to talk.
  live          boolean not null default false,
  -- The CPDLC unit this flight is logged on to, and one it has asked.
  atc_unit      text,
  logon_pending text,
  -- The message numbers of uplinks still waiting on an answer from the crew.
  owing         integer[] not null default '{}',
  last_polled_at timestamptz,
  -- Hoppie's own words when it refused something, verbatim.
  trouble       text,
  -- The receipt printer: which one, how wide, and whether Windows can find it.
  printer       jsonb not null default '{}',
  -- OUT, OFF, ON and IN, as the bridge reported them.
  times         jsonb not null default '{}',
  updated_at    timestamptz not null default now()
);

insert into public.acars_state (id) values (1) on conflict (id) do nothing;

-- The admin's half, and the bridge's answer to "have you been told anything
-- at all". Added separately so re-running this file upgrades an install that
-- already has the table.
--
-- `told` is the bridge saying whether the EFB has ever handed it any ACARS
-- settings, as against having handed it settings that say "off". Both leave
-- the station switched off; one is a crew decision and the other means the
-- Edge Function is too old to carry the logon code, and nothing set in
-- Settings will ever reach the simulator PC. The EFB can only tell those
-- apart because of this column.
alter table public.acars_state add column if not exists told boolean not null default false;
-- A logon code is set. Written by acars_set_logon(), never by the bridge, so
-- the flight deck can be told "a code is set but the simulator PC has not
-- been given it" - which no column the bridge owns could ever say. It is a
-- flag, never the code.
alter table public.acars_state add column if not exists code_set boolean not null default false;
-- What an admin asked for, beside what the bridge actually has.
alter table public.acars_state add column if not exists wanted_callsign text;
alter table public.acars_state add column if not exists wanted_enabled boolean not null default false;
alter table public.acars_state add column if not exists wanted_at timestamptz;

alter table public.acars_state enable row level security;
revoke all on public.acars_state from anon;
grant select on public.acars_state to authenticated;

drop policy if exists "the flight deck reads the ACARS station" on public.acars_state;
create policy "the flight deck reads the ACARS station" on public.acars_state
  for select to authenticated using (public.can_use_vpilot());

-- ---------- Every message, both ways ----------

create table if not exists public.acars_messages (
  id         bigint generated always as identity primary key,
  -- The bridge's own reference for it, printed on the receipt so a strip of
  -- paper can be matched to a line on the screen.
  reference  text not null,
  at         timestamptz not null default now(),
  direction  text not null check (direction in ('uplink', 'downlink')),
  from_station text,
  to_station   text,
  -- The Hoppie message kind, or what was asked for: cpdlc, telex, progress,
  -- position, metar, taf, vatatis and so on.
  kind       text not null default 'telex',
  body       text not null default '',
  -- CPDLC only: this message's own number, and the answers the crew may give.
  -- Called msg_no rather than min, which reads as the aggregate function
  -- everywhere it appears in a query.
  msg_no     integer,
  answers    text[] not null default '{}',
  -- One of the few messages that mean something to the bridge itself:
  -- LOGON ACCEPTED, HANDOVER and the rest. Null for everything else.
  meaning    text,
  -- Whether the receipt printer took it, and what it said if it did not.
  printed    boolean,
  print_error text
);

-- Where the message came from. The live database has carried this since
-- before it was written down here, defaulting everything to 'hoppie'; it is
-- spelled out now because ops messages are the first rows that are not off
-- the datalink, and a row that lies about its own provenance is worse than
-- no column at all. Added rather than put in the create above, so a database
-- that already has the table gets it too.
alter table public.acars_messages
  add column if not exists source text not null default 'hoppie';

create index if not exists acars_messages_at_idx on public.acars_messages (at desc);
-- The bridge may report a message twice if a batch is retried after the EFB
-- took it but before the bridge heard so. Its reference is stable, so the
-- second one lands on the same row instead of printing twice in the window.
create unique index if not exists acars_messages_reference_idx on public.acars_messages (reference);

alter table public.acars_messages enable row level security;
revoke all on public.acars_messages from anon;
grant select on public.acars_messages to authenticated;

drop policy if exists "the flight deck reads ACARS" on public.acars_messages;
create policy "the flight deck reads ACARS" on public.acars_messages
  for select to authenticated using (public.can_use_vpilot());

-- ---------- What the Edge Function calls ----------

-- The settings the bridge needs but is not allowed to keep: the Hoppie logon
-- code and the callsign. Only the service role may call this, and the Edge
-- Function only calls it for a bridge whose key has already been accepted by
-- vpilot_authenticate().
--
-- This is the one place the code leaves the database, and it goes straight
-- down the link to the bridge that owns the EFB. It is never returned to a
-- browser.
-- It also carries the crew, which has nothing to do with the logon code and
-- everything to do with this being the one channel from the database to the
-- bridge. The bridge prints a slip at the end of each sector and wants the
-- names on it; it cannot know them, because only the roster does.
create or replace function public.acars_bridge_config()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'acars', jsonb_build_object(
      'logon', coalesce(s.hoppie_code, ''),
      'callsign', coalesce(s.callsign, ''),
      'enabled', s.enabled
    ),
    -- Whoever is rostered to the sector being flown: the earliest one that
    -- has not arrived yet, which at the moment a slip prints is the sector
    -- that has just finished. In seat order, not alphabetical.
    'crew', coalesce(
      (select jsonb_agg(
                jsonb_build_object('duty', r.duty, 'name', p.display_name)
                order by case r.duty
                           when 'Captain' then 1
                           when 'First Officer' then 2
                           when 'Relief Pilot' then 3
                           else 4
                         end, p.display_name)
       from public.roster r
       join public.profiles p on p.id = r.user_id
       where r.sector_id = (
         select flying.id
         from public.sectors flying
         left join public.sector_actuals done on done.sector_id = flying.id
         where done.on_blocks is null and not coalesce(done.skipped, false)
         order by flying.std
         limit 1)),
      '[]'::jsonb)
  )
  from public.acars_secret s
  where s.id = 1;
$$;

-- Everything the bridge reported about ACARS, called from vpilot_ingest.
-- Its own function so the ACARS events can be added without touching the
-- radio's ingest, which is the part that must not break.
create or replace function public.acars_ingest_event(e jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  kind text := e->>'type';
  ref  text;
begin
  if kind = 'acars-state' then
    -- The bridge's own columns, every one of them, every time. The admin's
    -- (code_set, wanted_*) are deliberately absent: see the table.
    update public.acars_state
       set told = coalesce(public.vpilot_flag(e->'told'), false),
           enabled = coalesce(public.vpilot_flag(e->'enabled'), false),
           configured = coalesce(public.vpilot_flag(e->'configured'), false),
           callsign = nullif(e->>'callsign', ''),
           live = coalesce(public.vpilot_flag(e->'live'), false),
           atc_unit = nullif(e->>'atcUnit', ''),
           logon_pending = nullif(e->>'logonPending', ''),
           owing = coalesce((
             select array_agg((o.value)::integer order by o.ord)
             from jsonb_array_elements_text(coalesce(e->'owing', '[]'::jsonb))
               with ordinality as o(value, ord)
             where o.value ~ '^[0-9]+$'), '{}'),
           last_polled_at = case
             when coalesce(e->>'lastPolledAt', '') = '' then null
             else (e->>'lastPolledAt')::timestamptz end,
           trouble = nullif(e->>'trouble', ''),
           printer = coalesce(e->'printer', '{}'::jsonb),
           times = coalesce(e->'times', '{}'::jsonb),
           updated_at = now()
     where id = 1;

  elsif kind = 'acars-message' then
    ref := nullif(e->>'reference', '');
    if ref is null then
      return;
    end if;
    insert into public.acars_messages
      (reference, at, direction, from_station, to_station, kind, body, msg_no, answers, meaning)
    values (
      ref,
      case when coalesce(e->>'at', '') = '' then now() else (e->>'at')::timestamptz end,
      case when e->>'direction' = 'downlink' then 'downlink' else 'uplink' end,
      nullif(e->>'from', ''),
      nullif(e->>'to', ''),
      coalesce(nullif(e->>'kind', ''), 'telex'),
      coalesce(e->>'text', ''),
      public.vpilot_number(e->'min')::integer,
      coalesce((
        select array_agg(a.value order by a.ord)
        from jsonb_array_elements_text(coalesce(e->'answers', '[]'::jsonb))
          with ordinality as a(value, ord)), '{}'),
      nullif(e->>'meaning', ''))
    -- A batch the bridge retried after the EFB had already taken it must not
    -- double up in the message window.
    on conflict (reference) do nothing;

    -- The window keeps the last five hundred messages. A long event would
    -- otherwise grow this without bound, and nobody scrolls back past a
    -- sector. Only on an insert: the state event arrives on a 20 s heartbeat,
    -- and pruning on each of those would be three pointless scans a minute.
    delete from public.acars_messages
     where id <= coalesce((select max(id) from public.acars_messages), 0) - 500;

  elsif kind = 'acars-printed' then
    ref := nullif(e->>'reference', '');
    if ref is null then
      return;
    end if;
    update public.acars_messages
       set printed = coalesce(public.vpilot_flag(e->'ok'), false),
           print_error = nullif(e->>'error', '')
     where reference = ref;

  elsif kind = 'acars-trouble' then
    -- Something worth saying that is not a message: a controller who never
    -- answered a logon, say. It goes in the window as a notice from the
    -- bridge, because the alternative is it going nowhere.
    insert into public.acars_messages (reference, direction, from_station, kind, body)
    values ('T' || extract(epoch from clock_timestamp())::bigint || '-' || floor(random() * 1000)::text,
            'uplink', 'BRIDGE', 'notice', coalesce(e->>'message', ''))
    on conflict (reference) do nothing;
  end if;
end;
$$;

-- ---------- What the app calls ----------

-- The Hoppie logon code, set by an admin. Deliberately write-only: there is
-- no function anywhere that hands the code back to a browser, so a code that
-- has been set can be replaced but never read. An admin who has lost it gets
-- a new one from Hoppie.
--
-- Passing null for the code leaves whatever is already set alone, so the
-- callsign and the switch can be changed without retyping it.
create or replace function public.acars_set_logon(
  code text default null,
  callsign text default null,
  enabled boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  -- Everything the parameters are needed for is worked out here, into
  -- locals. The parameters are called code, callsign and enabled so the API
  -- reads properly, but two of those are also column names in the table
  -- being updated - and plpgsql raises on the ambiguity rather than guessing.
  -- Nothing below this block mentions a parameter.
  clean_code text := nullif(btrim(coalesce(code, '')), '');
  clean_call text := nullif(upper(regexp_replace(coalesce(callsign, ''), '[^A-Za-z0-9]', '', 'g')), '');
  -- Null means "leave it alone", which is how the callsign and the switch are
  -- changed without retyping the code - and how the code is kept when only
  -- the switch is flicked.
  change_call boolean := callsign is not null;
  want_enabled boolean := enabled;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can set the Hoppie logon code';
  end if;

  -- Hoppie issues codes well over this; anything shorter is a typo or a
  -- paste that went wrong, and a bad code only shows up as "illegal logon
  -- code" at the worst moment.
  if clean_code is not null and length(clean_code) < 6 then
    raise exception 'That does not look like a Hoppie logon code';
  end if;

  update public.acars_secret s
     set hoppie_code = coalesce(clean_code, s.hoppie_code),
         callsign = case when change_call then clean_call else s.callsign end,
         enabled = coalesce(want_enabled, s.enabled),
         set_by = auth.uid(),
         set_at = now()
   where s.id = 1;

  -- What was asked for, in the admin's own columns. Deliberately NOT the
  -- bridge's `configured`, `callsign` and `enabled`: those say what the
  -- simulator PC actually has, the bridge rewrites them every twenty seconds,
  -- and writing an intention into them only destroys the one piece of
  -- information that explains a station which is set up and still silent.
  --
  -- updated_at is the bridge's too - it is how the EFB tells a live bridge
  -- from a PC that has gone - so this does not touch it either.
  update public.acars_state t
     set code_set = (select s.hoppie_code is not null and s.hoppie_code <> ''
                       from public.acars_secret s where s.id = 1),
         wanted_callsign = (select s.callsign from public.acars_secret s where s.id = 1),
         wanted_enabled = (select s.enabled from public.acars_secret s where s.id = 1),
         wanted_at = now()
   where t.id = 1;
end;
$$;

-- Whether a code is set, and who set it - never the code. For the Settings
-- page, so an admin can see the station is configured without the code ever
-- being sent to a browser.
create or replace function public.acars_logon_status()
returns table (configured boolean, callsign text, enabled boolean, set_at timestamptz, set_by text)
language sql security definer set search_path = public as $$
  select
    s.hoppie_code is not null and s.hoppie_code <> '',
    s.callsign,
    s.enabled,
    s.set_at,
    p.display_name
  from public.acars_secret s
  left join public.profiles p on p.id = s.set_by
  where s.id = 1 and public.is_admin();
$$;

-- Forgets the code entirely, and switches ACARS off with it. For handing the
-- sim PC on, or a code that has leaked.
create or replace function public.acars_forget_logon()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can forget the Hoppie logon code';
  end if;
  update public.acars_secret
     set hoppie_code = null, enabled = false, set_by = auth.uid(), set_at = now()
   where id = 1;
  -- Only the admin's columns, as above. The bridge says what it still has
  -- until it next reports, which is the truth and is at most twenty seconds
  -- out of date.
  update public.acars_state
     set code_set = false, wanted_enabled = false, wanted_at = now()
   where id = 1;
end;
$$;

-- ---------- Ops to the crew ----------
--
-- A company uplink: ops types a message on their own tablet and it lands in
-- the flight deck's ACARS window and on the receipt printer, the way an
-- airline's own messages arrive alongside ATC's.
--
-- It deliberately does not go near Hoppie. Hoppie carries messages between
-- stations, and ops and the flight deck are the same station - a telex
-- addressed to our own callsign is either refused or comes straight back.
-- Both sides already share this database, so the message is simply written
-- here, where the flight deck is looking anyway, and the printer is asked
-- separately. That also means ops can leave a message with the simulator PC
-- switched off; the crew reads it when they next open ACARS.
--
-- Who may send: can_edit(), which is admin, dispatcher and operations. The
-- flight deck roles are left out on purpose - a pilot talking to ops has the
-- ops chat, and a crew member sending themselves a company message would be
-- a confusing thing to find on a strip of paper.
create or replace function public.acars_send_company(message text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  body_text text := btrim(coalesce(message, ''));
  ref       text;
  made      bigint;
  live      boolean;
  seen      timestamptz;
begin
  if not public.can_edit() then
    raise exception 'Only ops can send a company message to the crew';
  end if;
  if body_text = '' then
    raise exception 'There is no message to send';
  end if;
  -- One strip of paper. Hoppie's own limit is smaller, but this never goes
  -- to Hoppie; the cap is here so a pasted flight plan cannot empty the roll.
  if length(body_text) > 900 then
    raise exception 'That is too long for one ACARS message (% characters of 900)', length(body_text);
  end if;

  -- Our own reference, in the bridge's shape but plainly not Hoppie's. The
  -- unique index on reference is what stops a retried bridge batch printing
  -- a message twice; nothing retries this one, but it keeps the shape.
  ref := 'ops-' || gen_random_uuid()::text;

  insert into public.acars_messages
    (reference, direction, from_station, to_station, kind, body, source)
  values (
    ref, 'uplink', 'QFA-100 OPS',
    (select nullif(btrim(coalesce(callsign, '')), '') from public.acars_state where id = 1),
    'company', body_text, 'ops')
  returning id into made;

  -- And print it, if there is anything listening. Best effort on purpose:
  -- the message is already saved, and a sim PC that is switched off must not
  -- cost ops the message. vpilot_command() would raise here instead, which
  -- is right for a button on the flight deck and wrong for this.
  --
  -- Only 'text' goes down. 'reference' asks the bridge to print something it
  -- already holds, and it has never seen this one - it never came from
  -- Hoppie.
  select online, last_seen_at into live, seen from public.vpilot_link where id = 1;
  if coalesce(live, false) and coalesce(seen, 'epoch'::timestamptz) >= now() - interval '90 seconds' then
    insert into public.vpilot_commands (type, args, requested_by)
    values ('acars-print', jsonb_build_object('text', body_text, 'from', 'QFA-100 OPS', 'kind', 'company'), auth.uid());
  end if;

  return made;
end;
$$;

-- ---------- Driving the station ----------
-- The commands go down the queue the radio already uses, so there is one
-- path from the EFB to the sim PC and one place that checks what may be sent.
-- vpilot_command() is widened below to accept them.

-- Which ACARS commands the bridge understands. Checked before anything is
-- queued, so a command the bridge would only refuse never reaches it.
create or replace function public.acars_known_command(kind text)
returns boolean language sql immutable as $$
  select kind in (
    'acars-telex', 'acars-pdc', 'acars-info', 'acars-ping', 'acars-poll',
    'acars-logon', 'acars-logoff', 'acars-reply', 'acars-request',
    'acars-position', 'acars-progress', 'acars-print', 'acars-test-print');
$$;

-- What each one needs before it is worth sending. Its own function so
-- vpilot_command() stays readable with both sets of rules in it.
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
    if coalesce(btrim(given->>'request'), '') not in
       ('metar', 'taf', 'shorttaf', 'vatatis', 'peatis', 'ivaoatis') then
      raise exception 'The bridge cannot ask Hoppie for "%"', coalesce(given->>'request', '');
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

-- ---------- Who may call what ----------

revoke all on function public.acars_bridge_config() from public, anon, authenticated;
grant execute on function public.acars_bridge_config() to service_role;

revoke all on function public.acars_ingest_event(jsonb) from public, anon, authenticated;
grant execute on function public.acars_ingest_event(jsonb) to service_role;

-- Ops writes it; can_edit() inside decides who that is, so the grant is the
-- same as every other signed-in call.
revoke all on function public.acars_send_company(text) from anon;
grant execute on function public.acars_send_company(text) to authenticated;

revoke all on function public.acars_set_logon(text, text, boolean) from anon;
revoke all on function public.acars_logon_status() from anon;
revoke all on function public.acars_forget_logon() from anon;
grant execute on function public.acars_set_logon(text, text, boolean) to authenticated;
grant execute on function public.acars_logon_status() to authenticated;
grant execute on function public.acars_forget_logon() to authenticated;
