begin;

create table public.stillness_owner_alerts (
  id text primary key,
  kind text not null check (kind in ('trial','credit','depleted','test')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  finished_at timestamptz,
  outcome text check (outcome in ('accepted','failed'))
);
create index stillness_owner_alerts_pending_idx on public.stillness_owner_alerts (available_at)
  where outcome is null;
create table public.stillness_credit_balance (
  singleton boolean primary key default true check (singleton),
  cents integer not null check (cents between 0 and 1000000),
  observed_at timestamptz not null default now()
);
create index stillness_usage_gemini_created_idx on public.stillness_usage (created_at)
  where kind in ('voice','preview','script');

alter table public.stillness_owner_alerts enable row level security;
alter table public.stillness_credit_balance enable row level security;
revoke all on public.stillness_owner_alerts, public.stillness_credit_balance from public, anon, authenticated, service_role;
grant select, insert, update on public.stillness_owner_alerts, public.stillness_credit_balance to service_role;

create function public.stillness_queue_owner_alert(p_id text, p_kind text, p_details jsonb)
returns boolean language sql set search_path = '' as $$
  with queued as (
    insert into public.stillness_owner_alerts (id, kind, details) values (p_id, p_kind, p_details)
    on conflict (id) do nothing returning 1
  )
  select exists(select 1 from queued);
$$;

create function public.stillness_queue_owner_trial()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform public.stillness_queue_owner_alert('trial/' || new.user_id, 'trial',
    jsonb_build_object('endsAt', new.trial_ends_at));
  return new;
end;
$$;
create trigger stillness_queue_owner_trial
  after insert on public.stillness_trial_email
  for each row when (new.kind = 'started') execute function public.stillness_queue_owner_trial();

create function public.stillness_claim_owner_alert(p_id text)
returns jsonb language sql set search_path = '' as $$
  with candidate as (
    select a.id from public.stillness_owner_alerts a
    where a.outcome is null and a.available_at <= now()
      and a.created_at > now() - interval '7 days'
      and (p_id is null or a.id = p_id)
    order by a.available_at, a.id
    limit 1 for update of a skip locked
  )
  update public.stillness_owner_alerts a
  set available_at = now() + interval '5 minutes', attempts = a.attempts + 1
  from candidate c where a.id = c.id
  returning jsonb_build_object('id', a.id, 'kind', a.kind, 'details', a.details, 'attempts', a.attempts);
$$;

create function public.stillness_finish_owner_alert(p_id text, p_attempts integer, p_outcome text)
returns boolean language plpgsql set search_path = '' as $$
begin
  if p_outcome = 'retry' then
    update public.stillness_owner_alerts set available_at = now() + interval '1 minute'
    where id = p_id and attempts = p_attempts and outcome is null;
  elsif p_outcome in ('accepted','failed') then
    update public.stillness_owner_alerts set outcome = p_outcome, finished_at = now()
    where id = p_id and attempts = p_attempts and outcome is null;
  else
    return false;
  end if;
  return found;
end;
$$;

create function public.stillness_save_credit_balance(p_cents integer)
returns boolean language plpgsql set search_path = '' as $$
begin
  insert into public.stillness_credit_balance (cents) values (p_cents)
  on conflict (singleton) do update set cents = excluded.cents, observed_at = now();
  return true;
end;
$$;

create function public.stillness_owner_credit_status()
returns jsonb language sql stable set search_path = '' as $$
  with balance as (
    select cents, observed_at from (select true as singleton) s
    left join public.stillness_credit_balance b using (singleton)
  ), usage_totals as (
    select
      coalesce(sum(u.used_seconds) filter (where u.kind <> 'script' and u.created_at >= b.observed_at), 0) as voice_since,
      count(*) filter (where u.kind = 'script' and u.created_at >= b.observed_at) as scripts_since,
      coalesce(sum(u.used_seconds) filter (where u.kind <> 'script' and u.created_at >= now() - interval '7 days'), 0) as voice_week,
      count(*) filter (where u.kind = 'script' and u.created_at >= now() - interval '7 days') as scripts_week
    from balance b join public.stillness_usage u
      on u.kind in ('voice','preview','script')
      and u.created_at >= least(coalesce(b.observed_at, now()), now() - interval '7 days')
  ), allowances as (
    select count(*) as active_members,
      coalesce(sum(remaining_seconds::bigint + topup_seconds), 0) as premium_seconds
    from public.stillness_members
    where status in ('trialing','active') and period_ends_at > now()
  )
  select to_jsonb(b) || to_jsonb(u) || to_jsonb(a)
  from balance b cross join usage_totals u cross join allowances a;
$$;

revoke execute on function public.stillness_queue_owner_alert(text,text,jsonb),
  public.stillness_queue_owner_trial(), public.stillness_claim_owner_alert(text),
  public.stillness_finish_owner_alert(text,integer,text), public.stillness_save_credit_balance(integer),
  public.stillness_owner_credit_status() from public, anon, authenticated;
grant execute on function public.stillness_queue_owner_alert(text,text,jsonb),
  public.stillness_queue_owner_trial(), public.stillness_claim_owner_alert(text),
  public.stillness_finish_owner_alert(text,integer,text), public.stillness_save_credit_balance(integer),
  public.stillness_owner_credit_status() to service_role;

commit;
