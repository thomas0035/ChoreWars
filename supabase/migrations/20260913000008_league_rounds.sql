-- ============================================================================
-- League rounds replace the calendar-month league.
--
-- Why: turns only exist when an area is flagged, so in a calendar month one
-- member can get three turns and another none. Ranking raw monthly totals
-- punished people for having fewer chances, not for doing less.
--
-- Rules:
-- 1. A round ends once every eligible member has had N own turns resolved
--    (N = setting `league_turns_per_round`, default 3). An own turn is a real
--    completion of an area where you were the scheduled person, done by you or
--    rescued by someone else. Eligible = current member, not away, in at least
--    one active rotation, and in the house when the round started.
-- 2. Safety cap: `league_max_round_days` (default 45). At the cap the round
--    settles anyway.
-- 3. Round score = ledger points in the round, but only your first N own turns
--    count for you (points, bonuses and rescue penalties). Rescues you do for
--    others always count in full.
-- 4. Champion = highest score > 0: Skip Pass + achievement.
--    Loser = lowest score among eligible members who reached N turns, only if
--    at least two did: takes the forfeit (setting `league_forfeit`).
-- 5. Skip Pass: the turn goes to last round's lowest scorer (if they are not
--    away), else to the next in rotation. A turn received from a Skip Pass
--    counts as the receiver's own turn, cannot be skipped again, and once it is
--    done the rotation resumes from the skipper's position.
--
-- Settled round windows are (started_at, ended_at]. A complete round ends at
-- the instant of the last eligible member's Nth turn; the next round starts
-- at that same instant.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Settle every finished calendar month under the old rules, so the cutover
--    is clean: past months become legacy rounds, the first real round starts
--    at the beginning of the current month.
-- ---------------------------------------------------------------------------
do $$
declare h record;
begin
  for h in select id from public.houses loop
    perform public.award_monthly_results(h.id);
  end loop;
end $$;

drop function if exists public.award_monthly_results(uuid);
drop function if exists public.get_monthly_results(int);
drop function if exists public.get_leaderboard(text);   -- return table gains columns

-- ---------------------------------------------------------------------------
-- 1. monthly_results -> league_rounds
-- ---------------------------------------------------------------------------
alter table public.monthly_results rename to league_rounds;
alter index if exists public.monthly_results_pkey rename to league_rounds_pkey;
alter table public.league_rounds rename column month_start to started_at;
alter table public.league_rounds
  add column round_no      int,
  add column ended_at      timestamptz,
  add column settle_reason text,
  add column turns_needed  int;   -- N in force when settled; null for legacy months

with n as (
  select id, row_number() over (partition by house_id order by started_at) as rn from public.league_rounds
)
update public.league_rounds r
   set round_no      = n.rn,
       ended_at      = public.house_month_start(r.house_id, r.started_at + interval '45 days'),
       settle_reason = 'legacy'
  from n
 where n.id = r.id;

alter table public.league_rounds alter column round_no set not null;

-- Drop the old unique (house_id, month_start) whatever it ended up being called.
do $$
declare c record;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.league_rounds'::regclass and con.contype = 'u'
  loop
    execute format('alter table public.league_rounds drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.league_rounds add constraint league_rounds_house_round_key unique (house_id, round_no);
alter table public.league_rounds add constraint league_rounds_settle_reason_check
  check (settle_reason is null or settle_reason in ('complete', 'max_length', 'legacy'));
alter table public.league_rounds add constraint league_rounds_closed_check
  check ((ended_at is null) = (settle_reason is null));
create unique index league_rounds_one_open_idx on public.league_rounds (house_id) where ended_at is null;

alter policy "monthly_results: read" on public.league_rounds rename to "league_rounds: read";

-- RLS, replica identity and publication membership follow the table through the rename.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'league_rounds') then
    alter publication supabase_realtime add table public.league_rounds;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. skip_passes.month_start -> round_id
