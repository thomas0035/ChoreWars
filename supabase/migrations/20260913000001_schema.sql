-- ============================================================================
-- ChoreWars — schema
-- Tables, enums, indexes. No business logic here (see 0002_functions.sql).
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.house_role as enum ('member', 'admin');
create type public.activation_state as enum ('passive', 'active', 'volunteer_claimed');
create type public.completion_type as enum ('normal', 'volunteer');

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  avatar_url  text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Houses & membership
-- ---------------------------------------------------------------------------
create table public.houses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.house_members (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.house_role not null default 'member',
  joined_at   timestamptz not null default now(),
  unique (house_id, user_id)
);
create index house_members_user_idx on public.house_members (user_id);

-- Key/value settings per house. Known keys:
--   timezone                            (IANA, default 'UTC')
--   week_start_day                      (monday..sunday, default 'monday')
--   default_reactivation_cooldown_hours (default '4')
--   volunteering_enabled                ('true'|'false')
--   early_bonus_points                  (default '2')
--   streak_bonus_3 / streak_bonus_5 / streak_bonus_10
--   public_login_directory              ('true'|'false') — show member names on login screen
create table public.house_settings (
  house_id    uuid not null references public.houses (id) on delete cascade,
  key         text not null,
  value       text not null,
  primary key (house_id, key)
);

-- ---------------------------------------------------------------------------
-- Cleaning areas
-- ---------------------------------------------------------------------------
create table public.cleaning_areas (
  id                          uuid primary key default gen_random_uuid(),
  house_id                    uuid not null references public.houses (id) on delete cascade,
  name                        text not null check (char_length(name) between 1 and 40),
  icon                        text not null default '🧹',
  active                      boolean not null default true,
  normal_points               int not null default 10 check (normal_points between 0 and 1000),
  rescue_points               int not null default 12 check (rescue_points between 0 and 1000),
  -- Passive status thresholds (hours since last_cleaned_at):
  --   [0, minimum)            Fresh
  --   [minimum, expected)     Due Soon
  --   [expected, attention)   Ready to Check
  --   [attention, ∞)          Needs Attention
  minimum_interval_hours      int not null default 120 check (minimum_interval_hours >= 0),
  expected_interval_hours     int not null default 168 check (expected_interval_hours >= 0),
  attention_interval_hours    int not null default 288 check (attention_interval_hours >= 0),
  volunteer_grace_hours       int not null default 24 check (volunteer_grace_hours >= 0),
  reactivation_cooldown_hours int check (reactivation_cooldown_hours >= 0), -- null => house default
  sort_order                  int not null default 0,
  created_at                  timestamptz not null default now(),
  check (minimum_interval_hours <= expected_interval_hours),
  check (expected_interval_hours <= attention_interval_hours)
);
create index cleaning_areas_house_idx on public.cleaning_areas (house_id);

