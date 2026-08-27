-- POS Loyalty: schemes, a points ledger, and redemption as a TENDER (S618).
--
-- Closes the last engineering item on POS_TODO's Nepal-market gap list. Half of it already
-- existed and was unused: closeOrder auto-builds pos_customers from any bill carrying a buyer
-- name + phone, so identity, dedup and the capture point were all built. What was missing is the
-- ledger, the schemes, and the moment at the till where a diner spends what they earned.
--
-- SHAPE, decided with the client before any code:
--   * Several schemes; a customer is tagged to exactly ONE, or none. Untagged earns NOTHING, so
--     loyalty is opt-in per person and no existing customer silently starts accruing.
--   * A scheme controls earn rate and minimum spend. Nothing else. Redemption VALUE is therefore
--     one client-level setting: schemes differ in how fast you earn, everyone redeems at the same
--     rate. One fewer number per scheme to keep consistent, and easier to explain to a diner.
--   * Points are per outlet. pos_customers is already client-scoped and no grouped client exists.
--
-- WHY REDEMPTION IS A TENDER AND NOT A DISCOUNT. This is the load-bearing decision; the discount
-- route looks cheaper and is not, because it collides with two things that already exist:
--
--   1. VAT. computeOrderAmounts applies discount_amount to the PRE-VAT base and recalculates VAT
--      on the discounted amount. Booking a redemption there would reduce the taxable value and
--      the VAT remitted on every redeemed bill. As a tender, VAT is charged on the full bill and
--      the points settle part of what is owed.
--   2. The per-staff discount cap. guard_pos_order_close() (S577) measures discount_amount
--      server-side against SUM(qty * unit_price) and rejects a close over pos_discount_limit — so
--      a 10%-capped waiter could not apply a 20% redemption, and the guard would reject a
--      legitimate bill mid-service. A tender touches none of close_type/status/discount_amount,
--      so that trigger does not fire at all.
--
-- KNOWN SIMPLIFICATION, stated so nobody discovers it from a P&L: revenue is recognised in full
-- and the redemption is a non-cash tender. No liability is accrued at earn time, so the cost of
-- the reward lands as reduced cash rather than an expense line. Correct double-entry would accrue
-- at earn; that is deliberately out of scope for v1 and is written into the Help text.

-- ── 1. Feature flag ──────────────────────────────────────────────────────────────────────────
-- The column that breaks every OTHER client's flag save when skipped: FeatureAccessModal writes
-- the whole row, so a key with no column 400s the entire save, not just this feature.
ALTER TABLE public.feature_flags ADD COLUMN IF NOT EXISTS loyalty boolean DEFAULT false;

-- ── 2. Schemes ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_loyalty_schemes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name              text NOT NULL,
  -- Points earned per NPR 100 of the ex-VAT, post-discount base. Numeric rather than integer so a
  -- scheme can run at 0.5/100 without needing a second "per how many rupees" column.
  points_per_100    numeric NOT NULL DEFAULT 1 CHECK (points_per_100 >= 0),
  -- A bill below this earns nothing at all. Not a threshold the points are measured ABOVE — the
  -- whole bill earns once it qualifies, which is what a diner expects and what staff can explain.
  min_spend_to_earn numeric NOT NULL DEFAULT 0 CHECK (min_spend_to_earn >= 0),
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_loyalty_schemes_client ON public.pos_loyalty_schemes (client_id);

-- Tag: nullable, SET NULL on delete. Deleting a scheme un-enrols its members rather than
-- cascading away the customers themselves.
ALTER TABLE public.pos_customers
  ADD COLUMN IF NOT EXISTS loyalty_scheme_id uuid REFERENCES public.pos_loyalty_schemes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pos_customers_loyalty_scheme
  ON public.pos_customers (loyalty_scheme_id) WHERE loyalty_scheme_id IS NOT NULL;

