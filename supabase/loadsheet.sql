-- The loadsheet, delivered by ACARS and printed on the flight deck printer.
--
-- Run after supabase/acars.sql and supabase/notifications.sql in the Supabase
-- SQL Editor. Safe to run again.
--
-- ---- What this is ----
--
-- A real crew does not read the weights off the flight plan. Load control
-- sends a loadsheet up the datalink a few minutes before push, it prints on
-- the pedestal, and the crew enters those figures. This does the same: the
-- figures come out of the OFP the team imported from SimBrief, and they
-- arrive on paper, unasked for, shortly before departure.
--
-- ---- Why it is in the database and not in the app ----
--
-- It has to arrive whether or not anybody is looking at a tablet. A browser
-- cannot be trusted to fire a timer at a particular minute: the tablet may be
-- asleep, the page may be closed, and four tablets open at once would send it
-- four times. So the schedule lives here, on the same cron that drives push
-- notifications, and the send is one insert that the unique index on
-- acars_messages.reference makes safe to attempt twice.
--
-- ---- When it arrives ----
--
--   * The first one lands at a random moment between 20 and 7 minutes before
--     the scheduled departure, which is about when a real one turns up: late
--     enough that the figures are current, early enough to enter them without
--     being rushed. The moment is drawn once, when the sheet is scheduled,
--     and then kept - not redrawn on every tick, or it would never settle.
--   * Import a new OFP after that one has printed and a revision follows,
--     between 10 and 5 minutes before departure.
--   * A revision that cannot make that window - a plan imported at six
--     minutes to go, or after the departure time - prints 1 to 2 minutes
--     after the import instead. The sheet never holds the aeroplane: a late
--     revision is late, and still better in the crew's hand than waited for.
--
-- Nothing is sent for a sector that has already pushed back, and nothing is
-- sent without an OFP, because there would be no figures to send.

-- ---------- What has been sent, and what is due ----------

