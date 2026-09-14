-- S754 — POS rank rules enforced in the database, the same ones the screens already show.
--
-- Decisions taken with Aashish (2026-09-14):
--   * Opening and closing a shift, cash in / cash out and a Credit settlement are supervisor work;
--     the till's setup (tables, discount reasons, quick notes, ticket routing, delivery partners,
--     reservation settings, opening hours, loyalty point value and schemes) is POS manager work;
--     the invoice / VAT details printed on every bill are the Owner's. Admin (the operator) and the
--     service role are exempt from all of it, as every guard in this schema is.
--   * A closed shift is a signed record: nothing edits or deletes it, and no cash movement is ever
--     edited or deleted — a mistake is corrected with a second movement.
--   * Loyalty schemes, the point value and who is enrolled are set by a POS manager or the Owner.
--   * A credit note can hand cash back: kind 'refund' on pos_cash_movements, linked to the note.
--   * The kitchen gets a 'served' stage so the floor's Ready clears.
--   * Only ACCEPTED bookings fill a slot on the public booking page; a request does not.
--   * A guest order carrying a dish that is no longer available is refused whole, naming the dish.
--
-- Sections:
--   (0) pos_caller_has_rank(): the one POS rank test the triggers below share
--   (1) pos_shifts: rank to open/close, closed = immutable, no client DELETE, attribution stamped, audited
--   (2) pos_cash_movements: rank to insert, never edited/deleted, 'refund' kind + credit-note link, audited
--   (3) settings: POS setup columns need a POS manager; invoice/VAT/print columns need the Owner
--   (4) pos_tables: setup needs a POS manager, status stays open to the till; no delete under an open bill
--   (5) loyalty: schemes and enrolment need a POS manager
--   (6) get_pos_device_secret: the manager test COALESCE'd (it fell open for IMS/HR/Self-Service logins)
--   (7) get_pos_staff / get_pos_staff_list: settlement-blocked logins leave the PIN picker; the list says so
--   (8) submit_guest_order: whole-number qty, machine codes on every refusal, unavailable dishes refuse the order
--   (9) pos_kot_log: 'served' stage + served_at; the guest tracker reads served as ready
--  (10) reservation_hour_load: only accepted bookings count against seats

