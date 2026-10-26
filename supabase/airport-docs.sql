-- WorldFlight's own airport documents, for the airport briefings.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- The teams controlling each destination publish a pilot briefing on the
-- WorldFlight planning site, and often an aerodrome or parking chart with it.
-- They are listed by the site's own API, which does not let a browser read it
-- directly, so the database fetches the list and the app asks the database -
-- the same arrangement as supabase/weather.sql. The documents themselves are
-- plain links the browser opens on its own; nothing is copied here.
--
-- Until this file is run, the briefings simply show no documents.
--
-- Needs the free "http" extension; this file turns it on. If your project will
-- not let it, open Database -> Extensions and search for "http".

create extension if not exists http with schema extensions;

-- One row per airport, holding the list as last read. Documents go up
-- throughout the week leading into the event, so a list is reread once it is
-- two hours old.
create table if not exists public.airport_doc_cache (
  icao       text primary key,
  docs       jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now()
);

alter table public.airport_doc_cache enable row level security;
revoke all on public.airport_doc_cache from anon;
grant select on public.airport_doc_cache to authenticated;
drop policy if exists "members read airport documents" on public.airport_doc_cache;
create policy "members read airport documents" on public.airport_doc_cache
  for select to authenticated using (public.is_member());

-- What WorldFlight publishes for one airport, as a list of
--   { name, url, type, updated, by, scope }
-- newest first. An empty list means nobody has uploaded anything for that
-- airport, which is normal until the controlling team gets to it.
--
-- force skips the two-hour wait, for the refresh button on the briefing; a
-- minute is still kept, so a page left open cannot lean on the site.
--
-- The argument is not called "icao" on purpose: inside the function a name
-- matching a column of airport_doc_cache makes "on conflict (icao)" ambiguous.
drop function if exists public.airport_docs(text);
drop function if exists public.airport_docs(text, boolean);

create or replace function public.airport_docs(icao_code text, force boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  site constant text := 'https://planning.worldflight.center';
  code  text := upper(regexp_replace(coalesce(icao_code, ''), '[^A-Za-z0-9]', '', 'g'));
  hit   public.airport_doc_cache%rowtype;
  body  text;
  found jsonb;
  list  jsonb;
begin
  if not public.is_member() then raise exception 'Only members can read the airport documents'; end if;
  if length(code) <> 4 then raise exception 'Give a four-letter ICAO code'; end if;

  select * into hit from public.airport_doc_cache c where c.icao = code;
  if hit.icao is not null
     and hit.fetched_at > now() - (case when force then interval '1 minute' else interval '2 hours' end) then
    return hit.docs;
  end if;

  begin
    body := (extensions.http_get(site || '/api/icao/' || code || '/docs')).content;
  exception when others then
    -- The site is unreachable. The list read earlier beats nothing at all,
    -- and the app says how old it is.
    return coalesce(hit.docs, '[]'::jsonb);
  end;

  -- An error page is not a list of documents; keep whatever was already known.
  begin
    found := (body::jsonb) -> 'docs';
  exception when others then
    found := null;
  end;
  if found is null or jsonb_typeof(found) <> 'array' then
    return coalesce(hit.docs, '[]'::jsonb);
  end if;

  -- The site gives each document's address as a path; the app wants one it can
  -- open from anywhere. Everything else is passed on as published.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'name', coalesce(d ->> 'filename', 'Document'),
               'url', case when d ->> 'url' ~ '^https?://' then d ->> 'url' else site || (d ->> 'url') end,
               'type', upper(coalesce(d ->> 'type', '')),
               'updated', d ->> 'updated',
               'by', coalesce(d ->> 'submittedBy', ''),
               'scope', coalesce(d ->> 'scopeLabel', '')
             )
             order by d ->> 'updated' desc nulls last
           ),
           '[]'::jsonb
         )
    into list
    from jsonb_array_elements(found) as d
   where nullif(d ->> 'url', '') is not null;

  insert into public.airport_doc_cache (icao, docs, fetched_at) values (code, list, now())
  on conflict (icao) do update set docs = excluded.docs, fetched_at = excluded.fetched_at;
  return list;
end;
$$;

revoke execute on function public.airport_docs(text, boolean) from anon, public;
grant execute on function public.airport_docs(text, boolean) to authenticated;
