begin;

create table stillness_private.marketing_attribution (
  user_id uuid primary key references public.stillness_members(user_id) on delete cascade,
  source text not null check (source in ('youtube', 'instagram', 'stillness_sample')),
  attributed_at timestamptz not null default now(),
  first_session_at timestamptz,
  first_paid_at timestamptz
);

alter table stillness_private.marketing_attribution enable row level security;
revoke all on stillness_private.marketing_attribution from public, anon, authenticated, service_role;
grant select, insert, update on stillness_private.marketing_attribution to service_role;

create index stillness_marketing_attributed_at_idx on stillness_private.marketing_attribution(attributed_at);
create index stillness_marketing_session_at_idx on stillness_private.marketing_attribution(first_session_at) where first_session_at is not null;
create index stillness_marketing_paid_at_idx on stillness_private.marketing_attribution(first_paid_at) where first_paid_at is not null;
create index stillness_free_trial_started_at_idx on stillness_private.free_trial_claims(started_at);

create function public.stillness_marketing_touch(p_user_id uuid, p_stage text, p_source text default null)
returns void language plpgsql set search_path = '' as $$
begin
  if p_stage = 'attributed' and p_source in ('youtube', 'instagram', 'stillness_sample') then
    insert into stillness_private.marketing_attribution(user_id, source)
    select user_id, p_source from public.stillness_members
    where user_id = p_user_id and created_at > now() - interval '1 day' and subscription_id is null
    on conflict (user_id) do nothing;
  elsif p_stage = 'session' then
    update stillness_private.marketing_attribution set first_session_at = now()
    where user_id = p_user_id and first_session_at is null;
  elsif p_stage = 'paid' then
    update stillness_private.marketing_attribution set first_paid_at = now()
    where user_id = p_user_id and first_paid_at is null;
  end if;
end;
$$;

create function public.stillness_marketing_summary()
returns table(source text, attributed bigint, trial_starts bigint, first_sessions bigint, first_paid bigint)
language sql stable set search_path = '' as $$
  with recent_events as (
    select t.source, 'attributed' as kind from stillness_private.marketing_attribution t
      where t.attributed_at >= now() - interval '7 days'
    union all
    select t.source, 'trial' from stillness_private.free_trial_claims c
      join stillness_private.marketing_attribution t using (user_id)
      where c.started_at >= now() - interval '7 days' and c.started_at >= t.attributed_at
    union all
    select t.source, 'session' from stillness_private.marketing_attribution t
      where t.first_session_at >= now() - interval '7 days'
    union all
    select t.source, 'paid' from stillness_private.marketing_attribution t
      where t.first_paid_at >= now() - interval '7 days'
  )
  select recent_events.source,
    count(*) filter (where kind = 'attributed'), count(*) filter (where kind = 'trial'),
    count(*) filter (where kind = 'session'), count(*) filter (where kind = 'paid')
  from recent_events group by recent_events.source;
$$;

revoke execute on function public.stillness_marketing_touch(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.stillness_marketing_summary() from public, anon, authenticated;
grant execute on function public.stillness_marketing_touch(uuid, text, text) to service_role;
grant execute on function public.stillness_marketing_summary() to service_role;

commit;
