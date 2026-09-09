-- S707 (2 of 2) — the Item Master delete guard stops being advice.
--
-- S706 fixed the guard in the browser: it now reads a map of ANY referencing row (not just rows
-- with qty > 0), refuses when the usage scan could not answer, and clears the same eleven tables
-- it checks. Every one of those fixes was necessary. None of them is a guard.
--
-- WHAT THE BROWSER GUARD DOES NOT COVER
--
-- `items` carries one permissive policy after the S542 consolidation --
-- `client_id = my_client_id() OR is_admin()`, FOR ALL -- plus RESTRICTIVE fences excluding POS PIN
-- staff (S316), HR self-service (S316) and HR-role staff (S430). `items` is deliberately NOT in
-- the `no_ims_staff` list (S419), because IMS staff need the item book. So the accounts that can
-- issue `DELETE /rest/v1/items?id=eq.<uuid>` with nothing but their own JWT and the public anon
-- key are: admin, the Owner, and EVERY IMS account of any rank -- including `ims_role = 'staff'`,
-- which cannot open Item Master at all (`hasImsAccess('supervisor')` in Items.js, `minImsRole:
-- 'supervisor'` on the nav item).
--
-- That delete is not refused. Five of the eleven referencing tables hold it with a plain FK; the
-- three ON DELETE CASCADE tables -- `requisition_lines`, `staff_meals`, `vendor_returns` -- go
-- with it. And the audit picture is asymmetric in the worst direction: `items` and
-- `vendor_returns` carry `log_audit` triggers, so those rows survive as `to_jsonb(OLD)` snapshots,
-- while `requisition_lines` and `staff_meals` carry none. Staff meals are inside `computeUsed()`
-- and therefore inside COGS, so this silently moves a period's food cost with no record anywhere
-- that it happened. There is no server-side closed-period write guard either, so a closed period
-- is not protection.
--
-- WHY A TRIGGER AND NOT A `SECURITY DEFINER` RPC
--
-- Privilege invariant #3 settled this shape already: S576/S579 chose triggers "rather than RPCs,
-- because an RPC protects only the callers that choose to call it and leaves the open policy in
-- place." A `delete_item()` RPC would leave `items_all` FOR ALL exactly as wide as it is today and
-- protect only Items.js, which is the one caller that already behaves. The trigger below is the
-- direct sibling of `purchase_entries_guard_paid_delete` (S698) and is SECURITY INVOKER for the
-- same reason `guard_profiles_privileged_columns()` is: `current_user` is the seam, and under
-- DEFINER it would be the owner every time and the service-role carve-out could never fire.
--
-- A NOTE ON DELETING A CLIENT. `items_client_id_fkey` is ON DELETE CASCADE, and ClientDrawer
-- deletes the `clients` row from the browser. That sequence runs `deleteClientData` (service role,
-- which empties `items`) first, so the cascade normally fires on zero rows. If that step failed
-- partway, the client-row delete now REFUSES instead of cascading a half-deleted item book away
-- silently -- and ClientDrawer's own handler already says the right thing ("Run Delete Client
-- again to finish"), which re-runs the service-role step.

-- ── (a) The lookup ──────────────────────────────────────────────────────────────────────────
--
-- One row per (item, referencing table) that actually holds a row. SECURITY DEFINER for the same
-- reason as `purchase_bill_payments`: a guard that drops its read passes vacuously, and several of
-- these tables are period- or parent-scoped rather than client-scoped, so a caller whose RLS view
-- of `requisition_lines` is narrower than its view of `items` would otherwise be told the item is
-- unreferenced. The caller check is on the ITEM's client, wrapped in COALESCE per the fail-open
-- rule, and the service role is recognised by the absence of a JWT subject rather than by name.
--
-- Output columns are `ref_item_id` / `ref_table` / `ref_count`, not `item_id`: a RETURNS TABLE
-- column name is in scope inside the body, and `item_id` is a real column on all eleven tables,
-- so naming it that makes every reference to it ambiguous.
--
-- The table list, and its order, is the SQL twin of `src/modules/ims/items/itemRefTables.js`.
-- `itemRefTables.test.js` reads THIS FILE and fails if the two ever diverge.

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

REVOKE EXECUTE ON FUNCTION public.item_reference_counts(uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.item_reference_counts(uuid[]) TO authenticated, service_role;

-- ── (b) The delete guard ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.items_guard_referenced_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_tables text;
BEGIN
  -- SECURITY INVOKER on purpose (see the header): `current_user` is the only thing that separates
  -- a browser JWT from the service role and from a SECURITY DEFINER body such as
  -- force_delete_item() below, which is what makes that function the one sanctioned way through.
  IF current_user IN ('anon', 'authenticated') THEN
    SELECT string_agg(DISTINCT r.ref_table, ', ' ORDER BY r.ref_table)
      INTO v_tables
      FROM item_reference_counts(ARRAY[OLD.id]) r;

    IF v_tables IS NOT NULL THEN
      RAISE EXCEPTION 'item_has_references: item % is referenced in %', OLD.id, v_tables
        USING ERRCODE = 'P0001',
              HINT = 'Hide the item instead, or ask a Crest operator to force-delete it along with those records.';
    END IF;
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS items_guard_referenced_delete ON public.items;
CREATE TRIGGER items_guard_referenced_delete
  BEFORE DELETE ON public.items
  FOR EACH ROW EXECUTE FUNCTION public.items_guard_referenced_delete();

-- ── (c) The one sanctioned way through ──────────────────────────────────────────────────────
--
-- Admin-only, matching Item Master exactly: force-delete is offered to `isAdmin` there, never to
-- the Owner. `COALESCE(is_admin(), false)` because is_admin() returns NULL for a caller with no
-- profiles row, and `IF NOT NULL THEN` never fires -- the fail-open trap this codebase has now hit
-- in three separate guises.
--
-- ATOMIC, which the browser loop it replaces could not be. That loop issued twelve separate HTTP
-- requests, so a refusal on request nine left the first eight tables emptied and the item still
-- standing -- the exact state S706 found, where force-delete cleared eight tables, was refused by
-- the remaining three, and told the operator to "try again", which could never work. A function
-- body is one transaction: either the item and all of its history go, or nothing does.
--
-- Returns what it actually removed, per table, so the confirmation can name the damage instead of
-- reciting the list it intended to clear.

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
    'vendor_returns', 'recipe_ingredients', 'requisition_lines', 'staff_meals', 'wastages',
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

  -- SECURITY DEFINER, so current_user here is the function owner and the trigger in (b) waves
  -- this through. Nothing else can reach this point.
  DELETE FROM items WHERE id = p_item_id;
  cleared_table := 'items';
  rows_deleted  := 1;
  RETURN NEXT;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.force_delete_item(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.force_delete_item(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   -- the trigger is attached and enabled
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.items'::regclass AND NOT tgisinternal;
--
--   -- neither function is reachable by anon
--   SELECT has_function_privilege('anon', 'public.force_delete_item(uuid)', 'EXECUTE');       -- false
--   SELECT has_function_privilege('anon', 'public.item_reference_counts(uuid[])', 'EXECUTE'); -- false
--
--   -- force_delete_item is DEFINER, the guard is INVOKER (prosecdef true / false)
--   SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('force_delete_item', 'items_guard_referenced_delete', 'item_reference_counts');
--
--   -- and the guard actually refuses. Run as a client JWT, in a transaction you roll back:
--   BEGIN;
--     DELETE FROM items WHERE id = '<an item with purchases>';  -- expect P0001 item_has_references
--   ROLLBACK;
