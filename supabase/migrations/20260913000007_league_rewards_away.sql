-- ============================================================================
-- League stakes, penalties and away members.
--
-- 1. Rescue penalty: when a volunteer completes your area you lose
--    `rescue_penalty_points` (house setting, default 5) as a negative ledger row.
-- 2. Month end (idempotent, lazily evaluated like weekly champions):
--      champion  -> Skip Pass + 'monthly_champion' achievement
--      lowest    -> forfeit (house setting `monthly_forfeit`), tracked until marked done
-- 3. Away members: admins mark a member away; rotations skip them, they take
--    no penalty and are excluded from the forfeit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.house_members add column if not exists away boolean not null default false;

create table public.monthly_results (
  id                uuid primary key default gen_random_uuid(),
  house_id          uuid not null references public.houses (id) on delete cascade,
  month_start       timestamptz not null,
  champion_user_id  uuid references public.profiles (id) on delete set null,
  champion_points   int not null default 0,
  loser_user_id     uuid references public.profiles (id) on delete set null,
  loser_points      int,
  forfeit           text,
  forfeit_done_at   timestamptz,
  forfeit_done_by   uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (house_id, month_start)
);

create table public.skip_passes (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null references public.houses (id) on delete cascade,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  month_start   timestamptz not null,           -- the month that was won
  granted_at    timestamptz not null default now(),
  used_at       timestamptz,
  used_area_id  uuid references public.cleaning_areas (id) on delete set null,
  unique (house_id, user_id, month_start)
);
create index skip_passes_unused_idx on public.skip_passes (house_id, user_id) where used_at is null;

alter table public.monthly_results enable row level security;
alter table public.skip_passes     enable row level security;
create policy "monthly_results: read" on public.monthly_results for select to authenticated using (public.is_house_member(house_id));
create policy "skip_passes: read"     on public.skip_passes     for select to authenticated using (public.is_house_member(house_id));
alter table public.monthly_results replica identity full;
alter table public.skip_passes replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.monthly_results, public.skip_passes;
  end if;
end $$;

insert into public.achievements (id, name, description, icon, sort_order)
values ('monthly_champion', 'Monthly Champion', 'Finish #1 for a month.', '🥇', 75)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Rotation helper: skip away members.
-- ---------------------------------------------------------------------------
create or replace function public.next_rotation_user(p_area uuid, p_current uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_pos int; v_next uuid;
begin
  select position into v_pos from cleaning_rotation_members where cleaning_area_id = p_area and user_id = p_current;

  -- First non-away member after the current position, wrapping around.
  select rm.user_id into v_next
    from cleaning_rotation_members rm
    join house_members hm on hm.house_id = rm.house_id and hm.user_id = rm.user_id
   where rm.cleaning_area_id = p_area
     and not hm.away
     and rm.user_id is distinct from p_current
   order by (case when v_pos is not null and rm.position > v_pos then 0 else 1 end), rm.position
   limit 1;
  if v_next is not null then return v_next; end if;

  -- Nobody else is available. Stay with the current person if they are in the rotation.
  if v_pos is not null then return p_current; end if;
  select user_id into v_next from cleaning_rotation_members where cleaning_area_id = p_area order by position limit 1;
  return v_next;
end;
$$;

create or replace function public.is_away(p_house uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select away from house_members where house_id = p_house and user_id = p_user), false);
$$;

