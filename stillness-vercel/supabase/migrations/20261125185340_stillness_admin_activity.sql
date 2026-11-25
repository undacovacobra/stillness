create table public.stillness_admin_activity (
  id bigint generated always as identity primary key,
  platform text not null check (char_length(platform) between 1 and 40),
  action text not null check (char_length(action) between 1 and 48),
  title text not null check (char_length(title) between 1 and 200),
  url text not null check (url ~ '^https://[^[:space:]]+$' and char_length(url) <= 2048),
  occurred_at timestamptz not null,
  time_known boolean not null default true,
  unique (platform, action, url)
);

alter table public.stillness_admin_activity enable row level security;
revoke all on table public.stillness_admin_activity from public, anon, authenticated;
grant select on table public.stillness_admin_activity to service_role;

create index stillness_admin_activity_chronological
  on public.stillness_admin_activity (occurred_at desc, id desc);

create function public.stillness_list_admin_activity(p_before_id bigint default null)
returns setof public.stillness_admin_activity
language sql stable security invoker set search_path = ''
as $$
  select entry.*
  from public.stillness_admin_activity as entry
  where p_before_id is null or
    (entry.occurred_at, entry.id) < (
      select cursor_entry.occurred_at, cursor_entry.id
      from public.stillness_admin_activity as cursor_entry
      where cursor_entry.id = p_before_id
    )
  order by entry.occurred_at desc, entry.id desc
  limit 51;
$$;

revoke all on function public.stillness_list_admin_activity(bigint) from public, anon, authenticated;
grant execute on function public.stillness_list_admin_activity(bigint) to service_role;
