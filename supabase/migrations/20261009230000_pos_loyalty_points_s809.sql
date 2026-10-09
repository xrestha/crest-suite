-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 2, slice 2g: loyalty points follow the money.
--
--   CUSTOMERS-PARKING-1 (P2). Picking a delivery partner on a Credit bill puts the platform's name and
--   phone on the bill and in the customer book. award_loyalty_points never asked who the buyer was, so
--   an enrolled platform earned points on its own unpaid bills (BLOOM CAFE's only till award: 188
--   points = NPR 1,880, the whole bill), and redeem_loyalty_points let any bill carrying the platform's
--   phone spend them, the platform's own next order included. Now a bill tagged to a partner, or whose
--   phone is one of the outlet's partner phones (as typed, or the same number written another way),
--   earns nothing and cannot spend points (HINT pos_points_delivery_partner). A cancel (0 points)
--   still works on such a bill, so a redemption made before the partner was picked can be handed back.
--
--   CUSTOMERS-PARKING-2 (P2). A redemption is written to the ledger, with a Loyalty payment line on
--   the open bill, BEFORE the close. Only the till that redeemed it could hand it back, and only while
--   it remembered (not after a reload, a till lock that could not reach the server, an outlet move, or
--   on a second till). The bill was then charged Cash in full with the points still spent, or charged
--   Split and its payment lines refused. Now guard_pos_order_close hands back, in the close's own
--   transaction, any redemption standing on a bill that closes any way but a Split charge (Cash, Card,
--   QR, Credit, Complimentary, Void): a Loyalty line belongs only on a Split charge, because the till
--   turns Split on when points are applied. The points go back to the guest and the line goes. A Split
--   charge keeps its line: the till redeems for that press just before it (and, from this release,
--   hands back first when it charges Split without points).
--
--   CUSTOMERS-PARKING-3 (P2). The till took a failed read of the point value as NPR 1 a point and never
--   compared the amount the server charged. That is the till's half (PosOrders.jsx). The database half:
--   settings.pos_loyalty_point_value must be more than 0 (CHECK). Only the Loyalty form refused 0, and
--   at 0 a redemption spent the guest's points for a NPR 0 line. NULL stays allowed and reads as NPR 1
--   everywhere, as the column default, the till and redeem_loyalty_points already read it.
--
--   The other numbers on a bill are untouched: what a bill earns (stored, non-comped lines minus the
--   discount), the redemption cap, the 10-minute award window, the replace-on-redeem rule.
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-09 after slice 2c went
-- live). Section 0 refuses to run over any other body. Every change inside them is a block marked
-- "S809 2g".
--   award_loyalty_points(uuid)            38636fa2b1d6a9e5d96080fc1d97e3b8  (S754's, 20260916100000)
--   redeem_loyalty_points(uuid, integer)  bef3b76d360b895f469c2565f4fc0270  (S754's, 20260916100000)
--   guard_pos_order_close()               4d5725cfb7600e3f5fa16c16db1e81b8  (slice 2c's, 20261009200000)
-- No signature changes. award/redeem stay SECURITY DEFINER with search_path public and proacl
-- {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}; guard_pos_order_close stays
-- SECURITY INVOKER with proacl {postgres=X/postgres}. CREATE OR REPLACE keeps the grants.
-- New: pos_phone_is_delivery_partner(uuid, text), an INVOKER helper with no client grant (only the two
-- DEFINER bodies above call it), and the CHECK settings_pos_loyalty_point_value_positive.
-- Not touched (slice 2h owns them, drafted at the same time): save_pos_order_items, push_master_data.
--
-- Live before this migration (2026-10-09, after the owner cleared BLOOM CAFE's data):
--   * pos_loyalty_ledger 0 rows, pos_customers 0, pos_loyalty_schemes 0, pos_orders 0,
--     pos_order_payments with payment_method 'Loyalty' 0. BLOOM CAFE's 188 partner points went with
--     the clear, so there is nothing to zero: this migration writes no ledger row. Section 3 counts any
--     partner phone holding points at the apply moment and only reports it, because from here on such
--     a balance can be neither added to nor spent.
--   * settings: 4 rows (the global row and three outlets); pos_loyalty_point_value is 1, 1, 1 and 10
--     (BLOOM CAFE); 0 rows are NULL and 0 are 0 or below, so the CHECK rejects 0 rows today.
--   * settings.pos_loyalty_point_value: numeric, nullable, DEFAULT 1. BLOOM CAFE has 2 delivery
--     partners, each with a phone (10 and 9 digits); the other outlets have none.
--
-- Ship order: this migration BEFORE the app. A till on crest-v420 is refused nothing in normal service
-- (see the slice report): the partner refusal needs a partner phone holding points, which nothing can
-- now give it, and the close hands points back rather than refusing.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN supervisor, its Owner and the operator inside a
-- block that rolls itself back. If any check fails, the whole migration fails and nothing lands.
-- Drafted against a local Postgres 17 copy of the live tables, policies, table and function grants,
-- triggers and every public function (bs_months included): the file runs clean, and again over
-- itself; each of eleven one-line reversals of a fix fails the probe; a point value of 0 already
-- stored stops it at section 1; and two partner customer rows holding points are counted in section 3.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
-- The second hash of each pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.award_loyalty_points(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '38636fa2b1d6a9e5d96080fc1d97e3b8' AND v_md5 IS DISTINCT FROM '09de0865750b36accc1ae68b4075c5e3' THEN
    RAISE EXCEPTION 'S809 2g: award_loyalty_points changed since this slice was drafted (live md5 %) — merge section 4 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.redeem_loyalty_points(uuid,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'bef3b76d360b895f469c2565f4fc0270' AND v_md5 IS DISTINCT FROM '00f0f2bfb8a7de290795b6737681b925' THEN
    RAISE EXCEPTION 'S809 2g: redeem_loyalty_points changed since this slice was drafted (live md5 %) — merge section 5 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '4d5725cfb7600e3f5fa16c16db1e81b8' AND v_md5 IS DISTINCT FROM '2b5f4cd801170bafc620052cf40d2620' THEN
    RAISE EXCEPTION 'S809 2g: guard_pos_order_close changed since this slice was drafted (live md5 %) — merge section 6 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. A point is worth more than nothing (CUSTOMERS-PARKING-3) ──────────────────────────────
-- At 0 a redemption spent the guest's points for a NPR 0 Loyalty line, while the till (which reads
-- 0 as 1) showed them worth NPR 1 each. Only the Customers → Loyalty form refused it; a CHECK sees
-- every writer (a REST write, the operator's restore, any later screen). NULL is left allowed: it
-- reads as NPR 1 (the column default) in redeem_loyalty_points and on the till alike.
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM public.settings WHERE pos_loyalty_point_value <= 0;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'S809 2g: % settings rows value a loyalty point at NPR 0 or less — set each to the value the Owner meant before applying', v_n;
  END IF;
END;
$$;

ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_pos_loyalty_point_value_positive;
ALTER TABLE public.settings ADD CONSTRAINT settings_pos_loyalty_point_value_positive
  CHECK (pos_loyalty_point_value IS NULL OR pos_loyalty_point_value > 0);


-- ── 2. Is this phone one of the outlet's delivery partners? (CUSTOMERS-PARKING-1) ─────────────
-- The till's partner picker copies the partner's phone onto the bill exactly as POS Setup stores it,
-- so the first test is the same text. A phone typed by hand in another form (+977, dashes, a leading
-- 0) is caught by the second: both written the way pos_customers.phone_canonical writes a phone
-- (digits only, a leading 977 dropped from 11 digits or more, then leading zeros), and only when the
-- result has 7 digits or more, as normalizePhone in src/utils/phone.js. isDeliveryPartnerPhone in
-- src/modules/pos/customers/loyaltyPoints.js is the till's twin: change both together.
-- No settings row, a NULL or non-array partner list, or a partner with no phone matches nothing.
-- INVOKER, with no client grant: award_loyalty_points and redeem_loyalty_points (DEFINER) are its
-- only callers, and inside them it runs as their owner.
CREATE OR REPLACE FUNCTION public.pos_phone_is_delivery_partner(p_client_id uuid, p_phone text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT btrim(COALESCE(p_phone, '')) AS raw,
           regexp_replace(CASE WHEN d ~ '^977.{8,}' THEN substr(d, 4) ELSE d END, '^0+', '') AS canon
      FROM (SELECT regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g') AS d) x
  )
  SELECT EXISTS (
    SELECT 1
      FROM b, settings s
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(s.pos_delivery_partners) = 'array' THEN s.pos_delivery_partners ELSE '[]'::jsonb END) AS e(v)
     CROSS JOIN LATERAL (
             SELECT btrim(COALESCE(e.v ->> 'phone', '')) AS raw,
                    regexp_replace(CASE WHEN d ~ '^977.{8,}' THEN substr(d, 4) ELSE d END, '^0+', '') AS canon
               FROM (SELECT regexp_replace(COALESCE(e.v ->> 'phone', ''), '\D', '', 'g') AS d) y) p
     WHERE s.client_id = p_client_id
       AND b.raw <> '' AND p.raw <> ''
       AND (p.raw = b.raw OR (length(p.canon) >= 7 AND p.canon = b.canon)))
$function$;

REVOKE ALL ON FUNCTION public.pos_phone_is_delivery_partner(uuid, text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.pos_phone_is_delivery_partner(uuid, text) IS
  'S809 2g: true when p_phone is one of the outlet''s settings.pos_delivery_partners phones, as typed or as the same number written another way. A delivery platform owes its bills; it neither earns nor spends loyalty points. Called only by award_loyalty_points and redeem_loyalty_points; twin of isDeliveryPartnerPhone (loyaltyPoints.js).';


-- ── 3. Points standing on a partner phone at the apply moment: reported, not changed ─────────
-- Live there are none (the ledger is empty since the owner's clear). A balance found here can no
-- longer grow or be spent after this migration, so it is left for the Owner to see rather than
-- written off by a migration.
DO $$
DECLARE
  v_n   int;
  v_pts bigint;
BEGIN
  SELECT count(*), COALESCE(sum(bal), 0) INTO v_n, v_pts
    FROM (SELECT c.id, sum(l.points) AS bal
            FROM public.pos_customers c
            JOIN public.pos_loyalty_ledger l ON l.customer_id = c.id
           WHERE public.pos_phone_is_delivery_partner(c.client_id, c.phone)
           GROUP BY c.id
          HAVING sum(l.points) <> 0) t;
  RAISE NOTICE 'S809 2g: % delivery-partner customer rows hold a points balance (% points in all); they can no longer earn or spend', v_n, v_pts;
END;
$$;


-- ── 4. award_loyalty_points ───────────────────────────────────────────────────────────────────
-- The live body (S754's) with one S809 2g block: a bill tagged to a delivery partner, or on a
-- partner's phone, earns nothing.
CREATE OR REPLACE FUNCTION public.award_loyalty_points(p_order_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         o.closed_by, o.closed_at, o.credit_note_id, o.delivery_partner
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

  -- ── S809 2g (CUSTOMERS-PARKING-1): a delivery platform is not a diner ──────────────────────
  -- A partner's bill is owed by the platform, which remits it later; the platform is in the customer
  -- book only because the picker puts its name and phone on the bill. Tagged to a partner, or on a
  -- partner's phone (picked, or typed by hand), the bill earns nothing, whoever is enrolled. A tag is
  -- never blank (pos_orders_delivery_partner_check), and the helper never returns NULL.
  IF v_order.delivery_partner IS NOT NULL
     OR public.pos_phone_is_delivery_partner(v_order.client_id, v_order.buyer_phone) THEN
    RETURN 0;
  END IF;
  -- ── end S809 2g ──────────────────────────────────────────────────────────────────────────

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
$function$;


-- ── 5. redeem_loyalty_points ──────────────────────────────────────────────────────────────────
-- The live body (S754's) with two S809 2g blocks: a handback says so in the ledger, and a partner's
-- bill cannot spend points. Unchanged otherwise: guard_pos_order_close (section 6) now calls it with
-- 0 points to hand back a redemption a close would otherwise strand, through the same checks.
CREATE OR REPLACE FUNCTION public.redeem_loyalty_points(p_order_id uuid, p_points integer)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT o.id, o.client_id, o.buyer_phone, o.status, o.delivery_partner
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
            -- S809 2g: a cancel (the till's Undo or Cancel, or a close that does not take the points,
            -- section 6) says so; a replacement keeps its old wording.
            CASE WHEN p_points = 0 THEN 'Points handed back: this bill was not paid with them'
                 ELSE 'Earlier redemption on this bill replaced' END,
            v_caller);
  END LOOP;
  DELETE FROM pos_order_payments WHERE order_id = p_order_id AND payment_method = 'Loyalty';

  IF p_points = 0 THEN
    RETURN 0;
  END IF;

  IF v_order.buyer_phone IS NULL OR btrim(v_order.buyer_phone) = '' THEN
    RAISE EXCEPTION 'This bill has no customer phone, so there is no balance to redeem from.';
  END IF;

  -- ── S809 2g (CUSTOMERS-PARKING-1): a delivery platform does not spend points ───────────────
  -- Its bill is owed by the platform. A balance on a partner's phone could only have been earned on
  -- the platform's own bills (award_loyalty_points no longer gives any), so it is never spendable,
  -- on the platform's bill or on any other bill carrying that phone. After the cancel above, so
  -- points applied before a partner was picked can still be handed back.
  IF v_order.delivery_partner IS NOT NULL
     OR public.pos_phone_is_delivery_partner(v_order.client_id, v_order.buyer_phone) THEN
    RAISE EXCEPTION 'pos_points_delivery_partner: this bill is on a delivery partner''s phone, and a delivery partner does not earn or spend loyalty points — no points were redeemed; take the payment without them'
      USING ERRCODE = 'P0001', HINT = 'pos_points_delivery_partner';
  END IF;
  -- ── end S809 2g ──────────────────────────────────────────────────────────────────────────

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
$function$;


-- ── 6. guard_pos_order_close ──────────────────────────────────────────────────────────────────
-- The live body (slice 2c's) with one S809 2g block, at the end of the close branch: a close that is
-- not a Split charge hands back any redemption standing on the bill.
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


-- ── 7. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  -- Phones no real guest has: asserted absent from the outlet's customer book before the setup.
  c_r      CONSTANT text := '9800000201';      -- a regular, enrolled, 500 points
  c_dp     CONSTANT text := '9800000209';      -- the probe's delivery partner, as POS Setup stores it
  c_dp_typ CONSTANT text := '+977 980-000-0209'; -- the same number typed another way
  v_c        uuid;    -- BLOOM CAFE
  v_c2       uuid;    -- BLOOM CAFE - PKR (the operator's check is on BLOOM CAFE's bill from outside it)
  v_pin      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_owner    uuid;
  v_admin    uuid;
  v_s        uuid;    -- the probe's open shift
  v_scheme   uuid;
  v_r        uuid;    -- the regular
  v_dp       uuid;    -- the partner's customer row (enrolled, holding points as a restored backup could)
  v_dp2      uuid;    -- the partner's number typed another way, enrolled
  v_r1       uuid := gen_random_uuid();   -- pos_order_items.recipe_id has no FK
  v_o_cash   uuid;  v_o_split  uuid;  v_o_stale  uuid;  v_o_split2 uuid;
  v_o_void   uuid;  v_o_comp   uuid;  v_o_credit uuid;  v_o_disc   uuid;
  v_o_admin  uuid;  v_o_value  uuid;  v_o_p1     uuid;  v_o_p2     uuid;
  v_o_p3     uuid;  v_o_plain  uuid;
  v_amt      numeric;
  v_n        int;
  v_bal      int;
  v_st       text;
  v_hint     text;
  v_msg      text;
  v_note     text;
  v_by       uuid;
  v_value    numeric;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.settings'::regclass AND conname = 'settings_pos_loyalty_point_value_positive'
     AND contype = 'c' AND convalidated;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 2g: the point-value CHECK is missing or not validated';
  END IF;
  -- award/redeem stay DEFINER (they write the no-client-write ledger); the close guard and the new
  -- helper stay INVOKER (the guard keys on current_user; the helper runs as its DEFINER callers).
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE (oid IN ('public.award_loyalty_points(uuid)'::regprocedure, 'public.redeem_loyalty_points(uuid,integer)'::regprocedure) AND prosecdef)
      OR (oid IN ('public.guard_pos_order_close()'::regprocedure, 'public.pos_phone_is_delivery_partner(uuid,text)'::regprocedure) AND NOT prosecdef);
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S809 2g: a function changed its SECURITY mode (% of 4 as expected)', v_n;
  END IF;
  IF has_function_privilege('anon', 'public.award_loyalty_points(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.redeem_loyalty_points(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.award_loyalty_points(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.redeem_loyalty_points(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_phone_is_delivery_partner(uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_phone_is_delivery_partner(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 2g: EXECUTE grants on the loyalty functions are not as expected';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid = 'public.pos_orders'::regclass
     AND tgname = 'guard_pos_order_close' AND tgtype = 19 AND tgfoid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 2g: guard_pos_order_close is not enabled as a BEFORE UPDATE row trigger on pos_orders';
  END IF;

  -- ── The logins: BLOOM CAFE's POS PIN login (its supervisor where there is one), its Owner, the
  -- operator (the same selection as slices 2b and 2c) ────────────────────────────────────────
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
    RAISE EXCEPTION 'S809 2g probe: needs BLOOM CAFE, BLOOM CAFE - PKR, a POS PIN login and the Owner of BLOOM CAFE, and the operator (got %, %, %, %, %)',
      v_c, v_c2, v_pin, v_owner, v_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_customers WHERE client_id = v_c AND phone IN (c_r, c_dp, c_dp_typ)) THEN
    RAISE EXCEPTION 'S809 2g probe: a probe phone number is already in BLOOM CAFE''s customer book';
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- The stand-in loses every other staff marker (a restrictive policy would otherwise turn an
    -- "allowed" into a vacuous 0 rows) and gets a 10% discount cap for (h). BLOOM CAFE values a point
    -- at NPR 10 (its live value) and lists one probe partner, whatever its settings are now.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = 10,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_pin;
    UPDATE public.settings
       SET pos_loyalty_point_value = 10,
           pos_delivery_partners = jsonb_build_array(jsonb_build_object('name', 'S809 2g Partner', 'phone', c_dp, 'commission_pct', 20))
     WHERE client_id = v_c;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 2g probe: expected one settings row for BLOOM CAFE, found %', v_n;
    END IF;
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S809 2g probe', 0, '{}') RETURNING id INTO v_s;

    INSERT INTO public.pos_loyalty_schemes (client_id, name, points_per_100)
      VALUES (v_c, 'S809 2g probe', 10) RETURNING id INTO v_scheme;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'Probe regular', c_r, v_scheme) RETURNING id INTO v_r;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'S809 2g Partner', c_dp, v_scheme) RETURNING id INTO v_dp;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'S809 2g Partner typed', c_dp_typ, v_scheme) RETURNING id INTO v_dp2;
    INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, kind, points, note)
      VALUES (v_c, v_r,  'earn', 500, 'S809 2g probe'),
             (v_c, v_dp, 'earn', 188, 'S809 2g probe: a partner balance from an older backup');

    -- Takeaway orders on the probe's phones. order_no is given, so the probe takes no lock on the
    -- outlet's real series. Every bill carries one NPR 1,000 dish at 0 % VAT.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990701, 'Probe regular', c_r) RETURNING id INTO v_o_cash;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990702, 'Probe regular', c_r) RETURNING id INTO v_o_split;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990703, 'Probe regular', c_r) RETURNING id INTO v_o_stale;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990704, 'Probe regular', c_r) RETURNING id INTO v_o_split2;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990705, 'Probe regular', c_r) RETURNING id INTO v_o_void;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990706, 'Probe regular', c_r) RETURNING id INTO v_o_comp;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990707, 'Probe regular', c_r) RETURNING id INTO v_o_credit;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990708, 'Probe regular', c_r) RETURNING id INTO v_o_disc;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990709, 'Probe regular', c_r) RETURNING id INTO v_o_admin;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990710, 'Probe regular', c_r) RETURNING id INTO v_o_value;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990711, 'S809 2g Partner', c_dp) RETURNING id INTO v_o_p1;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990712, 'S809 2g Partner typed', c_dp_typ) RETURNING id INTO v_o_p2;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990713, 'Probe regular', c_r) RETURNING id INTO v_o_p3;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 2g probe', 990714, 'Probe regular', c_r) RETURNING id INTO v_o_plain;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      SELECT o, v_c, v_r1, 'S809 2g probe dish', 1, 1000, 0
        FROM unnest(ARRAY[v_o_cash, v_o_split, v_o_stale, v_o_split2, v_o_void, v_o_comp, v_o_credit,
                          v_o_disc, v_o_admin, v_o_value, v_o_p1, v_o_p2, v_o_p3, v_o_plain]) AS o;

    -- ── The helper, as its callers see it ─────────────────────────────────────────────────────
    IF NOT public.pos_phone_is_delivery_partner(v_c, c_dp)
       OR NOT public.pos_phone_is_delivery_partner(v_c, c_dp_typ)
       OR NOT public.pos_phone_is_delivery_partner(v_c, '  ' || c_dp || ' ')
       OR public.pos_phone_is_delivery_partner(v_c, c_r)
       OR public.pos_phone_is_delivery_partner(v_c, NULL)
       OR public.pos_phone_is_delivery_partner(v_c, '')
       OR public.pos_phone_is_delivery_partner(v_c2, c_dp) THEN
      RAISE EXCEPTION 'S809 2g probe: pos_phone_is_delivery_partner does not tell the partner''s phone from the others';
    END IF;

    -- ── As the POS supervisor, through RLS and the INVOKER triggers ──────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 2g probe: the stand-in % is not a plain POS supervisor', v_pin;
    END IF;

    -- ── (a) CUSTOMERS-PARKING-2: points spent on an unfinished try, then the bill charged Cash.
    -- The close hands them back and takes the Loyalty line off, then the bill earns as usual ──────
    v_amt := public.redeem_loyalty_points(v_o_cash, 30);
    IF v_amt IS DISTINCT FROM 300.00 THEN
      RAISE EXCEPTION 'S809 2g probe: 30 points at NPR 10 redeemed for %', v_amt;
    END IF;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id = v_o_cash RETURNING status INTO v_st;
    IF NOT FOUND OR v_st IS DISTINCT FROM 'billed' THEN
      RAISE EXCEPTION 'S809 2g probe: the Cash charge after an unfinished redemption did not land';
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o_cash;
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_n <> 0 OR v_bal <> 500 THEN
      RAISE EXCEPTION 'S809 2g probe: the Cash charge left % payment line(s) and a balance of % (want 0 and 500)', v_n, v_bal;
    END IF;
    SELECT note, created_by INTO v_note, v_by FROM public.pos_loyalty_ledger
     WHERE order_id = v_o_cash AND kind = 'adjust' AND points = 30;
    IF v_note IS DISTINCT FROM 'Points handed back: this bill was not paid with them' OR v_by IS DISTINCT FROM v_pin THEN
      RAISE EXCEPTION 'S809 2g probe: the handback reads "%" by %', v_note, v_by;
    END IF;
    v_n := public.award_loyalty_points(v_o_cash);
    IF v_n <> 100 THEN
      RAISE EXCEPTION 'S809 2g probe: a regular''s NPR 1,000 Cash bill earned % points (want 100)', v_n;
    END IF;
    -- balance 600

    -- ── (b) A Split charge with points keeps its Loyalty line, and its other legs are recorded ───
    v_amt := public.redeem_loyalty_points(v_o_split, 30);
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Split', paid_amount = 1000
     WHERE id = v_o_split;
    SELECT count(*), COALESCE(sum(amount), 0) INTO v_n, v_amt FROM public.pos_order_payments
     WHERE order_id = v_o_split AND payment_method = 'Loyalty';
    IF v_n <> 1 OR v_amt <> 300 THEN
      RAISE EXCEPTION 'S809 2g probe: the Split charge with points kept % Loyalty line(s) worth % (want 1, 300)', v_n, v_amt;
    END IF;
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_o_split, v_c, 'Cash', 700);
    -- balance 570

    -- ── (c) For the record, the shape a till before this release can still reach: a Split charge
    -- WITHOUT points over a stale redemption keeps it, and the till's legs are then refused ───────
    PERFORM public.redeem_loyalty_points(v_o_stale, 10);
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Split', paid_amount = 1000
     WHERE id = v_o_stale;
    BEGIN
      INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
        VALUES (v_o_stale, v_c, 'Cash', 1000);
      RAISE EXCEPTION 'S809 2g probe: legs past the bill''s total were accepted beside a stale Loyalty line';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'bill_locked' THEN
        RAISE EXCEPTION 'S809 2g probe: the over-total legs were refused with hint %', v_hint;
      END IF;
    END;
    -- balance 560

    -- ── (d) This release's till: before a Split charge without points it hands back first
    -- (redeeming 0), and then the legs record ────────────────────────────────────────────────────
    PERFORM public.redeem_loyalty_points(v_o_split2, 10);
    PERFORM public.redeem_loyalty_points(v_o_split2, 0);
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Split', paid_amount = 1000
     WHERE id = v_o_split2;
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_o_split2, v_c, 'Cash', 600), (v_o_split2, v_c, 'Card', 400);
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_bal <> 560 THEN
      RAISE EXCEPTION 'S809 2g probe: after the Split charges the balance is % (want 560)', v_bal;
    END IF;

    -- ── (e) A Complimentary and (f) a Credit charge hand back too ───────────────────────────────
    PERFORM public.redeem_loyalty_points(v_o_comp, 10);
    UPDATE public.pos_orders SET status = 'billed', close_type = 'writeoff', paid_amount = 0, close_reason = 'probe'
     WHERE id = v_o_comp;
    PERFORM public.redeem_loyalty_points(v_o_credit, 10);
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Credit', paid_amount = 1000
     WHERE id = v_o_credit;
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id IN (v_o_comp, v_o_credit);
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_n <> 0 OR v_bal <> 560 THEN
      RAISE EXCEPTION 'S809 2g probe: the Complimentary and Credit closes left % line(s) and a balance of % (want 0 and 560)', v_n, v_bal;
    END IF;

    -- ── (g) A close refused further down the guard (a discount over the 10% cap) undoes its
    -- handback with it: the redemption stands until a close lands ────────────────────────────────
    PERFORM public.redeem_loyalty_points(v_o_disc, 10);
    BEGIN
      UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 500, discount_amount = 500
       WHERE id = v_o_disc;
      RAISE EXCEPTION 'S809 2g probe: a discount over the supervisor''s cap was accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE '%exceeds this account''s cap%' THEN
        RAISE EXCEPTION 'S809 2g probe: the over-cap discount was refused with: %', v_msg;
      END IF;
    END;
    SELECT status INTO v_st FROM public.pos_orders WHERE id = v_o_disc;
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o_disc AND payment_method = 'Loyalty';
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_st IS DISTINCT FROM 'open' OR v_n <> 1 OR v_bal <> 550 THEN
      RAISE EXCEPTION 'S809 2g probe: after the refused close the bill is %, with % Loyalty line(s) and a balance of % (want open, 1, 550)', v_st, v_n, v_bal;
    END IF;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id = v_o_disc;
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_bal <> 560 THEN
      RAISE EXCEPTION 'S809 2g probe: the Cash charge after the refusal left a balance of % (want 560)', v_bal;
    END IF;

    -- ── (h) A Void by the Owner (no Allow Void needed) of a bill the supervisor redeemed on ──────
    PERFORM public.redeem_loyalty_points(v_o_void, 20);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 2g probe: % is not an Owner login', v_owner;
    END IF;
    UPDATE public.pos_orders SET status = 'voided', close_type = 'void', close_reason = 'probe'
     WHERE id = v_o_void RETURNING status INTO v_st;
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o_void;
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_st IS DISTINCT FROM 'voided' OR v_n <> 0 OR v_bal <> 560 THEN
      RAISE EXCEPTION 'S809 2g probe: the Owner''s Void is %, with % line(s) and a balance of % (want voided, 0, 560)', v_st, v_n, v_bal;
    END IF;

    -- ── (i) CUSTOMERS-PARKING-3: the point value cannot be 0 or less; NULL reads as NPR 1 ────────
    BEGIN
      UPDATE public.settings SET pos_loyalty_point_value = 0 WHERE client_id = v_c;
      RAISE EXCEPTION 'S809 2g probe: a point value of 0 was accepted';
    EXCEPTION WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_msg = CONSTRAINT_NAME;
      IF v_msg IS DISTINCT FROM 'settings_pos_loyalty_point_value_positive' THEN
        RAISE EXCEPTION 'S809 2g probe: a point value of 0 was refused by %', v_msg;
      END IF;
    END;
    BEGIN
      UPDATE public.settings SET pos_loyalty_point_value = -5 WHERE client_id = v_c;
      RAISE EXCEPTION 'S809 2g probe: a negative point value was accepted';
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
    UPDATE public.settings SET pos_loyalty_point_value = 5 WHERE client_id = v_c RETURNING pos_loyalty_point_value INTO v_value;
    IF NOT FOUND OR v_value IS DISTINCT FROM 5 THEN
      RAISE EXCEPTION 'S809 2g probe: the Owner could not set the point value to 5';
    END IF;

    -- What the server charges for points is the stored value at that moment: a till still showing
    -- NPR 10 a point is told 150, not 300, and must say so before it charges (PosOrders.jsx).
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    v_amt := public.redeem_loyalty_points(v_o_value, 30);
    IF v_amt IS DISTINCT FROM 150.00 THEN
      RAISE EXCEPTION 'S809 2g probe: 30 points at NPR 5 redeemed for %', v_amt;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.settings SET pos_loyalty_point_value = NULL WHERE client_id = v_c;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    v_amt := public.redeem_loyalty_points(v_o_value, 30);
    IF v_amt IS DISTINCT FROM 30.00 THEN
      RAISE EXCEPTION 'S809 2g probe: 30 points at an unset value redeemed for % (want NPR 1 a point)', v_amt;
    END IF;
    PERFORM public.redeem_loyalty_points(v_o_value, 0);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    UPDATE public.settings SET pos_loyalty_point_value = 10 WHERE client_id = v_c;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);

    -- ── (j) CUSTOMERS-PARKING-1: the partner's phone spends nothing, even holding points; a cancel
    -- still runs; its Credit bill tagged to the partner earns nothing, enrolled or not ─────────────
    BEGIN
      PERFORM public.redeem_loyalty_points(v_o_p1, 10);
      RAISE EXCEPTION 'S809 2g probe: points were redeemed on a delivery partner''s phone';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_points_delivery_partner' THEN
        RAISE EXCEPTION 'S809 2g probe: the partner redemption — expected pos_points_delivery_partner, got: %', v_msg;
      END IF;
    END;
    v_amt := public.redeem_loyalty_points(v_o_p1, 0);
    IF v_amt IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 2g probe: a cancel on the partner''s bill returned %', v_amt;
    END IF;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Credit', paid_amount = 1000, delivery_partner = 'S809 2g Partner'
     WHERE id = v_o_p1;
    v_n := public.award_loyalty_points(v_o_p1);
    IF v_n <> 0 OR EXISTS (SELECT 1 FROM public.pos_loyalty_ledger WHERE order_id = v_o_p1) THEN
      RAISE EXCEPTION 'S809 2g probe: the partner''s own Credit bill earned % points', v_n;
    END IF;
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_dp;
    IF v_bal <> 188 THEN
      RAISE EXCEPTION 'S809 2g probe: the partner''s balance moved to %', v_bal;
    END IF;

    -- (k) The partner's number typed another way, charged Cash with no partner picked, earns nothing.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id = v_o_p2;
    v_n := public.award_loyalty_points(v_o_p2);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 2g probe: the partner''s number, typed another way, earned % points', v_n;
    END IF;

    -- (l) A bill tagged to the partner earns nothing even on a regular's phone.
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Credit', paid_amount = 1000, delivery_partner = 'S809 2g Partner'
     WHERE id = v_o_p3;
    v_n := public.award_loyalty_points(v_o_p3);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 2g probe: a partner-tagged bill earned % points on a regular''s phone', v_n;
    END IF;

    -- (m) A close with nothing redeemed writes no ledger row, and the regular's Credit tab earns as
    -- before (when a tab earns is owner decision Q19, stage 4).
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Credit', paid_amount = 1000
     WHERE id = v_o_plain;
    IF EXISTS (SELECT 1 FROM public.pos_loyalty_ledger WHERE order_id = v_o_plain) THEN
      RAISE EXCEPTION 'S809 2g probe: a close with nothing redeemed wrote a ledger row';
    END IF;
    v_n := public.award_loyalty_points(v_o_plain);
    IF v_n <> 100 THEN
      RAISE EXCEPTION 'S809 2g probe: a regular''s Credit bill earned % points (want 100)', v_n;
    END IF;

    -- ── (n) The operator voids a BLOOM CAFE bill a supervisor redeemed on; the handback runs as the
    -- operator (whose own outlet, if any, is not BLOOM CAFE) ───────────────────────────────────────
    PERFORM public.redeem_loyalty_points(v_o_admin, 10);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 2g probe: % is not the operator', v_admin;
    END IF;
    UPDATE public.pos_orders SET status = 'voided', close_type = 'void', close_reason = 'probe'
     WHERE id = v_o_admin;
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o_admin;
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    -- 500 + 100 (a) − 30 (b) − 10 (c) + 100 (m) = 660
    IF v_n <> 0 OR v_bal <> 660 THEN
      RAISE EXCEPTION 'S809 2g probe: the operator''s Void left % line(s) and a final balance of % (want 0 and 660)', v_n, v_bal;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2g_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_2g_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('award_loyalty_points', 'redeem_loyalty_points', 'guard_pos_order_close', 'pos_phone_is_delivery_partner');
--     expect award 09de0865750b36accc1ae68b4075c5e3, redeem 00f0f2bfb8a7de290795b6737681b925, guard_pos_order_close 2b5f4cd801170bafc620052cf40d2620,
--     pos_phone_is_delivery_partner 5ec55e122949eb4184f0ac0648d325e8; prosecdef t, t, f, f; proacl unchanged on the first
--     three ({postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} twice, then
--     {postgres=X/postgres}) and {postgres=X/postgres} on the helper.
--   SELECT conname, convalidated, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.settings'::regclass AND conname = 'settings_pos_loyalty_point_value_positive';   -- t
--   SELECT has_function_privilege('authenticated', 'public.pos_phone_is_delivery_partner(uuid,text)', 'EXECUTE');  -- f
--   SELECT count(*) FROM public.settings WHERE pos_loyalty_point_value <= 0;   -- 0
