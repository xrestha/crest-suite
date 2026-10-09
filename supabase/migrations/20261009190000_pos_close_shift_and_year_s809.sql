-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 2, slice 2b: the database decides each close — what is on the bill, which shift it
-- lands on, and which year's numbered series it joins.
--
--   CHECKOUT-1, server half (P1; owner decision Q8 a, 2026-10-09). A Charge or a Complimentary close
--   had no line check, so an order with nothing on it could be "paid" for NPR 0 and printed as a
--   numbered, empty Tax Invoice. guard_pos_order_close now refuses a close to paid with no line that
--   is not comped, and a close to writeoff with no line at all (HINT pos_bill_empty). A void is not
--   affected: its stored lines are the record of what was voided. The till's half (an emptied CART,
--   whose stored lines are still there) is slice 2a's closeBlocker: the database sees stored lines.
--
--   CHECKOUT-3 (P2) + SHIFTS-1, database half (P2). "Charge needs an open shift" lived in the browser,
--   and the bill carried whatever shift_id the request named: none, an old closed shift, another
--   outlet's. On a close to paid or writeoff the guard now reads the outlet's open shift FOR SHARE,
--   stamps NEW.shift_id from it and refuses when there is none (HINT no_open_shift).
--   pos_cash_movements_guard reads its shift FOR SHARE too. Since slice 1l, pos_shifts_guard adds the
--   shift's stored cash up as it closes and refuses a report that differs (pos_shift_figures_changed).
--   Together, under READ COMMITTED:
--     * A bill (or cash entry) that took its FOR SHARE first: the shift's Close is an UPDATE, which
--       locks the row (FOR NO KEY UPDATE, taken before its BEFORE trigger runs) and so waits until
--       that bill commits or rolls back. Only then does pos_shifts_guard run, and each of its reads
--       takes a fresh snapshot (a VOLATILE plpgsql body), so it counts the bill, and a report the
--       page read before the bill is refused; pressing Close Shift again re-reads it.
--     * A bill arriving after the Close has locked the row: its FOR SHARE waits for the Close to
--       commit, then the read follows the row to its new version and re-checks status = 'open'
--       (EvalPlanQual), finds it closed and returns nothing; the guard also tests the status it got
--       back. The bill is refused no_open_shift and lands on no closed shift. A cash entry is
--       refused pos_cash_movement_shift_closed the same way (it reads the status after its lock).
--     So no bill and no cash entry can commit onto a shift between the moment its figures are taken
--     and its close. The one write this does not cover is a Split bill's payment legs, inserted by
--     the till just after the close in a request of its own (see the slice report).
--
--   CHECKOUT-4 (P2) + CREDIT-NOTES-4 (P2). The year whose numbered series a Tax Invoice, an NC slip
--   or a Credit Note joins came from the tablet's clock and time zone, and a REST write could name
--   any year (or none, leaving a paid bill unnumbered). It is now Nepal's date at the server's
--   now(), through bs_months: the fiscal year runs Shrawan (month 4) to Ashadh (month 3) and is
--   written as the till always wrote it, "83/84" (getBsFiscalYear). One definition, the new
--   pos_invoice_fy(timestamptz), is called by guard_pos_order_close (NEW.invoice_fy on a close to
--   paid / writeoff), guard_pos_credit_note (NEW.invoice_fy on an INSERT that is not the operator's
--   restore) and apply_pos_item_comps (the NC year; p_fy is kept in the signature and ignored). The
--   numbering triggers fire after the guards (BEFORE row triggers fire by name: guard_ < trg_), so
--   the number follows the server's year.
--
--   CHECKOUT-10 (P2) and the S809.4 item. apply_pos_item_comps' whole-recipe UPDATE had no
--   comped = false filter, so it re-comped a comp left on the order by a failed, cancelled close
--   under a new NC number; it now has the filter, as the p_full_lines one already did. And a part
--   comp whose line was not found was skipped (CONTINUE) while the NC number was still returned, so
--   the till printed an empty comp slip under a number nothing on the bill carries. Now every entry
--   of the call must comp a line, or the call is refused and nothing is comped
--   (HINT pos_comp_line_missing). Refused rather than returning nothing: the till has already taken
--   that comp off the total on screen, so a quiet "nothing comped" would close the bill short.
--
--   SHIFTS-7 (P3, pulled forward). pos_shifts_guard kept a close time the request sent
--   (COALESCE(NEW.closed_at, now())). It is now now(), and the closing report's capturedAt is
--   stamped with the same moment.
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-09). Section 0 refuses to
-- run over any other body. Every change inside them is a block marked "S809 2b".
--   guard_pos_order_close()      eb62af47b2203fb2dde7556748b1453a  (slice 1c's)
--   guard_pos_credit_note()      905bed988d335a5251656179e3bfc0ca  (slice 1l's)
--   apply_pos_item_comps(...)    5238fec7038f0eb562a9bd496b525203  (slice 1j's)
--   pos_cash_movements_guard()   ed465552c326ed8657748b9feb3ec5c1  (slice 1l's)
--   pos_shifts_guard()           79b0b361c7a6466d5fc258ec3cd39d83  (slice 1l's)
-- New: pos_invoice_fy(timestamptz), a STABLE SQL function the three call.
--
-- Live before this migration (2026-10-09), all at BLOOM CAFE:
--   * 33 billed bills (32 paid, 1 Complimentary): 0 have no line and 0 have no uncomped line, so 0
--     would have failed the empty-bill refusal.
--   * 21 of them carry no shift (20 paid + the Complimentary, the last closed 2026-09-04, before the
--     S754 browser rule). Every bill since has one. Nothing is rewritten: the guard judges new
--     closes only.
--   * The new year rule gives every stored year back: 33 of 33 billed bills (by closed_at; 3 in
--     "82/83", 30 in "83/84") and 1 of 1 Credit Note (by created_at, "83/84"). The probe re-checks it.
--   * 1 comped line (NC-1, on a voided order, 2026-08-19) carries comp_fy "2083/84", not "83/84";
--     it is left as it is (it shares no series with anything the till numbers).
--   * 2 shifts: one closed 2026-07-29 (no report), one open since 2026-09-15 holding 16 bills.
--   * bs_months covers AD 1943-04-14 to 2031-04-13 (BS 2000 to 2087), as bsCalendar.js does. From
--     2031-04-14 every Charge, Complimentary, comp and Credit Note is refused
--     (pos_fiscal_year_unknown) until the table is extended.
-- No constraint is added and no row is written.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN supervisor, its Owner and the operator inside a
-- block that rolls itself back. If any check fails, the whole migration fails and nothing lands.
-- Drafted against a local Postgres 17 copy of these tables, policies, grants, triggers and live bodies
-- (BLOOM's rows): the file runs clean (and again over itself), under a UTC and a New York session
-- time zone; each of nine one-line reversals of a fix fails the probe; and two real sessions showed
-- both lock orders (a Close waiting about 4 s on an open bill or cash entry and then refusing the
-- stale report; a bill waiting on a Close and then refused no_open_shift).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
--
-- CREATE OR REPLACE would silently revert another change to any of them. The second hash of each
-- pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'eb62af47b2203fb2dde7556748b1453a' AND v_md5 IS DISTINCT FROM '5a50b8bc5ea06f2102e6440e16173e1d' THEN
    RAISE EXCEPTION 'S809 2b: guard_pos_order_close changed since this slice was drafted (live md5 %) — merge section 2 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '905bed988d335a5251656179e3bfc0ca' AND v_md5 IS DISTINCT FROM '698df246f07fb00a23a1dda876aff6f8' THEN
    RAISE EXCEPTION 'S809 2b: guard_pos_credit_note changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '5238fec7038f0eb562a9bd496b525203' AND v_md5 IS DISTINCT FROM '55553b4fe5365f40de48f9d6e7025d6d' THEN
    RAISE EXCEPTION 'S809 2b: apply_pos_item_comps changed since this slice was drafted (live md5 %) — merge section 4 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'ed465552c326ed8657748b9feb3ec5c1' AND v_md5 IS DISTINCT FROM '6cc608afe6808f86308b8ef2d32cf7cf' THEN
    RAISE EXCEPTION 'S809 2b: pos_cash_movements_guard changed since this slice was drafted (live md5 %) — merge section 5 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_shifts_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '79b0b361c7a6466d5fc258ec3cd39d83' AND v_md5 IS DISTINCT FROM '30c69620986bd28650a2ff34b70ab6a0' THEN
    RAISE EXCEPTION 'S809 2b: pos_shifts_guard changed since this slice was drafted (live md5 %) — merge section 6 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  -- No public function may have a second overload (the S630 rule); this file keeps every signature.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'apply_pos_item_comps') <> 1 THEN
    RAISE EXCEPTION 'S809 2b: apply_pos_item_comps has more than one signature';
  END IF;
END;
$$;


-- ── 1. The year a bill, an NC slip and a Credit Note are numbered in ──────────────────────────
--
-- Nepal's calendar date at p_at, through bs_months, as the fiscal-year label the till has always
-- written (bsCalendar.js getBsFiscalYear): the year starts on 1 Shrawan (month 4), and "83/84" is
-- the year starting in Shrawan 2083. Each part is the year mod 100 with no padding, as in JS. NULL
-- when p_at is NULL or past the end of bs_months (the callers refuse then: a bill must never close
-- unnumbered or numbered in a guessed year). Nepal has no daylight saving, so AT TIME ZONE
-- 'Asia/Kathmandu' is a fixed +05:45.
-- Plain SQL, not SECURITY DEFINER: bs_months is readable by authenticated (bs_months_select), and
-- the two guards call this as the signed-in login. anon has no use for it.
CREATE OR REPLACE FUNCTION public.pos_invoice_fy(p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $fn$
  SELECT (f.start_year % 100)::text || '/' || ((f.start_year + 1) % 100)::text
    FROM (SELECT CASE WHEN m.bs_month >= 4 THEN m.bs_year ELSE m.bs_year - 1 END AS start_year
            FROM bs_months m
           WHERE (p_at AT TIME ZONE 'Asia/Kathmandu')::date >= m.ad_start
             AND (p_at AT TIME ZONE 'Asia/Kathmandu')::date <  m.ad_start + m.days
         ) AS f
$fn$;
REVOKE ALL ON FUNCTION public.pos_invoice_fy(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_invoice_fy(timestamptz) TO authenticated, service_role;


-- ── 2. guard_pos_order_close ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_pos_order_close()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_allow_void    boolean;
  v_discount_cap  numeric;
  v_subtotal      numeric;
  v_max_discount  numeric;
  v_allowed CONSTANT text[] := ARRAY[
    'ims_posted_at', 'print_count', 'comp_print_count', 'credit_note_id',
    'credit_settled_at', 'credit_settled_by', 'credit_settled_method', 'commission_amount'];
  -- S809 2b
  v_shift_id      uuid;
  v_shift_status  text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- ── S809 1c (CHECKOUT-8): the print counters only go up ──────────────────────────────────
  -- A reprint's "COPY OF ORIGINAL" mark is read from these, so a lowered count makes the next
  -- reprint a second unmarked original. A lower value is ignored rather than refused: the till
  -- writes count + 1 from the row it last read and does not wait for the answer (S776), and a till
  -- a reprint behind another must not be told its print failed. GREATEST skips NULL, so a NULL sent
  -- keeps the stored count. On an open order as well as a closed bill: a count planted while the
  -- order is open is read by the first print after the close.
  NEW.print_count      := GREATEST(OLD.print_count, NEW.print_count);
  NEW.comp_print_count := GREATEST(OLD.comp_print_count, NEW.comp_print_count);
  -- ── end S809 1c ──────────────────────────────────────────────────────────────────────────

  -- ── (A) A billed or voided bill is locked ──────────────────────────────────────────────────
  IF OLD.status IS DISTINCT FROM 'open' THEN
    IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
      RAISE EXCEPTION
        'pos_orders: this bill is closed and printed, so it can no longer be changed — issue a Credit Note to correct it'
        USING ERRCODE = '42501', HINT = 'bill_locked';
    END IF;

    -- Credit-note link: the Issue Credit Note screen is POS-manager only. Linked once — the Credit
    -- Notes list offers only bills with no link, and a re-link would detach the first note — and
    -- only to a note that really was issued against this bill.
    IF NEW.credit_note_id IS DISTINCT FROM OLD.credit_note_id THEN
      IF NOT public.pos_caller_has_rank('manager') THEN
        RAISE EXCEPTION 'pos_orders: linking a credit note to a bill needs POS Manager access or above'
          USING ERRCODE = '42501', HINT = 'rank_required';
      END IF;
      IF OLD.credit_note_id IS NOT NULL OR NEW.credit_note_id IS NULL
         OR OLD.close_type IS DISTINCT FROM 'paid'
         OR NOT EXISTS (SELECT 1 FROM pos_credit_notes n WHERE n.id = NEW.credit_note_id AND n.order_id = NEW.id) THEN
        RAISE EXCEPTION 'pos_orders: this bill already has a credit note, or the note was not issued against it'
          USING ERRCODE = '42501', HINT = 'bill_locked';
      END IF;
    END IF;

    -- Credit settlement: Customers → Outstanding Credit is a Supervisor page. Settled once (the page
    -- already filters `.is('credit_settled_at', null)`), only on a Credit bill, and the settler is
    -- whoever is signed in — never a name the request supplies.
    IF NEW.credit_settled_at     IS DISTINCT FROM OLD.credit_settled_at
       OR NEW.credit_settled_by     IS DISTINCT FROM OLD.credit_settled_by
       OR NEW.credit_settled_method IS DISTINCT FROM OLD.credit_settled_method
       OR NEW.commission_amount     IS DISTINCT FROM OLD.commission_amount THEN
      IF NOT public.pos_caller_has_rank('supervisor') THEN
        RAISE EXCEPTION 'pos_orders: settling a credit bill needs POS Supervisor access or above'
          USING ERRCODE = '42501', HINT = 'rank_required';
      END IF;
      IF OLD.credit_settled_at IS NOT NULL OR NEW.credit_settled_at IS NULL
         OR OLD.payment_method IS DISTINCT FROM 'Credit' OR OLD.status IS DISTINCT FROM 'billed' THEN
        RAISE EXCEPTION 'pos_orders: this bill is not an unsettled Credit bill, so it cannot be settled'
          USING ERRCODE = '42501', HINT = 'bill_locked';
      END IF;
      NEW.credit_settled_by := (SELECT auth.uid());
    END IF;

    -- ── S809 1c (CHECKOUT-8): the Inventory posting mark ───────────────────────────────────
    -- ims_posted_at says this bill's revenue reached Inventory; the floor banner, the Home tile
    -- and Periods' backfill all look for bills without it. Set on a bill that never posted, it
    -- hides that revenue for good. So it is set by the people who post: whoever closes bills
    -- (Supervisor and above), just after the close, and the Owner or the operator from Periods.
    -- Once set it stands: a second write (a backfill racing the till, or a clear) keeps the first
    -- mark rather than failing a batch. Nothing posts twice either way, because the backfill asks
    -- sales_entries.pos_order_id, never the mark alone.
    IF NEW.ims_posted_at IS DISTINCT FROM OLD.ims_posted_at THEN
      IF OLD.ims_posted_at IS NOT NULL THEN
        NEW.ims_posted_at := OLD.ims_posted_at;
      ELSIF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
        RAISE EXCEPTION 'pos_orders: marking a bill as posted to Inventory needs POS Supervisor access or above'
          USING ERRCODE = '42501', HINT = 'rank_required';
      END IF;
    END IF;
    -- ── end S809 1c ────────────────────────────────────────────────────────────────────────

    RETURN NEW;
  END IF;

  -- ── (B) The order is open ──────────────────────────────────────────────────────────────────
  -- An open order never carries an invoice number; clearing it on every write means the one the
  -- request might supply is discarded and assign_pos_invoice_no (which fires after this trigger,
  -- trigger names sort guard_ < trg_) always numbers the bill itself.
  NEW.invoice_no := NULL;

  -- Credit-note and settlement columns mean nothing on an open order, and no screen writes them.
  IF NEW.credit_note_id        IS DISTINCT FROM OLD.credit_note_id
     OR NEW.credit_settled_at     IS DISTINCT FROM OLD.credit_settled_at
     OR NEW.credit_settled_by     IS DISTINCT FROM OLD.credit_settled_by
     OR NEW.credit_settled_method IS DISTINCT FROM OLD.credit_settled_method
     OR NEW.commission_amount     IS DISTINCT FROM OLD.commission_amount THEN
    RAISE EXCEPTION 'pos_orders: credit-note and settlement details can only be recorded on a closed bill'
      USING ERRCODE = '42501', HINT = 'order_not_closed';
  END IF;

  -- ── S809 1c (CHECKOUT-8): an open order has posted nothing to Inventory ────────────────────
  -- A mark set now would survive the close (the first mark stands, above) and hide the bill from
  -- the backfill. The till sets it only after the close, in a write of its own.
  IF NEW.ims_posted_at IS DISTINCT FROM OLD.ims_posted_at THEN
    RAISE EXCEPTION 'pos_orders: an open order cannot be marked as posted to Inventory — that is recorded once the bill closes'
      USING ERRCODE = '42501', HINT = 'order_not_closed';
  END IF;
  -- ── end S809 1c ──────────────────────────────────────────────────────────────────────────

  -- The close itself. Every Payment / Void / Complimentary control sits behind the Payment button,
  -- which PosOrders.jsx shows at hasPosAccess('supervisor') — so closing, a write-off and a Credit
  -- sale all need Supervisor. Attribution is stamped here: closed_by from the session, closed_at from
  -- the server clock (a tablet's clock could backdate a bill into a closed month, and the loyalty
  -- award and split-payment windows below are measured against this instant).
  IF NEW.status IS DISTINCT FROM 'open' THEN
    IF NEW.status NOT IN ('billed', 'voided') THEN
      RAISE EXCEPTION 'pos_orders: a bill closes as billed or voided, not %', NEW.status
        USING ERRCODE = '22023';
    END IF;
    -- ── S809 1c (CHECKOUT-2): a bill closes as one of three pairs ──────────────────────────
    -- Every money report classifies a closed bill by close_type, so a status with no close type,
    -- or one that disagrees with it, closed the bill out of all of them; and "voided" with no
    -- close type walked past the Allow Void test below. The CHECK pos_orders_status_close_type_check
    -- holds the same pairs for every writer; this names the refusal before it.
    IF NOT COALESCE((NEW.status = 'billed' AND NEW.close_type IN ('paid', 'writeoff'))
                 OR (NEW.status = 'voided' AND NEW.close_type = 'void'), false) THEN
      RAISE EXCEPTION 'pos_orders: a bill closes as paid or complimentary (billed) or as void (voided), and this close sent status % with close type %',
        NEW.status, COALESCE(NEW.close_type, 'none')
        USING ERRCODE = '22023', HINT = 'pos_close_mismatch';
    END IF;
    -- ── end S809 1c ────────────────────────────────────────────────────────────────────────
    IF NOT public.pos_caller_has_rank('supervisor') THEN
      RAISE EXCEPTION 'pos_orders: closing a bill needs POS Supervisor access or above'
        USING ERRCODE = '42501', HINT = 'rank_required';
    END IF;

    -- ── S809 2b: what a Charge or a Complimentary close stands on is the database's ────────────
    -- billed means paid or writeoff here (the pair check above). Every rule below applies to the
    -- Owner and, outside a restore, to the operator (Q26 a); the operator's restore INSERTs closed
    -- bills and never reaches this UPDATE branch. A void is not affected by any of them.
    IF NEW.status = 'billed' THEN
      -- CHECKOUT-1 (Q8 a): a bill with nothing on it is refused. A Charge needs a line that is not
      -- comped (an all-comped bill is the Complimentary tab's), a Complimentary close needs a line.
      -- Read from the STORED lines, the only ones the database can see: the till saves its cart
      -- before every close and refuses an emptied cart itself (closeBlocker). Read as the caller,
      -- and pos_order_items carries the same policies as pos_orders, so a line this caller cannot
      -- see does not exist for it either; an unseen line can only refuse a close, never pass one.
      IF NOT EXISTS (SELECT 1 FROM pos_order_items i
                      WHERE i.order_id = NEW.id
                        AND (NEW.close_type = 'writeoff' OR NOT COALESCE(i.comped, false))) THEN
        RAISE EXCEPTION 'pos_orders: there is nothing on this bill, so it was not closed — add the items back, or ask someone with Void to void it'
          USING ERRCODE = '23514', HINT = 'pos_bill_empty';
      END IF;

      -- CHECKOUT-3 + SHIFTS-1: the bill goes on the outlet's shift that is open NOW, whatever the
      -- request named (none, an old closed shift, another outlet's). FOR SHARE holds that shift
      -- open until this bill commits: a Close Shift arriving meanwhile waits for it and then counts
      -- it (pos_shifts_guard refuses a report that left it out). A bill arriving after the Close has
      -- locked the row waits, and its read then follows the row to its new version, re-checks
      -- status = 'open' and returns nothing. The status is also tested here, on the row the lock
      -- returned, so this holds whatever plan the read uses. One open shift per outlet is the
      -- unique index pos_shifts_one_open_per_client. FOR SHARE needs UPDATE on pos_shifts and its
      -- UPDATE policy: authenticated holds both, and pos_shifts carries the same policies as
      -- pos_orders, so anyone who can close this bill can lock its shift.
      SELECT s.id, s.status INTO v_shift_id, v_shift_status
        FROM pos_shifts s
       WHERE s.client_id = NEW.client_id AND s.status = 'open'
         FOR SHARE;
      IF v_shift_id IS NULL OR v_shift_status IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'pos_orders: no shift is open at this outlet, so this bill was not closed — open a shift in POS → Shifts, then close the bill again'
          USING ERRCODE = '55000', HINT = 'no_open_shift';
      END IF;
      NEW.shift_id := v_shift_id;

      -- CHECKOUT-4: the year whose numbered series the bill joins (TI / PB for a Charge, NC for a
      -- Complimentary) is Nepal's date at this instant, the same now() closed_at is stamped with
      -- below, never the request's or the tablet's. assign_pos_invoice_no fires after this trigger
      -- and numbers the bill in that series.
      NEW.invoice_fy := public.pos_invoice_fy(now());
      IF NEW.invoice_fy IS NULL THEN
        RAISE EXCEPTION 'pos_orders: today''s date is past the end of Crest''s Nepali calendar, so no invoice number can be given and the bill was not closed — contact Crest support'
          USING ERRCODE = 'P0001', HINT = 'pos_fiscal_year_unknown';
      END IF;
    END IF;
    -- ── end S809 2b ────────────────────────────────────────────────────────────────────────

    NEW.closed_by := (SELECT auth.uid());
    NEW.closed_at := now();
  ELSIF NEW.close_type IS DISTINCT FROM OLD.close_type THEN
    -- A close type is decided by the close. Set on an order that stays open it would make an open
    -- order read as a void / comp in every report that filters on close_type.
    RAISE EXCEPTION 'pos_orders: a close type can only be set by closing the bill'
      USING ERRCODE = '42501', HINT = 'order_not_closed';
  END IF;

  -- ── Unchanged from 20260819120000 below this line, but for the S809 1c void test ───────────
  IF NEW.close_type      IS NOT DISTINCT FROM OLD.close_type
     AND NEW.status      IS NOT DISTINCT FROM OLD.status
     AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount THEN
    RETURN NEW;
  END IF;

  IF public.is_admin() THEN
    RETURN NEW;
  END IF;

  IF public.is_client_owner() THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(pos_allow_void, false), pos_discount_limit
    INTO v_allow_void, v_discount_cap
    FROM profiles
   WHERE id = (SELECT auth.uid());

  -- S809 1c (CHECKOUT-2): keyed on the status as well as the close type. It tested
  -- close_type = 'void' alone, so {"status":"voided"} with no close type walked past it.
  IF COALESCE(NEW.status = 'voided' OR NEW.close_type = 'void', false)
     AND NOT COALESCE(v_allow_void, false) THEN
    RAISE EXCEPTION
      'pos_orders: this account is not permitted to void a bill — ask a manager to enable Allow Void for it on POS Staff'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.discount_amount IS NOT NULL AND NEW.discount_amount > 0 AND v_discount_cap IS NOT NULL THEN
    SELECT COALESCE(SUM(qty * unit_price), 0)
      INTO v_subtotal
      FROM pos_order_items
     WHERE order_id = NEW.id
       AND COALESCE(comped, false) = false;

    IF v_subtotal > 0 THEN
      v_max_discount := v_subtotal * (v_discount_cap / 100.0) + 0.01;
      IF NEW.discount_amount > v_max_discount THEN
        RAISE EXCEPTION
          'pos_orders: a discount of % exceeds this account''s cap (% percent of the % subtotal, i.e. at most %)',
          ROUND(NEW.discount_amount, 2), v_discount_cap,
          ROUND(v_subtotal, 2), ROUND(v_max_discount, 2)
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
-- A trigger function: no EXECUTE for anyone (live ACL is the owner's only). CREATE OR REPLACE keeps
-- it; this only restates it.
REVOKE ALL ON FUNCTION public.guard_pos_order_close() FROM PUBLIC;


-- ── 3. guard_pos_credit_note (the INSERT branch: the note's year) ───────────────────────────
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
  NEW.credit_note_no := NULL;   -- numbered by trg_assign_pos_credit_note_no, never by the request
  NEW.ims_posted_at := NULL;
  NEW.print_count := 0;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_pos_credit_note() FROM PUBLIC;


-- ── 4. apply_pos_item_comps (signature, SECURITY DEFINER and grants unchanged) ───────────────
CREATE OR REPLACE FUNCTION public.apply_pos_item_comps(p_order_id uuid, p_client_id uuid, p_fy text, p_comp_reason text, p_comped_by uuid, p_full_recipe_ids uuid[], p_partial jsonb, p_full_lines jsonb DEFAULT NULL::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_comp_no integer;
  v_now timestamptz := now();
  v_item jsonb;
  v_order_client uuid;
  v_order_status text;
  v_caller uuid := (SELECT auth.uid());
  v_comped_by uuid;
  v_src record;
  v_new_id uuid;
  v_sel text;
  v_qty integer;
  v_sent integer;
  -- S809 2b
  v_fy text;
  v_missing uuid;
BEGIN
  SELECT client_id, status INTO v_order_client, v_order_status FROM pos_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order_client IS NULL OR v_order_client <> p_client_id THEN
    RAISE EXCEPTION 'order does not belong to this client';
  END IF;
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR p_client_id = public.my_client_id()
  , false) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  -- S809 1j (ACCESS-9): the one POS rank test (admin, the Owner, or a POS supervisor or manager),
  -- which also refuses a login a Final Settlement has blocked, for the hour its last access token
  -- still lives. This was a copy of it without that test.
  IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION
      'complimentary items require Supervisor access or above'
      USING ERRCODE = '42501';
  END IF;

  -- S754: a closed bill's lines are locked for everyone, and this function is the one line writer
  -- the row guards cannot see.
  IF v_order_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'this bill is already closed, so items on it can no longer be made complimentary'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;

  v_comped_by := CASE
    WHEN COALESCE((SELECT role FROM profiles WHERE id = v_caller) = 'admin', false)
      THEN COALESCE(p_comped_by, v_caller)
    ELSE v_caller
  END;

  -- ── S809 2b (CHECKOUT-4): the NC number's year is Nepal's date, from the server ─────────────
  -- As on the bill itself (guard_pos_order_close), so the item comps and a Complimentary bill share
  -- one series per year whatever the tablet's clock says. p_fy is ignored: it stays in the
  -- signature so a till on an older build still binds to this function.
  v_fy := public.pos_invoice_fy(v_now);
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'pos_fiscal_year_unknown: today''s date is past the end of Crest''s Nepali calendar, so no NC number can be given and nothing was made complimentary — contact Crest support'
      USING ERRCODE = 'P0001', HINT = 'pos_fiscal_year_unknown';
  END IF;
  -- ── end S809 2b ──────────────────────────────────────────────────────────────────────────

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || v_fy));

  SELECT COALESCE(MAX(n), 0) + 1 INTO v_comp_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = v_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = v_fy
  ) combined;

  -- The pre-S758 argument: whole recipes, which on a till that knows no options means its plain
  -- lines. It no longer reaches a customized line — that is comped by line through p_full_lines.
  IF p_full_recipe_ids IS NOT NULL AND array_length(p_full_recipe_ids, 1) > 0 THEN
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = v_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id AND recipe_id = ANY(p_full_recipe_ids) AND selection_key = ''
      -- S809 2b (CHECKOUT-10): a line already comped keeps its comp, as on p_full_lines below. It
      -- was re-comped here under the new NC number, so a comp left by a failed close moved slips.
      AND COALESCE(comped, false) = false;
    -- S809 2b (S809.4): each recipe asked for was comped by this call, or nothing is: the till has
    -- already taken it off the total on screen, so a recipe with nothing left to comp must stop the
    -- close rather than let it charge short under an NC number for a comp that did not happen. The
    -- NC number is this call's own (MAX + 1 under the lock above), so it marks exactly its rows.
    SELECT r.id INTO v_missing
      FROM unnest(p_full_recipe_ids) AS r(id)
     WHERE NOT EXISTS (SELECT 1 FROM pos_order_items i
                        WHERE i.order_id = p_order_id AND i.recipe_id = r.id AND i.selection_key = ''
                          AND i.comp_no = v_comp_no AND i.comp_fy = v_fy)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'pos_comp_line_missing: a dish to be made complimentary is not on this bill (or is already complimentary), so nothing was made complimentary — the bill may have changed on another device'
        USING ERRCODE = 'P0001', HINT = 'pos_comp_line_missing',
              DETAIL = format('recipe %s', COALESCE(v_missing::text, 'none'));
    END IF;
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_full_lines, '[]'::jsonb))
  LOOP
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = v_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id
      AND recipe_id = (v_item->>'recipe_id')::uuid
      AND selection_key = COALESCE(v_item->>'selection_key', '')
      AND COALESCE(comped, false) = false;
    -- S809 2b (S809.4): as above, a line asked for that comps nothing stops the whole call.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos_comp_line_missing: a dish to be made complimentary is not on this bill (or is already complimentary), so nothing was made complimentary — the bill may have changed on another device'
        USING ERRCODE = 'P0001', HINT = 'pos_comp_line_missing',
              DETAIL = format('recipe %s, choices %s', COALESCE(v_item->>'recipe_id', 'none'), COALESCE(NULLIF(v_item->>'selection_key', ''), 'none'));
    END IF;
  END LOOP;

  -- The comped split takes its price from the stored line it is split off, never from the
  -- payload (S754: a line's price is the menu's). vat_rate likewise, and since S758 its options.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_partial, '[]'::jsonb))
  LOOP
    v_sel := COALESCE(v_item->>'selection_key', '');

    -- S809 1j (CHECKOUT-16): a whole number, as text or a JSON number. Checked before the cast, so
    -- "1.5", "-3" or a missing quantity is a worded refusal rather than a cast error.
    IF COALESCE(v_item->>'comp_qty', '') !~ '^[0-9]{1,9}$' THEN
      RAISE EXCEPTION 'pos_comp_qty_invalid: a complimentary quantity must be a whole number of 1 or more, not %',
        COALESCE(v_item->>'comp_qty', 'none')
        USING ERRCODE = '22023', HINT = 'pos_comp_qty_invalid';
    END IF;
    v_qty := (v_item->>'comp_qty')::integer;

    SELECT id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty,
           selection_key, base_unit_price, options_delta, option_summary
      INTO v_src
      FROM pos_order_items
     WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid
       AND selection_key = v_sel
       AND COALESCE(comped, false) = false
     ORDER BY created_at
     LIMIT 1;
    -- S809 2b (S809.4): this was CONTINUE, so a part comp whose line was gone was skipped while the
    -- NC number was still returned, and the till printed an empty Complimentary Slip under it and
    -- charged the bill short by the comp it had shown. Now nothing in the call is comped.
    IF v_src.id IS NULL THEN
      RAISE EXCEPTION 'pos_comp_line_missing: % is not on this bill to be made complimentary, so nothing was made complimentary — the bill may have changed on another device',
        COALESCE(NULLIF(v_item->>'name', ''), 'a dish')
        USING ERRCODE = 'P0001', HINT = 'pos_comp_line_missing',
              DETAIL = format('recipe %s, choices %s', COALESCE(v_item->>'recipe_id', 'none'), COALESCE(NULLIF(v_sel, ''), 'none'));
    END IF;

    -- S809 1j (CHECKOUT-16): part of a line is 1 up to one less than its quantity. The whole line
    -- goes through p_full_recipe_ids / p_full_lines, which is what the till sends for it; this
    -- branch used to take any number, leaving a charged line of 0 or −3 and a comp of −3.
    IF v_qty < 1 OR v_qty >= v_src.qty THEN
      RAISE EXCEPTION 'pos_comp_qty_invalid: % can be made complimentary from 1 up to % here (the bill has %), not % — a whole line is comped in full',
        v_src.name, v_src.qty - 1, v_src.qty, v_qty
        USING ERRCODE = '22023', HINT = 'pos_comp_qty_invalid';
    END IF;

    -- S809 1j: the kitchen's count of this line, as save_pos_order_items and the pulled-item
    -- triggers define it, is split between the two rows: the comp takes sent units first, and the
    -- charged row keeps the rest. It used to keep its whole sent_qty above its new quantity
    -- (3 sent, comp 1 → qty 2, sent_qty 3), so a later save of that line recorded a pull of 1
    -- that nobody made.
    v_sent := GREATEST(COALESCE(v_src.sent_qty, 0),
                       CASE WHEN COALESCE(v_src.sent_to_kot, false) THEN v_src.qty ELSE 0 END);

    UPDATE pos_order_items
    SET qty = qty - v_qty,
        sent_qty = v_sent - LEAST(v_sent, v_qty)
    WHERE id = v_src.id;

    INSERT INTO pos_order_items (
      order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty,
      comped, comp_reason, comped_by, comped_at, comp_fy, comp_no,
      selection_key, base_unit_price, options_delta, option_summary
    ) VALUES (
      p_order_id, p_client_id, v_src.recipe_id, v_src.name, v_src.category,
      v_qty, v_src.unit_price, v_src.vat_rate, v_src.sent_to_kot,
      LEAST(v_sent, v_qty),
      true, p_comp_reason, v_comped_by, v_now, v_fy, v_comp_no,
      v_src.selection_key, v_src.base_unit_price, v_src.options_delta, v_src.option_summary
    ) RETURNING id INTO v_new_id;

    INSERT INTO pos_order_item_options (
      client_id, order_id, order_item_id, recipe_id, group_id, option_id, group_name, group_kind,
      option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
    )
    SELECT client_id, order_id, v_new_id, recipe_id, group_id, option_id, group_name, group_kind,
           option_name, kitchen_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas, sort
      FROM pos_order_item_options WHERE order_item_id = v_src.id;
  END LOOP;

  RETURN v_comp_no;
END;
$function$;
-- Grants as live (CREATE OR REPLACE keeps them; restated): the till calls it as authenticated.
REVOKE ALL ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb, jsonb) TO authenticated, service_role;


-- ── 5. pos_cash_movements_guard (its shift read takes FOR SHARE) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_cash_movements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shift_status text;
  v_note_net numeric;
BEGIN
  -- S809 1l (GAP-OPERATOR-1): the operator no longer passes here; only its restore does, below.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── S809 1l (GAP-OPERATOR-1, Q26 a): the operator's restore, and nothing else it sends ─────
  -- restoreClientData re-inserts the cash ledger as it was, entries on closed shifts included, each
  -- dated when it was first recorded. Cash In / Out, the credit-settlement entry and the credit-note
  -- refund never send created_at, so an entry made from a screen (by the operator too) is dated
  -- now() by the column default and meets every check below: an OPEN shift of the outlet, a refund
  -- no larger than its note, created_by and created_at stamped, never an edit or a delete. The
  -- operator keeps its rank exemption: pos_caller_has_rank admits it.
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND NEW.created_at < now() THEN
    RETURN NEW;
  END IF;
  -- ── end S809 1l ──────────────────────────────────────────────────────────────────────────

  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'pos_cash_movement_locked: a cash movement is a drawer record and cannot be changed or deleted — record a correcting Cash In or Cash Out instead'
      USING ERRCODE = '42501', HINT = 'pos_cash_movement_locked';
  END IF;

  IF NEW.kind = 'refund' THEN
    IF NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'pos_cash_refund_rank: paying out a credit note refund needs a POS manager or the Owner'
        USING ERRCODE = '42501', HINT = 'pos_cash_refund_rank';
    END IF;
  ELSIF NOT public.pos_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION 'pos_cash_movement_rank: recording cash in or out of the drawer needs a POS supervisor, a POS manager or the Owner'
      USING ERRCODE = '42501', HINT = 'pos_cash_movement_rank';
  END IF;

  -- The drawer it moves is an OPEN shift's. A closed shift's settlement is signed.
  IF NEW.shift_id IS NULL THEN
    RAISE EXCEPTION 'pos_cash_movement_no_shift: cash can only be recorded against an open shift'
      USING HINT = 'pos_cash_movement_no_shift';
  END IF;
  -- S809 2b (SHIFTS-1): FOR SHARE, as a bill's close does (guard_pos_order_close). An entry that
  -- locks the shift first makes a Close Shift wait for it and then count it; one that arrives after
  -- the Close has locked the row waits, then reads the row's new status here and is refused. The
  -- read returns the row's newest version, so the status test below sees the close.
  SELECT s.status INTO v_shift_status FROM pos_shifts s WHERE s.id = NEW.shift_id AND s.client_id = NEW.client_id FOR SHARE;
  IF v_shift_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'pos_cash_movement_shift_closed: that shift is closed (or not this outlet''s), so this cash is not on any open drawer count'
      USING HINT = 'pos_cash_movement_shift_closed';
  END IF;

  IF NEW.kind = 'refund' THEN
    SELECT n.net_amount INTO v_note_net FROM pos_credit_notes n
     WHERE n.id = NEW.pos_credit_note_id AND n.client_id = NEW.client_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pos_cash_refund_note: a refund must name a credit note of this outlet'
        USING HINT = 'pos_cash_refund_note';
    END IF;
    IF NEW.amount > COALESCE(v_note_net, 0) + 0.01 THEN
      RAISE EXCEPTION 'pos_cash_refund_over: the refund (NPR %) is more than the credit note (NPR %)', NEW.amount, COALESCE(v_note_net, 0)
        USING HINT = 'pos_cash_refund_over';
    END IF;
  END IF;

  NEW.created_by := (select auth.uid());
  NEW.created_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.pos_cash_movements_guard() FROM PUBLIC;


-- ── 6. pos_shifts_guard (the close time is the server's) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_shifts_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- S809 1l (SHIFTS-2)
  v_counted  numeric;
  v_sales    numeric;
  v_in       numeric;
  v_out      numeric;
  v_expected numeric;
  v_bad      text;
BEGIN
  -- S809 1l (GAP-OPERATOR-1): the operator no longer passes here; only its restore does, below.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── S809 1l (GAP-OPERATOR-1, Q26 a): the operator's restore, and nothing else it sends ─────
  -- restoreClientData re-inserts a client's shifts as they were, closed ones included, each dated
  -- when it was first opened. Open Shift never sends opened_at, so a shift opened from the screen
  -- (by the operator too) is dated now() by the column default and meets every check below. The
  -- operator keeps its rank exemption: pos_caller_has_rank admits it.
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND NEW.opened_at < now() THEN
    RETURN NEW;
  END IF;
  -- ── end S809 1l ──────────────────────────────────────────────────────────────────────────

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos_shift_locked: a shift is a cash record and cannot be deleted — every bill and cash movement on it would lose its shift'
      USING ERRCODE = '42501', HINT = 'pos_shift_locked';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'closed' THEN
    RAISE EXCEPTION 'pos_shift_closed: this shift is closed and its settlement slip is signed — it cannot be changed'
      USING ERRCODE = '42501', HINT = 'pos_shift_closed';
  END IF;

  IF NOT public.pos_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION 'pos_shift_rank: opening or closing a shift needs a POS supervisor, a POS manager or the Owner'
      USING ERRCODE = '42501', HINT = 'pos_shift_rank';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'pos_shift_must_open: a shift starts open and is closed with Close Shift'
        USING HINT = 'pos_shift_must_open';
    END IF;
    -- ── S809 1l (SHIFTS-2): the opening float is the total of the notes counted ────────────
    v_counted := public.pos_cash_count_total(NEW.opening_denominations);
    IF v_counted IS NULL OR abs(NEW.opening_cash - v_counted) > 0.005 THEN
      RAISE EXCEPTION 'pos_shift_count_mismatch: the opening cash (NPR %) is not the total of the notes counted (%) — count the drawer on the Shifts screen, which adds the notes up itself',
        NEW.opening_cash, COALESCE('NPR ' || v_counted, 'not a valid count')
        USING ERRCODE = '23514', HINT = 'pos_shift_count_mismatch';
    END IF;
    -- ── end S809 1l ────────────────────────────────────────────────────────────────────────
    -- Attribution the subject can choose is not attribution.
    NEW.opened_by := (select auth.uid());
    NEW.opened_at := now();
    NEW.closed_at := NULL; NEW.closed_by := NULL; NEW.closing_cash := NULL;
    NEW.closing_denominations := NULL; NEW.closing_report := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE of an open shift. What it opened with is fixed; Expected Cash is measured from it.
  -- S809 1l: so are the shift and its outlet, whose stored rows the close below adds up.
  NEW.id := OLD.id;
  NEW.client_id := OLD.client_id;
  NEW.opened_by := OLD.opened_by;
  NEW.opened_at := OLD.opened_at;
  NEW.opening_cash := OLD.opening_cash;
  NEW.opening_denominations := OLD.opening_denominations;
  IF NEW.status = 'closed' THEN
    -- ── S809 1l (SHIFTS-2): the signed cash figures are the shift's own ──────────────────────
    -- Counted Cash is the total of the notes counted.
    v_counted := public.pos_cash_count_total(NEW.closing_denominations);
    IF v_counted IS NULL OR NEW.closing_cash IS NULL OR abs(NEW.closing_cash - v_counted) > 0.005 THEN
      RAISE EXCEPTION 'pos_shift_count_mismatch: the counted cash (%) is not the total of the notes counted (%) — count the drawer on the Shifts screen, which adds the notes up itself',
        COALESCE('NPR ' || NEW.closing_cash, 'none'), COALESCE('NPR ' || v_counted, 'not a valid count')
        USING ERRCODE = '23514', HINT = 'pos_shift_count_mismatch';
    END IF;

    -- Expected Cash from what is stored, the way expectedCashOf adds up loadShiftReport's rows: the
    -- float, the paid Cash bills, the Cash legs of the paid Split bills (a leg on any other bill is
    -- not counted there either), Cash In, less Cash Out. These read through the caller's RLS, and
    -- that view is the whole of this outlet's bills, legs and entries: the three tables carry the
    -- same same-client policy and the same three restrictive ones as pos_shifts, whose row this
    -- caller is updating (the S749 lesson: the read is as wide as the target).
    -- S809 2b (SHIFTS-1): this UPDATE locked the shift's row before this trigger ran, waiting for
    -- any bill or cash entry holding it FOR SHARE to finish, and each read below takes a fresh
    -- snapshot (a VOLATILE body under READ COMMITTED). So these figures include every bill and entry
    -- that reached the shift, and none can reach it from here to the close: they wait on the row
    -- and are then refused, because the shift is closed.
    SELECT COALESCE(sum(o.paid_amount), 0) INTO v_sales
      FROM pos_orders o
     WHERE o.shift_id = OLD.id AND o.client_id = OLD.client_id
       AND o.close_type = 'paid' AND o.payment_method = 'Cash';
    SELECT v_sales + COALESCE(sum(p.amount), 0) INTO v_sales
      FROM pos_order_payments p
      JOIN pos_orders o ON o.id = p.order_id
     WHERE o.shift_id = OLD.id AND o.client_id = OLD.client_id
       AND o.close_type = 'paid' AND o.payment_method = 'Split'
       AND p.client_id = OLD.client_id AND p.payment_method = 'Cash';
    SELECT COALESCE(sum(m.amount) FILTER (WHERE m.direction = 'in'), 0),
           COALESCE(sum(m.amount) FILTER (WHERE m.direction = 'out'), 0)
      INTO v_in, v_out
      FROM pos_cash_movements m
     WHERE m.shift_id = OLD.id AND m.client_id = OLD.client_id;
    v_expected := NEW.opening_cash + v_sales + v_in - v_out;

    -- A report sent with the close must carry the eight cash figures the screens and the slip show,
    -- each the database's own within NPR 0.01 (the page adds in floating point). A missing or
    -- non-numeric figure counts as wrong: the page reads a missing one as 0, which is how leaving one
    -- out would hide that much cash. No report at all stays allowed: History then adds the stored
    -- rows up itself, which is the true figure.
    IF NEW.closing_report IS NOT NULL THEN
      SELECT string_agg(f.k, ', ' ORDER BY f.ord) INTO v_bad
        FROM (VALUES (1, 'cashSales',     NEW.closing_report -> 'cashSales',          v_sales),
                     (2, 'byMethod.Cash', NEW.closing_report -> 'byMethod' -> 'Cash', v_sales),
                     (3, 'cashIn',        NEW.closing_report -> 'cashIn',             v_in),
                     (4, 'cashOut',       NEW.closing_report -> 'cashOut',            v_out),
                     (5, 'openingCash',   NEW.closing_report -> 'openingCash',        NEW.opening_cash),
                     (6, 'expectedCash',  NEW.closing_report -> 'expectedCash',       v_expected),
                     (7, 'closingCash',   NEW.closing_report -> 'closingCash',        NEW.closing_cash),
                     (8, 'variance',      NEW.closing_report -> 'variance',           NEW.closing_cash - v_expected)
             ) AS f(ord, k, sent, want)
       WHERE NOT COALESCE(abs(CASE WHEN jsonb_typeof(f.sent) = 'number'
                                   THEN (f.sent #>> '{}')::numeric END - f.want) <= 0.01, false);
      IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'pos_shift_figures_changed: this shift''s cash figures are not the ones sent with the close (%) — a bill or a cash entry probably reached the shift after its figures were read; nothing was closed, so press Close Shift again to count against the new figures', v_bad
          USING ERRCODE = 'P0001', HINT = 'pos_shift_figures_changed',
                DETAIL = jsonb_build_object('openingCash', NEW.opening_cash, 'cashSales', v_sales,
                                            'cashIn', v_in, 'cashOut', v_out, 'expectedCash', v_expected,
                                            'closingCash', NEW.closing_cash,
                                            'variance', NEW.closing_cash - v_expected)::text;
      END IF;
    END IF;
    -- ── end S809 1l ────────────────────────────────────────────────────────────────────────
    NEW.closed_by := (select auth.uid());
    -- ── S809 2b (SHIFTS-7): the close time is the server's ─────────────────────────────────
    -- It was COALESCE(NEW.closed_at, now()), so the tablet's clock (or a REST call) set the date the
    -- slip, History and the open/close window of every bill on the shift are read against. The
    -- report's capturedAt is the same moment, written as the page wrote it (toISOString).
    NEW.closed_at := now();
    IF jsonb_typeof(NEW.closing_report) = 'object' THEN
      NEW.closing_report := NEW.closing_report || jsonb_build_object(
        'capturedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    END IF;
    -- ── end S809 2b ────────────────────────────────────────────────────────────────────────
  ELSE
    NEW.closed_at := NULL; NEW.closed_by := NULL; NEW.closing_cash := NULL;
    NEW.closing_denominations := NULL; NEW.closing_report := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.pos_shifts_guard() FROM PUBLIC;


-- ── 7. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c        uuid;    -- BLOOM CAFE
  v_c2       uuid;    -- BLOOM CAFE - PKR, standing in as "another outlet"
  v_pin      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_owner    uuid;
  v_admin    uuid;
  v_fy       text;    -- the year the server gives today
  v_old      uuid;    -- a closed shift of BLOOM CAFE
  v_s        uuid;    -- the probe's shift
  v_s2       uuid;    -- an open shift of the other outlet
  v_r1       uuid := gen_random_uuid();   -- recipe ids: pos_order_items.recipe_id has no FK
  v_r2       uuid := gen_random_uuid();
  v_r3       uuid := gen_random_uuid();
  v_o_empty  uuid;    -- an open order with no line
  v_o_comped uuid;    -- an open order whose only line is comped
  v_o_cash   uuid;    -- 1 × NPR 1,000 at 13 % VAT, charged Cash NPR 1,130
  v_o_card   uuid;    -- 1 × NPR 500, no VAT, charged Card
  v_o_nc     uuid;    -- a Complimentary bill
  v_o_late   uuid;    -- NPR 250 Cash, charged while the drawer is being counted
  v_o_after  uuid;    -- charged after the shift closed
  v_o_c1     uuid;    -- open orders for the comp checks
  v_o_c2     uuid;
  v_o_c3     uuid;
  v_rbill    uuid;
  v_n        int;
  v_no       int;
  v_comp     int;
  v_txt      text;
  v_hint     text;
  v_msg      text;
  v_detail   text;
  v_ts       timestamptz;
  v_by       uuid;
  v_id       uuid;
  v_rep      jsonb;
  v_past     timestamptz := now() - interval '30 days';
  c_open  CONSTANT jsonb := '{"1000": 1, "500": 1}';                                  -- NPR 1,500
  c_count CONSTANT jsonb := '{"1000": 3, "100": 1, "50": 1, "20": 1, "10": 1}';       -- NPR 3,180
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  -- The four BEFORE row triggers this slice relies on, enabled. Same-timing row triggers fire in
  -- name order, so each guard runs before the numbering trigger on its table; the closes and the
  -- note below prove that behaviourally (each is numbered in the server's year, and a close that
  -- sends no year at all is numbered).
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O'
     AND ((tgrelid = 'public.pos_orders'::regclass AND tgname = 'guard_pos_order_close' AND tgtype = 19
           AND tgfoid = 'public.guard_pos_order_close()'::regprocedure)
       OR (tgrelid = 'public.pos_orders'::regclass AND tgname = 'trg_assign_pos_invoice_no' AND tgtype = 19
           AND tgfoid = 'public.assign_pos_invoice_no()'::regprocedure)
       OR (tgrelid = 'public.pos_credit_notes'::regclass AND tgname = 'guard_pos_credit_note' AND tgtype = 31
           AND tgfoid = 'public.guard_pos_credit_note()'::regprocedure)
       OR (tgrelid = 'public.pos_credit_notes'::regclass AND tgname = 'trg_assign_pos_credit_note_no' AND tgtype = 7
           AND tgfoid = 'public.assign_pos_credit_note_no()'::regprocedure));
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S809 2b: expected the two guards and the two numbering triggers enabled as BEFORE row triggers, found %', v_n;
  END IF;
  -- The guards key on current_user, which only works under SECURITY INVOKER; the comp RPC is the
  -- DEFINER write path. pos_shifts_guard must stay VOLATILE: its reads after the row lock take
  -- fresh snapshots only in a volatile body, which is what SHIFTS-1 rests on.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.guard_pos_order_close()'::regprocedure, 'public.guard_pos_credit_note()'::regprocedure,
                 'public.pos_cash_movements_guard()'::regprocedure, 'public.pos_shifts_guard()'::regprocedure,
                 'public.pos_invoice_fy(timestamptz)'::regprocedure)
     AND NOT prosecdef;
  IF v_n <> 5
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)'::regprocedure)
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.pos_shifts_guard()'::regprocedure) <> 'v'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.pos_invoice_fy(timestamptz)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'S809 2b: a guard became SECURITY DEFINER, apply_pos_item_comps stopped being one, or a volatility changed';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.pos_invoice_fy(timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_invoice_fy(timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_pos_item_comps(uuid,uuid,text,text,uuid,uuid[],jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 2b: pos_invoice_fy or apply_pos_item_comps is not authenticated-only';
  END IF;

  -- ── The year rule, at fixed moments. 1 Shrawan 2083 began 2026-07-17 in Nepal (18:15 UTC the
  -- day before); bs_months ends with Chaitra 2087, 2031-04-13. ──────────────────────────────
  IF public.pos_invoice_fy('2026-07-16 18:14:59+00') IS DISTINCT FROM '82/83'   -- 23:59:59, 32 Ashadh
     OR public.pos_invoice_fy('2026-07-16 18:15:00+00') IS DISTINCT FROM '83/84' -- 00:00, 1 Shrawan
     -- 01:45 on 1 Shrawan in Nepal: a tablet on UTC still reads 16 July, Ashadh, "82/83" (CHECKOUT-4)
     OR public.pos_invoice_fy('2026-07-16 20:00:00+00') IS DISTINCT FROM '83/84'
     OR public.pos_invoice_fy('2027-07-16 18:15:00+00') IS DISTINCT FROM '84/85'
     OR public.pos_invoice_fy('2031-04-13 18:14:59+00') IS DISTINCT FROM '87/88'
     OR public.pos_invoice_fy('2031-04-13 18:15:00+00') IS NOT NULL               -- past the table
     OR public.pos_invoice_fy(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'S809 2b: pos_invoice_fy does not give the fiscal year the till writes';
  END IF;
  -- Every stored year is the one the rule gives: each billed bill by its closed_at, each note by
  -- its created_at (live 2026-10-09: 33 of 33 and 1 of 1).
  SELECT count(*) INTO v_n FROM public.pos_orders
   WHERE status = 'billed' AND invoice_fy IS DISTINCT FROM public.pos_invoice_fy(closed_at);
  SELECT v_n + count(*) INTO v_n FROM public.pos_credit_notes
   WHERE invoice_fy IS DISTINCT FROM public.pos_invoice_fy(created_at);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 2b: % stored bills or notes carry a year the new rule would not give them', v_n;
  END IF;
  v_fy := public.pos_invoice_fy(now());
  IF v_fy IS NULL OR v_fy = '82/83' THEN
    RAISE EXCEPTION 'S809 2b: today''s year came out as %', v_fy;
  END IF;

  -- ── The logins: BLOOM CAFE's POS PIN login (its supervisor where there is one), its Owner, the
  -- operator; BLOOM CAFE - PKR as another outlet ─────────────────────────────────────────────
  SELECT id INTO v_c  FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_c2 FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_pin
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND pos_role IS NULL AND ims_role IS NULL AND hr_role IS NULL
     AND pos_email IS NULL AND NOT COALESCE(hr_self_service, false)
   ORDER BY id LIMIT 1;
  IF v_c IS NULL OR v_c2 IS NULL OR v_pin IS NULL OR v_owner IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 2b probe: needs BLOOM CAFE, BLOOM CAFE - PKR, a POS PIN login and the Owner of BLOOM CAFE, and the operator (got %, %, %, %, %)',
      v_c, v_c2, v_pin, v_owner, v_admin;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- The stand-in loses every other staff marker, or a restrictive policy would turn an "allowed"
    -- into a vacuous 0 rows (the S792 lesson). The outlet's own open shift is closed for the length
    -- of the probe (one open shift per outlet), and the other outlet gets one if it has none.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_pin;
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';
    SELECT id INTO v_old FROM public.pos_shifts WHERE client_id = v_c AND status = 'closed' ORDER BY opened_at LIMIT 1;
    -- The owner cleared BLOOM CAFE's data on 2026-10-09 (no shift left), so the probe brings its own
    -- old closed shift when there is none. Rolled back with everything else below.
    IF v_old IS NULL THEN
      INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations,
                                     opened_at, closed_at, closing_cash, closing_denominations)
        VALUES (v_c, 'closed', 'S809 2b probe old shift', 0, '{}', v_past, v_past + interval '8 hours', 0, '{}')
        RETURNING id INTO v_old;
    END IF;
    SELECT id INTO v_s2 FROM public.pos_shifts WHERE client_id = v_c2 AND status = 'open';
    IF v_s2 IS NULL THEN
      INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
        VALUES (v_c2, 'open', 'S809 2b probe other outlet', 0, '{}') RETURNING id INTO v_s2;
    END IF;
    IF v_old IS NULL OR v_s2 IS NULL THEN
      RAISE EXCEPTION 'S809 2b probe: setup found no closed shift of the outlet or no shift of the other outlet';
    END IF;

    -- Takeaway orders. order_no is given, so the probe takes no lock on the outlet's real series.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990401) RETURNING id INTO v_o_empty;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990402) RETURNING id INTO v_o_comped;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990403) RETURNING id INTO v_o_cash;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990404) RETURNING id INTO v_o_card;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990405) RETURNING id INTO v_o_nc;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990406) RETURNING id INTO v_o_late;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990407) RETURNING id INTO v_o_after;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990408) RETURNING id INTO v_o_c1;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990409) RETURNING id INTO v_o_c2;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2b probe', 990410) RETURNING id INTO v_o_c3;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, comped, comp_reason, comp_no, comp_fy)
      VALUES (v_o_comped, v_c, v_r1, 'S809 2b probe comped', 1, 300, 0, true, 'probe', 990, 'S809-2b');
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      VALUES (v_o_cash,  v_c, v_r1, 'S809 2b probe dish', 1, 1000, 0.13),
             (v_o_card,  v_c, v_r2, 'S809 2b probe dish', 1, 500, 0),
             (v_o_nc,    v_c, v_r1, 'S809 2b probe dish', 1, 200, 0),
             (v_o_late,  v_c, v_r1, 'S809 2b probe dish', 1, 250, 0),
             (v_o_after, v_c, v_r1, 'S809 2b probe dish', 1, 100, 0),
             (v_o_c1,    v_c, v_r1, 'S809 2b probe momo', 3, 250, 0),
             (v_o_c1,    v_c, v_r2, 'S809 2b probe coke', 1, 100, 0),
             (v_o_c2,    v_c, v_r2, 'S809 2b probe coke', 1, 100, 0),
             (v_o_c3,    v_c, v_r3, 'S809 2b probe tea',  2, 50, 0);
    -- CHECKOUT-10's leftover: a comp a failed, cancelled close left on an open order.
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, comped, comp_reason, comp_no, comp_fy)
      VALUES (v_o_c2, v_c, v_r2, 'S809 2b probe coke', 1, 100, 0, true, 'probe leftover', 990, 'S809-2b');

    -- ── (a) A POS supervisor, with no shift open at the outlet ───────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 2b probe: the stand-in % is not a plain POS supervisor', v_pin;
    END IF;

    -- CHECKOUT-3: a Charge and a Complimentary close need an open shift, whatever the request names.
    FOR v_txt IN SELECT unnest(ARRAY['paid', 'writeoff']) LOOP
      BEGIN
        UPDATE public.pos_orders
           SET status = 'billed', close_type = v_txt, shift_id = v_old,
               payment_method = CASE WHEN v_txt = 'paid' THEN 'Cash' END,
               paid_amount = CASE WHEN v_txt = 'paid' THEN 1130 ELSE 0 END,
               close_reason = CASE WHEN v_txt = 'writeoff' THEN 'probe' END
         WHERE id = v_o_cash;
        RAISE EXCEPTION 'S809 2b probe: a % close with no shift open was accepted', v_txt;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'no_open_shift' THEN
          RAISE EXCEPTION 'S809 2b probe: a % close with no shift — expected no_open_shift, got: %', v_txt, v_msg;
        END IF;
      END;
    END LOOP;

    -- The supervisor opens the probe's shift.
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S809 2b probe', 1500, c_open) RETURNING id INTO v_s;

    -- ── (b) CHECKOUT-1: a bill with nothing on it is refused ──────────────────────────────────
    FOR v_txt, v_id IN SELECT * FROM (VALUES ('paid', v_o_empty), ('writeoff', v_o_empty), ('paid', v_o_comped)) AS x(ct, o) LOOP
      BEGIN
        UPDATE public.pos_orders
           SET status = 'billed', close_type = v_txt,
               payment_method = CASE WHEN v_txt = 'paid' THEN 'Cash' END,
               paid_amount = 0,
               close_reason = CASE WHEN v_txt = 'writeoff' THEN 'probe' END
         WHERE id = v_id;
        RAISE EXCEPTION 'S809 2b probe: an empty % close was accepted', v_txt;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'pos_bill_empty' THEN
          RAISE EXCEPTION 'S809 2b probe: an empty % close — expected pos_bill_empty, got: %', v_txt, v_msg;
        END IF;
      END;
    END LOOP;
    -- A Complimentary close needs a line, comped or not: the all-comped order closes that way.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'writeoff', paid_amount = 0, close_reason = 'probe'
     WHERE id = v_o_comped
     RETURNING shift_id, invoice_fy, invoice_no INTO v_id, v_txt, v_no;
    IF NOT FOUND OR v_id IS DISTINCT FROM v_s OR v_txt IS DISTINCT FROM v_fy OR v_no IS NULL THEN
      RAISE EXCEPTION 'S809 2b probe: the all-comped order''s Complimentary close landed on shift %, year %, NC %', v_id, v_txt, v_no;
    END IF;

    -- ── (c) A Charge lands on the open shift, in the server's year, whatever the request sent ───
    -- CHECKOUT-3 / CHECKOUT-4: an old closed shift, a forged year and an invoice number are sent;
    -- the bill takes the open shift, today's year and the next number in that year's series.
    SELECT COALESCE(max(invoice_no), 0) + 1 INTO v_no FROM public.pos_orders
     WHERE client_id = v_c AND invoice_fy = v_fy AND close_type = 'paid';
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1130,
           shift_id = v_old, invoice_fy = '82/83', invoice_no = 4242
     WHERE id = v_o_cash
     RETURNING shift_id, invoice_fy, invoice_no, closed_by INTO v_id, v_txt, v_n, v_by;
    IF NOT FOUND OR v_id IS DISTINCT FROM v_s OR v_txt IS DISTINCT FROM v_fy OR v_n IS DISTINCT FROM v_no OR v_by IS DISTINCT FROM v_pin THEN
      RAISE EXCEPTION 'S809 2b probe: the Cash bill landed on shift % (want %), year % (want %), number % (want %), by %', v_id, v_s, v_txt, v_fy, v_n, v_no, v_by;
    END IF;
    -- Another outlet's open shift and no year at all: still this outlet's shift, numbered.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Card', paid_amount = 500,
           shift_id = v_s2, invoice_fy = NULL
     WHERE id = v_o_card
     RETURNING shift_id, invoice_fy, invoice_no INTO v_id, v_txt, v_n;
    IF NOT FOUND OR v_id IS DISTINCT FROM v_s OR v_txt IS DISTINCT FROM v_fy OR v_n IS DISTINCT FROM v_no + 1 THEN
      RAISE EXCEPTION 'S809 2b probe: the Card bill landed on shift %, year %, number % (want %)', v_id, v_txt, v_n, v_no + 1;
    END IF;
    -- A Complimentary close sent with the long year spelling: the NC series of today's year.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'writeoff', paid_amount = 0, close_reason = 'probe', invoice_fy = '2083/84'
     WHERE id = v_o_nc
     RETURNING shift_id, invoice_fy, invoice_no INTO v_id, v_txt, v_n;
    IF NOT FOUND OR v_id IS DISTINCT FROM v_s OR v_txt IS DISTINCT FROM v_fy OR v_n IS NULL THEN
      RAISE EXCEPTION 'S809 2b probe: the Complimentary bill landed on shift %, year %, NC %', v_id, v_txt, v_n;
    END IF;

    -- ── (d) Item comps: the server's year, the comped filter, and no NC number for a missing line ─
    -- 3 momo (comp 1) and the whole coke, sent with last year's spelling and the Owner's name.
    SELECT public.apply_pos_item_comps(v_o_c1, v_c, '82/83', 'probe', v_owner, ARRAY[v_r2],
             jsonb_build_array(jsonb_build_object('recipe_id', v_r1, 'comp_qty', 1, 'name', 'S809 2b probe momo')))
      INTO v_comp;
    SELECT count(*) INTO v_n FROM public.pos_order_items
     WHERE order_id = v_o_c1 AND comped AND comp_no = v_comp AND comp_fy = v_fy AND comped_by = v_pin;
    IF v_comp IS NULL OR v_n <> 2
       OR (SELECT qty FROM public.pos_order_items WHERE order_id = v_o_c1 AND recipe_id = v_r1 AND NOT comped) IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'S809 2b probe: the comps did not land as 2 rows of NC % in year % by the supervisor (% found)', v_comp, v_fy, v_n;
    END IF;

    -- CHECKOUT-10: the whole-coke comp on an order holding a leftover comped coke comps only the
    -- uncomped one; the leftover keeps its own number.
    SELECT public.apply_pos_item_comps(v_o_c2, v_c, v_fy, 'probe', NULL, ARRAY[v_r2], '[]'::jsonb) INTO v_comp;
    IF (SELECT count(*) FROM public.pos_order_items WHERE order_id = v_o_c2 AND comp_no = 990 AND comp_fy = 'S809-2b') <> 1
       OR (SELECT count(*) FROM public.pos_order_items WHERE order_id = v_o_c2 AND comp_no = v_comp AND comp_fy = v_fy) <> 1 THEN
      RAISE EXCEPTION 'S809 2b probe: the whole-recipe comp re-comped the leftover comp (NC %)', v_comp;
    END IF;

    -- S809.4: a comp that finds nothing to comp is refused, and nothing in the call is comped.
    --   the coke again (nothing uncomped left); a customized line that is not there; and the tea in
    --   full beside a part comp of a dish that is not on the bill.
    FOR v_rep IN SELECT x FROM jsonb_array_elements(jsonb_build_array(
        jsonb_build_object('o', v_o_c2, 'full', jsonb_build_array(v_r2), 'partial', '[]'::jsonb, 'lines', NULL),
        jsonb_build_object('o', v_o_c3, 'full', '[]'::jsonb, 'partial', '[]'::jsonb,
                           'lines', jsonb_build_array(jsonb_build_object('recipe_id', v_r3, 'selection_key', 'no-such-choice'))),
        jsonb_build_object('o', v_o_c3, 'full', jsonb_build_array(v_r3),
                           'partial', jsonb_build_array(jsonb_build_object('recipe_id', v_r1, 'comp_qty', 1, 'name', 'S809 2b probe momo')),
                           'lines', NULL))) AS t(x)
    LOOP
      BEGIN
        PERFORM public.apply_pos_item_comps((v_rep ->> 'o')::uuid, v_c, v_fy, 'probe', NULL,
                  ARRAY(SELECT e::uuid FROM jsonb_array_elements_text(v_rep -> 'full') AS e),
                  v_rep -> 'partial', NULLIF(v_rep -> 'lines', 'null'::jsonb));
        RAISE EXCEPTION 'S809 2b probe: a comp with nothing to comp was accepted: %', v_rep;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'pos_comp_line_missing' THEN
          RAISE EXCEPTION 'S809 2b probe: % — expected pos_comp_line_missing, got: %', v_rep, v_msg;
        END IF;
      END;
    END LOOP;
    IF EXISTS (SELECT 1 FROM public.pos_order_items WHERE order_id = v_o_c3 AND comped) THEN
      RAISE EXCEPTION 'S809 2b probe: a refused comp call left a comped line behind';
    END IF;

    -- ── (e) A Credit Note takes the server's year and the next number in it (the Owner issues) ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 2b probe: % is not an Owner login', v_owner;
    END IF;
    SELECT COALESCE(max(credit_note_no), 0) + 1 INTO v_no FROM public.pos_credit_notes
     WHERE client_id = v_c AND invoice_fy = v_fy;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                         taxable_amount, non_taxable_amount, vat_amount, net_amount)
      VALUES (v_c, v_o_cash, '82/83', 1, 'S809 2b probe', '23 Ashwin 2083', 'S809 2b probe', 'none', 1000, 0, 1000, 0, 130, 1130)
      RETURNING invoice_fy, credit_note_no INTO v_txt, v_n;
    IF v_txt IS DISTINCT FROM v_fy OR v_n IS DISTINCT FROM v_no THEN
      RAISE EXCEPTION 'S809 2b probe: the Credit Note took year % number % (want % number %)', v_txt, v_n, v_fy, v_no;
    END IF;

    -- The operator's restore keeps the year a note was issued in (S809 1l, unchanged).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 2b probe: % is not the operator', v_admin;
    END IF;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, invoice_fy)
      VALUES (v_c, 'billed', 'paid', 'Cash', 100, 'S809 2b restored', 990411, v_past, 'S809-2b') RETURNING id INTO v_rbill;
    INSERT INTO public.pos_credit_notes (client_id, order_id, credit_note_no, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, created_at)
      VALUES (v_c, v_rbill, 4243, 'S809-2b', 990411, 'S809 2b restored', '23 Bhadra 2083', 'S809 2b restored', v_past)
      RETURNING invoice_fy, credit_note_no INTO v_txt, v_n;
    IF v_txt IS DISTINCT FROM 'S809-2b' OR v_n IS DISTINCT FROM 4243 THEN
      RAISE EXCEPTION 'S809 2b probe: the restored note landed as year %, number %', v_txt, v_n;
    END IF;

    -- ── (f) The shift: cash in, a bill during the count, and the close ─────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    -- A supervisor's Cash In locks the open shift FOR SHARE through its policies and lands.
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason)
      VALUES (v_c, v_s, 'in', 'pay_in', 300, 'S809 2b probe float top-up');
    -- The report the Shifts page read: 1,500 float + 1,130 Cash + 300 in = 2,930.
    v_rep := jsonb_build_object('cashSales', 1130, 'byMethod', jsonb_build_object('Cash', 1130, 'Card', 500),
                                'cashIn', 300, 'cashOut', 0, 'openingCash', 1500, 'expectedCash', 2930,
                                'closingCash', 3180, 'variance', 250);
    -- Order 1 (SHIFTS-1): a NPR 250 Cash bill commits onto the shift while the drawer is counted.
    -- Concurrently, the Close would have waited on this bill's FOR SHARE; either way, the Close
    -- with the report read before it is refused, naming the new Expected Cash.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 250
     WHERE id = v_o_late RETURNING shift_id INTO v_id;
    IF NOT FOUND OR v_id IS DISTINCT FROM v_s THEN
      RAISE EXCEPTION 'S809 2b probe: the bill charged during the count landed on shift %', v_id;
    END IF;
    BEGIN
      UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3180, closing_denominations = c_count, closing_report = v_rep
       WHERE id = v_s AND status = 'open';
      RAISE EXCEPTION 'S809 2b probe: a close that left out the bill charged during the count was accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'pos_shift_figures_changed'
         OR (CASE WHEN v_hint = 'pos_shift_figures_changed' THEN (v_detail::jsonb ->> 'expectedCash')::numeric END) IS DISTINCT FROM 3180 THEN
        RAISE EXCEPTION 'S809 2b probe: the stale close — expected pos_shift_figures_changed at Expected Cash 3180, got: % / %', v_msg, v_detail;
      END IF;
    END;
    -- Pressed again with the re-read figures, it lands. SHIFTS-7: a 2020 close time and capturedAt
    -- are sent (a tablet whose clock reset); both become the server's moment.
    v_rep := jsonb_build_object('cashSales', 1380, 'byMethod', jsonb_build_object('Cash', 1380, 'Card', 500),
                                'cashIn', 300, 'cashOut', 0, 'openingCash', 1500, 'expectedCash', 3180,
                                'closingCash', 3180, 'variance', 0, 'capturedAt', '2020-01-01T00:00:00.000Z');
    UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3180, closing_denominations = c_count,
                                 closing_report = v_rep, closed_at = '2020-01-01 00:00:00+00'
     WHERE id = v_s AND status = 'open'
     RETURNING closed_at, closing_report ->> 'capturedAt', closed_by INTO v_ts, v_txt, v_by;
    IF NOT FOUND OR v_ts IS DISTINCT FROM now() OR v_by IS DISTINCT FROM v_pin
       OR v_txt IS DISTINCT FROM to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
      RAISE EXCEPTION 'S809 2b probe: the close landed at %, captured %, by % (want now(), by the supervisor)', v_ts, v_txt, v_by;
    END IF;

    -- Order 2 (SHIFTS-1 / CHECKOUT-3): once the shift is closed, a bill is refused rather than
    -- landing on it, and so is cash. Concurrently, each would have waited on the Close's row lock and
    -- then read the closed row.
    BEGIN
      UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 100, shift_id = v_s
       WHERE id = v_o_after;
      RAISE EXCEPTION 'S809 2b probe: a bill was charged onto a closed shift';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'no_open_shift' THEN
        RAISE EXCEPTION 'S809 2b probe: a bill after the close — expected no_open_shift, got: %', v_msg;
      END IF;
    END;
    BEGIN
      INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason)
        VALUES (v_c, v_s, 'out', 'pay_out', 100, 'S809 2b probe');
      RAISE EXCEPTION 'S809 2b probe: cash was recorded on a closed shift';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_cash_movement_shift_closed' THEN
        RAISE EXCEPTION 'S809 2b probe: cash after the close — expected pos_cash_movement_shift_closed, got: %', v_msg;
      END IF;
    END;

    -- ── (g) A void needs no shift, and gets no year or number (the Owner, who needs no Allow Void) ─
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.pos_orders SET status = 'voided', close_type = 'void', close_reason = 'probe'
     WHERE id = v_o_after
     RETURNING invoice_no, closed_by INTO v_n, v_by;
    IF NOT FOUND OR v_n IS NOT NULL OR v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S809 2b probe: the Owner''s void with no shift open did not land unnumbered (number %, by %)', v_n, v_by;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2b_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_2b_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, provolatile, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('guard_pos_order_close', 'guard_pos_credit_note', 'apply_pos_item_comps',
