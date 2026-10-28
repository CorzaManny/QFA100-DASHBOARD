-- Notifications: tells a pilot's phone when the roster is published, when
-- their own sectors change, and when it is nearly time to report. It also
-- tells the ops controllers when a delay has put a report-time move in front
-- of them to decide (see supabase/report-shifts.sql).
--
-- Run this in the SQL Editor after schema.sql, and after deploying the
-- send-push function (supabase/functions/send-push/index.ts). Three things
-- have to be filled in below, all marked "<= fill in":
--
--   1. the VAPID private key that goes with the public one in js/config.js
--   2. the address of your send-push function
--   3. any secret you like, so only the database can call that function
--
-- Fill them in here in the SQL Editor, not in the file on your computer: this
-- repository is public. They are only written the first time, so it is safe to
-- run this file again later without pasting them in again.

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

-- ---------- Where the pieces are kept ----------

-- One row, readable only by the database itself and the send-push function.
create table if not exists public.push_config (
  id            boolean primary key default true check (id),
  vapid_public  text not null default '',
  vapid_private text not null default '',
  subject       text not null default 'https://efb.qfa100.org',
  edge_url      text not null default '',
  secret        text not null default ''
);
insert into public.push_config (id) values (true) on conflict (id) do nothing;

-- Each of these is only written the first time, so running this file again
-- keeps what you already saved and you never have to paste them in twice.
update public.push_config set
  vapid_public  = 'BBQNk0GT1-Fa1AgSql6WRll_GHErZz6o8picqXFW65tNfiRRNBc0OvcGaf0X7WfZUujkX25tRhodSEK2oTdEChE',
  vapid_private = coalesce(nullif(vapid_private, ''),
    'PASTE-THE-PRIVATE-KEY-HERE'),                                   -- <= fill in
  edge_url      = coalesce(nullif(edge_url, ''),
    'https://YOUR-PROJECT.supabase.co/functions/v1/send-push'),      -- <= fill in
  secret        = coalesce(nullif(secret, ''),
    'PICK-ANY-LONG-RANDOM-STRING')                                   -- <= fill in
where id;

-- To change one of them later, run just this line with the new value:
--   update public.push_config set secret = 'the new one' where id;

-- Who the push services can contact about this app. It has to be a real
-- https address or a real mailto:, and some of them refuse a made-up one, so
-- the app's own address is used. Change it to your email if you would rather.
-- The old GitHub Pages address is listed here as well, so running this file
-- again moves a project set up before the team had its own domain.
update public.push_config
set subject = 'https://efb.qfa100.org'
where id and subject in ('', 'mailto:ops@qfa100.example', 'https://corzamanny.github.io/QFA100-DASHBOARD');

-- Supabase's gateway wants an Authorization header before a function is
-- allowed to run at all. The publishable key from js/config.js satisfies it --
-- that key is public by design, and the real check is the secret above. If you
-- would rather turn "Verify JWT" off on the function instead, leave this empty
-- and no header is sent.
alter table public.push_config add column if not exists auth_key text not null default '';
update public.push_config
set auth_key = coalesce(nullif(auth_key, ''), 'sb_publishable_294YXJrzcL-PXagMXnAFog_PM3CsjJH')
where id;

-- One row per device somebody has turned notifications on for. A person can
-- have several: their phone, their iPad, the computer at the sim.
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  label      text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Everything waiting to be sent, and everything already sent. Keeping the sent
-- ones means a notification is never sent twice, and you can see what went out.
create table if not exists public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null default '',
  url        text not null default '#/dashboard',
  ttl        integer not null default 3600,
  dedupe     text not null unique,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists notifications_waiting_idx on public.notifications (created_at) where sent_at is null;
-- How many goes it has had, and what went wrong on the last one.
alter table public.notifications add column if not exists tries integer not null default 0;
alter table public.notifications add column if not exists error text not null default '';

alter table public.push_config enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notifications enable row level security;

revoke all on public.push_config from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select on public.notifications to authenticated;

