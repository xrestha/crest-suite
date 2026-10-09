-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 2, slice 2c: a bill keeps the tax status it was issued under.
--
--   CHECKOUT-6 (P2), REPORTS-1 (P2), CREDIT-NOTES-5 (P3). A POS bill stored only its number and
--   year. Whether it was a TAX INVOICE (TI, VAT charged) or a plain BILL (PB) was read from
--   settings.is_vat_registered every time it was printed or counted, so once an outlet changed its
--   VAT registration every past bill changed with it:
--     * a reprint or View of TI880 (1,000 + 130 VAT, paid 1,130) after a deregistration read
--       PB880, Net Amount 1,000.00, "One Thousand only", the change worked out on 1,000;
--     * Sales Report, Covers and the 1L+ (Annexure 13) tab recomputed past Tax Invoices with no
--       VAT: past months lost their VAT, a party that crossed one lakh dropped below it, and a bill
--       no longer cancelled against its own Credit Note on Daily;
--     * a Credit Note referenced its bill as TI or PB by today's setting (stored for good in
--       original_invoice_label), and a VAT note reprinted after a deregistration lost its VAT lines
--       while its Net still included the VAT.
--   A bill's lines already freeze their VAT rate (save_pos_order_items stores 0 on every new line of
--   an unregistered outlet), but not the bill's type: a registered outlet's zero-rated dishes and a
--   PAN bill look the same from the lines.
--
--   The fix, one column the server owns:
--     1. pos_orders.vat_registered (boolean, NULL = no stamp).
--     2. guard_pos_order_close stamps it at the close (open -> billed or voided) from the outlet's
--        setting at that instant, read the way save_pos_order_items and the till read it (a missing
--        row or a NULL flag is registered, the column default). It is NULL on every write to an
--        open order and cannot be changed on a closed bill: a value a request sends is overwritten
--        or ignored on every path, never refused. A Charge that names the status its total was
--        worked out under (tills from this release) and names the other one is refused
--        (HINT pos_vat_status_changed): that till read its settings before the Owner switched VAT
--        registration, and would print one kind of bill under the other kind's stamp. Tills on
--        crest-v416..v419 send no status and are stamped, never refused.
--     3. guard_pos_order_insert drops a status sent with a new open order. The operator's restore
--        (an admin INSERT of a closed bill) keeps the status its backup carries; a backup from
--        before this migration carries none.
--     4. Every closed bill already stored is stamped with today's setting (section 4). Live there
--        are none (below), so this does nothing today; it is written for the apply moment, when the
--        owner may have rung up test bills. It stops for a person to decide if a bill's own lines
--        say VAT was charged while today's setting says PAN.
--   The app then reads each bill's stamp, and today's setting only where there is none (an open
--   order, or a bill restored from an older backup): the bill print and View (posOrderPrintHtml.js,
--   viewPosBill.js), Sales Report (salesReportMath.js and its 1L+ tab), Covers, Sales Exceptions'
--   TI/PB labels, Customers' Outstanding Credit labels, the Credit Note modal (its figures, its stored
--   TI/PB reference and its print) and the Credit Note Book's reprint.
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-09). Section 0 refuses to
-- run over any other body. Every change inside them is a block marked "S809 2c".
--   guard_pos_order_close()   5a50b8bc5ea06f2102e6440e16173e1d  (slice 2b's, 20261009190000)
--   guard_pos_order_insert()  0d4d89f3d71cb21cbc8eaa6d949a5693  (S754's, 20260916100000)
-- Both stay SECURITY INVOKER with search_path public and proacl {postgres=X/postgres}; CREATE OR
-- REPLACE keeps the grants. No signature changes. guard_pos_credit_note (slice 2e's) is not touched:
-- a note reads its bill's stamp at issue and at print, in the app.
--
-- Live before this migration (2026-10-09):
--   * pos_orders: 0 rows at any client (BLOOM CAFE cleared by the owner, and the deleted client's
--     leftover order is gone); pos_credit_notes: 0; pos_order_items: 0. So the backfill stamps 0
--     bills, 0 bills would stop it, and 0 unnumbered bills are left alone.
--   * POS outlets: BLOOM CAFE and BLOOM CAFE - PKR, both is_vat_registered = false, both with a
--     settings row (settings.client_id is UNIQUE). No outlet with POS bills has ever changed its VAT
--     status (the S809 review), so today's setting is the one each stored bill was issued under.
--   * settings.is_vat_registered is nullable with DEFAULT true.
-- No constraint is added. The only rows written are section 4's (0 today).
--
-- Ship order: this migration BEFORE the app. The app selects pos_orders.vat_registered and the till
-- sends it on a close; before the column exists those reads fail (42703) and the close is refused.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN supervisor, its Owner and the operator inside a
-- block that rolls itself back. If any check fails, the whole migration fails and nothing lands.
-- Drafted against a local Postgres 17 copy of the live tables, policies, grants, triggers and bodies
-- these paths touch (bs_months included): the file runs clean, and again over itself; each of ten
-- one-line reversals of a fix fails the probe; with PAN bills, a void and an open order already
-- stored, section 4 stamps the three closed ones PAN, leaves the open one and renumbers nothing; and
-- a bill with VAT lines at an outlet now set to PAN stops it.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
--
-- CREATE OR REPLACE would silently revert another change to either of them (slice 2g rebuilds
-- guard_pos_order_close after this one). The second hash of each pair is the body this migration
-- writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '5a50b8bc5ea06f2102e6440e16173e1d' AND v_md5 IS DISTINCT FROM '4d5725cfb7600e3f5fa16c16db1e81b8' THEN
    RAISE EXCEPTION 'S809 2c: guard_pos_order_close changed since this slice was drafted (live md5 %) — merge section 2 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_insert()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '0d4d89f3d71cb21cbc8eaa6d949a5693' AND v_md5 IS DISTINCT FROM '555ea55be0f69a7ef19a1ce6b06b8e99' THEN
    RAISE EXCEPTION 'S809 2c: guard_pos_order_insert changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. The column ─────────────────────────────────────────────────────────────────────────────
-- Nullable with no default: adding it rewrites nothing, and NULL means "no stamp" (an open order,
-- or a bill restored from a backup older than this). Table-level grants cover it; pos_orders' RLS
-- policies and log_audit need nothing (the stamp changes only at the close, a transition the audit
-- already records). Not in guard_pos_order_close's closed-bill allow-list: section 2 keeps it.
ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS vat_registered boolean;

COMMENT ON COLUMN public.pos_orders.vat_registered IS
  'S809 2c: whether the outlet was VAT-registered when this bill closed (TAX INVOICE with VAT, or a plain PAN BILL). Stamped by guard_pos_order_close from settings.is_vat_registered at the close; NULL while the order is open and on a bill restored from a backup older than 2c. Reprints, reports and Credit Notes read it instead of today''s setting.';


-- ── 2. guard_pos_order_close ──────────────────────────────────────────────────────────────────
-- The live body (slice 2b's) with three S809 2c blocks: the closed-bill lock keeps the stamp, an
-- open-order write clears it, and the close stamps it (refusing a Charge whose total assumed the
-- other status).
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


-- ── 3. guard_pos_order_insert ─────────────────────────────────────────────────────────────────
-- The live body (S754's) with two S809 2c lines: an order opens with no tax status, and the
-- operator's restore of a closed bill keeps the status its backup carries.
CREATE OR REPLACE FUNCTION public.guard_pos_order_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- Cheap test first: the ordinary insert pays no identity lookup.
  IF NEW.status = 'open'
     AND NEW.close_type IS NULL AND NEW.invoice_no IS NULL AND NEW.closed_at IS NULL
     AND NEW.closed_by IS NULL AND NEW.paid_amount IS NULL AND NEW.payment_method IS NULL
     AND NEW.discount_amount IS NULL AND NEW.credit_note_id IS NULL
     AND NEW.credit_settled_at IS NULL AND NEW.commission_amount IS NULL THEN
    -- S809 2c: an order opens with no tax status; guard_pos_order_close stamps the bill's own at
    -- the close. A value sent here is dropped, not refused.
    NEW.vat_registered := NULL;
    RETURN NEW;
  END IF;

  IF COALESCE(public.is_admin(), false) THEN
    -- S809 2c: the operator's restore brings a closed bill back with the status its backup carries
    -- (none from a backup older than 2c, and the screens then read today's setting). An order that
    -- is still open carries none.
    IF NEW.status = 'open' THEN
      NEW.vat_registered := NULL;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_orders: an order is opened empty and closed from the Payment screen — it cannot be created already closed'
    USING ERRCODE = '42501', HINT = 'order_not_open';
END;
$function$;


-- ── 4. Bills already closed: stamped with today's setting ────────────────────────────────────
-- Live 2026-10-09 there is no bill at all, so this writes nothing. At the apply moment it stamps
-- any bill rung up since with its outlet's setting, which is the one it was issued under: no
-- outlet with POS bills has changed its VAT status. Two cases are not guessed:
--   * a bill whose own lines carry VAT (vat_rate > 0 on a charged line) at an outlet whose
--     setting now says PAN was charged while the outlet was registered (save_pos_order_items
--     stores 0 on every new line of an unregistered outlet). Stamping it PAN would be the very
--     error this slice removes, so the migration stops and names how many;
--   * a billed bill with a year and no number. assign_pos_invoice_no numbers such a row on ANY
--     update, so the backfill leaves it alone (its stamp stays NULL and the screens read today's
--     setting for it) rather than number it as a side effect.
-- The opposite case (a bill stamped registered whose lines are all 0 %) cannot be told apart from a
-- registered outlet's zero-rated dishes, so it is only counted. Each stamped bill writes one
-- audit_logs row (the column is not in log_audit's noise list).
DO $$
DECLARE
  v_contra  int;
  v_zero    int;
  v_skip    int;
  v_n       int;
BEGIN
  SELECT count(*) INTO v_contra
    FROM public.pos_orders o
   WHERE o.status <> 'open' AND o.vat_registered IS NULL
     AND NOT COALESCE((SELECT s.is_vat_registered FROM public.settings s WHERE s.client_id = o.client_id), true)
     AND EXISTS (SELECT 1 FROM public.pos_order_items i
                  WHERE i.order_id = o.id AND NOT COALESCE(i.comped, false) AND COALESCE(i.vat_rate, 0) > 0);
  IF v_contra > 0 THEN
    RAISE EXCEPTION 'S809 2c: % closed bills carry VAT on their lines at an outlet whose setting now says PAN — decide their stamp by hand before applying', v_contra;
  END IF;

  SELECT count(*) INTO v_zero
    FROM public.pos_orders o
   WHERE o.status = 'billed' AND o.close_type = 'paid' AND o.vat_registered IS NULL
     AND COALESCE((SELECT s.is_vat_registered FROM public.settings s WHERE s.client_id = o.client_id), true)
     AND EXISTS (SELECT 1 FROM public.pos_order_items i WHERE i.order_id = o.id AND NOT COALESCE(i.comped, false))
     AND NOT EXISTS (SELECT 1 FROM public.pos_order_items i
                      WHERE i.order_id = o.id AND NOT COALESCE(i.comped, false) AND COALESCE(i.vat_rate, 0) > 0);
  SELECT count(*) INTO v_skip
    FROM public.pos_orders
   WHERE status = 'billed' AND invoice_no IS NULL AND invoice_fy IS NOT NULL AND vat_registered IS NULL;

  UPDATE public.pos_orders o
     SET vat_registered = COALESCE((SELECT s.is_vat_registered FROM public.settings s WHERE s.client_id = o.client_id), true)
   WHERE o.status <> 'open' AND o.vat_registered IS NULL
     AND NOT (o.status = 'billed' AND o.invoice_no IS NULL AND o.invoice_fy IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RAISE NOTICE 'S809 2c backfill: % closed bills stamped; % stamped registered with only 0 %% lines (left as stamped); % unnumbered billed bills left without a stamp',
    v_n, v_zero, v_skip;
END;
$$;


-- ── 5. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c        uuid;    -- BLOOM CAFE
  v_c2       uuid;    -- BLOOM CAFE - PKR, standing in as "another outlet"
  v_pin      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_owner    uuid;
  v_admin    uuid;
  v_s        uuid;    -- the probe's open shift at BLOOM CAFE
  v_s2       uuid;    -- an open shift at the other outlet
  v_r1       uuid := gen_random_uuid();   -- pos_order_items.recipe_id has no FK
  v_o_new    uuid;    -- opened by the supervisor with a status sent
  v_o_pan    uuid;    -- NPR 500 at 0 %, charged by a till that sends no status (crest-v416..v419)
  v_o_mis    uuid;    -- NPR 1,000 at 0 %, charged by a till that believes the outlet is registered
  v_o_vat    uuid;    -- NPR 1,000 at 13 %, charged after the Owner registers, no status sent
  v_o_vat2   uuid;    -- the same, by a till that says registered
  v_o_nc     uuid;    -- a Complimentary
  v_o_void   uuid;    -- a Void
  v_o_null   uuid;    -- charged while the outlet's flag is NULL (never set)
  v_o_pkr    uuid;    -- the other outlet's bill, charged by the operator
  v_o_old    uuid;    -- a bill closed before 2c, with no status (the backfill)
  v_o_odd    uuid;    -- a billed bill with a year and no number (the backfill leaves it)
  v_o_open   uuid;    -- an open order (the backfill leaves it)
  v_b        boolean;
  v_n        int;
  v_no       int;
  v_id       uuid;
  v_st       text;
  v_hint     text;
  v_msg      text;
  v_past     timestamptz := now() - interval '30 days';
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  SELECT count(*) INTO v_n FROM pg_attribute
   WHERE attrelid = 'public.pos_orders'::regclass AND attname = 'vat_registered' AND NOT attisdropped
     AND atttypid = 'boolean'::regtype AND NOT attnotnull AND NOT atthasdef;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 2c: pos_orders.vat_registered is missing, or is not a nullable boolean with no default';
  END IF;
  -- Both guards enabled as BEFORE row triggers (UPDATE = 19, INSERT = 7) on their functions, and
  -- both SECURITY INVOKER: they key on current_user, which a DEFINER body would always pass.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid = 'public.pos_orders'::regclass
     AND ((tgname = 'guard_pos_order_close'  AND tgtype = 19 AND tgfoid = 'public.guard_pos_order_close()'::regprocedure)
       OR (tgname = 'guard_pos_order_insert' AND tgtype = 7  AND tgfoid = 'public.guard_pos_order_insert()'::regprocedure));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 2c: expected the close and insert guards enabled as BEFORE row triggers on pos_orders, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.guard_pos_order_close()'::regprocedure, 'public.guard_pos_order_insert()'::regprocedure)
     AND NOT prosecdef;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 2c: a pos_orders guard became SECURITY DEFINER';
  END IF;
  -- After section 4 every closed bill has a stamp but the unnumbered ones it left, and no open
  -- order has one.
  SELECT count(*) INTO v_n FROM public.pos_orders
   WHERE status <> 'open' AND vat_registered IS NULL
     AND NOT (status = 'billed' AND invoice_no IS NULL AND invoice_fy IS NOT NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 2c: % closed bills carry no tax status after the backfill', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.pos_orders WHERE status = 'open' AND vat_registered IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 2c: % open orders carry a tax status', v_n;
  END IF;

  -- ── The logins: BLOOM CAFE's POS PIN login (its supervisor where there is one), its Owner, the
  -- operator; BLOOM CAFE - PKR as another outlet (the same selection as slice 2b's probe) ──────
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
    RAISE EXCEPTION 'S809 2c probe: needs BLOOM CAFE, BLOOM CAFE - PKR, a POS PIN login and the Owner of BLOOM CAFE, and the operator (got %, %, %, %, %)',
      v_c, v_c2, v_pin, v_owner, v_admin;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- The stand-in loses every other staff marker, or a restrictive policy would turn an "allowed"
    -- into a vacuous 0 rows (the S792 lesson). Both outlets give PAN bills for the length of the
    -- probe, whatever they are set to now; (e) to (i) switch BLOOM CAFE's as its Owner would.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_pin;
    UPDATE public.settings SET is_vat_registered = false WHERE client_id IN (v_c, v_c2);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 2c probe: expected a settings row for each of the two outlets, found %', v_n;
    END IF;
    -- One open shift per outlet: the outlet's own (none since the owner's clear) closes for the
    -- probe; the other outlet's is used if it has one.
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S809 2c probe', 0, '{}') RETURNING id INTO v_s;
    SELECT id INTO v_s2 FROM public.pos_shifts WHERE client_id = v_c2 AND status = 'open';
    IF v_s2 IS NULL THEN
      INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
        VALUES (v_c2, 'open', 'S809 2c probe other outlet', 0, '{}') RETURNING id INTO v_s2;
    END IF;

    -- Takeaway orders. order_no is given, so the probe takes no lock on the outlets' real series.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990501) RETURNING id INTO v_o_pan;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990502) RETURNING id INTO v_o_mis;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990503) RETURNING id INTO v_o_vat;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990504) RETURNING id INTO v_o_vat2;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990505) RETURNING id INTO v_o_nc;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990506) RETURNING id INTO v_o_void;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990507) RETURNING id INTO v_o_null;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c2, 'open', 'S809 2c probe', 990508) RETURNING id INTO v_o_pkr;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c,  'open', 'S809 2c probe', 990509) RETURNING id INTO v_o_open;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      VALUES (v_o_pan,  v_c,  v_r1, 'S809 2c probe dish', 1,  500, 0),
             (v_o_mis,  v_c,  v_r1, 'S809 2c probe dish', 1, 1000, 0),
             (v_o_vat,  v_c,  v_r1, 'S809 2c probe dish', 1, 1000, 0.13),
             (v_o_vat2, v_c,  v_r1, 'S809 2c probe dish', 1, 1000, 0.13),
             (v_o_nc,   v_c,  v_r1, 'S809 2c probe dish', 1,  200, 0),
             (v_o_void, v_c,  v_r1, 'S809 2c probe dish', 1,  300, 0),
             (v_o_null, v_c,  v_r1, 'S809 2c probe dish', 1,  400, 0.13),
             (v_o_pkr,  v_c2, v_r1, 'S809 2c probe dish', 1, 1000, 0),
             (v_o_open, v_c,  v_r1, 'S809 2c probe dish', 1,  100, 0);

    -- ── Section 4's backfill, on bills closed before 2c ─────────────────────────────────────
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, invoice_fy, invoice_no)
      VALUES (v_c, 'billed', 'paid', 'Cash', 100, 'S809 2c probe', 990510, v_past, 'S809-2c', 990510) RETURNING id INTO v_o_old;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, invoice_fy)
      VALUES (v_c, 'billed', 'paid', 'Cash', 100, 'S809 2c probe', 990511, v_past, 'S809-2c') RETURNING id INTO v_o_odd;
    -- Section 4's statement, verbatim.
    UPDATE public.pos_orders o
       SET vat_registered = COALESCE((SELECT s.is_vat_registered FROM public.settings s WHERE s.client_id = o.client_id), true)
     WHERE o.status <> 'open' AND o.vat_registered IS NULL
       AND NOT (o.status = 'billed' AND o.invoice_no IS NULL AND o.invoice_fy IS NOT NULL);
    SELECT vat_registered INTO v_b FROM public.pos_orders WHERE id = v_o_old;
    IF v_b IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S809 2c probe: the backfill stamped a PAN outlet''s old bill %', v_b;
    END IF;
    SELECT vat_registered, invoice_no INTO v_b, v_no FROM public.pos_orders WHERE id = v_o_odd;
    IF v_b IS NOT NULL OR v_no IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2c probe: the backfill stamped (%) or numbered (%) the unnumbered bill', v_b, v_no;
    END IF;
    IF (SELECT vat_registered FROM public.pos_orders WHERE id = v_o_open) IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2c probe: the backfill stamped an open order';
    END IF;

    -- ── (a) A POS supervisor ──────────────────────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 2c probe: the stand-in % is not a plain POS supervisor', v_pin;
    END IF;

    -- An order opens with no status, whatever the request sends, and keeps none while open.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, vat_registered)
      VALUES (v_c, 'open', 'S809 2c probe', 990512, true) RETURNING id, vat_registered INTO v_o_new, v_b;
    IF v_o_new IS NULL OR v_b IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2c probe: an order opened with a status sent stored %', v_b;
    END IF;
    UPDATE public.pos_orders SET covers = 2, vat_registered = true WHERE id = v_o_new RETURNING vat_registered INTO v_b;
    IF NOT FOUND OR v_b IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2c probe: an open order took a status from a request (%)', v_b;
    END IF;

    -- ── (b) CHECKOUT-6: a till on crest-v416..v419 sends no status, and the bill is stamped ────
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 500
     WHERE id = v_o_pan RETURNING vat_registered, shift_id INTO v_b, v_id;
    IF NOT FOUND OR v_b IS DISTINCT FROM false OR v_id IS DISTINCT FROM v_s THEN
      RAISE EXCEPTION 'S809 2c probe: the PAN outlet''s bill was stamped % on shift %', v_b, v_id;
    END IF;

    -- ── (c) A Charge worked out as a Tax Invoice at a PAN outlet is refused, and leaves the order
    -- open and unnumbered; charged again as a PAN bill it lands ─────────────────────────────────
    BEGIN
      UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1130, vat_registered = true
       WHERE id = v_o_mis;
      RAISE EXCEPTION 'S809 2c probe: a Charge worked out as a Tax Invoice at a PAN outlet was accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_vat_status_changed' THEN
        RAISE EXCEPTION 'S809 2c probe: a Charge under the other VAT status — expected pos_vat_status_changed, got: %', v_msg;
      END IF;
    END;
    SELECT status, vat_registered, invoice_no INTO v_st, v_b, v_no FROM public.pos_orders WHERE id = v_o_mis;
    IF v_st IS DISTINCT FROM 'open' OR v_b IS NOT NULL OR v_no IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2c probe: the refused Charge left the order %, stamped %, numbered %', v_st, v_b, v_no;
    END IF;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000, vat_registered = false
     WHERE id = v_o_mis RETURNING status, vat_registered INTO v_st, v_b;
    IF NOT FOUND OR v_st IS DISTINCT FROM 'billed' OR v_b IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S809 2c probe: the Charge as a PAN bill landed as %, stamped %', v_st, v_b;
    END IF;

    -- ── (d) A closed bill's status cannot be changed, and the write is not refused over it ─────
    UPDATE public.pos_orders SET vat_registered = true, print_count = 1
     WHERE id = v_o_pan RETURNING vat_registered, print_count INTO v_b, v_n;
    IF NOT FOUND OR v_b IS DISTINCT FROM false OR v_n IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'S809 2c probe: a reprint count sent with a status left the bill stamped %, print count %', v_b, v_n;
    END IF;

    -- ── (e) The Owner registers for VAT: new bills are Tax Invoices, the PAN bills stay PAN ─────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 2c probe: % is not an Owner login', v_owner;
    END IF;
    UPDATE public.settings SET is_vat_registered = true WHERE client_id = v_c RETURNING is_vat_registered INTO v_b;
    IF NOT FOUND OR v_b IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'S809 2c probe: the Owner could not register the outlet for VAT';
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Card', paid_amount = 1130
     WHERE id = v_o_vat RETURNING vat_registered INTO v_b;
    IF NOT FOUND OR v_b IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'S809 2c probe: a bill after the registration was stamped %', v_b;
    END IF;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1130, vat_registered = true
     WHERE id = v_o_vat2 RETURNING vat_registered INTO v_b;
    IF NOT FOUND OR v_b IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'S809 2c probe: a Charge that named the right status was stamped %', v_b;
    END IF;
    IF (SELECT vat_registered FROM public.pos_orders WHERE id = v_o_pan) IS DISTINCT FROM false
       OR (SELECT vat_registered FROM public.pos_orders WHERE id = v_o_mis) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S809 2c probe: a PAN bill changed type when the outlet registered';
    END IF;

    -- ── (f) The Owner deregisters: the Tax Invoices stay Tax Invoices ──────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.settings SET is_vat_registered = false WHERE client_id = v_c;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    IF (SELECT vat_registered FROM public.pos_orders WHERE id = v_o_vat) IS DISTINCT FROM true
       OR (SELECT vat_registered FROM public.pos_orders WHERE id = v_o_vat2) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'S809 2c probe: a Tax Invoice changed type when the outlet deregistered';
    END IF;

    -- ── (g) A Complimentary charges nothing: a status sent is not checked, and the stamp is the
    -- setting's ──────────────────────────────────────────────────────────────────────────────
    UPDATE public.pos_orders SET status = 'billed', close_type = 'writeoff', paid_amount = 0, close_reason = 'probe', vat_registered = true
     WHERE id = v_o_nc RETURNING vat_registered INTO v_b;
    IF NOT FOUND OR v_b IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S809 2c probe: the Complimentary was stamped %', v_b;
    END IF;

    -- ── (h) Nor a Void (the Owner, who needs no Allow Void) ────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.pos_orders SET status = 'voided', close_type = 'void', close_reason = 'probe', vat_registered = true
     WHERE id = v_o_void RETURNING vat_registered INTO v_b;
    IF NOT FOUND OR v_b IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'S809 2c probe: the Void was stamped %', v_b;
    END IF;

    -- ── (i) A flag never set counts as registered, as the till and save_pos_order_items read it ──
    UPDATE public.settings SET is_vat_registered = NULL WHERE client_id = v_c;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 452
     WHERE id = v_o_null RETURNING vat_registered INTO v_b;
    IF NOT FOUND OR v_b IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'S809 2c probe: a bill under a never-set flag was stamped % (want registered)', v_b;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.settings SET is_vat_registered = false WHERE client_id = v_c;

    -- ── (j) The stamp is the bill's own outlet's, not the caller's: the operator (whose own
    -- outlet, if any, is not the other outlet) charges the other outlet's bill, a PAN bill ────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 2c probe: % is not the operator', v_admin;
    END IF;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id = v_o_pkr RETURNING vat_registered, shift_id INTO v_b, v_id;
    IF NOT FOUND OR v_b IS DISTINCT FROM false OR v_id IS DISTINCT FROM v_s2 THEN
      RAISE EXCEPTION 'S809 2c probe: the other outlet''s bill was stamped % on shift % (want its own outlet''s PAN bill)', v_b, v_id;
    END IF;

    -- ── (k) The operator's restore keeps a closed bill's status, or none; an open order has none ──
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, invoice_fy, invoice_no, vat_registered)
      VALUES (v_c, 'billed', 'paid', 'Cash', 1130, 'S809 2c restored', 990513, v_past, 'S809-2c', 990513, true)
      RETURNING vat_registered INTO v_b;
    IF v_b IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'S809 2c probe: a restored Tax Invoice came back stamped %', v_b;
    END IF;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, invoice_fy, invoice_no)
      VALUES (v_c, 'billed', 'paid', 'Cash', 500, 'S809 2c restored', 990514, v_past, 'S809-2c', 990514)
      RETURNING vat_registered INTO v_b;
    IF v_b IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2c probe: a bill restored from an older backup came back stamped %', v_b;
    END IF;
    -- An open order carrying a discount, as a backup can: past the cheap test, into the operator's
    -- branch.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, discount_amount, vat_registered)
      VALUES (v_c, 'open', 'S809 2c restored', 990515, 50, true)
      RETURNING vat_registered INTO v_b;
    IF v_b IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2c probe: an order restored open came back stamped %', v_b;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2c_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_2c_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, provolatile, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace AND proname IN ('guard_pos_order_close', 'guard_pos_order_insert');
--     expect guard_pos_order_close 4d5725cfb7600e3f5fa16c16db1e81b8, guard_pos_order_insert 555ea55be0f69a7ef19a1ce6b06b8e99;
--     prosecdef false, provolatile 'v', proacl {postgres=X/postgres} on both.
--   SELECT attname, format_type(atttypid, atttypmod), attnotnull, atthasdef FROM pg_attribute
--    WHERE attrelid = 'public.pos_orders'::regclass AND attname = 'vat_registered';      -- boolean, f, f
--   SELECT tgname, tgtype, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.pos_orders'::regclass AND tgname IN ('guard_pos_order_close', 'guard_pos_order_insert');   -- 19 O / 7 O
--   SELECT count(*) FROM public.pos_orders WHERE status <> 'open' AND vat_registered IS NULL;   -- 0 (0 bills on 2026-10-09)
--   SELECT count(*) FROM public.pos_orders WHERE status = 'open' AND vat_registered IS NOT NULL;  -- 0
--   SELECT client_id, vat_registered, count(*) FROM public.pos_orders WHERE status <> 'open' GROUP BY 1, 2;
--     every outlet's bills on one value, its setting (BLOOM CAFE: false)
