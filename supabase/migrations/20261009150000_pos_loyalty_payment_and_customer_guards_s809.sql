-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1i: the points line on a bill, and the points a customer holds, change only
-- the way the till changes them.
--
--   DATABASE-4 (P2). guard_pos_order_payments_closed refused an UPDATE or DELETE of a payment line
--   only once its bill was closed. The one line an OPEN bill carries is the Loyalty line that
--   redeem_loyalty_points writes, so any login of the outlet, a Staff PIN included, could PATCH it
--   up to the bill's total over REST, close the bill as Split and keep the cash. The till's cash
--   line is then refused as over the bill, the Z-report's Expected Cash leaves it out, and nothing
--   compares the Loyalty tender with the points ledger. Nothing in the app edits or deletes a
--   payment line (src/ only inserts the Split lines after the close), so a client session now may
--   not, on an open bill either (pos_payment_line_locked). redeem_loyalty_points is SECURITY
--   DEFINER, so it still replaces and hands back its own line: its statements run as the owner and
--   pass the current_user seam (the probe proves both). A closed bill keeps its bill_locked
--   refusal. The operator is held to it too: owner decision Q26 (a), 2026-10-08, "outside a
--   restore, the operator meets the same integrity checks; the operator stays exempt from rank
--   rules". The restore only INSERTs payment lines, through the unchanged INSERT branch.
--
--   DATABASE-5 (P2). Any login could DELETE a loyalty customer, and pos_loyalty_ledger's
--   customer_id foreign key was ON DELETE CASCADE, so the delete silently took every earn, redeem
--   and adjust row with it (a cascade runs as the table owner, past the ledger's missing DELETE
--   grant). Two layers now:
--     (1) pos_customers_guard_loyalty also fires BEFORE DELETE. A client session, the operator
--         included (Q26 a), cannot delete a customer who has points history
--         (pos_customer_has_points_history), and deleting an enrolled customer, which takes them out
--         of their scheme, needs the enrolment rank: a POS manager, the Owner or the operator
--         (pos_customer_delete_rank). A customer with neither goes as before.
--     (2) The foreign key becomes NO ACTION. A customer who has ledger rows cannot be deleted by
--         anyone, the operator and the service role included, until those rows are deleted first,
--         so the history never goes by cascade again. NO ACTION rather than RESTRICT because it is
--         checked at the end of the statement: deleting a client, which cascades into both tables
--         in one statement, still works. Danger Zone (deleteClientDataFor and clearModuleData,
--         service role) already deletes pos_loyalty_ledger before pos_customers, and the restore
--         inserts customers before the ledger.
--
--   CUSTOMERS-PARKING-7 (P2). The guard returned at once unless loyalty_scheme_id changed, and
--   redeem_loyalty_points / award_loyalty_points find a customer by the exact phone on the bill.
--   So any login, a Staff PIN included, could PATCH a regular's phone to a friend's number and the
--   whole balance moved with it, with nothing recording it. A client session, the operator
--   included (Q26 a; the restore only INSERTs customers), can no longer change a customer's phone,
--   outlet or id (pos_customer_phone_locked). The till's upsert re-sends the phone and outlet it
--   matched on, so it passes the cheap first test as before. A regular on a new number keeps their
--   points on the old one, which still finds them at the till; moving points between customers is
--   a hand adjustment, owner decision Q13 (stage 3), and is not decided here.
--
-- Every writer, listed before the lock (pos-billing.md, S754):
--   pos_order_payments: PosOrders inserts the Split lines after the close (unchanged);
--     redeem_loyalty_points inserts the Loyalty line and deletes an earlier one (DEFINER);
--     restoreClientData inserts as the operator (unchanged exemption); admin-user-ops deletes
--     orders as the service role (cascade, seam). No UPDATE or DELETE anywhere in src/.
--   pos_customers: the till's upsert on (client_id, phone) before a redemption and after the close
--     (name, phone, updated_at, address, pan, client_id); LoyaltyTab's loyalty_scheme_id update
--     (POS manager, unchanged); the restore's INSERT as the operator; Danger Zone's DELETE as the
--     service role, after the ledger; a scheme delete's SET NULL (cascade, as the table owner).
--     No DELETE and no phone change anywhere in src/.
--   pos_loyalty_ledger: written only by the three loyalty RPCs and the operator's restore; deleted
--     only by Danger Zone and by a client delete's cascade.
--
-- Built on LIVE bodies read 2026-10-09 (md5(prosrc)); section 0 refuses to run if either changed:
--     guard_pos_order_payments_closed()   1e27348520ec1cdbee56ed71f4d88c58
--     pos_customers_guard_loyalty()       1bbdf22ecf9474348335bc23f3fce30b
-- Not replaced, but the probe relies on it: redeem_loyalty_points(uuid, integer)
-- bef3b76d360b895f469c2565f4fc0270. No other stage-1 slice changes any of the three.
--
-- Live before this migration: 4 payment lines, all on billed bills (0 on an open bill); 3
-- customers, all at BLOOM CAFE, all enrolled, 1 with history; 4 ledger rows, 0 without a
-- customer, so the foreign key validates. The triggers judge new writes only; no row is rewritten.
--
-- The probe at the end runs as a POS supervisor PIN login, the outlet's Owner and the operator
-- inside a block that rolls itself back. If any check fails, the whole migration fails and nothing
-- here lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.guard_pos_order_payments_closed()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '1e27348520ec1cdbee56ed71f4d88c58' THEN
    RAISE EXCEPTION 'S809 1i: guard_pos_order_payments_closed changed since this slice was drafted (live md5 %) — merge section 1 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.pos_customers_guard_loyalty()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '1bbdf22ecf9474348335bc23f3fce30b' THEN
    RAISE EXCEPTION 'S809 1i: pos_customers_guard_loyalty changed since this slice was drafted (live md5 %) — merge section 2 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. A payment line is never edited or removed by hand (DATABASE-4) ────────────────────────