-- A person manages their own devices and reads their own notifications.
drop policy if exists "own devices" on public.push_subscriptions;
create policy "own devices" on public.push_subscriptions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own notifications" on public.notifications;
create policy "own notifications" on public.notifications
  for select to authenticated using (user_id = auth.uid());

-- ---------- How late the day is running ----------

-- The same chain the app draws on the Schedule page, worked out in the
-- database so the notifications can use it: a sector leaves no earlier than
-- its published window, and no earlier than the aeroplane is back and turned
-- round. The live aircraft position is not available here, so this uses only
-- the times the flight deck has stamped.
create or replace function public.sector_running()
returns table (sector_id uuid, est_off timestamptz, est_on timestamptz, delay_minutes integer)
language plpgsql stable security definer set search_path = public as $$
declare
  turn interval;
  r    record;
  off_ timestamptz;
  on_  timestamptz;
  prev timestamptz;
begin
  select make_interval(mins => round(coalesce((rules ->> 'turnaroundMinutes')::numeric, 45))::integer)
    into turn from public.settings limit 1;
  turn := coalesce(turn, interval '45 minutes');

  for r in
    select s.id, s.std, s.sta, a.off_blocks, a.on_blocks, coalesce(a.skipped, false) as skipped
    from public.sectors s
    left join public.sector_actuals a on a.sector_id = s.id
    order by s.std
  loop
    continue when r.skipped;
    off_ := coalesce(r.off_blocks, greatest(r.std, coalesce(prev + turn, r.std)));
    on_  := coalesce(r.on_blocks, off_ + (r.sta - r.std));
    prev := on_;
    sector_id := r.id;
    est_off := off_;
    est_on := on_;
    delay_minutes := round(extract(epoch from (off_ - r.std)) / 60);
    return next;
  end loop;
end;
$$;

-- Everyone's report time, beside what the day is actually doing.
--
-- due_at is the published report time and nothing else. The app used to move
-- it by the delay on the sector, which meant the clock a pilot reported to was
-- set by a stamped time nobody had looked at. A delay now only proposes a new
-- time, for the ops controller to approve; see supabase/report-shifts.sql.
-- est_off and delay_minutes are still here because that is what the proposal
-- is worked out from.
create or replace view public.report_times with (security_invoker = true) as
  select r.id as roster_id, r.user_id, r.duty, r.report_at, s.id as sector_id, s.flight, s.dep, s.arr, s.std,
         run.est_off, run.delay_minutes,
         r.report_at as due_at
  from public.roster r
  join public.sectors s on s.id = r.sector_id
  join public.sector_running() run on run.sector_id = s.id;

grant select on public.report_times to authenticated;

-- ---------- What is worth telling someone ----------

-- In case schema.sql has not been run since this column was added.
alter table public.profiles add column if not exists notify jsonb not null default '{}'::jsonb;
grant update (display_name, vatsim_cid, notify) on public.profiles to authenticated;

-- Nothing is queued for somebody with no device listening, or who has turned
-- this kind of notification off in Settings.
create or replace function public.notify(
  target uuid, kind text, title text, body text, url text, dedupe text, ttl integer default 3600
)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind, title, body, url, dedupe, ttl)
  select target, kind, title, body, url, dedupe, ttl
  where exists (select 1 from public.push_subscriptions where user_id = target)
    and coalesce((select (notify ->> kind)::boolean from public.profiles where id = target), true)
  on conflict (dedupe) do nothing;
$$;

-- The roster going live.
create or replace function public.notify_roster_published()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  stamp text := to_char(now(), 'YYYYMMDDHH24MI');
  r record;
begin
  if new.roster_state = 'published' and coalesce(old.roster_state, '') <> 'published' then
    for r in
      select ro.user_id, count(*) as sectors, min(s.std) as first_std,
             (array_agg(s.flight order by s.std))[1] as first_flight
      from public.roster ro join public.sectors s on s.id = ro.sector_id
      where s.std > now()
      group by ro.user_id
    loop
      perform public.notify(
        r.user_id, 'roster', 'The roster is published',
        format('You have %s sector%s. The first is %s on %s.', r.sectors, case when r.sectors = 1 then '' else 's' end,
               r.first_flight, to_char(r.first_std, 'DD Mon HH24:MI"Z"')),
        '#/roster', 'published-' || r.user_id || '-' || stamp, 86400
      );
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_published on public.settings;
create trigger notify_published after update on public.settings
  for each row execute function public.notify_roster_published();

