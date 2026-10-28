-- Run after report-shifts.sql and crew-confirm.sql, as the database owner.
-- All changes are rolled back, including the two test sectors and accounts it
-- makes, so it is safe to run against a live project.
--
-- What it is really guarding is the third assertion. The obvious way to write
-- this feature measures the move as report_at + (estimate - published std),
-- and then approving it moves report_at - so the next tick measures the same
-- delay all over again and asks the controller the same question for ever.
-- Hence anchor_off: a row remembers which estimate its report time is lined
-- up with. Take that out and this still looks right in the app for about ten
-- seconds.

begin;

-- auth.uid() is null for the owner, and every decision here goes through
-- can_edit(), so the session pretends to be the admin account made below.
do $$
declare
  boss    uuid := gen_random_uuid();
  flyer   uuid := gen_random_uuid();
  sec_a   uuid;
  sec_b   uuid;
  entry   uuid;
  published timestamptz;
  moved   timestamptz;
  pending integer;
begin
  insert into public.profiles (id, display_name, role, is_test)
  values (boss, 'Test Controller', 'admin', true), (flyer, 'Test Pilot', 'pilot', true);
  perform set_config('request.jwt.claims', json_build_object('sub', boss, 'role', 'authenticated')::text, true);

  update public.settings set roster_state = 'published' where id = 1;

  -- Two sectors back to back. The first lands two hours late, so the second
  -- cannot get away on time: the aeroplane is not back and turned round.
  insert into public.sectors (flight, dep, arr, std, sta)
  values ('TESTA', 'YSSY', 'WSSS', now() + interval '1 hour', now() + interval '2 hours')
  returning id into sec_a;
  insert into public.sectors (flight, dep, arr, std, sta)
  values ('TESTB', 'WSSS', 'OMDB', now() + interval '3 hours', now() + interval '5 hours')
  returning id into sec_b;
  insert into public.sector_actuals (sector_id, off_blocks, on_blocks)
  values (sec_a, now() + interval '1 hour', now() + interval '3 hours');

  -- One seat on the second sector, reporting 45 minutes before it goes.
  insert into public.roster (sector_id, user_id, duty, report_at)
  values (sec_b, flyer, 'Captain', now() + interval '2 hours 15 minutes')
  returning id into entry;
  select report_at into published from public.roster where id = entry;

  -- 1. The delay raises a question, and changes nothing by itself.
  perform public.raise_report_shifts();
  if not exists (select 1 from public.report_shifts where roster_id = entry and state = 'pending') then
    raise exception 'A sector held up by two hours raised no report-time decision';
  end if;
  if (select report_at from public.roster where id = entry) <> published then
    raise exception 'The delay moved a report time on its own';
  end if;

  -- 2. Approving it moves the report time, and only then.
  moved := public.approve_report_shift(entry);
  if (select report_at from public.roster where id = entry) <> moved then
    raise exception 'Approving a move did not write the report time to the roster';
  end if;
  if moved <= published then
    raise exception 'Approving a delay moved the report time earlier, not later';
  end if;
  if exists (select 1 from public.report_shifts where roster_id = entry and state = 'pending') then
    raise exception 'A decided report time is still waiting on a decision';
  end if;

  -- 3. And the same delay is not put in front of them again.
  perform public.raise_report_shifts();
  perform public.raise_report_shifts();
  if exists (select 1 from public.report_shifts where roster_id = entry and state = 'pending') then
    raise exception 'The same delay was raised again after it had been approved';
  end if;
  if (select report_at from public.roster where id = entry) <> moved then
    raise exception 'A later tick moved an approved report time again';
  end if;

  -- 4. The day slips another hour, which is a new question. Leaving that one
  --    alone is a decision too, and it also sticks.
  update public.sector_actuals set on_blocks = on_blocks + interval '1 hour' where sector_id = sec_a;
  perform public.raise_report_shifts();
  select count(*) into pending from public.report_shifts where roster_id = entry and state = 'pending';
  if pending <> 1 then
    raise exception 'An hour more delay raised % decisions, wanted 1', pending;
  end if;
  perform public.dismiss_report_shift(entry);
  perform public.raise_report_shifts();
  if (select report_at from public.roster where id = entry) <> moved then
    raise exception 'Leaving a report time alone changed it anyway';
  end if;
  if exists (select 1 from public.report_shifts where roster_id = entry and state = 'pending') then
    raise exception 'A report time left alone was asked about again on the next tick';
  end if;

  -- 5. A report time set by hand is a time somebody chose with the delay in
  --    front of them, so it is not then argued with.
  update public.roster set report_at = published where id = entry;
  perform public.raise_report_shifts();
  perform public.raise_report_shifts();
  if exists (select 1 from public.report_shifts where roster_id = entry and state = 'pending') then
    raise exception 'A report time typed in by ops was raised as a move straight back';
  end if;

  -- 6. The pilot has something to confirm, and confirming clears it.
  if not exists (select 1 from public.crew_changes where user_id = flyer and kind = 'added' and seen_at is null) then
    raise exception 'Being rostered on a sector left the pilot nothing to confirm';
  end if;
  if not exists (select 1 from public.crew_changes where user_id = flyer and kind = 'report' and seen_at is null) then
    raise exception 'A report time moved by ops left the pilot nothing to confirm';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', flyer, 'role', 'authenticated')::text, true);
  if public.confirm_changes() < 2 then
    raise exception 'Confirming did not clear what was waiting';
  end if;
  if exists (select 1 from public.crew_changes where user_id = flyer and seen_at is null) then
    raise exception 'Something was still waiting after the pilot confirmed';
  end if;

  -- 7. A sector moving is the pilot's business too.
  perform set_config('request.jwt.claims', json_build_object('sub', boss, 'role', 'authenticated')::text, true);
  update public.sectors set std = std + interval '30 minutes', sta = sta + interval '30 minutes'
  where id = sec_b;
  if not exists (select 1 from public.crew_changes where user_id = flyer and kind = 'sector' and seen_at is null) then
    raise exception 'The sector moving under the crew left them nothing to confirm';
  end if;

  raise notice 'report-shifts: all assertions passed';
end;
$$;

rollback;
