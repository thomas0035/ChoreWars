-- ============================================================================
-- ChoreWars — seed: one house, six members, five areas, rotations.
-- Idempotent (fixed UUIDs + ON CONFLICT). Apply with:
--   npx supabase db push --include-seed
-- Every member logs in with <firstname>@house.local and the password below,
-- then changes it from the Profile screen.
-- ============================================================================

-- pgcrypto (crypt/gen_salt) lives in the "extensions" schema on hosted Supabase.
set search_path = public, extensions;

do $$
declare
  v_house    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_password text := 'chorewars';   -- initial password for all six seeded accounts

  u_thomas uuid := '10000000-0000-4000-8000-000000000001';
  u_vinil  uuid := '10000000-0000-4000-8000-000000000002';
  u_akshay uuid := '10000000-0000-4000-8000-000000000003';
  u_stebin uuid := '10000000-0000-4000-8000-000000000004';
  u_jesvin uuid := '10000000-0000-4000-8000-000000000005';
  u_albert uuid := '10000000-0000-4000-8000-000000000006';

  a_kitchen uuid := '20000000-0000-4000-8000-000000000001';
  a_sink    uuid := '20000000-0000-4000-8000-000000000002';
  a_hall    uuid := '20000000-0000-4000-8000-000000000003';
  a_bath_a  uuid := '20000000-0000-4000-8000-000000000004';
  a_bath_b  uuid := '20000000-0000-4000-8000-000000000005';

  m record;
  v_hash text := crypt(v_password, gen_salt('bf'));
begin
  -- -------------------------------------------------------------------------
  -- Auth users (+ identities so email/password sign-in works)
  -- -------------------------------------------------------------------------
  for m in
    select * from (values
      (u_thomas, 'Thomas', 'thomas@house.local'),
      (u_vinil,  'Vinil',  'vinil@house.local'),
      (u_akshay, 'Akshay', 'akshay@house.local'),
      (u_stebin, 'Stebin', 'stebin@house.local'),
      (u_jesvin, 'Jesvin', 'jesvin@house.local'),
      (u_albert, 'Albert', 'albert@house.local')
    ) as t(id, name, email)
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current,
      reauthentication_token, phone_change, phone_change_token, is_sso_user, is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000', m.id, 'authenticated', 'authenticated', m.email, v_hash, now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', m.name), now(), now(),
      '', '', '', '', '', '', '', '', false, false
    ) on conflict (id) do nothing;

    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), m.id, m.id::text,
      jsonb_build_object('sub', m.id::text, 'email', m.email, 'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    ) on conflict (provider_id, provider) do nothing;

    -- The auth trigger creates the profile; make sure the display name is right either way.
    insert into public.profiles (id, name) values (m.id, m.name)
    on conflict (id) do update set name = excluded.name;
  end loop;

  -- -------------------------------------------------------------------------
  -- House, members, settings
  -- -------------------------------------------------------------------------
  insert into public.houses (id, name) values (v_house, 'Our House') on conflict (id) do nothing;

  insert into public.house_members (house_id, user_id, role) values
    (v_house, u_thomas, 'admin'),
    (v_house, u_vinil,  'member'),
    (v_house, u_akshay, 'member'),
    (v_house, u_stebin, 'member'),
    (v_house, u_jesvin, 'member'),
    (v_house, u_albert, 'member')
  on conflict (house_id, user_id) do nothing;

  insert into public.user_streaks (house_id, user_id)
  select v_house, unnest(array[u_thomas, u_vinil, u_akshay, u_stebin, u_jesvin, u_albert])
  on conflict do nothing;

  insert into public.house_settings (house_id, key, value) values
    (v_house, 'timezone', 'Asia/Kolkata'),
    (v_house, 'week_start_day', 'monday'),
    (v_house, 'default_reactivation_cooldown_hours', '4'),
    (v_house, 'volunteering_enabled', 'true'),
    (v_house, 'early_bonus_points', '2'),
    (v_house, 'streak_bonus_3', '3'),
    (v_house, 'streak_bonus_5', '5'),
    (v_house, 'streak_bonus_10', '10'),
    (v_house, 'public_login_directory', 'true')
  on conflict (house_id, key) do nothing;

  -- -------------------------------------------------------------------------
  -- Areas (hours: minimum / expected / attention)
  -- -------------------------------------------------------------------------
  insert into public.cleaning_areas (id, house_id, name, icon, minimum_interval_hours, expected_interval_hours, attention_interval_hours, sort_order) values
    (a_kitchen, v_house, 'Kitchen',    '🍳', 120, 168, 336, 10),   -- 5d / 7d / 14d
    (a_sink,    v_house, 'Sink',       '🚰', 240, 336, 504, 20),   -- 10d / 14d / 21d
    (a_hall,    v_house, 'Hall',       '🧽', 120, 168, 264, 30),   -- 5d / 7d / 11d
    (a_bath_a,  v_house, 'Bathroom A', '🚿', 120, 168, 336, 40),
    (a_bath_b,  v_house, 'Bathroom B', '🚿', 120, 168, 336, 50)
  on conflict (id) do nothing;

  -- Rotations (position order = turn order)
  insert into public.cleaning_rotation_members (house_id, cleaning_area_id, user_id, position)
  select v_house, a_kitchen, u, ord - 1 from unnest(array[u_thomas, u_vinil, u_akshay, u_stebin, u_jesvin, u_albert]) with ordinality as t(u, ord)
  union all
  select v_house, a_hall,    u, ord - 1 from unnest(array[u_akshay, u_stebin, u_albert, u_thomas, u_vinil, u_jesvin]) with ordinality as t(u, ord)
  union all
  select v_house, a_sink,    u, ord - 1 from unnest(array[u_jesvin, u_thomas, u_vinil, u_albert, u_stebin, u_akshay]) with ordinality as t(u, ord)
  union all
  select v_house, a_bath_a,  u, ord - 1 from unnest(array[u_thomas, u_vinil, u_albert]) with ordinality as t(u, ord)
  union all
  select v_house, a_bath_b,  u, ord - 1 from unnest(array[u_stebin, u_jesvin, u_akshay]) with ordinality as t(u, ord)
  on conflict (cleaning_area_id, user_id) do nothing;

  -- State: first person in each rotation is up; no cleaning recorded yet.
  insert into public.cleaning_area_state (cleaning_area_id, house_id, current_scheduled_user_id) values
    (a_kitchen, v_house, u_thomas),
    (a_sink,    v_house, u_jesvin),
    (a_hall,    v_house, u_akshay),
    (a_bath_a,  v_house, u_thomas),
    (a_bath_b,  v_house, u_stebin)
  on conflict (cleaning_area_id) do nothing;
end $$;
