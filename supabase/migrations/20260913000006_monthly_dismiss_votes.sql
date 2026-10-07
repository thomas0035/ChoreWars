-- ============================================================================
-- 1. Monthly points become the main competition: get_user_stats gains
--    monthly_rank / month_start (weekly values are kept).
-- 2. "Looks fine, not needed" becomes a vote. The scheduled person starts it;
--    anyone in the area's rotation can agree; the flag clears once at least
--    half of the rotation (rounded up) has voted. Admins keep an immediate
--    override via dismiss_activation.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Stats
-- ---------------------------------------------------------------------------
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
    'monthly_rank',   (select lb.rank from get_leaderboard('month') lb where lb.user_id = p_user_id),
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
    'week_end', house_week_end(v_house, v_week_start),
    'month_start', v_month_start
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dismiss votes
-- ---------------------------------------------------------------------------
create table public.dismiss_votes (
  house_id          uuid not null references public.houses (id) on delete cascade,
  cleaning_area_id  uuid not null references public.cleaning_areas (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  created_at        timestamptz not null default now(),
  primary key (cleaning_area_id, user_id)
);

alter table public.dismiss_votes enable row level security;
create policy "dismiss_votes: read" on public.dismiss_votes for select to authenticated using (public.is_house_member(house_id));
alter table public.dismiss_votes replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.dismiss_votes;
  end if;
end $$;

-- Votes only make sense while an area is flagged: clear them whenever it goes back to passive.
create or replace function public.clear_dismiss_votes_on_passive()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.activation_state = 'passive' and old.activation_state <> 'passive' then
    delete from dismiss_votes where cleaning_area_id = new.cleaning_area_id;
  end if;
  return new;
end;
$$;
drop trigger if exists dismiss_votes_clear_on_passive on public.cleaning_area_state;
create trigger dismiss_votes_clear_on_passive
  after update of activation_state on public.cleaning_area_state
  for each row execute function public.clear_dismiss_votes_on_passive();

-- Someone removed from a rotation no longer has a say in that area.
create or replace function public.clear_dismiss_vote_on_rotation_leave()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from dismiss_votes where cleaning_area_id = old.cleaning_area_id and user_id = old.user_id;
  return old;
end;
$$;
drop trigger if exists dismiss_votes_clear_on_rotation_leave on public.cleaning_rotation_members;
create trigger dismiss_votes_clear_on_rotation_leave
  after delete on public.cleaning_rotation_members
  for each row execute function public.clear_dismiss_vote_on_rotation_leave();

-- Half the rotation, rounded up; never less than 1.
create or replace function public.dismiss_votes_needed(p_area uuid)
returns int language sql stable security definer set search_path = public as $$
  select greatest(1, ((count(*) + 1) / 2)::int) from cleaning_rotation_members where cleaning_area_id = p_area;
$$;

-- Admin-only immediate override. Members go through vote_dismiss.
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
  if not is_house_admin(v_area.house_id) then raise exception 'not_admin'; end if;
  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  if v_state.activation_state = 'passive' then raise exception 'not_active'; end if;

  update cleaning_area_state
     set activation_state = 'passive', activated_at = null, activated_by_user_id = null,
         volunteer_user_id = null, volunteer_claimed_at = null, updated_at = now()
   where cleaning_area_id = p_area_id;

  perform log_area_event(v_area.house_id, p_area_id, 'dismissed',
    jsonb_build_object('by', 'admin', 'activated_by_user_id', v_state.activated_by_user_id, 'activated_at', v_state.activated_at,
                       'volunteer_user_id', v_state.volunteer_user_id));
  return jsonb_build_object('area_id', p_area_id, 'dismissed', true);
end;
$$;

-- Cast a "looks fine" vote. The first vote must come from the scheduled person (or an admin);
-- after that anyone in the area's rotation can agree. Clears the flag once the threshold is met.
create or replace function public.vote_dismiss(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_area cleaning_areas%rowtype;
  v_state cleaning_area_state%rowtype;
  v_existing int; v_votes int; v_needed int;
  v_voters jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into v_area from cleaning_areas where id = p_area_id and active;
  if not found then raise exception 'area_not_found'; end if;
  if not is_house_member(v_area.house_id) then raise exception 'not_a_member'; end if;

  select * into v_state from cleaning_area_state where cleaning_area_id = p_area_id for update;
  if not found then raise exception 'area_not_found'; end if;
  if v_state.activation_state = 'passive' then raise exception 'not_active'; end if;
  if not exists (select 1 from cleaning_rotation_members where cleaning_area_id = p_area_id and user_id = v_uid) then
    raise exception 'not_in_area_rotation';
  end if;

  select count(*) into v_existing
    from dismiss_votes dv
    join cleaning_rotation_members rm on rm.cleaning_area_id = dv.cleaning_area_id and rm.user_id = dv.user_id
   where dv.cleaning_area_id = p_area_id;
  if v_existing = 0 and v_uid is distinct from v_state.current_scheduled_user_id and not is_house_admin(v_area.house_id) then
    raise exception 'dismiss_vote_not_started';
  end if;

  insert into dismiss_votes (house_id, cleaning_area_id, user_id) values (v_area.house_id, p_area_id, v_uid)
  on conflict do nothing;
  if found then
    perform log_area_event(v_area.house_id, p_area_id, 'dismiss_voted', '{}'::jsonb);
  end if;

  select count(*), coalesce(jsonb_agg(dv.user_id), '[]'::jsonb) into v_votes, v_voters
    from dismiss_votes dv
    join cleaning_rotation_members rm on rm.cleaning_area_id = dv.cleaning_area_id and rm.user_id = dv.user_id
   where dv.cleaning_area_id = p_area_id;
  v_needed := dismiss_votes_needed(p_area_id);

  if v_votes >= v_needed then
    update cleaning_area_state
       set activation_state = 'passive', activated_at = null, activated_by_user_id = null,
           volunteer_user_id = null, volunteer_claimed_at = null, updated_at = now()
     where cleaning_area_id = p_area_id;
    perform log_area_event(v_area.house_id, p_area_id, 'dismissed',
      jsonb_build_object('by', 'vote', 'voters', v_voters, 'needed', v_needed,
                         'activated_by_user_id', v_state.activated_by_user_id, 'activated_at', v_state.activated_at,
                         'volunteer_user_id', v_state.volunteer_user_id));
    return jsonb_build_object('area_id', p_area_id, 'area_name', v_area.name, 'dismissed', true, 'votes', v_votes, 'needed', v_needed);
  end if;

  return jsonb_build_object('area_id', p_area_id, 'area_name', v_area.name, 'dismissed', false, 'votes', v_votes, 'needed', v_needed);
end;
$$;

-- Take back your own vote while the area is still flagged.
create or replace function public.retract_dismiss_vote(p_area_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_house uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  delete from dismiss_votes where cleaning_area_id = p_area_id and user_id = v_uid returning house_id into v_house;
  if not found then raise exception 'no_vote'; end if;
  perform log_area_event(v_house, p_area_id, 'dismiss_vote_retracted', '{}'::jsonb);
  return jsonb_build_object('area_id', p_area_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (the 0002 loop ran before these existed)
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('dismiss_votes_needed', 'vote_dismiss', 'retract_dismiss_vote', 'dismiss_activation', 'get_user_stats')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
  -- Trigger functions are never called directly by clients.
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('clear_dismiss_votes_on_passive', 'clear_dismiss_vote_on_rotation_leave')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
