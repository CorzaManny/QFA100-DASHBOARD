-- Run after schema.sql. Public website content, separate from login profiles.
begin;
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  role text not null check (length(trim(role)) between 1 and 120),
  description text not null check (length(trim(description)) between 1 and 1000),
  photo_url text not null check (photo_url ~ '^https://'),
  position integer not null default 0 check (position >= 0)
);
alter table public.team_members enable row level security;
grant select on public.team_members to anon, authenticated;
grant insert, update, delete on public.team_members to authenticated;
drop policy if exists "public read team" on public.team_members;
create policy "public read team" on public.team_members for select to anon, authenticated using (true);
drop policy if exists "admins manage team" on public.team_members;
create policy "admins manage team" on public.team_members for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.reorder_team_members(member_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can reorder the team'; end if;
  lock table public.team_members in exclusive mode;
  if member_ids is null
     or cardinality(member_ids) <> (select count(*) from public.team_members)
     or cardinality(member_ids) <> (select count(distinct x) from unnest(member_ids) x)
     or exists (select 1 from unnest(member_ids) x where not exists (select 1 from public.team_members t where t.id = x))
  then raise exception 'Team changed. Reopen the Team tab and try again.'; end if;
  update public.team_members t set position = ordered.n - 1
    from unnest(member_ids) with ordinality as ordered(id, n) where t.id = ordered.id;
end;
$$;
revoke all on function public.reorder_team_members(uuid[]) from public, anon;
grant execute on function public.reorder_team_members(uuid[]) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('team-photos', 'team-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists "admins upload team photos" on storage.objects;
create policy "admins upload team photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'team-photos' and public.is_admin());
commit;
