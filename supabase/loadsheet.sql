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
create or replace function public.loadsheet_num(value numeric, width integer default 12)
returns text language sql immutable as $fn$
  select lpad(case when value is null then '-----' else round(value)::bigint::text end, width);
$fn$;

-- The printed loadsheet, as one strip of paper.
--
-- Laid out for the flight deck printer, which is 42 columns across. Every
-- figure on the sheet sits in the same column as every other, whether it is a
-- weight, a fuel or a headcount, so the eye can run straight down it - a
-- loadsheet is read in a hurry, with a hand already on the FMC.
--
-- The two figure columns are halves of whatever `cols` leaves after the
-- labels, so changing that one number re-lays the whole sheet out rather than
-- needing every line edited. Do not take it below 36: the flight and route
-- line below is 38 characters and would wrap, and a wrapped line is the one
-- thing that makes a column of figures unreadable.
create or replace function public.loadsheet_body(target uuid)
returns text language plpgsql stable set search_path = public as $fn$
declare
  plan   record;
  ofp    jsonb;
  units  text;
  -- What the flight deck printer fits on a line.
  cols   constant integer := 42;
  -- Every figure is right-aligned inside its column, so they all end on the
  -- same column whatever their length. The two figure columns are deliberately
  -- narrow rather than split across the whole width: a figure column wider
  -- than the figures in it leaves a gap between WEIGHT and MAX that the short
  -- headings fall into, and a heading sitting ten spaces off the digits below
  -- it reads as crooked even when it is exactly aligned. Ten is room for seven
  -- figures, which is more than any 737 weight in kilos or pounds.
  --
  -- So the table is left-aligned and the paper keeps some white on the right,
  -- while the heading and the footer below still span the full width to frame
  -- it. That is how a printed form looks.
  lcol   constant integer := 8;
  wcol   constant integer := 10;
  mcol   constant integer := 10;
  rule   constant text := repeat('-', cols);
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
  -- beside the weight. Centred, because it is the one line meant to be seen
  -- before the sheet is read.
  if nullif(ofp ->> 'tow', '')::numeric > nullif(ofp ->> 'maxTow', '')::numeric then
    over := 'TOW EXCEEDS MAX';
  elsif nullif(ofp ->> 'zfw', '')::numeric > nullif(ofp ->> 'maxZfw', '')::numeric then
    over := 'ZFW EXCEEDS MAX';
  elsif nullif(ofp ->> 'ldw', '')::numeric > nullif(ofp ->> 'maxLdw', '')::numeric then
    over := 'LDW EXCEEDS MAX';
  end if;
  if over <> '' then
    over := '** ' || over || ' - CHECK **';
    over := E'