-- Somebody's own sectors changing after the roster has gone out.
create or replace function public.notify_roster_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s     record;
  stamp text := to_char(now(), 'YYYYMMDDHH24MI');
  entry public.roster%rowtype;
begin
  if tg_op = 'DELETE' then entry := old; else entry := new; end if;
  if not public.roster_published() then return entry; end if;
  select * into s from public.sectors where id = entry.sector_id;
  if s.id is null or s.std < now() then return entry; end if;

  if tg_op = 'DELETE' then
    perform public.notify(old.user_id, 'roster', 'You are off ' || s.flight,
      format('%s to %s on %s is no longer yours.', s.dep, s.arr, to_char(s.std, 'DD Mon')),
      '#/roster', 'off-' || old.id || '-' || stamp, 86400);
  elsif tg_op = 'INSERT' then
    perform public.notify(new.user_id, 'roster', 'You are rostered on ' || s.flight,
      format('%s to %s as %s. Report %s.', s.dep, s.arr, new.duty, to_char(new.report_at, 'DD Mon HH24:MI"Z"')),
      '#/roster/' || s.id, 'on-' || new.id, 86400);
  elsif new.duty <> old.duty or new.report_at <> old.report_at then
    perform public.notify(new.user_id, 'roster', s.flight || ' has changed',
      format('Now %s, report %s.', new.duty, to_char(new.report_at, 'DD Mon HH24:MI"Z"')),
      '#/roster/' || s.id, 'moved-' || new.id || '-' || stamp, 86400);
  end if;
  return entry;
end;
$$;

drop trigger if exists notify_roster on public.roster;
create trigger notify_roster after insert or update or delete on public.roster
  for each row execute function public.notify_roster_change();

-- Report reminders. A delay no longer moves anybody's report time by itself,
-- so there is nothing to tell a pilot about here beyond the reminder itself:
-- the ops controller decides a move (supabase/report-shifts.sql) and changing
-- the roster entry is what tells them.
--
-- Called every ten seconds by the job at the bottom.
create or replace function public.notify_due()
returns integer language plpgsql security definer set search_path = public as $$
declare
  team_lead integer;
  lead      integer;
  r         record;
  made      integer := 0;
begin
  if not public.roster_published() then return 0; end if;
  select round(coalesce((rules ->> 'reportReminderMinutes')::numeric, 90))::integer
    into team_lead from public.settings limit 1;
  team_lead := coalesce(team_lead, 90);

  for r in
    select rt.*, p.notify
    from public.report_times rt
    join public.profiles p on p.id = rt.user_id
    where rt.due_at between now() and now() + interval '24 hours'
  loop
    -- Each person may want more or less warning than the team's default.
    lead := coalesce(round((r.notify ->> 'reportMinutes')::numeric)::integer, team_lead);
    if lead > 0 and r.due_at between now() and now() + make_interval(mins => lead) then
      perform public.notify(
        r.user_id,
        'report',
        format('Report at %s for %s', to_char(r.due_at, 'HH24:MI"Z"'), r.flight),
        format('%s to %s as %s, in about %s minutes.', r.dep, r.arr, r.duty,
               round(extract(epoch from (r.due_at - now())) / 60)),
        '#/roster/' || r.sector_id,
        'report-' || r.roster_id,
        7200
      );
      made := made + 1;
    end if;
  end loop;
  return made;
end;
$$;

-- ---------- Sending ----------

-- Builds whatever is due, then asks the send-push function to deliver
-- everything waiting. Runs every ten seconds (see the job at the bottom).
--
-- With nothing waiting it costs about ten milliseconds and never calls out to
-- anything, which is what makes running it that often reasonable.
create or replace function public.push_tick()
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg      record;
  waiting  integer;
  answer   extensions.http_response;
