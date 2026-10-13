-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S830, POS stage 5, slice 5f-2, step 1 of 2: waiting bills are posted by the server too.
--
--   5f-1 (20261013160000) made the close post its own bill. A bill that closed while its month was
--   not open in Inventory (or at an outlet with Inventory off, or whose post failed) still waits, and
--   the floor banner's "Post to Inventory" and Periods' "Post POS bills to Inventory" posted those
--   from the browser (backfillPosOrdersToIms): read the bills, walk the recipe book, write the sales,
--   then the stock lines best-effort. Now both call post_waiting_pos_bills, which posts a month's
--   waiting bills through the same server step as the close.
--
--   pos_post_bill_into(bill, period) is that step, taken out of 5f-1's pos_post_bill_to_ims: the
--   checks the INVOKER guards would make (the bill billed and of the period's outlet, not yet posted,
--   Inventory on, its Nepal day inside the period's month) and the writes (sales rows in one
--   statement, then stock lines). A bill whose till sales are already in Inventory but which carries
--   no mark (a post from before the mark existed) is marked, as Periods' pre-stamp did, never posted
--   again. pos_post_bill_to_ims, the close's, now finds the outlet's OPEN month holding the bill's
--   Nepal day and hands it over; what it posts is unchanged.
--
--   post_waiting_pos_bills(period, limit) (SECURITY DEFINER, for the browser): who may post is what
--   the app allowed: the outlet's Owner and the operator any month (ims_closed_period_guard admits
--   them to a closed one), a POS manager of the outlet its OPEN month only. It posts the month's
--   waiting bills in close order, up to `limit` (default 100, at most 200: about 4 ms a bill, so a
--   call stays far inside the browser role's 8 s statement timeout), each in its own
--   subtransaction, so one bad bill never costs its neighbours and is left waiting. It answers what it
--   did and how many still wait; the page calls again until nothing moves.
--
-- Credit notes are unchanged (the browser still posts them; slice 5f-4). Nothing is refused yet: an
-- older page's own post still works, so this file goes first. Step 2 (a later file, after crest-v446
-- is live) makes both guards refuse till sales and stock lines from a browser and raises the till
-- floor.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13 (written by 20261013160000):
-- pos_post_bill_to_ims 671626db781d8b78ad35da20061f5a51, pos_bill_sales_rows
-- 2cc546f394e068c87c157980c08df56d, pos_bill_stock_lines e44c21e02c660def4afac3b959c03fd2,
-- sales_entries_stamp_pos_source 639217f30a83b1ecc600cae2d4de7f39. Section 0 refuses any other.
-- pos_post_bill_to_ims keeps its signature, return type, SECURITY (INVOKER) and search_path, so the
-- close trigger is untouched. post_waiting_pos_bills is a new RPC: the file ends with a schema
-- reload. No till floor change in this step.
--
-- To undo: DROP FUNCTION public.post_waiting_pos_bills(uuid, integer), public.pos_post_bill_into(uuid, uuid)
-- after re-running 20261013160000's CREATE OR REPLACE of pos_post_bill_to_ims (section 5 there).
-- The page then falls back to nothing: revert the app too (crest-v445 posts from the browser).
--
-- The probe (section 4) acts at BLOOM CAFE (or the first POS outlet with Inventory, an open month
-- holding today, a closed month, an Owner and unblocked manager and supervisor till logins), as the
-- migration's role, its manager, its supervisor and its Owner, inside a block that rolls itself
-- back. It switches the outlet's Inventory off for a moment (to close bills that wait), and holds the
-- outlet's invoice-number lock and clients row for a second or so; a till closing a bill there in
-- that moment waits. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
-- Each second hash of pos_post_bill_to_ims is the body this file writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_post_bill_to_ims(uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('671626db781d8b78ad35da20061f5a51', '3188e125db2afbca58988b1e164b7fc4') THEN
    RAISE EXCEPTION 'S830 5f-2 pre-flight: pos_post_bill_to_ims changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_bill_sales_rows(uuid[])'::regprocedure;
  IF v_md5 IS DISTINCT FROM '2cc546f394e068c87c157980c08df56d' THEN
    RAISE EXCEPTION 'S830 5f-2 pre-flight: pos_bill_sales_rows changed since this was written (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_bill_stock_lines(uuid[])'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'e44c21e02c660def4afac3b959c03fd2' THEN
    RAISE EXCEPTION 'S830 5f-2 pre-flight: pos_bill_stock_lines changed since this was written (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.sales_entries_stamp_pos_source()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '639217f30a83b1ecc600cae2d4de7f39' THEN
    RAISE EXCEPTION 'S830 5f-2 pre-flight: sales_entries_stamp_pos_source changed since this was written (md5 %).', v_md5;
  END IF;
END;
$$;


-- ── 1. Post one bill into a given month ────────────────────────────────────────────────────────
-- Runs as its caller, and only the owner may call it (the close trigger and post_waiting_pos_bills
-- are SECURITY DEFINER), which is why it makes the INVOKER guards' checks itself. It does not ask
-- whether the month is open: its callers decide that (the close: the open month only; the RPC: the
-- caller's rights). Returns:
--   posted          sales rows and stock lines written, the bill marked (by the stamp trigger)
--   nothing_to_post no recipe line: marked
--   already         marked, or its till sales already in Inventory (then marked now)
--   not_billed      no such bill, or not billed
--   other_outlet    the month is not the bill's outlet's
--   no_ims          the outlet does not have Crest Inventory (left unmarked: D6, D7)
--   other_month     no closed_at, or the bill's Nepal day is not in this month
-- Raises on anything else.
CREATE OR REPLACE FUNCTION public.pos_post_bill_into(p_order_id uuid, p_period_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bill   record;
  v_period record;
  v_ims    boolean;
  v_day    date;
  v_bs_day integer;
BEGIN
  SELECT o.id, o.client_id, o.status, o.closed_at, o.ims_posted_at INTO v_bill
    FROM pos_orders o
   WHERE o.id = p_order_id
     FOR NO KEY UPDATE;
  IF NOT FOUND OR v_bill.status IS DISTINCT FROM 'billed' THEN
    RETURN 'not_billed';
  END IF;

  SELECT p.id, p.client_id, p.bs_year, p.bs_month INTO v_period
    FROM monthly_periods p
   WHERE p.id = p_period_id;
  IF v_period.id IS NULL OR v_period.client_id IS DISTINCT FROM v_bill.client_id THEN
    RETURN 'other_outlet';
  END IF;

  IF v_bill.ims_posted_at IS NOT NULL THEN
    RETURN 'already';
  END IF;
  -- Periods' pre-stamp (backfillPosToIms, S573): revenue already there is never posted again.
  IF EXISTS (SELECT 1 FROM sales_entries s
              WHERE s.pos_order_id = p_order_id AND s.source IN ('pos', 'pos_comp')) THEN
    UPDATE pos_orders SET ims_posted_at = now() WHERE id = p_order_id AND ims_posted_at IS NULL;
    RETURN 'already';
  END IF;

  -- ims_sales_entries_guard's pos_outlet_no_ims: NULL counts as on, as the app's `?? true` reads it.
  SELECT c.ims_enabled INTO v_ims FROM clients c WHERE c.id = v_bill.client_id;
  IF v_ims IS FALSE THEN
    RETURN 'no_ims';
  END IF;

  -- nepalDayInPeriod: the day the bill closed in Nepal, which must fall in this month.
  v_day := (v_bill.closed_at AT TIME ZONE 'Asia/Kathmandu')::date;
  SELECT (v_day - m.ad_start + 1) INTO v_bs_day
    FROM bs_months m
   WHERE m.bs_year = v_period.bs_year AND m.bs_month = v_period.bs_month
     AND v_day >= m.ad_start AND v_day < m.ad_start + m.days;
  IF v_bs_day IS NULL THEN
    RETURN 'other_month';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pos_order_items i WHERE i.order_id = p_order_id AND i.recipe_id IS NOT NULL) THEN
    UPDATE pos_orders SET ims_posted_at = now() WHERE id = p_order_id AND ims_posted_at IS NULL;
    RETURN 'nothing_to_post';
  END IF;

  -- The bill's sales rows in ONE statement: sales_entries_stamp_pos_source marks the bill with them
  -- and refuses a second statement for it.
  INSERT INTO sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate,
                             pos_order_id, ingredient_deltas)
  SELECT v_period.id, r.recipe_id, v_bs_day, r.qty_sold, r.source, r.unit_price, r.vat_rate,
         r.order_id, r.ingredient_deltas
    FROM public.pos_bill_sales_rows(ARRAY[p_order_id]) r
   ORDER BY r.line_id;

  INSERT INTO stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
  SELECT v_bill.client_id, s.item_id, v_period.id, v_bs_day, s.qty, s.source, s.order_id
    FROM public.pos_bill_stock_lines(ARRAY[p_order_id]) s;

  RETURN 'posted';
END;
$$;


-- ── 2. The close's post: the open month holding the bill's day, then the step above ────────────
-- What it posts is unchanged from 5f-1. Returns pos_post_bill_into's answer, or:
--   not_billed      no such bill, or not billed
--   undated         no closed_at, or a day outside the BS calendar table
--   month_not_open  the bill's Nepali month is not the one open in Inventory (left for Post to Inventory)
CREATE OR REPLACE FUNCTION public.pos_post_bill_to_ims(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_bill   record;
  v_day    date;
  v_month  record;
  v_period uuid;
BEGIN
  SELECT o.client_id, o.status, o.closed_at INTO v_bill FROM pos_orders o WHERE o.id = p_order_id;
  IF NOT FOUND OR v_bill.status IS DISTINCT FROM 'billed' THEN
    RETURN 'not_billed';
  END IF;

  v_day := (v_bill.closed_at AT TIME ZONE 'Asia/Kathmandu')::date;
  SELECT m.bs_year, m.bs_month INTO v_month
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

  RETURN public.pos_post_bill_into(p_order_id, v_period);
END;
$$;


-- ── 3. Post a month's waiting bills (the floor banner and Periods) ─────────────────────────────
-- Answers { posted, already, nothing_to_post, not_posted, failed, remaining, error, failed_bill }:
-- this call's outcomes (not_posted: bills the step declined, e.g. Inventory off), how many of the
-- month's bills still wait after it, and the first failure's message and bill. A failed bill is left
-- waiting and retried by the next call; the page stops calling when a call moves nothing.
CREATE OR REPLACE FUNCTION public.post_waiting_pos_bills(p_period_id uuid, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period    record;
  v_from      timestamptz;
  v_to        timestamptz;
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
  v_id        uuid;
  v_res       text;
  v_posted    integer := 0;
  v_already   integer := 0;
  v_empty     integer := 0;
  v_declined  integer := 0;
  v_failed    integer := 0;
  v_error     text;
  v_failed_id uuid;
  v_remaining integer;
BEGIN
  SELECT p.id, p.client_id, p.bs_year, p.bs_month, p.status INTO v_period
    FROM monthly_periods p
   WHERE p.id = p_period_id;

  -- The operator for any outlet; the outlet's Owner any month; a POS manager of the outlet its open
  -- month only (ims_closed_period_guard admits only the Owner and the operator to a closed month).
  -- Wrapped whole: is_admin() and my_client_id() are NULL for a login with no profile.
  IF NOT COALESCE(v_period.id IS NOT NULL
                  AND (public.is_admin()
                       OR (v_period.client_id = public.my_client_id()
                           AND (public.is_client_owner()
                                OR (v_period.status = 'open' AND public.pos_caller_has_rank('manager'))))), false) THEN
    RAISE EXCEPTION 'post_waiting_pos_bills: till bills are posted to Inventory by the Owner, or by a POS manager of this outlet while the month is open'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- The month's span in Nepal time, as the backfill read it (bsDayBoundaryIso).
  SELECT (m.ad_start + time '00:00') AT TIME ZONE 'Asia/Kathmandu',
         ((m.ad_start + m.days) + time '00:00') AT TIME ZONE 'Asia/Kathmandu'
    INTO v_from, v_to
    FROM bs_months m
   WHERE m.bs_year = v_period.bs_year AND m.bs_month = v_period.bs_month;
  IF v_from IS NULL THEN
    RETURN jsonb_build_object('posted', 0, 'already', 0, 'nothing_to_post', 0, 'not_posted', 0,
                              'failed', 0, 'remaining', 0, 'error', NULL, 'failed_bill', NULL);
  END IF;

  FOR v_id IN
    SELECT o.id
      FROM pos_orders o
     WHERE o.client_id = v_period.client_id
       AND o.status = 'billed'
       AND o.ims_posted_at IS NULL
       AND o.closed_at >= v_from AND o.closed_at < v_to
     ORDER BY o.closed_at, o.id
     LIMIT v_limit
  LOOP
    BEGIN
      v_res := public.pos_post_bill_into(v_id, v_period.id);
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      IF v_error IS NULL THEN
        v_error := SQLERRM;
        v_failed_id := v_id;
      END IF;
      CONTINUE;
    END;
    CASE v_res
      WHEN 'posted' THEN v_posted := v_posted + 1;
      WHEN 'already' THEN v_already := v_already + 1;
      WHEN 'nothing_to_post' THEN v_empty := v_empty + 1;
      ELSE v_declined := v_declined + 1;
    END CASE;
  END LOOP;

  SELECT count(*) INTO v_remaining
    FROM pos_orders o
   WHERE o.client_id = v_period.client_id
     AND o.status = 'billed'
     AND o.ims_posted_at IS NULL
     AND o.closed_at >= v_from AND o.closed_at < v_to;

  RETURN jsonb_build_object('posted', v_posted, 'already', v_already, 'nothing_to_post', v_empty,
                            'not_posted', v_declined, 'failed', v_failed, 'remaining', v_remaining,
                            'error', v_error, 'failed_bill', v_failed_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pos_post_bill_into(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pos_post_bill_to_ims(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_waiting_pos_bills(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_waiting_pos_bills(uuid, integer) TO authenticated;


-- ── 4. Prove it ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_client  uuid;
  v_period  uuid;
  v_start   date;
  v_closed  uuid;
  v_cstart  date;
  v_operiod uuid;
  v_mgr     uuid;
  v_sup     uuid;
  v_owner   uuid;
  v_fy      text;
  v_chicken uuid;
  v_wrap    uuid;
  v_w1 uuid; v_w2 uuid; v_w3 uuid; v_w4 uuid; v_w5 uuid; v_w6 uuid;
  v_line    uuid;
  v_r       jsonb;
  v_r2      jsonb;
  v_n       integer;
  v_hint    text;
  v_msg     text;
BEGIN
  -- ── Where: a POS outlet with Inventory, an open month holding today, a closed month, an Owner,
  --    a POS manager and supervisor till login; and another outlet's open month ──────────────────
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND c.ims_enabled IS NOT FALSE
     AND EXISTS (SELECT 1 FROM public.monthly_periods mp
                   JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
                  WHERE mp.client_id = c.id AND mp.status = 'open'
                    AND v_today >= m.ad_start AND v_today < m.ad_start + m.days)
     AND EXISTS (SELECT 1 FROM public.monthly_periods mp WHERE mp.client_id = c.id AND mp.status = 'closed')
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND COALESCE(p.active_client_id, p.client_id) = c.id
                    AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
                    AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false))
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S830 5f-2 probe: no POS outlet with Inventory, an open month holding today, a closed month, an Owner and unblocked manager and supervisor till logins';
  END IF;
  SELECT mp.id, m.ad_start INTO v_period, v_start
    FROM public.monthly_periods mp JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
   WHERE mp.client_id = v_client AND mp.status = 'open';
  SELECT mp.id, m.ad_start INTO v_closed, v_cstart
    FROM public.monthly_periods mp JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
   WHERE mp.client_id = v_client AND mp.status = 'closed'
   ORDER BY mp.bs_year DESC, mp.bs_month DESC LIMIT 1;
  SELECT mp.id INTO v_operiod FROM public.monthly_periods mp
   WHERE mp.status = 'open' AND mp.client_id <> v_client ORDER BY mp.client_id LIMIT 1;
  SELECT p.id INTO v_owner FROM public.profiles p
   WHERE p.client_id = v_client AND COALESCE(p.active_client_id, p.client_id) = v_client
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
     AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false) ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_mgr FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_sup FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  v_fy := public.pos_invoice_fy(now());

  BEGIN
    -- ── Setup, as the migration's own role ─────────────────────────────────────────────────────
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S830 5f-2 probe chicken', 'kg', 1, 0, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S830 5f-2 probe wrap', 'Food', 1) RETURNING id INTO v_wrap;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_wrap, v_chicken, 0.3);

    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w1;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w2;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w3;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w4;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w5;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w6;
    -- W1 wrap ×2; W2 only an open item; W3 wrap ×1 whose sales are in but not marked; W4 a wrap whose
    -- choice names a missing item (its post fails); W5 wrap ×1 closed in the closed month; W6 wrap ×1
    -- closed normally (the close's own post, through the reworked pos_post_bill_to_ims).
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_w1, v_client, 'S830 5f-2 probe wrap', v_wrap, 2, 300, 0.13),
      (v_w2, v_client, 'S830 5f-2 probe water', NULL, 1, 200, 0.13),
      (v_w3, v_client, 'S830 5f-2 probe wrap', v_wrap, 1, 300, 0.13),
      (v_w5, v_client, 'S830 5f-2 probe wrap', v_wrap, 1, 300, 0.13),
      (v_w6, v_client, 'S830 5f-2 probe wrap', v_wrap, 1, 300, 0.13);
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, selection_key)
      VALUES (v_w4, v_client, 'S830 5f-2 probe wrap', v_wrap, 1, 300, 0.13, 'probe') RETURNING id INTO v_line;
    INSERT INTO public.pos_order_item_options (client_id, order_id, order_item_id, option_name, ingredient_deltas)
      VALUES (v_client, v_w4, v_line, 'Missing item', jsonb_build_array(jsonb_build_object('item_id', gen_random_uuid(), 'qty', 1)));

    -- W1 to W4 close while Inventory is off, so they wait (day 1 of the open month, 00:15 in Nepal).
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 678, invoice_fy = v_fy,
           closed_at = (v_start + time '00:15') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id IN (v_w1, v_w2, v_w3, v_w4);
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    -- W3's sales go in by hand and its mark is cleared: revenue posted before the mark existed.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_period, v_wrap, 1, 1, 'pos', 300, 0.13, v_w3);
    UPDATE public.pos_orders SET ims_posted_at = NULL WHERE id = v_w3;
    -- W5 closes on day 1 of the closed month: its month is not open, so it waits.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy,
           closed_at = (v_cstart + time '00:15') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id = v_w5;
    -- W6 closes on day 1 of the open month with Inventory on: the close posts it.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy,
           closed_at = (v_start + time '00:15') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id = v_w6;

    -- (1) The close still posts its own bill (pos_post_bill_to_ims, reworked).
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w6) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_w6 AND period_id = v_period AND bs_day = 1) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_w6 AND source = 'pos_sale' AND abs(qty + 0.3 / 0.85) < 1e-9) <> 1 THEN
      RAISE EXCEPTION 'S830 5f-2 probe: the close of W6 was not posted with its stock line';
    END IF;
    IF (SELECT count(*) FROM public.pos_orders WHERE id IN (v_w1, v_w2, v_w3, v_w4, v_w5) AND ims_posted_at IS NOT NULL) <> 0 THEN
      RAISE EXCEPTION 'S830 5f-2 probe: a bill meant to wait was marked at its close';
    END IF;

    -- ── As the outlet's POS manager, on a till of this release ──────────────────────────────────
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;

    v_r := public.post_waiting_pos_bills(v_period, 200);

    -- (2) W1 posted from its stored lines; W2 marked with nothing written; W3 marked, not re-posted;
    --     W4 failed and still waits; W5 (the closed month) untouched.
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w1) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_w1 AND period_id = v_period AND bs_day = 1
            AND source = 'pos' AND recipe_id = v_wrap AND qty_sold = 2 AND unit_price = 300) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_w1) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_w1 AND item_id = v_chicken AND source = 'pos_sale'
            AND period_id = v_period AND bs_day = 1 AND abs(qty + 0.6 / 0.85) < 1e-9) <> 1 THEN
      RAISE EXCEPTION 'S830 5f-2 probe: W1 was not posted from its stored lines (answer %)', v_r;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w2) IS NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_w2) THEN
      RAISE EXCEPTION 'S830 5f-2 probe: W2 (no dish) was not marked with nothing written (answer %)', v_r;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w3) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_w3) <> 1
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_w3) THEN
      RAISE EXCEPTION 'S830 5f-2 probe: W3 (revenue already in) was not just marked (answer %)', v_r;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w4) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_w4)
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_w4) THEN
      RAISE EXCEPTION 'S830 5f-2 probe: W4 (a failed post) left rows or a mark behind (answer %)', v_r;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w5) IS NOT NULL THEN
      RAISE EXCEPTION 'S830 5f-2 probe: W5 (the closed month) was touched by a post of the open month';
    END IF;
    IF (v_r ->> 'posted')::int < 1 OR (v_r ->> 'already')::int < 1 OR (v_r ->> 'nothing_to_post')::int < 1
       OR (v_r ->> 'failed')::int < 1 OR (v_r ->> 'remaining')::int < 1
       OR v_r ->> 'error' IS NULL OR v_r ->> 'failed_bill' IS NULL THEN
      RAISE EXCEPTION 'S830 5f-2 probe: the answer does not count what was done: %', v_r;
    END IF;

    -- (3) A second call posts nothing again: W1 keeps one sales row and one stock line.
    v_r2 := public.post_waiting_pos_bills(v_period, 200);
    IF (v_r2 ->> 'posted')::int <> 0
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_w1) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_w1) <> 1 THEN
      RAISE EXCEPTION 'S830 5f-2 probe: a second call posted again: %', v_r2;
    END IF;

    -- (4) Refused: the manager on the closed month; the manager on another outlet's month; the
    --     supervisor on the open month. Each names rank_required.
    v_hint := NULL;
    BEGIN
      PERFORM public.post_waiting_pos_bills(v_closed, 200);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' THEN
      RAISE EXCEPTION 'S830 5f-2 probe: a POS manager posting a closed month answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    IF v_operiod IS NOT NULL THEN
      v_hint := NULL;
      BEGIN
        PERFORM public.post_waiting_pos_bills(v_operiod, 200);
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S830 5f-2 probe: a POS manager posting another outlet''s month answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sup)::text, true);
    v_hint := NULL;
    BEGIN
      PERFORM public.post_waiting_pos_bills(v_period, 200);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' THEN
      RAISE EXCEPTION 'S830 5f-2 probe: a POS supervisor posting answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (5) The Owner posts the closed month: W5 lands on day 1 of it.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    v_r := public.post_waiting_pos_bills(v_closed, 200);
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w5) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_w5 AND period_id = v_closed AND bs_day = 1) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_w5 AND period_id = v_closed AND bs_day = 1) <> 1 THEN
      RAISE EXCEPTION 'S830 5f-2 probe: the Owner''s post of the closed month did not post W5 on its day 1: %', v_r;
    END IF;

    -- (6) Who can call what.
    IF NOT has_function_privilege('authenticated', 'public.post_waiting_pos_bills(uuid, integer)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.post_waiting_pos_bills(uuid, integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_post_bill_into(uuid, uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_post_bill_to_ims(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'S830 5f-2 probe: the grants are not authenticated-only on the RPC and owner-only on the steps';
    END IF;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's830_5f2_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's830_5f2_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';


-- ── 5. What this step acts on, live (the last statement, so `db query` prints it) ─────────────
SELECT
  (SELECT count(*) FROM public.pos_orders WHERE status = 'billed' AND ims_posted_at IS NULL) AS bills_waiting,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_post_bill_to_ims(uuid)'::regprocedure) AS close_post_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_post_bill_into(uuid, uuid)'::regprocedure) AS post_into_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.post_waiting_pos_bills(uuid, integer)'::regprocedure) AS rpc_md5,
  has_function_privilege('authenticated', 'public.post_waiting_pos_bills(uuid, integer)', 'EXECUTE') AS rpc_for_logins;