--
-- Unchanged: the INSERT branch (the operator's restore included), the closed-bill refusal and its
-- words, and the current_user seam that lets SECURITY DEFINER bodies and the service role through.
-- New, after the closed-bill test: a client session's UPDATE or DELETE that touches any line is
-- refused on an open bill too, the operator's included (Q26 a). EXISTS over old_rows, never
-- "always": a statement that touches no line still fires this trigger (a PATCH matching nothing,
-- the cascade when an empty open order is deleted) and must pass. An open order deleted WITH a
-- Loyalty line was already refused as bill_locked (the cascade fires this trigger as the caller
-- once the order is gone; pos-billing.md S755), and still is. old_rows is only read on the UPDATE
-- and DELETE paths: the INSERT branch returns first, and plpgsql plans a statement when it runs.
CREATE OR REPLACE FUNCTION public.guard_pos_order_payments_closed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
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

  -- S809 1i (DATABASE-4): an open bill's line is the till's too. Only redeem_loyalty_points
  -- writes or removes one, and it passed the seam above.
  IF EXISTS (SELECT 1 FROM old_rows) THEN
    RAISE EXCEPTION 'pos_payment_line_locked: a bill''s payment lines are written by the till itself — the points line when points are redeemed, the rest as the bill closes — so they cannot be changed or removed by hand; to take points off an open bill, press Undo on the points in the payment window'
      USING ERRCODE = '42501', HINT = 'pos_payment_line_locked';
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_pos_order_payments_closed() FROM PUBLIC;


-- ── 2. A customer's phone and points history stay theirs (CUSTOMERS-PARKING-7, DATABASE-5) ─────
--
-- SECURITY INVOKER on purpose, as before: current_user is then the caller's role, so the service
-- role, every SECURITY DEFINER body and a foreign-key cascade (which runs as the table owner) pass.
-- The operator is held to the two integrity rules (phone and history) like everyone else, owner
-- decision Q26 (a): the restore only INSERTs customers and never deletes one. It stays exempt from
-- the rank rule (enrolment), as S754 made it everywhere; pos_caller_has_rank() admits it.
--
-- The history test reads pos_loyalty_ledger through the caller's own RLS. That view is as wide as
-- the caller's view of pos_customers (same client, the same three restrictive policies), and the
-- NO ACTION foreign key in section 3 refuses the delete anyway if the read ever comes up short:
-- this test is there for a refusal the page can word, not as the only lock.
CREATE OR REPLACE FUNCTION public.pos_customers_guard_loyalty()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- S809 1i (DATABASE-5): a delete never takes a customer's points history with it.
  IF TG_OP = 'DELETE' THEN
    IF current_user NOT IN ('anon', 'authenticated') THEN
      RETURN OLD;
    END IF;
    IF EXISTS (SELECT 1 FROM pos_loyalty_ledger l WHERE l.customer_id = OLD.id) THEN
      RAISE EXCEPTION 'pos_customer_has_points_history: this customer has a loyalty points history (every point earned and spent, and which bills spent them), so the customer cannot be deleted — take them off their scheme in Customers → Loyalty instead'
        USING ERRCODE = '42501', HINT = 'pos_customer_has_points_history';
    END IF;
    IF OLD.loyalty_scheme_id IS NOT NULL
       AND NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
      RAISE EXCEPTION 'pos_customer_delete_rank: this customer is enrolled in a loyalty scheme, and only the Owner or a POS manager can take a customer out of one'
        USING ERRCODE = '42501', HINT = 'pos_customer_delete_rank';
    END IF;
    RETURN OLD;
  END IF;

  -- Cheap test first: this fires on every bill closed with a name and phone. The till's upsert
  -- re-sends the phone and outlet it matched on, so its row leaves all four of these unchanged.
  IF (TG_OP = 'INSERT' AND NEW.loyalty_scheme_id IS NULL)
     OR (TG_OP = 'UPDATE'
         AND NEW.loyalty_scheme_id IS NOT DISTINCT FROM OLD.loyalty_scheme_id
         AND NEW.phone             IS NOT DISTINCT FROM OLD.phone
         AND NEW.client_id         IS NOT DISTINCT FROM OLD.client_id
         AND NEW.id                IS NOT DISTINCT FROM OLD.id) THEN
    RETURN NEW;
  END IF;
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- S809 1i (CUSTOMERS-PARKING-7): the balance belongs to the phone, because the loyalty RPCs find
  -- the customer by the phone on the bill. No screen changes a phone, an outlet or an id.
  IF TG_OP = 'UPDATE'
     AND (NEW.phone     IS DISTINCT FROM OLD.phone
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.id        IS DISTINCT FROM OLD.id) THEN
    RAISE EXCEPTION 'pos_customer_phone_locked: a customer''s phone number and outlet are what their loyalty points and bill history belong to, so they cannot be changed — a new number starts a new customer the first time a bill is closed with it, and the points stay with the old number'
      USING ERRCODE = '42501', HINT = 'pos_customer_phone_locked';
  END IF;

  -- Reached only by an enrolment change: an INSERT with a scheme, or an UPDATE of the scheme.
  -- The operator's restore inserts enrolled customers; it passes here as before.
  IF COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'loyalty_enrol_rank: only the Owner or a POS manager can enrol a customer in a loyalty scheme'
      USING ERRCODE = '42501', HINT = 'loyalty_enrol_rank';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.pos_customers_guard_loyalty() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_customers_guard_loyalty ON public.pos_customers;
CREATE TRIGGER pos_customers_guard_loyalty
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_customers
  FOR EACH ROW EXECUTE FUNCTION public.pos_customers_guard_loyalty();


-- ── 3. The points history never goes by cascade (DATABASE-5) ───────────────────────────────
--
-- Same name, same column, so the one relationship PostgREST resolves between the two tables is
-- unchanged. ON DELETE and ON UPDATE NO ACTION (the default): a customer who has ledger rows is
-- not deleted, and its id cannot change under them. What happens to a deleted customer's ledger
-- now: nothing, because the customer is not deleted while it has one. The ledger has to be
-- deleted first, which only the service role can do (the ledger has no DELETE grant or policy for a
-- client session), and Danger Zone does exactly that.
ALTER TABLE public.pos_loyalty_ledger DROP CONSTRAINT IF EXISTS pos_loyalty_ledger_customer_id_fkey;
ALTER TABLE public.pos_loyalty_ledger
  ADD CONSTRAINT pos_loyalty_ledger_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.pos_customers (id);


-- ── 4. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n      int;
  v_att    smallint;
  v_owner  uuid;
  v_sup    uuid;
  v_admin  uuid;
  v_a      uuid;
  v_b      uuid;
  v_c      uuid;
  v_scheme uuid;
  v_r      uuid;   -- a regular with points history
  v_e      uuid;   -- enrolled, no history
  v_e2     uuid;   -- enrolled, no history (the Owner's enrolment change)
  v_p      uuid;   -- not enrolled, no history
  v_rs     uuid;   -- the operator's restored customer
  v_cc     uuid;   -- a customer of the scratch client
  v_o1     uuid;   -- an open bill with a dish on it, for the regular
  v_o2     uuid;   -- an empty open bill
  v_o3     uuid;   -- a closed Split bill
  v_leg    uuid;
  v_leg3   uuid;
  v_value  numeric;
  v_amt    numeric;
  v_txt    text;
  v_hint   text;
  c_r  CONSTANT text := '9800001101';
  c_e  CONSTANT text := '9800001102';
  c_e2 CONSTANT text := '9800001103';
  c_p  CONSTANT text := '9800001104';
  c_n  CONSTANT text := '9800001105';   -- a number not in the book
  c_rs CONSTANT text := '9800001106';
BEGIN
  -- Catalog. Asserted on catalog columns, never on formatted text.
  SELECT attnum INTO v_att FROM pg_attribute
   WHERE attrelid = 'public.pos_loyalty_ledger'::regclass AND attname = 'customer_id';
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_loyalty_ledger'::regclass AND contype = 'f'
     AND confrelid = 'public.pos_customers'::regclass;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1i: % foreign keys from pos_loyalty_ledger to pos_customers (expected exactly 1)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_loyalty_ledger'::regclass AND contype = 'f'
     AND confrelid = 'public.pos_customers'::regclass
     AND conkey = ARRAY[v_att] AND confdeltype = 'a' AND confupdtype = 'a'
     AND NOT condeferrable AND convalidated;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1i: the ledger''s customer key is not a validated, non-deferrable NO ACTION key on customer_id';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_customers'::regclass AND NOT tgisinternal
     AND tgname = 'pos_customers_guard_loyalty' AND tgenabled = 'O'
     AND tgfoid = 'public.pos_customers_guard_loyalty()'::regprocedure
     AND tgtype = 31;   -- ROW | BEFORE | INSERT | DELETE | UPDATE
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1i: pos_customers_guard_loyalty is not a BEFORE ROW INSERT/UPDATE/DELETE trigger';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_order_payments'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgfoid = 'public.guard_pos_order_payments_closed()'::regprocedure;
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 1i: expected the three statement triggers on pos_order_payments, found %', v_n;
  END IF;
  -- Both guards key on current_user, which only works under SECURITY INVOKER.
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.guard_pos_order_payments_closed()'::regprocedure,
                 'public.pos_customers_guard_loyalty()'::regprocedure)
     AND NOT prosecdef;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1i: a guard became SECURITY DEFINER, so its current_user seam would pass everyone';
  END IF;

  -- The callers: a POS outlet with an Owner login and a POS supervisor PIN login working in it,
  -- and the operator.
  SELECT o.id, s.id, c.id INTO v_owner, v_sup, v_a
    FROM public.profiles o
    JOIN public.clients c ON c.id = COALESCE(o.active_client_id, o.client_id) AND c.pos_enabled
    JOIN public.profiles s ON COALESCE(s.active_client_id, s.client_id) = c.id
   WHERE o.role = 'client'
     AND o.pos_email IS NULL AND o.pos_role IS NULL AND o.ims_role IS NULL AND o.hr_role IS NULL
     AND NOT COALESCE(o.hr_self_service, false)
     AND s.role = 'client' AND s.pos_email IS NOT NULL AND s.pos_role = 'supervisor'
     AND s.settlement_blocked_by IS NULL
     AND s.ims_role IS NULL AND s.hr_role IS NULL AND NOT COALESCE(s.hr_self_service, false)
   ORDER BY o.id, s.id
   LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND pos_role IS NULL AND ims_role IS NULL AND hr_role IS NULL
     AND pos_email IS NULL AND NOT COALESCE(hr_self_service, false)
   ORDER BY id LIMIT 1;
  SELECT id INTO v_b FROM public.clients WHERE id <> v_a ORDER BY id LIMIT 1;
  IF v_owner IS NULL OR v_sup IS NULL OR v_admin IS NULL OR v_b IS NULL THEN
    RAISE EXCEPTION 'S809 1i probe: needs a POS outlet with an Owner and a POS supervisor PIN login, the operator and a second client (got %, %, %, %)',
      v_owner, v_sup, v_admin, v_b;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_customers
              WHERE client_id = v_a AND phone IN (c_r, c_e, c_e2, c_p, c_n, c_rs)) THEN
    RAISE EXCEPTION 'S809 1i probe: a probe phone number is already in the customer book';
  END IF;
  SELECT pos_loyalty_point_value INTO v_value FROM public.settings WHERE client_id = v_a;
  v_value := COALESCE(v_value, 1);
  IF v_value * 30 > 11300 THEN
    RAISE EXCEPTION 'S809 1i probe: a point is worth NPR %, too much for the probe bill', v_value;
  END IF;

  BEGIN
    -- Setup, as the migration's own role. A scheme, four customers, the regular's 500 points, an
    -- open bill for the regular with one NPR 10,000 dish on it, an empty open bill, and a closed
    -- Split bill with its cash line.
    INSERT INTO public.pos_loyalty_schemes (client_id, name, points_per_100)
      VALUES (v_a, 'S809 1i probe', 1) RETURNING id INTO v_scheme;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_a, 'Probe regular', c_r, v_scheme) RETURNING id INTO v_r;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_a, 'Probe enrolled', c_e, v_scheme) RETURNING id INTO v_e;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_a, 'Probe enrolled 2', c_e2, v_scheme) RETURNING id INTO v_e2;
    INSERT INTO public.pos_customers (client_id, name, phone)
      VALUES (v_a, 'Probe walk-in', c_p) RETURNING id INTO v_p;
    INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, kind, points, note)
      VALUES (v_a, v_r, 'earn', 500, 'S809 1i probe');
    INSERT INTO public.pos_orders (client_id, buyer_name, buyer_phone)
      VALUES (v_a, 'Probe regular', c_r) RETURNING id INTO v_o1;
    INSERT INTO public.pos_order_items (order_id, client_id, name, qty, unit_price, vat_rate)
      VALUES (v_o1, v_a, 'S809 1i probe dish', 1, 10000, 0.13);
    INSERT INTO public.pos_orders (client_id) VALUES (v_a) RETURNING id INTO v_o2;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, closed_at, closed_by)
      VALUES (v_a, 'billed', 'paid', 'Split', 11300, now(), v_owner) RETURNING id INTO v_o3;
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_o3, v_a, 'Cash', 11300) RETURNING id INTO v_leg3;

    -- ── As the POS supervisor, through RLS and the INVOKER triggers ──
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false)
       OR COALESCE(public.pos_caller_has_rank('manager'), false) THEN
      RAISE EXCEPTION 'S809 1i probe: % does not rank as a POS supervisor', v_sup;
    END IF;

    -- DATABASE-4 (a) redeeming 30 points writes one Loyalty line.
    v_amt := public.redeem_loyalty_points(v_o1, 30);
    IF v_amt IS DISTINCT FROM round(30 * v_value, 2) THEN
      RAISE EXCEPTION 'S809 1i probe: 30 points redeemed for %, expected %', v_amt, round(30 * v_value, 2);
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o1 AND payment_method = 'Loyalty';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1i probe: the redemption left % Loyalty line(s)', v_n;
    END IF;
    SELECT id INTO v_leg FROM public.pos_order_payments WHERE order_id = v_o1 AND payment_method = 'Loyalty';

    -- (b) raising that line to the bill's total is refused: the hole itself.
    BEGIN
      UPDATE public.pos_order_payments SET amount = 11300 WHERE id = v_leg;
      RAISE EXCEPTION 'S809 1i probe: a Supervisor raised the Loyalty line on an open bill';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_payment_line_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the Loyalty line edit was refused with hint %', v_hint;
      END IF;
    END;

    -- (c) deleting it by hand is refused, and it stands as written.
    BEGIN
      DELETE FROM public.pos_order_payments WHERE id = v_leg;
      RAISE EXCEPTION 'S809 1i probe: a Supervisor deleted the Loyalty line on an open bill';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_payment_line_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the Loyalty line delete was refused with hint %', v_hint;
      END IF;
    END;
    SELECT amount INTO v_amt FROM public.pos_order_payments WHERE id = v_leg;
    IF v_amt IS DISTINCT FROM round(30 * v_value, 2) THEN
      RAISE EXCEPTION 'S809 1i probe: after the refusals the Loyalty line reads %', v_amt;
    END IF;

    -- (d) a second redemption still replaces the first through the RPC: its own DELETE passes.
    v_amt := public.redeem_loyalty_points(v_o1, 20);
    SELECT count(*), sum(amount) INTO v_n, v_amt FROM public.pos_order_payments
     WHERE order_id = v_o1 AND payment_method = 'Loyalty';
    IF v_n <> 1 OR v_amt IS DISTINCT FROM round(20 * v_value, 2) THEN
      RAISE EXCEPTION 'S809 1i probe: re-redeeming left % Loyalty line(s) worth %', v_n, v_amt;
    END IF;
    SELECT COALESCE(sum(points), 0) INTO v_n FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_n <> 480 THEN
      RAISE EXCEPTION 'S809 1i probe: after re-redeeming the balance is %, expected 480', v_n;
    END IF;

    -- (e) the till's cancel (cancelLiveRedemption, p_points 0) hands the points back and removes it.
    PERFORM public.redeem_loyalty_points(v_o1, 0);
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o1;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1i probe: the cancel left % payment line(s) on the open bill', v_n;
    END IF;
    SELECT COALESCE(sum(points), 0) INTO v_n FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_n <> 500 THEN
      RAISE EXCEPTION 'S809 1i probe: after the cancel the balance is %, expected 500', v_n;
    END IF;

    -- (f) statements that touch no line pass, and so does deleting an empty open bill (its cascade
    -- into the payment lines removes nothing).
    DELETE FROM public.pos_order_payments WHERE id = gen_random_uuid();
    UPDATE public.pos_order_payments SET amount = amount WHERE false;
    DELETE FROM public.pos_orders WHERE id = v_o2;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1i probe: deleting an empty open bill removed % row(s)', v_n;
    END IF;

    -- (g) a closed bill's line keeps its own refusal.
    BEGIN
      UPDATE public.pos_order_payments SET amount = 1 WHERE id = v_leg3;
      RAISE EXCEPTION 'S809 1i probe: a closed bill''s payment line was changed';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'bill_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the closed-bill line edit was refused with hint %', v_hint;
      END IF;
    END;

    -- CUSTOMERS-PARKING-7 (h) moving the regular to a free number is refused, and the phone stays.
    BEGIN
      UPDATE public.pos_customers SET phone = c_n WHERE id = v_r;
      RAISE EXCEPTION 'S809 1i probe: a Supervisor moved a regular to another phone';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_phone_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the phone change was refused with hint %', v_hint;
      END IF;
    END;
    SELECT phone INTO v_txt FROM public.pos_customers WHERE id = v_r;
    IF v_txt IS DISTINCT FROM c_r THEN
      RAISE EXCEPTION 'S809 1i probe: the regular''s phone now reads %', v_txt;
    END IF;

    -- (i) and to another outlet.
    BEGIN
      UPDATE public.pos_customers SET client_id = v_b WHERE id = v_p;
      RAISE EXCEPTION 'S809 1i probe: a Supervisor moved a customer to another outlet';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_phone_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the outlet change was refused with hint %', v_hint;
      END IF;
    END;

    -- (j) the till's upsert on (client_id, phone), as PostgREST sends it, still updates the name.
    INSERT INTO public.pos_customers (client_id, name, phone, updated_at)
      VALUES (v_a, 'Probe regular renamed', c_r, now())
      ON CONFLICT (client_id, phone) DO UPDATE
        SET client_id = EXCLUDED.client_id, name = EXCLUDED.name,
            phone = EXCLUDED.phone, updated_at = EXCLUDED.updated_at;
    SELECT name INTO v_txt FROM public.pos_customers WHERE id = v_r;
    IF v_txt IS DISTINCT FROM 'Probe regular renamed' THEN
      RAISE EXCEPTION 'S809 1i probe: the till''s upsert left the name as %', v_txt;
    END IF;

    -- (k) enrolment still needs a POS manager (unchanged).
    BEGIN
      UPDATE public.pos_customers SET loyalty_scheme_id = NULL WHERE id = v_e;
      RAISE EXCEPTION 'S809 1i probe: a Supervisor took a customer off a scheme';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'loyalty_enrol_rank' THEN
        RAISE EXCEPTION 'S809 1i probe: the enrolment change was refused with hint %', v_hint;
      END IF;
    END;

    -- DATABASE-5 (l) the regular, who has history, cannot be deleted.
    BEGIN
      DELETE FROM public.pos_customers WHERE id = v_r;
      RAISE EXCEPTION 'S809 1i probe: a Supervisor deleted a customer with points history';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_has_points_history' THEN
        RAISE EXCEPTION 'S809 1i probe: the history delete was refused with hint %', v_hint;
      END IF;
    END;

    -- (m) an enrolled customer with no history needs a POS manager.
    BEGIN
      DELETE FROM public.pos_customers WHERE id = v_e;
      RAISE EXCEPTION 'S809 1i probe: a Supervisor deleted an enrolled customer';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_delete_rank' THEN
        RAISE EXCEPTION 'S809 1i probe: the enrolled delete was refused with hint %', v_hint;
      END IF;
    END;

    -- (n) a walk-in with neither goes as before.
    DELETE FROM public.pos_customers WHERE id = v_p;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1i probe: deleting a plain customer removed % row(s)', v_n;
    END IF;

    -- ── As the Owner ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1i probe: % is not an Owner login', v_owner;
    END IF;

    -- (o) the Owner cannot edit a line by hand either, and the RPC still hands it back.
    PERFORM public.redeem_loyalty_points(v_o1, 10);
    SELECT id INTO v_leg FROM public.pos_order_payments WHERE order_id = v_o1 AND payment_method = 'Loyalty';
    BEGIN
      DELETE FROM public.pos_order_payments WHERE id = v_leg;
      RAISE EXCEPTION 'S809 1i probe: the Owner deleted the Loyalty line on an open bill';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_payment_line_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the Owner''s line delete was refused with hint %', v_hint;
      END IF;
    END;
    PERFORM public.redeem_loyalty_points(v_o1, 0);
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o1;
    SELECT COALESCE(sum(points), 0) INTO v_amt FROM public.pos_loyalty_ledger WHERE customer_id = v_r;
    IF v_n <> 0 OR v_amt <> 500 THEN
      RAISE EXCEPTION 'S809 1i probe: the Owner''s cancel left % line(s) and a balance of %', v_n, v_amt;
    END IF;

    -- (p) the Owner cannot move the regular's phone, nor delete them.
    BEGIN
      UPDATE public.pos_customers SET phone = c_n WHERE id = v_r;
      RAISE EXCEPTION 'S809 1i probe: the Owner moved a regular to another phone';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_phone_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the Owner''s phone change was refused with hint %', v_hint;
      END IF;
    END;
    BEGIN
      DELETE FROM public.pos_customers WHERE id = v_r;
      RAISE EXCEPTION 'S809 1i probe: the Owner deleted a customer with points history';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_has_points_history' THEN
        RAISE EXCEPTION 'S809 1i probe: the Owner''s history delete was refused with hint %', v_hint;
      END IF;
    END;

    -- (q) the Owner's enrolment changes (LoyaltyTab) and deleting an enrolled customer pass.
    UPDATE public.pos_customers SET loyalty_scheme_id = NULL WHERE id = v_e2;
    UPDATE public.pos_customers SET loyalty_scheme_id = v_scheme WHERE id = v_e2;
    SELECT count(*) INTO v_n FROM public.pos_customers WHERE id = v_e2 AND loyalty_scheme_id = v_scheme;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1i probe: the Owner''s enrolment change did not land';
    END IF;
    DELETE FROM public.pos_customers WHERE id = v_e;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1i probe: the Owner deleting an enrolled customer removed % row(s)', v_n;
    END IF;

    -- ── As the operator ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 1i probe: % is not the operator', v_admin;
    END IF;

    -- (r) the restore's inserts land: an enrolled customer, its ledger row, and a closed bill's
    -- Loyalty line (restoreClientData, in RESTORE_ORDER).
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_a, 'Probe restored', c_rs, v_scheme) RETURNING id INTO v_rs;
    INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, kind, points, note)
      VALUES (v_a, v_rs, 'earn', 50, 'S809 1i probe restore');
    INSERT INTO public.pos_order_payments (order_id, client_id, payment_method, amount)
      VALUES (v_o3, v_a, 'Loyalty', round(5 * v_value, 2));

    -- (s) outside a restore the operator meets the same integrity rules (Q26 a): an open bill's
    -- Loyalty line is the RPC's, which the operator may still call.
    PERFORM public.redeem_loyalty_points(v_o1, 10);
    SELECT id INTO v_leg FROM public.pos_order_payments WHERE order_id = v_o1 AND payment_method = 'Loyalty';
    BEGIN
      UPDATE public.pos_order_payments SET amount = 11300 WHERE id = v_leg;
      RAISE EXCEPTION 'S809 1i probe: the operator raised the Loyalty line on an open bill';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_payment_line_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the operator''s line edit was refused with hint %', v_hint;
      END IF;
    END;
    PERFORM public.redeem_loyalty_points(v_o1, 0);
    SELECT count(*) INTO v_n FROM public.pos_order_payments WHERE order_id = v_o1;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1i probe: the operator''s cancel left % line(s)', v_n;
    END IF;

    -- (t) nor move a regular to another phone, nor delete a customer with history.
    BEGIN
      UPDATE public.pos_customers SET phone = c_n WHERE id = v_r;
      RAISE EXCEPTION 'S809 1i probe: the operator moved a regular to another phone';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_phone_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the operator''s phone change was refused with hint %', v_hint;
      END IF;
    END;
    BEGIN
      DELETE FROM public.pos_customers WHERE id = v_r;
      RAISE EXCEPTION 'S809 1i probe: the operator deleted a customer with points history';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_customer_has_points_history' THEN
        RAISE EXCEPTION 'S809 1i probe: the operator''s history delete was refused with hint %', v_hint;
      END IF;
    END;

    -- (t2) but the rank rule does not apply to the operator: an enrolled customer with no history
    -- goes.
    DELETE FROM public.pos_customers WHERE id = v_e2;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1i probe: the operator deleting an enrolled customer removed % row(s)', v_n;
    END IF;

    -- (u) nor edit a closed bill's line (unchanged).
    BEGIN
      UPDATE public.pos_order_payments SET amount = 1 WHERE id = v_leg3;
      RAISE EXCEPTION 'S809 1i probe: the operator changed a closed bill''s payment line';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'bill_locked' THEN
        RAISE EXCEPTION 'S809 1i probe: the operator''s closed-line edit was refused with hint %', v_hint;
      END IF;
    END;

    -- ── Back to the migration's role (the service role's shape: no JWT, past the seams) ──
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    -- (v) the foreign key refuses even here; Danger Zone's order (ledger first) goes through.
    BEGIN
      DELETE FROM public.pos_customers WHERE id = v_rs;
      RAISE EXCEPTION 'S809 1i probe: a customer with history was deleted past the foreign key';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    DELETE FROM public.pos_loyalty_ledger WHERE customer_id = v_rs;
    DELETE FROM public.pos_customers WHERE id = v_rs;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1i probe: ledger-then-customer removed % customer row(s)', v_n;
    END IF;

    -- (w) deleting a client still takes its customers and their history in one statement.
    INSERT INTO public.clients (name) VALUES ('S809 1i probe client') RETURNING id INTO v_c;
    INSERT INTO public.pos_customers (client_id, name, phone)
      VALUES (v_c, 'Probe cascade', c_r) RETURNING id INTO v_cc;
    INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, kind, points)
      VALUES (v_c, v_cc, 'earn', 5);
    DELETE FROM public.clients WHERE id = v_c;
    SELECT (SELECT count(*) FROM public.pos_customers WHERE client_id = v_c)
         + (SELECT count(*) FROM public.pos_loyalty_ledger WHERE client_id = v_c) INTO v_n;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1i probe: deleting a client left % customer/ledger row(s)', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1i_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1i_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT conname, confdeltype, confupdtype, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.pos_loyalty_ledger'::regclass AND confrelid = 'public.pos_customers'::regclass;
--   SELECT tgname, tgtype, tgenabled FROM pg_trigger
--    WHERE tgrelid IN ('public.pos_customers'::regclass, 'public.pos_order_payments'::regclass) AND NOT tgisinternal;
--   SELECT proname, md5(prosrc), prosecdef, proacl FROM pg_proc
--    WHERE proname IN ('guard_pos_order_payments_closed', 'pos_customers_guard_loyalty');
--     expected, from this file: 412a96a5c93a942a5e9aa08f17ddaba8 / 2ba9378b781a040433709a354f098c33,
--     prosecdef false, proacl {postgres=X/postgres}
--   SELECT count(*) FROM pos_customers;   -- 3 at BLOOM CAFE, as before
--   SELECT count(*) FROM pos_loyalty_ledger;   -- 4, as before
