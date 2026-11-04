begin;

alter table public.calculator_model_request_jobs
  add column contact_state text check (contact_state in ('waiting','closed','escalated')),
  add column contact_round integer not null default 0,
  add column contact_question text not null default '',
  add column contact_candidates jsonb not null default '[]',
  add column contact_next_at timestamptz,
  add column activity jsonb not null default '[]';

create table model_automation_private.mail_outbox (
  mail_key text primary key,
  request_id uuid references public.calculator_model_request_jobs(request_id) on delete cascade,
  round integer,
  kind text not null check (kind in ('question','reminder','escalation','weekly')),
  recipient text not null,
  payload jsonb not null,
  available_at timestamptz not null default now(),
  state text not null default 'pending' check (state in ('pending','sending','sent','failed','cancelled')),
  lease uuid,
  lease_until timestamptz,
  started_at timestamptz,
  sent_at timestamptz,
  provider_id text,
  attempts integer not null default 0
);
alter table model_automation_private.mail_outbox enable row level security;
revoke all on model_automation_private.mail_outbox from public, anon, authenticated;
create index model_request_mail_due_idx on model_automation_private.mail_outbox (available_at) where state in ('pending','sending');

create function model_automation_private.event(p_kind text, p_detail text default '') returns jsonb
language sql stable security invoker set search_path='' as $$
  select jsonb_build_array(jsonb_build_object('at',now(),'kind',p_kind,'detail',p_detail));
$$;
revoke all on function model_automation_private.event(text,text) from public;

create function model_automation_private.track_job() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.state in ('queued','declined') and new.state is distinct from old.state then
    new.contact_state:=null;
    new.contact_next_at:=null;
  end if;
  if old.contact_state='waiting' and new.contact_state is distinct from 'waiting' then
    update model_automation_private.mail_outbox set state='cancelled'
      where request_id=old.request_id and round=old.contact_round and kind in ('question','reminder')
        and (state='pending' or (state='sending' and coalesce(lease_until,now())<=now()));
  end if;
  if new.state is distinct from old.state and new.contact_state is null then
    new.activity:=new.activity||model_automation_private.event(
      case when new.state='added' and new.existing then 'already_available' else new.state end,
      case when new.state='review' then new.reason when new.state='added' then new.product->>'model' else '' end
    );
  end if;
  if new.email_state is distinct from old.email_state and new.email_state in ('sent','failed') then
    new.activity:=new.activity||model_automation_private.event('confirmation_'||new.email_state);
  end if;
  return new;
end;
$$;
revoke all on function model_automation_private.track_job() from public;
create trigger track_model_request_job before update on public.calculator_model_request_jobs
for each row execute function model_automation_private.track_job();

create function model_automation_private.business_date(p_start timestamptz,p_days integer) returns timestamptz
language sql stable security invoker set search_path='' as $$
  select (d::date + time '05:00') at time zone 'Australia/Sydney'
  from generate_series(1,20) as n
  cross join lateral (select (p_start at time zone 'Australia/Sydney')::date+n as d) as days
  where extract(isodow from d)<=5 order by d offset greatest(p_days-1,0) limit 1;
$$;
revoke all on function model_automation_private.business_date(timestamptz,integer) from public;

create function model_automation_private.can_contact_request(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.calculator_model_requests r
    join auth.users a on a.id=r.user_id and lower(a.email)=lower(r.requester_email)
    join public.approved_users u on lower(u.email)=lower(r.requester_email)
    join public.businesses b on b.id=r.business_id and b.operating_state='NSW'
    where r.id=p_id
      and not coalesce(u.is_locked,false)
      and (u.business_id=r.business_id or u.role='admin' or lower(u.email)='danieldipalma88@gmail.com'
        or exists(select 1 from public.approved_user_businesses m where lower(m.email)=lower(u.email) and m.business_id=r.business_id))
  );
$$;
revoke all on function model_automation_private.can_contact_request(uuid) from public;

