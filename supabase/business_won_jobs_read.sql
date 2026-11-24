-- Apply this file followed by business_won_jobs_index.sql in ONE migration
-- transaction. Neither file starts or commits its own transaction.
-- Read-side cache only: no index, trigger, FK, policy or column changes on quote
-- storage. xmin + updated_at + email detect legacy data-only updates as well.
-- The RPC is a standalone read request, not mixed with source writes in one TX.
-- A future source_keys_v1 change requires cache invalidation under the same lock.

create schema if not exists business_won_private;
revoke all on schema business_won_private from public, anon, authenticated;
grant usage on schema business_won_private to authenticated;

create table if not exists business_won_private.source_directory (
  user_id uuid primary key,
  profile_updated_at timestamptz not null,
  profile_email text,
  profile_version text not null,
  source_keys text[] not null
);
alter table business_won_private.source_directory enable row level security;
revoke all on table business_won_private.source_directory from public, anon, authenticated;

create or replace function business_won_private.text_v1(p_value jsonb)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case when jsonb_typeof(p_value) in ('string', 'number') then p_value #>> '{}' end;
$$;

create or replace function business_won_private.array_v1(p_value jsonb, p_decode boolean default true)
returns jsonb language plpgsql immutable parallel safe set search_path = '' as $$
declare v_value jsonb := p_value;
begin
  if p_decode and jsonb_typeof(v_value) = 'string' then
    v_value := (v_value #>> '{}')::jsonb;
  end if;
  return case when jsonb_typeof(v_value) = 'array' then v_value else '[]'::jsonb end;
exception when others then
  return '[]'::jsonb;
end;
$$;

create or replace function business_won_private.stored_array_v1(p_data jsonb, p_keys text[])
returns jsonb language plpgsql immutable parallel safe set search_path = '' as $$
declare v_key text; v_value jsonb;
begin
  foreach v_key in array p_keys loop
    v_value := p_data -> v_key;
    -- Match wonReadableStorageKey's first JS-truthy alias, not first valid alias.
    -- A malformed canonical value MUST NOT uncover a stale legacy copy.
    if v_value is not null and v_value not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb) then
      return business_won_private.array_v1(v_value);
    end if;
  end loop;
  return '[]'::jsonb;
end;
$$;

