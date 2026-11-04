-- S876 PERF-10: Settings' "Renumber All" codes in one request, all or nothing.
--
-- Settings.js renumbered items, vendors and sub-recipes with one PATCH per row, each waiting for the
-- last (300 items = 300 round trips), and a dropped connection part-way left the list half renumbered;
-- for sub-recipes, whose recipe_code is unique per client, it could leave rows with no code at all.
-- renumber_codes() does the same work in one call and one transaction.
--
-- SECURITY INVOKER on purpose: every row is read and written under the caller's own RLS, the restrictive
-- staff-isolation policies and the per-row guards (ims_items_guard, ims_vendors_guard, guard_recipe_rank,
-- log_audit), exactly as the per-row PATCHes were. A guard's refusal raises and rolls the whole run back.
-- An UPDATE that RLS silently skips is caught by the closing check, which raises renumber_refused.
--
-- The numbering is the page's: rows ordered by name, then id (the PostgREST .order('name').order('id')),
-- numbered <PREFIX>-001, -002, ... with String(n).padStart(3, '0')'s width (1000 stays 1000).
--   items        real items only (is_sub_recipe = false): a sub-recipe's mirror row keeps the sub-recipe code
--   vendors      every vendor, archived included (vendor_code has no unique index; see Settings.js)
--   sub_recipes  recipes in the Sub-Recipe category, then each one's mirror row in items (linked_item_id).
--                Two passes, because recipes_client_recipe_code_key is unique per client and is checked
--                row by row: clear the codes that move, then write the new ones. A code already held by
--                a menu recipe makes the index refuse, and nothing changes.
-- Only rows whose code actually changes are written, so the audit log records the moves and nothing else.
--
-- Returns {"total": rows numbered, "changed": rows whose code moved}.
-- The prefix itself is still saved by the page (saveSettings), before this is called.
--
-- Reverse: DROP FUNCTION public.renumber_codes(uuid, text, text); the page's old per-row loop is in git.

BEGIN;