-- ── 3. The ledger ────────────────────────────────────────────────────────────────────────────
-- Balance is SUM(points) and is NEVER stored as a column. Same reasoning as payable_payments
-- behind Outstanding Payables: a stored balance and its ledger are two sources for one number,
-- and the day they disagree there is no way to tell which is right.
CREATE TABLE IF NOT EXISTS public.pos_loyalty_ledger (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.pos_customers(id) ON DELETE CASCADE,
  order_id    uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  kind        text NOT NULL CHECK (kind IN ('earn', 'redeem', 'adjust')),
  -- Signed: earn is positive, redeem negative, adjust either way. One column means the balance is
  -- a plain SUM with no CASE, which is what keeps every reader of it identical.
  points      integer NOT NULL,
  -- Which scheme produced this row. Kept even though the customer's tag is on pos_customers, so a
  -- later rate change or re-tag can never retro-explain an old row as something it was not.
  scheme_id   uuid REFERENCES public.pos_loyalty_schemes(id) ON DELETE SET NULL,
  note        text,
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The balance query is "every row for this customer", so customer_id leads.
CREATE INDEX IF NOT EXISTS idx_pos_loyalty_ledger_customer ON public.pos_loyalty_ledger (customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pos_loyalty_ledger_client   ON public.pos_loyalty_ledger (client_id, created_at);

-- Idempotency, enforced by the database rather than by the caller remembering. closeOrder retries
-- on several failure paths and award_loyalty_points is called from inside it; without this a
-- retried close awards the same bill twice.
CREATE UNIQUE INDEX IF NOT EXISTS pos_loyalty_ledger_one_earn_per_order
  ON public.pos_loyalty_ledger (order_id) WHERE kind = 'earn' AND order_id IS NOT NULL;

-- ── 4. RLS ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pos_loyalty_schemes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_loyalty_ledger  ENABLE ROW LEVEL SECURITY;

-- Schemes: ordinary same-client-or-admin. A manager edits these from the Customers page, so
-- writes are allowed here; there is no money in a scheme definition.
DROP POLICY IF EXISTS pos_loyalty_schemes_client ON public.pos_loyalty_schemes;
CREATE POLICY pos_loyalty_schemes_client ON public.pos_loyalty_schemes
  TO authenticated
  USING (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  )
  WITH CHECK (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  );

-- Ledger: SELECT ONLY. There is deliberately no INSERT/UPDATE/DELETE policy at all, so the two
-- RPCs below are the only write path — the same shape as set_outlet_access (S617) and
-- apply_pos_item_comps (S579). A points balance is money-adjacent, and a permissive client policy
-- would let any till JWT PATCH itself whatever balance it liked.
DROP POLICY IF EXISTS pos_loyalty_ledger_select ON public.pos_loyalty_ledger;
CREATE POLICY pos_loyalty_ledger_select ON public.pos_loyalty_ledger
  FOR SELECT TO authenticated
  USING (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  );

-- The ONE exception to "no write policy", and it is not a hole: Export/Import restore
-- (src/modules/admin/dataExport/restoreClientData.js) inserts through the BROWSER client with an
-- admin's session, i.e. as `authenticated` — not through the service role. Without this, a
-- restored client would come back with every customer's points balance silently at zero, which is
-- worse than the risk it avoids. Scoped to admins only, so the threat this table is designed
-- against — a till JWT minting itself points — is untouched. Same posture as feature_flags'
-- admin-only writes (S531).
DROP POLICY IF EXISTS pos_loyalty_ledger_admin_insert ON public.pos_loyalty_ledger;
CREATE POLICY pos_loyalty_ledger_admin_insert ON public.pos_loyalty_ledger
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin');

-- Staff-account isolation, mirroring pos_order_items. POS PIN staff are deliberately NOT fenced
-- out — they are the ones who ring the bill that earns and apply the redemption.
CREATE POLICY no_self_service_accounts ON public.pos_loyalty_schemes AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_ims_staff ON public.pos_loyalty_schemes AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
CREATE POLICY no_hr_role_staff ON public.pos_loyalty_schemes AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

CREATE POLICY no_self_service_accounts ON public.pos_loyalty_ledger AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_ims_staff ON public.pos_loyalty_ledger AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
CREATE POLICY no_hr_role_staff ON public.pos_loyalty_ledger AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

-- Raw-SQL tables get NO role grants in this project by default — a missing GRANT reads as an RLS
-- failure. The ledger gets SELECT + INSERT only: INSERT is what the admin-only restore policy
-- above needs to be reachable at all, and RLS is what narrows it to admins. No UPDATE and no
-- DELETE for anyone but the service role — a ledger whose past rows can be edited is not a
-- ledger, and Danger Zone clears it through the service role like every other client table.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_loyalty_schemes TO authenticated;
GRANT ALL                            ON public.pos_loyalty_schemes TO service_role;
GRANT SELECT, INSERT                 ON public.pos_loyalty_ledger  TO authenticated;
GRANT ALL                            ON public.pos_loyalty_ledger  TO service_role;

-- ── 5. Redemption value, and the two CHECK constraints ────────────────────────────────────────
-- One client-level rupee value per point, edited in POS → Table Management beside Discounts and
-- Delivery Partners. settings has been same-client writable since S290.
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS pos_loyalty_point_value numeric DEFAULT 1;

-- 'Loyalty' becomes a valid per-leg tender, and a valid whole-bill method for the case where
-- points cover the entire bill. Current lists confirmed from 20260707160000 (which reverted the
-- Foodmandu/Pathao experiment) and the baseline respectively — not from the baseline alone.
ALTER TABLE public.pos_order_payments DROP CONSTRAINT pos_order_payments_payment_method_check;
ALTER TABLE public.pos_order_payments ADD CONSTRAINT pos_order_payments_payment_method_check
  CHECK (payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Loyalty'::text]));

ALTER TABLE public.pos_orders DROP CONSTRAINT pos_orders_payment_method_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_payment_method_check
  CHECK (payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Credit'::text, 'Split'::text, 'Loyalty'::text]));

-- NOTE for the frontend half: 'Loyalty' must NOT join PAYMENT_METHODS in posOrdersConstants.js.
-- That constant is the SELECTABLE list, and S290→S291 already learned this with Foodmandu/Pathao:
-- they were added as pickable methods, which was wrong because a cashier does not choose them.
-- A redemption is applied when the customer has a balance; the rest of the bill is then tendered
-- normally through the existing split machinery.

-- ── 6. Earn ──────────────────────────────────────────────────────────────────────────────────
-- Computes from the ORDER'S OWN STORED LINES, never from a caller-supplied amount. A till that
-- can name its own earn base can mint points, which is S579's rule (attribution the caller
-- chooses is not attribution) applied to a balance instead of a name.
DROP FUNCTION IF EXISTS public.award_loyalty_points(uuid);
CREATE FUNCTION public.award_loyalty_points(p_order_id uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_caller_client uuid;
  v_order         record;
  v_customer      uuid;
  v_scheme_id     uuid;
  v_scheme        record;
  v_base          numeric;
  v_points        integer;
BEGIN
  SELECT client_id INTO v_caller_client FROM profiles WHERE id = (select auth.uid());

  SELECT o.id, o.client_id, o.buyer_phone, o.discount_amount, o.close_type
    INTO v_order
    FROM pos_orders o WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  -- SECURITY DEFINER bypasses RLS entirely, so the caller check is this function's own job.
  IF NOT (COALESCE(public.is_admin(), false) OR v_order.client_id = v_caller_client) THEN
    RAISE EXCEPTION 'Not permitted.';
  END IF;

  -- Only a real sale earns. A void has no revenue and a complimentary write-off was given away.
  IF v_order.close_type IS DISTINCT FROM 'paid' THEN RETURN 0; END IF;
  IF v_order.buyer_phone IS NULL OR btrim(v_order.buyer_phone) = '' THEN RETURN 0; END IF;

  -- Matched on exact phone, which is what closeOrder's upsert conflicts on and is therefore
  -- guaranteed unique. NOT phone_canonical: that column is generated but NOT unique, so two rows
  -- can legitimately share one canonical form and the lookup would be ambiguous.
  SELECT c.id, c.loyalty_scheme_id INTO v_customer, v_scheme_id
    FROM pos_customers c
   WHERE c.client_id = v_order.client_id AND c.phone = v_order.buyer_phone;
  IF v_customer IS NULL OR v_scheme_id IS NULL THEN RETURN 0; END IF;

  SELECT s.* INTO v_scheme FROM pos_loyalty_schemes s
   WHERE s.id = v_scheme_id AND s.is_active;
  -- Tagged to a scheme that has since been deactivated: earns nothing, silently and by design.
  IF v_scheme.id IS NULL THEN RETURN 0; END IF;

  -- Ex-VAT, post-discount, comps excluded — byte-for-byte the base PosCustomers settles delivery
  -- commission against (S596), so the two can never disagree about what a bill was worth.
  SELECT COALESCE(SUM(i.qty * i.unit_price), 0) INTO v_base
    FROM pos_order_items i
   WHERE i.order_id = p_order_id AND COALESCE(i.comped, false) = false;
  v_base := v_base - COALESCE(v_order.discount_amount, 0);

  IF v_base < v_scheme.min_spend_to_earn OR v_base <= 0 THEN RETURN 0; END IF;

  v_points := floor(v_base / 100.0 * v_scheme.points_per_100);
  IF v_points <= 0 THEN RETURN 0; END IF;

  -- The unique index is the real guard; this keeps a retry from raising instead of no-opping.
  IF EXISTS (SELECT 1 FROM pos_loyalty_ledger WHERE order_id = p_order_id AND kind = 'earn') THEN
    RETURN 0;
  END IF;

  INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, scheme_id, created_by)
  VALUES (v_order.client_id, v_customer, p_order_id, 'earn', v_points, v_scheme.id, (select auth.uid()));

  RETURN v_points;
END;
$fn$;

-- ── 7. Redeem ────────────────────────────────────────────────────────────────────────────────
-- Writes the ledger row AND the tender in one transaction, so a 'Loyalty' tender can never exist
-- without the points that paid for it, and points can never be spent without a bill to show it.
DROP FUNCTION IF EXISTS public.redeem_loyalty_points(uuid, integer);
CREATE FUNCTION public.redeem_loyalty_points(p_order_id uuid, p_points integer) RETURNS numeric
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
DECLARE
  v_caller_client uuid;
  v_order         record;
  v_customer      uuid;
  v_balance       integer;
  v_value         numeric;
  v_amount        numeric;
BEGIN
  IF p_points IS NULL OR p_points <= 0 THEN
    RAISE EXCEPTION 'Redeem a positive number of points.';
  END IF;

  SELECT client_id INTO v_caller_client FROM profiles WHERE id = (select auth.uid());

  SELECT o.id, o.client_id, o.buyer_phone, o.status
    INTO v_order
    FROM pos_orders o WHERE o.id = p_order_id;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found.'; END IF;

  IF NOT (COALESCE(public.is_admin(), false) OR v_order.client_id = v_caller_client) THEN
    RAISE EXCEPTION 'Not permitted.';
  END IF;

  IF v_order.buyer_phone IS NULL OR btrim(v_order.buyer_phone) = '' THEN
    RAISE EXCEPTION 'This bill has no customer phone, so there is no balance to redeem from.';
  END IF;

  SELECT c.id INTO v_customer FROM pos_customers c
   WHERE c.client_id = v_order.client_id AND c.phone = v_order.buyer_phone;
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

  INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, created_by)
  VALUES (v_order.client_id, v_customer, p_order_id, 'redeem', -p_points, (select auth.uid()));

  INSERT INTO pos_order_payments (order_id, client_id, payment_method, amount, recorded_by)
  VALUES (p_order_id, v_order.client_id, 'Loyalty', v_amount, (select auth.uid()));

  RETURN v_amount;
END;
$fn$;

-- ── 8. Grants ────────────────────────────────────────────────────────────────────────────────
-- REVOKE FROM anon alone is a silent no-op while PUBLIC holds the grant, and a fresh function
-- carries Postgres's default GRANT EXECUTE TO PUBLIC (S532).
REVOKE EXECUTE ON FUNCTION public.award_loyalty_points(uuid)           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.award_loyalty_points(uuid)           TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.redeem_loyalty_points(uuid, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- ── Verification ─────────────────────────────────────────────────────────────────────────────
--   SELECT has_function_privilege('anon','public.redeem_loyalty_points(uuid,integer)','EXECUTE');  -- false
--   SELECT has_table_privilege('authenticated','public.pos_loyalty_ledger','UPDATE');              -- false
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pos_loyalty_ledger'::regclass;         -- true
--
-- The grant layer alone does NOT prove the ledger is protected — `authenticated` legitimately
-- holds INSERT so the admin-only restore policy is reachable. The check that matters is a real
-- INSERT from a NON-admin session (a POS till token), which RLS must reject with 42501. Do it
-- through PostgREST with that session's own token, the way the S577/S579 guards were tested.
--   -- Both CHECKs must now admit the new tender value:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('pos_order_payments_payment_method_check',
--                      'pos_orders_payment_method_check');        -- both must contain 'Loyalty'
--
-- Live, with a till session: an ordinary bill for an untagged customer must still close and award
-- nothing (the control that proves the guard is not simply refusing everything), then tag that
-- customer to a scheme, close another bill, and confirm exactly one 'earn' row appears.
