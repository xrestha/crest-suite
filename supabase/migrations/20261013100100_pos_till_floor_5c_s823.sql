-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S823, POS stage 5, slice 5c, step 2 of 2: tills older than crest-v438 write no bills.
--
--   APPLY ONLY ONCE crest-v438 IS LIVE (Vercel shows the deploy Ready and a fresh load of the app
--   reports crest-v438). Applied before that, every till is refused with nothing newer to load.
--
--   The S809 1b floor has stood at NULL since 2026-10-09, waiting on proof that x-crest-build reaches
--   the database; S822's header probe (20261012160000) showed it does, and the gateway's preflight
--   allows it. crest-v438 is the first release that sends items_version with a close (step 1,
--   20261013100000, refuses a close whose lines moved since they were priced), and it takes in every
--   change the floor was first meant for: 2a's refusal to charge an emptied cart (crest-v417) and
--   every till-side rule since. A till older than crest-v438 now has its bill writes refused
--   (pos_till_build_too_old) before anything is written; it keeps its unsent cart the way a lock
--   does and reloads itself within 3 seconds, at most once per 3 minutes (S809 1b,
--   releaseWatch.js). The release watch reloads most tills before this lands anyway.
--
--   The other pages that write bills (Customers' settle, Credit Notes, Periods' Post POS bills) are
--   gated the same way and say "reload the page" (errorText.js). A guest's QR order, the payment
--   webhook, admin-user-ops and pg_cron are not signed-in browser calls and pass, as before.
--
-- Built on the live body, md5(prosrc), read 2026-10-13: pos_min_till_build
-- dde1c8d2b5aed5f2b733e586b32e2e78 (S809 1b, 20261009100000), and requires step 1's
-- guard_pos_order_close (93873af6cdb5452c412396e829e8d41a). Same signature, STABLE, search_path ''
-- and ACL (authenticated and service_role only), so CREATE OR REPLACE keeps the gate's reads.
--
-- To undo: CREATE OR REPLACE it again with the body SELECT NULL::integer (no floor).
--
-- The probe acts as a signed-in Owner inside a block that rolls itself back: crest-v437 and a
-- missing header are refused, crest-v438 and newer pass, a guest passes. If any check fails,
-- nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the floor as 1b left it, and step 1 applied ─────────────────────────────────
-- The floor's second hash is the body this file writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('dde1c8d2b5aed5f2b733e586b32e2e78', '24490060a1847d8dcd8f98a1696784b3') THEN
    RAISE EXCEPTION 'S823 5c step 2 pre-flight: pos_min_till_build changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_order_close()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '93873af6cdb5452c412396e829e8d41a' THEN
    RAISE EXCEPTION 'S823 5c step 2 pre-flight: step 1 (20261013100000) is not live (guard_pos_order_close md5 %). Apply it, deploy crest-v438, then this.', v_md5;
  END IF;
END;
$$;


-- ── 1. The floor ──────────────────────────────────────────────────────────────────────────────
-- STABLE, not IMMUTABLE, as 1b explains: an IMMUTABLE constant can be folded into a cached plan.
CREATE OR REPLACE FUNCTION public.pos_min_till_build()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 438
$$;

COMMENT ON FUNCTION public.pos_min_till_build() IS
  'S809 1b: oldest APP_VERSION number (crest-vNNN) a till may write bills from; NULL = no floor. Raise it in a migration only after that release is deployed. S823 5c: 438 (a close carries items_version).';


-- ── 2. Prove it ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_owner uuid;
  v_try   text;
  v_err   text;
BEGIN
  IF public.pos_min_till_build() IS DISTINCT FROM 438 THEN
    RAISE EXCEPTION 'S823 5c step 2: the floor reads %, not 438', public.pos_min_till_build();
  END IF;
  IF has_function_privilege('anon', 'public.pos_min_till_build()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pos_min_till_build()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S823 5c step 2: pos_min_till_build''s EXECUTE grants changed';
  END IF;

  SELECT p.id INTO v_owner
    FROM public.clients c JOIN public.profiles p ON p.client_id = c.id
   WHERE c.pos_enabled AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL
     AND p.ims_role IS NULL AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name, p.id LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'S823 5c step 2 probe: no POS outlet with an Owner';
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

    -- (a) A page on crest-v437, and pages sending no build or an unreadable one, are refused.
    FOREACH v_try IN ARRAY ARRAY['{"x-crest-build":"crest-v437"}', '{}', '{"x-crest-build":"crest"}'] LOOP
      PERFORM set_config('request.headers', v_try, true);
      v_err := NULL;
      BEGIN
        UPDATE public.pos_orders SET id = id WHERE false;
      EXCEPTION WHEN others THEN
        v_err := SQLERRM;
        IF v_err NOT LIKE 'pos_till_build_too_old:%' THEN RAISE; END IF;
      END;
      IF v_err IS NULL THEN
        RAISE EXCEPTION 'S823 5c step 2 probe: headers % were let through', v_try;
      END IF;
    END LOOP;
    IF v_err NOT LIKE '%bills now need crest-v438 or newer%' THEN
      RAISE EXCEPTION 'S823 5c step 2 probe: the refusal reads %', v_err;
    END IF;

    -- (b) crest-v438 and newer pass, on both gated tables.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v438"}', true);
    UPDATE public.pos_orders SET id = id WHERE false;
    UPDATE public.pos_order_items SET id = id WHERE false;
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v1000"}', true);
    DELETE FROM public.pos_order_items WHERE false;

    -- (c) A guest (anon) passes with an old header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v437"}', true);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    INSERT INTO public.pos_order_items SELECT * FROM public.pos_order_items WHERE false;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's823_5c_step2_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's823_5c_step2_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 3. What it left (the last statement, so `db query` prints it) ─────────────────────────────
SELECT public.pos_min_till_build() AS till_floor,
       (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure) AS floor_md5,
       (SELECT proacl::text FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure) AS floor_acl;
