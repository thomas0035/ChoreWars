-- ============================================================================
-- Push notifications (Web Push).
--
-- Flow: game events and the 15-minute cron job insert rows into
-- `notifications` (an outbox). An insert trigger pings the `send-push` Edge
-- Function through pg_net (sent after commit; rolled back with the
-- transaction). The function claims the rows, delivers them to every device in
-- `push_subscriptions` and records the result. Unsent rows are retried by the
-- cron job.
--
-- What gets sent (never to the person who caused it, never to away members):
--   flagged     an area you're scheduled for was flagged Needs Cleaning
--   reassigned  a flagged area was handed to you (Skip Pass, away hand-off, admin)
--   rescued     someone volunteered to do your flagged area
--   up_next     you're next in an area's rotation
--   attention   an unflagged area you're scheduled for crossed its attention
--               threshold (once per clean cycle; cron, 08:00–21:59 house time)
--   grace_over  your flagged area is still not done and volunteering is now
--               open (once per flag; cron, 08:00–21:59 house time)
--   test        "Send a test" button on Profile
--
-- One-time setup (Dashboard → SQL Editor), values from the README:
--   select vault.create_secret('https://<ref>.supabase.co', 'chorewars_project_url');
--   select vault.create_secret('<random string>',           'chorewars_push_secret');
-- Until both exist, notifications queue up and are sent once configured.
-- ============================================================================

do $$
begin
  create extension if not exists pg_net with schema extensions;
exception when others then
  raise notice 'pg_net not available: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table public.notifications (
  id                uuid primary key default gen_random_uuid(),
  house_id          uuid not null references public.houses (id) on delete cascade,
  user_id           uuid not null references public.profiles (id) on delete cascade,
  kind              text not null,
  cleaning_area_id  uuid references public.cleaning_areas (id) on delete cascade,
  title             text not null,
  body              text not null,
  url               text not null default '/',
  dedupe_key        text unique,
  created_at        timestamptz not null default now(),
  claimed_at        timestamptz,
  attempts          int not null default 0,
  sent_at           timestamptz,
  last_error        text
);
create index notifications_unsent_idx on public.notifications (created_at) where sent_at is null;
create index notifications_user_time_idx on public.notifications (user_id, created_at desc);

