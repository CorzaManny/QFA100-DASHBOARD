-- The stream: the team's Twitch channel, and the things worth talking about.
-- Run after schema.sql in the Supabase SQL Editor. Safe to run again.
--
-- The channel is the Twitch name on its own, not the whole address: for
-- twitch.tv/qantas100 it is qantas100. Topics are one per line, and the crew
-- on the flight deck see them beside the chat.

alter table public.settings add column if not exists twitch_channel text not null default '';
alter table public.settings add column if not exists stream_topics text not null default '';
