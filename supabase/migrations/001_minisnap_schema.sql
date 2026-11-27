-- MiniSnap v2 complete schema, RLS policies, atomic RPCs, and storage setup.
-- Run in Supabase SQL Editor or via `supabase db push`.

create extension if not exists pgcrypto;

-- 1. Private Storage bucket for strips and individual frames
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photo-strips', 'photo-strips', false, 5242880, array['image/jpeg'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg'];

-- 2. Events configuration table (branding, retention TTL, access policy, privacy waiver)
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null default 'MINISNAP PHOTOBOOTH',
  subtitle text not null default 'BGKV · STUDIO',
  footer_text text not null default 'A SCHOOL MEMORY · KOLKATA',
  retention_hours integer not null default 24 check (retention_hours between 1 and 8760),
  auto_upload boolean not null default true,
  open_guest_access boolean not null default true,
  waiver_version text not null default 'v1.0-all-inclusive',
  waiver_text text not null default 'By opting in, you grant BGKV and the event organizers a non-exclusive, royalty-free, worldwide license to include your captured photo strip and individual frames in an official commemorative event collage (digital or print). Your private QR delivery link remains strictly private and unshared with other guests. Unarchived sessions automatically expire and delete from storage after the configured retention window. You may request immediate deletion at any time using your session code.',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.events (slug, title, subtitle, footer_text, retention_hours, auto_upload, open_guest_access, is_active)
values ('bgkv-studio', 'MINISNAP PHOTOBOOTH', 'BGKV · STUDIO', 'A SCHOOL MEMORY · KOLKATA', 24, true, true, true)
on conflict (slug) do nothing;

-- 3. Photo sessions table (safe additive evolution for existing projects)
create table if not exists public.photo_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text unique not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_accessed_at timestamptz,
  guest_access_count integer not null default 0
);

alter table public.photo_sessions add column if not exists short_code text;
alter table public.photo_sessions add column if not exists event_id uuid references public.events(id) on delete set null;
alter table public.photo_sessions add column if not exists frame_paths jsonb not null default '[]'::jsonb;
alter table public.photo_sessions add column if not exists filter_id text not null default 'none';
alter table public.photo_sessions add column if not exists strip_theme text not null default 'pink';
alter table public.photo_sessions add column if not exists layout_type text not null default 'strip-4';
alter table public.photo_sessions add column if not exists caption text;
alter table public.photo_sessions add column if not exists total_bytes integer not null default 0;
alter table public.photo_sessions add column if not exists upload_status text not null default 'ready';
alter table public.photo_sessions add column if not exists collage_consent boolean not null default false;
alter table public.photo_sessions add column if not exists collage_consent_at timestamptz;
alter table public.photo_sessions add column if not exists waiver_version text;
alter table public.photo_sessions add column if not exists is_archived boolean not null default false;

update public.photo_sessions
set short_code = 'MS-' || upper(substr(replace(id::text, '-', ''), 1, 4))
where short_code is null;

create unique index if not exists photo_sessions_short_code_idx on public.photo_sessions(short_code);
create unique index if not exists photo_sessions_token_hash_idx on public.photo_sessions(token_hash);
create index if not exists photo_sessions_expires_idx on public.photo_sessions(expires_at) where is_archived = false;
create index if not exists photo_sessions_created_idx on public.photo_sessions(created_at desc);
create index if not exists photo_sessions_collage_idx on public.photo_sessions(event_id, collage_consent) where collage_consent = true;

-- 4. Generalized IP rate-limiting table & RPC (booth PIN, admin auth, open guest upload)
create table if not exists public.minisnap_booth_pin_attempts (
  ip_hash text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0
);

create table if not exists public.minisnap_rate_limits (
  bucket text not null,
  ip_hash text not null,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0,
  primary key (bucket, ip_hash)
);

-- 5. Strict Row Level Security: zero direct anon/authenticated access
alter table public.events enable row level security;
alter table public.photo_sessions enable row level security;
alter table public.minisnap_booth_pin_attempts enable row level security;
alter table public.minisnap_rate_limits enable row level security;

create or replace function public.minisnap_check_booth_attempt(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_attempts integer;
begin
  insert into public.minisnap_booth_pin_attempts (ip_hash, window_started_at, attempts)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update
  set window_started_at = case
        when public.minisnap_booth_pin_attempts.window_started_at < now() - interval '15 minutes' then now()
        else public.minisnap_booth_pin_attempts.window_started_at
      end,
      attempts = case
        when public.minisnap_booth_pin_attempts.window_started_at < now() - interval '15 minutes' then 1
        else public.minisnap_booth_pin_attempts.attempts + 1
      end
  returning attempts into current_attempts;

  return current_attempts <= 5;
end;
$$;

create or replace function public.minisnap_check_rate_limit(
  p_bucket text,
  p_ip_hash text,
  p_max_attempts integer default 10,
  p_window_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_attempts integer;
  win interval := make_interval(secs => p_window_seconds);
begin
  insert into public.minisnap_rate_limits (bucket, ip_hash, window_started_at, attempts)
  values (p_bucket, p_ip_hash, now(), 1)
  on conflict (bucket, ip_hash) do update
  set window_started_at = case
        when public.minisnap_rate_limits.window_started_at < now() - win then now()
        else public.minisnap_rate_limits.window_started_at
      end,
      attempts = case
        when public.minisnap_rate_limits.window_started_at < now() - win then 1
        else public.minisnap_rate_limits.attempts + 1
      end
  returning attempts into current_attempts;

  return current_attempts <= p_max_attempts;
end;
$$;

create or replace function public.minisnap_record_guest_access(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.photo_sessions
  set last_accessed_at = now(),
      guest_access_count = coalesce(guest_access_count, 0) + 1
  where id = p_session_id;
end;
$$;

revoke all on function public.minisnap_check_booth_attempt(text) from public, anon, authenticated;
grant execute on function public.minisnap_check_booth_attempt(text) to service_role;

revoke all on function public.minisnap_check_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.minisnap_check_rate_limit(text, text, integer, integer) to service_role;

revoke all on function public.minisnap_record_guest_access(uuid) from public, anon, authenticated;
grant execute on function public.minisnap_record_guest_access(uuid) to service_role;
