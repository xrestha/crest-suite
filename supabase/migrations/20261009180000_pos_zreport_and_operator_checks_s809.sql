-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1l: the cash figures on a signed Z-report are the shift's own, and Crest
-- support meets the same cash and credit-note checks as the restaurant.
--
--   SHIFTS-2 (P2). pos_shifts_guard stamped who closed a shift and kept everything else the tablet
--   sent: the counted cash, the notes counted and the whole closing report. One PATCH could close a
--   shift with Cash Sales NPR 5,000 lower and a variance of 0, and Shift History then showed
--   "✓ Balanced" over a NPR 5,000 shortage with no Cash Out line anyone could question. Now:
--     (1) the counted cash must be the total of the notes counted (₨1000 down to ₨1, whole counts,
--         none negative), and so must the opening float when a shift opens (pos_shift_count_mismatch);
--     (2) as a shift closes, the guard works out Expected Cash itself, as expectedCashOf
--         (PosShifts.jsx) does over the rows loadShiftReport reads: the opening float, + paid_amount
--         of the shift's paid Cash bills, + the Cash legs of its paid Split bills, + Cash In,
--         − Cash Out. Plain sums of stored figures, so no VAT or rounding is worked out a second
--         time (pos-billing.md: paid_amount is deliberately not re-derived);
--     (3) a closing report sent with the close must carry the eight cash figures the screens and the
--         slip show, each within NPR 0.01 of the database's: cashSales, byMethod.Cash, cashIn,
--         cashOut, openingCash, expectedCash, closingCash and variance. Otherwise the close is
--         refused (pos_shift_figures_changed), naming the figures, with the database's in DETAIL.
--     It refuses rather than rewrites, because the page prints the signed slip from the figures it
--     sent: rewritten figures would let the paper and the stored record disagree, which is what
--     freezing the report at the close (S573) exists to stop. An honest page meets the refusal only
--     when a bill or a cash entry landed after its last re-read. The close dialog keeps the count,
--     and pressing Close Shift again re-reads and asks again.
--     Not covered: Total Sales, discounts, the void and comp values, the non-cash method rows, the
--     bill counts and the cash-entry lines are still the page's (none of them moves Expected Cash,
--     and every bill keeps its shift_id, so each can be recounted). A close with no report is still
--     accepted (History then adds the stored rows up itself, which is the true figure). The close
--     time is still the tablet's (SHIFTS-7, stage 4). A bill or cash entry committing at the same
--     instant as the close can still land after the figures were taken (SHIFTS-1 / CHECKOUT-3,
--     stage 2). A false count typed on the screen is a human count, as before.
--
--   GAP-OPERATOR-1 (P2). All three guards let the operator straight through (the credit-note guard on
--   an insert; "the operator's restore carries the historical rows as they were"), so a credit note
--   or a cash entry the database
--   refused to the restaurant's manager went through unchecked when Crest support entered it from
--   the same screen: a note worked out under today's VAT setting against a bill printed with VAT, a
--   Cash Out on a shift that had just closed. Owner decision Q26 (a), 2026-10-08: outside a restore
--   the operator meets the same integrity checks as the Owner, and stays exempt from the rank rules
--   (S754; pos_caller_has_rank admits it). So for the operator, outside a restore:
--     credit notes: a paid bill of the outlet, one note per bill, the S755 amount match, issued_by
--       stamped, the number from the series, print count 0, no Inventory mark;
--     cash entries: an OPEN shift of the outlet, a refund no larger than its note, created_by and
--       created_at stamped, and no edit or delete;
--     shifts: opened open, the float the notes counted, opened_by / opened_at stamped, the close
--       checks above, and no change or delete once closed. That replaces S754's "the operator may
--       change a closed shift" (POS_DECISIONS.md).
--
--   How the restore is told apart. restoreClientData inserts through the browser as the operator,
--   and what it inserts already happened: every row carries the time it was first recorded
--   (opened_at on a shift, created_at on a cash entry and on a credit note), and that time is in the
--   past. No screen sends either column. Open Shift, Cash In / Out, the credit-settlement entry, the
--   cash refund and Issue Credit Note all leave it to the column default, now(), which is the
--   transaction's own start, so a row the database dated itself equals now() exactly. "The operator,
--   inserting a row dated before this transaction" is the restore, and nothing a screen sends.
--   Considered and not taken: a request header, or an admin-only clients.restore_in_progress_at that
--   the restore sets and clears. Both need restoreClientData changed, and a restore run from an admin
--   tab opened before the release would then be checked like a screen: closed shifts refused (and so
--   every bill that names one), credit notes renumbered and their print counts reset, silently. The
--   flag would also outlive a restore that crashed half way. Like any test of what a request carries,
--   a REST call the operator writes by hand can still pass as a restore; Q26 is about the screens.
--
-- Built on (md5(prosrc)); section 0 refuses to run over any other body:
--   pos_shifts_guard()          72f03d7d684601da55090461c41d392d  LIVE, read 2026-10-09
--   pos_cash_movements_guard()  92bfe10cddcd7c92ef082759df4f1a42  LIVE, read 2026-10-09
--   guard_pos_credit_note()     cfd440874663c690990ba6ea65c832f8  slice 1c's DRAFTED body
--     (20261009110000), its "S809 1c" UPDATE block kept as written. The live body before 1c is
--     6d8474f9ddd8bf0de59d6eff4fcae42b, which section 0 refuses: apply 1c first.
-- Every change inside the three bodies is a block marked "S809 1l"; the rest is the text it was built
-- on. Slice 1b's build gate sits on pos_orders and pos_order_items only; the probe sends its header.
--
-- Live before this migration (2026-10-09): 2 shifts, both BLOOM CAFE. One closed 2026-07-29 with no
-- report (opening 500 = 5 × ₨100, counted 500 = 5 × ₨100). One open since 2026-09-15 (opening 0, all
-- counts 0), whose stored cash is NPR 4,675 of Cash bills + NPR 520 of Cash legs on one Split bill,
-- with no cash entries: Expected Cash NPR 5,195 if it closed now. 0 cash entries. 1 credit note,
-- issued by the operator on 2026-07-29 and numbered. No constraint is added and no row is rewritten:
-- the guards judge new writes only. New: pos_cash_count_total(jsonb), a pure function the shift
-- guard calls.
--
-- The probe at the end runs as a POS supervisor PIN login, the outlet's Owner and the operator inside
-- a block that rolls itself back. If any check fails, the whole migration fails and nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
--
-- CREATE OR REPLACE would silently revert another change to any of them. The second hash of each
-- pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_shifts_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '72f03d7d684601da55090461c41d392d' AND v_md5 IS DISTINCT FROM '79b0b361c7a6466d5fc258ec3cd39d83' THEN
    RAISE EXCEPTION 'S809 1l: pos_shifts_guard changed since this slice was drafted (live md5 %) — merge section 2 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '92bfe10cddcd7c92ef082759df4f1a42' AND v_md5 IS DISTINCT FROM 'ed465552c326ed8657748b9feb3ec5c1' THEN
    RAISE EXCEPTION 'S809 1l: pos_cash_movements_guard changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'cfd440874663c690990ba6ea65c832f8' AND v_md5 IS DISTINCT FROM '905bed988d335a5251656179e3bfc0ca' THEN
    RAISE EXCEPTION 'S809 1l: guard_pos_credit_note is not slice 1c''s body (live md5 %). Apply 20261009110000 first; if the guard changed after it, merge section 4 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. What a count of notes adds up to ─────────────────────────────────────────────────────
