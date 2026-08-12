-- Supabase performance advisor: `multiple_permissive_policies` (0006) — 15 tables.
--
-- Postgres ORs together every PERMISSIVE policy that matches a (role, command) pair, and it must
-- execute all of them for every row. This project accumulated three overlapping generations of
-- permissive policy on the same tables, all expressing the identical rule:
--
--   1. `admin_all_<x>`      — TO authenticated, FOR ALL, `is_admin()`
--   2. `<x>_all`            — FOR ALL, `is_admin() OR <client scope>`, USING + WITH CHECK
--   3. `<x>_select/insert/update/delete` — per-command, same predicate as (2)
--
-- (1) is a strict subset of (2) and (3) — every row it admits, they admit — so it is pure
-- overhead. (3) is (2) split four ways. Keeping (2) alone preserves the effective grant exactly
-- while cutting 2-3 policy evaluations per row on the hottest tables in the app.
--
-- Equivalence of (2) vs (3) on the period-scoped tables is worth stating explicitly, since the
-- two are written differently: (2) uses `EXISTS (SELECT 1 FROM monthly_periods p WHERE p.id =
-- period_id AND p.client_id = my_client_id())`, (3) uses `(SELECT client_id FROM monthly_periods
-- WHERE id = period_id) = my_client_id()`. For a missing or NULL period_id the scalar form yields
-- NULL (falsy in a policy) and the EXISTS form yields false — same admitted row set either way.
--
-- RESTRICTIVE policies (`no_self_service_accounts`, `no_pos_pin_staff`, `no_ims_staff`,
-- `no_hr_role_staff` from S316/S419/S430) are NOT touched here and are unaffected: they AND with
-- whatever permissive policies remain, so removing redundant permissive ones cannot widen access.
--
-- Verify afterwards (expect zero rows):
--   SELECT tablename, cmd, count(*) FROM pg_policies
--   WHERE schemaname='public' AND permissive='PERMISSIVE'
--   GROUP BY 1,2 HAVING count(*) > 1;

BEGIN;

-- ── Group A: tables scoped by their own client_id column ────────────────────────────────────
-- Keep `<x>_all`: `client_id = my_client_id() OR is_admin()`, USING + WITH CHECK.

DROP POLICY IF EXISTS admin_all_categories ON public.categories;
DROP POLICY IF EXISTS categories_select    ON public.categories;
DROP POLICY IF EXISTS categories_insert    ON public.categories;
DROP POLICY IF EXISTS categories_update    ON public.categories;
DROP POLICY IF EXISTS categories_delete    ON public.categories;

DROP POLICY IF EXISTS admin_all_items ON public.items;
DROP POLICY IF EXISTS items_select    ON public.items;
DROP POLICY IF EXISTS items_insert    ON public.items;
DROP POLICY IF EXISTS items_update    ON public.items;
DROP POLICY IF EXISTS items_delete    ON public.items;

DROP POLICY IF EXISTS admin_all_recipes ON public.recipes;
DROP POLICY IF EXISTS recipes_select    ON public.recipes;
DROP POLICY IF EXISTS recipes_insert    ON public.recipes;
DROP POLICY IF EXISTS recipes_update    ON public.recipes;
DROP POLICY IF EXISTS recipes_delete    ON public.recipes;

DROP POLICY IF EXISTS admin_all_vendors ON public.vendors;
DROP POLICY IF EXISTS vendors_select    ON public.vendors;
DROP POLICY IF EXISTS vendors_insert    ON public.vendors;
DROP POLICY IF EXISTS vendors_update    ON public.vendors;
DROP POLICY IF EXISTS vendors_delete    ON public.vendors;

-- ── Group B: tables scoped through monthly_periods.period_id ────────────────────────────────
-- Keep `<x>_all` (the EXISTS form).

DROP POLICY IF EXISTS admin_all_purchases ON public.purchase_entries;
DROP POLICY IF EXISTS purchases_select    ON public.purchase_entries;
DROP POLICY IF EXISTS purchases_insert    ON public.purchase_entries;
DROP POLICY IF EXISTS purchases_update    ON public.purchase_entries;
DROP POLICY IF EXISTS purchases_delete    ON public.purchase_entries;

-- sales_entries additionally carried `sales_entries_select`, a fourth SELECT policy that
-- re-implements the same rule inline against profiles instead of via is_admin()/my_client_id().
-- Dropping it also removes one of the 41 auth_rls_initplan findings.
DROP POLICY IF EXISTS admin_all_sales      ON public.sales_entries;
DROP POLICY IF EXISTS sales_select         ON public.sales_entries;
DROP POLICY IF EXISTS sales_insert         ON public.sales_entries;
DROP POLICY IF EXISTS sales_update         ON public.sales_entries;
DROP POLICY IF EXISTS sales_delete         ON public.sales_entries;
DROP POLICY IF EXISTS sales_entries_select ON public.sales_entries;