-- ---------------------------------------------------------------------------
alter table public.skip_passes add column round_id uuid references public.league_rounds (id) on delete cascade;
update public.skip_passes sp
   set round_id = r.id
  from public.league_rounds r
 where r.house_id = sp.house_id and r.started_at = sp.month_start;
alter table public.skip_passes drop column month_start;   -- also drops the old unique constraint
alter table public.skip_passes add constraint skip_passes_house_user_round_key unique (house_id, user_id, round_id);

-- ---------------------------------------------------------------------------
-- 3. Skip Pass origin on the area state.
--    skip_from_user_id = the skipper whose rotation position the area resumes
--    from once the passed-on turn is done. Null when the turn was not skipped.
-- ---------------------------------------------------------------------------
alter table public.cleaning_area_state
  add column skip_from_user_id uuid references public.profiles (id) on delete set null;

-- Any other change of the scheduled person (admin edits, away hand-offs, member
-- removal) turns the turn back into an ordinary rotation turn.
create or replace function public.clear_skip_origin_on_reassign()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.current_scheduled_user_id is distinct from old.current_scheduled_user_id
     and new.skip_from_user_id is not distinct from old.skip_from_user_id then
    new.skip_from_user_id := null;
  end if;
  return new;
end;
$$;
drop trigger if exists area_state_clear_skip_origin on public.cleaning_area_state;
create trigger area_state_clear_skip_origin
  before update on public.cleaning_area_state
  for each row execute function public.clear_skip_origin_on_reassign();

-- ---------------------------------------------------------------------------
-- 4. Settings and achievement text
-- ---------------------------------------------------------------------------
-- Known keys added here:
--   league_turns_per_round (1..20, default 3)
--   league_max_round_days  (7..365, default 45)
--   league_forfeit         (text, replaces monthly_forfeit)
update public.house_settings set key = 'league_forfeit' where key = 'monthly_forfeit';
update public.achievements
   set name = 'League Champion', description = 'Finish #1 in a league round.'
 where id = 'monthly_champion';

create or replace function public.league_turns(p_house uuid)
returns int language sql stable security definer set search_path = public as $$
  select least(20, greatest(1, house_setting_int(p_house, 'league_turns_per_round', 3)));
$$;

create or replace function public.league_max_days(p_house uuid)
returns int language sql stable security definer set search_path = public as $$
  select least(365, greatest(7, house_setting_int(p_house, 'league_max_round_days', 45)));
$$;

-- ---------------------------------------------------------------------------
-- 5. Scoring
-- ---------------------------------------------------------------------------

-- Members a round waits for (and who can take its forfeit).
create or replace function public.league_eligible_members(p_house uuid, p_start timestamptz)
returns table (user_id uuid)
language sql stable security definer set search_path = public as $$
  select hm.user_id
    from house_members hm
   where hm.house_id = p_house
     and not hm.away
     and hm.joined_at <= p_start
     and exists (select 1 from cleaning_rotation_members rm
                   join cleaning_areas a on a.id = rm.cleaning_area_id and a.active
                  where rm.house_id = p_house and rm.user_id = hm.user_id);
$$;

