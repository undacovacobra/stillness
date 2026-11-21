begin;

create schema stillness_private;
revoke all on schema stillness_private from public, anon, authenticated;
grant usage on schema stillness_private to service_role;

-- Retain the account claim if the user deletes their profile. Only hashed
-- enrollment identities reach this table, and they are never part of the API response.
create table stillness_private.free_trial_claims (
  user_id uuid primary key,
  device_hash text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  network_hash text not null check (network_hash ~ '^[a-f0-9]{64}$'),
  started_at timestamptz not null
);

create index stillness_free_trial_device_idx on stillness_private.free_trial_claims (device_hash, started_at desc);
create index stillness_free_trial_network_idx on stillness_private.free_trial_claims (network_hash, started_at desc);

alter table stillness_private.free_trial_claims enable row level security;
revoke all on stillness_private.free_trial_claims from public, anon, authenticated, service_role;
grant select, insert on stillness_private.free_trial_claims to service_role;

create function public.stillness_start_free_trial(p_user_id uuid, p_device_hash text, p_network_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  member public.stillness_members%rowtype;
  awarded_at timestamptz;
begin
  if p_device_hash is null or p_device_hash !~ '^[a-f0-9]{64}$'
    or p_network_hash is null or p_network_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('started', false, 'reason', 'ineligible');
  end if;

  select * into member from public.stillness_members where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('started', false, 'reason', 'ineligible');
  end if;
  if exists (select 1 from stillness_private.free_trial_claims where user_id = p_user_id) then
    if member.status = 'trialing' and member.subscription_id is null and member.period_ends_at > now() then
      return jsonb_build_object('started', true, 'reason', null);
    end if;
    return jsonb_build_object('started', false, 'reason', 'used');
  end if;
  if member.trial_used or member.period_starts_at is not null or member.period_ends_at is not null then
    return jsonb_build_object('started', false, 'reason', 'used');
  end if;
  if member.status <> 'inactive' or member.subscription_id is not null or exists (
    select 1 from public.stillness_trial_claims where user_id = p_user_id
  ) then
    return jsonb_build_object('started', false, 'reason', 'ineligible');
  end if;

  -- Serialize the rolling limit checks across different accounts. Lock device
  -- before network in distinct namespaces so same-key races do not deadlock.
  perform pg_advisory_xact_lock(196084001, hashtext(p_device_hash));
  perform pg_advisory_xact_lock(196084002, hashtext(p_network_hash));
  awarded_at := clock_timestamp();

  if exists (
    select 1 from stillness_private.free_trial_claims
    where device_hash = p_device_hash and started_at > awarded_at - interval '180 days'
  ) then
    return jsonb_build_object('started', false, 'reason', 'device_limit');
  end if;
  if (
    select count(*) from stillness_private.free_trial_claims
    where network_hash = p_network_hash and started_at > awarded_at - interval '30 days'
  ) >= 3 then
    return jsonb_build_object('started', false, 'reason', 'network_limit');
  end if;

  insert into stillness_private.free_trial_claims (user_id, device_hash, network_hash, started_at)
  values (p_user_id, p_device_hash, p_network_hash, awarded_at);
  update public.stillness_members set
    status = 'trialing', trial_used = true, remaining_seconds = 900,
    period_starts_at = awarded_at, period_ends_at = awarded_at + interval '10 days',
    allowance_version = allowance_version + 1
  where user_id = p_user_id;
  return jsonb_build_object('started', true, 'reason', null);
end;
$$;

revoke execute on function public.stillness_start_free_trial(uuid, text, text) from public, anon, authenticated;
grant execute on function public.stillness_start_free_trial(uuid, text, text) to service_role;

-- The first paid invoice must advance a cardless trial to its paid period.
-- A different Stripe subscription cannot replace a currently entitled Stripe subscription.
create or replace function public.stillness_apply_billing_event(
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
    elsif member.subscription_id is not null and member.subscription_id is distinct from p_subscription_id
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
        period_starts_at = case when new_period then p_period_starts_at else greatest(period_starts_at, p_period_starts_at) end,
        period_ends_at = case when new_period then p_period_ends_at else greatest(period_ends_at, p_period_ends_at) end,
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

commit;
