create or replace function public.admin_message_activity()
returns table (
  user_id uuid,
  message_count bigint,
  last_message_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.sender_id, count(*)::bigint, max(m.created_at)
  from public.messages m
  group by m.sender_id;
$$;

revoke all on function public.admin_message_activity() from public, anon, authenticated;
grant execute on function public.admin_message_activity() to service_role;
