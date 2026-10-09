-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1c: a bill closes one of three ways, and a printed document's counters and
-- Inventory mark only move forward.
--
--   CHECKOUT-2 (P1). The Allow Void check in guard_pos_order_close tested close_type = 'void' and
--   nothing else, and pos_orders had no rule pairing status with close_type. So a supervisor with no
--   Allow Void could PATCH {"status":"voided"} with no close type and void a paid bill; and
--   {"status":"billed"} with no close type closed it as billed. Either way the bill left every money
--   report, because Sales Report, Covers, the Z-report, the POS Dashboard and Exceptions all classify
--   a closed bill by close_type alone. Closed two ways:
--     (1) the guard refuses any close that is not billed + paid, billed + writeoff or voided + void
--         (HINT pos_close_mismatch), and tests Allow Void on the status as well as the close type;
--     (2) the CHECK pos_orders_status_close_type_check holds the same three pairs (and open + no
--         close type) for every writer, including the inserts the guard does not see: the
--         operator's restore and anything running as the service role.
--
--   CHECKOUT-8 (P2). print_count, comp_print_count and ims_posted_at stay writable on a closed bill
--   (the till writes them after the close), with no direction and, for the mark, no rank. Any login,
--   a Staff PIN included, could set print_count back to 0, so the next reprint came out as a second
--   unmarked original, or set ims_posted_at on a bill that never reached Inventory, so its revenue
--   never got there. Now:
--     (3) the print counters only go up. A lower value is ignored, not refused: the till writes
--         count + 1 from the row it last read and does not wait for the answer (S776), so a till a
--         reprint behind must not be told its print failed. A CHECK keeps both counters at 0 or
--         more, because an order can be INSERTED with any count (guard_pos_order_insert's cheap test
--         does not look at it) and a negative one makes every print up to 1 an unmarked original;
--     (4) ims_posted_at is set only on a closed bill, only by POS Supervisor and above (the people
--         who close bills, which is when the till sets it; the Owner and the operator from Periods),
--         and once set it stands: a later write keeps the first mark instead of failing a batch.
--
--   CREDIT-NOTES-6 (P3). The same two columns on a Credit Note, the only ones its guard lets change:
--     (5) print_count only goes up, with a CHECK at 0 or more; ims_posted_at is set once, by a POS
--         manager (who issues notes), the Owner or the operator, and then stands.
--
-- Built on the LIVE bodies (pg_get_functiondef, read 2026-10-09):
--   guard_pos_order_close()  md5(prosrc) 065499d73ace6e4fd1bcf97445a83743
--   guard_pos_credit_note()  md5(prosrc) 6d8474f9ddd8bf0de59d6eff4fcae42b
-- Every change inside them is a block marked "S809 1c"; everything else is the live text. Slice 1b
-- adds a statement trigger on pos_orders and leaves both bodies alone. Slice 1l changes
-- guard_pos_credit_note's INSERT branch, not the UPDATE branch changed here.
--
-- Live before this migration (2026-10-09): 41 bills, all at BLOOM CAFE: 32 billed + paid,
-- 1 billed + writeoff, 7 voided + void, 1 open + no close type. So 0 rows break the new pair CHECK.
-- print_count runs 0..1 with no NULL and none negative, comp_print_count is 0 on every bill, and the
-- one Credit Note has print_count >= 0: 0 rows break the counter CHECKs. 0 open orders carry an
-- Inventory mark. Adding the CHECKs takes a brief lock on pos_orders and pos_credit_notes.
--
-- The probe at the end runs as real logins of BLOOM CAFE (a POS PIN login made to stand in for each
-- rank, the Owner, the operator) inside a block that rolls itself back. If any check fails, the
-- whole migration fails and nothing here lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Refuse to run over a body that changed since this was drafted ──────────────────────
--
-- CREATE OR REPLACE would silently revert another change to either guard. The second hash of each
-- pair is the body this migration writes, so a re-run passes.
DO $$
BEGIN
  IF COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure)
       NOT IN ('065499d73ace6e4fd1bcf97445a83743', 'eb62af47b2203fb2dde7556748b1453a'), true)
  OR COALESCE((SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure)
       NOT IN ('6d8474f9ddd8bf0de59d6eff4fcae42b', 'cfd440874663c690990ba6ea65c832f8'), true) THEN
    RAISE EXCEPTION 'S809 1c: guard_pos_order_close or guard_pos_credit_note changed since this migration was drafted. Re-read the live body and merge the S809 1c blocks into it; do not just update the hash.';
  END IF;
