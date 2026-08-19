-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S576 — an item already fired to the kitchen could be removed by any Staff-rank account with no
-- permission, no reason, and no record that it ever existed.
--
-- save_pos_order_items() replaces an order's lines WHOLESALE (`DELETE ... ; INSERT ...`), which is
-- correct and deliberate — it is what made the save atomic in S573. The consequence nobody had
-- accounted for is that a line carrying `sent_to_kot = true` simply ceases to exist on the next
-- save. The food was cooked. The ticket printed. Then the line is gone from pos_order_items, gone
-- from the bill, and gone from every report that reads either — and the ONLY surviving trace is
-- pos_kot_log, which is why the phase-6 critique recorded this as "caught after the fact by KOT
-- Reconciliation only": that page can tell you a ticket exists with no matching bill line, but not
-- who pulled it, when, or why.
--
-- That is the classic till shrinkage route — ring it, fire it, serve it, pull the line before
-- charging — and it needs no privilege at all today.
--
-- THE FIX IS A RECORD, NOT A BLOCK, and that is a deliberate call. Pulling a fired item is a
-- legitimate and routine thing (wrong table, customer changed their mind, kitchen 86'd it), and
-- rank-gating it would stall a live service behind a manager on every genuine mistake. What was
-- missing is attribution, so attribution is what this adds: every removal of an already-sent
-- quantity writes a row naming the item, the quantity, the account and the time, and the frontend
-- asks for a reason before it lets the removal through.
--
-- The detection lives in the RPC rather than the browser for the same reason the discount cap
-- moved into a trigger in 20260819120000: a check the client can decline to run is advisory. Here
-- the diff is computed from the rows already in the table against the rows being written, inside
-- the same transaction as the replacement — so a caller cannot remove a line without producing
-- the record, whatever it sends.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. The record ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_kot_removals (
  id           uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- CASCADE, unlike pos_cash_movements' SET NULL: a removal is only meaningful as part of the
  -- order it was pulled from, and an orphan row would be evidence of nothing in particular.
  order_id     uuid NOT NULL REFERENCES public.pos_orders(id) ON DELETE CASCADE,
  -- Nullable and SET NULL so deleting a recipe never destroys the record. item_name is captured
  -- alongside it precisely so the row stays readable when the recipe is gone or renamed — the
  -- same resolve-at-write-time rule the Monthly Owner Report snapshot follows.
  recipe_id    uuid REFERENCES public.recipes(id) ON DELETE SET NULL,
  item_name    text NOT NULL,
  qty_removed  integer NOT NULL CHECK (qty_removed > 0),
  reason       text,
  removed_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  removed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_kot_removals_order  ON public.pos_kot_removals (order_id);
-- The report reads a BS-day window per client, so client_id leads and the timestamp follows.
CREATE INDEX IF NOT EXISTS idx_pos_kot_removals_client ON public.pos_kot_removals (client_id, removed_at);

ALTER TABLE public.pos_kot_removals ENABLE ROW LEVEL SECURITY;

-- Same-client-or-admin, with auth.uid() wrapped in a SELECT so the planner runs it once per
-- statement rather than once per row (the S542 initplan rule).
CREATE POLICY pos_kot_removals_client ON public.pos_kot_removals
  TO authenticated
  USING (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  )
  WITH CHECK (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  );

-- Staff-account isolation, mirroring pos_order_items exactly: HR self-service, IMS staff and HR
-- staff accounts are fenced off. POS PIN staff are deliberately NOT blocked — they are the ones
-- whose removals this table records, and save_pos_order_items runs as INVOKER, so a policy that
-- excluded them would make the INSERT fail and take the whole save down with it.
CREATE POLICY no_self_service_accounts ON public.pos_kot_removals AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_ims_staff ON public.pos_kot_removals AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
CREATE POLICY no_hr_role_staff ON public.pos_kot_removals AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

-- Raw-SQL tables get NO role grants in this project by default — without this the table is
-- invisible to the app even with RLS correct. No UPDATE and no DELETE for `authenticated` on
-- purpose: this is an audit record, and a till session that can rewrite it has gained nothing
-- from it existing. Admins clear it through the service role (Danger Zone) like every other
-- client-scoped table.
GRANT SELECT, INSERT ON public.pos_kot_removals TO authenticated;
GRANT ALL ON public.pos_kot_removals TO service_role;

-- ── 2. save_pos_order_items, now recording what it deletes ───────────────────────────────────
-- The 2-arg signature is DROPPED rather than kept alongside, which is a deliberate exception to
-- the standing rule in .claude/rules/supabase-sql.md ("keep the old arity rather than dropping it —
-- the service worker is cache-first, so a device can still be running a bundle that calls it").
-- Keeping both is not an option here: PostgREST resolves an RPC by ARGUMENT NAME, so a call
-- carrying {p_order_id, p_rows} would match a 2-arg function AND a 3-arg one with a DEFAULT, and
-- Postgres answers that with "function is not unique" — every save would fail, on every device.
-- Dropping the old arity is what makes the stale-bundle case work rather than what breaks it: the
-- old call binds to this function and takes the default, so a device on last week's bundle keeps
-- saving orders and simply records its removals with no reason attached — strictly more than the
-- nothing it records today.
DROP FUNCTION IF EXISTS public.save_pos_order_items(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.save_pos_order_items(
  p_order_id        uuid,
  p_rows            jsonb,
  p_removal_reason  text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_client_id uuid;
  v_inserted  integer := 0;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id is required';
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a json array';
  END IF;

  -- client_id is derived from the order, never taken as a parameter — a caller must not be able
  -- to stamp someone else's client onto these rows. If RLS hides the order from this caller the
  -- SELECT finds nothing and we refuse, which is also the correct answer for a bad id.
  SELECT client_id INTO v_client_id FROM pos_orders WHERE id = p_order_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'order not found or not visible: %', p_order_id;
  END IF;

  -- ── Record any already-fired quantity about to disappear ───────────────────────────────────
  -- Matched on recipe_id where there is one and on name otherwise, which is the same identity
  -- addItem() uses to merge a re-tapped item into its existing line, so a line and its
  -- replacement are recognised as the same thing.
  --
  -- The comparison is old SENT qty vs new TOTAL qty, not sent vs sent: the client clears
  -- sent_to_kot on a line it intends to re-fire, and treating that as a removal would file a
  -- record every time an order is edited and re-sent. Only a genuine shortfall counts.
  --
  -- comped rows are excluded from the "before" side. A comp is already its own audited event
  -- (comp_no, comped_by, comped_at, a printed Complimentary Slip) and apply_pos_item_comps splits
  -- a partially-comped line in two, so counting them here would file a phantom removal against
  -- the very act the comp record already covers.
  WITH before_sent AS (
    SELECT COALESCE(recipe_id::text, name) AS k,
           MIN(recipe_id::text)            AS rid,
           MIN(name)                       AS nm,
           SUM(qty)                        AS sent_qty
      FROM pos_order_items
     WHERE order_id = p_order_id
       AND COALESCE(sent_to_kot, false) = true
       AND COALESCE(comped, false)      = false
     GROUP BY COALESCE(recipe_id::text, name)
  ), after_all AS (
    SELECT COALESCE(NULLIF(r->>'recipe_id', ''), r->>'name') AS k,
           SUM(COALESCE((r->>'qty')::integer, 1))            AS qty
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
     GROUP BY COALESCE(NULLIF(r->>'recipe_id', ''), r->>'name')
  )
  INSERT INTO pos_kot_removals (client_id, order_id, recipe_id, item_name, qty_removed, reason, removed_by)
  SELECT v_client_id, p_order_id, b.rid::uuid, b.nm,
         (b.sent_qty - COALESCE(a.qty, 0))::integer,
         NULLIF(BTRIM(COALESCE(p_removal_reason, '')), ''),
         (SELECT auth.uid())
    FROM before_sent b
    LEFT JOIN after_all a ON a.k = b.k
   WHERE b.sent_qty - COALESCE(a.qty, 0) > 0;

  -- Both statements run inside this function's single transaction: either the replacement lands
  -- whole or the original lines are still there. That is the entire point of the change.
  DELETE FROM pos_order_items WHERE order_id = p_order_id;

  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO pos_order_items (
    order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, notes
  )
  SELECT
    p_order_id,
    v_client_id,
    NULLIF(r->>'recipe_id', '')::uuid,
    r->>'name',
    COALESCE(NULLIF(r->>'category', ''), 'Other'),
    COALESCE((r->>'qty')::integer, 1),
    COALESCE((r->>'unit_price')::numeric, 0),
    COALESCE((r->>'vat_rate')::numeric, 0),
    COALESCE((r->>'sent_to_kot')::boolean, false),
    NULLIF(r->>'notes', '')
  FROM jsonb_array_elements(p_rows) AS r;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

-- Raw-SQL objects get no grants by default in this project.
REVOKE ALL ON FUNCTION public.save_pos_order_items(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_pos_order_items(uuid, jsonb, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
