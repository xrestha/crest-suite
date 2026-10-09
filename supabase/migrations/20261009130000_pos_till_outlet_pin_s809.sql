-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 1, slice 1g: a till PIN login stays at its own outlet.
--
--   ACCESS-4 (P2). A PIN login could be ticked into a sibling outlet in Outlet Access and then
--   switched there, and active_client_id is one value per login: every later sign-in on its own
--   counter's tablet landed in the sibling, so a walk-in bill took the sibling's next invoice number
--   and printed the sibling's name and PAN. One outlet's sales register missed a sale and the other
--   carried one it never made, on a printed tax invoice. pos-staff-login only ever signs a PIN in on
--   a tablet of its HOME outlet, so home is the one outlet a PIN session may work in.
--
--   Closed here three ways:
--     (1) set_active_outlet refuses a PIN login (pos_email set) every outlet but its own, whatever
--         Outlet Access says. Its own outlet, by NULL or by id, is the reset it always was.
--     (2) set_outlet_access refuses to grant a PIN login another outlet, so the matrix cannot record
--         a reach that (1) would refuse (and that get_outlet_reaching_logins and link_hr_login would
--         otherwise believe). Granting nothing — clearing a row an older build wrote — still works.
--     (3) every PIN login's active_client_id is cleared, with any outlet-access rows and employee
--         links it holds at other outlets. Live before this migration: 2 PIN logins, 0 with
--         active_client_id set, 0 outlet-access rows, 0 employee links. So (3) changes no row today.
--
--   Nothing else writes a PIN login's active_client_id: every PIN login is created fresh by
--   admin-user-ops, so after (1)-(3) none can be anywhere but home (pos-staff-login is deliberately
--   left alone; only set_active_outlet() writes the column, CLAUDE.md). The till pages also refuse to
--   run while the window shows another outlet than the tablet's, with a way back (TillOutletGate,
--   GAP-OUTLETS-1, owner decision Q24 (a)). The Owner's own email login
--   keeps switching freely: that half is enforced on the tablet, because the tablet knows which
--   counter it stands at and the login does not.
--
-- Built on the LIVE bodies, read 2026-10-09:
--   set_active_outlet(uuid)         md5(prosrc) 31e3f8307f0898e01b700770157c4a78 (saved with CRLF)
--   set_outlet_access(uuid, uuid[]) md5(prosrc) 414730d6beb7014fcba2aef7a87fff47
-- Neither is touched by another stage-1 slice. CREATE OR REPLACE keeps both functions' grants
-- (postgres, authenticated, service_role; no PUBLIC, no anon), and the probe asserts it.
--
-- The probe at the end runs as a real PIN login, the Owner and an allowlisted staff login inside a
-- block that rolls itself back. If any check fails, the whole migration fails and nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 1. A PIN login switches nowhere ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_active_outlet(p_client_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_home_group uuid;
  v_target_group uuid;
  v_allowed boolean;
  v_home uuid;
  v_pin boolean;
BEGIN
  -- Resetting to your OWN outlet stays open to everyone, and must come BEFORE the checks below:
  -- assigning any staff marker demotes an account out of Owner, so an Owner who had switched and
  -- was then given a role would otherwise be stranded at a sibling outlet with no way back.
  IF p_client_id IS NULL THEN
    UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
    RETURN;
  END IF;

  -- S809 ACCESS-4: a till PIN login works only at its home outlet, the only one whose tablets can
  -- sign it in. Asking for home is the reset above; any other outlet is refused, even with an
  -- Outlet Access row an older build may have written. A caller with no profile row is not a PIN
  -- login here and falls through to the checks below, which refuse it.
  SELECT p.client_id, p.pos_email IS NOT NULL INTO v_home, v_pin
    FROM profiles p
   WHERE p.id = (select auth.uid());
  IF COALESCE(v_pin, false) THEN
    IF p_client_id = v_home THEN
      UPDATE profiles SET active_client_id = NULL WHERE id = (select auth.uid());
      RETURN;
    END IF;
    RAISE EXCEPTION 'pos_pin_outlet_pinned: a till PIN login works only at its own outlet, so it cannot switch to another'
      USING ERRCODE = '42501', HINT = 'pos_pin_outlet_pinned';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profile_outlet_access
     WHERE profile_id = (select auth.uid()) AND client_id = p_client_id
  ) INTO v_allowed;

  -- COALESCE on both identity tests: each reads a profiles row and returns NULL -- not false --
  -- when the caller has none, and IF NOT NULL THEN never fires, so the unwrapped form falls
  -- OPEN for exactly the accounts that could not be identified (S579).
  IF NOT (COALESCE(public.is_admin(), false)
          OR COALESCE(public.is_client_owner(), false)
          OR COALESCE(v_allowed, false)) THEN
    RAISE EXCEPTION 'Not permitted: you do not have access to that outlet.';
  END IF;

  SELECT c.group_id INTO v_home_group
    FROM profiles p JOIN clients c ON c.id = p.client_id
   WHERE p.id = (select auth.uid());

  SELECT group_id INTO v_target_group FROM clients WHERE id = p_client_id;

  -- Fails closed on every ambiguous case: no group, target ungrouped, or different group.
  IF v_home_group IS NULL OR v_target_group IS NULL OR v_home_group <> v_target_group THEN
    RAISE EXCEPTION 'Not permitted: that outlet is not in your group.';
  END IF;

  UPDATE profiles SET active_client_id = p_client_id WHERE id = (select auth.uid());
