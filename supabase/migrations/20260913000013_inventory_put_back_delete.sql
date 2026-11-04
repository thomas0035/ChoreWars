-- ============================================================================
-- ChoreWars — Inventory: put back (the "−" button) and delete with takes
--
-- * inventory_put_back: the card shows "−  3  +" for pieces and packs. "−"
--   takes back some of your own takes from the last 24 hours, newest first
--   (shrinking a take or removing it). Older takes need an admin, as with
--   inventory_undo_take. Putting back from an item that ran out reopens it.
-- * inventory_delete_item: the buyer or an admin can now delete an item even
--   after others took some. Their takes go with it (so does what they owed
--   for it), and they get a notification. Payments are kept, so if someone
--   had already paid for it the balance flips and the buyer owes them back.
-- ============================================================================

create or replace function public.inventory_put_back(p_item_id uuid, p_qty numeric default 1)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  i        inventory_items%rowtype;
  v_taken  numeric;
  v_recent numeric;
  v_rest   numeric := p_qty;
  t        record;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into i from inventory_items where id = p_item_id for update;
  if not found or not is_house_member(i.house_id) then raise exception 'item_not_found'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'invalid_amount'; end if;
  if i.unit in ('pcs', 'pack') and p_qty <> trunc(p_qty) then raise exception 'whole_number_only'; end if;

  select coalesce(sum(qty), 0) into v_recent from inventory_takes
   where item_id = i.id and user_id = v_uid and created_at >= now() - interval '24 hours';
  if v_recent = 0 then
    if exists (select 1 from inventory_takes where item_id = i.id and user_id = v_uid) then
      raise exception 'undo_window_passed';
    end if;
    raise exception 'nothing_to_put_back';
  end if;
  if p_qty > v_recent then raise exception 'not_that_many' using detail = inventory_qty_label(v_recent, i.unit); end if;

  select coalesce(sum(qty), 0) into v_taken from inventory_takes where item_id = i.id;

  for t in select * from inventory_takes
            where item_id = i.id and user_id = v_uid and created_at >= now() - interval '24 hours'
            order by created_at desc loop
    exit when v_rest <= 0;
    if t.qty <= v_rest then
      delete from inventory_takes where id = t.id;
      v_rest := v_rest - t.qty;
    else
      update inventory_takes set qty = qty - v_rest where id = t.id;
      v_rest := 0;
    end if;
  end loop;

  -- Ran out → reopen. An item finished early (leftovers thrown away) stays finished.
  if i.finished_at is not null and v_taken >= i.total_qty then
    update inventory_items set finished_at = null, finished_by = null where id = i.id;
  end if;

  perform log_area_event(i.house_id, null, 'inventory_put_back',
    jsonb_build_object('item_id', i.id, 'name', i.name, 'qty', p_qty));
  return jsonb_build_object('item_id', i.id, 'qty', p_qty, 'left', i.total_qty - v_taken + p_qty);
end;
$$;

create or replace function public.inventory_delete_item(p_item_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_me   text;
  i      inventory_items%rowtype;
  r      record;
  v_lost jsonb;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select * into i from inventory_items where id = p_item_id for update;
  if not found or not is_house_member(i.house_id) then raise exception 'item_not_found'; end if;
  if v_uid <> i.bought_by and not is_house_admin(i.house_id) then raise exception 'not_buyer'; end if;

  -- What each other taker owed for it, for the log and their notification.
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'qty', qty, 'cost_paise', round(cost))), '[]'::jsonb) into v_lost
    from (select user_id, sum(qty) as qty, sum(cost_paise) as cost from inventory_take_costs
           where item_id = i.id and user_id <> i.bought_by group by user_id) x;

  delete from inventory_items where id = i.id;  -- takes cascade
  perform log_area_event(i.house_id, null, 'inventory_item_deleted',
    jsonb_build_object('item_id', i.id, 'name', i.name, 'qty', i.total_qty, 'price_paise', i.price_paise,
                       'bought_by', i.bought_by, 'takes', v_lost));

  v_me := coalesce((select name from profiles where id = v_uid), 'Someone');
  for r in select (e ->> 'user_id')::uuid as user_id, (e ->> 'qty')::numeric as qty, (e ->> 'cost_paise')::numeric as cost
             from jsonb_array_elements(v_lost) e loop
    perform queue_notification(i.house_id, r.user_id, 'inventory_item_deleted', null,
      '🗑️ ' || v_me || ' deleted ' || i.name,
      'You''re no longer charged for your ' || inventory_qty_label(r.qty, i.unit) || ' (' || inventory_rupees(r.cost) || ').',
      '/inventory');
  end loop;

  return jsonb_build_object('id', i.id, 'takes_removed', jsonb_array_length(v_lost));
end;
$$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('inventory_put_back', 'inventory_delete_item')
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
