-- S756 — IMS re-analysis, stage 1: closed months and IMS rank rules enforced by the database.
--
-- The IMS module's rules lived one layer above where they were decided, the shape S531 and S754
-- closed for profiles and POS. Every table below carried a plain same-client FOR ALL policy, so an
-- IMS staff-rank login, a store-room count PIN or (on stock_movements) a POS PIN waiter could, over
-- the REST API: reopen, close or relabel a month; write into a closed month; delete purchase bills
-- and supplier payments; hide or delete dishes; rewrite recipe ingredients; post depreciation; and
-- change the food-cost thresholds every report bands against.
--
-- Decisions taken with the owner (Aashish, 2026-09-15), in IMS_TODO.md:
--   D1  A closed month refuses writes for everyone but admin AND THE OWNER, who edit in place.
--       Reopening cannot be the Owner's route: only one period may be open, and the next month is
--       already open by the time a mistake is found. Settling an old bill (paid_at only) stays open.
--   D2  Creating/closing a month: Owner, IMS supervisor or manager, admin. Reopen and relabel:
--       Owner or admin.
--   D3  Hide/unhide a dish: IMS supervisor+. Delete a dish: IMS manager+.
--   D4  One "Sign out all counting tablets" (rotate_ims_device_secret).
-- Everything else mirrors the rank the browser already applies, found by a writer inventory of
-- every client, RPC and Edge Function write to each table (S756).
--
-- Carve-outs every guard below shares, in this order:
--   * current_user NOT IN ('anon','authenticated') — the service role, SECURITY DEFINER bodies
--     (push_master_data, force_delete_item) and FK cascade actions, which run as the table owner.
--     Hence every guard is SECURITY INVOKER: under DEFINER current_user is the owner every time.
--   * COALESCE(is_admin(), false) — the operator, including restore.
--   * The Owner, through ims_caller_has_rank (is_client_owner(), wrapped in COALESCE).
-- Every authorisation expression is COALESCE'd: NULL IN (...) is NULL, and IF NOT NULL never fires.


-- ══ 0. Helpers ═══════════════════════════════════════════════════════════════════════════════════