CREATE OR REPLACE FUNCTION public.renumber_codes(p_client_id uuid, p_kind text, p_prefix text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_prefix  text := upper(btrim(coalesce(p_prefix, '')));
  v_total   int;
  v_changed int;
BEGIN
  IF NOT COALESCE(p_client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false) THEN
    RAISE EXCEPTION 'renumber_codes: you can renumber only the outlet you are signed in to'
      USING ERRCODE = '42501', HINT = 'renumber_wrong_outlet';
  END IF;
  IF v_prefix = '' THEN
    RAISE EXCEPTION 'renumber_codes: a code prefix is needed'
      USING ERRCODE = '22023', HINT = 'renumber_no_prefix';
  END IF;

  IF p_kind = 'items' THEN
    SELECT count(*) INTO v_total
    FROM public.items
    WHERE client_id = p_client_id AND is_sub_recipe = false;

    WITH numbered AS (
      SELECT id, v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
      FROM (SELECT id, row_number() OVER (ORDER BY name, id) AS n
            FROM public.items
            WHERE client_id = p_client_id AND is_sub_recipe = false) s
    ), moved AS (
      UPDATE public.items i
      SET item_code = nb.code
      FROM numbered nb
      WHERE i.id = nb.id AND i.item_code IS DISTINCT FROM nb.code
      RETURNING 1
    )
    SELECT count(*) INTO v_changed FROM moved;

    IF EXISTS (
      SELECT 1
      FROM (SELECT id, item_code, v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
            FROM (SELECT id, item_code, row_number() OVER (ORDER BY name, id) AS n
                  FROM public.items
                  WHERE client_id = p_client_id AND is_sub_recipe = false) s) c
      WHERE c.item_code IS DISTINCT FROM c.code
    ) THEN
      RAISE EXCEPTION 'renumber_codes: some items could not be changed, so none were'
        USING ERRCODE = '42501', HINT = 'renumber_refused';
    END IF;

  ELSIF p_kind = 'vendors' THEN
    SELECT count(*) INTO v_total
    FROM public.vendors
    WHERE client_id = p_client_id;

    WITH numbered AS (
      SELECT id, v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
      FROM (SELECT id, row_number() OVER (ORDER BY name, id) AS n
            FROM public.vendors
            WHERE client_id = p_client_id) s
    ), moved AS (
      UPDATE public.vendors v
      SET vendor_code = nb.code
      FROM numbered nb
      WHERE v.id = nb.id AND v.vendor_code IS DISTINCT FROM nb.code
      RETURNING 1
    )
    SELECT count(*) INTO v_changed FROM moved;

    IF EXISTS (
      SELECT 1
      FROM (SELECT id, vendor_code, v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
            FROM (SELECT id, vendor_code, row_number() OVER (ORDER BY name, id) AS n
                  FROM public.vendors
                  WHERE client_id = p_client_id) s) c
      WHERE c.vendor_code IS DISTINCT FROM c.code
    ) THEN
      RAISE EXCEPTION 'renumber_codes: some vendors could not be changed, so none were'
        USING ERRCODE = '42501', HINT = 'renumber_refused';
    END IF;

  ELSIF p_kind = 'sub_recipes' THEN
    SELECT count(*) INTO v_total
    FROM public.recipes
    WHERE client_id = p_client_id AND category = 'Sub-Recipe';

    -- Pass 1: clear every code that is about to move (the unique index is partial; NULLs are free).
    WITH numbered AS (
      SELECT id, v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
      FROM (SELECT id, row_number() OVER (ORDER BY name, id) AS n
            FROM public.recipes
            WHERE client_id = p_client_id AND category = 'Sub-Recipe') s
    ), cleared AS (
      UPDATE public.recipes r
      SET recipe_code = NULL
      FROM numbered nb
      WHERE r.id = nb.id AND r.recipe_code IS DISTINCT FROM nb.code
      RETURNING 1
    )
    SELECT count(*) INTO v_changed FROM cleared;

    -- Pass 2: write the new codes.
    WITH numbered AS (
      SELECT id, v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
      FROM (SELECT id, row_number() OVER (ORDER BY name, id) AS n
            FROM public.recipes
            WHERE client_id = p_client_id AND category = 'Sub-Recipe') s
    )
    UPDATE public.recipes r
    SET recipe_code = nb.code
    FROM numbered nb
    WHERE r.id = nb.id AND r.recipe_code IS DISTINCT FROM nb.code;

    -- The mirror row in items prints the same code on every ingredient line that uses the sub-recipe.
    WITH numbered AS (
      SELECT linked_item_id, v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
      FROM (SELECT linked_item_id, row_number() OVER (ORDER BY name, id) AS n
            FROM public.recipes
            WHERE client_id = p_client_id AND category = 'Sub-Recipe') s
      WHERE linked_item_id IS NOT NULL
    )
    UPDATE public.items i
    SET item_code = nb.code
    FROM numbered nb
    WHERE i.id = nb.linked_item_id AND i.client_id = p_client_id AND i.item_code IS DISTINCT FROM nb.code;

    IF EXISTS (
      SELECT 1
      FROM (SELECT id, recipe_code, linked_item_id,
                   v_prefix || '-' || lpad(n::text, greatest(3, length(n::text)), '0') AS code
            FROM (SELECT id, recipe_code, linked_item_id, row_number() OVER (ORDER BY name, id) AS n
                  FROM public.recipes
                  WHERE client_id = p_client_id AND category = 'Sub-Recipe') s) c
      LEFT JOIN public.items i ON i.id = c.linked_item_id AND i.client_id = p_client_id
      WHERE c.recipe_code IS DISTINCT FROM c.code
         OR (i.id IS NOT NULL AND i.item_code IS DISTINCT FROM c.code)
    ) THEN
      RAISE EXCEPTION 'renumber_codes: some sub-recipes could not be changed, so none were'
        USING ERRCODE = '42501', HINT = 'renumber_refused';
    END IF;

  ELSE
    RAISE EXCEPTION 'renumber_codes: unknown kind %', p_kind
      USING ERRCODE = '22023', HINT = 'renumber_bad_kind';
  END IF;

  RETURN jsonb_build_object('total', v_total, 'changed', v_changed);
END;
$$;

REVOKE ALL ON FUNCTION public.renumber_codes(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renumber_codes(uuid, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
