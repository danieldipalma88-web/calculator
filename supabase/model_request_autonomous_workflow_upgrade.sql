-- Incremental SQL for review, after model_request_research_upgrade.sql.
-- Drain old workers/provider sends before applying. Install defaults paused;
-- after app deployment and approval, the DB owner separately activates with:
-- update model_automation_private.settings set autonomous_workflow_enabled=true where singleton;
-- No row backfill or paid work runs at install.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

alter table model_automation_private.research_jobs
  add column if not exists next_attempt_at timestamptz,
  add column if not exists workflow_retries integer not null default 0,
  add column if not exists completion_suppressed boolean not null default false;
alter table model_automation_private.settings
  add column if not exists autonomous_workflow_enabled boolean not null default false,
  add column if not exists research_provider_blocked boolean not null default false;

create table if not exists model_automation_private.research_case_links (
  duplicate_id uuid primary key references public.calculator_model_requests(id) on delete cascade,
  canonical_id uuid not null references public.calculator_model_requests(id) on delete cascade,
  duplicate_details jsonb not null,
  duplicate_version integer,
  linked_at timestamptz not null default now(),
  check(duplicate_id<>canonical_id)
);
create index if not exists research_case_canonical_idx
  on model_automation_private.research_case_links(canonical_id);
create index if not exists research_case_owner_idx
  on public.calculator_model_requests(user_id,business_id,created_at,id);
create index if not exists research_case_mail_idx
  on model_automation_private.mail_outbox(request_id,kind);
alter table model_automation_private.research_case_links enable row level security;
revoke all on model_automation_private.research_case_links from public,anon,authenticated;

-- Serialize short case/contact and provider reservation/pause decisions, never
-- network calls or settlement. Lock request -> legacy job -> research/outbox.
create or replace function model_automation_private.workflow_lock() returns void
language sql security invoker set search_path='' as $$
  select pg_advisory_xact_lock(546561296,804125116);
$$;
create or replace function model_automation_private.workflow_intake() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform model_automation_private.workflow_lock();
  new.created_at:=clock_timestamp();
  return new;
end; $$;
drop trigger if exists a_model_workflow_intake on public.calculator_model_requests;
-- Runs after existing quota and authorization checks and timestamps actual
-- insertion order, not the start of a transaction waiting on the case lock.
drop trigger if exists z_model_workflow_intake on public.calculator_model_requests;
create trigger z_model_workflow_intake before insert on public.calculator_model_requests
  for each row execute function model_automation_private.workflow_intake();

create or replace function model_automation_private.workflow_normal(p_text text) returns text
language sql immutable security invoker set search_path='' as $$
  select lower(btrim(regexp_replace(coalesce(p_text,''),'[[:space:]]+',' ','g')));
$$;
create or replace function model_automation_private.workflow_details(r public.calculator_model_requests) returns jsonb
language sql immutable security invoker set search_path='' as $$
  select jsonb_build_array(lower(r.requester_email),r.system_type,
    model_automation_private.workflow_normal(r.brand),model_automation_private.workflow_normal(r.model),
    model_automation_private.workflow_normal(r.capacity),r.phase,r.postcode,r.install_type,
    model_automation_private.workflow_normal(r.notes));
$$;
create or replace function model_automation_private.workflow_canonical(p_id uuid) returns uuid
language sql stable security invoker set search_path='' as $$
  select l.canonical_id from model_automation_private.research_case_links l
    join public.calculator_model_requests d on d.id=l.duplicate_id
    join public.calculator_model_requests c on c.id=l.canonical_id
    left join model_automation_private.research_requests h on h.request_id=d.id
    where l.duplicate_id=p_id and c.user_id=d.user_id and c.business_id=d.business_id
      and lower(c.requester_email)=lower(d.requester_email)
      and l.duplicate_details=model_automation_private.workflow_details(d)
      and l.duplicate_version is not distinct from h.version
      and model_automation_private.can_contact_request(d.id) and model_automation_private.can_contact_request(c.id);
$$;

create or replace function model_automation_private.workflow_case_members(p_id uuid) returns table(request_id uuid)
language sql stable security invoker set search_path='' as $$
  select c.id from public.calculator_model_requests r
    join public.calculator_model_requests c on c.user_id=r.user_id and c.business_id=r.business_id
    left join public.calculator_model_request_jobs j on j.request_id=c.id
    left join model_automation_private.research_requests h on h.request_id=c.id
    left join model_automation_private.research_requests d on d.request_id=r.id
    where r.id=p_id and (c.id=r.id or model_automation_private.workflow_canonical(c.id)=r.id
      or ((c.created_at,c.id)>(r.created_at,r.id) and c.status in ('new','reviewing')
        and j.contact_state is distinct from 'closed' and j.state in ('queued','checking','researching','review')
        and model_automation_private.workflow_canonical(c.id) is null
        and model_automation_private.workflow_details(c)=model_automation_private.workflow_details(r)
        and coalesce(h.messages,'[]')=coalesce(d.messages,'[]')
        and (h.request_id is not null or not exists(select 1 from jsonb_array_elements(j.activity) e
          where e->>'kind' in ('response_received','escalated')))
        and model_automation_private.can_contact_request(c.id)));
$$;

create or replace function model_automation_private.workflow_live_mail(p_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from model_automation_private.mail_outbox
    where request_id=p_id and state='sending' and lease_until>now());
$$;
create or replace function model_automation_private.workflow_cancel_contact(p_id uuid) returns void
language sql security invoker set search_path='' as $$
  update model_automation_private.mail_outbox
    set state=case when started_at is null then 'cancelled' else 'failed' end,lease=null,lease_until=null
    where request_id=p_id and kind in ('question','reminder','escalation')
      and state in ('pending','sending') and (lease_until is null or lease_until<=now());
$$;