-- The IMS twin of pos_caller_has_rank (20260916110000). A count PIN (ims_email set) is refused at
-- every rank: it exists to enter a closing count on a shared tablet, and the tables that count
-- writes are governed by the S737 scope/recount rules, not by this helper. Its rank is fixed at
-- 'staff' for that reason (admin-user-ops refuses any other since S756), so without this clause a
-- 4-digit tablet PIN would pass every "staff and above" check below.
CREATE OR REPLACE FUNCTION public.ims_caller_has_rank(p_min text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(public.is_client_owner(), false)
      OR COALESCE((
           SELECT p.settlement_blocked_by IS NULL
              AND p.ims_email IS NULL
              AND CASE p_min
                    WHEN 'staff'      THEN p.ims_role IN ('staff', 'supervisor', 'manager')
                    WHEN 'supervisor' THEN p.ims_role IN ('supervisor', 'manager')
                    WHEN 'manager'    THEN p.ims_role = 'manager'
                  END
             FROM profiles p
            WHERE p.id = (select auth.uid())), false)
$$;
REVOKE ALL ON FUNCTION public.ims_caller_has_rank(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ims_caller_has_rank(text) TO authenticated, service_role;

-- Whether a period is closed, read past RLS. An INVOKER lookup is subject to monthly_periods' own
-- policies and can come back empty, which would read as "not closed" — the permissive direction.
-- Returns a boolean and nothing else, so it discloses nothing a caller could not already see.
-- A NULL or missing period is not closed: staff_meals and requisitions carry a nullable period_id.
CREATE OR REPLACE FUNCTION public.ims_period_is_closed(p_period_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT mp.status = 'closed' FROM monthly_periods mp WHERE mp.id = p_period_id), false)
$$;
REVOKE ALL ON FUNCTION public.ims_period_is_closed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ims_period_is_closed(uuid) TO authenticated, service_role;

-- Who may write into a closed month (D1). Mirrors canEditClosedPeriods in AuthContext.js.
CREATE OR REPLACE FUNCTION public.caller_can_edit_closed_period()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
$$;
REVOKE ALL ON FUNCTION public.caller_can_edit_closed_period() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caller_can_edit_closed_period() TO authenticated, service_role;


-- ══ 1. The closed-month lock (D1) ════════════════════════════════════════════════════════════════
--
-- Writers enumerated (S756 inventory). The only non-admin write that legitimately lands in a
-- closed month is Outstanding Payables settling an old bill, which UPDATEs purchase_entries.paid_at
-- and nothing else — carved out below. POS closes and credit notes post only into an open period
-- (PosOrders.jsx, creditNotePosting.js check first); the POS backfill button follows the same
-- lock; carry-forward writes the NEXT (open) period; restore and Resync are admin. The Stock Count
-- offline replay was the one path landing counts in a month closed while the tablet was offline,
-- and refusing it is the point.
CREATE OR REPLACE FUNCTION public.ims_closed_period_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_old_period uuid;
  v_new_period uuid;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.caller_can_edit_closed_period() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'INSERT' THEN v_old_period := (to_jsonb(OLD) ->> 'period_id')::uuid; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_period := (to_jsonb(NEW) ->> 'period_id')::uuid; END IF;

  -- Settling a bill from an earlier month is not editing that month (Outstanding Payables).
  IF TG_TABLE_NAME = 'purchase_entries' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'paid_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'paid_at') THEN
    RETURN NEW;
  END IF;

  IF public.ims_period_is_closed(v_old_period) OR public.ims_period_is_closed(v_new_period) THEN
    RAISE EXCEPTION '%: this month is closed, so its figures cannot be changed except by the account owner', TG_TABLE_NAME
      USING ERRCODE = '42501', HINT = 'period_closed';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_closed_period_guard() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['opening_stock', 'closing_stock', 'wastages', 'staff_meals',
                           'sales_entries', 'purchase_entries', 'vendor_returns', 'requisitions']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS ims_closed_period_guard ON public.%I', t);
    EXECUTE format('CREATE TRIGGER ims_closed_period_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.ims_closed_period_guard()', t);
  END LOOP;
END $$;

-- requisition_lines has no period of its own; it reaches one through its requisition. A cascade
-- from the header delete has already returned at the current_user check, before any lookup.
CREATE OR REPLACE FUNCTION public.ims_requisition_line_period_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_req_ids uuid[];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR public.caller_can_edit_closed_period() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_req_ids := ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.requisition_id END,
                     CASE WHEN TG_OP <> 'DELETE' THEN NEW.requisition_id END];
  IF EXISTS (SELECT 1 FROM requisitions r
              WHERE r.id = ANY (v_req_ids) AND public.ims_period_is_closed(r.period_id)) THEN
    RAISE EXCEPTION 'requisition_lines: this month is closed, so its figures cannot be changed except by the account owner'
      USING ERRCODE = '42501', HINT = 'period_closed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_requisition_line_period_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_closed_period_guard ON public.requisition_lines;
CREATE TRIGGER ims_closed_period_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.requisition_lines
  FOR EACH ROW EXECUTE FUNCTION public.ims_requisition_line_period_guard();

