-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S830, POS stage 5, slice 5f-1: the server posts a closed bill to Inventory in the close's own
-- transaction, sales and stock lines together.
--
--   Until now the till posted a bill after its close returned (postClosedBill, S809 4e): it read the
--   open month, read the bill's lines back, wrote the sales rows, then read the recipe book and wrote
--   the stock lines, best-effort. A connection lost after the close left the bill waiting for Post
--   to Inventory, and a lost stock write left a bill with revenue and no ledger rows. Now an AFTER
--   UPDATE OF status trigger on pos_orders posts every bill that closes as billed (paid or
--   Complimentary), from the STORED bill, in the close's transaction.
--
--   It checks for itself what the INVOKER guards check for the till, because inside a SECURITY
--   DEFINER body current_user is the owner and those guards wave it through: Inventory is on for
--   the outlet (clients.ims_enabled, NULL counts as on), the bill's Nepal day falls in the outlet's
--   month that is OPEN in Inventory, the bill is billed and not yet posted. Anything else leaves
--   the bill exactly as the till leaves it: unmarked, counted on the floor banner. A bill with no
--   recipe line is marked done, as the till marks it. sales_entries_stamp_pos_source still marks a
--   posted bill and still refuses a second post of it.
--
--   The post runs inside an exception block: a failed post never refuses a close (refusing a sale
--   mid-service is not acceptable). It is rolled back whole, so a bill never gets sales without
--   stock lines from this path, and it waits for Post to Inventory.
--
--   The recipe walk now exists twice (owner decision Q30 a, reversing pos-billing.md's "never a SQL
--   copy of it"): recipeCost.js and pos_bill_stock_lines below. They are held together three ways:
--   section 7a re-checks this copy against every stock line and sales row on record at apply time
--   (2026-10-13, read-only: all 71,725 lines over 4,248 bills and all 11,936 sales row groups
--   matched); section 7b builds a fixture and asserts the numbers src/modules/pos/orders/
--   serverPostTwin.test.js pins for the app's own walk; and any later change to either walk must
--   change both, with a migration whose probe asserts the new numbers.
--
--   Also: stock_movements_one_sale_per_bill_item, a unique partial index on (ref_id, source,
--   item_id) for pos_sale/pos_comp. The walk sums per bill, source and item, so a second row is
--   always a second post. Live 2026-10-13: 0 duplicates, 0 rows without a bill.
--
-- What the till does meanwhile (no app change needed in this slice). Its own post still runs after
-- the close. When the server has posted, its sales insert is refused as pos_bill_already_posted,
-- which postClosedBill already reads as posted (another device got there first), and it writes no
-- stock lines. When the server could not post, the till's post meets the same checks and usually
-- the same answer. Slice 5f-2 stops the browser writing till rows and raises the till floor.
--
-- Mirrors the app exactly, with one deliberate difference: a choice naming an item that does not
-- exist (or is not this outlet's) makes the whole post fail and the bill wait, where the app writes
-- the sales and loses all the bill's stock lines with a console error. Live: 1,999 stored choice
-- lines, every one naming an item with a numeric quantity.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13. This file replaces none of them; the post
-- relies on how they behave, so section 0 refuses any other body: sales_entries_stamp_pos_source
-- 639217f30a83b1ecc600cae2d4de7f39, ims_sales_entries_guard fb3674837ab09d384f2f089190672158,
-- ims_stock_movements_guard 0243bef6e3ee9694384e63166fbe9474, guard_pos_order_close
-- 93873af6cdb5452c412396e829e8d41a. No RPC is added to the API (every new function is revoked from
-- the browser roles), so no schema reload. No till build floor change.
--
-- Deploy order: this file alone. The app release that follows changes only the guide text.
--
-- To undo:
--   DROP TRIGGER IF EXISTS pos_orders_post_to_inventory ON public.pos_orders;
--   DROP FUNCTION IF EXISTS public.pos_orders_post_to_inventory(), public.pos_post_bill_to_ims(uuid),
--     public.pos_bill_stock_lines(uuid[]), public.pos_bill_sales_rows(uuid[]), public.pos_line_choice_lines(uuid);
--   DROP INDEX IF EXISTS public.stock_movements_one_sale_per_bill_item;
-- The till's own post then takes over again, unchanged.
--
-- The probe (section 7b) acts at BLOOM CAFE (or the first POS outlet with Inventory, an open month
-- holding today and an unblocked supervisor till login), as the migration's role and as that
-- supervisor, inside a block that rolls itself back. For a second or so it holds that outlet's
-- invoice-number lock and its open shift (FOR SHARE), so a till closing a bill there in that moment
-- waits for it. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this post relies on, and a ledger the new index can hold ──────────
DO $$
DECLARE
  v_md5 text;
  v_dup bigint;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.sales_entries_stamp_pos_source()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '639217f30a83b1ecc600cae2d4de7f39' THEN
    RAISE EXCEPTION 'S830 5f-1 pre-flight: sales_entries_stamp_pos_source changed since this was written (md5 %). Re-check the post against the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'fb3674837ab09d384f2f089190672158' THEN
    RAISE EXCEPTION 'S830 5f-1 pre-flight: ims_sales_entries_guard changed since this was written (md5 %). Re-check the post against the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_stock_movements_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '0243bef6e3ee9694384e63166fbe9474' THEN
    RAISE EXCEPTION 'S830 5f-1 pre-flight: ims_stock_movements_guard changed since this was written (md5 %). Re-check the post against the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '93873af6cdb5452c412396e829e8d41a' THEN
    RAISE EXCEPTION 'S830 5f-1 pre-flight: guard_pos_order_close changed since this was written (md5 %). Re-check the post against the live body.', v_md5;
  END IF;

  SELECT count(*) INTO v_dup
    FROM (SELECT 1 FROM public.stock_movements
           WHERE source IN ('pos_sale', 'pos_comp')
           GROUP BY ref_id, source, item_id HAVING count(*) > 1 AND ref_id IS NOT NULL) x;
  IF v_dup > 0 THEN
    RAISE EXCEPTION 'S830 5f-1 pre-flight: % bill/item pairs already have two till stock lines; clear the duplicates before this index can go on', v_dup;
  END IF;
END;
$$;


-- ── 1. One till stock line per bill, source and item ────────────────────────────────────────────
-- The walk below and the app's billMovementRows both sum per bill, source and item, so a second
-- row is always a second post: the server's and a till's, or two tills'. NULL ref_ids (a bill
-- deleted under its rows: the key is ON DELETE SET NULL) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_one_sale_per_bill_item
  ON public.stock_movements (ref_id, source, item_id)
  WHERE source IN ('pos_sale', 'pos_comp');


-- ── 2. A line's choices, as the sale stores them ───────────────────────────────────────────────
-- The SQL twin of orderLineIngredients.lineIngredientDeltas: every stock line on the line's
-- options, flattened, an item line as {item_id, qty} and a sub-recipe line as {sub_recipe_id, qty}
-- (item_id wins when both are named), a zero or unreadable quantity dropped, NULL when none is
-- left. The caller asks only for a line with a selection (selection_key <> ''), as the app does.
-- Ordered by the options' own order, so a re-run writes the same array.
CREATE OR REPLACE FUNCTION public.pos_line_choice_lines(p_line_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_agg(CASE WHEN z.item_id <> '' THEN jsonb_build_object('item_id', z.item_id, 'qty', z.qty)
                        ELSE jsonb_build_object('sub_recipe_id', z.sub_id, 'qty', z.qty) END
                   ORDER BY z.o_sort, z.o_created, z.o_id, z.n)
    FROM (
      SELECT o.sort AS o_sort, o.created_at AS o_created, o.id AS o_id, d.n,
             COALESCE(d.e ->> 'item_id', '') AS item_id,
             COALESCE(d.e ->> 'sub_recipe_id', '') AS sub_id,
             -- Number(d.qty) || 0: a JSON number, or a string that reads as one; anything else is 0.
             CASE jsonb_typeof(d.e -> 'qty')
               WHEN 'number' THEN (d.e ->> 'qty')::numeric
               WHEN 'string' THEN CASE WHEN btrim(d.e ->> 'qty') ~ '^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$'
                                       THEN btrim(d.e ->> 'qty')::numeric END
             END AS qty
        FROM pos_order_item_options o
       CROSS JOIN LATERAL jsonb_array_elements(
               CASE WHEN jsonb_typeof(o.ingredient_deltas) = 'array' THEN o.ingredient_deltas ELSE '[]'::jsonb END
             ) WITH ORDINALITY AS d(e, n)
       WHERE o.order_item_id = p_line_id
    ) z
   WHERE COALESCE(z.qty, 0) <> 0
     AND (z.item_id <> '' OR z.sub_id <> '');
$$;


-- ── 3. A bill's sales rows ─────────────────────────────────────────────────────────────────────
-- The SQL twin of backfillPosToIms.billSalesRows, without the month and day (the caller's). Only a
-- line with a recipe posts. A comped line, and every line of a Complimentary (writeoff) bill, posts
-- as pos_comp at its full price; every other line as pos at its price less the bill discount spread
-- over the bill's non-comped lines, recipe or not (closeAttempt.storedDiscountRatio: the share
-- min(1, discount / base), 0 without a base or a discount). Arithmetic in float8, as the app's.
CREATE OR REPLACE FUNCTION public.pos_bill_sales_rows(p_order_ids uuid[])
RETURNS TABLE (order_id uuid, line_id uuid, recipe_id uuid, source text, qty_sold numeric,
               unit_price numeric, vat_rate numeric, ingredient_deltas jsonb)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH b AS (
    SELECT o.id, (o.close_type = 'writeoff') AS whole_comp,
           CASE WHEN o.close_type = 'writeoff' THEN 0::float8
                WHEN x.base > 0 AND COALESCE(o.discount_amount, 0) > 0
                  THEN LEAST(1::float8, o.discount_amount::float8 / x.base)
                ELSE 0::float8 END AS disc
      FROM pos_orders o
     CROSS JOIN LATERAL (
       SELECT COALESCE(sum(i.qty::float8 * i.unit_price::float8) FILTER (WHERE NOT i.comped), 0) AS base
         FROM pos_order_items i
        WHERE i.order_id = o.id
     ) x
     WHERE o.id = ANY (p_order_ids)
  )
  SELECT b.id, i.id, i.recipe_id,
         CASE WHEN b.whole_comp OR i.comped THEN 'pos_comp' ELSE 'pos' END,
         i.qty::numeric,
         CASE WHEN b.whole_comp OR i.comped OR b.disc = 0 THEN i.unit_price
              ELSE (i.unit_price::float8 * (1 - b.disc))::numeric END,
         COALESCE(i.vat_rate, 0),
         CASE WHEN i.selection_key <> '' THEN public.pos_line_choice_lines(i.id) END
    FROM b
    JOIN pos_order_items i ON i.order_id = b.id
   WHERE i.recipe_id IS NOT NULL;
$$;


-- ── 4. A bill's stock lines: the recipe walk ───────────────────────────────────────────────────
-- The SQL twin of recipeCost.walkRecipeTree fed through pos_recipe_book (the till's book), then
-- orderLineIngredients.loadDeltaExplosion/deltaItems and backfillPosToIms.billMovementRows:
--   * A recipe line's dish is walked from the dish (scale 1, depth 0). An ingredient row naming an
--     item emits qty_per_portion × scale ÷ (yield_pct / 100), a yield of 0 or none read as 100. A
--     row naming a sub-recipe recurses into it at batches = qty_per_portion × scale ÷ its yield_qty
--     (0 or none read as 1). A node deeper than 12 below its start is not walked (MAX_DEPTH_ROUNDS).
--     Only this outlet's recipes and items are in the book, as in pos_recipe_book: another outlet's
--     sub-recipe is not followed, another outlet's item is not trimmed.
--   * A sub-recipe used twice is walked twice: a shared base is paid for once per use.
--   * A line's choices (pos_line_choice_lines): an item line ÷ its yield, a sub-recipe line × that
--     sub-recipe walked from itself per ONE output unit (its batch ÷ yield_qty).
--   * Each line's plate × the line's qty, summed per bill, source (pos_sale; pos_comp for a comped
--     line or a Complimentary bill) and item; a sum within 1e-9 of zero is dropped; the row is the
--     negative of the sum (stock taken off). Arithmetic in float8, as the app's.
CREATE OR REPLACE FUNCTION public.pos_bill_stock_lines(p_order_ids uuid[])
RETURNS TABLE (order_id uuid, source text, item_id uuid, qty numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH RECURSIVE
  lines AS (
    SELECT o.id AS order_id, o.client_id, i.id AS line_id, i.recipe_id, i.qty::float8 AS qty,
           CASE WHEN o.close_type = 'writeoff' OR i.comped THEN 'pos_comp' ELSE 'pos_sale' END AS src,
           CASE WHEN i.selection_key <> '' THEN public.pos_line_choice_lines(i.id) END AS choices
      FROM pos_orders o
      JOIN pos_order_items i ON i.order_id = o.id
     WHERE o.id = ANY (p_order_ids)
       AND i.recipe_id IS NOT NULL
  ),
  choice AS (
    -- A malformed id raises here, and the post fails whole (the bill waits) rather than silently
    -- losing the line.
    SELECT l.line_id, l.client_id,
           NULLIF(c ->> 'item_id', '')::uuid AS item_id,
           CASE WHEN COALESCE(c ->> 'item_id', '') = '' THEN NULLIF(c ->> 'sub_recipe_id', '')::uuid END AS sub_id,
           (c ->> 'qty')::float8 AS dq
      FROM lines l
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.choices, '[]'::jsonb)) c
  ),
  seeds AS (
    SELECT client_id, recipe_id AS id FROM lines
    UNION
    SELECT client_id, sub_id FROM choice WHERE sub_id IS NOT NULL
  ),
  walk (client_id, top_id, node_id, scale, depth) AS (
    SELECT s.client_id, s.id, s.id, 1::float8, 0
      FROM seeds s
      JOIN recipes r ON r.id = s.id AND r.client_id = s.client_id
    UNION ALL
    SELECT w.client_id, w.top_id, ri.sub_recipe_id,
           (ri.qty_per_portion::float8 * w.scale) / COALESCE(NULLIF(sr.yield_qty::float8, 0), 1),
           w.depth + 1
      FROM walk w
      JOIN recipe_ingredients ri ON ri.recipe_id = w.node_id AND ri.item_id IS NULL AND ri.sub_recipe_id IS NOT NULL
      JOIN recipes sr ON sr.id = ri.sub_recipe_id AND sr.client_id = w.client_id
     WHERE w.depth < 12
  ),
  per_one AS (   -- each seed's raw items for ONE plate (a dish) or ONE batch (a sub-recipe)
    SELECT w.client_id, w.top_id, ri.item_id,
           sum((ri.qty_per_portion::float8 * w.scale) / (COALESCE(NULLIF(it.yield_pct::float8, 0), 100) / 100)) AS q
      FROM walk w
      JOIN recipe_ingredients ri ON ri.recipe_id = w.node_id AND ri.item_id IS NOT NULL
      LEFT JOIN items it ON it.id = ri.item_id AND it.client_id = w.client_id
     GROUP BY w.client_id, w.top_id, ri.item_id
  ),
  choice_items AS (   -- each line's choices, per plate, as raw items
    SELECT ch.line_id, ch.item_id, ch.dq / (COALESCE(NULLIF(it.yield_pct::float8, 0), 100) / 100) AS q
      FROM choice ch
      LEFT JOIN items it ON it.id = ch.item_id AND it.client_id = ch.client_id
     WHERE ch.item_id IS NOT NULL
    UNION ALL
    SELECT ch.line_id, p.item_id, (p.q / COALESCE(NULLIF(sr.yield_qty::float8, 0), 1)) * ch.dq
      FROM choice ch
      JOIN recipes sr ON sr.id = ch.sub_id AND sr.client_id = ch.client_id
      JOIN per_one p ON p.client_id = ch.client_id AND p.top_id = ch.sub_id
     WHERE ch.sub_id IS NOT NULL
  ),
  line_items AS (
    SELECT l.order_id, l.src, p.item_id, p.q * l.qty AS q
      FROM lines l
      JOIN per_one p ON p.client_id = l.client_id AND p.top_id = l.recipe_id
    UNION ALL
    SELECT l.order_id, l.src, x.item_id, x.q * l.qty
      FROM lines l
      JOIN choice_items x ON x.line_id = l.line_id
  )
  SELECT li.order_id, li.src, li.item_id, (-sum(li.q))::numeric
    FROM line_items li
   GROUP BY li.order_id, li.src, li.item_id
  HAVING abs(sum(li.q)) > 1e-9
   ORDER BY li.order_id, li.src, li.item_id;
$$;


-- ── 5. Post one bill ───────────────────────────────────────────────────────────────────────────
-- Runs as its caller, and only the owner may call it: from the close trigger below (SECURITY
-- DEFINER, so the INVOKER guards on sales_entries and stock_movements let it through), which is
-- why every check those guards would make is made here. Returns what it did:
--   posted          sales rows and stock lines written, the bill marked (by the stamp trigger)
--   nothing_to_post no recipe line: marked, as the till marks it
--   not_billed      no such bill, or not billed
--   already         marked, or it already has till sales rows
--   no_ims          the outlet does not have Crest Inventory (left unmarked: D6, D7)
--   undated         no closed_at, or a day outside the BS calendar table
--   month_not_open  the bill's Nepali month is not the one open in Inventory (left for Post to Inventory)
-- Raises on anything else; the trigger catches it.
CREATE OR REPLACE FUNCTION public.pos_post_bill_to_ims(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bill   record;
  v_ims    boolean;
  v_day    date;
  v_month  record;
  v_period uuid;
BEGIN
  SELECT o.id, o.client_id, o.status, o.closed_at, o.ims_posted_at INTO v_bill
    FROM pos_orders o
   WHERE o.id = p_order_id
     FOR NO KEY UPDATE;
  IF NOT FOUND OR v_bill.status IS DISTINCT FROM 'billed' THEN
    RETURN 'not_billed';
  END IF;
  IF v_bill.ims_posted_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM sales_entries s
                 WHERE s.pos_order_id = p_order_id AND s.source IN ('pos', 'pos_comp')) THEN
    RETURN 'already';
  END IF;

  -- ims_sales_entries_guard's pos_outlet_no_ims: NULL counts as on, as the app's `?? true` reads it.
  SELECT c.ims_enabled INTO v_ims FROM clients c WHERE c.id = v_bill.client_id;
  IF v_ims IS FALSE THEN
    RETURN 'no_ims';
  END IF;

  -- nepalDayInPeriod: the day the bill closed in Nepal, in the outlet's month OPEN in Inventory
  -- (one per outlet). ims_closed_period_guard would refuse any other month anyway.
  v_day := (v_bill.closed_at AT TIME ZONE 'Asia/Kathmandu')::date;
  SELECT m.bs_year, m.bs_month, (v_day - m.ad_start + 1) AS bs_day INTO v_month
    FROM bs_months m
   WHERE v_day >= m.ad_start AND v_day < m.ad_start + m.days;
  IF v_day IS NULL OR v_month.bs_year IS NULL THEN
    RETURN 'undated';
  END IF;
  SELECT p.id INTO v_period
    FROM monthly_periods p
   WHERE p.client_id = v_bill.client_id
     AND p.bs_year = v_month.bs_year AND p.bs_month = v_month.bs_month
     AND p.status = 'open';
  IF v_period IS NULL THEN
    RETURN 'month_not_open';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pos_order_items i WHERE i.order_id = p_order_id AND i.recipe_id IS NOT NULL) THEN
    UPDATE pos_orders SET ims_posted_at = now() WHERE id = p_order_id AND ims_posted_at IS NULL;
    RETURN 'nothing_to_post';
  END IF;

  -- The bill's sales rows in ONE statement: sales_entries_stamp_pos_source marks the bill with them
  -- and refuses a second statement for it.
  INSERT INTO sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate,
                             pos_order_id, ingredient_deltas)
  SELECT v_period, r.recipe_id, v_month.bs_day, r.qty_sold, r.source, r.unit_price, r.vat_rate,
         r.order_id, r.ingredient_deltas
    FROM public.pos_bill_sales_rows(ARRAY[p_order_id]) r
   ORDER BY r.line_id;

  INSERT INTO stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
  SELECT v_bill.client_id, s.item_id, v_period, v_month.bs_day, s.qty, s.source, s.order_id
    FROM public.pos_bill_stock_lines(ARRAY[p_order_id]) s;

  RETURN 'posted';
