-- Additive only. Existing calculator snapshots and payment flags are untouched.
begin;

create table if not exists public.won_job_batches (
  id uuid primary key,
  actor_id uuid not null default auth.uid(),
  actor_email text not null default lower(auth.jwt() ->> 'email'),
  created_at timestamptz not null default statement_timestamp(),
  kind text not null check (kind in ('manual', 'payment_requested', 'paid_in', 'paid_out')),
  label text not null check (
    (kind = 'manual' and char_length(btrim(label)) between 1 and 80)
    or (kind <> 'manual' and label = '')
  ),
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 50),
  outcomes jsonb not null default '[]'::jsonb check (
    jsonb_typeof(outcomes) = 'array' and jsonb_array_length(outcomes) <= jsonb_array_length(items)
  ),
  outcome_count integer generated always as (jsonb_array_length(outcomes)) stored
);

create index if not exists won_job_batches_created_id_idx
  on public.won_job_batches (created_at desc, id desc);

alter table public.won_job_batches enable row level security;
revoke all on table public.won_job_batches from public, anon, authenticated;
grant select on table public.won_job_batches to authenticated;
grant insert (id, kind, label, items), update (outcomes) on table public.won_job_batches to authenticated;

drop policy if exists "admins read won job batches" on public.won_job_batches;
create policy "admins read won job batches" on public.won_job_batches for select to authenticated
using (
  (select public.is_approved_admin())
  and not exists (
    select 1 from public.approved_users as approval
    where lower(approval.email) = (select lower(auth.jwt() ->> 'email')) and approval.is_locked
  )
);

drop policy if exists "admins create own won job batches" on public.won_job_batches;
create policy "admins create own won job batches" on public.won_job_batches for insert to authenticated
with check (
  actor_id = (select auth.uid())
  and actor_email = (select lower(auth.jwt() ->> 'email'))
  and (select public.is_approved_admin())
  and not exists (
    select 1 from public.approved_users as approval
    where lower(approval.email) = (select lower(auth.jwt() ->> 'email')) and approval.is_locked
  )
);

drop policy if exists "admins append outcomes to own won job batches" on public.won_job_batches;
create policy "admins append outcomes to own won job batches" on public.won_job_batches for update to authenticated
using (
  actor_id = (select auth.uid()) and kind <> 'manual'
  and (select public.is_approved_admin())
  and not exists (
    select 1 from public.approved_users as approval
    where lower(approval.email) = (select lower(auth.jwt() ->> 'email')) and approval.is_locked
  )
)
with check (
  actor_id = (select auth.uid()) and kind <> 'manual'
  and (select public.is_approved_admin())
  and not exists (
    select 1 from public.approved_users as approval
    where lower(approval.email) = (select lower(auth.jwt() ->> 'email')) and approval.is_locked
  )
);

-- Intent and past outcomes are immutable. A status can be appended only once
-- for a selected job; other admins can read the batch but not extend it.
create or replace function public.validate_won_job_batch_write()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
declare
  item jsonb;
  previous_count integer;
begin
  if tg_op = 'INSERT' then
    if new.outcomes <> '[]'::jsonb or octet_length(new.items::text) > 65536 then
      raise exception 'Invalid won job batch';
    end if;
    if (select count(distinct value ->> 'id') from jsonb_array_elements(new.items)) <> jsonb_array_length(new.items) then
      raise exception 'Won job batch IDs must be distinct';
    end if;
    for item in select value from jsonb_array_elements(new.items) loop
      if coalesce(item ->> 'id', '') !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(item -> 'quote') is distinct from 'string'
        or char_length(item ->> 'quote') > 160
        or jsonb_typeof(item -> 'salesperson') is distinct from 'string'
        or char_length(item ->> 'salesperson') > 160
        or jsonb_typeof(item -> 'recovered') is distinct from 'boolean' then
        raise exception 'Invalid won job batch item';
      end if;
    end loop;
    return new;
  end if;

  previous_count := jsonb_array_length(old.outcomes);
  if new.kind = 'manual' or jsonb_typeof(new.outcomes) is distinct from 'array'
    or jsonb_array_length(new.outcomes) <> previous_count + 1
    or new.outcomes - previous_count <> old.outcomes
    or octet_length(new.outcomes::text) > 65536 then
    raise exception 'Won job batch outcomes can only be appended';
  end if;
  item := new.outcomes -> previous_count;
  if coalesce(item ->> 'id', '') !~ '^[0-9a-f]{64}$'
    or coalesce(item ->> 'status', '') not in ('confirmed', 'already_recorded', 'failed')
    or not (new.items @> jsonb_build_array(jsonb_build_object('id', item ->> 'id')))
    or old.outcomes @> jsonb_build_array(jsonb_build_object('id', item ->> 'id'))
    or (item ? 'detail' and (
      jsonb_typeof(item -> 'detail') is distinct from 'string' or char_length(item ->> 'detail') > 240
    )) then
    raise exception 'Invalid won job batch outcome';
  end if;
  return new;
end;
$$;

revoke all on function public.validate_won_job_batch_write() from public, anon, authenticated;
drop trigger if exists validate_won_job_batch_write on public.won_job_batches;
create trigger validate_won_job_batch_write
  before insert or update on public.won_job_batches
  for each row execute function public.validate_won_job_batch_write();

commit;
