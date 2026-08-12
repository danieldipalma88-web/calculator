begin;

create table if not exists public.calculator_user_acknowledgements (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text not null,
  acknowledgement_key text not null,
  acknowledgement_version integer not null check (acknowledgement_version > 0),
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, acknowledgement_key, acknowledgement_version)
);

alter table public.calculator_user_acknowledgements enable row level security;

revoke all on table public.calculator_user_acknowledgements from anon;
revoke all on table public.calculator_user_acknowledgements from authenticated;
grant select, insert on table public.calculator_user_acknowledgements to authenticated;

drop policy if exists "users can read their calculator acknowledgements"
  on public.calculator_user_acknowledgements;
create policy "users can read their calculator acknowledgements"
on public.calculator_user_acknowledgements
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "users can record their calculator acknowledgements"
  on public.calculator_user_acknowledgements;
create policy "users can record their calculator acknowledgements"
on public.calculator_user_acknowledgements
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and lower(user_email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
);

create table if not exists public.calculator_model_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_request_id uuid not null,
  requester_email text not null,
  requester_name text not null default '',
  business_id uuid references public.businesses(id) on delete set null,
  business_name text not null default '',
  system_type text not null check (system_type in ('split', 'ducted', 'multi-head')),
  brand text not null,
  model text not null,
  capacity text not null default '',
  phase text not null default '' check (phase in ('', 'single', 'three', 'unknown')),
  notes text not null default '',
  status text not null default 'new' check (status in ('new', 'reviewing', 'added', 'declined')),
  notification_status text not null default 'pending' check (notification_status in ('pending', 'sent', 'failed')),
  notification_attempted_at timestamptz,
  notification_sent_at timestamptz,
  notification_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_request_id)
);

create index if not exists calculator_model_requests_user_created_idx
  on public.calculator_model_requests (user_id, created_at desc);

create index if not exists calculator_model_requests_status_created_idx
  on public.calculator_model_requests (status, created_at desc);

alter table public.calculator_model_requests enable row level security;

revoke all on table public.calculator_model_requests from anon;
revoke all on table public.calculator_model_requests from authenticated;
grant select, insert, update (
  notification_status,
  notification_attempted_at,
  notification_sent_at,
  notification_error,
  updated_at
) on table public.calculator_model_requests to authenticated;

drop policy if exists "users can read their calculator model requests"
  on public.calculator_model_requests;
create policy "users can read their calculator model requests"
on public.calculator_model_requests
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "users can create their calculator model requests"
  on public.calculator_model_requests;
create policy "users can create their calculator model requests"
on public.calculator_model_requests
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and lower(requester_email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  and status = 'new'
  and notification_status = 'pending'
);

drop policy if exists "users can update notification state on their model requests"
  on public.calculator_model_requests;
create policy "users can update notification state on their model requests"
on public.calculator_model_requests
for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and lower(requester_email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
);

select pg_notify('pgrst', 'reload schema');

commit;
