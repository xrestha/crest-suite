-- S885: item categories can be added, renamed and removed from Item Master.
--
-- Owner decisions (2026-11-04, asked in plain words): IMS supervisors and above add and rename; only
-- the Owner and IMS managers remove, because a remove moves items and money. Removing a category that
-- holds items asks where they go, then ONE step moves them, their stock-count section assignments and
-- their monthly budgets (two budgets in the same month are added together), and removes the category.
-- "Sub-Recipes" can never be renamed or removed.
--
-- Why one function: removing is four writes on four tables, and two of the foreign keys onto
-- categories CASCADE (budgets, ims_count_assignments). Done from the browser as separate requests, a
-- failure half-way would leave a category gone with its budgets silently deleted for every month and
-- its counters unable to see the moved items. In one transaction a refusal leaves everything as it
-- was, so the page may say nothing changed.
--
-- 1. merge_item_category(p_from, p_to) — SECURITY INVOKER on purpose: every rank guard (items
--    supervisor, budgets supervisor, count assignments manager through RLS, categories DELETE manager)
--    and every RLS policy still applies to the caller. The rank test up front only words the refusal.
-- 2. categories_guard_protected — a BEFORE trigger refusing a signed-in session any rename or delete
--    of "Sub-Recipes", renaming another category to it, or a second spelling of it. Recipe Costing
--    (Recipes.js) finds it by that exact name, Item Master hides it by that name, and push_master_data
--    matches it by lower(name), so a renamed copy would split the sub-recipe mirrors across two.
--    SECURITY INVOKER keyed on current_user, so the service role, SECURITY DEFINER bodies (the HQ push)
--    and a cascade from a deleted client pass; a delete whose client row is already gone passes too.
--
-- Add and rename stay plain writes on categories (UNIQUE (client_id, name), case-sensitive; the page
-- checks case-insensitively first). No new table, so nothing to register for export or Danger Zone.
--
-- Reverse:
--   DROP TRIGGER IF EXISTS categories_guard_protected ON public.categories;
--   DROP FUNCTION IF EXISTS public.categories_guard_protected();
--   DROP FUNCTION IF EXISTS public.merge_item_category(uuid, uuid);