begin
  perform public.notify_due();
  -- The report-time proposals the ops board works from. Its own file, so a
  -- project that has not been given supabase/report-shifts.sql yet simply
  -- carries on without them.
  begin
    perform public.raise_report_shifts();
  exception when undefined_function then
    null;
  end;
  select count(*) into waiting from public.notifications where sent_at is null;
  if waiting = 0 then return 'nothing waiting'; end if;

  select * into cfg from public.push_config where id;
  if cfg.edge_url like '%YOUR-PROJECT%' or cfg.vapid_private in ('', 'PASTE-THE-PRIVATE-KEY-HERE') then
    return 'push is not set up yet: fill in the three lines at the top of supabase/notifications.sql';
  end if;

  -- A function that has gone cold takes a few seconds to wake up, and the
  -- default here is five. Each cron run gets a fresh session, so this is set
  -- every time.
  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '25000');
    perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS', '10000');
  exception when others then
    null;  -- an older http extension without this; the default timeout applies
  end;

  select * into answer from extensions.http((
    'POST',
    cfg.edge_url,
    case
      when cfg.auth_key = '' then array[extensions.http_header('x-push-secret', cfg.secret)]
      else array[
        extensions.http_header('x-push-secret', cfg.secret),
        extensions.http_header('Authorization', 'Bearer ' || cfg.auth_key),
        extensions.http_header('apikey', cfg.auth_key)
      ]
    end,
    'application/json',
    '{}'
  )::extensions.http_request);
  return format('%s waiting, send-push said %s %s', waiting, answer.status, left(answer.content, 200));
exception when others then
  return 'could not reach send-push: ' || sqlerrm;
end;
$$;

revoke all on function public.push_tick(), public.notify_due(), public.sector_running() from public, anon, authenticated;
grant execute on function public.sector_running() to authenticated;

-- Every ten seconds rather than every minute: a report reminder does not care,
-- but a question from the flight deck in the ops chat does, and waiting up to
-- a minute for it made the chat feel broken. pg_cron takes a plain interval
-- like this from version 1.5, and will not start a run while the last one is
-- still going, so a slow send cannot pile up behind itself.
--
-- On pg_cron 1.4 or older, '10 seconds' is rejected; put '* * * * *' back.
select cron.unschedule('push-tick') where exists (select 1 from cron.job where jobname = 'push-tick');
select cron.schedule('push-tick', '10 seconds', $job$ select public.push_tick() $job$);

-- Old notifications are no use to anybody after a week.
select cron.unschedule('push-tidy') where exists (select 1 from cron.job where jobname = 'push-tidy');
select cron.schedule('push-tidy', '40 3 * * *',
  $job$ delete from public.notifications where created_at < now() - interval '7 days' $job$);

-- Run it once now and see what it says.
select public.push_tick();

-- ---------- If notifications are not arriving ----------
-- Run these three and read them together.
--
--   1. Is everything filled in, and does the app's key match the database's?
select vapid_private not in ('', 'PASTE-THE-PRIVATE-KEY-HERE') as private_key_set,
       edge_url <> '' and edge_url not like '%YOUR-PROJECT%'   as function_url_set,
       secret not in ('', 'PICK-ANY-LONG-RANDOM-STRING')       as secret_set,
       left(vapid_public, 12) || '...'                         as public_key_starts,
       edge_url
from public.push_config;

--   2. Has anybody turned notifications on, and where do they go?
select p.display_name, s.label, left(s.endpoint, 45) || '...' as sent_to, s.created_at
from public.push_subscriptions s join public.profiles p on p.id = s.user_id;

--   3. What happened to the last few messages?
select id, kind, title, created_at, sent_at, tries, error
from public.notifications order by id desc limit 10;

--   To have another go at the last few, whatever happened to them:
--     update public.notifications set sent_at = null, tries = 0
--     where id in (select id from public.notifications order by id desc limit 5);
--     select public.push_tick();
