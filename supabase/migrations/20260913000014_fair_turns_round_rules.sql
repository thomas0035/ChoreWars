-- ============================================================================
-- Fair turns + round rule changes (lessons from the first full round).
--
-- 1. Fair turns. Areas no longer hand the turn down a fixed list. When an area
--    is flagged, the turn goes to the person, among those who clean that area
--    and are not away, who
--      a. has no other open task (unless everyone has one),
--      b. has had the fewest turns this round, counted across ALL areas
--         (open tasks and used Skip Passes count as turns),
--      c. has waited longest since their last turn,
--      d. comes first in the area's list.
--    cleaning_rotation_members now means "who cleans this area"; its order is
--    only the last tie-break. On a passive area current_scheduled_user_id is a
--    preview ("likely next"), refreshed whenever any area changes. An admin's
--    manual choice is pinned until that area is next cleaned or cleared.
--
-- 2. Rounds: 2 turns each and a 60-day backstop by default (was 3 / 45).
--
-- 3. Forfeit: every eligible member (not away, in the house when the round
--    started, cleans at least one area) can take it, whether or not they had
--    all their turns. Before, a timed-out round only considered people who HAD
--    done all their turns, which punished exactly them.
--    Tie-break "fewer turns" now uses counted turns (capped at N).
--
-- 4. get_round_standings: everyone's final score and turns for a settled round.
--
-- 5. The "you're up next" push is gone: next is now a best guess, not a promise.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fair pick
-- ---------------------------------------------------------------------------
alter table public.cleaning_area_state
  add column if not exists scheduled_pinned boolean not null default false;

create or replace function public.fair_pick_cleaner(p_area uuid, p_exclude uuid default null)
returns uuid language sql stable security definer set search_path = public as $$
  with a as (
    select house_id from cleaning_areas where id = p_area
  ),
  rs as (   -- start of the open round, else end of the last one
    select coalesce(
             (select lr.started_at from league_rounds lr, a where lr.house_id = a.house_id and lr.ended_at is null),
             (select max(lr.ended_at) from league_rounds lr, a where lr.house_id = a.house_id),
             '-infinity'::timestamptz) as t
  ),
  cand as (
    select rm.user_id, rm.position,
           (select count(*) from cleaning_area_state s
              join cleaning_areas ca on ca.id = s.cleaning_area_id and ca.active
             where s.house_id = rm.house_id and s.activation_state <> 'passive'
               and s.current_scheduled_user_id = rm.user_id and s.cleaning_area_id <> p_area) as open_tasks,
           (select count(*) from cleaning_completions cc, rs
             where cc.house_id = rm.house_id and cc.scheduled_user_id = rm.user_id
               and cc.activated_at is not null and cc.completed_at > rs.t) as turns,
           (select count(*) from skip_passes sp, rs
             where sp.house_id = rm.house_id and sp.user_id = rm.user_id and sp.used_at > rs.t) as skips,
           (select max(cc.completed_at) from cleaning_completions cc
             where cc.house_id = rm.house_id and cc.scheduled_user_id = rm.user_id
               and cc.activated_at is not null) as last_turn
      from cleaning_rotation_members rm
      join house_members hm on hm.house_id = rm.house_id and hm.user_id = rm.user_id
     where rm.cleaning_area_id = p_area
       and not hm.away
       and rm.user_id is distinct from p_exclude
  )
  select user_id from cand
   order by (open_tasks > 0), turns + skips + open_tasks, last_turn asc nulls first, position
   limit 1;
$$;