-- ══ 1. The one-step remove ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.merge_item_category(p_from uuid, p_to uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from              public.categories%ROWTYPE;
  v_to                public.categories%ROWTYPE;
  v_items             integer := 0;
  v_budgets_merged    integer := 0;
  v_budgets_moved     integer := 0;
  v_assignments_moved integer := 0;
  v_deleted           integer := 0;
BEGIN
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'category_missing: no category was named' USING ERRCODE = 'P0001', HINT = 'category_missing';
  END IF;

  -- RLS limits this read to the caller's own outlet (or every outlet for the operator).
  SELECT * INTO v_from FROM categories WHERE id = p_from;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'category_missing: the category to remove no longer exists' USING ERRCODE = 'P0001', HINT = 'category_missing';
  END IF;

  IF p_to IS NOT NULL THEN
    IF p_to = p_from THEN
      RAISE EXCEPTION 'category_same: a category cannot be moved into itself' USING ERRCODE = 'P0001', HINT = 'category_same';
    END IF;
    SELECT * INTO v_to FROM categories WHERE id = p_to;
    IF NOT FOUND OR v_to.client_id IS DISTINCT FROM v_from.client_id THEN
      RAISE EXCEPTION 'category_missing: the category to move into no longer exists' USING ERRCODE = 'P0001', HINT = 'category_missing';
    END IF;
  END IF;

  IF lower(btrim(v_from.name)) = 'sub-recipes' OR (p_to IS NOT NULL AND lower(btrim(v_to.name)) = 'sub-recipes') THEN
    RAISE EXCEPTION 'category_protected: Sub-Recipes is kept by Recipe Costing' USING ERRCODE = 'P0001', HINT = 'category_protected';
  END IF;

  -- COALESCE: ims_caller_has_rank is already NULL-safe, but a bare call in an IF is the S630 shape.
  IF NOT COALESCE(public.ims_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'category_remove_rank: removing a category needs the Owner or an IMS manager'
      USING ERRCODE = '42501', HINT = 'category_remove_rank';
  END IF;

  IF p_to IS NULL AND (EXISTS (SELECT 1 FROM items WHERE category_id = p_from)
                       OR EXISTS (SELECT 1 FROM budgets WHERE category_id = p_from)) THEN
    RAISE EXCEPTION 'category_needs_target: the category still holds items or budgets'
      USING ERRCODE = 'P0001', HINT = 'category_needs_target';
  END IF;

  IF p_to IS NOT NULL THEN
    -- Items, hidden ones and sub-recipe mirrors included (none can be filed under Sub-Recipes here,
    -- since neither side is it).
    UPDATE items SET category_id = p_to WHERE category_id = p_from;
    GET DIAGNOSTICS v_items = ROW_COUNT;

    -- Budgets: UNIQUE (period_id, category_id), so a month that budgets both adds them together and
    -- the moved one goes; a month that budgets only the old category moves its row.
    UPDATE budgets t
       SET amount = COALESCE(t.amount, 0) + COALESCE(f.amount, 0)
      FROM budgets f
     WHERE f.category_id = p_from
       AND t.category_id = p_to
       AND t.period_id IS NOT DISTINCT FROM f.period_id;
    GET DIAGNOSTICS v_budgets_merged = ROW_COUNT;
    DELETE FROM budgets f
     WHERE f.category_id = p_from
       AND EXISTS (SELECT 1 FROM budgets t WHERE t.category_id = p_to AND t.period_id IS NOT DISTINCT FROM f.period_id);
    UPDATE budgets SET category_id = p_to WHERE category_id = p_from;
    GET DIAGNOSTICS v_budgets_moved = ROW_COUNT;

    -- Stock-count sections: whoever counted the old category now counts the new one. Insert-if-absent
    -- BEFORE the delete below, or a scoped counter would lose sight of the moved items.
    INSERT INTO ims_count_assignments (client_id, profile_id, category_id)
    SELECT a.client_id, a.profile_id, p_to
      FROM ims_count_assignments a
     WHERE a.category_id = p_from
    ON CONFLICT (profile_id, category_id) DO NOTHING;
    GET DIAGNOSTICS v_assignments_moved = ROW_COUNT;
    DELETE FROM ims_count_assignments WHERE category_id = p_from;
  END IF;

  DELETE FROM categories WHERE id = p_from;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted <> 1 THEN
    -- Under RLS a row the caller may not delete simply does not delete; raising rolls back the moves.
    RAISE EXCEPTION 'category_missing: the category could not be removed with this login'
      USING ERRCODE = 'P0001', HINT = 'category_missing';
  END IF;

  RETURN jsonb_build_object(
    'items_moved', v_items,
    'budgets_merged', v_budgets_merged,
    'budgets_moved', v_budgets_moved,
    'assignments_moved', v_assignments_moved
  );
END
$function$;

REVOKE ALL ON FUNCTION public.merge_item_category(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_item_category(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.merge_item_category(uuid, uuid) TO authenticated, service_role;

-- ══ 2. Sub-Recipes is kept ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.categories_guard_protected()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- A whole-client deletion from an operator session cascades through here; its client row is
    -- already gone by then.
    IF lower(btrim(OLD.name)) = 'sub-recipes'
       AND EXISTS (SELECT 1 FROM clients c WHERE c.id = OLD.client_id) THEN
      RAISE EXCEPTION 'category_protected: Sub-Recipes cannot be removed'
        USING ERRCODE = 'P0001', HINT = 'category_protected';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND lower(btrim(OLD.name)) = 'sub-recipes' AND NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'category_protected: Sub-Recipes cannot be renamed'
      USING ERRCODE = 'P0001', HINT = 'category_protected';
  END IF;

  -- No second spelling: the app reads the exact name 'Sub-Recipes', the HQ push reads lower(name).
  -- Only a new or changed name is tested, so a row already spelled another way can still be re-sorted.
  IF (TG_OP = 'INSERT' OR NEW.name IS DISTINCT FROM OLD.name)
     AND lower(btrim(NEW.name)) = 'sub-recipes' AND NEW.name <> 'Sub-Recipes' THEN
    RAISE EXCEPTION 'category_protected: Sub-Recipes is spelled exactly that way'
      USING ERRCODE = 'P0001', HINT = 'category_protected';
  END IF;
  IF TG_OP = 'UPDATE' AND lower(btrim(NEW.name)) = 'sub-recipes' AND lower(btrim(OLD.name)) <> 'sub-recipes' THEN
    RAISE EXCEPTION 'category_protected: another category cannot be renamed to Sub-Recipes'
      USING ERRCODE = 'P0001', HINT = 'category_protected';
  END IF;

  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.categories_guard_protected() FROM PUBLIC;

DROP TRIGGER IF EXISTS categories_guard_protected ON public.categories;
CREATE TRIGGER categories_guard_protected BEFORE INSERT OR UPDATE OR DELETE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.categories_guard_protected();

NOTIFY pgrst, 'reload schema';

-- ══ 3. Self-check (catalog values, not formatted strings) ════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.merge_item_category(uuid, uuid)'::regprocedure AND NOT prosecdef) THEN
    RAISE EXCEPTION 'S885: merge_item_category must exist and be SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', 'public.merge_item_category(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S885: anon can still execute merge_item_category';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'categories_guard_protected'
                   AND tgrelid = 'public.categories'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S885: categories_guard_protected trigger missing';
  END IF;
END $$;