-- receive_purchase_order refused a closed period for everyone but admin (S709). The Owner joins
-- the carve-out (D1). Body otherwise identical to the live definition read on 2026-09-15.
CREATE OR REPLACE FUNCTION public.receive_purchase_order(p_po_id uuid, p_bs_day integer, p_payment_method text, p_vat_inclusive boolean, p_group_id uuid, p_lines jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_po        purchase_orders%ROWTYPE;
  v_period    monthly_periods%ROWTYPE;
  v_line      jsonb;
  v_item      purchase_order_items%ROWTYPE;
  v_qty       numeric;
  v_remaining numeric;
  v_updated   integer;
  v_all       boolean;
  v_any       boolean;
  v_status    text;
BEGIN
  IF p_po_id IS NULL THEN
    RAISE EXCEPTION 'p_po_id is required';
  END IF;
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'p_group_id is required';
  END IF;
  IF p_bs_day IS NULL OR p_bs_day < 1 OR p_bs_day > 32 THEN
    RAISE EXCEPTION 'p_bs_day must be 1-32';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty json array';
  END IF;

  -- FOR UPDATE: this is the row every concurrent receipt against this PO must queue behind, so
  -- the remaining-quantity checks below are evaluated one receipt at a time rather than by two
  -- browsers reading the same "remaining" and each deciding it fits.
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po_not_found: purchase order % is not available', p_po_id
      USING ERRCODE = 'P0001',
            HINT = 'Reload the Purchase Orders list.';
  END IF;

  IF v_po.status IN ('cancelled', 'received') THEN
    RAISE EXCEPTION 'po_not_receivable: purchase order % is %', v_po.po_number, v_po.status
      USING ERRCODE = 'P0001',
            HINT = 'A cancelled or fully received order cannot take another delivery. Raise a new PO.';
  END IF;

  -- Fail CLOSED if the period cannot be read: an unreadable period is not an open one.
  SELECT * INTO v_period FROM monthly_periods WHERE id = v_po.period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po_not_found: the period behind purchase order % is not available', v_po.po_number
      USING ERRCODE = 'P0001',
            HINT = 'Reload the Purchase Orders list.';
  END IF;

  -- The closed-period lock. Admin and the Owner edit a closed month in place (S756, D1); the
  -- purchase_entries trigger enforces the same pair, this only refuses before any row is touched.
  IF v_period.status = 'closed' AND NOT public.caller_can_edit_closed_period() THEN
    RAISE EXCEPTION 'po_period_closed: period % is closed', v_po.period_id
      USING ERRCODE = 'P0001',
            HINT = 'Ask the account owner to enter it, or receive the delivery into the open period.';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_qty := round(COALESCE((v_line ->> 'qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_item
      FROM purchase_order_items
     WHERE id = (v_line ->> 'po_item_id')::uuid
       AND po_id = p_po_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'po_receipt_stale: line % is not on purchase order %', v_line ->> 'po_item_id', v_po.po_number
        USING ERRCODE = 'P0001',
              HINT = 'The order changed since this screen was opened. Nothing was received; reopen it from the list.';
    END IF;

    v_remaining := round(v_item.qty_ordered - COALESCE(v_item.qty_received, 0), 3);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'po_over_receive: % over the % still on order for line %', v_qty - v_remaining, v_remaining, v_item.id
        USING ERRCODE = 'P0001',
              HINT = 'Someone may have received against this order already. Reopen it to see what is left.';
    END IF;

    INSERT INTO purchase_entries
      (period_id, item_id, vendor_id, bs_day, qty, rate, invoice_ref,
       payment_method, vat_inclusive, purchase_group_id, po_id)
    VALUES
      (v_po.period_id, v_item.item_id, v_po.vendor_id, p_bs_day, v_qty,
       COALESCE(round((v_line ->> 'rate')::numeric, 2), 0),
       v_po.po_number,
       COALESCE(NULLIF(p_payment_method, ''), 'Credit'),
       COALESCE(p_vat_inclusive, false),
       p_group_id,
       p_po_id);

    UPDATE purchase_order_items
       SET qty_received = COALESCE(qty_received, 0) + v_qty
     WHERE id = v_item.id AND po_id = p_po_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'po_receipt_stale: could not record the received quantity for line %', v_item.id
        USING ERRCODE = 'P0001',
              HINT = 'Nothing was received. Reopen the order from the list and try again.';
    END IF;
  END LOOP;

  SELECT bool_and(COALESCE(qty_received, 0) >= qty_ordered),
         bool_or(COALESCE(qty_received, 0) > 0)
    INTO v_all, v_any
    FROM purchase_order_items WHERE po_id = p_po_id;

  v_status := CASE WHEN v_all THEN 'received'
                   WHEN v_any THEN 'partial'
                   ELSE v_po.status END;

  IF v_status IS DISTINCT FROM v_po.status THEN
    UPDATE purchase_orders SET status = v_status WHERE id = p_po_id;
  END IF;

  RETURN v_status;
END;
$function$;


-- ══ 2. monthly_periods: who creates, closes, reopens and relabels a month (D2) ═══════════════════
--
-- Writers enumerated: performPeriodClose (open→closed + insert next) from Periods and the Dashboard;
-- createPeriodWithCarryForward, Reopen and relabel (admin only in the UI); the Dashboard's
-- projection snapshots, written by ANY viewer of an open month, best-effort — left open here so a
-- staff viewer's capture still lands; AdminClients seed and restore (admin). DELETE already has
-- monthly_periods_delete_owner.
CREATE OR REPLACE FUNCTION public.ims_monthly_periods_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  c_free constant text[] := ARRAY['sales_projection_snapshot', 'purch_projection_snapshot'];
  v_changed text[];
  v_owner boolean;
BEGIN
  IF TG_OP = 'DELETE' OR current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_owner := COALESCE(public.is_client_owner(), false);

  IF TG_OP = 'INSERT' THEN
    IF NOT public.ims_caller_has_rank('supervisor') THEN
      RAISE EXCEPTION 'monthly_periods: starting a month needs the account owner or an IMS supervisor or manager'
        USING ERRCODE = '42501', HINT = 'period_rank';
    END IF;
    IF NEW.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'monthly_periods: a month starts open and is closed with End Period'
        USING ERRCODE = '42501', HINT = 'period_rank';
    END IF;
    RETURN NEW;
  END IF;

  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
    FROM jsonb_object_keys(to_jsonb(NEW)) k
   WHERE NOT (k = ANY (c_free))
     AND (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k);
  IF cardinality(v_changed) = 0 THEN
    RETURN NEW;
  END IF;

  -- Closing the month: the Periods page's own audience.
  IF v_changed = ARRAY['status'] AND OLD.status = 'open' AND NEW.status = 'closed' THEN
    IF public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'monthly_periods: closing the month needs the account owner or an IMS supervisor or manager'
      USING ERRCODE = '42501', HINT = 'period_rank';
  END IF;

  -- Reopening, relabelling (which moves every row of the month into another reporting month) and
  -- anything else: the Owner.
  IF v_owner THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'monthly_periods: reopening or renaming a month needs the account owner (%)', array_to_string(v_changed, ', ')
    USING ERRCODE = '42501', HINT = 'period_rank';
END;
$$;
REVOKE ALL ON FUNCTION public.ims_monthly_periods_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_monthly_periods_guard ON public.monthly_periods;
CREATE TRIGGER ims_monthly_periods_guard
  BEFORE INSERT OR UPDATE ON public.monthly_periods
  FOR EACH ROW EXECUTE FUNCTION public.ims_monthly_periods_guard();


-- ══ 3. Purchases, returns and supplier payments ══════════════════════════════════════════════════
--
-- purchase_entries — INSERT/DELETE: IMS staff+ (save_purchase_bill and single-bill delete are
-- staff pages; Delete All is supervisor in the page and left at staff here, since a staff login
-- may already delete every bill one at a time). UPDATE: only Outstanding Payables (paid_at) —
-- manager. vendor_returns — staff+ (ReturnsTab). payable_payments — manager (Outstanding Payables).
-- FK cascades (bill delete → payments, → returns SET NULL) pass at current_user.
CREATE OR REPLACE FUNCTION public.ims_rank_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_need text := TG_ARGV[0];
  v_what text := TG_ARGV[1];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- An optional per-operation override: TG_ARGV[2] is the rank an UPDATE needs.
  IF TG_OP = 'UPDATE' AND TG_NARGS > 2 THEN
    v_need := TG_ARGV[2];
  END IF;
  IF NOT public.ims_caller_has_rank(v_need) THEN
    RAISE EXCEPTION '%: % needs an IMS % or the account owner', TG_TABLE_NAME, v_what,
      CASE v_need WHEN 'staff' THEN 'login' ELSE v_need END
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_rank_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.purchase_entries;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_entries
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('staff', 'recording a purchase bill', 'manager');

DROP TRIGGER IF EXISTS ims_rank_guard ON public.vendor_returns;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vendor_returns
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('staff', 'recording a return to a supplier');

DROP TRIGGER IF EXISTS ims_rank_guard ON public.payable_payments;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payable_payments
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'recording a supplier payment');

DROP TRIGGER IF EXISTS ims_rank_guard ON public.par_levels;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.par_levels
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'setting a par level');


-- ══ 4. Requisitions: an issued slip is changed by a supervisor ═══════════════════════════════════
--
-- Writers: raise (staff, draft or Save & Issue), issue a draft (lines then header, staff),
-- correct an issued slip's qty_issued (supervisor, canAmendIssued), delete a draft (staff) or an
-- issued slip (supervisor). Nothing updates an issued header. Known gap, accepted: a line INSERT
-- onto an issued slip stays staff-rank, because Save & Issue inserts its lines after the header is
-- already 'issued' and a row trigger cannot tell that apart from a later addition.
CREATE OR REPLACE FUNCTION public.ims_requisition_rank_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_issued boolean := false;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'INSERT' THEN
    IF TG_TABLE_NAME = 'requisitions' THEN
      v_issued := OLD.status = 'issued';
    ELSE
      v_issued := COALESCE((SELECT r.status = 'issued' FROM requisitions r WHERE r.id = OLD.requisition_id), false);
    END IF;
  END IF;

  IF v_issued AND NOT public.ims_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION '%: changing or deleting a requisition that has already been issued needs an IMS supervisor or manager', TG_TABLE_NAME
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  IF NOT public.ims_caller_has_rank('staff') THEN
    RAISE EXCEPTION '%: requisitions need an IMS login', TG_TABLE_NAME
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_requisition_rank_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.requisitions;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.requisitions
  FOR EACH ROW EXECUTE FUNCTION public.ims_requisition_rank_guard();
DROP TRIGGER IF EXISTS ims_rank_guard ON public.requisition_lines;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.requisition_lines
  FOR EACH ROW EXECUTE FUNCTION public.ims_requisition_rank_guard();


-- ══ 5. stock_movements: the perpetual ledger ═════════════════════════════════════════════════════
--
-- Not on no_pos_pin_staff, because the till writes it. Writers: Sales Entry (source 'manual',
-- delete+insert for one day, IMS staff+); the till closing a bill (pos_sale/pos_comp INSERT, POS
-- supervisor+ — guard_pos_order_close already requires that to close); the POS backfill (IMS
-- supervisor+ or Owner); Clear Book Stock (every source, admin in the page). Nothing UPDATEs.
CREATE OR REPLACE FUNCTION public.ims_stock_movements_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_source text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false)
     OR COALESCE(public.is_client_owner(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

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
  END IF;

  RAISE EXCEPTION 'stock_movements: this stock movement (%) cannot be % from this login', COALESCE(v_source, 'no source'),
    CASE TG_OP WHEN 'INSERT' THEN 'recorded' ELSE 'removed' END
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$$;
REVOKE ALL ON FUNCTION public.ims_stock_movements_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.stock_movements;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.ims_stock_movements_guard();


-- ══ 6. Recipes (D3) ══════════════════════════════════════════════════════════════════════════════
--
-- Writers: Recipe Costing (IMS supervisor: insert, edit, target FC%, Hide, Delete); Recipe Import
-- (supervisor: insert, and DELETE of the just-inserted recipe when its ingredients fail); Menu
-- Pricing (admin/Owner/POS manager/IMS manager: insert, name/category/price/VAT/cost, pos_enabled);
-- Menu Engineering me_class (IMS manager); Settings recipe_code (IMS manager); POS Table Management
-- hsc_code (POS manager); push_master_data (DEFINER). guard_recipe_menu_price keeps the price rule.
CREATE OR REPLACE FUNCTION public.guard_recipe_rank()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF public.ims_caller_has_rank('manager') THEN
      RETURN OLD;
    END IF;
    -- Recipe Import's cleanup: a supervisor removing the recipe it inserted moments ago when its
    -- ingredient rows were refused. Nothing references a recipe that new and that empty.
    IF public.ims_caller_has_rank('supervisor')
       AND OLD.created_at > now() - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM recipe_ingredients ri WHERE ri.recipe_id = OLD.id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'recipes: deleting a dish needs an IMS manager or the account owner — hide it instead'
      USING ERRCODE = '42501', HINT = 'recipe_delete_rank';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    IF public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'recipes: hiding or showing a dish needs an IMS supervisor or manager'
      USING ERRCODE = '42501', HINT = 'recipe_hide_rank';
  END IF;

  IF public.ims_caller_has_rank('supervisor') OR COALESCE(public.caller_can_set_menu_price(), false) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recipes: changing a recipe needs an IMS supervisor, a manager or the account owner'
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_recipe_rank() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_recipe_rank ON public.recipes;
CREATE TRIGGER guard_recipe_rank
  BEFORE INSERT OR UPDATE OR DELETE ON public.recipes
  FOR EACH ROW EXECUTE FUNCTION public.guard_recipe_rank();

-- recipe_ingredients: Recipe Costing and Recipe Import (supervisor), push_master_data (DEFINER),
-- the cascade from a recipe delete. No POS path writes it.
DROP TRIGGER IF EXISTS ims_rank_guard ON public.recipe_ingredients;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'changing a recipe''s ingredients');


-- ══ 7. Fixed assets ══════════════════════════════════════════════════════════════════════════════
--
-- Mirrors the page: categories, the register and repair expenses are supervisor (FixedAssets.js);
-- disposal (status and disposal_* on the register) and both posting RPCs are manager. The RPCs are
-- SECURITY INVOKER, so these triggers fire inside them.
DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_categories;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_categories
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'changing asset categories');
DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_repair_expenses;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_repair_expenses
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('supervisor', 'recording a repair expense');
DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_depreciation_runs;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_depreciation_runs
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'posting depreciation');
DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_depreciation_schedule;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_depreciation_schedule
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'posting depreciation');
DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_tax_pool_runs;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_tax_pool_runs
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'posting the tax depreciation pools');
DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_tax_pool_lines;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_tax_pool_lines
  FOR EACH ROW EXECUTE FUNCTION public.ims_rank_guard('manager', 'posting the tax depreciation pools');

