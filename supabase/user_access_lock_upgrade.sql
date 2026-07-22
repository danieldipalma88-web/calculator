begin;

alter table public.approved_users
  add column if not exists is_locked boolean not null default false;

create or replace function public.is_approved_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'danieldipalma88@gmail.com'
    or exists (
      select 1
      from public.approved_users
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        and role = 'admin'
        and not coalesce(is_locked, false)
    );
$$;

revoke all on function public.is_approved_admin() from public;
grant execute on function public.is_approved_admin() to authenticated;

create or replace function public.admin_set_approved_user_lock(
  target_email text,
  target_locked boolean default true
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(target_email, '')));
  current_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  if normalized_email = '' then
    raise exception 'Email is required';
  end if;

  if normalized_email = current_email or normalized_email = 'danieldipalma88@gmail.com' then
    raise exception 'You cannot lock this platform admin account';
  end if;

  update public.approved_users
  set is_locked = coalesce(target_locked, true)
  where lower(email) = normalized_email;

  if not found then
    raise exception 'Approved user not found';
  end if;
end;
$$;

revoke all on function public.admin_set_approved_user_lock(text, boolean) from public;
grant execute on function public.admin_set_approved_user_lock(text, boolean) to authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
