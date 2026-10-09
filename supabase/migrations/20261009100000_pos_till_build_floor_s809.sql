-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1b: a till too old for the rules it writes under is told to reload.
--
--   GAP-RELEASE-1 (P2), owner decision Q27 (c). A till never picked up a release on its own: a
--   tablet left on ran the code it opened with while the database moved on, and the only defence
--   was to keep every changed RPC callable by an old page (S754's optional p_expected_version).
--   The app half of this slice makes the till reload itself at a safe moment once a new release is
--   out (src/shared/releaseWatch.js). This is the hard stop behind it, for a release that changes
--   what a till must send: a till older than the floor has its bill writes refused, before anything
--   is written, and reloads.
--
--   (1) public.pos_min_till_build() is the floor: the oldest APP_VERSION number (crest-vNNN → NNN)
--       a till may write bills from. NULL = no floor, which is what this migration leaves. A later
--       migration that changes what a till sends replaces it with that release's number — AFTER
--       the release is deployed, never before, or every till is refused with nothing newer to load.
--       A function rather than a settings column: nothing in the browser can lower it, and the
--       migration that needs it is where the reason for the number is written down.
--   (2) public.pos_till_build_gate() reads the x-crest-build header every browser call to /rest/v1/
--       carries (src/utils/buildHeaderFetch.js) and refuses an older or missing one with
--       pos_till_build_too_old. It runs once per STATEMENT, BEFORE, on writes to pos_orders and
--       pos_order_items, which covers save_pos_order_items, the bill close (guard_pos_order_close)
--       and a direct REST write alike, without editing either body. Only signed-in browser calls
--       are checked (auth.role() = 'authenticated'): a guest's QR order (anon), the payment webhook
--       and admin-user-ops (service role), and pg_cron (no JWT) all pass. A page too old to send
--       the header at all — everything before this release — is refused once a floor is set, which
--       is the point; it needs one manual reload after this release ships (S809.2).
--
--   PostgREST already hands request headers to the database (request.headers, lower-cased); the
--   booking rate limit reads x-forwarded-for and admin-user-ops' HR path reads x-crest-actor the
--   same way. The gateway's CORS preflight allows x-crest-build (checked 2026-10-09).
--
-- No existing function is replaced. Undo: drop the two triggers, then the two functions.
--
-- The probe at the end sets a floor inside a block that rolls itself back, and checks an old,
-- current, missing and unreadable build header as a signed-in login, and a guest, the service role
-- and a call with no JWT. If any check fails, the whole migration fails and nothing here lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 1. The floor ──────────────────────────────────────────────────────────────────────────
--
-- STABLE, not IMMUTABLE: an IMMUTABLE constant can be folded into a cached plan, and a session
-- would then keep the old floor after a later migration replaces this body.
CREATE OR REPLACE FUNCTION public.pos_min_till_build()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT NULL::integer
$$;

COMMENT ON FUNCTION public.pos_min_till_build() IS
  'S809 1b: oldest APP_VERSION number (crest-vNNN) a till may write bills from; NULL = no floor. Raise it in a migration only after that release is deployed.';

-- The gate below is SECURITY INVOKER, so the signed-in caller runs this. It returns one number.
REVOKE ALL ON FUNCTION public.pos_min_till_build() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_min_till_build() TO authenticated, service_role;


-- ── 2. The gate ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_till_build_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_min   integer;
  v_sent  text;
  v_build integer;
BEGIN
  -- Signed-in browser calls only. Guests (anon), the service role and pg_cron (no JWT) pass.
  -- Tested before the floor is read, because anon holds no EXECUTE on pos_min_till_build().
  IF NOT COALESCE(auth.role() = 'authenticated', false) THEN
    RETURN NULL;
  END IF;
  v_min := public.pos_min_till_build();
  IF v_min IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_sent := NULLIF(current_setting('request.headers', true), '')::json ->> 'x-crest-build';
  EXCEPTION WHEN others THEN
    v_sent := NULL;
  END;
  v_build := NULLIF(substring(COALESCE(v_sent, '') FROM '([0-9]+)$'), '')::integer;

  IF COALESCE(v_build >= v_min, false) THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'pos_till_build_too_old: this page runs %, and bills now need crest-v% or newer; reload the page',
      COALESCE(v_sent, 'a version from before 2026-10-09'), v_min
    USING ERRCODE = 'P0001', HINT = 'pos_till_build_too_old';
END;
$$;

COMMENT ON FUNCTION public.pos_till_build_gate() IS
  'S809 1b: BEFORE statement trigger; refuses a signed-in browser write to bills from a page older than pos_min_till_build().';

REVOKE ALL ON FUNCTION public.pos_till_build_gate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pos_orders_till_build_gate ON public.pos_orders;
CREATE TRIGGER pos_orders_till_build_gate
  BEFORE INSERT OR UPDATE ON public.pos_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.pos_till_build_gate();

DROP TRIGGER IF EXISTS pos_order_items_till_build_gate ON public.pos_order_items;
CREATE TRIGGER pos_order_items_till_build_gate
  BEFORE INSERT OR UPDATE OR DELETE ON public.pos_order_items
  FOR EACH STATEMENT EXECUTE FUNCTION public.pos_till_build_gate();


-- ── 3. Prove it ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_n     int;
  v_owner uuid;
  v_err   text;
  v_try   text;
BEGIN
  -- Every write below matches no rows. A statement trigger fires anyway, so the gate is tested
  -- and nothing is written, even before the rollback.
  -- Catalog: two enabled, BEFORE, statement-level gate triggers.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname IN ('pos_orders_till_build_gate', 'pos_order_items_till_build_gate')
     AND NOT tgisinternal AND tgenabled = 'O'
     AND (tgtype & 1) = 0          -- not FOR EACH ROW
     AND (tgtype & 2) <> 0         -- BEFORE
     AND tgfoid = 'public.pos_till_build_gate()'::regprocedure;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S809 1b: expected 2 BEFORE statement gate triggers, found %', v_n;
  END IF;
  IF public.pos_min_till_build() IS NOT NULL THEN
    RAISE EXCEPTION 'S809 1b: this migration must leave no floor, found %', public.pos_min_till_build();
  END IF;

  SELECT p.id INTO v_owner
    FROM public.profiles p
    JOIN public.clients c ON c.id = COALESCE(p.active_client_id, p.client_id)
   WHERE p.role = 'client' AND c.pos_enabled
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 1b probe: no POS Owner login to test with';
  END IF;

  BEGIN
    -- No floor: an old header passes. In a block of its own, so the floor it reads (NULL) is not
    -- a cached result the checks below could reuse after the floor is replaced.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v1"}', true);
    BEGIN
      UPDATE public.pos_orders SET id = id WHERE false;
    EXCEPTION WHEN others THEN
      RAISE;
    END;

    -- A floor of crest-v413, for this block only.
    EXECUTE $f$CREATE OR REPLACE FUNCTION public.pos_min_till_build() RETURNS integer
               LANGUAGE sql STABLE SET search_path = '' AS 'SELECT 413'$f$;

    -- (a) A signed-in page on crest-v412 is refused, on each gated table and event.
    FOREACH v_try IN ARRAY ARRAY[
      'UPDATE public.pos_orders SET id = id WHERE false',
      'INSERT INTO public.pos_orders SELECT * FROM public.pos_orders WHERE false',
      'UPDATE public.pos_order_items SET id = id WHERE false',
      'INSERT INTO public.pos_order_items SELECT * FROM public.pos_order_items WHERE false',
      'DELETE FROM public.pos_order_items WHERE false'
    ] LOOP
      PERFORM set_config('request.headers', '{"x-crest-build":"crest-v412"}', true);
      v_err := NULL;
      BEGIN
        EXECUTE v_try;
      EXCEPTION WHEN others THEN
        v_err := SQLERRM;
        IF SQLSTATE <> 'P0001' OR v_err NOT LIKE 'pos_till_build_too_old:%' THEN RAISE; END IF;
      END;
      IF v_err IS NULL THEN
        RAISE EXCEPTION 'S809 1b probe: crest-v412 was let through by: %', v_try;
      END IF;
    END LOOP;

    -- (b) No header, an unreadable one, and no headers at all: refused.
    FOREACH v_try IN ARRAY ARRAY['{}', '{"x-crest-build":"crest"}', '{"x-crest-build":""}', 'not json'] LOOP
      PERFORM set_config('request.headers', v_try, true);
      v_err := NULL;
      BEGIN
        UPDATE public.pos_order_items SET id = id WHERE false;
      EXCEPTION WHEN others THEN
        v_err := SQLERRM;
        IF v_err NOT LIKE 'pos_till_build_too_old:%' THEN RAISE; END IF;
      END;
      IF v_err IS NULL THEN
        RAISE EXCEPTION 'S809 1b probe: headers % were let through', v_try;
      END IF;
    END LOOP;

    -- (c) crest-v413 and newer pass.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v413"}', true);
    UPDATE public.pos_orders SET id = id WHERE false;
    DELETE FROM public.pos_order_items WHERE false;
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v1000"}', true);
    UPDATE public.pos_order_items SET id = id WHERE false;

    -- (d) A guest (anon), the service role and a call with no JWT pass with an old header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v412"}', true);
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    INSERT INTO public.pos_order_items SELECT * FROM public.pos_order_items WHERE false;
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    UPDATE public.pos_orders SET id = id WHERE false;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);
    UPDATE public.pos_orders SET id = id WHERE false;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1b_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1b_probe_rollback' THEN RAISE; END IF;
  END;

  -- The rollback took the probe's floor with it.
  IF public.pos_min_till_build() IS NOT NULL THEN
    RAISE EXCEPTION 'S809 1b probe: the probe floor survived its rollback';
  END IF;
END;
$$;

-- Read back after applying (one statement per call):
--   SELECT tgname, tgenabled, tgtype FROM pg_trigger WHERE tgname LIKE '%till_build_gate';
--   SELECT public.pos_min_till_build();
--   SELECT p.proname, p.proacl FROM pg_proc p WHERE p.proname IN ('pos_min_till_build', 'pos_till_build_gate');