END;
$fn$;


-- ── 2. Outlet Access cannot grant a PIN login another outlet ──────────────────────────────
CREATE OR REPLACE FUNCTION public.set_outlet_access(p_profile_id uuid, p_client_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_group  uuid;
  v_target_group uuid;
  v_ids    uuid[] := COALESCE(p_client_ids, ARRAY[]::uuid[]);
BEGIN
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  -- The SUBJECT must be in my group...
  SELECT c.group_id INTO v_target_group
    FROM profiles p JOIN clients c ON c.id = p.client_id
   WHERE p.id = p_profile_id;
  IF v_target_group IS DISTINCT FROM v_group THEN
    RAISE EXCEPTION 'Not permitted: that account is not in your group.';
  END IF;

  -- S809 ACCESS-4: a till PIN login works only at its own outlet (set_active_outlet refuses it any
  -- other), so a grant would be a reach the matrix shows and nothing honours. An empty list still
  -- passes: it is how a row an older build wrote is cleared.
  IF cardinality(v_ids) > 0
     AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_profile_id AND p.pos_email IS NOT NULL) THEN
    RAISE EXCEPTION 'outlet_access_pin_login: a till PIN login works only at its own outlet, so it cannot be given another'
      USING ERRCODE = '42501', HINT = 'outlet_access_pin_login';
  END IF;

  -- ...and so must every outlet being granted. Checked as a set: one stray id fails the whole
  -- call rather than being silently dropped, so the UI can never report a grant that did not
  -- happen.
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS want(id)
     WHERE want.id NOT IN (SELECT c2.id FROM clients c2 WHERE c2.group_id = v_group)
  ) THEN
    RAISE EXCEPTION 'Not permitted: one or more outlets are not in your group.';
  END IF;

  DELETE FROM profile_outlet_access WHERE profile_id = p_profile_id;

  INSERT INTO profile_outlet_access (profile_id, client_id, granted_by)
  SELECT p_profile_id, want.id, (select auth.uid()) FROM unnest(v_ids) AS want(id);

  -- S798 3f-1: a login's employee link at an outlet lives only while the login can open that outlet,
  -- so an untick takes the link with it. Home links (profiles.hr_employee_id) are not in that table.
  DELETE FROM profile_employee_links l
   WHERE l.profile_id = p_profile_id
     AND l.client_id <> ALL (v_ids);

  -- A revoke must EVICT, not merely deny the next switch. Without this, an account already
  -- sitting in an outlet whose access was just removed keeps my_client_id() resolving there
  -- until they happen to switch again -- the same staleness clear_stale_active_outlet() handles
  -- for regrouping.
  UPDATE profiles
     SET active_client_id = NULL
   WHERE id = p_profile_id
     AND active_client_id IS NOT NULL
     AND active_client_id <> client_id
     AND active_client_id <> ALL (v_ids);