DROP POLICY IF EXISTS admin_all_wastages ON public.wastages;
DROP POLICY IF EXISTS wastages_select    ON public.wastages;
DROP POLICY IF EXISTS wastages_insert    ON public.wastages;
DROP POLICY IF EXISTS wastages_update    ON public.wastages;
DROP POLICY IF EXISTS wastages_delete    ON public.wastages;

-- opening_stock / closing_stock never had a per-command DELETE policy; `<x>_stock_all` covers it.
DROP POLICY IF EXISTS admin_all_opening ON public.opening_stock;
DROP POLICY IF EXISTS opening_select    ON public.opening_stock;
DROP POLICY IF EXISTS opening_insert    ON public.opening_stock;
DROP POLICY IF EXISTS opening_update    ON public.opening_stock;

DROP POLICY IF EXISTS admin_all_closing ON public.closing_stock;
DROP POLICY IF EXISTS closing_select    ON public.closing_stock;
DROP POLICY IF EXISTS closing_insert    ON public.closing_stock;
DROP POLICY IF EXISTS closing_update    ON public.closing_stock;

-- ── Group C: scoped through recipes.recipe_id ───────────────────────────────────────────────

DROP POLICY IF EXISTS admin_all_recipe_ing ON public.recipe_ingredients;
DROP POLICY IF EXISTS recipe_ing_select    ON public.recipe_ingredients;
DROP POLICY IF EXISTS recipe_ing_insert    ON public.recipe_ingredients;
DROP POLICY IF EXISTS recipe_ing_update    ON public.recipe_ingredients;
DROP POLICY IF EXISTS recipe_ing_delete    ON public.recipe_ingredients;

-- ── clients: only the blanket admin policy is redundant ─────────────────────────────────────
-- clients_select is `id = my_client_id() OR is_admin()`; insert/update/delete are `is_admin()`.
-- admin_all_clients adds nothing to any of the four. The per-command set is kept as-is.

DROP POLICY IF EXISTS admin_all_clients ON public.clients;

-- ── purchase_orders / purchase_order_items: two FOR ALL policies saying the same thing ──────
-- `client_purchase_orders` / `client_po_items` have USING only; `client_access_*` have the
-- identical USING plus an explicit WITH CHECK. For a FOR ALL policy an omitted WITH CHECK
-- defaults to the USING expression, so the pair is functionally identical. Keep the explicit one.

DROP POLICY IF EXISTS client_purchase_orders ON public.purchase_orders;
DROP POLICY IF EXISTS client_po_items        ON public.purchase_order_items;

-- ── hr_employees: `hr_employees_update` was written without a FOR clause ────────────────────
-- so it is FOR ALL, not FOR UPDATE, and therefore overlaps its three per-command siblings on
-- SELECT/INSERT/DELETE. All four carry the identical predicate, so scoping it to UPDATE (which
-- is plainly what the name intends) removes the overlap without changing who can do what.
-- A policy's command cannot be changed by ALTER POLICY, so this is a drop + recreate.

DROP POLICY IF EXISTS hr_employees_update ON public.hr_employees;

CREATE POLICY hr_employees_update ON public.hr_employees
  FOR UPDATE
  USING (
    ((select public.is_admin()) OR client_id = (select public.my_client_id()))
    AND NOT (select public.is_hr_self_service())
  )
  WITH CHECK (
    ((select public.is_admin()) OR client_id = (select public.my_client_id()))
    AND NOT (select public.is_hr_self_service())
  );

-- ── vendor_returns: an admin FOR ALL policy overlapping four client per-command policies ────
-- The client policies do not include admin, so the admin one cannot simply be dropped. Collapse
-- all five into the single `<x>_all` shape every other client_id-scoped table already uses.
--
--   old "vendor_returns: admin all"    = EXISTS (SELECT 1 FROM profiles
--                                                WHERE id = auth.uid() AND role = 'admin')
--   old "vendor_returns: client read"  = client_id = my_client_id()   (same for update/delete)
--   old "vendor_returns: client insert" = client_id = (SELECT client_id FROM profiles
--                                                      WHERE id = auth.uid())
--
-- The inline admin EXISTS is equivalent to is_admin() (both resolve the caller's own profiles
-- row, which profiles_select already permits), and the inline client_id subquery is literally
-- my_client_id()'s body. This also clears two more auth_rls_initplan findings.

DROP POLICY IF EXISTS "vendor_returns: admin all"     ON public.vendor_returns;
DROP POLICY IF EXISTS "vendor_returns: client read"   ON public.vendor_returns;
DROP POLICY IF EXISTS "vendor_returns: client insert" ON public.vendor_returns;
DROP POLICY IF EXISTS "vendor_returns: client update" ON public.vendor_returns;
DROP POLICY IF EXISTS "vendor_returns: client delete" ON public.vendor_returns;

CREATE POLICY vendor_returns_all ON public.vendor_returns
  FOR ALL
  USING (
    (select public.is_admin()) OR client_id = (select public.my_client_id())
  )
  WITH CHECK (
    (select public.is_admin()) OR client_id = (select public.my_client_id())
  );

COMMIT;
