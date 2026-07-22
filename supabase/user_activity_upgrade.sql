begin;

alter table public.approved_users
  add column if not exists last_active_at timestamptz;

update public.approved_users au
set last_active_at = users.last_sign_in_at
from auth.users users
where lower(users.email) = lower(au.email)
  and au.last_active_at is null
  and users.last_sign_in_at is not null;

create or replace function public.record_current_user_activity()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  current_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  recorded_at timestamptz;
begin
  if current_email = '' then
    raise exception 'Not authenticated';
  end if;

  update public.approved_users
  set last_active_at = now()
  where lower(email) = current_email
    and not coalesce(is_locked, false)
  returning last_active_at into recorded_at;

  return recorded_at;
end;
$$;

revoke all on function public.record_current_user_activity() from public;
grant execute on function public.record_current_user_activity() to authenticated;

create or replace function public.admin_list_approved_user_activity()
returns table (
  email text,
  last_active_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
stable
as $$
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  select
    lower(au.email)::text,
    greatest(au.last_active_at, users.last_sign_in_at)
  from public.approved_users au
  left join auth.users users on lower(users.email) = lower(au.email)
  order by greatest(au.last_active_at, users.last_sign_in_at) desc nulls last, au.email;
end;
$$;

revoke all on function public.admin_list_approved_user_activity() from public;
grant execute on function public.admin_list_approved_user_activity() to authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
