create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null default '',
  email text not null,
  created_at timestamptz not null default now(),
  unique (owner_id, email)
);

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (sender_id <> recipient_id),
  unique (sender_id, recipient_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct', 'group')),
  title text,
  direct_key text unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((type = 'direct' and direct_key is not null and title is null)
      or (type = 'group' and direct_key is null and title is not null))
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null default '',
  attachment_path text,
  created_at timestamptz not null default now(),
  check (char_length(body) <= 4000),
  check (body <> '' or attachment_path is not null)
);

create index if not exists conversation_members_user_idx
  on public.conversation_members (user_id, conversation_id);
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);
create index if not exists friend_requests_recipient_status_idx
  on public.friend_requests (recipient_id, status, created_at desc);
create index if not exists user_contacts_owner_idx
  on public.user_contacts (owner_id, created_at desc);

create or replace function public.is_conversation_member(p_conversation_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id = auth.uid() and exists (
    select 1
    from public.conversation_members m
    where m.conversation_id = p_conversation_id
      and m.user_id = p_user_id
  );
$$;

create or replace function public.is_current_user_conversation_member(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members m
    where m.conversation_id = p_conversation_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

drop trigger if exists friend_requests_set_updated_at on public.friend_requests;
create trigger friend_requests_set_updated_at
before update on public.friend_requests
for each row execute function public.set_updated_at();

create or replace function public.touch_conversation_on_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
  set updated_at = new.created_at
  where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation
after insert on public.messages
for each row execute function public.touch_conversation_on_message();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

insert into public.profiles (id, display_name)
select id, coalesce(nullif(trim(raw_user_meta_data ->> 'name'), ''), split_part(coalesce(email, ''), '@', 1))
from auth.users
on conflict (id) do nothing;

create or replace function public.save_contact_and_request(p_name text, p_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := left(trim(coalesce(p_name, '')), 100);
  v_recipient uuid;
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;
  if v_email = '' or length(v_email) > 320 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address';
  end if;

  insert into public.user_contacts (owner_id, display_name, email)
  values (v_owner, v_name, v_email)
  on conflict (owner_id, email) do update
    set display_name = excluded.display_name;

  select u.id into v_recipient
  from auth.users as u
  where lower(u.email) = v_email
    and u.email_confirmed_at is not null
  limit 1;

  if v_recipient is null then
    return 'saved';
  end if;
  if v_recipient = v_owner then
    return 'self';
  end if;

  if exists (
    select 1 from public.friend_requests as r
    where r.status = 'accepted'
      and ((r.sender_id = v_owner and r.recipient_id = v_recipient)
        or (r.sender_id = v_recipient and r.recipient_id = v_owner))
  ) then
    return 'already_friends';
  end if;

  insert into public.friend_requests (sender_id, recipient_id)
  values (v_owner, v_recipient)
  on conflict (sender_id, recipient_id) do update
    set status = 'pending', updated_at = now()
    where public.friend_requests.status = 'declined';

  return 'requested';
end;
$$;

create or replace function public.respond_to_friend_request(p_request_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender uuid;
  v_recipient uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  update public.friend_requests
  set status = case when p_accept then 'accepted' else 'declined' end
  where id = p_request_id
    and recipient_id = auth.uid()
    and status = 'pending'
  returning sender_id, recipient_id into v_sender, v_recipient;
  if not found then
    raise exception 'Friend request not found';
  end if;
  if p_accept then
    update public.friend_requests
    set status = 'accepted'
    where sender_id = v_recipient
      and recipient_id = v_sender
      and status = 'pending';
  end if;
end;
$$;

create or replace function public.start_direct_conversation(p_other_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_conversation uuid;
  v_key text;
begin
  if v_user is null or p_other_user is null or p_other_user = v_user then
    raise exception 'Invalid conversation members';
  end if;
  if not exists (
    select 1 from public.friend_requests r
    where r.status = 'accepted'
      and ((r.sender_id = v_user and r.recipient_id = p_other_user)
        or (r.sender_id = p_other_user and r.recipient_id = v_user))
  ) then
    raise exception 'You can only message accepted friends';
  end if;

  v_key := least(v_user::text, p_other_user::text) || ':' || greatest(v_user::text, p_other_user::text);
  insert into public.conversations (type, direct_key, created_by)
  values ('direct', v_key, v_user)
  on conflict (direct_key) do update set direct_key = excluded.direct_key
  returning id into v_conversation;

  insert into public.conversation_members (conversation_id, user_id)
  values (v_conversation, v_user), (v_conversation, p_other_user)
  on conflict do nothing;
  return v_conversation;
end;
$$;

create or replace function public.create_group_conversation(p_title text, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_title text := left(trim(coalesce(p_title, '')), 80);
  v_conversation uuid;
  v_member uuid;
begin
  if v_user is null then
    raise exception 'Authentication required';
  end if;
  if v_title = '' then
    raise exception 'Group name is required';
  end if;
  if coalesce(cardinality(p_member_ids), 0) > 99 then
    raise exception 'A group can contain at most 100 members';
  end if;
  foreach v_member in array coalesce(p_member_ids, array[]::uuid[]) loop
    if v_member <> v_user and not exists (
      select 1 from public.friend_requests r
      where r.status = 'accepted'
        and ((r.sender_id = v_user and r.recipient_id = v_member)
          or (r.sender_id = v_member and r.recipient_id = v_user))
    ) then
      raise exception 'Groups can only include accepted friends';
    end if;
  end loop;

  insert into public.conversations (type, title, created_by)
  values ('group', v_title, v_user)
  returning id into v_conversation;

  insert into public.conversation_members (conversation_id, user_id)
  values (v_conversation, v_user)
  on conflict do nothing;
  insert into public.conversation_members (conversation_id, user_id)
  select v_conversation, distinct_members.user_id
  from (select distinct unnest(coalesce(p_member_ids, array[]::uuid[])) as user_id) as distinct_members
  where distinct_members.user_id <> v_user
  on conflict do nothing;
  return v_conversation;
end;
$$;

alter table public.profiles enable row level security;
alter table public.user_contacts enable row level security;
alter table public.friend_requests enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Authenticated users can view profiles" on public.profiles;
drop policy if exists "Users can view connected profiles" on public.profiles;
create policy "Users can view connected profiles"
on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or exists (
    select 1
    from public.friend_requests r
    where r.status = 'accepted'
      and (
        (r.sender_id = (select auth.uid()) and r.recipient_id = id)
        or (r.recipient_id = (select auth.uid()) and r.sender_id = id)
      )
  )
  or exists (
    select 1
    from public.friend_requests r
    where r.status = 'pending'
      and (
        (r.sender_id = (select auth.uid()) and r.recipient_id = id)
        or (r.recipient_id = (select auth.uid()) and r.sender_id = id)
      )
  )
);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "Users can view own contacts" on public.user_contacts;
create policy "Users can view own contacts"
on public.user_contacts for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists "Users can delete own contacts" on public.user_contacts;
create policy "Users can delete own contacts"
on public.user_contacts for delete to authenticated using (owner_id = (select auth.uid()));

drop policy if exists "Users can view their friend requests" on public.friend_requests;
create policy "Users can view their friend requests"
on public.friend_requests for select to authenticated
using (sender_id = (select auth.uid()) or recipient_id = (select auth.uid()));

drop policy if exists "Members can view conversations" on public.conversations;
create policy "Members can view conversations"
on public.conversations for select to authenticated
using (public.is_conversation_member(id, (select auth.uid())));
drop policy if exists "Members can view conversation members" on public.conversation_members;
create policy "Members can view conversation members"
on public.conversation_members for select to authenticated
using (public.is_current_user_conversation_member(conversation_id));
drop policy if exists "Members can view messages" on public.messages;
create policy "Members can view messages"
on public.messages for select to authenticated
using (public.is_conversation_member(conversation_id, (select auth.uid())));
drop policy if exists "Members can send messages" on public.messages;
create policy "Members can send messages"
on public.messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.is_conversation_member(conversation_id, (select auth.uid()))
);
drop policy if exists "Senders can delete own messages" on public.messages;
create policy "Senders can delete own messages"
on public.messages for delete to authenticated
using (sender_id = (select auth.uid()));

grant select, update on public.profiles to authenticated;
grant select, delete on public.user_contacts to authenticated;
grant select on public.friend_requests to authenticated;
grant select on public.conversations, public.conversation_members, public.messages to authenticated;
grant insert, delete on public.messages to authenticated;
grant execute on function public.save_contact_and_request(text, text) to authenticated;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.start_direct_conversation(uuid) to authenticated;
grant execute on function public.create_group_conversation(text, uuid[]) to authenticated;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.is_current_user_conversation_member(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  ('message-photos', 'message-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can upload own avatar" on storage.objects;
create policy "Users can upload own avatar"
on storage.objects for insert to authenticated
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Users can update own avatar" on storage.objects;
create policy "Users can update own avatar"
on storage.objects for update to authenticated
using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Authenticated users can read avatars" on storage.objects;
create policy "Connected users can read avatars"
on storage.objects for select to authenticated using (
  bucket_id = 'avatars'
  and exists (
    select 1 from public.profiles p
    where p.avatar_path = name
  )
);
drop policy if exists "Users can upload own message photos" on storage.objects;
create policy "Users can upload own message photos"
on storage.objects for insert to authenticated
with check (bucket_id = 'message-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "Members can read conversation photos" on storage.objects;
create policy "Members can read conversation photos"
on storage.objects for select to authenticated
using (
  bucket_id = 'message-photos'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or exists (
      select 1 from public.messages msg
      join public.conversation_members member on member.conversation_id = msg.conversation_id
      where msg.attachment_path = name and member.user_id = (select auth.uid())
    )
  )
);
drop policy if exists "Users can delete own photos" on storage.objects;
create policy "Users can delete own photos"
on storage.objects for delete to authenticated
using ((bucket_id in ('avatars', 'message-photos')) and (storage.foldername(name))[1] = (select auth.uid())::text);

do $$
declare
  table_name text;
begin
  foreach table_name in array array['messages', 'friend_requests'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;
