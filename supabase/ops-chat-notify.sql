-- Notifications for the ops chat: a message from the flight deck reaches the
-- controller on shift even with the app shut, and a message from ops reaches
-- the cockpit tablets.
--
-- Run after supabase/ops-chat.sql and supabase/notifications.sql, both of
-- which this needs. Safe to run again.
--
-- A notification only goes to somebody who has turned notifications on for a
-- device (Settings -> Notifications) and has not switched the ops chat off,
-- which public.notify() takes care of. Sending rides the same job as
-- everything else, which runs every ten seconds, so that is about how long a
-- message takes to arrive.

-- Who should be answering right now, in the database's own words. This mirrors
-- opsOnShift() in js/ops.js: somebody who has taken the desk off the roster
-- holds it until they hand it back, or until the next rostered shift begins.
create or replace function public.ops_on_desk()
returns uuid language sql stable security definer set search_path = public as $$
  with desk as (
    select user_id, taken_at from public.ops_desk
    where id = 1 and user_id is not null and taken_at is not null
  )
  select coalesce(
    (
      select d.user_id from desk d
      where not exists (
        select 1 from public.ops_shifts s
        where s.starts_at > d.taken_at and s.starts_at <= now()
      )
    ),
    (
      select user_id from public.ops_shifts
      where starts_at <= now() and now() < ends_at
      order by starts_at desc
      limit 1
    )
  );
$$;

revoke all on function public.ops_on_desk() from anon;
grant execute on function public.ops_on_desk() to authenticated;

-- At most one notification per person per half minute, however much is being
-- said: a burst of three should buzz a phone once, not three times, while a
-- follow-up thirty seconds later - which is usually the one that matters - is
-- still heard. The dedupe key is what does it: public.notify() drops anything
-- repeating a key it has already queued, so the window is simply how coarse
-- that key is.
create or replace function public.notify_ops_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  sender_role text;
  stamp       text := to_char(now(), 'YYYYMMDDHH24MI')
                      || case when extract(second from now()) < 30 then 'a' else 'b' end;
  preview     text;
  who         text;
  on_desk     uuid;
  r           record;
begin
  select role into sender_role from public.profiles where id = new.user_id;
  if sender_role is null then return new; end if;

  -- One line of it: enough to know whether it can wait for the kettle.
  preview := left(regexp_replace(coalesce(new.body, ''), '\s+', ' ', 'g'), 140);
  who := coalesce(nullif(btrim(new.sender), ''), 'Someone');

  if sender_role = 'efb' then
    -- The flight deck is asking. It goes to whoever has the desk, and to
    -- every controller when nobody has it, so a question is never left with
    -- nobody's name on it. Only the roles that have the panel to answer in.
    on_desk := public.ops_on_desk();
    for r in
      select id from public.profiles
      where role in ('admin', 'operations')
        and id <> new.user_id
        and (on_desk is null or id = on_desk)
    loop
      perform public.notify(
        r.id, 'opschat', 'Flight deck · ' || who, preview, '#/opschat',
        'opschat-' || r.id || '-' || stamp, 3600
      );
    end loop;
  else
    -- Ops is answering, so both tablets hear it: either seat may have asked.
    for r in select id from public.profiles where role = 'efb' and id <> new.user_id loop
      perform public.notify(
        r.id, 'opschat', 'Ops · ' || who, preview, '#/opschat',
        'opschat-' || r.id || '-' || stamp, 3600
      );
    end loop;
  end if;
  return new;
exception when others then
  -- A message must never fail to send because a notification could not be
  -- queued - notifications.sql may not have been run on this database at all.
  return new;
end;
$$;

drop trigger if exists notify_ops_message on public.ops_messages;
create trigger notify_ops_message after insert on public.ops_messages
  for each row execute function public.notify_ops_message();