--
-- The Shifts screen sends each count as {"1000": 3, "500": 0, …, "1": 2}: the nine notes and coins it
-- shows, as whole numbers, none negative (DenomGrid clamps a typed "-5" to 0). This returns their
-- total, or NULL when the count is not that shape: another key, a fraction, a negative, a
-- non-number, or no object at all. A note left out counts 0, and {} is 0. Every cast sits behind a
-- CASE, so a malformed count is a NULL, never an error.
-- A plain function, not SECURITY DEFINER: it reads no table. pos_shifts_guard is SECURITY INVOKER and
-- calls it as the signed-in login, so authenticated needs EXECUTE; anon never reaches the call.
CREATE OR REPLACE FUNCTION public.pos_cash_count_total(p_counts jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT CASE
           WHEN jsonb_typeof(p_counts) = 'object'
            AND COALESCE(bool_and(c.note IS NOT NULL AND c.n IS NOT NULL AND c.n >= 0 AND c.n = trunc(c.n)), true)
           THEN COALESCE(sum(c.note * c.n), 0)
         END
    FROM (SELECT CASE WHEN e.key IN ('1000', '500', '100', '50', '20', '10', '5', '2', '1')
                      THEN e.key::numeric END AS note,
                 CASE WHEN jsonb_typeof(e.value) = 'number'
                      THEN (e.value #>> '{}')::numeric END AS n
            FROM jsonb_each(CASE WHEN jsonb_typeof(p_counts) = 'object' THEN p_counts ELSE '{}'::jsonb END) AS e
         ) AS c
$fn$;
REVOKE ALL ON FUNCTION public.pos_cash_count_total(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_cash_count_total(jsonb) TO authenticated, service_role;


-- ── 2. pos_shifts_guard ───────────────────────────────────────────────────────────────────────
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
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  ELSE
    NEW.closed_at := NULL; NEW.closed_by := NULL; NEW.closing_cash := NULL;
    NEW.closing_denominations := NULL; NEW.closing_report := NULL;
  END IF;
  RETURN NEW;
END;
$function$;
-- A trigger function: no EXECUTE for anyone (live ACL is the owner's only). CREATE OR REPLACE keeps
-- it; this only restates it.
REVOKE ALL ON FUNCTION public.pos_shifts_guard() FROM PUBLIC;


-- ── 3. pos_cash_movements_guard ─────────────────────────────────────────────────────────────
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
  SELECT s.status INTO v_shift_status FROM pos_shifts s WHERE s.id = NEW.shift_id AND s.client_id = NEW.client_id;
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


-- ── 4. guard_pos_credit_note (slice 1c's body; the INSERT branch's operator exemption narrowed) ──
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

  NEW.issued_by := (SELECT auth.uid());
  NEW.credit_note_no := NULL;   -- numbered by trg_assign_pos_credit_note_no, never by the request
  NEW.ims_posted_at := NULL;
  NEW.print_count := 0;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_pos_credit_note() FROM PUBLIC;


-- ── 5. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n      int;
  v_pin    uuid;    -- a POS PIN login, made to stand in for a POS supervisor
  v_c      uuid;    -- its outlet
  v_owner  uuid;
  v_admin  uuid;
  v_s1     uuid;
  v_s2     uuid;
  v_s3     uuid;
  v_r1     uuid;
  v_m      uuid;
  v_b      uuid;
  v_vat    uuid;    -- a bill printed with VAT: one NPR 1,000 dish + NPR 130
  v_rbill  uuid;
  v_note   uuid;
  v_no     integer;
  v_pc     integer;
  v_by     uuid;
  v_ts     timestamptz;
  v_num    numeric;
  v_txt    text;
  v_hint   text;
  v_msg    text;
  v_detail text;
  v_x      jsonb;
  v_rep    jsonb;
  v_past   timestamptz := now() - interval '30 days';
  -- Shift 1's drawer at the close: 3 × ₨1000 + 4 × ₨100 + ₨20 + ₨10 = NPR 3,430.
  c_count1 CONSTANT jsonb := '{"1000": 3, "500": 0, "100": 4, "50": 0, "20": 1, "10": 1, "5": 0, "2": 0, "1": 0}';
BEGIN
  -- Catalog. Asserted on catalog columns, never on formatted text.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O' AND tgtype = 31   -- ROW | BEFORE | INSERT | DELETE | UPDATE
     AND ((tgrelid = 'public.pos_shifts'::regclass AND tgname = 'pos_shifts_guard'
           AND tgfoid = 'public.pos_shifts_guard()'::regprocedure)
       OR (tgrelid = 'public.pos_cash_movements'::regclass AND tgname = 'pos_cash_movements_guard'
           AND tgfoid = 'public.pos_cash_movements_guard()'::regprocedure)
       OR (tgrelid = 'public.pos_credit_notes'::regclass AND tgname = 'guard_pos_credit_note'
           AND tgfoid = 'public.guard_pos_credit_note()'::regprocedure));
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 1l: expected the three BEFORE row guards enabled on their tables, found %', v_n;
  END IF;
  -- All three key on current_user, which only works under SECURITY INVOKER.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.pos_shifts_guard()'::regprocedure, 'public.pos_cash_movements_guard()'::regprocedure,
                 'public.guard_pos_credit_note()'::regprocedure, 'public.pos_cash_count_total(jsonb)'::regprocedure)
     AND NOT prosecdef;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S809 1l: a guard or the count helper became SECURITY DEFINER';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.pos_cash_count_total(jsonb)'::regprocedure) <> 'i'
     OR NOT has_function_privilege('authenticated', 'public.pos_cash_count_total(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_cash_count_total(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 1l: pos_cash_count_total is not IMMUTABLE, or its EXECUTE is not authenticated-only';
  END IF;

  -- The count helper adds a count up exactly as the Shifts screen does, and refuses any other shape.
  IF public.pos_cash_count_total('{"1000": 2, "5": 3}') IS DISTINCT FROM 2015
     OR public.pos_cash_count_total(c_count1) IS DISTINCT FROM 3430
     OR public.pos_cash_count_total('{}') IS DISTINCT FROM 0
     OR public.pos_cash_count_total('{"7": 1}') IS NOT NULL
     OR public.pos_cash_count_total('{"1000": -1}') IS NOT NULL
     OR public.pos_cash_count_total('{"1000": 1.5}') IS NOT NULL
     OR public.pos_cash_count_total('{"1000": "2"}') IS NOT NULL
     OR public.pos_cash_count_total('[1000]') IS NOT NULL
     OR public.pos_cash_count_total(NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'S809 1l: pos_cash_count_total does not add a count up as the Shifts screen does';
  END IF;

  -- The logins: a POS PIN login and its outlet, that outlet's Owner, and the operator.
  SELECT p.id, COALESCE(p.active_client_id, p.client_id) INTO v_pin, v_c
    FROM public.profiles p
    JOIN public.clients c ON c.id = COALESCE(p.active_client_id, p.client_id)
   WHERE p.role = 'client' AND c.pos_enabled AND p.pos_email IS NOT NULL
   ORDER BY p.id
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
  IF v_pin IS NULL OR v_owner IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 1l probe: needs a POS PIN login, its outlet''s Owner and the operator (got %, %, %)', v_pin, v_owner, v_admin;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- Setup, as the migration's own role. The stand-in loses every other staff marker, or a
    -- restrictive policy would turn an "allowed" into a vacuous 0 rows (the S792 lesson). The
    -- outlet's own open shift is closed for the length of the probe: one open shift per outlet.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_pin;
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';

    -- ── (a) A POS supervisor opens a shift: the float is the notes counted ──────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 1l probe: the stand-in % is not a plain POS supervisor', v_pin;
    END IF;

    -- SHIFTS-2: a float that is not the notes counted is refused, however the count is wrong. Each
    -- case is wrong in one way only (the -2 × ₨500 one adds up, if negatives were allowed).
    FOR v_x IN SELECT x FROM jsonb_array_elements('[
        {"cash": 2000, "counts": {"1000": 1, "500": 1}},
        {"cash": 1007, "counts": {"1000": 1, "7": 1}},
        {"cash": 2000, "counts": {"1000": 3, "500": -2}},
        {"cash": 1500, "counts": {"1000": 1.5}},
        {"cash": 0,    "counts": null}
      ]'::jsonb) AS t(x)
    LOOP
      BEGIN
        INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
          VALUES (v_c, 'open', 'S809 1l probe', (v_x ->> 'cash')::numeric, NULLIF(v_x -> 'counts', 'null'::jsonb));
        RAISE EXCEPTION 'S809 1l probe: an opening float of NPR % over the count % was accepted', v_x ->> 'cash', v_x -> 'counts';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'pos_shift_count_mismatch' THEN
          RAISE EXCEPTION 'S809 1l probe: a float over the count % — expected pos_shift_count_mismatch, got: %', v_x -> 'counts', v_msg;
        END IF;
      END;
    END LOOP;

    -- The screen's open lands, signed and dated by the server: a sent author and a sent (past) time
    -- are both replaced. A past date is the restore's mark only from the operator.
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations, opened_by, opened_at)
      VALUES (v_c, 'open', 'S809 1l probe 1', 1500, '{"1000": 1, "500": 1, "100": 0}', v_owner, v_past)
      RETURNING id, opened_by, opened_at INTO v_s1, v_by, v_ts;
    IF v_by IS DISTINCT FROM v_pin OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 1l probe: the supervisor''s shift opened as %, at %', v_by, v_ts;
    END IF;

    -- Shift 1's bills, as the migration's role (the close of a bill is 1c's probe's business):
    -- a Cash bill of NPR 1,130; a Split bill of NPR 2,000 paid NPR 800 cash + NPR 1,200 card; a
    -- Credit bill of NPR 500; and a Card bill carrying a stray Cash leg, which the Shifts page does not
    -- count, so neither may the guard.
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, shift_id)
      VALUES (v_c, 'billed', 'paid', 'Cash',   1130, 'S809 1l probe', 990301, now(), v_s1),
             (v_c, 'billed', 'paid', 'Credit',  500, 'S809 1l probe', 990303, now(), v_s1);
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, shift_id)
      VALUES (v_c, 'billed', 'paid', 'Split', 2000, 'S809 1l probe', 990302, now(), v_s1) RETURNING id INTO v_b;
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_b, v_c, 'Cash', 800), (v_b, v_c, 'Card', 1200);
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, shift_id)
      VALUES (v_c, 'billed', 'paid', 'Card', 300, 'S809 1l probe', 990304, now(), v_s1) RETURNING id INTO v_b;
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_b, v_c, 'Cash', 300);
    -- The bill the credit notes below are issued against: printed with VAT, on no shift.
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 1130, 'S809 1l probe VAT', 990305, now()) RETURNING id INTO v_vat;
    INSERT INTO public.pos_order_items (order_id, client_id, name, qty, unit_price, vat_rate)
      VALUES (v_vat, v_c, 'S809 1l probe dish', 1, 1000, 0.13);

    -- Shift 1's Cash In and Cash Out, from the screen: the sent author is replaced.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, created_by)
      VALUES (v_c, v_s1, 'in', 'pay_in', 300, 'S809 1l probe float top-up', v_owner)
      RETURNING created_by INTO v_by;
    IF v_by IS DISTINCT FROM v_pin THEN
      RAISE EXCEPTION 'S809 1l probe: the supervisor''s Cash In was filed under %', v_by;
    END IF;
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason)
      VALUES (v_c, v_s1, 'out', 'pay_out', 200, 'S809 1l probe supplier');
    -- Expected Cash for shift 1 is now 1,500 + 1,130 + 800 + 300 − 200 = NPR 3,530.

    -- ── (b) The supervisor closes shift 1 ──────────────────────────────────────────────────
    -- SHIFTS-2 itself: the drawer really holds NPR 3,430 and the count says so, and the report
    -- lowers Cash Sales by NPR 100 so that it reads Balanced.
    v_rep := jsonb_build_object('cashSales', 1830, 'byMethod', jsonb_build_object('Cash', 1830, 'Card', 1500, 'Credit', 500),
                                'cashIn', 300, 'cashOut', 200, 'openingCash', 1500, 'expectedCash', 3430,
                                'closingCash', 3430, 'variance', 0);
    BEGIN
      UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3430, closing_denominations = c_count1, closing_report = v_rep
       WHERE id = v_s1 AND status = 'open';
      RAISE EXCEPTION 'S809 1l probe: a close whose report hid NPR 100 of cash sales was accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'pos_shift_figures_changed'
         OR (CASE WHEN v_hint = 'pos_shift_figures_changed' THEN (v_detail::jsonb ->> 'expectedCash')::numeric END) IS DISTINCT FROM 3530
         OR v_msg NOT LIKE '%(cashSales, byMethod.Cash, expectedCash, variance)%' THEN
        RAISE EXCEPTION 'S809 1l probe: the forged close — expected pos_shift_figures_changed at Expected Cash 3530, got: % / %', v_msg, v_detail;
      END IF;
    END;

    -- A counted total that is not the notes counted.
    v_rep := jsonb_build_object('cashSales', 1930, 'byMethod', jsonb_build_object('Cash', 1930, 'Card', 1500, 'Credit', 500),
                                'cashIn', 300, 'cashOut', 200, 'openingCash', 1500, 'expectedCash', 3530,
                                'closingCash', 3530, 'variance', 0);
    BEGIN
      UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3530, closing_denominations = c_count1, closing_report = v_rep
       WHERE id = v_s1 AND status = 'open';
      RAISE EXCEPTION 'S809 1l probe: a counted cash of 3530 over notes adding up to 3430 was accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_shift_count_mismatch' THEN
        RAISE EXCEPTION 'S809 1l probe: the miscounted close — expected pos_shift_count_mismatch, got: %', v_msg;
      END IF;
    END;

    -- A figure left out reads as 0 on the page, so it is refused too.
    v_rep := jsonb_build_object('cashSales', 1930, 'byMethod', jsonb_build_object('Cash', 1930, 'Card', 1500, 'Credit', 500),
                                'cashOut', 200, 'openingCash', 1500, 'expectedCash', 3530,
                                'closingCash', 3430, 'variance', -100);
    BEGIN
      UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3430, closing_denominations = c_count1, closing_report = v_rep
       WHERE id = v_s1 AND status = 'open';
      RAISE EXCEPTION 'S809 1l probe: a report with no Cash In figure was accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_shift_figures_changed' OR v_msg NOT LIKE '%(cashIn)%' THEN
        RAISE EXCEPTION 'S809 1l probe: the report missing Cash In — expected pos_shift_figures_changed naming cashIn, got: %', v_msg;
      END IF;
    END;

    -- The honest race: the report was right when read, then a NPR 250 Cash bill was charged while the
    -- drawer was being counted. The close is refused with the new Expected Cash.
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, shift_id)
      VALUES (v_c, 'billed', 'paid', 'Cash', 250, 'S809 1l probe', 990306, now(), v_s1);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_rep := jsonb_build_object('cashSales', 1930, 'byMethod', jsonb_build_object('Cash', 1930, 'Card', 1500, 'Credit', 500),
                                'cashIn', 300, 'cashOut', 200, 'openingCash', 1500, 'expectedCash', 3530,
                                'closingCash', 3430, 'variance', -100);
    BEGIN
      UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3430, closing_denominations = c_count1, closing_report = v_rep
       WHERE id = v_s1 AND status = 'open';
      RAISE EXCEPTION 'S809 1l probe: a close that left out a bill charged during the count was accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'pos_shift_figures_changed'
         OR (CASE WHEN v_hint = 'pos_shift_figures_changed' THEN (v_detail::jsonb ->> 'expectedCash')::numeric END) IS DISTINCT FROM 3780 THEN
        RAISE EXCEPTION 'S809 1l probe: the stale close — expected pos_shift_figures_changed at Expected Cash 3780, got: % / %', v_msg, v_detail;
      END IF;
    END;

    -- Pressed again with the re-read figures, it lands: Cash Sales carries the page's floating-point
    -- noise, the sent closer is replaced, and the stored variance is NPR 350 short.
    v_rep := jsonb_build_object('cashSales', 2180.004, 'byMethod', jsonb_build_object('Cash', 2180, 'Card', 1500, 'Credit', 500),
                                'cashIn', 300, 'cashOut', 200, 'openingCash', 1500, 'expectedCash', 3780,
                                'closingCash', 3430, 'variance', -350, 'salesTotal', 4180);
    UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3430, closing_denominations = c_count1,
                                 closing_report = v_rep, closed_by = v_owner
     WHERE id = v_s1 AND status = 'open'
     RETURNING closed_by, closing_cash, status, (closing_report ->> 'variance')::numeric INTO v_by, v_num, v_txt, v_detail;
    IF NOT FOUND OR v_by IS DISTINCT FROM v_pin OR v_num IS DISTINCT FROM 3430 OR v_txt IS DISTINCT FROM 'closed'
       OR v_detail::numeric IS DISTINCT FROM -350 THEN
      RAISE EXCEPTION 'S809 1l probe: the honest close did not land as the supervisor''s (closed_by %, counted %, status %, variance %)', v_by, v_num, v_txt, v_detail;
    END IF;

    -- Cash on a closed shift is still refused (S754, unchanged).
    BEGIN
      INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason)
        VALUES (v_c, v_s1, 'in', 'pay_in', 100, 'S809 1l probe');
      RAISE EXCEPTION 'S809 1l probe: a supervisor recorded cash on a closed shift';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_cash_movement_shift_closed' THEN
        RAISE EXCEPTION 'S809 1l probe: cash on a closed shift — expected pos_cash_movement_shift_closed, got: %', v_msg;
      END IF;
    END;

    -- ── (c) The operator, from the same screens (Q26 a) ─────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 1l probe: % is not the operator', v_admin;
    END IF;

    -- What the screens send is dated now(), so it is not a restore: a shift that arrives closed is
    -- refused, and so is a float that is not the notes counted.
    BEGIN
      INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations, closing_cash)
        VALUES (v_c, 'closed', 'S809 1l probe', 0, '{}', 0);
      RAISE EXCEPTION 'S809 1l probe: the operator created a shift already closed';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_shift_must_open' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s closed shift — expected pos_shift_must_open, got: %', v_msg;
      END IF;
    END;
    BEGIN
      INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
        VALUES (v_c, 'open', 'S809 1l probe', 999, '{"500": 1}');
      RAISE EXCEPTION 'S809 1l probe: the operator opened a float that is not the notes counted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_shift_count_mismatch' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s float — expected pos_shift_count_mismatch, got: %', v_msg;
      END IF;
    END;

    -- Shift 2, opened by the operator from the screen: its author and time are the server's.
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations, opened_by)
      VALUES (v_c, 'open', 'S809 1l probe 2', 5000, '{"1000": 5}', v_owner)
      RETURNING id, opened_by, opened_at INTO v_s2, v_by, v_ts;
    IF v_by IS DISTINCT FROM v_admin OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 1l probe: the operator''s shift opened as %, at %', v_by, v_ts;
    END IF;

    -- A Cash Out from the screen lands under the operator's own name, now.
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, created_by)
      VALUES (v_c, v_s2, 'out', 'pay_out', 500, 'S809 1l probe supplier', v_owner)
      RETURNING id, created_by, created_at INTO v_m, v_by, v_ts;
    IF v_by IS DISTINCT FROM v_admin OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 1l probe: the operator''s Cash Out was filed as %, at %', v_by, v_ts;
    END IF;

    -- A cash entry is never edited or deleted, by the operator either.
    BEGIN
      UPDATE public.pos_cash_movements SET amount = 1 WHERE id = v_m;
      RAISE EXCEPTION 'S809 1l probe: the operator edited a cash entry';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_cash_movement_locked' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s edit — expected pos_cash_movement_locked, got: %', v_msg;
      END IF;
    END;
    BEGIN
      DELETE FROM public.pos_cash_movements WHERE id = v_m;
      RAISE EXCEPTION 'S809 1l probe: the operator deleted a cash entry';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_cash_movement_locked' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s delete — expected pos_cash_movement_locked, got: %', v_msg;
      END IF;
    END;

    -- GAP-OPERATOR-1's VAT case: the outlet has left VAT, so the screen works the note out with no
    -- VAT (net NPR 1,000) against a bill that charged NPR 1,130. Refused for the operator as for the
    -- manager.
    BEGIN
      INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                           original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                           taxable_amount, non_taxable_amount, vat_amount, net_amount)
        VALUES (v_c, v_vat, 'S809-1l', 990305, 'S809 1l probe', '2083-06-23', 'S809 1l probe', 'cash',
                1000, 0, 0, 1000, 0, 1000);
      RAISE EXCEPTION 'S809 1l probe: the operator issued a note under today''s VAT setting against a VAT bill';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'credit_note_amounts' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s VAT-case note — expected credit_note_amounts, got: %', v_msg;
      END IF;
    END;

    -- The bill's own amounts pass, and the note is numbered, signed and counted by the server:
    -- the sent number, author, print count and Inventory mark are all replaced.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                         taxable_amount, non_taxable_amount, vat_amount, net_amount,
                                         credit_note_no, issued_by, print_count, ims_posted_at)
      VALUES (v_c, v_vat, 'S809-1l', 990305, 'S809 1l probe', '2083-06-23', 'S809 1l probe', 'cash',
              1000, 0, 1000, 0, 130, 1130, 4242, v_owner, 5, now())
      RETURNING id, issued_by, credit_note_no, print_count, ims_posted_at INTO v_note, v_by, v_no, v_pc, v_ts;
    IF v_by IS DISTINCT FROM v_admin OR v_no IS NULL OR v_no = 4242 OR v_pc IS DISTINCT FROM 0 OR v_ts IS NOT NULL THEN
      RAISE EXCEPTION 'S809 1l probe: the operator''s note landed as issued_by %, number %, print count %, posted %', v_by, v_no, v_pc, v_ts;
    END IF;

    -- Its cash refund: no more than the note, then the note's net.
    BEGIN
      INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, pos_credit_note_id, order_id)
        VALUES (v_c, v_s2, 'out', 'refund', 1200, 'S809 1l probe refund', v_note, v_vat);
      RAISE EXCEPTION 'S809 1l probe: the operator refunded more than the note';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_cash_refund_over' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s over-refund — expected pos_cash_refund_over, got: %', v_msg;
      END IF;
    END;
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, pos_credit_note_id, order_id)
      VALUES (v_c, v_s2, 'out', 'refund', 1130, 'S809 1l probe refund', v_note, v_vat)
      RETURNING created_by INTO v_by;
    IF v_by IS DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'S809 1l probe: the operator''s refund was filed under %', v_by;
    END IF;
    -- Expected Cash for shift 2: 5,000 − 500 − 1,130 = NPR 3,370.

    -- The operator's close meets the same check: a report that leaves the refund out is refused.
    v_rep := jsonb_build_object('cashSales', 0, 'byMethod', jsonb_build_object('Cash', 0),
                                'cashIn', 0, 'cashOut', 500, 'openingCash', 5000, 'expectedCash', 4500,
                                'closingCash', 4500, 'variance', 0);
    BEGIN
      UPDATE public.pos_shifts SET status = 'closed', closing_cash = 4500, closing_denominations = '{"1000": 4, "500": 1}',
                                   closing_report = v_rep
       WHERE id = v_s2 AND status = 'open';
      RAISE EXCEPTION 'S809 1l probe: the operator closed a shift with a report that left the refund out';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
      IF v_hint IS DISTINCT FROM 'pos_shift_figures_changed'
         OR (CASE WHEN v_hint = 'pos_shift_figures_changed' THEN (v_detail::jsonb ->> 'expectedCash')::numeric END) IS DISTINCT FROM 3370 THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s forged close — expected pos_shift_figures_changed at Expected Cash 3370, got: % / %', v_msg, v_detail;
      END IF;
    END;

    -- A close with no report stays allowed (History adds the stored rows up), with an honest count.
    UPDATE public.pos_shifts SET status = 'closed', closing_cash = 3370,
                                 closing_denominations = '{"1000": 3, "100": 3, "50": 1, "20": 1}', closing_report = NULL
     WHERE id = v_s2 AND status = 'open'
     RETURNING closed_by INTO v_by;
    IF NOT FOUND OR v_by IS DISTINCT FROM v_admin THEN
      RAISE EXCEPTION 'S809 1l probe: the operator''s close with no report did not land (closed_by %)', v_by;
    END IF;

    -- GAP-OPERATOR-1's second face: a Cash Out on the shift that has just closed.
    BEGIN
      INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason)
        VALUES (v_c, v_s2, 'out', 'pay_out', 2000, 'S809 1l probe supplier');
      RAISE EXCEPTION 'S809 1l probe: the operator recorded a Cash Out on a closed shift';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_cash_movement_shift_closed' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s Cash Out on a closed shift — expected pos_cash_movement_shift_closed, got: %', v_msg;
      END IF;
    END;

    -- A closed shift is a signed record for the operator too: no change, no delete.
    BEGIN
      UPDATE public.pos_shifts SET closing_cash = 3500 WHERE id = v_s2;
      RAISE EXCEPTION 'S809 1l probe: the operator changed a closed shift';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_shift_closed' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s change to a closed shift — expected pos_shift_closed, got: %', v_msg;
      END IF;
    END;
    BEGIN
      DELETE FROM public.pos_shifts WHERE id = v_s2;
      RAISE EXCEPTION 'S809 1l probe: the operator deleted a shift';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_shift_locked' THEN
        RAISE EXCEPTION 'S809 1l probe: the operator''s shift delete — expected pos_shift_locked, got: %', v_msg;
      END IF;
    END;

    -- ── (d) The Owner opens and closes an empty shift, Balanced ───────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1l probe: % is not an Owner login', v_owner;
    END IF;
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S809 1l probe 3', 0,
              '{"1000": 0, "500": 0, "100": 0, "50": 0, "20": 0, "10": 0, "5": 0, "2": 0, "1": 0}')
      RETURNING id INTO v_s3;
    v_rep := jsonb_build_object('cashSales', 0, 'byMethod', jsonb_build_object('Cash', 0),
                                'cashIn', 0, 'cashOut', 0, 'openingCash', 0, 'expectedCash', 0,
                                'closingCash', 0, 'variance', 0);
    UPDATE public.pos_shifts SET status = 'closed', closing_cash = 0, closing_denominations = '{}', closing_report = v_rep
     WHERE id = v_s3 AND status = 'open'
     RETURNING closed_by INTO v_by;
    IF NOT FOUND OR v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S809 1l probe: the Owner''s balanced close did not land (closed_by %)', v_by;
    END IF;

    -- ── (e) The operator's restore: rows dated when first recorded go in as they were ───────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

    -- A closed shift, its float and count unchecked, its authors blank (prepareRow empties them).
    INSERT INTO public.pos_shifts (client_id, label, status, opened_at, opened_by, opening_cash, opening_denominations,
                                   closed_at, closed_by, closing_cash, closing_denominations, closing_report)
      VALUES (v_c, 'S809 1l restored', 'closed', v_past, NULL, 100, NULL,
              v_past + interval '8 hours', NULL, 999, NULL, '{"variance": 0}')
      RETURNING id, status, opened_at, closing_cash, opened_by INTO v_r1, v_txt, v_ts, v_num, v_by;
    IF v_txt IS DISTINCT FROM 'closed' OR v_ts IS DISTINCT FROM v_past OR v_num IS DISTINCT FROM 999 OR v_by IS NOT NULL THEN
      RAISE EXCEPTION 'S809 1l probe: the restored shift landed as %, opened %, counted %, by %', v_txt, v_ts, v_num, v_by;
    END IF;

    -- A cash entry on that closed shift, as it was.
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, created_at, created_by)
      VALUES (v_c, v_r1, 'out', 'pay_out', 50, 'S809 1l restored', v_past + interval '1 hour', NULL)
      RETURNING created_at, created_by INTO v_ts, v_by;
    IF v_ts IS DISTINCT FROM v_past + interval '1 hour' OR v_by IS NOT NULL THEN
      RAISE EXCEPTION 'S809 1l probe: the restored cash entry landed at %, by %', v_ts, v_by;
    END IF;

    -- A credit note as it was: its own number, print count and Inventory mark, and amounts the
    -- screen's check would refuse (all 0), against a restored bill.
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 100, 'S809 1l restored', 990311, v_past) RETURNING id INTO v_rbill;
    INSERT INTO public.pos_credit_notes (client_id, order_id, credit_note_no, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, issued_by, print_count, ims_posted_at, created_at)
      VALUES (v_c, v_rbill, 4243, 'S809-1l', 990311, 'S809 1l restored', '2083-05-23', 'S809 1l restored', NULL, 2, v_past, v_past)
      RETURNING credit_note_no, print_count, ims_posted_at INTO v_no, v_pc, v_ts;
    IF v_no IS DISTINCT FROM 4243 OR v_pc IS DISTINCT FROM 2 OR v_ts IS DISTINCT FROM v_past THEN
      RAISE EXCEPTION 'S809 1l probe: the restored note landed as number %, print count %, posted %', v_no, v_pc, v_ts;
    END IF;

    -- An open shift as it was: its float and its time kept, no author.
    INSERT INTO public.pos_shifts (client_id, label, status, opened_at, opening_cash)
      VALUES (v_c, 'S809 1l restored open', 'open', v_past, 777)
      RETURNING opened_at, opening_cash, opened_by INTO v_ts, v_num, v_by;
    IF v_ts IS DISTINCT FROM v_past OR v_num IS DISTINCT FROM 777 OR v_by IS NOT NULL THEN
      RAISE EXCEPTION 'S809 1l probe: the restored open shift landed opened %, float %, by %', v_ts, v_num, v_by;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1l_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1l_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, provolatile, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('pos_shifts_guard', 'pos_cash_movements_guard', 'guard_pos_credit_note', 'pos_cash_count_total');
--     expect pos_shifts_guard 79b0b361c7a6466d5fc258ec3cd39d83, pos_cash_movements_guard ed465552c326ed8657748b9feb3ec5c1,
--     guard_pos_credit_note 905bed988d335a5251656179e3bfc0ca, pos_cash_count_total
--     cb7b8225e1bb6b3b0eaeb38ebfeca4c1, prosecdef false on all four, the three guards
--     {postgres=X/postgres} as before, pos_cash_count_total 'i' and
--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
--   SELECT has_function_privilege('anon', 'public.pos_cash_count_total(jsonb)', 'EXECUTE');   -- false
--   SELECT tgrelid::regclass::text, tgname, tgtype::int, tgenabled::text FROM pg_trigger
--    WHERE tgname IN ('pos_shifts_guard', 'pos_cash_movements_guard', 'guard_pos_credit_note');   -- 3 rows, 31, O
--   SELECT count(*), count(closing_report), count(*) FILTER (WHERE status = 'open') FROM public.pos_shifts;   -- 2 / 0 / 1
--   SELECT count(*) FROM public.pos_cash_movements;   -- 0
--   SELECT count(*) FROM public.pos_credit_notes;     -- 1