create or replace function business_won_private.row_business_v1(p_row jsonb)
returns text language plpgsql immutable parallel safe set search_path = '' as $$
declare v_state jsonb; v_legacy jsonb;
begin
  if jsonb_typeof(p_row) is distinct from 'object' then return null; end if;
  if p_row->'state' is not null and p_row->'state' <> 'null'::jsonb
    and jsonb_typeof(p_row->'state') <> 'object' then return null; end if;
  v_state := p_row #> '{state,businessId}';
  v_legacy := p_row -> 'businessId';
  if v_state = 'null'::jsonb then v_state := null; end if;
  if v_legacy = 'null'::jsonb then v_legacy := null; end if;
  if v_state is not null and (jsonb_typeof(v_state) <> 'string' or v_state = '""'::jsonb) then return null; end if;
  if v_legacy is not null and (jsonb_typeof(v_legacy) <> 'string' or v_legacy = '""'::jsonb) then return null; end if;
  if v_state is not null and v_legacy is not null and v_state <> v_legacy then return null; end if;
  if (coalesce(v_state, v_legacy) #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return coalesce(v_state, v_legacy) #>> '{}';
end;
$$;

create or replace function business_won_private.identity_v1(p_owner text, p_salesperson text, p_option text, p_won text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select jsonb_build_array(p_owner, p_salesperson, p_option, p_won)::text;
$$;

create or replace function business_won_private.marker_identity_v1(p_record jsonb, p_user_id uuid, p_email text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select case when salesperson <> '' and won <> '' then business_won_private.identity_v1(owner_id, salesperson, option_id, won) end
  from (select
    coalesce(nullif(btrim(business_won_private.text_v1(p_record->'dataUserId')), ''),
      nullif(btrim(business_won_private.text_v1(p_record->'userId')), ''), p_user_id::text,
      lower(btrim(coalesce(business_won_private.text_v1(p_record->'dataOwnerEmail'),
        business_won_private.text_v1(p_record->'ownerEmail'), p_email, '')))) as owner_id,
    lower(btrim(coalesce(nullif(business_won_private.text_v1(p_record->'userEmail'), ''),
      nullif(business_won_private.text_v1(p_record->'wonByEmail'), ''), business_won_private.text_v1(p_record->'email'), ''))) as salesperson,
    coalesce(nullif(btrim(business_won_private.text_v1(p_record->'optionId')), ''), 'option_1') as option_id,
    btrim(coalesce(business_won_private.text_v1(p_record->'wonAt'), '')) as won
  ) normalized;
$$;

create or replace function business_won_private.markers_v1(p_data jsonb)
returns table(kind text, record jsonb, marker_position bigint)
language sql immutable parallel safe set search_path = '' as $$
  select keys.kind, entry.record, keys.priority * 1000000000::bigint + entry.position
  from (values
    ('deleted', 'installerDeletedWonOptionsV1', 1),
    ('deleted', 'greenEnergyDeletedWonOptionsV1', 2),
    ('deleted', 'DeletedWonOptionsV1', 3),
    ('admin', 'installerWonOptionAdminStateV1', 4),
    ('admin', 'greenEnergyWonOptionAdminStateV1', 5),
    ('admin', 'WonOptionAdminStateV1', 6)
  ) keys(kind, storage_key, priority)
  cross join lateral jsonb_array_elements(business_won_private.array_v1(p_data->keys.storage_key))
    with ordinality entry(record, position)
  where jsonb_typeof(entry.record) = 'object';
$$;

create or replace function business_won_private.source_keys_v1(p_data jsonb, p_user_id uuid, p_email text)
returns text[] language sql immutable parallel safe set search_path = '' as $$
  select coalesce(array_agg(distinct token order by token) filter(where token is not null), '{}'::text[])
  from (
    select 'b:' || business_won_private.row_business_v1(qr.value) as token
    from (
      select business_won_private.stored_array_v1(p_data,
        array['installerMasterQuoteLogV1','greenEnergyMasterQuoteLogV1','MasterQuoteLogV1']) as quotes
      union all
      select business_won_private.array_v1(saved.value->'quotes', false)
      from jsonb_array_elements(business_won_private.stored_array_v1(p_data,
        array['installerSavedQuoteSetsV1','greenEnergySavedQuoteSetsV1','SavedQuoteSetsV1'])) saved(value)
    ) snapshots cross join lateral jsonb_array_elements(snapshots.quotes) qr(value)
    union all
    select 'j:' || md5(business_won_private.marker_identity_v1(marker.record, p_user_id, p_email))
    from business_won_private.markers_v1(p_data) marker
  ) tokens;
$$;

create or replace function business_won_private.money_v1(p_value jsonb)
returns numeric language plpgsql immutable parallel safe set search_path = '' as $$
declare v_text text := business_won_private.text_v1(p_value); v_amount numeric;
begin
  if v_text is null or length(v_text) > 100 or btrim(v_text) !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' then return null; end if;
  v_amount := btrim(v_text)::numeric;
  if abs(v_amount) > 1.7976931348623157e308::numeric then return null; end if;
  return v_amount;
exception when others then return null;
end;
$$;

create or replace function business_won_private.time_v1(p_value text)
returns timestamptz language plpgsql stable parallel safe set search_path = '' set timezone = 'UTC' as $$
begin
  return coalesce(nullif(p_value, '')::timestamptz, '-infinity'::timestamptz);
exception when others then return '-infinity'::timestamptz;
end;
$$;

create or replace function business_won_private.normal_text_v1(p_value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select regexp_replace(lower(btrim(coalesce(p_value, ''))), '[[:space:]]+', ' ', 'g');
$$;

create or replace function business_won_private.read_v1(p_business_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  v_role text; v_locked boolean; v_primary uuid; v_name text; v_jobs jsonb;
  v_versions jsonb; v_final_versions jsonb; v_cached_versions jsonb;
  v_refreshing jsonb := jsonb_build_object('status', 'refreshing', 'businessId', p_business_id, 'retryAfterMs', 1000);
begin
  if auth.uid() is null or v_email = '' or p_business_id is null then
    raise exception 'Business Won Jobs access denied' using errcode = '42501';
  end if;
  select a.role, a.is_locked, a.business_id into v_role, v_locked, v_primary
  from public.approved_users a where a.email = v_email;
  if not found or coalesce(v_locked, false) then
    raise exception 'Business Won Jobs access denied' using errcode = '42501';
  end if;
  if not (v_email = 'danieldipalma88@gmail.com' or coalesce(v_role = 'admin', false)) then
    if v_role is distinct from 'business_owner' or not (v_primary = p_business_id or exists(
      select 1 from public.approved_user_businesses m where m.email = v_email and m.business_id = p_business_id
    )) is true then
      raise exception 'Business Won Jobs access denied' using errcode = '42501';
    end if;
  end if;
  select b.name into v_name from public.businesses b where b.id = p_business_id;
  if not found then raise exception 'Business not found' using errcode = '22023'; end if;
  -- Only the new, private directory needs a GIN index. Quote saves never touch it.
  if not exists(
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = c.relam
    where i.indexrelid = pg_catalog.to_regclass('business_won_private.business_won_jobs_directory_keys_idx')
      and i.indrelid = 'business_won_private.source_directory'::regclass
      and i.indisvalid and i.indisready and i.indislive and i.indpred is null
      and i.indnatts = 1 and am.amname = 'gin' and i.indexprs is null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'source_keys'
  ) then
    raise exception 'Business Won Jobs directory index is not ready; no profiles read' using errcode = '55000';
  end if;

  -- These comparisons never select data: even a cold directory first reads only
  -- small profile metadata. No unselected JSON is fetched on a warm request.
  select coalesce(jsonb_agg(jsonb_build_array(s.user_id, s.email, s.updated_at, s.xmin::text) order by s.user_id), '[]'::jsonb)
    into v_versions from public.user_calculator_data s;
  select coalesce(jsonb_agg(jsonb_build_array(d.user_id, d.profile_email, d.profile_updated_at, d.profile_version) order by d.user_id), '[]'::jsonb)
    into v_cached_versions from business_won_private.source_directory d;
  if v_versions is distinct from v_cached_versions then
    -- This lock belongs only to this cache; no source rows are locked. Losers
    -- return a progress response instead of waiting or duplicating refresh work.
    if not pg_catalog.pg_try_advisory_xact_lock(730761, 1) then return v_refreshing; end if;
    delete from business_won_private.source_directory d
      where not exists(select 1 from public.user_calculator_data s where s.user_id = d.user_id);
    with changed as materialized (
      select s.user_id from public.user_calculator_data s
      left join business_won_private.source_directory d on d.user_id = s.user_id
      where d.user_id is null or d.profile_updated_at is distinct from s.updated_at
        or d.profile_email is distinct from s.email or d.profile_version is distinct from s.xmin::text
      order by (d.user_id is not null), d.profile_updated_at, s.user_id
      limit 10
    ), refreshed as materialized (
      -- Data and its exact version come from this same statement snapshot.
      select s.user_id, s.updated_at, s.email, s.xmin::text as profile_version,
        business_won_private.source_keys_v1(s.data, s.user_id, s.email) as source_keys
      from changed c join public.user_calculator_data s on s.user_id = c.user_id
    )
    insert into business_won_private.source_directory(user_id, profile_updated_at, profile_email, profile_version, source_keys)
    select r.user_id, r.updated_at, r.email, r.profile_version, r.source_keys from refreshed r
    on conflict(user_id) do update set profile_updated_at = excluded.profile_updated_at,
      profile_email = excluded.profile_email, profile_version = excluded.profile_version, source_keys = excluded.source_keys;

    select coalesce(jsonb_agg(jsonb_build_array(s.user_id, s.email, s.updated_at, s.xmin::text) order by s.user_id), '[]'::jsonb)
      into v_versions from public.user_calculator_data s;
    select coalesce(jsonb_agg(jsonb_build_array(d.user_id, d.profile_email, d.profile_updated_at, d.profile_version) order by d.user_id), '[]'::jsonb)
      into v_cached_versions from business_won_private.source_directory d;
    if v_versions is distinct from v_cached_versions then return v_refreshing; end if;
  end if;

  with sources as materialized (
    select s.user_id, s.email, s.data
    from business_won_private.source_directory d
    join public.user_calculator_data s on s.user_id = d.user_id
      and s.updated_at = d.profile_updated_at and s.email is not distinct from d.profile_email
      and s.xmin::text = d.profile_version
    where d.source_keys @> array['b:' || p_business_id::text]
  ), snapshots as materialized (
    select s.user_id, s.email, 0::bigint as source_position,
      business_won_private.stored_array_v1(s.data,
        array['installerQuoteOptionDefsV1','greenEnergyQuoteOptionDefsV1','QuoteOptionDefsV1']) as defs,
      business_won_private.stored_array_v1(s.data,
        array['installerMasterQuoteLogV1','greenEnergyMasterQuoteLogV1','MasterQuoteLogV1']) as quotes
    from sources s
    union all
    select s.user_id, s.email, saved.position,
      business_won_private.array_v1(saved.value->'optionDefs', false),
      business_won_private.array_v1(saved.value->'quotes', false)
    from sources s cross join lateral jsonb_array_elements(business_won_private.stored_array_v1(s.data,
      array['installerSavedQuoteSetsV1','greenEnergySavedQuoteSetsV1','SavedQuoteSetsV1'])) with ordinality saved(value, position)
  ), groups as materialized (
    select s.user_id, s.email, s.source_position, grouped.option_id, grouped.rows,
      coalesce(won_def.value, grouped.first_won) as option
    from snapshots s
    cross join lateral (
      select coalesce(nullif(business_won_private.text_v1(entry.value->'optionId'), ''), 'option_1') as option_id,
        jsonb_agg(entry.value order by entry.position) as rows,
        (jsonb_agg(entry.value order by entry.position) filter(
          where nullif(business_won_private.text_v1(entry.value->'wonAt'), '') is not null))->0 as first_won
      from jsonb_array_elements(s.quotes) with ordinality entry(value, position)
      group by coalesce(nullif(business_won_private.text_v1(entry.value->'optionId'), ''), 'option_1')
    ) grouped
    left join lateral (
      select def.value from jsonb_array_elements(s.defs) with ordinality def(value, position)
      where jsonb_typeof(def.value) = 'object'
        and coalesce(nullif(business_won_private.text_v1(def.value->'id'), ''), 'option_1') = grouped.option_id
        and nullif(business_won_private.text_v1(def.value->'wonAt'), '') is not null
      order by def.position limit 1
    ) won_def on true
    where coalesce(won_def.value, grouped.first_won) is not null
  ), raw_jobs as materialized (
    select g.*, attribution.salesperson, business_won_private.text_v1(g.option->'wonAt') as won_at,
      business_won_private.identity_v1(g.user_id::text, attribution.salesperson, g.option_id,
        business_won_private.text_v1(g.option->'wonAt')) as identity,
      coalesce(nullif(business_won_private.text_v1(g.option->'name'), ''),
        nullif(business_won_private.text_v1(g.option->'optionName'), ''), 'Option') as quote_name
    from groups g cross join lateral (
      select lower(btrim(coalesce(nullif(business_won_private.text_v1(g.option->'wonByEmail'), ''),
        (select nullif(business_won_private.text_v1(r.value->'wonByEmail'), '') from jsonb_array_elements(g.rows) r(value)
          where nullif(business_won_private.text_v1(r.value->'wonByEmail'), '') is not null limit 1), g.email, ''))) as salesperson
    ) attribution where attribution.salesperson <> ''
  ), marker_sources as materialized (
    select s.user_id, s.email, s.data
    from business_won_private.source_directory d
    join public.user_calculator_data s on s.user_id = d.user_id
      and s.updated_at = d.profile_updated_at and s.email is not distinct from d.profile_email
      and s.xmin::text = d.profile_version
    where d.source_keys &&
      array(select distinct 'j:' || md5(r.identity) from raw_jobs r)
  ), markers as materialized (
    select m.*, s.user_id,
      business_won_private.marker_identity_v1(m.record, s.user_id, s.email) as identity
    from marker_sources s cross join lateral business_won_private.markers_v1(s.data) m
  ), suppressed as (
    select distinct identity from markers where kind = 'deleted'
      or nullif(business_won_private.text_v1(record->'unlockedAt'), '') is not null
  ), overlays as (
    select distinct on (m.identity) m.identity, m.record
    from markers m where m.kind = 'admin'
    order by m.identity, business_won_private.time_v1(coalesce(
      nullif(business_won_private.text_v1(m.record->'updatedAt'), ''),
      nullif(business_won_private.text_v1(m.record->'paymentRequestedAt'), ''),
      nullif(business_won_private.text_v1(m.record->'paidInAt'), ''),
      nullif(business_won_private.text_v1(m.record->'paidOutAt'), ''),
      nullif(business_won_private.text_v1(m.record->'unlockedAt'), ''),
      business_won_private.text_v1(m.record->'paymentResetAt'))) desc, m.user_id desc, m.marker_position desc
  ), source_winners as materialized (
    -- The admin reader takes current before saved for one owner/win identity.
    select distinct on (r.identity) r.* from raw_jobs r
    where not exists(select 1 from suppressed d where d.identity = r.identity)
    order by r.identity, r.source_position
  ), scoped as materialized (
    select r.*, ov.record as overlay
    from source_winners r left join overlays ov on ov.identity = r.identity
    where not exists(select 1 from jsonb_array_elements(r.rows) qr(value)
      where business_won_private.row_business_v1(qr.value) is distinct from p_business_id::text)
  ), prepared as (
    select s.*,
      jsonb_build_array(p_business_id::text, s.salesperson, s.option_id, s.won_at,
        business_won_private.normal_text_v1(s.quote_name), details.fingerprint)::text as duplicate_key,
      coalesce(nullif(business_won_private.text_v1(s.option->'wonByName'), ''), details.salesperson_name,
        nullif(a.display_name, ''), s.salesperson) as salesperson_name,
      coalesce(nullif(business_won_private.text_v1(s.option->'installationAddress'), ''), details.address) as address,
      coalesce(nullif(business_won_private.text_v1(s.option->'proposedInstallationDate'), ''), details.installation_date) as installation_date,
      details.public_rows,
      case when pay.paid_in and pay.paid_out then 3 when pay.paid_in or pay.paid_out then 2
        when pay.requested then 1 else 0 end as payment_priority
    from scoped s
    left join public.approved_users a on a.email = s.salesperson
    cross join lateral (
      select jsonb_agg(jsonb_build_object(
          'brand', business_won_private.text_v1(qr.value->'brand'),
          'model', business_won_private.text_v1(qr.value->'model'),
          'type', business_won_private.text_v1(qr.value->'type'),
          'size', coalesce(nullif(business_won_private.text_v1(qr.value->'size'), ''), business_won_private.text_v1(qr.value->'capacity')),
          'install', business_won_private.text_v1(qr.value->'install'),
          'finalInc', business_won_private.money_v1(qr.value->'finalInc'),
          'rebate', business_won_private.money_v1(qr.value->'rebate'),
          'netProfit', business_won_private.money_v1(qr.value->'netProfit')
        ) order by qr.position) as public_rows,
        jsonb_agg(fingerprint.value order by fingerprint.value::text) as fingerprint,
        (array_agg(nullif(business_won_private.text_v1(qr.value->'wonByName'), '') order by qr.position)
          filter(where nullif(business_won_private.text_v1(qr.value->'wonByName'), '') is not null))[1] as salesperson_name,
        (array_agg(business_won_private.text_v1(qr.value->'installationAddress') order by qr.position)
          filter(where nullif(business_won_private.text_v1(qr.value->'installationAddress'), '') is not null
            or nullif(business_won_private.text_v1(qr.value->'googlePlaceId'), '') is not null
            or nullif(business_won_private.text_v1(qr.value->'proposedInstallationDate'), '') is not null))[1] as address,
        (array_agg(business_won_private.text_v1(qr.value->'proposedInstallationDate') order by qr.position)
          filter(where nullif(business_won_private.text_v1(qr.value->'installationAddress'), '') is not null
            or nullif(business_won_private.text_v1(qr.value->'googlePlaceId'), '') is not null
            or nullif(business_won_private.text_v1(qr.value->'proposedInstallationDate'), '') is not null))[1] as installation_date
      from jsonb_array_elements(s.rows) with ordinality qr(value, position)
      cross join lateral (select jsonb_build_array(
        business_won_private.normal_text_v1(business_won_private.text_v1(qr.value->'type')),
        business_won_private.normal_text_v1(business_won_private.text_v1(qr.value->'brand')),
        business_won_private.normal_text_v1(business_won_private.text_v1(qr.value->'series')),
        business_won_private.normal_text_v1(coalesce(nullif(business_won_private.text_v1(qr.value->'size'), ''), business_won_private.text_v1(qr.value->'capacity'))),
        business_won_private.normal_text_v1(business_won_private.text_v1(qr.value->'model')),
        business_won_private.normal_text_v1(business_won_private.text_v1(qr.value->'install'))
      ) as value) fingerprint
    ) details
    cross join lateral (
      select
        nullif(business_won_private.text_v1(s.overlay->'paymentRequestedAt'), '') is not null or
          (nullif(business_won_private.text_v1(s.overlay->'paymentResetAt'), '') is null and bool_or(nullif(business_won_private.text_v1(p.value->'paymentRequestedAt'), '') is not null)) as requested,
        nullif(business_won_private.text_v1(s.overlay->'paidInAt'), '') is not null or
          (nullif(business_won_private.text_v1(s.overlay->'paymentResetAt'), '') is null and bool_or(coalesce(nullif(business_won_private.text_v1(p.value->'agencyPaidInAt'), ''), nullif(business_won_private.text_v1(p.value->'paidInAt'), '')) is not null)) as paid_in,
        nullif(business_won_private.text_v1(s.overlay->'paidOutAt'), '') is not null or
          (nullif(business_won_private.text_v1(s.overlay->'paymentResetAt'), '') is null and bool_or(coalesce(nullif(business_won_private.text_v1(p.value->'salespersonPaidOutAt'), ''), nullif(business_won_private.text_v1(p.value->'paidOutAt'), '')) is not null)) as paid_out
      from (select s.option as value union all select qr.value from jsonb_array_elements(s.rows) qr(value)
        where nullif(business_won_private.text_v1(qr.value->'wonAt'), '') is null or business_won_private.text_v1(qr.value->'wonAt') = s.won_at) p
    ) pay
  ), canonical as materialized (
    select distinct on (p.duplicate_key) p.* from prepared p
    order by p.duplicate_key, (lower(coalesce(p.email, '')) = p.salesperson) desc,
      p.payment_priority desc, (p.source_position = 0) desc, jsonb_array_length(p.rows) desc,
      p.user_id, p.source_position
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', p_business_id::text || ':' || md5(c.duplicate_key), 'quoteName', c.quote_name,
    'wonAt', c.won_at, 'salespersonName', c.salesperson_name,
    'address', c.address, 'installationDate', c.installation_date, 'rows', c.public_rows
  ) order by business_won_private.time_v1(c.won_at) desc, c.duplicate_key), '[]'::jsonb)
  into v_jobs from canonical c;

  -- VOLATILE PL/pgSQL takes a fresh snapshot for this metadata-only statement.
  -- A new/changed/deleted profile during projection could contain a business job
  -- or fence; never claim a complete result until all versions agree again.
  select coalesce(jsonb_agg(jsonb_build_array(s.user_id, s.email, s.updated_at, s.xmin::text) order by s.user_id), '[]'::jsonb)
    into v_final_versions from public.user_calculator_data s;
  select coalesce(jsonb_agg(jsonb_build_array(d.user_id, d.profile_email, d.profile_updated_at, d.profile_version) order by d.user_id), '[]'::jsonb)
    into v_cached_versions from business_won_private.source_directory d;
  if v_versions is distinct from v_final_versions or v_final_versions is distinct from v_cached_versions then
    return v_refreshing;
  end if;

  if jsonb_array_length(v_jobs) > 1000 then
    raise exception 'Business Won Jobs exceeds the 1000 job limit; no jobs returned' using errcode = '54000';
  end if;
  if exists(select 1 from jsonb_array_elements(v_jobs) j where jsonb_array_length(j->'rows') > 200) then
    raise exception 'Business Won Jobs exceeds the 200 rows per job limit; no jobs returned' using errcode = '54000';
  end if;
  if (select coalesce(sum(jsonb_array_length(j->'rows')), 0) from jsonb_array_elements(v_jobs) j) > 5000 then
    raise exception 'Business Won Jobs exceeds the 5000 total rows limit; no jobs returned' using errcode = '54000';
  end if;
  if octet_length(v_jobs::text) > 2097152 then
    raise exception 'Business Won Jobs exceeds the 2 MiB output limit; no jobs returned' using errcode = '54000';
  end if;
  return jsonb_build_object('businessId', p_business_id, 'businessName', v_name, 'jobs', v_jobs);
end;
$$;

create or replace function public.read_business_won_jobs(p_business_id uuid)
returns jsonb language sql volatile security invoker set search_path = '' as $$
  select business_won_private.read_v1(p_business_id);
$$;

revoke all on all functions in schema business_won_private from public, anon, authenticated;
grant execute on function business_won_private.read_v1(uuid) to authenticated;
revoke all on function public.read_business_won_jobs(uuid) from public, anon, authenticated;
grant execute on function public.read_business_won_jobs(uuid) to authenticated;
