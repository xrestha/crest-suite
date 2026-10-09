-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3k: a regular's points follow the number, however it is typed, and the Owner
-- and POS managers can add or correct a points balance by hand.
--
--   CUSTOMERS-PARKING-4 (P2). award_loyalty_points and redeem_loyalty_points found the customer by the
--   phone exactly as typed on the bill, and the customer book was unique on that text. A regular first
--   billed as "9841234567" and tonight typed "984-1234567", "+977 9841234567" or "09841234567" had no
--   points at the counter, earned nothing, and the bill started a second customer. Now both functions
--   find the customer by the number itself (pos_customers.phone_canonical: digits only, a leading 977
--   dropped from 11 digits or more, then leading zeros), and an outlet's book holds one customer per
--   number (a new unique index). A "phone" of fewer than 7 digits is not treated as a number (as
--   normalizePhone in src/utils/phone.js): it still matches as typed, and the new index leaves it out.
--   pos_customers_client_id_phone_key (UNIQUE (client_id, phone)) is KEPT: a till on crest-v422 or
--   older upserts the customer with onConflict 'client_id,phone', which needs that key to exist.
--
--   CUSTOMERS-PARKING-5 (P2, owner decision Q13 b). Every failed or doubtful award told the cashier to
--   "ask the Owner to add the points", and nothing could: the ledger takes no client write and no
--   screen corrected a balance. New: adjust_loyalty_points(customer, points, reason), for the Owner, a
--   POS manager and the operator (pos_caller_has_rank('manager'), which also refuses a login a Final
--   Settlement has blocked). It writes one 'adjust' row to pos_loyalty_ledger with the reason, stamped
--   with the signed-in login (auth.uid(), never a parameter), and returns the new balance.
--     * A reason is required. 0 points, or more than 10,00,000 (1,000,000) either way, is refused.
--     * A hand correction never takes a balance below zero (pos_points_adjust_below_zero). A minus
--       balance can be neither spent nor explained at the counter, and the only true minus position,
--       points earned on a bill that a credit note cancelled after they were spent, is still written by
--       reverse_loyalty_for_credit_note. A balance already below zero can be brought back up by hand.
--     * A delivery partner's number cannot be GIVEN points (2g's rule: a platform neither earns nor
--       spends). Taking points OFF a partner's number is allowed, so a balance left from before 2g can
--       be cleared to 0.
--     * The row carries no bill (order_id NULL). redeem_loyalty_points hands back every adjust row on
--       a bill when the bill is charged without points, and reverse_loyalty_for_credit_note reverses
--       every row on the bill, so a hand correction tied to a bill would be undone by either.
--   The two refusals inside award_loyalty_points now name where the points are added by hand.
--
--   S809.4 (1i): pos_customers had no audit trail, so enrolment changes left no record. Three AFTER
--   triggers call the shared log_audit() for the loyalty events only: a customer enrolled at creation,
--   a scheme change (or a phone/outlet change, which only the operator can make), and the delete of an
--   enrolled customer. The till's upsert on every bill with a name and phone writes none.
--
--   CUSTOMERS-PARKING-8 and -12 (Customers → Loyalty) are app-only: LoyaltyTab.jsx.
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-09 with 2h live). Section 0
-- refuses to run over any other body. Every change inside them is a block marked "S809 3k".
--   award_loyalty_points(uuid)            09de0865750b36accc1ae68b4075c5e3  (slice 2g's, 20261009230000)
--   redeem_loyalty_points(uuid, integer)  00f0f2bfb8a7de290795b6737681b925  (slice 2g's, 20261009230000)
-- No signature changes: both stay SECURITY DEFINER, search_path public, proacl
-- {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}; CREATE OR REPLACE keeps it.
-- Called, not replaced: pos_caller_has_rank(text) 7d34792c8f392e49bc47274d1e8045ce (slice 3i owns it;
-- its contract, admin, the Owner, or a POS login at the rank that nothing has blocked, is all this file
-- relies on), pos_phone_is_delivery_partner(uuid, text) 5ec55e122949eb4184f0ac0648d325e8,
-- log_audit() ce02b83bbffc3912eb755b3c7a1b3686, pos_customers_guard_loyalty() 2ba9378b781a040433709a354f098c33.
-- New: pos_phone_canonical(text) (INVOKER, no client grant), adjust_loyalty_points(uuid, integer, text)
-- (DEFINER; authenticated and service_role), the partial unique index
-- pos_customers_client_phone_canonical_key, triggers audit_pos_customers_enrolment_ins/_upd/_del.
-- Not touched (owned by other stage-3 slices drafted at the same time): guard_pos_order_close,
-- save_pos_order_items, pos_caller_has_rank.
--
-- Live before this migration (2026-10-09, after the Bloom demo seed):
--   * pos_customers: 63 rows at 2 outlets (BLOOM CAFE 41, BLOOM CAFE - PKR 22), all enrolled; every
--     stored phone is already in its canonical form; 0 rows under 7 digits; 0 numbers held by two rows
--     of one outlet, so the new unique index rejects 0 rows today. Section 1 re-counts at apply time and
--     stops the migration if any exist (which row to keep, and whose name and scheme, is the Owner's
--     call, not a migration's).
--   * pos_orders: 1,060 bills carry a phone, 0 of them typed in a non-canonical form.
--   * pos_loyalty_ledger: 822 rows, 0 of kind 'adjust'.
--
-- Ship order: this migration BEFORE the app. A till on crest-v422 is refused nothing in normal service
-- that it needs: its customer-book upsert of a number already in the book under another spelling is now
-- refused by the new index (it used to start a second customer). That upsert is logged and never shown
-- or waited on, and the bill's points now reach the existing customer.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN logins (one a supervisor, one a manager), its Owner
-- and the operator, inside a block that rolls itself back. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
-- The second hash of each pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.award_loyalty_points(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '09de0865750b36accc1ae68b4075c5e3' AND v_md5 IS DISTINCT FROM '7ccc91ac0e24d854660496b5dcdb7802' THEN
    RAISE EXCEPTION 'S809 3k: award_loyalty_points changed since this slice was drafted (live md5 %) — merge section 4 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.redeem_loyalty_points(uuid,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '00f0f2bfb8a7de290795b6737681b925' AND v_md5 IS DISTINCT FROM '2d16ca903e3e97d12d5852460e25e166' THEN
    RAISE EXCEPTION 'S809 3k: redeem_loyalty_points changed since this slice was drafted (live md5 %) — merge section 5 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. One customer per number, per outlet: count before the index (CUSTOMERS-PARKING-4) ──────
DO $$
DECLARE
  v_groups int;
  v_rows   int;
BEGIN
  SELECT count(*), COALESCE(sum(n), 0) INTO v_groups, v_rows
    FROM (SELECT count(*) AS n
            FROM public.pos_customers
           WHERE length(phone_canonical) >= 7
           GROUP BY client_id, phone_canonical
          HAVING count(*) > 1) d;
  RAISE NOTICE 'S809 3k: % numbers are held by more than one customer row of one outlet (% rows)', v_groups, v_rows;
  IF v_groups > 0 THEN
    RAISE EXCEPTION 'S809 3k: % phone numbers are each held by two or more customer rows of one outlet (% rows in all). Merge each into one row first (move the ledger rows to the row being kept, then delete the others, in one transaction as the operator), deciding with the Owner which name and scheme to keep; then apply again', v_groups, v_rows;
  END IF;
END;
$$;


-- ── 2. The number a phone is, written the way the customer book writes it ───────────────────
-- The same expression as the generated column pos_customers.phone_canonical (the probe checks the two
-- agree on every way it types a number), so a bill's phone and a customer row compare on equal terms.
-- The twin of normalizePhone in src/utils/phone.js, whose callers also count under 7 digits as no
-- number. NULL reads as ''.
-- INVOKER, with no client grant: award_loyalty_points and redeem_loyalty_points (DEFINER) call it.
CREATE OR REPLACE FUNCTION public.pos_phone_canonical(p_phone text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT regexp_replace(
           CASE WHEN d ~ '^977.{8,}' THEN substr(d, 4) ELSE d END,
           '^0+', '')
    FROM (SELECT regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g') AS d) x
$function$;

REVOKE ALL ON FUNCTION public.pos_phone_canonical(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.pos_phone_canonical(text) IS
  'S809 3k: a phone as the number it is: digits only, a leading 977 dropped from 11 digits or more, then leading zeros (the pos_customers.phone_canonical expression). Fewer than 7 digits is not a number to match on. Called by award_loyalty_points and redeem_loyalty_points; twin of normalizePhone (src/utils/phone.js).';


-- ── 3. The unique key on the number ──────────────────────────────────────────────────────────
-- Partial: a "phone" under 7 digits (a code, "N/A") is keyed only by the raw text, as before, so two
-- such entries never collide here. The raw-text key pos_customers_client_id_phone_key stays: tills on
-- crest-v422 or older upsert with onConflict 'client_id,phone', which needs it. Built with the table
-- locked for the moment it takes (63 rows live).
CREATE UNIQUE INDEX IF NOT EXISTS pos_customers_client_phone_canonical_key
  ON public.pos_customers (client_id, phone_canonical)
  WHERE length(phone_canonical) >= 7;

COMMENT ON INDEX public.pos_customers_client_phone_canonical_key IS
  'S809 3k (CUSTOMERS-PARKING-4): one customer per phone number per outlet, however the number was typed. Numbers of 7 digits or more only; the raw-text key pos_customers_client_id_phone_key is kept for older tills'' upserts.';


-- ── 4. award_loyalty_points ───────────────────────────────────────────────────────────────────
-- The live body (2g's) with two S809 3k blocks: the customer is found by the number, and the two
-- refusals name where points are added by hand.
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
  v_canon     text;   -- S809 3k
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
  -- S809 3k (Q13 b): by hand, the Owner or a POS manager adds them in Customers → Loyalty
  -- (adjust_loyalty_points); the two sentences below say so.
  IF NOT COALESCE(public.is_admin() OR public.is_client_owner(), false) THEN
    IF v_order.closed_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Points for a bill are added by the person who closed it, as it closes — the Owner or a POS manager can add them by hand in Customers → Loyalty.'
        USING ERRCODE = '42501', HINT = 'rank_required';
    END IF;
    IF v_order.closed_at IS NULL OR v_order.closed_at < now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'This bill closed too long ago for points to be added from the till — the Owner or a POS manager can add them by hand in Customers → Loyalty.'
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

  -- ── S809 3k (CUSTOMERS-PARKING-4): the customer is the number, however it was typed ────────
  -- "+977 984-1234567" on tonight's bill is the regular stored as "9841234567". Under 7 digits there
  -- is no number to go by, so the text must match as typed (as before). The partial unique index
  -- pos_customers_client_phone_canonical_key holds at most one row per number, and the length test on
  -- the row lets the planner use it.
  v_canon := public.pos_phone_canonical(v_order.buyer_phone);
  IF length(v_canon) >= 7 THEN
    SELECT c.id, c.loyalty_scheme_id INTO v_customer, v_scheme_id
      FROM pos_customers c
     WHERE c.client_id = v_order.client_id
       AND length(c.phone_canonical) >= 7 AND c.phone_canonical = v_canon;
  ELSE
    SELECT c.id, c.loyalty_scheme_id INTO v_customer, v_scheme_id
      FROM pos_customers c
     WHERE c.client_id = v_order.client_id AND c.phone = v_order.buyer_phone;
  END IF;
  -- ── end S809 3k ──────────────────────────────────────────────────────────────────────────
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
-- The live body (2g's) with one S809 3k block: the customer whose balance is spent is found by the
-- number, the same way award_loyalty_points finds the one who earns.
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
  v_canon    text;   -- S809 3k
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
  -- ── S809 3k (CUSTOMERS-PARKING-4): found by the number, as award_loyalty_points finds it ────
  v_canon := public.pos_phone_canonical(v_order.buyer_phone);
  IF length(v_canon) >= 7 THEN
    SELECT c.id INTO v_customer FROM pos_customers c
     WHERE c.client_id = v_order.client_id
       AND length(c.phone_canonical) >= 7 AND c.phone_canonical = v_canon
     FOR UPDATE;
  ELSE
    SELECT c.id INTO v_customer FROM pos_customers c
     WHERE c.client_id = v_order.client_id AND c.phone = v_order.buyer_phone
     FOR UPDATE;
  END IF;
  -- ── end S809 3k ──────────────────────────────────────────────────────────────────────────
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


-- ── 6. adjust_loyalty_points (CUSTOMERS-PARKING-5, owner decision Q13 b) ──────────────────────
-- A points balance added to or corrected by hand, from Customers → Loyalty → Adjust points. The
-- ledger takes no client write (admin-only INSERT for the restore), so this DEFINER function is the
-- only way a client session adds an 'adjust' row of its own; it re-checks everything RLS would have.
CREATE OR REPLACE FUNCTION public.adjust_loyalty_points(p_customer_id uuid, p_points integer, p_note text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := (SELECT auth.uid());
  v_customer record;
  v_note     text := btrim(COALESCE(p_note, ''));
  v_balance  bigint;
BEGIN
  SELECT c.id, c.client_id, c.phone INTO v_customer
    FROM pos_customers c WHERE c.id = p_customer_id;
  IF v_customer.id IS NULL THEN
    RAISE EXCEPTION 'pos_points_adjust_no_customer: that customer is not in the customer book any more, so no points were changed'
      USING ERRCODE = 'P0001', HINT = 'pos_points_adjust_no_customer';
  END IF;

  -- The outlet first, then the rank. Both COALESCE'd: is_admin() is NULL for a session with no profile.
  IF NOT COALESCE(public.is_admin() OR v_customer.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'Not permitted.' USING ERRCODE = '42501';
  END IF;
  -- Q13 (b): the Owner and POS managers (and the operator). pos_caller_has_rank refuses a staff login a
  -- Final Settlement has blocked, and any IMS, HR or Self-Service login, as every POS rank check does.
  IF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'pos_points_adjust_rank: only the Owner or a POS manager can add or take off loyalty points by hand, so no points were changed'
      USING ERRCODE = '42501', HINT = 'pos_points_adjust_rank';
  END IF;

  IF p_points IS NULL OR p_points = 0 THEN
    RAISE EXCEPTION 'pos_points_adjust_amount: enter how many points to add or take off, so no points were changed'
      USING ERRCODE = 'P0001', HINT = 'pos_points_adjust_amount';
  END IF;
  -- Not a business limit: a typo guard (an extra zero or two) well above any real balance.
  IF abs(p_points::bigint) > 1000000 THEN
    RAISE EXCEPTION 'pos_points_adjust_amount: a hand correction changes at most 10,00,000 points at a time, so no points were changed — check the number'
      USING ERRCODE = 'P0001', HINT = 'pos_points_adjust_amount';
  END IF;
  IF v_note = '' OR length(v_note) > 300 THEN
    RAISE EXCEPTION 'pos_points_adjust_reason: say in a few words (300 characters at most) why the points are being changed — the reason is kept with the correction — so no points were changed'
      USING ERRCODE = 'P0001', HINT = 'pos_points_adjust_reason';
  END IF;

  -- 2g: a delivery platform neither earns nor spends points. Points cannot be given to its number;
  -- taking them off is allowed, so a balance left from before 2g can be cleared.
  IF p_points > 0 AND public.pos_phone_is_delivery_partner(v_customer.client_id, v_customer.phone) THEN
    RAISE EXCEPTION 'pos_points_adjust_partner: this is a delivery partner''s number, and a delivery partner does not earn or spend loyalty points, so no points were added'
      USING ERRCODE = 'P0001', HINT = 'pos_points_adjust_partner';
  END IF;

  -- The customer row is locked before the balance is read, as redeem_loyalty_points does, so a till
  -- spending this balance at the same moment waits for the correction (or the correction for it).
  PERFORM 1 FROM pos_customers c WHERE c.id = p_customer_id FOR UPDATE;
  SELECT COALESCE(SUM(l.points), 0) INTO v_balance
    FROM pos_loyalty_ledger l WHERE l.customer_id = p_customer_id;

  -- Never below zero by hand. A balance already below zero (a credit note took back points that had
  -- been spent) may still be brought up.
  IF p_points < 0 AND v_balance + p_points < 0 THEN
    RAISE EXCEPTION 'pos_points_adjust_below_zero: this customer holds % points, so at most % can be taken off, and no points were changed', v_balance, GREATEST(v_balance, 0)
      USING ERRCODE = 'P0001', HINT = 'pos_points_adjust_below_zero';
  END IF;

  -- No bill: redeem_loyalty_points hands back, and reverse_loyalty_for_credit_note reverses, every
  -- adjust row carrying the bill's id, which would undo a hand correction tied to one.
  INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, note, created_by)
  VALUES (v_customer.client_id, p_customer_id, NULL, 'adjust', p_points, 'By hand: ' || v_note, v_caller);

  RETURN (v_balance + p_points)::integer;
END;
$function$;

REVOKE ALL ON FUNCTION public.adjust_loyalty_points(uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.adjust_loyalty_points(uuid, integer, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.adjust_loyalty_points(uuid, integer, text) IS
  'S809 3k (CUSTOMERS-PARKING-5, Q13 b): add (+) or take off (-) a customer''s loyalty points by hand, with a reason. The Owner, a POS manager or the operator. Writes one adjust row to pos_loyalty_ledger (no bill, created_by = the signed-in login); never takes a balance below zero; never gives points to a delivery partner''s number. Returns the new balance.';


-- ── 7. Who enrolled whom: the customer book's loyalty events in the Audit Log (S809.4) ────────
-- log_audit() is the shared AFTER trigger (full row snapshots, the signed-in login). WHEN clauses keep
-- the till's upsert out: it never sends a scheme, and re-sends the phone and outlet it matched on.
DROP TRIGGER IF EXISTS audit_pos_customers_enrolment_ins ON public.pos_customers;
CREATE TRIGGER audit_pos_customers_enrolment_ins
  AFTER INSERT ON public.pos_customers
  FOR EACH ROW WHEN (NEW.loyalty_scheme_id IS NOT NULL)
  EXECUTE FUNCTION public.log_audit();

DROP TRIGGER IF EXISTS audit_pos_customers_enrolment_upd ON public.pos_customers;
CREATE TRIGGER audit_pos_customers_enrolment_upd
  AFTER UPDATE ON public.pos_customers
  FOR EACH ROW WHEN (OLD.loyalty_scheme_id IS DISTINCT FROM NEW.loyalty_scheme_id
                     OR OLD.phone IS DISTINCT FROM NEW.phone
                     OR OLD.client_id IS DISTINCT FROM NEW.client_id)
  EXECUTE FUNCTION public.log_audit();

DROP TRIGGER IF EXISTS audit_pos_customers_enrolment_del ON public.pos_customers;
CREATE TRIGGER audit_pos_customers_enrolment_del
  AFTER DELETE ON public.pos_customers
  FOR EACH ROW WHEN (OLD.loyalty_scheme_id IS NOT NULL)
  EXECUTE FUNCTION public.log_audit();


-- ── 8. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  -- Phones no real guest has: asserted absent from the outlet's customer book before the setup.
  c_r      CONSTANT text := '9800000301';         -- a regular, enrolled, 500 points
  c_r_plus CONSTANT text := '+977 980-000-0301';  -- the same number typed with the country code
  c_r_zero CONSTANT text := '09800000301';        -- ... and with a leading 0
  c_r_sp   CONSTANT text := '980 000 0301';       -- ... and with spaces
  c_dp     CONSTANT text := '9800000309';         -- the probe's delivery partner, as POS Setup stores it
  c_s      CONSTANT text := '12345';              -- a "phone" too short to be a number
  c_s_dash CONSTANT text := '1-2345';
  c_x      CONSTANT text := '9800000302';         -- a customer of the other outlet
  v_c        uuid;    -- BLOOM CAFE
  v_c2       uuid;    -- BLOOM CAFE - PKR
  v_sup      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_mgr      uuid;    -- another, made a plain POS manager
  v_owner    uuid;
  v_admin    uuid;
  v_s        uuid;    -- the probe's open shift
  v_scheme   uuid;
  v_r        uuid;    -- the regular
  v_dp       uuid;    -- the partner's customer row, holding points as a backup from before 2g could
  v_short    uuid;    -- the short "phone", enrolled
  v_x        uuid;    -- the other outlet's customer
  v_r1       uuid := gen_random_uuid();   -- pos_order_items.recipe_id has no FK
  v_o_plus   uuid;  v_o_zero  uuid;  v_o_short uuid;  v_o_dash  uuid;
  v_amt      numeric;
  v_n        int;
  v_bal      int;
  v_audit    int;
  v_hint     text;
  v_msg      text;
  v_note     text;
  v_by       uuid;
  v_kind     text;
  v_ord      uuid;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  -- The new key: unique, partial, leading on client_id then phone_canonical; the raw key kept.
  SELECT count(*) INTO v_n
    FROM pg_index i
   WHERE i.indexrelid = 'public.pos_customers_client_phone_canonical_key'::regclass
     AND i.indrelid = 'public.pos_customers'::regclass
     AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL AND i.indnatts = 2
     AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.pos_customers'::regclass AND attname = 'client_id')
     AND i.indkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.pos_customers'::regclass AND attname = 'phone_canonical');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3k: the unique key on (client_id, phone_canonical) is missing or not as built';
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_customers'::regclass AND conname = 'pos_customers_client_id_phone_key' AND contype = 'u';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3k: pos_customers_client_id_phone_key is gone — tills on crest-v422 or older upsert against it';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE (oid IN ('public.award_loyalty_points(uuid)'::regprocedure, 'public.redeem_loyalty_points(uuid,integer)'::regprocedure,
                  'public.adjust_loyalty_points(uuid,integer,text)'::regprocedure) AND prosecdef)
      OR (oid = 'public.pos_phone_canonical(text)'::regprocedure AND NOT prosecdef AND provolatile = 'i');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S809 3k: a function changed its SECURITY mode or volatility (% of 4 as expected)', v_n;
  END IF;
  IF has_function_privilege('anon', 'public.adjust_loyalty_points(uuid,integer,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.adjust_loyalty_points(uuid,integer,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.adjust_loyalty_points(uuid,integer,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.award_loyalty_points(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.redeem_loyalty_points(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.award_loyalty_points(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.redeem_loyalty_points(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_phone_canonical(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_phone_canonical(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 3k: EXECUTE grants on the loyalty functions are not as expected';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O' AND tgrelid = 'public.pos_customers'::regclass
     AND tgfoid = 'public.log_audit()'::regprocedure AND tgqual IS NOT NULL
     AND tgname IN ('audit_pos_customers_enrolment_ins', 'audit_pos_customers_enrolment_upd', 'audit_pos_customers_enrolment_del');
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 3k: % of the 3 customer-book audit triggers are in place', v_n;
  END IF;

  -- ── The logins: two POS PIN logins of BLOOM CAFE (stand-ins for a supervisor and a manager), its
  -- Owner, the operator ─────────────────────────────────────────────────────────────────────────
  SELECT id INTO v_c  FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_c2 FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_sup
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_mgr
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
     AND p.id IS DISTINCT FROM v_sup
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id
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
  IF v_c IS NULL OR v_c2 IS NULL OR v_sup IS NULL OR v_mgr IS NULL OR v_owner IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 3k probe: needs BLOOM CAFE, BLOOM CAFE - PKR, two POS PIN logins and the Owner of BLOOM CAFE, and the operator (got %, %, %, %, %, %)',
      v_c, v_c2, v_sup, v_mgr, v_owner, v_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_customers
              WHERE (client_id = v_c AND (phone_canonical IN (c_r, c_dp) OR phone IN (c_s, c_s_dash)))
                 OR (client_id = v_c2 AND phone_canonical = c_x)) THEN
    RAISE EXCEPTION 'S809 3k probe: a probe phone number is already in a customer book';
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- The stand-ins lose every other staff marker (a restrictive policy would otherwise turn an
    -- "allowed" into a vacuous 0 rows). BLOOM CAFE values a point at NPR 10 and lists one probe partner.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = 10,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_sup;
    UPDATE public.profiles
       SET pos_role = 'manager', pos_allow_void = true, pos_discount_limit = 10,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_mgr;
    UPDATE public.settings
       SET pos_loyalty_point_value = 10,
           pos_delivery_partners = jsonb_build_array(jsonb_build_object('name', 'S809 3k Partner', 'phone', c_dp, 'commission_pct', 20))
     WHERE client_id = v_c;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3k probe: expected one settings row for BLOOM CAFE, found %', v_n;
    END IF;
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S809 3k probe', 0, '{}') RETURNING id INTO v_s;

    INSERT INTO public.pos_loyalty_schemes (client_id, name, points_per_100)
      VALUES (v_c, 'S809 3k probe', 10) RETURNING id INTO v_scheme;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'Probe regular', c_r, v_scheme) RETURNING id INTO v_r;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'S809 3k Partner', c_dp, v_scheme) RETURNING id INTO v_dp;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'Probe short code', c_s, v_scheme) RETURNING id INTO v_short;
    INSERT INTO public.pos_customers (client_id, name, phone)
      VALUES (v_c2, 'Probe other outlet', c_x) RETURNING id INTO v_x;
    INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, kind, points, note)
      VALUES (v_c, v_r,  'earn', 500, 'S809 3k probe'),
             (v_c, v_dp, 'earn', 188, 'S809 3k probe: a partner balance from an older backup');

    -- The helper is the generated column's twin, on every way the probe types a number.
    IF EXISTS (SELECT 1 FROM public.pos_customers c
                WHERE c.id IN (v_r, v_dp, v_short, v_x)
                  AND c.phone_canonical IS DISTINCT FROM public.pos_phone_canonical(c.phone))
       OR public.pos_phone_canonical(c_r_plus) <> c_r OR public.pos_phone_canonical(c_r_zero) <> c_r
       OR public.pos_phone_canonical(c_r_sp) <> c_r OR public.pos_phone_canonical(NULL) <> ''
       OR public.pos_phone_canonical('97798') <> '97798' THEN
      RAISE EXCEPTION 'S809 3k probe: pos_phone_canonical does not write a number as phone_canonical does';
    END IF;

    -- Takeaway orders. order_no is given, so the probe takes no lock on the outlet's real series.
    -- Every bill carries one NPR 1,000 dish at 0 % VAT.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 3k probe', 990801, 'Probe regular', c_r_plus) RETURNING id INTO v_o_plus;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 3k probe', 990802, 'Probe regular', c_r_zero) RETURNING id INTO v_o_zero;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 3k probe', 990803, 'Probe short code', c_s) RETURNING id INTO v_o_short;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S809 3k probe', 990804, 'Probe short code', c_s_dash) RETURNING id INTO v_o_dash;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      SELECT o, v_c, v_r1, 'S809 3k probe dish', 1, 1000, 0
        FROM unnest(ARRAY[v_o_plus, v_o_zero, v_o_short, v_o_dash]) AS o;

    -- ── As the POS supervisor, through RLS and the INVOKER triggers ──────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 3k probe: the stand-in % is not a plain POS supervisor', v_sup;
    END IF;

    -- ── (a) CUSTOMERS-PARKING-4: a bill typed "+977 980-000-0301" earns for the regular stored as
    -- "9800000301" ─────────────────────────────────────────────────────────────────────────────
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id = v_o_plus;
    v_n := public.award_loyalty_points(v_o_plus);
    SELECT customer_id INTO v_ord FROM public.pos_loyalty_ledger WHERE order_id = v_o_plus AND kind = 'earn';
    IF v_n <> 100 OR v_ord IS DISTINCT FROM v_r THEN
      RAISE EXCEPTION 'S809 3k probe: a bill typed with +977 earned % points for % (want 100 for the regular)', v_n, v_ord;
    END IF;
    -- balance 600

    -- (b) ... and a bill typed "09800000301" spends the same balance.
    v_amt := public.redeem_loyalty_points(v_o_zero, 30);
    SELECT customer_id INTO v_ord FROM public.pos_loyalty_ledger WHERE order_id = v_o_zero AND kind = 'redeem';
    IF v_amt IS DISTINCT FROM 300.00 OR v_ord IS DISTINCT FROM v_r THEN
      RAISE EXCEPTION 'S809 3k probe: 30 points on a bill typed with a leading 0 redeemed for % from % (want 300 from the regular)', v_amt, v_ord;
    END IF;
    -- balance 570 (the redemption stands on the open bill)

    -- (c) Under 7 digits there is no number: "12345" earns for "12345", and "1-2345" for nobody.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id IN (v_o_short, v_o_dash);
    v_n := public.award_loyalty_points(v_o_short);
    IF v_n <> 100 THEN
      RAISE EXCEPTION 'S809 3k probe: the short code typed as stored earned % points (want 100)', v_n;
    END IF;
    v_n := public.award_loyalty_points(v_o_dash);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3k probe: a short code typed another way earned % points (want 0)', v_n;
    END IF;

    -- (d) The book holds one row per number. A till on crest-v422 typing the regular another way is
    -- refused by the new key (it used to start a second customer); the same spelling still upserts.
    -- Neither writes an Audit Log row. (Only the operator reads the Audit Log, so the probe counts as
    -- the operator, then carries on as the supervisor.)
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_audit FROM public.audit_logs WHERE table_name = 'pos_customers' AND record_id = v_r;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    BEGIN
      INSERT INTO public.pos_customers (client_id, name, phone, updated_at)
        VALUES (v_c, 'Probe regular, typed again', c_r_plus, now())
        ON CONFLICT (client_id, phone) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
      RAISE EXCEPTION 'S809 3k probe: a second customer row was accepted for a number already in the book';
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_msg = CONSTRAINT_NAME;
      IF v_msg IS DISTINCT FROM 'pos_customers_client_phone_canonical_key' THEN
        RAISE EXCEPTION 'S809 3k probe: the second spelling was refused by % (want pos_customers_client_phone_canonical_key)', v_msg;
      END IF;
    END;
    INSERT INTO public.pos_customers (client_id, name, phone, updated_at)
      VALUES (v_c, 'Probe regular, renamed', c_r, now())
      ON CONFLICT (client_id, phone) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at;
    SELECT count(*) INTO v_n FROM public.pos_customers WHERE client_id = v_c AND phone_canonical = c_r;
    IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM public.pos_customers WHERE id = v_r AND name = 'Probe regular, renamed') THEN
      RAISE EXCEPTION 'S809 3k probe: the till''s upsert of the stored spelling did not update the one customer row';
    END IF;
    -- A second short code typed another way is a separate entry: the new key leaves it out.
    INSERT INTO public.pos_customers (client_id, name, phone) VALUES (v_c, 'Probe short code, dashed', c_s_dash);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_n FROM public.audit_logs WHERE table_name = 'pos_customers' AND record_id = v_r;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    IF v_n <> v_audit THEN
      RAISE EXCEPTION 'S809 3k probe: the till''s customer upsert wrote % Audit Log row(s)', v_n - v_audit;
    END IF;

    -- (e) CUSTOMERS-PARKING-5: a supervisor cannot adjust points.
    BEGIN
      PERFORM public.adjust_loyalty_points(v_r, 50, 'probe');
      RAISE EXCEPTION 'S809 3k probe: a POS supervisor adjusted points';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_points_adjust_rank' THEN
        RAISE EXCEPTION 'S809 3k probe: the supervisor''s adjust was refused with hint %', v_hint;
      END IF;
    END;

    -- ── As the POS manager ─────────────────────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 3k probe: the stand-in % is not a plain POS manager', v_mgr;
    END IF;

    -- (f) +50 with a reason: one adjust row, no bill, stamped with the manager, the new balance back.
    v_n := public.adjust_loyalty_points(v_r, 50, '  Points from bill 1234 that did not reach the till  ');
    SELECT kind, order_id, created_by, note INTO v_kind, v_ord, v_by, v_note
      FROM public.pos_loyalty_ledger WHERE customer_id = v_r AND points = 50;
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_n <> 620 OR v_bal <> 620 OR v_kind IS DISTINCT FROM 'adjust' OR v_ord IS NOT NULL OR v_by IS DISTINCT FROM v_mgr
       OR v_note IS DISTINCT FROM 'By hand: Points from bill 1234 that did not reach the till' THEN
      RAISE EXCEPTION 'S809 3k probe: +50 by hand returned % (balance %), a % row on bill % by % reading "%"', v_n, v_bal, v_kind, v_ord, v_by, v_note;
    END IF;

    -- (g) Each refusal, and nothing written by any of them.
    FOR v_hint, v_n, v_note IN
      SELECT * FROM (VALUES ('pos_points_adjust_amount', 0, 'probe'),
                            ('pos_points_adjust_amount', 1000001, 'probe'),
                            ('pos_points_adjust_amount', -1000001, 'probe'),
                            ('pos_points_adjust_reason', 10, '   '),
                            ('pos_points_adjust_reason', 10, NULL),
                            ('pos_points_adjust_reason', 10, repeat('x', 301)),
                            ('pos_points_adjust_below_zero', -621, 'probe')) t(h, p, r)
    LOOP
      BEGIN
        PERFORM public.adjust_loyalty_points(v_r, v_n, v_note);
        RAISE EXCEPTION 'S809 3k probe: an adjust of % points was accepted (want %)', v_n, v_hint;
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_msg = PG_EXCEPTION_HINT;
        IF v_msg IS DISTINCT FROM v_hint THEN
          RAISE EXCEPTION 'S809 3k probe: an adjust of % points was refused with % (want %)', v_n, v_msg, v_hint;
        END IF;
      END;
    END LOOP;
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_bal <> 620 THEN
      RAISE EXCEPTION 'S809 3k probe: refused adjustments moved the balance to %', v_bal;
    END IF;

    -- (h) Down to exactly 0 is allowed (the redemption on the open bill is already counted).
    v_n := public.adjust_loyalty_points(v_r, -620, 'Moved to the guest''s new number');
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3k probe: taking the whole balance off left %', v_n;
    END IF;

    -- (i) A delivery partner's number: nothing added; its old balance can be cleared, not overdrawn.
    BEGIN
      PERFORM public.adjust_loyalty_points(v_dp, 10, 'probe');
      RAISE EXCEPTION 'S809 3k probe: points were added to a delivery partner''s number';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_points_adjust_partner' THEN
        RAISE EXCEPTION 'S809 3k probe: adding points to the partner was refused with %', v_hint;
      END IF;
    END;
    v_n := public.adjust_loyalty_points(v_dp, -188, 'Delivery partner: points from before S809 cleared');
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3k probe: clearing the partner''s balance left %', v_n;
    END IF;
    BEGIN
      PERFORM public.adjust_loyalty_points(v_dp, -1, 'probe');
      RAISE EXCEPTION 'S809 3k probe: a partner''s balance was taken below zero';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_points_adjust_below_zero' THEN
        RAISE EXCEPTION 'S809 3k probe: overdrawing the partner was refused with %', v_hint;
      END IF;
    END;

    -- (j) Another outlet's customer, and a customer that does not exist.
    BEGIN
      PERFORM public.adjust_loyalty_points(v_x, 10, 'probe');
      RAISE EXCEPTION 'S809 3k probe: a BLOOM CAFE manager adjusted another outlet''s customer';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    BEGIN
      PERFORM public.adjust_loyalty_points(gen_random_uuid(), 10, 'probe');
      RAISE EXCEPTION 'S809 3k probe: an adjust of a customer that does not exist was accepted';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_points_adjust_no_customer' THEN
        RAISE EXCEPTION 'S809 3k probe: a missing customer was refused with %', v_hint;
      END IF;
    END;

    -- (k) The ledger still takes no client write of its own: the function is the way in.
    BEGIN
      INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, kind, points, note)
        VALUES (v_c, v_r, 'adjust', 1000, 'probe');
      RAISE EXCEPTION 'S809 3k probe: a POS manager wrote a ledger row directly';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;

    -- (l) S809.4: an enrolment change by the manager is in the Audit Log, under the manager.
    UPDATE public.pos_customers SET loyalty_scheme_id = NULL WHERE id = v_r;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    SELECT count(*) INTO v_n FROM public.audit_logs
     WHERE table_name = 'pos_customers' AND record_id = v_r AND action = 'UPDATE' AND user_id = v_mgr
       AND old_data ->> 'loyalty_scheme_id' = v_scheme::text AND new_data ->> 'loyalty_scheme_id' IS NULL;
    IF v_n <> 1 OR (SELECT count(*) FROM public.audit_logs WHERE table_name = 'pos_customers' AND record_id = v_r) <> v_audit + 1 THEN
      RAISE EXCEPTION 'S809 3k probe: taking the regular off the scheme wrote % matching Audit Log row(s)', v_n;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    UPDATE public.pos_customers SET loyalty_scheme_id = v_scheme WHERE id = v_r;

    -- ── (m) As the Owner, and as the operator ────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 3k probe: % is not an Owner login', v_owner;
    END IF;
    v_n := public.adjust_loyalty_points(v_r, 40, 'Birthday gift');
    IF v_n <> 40 OR NOT EXISTS (SELECT 1 FROM public.pos_loyalty_ledger WHERE customer_id = v_r AND points = 40 AND created_by = v_owner) THEN
      RAISE EXCEPTION 'S809 3k probe: the Owner''s +40 returned % or was not stamped with the Owner', v_n;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 3k probe: % is not the operator', v_admin;
    END IF;
    v_n := public.adjust_loyalty_points(v_r, 5, 'Support: correction asked for by the Owner');
    -- 500 + 100 (a) − 30 (b) + 50 (f) − 620 (h) + 40 + 5 = 45
    IF v_n <> 45 THEN
      RAISE EXCEPTION 'S809 3k probe: the final balance is % (want 45)', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3k_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3k_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('award_loyalty_points', 'redeem_loyalty_points', 'adjust_loyalty_points', 'pos_phone_canonical');
--     expect award 7ccc91ac0e24d854660496b5dcdb7802, redeem 2d16ca903e3e97d12d5852460e25e166, adjust 25db7b05bd987b149a789b7c81d4387a, pos_phone_canonical 8da62ae0b9fec5af061a8fb97bc64919;
--     prosecdef t, t, t, f; proacl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} on the
--     first three and {postgres=X/postgres} on pos_phone_canonical.
--   SELECT indexrelid::regclass, indisunique, indisvalid, pg_get_indexdef(indexrelid) FROM pg_index
--    WHERE indrelid = 'public.pos_customers'::regclass;   -- both keys: (client_id, phone) and the partial (client_id, phone_canonical)
--   SELECT tgname, tgenabled, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.pos_customers'::regclass AND NOT tgisinternal;   -- the guard and the three audit_pos_customers_enrolment_*
--   SELECT has_function_privilege('anon', 'public.adjust_loyalty_points(uuid,integer,text)', 'EXECUTE');   -- f
--   SELECT count(*) FROM (SELECT 1 FROM public.pos_customers WHERE length(phone_canonical) >= 7
--                         GROUP BY client_id, phone_canonical HAVING count(*) > 1) d;   -- 0