-- Called under workflow_lock, with the submitted request and its job locked.
-- Do not displace active historical leases or overwrite completed decisions.
create or replace function model_automation_private.workflow_link(p_id uuid) returns uuid
language plpgsql security invoker set search_path='' as $$
declare r public.calculator_model_requests%rowtype; v_id uuid; v_version integer;
begin
  v_id:=model_automation_private.workflow_canonical(p_id);
  if v_id is not null then return v_id; end if;
  select * into r from public.calculator_model_requests where id=p_id;
  if not found or r.status not in ('new','reviewing') or r.system_type not in ('split','ducted')
    or not model_automation_private.can_contact_request(p_id)
    or exists(select 1 from model_automation_private.research_jobs where external_id=p_id and lease_until>now())
    or exists(select 1 from public.calculator_model_request_jobs where request_id=p_id and lease_until>now())
    or model_automation_private.workflow_live_mail(p_id) then return null; end if;
  select version into v_version from model_automation_private.research_requests where request_id=p_id;
  select coalesce(model_automation_private.workflow_canonical(c.id),c.id) into v_id from public.calculator_model_requests c
    left join public.calculator_model_request_jobs j on j.request_id=c.id
    left join model_automation_private.research_requests h on h.request_id=c.id
    left join model_automation_private.research_requests d on d.request_id=r.id
    where c.user_id=r.user_id and c.business_id=r.business_id and (c.created_at,c.id)<(r.created_at,r.id)
      and model_automation_private.workflow_details(c)=model_automation_private.workflow_details(r)
      and coalesce(h.messages,'[]')=coalesce(d.messages,'[]')
      -- Uncaptured legacy replies are not presumed identical.
      and (h.request_id is not null or not exists(select 1 from jsonb_array_elements(j.activity) e
        where e->>'kind' in ('response_received','escalated')))
      and (d.request_id is not null or not exists(select 1 from public.calculator_model_request_jobs k,
        lateral jsonb_array_elements(k.activity) e where k.request_id=r.id and e->>'kind' in ('response_received','escalated')))
      and model_automation_private.can_contact_request(c.id)
      and (model_automation_private.workflow_canonical(c.id) is null or c.status in ('added','no_rebate'))
      and ( (c.status in ('new','reviewing') and (j.state is null or j.state in ('queued','checking','researching','review'))
               and j.contact_state is distinct from 'closed')
         or (c.status in ('added','no_rebate') and j.state=c.status and exists(
           select 1 from model_automation_private.research_jobs q
            where q.external_id=c.id and q.round=h.version and q.state in ('complete','no_rebate') and q.applied_at is not null)) )
    order by c.created_at,c.id limit 1;
  if v_id is null then return null; end if;
  insert into model_automation_private.research_case_links(duplicate_id,canonical_id,duplicate_details,duplicate_version)
    values(p_id,v_id,model_automation_private.workflow_details(r),v_version)
    on conflict(duplicate_id) do update set canonical_id=excluded.canonical_id,
      duplicate_details=excluded.duplicate_details,duplicate_version=excluded.duplicate_version,linked_at=now();
  perform model_automation_private.workflow_cancel_contact(p_id);
  update model_automation_private.research_jobs set state='superseded',lease=null,lease_until=null,updated_at=now()
    where external_id=p_id and state in ('queued','researching','pending_verification','waiting_for_details','review','budget_paused')
      and applied_at is null;
  return v_id;
end; $$;

create or replace function model_automation_private.workflow_unreconciled(p_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from model_automation_private.research_jobs j
    join model_automation_private.research_costs c on c.job_id=j.id
    where j.external_id=p_id and (c.state in ('pending','uncertain') or
      (c.state='settled' and c.step>coalesce((j.checkpoint->>'round')::integer,0))));
$$;
create or replace function model_automation_private.workflow_authorized(p_secret text) returns void
language plpgsql security invoker set search_path='' as $$
begin
  if length(coalesce(p_secret,''))<40 or not exists(select 1 from model_automation_private.settings
    where secret_hash=sha256(convert_to(p_secret,'UTF8'))) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
end; $$;
create or replace function model_automation_private.workflow_enabled() returns boolean
language sql stable security invoker set search_path='' as $$
  select coalesce((select autonomous_workflow_enabled from model_automation_private.settings where singleton),false);
$$;

create or replace function model_automation_private.workflow_completion_suppressed(p_id uuid) returns boolean
language sql stable security invoker set search_path='' as $$
  select exists(select 1 from model_automation_private.research_jobs j
    join model_automation_private.research_requests h on h.request_id=j.external_id and h.version=j.round
    where j.external_id=p_id and j.completion_suppressed);
$$;

create or replace function model_automation_private.workflow_completion_allowed(p_id uuid,p_started timestamptz) returns boolean
language sql stable security invoker set search_path='' as $$
  select not model_automation_private.workflow_completion_suppressed(p_id)
    and (p_started is not null or model_automation_private.workflow_canonical(p_id) is null);
$$;

-- Match the complete registered code or exact pair (including reversed order).
-- One component alone cannot disambiguate a package from a registered pair.
create or replace function model_automation_private.workflow_registry_matches(r public.calculator_model_requests,p_registry jsonb) returns boolean
language sql immutable security invoker set search_path='' as $$
  with codes as (
    select array(select upper(btrim(code)) from unnest(string_to_array(r.model,'/')) code order by 1) as requested,
      array(select upper(btrim(code)) from unnest(string_to_array(p_registry->>'model','/')) code order by 1) as registered
  )
  select coalesce(jsonb_typeof(p_registry->'registrationNumber')='string'
    and nullif(btrim(p_registry->>'registrationNumber'),'') is not null
    and upper(btrim(r.brand))=upper(btrim(p_registry->>'brand'))
    and cardinality(registered) in (1,2)
    and (cardinality(registered)=1 or registered[1]<>registered[2])
    and not exists(select 1 from unnest(registered) code where code !~ '^[A-Z0-9][A-Z0-9 ._+()-]*$')
    and requested=registered,false)
  from codes;
$$;

