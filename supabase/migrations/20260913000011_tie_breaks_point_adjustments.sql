-- ============================================================================
-- Fair tie-breaks + admin point adjustments.
--
-- 1. Ties. Champion and forfeit used to fall back to "name asc", so the person
--    first in the alphabet won every tie. New ladders:
--      champion : points desc, rescues done desc, times rescued asc,
--                 reached their final score first (earliest last ledger row), name
--      forfeit  : points asc, times rescued desc, own turns asc,
--                 reached their final score last (latest last ledger row).
--                 If two people are identical on all of that, nobody takes the forfeit.
--      weekly   : points desc, reached their final score first, name
--    The leaderboard still shares ranks (two #1s, then #3); only the awards change.
--
-- 2. Admin adjustments. Admins can give or take points for things that aren't
--    a clean (dirty dishes left out, an area not checked, extra effort...).
--    Each one is a normal ledger row with reason 'admin_adjustment', a required
--    note and the admin who made it, so it counts everywhere a SUM over the
--    ledger counts (round, week, all time) and the whole house can read it.
--    Size is capped by house setting `max_point_adjustment` (default 50).
--    An adjustment can be undone until its round is settled, like a completion.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Ledger: note + author
-- ---------------------------------------------------------------------------
alter table public.user_points_ledger
  add column if not exists note       text,
  add column if not exists created_by uuid references public.profiles (id) on delete set null;

create index if not exists user_points_ledger_adjustments_idx
  on public.user_points_ledger (house_id, created_at desc) where reason = 'admin_adjustment';

-- ---------------------------------------------------------------------------
-- 2. Round scores: last_scored_at for tie-breaks; admin deductions are not
--    "penalties" (that column means rescue penalties on the profile page).
-- ---------------------------------------------------------------------------
drop function if exists public.league_round_scores(uuid, timestamptz, timestamptz, int);   -- return table gains a column

create or replace function public.league_round_scores(p_house uuid, p_start timestamptz, p_end timestamptz, p_turns int)
returns table (user_id uuid, points int, own_turns int, rescues int, rescued int, penalty_points int, last_scored_at timestamptz)
language sql stable security definer set search_path = public as $$
  with own as (
    select cc.id, cc.scheduled_user_id as uid,
           row_number() over (partition by cc.scheduled_user_id order by cc.completed_at, cc.id) as turn_no
      from cleaning_completions cc
     where cc.house_id = p_house
       and cc.activated_at is not null          -- admin back-filled cleans are not turns
       and cc.scheduled_user_id is not null
       and cc.completed_at > p_start and (p_end is null or cc.completed_at <= p_end)
  ),
  led as (
    select l.user_id as uid, l.points as pts, l.reason, l.created_at
      from user_points_ledger l
      left join own o on o.id = l.cleaning_completion_id and o.uid = l.user_id
     where l.house_id = p_house
       and l.created_at > p_start and (p_end is null or l.created_at <= p_end)
       and (o.id is null or o.turn_no <= p_turns)
  ),
  vol as (
    select cc.completed_by_user_id as uid, count(*) as n
      from cleaning_completions cc
     where cc.house_id = p_house and cc.completion_type = 'volunteer' and cc.activated_at is not null
       and cc.completed_at > p_start and (p_end is null or cc.completed_at <= p_end)
     group by cc.completed_by_user_id
  )
  select hm.user_id,
         coalesce((select sum(led.pts) from led where led.uid = hm.user_id), 0)::int,
         (select count(*) from own where own.uid = hm.user_id)::int,
         coalesce((select vol.n from vol where vol.uid = hm.user_id), 0)::int,
         (select count(*) from led where led.uid = hm.user_id and led.reason = 'rescued_penalty')::int,
         coalesce((select -sum(led.pts) from led where led.uid = hm.user_id and led.pts < 0 and led.reason <> 'admin_adjustment'), 0)::int,
         (select max(led.created_at) from led where led.uid = hm.user_id)
    from house_members hm
   where hm.house_id = p_house;
$$;

-- ---------------------------------------------------------------------------
-- 3. Round settlement with the new ladders (body otherwise as in 0008)
-- ---------------------------------------------------------------------------
create or replace function public.settle_league_rounds(p_house uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_n        int := league_turns(p_house);
  v_max      int := league_max_days(p_house);
  r          league_rounds%rowtype;
  v_start    timestamptz;
  v_deadline timestamptz;
  v_end      timestamptz;
  v_reason   text;
  v_eligible int; v_done int; v_forfeit_eligible int;
  v_champ    uuid; v_champ_pts int;
  v_loser    uuid; v_loser_pts int; v_loser_ties int;
  i          int := 0;
begin
  -- Concurrent lazy settles of the same house queue up here.
  perform pg_advisory_xact_lock(hashtext('league_rounds:' || p_house::text));

  loop
    i := i + 1;
    exit when i > 50;

    -- Open round, or open the next one.
    select * into r from league_rounds where house_id = p_house and ended_at is null;
    if not found then
      select max(ended_at) into v_start from league_rounds where house_id = p_house;
      if v_start is null then
        select min(completed_at) - interval '1 microsecond' into v_start
          from cleaning_completions where house_id = p_house and activated_at is not null;
        if v_start is null then return; end if;   -- no real activity yet
      end if;
      insert into league_rounds (house_id, round_no, started_at)
      values (p_house, coalesce((select max(round_no) from league_rounds where house_id = p_house), 0) + 1, v_start)
      returning * into r;
    end if;

    v_deadline := r.started_at + make_interval(days => v_max);

    -- Has every eligible member had N own turns (before the deadline)?
    with own as (
      select cc.scheduled_user_id as uid, cc.completed_at,
             row_number() over (partition by cc.scheduled_user_id order by cc.completed_at, cc.id) as turn_no
        from cleaning_completions cc
       where cc.house_id = p_house and cc.activated_at is not null and cc.scheduled_user_id is not null
         and cc.completed_at > r.started_at and cc.completed_at <= v_deadline
    )
    select count(*), count(nth.completed_at), max(nth.completed_at)
      into v_eligible, v_done, v_end
      from league_eligible_members(p_house, r.started_at) e
      left join own nth on nth.uid = e.user_id and nth.turn_no = v_n;

    if v_eligible >= 2 and v_done = v_eligible then
      v_reason := 'complete';
    elsif now() >= v_deadline then
      v_end := v_deadline;
      v_reason := 'max_length';
      -- A round in which nothing happened is not worth recording: slide its start forward instead.
      if not exists (select 1 from cleaning_completions
                      where house_id = p_house and activated_at is not null
                        and completed_at > r.started_at and completed_at <= v_deadline) then
        update league_rounds set started_at = v_deadline where id = r.id;
        continue;
      end if;
    else
      return;   -- round stays open
    end if;

    -- Champion: highest capped score above zero. Ties: more rescues done, fewer
    -- times rescued, then whoever reached their final score first.
    v_champ := null; v_champ_pts := null; v_loser := null; v_loser_pts := null;
    select s.user_id, s.points into v_champ, v_champ_pts
      from league_round_scores(p_house, r.started_at, v_end, v_n) s
      join profiles p on p.id = s.user_id
     where s.points > 0
     order by s.points desc, s.rescues desc, s.rescued asc, s.last_scored_at asc nulls last, p.name asc
     limit 1;

    -- Loser: lowest score among eligible members who reached N turns, if at least two did.
    -- Ties: rescued more often, fewer own turns, then whoever reached their final
    -- score last. Still identical -> no forfeit this round.
    if v_champ is not null then
      select count(*) into v_forfeit_eligible
        from league_round_scores(p_house, r.started_at, v_end, v_n) s
        join league_eligible_members(p_house, r.started_at) e on e.user_id = s.user_id
       where s.own_turns >= v_n;

      if v_forfeit_eligible >= 2 then
        with cand as (
          select s.user_id, s.points, s.rescued, s.own_turns, s.last_scored_at
            from league_round_scores(p_house, r.started_at, v_end, v_n) s
            join league_eligible_members(p_house, r.started_at) e on e.user_id = s.user_id
           where s.own_turns >= v_n and s.user_id <> v_champ
        ),
        first_pick as (
          select * from cand
           order by points asc, rescued desc, own_turns asc, last_scored_at desc nulls last
           limit 1
        )
        select f.user_id, f.points,
               (select count(*) from cand c
                 where c.points = f.points and c.rescued = f.rescued and c.own_turns = f.own_turns
                   and c.last_scored_at is not distinct from f.last_scored_at)
          into v_loser, v_loser_pts, v_loser_ties
          from first_pick f;
        if coalesce(v_loser_ties, 0) > 1 then v_loser := null; v_loser_pts := null; end if;
      end if;
    end if;

    update league_rounds
       set ended_at = v_end, settle_reason = v_reason, turns_needed = v_n,
           champion_user_id = v_champ, champion_points = coalesce(v_champ_pts, 0),
           loser_user_id = v_loser, loser_points = v_loser_pts,
           forfeit = case when v_loser is not null then house_setting(p_house, 'league_forfeit', 'Buys snacks for the house') end
     where id = r.id;

    if v_champ is not null then
      insert into skip_passes (house_id, user_id, round_id) values (p_house, v_champ, r.id)
      on conflict (house_id, user_id, round_id) do nothing;
      insert into user_achievements (house_id, user_id, achievement_id)
      values (p_house, v_champ, 'monthly_champion')
      on conflict do nothing;
    end if;

    perform log_area_event(p_house, null, 'round_settled',
      jsonb_build_object('round_id', r.id, 'round_no', r.round_no, 'reason', v_reason,
                         'champion_user_id', v_champ, 'loser_user_id', v_loser));
    -- Loop: opens the next round at v_end and checks it too.
  end loop;
end;
$$;

-- Skip Pass target uses the same forfeit ladder, so "last round's lowest scorer"
-- is the person the round would have picked.
create or replace function public.league_skip_target(p_house uuid, p_skipper uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare r league_rounds%rowtype; v_target uuid; v_away boolean;
begin
  select * into r from league_rounds
   where house_id = p_house and ended_at is not null
   order by round_no desc limit 1;
  if not found then return null; end if;

  -- The settled loser when there is one; otherwise recompute from the scores.
  if r.loser_user_id is not null and r.loser_user_id <> p_skipper then
    select hm.away into v_away from house_members hm where hm.house_id = p_house and hm.user_id = r.loser_user_id;
    if found and not v_away then return r.loser_user_id; end if;
  end if;

  select s.user_id, hm.away into v_target, v_away
    from league_round_scores(p_house, r.started_at, r.ended_at,
                             case when r.settle_reason = 'legacy' then 1000000 else coalesce(r.turns_needed, league_turns(p_house)) end) s
    join house_members hm on hm.house_id = p_house and hm.user_id = s.user_id
    join profiles p on p.id = s.user_id
   where s.user_id <> p_skipper
     and (hm.joined_at <= r.started_at or r.settle_reason = 'legacy')
   order by s.points asc, s.rescued desc, s.own_turns asc, s.last_scored_at desc nulls last, p.name asc
   limit 1;

  if v_target is null or v_away then return null; end if;
  return v_target;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Weekly champion: first to reach the top score wins a tie
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
       order by sum(l.points) desc, max(l.created_at) asc, p.name asc
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

-- ---------------------------------------------------------------------------
-- 5. Admin adjustments
-- ---------------------------------------------------------------------------
create or replace function public.admin_adjust_points(p_user_id uuid, p_points int, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house uuid := require_admin();
  v_note  text := btrim(coalesce(p_note, ''));
  v_max   int  := greatest(1, house_setting_int(v_house, 'max_point_adjustment', 50));
  v_admin text := coalesce((select name from profiles where id = auth.uid()), 'An admin');
  v_id    uuid;
begin
  if p_user_id is null or not exists (select 1 from house_members where house_id = v_house and user_id = p_user_id) then
    raise exception 'member_not_found';
  end if;
  if p_points is null or p_points = 0 or abs(p_points) > v_max then
    raise exception 'adjustment_out_of_range' using detail = v_max::text;
  end if;
  if char_length(v_note) not between 3 and 200 then raise exception 'note_required'; end if;

  insert into user_points_ledger (house_id, user_id, cleaning_completion_id, points, reason, note, created_by)
  values (v_house, p_user_id, null, p_points, 'admin_adjustment', v_note, auth.uid())
  returning id into v_id;

  perform log_area_event(v_house, null, 'points_adjusted',
    jsonb_build_object('ledger_id', v_id, 'user_id', p_user_id, 'points', p_points, 'note', v_note));

  -- queue_notification skips the actor themselves and away members.
  perform queue_notification(v_house, p_user_id, 'points_adjusted', null,
    case when p_points > 0 then '⚖️ ' || v_admin || ' gave you ' || p_points || ' points'
         else '⚖️ ' || v_admin || ' took ' || abs(p_points) || ' points' end,
    v_note, '/history');

  return jsonb_build_object('id', v_id, 'user_id', p_user_id, 'points', p_points);
end;
$$;

-- Undo an adjustment — refused once its round is settled (the champion / forfeit were decided from it).
create or replace function public.admin_undo_adjustment(p_ledger_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house uuid := require_admin();
  l user_points_ledger%rowtype;
begin
  select * into l from user_points_ledger
   where id = p_ledger_id and house_id = v_house and reason = 'admin_adjustment';
  if not found then raise exception 'adjustment_not_found'; end if;

  if exists (select 1 from league_rounds lr
              where lr.house_id = v_house and lr.ended_at is not null
                and l.created_at > lr.started_at and l.created_at <= lr.ended_at) then
    raise exception 'round_settled';
  end if;

  delete from user_points_ledger where id = l.id;
  perform log_area_event(v_house, null, 'points_adjustment_undone',
    jsonb_build_object('ledger_id', l.id, 'user_id', l.user_id, 'points', l.points, 'note', l.note));
  return jsonb_build_object('id', l.id, 'user_id', l.user_id, 'points', l.points);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Setting: max_point_adjustment (body as in 0008 plus the new key)
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_probe timestamptz;
begin
  if p_key not in ('timezone', 'week_start_day', 'default_reactivation_cooldown_hours', 'volunteering_enabled',
                   'early_bonus_points', 'streak_bonus_3', 'streak_bonus_5', 'streak_bonus_10', 'public_login_directory', 'house_name',
                   'rescue_penalty_points', 'league_forfeit', 'league_turns_per_round', 'league_max_round_days',
                   'max_point_adjustment') then
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
  if p_key = 'max_point_adjustment' and (p_value !~ '^\d{1,3}$' or p_value::int not between 1 and 500) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'league_turns_per_round' and (p_value !~ '^\d{1,2}$' or p_value::int not between 1 and 20) then
    raise exception 'invalid_value';
  end if;
  if p_key = 'league_max_round_days' and (p_value !~ '^\d{1,3}$' or p_value::int not between 7 and 365) then
    raise exception 'invalid_value';
  end if;
  if p_key in ('volunteering_enabled', 'public_login_directory') and p_value not in ('true', 'false') then
    raise exception 'invalid_value';
  end if;
  if p_key = 'league_forfeit' and char_length(trim(p_value)) not between 1 and 120 then
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
-- 7. Grants (create or replace keeps the existing ACL; only the dropped and
--    the new functions need theirs set)
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('league_round_scores', 'admin_adjust_points', 'admin_undo_adjustment')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
