-- The team's own normal checklists: the Preflight-to-Secure list the flight
-- deck taps through every sector, edited in the app on the Checklists page.
--
-- An empty table means the team has not changed anything and every device
-- uses the checklists the app ships with (js/data/checklists.js). The first
-- save writes the whole list, so from then on this table is what the team
-- flies and the bundled set is only the starting point.
--
-- Non-normal checklists are not here and are not editable: they are the
-- extracted QRH, with their own numbering, branches and jumps between
-- procedures, and are not a team's to reword.
--
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.

create table if not exists public.normal_checklists (
  id         text primary key,
  name       text not null,
  position   integer not null default 0,
  items      jsonb not null default '[]'::jsonb, -- [["Challenge", "Response"], ...]
  updated_at timestamptz not null default now()
);

alter table public.normal_checklists enable row level security;
revoke all on public.normal_checklists from anon;
-- Read-only to everyone signed in. The list is written only through
-- set_normal_checklists below, which is the one place admin is checked.
grant select on public.normal_checklists to authenticated;

drop policy if exists "members read normal checklists" on public.normal_checklists;
create policy "members read normal checklists" on public.normal_checklists
  for select to authenticated using (public.is_member());

-- Replaces the whole list in one go, so reordering, renaming, adding and
-- deleting cannot half-apply and leave two checklists claiming one position.
-- Admins only: a dispatcher builds the roster, but the checklists the crew
-- reads out are the team's procedures and are an admin's to change.
create or replace function public.set_normal_checklists(payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change the normal checklists';
  end if;
  if jsonb_typeof(payload) <> 'array' then
    raise exception 'Expected a list of checklists';
  end if;
  if jsonb_array_length(payload) = 0 then
    raise exception 'Keep at least one normal checklist';
  end if;

  -- Replace rather than merge: the app always sends the whole list, so a
  -- checklist missing from it is one the admin deleted. Position comes from
  -- the order they arrive in, which is the order the flight deck flies them.
  delete from public.normal_checklists;
  insert into public.normal_checklists (id, name, position, items, updated_at)
  select
    coalesce(trim(entry ->> 'id'), ''),
    coalesce(trim(entry ->> 'name'), ''),
    ord,
    coalesce(entry -> 'items', '[]'::jsonb),
    now()
  from jsonb_array_elements(payload) with ordinality as listed(entry, ord);

  -- Checked after the insert rather than before: it is all one transaction,
  -- so raising here rolls the replacement back and the team keeps the list
  -- it had.
  if exists (select 1 from public.normal_checklists where id = '' or name = '') then
    raise exception 'Every checklist needs an id and a name';
  end if;
  if exists (select 1 from public.normal_checklists where jsonb_typeof(items) <> 'array') then
    raise exception 'A checklist''s items must be a list';
  end if;
end;
$$;

revoke all on function public.set_normal_checklists(jsonb) from anon;
grant execute on function public.set_normal_checklists(jsonb) to authenticated;
