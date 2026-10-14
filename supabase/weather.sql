-- TAFs for the airport briefings.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- The forecast comes from the United States government aviation weather
-- service, which covers the whole world but does not allow a browser to read
-- it directly. So the database fetches it instead and the app asks the
-- database, the same way supabase/worldflight.sql reads the WorldFlight site.
-- Until this file is run, the airport pages simply show no TAF.
--
-- Needs the free "http" extension; this file turns it on. If your project will
-- not let it, open Database -> Extensions and search for "http".

create extension if not exists http with schema extensions;

-- One row per airport. A forecast is reread when it is older than 15 minutes,
-- so a busy briefing page does not hammer the source.
create table if not exists public.taf_cache (
  icao       text primary key,
  raw        text not null default '',
  fetched_at timestamptz not null default now()
);

alter table public.taf_cache enable row level security;
revoke all on public.taf_cache from anon;
grant select on public.taf_cache to authenticated;
drop policy if exists "members read tafs" on public.taf_cache;
create policy "members read tafs" on public.taf_cache
  for select to authenticated using (public.is_member());

-- The current TAF for one airport, as published. An empty string means the
-- airport does not issue one, which is normal at small fields.
--
-- The argument is deliberately not called "icao": inside the function a name
-- that matches a column of taf_cache makes "on conflict (icao)" ambiguous.
drop function if exists public.taf(text);

create or replace function public.taf(icao_code text)
returns text language plpgsql security definer
set search_path = public, extensions as $$
declare
  code text := upper(regexp_replace(coalesce(icao_code, ''), '[^A-Za-z0-9]', '', 'g'));
  hit  public.taf_cache%rowtype;
  body text;
begin
  if not public.is_member() then raise exception 'Only members can read the weather'; end if;
  if length(code) <> 4 then raise exception 'Give a four-letter ICAO code'; end if;

  select * into hit from public.taf_cache t where t.icao = code;
  if hit.icao is not null and hit.fetched_at > now() - interval '15 minutes' then
    return hit.raw;
  end if;

  begin
    body := (extensions.http_get('https://aviationweather.gov/api/data/taf?format=raw&ids=' || code)).content;
  exception when others then
    -- The source is unreachable. The forecast read earlier beats nothing at
    -- all, and the app says how old it is.
    return coalesce(hit.raw, '');
  end;

  body := btrim(coalesce(body, ''));
  -- An error page is not a forecast; keep whatever was already known.
  if body = '' or body !~ '^TAF' then
    body := coalesce(hit.raw, '');
  end if;

  insert into public.taf_cache (icao, raw, fetched_at) values (code, body, now())
  on conflict (icao) do update set raw = excluded.raw, fetched_at = excluded.fetched_at;
  return body;
end;
$$;

revoke execute on function public.taf(text) from anon, public;
grant execute on function public.taf(text) to authenticated;
