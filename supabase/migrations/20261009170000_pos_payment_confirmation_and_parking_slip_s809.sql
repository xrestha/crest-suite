-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1k: a payment confirmation and a parking slip are written by the server.
--
--   CHECKOUT-12 (P3, dormant until QR auto-confirm goes live). pos_payment_confirmations had a
--   same-client UPDATE policy with no column limit, no WITH CHECK and no trigger. Only the
--   pos-payment-webhook Edge Function (service role) creates a row; the till's QR poll
--   (PosOrders.jsx) reads unconsumed rows matched to the bill on screen and closes the bill as paid
--   by that provider. So any login of the outlet could set yesterday's used confirmation back to
--   unused, point it at another table's open bill with today's amount, and have the cashier's till
--   close that bill as paid by eSewa without anyone checking the merchant app.
--
--   Closed by pos_payment_confirmations_guard (BEFORE INSERT/UPDATE/DELETE, SECURITY INVOKER):
--   a browser session may only mark a confirmation used, once, after the bill it was matched to is
--   closed, and the time is the server's. Every other column, every insert and every delete is
--   refused, the operator included. authenticated holds no INSERT or DELETE grant, so the restore
--   cannot insert this table today either (DATABASE-6, stage 4, takes it out of RESTORE_ORDER).
--   The webhook (service role) is untouched.
--
--   Writers traced (2026-10-09): pos-payment-webhook inserts (service role); PosOrders.jsx:772
--   updates { consumed_at } by id after closeOrder('paid') returned true, i.e. after the bill is
--   billed; admin-user-ops deletes a client's rows with the service role (Danger Zone, client
--   delete). Nothing else in src/ or supabase/functions writes the table.
--
--   CUSTOMERS-PARKING-13 (P3). The Supervisor rank to issue a slip was a check inside
--   NewParkingSlipModal, and the slip number, issuer, times, bill number and print count were
--   whatever the browser sent. Any login of the outlet could issue a slip, give two tokens the
--   same number, put a colleague's name on one, rewrite the vehicle on an issued slip, close it in
--   someone else's name, or set print_count back to 0 so the next reprint is a second token with
--   no REPRINT mark. Closed by pos_parking_slips_guard (BEFORE INSERT/UPDATE, SECURITY INVOKER),
--   which calls the one POS rank test, pos_caller_has_rank():
--     • issue = POS supervisor, POS manager, Owner or operator (the screen's hasPosAccess('supervisor'));
--       the number, issuer, time in, status and print count are the server's; a linked bill must
--       be this outlet's, and the bill number printed on the token is that bill's own;
--     • afterwards only two things change: it is printed again (the count goes up by one, whatever
--       the tablet thought it was) or it is closed once (time out and "exited by" are the server's;
--       an automatic close is allowed only for a slip from before today's 6 AM Nepal service-day
--       start and names nobody). Closing an already-closed slip again keeps the first close.
--       Printing and closing need any POS rank (the page is staff+);
--     • slips are numbered per outlet by trg_assign_pos_parking_slip_no, the same advisory-lock
--       MAX+1 shape as pos_orders.order_no; the guard clears a number the browser sends so that
--       trigger always numbers a till's slip, and UNIQUE (client_id, slip_no) plus NOT NULL make the
--       number a schema fact.
--   The operator keeps what it sends on INSERT, because restoreClientData re-inserts a client's
--   slips with their original numbers, names and times (slice 1l, Q26, is to narrow this to a
--   restore in progress). On UPDATE the operator meets the same rules as the Owner (Q26 a): no
--   screen or restore path needs more.
--
-- Built on LIVE bodies read 2026-10-09 (nothing here replaces them; both are relied on):
--   assign_pos_parking_slip_no   md5(prosrc) efe7d6d737336e687a4fa44e637b65c3 (kept: it numbers
--                                any NULL slip_no under pg_advisory_xact_lock, like
--                                assign_pos_order_no d48f0498091e8c625d61e08937984a68)
--   pos_caller_has_rank          md5(prosrc) 7d34792c8f392e49bc47274d1e8045ce
-- New: pos_parking_slips_guard(), pos_payment_confirmations_guard(), their triggers,
--      pos_parking_slips_client_slip_no_key, pos_parking_slips.slip_no NOT NULL.
--
-- Live before this migration: 5 parking slips, all BLOOM CAFE, numbered 1–5 (0 duplicates, 0 gaps,
-- 0 NULL numbers, 0 open), every bill link to a bill of the same outlet with a matching number, so
-- the unique index and NOT NULL validate. 0 payment confirmations and 0 webhook secrets at any
-- client. authenticated holds INSERT/SELECT/UPDATE on pos_parking_slips (no DELETE) and
-- SELECT/UPDATE on pos_payment_confirmations (no INSERT, no DELETE).
--
-- The probe at the end runs as a real Owner, a real POS login (made Staff rank inside the block)
-- and the operator, inside a block that rolls itself back. If any check fails, the whole
-- migration fails and nothing here lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 1. A payment confirmation is the provider's; a till may only mark it used (CHECKOUT-12) ──
--
-- SECURITY INVOKER on purpose: current_user is then the caller's role, so the webhook (service
-- role), every SECURITY DEFINER body and the foreign keys' own actions pass, as in
-- guard_profiles_privileged_columns(). An allow-list, not a deny-list: a column added to this
-- table later is locked by default. The bill lookup runs under the caller's RLS and fails closed:
-- a bill the caller cannot see counts as not closed.
CREATE OR REPLACE FUNCTION public.pos_payment_confirmations_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP <> 'UPDATE'
     OR (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
     OR OLD.consumed_at IS NOT NULL
     OR NEW.consumed_at IS NULL THEN
    RAISE EXCEPTION 'pos_payment_confirmations: a payment confirmation is written by the payment provider; a till may only mark it used, once'
      USING ERRCODE = '42501', HINT = 'pos_payment_confirmation_locked';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pos_orders o
                  WHERE o.id = OLD.matched_order_id
                    AND o.client_id = OLD.client_id
                    AND o.status = 'billed') THEN
    RAISE EXCEPTION 'pos_payment_confirmations: a payment confirmation is marked used by the bill it was matched to, once that bill is closed'
      USING ERRCODE = '42501', HINT = 'pos_payment_confirmation_locked';
  END IF;

  NEW.consumed_at := now();
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_payment_confirmations_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_payment_confirmations_guard ON public.pos_payment_confirmations;
CREATE TRIGGER pos_payment_confirmations_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_payment_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.pos_payment_confirmations_guard();