create table public.cleaning_rotation_members (
  id                uuid primary key default gen_random_uuid(),
  house_id          uuid not null references public.houses (id) on delete cascade,
  cleaning_area_id  uuid not null references public.cleaning_areas (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  position          int not null check (position >= 0),
  unique (cleaning_area_id, user_id),
  unique (cleaning_area_id, position) deferrable initially deferred
);

-- Explicit (stored) state only. The Fresh/Due Soon/Ready/Attention badge is
-- computed on read from last_cleaned_at + the area's thresholds — never stored.
create table public.cleaning_area_state (
  cleaning_area_id          uuid primary key references public.cleaning_areas (id) on delete cascade,
  house_id                  uuid not null references public.houses (id) on delete cascade,
  current_scheduled_user_id uuid references public.profiles (id) on delete set null,
  activation_state          public.activation_state not null default 'passive',
  last_cleaned_at           timestamptz,
  activated_at              timestamptz,
  activated_by_user_id      uuid references public.profiles (id) on delete set null,
  volunteer_user_id         uuid references public.profiles (id) on delete set null,
  volunteer_claimed_at      timestamptz,
  updated_at                timestamptz not null default now(),
  check (
    (activation_state = 'passive' and activated_at is null and volunteer_user_id is null)
    or (activation_state = 'active' and activated_at is not null and volunteer_user_id is null)
    or (activation_state = 'volunteer_claimed' and activated_at is not null and volunteer_user_id is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Completions, points, streaks, achievements
-- ---------------------------------------------------------------------------
create table public.cleaning_completions (
  id                    uuid primary key default gen_random_uuid(),
  house_id              uuid not null references public.houses (id) on delete cascade,
  cleaning_area_id      uuid not null references public.cleaning_areas (id) on delete cascade,
  scheduled_user_id     uuid references public.profiles (id) on delete set null,
  completed_by_user_id  uuid references public.profiles (id) on delete set null,
  completion_type       public.completion_type not null,
  points_awarded        int not null default 0,
  activated_at          timestamptz,
  completed_at          timestamptz not null default now()
);
create index cleaning_completions_house_time_idx on public.cleaning_completions (house_id, completed_at desc);
create index cleaning_completions_area_idx on public.cleaning_completions (cleaning_area_id, completed_at desc);
create index cleaning_completions_user_idx on public.cleaning_completions (completed_by_user_id);

-- Append-only audit trail; every displayed total is a SUM over this table.
create table public.user_points_ledger (
  id                      uuid primary key default gen_random_uuid(),
  house_id                uuid not null references public.houses (id) on delete cascade,
  user_id                 uuid not null references public.profiles (id) on delete cascade,
  cleaning_completion_id  uuid references public.cleaning_completions (id) on delete set null,
  points                  int not null,
  reason                  text not null, -- normal_completion | volunteer_rescue | early_bonus | streak_bonus
  created_at              timestamptz not null default now()
);
create index user_points_ledger_house_user_time_idx on public.user_points_ledger (house_id, user_id, created_at);

-- One row per user per house; global across all areas.
create table public.user_streaks (
  house_id        uuid not null references public.houses (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  current_streak  int not null default 0,
  longest_streak  int not null default 0,
  updated_at      timestamptz not null default now(),
  primary key (house_id, user_id)
);

create table public.achievements (
  id          text primary key,           -- slug
  name        text not null,
  description text not null,
  icon        text not null,
  sort_order  int not null default 0
);

create table public.user_achievements (
  house_id        uuid not null references public.houses (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  achievement_id  text not null references public.achievements (id) on delete cascade,
  earned_at       timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

create table public.weekly_champions (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses (id) on delete cascade,
  week_start  timestamptz not null,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  points      int not null,
  created_at  timestamptz not null default now(),
  unique (house_id, week_start)
);

-- Audit log for non-completion actions (activated, dismissed, volunteer claimed/released, admin edits).
create table public.area_events (
  id                uuid primary key default gen_random_uuid(),
  house_id          uuid not null references public.houses (id) on delete cascade,
  cleaning_area_id  uuid references public.cleaning_areas (id) on delete cascade,
  user_id           uuid references public.profiles (id) on delete set null,
  event_type        text not null,
  details           jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);
create index area_events_house_time_idx on public.area_events (house_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Reference data: V1 achievements
-- ---------------------------------------------------------------------------
insert into public.achievements (id, name, description, icon, sort_order) values
  ('first_clean',     'First Clean',     'Complete your first cleaning.',                     '🧹', 10),
  ('quick_cleaner',   'Quick Cleaner',   'Complete a task within 2 hours of it being flagged.', '⚡', 20),
  ('on_fire',         'On Fire',         'Reach a 5-task streak.',                            '🔥', 30),
  ('house_hero',      'House Hero',      'Rescue 3 tasks.',                                   '🦸', 40),
  ('reliable',        'Reliable',        'Complete 20 scheduled tasks.',                      '💪', 50),
  ('unstoppable',     'Unstoppable',     'Reach a 10-task streak.',                           '🚀', 60),
  ('weekly_champion', 'Weekly Champion', 'Finish #1 for a week.',                             '👑', 70),
  ('house_legend',    'House Legend',    'Complete 100 cleanings.',                           '🏠', 80);

-- ---------------------------------------------------------------------------
-- Auto-create a profile when an auth user is created
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), initcap(split_part(coalesce(new.email, 'member'), '@', 1)))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
