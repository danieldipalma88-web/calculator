create table if not exists public.approved_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now()
);

alter table public.approved_users enable row level security;

drop policy if exists "approved users can read own approval" on public.approved_users;
create policy "approved users can read own approval"
on public.approved_users
for select
to authenticated
using (lower(email) = lower((auth.jwt() ->> 'email')));

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
  );
$$;

revoke all on function public.is_approved_admin() from public;
grant execute on function public.is_approved_admin() to authenticated;

create or replace function public.admin_upsert_approved_user(
  target_email text,
  target_role text default 'user'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(target_email, '')));
  normalized_role text := case when target_role = 'admin' then 'admin' else 'user' end;
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  if normalized_email = '' then
    raise exception 'Email is required';
  end if;

  if normalized_email = 'danieldipalma88@gmail.com' then
    normalized_role := 'admin';
  end if;

  insert into public.approved_users (email, role)
  values (normalized_email, normalized_role)
  on conflict (email) do update set role = excluded.role;
end;
$$;

revoke all on function public.admin_upsert_approved_user(text, text) from public;
grant execute on function public.admin_upsert_approved_user(text, text) to authenticated;

create or replace function public.admin_delete_approved_user(target_email text)
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
    raise exception 'You cannot remove this admin account';
  end if;

  delete from public.approved_users
  where lower(email) = normalized_email;
end;
$$;

revoke all on function public.admin_delete_approved_user(text) from public;
grant execute on function public.admin_delete_approved_user(text) to authenticated;

drop policy if exists "admins can manage approved users" on public.approved_users;
create policy "admins can manage approved users"
on public.approved_users
for all
to authenticated
using (public.is_approved_admin())
with check (public.is_approved_admin());

create table if not exists public.user_calculator_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_calculator_data enable row level security;

drop policy if exists "users can read own calculator data" on public.user_calculator_data;
create policy "users can read own calculator data"
on public.user_calculator_data
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "users can insert own calculator data" on public.user_calculator_data;
create policy "users can insert own calculator data"
on public.user_calculator_data
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "users can update own calculator data" on public.user_calculator_data;
create policy "users can update own calculator data"
on public.user_calculator_data
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create table if not exists public.saved_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  quote_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.saved_quotes enable row level security;

drop policy if exists "users can manage own saved quotes" on public.saved_quotes;
create policy "users can manage own saved quotes"
on public.saved_quotes
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into public.approved_users (email, role)
values ('danieldipalma88@gmail.com', 'admin')
on conflict (email) do update set role = 'admin';
