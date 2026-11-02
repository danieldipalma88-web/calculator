begin;

create schema if not exists model_automation_private;
revoke all on schema model_automation_private from public;
create table model_automation_private.settings (
  singleton boolean primary key default true check(singleton),
  secret_hash bytea not null
);
alter table model_automation_private.settings enable row level security;
revoke all on model_automation_private.settings from public, anon, authenticated;

alter table public.calculator_model_requests
  add column postcode text not null default '' check(postcode = '' or postcode ~ '^[0-9]{4}$'),
  add column install_type text not null default '' check(install_type in ('','new','replacement'));

create function model_automation_private.compact_identity(p jsonb) returns text
language sql immutable security invoker set search_path='' as $$
  select upper(regexp_replace(p->>'brand','[^A-Za-z0-9]','','g'))||'|'||
    least(upper(regexp_replace(split_part(p->>'model','/',1),'[^A-Za-z0-9]','','g')),upper(regexp_replace(split_part(p->>'model','/',2),'[^A-Za-z0-9]','','g')))||'/'||
    greatest(upper(regexp_replace(split_part(p->>'model','/',1),'[^A-Za-z0-9]','','g')),upper(regexp_replace(split_part(p->>'model','/',2),'[^A-Za-z0-9]','','g')));
$$;
revoke all on function model_automation_private.compact_identity(jsonb) from public,anon,authenticated;
create table public.calculator_catalogue_additions (
  id uuid primary key default gen_random_uuid(),
  identity text not null unique,
  compact_identity text generated always as (model_automation_private.compact_identity(product)) stored unique,
  product jsonb not null check(product->>'systemType' in ('split','ducted')),
  active boolean not null default true,
  disabled_at timestamptz,
  disabled_by text,
  created_at timestamptz not null default now()
);
alter table public.calculator_catalogue_additions enable row level security;
revoke all on public.calculator_catalogue_additions from public, anon, authenticated;
grant select(id,product,active,created_at) on public.calculator_catalogue_additions to anon, authenticated;
create policy published_models on public.calculator_catalogue_additions for select to anon,authenticated using(active);

create table public.calculator_model_request_jobs (
  request_id uuid primary key references public.calculator_model_requests(id) on delete cascade,
  state text not null default 'queued' check(state in ('queued','checking','review','added','declined')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  reason text not null default '',
  evidence jsonb not null default '{}',
  product jsonb,
  existing boolean not null default false,
  email_state text not null default 'pending' check(email_state in ('pending','sending','sent','failed')),
  email_started_at timestamptz,
  email_sent_at timestamptz,
  email_error text not null default '',
  email_id text,
  reviewed_by text,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.calculator_model_request_jobs enable row level security;
revoke all on public.calculator_model_request_jobs from public, anon, authenticated;
grant select on public.calculator_model_request_jobs to authenticated;

create function model_automation_private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.approved_users u where lower(u.email)=lower(auth.jwt()->>'email')
    and not coalesce(u.is_locked,false)
    and (u.role='admin' or lower(u.email)='danieldipalma88@gmail.com')
  );
$$;
revoke all on function model_automation_private.is_admin() from public;
grant usage on schema model_automation_private to authenticated, anon;
grant execute on function model_automation_private.is_admin() to authenticated;
create policy admin_model_requests on public.calculator_model_requests for select to authenticated
  using(model_automation_private.is_admin());
create policy request_job_visibility on public.calculator_model_request_jobs for select to authenticated using(
  model_automation_private.is_admin() or exists(select 1 from public.calculator_model_requests r where r.id=request_id and r.user_id=auth.uid())
);
create policy admin_catalogue on public.calculator_catalogue_additions for select to authenticated using(model_automation_private.is_admin());

create function model_automation_private.validate_submission() returns trigger
language plpgsql security definer set search_path='' as $$
declare u public.approved_users%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in required' using errcode='42501'; end if;
  select * into u from public.approved_users where lower(email)=lower(auth.jwt()->>'email');
  if not found or coalesce(u.is_locked,false) then raise exception 'Account is not approved' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,713));
  if not exists(select 1 from public.calculator_model_requests where user_id=auth.uid() and client_request_id=new.client_request_id)
    and (select count(*) from public.calculator_model_requests where user_id=auth.uid() and created_at>=now()-interval '15 minutes')>=5 then
    raise exception 'Request limit reached' using errcode='P0001';
  end if;
  if new.business_id is not null and not model_automation_private.is_admin()
    and new.business_id is distinct from u.business_id
    and not exists(select 1 from public.approved_user_businesses where lower(email)=lower(u.email) and business_id=new.business_id) then
    raise exception 'Business access denied' using errcode='42501';
  end if;
  if length(trim(new.brand)) not between 1 and 100 or length(trim(new.model)) not between 1 and 180
    or length(new.notes)>600 or length(new.capacity)>40 then raise exception 'Invalid model details'; end if;
  new.id:=gen_random_uuid(); new.user_id:=auth.uid(); new.requester_email:=lower(u.email);
  new.requester_name:=coalesce(u.display_name,u.email); new.business_name:=coalesce((select name from public.businesses where id=new.business_id),'');
  new.created_at:=now(); new.updated_at:=now(); new.status:='new'; new.notification_status:='pending';
  new.notification_attempted_at:=null; new.notification_sent_at:=null; new.notification_error:='';
  return new;
