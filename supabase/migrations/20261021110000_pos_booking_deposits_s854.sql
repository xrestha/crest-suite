-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S854: deposits for party bookings. A supervisor or manager takes money against a booking; the
-- guest gets a numbered DEPOSIT RECEIPT with no VAT on it; on the night the deposit pays part of the
-- bill as a TENDER; whatever is not used is refunded the way it came.
--
-- Owner decisions (S854, asked in plain words):
--   · A supervisor or a manager takes a deposit on a booking. The guest gets a numbered deposit
--     receipt with NO VAT on it: its own document and its own number series per outlet and fiscal
--     year, like the customer payment receipts of S843 (pos_credit_receipts).
--   · VAT is charged on the FINAL BILL only. On the night the full bill carries VAT as usual and the
--     deposit pays part of it as a TENDER (payment method 'Deposit'), never as a discount.
--   · ALWAYS REFUNDED. A cancellation, a no-show, or deposit money left over after the bill is
--     refunded, the same way it came (cash comes out of the drawer; eSewa, Card and the rest are
--     recorded as refunded by that method). A deposit is never kept.
--   · Cash deposits go into that shift's Expected Cash and cash refunds come out of it. A deposit is
--     not a sale.
--
-- Tender, not discount (pos-billing.md, S618). computeOrderAmounts applies discount_amount to the
-- pre-VAT base, so a deposit booked as a discount would lower the taxable value and the VAT remitted,
-- and guard_pos_order_close caps a discount by the cashier's discount permission. A tender touches
-- neither: the bill is VAT-charged in full and the deposit settles part of it, exactly like the
-- Loyalty leg. IMS revenue is unchanged (the post reads unit_price). The receipt carries no VAT because
-- the VAT document is the bill; a second VAT document would count it twice.
--
-- What this file changes:
--   1. 'Deposit' joins both payment_method CHECKs (pos_order_payments, pos_orders). The cashier never
--      PICKS it (not PAYMENT_METHODS); apply_booking_deposit writes the leg.
--   2. pos_booking_deposits: one row per deposit (number, booking, amount, method, what was used on
--      the bill, what was refunded, who and when, the shifts). Read by the outlet's logins; written
--      ONLY by the functions below (the guard refuses every client write but the operator's restore).
--      One LIVE deposit per booking (a partial unique index: a deposit with a balance left). A booking
--      whose deposit was refunded in full (cancelled, then reinstated) can take a new one.
--   3. pos_cash_movements: kinds 'deposit' (in) and 'deposit_refund' (out), each pinned to its
--      direction; booking_deposit_id names the deposit, one entry per deposit per kind.
--   4. record_booking_deposit / refund_booking_deposit (SECURITY DEFINER, Supervisor+, one
--      transaction each, idempotent on a request id) and apply_booking_deposit (the payment window's
--      one writer of the Deposit leg on an OPEN bill, as redeem_loyalty_points is of the Loyalty leg).
--   5. pos_orders_settle_booking_deposit, an AFTER UPDATE trigger: a Split charge that carries a
--      Deposit leg settles the deposit's used_amount in the close's own transaction.
--   6. Three live bodies patched in place at named anchors (each refuses unless its anchor occurs
--      exactly once; a re-run finds the S854 marker and skips):
--      · guard_pos_order_close: a Deposit leg belongs only on a Split charge. Any other close (Cash,
--        Card, QR, Credit, Complimentary, Void) hands it back through apply_booking_deposit(id, 0) in
--        the close's transaction, so a try that never finished cannot leave the deposit spent. A
--        whole-bill 'Deposit' method is refused (pos_deposit_split_only), and so is a Deposit leg
--        larger than the bill (pos_deposit_over_bill).
--      · guard_pos_order_payments_closed: a Deposit leg is never admitted after the close (the
--        Loyalty rule). Before the close no client can write any leg already (S809 1i).
--      · pos_cash_movements_guard: a client session cannot enter a deposit-kind entry by hand.
--
-- Expected Cash needs NO change. pos_shifts_guard (and its JS twin, expectedCashOf) count cash sales
-- as Cash bills plus the Cash legs of Split bills, so a Deposit leg is never counted as cash on the
-- night (its cash went in when it was taken), and they add every cash entry by DIRECTION, so the two
-- new kinds (each pinned to one direction below) count unchanged. Section 0 asserts the guard still
-- sums by direction. PosShifts.jsx only names the new kinds and lists deposits by method.
--
-- Credit-note cash cap: pos_bill_cash_taken counts a bill's Cash legs only, and is left so. A part of
-- a bill the deposit paid cannot be refunded as cash through a Credit Note's cash refund.
--
-- Decisions taken here (conservative and simple):
--   · A deposit pays at most ONE bill: its booking's own (pos_reservations.order_id). What the bill
--     does not use is refunded, never moved to another bill.
--   · A VOID or a Complimentary close hands the Deposit leg back before the bill closes, so nothing
--     is used and the whole deposit stays refundable.
--   · A Credit Note on a bill a deposit paid does NOT give the deposit back to the booking: the bill
--     stays the record of what the deposit paid (used_amount stands), and the note settles that money
--     with the guest. The note cash refund cannot pay out the deposit part (the cap above).
--   · A refund always returns the WHOLE remaining balance by the deposit's own method
--     (refund_method = method is a CHECK), once. Refused while the deposit is a Deposit leg on an
--     open bill: take it off the bill in the payment window first.
--   · Cash needs an open shift (taking or refunding); another method attaches to the open shift
--     when there is one, so the shift report can list deposits by method (as S843 receipts do).
--   · Audit: log_audit on a deposit's creation and deletion, and on an UPDATE that changes what was
--     used or refunded (the S843 receipts shape: attaching to and detaching from an open bill is
--     noise and is not audited).
--
-- Till build floor. A till before this release does not know the Deposit leg: its post-close leg
-- insert treats any non-Loyalty leg as "already recorded" and would leave a Split bill short. The
-- floor is raised to crest-v469 by a SEPARATE migration (20261021120000), applied only after Vercel
-- reports crest-v469 deployed; raised first, every till is refused with nothing newer to load.
--
-- Deploy order: this file (safe before the release: nothing an older bundle sends meets a new
-- refusal, and the new CHECK values are additive), then the frontend crest-v469, then
-- 20261021120000. admin-user-ops needs the Danger Zone lines below and a deploy.
--
-- Danger Zone (admin-user-ops, both deleteClientDataFor and clearModuleData 'pos'): delete
-- pos_cash_movements first (booking_deposit_id is NO ACTION), then pos_booking_deposits, BEFORE
-- pos_reservations (its composite key is NO ACTION), pos_orders (order_id NO ACTION) and pos_shifts.
-- Restore (restoreClientData.js RESTORE_ORDER): pos_booking_deposits after pos_reservations and
-- before pos_cash_movements. guard_pos_booking_deposits lets the operator's restore insert a row
-- dated before it (taken_at < now()); every other client write is refused.
--
-- To undo (only while no deposit exists): drop the trigger pos_orders_settle_booking_deposit and its
-- function, the three RPCs, re-run the three patched functions from their bodies with the S854
-- blocks removed, drop pos_cash_movements.booking_deposit_id and restore its kind CHECKs from
-- 20261015120000, drop pos_booking_deposits, and restore both payment_method CHECKs from
-- 20260827160000.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the helpers, and the anchors the patches below insert at ────────────────────
CREATE OR REPLACE FUNCTION pg_temp.s854_count(p_src text, p_needle text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (length(p_src) - length(replace(p_src, p_needle, ''))) / length(p_needle)
$$;

CREATE OR REPLACE FUNCTION pg_temp.s854_patch(p_src text, p_old text, p_new text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer;
BEGIN
  v_n := pg_temp.s854_count(p_src, p_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S854 patch: expected the old text once, found it % time(s): %', v_n, left(p_old, 120);
  END IF;
  RETURN replace(p_src, p_old, p_new);
END;
$$;

DO $$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.pos_invoice_fy(timestamp with time zone)') IS NULL
     OR to_regprocedure('public.pos_caller_has_rank(text)') IS NULL
     OR to_regprocedure('public.touch_updated_at()') IS NULL
     OR to_regprocedure('public.log_audit()') IS NULL
     OR to_regprocedure('public.record_credit_receipt(uuid, text, text, numeric, jsonb, text, text)') IS NULL THEN
    RAISE EXCEPTION 'S854 pre-flight: a function this file builds on is missing (is 20261015120000 live?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'pos_reservations_id_client_id_key'
                    AND conrelid = 'public.pos_reservations'::regclass) THEN
    RAISE EXCEPTION 'S854 pre-flight: pos_reservations has no (id, client_id) key (20261008120000)';
  END IF;

  -- guard_pos_order_close: the S809 2g handback stands, and the closer stamp occurs once.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF position('S854' IN v_src) = 0
     AND (pg_temp.s854_count(v_src, '    NEW.closed_by := (SELECT auth.uid());') <> 1
          OR position('PERFORM public.redeem_loyalty_points(NEW.id, 0);' IN v_src) = 0) THEN
    RAISE EXCEPTION 'S854 pre-flight: guard_pos_order_close is not the body this was written against. Re-read it live and move the anchor.';
  END IF;

  -- guard_pos_order_payments_closed: the Loyalty exclusion in the after-close admission, once.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.guard_pos_order_payments_closed()'::regprocedure;
  IF position('S854' IN v_src) = 0
     AND pg_temp.s854_count(v_src, 'n.payment_method = ''Loyalty'')') <> 1 THEN
    RAISE EXCEPTION 'S854 pre-flight: guard_pos_order_payments_closed is not the body this was written against (20261012170000).';
  END IF;

  -- pos_cash_movements_guard: the S843 block is in, and the creator stamp occurs once.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure;
  IF position('S854' IN v_src) = 0
     AND (position('S843' IN v_src) = 0
          OR pg_temp.s854_count(v_src, '  NEW.created_by := (select auth.uid());') <> 1) THEN
    RAISE EXCEPTION 'S854 pre-flight: pos_cash_movements_guard is not the S843 body this was written against.';
  END IF;

  -- Expected Cash on the server counts every cash entry by direction. If that ever changes, the two
  -- new kinds need their own terms there, in the same commit as PosShifts.jsx.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.pos_shifts_guard()'::regprocedure;
  IF position('FILTER (WHERE m.direction = ''in'')' IN v_src) = 0
     OR position('FILTER (WHERE m.direction = ''out'')' IN v_src) = 0
     OR position('m.shift_id = OLD.id' IN v_src) = 0 THEN
    RAISE EXCEPTION 'S854 pre-flight: pos_shifts_guard no longer sums cash entries by direction. Add the deposit kinds there first.';
  END IF;
END;
$$;


-- ── 1. 'Deposit' is a tender ───────────────────────────────────────────────────────────────────
-- Current lists from 20260827160000 (the last to set them). A leg on a Split bill; the bill-level list
-- carries it too for parity with 'Loyalty', but guard_pos_order_close refuses a whole-bill 'Deposit'
-- close (section 7): a deposit pays its part as a Split leg.
ALTER TABLE public.pos_order_payments DROP CONSTRAINT IF EXISTS pos_order_payments_payment_method_check;
ALTER TABLE public.pos_order_payments ADD CONSTRAINT pos_order_payments_payment_method_check
  CHECK (payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Loyalty'::text, 'Deposit'::text]));

ALTER TABLE public.pos_orders DROP CONSTRAINT IF EXISTS pos_orders_payment_method_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_payment_method_check
  CHECK (payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Credit'::text, 'Split'::text, 'Loyalty'::text, 'Deposit'::text]));


-- ── 2. The deposit table ───────────────────────────────────────────────────────────────────────
-- reservation_id is a composite key with client_id (the S809 shape: a deposit, its booking and its
-- bill belong to one outlet), NO ACTION: a booking holding money is never deleted from under it.
-- order_id (the bill it is on or paid) is NO ACTION for the credit receipt lines' reason: a delete
-- must never orphan money. A deposit pays at most one bill, so one column is enough.
CREATE TABLE IF NOT EXISTS public.pos_booking_deposits (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  reservation_id    uuid NOT NULL,
  invoice_fy        text NOT NULL,
  receipt_no        integer NOT NULL CHECK (receipt_no > 0),
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  method            text NOT NULL CHECK (method IN ('Cash', 'Card', 'eSewa', 'Khalti', 'FonePay')),
  used_amount       numeric(12,2) NOT NULL DEFAULT 0 CHECK (used_amount >= 0),
  refunded_amount   numeric(12,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  order_id          uuid REFERENCES public.pos_orders(id),
  shift_id          uuid REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
  taken_by          uuid DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE SET NULL,
  taken_at          timestamptz NOT NULL DEFAULT now(),
  refund_method     text,
  refunded_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  refunded_at       timestamptz,
  refund_shift_id   uuid REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
  request_id        uuid NOT NULL,
  refund_request_id uuid,
  notes             text CHECK (notes IS NULL OR length(notes) <= 300),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_booking_deposits_within CHECK (used_amount + refunded_amount <= amount),
  -- Refunded the way it came (owner decision): the method is the deposit's own.
  CONSTRAINT pos_booking_deposits_refund_same_way CHECK (refund_method IS NULL OR refund_method = method),
  CONSTRAINT pos_booking_deposits_refund_pair
    CHECK (COALESCE((refunded_amount > 0) = (refunded_at IS NOT NULL AND refund_method IS NOT NULL), false)),
  -- Used means used on a bill.
  CONSTRAINT pos_booking_deposits_used_on_bill CHECK (used_amount = 0 OR order_id IS NOT NULL),
  CONSTRAINT pos_booking_deposits_no_key UNIQUE (client_id, invoice_fy, receipt_no),
  CONSTRAINT pos_booking_deposits_request_key UNIQUE (request_id),
  CONSTRAINT pos_booking_deposits_refund_request_key UNIQUE (refund_request_id),
  CONSTRAINT pos_booking_deposits_reservation_fkey
    FOREIGN KEY (reservation_id, client_id) REFERENCES public.pos_reservations (id, client_id)
);

-- One live deposit per booking: a deposit with a balance left.
CREATE UNIQUE INDEX IF NOT EXISTS pos_booking_deposits_one_live
  ON public.pos_booking_deposits (reservation_id) WHERE used_amount + refunded_amount < amount;
-- The bookings list reads by reservation (and the composite key's own lookups).
CREATE INDEX IF NOT EXISTS pos_booking_deposits_reservation_idx ON public.pos_booking_deposits (reservation_id, client_id);
-- apply_booking_deposit and the close settle find the deposit on a bill.
CREATE INDEX IF NOT EXISTS pos_booking_deposits_order_idx ON public.pos_booking_deposits (order_id) WHERE order_id IS NOT NULL;
-- The shift report lists deposits taken and refunded on a shift.
CREATE INDEX IF NOT EXISTS pos_booking_deposits_shift_idx ON public.pos_booking_deposits (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_booking_deposits_refund_shift_idx ON public.pos_booking_deposits (refund_shift_id) WHERE refund_shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_booking_deposits_client_taken_idx ON public.pos_booking_deposits (client_id, taken_at);

COMMENT ON TABLE public.pos_booking_deposits IS
  'S854: money taken in advance against a booking. A numbered deposit receipt with its own series per outlet and fiscal year and no VAT (VAT is charged on the final bill). It pays its booking bill as a Deposit tender (used_amount, order_id); whatever is left is always refunded the way it came. Written only by record_booking_deposit, refund_booking_deposit, apply_booking_deposit and the close settle trigger.';

-- updated_at by the one trigger function this schema uses for it (supabase-sql.md).
DROP TRIGGER IF EXISTS pos_booking_deposits_touch ON public.pos_booking_deposits;
CREATE TRIGGER pos_booking_deposits_touch
  BEFORE UPDATE ON public.pos_booking_deposits
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- ── 3. RLS, the staff-isolation trio, grants ───────────────────────────────────────────────────
-- Reads: the outlet's logins (my_client_id(), never its body) and the operator. POS PIN staff are
-- not fenced out: a staff-rank login sees the Refund due badge, and the payment window reads the
-- balance. Writes: none for a client session but the operator's restore INSERT (admin-only policy
-- and the guard below). Every other write is the DEFINER functions'.
ALTER TABLE public.pos_booking_deposits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_booking_deposits_read ON public.pos_booking_deposits;
CREATE POLICY pos_booking_deposits_read ON public.pos_booking_deposits
  FOR SELECT TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

DROP POLICY IF EXISTS pos_booking_deposits_restore ON public.pos_booking_deposits;
CREATE POLICY pos_booking_deposits_restore ON public.pos_booking_deposits
  FOR INSERT TO authenticated
  WITH CHECK (COALESCE((SELECT public.is_admin()), false));

-- The trio every pos_* business table carries (the S843 receipts list), so a bare same-client policy
-- cannot reopen this table to HR Self-Service, IMS or HR-role logins.
DO $do$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS no_self_service_accounts ON public.pos_booking_deposits';
  EXECUTE 'DROP POLICY IF EXISTS no_ims_staff ON public.pos_booking_deposits';
  EXECUTE 'DROP POLICY IF EXISTS no_hr_role_staff ON public.pos_booking_deposits';
  EXECUTE 'CREATE POLICY no_self_service_accounts ON public.pos_booking_deposits AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())';
  EXECUTE 'CREATE POLICY no_ims_staff ON public.pos_booking_deposits AS RESTRICTIVE FOR ALL USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff())';
  EXECUTE 'CREATE POLICY no_hr_role_staff ON public.pos_booking_deposits AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff())';
END;
$do$;

REVOKE ALL ON public.pos_booking_deposits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.pos_booking_deposits TO authenticated;
GRANT ALL ON public.pos_booking_deposits TO service_role;


-- ── 4. The guard: a deposit is written by its functions only ───────────────────────────────────
-- SECURITY INVOKER with the current_user seam: the DEFINER functions, the close settle trigger, the
-- service role and an FK cascade (which runs as the owner) pass; a client session meets the rest.
CREATE OR REPLACE FUNCTION public.guard_pos_booking_deposits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The operator's restore re-inserts a deposit as it was first taken (the S809 1l shape).
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND NEW.taken_at < now() THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_booking_deposit_locked: a booking deposit is recorded, used and refunded only by Crest itself (Take deposit and Refund on Reservations, the Deposit line in the payment window), never by hand, and it is never deleted'
    USING ERRCODE = '42501', HINT = 'pos_booking_deposit_locked';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_pos_booking_deposits() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_pos_booking_deposits ON public.pos_booking_deposits;
CREATE TRIGGER guard_pos_booking_deposits
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_booking_deposits
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_booking_deposits();

-- Audit: creation, Danger Zone deletion, and a change to what was used or refunded.
DROP TRIGGER IF EXISTS audit_pos_booking_deposits_ins_del ON public.pos_booking_deposits;
CREATE TRIGGER audit_pos_booking_deposits_ins_del
  AFTER INSERT OR DELETE ON public.pos_booking_deposits
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
DROP TRIGGER IF EXISTS audit_pos_booking_deposits_money ON public.pos_booking_deposits;
CREATE TRIGGER audit_pos_booking_deposits_money
  AFTER UPDATE ON public.pos_booking_deposits
  FOR EACH ROW WHEN (OLD.used_amount IS DISTINCT FROM NEW.used_amount
                  OR OLD.refunded_amount IS DISTINCT FROM NEW.refunded_amount)
  EXECUTE FUNCTION public.log_audit();


-- ── 5. pos_cash_movements: a cash deposit in, a cash refund out ────────────────────────────────
ALTER TABLE public.pos_cash_movements
  ADD COLUMN IF NOT EXISTS booking_deposit_id uuid REFERENCES public.pos_booking_deposits(id);

ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_kind_check;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_kind_check
  CHECK (kind IN ('pay_in', 'pay_out', 'credit_settlement', 'refund', 'credit_receipt_cancel', 'deposit', 'deposit_refund'));

ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_kind_direction_check;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_kind_direction_check
  CHECK (COALESCE((kind IN ('pay_in', 'credit_settlement', 'deposit') AND direction = 'in')
               OR (kind IN ('pay_out', 'refund', 'credit_receipt_cancel', 'deposit_refund') AND direction = 'out'), false));

-- A deposit kind always names its deposit, and only a deposit kind does.
ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_deposit_kinds;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_deposit_kinds
  CHECK (COALESCE((booking_deposit_id IS NOT NULL) = (kind IN ('deposit', 'deposit_refund')), false));

-- A deposit's Cash In happens once, and its refund's Cash Out once.
CREATE UNIQUE INDEX IF NOT EXISTS pos_cash_movements_one_per_deposit_kind
  ON public.pos_cash_movements (booking_deposit_id, kind) WHERE booking_deposit_id IS NOT NULL;


-- ── 6. The three functions ─────────────────────────────────────────────────────────────────────
-- Each is SECURITY DEFINER with its own caller checks, every one wrapped in COALESCE(…, false) (an
-- is_admin() or a rank test can be NULL, and IF NOT NULL never fires). Attribution is auth.uid(),
-- never a parameter. The outlet is the caller's own (my_client_id(), the S843 receipts shape), so
-- Crest support records nothing for an outlet it is only viewing.

-- 6a. Taking a deposit. p_request_id makes a lost answer safe to resend: the same id returns the first
-- deposit (replayed true). Cash needs an open shift, read FOR SHARE as a bill's close takes it, so a
-- Close Shift waits for this deposit and counts its Cash In.
CREATE OR REPLACE FUNCTION public.record_booking_deposit(
  p_reservation_id uuid,
  p_amount         numeric,
  p_method         text,
  p_request_id     uuid,
  p_note           text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid    uuid := (SELECT auth.uid());
  v_client uuid := public.my_client_id();
  v_res    public.pos_reservations%ROWTYPE;
  v_row    public.pos_booking_deposits%ROWTYPE;
  v_shift  uuid;
  v_fy     text;
  v_no     integer;
BEGIN
  IF v_uid IS NULL OR v_client IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_auth: sign in to the outlet to take a deposit'
      USING ERRCODE = '42501', HINT = 'booking_deposit_auth';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION 'booking_deposit_rank: taking a booking deposit needs a POS supervisor, a POS manager or the Owner'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_bad: the deposit has no request id' USING HINT = 'booking_deposit_bad';
  END IF;

  -- A retry of a press whose answer was lost: the first deposit, unchanged.
  SELECT * INTO v_row FROM public.pos_booking_deposits WHERE client_id = v_client AND request_id = p_request_id;
  IF FOUND THEN
    SELECT * INTO v_res FROM public.pos_reservations WHERE id = v_row.reservation_id;
    RETURN to_jsonb(v_row) || jsonb_build_object(
      'replayed', true,
      'balance', round(v_row.amount - v_row.used_amount - v_row.refunded_amount, 2),
      'customer_name', v_res.customer_name, 'party_size', v_res.party_size, 'reserved_for', v_res.reserved_for);
  END IF;

  IF p_method IS NULL OR p_method NOT IN ('Cash', 'Card', 'eSewa', 'Khalti', 'FonePay') THEN
    RAISE EXCEPTION 'booking_deposit_bad: % is not a way a deposit can be paid (Cash, Card, eSewa, Khalti or FonePay)', COALESCE(p_method, 'no method')
      USING HINT = 'booking_deposit_bad';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) OR p_amount >= 10000000000 THEN
    RAISE EXCEPTION 'booking_deposit_bad: the deposit must be more than zero, to the paisa'
      USING HINT = 'booking_deposit_bad';
  END IF;

  -- The booking, locked: two presses (two tablets) on one booking queue, and the second meets the first.
  SELECT * INTO v_res FROM public.pos_reservations
   WHERE id = p_reservation_id AND client_id = v_client
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_deposit_no_booking: that booking is not on this outlet records'
      USING HINT = 'booking_deposit_no_booking';
  END IF;
  IF v_res.status NOT IN ('requested', 'booked', 'confirmed', 'arrived') THEN
    RAISE EXCEPTION 'booking_deposit_booking_closed: this booking is % now, so it takes no deposit', v_res.status
      USING HINT = 'booking_deposit_booking_closed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_booking_deposits d
              WHERE d.reservation_id = v_res.id AND d.used_amount + d.refunded_amount < d.amount) THEN
    RAISE EXCEPTION 'booking_deposit_exists: this booking already holds a deposit, so a second one was not taken — refund it first to take a different amount'
      USING HINT = 'booking_deposit_exists';
  END IF;

  -- The drawer, as a bill's close takes it.
  SELECT s.id INTO v_shift FROM public.pos_shifts s
   WHERE s.client_id = v_client AND s.status = 'open'
   ORDER BY s.opened_at DESC LIMIT 1 FOR SHARE;
  IF p_method = 'Cash' AND v_shift IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_no_shift: no shift is open, so this cash has no drawer to go in — open a shift first, or record how the money really came'
      USING HINT = 'booking_deposit_no_shift';
  END IF;

  -- The number: per outlet and fiscal year, as the payment receipts are numbered.
  v_fy := public.pos_invoice_fy(now());
  IF v_fy IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_bad: the date is past the end of the Nepali calendar Crest knows, so no receipt number can be given — contact Crest support'
      USING HINT = 'booking_deposit_bad';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pos_booking_deposit_no:' || v_client::text || ':' || v_fy));
  SELECT COALESCE(max(receipt_no), 0) + 1 INTO v_no
    FROM public.pos_booking_deposits WHERE client_id = v_client AND invoice_fy = v_fy;

  INSERT INTO public.pos_booking_deposits
    (client_id, reservation_id, invoice_fy, receipt_no, amount, method, shift_id, taken_by, taken_at,
     request_id, notes)
  VALUES
    (v_client, v_res.id, v_fy, v_no, p_amount, p_method, v_shift, v_uid, now(),
     p_request_id, NULLIF(left(btrim(COALESCE(p_note, '')), 300), ''))
  RETURNING * INTO v_row;

  -- Cash goes in the drawer now: one entry for the deposit. DEFINER passes the cash guard, so this
  -- body stamps what that guard would.
  IF p_method = 'Cash' THEN
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, booking_deposit_id, reason, created_by)
    VALUES (v_client, v_shift, 'in', 'deposit', p_amount, v_row.id,
            left(format('Deposit DP-%s (%s) — %s', v_no, v_fy, v_res.customer_name), 500), v_uid);
  END IF;

  RETURN to_jsonb(v_row) || jsonb_build_object(
    'replayed', false,
    'balance', v_row.amount,
    'customer_name', v_res.customer_name, 'party_size', v_res.party_size, 'reserved_for', v_res.reserved_for);
END;
$$;
REVOKE ALL ON FUNCTION public.record_booking_deposit(uuid, numeric, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_booking_deposit(uuid, numeric, text, uuid, text) TO authenticated, service_role;


-- 6b. Refunding a deposit: the WHOLE balance left, the way it came, once. Refused while it is a
-- Deposit leg on an open bill (take it off in the payment window first). A Cash refund leaves the
-- OPEN shift drawer as its own entry. The same p_request_id returns the first refund.
CREATE OR REPLACE FUNCTION public.refund_booking_deposit(p_deposit_id uuid, p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid     uuid := (SELECT auth.uid());
  v_client  uuid := public.my_client_id();
  v_dep     public.pos_booking_deposits%ROWTYPE;
  v_res     public.pos_reservations%ROWTYPE;
  v_balance numeric;
  v_shift   uuid;
BEGIN
  IF v_uid IS NULL OR v_client IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_auth: sign in to the outlet to refund a deposit'
      USING ERRCODE = '42501', HINT = 'booking_deposit_auth';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION 'booking_deposit_rank: refunding a booking deposit needs a POS supervisor, a POS manager or the Owner'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_bad: the refund has no request id' USING HINT = 'booking_deposit_bad';
  END IF;

  -- A retry of a press whose answer was lost: the first refund, unchanged.
  SELECT * INTO v_dep FROM public.pos_booking_deposits WHERE client_id = v_client AND refund_request_id = p_request_id;
  IF FOUND THEN
    SELECT * INTO v_res FROM public.pos_reservations WHERE id = v_dep.reservation_id;
    RETURN to_jsonb(v_dep) || jsonb_build_object(
      'replayed', true, 'refunded_now', v_dep.refunded_amount,
      'balance', round(v_dep.amount - v_dep.used_amount - v_dep.refunded_amount, 2),
      'customer_name', v_res.customer_name, 'party_size', v_res.party_size, 'reserved_for', v_res.reserved_for);
  END IF;

  SELECT * INTO v_dep FROM public.pos_booking_deposits
   WHERE id = p_deposit_id AND client_id = v_client
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_deposit_missing: that deposit is not on this outlet records'
      USING HINT = 'booking_deposit_missing';
  END IF;
  SELECT * INTO v_res FROM public.pos_reservations WHERE id = v_dep.reservation_id;

  v_balance := round(v_dep.amount - v_dep.used_amount - v_dep.refunded_amount, 2);
  IF v_balance <= 0 THEN
    RAISE EXCEPTION 'booking_deposit_nothing_left: nothing is left on this deposit to refund (NPR % was used on the bill and NPR % refunded already)',
      v_dep.used_amount, v_dep.refunded_amount
      USING HINT = 'booking_deposit_nothing_left';
  END IF;

  -- On an open bill as its Deposit line: the bill would be short of it.
  IF v_dep.order_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.pos_orders o
                  WHERE o.id = v_dep.order_id AND o.status = 'open')
     AND EXISTS (SELECT 1 FROM public.pos_order_payments p
                  WHERE p.order_id = v_dep.order_id AND p.payment_method = 'Deposit') THEN
    RAISE EXCEPTION 'booking_deposit_on_open_bill: this deposit is on an open bill as its Deposit line, so it was not refunded — take it off the bill in the payment window (or charge the bill) first'
      USING HINT = 'booking_deposit_on_open_bill';
  END IF;

  SELECT s.id INTO v_shift FROM public.pos_shifts s
   WHERE s.client_id = v_client AND s.status = 'open'
   ORDER BY s.opened_at DESC LIMIT 1 FOR SHARE;
  IF v_dep.method = 'Cash' AND v_shift IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_refund_no_shift: no shift is open, so the cash cannot come out of a drawer — open a shift first, then refund'
      USING HINT = 'booking_deposit_refund_no_shift';
  END IF;

  UPDATE public.pos_booking_deposits
     SET refunded_amount = refunded_amount + v_balance,
         refund_method = method,
         refunded_by = v_uid,
         refunded_at = now(),
         refund_shift_id = v_shift,
         refund_request_id = p_request_id
   WHERE id = v_dep.id
  RETURNING * INTO v_dep;

  IF v_dep.method = 'Cash' THEN
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, booking_deposit_id, reason, created_by)
    VALUES (v_client, v_shift, 'out', 'deposit_refund', v_balance, v_dep.id,
            left(format('Deposit DP-%s (%s) refunded — %s', v_dep.receipt_no, v_dep.invoice_fy, v_res.customer_name), 500), v_uid);
  END IF;

  RETURN to_jsonb(v_dep) || jsonb_build_object(
    'replayed', false, 'refunded_now', v_balance, 'balance', 0,
    'customer_name', v_res.customer_name, 'party_size', v_res.party_size, 'reserved_for', v_res.reserved_for);
END;
$$;
REVOKE ALL ON FUNCTION public.refund_booking_deposit(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_booking_deposit(uuid, uuid) TO authenticated, service_role;


-- 6c. The Deposit leg on an OPEN bill: the payment window calls it at Charge time, and with 0 to hand
-- it back. Who may call it mirrors redeem_loyalty_points: the bill outlet (or the operator) and
-- Supervisor rank, the rank every close needs. One live leg per bill: an earlier one is handed back
-- first and replaced, never stacked. The deposit is the one already on this bill, else the one of
-- the booking seated on it (pos_reservations.order_id). Returns the amount now on the bill (numeric,
-- 0 for a handback), as redeem_loyalty_points does.
CREATE OR REPLACE FUNCTION public.apply_booking_deposit(p_order_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid     uuid := (SELECT auth.uid());
  v_order   record;
  v_dep     public.pos_booking_deposits%ROWTYPE;
  v_n       integer;
  v_balance numeric;
  v_gross   numeric;
  v_maxvat  numeric;
  v_other   numeric;
BEGIN
  IF p_amount IS NULL OR p_amount < 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'booking_deposit_bad: the amount taken from the deposit must be zero or more, to the paisa'
      USING HINT = 'booking_deposit_bad';
  END IF;

  -- Locked: two presses on one bill (a double tap, two tablets) queue.
  SELECT o.id, o.client_id, o.status INTO v_order
    FROM public.pos_orders o WHERE o.id = p_order_id
    FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'booking_deposit_no_bill: that bill was not found' USING HINT = 'booking_deposit_no_bill';
  END IF;
  IF NOT COALESCE(public.is_admin() OR v_order.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'booking_deposit_auth: that bill is not this outlet bill'
      USING ERRCODE = '42501', HINT = 'booking_deposit_auth';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION 'booking_deposit_rank: a deposit is used while taking payment, which needs a POS supervisor, a POS manager or the Owner'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;
  IF v_order.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'booking_deposit_bill_closed: a deposit is used while the bill is being closed, and this bill is already closed'
      USING HINT = 'booking_deposit_bill_closed';
  END IF;

  -- What stands on this bill goes first: its leg removed, the deposit freed. Done before anything is
  -- looked up, so a handback works whatever has happened to the booking since.
  SELECT * INTO v_dep FROM public.pos_booking_deposits d
   WHERE d.order_id = p_order_id AND d.client_id = v_order.client_id AND d.used_amount = 0
   FOR UPDATE;
  DELETE FROM public.pos_order_payments WHERE order_id = p_order_id AND payment_method = 'Deposit';
  IF v_dep.id IS NOT NULL THEN
    UPDATE public.pos_booking_deposits SET order_id = NULL WHERE id = v_dep.id;
  END IF;

  IF p_amount = 0 THEN
    RETURN 0;
  END IF;

  -- The deposit of the booking seated on this bill, with a balance left.
  SELECT count(*) INTO v_n
    FROM public.pos_booking_deposits d
    JOIN public.pos_reservations r ON r.id = d.reservation_id AND r.client_id = d.client_id
   WHERE r.order_id = p_order_id AND r.client_id = v_order.client_id
     AND d.used_amount + d.refunded_amount < d.amount;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'booking_deposit_none: no booking with a deposit left is seated on this bill, so no deposit was used'
      USING HINT = 'booking_deposit_none';
  END IF;
  IF v_n > 1 THEN
    RAISE EXCEPTION 'booking_deposit_ambiguous: % bookings with a deposit are seated on this bill, so Crest cannot tell which to use — refund the ones not paying this bill first', v_n
      USING HINT = 'booking_deposit_ambiguous';
  END IF;
  SELECT d.* INTO v_dep
    FROM public.pos_booking_deposits d
    JOIN public.pos_reservations r ON r.id = d.reservation_id AND r.client_id = d.client_id
   WHERE r.order_id = p_order_id AND r.client_id = v_order.client_id
     AND d.used_amount + d.refunded_amount < d.amount
   FOR UPDATE OF d;
  IF v_dep.used_amount > 0 THEN
    RAISE EXCEPTION 'booking_deposit_already_used: this deposit already paid part of another bill, and what is left is refunded, never moved to a second bill'
      USING HINT = 'booking_deposit_already_used';
  END IF;
  IF v_dep.order_id IS NOT NULL AND v_dep.order_id <> p_order_id THEN
    RAISE EXCEPTION 'booking_deposit_on_other_bill: this deposit is already on another open bill, so it was not used here — take it off that bill first'
      USING HINT = 'booking_deposit_on_other_bill';
  END IF;

  v_balance := round(v_dep.amount - v_dep.used_amount - v_dep.refunded_amount, 2);
  IF p_amount > v_balance + 0.005 THEN
    RAISE EXCEPTION 'booking_deposit_over_balance: the deposit has NPR % left, less than the NPR % asked for, so none of it was used', v_balance, p_amount
      USING HINT = 'booking_deposit_over_balance';
  END IF;

  -- Cap: an UPPER BOUND on the bill (redeem_loyalty_points' own): the stored lines that are not comped,
  -- at their highest VAT rate, plus a rupee of rounding, less any other leg already on the bill (a
  -- points line). The close checks the exact figure (pos_deposit_over_bill).
  SELECT COALESCE(SUM(qty * unit_price), 0), COALESCE(MAX(vat_rate), 0)
    INTO v_gross, v_maxvat
    FROM public.pos_order_items
   WHERE order_id = p_order_id AND COALESCE(comped, false) = false;
  SELECT COALESCE(SUM(amount), 0) INTO v_other
    FROM public.pos_order_payments WHERE order_id = p_order_id;
  IF v_gross <= 0 OR p_amount > v_gross * (1 + GREATEST(v_maxvat, 0)) + 1 - v_other THEN
    RAISE EXCEPTION 'booking_deposit_over_bill: NPR % of the deposit is more than this bill comes to, so none of it was used — use no more than the bill total', p_amount
      USING HINT = 'booking_deposit_over_bill';
  END IF;

  INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount, recorded_by)
  VALUES (p_order_id, v_order.client_id, 'Deposit', p_amount, v_uid);
  UPDATE public.pos_booking_deposits SET order_id = p_order_id WHERE id = v_dep.id;

  RETURN p_amount;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_booking_deposit(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_booking_deposit(uuid, numeric) TO authenticated, service_role;


-- 6d. The close settles what the bill used. AFTER UPDATE, so it sees the bill as closed and runs only
-- when the close itself has passed every BEFORE check; SECURITY DEFINER, so it passes the deposit
-- guard (a trigger function needs no EXECUTE grant). A Split charge with a Deposit leg and no deposit
-- on the bill is refused rather than closed with money that came from nowhere.
CREATE OR REPLACE FUNCTION public.pos_orders_settle_booking_deposit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_leg numeric;
  v_dep public.pos_booking_deposits%ROWTYPE;
BEGIN
  SELECT COALESCE(sum(p.amount), 0) INTO v_leg
    FROM public.pos_order_payments p
   WHERE p.order_id = NEW.id AND p.payment_method = 'Deposit';
  IF v_leg <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_dep FROM public.pos_booking_deposits d
   WHERE d.order_id = NEW.id AND d.client_id = NEW.client_id AND d.used_amount = 0
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_orders: this bill carries a Deposit payment line but no booking deposit is on it, so the bill was not closed and nothing was charged — take the deposit off in the payment window and add it again'
      USING ERRCODE = 'P0001', HINT = 'pos_deposit_missing';
  END IF;
  IF v_leg > v_dep.amount - v_dep.refunded_amount + 0.005 THEN
    RAISE EXCEPTION 'pos_orders: the Deposit line (NPR %) is more than the deposit has left (NPR %), so the bill was not closed and nothing was charged',
      round(v_leg, 2), round(v_dep.amount - v_dep.refunded_amount, 2)
      USING ERRCODE = 'P0001', HINT = 'booking_deposit_over_balance';
  END IF;

  UPDATE public.pos_booking_deposits SET used_amount = round(v_leg, 2) WHERE id = v_dep.id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_orders_settle_booking_deposit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pos_orders_settle_booking_deposit ON public.pos_orders;
CREATE TRIGGER pos_orders_settle_booking_deposit
  AFTER UPDATE ON public.pos_orders
  FOR EACH ROW
  WHEN (OLD.status = 'open' AND NEW.status = 'billed' AND NEW.close_type = 'paid' AND NEW.payment_method = 'Split')
  EXECUTE FUNCTION public.pos_orders_settle_booking_deposit();


-- ── 7. The three live bodies, patched at their anchors ─────────────────────────────────────────
-- guard_pos_order_close: just before the closer is stamped, after the S809 2g points handback.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.guard_pos_order_close()'::regprocedure);
BEGIN
  IF position('S854' IN v_def) > 0 THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_temp.s854_patch(v_def,
$o$    NEW.closed_by := (SELECT auth.uid());$o$,
$n$    -- ── S854: a booking deposit pays only as a Split leg, never more than the bill ─────────────
    -- apply_booking_deposit writes the Deposit leg on the open bill when the payment window charges.
    -- The deposit pays its part of a Split charge; a whole-bill 'Deposit' method is refused. Any close
    -- that is not a Split charge (Cash, Card, QR, Credit, Complimentary, Void) hands a standing Deposit
    -- leg back here, in the close transaction, through apply_booking_deposit(id, 0), the one writer of
    -- that leg: the deposit stays whole and refundable, and if anything refuses the close the handback
    -- is undone with it. On a Split charge the leg may not exceed the bill. The leg is read as the
    -- caller (pos_order_payments carries the pos_orders client policy). What the bill used is settled
    -- by pos_orders_settle_booking_deposit (AFTER UPDATE).
    IF COALESCE(NEW.close_type = 'paid' AND NEW.payment_method = 'Deposit', false) THEN
      RAISE EXCEPTION 'pos_orders: a booking deposit pays its part of a bill as a Split payment line, never as the method of the whole bill, so the bill was not closed and nothing was charged — charge it as Split with the Deposit line'
        USING ERRCODE = '22023', HINT = 'pos_deposit_split_only';
    END IF;
    IF COALESCE(NEW.close_type = 'paid' AND NEW.payment_method = 'Split', false) THEN
      IF (SELECT COALESCE(sum(p.amount), 0) FROM pos_order_payments p
           WHERE p.order_id = NEW.id AND p.payment_method = 'Deposit') > COALESCE(NEW.paid_amount, 0) + 0.01 THEN
        RAISE EXCEPTION 'pos_orders: the booking deposit line is more than this bill total (NPR %), so the bill was not closed and nothing was charged — take less from the deposit in the payment window and charge again',
          round(COALESCE(NEW.paid_amount, 0), 2)
          USING ERRCODE = 'P0001', HINT = 'pos_deposit_over_bill';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM pos_order_payments p
                   WHERE p.order_id = NEW.id AND p.payment_method = 'Deposit') THEN
      PERFORM public.apply_booking_deposit(NEW.id, 0);
    END IF;
    -- ── end S854 ──

    NEW.closed_by := (SELECT auth.uid());$n$);
  EXECUTE v_def;
END;
$do$;

-- guard_pos_order_payments_closed: a leg arriving after the close is admitted for a Split bill from its
-- closer only, and never a Loyalty leg; now never a Deposit leg either (it is written before the close
-- by apply_booking_deposit, which passes this guard as its owner).
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.guard_pos_order_payments_closed()'::regprocedure);
BEGIN
  IF position('S854' IN v_def) > 0 THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_temp.s854_patch(v_def,
$o$n.payment_method = 'Loyalty')$o$,
$n$n.payment_method IN ('Loyalty', 'Deposit'))   -- S854: nor a Deposit leg$n$);
  EXECUTE v_def;
END;
$do$;

-- pos_cash_movements_guard: before created_by is stamped (every check above it still runs), after the
-- S843 receipt block. The operator restore returns earlier in the body and is unaffected.
DO $do$
DECLARE
  v_def text := pg_get_functiondef('public.pos_cash_movements_guard()'::regprocedure);
BEGIN
  IF position('S854' IN v_def) > 0 THEN
    RETURN; -- a re-run
  END IF;
  v_def := pg_temp.s854_patch(v_def,
$o$  NEW.created_by := (select auth.uid());$o$,
$n$  -- ── S854: a booking deposit and its refund put their own cash on the drawer ──────────────
  IF NEW.booking_deposit_id IS NOT NULL OR NEW.kind IN ('deposit', 'deposit_refund') THEN
    RAISE EXCEPTION 'pos_cash_deposit_direct: a booking deposit and its refund are recorded on Reservations, which puts their cash on the drawer itself, so this entry was not recorded'
      USING ERRCODE = '42501', HINT = 'pos_cash_deposit_direct';
  END IF;
  -- ── end S854 ──
  NEW.created_by := (select auth.uid());$n$);
  EXECUTE v_def;
END;
$do$;


-- ── 8. Assertions against the catalog ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n integer;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pos_booking_deposits'::regclass) THEN
    RAISE EXCEPTION 'S854 assert: RLS is not on pos_booking_deposits';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'pos_booking_deposits' AND permissive = 'RESTRICTIVE';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S854 assert: expected 3 restrictive policies on pos_booking_deposits, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'pos_booking_deposits' AND permissive = 'PERMISSIVE'
     AND cmd IN ('UPDATE', 'DELETE', 'ALL');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S854 assert: a permissive UPDATE/DELETE/ALL policy exists on pos_booking_deposits';
  END IF;

  -- Grants: nothing for anon; authenticated reads and (for the restore) inserts, never changes.
  IF has_table_privilege('anon', 'public.pos_booking_deposits', 'SELECT')
     OR has_table_privilege('authenticated', 'public.pos_booking_deposits', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pos_booking_deposits', 'DELETE')
     OR has_table_privilege('authenticated', 'public.pos_booking_deposits', 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.pos_booking_deposits', 'SELECT') THEN
    RAISE EXCEPTION 'S854 assert: table grants on pos_booking_deposits are not as intended';
  END IF;

  -- Functions: anon cannot call any; the four bodies that write money are DEFINER, the guard is not.
  IF has_function_privilege('anon', 'public.record_booking_deposit(uuid, numeric, text, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.refund_booking_deposit(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_booking_deposit(uuid, numeric)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_orders_settle_booking_deposit()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S854 assert: a deposit function is callable by a role that must not call it';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_booking_deposit(uuid, numeric, text, uuid, text)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.refund_booking_deposit(uuid, uuid)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.apply_booking_deposit(uuid, numeric)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pos_orders_settle_booking_deposit()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.guard_pos_booking_deposits()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'S854 assert: SECURITY DEFINER/INVOKER is not as intended';
  END IF;

  -- The patched bodies carry their blocks exactly once.
  IF pg_temp.s854_count((SELECT prosrc FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure), 'pos_deposit_split_only') <> 1
     OR pg_temp.s854_count((SELECT prosrc FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure), 'apply_booking_deposit(NEW.id, 0)') <> 1
     OR pg_temp.s854_count((SELECT prosrc FROM pg_proc WHERE oid = 'public.guard_pos_order_payments_closed()'::regprocedure), 'IN (''Loyalty'', ''Deposit'')') <> 1
     OR pg_temp.s854_count((SELECT prosrc FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure), 'pos_cash_deposit_direct') <> 2 THEN
    RAISE EXCEPTION 'S854 assert: a patched body is not as intended';
  END IF;

  -- The settle trigger is attached and enabled.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.pos_orders'::regclass AND tgname = 'pos_orders_settle_booking_deposit'
                    AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'S854 assert: pos_orders_settle_booking_deposit is not attached';
  END IF;

  -- The new login columns are picked up by the delete-a-login check (FKs to profiles, not cascade).
  SELECT count(*) INTO v_n FROM public.pos_login_reference_columns() c
   WHERE c.table_name = 'pos_booking_deposits' AND c.column_name IN ('taken_by', 'refunded_by');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S854 assert: taken_by / refunded_by are not both in pos_login_reference_columns (found %)', v_n;
  END IF;
END;
$$;


-- ── 9. Prove it, as an outlet Owner, inside a block that rolls itself back ─────────────────────
-- For its second or so it holds the outlet open shift set aside and its number series locks, so a
-- till closing a bill at that outlet in that moment waits for it. If any check fails, nothing lands.
DO $probe$
DECLARE
  v_client uuid;
  v_owner  uuid;
  v_live   uuid;
  v_shift  uuid;
  v_recipe uuid;
  v_res    uuid;
  v_o1     uuid;
  v_o2     uuid;
  v_dep    uuid;
  v_r      jsonb;
  v_r2     jsonb;
  v_amt    numeric;
  v_row    record;
  v_n      bigint;
  v_hint   text;
  v_msg    text;
  v_state  text;
  v_req    uuid := gen_random_uuid();
  v_rreq   uuid := gen_random_uuid();
BEGIN
  SELECT c.id, p.id INTO v_client, v_owner
    FROM public.clients c JOIN public.profiles p ON p.client_id = c.id
   WHERE c.pos_enabled AND COALESCE(p.active_client_id, p.client_id) = c.id
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL
     AND p.ims_role IS NULL AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name, p.id LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S854 probe: no POS outlet with an Owner and a settings row';
  END IF;

  BEGIN
    -- Setup, as the migration role (every guard lets it through): the live shift set aside and a
    -- probe shift opened, a dish, a booking for later today, two open takeaway bills of NPR 1000.
    SELECT s.id INTO v_live FROM public.pos_shifts s WHERE s.client_id = v_client AND s.status = 'open';
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE id = v_live;
    INSERT INTO public.pos_shifts (client_id, label, status, opening_cash, opening_denominations, opened_by)
      VALUES (v_client, 'S854 probe', 'open', 0, '{}'::jsonb, v_owner) RETURNING id INTO v_shift;
    INSERT INTO public.recipes (client_id, name) VALUES (v_client, 'S854 probe dish') RETURNING id INTO v_recipe;
    INSERT INTO public.pos_reservations (client_id, customer_name, phone, party_size, reserved_for, status)
      VALUES (v_client, 'S854 probe party', '9800000854', 12, now() + interval '2 hours', 'booked')
      RETURNING id INTO v_res;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_o1;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price)
      VALUES (v_o1, v_client, 'S854 probe dish', v_recipe, 1, 1000);
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_o2;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price)
      VALUES (v_o2, v_client, 'S854 probe dish', v_recipe, 1, 1000);

    -- From here on, the Owner own session, on a till of this release.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;

    -- (a) A Cash deposit of NPR 2000: numbered, on the open shift, one Cash In naming it.
    v_r := public.record_booking_deposit(v_res, 2000, 'Cash', v_req);
    v_dep := (v_r ->> 'id')::uuid;
    IF v_dep IS NULL OR (v_r ->> 'replayed')::boolean OR (v_r ->> 'receipt_no') IS NULL
       OR (v_r ->> 'shift_id')::uuid IS DISTINCT FROM v_shift OR (v_r ->> 'taken_by')::uuid IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S854 probe (a): the deposit answered %', v_r;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_cash_movements
     WHERE booking_deposit_id = v_dep AND kind = 'deposit' AND direction = 'in' AND amount = 2000 AND shift_id = v_shift;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S854 probe (a): % Cash In entries for the deposit', v_n;
    END IF;

    -- (b) The same press again returns the first deposit.
    v_r2 := public.record_booking_deposit(v_res, 2000, 'Cash', v_req);
    IF (v_r2 ->> 'id')::uuid IS DISTINCT FROM v_dep OR NOT (v_r2 ->> 'replayed')::boolean THEN
      RAISE EXCEPTION 'S854 probe (b): a replay answered %', v_r2;
    END IF;

    -- (c) A second deposit on the same booking is refused.
    v_hint := NULL; v_msg := NULL;
    BEGIN
      PERFORM public.record_booking_deposit(v_res, 500, 'eSewa', gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'booking_deposit_exists' THEN
      RAISE EXCEPTION 'S854 probe (c): a second deposit answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (d) A client session writes none of it by hand: the deposit row, a deposit-kind cash entry, a
    --     Deposit leg on an open bill.
    v_state := NULL;
    BEGIN
      INSERT INTO public.pos_booking_deposits (client_id, reservation_id, invoice_fy, receipt_no, amount, method, request_id)
        VALUES (v_client, v_res, 'probe', 999999, 1, 'Cash', gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      RAISE EXCEPTION 'S854 probe (d): a hand-written deposit row answered %', COALESCE(v_state, 'nothing');
    END IF;
    v_hint := NULL;
    BEGIN
      INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, reason, booking_deposit_id)
        VALUES (v_client, v_shift, 'in', 'deposit', 1, 'S854 probe', v_dep);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_cash_deposit_direct' THEN
      RAISE EXCEPTION 'S854 probe (d): a hand-written deposit cash entry answered %', COALESCE(v_hint, 'nothing');
    END IF;
    v_state := NULL;
    BEGIN
      INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
        VALUES (v_o1, v_client, 'Deposit', 100);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      RAISE EXCEPTION 'S854 probe (d): a hand-written Deposit leg answered %', COALESCE(v_state, 'nothing');
    END IF;

    -- (e) Nothing is seated on bill 1 yet: no deposit to use.
    v_hint := NULL;
    BEGIN
      PERFORM public.apply_booking_deposit(v_o1, 500);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'booking_deposit_none' THEN
      RAISE EXCEPTION 'S854 probe (e): using a deposit on a bill with no booking answered %', COALESCE(v_hint, 'nothing');
    END IF;

    -- The party is seated on bill 1 (the till writes this from its save; here the migration role).
    RESET ROLE;
    UPDATE public.pos_reservations SET status = 'seated', order_id = v_o1, seated_at = now() WHERE id = v_res;
    SET LOCAL ROLE authenticated;

    -- (f) 600 goes on bill 1 as its Deposit leg; more than the balance is refused; 0 hands it back.
    v_amt := public.apply_booking_deposit(v_o1, 600);
    IF v_amt IS DISTINCT FROM 600::numeric
       OR (SELECT count(*) FROM public.pos_order_payments WHERE order_id = v_o1 AND payment_method = 'Deposit' AND amount = 600) <> 1
       OR (SELECT order_id FROM public.pos_booking_deposits WHERE id = v_dep) IS DISTINCT FROM v_o1 THEN
      RAISE EXCEPTION 'S854 probe (f): using 600 answered % and left the leg or the link wrong', v_amt;
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.apply_booking_deposit(v_o1, 2500);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'booking_deposit_over_balance' THEN
      RAISE EXCEPTION 'S854 probe (f): using more than the balance answered %', COALESCE(v_hint, 'nothing');
    END IF;
    v_amt := public.apply_booking_deposit(v_o1, 0);
    IF v_amt <> 0
       OR EXISTS (SELECT 1 FROM public.pos_order_payments WHERE order_id = v_o1 AND payment_method = 'Deposit')
       OR (SELECT order_id FROM public.pos_booking_deposits WHERE id = v_dep) IS NOT NULL THEN
      RAISE EXCEPTION 'S854 probe (f): a handback left the leg or the link';
    END IF;

    -- (g) A refund is refused while the deposit is a leg on the open bill.
    PERFORM public.apply_booking_deposit(v_o1, 600);
    v_hint := NULL;
    BEGIN
      PERFORM public.refund_booking_deposit(v_dep, gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'booking_deposit_on_open_bill' THEN
      RAISE EXCEPTION 'S854 probe (g): a refund over an open bill answered %', COALESCE(v_hint, 'nothing');
    END IF;

    -- (h) A Cash charge (not Split) hands the leg back in its own transaction: billed, no leg, nothing used.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1130
     WHERE id = v_o1;
    SELECT o.status, d.order_id, d.used_amount INTO v_row
      FROM public.pos_orders o, public.pos_booking_deposits d WHERE o.id = v_o1 AND d.id = v_dep;
    IF v_row.status IS DISTINCT FROM 'billed' OR v_row.order_id IS NOT NULL OR v_row.used_amount <> 0
       OR EXISTS (SELECT 1 FROM public.pos_order_payments WHERE order_id = v_o1 AND payment_method = 'Deposit') THEN
      RAISE EXCEPTION 'S854 probe (h): a Cash charge stored status %, deposit on %, used %', v_row.status, v_row.order_id, v_row.used_amount;
    END IF;

    -- The party moves to bill 2 (as the migration role).
    RESET ROLE;
    UPDATE public.pos_reservations SET order_id = v_o2 WHERE id = v_res;
    SET LOCAL ROLE authenticated;

    -- (i) A whole-bill 'Deposit' close is refused, and so is a Split charge for less than the leg.
    PERFORM public.apply_booking_deposit(v_o2, 600);
    v_hint := NULL;
    BEGIN
      UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Deposit', paid_amount = 1130
       WHERE id = v_o2;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_deposit_split_only' THEN
      RAISE EXCEPTION 'S854 probe (i): a whole-bill Deposit close answered %', COALESCE(v_hint, 'nothing');
    END IF;
    v_hint := NULL;
    BEGIN
      UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Split', paid_amount = 500
       WHERE id = v_o2;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_deposit_over_bill'
       OR (SELECT status FROM public.pos_orders WHERE id = v_o2) IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'S854 probe (i): a Split charge below its Deposit leg answered %', COALESCE(v_hint, 'nothing');
    END IF;

    -- (j) The Split charge closes; the deposit has used 600 on bill 2; the rest of the payment lands from
    --     the closer; a Deposit leg after the close is refused.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Split', paid_amount = 1130
     WHERE id = v_o2;
    SELECT used_amount, order_id INTO v_row FROM public.pos_booking_deposits WHERE id = v_dep;
    IF v_row.used_amount <> 600 OR v_row.order_id IS DISTINCT FROM v_o2 THEN
      RAISE EXCEPTION 'S854 probe (j): the Split charge left the deposit used % on %', v_row.used_amount, v_row.order_id;
    END IF;
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_o2, v_client, 'Cash', 530);
    v_state := NULL;
    BEGIN
      INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
        VALUES (v_o2, v_client, 'Deposit', 0.01);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      RAISE EXCEPTION 'S854 probe (j): a Deposit leg after the close answered %', COALESCE(v_state, 'nothing');
    END IF;

    -- (k) The rest (NPR 1400) is refunded in cash, once: one Cash Out naming it; the same press again
    --     returns the first refund; another press finds nothing left.
    v_r := public.refund_booking_deposit(v_dep, v_rreq);
    IF (v_r ->> 'refunded_now')::numeric IS DISTINCT FROM 1400::numeric OR (v_r ->> 'replayed')::boolean
       OR (v_r ->> 'refund_shift_id')::uuid IS DISTINCT FROM v_shift OR (v_r ->> 'refund_method') IS DISTINCT FROM 'Cash' THEN
      RAISE EXCEPTION 'S854 probe (k): the refund answered %', v_r;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_cash_movements
     WHERE booking_deposit_id = v_dep AND kind = 'deposit_refund' AND direction = 'out' AND amount = 1400 AND shift_id = v_shift;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S854 probe (k): % Cash Out entries for the refund', v_n;
    END IF;
    v_r2 := public.refund_booking_deposit(v_dep, v_rreq);
    IF NOT (v_r2 ->> 'replayed')::boolean THEN
      RAISE EXCEPTION 'S854 probe (k): a refund replay answered %', v_r2;
    END IF;
    v_hint := NULL;
    BEGIN
      PERFORM public.refund_booking_deposit(v_dep, gen_random_uuid());
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'booking_deposit_nothing_left' THEN
      RAISE EXCEPTION 'S854 probe (k): a second refund answered %', COALESCE(v_hint, 'nothing');
    END IF;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's854_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's854_probe_rollback' THEN RAISE; END IF;
  END;
END;
$probe$;

NOTIFY pgrst, 'reload schema';

-- What this file changed, live (the last statement, so `db query` prints it).
SELECT (SELECT count(*) FROM public.pos_booking_deposits) AS deposits,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pos_booking_deposits') AS policies,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'pos_cash_movements_kind_check') AS cash_kinds,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'pos_order_payments_payment_method_check') AS leg_methods;