-- Hand-offs (Skip Pass fallback, going away, member removed, after a clean):
-- the fairest other person. Same fallbacks as before when nobody else is available.
create or replace function public.next_rotation_user(p_area uuid, p_current uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_next uuid;
begin
  v_next := fair_pick_cleaner(p_area, p_current);
  if v_next is not null then return v_next; end if;

  if exists (select 1 from cleaning_rotation_members where cleaning_area_id = p_area and user_id = p_current) then
    return p_current;
  end if;
  select user_id into v_next from cleaning_rotation_members where cleaning_area_id = p_area order by position limit 1;
  return v_next;
end;
$$;

-- Flagging decides who cleans (body otherwise as in 0008).
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

  -- An admin's manual choice stands if that person can still take it.
  if v_state.scheduled_pinned and v_state.current_scheduled_user_id is not null
     and exists (select 1 from cleaning_rotation_members
                  where cleaning_area_id = p_area_id and user_id = v_state.current_scheduled_user_id)
     and not is_away(v_area.house_id, v_state.current_scheduled_user_id) then
    v_scheduled := v_state.current_scheduled_user_id;
  end if;
  if v_scheduled is null then
    v_scheduled := fair_pick_cleaner(p_area_id, null);
  end if;
  if v_scheduled is null then   -- everyone on this area is away
    select user_id into v_scheduled from cleaning_rotation_members where cleaning_area_id = p_area_id order by position limit 1;
  end if;
  if v_scheduled is null then raise exception 'no_rotation'; end if;

  update cleaning_area_state
     set activation_state = 'active', activated_at = now(), activated_by_user_id = v_uid,
         current_scheduled_user_id = v_scheduled, skip_from_user_id = null, updated_at = now()
   where cleaning_area_id = p_area_id;

  perform log_area_event(v_area.house_id, p_area_id, 'activated', jsonb_build_object('scheduled_user_id', v_scheduled));

  return jsonb_build_object(
    'area_id', p_area_id, 'area_name', v_area.name, 'area_icon', v_area.icon,
    'scheduled_user_id', v_scheduled,
    'scheduled_user_name', (select name from profiles where id = v_scheduled)
  );
end;
$$;

-- Admin's manual choice is pinned (body otherwise as in 0002).
create or replace function public.admin_set_scheduled_user(p_area_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin();
begin
  if not exists (select 1 from cleaning_areas where id = p_area_id and house_id = v_house) then raise exception 'area_not_found'; end if;
  if not exists (select 1 from cleaning_rotation_members where cleaning_area_id = p_area_id and user_id = p_user_id) then raise exception 'not_in_rotation'; end if;
  update cleaning_area_state
     set current_scheduled_user_id = p_user_id,
         scheduled_pinned = true,
         volunteer_user_id = case when volunteer_user_id = p_user_id then null else volunteer_user_id end,
         volunteer_claimed_at = case when volunteer_user_id = p_user_id then null else volunteer_claimed_at end,
         activation_state = case when activation_state = 'volunteer_claimed' and volunteer_user_id = p_user_id then 'active' else activation_state end,
         updated_at = now()
   where cleaning_area_id = p_area_id;
  perform log_area_event(v_house, p_area_id, 'admin_scheduled_set', jsonb_build_object('user_id', p_user_id));
end;
$$;

-- The pin lasts until the area is next cleaned (or its flag is cleared).
create or replace function public.clear_scheduled_pin_on_passive()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.activation_state <> 'passive' and new.activation_state = 'passive' then
    new.scheduled_pinned := false;
  end if;
  return new;
end;
$$;
drop trigger if exists area_state_clear_pin on public.cleaning_area_state;
create trigger area_state_clear_pin
  before update on public.cleaning_area_state
  for each row execute function public.clear_scheduled_pin_on_passive();

-- "Likely next" on every other unflagged area, recomputed after any change.
create or replace function public.refresh_turn_previews(p_house uuid, p_skip_area uuid default null)
returns void language sql security definer set search_path = public as $$
  update cleaning_area_state s
     set current_scheduled_user_id = n.pick, updated_at = now()
    from (select s2.cleaning_area_id, fair_pick_cleaner(s2.cleaning_area_id, null) as pick
            from cleaning_area_state s2
            join cleaning_areas a on a.id = s2.cleaning_area_id and a.active
           where s2.house_id = p_house
             and s2.activation_state = 'passive'
             and not s2.scheduled_pinned
             and s2.cleaning_area_id is distinct from p_skip_area) n
   where s.cleaning_area_id = n.cleaning_area_id
     and n.pick is not null
     and s.current_scheduled_user_id is distinct from n.pick;
$$;

create or replace function public.refresh_turn_previews_trg()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform refresh_turn_previews(new.house_id, new.cleaning_area_id);
  return null;
exception when others then
  raise notice 'refresh_turn_previews skipped: %', sqlerrm;
  return null;
end;
$$;
drop trigger if exists area_state_refresh_previews on public.cleaning_area_state;
-- depth 0 = not fired by the refresh's own updates.
create trigger area_state_refresh_previews
  after update on public.cleaning_area_state
  for each row when (pg_trigger_depth() = 0)
  execute function public.refresh_turn_previews_trg();

-- Notifications: as in 0009 without the "you're up next" push.
create or replace function public.notify_area_state_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_area cleaning_areas%rowtype;
  v_actor text := (select name from profiles where id = auth.uid());
  v_label text;
  v_url text;
begin
  select * into v_area from cleaning_areas where id = new.cleaning_area_id;
  if not found or not v_area.active then return null; end if;
  v_label := v_area.icon || ' ' || v_area.name;
  v_url := '/areas/' || v_area.id;

  -- Flagged: passive -> active.
  if old.activation_state = 'passive' and new.activation_state = 'active' then
    perform queue_notification(new.house_id, new.current_scheduled_user_id, 'flagged', v_area.id,
      v_label || ' needs cleaning',
      coalesce(v_actor || ' flagged it. ', '') || 'It''s your turn.', v_url);

  -- Reassigned while flagged.
  elsif old.activation_state <> 'passive' and new.activation_state <> 'passive'
        and new.current_scheduled_user_id is distinct from old.current_scheduled_user_id then
    perform queue_notification(new.house_id, new.current_scheduled_user_id, 'reassigned', v_area.id,
      v_label || ' is now your turn',
      case when new.skip_from_user_id is not null
           then coalesce((select name from profiles where id = new.skip_from_user_id), 'Someone') || ' used a Skip Pass on it.'
           else 'It was handed over to you. It''s flagged as needing cleaning.' end,
      v_url);

  -- Volunteer claimed your turn.
  elsif old.activation_state = 'active' and new.activation_state = 'volunteer_claimed' then
    perform queue_notification(new.house_id, new.current_scheduled_user_id, 'rescued', v_area.id,
      '🦸 ' || coalesce((select name from profiles where id = new.volunteer_user_id), 'Someone') || ' is rescuing the ' || v_area.name,
      'They volunteered to take your turn.', v_url);
  end if;

  return null;
exception when others then
  raise notice 'notify_area_state_change skipped: %', sqlerrm;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Round length defaults: 2 turns, 60-day backstop
-- ---------------------------------------------------------------------------
create or replace function public.league_turns(p_house uuid)
returns int language sql stable security definer set search_path = public as $$
  select least(20, greatest(1, house_setting_int(p_house, 'league_turns_per_round', 2)));
$$;

create or replace function public.league_max_days(p_house uuid)
returns int language sql stable security definer set search_path = public as $$
  select least(365, greatest(7, house_setting_int(p_house, 'league_max_round_days', 60)));
$$;

-- Houses still on the old defaults move to the new ones (applies to the open round too).
update public.house_settings set value = '2'  where key = 'league_turns_per_round' and value = '3';
update public.house_settings set value = '60' where key = 'league_max_round_days'  and value = '45';

-- ---------------------------------------------------------------------------
-- 3. Settlement: forfeit among all eligible members (body otherwise as in 0011)
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

    -- Loser: lowest score among ALL eligible members (not the champion), if there
    -- are at least two eligible. Having fewer turns no longer protects anyone.
    -- Ties: rescued more often, fewer counted turns, then whoever reached their
    -- final score last. Still identical -> no forfeit this round.
    if v_champ is not null then
      select count(*) into v_forfeit_eligible from league_eligible_members(p_house, r.started_at);

      if v_forfeit_eligible >= 2 then
        with cand as (
          select s.user_id, s.points, s.rescued, least(s.own_turns, v_n) as turns, s.last_scored_at
            from league_round_scores(p_house, r.started_at, v_end, v_n) s
            join league_eligible_members(p_house, r.started_at) e on e.user_id = s.user_id
           where s.user_id <> v_champ
        ),
        first_pick as (
          select * from cand
           order by points asc, rescued desc, turns asc, last_scored_at desc nulls last
           limit 1
        )
        select f.user_id, f.points,
               (select count(*) from cand c
                 where c.points = f.points and c.rescued = f.rescued and c.turns = f.turns
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

-- ---------------------------------------------------------------------------
-- 4. Final table of a settled round, for everyone in the house
-- ---------------------------------------------------------------------------
create or replace function public.get_round_standings(p_round_id uuid)
returns table (user_id uuid, name text, avatar_url text, points int, own_turns int, turns_needed int,
               rescues int, rescued int, is_champion boolean, is_loser boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  v_house uuid := current_house_id();
  r league_rounds%rowtype;
  v_n int;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  select * into r from league_rounds lr where lr.id = p_round_id and lr.house_id = v_house and lr.ended_at is not null;
  if not found then raise exception 'result_not_found'; end if;
  -- Legacy months were decided without the turn cap.
  v_n := case when r.settle_reason = 'legacy' then null else coalesce(r.turns_needed, league_turns(v_house)) end;

  return query
    select s.user_id, p.name, p.avatar_url, s.points, s.own_turns, v_n, s.rescues, s.rescued,
           coalesce(s.user_id = r.champion_user_id, false),
           coalesce(s.user_id = r.loser_user_id, false)
      from league_round_scores(v_house, r.started_at, r.ended_at, coalesce(v_n, 1000000)) s
      join profiles p on p.id = s.user_id
     order by s.points desc, p.name asc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_round_standings'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('fair_pick_cleaner', 'refresh_turn_previews',
                                                 'refresh_turn_previews_trg', 'clear_scheduled_pin_on_passive')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Bring every unflagged area's "likely next" in line with the new rule now
-- ---------------------------------------------------------------------------
do $$
declare h record;
begin
  for h in select id from public.houses loop
    perform public.refresh_turn_previews(h.id, null);
  end loop;
end $$;