CREATE OR REPLACE FUNCTION public.ims_assets_register_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  c_disposal constant text[] := ARRAY['status', 'disposal_date', 'disposal_proceeds', 'disposal_gain_loss', 'disposal_reason'];
  v_need text := 'supervisor';
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_need := 'manager';
  ELSIF TG_OP = 'UPDATE' AND EXISTS (
          SELECT 1 FROM unnest(c_disposal) k
           WHERE (to_jsonb(NEW) -> k) IS DISTINCT FROM (to_jsonb(OLD) -> k)) THEN
    v_need := 'manager';
  END IF;
  IF NOT public.ims_caller_has_rank(v_need) THEN
    RAISE EXCEPTION 'assets_register: % needs an IMS % or the account owner',
      CASE v_need WHEN 'manager' THEN 'disposing of or deleting an asset' ELSE 'changing the asset register' END, v_need
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.ims_assets_register_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS ims_rank_guard ON public.assets_register;
CREATE TRIGGER ims_rank_guard BEFORE INSERT OR UPDATE OR DELETE ON public.assets_register
  FOR EACH ROW EXECUTE FUNCTION public.ims_assets_register_guard();


-- ══ 8. settings: the IMS thresholds every report bands against ═══════════════════════════════════
--
-- Live body of settings_guard_staff_roles (20260916110000) read 2026-09-15, plus c_ims: the food-
-- cost and variance bands, expiry days, the negative-stock and below-cost switches, and the three
-- code prefixes — saved only from Settings (IMS manager). Their column defaults join c_insert_base,
-- or the first-row INSERT from a POS, HR or Combo page would read as a change and be refused.
CREATE OR REPLACE FUNCTION public.settings_guard_staff_roles()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  c_insert_base constant jsonb := '{"hr_custom_roles": [], "ims_custom_roles": [], "pos_custom_roles": [], "is_vat_registered": true, "pos_loyalty_point_value": 1,
                                    "fc_warning_pct": 35, "fc_critical_pct": 45, "expiry_warning_days": 7, "variance_flag_pct": 10,
                                    "block_negative_stock": false, "warn_below_cost_pricing": true,
                                    "item_code_prefix": "ITM", "vendor_code_prefix": "VND", "sub_recipe_code_prefix": "SRC"}'::jsonb;
  c_tada        constant text[] := ARRAY['tada_vehicle_rates', 'tada_purpose_options', 'tada_start_points'];
  c_pos_setup   constant text[] := ARRAY['pos_bot_categories', 'pos_note_presets', 'pos_discount_reasons', 'pos_delivery_partners',
                                         'pos_reservation_settings', 'pos_open_time', 'pos_close_time', 'pos_loyalty_point_value'];
  c_print       constant text[] := ARRAY['is_vat_registered', 'invoice_prefix', 'vat_number', 'property_address', 'property_phone', 'payment_qr_data'];
  c_ims         constant text[] := ARRAY['fc_warning_pct', 'fc_critical_pct', 'expiry_warning_days', 'variance_flag_pct',
                                         'block_negative_stock', 'warn_below_cost_pricing',
                                         'item_code_prefix', 'vendor_code_prefix', 'sub_recipe_code_prefix'];
  v_new jsonb;
  v_old jsonb;
  v_changed text[];
  v_me profiles;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  v_new := to_jsonb(NEW);
  v_old := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE c_insert_base END;
  -- to_jsonb renders a NULL column as JSON null; `->` on a missing key is SQL NULL. Normalise both.
  SELECT COALESCE(array_agg(k), '{}') INTO v_changed
    FROM unnest(ARRAY['hr_custom_roles', 'ims_custom_roles', 'pos_custom_roles'] || c_tada || c_pos_setup || c_print || c_ims) k
   WHERE COALESCE(v_new -> k, 'null'::jsonb) IS DISTINCT FROM COALESCE(v_old -> k, 'null'::jsonb);
  IF cardinality(v_changed) = 0 THEN
    RETURN NEW;
  END IF;

  IF COALESCE(public.is_client_owner(), false) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_me FROM profiles WHERE id = (select auth.uid());

  IF 'hr_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.hr_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an HR manager can change the HR role list' USING ERRCODE = '42501';
  END IF;
  IF 'ims_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.ims_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or an IMS manager can change the IMS role list' USING ERRCODE = '42501';
  END IF;
  IF 'pos_custom_roles' = ANY (v_changed) AND NOT COALESCE(v_me.pos_role = 'manager', false) THEN
    RAISE EXCEPTION 'staff_roles_rank: only the Owner or a POS manager can change the POS role list' USING ERRCODE = '42501';
  END IF;
  IF v_changed && c_tada AND NOT COALESCE(v_me.hr_role = 'manager', false) THEN
    RAISE EXCEPTION 'tada_settings_rank: only the Owner or an HR manager can change the travel claim settings' USING ERRCODE = '42501';
  END IF;
  IF v_changed && c_pos_setup AND NOT COALESCE(v_me.pos_role = 'manager', false) THEN
    RAISE EXCEPTION 'pos_setup_rank: only the Owner or a POS manager can change the till setup (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_pos_setup) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'pos_setup_rank';
  END IF;
  IF v_changed && c_ims AND NOT COALESCE(v_me.ims_role = 'manager' AND v_me.ims_email IS NULL, false) THEN
    RAISE EXCEPTION 'ims_settings_rank: only the Owner or an IMS manager can change the inventory thresholds and code prefixes (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_ims) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'ims_settings_rank';
  END IF;
  IF v_changed && c_print THEN
    RAISE EXCEPTION 'invoice_settings_rank: only the Owner can change the invoice and VAT details printed on bills (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_print) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'invoice_settings_rank';
  END IF;
  RETURN NEW;