' || lpad(over, (cols + length(over)) / 2);
  end if;

  sheet := concat_ws(E'
',
    rpad('LOADSHEET', cols - 10) || lpad('EDNO ' || plan.edno::text, 10),
    concat_ws('  ',
      coalesce(nullif(plan.flight, ''), '-'),
      coalesce(nullif(plan.dep, ''), '----') || '/' || coalesce(nullif(plan.arr, ''), '----'),
      upper(to_char(plan.std, 'DDMon')),
      coalesce(nullif(ofp ->> 'acft', ''), '----'),
      coalesce(nullif(ofp ->> 'reg', ''), 'REG N/A')),
    rule,
    rpad('', lcol) || lpad('WEIGHT', wcol) || lpad('MAX', mcol),
    rpad('ZFW', lcol)   || public.loadsheet_num(nullif(ofp ->> 'zfw', '')::numeric, wcol)
                        || public.loadsheet_num(nullif(ofp ->> 'maxZfw', '')::numeric, mcol),
    rpad('TOF', lcol)   || public.loadsheet_num(tof, wcol),
    rpad('TOW', lcol)   || public.loadsheet_num(nullif(ofp ->> 'tow', '')::numeric, wcol)
                        || public.loadsheet_num(nullif(ofp ->> 'maxTow', '')::numeric, mcol),
    rpad('TRIP', lcol)  || public.loadsheet_num(nullif(ofp ->> 'tripFuel', '')::numeric, wcol),
    rpad('LDW', lcol)   || public.loadsheet_num(nullif(ofp ->> 'ldw', '')::numeric, wcol)
                        || public.loadsheet_num(nullif(ofp ->> 'maxLdw', '')::numeric, mcol),
    rule,
    rpad('PAX', lcol)   || public.loadsheet_num(nullif(ofp ->> 'pax', '')::numeric, wcol),
    rpad('CARGO', lcol) || public.loadsheet_num(nullif(ofp ->> 'cargo', '')::numeric, wcol),
    rpad('TAXI', lcol)  || public.loadsheet_num(nullif(ofp ->> 'taxiFuel', '')::numeric, wcol),
    rpad('RESV', lcol)  || public.loadsheet_num(nullif(ofp ->> 'reserveFuel', '')::numeric, wcol),
    rule,
    'ALL WEIGHTS IN ' || units,
    rpad('PREPARED ' || to_char(now(), 'HH24:MI') || 'Z', cols - 12) || lpad('LOAD CONTROL', 12)
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

-- ---------- Trying it without waiting for the first sector ----------
--
-- Nothing is scheduled for a sector until its OFP has been imported, so days
-- before the event there is nothing here to look at. This is how to see the
-- whole thing work today, in order. Run each on its own.
--
--   1. Is this file installed at all? An empty table is the right answer
--      before any OFP has been imported; an error means it is not installed.
-- select count(*) from public.loadsheets;
--
--   2. Import an OFP for a sector in the app first - Briefing -> Flight plan
--      -> Import latest OFP. The plan in SimBrief has to be that sector's
--      route or the app refuses it. Then schedule the sheets by hand rather
--      than waiting up to half a minute for the cron:
-- select public.loadsheet_tick();
--
--   3. What got scheduled, and whether the window is being honoured. The last
--      column should read between 7 and 20 minutes for a first edition:
-- select s.flight, s.dep, s.arr, s.std, l.edno, l.due_at, l.sent_at,
--        s.std - l.due_at as before_departure
-- from public.loadsheets l join public.sectors s on s.id = l.sector_id
-- order by s.std;
--
--   4. The paper itself, before anybody sends it. Takes a sector id, which
--      step 3 can give you:
-- select public.loadsheet_body((select sector_id from public.loadsheets limit 1));
--
--   5. Print one now. Note this calls loadsheet_deliver and NOT
--      loadsheet_send_now: send_now is what the Ops board button calls, and it
--      asks can_edit(), which reads auth.uid() - and auth.uid() is null in the
--      SQL Editor, so it would refuse you here however much of an admin you
--      are. deliver is the same send without the permission check, which is
--      why the app is never given it.
-- select public.loadsheet_deliver((select sector_id from public.loadsheets limit 1));
--
--   6. And it should now be in the ACARS window and on the printer:
-- select at, reference, from_station, printed, print_error
-- from public.acars_messages where source = 'loadsheet' order by at desc;
--
-- ---------- If the MAX column prints as dashes ----------
--
-- The limits are not on the sheet because they are not in the stored OFP. The
-- app only started reading max_zfw, max_tow and max_ldw out of SimBrief when
-- the loadsheet was built, so any plan imported before that was saved without
-- them, and no amount of re-running this file puts them there. Import the
-- plan again on the sector's Briefing page and they appear.
--
-- This says which it is: `parsed` false means the key is absent, so the OFP
-- predates the change and wants re-importing. True with an empty value means
-- SimBrief itself did not give a limit for that airframe. The CARGO line came
-- in at the same time, so it is the other tell - dashes in both is a stale
-- import rather than anything wrong with the sheet.
-- select s.flight, b.ofp ? 'maxTow' as parsed, b.ofp ->> 'maxTow' as value,
--        b.ofp ? 'cargo' as cargo_parsed, b.ofp_at
-- from public.briefings b join public.sectors s on s.id = b.sector_id
-- where b.ofp is not null order by s.std;
--
-- To go round again on the same sector, clear the send and let it re-schedule:
-- update public.loadsheets set sent_at = null, due_at = now() where sector_id = '<id>';
