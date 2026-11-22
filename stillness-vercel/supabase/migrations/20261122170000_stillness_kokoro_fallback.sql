alter table public.stillness_usage
  drop constraint stillness_usage_kind_check,
  add constraint stillness_usage_kind_check check (kind in ('voice', 'preview', 'script', 'kokoro'));

create or replace function public.stillness_reserve_usage(p_user_id uuid, p_request_id text, p_seconds integer, p_kind text)
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
    or p_kind is null or p_kind not in ('voice', 'preview', 'script', 'kokoro')
    or p_seconds is null or p_seconds not between 0 and 7200 or (p_kind in ('script', 'kokoro')) <> (p_seconds = 0) then
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
  if member.status not in ('active','trialing') or member.period_ends_at is null or member.period_ends_at <= now()
    or (p_kind = 'kokoro' and member.status <> 'active') then
    reason := 'inactive';
  elsif exists (select 1 from public.stillness_usage where user_id = p_user_id and request_id = p_request_id) then
    reason := 'duplicate';
  elsif p_kind <> 'kokoro' and not (p_kind = 'script' and member.status = 'active')
    and member.remaining_seconds + member.topup_seconds < greatest(p_seconds, 1) then
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

create or replace function public.stillness_settle_usage(p_user_id uuid, p_request_id text, p_used_seconds integer)
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
    elsif hold.kind in ('script', 'kokoro') and p_used_seconds > 0 then
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