-- One row per current member for the window (p_start, p_end]; p_end null = open round.
--   points          capped round score (own turns beyond p_turns don't count)
--   own_turns       real completions where the member was the scheduled person
--   rescues         rescues the member did for others
--   rescued         counted rescue penalties against the member
--   penalty_points  counted negative points (positive number)
create or replace function public.league_round_scores(p_house uuid, p_start timestamptz, p_end timestamptz, p_turns int)
returns table (user_id uuid, points int, own_turns int, rescues int, rescued int, penalty_points int)
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
    select l.user_id as uid, l.points as pts, l.reason
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
         coalesce((select -sum(led.pts) from led where led.uid = hm.user_id and led.pts < 0), 0)::int
    from house_members hm
   where hm.house_id = p_house;
$$;

-- ---------------------------------------------------------------------------
-- 6. Settlement — idempotent; safe from cron AND lazily on read.
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
  v_loser    uuid; v_loser_pts int;
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

    -- Champion: highest capped score above zero.
    v_champ := null; v_champ_pts := null; v_loser := null; v_loser_pts := null;
    select s.user_id, s.points into v_champ, v_champ_pts
      from league_round_scores(p_house, r.started_at, v_end, v_n) s
      join profiles p on p.id = s.user_id
     where s.points > 0
     order by s.points desc, s.rescues desc, p.name asc
     limit 1;

    -- Loser: lowest score among eligible members who reached N turns, if at least two did.
    if v_champ is not null then
      select count(*) into v_forfeit_eligible
        from league_round_scores(p_house, r.started_at, v_end, v_n) s
        join league_eligible_members(p_house, r.started_at) e on e.user_id = s.user_id
       where s.own_turns >= v_n;

      if v_forfeit_eligible >= 2 then
        select s.user_id, s.points into v_loser, v_loser_pts
          from league_round_scores(p_house, r.started_at, v_end, v_n) s
          join league_eligible_members(p_house, r.started_at) e on e.user_id = s.user_id
          join profiles p on p.id = s.user_id
         where s.own_turns >= v_n and s.user_id <> v_champ
         order by s.points asc, s.rescued desc, p.name asc
         limit 1;
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

-- Hourly cron entry point (name kept so the pg_cron job from 0003 keeps working).
create or replace function public.award_all_weekly_champions()
returns void language plpgsql security definer set search_path = public as $$
declare h record;
begin
  for h in select id from houses loop
    perform award_weekly_champions(h.id);
    perform settle_league_rounds(h.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Reads
-- ---------------------------------------------------------------------------

-- The open round with everyone's progress, or null before the first clean.
create or replace function public.get_league_round()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house uuid := current_house_id();
  r league_rounds%rowtype;
  v_n int; v_max int;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  perform settle_league_rounds(v_house);
  select * into r from league_rounds where house_id = v_house and ended_at is null;
  if not found then return null; end if;
  v_n := league_turns(v_house);
  v_max := league_max_days(v_house);

  return jsonb_build_object(
    'round_id', r.id,
    'round_no', r.round_no,
    'started_at', r.started_at,
    'settles_by', r.started_at + make_interval(days => v_max),
    'turns_needed', v_n,
    'max_days', v_max,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', s.user_id, 'name', p.name, 'avatar_url', p.avatar_url,
               'own_turns', s.own_turns, 'round_points', s.points,
               'eligible', e.user_id is not null, 'away', hm.away)
             order by s.points desc, p.name asc)
        from league_round_scores(v_house, r.started_at, null, v_n) s
        join profiles p on p.id = s.user_id
        join house_members hm on hm.house_id = v_house and hm.user_id = s.user_id
        left join league_eligible_members(v_house, r.started_at) e on e.user_id = s.user_id
    ), '[]'::jsonb)
  );
end;
$$;

-- p_period: 'round' (capped score of the open round) | 'week' | 'all'.
create or replace function public.get_leaderboard(p_period text default 'round')
returns table (user_id uuid, name text, avatar_url text, points bigint, rank int, current_streak int, own_turns int, turns_needed int)
language plpgsql security definer set search_path = public as $$
declare v_house uuid := current_house_id(); v_from timestamptz; v_n int; v_start timestamptz;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  perform award_weekly_champions(v_house);
  perform settle_league_rounds(v_house);

  if p_period = 'round' then
    v_n := league_turns(v_house);
    select lr.started_at into v_start from league_rounds lr where lr.house_id = v_house and lr.ended_at is null;
    return query
      select p.id, p.name, p.avatar_url,
             s.points::bigint,
             (rank() over (order by s.points desc))::int,
             coalesce(us.current_streak, 0)::int,
             s.own_turns,
             v_n
        from league_round_scores(v_house, coalesce(v_start, now()), null, v_n) s
        join profiles p on p.id = s.user_id
        left join user_streaks us on us.house_id = v_house and us.user_id = s.user_id
       order by s.points desc, p.name asc;
    return;
  end if;

  if p_period not in ('week', 'all') then raise exception 'invalid_value'; end if;
  v_from := case p_period when 'week' then house_week_start(v_house) else '-infinity'::timestamptz end;
  return query
    select p.id, p.name, p.avatar_url,
           coalesce(sum(l.points), 0)::bigint as pts,
           (rank() over (order by coalesce(sum(l.points), 0) desc))::int as rnk,
           coalesce(max(st.current_streak), 0)::int as streak,
           null::int, null::int
      from house_members hm
      join profiles p on p.id = hm.user_id
      left join user_points_ledger l on l.user_id = p.id and l.house_id = v_house and l.created_at >= v_from
      left join user_streaks st on st.user_id = p.id and st.house_id = v_house
     where hm.house_id = v_house
     group by p.id, p.name, p.avatar_url
     order by pts desc, p.name asc;
