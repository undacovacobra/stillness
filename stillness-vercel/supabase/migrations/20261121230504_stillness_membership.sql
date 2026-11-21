begin;

create table public.stillness_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text not null default '' check (char_length(name) <= 80),
  goal text not null default '' check (char_length(goal) <= 120),
  stripe_customer_id text unique,
  subscription_id text unique,
  status text not null default 'inactive'
    check (status in ('inactive','trialing','active','past_due','unpaid','incomplete','incomplete_expired','paused','canceled')),
  cancel_at_period_end boolean not null default false,
  period_starts_at timestamptz,
  period_ends_at timestamptz,
  trial_used boolean not null default false,
  remaining_seconds integer not null default 0 check (remaining_seconds >= 0),
  topup_seconds integer not null default 0 check (topup_seconds >= 0),
  voice_seconds_used bigint not null default 0 check (voice_seconds_used >= 0),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  allowance_version bigint not null default 0,
  stripe_event_created bigint not null default 0
);

-- Claims survive account deletion so the same card cannot unlock another trial.
create table public.stillness_trial_claims (
  setup_id text primary key,
  user_id uuid not null unique,
  card_hash text not null unique check (card_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create table public.stillness_billing_events (
  event_id text primary key,
  user_id uuid not null,
  reason text
);

create table public.stillness_topup_purchases (
  purchase_id text primary key,
  user_id uuid not null references public.stillness_members(user_id) on delete cascade
);

create table public.stillness_usage (
  user_id uuid not null references public.stillness_members(user_id) on delete cascade,
  request_id text not null,
  kind text not null check (kind in ('voice', 'preview', 'script')),
  allowance_version bigint not null,
  held_included integer not null check (held_included >= 0),
  held_topup integer not null check (held_topup >= 0),
  used_seconds integer check (used_seconds >= 0),
  outcome text check (outcome in ('settled', 'expired', 'limit')),
  created_at timestamptz not null default now(),
  primary key (user_id, request_id)
);

create index stillness_members_newest_idx on public.stillness_members (created_at desc, user_id);
create index stillness_topup_purchases_member_idx on public.stillness_topup_purchases (user_id);
create index stillness_usage_rate_idx on public.stillness_usage (user_id, created_at desc);
create index stillness_usage_pending_idx on public.stillness_usage (user_id, created_at) where outcome is null;

alter table public.stillness_members enable row level security;
alter table public.stillness_trial_claims enable row level security;
alter table public.stillness_billing_events enable row level security;
alter table public.stillness_topup_purchases enable row level security;
alter table public.stillness_usage enable row level security;

-- Only server-side credentials can call the RPCs or access these tables.
revoke all on public.stillness_members, public.stillness_trial_claims, public.stillness_billing_events,
  public.stillness_topup_purchases, public.stillness_usage from public, anon, authenticated, service_role;
grant select, insert, update on public.stillness_members, public.stillness_trial_claims, public.stillness_billing_events,
  public.stillness_topup_purchases, public.stillness_usage to service_role;

create function public.stillness_get_member(p_user_id uuid, p_email text)
returns jsonb language plpgsql set search_path = '' as $$
begin
  insert into public.stillness_members (user_id, email)
  values (p_user_id, p_email)
  on conflict (user_id) do update set email = excluded.email
    where excluded.email is not null and stillness_members.email is distinct from excluded.email;
  return (select to_jsonb(m) - 'allowance_version' - 'stripe_event_created'
    from public.stillness_members m where user_id = p_user_id);
end;
$$;

create function public.stillness_save_profile(p_user_id uuid, p_name text, p_goal text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  member public.stillness_members%rowtype;
begin
  insert into public.stillness_members (user_id, name, goal)
  values (p_user_id, trim(p_name), trim(p_goal))
  on conflict (user_id) do update set name = excluded.name, goal = excluded.goal
  returning * into member;
  return to_jsonb(member) - 'allowance_version' - 'stripe_event_created';
end;
$$;

create function public.stillness_list_members(p_limit integer, p_offset integer)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(m) - 'stripe_customer_id' - 'subscription_id' - 'allowance_version' - 'stripe_event_created'
    order by m.created_at desc, m.user_id), '[]'::jsonb)
  from (
    select * from public.stillness_members
    order by created_at desc, user_id
    limit greatest(1, least(p_limit, 100))
    offset greatest(0, p_offset)
  ) as m;
$$;

create function public.stillness_set_stripe_customer(p_user_id uuid, p_customer_id text)
returns jsonb language plpgsql set search_path = '' as $$
begin
  if p_customer_id is null or p_customer_id !~ '^cus_[a-zA-Z0-9]+$' then
    raise exception 'Invalid Stripe customer' using errcode = '22023';
  end if;
  insert into public.stillness_members (user_id, stripe_customer_id)
  values (p_user_id, p_customer_id)
  on conflict (user_id) do update set stripe_customer_id = excluded.stripe_customer_id
    where stillness_members.stripe_customer_id is null;
  return (select to_jsonb(m) - 'allowance_version' - 'stripe_event_created'
    from public.stillness_members m where user_id = p_user_id);
end;
$$;

create function public.stillness_find_member_by_customer(p_customer_id text)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(m) - 'allowance_version' - 'stripe_event_created'
  from public.stillness_members m where stripe_customer_id = p_customer_id;
$$;

create function public.stillness_claim_trial_card(p_user_id uuid, p_customer_id text, p_setup_id text, p_card_hash text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  member public.stillness_members%rowtype;
  existing_claim public.stillness_trial_claims%rowtype;
begin
  select * into member from public.stillness_members where user_id = p_user_id for update;
  if not found or p_customer_id is null or member.stripe_customer_id is distinct from p_customer_id then
    return jsonb_build_object('applied', false, 'reason', 'customer_mismatch');
  end if;
  if p_setup_id is null or p_setup_id !~ '^seti_[a-zA-Z0-9]+$' or p_card_hash is null or p_card_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('applied', false, 'reason', 'invalid_claim');
  end if;

  select * into existing_claim from public.stillness_trial_claims where user_id = p_user_id;
  if found and existing_claim.setup_id = p_setup_id and existing_claim.card_hash = p_card_hash then
    return jsonb_build_object('applied', true, 'reason', 'already_claimed');
  end if;
  if member.trial_used or member.subscription_id is not null or existing_claim.setup_id is not null then
    return jsonb_build_object('applied', false, 'reason', 'duplicate_trial');
  end if;

  insert into public.stillness_trial_claims (setup_id, user_id, card_hash)
  values (p_setup_id, p_user_id, p_card_hash)
  on conflict do nothing;
  if not found then
    update public.stillness_members set trial_used = true where user_id = p_user_id;
    return jsonb_build_object('applied', false, 'reason', 'duplicate_trial');
  end if;
  return jsonb_build_object('applied', true);
end;
$$;

create function public.stillness_apply_billing_event(
  p_event_id text, p_event_created bigint, p_user_id uuid, p_customer_id text, p_subscription_id text,
  p_status text, p_period_ends_at timestamptz, p_period_starts_at timestamptz, p_entitlement text,
  p_trial_claim_id text, p_topup_purchase_id text, p_cancel_at_period_end boolean
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  member public.stillness_members%rowtype;
  applied boolean := false;
  result_reason text;
  new_period boolean;
begin
  select * into member from public.stillness_members where user_id = p_user_id for update;
  if not found or p_customer_id is null or member.stripe_customer_id is distinct from p_customer_id then
    return jsonb_build_object('applied', false, 'reason', 'customer_mismatch');
  end if;
  insert into public.stillness_billing_events (event_id, user_id)
  values (p_event_id, p_user_id) on conflict do nothing;
  if not found then
    select reason into result_reason from public.stillness_billing_events
    where event_id = p_event_id and user_id = p_user_id;
    return jsonb_build_object('applied', false, 'reason', coalesce(result_reason, 'duplicate'));
  end if;

  if p_entitlement = 'topup' then
    if p_topup_purchase_id is null or p_topup_purchase_id = '' then
      result_reason := 'invalid_purchase';
    else
      insert into public.stillness_topup_purchases (purchase_id, user_id)
      values (p_topup_purchase_id, p_user_id) on conflict do nothing;
      if found then
        update public.stillness_members set topup_seconds = topup_seconds + 3600 where user_id = p_user_id;
        applied := true;
      else
        result_reason := 'duplicate';
      end if;
    end if;
  elsif p_entitlement = 'trial' then
    if p_subscription_id = member.subscription_id and member.trial_used then
      if member.status = 'trialing' and p_event_created >= member.stripe_event_created then
        update public.stillness_members set
          cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
          stripe_event_created = greatest(stripe_event_created, p_event_created)
        where user_id = p_user_id;
      end if;
      result_reason := 'duplicate';
    elsif member.trial_used or member.subscription_id is not null or not exists (
      select 1 from public.stillness_trial_claims where setup_id = p_trial_claim_id and user_id = p_user_id
    ) then
      result_reason := 'duplicate_trial';
    elsif p_subscription_id is null or p_period_ends_at is null or p_period_starts_at is null
      or p_period_ends_at <= p_period_starts_at or p_period_ends_at > p_period_starts_at + interval '11 days' then
      result_reason := 'invalid_period';
    else
      update public.stillness_members set
        status = 'trialing', subscription_id = p_subscription_id, trial_used = true,
        remaining_seconds = 900, allowance_version = allowance_version + 1,
        period_starts_at = p_period_starts_at, period_ends_at = p_period_ends_at,
        cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
        stripe_event_created = greatest(stripe_event_created, p_event_created)
      where user_id = p_user_id;
      applied := true;
    end if;
  elsif p_entitlement = 'paid' then
    if p_subscription_id is null or p_period_ends_at is null or p_period_starts_at is null or p_period_ends_at <= p_period_starts_at then
      result_reason := 'invalid_period';
    elsif (member.period_starts_at > p_period_starts_at or p_event_created < member.stripe_event_created)
      and (member.period_ends_at is null or p_period_ends_at <= member.period_ends_at) then
      result_reason := 'stale';
    elsif member.subscription_id is distinct from p_subscription_id
      and member.status in ('trialing', 'active') and member.period_ends_at > now() then
      result_reason := 'subscription_mismatch';
    else
      new_period := member.subscription_id is distinct from p_subscription_id
        or member.period_starts_at is null or p_period_starts_at > member.period_starts_at
        or (member.status = 'trialing' and p_period_ends_at > member.period_ends_at);
      update public.stillness_members set
        status = 'active', subscription_id = p_subscription_id, trial_used = true,
        remaining_seconds = case when new_period then 7200 else remaining_seconds end,
        allowance_version = case when new_period then allowance_version + 1 else allowance_version end,
        period_starts_at = greatest(period_starts_at, p_period_starts_at), period_ends_at = greatest(period_ends_at, p_period_ends_at),
        cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
        stripe_event_created = greatest(stripe_event_created, p_event_created)
      where user_id = p_user_id;
      applied := true;
    end if;
  elsif p_entitlement = 'status' then
    if p_subscription_id is null or member.subscription_id is distinct from p_subscription_id then
      result_reason := 'subscription_mismatch';
    elsif p_event_created < member.stripe_event_created then
      result_reason := 'stale';
    elsif p_status is null or p_status not in ('trialing','active','past_due','unpaid','incomplete','incomplete_expired','paused','canceled') then
      result_reason := 'invalid_status';
    else
      -- Only a trial claim or paid invoice grants time.
      update public.stillness_members set
        status = case when p_status in ('trialing','active') then status else p_status end,
        cancel_at_period_end = coalesce(p_cancel_at_period_end, cancel_at_period_end),
        stripe_event_created = greatest(stripe_event_created, p_event_created)
      where user_id = p_user_id;
      applied := true;
    end if;
  else
    result_reason := 'invalid_entitlement';
  end if;

  update public.stillness_billing_events set reason = result_reason where event_id = p_event_id;
  return jsonb_build_object('applied', applied, 'reason', result_reason);
end;
$$;

create function public.stillness_reserve_usage(p_user_id uuid, p_request_id text, p_seconds integer, p_kind text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  member public.stillness_members%rowtype;
  reason text;
  restored_included integer;
  restored_topup integer;
  new_included integer;
  new_topup integer;
  utc_today timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_request_id is null or char_length(p_request_id) not between 1 and 128
    or p_kind is null or p_kind not in ('voice', 'preview', 'script')
    or p_seconds is null or p_seconds not between 0 and 7200 or (p_kind = 'script') <> (p_seconds = 0) then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_request');
  end if;

  select * into member from public.stillness_members where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'inactive', 'remaining_seconds', 0, 'topup_seconds', 0);
  end if;

  -- Clear abandoned holds after the provider time limit. Refund time into its original bucket.
  with expired as (
    update public.stillness_usage set outcome = 'expired'
    where user_id = p_user_id and outcome is null and created_at < now() - interval '5 minutes'
    returning held_included, held_topup, allowance_version
  )
  select coalesce(sum(held_included) filter (where allowance_version = member.allowance_version), 0),
    coalesce(sum(held_topup), 0)
  into restored_included, restored_topup from expired;

  if restored_included + restored_topup > 0 then
    update public.stillness_members set
      remaining_seconds = remaining_seconds + restored_included, topup_seconds = topup_seconds + restored_topup
    where user_id = p_user_id returning * into member;
  end if;
  if member.status not in ('active','trialing') or member.period_ends_at is null or member.period_ends_at <= now() then
    reason := 'inactive';
  elsif exists (select 1 from public.stillness_usage where user_id = p_user_id and request_id = p_request_id) then
    reason := 'duplicate';
  elsif member.remaining_seconds + member.topup_seconds < greatest(p_seconds, 1) then
    reason := 'limit';
  elsif (select count(*) from public.stillness_usage
    where user_id = p_user_id and created_at >= utc_today and (kind = 'script') = (p_kind = 'script'))
    >= (case when p_kind = 'script' then 30 else 280 end) then
    reason := 'rate_limited';
  elsif (select count(*) from public.stillness_usage where user_id = p_user_id and outcome is null) >= 4 then
    reason := 'rate_limited';
  end if;

  if reason is null then
    new_included := least(p_seconds, member.remaining_seconds);
    new_topup := p_seconds - new_included;
    insert into public.stillness_usage (user_id, request_id, kind, allowance_version, held_included, held_topup)
    values (p_user_id, p_request_id, p_kind, member.allowance_version, new_included, new_topup);
    update public.stillness_members set
      remaining_seconds = remaining_seconds - new_included,
      topup_seconds = topup_seconds - new_topup,
      last_used_at = now()
    where user_id = p_user_id returning * into member;
  end if;
  return jsonb_build_object('allowed', reason is null, 'reason', reason,
    'remaining_seconds', member.remaining_seconds, 'topup_seconds', member.topup_seconds);
end;
$$;

create function public.stillness_settle_usage(p_user_id uuid, p_request_id text, p_used_seconds integer)
returns jsonb language plpgsql set search_path = '' as $$
declare
  member public.stillness_members%rowtype;
  hold public.stillness_usage%rowtype;
  accepted boolean := false;
  reason text;
  additional integer;
  actual_used integer;
  included_change integer;
  topup_change integer;
  outcome_value text;
begin
  if p_used_seconds is null or p_used_seconds not between 0 and 7200 then
    return jsonb_build_object('accepted', false, 'reason', 'invalid_request');
  end if;
  -- Reservations and events always lock in this order.
  select * into member from public.stillness_members where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('accepted', false, 'reason', 'inactive', 'remaining_seconds', 0, 'topup_seconds', 0);
  end if;
  select * into hold from public.stillness_usage where user_id = p_user_id and request_id = p_request_id for update;
  if not found then
    reason := 'missing';
  elsif hold.outcome is not null then
    accepted := hold.outcome = 'settled' and hold.used_seconds = p_used_seconds;
    reason := case when accepted then null else hold.outcome end;
  else
    actual_used := p_used_seconds;
    additional := greatest(0, p_used_seconds - hold.held_included - hold.held_topup);
    outcome_value := 'settled';
    if hold.created_at < now() - interval '5 minutes' then
      reason := 'expired';
    elsif hold.kind = 'script' and p_used_seconds > 0 then
      reason := 'invalid_request';
    elsif additional > member.remaining_seconds + member.topup_seconds then
      reason := 'limit';
    end if;
    if reason is not null then
      -- No generated audio can be delivered on rejection.
      actual_used := 0;
      outcome_value := case when reason = 'expired' then 'expired' else 'limit' end;
      additional := 0;
    end if;

    -- Any current overage comes out of included time first. Old included holds
    -- never roll into a new subscription period.
    included_change := case when hold.allowance_version = member.allowance_version then
      greatest(0, hold.held_included - actual_used) else 0 end
      - least(additional, member.remaining_seconds);
    topup_change := greatest(0, hold.held_topup - greatest(0, actual_used - hold.held_included))
      - greatest(0, additional - member.remaining_seconds);
    update public.stillness_members set
      remaining_seconds = remaining_seconds + included_change,
      topup_seconds = topup_seconds + topup_change,
      voice_seconds_used = voice_seconds_used + actual_used
    where user_id = p_user_id returning * into member;
    update public.stillness_usage set used_seconds = actual_used, outcome = outcome_value
    where user_id = p_user_id and request_id = p_request_id;
    accepted := reason is null;
  end if;
  return jsonb_build_object('accepted', accepted, 'reason', reason,
    'remaining_seconds', member.remaining_seconds, 'topup_seconds', member.topup_seconds);
end;
$$;

revoke execute on function public.stillness_get_member(uuid, text),
  public.stillness_save_profile(uuid, text, text),
  public.stillness_list_members(integer, integer),
  public.stillness_set_stripe_customer(uuid, text),
  public.stillness_find_member_by_customer(text),
  public.stillness_claim_trial_card(uuid, text, text, text),
  public.stillness_apply_billing_event(text, bigint, uuid, text, text, text, timestamptz, timestamptz, text, text, text, boolean),
  public.stillness_reserve_usage(uuid, text, integer, text),
  public.stillness_settle_usage(uuid, text, integer)
from public, anon, authenticated;

grant execute on function public.stillness_get_member(uuid, text),
  public.stillness_save_profile(uuid, text, text),
  public.stillness_list_members(integer, integer),
  public.stillness_set_stripe_customer(uuid, text),
  public.stillness_find_member_by_customer(text),
  public.stillness_claim_trial_card(uuid, text, text, text),
  public.stillness_apply_billing_event(text, bigint, uuid, text, text, text, timestamptz, timestamptz, text, text, text, boolean),
  public.stillness_reserve_usage(uuid, text, integer, text),
  public.stillness_settle_usage(uuid, text, integer)
to service_role;

commit;