end;
$$;
revoke all on function model_automation_private.validate_submission() from public,anon,authenticated;
create trigger validate_new_model_request before insert on public.calculator_model_requests
  for each row execute function model_automation_private.validate_submission();

create function model_automation_private.enqueue() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.calculator_model_request_jobs(request_id) values(new.id);
  return new;
end;
$$;
revoke all on function model_automation_private.enqueue() from public,anon,authenticated;
create trigger queue_new_model_request after insert on public.calculator_model_requests
  for each row execute function model_automation_private.enqueue();

-- Only new requests are queued. Historical requests are never automatically emailed.
create function model_automation_private.worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  j public.calculator_model_request_jobs%rowtype;
  r public.calculator_model_requests%rowtype;
  added public.calculator_catalogue_additions%rowtype;
  p jsonb;
begin
  if length(coalesce(p_secret,'')) < 40 or not exists(select 1 from model_automation_private.settings where secret_hash=sha256(convert_to(p_secret,'UTF8'))) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if p_action='claim' then
    -- A crashed or repeatedly failing verifier becomes visible for manual review.
    update public.calculator_model_request_jobs set state='review',reason='Verification did not finish after three attempts',updated_at=now()
      where state in ('queued','checking') and attempts>=3 and coalesce(lease_until,available_at)<now();
    update public.calculator_model_request_jobs set email_state='failed',email_error='Delivery outcome uncertain. Check provider delivery logs before resending.',updated_at=now()
      where state='added' and email_state='sending' and email_started_at < now()-interval '23 hours';
    select * into j from public.calculator_model_request_jobs
      where (p_id is null or request_id=p_id) and available_at<=now()
        and (lease_until is null or lease_until<now())
        and ((state in ('queued','checking') and attempts<3) or (state='added' and email_state in ('pending','sending')))
      order by available_at,request_id for update skip locked limit 1;
    if not found then return null; end if;
    update public.calculator_model_request_jobs set lease_token=gen_random_uuid(),lease_until=now()+interval '6 minutes',
      state=case when state='added' then state else 'checking' end,
      attempts=case when state='added' then attempts else attempts+1 end,updated_at=now()
      where request_id=j.request_id returning * into j;
    select * into r from public.calculator_model_requests where id=j.request_id;
    return jsonb_build_object('job',to_jsonb(j),'request',to_jsonb(r),
      'operating_state',(select operating_state from public.businesses where id=r.business_id),
      'user_enabled',exists(select 1 from public.approved_users where lower(email)=lower(r.requester_email) and not coalesce(is_locked,false)));
  end if;
  select * into j from public.calculator_model_request_jobs where request_id=p_id for update;
  if not found or p_lease is null or j.lease_token is null or j.lease_until is null or j.lease_token is distinct from p_lease or j.lease_until<now() then
    raise exception 'Job lease expired' using errcode='40001';
  end if;
  if p_action='verified' then
    if j.state<>'checking' then raise exception 'Invalid job state'; end if;
    select * into r from public.calculator_model_requests where id=p_id;
    if not exists(select 1 from public.approved_users u where lower(u.email)=lower(r.requester_email) and not coalesce(u.is_locked,false)
      and (u.business_id=r.business_id or u.role='admin' or lower(u.email)='danieldipalma88@gmail.com'
        or exists(select 1 from public.approved_user_businesses m where lower(m.email)=lower(u.email) and m.business_id=r.business_id)))
      or not exists(select 1 from public.businesses where id=r.business_id and operating_state='NSW') then
      update public.calculator_model_request_jobs set state='review',reason='Requester or business access changed',lease_until=null,lease_token=null,updated_at=now() where request_id=p_id;
      return jsonb_build_object('state','review');
    end if;
    p:=p_data->'product';
    if p is null or p->>'systemType' not in ('split','ducted') or coalesce(p->>'brand','')='' or coalesce(p->>'model','')=''
      or p->>'phase' not in ('Single','Three') or coalesce((p->>'capacityKw')::numeric,0)<=0
      or coalesce(p_data->>'identity','')='' then raise exception 'Invalid verified model'; end if;
    -- A verified shadow row ensures availability in every NSW catalogue variant.
      insert into public.calculator_catalogue_additions(identity,product) values(p_data->>'identity',p)
        on conflict do nothing;
      select * into added from public.calculator_catalogue_additions where compact_identity=model_automation_private.compact_identity(p);
      if not found or not added.active or added.identity is distinct from (p_data->>'identity') or added.product is distinct from p then
        update public.calculator_model_request_jobs set state='review',reason='Model is disabled or has conflicting verified details',evidence=p_data->'evidence',lease_until=null,lease_token=null,updated_at=now() where request_id=p_id;
        return jsonb_build_object('state','review');
      end if;
      p:=added.product;
    update public.calculator_model_request_jobs set state='added',product=p,existing=coalesce((p_data->>'existing')::boolean,false),
      evidence=coalesce(p_data->'evidence','{}'),reason='',updated_at=now() where request_id=p_id returning * into j;
    update public.calculator_model_requests set status='added',updated_at=now() where id=p_id;
  elsif p_action='review' then
    if j.state<>'checking' then raise exception 'Invalid job state'; end if;
    update public.calculator_model_request_jobs set state='review',reason=left(p_data->>'reason',600),evidence=coalesce(p_data->'evidence','{}'),lease_until=null,lease_token=null,updated_at=now() where request_id=p_id returning * into j;
    update public.calculator_model_requests set status='reviewing',updated_at=now() where id=p_id;
  elsif p_action='retry' then
    if j.state<>'checking' then raise exception 'Invalid job state'; end if;
    update public.calculator_model_request_jobs set state=case when attempts>=3 then 'review' else 'queued' end,
      reason=left(p_data->>'reason',600),available_at=now()+interval '10 minutes',lease_until=null,lease_token=null,updated_at=now() where request_id=p_id returning * into j;
  elsif p_action='email_start' then
    if j.state<>'added' or j.email_state not in ('pending','sending') then raise exception 'Email not pending'; end if;
    if j.email_started_at<now()-interval '23 hours' then raise exception 'Email reconciliation required'; end if;
    perform 1 from public.calculator_catalogue_additions where product=j.product and active for update;
    if not found then raise exception 'Verified model is not published'; end if;
    update public.calculator_model_request_jobs set email_state='sending',email_started_at=coalesce(email_started_at,now()),lease_until=now()+interval '2 minutes',updated_at=now() where request_id=p_id returning * into j;
  elsif p_action='email_sent' then
    if j.state<>'added' or j.email_state<>'sending' then raise exception 'Email not sending'; end if;
    update public.calculator_model_request_jobs set email_state='sent',email_sent_at=now(),email_error='',email_id=p_data->>'id',lease_until=null,lease_token=null,updated_at=now() where request_id=p_id returning * into j;
  elsif p_action='email_error' then
    if j.state<>'added' then raise exception 'Model not published'; end if;
    update public.calculator_model_request_jobs set email_error=left(p_data->>'reason',600),
      email_state=case when exists(select 1 from public.calculator_catalogue_additions where product=j.product and active) then email_state else 'failed' end,
      available_at=now()+interval '10 minutes',lease_until=null,lease_token=null,updated_at=now() where request_id=p_id returning * into j;
  else raise exception 'Unknown worker action';
  end if;
  return to_jsonb(j);
