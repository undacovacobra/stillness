begin;

alter table public.stillness_members
  add column marketing_email_opt_in boolean not null default false;

create table public.stillness_trial_email (
  user_id uuid not null references public.stillness_members(user_id) on delete cascade,
  kind text not null check (kind in ('welcome', 'started', 'reminder', 'ended', 'offer')),
  trial_ends_at timestamptz,
  due_at timestamptz not null,
  expires_at timestamptz not null,
  first_attempt_at timestamptz,
  claimed_at timestamptz,
  attempts integer not null default 0,
  delivery jsonb,
  outcome text check (outcome in ('sent', 'failed')),
  primary key (user_id, kind)
);
create index stillness_trial_email_due_idx
  on public.stillness_trial_email (due_at) where outcome is null;

alter table public.stillness_trial_email enable row level security;
revoke all on public.stillness_trial_email from public, anon, authenticated, service_role;
grant select, insert, update on public.stillness_trial_email to service_role;

create function public.stillness_queue_trial_email()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.email is not null and (tg_op = 'INSERT' or old.email is null) and not new.trial_used then
    insert into public.stillness_trial_email (user_id, kind, due_at, expires_at)
    values (new.user_id, 'welcome', now() + interval '15 minutes', now() + interval '3 days')
    on conflict do nothing;
  end if;
  if tg_op = 'UPDATE' and not old.trial_used and new.trial_used and new.status = 'trialing'
      and new.period_ends_at > now() and new.subscription_id is null then
    insert into public.stillness_trial_email (user_id, kind, trial_ends_at, due_at, expires_at)
    values
      (new.user_id, 'started', new.period_ends_at, now(), now() + interval '2 days'),
      (new.user_id, 'reminder', new.period_ends_at, new.period_ends_at - interval '2 days', new.period_ends_at),
      (new.user_id, 'ended', new.period_ends_at, new.period_ends_at, new.period_ends_at + interval '2 days'),
      (new.user_id, 'offer', new.period_ends_at, new.period_ends_at + interval '3 days', new.period_ends_at + interval '7 days')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger stillness_queue_trial_email
  after insert or update of email, trial_used on public.stillness_members
  for each row execute function public.stillness_queue_trial_email();

create function public.stillness_set_email_preference(p_user_id uuid, p_enabled boolean)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.stillness_members set marketing_email_opt_in = p_enabled where user_id = p_user_id;
  return found;
end;
$$;

create function public.stillness_claim_trial_email(p_user_id uuid, p_kinds text[], p_recipients text[])
returns jsonb language sql set search_path = '' as $$
  with candidate as (
    select q.user_id, q.kind, coalesce(q.delivery,
      jsonb_build_object('email', m.email, 'name', m.name, 'remaining_seconds', m.remaining_seconds)) as delivery
    from public.stillness_trial_email q
    join public.stillness_members m on m.user_id = q.user_id
    where q.outcome is null and q.due_at <= now() and q.expires_at > now()
      and (q.claimed_at is null or q.claimed_at < now() - interval '10 minutes')
      and (q.first_attempt_at is null or q.first_attempt_at > now() - interval '23 hours')
      and (p_user_id is null or q.user_id = p_user_id) and q.kind = any(p_kinds)
      and m.email is not null and (p_recipients is null or lower(m.email) = any(p_recipients))
      and (q.delivery is null or q.delivery->>'email' = m.email)
      and m.subscription_id is null
      and case q.kind
        when 'welcome' then m.status = 'inactive' and not m.trial_used
        when 'started' then m.status = 'trialing' and m.period_ends_at = q.trial_ends_at and m.period_ends_at > now()
        when 'reminder' then m.status = 'trialing' and m.period_ends_at = q.trial_ends_at and m.period_ends_at > now()
        when 'ended' then m.status = 'trialing' and m.period_ends_at = q.trial_ends_at and m.period_ends_at <= now()
        when 'offer' then m.status = 'trialing' and m.period_ends_at = q.trial_ends_at and m.period_ends_at <= now()
          and m.marketing_email_opt_in
      end
    order by q.due_at, q.user_id, q.kind
    limit 1 for update of q skip locked
  )
  update public.stillness_trial_email q
  set claimed_at = now(), first_attempt_at = coalesce(q.first_attempt_at, now()),
      delivery = c.delivery, attempts = q.attempts + 1
  from candidate c where (q.user_id, q.kind) = (c.user_id, c.kind)
  returning c.delivery || jsonb_build_object('user_id', q.user_id, 'kind', q.kind,
    'trial_ends_at', q.trial_ends_at, 'attempts', q.attempts);
$$;

create function public.stillness_finish_trial_email(p_user_id uuid, p_kind text, p_attempts integer, p_outcome text)
returns boolean language plpgsql set search_path = '' as $$
begin
  if p_outcome = 'retry' then
    update public.stillness_trial_email
    set claimed_at = null, first_attempt_at = null, delivery = null, due_at = now() + interval '1 hour'
    where user_id = p_user_id and kind = p_kind and attempts = p_attempts and outcome is null;
  elsif p_outcome in ('sent', 'failed') then
    update public.stillness_trial_email
    set outcome = p_outcome, delivery = null
    where user_id = p_user_id and kind = p_kind and attempts = p_attempts and outcome is null;
  else
    return false;
  end if;
  return found;
end;
$$;

revoke execute on function public.stillness_queue_trial_email(),
  public.stillness_set_email_preference(uuid, boolean),
  public.stillness_claim_trial_email(uuid, text[], text[]),
  public.stillness_finish_trial_email(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function public.stillness_queue_trial_email(),
  public.stillness_set_email_preference(uuid, boolean),
  public.stillness_claim_trial_email(uuid, text[], text[]),
  public.stillness_finish_trial_email(uuid, text, integer, text) to service_role;

commit;