alter table public.push_subscriptions enable row level security;
alter table public.notifications      enable row level security;
create policy "push_subscriptions: read own" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "notifications: read own"      on public.notifications      for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. Device registration (client RPCs)
-- ---------------------------------------------------------------------------
-- Upsert by endpoint: a browser that signs in as someone else moves to them.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'invalid_value';
  end if;
  insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (v_uid, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, last_seen_at = now();
end;
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Queueing
-- ---------------------------------------------------------------------------
-- Returns null for a missing secret (setup not done yet) instead of failing the caller.
create or replace function public.push_config(p_name text)
returns text language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name limit 1;
  return v;
exception when others then
  return null;
end;
$$;

-- Fire-and-forget POST to the Edge Function. Never raises: a delivery problem
-- must not roll back a cleaning action.
create or replace function public.ping_push_sender(p_ids uuid[] default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_url text := push_config('chorewars_project_url');
  v_secret text := push_config('chorewars_push_secret');
begin
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/send-push',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret),
    body := jsonb_build_object('ids', to_jsonb(p_ids))
  );
exception when others then
  raise notice 'push ping skipped: %', sqlerrm;
end;
$$;

-- The single place deciding whether someone gets a notification.
create or replace function public.queue_notification(
  p_house uuid, p_user uuid, p_kind text, p_area uuid, p_title text, p_body text, p_url text default '/', p_dedupe text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  if p_kind <> 'test' and (p_user = auth.uid() or is_away(p_house, p_user)) then return; end if;
  if not exists (select 1 from push_subscriptions where user_id = p_user) then return; end if;
  insert into notifications (house_id, user_id, kind, cleaning_area_id, title, body, url, dedupe_key)
  values (p_house, p_user, p_kind, p_area, p_title, p_body, coalesce(p_url, '/'), p_dedupe)
  on conflict (dedupe_key) do nothing;
end;
$$;

create or replace function public.notifications_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from new_rows) then
    perform ping_push_sender(array(select id from new_rows));
  end if;
  return null;
end;
$$;
drop trigger if exists notifications_dispatch on public.notifications;
create trigger notifications_dispatch
  after insert on public.notifications
  referencing new table as new_rows
  for each statement execute function public.notifications_after_insert();

-- ---------------------------------------------------------------------------
-- 4. Event notifications from area state changes
-- ---------------------------------------------------------------------------
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

  -- Next in rotation (after a clean, or an admin change). Skipped on a house
  -- reset, which clears last_cleaned_at on every area at once.
  elsif new.activation_state = 'passive'
        and new.current_scheduled_user_id is distinct from old.current_scheduled_user_id
        and not (new.last_cleaned_at is null and old.last_cleaned_at is not null) then
    perform queue_notification(new.house_id, new.current_scheduled_user_id, 'up_next', v_area.id,
      'You''re up next for the ' || v_area.name || ' ' || v_area.icon,
      'Nothing to do yet. We''ll tell you when it needs cleaning.', v_url);
  end if;

  return null;
exception when others then
  raise notice 'notify_area_state_change skipped: %', sqlerrm;
  return null;
end;
$$;
drop trigger if exists area_state_notify on public.cleaning_area_state;
create trigger area_state_notify
  after update on public.cleaning_area_state
  for each row execute function public.notify_area_state_change();

-- ---------------------------------------------------------------------------
-- 5. Time-based notifications (cron) + retry of undelivered ones
-- ---------------------------------------------------------------------------
create or replace function public.run_notification_jobs()
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_user uuid;
  v_hour int;
  v_days int;
begin
  for r in
    select a.*, s.current_scheduled_user_id, s.activation_state, s.last_cleaned_at, s.activated_at, s.skip_from_user_id
      from cleaning_areas a
      join cleaning_area_state s on s.cleaning_area_id = a.id
     where a.active
  loop
    v_hour := extract(hour from now() at time zone house_setting(r.house_id, 'timezone', 'UTC'));
    continue when v_hour < 8 or v_hour >= 22;

    if r.activation_state = 'passive' and r.last_cleaned_at is not null
       and now() >= r.last_cleaned_at + make_interval(hours => r.attention_interval_hours) then
      -- Same person mark_needs_cleaning would pick.
      v_user := r.current_scheduled_user_id;
      if v_user is null or not exists (select 1 from cleaning_rotation_members where cleaning_area_id = r.id and user_id = v_user) then
        select user_id into v_user from cleaning_rotation_members where cleaning_area_id = r.id order by position limit 1;
      end if;
      if v_user is not null and is_away(r.house_id, v_user) then
        v_user := next_rotation_user(r.id, v_user);
      end if;
      v_days := floor(extract(epoch from now() - r.last_cleaned_at) / 86400);
      perform queue_notification(r.house_id, v_user, 'attention', r.id,
        '🔴 The ' || r.name || ' needs attention',
        'Last cleaned ' || v_days || ' day' || case when v_days = 1 then '' else 's' end || ' ago, and it''s your turn.',
        '/areas/' || r.id,
        'attention:' || r.id || ':' || r.last_cleaned_at);

    elsif r.activation_state = 'active' and r.activated_at is not null
          and now() >= r.activated_at + make_interval(hours => r.volunteer_grace_hours)
          and house_setting(r.house_id, 'volunteering_enabled', 'true') = 'true' then
      perform queue_notification(r.house_id, r.current_scheduled_user_id, 'grace_over', r.id,
        '⏰ The ' || r.name || ' is still waiting',
        'Anyone can rescue it now, and you''d lose '
          || house_setting_int(r.house_id, 'rescue_penalty_points', 5) || ' points.',
        '/areas/' || r.id,
        'grace:' || r.id || ':' || r.activated_at);
    end if;
  end loop;

  -- Retry anything undelivered from the last day (max 5 attempts).
  if exists (select 1 from notifications
              where sent_at is null and attempts < 5 and created_at > now() - interval '1 day'
                and created_at < now() - interval '2 minutes') then
    perform ping_push_sender(null);
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (select 1 from cron.job where jobname = 'chorewars-notifications') then
      perform cron.schedule('chorewars-notifications', '*/15 * * * *', 'select public.run_notification_jobs()');
    end if;
  end if;
exception when others then
  raise notice 'notification cron schedule skipped: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Sender-side RPCs (service role only)
-- ---------------------------------------------------------------------------
-- Claims rows for delivery. p_ids null = sweep everything due. A claim expires
-- after 5 minutes so a crashed sender doesn't strand rows.
create or replace function public.claim_notifications(p_ids uuid[] default null)
returns setof public.notifications language plpgsql security definer set search_path = public as $$
begin
  return query
  update notifications n
     set claimed_at = now(), attempts = n.attempts + 1
   where n.sent_at is null
     and n.attempts < 5
     and n.created_at > now() - interval '1 day'
     and (n.claimed_at is null or n.claimed_at < now() - interval '5 minutes')
     and (p_ids is null or n.id = any (p_ids))
  returning n.*;
end;
$$;

create or replace function public.finish_notification(p_id uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update notifications
     set sent_at = case when p_ok then now() end,
         claimed_at = case when p_ok then claimed_at end,
         last_error = left(p_error, 500)
   where id = p_id;
end;
$$;

revoke all on function public.claim_notifications(uuid[])                     from public, anon, authenticated;
revoke all on function public.finish_notification(uuid, boolean, text)         from public, anon, authenticated;
revoke all on function public.run_notification_jobs()                          from public, anon, authenticated;
revoke all on function public.ping_push_sender(uuid[])                         from public, anon, authenticated;
revoke all on function public.push_config(text)                                from public, anon, authenticated;
revoke all on function public.queue_notification(uuid, uuid, text, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_notifications(uuid[])              to service_role;
grant execute on function public.finish_notification(uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Test button
-- ---------------------------------------------------------------------------
create or replace function public.send_test_notification()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_house uuid := current_house_id();
  v_devices int;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if v_house is null then raise exception 'not_a_member'; end if;
  select count(*) into v_devices from push_subscriptions where user_id = v_uid;
  if v_devices = 0 then raise exception 'no_push_devices'; end if;
  perform queue_notification(v_house, v_uid, 'test', null,
    '🧹 ChoreWars notifications are on',
    'This is what a heads-up will look like.', '/profile',
    'test:' || v_uid || ':' || date_trunc('minute', now()));
  return jsonb_build_object('devices', v_devices);
end;
$$;
