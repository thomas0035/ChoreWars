-- ============================================================================
-- ChoreWars — Inventory: shared house purchases and who owes whom
--
-- Someone buys something for the house (a 10-chapati packet for ₹80, 1 kg of
-- rice, a bunch of bananas) and adds it as an item. Everyone logs what they
-- take. Each take costs its share of the price, owed to the buyer:
--   * open item:     qty × price / total_qty          (₹8 a chapati)
--   * finished item: qty × price / taken_qty          (leftovers thrown away
--     are spread over the people who actually took some; 8 of 10 taken → ₹10
--     a chapati). Nobody took any → the buyer absorbs it.
-- An item finishes by itself when the last of it is taken; the buyer or an
-- admin can also finish it early (thrown away / expired).
--
-- Balances are netted per pair across all items, minus payments. Only the
-- person who was owed records a payment ("received ₹X from Y"), capped at
-- what Y currently owes them, so nobody can wipe a debt by themselves.
--
-- Money is integer paise. Costs are computed from the takes at read time, so
-- editing an item's price or finishing it re-prices every take.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table public.inventory_items (
  id           uuid primary key default gen_random_uuid(),
  house_id     uuid not null references public.houses (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 60),
  unit         text not null check (unit in ('pcs', 'pack', 'g', 'kg', 'ml', 'l')),
  total_qty    numeric(12, 3) not null check (total_qty > 0),
  price_paise  int not null check (price_paise >= 0),
  bought_by    uuid not null references public.profiles (id) on delete cascade,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz,
  finished_by  uuid references public.profiles (id) on delete set null
);
create index inventory_items_house_idx on public.inventory_items (house_id, created_at desc);

