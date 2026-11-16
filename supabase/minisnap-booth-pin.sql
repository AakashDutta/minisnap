-- MiniSnap booth PIN protection. Run once in Supabase SQL Editor.
create table if not exists public.minisnap_booth_pin_attempts (
  ip_hash text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0
);

alter table public.minisnap_booth_pin_attempts enable row level security;

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

revoke all on function public.minisnap_check_booth_attempt(text) from public, anon, authenticated;
grant execute on function public.minisnap_check_booth_attempt(text) to service_role;
