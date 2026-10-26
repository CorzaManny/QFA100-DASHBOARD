-- Watches the official WorldFlight schedule from inside the database.
--
-- Supabase reads https://planning.worldflight.center/schedule every six hours
-- and keeps a copy in public.official_schedule. Nothing is written to the
-- team's own schedule: the app compares the two and an admin presses the
-- button. Run this once in the SQL Editor, after schema.sql.
--
-- It needs two extensions, both free on Supabase. This file turns them on; if
-- that is not allowed on your plan, turn them on by hand first in
-- Database -> Extensions and search for "http" and "pg_cron".

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

-- ---------- Where the official schedule is kept ----------

-- The published programme, as last read from the WorldFlight site. The team's
-- own sectors live in public.sectors and are never touched by this.
create table if not exists public.official_schedule (
  flight         text primary key,
  dep            text not null,
  arr            text not null,
  std            timestamptz not null,
  sta            timestamptz not null,
  dep_window_min integer,
  route          text not null default ''
);

-- Some sectors are published twice: WorldFlight offers two ways round and the
-- team flies one of them. The unsuffixed row is option A and goes in the
-- columns above; the ".B" row beside it is option B and goes in these. Null
-- means that sector has only one route. See supabase/route-options.sql.
alter table public.official_schedule add column if not exists alt_dep text;
alter table public.official_schedule add column if not exists alt_arr text;
alter table public.official_schedule add column if not exists alt_route text not null default '';

-- One row saying when the check last ran and whether it worked, so the app can
-- say "checked 20 minutes ago" and show a problem rather than going quiet.
create table if not exists public.official_schedule_check (
  id         boolean primary key default true check (id),
  checked_at timestamptz not null default now(),
  ok         boolean not null default false,
  sectors    integer not null default 0,
  note       text not null default ''
);
insert into public.official_schedule_check (id) values (true) on conflict (id) do nothing;

alter table public.official_schedule enable row level security;
alter table public.official_schedule_check enable row level security;
revoke all on public.official_schedule, public.official_schedule_check from anon;
grant select on public.official_schedule, public.official_schedule_check to authenticated;

-- Everyone on the team reads it; only the job below writes it.
drop policy if exists "members read official schedule" on public.official_schedule;
create policy "members read official schedule" on public.official_schedule
  for select to authenticated using (public.is_member());

drop policy if exists "members read official schedule check" on public.official_schedule_check;
create policy "members read official schedule check" on public.official_schedule_check
  for select to authenticated using (public.is_member());

-- ---------- Reading the page ----------

-- Turns %20 and + in a link back into spaces. The routes are plain ASCII, so
-- this does not deal with multi-byte characters.
create or replace function public.url_decode(input text)
returns text language sql immutable as $$
  select coalesce(
    string_agg(
      case
        when n > 1 and part ~ '^[0-9A-Fa-f]{2}'
        then chr(('x' || substring(part, 1, 2))::bit(8)::int) || substring(part, 3)
        else part
      end,
      '' order by n
    ),
    ''
  )
  from unnest(string_to_array(replace(input, '+', ' '), '%')) with ordinality as t (part, n);
$$;

