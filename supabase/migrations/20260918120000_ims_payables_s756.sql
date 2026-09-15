-- S756 — IMS re-analysis, stage 3: settling a bill with supplier credit (owner decision D11).
--
-- A supplier credit is a bill whose payments exceed what is now owed on it — goods returned after
-- it was paid (S723). Until now Outstanding Payables showed it in purple and said "take it off the
-- next bill", with no way to record doing so: the credit sat forever, and the next bill sat
-- short-paid forever beside it.
--
-- Using a credit is recorded as a PAIR of payable_payments rows sharing one credit_link_id:
--   * a NEGATIVE row on the line holding the credit (its payments go down by the amount used), and
--   * an equal POSITIVE row on the line being paid (its payments go up by the same amount).
-- Every screen that sums payments per line (Outstanding Payables, Vendor Report's drilldown, the
-- Vendor Balance Confirmation letter, the Owner Dashboard, the Monthly Report) then tells the truth
-- without knowing credits exist, and every figure still derives from rows a reader can point at.
--
-- The browser writes both halves in ONE insert (one statement, one transaction). What this
-- migration adds is the refusal of a pair that does not hold together, checked at COMMIT by a
-- deferred constraint trigger so the two halves may arrive in either order within the statement:
--   * exactly two rows per link, one negative and one positive, summing to zero, on one date;
--   * both on Credit bills of the SAME supplier and the same client, on two different bills;
--   * the line the credit is taken from is not left with negative payments — a credit can only
--     come out of money that was actually paid on it.
-- Deleting one half alone is refused by the same check, so a pair is deleted together or not at all.
--
-- Deliberately NOT checked here: that the amount used is no more than the bill's CREDIT (paid minus
-- what is owed after returns, VAT and the bill discount). That figure is calcBillTotals over the
-- bill's lines and its returns, and a second copy of it in SQL would be a second definition of what
-- a bill is owed (vendor-payables.md). The page refuses it from the same arithmetic the table shows;
-- the payments-not-negative rule above is the floor that stops money being invented from nothing.
--
-- No RPC. A single insert is already atomic; an RPC would only have added the paid_at stamps, which
-- are a recoverable second write the page already words honestly.
--
-- Carve-outs: the service role / DEFINER bodies / FK cascades (current_user), and admin — a restore
-- inserts payable_payments in 500-row chunks, which can split a pair across two requests.
-- ims_rank_guard (20260918100000) still requires IMS manager for every write to this table.


-- ══ 1. Columns and row-level constraints ═════════════════════════════════════════════════════════

ALTER TABLE public.payable_payments ADD COLUMN IF NOT EXISTS credit_link_id uuid;

-- Partners are read and deleted by link id (Outstanding Payables deletes a pair in one statement).
CREATE INDEX IF NOT EXISTS idx_payable_payments_credit_link_id
  ON public.payable_payments (credit_link_id) WHERE credit_link_id IS NOT NULL;

-- A row carries the 'Supplier credit' mode exactly when it carries a link. COALESCE: payment_mode is
-- NULL on rows written before 20260803100000, and NULL = false is NULL, which a CHECK would pass.
-- payablesAllocation.js's SUPPLIER_CREDIT_MODE spells the same string.
ALTER TABLE public.payable_payments DROP CONSTRAINT IF EXISTS payable_payments_credit_mode_matches_link;
ALTER TABLE public.payable_payments ADD CONSTRAINT payable_payments_credit_mode_matches_link
  CHECK ((COALESCE(payment_mode, '') = 'Supplier credit') = (credit_link_id IS NOT NULL)) NOT VALID;

-- Money paid is positive; only a credit half may be negative, and never zero.
ALTER TABLE public.payable_payments DROP CONSTRAINT IF EXISTS payable_payments_amount_sign;
ALTER TABLE public.payable_payments ADD CONSTRAINT payable_payments_amount_sign
  CHECK (CASE WHEN credit_link_id IS NULL THEN amount > 0 ELSE amount <> 0 END) NOT VALID;

