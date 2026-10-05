-- S798 stage 4f (SELF-SERVICE-6) — a sign-in the server could not complete gives its PIN attempt back.
--
-- S791 made the three PIN sign-in Edge Functions (hr-selfservice-login, pos-staff-login,
-- ims-staff-login) count each attempt as a FAILURE before signing in (reserve_*_pin_attempt,
-- migration 20260928120000), and reset the counter on a correct PIN. What it left counted is the
-- attempt GoTrue never judged: a 429 or 5xx during a busy shift change, a dropped connection, a
-- reply with no session. The functions dropped the sign-in error, so each of those said "Incorrect
-- PIN" and stayed counted, and five of them locked out an employee typing the correct PIN for 15
-- minutes. The functions now read the error and count only an answer about the account
-- (invalid_credentials, user_banned); for anything else they give the attempt back here and
-- answer 503.
--
-- WHY NOT record_*_pin_attempt(true). That is the reset on a correct PIN: it zeroes the whole
-- counter, so giving one attempt back with it would also forgive every real wrong PIN before it.
--
-- release_*_pin_attempt(p_staff_id, p_locked_until) undoes exactly one reservation:
--   * the count drops by one, never below 0;
--   * the lock is lifted only when it is the stamp THIS reservation set (the 5th attempt returns
--     the lock it set as locked_until; the function passes that back). A lock another attempt set
--     stays: an earlier reservation that comes back unanswered passes NULL and leaves it.
--   * true when the account was found (of the kind, as reserve_* reads it), else false.
-- An expired stamp the reservation cleared is not put back: it would only restart the count at 1,
-- which a count of 0 already does.
--
-- Same account-kind predicates and the same audit position as reserve_* (log_audit()'s profiles
-- noise-skip strips the *_pin_failed_attempts / *_pin_locked_until pairs, so a release writes no
-- audit_logs row; the probe below proves it with real writes).
--
-- GRANTS. service_role only: a browser able to release could undo its own wrong PINs and walk a
-- 4-digit PIN with the lockout never firing.
--
-- DEPLOY ORDER: this migration, then the three functions. The other order is safe: a release that
-- is not in the schema cache fails, is logged, and the function still answers 503 (the attempt
-- stays counted, as before this change).
--
-- REVERSE: DROP FUNCTION public.release_hr_pin_attempt(uuid, timestamptz),
-- public.release_pos_pin_attempt(uuid, timestamptz), public.release_ims_pin_attempt(uuid, timestamptz);
-- then NOTIFY pgrst, 'reload schema'. The deployed functions then log a failed release and keep
-- the attempt counted.

