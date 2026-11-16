alter table public.profiles
  add column if not exists discriminator integer;

create unique index if not exists profiles_discriminator_unique
  on public.profiles (discriminator)
  where discriminator is not null;

do $$
declare
  profile_record record;
  candidate integer;
  attempts integer;
begin
  for profile_record in
    select id from public.profiles where discriminator is null
  loop
    attempts := 0;
    loop
      candidate := 100000 + floor(random() * 900000)::integer;
      begin
        update public.profiles
        set discriminator = candidate
        where id = profile_record.id and discriminator is null;
        exit;
      exception when unique_violation then
        attempts := attempts + 1;
        if attempts >= 100 then
          select available.value into candidate
          from generate_series(100000, 999999) as available(value)
          where not exists (
            select 1 from public.profiles p where p.discriminator = available.value
          )
          limit 1;
          if candidate is null then
            raise exception 'No nickname discriminators are available';
          end if;
          update public.profiles set discriminator = candidate
          where id = profile_record.id and discriminator is null;
          exit;
        end if;
      end;
    end loop;
  end loop;
end;
$$;

alter table public.profiles
  alter column discriminator set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_discriminator_range'
  ) then
    alter table public.profiles
      add constraint profiles_discriminator_range
      check (discriminator between 100000 and 999999);
  end if;
end;
$$;

create or replace function public.assign_profile_discriminator()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  candidate integer;
  attempts integer := 0;
begin
  if tg_op = 'UPDATE' then
    if new.discriminator is distinct from old.discriminator then
      raise exception 'Nickname discriminator cannot be changed';
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(710042619);
  loop
    candidate := 100000 + floor(random() * 900000)::integer;
    if not exists (select 1 from public.profiles p where p.discriminator = candidate) then
      new.discriminator := candidate;
      return new;
    end if;
    attempts := attempts + 1;
    if attempts >= 100 then
      select available.value into candidate
      from generate_series(100000, 999999) as available(value)
      where not exists (
        select 1 from public.profiles p where p.discriminator = available.value
      )
      limit 1;
      if candidate is null then
        raise exception 'No nickname discriminators are available';
      end if;
      new.discriminator := candidate;
      return new;
    end if;
  end loop;
end;
$$;

drop trigger if exists profiles_assign_discriminator on public.profiles;
create trigger profiles_assign_discriminator
before insert on public.profiles
for each row execute function public.assign_profile_discriminator();

drop trigger if exists profiles_prevent_discriminator_change on public.profiles;
create trigger profiles_prevent_discriminator_change
before update of discriminator on public.profiles
for each row execute function public.assign_profile_discriminator();

create or replace function public.request_friend_by_nickname(
  p_owner_id uuid,
  p_nickname text,
  p_discriminator integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_id uuid;
  existing_status text;
begin
  if p_owner_id is null
    or p_nickname is null
    or length(trim(p_nickname)) not between 1 and 60
    or p_discriminator is null
    or p_discriminator not between 100000 and 999999 then
    raise exception 'Enter a nickname in the format nickname#123456';
  end if;

  select p.id into recipient_id
  from public.profiles p
  where lower(trim(p.display_name)) = lower(trim(p_nickname))
    and p.discriminator = p_discriminator;

  if recipient_id is null then
    return 'not_found';
  end if;
  if recipient_id = p_owner_id then
    return 'self';
  end if;
  if exists (
    select 1 from public.friend_requests r
    where r.status = 'accepted'
      and ((r.sender_id = p_owner_id and r.recipient_id = recipient_id)
        or (r.sender_id = recipient_id and r.recipient_id = p_owner_id))
  ) then
    return 'already_friends';
  end if;
  if exists (
    select 1 from public.friend_requests r
    where r.sender_id = recipient_id
      and r.recipient_id = p_owner_id
      and r.status = 'pending'
  ) then
    return 'incoming_pending';
  end if;

  select r.status into existing_status
  from public.friend_requests r
  where r.sender_id = p_owner_id and r.recipient_id = recipient_id;

  if existing_status = 'pending' then
    return 'already_requested';
  end if;

  insert into public.friend_requests (sender_id, recipient_id, status)
  values (p_owner_id, recipient_id, 'pending')
  on conflict (sender_id, recipient_id) do update
    set status = 'pending', updated_at = now()
    where public.friend_requests.status = 'declined';

  return 'requested';
end;
$$;

revoke all on function public.request_friend_by_nickname(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.request_friend_by_nickname(uuid, text, integer) to service_role;