-- Distinct note histories only merge after both current rounds independently
-- verify the same exact registration, specs, installation and outcome.
create or replace function model_automation_private.workflow_link_verified(p_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare
  r public.calculator_model_requests%rowtype; j model_automation_private.research_jobs%rowtype;
  v_canonical uuid; v_members uuid[]; v_delivery uuid;
begin
  select * into j from model_automation_private.research_jobs where id=p_id;
  if j.state not in ('complete','no_rebate') or j.applied_at is null
    or nullif(j.applied_outcome#>>'{evidence,verification,registry,registrationNumber}','') is null then return; end if;
  select * into r from public.calculator_model_requests where id=j.external_id;
  select array_agg(c.id order by c.created_at,c.id) into v_members
    from public.calculator_model_requests c
    join public.calculator_model_request_jobs l on l.request_id=c.id
    join model_automation_private.research_requests h on h.request_id=c.id
    join model_automation_private.research_jobs q on q.external_id=c.id and q.round=h.version
    where c.user_id=r.user_id and c.business_id=r.business_id and lower(c.requester_email)=lower(r.requester_email)
      and c.system_type=r.system_type and c.postcode=r.postcode and c.install_type=r.install_type
      and c.status=r.status and l.state=c.status and model_automation_private.can_contact_request(c.id)
      and q.state=j.state and q.applied_at is not null
      and q.applied_outcome->>'kind'=j.applied_outcome->>'kind'
      and q.applied_outcome#>>'{evidence,verification,registry,registrationNumber}'=j.applied_outcome#>>'{evidence,verification,registry,registrationNumber}'
      and q.applied_outcome#>>'{product,systemType}'=j.applied_outcome#>>'{product,systemType}'
      and model_automation_private.workflow_normal(q.applied_outcome#>>'{product,brand}')=model_automation_private.workflow_normal(j.applied_outcome#>>'{product,brand}')
      and model_automation_private.workflow_normal(q.applied_outcome#>>'{product,model}')=model_automation_private.workflow_normal(j.applied_outcome#>>'{product,model}')
      and q.applied_outcome#>'{product,phase}'=j.applied_outcome#>'{product,phase}'
      and q.applied_outcome#>'{product,capacityKw}'=j.applied_outcome#>'{product,capacityKw}';
  if coalesce(cardinality(v_members),0)<2 then return; end if;
  v_canonical:=v_members[1];
  select d.request_id into v_delivery from (
    select l.request_id,l.email_started_at as started,l.email_state='sent' as sent
      from public.calculator_model_request_jobs l
      where j.state='complete' and l.request_id=any(v_members) and l.state='added'
        and (l.email_started_at is not null or l.email_state='sent')
    union all
    select m.request_id,m.started_at,m.state='sent' from model_automation_private.mail_outbox m
      join model_automation_private.research_requests h on h.request_id=m.request_id and h.version=m.research_version
      where j.state='no_rebate' and m.request_id=any(v_members) and m.kind='no_rebate'
        and (m.started_at is not null or m.state='sent')
  ) d order by d.sent desc,d.started nulls last,array_position(v_members,d.request_id) limit 1;
  v_delivery:=coalesce(v_delivery,v_canonical);
  -- Keep canonical case ownership separate from an already-authorized delivery.
  -- In particular, never move a retry onto a different provider key.
  insert into model_automation_private.research_case_links(duplicate_id,canonical_id,duplicate_details,duplicate_version)
    select c.id,v_canonical,model_automation_private.workflow_details(c),h.version
    from public.calculator_model_requests c join model_automation_private.research_requests h on h.request_id=c.id
    where c.id=any(v_members) and c.id<>v_canonical
    on conflict(duplicate_id) do update set canonical_id=excluded.canonical_id,
      duplicate_details=excluded.duplicate_details,duplicate_version=excluded.duplicate_version
    where research_case_links.canonical_id is distinct from excluded.canonical_id;
  update model_automation_private.research_jobs q set completion_suppressed=(q.external_id<>v_delivery)
    from model_automation_private.research_requests h where q.external_id=h.request_id and q.round=h.version
      and q.external_id=any(v_members) and q.state=j.state
      and q.completion_suppressed is distinct from (q.external_id<>v_delivery);
  update model_automation_private.mail_outbox m set state=case when m.started_at is null then 'cancelled' else 'failed' end,
    lease=null,lease_until=null
    where m.request_id=any(v_members) and m.kind='no_rebate' and m.state in ('pending','sending')
      and (m.lease_until is null or m.lease_until<=now())
      and model_automation_private.workflow_completion_suppressed(m.request_id);
  perform model_automation_private.workflow_cancel_contact(member.id) from unnest(v_members) member(id);
end; $$;

do $$
begin
  if to_regprocedure('model_automation_private.research_worker_before_workflow(text,text,uuid,uuid,jsonb)') is null then
    alter function model_automation_private.research_worker(text,text,uuid,uuid,jsonb) rename to research_worker_before_workflow;
  end if;
  if to_regprocedure('model_automation_private.request_self_before_workflow(uuid,jsonb)') is null then
    alter function model_automation_private.request_self(uuid,jsonb) rename to request_self_before_workflow;
  end if;
end; $$;
revoke all on function model_automation_private.research_worker_before_workflow(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function model_automation_private.request_self_before_workflow(uuid,jsonb) from public,anon,authenticated;

create or replace function model_automation_private.research_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  r public.calculator_model_requests%rowtype; l public.calculator_model_request_jobs%rowtype;
  j model_automation_private.research_jobs%rowtype;
  v_id uuid; v_version integer; v_snapshot jsonb; v_fingerprint text; v jsonb; candidate record;
  v_blocked boolean; v_review_candidate boolean:=false; v_registry jsonb;
  v_outcome jsonb:=p_data->'outcome';
  v_kind text:=v_outcome->>'kind';
begin
  perform model_automation_private.workflow_authorized(p_secret);
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid research data'; end if;
  if p_action in ('enqueue','restore_prepaid','claim','apply_result','retry_research','confirmation_claim','reserve','pause_provider') then
    perform model_automation_private.workflow_lock();
    if p_action<>'pause_provider' and not model_automation_private.workflow_enabled() then
      if p_action='reserve' then raise exception 'Model workflow paused'; end if;
      if p_action in ('apply_result','retry_research') then return jsonb_build_object('state','paused'); end if;
      return null;
    end if;
  end if;
  select research_provider_blocked into v_blocked from model_automation_private.settings where singleton;
  if p_action in ('enqueue','claim') and v_blocked then return null; end if;
  if p_action='reserve' and v_blocked then raise exception 'Research provider is paused'; end if;
  if p_action='budget' then
    return model_automation_private.research_worker_before_workflow(p_secret,p_action,p_id,p_lease,p_data)
      ||jsonb_build_object('researchProviderBlocked',v_blocked);
  end if;
  if p_action='get' and v_blocked then
    v:=model_automation_private.research_worker_before_workflow(p_secret,p_action,p_id,p_lease,p_data);
    if v->>'state' in ('queued','researching','review') and v->>'applied_at' is null then
      v:=v||jsonb_build_object('result',coalesce(nullif(v->'result','null'::jsonb),'{}'::jsonb)
        ||jsonb_build_object('researchPaused',true));
    end if;
    return v;
  end if;
  if p_action='enqueue' then
    -- Inspect at most a small batch under the case lock. Stalled legacy work
    -- without research is recovered once; already applied reviews stay put.
    for candidate in
      select request.id from public.calculator_model_requests request
      left join public.calculator_model_request_jobs legacy on legacy.request_id=request.id
      left join model_automation_private.research_requests h on h.request_id=request.id
      left join model_automation_private.research_jobs job on job.external_id=request.id and job.round=h.version
      where (p_id is null or request.id=p_id)
        and request.status in ('new','reviewing') and request.system_type in ('split','ducted')
        and (legacy.state is null or legacy.state in ('queued','checking','researching','review')) and legacy.contact_state is distinct from 'closed'
        and (legacy.lease_until is null or legacy.lease_until<=now())
        and (job.lease_until is null or job.lease_until<=now())
        and not model_automation_private.workflow_live_mail(request.id)
        and model_automation_private.can_contact_request(request.id)
        and model_automation_private.workflow_canonical(request.id) is null
        and not model_automation_private.workflow_unreconciled(request.id)
        and ((p_id is not null and p_data->>'retry'='true' and legacy.state='review')
          or legacy.request_id is null
          or (legacy.state='queued' and legacy.available_at<=now()
            and (job.id is null or job.applied_at is null or
              (legacy.reviewed_at>=job.updated_at and nullif(legacy.reviewed_by,'') is not null)))
          or (job.id is null and (legacy.state in ('checking','researching','review')) and legacy.available_at<=now())
          or (job.applied_at is null and (job.next_attempt_at is null or job.next_attempt_at<=now())
            and job.state in ('queued','researching','pending_verification','waiting_for_details','review','budget_paused'))
          or (job.state='review' and job.result->>'outcome'='candidate'
            and job.applied_outcome#>'{evidence,temporaryVerificationFailure}'='true'::jsonb))
      order by coalesce(legacy.available_at,request.created_at),request.created_at,request.id limit 16
    loop
      select * into r from public.calculator_model_requests where id=candidate.id for update skip locked;
      if not found or r.status not in ('new','reviewing') then continue; end if;
      insert into public.calculator_model_request_jobs(request_id) values(r.id) on conflict do nothing;
      select * into l from public.calculator_model_request_jobs where request_id=r.id for update skip locked;
      if not found or l.state not in ('queued','checking','researching','review') or l.contact_state='closed'
        or l.lease_until>now() or not model_automation_private.can_contact_request(r.id)
        or model_automation_private.workflow_live_mail(r.id) or model_automation_private.workflow_unreconciled(r.id)
        then continue; end if;
      if model_automation_private.workflow_link(r.id) is not null then continue; end if;
      select version into v_version from model_automation_private.research_requests where request_id=r.id;
      select * into j from model_automation_private.research_jobs where external_id=r.id and round=v_version for update;
      if j.lease_until>now() then continue; end if;
      if j.state='review' and j.result->>'outcome'='candidate'
        and j.applied_outcome#>'{evidence,temporaryVerificationFailure}'='true'::jsonb then
        update model_automation_private.research_jobs set state='pending_verification',applied_at=null,applied_outcome=null,
          next_attempt_at=null,updated_at=now() where id=j.id;
        update public.calculator_model_request_jobs set state='researching',contact_state=null,contact_next_at=null,
          reason='',lease_token=null,lease_until=null,updated_at=now() where request_id=r.id;
        insert into model_automation_private.research_events(job_id,kind,detail)
          values(j.id,'recovered','Resuming verification after historical temporary failure');
        return model_automation_private.research_job(j.id);
      end if;
      if j.id is null then
        perform model_automation_private.workflow_cancel_contact(r.id);
        update public.calculator_model_request_jobs set state='queued',contact_state=null,contact_next_at=null,
          lease_until=null,lease_token=null,available_at=now(),updated_at=now(),
          activity=case when l.state='queued' then activity else activity||model_automation_private.event('recovered',l.reason) end
          where request_id=r.id;
      end if;
      v:=model_automation_private.research_worker_before_workflow(p_secret,'enqueue',r.id,p_lease,p_data);
      if v is not null and (v->>'next_attempt_at' is null or (v->>'next_attempt_at')::timestamptz<=now()) then return v; end if;
    end loop;
    return null;
  elsif p_action='confirmation_claim' then
    for candidate in select request_id from public.calculator_model_request_jobs where (p_id is null or request_id=p_id)
      and state='added' and email_state in ('pending','sending') and available_at<=now()
      and (lease_until is null or lease_until<=now())
      and model_automation_private.workflow_completion_allowed(request_id,email_started_at)
      order by available_at,request_id limit 16 loop
      v:=model_automation_private.research_worker_before_workflow(p_secret,p_action,candidate.request_id,p_lease,p_data);
      if v is not null then return v; end if;
    end loop;
    return null;
  elsif p_action='claim' then
    for candidate in select id,external_id from model_automation_private.research_jobs
      where (p_id is null or id=p_id) and (next_attempt_at is null or next_attempt_at<=now())
        and (state='queued' or (state='researching' and lease_until<=now()))
        and model_automation_private.workflow_canonical(external_id) is null
      order by created_at,id limit 16 loop
      perform 1 from public.calculator_model_requests where id=candidate.external_id and status in ('new','reviewing') for update skip locked;
      if not found then continue; end if;
      perform 1 from public.calculator_model_request_jobs where request_id=candidate.external_id
        and state='researching' and contact_state is distinct from 'closed' for update skip locked;
      if not found or model_automation_private.workflow_link(candidate.external_id) is not null then continue; end if;
      v:=model_automation_private.research_worker_before_workflow(p_secret,p_action,candidate.id,p_lease,p_data);
      if v is not null then return v; end if;
    end loop;
    return null;
  elsif p_action in ('apply_result','retry_research','pause_provider') then
    select external_id into v_id from model_automation_private.research_jobs where id=p_id;
    if not found then raise exception 'Unknown research job'; end if;
    select * into r from public.calculator_model_requests where id=v_id for update;
    select * into l from public.calculator_model_request_jobs where request_id=v_id for update;
    select * into j from model_automation_private.research_jobs where id=p_id for update;
    if (j.applied_at is null and model_automation_private.workflow_canonical(v_id) is not null) or
      (j.applied_at is null and (r.status not in ('new','reviewing') or l.contact_state='closed'
        or model_automation_private.workflow_link(v_id) is not null)) then
      return jsonb_build_object('state','superseded');
    end if;
    if j.applied_at is null and model_automation_private.workflow_live_mail(v_id) then
      return jsonb_build_object('state',j.state,'next_attempt_at',now()+interval '2 minutes');
    end if;
    if p_action='pause_provider' then
      if j.state<>'researching' or j.applied_at is not null or p_lease is null or j.lease is distinct from p_lease
        or j.lease_until is null or j.lease_until<=now() or l.state is distinct from 'researching'
        or not model_automation_private.can_contact_request(v_id) then
        raise exception 'Research lease is no longer current' using errcode='40001'; end if;
      v_snapshot:=model_automation_private.research_snapshot(v_id);
      if not exists(select 1 from model_automation_private.research_rounds rr where rr.external_id=v_id and rr.round=j.round
        and rr.request=v_snapshot and rr.fingerprint=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex')) then
        raise exception 'Research snapshot is no longer current' using errcode='40001'; end if;
      if exists(select 1 from model_automation_private.research_costs where job_id=p_id and state='pending') then
        raise exception 'Provider call requires reconciliation'; end if;
      if exists(select 1 from model_automation_private.research_costs where job_id=p_id and state='uncertain') then
        -- Keep the unknown charge reserved and never release the job to claim.
        update model_automation_private.research_jobs set state='review',lease=null,lease_until=null,updated_at=now() where id=p_id;
        update public.calculator_model_request_jobs set state='review',lease_token=null,lease_until=null,
          reason='Research provider usage needs reconciliation before further paid calls.',updated_at=now()
          where request_id=v_id;
      else
        perform model_automation_private.research_worker_before_workflow(p_secret,'yield',p_id,p_lease,'{}');
      end if;
      update model_automation_private.settings set research_provider_blocked=true where singleton;
      insert into model_automation_private.research_events(job_id,kind,detail)
        values(p_id,'provider_paused',left(coalesce(p_data->>'reason','Research provider paused'),600));
      return model_automation_private.research_worker(p_secret,'get',p_id,null,'{}');
    end if;
    if p_action='retry_research' or v_kind='retry_verification'
      or (v_kind='review' and v_outcome#>'{evidence,temporaryVerificationFailure}'='true'::jsonb) then
      if not model_automation_private.can_contact_request(v_id) then return jsonb_build_object('state','superseded'); end if;
      v_snapshot:=model_automation_private.research_snapshot(v_id);
      if v_snapshot is distinct from (select request from model_automation_private.research_rounds
        where external_id=v_id and round=j.round) then return jsonb_build_object('state','superseded'); end if;
      if p_action='retry_research' then
        -- The existing yield RPC validates the lease and all cost/checkpoint states.
        perform model_automation_private.research_worker_before_workflow(p_secret,'yield',p_id,p_lease,'{}');
      elsif not ((j.state='pending_verification' and j.result->>'outcome' is not distinct from 'candidate')
        or (j.state='review' and j.result->>'outcome' is not distinct from 'review'))
        or j.applied_at is not null or j.lease is not null or l.state not in ('researching','review') then
        raise exception 'Research outcome is not ready for verification retry';
      end if;
      if p_action='retry_research' or j.next_attempt_at is null or j.next_attempt_at<=now() then
        update model_automation_private.research_jobs set next_attempt_at=now()
          + make_interval(mins=>least(240,5*(1<<least(workflow_retries,6)))),
          workflow_retries=least(workflow_retries+1,7),updated_at=now() where id=p_id returning * into j;
        insert into model_automation_private.research_events(job_id,kind,detail)
          values(p_id,'retry_deferred',left(coalesce(v_outcome->>'reason',p_data->>'reason','Temporary service failure'),600));
      end if;
      return jsonb_build_object('state',j.state,'next_attempt_at',j.next_attempt_at);
    end if;
    if j.applied_at is null and j.next_attempt_at>now() then
      return jsonb_build_object('state',j.state,'next_attempt_at',j.next_attempt_at);
    end if;
    if j.applied_at is null and j.state='review' and model_automation_private.workflow_unreconciled(v_id) then
      return jsonb_build_object('state','review','researchPaused',true);
    end if;
    if j.applied_at is null and j.state='review' and j.result->>'outcome'='review'
      and v_kind in ('needs_details','ready_to_add','no_rebate') then
      v_snapshot:=model_automation_private.research_snapshot(v_id);
      v_fingerprint:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
      -- Leave stale outcomes to the deployed snapshot fence. Otherwise adapt the
      -- review to its equivalent verification state inside this transaction.
      if exists(select 1 from model_automation_private.research_rounds rr where rr.external_id=v_id and rr.round=j.round
        and rr.request=v_snapshot and rr.fingerprint=v_fingerprint) then
        if j.lease is not null or j.lease_until>now() or l.state not in ('researching','review')
          or l.contact_state is not null or not model_automation_private.can_contact_request(v_id) then
          raise exception 'Research outcome is not ready to apply'; end if;
        v_registry:=v_outcome#>'{evidence,verification,registry}';
        if not model_automation_private.workflow_registry_matches(r,v_registry) then
          raise exception 'Review verification is not bound to the original exact registry match'; end if;
        if v_kind='needs_details' then
          if v_outcome#>>'{evidence,verification,kind}' is distinct from 'clarify'
            or (r.postcode~'^[0-9]{4}$' and r.postcode<>'0000' and r.install_type in ('new','replacement')) then
            raise exception 'Verified review is not missing installation details'; end if;
          update model_automation_private.research_jobs set state='waiting_for_details' where id=p_id;
        else
          if v_outcome#>>'{product,systemType}' is distinct from r.system_type
            or v_outcome#>>'{evidence,verification,postcode}' is distinct from r.postcode
            or v_outcome#>>'{evidence,verification,installType}' is distinct from r.install_type
            or r.postcode!~'^[0-9]{4}$' or r.postcode='0000' or r.install_type not in ('new','replacement')
            or coalesce(v_outcome#>>'{product,phase}','') not in ('Single','Three')
            or jsonb_typeof(v_outcome#>'{product,capacityKw}') is distinct from 'number' then
            raise exception 'Deterministic review outcome requires matching installation and model specs'; end if;
          v_review_candidate:=true;
          update model_automation_private.research_jobs set state='pending_verification',result=jsonb_build_object(
            'outcome','candidate','canonical',jsonb_build_object('brand',v_registry->'brand','model',v_registry->'model',
              'registrationNumber',v_registry->'registrationNumber','systemType',r.system_type,
              'phase',v_outcome#>'{product,phase}','capacityKw',v_outcome#>'{product,capacityKw}')) where id=p_id;
        end if;
      end if;
    end if;
    v:=model_automation_private.research_worker_before_workflow(p_secret,p_action,p_id,p_lease,p_data);
    if v_review_candidate then
      -- The original investigation remains the durable result; verifier proof
      -- is retained separately in the applied outcome.
      update model_automation_private.research_jobs set result=j.result where id=p_id;
    end if;
    if v->>'state' in ('added','no_rebate') then
      perform model_automation_private.workflow_link_verified(p_id);
    end if;
    if v->>'state'='review' and v_outcome->>'kind'='review' and v_outcome->'registry_match_unverified'='true'::jsonb
      and j.state in ('review','pending_verification','waiting_for_details')
      and j.result->>'outcome' in ('candidate','needs_details','review')
      and model_automation_private.can_contact_request(v_id)
      and not model_automation_private.workflow_unreconciled(v_id)
      and not exists(select 1 from model_automation_private.mail_outbox m
        where m.mail_key like 'registry-unverified/%'
          and m.request_id in (select request_id from model_automation_private.workflow_case_members(v_id))
          and (m.started_at is not null or m.state='sent' or (m.request_id=v_id and m.state='pending' and m.research_version=j.round))) then
      insert into model_automation_private.mail_outbox(mail_key,request_id,round,kind,recipient,payload,research_job_id,research_version,research_fingerprint)
        select 'registry-unverified/'||v_id||'/'||j.round,v_id,j.round,'escalation','danieldipalma88@gmail.com',
          jsonb_build_object('registry_unverified',true,'brand',r.brand,'model',r.model,
            'requester',r.requester_name,'business',r.business_name,'submitted',r.created_at,'reason',left(v_outcome->>'reason',600)),
          j.id,j.round,s.fingerprint
        from model_automation_private.research_rounds s where s.external_id=v_id and s.round=j.round on conflict do nothing;
    end if;
    return v;
  end if;
  return model_automation_private.research_worker_before_workflow(p_secret,p_action,p_id,p_lease,p_data);
end; $$;
revoke all on function model_automation_private.research_worker(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function model_automation_private.research_worker(text,text,uuid,uuid,jsonb) to anon;
create or replace function public.model_request_research_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.research_worker(p_secret,p_action,p_id,p_lease,p_data); $$;

-- Old deployments may still confirm completed, verified work. They cannot
-- claim research, clarify, or invoke the private publishing action directly.
create or replace function model_automation_private.workflow_legacy_confirmation(p_secret text,p_action text,p_id uuid,p_lease uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform model_automation_private.workflow_authorized(p_secret);
  if p_action='claim' then return model_automation_private.research_worker(p_secret,'confirmation_claim',p_id,null,'{}'); end if;
  if p_action in ('email_start','email_sent','email_error') then
    perform model_automation_private.workflow_lock();
    if p_action='email_start' then
      if not model_automation_private.workflow_enabled() then raise exception 'Model workflow paused'; end if;
      if not model_automation_private.workflow_completion_allowed(p_id,
        (select email_started_at from public.calculator_model_request_jobs where request_id=p_id)) then
        raise exception 'Duplicate completion suppressed'; end if;
    end if;
    return model_automation_private.worker(p_secret,p_action,p_id,p_lease,p_data);
  end if;
  raise exception 'Legacy research worker retired';
end; $$;
revoke all on function model_automation_private.worker(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function model_automation_private.workflow_legacy_confirmation(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function model_automation_private.workflow_legacy_confirmation(text,text,uuid,uuid,jsonb) to anon;
create or replace function public.model_request_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.workflow_legacy_confirmation(p_secret,p_action,p_id,p_lease,p_data); $$;

do $$
begin
  if to_regprocedure('model_automation_private.contact_worker_before_workflow(text,text,uuid,uuid,jsonb)') is null then
    alter function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) rename to contact_worker_before_workflow;
  end if;
  if to_regprocedure('model_automation_private.clarify_before_workflow(uuid,uuid,jsonb)') is null then
    alter function model_automation_private.clarify(uuid,uuid,jsonb) rename to clarify_before_workflow;
  end if;
end; $$;
revoke all on function model_automation_private.contact_worker_before_workflow(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function model_automation_private.clarify_before_workflow(uuid,uuid,jsonb) from public,anon,authenticated;

create or replace function model_automation_private.workflow_prior_contact(
  p_id uuid,p_kind text,p_question text,p_day text,p_key text default null
) returns integer
language sql stable security invoker set search_path='' as $$
  select m.round from model_automation_private.mail_outbox m
    where m.kind=p_kind and m.mail_key is distinct from p_key
      and m.request_id in (select request_id from model_automation_private.workflow_case_members(p_id))
      and (m.started_at is not null or m.state='sent')
      and model_automation_private.workflow_normal(m.payload->>'question')=model_automation_private.workflow_normal(p_question)
      and m.payload->>'day' is not distinct from p_day
    order by (m.request_id=p_id) desc,m.round desc limit 1;
$$;

create or replace function model_automation_private.clarify(p_id uuid,p_lease uuid,p_data jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare j public.calculator_model_request_jobs%rowtype; v_round integer;
begin
  select * into j from public.calculator_model_request_jobs where request_id=p_id for update;
  if not found or j.state<>'checking' or p_lease is null or j.lease_token is distinct from p_lease
    or j.lease_until is null or j.lease_until<=now() then raise exception 'Job lease expired'; end if;
  v_round:=model_automation_private.workflow_prior_contact(p_id,'question',left(p_data->>'reason',600),null);
  if v_round is not null and model_automation_private.can_contact_request(p_id) then
    -- Keep the reply form available, without creating or reopening a send.
    update public.calculator_model_request_jobs set state='review',contact_state='waiting',contact_next_at=null,contact_round=greatest(contact_round,1),
      contact_question=left(p_data->>'reason',600),contact_candidates=coalesce(p_data->'candidates','[]'),
      reason='Details already requested',lease_token=null,lease_until=null,
      activity=activity||model_automation_private.event('question_suppressed','The same question was already attempted'),
      updated_at=now() where request_id=p_id;
    update public.calculator_model_requests set status='reviewing',updated_at=now() where id=p_id;
    return;
  end if;
  perform model_automation_private.clarify_before_workflow(p_id,p_lease,p_data);
end; $$;
revoke all on function model_automation_private.clarify(uuid,uuid,jsonb) from public,anon,authenticated;

create or replace function model_automation_private.contact_worker(p_secret text,p_action text,p_id uuid,p_lease uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m model_automation_private.mail_outbox%rowtype; j public.calculator_model_request_jobs%rowtype;
  r public.calculator_model_requests%rowtype; candidate record; v_valid boolean; v_snapshot jsonb;
begin
  perform model_automation_private.workflow_authorized(p_secret);
  perform model_automation_private.workflow_lock();
  if p_action in ('maintain','claim','clarify') and not model_automation_private.workflow_enabled() then return null; end if;
  if p_action='maintain' then
    -- Retire digest and old help alerts. Preserve ledger rows and live leases.
    update model_automation_private.mail_outbox set state=case when started_at is null then 'cancelled' else 'failed' end,
      lease=null,lease_until=null
      where (kind='weekly' or (kind='escalation' and mail_key not like 'registry-unverified/%'))
        and state in ('pending','sending') and (lease_until is null or lease_until<=now());
    update public.calculator_model_request_jobs jobs set contact_state='closed',contact_next_at=null,
      activity=activity||model_automation_private.event('closed','No response after the follow-up period'),updated_at=now()
      where jobs.contact_state='waiting' and not model_automation_private.workflow_live_mail(jobs.request_id)
        and model_automation_private.workflow_canonical(jobs.request_id) is null
        and exists(select 1 from model_automation_private.mail_outbox sent
          where sent.request_id=jobs.request_id and sent.round=jobs.contact_round and sent.kind='question'
          and sent.research_job_id is not null and sent.state='sent'
          and model_automation_private.business_date(sent.sent_at,10)<=now());
    return null;
  elsif p_action='clarify' then
    -- The research apply transaction is the only remaining issuer of a
    -- checking lease. Never accept a pre-upgrade verifier's clarification.
    if not exists(select 1 from model_automation_private.research_jobs
      where external_id=p_id and applied_at is null and state in ('pending_verification','waiting_for_details')) then
      raise exception 'Legacy research worker retired';
    end if;
    perform model_automation_private.clarify(p_id,p_lease,p_data);
    return null;
  elsif p_action='claim' then
    for candidate in select mail_key,request_id from model_automation_private.mail_outbox
      where (p_id is null or request_id=p_id) and available_at<=now() and state in ('pending','sending')
        and (lease_until is null or lease_until<=now())
      order by (kind='no_rebate') desc,available_at,mail_key limit 16 loop
      v_valid:=false;
      if candidate.request_id is not null then
        select * into r from public.calculator_model_requests where id=candidate.request_id for update skip locked;
        if not found then continue; end if;
        select * into j from public.calculator_model_request_jobs where request_id=r.id for update skip locked;
        if not found or model_automation_private.workflow_live_mail(r.id) then continue; end if;
        if j.contact_state is distinct from 'closed' then perform model_automation_private.workflow_link(r.id); end if;
      end if;
      select * into m from model_automation_private.mail_outbox where mail_key=candidate.mail_key
        and state in ('pending','sending') and (lease_until is null or lease_until<=now()) for update skip locked;
      if not found then continue; end if;
      if m.kind<>'weekly' and (m.kind<>'escalation' or m.mail_key like 'registry-unverified/%')
        and (case when m.kind='no_rebate' then model_automation_private.workflow_completion_allowed(m.request_id,m.started_at)
          else model_automation_private.workflow_canonical(m.request_id) is null end)
        and model_automation_private.can_contact_request(m.request_id) and m.research_job_id is not null then
        v_snapshot:=model_automation_private.research_snapshot(m.request_id);
        if v_snapshot->>'round'=m.research_version::text
          and encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex')=m.research_fingerprint then
          v_valid:=case when m.kind='no_rebate' then j.state='no_rebate' and r.status='no_rebate'
              and lower(m.recipient)=lower(r.requester_email)
              and exists(select 1 from model_automation_private.research_jobs q where q.id=m.research_job_id
                and q.external_id=m.request_id and q.round=m.research_version and q.state='no_rebate' and q.applied_at is not null)
            when m.kind='escalation' then j.state='review' and j.contact_state is null and r.status='reviewing'
              and exists(select 1 from model_automation_private.research_jobs q where q.id=m.research_job_id
                and q.state='review' and q.applied_at is not null
                and q.applied_outcome->'registry_match_unverified'='true'::jsonb)
            else j.contact_state='waiting' and j.contact_round=m.round and r.status='reviewing'
              and lower(m.recipient)=lower(r.requester_email)
              and model_automation_private.workflow_prior_contact(m.request_id,m.kind,m.payload->>'question',
                m.payload->>'day',m.mail_key) is null end;
        end if;
      end if;
      if not coalesce(v_valid,false) or m.attempts>=3 or m.started_at<now()-interval '23 hours' then
        update model_automation_private.mail_outbox set state=case
          when m.started_at is null then 'cancelled' else 'failed' end,lease=null,lease_until=null where mail_key=m.mail_key;
        continue;
      end if;
      update model_automation_private.mail_outbox set state='sending',lease=gen_random_uuid(),
        lease_until=now()+interval '2 minutes',started_at=coalesce(started_at,now()),attempts=attempts+1
        where mail_key=m.mail_key returning * into m;
      return to_jsonb(m);
    end loop;
    return null;
  elsif p_action in ('sent','retry') then
    select * into m from model_automation_private.mail_outbox where mail_key=p_data->>'key';
    if not found or (p_id is not null and m.request_id is distinct from p_id) then raise exception 'Unknown email'; end if;
    -- Keep original acknowledgement and reminder stamping, including existing
    -- provider idempotency keys for retries that have not become obsolete.
    return model_automation_private.contact_worker_before_workflow(p_secret,p_action,p_id,p_lease,p_data);
  end if;
  raise exception 'Unknown model request contact action';
end; $$;
revoke all on function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) to anon;
create or replace function public.model_request_contact_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.contact_worker(p_secret,p_action,p_id,p_lease,p_data); $$;

create or replace function model_automation_private.request_self(p_id uuid,p_response jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.calculator_model_requests%rowtype; j public.calculator_model_request_jobs%rowtype;
  v_id uuid; v_version integer; v_model text; v_postcode text; v_install text; v_message text; v_help boolean;
begin
  if not model_automation_private.can_contact_request(p_id) or not exists(select 1 from public.calculator_model_requests
    where id=p_id and user_id=auth.uid() and lower(requester_email)=lower(auth.jwt()->>'email')) then return null; end if;
  perform model_automation_private.workflow_lock();
  v_id:=coalesce(model_automation_private.workflow_canonical(p_id),p_id);
  select * into r from public.calculator_model_requests where id=v_id for update;
  if not found or not model_automation_private.can_contact_request(v_id) or r.user_id is distinct from auth.uid()
    or lower(r.requester_email) is distinct from lower(auth.jwt()->>'email') then return null; end if;
  if p_response is null then return model_automation_private.request_self_before_workflow(v_id,null); end if;
  select * into j from public.calculator_model_request_jobs where request_id=v_id for update;
  perform model_automation_private.research_ensure(v_id);
  select version into v_version from model_automation_private.research_requests where request_id=v_id for update;
  if j.state is distinct from 'review' or j.contact_state is null or j.contact_state not in ('waiting','closed')
    or r.status not in ('new','reviewing') or p_response->>'round' is distinct from j.contact_round::text
    or (p_response ? 'version' and p_response->>'version' is distinct from v_version::text) then
    raise exception 'Request is no longer awaiting a response';
  end if;
  if model_automation_private.workflow_live_mail(v_id) then raise exception 'Requester notification is sending; retry shortly'; end if;
  v_model:=btrim(coalesce(p_response->>'model','')); v_postcode:=btrim(coalesce(p_response->>'postcode',''));
  v_install:=btrim(coalesce(p_response->>'install_type','')); v_message:=btrim(coalesce(p_response->>'message',''));
  if jsonb_typeof(p_response)<>'object' or length(v_model)>180 or length(v_message)>1000 or v_model~'[[:cntrl:]]'
    or (v_postcode<>'' and (v_postcode!~'^[0-9]{4}$' or v_postcode='0000')) or v_install not in ('','new','replacement')
    or (p_response ? 'help' and jsonb_typeof(p_response->'help') not in ('boolean','null')) then raise exception 'Invalid model response'; end if;
  if exists(select 1 from model_automation_private.research_replies where request_id=v_id
    and response-'version'=p_response-'version') then raise exception 'This response was already received'; end if;
  v_help:=coalesce(p_response->>'help'='true',false) or v_message~* '\m(frustrat(ed|ing|ion)|fed up|still (not working|doesn.t work)|human|someone (call|contact|help)|no one (replied|responded)|getting nowhere)\M';
  if not v_help and v_message='' and coalesce(nullif(v_model,''),r.model)=r.model
    and coalesce(nullif(v_postcode,''),r.postcode)=r.postcode and coalesce(nullif(v_install,''),r.install_type)=r.install_type then
    raise exception 'Add the requested information or ask for help';
  end if;
  perform model_automation_private.workflow_cancel_contact(v_id);
  update public.calculator_model_requests set model=coalesce(nullif(v_model,''),model),postcode=coalesce(nullif(v_postcode,''),postcode),
    install_type=coalesce(nullif(v_install,''),install_type),status='new',updated_at=now() where id=v_id;
  update model_automation_private.research_requests set version=greatest(version,v_version+1),
    messages=case when v_message<>'' then messages||jsonb_build_array(v_message) else messages end where request_id=v_id;
  insert into model_automation_private.research_replies(request_id,version,response)
    select v_id,version,p_response from model_automation_private.research_requests where request_id=v_id;
  update model_automation_private.research_jobs set state='superseded',lease=null,lease_until=null,updated_at=now()
    where external_id=v_id and state not in ('complete','no_rebate','superseded');
  update public.calculator_model_request_jobs set state='queued',contact_state=null,contact_next_at=null,attempts=0,
    reason='',available_at=now(),lease_until=null,lease_token=null,
    activity=activity||model_automation_private.event(case when v_help then 'help_received' else 'response_received' end,v_message),
    updated_at=now() where request_id=v_id;
  return model_automation_private.request_self_before_workflow(v_id,null);
end; $$;
revoke all on function model_automation_private.request_self(uuid,jsonb) from public,anon,authenticated;
grant execute on function model_automation_private.request_self(uuid,jsonb) to authenticated;
create or replace function public.model_request_self(p_id uuid,p_response jsonb default null) returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.request_self(p_id,p_response); $$;

revoke all on function model_automation_private.workflow_lock(),model_automation_private.workflow_intake(),
  model_automation_private.workflow_normal(text),model_automation_private.workflow_details(public.calculator_model_requests),
  model_automation_private.workflow_canonical(uuid),model_automation_private.workflow_case_members(uuid),
  model_automation_private.workflow_live_mail(uuid),
  model_automation_private.workflow_cancel_contact(uuid),model_automation_private.workflow_link(uuid),
  model_automation_private.workflow_unreconciled(uuid),model_automation_private.workflow_authorized(text),model_automation_private.workflow_enabled(),
  model_automation_private.workflow_completion_suppressed(uuid),model_automation_private.workflow_completion_allowed(uuid,timestamptz),
  model_automation_private.workflow_registry_matches(public.calculator_model_requests,jsonb),model_automation_private.workflow_link_verified(uuid),
  model_automation_private.workflow_prior_contact(uuid,text,text,text,text) from public,anon,authenticated;

select pg_notify('pgrst','reload schema');
commit;
