-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 2, slice 2e: a Credit Note is finished in the transaction that issues it, takes only
-- the bill's cash out of the drawer, and can put the bill's food back into Inventory.
--
--   CREDIT-NOTES-2 (P2). The note and the bill's "credited" mark were two browser requests, and the
--   cash refund and the points reversal were two more after them. A dropped connection after the
--   note landed left the bill unlinked for good (still "owed" in Customers, still a sale on the
--   dashboards, still showing the Credit Note button), and a lost reply to the note itself skipped
--   the refund and the reversal too, with nothing that could run them later. A new AFTER INSERT
--   trigger on pos_credit_notes, pos_credit_note_settle(), now does all three inside the note's own
--   INSERT: it marks the bill credited, records the cash refund on the open shift, and reverses the
--   bill's loyalty (reverse_loyalty_for_credit_note, unchanged and idempotent). Either the note and
--   all three land, or none of them does and nothing is numbered. It is SECURITY INVOKER: the link
--   is the same UPDATE the screen sent, so it meets guard_pos_order_close's link rule and every
--   policy on pos_orders, and the refund meets pos_cash_movements_guard (manager, an OPEN shift read
--   FOR SHARE, no more than the note, one per note). The operator's restore (an admin INSERT dated
--   before now(), guard_pos_credit_note's S809 1l test) and non-client sessions only get the link:
--   the restore brings the cash and points ledgers back as they were.
--   What is left after the INSERT is the print and the Inventory posting. The till prints first now;
--   a note whose print never happened is printed from the Credit Note Book (its first print is the
--   original), and its Inventory posting is the S747 waiting mark that Periods posts.
--
--   SHIFTS-3 (P2). The refund always took the WHOLE bill out of the drawer record. It is now
--   pos_bill_cash_taken(order): paid_amount of a Cash bill; the Cash legs of a Split bill (a Loyalty
--   leg comes back as points, a card or wallet leg goes back the way it came); for a Credit bill,
--   paid_amount less the platform's commission once it was settled in cash, else 0; any other method
--   0. Never more than the note. The same function feeds the till's sentence ("NPR 1,000 of this bill
--   was paid in cash"), so the figure on screen and the figure in the drawer are one definition. A
--   cash refund with no shift open refuses the note (HINT credit_note_refund_no_shift); the screen
--   says so before Issue, as it always has. A note whose bill took no cash records no refund.
--
--   CREDIT-NOTES-1 (P2; owner decision Q10 a, 2026-10-09). A note never touched stock, so crediting a
--   bill to bill it again, or crediting a duplicate, left that food used twice in Inventory: Book
--   Stock and the Reorder list read low until the count, and that month's Variance read low for good.
--   The note now asks whether the food was served. pos_credit_notes.restock (NOT NULL DEFAULT false)
--   holds the answer, set when the note is issued and locked after (guard_pos_credit_note's UPDATE
--   allow-list does not name it). A note answered "not served" posts its Inventory reversal under a
--   new sales_entries source, 'pos_credit_restock': the same rows a 'pos_credit' reversal writes
--   (negative qty, the bill's discounted price, the note's id), so revenue, quantities and every
--   revenue report read it exactly as before, but the shared depletion rule (salesDepletion.js) counts
--   it, so the plates come back out of theoretical usage (Stock Report, Reorder, Variance, Shrinkage,
--   the Owner Report). It also writes POSITIVE stock_movements rows, source 'pos_credit_restock',
--   ref_id the credited bill: the bill's own 'pos_sale' depletion negated item by item, so Book Stock
--   and Stock Movements put back exactly what the bill took. Both land in the note's own Inventory
--   month and day, beside its revenue reversal. COGS (opening + purchases − the counted closing) never
--   moved and does not move now.
--   sales_entries_source_check admits the new source. ims_sales_entries_guard admits it from the
--   people who post a 'pos_credit' row (POS manager, IMS supervisor; the Owner as before), and, for
--   the Owner and every staff login (not the operator), requires the row to match its note: a
--   'pos_credit_restock' row must take sales back (qty < 0) and name a note answered "not served"
--   (HINT pos_credit_restock_invalid), and a 'pos_credit' row may not name such a note (HINT
--   credit_note_restock_mismatch: a page older than this release would otherwise post the note as a
--   plain reversal and the food would never come back). ims_stock_movements_guard admits a restock
--   movement from the same people, and for the Owner too requires qty > 0 and a bill whose note says
--   "not served". A new partial unique index, stock_movements_one_restock_per_bill_item, keeps one
--   restock row per bill and item, so a post that runs twice cannot put the food back twice.
--
--   S809.4 (found in 2b, pulled forward). guard_pos_credit_note kept a created_at a client session
--   sent, and the printed note's Date and Miti are read from it, so a REST insert could backdate a
--   note. Outside the operator's restore it is now now().
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-09 after slice 2b). Section 0
-- refuses to run over any other body. Every change inside them is a block marked "S809 2e".
--   guard_pos_credit_note()         698df246f07fb00a23a1dda876aff6f8  (slice 2b's)
--   ims_sales_entries_guard()       b33d9b1e7ea6ccae944d602d5f6e2fe6  (S792's)
--   ims_stock_movements_guard()     85ceefc09e983f57b0412ee8cdf3c888  (S756's)
-- Called, not replaced: reverse_loyalty_for_credit_note(uuid) 83701ae71762bc495977ca981ab5e69e and
-- guard_pos_order_close() 5a50b8bc5ea06f2102e6440e16173e1d (slice 2c is replacing it in parallel; the
-- link rule this relies on is its section (A) credit_note_id clause, which 2c does not change; the
-- probe proves the link behaviourally against whichever body is live).
-- New: pos_bill_cash_taken(uuid) (SQL, STABLE, INVOKER) and pos_credit_note_settle() (the trigger).
-- Owned by slice 2f and not touched here: its sales_entries_stamp_pos_source statement trigger. It
-- stamps pos_credit_notes.ims_posted_at from 'pos_credit' rows only, so a "not served" note is still
-- stamped by the screen that posts it (as every note was before 2f); adding 'pos_credit_restock' to
-- 2f's credit list at integration would close that gap for these notes too. Nothing here writes a
-- 'pos' or 'pos_comp' row. Any probe that inserts a Credit Note after this lands (2f's does) now gets
-- the link, the refund and the loyalty reversal with it: with refund_method 'cash' it needs an open
-- shift, or it is refused (credit_note_refund_no_shift).
--
-- Live before this migration (2026-10-09), the whole project:
--   * 0 Credit Notes, 0 POS bills, 0 shifts, 0 cash movements, 0 payment legs and 0 loyalty
--     reversals (BLOOM CAFE, the only client that ever billed, was cleared by the owner today; no
--     other client has a POS bill or a note). So no note is left unlinked, half-refunded or
--     half-reversed, and nothing needs repairing.
--   * sales_entries: 1,829 rows, every one 'manual'. stock_movements: 6,514 rows, every one 'manual'.
--     The widened CHECK, the guards' new refusals and the new unique index reject 0 existing rows.
-- The new column is NOT NULL DEFAULT false (no table rewrite on Postgres 11+). No row is written.
--
-- Apply BEFORE the app release that sends `restock` and reads pos_bill_cash_taken (the Issue Credit
-- Note screen refuses to load without the function, and the Periods backfill selects the column).
-- A till on the current build (crest-v419 and older) keeps working: it sends no restock (false), its
-- own link PATCH becomes a no-op, its own refund insert is refused by the one-refund-per-note index
-- (the trigger already recorded the right amount) and shows its "check the Refund line" warning, and
-- its loyalty call is told the reversal is already done.
--
-- The probe at the end runs as BLOOM CAFE's two POS PIN logins (a manager and a supervisor stand-in),
-- its Owner and the operator, inside a block that rolls itself back. It brings its own Inventory
-- month, item, dish, shift, bills, payment legs, customer and points. If any check fails, the whole
-- migration fails and nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
--
-- CREATE OR REPLACE would silently revert another change to any of them. The second hash of each
-- pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '698df246f07fb00a23a1dda876aff6f8' AND v_md5 IS DISTINCT FROM '5d47faa30c2b2ebccca7d1abab6d335a' THEN
    RAISE EXCEPTION 'S809 2e: guard_pos_credit_note changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'b33d9b1e7ea6ccae944d602d5f6e2fe6' AND v_md5 IS DISTINCT FROM '492abc0353f288a2bcb9daba12f60434' THEN
    RAISE EXCEPTION 'S809 2e: ims_sales_entries_guard changed since this slice was drafted (live md5 %) — merge section 6 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_stock_movements_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '85ceefc09e983f57b0412ee8cdf3c888' AND v_md5 IS DISTINCT FROM '0243bef6e3ee9694384e63166fbe9474' THEN
    RAISE EXCEPTION 'S809 2e: ims_stock_movements_guard changed since this slice was drafted (live md5 %) — merge section 7 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  -- The two new functions: absent, or exactly what this file writes (a re-run).
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'pos_credit_note_settle';
  IF FOUND AND v_md5 IS DISTINCT FROM '1bb4fdd35e86f0977bd1d41a84b845f0' THEN
    RAISE EXCEPTION 'S809 2e: a pos_credit_note_settle already exists with another body (md5 %)', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'pos_bill_cash_taken';
  IF FOUND AND v_md5 IS DISTINCT FROM 'd5860a4ca0a41759e186e495828db44f' THEN
    RAISE EXCEPTION 'S809 2e: a pos_bill_cash_taken already exists with another body (md5 %)', v_md5;
  END IF;
  -- No public function may have a second overload (the S630 rule).
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname IN ('pos_credit_note_settle', 'pos_bill_cash_taken')) > 2 THEN
    RAISE EXCEPTION 'S809 2e: pos_credit_note_settle or pos_bill_cash_taken has more than one signature';
  END IF;
  -- The trigger calls reverse_loyalty_for_credit_note as the signed-in login, which needs EXECUTE.
  IF NOT has_function_privilege('authenticated', 'public.reverse_loyalty_for_credit_note(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 2e: authenticated cannot execute reverse_loyalty_for_credit_note';
  END IF;
END;
$$;


-- ── 1. Schema: the note's answer, the new source, one restock row per bill and item ───────────
ALTER TABLE public.pos_credit_notes
  ADD COLUMN IF NOT EXISTS restock boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.pos_credit_notes.restock IS
  'S809 2e (Q10 a): true when the manager said the food on the credited bill was NOT served on it (it is billed again on a new bill, or the bill was a duplicate), so the note''s Inventory reversal also puts that food back (sales_entries / stock_movements source pos_credit_restock). Set at issue, never changed.';

-- One statement, so the table is never without the constraint. Validates 1,829 'manual' rows.
ALTER TABLE public.sales_entries
  DROP CONSTRAINT IF EXISTS sales_entries_source_check,
  ADD CONSTRAINT sales_entries_source_check
    CHECK (source = ANY (ARRAY['manual'::text, 'pos'::text, 'pos_comp'::text, 'pos_credit'::text, 'pos_credit_restock'::text]));

-- One restock row per bill and item: the post (Issue Credit Note, then Periods' backfill if that
-- failed) can run twice; the food comes back once. Leading column ref_id also serves the lookup.
-- 0 live rows carry the source.
CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_one_restock_per_bill_item
  ON public.stock_movements (ref_id, item_id)
  WHERE source = 'pos_credit_restock';


-- ── 2. pos_bill_cash_taken: the cash a paid bill brought into the drawer ─────────────────────
--
-- The SQL twin of the Shifts report's cash rules (PosShifts.jsx loadShiftReport, and since S809 1l
-- pos_shifts_guard): a Cash bill's paid_amount; a Split bill's Cash legs; a Credit bill settled in
-- cash brings paid_amount − commission (the S754 settlement posting). A Loyalty leg is points, given
-- back by the loyalty reversal; Card, eSewa, Khalti and FonePay go back the way they came. NULL when
-- the caller cannot see a paid bill by that id.
-- SECURITY INVOKER (plain SQL): it reads as the signed-in login, through every policy on pos_orders
-- and pos_order_payments, the same rows Issue Credit Note reads. Called by that screen (to say how
-- much cash goes back) and by pos_credit_note_settle (to record it), so the two cannot disagree.
CREATE OR REPLACE FUNCTION public.pos_bill_cash_taken(p_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT round(GREATEST(COALESCE(
           CASE
             WHEN o.payment_method = 'Cash' THEN o.paid_amount
             WHEN o.payment_method = 'Split' THEN
               (SELECT sum(p.amount) FROM pos_order_payments p
                 WHERE p.order_id = o.id AND p.payment_method = 'Cash')
             WHEN o.payment_method = 'Credit' AND o.credit_settled_at IS NOT NULL
                  AND o.credit_settled_method = 'Cash'
               THEN o.paid_amount - COALESCE(o.commission_amount, 0)
             ELSE 0
           END, 0), 0), 2)
    FROM pos_orders o
   WHERE o.id = p_order_id
     AND o.status = 'billed' AND o.close_type = 'paid'
$function$;
REVOKE ALL ON FUNCTION public.pos_bill_cash_taken(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_bill_cash_taken(uuid) TO authenticated, service_role;


-- ── 3. guard_pos_credit_note (the INSERT branch: created_at is the server's) ──────────────────
CREATE OR REPLACE FUNCTION public.guard_pos_credit_note()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order record;
  v_lines numeric;
  v_allowed CONSTANT text[] := ARRAY['print_count', 'ims_posted_at'];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos_credit_notes: an issued credit note is a numbered tax document and cannot be deleted'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
      RAISE EXCEPTION 'pos_credit_notes: an issued credit note cannot be changed — only its print count and Inventory posting mark are recorded afterwards'
        USING ERRCODE = '42501', HINT = 'bill_locked';
    END IF;

    -- ── S809 1c (CREDIT-NOTES-6): the two columns that may still move, each one way ─────────
    -- The reprint's copy mark is read from print_count, so it only goes up; a lower value is
    -- ignored, as on a bill (guard_pos_order_close). ims_posted_at says the note's reversal
    -- reached Inventory: set on a note that never posted, the bill's revenue stays in Inventory
    -- for good. It is set by the people who post a note — a POS manager (who issues it), the
    -- Owner or the operator (Periods) — and once set it stands.
    NEW.print_count := GREATEST(OLD.print_count, NEW.print_count);
    IF NEW.ims_posted_at IS DISTINCT FROM OLD.ims_posted_at THEN
      IF OLD.ims_posted_at IS NOT NULL THEN
        NEW.ims_posted_at := OLD.ims_posted_at;
      ELSIF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
        RAISE EXCEPTION 'pos_credit_notes: marking a Credit Note as posted to Inventory needs POS Manager access or above'
          USING ERRCODE = '42501', HINT = 'rank_required';
      END IF;
    END IF;
    -- ── end S809 1c ────────────────────────────────────────────────────────────────────────

    RETURN NEW;
  END IF;

  -- INSERT. The operator's restore carries the historical rows as they were.
  -- ── S809 1l (GAP-OPERATOR-1, Q26 a): the restore, and nothing else the operator sends ─────
  -- A restored note carries the time it was first issued. Issue Credit Note never sends created_at,
  -- so a note issued from the screen (by the operator too) is dated now() by the column default and
  -- meets every check below. That includes the S755 amount match: a note worked out under today's
  -- VAT setting against a bill printed under another is refused for Crest support as it is for the
  -- manager. The rank test below still admits the operator.
  IF COALESCE(public.is_admin(), false) AND NEW.created_at < now() THEN
    RETURN NEW;
  END IF;
  -- ── end S809 1l ──────────────────────────────────────────────────────────────────────────

  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'pos_credit_notes: issuing a Credit Note needs POS Manager access or above'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- The bill: this client's, a paid bill that is billed, with no note yet. Locked so two managers
  -- issuing against one bill queue, and the second sees the first note.
  SELECT o.id, o.client_id, o.status, o.close_type, o.credit_note_id, o.discount_amount, o.paid_amount
    INTO v_order
    FROM pos_orders o WHERE o.id = NEW.order_id
    FOR UPDATE;
  IF v_order.id IS NULL OR v_order.client_id IS DISTINCT FROM NEW.client_id
     OR v_order.status IS DISTINCT FROM 'billed' OR v_order.close_type IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'pos_credit_notes: a Credit Note is issued against a paid bill of this outlet'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;
  IF v_order.credit_note_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM pos_credit_notes n WHERE n.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'pos_credit_notes: this bill already has a Credit Note — a bill is credited once'
      USING ERRCODE = '23505', HINT = 'credit_note_exists';
  END IF;

  -- S755: the amounts are the bill's. A line this session cannot see lowers v_lines and is
  -- refused, never passed. The lines of a billed order are locked (S754), so they are the lines
  -- the bill was charged for.
  SELECT COALESCE(SUM(i.qty * i.unit_price), 0) INTO v_lines
    FROM pos_order_items i
   WHERE i.order_id = NEW.order_id AND NOT COALESCE(i.comped, false);

  IF NOT COALESCE(
        NEW.gross_amount >= 0 AND NEW.discount_amount >= 0 AND NEW.taxable_amount >= 0
    AND NEW.non_taxable_amount >= 0 AND NEW.vat_amount >= 0 AND NEW.net_amount > 0
    AND abs(NEW.gross_amount - v_lines) <= 0.01
    AND abs(NEW.discount_amount - COALESCE(v_order.discount_amount, 0)) <= 0.01
    AND abs((NEW.taxable_amount + NEW.non_taxable_amount) - (NEW.gross_amount - NEW.discount_amount)) <= 0.01
    AND abs(NEW.net_amount - (NEW.taxable_amount + NEW.non_taxable_amount + NEW.vat_amount)) <= 0.51
    AND abs(NEW.net_amount - COALESCE(v_order.paid_amount, 0)) <= 1
    AND (NEW.taxable_amount > 0.01 OR NEW.vat_amount <= 0.01)
  , false) THEN
    RAISE EXCEPTION 'pos_credit_notes: the amounts on this Credit Note do not match the bill it credits'
      USING ERRCODE = '23514', HINT = 'credit_note_amounts',
            DETAIL = format('note gross %s, discount %s, taxable %s, non-taxable %s, VAT %s, net %s; bill lines %s, discount %s, paid %s',
                            NEW.gross_amount, NEW.discount_amount, NEW.taxable_amount, NEW.non_taxable_amount,
                            NEW.vat_amount, NEW.net_amount, v_lines, COALESCE(v_order.discount_amount, 0),
                            v_order.paid_amount);
  END IF;

  -- ── S809 2b (CREDIT-NOTES-4): the note's year is Nepal's date at this instant ───────────────
  -- It picks the numbered series the note joins, and trg_assign_pos_credit_note_no fires after this
  -- trigger (guard_ sorts before trg_), so the request's year is ignored: a tablet on another time
  -- zone or a wrong date cannot file the note in last year's series, and a REST insert cannot name
  -- a closed year or start a new series with a stray string. The restore (above) keeps its year.
  NEW.invoice_fy := public.pos_invoice_fy(now());
  IF NEW.invoice_fy IS NULL THEN
    RAISE EXCEPTION 'pos_credit_notes: today''s date is past the end of Crest''s Nepali calendar, so no credit note number can be given and no note was issued — contact Crest support'
      USING ERRCODE = 'P0001', HINT = 'pos_fiscal_year_unknown';
  END IF;
  -- ── end S809 2b ──────────────────────────────────────────────────────────────────────────

  NEW.issued_by := (SELECT auth.uid());
  -- ── S809 2e (S809.4): the printed Date and Miti are read from created_at, so it is the server's ─
  -- The screen never sends it; a REST insert that did kept it and printed a backdated note. The
  -- restore (above) keeps the time a note was first issued.
  NEW.created_at := now();
  -- ── end S809 2e ──────────────────────────────────────────────────────────────────────────
  NEW.credit_note_no := NULL;   -- numbered by trg_assign_pos_credit_note_no, never by the request
  NEW.ims_posted_at := NULL;
  NEW.print_count := 0;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_pos_credit_note() FROM PUBLIC;


-- ── 4. pos_credit_note_settle: the bill, the drawer and the points, in the note's transaction ─
CREATE OR REPLACE FUNCTION public.pos_credit_note_settle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_restore boolean;
  v_linked  integer;
  v_cash    numeric;
  v_shift   uuid;
BEGIN
  -- ── S809 2e (CREDIT-NOTES-2, SHIFTS-3) ──────────────────────────────────────────────────────
  -- AFTER INSERT, so the note is already guarded (guard_pos_credit_note), numbered and visible. Any
  -- refusal below rolls the note back with it: nothing is issued and no number is used.
  --
  -- Not a client session (the service role or a SECURITY DEFINER body), or the operator's restore of
  -- a note as it was first issued (guard_pos_credit_note's S809 1l test): only the link. The restore
  -- brings back the shift's cash ledger and the points ledger as they were, refund and reversal rows
  -- included, so recording either again here would count it twice.
  v_restore := current_user NOT IN ('anon', 'authenticated')
            OR (COALESCE(public.is_admin(), false) AND NEW.created_at < now());

  -- 1. The bill is marked credited. SECURITY INVOKER on purpose: this is the UPDATE the screen used
  --    to send itself, so it meets guard_pos_order_close's link rule (POS manager, once, a paid bill,
  --    a note issued against it) and every policy on pos_orders. guard_pos_credit_note has just
  --    checked the same bill, locked FOR UPDATE, so for a note it let in the link always lands; if
  --    it ever matched nothing, the note is refused rather than left without its bill.
  UPDATE pos_orders o
     SET credit_note_id = NEW.id
   WHERE o.id = NEW.order_id AND o.client_id = NEW.client_id
     AND o.credit_note_id IS NULL AND o.status = 'billed' AND o.close_type = 'paid';
  GET DIAGNOSTICS v_linked = ROW_COUNT;

  IF v_restore THEN
    RETURN NULL;
  END IF;
  IF v_linked <> 1 THEN
    RAISE EXCEPTION 'pos_credit_notes: the bill could not be marked as credited, so no Credit Note was issued'
      USING ERRCODE = 'P0001', HINT = 'credit_note_link_failed';
  END IF;

  -- 2. Cash handed back comes out of the drawer, and only the cash this bill took (SHIFTS-3; see
  --    pos_bill_cash_taken). The row goes through pos_cash_movements_guard as the signed-in login:
  --    POS manager, the outlet's OPEN shift read FOR SHARE (a Close Shift waits for this note, or
  --    this note is refused after it), no more than the note, one per note, created_by and
  --    created_at stamped. The reason is the one the screen wrote.
  IF NEW.refund_method = 'cash' THEN
    v_cash := LEAST(COALESCE(public.pos_bill_cash_taken(NEW.order_id), 0), NEW.net_amount);
    IF v_cash > 0 THEN
      SELECT s.id INTO v_shift FROM pos_shifts s WHERE s.client_id = NEW.client_id AND s.status = 'open';
      IF v_shift IS NULL THEN
        RAISE EXCEPTION 'pos_credit_notes: no shift is open, so the cash refund has no drawer count to go on and no Credit Note was issued — open a shift, or choose Other or None'
          USING ERRCODE = 'P0001', HINT = 'credit_note_refund_no_shift';
      END IF;
      INSERT INTO pos_cash_movements (client_id, shift_id, direction, kind, amount, pos_credit_note_id, order_id, reason)
      VALUES (NEW.client_id, v_shift, 'out', 'refund', v_cash, NEW.id, NEW.order_id,
              left(format('Credit Note %s refund — %s', NEW.credit_note_no, NEW.reason), 500));
    END IF;
  END IF;

  -- 3. The bill's loyalty (the S754 owner decision): the points it earned are taken back and the
  --    points spent on it returned. The same function the screen called; it checks the caller is a
  --    POS manager, locks the note and writes at most two rows per customer, once per note.
  PERFORM public.reverse_loyalty_for_credit_note(NEW.id);
  -- ── end S809 2e ──────────────────────────────────────────────────────────────────────────

  RETURN NULL;
END;
$function$;
-- A trigger function: no EXECUTE for anyone (checked at CREATE TRIGGER, never at fire time).
REVOKE ALL ON FUNCTION public.pos_credit_note_settle() FROM PUBLIC;


-- ── 5. The trigger. AFTER, so it sees the numbered row; ROW, once per note ───────────────────
DROP TRIGGER IF EXISTS pos_credit_note_settle ON public.pos_credit_notes;
CREATE TRIGGER pos_credit_note_settle
  AFTER INSERT ON public.pos_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.pos_credit_note_settle();


-- ── 6. ims_sales_entries_guard (the restock source, and a reversal that matches its note) ─────
CREATE OR REPLACE FUNCTION public.ims_sales_entries_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old text;
  v_new text;
BEGIN
  -- ── S809 2e: the Owner is no longer waved through here; the operator still is ───────────────
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- A Credit Note's reversal follows the note's own answer (CREDIT-NOTES-1, Q10 a). A note that
  -- said its food was not served posts 'pos_credit_restock' rows, which take the plates back out of
  -- stock usage; any other note posts 'pos_credit'. Checked for the Owner as well as staff (only the
  -- operator's restore is exempt): a page older than this release posts every note as 'pos_credit',
  -- and the food would then never come back, so that post is refused and the note stays waiting for
  -- a page that posts it right. A restock row must take sales back (qty < 0) and name such a note.
  -- The note is read through this login's policies: a note it cannot see fails closed.
  IF TG_OP <> 'DELETE' THEN
    IF NEW.source = 'pos_credit' AND NEW.pos_credit_note_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM pos_credit_notes n WHERE n.id = NEW.pos_credit_note_id AND n.restock) THEN
      RAISE EXCEPTION 'credit_note_restock_mismatch: this Credit Note said its food was not served, so its Inventory posting must put the food back — post it again from a page that is up to date'
        USING ERRCODE = '42501', HINT = 'credit_note_restock_mismatch';
    END IF;
    IF NEW.source = 'pos_credit_restock'
       AND (NOT COALESCE(NEW.qty_sold < 0, false)
            OR NOT EXISTS (SELECT 1 FROM pos_credit_notes n WHERE n.id = NEW.pos_credit_note_id AND n.restock)) THEN
      RAISE EXCEPTION 'pos_credit_restock_invalid: food goes back into Inventory only through a Credit Note that said it was not served, and only as sales taken back'
        USING ERRCODE = '42501', HINT = 'pos_credit_restock_invalid';
    END IF;
  END IF;

  IF COALESCE(public.is_client_owner(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- ── end S809 2e ──────────────────────────────────────────────────────────────────────────

  IF TG_OP <> 'INSERT' THEN v_old := COALESCE(OLD.source, 'manual'); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := COALESCE(NEW.source, 'manual'); END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new = 'manual' AND public.ims_caller_has_rank('staff') THEN
      RETURN NEW;
    ELSIF v_new IN ('pos', 'pos_comp')
          AND (COALESCE(public.pos_caller_has_rank('supervisor'), false) OR public.ims_caller_has_rank('supervisor')) THEN
      RETURN NEW;
    -- S809 2e: a "not served" note's reversal is posted by the same people as any other note's.
    ELSIF v_new IN ('pos_credit', 'pos_credit_restock')
          AND (COALESCE(public.pos_caller_has_rank('manager'), false) OR public.ims_caller_has_rank('supervisor')) THEN
      RETURN NEW;
    END IF;
  ELSIF v_old = 'manual' AND COALESCE(v_new, 'manual') = 'manual' AND public.ims_caller_has_rank('staff') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'sales_entries: this sale (%) cannot be % from this login', COALESCE(v_new, v_old),
    CASE TG_OP WHEN 'INSERT' THEN 'recorded' WHEN 'DELETE' THEN 'removed' ELSE 'changed' END
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$function$;
REVOKE ALL ON FUNCTION public.ims_sales_entries_guard() FROM PUBLIC;


-- ── 7. ims_stock_movements_guard (stock a Credit Note puts back) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.ims_stock_movements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source text;
BEGIN
  -- ── S809 2e: the Owner is no longer waved through here; the operator still is ───────────────
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- A Credit Note that said its bill's food was not served puts that food back (CREDIT-NOTES-1,
  -- Q10 a): positive rows, the bill's own 'pos_sale' depletion negated, ref_id the credited bill. The
  -- Owner meets this too; only the operator's restore is exempt. A restock row must add stock and
  -- name a bill of this outlet whose note said so. One per bill and item
  -- (stock_movements_one_restock_per_bill_item).
  IF TG_OP = 'INSERT' AND NEW.source = 'pos_credit_restock'
     AND (NOT COALESCE(NEW.qty > 0, false)
          OR NOT EXISTS (SELECT 1 FROM pos_credit_notes n
                          WHERE n.order_id = NEW.ref_id AND n.client_id = NEW.client_id AND n.restock)) THEN
    RAISE EXCEPTION 'pos_credit_restock_invalid: stock goes back into Inventory only through a Credit Note that said its bill''s food was not served, and only as stock added'
      USING ERRCODE = '42501', HINT = 'pos_credit_restock_invalid';
  END IF;

  IF COALESCE(public.is_client_owner(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- ── end S809 2e ──────────────────────────────────────────────────────────────────────────

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'stock_movements: a stock movement is a ledger record and is not edited — delete and re-post the day instead'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;

  v_source := CASE WHEN TG_OP = 'INSERT' THEN NEW.source ELSE OLD.source END;
  IF v_source = 'manual' THEN
    IF public.ims_caller_has_rank('staff') THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  ELSIF v_source IN ('pos_sale', 'pos_comp') AND TG_OP = 'INSERT' THEN
    IF COALESCE(public.pos_caller_has_rank('supervisor'), false) OR public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
  -- S809 2e: posted with the note's revenue reversal, by the same people (ims_sales_entries_guard).
  ELSIF v_source = 'pos_credit_restock' AND TG_OP = 'INSERT' THEN
    IF COALESCE(public.pos_caller_has_rank('manager'), false) OR public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'stock_movements: this stock movement (%) cannot be % from this login', COALESCE(v_source, 'no source'),
    CASE TG_OP WHEN 'INSERT' THEN 'recorded' ELSE 'removed' END
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$function$;
REVOKE ALL ON FUNCTION public.ims_stock_movements_guard() FROM PUBLIC;


-- ── 8. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c        uuid;    -- BLOOM CAFE
  v_mgr      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS manager
  v_sup      uuid;    -- another POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_owner    uuid;
  v_admin    uuid;
  v_fy       text;    -- the year the server gives today
  v_y        int;     -- today's Nepal month
  v_m        int;
  v_day      int;
  v_p        uuid;    -- the probe's open Inventory month
  v_item     uuid;    -- an IMS item (chicken, kg)
  v_item2    uuid;    -- a second item (flour, kg)
  v_dish     uuid;    -- a dish
  v_cust     uuid;    -- a loyalty customer
  v_s        uuid;    -- the probe's shift
  v_b_cash   uuid;    -- 2 × NPR 1,000 at 13 % VAT, Cash NPR 2,260; earned 22 points
  v_b_split  uuid;    -- 1 × NPR 2,000 at 13 % VAT, Split: Cash 1,000 + Card 1,000 + Loyalty 260 (26 points)
  v_b_card   uuid;    -- 1 × NPR 500, no VAT, Card
  v_b_credit uuid;    -- 1 × NPR 500, no VAT, Credit, not settled
  v_b_noshift uuid;   -- 1 × NPR 300, no VAT, Cash (the refund with no shift open)
  v_b_settled uuid;   -- 1 × NPR 500, Credit, settled in Cash with NPR 50 commission
  v_b_rest   uuid;    -- a restored bill (the operator's restore)
  v_n1       uuid;    -- notes
  v_n2       uuid;
  v_n3       uuid;
  v_n4       uuid;
  v_n6       uuid;
  v_n        int;
  v_amt      numeric;
  v_ts       timestamptz;
  v_hint     text;
  v_msg      text;
  v_txt      text;
  v_past     timestamptz := now() - interval '30 days';
  c_open  CONSTANT jsonb := '{"1000": 1, "500": 1}';   -- NPR 1,500
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  -- The new trigger: AFTER INSERT, FOR EACH ROW (tgtype 1 + 4), enabled, on the new function; and
  -- the guard still BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW (1 + 2 + 4 + 8 + 16).
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid = 'public.pos_credit_notes'::regclass
     AND ((tgname = 'pos_credit_note_settle' AND tgtype = 5 AND tgfoid = 'public.pos_credit_note_settle()'::regprocedure)
       OR (tgname = 'guard_pos_credit_note' AND tgtype = 31 AND tgfoid = 'public.guard_pos_credit_note()'::regprocedure));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 2e: expected pos_credit_note_settle (AFTER INSERT ROW) and guard_pos_credit_note (BEFORE ROW) enabled, found %', v_n;
  END IF;
  -- Every function here runs as the signed-in login: the guards key on current_user, and the
  -- trigger's link and refund must meet guard_pos_order_close and pos_cash_movements_guard.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.guard_pos_credit_note()'::regprocedure, 'public.pos_credit_note_settle()'::regprocedure,
                 'public.ims_sales_entries_guard()'::regprocedure, 'public.ims_stock_movements_guard()'::regprocedure,
                 'public.pos_bill_cash_taken(uuid)'::regprocedure)
     AND NOT prosecdef;
  IF v_n <> 5 OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.pos_bill_cash_taken(uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'S809 2e: a function became SECURITY DEFINER, or pos_bill_cash_taken is not STABLE';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.pos_bill_cash_taken(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_bill_cash_taken(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_credit_note_settle()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 2e: pos_bill_cash_taken is not authenticated-only, or the trigger function is executable';
  END IF;
  -- The column: boolean, NOT NULL, default false.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.pos_credit_notes'::regclass AND a.attname = 'restock'
                    AND a.atttypid = 'boolean'::regtype AND a.attnotnull AND NOT a.attisdropped
                    AND pg_get_expr(d.adbin, d.adrelid) = 'false') THEN
    RAISE EXCEPTION 'S809 2e: pos_credit_notes.restock is not a NOT NULL boolean defaulting to false';
  END IF;
  -- The index: unique, partial, on (ref_id, item_id) in that order.
  IF NOT EXISTS (SELECT 1 FROM pg_index i
                  WHERE i.indexrelid = 'public.stock_movements_one_restock_per_bill_item'::regclass
                    AND i.indisunique AND i.indpred IS NOT NULL AND i.indnatts = 2
                    AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.stock_movements'::regclass AND attname = 'ref_id')
                    AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.stock_movements'::regclass AND attname = 'item_id')) THEN
    RAISE EXCEPTION 'S809 2e: stock_movements_one_restock_per_bill_item is not a partial unique index on (ref_id, item_id)';
  END IF;

  v_fy := public.pos_invoice_fy(now());
  SELECT m.bs_year, m.bs_month, ((now() AT TIME ZONE 'Asia/Kathmandu')::date - m.ad_start) + 1
    INTO v_y, v_m, v_day
    FROM public.bs_months m
   WHERE (now() AT TIME ZONE 'Asia/Kathmandu')::date >= m.ad_start
     AND (now() AT TIME ZONE 'Asia/Kathmandu')::date <  m.ad_start + m.days;
  IF v_fy IS NULL OR v_y IS NULL THEN
    RAISE EXCEPTION 'S809 2e probe: today is not in bs_months';
  END IF;

  -- ── The logins: two POS PIN logins of BLOOM CAFE (a manager and a supervisor stand-in), its
  -- Owner, the operator ──────────────────────────────────────────────────────────────────────
  SELECT id INTO v_c FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT p.id INTO v_mgr FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id LIMIT 1;
  SELECT p.id INTO v_sup FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
     AND p.id IS DISTINCT FROM v_mgr
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id LIMIT 1;
  SELECT p.id INTO v_owner FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND pos_role IS NULL AND ims_role IS NULL AND hr_role IS NULL
     AND pos_email IS NULL AND NOT COALESCE(hr_self_service, false)
   ORDER BY id LIMIT 1;
  IF v_c IS NULL OR v_mgr IS NULL OR v_sup IS NULL OR v_owner IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 2e probe: needs BLOOM CAFE, two of its POS PIN logins, its Owner and the operator (got %, %, %, %, %)',
      v_c, v_mgr, v_sup, v_owner, v_admin;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role (every guard lets it through) ─────────────────────
    -- The stand-ins lose every other staff marker, or a restrictive policy would turn an "allowed"
    -- into a vacuous 0 rows (the S792 lesson). BLOOM CAFE's own open shift and open Inventory month
    -- (if any) are closed for the length of the probe: one of each may be open per outlet.
    UPDATE public.profiles
       SET pos_role = CASE WHEN id = v_mgr THEN 'manager' ELSE 'supervisor' END,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id IN (v_mgr, v_sup);
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';
    UPDATE public.monthly_periods SET status = 'closed' WHERE client_id = v_c AND status = 'open';
    INSERT INTO public.monthly_periods (client_id, bs_year, bs_month, status) VALUES (v_c, v_y, v_m, 'open')
      ON CONFLICT (client_id, bs_year, bs_month) DO UPDATE SET status = 'open'
      RETURNING id INTO v_p;

    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate)
      VALUES (v_c, 'S809 2e probe chicken', 'kg', 1, 600) RETURNING id INTO v_item;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate)
      VALUES (v_c, 'S809 2e probe flour', 'kg', 1, 80) RETURNING id INTO v_item2;
    INSERT INTO public.recipes (client_id, name) VALUES (v_c, 'S809 2e probe momo') RETURNING id INTO v_dish;
    INSERT INTO public.pos_customers (client_id, name, phone) VALUES (v_c, 'S809 2e probe guest', '9800809205')
      RETURNING id INTO v_cust;

    -- Closed bills, as the till leaves them (a fixture, so the probe does not lean on the close
    -- guard slice 2c is changing). order_no and invoice_no are given, so the probe takes no lock on
    -- the outlet's real series.
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, discount_amount,
                                   table_name, order_no, invoice_no, invoice_fy, closed_at, closed_by)
      VALUES (v_c, 'billed', 'paid', 'Cash',   2260, 0, 'S809 2e probe', 990501, 990501, v_fy, now(), v_sup) RETURNING id INTO v_b_cash;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, discount_amount,
                                   table_name, order_no, invoice_no, invoice_fy, closed_at, closed_by)
      VALUES (v_c, 'billed', 'paid', 'Split',  2260, 0, 'S809 2e probe', 990502, 990502, v_fy, now(), v_sup) RETURNING id INTO v_b_split;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, discount_amount,
                                   table_name, order_no, invoice_no, invoice_fy, closed_at, closed_by)
      VALUES (v_c, 'billed', 'paid', 'Card',    500, 0, 'S809 2e probe', 990503, 990503, v_fy, now(), v_sup) RETURNING id INTO v_b_card;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, discount_amount,
                                   table_name, order_no, invoice_no, invoice_fy, closed_at, closed_by)
      VALUES (v_c, 'billed', 'paid', 'Credit',  500, 0, 'S809 2e probe', 990504, 990504, v_fy, now(), v_sup) RETURNING id INTO v_b_credit;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, discount_amount,
                                   table_name, order_no, invoice_no, invoice_fy, closed_at, closed_by)
      VALUES (v_c, 'billed', 'paid', 'Cash',    300, 0, 'S809 2e probe', 990505, 990505, v_fy, now(), v_sup) RETURNING id INTO v_b_noshift;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, discount_amount,
                                   table_name, order_no, invoice_no, invoice_fy, closed_at, closed_by,
                                   credit_settled_at, credit_settled_by, credit_settled_method, commission_amount)
      VALUES (v_c, 'billed', 'paid', 'Credit',  500, 0, 'S809 2e probe', 990506, 990506, v_fy, now(), v_sup,
              now(), v_sup, 'Cash', 50) RETURNING id INTO v_b_settled;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, discount_amount,
                                   table_name, order_no, invoice_no, invoice_fy, closed_at, closed_by)
      VALUES (v_c, 'billed', 'paid', 'Cash',    100, 0, 'S809 2e restored', 990507, 990507, 'S809-2e', v_past, v_sup) RETURNING id INTO v_b_rest;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      VALUES (v_b_cash,    v_c, v_dish, 'S809 2e probe momo', 2, 1000, 0.13),
             (v_b_split,   v_c, v_dish, 'S809 2e probe momo', 1, 2000, 0.13),
             (v_b_card,    v_c, v_dish, 'S809 2e probe momo', 1,  500, 0),
             (v_b_credit,  v_c, v_dish, 'S809 2e probe momo', 1,  500, 0),
             (v_b_noshift, v_c, v_dish, 'S809 2e probe momo', 1,  300, 0),
             (v_b_settled, v_c, v_dish, 'S809 2e probe momo', 1,  500, 0),
             (v_b_rest,    v_c, v_dish, 'S809 2e probe momo', 1,  100, 0);
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_b_split, v_c, 'Cash', 1000), (v_b_split, v_c, 'Card', 1000), (v_b_split, v_c, 'Loyalty', 260);
    -- Points: 22 earned on the Cash bill, 26 spent on the Split bill, 1 earned on the restored bill.
    INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, note)
      VALUES (v_c, v_cust, v_b_cash,  'earn',    22, 'S809 2e probe'),
             (v_c, v_cust, v_b_split, 'redeem', -26, 'S809 2e probe'),
             (v_c, v_cust, v_b_rest,  'earn',     1, 'S809 2e probe');
    -- The Split bill reached Inventory at its close: its revenue row and its depletion, as
    -- writeSalesEntries writes them (0.4 kg chicken and 0.25 kg flour for the plate).
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_p, v_dish, v_day, 1, 'pos', 2000, 0.13, v_b_split);
    INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
      VALUES (v_c, v_item,  v_p, v_day, -0.4,  'pos_sale', v_b_split),
             (v_c, v_item2, v_p, v_day, -0.25, 'pos_sale', v_b_split);

    -- ── (a) The cash each bill took (SHIFTS-3), read as the POS manager ──────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 2e probe: the stand-in % is not a plain POS manager', v_mgr;
    END IF;
    IF public.pos_bill_cash_taken(v_b_cash) IS DISTINCT FROM 2260.00
       OR public.pos_bill_cash_taken(v_b_split) IS DISTINCT FROM 1000.00      -- the Card and Loyalty legs are not cash
       OR public.pos_bill_cash_taken(v_b_card) IS DISTINCT FROM 0.00
       OR public.pos_bill_cash_taken(v_b_credit) IS DISTINCT FROM 0.00        -- nothing collected yet
       OR public.pos_bill_cash_taken(v_b_settled) IS DISTINCT FROM 450.00     -- settled in cash, less the commission
       OR public.pos_bill_cash_taken(gen_random_uuid()) IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2e probe: pos_bill_cash_taken gave % / % / % / % / %',
        public.pos_bill_cash_taken(v_b_cash), public.pos_bill_cash_taken(v_b_split), public.pos_bill_cash_taken(v_b_card),
        public.pos_bill_cash_taken(v_b_credit), public.pos_bill_cash_taken(v_b_settled);
    END IF;

    -- ── (b) A cash refund with no shift open refuses the whole note, and nothing is numbered ────
    BEGIN
      INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                           original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                           taxable_amount, non_taxable_amount, vat_amount, net_amount)
        VALUES (v_c, v_b_noshift, v_fy, 990505, 'S809 2e probe', '23 Ashwin 2083', 'S809 2e probe', 'cash', 300, 0, 0, 300, 0, 300);
      RAISE EXCEPTION 'S809 2e probe: a cash refund with no shift open was issued';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'credit_note_refund_no_shift' THEN
        RAISE EXCEPTION 'S809 2e probe: a cash refund with no shift — expected credit_note_refund_no_shift, got: %', v_msg;
      END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.pos_credit_notes WHERE order_id = v_b_noshift)
       OR (SELECT credit_note_id FROM public.pos_orders WHERE id = v_b_noshift) IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2e probe: the refused note left a note or a link behind';
    END IF;

    -- ── (c) The supervisor opens the shift, and cannot issue a note ─────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    IF NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 2e probe: the stand-in % is not a plain POS supervisor', v_sup;
    END IF;
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S809 2e probe', 1500, c_open) RETURNING id INTO v_s;
    BEGIN
      INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                           original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                           taxable_amount, non_taxable_amount, vat_amount, net_amount)
        VALUES (v_c, v_b_noshift, v_fy, 990505, 'S809 2e probe', '23 Ashwin 2083', 'S809 2e probe', 'none', 300, 0, 0, 300, 0, 300);
      RAISE EXCEPTION 'S809 2e probe: a POS supervisor issued a Credit Note';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 2e probe: a supervisor''s note — expected rank_required, got: %', v_msg;
      END IF;
    END;

    -- ── (d) The manager credits the Cash bill: served, cash back, a 2020 date sent ──────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, restock, created_at,
                                         gross_amount, discount_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount)
      VALUES (v_c, v_b_cash, v_fy, 990501, 'S809 2e probe', '23 Ashwin 2083', 'Wrong customer', 'cash', false, '2020-01-01 00:00:00+00',
              2000, 0, 2000, 0, 260, 2260)
      RETURNING id, created_at INTO v_n1, v_ts;
    -- S809.4: the date is the server's.
    IF v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 2e probe: the note kept the date it was sent (%)', v_ts;
    END IF;
    -- CREDIT-NOTES-2: the bill is marked credited in the same transaction.
    IF (SELECT credit_note_id FROM public.pos_orders WHERE id = v_b_cash) IS DISTINCT FROM v_n1 THEN
      RAISE EXCEPTION 'S809 2e probe: the Cash bill is not linked to its note';
    END IF;
    -- SHIFTS-3: the whole bill was cash, so the whole bill comes out, on the open shift, by the manager.
    SELECT count(*), max(amount) INTO v_n, v_amt FROM public.pos_cash_movements
     WHERE pos_credit_note_id = v_n1 AND kind = 'refund' AND direction = 'out' AND shift_id = v_s
       AND order_id = v_b_cash AND created_by = v_mgr AND reason LIKE 'Credit Note % refund — Wrong customer';
    IF v_n <> 1 OR v_amt IS DISTINCT FROM 2260.00 THEN
      RAISE EXCEPTION 'S809 2e probe: the Cash bill''s refund — % row(s), NPR %', v_n, v_amt;
    END IF;
    -- The bill's 22 earned points are taken back, in the same transaction.
    IF NOT EXISTS (SELECT 1 FROM public.pos_loyalty_ledger
                    WHERE credit_note_id = v_n1 AND customer_id = v_cust AND kind = 'adjust' AND points = -22) THEN
      RAISE EXCEPTION 'S809 2e probe: the Cash bill''s earned points were not taken back';
    END IF;
    -- A till on the current build still sends its own refund afterwards: refused (one per note), so
    -- the drawer is not charged twice.
    BEGIN
      INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, pos_credit_note_id, order_id, reason)
        VALUES (v_c, v_s, 'out', 'refund', 2260, v_n1, v_b_cash, 'S809 2e probe stale till');
      RAISE EXCEPTION 'S809 2e probe: a second refund for one note was recorded';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- … and its own link PATCH is a no-op, not a refusal.
    UPDATE public.pos_orders SET credit_note_id = v_n1 WHERE id = v_b_cash;

    -- ── (e) The Split bill, credited as a duplicate: only its Cash leg comes out ────────────────
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, restock,
                                         gross_amount, discount_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount)
      VALUES (v_c, v_b_split, v_fy, 990502, 'S809 2e probe', '23 Ashwin 2083', 'Duplicate bill', 'cash', true,
              2000, 0, 2000, 0, 260, 2260)
      RETURNING id INTO v_n2;
    IF (SELECT credit_note_id FROM public.pos_orders WHERE id = v_b_split) IS DISTINCT FROM v_n2
       OR NOT (SELECT restock FROM public.pos_credit_notes WHERE id = v_n2) THEN
      RAISE EXCEPTION 'S809 2e probe: the Split bill is not linked, or its note lost the "not served" answer';
    END IF;
    SELECT count(*), max(amount) INTO v_n, v_amt FROM public.pos_cash_movements
     WHERE pos_credit_note_id = v_n2 AND kind = 'refund' AND shift_id = v_s;
    IF v_n <> 1 OR v_amt IS DISTINCT FROM 1000.00 THEN
      RAISE EXCEPTION 'S809 2e probe: the Split bill''s refund — % row(s), NPR % (want the NPR 1,000 Cash leg)', v_n, v_amt;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_loyalty_ledger
                    WHERE credit_note_id = v_n2 AND customer_id = v_cust AND kind = 'adjust' AND points = 26) THEN
      RAISE EXCEPTION 'S809 2e probe: the 26 points spent on the Split bill were not returned';
    END IF;
    -- The answer is locked once issued, like everything on the note but its print count and mark.
    BEGIN
      UPDATE public.pos_credit_notes SET restock = false WHERE id = v_n2;
      RAISE EXCEPTION 'S809 2e probe: a note''s "not served" answer was changed';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'bill_locked' THEN
        RAISE EXCEPTION 'S809 2e probe: changing restock — expected bill_locked, got: %', v_msg;
      END IF;
    END;

    -- ── (f) A Card bill with Cash picked: no cash came in, so none goes out; an unpaid Credit bill ─
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method,
                                         gross_amount, discount_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount)
      VALUES (v_c, v_b_card, v_fy, 990503, 'S809 2e probe', '23 Ashwin 2083', 'Wrong customer', 'cash', 500, 0, 0, 500, 0, 500)
      RETURNING id INTO v_n3;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method,
                                         gross_amount, discount_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount)
      VALUES (v_c, v_b_credit, v_fy, 990504, 'S809 2e probe', '23 Ashwin 2083', 'Wrong customer', 'none', 500, 0, 0, 500, 0, 500)
      RETURNING id INTO v_n4;
    IF EXISTS (SELECT 1 FROM public.pos_cash_movements WHERE pos_credit_note_id IN (v_n3, v_n4))
       OR (SELECT credit_note_id FROM public.pos_orders WHERE id = v_b_card) IS DISTINCT FROM v_n3
       OR (SELECT credit_note_id FROM public.pos_orders WHERE id = v_b_credit) IS DISTINCT FROM v_n4
       OR (SELECT restock FROM public.pos_credit_notes WHERE id = v_n3) THEN   -- not sent: false
      RAISE EXCEPTION 'S809 2e probe: the Card or unpaid Credit bill took cash out, or was not linked, or defaulted to restock';
    END IF;

    -- ── (g) Inventory (CREDIT-NOTES-1), posted as the POS manager, as the Issue screen does ──────
    -- The served note's reversal is a plain pos_credit row; it cannot be a restock.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
      VALUES (v_p, v_dish, v_day, -2, 'pos_credit', 1000, 0.13, v_n1);
    FOR v_txt IN SELECT unnest(ARRAY['restock row for a served note', 'pos_credit row for a not-served note', 'restock row adding sales']) LOOP
      BEGIN
        IF v_txt = 'restock row for a served note' THEN
          INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
            VALUES (v_p, v_dish, v_day, -2, 'pos_credit_restock', 1000, 0.13, v_n1);
        ELSIF v_txt = 'pos_credit row for a not-served note' THEN
          INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
            VALUES (v_p, v_dish, v_day, -1, 'pos_credit', 2000, 0.13, v_n2);
        ELSE
          INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
            VALUES (v_p, v_dish, v_day, 1, 'pos_credit_restock', 2000, 0.13, v_n2);
        END IF;
        RAISE EXCEPTION 'S809 2e probe: a % was accepted', v_txt;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM (CASE WHEN v_txt = 'pos_credit row for a not-served note'
                                         THEN 'credit_note_restock_mismatch' ELSE 'pos_credit_restock_invalid' END) THEN
          RAISE EXCEPTION 'S809 2e probe: a % — got: %', v_txt, v_msg;
        END IF;
      END;
    END LOOP;
    -- The not-served note's reversal: the sale taken back under the new source (the CHECK admits it).
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
      VALUES (v_p, v_dish, v_day, -1, 'pos_credit_restock', 2000, 0.13, v_n2);
    -- The stock it puts back: the Split bill's own POS Sale depletion, negated.
    INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
      SELECT v_c, m.item_id, v_p, v_day, -sum(m.qty), 'pos_credit_restock', v_b_split
        FROM public.stock_movements m
       WHERE m.ref_id = v_b_split AND m.source = 'pos_sale'
       GROUP BY m.item_id;
    -- The bill's ledger now nets to nothing, item by item: the food is back.
    IF EXISTS (SELECT 1 FROM public.stock_movements WHERE ref_id = v_b_split GROUP BY item_id HAVING abs(sum(qty)) > 1e-9)
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b_split AND source = 'pos_credit_restock') <> 2 THEN
      RAISE EXCEPTION 'S809 2e probe: the restock did not cancel the Split bill''s depletion';
    END IF;
    -- Posted twice (the screen, then Periods): refused, so the food comes back once.
    BEGIN
      INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
        VALUES (v_c, v_item, v_p, v_day, 0.4, 'pos_credit_restock', v_b_split);
      RAISE EXCEPTION 'S809 2e probe: the same bill''s chicken was put back twice';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    -- Stock goes back only for a not-served note's bill, and only as stock added.
    FOR v_txt IN SELECT unnest(ARRAY['served', 'negative', 'another bill']) LOOP
      BEGIN
        INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
          VALUES (v_c, v_item2, v_p, v_day,
                  CASE WHEN v_txt = 'negative' THEN -0.25 ELSE 0.25 END, 'pos_credit_restock',
                  CASE WHEN v_txt = 'served' THEN v_b_cash WHEN v_txt = 'another bill' THEN v_b_noshift ELSE v_b_split END);
        RAISE EXCEPTION 'S809 2e probe: a restock movement (%) was accepted', v_txt;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'pos_credit_restock_invalid' THEN
          RAISE EXCEPTION 'S809 2e probe: a restock movement (%) — expected pos_credit_restock_invalid, got: %', v_txt, v_msg;
        END IF;
      END;
    END LOOP;

    -- ── (h) The supervisor cannot post a note's reversal or put stock back (rank, as before) ────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    FOR v_txt IN SELECT unnest(ARRAY['sales_entries', 'stock_movements']) LOOP
      BEGIN
        IF v_txt = 'sales_entries' THEN
          INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
            VALUES (v_p, v_dish, v_day, -1, 'pos_credit_restock', 2000, 0.13, v_n2);
        ELSE
          INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
            VALUES (v_c, v_item2, v_p, v_day, 0.1, 'pos_credit_restock', v_b_split);
        END IF;
        RAISE EXCEPTION 'S809 2e probe: a POS supervisor wrote a restock row to %', v_txt;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'ims_rank' THEN
          RAISE EXCEPTION 'S809 2e probe: a supervisor''s restock row to % — expected ims_rank, got: %', v_txt, v_msg;
        END IF;
      END;
    END LOOP;

    -- ── (i) The Owner, on a page older than this release, posts the not-served note as a plain
    --        reversal: refused, so the note stays waiting for a page that puts the food back ──────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 2e probe: % is not an Owner login', v_owner;
    END IF;
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
        VALUES (v_p, v_dish, v_day, -1, 'pos_credit', 2000, 0.13, v_n2);
      RAISE EXCEPTION 'S809 2e probe: the Owner posted a not-served note as a plain reversal';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'credit_note_restock_mismatch' THEN
        RAISE EXCEPTION 'S809 2e probe: the Owner''s plain reversal — expected credit_note_restock_mismatch, got: %', v_msg;
      END IF;
    END;
    -- The Owner's manual Sales Entry is untouched by any of this.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source)
      VALUES (v_p, v_dish, v_day, 1, 'manual');

    -- ── (j) The operator's restore: the note as it was, its bill linked, nothing paid or reversed ─
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 2e probe: % is not the operator', v_admin;
    END IF;
    INSERT INTO public.pos_credit_notes (client_id, order_id, credit_note_no, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, restock, created_at,
                                         gross_amount, discount_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount)
      VALUES (v_c, v_b_rest, 4244, 'S809-2e', 990507, 'S809 2e restored', '23 Bhadra 2083', 'S809 2e restored', 'cash', true, v_past,
              100, 0, 0, 100, 0, 100)
      RETURNING id, created_at INTO v_n6, v_ts;
    IF v_ts IS DISTINCT FROM v_past
       OR (SELECT credit_note_id FROM public.pos_orders WHERE id = v_b_rest) IS DISTINCT FROM v_n6
       OR EXISTS (SELECT 1 FROM public.pos_cash_movements WHERE pos_credit_note_id = v_n6)
       OR EXISTS (SELECT 1 FROM public.pos_loyalty_ledger WHERE credit_note_id = v_n6) THEN
      RAISE EXCEPTION 'S809 2e probe: the restored note was re-dated, not linked, or paid out / reversed again';
    END IF;

    -- ── (k) Every note in the probe has its bill, and only its bill, marked credited ───────────
    SELECT count(*) INTO v_n FROM public.pos_credit_notes n
      JOIN public.pos_orders o ON o.id = n.order_id
     WHERE n.client_id = v_c AND o.credit_note_id IS DISTINCT FROM n.id;
    IF v_n <> 0 OR (SELECT count(*) FROM public.pos_credit_notes WHERE id IN (v_n1, v_n2, v_n3, v_n4, v_n6)) <> 5 THEN
      RAISE EXCEPTION 'S809 2e probe: % note(s) of BLOOM CAFE are not linked to their bill', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2e_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_2e_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, provolatile, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('guard_pos_credit_note', 'pos_credit_note_settle', 'pos_bill_cash_taken',
--                      'ims_sales_entries_guard', 'ims_stock_movements_guard');
--     expect guard_pos_credit_note 5d47faa30c2b2ebccca7d1abab6d335a, pos_credit_note_settle 1bb4fdd35e86f0977bd1d41a84b845f0,
--     pos_bill_cash_taken d5860a4ca0a41759e186e495828db44f, ims_sales_entries_guard 492abc0353f288a2bcb9daba12f60434,
--     ims_stock_movements_guard 0243bef6e3ee9694384e63166fbe9474;
--     prosecdef false on all five; pos_bill_cash_taken 's' and {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres};
--     the four trigger functions {postgres=X/postgres}.
--   SELECT tgname, tgtype, tgenabled FROM pg_trigger WHERE tgrelid = 'public.pos_credit_notes'::regclass AND NOT tgisinternal ORDER BY tgname;
--     audit_pos_credit_notes, guard_pos_credit_note (31), pos_credit_note_settle (5), trg_assign_pos_credit_note_no (7), all 'O'.
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'sales_entries_source_check';      -- lists pos_credit_restock
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'stock_movements_one_restock_per_bill_item';
--   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'pos_credit_notes' AND column_name = 'restock';      -- boolean, NO, false
--   SELECT has_function_privilege('anon', 'public.pos_bill_cash_taken(uuid)', 'EXECUTE');                -- false
--   SELECT count(*) FROM public.pos_credit_notes n JOIN public.pos_orders o ON o.id = n.order_id
--    WHERE o.credit_note_id IS DISTINCT FROM n.id;                                                      -- 0
--   SELECT count(*) FROM public.sales_entries WHERE source = 'pos_credit_restock';                      -- 0
--   SELECT count(*) FROM public.stock_movements WHERE source = 'pos_credit_restock';                    -- 0
--   SELECT count(*) FROM public.pos_credit_notes;   -- unchanged (0 on 2026-10-09)