END;
$$;


-- ── 6. The close posts the bill ────────────────────────────────────────────────────────────────
-- SECURITY DEFINER: the post's writes pass the INVOKER guards (it makes their checks itself, above)
-- and the browser roles need no grant on the helpers. A failed post is rolled back whole and logged;
-- the close stands, and the bill waits for Post to Inventory.
CREATE OR REPLACE FUNCTION public.pos_orders_post_to_inventory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_state text;
  v_msg   text;
  v_hint  text;
BEGIN
  BEGIN
    PERFORM public.pos_post_bill_to_ims(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
    RAISE WARNING 'pos_orders_post_to_inventory: bill % closed but was not posted to Inventory (% %: %); it waits for Post to Inventory',
      NEW.id, v_state, COALESCE(v_hint, ''), v_msg;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pos_orders_post_to_inventory ON public.pos_orders;
CREATE TRIGGER pos_orders_post_to_inventory
  AFTER UPDATE OF status ON public.pos_orders
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status = 'billed')
  EXECUTE FUNCTION public.pos_orders_post_to_inventory();

-- The owner only. A trigger function needs no grant (EXECUTE is checked at CREATE TRIGGER time).
REVOKE ALL ON FUNCTION public.pos_orders_post_to_inventory() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pos_post_bill_to_ims(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pos_bill_stock_lines(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pos_bill_sales_rows(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pos_line_choice_lines(uuid) FROM PUBLIC, anon, authenticated, service_role;


-- ── 7. Prove it ────────────────────────────────────────────────────────────────────────────────
-- 7a. Live parity: this copy of the walk and of the sales rule against every bill on record that
-- has till sales rows or till stock lines. The ledger's figures are the app's (postClosedBill and
-- the backfill), so this is the JS twin checked against the SQL one on real bills. A recipe edited
-- after a bill posted makes that bill differ legitimately; if this refuses, look at the bills it
-- names before changing anything.
DO $$
DECLARE
  v_ids        uuid[];
  v_moves      bigint;
  v_moves_bad  bigint;
  v_sales_bad  bigint;
  v_example    text;
BEGIN
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT ref_id AS id FROM public.stock_movements WHERE source IN ('pos_sale', 'pos_comp') AND ref_id IS NOT NULL
    UNION
    SELECT pos_order_id FROM public.sales_entries WHERE source IN ('pos', 'pos_comp') AND pos_order_id IS NOT NULL
  ) b;

  WITH mine AS (
    SELECT s.order_id, s.source, s.item_id, s.qty::float8 AS qty FROM public.pos_bill_stock_lines(v_ids) s
  ), theirs AS (
    SELECT m.ref_id AS order_id, m.source, m.item_id, sum(m.qty)::float8 AS qty
      FROM public.stock_movements m
     WHERE m.source IN ('pos_sale', 'pos_comp') AND m.ref_id IS NOT NULL
     GROUP BY 1, 2, 3
  ), cmp AS (
    SELECT COALESCE(a.order_id, b.order_id) AS order_id, a.qty AS mine, b.qty AS theirs
      FROM mine a FULL JOIN theirs b ON b.order_id = a.order_id AND b.source = a.source AND b.item_id = a.item_id
  )
  SELECT count(*),
         count(*) FILTER (WHERE mine IS NULL OR theirs IS NULL OR abs(mine - theirs) > 1e-6 * greatest(1, abs(theirs))),
         min(order_id::text) FILTER (WHERE mine IS NULL OR theirs IS NULL OR abs(mine - theirs) > 1e-6 * greatest(1, abs(theirs)))
    INTO v_moves, v_moves_bad, v_example
    FROM cmp;
  IF v_moves_bad > 0 THEN
    RAISE EXCEPTION 'S830 5f-1 parity: % of % till stock lines differ from the SQL walk (e.g. bill %)', v_moves_bad, v_moves, v_example;
  END IF;

  WITH mine AS (
    SELECT r.order_id, r.recipe_id, r.source, r.qty_sold, round(r.unit_price, 3) AS up, r.vat_rate,
           (SELECT jsonb_agg(e ORDER BY e ->> 'item_id', e ->> 'sub_recipe_id', e ->> 'qty')
              FROM jsonb_array_elements(COALESCE(r.ingredient_deltas, '[]'::jsonb)) e) AS deltas
      FROM public.pos_bill_sales_rows(v_ids) r
  ), theirs AS (
    SELECT s.pos_order_id AS order_id, s.recipe_id, s.source, s.qty_sold, round(s.unit_price, 3) AS up, s.vat_rate,
           (SELECT jsonb_agg(e ORDER BY e ->> 'item_id', e ->> 'sub_recipe_id', e ->> 'qty')
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.ingredient_deltas) = 'array' THEN s.ingredient_deltas ELSE '[]'::jsonb END) e) AS deltas
      FROM public.sales_entries s
     WHERE s.source IN ('pos', 'pos_comp') AND s.pos_order_id = ANY (v_ids)
  ), km AS (
    SELECT order_id, recipe_id, source, qty_sold, up, vat_rate, deltas, count(*) AS n FROM mine GROUP BY 1, 2, 3, 4, 5, 6, 7
  ), kt AS (
    SELECT order_id, recipe_id, source, qty_sold, up, vat_rate, deltas, count(*) AS n FROM theirs GROUP BY 1, 2, 3, 4, 5, 6, 7
  )
  SELECT count(DISTINCT COALESCE(a.order_id, b.order_id)), min(COALESCE(a.order_id, b.order_id)::text)
    INTO v_sales_bad, v_example
    FROM km a FULL JOIN kt b
      ON b.order_id = a.order_id AND b.recipe_id = a.recipe_id AND b.source = a.source AND b.qty_sold = a.qty_sold
     AND b.up = a.up AND b.vat_rate IS NOT DISTINCT FROM a.vat_rate AND b.deltas IS NOT DISTINCT FROM a.deltas
   WHERE a.n IS DISTINCT FROM b.n;
  IF v_sales_bad > 0 THEN
    RAISE EXCEPTION 'S830 5f-1 parity: % bills'' till sales rows differ from the SQL rule (e.g. bill %)', v_sales_bad, v_example;
  END IF;

  RAISE NOTICE 'S830 5f-1 parity: % bills, % till stock lines and every till sales row match', cardinality(v_ids), v_moves;