create table public.inventory_takes (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses (id) on delete cascade,
  item_id     uuid not null references public.inventory_items (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  qty         numeric(12, 3) not null check (qty > 0),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index inventory_takes_item_idx on public.inventory_takes (item_id);

create table public.inventory_payments (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null references public.houses (id) on delete cascade,
  from_user     uuid not null references public.profiles (id) on delete cascade,
  to_user       uuid not null references public.profiles (id) on delete cascade,
  amount_paise  int not null check (amount_paise > 0),
  note          text check (note is null or char_length(note) <= 100),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  check (from_user <> to_user)
);
create index inventory_payments_house_idx on public.inventory_payments (house_id, created_at desc);

alter table public.inventory_items    enable row level security;
alter table public.inventory_takes    enable row level security;
alter table public.inventory_payments enable row level security;
create policy "inventory_items: read"    on public.inventory_items    for select to authenticated using (public.is_house_member(house_id));
create policy "inventory_takes: read"    on public.inventory_takes    for select to authenticated using (public.is_house_member(house_id));
create policy "inventory_payments: read" on public.inventory_payments for select to authenticated using (public.is_house_member(house_id));

-- Full replica identity so DELETE events (undo) carry the row.
alter table public.inventory_items    replica identity full;
alter table public.inventory_takes    replica identity full;
alter table public.inventory_payments replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.inventory_items, public.inventory_takes, public.inventory_payments;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Views (security_invoker, so the tables' RLS still applies to clients)
-- ---------------------------------------------------------------------------
create view public.inventory_item_summary with (security_invoker = true) as
select i.*,
       coalesce(t.taken, 0)               as taken_qty,
       i.total_qty - coalesce(t.taken, 0) as remaining_qty,
       -- Paise per unit. Finished with leftovers → spread over what was taken.
       case when i.finished_at is not null and coalesce(t.taken, 0) > 0
            then i.price_paise / t.taken
            else i.price_paise / i.total_qty end as unit_cost
  from public.inventory_items i
  left join (select item_id, sum(qty) as taken from public.inventory_takes group by item_id) t on t.item_id = i.id;

create view public.inventory_take_costs with (security_invoker = true) as
select t.*, s.bought_by, t.qty * s.unit_cost as cost_paise
  from public.inventory_takes t
  join public.inventory_item_summary s on s.id = t.item_id;

-- ---------------------------------------------------------------------------
-- 3. Balances
-- ---------------------------------------------------------------------------
-- Net debts in a house: one row per pair, debtor owes creditor amount_paise (> 0).
create or replace function public.inventory_house_balances(p_house uuid)
returns table (debtor uuid, creditor uuid, amount_paise int)
language sql stable security definer set search_path = public as $$
  with flows as (
    select user_id as debtor, bought_by as creditor, cost_paise as amt
      from inventory_take_costs where house_id = p_house and user_id <> bought_by
    union all
    select from_user, to_user, -amount_paise::numeric
      from inventory_payments where house_id = p_house
  ),
  pairs as (
    -- net > 0: a owes b
    select least(debtor, creditor) as a, greatest(debtor, creditor) as b,
           sum(case when debtor < creditor then amt else -amt end) as net
      from flows group by 1, 2
  )
  select case when net > 0 then a else b end,
         case when net > 0 then b else a end,
         round(abs(net))::int
    from pairs
   where round(abs(net)) > 0;
$$;

create or replace function public.inventory_balances()
returns table (debtor uuid, creditor uuid, amount_paise int)
language sql stable security definer set search_path = public as $$
  select * from inventory_house_balances(current_house_id());
$$;

-- "₹80", "₹24.50"
create or replace function public.inventory_rupees(p_paise numeric)
returns text language sql immutable as $$
  select '₹' || case when round(p_paise) % 100 = 0 then (round(p_paise) / 100)::bigint::text
                     else to_char(round(p_paise) / 100.0, 'FM999999990.00') end;
$$;

-- "10 pcs", "1.5 kg"
create or replace function public.inventory_qty_label(p_qty numeric, p_unit text)
returns text language sql immutable as $$
  select trim_scale(p_qty)::text || ' ' || case p_unit when 'l' then 'L' when 'pack' then 'pack' || case when p_qty = 1 then '' else 's' end else p_unit end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Items
-- ---------------------------------------------------------------------------
create or replace function public.inventory_add_item(p_name text, p_unit text, p_qty numeric, p_price_paise int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_house uuid := current_house_id();
  v_name  text := btrim(coalesce(p_name, ''));
  v_buyer text;
  v_id    uuid;
  m       record;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if v_house is null then raise exception 'not_a_member'; end if;
  if char_length(v_name) not between 1 and 60 then raise exception 'invalid_name'; end if;
  if p_unit is null or p_unit not in ('pcs', 'pack', 'g', 'kg', 'ml', 'l') then raise exception 'invalid_unit'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000 then raise exception 'invalid_amount'; end if;
  if p_unit in ('pcs', 'pack') and p_qty <> trunc(p_qty) then raise exception 'whole_number_only'; end if;
  if p_price_paise is null or p_price_paise < 0 or p_price_paise > 10000000 then raise exception 'invalid_price'; end if;

  insert into inventory_items (house_id, name, unit, total_qty, price_paise, bought_by, created_by)
  values (v_house, v_name, p_unit, p_qty, p_price_paise, v_uid, v_uid)
  returning id into v_id;

  perform log_area_event(v_house, null, 'inventory_item_added',
    jsonb_build_object('item_id', v_id, 'name', v_name, 'qty', p_qty, 'unit', p_unit, 'price_paise', p_price_paise));

  v_buyer := coalesce((select name from profiles where id = v_uid), 'Someone');
  -- queue_notification skips the actor, away members and people with no devices.
  for m in select user_id from house_members where house_id = v_house loop
    perform queue_notification(v_house, m.user_id, 'inventory_item_added', null,
      '🛒 ' || v_buyer || ' bought ' || v_name,
      inventory_qty_label(p_qty, p_unit) || ' · ' || inventory_rupees(p_price_paise) || '. Log what you take in Stock.',
      '/inventory');
  end loop;

  return jsonb_build_object('id', v_id);
end;
$$;

-- Buyer or admin, while the item is open. The quantity can't go below what's already been taken.
create or replace function public.inventory_update_item(p_item_id uuid, p_name text, p_qty numeric, p_price_paise int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_name  text := btrim(coalesce(p_name, ''));
  i       inventory_items%rowtype;
  v_taken numeric;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into i from inventory_items where id = p_item_id for update;
  if not found or not is_house_member(i.house_id) then raise exception 'item_not_found'; end if;
  if v_uid <> i.bought_by and not is_house_admin(i.house_id) then raise exception 'not_buyer'; end if;
  if i.finished_at is not null then raise exception 'item_finished'; end if;
  if char_length(v_name) not between 1 and 60 then raise exception 'invalid_name'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 1000000 then raise exception 'invalid_amount'; end if;
  if i.unit in ('pcs', 'pack') and p_qty <> trunc(p_qty) then raise exception 'whole_number_only'; end if;
  if p_price_paise is null or p_price_paise < 0 or p_price_paise > 10000000 then raise exception 'invalid_price'; end if;

  select coalesce(sum(qty), 0) into v_taken from inventory_takes where item_id = i.id;
  if p_qty < v_taken then raise exception 'qty_below_taken' using detail = trim_scale(v_taken)::text; end if;

  update inventory_items
     set name = v_name, total_qty = p_qty, price_paise = p_price_paise,
         finished_at = case when p_qty = v_taken then now() end,
         finished_by = case when p_qty = v_taken then v_uid end
   where id = i.id;

  perform log_area_event(i.house_id, null, 'inventory_item_updated',
    jsonb_build_object('item_id', i.id, 'name', v_name, 'qty', p_qty, 'price_paise', p_price_paise,
                       'old_qty', i.total_qty, 'old_price_paise', i.price_paise));
  return jsonb_build_object('id', i.id);
end;
$$;

-- Buyer or admin, only while nobody else has taken any (otherwise finish it instead).
create or replace function public.inventory_delete_item(p_item_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); i inventory_items%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into i from inventory_items where id = p_item_id for update;
  if not found or not is_house_member(i.house_id) then raise exception 'item_not_found'; end if;
  if v_uid <> i.bought_by and not is_house_admin(i.house_id) then raise exception 'not_buyer'; end if;
  if exists (select 1 from inventory_takes where item_id = i.id and user_id <> i.bought_by) then
    raise exception 'item_has_takes';
  end if;

  delete from inventory_items where id = i.id;
  perform log_area_event(i.house_id, null, 'inventory_item_deleted',
    jsonb_build_object('item_id', i.id, 'name', i.name, 'qty', i.total_qty, 'price_paise', i.price_paise));
  return jsonb_build_object('id', i.id);
end;
$$;

-- Buyer or admin finishes an item that still has some left (thrown away / expired), or reopens it.
create or replace function public.inventory_finish_item(p_item_id uuid, p_finished boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); i inventory_items%rowtype; v_taken numeric;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into i from inventory_items where id = p_item_id for update;
  if not found or not is_house_member(i.house_id) then raise exception 'item_not_found'; end if;
  if v_uid <> i.bought_by and not is_house_admin(i.house_id) then raise exception 'not_buyer'; end if;
  select coalesce(sum(qty), 0) into v_taken from inventory_takes where item_id = i.id;

  if p_finished then
    if i.finished_at is not null then raise exception 'item_finished'; end if;
    update inventory_items set finished_at = now(), finished_by = v_uid where id = i.id;
  else
    if i.finished_at is null then return jsonb_build_object('id', i.id, 'finished', false); end if;
    if v_taken >= i.total_qty then raise exception 'nothing_left'; end if;
    update inventory_items set finished_at = null, finished_by = null where id = i.id;
  end if;

  perform log_area_event(i.house_id, null, case when p_finished then 'inventory_item_finished' else 'inventory_item_reopened' end,
    jsonb_build_object('item_id', i.id, 'name', i.name, 'left', i.total_qty - v_taken));
  return jsonb_build_object('id', i.id, 'finished', p_finished);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Takes
-- ---------------------------------------------------------------------------
create or replace function public.inventory_take(p_item_id uuid, p_qty numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  i      inventory_items%rowtype;
  v_left numeric;
  v_id   uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  -- Row lock: two people grabbing the last chapati can't both get it.
  select * into i from inventory_items where id = p_item_id for update;
  if not found or not is_house_member(i.house_id) then raise exception 'item_not_found'; end if;
  if i.finished_at is not null then raise exception 'item_finished'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'invalid_amount'; end if;
  if i.unit in ('pcs', 'pack') and p_qty <> trunc(p_qty) then raise exception 'whole_number_only'; end if;

  v_left := i.total_qty - coalesce((select sum(qty) from inventory_takes where item_id = i.id), 0);
  if p_qty > v_left then raise exception 'not_enough_left' using detail = inventory_qty_label(v_left, i.unit); end if;

  insert into inventory_takes (house_id, item_id, user_id, qty, created_by)
  values (i.house_id, i.id, v_uid, p_qty, v_uid)
  returning id into v_id;

  if p_qty = v_left then
    update inventory_items set finished_at = now(), finished_by = v_uid where id = i.id;
  end if;

  return jsonb_build_object('id', v_id, 'item_id', i.id, 'left', v_left - p_qty, 'finished', p_qty = v_left);
end;
$$;

-- The taker within 24 hours, or an admin any time. Undoing a take on an item that
-- ran out reopens it; an item finished early (leftovers thrown away) stays finished.
create or replace function public.inventory_undo_take(p_take_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  t       inventory_takes%rowtype;
  i       inventory_items%rowtype;
  v_taken numeric;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into t from inventory_takes where id = p_take_id;
  if not found or not is_house_member(t.house_id) then raise exception 'take_not_found'; end if;
  if not is_house_admin(t.house_id) then
    if t.user_id <> v_uid then raise exception 'not_authorized'; end if;
    if t.created_at < now() - interval '24 hours' then raise exception 'undo_window_passed'; end if;
  end if;

  select * into i from inventory_items where id = t.item_id for update;
  select coalesce(sum(qty), 0) into v_taken from inventory_takes where item_id = i.id;

  delete from inventory_takes where id = t.id;
  if i.finished_at is not null and v_taken >= i.total_qty then
    update inventory_items set finished_at = null, finished_by = null where id = i.id;
  end if;

  perform log_area_event(t.house_id, null, 'inventory_take_undone',
    jsonb_build_object('take_id', t.id, 'item_id', i.id, 'name', i.name, 'user_id', t.user_id, 'qty', t.qty));
  return jsonb_build_object('id', t.id, 'item_id', i.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Payments (recorded by the receiver)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_record_payment(p_from_user uuid, p_amount_paise int, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_house uuid := current_house_id();
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
  v_owed  int;
  v_me    text;
  v_id    uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if v_house is null then raise exception 'not_a_member'; end if;
  if p_from_user is null or p_from_user = v_uid then raise exception 'member_not_found'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 then raise exception 'invalid_amount'; end if;
  if v_note is not null and char_length(v_note) > 100 then raise exception 'invalid_value'; end if;

  -- One payment at a time per house, so two quick taps can't both pass the cap.
  perform pg_advisory_xact_lock(hashtext('inventory_payment:' || v_house::text));
  select b.amount_paise into v_owed from inventory_house_balances(v_house) b
   where b.debtor = p_from_user and b.creditor = v_uid;
  if coalesce(v_owed, 0) = 0 then raise exception 'nothing_owed'; end if;
  if p_amount_paise > v_owed then raise exception 'amount_exceeds_debt' using detail = v_owed::text; end if;

  insert into inventory_payments (house_id, from_user, to_user, amount_paise, note, created_by)
  values (v_house, p_from_user, v_uid, p_amount_paise, v_note, v_uid)
  returning id into v_id;

  perform log_area_event(v_house, null, 'inventory_payment',
    jsonb_build_object('payment_id', v_id, 'from_user', p_from_user, 'to_user', v_uid, 'amount_paise', p_amount_paise));

  v_me := coalesce((select name from profiles where id = v_uid), 'Someone');
  perform queue_notification(v_house, p_from_user, 'inventory_payment', null,
    '💸 ' || v_me || ' got your ' || inventory_rupees(p_amount_paise),
    case when p_amount_paise = v_owed then 'You''re all square now.'
         else 'You still owe ' || inventory_rupees(v_owed - p_amount_paise) || '.' end,
    '/inventory');

  return jsonb_build_object('id', v_id, 'amount_paise', p_amount_paise, 'still_owed', v_owed - p_amount_paise);
end;
$$;

create or replace function public.inventory_undo_payment(p_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); p inventory_payments%rowtype;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into p from inventory_payments where id = p_payment_id;
  if not found or not is_house_member(p.house_id) then raise exception 'payment_not_found'; end if;
  if p.to_user <> v_uid and not is_house_admin(p.house_id) then raise exception 'not_authorized'; end if;

  delete from inventory_payments where id = p.id;
  perform log_area_event(p.house_id, null, 'inventory_payment_undone',
    jsonb_build_object('payment_id', p.id, 'from_user', p.from_user, 'to_user', p.to_user, 'amount_paise', p.amount_paise));
  return jsonb_build_object('id', p.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'inventory_balances', 'inventory_add_item', 'inventory_update_item', 'inventory_delete_item',
      'inventory_finish_item', 'inventory_take', 'inventory_undo_take', 'inventory_record_payment', 'inventory_undo_payment')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;

-- Takes any house id, so clients only get it through inventory_balances().
revoke all on function public.inventory_house_balances(uuid) from public, anon, authenticated;
grant execute on function public.inventory_house_balances(uuid) to service_role;