END;
$$;


-- ── 1. A closed bill is one of three pairs, and no counter is negative ────────────────────
--
-- COALESCE(…, false) because a CHECK passes on NULL: without it, billed with no close type is
-- NULL, not false, and goes through — the very row CHECKOUT-2 is about.
ALTER TABLE public.pos_orders DROP CONSTRAINT IF EXISTS pos_orders_status_close_type_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_status_close_type_check CHECK (COALESCE(
     (status = 'open'   AND close_type IS NULL)
  OR (status = 'billed' AND close_type IN ('paid', 'writeoff'))
  OR (status = 'voided' AND close_type = 'void'), false));

-- print_count is nullable on pos_orders, and the till reads NULL as 0, so NULL stays allowed.
ALTER TABLE public.pos_orders DROP CONSTRAINT IF EXISTS pos_orders_print_counts_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_print_counts_check
  CHECK ((print_count IS NULL OR print_count >= 0) AND comp_print_count >= 0);

ALTER TABLE public.pos_credit_notes DROP CONSTRAINT IF EXISTS pos_credit_notes_print_count_check;
ALTER TABLE public.pos_credit_notes ADD CONSTRAINT pos_credit_notes_print_count_check
  CHECK (print_count >= 0);


-- ── 2. guard_pos_order_close ──────────────────────────────────────────────────────────────
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


-- ── 3. guard_pos_credit_note ──────────────────────────────────────────────────────────────
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
  IF COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

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


-- ── 4. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_pin    uuid;    -- a POS PIN login, made to stand in for each rank in turn
  v_c      uuid;    -- its outlet
  v_owner  uuid;
  v_admin  uuid;
  v_o1     uuid;
  v_o2     uuid;
  v_o3     uuid;
  v_o4     uuid;
  v_o5     uuid;
  v_r_paid uuid;
  v_note   uuid;
  v_off    uuid := gen_random_uuid();
  v_pair   record;
  v_i      int;
  v_n      int;
  v_m      int;
  v_ts     timestamptz;
  v_by     uuid;
  v_hint   text;
  v_msg    text;
  v_t0     timestamptz := now() - interval '1 hour';
