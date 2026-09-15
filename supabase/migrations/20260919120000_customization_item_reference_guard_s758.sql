-- S758 stage 3: pos_option_ingredients.item_id is a twelfth foreign key to items(id).
--
-- itemRefTables.test.js reads every migration for FKs to items(id) and fails when a table is not
-- in ITEM_REF_TABLES — which is exactly what it did the moment 20260919110000 created this table.
-- The list exists twice (itemRefTables.js and the two functions below), so both move together:
--
--   item_reference_counts()  — what Item Master's delete guard and the BEFORE DELETE trigger ask.
--                              Without this line an item used only in an option read as unused,
--                              and its delete was then refused by the plain FK with a raw 23503.
--   force_delete_item()      — what an operator's force-delete clears. Without it the final
--                              DELETE FROM items was refused after the other eleven tables had
--                              been emptied — the S706 half-destroyed item, one table later.
--
-- Bodies are copied from 20260909130000, confirmed byte-identical to the LIVE definitions on
-- 2026-09-15 (prosrc read back), with the one table added in the same place in both: after
-- recipe_ingredients. The plain FK does not cascade, and nothing references pos_option_ingredients,
-- so any position before items is a valid dependency order; beside recipe lines is the readable one.
-- Signatures and return types are unchanged, so CREATE OR REPLACE keeps the grants.

CREATE OR REPLACE FUNCTION public.item_reference_counts(p_ids uuid[])
RETURNS TABLE (ref_item_id uuid, ref_table text, ref_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  WITH scoped AS (
    SELECT i.id
      FROM items i
     WHERE i.id = ANY (p_ids)
       AND COALESCE(
             (select auth.uid()) IS NULL
             OR is_admin()
             OR i.client_id = my_client_id(),
             false)
  ), refs AS (
              SELECT 'vendor_returns'::text  AS t, x.item_id FROM vendor_returns      x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'recipe_ingredients',      x.item_id FROM recipe_ingredients   x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'pos_option_ingredients',  x.item_id FROM pos_option_ingredients x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'requisition_lines',       x.item_id FROM requisition_lines    x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'staff_meals',             x.item_id FROM staff_meals          x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'wastages',                x.item_id FROM wastages             x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'opening_stock',           x.item_id FROM opening_stock        x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'closing_stock',           x.item_id FROM closing_stock        x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'par_levels',              x.item_id FROM par_levels           x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'purchase_order_items',    x.item_id FROM purchase_order_items x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'stock_movements',         x.item_id FROM stock_movements      x JOIN scoped s ON s.id = x.item_id
    UNION ALL SELECT 'purchase_entries',        x.item_id FROM purchase_entries     x JOIN scoped s ON s.id = x.item_id
  )
  SELECT r.item_id, r.t, count(*)::bigint
    FROM refs r
   GROUP BY r.item_id, r.t;
$fn$;

CREATE OR REPLACE FUNCTION public.force_delete_item(p_item_id uuid)
RETURNS TABLE (cleared_table text, rows_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_client uuid;
  v_tbl    text;
  v_n      integer;
BEGIN
  IF NOT COALESCE(is_admin(), false) THEN
    RAISE EXCEPTION 'force_delete_item_not_permitted: only a Crest operator can force-delete an item'
      USING ERRCODE = 'P0001',
            HINT = 'Hide the item instead — it keeps every record it is already on.';
  END IF;

  SELECT client_id INTO v_client FROM items WHERE id = p_item_id;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'force_delete_item_missing: that item no longer exists'
      USING ERRCODE = 'P0001',
            HINT = 'Reload Item Master — someone else may have deleted it already.';
  END IF;

  -- itemRefTables.js order, which is a DEPENDENCY order and not a preference: vendor_returns
  -- references purchase_entries as well as items, so it must go first.
  FOREACH v_tbl IN ARRAY ARRAY[
    'vendor_returns', 'recipe_ingredients', 'pos_option_ingredients', 'requisition_lines', 'staff_meals', 'wastages',
    'opening_stock', 'closing_stock', 'par_levels', 'purchase_order_items', 'stock_movements',
    'purchase_entries'
  ] LOOP
    EXECUTE format('DELETE FROM public.%I WHERE item_id = $1', v_tbl) USING p_item_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      cleared_table := v_tbl;
      rows_deleted  := v_n;
      RETURN NEXT;
    END IF;
  END LOOP;

  -- SECURITY DEFINER, so current_user here is the function owner and the items trigger waves this
  -- through — as does guard_pos_option_edit on pos_option_ingredients. Nothing else can reach this.
  DELETE FROM items WHERE id = p_item_id;
  cleared_table := 'items';
  rows_deleted  := 1;
  RETURN NEXT;
END;
$fn$;

NOTIFY pgrst, 'reload schema';

-- ── Verification, rolled back ─────────────────────────────────────────────────────────────────
DO $do$
BEGIN
  BEGIN
    DECLARE
      v_c uuid; v_i uuid; v_g uuid; v_o uuid; v_n bigint;
    BEGIN
      INSERT INTO public.clients (name, pos_enabled, customization_enabled) VALUES ('__s758c', true, true) RETURNING id INTO v_c;
      INSERT INTO public.items (client_id, name, uom, rate, purchase_qty) VALUES (v_c, '__cheese', 'GM', 1, 1) RETURNING id INTO v_i;
      INSERT INTO public.pos_option_groups (client_id, name) VALUES (v_c, 'Extras') RETURNING id INTO v_g;
      INSERT INTO public.pos_options (client_id, group_id, name) VALUES (v_c, v_g, 'Extra cheese') RETURNING id INTO v_o;
      INSERT INTO public.pos_option_ingredients (client_id, option_id, item_id, qty_per_portion) VALUES (v_c, v_o, v_i, 30);

      SELECT ref_count INTO v_n FROM public.item_reference_counts(ARRAY[v_i]) WHERE ref_table = 'pos_option_ingredients';
      IF COALESCE(v_n, 0) <> 1 THEN
        RAISE EXCEPTION 'S758c verify: item_reference_counts did not see the option ingredient (got %)', v_n;
      END IF;
      IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.force_delete_item(uuid)'::regprocedure) NOT LIKE '%pos_option_ingredients%' THEN
        RAISE EXCEPTION 'S758c verify: force_delete_item does not clear pos_option_ingredients';
      END IF;
      IF NOT has_function_privilege('authenticated', 'public.item_reference_counts(uuid[])', 'EXECUTE')
         OR has_function_privilege('anon', 'public.force_delete_item(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'S758c verify: grants changed';
      END IF;

      RAISE EXCEPTION 's758c_rollback' USING ERRCODE = 'P0758';
    END;
  EXCEPTION WHEN SQLSTATE 'P0758' THEN
    NULL;
  END;
END
$do$;
