begin;

create table public.stillness_email_templates (
  kind text primary key check (kind in ('welcome','started','reminder','ended','ended-beta','offer')),
  subject text not null check (char_length(subject) between 1 and 150),
  body text not null check (char_length(body) between 1 and 8000),
  updated_by uuid not null,
  updated_at timestamptz not null default now()
);

alter table public.stillness_email_templates enable row level security;
revoke all on public.stillness_email_templates from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.stillness_email_templates to service_role;

create function public.stillness_save_email_template(p_kind text, p_subject text, p_body text, p_owner uuid)
returns boolean language plpgsql set search_path = '' as $$
begin
  if p_subject is null and p_body is null then
    delete from public.stillness_email_templates where kind = p_kind;
  else
    insert into public.stillness_email_templates (kind, subject, body, updated_by)
    values (p_kind, p_subject, p_body, p_owner)
    on conflict (kind) do update set subject = excluded.subject, body = excluded.body,
      updated_by = excluded.updated_by, updated_at = now();
  end if;
  return true;
end;
$$;

create function public.stillness_admin_email()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'templates', coalesce((select jsonb_agg(jsonb_build_object('kind', t.kind, 'subject', t.subject,
      'body', t.body, 'updated_at', t.updated_at) order by t.kind) from public.stillness_email_templates t), '[]'::jsonb),
    'activity', coalesce((select jsonb_agg(to_jsonb(a) order by a.attempted_at desc nulls last, a.due_at, a.kind) from (
      select m.email, q.kind, q.due_at, q.claimed_at as attempted_at,
        case
          when q.outcome = 'sent' then 'accepted'
          when q.outcome = 'failed' then 'failed'
          when q.claimed_at is not null and q.claimed_at < now() - interval '10 minutes' then 'unconfirmed'
          when q.claimed_at is not null then 'processing'
          when m.subscription_id is not null or (q.kind = 'welcome' and m.trial_used)
            or (q.kind = 'offer' and q.due_at <= now() and not m.marketing_email_opt_in) then 'skipped'
          when q.expires_at <= now() then 'expired'
          when q.due_at <= now() then 'queued'
          else 'scheduled'
        end as status
      from public.stillness_trial_email q
      join public.stillness_members m on m.user_id = q.user_id
      where m.email is not null
      order by q.claimed_at desc nulls last, q.due_at, q.kind
      limit 30
    ) a), '[]'::jsonb)
  );
$$;

create function public.stillness_admin_members(p_limit integer, p_offset integer, p_search text)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at desc, m.user_id), '[]'::jsonb)
  from (
    select user_id, email, name, status, period_ends_at, trial_used, remaining_seconds, topup_seconds,
      voice_seconds_used, last_used_at, cancel_at_period_end, created_at, marketing_email_opt_in,
      subscription_id is not null as has_subscription
    from public.stillness_members
    where coalesce(p_search, '') = '' or strpos(lower(coalesce(email, '')), lower(p_search)) > 0
      or strpos(lower(name), lower(p_search)) > 0
    order by created_at desc, user_id
    limit greatest(1, least(p_limit, 100))
    offset greatest(0, p_offset)
  ) m;
$$;

create function public.stillness_claim_trial_email(p_user_id uuid, p_kinds text[], p_recipients text[], p_mode text)
returns jsonb language sql set search_path = '' as $$
  with candidate as (
    select q.user_id, q.kind, coalesce(q.delivery, jsonb_build_object(
      'email', m.email, 'name', m.name, 'remaining_seconds', m.remaining_seconds,
      'template', case when t.kind is not null then jsonb_build_object('subject', t.subject, 'body', t.body) end
    )) as delivery
    from public.stillness_trial_email q
    join public.stillness_members m on m.user_id = q.user_id
    left join public.stillness_email_templates t
      on t.kind = case when q.kind = 'ended' and p_mode = 'beta' then 'ended-beta' else q.kind end
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

revoke execute on function public.stillness_save_email_template(text, text, text, uuid),
  public.stillness_admin_email(), public.stillness_admin_members(integer, integer, text),
  public.stillness_claim_trial_email(uuid, text[], text[], text) from public, anon, authenticated;
grant execute on function public.stillness_save_email_template(text, text, text, uuid),
  public.stillness_admin_email(), public.stillness_admin_members(integer, integer, text),
  public.stillness_claim_trial_email(uuid, text[], text[], text) to service_role;

commit;