end;
$$;

-- Settled rounds, newest first. The first row is "last round".
create or replace function public.get_league_rounds(p_limit int default 12)
returns table (
  id uuid, round_no int, started_at timestamptz, ended_at timestamptz, settle_reason text,
  champion_user_id uuid, champion_name text, champion_avatar_url text, champion_points int,
  loser_user_id uuid, loser_name text, loser_avatar_url text, loser_points int,
  forfeit text, forfeit_done_at timestamptz, forfeit_done_by_name text
)
language plpgsql security definer set search_path = public as $$
declare v_house uuid := current_house_id();
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  perform settle_league_rounds(v_house);
  return query
    select r.id, r.round_no, r.started_at, r.ended_at, r.settle_reason,
           r.champion_user_id, cp.name, cp.avatar_url, r.champion_points,
           r.loser_user_id, lp.name, lp.avatar_url, r.loser_points,
           r.forfeit, r.forfeit_done_at, dp.name
      from league_rounds r
      left join profiles cp on cp.id = r.champion_user_id
      left join profiles lp on lp.id = r.loser_user_id
      left join profiles dp on dp.id = r.forfeit_done_by
     where r.house_id = v_house and r.ended_at is not null
     order by r.round_no desc
     limit p_limit;
end;
$$;

create or replace function public.get_user_stats(p_user_id uuid default auth.uid())
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house uuid := current_house_id();
  v_week_start timestamptz;
  v_n int;
  r league_rounds%rowtype;
  v_pts int := 0; v_turns int := 0; v_pen int := 0;
  v_result jsonb;
begin
  if v_house is null then raise exception 'not_a_member'; end if;
  if not shares_house_with(p_user_id) then raise exception 'not_authorized'; end if;
  perform award_weekly_champions(v_house);
  perform settle_league_rounds(v_house);
  v_week_start := house_week_start(v_house);
  v_n := league_turns(v_house);

  select * into r from league_rounds where house_id = v_house and ended_at is null;
  if found then
    select s.points, s.own_turns, s.penalty_points into v_pts, v_turns, v_pen
      from league_round_scores(v_house, r.started_at, null, v_n) s
     where s.user_id = p_user_id;
  end if;

  select jsonb_build_object(
    'user_id', p_user_id,
    'weekly_points',  coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id and created_at >= v_week_start), 0),
    'round_points',   coalesce(v_pts, 0),
    'total_points',   coalesce((select sum(points) from user_points_ledger where house_id = v_house and user_id = p_user_id), 0),
    'penalty_points', coalesce(v_pen, 0),
    'weekly_rank',    (select lb.rank from get_leaderboard('week') lb where lb.user_id = p_user_id),
    'round_rank',     (select lb.rank from get_leaderboard('round') lb where lb.user_id = p_user_id),
    'round_turns',    coalesce(v_turns, 0),
    'round_turns_needed', v_n,
    'round_no',       r.round_no,
    'round_started_at', r.started_at,
    'member_count',   (select count(*) from house_members where house_id = v_house),
    'current_streak', coalesce((select current_streak from user_streaks where house_id = v_house and user_id = p_user_id), 0),
    'longest_streak', coalesce((select longest_streak from user_streaks where house_id = v_house and user_id = p_user_id), 0),
    'normal_completions', (select count(*) from cleaning_completions where house_id = v_house and completed_by_user_id = p_user_id and completion_type = 'normal'),
    'rescues',        (select count(*) from cleaning_completions where house_id = v_house and completed_by_user_id = p_user_id and completion_type = 'volunteer'),
    'weekly_wins',    (select count(*) from weekly_champions where house_id = v_house and user_id = p_user_id),
    'round_wins',     (select count(*) from league_rounds where house_id = v_house and champion_user_id = p_user_id and ended_at is not null),
    'skip_passes',    (select count(*) from skip_passes where house_id = v_house and user_id = p_user_id and used_at is null),
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

