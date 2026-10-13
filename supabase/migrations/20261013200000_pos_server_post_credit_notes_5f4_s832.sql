-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S832, POS stage 5, slice 5f-4, step 1 of 2: the server sends a credit note to Inventory as it
-- is issued, and posts waiting notes too.
--
--   Owner decision Q32 (yes), 2026-10-13: the server also sends a credit note to Inventory when it
--   is issued, as a small follow-on to the bills (5f-1 to 5f-3). Until now the page did it after the
--   note printed (creditNotePosting.postCreditNoteToIms): read today's month, write the reversal
--   rows, then, for a "not served" note, read the bill's stock lines and write them back
--   best-effort. A connection lost in that moment left the note waiting, and a lost stock write left
--   a "not served" note whose food never came back. Waiting notes were posted from the browser too,
--   after the bills (backfillCreditNotesToIms, from the floor's Post to Inventory and Periods).
--
--   * pos_post_credit_note_into(note, period): the note's twin of pos_post_bill_into. It makes the
--     INVOKER guards' checks itself (inside a SECURITY DEFINER body current_user is the owner and
--     they wave it through): the note of the period's outlet, not yet posted, Inventory on (NULL
--     counts as on), its bill closed on or after the outlet's Inventory start (clients.ims_since,
--     S831), the note's Nepal issue day inside the period's month. The reversal is the bill's own
--     'pos' sales rows from pos_bill_sales_rows (the SQL twin of billSalesRows since S830), negated,
--     which is exactly what creditNoteReversalRows built: comped lines skipped, the bill discount
--     spread as the bill posted it, a customized line's choices carried. It goes in ONE statement
--     (sales_entries_stamp_pos_source marks the note with it and refuses a second statement). A
--     "not served" note (restock) waits until its bill's own sale is in Inventory, then also puts
--     back the bill's 'pos_sale' stock lines item by item, in the same transaction: it is no longer
--     best-effort. A note whose reversal is already in Inventory but carries no mark is marked, never
--     posted again; a note with nothing to take back (no recipe line, or every line comped) is
--     marked with nothing written, as the page marked it.
--   * pos_post_credit_note_to_ims(note): finds the outlet's OPEN month holding the note's Nepal issue
--     day and hands over, as pos_post_bill_to_ims does for a bill.
--   * pos_credit_notes_post_to_inventory: AFTER INSERT on pos_credit_notes, SECURITY DEFINER, in the
--     note's own transaction, inside an exception block: a failed post never refuses a note (it is a
--     numbered tax document by then) and is rolled back whole, so the note waits, unmarked. It fires
--     after pos_credit_note_settle (triggers of one kind fire in name order). The operator's restore
--     is left alone: a note carrying the time it was first issued, or already marked, brings its
--     reversal rows with it.
--   * post_waiting_credit_notes(period, limit) (SECURITY DEFINER, for the browser): a month's waiting
--     notes, in issue order, each in its own subtransaction, with the same rights as
--     post_waiting_pos_bills: the outlet's Owner and the operator any month, a POS manager of the
--     outlet its OPEN month only. A note on a bill closed before the outlet's Inventory began is never
--     sent, so it neither takes a place nor counts as remaining (pos_ims_waiting_counts' rule). It
--     answers what it did and how many still wait.
--
-- The till does nothing new in this step. A page from before crest-v448 still posts the note itself
-- after printing: the server has posted it by then, so that insert is refused as
-- pos_credit_note_already_posted, which postCreditNoteToIms already reads as posted. Step 2 (a later
-- file, after crest-v448 is live) makes both guards refuse a note's rows from a browser and raises
-- the till floor.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13. This file replaces none of them; the post
-- relies on how they behave, so section 0 refuses any other: pos_bill_sales_rows
-- 2cc546f394e068c87c157980c08df56d (20261013160000), sales_entries_stamp_pos_source
-- 639217f30a83b1ecc600cae2d4de7f39 (20261010140000), ims_sales_entries_guard
-- ace91816eec08c9f8cdb09a49e961f3c (20261013180000), ims_stock_movements_guard
-- 63d4eac768c9ddd6da676dffb88ff3ee (20261013180000), guard_pos_credit_note
-- 181ee4ec9c5a4656fcbd33eee08a0422 (20261013140000), pos_credit_note_settle
-- 1bb4fdd35e86f0977bd1d41a84b845f0 (20261009210000). post_waiting_credit_notes is a new RPC, so the
-- file ends with a schema reload. No till floor change in this step.
--
-- Deploy order: this file, then crest-v448 (which calls post_waiting_credit_notes and stops posting
-- notes from the page).
--
-- To undo:
--   DROP TRIGGER IF EXISTS pos_credit_notes_post_to_inventory ON public.pos_credit_notes;
--   DROP FUNCTION IF EXISTS public.pos_credit_notes_post_to_inventory(),
--     public.post_waiting_credit_notes(uuid, integer), public.pos_post_credit_note_to_ims(uuid),
--     public.pos_post_credit_note_into(uuid, uuid);
-- and revert the app to crest-v447, which posts notes from the page.
--
-- Section 6 re-checks the reversal against every note on record (read-only): the reversal rows each
-- posted note holds must equal what pos_post_credit_note_into would write for it, and a "not served"
-- note's stock lines its bill's own 'pos_sale' lines negated. Live 2026-10-13: 2 notes, both posted,
-- both matching; none "not served".
--
-- The probe (section 7) acts at BLOOM CAFE (or the first POS outlet with Inventory, an open month
-- holding today, a closed month, an Owner and unblocked manager and supervisor till logins), as the
-- migration's role, that manager, that supervisor and that Owner, inside a block that rolls itself
-- back. It switches the outlet's Inventory off for a moment and moves its Inventory start, and for a
-- second or so holds the outlet's invoice-number and credit-note-number locks and its clients row; a
-- till closing a bill or issuing a note there in that moment waits. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_bill_sales_rows(uuid[])'::regprocedure;
  IF v_md5 IS DISTINCT FROM '2cc546f394e068c87c157980c08df56d' THEN
    RAISE EXCEPTION 'S832 5f-4 pre-flight: pos_bill_sales_rows changed since this was written (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.sales_entries_stamp_pos_source()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '639217f30a83b1ecc600cae2d4de7f39' THEN
    RAISE EXCEPTION 'S832 5f-4 pre-flight: sales_entries_stamp_pos_source changed since this was written (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'ace91816eec08c9f8cdb09a49e961f3c' THEN
    RAISE EXCEPTION 'S832 5f-4 pre-flight: ims_sales_entries_guard changed since this was written (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_stock_movements_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '63d4eac768c9ddd6da676dffb88ff3ee' THEN
    RAISE EXCEPTION 'S832 5f-4 pre-flight: ims_stock_movements_guard changed since this was written (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '181ee4ec9c5a4656fcbd33eee08a0422' THEN
    RAISE EXCEPTION 'S832 5f-4 pre-flight: guard_pos_credit_note changed since this was written (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_credit_note_settle()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '1bb4fdd35e86f0977bd1d41a84b845f0' THEN
    RAISE EXCEPTION 'S832 5f-4 pre-flight: pos_credit_note_settle changed since this was written (md5 %).', v_md5;
  END IF;
  -- One "not served" stock line per bill and item: a second post of a note's stock is refused.
  IF NOT COALESCE((SELECT i.indisunique FROM pg_index i
                    WHERE i.indexrelid = to_regclass('public.stock_movements_one_restock_per_bill_item')), false) THEN
    RAISE EXCEPTION 'S832 5f-4 pre-flight: the unique index stock_movements_one_restock_per_bill_item is missing.';
  END IF;
END;
$$;


-- ── 1. Post one credit note into a given month ─────────────────────────────────────────────────
-- Runs as its caller, and only the owner may call it (the issue trigger and post_waiting_credit_notes
-- are SECURITY DEFINER), which is why it makes the INVOKER guards' checks itself. It does not ask
-- whether the month is open: its callers decide that (the issue: the open month only; the RPC: the
-- caller's rights). Returns:
--   posted           reversal rows written (and a "not served" note's stock lines), the note marked
--                    (by the stamp trigger)
--   nothing_to_post  the bill has no line to take back (no recipe line, or every line comped): marked
--   already          marked, or its reversal already in Inventory (then marked now)
--   bill_waiting     a "not served" note whose bill's own sale is not in Inventory yet (left unmarked:
--                    putting the food back first would let the bill's later post take it again)
--   not_found        no such note
--   other_outlet     the month is not the note's outlet's
--   no_ims           the outlet does not have Crest Inventory (left unmarked)
--   before_inventory the note's bill closed before the outlet's Inventory began (clients.ims_since,
--                    S831; left unmarked, and never sent: the bill's revenue never went in)
--   other_month      the note's Nepal issue day is not in this month
-- Raises on anything else.
CREATE OR REPLACE FUNCTION public.pos_post_credit_note_into(p_note_id uuid, p_period_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_note   record;
  v_period record;
  v_closed timestamptz;
  v_ims    boolean;
  v_since  timestamptz;
  v_day    date;
  v_bs_day integer;
BEGIN
  -- Locked first, as sales_entries_stamp_pos_source locks it: a second post of this note waits here
  -- for the first to commit, then sees its mark.
  SELECT n.id, n.client_id, n.order_id, n.restock, n.created_at, n.ims_posted_at INTO v_note
    FROM pos_credit_notes n
   WHERE n.id = p_note_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  SELECT p.id, p.client_id, p.bs_year, p.bs_month INTO v_period
    FROM monthly_periods p
   WHERE p.id = p_period_id;
  IF v_period.id IS NULL OR v_period.client_id IS DISTINCT FROM v_note.client_id THEN
    RETURN 'other_outlet';
  END IF;

  IF v_note.ims_posted_at IS NOT NULL THEN
    RETURN 'already';
  END IF;
  -- The backfill's pre-stamp (S747): a reversal already there is never posted again.
  IF EXISTS (SELECT 1 FROM sales_entries s
              WHERE s.pos_credit_note_id = p_note_id AND s.source IN ('pos_credit', 'pos_credit_restock')) THEN
    UPDATE pos_credit_notes SET ims_posted_at = now() WHERE id = p_note_id AND ims_posted_at IS NULL;
    RETURN 'already';
  END IF;

  -- ims_sales_entries_guard's pos_outlet_no_ims: NULL counts as on, as the app's `?? true` reads it.
  SELECT c.ims_enabled, c.ims_since INTO v_ims, v_since FROM clients c WHERE c.id = v_note.client_id;
  IF v_ims IS FALSE THEN
    RETURN 'no_ims';
  END IF;
  -- Q31 (a), S831: a bill closed before the outlet's Inventory began never went in, so its note has
  -- nothing to take back (billCountsForIms).
  SELECT o.closed_at INTO v_closed FROM pos_orders o WHERE o.id = v_note.order_id;
  IF v_closed < v_since THEN
    RETURN 'before_inventory';
  END IF;

  -- nepalDayInPeriod: the day the note was issued in Nepal, which must fall in this month.
  v_day := (v_note.created_at AT TIME ZONE 'Asia/Kathmandu')::date;
  SELECT (v_day - m.ad_start + 1) INTO v_bs_day
    FROM bs_months m
   WHERE m.bs_year = v_period.bs_year AND m.bs_month = v_period.bs_month
     AND v_day >= m.ad_start AND v_day < m.ad_start + m.days;
  IF v_bs_day IS NULL THEN
    RETURN 'other_month';
  END IF;

  -- creditNoteReversalRows: only what the bill's close POSTED as a sale ('pos'): a comped line (and a
  -- Complimentary bill, which a note cannot credit) went in as 'pos_comp' at no revenue.
  IF NOT EXISTS (SELECT 1 FROM public.pos_bill_sales_rows(ARRAY[v_note.order_id]) r WHERE r.source = 'pos') THEN
    UPDATE pos_credit_notes SET ims_posted_at = now() WHERE id = p_note_id AND ims_posted_at IS NULL;
    RETURN 'nothing_to_post';
  END IF;

  -- S809 2e: a "not served" note waits for its bill's own sale (the link, never the bill's mark).
  IF v_note.restock
     AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_order_id = v_note.order_id AND s.source = 'pos') THEN
    RETURN 'bill_waiting';
  END IF;

  -- The reversal in ONE statement: sales_entries_stamp_pos_source marks the note with it and refuses
  -- a second statement for it. It names its note and no bill (sales_entry_link_mismatch).
  INSERT INTO sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate,
                             pos_credit_note_id, ingredient_deltas)
  SELECT v_period.id, r.recipe_id, v_bs_day, -r.qty_sold,
         CASE WHEN v_note.restock THEN 'pos_credit_restock' ELSE 'pos_credit' END,
         r.unit_price, r.vat_rate, p_note_id, r.ingredient_deltas
    FROM public.pos_bill_sales_rows(ARRAY[v_note.order_id]) r
   WHERE r.source = 'pos'
   ORDER BY r.line_id;

  -- creditNoteRestockMovements: the bill's own 'pos_sale' stock lines, negated item by item, on the
  -- note's day. Nothing for an item the bill took no stock of (a dish with no ingredients).
  IF v_note.restock THEN
    INSERT INTO stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
    SELECT v_note.client_id, m.item_id, v_period.id, v_bs_day, -sum(m.qty), 'pos_credit_restock', v_note.order_id
      FROM stock_movements m
     WHERE m.ref_id = v_note.order_id AND m.source = 'pos_sale' AND m.item_id IS NOT NULL
     GROUP BY m.item_id
    HAVING sum(m.qty) < -1e-9
     ORDER BY m.item_id;
  END IF;

  RETURN 'posted';
END;
$$;


-- ── 2. Post a note as it is issued: into the open month holding its Nepal issue day ─────────────
-- Returns pos_post_credit_note_into's answer, or not_found, undated (a day outside bs_months) or
-- month_not_open (that month is not started, or is closed, in Inventory: the note waits).
CREATE OR REPLACE FUNCTION public.pos_post_credit_note_to_ims(p_note_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_note   record;
  v_day    date;
  v_month  record;
  v_period uuid;
BEGIN
  SELECT n.client_id, n.created_at INTO v_note FROM pos_credit_notes n WHERE n.id = p_note_id;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  v_day := (v_note.created_at AT TIME ZONE 'Asia/Kathmandu')::date;
  SELECT m.bs_year, m.bs_month INTO v_month
    FROM bs_months m
   WHERE v_day >= m.ad_start AND v_day < m.ad_start + m.days;
  IF v_day IS NULL OR v_month.bs_year IS NULL THEN
    RETURN 'undated';
  END IF;
  SELECT p.id INTO v_period
    FROM monthly_periods p
   WHERE p.client_id = v_note.client_id
     AND p.bs_year = v_month.bs_year AND p.bs_month = v_month.bs_month
     AND p.status = 'open';
  IF v_period IS NULL THEN
    RETURN 'month_not_open';
  END IF;

  RETURN public.pos_post_credit_note_into(p_note_id, v_period);
END;
$$;


-- ── 3. Issuing a note posts it ─────────────────────────────────────────────────────────────────
-- SECURITY DEFINER: the post's writes pass the INVOKER guards (it makes their checks itself, above)
-- and the browser roles need no grant on the steps. A failed post is rolled back whole and logged;
-- the note stands, and waits for Post to Inventory.
--
-- The operator's restore is left alone: guard_pos_credit_note keeps a restored note's first-issued
-- time (any other insert is dated now()) and its mark, and the restore brings the note's reversal
-- rows with it. A note dated before this transaction, or already marked, is not posted here.
CREATE OR REPLACE FUNCTION public.pos_credit_notes_post_to_inventory()
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
  IF NEW.created_at < now() THEN
    RETURN NULL;
  END IF;
  BEGIN
    PERFORM public.pos_post_credit_note_to_ims(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT, v_hint = PG_EXCEPTION_HINT;
    RAISE WARNING 'pos_credit_notes_post_to_inventory: credit note % issued but was not posted to Inventory (% %: %); it waits for Post to Inventory',
      NEW.id, v_state, COALESCE(v_hint, ''), v_msg;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pos_credit_notes_post_to_inventory ON public.pos_credit_notes;
CREATE TRIGGER pos_credit_notes_post_to_inventory
  AFTER INSERT ON public.pos_credit_notes
  FOR EACH ROW
  WHEN (NEW.ims_posted_at IS NULL)
  EXECUTE FUNCTION public.pos_credit_notes_post_to_inventory();


-- ── 4. Post a month's waiting credit notes ─────────────────────────────────────────────────────
-- Answers { posted, already, nothing_to_post, bill_waiting, not_posted, failed, remaining, error,
-- failed_note }: this call's outcomes (bill_waiting: "not served" notes whose bill is not in yet;
-- not_posted: notes the step declined otherwise, e.g. Inventory off), how many of the month's notes
-- still wait after it, and the first failure's message and note. A failed note is left waiting and
-- retried by the next call; the page stops calling when a call moves nothing. The app posts the
-- month's waiting bills first (post_waiting_pos_bills), so a "not served" note finds its bill in.
CREATE OR REPLACE FUNCTION public.post_waiting_credit_notes(p_period_id uuid, p_limit integer DEFAULT 100)
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
  v_waiting   integer := 0;
  v_declined  integer := 0;
  v_failed    integer := 0;
  v_error     text;
  v_failed_id uuid;
  v_remaining integer;
BEGIN
  SELECT p.id, p.client_id, p.bs_year, p.bs_month, p.status INTO v_period
    FROM monthly_periods p
   WHERE p.id = p_period_id;

  -- post_waiting_pos_bills' rights: the operator for any outlet; the outlet's Owner any month; a POS
  -- manager of the outlet its open month only. Wrapped whole: is_admin() and my_client_id() are NULL
  -- for a login with no profile.
  IF NOT COALESCE(v_period.id IS NOT NULL
                  AND (public.is_admin()
                       OR (v_period.client_id = public.my_client_id()
                           AND (public.is_client_owner()
                                OR (v_period.status = 'open' AND public.pos_caller_has_rank('manager'))))), false) THEN
    RAISE EXCEPTION 'post_waiting_credit_notes: credit notes are posted to Inventory by the Owner, or by a POS manager of this outlet while the month is open'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- The month's span in Nepal time (bsDayBoundaryIso), by the day each note was issued.
  SELECT (m.ad_start + time '00:00') AT TIME ZONE 'Asia/Kathmandu',
         ((m.ad_start + m.days) + time '00:00') AT TIME ZONE 'Asia/Kathmandu'
    INTO v_from, v_to
    FROM bs_months m
   WHERE m.bs_year = v_period.bs_year AND m.bs_month = v_period.bs_month;
  IF v_from IS NULL THEN
    RETURN jsonb_build_object('posted', 0, 'already', 0, 'nothing_to_post', 0, 'bill_waiting', 0, 'not_posted', 0,
                              'failed', 0, 'remaining', 0, 'error', NULL, 'failed_note', NULL);
  END IF;
  -- Q31 (a), S831: a note on a bill closed before the outlet's Inventory began is never sent, so it
  -- neither takes a place in the batch nor counts as remaining (pos_ims_waiting_counts' rule).
  SELECT c.ims_since INTO v_since FROM clients c WHERE c.id = v_period.client_id;

  FOR v_id IN
    SELECT n.id
      FROM pos_credit_notes n
      JOIN pos_orders o ON o.id = n.order_id
     WHERE n.client_id = v_period.client_id
       AND n.ims_posted_at IS NULL
       AND n.created_at >= v_from AND n.created_at < v_to
       AND (v_since IS NULL OR o.closed_at >= v_since)
     ORDER BY n.created_at, n.id
     LIMIT v_limit
  LOOP
    BEGIN
      v_res := public.pos_post_credit_note_into(v_id, v_period.id);
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
      WHEN 'bill_waiting' THEN v_waiting := v_waiting + 1;
      ELSE v_declined := v_declined + 1;
    END CASE;
  END LOOP;

  SELECT count(*) INTO v_remaining
    FROM pos_credit_notes n
    JOIN pos_orders o ON o.id = n.order_id
   WHERE n.client_id = v_period.client_id
     AND n.ims_posted_at IS NULL
     AND n.created_at >= v_from AND n.created_at < v_to
     AND (v_since IS NULL OR o.closed_at >= v_since);

  RETURN jsonb_build_object('posted', v_posted, 'already', v_already, 'nothing_to_post', v_empty,
                            'bill_waiting', v_waiting, 'not_posted', v_declined, 'failed', v_failed,
                            'remaining', v_remaining, 'error', v_error, 'failed_note', v_failed_id);
END;
$$;


-- ── 5. Who can call what ───────────────────────────────────────────────────────────────────────
-- The owner only on the steps and the trigger function (a trigger function needs no grant: EXECUTE
-- is checked at CREATE TRIGGER time). The RPC for signed-in logins; it checks the caller itself.
REVOKE ALL ON FUNCTION public.pos_credit_notes_post_to_inventory() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pos_post_credit_note_to_ims(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.pos_post_credit_note_into(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_waiting_credit_notes(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_waiting_credit_notes(uuid, integer) TO authenticated;


-- ── 6. Every note on record, re-checked (read-only) ────────────────────────────────────────────
-- Each posted note's stored reversal, per recipe, source and VAT rate, must hold what the server's
-- reversal would write (quantity exactly, amount within a paisa), and a "not served" note's stock
-- lines must be its bill's own 'pos_sale' lines negated. A difference means the page and the server
-- disagree about some note, so nothing is changed until it is understood.
DO $$
DECLARE
  v_notes  integer;
  v_bad    integer;
  v_sample text;
  v_stock  integer;
BEGIN
  WITH notes AS (
    SELECT n.id, n.order_id, n.restock
      FROM public.pos_credit_notes n
     WHERE EXISTS (SELECT 1 FROM public.sales_entries s WHERE s.pos_credit_note_id = n.id)
  ),
  stored AS (
    SELECT s.pos_credit_note_id AS note_id, s.recipe_id, s.source, round(s.vat_rate::numeric, 4) AS vat,
           sum(s.qty_sold) AS qty, sum(s.qty_sold * s.unit_price) AS amt
      FROM public.sales_entries s JOIN notes n ON n.id = s.pos_credit_note_id
     GROUP BY 1, 2, 3, 4
  ),
  calc AS (
    SELECT n.id AS note_id, r.recipe_id,
           CASE WHEN n.restock THEN 'pos_credit_restock' ELSE 'pos_credit' END AS source,
           round(r.vat_rate::numeric, 4) AS vat, sum(-r.qty_sold) AS qty, sum(-r.qty_sold * r.unit_price) AS amt
      FROM notes n CROSS JOIN LATERAL public.pos_bill_sales_rows(ARRAY[n.order_id]) r
     WHERE r.source = 'pos'
     GROUP BY 1, 2, 3, 4
  ),
  cmp AS (
    SELECT COALESCE(s.note_id, c.note_id) AS note_id,
           (s.note_id IS NOT NULL AND c.note_id IS NOT NULL AND s.qty = c.qty AND abs(s.amt - c.amt) < 0.01) AS ok
      FROM stored s
      FULL JOIN calc c ON c.note_id = s.note_id AND c.recipe_id = s.recipe_id AND c.source = s.source AND c.vat = s.vat
  )
  SELECT (SELECT count(*) FROM notes), count(DISTINCT note_id) FILTER (WHERE NOT ok),
         string_agg(DISTINCT note_id::text, ', ') FILTER (WHERE NOT ok)
    INTO v_notes, v_bad, v_sample
    FROM cmp;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'S832 5f-4 parity: % of % posted credit notes hold a reversal the server would not write: %', v_bad, v_notes, v_sample;
  END IF;

  WITH notes AS (
    SELECT n.id, n.order_id, n.client_id
      FROM public.pos_credit_notes n
     WHERE n.restock
       AND EXISTS (SELECT 1 FROM public.sales_entries s WHERE s.pos_credit_note_id = n.id)
  ),
  stored AS (
    SELECT n.id AS note_id, m.item_id, sum(m.qty) AS qty
      FROM notes n JOIN public.stock_movements m ON m.ref_id = n.order_id AND m.source = 'pos_credit_restock'
     GROUP BY 1, 2
  ),
  calc AS (
    SELECT n.id AS note_id, m.item_id, -sum(m.qty) AS qty
      FROM notes n JOIN public.stock_movements m ON m.ref_id = n.order_id AND m.source = 'pos_sale' AND m.item_id IS NOT NULL
     GROUP BY 1, 2
    HAVING sum(m.qty) < -1e-9
  )
  SELECT count(*) INTO v_stock
    FROM stored s FULL JOIN calc c ON c.note_id = s.note_id AND c.item_id = s.item_id
   WHERE s.note_id IS NULL OR c.note_id IS NULL OR abs(s.qty - c.qty) > 1e-6;
  IF v_stock > 0 THEN
    RAISE EXCEPTION 'S832 5f-4 parity: % stock lines of "not served" credit notes differ from their bills'' own, negated', v_stock;
  END IF;
  RAISE NOTICE 'S832 5f-4 parity: % posted credit notes re-checked, all matching', v_notes;
END;
$$;


-- ── 7. Prove it ────────────────────────────────────────────────────────────────────────────────
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
  v_day1    timestamptz;
  v_bs_day  integer;
  v_since   timestamptz;
  v_chicken uuid;
  v_wrap    uuid;
  v_b1 uuid; v_b2 uuid; v_b3 uuid; v_b4 uuid; v_b5 uuid; v_b6 uuid; v_b7 uuid; v_b8 uuid; v_b9 uuid;
  v_n1 uuid; v_n2 uuid; v_n3 uuid; v_n4 uuid; v_n5 uuid; v_n6 uuid; v_n7 uuid; v_n8 uuid; v_n9 uuid;
  v_line    uuid;
  v_res     text;
  v_r       jsonb;
  v_n       integer;
  v_rem_with integer;
  v_rem_all  integer;
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
    RAISE EXCEPTION 'S832 5f-4 probe: no POS outlet with Inventory, an open month holding today, a closed month, an Owner and unblocked manager and supervisor till logins';
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
  -- The bills close on day 1 of the open month at 00:15 in Nepal; every note is issued now, on
  -- today's day of the same month.
  v_day1   := (v_start + time '00:15') AT TIME ZONE 'Asia/Kathmandu';
  v_bs_day := v_today - v_start + 1;

  BEGIN
    -- ── Setup, as the migration's own role ─────────────────────────────────────────────────────
    -- Inventory from the start for this block (it is rolled back), so no bill below is "before".
    UPDATE public.clients SET ims_since = NULL WHERE id = v_client;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S832 5f-4 probe chicken', 'kg', 1, 0, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S832 5f-4 probe wrap', 'Food', 1) RETURNING id INTO v_wrap;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_wrap, v_chicken, 0.3);

    -- order_no is given, so the probe takes no lock on the outlet's real order series.
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990841, 'S832 5f-4 probe') RETURNING id INTO v_b1;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990842, 'S832 5f-4 probe') RETURNING id INTO v_b2;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990843, 'S832 5f-4 probe') RETURNING id INTO v_b3;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990844, 'S832 5f-4 probe') RETURNING id INTO v_b4;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990845, 'S832 5f-4 probe') RETURNING id INTO v_b5;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990846, 'S832 5f-4 probe') RETURNING id INTO v_b6;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990847, 'S832 5f-4 probe') RETURNING id INTO v_b7;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990848, 'S832 5f-4 probe') RETURNING id INTO v_b8;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990849, 'S832 5f-4 probe') RETURNING id INTO v_b9;

    -- PAN bills (no VAT), so each note's amounts are the bill's lines less its discount.
    -- B1: wrap ×2 @300 and a customized wrap @300 (its choice adds chicken), NPR 90 off: every wrap
    --     posts at 270. B2: wrap @300 and a comped wrap @300. B3, B4, B6, B7, B8, B9: wrap @300.
    -- B5: only an open item @200.
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_b1, v_client, 'S832 5f-4 probe wrap', v_wrap, 2, 300, 0),
      (v_b2, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0),
      (v_b3, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0),
      (v_b4, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0),
      (v_b5, v_client, 'S832 5f-4 probe water', NULL, 1, 200, 0),
      (v_b6, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0),
      (v_b7, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0),
      (v_b8, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0),
      (v_b9, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0);
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, selection_key)
      VALUES (v_b1, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0, 'probe') RETURNING id INTO v_line;
    INSERT INTO public.pos_order_item_options (client_id, order_id, order_item_id, option_name, ingredient_deltas)
      VALUES (v_client, v_b1, v_line, 'Extra chicken', jsonb_build_array(jsonb_build_object('item_id', v_chicken, 'qty', 0.05)));
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate, comped, comp_no, comp_fy, comp_reason)
      VALUES (v_b2, v_client, 'S832 5f-4 probe wrap', v_wrap, 1, 300, 0, true, 999832, v_fy, 'S832 5f-4 probe');

    -- ── Closes, as the migration's own role (the close guard steps aside; the post trigger does not)
    -- B4 closes while Inventory is off, so it waits; switching back on stamps today, which is cleared.
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 300,
           vat_registered = false, invoice_fy = v_fy, closed_at = v_day1
     WHERE id = v_b4;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    UPDATE public.clients SET ims_since = NULL WHERE id = v_client;
    -- B1, B2, B3, B5, B6, B7 close with Inventory on: each close posts its bill.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 90, paid_amount = 810,
           vat_registered = false, invoice_fy = v_fy, closed_at = v_day1
     WHERE id = v_b1;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0,
           paid_amount = CASE WHEN id = v_b5 THEN 200 ELSE 300 END,
           vat_registered = false, invoice_fy = v_fy, closed_at = v_day1
     WHERE id IN (v_b2, v_b3, v_b5, v_b6, v_b7);
    -- B9 closes on day 1 of the closed month: its month is not open, so it waits.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 300,
           vat_registered = false, invoice_fy = v_fy, closed_at = (v_cstart + time '00:15') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id = v_b9;
    IF (SELECT count(*) FROM public.pos_orders WHERE id IN (v_b1, v_b2, v_b3, v_b5, v_b6, v_b7) AND ims_posted_at IS NOT NULL) <> 6
       OR (SELECT count(*) FROM public.pos_orders WHERE id IN (v_b4, v_b9) AND ims_posted_at IS NULL) <> 2
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_b1 AND source = 'pos') <> 2 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the fixture bills did not post (or wait) at their close as 5f-1 does';
    END IF;
    -- B7's "not served" stock line is already there (a stand-in for any failure), so its note's post
    -- will be refused by stock_movements_one_restock_per_bill_item.
    INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
      VALUES (v_client, v_chicken, v_period, 1, 0.01, 'pos_credit_restock', v_b7);

    -- ── Notes, as the outlet's POS manager, on a till of this release ───────────────────────────
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;

    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b1, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', false, 900, 90, 0, 810, 0, 810)
      RETURNING id INTO v_n1;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b2, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', false, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n2;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b3, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', true, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n3;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b4, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', true, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n4;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b5, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', false, 200, 0, 0, 200, 0, 200)
      RETURNING id INTO v_n5;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b7, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', true, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n7;
    RESET ROLE;

    -- (1) N1 (discount, a customized line): posted as it was issued, on today's day of the open month:
    --     exactly the bill's own sales rows, negated, naming the note and no bill; no stock put back.
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n1) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n1) <> 2
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n1
                   AND (source <> 'pos_credit' OR pos_order_id IS NOT NULL OR period_id <> v_period
                        OR bs_day <> v_bs_day OR abs(unit_price - 270) > 1e-9))
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n1 AND ingredient_deltas IS NOT NULL) <> 1
       OR EXISTS ((SELECT recipe_id, -qty_sold, unit_price, vat_rate, ingredient_deltas FROM public.sales_entries
                    WHERE pos_order_id = v_b1 AND source = 'pos')
                  EXCEPT ALL
                  (SELECT recipe_id, qty_sold, unit_price, vat_rate, ingredient_deltas FROM public.sales_entries
                    WHERE pos_credit_note_id = v_n1))
       OR EXISTS ((SELECT recipe_id, qty_sold, unit_price, vat_rate, ingredient_deltas FROM public.sales_entries
                    WHERE pos_credit_note_id = v_n1)
                  EXCEPT ALL
                  (SELECT recipe_id, -qty_sold, unit_price, vat_rate, ingredient_deltas FROM public.sales_entries
                    WHERE pos_order_id = v_b1 AND source = 'pos'))
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_b1 AND source = 'pos_credit_restock') THEN
      RAISE EXCEPTION 'S832 5f-4 probe: N1 was not posted at its issue as its bill''s sales negated';
    END IF;
    -- (2) N2: the comped wrap is not taken back; the paid one is.
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n2) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n2) <> 1
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n2
            AND source = 'pos_credit' AND qty_sold = -1 AND unit_price = 300) <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: N2 took back a comped line, or not the paid one';
    END IF;
    -- (3) N3 ("not served", bill in): posted as pos_credit_restock, and the chicken is put back.
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n3) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n3
            AND source = 'pos_credit_restock' AND qty_sold = -1 AND unit_price = 300 AND bs_day = v_bs_day) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b3 AND source = 'pos_credit_restock') <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b3 AND source = 'pos_credit_restock'
            AND item_id = v_chicken AND period_id = v_period AND bs_day = v_bs_day AND abs(qty - 0.3 / 0.85) < 1e-9) <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: N3 (not served) did not post its reversal and put its stock back';
    END IF;
    -- (4) N4 ("not served", bill waiting): issued, unmarked, nothing written; the step says why.
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n4) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n4)
       OR EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_b4) THEN
      RAISE EXCEPTION 'S832 5f-4 probe: N4 was posted before its bill';
    END IF;
    v_res := public.pos_post_credit_note_into(v_n4, v_period);
    IF v_res IS DISTINCT FROM 'bill_waiting' THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the step answered % for a not-served note whose bill waits', v_res;
    END IF;
    -- (5) N5 (no dish on the bill): marked, nothing written.
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n5) IS NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n5) THEN
      RAISE EXCEPTION 'S832 5f-4 probe: N5 (nothing to take back) was not marked with nothing written';
    END IF;
    -- (6) N7: its post failed, and the note still stands, numbered and linked, unmarked, with nothing
    --     of its post left behind.
    IF (SELECT credit_note_no FROM public.pos_credit_notes WHERE id = v_n7) IS NULL
       OR (SELECT credit_note_id FROM public.pos_orders WHERE id = v_b7) IS DISTINCT FROM v_n7
       OR (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n7) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n7)
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b7 AND source = 'pos_credit_restock') <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: a failed post refused N7, or left part of itself behind';
    END IF;

    -- (7) N6, issued while Inventory is off: issued, unmarked, nothing written.
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b6, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', false, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n6;
    RESET ROLE;
    v_res := public.pos_post_credit_note_into(v_n6, v_period);
    IF v_res IS DISTINCT FROM 'no_ims'
       OR (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n6) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n6) THEN
      RAISE EXCEPTION 'S832 5f-4 probe: a note issued with Inventory off was sent (step answered %)', v_res;
    END IF;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    UPDATE public.clients SET ims_since = NULL WHERE id = v_client;

    -- (8) N9, as the operator's restore brings it back: a note first issued in the closed month,
    --     unmarked. The issue trigger leaves it alone. Fiscal year 86/87, as the S809 3j probe did, so
    --     it never takes the outlet's real credit-note series.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount, created_at)
      VALUES (v_client, v_b9, '86/87', 1, 'S832 5f-4 probe', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', false,
              300, 0, 0, 300, 0, 300, (v_cstart + time '00:30') AT TIME ZONE 'Asia/Kathmandu')
      RETURNING id INTO v_n9;
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n9) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n9) THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the issue trigger posted a restored note';
    END IF;

    -- ── The month's waiting notes, as the POS manager ──────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;
    -- The bills first, as the app does: B4 goes in.
    v_r := public.post_waiting_pos_bills(v_period, 200);
    v_r := public.post_waiting_credit_notes(v_period, 200);
    RESET ROLE;

    -- (9) N4 now posts, and puts B4's chicken back; N6 posts; N7 fails again and still waits.
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n4) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n4
            AND source = 'pos_credit_restock' AND qty_sold = -1 AND bs_day = v_bs_day) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b4 AND source = 'pos_credit_restock'
            AND item_id = v_chicken AND period_id = v_period AND bs_day = v_bs_day AND abs(qty - 0.3 / 0.85) < 1e-9) <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the month''s post did not post N4 after its bill (answer %)', v_r;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n6) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n6 AND source = 'pos_credit') <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the month''s post did not post N6 (answer %)', v_r;
    END IF;
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n7) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n7)
       OR (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n9) IS NOT NULL THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the month''s post posted N7 (failing) or N9 (another month) (answer %)', v_r;
    END IF;
    IF (v_r ->> 'posted')::int < 2 OR (v_r ->> 'failed')::int < 1 OR (v_r ->> 'remaining')::int < 1
       OR v_r ->> 'error' IS NULL OR (v_r ->> 'failed_note')::uuid IS DISTINCT FROM v_n7 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the answer does not count what was done: %', v_r;
    END IF;

    -- (10) A note whose reversal is in but whose mark is not: marked, never posted again. A second
    --      call posts nothing.
    UPDATE public.pos_credit_notes SET ims_posted_at = NULL WHERE id = v_n2;
    SET LOCAL ROLE authenticated;
    v_r := public.post_waiting_credit_notes(v_period, 200);
    RESET ROLE;
    IF (v_r ->> 'posted')::int <> 0 OR (v_r ->> 'already')::int < 1
       OR (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n2) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n2) <> 1
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n4) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b4 AND source = 'pos_credit_restock') <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: a second call posted again, or a reversal already in was posted twice: %', v_r;
    END IF;
    v_res := public.pos_post_credit_note_into(v_n1, v_period);
    IF v_res IS DISTINCT FROM 'already' THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the step answered % for a note already posted', v_res;
    END IF;

    -- (11) Refused: the manager on the closed month; the manager on another outlet's month; the
    --      supervisor on the open month. Each names rank_required.
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      PERFORM public.post_waiting_credit_notes(v_closed, 200);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' THEN
      RAISE EXCEPTION 'S832 5f-4 probe: a POS manager posting a closed month''s notes answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    IF v_operiod IS NOT NULL THEN
      v_hint := NULL;
      BEGIN
        PERFORM public.post_waiting_credit_notes(v_operiod, 200);
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S832 5f-4 probe: a POS manager posting another outlet''s notes answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sup)::text, true);
    v_hint := NULL;
    BEGIN
      PERFORM public.post_waiting_credit_notes(v_period, 200);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'rank_required' THEN
      RAISE EXCEPTION 'S832 5f-4 probe: a POS supervisor posting notes answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (12) The Owner posts the closed month: N9 lands on day 1 of it.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    v_r := public.post_waiting_credit_notes(v_closed, 200);
    RESET ROLE;
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n9) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n9 AND period_id = v_closed
            AND bs_day = 1 AND source = 'pos_credit' AND qty_sold = -1) <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the Owner''s post of the closed month did not post N9 on its day 1: %', v_r;
    END IF;

    -- (13) Inventory began after B8 closed (00:05 on day 1, the start at 00:10): its note is issued and
    --      never sent, and the month's post neither touches it nor counts it as remaining.
    v_since := (v_start + time '00:10') AT TIME ZONE 'Asia/Kathmandu';
    UPDATE public.clients SET ims_since = v_since WHERE id = v_client;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 300,
           vat_registered = false, invoice_fy = v_fy, closed_at = (v_start + time '00:05') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id = v_b8;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b8, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4 probe', 'none', false, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n8;
    v_r := public.post_waiting_credit_notes(v_period, 200);
    RESET ROLE;
    v_res := public.pos_post_credit_note_into(v_n8, v_period);
    IF v_res IS DISTINCT FROM 'before_inventory'
       OR (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n8) IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.sales_entries WHERE pos_credit_note_id = v_n8) THEN
      RAISE EXCEPTION 'S832 5f-4 probe: a note on a bill from before Inventory began was sent (step answered %)', v_res;
    END IF;
    SELECT count(*) FILTER (WHERE o.closed_at >= v_since), count(*) INTO v_rem_with, v_rem_all
      FROM public.pos_credit_notes n
      JOIN public.pos_orders o ON o.id = n.order_id
      JOIN public.bs_months m ON m.ad_start = v_start
     WHERE n.client_id = v_client AND n.ims_posted_at IS NULL
       AND n.created_at >= (m.ad_start + time '00:00') AT TIME ZONE 'Asia/Kathmandu'
       AND n.created_at < ((m.ad_start + m.days) + time '00:00') AT TIME ZONE 'Asia/Kathmandu';
    IF (v_r ->> 'remaining')::int IS DISTINCT FROM v_rem_with OR v_rem_all <= v_rem_with THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the post counted % remaining; % wait since the start, % in the whole month',
        v_r ->> 'remaining', v_rem_with, v_rem_all;
    END IF;

    -- (14) Who can call what.
    IF NOT has_function_privilege('authenticated', 'public.post_waiting_credit_notes(uuid, integer)', 'EXECUTE')
       OR has_function_privilege('anon', 'public.post_waiting_credit_notes(uuid, integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_post_credit_note_into(uuid, uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_post_credit_note_to_ims(uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.pos_credit_notes_post_to_inventory()', 'EXECUTE') THEN
      RAISE EXCEPTION 'S832 5f-4 probe: the grants are not authenticated-only on the RPC and owner-only on the steps';
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's832_5f4_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's832_5f4_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';


-- ── 8. What this step acts on, live (the last statement, so `db query` prints it) ─────────────
SELECT
  (SELECT count(*) FROM public.pos_credit_notes WHERE ims_posted_at IS NULL) AS notes_waiting,
  (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t
    WHERE t.tgname = 'pos_credit_notes_post_to_inventory' AND t.tgrelid = 'public.pos_credit_notes'::regclass
      AND NOT t.tgisinternal) AS issue_trigger,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_post_credit_note_into(uuid, uuid)'::regprocedure) AS post_into_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_post_credit_note_to_ims(uuid)'::regprocedure) AS issue_post_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.post_waiting_credit_notes(uuid, integer)'::regprocedure) AS rpc_md5,
  has_function_privilege('authenticated', 'public.post_waiting_credit_notes(uuid, integer)', 'EXECUTE') AS rpc_for_logins;