-- ── 2. A parking slip is issued by a supervisor and then only printed or closed ───────────────
--   (CUSTOMERS-PARKING-13)
--
-- SECURITY INVOKER for the same current_user seam (the foreign keys' SET NULL on a deleted bill or
-- profile runs as the table owner and passes). Its name sorts before trg_assign_pos_parking_slip_no,
-- so on INSERT it runs first and the slip_no it clears is then numbered by that trigger. Keep the
-- two names in that order; the probe below proves it by behaviour.
CREATE OR REPLACE FUNCTION public.pos_parking_slips_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_invoice integer;
  v_cutoff  timestamptz;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The operator's restore re-inserts a client's slips as they were. Slice 1l (Q26) narrows this
    -- to a restore in progress.
    IF COALESCE(public.is_admin(), false) THEN
      RETURN NEW;
    END IF;
    IF NOT COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
      RAISE EXCEPTION 'pos_parking_slips: issuing a parking slip needs a POS supervisor, a POS manager or the Owner'
        USING ERRCODE = '42501', HINT = 'pos_parking_slip_rank';
    END IF;
    IF NEW.order_id IS NOT NULL THEN
      SELECT o.invoice_no INTO v_invoice
        FROM pos_orders o
       WHERE o.id = NEW.order_id AND o.client_id = NEW.client_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'pos_parking_slips: a parking slip can only be linked to a bill of its own outlet'
          USING ERRCODE = '23503', HINT = 'pos_parking_slip_bill';
      END IF;
    END IF;
    NEW.slip_no         := NULL;          -- numbered next by trg_assign_pos_parking_slip_no
    NEW.bill_invoice_no := v_invoice;     -- the linked bill's own number, never the tablet's
    NEW.issued_by       := (select auth.uid());
    NEW.time_in         := now();
    NEW.created_at      := now();
    NEW.status          := 'open';
    NEW.time_out        := NULL;
    NEW.exited_by       := NULL;
    NEW.auto_closed     := false;
    NEW.print_count     := 0;
    RETURN NEW;
  END IF;

  -- UPDATE. After issue a slip is only printed again or closed.
  IF (to_jsonb(NEW) - ARRAY['print_count', 'status', 'time_out', 'exited_by', 'auto_closed'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['print_count', 'status', 'time_out', 'exited_by', 'auto_closed']) THEN
    RAISE EXCEPTION 'pos_parking_slips: an issued parking slip cannot be rewritten; it can only be printed again or marked exited'
      USING ERRCODE = '42501', HINT = 'pos_parking_slip_locked';
  END IF;
  IF NOT COALESCE(public.pos_caller_has_rank('staff'), false) THEN
    RAISE EXCEPTION 'pos_parking_slips: printing or closing a parking slip needs a POS login (Staff rank or above) or the Owner'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- A print is one more copy, whatever count the tablet last saw. It never goes back down.
  IF NEW.print_count IS DISTINCT FROM OLD.print_count THEN
    NEW.print_count := OLD.print_count + 1;
  END IF;

  IF (NEW.status, NEW.time_out, NEW.exited_by, NEW.auto_closed)
     IS DISTINCT FROM (OLD.status, OLD.time_out, OLD.exited_by, OLD.auto_closed) THEN
    IF OLD.status = 'closed' THEN
      IF NEW.status IS DISTINCT FROM 'closed' THEN
        RAISE EXCEPTION 'pos_parking_slips: a closed parking slip stays closed'
          USING HINT = 'pos_parking_slip_closed';
      END IF;
      -- Closed again (two tablets, or Mark Exited after the sweep): the first close stands.
      NEW.time_out    := OLD.time_out;
      NEW.exited_by   := OLD.exited_by;
      NEW.auto_closed := OLD.auto_closed;
    ELSE
      IF NEW.status IS DISTINCT FROM 'closed' THEN
        RAISE EXCEPTION 'pos_parking_slips: an open parking slip changes only by being marked exited'
          USING ERRCODE = '42501', HINT = 'pos_parking_slip_locked';
      END IF;
      IF NEW.auto_closed THEN
        -- The page's sweep closes a slip from before the 6 AM (Nepal) that started today's service
        -- day (PosParkingSlips.jsx). 30 minutes of slack for a tablet clock running fast, so the
        -- sweep a till sends is never refused for a few minutes' drift.
        v_cutoff := (date_trunc('day', ((now() + interval '30 minutes') AT TIME ZONE 'Asia/Kathmandu') - interval '6 hours')
                     + interval '6 hours') AT TIME ZONE 'Asia/Kathmandu';
        IF OLD.time_in >= v_cutoff THEN
          RAISE EXCEPTION 'pos_parking_slips: only a slip from an earlier service day closes automatically; mark this vehicle exited instead'
            USING HINT = 'pos_parking_slip_not_stale';
        END IF;
      END IF;
      NEW.time_out  := now();
      NEW.exited_by := CASE WHEN NEW.auto_closed THEN NULL ELSE (select auth.uid()) END;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_parking_slips_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_parking_slips_guard ON public.pos_parking_slips;
CREATE TRIGGER pos_parking_slips_guard
  BEFORE INSERT OR UPDATE ON public.pos_parking_slips
  FOR EACH ROW EXECUTE FUNCTION public.pos_parking_slips_guard();


-- ── 3. One number per slip per outlet ───────────────────────────────────────────────────────
--
-- NOT NULL is checked after the BEFORE triggers, so the numbering trigger fills a NULL first,
-- including on a restore from a backup that predates numbering. The index also serves the
-- numbering trigger's MAX(slip_no) per client.
DROP INDEX IF EXISTS public.pos_parking_slips_client_slip_no_key;
CREATE UNIQUE INDEX pos_parking_slips_client_slip_no_key
  ON public.pos_parking_slips (client_id, slip_no);
ALTER TABLE public.pos_parking_slips ALTER COLUMN slip_no SET NOT NULL;


-- ── 4. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_att_cl   smallint;
  v_att_no   smallint;
  v_n        int;
  v_cl       uuid;
  v_b        uuid;
  v_owner    uuid;
  v_pos      uuid;
  v_admin    uuid;
  v_other    uuid;
  v_bill     uuid;
  v_bill_inv integer;
  v_open     uuid;
  v_far      uuid;
  v_c_open   uuid;
  v_c_paid   uuid;
  v_c_used   uuid;
  v_old      uuid;
  v_s1       uuid;
  v_s2       uuid;
  v_s3       uuid;
  v_sa       uuid;
  v_max      integer;
  v_cut      timestamptz;
  v_ts       timestamptz;
  v_by       uuid;
  r          record;
  v_hint     text;
  v_state    text;
BEGIN
  -- Catalog, asserted on catalog columns.
  SELECT attnum INTO v_att_cl FROM pg_attribute
   WHERE attrelid = 'public.pos_parking_slips'::regclass AND attname = 'client_id';
  SELECT attnum INTO v_att_no FROM pg_attribute
   WHERE attrelid = 'public.pos_parking_slips'::regclass AND attname = 'slip_no';
  SELECT count(*) INTO v_n FROM pg_index
   WHERE indrelid = 'public.pos_parking_slips'::regclass AND indisunique AND indpred IS NULL
     AND indnatts = 2 AND indkey[0] = v_att_cl AND indkey[1] = v_att_no;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1k: expected one unique index on pos_parking_slips (client_id, slip_no), found %', v_n;
  END IF;
  IF NOT (SELECT attnotnull FROM pg_attribute
           WHERE attrelid = 'public.pos_parking_slips'::regclass AND attnum = v_att_no) THEN
    RAISE EXCEPTION 'S809 1k: pos_parking_slips.slip_no is still nullable';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_parking_slips'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgname IN ('pos_parking_slips_guard', 'trg_assign_pos_parking_slip_no');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1k: expected the guard and the numbering trigger on pos_parking_slips, found %', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_payment_confirmations'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgname = 'pos_payment_confirmations_guard';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 1k: the payment confirmation guard is missing';
  END IF;
  IF has_table_privilege('authenticated', 'public.pos_payment_confirmations', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pos_payment_confirmations', 'DELETE')
     OR has_table_privilege('authenticated', 'public.pos_parking_slips', 'DELETE') THEN
    RAISE EXCEPTION 'S809 1k: a browser session holds INSERT/DELETE on confirmations or DELETE on parking slips';
  END IF;
  IF has_function_privilege('anon', 'public.pos_parking_slips_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_parking_slips_guard()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_payment_confirmations_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_payment_confirmations_guard()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 1k: a guard function is executable by a browser role';
  END IF;

  -- The cast: the outlet with the most numbered bills, its Owner, one of its POS logins, the
  -- operator, another outlet and a bystander profile to forge names with.
  SELECT o.client_id INTO v_cl FROM public.pos_orders o
   WHERE o.status = 'billed' AND o.invoice_no IS NOT NULL
   GROUP BY o.client_id ORDER BY count(*) DESC, o.client_id LIMIT 1;
  SELECT o.id, o.invoice_no INTO v_bill, v_bill_inv FROM public.pos_orders o
   WHERE o.client_id = v_cl AND o.status = 'billed' AND o.invoice_no IS NOT NULL
   ORDER BY o.id LIMIT 1;
  SELECT p.id INTO v_owner FROM public.profiles p
   WHERE COALESCE(p.active_client_id, p.client_id) = v_cl AND p.role = 'client'
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_pos FROM public.profiles p
   WHERE COALESCE(p.active_client_id, p.client_id) = v_cl AND p.role = 'client'
     AND p.pos_email IS NOT NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' ORDER BY p.id LIMIT 1;
  SELECT c.id INTO v_b FROM public.clients c WHERE c.id <> v_cl ORDER BY c.id LIMIT 1;
  SELECT p.id INTO v_other FROM public.profiles p
   WHERE p.id NOT IN (v_owner, v_pos, v_admin) ORDER BY p.id LIMIT 1;
  IF v_cl IS NULL OR v_bill IS NULL OR v_owner IS NULL OR v_pos IS NULL OR v_admin IS NULL
     OR v_b IS NULL OR v_other IS NULL THEN
    RAISE EXCEPTION 'S809 1k probe: needs a billed outlet with an Owner and a POS login, the operator, a second client and a bystander (got %, %, %, %, %, %, %)',
      v_cl, v_bill, v_owner, v_pos, v_admin, v_b, v_other;
  END IF;

  BEGIN
    -- Setup, as the migration's own role (the guards let it through, like the webhook).
    UPDATE public.profiles SET pos_role = 'staff', settlement_blocked_by = NULL WHERE id = v_pos;
    INSERT INTO public.pos_orders (client_id) VALUES (v_cl) RETURNING id INTO v_open;
    INSERT INTO public.pos_orders (client_id) VALUES (v_b)  RETURNING id INTO v_far;
    INSERT INTO public.pos_payment_confirmations (client_id, provider, amount, txn_ref, matched_order_id)
      VALUES (v_cl, 'eSewa', 1850, 'S809-1k-open', v_open) RETURNING id INTO v_c_open;
    INSERT INTO public.pos_payment_confirmations (client_id, provider, amount, txn_ref, matched_order_id)
      VALUES (v_cl, 'eSewa', 1850, 'S809-1k-paid', v_bill) RETURNING id INTO v_c_paid;
    INSERT INTO public.pos_payment_confirmations (client_id, provider, amount, txn_ref, matched_order_id, consumed_at)
      VALUES (v_cl, 'eSewa', 1850, 'S809-1k-used', v_bill, now() - interval '1 day') RETURNING id INTO v_c_used;
    INSERT INTO public.pos_parking_slips (client_id, vehicle_number, time_in)
      VALUES (v_cl, 'S809 PROBE OLD', now() - interval '2 days') RETURNING id INTO v_old;
    SELECT max(slip_no) INTO v_max FROM public.pos_parking_slips WHERE client_id = v_cl;

    -- ── As the Owner ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1k probe: % is not an Owner login', v_owner;
    END IF;

    -- (p1) everything the browser sends about who, when, which number and which bill is replaced.
    INSERT INTO public.pos_parking_slips (client_id, slip_no, vehicle_number, time_in, created_at, issued_by,
                                          print_count, status, time_out, exited_by, auto_closed, order_id, bill_invoice_no)
      VALUES (v_cl, 999999, 'S809 PROBE 1', now() - interval '3 days', now() - interval '3 days', v_other,
              7, 'closed', now(), v_other, true, v_bill, 424242)
      RETURNING * INTO r;
    IF r.slip_no IS DISTINCT FROM v_max + 1 OR r.issued_by IS DISTINCT FROM v_owner
       OR r.time_in IS DISTINCT FROM now() OR r.created_at IS DISTINCT FROM now() OR r.print_count IS DISTINCT FROM 0
       OR r.status IS DISTINCT FROM 'open' OR r.time_out IS NOT NULL OR r.exited_by IS NOT NULL
       OR r.auto_closed IS DISTINCT FROM false
       OR r.order_id IS DISTINCT FROM v_bill OR r.bill_invoice_no IS DISTINCT FROM v_bill_inv THEN
      RAISE EXCEPTION 'S809 1k probe: an Owner''s slip kept what the browser sent: %', row_to_json(r);
    END IF;
    v_s1 := r.id;

    -- (p2) the next slip takes the next number.
    INSERT INTO public.pos_parking_slips (client_id, vehicle_number) VALUES (v_cl, 'S809 PROBE 2')
      RETURNING id, slip_no INTO v_s2, v_n;
    IF v_n IS DISTINCT FROM v_max + 2 THEN
      RAISE EXCEPTION 'S809 1k probe: the second slip was numbered %, expected %', v_n, v_max + 2;
    END IF;
    INSERT INTO public.pos_parking_slips (client_id, vehicle_number) VALUES (v_cl, 'S809 PROBE 3')
      RETURNING id INTO v_s3;

    -- (p3) a bill of another outlet.
    BEGIN
      INSERT INTO public.pos_parking_slips (client_id, vehicle_number, order_id) VALUES (v_cl, 'S809 PROBE X', v_far);
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_parking_slip_bill' THEN
      RAISE EXCEPTION 'S809 1k probe: a slip linked to another outlet''s bill gave %', v_hint;
    END IF;

    -- (p4) an issued slip is not rewritten: vehicle, number, issuer, bill number.
    BEGIN
      UPDATE public.pos_parking_slips SET vehicle_number = 'REWRITTEN' WHERE id = v_s1;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_parking_slip_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: rewriting a slip''s vehicle gave %', v_hint;
    END IF;
    BEGIN
      UPDATE public.pos_parking_slips SET slip_no = 1, issued_by = v_other, bill_invoice_no = 1 WHERE id = v_s1;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_parking_slip_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: renumbering or re-attributing a slip gave %', v_hint;
    END IF;

    -- (p5) a print adds one; a reset to 0 or a jump still adds exactly one.
    UPDATE public.pos_parking_slips SET print_count = 1 WHERE id = v_s1 RETURNING print_count INTO v_n;
    IF v_n IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'S809 1k probe: the first print stored %', v_n; END IF;
    UPDATE public.pos_parking_slips SET print_count = 0 WHERE id = v_s1 RETURNING print_count INTO v_n;
    IF v_n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'S809 1k probe: a print_count reset stored % (expected 2)', v_n; END IF;
    UPDATE public.pos_parking_slips SET print_count = 50 WHERE id = v_s1 RETURNING print_count INTO v_n;
    IF v_n IS DISTINCT FROM 3 THEN RAISE EXCEPTION 'S809 1k probe: a print_count jump stored % (expected 3)', v_n; END IF;

    -- (p6) Mark Exited: the closer and the time are the server's.
    UPDATE public.pos_parking_slips
       SET status = 'closed', time_out = now() - interval '1 day', exited_by = v_other
     WHERE id = v_s1
     RETURNING exited_by, time_out INTO v_by, v_ts;
    IF NOT FOUND OR v_by IS DISTINCT FROM v_owner OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 1k probe: Mark Exited stored exited_by % at %', v_by, v_ts;
    END IF;

    -- (p7) closing it again (another tablet, or an auto-close) keeps the first close.
    UPDATE public.pos_parking_slips SET status = 'closed', exited_by = v_other, auto_closed = true
     WHERE id = v_s1 RETURNING exited_by INTO v_by;
    IF v_by IS DISTINCT FROM v_owner
       OR COALESCE((SELECT auto_closed FROM public.pos_parking_slips WHERE id = v_s1), true) THEN
      RAISE EXCEPTION 'S809 1k probe: a second close rewrote the first (exited_by %)', v_by;
    END IF;

    -- (p8) a closed slip is not reopened.
    BEGIN
      UPDATE public.pos_parking_slips SET status = 'open', time_out = NULL WHERE id = v_s1;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_parking_slip_closed' THEN
      RAISE EXCEPTION 'S809 1k probe: reopening a closed slip gave %', v_hint;
    END IF;

    -- (p9) an open slip does not take a name without being closed.
    BEGIN
      UPDATE public.pos_parking_slips SET exited_by = v_other WHERE id = v_s2;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_parking_slip_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: naming an open slip''s closer gave %', v_hint;
    END IF;

    -- (p10) today's slip is not auto-closed. Skipped in the half hour before 6 AM Nepal, when a
    -- slip from the night's service is legitimately sweepable.
    v_cut := (date_trunc('day', ((now() + interval '30 minutes') AT TIME ZONE 'Asia/Kathmandu') - interval '6 hours')
              + interval '6 hours') AT TIME ZONE 'Asia/Kathmandu';
    IF now() >= v_cut THEN
      BEGIN
        UPDATE public.pos_parking_slips SET status = 'closed', time_out = now(), auto_closed = true WHERE id = v_s3;
        v_hint := '(accepted)';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      END;
      IF v_hint IS DISTINCT FROM 'pos_parking_slip_not_stale' THEN
        RAISE EXCEPTION 'S809 1k probe: auto-closing today''s slip gave %', v_hint;
      END IF;
    ELSE
      RAISE NOTICE 'S809 1k probe: (p10) skipped, run inside the half hour before 6 AM Nepal';
    END IF;

    -- (p11) the sweep closes an earlier day's slip, naming nobody, at the server's time.
    UPDATE public.pos_parking_slips
       SET status = 'closed', time_out = now() - interval '5 days', auto_closed = true
     WHERE id = v_old
     RETURNING exited_by, time_out INTO v_by, v_ts;
    IF NOT FOUND OR v_by IS NOT NULL OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 1k probe: the sweep stored exited_by % at % (found %)', v_by, v_ts, FOUND;
    END IF;

    -- (c1) a used confirmation is not put back in play against another bill.
    BEGIN
      UPDATE public.pos_payment_confirmations SET consumed_at = NULL, matched_order_id = v_open WHERE id = v_c_used;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_confirmation_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: reviving a used confirmation gave %', v_hint;
    END IF;
    -- (c2) nor is an unused one re-pointed, (c3) nor its amount changed.
    BEGIN
      UPDATE public.pos_payment_confirmations SET matched_order_id = v_open WHERE id = v_c_paid;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_confirmation_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: re-pointing a confirmation gave %', v_hint;
    END IF;
    BEGIN
      UPDATE public.pos_payment_confirmations SET amount = 25 WHERE id = v_c_open;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_confirmation_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: changing a confirmation''s amount gave %', v_hint;
    END IF;
    -- (c3b) nor changed in the same write that marks it used.
    BEGIN
      UPDATE public.pos_payment_confirmations SET consumed_at = now(), amount = 25, provider = 'FonePay' WHERE id = v_c_paid;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_confirmation_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: changing a confirmation while marking it used gave %', v_hint;
    END IF;
    -- (c4) a confirmation is not used up while its bill is still open.
    BEGIN
      UPDATE public.pos_payment_confirmations SET consumed_at = now() WHERE id = v_c_open;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_confirmation_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: using a confirmation on an open bill gave %', v_hint;
    END IF;
    -- (c5) the till's own write after the close: allowed, at the server's time.
    UPDATE public.pos_payment_confirmations SET consumed_at = '2000-01-01T00:00:00Z' WHERE id = v_c_paid
      RETURNING consumed_at INTO v_ts;
    IF NOT FOUND OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 1k probe: the till''s consume stored % (found %)', v_ts, FOUND;
    END IF;
    -- (c6) once.
    BEGIN
      UPDATE public.pos_payment_confirmations SET consumed_at = now() WHERE id = v_c_paid;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_confirmation_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: using a confirmation twice gave %', v_hint;
    END IF;
    -- (c7) the poll's read still finds the open bill's confirmation.
    SELECT count(*) INTO v_n FROM public.pos_payment_confirmations
     WHERE matched_order_id = v_open AND consumed_at IS NULL;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1k probe: the QR poll''s read found % row(s), expected 1', v_n;
    END IF;
    -- (c8) no browser insert or delete (grants), whatever the guard says.
    BEGIN
      DELETE FROM public.pos_payment_confirmations WHERE id = v_c_open;
      v_state := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      RAISE EXCEPTION 'S809 1k probe: a browser delete of a confirmation gave %', v_state;
    END IF;
    BEGIN
      INSERT INTO public.pos_payment_confirmations (client_id, provider, amount, txn_ref, matched_order_id)
        VALUES (v_cl, 'eSewa', 1850, 'S809-1k-forged', v_open);
      v_state := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '42501' THEN
      RAISE EXCEPTION 'S809 1k probe: a browser insert of a confirmation gave %', v_state;
    END IF;

    -- ── As a POS login at Staff rank ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pos, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.pos_caller_has_rank('staff'), false)
       OR COALESCE(public.pos_caller_has_rank('supervisor'), false) THEN
      RAISE EXCEPTION 'S809 1k probe: the stand-in % is not a Staff-rank POS login', v_pos;
    END IF;
    -- (s1) cannot issue.
    BEGIN
      INSERT INTO public.pos_parking_slips (client_id, vehicle_number) VALUES (v_cl, 'S809 PROBE STAFF');
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_parking_slip_rank' THEN
      RAISE EXCEPTION 'S809 1k probe: a Staff-rank issue gave %', v_hint;
    END IF;
    -- (s2) can mark a vehicle exited, under its own name whatever it sends.
    UPDATE public.pos_parking_slips SET status = 'closed', time_out = now(), exited_by = v_owner
     WHERE id = v_s2 RETURNING exited_by INTO v_by;
    IF v_by IS DISTINCT FROM v_pos THEN
      RAISE EXCEPTION 'S809 1k probe: a Staff-rank Mark Exited stored exited_by %', v_by;
    END IF;
    -- (s3) can reprint.
    UPDATE public.pos_parking_slips SET print_count = 0 WHERE id = v_s1 RETURNING print_count INTO v_n;
    IF v_n IS DISTINCT FROM 4 THEN
      RAISE EXCEPTION 'S809 1k probe: a Staff-rank reprint stored % (expected 4)', v_n;
    END IF;

    -- ── As the operator ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 1k probe: % is not the operator', v_admin;
    END IF;
    -- (a1) a restore re-inserts a slip exactly as it was.
    INSERT INTO public.pos_parking_slips (client_id, slip_no, vehicle_number, time_in, created_at, issued_by,
                                          print_count, status, time_out, exited_by, auto_closed)
      VALUES (v_cl, v_max + 100, 'S809 PROBE RESTORE', now() - interval '10 days', now() - interval '10 days', v_other,
              3, 'closed', now() - interval '9 days', v_other, false)
      RETURNING * INTO r;
    IF r.slip_no IS DISTINCT FROM v_max + 100 OR r.issued_by IS DISTINCT FROM v_other
       OR r.time_in IS DISTINCT FROM now() - interval '10 days' OR r.print_count IS DISTINCT FROM 3
       OR r.status IS DISTINCT FROM 'closed' OR r.exited_by IS DISTINCT FROM v_other THEN
      RAISE EXCEPTION 'S809 1k probe: the operator''s restore insert was rewritten: %', row_to_json(r);
    END IF;
    v_sa := r.id;
    -- (a2) a second slip with the same number at the same outlet is refused by the index.
    BEGIN
      INSERT INTO public.pos_parking_slips (client_id, slip_no, vehicle_number) VALUES (v_cl, v_max + 100, 'S809 PROBE DUP');
      v_state := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23505' THEN
      RAISE EXCEPTION 'S809 1k probe: a duplicate slip number gave %', v_state;
    END IF;
    -- (a3) outside a restore the operator meets the same rules on an issued slip and on a
    -- confirmation (Q26 a).
    BEGIN
      UPDATE public.pos_parking_slips SET vehicle_number = 'OPERATOR REWRITE' WHERE id = v_sa;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_parking_slip_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: the operator rewriting a slip gave %', v_hint;
    END IF;
    BEGIN
      UPDATE public.pos_payment_confirmations SET consumed_at = NULL WHERE id = v_c_used;
      v_hint := '(accepted)';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_payment_confirmation_locked' THEN
      RAISE EXCEPTION 'S809 1k probe: the operator reviving a confirmation gave %', v_hint;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1k_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1k_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT tgrelid::regclass, tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid IN ('public.pos_parking_slips'::regclass, 'public.pos_payment_confirmations'::regclass)
--      AND NOT tgisinternal ORDER BY 1, 2;
--   SELECT indexrelid::regclass, indisunique, indkey FROM pg_index WHERE indrelid = 'public.pos_parking_slips'::regclass;
--   SELECT attnotnull FROM pg_attribute WHERE attrelid = 'public.pos_parking_slips'::regclass AND attname = 'slip_no';
--   SELECT proname, md5(prosrc), proacl FROM pg_proc
--    WHERE proname IN ('pos_parking_slips_guard', 'pos_payment_confirmations_guard', 'assign_pos_parking_slip_no');
--   SELECT client_id, count(*), count(DISTINCT slip_no), min(slip_no), max(slip_no) FROM pos_parking_slips GROUP BY 1;
