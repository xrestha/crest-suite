-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S843: customer credit takes part payments, each one a numbered money receipt.
--
-- Until now a Credit bill was settled whole, once, by one conditional UPDATE from Customers →
-- Outstanding Credit, and only a Cash settlement left a row of its own (a Cash In). Owner decisions
-- (2026-10-15, asked in plain words):
--   · a payment clears the oldest bills first, and the cashier may tick different bills;
--   · a customer can never pay more than they owe (an advance may be taxable when received — an
--     accountant question already open in POS_TODO.md);
--   · a supervisor or a manager can cancel a payment entered by mistake, with a reason; it is never
--     deleted, and cash taken back leaves the drawer as its own entry;
--   · the receipt is a money receipt with its own number series and no VAT on it (the tax invoice
--     was issued at the sale; a second VAT document would count the VAT twice).
--
-- What this file changes:
--   1. pos_credit_receipts (one row per payment: number, party, method, amount, who, when, its
--      cancellation) and pos_credit_receipt_lines (how much of it went to which bill, and for a
--      delivery partner the commission it kept). Both written ONLY by the two functions below.
--   2. pos_cash_movements.credit_receipt_id, a 'credit_receipt_cancel' kind (cash out), one entry
--      per receipt per kind. A receipt's Cash In carries no order_id (it can cover many bills).
--   3. pos_orders: 'Mixed' joins credit_settled_method (a bill cleared by receipts of different
--      methods); a partial index for the open-credit reads.
--   4. record_credit_receipt / cancel_credit_receipt (SECURITY DEFINER, supervisor+, one
--      transaction each). A bill is stamped credit_settled_* only when its receipts reach its
--      total, so every existing reader of credit_settled_at still means "fully paid".
--   5. pos_credit_party_key / pos_credit_open_bills / pos_credit_party_events: one definition of
--      who a bill belongs to and of what is still owed, for Customers, the statement, the ageing
--      view and the till's credit-limit warning.
--   6. Three live bodies patched in place (pinned by md5 below):
--      · pos_bill_cash_taken counts a bill's Cash receipt lines (a credit note on a part-paid bill
--        refunds the cash really taken);
--      · guard_pos_order_close refuses the old whole-bill settle on a bill that has receipts;
--      · pos_cash_movements_guard refuses a client session's receipt-tagged entry, and the old
--        settlement Cash In on a bill that has receipts.
--      A bundle from before this change keeps working for bills with no receipts (the old path is
--      untouched for them), so this can be applied before crest-v459 deploys.
--
-- Depends on it (app): src/modules/pos/customers/* (Receive payment, receipts, statement, ageing),
-- the till's credit-limit warning, PosShifts (the new cash-out kind), src/shared/scopedDb.js,
-- restoreClientData.js RESTORE_ORDER (pos_credit_receipts → pos_credit_receipt_lines →
-- pos_cash_movements), admin-user-ops delete sequences (pos_cash_movements → lines → receipts →
-- pos_orders), then `supabase functions deploy admin-user-ops`.
--
-- To undo: drop the two RPCs and three read functions, re-run the three patched functions from
-- their previous definitions (pos_bill_cash_taken 20261013100000; the two guards from their live
-- bodies with the S843 blocks removed), drop pos_cash_movements.credit_receipt_id and restore its
-- two kind CHECKs, drop the two tables. Only safe while no receipt exists.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the three bodies patched below are the ones read on 2026-10-15 ─────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_bill_cash_taken(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'd5860a4ca0a41759e186e495828db44f' THEN
    RAISE EXCEPTION 'S843 pre-flight: pos_bill_cash_taken changed since this was written (md5 %)', v_md5;
  END IF;

  -- The two guards are patched by inserting a block at an anchor line; a re-run finds the marker
  -- and skips the patch, so only a body that is neither the pinned one nor already patched stops.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '1ea931acb41052ae5877b27f44568d30'
     AND position('S843' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'S843 pre-flight: guard_pos_order_close changed since this was written (md5 %)', v_md5;
  END IF;

  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '6cc608afe6808f86308b8ef2d32cf7cf'
     AND position('S843' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'S843 pre-flight: pos_cash_movements_guard changed since this was written (md5 %)', v_md5;
  END IF;

  IF to_regprocedure('public.pos_phone_canonical(text)') IS NULL
     OR to_regprocedure('public.pos_invoice_fy(timestamp with time zone)') IS NULL
     OR to_regprocedure('public.pos_caller_has_rank(text)') IS NULL THEN
    RAISE EXCEPTION 'S843 pre-flight: a helper this file calls is missing';
  END IF;
END;
$$;


-- ── 1. Who a Credit bill belongs to ─────────────────────────────────────────────────────────────
-- A bill has no customer link, only the buyer's typed name and phone (and a delivery partner's
-- name). So the party is a key: the partner's name, else the canonical phone (7+ digits, the same
-- rule as pos_customers' unique key), else the name. The prefix says which kind it is.
CREATE OR REPLACE FUNCTION public.pos_credit_party_key(p_partner text, p_phone text, p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
           WHEN NULLIF(btrim(p_partner), '') IS NOT NULL THEN 'partner:' || lower(btrim(p_partner))
           WHEN length(public.pos_phone_canonical(p_phone)) >= 7 THEN 'phone:' || public.pos_phone_canonical(p_phone)
           WHEN NULLIF(btrim(p_name), '') IS NOT NULL THEN 'name:' || lower(btrim(p_name))
           ELSE 'unknown'
         END
$$;
REVOKE ALL ON FUNCTION public.pos_credit_party_key(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_credit_party_key(text, text, text) TO authenticated, service_role;


-- ── 2. The receipt tables ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_credit_receipts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  invoice_fy     text NOT NULL,
  receipt_no     integer NOT NULL CHECK (receipt_no > 0),
  party_key      text NOT NULL CHECK (length(party_key) BETWEEN 1 AND 220),
  party_name     text NOT NULL,
  party_phone    text,
  method         text NOT NULL CHECK (method IN ('Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Cheque', 'Bank Transfer')),
  reference      text CHECK (reference IS NULL OR length(reference) <= 60),
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  commission_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (commission_total >= 0),
  note           text CHECK (note IS NULL OR length(note) <= 300),
  shift_id       uuid REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
  received_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  request_id     uuid NOT NULL,
  print_count    integer NOT NULL DEFAULT 0 CHECK (print_count >= 0),
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  cancel_reason  text CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 3 AND 300),
  CONSTRAINT pos_credit_receipts_cancel_pair CHECK (COALESCE((cancelled_at IS NULL) = (cancel_reason IS NULL), false)),
  CONSTRAINT pos_credit_receipts_no_key UNIQUE (client_id, invoice_fy, receipt_no),
  CONSTRAINT pos_credit_receipts_request_key UNIQUE (client_id, request_id)
);
CREATE INDEX IF NOT EXISTS pos_credit_receipts_client_received_idx ON public.pos_credit_receipts (client_id, received_at);
CREATE INDEX IF NOT EXISTS pos_credit_receipts_party_idx ON public.pos_credit_receipts (client_id, party_key);
CREATE INDEX IF NOT EXISTS pos_credit_receipts_shift_idx ON public.pos_credit_receipts (shift_id) WHERE shift_id IS NOT NULL;

COMMENT ON TABLE public.pos_credit_receipts IS
  'S843: one row per payment a credit customer or delivery partner makes. A money receipt with its own number series per outlet and fiscal year, never a tax invoice. Written only by record_credit_receipt / cancel_credit_receipt; never deleted (a mistake is cancelled, with a reason).';

-- order_id is NO ACTION on purpose: a billed order is never deleted from a screen, and Danger Zone
-- deletes the lines first. A SET NULL here would let a delete succeed and orphan the money.
CREATE TABLE IF NOT EXISTS public.pos_credit_receipt_lines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  receipt_id  uuid NOT NULL REFERENCES public.pos_credit_receipts(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES public.pos_orders(id),
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),
  commission  numeric(12,2) NOT NULL DEFAULT 0 CHECK (commission >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_credit_receipt_lines_positive CHECK (amount + commission > 0),
  CONSTRAINT pos_credit_receipt_lines_one_per_bill UNIQUE (receipt_id, order_id)
);
CREATE INDEX IF NOT EXISTS pos_credit_receipt_lines_order_idx ON public.pos_credit_receipt_lines (order_id);
CREATE INDEX IF NOT EXISTS pos_credit_receipt_lines_client_idx ON public.pos_credit_receipt_lines (client_id);

COMMENT ON TABLE public.pos_credit_receipt_lines IS
  'S843: how much of a receipt went to which Credit bill (amount received) and, for a delivery partner, the commission it kept on that bill. A bill''s still-owed = paid_amount − Σ(amount + commission) over its lines whose receipt is not cancelled.';


-- RLS: one permissive FOR ALL per table, my_client_id() (never its body), every operand wrapped.
ALTER TABLE public.pos_credit_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_credit_receipt_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_credit_receipts_client ON public.pos_credit_receipts;
CREATE POLICY pos_credit_receipts_client ON public.pos_credit_receipts
  TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false))
  WITH CHECK (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

DROP POLICY IF EXISTS pos_credit_receipt_lines_client ON public.pos_credit_receipt_lines;
CREATE POLICY pos_credit_receipt_lines_client ON public.pos_credit_receipt_lines
  TO authenticated
  USING (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false))
  WITH CHECK (COALESCE(client_id = (SELECT public.my_client_id()) OR (SELECT public.is_admin()), false));

-- Staff-account isolation, the trio every pos_* business table carries. POS PIN staff are not
-- fenced out (the till's credit-limit warning reads what a customer owes).
DO $do$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['pos_credit_receipts', 'pos_credit_receipt_lines'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS no_self_service_accounts ON public.%I', v_t);
    EXECUTE format('DROP POLICY IF EXISTS no_ims_staff ON public.%I', v_t);
    EXECUTE format('DROP POLICY IF EXISTS no_hr_role_staff ON public.%I', v_t);
    EXECUTE format('CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())', v_t);
    EXECUTE format('CREATE POLICY no_ims_staff ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff())', v_t);
    EXECUTE format('CREATE POLICY no_hr_role_staff ON public.%I AS RESTRICTIVE FOR ALL USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff())', v_t);
  END LOOP;
END;
$do$;

-- Raw-SQL tables get no role grants. authenticated reads both; INSERT only for the operator's
-- restore and UPDATE only for a receipt's reprint count (the guards below refuse everything else).
-- No DELETE: the functions are DEFINER, and Danger Zone is the service role.
GRANT SELECT, INSERT, UPDATE ON public.pos_credit_receipts TO authenticated;
GRANT SELECT, INSERT ON public.pos_credit_receipt_lines TO authenticated;
GRANT ALL ON public.pos_credit_receipts, public.pos_credit_receipt_lines TO service_role;


-- ── 3. The guards: a receipt is written by its functions only ───────────────────────────────────
-- SECURITY INVOKER with the current_user seam: the two DEFINER functions, the service role and an
-- FK cascade (which runs as the owner) pass; a client session meets the rules below.
CREATE OR REPLACE FUNCTION public.guard_pos_credit_receipts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The operator's restore re-inserts a receipt as it was first recorded (S809 1l shape).
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND NEW.received_at < now() THEN
    RETURN NEW;
  END IF;

  -- A reprint bumps the count, which only goes up (a till a print behind must not fail), and
  -- nothing else on the row may change.
  IF TG_OP = 'UPDATE' THEN
    NEW.print_count := GREATEST(OLD.print_count, NEW.print_count);
    IF (to_jsonb(NEW) - 'print_count') IS DISTINCT FROM (to_jsonb(OLD) - 'print_count') THEN
      RAISE EXCEPTION 'pos_credit_receipt_locked: a payment receipt cannot be changed — cancel it with a reason instead'
        USING ERRCODE = '42501', HINT = 'pos_credit_receipt_locked';
    END IF;
    IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
      RAISE EXCEPTION 'pos_credit_receipt_rank: reprinting a payment receipt needs a POS supervisor, a POS manager or the Owner'
        USING ERRCODE = '42501', HINT = 'rank_required';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pos_credit_receipt_locked: a payment receipt is recorded only by Receive payment and is never deleted — cancel it with a reason instead'
    USING ERRCODE = '42501', HINT = 'pos_credit_receipt_locked';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_pos_credit_receipts() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_pos_credit_receipts ON public.pos_credit_receipts;
CREATE TRIGGER guard_pos_credit_receipts
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_credit_receipts
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_credit_receipts();

CREATE OR REPLACE FUNCTION public.guard_pos_credit_receipt_lines()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) AND NEW.created_at < now() THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pos_credit_receipt_locked: how a payment was split over bills is recorded only by Receive payment and cannot be changed'
    USING ERRCODE = '42501', HINT = 'pos_credit_receipt_locked';
END;
$$;
REVOKE ALL ON FUNCTION public.guard_pos_credit_receipt_lines() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_pos_credit_receipt_lines ON public.pos_credit_receipt_lines;
CREATE TRIGGER guard_pos_credit_receipt_lines
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_credit_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_credit_receipt_lines();

-- Audit: a receipt's creation, its cancellation and (Danger Zone) its deletion. Not the reprint
-- count, which would be noise; not the lines (per-line volume, the receipt row names the total).
DROP TRIGGER IF EXISTS audit_pos_credit_receipts_ins_del ON public.pos_credit_receipts;
CREATE TRIGGER audit_pos_credit_receipts_ins_del
  AFTER INSERT OR DELETE ON public.pos_credit_receipts
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();
DROP TRIGGER IF EXISTS audit_pos_credit_receipts_cancel ON public.pos_credit_receipts;
CREATE TRIGGER audit_pos_credit_receipts_cancel
  AFTER UPDATE ON public.pos_credit_receipts
  FOR EACH ROW WHEN (OLD.cancelled_at IS DISTINCT FROM NEW.cancelled_at)
  EXECUTE FUNCTION public.log_audit();


-- ── 4. pos_cash_movements: a receipt's cash in, and a cancelled receipt's cash out ───────────────
ALTER TABLE public.pos_cash_movements
  ADD COLUMN IF NOT EXISTS credit_receipt_id uuid REFERENCES public.pos_credit_receipts(id);

ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_kind_check;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_kind_check
  CHECK (kind IN ('pay_in', 'pay_out', 'credit_settlement', 'refund', 'credit_receipt_cancel'));

ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_kind_direction_check;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_kind_direction_check
  CHECK (COALESCE((kind IN ('pay_in', 'credit_settlement') AND direction = 'in')
               OR (kind IN ('pay_out', 'refund', 'credit_receipt_cancel') AND direction = 'out'), false));

ALTER TABLE public.pos_cash_movements DROP CONSTRAINT IF EXISTS pos_cash_movements_receipt_kinds;
ALTER TABLE public.pos_cash_movements ADD CONSTRAINT pos_cash_movements_receipt_kinds
  CHECK (credit_receipt_id IS NULL OR kind IN ('credit_settlement', 'credit_receipt_cancel'));

-- A receipt's Cash In happens once and its cancellation's Cash Out once.
CREATE UNIQUE INDEX IF NOT EXISTS pos_cash_movements_one_per_receipt_kind
  ON public.pos_cash_movements (credit_receipt_id, kind) WHERE credit_receipt_id IS NOT NULL;


-- ── 5. pos_orders: 'Mixed', and the open-credit index ────────────────────────────────────────────
ALTER TABLE public.pos_orders DROP CONSTRAINT IF EXISTS pos_orders_credit_settled_method_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_credit_settled_method_check
  CHECK (credit_settled_method IN ('Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Cheque', 'Bank Transfer', 'Mixed'));

CREATE INDEX IF NOT EXISTS pos_orders_open_credit_idx ON public.pos_orders (client_id, closed_at)
  WHERE payment_method = 'Credit' AND status = 'billed' AND credit_settled_at IS NULL AND credit_note_id IS NULL;


-- ── 6. What is still owed: one definition ────────────────────────────────────────────────────────
-- INVOKER: the caller's RLS applies (and its restrictive families). The outlet is filtered
-- explicitly because the operator's RLS sees every outlet: p_client_id when given (the operator's
-- view-as is a browser setting, so its my_client_id() is not the outlet on screen — the
-- pos_loyalty_balances shape), else my_client_id(). A login's RLS returns nothing for another
-- outlet's id, so the parameter widens nothing.
CREATE OR REPLACE FUNCTION public.pos_credit_open_bills(p_party_key text DEFAULT NULL, p_client_id uuid DEFAULT NULL)
RETURNS TABLE (
  order_id         uuid,
  party_key        text,
  buyer_name       text,
  buyer_phone      text,
  delivery_partner text,
  order_no         integer,
  table_name       text,
  invoice_no       integer,
  invoice_fy       text,
  invoice_prefix   text,
  closed_at        timestamptz,
  paid_amount      numeric,
  received         numeric,
  commission       numeric,
  owed             numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT o.id,
         public.pos_credit_party_key(o.delivery_partner, o.buyer_phone, o.buyer_name),
         o.buyer_name, o.buyer_phone, o.delivery_partner, o.order_no, o.table_name,
         o.invoice_no, o.invoice_fy, o.invoice_prefix, o.closed_at,
         o.paid_amount,
         COALESCE(x.received, 0),
         COALESCE(x.commission, 0),
         round(COALESCE(o.paid_amount, 0) - COALESCE(x.received, 0) - COALESCE(x.commission, 0), 2)
    FROM public.pos_orders o
    LEFT JOIN LATERAL (
      SELECT sum(l.amount) AS received, sum(l.commission) AS commission
        FROM public.pos_credit_receipt_lines l
        JOIN public.pos_credit_receipts r ON r.id = l.receipt_id
       WHERE l.order_id = o.id AND r.cancelled_at IS NULL
    ) x ON true
   WHERE o.client_id = COALESCE(p_client_id, public.my_client_id())
     AND o.payment_method = 'Credit' AND o.status = 'billed' AND o.close_type = 'paid'
     AND o.credit_settled_at IS NULL AND o.credit_note_id IS NULL
     AND (p_party_key IS NULL
          OR public.pos_credit_party_key(o.delivery_partner, o.buyer_phone, o.buyer_name) = p_party_key)
   ORDER BY o.closed_at, o.id
$$;
REVOKE ALL ON FUNCTION public.pos_credit_open_bills(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_credit_open_bills(text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.pos_credit_open_bills(text, uuid) IS
  'S843: every unpaid Credit bill of the signed-in outlet (one party''s when a key is given), oldest first, with what was received on it, the partner commission kept, and what is still owed. The one definition of "owed"; INVOKER.';

-- A party's account history for the statement: bills (debit), receipts (credit), cancelled
-- receipts (debit back), whole-bill settlements from before receipts (credit), and a credit note on
-- one of its Credit bills (credit: what that bill still owed when the note was issued; any refund of
-- what had been received belongs to the note, not to this account). Σ debit − Σ credit is the
-- balance, and equals Σ owed of pos_credit_open_bills for the same key.
CREATE OR REPLACE FUNCTION public.pos_credit_party_events(p_party_key text, p_client_id uuid DEFAULT NULL)
RETURNS TABLE (
  event_at     timestamptz,
  kind         text,
  order_id     uuid,
  receipt_id   uuid,
  doc_no       integer,
  doc_fy       text,
  doc_prefix   text,
  method       text,
  debit        numeric,
  credit       numeric,
  detail       text)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH bills AS (
    SELECT o.*
      FROM public.pos_orders o
     WHERE o.client_id = COALESCE(p_client_id, public.my_client_id())
       AND o.payment_method = 'Credit' AND o.status = 'billed' AND o.close_type = 'paid'
       AND public.pos_credit_party_key(o.delivery_partner, o.buyer_phone, o.buyer_name) = p_party_key
  ), active AS (
    SELECT l.order_id, sum(l.amount + l.commission) AS cleared
      FROM public.pos_credit_receipt_lines l
      JOIN public.pos_credit_receipts r ON r.id = l.receipt_id
     WHERE r.cancelled_at IS NULL AND l.order_id IN (SELECT id FROM bills)
     GROUP BY l.order_id
  ), receipts AS (
    SELECT r.*, sum(l.amount + l.commission) AS cleared
      FROM public.pos_credit_receipts r
      JOIN public.pos_credit_receipt_lines l ON l.receipt_id = r.id
     WHERE r.client_id = COALESCE(p_client_id, public.my_client_id()) AND r.party_key = p_party_key
     GROUP BY r.id
  )
  SELECT b.closed_at, 'bill', b.id, NULL::uuid, b.invoice_no, b.invoice_fy, b.invoice_prefix,
         NULL::text, round(b.paid_amount, 2), 0::numeric, b.table_name
    FROM bills b
  UNION ALL
  SELECT b.credit_settled_at, 'settled', b.id, NULL::uuid, b.invoice_no, b.invoice_fy, b.invoice_prefix,
         b.credit_settled_method, 0::numeric, round(b.paid_amount, 2),
         CASE WHEN COALESCE(b.commission_amount, 0) > 0
              THEN 'commission ' || round(b.commission_amount, 2)::text END
    FROM bills b
   WHERE b.credit_settled_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.pos_credit_receipt_lines l WHERE l.order_id = b.id)
  UNION ALL
  SELECT r.received_at, 'receipt', NULL::uuid, r.id, r.receipt_no, r.invoice_fy, NULL::text,
         r.method, 0::numeric, round(r.cleared, 2),
         NULLIF(concat_ws(' · ', r.reference,
                          CASE WHEN r.commission_total > 0 THEN 'commission ' || r.commission_total::text END), '')
    FROM receipts r
  UNION ALL
  SELECT r.cancelled_at, 'receipt_cancelled', NULL::uuid, r.id, r.receipt_no, r.invoice_fy, NULL::text,
         r.method, round(r.cleared, 2), 0::numeric, r.cancel_reason
    FROM receipts r
   WHERE r.cancelled_at IS NOT NULL
  UNION ALL
  SELECT n.created_at, 'credit_note', b.id, NULL::uuid, n.credit_note_no, n.invoice_fy, n.invoice_prefix,
         NULL::text, 0::numeric,
         GREATEST(round(b.paid_amount - COALESCE(a.cleared, 0)
                        - CASE WHEN b.credit_settled_at IS NOT NULL
                                AND NOT EXISTS (SELECT 1 FROM public.pos_credit_receipt_lines l WHERE l.order_id = b.id)
                               THEN b.paid_amount ELSE 0 END, 2), 0),
         n.reason
    FROM bills b
    JOIN public.pos_credit_notes n ON n.id = b.credit_note_id
    LEFT JOIN active a ON a.order_id = b.id
   ORDER BY 1, 2
$$;
REVOKE ALL ON FUNCTION public.pos_credit_party_events(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_credit_party_events(text, uuid) TO authenticated, service_role;


-- ── 7. Recording a payment ───────────────────────────────────────────────────────────────────────
-- p_lines: [{ "order_id": uuid, "amount": n, "commission": n }] — the browser proposes the split
-- (oldest first, or the bills the cashier ticked); everything is re-checked here under the bills'
-- row locks. Σ amount must equal p_amount; no line may exceed what its bill still owes (no
-- advances); commission only on a delivery partner's bills. A replay of the same p_request_id
-- returns the first receipt. Cash needs an open shift, read FOR SHARE as a bill's close does.
CREATE OR REPLACE FUNCTION public.record_credit_receipt(
  p_request_id uuid,
  p_party_key  text,
  p_method     text,
  p_amount     numeric,
  p_lines      jsonb,
  p_reference  text DEFAULT NULL,
  p_note       text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid      uuid := (SELECT auth.uid());
  v_client   uuid := public.my_client_id();
  v_kind     text;
  v_prior    public.pos_credit_receipts%ROWTYPE;
  v_ids      uuid[];
  v_n        integer;
  v_line     jsonb;
  v_oid      uuid;
  v_amt      numeric;
  v_comm     numeric;
  v_o        public.pos_orders%ROWTYPE;
  v_cleared  numeric;
  v_owed     numeric;
  v_sum      numeric := 0;
  v_comm_sum numeric := 0;
  v_shift    uuid;
  v_fy       text;
  v_no       integer;
  v_receipt  uuid := gen_random_uuid();
  v_name     text;
  v_phone    text;
  v_latest   timestamptz;
  v_methods  text[];
  v_bills    jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR v_client IS NULL THEN
    RAISE EXCEPTION 'credit_receipt_auth: sign in to the outlet to record a payment'
      USING ERRCODE = '42501', HINT = 'credit_receipt_auth';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION 'credit_receipt_rank: recording a customer payment needs a POS supervisor, a POS manager or the Owner'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'credit_receipt_bad: the payment has no request id' USING HINT = 'credit_receipt_bad';
  END IF;

  -- A retry of a press whose answer was lost: the first receipt, unchanged.
  SELECT * INTO v_prior FROM public.pos_credit_receipts WHERE client_id = v_client AND request_id = p_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object('receipt_id', v_prior.id, 'receipt_no', v_prior.receipt_no,
                              'invoice_fy', v_prior.invoice_fy, 'received_at', v_prior.received_at,
                              'replayed', true);
  END IF;

  v_kind := CASE WHEN p_party_key LIKE 'partner:%' THEN 'partner'
                 WHEN p_party_key LIKE 'phone:%' OR p_party_key LIKE 'name:%' THEN 'customer' END;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'credit_receipt_bad: the payment does not name a customer or delivery partner' USING HINT = 'credit_receipt_bad';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Cheque', 'Bank Transfer') THEN
    RAISE EXCEPTION 'credit_receipt_bad: % is not a payment method a receipt can record', COALESCE(p_method, 'no method') USING HINT = 'credit_receipt_bad';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION 'credit_receipt_bad: the amount must be more than zero, to the paisa' USING HINT = 'credit_receipt_bad';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RAISE EXCEPTION 'credit_receipt_bad: the payment names no bills' USING HINT = 'credit_receipt_bad';
  END IF;
  v_n := jsonb_array_length(p_lines);
  IF v_n < 1 OR v_n > 200 THEN
    RAISE EXCEPTION 'credit_receipt_bad: a payment covers 1 to 200 bills' USING HINT = 'credit_receipt_bad';
  END IF;

  SELECT array_agg((e ->> 'order_id')::uuid ORDER BY (e ->> 'order_id')::uuid) INTO v_ids
    FROM jsonb_array_elements(p_lines) e;
  IF array_position(v_ids, NULL) IS NOT NULL
     OR cardinality(v_ids) <> (SELECT count(DISTINCT x) FROM unnest(v_ids) x) THEN
    RAISE EXCEPTION 'credit_receipt_bad: each bill may appear once in a payment' USING HINT = 'credit_receipt_bad';
  END IF;

  -- The bills, locked in id order (two payments on overlapping bills queue, never deadlock). A
  -- whole-bill settle, a credit note or another payment on one of them waits for this one.
  PERFORM 1 FROM public.pos_orders o WHERE o.id = ANY (v_ids) AND o.client_id = v_client ORDER BY o.id FOR UPDATE;

  -- Then the drawer, as a bill's close takes it: a Close Shift waits for this payment and counts it.
  SELECT s.id INTO v_shift FROM public.pos_shifts s
   WHERE s.client_id = v_client AND s.status = 'open'
   ORDER BY s.opened_at DESC LIMIT 1 FOR SHARE;
  IF p_method = 'Cash' AND v_shift IS NULL THEN
    RAISE EXCEPTION 'credit_receipt_no_shift: no shift is open, so this cash has no drawer to go in — open a shift first, or record it as another method'
      USING HINT = 'credit_receipt_no_shift';
  END IF;

  FOR v_line IN SELECT e FROM jsonb_array_elements(p_lines) e LOOP
    v_oid  := (v_line ->> 'order_id')::uuid;
    v_amt  := COALESCE((v_line ->> 'amount')::numeric, 0);
    v_comm := COALESCE((v_line ->> 'commission')::numeric, 0);
    IF v_amt < 0 OR v_comm < 0 OR v_amt <> round(v_amt, 2) OR v_comm <> round(v_comm, 2) OR v_amt + v_comm <= 0 THEN
      RAISE EXCEPTION 'credit_receipt_bad: each bill needs an amount above zero, to the paisa' USING HINT = 'credit_receipt_bad';
    END IF;
    IF v_comm > 0 AND v_kind <> 'partner' THEN
      RAISE EXCEPTION 'credit_receipt_bad: only a delivery partner keeps a commission' USING HINT = 'credit_receipt_bad';
    END IF;

    SELECT * INTO v_o FROM public.pos_orders WHERE id = v_oid AND client_id = v_client;
    IF NOT FOUND OR v_o.status IS DISTINCT FROM 'billed' OR v_o.close_type IS DISTINCT FROM 'paid'
       OR v_o.payment_method IS DISTINCT FROM 'Credit'
       OR v_o.credit_note_id IS NOT NULL OR v_o.credit_settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'credit_receipt_stale: bill % is no longer an unpaid Credit bill (paid, credited or not this outlet''s) — reload and try again',
        COALESCE(v_o.invoice_no::text, v_oid::text)
        USING HINT = 'credit_receipt_stale';
    END IF;
    IF public.pos_credit_party_key(v_o.delivery_partner, v_o.buyer_phone, v_o.buyer_name) IS DISTINCT FROM p_party_key THEN
      RAISE EXCEPTION 'credit_receipt_party: bill % belongs to someone else' , COALESCE(v_o.invoice_no::text, v_oid::text)
        USING HINT = 'credit_receipt_party';
    END IF;

    SELECT COALESCE(sum(l.amount + l.commission), 0) INTO v_cleared
      FROM public.pos_credit_receipt_lines l
      JOIN public.pos_credit_receipts r ON r.id = l.receipt_id
     WHERE l.order_id = v_oid AND r.cancelled_at IS NULL;
    v_owed := round(COALESCE(v_o.paid_amount, 0) - v_cleared, 2);
    IF v_amt + v_comm > v_owed + 0.005 THEN
      RAISE EXCEPTION 'credit_receipt_over: bill % still owes NPR %, less than the NPR % put against it — a payment cannot be more than is owed',
        COALESCE(v_o.invoice_no::text, v_oid::text), v_owed, v_amt + v_comm
        USING HINT = 'credit_receipt_over';
    END IF;

    v_sum := v_sum + v_amt;
    v_comm_sum := v_comm_sum + v_comm;
    IF v_latest IS NULL OR v_o.closed_at > v_latest THEN
      v_latest := v_o.closed_at;
      v_name   := COALESCE(NULLIF(btrim(v_o.delivery_partner), ''), NULLIF(btrim(v_o.buyer_name), ''), 'Customer');
      v_phone  := v_o.buyer_phone;
    END IF;
  END LOOP;

  IF abs(v_sum - p_amount) > 0.005 THEN
    RAISE EXCEPTION 'credit_receipt_bad: the bills add up to NPR %, not the NPR % received', v_sum, p_amount
      USING HINT = 'credit_receipt_bad';
  END IF;

  -- The number: per outlet and fiscal year, as credit notes are numbered.
  v_fy := public.pos_invoice_fy(now());
  PERFORM pg_advisory_xact_lock(hashtext('pos_credit_receipt_no:' || v_client::text || ':' || v_fy));
  SELECT COALESCE(max(receipt_no), 0) + 1 INTO v_no
    FROM public.pos_credit_receipts WHERE client_id = v_client AND invoice_fy = v_fy;

  INSERT INTO public.pos_credit_receipts
    (id, client_id, invoice_fy, receipt_no, party_key, party_name, party_phone, method, reference,
     amount, commission_total, note, shift_id, received_by, request_id)
  VALUES
    (v_receipt, v_client, v_fy, v_no, p_party_key, v_name, v_phone, p_method,
     NULLIF(left(btrim(p_reference), 60), ''), p_amount, round(v_comm_sum, 2),
     NULLIF(left(btrim(p_note), 300), ''), v_shift, v_uid, p_request_id);

  INSERT INTO public.pos_credit_receipt_lines (client_id, receipt_id, order_id, amount, commission)
  SELECT v_client, v_receipt, (e ->> 'order_id')::uuid,
         COALESCE((e ->> 'amount')::numeric, 0), COALESCE((e ->> 'commission')::numeric, 0)
    FROM jsonb_array_elements(p_lines) e;

  -- Cash goes on the drawer now, one entry for the receipt (kind credit_settlement, so Expected Cash
  -- on both sides of its JS/SQL pair counts it unchanged). DEFINER bypasses the cash guard, so this
  -- body stamps what the guard would.
  IF p_method = 'Cash' THEN
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, credit_receipt_id, reason, created_by)
    VALUES (v_client, v_shift, 'in', 'credit_settlement', p_amount, v_receipt,
            left(format('Receipt %s (%s) — %s', v_no, v_fy, v_name), 500), v_uid);
  END IF;

  -- Each bill: a partner bill carries the commission kept so far; a bill its receipts now cover is
  -- stamped settled, by this login, now, with the one method that paid it or 'Mixed'.
  FOREACH v_oid IN ARRAY v_ids LOOP
    SELECT COALESCE(sum(l.amount + l.commission), 0), COALESCE(sum(l.commission), 0),
           array_agg(DISTINCT r.method)
      INTO v_cleared, v_comm, v_methods
      FROM public.pos_credit_receipt_lines l
      JOIN public.pos_credit_receipts r ON r.id = l.receipt_id
     WHERE l.order_id = v_oid AND r.cancelled_at IS NULL;

    SELECT * INTO v_o FROM public.pos_orders WHERE id = v_oid;
    v_owed := round(COALESCE(v_o.paid_amount, 0) - v_cleared, 2);

    UPDATE public.pos_orders o
       SET commission_amount = CASE WHEN v_kind = 'partner' THEN NULLIF(round(v_comm, 2), 0) ELSE o.commission_amount END,
           credit_settled_at     = CASE WHEN v_owed <= 0.005 THEN now() ELSE o.credit_settled_at END,
           credit_settled_by     = CASE WHEN v_owed <= 0.005 THEN v_uid ELSE o.credit_settled_by END,
           credit_settled_method = CASE WHEN v_owed <= 0.005
                                        THEN CASE WHEN cardinality(v_methods) = 1 THEN v_methods[1] ELSE 'Mixed' END
                                        ELSE o.credit_settled_method END
     WHERE o.id = v_oid;

    v_bills := v_bills || jsonb_build_object('order_id', v_oid, 'owed', GREATEST(v_owed, 0), 'settled', v_owed <= 0.005);
  END LOOP;

  RETURN jsonb_build_object('receipt_id', v_receipt, 'receipt_no', v_no, 'invoice_fy', v_fy,
                            'received_at', now(), 'bills', v_bills, 'replayed', false);
END;
$$;
REVOKE ALL ON FUNCTION public.record_credit_receipt(uuid, text, text, numeric, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_credit_receipt(uuid, text, text, numeric, jsonb, text, text) TO authenticated, service_role;


-- ── 8. Cancelling a payment entered by mistake ──────────────────────────────────────────────────
-- Supervisor or above (owner decision), with a reason. The receipt stays, marked cancelled; its
-- bills owe again (a bill it had settled is un-settled); its cash leaves the open drawer as its own
-- entry. Refused once a credit note is on one of its bills (the note settled that money).
CREATE OR REPLACE FUNCTION public.cancel_credit_receipt(p_receipt_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid     uuid := (SELECT auth.uid());
  v_client  uuid := public.my_client_id();
  v_reason  text := btrim(COALESCE(p_reason, ''));
  v_r       public.pos_credit_receipts%ROWTYPE;
  v_ids     uuid[];
  v_oid     uuid;
  v_shift   uuid;
  v_cleared numeric;
  v_comm    numeric;
  v_paid    numeric;
  v_partner boolean;
  v_bills   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR v_client IS NULL THEN
    RAISE EXCEPTION 'credit_receipt_auth: sign in to the outlet to cancel a payment'
      USING ERRCODE = '42501', HINT = 'credit_receipt_auth';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
    RAISE EXCEPTION 'credit_receipt_rank: cancelling a customer payment needs a POS supervisor, a POS manager or the Owner'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 300 THEN
    RAISE EXCEPTION 'credit_receipt_cancel_reason: say why the payment is being cancelled (3 to 300 characters)'
      USING HINT = 'credit_receipt_cancel_reason';
  END IF;

  SELECT * INTO v_r FROM public.pos_credit_receipts
   WHERE id = p_receipt_id AND client_id = v_client FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credit_receipt_missing: that payment is not on this outlet''s records' USING HINT = 'credit_receipt_missing';
  END IF;
  IF v_r.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object('receipt_id', v_r.id, 'already_cancelled', true, 'cancelled_at', v_r.cancelled_at);
  END IF;

  SELECT array_agg(order_id ORDER BY order_id) INTO v_ids
    FROM public.pos_credit_receipt_lines WHERE receipt_id = v_r.id;
  PERFORM 1 FROM public.pos_orders o WHERE o.id = ANY (v_ids) ORDER BY o.id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.pos_orders o WHERE o.id = ANY (v_ids) AND o.credit_note_id IS NOT NULL) THEN
    RAISE EXCEPTION 'credit_receipt_cancel_credited: a credit note has been issued on one of this payment''s bills, so the payment stands — the note settled that money'
      USING HINT = 'credit_receipt_cancel_credited';
  END IF;

  IF v_r.method = 'Cash' THEN
    SELECT s.id INTO v_shift FROM public.pos_shifts s
     WHERE s.client_id = v_client AND s.status = 'open'
     ORDER BY s.opened_at DESC LIMIT 1 FOR SHARE;
    IF v_shift IS NULL THEN
      RAISE EXCEPTION 'credit_receipt_cancel_no_shift: no shift is open, so the cash cannot be taken back out of a drawer — open a shift first'
        USING HINT = 'credit_receipt_cancel_no_shift';
    END IF;
  END IF;

  UPDATE public.pos_credit_receipts
     SET cancelled_at = now(), cancelled_by = v_uid, cancel_reason = v_reason
   WHERE id = v_r.id;

  IF v_r.method = 'Cash' THEN
    INSERT INTO public.pos_cash_movements (client_id, shift_id, direction, kind, amount, credit_receipt_id, reason, created_by)
    VALUES (v_client, v_shift, 'out', 'credit_receipt_cancel', v_r.amount, v_r.id,
            left(format('Receipt %s (%s) cancelled — %s', v_r.receipt_no, v_r.invoice_fy, v_reason), 500), v_uid);
  END IF;

  v_partner := v_r.party_key LIKE 'partner:%';
  FOREACH v_oid IN ARRAY v_ids LOOP
    SELECT COALESCE(sum(l.amount + l.commission), 0), COALESCE(sum(l.commission), 0)
      INTO v_cleared, v_comm
      FROM public.pos_credit_receipt_lines l
      JOIN public.pos_credit_receipts r ON r.id = l.receipt_id
     WHERE l.order_id = v_oid AND r.cancelled_at IS NULL;
    SELECT paid_amount INTO v_paid FROM public.pos_orders WHERE id = v_oid;

    UPDATE public.pos_orders o
       SET commission_amount     = CASE WHEN v_partner THEN NULLIF(round(v_comm, 2), 0) ELSE o.commission_amount END,
           credit_settled_at     = CASE WHEN round(COALESCE(v_paid, 0) - v_cleared, 2) > 0.005 THEN NULL ELSE o.credit_settled_at END,
           credit_settled_by     = CASE WHEN round(COALESCE(v_paid, 0) - v_cleared, 2) > 0.005 THEN NULL ELSE o.credit_settled_by END,
           credit_settled_method = CASE WHEN round(COALESCE(v_paid, 0) - v_cleared, 2) > 0.005 THEN NULL ELSE o.credit_settled_method END
     WHERE o.id = v_oid;

    v_bills := v_bills || jsonb_build_object('order_id', v_oid, 'owed', GREATEST(round(COALESCE(v_paid, 0) - v_cleared, 2), 0));
  END LOOP;

  RETURN jsonb_build_object('receipt_id', v_r.id, 'already_cancelled', false, 'cancelled_at', now(), 'bills', v_bills);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_credit_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_credit_receipt(uuid, text) TO authenticated, service_role;


-- ── 9. pos_bill_cash_taken: a Credit bill's cash is its Cash receipts ────────────────────────────
-- A bill with receipt lines: the Cash ones not cancelled. A bill settled whole before receipts
-- existed: as before (paid − commission when settled in Cash). Same signature and return type.
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
             -- S843: part payments
             WHEN o.payment_method = 'Credit'
                  AND EXISTS (SELECT 1 FROM pos_credit_receipt_lines l WHERE l.order_id = o.id) THEN
               (SELECT sum(l.amount) FROM pos_credit_receipt_lines l
                  JOIN pos_credit_receipts r ON r.id = l.receipt_id
                 WHERE l.order_id = o.id AND r.method = 'Cash' AND r.cancelled_at IS NULL)
             WHEN o.payment_method = 'Credit' AND o.credit_settled_at IS NOT NULL
                  AND o.credit_settled_method = 'Cash'
               THEN o.paid_amount - COALESCE(o.commission_amount, 0)
             ELSE 0
           END, 0), 0), 2)
    FROM pos_orders o
   WHERE o.id = p_order_id
     AND o.status = 'billed' AND o.close_type = 'paid'
$function$;


-- ── 10. The two guards: the old whole-bill settle stays for bills with no receipts ──────────────
DO $patch$
DECLARE
  v_def    text;
  v_anchor text;
  v_block  text;
  v_count  integer;
BEGIN
  -- guard_pos_order_close: inside (A)'s settlement branch, before the settler is stamped.
  v_def := pg_get_functiondef('public.guard_pos_order_close()'::regprocedure);
  IF position('S843' IN v_def) = 0 THEN
    v_anchor := '      NEW.credit_settled_by := (SELECT auth.uid());';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'S843: guard_pos_order_close anchor found % times, expected 1', v_count;
    END IF;
    v_block := E'      -- ── S843: a bill with part payments is settled only by its receipts ─────────────────\n'
            || E'      -- record_credit_receipt stamps it when they reach the total (DEFINER, never here).\n'
            || E'      IF EXISTS (SELECT 1 FROM public.pos_credit_receipt_lines l WHERE l.order_id = OLD.id) THEN\n'
            || E'        RAISE EXCEPTION ''pos_orders: this bill has part payments recorded, so it is settled through Receive payment on Customers — reload Crest if that button is missing''\n'
            || E'          USING ERRCODE = ''42501'', HINT = ''credit_use_receipts'';\n'
            || E'      END IF;\n'
            || E'      -- ── end S843 ──\n';
    EXECUTE replace(v_def, v_anchor, v_block || v_anchor);
  END IF;

  -- pos_cash_movements_guard: before created_by is stamped (every check above it still runs).
  v_def := pg_get_functiondef('public.pos_cash_movements_guard()'::regprocedure);
  IF position('S843' IN v_def) = 0 THEN
    v_anchor := '  NEW.created_by := (select auth.uid());';
    v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'S843: pos_cash_movements_guard anchor found % times, expected 1', v_count;
    END IF;
    v_block := E'  -- ── S843: a receipt''s cash is written by record_credit_receipt / cancel_credit_receipt ──\n'
            || E'  IF NEW.credit_receipt_id IS NOT NULL OR NEW.kind = ''credit_receipt_cancel'' THEN\n'
            || E'    RAISE EXCEPTION ''pos_cash_receipt_direct: a customer payment''''s cash is recorded by Receive payment itself, not entered directly''\n'
            || E'      USING ERRCODE = ''42501'', HINT = ''pos_cash_receipt_direct'';\n'
            || E'  END IF;\n'
            || E'  -- The old whole-bill settlement Cash In: one bill, and only a bill with no receipts.\n'
            || E'  IF NEW.kind = ''credit_settlement''\n'
            || E'     AND (NEW.order_id IS NULL\n'
            || E'          OR EXISTS (SELECT 1 FROM public.pos_credit_receipt_lines l WHERE l.order_id = NEW.order_id)) THEN\n'
            || E'    RAISE EXCEPTION ''pos_cash_settlement_receipts: that bill''''s payments are recorded with receipts, which put their cash on the drawer themselves''\n'
            || E'      USING ERRCODE = ''42501'', HINT = ''credit_use_receipts'';\n'
            || E'  END IF;\n'
            || E'  -- ── end S843 ──\n';
    EXECUTE replace(v_def, v_anchor, v_block || v_anchor);
  END IF;
END;
$patch$;


-- ── 11. Assertions against the catalog ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n integer;
BEGIN
  -- Tables, RLS, the trio
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pos_credit_receipts'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pos_credit_receipt_lines'::regclass) THEN
    RAISE EXCEPTION 'S843 assert: RLS is not on';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename IN ('pos_credit_receipts', 'pos_credit_receipt_lines')
     AND permissive = 'RESTRICTIVE';
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'S843 assert: expected 6 restrictive policies, found %', v_n;
  END IF;

  -- Grants: nothing for anon, and no TRUNCATE/REFERENCES/TRIGGER for authenticated
  IF has_table_privilege('anon', 'public.pos_credit_receipts', 'SELECT')
     OR has_table_privilege('anon', 'public.pos_credit_receipt_lines', 'SELECT')
     OR has_table_privilege('authenticated', 'public.pos_credit_receipts', 'DELETE')
     OR has_table_privilege('authenticated', 'public.pos_credit_receipt_lines', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pos_credit_receipts', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.pos_credit_receipt_lines', 'TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.pos_credit_receipts', 'SELECT') THEN
    RAISE EXCEPTION 'S843 assert: table grants are not as intended';
  END IF;

  -- Functions: anon cannot call any of them; the two writers are DEFINER, the readers are not
  IF has_function_privilege('anon', 'public.record_credit_receipt(uuid, text, text, numeric, jsonb, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cancel_credit_receipt(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_credit_open_bills(text, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_credit_party_events(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S843 assert: anon can call a credit function';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_credit_receipt(uuid, text, text, numeric, jsonb, text, text)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.cancel_credit_receipt(uuid, text)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.pos_credit_open_bills(text, uuid)'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.guard_pos_credit_receipts()'::regprocedure) THEN
    RAISE EXCEPTION 'S843 assert: SECURITY DEFINER/INVOKER is not as intended';
  END IF;

  -- The patched bodies carry their blocks, exactly once
  IF (SELECT (length(prosrc) - length(replace(prosrc, 'credit_use_receipts', ''))) / length('credit_use_receipts')
        FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure) <> 1
     OR (SELECT (length(prosrc) - length(replace(prosrc, 'pos_cash_receipt_direct', ''))) / length('pos_cash_receipt_direct')
        FROM pg_proc WHERE oid = 'public.pos_cash_movements_guard()'::regprocedure) <> 2
     OR position('pos_credit_receipt_lines' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.pos_bill_cash_taken(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'S843 assert: a patched body is not as intended';
  END IF;

  -- The new login columns are picked up by the delete-a-login check (FKs to profiles, not cascade)
  IF NOT EXISTS (SELECT 1 FROM public.pos_login_reference_columns() c
                  WHERE c.table_name = 'pos_credit_receipts' AND c.column_name = 'received_by') THEN
    RAISE EXCEPTION 'S843 assert: received_by is not in pos_login_reference_columns';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- What this file changed, live (the last statement, so `db query` prints it)
SELECT (SELECT count(*) FROM public.pos_credit_receipts) AS receipts,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'pos_credit_receipt%') AS policies,
       (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'pos_cash_movements_kind_check') AS cash_kinds;
