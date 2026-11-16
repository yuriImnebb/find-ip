create table if not exists public.user_ip_addresses (
  user_id uuid not null references auth.users (id) on delete cascade,
  ip_address inet not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, ip_address)
);

create index if not exists user_ip_addresses_ip_idx
  on public.user_ip_addresses (ip_address, last_seen_at desc);
create index if not exists user_ip_addresses_user_last_seen_idx
  on public.user_ip_addresses (user_id, last_seen_at desc);

create table if not exists public.ip_bans (
  id uuid primary key default gen_random_uuid(),
  ip_address inet not null unique,
  reason text not null,
  banned_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.ip_consents (
  user_id uuid primary key references auth.users (id) on delete cascade,
  policy_version text not null,
  accepted_at timestamptz not null default now()
);

alter table public.user_ip_addresses enable row level security;
alter table public.ip_bans enable row level security;
alter table public.ip_consents enable row level security;

revoke all on public.profiles, public.user_contacts, public.friend_requests,
  public.conversations, public.conversation_members, public.messages,
  public.user_ip_addresses, public.ip_bans, public.ip_consents
  from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on storage.objects from public, anon, authenticated;
grant all on public.profiles, public.user_contacts, public.friend_requests,
  public.conversations, public.conversation_members, public.messages,
  public.user_ip_addresses, public.ip_bans, public.ip_consents
  to service_role;
grant all on all sequences in schema public to service_role;
grant all on storage.objects to service_role;

revoke execute on function public.save_contact_and_request(text, text) from public, anon, authenticated;
revoke execute on function public.respond_to_friend_request(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.start_direct_conversation(uuid) from public, anon, authenticated;
revoke execute on function public.create_group_conversation(text, uuid[]) from public, anon, authenticated;

create or replace function public.save_contact_and_request_for_user(
  p_owner_id uuid,
  p_name text,
  p_email text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := left(trim(coalesce(p_name, '')), 100);
  v_recipient uuid;
begin
  if p_owner_id is null or v_email = '' or length(v_email) > 320
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'A valid owner and email are required';
  end if;

  insert into public.user_contacts (owner_id, display_name, email)
  values (p_owner_id, v_name, v_email)
  on conflict (owner_id, email) do update
    set display_name = excluded.display_name;

  select u.id into v_recipient
  from auth.users as u
  where lower(u.email) = v_email and u.email_confirmed_at is not null
  limit 1;

  if v_recipient is null then return 'saved'; end if;
  if v_recipient = p_owner_id then return 'self'; end if;

  if exists (
    select 1 from public.friend_requests r
    where r.status = 'accepted'
      and ((r.sender_id = p_owner_id and r.recipient_id = v_recipient)
        or (r.sender_id = v_recipient and r.recipient_id = p_owner_id))
  ) then
    return 'already_friends';
  end if;

  insert into public.friend_requests (sender_id, recipient_id)
  values (p_owner_id, v_recipient)
  on conflict (sender_id, recipient_id) do update
    set status = 'pending', updated_at = now()
    where public.friend_requests.status = 'declined';

  return 'requested';
end;
$$;

revoke all on function public.save_contact_and_request_for_user(uuid, text, text) from public, anon, authenticated;
grant execute on function public.save_contact_and_request_for_user(uuid, text, text) to service_role;
