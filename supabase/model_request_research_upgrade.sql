-- Apply after model_request_followup_upgrade.sql. No existing request is queued
-- or changed by this migration. Production use requires independent Sol-high review.
begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

alter table public.calculator_model_request_jobs drop constraint calculator_model_request_jobs_state_check;
alter table public.calculator_model_request_jobs add constraint calculator_model_request_jobs_state_check
  check(state in ('queued','checking','researching','review','added','declined','no_rebate'));
alter table public.calculator_model_requests drop constraint calculator_model_requests_status_check;
alter table public.calculator_model_requests add constraint calculator_model_requests_status_check
  check(status in ('new','reviewing','added','declined','no_rebate'));
alter table model_automation_private.mail_outbox drop constraint mail_outbox_kind_check;
alter table model_automation_private.mail_outbox add constraint mail_outbox_kind_check
  check(kind in ('question','reminder','escalation','weekly','no_rebate'));

create table model_automation_private.research_requests (
  request_id uuid primary key references public.calculator_model_requests(id) on delete cascade,
  version integer not null default 1 check(version between 1 and 20),
  original jsonb not null,
  messages jsonb not null default '[]' check(jsonb_typeof(messages)='array')
);
create table model_automation_private.research_rounds (
  external_id uuid not null references model_automation_private.research_requests(request_id) on delete cascade,
  round integer not null check(round between 1 and 20),
  fingerprint text not null,
  request jsonb not null,
  created_at timestamptz not null default now(),
  primary key(external_id,round)
);
create table model_automation_private.research_jobs (
  id uuid primary key default gen_random_uuid(),
  external_id uuid not null,
  round integer not null,
  state text not null default 'queued' check(state in ('queued','researching','pending_verification','waiting_for_details','review','budget_paused','complete','no_rebate','superseded')),
  lease uuid,
  lease_until timestamptz,
  checkpoint jsonb,
  result jsonb,
  applied_outcome jsonb,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(external_id,round),
  foreign key(external_id,round) references model_automation_private.research_rounds(external_id,round) on delete cascade,
  check((lease is null)=(lease_until is null))
);
create index research_jobs_due on model_automation_private.research_jobs(created_at,id) where state in ('queued','researching','pending_verification');
create table model_automation_private.research_events (
  sequence bigint generated always as identity primary key,
  job_id uuid not null references model_automation_private.research_jobs(id) on delete cascade,
  at timestamptz not null default now(), kind text not null, detail text not null
);
create index research_events_job on model_automation_private.research_events(job_id,sequence);
create table model_automation_private.research_budget (
  month date primary key check(extract(day from month)=1),
  seed_spent bigint not null default 0 check(seed_spent>=0),
  spent_micros bigint not null default 0 check(spent_micros>=0),
  reserved_micros bigint not null default 0 check(reserved_micros>=0),
  limit_micros bigint not null default 20000000 check(limit_micros between 1 and 20000000),
  minimum_fx numeric not null default 2.2 check(minimum_fx>=2.2),
  pricing_review_by date not null default '2026-12-09' check(pricing_review_by<='2026-12-09'),
  check(seed_spent+spent_micros+reserved_micros<=limit_micros)
);
-- Once only; reruns must neither overwrite nor reduce an existing ledger.
insert into model_automation_private.research_budget(month,seed_spent) values('2026-11-01',1063705)
  on conflict(month) do nothing;
create table model_automation_private.research_costs (
  id uuid primary key default gen_random_uuid(),
  -- Money survives request deletion; the nullable link contains no customer data.
  job_id uuid references model_automation_private.research_jobs(id) on delete set null,
  lease uuid not null,
  step integer not null check(step between 1 and 8),
  month date not null references model_automation_private.research_budget(month),
  reserved bigint not null check(reserved>0),
  charged bigint not null default 0 check(charged>=0 and charged<=reserved),
  state text not null default 'pending' check(state in ('pending','settled','uncertain','rejected')),
  provider_id text,
  created_at timestamptz not null default now(),
  unique(job_id,lease)
);
create unique index research_provider_charge on model_automation_private.research_costs(provider_id) where provider_id is not null;
create table model_automation_private.research_imports (
  source_job_id uuid primary key,
  job_id uuid unique references model_automation_private.research_jobs(id) on delete set null,
  imported_at timestamptz not null default now()
);
create table model_automation_private.research_replies (
  request_id uuid not null references model_automation_private.research_requests(request_id) on delete cascade,
  version integer not null, response jsonb not null, at timestamptz not null default now(),
  primary key(request_id,version)
);
alter table model_automation_private.mail_outbox add column research_job_id uuid references model_automation_private.research_jobs(id) on delete set null,
  add column research_version integer, add column research_fingerprint text;

create function model_automation_private.research_immutable() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='UPDATE' or pg_trigger_depth()=1 then raise exception 'Research history is immutable'; end if;
  return old; -- Permit FK cascades when the owning request is removed.
end; $$;
create trigger immutable_research_round before update or delete on model_automation_private.research_rounds
  for each row execute function model_automation_private.research_immutable();
create trigger immutable_research_event before update or delete on model_automation_private.research_events
  for each row execute function model_automation_private.research_immutable();
create trigger immutable_research_reply before update or delete on model_automation_private.research_replies
  for each row execute function model_automation_private.research_immutable();

