-- S791 — a PIN attempt is counted BEFORE the sign-in, not after it.
--
-- Found in hss-suite (batch 4 re-analysis #37, filed in docs/CROSS-REPO.md there) and confirmed here
-- in all three PIN sign-in Edge Functions. hr-selfservice-login, pos-staff-login and ims-staff-login
-- each ran
--
--   check_*_pin_lock  →  look up the account  →  signInWithPassword  →  record_*_pin_attempt
--
-- so every request of a parallel burst passed the check before the 5th failure was recorded, and a
-- burst of wrong PINs got as many guesses as it had requests in flight, not 5. On HR Self-Service
-- every input such a burst needs is public by design: the staff ids come from the anon picker and
-- the client id from the QR link handed to all staff.
--
-- THE FIX. reserve_*_pin_attempt(p_staff_id) counts the attempt as a FAILURE up front, in ONE
-- UPDATE that also refuses while the account is locked. The UPDATE takes the row lock, so concurrent
-- reservations queue and each one sees the count the previous one left: the 6th request of a burst
-- finds the lock the 5th set and is refused without a sign-in. The Edge Function signs in only
-- holding a reservation. A correct PIN then resets through the existing record_*_pin_attempt(true);
-- a wrong one needs no second write, because it was counted already.
--
--   outcome 'reserved'  counted. locked_until is set only when THIS attempt locked the account.
--   outcome 'locked'    refused, nothing counted. locked_until is when the lock ends.
--   outcome 'reject'    no account of that kind. Nothing counted, so naming a uuid cannot drive
--                       its counter (the rule the functions' account lookups already follow).
--
-- MIRRORED FROM THE LIVE BODIES (pg_get_functiondef, 2026-09-28). The account-kind predicates:
--   hr   hr_self_service = true                           (check_/record_hr_pin_*)
--   pos  pos_role IS NOT NULL AND pos_email IS NOT NULL    (check_/record_pos_pin_*)
--   ims  ims_role IS NOT NULL AND ims_email IS NOT NULL    (check_/record_ims_pin_*)
-- and one rule for all three: a failure counts n = 1 when a previous lock has expired, else
-- attempts + 1, and n >= 5 locks for 15 minutes. hss-suite's stepped 5/10/15 rule is deliberately
-- NOT adopted, and no column is added.
--
-- ONE DELIBERATE DIFFERENCE from record_*(false): an expired lock stamp is CLEARED when the count
-- restarts. record_* keeps it (`ELSE *_pin_locked_until`), so every later failure sees the same
-- expired stamp and computes n = 1 again. After an account's first lockout ends, its counter is
-- pinned at 1 and it can never lock again until a correct PIN clears the stamp. A pure-SELECT
-- simulation of the live CASE confirmed this on 2026-09-28; no live account was in that state that
-- day. Clearing the stamp is what makes "5 failures → 15 minutes" hold on every cycle, not only the
-- first. record_*(false) keeps the defect: after this migration and the three deploys it runs only
-- on the PGRST202 fallback path.
--
-- WHAT STAYS. check_*_pin_lock and record_*_pin_attempt are unchanged. record_*(true) is still the
-- reset on a correct PIN, the pre-S791 deployed functions call both until they are redeployed, and
-- the S791 functions fall back to them when reserve_* is not in the schema cache (PGRST202, the
-- S754 verify_pos_legacy_device precedent), so a deploy-order slip cannot lock out every till.
--
-- AUDIT. The UPDATE writes only *_pin_failed_attempts and *_pin_locked_until. log_audit()'s profiles
-- noise-skip (read live 2026-09-28) strips pos_/hr_/ims_pin_failed_attempts, their *_pin_locked_until
-- pairs and last_seen_at before comparing OLD with NEW, so a reservation writes no audit_logs row,
-- the same as record_* today. The probe at the end proves it with real writes.
-- guard_profiles_privileged_columns() returns at once for a current_user outside anon and
-- authenticated, which a SECURITY DEFINER body always is.
--
-- GRANTS. service_role only; the Edge Functions are the one caller. A browser able to call a
-- reservation could lock any listed employee out, and a call that moved to the server takes its
-- grant with it (supabase-sql.md, S532).
--
-- DEPLOY ORDER: this migration, then hr-selfservice-login, pos-staff-login and ims-staff-login.
-- The other order is safe too: PGRST202 sends them down the old check-then-record path, logged.
--
-- REVERSE: DROP FUNCTION public.reserve_hr_pin_attempt(uuid), public.reserve_pos_pin_attempt(uuid),
-- public.reserve_ims_pin_attempt(uuid); then NOTIFY pgrst, 'reload schema'. The S791 functions then
-- fall back to check-then-record on PGRST202, burst gap included. Redeploy the three functions'
-- pre-S791 versions from git history to drop the fallback and its log line.

-- ── hr: HR Self-Service (hr-selfservice-login) ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_hr_pin_attempt(p_staff_id uuid)
RETURNS TABLE(outcome text, locked_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  IF p_staff_id IS NULL THEN
    outcome := 'reject'; locked_until := NULL;
    RETURN NEXT; RETURN;
  END IF;

  -- record_hr_pin_attempt(false)'s arithmetic, plus the lock test in the WHERE and the expired stamp
  -- cleared (ELSE NULL: the WHERE leaves only a NULL or an expired stamp to replace).
  UPDATE profiles
     SET hr_pin_failed_attempts = CASE
           WHEN hr_pin_locked_until IS NOT NULL AND hr_pin_locked_until <= now() THEN 1
           ELSE hr_pin_failed_attempts + 1
         END,
         hr_pin_locked_until = CASE
           WHEN (CASE WHEN hr_pin_locked_until IS NOT NULL AND hr_pin_locked_until <= now() THEN 1
                      ELSE hr_pin_failed_attempts + 1 END) >= 5
           THEN now() + interval '15 minutes'
           ELSE NULL
         END
   WHERE id = p_staff_id
     AND hr_self_service = true
     AND (hr_pin_locked_until IS NULL OR hr_pin_locked_until <= now())
  RETURNING hr_pin_locked_until INTO v_until;

  IF FOUND THEN
    outcome := 'reserved';
    locked_until := CASE WHEN v_until > now() THEN v_until END;
    RETURN NEXT; RETURN;
  END IF;

  SELECT hr_pin_locked_until INTO v_until
    FROM profiles
   WHERE id = p_staff_id AND hr_self_service = true;

  IF COALESCE(FOUND AND v_until > now(), false) THEN
    outcome := 'locked'; locked_until := v_until;
  ELSE
    outcome := 'reject'; locked_until := NULL;
  END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_hr_pin_attempt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_hr_pin_attempt(uuid) TO service_role;

-- ── pos: the till (pos-staff-login) ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_pos_pin_attempt(p_staff_id uuid)
RETURNS TABLE(outcome text, locked_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  IF p_staff_id IS NULL THEN
    outcome := 'reject'; locked_until := NULL;
    RETURN NEXT; RETURN;
  END IF;

  UPDATE profiles
     SET pos_pin_failed_attempts = CASE
           WHEN pos_pin_locked_until IS NOT NULL AND pos_pin_locked_until <= now() THEN 1
           ELSE pos_pin_failed_attempts + 1
         END,
         pos_pin_locked_until = CASE
           WHEN (CASE WHEN pos_pin_locked_until IS NOT NULL AND pos_pin_locked_until <= now() THEN 1
                      ELSE pos_pin_failed_attempts + 1 END) >= 5
           THEN now() + interval '15 minutes'
           ELSE NULL
         END
   WHERE id = p_staff_id
     AND pos_role IS NOT NULL AND pos_email IS NOT NULL
     AND (pos_pin_locked_until IS NULL OR pos_pin_locked_until <= now())
  RETURNING pos_pin_locked_until INTO v_until;

  IF FOUND THEN
    outcome := 'reserved';
    locked_until := CASE WHEN v_until > now() THEN v_until END;
    RETURN NEXT; RETURN;
  END IF;

  SELECT pos_pin_locked_until INTO v_until
    FROM profiles
   WHERE id = p_staff_id AND pos_role IS NOT NULL AND pos_email IS NOT NULL;

  IF COALESCE(FOUND AND v_until > now(), false) THEN
    outcome := 'locked'; locked_until := v_until;
  ELSE
    outcome := 'reject'; locked_until := NULL;
  END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_pos_pin_attempt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_pos_pin_attempt(uuid) TO service_role;

-- ── ims: the stock-count tablet (ims-staff-login) ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reserve_ims_pin_attempt(p_staff_id uuid)
RETURNS TABLE(outcome text, locked_until timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_until timestamptz;
BEGIN
  IF p_staff_id IS NULL THEN
    outcome := 'reject'; locked_until := NULL;
    RETURN NEXT; RETURN;
  END IF;

  UPDATE profiles
     SET ims_pin_failed_attempts = CASE
           WHEN ims_pin_locked_until IS NOT NULL AND ims_pin_locked_until <= now() THEN 1
           ELSE ims_pin_failed_attempts + 1
         END,
         ims_pin_locked_until = CASE
           WHEN (CASE WHEN ims_pin_locked_until IS NOT NULL AND ims_pin_locked_until <= now() THEN 1
                      ELSE ims_pin_failed_attempts + 1 END) >= 5
           THEN now() + interval '15 minutes'
           ELSE NULL
         END
   WHERE id = p_staff_id
     AND ims_role IS NOT NULL AND ims_email IS NOT NULL
     AND (ims_pin_locked_until IS NULL OR ims_pin_locked_until <= now())
  RETURNING ims_pin_locked_until INTO v_until;

  IF FOUND THEN
    outcome := 'reserved';
    locked_until := CASE WHEN v_until > now() THEN v_until END;
    RETURN NEXT; RETURN;
  END IF;

  SELECT ims_pin_locked_until INTO v_until
    FROM profiles
   WHERE id = p_staff_id AND ims_role IS NOT NULL AND ims_email IS NOT NULL;

  IF COALESCE(FOUND AND v_until > now(), false) THEN
    outcome := 'locked'; locked_until := v_until;
  ELSE
    outcome := 'reject'; locked_until := NULL;
  END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_ims_pin_attempt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ims_pin_attempt(uuid) TO service_role;

-- ── Assertions ───────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.reserve_hr_pin_attempt(uuid)', 'public.reserve_pos_pin_attempt(uuid)',
                              'public.reserve_ims_pin_attempt(uuid)'] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'S791: % does not exist', v_fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'S791: % must be SECURITY DEFINER', v_fn;
    END IF;
    IF NOT COALESCE((SELECT 'search_path=public' = ANY (proconfig) FROM pg_proc WHERE oid = v_fn::regprocedure), false) THEN
      RAISE EXCEPTION 'S791: % must pin search_path to public', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S791: % must be service_role-only', v_fn;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('reserve_hr_pin_attempt', 'reserve_pos_pin_attempt', 'reserve_ims_pin_attempt')) <> 3 THEN
    RAISE EXCEPTION 'S791: a reserve_*_pin_attempt function has more than one signature';
  END IF;

  -- The pair the reservation works beside: record_*(true) is the reset on a correct PIN, and both
  -- are the PGRST202 fallback. They must still exist and still be the Edge Functions' alone.
  FOREACH v_fn IN ARRAY ARRAY['public.check_hr_pin_lock(uuid)', 'public.record_hr_pin_attempt(uuid, boolean)',
                              'public.check_pos_pin_lock(uuid)', 'public.record_pos_pin_attempt(uuid, boolean)',
                              'public.check_ims_pin_lock(uuid)', 'public.record_ims_pin_attempt(uuid, boolean)'] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'S791: % is gone, and the sign-in functions still call it', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S791: % must be service_role-only', v_fn;
    END IF;
  END LOOP;
END;
$$;

-- ── Verification: real writes, rolled back ───────────────────────────────────────────────────────
-- A plpgsql body is not validated at CREATE time, so each function is called on one real PIN account
-- of its kind inside a savepoint (the inner BEGIN block) that a deliberate RAISE rolls back; the
-- account's counters come out unchanged. What it proves, per kind:
--   * 5 reservations count 1..5 and the 5th returns the lock it set; the 6th is 'locked' and counts
--     nothing;
--   * after the lock expires the count restarts at 1 with the stamp cleared, and the next failure
--     is 2 (record_*(false) would say 1 again);
--   * record_*(true) still resets both columns;
--   * an unknown uuid, NULL, and an account of another kind are 'reject', and the other account's
--     counter does not move;
--   * none of it writes an audit_logs row (log_audit()'s profiles noise-skip).
-- Skipped for a kind with no account, with a NOTICE.
DO $$
DECLARE
  k text;
  v_pred text;
  v_fn text;
  v_att text;
  v_lock text;
  v_id uuid;
  v_other uuid;
  v_out text;
  v_until timestamptz;
  v_n integer;
  v_lu timestamptz;
  v_other_before integer;
  v_floor bigint;
  v_audit bigint;
  i integer;
BEGIN
  SELECT COALESCE(max(id), 0) INTO v_floor FROM public.audit_logs;

  FOREACH k IN ARRAY ARRAY['hr', 'pos', 'ims'] LOOP
    v_pred := CASE k
                WHEN 'hr'  THEN 'hr_self_service = true'
                WHEN 'pos' THEN 'pos_role IS NOT NULL AND pos_email IS NOT NULL'
                WHEN 'ims' THEN 'ims_role IS NOT NULL AND ims_email IS NOT NULL'
              END;
    v_fn   := format('reserve_%s_pin_attempt', k);
    v_att  := format('%s_pin_failed_attempts', k);
    v_lock := format('%s_pin_locked_until', k);

    v_id := NULL; v_other := NULL;
    EXECUTE format('SELECT id FROM public.profiles WHERE %s ORDER BY id LIMIT 1', v_pred) INTO v_id;
    IF v_id IS NULL THEN
      RAISE NOTICE 'S791 probe: no % PIN account to exercise; skipped', k;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT id FROM public.profiles WHERE NOT COALESCE(%s, false) ORDER BY id LIMIT 1', v_pred) INTO v_other;

    BEGIN
      EXECUTE format('UPDATE public.profiles SET %I = 0, %I = NULL WHERE id = $1', v_att, v_lock) USING v_id;

      FOR i IN 1..5 LOOP
        EXECUTE format('SELECT outcome, locked_until FROM public.%I($1)', v_fn) INTO v_out, v_until USING v_id;
        EXECUTE format('SELECT %I FROM public.profiles WHERE id = $1', v_att) INTO v_n USING v_id;
        IF v_out IS DISTINCT FROM 'reserved' OR v_n IS DISTINCT FROM i
           OR (i < 5 AND v_until IS NOT NULL)
           OR (i = 5 AND NOT COALESCE(v_until > now(), false)) THEN
          RAISE EXCEPTION 'S791 probe (%): reservation % returned (%, %) with % attempts stored', k, i, v_out, v_until, v_n;
        END IF;
      END LOOP;

      EXECUTE format('SELECT outcome, locked_until FROM public.%I($1)', v_fn) INTO v_out, v_until USING v_id;
      EXECUTE format('SELECT %I FROM public.profiles WHERE id = $1', v_att) INTO v_n USING v_id;
      IF v_out IS DISTINCT FROM 'locked' OR NOT COALESCE(v_until > now(), false) OR v_n IS DISTINCT FROM 5 THEN
        RAISE EXCEPTION 'S791 probe (%): a locked account returned (%, %) with % attempts stored', k, v_out, v_until, v_n;
      END IF;

      EXECUTE format('UPDATE public.profiles SET %I = now() - interval ''1 second'' WHERE id = $1', v_lock) USING v_id;
      FOR i IN 1..2 LOOP
        EXECUTE format('SELECT outcome, locked_until FROM public.%I($1)', v_fn) INTO v_out, v_until USING v_id;
        EXECUTE format('SELECT %I, %I FROM public.profiles WHERE id = $1', v_att, v_lock) INTO v_n, v_lu USING v_id;
        IF v_out IS DISTINCT FROM 'reserved' OR v_until IS NOT NULL OR v_n IS DISTINCT FROM i OR v_lu IS NOT NULL THEN
          RAISE EXCEPTION 'S791 probe (%): after an expired lock, reservation % returned (%, %), stored (%, %)', k, i, v_out, v_until, v_n, v_lu;
        END IF;
      END LOOP;

      EXECUTE format('SELECT 1 FROM public.%I($1, true)', format('record_%s_pin_attempt', k)) USING v_id;
      EXECUTE format('SELECT %I, %I FROM public.profiles WHERE id = $1', v_att, v_lock) INTO v_n, v_lu USING v_id;
      IF v_n IS DISTINCT FROM 0 OR v_lu IS NOT NULL THEN
        RAISE EXCEPTION 'S791 probe (%): record_%_pin_attempt(true) left (%, %)', k, k, v_n, v_lu;
      END IF;

      EXECUTE format('SELECT outcome FROM public.%I($1)', v_fn) INTO v_out USING gen_random_uuid();
      IF v_out IS DISTINCT FROM 'reject' THEN
        RAISE EXCEPTION 'S791 probe (%): an unknown account returned %', k, v_out;
      END IF;
      EXECUTE format('SELECT outcome FROM public.%I($1)', v_fn) INTO v_out USING NULL::uuid;
      IF v_out IS DISTINCT FROM 'reject' THEN
        RAISE EXCEPTION 'S791 probe (%): a NULL staff id returned %', k, v_out;
      END IF;
      IF v_other IS NOT NULL THEN
        EXECUTE format('SELECT %I FROM public.profiles WHERE id = $1', v_att) INTO v_other_before USING v_other;
        EXECUTE format('SELECT outcome FROM public.%I($1)', v_fn) INTO v_out USING v_other;
        EXECUTE format('SELECT %I FROM public.profiles WHERE id = $1', v_att) INTO v_n USING v_other;
        IF v_out IS DISTINCT FROM 'reject' OR v_n IS DISTINCT FROM v_other_before THEN
          RAISE EXCEPTION 'S791 probe (%): an account of another kind returned % and moved its counter from % to %', k, v_out, v_other_before, v_n;
        END IF;
      END IF;

      SELECT count(*) INTO v_audit FROM public.audit_logs
       WHERE id > v_floor AND table_name = 'profiles' AND record_id = ANY (ARRAY[v_id, v_other]);
      IF v_audit <> 0 THEN
        RAISE EXCEPTION 'S791 probe (%): % audit_logs row(s) written for lockout-only updates — log_audit()''s profiles noise-skip no longer covers them', k, v_audit;
      END IF;

      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's791_probe_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 's791_probe_rollback' THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
