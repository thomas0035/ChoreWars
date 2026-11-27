-- ============================================================================
-- Member logins are managed from the app; nobody needs the Supabase dashboard.
--
-- 1. admin_create_member: add a member (login + membership) in one step.
-- 2. Removing a member blocks their login; adding them back unblocks it.
--    Their history (cleanings, points, inventory, payments) is kept either way.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add a member from the app in one step.
--
-- Before: an admin first created the login in the Supabase dashboard, then
-- added that email under Admin → Members. admin_create_member() does both:
--   - no login with that email yet → creates a confirmed email/password login
--     (same shape as seed.sql) with the given starting password, or
--     'chorewars' if left blank, then adds them to the house;
--   - a login already exists (e.g. someone removed earlier) → just adds them
--     back; their existing password is kept and p_password is ignored.
-- Returns { user_id, created }.
--
-- This writes auth.users / auth.identities directly, like seed.sql does.
-- Supabase doesn't officially support that, so if a future Auth upgrade
-- changes those tables, this is the function to fix (or replace with an Edge
-- Function calling auth.admin.createUser).
--
-- admin_add_member() is kept for older clients.
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_member(p_email text, p_name text, p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_house   uuid := require_admin();
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_name    text := nullif(trim(coalesce(p_name, '')), '');
  -- Blank → the same starting password the seeded members got; they change it in Profile.
  v_password text := coalesce(nullif(p_password, ''), 'chorewars');
  v_uid     uuid;
  v_created boolean := false;
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  if char_length(v_name) > 40 then raise exception 'invalid_value'; end if;
  v_name := coalesce(v_name, initcap(split_part(v_email, '@', 1)));

  select id into v_uid from auth.users where lower(email) = v_email limit 1;

  if v_uid is not null then
    if exists (select 1 from house_members where house_id = v_house and user_id = v_uid) then
      raise exception 'already_member';
    end if;
  else
    -- Auth's own limits: at least 6 characters (config.toml), bcrypt reads 72 bytes at most.
    if char_length(v_password) < 6 or octet_length(v_password) > 72 then
      raise exception 'invalid_password';
    end if;

    v_uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current,
      reauthentication_token, phone_change, phone_change_token, is_sso_user, is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_password, extensions.gen_salt('bf', 10)), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('name', v_name), now(), now(),
      '', '', '', '', '', '', '', '', false, false
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), v_uid, v_uid::text,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
      'email', null, now(), now()
    );
    v_created := true;
  end if;

  -- The auth trigger already made the profile for a new login; set the name either way.
  insert into profiles (id, name) values (v_uid, v_name)
  on conflict (id) do update set name = case when nullif(trim(coalesce(p_name, '')), '') is null then profiles.name else excluded.name end;
  insert into house_members (house_id, user_id, role) values (v_house, v_uid, 'member');
  insert into user_streaks (house_id, user_id) values (v_house, v_uid) on conflict do nothing;
  perform log_area_event(v_house, null, 'admin_member_added', jsonb_build_object('user_id', v_uid, 'created_login', v_created));

  return jsonb_build_object('user_id', v_uid, 'created', v_created);
end;
$$;

revoke execute on function public.admin_create_member(text, text, text) from public, anon;
grant execute on function public.admin_create_member(text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Login follows membership. admin_remove_member() deletes the house_members
--    row (and hands off their turns); this trigger then blocks the login, so a
--    removed person can't sign in by typing their email. Re-adding them, by
--    either add function, unblocks it. 100 years = Supabase's own "ban forever".
--    Skipped when the whole account is being deleted (the profile is gone).
-- ---------------------------------------------------------------------------
create or replace function public.sync_member_login()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update auth.users set banned_until = null where id = new.user_id and banned_until is not null;
    return new;
  end if;

  if not exists (select 1 from house_members where user_id = old.user_id)
     and exists (select 1 from profiles where id = old.user_id) then
    update auth.users set banned_until = now() + interval '100 years' where id = old.user_id;
  end if;
  return old;
end;
$$;

drop trigger if exists house_members_sync_login on public.house_members;
create trigger house_members_sync_login
  after insert or delete on public.house_members
  for each row execute function public.sync_member_login();

revoke execute on function public.sync_member_login() from public, anon, authenticated;
