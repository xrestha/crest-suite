-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S754 — POS money path: a printed bill is locked, a bill line is priced by the menu, closing and
-- its side-effects are ranked and attributed server-side, loyalty is earned and spent only at the
-- close, and a credit note hands loyalty back.
--
-- OWNER DECISIONS this file implements (Aashish, S754):
--   * A printed (billed / voided) bill is locked for EVERYONE, Owner and operator included.
--     Corrections go through a credit note. The operator's backup restore must keep working.
--   * A bill line's price comes from the menu (recipes.selling_price), never from the tablet; only a
--     POS manager, an IMS manager, the Owner or the operator may change a menu price or pos_enabled.
--   * Two tablets on one order: warn and reload (optimistic version on the order's lines).
--   * The server enforces the same rank rules the screens show.
--   * Loyalty: points are earned and spent only while the bill is being closed, only by the person
--     closing it; a failed award cannot be retried later by staff (Owner / operator may).
--   * A credit note takes back the points a bill earned and returns the points it spent.
--
-- THE SEAM, unchanged from 20260810120000 / 20260819120000: every guard below is SECURITY INVOKER
-- and keys on current_user. 'anon' / 'authenticated' is a browser session and is GUARDED;
-- 'service_role' (admin-user-ops, Danger Zone) and the owner of a SECURITY DEFINER body pass. So
-- apply_pos_item_comps, redeem_loyalty_points and award_loyalty_points — all DEFINER — are not
-- stopped by the row guards, and each re-checks what it bypasses inside its own body (S753 rule).
-- Measured live before writing (rolled back): a foreign-key cascade (ON DELETE CASCADE / SET NULL)
-- runs as the TABLE OWNER, so deleting a profile or a shift that a billed order names is not
-- refused by the lock — Postgres, not the browser, is making that write.
--
-- WHAT THE OPERATOR'S RESTORE DOES (restoreClientData.js, as `authenticated` with role 'admin'):
-- INSERTs pos_orders already billed, then pos_order_items / pos_order_payments into those billed
-- orders, then pos_loyalty_ledger, then pos_credit_notes, then UPDATEs pos_orders.credit_note_id on
-- billed orders. Every guard below lets exactly those four writes through for an admin and nothing
-- else past the lock.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Rank helpers ─────────────────────────────────────────────────────────────────────────
-- One place for "does the caller hold at least this POS rank", so the guards below cannot each
-- carry their own copy. Admin and the Owner resolve to manager on every axis, exactly as
-- AuthContext.hasPosAccess does; the Owner test is is_client_owner(), not a fourth copy of it.
-- COALESCE on every operand: is_admin() / is_client_owner() return NULL for a profile-less
-- session, and pos_role is NULL for every account with no POS access (S579 / S630).
CREATE OR REPLACE FUNCTION public.pos_caller_has_rank(p_min text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(public.is_client_owner(), false)
      OR COALESCE((
           SELECT CASE p_min
                    WHEN 'staff'      THEN p.pos_role IN ('staff', 'supervisor', 'manager')
                    WHEN 'supervisor' THEN p.pos_role IN ('supervisor', 'manager')
                    WHEN 'manager'    THEN p.pos_role = 'manager'
                    ELSE false
                  END
             FROM profiles p
            WHERE p.id = (SELECT auth.uid())
         ), false)
$fn$;

-- Who may put a price on the menu or take a dish on/off it. Menu Pricing is gated on IMS manager
-- for a client with IMS and on POS manager for a POS-only client (MenuPricing.js / Layout.js), so
-- either manager rank qualifies here, plus the Owner and the operator.
CREATE OR REPLACE FUNCTION public.caller_can_set_menu_price()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(public.is_client_owner(), false)
      OR COALESCE((
           SELECT p.pos_role = 'manager' OR p.ims_role = 'manager'
             FROM profiles p
            WHERE p.id = (SELECT auth.uid())
         ), false)
$fn$;

-- Called from INVOKER triggers running as `authenticated`, so authenticated needs EXECUTE. They
-- report only the caller's own rank.
REVOKE ALL     ON FUNCTION public.pos_caller_has_rank(text)       FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.pos_caller_has_rank(text)       TO authenticated, service_role;
REVOKE ALL     ON FUNCTION public.caller_can_set_menu_price()     FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.caller_can_set_menu_price()     TO authenticated, service_role;


-- ── 1. New columns ──────────────────────────────────────────────────────────────────────────
-- items_version: bumped by save_pos_order_items on every save. A tablet that sends the version it
-- loaded is refused ('stale_order') when another tablet has saved since.
ALTER TABLE public.pos_orders      ADD COLUMN IF NOT EXISTS items_version integer NOT NULL DEFAULT 0;

-- sent_qty: how much of a line the kitchen/bar already has. The frontend has carried it in memory
-- since S754 (the "+2" badge) but it was never stored, so a reload lost it and the KOT-removal diff
-- could only see the all-or-nothing sent_to_kot flag.
ALTER TABLE public.pos_order_items ADD COLUMN IF NOT EXISTS sent_qty integer NOT NULL DEFAULT 0;

-- credit_note_id on the loyalty ledger: the idempotency key of reverse_loyalty_for_credit_note().
-- Deliberately NO foreign key: restoreClientData.js inserts pos_loyalty_ledger BEFORE
-- pos_credit_notes, and a FK here would refuse the first chunk carrying a reversal row — and the
-- restore loop drops a whole table on its first failing chunk, i.e. every customer's balance.
ALTER TABLE public.pos_loyalty_ledger ADD COLUMN IF NOT EXISTS credit_note_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS pos_loyalty_ledger_one_reversal_per_note
  ON public.pos_loyalty_ledger (credit_note_id, customer_id, (points > 0))
  WHERE credit_note_id IS NOT NULL;


-- ── 2. One open order per table ─────────────────────────────────────────────────────────────
-- Live on 2026-09-14 (S754): zero (client_id, table_id) pairs with more than one open order, so
-- this builds. If it ever fails on another database, clean up first — see the report for the query;
-- never auto-delete an order here.
CREATE UNIQUE INDEX IF NOT EXISTS pos_orders_one_open_per_table
  ON public.pos_orders (client_id, table_id)
  WHERE status = 'open' AND table_id IS NOT NULL;


-- ── 3. pos_orders: the close guard, now also the closed-bill lock ───────────────────────────
-- Based on the live body of guard_pos_order_close (20260819120000, unchanged since; verified with
-- pg_get_functiondef on 2026-09-14). The void and discount-cap checks are kept byte-for-byte.
--
-- THE ALLOW-LIST — every column any code path writes on a billed/voided order, found by grepping
-- every .update/scopedUpdate on pos_orders in src/ and every SQL function body that touches it:
--   ims_posted_at                     PosOrders.closeOrder (both branches), backfillPosToIms ×3
--   print_count, comp_print_count     printBill, printCompSlip, printItemCompSlip (reprints)
--   credit_note_id                    IssueCreditNoteModal (POS manager); restore second pass (admin)
--   credit_settled_at / _by / _method,
--   commission_amount                 PosCustomers.settleBill (POS supervisor page)
-- Nothing edits buyer name / PAN / phone after the close: the one buyer write outside the close
-- payload (closeOrder, before a redemption) happens while the order is still open. No SQL function
-- updates pos_orders at all.
-- An allow-list, not a deny-list, for invariant #1's reason: the next column added is locked.
CREATE OR REPLACE FUNCTION public.guard_pos_order_close()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
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

  -- ── Unchanged from 20260819120000 below this line ──────────────────────────────────────────
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

  IF NEW.close_type = 'void' AND COALESCE(v_allow_void, false) = false THEN
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
$$;
-- Trigger guard_pos_order_close (BEFORE UPDATE) already exists and points at this function.


-- An order is created open. A browser INSERT arriving already billed skipped the close guard and
-- the invoice trigger entirely (both are BEFORE UPDATE). performSave and the offline replay insert
-- only table / covers / opened_by with status 'open'; the operator's restore inserts closed orders
-- and is let through.
CREATE OR REPLACE FUNCTION public.guard_pos_order_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
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
    RETURN NEW;
  END IF;

  IF COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_orders: an order is opened empty and closed from the Payment screen — it cannot be created already closed'
    USING ERRCODE = '42501', HINT = 'order_not_open';
END;
$$;

DROP TRIGGER IF EXISTS guard_pos_order_insert ON public.pos_orders;
CREATE TRIGGER guard_pos_order_insert
  BEFORE INSERT ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_order_insert();

-- Nobody deletes a closed bill. Clear Occupied deletes open orders only (it selects status 'open');
-- Danger Zone runs as the service role.
CREATE OR REPLACE FUNCTION public.guard_pos_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND OLD.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'pos_orders: a closed bill cannot be deleted — issue a Credit Note to reverse it'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_pos_order_delete ON public.pos_orders;
CREATE TRIGGER guard_pos_order_delete
  BEFORE DELETE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_order_delete();

REVOKE ALL ON FUNCTION public.guard_pos_order_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_pos_order_delete() FROM PUBLIC;


-- ── 4. pos_order_items: lines of a closed bill are locked; a line's price is not the tablet's ─
-- Every write to these lines, enumerated:
--   save_pos_order_items (INVOKER)          open orders only — refuses otherwise, see §6
--   sent_to_kot flag UPDATEs (saveOrder,
--     sendTicket)                           open orders, after a save
--   apply_pos_item_comps (DEFINER)          before the close; not reached by these guards, so the
--                                           RPC now checks the order is open itself (§9)
--   Clear Occupied DELETE                   open orders only
--   restore INSERT (admin)                  into billed orders — let through
-- Nothing writes a line after the close. Statement-level, so a 20-line save pays one lookup per
-- statement rather than one per row.
CREATE OR REPLACE FUNCTION public.guard_pos_order_items_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_hit boolean;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NULL;
  END IF;

  -- LEFT JOIN: a parent this session cannot see reads as "not open" and is refused, never passed.
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM new_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
    -- The operator's restore inserts the lines of closed bills.
    IF v_hit AND COALESCE(public.is_admin(), false) THEN
      v_hit := false;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (SELECT 1 FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open')
        OR EXISTS (SELECT 1 FROM new_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
  ELSE
    SELECT EXISTS (SELECT 1 FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
  END IF;

  IF v_hit THEN
    RAISE EXCEPTION 'pos_order_items: this bill is closed and printed, so its lines can no longer be changed — issue a Credit Note to correct it'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS guard_pos_order_items_closed_ins ON public.pos_order_items;
DROP TRIGGER IF EXISTS guard_pos_order_items_closed_upd ON public.pos_order_items;
DROP TRIGGER IF EXISTS guard_pos_order_items_closed_del ON public.pos_order_items;
CREATE TRIGGER guard_pos_order_items_closed_ins AFTER INSERT ON public.pos_order_items
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_order_items_closed();
CREATE TRIGGER guard_pos_order_items_closed_upd AFTER UPDATE ON public.pos_order_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_order_items_closed();
CREATE TRIGGER guard_pos_order_items_closed_del AFTER DELETE ON public.pos_order_items
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_order_items_closed();

-- Price, quantity and identity of a line are written by save_pos_order_items and nothing else from
-- a browser. Without this a single POST /rest/v1/pos_order_items with unit_price 1 walked past the
-- menu price the RPC applies. save_pos_order_items marks its own transaction with a local setting
-- (set_config(..., true)); a PostgREST table request is its own transaction and cannot carry it.
-- The KOT flag (sent_to_kot, sent_qty) and notes stay directly writable — the send path needs them.
CREATE OR REPLACE FUNCTION public.guard_pos_item_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.unit_price IS NOT DISTINCT FROM OLD.unit_price
     AND NEW.vat_rate   IS NOT DISTINCT FROM OLD.vat_rate
     AND NEW.qty        IS NOT DISTINCT FROM OLD.qty
     AND NEW.recipe_id  IS NOT DISTINCT FROM OLD.recipe_id
     AND NEW.order_id   IS NOT DISTINCT FROM OLD.order_id
     AND NEW.client_id  IS NOT DISTINCT FROM OLD.client_id
     AND NEW.name       IS NOT DISTINCT FROM OLD.name
     AND NEW.category   IS NOT DISTINCT FROM OLD.category THEN
    RETURN NEW;
  END IF;

  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- The operator's restore inserts historical lines as they were billed.
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_order_items: order lines are saved through the order screen, which prices them from the menu — they cannot be written directly'
    USING ERRCODE = '42501', HINT = 'line_not_on_menu';
END;
$$;

DROP TRIGGER IF EXISTS guard_pos_item_price ON public.pos_order_items;
CREATE TRIGGER guard_pos_item_price
  BEFORE INSERT OR UPDATE ON public.pos_order_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_item_price();

REVOKE ALL ON FUNCTION public.guard_pos_order_items_closed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_pos_item_price()        FROM PUBLIC;


-- ── 5. pos_order_payments: legs of a closed bill are locked, with one exception ──────────────
-- Every write, enumerated:
--   redeem_loyalty_points (DEFINER)     the Loyalty leg, before the close — not reached here
--   closeOrder split legs (INSERT)      AFTER the bill is billed (warnWrite path in PosOrders.jsx)
--   restore INSERT (admin)              legs of closed bills
-- Nothing UPDATEs or DELETEs a leg (PosShifts reads them; the "re-enter it from Shifts" warning in
-- PosOrders has no write path behind it).
--
-- The split legs cannot move before the close without a frontend change, so the database admits
-- them on a closed bill in the narrowest shape that matches what closeOrder actually does: a
-- 'Split' bill, inserted by the session that closed it, within 10 minutes of the server-stamped
-- closed_at, never a Loyalty leg (those only come from the RPC), and never taking the recorded legs
-- past the bill's own paid_amount — which also stops a replayed insert doubling the breakdown.
-- (paid_amount is compared, never re-derived: no second copy of the VAT arithmetic.)
-- That shape is the ONLY browser insert admitted, open orders included: nothing in the app inserts a
-- leg before the close (the Loyalty leg comes from the RPC), and a stray leg on an open order would
-- both inflate the Z-report and push the real legs past paid_amount.
CREATE OR REPLACE FUNCTION public.guard_pos_order_payments_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_hit boolean;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
        FROM (SELECT DISTINCT order_id FROM new_rows) r
        LEFT JOIN pos_orders o ON o.id = r.order_id
       WHERE NOT COALESCE(
               o.status = 'billed'
           AND o.payment_method = 'Split'
           AND o.closed_by = (SELECT auth.uid())
           AND o.closed_at >= now() - interval '10 minutes'
           AND NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.order_id = r.order_id AND n.payment_method = 'Loyalty')
           AND (SELECT COALESCE(SUM(p.amount), 0) FROM pos_order_payments p WHERE p.order_id = r.order_id)
                 <= COALESCE(o.paid_amount, 0) + 0.5
         , false)
    ) INTO v_hit;
    IF v_hit AND COALESCE(public.is_admin(), false) THEN
      v_hit := false;   -- the operator's restore
    END IF;
    IF v_hit THEN
      RAISE EXCEPTION 'pos_order_payments: payment lines are recorded by the Payment screen as the bill closes, by whoever closed it — they cannot be added afterwards or by hand'
        USING ERRCODE = '42501', HINT = 'bill_locked';
    END IF;
    RETURN NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    SELECT EXISTS (SELECT 1 FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open')
        OR EXISTS (SELECT 1 FROM new_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
  ELSE
    SELECT EXISTS (SELECT 1 FROM old_rows r LEFT JOIN pos_orders o ON o.id = r.order_id
                    WHERE o.status IS DISTINCT FROM 'open') INTO v_hit;
  END IF;

  IF v_hit THEN
    RAISE EXCEPTION 'pos_order_payments: this bill is closed, so how it was paid can no longer be changed'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS guard_pos_order_payments_closed_ins ON public.pos_order_payments;
DROP TRIGGER IF EXISTS guard_pos_order_payments_closed_upd ON public.pos_order_payments;
DROP TRIGGER IF EXISTS guard_pos_order_payments_closed_del ON public.pos_order_payments;
CREATE TRIGGER guard_pos_order_payments_closed_ins AFTER INSERT ON public.pos_order_payments
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_order_payments_closed();
CREATE TRIGGER guard_pos_order_payments_closed_upd AFTER UPDATE ON public.pos_order_payments
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_order_payments_closed();
CREATE TRIGGER guard_pos_order_payments_closed_del AFTER DELETE ON public.pos_order_payments
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_order_payments_closed();

REVOKE ALL ON FUNCTION public.guard_pos_order_payments_closed() FROM PUBLIC;


-- ── 6. save_pos_order_items: open orders only, menu prices, optimistic version, sent_qty ─────
-- Based on the live body (20260819130000; pg_get_functiondef identical on 2026-09-14).
--
-- PRICE. A line that already exists on the order keeps the price (and VAT rate, name, category) it
-- was saved with — a menu change mid-meal does not reprice food already ordered. A NEW line takes
-- recipes.selling_price, and VAT the way addItem() computes it: settings.is_vat_registered
-- (default true, as PosOrders loads it) ? COALESCE(recipes.vat_rate, 0.13) : 0. The incoming
-- unit_price / vat_rate / name / category are ignored.
--
-- A NEW line must be a dish the till menu would offer: same client, is_active, pos_enabled, not a
-- Sub-Recipe (PosOrders.loadMenu's own filter). Without that, a request naming an off-menu recipe
-- would bill at a price no manager put on the menu. Every line needs a recipe_id — every add path
-- (menu tap, guest request, offline cache) carries one, and live has zero lines without.
--
-- VERSION. p_expected_version NULL keeps the old behaviour, so a stale bundle still saves. The
-- order row is taken FOR UPDATE first, so two saves queue and the version check is true when it is
-- applied. Returns jsonb {inserted, items_version, items} — every caller today ignores `data`.
--
-- The 3-arg signature is DROPPED, per the S577 precedent: PostgREST binds by argument name, so a
-- 3-key call from a stale bundle resolves to this function through p_expected_version's default;
-- keeping both would make that call ambiguous ("function is not unique").
DROP FUNCTION IF EXISTS public.save_pos_order_items(uuid, jsonb, text);

CREATE OR REPLACE FUNCTION public.save_pos_order_items(
  p_order_id          uuid,
  p_rows              jsonb,
  p_removal_reason    text    DEFAULT NULL,
  p_expected_version  integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_client_id uuid;
  v_status    text;
  v_version   integer;
  v_vat_reg   boolean;
  v_inserted  integer := 0;
  v_bad       text;
  v_items     jsonb;
  v_prev      jsonb;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'p_order_id is required';
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'p_rows must be a json array';
  END IF;

  -- client_id is derived from the order, never taken as a parameter. RLS hides another client's
  -- order, which reads as not found.
  SELECT client_id, status, items_version
    INTO v_client_id, v_status, v_version
    FROM pos_orders WHERE id = p_order_id
    FOR UPDATE;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'order not found or not visible: %', p_order_id;
  END IF;

  IF v_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'order_not_open: this bill is already closed, so its items cannot be changed — reload the floor'
      USING ERRCODE = 'P0001', HINT = 'order_not_open';
  END IF;

  IF p_expected_version IS NOT NULL AND p_expected_version IS DISTINCT FROM v_version THEN
    RAISE EXCEPTION 'stale_order: this order was changed on another device since it was opened here — reload it before saving'
      USING ERRCODE = 'P0001', HINT = 'stale_order',
            DETAIL = format('expected version %s, current version %s', p_expected_version, v_version);
  END IF;

  -- ── Validate the incoming lines ────────────────────────────────────────────────────────────
  SELECT string_agg(DISTINCT reason, '; ') INTO v_bad
    FROM (
      SELECT CASE
               WHEN NULLIF(r->>'recipe_id', '') IS NULL THEN 'a line with no menu item'
               WHEN COALESCE((r->>'qty')::integer, 1) < 1 THEN format('%s with a quantity below 1', COALESCE(r->>'name', 'a line'))
             END AS reason
        FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
    ) x
   WHERE reason IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: %', v_bad USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  -- A NEW line (a recipe not already on this order) must be on the till menu.
  SELECT string_agg(DISTINCT COALESCE(rec.name, r->>'name', r->>'recipe_id'), ', ') INTO v_bad
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
    LEFT JOIN recipes rec
           ON rec.id = (r->>'recipe_id')::uuid
          AND rec.client_id = v_client_id
   WHERE NOT EXISTS (SELECT 1 FROM pos_order_items i
                      WHERE i.order_id = p_order_id AND i.recipe_id = (r->>'recipe_id')::uuid)
     AND NOT COALESCE(rec.id IS NOT NULL
                      AND rec.is_active IS NOT FALSE
                      AND rec.pos_enabled IS NOT FALSE
                      AND rec.category IS DISTINCT FROM 'Sub-Recipe', false);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'line_not_on_menu: % is not on the menu any more — remove it from the order and save again', v_bad
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  SELECT COALESCE(is_vat_registered, true) INTO v_vat_reg FROM settings WHERE client_id = v_client_id;
  v_vat_reg := COALESCE(v_vat_reg, true);

  -- ── Record any already-fired quantity about to disappear ───────────────────────────────────
  -- The "sent" side is now the larger of the stored sent_qty and the old all-or-nothing flag, so a
  -- line topped up after a send (sent_to_kot false, sent_qty 2 of 3) still counts its 2.
  WITH before_sent AS (
    SELECT COALESCE(recipe_id::text, name) AS k,
           MIN(recipe_id::text)            AS rid,
           MIN(name)                       AS nm,
           SUM(GREATEST(COALESCE(sent_qty, 0),
                        CASE WHEN COALESCE(sent_to_kot, false) THEN qty ELSE 0 END)) AS sent_qty
      FROM pos_order_items
     WHERE order_id = p_order_id
       AND COALESCE(comped, false) = false
     GROUP BY COALESCE(recipe_id::text, name)
  ), after_all AS (
    SELECT COALESCE(NULLIF(r->>'recipe_id', ''), r->>'name') AS k,
           SUM(COALESCE((r->>'qty')::integer, 1))            AS qty
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
     GROUP BY COALESCE(NULLIF(r->>'recipe_id', ''), r->>'name')
  )
  INSERT INTO pos_kot_removals (client_id, order_id, recipe_id, item_name, qty_removed, reason, removed_by)
  SELECT v_client_id, p_order_id, b.rid::uuid, b.nm,
         (b.sent_qty - COALESCE(a.qty, 0))::integer,
         NULLIF(BTRIM(COALESCE(p_removal_reason, '')), ''),
         (SELECT auth.uid())
    FROM before_sent b
    LEFT JOIN after_all a ON a.k = b.k
   WHERE b.sent_qty - COALESCE(a.qty, 0) > 0;

  -- Prices already on the order, captured before the replacement deletes them (jsonb numbers are
  -- exact numerics, so nothing is rounded on the way through). A non-comped line wins over a comped
  -- split of the same recipe.
  SELECT COALESCE(jsonb_object_agg(s.recipe_id::text, jsonb_build_object(
           'unit_price', s.unit_price, 'vat_rate', s.vat_rate, 'name', s.name, 'category', s.category)), '{}'::jsonb)
    INTO v_prev
    FROM (
      SELECT DISTINCT ON (recipe_id) recipe_id, unit_price, vat_rate, name, category
        FROM pos_order_items
       WHERE order_id = p_order_id AND recipe_id IS NOT NULL
       ORDER BY recipe_id, COALESCE(comped, false), created_at
    ) s;

  -- This transaction's writes to pos_order_items are the RPC's own (guard_pos_item_price).
  PERFORM set_config('crest.pos_items_rpc', 'on', true);

  DELETE FROM pos_order_items WHERE order_id = p_order_id;

  IF p_rows IS NOT NULL AND jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO pos_order_items (
      order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate,
      sent_to_kot, sent_qty, notes
    )
    SELECT
      p_order_id,
      v_client_id,
      rec.id,
      COALESCE(v_prev -> rec.id::text ->> 'name', rec.name),
      COALESCE(v_prev -> rec.id::text ->> 'category', NULLIF(rec.category, ''), 'Other'),
      COALESCE((r->>'qty')::integer, 1),
      COALESCE((v_prev -> rec.id::text ->> 'unit_price')::numeric, rec.selling_price, 0),
      COALESCE((v_prev -> rec.id::text ->> 'vat_rate')::numeric,
               CASE WHEN v_vat_reg THEN COALESCE(rec.vat_rate, 0.13) ELSE 0 END),
      COALESCE((r->>'sent_to_kot')::boolean, false),
      GREATEST(COALESCE((r->>'sent_qty')::integer, 0), 0),
      NULLIF(r->>'notes', '')
    FROM jsonb_array_elements(p_rows) AS r
    JOIN recipes rec ON rec.id = (r->>'recipe_id')::uuid AND rec.client_id = v_client_id;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  PERFORM set_config('crest.pos_items_rpc', 'off', true);

  -- Every row must have landed: a recipe the JOIN could not see (RLS, another client) would
  -- otherwise vanish from the order silently.
  IF v_inserted <> COALESCE(jsonb_array_length(p_rows), 0) THEN
    RAISE EXCEPTION 'line_not_on_menu: % of % lines could not be matched to this outlet''s menu',
      COALESCE(jsonb_array_length(p_rows), 0) - v_inserted, COALESCE(jsonb_array_length(p_rows), 0)
      USING ERRCODE = 'P0001', HINT = 'line_not_on_menu';
  END IF;

  UPDATE pos_orders SET items_version = items_version + 1
   WHERE id = p_order_id
   RETURNING items_version INTO v_version;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id, 'recipe_id', i.recipe_id, 'name', i.name, 'category', i.category,
           'qty', i.qty, 'unit_price', i.unit_price, 'vat_rate', i.vat_rate,
           'sent_to_kot', i.sent_to_kot, 'sent_qty', i.sent_qty, 'notes', i.notes)
           ORDER BY i.created_at, i.id), '[]'::jsonb)
    INTO v_items
    FROM pos_order_items i WHERE i.order_id = p_order_id;

  RETURN jsonb_build_object('inserted', v_inserted, 'items_version', v_version, 'items', v_items);
END;
$$;

REVOKE ALL     ON FUNCTION public.save_pos_order_items(uuid, jsonb, text, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.save_pos_order_items(uuid, jsonb, text, integer) TO authenticated;


-- ── 7. recipes: the menu price and pos_enabled are a manager's ──────────────────────────────
-- Who writes them today: Menu Pricing (manager — IMS manager, or POS manager on a POS-only client)
-- writes selling_price, pos_enabled and inserts; Recipe Costing (Recipes.js, IMS SUPERVISOR) sends
-- selling_price and vat_rate in every insert and update payload; push_master_data is DEFINER.
--
-- UPDATE: a change to selling_price, vat_rate (the other half of a line's price) or pos_enabled
-- needs caller_can_set_menu_price(). Recipe Costing's payload re-sends the stored values, so a
-- supervisor editing yield or ingredients passes untouched; a supervisor CHANGING a price is
-- refused. vat_rate NULL and 0.13 are the same price (vatOf() reads NULL as 0.13, and Recipe Costing
-- writes 0.13 back for a NULL), so that pair is not a change.
--
-- INSERT: refusing a supervisor's new dish would break Recipe Costing's "+ New Recipe", which is a
-- supervisor screen. The row is kept, but it arrives OFF the till (pos_enabled := false) until a
-- manager puts it on from Menu Pricing, where its price is on screen. IMS reads nothing from
-- recipes.pos_enabled (only POS and the guest menu do), so an IMS-only client sees no difference.
CREATE OR REPLACE FUNCTION public.guard_recipe_menu_price()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.pos_enabled IS NOT DISTINCT FROM false THEN
      RETURN NEW;
    END IF;
    IF NOT public.caller_can_set_menu_price() THEN
      NEW.pos_enabled := false;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.selling_price IS NOT DISTINCT FROM OLD.selling_price
     AND COALESCE(NEW.vat_rate, 0.13) IS NOT DISTINCT FROM COALESCE(OLD.vat_rate, 0.13)
     AND NEW.pos_enabled IS NOT DISTINCT FROM OLD.pos_enabled THEN
    RETURN NEW;
  END IF;

  IF public.caller_can_set_menu_price() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'recipes: a menu price, its VAT rate and whether a dish is on the POS menu are set by a manager (Menu Pricing)'
    USING ERRCODE = '42501', HINT = 'rank_required';
END;
$$;

DROP TRIGGER IF EXISTS guard_recipe_menu_price ON public.recipes;
CREATE TRIGGER guard_recipe_menu_price
  BEFORE INSERT OR UPDATE ON public.recipes
  FOR EACH ROW EXECUTE FUNCTION public.guard_recipe_menu_price();

REVOKE ALL ON FUNCTION public.guard_recipe_menu_price() FROM PUBLIC;


-- ── 8. pos_credit_notes: issued by a manager, attributed by the server, never edited ─────────
-- Writes, enumerated: IssueCreditNoteModal INSERT (POS manager — the modal and CreditNotes.jsx
-- both redirect below manager); creditNotePosting ims_posted_at UPDATE ×3; creditNoteHtml
-- print_count UPDATE; restore INSERT (admin, issued_by nulled). No client DELETE anywhere.
-- Already audited: audit_pos_credit_notes (log_audit) exists live, so item 10 needed nothing.
CREATE OR REPLACE FUNCTION public.guard_pos_credit_note()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_order record;
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
  SELECT o.id, o.client_id, o.status, o.close_type, o.credit_note_id
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

  NEW.issued_by := (SELECT auth.uid());
  NEW.credit_note_no := NULL;   -- numbered by trg_assign_pos_credit_note_no, never by the request
  NEW.ims_posted_at := NULL;
  NEW.print_count := 0;
  RETURN NEW;
END;
$$;

-- Named to sort BEFORE trg_assign_pos_credit_note_no, so the number is always assigned after the
-- request's own value has been cleared.
DROP TRIGGER IF EXISTS guard_pos_credit_note ON public.pos_credit_notes;
CREATE TRIGGER guard_pos_credit_note
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_credit_note();

REVOKE ALL ON FUNCTION public.guard_pos_credit_note() FROM PUBLIC;


-- ── 9. apply_pos_item_comps: the order must still be open ───────────────────────────────────
-- DEFINER, so the §4 line lock does not reach it; the lock is re-checked here (S753 rule). Body is
-- the live one from 20260914190000 with the order read taking status too, and nothing else moved.
CREATE OR REPLACE FUNCTION public.apply_pos_item_comps(p_order_id uuid, p_client_id uuid, p_fy text, p_comp_reason text, p_comped_by uuid, p_full_recipe_ids uuid[], p_partial jsonb)
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
  v_pos_role text;
  v_comped_by uuid;
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

  SELECT pos_role INTO v_pos_role FROM profiles WHERE id = v_caller;
  IF NOT COALESCE(
    (SELECT role FROM profiles WHERE id = v_caller) = 'admin'
    OR public.is_client_owner()
    OR v_pos_role IN ('supervisor', 'manager')
  , false) THEN
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

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));

  SELECT COALESCE(MAX(n), 0) + 1 INTO v_comp_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;

  IF p_full_recipe_ids IS NOT NULL AND array_length(p_full_recipe_ids, 1) > 0 THEN
    UPDATE pos_order_items
    SET comped = true, comp_reason = p_comp_reason, comped_by = v_comped_by,
        comped_at = v_now, comp_fy = p_fy, comp_no = v_comp_no
    WHERE order_id = p_order_id AND recipe_id = ANY(p_full_recipe_ids);
  END IF;

  -- The comped split takes its price from the stored line it is split off, never from the
  -- payload (S754: a line's price is the menu's). vat_rate likewise.
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_partial, '[]'::jsonb))
  LOOP
    UPDATE pos_order_items
    SET qty = qty - (v_item->>'comp_qty')::integer
    WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid;

    INSERT INTO pos_order_items (
      order_id, client_id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, sent_qty,
      comped, comp_reason, comped_by, comped_at, comp_fy, comp_no
    )
    SELECT
      p_order_id, p_client_id, s.recipe_id, s.name, s.category,
      (v_item->>'comp_qty')::integer, s.unit_price, s.vat_rate, s.sent_to_kot,
      LEAST(s.sent_qty, (v_item->>'comp_qty')::integer),
      true, p_comp_reason, v_comped_by, v_now, p_fy, v_comp_no
    FROM (
      SELECT recipe_id, name, category, unit_price, vat_rate, sent_to_kot, sent_qty
        FROM pos_order_items
       WHERE order_id = p_order_id AND recipe_id = (v_item->>'recipe_id')::uuid
         AND COALESCE(comped, false) = false
       ORDER BY created_at
       LIMIT 1
    ) s;
  END LOOP;

  RETURN v_comp_no;
END;
$function$;


-- ── 10. get_next_pos_comp_slip_no: the caller check falls closed ─────────────────────────────
-- Live body from 20260914190000; only the IF is wrapped. is_admin() and my_client_id() are both
-- NULL for a profile-less session, and `IF NOT (NULL OR NULL)` never fires.
CREATE OR REPLACE FUNCTION public.get_next_pos_comp_slip_no(p_client_id uuid, p_fy text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  next_no integer;
BEGIN
  IF NOT COALESCE(
    public.is_admin() OR p_client_id = public.my_client_id()
  , false) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pos_comp_slip_no:' || p_client_id::text || ':' || p_fy));
  SELECT COALESCE(MAX(n), 0) + 1 INTO next_no FROM (
    SELECT invoice_no AS n FROM pos_orders WHERE client_id = p_client_id AND invoice_fy = p_fy AND close_type = 'writeoff'
    UNION ALL
    SELECT comp_no AS n FROM pos_order_items WHERE client_id = p_client_id AND comp_fy = p_fy
  ) combined;
  RETURN next_no;
END;
$function$;


-- ── 11. Loyalty: redeem while closing, award by the closer, reverse on a credit note ─────────
-- Both bodies were last defined in 20260827160000 (live identical on 2026-09-14). Their caller
-- checks compared against profiles.client_id — the HOME outlet — which S750 replaced with
-- my_client_id() everywhere else; they move to it here.

-- A redemption is "live" on an order while its redeem rows (plus the adjust rows that replaced
-- them, which carry the order but no credit_note_id) sum below zero.
CREATE OR REPLACE FUNCTION public.redeem_loyalty_points(p_order_id uuid, p_points integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_caller   uuid := (SELECT auth.uid());
  v_order    record;
  v_customer uuid;
  v_balance  integer;
  v_value    numeric;
  v_amount   numeric;
  v_gross    numeric;
  v_maxvat   numeric;
  v_prior    record;
BEGIN
  -- 0 is allowed and means "cancel this bill's redemption": the earlier one is handed back and its
  -- Loyalty leg removed, and nothing new is spent (for a cashier who undid the points tender after
  -- a failed close had already debited them).
  IF p_points IS NULL OR p_points < 0 THEN
    RAISE EXCEPTION 'Redeem a positive number of points.';
  END IF;

  -- Locked: two redemptions on one bill (a double tap, two tablets) queue.
  SELECT o.id, o.client_id, o.buyer_phone, o.status
    INTO v_order
    FROM pos_orders o WHERE o.id = p_order_id
    FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found.'; END IF;

  IF NOT COALESCE(public.is_admin() OR v_order.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'Not permitted.' USING ERRCODE = '42501';
  END IF;

  -- The redemption panel lives in the billing modal, which only Supervisor and above can open.
  IF NOT public.pos_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION 'Points are redeemed while taking payment, which needs Supervisor access or above.'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  IF v_order.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Points can only be redeemed while the bill is being closed — this bill is already closed.'
      USING ERRCODE = 'P0001', HINT = 'order_not_open';
  END IF;

  -- One live redemption per bill: an earlier one (the cashier changed the points and pressed
  -- Confirm again) is handed back first and its Loyalty leg removed, rather than stacking a second.
  -- Done before the phone is read, so a cancel still works on a bill whose phone was since cleared.
  FOR v_prior IN
    SELECT l.customer_id, -SUM(l.points)::integer AS pts
      FROM pos_loyalty_ledger l
     WHERE l.order_id = p_order_id
       AND l.credit_note_id IS NULL
       AND l.kind IN ('redeem', 'adjust')
     GROUP BY l.customer_id
    HAVING SUM(l.points) < 0
  LOOP
    INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, note, created_by)
    VALUES (v_order.client_id, v_prior.customer_id, p_order_id, 'adjust', v_prior.pts,
            'Earlier redemption on this bill replaced', v_caller);
  END LOOP;
  DELETE FROM pos_order_payments WHERE order_id = p_order_id AND payment_method = 'Loyalty';

  IF p_points = 0 THEN
    RETURN 0;
  END IF;

  IF v_order.buyer_phone IS NULL OR btrim(v_order.buyer_phone) = '' THEN
    RAISE EXCEPTION 'This bill has no customer phone, so there is no balance to redeem from.';
  END IF;

  -- The customer row is locked BEFORE the balance is read, so two bills spending one balance at the
  -- same moment cannot both pass the check.
  SELECT c.id INTO v_customer FROM pos_customers c
   WHERE c.client_id = v_order.client_id AND c.phone = v_order.buyer_phone
   FOR UPDATE;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'No customer record for that phone yet.';
  END IF;

  SELECT COALESCE(SUM(points), 0) INTO v_balance
    FROM pos_loyalty_ledger WHERE customer_id = v_customer;

  IF p_points > v_balance THEN
    RAISE EXCEPTION 'Only % point(s) available.', v_balance;
  END IF;

  SELECT COALESCE(pos_loyalty_point_value, 1) INTO v_value
    FROM settings WHERE client_id = v_order.client_id;
  v_value := COALESCE(v_value, 1);
  v_amount := round((p_points * v_value)::numeric, 2);

  -- Cap: the bill's payable total is not computable here without a second copy of the VAT-on-
  -- discounted-base and rounding arithmetic (and the discount is not even stored until the close).
  -- An UPPER BOUND is: stored non-comped lines at their highest VAT rate, plus a rupee of rounding.
  -- A discount only lowers the real total, so this never refuses a legitimate redemption; it refuses
  -- a redemption worth more than the food on the bill, which is the one that turns points into cash.
  SELECT COALESCE(SUM(qty * unit_price), 0), COALESCE(MAX(vat_rate), 0)
    INTO v_gross, v_maxvat
    FROM pos_order_items
   WHERE order_id = p_order_id AND COALESCE(comped, false) = false;
  IF v_gross <= 0 OR v_amount > v_gross * (1 + GREATEST(v_maxvat, 0)) + 1 THEN
    RAISE EXCEPTION 'Those points are worth more than this bill — redeem fewer.'
      USING ERRCODE = 'P0001', HINT = 'redeem_exceeds_bill';
  END IF;

  INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, created_by)
  VALUES (v_order.client_id, v_customer, p_order_id, 'redeem', -p_points, v_caller);

  INSERT INTO pos_order_payments (order_id, client_id, payment_method, amount, recorded_by)
  VALUES (p_order_id, v_order.client_id, 'Loyalty', v_amount, v_caller);

  RETURN v_amount;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.award_loyalty_points(p_order_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_caller    uuid := (SELECT auth.uid());
  v_order     record;
  v_customer  uuid;
  v_scheme_id uuid;
  v_scheme    record;
  v_base      numeric;
  v_points    integer;
BEGIN
  SELECT o.id, o.client_id, o.buyer_phone, o.discount_amount, o.close_type, o.status,
         o.closed_by, o.closed_at, o.credit_note_id
    INTO v_order
    FROM pos_orders o WHERE o.id = p_order_id
    FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF NOT COALESCE(public.is_admin() OR v_order.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'Not permitted.' USING ERRCODE = '42501';
  END IF;

  -- Points are earned at the moment of the close, by the person who closed it. A failed award is
  -- not retried later by staff — the Owner or the operator may add it afterwards.
  IF NOT COALESCE(public.is_admin() OR public.is_client_owner(), false) THEN
    IF v_order.closed_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Points for a bill are added by the person who closed it, as it closes — ask the Owner to add them.'
        USING ERRCODE = '42501', HINT = 'rank_required';
    END IF;
    IF v_order.closed_at IS NULL OR v_order.closed_at < now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'This bill closed too long ago for points to be added from the till — ask the Owner to add them.'
        USING ERRCODE = '42501', HINT = 'award_window_closed';
    END IF;
  END IF;

  -- Only a real, standing sale earns.
  IF v_order.status IS DISTINCT FROM 'billed' OR v_order.close_type IS DISTINCT FROM 'paid' THEN RETURN 0; END IF;
  IF v_order.credit_note_id IS NOT NULL THEN RETURN 0; END IF;
  IF v_order.buyer_phone IS NULL OR btrim(v_order.buyer_phone) = '' THEN RETURN 0; END IF;

  SELECT c.id, c.loyalty_scheme_id INTO v_customer, v_scheme_id
    FROM pos_customers c
   WHERE c.client_id = v_order.client_id AND c.phone = v_order.buyer_phone;
  IF v_customer IS NULL OR v_scheme_id IS NULL THEN RETURN 0; END IF;

  SELECT s.* INTO v_scheme FROM pos_loyalty_schemes s
   WHERE s.id = v_scheme_id AND s.is_active;
  IF v_scheme.id IS NULL THEN RETURN 0; END IF;

  SELECT COALESCE(SUM(i.qty * i.unit_price), 0) INTO v_base
    FROM pos_order_items i
   WHERE i.order_id = p_order_id AND COALESCE(i.comped, false) = false;
  v_base := v_base - COALESCE(v_order.discount_amount, 0);

  IF v_base < v_scheme.min_spend_to_earn OR v_base <= 0 THEN RETURN 0; END IF;

  v_points := floor(v_base / 100.0 * v_scheme.points_per_100);
  IF v_points <= 0 THEN RETURN 0; END IF;

  IF EXISTS (SELECT 1 FROM pos_loyalty_ledger WHERE order_id = p_order_id AND kind = 'earn') THEN
    RETURN 0;
  END IF;

  INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, scheme_id, created_by)
  VALUES (v_order.client_id, v_customer, p_order_id, 'earn', v_points, v_scheme.id, v_caller);

  RETURN v_points;
END;
$fn$;

-- A credit note hands the bill's loyalty back: points it EARNED are taken back, points SPENT on it
-- are returned. Two 'adjust' rows per customer at most (kind CHECK allows earn/redeem/adjust only),
-- each carrying credit_note_id. Idempotent twice over: the note row is locked and an existing
-- reversal returns early, and pos_loyalty_ledger_one_reversal_per_note refuses a duplicate.
-- A balance may go below zero when the earned points were already spent — the ledger is signed and
-- that is the true position.
CREATE OR REPLACE FUNCTION public.reverse_loyalty_for_credit_note(p_credit_note_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_caller   uuid := (SELECT auth.uid());
  v_note     record;
  v_row      record;
  v_label    text;
  v_taken    integer := 0;
  v_returned integer := 0;
BEGIN
  IF p_credit_note_id IS NULL THEN
    RAISE EXCEPTION 'p_credit_note_id is required';
  END IF;

  SELECT n.id, n.client_id, n.order_id, n.credit_note_no, n.invoice_fy
    INTO v_note
    FROM pos_credit_notes n WHERE n.id = p_credit_note_id
    FOR UPDATE;
  IF v_note.id IS NULL THEN
    RAISE EXCEPTION 'Credit note not found.';
  END IF;

  IF NOT COALESCE(public.is_admin() OR v_note.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'Not permitted.' USING ERRCODE = '42501';
  END IF;

  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'Reversing loyalty for a Credit Note needs POS Manager access or above.'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  IF EXISTS (SELECT 1 FROM pos_loyalty_ledger WHERE credit_note_id = p_credit_note_id) THEN
    RETURN jsonb_build_object('already_reversed', true, 'points_taken_back', 0, 'points_returned', 0);
  END IF;

  v_label := 'Credit Note ' || COALESCE(v_note.credit_note_no::text, '') ||
             CASE WHEN v_note.invoice_fy IS NOT NULL THEN ' (' || v_note.invoice_fy || ')' ELSE '' END;

  FOR v_row IN
    SELECT l.customer_id,
           COALESCE(SUM(l.points) FILTER (WHERE l.kind = 'earn'), 0)::integer                AS earned,
           (-COALESCE(SUM(l.points) FILTER (WHERE l.kind IN ('redeem', 'adjust')), 0))::integer AS spent
      FROM pos_loyalty_ledger l
     WHERE l.order_id = v_note.order_id
       AND l.client_id = v_note.client_id
       AND l.credit_note_id IS NULL
     GROUP BY l.customer_id
  LOOP
    IF v_row.earned > 0 THEN
      INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, note, created_by, credit_note_id)
      VALUES (v_note.client_id, v_row.customer_id, v_note.order_id, 'adjust', -v_row.earned,
              v_label || ': points earned on the bill taken back', v_caller, p_credit_note_id);
      v_taken := v_taken + v_row.earned;
    END IF;
    IF v_row.spent > 0 THEN
      INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, note, created_by, credit_note_id)
      VALUES (v_note.client_id, v_row.customer_id, v_note.order_id, 'adjust', v_row.spent,
              v_label || ': points spent on the bill returned', v_caller, p_credit_note_id);
      v_returned := v_returned + v_row.spent;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('already_reversed', false, 'points_taken_back', v_taken, 'points_returned', v_returned);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.award_loyalty_points(uuid)             FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer)   FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.reverse_loyalty_for_credit_note(uuid)  FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.award_loyalty_points(uuid)             TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer)   TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.reverse_loyalty_for_credit_note(uuid)  TO authenticated;


-- ── 12. log_audit: items_version is housekeeping ────────────────────────────────────────────
-- Every save now bumps pos_orders.items_version; without this each save would write an audit row
-- reading "(no tracked field changed)". Patched in place from the LIVE body (the S753 technique),
-- so a concurrent change to log_audit elsewhere is kept rather than overwritten.
DO $patch$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.log_audit()'::regprocedure) INTO v_def;
  IF position('''items_version''' IN v_def) > 0 THEN
    RETURN;  -- already patched
  END IF;
  v_new := replace(v_def,
    'ARRAY[''covers'',''print_count'',''comp_print_count'',''notes'']',
    'ARRAY[''covers'',''print_count'',''comp_print_count'',''notes'',''items_version'']');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'log_audit(): the pos_orders noise-skip array was not found in the live body — patch it by hand';
  END IF;
  EXECUTE v_new;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.log_audit()'::regprocedure) NOT LIKE '%''items_version''%' THEN
    RAISE EXCEPTION 'log_audit(): items_version patch did not take';
  END IF;
END
$patch$;


-- ── 13. Assertions (catalog values, never formatted strings) ────────────────────────────────
DO $assert$
BEGIN
  -- The old 3-arg save is gone and exactly one save_pos_order_items remains, INVOKER.
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'save_pos_order_items' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'save_pos_order_items: expected exactly one signature';
  END IF;
  IF (SELECT prosecdef OR pronargs <> 4 FROM pg_proc WHERE proname = 'save_pos_order_items' AND pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'save_pos_order_items must be SECURITY INVOKER with 4 arguments';
  END IF;
  -- Row guards are INVOKER (current_user is the seam); the RPCs that must pass them are DEFINER.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
              AND proname IN ('guard_pos_order_close','guard_pos_order_insert','guard_pos_order_delete',
                              'guard_pos_order_items_closed','guard_pos_item_price','guard_pos_order_payments_closed',
                              'guard_recipe_menu_price','guard_pos_credit_note')) THEN
    RAISE EXCEPTION 'a row guard is SECURITY DEFINER — current_user would never be a client role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND NOT prosecdef
              AND proname IN ('apply_pos_item_comps','redeem_loyalty_points','award_loyalty_points','reverse_loyalty_for_credit_note')) THEN
    RAISE EXCEPTION 'a writer RPC lost SECURITY DEFINER and would be refused by its own row guards';
  END IF;
  IF has_function_privilege('anon', 'public.reverse_loyalty_for_credit_note(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.save_pos_order_items(uuid, jsonb, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_pos_order_items(uuid, jsonb, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.reverse_loyalty_for_credit_note(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'function grants are wrong';
  END IF;
  -- A profile-less session: the comp-slip caller check must now raise.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  BEGIN
    PERFORM public.get_next_pos_comp_slip_no('00000000-0000-0000-0000-000000000002'::uuid, '2083/84');
    RAISE EXCEPTION 'get_next_pos_comp_slip_no did not refuse a profile-less caller';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'not authorized%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END
$assert$;

NOTIFY pgrst, 'reload schema';