END;
$fn$;


-- ── 3. Every PIN login starts at home ─────────────────────────────────────────────────────
-- 0 rows each on 2026-10-09; kept so the migration holds wherever it runs. As the migration's role,
-- which guard_profiles_privileged_columns lets through; log_audit records any row it does change.
UPDATE public.profiles
   SET active_client_id = NULL
 WHERE pos_email IS NOT NULL
   AND active_client_id IS NOT NULL;

DELETE FROM public.profile_employee_links l
 USING public.profiles p
 WHERE p.id = l.profile_id
   AND p.pos_email IS NOT NULL;

DELETE FROM public.profile_outlet_access a
 USING public.profiles p
 WHERE p.id = a.profile_id
   AND p.pos_email IS NOT NULL;


-- ── 4. Prove it ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_group  uuid;
  v_home   uuid;
  v_sib    uuid;
  v_pin    uuid;
  v_owner  uuid;
  v_staff  uuid;
  v_active uuid;
  v_n      int;
  v_hint   text;
BEGIN
  -- Catalog: still callable by a signed-in login and by nobody signed out.
  IF has_function_privilege('anon', 'public.set_active_outlet(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_outlet_access(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_active_outlet(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_outlet_access(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 1g: the grants on set_active_outlet / set_outlet_access changed';
  END IF;

  -- Section 3 held.
  SELECT count(*) INTO v_n FROM public.profiles WHERE pos_email IS NOT NULL AND active_client_id IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 1g: % PIN login(s) still set to another outlet', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM public.profile_outlet_access a JOIN public.profiles p ON p.id = a.profile_id
   WHERE p.pos_email IS NOT NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'S809 1g: % outlet-access row(s) still held by PIN logins', v_n;
  END IF;

  -- The cast: a PIN login at an outlet of a group of two or more, a sibling outlet, the Owner of
  -- the PIN login's outlet, and a second login there to stand in as an allowlisted email staff login.
  SELECT p.id, p.client_id, c.group_id INTO v_pin, v_home, v_group
    FROM public.profiles p
    JOIN public.clients c ON c.id = p.client_id
   WHERE p.pos_email IS NOT NULL AND p.pos_role IS NOT NULL AND c.group_id IS NOT NULL
     AND (SELECT count(*) FROM public.clients s WHERE s.group_id = c.group_id) >= 2
   ORDER BY p.id
   LIMIT 1;
  IF v_pin IS NULL THEN
    RAISE EXCEPTION 'S809 1g probe: no PIN login at an outlet of a group to test with';
  END IF;
  SELECT id INTO v_sib FROM public.clients WHERE group_id = v_group AND id <> v_home ORDER BY id LIMIT 1;
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.client_id = v_home AND p.role = 'client'
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  SELECT p.id INTO v_staff
    FROM public.profiles p
   WHERE p.client_id = v_home AND p.role = 'client' AND p.id <> v_pin AND p.id <> v_owner
   ORDER BY p.id
   LIMIT 1;
  IF v_sib IS NULL OR v_owner IS NULL OR v_staff IS NULL THEN
    RAISE EXCEPTION 'S809 1g probe: needs a sibling outlet, an Owner and a second login (got %, %, %)', v_sib, v_owner, v_staff;
  END IF;

  BEGIN
    -- Setup, as the migration's role. The stand-in becomes an IMS manager with an email login
    -- (every PIN and HR marker removed, or a restrictive marker would make "allowed" vacuous), and
    -- the PIN login gets an Outlet Access row into the sibling, as a build before this one could
    -- have written it.
    UPDATE public.profiles
       SET pos_email = NULL, pos_role = NULL, ims_role = 'manager', ims_email = NULL,
           hr_role = NULL, hr_self_service = false, active_client_id = NULL
     WHERE id = v_staff;
    INSERT INTO public.profile_outlet_access (profile_id, client_id, granted_by) VALUES (v_pin, v_sib, v_owner);
    UPDATE public.profiles SET active_client_id = NULL WHERE id = v_owner;

    -- ── As the PIN login ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;

    -- (a) The sibling is refused, the stale grant notwithstanding.
    BEGIN
      PERFORM public.set_active_outlet(v_sib);
      RAISE EXCEPTION 'S809 1g probe: a PIN login was switched to a sibling outlet';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'pos_pin_outlet_pinned' THEN
        RAISE EXCEPTION 'S809 1g probe: the PIN refusal came with hint %', v_hint;
      END IF;
    END;
    -- (b) Home, by id and by NULL, is the reset.
    PERFORM public.set_active_outlet(v_home);
    PERFORM public.set_active_outlet(NULL);

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT active_client_id INTO v_active FROM public.profiles WHERE id = v_pin;
    IF v_active IS NOT NULL THEN
      RAISE EXCEPTION 'S809 1g probe: the PIN login ended at %, not home', v_active;
    END IF;

    -- ── As the Owner ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1g probe: % is not an Owner login', v_owner;
    END IF;

    -- (c) A PIN login cannot be granted the sibling...
    BEGIN
      PERFORM public.set_outlet_access(v_pin, ARRAY[v_sib]);
      RAISE EXCEPTION 'S809 1g probe: a PIN login was granted a sibling outlet';
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
      IF v_hint IS DISTINCT FROM 'outlet_access_pin_login' THEN
        RAISE EXCEPTION 'S809 1g probe: the grant refusal came with hint %', v_hint;
      END IF;
    END;
    -- (d) ...but granting it nothing clears the stale row.
    PERFORM public.set_outlet_access(v_pin, ARRAY[]::uuid[]);
    -- (e) An email staff login can still be granted the sibling.
    PERFORM public.set_outlet_access(v_staff, ARRAY[v_sib]);
    -- (f) The Owner still switches freely, and comes home.
    PERFORM public.set_active_outlet(v_sib);

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT count(*) INTO v_n FROM public.profile_outlet_access WHERE profile_id = v_pin;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 1g probe: granting a PIN login nothing left % row(s)', v_n;
    END IF;
    SELECT count(*) INTO v_n FROM public.profile_outlet_access WHERE profile_id = v_staff AND client_id = v_sib;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 1g probe: the staff grant wrote % row(s)', v_n;
    END IF;
    SELECT active_client_id INTO v_active FROM public.profiles WHERE id = v_owner;
    IF v_active IS DISTINCT FROM v_sib THEN
      RAISE EXCEPTION 'S809 1g probe: the Owner switch landed on %, not the sibling', v_active;
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.set_active_outlet(NULL);

    -- ── As the allowlisted email staff login ──
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    IF COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 1g probe: the stand-in % still reads as the Owner', v_staff;
    END IF;
    -- (g) The allowlist still takes an email staff login to the sibling.
    PERFORM public.set_active_outlet(v_sib);

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    SELECT active_client_id INTO v_active FROM public.profiles WHERE id = v_staff;
    IF v_active IS DISTINCT FROM v_sib THEN
      RAISE EXCEPTION 'S809 1g probe: the allowlisted switch landed on %, not the sibling', v_active;
    END IF;
    SELECT active_client_id INTO v_active FROM public.profiles WHERE id = v_owner;
    IF v_active IS NOT NULL THEN
      RAISE EXCEPTION 'S809 1g probe: the Owner did not come home (%)', v_active;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_1g_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_1g_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

-- Read back after applying (one statement per call):
--   SELECT p.proname, md5(p.prosrc), p.proacl FROM pg_proc p
--    WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('set_active_outlet', 'set_outlet_access');
--   SELECT position('pos_pin_outlet_pinned' IN prosrc) > 0 FROM pg_proc WHERE proname = 'set_active_outlet';
--   SELECT position('outlet_access_pin_login' IN prosrc) > 0 FROM pg_proc WHERE proname = 'set_outlet_access';
--   SELECT count(*) FROM public.profiles WHERE pos_email IS NOT NULL AND active_client_id IS NOT NULL;
--   SELECT count(*) FROM public.profile_outlet_access a JOIN public.profiles p ON p.id = a.profile_id WHERE p.pos_email IS NOT NULL;
