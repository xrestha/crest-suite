-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S823, POS stage 5, slice 5c, step 1 of 2: a settlement is dated by the server, a credit bill's
-- cash goes in the drawer once, a close is pinned to the lines it priced, a void is filed on the
-- shift open now, and Close Shift waits for a Split bill's payments.
--
--   3l (credit_settled_at). guard_pos_order_close stamped who settled a Credit bill from the session
--   but kept the tablet's time, so a tablet's clock dated the settlement on Customers → Collected,
--   the Sales Report and the bill's View. It is now this instant, as closed_at is. The page still
--   sends a time, because a NULL there means "not a settlement" to the checks above it.
--
--   3l (one Cash In per settled bill). A Cash settlement puts a credit_settlement entry in the
--   drawer. The page sends a retry with the same id, so a lost answer cannot double it, but nothing
--   stopped a second entry with a new id (another screen, a second tab). A partial unique index on
--   pos_cash_movements(order_id) for that kind makes it once-only, the same shape as the one refund
--   per credit note (pos_cash_movements_one_refund_per_note). Live: 0 settlement entries, so 0
--   duplicates (section 0 refuses to build it over any).
--
--   2d (the close pins its lines). The till saves its cart, works the total out from the lines the
--   save stored, applies comps and points, then sends the close. Another save landing in between
--   (another till's, or this till's next press overtaking an earlier press whose close arrives late)
--   left a bill numbered and printed for a total its stored lines do not add up to. Only
--   save_pos_order_items moves items_version (+1 on every cart save; checked live 2026-10-13: no
--   other function or trigger writes it, and apply_pos_item_comps and redeem_loyalty_points do not),
--   so the till (crest-v438 on) sends the version its save returned, and a Charge or Complimentary
--   close whose version differs from the stored one is refused (pos_bill_lines_changed). A till older
--   than crest-v438 sends none, NEW keeps OLD's, and it closes as before until step 2 raises the build
--   floor. A void prices nothing: never refused for this, and a version it sends is not kept.
--
--   SHIFTS-6 (a void's shift). The guard stamped the open shift on a Charge or Complimentary only,
--   and the till's own read filed a void (S809 SHIFTS-6): a failed read kept a cached id, which could
--   name a shift already closed and frozen without it. A void now reads the open shift FOR SHARE, as
--   a Charge does, and is stamped with it, or with none when none is open; it is never refused for
--   it (S754 owner decision: a void takes no money). The till stops reading it (crest-v438).
--
--   2b (a Split bill's payments inside the shift lock). A Split bill's payment lines are inserted in
--   a request after its close, admitted by guard_pos_order_payments_closed for 10 minutes from the
--   login that closed it. The bill locks its shift FOR SHARE and the lines do not, so a Close Shift
--   between the two froze a report without the bill's Cash leg. pos_shifts_guard now refuses a close
--   (pos_shift_split_pending) while a Split bill on the shift closed in the last 11 minutes has lines
--   adding up to less than it was paid. 11, one minute past the lines' window, so an insert that began
--   inside it and is still finishing is waited for too. guard_pos_order_payments_closed is not
--   touched (5b changed it; one object per slice).
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13: guard_pos_order_close
-- 2b5f4cd801170bafc620052cf40d2620 (S815 4g, 20261012100000), pos_shifts_guard
-- 30c69620986bd28650a2ff34b70ab6a0. Section 0 refuses any other body. Signatures, return types,
-- SECURITY (both INVOKER) and search_path are unchanged, so CREATE OR REPLACE keeps both triggers
-- attached. No RPC changes shape, so no schema reload.
--
-- Deploy order: this file, then the till release crest-v438 (it stops reading the shift for a void,
-- so it must not go out before this lands), then step 2 (20261013100100), which raises
-- pos_min_till_build() to 438 once that release is live. No Edge Function deploy.
--
-- To undo: re-run guard_pos_order_close's CREATE OR REPLACE from 20261012100000 and
-- pos_shifts_guard's from 20261009190000 (the md5s above), then
-- DROP INDEX public.pos_cash_movements_one_credit_settlement.
--
-- The probe at the end acts as a POS outlet's Owner inside a block that rolls itself back. For its
-- second or so it holds the outlet's open shift set aside and its invoice series' advisory lock, so a
-- till closing a bill at that outlet in that moment waits for it. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces, and no duplicate settlement entries ──────────
-- Each second hash is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('2b5f4cd801170bafc620052cf40d2620', '93873af6cdb5452c412396e829e8d41a') THEN
    RAISE EXCEPTION 'S823 5c pre-flight: guard_pos_order_close changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_shifts_guard()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('30c69620986bd28650a2ff34b70ab6a0', '6b85a2600bf70e32d292bcae2dbbd8fa') THEN
    RAISE EXCEPTION 'S823 5c pre-flight: pos_shifts_guard changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_cash_movements
              WHERE kind = 'credit_settlement' AND order_id IS NOT NULL
              GROUP BY order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'S823 5c pre-flight: a settled bill already has two credit_settlement drawer entries. Decide which stands before adding the index.';
  END IF;
END;
$$;


-- ── 1. The close: the settlement's time, the pinned lines, a void's shift ─────────────────────
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
  -- S809 2c
  v_vat_sent      boolean;
  v_vat_reg       boolean;
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
    -- ── S809 2c (CHECKOUT-6): the bill's tax status stands as its close stamped it ──────────
    -- Every reprint, report and Credit Note reads it. A value a request sends is ignored rather
    -- than refused, as a lowered print count is above: no screen changes it after the close, so
    -- this column alone never turns a write into "this bill is locked".
    NEW.vat_registered := OLD.vat_registered;
    -- ── end S809 2c ────────────────────────────────────────────────────────────────────────

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
      -- ── S823 5c (3l): and the time is the server's ─────────────────────────────────────────
      -- The page sends the tablet's clock, and still must send a time: NULL means "not a
      -- settlement" to the test above. A tablet's clock could date a settlement into another day
      -- or month on Customers → Collected and the Sales Report, so it is this instant, as
      -- closed_at is.
      NEW.credit_settled_at := now();
      -- ── end S823 5c ────────────────────────────────────────────────────────────────────────
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

  -- ── S809 2c: nor a tax status; the close below stamps the bill's own ──────────────────────
  -- What the request sent is kept aside first: a Charge names the status its total assumed.
  v_vat_sent := NEW.vat_registered;
  NEW.vat_registered := NULL;
  -- ── end S809 2c ──────────────────────────────────────────────────────────────────────────

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
      -- ── S823 5c (2d): the close pins the lines it priced ─────────────────────────────────
      -- The till saves its cart, works the total out from the lines that save stored, applies
      -- comps and points, then sends this close carrying the items_version the save returned
      -- (crest-v438 on). Only save_pos_order_items moves items_version (+1 on every cart save),
      -- so a different number here means another save landed in between: another till's, or this
      -- till's next press overtaking an earlier press whose close arrives late. The bill would be
      -- numbered and printed for a total its stored lines do not add up to, so it is refused and
      -- the till loads the latest order. A till older than crest-v438 sends no version, NEW keeps
      -- OLD's, and it closes as before until pos_min_till_build() turns it away. First, so an
      -- order another till emptied in between is named as changed, not as empty.
      IF NEW.items_version IS DISTINCT FROM OLD.items_version THEN
        RAISE EXCEPTION 'pos_orders: the items on this bill changed after this till worked out its total (another till saved the order in between), so it was not closed and nothing was charged — open the order again to see the latest, check the total, then close it'
          USING ERRCODE = 'P0001', HINT = 'pos_bill_lines_changed';
      END IF;
      -- ── end S823 5c ──────────────────────────────────────────────────────────────────────

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
    ELSE
      -- ── S823 5c (SHIFTS-6): a void goes on the shift open now, and is never refused for it ──
      -- A shift's Z-report counts its voids by shift_id, and the till's own read (S809 SHIFTS-6)
      -- kept a cached id when it failed, which could name a shift already closed and frozen
      -- without this void. Read as a Charge reads it above, FOR SHARE, so a Close Shift waits for
      -- this void and counts it, and a void arriving after the Close locked the row finds no open
      -- shift. None open files it on none: a void takes no money, so it is never refused for want
      -- of a shift (S754 owner decision). What the request named is replaced either way.
      SELECT s.id, s.status INTO v_shift_id, v_shift_status
        FROM pos_shifts s
       WHERE s.client_id = NEW.client_id AND s.status = 'open'
         FOR SHARE;
      NEW.shift_id := CASE WHEN v_shift_status = 'open' THEN v_shift_id END;
      -- A void prices nothing, so the version it sends is neither checked nor kept.
      NEW.items_version := OLD.items_version;
      -- ── end S823 5c ──────────────────────────────────────────────────────────────────────
    END IF;
    -- ── end S809 2b ────────────────────────────────────────────────────────────────────────

    -- ── S809 2c (CHECKOUT-6, REPORTS-1, CREDIT-NOTES-5): the bill's tax status, frozen ────────
    -- TAX INVOICE or BILL, and whether its lines' VAT is charged, is the outlet's setting at this
    -- instant, kept on the bill, so a reprint, every report and the bill's Credit Note read it as
    -- it was issued, not by today's setting. Read the way save_pos_order_items prices a new line
    -- and the till reads it: a missing row or a NULL flag is registered (the column default). Read
    -- as the caller: settings_select admits the outlet's own row to every login that can update
    -- this order (both scope by my_client_id()), and the operator through is_admin(). A void is
    -- stamped too, so its View shows the type the bill would have been issued as.
    SELECT s.is_vat_registered INTO v_vat_reg FROM settings s WHERE s.client_id = NEW.client_id;
    v_vat_reg := COALESCE(v_vat_reg, true);
    -- A Charge sends the status its total was worked out under (tills from this release; an older
    -- till sends none and is not checked). A till that read its settings before the Owner switched
    -- VAT registration would print one kind of bill under the other kind's stamp, with a total that
    -- no reprint matches, so the Charge is refused and the till reads its settings again. A
    -- Complimentary or a Void charges nothing, so neither is checked.
    IF NEW.close_type = 'paid' AND v_vat_sent IS NOT NULL AND v_vat_sent IS DISTINCT FROM v_vat_reg THEN
      RAISE EXCEPTION 'pos_orders: this outlet''s VAT registration was changed since this till loaded it, so the bill was not charged — the till is reloading it; check the new total with the guest, then charge again'
        USING ERRCODE = '55000', HINT = 'pos_vat_status_changed';
    END IF;
    NEW.vat_registered := v_vat_reg;
    -- ── end S809 2c ────────────────────────────────────────────────────────────────────────

    -- ── S809 2g (CUSTOMERS-PARKING-2): points spent on an unfinished try go back ─────────────
    -- redeem_loyalty_points spends the guest's points and puts a Loyalty line on the open bill just
    -- before the close. A try that never finished (its answer lost, then a reload, a lock, an outlet
    -- move, or the bill charged on another till) left them spent, and only the till that redeemed
    -- them, while it remembered, could hand them back. A Loyalty line belongs only on a Split charge
    -- (the till turns Split on when points are applied), so a close that is not one (Cash, Card, QR,
    -- Credit, Complimentary, Void) hands back whatever redemption stands on the bill, here, in the
    -- close's own transaction: the points return to the guest and the line goes. If anything below
    -- refuses the close, the handback is undone with it. A Split charge keeps its line: the till
    -- redeems for that press just before the close, and hands back first when it charges Split
    -- without points.
    -- The line is read as the caller (pos_order_payments has the same client policy as pos_orders).
    -- The handback is redeem_loyalty_points(…, 0), the one writer of points and of that line, through
    -- its own checks: the same outlet and Supervisor rank this close has just passed, and an open
    -- order, which this BEFORE trigger still sees. As its owner it passes the payment-line guard.
    IF NOT COALESCE(NEW.close_type = 'paid' AND NEW.payment_method = 'Split', false)
       AND EXISTS (SELECT 1 FROM pos_order_payments p
                    WHERE p.order_id = NEW.id AND p.payment_method = 'Loyalty') THEN
      PERFORM public.redeem_loyalty_points(NEW.id, 0);
    END IF;
    -- ── end S809 2g ────────────────────────────────────────────────────────────────────────

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


-- ── 2. Close Shift waits for a Split bill's payments ──────────────────────────────────────────
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
  -- S823 5c
  v_pending  bigint;
  v_first    timestamptz;
  v_last     timestamptz;
  v_list     jsonb;
  v_what     text;
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

    -- ── S823 5c (2b): a Split bill's payments are on the shift before it closes ──────────────
    -- A Split bill's payment lines are inserted by the till in a request after its close, admitted
    -- by guard_pos_order_payments_closed only from the login that closed it, within 10 minutes of
    -- its closed_at. The bill locks this shift (FOR SHARE) and the lines do not, so a Close Shift
    -- landing between the two froze a report without that bill's Cash leg, and the leg then landed
    -- on a closed shift. So a close waits while a Split bill on this shift closed in the last
    -- 11 minutes has lines adding up to less than it was paid (its Loyalty line, written before the
    -- close, counts). One minute past the lines' own window, so a line whose insert began inside it
    -- and is still finishing is waited for too. After that no line can arrive, and the shift closes
    -- without one that never came: the till told the cashier to give those amounts to whoever closes
    -- the drawer. Read through the caller's RLS, as the figures below are: pos_order_payments
    -- carries the same client policy and restrictive families as pos_shifts. Refused before
    -- anything is written; the Shifts page keeps the count it sent.
    SELECT count(*), min(b.closed_at), max(b.closed_at),
           jsonb_agg(jsonb_build_object('order_no', b.order_no, 'invoice_no', b.invoice_no,
                                        'paid', b.paid_amount, 'recorded', b.recorded,
                                        'closed_at', b.closed_at) ORDER BY b.closed_at)
      INTO v_pending, v_first, v_last, v_list
      FROM (SELECT o.order_no, o.invoice_no, o.paid_amount, o.closed_at,
                   (SELECT COALESCE(sum(p.amount), 0) FROM pos_order_payments p WHERE p.order_id = o.id) AS recorded
              FROM pos_orders o
             WHERE o.shift_id = OLD.id AND o.client_id = OLD.client_id
               AND o.status = 'billed' AND o.close_type = 'paid' AND o.payment_method = 'Split'
               AND o.closed_at >= now() - interval '11 minutes') b
     WHERE b.recorded < COALESCE(b.paid_amount, 0) - 0.01;
    IF v_pending > 0 THEN
      v_what := CASE WHEN v_pending = 1
                     THEN 'a Split bill closed on this shift at '
                          || to_char(v_last AT TIME ZONE 'Asia/Kathmandu', 'FMHH12:MI AM')
                          || ' is still recording how it was paid'
                     ELSE v_pending || ' Split bills closed on this shift since '
                          || to_char(v_first AT TIME ZONE 'Asia/Kathmandu', 'FMHH12:MI AM')
                          || ' are still recording how they were paid' END;
      RAISE EXCEPTION 'pos_shift_split_pending: %, so the shift was not closed — press Close Shift again in a minute. Payments that never arrive stop holding the shift at %',
        v_what, to_char((v_last + interval '11 minutes') AT TIME ZONE 'Asia/Kathmandu', 'FMHH12:MI AM')
        USING ERRCODE = 'P0001', HINT = 'pos_shift_split_pending', DETAIL = v_list::text;
    END IF;
    -- ── end S823 5c ────────────────────────────────────────────────────────────────────────

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


-- ── 3. A settled credit bill's cash goes in the drawer once ───────────────────────────────────
-- Built plainly (not CONCURRENTLY: the table holds 9 rows, and a migration runs in one transaction).
CREATE UNIQUE INDEX IF NOT EXISTS pos_cash_movements_one_credit_settlement
  ON public.pos_cash_movements (order_id)
  WHERE kind = 'credit_settlement' AND order_id IS NOT NULL;


-- ── 4. Prove it ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client uuid;
  v_owner  uuid;
  v_recipe uuid;
  v_live   uuid;
  v_shift  uuid;
  v_id     uuid;
  v_ids    uuid[] := '{}';
  v_row    record;
  v_n      bigint;
  v_hint   text;
  v_msg    text;
  v_con    text;
  i        integer;
BEGIN
  -- Catalog: both guards still INVOKER with their triggers attached and enabled; the index is
  -- unique, partial, and leads on order_id.
  IF (SELECT count(*) FROM pg_proc WHERE NOT prosecdef AND oid IN (
        'public.guard_pos_order_close()'::regprocedure, 'public.pos_shifts_guard()'::regprocedure)) <> 2 THEN
    RAISE EXCEPTION 'S823 5c: a replaced guard changed its SECURITY';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O'
     AND ((tgrelid = 'public.pos_orders'::regclass AND tgname = 'guard_pos_order_close')
       OR (tgrelid = 'public.pos_shifts'::regclass AND tgname = 'pos_shifts_guard'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S823 5c: % of the 2 guard triggers are attached and enabled', v_n;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_index x
         JOIN pg_class c ON c.oid = x.indexrelid
         JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = x.indkey[0]
        WHERE c.relname = 'pos_cash_movements_one_credit_settlement'
          AND x.indrelid = 'public.pos_cash_movements'::regclass
          AND x.indisunique AND x.indisvalid AND x.indnatts = 1 AND a.attname = 'order_id'
          AND pg_get_expr(x.indpred, x.indrelid) LIKE '%credit_settlement%') THEN
    RAISE EXCEPTION 'S823 5c: pos_cash_movements_one_credit_settlement is not a valid unique partial index on order_id';
  END IF;

  -- ── Who acts: BLOOM CAFE (or the first POS outlet with an Owner and a settings row) ──────────
  SELECT c.id, p.id INTO v_client, v_owner
    FROM public.clients c JOIN public.profiles p ON p.client_id = c.id
   WHERE c.pos_enabled AND COALESCE(p.active_client_id, p.client_id) = c.id
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL
     AND p.ims_role IS NULL AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name, p.id LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S823 5c probe: no POS outlet with an Owner and a settings row';
  END IF;

  BEGIN
    -- Setup, as the migration's own role (every guard lets it through). The outlet's open shift is
    -- set aside, so the first void meets none; a test dish; seven open takeaway orders with one
    -- NPR 100 line each, at items_version 3.
    SELECT s.id INTO v_live FROM public.pos_shifts s WHERE s.client_id = v_client AND s.status = 'open';
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE id = v_live;
    INSERT INTO public.recipes (client_id, name) VALUES (v_client, 'S823 5c probe dish') RETURNING id INTO v_recipe;
    FOR i IN 1..7 LOOP
      INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_id;
      INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price)
        VALUES (v_id, v_client, 'S823 5c probe dish', v_recipe, 1, 100);
      v_ids := v_ids || v_id;
    END LOOP;
    UPDATE public.pos_orders SET items_version = 3 WHERE id = ANY (v_ids);

    -- From here on, the Owner's own session, on a till of this release (so a raised build floor,
    -- step 2, does not refuse a re-run of this file).
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;

    -- (a) A void with no shift open, naming the shift set aside and an old version: voided, filed
    --     on no shift, its version unchanged.
    UPDATE public.pos_orders
       SET status = 'voided', close_type = 'void', close_reason = 'S823 5c probe',
           shift_id = v_live, items_version = 1
     WHERE id = v_ids[1];
    SELECT status, shift_id, items_version INTO v_row FROM public.pos_orders WHERE id = v_ids[1];
    IF v_row.status IS DISTINCT FROM 'voided' OR v_row.shift_id IS NOT NULL OR v_row.items_version <> 3 THEN
      RAISE EXCEPTION 'S823 5c probe: a void with no shift open stored status %, shift %, version %', v_row.status, v_row.shift_id, v_row.items_version;
    END IF;

    -- A shift opens (as the migration's role, which the guard lets through).
    RESET ROLE;
    INSERT INTO public.pos_shifts (client_id, label, status, opening_cash, opening_denominations, opened_by)
      VALUES (v_client, 'S823 5c probe', 'open', 0, '{}'::jsonb, v_owner) RETURNING id INTO v_shift;
    SET LOCAL ROLE authenticated;

    -- (b) A void naming another shift is filed on the one open now.
    UPDATE public.pos_orders
       SET status = 'voided', close_type = 'void', close_reason = 'S823 5c probe', shift_id = v_live
     WHERE id = v_ids[2];
    SELECT shift_id INTO v_row FROM public.pos_orders WHERE id = v_ids[2];
    IF v_row.shift_id IS DISTINCT FROM v_shift THEN
      RAISE EXCEPTION 'S823 5c probe: a void with a shift open was filed on % (the open one is %)', v_row.shift_id, v_shift;
    END IF;

    -- (c) A Charge priced at an older version is refused, and the order stays open.
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_orders
         SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 113, items_version = 2
       WHERE id = v_ids[3];
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_bill_lines_changed'
       OR (SELECT status FROM public.pos_orders WHERE id = v_ids[3]) IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'S823 5c probe: a Charge priced at an older version answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (d) The same Charge at the stored version closes, on the open shift.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 113, items_version = 3
     WHERE id = v_ids[3];
    SELECT status, shift_id, invoice_no INTO v_row FROM public.pos_orders WHERE id = v_ids[3];
    IF v_row.status IS DISTINCT FROM 'billed' OR v_row.shift_id IS DISTINCT FROM v_shift OR v_row.invoice_no IS NULL THEN
      RAISE EXCEPTION 'S823 5c probe: a Charge at the stored version stored status %, shift %, invoice %', v_row.status, v_row.shift_id, v_row.invoice_no;
    END IF;

    -- (e) A Charge that sends no version (a till older than crest-v438) closes as before.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 113
     WHERE id = v_ids[4];
    IF (SELECT status FROM public.pos_orders WHERE id = v_ids[4]) IS DISTINCT FROM 'billed' THEN
      RAISE EXCEPTION 'S823 5c probe: a Charge sending no version did not close';
    END IF;

    -- (f) A Credit bill settles at the server's time, whatever time the tablet sent.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Credit', paid_amount = 113, items_version = 3
     WHERE id = v_ids[5];
    UPDATE public.pos_orders
       SET credit_settled_at = '2020-01-01T00:00:00Z', credit_settled_method = 'Cash', credit_settled_by = NULL
     WHERE id = v_ids[5];
    SELECT credit_settled_at, credit_settled_by INTO v_row FROM public.pos_orders WHERE id = v_ids[5];
    IF v_row.credit_settled_at IS DISTINCT FROM now() OR v_row.credit_settled_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S823 5c probe: a settlement stored time % by % (expected % by %)', v_row.credit_settled_at, v_row.credit_settled_by, now(), v_owner;
    END IF;

    -- (g) Its Cash In goes on the drawer once: a second entry with a new id is a duplicate key.
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, order_id)
      VALUES (v_client, v_shift, 'in', 'credit_settlement', 113, 'S823 5c probe', v_ids[5]);
    v_con := NULL; v_msg := NULL;
    BEGIN
      INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, order_id)
        VALUES (v_client, v_shift, 'in', 'credit_settlement', 113, 'S823 5c probe, again', v_ids[5]);
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME, v_msg = MESSAGE_TEXT;
    END;
    IF v_con IS DISTINCT FROM 'pos_cash_movements_one_credit_settlement' THEN
      RAISE EXCEPTION 'S823 5c probe: a second settlement entry for one bill answered % (%)', COALESCE(v_con, 'nothing'), v_msg;
    END IF;

    -- (h) Two Split bills with no payment lines yet: one closed now, one 12 minutes ago (backdated
    --     as the migration's role). Close Shift waits for the first only.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Split', paid_amount = 113, items_version = 3
     WHERE id = ANY (ARRAY[v_ids[6], v_ids[7]]);
    RESET ROLE;
    UPDATE public.pos_orders SET closed_at = now() - interval '12 minutes' WHERE id = v_ids[7];
    SET LOCAL ROLE authenticated;
    v_hint := NULL; v_msg := NULL;
    BEGIN
      UPDATE public.pos_shifts SET status = 'closed', closing_cash = 0, closing_denominations = '{}'::jsonb
       WHERE id = v_shift;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_shift_split_pending' OR v_msg NOT LIKE '%a Split bill closed on this shift at %'
       OR (SELECT status FROM public.pos_shifts WHERE id = v_shift) IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'S823 5c probe: Close Shift with a Split bill''s payments pending answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (i) Its payment lines arrive (from the login that closed it, inside the window), and Close
    --     Shift goes through; the older short Split bill no longer holds it.
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_ids[6], v_client, 'Cash', 63), (v_ids[6], v_client, 'Card', 50);
    UPDATE public.pos_shifts SET status = 'closed', closing_cash = 0, closing_denominations = '{}'::jsonb
     WHERE id = v_shift;
    SELECT status, closed_at, closed_by INTO v_row FROM public.pos_shifts WHERE id = v_shift;
    IF v_row.status IS DISTINCT FROM 'closed' OR v_row.closed_at IS DISTINCT FROM now() OR v_row.closed_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S823 5c probe: Close Shift after the payments arrived stored status %, at %, by %', v_row.status, v_row.closed_at, v_row.closed_by;
    END IF;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's823_5c_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's823_5c_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 5. What this slice acts on, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT count(*) FROM public.pos_orders WHERE status = 'open') AS open_bills,
  (SELECT count(*) FROM public.pos_shifts WHERE status = 'open') AS open_shifts,
  (SELECT count(*) FROM public.pos_cash_movements WHERE kind = 'credit_settlement') AS settlement_entries,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure) AS close_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_shifts_guard()'::regprocedure) AS shifts_md5,
  (SELECT pg_get_indexdef('public.pos_cash_movements_one_credit_settlement'::regclass)) AS settlement_index;

-- Read back after applying (one statement per call):
--   SELECT p.proname, md5(prosrc), prosecdef FROM pg_proc p
--    WHERE p.oid IN ('public.guard_pos_order_close()'::regprocedure, 'public.pos_shifts_guard()'::regprocedure);
--     expect the second hash of each in section 0, prosecdef f / f.
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgname IN ('guard_pos_order_close', 'pos_shifts_guard') AND NOT tgisinternal;   -- both O
--   SELECT pg_get_indexdef('public.pos_cash_movements_one_credit_settlement'::regclass);