-- Reads the schedule page and replaces public.official_schedule with what it
-- says. Returns how many sectors were read. A failure is recorded rather than
-- raised, so a bad afternoon on the WorldFlight site does not fill the logs;
-- the app shows the problem on the Schedule page.
create or replace function public.refresh_official_schedule(
  source text default 'https://planning.worldflight.center/schedule'
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  months constant text[] := array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  page    text;
  chunk   text;
  sector  text[];
  window_ text[];
  link    text[];
  flight_ text;     -- the sector number with any ".A"/".B" suffix taken off
  variant text;     -- 'A' (the row as published) or 'B' (the alternative)
  year_   integer;
  month_  integer;
  open_   integer;   -- minutes past midnight the departure window opens
  shut_   integer;   -- ...and closes
  wide    integer;   -- how long it stays open
  std_    timestamptz;
  found   integer := 0;   -- how many sectors the page gave us
begin
  page := (extensions.http_get(source)).content;
  if page is null or length(page) < 2000 then
    raise exception 'the schedule page came back empty';
  end if;

  -- "WorldFlight 2026 will take place between ..." in the banner.
  year_ := coalesce(
    (regexp_match(page, 'WorldFlight (20[0-9][0-9]) will take place'))[1]::integer,
    extract(year from now())::integer
  );

  drop table if exists pg_temp.wf_new;
  create temporary table pg_temp.wf_new (like public.official_schedule including all) on commit drop;

  -- The ".B" rows, held aside and attached to their own sector after the loop,
  -- so the order the page happens to list them in does not matter.
  drop table if exists pg_temp.wf_alt;
  create temporary table pg_temp.wf_alt (
    flight text primary key, dep text, arr text, route text
  ) on commit drop;

  -- One table row per sector; everything needed is in the details button and
  -- the departure window beside it.
  foreach chunk in array string_to_array(page, '<tr ')
  loop
    -- A sector with an alternative (two ways round the same pair of airports)
    -- is published twice: the unsuffixed row, and a second suffixed ".B", e.g.
    -- "WF2619.B". Both are read - the suffix is in the character class - and
    -- the ".B" one is kept aside below as that sector's option B.
    sector := regexp_match(
      chunk,
      'data-from="([A-Z0-9]{4})" data-to="([A-Z0-9]{4})" data-wf="([A-Za-z0-9.]+)" ' ||
      'data-date="[A-Za-z]+ ([0-9]{1,2})[a-z]* ([A-Za-z]{3})" ' ||
      'data-dep="([0-9]{2}):([0-9]{2})" data-block="([0-9]{2}):([0-9]{2})"'
    );
    continue when sector is null;

    -- The window used to sit right after window-tt">; it is now the text of a
    -- nested span, so it is read from that span's own data-utc attribute instead.
    window_ := regexp_match(chunk, 'data-kind="window" data-utc="([0-9]{2}):([0-9]{2})[^0-9]+([0-9]{2}):([0-9]{2})"');
    continue when window_ is null;

    month_ := array_position(months, initcap(sector[5]));
    continue when month_ is null;

    -- "WF2619.B" is option B of WF2619. A page that ever labelled the first
    -- choice ".A" rather than leaving it bare is read the same way.
    flight_ := sector[3];
    variant := 'A';
    if flight_ ~ '\.B$' then
      variant := 'B';
      flight_ := left(flight_, -2);
    elsif flight_ ~ '\.A$' then
      flight_ := left(flight_, -2);
    end if;

    -- The page publishes a window rather than a departure time, and data-dep
    -- is the middle of it, so the window opens half its length earlier.
    open_ := window_[1]::integer * 60 + window_[2]::integer;
    shut_ := window_[3]::integer * 60 + window_[4]::integer;
    wide := mod(shut_ - open_ + 1440, 1440);
    std_ := make_timestamptz(year_, month_, sector[4]::integer, sector[6]::integer, sector[7]::integer, 0, 'UTC')
            - make_interval(mins => wide / 2);

    link := regexp_match(chunk, 'simbrief\.com/options/custom\?[^"]*route=([^&"]*)');

    -- Option B flies between different airports at the same times, so only
    -- where it goes and how it gets there is worth keeping.
    if variant = 'B' then
      insert into pg_temp.wf_alt (flight, dep, arr, route)
      values (flight_, sector[1], sector[2], coalesce(public.url_decode(link[1]), ''))
      on conflict (flight) do nothing;
      continue;
    end if;

    insert into pg_temp.wf_new (flight, dep, arr, std, sta, dep_window_min, route)
    values (
      flight_, sector[1], sector[2], std_,
      std_ + make_interval(hours => sector[8]::integer, mins => sector[9]::integer),
      nullif(wide, 0),
      coalesce(public.url_decode(link[1]), '')
    )
    on conflict (flight) do nothing;
  end loop;

  update pg_temp.wf_new n
  set alt_dep = a.dep, alt_arr = a.arr, alt_route = a.route
  from pg_temp.wf_alt a
  where a.flight = n.flight;

  select count(*) into found from pg_temp.wf_new;
  if found = 0 then
    raise exception 'no sectors found on the page; it may have been rebuilt';
  end if;

  insert into public.official_schedule as o
    (flight, dep, arr, std, sta, dep_window_min, route, alt_dep, alt_arr, alt_route)
  select flight, dep, arr, std, sta, dep_window_min, route, alt_dep, alt_arr, alt_route
  from pg_temp.wf_new
  on conflict (flight) do update set
    dep = excluded.dep, arr = excluded.arr, std = excluded.std, sta = excluded.sta,
    dep_window_min = excluded.dep_window_min, route = excluded.route,
    alt_dep = excluded.alt_dep, alt_arr = excluded.alt_arr, alt_route = excluded.alt_route;
  delete from public.official_schedule where flight not in (select flight from pg_temp.wf_new);

  update public.official_schedule_check
  set checked_at = now(), ok = true, sectors = found, note = '';
  return found;

exception when others then
  update public.official_schedule_check
  set checked_at = now(), ok = false, note = left(sqlerrm, 300);
  return 0;
end;
$$;

revoke all on function public.refresh_official_schedule(text) from public, anon, authenticated;

-- ---------- The six-hourly check ----------

select cron.unschedule('worldflight-schedule')
where exists (select 1 from cron.job where jobname = 'worldflight-schedule');

select cron.schedule(
  'worldflight-schedule',
  '20 */6 * * *',
  $job$ select public.refresh_official_schedule() $job$
);

-- Read it now, so the app has the schedule straight away.
select public.refresh_official_schedule() as sectors_read;

-- How it went. ok = false means the note says what stopped it.
select checked_at, ok, sectors, note from public.official_schedule_check;