-- ---------------------------------------------------------------------------
-- 8. Writes
-- ---------------------------------------------------------------------------

-- The loser themselves or an admin can tick a round's forfeit off (or un-tick it).
create or replace function public.mark_forfeit_done(p_result_id uuid, p_done boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); r league_rounds%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into r from league_rounds where id = p_result_id;
  if not found then raise exception 'result_not_found'; end if;
  if not is_house_member(r.house_id) then raise exception 'not_a_member'; end if;
  if r.ended_at is null then raise exception 'round_open'; end if;
  if v_uid is distinct from r.loser_user_id and not is_house_admin(r.house_id) then raise exception 'not_authorized'; end if;

  update league_rounds
     set forfeit_done_at = case when p_done then now() end,
         forfeit_done_by = case when p_done then v_uid end
   where id = p_result_id;
  perform log_area_event(r.house_id, null, 'forfeit_marked', jsonb_build_object('result_id', p_result_id, 'done', p_done));
  return jsonb_build_object('id', p_result_id, 'done', p_done);
end;
$$;

-- Undo the most recent completion of an area — refused once its round is settled,
-- because the stored champion / forfeit / Skip Pass were decided from it.
create or replace function public.admin_undo_completion(p_completion_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house uuid := require_admin();
  c cleaning_completions%rowtype;
  v_state cleaning_area_state%rowtype;
  v_latest uuid;
  v_prev timestamptz;
begin
  select * into c from cleaning_completions where id = p_completion_id and house_id = v_house;
  if not found then raise exception 'completion_not_found'; end if;

  select id into v_latest from cleaning_completions
   where cleaning_area_id = c.cleaning_area_id order by completed_at desc, id desc limit 1;
  if v_latest <> c.id then raise exception 'not_latest_completion'; end if;

  if exists (select 1 from league_rounds lr
              where lr.house_id = v_house and lr.ended_at is not null
                and c.completed_at > lr.started_at and c.completed_at <= lr.ended_at) then
    raise exception 'round_settled';
  end if;

  select * into v_state from cleaning_area_state where cleaning_area_id = c.cleaning_area_id for update;
  if found and v_state.activation_state <> 'passive' then raise exception 'area_active'; end if;

  delete from user_points_ledger where cleaning_completion_id = c.id;
  delete from cleaning_completions where id = c.id;

  select max(completed_at) into v_prev from cleaning_completions where cleaning_area_id = c.cleaning_area_id;

  update cleaning_area_state
     set last_cleaned_at = v_prev,
         current_scheduled_user_id = case
           when c.scheduled_user_id is not null and exists (
             select 1 from cleaning_rotation_members where cleaning_area_id = c.cleaning_area_id and user_id = c.scheduled_user_id)
           then c.scheduled_user_id else current_scheduled_user_id end,
         updated_at = now()
   where cleaning_area_id = c.cleaning_area_id;

  if c.completed_by_user_id is not null then perform recompute_streak(v_house, c.completed_by_user_id); end if;
  if c.scheduled_user_id is not null and c.scheduled_user_id is distinct from c.completed_by_user_id then
    perform recompute_streak(v_house, c.scheduled_user_id);
  end if;

  perform log_area_event(v_house, c.cleaning_area_id, 'admin_completion_undone', to_jsonb(c));
  return jsonb_build_object('area_id', c.cleaning_area_id, 'scheduled_user_id', c.scheduled_user_id);
end;
$$;

-- Reset also clears league rounds and passes, then opens a fresh round 1 now
-- (otherwise 'scores' mode would replay the kept completions into new rounds).
create or replace function public.admin_reset_house(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin();
begin
  if p_mode not in ('scores', 'everything') then raise exception 'invalid_value'; end if;

  delete from user_points_ledger where house_id = v_house;
  delete from weekly_champions where house_id = v_house;
  delete from skip_passes where house_id = v_house;
  delete from league_rounds where house_id = v_house;
  delete from user_achievements where house_id = v_house;
  update user_streaks set current_streak = 0, longest_streak = 0, updated_at = now() where house_id = v_house;

  if p_mode = 'scores' then
    update cleaning_completions set points_awarded = 0 where house_id = v_house;
  else
    delete from cleaning_completions where house_id = v_house;
    delete from area_events where house_id = v_house;
    update cleaning_area_state s
       set activation_state = 'passive', last_cleaned_at = null, activated_at = null, activated_by_user_id = null,
           volunteer_user_id = null, volunteer_claimed_at = null, skip_from_user_id = null,
           current_scheduled_user_id = (select m.user_id from cleaning_rotation_members m
                                         where m.cleaning_area_id = s.cleaning_area_id order by m.position limit 1),
           updated_at = now()
     where s.house_id = v_house;
  end if;

  insert into league_rounds (house_id, round_no, started_at) values (v_house, 1, now());
  perform log_area_event(v_house, null, 'admin_reset', jsonb_build_object('mode', p_mode));
end;
$$;

create or replace function public.admin_set_setting(p_key text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_probe timestamptz;
begin
  if p_key not in ('timezone', 'week_start_day', 'default_reactivation_cooldown_hours', 'volunteering_enabled',
                   'early_bonus_points', 'streak_bonus_3', 'streak_bonus_5', 'streak_bonus_10', 'public_login_directory', 'house_name',
                   'rescue_penalty_points', 'league_forfeit', 'league_turns_per_round', 'league_max_round_days') then
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
-- 9. Skip Pass: hand the turn to last round's lowest scorer.
-- ---------------------------------------------------------------------------

-- Last settled round's lowest scorer other than the skipper, or null when there is
-- no settled round yet or that person is away (the caller then uses the rotation).
-- Legacy months are scored without the turn cap, matching how they were decided.
create or replace function public.league_skip_target(p_house uuid, p_skipper uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare r league_rounds%rowtype; v_target uuid; v_away boolean;
begin
  select * into r from league_rounds
   where house_id = p_house and ended_at is not null
   order by round_no desc limit 1;
  if not found then return null; end if;

  select s.user_id, hm.away into v_target, v_away
    from league_round_scores(p_house, r.started_at, r.ended_at,
                             case when r.settle_reason = 'legacy' then 1000000 else coalesce(r.turns_needed, league_turns(p_house)) end) s
    join house_members hm on hm.house_id = p_house and hm.user_id = s.user_id
    join profiles p on p.id = s.user_id
   where s.user_id <> p_skipper
     and (hm.joined_at <= r.started_at or r.settle_reason = 'legacy')
   order by s.points asc, s.rescued desc, p.name asc
   limit 1;

  if v_target is null or v_away then return null; end if;
  return v_target;
end;
$$;

create or replace function public.use_skip_pass(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
  v_pass uuid; v_next uuid; v_reason text;
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
  if v_state.skip_from_user_id is not null then raise exception 'turn_not_skippable'; end if;

  select id into v_pass from skip_passes
   where house_id = v_area.house_id and user_id = v_uid and used_at is null
   order by granted_at limit 1 for update;
  if v_pass is null then raise exception 'no_skip_pass'; end if;

  v_next := league_skip_target(v_area.house_id, v_uid);
  if v_next is not null then
    v_reason := 'lowest_last_round';
    -- Remember the skipper so the rotation resumes from their position afterwards.
    update cleaning_area_state
       set current_scheduled_user_id = v_next, skip_from_user_id = v_uid, updated_at = now()
     where cleaning_area_id = p_area_id;
  else
    v_reason := 'rotation';
    v_next := next_rotation_user(p_area_id, v_uid);
    if v_next is null or v_next = v_uid then raise exception 'no_one_to_skip_to'; end if;
    update cleaning_area_state set current_scheduled_user_id = v_next, updated_at = now() where cleaning_area_id = p_area_id;
  end if;

  update skip_passes set used_at = now(), used_area_id = p_area_id where id = v_pass;

  perform log_area_event(v_area.house_id, p_area_id, 'turn_skipped',
    jsonb_build_object('from_user_id', v_uid, 'to_user_id', v_next, 'pass_id', v_pass, 'reason', v_reason));
  return jsonb_build_object(
    'area_id', p_area_id, 'area_name', v_area.name,
    'next_user_id', v_next, 'next_user_name', (select name from profiles where id = v_next),
    'reason', v_reason,
    'passes_left', (select count(*) from skip_passes where house_id = v_area.house_id and user_id = v_uid and used_at is null)
  );
end;
$$;

-- mark_needs_cleaning: a passed-on turn stays with its receiver even if they are not
-- in this area's rotation; if they are away it goes to the person after the skipper.
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
  if v_scheduled is null or (v_state.skip_from_user_id is null and not exists (
       select 1 from cleaning_rotation_members where cleaning_area_id = p_area_id and user_id = v_scheduled)) then
    select user_id into v_scheduled from cleaning_rotation_members where cleaning_area_id = p_area_id order by position limit 1;
  end if;
  if v_scheduled is null then raise exception 'no_rotation'; end if;
  if is_away(v_area.house_id, v_scheduled) then
    v_scheduled := next_rotation_user(p_area_id, coalesce(v_state.skip_from_user_id, v_scheduled));
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

-- complete_cleaning: unchanged scoring; after a passed-on turn the rotation resumes
-- from the skipper's position.
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

  -- Advance only this area's rotation (from the skipper if the turn was passed on); reset to passive.
  v_next := next_rotation_user(p_area_id, coalesce(v_state.skip_from_user_id, v_state.current_scheduled_user_id));
  update cleaning_area_state
     set activation_state = 'passive', last_cleaned_at = v_now, activated_at = null, activated_by_user_id = null,
         volunteer_user_id = null, volunteer_claimed_at = null, skip_from_user_id = null,
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

-- Away hand-off: a passed-on turn goes to the person after the skipper.
create or replace function public.admin_set_member_away(p_user_id uuid, p_away boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); r record; v_from uuid; v_next uuid;
begin
  update house_members set away = p_away where house_id = v_house and user_id = p_user_id;
  if not found then raise exception 'not_a_member'; end if;

  if p_away then
    for r in select s.* from cleaning_area_state s where s.house_id = v_house and s.current_scheduled_user_id = p_user_id loop
      v_from := coalesce(r.skip_from_user_id, p_user_id);
      v_next := next_rotation_user(r.cleaning_area_id, v_from);
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
-- 10. Grants
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'league_turns', 'league_max_days', 'league_eligible_members', 'league_round_scores', 'settle_league_rounds',
      'award_all_weekly_champions', 'get_league_round', 'get_leaderboard', 'get_league_rounds', 'get_user_stats',
      'mark_forfeit_done', 'admin_undo_completion', 'admin_reset_house', 'admin_set_setting',
      'league_skip_target', 'use_skip_pass', 'mark_needs_cleaning', 'complete_cleaning', 'admin_set_member_away')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'clear_skip_origin_on_reassign'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Open the first round for every house now, not on someone's first page load.
-- ---------------------------------------------------------------------------
do $$
declare h record;
begin
  for h in select id from public.houses loop
    perform public.settle_league_rounds(h.id);
  end loop;
end $$;