END;
$function$;


-- ══ 9. demand_forecast_daily: HR logins read it ══════════════════════════════════════════════════
--
-- Roster's Labor Forecast overlays forecast covers onto the HR roster, and no_hr_role_staff was FOR
-- ALL here, so every HR login — the tab's audience — read [] with no error: the overlay silently
-- never appeared. A forecast is not sensitive; writing one still is. The S752 monthly_periods split.
DROP POLICY IF EXISTS no_hr_role_staff ON public.demand_forecast_daily;
DROP POLICY IF EXISTS no_hr_role_staff_insert ON public.demand_forecast_daily;
DROP POLICY IF EXISTS no_hr_role_staff_update ON public.demand_forecast_daily;
DROP POLICY IF EXISTS no_hr_role_staff_delete ON public.demand_forecast_daily;
CREATE POLICY no_hr_role_staff_insert ON public.demand_forecast_daily AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.is_hr_role_staff());
CREATE POLICY no_hr_role_staff_update ON public.demand_forecast_daily AS RESTRICTIVE FOR UPDATE
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());
CREATE POLICY no_hr_role_staff_delete ON public.demand_forecast_daily AS RESTRICTIVE FOR DELETE
  USING (NOT public.is_hr_role_staff());


-- ══ 10. Counting tablets (D4) ════════════════════════════════════════════════════════════════════