BEGIN
  -- Catalog: the three CHECKs exist and were validated against the live rows; both guards are
  -- enabled on their tables. Asserted on catalog columns, not on formatted text.
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE contype = 'c' AND convalidated
     AND ((conrelid = 'public.pos_orders'::regclass
           AND conname IN ('pos_orders_status_close_type_check', 'pos_orders_print_counts_check'))
       OR (conrelid = 'public.pos_credit_notes'::regclass AND conname = 'pos_credit_notes_print_count_check'));
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 1c: expected 3 validated CHECKs, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O'
     AND ((tgrelid = 'public.pos_orders'::regclass AND tgname = 'guard_pos_order_close'
           AND tgfoid = 'public.guard_pos_order_close()'::regprocedure)
       OR (tgrelid = 'public.pos_credit_notes'::regclass AND tgname = 'guard_pos_credit_note'
           AND tgfoid = 'public.guard_pos_credit_note()'::regprocedure));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1c: expected both guard triggers enabled, found %', v_n;
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
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY id LIMIT 1;
  IF v_pin IS NULL OR v_owner IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 1c probe: needs a POS PIN login, its outlet''s Owner and an operator (got %, %, %)', v_pin, v_owner, v_admin;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is ever set before this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- Setup, as the migration's own role. The stand-in loses every other staff marker, or a
    -- restrictive policy would turn an "allowed" into a vacuous 0 rows (the S792 lesson).
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_pin;
    -- Takeaway orders (no table). order_no is given, so the probe takes no lock on the outlet's
    -- real order-number series.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no)
      VALUES (v_c, 'open', 'S809 1c probe 1', 990001) RETURNING id INTO v_o1;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no)
      VALUES (v_c, 'open', 'S809 1c probe 2', 990002) RETURNING id INTO v_o2;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no)
      VALUES (v_c, 'open', 'S809 1c probe 3', 990003) RETURNING id INTO v_o3;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no)
      VALUES (v_c, 'open', 'S809 1c probe 4', 990004) RETURNING id INTO v_o4;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no)
      VALUES (v_c, 'open', 'S809 1c probe 5', 990005) RETURNING id INTO v_o5;

    -- ── (a) The operator's restore: closed bills of all three kinds go in as they were, a
    --        billed bill with no close type does not, and the credit-note link still lands ──────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 1c probe: % is not the operator', v_admin;
    END IF;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, print_count)
      VALUES (v_c, 'billed', 'paid', 'Cash', 100, 'S809 1c restore', 990011, v_t0, 1) RETURNING id INTO v_r_paid;
    INSERT INTO public.pos_orders (client_id, status, close_type, paid_amount, close_reason, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'writeoff', 0, 'probe', 'S809 1c restore', 990012, v_t0),
             (v_c, 'voided', 'void', NULL, 'probe', 'S809 1c restore', 990013, v_t0);
    BEGIN
      INSERT INTO public.pos_orders (client_id, status, table_name, order_no, closed_at)
        VALUES (v_c, 'billed', 'S809 1c restore', 990014, v_t0);
      RAISE EXCEPTION 'S809 1c probe: a billed bill with no close type was restored';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, credit_note_no, original_invoice_no,
                                         original_invoice_label, original_invoice_date_bs, reason)
      VALUES (v_c, v_r_paid, 'S809-1c', 990001, 990011, 'S809 1c probe', '2083-06-23', 'S809 1c probe')
      RETURNING id INTO v_note;
    UPDATE public.pos_orders SET credit_note_id = v_note WHERE id = v_r_paid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'S809 1c probe: the restore''s credit-note link matched no bill';
    END IF;

    -- ── (b) A POS supervisor without Allow Void ───────────────────────────────────────────
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_client_owner(), false) OR COALESCE(public.is_admin(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 1c probe: the stand-in % is not a plain POS supervisor', v_pin;
    END IF;

    -- CHECKOUT-2: a status with no close type, or one that disagrees with it, is refused.
    FOR v_pair IN
      SELECT * FROM (VALUES ('voided', NULL::text), ('billed', NULL), ('billed', 'void'),
                            ('voided', 'paid'), ('voided', 'writeoff')) AS x(st, ct)
    LOOP
      BEGIN
        UPDATE public.pos_orders SET status = v_pair.st, close_type = v_pair.ct WHERE id = v_o1;
        RAISE EXCEPTION 'S809 1c probe: a close as % with close type % was accepted', v_pair.st, COALESCE(v_pair.ct, 'none');
      EXCEPTION WHEN invalid_parameter_value THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
        IF v_hint IS DISTINCT FROM 'pos_close_mismatch' THEN
          RAISE EXCEPTION 'S809 1c probe: a close as % with close type % was refused with hint %', v_pair.st, COALESCE(v_pair.ct, 'none'), v_hint;
        END IF;
      END;
    END LOOP;

    -- A real void still needs Allow Void.
    BEGIN
      UPDATE public.pos_orders SET status = 'voided', close_type = 'void', close_reason = 'probe' WHERE id = v_o1;
      RAISE EXCEPTION 'S809 1c probe: a void without Allow Void was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE '%not permitted to void%' THEN
        RAISE EXCEPTION 'S809 1c probe: the void was refused for another reason: %', v_msg;
      END IF;
    END;

    -- Controls: a paid close and a Complimentary close still pass, stamped with the closer.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 100
     WHERE id = v_o2 RETURNING closed_by INTO v_by;
    IF NOT FOUND OR v_by IS DISTINCT FROM v_pin THEN
      RAISE EXCEPTION 'S809 1c probe: a paid close by a supervisor did not land as theirs (closed_by %)', v_by;
    END IF;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'writeoff', paid_amount = 0, close_reason = 'probe'
     WHERE id = v_o3;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'S809 1c probe: a Complimentary close by a supervisor did not land';
    END IF;

    -- CHECKOUT-8: the reprint counters go up for the rank that reprints.
    UPDATE public.pos_orders SET print_count = 1 WHERE id = v_o2 RETURNING print_count INTO v_i;
    IF v_i IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'S809 1c probe: the first print count is %', v_i; END IF;
    UPDATE public.pos_orders SET print_count = 2 WHERE id = v_o2 RETURNING print_count INTO v_i;
    IF v_i IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'S809 1c probe: a reprint count is %', v_i; END IF;
    UPDATE public.pos_orders SET comp_print_count = 1 WHERE id = v_o2 RETURNING comp_print_count INTO v_i;
    IF v_i IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'S809 1c probe: a comp-slip print count is %', v_i; END IF;

    -- CHECKOUT-8: the supervisor who closed it marks it posted; a second mark or a clear keeps it.
    UPDATE public.pos_orders SET ims_posted_at = v_t0 WHERE id = v_o2 RETURNING ims_posted_at INTO v_ts;
    IF v_ts IS DISTINCT FROM v_t0 THEN RAISE EXCEPTION 'S809 1c probe: the posting mark did not land (%)', v_ts; END IF;
    UPDATE public.pos_orders SET ims_posted_at = now() WHERE id = v_o2 RETURNING ims_posted_at INTO v_ts;
    IF v_ts IS DISTINCT FROM v_t0 THEN RAISE EXCEPTION 'S809 1c probe: a second posting mark replaced the first (%)', v_ts; END IF;

    -- CHECKOUT-8: an open order cannot be marked posted.
    BEGIN
      UPDATE public.pos_orders SET ims_posted_at = now() WHERE id = v_o4;
      RAISE EXCEPTION 'S809 1c probe: an open order was marked posted';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'order_not_closed' THEN
        RAISE EXCEPTION 'S809 1c probe: marking an open order was refused with hint %', v_hint;
      END IF;
    END;

    -- CREDIT-NOTES-6: below manager, a note cannot be marked posted; its print count still moves up.
    BEGIN
      UPDATE public.pos_credit_notes SET ims_posted_at = now() WHERE id = v_note;
      RAISE EXCEPTION 'S809 1c probe: a supervisor marked a Credit Note posted';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 1c probe: a supervisor''s note mark was refused with hint %', v_hint;
      END IF;
    END;
    UPDATE public.pos_credit_notes SET print_count = 1 WHERE id = v_note RETURNING print_count INTO v_i;
    IF v_i IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'S809 1c probe: a note print count is %', v_i; END IF;

    -- ── (c) A Staff-rank PIN login ───────────────────────────────────────────────────────
    RESET ROLE;
    UPDATE public.profiles SET pos_role = 'staff' WHERE id = v_pin;
    SET LOCAL ROLE authenticated;
    IF public.pos_caller_has_rank('supervisor') OR NOT public.pos_caller_has_rank('staff') THEN
      RAISE EXCEPTION 'S809 1c probe: the stand-in % is not a plain POS staff login', v_pin;
    END IF;

    -- A close still needs Supervisor (S754, unchanged).
    BEGIN
      UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 50 WHERE id = v_o4;
      RAISE EXCEPTION 'S809 1c probe: a Staff login closed a bill';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 1c probe: a Staff close was refused with hint %', v_hint;
      END IF;
    END;

    -- CHECKOUT-8: lowering or clearing a closed bill's counters changes nothing, and is not an error.
    UPDATE public.pos_orders SET print_count = 0, comp_print_count = 0 WHERE id = v_o2
      RETURNING print_count, comp_print_count INTO v_i, v_m;
    IF NOT FOUND OR v_i IS DISTINCT FROM 2 OR v_m IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'S809 1c probe: a Staff login lowered the counters to % / %', v_i, v_m;
    END IF;
    UPDATE public.pos_orders SET print_count = NULL WHERE id = v_o2 RETURNING print_count INTO v_i;
    IF v_i IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'S809 1c probe: a NULL print count landed as %', v_i; END IF;

    -- CHECKOUT-8: below Supervisor a bill cannot be marked posted, and a clear keeps the mark.
    BEGIN
      UPDATE public.pos_orders SET ims_posted_at = now() WHERE id = v_o3;
      RAISE EXCEPTION 'S809 1c probe: a Staff login marked a bill posted';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 1c probe: a Staff posting mark was refused with hint %', v_hint;
      END IF;
    END;
    UPDATE public.pos_orders SET ims_posted_at = NULL WHERE id = v_o2 RETURNING ims_posted_at INTO v_ts;
    IF v_ts IS DISTINCT FROM v_t0 THEN RAISE EXCEPTION 'S809 1c probe: a Staff login cleared the posting mark (%)', v_ts; END IF;

    -- The rest of a closed bill is still locked (S754, unchanged).
    BEGIN
      UPDATE public.pos_orders SET buyer_pan = '123456789' WHERE id = v_o2;
      RAISE EXCEPTION 'S809 1c probe: a closed bill''s buyer PAN was changed';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'bill_locked' THEN
        RAISE EXCEPTION 'S809 1c probe: the closed-bill lock answered with hint %', v_hint;
      END IF;
    END;

    -- CHECKOUT-8: a negative count cannot be planted on a new order, nor pushed onto an open one.
    BEGIN
      INSERT INTO public.pos_orders (client_id, status, table_name, order_no, print_count)
        VALUES (v_c, 'open', 'S809 1c probe', 990021, -5);
      RAISE EXCEPTION 'S809 1c probe: an order was opened with a negative print count';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    UPDATE public.pos_orders SET print_count = -1, comp_print_count = -1 WHERE id = v_o4
      RETURNING print_count, comp_print_count INTO v_i, v_m;
    IF NOT FOUND OR v_i IS DISTINCT FROM 0 OR v_m IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 1c probe: an open order''s counters went to % / %', v_i, v_m;
    END IF;

    -- The offline queue's replay (PosOrders.jsx flush): the upsert of an order made offline, its
    -- retry, and the covers update. order_no is given only to keep the probe off the real series.
    FOR v_n IN 1..2 LOOP
      INSERT INTO public.pos_orders (id, client_id, table_id, table_name, status, covers, opened_by, order_no)
        VALUES (v_off, v_c, NULL, 'S809 1c offline', 'open', 2, v_pin, 990031)
        ON CONFLICT (id) DO UPDATE
          SET client_id = EXCLUDED.client_id, table_id = EXCLUDED.table_id, table_name = EXCLUDED.table_name,
              status = EXCLUDED.status, covers = EXCLUDED.covers, opened_by = EXCLUDED.opened_by;
    END LOOP;
    UPDATE public.pos_orders SET covers = 3 WHERE id = v_off AND status = 'open';
    IF NOT FOUND THEN RAISE EXCEPTION 'S809 1c probe: the offline replay did not leave an open order'; END IF;

    -- CREDIT-NOTES-6: a note's print count does not go down either.
    UPDATE public.pos_credit_notes SET print_count = 0 WHERE id = v_note RETURNING print_count INTO v_i;
    IF NOT FOUND OR v_i IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'S809 1c probe: a Staff login lowered a note''s print count to %', v_i;
    END IF;

    -- ── (d) A POS manager ────────────────────────────────────────────────────────────────
    RESET ROLE;
    UPDATE public.profiles SET pos_role = 'manager' WHERE id = v_pin;
    SET LOCAL ROLE authenticated;
    IF NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 1c probe: the stand-in % is not a POS manager', v_pin;
    END IF;
    UPDATE public.pos_credit_notes SET print_count = 2 WHERE id = v_note RETURNING print_count INTO v_i;
    IF v_i IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'S809 1c probe: a manager''s note reprint count is %', v_i; END IF;
    UPDATE public.pos_credit_notes SET ims_posted_at = v_t0 WHERE id = v_note RETURNING ims_posted_at INTO v_ts;
    IF v_ts IS DISTINCT FROM v_t0 THEN RAISE EXCEPTION 'S809 1c probe: a manager''s note mark did not land (%)', v_ts; END IF;
    UPDATE public.pos_credit_notes SET ims_posted_at = NULL WHERE id = v_note RETURNING ims_posted_at INTO v_ts;
    IF v_ts IS DISTINCT FROM v_t0 THEN RAISE EXCEPTION 'S809 1c probe: a note''s posting mark was cleared (%)', v_ts; END IF;
    BEGIN
      UPDATE public.pos_credit_notes SET reason = 'changed' WHERE id = v_note;
      RAISE EXCEPTION 'S809 1c probe: an issued note''s reason was changed';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'bill_locked' THEN
        RAISE EXCEPTION 'S809 1c probe: the note lock answered with hint %', v_hint;
      END IF;
    END;

    -- ── (e) A supervisor WITH Allow Void voids, and marks the void settled ─────────────────
    RESET ROLE;
    UPDATE public.profiles SET pos_role = 'supervisor', pos_allow_void = true WHERE id = v_pin;
    SET LOCAL ROLE authenticated;
    UPDATE public.pos_orders SET status = 'voided', close_type = 'void', close_reason = 'probe'
     WHERE id = v_o4 RETURNING closed_by INTO v_by;
    IF NOT FOUND OR v_by IS DISTINCT FROM v_pin THEN
      RAISE EXCEPTION 'S809 1c probe: a void with Allow Void did not land as theirs (closed_by %)', v_by;
    END IF;
    UPDATE public.pos_orders SET ims_posted_at = v_t0 WHERE id = v_o4 RETURNING ims_posted_at INTO v_ts;
    IF v_ts IS DISTINCT FROM v_t0 THEN RAISE EXCEPTION 'S809 1c probe: the void''s settled mark did not land (%)', v_ts; END IF;

    -- ── (f) The Owner: exempt from Allow Void, not from the pairs ────────────────────────
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1c probe: % is not an Owner login', v_owner;
    END IF;
    BEGIN
      UPDATE public.pos_orders SET status = 'voided' WHERE id = v_o5;
      RAISE EXCEPTION 'S809 1c probe: the Owner closed a bill as voided with no close type';
    EXCEPTION WHEN invalid_parameter_value THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_close_mismatch' THEN
        RAISE EXCEPTION 'S809 1c probe: the Owner''s mismatched close was refused with hint %', v_hint;
      END IF;
    END;
    UPDATE public.pos_orders SET status = 'voided', close_type = 'void', close_reason = 'probe'
     WHERE id = v_o5 RETURNING closed_by INTO v_by;
    IF NOT FOUND OR v_by IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S809 1c probe: the Owner''s void did not land as theirs (closed_by %)', v_by;
    END IF;
    UPDATE public.pos_orders SET print_count = 3 WHERE id = v_o2 RETURNING print_count INTO v_i;
    IF v_i IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'S809 1c probe: the Owner''s reprint count is %', v_i; END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1c_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1c_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

-- Read back after applying (one statement per call):
--   SELECT conname, convalidated, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('pos_orders_status_close_type_check', 'pos_orders_print_counts_check', 'pos_credit_notes_print_count_check');
--   SELECT proname, md5(prosrc), proacl FROM pg_proc
--    WHERE proname IN ('guard_pos_order_close', 'guard_pos_credit_note') AND pronamespace = 'public'::regnamespace;
--     expect guard_pos_order_close eb62af47b2203fb2dde7556748b1453a, guard_pos_credit_note
--     cfd440874663c690990ba6ea65c832f8, and proacl {postgres=X/postgres} on both, as before.
--   SELECT status, close_type, count(*) FROM public.pos_orders GROUP BY 1, 2 ORDER BY 1, 2;
