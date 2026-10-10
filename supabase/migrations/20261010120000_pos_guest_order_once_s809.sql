-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3b: a guest's QR order lands once, is answered once, and its tracker reads
-- the food.
--
--   GUEST-2 (P2). When the reply to a guest's Place Order was lost on bad Wi-Fi, the phone kept the
--   cart and had no way to know the order had landed. Its retry was a new request: refused while the
--   first still waited ("already has an order waiting", with no tracker for the first), and taken as a
--   second round once staff had accepted the first, so the kitchen made everything twice.
--   submit_guest_order takes a fifth argument, p_request_id: a key the guest page makes once per
--   order and sends again with every retry of it. The request is stored under that key, and a key
--   that already landed for this table answers with that same request (status and all) instead of
--   storing another. A key that belongs to another table is refused (HINT request_key_conflict). The
--   argument defaults to NULL, which keeps the old behaviour exactly, so a guest page opened before
--   this release (it sends four arguments) reaches this body through the default and sees no change.
--   The four-argument form is dropped (no public function keeps a second overload: supabase-sql.md).
--
--   GUEST-3 (P2, the server half of ORDER-FLOW-11). Any login of the outlet could rewrite a guest
--   order: a turned-away order could later be marked accepted (the guest's phone kept saying "Staff
--   couldn't take this order" while the food came, and "Put it back in my order" sent it again), and
--   an accepted one could be turned away. New BEFORE UPDATE trigger guard_pos_guest_order_request:
--     * what the guest sent never changes: items, table, outlet, covers, note, sent time, id
--       (an allow-list: only status, order_id, decided_at and decided_by are a till's to write, so a
--       column added later is frozen by default) — HINT pos_guest_order_frozen;
--     * a waiting order is answered once, accepted or turned away, and that answer stands: a decided
--       order's status never changes again, and its bill is never moved — HINT pos_guest_order_decided.
--       One exception: an accepted order with no bill recorded (an accept written before S767) may
--       have its bill filled in once;
--     * who answered and when are the server's: decided_by := the signed-in login, decided_at := now();
--       a turned-away order goes onto no bill;
--     * the bill an accepted order goes onto is one of its own outlet's — HINT
--       pos_guest_order_other_outlet (the guest's tracker reads that bill's kitchen tickets).
--     Every client session is held to it, the operator's included: no screen rewrites an answer, a
--     restore never writes this table (RESTORE_LEFT_OUT), and an operator running a till races another
--     till exactly as a waiter does. The service role (admin-user-ops' clears), SECURITY DEFINER bodies
--     and a foreign key's own ON DELETE SET NULL (run as the table owner, so Clear Occupied of a bill
--     holding an accepted guest order still works) pass through the current_user seam.
--
--   GUEST-5 (P3, pulled forward). A paid choice (a Large size, an extra, a "no onion") sent for a dish
--   whose last choices were switched off while the guest's menu was open was dropped: the dish was
--   stored plain at its base price while the guest's tracker named the choice. It is now refused like
--   a choice taken off a dish that still has others (HINT unavailable_options): the page re-reads the
--   menu, takes the dish off the order and says so.
--
--   S809.4 (found in slice 3a) + slice 3d. get_guest_order_progress and get_guest_table_status counted
--   a CHANGE ticket (a pos_kot_log row whose lines are {qty: 0, change: true}, slice 3a) until the
--   kitchen pressed Seen, so a guest's tracker could sit below "Ready" and a table's badge read
--   "with the kitchen" meanwhile. Both now leave change tickets out. get_guest_table_status also
--   ranked a CANCELLED ticket as "new"; slice 3d lets the kitchen clear a ticket whose every dish was
--   taken off while the order stays open, so it now leaves cancelled tickets out too, as
--   get_guest_order_progress already did (confirmed against its live body).
--
-- Built on the LIVE bodies (pg_get_functiondef, md5(prosrc), read 2026-10-10 with master at
-- bf7f58f8, after slices 3a, 3i and 3k went live). Section 0 refuses to run over any other body.
-- Every change inside them is a block marked "S809 3b".
--   submit_guest_order(uuid,jsonb,text,integer)   a6b716a7c7a1b485dcfef8605b5182f7  (dropped here)
--   get_guest_order_progress(uuid)                d1d71ef28bdc11d9e3fb27c60224a054
--   get_guest_table_status(uuid)                  f5cbe654b1c6d44a80ce75bdfc4c459c
-- Live grants kept: submit_guest_order proacl {=X/postgres,postgres=X/postgres,anon=X/postgres,
-- authenticated=X/postgres,service_role=X/postgres} (re-granted on the new signature, which keeps
-- PUBLIC's default EXECUTE: guest ordering is anon by design); get_guest_order_progress and
-- get_guest_table_status keep proacl NULL (CREATE OR REPLACE keeps it). All three stay SECURITY
-- DEFINER with search_path public, owner postgres, no comment, nothing depending on them.
-- New: guard_pos_guest_order_request() (SECURITY INVOKER trigger function, no client grant) and its
-- trigger. pos_min_till_build() is NOT raised (see the slice report): nothing here changes what a till
-- writes to pos_orders or pos_order_items, the only tables the floor gates, and x-crest-build has not
-- been proven to reach request.headers from a browser. Not touched: guard_pos_kot_log and every other
-- trigger on pos_kot_log (slice 3d), save_pos_order_items, the Inventory posting objects (slice 3j).
--
-- Live before this migration (2026-10-10):
--   * pos_guest_order_requests: 0 rows (BLOOM CAFE's guest orders went with the owner's clear), so the
--     guard rejects nothing that exists; it only judges later updates. Policies: SELECT and UPDATE
--     (admin or my_client_id), the three RESTRICTIVE staff families; no INSERT or DELETE policy;
--     authenticated holds SELECT and UPDATE (and MAINTAIN), anon MAINTAIN only. No trigger but the
--     foreign keys' (order_id and decided_by are ON DELETE SET NULL).
--   * pos_kot_log: 0 change tickets; 12 cancelled tickets, all on voided bills; 4 tickets on open
--     orders, all served. So no tracker or badge reads differently at the apply moment.
--   * BLOOM CAFE and BLOOM CAFE - PKR: POS on, Customization on, access open.
--
-- Ship order: this migration BEFORE the app (either order works: the new guest page falls back to the
-- four-argument call on PGRST202, and the new till's conditional writes need nothing new). A till on
-- crest-v425 or older is refused nothing in normal service: Accept writes pending → accepted once, at
-- the next save, and Dismiss writes pending → dismissed. It is refused only a SECOND answer to the same
-- guest order (another till's, or its own after the banner came back), which is the point; its
-- Dismiss then reads "Could not dismiss that guest order — try again" and the order leaves its banner
-- at the next poll, because it is no longer waiting.
--
-- The probe at the end runs as a guest (anon), as two POS PIN logins of BLOOM CAFE and as the operator,
-- inside a block that rolls itself back. If any check fails, the whole migration fails and nothing lands.
-- Drafted against a local Postgres 17 replica of the live tables, policies, grants, triggers and every
-- public function (catalog read 2026-10-10): the file runs clean, and again over itself; each of 17
-- one-line reversals of a fix fails the probe; two sessions sending one key at the same moment store
-- one order and both get its id; and slices 3d and 3j's drafts apply after it (and 3d's before it).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces are the ones it was built on ─────────────────
-- The second hash of each pair is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
  v_n   int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'submit_guest_order';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3b: % functions are named submit_guest_order (want exactly 1) — drop the stray overload by hand first', v_n;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.submit_guest_order(uuid,jsonb,text,integer)');
  IF v_md5 IS NULL THEN
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.submit_guest_order(uuid,jsonb,text,integer,uuid)');
    IF v_md5 IS DISTINCT FROM 'b4312146f6c5da5e01f3d51c9fe99936' THEN
      RAISE EXCEPTION 'S809 3b: submit_guest_order has neither the live four-argument body nor this slice''s five-argument one (md5 %) — merge section 1 onto the live body and update section 0', v_md5;
    END IF;
  ELSIF v_md5 <> 'a6b716a7c7a1b485dcfef8605b5182f7' THEN
    RAISE EXCEPTION 'S809 3b: submit_guest_order changed since this slice was drafted (live md5 %) — merge section 1 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_guest_order_progress(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'd1d71ef28bdc11d9e3fb27c60224a054' AND v_md5 IS DISTINCT FROM 'da520833ee99b22acf79366b1372361e' THEN
    RAISE EXCEPTION 'S809 3b: get_guest_order_progress changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_guest_table_status(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'f5cbe654b1c6d44a80ce75bdfc4c459c' AND v_md5 IS DISTINCT FROM '064b3093cc561c430feb3040c5e229ad' THEN
    RAISE EXCEPTION 'S809 3b: get_guest_table_status changed since this slice was drafted (live md5 %) — merge section 4 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  -- The guard is new; on a re-run it is this slice's.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.guard_pos_guest_order_request()');
  IF v_md5 IS NOT NULL AND v_md5 <> '78258b26afcc9b7df24374505bf0abb9' THEN
    RAISE EXCEPTION 'S809 3b: a different guard_pos_guest_order_request() already exists (md5 %)', v_md5;
  END IF;
  -- Reported, not refused: the guard judges updates only, so rows already stored are never rejected.
  SELECT count(*) INTO v_n FROM public.pos_guest_order_requests;
  RAISE NOTICE 'S809 3b: % guest order requests on record at apply', v_n;
END;
$$;


-- ── 1. submit_guest_order: one order per key (GUEST-2), no dropped choice (GUEST-5) ─────────────
-- DROP first: a fifth parameter on CREATE OR REPLACE forks the function (supabase-sql.md, S630), and
-- the four-argument body would then miss every later fix. The whole file is one transaction, so no
-- caller ever finds the name missing. PostgREST calls by named argument, so a guest page from before
-- this release (four keys) resolves to the new body through p_request_id's default.
DROP FUNCTION IF EXISTS public.submit_guest_order(uuid, jsonb, text, integer);

CREATE OR REPLACE FUNCTION public.submit_guest_order(p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text, p_covers integer DEFAULT 1, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_table_status text;
  v_pos_enabled boolean;
  v_cust boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  v_unavailable text[] := '{}';
  v_bad_options text[] := '{}';
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
  v_opt_ids uuid[];
  v_has_groups boolean;
  v_sel jsonb;
  v_key_table uuid;
BEGIN
  SELECT t.client_id, t.status INTO v_client_id, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Table not found' USING HINT = 'table_not_found';
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  -- S809 (GUEST-4): a locked outlet refuses with POS switched off's own message and code, so the
  -- guest's page reads it the same way (guestOrderRefusal 'not_accepting', then the menu re-reads
  -- as empty) and the refusal says nothing about the outlet's account. Before the inactive-table
  -- test, because POS switched off is refused before it too.
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  -- S809 3b (GUEST-2): the guest page sends one key per order, and the same key with every retry of
  -- it. A key that already landed for this table is that order: it is answered with that request
  -- whatever the retry carries (accepted, turned away or still waiting, the guest's tracker reads it),
  -- and nothing is stored twice. Answered before the menu checks, because those checks judge a new
  -- order, and this one was sent already. A key of another table's order is refused, and the page
  -- makes a new key.
  IF p_request_id IS NOT NULL THEN
    SELECT q.table_id INTO v_key_table FROM pos_guest_order_requests q WHERE q.id = p_request_id;
    IF FOUND THEN
      IF v_key_table IS DISTINCT FROM p_table_id THEN
        RAISE EXCEPTION 'This order key belongs to another table' USING HINT = 'request_key_conflict';
      END IF;
      RETURN p_request_id;
    END IF;
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

  v_cust := public.customization_live(v_client_id);

  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(recipe_id uuid, qty numeric, note text, options jsonb)
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

    -- S758: the picks, as uuids. Anything unreadable is a pick that does not exist.
    BEGIN
      SELECT COALESCE(array_agg(e::uuid), ARRAY[]::uuid[]) INTO v_opt_ids
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(item.options) = 'array' THEN item.options ELSE '[]'::jsonb END) e;
    EXCEPTION WHEN invalid_text_representation THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END;

    v_has_groups := v_cust AND EXISTS (
      SELECT 1 FROM pos_recipe_option_groups a JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
       WHERE a.recipe_id = r.id AND EXISTS (SELECT 1 FROM pos_options o WHERE o.group_id = g.id AND o.is_active));

    IF cardinality(v_opt_ids) > 0 AND NOT v_cust THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END IF;

    -- S809 3b (GUEST-5): choices sent for a dish that offers none any more (its last group or option
    -- was switched off after the guest's menu loaded) used to be dropped, and the dish went through
    -- plain at its base price while the guest's tracker named the choice. Refused like a choice taken
    -- off a dish that still has others: the page takes the dish off and asks for it again.
    IF cardinality(v_opt_ids) > 0 AND NOT v_has_groups THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END IF;

    IF v_has_groups THEN
      -- A customizable dish is always checked, picks or not: one that must have a size cannot
      -- arrive without one from a page that was loaded before the dish had choices.
      v_sel := public.pos_price_selection(v_client_id, r.id, v_opt_ids);
      IF v_sel->>'problem' IS NOT NULL THEN
        v_bad_options := v_bad_options || r.name;
        CONTINUE;
      END IF;
    ELSE
      v_sel := NULL;
    END IF;

    IF v_sel IS NOT NULL AND v_sel->>'selection_key' <> '' THEN
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price + (v_sel->>'delta')::numeric, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note,
        'base_unit_price', r.selling_price, 'options_delta', (v_sel->>'delta')::numeric,
        'selection_key', v_sel->>'selection_key', 'option_ids', v_sel->'option_ids',
        'option_summary', v_sel->>'summary', 'options', v_sel->'options'
      );
    ELSE
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note
      );
    END IF;
  END LOOP;

  IF cardinality(v_unavailable) > 0 THEN
    RAISE EXCEPTION 'Some items in this order are no longer available'
      USING HINT = 'unavailable_items',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_unavailable) u ORDER BY 1))::text;
  END IF;

  IF cardinality(v_bad_options) > 0 THEN
    RAISE EXCEPTION 'The choices on some dishes are no longer available'
      USING HINT = 'unavailable_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_bad_options) u ORDER BY 1))::text;
  END IF;

  IF jsonb_array_length(v_snapshot) = 0 THEN
    RAISE EXCEPTION 'No valid items in order' USING HINT = 'no_valid_items';
  END IF;

  -- S809 3b (GUEST-2): stored under the page's key (a new one when the page sent none). A retry that
  -- arrives while the first send is still being written waits for it here, then finds its own order.
  BEGIN
    INSERT INTO pos_guest_order_requests (id, client_id, table_id, items, guest_notes, covers)
    VALUES (
      COALESCE(p_request_id, gen_random_uuid()), v_client_id, p_table_id, v_snapshot,
      NULLIF(left(COALESCE(p_notes, ''), 500), ''),
      LEAST(GREATEST(COALESCE(p_covers, 1), 1), 50)
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This table already has an order request waiting for staff — please wait for it to be reviewed before sending another.'
      USING HINT = 'pending';
  END;

  IF v_request_id IS NULL THEN
    SELECT q.table_id INTO v_key_table FROM pos_guest_order_requests q WHERE q.id = p_request_id;
    IF v_key_table IS DISTINCT FROM p_table_id THEN
      RAISE EXCEPTION 'This order key belongs to another table' USING HINT = 'request_key_conflict';
    END IF;
    v_request_id := p_request_id;
  END IF;

  RETURN v_request_id;
END;
$function$;

-- As the live four-argument form was: PUBLIC (the default on a new function) plus the three named
-- roles. Guest ordering is anonymous by design; the function does its own authorisation.
GRANT EXECUTE ON FUNCTION public.submit_guest_order(uuid, jsonb, text, integer, uuid) TO anon, authenticated, service_role;


-- ── 2. A guest order is answered once (GUEST-3) ──────────────────────────────────────────────
-- SECURITY INVOKER with the current_user seam (the house shape, guard_profiles_privileged_columns):
-- the service role, DEFINER bodies and a foreign key's ON DELETE SET NULL (run as the table owner)
-- pass. Its two reads (the caller's profile, the bill's outlet) run under the caller's policies: a
-- till login sees its own profile and its own outlet's bills.
CREATE OR REPLACE FUNCTION public.guard_pos_guest_order_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- The columns a till may write on a guest's order: its answer and the bill it went onto.
  -- decided_at and decided_by are then written here, never taken from the tablet.
  c_answer CONSTANT text[] := ARRAY['status', 'order_id', 'decided_at', 'decided_by'];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  -- What the guest sent, where and when, stays as they sent it. An allow-list, so a column added
  -- later is frozen by default (invariant #1's reason).
  IF (to_jsonb(NEW) - c_answer) IS DISTINCT FROM (to_jsonb(OLD) - c_answer) THEN
    RAISE EXCEPTION 'pos_guest_order_frozen: a guest''s QR order cannot be changed once it is sent — what they ordered, for which table, and when stay as they sent it; staff only accept it or turn it away'
      USING ERRCODE = '42501', HINT = 'pos_guest_order_frozen';
  END IF;

  IF OLD.status IS DISTINCT FROM 'pending' THEN
    -- Answered already. The answer stands; only an accept recorded with no bill may have it filled once.
    IF NEW.status IS DISTINCT FROM OLD.status
       OR (NEW.order_id IS DISTINCT FROM OLD.order_id
           AND NOT (OLD.status = 'accepted' AND OLD.order_id IS NULL AND NEW.order_id IS NOT NULL)) THEN
      RAISE EXCEPTION 'pos_guest_order_decided: this guest QR order was already % — a guest order is accepted or turned away once, and that answer stands', OLD.status
        USING ERRCODE = '42501', HINT = 'pos_guest_order_decided';
    END IF;
    NEW.decided_at := OLD.decided_at;
    NEW.decided_by := OLD.decided_by;
  ELSIF NEW.status = 'pending' THEN
    -- Still waiting: nothing about an answer can be written yet.
    NEW.order_id   := OLD.order_id;
    NEW.decided_at := OLD.decided_at;
    NEW.decided_by := OLD.decided_by;
  ELSE
    -- The one answer (the CHECK keeps it accepted or dismissed). A turned-away order went onto no bill.
    IF NEW.status = 'dismissed' THEN
      NEW.order_id := NULL;
    END IF;
    NEW.decided_at := now();
    NEW.decided_by := (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid()));
  END IF;

  -- The bill a guest order goes onto is its own outlet's: the guest's tracker reads that bill's tickets.
  IF NEW.order_id IS DISTINCT FROM OLD.order_id AND NEW.order_id IS NOT NULL
     AND NOT COALESCE(EXISTS (SELECT 1 FROM pos_orders o WHERE o.id = NEW.order_id AND o.client_id = NEW.client_id), false) THEN
    RAISE EXCEPTION 'pos_guest_order_other_outlet: a guest QR order can only go onto a bill of its own outlet'
      USING ERRCODE = '23503', HINT = 'pos_guest_order_other_outlet';
  END IF;

  RETURN NEW;
END;
$function$;

-- A trigger function needs no grant: EXECUTE is checked when the trigger is created, not when it fires.
REVOKE ALL ON FUNCTION public.guard_pos_guest_order_request() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_pos_guest_order_request ON public.pos_guest_order_requests;
CREATE TRIGGER guard_pos_guest_order_request
  BEFORE UPDATE ON public.pos_guest_order_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_guest_order_request();


-- ── 3. get_guest_order_progress: a change ticket holds nothing back (S809.4) ─────────────────
CREATE OR REPLACE FUNCTION public.get_guest_order_progress(p_request_id uuid)
 RETURNS TABLE(status text, kot_status text, remaining_minutes integer, order_closed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.pos_guest_order_requests%ROWTYPE;
  v_pos_enabled boolean;
  v_order_id uuid;
  v_order_status text;
  v_recipe_ids text[];
  v_worst int;
  v_max_ready timestamptz;
  v_rank int;
  v_ready timestamptz;
  r RECORD;
BEGIN
  SELECT * INTO v_req FROM public.pos_guest_order_requests q WHERE q.id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- pos_enabled stays the first gate on every guest read (S632).
  SELECT c.pos_enabled INTO v_pos_enabled FROM public.clients c WHERE c.id = v_req.client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
  -- S809 (GUEST-4): and a locked outlet reads as POS switched off (no row: the page keeps what it had).
  IF NOT COALESCE(public.client_access_open(v_req.client_id), false) THEN RETURN; END IF;

  status := v_req.status;
  kot_status := NULL;
  remaining_minutes := NULL;
  order_closed := false;

  IF v_req.status IS DISTINCT FROM 'accepted' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_req.order_id IS NOT NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status FROM public.pos_orders o WHERE o.id = v_req.order_id;
  END IF;
  -- An accept written before S767, or by a till still on an older bundle, has no order_id. The
  -- bill that took it is the earliest one on this table that was still open when the guest sent
  -- the order — created_at is the SERVER's clock, unlike decided_at, which the tablet writes.
  IF v_order_id IS NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status
      FROM public.pos_orders o
     WHERE o.table_id = v_req.table_id
       AND (o.closed_at IS NULL OR o.closed_at >= v_req.created_at)
     ORDER BY o.opened_at ASC
     LIMIT 1;
  END IF;

  IF v_order_id IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  order_closed := v_order_status IS DISTINCT FROM 'open';

  SELECT COALESCE(array_agg(DISTINCT e->>'recipe_id'), '{}')
    INTO v_recipe_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_req.items) = 'array' THEN v_req.items ELSE '[]'::jsonb END) e
   WHERE e->>'recipe_id' IS NOT NULL;

  v_worst := NULL;
  v_max_ready := NULL;
  FOR r IN
    SELECT k.status AS kstatus, k.started_at, k.estimated_prep_minutes
      FROM public.pos_kot_log k
     WHERE k.order_id = v_order_id
       AND k.sent_at >= v_req.created_at
       AND k.status IS DISTINCT FROM 'cancelled'
       -- S809 3b (S809.4): a CHANGE ticket (slice 3a: every line {qty: 0, change: true}) tells the
       -- kitchen an instruction changed. No food waits on it, and it stays "new" until the kitchen
       -- presses Seen, so it held the guest's tracker below Ready meanwhile.
       AND NOT COALESCE(k.items @> '[{"change": true}]'::jsonb, false)
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(k.items) = 'array' THEN k.items ELSE '[]'::jsonb END) i
          WHERE i->>'recipe_id' = ANY (v_recipe_ids)
       )
  LOOP
    v_rank := CASE r.kstatus WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 2 ELSE 0 END;
    IF v_worst IS NULL OR v_rank < v_worst THEN v_worst := v_rank; END IF;
    IF r.kstatus = 'in_progress' AND r.started_at IS NOT NULL AND r.estimated_prep_minutes IS NOT NULL THEN
      v_ready := r.started_at + (r.estimated_prep_minutes * interval '1 minute');
      IF v_max_ready IS NULL OR v_ready > v_max_ready THEN v_max_ready := v_ready; END IF;
    END IF;
  END LOOP;

  kot_status := CASE v_worst WHEN 0 THEN 'new' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'ready' ELSE NULL END;
  remaining_minutes := CASE
    WHEN kot_status = 'in_progress' AND v_max_ready IS NOT NULL
      THEN CEIL(EXTRACT(EPOCH FROM (v_max_ready - now())) / 60)::integer
    ELSE NULL
  END;
  RETURN NEXT;
