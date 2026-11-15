-- Apply after won_job_batches_upgrade.sql. Legacy batches without a lease marker
-- can still append directly; a claimed batch requires the leased RPC thereafter.
begin;
set local lock_timeout = '3s';

create schema if not exists won_payment_private;
revoke all on schema won_payment_private from public, anon, authenticated;
grant usage on schema won_payment_private to authenticated;

create table if not exists won_payment_private.batch_leases (
  batch_id uuid primary key references public.won_job_batches(id) on delete cascade,
  lease_token uuid not null,
  lease_until timestamptz not null
);
alter table won_payment_private.batch_leases add column if not exists record_xid xid8;
alter table won_payment_private.batch_leases enable row level security;
revoke all on won_payment_private.batch_leases from public, anon, authenticated;

create or replace function won_payment_private.owns_payment_batch(p_batch_id uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select auth.uid() is not null and coalesce(auth.jwt() ->> 'email', '') <> ''
    and public.is_approved_admin() is true and not exists (
      select 1 from public.approved_users a where lower(a.email) = lower(auth.jwt() ->> 'email') and a.is_locked
    ) and exists (
      select 1 from public.won_job_batches b where b.id = p_batch_id and b.actor_id = auth.uid() and b.kind <> 'manual'
    );
$$;

create or replace function won_payment_private.lock_batch_lease(p_batch_id uuid, p_token uuid) returns boolean
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_lease won_payment_private.batch_leases%rowtype;
begin
  if p_token is null or won_payment_private.owns_payment_batch(p_batch_id) is not true then return false; end if;
  select * into v_lease from won_payment_private.batch_leases l where l.batch_id = p_batch_id for update;
  return found and v_lease.lease_token = p_token and v_lease.lease_until > clock_timestamp();
end;
$$;

create or replace function won_payment_private.manage_batch_lease(
  p_batch_id uuid, p_token uuid, p_action text, p_outcomes jsonb
) returns boolean
language plpgsql security definer set search_path = '' set lock_timeout = '3s' as $$
declare
  v_count integer;
  v_outcome jsonb;
  v_journal jsonb;
  v_previous_token text;
  v_recorded boolean;
begin
  if p_token is null or won_payment_private.owns_payment_batch(p_batch_id) is not true then return false; end if;
  if p_action in ('claim', 'record') then
    if jsonb_typeof(p_outcomes) is distinct from 'array' then return false; end if;
    v_count := jsonb_array_length(p_outcomes);
    if v_count > 50 or octet_length(p_outcomes::text) > 65536 then return false; end if;
    -- A legacy UPDATE already holds this row when its trigger runs. Keep the
    -- same order here: batch row, then lease row; payments only lock the lease.
    select b.outcomes into v_journal from public.won_job_batches b
      where b.id = p_batch_id and b.actor_id = auth.uid() and b.kind <> 'manual'
      for no key update;
    if not found then return false; end if;
  end if;
  if p_action = 'claim' then
    if v_journal is distinct from p_outcomes then return false; end if;
    insert into won_payment_private.batch_leases as l (batch_id, lease_token, lease_until)
      values (p_batch_id, p_token, clock_timestamp() + interval '60 seconds')
      on conflict (batch_id) do update set lease_token = p_token, lease_until = clock_timestamp() + interval '60 seconds'
      where l.lease_token = p_token or l.lease_until <= clock_timestamp();
    return found;
  elsif p_action = 'release' and p_outcomes is null then
    update won_payment_private.batch_leases l set lease_until = '-infinity'::timestamptz, record_xid = null
      where l.batch_id = p_batch_id and l.lease_token = p_token;
    return found;
  elsif p_action = 'check' and p_outcomes is null then
    if not won_payment_private.lock_batch_lease(p_batch_id, p_token) then return false; end if;
    update won_payment_private.batch_leases l set lease_until = clock_timestamp() + interval '60 seconds'
      where l.batch_id = p_batch_id;
    return found;
  elsif p_action = 'record' then
    if v_count < 1 or v_journal is distinct from p_outcomes - (v_count - 1) then return false; end if;
    v_outcome := p_outcomes -> (v_count - 1);
    if jsonb_typeof(v_outcome) is distinct from 'object'
      or v_outcome - array['id', 'status', 'detail'] <> '{}'::jsonb
      or not won_payment_private.lock_batch_lease(p_batch_id, p_token) then return false; end if;
    -- A caller can set a custom GUC, but cannot arm this private transaction ID.
    -- The marker is usable only for the synchronous UPDATE below.
    v_previous_token := current_setting('won_payment.record_token', true);
    perform set_config('won_payment.record_token', p_token::text, true);
    update won_payment_private.batch_leases set record_xid = pg_current_xact_id() where batch_id = p_batch_id;
    update public.won_job_batches b set outcomes = p_outcomes
      where b.id = p_batch_id and b.actor_id = auth.uid() and b.kind <> 'manual' and b.outcome_count = v_count - 1;
    v_recorded := found;
    update won_payment_private.batch_leases set record_xid = null where batch_id = p_batch_id;
    perform set_config('won_payment.record_token', coalesce(v_previous_token, ''), true);
    return v_recorded;
  end if;
  return false;
end;
$$;

revoke all on function won_payment_private.owns_payment_batch(uuid), won_payment_private.lock_batch_lease(uuid,uuid),
  won_payment_private.manage_batch_lease(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function won_payment_private.lock_batch_lease(uuid,uuid),
  won_payment_private.manage_batch_lease(uuid,uuid,text,jsonb) to authenticated;

create or replace function public.manage_won_batch_lease(
  p_batch_id uuid, p_token uuid, p_action text, p_outcomes jsonb default null
) returns boolean
language sql security invoker set search_path = '' as $$
  select won_payment_private.manage_batch_lease(p_batch_id, p_token, p_action, p_outcomes);
$$;
revoke all on function public.manage_won_batch_lease(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.manage_won_batch_lease(uuid,uuid,text,jsonb) to authenticated;

create or replace function won_payment_private.fence_batch_outcomes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_lease won_payment_private.batch_leases%rowtype;
begin
  select * into v_lease from won_payment_private.batch_leases l where l.batch_id = old.id;
  if not found then
    -- A fixed snapshot could predate a claim even after the UPDATE waited for
    -- the batch row. Legacy appends use a fresh statement-level snapshot.
    if current_setting('transaction_isolation') not in ('read committed', 'read uncommitted') then
      raise exception 'Legacy batch append requires read committed isolation' using errcode = '42501';
    end if;
    return new;
  end if;
  if won_payment_private.owns_payment_batch(old.id) is not true
    or v_lease.lease_until <= clock_timestamp()
    or v_lease.lease_token::text is distinct from current_setting('won_payment.record_token', true)
    or v_lease.record_xid is null or v_lease.record_xid is distinct from pg_current_xact_id_if_assigned() then
    raise exception 'This batch requires an active payment lease' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function won_payment_private.fence_batch_outcomes() from public, anon, authenticated;
drop trigger if exists fence_won_job_batch_outcomes on public.won_job_batches;
create trigger fence_won_job_batch_outcomes before update of outcomes on public.won_job_batches
  for each row execute function won_payment_private.fence_batch_outcomes();
grant update (outcomes) on public.won_job_batches to authenticated;

-- Remove the pre-lease signature so PostgREST cannot select an unguarded overload.
drop function if exists public.save_won_payment_overlay(uuid,text,text,timestamptz,text,boolean);
create or replace function public.save_won_payment_overlay(
  p_owner_id uuid,
  p_owner_email text,
  p_storage_key text,
  p_expected_updated_at timestamptz,
  p_overlay text,
  p_readback boolean default false,
  p_batch_id uuid default null,
  p_batch_token uuid default null
) returns jsonb
language plpgsql security invoker
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  v_admin_email text := lower(auth.jwt() ->> 'email');
  v_owner_email text := nullif(lower(btrim(p_owner_email)), '');
  v_overlay jsonb;
  v_prior jsonb;
  v_old_records jsonb;
  v_previous_target jsonb;
  v_target_matches bigint;
  v_tail_preserved boolean;
  v_storage_key text;
  v_owner_id uuid;
  v_snapshot_email text;
  v_stamp timestamptz;
  v_next timestamptz;
  v_saved timestamptz;
begin
  if auth.uid() is null or coalesce(v_admin_email, '') = '' or public.is_approved_admin() is not true
    or exists(select 1 from public.approved_users a where lower(a.email) = v_admin_email and a.is_locked) then
    raise exception 'Not authorised' using errcode = '42501';
  end if;
  if num_nonnulls(p_owner_id, v_owner_email) <> 1 or octet_length(v_owner_email) > 320
    or (p_batch_id is null) <> (p_batch_token is null)
    or p_readback is null or p_storage_key is null or p_storage_key not in (
      'installerWonOptionAdminStateV1', 'greenEnergyWonOptionAdminStateV1', 'WonOptionAdminStateV1'
    ) or p_overlay is null or octet_length(p_overlay) > 2097152 then
    raise exception 'Invalid payment overlay' using errcode = '22023';
  end if;

  v_overlay := p_overlay::jsonb;
  if jsonb_typeof(v_overlay) is distinct from 'array' then
    raise exception 'Invalid payment overlay' using errcode = '22023';
  end if;
  if jsonb_array_length(v_overlay) not between 1 and 2000
    or exists(select 1 from jsonb_array_elements(v_overlay) e where jsonb_typeof(e) <> 'object')
    or coalesce(v_overlay #>> '{0,updatedAt}', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    raise exception 'Invalid payment overlay' using errcode = '22023';
  end if;

  -- The reviewed upsert stamps its first record. Derive an exact version here
  -- so a lost reply can be distinguished from a later write with the same data.
  v_stamp := (v_overlay #>> '{0,updatedAt}')::timestamptz;
  if not p_readback and (v_stamp < statement_timestamp() - interval '5 minutes'
    or v_stamp > statement_timestamp() + interval '1 minute') then
    raise exception 'Payment overlay must be reviewed again' using errcode = '22023';
  end if;
  v_next := greatest(v_stamp, p_expected_updated_at + interval '1 millisecond');

  -- Hold the lease row lock through the payment CAS. Once a runner loses its
  -- lease it can inspect a prior write, but it cannot start another one.
  if not p_readback and p_batch_id is not null and not won_payment_private.lock_batch_lease(p_batch_id, p_batch_token) then
    return jsonb_build_object('status', 'lease_lost');
  end if;

  select s.user_id, s.email, s.data -> p_storage_key, case
    when s.data ? 'installerWonOptionAdminStateV1' then 'installerWonOptionAdminStateV1'
    when s.data ? 'greenEnergyWonOptionAdminStateV1' then 'greenEnergyWonOptionAdminStateV1'
    when s.data ? 'WonOptionAdminStateV1' then 'WonOptionAdminStateV1'
    else 'installerWonOptionAdminStateV1' end
  into v_owner_id, v_snapshot_email, v_prior, v_storage_key
  from public.user_calculator_data s
  where (case when p_owner_id is not null then s.user_id = p_owner_id else lower(s.email) = v_owner_email end)
    and s.updated_at is not distinct from (case when p_readback then v_next else p_expected_updated_at end)
    and jsonb_typeof(s.data) = 'object';

  if not found or v_storage_key <> p_storage_key then
    return jsonb_build_object('status', case when p_readback then 'unconfirmed' else 'conflict' end);
  end if;
  if p_readback then
    if v_prior = (case when jsonb_typeof(v_prior) = 'array' then v_overlay else to_jsonb(p_overlay) end) then
      return jsonb_build_object('status', 'saved', 'updated_at', v_next);
    end if;
    return jsonb_build_object('status', 'unconfirmed');
  end if;

  if v_prior is null then
    v_old_records := '[]'::jsonb;
  elsif jsonb_typeof(v_prior) = 'array' then
    v_old_records := v_prior;
  elsif jsonb_typeof(v_prior) = 'string' then
    v_old_records := (v_prior #>> '{}')::jsonb;
  else
    raise exception 'Existing payment overlay is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(v_old_records) is distinct from 'array' then
    raise exception 'Existing payment overlay is invalid' using errcode = '22023';
  end if;

  -- Only the first (upserted) record may differ. Match by the same fallback
  -- win identity as the admin reader; compare the untouched tail as raw JSONB.
  with entries as (
    select incoming, position, e, jsonb_build_array(
      coalesce(nullif(btrim(coalesce(nullif(e->>'dataUserId', ''), nullif(e->>'userId', ''), v_owner_id::text)), ''), v_owner_id::text),
      lower(btrim(coalesce(nullif(e->>'userEmail', ''), nullif(e->>'wonByEmail', ''), e->>'email', ''))),
      coalesce(nullif(btrim(e->>'optionId'), ''), 'option_1'), coalesce(btrim(e->>'wonAt'), '')
    ) as identity
    from (values (false, v_old_records), (true, v_overlay)) inputs(incoming, records),
      lateral jsonb_array_elements(inputs.records) with ordinality as item(e, position)
  ), target as (
    select identity from entries where incoming and position = 1
  )
  select (jsonb_agg(e) filter(where not incoming and entries.identity = target.identity))->0,
    count(*) filter(where entries.identity = target.identity),
    (jsonb_agg(e order by position) filter(where not incoming and entries.identity <> target.identity))
      is not distinct from (jsonb_agg(e order by position) filter(where incoming and position <> 1))
      and bool_and(target.identity->>0 = v_owner_id::text and target.identity->>1 <> '' and target.identity->>3 <> '')
  into v_previous_target, v_target_matches, v_tail_preserved from entries cross join target;
  if v_target_matches not between 1 and 2 or v_tail_preserved is not true then
    raise exception 'Payment save cannot replace unrelated payment records' using errcode = '22023';
  end if;
  if (nullif(v_previous_target->>'paymentRequestedAt', '') is not null
      and v_previous_target->>'paymentRequestedAt' is distinct from v_overlay #>> '{0,paymentRequestedAt}')
    or (coalesce(nullif(v_previous_target->>'paidInAt', ''), nullif(v_previous_target->>'agencyPaidInAt', '')) is not null
      and coalesce(nullif(v_previous_target->>'paidInAt', ''), nullif(v_previous_target->>'agencyPaidInAt', ''))
        is distinct from coalesce(nullif(v_overlay #>> '{0,paidInAt}', ''), nullif(v_overlay #>> '{0,agencyPaidInAt}', '')))
    or (coalesce(nullif(v_previous_target->>'paidOutAt', ''), nullif(v_previous_target->>'salespersonPaidOutAt', '')) is not null
      and coalesce(nullif(v_previous_target->>'paidOutAt', ''), nullif(v_previous_target->>'salespersonPaidOutAt', ''))
        is distinct from coalesce(nullif(v_overlay #>> '{0,paidOutAt}', ''), nullif(v_overlay #>> '{0,salespersonPaidOutAt}', ''))) then
    raise exception 'Payment save cannot replace existing payment timestamps' using errcode = '22023';
  end if;

  -- This key also contains unlock and reset fences. A payment save must not
  -- introduce, remove, or retarget any of those markers.
  if exists (
    with markers as (
      select incoming, jsonb_build_array(
        lower(btrim(coalesce(nullif(e->>'userEmail', ''), nullif(e->>'wonByEmail', ''), e->>'email', ''))),
        lower(btrim(coalesce(nullif(e->>'dataOwnerEmail', ''), nullif(e->>'ownerEmail', ''), v_snapshot_email, ''))),
        btrim(coalesce(nullif(e->>'dataUserId', ''), nullif(e->>'userId', ''), v_owner_id::text)),
        coalesce(nullif(btrim(e->>'sourceId'), ''), 'current'), coalesce(nullif(btrim(e->>'optionId'), ''), 'option_1'),
        btrim(e->>'wonAt'), nullif(e->>'unlockedAt', ''), lower(btrim(coalesce(e->>'unlockedByEmail', ''))),
        nullif(e->>'paymentResetAt', ''), lower(btrim(coalesce(e->>'paymentResetByEmail', '')))
      ) as marker
      from (values (false, v_old_records), (true, v_overlay)) inputs(incoming, records),
        lateral jsonb_array_elements(inputs.records) e
      where nullif(e->>'unlockedAt', '') is not null or nullif(e->>'paymentResetAt', '') is not null
    )
    select 1 from markers group by marker
    having count(*) filter(where incoming) <> count(*) filter(where not incoming)
  ) then
    raise exception 'Payment save cannot modify unlock or reset markers' using errcode = '22023';
  end if;

  update public.user_calculator_data s
    set data = jsonb_set(s.data, array[p_storage_key],
      case when jsonb_typeof(v_prior) = 'array' then v_overlay else to_jsonb(p_overlay) end),
      updated_at = v_next
    where s.user_id = v_owner_id and (p_owner_id is not null or lower(s.email) = v_owner_email)
      and s.updated_at is not distinct from p_expected_updated_at
    returning s.updated_at into v_saved;

  if not found then return jsonb_build_object('status', 'conflict'); end if;
  return jsonb_build_object('status', 'saved', 'updated_at', v_saved);
end;
$$;

revoke all on function public.save_won_payment_overlay(uuid,text,text,timestamptz,text,boolean,uuid,uuid) from public, anon, authenticated;
grant execute on function public.save_won_payment_overlay(uuid,text,text,timestamptz,text,boolean,uuid,uuid) to authenticated;

select pg_notify('pgrst', 'reload schema');
commit;
