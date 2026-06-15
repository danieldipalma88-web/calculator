-- Data safety upgrade.
-- Run this once in Supabase SQL Editor to keep server-side backups before calculator data changes.

create table if not exists public.user_calculator_data_backups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text,
  data jsonb not null default '{}'::jsonb,
  source text not null default 'before_update',
  created_at timestamptz not null default now()
);

alter table public.user_calculator_data_backups enable row level security;

drop policy if exists "admins can read calculator data backups" on public.user_calculator_data_backups;
create policy "admins can read calculator data backups"
on public.user_calculator_data_backups
for select
to authenticated
using (public.is_approved_admin());

create or replace function public.backup_user_calculator_data()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.data is distinct from new.data then
    insert into public.user_calculator_data_backups (user_id, email, data, source)
    values (old.user_id, old.email, old.data, 'before_update');
  elsif tg_op = 'DELETE' then
    insert into public.user_calculator_data_backups (user_id, email, data, source)
    values (old.user_id, old.email, old.data, 'before_delete');
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists user_calculator_data_backup_before_change on public.user_calculator_data;
create trigger user_calculator_data_backup_before_change
before update or delete on public.user_calculator_data
for each row
execute function public.backup_user_calculator_data();

select pg_notify('pgrst', 'reload schema');