-- ── (0) The POS rank test ───────────────────────────────────────────────────────────────────────
--
-- Admin, the Owner, or a POS login at the given rank or above whose login has not been blocked by a
-- Final Settlement (S753 revokes those sessions, but an issued access token lives up to an hour).
-- Every operand is COALESCE'd: pos_role is NULL for every non-POS account and
-- `NULL IN ('supervisor','manager')` is NULL, which in an `IF NOT` falls OPEN (S579/S630).
-- SECURITY DEFINER because profiles is self-or-admin under RLS; it reads only the caller's own row.
-- Called from SECURITY INVOKER triggers, so `authenticated` needs EXECUTE on it.
CREATE OR REPLACE FUNCTION public.pos_caller_has_rank(p_min text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(public.is_admin(), false)
      OR COALESCE(public.is_client_owner(), false)
      OR COALESCE((
           SELECT p.settlement_blocked_by IS NULL
              AND CASE p_min
                    WHEN 'staff'      THEN p.pos_role IN ('staff', 'supervisor', 'manager')
                    WHEN 'supervisor' THEN p.pos_role IN ('supervisor', 'manager')
                    WHEN 'manager'    THEN p.pos_role = 'manager'
                  END
             FROM profiles p
            WHERE p.id = (select auth.uid())), false)
$$;
REVOKE ALL ON FUNCTION public.pos_caller_has_rank(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pos_caller_has_rank(text) TO authenticated, service_role;

-- ── (1) pos_shifts ──────────────────────────────────────────────────────────────────────────────
--
-- pos_shifts_client is a plain same-client FOR ALL policy, so any till JWT — a Staff-rank waiter —
-- could open a shift, PATCH a closed shift's closing_cash / closing_report (the signed Z-report), or
-- DELETE it outright, which SET NULLs shift_id on every bill and cash movement it reconciled.
-- The only writers are PosShifts.jsx (supervisor page): INSERT an open shift, and one UPDATE that
-- closes it (`.eq('status','open')`). PosOrders/PosCustomers only read the open shift.
CREATE OR REPLACE FUNCTION public.pos_shifts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

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
    -- Attribution the subject can choose is not attribution.
    NEW.opened_by := (select auth.uid());
    NEW.opened_at := now();
    NEW.closed_at := NULL; NEW.closed_by := NULL; NEW.closing_cash := NULL;
    NEW.closing_denominations := NULL; NEW.closing_report := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE of an open shift. What it opened with is fixed; Expected Cash is measured from it.
  NEW.opened_by := OLD.opened_by;
  NEW.opened_at := OLD.opened_at;
  NEW.opening_cash := OLD.opening_cash;
  NEW.opening_denominations := OLD.opening_denominations;
  IF NEW.status = 'closed' THEN
    NEW.closed_by := (select auth.uid());
    NEW.closed_at := COALESCE(NEW.closed_at, now());
  ELSE
    NEW.closed_at := NULL; NEW.closed_by := NULL; NEW.closing_cash := NULL;
    NEW.closing_denominations := NULL; NEW.closing_report := NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_shifts_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_shifts_guard ON public.pos_shifts;
CREATE TRIGGER pos_shifts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_shifts
  FOR EACH ROW EXECUTE FUNCTION public.pos_shifts_guard();

DROP TRIGGER IF EXISTS audit_pos_shifts ON public.pos_shifts;
CREATE TRIGGER audit_pos_shifts
  AFTER INSERT OR DELETE OR UPDATE ON public.pos_shifts
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- ── (2) pos_cash_movements ──────────────────────────────────────────────────────────────────────
--
-- Writers: PosShifts.jsx Cash In / Cash Out (supervisor page), PosCustomers.jsx Credit settlement
-- (supervisor page), and — new — a credit note's cash refund (manager action). No screen edits or
-- deletes a movement. The table was empty on 2026-09-14, so the new CHECKs validate against nothing.

-- A refund hands cash back out of the drawer against a credit note.
ALTER TABLE public.pos_cash_movements
  ADD COLUMN IF NOT EXISTS pos_credit_note_id uuid REFERENCES public.pos_credit_notes(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.pos_cash_movements.pos_credit_note_id IS
  'S754: the credit note a kind=''refund'' movement paid out. SET NULL on delete (Danger Zone deletes notes before movements).';

ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_kind_check;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_kind_check
  CHECK (kind = ANY (ARRAY['pay_in'::text, 'pay_out'::text, 'credit_settlement'::text, 'refund'::text]));

-- Direction follows from kind, so a refund can only ever take cash OUT (expectedCashOf subtracts
-- every direction='out' movement) and a settlement only ever put it in.
ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_kind_direction_check;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_kind_direction_check
  CHECK ((kind IN ('pay_in', 'credit_settlement') AND direction = 'in')
      OR (kind IN ('pay_out', 'refund') AND direction = 'out'));

-- Only a refund names a credit note. (No "a refund MUST name one" CHECK: the SET NULL above would
-- then fail the Danger Zone delete. The trigger requires it on INSERT instead.)
ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_credit_note_only_refund;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_credit_note_only_refund
  CHECK (pos_credit_note_id IS NULL OR kind = 'refund');

-- One cash refund per note: a double tap or a retry after a lost response is a 23505, not the
-- drawer paid out twice. Also the index a "was this note refunded?" lookup reads.
CREATE UNIQUE INDEX IF NOT EXISTS pos_cash_movements_one_refund_per_note
  ON public.pos_cash_movements (pos_credit_note_id)
  WHERE kind = 'refund' AND pos_credit_note_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pos_cash_movements_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_shift_status text;
  v_note_net numeric;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

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
$$;
REVOKE ALL ON FUNCTION public.pos_cash_movements_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_cash_movements_guard ON public.pos_cash_movements;
CREATE TRIGGER pos_cash_movements_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.pos_cash_movements_guard();

DROP TRIGGER IF EXISTS audit_pos_cash_movements ON public.pos_cash_movements;
CREATE TRIGGER audit_pos_cash_movements
  AFTER INSERT OR DELETE OR UPDATE ON public.pos_cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- ── (3) settings ────────────────────────────────────────────────────────────────────────────────
--
-- The live body is 20260915090000's (S753). Carried forward unchanged: the three role lists and the
-- TADA settings. Added:
--
--   POS manager or Owner — written only from POS manager pages:
--     pos_bot_categories, pos_note_presets, pos_discount_reasons, pos_delivery_partners,
--     pos_reservation_settings (PosTableManagement.jsx, hasPosAccess('manager'));
--     pos_open_time, pos_close_time (CoversReport.jsx, manager);
--     pos_loyalty_point_value (PosCustomers.jsx → LoyaltyTab; the owner decision makes it manager).
--   Owner only — resolved at PRINT time on bills and credit notes (posOrderPrintHtml.js,
--   creditNoteHtml.js, viewPosBill.js), so a change reaches documents already issued; written today
--   only by admin screens (Settings → Property, ClientDrawer):
--     is_vat_registered, invoice_prefix, vat_number, property_address, property_phone,
--     payment_qr_data (the merchant QR a guest pays into — a waiter could point it at their own).
--
-- Comparison moves to jsonb so the column lists read as lists. On INSERT a column counts as set only
-- when it differs from its column DEFAULT — the old body compared against NULL, so a first settings
-- row written by a POS manager (a trial client has none) tripped the role-list check on
-- pos_custom_roles' '[]' default. The assertion block checks the baseline against the live defaults.
CREATE OR REPLACE FUNCTION public.settings_guard_staff_roles()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  c_insert_base constant jsonb := '{"hr_custom_roles": [], "ims_custom_roles": [], "pos_custom_roles": [], "is_vat_registered": true, "pos_loyalty_point_value": 1}'::jsonb;
  c_tada        constant text[] := ARRAY['tada_vehicle_rates', 'tada_purpose_options', 'tada_start_points'];
  c_pos_setup   constant text[] := ARRAY['pos_bot_categories', 'pos_note_presets', 'pos_discount_reasons', 'pos_delivery_partners',
                                         'pos_reservation_settings', 'pos_open_time', 'pos_close_time', 'pos_loyalty_point_value'];
  c_print       constant text[] := ARRAY['is_vat_registered', 'invoice_prefix', 'vat_number', 'property_address', 'property_phone', 'payment_qr_data'];
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
    FROM unnest(ARRAY['hr_custom_roles', 'ims_custom_roles', 'pos_custom_roles'] || c_tada || c_pos_setup || c_print) k
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
  IF v_changed && c_print THEN
    RAISE EXCEPTION 'invoice_settings_rank: only the Owner can change the invoice and VAT details printed on bills (%)',
      array_to_string(ARRAY(SELECT unnest(v_changed) INTERSECT SELECT unnest(c_print) ORDER BY 1), ', ')
      USING ERRCODE = '42501', HINT = 'invoice_settings_rank';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.settings_guard_staff_roles() FROM PUBLIC;
-- Trigger unchanged (20260914230000): BEFORE INSERT OR UPDATE ON settings.

-- ── (4) pos_tables ──────────────────────────────────────────────────────────────────────────────
--
-- Writers: PosTableManagement.jsx (manager page) inserts, renames, re-sections, re-sorts, deletes and
-- cycles status; PosOrders.jsx and its offline replay write `{ status: 'occupied' | 'available' }`
-- only, from any POS rank. No SECURITY DEFINER function writes pos_tables (checked live).
CREATE OR REPLACE FUNCTION public.pos_tables_guard_rank()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- Cheap test first: the till flips status on every seat and every bill.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'pos_tables_rank: only the Owner or a POS manager can add, rename, move or delete tables'
      USING ERRCODE = '42501', HINT = 'pos_tables_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_tables_guard_rank() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_tables_guard_rank ON public.pos_tables;
CREATE TRIGGER pos_tables_guard_rank
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_tables
  FOR EACH ROW EXECUTE FUNCTION public.pos_tables_guard_rank();

-- pos_orders.table_id has NO foreign key, so deleting a table under an open bill succeeds and the
-- bill vanishes from the floor with nobody able to reach it. Refused for EVERYONE, admin and service
-- role included — the Danger Zone deletes orders before tables, and a whole-client deletion is let
-- through (the clients row is already gone inside that cascade). SECURITY DEFINER so the check reads
-- every open order whatever the caller's RLS view; trigger functions need no EXECUTE grant.
CREATE OR REPLACE FUNCTION public.pos_tables_guard_open_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_order_no integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM clients WHERE id = OLD.client_id) THEN
    RETURN OLD;
  END IF;
  SELECT o.order_no INTO v_order_no
    FROM pos_orders o
   WHERE o.table_id = OLD.id AND o.status = 'open'
   ORDER BY o.opened_at DESC
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pos_table_has_open_order: % has an open bill (order #%) — bill or void it before deleting the table', OLD.name, COALESCE(v_order_no::text, '?')
      USING HINT = 'pos_table_has_open_order';
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_tables_guard_open_order_delete() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_tables_guard_open_order_delete ON public.pos_tables;
CREATE TRIGGER pos_tables_guard_open_order_delete
  BEFORE DELETE ON public.pos_tables
  FOR EACH ROW EXECUTE FUNCTION public.pos_tables_guard_open_order_delete();

-- ── (5) Loyalty ─────────────────────────────────────────────────────────────────────────────────
--
-- LoyaltyTab.jsx (inside PosCustomers, a supervisor page) is the only writer of schemes and of
-- pos_customers.loyalty_scheme_id. The bill-close customer upsert (PosOrders.jsx custRow) sends
-- name/phone/address/pan/updated_at and never loyalty_scheme_id, so an upsert leaves it untouched and
-- this guard never fires on a bill. A scheme delete SET NULLs members through the FK, which runs as
-- the table owner and passes the current_user seam.
CREATE OR REPLACE FUNCTION public.pos_loyalty_schemes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'loyalty_rank: only the Owner or a POS manager can create, change or delete a loyalty scheme'
      USING ERRCODE = '42501', HINT = 'loyalty_rank';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_loyalty_schemes_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_loyalty_schemes_guard ON public.pos_loyalty_schemes;
CREATE TRIGGER pos_loyalty_schemes_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_loyalty_schemes
  FOR EACH ROW EXECUTE FUNCTION public.pos_loyalty_schemes_guard();

CREATE OR REPLACE FUNCTION public.pos_customers_guard_loyalty()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- Cheap test first: this fires on every bill closed with a name and phone.
  IF (TG_OP = 'INSERT' AND NEW.loyalty_scheme_id IS NULL)
     OR (TG_OP = 'UPDATE' AND NEW.loyalty_scheme_id IS NOT DISTINCT FROM OLD.loyalty_scheme_id) THEN
    RETURN NEW;
  END IF;
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'loyalty_enrol_rank: only the Owner or a POS manager can enrol a customer in a loyalty scheme'
      USING ERRCODE = '42501', HINT = 'loyalty_enrol_rank';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_customers_guard_loyalty() FROM PUBLIC;
DROP TRIGGER IF EXISTS pos_customers_guard_loyalty ON public.pos_customers;
CREATE TRIGGER pos_customers_guard_loyalty
  BEFORE INSERT OR UPDATE ON public.pos_customers
  FOR EACH ROW EXECUTE FUNCTION public.pos_customers_guard_loyalty();

-- ── (6) get_pos_device_secret ───────────────────────────────────────────────────────────────────
--
-- Live body = 20260914190000. `IF NOT (is_client_owner() OR caller_pos_role = 'manager')` is NULL for
-- an IMS manager, HR manager or Self-Service login of the client (is_client_owner() false, pos_role
-- NULL → false OR NULL → NULL), `IF NOT NULL` never fires, and the device secret — the gate on the
-- anonymous PIN roster — was returned to them.
CREATE OR REPLACE FUNCTION public.get_pos_device_secret(p_client_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_pos_role  text;
  v_secret         uuid;
BEGIN
  IF COALESCE(public.is_admin(), false) THEN
    SELECT pos_device_secret INTO v_secret FROM client_secrets WHERE client_id = p_client_id;
    RETURN v_secret;
  END IF;

  SELECT COALESCE(p.active_client_id, p.client_id), p.pos_role INTO caller_client_id, caller_pos_role
  FROM profiles p WHERE p.id = auth.uid();

  IF caller_client_id IS DISTINCT FROM p_client_id THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF NOT COALESCE(public.is_client_owner() OR caller_pos_role = 'manager', false) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT pos_device_secret INTO v_secret FROM client_secrets WHERE client_id = p_client_id;
  RETURN v_secret;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_pos_device_secret(uuid) TO authenticated, service_role;

-- ── (7) The POS staff lists ─────────────────────────────────────────────────────────────────────
--
-- A leaver whose Final Settlement blocked their login (S753) stayed on the device's PIN picker, where
-- every tap failed. get_pos_staff (the picker) drops them; get_pos_staff_list (POS Staff) keeps them
-- and says so in a new last column, `settlement_blocked`.
CREATE OR REPLACE FUNCTION public.get_pos_staff(p_client_id uuid, p_device_secret uuid)
 RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.id, p.full_name, p.pos_role, p.pos_job_title
  FROM profiles p
  WHERE p.client_id = p_client_id
    AND p.pos_role IS NOT NULL
    AND p.pos_email IS NOT NULL
    AND p.settlement_blocked_by IS NULL
    AND EXISTS (
      SELECT 1 FROM client_secrets cs
      WHERE cs.client_id = p_client_id AND cs.pos_device_secret = p_device_secret
    )
  ORDER BY p.full_name;
$function$;
-- Anon-callable by design (the pre-login picker, gated by the device secret) — as 20260810180000.
GRANT EXECUTE ON FUNCTION public.get_pos_staff(uuid, uuid) TO anon, authenticated, service_role;

-- RETURNS TABLE changes, so DROP + CREATE (42P13), then the grants again.
DROP FUNCTION IF EXISTS public.get_pos_staff_list(uuid);
CREATE FUNCTION public.get_pos_staff_list(p_client_id uuid)
 RETURNS TABLE(id uuid, full_name text, pos_role text, pos_job_title text, pos_team text, last_seen_at timestamp with time zone, hr_employee_id uuid, employee_code text, pos_discount_limit numeric, pos_allow_void boolean, settlement_blocked boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  caller_client_id uuid;
  caller_role text;
BEGIN
  SELECT COALESCE(p.active_client_id, p.client_id), p.role INTO caller_client_id, caller_role
  FROM profiles p WHERE p.id = auth.uid();

  IF COALESCE(caller_role = 'admin' OR caller_client_id = p_client_id, false) THEN
    RETURN QUERY
      SELECT p.id, p.full_name, p.pos_role, p.pos_job_title, p.pos_team, p.last_seen_at,
             p.hr_employee_id, e.employee_code::text, p.pos_discount_limit, p.pos_allow_void,
             (p.settlement_blocked_by IS NOT NULL)
      FROM profiles p
      LEFT JOIN hr_employees e ON e.id = p.hr_employee_id
      WHERE p.client_id = p_client_id
        AND p.role = 'client'
        AND p.pos_email IS NOT NULL
      ORDER BY p.full_name;
  END IF;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) TO authenticated, service_role;

-- ── (8) submit_guest_order ──────────────────────────────────────────────────────────────────────
--
-- Live body = 20260914130000. Changes:
--   * qty is a whole number, 0..50: a guest cannot order 0.25 of a momo plate.
--   * Every refusal carries a stable code in HINT (the message text is unchanged, so an old bundle
--     still reads). PostgREST returns it as `hint`, supabase-js as `error.hint`:
--       table_not_found | not_accepting | inactive | empty | too_many_items | unavailable_items
--       | no_valid_items | pending
--   * A line naming a dish that is inactive, not on the POS, a Sub-Recipe, unpriced or not this
--     restaurant's refuses the WHOLE order (nothing inserted) with HINT 'unavailable_items' and
--     DETAIL = a JSON array of the dish names, e.g. ["Chicken Momo","Thukpa"] (a dish that no longer
--     exists at all is named "An item"). Before, those lines were skipped and the guest was shown an
--     order confirmation for food nobody would bring.
--   * no_valid_items remains for an order with no usable line at all (every line blank or qty 0).
-- pos_enabled stays the first gate after the table lookup (S632), and every other check is kept.
CREATE OR REPLACE FUNCTION public.submit_guest_order(
    p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL, p_covers integer DEFAULT 1
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_client_id uuid;
  v_table_status text;
  v_pos_enabled boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  v_unavailable text[] := '{}';
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
BEGIN
  SELECT t.client_id, t.status INTO v_client_id, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Table not found' USING HINT = 'table_not_found';
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  -- S746: the floor cannot open an inactive table, so an order for one would strand on a tile
  -- nobody can click.
  IF v_table_status = 'inactive' THEN
    RAISE EXCEPTION 'This table is not taking orders' USING HINT = 'inactive';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order is empty' USING HINT = 'empty';
  END IF;
  IF jsonb_array_length(p_items) > 30 THEN
    RAISE EXCEPTION 'Too many items in one order' USING HINT = 'too_many_items';
  END IF;

  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(recipe_id uuid, qty numeric, note text)
  LOOP
    IF item.recipe_id IS NULL THEN CONTINUE; END IF;
    v_qty := LEAST(GREATEST(FLOOR(COALESCE(item.qty, 0)), 0), 50);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_note := NULLIF(left(COALESCE(item.note, ''), 200), '');

    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.is_active, rc.pos_enabled INTO r
    FROM recipes rc
    WHERE rc.id = item.recipe_id AND rc.client_id = v_client_id;

    IF r.id IS NULL
       OR NOT COALESCE(r.is_active = true AND r.pos_enabled = true
                       AND r.category IS DISTINCT FROM 'Sub-Recipe' AND r.selling_price > 0, false) THEN
      v_unavailable := v_unavailable || COALESCE(NULLIF(btrim(r.name), ''), 'An item');
      CONTINUE;
    END IF;

    v_snapshot := v_snapshot || jsonb_build_object(
      'recipe_id', r.id, 'name', r.name, 'category', r.category,
      'unit_price', r.selling_price, 'vat_rate', r.vat_rate,
      'qty', v_qty, 'note', v_note
    );
  END LOOP;

  IF cardinality(v_unavailable) > 0 THEN
    RAISE EXCEPTION 'Some items in this order are no longer available'
      USING HINT = 'unavailable_items',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_unavailable) u ORDER BY 1))::text;
  END IF;

  IF jsonb_array_length(v_snapshot) = 0 THEN
    RAISE EXCEPTION 'No valid items in order' USING HINT = 'no_valid_items';
  END IF;

  BEGIN
    INSERT INTO pos_guest_order_requests (client_id, table_id, items, guest_notes, covers)
    VALUES (
      v_client_id, p_table_id, v_snapshot, NULLIF(left(COALESCE(p_notes, ''), 500), ''),
      LEAST(GREATEST(COALESCE(p_covers, 1), 1), 50)
    )
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This table already has an order request waiting for staff — please wait for it to be reviewed before sending another.'
      USING HINT = 'pending';
  END;

  RETURN v_request_id;
END;
$$;
-- Anon-callable by design (the public guest menu). CREATE OR REPLACE keeps grants; stated anyway.
GRANT EXECUTE ON FUNCTION public.submit_guest_order(uuid, jsonb, text, integer) TO anon, authenticated, service_role;

-- ── (9) pos_kot_log: Served ─────────────────────────────────────────────────────────────────────
--
-- new → in_progress → ready → served (cancelled beside them). No trigger or policy guards a status
-- transition on this table, so a waiter or the KDS at any POS rank can set served, as today for the
-- other stages. served_at mirrors started_at / ready_at.
ALTER TABLE public.pos_kot_log ADD COLUMN IF NOT EXISTS served_at timestamptz;
ALTER TABLE public.pos_kot_log DROP CONSTRAINT IF EXISTS pos_kot_log_status_check;
ALTER TABLE public.pos_kot_log ADD CONSTRAINT pos_kot_log_status_check
  CHECK (status = ANY (ARRAY['new'::text, 'in_progress'::text, 'ready'::text, 'served'::text, 'cancelled'::text]));

-- The guest tracker ranks an order by its least-advanced ticket and fell to 'new' (rank 0) for any
-- status it did not know — so serving a table would have sent the guest's tracker back to "order
-- placed". Served reads as ready there. Live body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.get_guest_table_status(p_table_id uuid)
 RETURNS TABLE(has_open_order boolean, kot_status text, remaining_minutes integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_pos_enabled boolean;
  v_order_id uuid;
  v_worst_rank int;
  v_max_ready_at timestamptz;
  r RECORD;
  rank int;
  ready_at_calc timestamptz;
BEGIN
  SELECT t.client_id INTO v_client_id FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    has_open_order := false; kot_status := NULL; remaining_minutes := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    has_open_order := false; kot_status := NULL; remaining_minutes := NULL; RETURN NEXT; RETURN;
  END IF;

  SELECT o.id INTO v_order_id FROM pos_orders o
  WHERE o.table_id = p_table_id AND o.status = 'open'
  ORDER BY o.opened_at DESC LIMIT 1;

  IF v_order_id IS NULL THEN
    has_open_order := false; kot_status := NULL; remaining_minutes := NULL; RETURN NEXT; RETURN;
  END IF;

  v_worst_rank := NULL;
  v_max_ready_at := NULL;
  FOR r IN SELECT status, started_at, estimated_prep_minutes FROM pos_kot_log WHERE order_id = v_order_id
  LOOP
    rank := CASE r.status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 2 ELSE 0 END;
    IF v_worst_rank IS NULL OR rank < v_worst_rank THEN v_worst_rank := rank; END IF;
    IF r.status = 'in_progress' AND r.started_at IS NOT NULL AND r.estimated_prep_minutes IS NOT NULL THEN
      ready_at_calc := r.started_at + (r.estimated_prep_minutes * interval '1 minute');
      IF v_max_ready_at IS NULL OR ready_at_calc > v_max_ready_at THEN v_max_ready_at := ready_at_calc; END IF;
    END IF;
  END LOOP;

  has_open_order := true;
  kot_status := CASE v_worst_rank WHEN 0 THEN 'new' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'ready' ELSE NULL END;
  remaining_minutes := CASE
    WHEN kot_status = 'in_progress' AND v_max_ready_at IS NOT NULL
      THEN CEIL(EXTRACT(EPOCH FROM (v_max_ready_at - now())) / 60)::integer
    ELSE NULL
  END;
  RETURN NEXT;
END;
$function$;

-- ── (10) Public booking capacity ────────────────────────────────────────────────────────────────
--
-- Live body = 20260904220000 with 'requested' in the status list, so every unanswered public request
-- took seats: a handful of requests (from anyone, on a public page) could show a slot as full to real
-- guests before the host had accepted any of them. Only accepted bookings fill a slot now. Read by
-- get_booking_availability and submit_reservation_request only; both run as owner, so this stays
-- INVOKER with no grant.
CREATE OR REPLACE FUNCTION public.reservation_hour_load(p_client_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE(day date, hour integer, covers integer)
  LANGUAGE sql STABLE
  SET search_path TO 'public'
  AS $$
  WITH live AS (
    SELECT (r.reserved_for AT TIME ZONE 'Asia/Kathmandu') AS s,
           (r.reserved_for AT TIME ZONE 'Asia/Kathmandu') + make_interval(mins => r.duration_minutes) AS e,
           r.party_size
    FROM pos_reservations r
    WHERE r.client_id = p_client_id
      AND r.status IN ('booked','confirmed','arrived','seated')
      -- A booking that STARTED before the window can still be sitting inside it.
      AND r.reserved_for >= p_from - interval '12 hours'
      AND r.reserved_for < p_to
  ),
  hours AS (
    SELECT gs AS h, l.party_size
    FROM live l,
         LATERAL generate_series(date_trunc('hour', l.s), l.e - interval '1 second', interval '1 hour') AS gs
  )
  SELECT h::date AS day, EXTRACT(hour FROM h)::integer AS hour, sum(party_size)::integer AS covers
  FROM hours
  GROUP BY 1, 2
$$;
REVOKE ALL ON FUNCTION public.reservation_hour_load(uuid, timestamptz, timestamptz) FROM PUBLIC;
-- x-forwarded-for in submit_reservation_request is deliberately NOT changed to its last hop: which hop
-- Supabase's proxy chain appends as trusted could not be confirmed from here (S754).

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
  k text;
  v_expr text;
  v_default jsonb;
  c_base constant jsonb := '{"hr_custom_roles": [], "ims_custom_roles": [], "pos_custom_roles": [], "is_vat_registered": true, "pos_loyalty_point_value": 1}'::jsonb;
BEGIN
  -- The row guards must be INVOKER, or current_user is the owner and they pass every caller.
  FOREACH v_fn IN ARRAY ARRAY['public.pos_shifts_guard()', 'public.pos_cash_movements_guard()', 'public.settings_guard_staff_roles()',
                              'public.pos_tables_guard_rank()', 'public.pos_loyalty_schemes_guard()', 'public.pos_customers_guard_loyalty()'] LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'S754: % must be SECURITY INVOKER', v_fn;
    END IF;
  END LOOP;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pos_tables_guard_open_order_delete()'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pos_caller_has_rank(text)'::regprocedure) THEN
    RAISE EXCEPTION 'S754: the open-order lookup and the rank helper must be SECURITY DEFINER';
  END IF;

  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
        ('pos_shifts_guard', 'audit_pos_shifts', 'pos_cash_movements_guard', 'audit_pos_cash_movements',
         'pos_tables_guard_rank', 'pos_tables_guard_open_order_delete', 'pos_loyalty_schemes_guard',
         'pos_customers_guard_loyalty', 'settings_guard_staff_roles')) <> 9 THEN
    RAISE EXCEPTION 'S754: a trigger is missing';
  END IF;

  IF has_function_privilege('anon', 'public.pos_caller_has_rank(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_pos_staff_list(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_pos_device_secret(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S754: an authenticated-only function is anon-executable';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.pos_caller_has_rank(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_pos_staff_list(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S754: authenticated lost EXECUTE on a function it needs';
  END IF;
  IF NOT has_function_privilege('anon', 'public.submit_guest_order(uuid, jsonb, text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_pos_staff(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S754: anon lost EXECUTE on a public pre-login function';
  END IF;
  IF (SELECT pronargs FROM pg_proc WHERE proname = 'submit_guest_order' AND pronamespace = 'public'::regnamespace) IS DISTINCT FROM 4::smallint
     OR (SELECT count(*) FROM pg_proc WHERE proname = 'submit_guest_order' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'S754: submit_guest_order must have exactly one (4-argument) signature';
  END IF;
  IF pg_get_functiondef('public.submit_guest_order(uuid, jsonb, text, integer)'::regprocedure) NOT LIKE '%pos_enabled%' THEN
    RAISE EXCEPTION 'S754: submit_guest_order no longer checks pos_enabled';
  END IF;

  -- The settings guard's INSERT baseline must equal the live column defaults, and no other guarded
  -- column may carry a default (it would read as "changed" on every insert).
  FOR k IN SELECT unnest(ARRAY['hr_custom_roles', 'ims_custom_roles', 'pos_custom_roles', 'tada_vehicle_rates', 'tada_purpose_options',
                               'tada_start_points', 'pos_bot_categories', 'pos_note_presets', 'pos_discount_reasons', 'pos_delivery_partners',
                               'pos_reservation_settings', 'pos_open_time', 'pos_close_time', 'pos_loyalty_point_value', 'is_vat_registered',
                               'invoice_prefix', 'vat_number', 'property_address', 'property_phone', 'payment_qr_data']) LOOP
    SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_expr
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.settings'::regclass AND a.attname = k AND NOT a.attisdropped;
    IF NOT FOUND THEN RAISE EXCEPTION 'S754: settings.% does not exist', k; END IF;
    IF v_expr IS NULL THEN
      v_default := NULL;
    ELSE
      EXECUTE format('SELECT to_jsonb(%s)', v_expr) INTO v_default;
    END IF;
    IF COALESCE(v_default, 'null'::jsonb) IS DISTINCT FROM COALESCE(c_base -> k, 'null'::jsonb) THEN
      RAISE EXCEPTION 'S754: settings.% default (%) disagrees with the guard''s insert baseline (%)', k, v_default, c_base -> k;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proargnames) a
                  WHERE p.oid = 'public.get_pos_staff_list(uuid)'::regprocedure AND a = 'settlement_blocked') THEN
    RAISE EXCEPTION 'S754: get_pos_staff_list does not return settlement_blocked';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