-- NOT VALID above so a historical row nobody has looked at cannot fail the whole migration; both are
-- enforced on every new or changed row regardless. Validate now where history allows, and say so
-- where it does not rather than aborting.
DO $$
BEGIN
  BEGIN
    ALTER TABLE public.payable_payments VALIDATE CONSTRAINT payable_payments_credit_mode_matches_link;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'S756: payable_payments_credit_mode_matches_link left NOT VALID — existing rows carry payment_mode ''Supplier credit'' with no link';
  END;
  BEGIN
    ALTER TABLE public.payable_payments VALIDATE CONSTRAINT payable_payments_amount_sign;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'S756: payable_payments_amount_sign left NOT VALID — existing ordinary payments with amount <= 0';
  END;
END $$;


-- ══ 2. The pair check ════════════════════════════════════════════════════════════════════════════

-- What is wrong with one credit link, or NULL when nothing is. SECURITY DEFINER so the check cannot
-- pass vacuously for a caller whose RLS view of payable_payments or purchase_entries is narrower
-- than the rows involved (the S698/S707 lookup pattern). Returns only a sentence, never row data.
CREATE OR REPLACE FUNCTION public.payable_credit_link_problem(p_link uuid)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n        integer;
  v_neg      integer;
  v_pos      integer;
  v_sum      numeric;
  v_dates    integer;
  v_clients  integer;
  v_client   uuid;
  v_src      uuid;
  v_tgt      uuid;
  v_s        record;
  v_t        record;
  v_src_net  numeric;
BEGIN
  IF p_link IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE amount < 0), count(*) FILTER (WHERE amount > 0),
         COALESCE(sum(amount), 0), count(DISTINCT paid_at), count(DISTINCT client_id), min(client_id::text)::uuid
    INTO v_n, v_neg, v_pos, v_sum, v_dates, v_clients, v_client
    FROM payable_payments
   WHERE credit_link_id = p_link;

  -- Both halves gone together is a clean delete.
  IF v_n = 0 THEN
    RETURN NULL;
  END IF;
  IF v_n <> 2 OR v_neg <> 1 OR v_pos <> 1 THEN
    RETURN 'a supplier credit is recorded as exactly two entries — one taken off the bill holding the credit and one paid onto the other bill — so the two are saved and deleted together';
  END IF;
  IF v_sum <> 0 THEN
    RETURN 'the two entries of a supplier credit must be the same amount';
  END IF;
  IF v_dates <> 1 OR v_clients <> 1 THEN
    RETURN 'the two entries of a supplier credit must carry the same date';
  END IF;

  SELECT purchase_entry_id INTO v_src FROM payable_payments WHERE credit_link_id = p_link AND amount < 0;
  SELECT purchase_entry_id INTO v_tgt FROM payable_payments WHERE credit_link_id = p_link AND amount > 0;

  SELECT pe.vendor_id, pe.payment_method, COALESCE(pe.purchase_group_id::text, pe.id::text) AS bill, mp.client_id
    INTO v_s
    FROM purchase_entries pe JOIN monthly_periods mp ON mp.id = pe.period_id
   WHERE pe.id = v_src;
  IF NOT FOUND THEN
    RETURN 'the bill the supplier credit was taken from no longer exists';
  END IF;
  SELECT pe.vendor_id, pe.payment_method, COALESCE(pe.purchase_group_id::text, pe.id::text) AS bill, mp.client_id
    INTO v_t
    FROM purchase_entries pe JOIN monthly_periods mp ON mp.id = pe.period_id
   WHERE pe.id = v_tgt;
  IF NOT FOUND THEN
    RETURN 'the bill the supplier credit was used on no longer exists';
  END IF;

  IF v_s.client_id IS DISTINCT FROM v_client OR v_t.client_id IS DISTINCT FROM v_client THEN
    RETURN 'a supplier credit can only move between bills of the same business';
  END IF;
  IF v_s.vendor_id IS NULL OR v_s.vendor_id IS DISTINCT FROM v_t.vendor_id THEN
    RETURN 'a supplier credit can only be used on another bill from the same supplier';
  END IF;
  IF COALESCE(v_s.payment_method, '') <> 'Credit' OR COALESCE(v_t.payment_method, '') <> 'Credit' THEN
    RETURN 'a supplier credit can only move between bills bought on credit';
  END IF;
  -- purchase_group_id, else the line: a legacy ungrouped bill's two lines compare as different
  -- bills here. The page never pairs within one bill; this stops the obvious misuse, not every one.
  IF v_s.bill = v_t.bill THEN
    RETURN 'a supplier credit has to move to a different bill';
  END IF;

  SELECT COALESCE(sum(amount), 0) INTO v_src_net FROM payable_payments WHERE purchase_entry_id = v_src;
  IF v_src_net < 0 THEN
    RETURN 'more supplier credit was taken from that bill than was ever paid on it';
  END IF;

  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.payable_credit_link_problem(uuid) FROM PUBLIC;