END;
$function$;


-- ── 4. get_guest_table_status: neither a change ticket nor a cleared one reads "Sent" ──────────
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

  -- S809 (GUEST-4): a locked outlet answers as POS switched off does.
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN
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
  -- S809 3b: a CHANGE ticket (S809.4: every line {qty: 0, change: true}, "new" until the kitchen
  -- presses Seen) and a cancelled one (slice 3d: the kitchen clears a ticket whose every dish was
  -- taken off, while the order stays open) have no food waiting on them. Both read as "new" here, so
  -- the table's badge sat at "with the kitchen" for the rest of the meal.
  FOR r IN SELECT status, started_at, estimated_prep_minutes FROM pos_kot_log
            WHERE order_id = v_order_id
              AND status IS DISTINCT FROM 'cancelled'
              AND NOT COALESCE(items @> '[{"change": true}]'::jsonb, false)
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


-- ── 5. Prove it ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c      uuid;    -- BLOOM CAFE
  v_c2     uuid;    -- BLOOM CAFE - PKR
  v_sup    uuid;    -- a POS PIN login of BLOOM CAFE: "Till 1"
  v_mgr    uuid;    -- another: "Till 2"
  v_admin  uuid;    -- the operator
  v_ta     uuid;    -- the probe's tables (BLOOM CAFE)
  v_tb     uuid;
  v_r1     uuid;    -- Momo, with one extra on offer
  v_r2     uuid;    -- Lassi, plain
  v_g      uuid;    -- Momo's extras group
  v_extra  uuid;    -- its one extra
  v_o      uuid;    -- an open bill on table A
  v_ot     uuid;    -- an open takeaway, deleted by a till (Clear Occupied)
  v_ot2    uuid;    -- another open takeaway
  v_ox     uuid;    -- a bill of the other outlet
  v_k1     uuid := gen_random_uuid();   -- the guest's order key on table A
  v_k2     uuid := gen_random_uuid();
  v_k3     uuid := gen_random_uuid();
  v_k4     uuid := gen_random_uuid();
  v_rb     uuid;    -- the order sent with no key (a guest page from before this release)
  v_id     uuid;
  v_n      int;
  v_status text;
  v_order  uuid;
  v_by     uuid;
  v_at     timestamptz;
  v_items  jsonb;
  v_hint   text;
  v_kot    text;
  v_mins   int;
  v_lassi  jsonb;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'submit_guest_order';
  IF v_n <> 1 OR to_regprocedure('public.submit_guest_order(uuid,jsonb,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'S809 3b: submit_guest_order must exist once, in its five-argument form only (% found)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid = to_regprocedure('public.submit_guest_order(uuid,jsonb,text,integer,uuid)')
     AND prosecdef AND provolatile = 'v' AND pronargs = 5 AND pronargdefaults = 3
     AND proconfig @> ARRAY['search_path=public'] AND prorettype = 'uuid'::regtype;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3b: submit_guest_order(…, p_request_id) is not SECURITY DEFINER / volatile / three defaults / search_path public / returning uuid';
  END IF;
  IF NOT has_function_privilege('anon', 'public.submit_guest_order(uuid,jsonb,text,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.submit_guest_order(uuid,jsonb,text,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.submit_guest_order(uuid,jsonb,text,integer,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_guest_order_progress(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.get_guest_table_status(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_pos_guest_order_request()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_pos_guest_order_request()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 3b: EXECUTE grants on the guest functions are not as expected';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE (oid IN ('public.get_guest_order_progress(uuid)'::regprocedure, 'public.get_guest_table_status(uuid)'::regprocedure)
          AND prosecdef AND provolatile = 's')
      OR (oid = 'public.guard_pos_guest_order_request()'::regprocedure AND NOT prosecdef);
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 3b: a guest function changed its SECURITY mode or volatility (% of 3 as expected)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.pos_guest_order_requests'::regclass AND NOT tgisinternal AND tgenabled = 'O'
     AND tgname = 'guard_pos_guest_order_request' AND tgfoid = 'public.guard_pos_guest_order_request()'::regprocedure
     AND tgtype = 19;   -- ROW (1) + BEFORE (2) + UPDATE (16)
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3b: the BEFORE UPDATE row trigger on pos_guest_order_requests is missing or not as built';
  END IF;

  -- ── The outlets and logins ─────────────────────────────────────────────────────────────────
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
    RAISE EXCEPTION 'S809 3b probe: needs BLOOM CAFE, BLOOM CAFE - PKR, two POS PIN logins of BLOOM CAFE and the operator (got %, %, %, %, %)',
      v_c, v_c2, v_sup, v_mgr, v_admin;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    UPDATE public.clients SET pos_enabled = true, customization_enabled = true WHERE id = v_c;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_c, 'S809 3b probe A', 'available') RETURNING id INTO v_ta;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_c, 'S809 3b probe B', 'available') RETURNING id INTO v_tb;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_c, 'S809 3b Momo', 'Food', 300, 0, true, true) RETURNING id INTO v_r1;
    INSERT INTO public.recipes (client_id, name, category, selling_price, vat_rate, is_active, pos_enabled)
      VALUES (v_c, 'S809 3b Lassi', 'Beverage', 180, 0, true, true) RETURNING id INTO v_r2;
    INSERT INTO public.pos_option_groups (client_id, name, kind, min_select, max_select)
      VALUES (v_c, 'S809 3b Extras', 'addon', 0, NULL) RETURNING id INTO v_g;
    INSERT INTO public.pos_options (client_id, group_id, name, price_delta)
      VALUES (v_c, v_g, 'Extra cheese', 100) RETURNING id INTO v_extra;
    INSERT INTO public.pos_recipe_option_groups (client_id, recipe_id, group_id) VALUES (v_c, v_r1, v_g);
    -- order_no is given, so the probe takes no lock on the outlets' real series.
    INSERT INTO public.pos_orders (client_id, table_id, table_name, status, order_no)
      VALUES (v_c, v_ta, 'S809 3b probe A', 'open', 990901) RETURNING id INTO v_o;
    INSERT INTO public.pos_orders (client_id, table_name, status, order_no)
      VALUES (v_c, 'S809 3b probe takeaway', 'open', 990902) RETURNING id INTO v_ot;
    INSERT INTO public.pos_orders (client_id, table_name, status, order_no)
      VALUES (v_c, 'S809 3b probe takeaway 2', 'open', 990903) RETURNING id INTO v_ot2;
    INSERT INTO public.pos_orders (client_id, table_name, status, order_no)
      VALUES (v_c2, 'S809 3b probe other outlet', 'open', 990904) RETURNING id INTO v_ox;
    v_lassi := jsonb_build_array(jsonb_build_object('recipe_id', v_r2, 'qty', 2));

    -- ── GUEST-2, as a guest ────────────────────────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    -- (a) An order sent with a key is stored under it.
    v_id := public.submit_guest_order(v_ta, v_lassi, 'No ice', 3, v_k1);
    IF v_id IS DISTINCT FROM v_k1 THEN
      RAISE EXCEPTION 'S809 3b probe: an order sent with key % came back as %', v_k1, v_id;
    END IF;
    -- (b) Sent again (the reply was lost), it is the same order.
    v_id := public.submit_guest_order(v_ta, v_lassi, 'No ice', 3, v_k1);
    IF v_id IS DISTINCT FROM v_k1 THEN
      RAISE EXCEPTION 'S809 3b probe: the resend of key % came back as %', v_k1, v_id;
    END IF;
    -- (c) A resend carrying a changed cart is still answered with the order that landed.
    v_id := public.submit_guest_order(v_ta, v_lassi || jsonb_build_array(jsonb_build_object('recipe_id', v_r1, 'qty', 1)), NULL, 3, v_k1);
    IF v_id IS DISTINCT FROM v_k1 THEN
      RAISE EXCEPTION 'S809 3b probe: a changed resend of key % came back as %', v_k1, v_id;
    END IF;
    -- (d) A different order while the first waits is refused as before.
    BEGIN
      v_id := public.submit_guest_order(v_ta, v_lassi, NULL, 2, v_k2);
      RAISE EXCEPTION 'S809 3b probe: a second waiting order on one table was accepted';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pending' THEN RAISE; END IF;
    END;
    -- (e) Table A's key sent from table B is refused.
    BEGIN
      v_id := public.submit_guest_order(v_tb, v_lassi, NULL, 2, v_k1);
      RAISE EXCEPTION 'S809 3b probe: table A''s order key was accepted for table B';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'request_key_conflict' THEN RAISE; END IF;
    END;
    -- (f) A guest page from before this release sends four arguments, by name, and is served as before.
    v_rb := public.submit_guest_order(p_table_id => v_tb, p_items => v_lassi, p_notes => NULL, p_covers => 4);
    IF v_rb IS NULL OR v_rb IN (v_k1, v_k2) THEN
      RAISE EXCEPTION 'S809 3b probe: the four-argument call returned %', v_rb;
    END IF;
    -- (g) GUEST-5: Momo with extra cheese is fine while the extra is offered ...
    BEGIN
      v_id := public.submit_guest_order(v_ta, jsonb_build_array(jsonb_build_object('recipe_id', v_r1, 'qty', 1, 'options', jsonb_build_array(v_extra))), NULL, 2, v_k3);
      RAISE EXCEPTION 'S809 3b probe: table A took a second waiting order';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      -- the dish passes every menu check and reaches the one-waiting-order rule
      IF v_hint IS DISTINCT FROM 'pending' THEN RAISE; END IF;
    END;
    RESET ROLE;
    UPDATE public.pos_options SET is_active = false WHERE id = v_extra;   -- the manager switches the extra off
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    -- ... and refused, not stored plain, once the dish offers no choice at all. (Before this fix the
    -- dish went through plain and reached the one-waiting-order rule: 'pending'.)
    BEGIN
      v_id := public.submit_guest_order(v_ta, jsonb_build_array(jsonb_build_object('recipe_id', v_r1, 'qty', 1, 'options', jsonb_build_array(v_extra))), NULL, 2, v_k3);
      RAISE EXCEPTION 'S809 3b probe: Momo with extra cheese was accepted after its last extra was switched off';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'unavailable_options' THEN RAISE; END IF;
    END;
    RESET ROLE;
    -- (h) An order that landed is answered as landed even when its dish has left the menu since: the
    -- resend is not a new order, so it is not judged as one.
    UPDATE public.recipes SET pos_enabled = false WHERE id = v_r2;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    v_id := public.submit_guest_order(v_ta, v_lassi, 'No ice', 3, v_k1);
    IF v_id IS DISTINCT FROM v_k1 THEN
      RAISE EXCEPTION 'S809 3b probe: the resend of a landed order came back as % once its dish left the menu', v_id;
    END IF;
    RESET ROLE;
    UPDATE public.recipes SET pos_enabled = true WHERE id = v_r2;

    SELECT count(*) INTO v_n FROM public.pos_guest_order_requests WHERE table_id = v_ta;
    SELECT items, covers INTO v_items, v_mins FROM public.pos_guest_order_requests WHERE id = v_k1;
    IF v_n <> 1 OR jsonb_array_length(v_items) <> 1 OR (v_items -> 0 ->> 'recipe_id')::uuid IS DISTINCT FROM v_r2 OR v_mins <> 3 THEN
      RAISE EXCEPTION 'S809 3b probe: table A holds % requests and key % holds % (covers %) — want one, the two lassis as first sent', v_n, v_k1, v_items, v_mins;
    END IF;
    SELECT covers INTO v_mins FROM public.pos_guest_order_requests WHERE id = v_rb AND table_id = v_tb AND status = 'pending';
    IF v_mins IS DISTINCT FROM 4 THEN
      RAISE EXCEPTION 'S809 3b probe: the four-argument order was not stored as sent (covers %)', v_mins;
    END IF;

    -- ── GUEST-3, as two tills of BLOOM CAFE ──────────────────────────────────────────────────
    -- Till 1 accepts key 1 onto table A's bill, the way the new till writes it (only while waiting).
    -- decided_by and decided_at are the server's, whatever the tablet sends.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.pos_guest_order_requests
       SET status = 'accepted', order_id = v_o, decided_by = v_mgr, decided_at = '2001-01-01'
     WHERE id = v_k1 AND status = 'pending';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    SELECT status, order_id, decided_by, decided_at INTO v_status, v_order, v_by, v_at FROM public.pos_guest_order_requests WHERE id = v_k1;
    IF v_n <> 1 OR v_status <> 'accepted' OR v_order IS DISTINCT FROM v_o OR v_by IS DISTINCT FROM v_sup OR v_at < now() - interval '1 minute' THEN
      RAISE EXCEPTION 'S809 3b probe: Till 1''s accept wrote % row(s): %, bill %, by %, at %', v_n, v_status, v_order, v_by, v_at;
    END IF;

    -- Till 2, still showing the banner, turns it away: the new till's conditional write matches nothing ...
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    UPDATE public.pos_guest_order_requests SET status = 'dismissed' WHERE id = v_k1 AND status = 'pending';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3b probe: Till 2''s conditional dismiss matched an accepted order';
    END IF;
    -- ... and an older till's plain write is refused.
    BEGIN
      UPDATE public.pos_guest_order_requests SET status = 'dismissed' WHERE id = v_k1;
      RAISE EXCEPTION 'S809 3b probe: an accepted guest order was turned away afterwards';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_decided' THEN RAISE; END IF;
    END;
    -- Accepting it again onto another bill is refused; repeating the same accept changes nothing.
    BEGIN
      UPDATE public.pos_guest_order_requests SET status = 'accepted', order_id = v_ot2 WHERE id = v_k1;
      RAISE EXCEPTION 'S809 3b probe: an accepted guest order was moved to another bill';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_decided' THEN RAISE; END IF;
    END;
    UPDATE public.pos_guest_order_requests SET status = 'accepted', order_id = v_o, decided_by = v_mgr WHERE id = v_k1;
    SELECT decided_by INTO v_by FROM public.pos_guest_order_requests WHERE id = v_k1;
    IF v_by IS DISTINCT FROM v_sup THEN
      RAISE EXCEPTION 'S809 3b probe: repeating the accept re-attributed it to %', v_by;
    END IF;
    -- What the guest sent cannot be edited.
    BEGIN
      UPDATE public.pos_guest_order_requests SET items = '[]'::jsonb WHERE id = v_k1;
      RAISE EXCEPTION 'S809 3b probe: a guest order''s dishes were edited';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_frozen' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE public.pos_guest_order_requests SET covers = 9 WHERE id = v_rb;
      RAISE EXCEPTION 'S809 3b probe: a waiting guest order''s covers were edited';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_frozen' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE public.pos_guest_order_requests SET table_id = v_ta WHERE id = v_rb;
      RAISE EXCEPTION 'S809 3b probe: a waiting guest order was moved to another table';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_frozen' THEN RAISE; END IF;
    END;

    -- Till 2 turns the four-argument order away (it sends a bill too): stored with no bill, by Till 2.
    UPDATE public.pos_guest_order_requests SET status = 'dismissed', order_id = v_o, decided_by = v_sup
     WHERE id = v_rb AND status = 'pending';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    SELECT status, order_id, decided_by INTO v_status, v_order, v_by FROM public.pos_guest_order_requests WHERE id = v_rb;
    IF v_n <> 1 OR v_status <> 'dismissed' OR v_order IS NOT NULL OR v_by IS DISTINCT FROM v_mgr THEN
      RAISE EXCEPTION 'S809 3b probe: Till 2''s dismiss stored %, bill %, by %', v_status, v_order, v_by;
    END IF;
    -- Till 1 then saves the dishes it had accepted locally: the turned-away order stays turned away.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    BEGIN
      UPDATE public.pos_guest_order_requests SET status = 'accepted', order_id = v_o WHERE id = v_rb;
      RAISE EXCEPTION 'S809 3b probe: a turned-away guest order was accepted afterwards';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_decided' THEN RAISE; END IF;
    END;
    -- The operator is held to it too.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    BEGIN
      UPDATE public.pos_guest_order_requests SET status = 'pending' WHERE id = v_rb;
      RAISE EXCEPTION 'S809 3b probe: the operator reopened a turned-away guest order';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_decided' THEN RAISE; END IF;
    END;
    RESET ROLE;

    -- A new guest order on table B (its first was turned away, so the waiting slot is free).
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    v_id := public.submit_guest_order(v_tb, v_lassi, NULL, 2, v_k4);
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    -- While it waits, nothing about an answer can be written onto it.
    UPDATE public.pos_guest_order_requests SET order_id = v_o, decided_by = v_sup WHERE id = v_k4;
    SELECT status, order_id, decided_by INTO v_status, v_order, v_by FROM public.pos_guest_order_requests WHERE id = v_k4;
    IF v_status <> 'pending' OR v_order IS NOT NULL OR v_by IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3b probe: a waiting guest order took a bill or an author (%, %, %)', v_status, v_order, v_by;
    END IF;
    -- It cannot go onto another outlet's bill ...
    BEGIN
      UPDATE public.pos_guest_order_requests SET status = 'accepted', order_id = v_ox WHERE id = v_k4 AND status = 'pending';
      RAISE EXCEPTION 'S809 3b probe: a guest order was accepted onto another outlet''s bill';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_other_outlet' THEN RAISE; END IF;
    END;
    -- ... an accept with no bill may have its bill filled in once, and not moved after.
    UPDATE public.pos_guest_order_requests SET status = 'accepted' WHERE id = v_k4 AND status = 'pending';
    UPDATE public.pos_guest_order_requests SET order_id = v_ot WHERE id = v_k4;
    BEGIN
      UPDATE public.pos_guest_order_requests SET order_id = v_ot2 WHERE id = v_k4;
      RAISE EXCEPTION 'S809 3b probe: a guest order''s bill was moved after it was filled in';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_guest_order_decided' THEN RAISE; END IF;
    END;
    -- Clear Occupied: Till 1 deletes the takeaway holding it. The bill link empties through the
    -- foreign key's SET NULL, which the guard lets through.
    DELETE FROM public.pos_orders WHERE id = v_ot;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3b probe: Till 1 could not delete its open takeaway (% rows)', v_n;
    END IF;
    SELECT status, order_id INTO v_status, v_order FROM public.pos_guest_order_requests WHERE id = v_k4;
    IF v_status <> 'accepted' OR v_order IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3b probe: after Clear Occupied the guest order reads %, bill %', v_status, v_order;
    END IF;
    RESET ROLE;

    -- ── The tracker and the table badge (S809.4, slice 3d), as a guest ─────────────────────────
    -- Table A's bill: the lassis' ticket is ready; a CHANGE ticket for them is still "new" (nobody has
    -- pressed Seen); a ticket the kitchen cleared is cancelled.
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.pos_kot_log (client_id, order_id, order_no, table_name, station, items, status, ready_at)
      VALUES (v_c, v_o, 990901, 'S809 3b probe A', 'BOT', jsonb_build_array(jsonb_build_object('recipe_id', v_r2, 'name', 'S809 3b Lassi', 'qty', 2)), 'ready', now());
    INSERT INTO public.pos_kot_log (client_id, order_id, order_no, table_name, station, items, status)
      VALUES (v_c, v_o, 990901, 'S809 3b probe A', 'BOT', jsonb_build_array(jsonb_build_object('recipe_id', v_r2, 'name', 'S809 3b Lassi', 'qty', 0, 'change', true, 'notes', 'No ice')), 'new');
    INSERT INTO public.pos_kot_log (client_id, order_id, order_no, table_name, station, items, status)
      VALUES (v_c, v_o, 990901, 'S809 3b probe A', 'BOT', jsonb_build_array(jsonb_build_object('recipe_id', v_r2, 'name', 'S809 3b Lassi', 'qty', 1)), 'cancelled');
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    SELECT p.status, p.kot_status INTO v_status, v_kot FROM public.get_guest_order_progress(v_k1) p;
    IF v_status IS DISTINCT FROM 'accepted' OR v_kot IS DISTINCT FROM 'ready' THEN
      RAISE EXCEPTION 'S809 3b probe: the guest''s tracker reads % / % (want accepted / ready)', v_status, v_kot;
    END IF;
    SELECT t.kot_status INTO v_kot FROM public.get_guest_table_status(v_ta) t;
    IF v_kot IS DISTINCT FROM 'ready' THEN
      RAISE EXCEPTION 'S809 3b probe: table A''s badge reads % (want ready)', v_kot;
    END IF;
    RESET ROLE;
    -- Real food still counts: a started ticket moves both back to "being prepared".
    PERFORM set_config('request.jwt.claims', '', true);
    INSERT INTO public.pos_kot_log (client_id, order_id, order_no, table_name, station, items, status, started_at, estimated_prep_minutes)
      VALUES (v_c, v_o, 990901, 'S809 3b probe A', 'BOT', jsonb_build_array(jsonb_build_object('recipe_id', v_r2, 'name', 'S809 3b Lassi', 'qty', 1)), 'in_progress', now(), 10);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    SELECT p.kot_status, p.remaining_minutes INTO v_kot, v_mins FROM public.get_guest_order_progress(v_k1) p;
    IF v_kot IS DISTINCT FROM 'in_progress' OR v_mins IS NULL THEN
      RAISE EXCEPTION 'S809 3b probe: with a ticket started the tracker reads % (% min)', v_kot, v_mins;
    END IF;
    SELECT t.kot_status INTO v_kot FROM public.get_guest_table_status(v_ta) t;
    IF v_kot IS DISTINCT FROM 'in_progress' THEN
      RAISE EXCEPTION 'S809 3b probe: with a ticket started table A''s badge reads %', v_kot;
    END IF;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3b_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3b_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT oid::regprocedure::text, md5(prosrc), prosecdef, proacl::text FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('submit_guest_order', 'get_guest_order_progress', 'get_guest_table_status', 'guard_pos_guest_order_request');
--     expect submit_guest_order(uuid,jsonb,text,integer,uuid) b4312146f6c5da5e01f3d51c9fe99936, t,
--       {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres};
--     get_guest_order_progress(uuid) da520833ee99b22acf79366b1372361e, t, NULL; get_guest_table_status(uuid) 064b3093cc561c430feb3040c5e229ad, t, NULL;
--     guard_pos_guest_order_request() 78258b26afcc9b7df24374505bf0abb9, f, {postgres=X/postgres}. Exactly 4 rows (no second submit_guest_order).
--   SELECT tgname, tgenabled, pg_get_triggerdef(oid) FROM pg_trigger
--    WHERE tgrelid = 'public.pos_guest_order_requests'::regclass AND NOT tgisinternal;   -- guard_pos_guest_order_request, BEFORE UPDATE, O
--   SELECT has_function_privilege('anon', 'public.submit_guest_order(uuid,jsonb,text,integer,uuid)', 'EXECUTE');   -- t
--   SELECT status, count(*) FROM public.pos_guest_order_requests GROUP BY 1;   -- unchanged by the apply