-- The roster RAISES on a dead key instead of returning no rows (S754 did the same for POS): an
-- empty roster read "no counting PINs set up yet, ask your manager" on a tablet whose key had been
-- rotated. And a leaver blocked at Final Settlement is off the picker.
CREATE OR REPLACE FUNCTION public.get_ims_count_staff(p_client_id uuid, p_device_secret uuid)
    RETURNS TABLE(id uuid, full_name text, ims_job_title text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM client_secrets cs
                  WHERE cs.client_id = p_client_id AND cs.ims_device_secret = p_device_secret) THEN
    RAISE EXCEPTION 'ims_device_not_active' USING ERRCODE = '28000',
      HINT = 'This counting tablet needs the setup code scanned again.';
  END IF;

  RETURN QUERY
    SELECT p.id::uuid, p.full_name::text, p.ims_job_title::text
      FROM profiles p
     WHERE p.client_id = p_client_id
       AND p.ims_role IS NOT NULL
       AND p.ims_email IS NOT NULL
       AND p.settlement_blocked_by IS NULL
     ORDER BY p.full_name;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.get_ims_count_staff(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_count_staff(uuid, uuid) TO anon, authenticated, service_role;

-- "Sign out all counting tablets". Same audience as showing the setup QR (ims_can_manage_counts:
-- admin, Owner, IMS manager). Rotating the shared key is the whole revoke; the enrol token goes
-- with it so a QR left open cannot hand out the new key. The audit row never carries the key.
CREATE OR REPLACE FUNCTION public.rotate_ims_device_secret(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := (select auth.uid());
BEGIN
  IF NOT COALESCE(
       public.is_admin() OR (p_client_id = public.my_client_id() AND public.ims_can_manage_counts()),
     false) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO client_secrets (client_id, ims_device_secret, ims_enrol_token, ims_enrol_token_expires_at)
  VALUES (p_client_id, gen_random_uuid(), NULL, NULL)
  ON CONFLICT (client_id) DO UPDATE
    SET ims_device_secret = gen_random_uuid(),
        ims_enrol_token = NULL,
        ims_enrol_token_expires_at = NULL,
        updated_at = now();

  INSERT INTO audit_logs (client_id, client_name, user_id, user_name, table_name, action, record_id, old_data, new_data)
  SELECT p_client_id, c.name, v_uid, (SELECT pr.full_name FROM profiles pr WHERE pr.id = v_uid),
         'client_secrets', 'UPDATE', p_client_id, NULL,
         jsonb_build_object('ims_count_tablets_signed_out_at', now())
    FROM clients c WHERE c.id = p_client_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.rotate_ims_device_secret(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.rotate_ims_device_secret(uuid) TO authenticated, service_role;


-- ══ 11. Self-check ═══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['opening_stock', 'closing_stock', 'wastages', 'staff_meals', 'sales_entries', 'purchase_entries',
                      'vendor_returns', 'requisitions', 'requisition_lines']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
                      WHERE c.relname = t AND tg.tgname = 'ims_closed_period_guard' AND NOT tg.tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S756: closed-period guard missing on %', v_missing;
  END IF;

  SELECT string_agg(t, ', ') INTO v_missing
    FROM unnest(ARRAY['purchase_entries', 'vendor_returns', 'payable_payments', 'par_levels', 'requisitions',
                      'requisition_lines', 'stock_movements', 'recipe_ingredients', 'assets_categories',
                      'assets_repair_expenses', 'assets_depreciation_runs', 'assets_depreciation_schedule',
                      'assets_tax_pool_runs', 'assets_tax_pool_lines', 'assets_register']) t
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
                      WHERE c.relname = t AND tg.tgname = 'ims_rank_guard' AND NOT tg.tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'S756: rank guard missing on %', v_missing;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('ims_closed_period_guard', 'ims_requisition_line_period_guard', 'ims_monthly_periods_guard',
                                  'ims_rank_guard', 'ims_requisition_rank_guard', 'ims_stock_movements_guard',
                                  'guard_recipe_rank', 'ims_assets_register_guard', 'settings_guard_staff_roles')
                AND p.prosecdef) THEN
    RAISE EXCEPTION 'S756: a guard trigger is SECURITY DEFINER — current_user would be the owner and it would never fire';
  END IF;

  IF has_function_privilege('anon', 'public.rotate_ims_device_secret(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S756: rotate_ims_device_secret is anon-executable';
  END IF;
END $$;