-- authenticated needs it: the INVOKER trigger below calls it in the writer's session.
GRANT EXECUTE ON FUNCTION public.payable_credit_link_problem(uuid) TO authenticated, service_role;

-- SECURITY INVOKER on purpose: under DEFINER current_user is the owner every time and the service-
-- role/cascade carve-out would swallow every caller (the S531 reasoning).
CREATE OR REPLACE FUNCTION public.payable_payments_credit_pair_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_link    uuid;
  v_problem text;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NULL;
  END IF;

  FOREACH v_link IN ARRAY ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.credit_link_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.credit_link_id END
  ] LOOP
    CONTINUE WHEN v_link IS NULL;
    v_problem := public.payable_credit_link_problem(v_link);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'supplier_credit_unbalanced: %', v_problem
        USING ERRCODE = 'P0001', HINT = 'supplier_credit_unbalanced';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.payable_payments_credit_pair_check() FROM PUBLIC;

-- DEFERRABLE INITIALLY DEFERRED: fires at COMMIT, after both halves of the insert (or both halves
-- of the delete) have landed, so the order inside one statement does not matter.
DROP TRIGGER IF EXISTS payable_payments_credit_pair ON public.payable_payments;
CREATE CONSTRAINT TRIGGER payable_payments_credit_pair
  AFTER INSERT OR UPDATE OR DELETE ON public.payable_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payable_payments_credit_pair_check();

NOTIFY pgrst, 'reload schema';


-- ══ 3. Self-check ════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'payable_payments' AND column_name = 'credit_link_id') THEN
    RAISE EXCEPTION 'S756: payable_payments.credit_link_id missing';
  END IF;

  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.payable_payments'::regclass
         AND conname IN ('payable_payments_credit_mode_matches_link', 'payable_payments_amount_sign')) <> 2 THEN
    RAISE EXCEPTION 'S756: a payable_payments credit CHECK is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger tg
                  WHERE tg.tgrelid = 'public.payable_payments'::regclass
                    AND tg.tgname = 'payable_payments_credit_pair'
                    AND tg.tgdeferrable AND tg.tginitdeferred AND NOT tg.tgisinternal) THEN
    RAISE EXCEPTION 'S756: payable_payments_credit_pair is missing or not INITIALLY DEFERRED';
  END IF;

  -- The INVOKER/DEFINER pair must not be swapped: swap either and the check stops working silently.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.payable_payments_credit_pair_check()'::regprocedure) THEN
    RAISE EXCEPTION 'S756: payable_payments_credit_pair_check is SECURITY DEFINER — current_user would be the owner and it would never fire';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.payable_credit_link_problem(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'S756: payable_credit_link_problem must be SECURITY DEFINER or it passes vacuously under RLS';
  END IF;

  IF has_function_privilege('anon', 'public.payable_credit_link_problem(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S756: payable_credit_link_problem is anon-executable';
  END IF;

  -- Execute the body once (a plpgsql body is only resolved on first run, S735): an unknown link is clean.
  IF public.payable_credit_link_problem(gen_random_uuid()) IS NOT NULL THEN
    RAISE EXCEPTION 'S756: payable_credit_link_problem reports a problem for a link with no rows';
  END IF;
END $$;
