-- Allows direct user login and admin "open calculator" views to read the same
-- calculator profile row by approved email.
--
-- Run this in Supabase SQL Editor if a user's direct login shows different
-- calculator values than the admin view of the same email.

alter table public.user_calculator_data
  add column if not exists email text;

create unique index if not exists user_calculator_data_email_unique
on public.user_calculator_data (lower(email))
where email is not null;

drop policy if exists "users can read own calculator data by email" on public.user_calculator_data;
create policy "users can read own calculator data by email"
on public.user_calculator_data
for select
to authenticated
using (
  email is not null
  and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists "users can update own calculator data by email" on public.user_calculator_data;
create policy "users can update own calculator data by email"
on public.user_calculator_data
for update
to authenticated
using (
  email is not null
  and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
)
with check (
  email is not null
  and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

drop policy if exists "users can insert own calculator data with email" on public.user_calculator_data;
create policy "users can insert own calculator data with email"
on public.user_calculator_data
for insert
to authenticated
with check (
  user_id = auth.uid()
  and (
    email is null
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);

select pg_notify('pgrst', 'reload schema');