-- ---------------------------------------------------------------------------
-- mark_needs_cleaning: never schedule an away member.
-- ---------------------------------------------------------------------------
create or replace function public.mark_needs_cleaning(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
  v_cooldown int;
  v_ready_at timestamptz;
  v_scheduled uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_area from cleaning_areas where id = p_area_id and active;
  if not found then raise exception 'area_not_found'; end if;
  if not is_house_member(v_area.house_id) then raise exception 'not_a_member'; end if;

  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  if not found then raise exception 'area_not_found'; end if;
  if v_state.activation_state <> 'passive' then raise exception 'already_active'; end if;

  v_cooldown := coalesce(v_area.reactivation_cooldown_hours,
                         house_setting_int(v_area.house_id, 'default_reactivation_cooldown_hours', 4));
  if v_state.last_cleaned_at is not null then
    v_ready_at := v_state.last_cleaned_at + make_interval(hours => v_cooldown);
    if now() < v_ready_at then
      raise exception 'cooldown' using detail = v_ready_at::text;
    end if;
  end if;

  v_scheduled := v_state.current_scheduled_user_id;
  if v_scheduled is null or not exists (
       select 1 from cleaning_rotation_members where cleaning_area_id = p_area_id and user_id = v_scheduled) then
    select user_id into v_scheduled from cleaning_rotation_members where cleaning_area_id = p_area_id order by position limit 1;
  end if;
  if v_scheduled is null then raise exception 'no_rotation'; end if;
  if is_away(v_area.house_id, v_scheduled) then
    v_scheduled := next_rotation_user(p_area_id, v_scheduled);
  end if;

  update cleaning_area_state
     set activation_state = 'active', activated_at = now(), activated_by_user_id = v_uid,
         current_scheduled_user_id = v_scheduled, updated_at = now()
   where cleaning_area_id = p_area_id;

  perform log_area_event(v_area.house_id, p_area_id, 'activated', jsonb_build_object('scheduled_user_id', v_scheduled));

  return jsonb_build_object(
    'area_id', p_area_id, 'area_name', v_area.name, 'area_icon', v_area.icon,
    'scheduled_user_id', v_scheduled,
    'scheduled_user_name', (select name from profiles where id = v_scheduled)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_cleaning: + rescue penalty for the scheduled person.
-- ---------------------------------------------------------------------------
create or replace function public.complete_cleaning(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
  v_type completion_type;
  v_base int; v_early int := 0; v_streak_bonus int := 0; v_total int;
  v_penalty int := 0;
  v_streak int := 0;
  v_completion_id uuid;
  v_next uuid;
  v_new_achievements jsonb;
  v_cleared_volunteer uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_area from cleaning_areas where id = p_area_id and active;
  if not found then raise exception 'area_not_found'; end if;
  if not is_house_member(v_area.house_id) then raise exception 'not_a_member'; end if;

  -- Row lock: a concurrent completion of the same area waits here, then fails the 'not_active' check.
  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  if not found then raise exception 'area_not_found'; end if;
  if v_state.activation_state = 'passive' then raise exception 'not_active'; end if;

  if v_uid = v_state.current_scheduled_user_id then
    v_type := 'normal';
    v_cleared_volunteer := v_state.volunteer_user_id; -- scheduled person finishing after a claim: claim is simply cleared
  elsif v_state.activation_state = 'volunteer_claimed' and v_uid = v_state.volunteer_user_id then
    v_type := 'volunteer';
  else
    raise exception 'not_authorized';
  end if;

  -- Points (never from the client).
  v_base := case v_type when 'normal' then v_area.normal_points else v_area.rescue_points end;
  if v_state.last_cleaned_at is not null
     and v_now < v_state.last_cleaned_at + make_interval(hours => v_area.expected_interval_hours) then
    v_early := house_setting_int(v_area.house_id, 'early_bonus_points', 2);
  end if;

  -- Streaks: global per user. Normal completion extends the cleaner's streak;
  -- a rescue resets the scheduled person's streak.
  if v_type = 'normal' then
    insert into user_streaks (house_id, user_id, current_streak, longest_streak)
    values (v_area.house_id, v_uid, 1, 1)
    on conflict (house_id, user_id) do update
      set current_streak = user_streaks.current_streak + 1,
          longest_streak = greatest(user_streaks.longest_streak, user_streaks.current_streak + 1),
          updated_at = now()
    returning current_streak into v_streak;

    v_streak_bonus := case v_streak
      when 3  then house_setting_int(v_area.house_id, 'streak_bonus_3', 3)
      when 5  then house_setting_int(v_area.house_id, 'streak_bonus_5', 5)
      when 10 then house_setting_int(v_area.house_id, 'streak_bonus_10', 10)
      else 0 end;
  else
    if v_state.current_scheduled_user_id is not null then
      insert into user_streaks (house_id, user_id, current_streak, longest_streak)
      values (v_area.house_id, v_state.current_scheduled_user_id, 0, 0)
      on conflict (house_id, user_id) do update set current_streak = 0, updated_at = now();
    end if;
    select coalesce(max(current_streak), 0) into v_streak from user_streaks where house_id = v_area.house_id and user_id = v_uid;
  end if;

  v_total := v_base + v_early + v_streak_bonus;

  insert into cleaning_completions (house_id, cleaning_area_id, scheduled_user_id, completed_by_user_id,
                                    completion_type, points_awarded, activated_at, completed_at)
  values (v_area.house_id, p_area_id, v_state.current_scheduled_user_id, v_uid, v_type, v_total, v_state.activated_at, v_now)
  returning id into v_completion_id;

  insert into user_points_ledger (house_id, user_id, cleaning_completion_id, points, reason)
  values (v_area.house_id, v_uid, v_completion_id, v_base,
          case v_type when 'normal' then 'normal_completion' else 'volunteer_rescue' end);
  if v_early > 0 then
    insert into user_points_ledger (house_id, user_id, cleaning_completion_id, points, reason)
    values (v_area.house_id, v_uid, v_completion_id, v_early, 'early_bonus');
  end if;
  if v_streak_bonus > 0 then
    insert into user_points_ledger (house_id, user_id, cleaning_completion_id, points, reason)
    values (v_area.house_id, v_uid, v_completion_id, v_streak_bonus, 'streak_bonus');
  end if;

  -- Rescue penalty for the person who should have done it (not if they are away).
  if v_type = 'volunteer' and v_state.current_scheduled_user_id is not null
     and not is_away(v_area.house_id, v_state.current_scheduled_user_id) then
    v_penalty := house_setting_int(v_area.house_id, 'rescue_penalty_points', 5);
    if v_penalty > 0 then
      insert into user_points_ledger (house_id, user_id, cleaning_completion_id, points, reason)
      values (v_area.house_id, v_state.current_scheduled_user_id, v_completion_id, -v_penalty, 'rescued_penalty');
    else
      v_penalty := 0;
    end if;
  end if;

  -- Advance only this area's rotation; reset to passive.
  v_next := next_rotation_user(p_area_id, v_state.current_scheduled_user_id);
  update cleaning_area_state
     set activation_state = 'passive', last_cleaned_at = v_now, activated_at = null, activated_by_user_id = null,
         volunteer_user_id = null, volunteer_claimed_at = null,
         current_scheduled_user_id = v_next, updated_at = now()
   where cleaning_area_id = p_area_id;

  v_new_achievements := evaluate_achievements(v_area.house_id, v_uid);

  perform log_area_event(v_area.house_id, p_area_id, 'completed',
    jsonb_build_object('completion_id', v_completion_id, 'type', v_type, 'cleared_volunteer_user_id', v_cleared_volunteer, 'penalty', v_penalty));

  return jsonb_build_object(
    'completion_id', v_completion_id,
    'completion_type', v_type,
    'area_id', p_area_id, 'area_name', v_area.name, 'area_icon', v_area.icon,
    'points', v_total,
    'breakdown', jsonb_build_object('base', v_base, 'early_bonus', v_early, 'streak_bonus', v_streak_bonus),
    'penalty', v_penalty,
    'streak', v_streak,
    'scheduled_user_id', v_state.current_scheduled_user_id,
    'scheduled_user_name', (select name from profiles where id = v_state.current_scheduled_user_id),
    'next_user_id', v_next,
    'next_user_name', (select name from profiles where id = v_next),
    'new_achievements', v_new_achievements
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Monthly results — idempotent; safe from cron AND lazily on read.
-- ---------------------------------------------------------------------------
create or replace function public.award_monthly_results(p_house uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_current   timestamptz := house_month_start(p_house);
  v_first     timestamptz;
  v_month     timestamptz;
  v_end       timestamptz;
  v_champ     uuid; v_champ_pts int;
  v_loser     uuid; v_loser_pts int;
begin
  select min(created_at) into v_first from user_points_ledger where house_id = p_house;
  if v_first is null then return; end if;

  v_month := house_month_start(p_house, v_first);
  while v_month < v_current loop
    -- +45 days always lands inside the following month, whatever the timezone offset.
    v_end := house_month_start(p_house, v_month + interval '45 days');

    if not exists (select 1 from monthly_results where house_id = p_house and month_start = v_month) then
      v_champ := null; v_champ_pts := null; v_loser := null; v_loser_pts := null;

      select l.user_id, sum(l.points)::int into v_champ, v_champ_pts
        from user_points_ledger l
        join house_members hm on hm.house_id = l.house_id and hm.user_id = l.user_id
        join profiles p on p.id = l.user_id
       where l.house_id = p_house and l.created_at >= v_month and l.created_at < v_end
       group by l.user_id, p.name
       having sum(l.points) > 0
       order by sum(l.points) desc, p.name asc
       limit 1;

      if v_champ is not null then
        -- Lowest scorer among current, non-away members other than the champion.
        select hm.user_id, coalesce(sum(l.points), 0)::int into v_loser, v_loser_pts
          from house_members hm
          join profiles p on p.id = hm.user_id
          left join user_points_ledger l
                 on l.user_id = hm.user_id and l.house_id = p_house and l.created_at >= v_month and l.created_at < v_end
         where hm.house_id = p_house and not hm.away and hm.user_id <> v_champ
         group by hm.user_id, p.name
         order by coalesce(sum(l.points), 0) asc,
                  (select count(*) from cleaning_completions cc
                    where cc.house_id = p_house and cc.completed_by_user_id = hm.user_id
                      and cc.completed_at >= v_month and cc.completed_at < v_end) asc,
                  p.name asc
         limit 1;

        insert into monthly_results (house_id, month_start, champion_user_id, champion_points, loser_user_id, loser_points, forfeit)
        values (p_house, v_month, v_champ, v_champ_pts, v_loser, v_loser_pts,
                case when v_loser is not null then house_setting(p_house, 'monthly_forfeit', 'Buys snacks for the house') end)
        on conflict (house_id, month_start) do nothing;

        insert into skip_passes (house_id, user_id, month_start) values (p_house, v_champ, v_month)
        on conflict (house_id, user_id, month_start) do nothing;

        insert into user_achievements (house_id, user_id, achievement_id)
        values (p_house, v_champ, 'monthly_champion')
        on conflict do nothing;
      end if;
    end if;
    v_month := v_end;
  end loop;
end;
$$;

-- Hourly cron entry point: weekly + monthly.
create or replace function public.award_all_weekly_champions()
returns void language plpgsql security definer set search_path = public as $$
declare h record;
begin
  for h in select id from houses loop
    perform award_weekly_champions(h.id);
    perform award_monthly_results(h.id);
  end loop;
end;
$$;

create or replace function public.get_monthly_results(p_limit int default 12)
returns table (
  id uuid, month_start timestamptz,
  champion_user_id uuid, champion_name text, champion_avatar_url text, champion_points int,
  loser_user_id uuid, loser_name text, loser_avatar_url text, loser_points int,
  forfeit text, forfeit_done_at timestamptz, forfeit_done_by_name text
)
language plpgsql security definer set search_path = public as $$
declare v_house uuid := current_house_id();
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  perform award_monthly_results(v_house);
  return query
    select r.id, r.month_start,
           r.champion_user_id, cp.name, cp.avatar_url, r.champion_points,
           r.loser_user_id, lp.name, lp.avatar_url, r.loser_points,
           r.forfeit, r.forfeit_done_at, dp.name
      from monthly_results r
      left join profiles cp on cp.id = r.champion_user_id
      left join profiles lp on lp.id = r.loser_user_id
      left join profiles dp on dp.id = r.forfeit_done_by
     where r.house_id = v_house
     order by r.month_start desc
     limit p_limit;
end;
$$;

-- The loser themselves or an admin can tick the forfeit off (or un-tick it).
create or replace function public.mark_forfeit_done(p_result_id uuid, p_done boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); r monthly_results%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into r from monthly_results where id = p_result_id;
  if not found then raise exception 'result_not_found'; end if;
  if not is_house_member(r.house_id) then raise exception 'not_a_member'; end if;
  if v_uid is distinct from r.loser_user_id and not is_house_admin(r.house_id) then raise exception 'not_authorized'; end if;

  update monthly_results
     set forfeit_done_at = case when p_done then now() end,
         forfeit_done_by = case when p_done then v_uid end
   where id = p_result_id;
  perform log_area_event(r.house_id, null, 'forfeit_marked', jsonb_build_object('result_id', p_result_id, 'done', p_done));
  return jsonb_build_object('id', p_result_id, 'done', p_done);
end;
$$;

-- Spend a Skip Pass: the turn moves to the next available person, the area stays flagged,
-- no points and no penalty for anyone.
create or replace function public.use_skip_pass(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
  v_pass uuid; v_next uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_area from cleaning_areas where id = p_area_id and active;
  if not found then raise exception 'area_not_found'; end if;
  if not is_house_member(v_area.house_id) then raise exception 'not_a_member'; end if;

  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  if not found then raise exception 'area_not_found'; end if;
  if v_state.activation_state = 'passive' then raise exception 'not_active'; end if;
  if v_state.activation_state = 'volunteer_claimed' then raise exception 'already_claimed'; end if;
  if v_uid is distinct from v_state.current_scheduled_user_id then raise exception 'not_authorized'; end if;

  select id into v_pass from skip_passes
   where house_id = v_area.house_id and user_id = v_uid and used_at is null
   order by granted_at limit 1 for update;
  if v_pass is null then raise exception 'no_skip_pass'; end if;

  v_next := next_rotation_user(p_area_id, v_uid);
  if v_next is null or v_next = v_uid then raise exception 'no_one_to_skip_to'; end if;

  update cleaning_area_state set current_scheduled_user_id = v_next, updated_at = now() where cleaning_area_id = p_area_id;
  update skip_passes set used_at = now(), used_area_id = p_area_id where id = v_pass;

  perform log_area_event(v_area.house_id, p_area_id, 'turn_skipped', jsonb_build_object('from_user_id', v_uid, 'to_user_id', v_next, 'pass_id', v_pass));
  return jsonb_build_object(
    'area_id', p_area_id, 'area_name', v_area.name,
    'next_user_id', v_next, 'next_user_name', (select name from profiles where id = v_next),
    'passes_left', (select count(*) from skip_passes where house_id = v_area.house_id and user_id = v_uid and used_at is null)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin: away flag. Setting away hands every current turn to the next available person.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_member_away(p_user_id uuid, p_away boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); r record; v_next uuid;
begin
  update house_members set away = p_away where house_id = v_house and user_id = p_user_id;
  if not found then raise exception 'not_a_member'; end if;

  if p_away then
    for r in select s.* from cleaning_area_state s where s.house_id = v_house and s.current_scheduled_user_id = p_user_id loop
      v_next := next_rotation_user(r.cleaning_area_id, p_user_id);
      if v_next is not null and v_next <> p_user_id then
        update cleaning_area_state
           set current_scheduled_user_id = v_next,
               volunteer_user_id = case when volunteer_user_id = v_next then null else volunteer_user_id end,
               volunteer_claimed_at = case when volunteer_user_id = v_next then null else volunteer_claimed_at end,
               activation_state = case when activation_state = 'volunteer_claimed' and volunteer_user_id = v_next then 'active' else activation_state end,
               updated_at = now()
         where cleaning_area_id = r.cleaning_area_id;
      end if;
    end loop;
  end if;

  perform log_area_event(v_house, null, 'admin_member_away_set', jsonb_build_object('user_id', p_user_id, 'away', p_away));
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings allow-list + validation for the two new keys.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_probe timestamptz;
begin
  if p_key not in ('timezone', 'week_start_day', 'default_reactivation_cooldown_hours', 'volunteering_enabled',
                   'early_bonus_points', 'streak_bonus_3', 'streak_bonus_5', 'streak_bonus_10', 'public_login_directory', 'house_name',
                   'rescue_penalty_points', 'monthly_forfeit') then
    raise exception 'unknown_setting';
  end if;
  if p_key = 'timezone' then
    begin
      v_probe := now() at time zone p_value at time zone p_value;
    exception when others then
      raise exception 'invalid_timezone';
    end;
  end if;
  if p_key = 'week_start_day' and lower(p_value) not in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday') then
    raise exception 'invalid_value';
  end if;
  if p_key in ('default_reactivation_cooldown_hours','early_bonus_points','streak_bonus_3','streak_bonus_5','streak_bonus_10','rescue_penalty_points') then
    if p_value !~ '^\d{1,4}$' then raise exception 'invalid_value'; end if;
  end if;
  if p_key in ('volunteering_enabled', 'public_login_directory') and p_value not in ('true', 'false') then
    raise exception 'invalid_value';
  end if;
  if p_key = 'monthly_forfeit' and char_length(trim(p_value)) not between 1 and 120 then
    raise exception 'invalid_value';
  end if;
  if p_key = 'house_name' then
    update houses set name = trim(p_value) where id = v_house;
    return;
  end if;
  insert into house_settings (house_id, key, value) values (v_house, p_key, trim(p_value))
  on conflict (house_id, key) do update set value = excluded.value;
  perform log_area_event(v_house, null, 'admin_setting_set', jsonb_build_object('key', p_key, 'value', p_value));
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads: leaderboard also settles the month; stats gain wins / passes / penalties.
-- ---------------------------------------------------------------------------
create or replace function public.get_leaderboard(p_period text default 'week')
returns table (user_id uuid, name text, avatar_url text, points bigint, rank int, current_streak int)
language plpgsql security definer set search_path = public as $$
declare v_house uuid := current_house_id(); v_from timestamptz;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  perform award_weekly_champions(v_house);
  perform award_monthly_results(v_house);
  v_from := case p_period
              when 'week'  then house_week_start(v_house)
              when 'month' then house_month_start(v_house)
              else '-infinity'::timestamptz end;
  return query
    select p.id, p.name, p.avatar_url,
           coalesce(sum(l.points), 0)::bigint as pts,
           (rank() over (order by coalesce(sum(l.points), 0) desc))::int as rnk,
           coalesce(max(s.current_streak), 0)::int as streak
      from house_members hm
      join profiles p on p.id = hm.user_id
      left join user_points_ledger l on l.user_id = p.id and l.house_id = v_house and l.created_at >= v_from
      left join user_streaks s on s.user_id = p.id and s.house_id = v_house
     where hm.house_id = v_house
     group by p.id, p.name, p.avatar_url
     order by pts desc, p.name asc;
end;
$$;

create or replace function public.get_user_stats(p_user_id uuid default auth.uid())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house uuid := current_house_id();
  v_week_start timestamptz; v_month_start timestamptz;
  v_result jsonb;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  if not shares_house_with(p_user_id) then raise exception 'not_authorized'; end if;
  perform award_weekly_champions(v_house);
  perform award_monthly_results(v_house);
  v_week_start := house_week_start(v_house);
  v_month_start := house_month_start(v_house);

  select jsonb_build_object(
    'user_id', p_user_id,
    'weekly_points',  coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id and created_at >= v_week_start), 0),
    'monthly_points', coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id and created_at >= v_month_start), 0),
    'total_points',   coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id), 0),
    'penalty_points', coalesce((select -sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id and created_at >= v_month_start and points < 0), 0),
    'weekly_rank',    (select lb.rank from get_leaderboard('week') lb where lb.user_id = p_user_id),
    'monthly_rank',   (select lb.rank from get_leaderboard('month') lb where lb.user_id = p_user_id),
    'member_count',   (select count(*) from house_members where house_id = v_house),
    'current_streak', coalesce((select current_streak from user_streaks where house_id = v_house and user_id = p_user_id), 0),
    'longest_streak', coalesce((select longest_streak from user_streaks where house_id = v_house and user_id = p_user_id), 0),
    'normal_completions', (select count(*) from cleaning_completions where house_id = v_house and completed_by_user_id = p_user_id and completion_type = 'normal'),
    'rescues',        (select count(*) from cleaning_completions where house_id = v_house and completed_by_user_id = p_user_id and completion_type = 'volunteer'),
    'weekly_wins',    (select count(*) from weekly_champions where house_id = v_house and user_id = p_user_id),
    'monthly_wins',   (select count(*) from monthly_results where house_id = v_house and champion_user_id = p_user_id),
    'skip_passes',    (select count(*) from skip_passes where house_id = v_house and user_id = p_user_id and used_at is null),
    'achievements',   coalesce((
        select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'description', a.description, 'icon', a.icon, 'earned_at', ua.earned_at) order by ua.earned_at desc)
          from user_achievements ua join achievements a on a.id = ua.achievement_id
         where ua.house_id = v_house and ua.user_id = p_user_id), '[]'::jsonb),
    'week_start', v_week_start,
    'week_end', house_week_end(v_house, v_week_start),
    'month_start', v_month_start
  ) into v_result;
  return v_result;
