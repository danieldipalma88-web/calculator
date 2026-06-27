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

drop function if exists public.admin_list_approved_users();
create or replace function public.admin_list_approved_users()
returns table (
  email text,
  role text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  select au.email, au.role, au.created_at
  from public.approved_users au
  order by au.created_at desc;
end;
$$;

revoke all on function public.admin_list_approved_users() from public;
grant execute on function public.admin_list_approved_users() to authenticated;

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

-- Multi-business access and commission structure upgrade
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  commission_type text not null default 'none',
  agency_commission_rate numeric not null default 25,
  salesperson_commission_rate numeric not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.businesses enable row level security;

alter table public.businesses drop constraint if exists businesses_commission_type_check;
alter table public.businesses
  add constraint businesses_commission_type_check
  check (commission_type in ('none', 'standard', 'agency'));

alter table public.businesses drop constraint if exists businesses_agency_commission_rate_check;
alter table public.businesses
  add constraint businesses_agency_commission_rate_check
  check (agency_commission_rate >= 0 and agency_commission_rate <= 100);

alter table public.businesses drop constraint if exists businesses_salesperson_commission_rate_check;
alter table public.businesses
  add constraint businesses_salesperson_commission_rate_check
  check (salesperson_commission_rate >= 0 and salesperson_commission_rate <= 100);

alter table public.approved_users drop constraint if exists approved_users_role_check;
alter table public.approved_users
  add constraint approved_users_role_check
  check (role in ('admin', 'business_owner', 'agency', 'salesperson', 'user'));

alter table public.approved_users
  add column if not exists business_id uuid references public.businesses(id) on delete set null,
  add column if not exists display_name text,
  add column if not exists commission_type_override text,
  add column if not exists agency_commission_rate_override numeric,
  add column if not exists salesperson_commission_rate_override numeric;

alter table public.approved_users drop constraint if exists approved_users_commission_type_override_check;
alter table public.approved_users
  add constraint approved_users_commission_type_override_check
  check (commission_type_override is null or commission_type_override in ('none', 'standard', 'agency'));

alter table public.approved_users drop constraint if exists approved_users_agency_commission_rate_override_check;
alter table public.approved_users
  add constraint approved_users_agency_commission_rate_override_check
  check (agency_commission_rate_override is null or (agency_commission_rate_override >= 0 and agency_commission_rate_override <= 100));

alter table public.approved_users drop constraint if exists approved_users_salesperson_commission_rate_override_check;
alter table public.approved_users
  add constraint approved_users_salesperson_commission_rate_override_check
  check (salesperson_commission_rate_override is null or (salesperson_commission_rate_override >= 0 and salesperson_commission_rate_override <= 100));

alter table public.user_calculator_data
  add column if not exists email text;

create unique index if not exists user_calculator_data_email_unique
on public.user_calculator_data (lower(email))
where email is not null;

insert into public.businesses (name, commission_type, agency_commission_rate, salesperson_commission_rate)
values ('Green Energy Climate Control', 'agency', 25, 50)
on conflict (name) do nothing;

update public.approved_users au
set business_id = b.id
from public.businesses b
where au.business_id is null
  and b.name = 'Green Energy Climate Control';

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

drop policy if exists "approved users can read assigned business" on public.businesses;
create policy "approved users can read assigned business"
on public.businesses
for select
to authenticated
using (
  public.is_approved_admin()
  or exists (
    select 1
    from public.approved_users au
    where au.business_id = businesses.id
      and lower(au.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

drop policy if exists "admins can manage businesses" on public.businesses;
create policy "admins can manage businesses"
on public.businesses
for all
to authenticated
using (public.is_approved_admin())
with check (public.is_approved_admin());

drop policy if exists "admins can read calculator data" on public.user_calculator_data;
create policy "admins can read calculator data"
on public.user_calculator_data
for select
to authenticated
using (public.is_approved_admin());

drop policy if exists "admins can update calculator data" on public.user_calculator_data;
create policy "admins can update calculator data"
on public.user_calculator_data
for update
to authenticated
using (public.is_approved_admin())
with check (public.is_approved_admin());

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

drop function if exists public.admin_upsert_approved_user(text, text);
drop function if exists public.admin_upsert_approved_user(text, text, uuid, text, numeric, numeric);
drop function if exists public.admin_upsert_approved_user(text, text, text, uuid, text, numeric, numeric);
create or replace function public.admin_upsert_approved_user(
  target_email text,
  target_role text default 'user',
  target_display_name text default '',
  target_business_id uuid default null,
  target_commission_type_override text default null,
  target_agency_commission_rate_override numeric default null,
  target_salesperson_commission_rate_override numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(coalesce(target_email, '')));
  normalized_display_name text := nullif(trim(coalesce(target_display_name, '')), '');
  normalized_role text := case
    when target_role in ('admin', 'business_owner', 'agency', 'salesperson', 'user') then target_role
    else 'user'
  end;
  normalized_commission_type text := case
    when target_commission_type_override in ('none', 'standard', 'agency') then target_commission_type_override
    else null
  end;
  normalized_agency_rate numeric := case
    when target_agency_commission_rate_override is null then null
    else least(greatest(target_agency_commission_rate_override, 0), 100)
  end;
  normalized_salesperson_rate numeric := case
    when target_salesperson_commission_rate_override is null then null
    else least(greatest(target_salesperson_commission_rate_override, 0), 100)
  end;
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

  insert into public.approved_users (
    email,
    display_name,
    role,
    business_id,
    commission_type_override,
    agency_commission_rate_override,
    salesperson_commission_rate_override
  )
  values (
    normalized_email,
    normalized_display_name,
    normalized_role,
    target_business_id,
    normalized_commission_type,
    normalized_agency_rate,
    normalized_salesperson_rate
  )
  on conflict (email) do update set
    display_name = excluded.display_name,
    role = excluded.role,
    business_id = excluded.business_id,
    commission_type_override = excluded.commission_type_override,
    agency_commission_rate_override = excluded.agency_commission_rate_override,
    salesperson_commission_rate_override = excluded.salesperson_commission_rate_override;
end;
$$;

revoke all on function public.admin_upsert_approved_user(text, text, text, uuid, text, numeric, numeric) from public;
grant execute on function public.admin_upsert_approved_user(text, text, text, uuid, text, numeric, numeric) to authenticated;

drop function if exists public.admin_upsert_business(uuid, text, text, numeric, numeric);
create or replace function public.admin_upsert_business(
  target_business_id uuid default null,
  target_name text default '',
  target_commission_type text default 'none',
  target_agency_commission_rate numeric default 25,
  target_salesperson_commission_rate numeric default 50
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_name text := trim(coalesce(target_name, ''));
  normalized_commission_type text := case
    when target_commission_type in ('none', 'standard', 'agency') then target_commission_type
    else 'none'
  end;
  normalized_agency_rate numeric := least(greatest(coalesce(target_agency_commission_rate, 0), 0), 100);
  normalized_salesperson_rate numeric := least(greatest(coalesce(target_salesperson_commission_rate, 0), 0), 100);
  output_id uuid;
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  if normalized_name = '' then
    raise exception 'Business name is required';
  end if;

  if target_business_id is null then
    insert into public.businesses (name, commission_type, agency_commission_rate, salesperson_commission_rate)
    values (normalized_name, normalized_commission_type, normalized_agency_rate, normalized_salesperson_rate)
    returning id into output_id;
  else
    update public.businesses
    set name = normalized_name,
        commission_type = normalized_commission_type,
        agency_commission_rate = normalized_agency_rate,
        salesperson_commission_rate = normalized_salesperson_rate,
        updated_at = now()
    where id = target_business_id
    returning id into output_id;
  end if;

  return output_id;
end;
$$;

revoke all on function public.admin_upsert_business(uuid, text, text, numeric, numeric) from public;
grant execute on function public.admin_upsert_business(uuid, text, text, numeric, numeric) to authenticated;

drop function if exists public.admin_list_businesses();
create or replace function public.admin_list_businesses()
returns table (
  id uuid,
  name text,
  commission_type text,
  agency_commission_rate numeric,
  salesperson_commission_rate numeric,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  select b.id, b.name, b.commission_type, b.agency_commission_rate, b.salesperson_commission_rate, b.created_at
  from public.businesses b
  order by b.name asc;
end;
$$;

revoke all on function public.admin_list_businesses() from public;
grant execute on function public.admin_list_businesses() to authenticated;

drop function if exists public.admin_list_approved_users();
create or replace function public.admin_list_approved_users()
returns table (
  email text,
  display_name text,
  role text,
  business_id uuid,
  business_name text,
  commission_type_override text,
  agency_commission_rate_override numeric,
  salesperson_commission_rate_override numeric,
  effective_commission_type text,
  effective_agency_commission_rate numeric,
  effective_salesperson_commission_rate numeric,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  select
    au.email,
    au.display_name,
    au.role,
    au.business_id,
    b.name as business_name,
    au.commission_type_override,
    au.agency_commission_rate_override,
    au.salesperson_commission_rate_override,
    coalesce(au.commission_type_override, b.commission_type, 'none') as effective_commission_type,
    coalesce(au.agency_commission_rate_override, b.agency_commission_rate, 0) as effective_agency_commission_rate,
    coalesce(au.salesperson_commission_rate_override, b.salesperson_commission_rate, 0) as effective_salesperson_commission_rate,
    au.created_at
  from public.approved_users au
  left join public.businesses b on b.id = au.business_id
  order by b.name asc nulls last, au.created_at desc;
end;
$$;

revoke all on function public.admin_list_approved_users() from public;
grant execute on function public.admin_list_approved_users() to authenticated;

-- Refresh Supabase/PostgREST schema cache so new RPC functions are available immediately.
select pg_notify('pgrst', 'reload schema');
