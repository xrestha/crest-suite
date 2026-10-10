-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3c: a till resting on the PIN screen announces a guest's QR order that is
-- waiting for Accept, asking through the tablet's own key.
--
--   FLOOR-KITCHEN-1 (P2, owner decision Q14 (1), 2026-10-09). The PIN screen is every PIN till's
--   resting state: three idle minutes and the till is back there, outside the app shell and its
--   repeating guest-order alert, with nobody signed in. A guest who scanned the QR code and ordered
--   then was heard nowhere: the Kitchen Display leaves guest orders to the floor by design, and the
--   till had no session to read pos_guest_order_requests with. The owner's answer: the locked till
--   announces it, checking through the tablet's own key.
--     * New: get_pos_device_guest_alerts(p_client_id, p_device_id, p_device_secret), SECURITY
--       DEFINER, STABLE, search_path public. The PIN screen's staff picker is its pattern
--       (get_pos_device_staff, read, not replaced): the same three arguments the tablet already
--       holds, the same key test by CALLING pos_device_key_valid (not replaced), and the same refusal
--       for an unknown, wrong or revoked key (pos_device_not_active, 28000, the same HINT), so the
--       PIN screen reads both answers one way. A key is good only for the outlet it was activated
--       for (pos_devices.client_id), so a tablet hears its own outlet and nothing else.
--     * What it returns is what the banner says and nothing more: per waiting guest order, the table's
--       name and when it was sent, oldest first, at most 50. No request id (it is the key to the
--       guest's own tracker), no dish, no note (a guest's note can be an allergy), no covers.
--     * Silent, not refused, where the outlet takes no guest orders: POS switched off, or the account
--       locked (client_access_open, the two gates submit_guest_order applies since S809 GUEST-4).
--       Guest ordering has no switch of its own (S746: it comes with POS; feature_flags.guest_ordering
--       grants nothing), so an outlet without QR codes simply has nothing waiting.
--     * It writes nothing. pos_devices.last_used_at stays the sign-in's (verify_pos_device): a poll
--       every 15 s is not a use, and stamping it would make Till Devices' "Last used" meaningless.
--     * EXECUTE: anon, authenticated and service_role, exactly as get_pos_device_staff (proacl
--       {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}); PUBLIC
--       revoked in this file, so the grant is the list and not Postgres's default. anon because the
--       PIN screen has no session; authenticated because a login left on the tablet is signed out by
--       that screen while it is already asking (S809 ACCESS-1).
--   Cost: one primary-key probe of pos_devices, one row of clients and the partial index
--   pos_guest_order_requests_pending_idx (client_id, table_id) WHERE status = 'pending'. The PIN
--   screen asks every 15 s, the cadence the signed-in shell already asks on; a tablet is one or the
--   other, never both, so the outlet's load does not change when its tills lock.
--   The key: 244 bits (register_pos_device), compared as its sha256. This adds no guessing surface
--   that get_pos_device_staff does not already have.
--
-- No live body is replaced. Called, not replaced (the probe tests the behaviour this file relies on):
--   pos_device_key_valid(uuid,uuid,text)   3b7392ac5f41e4cc8e8172f9fd7c7bc7  (INVOKER sql; EXECUTE postgres only)
--   pos_device_secret_hash(text)           4281cb07d7c95fd40beb6ac13dd4358f  (sha256 hex; EXECUTE postgres only)
--   client_access_open(uuid)               48291b6fa51cf5ff399da12cc9cdce01  (INVOKER sql; EXECUTE postgres only)
-- Read as the pattern, not replaced:
--   get_pos_device_staff(uuid,uuid,text)   8bec27d197fcc3cf7f02de4fbc64c263  (slice 3i's)
-- Not touched (owned by other slices): get_pos_device_staff, revoke_pos_device, register_pos_device,
-- verify_pos_device, list_pos_devices and every pos_device_* or session object, the pos-staff-login
-- Edge Function (slice 3h rebuilds the tablet sessions next); submit_guest_order,
-- get_guest_order_progress, get_guest_table_status, guard_pos_guest_order_request (3b);
-- save_pos_order_items (3e); get_group_summary (3n). No table, policy, trigger or grant on a table
-- changes. Should 3h replace pos_device_key_valid, this function follows it without a change.
--
-- Live before this migration (2026-10-10, after the Bloom demo seed):
--   * No function named get_pos_device_guest_alerts (or anything like %guest_alert%).
--   * pos_guest_order_requests: 0 rows at either POS outlet (BLOOM CAFE, BLOOM CAFE - PKR); 0 pending.
--   * pos_devices: 0 rows (BLOOM CAFE's one registered tablet went with the owner's clear), so no
--     tablet asks until a manager activates one; nothing stored is refused or reshaped.
--   * pos_devices and pos_guest_order_requests: RLS on, not forced, owner postgres (a DEFINER body
--     owned by postgres reads them whole and filters itself). pos_devices has no policy and no client
--     grant, so this function and its siblings are the only way a browser learns anything from it.
--   * Both POS outlets: pos_enabled, access open, Customization on.
--
-- Ship order: this migration BEFORE the app. A PIN screen on the new build that meets no function
-- (PGRST202) logs the failed poll and stays silent, keeping its last answer (nothing): no screen
-- breaks. A till on crest-v426 never calls it. Nothing an existing till does is refused.
--
-- The probe at the end runs as a guest's browser (anon) holding a tablet's key, as a BLOOM CAFE POS
-- PIN login (authenticated) and as the migration's own role, inside a block that rolls itself back.
-- Every row it reads it makes there: two BLOOM CAFE tablets (one revoked), one at BLOOM CAFE - PKR,
-- and guest orders at both outlets. If any check fails, the whole migration fails and nothing lands.
-- Drafted against a local Postgres 17 replica of the tables, live function bodies, grants and Supabase's
-- default function privileges it touches (catalog read 2026-10-10): the file runs clean as a first
-- create and again over itself, and each of 11 one-line reversals fails the probe (no key test, no
-- outlet filter, no waiting filter, no POS gate, no account gate, PUBLIC left holding EXECUTE, another
-- error code, SECURITY INVOKER, newest first, VOLATILE with a last_used_at stamp, anon not granted).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: what this file calls is there, and nothing already holds the name ───────────
DO $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_pos_device_guest_alerts'
     AND oid IS DISTINCT FROM to_regprocedure('public.get_pos_device_guest_alerts(uuid,uuid,text)');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 3c: get_pos_device_guest_alerts exists with another signature (% found) — drop it by hand first', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE (oid = to_regprocedure('public.pos_device_key_valid(uuid,uuid,text)') AND prorettype = 'boolean'::regtype)
      OR (oid = to_regprocedure('public.client_access_open(uuid)') AND prorettype = 'boolean'::regtype);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 3c: pos_device_key_valid(uuid,uuid,text) and client_access_open(uuid), both returning boolean, are required (% of 2 found)', v_n;
  END IF;
END;
$$;


-- ── 1. get_pos_device_guest_alerts: what the PIN screen announces ────────────────────────────
CREATE OR REPLACE FUNCTION public.get_pos_device_guest_alerts(p_client_id uuid, p_device_id uuid, p_device_secret text)
 RETURNS TABLE(table_name text, waiting_since timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_enabled boolean;
BEGIN
  -- S809 3c (FLOOR-KITCHEN-1, Q14): the tablet's own key, tested as the staff picker tests it
  -- (get_pos_device_staff), and refused the same way, so the PIN screen reads both answers alike.
  -- A key is good for the outlet it was activated for and no other.
  IF NOT COALESCE(public.pos_device_key_valid(p_client_id, p_device_id, p_device_secret), false) THEN
    RAISE EXCEPTION 'pos_device_not_active' USING ERRCODE = '28000',
      HINT = 'This till needs to be activated again by a manager.';
  END IF;

  -- An outlet that takes no guest orders has nothing to announce: POS switched off, or the account
  -- locked (the two gates submit_guest_order applies). Silence, not a refusal: the tablet is fine.
  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) OR NOT COALESCE(public.client_access_open(p_client_id), false) THEN
    RETURN;
  END IF;

  -- What the banner says, and nothing more: which table, and since when. No request id (the
  -- guest's tracker key), no dish, no note, no covers.
  RETURN QUERY
    SELECT t.name::text, q.created_at
      FROM pos_guest_order_requests q
      LEFT JOIN pos_tables t ON t.id = q.table_id AND t.client_id = q.client_id
     WHERE q.client_id = p_client_id
       AND q.status = 'pending'
     ORDER BY q.created_at, q.id
     LIMIT 50;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_pos_device_guest_alerts(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pos_device_guest_alerts(uuid, uuid, text) TO anon, authenticated, service_role;


-- ── 2. Catalog checks and the probe (rolls itself back) ──────────────────────────────────────
DO $$
DECLARE
  v_c      uuid;    -- BLOOM CAFE
  v_c2     uuid;    -- BLOOM CAFE - PKR, "another outlet"
  v_sup    uuid;    -- a BLOOM CAFE POS PIN login
  v_ta     uuid;
  v_tb     uuid;
  v_tc     uuid;
  v_tx     uuid;    -- a table at the other outlet
  v_dev    uuid;    -- BLOOM CAFE's live tablet
  v_dead   uuid;    -- BLOOM CAFE's revoked tablet
  v_dev2   uuid;    -- the other outlet's live tablet
  v_key    text := 'S809-3c-probe-key-' || replace(gen_random_uuid()::text, '-', '');
  v_key2   text := 'S809-3c-probe-key-' || replace(gen_random_uuid()::text, '-', '');
  v_keyd   text := 'S809-3c-probe-key-' || replace(gen_random_uuid()::text, '-', '');
  v_n      int;
  v_names  text;
  v_first  timestamptz;
  v_state  text;
  v_hint   text;
  v_used   timestamptz;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid = to_regprocedure('public.get_pos_device_guest_alerts(uuid,uuid,text)')
     AND prosecdef AND provolatile = 's' AND pronargs = 3 AND pronargdefaults = 0
     AND proconfig @> ARRAY['search_path=public'] AND proretset
     AND proowner = (SELECT oid FROM pg_roles WHERE rolname = 'postgres')
     AND proargnames = ARRAY['p_client_id', 'p_device_id', 'p_device_secret', 'table_name', 'waiting_since']
     AND proallargtypes = ARRAY['uuid'::regtype, 'uuid'::regtype, 'text'::regtype, 'text'::regtype, 'timestamptz'::regtype]::oid[];
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3c: get_pos_device_guest_alerts is not as built (DEFINER, STABLE, search_path public, owner postgres, three arguments, two columns)';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_pos_device_guest_alerts';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3c: % functions are named get_pos_device_guest_alerts (want exactly 1)', v_n;
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_pos_device_guest_alerts(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_pos_device_guest_alerts(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_pos_device_guest_alerts(uuid,uuid,text)', 'EXECUTE')
     -- The key test stays closed to the browser: only DEFINER bodies call it.
     OR has_function_privilege('anon', 'public.pos_device_key_valid(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_device_key_valid(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 3c: EXECUTE grants on get_pos_device_guest_alerts / pos_device_key_valid are not as expected';
  END IF;
  -- PUBLIC (grantee 0) holds nothing on it: the grant is the list above, not the default.
  SELECT count(*) INTO v_n
    FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = 'public.get_pos_device_guest_alerts(uuid,uuid,text)'::regprocedure AND a.grantee = 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 3c: PUBLIC still holds EXECUTE on get_pos_device_guest_alerts';
  END IF;

  -- ── The outlets and a login ──────────────────────────────────────────────────────────────────
  SELECT id INTO v_c  FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_c2 FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_sup
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
   LIMIT 1;
  IF v_c IS NULL OR v_c2 IS NULL OR v_sup IS NULL THEN
    RAISE EXCEPTION 'S809 3c probe: needs BLOOM CAFE, BLOOM CAFE - PKR and a POS PIN login of BLOOM CAFE (got %, %, %)', v_c, v_c2, v_sup;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);
    PERFORM set_config('request.jwt.claims', '', true);

    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    UPDATE public.clients SET pos_enabled = true, is_active = true WHERE id IN (v_c, v_c2);
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_c, 'S809 3c probe A', 'available') RETURNING id INTO v_ta;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_c, 'S809 3c probe B', 'available') RETURNING id INTO v_tb;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_c, 'S809 3c probe C', 'available') RETURNING id INTO v_tc;
    INSERT INTO public.pos_tables (client_id, name, status) VALUES (v_c2, 'S809 3c probe other outlet', 'available') RETURNING id INTO v_tx;
    INSERT INTO public.pos_devices (client_id, name, secret_hash)
      VALUES (v_c, 'S809 3c probe till', public.pos_device_secret_hash(v_key)) RETURNING id INTO v_dev;
    INSERT INTO public.pos_devices (client_id, name, secret_hash, revoked_at)
      VALUES (v_c, 'S809 3c probe revoked till', public.pos_device_secret_hash(v_keyd), now()) RETURNING id INTO v_dead;
    INSERT INTO public.pos_devices (client_id, name, secret_hash)
      VALUES (v_c2, 'S809 3c probe other till', public.pos_device_secret_hash(v_key2)) RETURNING id INTO v_dev2;
    -- Waiting: A (4 minutes) and B (1 minute). Answered: C accepted, A's earlier order dismissed.
    -- Waiting at the other outlet: one.
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items, guest_notes, covers, status, created_at)
    VALUES
      (v_c,  v_ta, '[{"name":"S809 3c Momo","qty":2}]'::jsonb, 'No peanuts, allergy', 2, 'pending',   now() - interval '4 minutes'),
      (v_c,  v_tb, '[{"name":"S809 3c Lassi","qty":1}]'::jsonb, NULL,                 1, 'pending',   now() - interval '1 minute'),
      (v_c,  v_tc, '[{"name":"S809 3c Momo","qty":1}]'::jsonb, NULL,                 1, 'accepted',  now() - interval '9 minutes'),
      (v_c,  v_ta, '[{"name":"S809 3c Momo","qty":1}]'::jsonb, NULL,                 1, 'dismissed', now() - interval '20 minutes'),
      (v_c2, v_tx, '[{"name":"S809 3c Momo","qty":1}]'::jsonb, NULL,                 1, 'pending',   now() - interval '2 minutes');

    -- ── As the PIN screen: anon, holding BLOOM CAFE's tablet key ────────────────────────────
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    -- (a) Its outlet's waiting orders, oldest first (in the order the function returns them): A then
    --     B. Not C (accepted), not A's dismissed one, nothing of the other outlet.
    SELECT count(*), string_agg(g.table_name, ',' ORDER BY g.ord), min(g.waiting_since)
      INTO v_n, v_names, v_first
      FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key) WITH ORDINALITY AS g(table_name, waiting_since, ord)
     WHERE g.table_name LIKE 'S809 3c probe%';
    IF v_n <> 2 OR v_names IS DISTINCT FROM 'S809 3c probe A,S809 3c probe B' THEN
      RAISE EXCEPTION 'S809 3c probe: the PIN screen heard % (%), want S809 3c probe A,S809 3c probe B', v_n, v_names;
    END IF;
    IF v_first > now() - interval '3 minutes' OR v_first < now() - interval '5 minutes' THEN
      RAISE EXCEPTION 'S809 3c probe: the oldest waiting order reads % (want about 4 minutes ago)', v_first;
    END IF;
    SELECT count(*) INTO v_n FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key) g
     WHERE g.table_name = 'S809 3c probe other outlet' OR g.table_name = 'S809 3c probe C';
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3c probe: the PIN screen heard an answered order or another outlet''s (% rows)', v_n;
    END IF;
    -- (b) The other outlet's tablet hears its own outlet only.
    SELECT count(*), string_agg(g.table_name, ',') INTO v_n, v_names
      FROM public.get_pos_device_guest_alerts(v_c2, v_dev2, v_key2) g
     WHERE g.table_name LIKE 'S809 3c probe%';
    IF v_n <> 1 OR v_names IS DISTINCT FROM 'S809 3c probe other outlet' THEN
      RAISE EXCEPTION 'S809 3c probe: the other outlet''s tablet heard % (%)', v_n, v_names;
    END IF;
    -- (c) Every bad key is refused the way get_pos_device_staff refuses it: a wrong secret, a revoked
    --     tablet's own secret, a tablet's key offered for another outlet (both ways), a key of one
    --     tablet under another tablet's id, and nothing at all.
    FOR v_n IN 1..6 LOOP
      BEGIN
        CASE v_n
          WHEN 1 THEN PERFORM count(*) FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key || 'x');
          WHEN 2 THEN PERFORM count(*) FROM public.get_pos_device_guest_alerts(v_c, v_dead, v_keyd);
          WHEN 3 THEN PERFORM count(*) FROM public.get_pos_device_guest_alerts(v_c, v_dev2, v_key2);
          WHEN 4 THEN PERFORM count(*) FROM public.get_pos_device_guest_alerts(v_c2, v_dev, v_key);
          WHEN 5 THEN PERFORM count(*) FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key2);
          ELSE        PERFORM count(*) FROM public.get_pos_device_guest_alerts(NULL, NULL, NULL);
        END CASE;
        RAISE EXCEPTION 'S809 3c probe: bad key case % was answered', v_n;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_hint = PG_EXCEPTION_HINT;
        IF SQLERRM <> 'pos_device_not_active' OR v_state <> '28000'
           OR v_hint IS DISTINCT FROM 'This till needs to be activated again by a manager.' THEN
          RAISE EXCEPTION 'S809 3c probe: bad key case % failed with % / % / % (want pos_device_not_active, 28000)', v_n, SQLERRM, v_state, v_hint;
        END IF;
      END;
    END LOOP;
    -- (d) The browser still cannot read the table itself.
    BEGIN
      PERFORM count(*) FROM public.pos_guest_order_requests;
      RAISE EXCEPTION 'S809 3c probe: anon read pos_guest_order_requests directly';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- (e) A poll is not a use: Till Devices' "Last used" stays the sign-in's.
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT last_used_at INTO v_used FROM public.pos_devices WHERE id = v_dev;
    IF v_used IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3c probe: asking stamped the tablet''s last_used_at (%)', v_used;
    END IF;

    -- ── As a BLOOM CAFE POS PIN login, a session left on the tablet: the same answer ──────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key) g WHERE g.table_name LIKE 'S809 3c probe%';
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 3c probe: a signed-in login on the tablet heard % orders (want 2)', v_n;
    END IF;
    RESET ROLE;

    -- ── Silence where the outlet takes no guest orders ──────────────────────────────────────
    -- (f) Once accepted, an order is no longer announced.
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.pos_guest_order_requests SET status = 'accepted', decided_at = now()
     WHERE client_id = v_c AND table_id = v_tb AND status = 'pending';
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    SELECT count(*), string_agg(g.table_name, ',') INTO v_n, v_names
      FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key) g WHERE g.table_name LIKE 'S809 3c probe%';
    IF v_n <> 1 OR v_names IS DISTINCT FROM 'S809 3c probe A' THEN
      RAISE EXCEPTION 'S809 3c probe: after B was accepted the PIN screen heard % (%)', v_n, v_names;
    END IF;
    RESET ROLE;
    -- (g) POS switched off (Customization goes with it, clients_customization_requires_pos): nothing,
    --     and no error. The other outlet still hears its own.
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.clients SET pos_enabled = false WHERE id = v_c;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_n FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3c probe: with POS off the PIN screen heard % orders', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.get_pos_device_guest_alerts(v_c2, v_dev2, v_key2) g WHERE g.table_name LIKE 'S809 3c probe%';
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3c probe: the other outlet went quiet when BLOOM CAFE''s POS was switched off (% rows)', v_n;
    END IF;
    RESET ROLE;
    -- (h) The account locked (client_access_open false): nothing, and no error.
    PERFORM set_config('request.jwt.claims', '', true);
    UPDATE public.clients SET pos_enabled = true, is_active = false WHERE id = v_c;
    IF COALESCE(public.client_access_open(v_c), false) THEN
      RAISE EXCEPTION 'S809 3c probe: an inactive account still reads as open';
    END IF;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_n FROM public.get_pos_device_guest_alerts(v_c, v_dev, v_key);
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3c probe: with the account locked the PIN screen heard % orders', v_n;
    END IF;
    -- (i) A locked account does not make a bad key good: still refused.
    BEGIN
      PERFORM count(*) FROM public.get_pos_device_guest_alerts(v_c, v_dead, v_keyd);
      RAISE EXCEPTION 'S809 3c probe: the revoked tablet was answered while the account was locked';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'pos_device_not_active' THEN RAISE; END IF;
    END;
    RESET ROLE;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3c_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3c_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT oid::regprocedure::text, md5(prosrc), prosecdef, provolatile, proacl::text FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace AND proname = 'get_pos_device_guest_alerts';
--     expect exactly 1 row: get_pos_device_guest_alerts(uuid,uuid,text), 7f534b42d95ff5c5b5a811d424b86c62, t, s,
--       {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--   SELECT has_function_privilege('anon', 'public.get_pos_device_guest_alerts(uuid,uuid,text)', 'EXECUTE'),
--          has_function_privilege('anon', 'public.pos_device_key_valid(uuid,uuid,text)', 'EXECUTE');   -- t, f
--   SELECT md5(prosrc) FROM pg_proc WHERE oid IN ('public.pos_device_key_valid(uuid,uuid,text)'::regprocedure,
--          'public.client_access_open(uuid)'::regprocedure, 'public.get_pos_device_staff(uuid,uuid,text)'::regprocedure);
--     unchanged: 3b7392ac…, 48291b6f…, 8bec27d1…
--   SELECT count(*) FROM public.pos_devices WHERE name LIKE 'S809 3c probe%';   -- 0 (the probe rolled back)
--   SELECT count(*) FROM public.pos_tables WHERE name LIKE 'S809 3c probe%';    -- 0
