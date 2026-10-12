-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S815, POS stage 4, slice 4g: points from an unpaid tab wait for the money, a bill's missing points
-- are added in one tap, and a regular's points move to their new number in one step.
--
--   CUSTOMERS-PARKING-9 (P3, owner decision Q19 c). A Credit (tab) bill earns its points at the close,
--   as before, but they cannot be spent until the bill is settled. The POS guide promised that points
--   follow payment; a regular could run up a tab on Friday and spend its points on Saturday. "Held"
--   points are the earn rows of bills that are Credit, billed, not settled and carry no credit note
--   (a credit note has already taken its bill's points back). Settling the bill releases them: nothing
--   is written, because held is worked out from the bill each time it is asked.
--     * pos_loyalty_balances(client, customer?) is the one place balance and held are worked out. It
--       is SECURITY INVOKER (the caller's own RLS) and read-only. The till's lookup and Customers →
--       Loyalty read it; until now each summed the raw ledger itself.
--     * redeem_loyalty_points spends only balance − held (hint pos_points_held when the held points
--       are what stands in the way).
--
--   Owner addition (2026-10-09): "add the points this bill earned" in one tap. award_loyalty_points
--   already let the Owner and the operator add a bill's points after the till's 10-minute window. A POS
--   manager may now too (pos_caller_has_rank('manager'), which also refuses a blocked login), from the
--   customer's points history in Customers → Loyalty. It writes an ordinary 'earn' row on the bill, so a
--   Credit Note on that bill takes it back exactly as it takes back an award made at the close.
--     * D13 (owner, 2026-10-12): only a bill closed after the customer joined their scheme. A bill from
--       before they joined earned nothing on purpose and is not a failed award; offered one, a manager
--       would be handing out points for every past visit. New column pos_customers.loyalty_enrolled_at,
--       stamped by the server (trigger pos_customers_stamp_enrolled_at): now() when a customer joins a
--       scheme, kept when they change scheme, cleared when they leave one. A client session cannot set
--       it; the operator's restore brings each customer's own date back. A late award for an older bill
--       is refused (hint pos_points_before_enrolment); the till's own award at the close returns 0, as
--       for any bill that earns nothing.
--     * Customers already enrolled get the date their joining was audited (S809 3k's audit triggers),
--       else the first time they earned points, else the time this migration runs. Live today: 63
--       enrolled, 0 audited joins, so the first earn or today.
--
--   Owner addition (2026-10-09): "Move points" for a regular's new number. New
--   move_loyalty_points(from customer, new phone, reason), Owner, POS manager or operator. One
--   transaction writes the pair: an 'adjust' row taking the points off the old number ("Moved to
--   98…: reason") and one putting them on the new number ("Moved from 98…: reason"), no bill on
--   either (a bill's adjust rows are handed back or reversed with it), created_by the signed-in login.
--     * D11: only the points that can be spent move. Points held on an unpaid Credit bill stay on the
--       old number until that bill is settled (a credit note on it takes them back from there); the
--       answer says how many stayed. With nothing spendable it refuses (pos_points_move_held or
--       pos_points_move_nothing).
--     * D12: the new number joins the old number's scheme if it is in none, and the old number leaves
--       its scheme (the regular no longer uses it).
--     * D14: a new number not yet in the customer book is added, with the old row's name, PAN and
--       address.
--     * Refused: a number under 7 digits, the customer's own number, a delivery partner's number on
--       either side (2g: a partner neither earns nor spends), another outlet's customer.
--
--   CUSTOMERS-PARKING-10 and -11, the full points history and the "+977" search are app-only.
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-12): both are byte-identical
-- to slice 3k's file 20261010110000. Section 0 refuses to run over any other body. Every change inside
-- them is a block marked "S815 4g".
--   award_loyalty_points(uuid)            7ccc91ac0e24d854660496b5dcdb7802
--   redeem_loyalty_points(uuid, integer)  2d16ca903e3e97d12d5852460e25e166
-- No signature changes: both stay SECURITY DEFINER, search_path public, proacl
-- {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}; CREATE OR REPLACE keeps it.
-- Called, not replaced: pos_caller_has_rank(text) 100bd1bd1e2a1a1c3a6f4cb105a8e887,
-- pos_phone_canonical(text) 8da62ae0b9fec5af061a8fb97bc64919, pos_phone_is_delivery_partner(uuid, text)
-- 5ec55e122949eb4184f0ac0648d325e8, pos_customers_guard_loyalty() 2ba9378b781a040433709a354f098c33
-- (BEFORE trigger; it fires before the new stamp trigger, alphabetically, so a refused enrolment never
-- reaches the stamp), log_audit() ce02b83bbffc3912eb755b3c7a1b3686.
-- New: column pos_customers.loyalty_enrolled_at; pos_customers_stamp_enrolled_at() (INVOKER, trigger, no
-- grant) and its trigger; pos_loyalty_balances(uuid, uuid) (INVOKER, STABLE; authenticated and
-- service_role); move_loyalty_points(uuid, text, text) (DEFINER; authenticated and service_role).
-- Not touched: reverse_loyalty_for_credit_note, adjust_loyalty_points, guard_pos_order_close.
--
-- Live before this migration (2026-10-12): 63 customers at BLOOM CAFE and BLOOM CAFE - PKR, all
-- enrolled; 822 ledger rows; 0 points held (no earn row sits on an unsettled Credit bill); 0 audit
-- rows for pos_customers.
--
-- Ship order: this migration BEFORE the app (the app calls pos_loyalty_balances and
-- move_loyalty_points). A till on crest-v430 or older needs nothing new: it still sums the raw ledger
-- for its screen, and a redemption of held points is refused with a sentence saying so (it shows
-- "Could not redeem the points, so the bill was not charged — …"). The till build floor is unchanged:
-- nothing a till writes changed.
--
-- To undo: DROP FUNCTION move_loyalty_points(uuid, text, text), pos_loyalty_balances(uuid, uuid); DROP
-- TRIGGER pos_customers_stamp_enrolled_at, then its function; ALTER TABLE pos_customers DROP COLUMN
-- loyalty_enrolled_at; re-run sections 4 and 5 of 20261010110000 (the award and redeem bodies).
--
-- The probe at the end runs as BLOOM CAFE's POS PIN logins (one a supervisor, one a manager) and the
-- operator, inside a block that rolls itself back. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
-- The second hash of each pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.award_loyalty_points(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '7ccc91ac0e24d854660496b5dcdb7802' AND v_md5 IS DISTINCT FROM 'c876271778dafdf1cc08696787d93f5b' THEN
    RAISE EXCEPTION 'S815 4g: award_loyalty_points changed since this slice was drafted (live md5 %) — merge section 5 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.redeem_loyalty_points(uuid,integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '2d16ca903e3e97d12d5852460e25e166' AND v_md5 IS DISTINCT FROM '7c5ffd50738fce54c0a98b2d35eba7c0' THEN
    RAISE EXCEPTION 'S815 4g: redeem_loyalty_points changed since this slice was drafted (live md5 %) — merge section 6 onto the live body and update the md5 in section 0', v_md5;
  END IF;
END;
$$;


-- ── 1. When a customer joined their scheme (D13) ─────────────────────────────────────────────
ALTER TABLE public.pos_customers ADD COLUMN IF NOT EXISTS loyalty_enrolled_at timestamptz;

COMMENT ON COLUMN public.pos_customers.loyalty_enrolled_at IS
  'S815 4g: when this customer joined a loyalty scheme (the start of their current membership). Stamped by the server (pos_customers_stamp_enrolled_at): set when they join, kept when they change scheme, NULL when they are in none. award_loyalty_points refuses a late award for a bill closed before it. Rows enrolled before S815 carry the audited join, else their first earned points, else the migration time.';

-- Before the trigger exists, so the dates land as written. On a re-run the trigger lets the
-- migration's own role through (scheme unchanged), and only rows still without a date are touched.
WITH joined AS MATERIALIZED (
  SELECT a.record_id, max(a.created_at) AS at
    FROM public.audit_logs a
   WHERE a.table_name = 'pos_customers'
     AND a.new_data ->> 'loyalty_scheme_id' IS NOT NULL
     AND (a.old_data IS NULL OR a.old_data ->> 'loyalty_scheme_id' IS NULL)
   GROUP BY a.record_id
), first_earn AS MATERIALIZED (
  SELECT l.customer_id, min(l.created_at) AS at
    FROM public.pos_loyalty_ledger l
   WHERE l.kind = 'earn'
   GROUP BY l.customer_id
)
UPDATE public.pos_customers c
   SET loyalty_enrolled_at = COALESCE((SELECT j.at FROM joined j WHERE j.record_id = c.id),
                                      (SELECT f.at FROM first_earn f WHERE f.customer_id = c.id),
                                      now())
 WHERE c.loyalty_scheme_id IS NOT NULL
   AND c.loyalty_enrolled_at IS NULL;


-- ── 2. The stamp ─────────────────────────────────────────────────────────────────────────────
-- INVOKER, so current_user tells a client session from a DEFINER body or the service role, as
-- guard_profiles_privileged_columns() does. A client session never sets the date: joining stamps
-- now(), a scheme change keeps the date, leaving clears it, and a date sent with the row is ignored.
-- Two exceptions: the operator's restore INSERTs each customer with their own date (is_admin()), and
-- the migration's role or the service role may correct a date on a row whose scheme it leaves alone.
-- Fires only when a write names the scheme or the date: the till's customer upsert on every bill
-- sends neither, so it never reaches this function on UPDATE.
CREATE OR REPLACE FUNCTION public.pos_customers_stamp_enrolled_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.loyalty_scheme_id IS NULL THEN
      NEW.loyalty_enrolled_at := NULL;
    ELSIF NEW.loyalty_enrolled_at IS NULL
       OR (current_user IN ('anon', 'authenticated') AND NOT COALESCE(public.is_admin(), false)) THEN
      NEW.loyalty_enrolled_at := now();
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.loyalty_scheme_id IS NULL THEN
    NEW.loyalty_enrolled_at := NULL;
  ELSIF OLD.loyalty_scheme_id IS NULL THEN
    NEW.loyalty_enrolled_at := now();
  ELSIF current_user IN ('anon', 'authenticated')
     OR NEW.loyalty_scheme_id IS DISTINCT FROM OLD.loyalty_scheme_id THEN
    NEW.loyalty_enrolled_at := OLD.loyalty_enrolled_at;
  END IF;
  RETURN NEW;
END;
$function$;

-- A trigger function needs no EXECUTE grant (checked at CREATE TRIGGER, never at fire time).
REVOKE ALL ON FUNCTION public.pos_customers_stamp_enrolled_at() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS pos_customers_stamp_enrolled_at ON public.pos_customers;
CREATE TRIGGER pos_customers_stamp_enrolled_at
  BEFORE INSERT OR UPDATE OF loyalty_scheme_id, loyalty_enrolled_at ON public.pos_customers
  FOR EACH ROW EXECUTE FUNCTION public.pos_customers_stamp_enrolled_at();


-- ── 3. Balance and held points, worked out in one place (CUSTOMERS-PARKING-9, Q19 c) ──────────
-- Held: earn rows whose bill is Credit, billed, not settled and has no credit note. A credit note's
-- reversal already cancels its bill's earn row in the balance, so that bill holds nothing. A bill is
-- Credit as a whole (a Split never has a Credit leg), so this is the whole test.
-- SECURITY INVOKER: the caller's RLS decides which rows it sees, and p_client_id keeps the operator to
-- one outlet (their RLS sees every outlet). Inside redeem_loyalty_points and move_loyalty_points
-- (DEFINER) it runs as the owner and sees every row of the outlet asked for.
-- One row per customer with ledger rows; a customer with none has no row (read it as 0 and 0).
CREATE OR REPLACE FUNCTION public.pos_loyalty_balances(p_client_id uuid, p_customer_id uuid DEFAULT NULL)
 RETURNS TABLE(customer_id uuid, balance integer, held integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT l.customer_id,
         COALESCE(sum(l.points), 0)::integer,
         COALESCE(sum(l.points) FILTER (
           WHERE l.kind = 'earn'
             AND o.status = 'billed'
             AND o.payment_method = 'Credit'
             AND o.credit_settled_at IS NULL
             AND o.credit_note_id IS NULL), 0)::integer
    FROM pos_loyalty_ledger l
    LEFT JOIN pos_orders o ON o.id = l.order_id
   WHERE l.client_id = p_client_id
     AND (p_customer_id IS NULL OR l.customer_id = p_customer_id)
   GROUP BY l.customer_id
$function$;

REVOKE ALL ON FUNCTION public.pos_loyalty_balances(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.pos_loyalty_balances(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.pos_loyalty_balances(uuid, uuid) IS
  'S815 4g (CUSTOMERS-PARKING-9, Q19 c): each customer''s points balance and the part of it held on unpaid Credit bills (earned at the close, spendable once the bill is settled). Spendable = balance − held, never below 0. One outlet; one customer when p_customer_id is given. INVOKER: the caller''s RLS applies.';


-- ── 4. Move points to a regular's new number (owner addition, D11, D12, D14) ───────────────────
CREATE OR REPLACE FUNCTION public.move_loyalty_points(p_from_customer_id uuid, p_to_phone text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller   uuid := (SELECT auth.uid());
  v_from     record;
  v_to       record;
  v_note     text := btrim(COALESCE(p_note, ''));
  v_canon    text := public.pos_phone_canonical(p_to_phone);
  v_to_id    uuid;
  v_scheme   uuid;
  v_balance  integer;
  v_held     integer;
  v_move     integer;
  v_to_bal   integer;
  v_created  boolean := false;
  v_enrolled boolean := false;
BEGIN
  SELECT c.id, c.client_id, c.name, c.phone, c.phone_canonical, c.pan, c.address
    INTO v_from
    FROM pos_customers c WHERE c.id = p_from_customer_id;
  IF v_from.id IS NULL THEN
    RAISE EXCEPTION 'pos_points_move_no_customer: that customer is not in the customer book any more, so no points were moved'
      USING ERRCODE = 'P0001', HINT = 'pos_points_move_no_customer';
  END IF;

  -- The outlet first, then the rank. Both COALESCE'd: is_admin() is NULL for a session with no profile.
  IF NOT COALESCE(public.is_admin() OR v_from.client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'Not permitted.' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    RAISE EXCEPTION 'pos_points_move_rank: only the Owner or a POS manager can move loyalty points to a new number, so no points were moved'
      USING ERRCODE = '42501', HINT = 'pos_points_move_rank';
  END IF;

  IF v_note = '' OR length(v_note) > 300 THEN
    RAISE EXCEPTION 'pos_points_move_reason: say in a few words (300 characters at most) why the points are moving — the reason is kept on both numbers — so no points were moved'
      USING ERRCODE = 'P0001', HINT = 'pos_points_move_reason';
  END IF;
  IF length(v_canon) < 7 THEN
    RAISE EXCEPTION 'pos_points_move_number: type the new phone number in full (7 digits or more), so no points were moved'
      USING ERRCODE = 'P0001', HINT = 'pos_points_move_number';
  END IF;
  IF v_canon = COALESCE(v_from.phone_canonical, '') OR btrim(p_to_phone) = v_from.phone THEN
    RAISE EXCEPTION 'pos_points_move_same: that is this customer''s own number, so no points were moved'
      USING ERRCODE = 'P0001', HINT = 'pos_points_move_same';
  END IF;
  -- 2g: a delivery platform neither earns nor spends, so its points never reach a person's number,
  -- and a person's points never reach a platform's.
  IF public.pos_phone_is_delivery_partner(v_from.client_id, v_from.phone)
     OR public.pos_phone_is_delivery_partner(v_from.client_id, v_canon) THEN
    RAISE EXCEPTION 'pos_points_move_partner: a delivery partner''s number does not earn or spend loyalty points, so points cannot be moved off it or onto it, and no points were moved'
      USING ERRCODE = 'P0001', HINT = 'pos_points_move_partner';
  END IF;

  -- D14: the new number's customer, or a new one with the old row's name, PAN and address. A till
  -- saving the same number at this moment wins the insert; its row is then the one used.
  SELECT c.id INTO v_to_id
    FROM pos_customers c
   WHERE c.client_id = v_from.client_id
     AND length(c.phone_canonical) >= 7 AND c.phone_canonical = v_canon;
  IF v_to_id IS NULL THEN
    INSERT INTO pos_customers (client_id, name, phone, pan, address)
    VALUES (v_from.client_id, v_from.name, v_canon, v_from.pan, v_from.address)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_to_id;
    IF v_to_id IS NULL THEN
      SELECT c.id INTO v_to_id
        FROM pos_customers c
       WHERE c.client_id = v_from.client_id
         AND length(c.phone_canonical) >= 7 AND c.phone_canonical = v_canon;
    ELSE
      v_created := true;
    END IF;
  END IF;
  IF v_to_id IS NULL THEN
    RAISE EXCEPTION 'pos_points_move_number: the new number could not be added to the customer book, so no points were moved — try again'
      USING ERRCODE = 'P0001', HINT = 'pos_points_move_number';
  END IF;

  -- Both rows locked in id order, as redeem_loyalty_points and adjust_loyalty_points lock one: a till
  -- spending either balance waits for the move (or the move for it), and two moves never deadlock.
  PERFORM 1 FROM pos_customers c WHERE c.id IN (v_from.id, v_to_id) ORDER BY c.id FOR UPDATE;
  SELECT c.loyalty_scheme_id INTO v_scheme FROM pos_customers c WHERE c.id = v_from.id;
  SELECT c.id, c.name, c.phone, c.loyalty_scheme_id INTO v_to FROM pos_customers c WHERE c.id = v_to_id;

  -- D11: only what can be spent moves; points held on an unpaid Credit bill stay with that bill.
  SELECT b.balance, b.held INTO v_balance, v_held
    FROM public.pos_loyalty_balances(v_from.client_id, v_from.id) b;
  v_balance := COALESCE(v_balance, 0);
  v_held    := COALESCE(v_held, 0);
  v_move    := GREATEST(v_balance - v_held, 0);
  IF v_move = 0 THEN
    IF v_held > 0 THEN
      RAISE EXCEPTION 'pos_points_move_held: all % of this customer''s points were earned on a Credit bill that is not paid yet, so they can be moved once it is settled — no points were moved', v_held
        USING ERRCODE = 'P0001', HINT = 'pos_points_move_held';
    END IF;
    RAISE EXCEPTION 'pos_points_move_nothing: this customer holds no points to move, so nothing was moved'
      USING ERRCODE = 'P0001', HINT = 'pos_points_move_nothing';
  END IF;

  -- The pair. No bill on either row: redeem_loyalty_points hands back, and
  -- reverse_loyalty_for_credit_note reverses, every adjust row carrying a bill's id.
  INSERT INTO pos_loyalty_ledger (client_id, customer_id, order_id, kind, points, note, created_by) VALUES
    (v_from.client_id, v_from.id, NULL, 'adjust', -v_move, 'Moved to ' || v_to.phone || ': ' || v_note, v_caller),
    (v_from.client_id, v_to.id,   NULL, 'adjust',  v_move, 'Moved from ' || v_from.phone || ': ' || v_note, v_caller);

  -- D12: the new number takes the old number's scheme when it is in none; the old number leaves its
  -- scheme. The stamp trigger dates the join; the audit triggers record both changes.
  IF v_scheme IS NOT NULL THEN
    IF v_to.loyalty_scheme_id IS NULL THEN
      UPDATE pos_customers SET loyalty_scheme_id = v_scheme WHERE id = v_to.id;
      v_enrolled := true;
    END IF;
    UPDATE pos_customers SET loyalty_scheme_id = NULL WHERE id = v_from.id;
  END IF;

  SELECT b.balance INTO v_to_bal FROM public.pos_loyalty_balances(v_from.client_id, v_to.id) b;

  RETURN jsonb_build_object(
    'moved',          v_move,
    'held_left',      v_held,
    'from_balance',   v_balance - v_move,
    'to_customer_id', v_to.id,
    'to_name',        v_to.name,
    'to_phone',       v_to.phone,
    'to_balance',     COALESCE(v_to_bal, 0),
    'created',        v_created,
    'enrolled',       v_enrolled,
    'unenrolled',     v_scheme IS NOT NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.move_loyalty_points(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.move_loyalty_points(uuid, text, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.move_loyalty_points(uuid, text, text) IS
  'S815 4g (owner addition): move a regular''s spendable points to their new number, with a reason. Owner, POS manager or operator. One transaction: an adjust row off the old number and one onto the new (no bill, created_by = the signed-in login); points held on an unpaid Credit bill stay. Adds the new number to the customer book if needed, enrols it in the old number''s scheme if it is in none, and takes the old number off its scheme. Returns {moved, held_left, from_balance, to_customer_id, to_name, to_phone, to_balance, created, enrolled, unenrolled}.';


-- ── 5. award_loyalty_points ──────────────────────────────────────────────────────────────────
-- The live body (3k's) with two S815 4g blocks: a POS manager may add a bill's points after the
-- till's window, and a late award for a bill from before the customer joined is refused.
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
  v_joined    timestamptz;  -- S815 4g
  v_late      boolean;      -- S815 4g
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

  -- Points are earned at the moment of the close, by the person who closed it.
  -- ── S815 4g (owner addition): a bill's points added later, in one tap ─────────────────────
  -- After the till's window, or by anyone but the closer, the Owner, a POS manager or the operator
  -- adds them, from the customer's points history in Customers → Loyalty. pos_caller_has_rank
  -- ('manager') is admin, the Owner, or a POS manager no block has stopped; it was is_admin() or
  -- is_client_owner() alone before. The written row is the same 'earn' row the close writes, so a
  -- Credit Note on the bill takes it back the same way.
  v_late := v_order.closed_by IS DISTINCT FROM v_caller
            OR v_order.closed_at IS NULL OR v_order.closed_at < now() - interval '10 minutes';
  IF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
    IF v_order.closed_by IS DISTINCT FROM v_caller THEN
      RAISE EXCEPTION 'Points for a bill are added by the person who closed it, as it closes — the Owner or a POS manager can add them from the customer''s points history in Customers → Loyalty.'
        USING ERRCODE = '42501', HINT = 'rank_required';
    END IF;
    IF v_order.closed_at IS NULL OR v_order.closed_at < now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'This bill closed too long ago for points to be added from the till — the Owner or a POS manager can add them from the customer''s points history in Customers → Loyalty.'
        USING ERRCODE = '42501', HINT = 'award_window_closed';
    END IF;
  END IF;
  -- ── end S815 4g ──────────────────────────────────────────────────────────────────────────

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
    SELECT c.id, c.loyalty_scheme_id, c.loyalty_enrolled_at INTO v_customer, v_scheme_id, v_joined
      FROM pos_customers c
     WHERE c.client_id = v_order.client_id
       AND length(c.phone_canonical) >= 7 AND c.phone_canonical = v_canon;
  ELSE
    SELECT c.id, c.loyalty_scheme_id, c.loyalty_enrolled_at INTO v_customer, v_scheme_id, v_joined
      FROM pos_customers c
     WHERE c.client_id = v_order.client_id AND c.phone = v_order.buyer_phone;
  END IF;
  -- ── end S809 3k ──────────────────────────────────────────────────────────────────────────
  IF v_customer IS NULL OR v_scheme_id IS NULL THEN RETURN 0; END IF;

  -- ── S815 4g (D13): a bill from before the customer joined earned nothing on purpose ─────────
  -- At the close that is an ordinary 0. Asked for later, it is refused with the reason, because the
  -- one-tap offers only bills since joining and a manager asking for an older one needs to know why.
  IF v_joined IS NOT NULL AND v_order.closed_at < v_joined THEN
    IF v_late THEN
      RAISE EXCEPTION 'pos_points_before_enrolment: this bill closed before the customer joined their points scheme, so it earns no points — none were added'
        USING ERRCODE = 'P0001', HINT = 'pos_points_before_enrolment';
    END IF;
    RETURN 0;
  END IF;
  -- ── end S815 4g ──────────────────────────────────────────────────────────────────────────

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


-- ── 6. redeem_loyalty_points ─────────────────────────────────────────────────────────────────
-- The live body (3k's) with one S815 4g block: only points that are not held on an unpaid Credit bill
-- can be spent.
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
  v_held     integer;  -- S815 4g
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

  -- ── S815 4g (CUSTOMERS-PARKING-9, Q19 c): points from an unpaid tab wait for the money ───────
  -- A Credit bill earns at its close, and those points can be spent once the bill is settled.
  -- pos_loyalty_balances is the one place both figures are worked out (the till reads it too).
  SELECT b.balance, b.held INTO v_balance, v_held
    FROM public.pos_loyalty_balances(v_order.client_id, v_customer) b;
  v_balance := COALESCE(v_balance, 0);
  v_held    := COALESCE(v_held, 0);

  IF p_points > GREATEST(v_balance - v_held, 0) THEN
    IF v_held > 0 AND p_points <= v_balance THEN
      RAISE EXCEPTION 'pos_points_held: % of this customer''s points were earned on a Credit bill that is not paid yet, and they can be spent once it is settled — % can be spent now, so no points were redeemed', LEAST(v_held, v_balance), GREATEST(v_balance - v_held, 0)
        USING ERRCODE = 'P0001', HINT = 'pos_points_held';
    END IF;
    RAISE EXCEPTION 'Only % point(s) available.', GREATEST(v_balance - v_held, 0);
  END IF;
  -- ── end S815 4g ──────────────────────────────────────────────────────────────────────────

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


-- ── 7. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  -- Phones no real guest has: asserted absent from the outlets' customer books before the setup.
  c_r      CONSTANT text := '9800000401';         -- a regular, enrolled, 500 points
  c_m      CONSTANT text := '9800000402';         -- a regular changing numbers
  c_m_plus CONSTANT text := '+977 980-000-0402';  -- ... their own number typed another way
  c_new    CONSTANT text := '9800000403';         -- ... and their new number, not in the book
  c_new_tp CONSTANT text := '+977 980-000-0403';  -- ... typed with the country code
  c_e      CONSTANT text := '9800000404';         -- a customer already in the book, on the second scheme
  c_m2     CONSTANT text := '9800000405';         -- a regular moving onto that customer's number
  c_z      CONSTANT text := '9800000406';         -- enrolled, no points
  c_l      CONSTANT text := '9800000407';         -- joins "tomorrow": every bill today is from before
  c_x      CONSTANT text := '9800000408';         -- a customer of the other outlet
  c_dp     CONSTANT text := '9800000409';         -- the probe's delivery partner, as POS Setup stores it
  c_new2   CONSTANT text := '9800000410';
  c_t      CONSTANT text := '9800000411';         -- the stamp's own rows
  c_u      CONSTANT text := '9800000412';
  v_c        uuid;    -- BLOOM CAFE
  v_c2       uuid;    -- BLOOM CAFE - PKR
  v_sup      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_mgr      uuid;    -- another, made a plain POS manager
  v_admin    uuid;
  v_s        uuid;    -- the probe's open shift
  v_scheme   uuid;
  v_scheme2  uuid;
  v_r uuid; v_m uuid; v_e uuid; v_m2 uuid; v_z uuid; v_l uuid; v_x uuid; v_dp uuid; v_t uuid; v_u uuid; v_new uuid;
  v_rcp      uuid := gen_random_uuid();   -- pos_order_items.recipe_id has no FK
  v_o_tab uuid; v_o_spend uuid; v_o_cash uuid; v_o_mgr uuid; v_o_pre uuid; v_o_mtab uuid;
  v_amt      numeric;
  v_n        int;
  v_bal      int;
  v_held     int;
  v_hint     text;
  v_msg      text;
  v_res      jsonb;
  v_at       timestamptz;
  v_id       uuid;
  v_ph       text;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.pos_customers'::regclass AND attname = 'loyalty_enrolled_at'
                    AND NOT attisdropped AND atttypid = 'timestamptz'::regtype) THEN
    RAISE EXCEPTION 'S815 4g: pos_customers.loyalty_enrolled_at is missing or not a timestamptz';
  END IF;
  -- tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16. Two columns named in UPDATE OF.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_customers'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgname = 'pos_customers_stamp_enrolled_at'
     AND tgfoid = 'public.pos_customers_stamp_enrolled_at()'::regprocedure
     AND (tgtype & 31) = 23 AND array_length(tgattr::int2[], 1) = 2;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S815 4g: the enrolment stamp trigger is missing or not BEFORE INSERT OR UPDATE OF the two columns';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE (oid IN ('public.award_loyalty_points(uuid)'::regprocedure, 'public.redeem_loyalty_points(uuid,integer)'::regprocedure,
                  'public.move_loyalty_points(uuid,text,text)'::regprocedure) AND prosecdef)
      OR (oid = 'public.pos_loyalty_balances(uuid,uuid)'::regprocedure AND NOT prosecdef AND provolatile = 's')
      OR (oid = 'public.pos_customers_stamp_enrolled_at()'::regprocedure AND NOT prosecdef);
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'S815 4g: a function changed its SECURITY mode or volatility (% of 5 as expected)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname IN ('pos_loyalty_balances', 'move_loyalty_points');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S815 4g: % signatures of the two new functions (want one each)', v_n;
  END IF;
  IF has_function_privilege('anon', 'public.pos_loyalty_balances(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pos_loyalty_balances(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pos_loyalty_balances(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.move_loyalty_points(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.move_loyalty_points(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.move_loyalty_points(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.award_loyalty_points(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.redeem_loyalty_points(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.award_loyalty_points(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.redeem_loyalty_points(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_customers_stamp_enrolled_at()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S815 4g: EXECUTE grants on the loyalty functions are not as expected';
  END IF;
  -- Every enrolled customer has a join date, and no one outside a scheme has one.
  SELECT count(*) INTO v_n FROM public.pos_customers
   WHERE (loyalty_scheme_id IS NOT NULL) <> (loyalty_enrolled_at IS NOT NULL);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S815 4g: % customers have a join date that does not match their enrolment', v_n;
  END IF;

  -- ── The logins: two POS PIN logins of BLOOM CAFE (stand-ins for a supervisor and a manager), and
  -- the operator ─────────────────────────────────────────────────────────────────────────────
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
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND pos_role IS NULL AND ims_role IS NULL AND hr_role IS NULL
     AND pos_email IS NULL AND NOT COALESCE(hr_self_service, false)
   ORDER BY id LIMIT 1;
  IF v_c IS NULL OR v_c2 IS NULL OR v_sup IS NULL OR v_mgr IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S815 4g probe: needs BLOOM CAFE, BLOOM CAFE - PKR, two POS PIN logins of BLOOM CAFE and the operator (got %, %, %, %, %)',
      v_c, v_c2, v_sup, v_mgr, v_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_customers
              WHERE (client_id = v_c AND phone_canonical IN (c_r, c_m, c_new, c_e, c_m2, c_z, c_l, c_dp, c_new2, c_t, c_u))
                 OR (client_id = v_c2 AND phone_canonical = c_x)) THEN
    RAISE EXCEPTION 'S815 4g probe: a probe phone number is already in a customer book';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_orders WHERE client_id = v_c AND order_no BETWEEN 991501 AND 991506) THEN
    RAISE EXCEPTION 'S815 4g probe: a probe order number is already in use at BLOOM CAFE';
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- The stand-ins lose every other staff marker (a restrictive policy would otherwise turn an
    -- "allowed" into a vacuous 0 rows). BLOOM CAFE values a point at NPR 10 and lists one probe partner.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = 10, pos_blocked_at = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_sup;
    UPDATE public.profiles
       SET pos_role = 'manager', pos_allow_void = true, pos_discount_limit = 10, pos_blocked_at = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_mgr;
    UPDATE public.settings
       SET pos_loyalty_point_value = 10,
           pos_delivery_partners = jsonb_build_array(jsonb_build_object('name', 'S815 4g Partner', 'phone', c_dp, 'commission_pct', 20))
     WHERE client_id = v_c;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S815 4g probe: expected one settings row for BLOOM CAFE, found %', v_n;
    END IF;
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S815 4g probe', 0, '{}') RETURNING id INTO v_s;

    INSERT INTO public.pos_loyalty_schemes (client_id, name, points_per_100)
      VALUES (v_c, 'S815 4g probe', 10) RETURNING id INTO v_scheme;
    INSERT INTO public.pos_loyalty_schemes (client_id, name, points_per_100)
      VALUES (v_c, 'S815 4g probe, second', 5) RETURNING id INTO v_scheme2;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id, pan)
      VALUES (v_c, 'Probe regular', c_r, v_scheme, NULL) RETURNING id INTO v_r;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id, pan, address)
      VALUES (v_c, 'Probe mover', c_m, v_scheme, '301234567', 'Probe street') RETURNING id INTO v_m;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'Probe existing', c_e, v_scheme2) RETURNING id INTO v_e;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'Probe second mover', c_m2, v_scheme) RETURNING id INTO v_m2;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'Probe empty', c_z, v_scheme) RETURNING id INTO v_z;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'Probe late joiner', c_l, v_scheme) RETURNING id INTO v_l;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c, 'S815 4g Partner', c_dp, v_scheme) RETURNING id INTO v_dp;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id)
      VALUES (v_c2, 'Probe other outlet', c_x, NULL) RETURNING id INTO v_x;
    -- The migration's role may correct a date on a row whose scheme it leaves alone: the late joiner
    -- joins "tomorrow", so every bill today is from before they joined.
    UPDATE public.pos_customers SET loyalty_enrolled_at = now() + interval '1 day' WHERE id = v_l;
    IF (SELECT loyalty_enrolled_at FROM public.pos_customers WHERE id = v_l) IS DISTINCT FROM now() + interval '1 day'
       OR (SELECT loyalty_enrolled_at FROM public.pos_customers WHERE id = v_r) IS DISTINCT FROM now()
       OR (SELECT loyalty_enrolled_at FROM public.pos_customers WHERE id = v_x) IS NOT NULL THEN
      RAISE EXCEPTION 'S815 4g probe: the stamp did not date the migration role''s rows as written';
    END IF;
    INSERT INTO public.pos_loyalty_ledger (client_id, customer_id, kind, points, note) VALUES
      (v_c, v_r,  'earn', 500, 'S815 4g probe'),
      (v_c, v_m,  'earn', 300, 'S815 4g probe'),
      (v_c, v_m2, 'earn',  50, 'S815 4g probe'),
      (v_c, v_dp, 'earn', 188, 'S815 4g probe: a partner balance from an older backup');

    -- Takeaway orders. order_no is given, so the probe takes no lock on the outlet's real series.
    -- Every bill carries one NPR 1,000 dish at 0 % VAT, except the one the regular spends on.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S815 4g probe', 991501, 'Probe regular', c_r) RETURNING id INTO v_o_tab;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S815 4g probe', 991502, 'Probe regular', c_r) RETURNING id INTO v_o_spend;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S815 4g probe', 991503, 'Probe regular', c_r) RETURNING id INTO v_o_cash;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S815 4g probe', 991504, 'Probe regular', c_r) RETURNING id INTO v_o_mgr;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S815 4g probe', 991505, 'Probe late joiner', c_l) RETURNING id INTO v_o_pre;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no, buyer_name, buyer_phone) VALUES
      (v_c, 'open', 'S815 4g probe', 991506, 'Probe mover', c_m) RETURNING id INTO v_o_mtab;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      SELECT o, v_c, v_rcp, 'S815 4g probe dish', 1, CASE WHEN o = v_o_spend THEN 10000 ELSE 1000 END, 0
        FROM unnest(ARRAY[v_o_tab, v_o_spend, v_o_cash, v_o_mgr, v_o_pre, v_o_mtab]) AS o;

    -- ── As the POS supervisor, through RLS and the INVOKER triggers ──────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S815 4g probe: the stand-in % is not a plain POS supervisor', v_sup;
    END IF;

    -- (a) Q19 (c): a Credit bill earns at its close, and the points are held.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Credit', paid_amount = 1000
     WHERE id = v_o_tab;
    v_n := public.award_loyalty_points(v_o_tab);
    SELECT balance, held INTO v_bal, v_held FROM public.pos_loyalty_balances(v_c, v_r);
    IF v_n <> 100 OR v_bal <> 600 OR v_held <> 100 THEN
      RAISE EXCEPTION 'S815 4g probe: a Credit bill earned % points; balance %, held % (want 100; 600, 100)', v_n, v_bal, v_held;
    END IF;
    -- Through the supervisor's own RLS, another outlet's figures are not there to read.
    SELECT count(*) INTO v_n FROM public.pos_loyalty_balances(v_c2);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S815 4g probe: a BLOOM CAFE supervisor read % balances of another outlet', v_n;
    END IF;

    -- (b) The held 100 cannot be spent; the other 500 can.
    BEGIN
      PERFORM public.redeem_loyalty_points(v_o_spend, 550);
      RAISE EXCEPTION 'S815 4g probe: points held on an unpaid Credit bill were spent';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_points_held' THEN
        RAISE EXCEPTION 'S815 4g probe: spending held points was refused with % (%)', v_hint, v_msg;
      END IF;
    END;
    v_amt := public.redeem_loyalty_points(v_o_spend, 500);
    SELECT balance, held INTO v_bal, v_held FROM public.pos_loyalty_balances(v_c, v_r);
    IF v_amt IS DISTINCT FROM 5000.00 OR v_bal <> 100 OR v_held <> 100 THEN
      RAISE EXCEPTION 'S815 4g probe: 500 points redeemed for %; balance %, held % (want 5000; 100, 100)', v_amt, v_bal, v_held;
    END IF;

    -- (c) Settling the tab releases its points: a replacement redemption of all 600 now passes.
    UPDATE public.pos_orders SET credit_settled_at = now(), credit_settled_method = 'Cash' WHERE id = v_o_tab;
    SELECT balance, held INTO v_bal, v_held FROM public.pos_loyalty_balances(v_c, v_r);
    IF v_bal <> 100 OR v_held <> 0 THEN
      RAISE EXCEPTION 'S815 4g probe: after the settle, balance %, held % (want 100, 0)', v_bal, v_held;
    END IF;
    v_amt := public.redeem_loyalty_points(v_o_spend, 600);
    SELECT balance, held INTO v_bal, v_held FROM public.pos_loyalty_balances(v_c, v_r);
    IF v_amt IS DISTINCT FROM 6000.00 OR v_bal <> 0 OR v_held <> 0 THEN
      RAISE EXCEPTION 'S815 4g probe: 600 points after the settle redeemed for %; balance %, held % (want 6000; 0, 0)', v_amt, v_bal, v_held;
    END IF;

    -- (d) Bills whose points did not land, and one from before its customer joined: at the close that
    -- one is an ordinary 0.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id IN (v_o_cash, v_o_pre);
    v_n := public.award_loyalty_points(v_o_pre);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S815 4g probe: a bill from before its customer joined earned % points at the close', v_n;
    END IF;

    -- (e) The mover's tab holds 100 of their 400.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Credit', paid_amount = 1000
     WHERE id = v_o_mtab;
    v_n := public.award_loyalty_points(v_o_mtab);
    SELECT balance, held INTO v_bal, v_held FROM public.pos_loyalty_balances(v_c, v_m);
    IF v_n <> 100 OR v_bal <> 400 OR v_held <> 100 THEN
      RAISE EXCEPTION 'S815 4g probe: the mover''s tab earned %; balance %, held % (want 100; 400, 100)', v_n, v_bal, v_held;
    END IF;

    -- (f) A supervisor cannot move points.
    BEGIN
      PERFORM public.move_loyalty_points(v_m, c_new, 'probe');
      RAISE EXCEPTION 'S815 4g probe: a POS supervisor moved points';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_points_move_rank' THEN
        RAISE EXCEPTION 'S815 4g probe: the supervisor''s move was refused with hint %', v_hint;
      END IF;
    END;

    -- ── As the POS manager ─────────────────────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S815 4g probe: the stand-in % is not a plain POS manager', v_mgr;
    END IF;

    -- (g) One tap: a POS manager adds the points of a bill the supervisor closed. Once.
    v_n := public.award_loyalty_points(v_o_cash);
    IF v_n <> 100 OR NOT EXISTS (SELECT 1 FROM public.pos_loyalty_ledger
                                  WHERE order_id = v_o_cash AND kind = 'earn' AND points = 100
                                    AND customer_id = v_r AND created_by = v_mgr) THEN
      RAISE EXCEPTION 'S815 4g probe: the manager''s late award gave % points, or no earn row stamped with the manager', v_n;
    END IF;
    v_n := public.award_loyalty_points(v_o_cash);
    IF v_n <> 0 OR (SELECT count(*) FROM public.pos_loyalty_ledger WHERE order_id = v_o_cash) <> 1 THEN
      RAISE EXCEPTION 'S815 4g probe: a second late award on the same bill gave % points', v_n;
    END IF;

    -- (h) ... but not for a bill from before the customer joined.
    BEGIN
      PERFORM public.award_loyalty_points(v_o_pre);
      RAISE EXCEPTION 'S815 4g probe: a late award was given for a bill from before its customer joined';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_points_before_enrolment' THEN
        RAISE EXCEPTION 'S815 4g probe: a pre-joining late award was refused with %', v_hint;
      END IF;
    END;

    -- (i) A bill the manager closes: the supervisor, not its closer, still cannot add its points.
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 1000
     WHERE id = v_o_mgr;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.award_loyalty_points(v_o_mgr);
      RAISE EXCEPTION 'S815 4g probe: a supervisor added the points of a bill another login closed';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S815 4g probe: the supervisor''s award of another''s bill was refused with %', v_hint;
      END IF;
    END;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);

    -- (j) Each refusal of a move, and nothing written by any of them.
    SELECT count(*) INTO v_bal FROM public.pos_loyalty_ledger WHERE client_id = v_c;
    FOR v_id, v_ph, v_msg, v_hint IN
      SELECT * FROM (VALUES (v_m,  c_new,    '   ',   'pos_points_move_reason'),
                            (v_m,  c_new,    NULL,    'pos_points_move_reason'),
                            (v_m,  c_new,    repeat('x', 301), 'pos_points_move_reason'),
                            (v_m,  '12345',  'probe', 'pos_points_move_number'),
                            (v_m,  NULL,     'probe', 'pos_points_move_number'),
                            (v_m,  c_m_plus, 'probe', 'pos_points_move_same'),
                            (v_m,  c_dp,     'probe', 'pos_points_move_partner'),
                            (v_dp, c_new2,   'probe', 'pos_points_move_partner'),
                            (v_z,  c_new2,   'probe', 'pos_points_move_nothing'),
                            (gen_random_uuid(), c_new, 'probe', 'pos_points_move_no_customer')) t(f, p, r, h)
    LOOP
      BEGIN
        PERFORM public.move_loyalty_points(v_id, v_ph, v_msg);
        RAISE EXCEPTION 'S815 4g probe: a move to % was accepted (want %)', v_ph, v_hint;
      EXCEPTION WHEN raise_exception THEN
        GET STACKED DIAGNOSTICS v_msg = PG_EXCEPTION_HINT;
        IF v_msg IS DISTINCT FROM v_hint THEN
          RAISE EXCEPTION 'S815 4g probe: a move to % was refused with % (want %)', v_ph, v_msg, v_hint;
        END IF;
      END;
    END LOOP;
    BEGIN
      PERFORM public.move_loyalty_points(v_x, c_new, 'probe');
      RAISE EXCEPTION 'S815 4g probe: a BLOOM CAFE manager moved another outlet''s customer''s points';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    END;
    IF (SELECT count(*) FROM public.pos_loyalty_ledger WHERE client_id = v_c) <> v_bal
       OR EXISTS (SELECT 1 FROM public.pos_customers WHERE client_id = v_c AND phone_canonical IN (c_new, c_new2)) THEN
      RAISE EXCEPTION 'S815 4g probe: a refused move wrote a ledger row or added a customer';
    END IF;

    -- (k) D11, D12, D14: the mover's 300 spendable points go to their new number, which is added to
    -- the book with their name, PAN and address and joins their scheme; the 100 held on the tab stay;
    -- the old number leaves its scheme.
    v_res := public.move_loyalty_points(v_m, c_new_tp, '  New SIM  ');
    v_new := (v_res ->> 'to_customer_id')::uuid;
    IF (v_res ->> 'moved')::int <> 300 OR (v_res ->> 'held_left')::int <> 100 OR (v_res ->> 'from_balance')::int <> 100
       OR (v_res ->> 'to_balance')::int <> 300 OR v_res ->> 'to_phone' <> c_new
       OR NOT (v_res ->> 'created')::boolean OR NOT (v_res ->> 'enrolled')::boolean OR NOT (v_res ->> 'unenrolled')::boolean THEN
      RAISE EXCEPTION 'S815 4g probe: the move answered %', v_res;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_customers
                    WHERE id = v_new AND client_id = v_c AND phone = c_new AND name = 'Probe mover'
                      AND pan = '301234567' AND address = 'Probe street'
                      AND loyalty_scheme_id = v_scheme AND loyalty_enrolled_at = now())
       OR NOT EXISTS (SELECT 1 FROM public.pos_customers
                       WHERE id = v_m AND loyalty_scheme_id IS NULL AND loyalty_enrolled_at IS NULL) THEN
      RAISE EXCEPTION 'S815 4g probe: the new number''s row or the old number''s enrolment is not as moved';
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_loyalty_ledger
     WHERE kind = 'adjust' AND order_id IS NULL AND created_by = v_mgr
       AND ((customer_id = v_m   AND points = -300 AND note = 'Moved to ' || c_new || ': New SIM')
         OR (customer_id = v_new AND points =  300 AND note = 'Moved from ' || c_m || ': New SIM'));
    SELECT balance, held INTO v_bal, v_held FROM public.pos_loyalty_balances(v_c, v_m);
    IF v_n <> 2 OR v_bal <> 100 OR v_held <> 100 THEN
      RAISE EXCEPTION 'S815 4g probe: % of the 2 move rows; the old number holds %, % held (want 100, 100)', v_n, v_bal, v_held;
    END IF;

    -- (l) What stayed is held, so a second move has nothing it may take.
    BEGIN
      PERFORM public.move_loyalty_points(v_m, c_new, 'again');
      RAISE EXCEPTION 'S815 4g probe: points held on an unpaid Credit bill were moved';
    EXCEPTION WHEN raise_exception THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_points_move_held' THEN
        RAISE EXCEPTION 'S815 4g probe: moving only held points was refused with %', v_hint;
      END IF;
    END;

    -- (m) Onto a customer already in the book, on another scheme: they keep their scheme.
    v_res := public.move_loyalty_points(v_m2, c_e, 'Two numbers, one regular');
    IF (v_res ->> 'moved')::int <> 50 OR (v_res ->> 'created')::boolean OR (v_res ->> 'enrolled')::boolean
       OR (v_res ->> 'to_customer_id')::uuid IS DISTINCT FROM v_e OR (v_res ->> 'to_balance')::int <> 50
       OR NOT EXISTS (SELECT 1 FROM public.pos_customers WHERE id = v_e AND loyalty_scheme_id = v_scheme2)
       OR NOT EXISTS (SELECT 1 FROM public.pos_customers WHERE id = v_m2 AND loyalty_scheme_id IS NULL) THEN
      RAISE EXCEPTION 'S815 4g probe: the move onto an existing customer answered %', v_res;
    END IF;

    -- (n) The stamp, from a client session: joining dates now(), a sent date is ignored, a scheme
    -- change keeps the date, leaving clears it, joining again dates it again.
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id, loyalty_enrolled_at)
      VALUES (v_c, 'Probe stamp', c_t, v_scheme, '2020-01-01') RETURNING id INTO v_t;
    SELECT loyalty_enrolled_at INTO v_at FROM public.pos_customers WHERE id = v_t;
    IF v_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S815 4g probe: a manager''s new member was dated % (want now)', v_at;
    END IF;
    UPDATE public.pos_customers SET loyalty_enrolled_at = '2020-01-01' WHERE id = v_t;
    UPDATE public.pos_customers SET loyalty_scheme_id = v_scheme2 WHERE id = v_t;
    SELECT loyalty_enrolled_at INTO v_at FROM public.pos_customers WHERE id = v_t;
    IF v_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S815 4g probe: a sent date or a scheme change moved the join date to %', v_at;
    END IF;
    UPDATE public.pos_customers SET loyalty_scheme_id = NULL WHERE id = v_t;
    IF (SELECT loyalty_enrolled_at FROM public.pos_customers WHERE id = v_t) IS NOT NULL THEN
      RAISE EXCEPTION 'S815 4g probe: leaving the scheme kept a join date';
    END IF;
    UPDATE public.pos_customers SET loyalty_scheme_id = v_scheme WHERE id = v_t;
    IF (SELECT loyalty_enrolled_at FROM public.pos_customers WHERE id = v_t) IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S815 4g probe: joining again was not dated';
    END IF;

    -- ── (o) As the operator: a restore brings a customer's own date back ─────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S815 4g probe: % is not the operator', v_admin;
    END IF;
    INSERT INTO public.pos_customers (client_id, name, phone, loyalty_scheme_id, loyalty_enrolled_at)
      VALUES (v_c, 'Probe restored', c_u, v_scheme, '2020-01-01') RETURNING id INTO v_u;
    IF (SELECT loyalty_enrolled_at FROM public.pos_customers WHERE id = v_u) IS DISTINCT FROM '2020-01-01'::timestamptz THEN
      RAISE EXCEPTION 'S815 4g probe: the operator''s restored join date was not kept';
    END IF;
    -- The operator's balances read is one outlet's, though their RLS sees every outlet.
    SELECT count(*) INTO v_n FROM public.pos_loyalty_balances(v_c) b
     WHERE b.customer_id IN (SELECT id FROM public.pos_customers WHERE client_id <> v_c);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S815 4g probe: the operator''s balances for BLOOM CAFE included % other outlets'' customers', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's815_4g_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's815_4g_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT p.oid::regprocedure, md5(p.prosrc), p.prosecdef, p.provolatile, p.proacl FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace
--      AND p.proname IN ('award_loyalty_points', 'redeem_loyalty_points', 'pos_loyalty_balances',
--                        'move_loyalty_points', 'pos_customers_stamp_enrolled_at');
--     expect award c876271778dafdf1cc08696787d93f5b, redeem 7c5ffd50738fce54c0a98b2d35eba7c0; prosecdef t for award, redeem, move and f for
--     the other two; proacl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} on
--     all but the stamp, which is {postgres=X/postgres}.
--   SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.pos_customers'::regclass AND NOT tgisinternal;   -- the stamp beside the guard and the three audits
--   SELECT count(*) FROM public.pos_customers
--    WHERE (loyalty_scheme_id IS NOT NULL) <> (loyalty_enrolled_at IS NOT NULL);   -- 0
--   SELECT has_function_privilege('anon', 'public.move_loyalty_points(uuid,text,text)', 'EXECUTE');   -- f