create function model_automation_private.request_self(p_id uuid,p_response jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  r public.calculator_model_requests%rowtype;
  j public.calculator_model_request_jobs%rowtype;
  v_model text;
  v_postcode text;
  v_install text;
  v_message text;
begin
  if not model_automation_private.can_contact_request(p_id)
    or not exists(select 1 from public.calculator_model_requests owned where owned.id=p_id
      and owned.user_id=auth.uid() and lower(owned.requester_email)=lower(auth.jwt()->>'email')) then return null; end if;
  if p_response is not null then
    select * into j from public.calculator_model_request_jobs where request_id=p_id for update;
    if not found or j.state<>'review' or j.contact_state is null or j.contact_state not in ('waiting','closed')
      or p_response->>'round' is distinct from j.contact_round::text then
      raise exception 'Request is no longer awaiting a response';
    end if;
    select * into r from public.calculator_model_requests where id=p_id;
    v_model:=btrim(coalesce(p_response->>'model',''));
    v_postcode:=btrim(coalesce(p_response->>'postcode',''));
    v_install:=btrim(coalesce(p_response->>'install_type',''));
    v_message:=btrim(coalesce(p_response->>'message',''));
    if jsonb_typeof(p_response)<>'object' or length(v_model)>180 or length(v_message)>1000
      or v_model ~ '[[:cntrl:]]' or (v_postcode<>'' and (v_postcode !~ '^[0-9]{4}$' or v_postcode='0000'))
      or v_install not in ('','new','replacement')
      or (p_response ? 'help' and jsonb_typeof(p_response->'help') not in ('boolean','null')) then
      raise exception 'Invalid model response';
    end if;
    if p_response->>'help'='true' or v_message ~* '\m(frustrat(ed|ing|ion)|fed up|still (not working|doesn.t work)|human|someone (call|contact|help)|no one (replied|responded)|getting nowhere)\M' then
      update public.calculator_model_request_jobs set contact_state='escalated',contact_next_at=null,reason='Requester asked for help or reported frustration',
        activity=activity||model_automation_private.event('escalated',v_message),updated_at=now() where request_id=p_id;
      insert into model_automation_private.mail_outbox(mail_key,request_id,round,kind,recipient,payload)
        values('escalation/'||p_id||'/'||j.contact_round,p_id,j.contact_round,'escalation','danieldipalma88@gmail.com',
          jsonb_build_object('brand',r.brand,'model',r.model,'requester',r.requester_name,'business',r.business_name,
            'message',v_message,'question',j.contact_question,'submitted',r.created_at))
        on conflict do nothing;
    else
      if coalesce(nullif(v_model,''),r.model)=r.model and coalesce(nullif(v_postcode,''),r.postcode)=r.postcode
        and coalesce(nullif(v_install,''),r.install_type)=r.install_type then
        raise exception 'Add the requested information in the model or installation fields, or ask for human help';
      else
        update public.calculator_model_requests set model=coalesce(nullif(v_model,''),model),
          postcode=coalesce(nullif(v_postcode,''),postcode),install_type=coalesce(nullif(v_install,''),install_type),
          status='new',updated_at=now() where id=p_id;
        update public.calculator_model_request_jobs set state='queued',contact_state=null,contact_next_at=null,
          attempts=0,reason='',available_at=now(),lease_until=null,lease_token=null,
          activity=activity||model_automation_private.event('response_received',v_message),updated_at=now() where request_id=p_id;
      end if;
    end if;
  end if;
  select * into r from public.calculator_model_requests where id=p_id;
  select * into j from public.calculator_model_request_jobs where request_id=p_id;
  return jsonb_build_object('brand',r.brand,'model',r.model,'system_type',r.system_type,'postcode',r.postcode,'install_type',r.install_type,
    'state',coalesce(j.contact_state,j.state,r.status),'question',coalesce(j.contact_question,''),
    'candidates',coalesce(j.contact_candidates,'[]'),'next_at',j.contact_next_at,'round',j.contact_round,'product',j.product);
end;
$$;
revoke all on function model_automation_private.request_self(uuid,jsonb) from public;
grant execute on function model_automation_private.request_self(uuid,jsonb) to authenticated;
create function public.model_request_self(p_id uuid,p_response jsonb default null) returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.request_self(p_id,p_response); $$;
revoke all on function public.model_request_self(uuid,jsonb) from public,anon;
grant execute on function public.model_request_self(uuid,jsonb) to authenticated;

create function model_automation_private.clarify(p_id uuid,p_lease uuid,p_data jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare
  r public.calculator_model_requests%rowtype;
  j public.calculator_model_request_jobs%rowtype;
  v_question text:=left(p_data->>'reason',600);
  v_candidates jsonb:=coalesce(p_data->'candidates','[]');
begin
  select * into j from public.calculator_model_request_jobs where request_id=p_id for update;
  if not found or j.state<>'checking' or p_lease is null or j.lease_token is distinct from p_lease
    or j.lease_until is null or j.lease_until<now() then raise exception 'Job lease expired'; end if;
  select * into r from public.calculator_model_requests where id=p_id;
  if j.contact_round>=3 or not model_automation_private.can_contact_request(p_id) then
    update public.calculator_model_request_jobs set state='review',
      reason=case when j.contact_round>=3 then 'Still unresolved after three clarification rounds' else 'Requester or business access changed' end,
      lease_token=null,lease_until=null,updated_at=now() where request_id=p_id;
  else
    update public.calculator_model_request_jobs set state='review',contact_state='waiting',contact_round=contact_round+1,
      reason=v_question,contact_question=v_question,contact_candidates=v_candidates,contact_next_at=null,
      evidence=coalesce(p_data->'evidence','{}'),lease_token=null,lease_until=null,
      activity=activity||model_automation_private.event('waiting',v_question),updated_at=now()
      where request_id=p_id returning * into j;
    insert into model_automation_private.mail_outbox(mail_key,request_id,round,kind,recipient,payload)
      values('question/'||p_id||'/'||j.contact_round,p_id,j.contact_round,'question',r.requester_email,
        jsonb_build_object('brand',r.brand,'model',r.model,'question',v_question,'candidates',v_candidates));
  end if;
  update public.calculator_model_requests set status='reviewing',updated_at=now() where id=p_id;
end;
$$;
revoke all on function model_automation_private.clarify(uuid,uuid,jsonb) from public;

create function model_automation_private.contact_worker(p_secret text,p_action text,p_id uuid,p_lease uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  j public.calculator_model_request_jobs%rowtype;
  m model_automation_private.mail_outbox%rowtype;
  v_week timestamp:=date_trunc('week',now() at time zone 'Australia/Sydney');
  v_summary jsonb;
  v_key text;
  v_event text;
  v_close timestamptz;
begin
  if length(coalesce(p_secret,'')) < 40 or not exists(select 1 from model_automation_private.settings where secret_hash=sha256(convert_to(p_secret,'UTF8'))) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if p_action='clarify' then
    perform model_automation_private.clarify(p_id,p_lease,p_data);
    return null;
  elsif p_action='maintain' then
    update public.calculator_model_request_jobs jobs set contact_state='closed',contact_next_at=null,
      activity=activity||model_automation_private.event('closed','No response after the follow-up period'),updated_at=now()
      where jobs.contact_state='waiting' and exists(
        select 1 from model_automation_private.mail_outbox sent where sent.request_id=jobs.request_id and sent.round=jobs.contact_round
          and sent.kind='question' and sent.state='sent' and model_automation_private.business_date(sent.sent_at,10)<=now());
    -- An expired in-flight send may have reached the provider. Never resend it
    -- after the requester has already answered or the round is closed.
    update model_automation_private.mail_outbox outbox set state='failed',lease=null,lease_until=null
      where outbox.kind in ('question','reminder') and outbox.state='sending' and outbox.lease_until<now()
        and not exists(select 1 from public.calculator_model_request_jobs jobs where jobs.request_id=outbox.request_id
          and jobs.contact_round=outbox.round and jobs.contact_state='waiting');
    -- The unique key also lets Tuesday or Wednesday recover a missed Monday invocation.
    if extract(isodow from now() at time zone 'Australia/Sydney')<=3 then
      v_key:='weekly/'||to_char(v_week,'YYYY-MM-DD');
      if not exists(select 1 from model_automation_private.mail_outbox where mail_key=v_key) then
        with summary as (
          select r.brand,r.model,jobs.state,jobs.existing,jobs.contact_state,
            jobs.email_state='failed' or jobs.email_error<>'' as delivery_issue,
            exists(select 1 from jsonb_array_elements(jobs.activity) as e
              where e->>'kind' in ('added','already_available','closed')
                and (e->>'at')::timestamptz>=(v_week-interval '7 days') at time zone 'Australia/Sydney'
                and (e->>'at')::timestamptz<v_week at time zone 'Australia/Sydney') as recent_outcome
          from public.calculator_model_request_jobs jobs join public.calculator_model_requests r on r.id=jobs.request_id
        )
        select jsonb_build_object('week',to_char(v_week-interval '7 days','DD Mon YYYY'),
          'added',(select count(*) from summary where state='added' and not existing and recent_outcome),
          'existing',(select count(*) from summary where state='added' and existing and recent_outcome),
          'waiting',(select count(*) from summary where contact_state='waiting'),
          'closed',(select count(*) from summary where contact_state='closed' and recent_outcome),
          'review',(select count(*) from summary where (state='review' and contact_state is null or contact_state='escalated' or delivery_issue)),
          'models',coalesce((select jsonb_agg(left(brand||' '||model,220)) from (select brand,model from summary
            where state='added' and not existing and recent_outcome order by brand,model limit 20) s),'[]'))
          into v_summary;
        insert into model_automation_private.mail_outbox(mail_key,kind,recipient,payload)
          values(v_key,'weekly','danieldipalma88@gmail.com',v_summary) on conflict do nothing;
      end if;
    end if;
    return null;
  elsif p_action='claim' then
    select * into m from model_automation_private.mail_outbox q
      where (p_id is null or q.request_id=p_id) and q.available_at<=now() and q.state in ('pending','sending')
        and (q.lease_until is null or q.lease_until<now())
        and (q.kind in ('weekly','escalation') or exists (select 1 from public.calculator_model_request_jobs jobs
          where jobs.request_id=q.request_id and jobs.contact_round=q.round
            and jobs.contact_state='waiting'))
      order by (q.kind='escalation') desc,q.available_at,q.mail_key limit 1;
    if not found then return null; end if;
    if m.request_id is not null then
      select * into j from public.calculator_model_request_jobs where request_id=m.request_id for update skip locked;
      if not found or (m.kind in ('question','reminder') and (j.contact_round<>m.round or j.contact_state is distinct from 'waiting')) then return null; end if;
    end if;
    select * into m from model_automation_private.mail_outbox where mail_key=m.mail_key and state in ('pending','sending')
      and (lease_until is null or lease_until<now()) for update skip locked;
    if not found then return null; end if;
    if m.kind in ('question','reminder') and not model_automation_private.can_contact_request(m.request_id) then
      update model_automation_private.mail_outbox set state='cancelled' where mail_key=m.mail_key;
      update public.calculator_model_request_jobs set contact_state=null,contact_next_at=null,
        reason='Requester or business access changed',activity=activity||model_automation_private.event('contact_cancelled','Access changed'),
        updated_at=now() where request_id=m.request_id;
      return jsonb_build_object('state','failed');
    end if;
    if m.attempts>=3 or m.started_at < now()-interval '23 hours' then
      update model_automation_private.mail_outbox set state='failed' where mail_key=m.mail_key;
      if m.request_id is not null then
        update public.calculator_model_request_jobs set
          contact_state=case when m.kind='escalation' then contact_state else null end,
          contact_next_at=case when m.kind='escalation' then contact_next_at else null end,
          reason=case when m.kind='escalation' and contact_state is distinct from 'escalated' then reason
            else 'Email delivery could not be verified. Review before sending again.' end,
          activity=activity||model_automation_private.event('contact_failed',m.kind),updated_at=now() where request_id=m.request_id;
      end if;
      return jsonb_build_object('state','failed');
    end if;
    update model_automation_private.mail_outbox set state='sending',lease=gen_random_uuid(),
      lease_until=now()+interval '2 minutes',started_at=coalesce(started_at,now()),attempts=attempts+1
      where mail_key=m.mail_key returning * into m;
    return to_jsonb(m);
  elsif p_action in ('sent','retry') then
    select * into m from model_automation_private.mail_outbox where mail_key=p_data->>'key';
    if not found then raise exception 'Unknown email'; end if;
    if m.request_id is not null then
      select * into j from public.calculator_model_request_jobs where request_id=m.request_id for update;
    end if;
    select * into m from model_automation_private.mail_outbox where mail_key=m.mail_key for update;
    if m.state<>'sending' or p_lease is null or m.lease is distinct from p_lease or m.lease_until<now() then
      raise exception 'Email lease expired';
    end if;
    if p_action='retry' then
      update model_automation_private.mail_outbox set lease_until=null,lease=null,available_at=now()+interval '5 minutes',
        state=case when m.kind in ('question','reminder') and (j.contact_state is distinct from 'waiting' or j.contact_round<>m.round)
          then 'failed' else 'sending' end
        where mail_key=m.mail_key;
      return null;
    end if;
    if coalesce(p_data->>'provider_id','')='' then raise exception 'Provider message ID required'; end if;
    update model_automation_private.mail_outbox set state='sent',sent_at=now(),provider_id=p_data->>'provider_id',
      lease_until=null,lease=null where mail_key=m.mail_key;
    if m.request_id is null then return null; end if;
    v_event:=case m.kind when 'question' then 'question_sent' when 'reminder' then 'reminder_sent' else 'escalation_sent' end;
    update public.calculator_model_request_jobs set activity=activity||model_automation_private.event(v_event),
      updated_at=now() where request_id=m.request_id;
    if j.contact_state='waiting' and j.contact_round=m.round and m.kind='question' then
      v_close:=model_automation_private.business_date(now(),10);
      insert into model_automation_private.mail_outbox(mail_key,request_id,round,kind,recipient,payload,available_at)
        select 'reminder-'||day||'/'||m.request_id||'/'||m.round,m.request_id,m.round,'reminder',m.recipient,
          m.payload||jsonb_build_object('day',day,'next',case when day=2 then model_automation_private.business_date(now(),5) else v_close end),
          model_automation_private.business_date(now(),day) from (values (2),(5)) days(day)
        on conflict do nothing;
      update public.calculator_model_request_jobs set contact_next_at=model_automation_private.business_date(now(),2)
        where request_id=m.request_id;
    elsif j.contact_state='waiting' and j.contact_round=m.round and m.kind='reminder' then
      update public.calculator_model_request_jobs set contact_next_at=(m.payload->>'next')::timestamptz where request_id=m.request_id;
    end if;
    return null;
  end if;
  raise exception 'Unknown model request contact action';
end;
$$;
revoke all on function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) from public;
grant execute on function model_automation_private.contact_worker(text,text,uuid,uuid,jsonb) to anon;
create function public.model_request_contact_worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
language sql security invoker set search_path='' as $$ select model_automation_private.contact_worker(p_secret,p_action,p_id,p_lease,p_data); $$;
revoke all on function public.model_request_contact_worker(text,text,uuid,uuid,jsonb) from public,authenticated;
grant execute on function public.model_request_contact_worker(text,text,uuid,uuid,jsonb) to anon;

-- Keep targeted verification and confirmation actions scoped to the requested row.
create or replace function model_automation_private.worker(p_secret text,p_action text,p_id uuid default null,p_lease uuid default null,p_data jsonb default '{}') returns jsonb
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
      where (p_id is null or request_id=p_id) and state in ('queued','checking') and attempts>=3 and coalesce(lease_until,available_at)<now();
    update public.calculator_model_request_jobs set email_state='failed',email_error='Delivery outcome uncertain. Check provider delivery logs before resending.',updated_at=now()
      where (p_id is null or request_id=p_id) and state='added' and email_state='sending' and email_started_at < now()-interval '23 hours';
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
      'user_enabled',model_automation_private.can_contact_request(r.id));
  end if;
  select * into j from public.calculator_model_request_jobs where request_id=p_id for update;
  if not found or p_lease is null or j.lease_token is null or j.lease_until is null or j.lease_token is distinct from p_lease or j.lease_until<now() then
    raise exception 'Job lease expired' using errcode='40001';
  end if;
  if p_action='verified' then
    if j.state<>'checking' then raise exception 'Invalid job state'; end if;
    if not model_automation_private.can_contact_request(p_id) then
      update public.calculator_model_request_jobs set state='review',reason='Requester or business access changed',lease_until=null,lease_token=null,updated_at=now() where request_id=p_id;
      update public.calculator_model_requests set status='reviewing',updated_at=now() where id=p_id;
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
    if not model_automation_private.can_contact_request(p_id) then raise exception 'Requester or business access changed'; end if;
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
      email_state=case when model_automation_private.can_contact_request(p_id)
        and exists(select 1 from public.calculator_catalogue_additions where product=j.product and active) then email_state else 'failed' end,
      available_at=now()+interval '10 minutes',lease_until=null,lease_token=null,updated_at=now() where request_id=p_id returning * into j;
  else raise exception 'Unknown worker action';
  end if;
  return to_jsonb(j);
end;
$$;

create function model_automation_private.digest_status() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('state',state,'week',payload->>'week','sent_at',sent_at)
    from model_automation_private.mail_outbox where model_automation_private.is_admin() and kind='weekly'
    order by available_at desc limit 1;
$$;
revoke all on function model_automation_private.digest_status() from public;
grant execute on function model_automation_private.digest_status() to authenticated;

create or replace function public.admin_model_request_list(p_filter text default 'review',p_query text default '',p_offset integer default 0) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  if not model_automation_private.is_admin() then raise exception 'Not authorized' using errcode='42501'; end if;
  with matched as (
    select r.created_at,r.id,to_jsonb(r)||jsonb_build_object('job',to_jsonb(j)-'lease_token') as item
    from public.calculator_model_requests r left join public.calculator_model_request_jobs j on j.request_id=r.id
    where (p_filter='all' or (p_filter='checking' and j.state in ('queued','checking')) or (p_filter='added' and j.state='added')
      or (p_filter='waiting' and j.contact_state='waiting') or (p_filter='closed' and (j.contact_state='closed' or r.status='declined'))
      or (p_filter='review' and ((j.state='review' and (j.contact_state is null or j.contact_state='escalated'))
        or (j.state='added' and (j.email_state='failed' or j.email_error<>'')) or (j.request_id is null and r.status in ('new','reviewing')))))
      and (p_query='' or strpos(lower(concat_ws(' ',r.brand,r.model,r.requester_name,r.requester_email,r.business_name)),lower(p_query))>0)
  ), page as (select * from matched order by created_at desc,id limit 101 offset greatest(p_offset,0))
  select jsonb_build_object('requests',coalesce((select jsonb_agg(item order by created_at desc,id) from (select * from page order by created_at desc,id limit 100) x),'[]'),
    'hasMore',(select count(*)>100 from page),
    'digest',model_automation_private.digest_status(),
    'products',coalesce((select jsonb_agg(jsonb_build_object('id',id,'product',product,'active',active,'created_at',created_at) order by created_at desc)
      from public.calculator_catalogue_additions),'[]')) into result;
  return result;
end;
$$;

-- Requesters receive the minimal owner-scoped RPC response, not job internals.
drop policy request_job_visibility on public.calculator_model_request_jobs;
create policy request_job_visibility on public.calculator_model_request_jobs for select to authenticated
using (model_automation_private.is_admin());

select pg_notify('pgrst','reload schema');
commit;
