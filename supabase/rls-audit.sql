-- ============================================================
-- Crest Inventory — RLS Audit
-- Run in Supabase Dashboard → SQL Editor
-- ============================================================

-- 1. Check which tables have RLS enabled
SELECT
  tablename,
  CASE WHEN rowsecurity THEN '✓ RLS ON' ELSE '✗ RLS OFF' END AS rls_status
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'clients','profiles','feature_flags','settings',
    'categories','items','vendors',
    'monthly_periods','purchase_entries','vendor_returns',
    'opening_stock','closing_stock','wastages',
    'sales_entries','recipes','recipe_ingredients',
    'overheads','par_levels'
  )
ORDER BY tablename;

-- 2. List all active RLS policies
SELECT
  tablename,
  policyname,
  cmd,
  roles,
  qual AS using_expr,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 3. Enable RLS on any table that's missing it
-- (run only the lines where table shows "RLS OFF" above)

-- ALTER TABLE public.clients           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.profiles          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.feature_flags     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.settings          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.categories        ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.items             ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.vendors           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.monthly_periods   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.purchase_entries  ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.vendor_returns    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.opening_stock     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.closing_stock     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.wastages          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.sales_entries     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.recipes           ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.overheads         ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.par_levels        ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. Minimum correct policies (paste if a table is missing them)
-- ============================================================

-- Admins (role = 'admin' in profiles) see everything.
-- Clients see only their own data via client_id match.
-- The pattern below uses a helper function for clarity.

-- Helper: get the client_id for the current user
CREATE OR REPLACE FUNCTION public.my_client_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT client_id FROM public.profiles WHERE id = auth.uid()
$$;

-- Helper: is the current user an admin?
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin'
  )
$$;

-- ── clients ──────────────────────────────────────────────────
-- Admins can see all; clients can only see their own row.
CREATE POLICY "clients_select" ON public.clients FOR SELECT
  USING (public.is_admin() OR id = public.my_client_id());

CREATE POLICY "clients_admin_all" ON public.clients FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── profiles ─────────────────────────────────────────────────
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT
  USING (public.is_admin() OR id = auth.uid());

CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_admin_all" ON public.profiles FOR ALL
  USING (public.is_admin()) WITH CHECK (public.is_admin());

-- ── client-scoped tables (all data tables) ───────────────────
-- Adjust the list to match tables that actually have client_id column.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'categories','items','vendors','monthly_periods',
    'purchase_entries','vendor_returns','opening_stock','closing_stock',
    'wastages','sales_entries','recipes','recipe_ingredients',
    'overheads','par_levels','feature_flags','settings'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL
       USING (public.is_admin() OR client_id = public.my_client_id())
       WITH CHECK (public.is_admin() OR client_id = public.my_client_id())',
      tbl || '_client_rls', tbl
    );
  END LOOP;
END $$;

-- Note: recipe_ingredients has no client_id — it's joined via recipe_id.
-- Its policy should use a subquery:
DROP POLICY IF EXISTS "recipe_ingredients_client_rls" ON public.recipe_ingredients;
CREATE POLICY "recipe_ingredients_rls" ON public.recipe_ingredients FOR ALL
  USING (
    public.is_admin() OR
    recipe_id IN (SELECT id FROM public.recipes WHERE client_id = public.my_client_id())
  )
  WITH CHECK (
    public.is_admin() OR
    recipe_id IN (SELECT id FROM public.recipes WHERE client_id = public.my_client_id())
  );