create function model_automation_private.research_ensure(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into model_automation_private.research_requests(request_id,original,messages)
    select r.id,to_jsonb(r),coalesce((select jsonb_agg(e->'detail' order by n)
      from public.calculator_model_request_jobs j cross join lateral jsonb_array_elements(j.activity) with ordinality a(e,n)
      where j.request_id=r.id and e->>'kind' in ('response_received','escalated') and coalesce(e->>'detail','')<>''),'[]')
    from public.calculator_model_requests r where r.id=p_id on conflict do nothing;
end; $$;
create function model_automation_private.research_capture() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    insert into model_automation_private.research_requests(request_id,original) values(new.id,to_jsonb(new));
  elsif row(new.brand,new.model,new.capacity,new.phase,new.notes,new.postcode,new.install_type,new.system_type,new.user_id,new.requester_email,new.business_id)
    is distinct from row(old.brand,old.model,old.capacity,old.phase,old.notes,old.postcode,old.install_type,old.system_type,old.user_id,old.requester_email,old.business_id) then
    -- The first edit to a legacy request preserves its pre-edit contents.
    insert into model_automation_private.research_requests(request_id,original,messages)
      values(old.id,to_jsonb(old),coalesce((select jsonb_agg(e->'detail' order by n)
        from public.calculator_model_request_jobs j cross join lateral jsonb_array_elements(j.activity) with ordinality a(e,n)
        where j.request_id=old.id and e->>'kind' in ('response_received','escalated') and coalesce(e->>'detail','')<>''),'[]')) on conflict do nothing;
    update model_automation_private.research_requests set version=version+1 where request_id=new.id;
  end if;
  return new;
end; $$;
create trigger capture_model_research_request after insert or update on public.calculator_model_requests
  for each row execute function model_automation_private.research_capture();
create function model_automation_private.research_original_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.original is distinct from old.original or new.version<old.version then raise exception 'Original request and versions are immutable'; end if;
  return new;
end; $$;
create trigger preserve_model_research_original before update on model_automation_private.research_requests
  for each row execute function model_automation_private.research_original_guard();

create function model_automation_private.research_snapshot(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.calculator_model_requests%rowtype; h model_automation_private.research_requests%rowtype;
begin
  select * into r from public.calculator_model_requests where id=p_id for update;
  if not found then return null; end if;
  perform model_automation_private.research_ensure(p_id);
  select * into h from model_automation_private.research_requests where request_id=p_id;
  if jsonb_array_length(h.messages)>12 then raise exception 'Requester history needs manual review'; end if;
  return jsonb_build_object('id',r.id,'round',h.version,'brand',r.brand,'model',r.model,'capacity',r.capacity,'phase',r.phase,
    'postcode',r.postcode,'install_type',r.install_type,'system_type',r.system_type,'notes',r.notes,'messages',h.messages);
end; $$;
create function model_automation_private.research_job(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select to_jsonb(j)||jsonb_build_object('request',r.request,'fingerprint',r.fingerprint,
    'events',coalesce((select jsonb_agg(jsonb_build_object('at',e.at,'kind',e.kind,'detail',e.detail) order by e.sequence)
      from model_automation_private.research_events e where e.job_id=j.id),'[]'))
  from model_automation_private.research_jobs j join model_automation_private.research_rounds r using(external_id,round) where j.id=p_id;
$$;
create function model_automation_private.research_budget_status() returns jsonb
language sql stable security definer set search_path='' as $$
  with m as (select date_trunc('month',now() at time zone 'Australia/Sydney')::date as month),
  b as (select m.month,coalesce(b.seed_spent,0)+coalesce(b.spent_micros,0) as charged,
    coalesce(b.reserved_micros,0) as reserved,
    coalesce(b.limit_micros,20000000) as ceiling,coalesce(b.pricing_review_by,date '2026-12-09') as review_by
    from m left join model_automation_private.research_budget b on b.month=m.month)
  select jsonb_build_object('month',to_char(month,'YYYY-MM'),'charged',charged,'reserved',reserved,
    'spentMicros',charged,'reservedMicros',reserved,'limitMicros',ceiling,'pricingReviewBy',review_by) from b;
$$;

create function model_automation_private.research_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  j model_automation_private.research_jobs%rowtype;
  l public.calculator_model_request_jobs%rowtype;
  r public.calculator_model_requests%rowtype;
  c model_automation_private.research_costs%rowtype;
  v_id uuid; v_key uuid; v_snapshot jsonb; v_hash text; v_outcome jsonb; v_result jsonb;
  v_round integer; v_step integer; v_amount bigint; v_limit bigint; v_charge bigint; v_month date;
  v_bad boolean; v_kind text; v_source uuid; v_target uuid; v_target_notes text;
  v_request_hash text; v_result_hash text; candidate record;
begin
  if length(coalesce(p_secret,''))<40 or not exists(select 1 from model_automation_private.settings where secret_hash=sha256(convert_to(p_secret,'UTF8'))) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Invalid research data'; end if;
  if p_action='budget' then return model_automation_private.research_budget_status(); end if;
  if p_action='get' then return model_automation_private.research_job(p_id); end if;
  if p_action='current' then
    if not model_automation_private.can_contact_request(p_id) then return null; end if;
    return model_automation_private.research_snapshot(p_id);
  end if;
  if p_action='related' then
    return coalesce((select jsonb_agg(id order by created_at,id) from model_automation_private.research_jobs
      where id<>p_id and result->>'identity'=p_data->>'identity'),'[]');
  end if;
  if p_action='restore_prepaid' then
    if p_id is null then raise exception 'A targeted prepaid request is required'; end if;
    v_result:=model_automation_private.research_worker(p_secret,'enqueue',p_id,null,'{"retry":true}');
    if v_result is null then raise exception 'Prepaid request is not eligible for restoration'; end if;
    -- Do not catch import errors here: PostgreSQL rolls back the enqueue and
    -- contact cancellation in the same RPC transaction if any pin fails.
    return model_automation_private.research_worker(p_secret,'import_checkpoint',(v_result->>'id')::uuid,null,p_data);
  end if;
  if p_action='confirmation_claim' then
    -- Never call the legacy worker's untargeted claim: it also claims queued work.
    select request_id into v_id from public.calculator_model_request_jobs where (p_id is null or request_id=p_id)
      and state='added' and email_state in ('pending','sending') and available_at<=now()
      and (lease_until is null or lease_until<=now()) order by available_at,request_id limit 1;
    if v_id is null then return null; end if;
    perform 1 from public.calculator_model_requests where id=v_id for update skip locked;
    if not found then return null; end if;
    select * into l from public.calculator_model_request_jobs where request_id=v_id for update skip locked;
    if not found or l.state<>'added' or l.email_state not in ('pending','sending') or l.available_at>now() or l.lease_until>now() then return null; end if;
    select * into j from model_automation_private.research_jobs where external_id=v_id and applied_outcome->>'kind'='ready_to_add'
      and applied_at is not null order by round desc limit 1;
    if found and model_automation_private.research_snapshot(v_id) is distinct from
      (select request from model_automation_private.research_rounds where external_id=v_id and round=j.round) then
      update public.calculator_model_request_jobs set email_state='failed',email_error='Request details changed; confirmation held for review',
        lease_token=null,lease_until=null,updated_at=now() where request_id=v_id;
      return null;
    end if;
    return model_automation_private.worker(p_secret,'claim',v_id,null,'{}');
  end if;
  if p_action='enqueue' then
    -- Filter before LIMIT so an inaccessible, unsupported or active oldest row
    -- cannot monopolize the recovery sweep. Leave excluded records untouched.
    select legacy.request_id into v_id from public.calculator_model_requests request
      join public.calculator_model_request_jobs legacy on legacy.request_id=request.id
      where (p_id is null or legacy.request_id=p_id)
      and request.system_type in ('split','ducted')
      and model_automation_private.can_contact_request(legacy.request_id)
      and (legacy.lease_until is null or legacy.lease_until<=now())
      and not exists(select 1 from model_automation_private.research_jobs active
        where active.external_id=legacy.request_id and active.lease_until>now())
      and (p_id is not null or not exists(select 1 from model_automation_private.mail_outbox sending
        where sending.request_id=legacy.request_id and sending.state='sending' and sending.lease_until>now()))
      and ((legacy.state='queued' and legacy.contact_state is null and legacy.available_at<=now())
        or (legacy.state in ('researching','review') and legacy.contact_state is null and exists(select 1 from model_automation_private.research_jobs q where q.external_id=legacy.request_id
          and (q.state in ('queued','pending_verification','waiting_for_details','review','budget_paused') or (q.state='researching' and q.lease_until<=now())) and q.applied_at is null))
        or (p_id is not null and p_data->>'retry'='true' and legacy.state='review' and legacy.contact_state is distinct from 'closed'))
      order by legacy.available_at,legacy.request_id for update of request,legacy skip locked limit 1;
    if v_id is null then return null; end if;
    select * into r from public.calculator_model_requests where id=v_id for update;
    select * into l from public.calculator_model_request_jobs where request_id=v_id for update;
    if not model_automation_private.can_contact_request(v_id) or r.system_type not in ('split','ducted')
      or l.state not in ('queued','researching','review') or l.contact_state='closed'
      or (l.state='review' and not (p_id is not null and p_data->>'retry'='true') and not exists(
        select 1 from model_automation_private.research_jobs q where q.external_id=v_id and q.applied_at is null and l.contact_state is null)) then return null; end if;
    if exists(select 1 from model_automation_private.mail_outbox where request_id=v_id and state='sending' and lease_until>now()) then
      raise exception 'Requester notification is sending; retry later';
    end if;
    v_snapshot:=model_automation_private.research_snapshot(v_id); v_round:=(v_snapshot->>'round')::integer;
    v_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
    select * into j from model_automation_private.research_jobs where external_id=v_id and round=v_round for update;
    if found then
      if (select fingerprint from model_automation_private.research_rounds where external_id=v_id and round=v_round)<>v_hash then
        raise exception 'This research round has different details';
      end if;
      if (p_id is not null and p_data->>'retry'='true') or (l.state='queued' and l.reviewed_at>=j.updated_at and nullif(l.reviewed_by,'') is not null) then
        if exists(select 1 from model_automation_private.research_costs where job_id=j.id and
          (state in ('pending','uncertain') or (state='settled' and step>coalesce((j.checkpoint->>'round')::integer,0)))) then
          raise exception 'Provider charge requires reconciliation before retry';
        end if;
        update model_automation_private.research_jobs set state=case when result->>'outcome'='candidate' then 'pending_verification'
          when result->>'outcome'='needs_details' then 'waiting_for_details' else 'queued' end,
          applied_at=null,applied_outcome=null,lease=null,lease_until=null,updated_at=now() where id=j.id;
        update public.calculator_model_request_jobs set state='researching',contact_state=null,contact_next_at=null,
          lease_token=null,lease_until=null,reason='',updated_at=now() where request_id=v_id;
      end if;
      return model_automation_private.research_job(j.id);
    end if;
    update model_automation_private.research_jobs set state='superseded',lease=null,lease_until=null,updated_at=now()
      where external_id=v_id and state not in ('complete','no_rebate','superseded');
    insert into model_automation_private.research_rounds(external_id,round,fingerprint,request) values(v_id,v_round,v_hash,v_snapshot);
    insert into model_automation_private.research_jobs(external_id,round) values(v_id,v_round) returning * into j;
    update public.calculator_model_request_jobs set state='researching',contact_state=null,contact_next_at=null,
      lease_token=null,lease_until=null,reason='',updated_at=now() where request_id=v_id;
    insert into model_automation_private.research_events(job_id,kind,detail) values(j.id,'queued','Research request saved');
    return model_automation_private.research_job(j.id);
  end if;
  if p_action='claim' then
    for candidate in select id,external_id from model_automation_private.research_jobs where (p_id is null or id=p_id)
      and (state='queued' or (state='researching' and lease_until<=now())) order by created_at,id loop
      perform 1 from public.calculator_model_requests where id=candidate.external_id for update skip locked;
      if not found then continue; end if;
      select * into l from public.calculator_model_request_jobs where request_id=candidate.external_id for update skip locked;
      if not found then continue; end if;
      select * into j from model_automation_private.research_jobs where id=candidate.id for update skip locked;
      if not found or not (j.state='queued' or (j.state='researching' and j.lease_until<=now())) then continue; end if;
      v_snapshot:=model_automation_private.research_snapshot(j.external_id);
      if l.state<>'researching' or not model_automation_private.can_contact_request(j.external_id)
        or v_snapshot is distinct from (select request from model_automation_private.research_rounds where external_id=j.external_id and round=j.round) then
        update model_automation_private.research_jobs set state='superseded',lease=null,lease_until=null,updated_at=now() where id=j.id;
        continue;
      end if;
      v_bad:=exists(select 1 from model_automation_private.research_costs where job_id=j.id and
        (state in ('pending','uncertain') or (state='settled' and step>coalesce((j.checkpoint->>'round')::integer,0))));
      if v_bad then
        update model_automation_private.research_jobs set state='review',lease=null,lease_until=null,updated_at=now() where id=j.id;
        update public.calculator_model_request_jobs set state='review',reason='Provider call may have completed; reconcile before retry',updated_at=now() where request_id=j.external_id;
        insert into model_automation_private.research_events(job_id,kind,detail) values(j.id,'recovered','Provider call may have completed; reconciliation required before retry');
        continue;
      end if;
      v_key:=gen_random_uuid();
      update model_automation_private.research_jobs set state='researching',lease=v_key,lease_until=now()+interval '3 minutes',updated_at=now() where id=j.id;
      insert into model_automation_private.research_events(job_id,kind,detail) values(j.id,'researching','Agent investigation started');
      return jsonb_build_object('job',model_automation_private.research_job(j.id),'lease',v_key);
    end loop;
    return null;
  end if;

  if p_action in ('settle','uncertain','rejected') then
    select * into c from model_automation_private.research_costs where id=p_id for update;
    if not found then raise exception 'Unknown research reservation'; end if;
    if p_action='settle' then
      if c.state='settled' and p_data->>'charge'=c.charged::text and p_data->>'provider_id'=c.provider_id then return 'true'; end if;
      if c.state<>'pending' then raise exception 'API charge already settled or requires reconciliation'; end if;
      if coalesce(p_data->>'charge','') !~ '^[0-9]{1,15}$' or coalesce(p_data->>'provider_id','')='' or length(p_data->>'provider_id')>200 then
        update model_automation_private.research_costs set state='uncertain' where id=p_id; return 'false';
      end if;
      v_charge:=(p_data->>'charge')::bigint;
      if v_charge>c.reserved or exists(select 1 from model_automation_private.research_costs where provider_id=p_data->>'provider_id' and id<>p_id) then
        update model_automation_private.research_costs set state='uncertain' where id=p_id; return 'false';
      end if;
      update model_automation_private.research_costs set state='settled',charged=v_charge,provider_id=p_data->>'provider_id' where id=p_id;
      update model_automation_private.research_budget set spent_micros=spent_micros+v_charge,reserved_micros=reserved_micros-c.reserved where month=c.month;
      return 'true';
    end if;
    if c.state='pending' then
      update model_automation_private.research_costs set state=p_action where id=p_id;
      if p_action='rejected' then update model_automation_private.research_budget set reserved_micros=reserved_micros-c.reserved where month=c.month; end if;
    end if;
    return null;
  end if;

  select external_id into v_id from model_automation_private.research_jobs where id=p_id;
  if v_id is null then raise exception 'Unknown research job'; end if;
  select * into r from public.calculator_model_requests where id=v_id for update;
  select * into l from public.calculator_model_request_jobs where request_id=v_id for update;
  select * into j from model_automation_private.research_jobs where id=p_id for update;
  v_snapshot:=model_automation_private.research_snapshot(v_id);
  v_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  if v_snapshot is distinct from (select request from model_automation_private.research_rounds where external_id=v_id and round=j.round)
    or v_hash is distinct from (select fingerprint from model_automation_private.research_rounds where external_id=v_id and round=j.round) then
    if p_action='apply_result' then
      update model_automation_private.research_jobs set state='superseded',lease=null,lease_until=null,updated_at=now() where id=j.id;
      return jsonb_build_object('state','superseded');
    end if;
    raise exception 'Research snapshot is no longer current' using errcode='40001';
  end if;
  if p_action='event' then
    if coalesce(p_data->>'kind','') not in ('api_usage','web_research','registry_search','related_request','continuation_deferred') then raise exception 'Invalid research event'; end if;
    insert into model_automation_private.research_events(job_id,kind,detail) values(j.id,p_data->>'kind',left(coalesce(p_data->>'detail',''),2400)); return null;
  end if;

  if p_action='import_checkpoint' then
    -- These are the three already-paid local artifacts, not a generic import API.
    v_source:=(p_data->>'source_job_id')::uuid;
    -- Explicitly reviewed mapping: Midea's live note includes the model codes
    -- as well as the source note. No other note differences are authorized.
    select target_id,target_notes,request_hash,result_hash into v_target,v_target_notes,v_request_hash,v_result_hash from (values
      ('bba2e013-2073-4453-9379-81a20ce7030c'::uuid,'6fd1afa2-85f0-4615-8ec9-bd45eb2ba28e'::uuid,'Mitsubishi Ciara Range','89f2a10bd0f1bc18bec14aeeedc3f5b3bad755fa7b09b346588e8e5e878c7828','043e82be81ff3b46bd3bc55c7fd9fa7e43b275966e51cfa6832eee0e390ec11b'),
      ('2f076bd0-127f-4511-9cc1-15cd203d0279'::uuid,'12fadd7c-887c-4398-89bc-879fc0999b43'::uuid,'Mitsubishi Ciara','ff342e1ce5f9c5ff4f7a4c13805713f69fd29a5310c3ed94b5462e7baaff59f2','5677196ba361ddf66b745d83b247b19c2260cc50f7ef5b7833f9c59ea8d52f72'),
      ('9ac354f8-473a-4853-ba91-a9193d9a5085'::uuid,'4c8410a4-83c9-4488-8d55-4685eb263f8a'::uuid,'UCMI200OC-3PH/DUCMI200IHC-3PH Midea Quantum','1912c09990cd7f181d190e94f2c15bb03a161655d6907e54e7ec5a7a5d6c6742','49be952a69b7f50197b7c96780b91655c9f0ee9edaae6f1cb5bfa898a5b89c8a')
    ) pins(id,target_id,target_notes,request_hash,result_hash) where id=v_source;
    if v_request_hash is null or encode(sha256(convert_to(p_data->>'source_request_text','UTF8')),'hex') is distinct from v_request_hash
      or encode(sha256(convert_to(p_data->>'result_text','UTF8')),'hex') is distinct from v_result_hash
      or v_id is distinct from v_target or v_snapshot->>'notes' is distinct from v_target_notes
      or (p_data->>'source_request_text')::jsonb-'id'-'round'-'notes' is distinct from v_snapshot-'id'-'round'-'notes'
      or j.state<>'queued' or j.applied_at is not null or l.state<>'researching'
      or not model_automation_private.can_contact_request(v_id)
      or exists(select 1 from model_automation_private.research_costs where job_id=j.id) then raise exception 'Prepaid artifact does not match an importable current request'; end if;
    insert into model_automation_private.research_imports(source_job_id,job_id) values(v_source,j.id);
    update model_automation_private.research_jobs set state='pending_verification',result=(p_data->>'result_text')::jsonb,
      lease=null,lease_until=null,updated_at=now() where id=j.id;
    insert into model_automation_private.research_events(job_id,kind,detail) values(j.id,'imported','Previously paid research restored; deterministic verification still required');
    return model_automation_private.research_job(j.id);
  end if;

  if p_action='apply_result' then
    v_outcome:=p_data->'outcome'; v_kind:=v_outcome->>'kind';
    if j.applied_at is not null then
      -- Repeated read-only verification can refresh timestamps/source evidence.
      -- The already applied decision/product cannot be changed by a second call.
      if j.applied_outcome-'evidence' is distinct from v_outcome-'evidence' then raise exception 'A different research outcome was already applied'; end if;
      return jsonb_build_object('state',l.state,'already_applied',true);
    end if;
    if j.state not in ('pending_verification','waiting_for_details','review','budget_paused') or j.lease is not null
      or l.state not in ('researching','review') or l.contact_state is not null then raise exception 'Research outcome is not ready to apply'; end if;
    if coalesce(v_kind,'') not in ('ready_to_add','no_rebate','needs_details','review') then raise exception 'Invalid verified outcome'; end if;
    if j.state in ('review','budget_paused') and v_kind<>'review' then raise exception 'Unresolved research requires manual review'; end if;
    if not model_automation_private.can_contact_request(v_id) then
      v_outcome:=jsonb_build_object('kind','review','reason','Requester or business access changed'); v_kind:='review';
    end if;
    if v_kind in ('ready_to_add','no_rebate') then
      if j.state<>'pending_verification' or j.result->>'outcome' is distinct from 'candidate'
        or nullif(j.result#>>'{canonical,registrationNumber}','') is null
        or v_outcome#>>'{evidence,verification,registry,registrationNumber}' is distinct from j.result#>>'{canonical,registrationNumber}'
        or v_outcome#>>'{evidence,verification,registry,brand}' is distinct from j.result#>>'{canonical,brand}'
        or v_outcome#>>'{evidence,verification,registry,model}' is distinct from j.result#>>'{canonical,model}'
        or lower(v_outcome#>>'{product,brand}') is distinct from lower(j.result#>>'{canonical,brand}')
        or v_outcome#>>'{product,model}' is distinct from j.result#>>'{canonical,model}'
        or v_outcome#>>'{product,systemType}' is distinct from j.result#>>'{canonical,systemType}'
        or v_outcome#>>'{product,phase}' is distinct from j.result#>>'{canonical,phase}'
        or (v_outcome#>>'{product,capacityKw}')::numeric is distinct from (j.result#>>'{canonical,capacityKw}')::numeric
        or nullif(v_outcome->>'identity','') is null then raise exception 'Deterministic outcome is not bound to the exact researched registration'; end if;
      if v_kind='no_rebate' and (v_outcome#>'{evidence,verification,certificates,esc}' is distinct from '0'::jsonb
        or v_outcome#>'{evidence,verification,certificates,prc}' is distinct from '0'::jsonb
        or v_outcome#>>'{evidence,verification,kind}' is distinct from 'no_rebate') then raise exception 'A deterministic no_rebate verifier result is required'; end if;
      if v_kind='ready_to_add' and (v_outcome#>>'{evidence,verification,kind}' is distinct from 'verified'
        or jsonb_typeof(v_outcome#>'{evidence,verification,certificates,esc}') is distinct from 'number'
        or jsonb_typeof(v_outcome#>'{evidence,verification,certificates,prc}') is distinct from 'number'
        or (v_outcome#>>'{evidence,verification,certificates,esc}')::numeric<0
        or (v_outcome#>>'{evidence,verification,certificates,prc}')::numeric<0
        or greatest((v_outcome#>>'{evidence,verification,certificates,esc}')::numeric,(v_outcome#>>'{evidence,verification,certificates,prc}')::numeric)<=0) then
        raise exception 'Positive deterministic certificates are required for publication';
      end if;
    end if;
    v_key:=gen_random_uuid();
    update public.calculator_model_request_jobs set state='checking',lease_token=v_key,lease_until=now()+interval '2 minutes',updated_at=now() where request_id=v_id;
    if v_kind='ready_to_add' then
      v_result:=model_automation_private.worker(p_secret,'verified',v_id,v_key,v_outcome);
      update public.calculator_model_request_jobs set lease_token=null,lease_until=null where request_id=v_id;
      update model_automation_private.research_jobs set state=case when v_result->>'state'='added' then 'complete' else 'review' end where id=j.id;
    elsif v_kind='needs_details' then
      perform model_automation_private.contact_worker(p_secret,'clarify',v_id,v_key,v_outcome||jsonb_build_object('reason',coalesce(v_outcome->>'question',v_outcome->>'reason','Please confirm the outstanding model details.')));
      update model_automation_private.mail_outbox set research_job_id=j.id,research_version=j.round,research_fingerprint=v_hash
        where request_id=v_id and kind='question' and round=(select contact_round from public.calculator_model_request_jobs where request_id=v_id) and state='pending';
    elsif v_kind='review' then
      v_result:=model_automation_private.worker(p_secret,'review',v_id,v_key,v_outcome||jsonb_build_object('reason',coalesce(v_outcome->>'reason',j.result->>'summary','Research needs manual review')));
      update model_automation_private.research_jobs set state='review' where id=j.id;
    else
      update public.calculator_model_request_jobs set state='no_rebate',product=v_outcome->'product',evidence=v_outcome->'evidence',
        reason='Verified calculation returned no ESC or PRC certificates',lease_token=null,lease_until=null,updated_at=now() where request_id=v_id;
      update public.calculator_model_requests set status='no_rebate',updated_at=now() where id=v_id;
      insert into model_automation_private.mail_outbox(mail_key,request_id,round,kind,recipient,payload,research_job_id,research_version,research_fingerprint)
        values('no-rebate/'||v_id||'/'||j.round,v_id,j.round,'no_rebate',r.requester_email,
          jsonb_build_object('brand',v_outcome#>>'{product,brand}','model',v_outcome#>>'{product,model}',
            'registration',j.result#>>'{canonical,registrationNumber}','postcode',r.postcode,'install_type',r.install_type),j.id,j.round,v_hash) on conflict do nothing;
      update model_automation_private.research_jobs set state='no_rebate' where id=j.id;
    end if;
    update model_automation_private.research_jobs set applied_at=now(),applied_outcome=v_outcome,updated_at=now() where id=j.id;
    insert into model_automation_private.research_events(job_id,kind,detail) values(j.id,'applied',v_kind);
    return jsonb_build_object('state',(select state from public.calculator_model_request_jobs where request_id=v_id));
  end if;

  if j.state<>'researching' or p_lease is null or j.lease is distinct from p_lease or j.lease_until<=now()
    or l.state<>'researching' or not model_automation_private.can_contact_request(v_id) then raise exception 'Research lease is no longer current' using errcode='40001'; end if;
  if p_action='check_lease' then return null;
  elsif p_action='checkpoint' then
    if coalesce(p_data->>'round','') !~ '^[0-8]$' or jsonb_typeof(p_data->'input') is distinct from 'array'
      or jsonb_typeof(p_data->'records') is distinct from 'array' or jsonb_typeof(p_data->'sources') is distinct from 'array'
      or octet_length(p_data::text)>1000000 then raise exception 'Invalid research checkpoint'; end if;
    v_step:=(p_data->>'round')::integer;
    if v_step<coalesce((j.checkpoint->>'round')::integer,0) or v_step>coalesce((j.checkpoint->>'round')::integer,0)+1
      or (v_step>coalesce((j.checkpoint->>'round')::integer,0) and not exists(select 1 from model_automation_private.research_costs where job_id=j.id and state='settled' and step=v_step))
      or exists(select 1 from model_automation_private.research_costs where job_id=j.id and (state='uncertain'
        or (state='pending' and (lease<>p_lease or p_data is distinct from j.checkpoint)))) then raise exception 'Checkpoint does not account for completed provider calls'; end if;
    update model_automation_private.research_jobs set checkpoint=p_data,lease_until=now()+interval '3 minutes',updated_at=now() where id=j.id;
    return null;
  elsif p_action='reserve' then
    if coalesce(p_data->>'micros','') !~ '^[0-9]{1,9}$' or coalesce(p_data->>'limit','') !~ '^[0-9]{1,9}$' then raise exception 'Invalid budget reservation'; end if;
    v_amount:=(p_data->>'micros')::bigint; v_limit:=(p_data->>'limit')::bigint;
    -- Full 1,050,000-token context + 4,096 output + two searches, at >=2.2 FX/tax.
    if v_amount<11729168 or v_limit not between 1 and 20000000 then raise exception 'Monthly research budget cannot cover a bounded API call'; end if;
    if (now() at time zone 'Australia/Sydney')::date>date '2026-12-09' then raise exception 'Model/search pricing needs review before further paid calls'; end if;
    if j.checkpoint is null then raise exception 'Save a checkpoint before reserving an API call'; end if;
    v_step:=(j.checkpoint->>'round')::integer+1;
    if v_step>8 or exists(select 1 from model_automation_private.research_costs where job_id=j.id and
      (lease=p_lease or state in ('pending','uncertain') or (state='settled' and step>coalesce((j.checkpoint->>'round')::integer,0)))) then raise exception 'Provider call requires checkpoint or reconciliation'; end if;
    v_month:=date_trunc('month',now() at time zone 'Australia/Sydney')::date;
    insert into model_automation_private.research_budget(month) values(v_month) on conflict do nothing;
    perform 1 from model_automation_private.research_budget where month=v_month for update;
    if v_amount<(select ceil(5331440*minimum_fx) from model_automation_private.research_budget where month=v_month) then raise exception 'Monthly research budget requires the approved FX allowance'; end if;
    -- UPDATE re-evaluates against the current locked row even if this RPC began
    -- before another invocation committed. Do not gate spending on an aggregate
    -- helper whose calling-statement snapshot could predate that lock wait.
    update model_automation_private.research_budget set reserved_micros=reserved_micros+v_amount
      where month=v_month and seed_spent+spent_micros+reserved_micros+v_amount<=least(v_limit,limit_micros);
    if not found then raise exception 'Monthly research budget cannot cover another bounded API call'; end if;
    insert into model_automation_private.research_costs(job_id,lease,step,month,reserved) values(j.id,p_lease,v_step,v_month,v_amount) returning id into v_key;
    return to_jsonb(v_key);
  elsif p_action='finish' then
    if coalesce(p_data->>'state','') not in ('pending_verification','waiting_for_details','review','budget_paused') or jsonb_typeof(p_data->'result') is distinct from 'object'
      or octet_length((p_data->'result')::text)>1000000 then raise exception 'Invalid research result'; end if;
    if p_data->>'state' in ('pending_verification','waiting_for_details') and exists(select 1 from model_automation_private.research_costs where job_id=j.id and
      (state in ('pending','uncertain') or (state='settled' and step>coalesce((j.checkpoint->>'round')::integer,0)))) then raise exception 'Provider call requires reconciliation'; end if;
    update model_automation_private.research_jobs set state=p_data->>'state',result=p_data->'result',lease=null,lease_until=null,updated_at=now() where id=j.id;
    insert into model_automation_private.research_events(job_id,kind,detail) values(j.id,p_data->>'state',left(coalesce(p_data#>>'{result,summary}',p_data#>>'{result,reason}','Investigation completed'),2400));
    return null;
  elsif p_action='yield' then
    if exists(select 1 from model_automation_private.research_costs where job_id=j.id and
      (state in ('pending','uncertain') or (state='settled' and step>coalesce((j.checkpoint->>'round')::integer,0)))) then raise exception 'Provider call requires checkpoint or reconciliation'; end if;
    update model_automation_private.research_jobs set state='queued',lease=null,lease_until=null,updated_at=now() where id=j.id; return null;
  end if;
  raise exception 'Unknown research action';
end; $$;

create function public.model_request_research_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.research_worker(p_secret,p_action,p_id,p_lease,p_data); $$;
revoke all on function public.model_request_research_worker(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.model_request_research_worker(text,text,uuid,uuid,jsonb) to anon;

-- Preserve the legacy publisher; add only the final version fence on its send
-- authorization. This also protects callers using the original public RPC.
alter function model_automation_private.worker(text,text,uuid,uuid,jsonb) rename to worker_before_research;
revoke all on function model_automation_private.worker_before_research(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
create function model_automation_private.worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_round integer;
begin
  if length(coalesce(p_secret,''))<40 or not exists(select 1 from model_automation_private.settings where secret_hash=sha256(convert_to(p_secret,'UTF8'))) then raise exception 'Not authorized' using errcode='42501'; end if;
  if p_action='email_start' then
    perform 1 from public.calculator_model_requests where id=p_id for update;
    select round into v_round from model_automation_private.research_jobs where external_id=p_id and applied_at is not null
      and applied_outcome->>'kind'='ready_to_add' order by round desc limit 1;
    if found and model_automation_private.research_snapshot(p_id) is distinct from
      (select request from model_automation_private.research_rounds where external_id=p_id and round=v_round) then
      raise exception 'Request details changed; confirmation held for review';
    end if;
  end if;
  return model_automation_private.worker_before_research(p_secret,p_action,p_id,p_lease,p_data);
end; $$;
revoke all on function model_automation_private.worker(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function model_automation_private.worker(text,text,uuid,uuid,jsonb) to anon;
create or replace function public.model_request_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.worker(p_secret,p_action,p_id,p_lease,p_data); $$;

-- Wrappers below preserve the old contact scheduler and notification keys.
alter function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) rename to contact_worker_before_research;
revoke all on function model_automation_private.contact_worker_before_research(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
create function model_automation_private.contact_worker(p_secret text,p_action text,p_id uuid,p_lease uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m model_automation_private.mail_outbox%rowtype; j public.calculator_model_request_jobs%rowtype; v jsonb; v_snapshot jsonb; v_valid boolean;
  v_week timestamp:=date_trunc('week',now() at time zone 'Australia/Sydney');
begin
  if length(coalesce(p_secret,''))<40 or not exists(select 1 from model_automation_private.settings where secret_hash=sha256(convert_to(p_secret,'UTF8'))) then raise exception 'Not authorized' using errcode='42501'; end if;
  if p_action='claim' then
    -- Lock request first, then legacy job, then outbox, matching reply/application.
    select * into m from model_automation_private.mail_outbox where (p_id is null or request_id=p_id) and kind='no_rebate'
      and state in ('pending','sending') and available_at<=now() and (lease_until is null or lease_until<=now()) order by available_at,mail_key limit 1;
    if found then
      perform 1 from public.calculator_model_requests where id=m.request_id for update skip locked;
      if not found then return null; end if;
      select * into j from public.calculator_model_request_jobs where request_id=m.request_id for update;
      select * into m from model_automation_private.mail_outbox where mail_key=m.mail_key and state in ('pending','sending') and (lease_until is null or lease_until<=now()) for update;
      if not found then return null; end if;
      v_snapshot:=model_automation_private.research_snapshot(m.request_id);
      v_valid:=model_automation_private.can_contact_request(m.request_id) and j.state='no_rebate'
        and v_snapshot->>'round'=m.research_version::text and encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex')=m.research_fingerprint
        and exists(select 1 from model_automation_private.research_jobs q where q.id=m.research_job_id and q.state='no_rebate' and q.applied_at is not null);
      if not coalesce(v_valid,false) then
        update model_automation_private.mail_outbox set state=case when started_at is null then 'cancelled' else 'failed' end,lease=null,lease_until=null where mail_key=m.mail_key;
        return jsonb_build_object('state','failed');
      end if;
      if m.attempts>=3 or m.started_at<now()-interval '23 hours' then
        update model_automation_private.mail_outbox set state='failed',lease=null,lease_until=null where mail_key=m.mail_key; return jsonb_build_object('state','failed');
      end if;
      update model_automation_private.mail_outbox set state='sending',lease=gen_random_uuid(),lease_until=now()+interval '2 minutes',
        started_at=coalesce(started_at,now()),attempts=attempts+1 where mail_key=m.mail_key returning * into m;
      return to_jsonb(m);
    end if;
  elsif p_action in ('sent','retry') then
    select * into m from model_automation_private.mail_outbox where mail_key=p_data->>'key';
    if found and m.kind='no_rebate' then
      if p_id is not null and m.request_id is distinct from p_id then raise exception 'Email request does not match'; end if;
      perform 1 from public.calculator_model_requests where id=m.request_id for update;
      perform 1 from public.calculator_model_request_jobs where request_id=m.request_id for update;
      select * into m from model_automation_private.mail_outbox where mail_key=m.mail_key for update;
      if m.state<>'sending' or p_lease is null or m.lease is distinct from p_lease or m.lease_until is null or m.lease_until<=now() then raise exception 'Email lease expired'; end if;
      if p_action='sent' then
        if coalesce(p_data->>'provider_id','')='' then raise exception 'Provider message ID required'; end if;
        update model_automation_private.mail_outbox set state='sent',sent_at=now(),provider_id=p_data->>'provider_id',lease=null,lease_until=null where mail_key=m.mail_key;
        update public.calculator_model_request_jobs set activity=activity||model_automation_private.event('no_rebate_sent'),updated_at=now() where request_id=m.request_id;
      else
        update model_automation_private.mail_outbox set lease=null,lease_until=null,available_at=now()+interval '5 minutes' where mail_key=m.mail_key;
      end if;
      return null;
    end if;
  end if;
  -- Stamp research/version guards before delegating all old kinds, including
  -- reminders created by the unchanged scheduler after a question is sent.
  if p_action='claim' then
    update model_automation_private.mail_outbox outbox set state=case when outbox.started_at is null then 'cancelled' else 'failed' end
      where outbox.kind in ('question','reminder') and outbox.state in ('pending','sending') and (outbox.lease_until is null or outbox.lease_until<=now())
      and (p_id is null or outbox.request_id=p_id) and outbox.research_job_id is not null
      and not exists(select 1 from model_automation_private.research_requests h join model_automation_private.research_rounds r on r.external_id=h.request_id and r.round=h.version
        where h.request_id=outbox.request_id and h.version=outbox.research_version and r.fingerprint=outbox.research_fingerprint);
  end if;
  v:=model_automation_private.contact_worker_before_research(p_secret,p_action,p_id,p_lease,p_data);
  if p_action='maintain' then
    -- Never change the body behind a provider idempotency key once a send could
    -- have started, even if a later retry is still waiting in the outbox.
    update model_automation_private.mail_outbox set payload=payload||jsonb_build_object(
      'no_rebate',(select count(*) from model_automation_private.research_jobs where applied_outcome->>'kind'='no_rebate'
        and applied_at>=(v_week-interval '7 days') at time zone 'Australia/Sydney'
        and applied_at<v_week at time zone 'Australia/Sydney'),
      'researchBudget',model_automation_private.research_budget_status()-'charged'-'reserved',
      'research_paused',(select count(*) from model_automation_private.research_jobs where state='budget_paused'
        or (state='review' and result->>'summary' like 'Monthly research budget%')))
      where kind='weekly' and mail_key='weekly/'||to_char(v_week,'YYYY-MM-DD') and state='pending' and started_at is null and attempts=0;
  end if;
  if p_action='sent' then
    update model_automation_private.mail_outbox reminder set research_job_id=question.research_job_id,research_version=question.research_version,research_fingerprint=question.research_fingerprint
      from model_automation_private.mail_outbox question where question.mail_key=p_data->>'key' and question.kind='question'
        and reminder.request_id=question.request_id and reminder.round=question.round and reminder.kind='reminder';
  end if;
  return v;
end; $$;
revoke all on function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) to anon;
create or replace function public.model_request_contact_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.contact_worker(p_secret,p_action,p_id,p_lease,p_data); $$;

create or replace function model_automation_private.request_self(p_id uuid,p_response jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.calculator_model_requests%rowtype; j public.calculator_model_request_jobs%rowtype;
  v_model text; v_postcode text; v_install text; v_message text; v_version integer; v_help boolean; v_final boolean;
begin
  select * into r from public.calculator_model_requests where id=p_id for update;
  if not found or not model_automation_private.can_contact_request(p_id) or r.user_id is distinct from auth.uid()
    or lower(r.requester_email) is distinct from lower(auth.jwt()->>'email') then return null; end if;
  select * into j from public.calculator_model_request_jobs where request_id=p_id for update;
  perform model_automation_private.research_ensure(p_id);
  if p_response is not null then
    select version into v_version from model_automation_private.research_requests where request_id=p_id for update;
    if j.state<>'review' or j.contact_state is null or j.contact_state not in ('waiting','closed')
      or p_response->>'round' is distinct from j.contact_round::text
      or (p_response ? 'version' and p_response->>'version' is distinct from v_version::text) then raise exception 'Request is no longer awaiting a response'; end if;
    if exists(select 1 from model_automation_private.mail_outbox where request_id=p_id and kind in ('question','reminder','no_rebate') and state='sending' and lease_until>now()) then raise exception 'Requester notification is sending; retry shortly'; end if;
    v_model:=btrim(coalesce(p_response->>'model','')); v_postcode:=btrim(coalesce(p_response->>'postcode',''));
    v_install:=btrim(coalesce(p_response->>'install_type','')); v_message:=coalesce(p_response->>'message','');
    if jsonb_typeof(p_response)<>'object' or length(v_model)>180 or length(v_message)>1000 or v_model~'[[:cntrl:]]'
      or (v_postcode<>'' and (v_postcode!~'^[0-9]{4}$' or v_postcode='0000')) or v_install not in ('','new','replacement')
      or (p_response ? 'help' and jsonb_typeof(p_response->'help') not in ('boolean','null')) then raise exception 'Invalid model response'; end if;
    v_help:=p_response->>'help'='true' or v_message~* '\m(frustrat(ed|ing|ion)|fed up|still (not working|doesn.t work)|human|someone (call|contact|help)|no one (replied|responded)|getting nowhere)\M';
    if not coalesce(v_help,false) and btrim(v_message)='' and coalesce(nullif(v_model,''),r.model)=r.model
      and coalesce(nullif(v_postcode,''),r.postcode)=r.postcode and coalesce(nullif(v_install,''),r.install_type)=r.install_type then raise exception 'Add the requested information or ask for human help'; end if;
    if not coalesce(v_help,false) then
      update public.calculator_model_requests set model=coalesce(nullif(v_model,''),model),postcode=coalesce(nullif(v_postcode,''),postcode),
        install_type=coalesce(nullif(v_install,''),install_type),status='new',updated_at=now() where id=p_id;
    end if;
    update model_automation_private.research_requests set version=greatest(version,v_version+1),
      messages=case when v_message<>'' then messages||jsonb_build_array(v_message) else messages end where request_id=p_id;
    insert into model_automation_private.research_replies(request_id,version,response)
      select p_id,version,p_response from model_automation_private.research_requests where request_id=p_id;
    update model_automation_private.research_jobs set state='superseded',lease=null,lease_until=null,updated_at=now()
      where external_id=p_id and state not in ('complete','no_rebate','superseded');
    if coalesce(v_help,false) then
      update public.calculator_model_request_jobs set contact_state='escalated',contact_next_at=null,reason='Requester asked for help or reported frustration',
        activity=activity||model_automation_private.event('escalated',v_message),updated_at=now() where request_id=p_id;
      insert into model_automation_private.mail_outbox(mail_key,request_id,round,kind,recipient,payload)
        values('escalation/'||p_id||'/'||j.contact_round,p_id,j.contact_round,'escalation','danieldipalma88@gmail.com',
          jsonb_build_object('brand',r.brand,'model',r.model,'requester',r.requester_name,'business',r.business_name,
            'message',v_message,'question',j.contact_question,'submitted',r.created_at)) on conflict do nothing;
    else
      update public.calculator_model_request_jobs set state='queued',contact_state=null,contact_next_at=null,attempts=0,reason='',available_at=now(),lease_until=null,lease_token=null,
        activity=activity||model_automation_private.event('response_received',v_message),updated_at=now() where request_id=p_id;
    end if;
  end if;
  select * into r from public.calculator_model_requests where id=p_id;
  select * into j from public.calculator_model_request_jobs where request_id=p_id;
  v_final:=j.state in ('added','no_rebate') and (not exists(select 1 from model_automation_private.research_jobs where external_id=p_id)
    or exists(select 1 from model_automation_private.research_jobs q join model_automation_private.research_rounds snapshot using(external_id,round)
      where q.external_id=p_id and q.applied_at is not null and q.applied_outcome->>'kind' in ('ready_to_add','no_rebate')
        and snapshot.request=model_automation_private.research_snapshot(p_id)));
  return jsonb_build_object('brand',r.brand,'model',r.model,'system_type',r.system_type,'postcode',r.postcode,'install_type',r.install_type,
    'state',case when j.state in ('added','no_rebate') and not coalesce(v_final,false) then 'review' else coalesce(j.contact_state,j.state,r.status) end,
    'question',coalesce(j.contact_question,''),'candidates',coalesce(j.contact_candidates,'[]'),
    'next_at',j.contact_next_at,'round',j.contact_round,'version',(select version from model_automation_private.research_requests where request_id=p_id),
    'product',case when j.state in ('added','no_rebate') and not coalesce(v_final,false) then null else j.product end)
    ||case when coalesce(v_final,false) then jsonb_build_object('outcome',j.state,'no_rebate',j.state='no_rebate',
      'summary',case when j.state='no_rebate' then 'The exact Australian GEMS registration was checked. The verified calculation returned no ESC or PRC certificates for the submitted installation. This model was not added as a rebate-generating option.'
        else 'The verified model is available in the NSW calculator.' end,
      'matchedModel',concat_ws(' ',j.product->>'brand',j.product->>'model')||' ('||(j.product->>'capacityKw')||' kW, '||(j.product->>'phase')||' phase)')
      else '{}'::jsonb end;
end; $$;

create function model_automation_private.research_admin_list(p_filter text,p_query text,p_offset integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v jsonb;
begin
  if not model_automation_private.is_admin() then raise exception 'Not authorized' using errcode='42501'; end if;
  with matched as (
    select r.created_at,r.id,to_jsonb(r)||jsonb_build_object('job',(to_jsonb(j)-'lease_token'-'lease_until')||jsonb_build_object(
      'outcome_email',(select jsonb_build_object('state',m.state,'sent_at',m.sent_at) from model_automation_private.mail_outbox m
        where m.request_id=r.id and m.kind='no_rebate' and m.research_version=(select max(round) from model_automation_private.research_jobs where external_id=r.id)
        order by m.available_at desc,m.mail_key limit 1),
      'research',
      (select jsonb_build_object('id',q.id,'state',q.state,'round',q.round,'updated_at',q.updated_at,
        'result',jsonb_build_object('summary',q.result->'summary','canonical',q.result->'canonical','sourceUrls',q.result->'sourceUrls','question',q.result->'question'),
        'events',coalesce((select jsonb_agg(jsonb_build_object('kind',e.kind,'detail',left(e.detail,600),'at',e.at) order by e.sequence)
          from (select * from model_automation_private.research_events where job_id=q.id order by sequence desc limit 30) e),'[]'))
        from model_automation_private.research_jobs q where q.external_id=r.id order by q.round desc limit 1))) as item
    from public.calculator_model_requests r left join public.calculator_model_request_jobs j on j.request_id=r.id
    where (p_filter='all' or (p_filter='checking' and j.state in ('queued','checking','researching')) or (p_filter='researching' and j.state='researching')
      or (p_filter='no_rebate' and j.state='no_rebate') or (p_filter='added' and j.state in ('added','no_rebate'))
      or (p_filter='waiting' and j.contact_state='waiting') or (p_filter='closed' and (j.contact_state='closed' or r.status='declined'))
      or (p_filter='review' and ((j.state='review' and (j.contact_state is null or j.contact_state='escalated'))
        or (j.state='added' and (j.email_state='failed' or j.email_error<>''))
        or exists(select 1 from model_automation_private.mail_outbox m where m.request_id=r.id and m.kind='no_rebate' and m.state='failed')
        or (j.request_id is null and r.status in ('new','reviewing')))))
      and (p_query='' or strpos(lower(concat_ws(' ',r.brand,r.model,r.requester_name,r.requester_email,r.business_name)),lower(p_query))>0)
  ), page as (select * from matched order by created_at desc,id limit 101 offset greatest(p_offset,0))
  select jsonb_build_object('requests',coalesce((select jsonb_agg(item order by created_at desc,id) from (select * from page order by created_at desc,id limit 100) x),'[]'),
    'hasMore',(select count(*)>100 from page),'digest',model_automation_private.digest_status(),
    'researchBudget',model_automation_private.research_budget_status()-'charged'-'reserved',
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',id,'product',product,'active',active,'created_at',created_at) order by created_at desc)
      from public.calculator_catalogue_additions),'[]')) into v;
  return v;
end; $$;
create or replace function public.admin_model_request_list(p_filter text default 'review',p_query text default '',p_offset integer default 0) returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.research_admin_list(p_filter,p_query,p_offset); $$;

do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='model_automation_private' and tablename like 'research_%' loop
    execute format('alter table model_automation_private.%I enable row level security',t.tablename);
    execute format('revoke all on table model_automation_private.%I from public,anon,authenticated',t.tablename);
  end loop;
  for t in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='model_automation_private' and p.proname like 'research_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',t.signature);
  end loop;
end $$;
revoke all on sequence model_automation_private.research_events_sequence_seq from public,anon,authenticated;
grant execute on function model_automation_private.research_worker(text,text,uuid,uuid,jsonb) to anon;
grant execute on function model_automation_private.research_admin_list(text,text,integer) to authenticated;
select pg_notify('pgrst','reload schema');
commit;