end;
$$;

-- Reset also clears monthly results and passes.
create or replace function public.admin_reset_house(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin();
begin
  if p_mode not in ('scores', 'everything') then raise exception 'invalid_value'; end if;

  delete from user_points_ledger where house_id = v_house;
  delete from weekly_champions where house_id = v_house;
  delete from monthly_results where house_id = v_house;
  delete from skip_passes where house_id = v_house;
  delete from user_achievements where house_id = v_house;
  update user_streaks set current_streak = 0, longest_streak = 0, updated_at = now() where house_id = v_house;

  if p_mode = 'scores' then
    update cleaning_completions set points_awarded = 0 where house_id = v_house;
  else
    delete from cleaning_completions where house_id = v_house;
    delete from area_events where house_id = v_house;
    update cleaning_area_state s
       set activation_state = 'passive', last_cleaned_at = null, activated_at = null, activated_by_user_id = null,
           volunteer_user_id = null, volunteer_claimed_at = null,
           current_scheduled_user_id = (select m.user_id from cleaning_rotation_members m
                                         where m.cleaning_area_id = s.cleaning_area_id order by m.position limit 1),
           updated_at = now()
     where s.house_id = v_house;
  end if;

  perform log_area_event(v_house, null, 'admin_reset', jsonb_build_object('mode', p_mode));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'next_rotation_user', 'is_away', 'mark_needs_cleaning', 'complete_cleaning', 'award_monthly_results',
      'award_all_weekly_champions', 'get_monthly_results', 'mark_forfeit_done', 'use_skip_pass',
      'admin_set_member_away', 'admin_set_setting', 'get_leaderboard', 'get_user_stats', 'admin_reset_house')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
