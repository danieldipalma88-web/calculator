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
