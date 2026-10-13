-- ============================================================================
-- Admin: discard a finished league round.
--
-- Deletes the round as if it never happened: its champion (and the crown that
-- comes with it), Skip Pass, forfeit and loser go with it. The League Champion
-- badge is taken back if that was the person's only remaining round win.
-- Later rounds are renumbered so there's no gap. Points, streaks, weekly
-- champions and cleaning history are untouched.
--
-- Refused for the open round, and when the round's Skip Pass was already used
-- (that hand-off can't be taken back).
-- ============================================================================

create or replace function public.admin_discard_round(p_round_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house uuid := require_admin();
  r league_rounds%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('league_rounds:' || v_house::text));

  select * into r from league_rounds where id = p_round_id and house_id = v_house;
  if not found then raise exception 'result_not_found'; end if;
  if r.ended_at is null then raise exception 'round_open'; end if;
  if exists (select 1 from skip_passes where round_id = r.id and used_at is not null) then
    raise exception 'skip_pass_used';
  end if;

  delete from league_rounds where id = r.id;   -- cascades to its skip_passes

  if r.champion_user_id is not null
     and not exists (select 1 from league_rounds
                      where house_id = v_house and champion_user_id = r.champion_user_id and ended_at is not null) then
    delete from user_achievements
     where house_id = v_house and user_id = r.champion_user_id and achievement_id = 'monthly_champion';
  end if;

  -- Close the gap in two steps so the unique (house_id, round_no) never collides.
  update league_rounds set round_no = -round_no where house_id = v_house and round_no > r.round_no;
  update league_rounds set round_no = -round_no - 1 where house_id = v_house and round_no < 0;

  perform log_area_event(v_house, null, 'round_discarded',
    jsonb_build_object('round_no', r.round_no, 'started_at', r.started_at, 'ended_at', r.ended_at,
                       'champion_user_id', r.champion_user_id, 'loser_user_id', r.loser_user_id));
  return jsonb_build_object('round_no', r.round_no);
end;
$$;

revoke execute on function public.admin_discard_round(uuid) from public, anon;
grant execute on function public.admin_discard_round(uuid) to authenticated, service_role;