-- One row per sector. It holds the drawn send time rather than working it out
-- each tick, so the arrival does not jump about as the cron runs.
create table if not exists public.loadsheets (
  sector_id uuid primary key references public.sectors (id) on delete cascade,
  -- Edition number, the way a loadsheet counts them: 1 is the first, and a
  -- revision is 2, 3 and so on.
  edno      integer not null default 1,
  -- When this edition is due to print, and when it actually did.
  due_at    timestamptz not null,
  sent_at   timestamptz,
  -- Which OFP import this edition was built from. A briefing whose ofp_at has
  -- moved past this one has been re-planned, and the sheet needs re-issuing.
  ofp_at    timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.loadsheets enable row level security;
revoke all on public.loadsheets from anon;
grant select on public.loadsheets to authenticated;

-- Readable by the team, so the app can say a sheet is on its way. Written
-- only by the tick below, which is security definer and runs as the owner.
drop policy if exists "the team reads loadsheets" on public.loadsheets;
create policy "the team reads loadsheets" on public.loadsheets
  for select to authenticated using (true);

-- ---------- The sheet itself ----------

-- A weight as a loadsheet prints it: whole numbers, right-aligned in its
-- column. A null becomes dashes rather than a zero, because a figure the OFP
-- did not carry and a figure that is actually zero are not the same thing to
-- a crew reading it.
create or replace function public.loadsheet_num(value numeric, width integer default 8)
returns text language sql immutable as $fn$
  select lpad(case when value is null then '-----' else round(value)::bigint::text end, width);
$fn$;

-- The printed loadsheet, as one strip of paper. Kept inside 32 columns so it
-- prints whole on a 58mm roll as well as an 80mm one.
create or replace function public.loadsheet_body(target uuid)
returns text language plpgsql stable set search_path = public as $fn$
declare
  plan   record;
  ofp    jsonb;
  units  text;
  rule   constant text := repeat('-', 32);
  sheet  text;
  over   text := '';
  tof    numeric;
begin
  select sec.flight, sec.dep, sec.arr, sec.std, b.ofp, coalesce(l.edno, 1) as edno
    into plan
  from public.sectors sec
  left join public.briefings b on b.sector_id = sec.id
  left join public.loadsheets l on l.sector_id = sec.id
  where sec.id = target;

  if not found or plan.ofp is null then
    return null;
  end if;

  ofp := plan.ofp;
  units := upper(coalesce(nullif(ofp ->> 'units', ''), 'KGS'));

  -- Takeoff fuel is the ramp fuel less what is burnt getting to the runway,
  -- which is the figure that goes in the box - not the block fuel.
  tof := nullif(ofp ->> 'blockFuel', '')::numeric - coalesce(nullif(ofp ->> 'taxiFuel', '')::numeric, 0);

  -- A plan can come back over a structural limit; SimBrief will produce one
  -- without complaint. Saying so is the whole reason for printing the maximum
  -- beside the weight.
  if nullif(ofp ->> 'tow', '')::numeric > nullif(ofp ->> 'maxTow', '')::numeric then
    over := E'\n** TOW EXCEEDS MAX - CHECK **';
  elsif nullif(ofp ->> 'zfw', '')::numeric > nullif(ofp ->> 'maxZfw', '')::numeric then
    over := E'\n** ZFW EXCEEDS MAX - CHECK **';
  elsif nullif(ofp ->> 'ldw', '')::numeric > nullif(ofp ->> 'maxLdw', '')::numeric then
    over := E'\n** LDW EXCEEDS MAX - CHECK **';
  end if;

  sheet := concat_ws(E'\n',
    'LOADSHEET            EDNO ' || plan.edno::text,
    format('%s  %s/%s  %s',
           coalesce(nullif(plan.flight, ''), '-'),
           coalesce(nullif(plan.dep, ''), '----'),
           coalesce(nullif(plan.arr, ''), '----'),
           upper(to_char(plan.std, 'DDMon'))),
    format('%s  %s',
           coalesce(nullif(ofp ->> 'acft', ''), '----'),
           coalesce(nullif(ofp ->> 'reg', ''), 'REG N/A')),
    rule,
    rpad('', 13) || lpad('WEIGHT', 9) || lpad('MAX', 10),
    rpad('ZFW', 13) || public.loadsheet_num(nullif(ofp ->> 'zfw', '')::numeric, 9)
                     || public.loadsheet_num(nullif(ofp ->> 'maxZfw', '')::numeric, 10),
    rpad('TAKEOFF FUEL', 13) || public.loadsheet_num(tof, 9),
    rpad('TOW', 13) || public.loadsheet_num(nullif(ofp ->> 'tow', '')::numeric, 9)
                     || public.loadsheet_num(nullif(ofp ->> 'maxTow', '')::numeric, 10),
    rpad('TRIP FUEL', 13) || public.loadsheet_num(nullif(ofp ->> 'tripFuel', '')::numeric, 9),
    rpad('LDW', 13) || public.loadsheet_num(nullif(ofp ->> 'ldw', '')::numeric, 9)
                     || public.loadsheet_num(nullif(ofp ->> 'maxLdw', '')::numeric, 10),
    rule,
    format('PAX %s    CARGO %s',
           coalesce(nullif(ofp ->> 'pax', ''), '-'),
           coalesce(round(nullif(ofp ->> 'cargo', '')::numeric)::bigint::text, '-')),
    format('TAXI %s    RESERVE %s',
           coalesce(round(nullif(ofp ->> 'taxiFuel', '')::numeric)::bigint::text, '-'),
           coalesce(round(nullif(ofp ->> 'reserveFuel', '')::numeric)::bigint::text, '-')),
    'ALL WEIGHTS IN ' || units,
    rule,
    'PREPARED ' || to_char(now(), 'HH24:MI') || 'Z  LOAD CONTROL'
  );

  return sheet || over;
end;
$fn$;

-- ---------- Scheduling ----------

-- The moment a first edition should print: somewhere in the twenty minutes
-- before departure, and never inside the last seven.
create or replace function public.loadsheet_first_due(std timestamptz)
returns timestamptz language sql volatile as $fn$
  select std - make_interval(secs => 7 * 60 + floor(random() * (13 * 60 + 1))::integer);
$fn$;

-- And for a revision. The window is tighter - ten to five minutes out - and
-- when there is no longer room for it the sheet goes a minute or two from now
-- instead. Nothing here is ever allowed to be the reason the aeroplane is
-- late, so a window that has passed is given up on rather than waited for.
create or replace function public.loadsheet_revision_due(std timestamptz)
returns timestamptz language sql volatile as $fn$
  select case
    when now() < std - interval '11 minutes'
      then std - make_interval(secs => 5 * 60 + floor(random() * (5 * 60 + 1))::integer)
    else now() + make_interval(secs => 60 + floor(random() * 61)::integer)
  end;
$fn$;

-- ---------- Sending one ----------

-- Builds a sheet, puts it in the ACARS window and asks the printer for it.
-- The tick calls this when one comes due; loadsheet_send_now() calls it to
-- force one out. One path, so a forced sheet is the same sheet.
--
-- The edition is not bumped here. A reprint of the same figures is the same
-- edition - that is what EDNO means - and only a new OFP makes it a revision.
-- So asking again for a sheet the printer ate reprints EDNO 2 rather than
-- inventing an EDNO 3 nobody can reconcile with the one in their hand.
create or replace function public.loadsheet_deliver(target uuid)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare
  sheet text;
  ref   text;
  ed    integer;
  live  boolean;
  seen  timestamptz;
begin
  select edno into ed from public.loadsheets where sector_id = target;
  if ed is null then
    return false;
  end if;

  sheet := public.loadsheet_body(target);
  if sheet is null then
    return false;
  end if;

  -- The reference carries the sector and the edition, so a repeated tick
  -- lands on the same row instead of filling the window with copies. The
  -- print below is asked for either way, which is what makes this a reprint.
  ref := 'loadsheet-' || target::text || '-' || ed::text;

  insert into public.acars_messages
    (reference, direction, from_station, to_station, kind, body, source)
  values (
    ref, 'uplink', 'LOAD CONTROL',
    (select nullif(btrim(coalesce(callsign, '')), '') from public.acars_state where id = 1),
    'loadsheet', sheet, 'loadsheet')
  on conflict (reference) do nothing;

  -- Best effort, exactly as acars_send_company does it: the sheet is saved
  -- either way, and a simulator that is switched off must not wedge the tick.
  select online, last_seen_at into live, seen from public.vpilot_link where id = 1;
  if coalesce(live, false) and coalesce(seen, 'epoch'::timestamptz) >= now() - interval '90 seconds' then
    insert into public.vpilot_commands (type, args, requested_by)
    values ('acars-print',
            jsonb_build_object('text', sheet, 'from', 'LOAD CONTROL', 'kind', 'loadsheet'),
            auth.uid());
  end if;

  update public.loadsheets
  set sent_at = now(), updated_at = now()
  where sector_id = target;

  return true;
end;
$fn$;

revoke all on function public.loadsheet_deliver(uuid) from public, anon, authenticated;

-- ---------- The tick ----------

-- Schedules what needs scheduling and sends what is due. Called by cron every
-- half minute; a window measured in minutes does not need better than that.
create or replace function public.loadsheet_tick()
returns integer language plpgsql security definer set search_path = public as $fn$
declare
  due  record;
  sent integer := 0;
begin
  -- 1. A sector with an OFP, still on the ground, and no sheet scheduled yet.
  -- The hour of grace lets a sector that went late still get its sheet.
  insert into public.loadsheets (sector_id, edno, due_at, ofp_at)
  select s.id, 1, public.loadsheet_first_due(s.std), b.ofp_at
  from public.sectors s
  join public.briefings b on b.sector_id = s.id
  left join public.sector_actuals a on a.sector_id = s.id
  where b.ofp is not null
    and a.off_blocks is null
    and not coalesce(a.skipped, false)
    and s.std > now() - interval '1 hour'
  on conflict (sector_id) do nothing;

  -- 2. A sheet that has printed, against a plan since imported again. Re-issue
  -- it, one edition up, in the revision window.
  update public.loadsheets l
  set edno = l.edno + 1,
      sent_at = null,
      due_at = public.loadsheet_revision_due(s.std),
      ofp_at = b.ofp_at,
      updated_at = now()
  from public.sectors s
  join public.briefings b on b.sector_id = s.id
  left join public.sector_actuals a on a.sector_id = s.id
  where l.sector_id = s.id
    and l.sent_at is not null
    and b.ofp_at is not null
    -- A sheet whose own ofp_at never got recorded counts as older than any
    -- import, rather than never being re-issued at all.
    and (l.ofp_at is null or b.ofp_at > l.ofp_at)
    and a.off_blocks is null
    and not coalesce(a.skipped, false);

  -- 3. A sheet not yet printed, against a plan imported again before it went.
  -- Still the same edition - nobody has seen the old figures - so it keeps the
  -- send time already drawn for it and is simply built from the newer plan.
  update public.loadsheets l
  set ofp_at = b.ofp_at, updated_at = now()
  from public.briefings b
  where l.sector_id = b.sector_id
    and l.sent_at is null
    and b.ofp_at is not null
    and (l.ofp_at is null or b.ofp_at > l.ofp_at);

  -- 4. Send what is due.
  for due in
    select l.sector_id
    from public.loadsheets l
    left join public.sector_actuals a on a.sector_id = l.sector_id
    where l.sent_at is null
      and l.due_at <= now()
      and a.off_blocks is null
      and not coalesce(a.skipped, false)
      -- On the ground, and that means the aeroplane rather than this sector.
      -- On a day running late the next sector's sheet can come due while the
      -- one before it is still airborne, and a loadsheet rolling out of the
      -- printer in the cruise is no use to anybody. It waits, and goes once
      -- they are on blocks - late, but in their hand on the ground.
      and not exists (
        select 1 from public.sector_actuals flying
        where flying.off_blocks is not null and flying.on_blocks is null
      )
    order by l.due_at
  loop
    if public.loadsheet_deliver(due.sector_id) then
      sent := sent + 1;
    end if;
  end loop;

  return sent;
end;
$fn$;

revoke all on function public.loadsheet_tick() from public, anon, authenticated;

-- ---------- Asking for one again ----------

-- "Resend loadsheet", from the sector's own briefing page. The crew have not
-- had it, or the paper is in the bin, and they want it again. It does not
-- print on the spot: it goes back in the queue on the same terms a revision
-- does - ten to five minutes before departure, or a minute or two from now
-- when there is no longer room for that - so a sheet asked for an hour out
-- still arrives when a loadsheet should, and one asked for at eight minutes
-- to go arrives straight away.
--
-- Open to everybody who writes briefings, which is the crew flying it.
create or replace function public.loadsheet_resend(target uuid)
returns timestamptz language plpgsql security definer set search_path = public as $fn$
declare
  std_at timestamptz;
  due    timestamptz;
begin
  if not public.can_report() then
    raise exception 'You cannot ask for a loadsheet';
  end if;

  select s.std into std_at
  from public.sectors s
  join public.briefings b on b.sector_id = s.id
  where s.id = target and b.ofp is not null;

  if not found then
    raise exception 'No flight plan has been imported for this sector, so there are no figures to put on a loadsheet';
  end if;

  due := public.loadsheet_revision_due(std_at);

  -- The edition stays as it is: the same figures on the same sheet. Only a
  -- new OFP makes it a revision, and loadsheet_tick() handles that one.
  insert into public.loadsheets (sector_id, edno, due_at, ofp_at)
  values (target, 1, due, (select ofp_at from public.briefings where sector_id = target))
  on conflict (sector_id) do update
    set due_at = due, sent_at = null, updated_at = now();

  return due;
end;
$fn$;

-- Force one out now, from the Ops Board. For when the schedule is not the
-- problem: the printer jammed, the bridge was down when it went, the crew are
-- asking and nobody wants to explain the queue to them. It skips the send
-- time and the on-the-ground check, because somebody has looked and decided.
--
-- Ops, dispatchers and admins - the same people who can already send the crew
-- a company ACARS message, and the same people the Ops Board is open to.
create or replace function public.loadsheet_send_now(target uuid)
returns boolean language plpgsql security definer set search_path = public as $fn$
declare
  gone boolean;
begin
  if not public.can_edit() then
    raise exception 'Only ops can force a loadsheet';
  end if;

  if not exists (
    select 1 from public.briefings where sector_id = target and ofp is not null
  ) then
    raise exception 'No flight plan has been imported for this sector, so there are no figures to put on a loadsheet';
  end if;

  -- A sector nobody has scheduled a sheet for yet - the tick has not come
  -- round, or the sector is further out than it looks at - still gets one.
  insert into public.loadsheets (sector_id, edno, due_at, ofp_at)
  values (target, 1, now(), (select ofp_at from public.briefings where sector_id = target))
  on conflict (sector_id) do nothing;

  gone := public.loadsheet_deliver(target);
  if not gone then
    raise exception 'The loadsheet could not be built for this sector';
  end if;
  return gone;
end;
$fn$;

grant execute on function public.loadsheet_resend(uuid) to authenticated;
grant execute on function public.loadsheet_send_now(uuid) to authenticated;

-- ---------- The clock ----------

select cron.unschedule('loadsheet-tick') where exists (select 1 from cron.job where jobname = 'loadsheet-tick');
select cron.schedule('loadsheet-tick', '30 seconds', $job$ select public.loadsheet_tick() $job$);

-- Run it once now and see what it says.
select public.loadsheet_tick() as sent_now;

-- ---------- Checking it ----------
--
--   What is scheduled, when it is due, and how long before departure that is:
-- select s.flight, s.dep, s.arr, s.std, l.edno, l.due_at, l.sent_at,
--        s.std - l.due_at as before_departure
-- from public.loadsheets l join public.sectors s on s.id = l.sector_id
-- order by s.std;
--
--   What one looks like before it is sent:
-- select public.loadsheet_body('paste-a-sector-id-here');
