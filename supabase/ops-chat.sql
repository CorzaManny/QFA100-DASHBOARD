-- The ops desk: who the operations controller on shift is, and the one chat
-- thread between the flight deck tablets and whoever that is.
-- Run after schema.sql and operations-role.sql in the Supabase SQL Editor.
-- Safe to run again.
--
-- Three things live here:
--   ops_shifts   the roster of who is on the desk and when, kept in Admin
--   ops_desk     one row: who has actually taken the desk, when somebody
--                steps in off the roster
--   ops_messages the thread itself, one shared channel rather than a
--                conversation per tablet, so a controller taking over reads
--                back everything that has been said

-- Who may see and write in the thread: the cockpit tablets and the ops
-- controllers who work the desk. A dispatcher builds the roster and the
-- schedule but does not answer the flight deck, so they are not in it.
-- Deliberately its own function rather than can_log(), so changing who keeps
-- the tech log never quietly changes who reads the chat.
create or replace function public.in_ops_chat()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'operations', 'efb')
  );
$$;

-- ---------- The shift roster ----------

create table if not exists public.ops_shifts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  notes      text not null default '',
  created_at timestamptz not null default now(),
  constraint ops_shifts_order check (ends_at > starts_at)
);

create index if not exists ops_shifts_starts_at_idx on public.ops_shifts (starts_at);

alter table public.ops_shifts enable row level security;
revoke all on public.ops_shifts from anon;
grant select, insert, update, delete on public.ops_shifts to authenticated;

-- The flight deck reads it, to know who should be answering. Only ops staff
-- build it, which is why there is no page for it outside Admin.
drop policy if exists "ops chat reads shifts" on public.ops_shifts;
create policy "ops chat reads shifts" on public.ops_shifts
  for select to authenticated using (public.in_ops_chat());

drop policy if exists "ops staff write shifts" on public.ops_shifts;
create policy "ops staff write shifts" on public.ops_shifts
  for all to authenticated using (public.can_edit()) with check (public.can_edit());

-- ---------- The desk as it actually is ----------
-- The roster says who should be on; this says who has picked it up when that
-- is somebody else. One row, like settings.

create table if not exists public.ops_desk (
  id       smallint primary key default 1,
  user_id  uuid references public.profiles (id) on delete set null,
  taken_at timestamptz,
  constraint ops_desk_single check (id = 1)
);

insert into public.ops_desk (id) values (1) on conflict (id) do nothing;

alter table public.ops_desk enable row level security;
revoke all on public.ops_desk from anon;
grant select on public.ops_desk to authenticated;

drop policy if exists "ops chat reads the desk" on public.ops_desk;
create policy "ops chat reads the desk" on public.ops_desk
  for select to authenticated using (public.in_ops_chat());

-- Taking it and handing it back go through these, so the row can only ever
-- say that the person who pressed the button has it.
create or replace function public.take_ops_desk()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then
    raise exception 'Only ops staff can take the ops desk';
  end if;
  update public.ops_desk set user_id = auth.uid(), taken_at = now() where id = 1;
end;
$$;

-- Back to whatever the roster says. Anyone on the desk may hand it back, and
-- so may another controller if the last one has gone to bed without doing it.
create or replace function public.release_ops_desk()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then
    raise exception 'Only ops staff can hand the ops desk back';
  end if;
  update public.ops_desk set user_id = null, taken_at = null where id = 1;
end;
$$;

revoke all on function public.take_ops_desk() from anon;
revoke all on function public.release_ops_desk() from anon;
grant execute on function public.take_ops_desk() to authenticated;
grant execute on function public.release_ops_desk() to authenticated;

-- ---------- The thread ----------

create table if not exists public.ops_messages (
  id      uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  -- Nullable, and set null if the account goes: a message stays readable
  -- after somebody leaves the team, under the name it was sent with.
  user_id uuid references public.profiles (id) on delete set null,
  sender  text not null default '',
  body    text not null,
  constraint ops_messages_body check (btrim(body) <> '' and length(body) <= 2000)
);

create index if not exists ops_messages_sent_at_idx on public.ops_messages (sent_at desc);

-- Who sent it and when are stamped by the database from the account that sent
-- it, so a message cannot be signed with somebody else's name or back-dated.
create or replace function public.stamp_ops_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.sent_at := now();
  select coalesce(display_name, '') into new.sender from public.profiles where id = auth.uid();
  return new;
end;
$$;

drop trigger if exists stamp_ops_message on public.ops_messages;
create trigger stamp_ops_message before insert on public.ops_messages
  for each row execute function public.stamp_ops_message();

alter table public.ops_messages enable row level security;
revoke all on public.ops_messages from anon;
grant select, insert, delete on public.ops_messages to authenticated;

drop policy if exists "ops chat reads the thread" on public.ops_messages;
create policy "ops chat reads the thread" on public.ops_messages
  for select to authenticated using (public.in_ops_chat());

drop policy if exists "ops chat writes the thread" on public.ops_messages;
create policy "ops chat writes the thread" on public.ops_messages
  for insert to authenticated with check (public.in_ops_chat() and user_id = auth.uid());

-- Nobody edits what was said. An admin can delete, for tidying up.
drop policy if exists "admins clear the thread" on public.ops_messages;
create policy "admins clear the thread" on public.ops_messages
  for delete to authenticated using (public.is_admin());