-- ── hr: HR Self-Service (hr-selfservice-login) ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_hr_pin_attempt(p_staff_id uuid, p_locked_until timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_staff_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE profiles
     SET hr_pin_failed_attempts = GREATEST(hr_pin_failed_attempts - 1, 0),
         hr_pin_locked_until = CASE
           WHEN p_locked_until IS NOT NULL AND hr_pin_locked_until = p_locked_until THEN NULL
           ELSE hr_pin_locked_until
         END
   WHERE id = p_staff_id
     AND hr_self_service = true;

  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.release_hr_pin_attempt(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_hr_pin_attempt(uuid, timestamptz) TO service_role;

-- ── pos: the till (pos-staff-login) ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_pos_pin_attempt(p_staff_id uuid, p_locked_until timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_staff_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE profiles
     SET pos_pin_failed_attempts = GREATEST(pos_pin_failed_attempts - 1, 0),
         pos_pin_locked_until = CASE
           WHEN p_locked_until IS NOT NULL AND pos_pin_locked_until = p_locked_until THEN NULL
           ELSE pos_pin_locked_until
         END
   WHERE id = p_staff_id
     AND pos_role IS NOT NULL AND pos_email IS NOT NULL;

  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.release_pos_pin_attempt(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_pos_pin_attempt(uuid, timestamptz) TO service_role;

-- ── ims: Stock Count (ims-staff-login) ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.release_ims_pin_attempt(p_staff_id uuid, p_locked_until timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF p_staff_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE profiles
     SET ims_pin_failed_attempts = GREATEST(ims_pin_failed_attempts - 1, 0),
         ims_pin_locked_until = CASE
           WHEN p_locked_until IS NOT NULL AND ims_pin_locked_until = p_locked_until THEN NULL
           ELSE ims_pin_locked_until
         END
   WHERE id = p_staff_id
     AND ims_role IS NOT NULL AND ims_email IS NOT NULL;

  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.release_ims_pin_attempt(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_ims_pin_attempt(uuid, timestamptz) TO service_role;

-- ── Assertions ───────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.release_hr_pin_attempt(uuid, timestamptz)',
                              'public.release_pos_pin_attempt(uuid, timestamptz)',
                              'public.release_ims_pin_attempt(uuid, timestamptz)'] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'S798 4f: % does not exist', v_fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION 'S798 4f: % must be SECURITY DEFINER', v_fn;
    END IF;
    IF NOT COALESCE((SELECT 'search_path=public' = ANY (proconfig) FROM pg_proc WHERE oid = v_fn::regprocedure), false) THEN
      RAISE EXCEPTION 'S798 4f: % must pin search_path to public', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S798 4f: % must be service_role-only', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc
       WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('release_hr_pin_attempt', 'release_pos_pin_attempt', 'release_ims_pin_attempt')) <> 3 THEN
    RAISE EXCEPTION 'S798 4f: a release_*_pin_attempt function has more than one signature';
  END IF;
  -- The reservation it undoes must still exist and still be the Edge Functions' alone.
  FOREACH v_fn IN ARRAY ARRAY['public.reserve_hr_pin_attempt(uuid)', 'public.reserve_pos_pin_attempt(uuid)',
                              'public.reserve_ims_pin_attempt(uuid)'] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'S798 4f: % is gone, and the sign-in functions still call it', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'S798 4f: % must be service_role-only', v_fn;
    END IF;
  END LOOP;
END;
$$;

-- ── Verification: real writes, rolled back ───────────────────────────────────────────────────────
-- A plpgsql body is not validated at CREATE time, so each release is run against its reservation on
-- one real PIN account of its kind, inside a savepoint (the inner BEGIN block) that a deliberate
-- RAISE rolls back; the account's counters come out unchanged. What it proves, per kind:
--   * reserve then release puts the count back (1 → 0), and a second release stays at 0;
--   * from 3: reserve (4), reserve (5, locks), release with the 5th's stamp → 4 and unlocked, the
--     stamp passed as text as the Edge Function passes it;
--   * from 4: the 5th locks, an earlier reservation released with NULL → 4 and STILL locked;
--   * a stamp that is not the lock's lifts nothing;
--   * an unknown uuid, NULL, and an account of another kind return false, and the other account's
--     counter does not move;
--   * none of it writes an audit_logs row.
-- Skipped for a kind with no account, with a NOTICE.
DO $$
DECLARE
  k text;
  v_pred text;
  v_res text;
  v_rel text;
  v_att text;
  v_lock text;
  v_id uuid;
  v_other uuid;
  v_out text;
  v_until timestamptz;
  v_ok boolean;
  v_n integer;
  v_lu timestamptz;
  v_other_before integer;
  v_floor bigint;
  v_audit bigint;
BEGIN
  SELECT COALESCE(max(id), 0) INTO v_floor FROM public.audit_logs;
  FOREACH k IN ARRAY ARRAY['hr', 'pos', 'ims'] LOOP
    v_pred := CASE k
                WHEN 'hr'  THEN 'hr_self_service = true'
                WHEN 'pos' THEN 'pos_role IS NOT NULL AND pos_email IS NOT NULL'
                WHEN 'ims' THEN 'ims_role IS NOT NULL AND ims_email IS NOT NULL'
              END;
    v_res  := format('reserve_%s_pin_attempt', k);
    v_rel  := format('release_%s_pin_attempt', k);
    v_att  := format('%s_pin_failed_attempts', k);
    v_lock := format('%s_pin_locked_until', k);
    v_id := NULL; v_other := NULL;
    EXECUTE format('SELECT id FROM public.profiles WHERE %s ORDER BY id LIMIT 1', v_pred) INTO v_id;
    IF v_id IS NULL THEN
      RAISE NOTICE 'S798 4f probe: no % PIN account to exercise; skipped', k;
      CONTINUE;
    END IF;
    EXECUTE format('SELECT id FROM public.profiles WHERE NOT COALESCE(%s, false) ORDER BY id LIMIT 1', v_pred) INTO v_other;
    BEGIN
      -- 1. reserve → 1, release → 0, release again → still 0.
      EXECUTE format('UPDATE public.profiles SET %I = 0, %I = NULL WHERE id = $1', v_att, v_lock) USING v_id;
      EXECUTE format('SELECT outcome FROM public.%I($1)', v_res) INTO v_out USING v_id;
      EXECUTE format('SELECT public.%I($1, NULL)', v_rel) INTO v_ok USING v_id;
      EXECUTE format('SELECT %I, %I FROM public.profiles WHERE id = $1', v_att, v_lock) INTO v_n, v_lu USING v_id;
      IF v_out IS DISTINCT FROM 'reserved' OR v_ok IS DISTINCT FROM true OR v_n IS DISTINCT FROM 0 OR v_lu IS NOT NULL THEN
        RAISE EXCEPTION 'S798 4f probe (%): reserve then release gave (%, %), stored (%, %)', k, v_out, v_ok, v_n, v_lu;
      END IF;
      EXECUTE format('SELECT public.%I($1, NULL)', v_rel) INTO v_ok USING v_id;
      EXECUTE format('SELECT %I FROM public.profiles WHERE id = $1', v_att) INTO v_n USING v_id;
      IF v_ok IS DISTINCT FROM true OR v_n IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'S798 4f probe (%): a release at 0 gave %, stored %', k, v_ok, v_n;
      END IF;

      -- 2. from 3: the 4th reserves, the 5th locks; releasing the 5th with its own stamp unlocks at 4.
      EXECUTE format('UPDATE public.profiles SET %I = 3, %I = NULL WHERE id = $1', v_att, v_lock) USING v_id;
      EXECUTE format('SELECT outcome FROM public.%I($1)', v_res) INTO v_out USING v_id;
      EXECUTE format('SELECT outcome, locked_until FROM public.%I($1)', v_res) INTO v_out, v_until USING v_id;
      IF v_out IS DISTINCT FROM 'reserved' OR NOT COALESCE(v_until > now(), false) THEN
        RAISE EXCEPTION 'S798 4f probe (%): the 5th reservation returned (%, %)', k, v_out, v_until;
      END IF;
      EXECUTE format('SELECT public.%I($1, $2::text::timestamptz)', v_rel) INTO v_ok USING v_id, v_until;
      EXECUTE format('SELECT %I, %I FROM public.profiles WHERE id = $1', v_att, v_lock) INTO v_n, v_lu USING v_id;
      IF v_ok IS DISTINCT FROM true OR v_n IS DISTINCT FROM 4 OR v_lu IS NOT NULL THEN
        RAISE EXCEPTION 'S798 4f probe (%): releasing the locking attempt left (%, %)', k, v_n, v_lu;
      END IF;

      -- 3. from 4: the 5th locks; an earlier reservation released with NULL leaves the lock.
      EXECUTE format('SELECT outcome, locked_until FROM public.%I($1)', v_res) INTO v_out, v_until USING v_id;
      EXECUTE format('SELECT public.%I($1, NULL)', v_rel) INTO v_ok USING v_id;
      EXECUTE format('SELECT %I, %I FROM public.profiles WHERE id = $1', v_att, v_lock) INTO v_n, v_lu USING v_id;
      IF v_ok IS DISTINCT FROM true OR v_n IS DISTINCT FROM 4 OR v_lu IS DISTINCT FROM v_until THEN
        RAISE EXCEPTION 'S798 4f probe (%): releasing a non-locking attempt left (%, %), lock was %', k, v_n, v_lu, v_until;
      END IF;

      -- 4. a stamp that is not the lock's lifts nothing.
      EXECUTE format('SELECT public.%I($1, $2)', v_rel) INTO v_ok USING v_id, v_until + interval '1 second';
      EXECUTE format('SELECT %I, %I FROM public.profiles WHERE id = $1', v_att, v_lock) INTO v_n, v_lu USING v_id;
      IF v_n IS DISTINCT FROM 3 OR v_lu IS DISTINCT FROM v_until THEN
        RAISE EXCEPTION 'S798 4f probe (%): a foreign stamp left (%, %), lock was %', k, v_n, v_lu, v_until;
      END IF;

      -- 5. unknown, NULL, and another kind of account: false, nothing moves.
      EXECUTE format('SELECT public.%I($1, NULL)', v_rel) INTO v_ok USING gen_random_uuid();
      IF v_ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'S798 4f probe (%): an unknown account returned %', k, v_ok;
      END IF;
      EXECUTE format('SELECT public.%I($1, NULL)', v_rel) INTO v_ok USING NULL::uuid;
      IF v_ok IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'S798 4f probe (%): a NULL staff id returned %', k, v_ok;
      END IF;
      IF v_other IS NOT NULL THEN
        EXECUTE format('UPDATE public.profiles SET %I = 2 WHERE id = $1', v_att) USING v_other;
        EXECUTE format('SELECT public.%I($1, NULL)', v_rel) INTO v_ok USING v_other;
        EXECUTE format('SELECT %I FROM public.profiles WHERE id = $1', v_att) INTO v_n USING v_other;
        IF v_ok IS DISTINCT FROM false OR v_n IS DISTINCT FROM 2 THEN
          RAISE EXCEPTION 'S798 4f probe (%): an account of another kind returned % and moved its counter from 2 to %', k, v_ok, v_n;
        END IF;
      END IF;

      SELECT count(*) INTO v_audit FROM public.audit_logs
       WHERE id > v_floor AND table_name = 'profiles' AND record_id = ANY (ARRAY[v_id, v_other]);
      IF v_audit <> 0 THEN
        RAISE EXCEPTION 'S798 4f probe (%): % audit_logs row(s) written for lockout-only updates — log_audit()''s profiles noise-skip no longer covers them', k, v_audit;
      END IF;

      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's798_4f_probe_rollback';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 's798_4f_probe_rollback' THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
