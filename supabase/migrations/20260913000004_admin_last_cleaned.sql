-- Admin: set when an area was last cleaned (and optionally by whom).
-- Used for initial setup / corrections. Awards no points, touches no streaks
-- or achievements. When a user is given, a zero-point completion row is
-- written so the history shows who cleaned it.
create or replace function public.admin_set_last_cleaned(p_area_id uuid, p_at timestamptz, p_user_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_house uuid := require_admin(); v_completion uuid;
begin
  if not exists (select 1 from cleaning_areas where id = p_area_id and house_id = v_house) then raise exception 'area_not_found'; end if;
  if p_at is null or p_at > now() + interval '5 minutes' then raise exception 'invalid_value'; end if;

  if p_user_id is not null then
    if not exists (select 1 from house_members where house_id = v_house and user_id = p_user_id) then raise exception 'not_a_member'; end if;
    insert into cleaning_completions (house_id, cleaning_area_id, scheduled_user_id, completed_by_user_id, completion_type, points_awarded, completed_at)
    values (v_house, p_area_id, p_user_id, p_user_id, 'normal', 0, p_at)
    returning id into v_completion;
  end if;

  update cleaning_area_state
     set last_cleaned_at = p_at, updated_at = now()
   where cleaning_area_id = p_area_id;

  perform log_area_event(v_house, p_area_id, 'admin_last_cleaned_set',
    jsonb_build_object('at', p_at, 'user_id', p_user_id, 'completion_id', v_completion));
end;
$$;

revoke execute on function public.admin_set_last_cleaned(uuid, timestamptz, uuid) from public, anon;
grant execute on function public.admin_set_last_cleaned(uuid, timestamptz, uuid) to authenticated, service_role;
