-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S831, POS stage 5, slice 5f-3: Inventory starts on the day it is switched on.
--
--   Owner decision Q31 (a), 2026-10-13: an outlet that switches Inventory on later starts that day.
--   Its earlier till bills stay in every POS report and are never sent to Inventory, nor their credit
--   notes. Asked again when this slice was planned (S831, 2026-10-13): every switch-on starts it
--   again, so bills closed while it was off never go to Inventory either. This reverses D6/D7 ("an
--   outlet without Inventory leaves its bills unmarked, so switching Inventory on later still finds
--   them waiting").
--
--   * clients.ims_since (timestamptz, NULL = Inventory from the start, every outlet today): the
--     start of the Nepal day Inventory was last switched on. clients_stamp_ims_since (BEFORE UPDATE OF
--     ims_enabled, only when it goes from off to on; NULL counts as on, as everywhere else) sets it.
--     clients_update is is_admin(), so only the operator (or the service role) moves it.
--   * pos_post_bill_into answers 'before_inventory' for a bill closed before it and leaves the bill
--     unmarked. That covers the close (pos_post_bill_to_ims → this step) and post_waiting_pos_bills.
--   * post_waiting_pos_bills starts its month's window at the stamp, so an earlier bill neither takes
--     a place in the batch nor counts as remaining.
--   * pos_ims_waiting_counts (the floor banner's panel, Periods' note, the close preflight, Home's
--     Needs attention) counts a bill from its close and a credit note from its BILL's close, both on
--     or after the stamp.
--   * ims_first_till_bill_at (Sales Entry's hand-over to the till, D35) reads the first bill on or
--     after the stamp, so the days before it stay open to hand entry.
--
--   Credit notes are still posted by the page until 5f-4; crest-v447 skips a note on a bill from
--   before the stamp, and 5f-4's server post will refuse one.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13: pos_post_bill_into
-- f1cadfcc261e9572e4aa16e89c65a627 and post_waiting_pos_bills 1ffbfea7b3dd9cbcf1b426b2adbc8d5a
-- (20261013170000), pos_ims_waiting_counts 3898b87725dd5d4dc6177596ddd18bcf (20261010140000),
-- ims_first_till_bill_at c6a3d14c56df7f03812b9fbed8db97b0 (20260928180000). Section 0 refuses any
-- other; each second hash is the body this file writes, so a re-run passes. Signatures, return types,
-- SECURITY, volatility and search_path are unchanged, so CREATE OR REPLACE keeps every grant and the
-- close trigger. No till floor change: nothing a till sends changes.
--
-- Apply BEFORE crest-v447 deploys: that release reads clients.ims_since with the outlet, and a page
-- reading a column that does not exist fails to load the outlet.
--
-- To undo: DROP TRIGGER clients_stamp_ims_since ON public.clients; DROP FUNCTION
-- public.clients_stamp_ims_since(); re-run the CREATE OR REPLACE of pos_post_bill_into and
-- post_waiting_pos_bills from 20261013170000, pos_ims_waiting_counts from 20261010140000 and
-- ims_first_till_bill_at from 20260928180000; then ALTER TABLE public.clients DROP COLUMN ims_since
-- (after reverting the app to crest-v446).
--
-- A probe that switches an outlet's Inventory off and on (5f-1, 5f-2 and later) now also moves that
-- outlet's stamp to today inside its own rolled-back block: a fixture bill dated earlier in the month
-- then answers 'before_inventory'. Set ims_since back (or to NULL) after the switch, as section 7 does.
--
-- The probe (section 7) acts at BLOOM CAFE (or the first POS outlet with Inventory, an open month
-- holding today, an Owner and an unblocked POS manager), as the migration's role, the manager and the
-- Owner, inside a block that rolls itself back. It switches the outlet's Inventory off and on, and
-- holds the outlet's invoice-number lock and clients row for a second or so; a till closing a bill
-- there in that moment waits. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_post_bill_into(uuid, uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('f1cadfcc261e9572e4aa16e89c65a627', 'c5c693f83c9840d9a068af26107af905') THEN
    RAISE EXCEPTION 'S831 5f-3 pre-flight: pos_post_bill_into changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.post_waiting_pos_bills(uuid, integer)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('1ffbfea7b3dd9cbcf1b426b2adbc8d5a', '963256fd57f2d656bd7683aba4c40ad8') THEN
    RAISE EXCEPTION 'S831 5f-3 pre-flight: post_waiting_pos_bills changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_ims_waiting_counts(uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('3898b87725dd5d4dc6177596ddd18bcf', '64e2640cf02b872692503fbc8bcfbb37') THEN
    RAISE EXCEPTION 'S831 5f-3 pre-flight: pos_ims_waiting_counts changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_first_till_bill_at(uuid, timestamptz, timestamptz)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('c6a3d14c56df7f03812b9fbed8db97b0', '20c8f79988146a9939db40e17342f793') THEN
    RAISE EXCEPTION 'S831 5f-3 pre-flight: ims_first_till_bill_at changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
END;
$$;


-- ── 1. The stamp ───────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS ims_since timestamptz;

COMMENT ON COLUMN public.clients.ims_since IS
  'When this outlet''s Inventory began: the start of the Nepal day Crest IMS was last switched on (S831 5f-3, owner Q31 a). NULL = from the start. A till bill closed before it is never sent to Inventory, nor a credit note on it. Set by clients_stamp_ims_since.';


-- ── 2. Switching Inventory on stamps the day ───────────────────────────────────────────────────
-- Every switch from off to on (NULL counts as on, as the app's `?? true` and the post read it), so a
-- switch off and back on the same day keeps that day's earlier bills. Switching off leaves the stamp
-- alone; nothing reads it while Inventory is off. INVOKER: it only sets NEW, and only the operator
-- and the service role can update clients at all.
CREATE OR REPLACE FUNCTION public.clients_stamp_ims_since()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.ims_since := (((now() AT TIME ZONE 'Asia/Kathmandu')::date) + time '00:00') AT TIME ZONE 'Asia/Kathmandu';
  RETURN NEW;
END;
$$;

-- A trigger function needs no grant (EXECUTE is checked at CREATE TRIGGER time).
REVOKE ALL ON FUNCTION public.clients_stamp_ims_since() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS clients_stamp_ims_since ON public.clients;
CREATE TRIGGER clients_stamp_ims_since
  BEFORE UPDATE OF ims_enabled ON public.clients
  FOR EACH ROW
  WHEN (OLD.ims_enabled IS FALSE AND NEW.ims_enabled IS NOT FALSE)
  EXECUTE FUNCTION public.clients_stamp_ims_since();


-- ── 3. Post one bill into a given month: a bill from before Inventory began is never sent ──────
-- Runs as its caller, and only the owner may call it (the close trigger and post_waiting_pos_bills
-- are SECURITY DEFINER), which is why it makes the INVOKER guards' checks itself. It does not ask
-- whether the month is open: its callers decide that (the close: the open month only; the RPC: the
-- caller's rights). Returns:
--   posted           sales rows and stock lines written, the bill marked (by the stamp trigger)
--   nothing_to_post  no recipe line: marked
--   already          marked, or its till sales already in Inventory (then marked now)
--   not_billed       no such bill, or not billed
--   other_outlet     the month is not the bill's outlet's
--   no_ims           the outlet does not have Crest Inventory (left unmarked)
--   before_inventory the bill closed before the outlet's Inventory began (clients.ims_since, S831;
--                    left unmarked, and never sent)
--   other_month      no closed_at, or the bill's Nepal day is not in this month
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
  v_since  timestamptz;
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
  SELECT c.ims_enabled, c.ims_since INTO v_ims, v_since FROM clients c WHERE c.id = v_bill.client_id;
  IF v_ims IS FALSE THEN
    RETURN 'no_ims';
  END IF;
  -- Q31 (a), S831: Inventory starts on the Nepal day it was switched on (NULL: from the start). A bill
  -- closed before that stays in the POS reports and is never sent, so it is left unmarked.
  IF v_bill.closed_at < v_since THEN
    RETURN 'before_inventory';
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


-- ── 4. Post a month's waiting bills: the window starts where Inventory began ────────────────────
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
  v_since     timestamptz;
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
  -- Q31 (a), S831: a bill closed before the outlet's Inventory began is never sent, so it neither takes
  -- a place in the batch nor counts as remaining. GREATEST skips a NULL stamp (Inventory from the start).
  SELECT c.ims_since INTO v_since FROM clients c WHERE c.id = v_period.client_id;
  v_from := GREATEST(v_from, v_since);

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


-- ── 5. How many wait, per Nepali month: only what belongs to Inventory ─────────────────────────
-- A month is Nepal's calendar month of the bill's close (the note's issue) through bs_months, the
-- same month Periods' backfill gives it (bsDayBoundaryIso over the period's BS month, S792). A
-- date outside bs_months (none today) comes back with NULL year and month. The month's period is
-- matched by year and month; none means the month has not been started in Inventory.
-- Since S831 (Q31 a) a bill counts only from the outlet's Inventory start (clients.ims_since), and a
-- credit note only when its BILL does: a note on an earlier bill is never sent either.
CREATE OR REPLACE FUNCTION public.pos_ims_waiting_counts(p_client_id uuid)
RETURNS TABLE (bs_year integer, bs_month integer, period_id uuid, period_status text, bills integer, notes integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_since timestamptz;
BEGIN
  -- The operator for any outlet; otherwise the outlet's own Owner, a POS manager, or an IMS
  -- supervisor or manager (pos_caller_has_rank and ims_caller_has_rank each also answer true for
  -- the Owner and the operator, and false for a blocked login). Wrapped whole: is_admin() and
  -- my_client_id() are NULL for a login with no profile, and NULL must refuse.
  IF NOT COALESCE(public.is_admin()
                  OR (p_client_id = public.my_client_id()
                      AND (public.pos_caller_has_rank('manager') OR public.ims_caller_has_rank('supervisor'))), false) THEN
    RAISE EXCEPTION 'pos_ims_waiting_counts: how many till bills wait for Inventory is shown to the Owner, a POS manager or an Inventory supervisor of this outlet'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- NULL: Inventory from the start, so nothing is left out.
  SELECT cl.ims_since INTO v_since FROM clients cl WHERE cl.id = p_client_id;

  RETURN QUERY
  WITH waiting AS (
    SELECT (o.closed_at AT TIME ZONE 'Asia/Kathmandu')::date AS d, 1 AS b, 0 AS n
      FROM pos_orders o
     WHERE o.client_id = p_client_id
       AND o.status = 'billed'
       AND o.ims_posted_at IS NULL
       AND (v_since IS NULL OR o.closed_at >= v_since)
       AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_order_id = o.id)
    UNION ALL
    SELECT (c.created_at AT TIME ZONE 'Asia/Kathmandu')::date, 0, 1
      FROM pos_credit_notes c
     WHERE c.client_id = p_client_id
       AND c.ims_posted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM pos_orders bo WHERE bo.id = c.order_id AND bo.closed_at < v_since)
       AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_credit_note_id = c.id)
  ), dated AS (
    SELECT m.bs_year AS y, m.bs_month AS mo, w.b, w.n
      FROM waiting w
      LEFT JOIN bs_months m ON w.d >= m.ad_start AND w.d < m.ad_start + m.days
  )
  SELECT d.y::integer, d.mo::integer, p.id, p.status, sum(d.b)::integer, sum(d.n)::integer
    FROM dated d
    LEFT JOIN monthly_periods p ON p.client_id = p_client_id AND p.bs_year = d.y AND p.bs_month = d.mo
   GROUP BY d.y, d.mo, p.id, p.status
   ORDER BY d.y NULLS LAST, d.mo NULLS LAST;
END;
$function$;


-- ── 6. D35: the till's first bill for Inventory is its first bill since Inventory began ─────────
-- Sales Entry keeps a POS client's pre-till days open to hand entry (D35), and the till's first
-- day is the earlier of what IMS holds and the till's own first bill — so a bill not yet posted to
-- IMS (an unsynced till, a hand-off awaiting the Periods backfill) does not leave its day looking
-- pre-till. pos_orders carries the restrictive no_ims_staff policy, so an IMS supervisor or staff
-- login — the people who use Sales Entry — reads it as empty with no error. This returns the one
-- timestamp and nothing else: the earliest paid or Complimentary bill carrying a dish, in the
-- window given. Same filters as the direct read it replaces (Sales.js readFirstTillBill). Since S831
-- (Q31 a) only from the outlet's Inventory start: a bill before it never reaches Inventory, so its
-- day is still the hand's.
CREATE OR REPLACE FUNCTION public.ims_first_till_bill_at(p_client_id uuid, p_from timestamptz, p_to timestamptz)
 RETURNS timestamptz
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- ims_caller_has_rank covers admin and the Owner, and refuses a count PIN (which never opens
  -- Sales Entry). COALESCE'd as a whole: my_client_id() is NULL for a caller with no profile.
  IF NOT COALESCE(public.is_admin()
                  OR (p_client_id = public.my_client_id() AND public.ims_caller_has_rank('staff')), false) THEN
    RAISE EXCEPTION 'Not permitted: this login cannot read that client''s till bills.' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT min(o.closed_at)
      FROM pos_orders o
     WHERE o.client_id = p_client_id
       AND o.status = 'billed'
       AND o.close_type IN ('paid', 'writeoff')
       -- GREATEST skips a NULL stamp (Inventory from the start).
       AND o.closed_at >= GREATEST(p_from, (SELECT c.ims_since FROM clients c WHERE c.id = p_client_id))
       AND o.closed_at <= p_to
       AND EXISTS (SELECT 1 FROM pos_order_items i WHERE i.order_id = o.id AND i.recipe_id IS NOT NULL)
  );
END;
$function$;


-- ── 7. Prove it ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_today       date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_today_start timestamptz;
  v_client      uuid;
  v_period      uuid;
  v_start       date;
  v_since       timestamptz;
  v_mgr         uuid;
  v_owner       uuid;
  v_fy          text;
  v_old_ims     boolean;
  v_old_since   timestamptz;
  v_chicken     uuid;
  v_wrap        uuid;
  v_b1 uuid; v_b2 uuid; v_b3 uuid;
  v_n1 uuid; v_n2 uuid;
  v_b1_at       timestamptz;
  v_res         text;
  v_r           jsonb;
  v_bw  integer; v_nw  integer;
  v_bw0 integer; v_nw0 integer;
  v_rem_with    integer;
  v_rem_all     integer;
  v_first       timestamptz;
  v_got         timestamptz;
BEGIN
  v_today_start := (v_today + time '00:00') AT TIME ZONE 'Asia/Kathmandu';

  -- ── Where: a POS outlet with Inventory, an open month holding today, an Owner and an unblocked POS
  --    manager till login ──────────────────────────────────────────────────────────────────────
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND c.ims_enabled IS NOT FALSE
     AND EXISTS (SELECT 1 FROM public.monthly_periods mp
                   JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
                  WHERE mp.client_id = c.id AND mp.status = 'open'
                    AND v_today >= m.ad_start AND v_today < m.ad_start + m.days)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND COALESCE(p.active_client_id, p.client_id) = c.id
                    AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
                    AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false))
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S831 5f-3 probe: no POS outlet with Inventory, an open month holding today, an Owner and an unblocked POS manager';
  END IF;
  SELECT mp.id, m.ad_start INTO v_period, v_start
    FROM public.monthly_periods mp JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
   WHERE mp.client_id = v_client AND mp.status = 'open';
  SELECT p.id INTO v_owner FROM public.profiles p
   WHERE p.client_id = v_client AND COALESCE(p.active_client_id, p.client_id) = v_client
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
     AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false) ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_mgr FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT c.ims_enabled, c.ims_since INTO v_old_ims, v_old_since FROM public.clients c WHERE c.id = v_client;
  v_fy := public.pos_invoice_fy(now());
  -- The probe's Inventory start: day 2 of the open month. Day 1 is before it, day 2 after.
  v_since := ((v_start + 1) + time '00:00') AT TIME ZONE 'Asia/Kathmandu';
  v_b1_at := (v_start + time '00:15') AT TIME ZONE 'Asia/Kathmandu';

  BEGIN
    -- ── Setup, as the migration's own role ─────────────────────────────────────────────────────
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S831 5f-3 probe chicken', 'kg', 1, 0, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S831 5f-3 probe wrap', 'Food', 1) RETURNING id INTO v_wrap;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_wrap, v_chicken, 0.3);

    -- order_no is given, so the probe takes no lock on the outlet's real order series.
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990831, 'S831 5f-3 probe') RETURNING id INTO v_b1;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990832, 'S831 5f-3 probe') RETURNING id INTO v_b2;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990833, 'S831 5f-3 probe') RETURNING id INTO v_b3;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_b1, v_client, 'S831 5f-3 probe wrap', v_wrap, 1, 300, 0.13),
      (v_b2, v_client, 'S831 5f-3 probe wrap', v_wrap, 1, 300, 0.13),
      (v_b3, v_client, 'S831 5f-3 probe wrap', v_wrap, 1, 300, 0.13);

    -- (1) The stamp. Switching off leaves it; switching on stamps the start of today in Nepal.
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    IF (SELECT ims_since FROM public.clients WHERE id = v_client) IS DISTINCT FROM v_old_since THEN
      RAISE EXCEPTION 'S831 5f-3 probe: switching Inventory off moved the stamp';
    END IF;
    -- B3 closes on day 2 while Inventory is off, so it waits.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy,
           closed_at = ((v_start + 1) + time '00:15') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id = v_b3;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    IF (SELECT ims_since FROM public.clients WHERE id = v_client) IS DISTINCT FROM v_today_start THEN
      RAISE EXCEPTION 'S831 5f-3 probe: switching Inventory on stamped %, not the start of today in Nepal (%)',
        (SELECT ims_since FROM public.clients WHERE id = v_client), v_today_start;
    END IF;
    -- A write that leaves Inventory on keeps whatever stamp is there.
    UPDATE public.clients SET ims_since = v_since WHERE id = v_client;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    IF (SELECT ims_since FROM public.clients WHERE id = v_client) IS DISTINCT FROM v_since THEN
      RAISE EXCEPTION 'S831 5f-3 probe: an on-to-on write moved the stamp';
    END IF;
    -- NULL counts as on: off to NULL stamps too.
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    UPDATE public.clients SET ims_enabled = NULL WHERE id = v_client;
    IF (SELECT ims_since FROM public.clients WHERE id = v_client) IS DISTINCT FROM v_today_start THEN
      RAISE EXCEPTION 'S831 5f-3 probe: switching Inventory from off to NULL did not stamp today';
    END IF;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    UPDATE public.clients SET ims_since = v_since WHERE id = v_client;

    -- B1 closes on day 1 (before the start) and B2 on day 2 (after), both with Inventory on.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy,
           closed_at = v_b1_at
     WHERE id = v_b1;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy,
           closed_at = ((v_start + 1) + time '00:15') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id = v_b2;

    -- (2) The close: B1 is left alone, unmarked; B2 posts on its day 2 with its stock line.
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b1) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b1)
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_b1) THEN
      RAISE EXCEPTION 'S831 5f-3 probe: the close sent a bill from before Inventory began';
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b2) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_b2 AND period_id = v_period AND bs_day = 2) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b2 AND source = 'pos_sale' AND abs(qty + 0.3 / 0.85) < 1e-9) <> 1 THEN
      RAISE EXCEPTION 'S831 5f-3 probe: the close of a bill after Inventory began did not post it with its stock line';
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b3) IS NOT NULL THEN
      RAISE EXCEPTION 'S831 5f-3 probe: B3, closed while Inventory was off, was marked';
    END IF;
    v_res := public.pos_post_bill_into(v_b1, v_period);
    IF v_res IS DISTINCT FROM 'before_inventory' THEN
      RAISE EXCEPTION 'S831 5f-3 probe: the step answered % for a bill from before Inventory began', v_res;
    END IF;

    -- A credit note on each of B1 and B2, not yet taken off Inventory sales. Fiscal year 86/87, as the
    -- S809 3j probe did, so the probe never takes the outlet's real credit-note series.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                         taxable_amount, non_taxable_amount, vat_amount, net_amount, restock)
      VALUES (v_client, v_b1, '86/87', 1, 'S831 5f-3 probe', '1 Baisakh 2000', 'S831 5f-3 probe', 'none', 300, 0, 300, 0, 39, 339, false)
      RETURNING id INTO v_n1;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                         taxable_amount, non_taxable_amount, vat_amount, net_amount, restock)
      VALUES (v_client, v_b2, '86/87', 1, 'S831 5f-3 probe', '1 Baisakh 2000', 'S831 5f-3 probe', 'none', 300, 0, 300, 0, 39, 339, false)
      RETURNING id INTO v_n2;

    -- ── As the outlet's POS manager, on a till of this release ──────────────────────────────────
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;

    -- (3) The waiting count leaves out B1, and the note on B1, and nothing else: with the stamp
    --     cleared, the open month counts exactly one more bill and one more note.
    SELECT w.bills, w.notes INTO v_bw, v_nw FROM public.pos_ims_waiting_counts(v_client) w WHERE w.period_id = v_period;
    RESET ROLE;
    UPDATE public.clients SET ims_since = NULL WHERE id = v_client;
    SET LOCAL ROLE authenticated;
    SELECT w.bills, w.notes INTO v_bw0, v_nw0 FROM public.pos_ims_waiting_counts(v_client) w WHERE w.period_id = v_period;
    RESET ROLE;
    UPDATE public.clients SET ims_since = v_since WHERE id = v_client;
    SET LOCAL ROLE authenticated;
    IF COALESCE(v_bw, 0) < 1 OR COALESCE(v_nw, 0) < 1
       OR v_bw0 IS DISTINCT FROM v_bw + 1 OR v_nw0 IS DISTINCT FROM v_nw + 1 THEN
      RAISE EXCEPTION 'S831 5f-3 probe: waiting counts were % bills / % notes with the stamp and % / % without',
        v_bw, v_nw, v_bw0, v_nw0;
    END IF;

    -- (4) Post the month: B3 posts on day 2; B1 is not touched, and is not counted as remaining.
    v_r := public.post_waiting_pos_bills(v_period, 200);
    RESET ROLE;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b3) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_b3 AND period_id = v_period AND bs_day = 2) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b3) <> 1 THEN
      RAISE EXCEPTION 'S831 5f-3 probe: the month''s post did not post B3 (answer %)', v_r;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_b1) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_order_id = v_b1)
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_b1) THEN
      RAISE EXCEPTION 'S831 5f-3 probe: the month''s post sent a bill from before Inventory began (answer %)', v_r;
    END IF;
    SELECT count(*) FILTER (WHERE o.closed_at >= v_since), count(*) INTO v_rem_with, v_rem_all
      FROM public.pos_orders o JOIN public.bs_months m ON m.ad_start = v_start
     WHERE o.client_id = v_client AND o.status = 'billed' AND o.ims_posted_at IS NULL
       AND o.closed_at >= (m.ad_start + time '00:00') AT TIME ZONE 'Asia/Kathmandu'
       AND o.closed_at < ((m.ad_start + m.days) + time '00:00') AT TIME ZONE 'Asia/Kathmandu';
    IF (v_r ->> 'remaining')::int IS DISTINCT FROM v_rem_with OR v_rem_all <= v_rem_with THEN
      RAISE EXCEPTION 'S831 5f-3 probe: the post counted % remaining; % wait since the start, % in the whole month',
        v_r ->> 'remaining', v_rem_with, v_rem_all;
    END IF;

    -- (5) Sales Entry's hand-over, as the Owner: the till's first bill is on or after the start; with
    --     the stamp cleared it is B1's close or earlier.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;
    v_first := public.ims_first_till_bill_at(v_client,
                 (v_start + time '00:00') AT TIME ZONE 'Asia/Kathmandu',
                 ((v_start + 31) + time '00:00') AT TIME ZONE 'Asia/Kathmandu');
    RESET ROLE;
    UPDATE public.clients SET ims_since = NULL WHERE id = v_client;
    SET LOCAL ROLE authenticated;
    v_got := public.ims_first_till_bill_at(v_client,
               (v_start + time '00:00') AT TIME ZONE 'Asia/Kathmandu',
               ((v_start + 31) + time '00:00') AT TIME ZONE 'Asia/Kathmandu');
    RESET ROLE;
    IF v_first IS NULL OR v_first < v_since OR v_got IS NULL OR v_got > v_b1_at THEN
      RAISE EXCEPTION 'S831 5f-3 probe: the till''s first bill read % with the stamp and % without (start %, B1 %)',
        v_first, v_got, v_since, v_b1_at;
    END IF;

    -- (6) Who can call what is unchanged, the new trigger function is nobody's, and a signed-in login
    --     can read the stamp with its outlet.
    IF NOT has_function_privilege('authenticated', 'public.post_waiting_pos_bills(uuid, integer)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.post_waiting_pos_bills(uuid, integer)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.pos_ims_waiting_counts(uuid)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.pos_ims_waiting_counts(uuid)', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.ims_first_till_bill_at(uuid, timestamptz, timestamptz)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.ims_first_till_bill_at(uuid, timestamptz, timestamptz)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_post_bill_into(uuid, uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.clients_stamp_ims_since()', 'EXECUTE')
       OR NOT has_column_privilege('authenticated', 'public.clients', 'ims_since', 'SELECT') THEN
      RAISE EXCEPTION 'S831 5f-3 probe: a grant is not what it was (RPCs authenticated-only, steps owner-only, the stamp readable)';
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's831_5f3_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's831_5f3_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';


-- ── 8. What this slice acts on, live (the last statement, so `db query` prints it) ─────────────
SELECT
  (SELECT format_type(a.atttypid, a.atttypmod) FROM pg_attribute a
    WHERE a.attrelid = 'public.clients'::regclass AND a.attname = 'ims_since' AND NOT a.attisdropped) AS ims_since_type,
  (SELECT count(*) FROM public.clients WHERE ims_since IS NOT NULL) AS outlets_with_a_start,
  (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
    WHERE t.tgname = 'clients_stamp_ims_since' AND t.tgrelid = 'public.clients'::regclass AND NOT t.tgisinternal) AS stamp_trigger,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_post_bill_into(uuid, uuid)'::regprocedure) AS post_into_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.post_waiting_pos_bills(uuid, integer)'::regprocedure) AS waiting_post_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_ims_waiting_counts(uuid)'::regprocedure) AS waiting_counts_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ims_first_till_bill_at(uuid, timestamptz, timestamptz)'::regprocedure) AS first_bill_md5,
  (SELECT count(*) FROM public.pos_orders WHERE status = 'billed' AND ims_posted_at IS NULL) AS bills_waiting;
