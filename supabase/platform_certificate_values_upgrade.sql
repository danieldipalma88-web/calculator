-- One authoritative spot-price record for every calculator.
-- Business calculator data continues to hold only the per-business agreement
-- deduction plus a compatibility snapshot of these platform fields.

create table if not exists public.platform_certificate_values (
  id text primary key default 'global',
  esc_spot_price numeric not null default 29,
  prc_spot_price numeric not null default 3,
  source text not null default 'Electric Future',
  locked boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by_email text,
  constraint platform_certificate_values_singleton_check check (id = 'global'),
  constraint platform_certificate_values_esc_positive_check check (esc_spot_price > 0),
  constraint platform_certificate_values_prc_positive_check check (prc_spot_price > 0),
  constraint platform_certificate_values_source_present_check check (length(btrim(source)) > 0)
);

alter table public.platform_certificate_values enable row level security;

do $$
declare
  candidate record;
  raw_value jsonb;
  certificate_value jsonb := null;
  seed_updated_at timestamptz := now();
begin
  if not exists (
    select 1
    from public.platform_certificate_values
    where id = 'global'
  ) then
    for candidate in
      select data, updated_at
      from public.business_calculator_data
      order by updated_at desc
    loop
      begin
        raw_value := coalesce(
          candidate.data -> 'installerCertificateValuesV1',
          candidate.data -> 'greenEnergyCertificateValuesV1',
          candidate.data -> 'CertificateValuesV1'
        );

        if jsonb_typeof(raw_value) = 'string' then
          certificate_value := (raw_value #>> '{}')::jsonb;
        elsif jsonb_typeof(raw_value) = 'object' then
          certificate_value := raw_value;
        else
          certificate_value := null;
        end if;

        if jsonb_typeof(certificate_value) = 'object'
          and coalesce(certificate_value ->> 'escSpotPrice', '') ~ '^[0-9]+([.][0-9]+)?$'
          and coalesce(certificate_value ->> 'prcSpotPrice', '') ~ '^[0-9]+([.][0-9]+)?$'
        then
          seed_updated_at := candidate.updated_at;
          exit;
        end if;
      exception when others then
        certificate_value := null;
      end;
    end loop;

    insert into public.platform_certificate_values (
      id,
      esc_spot_price,
      prc_spot_price,
      source,
      locked,
      updated_at
    )
    values (
      'global',
      case
        when coalesce(certificate_value ->> 'escSpotPrice', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (certificate_value ->> 'escSpotPrice')::numeric
        else 29
      end,
      case
        when coalesce(certificate_value ->> 'prcSpotPrice', '') ~ '^[0-9]+([.][0-9]+)?$'
          then (certificate_value ->> 'prcSpotPrice')::numeric
        else 3
      end,
      coalesce(nullif(btrim(certificate_value ->> 'source'), ''), 'Electric Future'),
      case
        when lower(coalesce(certificate_value ->> 'locked', 'true')) = 'false' then false
        else true
      end,
      seed_updated_at
    )
    on conflict (id) do nothing;
  end if;
end
$$;

drop policy if exists "authenticated users can read platform certificate values"
on public.platform_certificate_values;
create policy "authenticated users can read platform certificate values"
on public.platform_certificate_values
for select
to authenticated
using (true);

drop policy if exists "admins can manage platform certificate values"
on public.platform_certificate_values;
create policy "admins can manage platform certificate values"
on public.platform_certificate_values
for all
to authenticated
using (public.is_approved_admin())
with check (public.is_approved_admin());

grant select on public.platform_certificate_values to authenticated;
grant insert, update, delete on public.platform_certificate_values to authenticated;

