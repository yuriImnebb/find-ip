alter table public.profiles
  add column if not exists bio text not null default '',
  add column if not exists profile_link text not null default '';
