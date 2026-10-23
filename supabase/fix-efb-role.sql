-- Run in the Supabase SQL Editor after schema.sql and operations-role.sql.
-- Safe to run again. Restores the First Officer tablet after a role test and
-- lets admins select EFB tablet again through Admin > People.
begin;

create or replace function public.set_role(target uuid, new_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can change roles';
  end if;
  if new_role not in ('pending', 'admin', 'dispatcher', 'operations', 'pilot', 'observer', 'efb') then
    raise exception 'Unknown role';
  end if;
  if target = auth.uid() and new_role <> 'admin' then
    raise exception 'You cannot remove your own admin role';
  end if;
  if new_role = 'admin' and exists (select 1 from public.profiles where id = target and is_test) then
    raise exception 'A test account cannot be an admin';
  end if;
  update public.profiles set role = new_role where id = target;
end;
$$;

revoke execute on function public.set_role(uuid, text) from anon, public;
grant execute on function public.set_role(uuid, text) to authenticated;

update public.profiles
set role = 'efb'
where id in (
  select id from auth.users where email = 'first_officer@qfa100.efb'
);

commit;

-- Verify that the tablet account now has the efb role.
select u.email, p.display_name, p.role
from auth.users u
join public.profiles p on p.id = u.id
where u.email = 'first_officer@qfa100.efb';
