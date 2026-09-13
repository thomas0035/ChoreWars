-- ============================================================================
-- ChoreWars — business logic
-- Every state change goes through a SECURITY DEFINER function. Clients have no
-- INSERT/UPDATE/DELETE policies on any table (except profiles.name/avatar for
-- self), so points, rotations and streaks can only change here.
--
-- Error convention: RAISE EXCEPTION with a short snake_case code as the
-- message (e.g. 'cooldown', 'already_claimed'); the client maps it to copy.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.is_house_member(p_house uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from house_members where house_id = p_house and user_id = auth.uid());
$$;

create or replace function public.is_house_admin(p_house uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from house_members where house_id = p_house and user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.shares_house_with(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user = auth.uid() or exists (
    select 1 from house_members a join house_members b on a.house_id = b.house_id
    where a.user_id = auth.uid() and b.user_id = p_user
  );
$$;

create or replace function public.current_house_id()
returns uuid language sql stable security definer set search_path = public as $$
  select house_id from house_members where user_id = auth.uid() order by joined_at limit 1;
$$;

create or replace function public.house_setting(p_house uuid, p_key text, p_default text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select value from house_settings where house_id = p_house and key = p_key), p_default);
$$;

create or replace function public.house_setting_int(p_house uuid, p_key text, p_default int)
returns int language plpgsql stable security definer set search_path = public as $$
declare v text := house_setting(p_house, p_key, p_default::text);
begin
  return v::int;
exception when others then
  return p_default;
end;
$$;

-- Start of the house-week containing p_ts (week_start_day + timezone from house_settings).
create or replace function public.house_week_start(p_house uuid, p_ts timestamptz default now())
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  v_tz        text := house_setting(p_house, 'timezone', 'UTC');
  v_day       text := lower(house_setting(p_house, 'week_start_day', 'monday'));
  v_start_dow int  := case v_day
                        when 'monday' then 1 when 'tuesday' then 2 when 'wednesday' then 3
                        when 'thursday' then 4 when 'friday' then 5 when 'saturday' then 6
                        when 'sunday' then 7 else 1 end;
  v_local     date;
  v_dow       int;
  v_diff      int;
begin
  v_local := (p_ts at time zone v_tz)::date;
  v_dow   := extract(isodow from v_local)::int;
  v_diff  := ((v_dow - v_start_dow) + 7) % 7;
  return ((v_local - v_diff)::timestamp) at time zone v_tz;
end;
$$;

create or replace function public.house_week_end(p_house uuid, p_week_start timestamptz)
returns timestamptz language sql stable security definer set search_path = public as $$
  select house_week_start(p_house, p_week_start + interval '7 days 12 hours');
$$;

create or replace function public.house_month_start(p_house uuid, p_ts timestamptz default now())
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare v_tz text := house_setting(p_house, 'timezone', 'UTC');
begin
  return date_trunc('month', p_ts at time zone v_tz) at time zone v_tz;
end;
$$;

-- Next member in an area's rotation after p_current (wraps; falls back to first).
create or replace function public.next_rotation_user(p_area uuid, p_current uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_pos int; v_next uuid;
begin
  select position into v_pos from cleaning_rotation_members where cleaning_area_id = p_area and user_id = p_current;
  if v_pos is not null then
    select user_id into v_next from cleaning_rotation_members
    where cleaning_area_id = p_area and position > v_pos order by position limit 1;
  end if;
  if v_next is null then
    select user_id into v_next from cleaning_rotation_members
    where cleaning_area_id = p_area order by position limit 1;
  end if;
  return v_next;
end;
$$;

create or replace function public.log_area_event(p_house uuid, p_area uuid, p_type text, p_details jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into area_events (house_id, cleaning_area_id, user_id, event_type, details)
  values (p_house, p_area, auth.uid(), p_type, p_details);
$$;

-- ---------------------------------------------------------------------------
-- Achievements (evaluated inside the completing transaction — never async)
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_achievements(p_house uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_total int; v_normal int; v_rescues int; v_quick boolean; v_streak int; v_new jsonb;
begin
  select count(*), count(*) filter (where completion_type = 'normal'),
         count(*) filter (where completion_type = 'volunteer'),
         coalesce(bool_or(activated_at is not null and completed_at - activated_at <= interval '2 hours'), false)
    into v_total, v_normal, v_rescues, v_quick
    from cleaning_completions where house_id = p_house and completed_by_user_id = p_user;

  select coalesce(max(current_streak), 0) into v_streak from user_streaks where house_id = p_house and user_id = p_user;

  with earned as (
    select a.id from achievements a
    where (a.id = 'first_clean'   and v_total   >= 1)
       or (a.id = 'quick_cleaner' and v_quick)
       or (a.id = 'on_fire'       and v_streak  >= 5)
       or (a.id = 'house_hero'    and v_rescues >= 3)
       or (a.id = 'reliable'      and v_normal  >= 20)
       or (a.id = 'unstoppable'   and v_streak  >= 10)
       or (a.id = 'house_legend'  and v_total   >= 100)
  ), ins as (
    insert into user_achievements (house_id, user_id, achievement_id)
    select p_house, p_user, id from earned
    on conflict do nothing
    returning achievement_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'description', a.description, 'icon', a.icon)), '[]'::jsonb)
    into v_new
    from ins join achievements a on a.id = ins.achievement_id;

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Weekly champions — idempotent; safe to call from cron AND lazily on read.
-- ---------------------------------------------------------------------------
create or replace function public.award_weekly_champions(p_house uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_current_week timestamptz := house_week_start(p_house);
  v_first        timestamptz;
  v_week         timestamptz;
  v_week_end     timestamptz;
  r              record;
begin
  select min(created_at) into v_first from user_points_ledger where house_id = p_house;
  if v_first is null then return; end if;

  v_week := house_week_start(p_house, v_first);
  while v_week < v_current_week loop
    v_week_end := house_week_end(p_house, v_week);
    if not exists (select 1 from weekly_champions where house_id = p_house and week_start = v_week) then
      select l.user_id, sum(l.points)::int as pts into r
        from user_points_ledger l
        join house_members hm on hm.house_id = l.house_id and hm.user_id = l.user_id
        join profiles p on p.id = l.user_id
       where l.house_id = p_house and l.created_at >= v_week and l.created_at < v_week_end
       group by l.user_id, p.name
       having sum(l.points) > 0
       order by sum(l.points) desc, p.name asc
       limit 1;
      if found then
        insert into weekly_champions (house_id, week_start, user_id, points)
        values (p_house, v_week, r.user_id, r.pts)
        on conflict (house_id, week_start) do nothing;
        insert into user_achievements (house_id, user_id, achievement_id)
        values (p_house, r.user_id, 'weekly_champion')
        on conflict do nothing;
      end if;
    end if;
    v_week := v_week_end;
  end loop;
end;
$$;

create or replace function public.award_all_weekly_champions()
returns void language plpgsql security definer set search_path = public as $$
declare h record;
begin
  for h in select id from houses loop
    perform award_weekly_champions(h.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Member actions
-- ---------------------------------------------------------------------------

-- Mark an area as Needs Cleaning (0 points; subject to reactivation cooldown).
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

-- "Looks fine / not needed": scheduled person or admin returns an active area to passive. No rotation, no points.
create or replace function public.dismiss_activation(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_area from cleaning_areas where id = p_area_id and active;
  if not found then raise exception 'area_not_found'; end if;
  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  if v_state.activation_state = 'passive' then raise exception 'not_active'; end if;
  if v_uid <> v_state.current_scheduled_user_id and not is_house_admin(v_area.house_id) then
    raise exception 'not_authorized';
  end if;

  update cleaning_area_state
     set activation_state = 'passive', activated_at = null, activated_by_user_id = null,
         volunteer_user_id = null, volunteer_claimed_at = null, updated_at = now()
   where cleaning_area_id = p_area_id;

  perform log_area_event(v_area.house_id, p_area_id, 'dismissed',
    jsonb_build_object('activated_by_user_id', v_state.activated_by_user_id, 'activated_at', v_state.activated_at,
                       'volunteer_user_id', v_state.volunteer_user_id));
  return jsonb_build_object('area_id', p_area_id);
end;
$$;

-- Atomic volunteer claim. Exactly one concurrent caller can win the conditional UPDATE.
create or replace function public.claim_volunteer(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
  v_claimed uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_area from cleaning_areas where id = p_area_id and active;
  if not found then raise exception 'area_not_found'; end if;
  if not is_house_member(v_area.house_id) then raise exception 'not_a_member'; end if;
  if house_setting(v_area.house_id, 'volunteering_enabled', 'true') <> 'true' then raise exception 'volunteering_disabled'; end if;

  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id;
  if v_state.activation_state = 'passive' then raise exception 'not_active'; end if;
  if v_state.current_scheduled_user_id = v_uid then raise exception 'is_scheduled_user'; end if;
  if v_state.activation_state = 'volunteer_claimed' then raise exception 'already_claimed'; end if;
  if now() < v_state.activated_at + make_interval(hours => v_area.volunteer_grace_hours) then
    raise exception 'grace_period' using detail = (v_state.activated_at + make_interval(hours => v_area.volunteer_grace_hours))::text;
  end if;

  -- The single conditional write: state must still be 'active' with no volunteer, and grace must have elapsed.
  update cleaning_area_state
     set activation_state = 'volunteer_claimed', volunteer_user_id = v_uid, volunteer_claimed_at = now(), updated_at = now()
   where cleaning_area_id = p_area_id
     and activation_state = 'active'
     and volunteer_user_id is null
     and now() >= activated_at + make_interval(hours => v_area.volunteer_grace_hours)
  returning cleaning_area_id into v_claimed;

  if v_claimed is null then raise exception 'already_claimed'; end if;

  perform log_area_event(v_area.house_id, p_area_id, 'volunteer_claimed',
    jsonb_build_object('scheduled_user_id', v_state.current_scheduled_user_id));

  return jsonb_build_object(
    'area_id', p_area_id, 'area_name', v_area.name, 'area_icon', v_area.icon,
    'scheduled_user_name', (select name from profiles where id = v_state.current_scheduled_user_id)
  );
end;
$$;

-- Volunteer (or admin) releases a claim; responsibility returns to the scheduled person.
create or replace function public.release_volunteer(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_area from cleaning_areas where id = p_area_id and active;
  if not found then raise exception 'area_not_found'; end if;
  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  if v_state.activation_state <> 'volunteer_claimed' then raise exception 'not_claimed'; end if;
  if v_uid <> v_state.volunteer_user_id and not is_house_admin(v_area.house_id) then raise exception 'not_authorized'; end if;

  update cleaning_area_state
     set activation_state = 'active', volunteer_user_id = null, volunteer_claimed_at = null, updated_at = now()
   where cleaning_area_id = p_area_id;

  perform log_area_event(v_area.house_id, p_area_id, 'volunteer_released',
    jsonb_build_object('volunteer_user_id', v_state.volunteer_user_id));
  return jsonb_build_object('area_id', p_area_id);
end;
$$;

-- Complete an active cleaning. Records completion, awards points (server-side only),
-- updates streaks & achievements, advances rotation, resets to passive — atomically.
create or replace function public.complete_cleaning(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
  v_type completion_type;
  v_base int; v_early int := 0; v_streak_bonus int := 0; v_total int;
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
  -- a rescue resets the scheduled person's streak (the only streak-breaking event in V1).
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

  -- Advance only this area's rotation; reset to passive.
  v_next := next_rotation_user(p_area_id, v_state.current_scheduled_user_id);
  update cleaning_area_state
     set activation_state = 'passive', last_cleaned_at = v_now, activated_at = null, activated_by_user_id = null,
         volunteer_user_id = null, volunteer_claimed_at = null,
         current_scheduled_user_id = v_next, updated_at = now()
   where cleaning_area_id = p_area_id;

  v_new_achievements := evaluate_achievements(v_area.house_id, v_uid);

  perform log_area_event(v_area.house_id, p_area_id, 'completed',
    jsonb_build_object('completion_id', v_completion_id, 'type', v_type, 'cleared_volunteer_user_id', v_cleared_volunteer));

  return jsonb_build_object(
    'completion_id', v_completion_id,
    'completion_type', v_type,
    'area_id', p_area_id, 'area_name', v_area.name, 'area_icon', v_area.icon,
    'points', v_total,
    'breakdown', jsonb_build_object('base', v_base, 'early_bonus', v_early, 'streak_bonus', v_streak_bonus),
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
-- Reads
-- ---------------------------------------------------------------------------
create or replace function public.get_leaderboard(p_period text default 'week')
returns table (user_id uuid, name text, avatar_url text, points bigint, rank int, current_streak int)
language plpgsql security definer set search_path = public as $$
declare v_house uuid := current_house_id(); v_from timestamptz;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  perform award_weekly_champions(v_house);
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
  v_week_start := house_week_start(v_house);
  v_month_start := house_month_start(v_house);

  select jsonb_build_object(
    'user_id', p_user_id,
    'weekly_points',  coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id and created_at >= v_week_start), 0),
    'monthly_points', coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id and created_at >= v_month_start), 0),
    'total_points',   coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id), 0),
    'weekly_rank',    (select lb.rank from get_leaderboard('week') lb where lb.user_id = p_user_id),
    'member_count',   (select count(*) from house_members where house_id = v_house),
    'current_streak', coalesce((select current_streak from user_streaks where house_id = v_house and user_id = p_user_id), 0),
    'longest_streak', coalesce((select longest_streak from user_streaks where house_id = v_house and user_id = p_user_id), 0),
    'normal_completions', (select count(*) from cleaning_completions where house_id = v_house and completed_by_user_id = p_user_id and completion_type = 'normal'),
    'rescues',        (select count(*) from cleaning_completions where house_id = v_house and completed_by_user_id = p_user_id and completion_type = 'volunteer'),
    'weekly_wins',    (select count(*) from weekly_champions where house_id = v_house and user_id = p_user_id),
    'achievements',   coalesce((
        select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'description', a.description, 'icon', a.icon, 'earned_at', ua.earned_at) order by ua.earned_at desc)
          from user_achievements ua join achievements a on a.id = ua.achievement_id
         where ua.house_id = v_house and ua.user_id = p_user_id), '[]'::jsonb),
    'week_start', v_week_start,
    'week_end', house_week_end(v_house, v_week_start)
  ) into v_result;
  return v_result;
end;
$$;

-- Last week's champion (for the leaderboard header).
create or replace function public.get_last_week_champion()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_house uuid := current_house_id(); v_prev timestamptz; v_result jsonb;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  perform award_weekly_champions(v_house);
  v_prev := house_week_start(v_house, house_week_start(v_house) - interval '12 hours');
  select jsonb_build_object('user_id', wc.user_id, 'name', p.name, 'avatar_url', p.avatar_url, 'points', wc.points, 'week_start', wc.week_start)
    into v_result
    from weekly_champions wc join profiles p on p.id = wc.user_id
   where wc.house_id = v_house and wc.week_start = v_prev;
  return v_result; -- null when no champion yet
end;
$$;

-- Names/avatars for the login screen (anon-callable, gated by a house setting).
create or replace function public.login_directory()
returns table (name text, avatar_url text, email text)
language sql stable security definer set search_path = public as $$
  select p.name, p.avatar_url, u.email::text
    from house_members hm
    join houses h on h.id = hm.house_id
    join profiles p on p.id = hm.user_id
    join auth.users u on u.id = p.id
   where house_setting(h.id, 'public_login_directory', 'false') = 'true'
   order by p.name;
$$;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create or replace function public.require_admin()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_house uuid := current_house_id();
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  if not is_house_admin(v_house) then raise exception 'not_admin'; end if;
  return v_house;
end;
$$;

create or replace function public.admin_save_area(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_id uuid := (p ->> 'id')::uuid;
begin
  if v_id is null then
    insert into cleaning_areas (house_id, name, icon, normal_points, rescue_points, minimum_interval_hours,
      expected_interval_hours, attention_interval_hours, volunteer_grace_hours, reactivation_cooldown_hours, sort_order)
    values (v_house, p ->> 'name', coalesce(p ->> 'icon', '🧹'),
      coalesce((p ->> 'normal_points')::int, 10), coalesce((p ->> 'rescue_points')::int, 12),
      coalesce((p ->> 'minimum_interval_hours')::int, 120), coalesce((p ->> 'expected_interval_hours')::int, 168),
      coalesce((p ->> 'attention_interval_hours')::int, 288), coalesce((p ->> 'volunteer_grace_hours')::int, 24),
      (p ->> 'reactivation_cooldown_hours')::int,
      coalesce((p ->> 'sort_order')::int, (select coalesce(max(sort_order), 0) + 10 from cleaning_areas where house_id = v_house)))
    returning id into v_id;
    insert into cleaning_area_state (cleaning_area_id, house_id) values (v_id, v_house);
    perform log_area_event(v_house, v_id, 'admin_area_created', p);
  else
    if not exists (select 1 from cleaning_areas where id = v_id and house_id = v_house) then raise exception 'area_not_found'; end if;
    update cleaning_areas set
      name = coalesce(p ->> 'name', name),
      icon = coalesce(p ->> 'icon', icon),
      normal_points = coalesce((p ->> 'normal_points')::int, normal_points),
      rescue_points = coalesce((p ->> 'rescue_points')::int, rescue_points),
      minimum_interval_hours = coalesce((p ->> 'minimum_interval_hours')::int, minimum_interval_hours),
      expected_interval_hours = coalesce((p ->> 'expected_interval_hours')::int, expected_interval_hours),
      attention_interval_hours = coalesce((p ->> 'attention_interval_hours')::int, attention_interval_hours),
      volunteer_grace_hours = coalesce((p ->> 'volunteer_grace_hours')::int, volunteer_grace_hours),
      reactivation_cooldown_hours = case when p ? 'reactivation_cooldown_hours' then (p ->> 'reactivation_cooldown_hours')::int else reactivation_cooldown_hours end,
      sort_order = coalesce((p ->> 'sort_order')::int, sort_order),
      active = coalesce((p ->> 'active')::boolean, active)
    where id = v_id;
    perform log_area_event(v_house, v_id, 'admin_area_updated', p);
  end if;
  return v_id;
end;
$$;

-- Replace an area's rotation order. Keeps the current scheduled person if still present, else the first.
create or replace function public.admin_set_rotation(p_area_id uuid, p_user_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_scheduled uuid; v_state cleaning_area_state%rowtype;
begin
  if not exists (select 1 from cleaning_areas where id = p_area_id and house_id = v_house) then raise exception 'area_not_found'; end if;
  if exists (select 1 from unnest(p_user_ids) u where not exists (select 1 from house_members where house_id = v_house and user_id = u)) then
    raise exception 'not_a_member';
  end if;
  if (select count(distinct u) from unnest(p_user_ids) u) <> coalesce(array_length(p_user_ids, 1), 0) then raise exception 'duplicate_member'; end if;

  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  delete from cleaning_rotation_members where cleaning_area_id = p_area_id;
  insert into cleaning_rotation_members (house_id, cleaning_area_id, user_id, position)
  select v_house, p_area_id, u, (ord - 1)::int from unnest(p_user_ids) with ordinality as t(u, ord);

  v_scheduled := v_state.current_scheduled_user_id;
  if v_scheduled is null or not (v_scheduled = any (p_user_ids)) then
    v_scheduled := (case when array_length(p_user_ids, 1) > 0 then p_user_ids[1] else null end);
  end if;
  update cleaning_area_state
     set current_scheduled_user_id = v_scheduled,
         -- if the scheduled person changed while active and a volunteer was the new scheduled person, clear the claim
         volunteer_user_id = case when volunteer_user_id = v_scheduled then null else volunteer_user_id end,
         volunteer_claimed_at = case when volunteer_user_id = v_scheduled then null else volunteer_claimed_at end,
         activation_state = case when activation_state = 'volunteer_claimed' and volunteer_user_id = v_scheduled then 'active' else activation_state end,
         updated_at = now()
   where cleaning_area_id = p_area_id;
  perform log_area_event(v_house, p_area_id, 'admin_rotation_set', jsonb_build_object('user_ids', to_jsonb(p_user_ids)));
end;
$$;

create or replace function public.admin_set_scheduled_user(p_area_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin();
begin
  if not exists (select 1 from cleaning_areas where id = p_area_id and house_id = v_house) then raise exception 'area_not_found'; end if;
  if not exists (select 1 from cleaning_rotation_members where cleaning_area_id = p_area_id and user_id = p_user_id) then raise exception 'not_in_rotation'; end if;
  update cleaning_area_state
     set current_scheduled_user_id = p_user_id,
         volunteer_user_id = case when volunteer_user_id = p_user_id then null else volunteer_user_id end,
         volunteer_claimed_at = case when volunteer_user_id = p_user_id then null else volunteer_claimed_at end,
         activation_state = case when activation_state = 'volunteer_claimed' and volunteer_user_id = p_user_id then 'active' else activation_state end,
         updated_at = now()
   where cleaning_area_id = p_area_id;
  perform log_area_event(v_house, p_area_id, 'admin_scheduled_set', jsonb_build_object('user_id', p_user_id));
end;
$$;

create or replace function public.admin_set_member_role(p_user_id uuid, p_role house_role)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin();
begin
  if p_role = 'member' and p_user_id = auth.uid()
     and (select count(*) from house_members where house_id = v_house and role = 'admin') <= 1 then
    raise exception 'last_admin';
  end if;
  update house_members set role = p_role where house_id = v_house and user_id = p_user_id;
  if not found then raise exception 'not_a_member'; end if;
  perform log_area_event(v_house, null, 'admin_role_set', jsonb_build_object('user_id', p_user_id, 'role', p_role));
end;
$$;

create or replace function public.admin_rename_member(p_user_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin();
begin
  if not exists (select 1 from house_members where house_id = v_house and user_id = p_user_id) then raise exception 'not_a_member'; end if;
  update profiles set name = trim(p_name) where id = p_user_id;
  perform log_area_event(v_house, null, 'admin_member_renamed', jsonb_build_object('user_id', p_user_id, 'name', p_name));
end;
$$;

-- Add an existing auth user (created in Supabase Auth) to the house by email.
create or replace function public.admin_add_member(p_email text, p_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if v_uid is null then raise exception 'user_not_found'; end if;
  insert into profiles (id, name) values (v_uid, coalesce(nullif(trim(p_name), ''), initcap(split_part(p_email, '@', 1))))
  on conflict (id) do update set name = coalesce(nullif(trim(p_name), ''), profiles.name);
  insert into house_members (house_id, user_id, role) values (v_house, v_uid, 'member') on conflict do nothing;
  insert into user_streaks (house_id, user_id) values (v_house, v_uid) on conflict do nothing;
  perform log_area_event(v_house, null, 'admin_member_added', jsonb_build_object('user_id', v_uid));
  return v_uid;
end;
$$;

-- Remove a member: drops them from every rotation and hands off any scheduled/volunteer slots. History is kept.
create or replace function public.admin_remove_member(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); r record; v_next uuid;
begin
  if p_user_id = auth.uid() then raise exception 'cannot_remove_self'; end if;
  if not exists (select 1 from house_members where house_id = v_house and user_id = p_user_id) then raise exception 'not_a_member'; end if;

  for r in select s.* from cleaning_area_state s where s.house_id = v_house
            and (s.current_scheduled_user_id = p_user_id or s.volunteer_user_id = p_user_id) loop
    if r.current_scheduled_user_id = p_user_id then
      v_next := next_rotation_user(r.cleaning_area_id, p_user_id);
      if v_next = p_user_id then v_next := null; end if;
    else
      v_next := r.current_scheduled_user_id;
    end if;
    update cleaning_area_state
       set current_scheduled_user_id = v_next,
           volunteer_user_id = case when volunteer_user_id = p_user_id then null else volunteer_user_id end,
           volunteer_claimed_at = case when volunteer_user_id = p_user_id then null else volunteer_claimed_at end,
           activation_state = case when activation_state = 'volunteer_claimed' and volunteer_user_id = p_user_id then 'active' else activation_state end,
           updated_at = now()
     where cleaning_area_id = r.cleaning_area_id;
  end loop;

  delete from cleaning_rotation_members where house_id = v_house and user_id = p_user_id;
  delete from house_members where house_id = v_house and user_id = p_user_id;
  perform log_area_event(v_house, null, 'admin_member_removed', jsonb_build_object('user_id', p_user_id));
end;
$$;

create or replace function public.admin_set_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_probe timestamptz;
begin
  if p_key not in ('timezone', 'week_start_day', 'default_reactivation_cooldown_hours', 'volunteering_enabled',
                   'early_bonus_points', 'streak_bonus_3', 'streak_bonus_5', 'streak_bonus_10', 'public_login_directory', 'house_name') then
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
  if p_key in ('default_reactivation_cooldown_hours','early_bonus_points','streak_bonus_3','streak_bonus_5','streak_bonus_10') then
    if p_value !~ '^\d{1,4}$' then raise exception 'invalid_value'; end if;
  end if;
  if p_key in ('volunteering_enabled', 'public_login_directory') and p_value not in ('true', 'false') then
    raise exception 'invalid_value';
  end if;
  if p_key = 'house_name' then
    update houses set name = trim(p_value) where id = v_house;
    return;
  end if;
  insert into house_settings (house_id, key, value) values (v_house, p_key, p_value)
  on conflict (house_id, key) do update set value = excluded.value;
  perform log_area_event(v_house, null, 'admin_setting_set', jsonb_build_object('key', p_key, 'value', p_value));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: everything requires an authenticated user except the login directory.
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname <> 'login_directory'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
grant execute on function public.login_directory() to anon, authenticated;