end;
$$;
revoke all on function model_automation_private.worker(text,text,uuid,uuid,jsonb) from public;
grant execute on function model_automation_private.worker(text,text,uuid,uuid,jsonb) to anon;
create function public.model_request_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.worker(p_secret,p_action,p_id,p_lease,p_data); $$;
revoke all on function public.model_request_worker(text,text,uuid,uuid,jsonb) from public,authenticated;
grant execute on function public.model_request_worker(text,text,uuid,uuid,jsonb) to anon;

create function model_automation_private.admin_action(p_id uuid,p_action text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not model_automation_private.is_admin() then raise exception 'Not authorized' using errcode='42501'; end if;
  if p_action='disable' then
    -- Do not retract a product while its confirmation has an active send lease.
    perform 1 from public.calculator_catalogue_additions where id=p_id for update;
    if exists(select 1 from public.calculator_model_request_jobs j join public.calculator_catalogue_additions p on p.product=j.product
      where p.id=p_id and j.email_state='sending' and j.lease_until>now()) then raise exception 'Confirmation is sending; retry disabling shortly'; end if;
    update public.calculator_catalogue_additions set active=false,disabled_at=now(),disabled_by=auth.jwt()->>'email' where id=p_id;
  elsif p_action='retry' then
    update public.calculator_model_request_jobs set state='queued',attempts=0,reason='',available_at=now(),lease_until=null,lease_token=null,updated_at=now()
      where request_id=p_id and state='review';
    if not found then raise exception 'Only review requests can be retried'; end if;
  elsif p_action='decline' then
    perform 1 from public.calculator_model_request_jobs where request_id=p_id for update;
    if exists(select 1 from public.calculator_model_request_jobs where request_id=p_id and state not in ('review','declined')) then raise exception 'Request is processing or published'; end if;
    update public.calculator_model_request_jobs set state='declined',updated_at=now() where request_id=p_id;
    update public.calculator_model_requests set status='declined',updated_at=now() where id=p_id;
  else raise exception 'Invalid action'; end if;
  if p_action in ('retry','decline') then
    update public.calculator_model_request_jobs set reviewed_at=now(),reviewed_by=auth.jwt()->>'email' where request_id=p_id;
  end if;
end;
$$;
revoke all on function model_automation_private.admin_action(uuid,text) from public;
grant execute on function model_automation_private.admin_action(uuid,text) to authenticated;
create function public.admin_model_request_action(p_id uuid,p_action text) returns void
language sql security invoker set search_path='' as $$ select model_automation_private.admin_action(p_id,p_action); $$;
revoke all on function public.admin_model_request_action(uuid,text) from public,anon;
grant execute on function public.admin_model_request_action(uuid,text) to authenticated;

create function public.admin_model_request_list(p_filter text default 'review',p_query text default '',p_offset integer default 0) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if not model_automation_private.is_admin() then raise exception 'Not authorized' using errcode='42501'; end if;
  with matched as (
    select r.created_at,r.id,to_jsonb(r)||jsonb_build_object('job',to_jsonb(j)) as item
    from public.calculator_model_requests r left join public.calculator_model_request_jobs j on j.request_id=r.id
    where (p_filter='all' or (p_filter='checking' and j.state in ('queued','checking')) or (p_filter='added' and j.state='added')
      or (p_filter='review' and (j.state='review' or (j.state='added' and (j.email_state='failed' or j.email_error<>'')) or (j.request_id is null and r.status in ('new','reviewing')))))
      and (p_query='' or strpos(lower(concat_ws(' ',r.brand,r.model,r.requester_name,r.requester_email,r.business_name)),lower(p_query))>0)
  ), page as (select * from matched order by created_at desc,id limit 101 offset greatest(p_offset,0))
  select jsonb_build_object('requests',coalesce((select jsonb_agg(item order by created_at desc,id) from (select * from page order by created_at desc,id limit 100) x),'[]'),
    'hasMore',(select count(*)>100 from page),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',id,'product',product,'active',active,'created_at',created_at) order by created_at desc)
      from public.calculator_catalogue_additions),'[]')) into result;
  return result;
end;
$$;
revoke all on function public.admin_model_request_list(text,text,integer) from public,anon;
grant execute on function public.admin_model_request_list(text,text,integer) to authenticated;
select pg_notify('pgrst','reload schema');
commit;
