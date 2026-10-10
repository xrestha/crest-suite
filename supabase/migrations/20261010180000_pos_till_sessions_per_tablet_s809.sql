-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3h: a till lock ends only that tablet's session, and revoking a tablet ends
-- the sessions opened on it.
--
--   ACCESS-7 (P2), owner decision Q18 (a), 2026-10-09. The till lock (idle, or Lock POS) signed out
--   with supabase-js's default scope, 'global', which ends EVERY session of the login: a waiter who
--   locked till 1 was signed out of till 2 within the hour, mid-order, and lost its unsent lines, and
--   a Kitchen Display under a front-of-house PIN dropped to the email login every time that login
--   locked a till. The app half of this slice makes the lock 'local' (this tablet's session only).
--   That removes the one thing that cut off a lost or stolen tablet's open session as a side effect:
--   revoke_pos_device stopped only the NEXT sign-in, unlike the counting tablet's
--   ims_revoke_count_sessions (S792). So the server half, here:
--     (1) pos_device_sessions: one row per PIN sign-in, its session id (auth.sessions.id) filed under
--         the tablet that opened it. No client grants and no policies (pos_devices' reasoning): only
--         the functions below read or write it. Not exported, not restored (a session is not data).
--         Every key cascades: a deleted tablet, client or login takes its rows with it, so Danger Zone
--         and RESTORE_ORDER need nothing, and pos_login_reference_columns (S809 3i) does not count a
--         session as something a login recorded. No key to auth.sessions (GoTrue's own table, which
--         its migrations may rewrite): a row whose session has ended is dropped by (2) and (3).
--     (2) pos_record_device_session(p_client_id, p_device_id, p_session_id) → boolean, service role
--         only. pos-staff-login calls it after a correct PIN and BEFORE handing out the tokens, and
--         hands out nothing unless it answers true: the session exists, belongs to a POS PIN login of
--         the tablet's outlet, and the tablet's key is live. A tablet revoked between the sign-in gate
--         and here: the new session is ended on the spot and the answer is false (the till gets the
--         dead-key screen). The tablet row is read FOR KEY SHARE, which waits for a revoke in flight
--         (its SELECT … FOR UPDATE) but not for the gate's last_used_at stamp, so a sign-in and a
--         revoke cannot miss each other: whichever commits second sees the other. Each call also drops
--         this tablet's rows whose session has already ended (a lock, a sign-out). A session is filed
--         under one tablet only; filing it again under the same one answers true (a retry).
--     (3) revoke_pos_device(p_device_id), from its live body, plus: the sessions filed under the tablet
--         are deleted from auth.sessions (their refresh tokens go with them) and the rows with them.
--         Done before the "already revoked" early return, so a retry after a dropped answer ends
--         anything left. Same signature, refusals, audit row and grants.
--     (4) pos_revoke_till_sessions(p_client_id) → integer, service role only: every POS PIN login of
--         the outlet loses its sessions. admin-user-ops' revokeClientTablets (Archive, Clear Client
--         Data, Delete Client, the trial purge) calls it beside ims_revoke_count_sessions (S792), so
--         revoking all of an outlet's tablets signs its tills out too, sessions opened before this
--         release (never filed by (2)) included.
--   An access token already issued lives out its remaining minutes (at most an hour; an issued JWT
--   cannot be revoked): the till keeps working until then, or until it next locks, and then shows the
--   dead-key screen. That is S792's bound, unchanged.
--
--   ACCESS-6, ACCESS-11, ACCESS-12 and the removal of the shared-key code are app and Edge Function
--   changes. The shared key's four functions are dropped by 20261010190500, after the deploys.
--
-- Built on the LIVE body (pg_get_functiondef, md5(prosrc), read 2026-10-10 after stage-3 wave 3,
-- master ee69d692, crest-v427). Section 0 refuses to run over any other body:
--   revoke_pos_device(uuid)               9614cb6ef8abaacc83fae00d60bcdf56
--     proacl {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}, kept by CREATE OR REPLACE
-- Called, not replaced (section 0 checks the one the refusals rest on):
--   pos_device_caller_may_manage(uuid)    10e1c9a74168ad7b407eefb15d820e4d  (S809 3i's)
--   pos_devices_audit(text,pos_devices,pos_devices), register_pos_device(uuid,text) 1e73910963ab0a7ba985e20011dfd9ef (probe)
-- Not touched: verify_pos_device (98b68bbfbb2ca605a83a2df50f072b4d; pos-staff-login still calls it
-- first), get_pos_device_staff, pos_device_key_valid and get_pos_device_guest_alerts (3c).
--
-- Live before this migration (2026-10-10):
--   * 0 rows in pos_devices (BLOOM's data clear took its one tablet), so no tablet is activated and no
--     PIN sign-in can happen until one is: nothing is in flight.
--   * 6 POS PIN logins (3 at BLOOM CAFE, 3 at BLOOM CAFE - PKR), none blocked or settled, 0 open
--     sessions between them.
--   * No constraint or refusal is added to an existing table, so no live row is rejected.
--
-- Ship order, one step at a time:
--   1. this migration;
--   2. pos-staff-login (it calls (2); deployed first, every PIN sign-in fails closed with a 503, which
--      the till reads as "couldn't reach the server");
--   3. admin-user-ops (it calls (4); deployed first, Archive / Clear Client Data / Delete Client fail
--      on the missing function);
--   4. the app (the 'local' till lock, the PIN screen's answers, Till Devices without the shared key);
--   5. 20261010190500 (the shared key's functions), a day after the app, once no browser still runs a
--      crest-v427 Till Devices page, which reads pos_legacy_device_key_status.
-- A till on crest-v427 is refused nothing new: revoke_pos_device keeps its signature and answers. The
-- one new behaviour it meets is that a revoked tablet's open session now ends (within the hour).
--
-- The probe at the end runs as BLOOM CAFE's Owner, two of its POS PIN logins (made a plain supervisor
-- and a plain manager), a POS PIN login of BLOOM CAFE - PKR, an anonymous caller and the service role,
-- inside a block that rolls itself back. If any check fails, the whole migration fails and nothing
-- lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the body this file replaces is the one it was built on ───────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.revoke_pos_device(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '9614cb6ef8abaacc83fae00d60bcdf56' AND v_md5 IS DISTINCT FROM '6955db8158fa45ca5b9a7bafc6358551' THEN
    RAISE EXCEPTION 'S809 3h: revoke_pos_device changed since this slice was drafted (live md5 %) — merge section 3 onto the live body and update the md5 in section 0', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_device_caller_may_manage(uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '10e1c9a74168ad7b407eefb15d820e4d' THEN
    RAISE EXCEPTION 'S809 3h: pos_device_caller_may_manage changed since this slice was drafted (live md5 %) — re-read it: the probe''s refusals rest on it', v_md5;
  END IF;
  -- The new names are free, or hold exactly what this file creates (a re-run).
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace
                AND ((proname = 'pos_record_device_session'
                      AND NOT (pronargs = 3 AND proargtypes[0] = 'uuid'::regtype AND proargtypes[1] = 'uuid'::regtype
                               AND proargtypes[2] = 'uuid'::regtype))
                  OR (proname = 'pos_revoke_till_sessions'
                      AND NOT (pronargs = 1 AND proargtypes[0] = 'uuid'::regtype)))) THEN
    RAISE EXCEPTION 'S809 3h: a function named pos_record_device_session or pos_revoke_till_sessions already exists with another signature';
  END IF;
END;
$$;


-- ── 1. pos_device_sessions: which tablet opened which PIN session ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_device_sessions (
  -- auth.sessions.id: the `session_id` claim of the access token pos-staff-login was just issued.
  session_id uuid PRIMARY KEY,
  device_id  uuid NOT NULL REFERENCES public.pos_devices(id) ON DELETE CASCADE,
  client_id  uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- revoke_pos_device and the housekeeping in (2) both look a tablet's rows up.
CREATE INDEX IF NOT EXISTS pos_device_sessions_device_id_idx ON public.pos_device_sessions (device_id);

-- pos_devices' shape: RLS on with no policy, nothing for a client role (MAINTAIN, TRUNCATE,
-- REFERENCES and TRIGGER included, the S782 trap), the service role as for pos_devices.
ALTER TABLE public.pos_device_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_device_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_device_sessions TO service_role;


-- ── 2. pos_record_device_session: pos-staff-login files a new session under its tablet ──────────
CREATE OR REPLACE FUNCTION public.pos_record_device_session(p_client_id uuid, p_device_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dev  pos_devices;
  v_user uuid;
BEGIN
  IF p_client_id IS NULL OR p_device_id IS NULL OR p_session_id IS NULL THEN
    RETURN false;
  END IF;

  -- FOR KEY SHARE waits for a revoke in flight (revoke_pos_device takes the row FOR UPDATE) and does
  -- not wait for the sign-in gate's last_used_at stamp (FOR NO KEY UPDATE).
  SELECT * INTO v_dev FROM pos_devices
   WHERE id = p_device_id AND client_id = p_client_id
     FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Only a POS PIN login of the tablet's own outlet signs in on it (pos-staff-login's lookup).
  SELECT s.user_id INTO v_user FROM auth.sessions s WHERE s.id = p_session_id;
  IF v_user IS NULL OR NOT EXISTS (
       SELECT 1 FROM profiles p
        WHERE p.id = v_user AND p.client_id = v_dev.client_id
          AND p.pos_role IS NOT NULL AND p.pos_email IS NOT NULL) THEN
    RETURN false;
  END IF;

  -- Revoked between the sign-in gate and here: the session it just opened ends now.
  IF v_dev.revoked_at IS NOT NULL THEN
    DELETE FROM auth.sessions WHERE id = p_session_id;
    RETURN false;
  END IF;

  INSERT INTO pos_device_sessions (session_id, device_id, client_id, user_id)
  VALUES (p_session_id, p_device_id, v_dev.client_id, v_user)
  ON CONFLICT (session_id) DO NOTHING;

  -- This tablet's rows whose session has already ended: a lock, a sign-out.
  DELETE FROM pos_device_sessions ds
   WHERE ds.device_id = p_device_id
     AND NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = ds.session_id);

  RETURN EXISTS (SELECT 1 FROM pos_device_sessions ds WHERE ds.session_id = p_session_id AND ds.device_id = p_device_id);
END;
$$;
REVOKE ALL ON FUNCTION public.pos_record_device_session(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_record_device_session(uuid, uuid, uuid) TO service_role;


-- ── 3. revoke_pos_device: the tablet's sessions end with its key ─────────────────────────────────
-- Live body (9614cb6ef8abaacc83fae00d60bcdf56) with one block added, marked "S809 3h".
CREATE OR REPLACE FUNCTION public.revoke_pos_device(p_device_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old pos_devices;
  v_new pos_devices;
BEGIN
  SELECT * INTO v_old FROM pos_devices WHERE id = p_device_id FOR UPDATE;
  -- Absent and not-yours read the same, so the refusal is not an oracle for another client's ids.
  IF NOT FOUND OR NOT public.pos_device_caller_may_manage(v_old.client_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- S809 3h (ACCESS-7, owner decision Q18 a): the sessions opened on this tablet end with its key. A
  -- till lock ends only its own tablet's session now, so this is what cuts off a lost tablet that is
  -- still signed in. Deleting a session takes its refresh tokens with it; an access token already
  -- issued lives out its remaining minutes. Before the early return, so a retry ends anything left.
  DELETE FROM auth.sessions
   WHERE id IN (SELECT ds.session_id FROM pos_device_sessions ds WHERE ds.device_id = p_device_id);
  DELETE FROM pos_device_sessions WHERE device_id = p_device_id;

  IF v_old.revoked_at IS NOT NULL THEN
    RETURN;
  END IF;

  UPDATE pos_devices
     SET revoked_at = now(), revoked_by = (select auth.uid())
   WHERE id = p_device_id
  RETURNING * INTO v_new;

  PERFORM public.pos_devices_audit('UPDATE', v_old, v_new);
END;
$function$;


-- ── 4. pos_revoke_till_sessions: every till login of an outlet signed out (admin-user-ops) ────────
-- The counting tablets' ims_revoke_count_sessions (S792), for the till: revokeClientTablets revokes
-- every tablet key of the outlet with the service role, so it ends every POS PIN session of the outlet
-- with it, filed under a tablet or not.
CREATE OR REPLACE FUNCTION public.pos_revoke_till_sessions(p_client_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_n integer;
BEGIN
  DELETE FROM auth.sessions
   WHERE user_id IN (SELECT p.id FROM profiles p WHERE p.client_id = p_client_id AND p.pos_email IS NOT NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM pos_device_sessions WHERE client_id = p_client_id;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.pos_revoke_till_sessions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_revoke_till_sessions(uuid) TO service_role;


-- ── 5. Prove it ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c      uuid;   -- BLOOM CAFE
  v_pkr    uuid;   -- BLOOM CAFE - PKR, "another outlet"
  v_owner  uuid;   -- BLOOM CAFE's Owner
  v_sup    uuid;   -- a BLOOM CAFE POS PIN login, made a plain POS supervisor
  v_mgr    uuid;   -- another, made a plain POS manager
  v_other  uuid;   -- a POS PIN login of BLOOM CAFE - PKR
  v_dev_a  uuid;
  v_dev_b  uuid;
  v_s1     uuid := gen_random_uuid();   -- the supervisor, signed in on tablet A
  v_s2     uuid := gen_random_uuid();   -- the supervisor again, on tablet B (one waiter, two tills)
  v_s3     uuid := gen_random_uuid();   -- the supervisor, a session never filed (opened before this release)
  v_s4     uuid := gen_random_uuid();   -- the manager, on tablet B
  v_s5     uuid := gen_random_uuid();   -- the Owner, signed in by email
  v_s6     uuid := gen_random_uuid();   -- the other outlet's PIN login
  v_s7     uuid := gen_random_uuid();   -- the supervisor, a sign-in landing after tablet A is revoked
  v_n      int;
  v_priv   text;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pos_device_sessions'::regclass) THEN
    RAISE EXCEPTION 'S809 3h: row level security is off on pos_device_sessions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'pos_device_sessions') THEN
    RAISE EXCEPTION 'S809 3h: pos_device_sessions has a policy; only its functions reach it';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
    IF has_table_privilege('anon', 'public.pos_device_sessions', v_priv)
       OR has_table_privilege('authenticated', 'public.pos_device_sessions', v_priv) THEN
      RAISE EXCEPTION 'S809 3h: a client role holds % on pos_device_sessions', v_priv;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conrelid = 'public.pos_device_sessions'::regclass AND contype = 'f' AND confdeltype = 'c'
     AND confrelid IN ('public.pos_devices'::regclass, 'public.clients'::regclass, 'public.profiles'::regclass);
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 3h: pos_device_sessions does not carry its three cascading keys (% found)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.pos_record_device_session(uuid,uuid,uuid)'::regprocedure,
                 'public.pos_revoke_till_sessions(uuid)'::regprocedure,
                 'public.revoke_pos_device(uuid)'::regprocedure)
     AND prosecdef AND proconfig @> ARRAY['search_path=public'];
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S809 3h: a session function is not SECURITY DEFINER with search_path public (% of 3)', v_n;
  END IF;
  IF has_function_privilege('anon', 'public.pos_record_device_session(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_record_device_session(uuid,uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pos_record_device_session(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_revoke_till_sessions(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_revoke_till_sessions(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pos_revoke_till_sessions(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.revoke_pos_device(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.revoke_pos_device(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.revoke_pos_device(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 3h: EXECUTE grants on the session functions are not as expected';
  END IF;

  -- ── The outlets and the logins ────────────────────────────────────────────────────────────
  SELECT id INTO v_c FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_pkr FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_sup
    FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_mgr
    FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id = v_c AND p.pos_email IS NOT NULL AND p.id IS DISTINCT FROM v_sup
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_other
    FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id = v_pkr AND p.pos_email IS NOT NULL AND p.pos_role IS NOT NULL
   ORDER BY p.id
   LIMIT 1;
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  IF v_c IS NULL OR v_pkr IS NULL OR v_sup IS NULL OR v_mgr IS NULL OR v_other IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 3h probe: needs BLOOM CAFE, BLOOM CAFE - PKR, two BLOOM CAFE POS PIN logins, one of PKR''s and BLOOM CAFE''s Owner (got %, %, %, %, %, %)',
      v_c, v_pkr, v_sup, v_mgr, v_other, v_owner;
  END IF;

  BEGIN
    -- ── Setup, as the migration's own role ────────────────────────────────────────────────
    -- Both BLOOM CAFE stand-ins lose every other staff marker and any block, so a refusal below is the
    -- rank's and not a leftover marker's. Every login gets the sessions named above.
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_blocked_at = NULL, pos_blocked_by = NULL, settlement_blocked_by = NULL,
           ims_role = NULL, hr_role = NULL, hr_self_service = false, active_client_id = NULL
     WHERE id = v_sup;
    UPDATE public.profiles
       SET pos_role = 'manager', pos_blocked_at = NULL, pos_blocked_by = NULL, settlement_blocked_by = NULL,
           ims_role = NULL, hr_role = NULL, hr_self_service = false, active_client_id = NULL
     WHERE id = v_mgr;
    INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
    VALUES (v_s1, v_sup, now(), now()), (v_s2, v_sup, now(), now()), (v_s3, v_sup, now(), now()),
           (v_s4, v_mgr, now(), now()), (v_s5, v_owner, now(), now()), (v_s6, v_other, now(), now()),
           (v_s7, v_sup, now(), now());

    -- ── (a) As the Owner: two tablets, A and B ──────────────────────────────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT d.device_id INTO v_dev_a FROM public.register_pos_device(v_c, 'S809 3h probe A') d;
    SELECT d.device_id INTO v_dev_b FROM public.register_pos_device(v_c, 'S809 3h probe B') d;

    -- ── (b) No signed-in login and no anonymous caller files a session or signs an outlet out ──
    BEGIN
      PERFORM public.pos_record_device_session(v_c, v_dev_a, v_s5);
      RAISE EXCEPTION 'S809 3h probe: a signed-in login called pos_record_device_session';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      PERFORM public.pos_revoke_till_sessions(v_c);
      RAISE EXCEPTION 'S809 3h probe: a signed-in login called pos_revoke_till_sessions';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM public.pos_record_device_session(v_c, v_dev_a, v_s1);
      RAISE EXCEPTION 'S809 3h probe: an anonymous caller called pos_record_device_session';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;

    -- ── (c) As pos-staff-login (the service role): each PIN sign-in filed under its tablet ──────
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    IF NOT public.pos_record_device_session(v_c, v_dev_a, v_s1)
       OR NOT public.pos_record_device_session(v_c, v_dev_b, v_s2)
       OR NOT public.pos_record_device_session(v_c, v_dev_b, v_s4) THEN
      RAISE EXCEPTION 'S809 3h probe: a PIN sign-in on a live tablet of its own outlet was not filed';
    END IF;
    -- A retried call for the same sign-in is still filed; a session is never filed under a second tablet.
    IF NOT public.pos_record_device_session(v_c, v_dev_a, v_s1) THEN
      RAISE EXCEPTION 'S809 3h probe: filing the same sign-in twice was refused';
    END IF;
    IF COALESCE(public.pos_record_device_session(v_c, v_dev_b, v_s1), true) THEN
      RAISE EXCEPTION 'S809 3h probe: a session filed under tablet A was filed under tablet B too';
    END IF;
    -- Refused, and left open: the Owner's email session, another outlet's PIN login, the tablet named
    -- under the wrong outlet, a session that does not exist, a missing tablet.
    IF COALESCE(public.pos_record_device_session(v_c, v_dev_a, v_s5), true)
       OR COALESCE(public.pos_record_device_session(v_c, v_dev_a, v_s6), true)
       OR COALESCE(public.pos_record_device_session(v_pkr, v_dev_a, v_s1), true)
       OR COALESCE(public.pos_record_device_session(v_c, v_dev_a, gen_random_uuid()), true)
       OR COALESCE(public.pos_record_device_session(v_c, NULL, v_s1), true) THEN
      RAISE EXCEPTION 'S809 3h probe: a session that is not a PIN sign-in of the tablet''s outlet was filed';
    END IF;
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.pos_device_sessions WHERE device_id IN (v_dev_a, v_dev_b);
    IF v_n <> 3 OR (SELECT count(*) FROM auth.sessions WHERE id IN (v_s1, v_s2, v_s3, v_s4, v_s5, v_s6, v_s7)) <> 7 THEN
      RAISE EXCEPTION 'S809 3h probe: expected 3 filed sessions and all 7 still open (% filed)', v_n;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_device_sessions
                    WHERE session_id = v_s1 AND device_id = v_dev_a AND client_id = v_c AND user_id = v_sup) THEN
      RAISE EXCEPTION 'S809 3h probe: the supervisor''s sign-in on tablet A is not filed as such';
    END IF;

    -- ── (d) As the POS supervisor: no rank to revoke a tablet, and nothing ends ─────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.revoke_pos_device(v_dev_a);
      RAISE EXCEPTION 'S809 3h probe: a POS supervisor revoked a tablet';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id = v_s1) THEN
      RAISE EXCEPTION 'S809 3h probe: a refused revoke ended a session';
    END IF;

    -- ── (e) As the Owner: revoking tablet A ends exactly the session opened on it ──────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.revoke_pos_device(v_dev_a);
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM auth.sessions WHERE id = v_s1)
       OR (SELECT count(*) FROM auth.sessions WHERE id IN (v_s2, v_s3, v_s4, v_s5, v_s6, v_s7)) <> 6 THEN
      RAISE EXCEPTION 'S809 3h probe: revoking tablet A did not end exactly the session opened on it';
    END IF;
    IF EXISTS (SELECT 1 FROM public.pos_device_sessions WHERE device_id = v_dev_a)
       OR NOT EXISTS (SELECT 1 FROM public.pos_devices WHERE id = v_dev_a AND revoked_at IS NOT NULL AND revoked_by = v_owner) THEN
      RAISE EXCEPTION 'S809 3h probe: tablet A is not revoked by the Owner with its filed sessions cleared';
    END IF;
    SELECT count(*) INTO v_n FROM public.audit_logs
     WHERE table_name = 'pos_devices' AND action = 'UPDATE' AND record_id = v_dev_a;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3h probe: revoking tablet A wrote % audit rows, not 1', v_n;
    END IF;

    -- ── (f) A sign-in landing after the revoke: refused, and its session ended at once ──────────
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    IF COALESCE(public.pos_record_device_session(v_c, v_dev_a, v_s7), true) THEN
      RAISE EXCEPTION 'S809 3h probe: a sign-in on a revoked tablet was filed';
    END IF;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM auth.sessions WHERE id = v_s7) THEN
      RAISE EXCEPTION 'S809 3h probe: a session opened on a tablet revoked under it was left open';
    END IF;

    -- ── (g) Revoking tablet A again is quiet: no error, no second audit row ─────────────────────
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.revoke_pos_device(v_dev_a);
    RESET ROLE;
    SELECT count(*) INTO v_n FROM public.audit_logs
     WHERE table_name = 'pos_devices' AND action = 'UPDATE' AND record_id = v_dev_a;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3h probe: revoking tablet A twice wrote % audit rows, not 1', v_n;
    END IF;

    -- ── (h) As the POS manager: revoking tablet B ends both sessions opened on it, theirs too ───
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    PERFORM public.revoke_pos_device(v_dev_b);
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM auth.sessions WHERE id IN (v_s2, v_s4))
       OR (SELECT count(*) FROM auth.sessions WHERE id IN (v_s3, v_s5, v_s6)) <> 3 THEN
      RAISE EXCEPTION 'S809 3h probe: revoking tablet B did not end exactly the two sessions opened on it';
    END IF;

    -- ── (i) Archive / Clear / Delete Client (admin-user-ops, the service role): every till login
    -- of the outlet is signed out, a session never filed included; the Owner and PKR are not ─────
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    SET LOCAL ROLE service_role;
    v_n := public.pos_revoke_till_sessions(v_c);
    RESET ROLE;
    IF v_n < 1 OR EXISTS (SELECT 1 FROM auth.sessions WHERE id = v_s3)
       OR (SELECT count(*) FROM auth.sessions WHERE id IN (v_s5, v_s6)) <> 2 THEN
      RAISE EXCEPTION 'S809 3h probe: pos_revoke_till_sessions ended % sessions, not the outlet''s till logins alone', v_n;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3h_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3h_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('revoke_pos_device', 'pos_record_device_session', 'pos_revoke_till_sessions');
--     expect revoke_pos_device 6955db8158fa45ca5b9a7bafc6358551 with
--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres};
--     pos_record_device_session ceb86579dde35daacf7eaad3dd8316c3 and pos_revoke_till_sessions 3e58477309e96c03373c0744c6d95120, both
--     {postgres=X/postgres,service_role=X/postgres}; prosecdef t for all three.
--   SELECT relrowsecurity, relacl FROM pg_class WHERE oid = 'public.pos_device_sessions'::regclass;
--     expect t, {postgres=arwdDxtm/postgres,service_role=…} with no anon or authenticated entry.
--   SELECT conname, confdeltype FROM pg_constraint
--    WHERE conrelid = 'public.pos_device_sessions'::regclass AND contype = 'f';   -- 3 rows, all c
--   SELECT count(*) FROM public.pos_device_sessions;   -- 0 until a till signs in on the new pos-staff-login
--   SELECT count(*) FROM public.pos_login_reference_columns();   -- unchanged (46): every key here cascades
