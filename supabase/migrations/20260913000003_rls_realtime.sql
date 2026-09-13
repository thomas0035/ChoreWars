-- ============================================================================
-- ChoreWars — Row Level Security, realtime publication, scheduled job
-- Members can READ their house's data. There are no client write policies
-- except a user editing their own profile; all writes go through the
-- SECURITY DEFINER functions in 0002.
-- ============================================================================

alter table public.profiles                 enable row level security;
alter table public.houses                   enable row level security;
alter table public.house_members            enable row level security;
alter table public.house_settings           enable row level security;
alter table public.cleaning_areas           enable row level security;
alter table public.cleaning_rotation_members enable row level security;
alter table public.cleaning_area_state      enable row level security;
alter table public.cleaning_completions     enable row level security;
alter table public.user_points_ledger       enable row level security;
alter table public.user_streaks             enable row level security;
alter table public.achievements             enable row level security;
alter table public.user_achievements        enable row level security;
alter table public.weekly_champions         enable row level security;
alter table public.area_events              enable row level security;

create policy "profiles: read housemates"  on public.profiles for select to authenticated using (public.shares_house_with(id));
create policy "profiles: update self"      on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "houses: read own"           on public.houses            for select to authenticated using (public.is_house_member(id));
create policy "house_members: read"        on public.house_members     for select to authenticated using (public.is_house_member(house_id));
create policy "house_settings: read"       on public.house_settings    for select to authenticated using (public.is_house_member(house_id));
create policy "areas: read"                on public.cleaning_areas    for select to authenticated using (public.is_house_member(house_id));
create policy "rotation: read"             on public.cleaning_rotation_members for select to authenticated using (public.is_house_member(house_id));
create policy "state: read"                on public.cleaning_area_state for select to authenticated using (public.is_house_member(house_id));
create policy "completions: read"          on public.cleaning_completions for select to authenticated using (public.is_house_member(house_id));
create policy "ledger: read"               on public.user_points_ledger for select to authenticated using (public.is_house_member(house_id));
create policy "streaks: read"              on public.user_streaks      for select to authenticated using (public.is_house_member(house_id));
create policy "achievements: read"         on public.achievements      for select to authenticated using (true);
create policy "user_achievements: read"    on public.user_achievements for select to authenticated using (public.is_house_member(house_id));
create policy "champions: read"            on public.weekly_champions  for select to authenticated using (public.is_house_member(house_id));
create policy "events: read"               on public.area_events       for select to authenticated using (public.is_house_member(house_id));

-- ---------------------------------------------------------------------------
-- Realtime: broadcast row changes on the tables the UI watches.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.cleaning_area_state,
      public.cleaning_areas,
      public.cleaning_rotation_members,
      public.cleaning_completions,
      public.user_points_ledger,
      public.user_streaks,
      public.user_achievements,
      public.weekly_champions,
      public.house_members,
      public.house_settings,
      public.profiles;
  end if;
end $$;

-- Full replica identity so DELETE events carry the row (needed to react to removals).
alter table public.cleaning_rotation_members replica identity full;
alter table public.house_members replica identity full;

-- ---------------------------------------------------------------------------
-- Weekly champion snapshot. The leaderboard RPC also calls this lazily, so the
-- cron job is belt-and-braces. Silently skipped where pg_cron is unavailable.
-- ---------------------------------------------------------------------------
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron not available: %', sqlerrm;
  end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'chorewars-weekly-champions') then
      perform cron.schedule('chorewars-weekly-champions', '7 * * * *', 'select public.award_all_weekly_champions()');
    end if;
  end if;
exception when others then
  raise notice 'cron schedule skipped: %', sqlerrm;
end $$;
