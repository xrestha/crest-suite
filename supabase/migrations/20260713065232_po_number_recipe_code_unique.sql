-- getNextPoNumber() (PurchaseOrders.js) and getNextSubRecipeCode() (Recipes.js) both derive the
-- next number/code from client-side max(existing)+1 with NO DB-level uniqueness enforcement at
-- all — two near-simultaneous creates (two tabs, a fast double-click before the first insert
-- commits) could both compute and silently insert the exact same PO number or sub-recipe code,
-- with no error from either write. Adding per-client uniqueness turns that into a catchable
-- conflict the frontend can retry against, instead of two rows quietly sharing one number.

-- Dedup any pre-existing duplicates before each constraint can be added — rename the later
-- row(s), don't drop data. This should be a no-op in practice (the bug requires exact-millisecond
-- concurrent creates) but makes the migration safe to run regardless of current data state.
WITH ranked AS (
  SELECT id, client_id, po_number,
         row_number() OVER (PARTITION BY client_id, po_number ORDER BY created_at, id) AS rn
  FROM public.purchase_orders
)
UPDATE public.purchase_orders po SET po_number = po.po_number || '-DUP' || r.rn
FROM ranked r WHERE po.id = r.id AND r.rn > 1;

ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_client_po_number_key UNIQUE (client_id, po_number);

-- recipe_code is only ever set for sub-recipes (NULL for everything else) — a partial index
-- avoids constraining the many NULL rows against each other.
WITH ranked AS (
  SELECT id, client_id, recipe_code,
         row_number() OVER (PARTITION BY client_id, recipe_code ORDER BY created_at, id) AS rn
  FROM public.recipes
  WHERE recipe_code IS NOT NULL
)
UPDATE public.recipes r SET recipe_code = r.recipe_code || '-DUP' || rk.rn
FROM ranked rk WHERE r.id = rk.id AND rk.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS recipes_client_recipe_code_key
  ON public.recipes (client_id, recipe_code) WHERE recipe_code IS NOT NULL;

NOTIFY pgrst, 'reload schema';