END;
$$;

-- 7b. The fixture, closed, posted and checked. The same dishes, bills and numbers as
-- src/modules/pos/orders/serverPostTwin.test.js (B1, B2), plus what only the server decides.
DO $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_client  uuid;
  v_period  uuid;
  v_start   date;
  v_sup     uuid;
  v_fy      text;
  v_chicken uuid; v_flour uuid; v_oil uuid; v_cheese uuid;
  v_dough   uuid; v_sauce uuid; v_pizza uuid; v_wrap uuid;
  v_b1 uuid; v_b2 uuid; v_b3 uuid; v_b4 uuid; v_b5 uuid; v_b6 uuid; v_b7 uuid;
  v_line    uuid;
  v_day1    timestamptz;
  v_prev    timestamptz;
  v_got     jsonb;
  v_want    jsonb;
  v_kv      record;
  v_row     record;
  v_n       integer;
  v_state   text;
  v_hint    text;
  v_msg     text;
BEGIN
  -- ── Where: a POS outlet with Inventory, its open month holding today, a supervisor till login ──
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND c.ims_enabled IS NOT FALSE
     AND EXISTS (SELECT 1 FROM public.monthly_periods mp
                   JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
                  WHERE mp.client_id = c.id AND mp.status = 'open'
                    AND v_today >= m.ad_start AND v_today < m.ad_start + m.days)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S830 5f-1 probe: no POS outlet with Inventory, an open month holding today and an unblocked supervisor till login';
  END IF;
  SELECT mp.id, m.ad_start INTO v_period, v_start
    FROM public.monthly_periods mp JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
   WHERE mp.client_id = v_client AND mp.status = 'open';
  SELECT p.id INTO v_sup FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  v_fy   := public.pos_invoice_fy(now());
  v_day1 := (v_start + time '00:15') AT TIME ZONE 'Asia/Kathmandu';       -- day 1, 18:30 UTC the day before
  v_prev := (v_start - 1 + time '23:50') AT TIME ZONE 'Asia/Kathmandu';   -- the month before's last day

  BEGIN
    -- ── Setup, as the migration's own role (every guard lets it through) ───────────────────────
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S830 5f probe chicken', 'kg', 1, 0, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S830 5f probe flour', 'kg', 1, 0, 100) RETURNING id INTO v_flour;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S830 5f probe oil', 'l', 1, 0, 0) RETURNING id INTO v_oil;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S830 5f probe cheese', 'kg', 1, 0, 50) RETURNING id INTO v_cheese;

    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S830 5f probe dough', 'Sub-Recipe', 2) RETURNING id INTO v_dough;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S830 5f probe sauce', 'Sub-Recipe', 4) RETURNING id INTO v_sauce;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S830 5f probe pizza', 'Food', 1) RETURNING id INTO v_pizza;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S830 5f probe wrap', 'Food', 1) RETURNING id INTO v_wrap;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, sub_recipe_id, qty_per_portion) VALUES
      (v_dough, v_flour, NULL, 0.5), (v_dough, v_oil, NULL, 0.1),
      (v_sauce, NULL, v_dough, 1),   (v_sauce, v_chicken, NULL, 0.2),
      (v_pizza, v_flour, NULL, 0.1), (v_pizza, NULL, v_dough, 1), (v_pizza, NULL, v_sauce, 2), (v_pizza, v_cheese, NULL, 0.05),
      (v_wrap, v_chicken, NULL, 0.3);

    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_b1;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_b2;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_b3;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_b4;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_b5;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_b6;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_b7;

    -- B1 (the twin's): pizza ×2 @500; a customized wrap @300; a comped wrap @300 carrying options but
    -- no selection (ignored); an open item @200 (in the discount base, posts nothing); NPR 100 off.
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_b1, v_client, 'S830 5f probe pizza', v_pizza, 2, 500, 0.13),
      (v_b1, v_client, 'S830 5f probe water', NULL, 1, 200, 0.13);
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, selection_key)
      VALUES (v_b1, v_client, 'S830 5f probe wrap', v_wrap, 1, 300, 0.13, 'probe') RETURNING id INTO v_line;
    INSERT INTO public.pos_order_item_options (client_id, order_id, order_item_id, option_name, sort, ingredient_deltas) VALUES
      (v_client, v_b1, v_line, 'Extra cheese', 0,
       jsonb_build_array(jsonb_build_object('item_id', v_cheese, 'qty', 0.02), jsonb_build_object('item_id', v_chicken, 'qty', 0))),
      (v_client, v_b1, v_line, 'Sauce on the side', 1,
       jsonb_build_array(jsonb_build_object('sub_recipe_id', v_sauce, 'qty', 0.5)));
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, comped, comp_no, comp_fy, comp_reason)
      VALUES (v_b1, v_client, 'S830 5f probe wrap', v_wrap, 1, 300, 0.13, true, 999999, v_fy, 'S830 5f probe') RETURNING id INTO v_line;
    INSERT INTO public.pos_order_item_options (client_id, order_id, order_item_id, option_name, ingredient_deltas)
      VALUES (v_client, v_b1, v_line, 'Extra cheese', jsonb_build_array(jsonb_build_object('item_id', v_cheese, 'qty', 0.02)));
    -- B2 (the twin's): a Complimentary bill of wrap ×3 @300, with a stored discount it ignores.
    -- B3: only an open item. B4: a wrap closed on the month before's last day. B5: a wrap closed
    -- while Inventory is off. B6: a wrap whose choice names an item that does not exist. B7: a wrap
    -- the supervisor closes through the full close guard.
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_b2, v_client, 'S830 5f probe wrap', v_wrap, 3, 300, 0.13),
      (v_b3, v_client, 'S830 5f probe water', NULL, 1, 200, 0.13),
      (v_b4, v_client, 'S830 5f probe wrap', v_wrap, 1, 300, 0.13),
      (v_b5, v_client, 'S830 5f probe wrap', v_wrap, 1, 300, 0.13),
      (v_b7, v_client, 'S830 5f probe wrap', v_wrap, 1, 300, 0.13);
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, selection_key)
      VALUES (v_b6, v_client, 'S830 5f probe wrap', v_wrap, 1, 300, 0.13, 'probe') RETURNING id INTO v_line;
    INSERT INTO public.pos_order_item_options (client_id, order_id, order_item_id, option_name, ingredient_deltas)
      VALUES (v_client, v_b6, v_line, 'Missing item', jsonb_build_array(jsonb_build_object('item_id', gen_random_uuid(), 'qty', 1)));

    -- ── Closes as the migration's role (the close guard steps aside; the post trigger does not) ──
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 100,
           paid_amount = 1500, invoice_fy = v_fy, closed_at = v_day1
     WHERE id = v_b1;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'writeoff', discount_amount = 50, invoice_fy = v_fy, closed_at = v_day1
     WHERE id = v_b2;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 226, invoice_fy = v_fy, closed_at = v_day1
     WHERE id = v_b3;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy, closed_at = v_prev
     WHERE id = v_b4;
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy, closed_at = v_day1
     WHERE id = v_b5;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy, closed_at = v_day1
     WHERE id = v_b6;

    -- (1) B1's sales rows: three, dated day 1 of the open month, the bill marked.
    SELECT count(*) INTO v_n FROM public.sales_entries WHERE pos_order_id = v_b1;
    IF v_n <> 3 THEN RAISE EXCEPTION 'S830 5f-1 probe: B1 posted % sales rows, not 3', v_n; END IF;
    IF EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b1
                AND (period_id <> v_period OR bs_day <> 1 OR vat_rate <> 0.13 OR pos_credit_note_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'S830 5f-1 probe: B1''s sales rows are not all day 1 of the open month at 13%% VAT';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b1 AND recipe_id = v_pizza
                    AND source = 'pos' AND qty_sold = 2 AND abs(unit_price - 466.6666666666667) < 1e-6 AND ingredient_deltas IS NULL)
       OR NOT EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b1 AND recipe_id = v_wrap
                       AND source = 'pos' AND qty_sold = 1 AND abs(unit_price - 280) < 1e-6
                       AND ingredient_deltas @> jsonb_build_array(jsonb_build_object('item_id', v_cheese::text, 'qty', 0.02),
                                                                  jsonb_build_object('sub_recipe_id', v_sauce::text, 'qty', 0.5))
                       AND jsonb_array_length(ingredient_deltas) = 2)
       OR NOT EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b1 AND recipe_id = v_wrap
                       AND source = 'pos_comp' AND qty_sold = 1 AND unit_price = 300 AND ingredient_deltas IS NULL) THEN
      SELECT jsonb_agg(jsonb_build_object('recipe', recipe_id, 'source', source, 'qty', qty_sold, 'price', unit_price, 'deltas', ingredient_deltas))
        INTO v_got FROM public.sales_entries WHERE pos_order_id = v_b1;
      RAISE EXCEPTION 'S830 5f-1 probe: B1''s sales rows are not the twin''s: %', v_got;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b1) IS NULL THEN
      RAISE EXCEPTION 'S830 5f-1 probe: B1 posted but was not marked';
    END IF;

    -- (2) B1's stock lines: the twin's five, nothing else, each linked and dated.
    v_want := jsonb_build_object(
      'pos_sale:flour', -0.98125, 'pos_sale:oil', -0.15625, 'pos_sale:chicken', -10.5 / 17.0,
      'pos_sale:cheese', -0.24, 'pos_comp:chicken', -6 / 17.0);
    SELECT jsonb_object_agg(m.source || ':' || replace(i.name, 'S830 5f probe ', ''), m.qty), count(*)
      INTO v_got, v_n
      FROM public.stock_movements m JOIN public.items i ON i.id = m.item_id
     WHERE m.ref_id = v_b1 AND m.client_id = v_client AND m.period_id = v_period AND m.bs_day = 1;
    IF v_n <> 5 OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b1) <> 5 THEN
      RAISE EXCEPTION 'S830 5f-1 probe: B1 wrote % dated stock lines (want 5): %', v_n, v_got;
    END IF;
    FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_want) LOOP
      IF v_got ->> v_kv.key IS NULL OR abs((v_got ->> v_kv.key)::numeric - v_kv.value::numeric) > 1e-9 THEN
        RAISE EXCEPTION 'S830 5f-1 probe: B1''s % is % (the twin''s is %); all: %', v_kv.key, v_got ->> v_kv.key, v_kv.value, v_got;
      END IF;
    END LOOP;

    -- (3) B2, Complimentary: one pos_comp row at full price, its discount ignored; chicken 18/17.
    IF (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_b2) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b2 AND recipe_id = v_wrap
                       AND source = 'pos_comp' AND qty_sold = 3 AND unit_price = 300) THEN
      RAISE EXCEPTION 'S830 5f-1 probe: B2 (Complimentary) did not post one pos_comp row of 3 at NPR 300';
    END IF;
    IF (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b2) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_b2 AND item_id = v_chicken
                       AND source = 'pos_comp' AND abs(qty + 18 / 17.0) < 1e-9) THEN
      RAISE EXCEPTION 'S830 5f-1 probe: B2''s stock line is not pos_comp chicken -18/17';
    END IF;

    -- (4) B3, only an open item: nothing written, marked done.
    IF EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b3)
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_b3)
       OR (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b3) IS NULL THEN
      RAISE EXCEPTION 'S830 5f-1 probe: B3 (no dish) was not marked done with nothing written';
    END IF;

    -- (5) B4 (the month before), B5 (Inventory off), B6 (a failed post): closed, numbered, nothing
    --     written, unmarked, so the floor banner counts them.
    FOR v_row IN SELECT o.id, o.status, o.invoice_no, o.ims_posted_at FROM public.pos_orders o WHERE o.id IN (v_b4, v_b5, v_b6) LOOP
      IF v_row.status <> 'billed' OR v_row.invoice_no IS NULL THEN
        RAISE EXCEPTION 'S830 5f-1 probe: bill % did not stay closed and numbered (%, %)', v_row.id, v_row.status, v_row.invoice_no;
      END IF;
      IF v_row.ims_posted_at IS NOT NULL
         OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_row.id)
         OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_row.id) THEN
        RAISE EXCEPTION 'S830 5f-1 probe: bill % (B4 another month, B5 Inventory off, B6 a failed post) was posted or marked', v_row.id;
      END IF;
    END LOOP;

    -- ── B7: the outlet's supervisor closes a bill on a till of this release ─────────────────────
    -- A Charge needs an open shift; one is opened here if the outlet has none (rolled back with
    -- everything else).
    IF NOT EXISTS (SELECT 1 FROM public.pos_shifts WHERE client_id = v_client AND status = 'open') THEN
      INSERT INTO public.pos_shifts (client_id) VALUES (v_client);
    END IF;
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sup)::text, true);
    SET LOCAL ROLE authenticated;

    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339
     WHERE id = v_b7;

    -- (6) Posted in the close, under today's Nepali day, and marked.
    IF (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_b7 AND period_id = v_period
         AND bs_day = v_today - v_start + 1 AND source = 'pos' AND recipe_id = v_wrap AND unit_price = 300) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b7 AND item_id = v_chicken
            AND source = 'pos_sale' AND bs_day = v_today - v_start + 1 AND abs(qty + 6 / 17.0) < 1e-9) <> 1
       OR (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b7) IS NULL THEN
      RAISE EXCEPTION 'S830 5f-1 probe: the supervisor''s close of B7 was not posted under today''s day (%) and marked',
        v_today - v_start + 1;
    END IF;

    -- (7) The till's own post after it is turned away as already posted, which postClosedBill reads
    --     as posted, and a second stock line for the bill is refused by the index.
    v_hint := NULL;
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
        VALUES (v_period, v_wrap, v_today - v_start + 1, 1, 'pos', 300, 0.13, v_b7);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_bill_already_posted' THEN
      RAISE EXCEPTION 'S830 5f-1 probe: the till''s post after the server''s answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    v_state := NULL;
    BEGIN
      INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
        VALUES (v_client, v_chicken, v_period, v_today - v_start + 1, -1, 'pos_sale', v_b7);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    END;
    IF v_state IS DISTINCT FROM '23505' THEN
      RAISE EXCEPTION 'S830 5f-1 probe: a second stock line for B7''s chicken answered % (%)', COALESCE(v_state, 'nothing'), v_msg;
    END IF;

    -- (8) The browser cannot call the post or the walk.
    IF has_function_privilege('authenticated', 'public.pos_post_bill_to_ims(uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_bill_stock_lines(uuid[])', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_bill_sales_rows(uuid[])', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_line_choice_lines(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.pos_post_bill_to_ims(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'S830 5f-1 probe: a browser role can execute the post or the walk';
    END IF;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's830_5f1_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's830_5f1_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 8. What this slice acts on, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT count(*) FROM public.pos_orders WHERE status = 'billed' AND ims_posted_at IS NULL) AS bills_waiting,
  (SELECT count(*) FROM public.stock_movements WHERE source IN ('pos_sale', 'pos_comp')) AS till_stock_lines,
  (SELECT count(*) FROM pg_indexes WHERE indexname = 'stock_movements_one_sale_per_bill_item') AS sale_line_index,
  (SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'pos_orders_post_to_inventory' AND NOT tgisinternal) AS post_trigger,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_post_bill_to_ims(uuid)'::regprocedure) AS post_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_bill_stock_lines(uuid[])'::regprocedure) AS walk_md5;

-- Read back after applying (one statement per call):
--   SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'pos_orders_post_to_inventory';
--     expect AFTER UPDATE OF status … WHEN ((old.status = 'open') AND (new.status = 'billed'))
--   SELECT p.proname, p.prosecdef, has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     FROM pg_proc p WHERE p.proname IN ('pos_orders_post_to_inventory', 'pos_post_bill_to_ims',
--       'pos_bill_stock_lines', 'pos_bill_sales_rows', 'pos_line_choice_lines');
--     expect DEFINER only on the trigger function, and no EXECUTE for authenticated on any.
