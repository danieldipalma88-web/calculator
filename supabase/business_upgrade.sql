-- Business/user/commission upgrade only.
-- Run this in Supabase SQL Editor if the full schema.sql file gives a function-language error.

create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  operating_state text not null default 'NSW',
  commission_type text not null default 'none',
  agency_commission_rate numeric not null default 25,
  salesperson_commission_rate numeric not null default 50,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.businesses enable row level security;

alter table public.businesses
  add column if not exists operating_state text not null default 'NSW';

alter table public.businesses drop constraint if exists businesses_commission_type_check;
alter table public.businesses
  add constraint businesses_commission_type_check
  check (commission_type in ('none', 'standard', 'agency'));

alter table public.businesses drop constraint if exists businesses_operating_state_check;
alter table public.businesses
  add constraint businesses_operating_state_check
  check (operating_state in ('NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'));

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
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'danieldipalma88@gmail.com'
    or exists (
      select 1
      from public.approved_users
      where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        and role = 'admin'
    );
$$
language sql
stable
security definer
set search_path = public;

revoke all on function public.is_approved_admin() from public;
grant execute on function public.is_approved_admin() to authenticated;

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

drop function if exists public.admin_upsert_approved_user(text, text);
drop function if exists public.admin_upsert_approved_user(text, text, uuid, text, numeric, numeric);
create or replace function public.admin_upsert_approved_user(
  target_email text,
  target_role text default 'user',
  target_business_id uuid default null,
  target_commission_type_override text default null,
  target_agency_commission_rate_override numeric default null,
  target_salesperson_commission_rate_override numeric default null
)
returns void
as $$
declare
  normalized_email text := lower(trim(coalesce(target_email, '')));
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
    role,
    business_id,
    commission_type_override,
    agency_commission_rate_override,
    salesperson_commission_rate_override
  )
  values (
    normalized_email,
    normalized_role,
    target_business_id,
    normalized_commission_type,
    normalized_agency_rate,
    normalized_salesperson_rate
  )
  on conflict (email) do update set
    role = excluded.role,
    business_id = excluded.business_id,
    commission_type_override = excluded.commission_type_override,
    agency_commission_rate_override = excluded.agency_commission_rate_override,
    salesperson_commission_rate_override = excluded.salesperson_commission_rate_override;
end;
$$
language plpgsql
security definer
set search_path = public;

revoke all on function public.admin_upsert_approved_user(text, text, uuid, text, numeric, numeric) from public;
grant execute on function public.admin_upsert_approved_user(text, text, uuid, text, numeric, numeric) to authenticated;

drop function if exists public.admin_upsert_business(uuid, text, text, numeric, numeric);
drop function if exists public.admin_upsert_business(uuid, text, text, text, numeric, numeric);
create or replace function public.admin_upsert_business(
  target_business_id uuid default null,
  target_name text default '',
  target_operating_state text default 'NSW',
  target_commission_type text default 'none',
  target_agency_commission_rate numeric default 25,
  target_salesperson_commission_rate numeric default 50
)
returns uuid
as $$
declare
  normalized_name text := trim(coalesce(target_name, ''));
  normalized_operating_state text := upper(trim(coalesce(target_operating_state, 'NSW')));
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

  if normalized_operating_state not in ('NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT') then
    normalized_operating_state := 'NSW';
  end if;

  if target_business_id is null then
    insert into public.businesses (name, operating_state, commission_type, agency_commission_rate, salesperson_commission_rate)
    values (normalized_name, normalized_operating_state, normalized_commission_type, normalized_agency_rate, normalized_salesperson_rate)
    returning id into output_id;
  else
    update public.businesses
    set name = normalized_name,
        operating_state = normalized_operating_state,
        commission_type = normalized_commission_type,
        agency_commission_rate = normalized_agency_rate,
        salesperson_commission_rate = normalized_salesperson_rate,
        updated_at = now()
    where id = target_business_id
    returning id into output_id;
  end if;

  return output_id;
end;
$$
language plpgsql
security definer
set search_path = public;

revoke all on function public.admin_upsert_business(uuid, text, text, text, numeric, numeric) from public;
grant execute on function public.admin_upsert_business(uuid, text, text, text, numeric, numeric) to authenticated;

drop function if exists public.admin_list_businesses();
create or replace function public.admin_list_businesses()
returns table (
  id uuid,
  name text,
  operating_state text,
  commission_type text,
  agency_commission_rate numeric,
  salesperson_commission_rate numeric,
  created_at timestamptz
)
as $$
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  select b.id, b.name, b.operating_state, b.commission_type, b.agency_commission_rate, b.salesperson_commission_rate, b.created_at
  from public.businesses b
  order by b.name asc;
end;
$$
language plpgsql
security definer
set search_path = public;

revoke all on function public.admin_list_businesses() from public;
grant execute on function public.admin_list_businesses() to authenticated;

drop function if exists public.admin_list_approved_users();
create or replace function public.admin_list_approved_users()
returns table (
  email text,
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
as $$
begin
  if not public.is_approved_admin() then
    raise exception 'Not authorized';
  end if;

  return query
  select
    au.email,
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
$$
language plpgsql
security definer
set search_path = public;

revoke all on function public.admin_list_approved_users() from public;
grant execute on function public.admin_list_approved_users() to authenticated;

select pg_notify('pgrst', 'reload schema');
