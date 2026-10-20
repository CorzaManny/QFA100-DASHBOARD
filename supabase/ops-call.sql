-- Calling between the flight deck and the ops desk, inside the app.
--
-- Run after supabase/ops-chat.sql, and after supabase/ops-chat-notify.sql if
-- you want a call to reach a phone with the app shut. Safe to run again.
--
-- There are only two things to set up here. The audio itself goes straight
-- between the two devices and never touches the database.
--
--   1. who is allowed on the channel that carries the handshake
--   2. the notification that tells somebody their app is ringing
--
-- Realtime also has to be switched on for the project: Dashboard ->
-- Project Settings -> Realtime, which it is by default.

-- ---------- Who may carry a handshake ----------
-- The channel is private, so Realtime checks this before letting anybody join
-- it or send on it. Without a policy nobody can, which is the safe default and
-- also why calling does nothing until this file has been run.
--
-- It matters: the publishable key is in js/config.js for anyone to read, so a
-- channel left public would let a stranger listen to the handshake - which
-- carries the addresses of both devices - or ring the cockpit at three in the
-- morning. in_ops_chat() is the same gate the thread itself uses.

grant select, insert on realtime.messages to authenticated;

drop policy if exists "ops chat joins the call channel" on realtime.messages;
create policy "ops chat joins the call channel" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'ops-call' and public.in_ops_chat());

drop policy if exists "ops chat sends call signals" on realtime.messages;
create policy "ops chat sends call signals" on realtime.messages
  for insert to authenticated
  with check (realtime.topic() = 'ops-call' and public.in_ops_chat());

-- ---------- The doorbell ----------
-- Ringing somebody needs their app to be running, which no web app can get
-- around: a closed app cannot be woken the way a phone call wakes a phone.
-- This is the next best thing - a notification saying who is calling, which
-- opens the panel when it is tapped. It goes out on the same ten-second job as
-- everything else, so it lands while the caller is still listening to the ring.
--
-- Returns how many people were told, which is 0 when nobody on the other side
-- has a device set up for notifications.
create or replace function public.ring_ops(call_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  caller_role text;
  caller_name text;
  on_desk     uuid;
  r           record;
  told        integer := 0;
begin
  if not public.in_ops_chat() then
    raise exception 'Only the flight deck and ops staff can call';
  end if;
  select role, coalesce(nullif(btrim(display_name), ''), 'Someone')
    into caller_role, caller_name
    from public.profiles where id = auth.uid();

  if caller_role = 'efb' then
    -- Whoever has the desk, or all the controllers when nobody has it, so a
    -- call is never made to an empty chair.
    on_desk := public.ops_on_desk();
    for r in
      select id from public.profiles
      where role in ('admin', 'dispatcher', 'operations')
        and id <> auth.uid()
        and (on_desk is null or id = on_desk)
    loop
      perform public.notify(
        r.id, 'opscall', 'The flight deck is calling',
        caller_name || ' is calling the ops desk. Open the app to answer.',
        '#/opschat', 'opscall-' || r.id || '-' || call_id, 120
      );
      told := told + 1;
    end loop;
  else
    for r in select id from public.profiles where role = 'efb' and id <> auth.uid() loop
      perform public.notify(
        r.id, 'opscall', 'Ops is calling',
        caller_name || ' is calling the flight deck. Open the app to answer.',
        '#/opschat', 'opscall-' || r.id || '-' || call_id, 120
      );
      told := told + 1;
    end loop;
  end if;
  return told;
exception
  when undefined_function or undefined_table then
    -- supabase/ops-chat-notify.sql has not been run on this database, so there
    -- is nothing to queue a notification with. The call still rings every app
    -- that happens to be open.
    return 0;
end;
$$;

revoke all on function public.ring_ops(uuid) from anon;
grant execute on function public.ring_ops(uuid) to authenticated;

-- A call invite is no use two minutes later, which is what the ttl above says.
-- Nothing else here keeps any record of a call: who rang whom is in nobody's
-- interest to store, and the audio never came near the database.
