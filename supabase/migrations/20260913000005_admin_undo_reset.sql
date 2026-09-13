-- Admin tools: undo the latest completion of an area, reset scores, reset the house.

-- Rebuild a user's streak from history (used after an undo).
-- Real completions always have activated_at set; admin-logged ones don't and are ignored.
create or replace function public.recompute_streak(p_house uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; v_cur int := 0; v_max int := 0;
begin
  for r in
    select completion_type, completed_by_user_id, scheduled_user_id
      from cleaning_completions
     where house_id = p_house and activated_at is not null
       and (completed_by_user_id = p_user or scheduled_user_id = p_user)
     order by completed_at, id
  loop
    if r.completion_type = 'normal' and r.completed_by_user_id = p_user then
      v_cur := v_cur + 1;
      v_max := greatest(v_max, v_cur);
    elsif r.completion_type = 'volunteer' and r.scheduled_user_id = p_user then
      v_cur := 0;
    end if;
  end loop;
  insert into user_streaks (house_id, user_id, current_streak, longest_streak)
  values (p_house, p_user, v_cur, v_max)
  on conflict (house_id, user_id) do update
    set current_streak = excluded.current_streak, longest_streak = excluded.longest_streak, updated_at = now();
end;
$$;

-- Undo the most recent completion of an area. Removes its points, restores the previous
-- last_cleaned_at, returns the turn to the person who was scheduled, recomputes streaks.
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

-- p_mode = 'scores'     : clear points, streaks, achievements, weekly champions; keep history (zero points).
-- p_mode = 'everything' : also delete all history and events; every area back to passive, first in rotation.
create or replace function public.admin_reset_house(p_mode text)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin();
begin
  if p_mode not in ('scores', 'everything') then raise exception 'invalid_value'; end if;

  delete from user_points_ledger where house_id = v_house;
  delete from weekly_champions where house_id = v_house;
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

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('recompute_streak', 'admin_undo_completion', 'admin_reset_house')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