--                      'pos_cash_movements_guard', 'pos_shifts_guard', 'pos_invoice_fy');
--     expect guard_pos_order_close 5a50b8bc5ea06f2102e6440e16173e1d, guard_pos_credit_note 698df246f07fb00a23a1dda876aff6f8,
--     apply_pos_item_comps 55553b4fe5365f40de48f9d6e7025d6d, pos_cash_movements_guard 6cc608afe6808f86308b8ef2d32cf7cf,
--     pos_shifts_guard 30c69620986bd28650a2ff34b70ab6a0, pos_invoice_fy 58ac0b415f4764340916622d3e489e10;
--     prosecdef true only on apply_pos_item_comps; the four guards
--     {postgres=X/postgres}; apply_pos_item_comps and pos_invoice_fy
--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}; pos_invoice_fy 's'.
--   SELECT has_function_privilege('anon', 'public.pos_invoice_fy(timestamptz)', 'EXECUTE');   -- false
--   SELECT public.pos_invoice_fy(now());                                                        -- '83/84' until 2027-07-16 18:15 UTC
--   SELECT count(*) FROM public.pos_orders WHERE status = 'billed' AND invoice_fy IS DISTINCT FROM public.pos_invoice_fy(closed_at);   -- 0
--   SELECT count(*) FROM public.pos_credit_notes WHERE invoice_fy IS DISTINCT FROM public.pos_invoice_fy(created_at);                -- 0
--   SELECT count(*), count(*) FILTER (WHERE status = 'open') FROM public.pos_shifts;                                                  -- 0 / 0 (BLOOM CAFE cleared 2026-10-09)
--   SELECT count(*) FROM public.pos_orders;   -- unchanged (0 after the owner's clear and the leftover cleanup, 2026-10-09)
