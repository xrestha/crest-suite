-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Four SECURITY DEFINER guards fail OPEN for an authenticated session that has no profiles row.
--
-- is_admin() is a LANGUAGE sql scalar:
--
--     select role = 'admin' from profiles where id = auth.uid()
--
-- With no matching row it returns NULL, not false. So the natural guard
--
--     IF NOT public.is_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
--
-- evaluates NOT NULL -> NULL, and IF NULL THEN never fires: execution falls straight through to
-- the privileged body. Every other operand that can be NULL does the same thing --
-- p_client_id = my_client_id() is NULL for that caller, and false OR NULL is still NULL.
--
-- Worst of the four is admin_clear_audit_logs, because all three of its parameters DEFAULT NULL.
-- Each filter clause is written (p_x IS NULL OR col = p_x), so an argument-less call collapses
-- every clause to TRUE and the body is an unfiltered DELETE FROM audit_logs -- the entire
-- forensic record, for every tenant, returning the row count. `authenticated` holds EXECUTE on
-- it. The other three leak rather than destroy: an email -> user-uuid oracle over all of
-- auth.users, any client's menu co-occurrence, and any client's self-service roster.
--
-- Reachable because handle_new_user() ends `exception when others then return new`, so any
-- failure of its profile insert leaves an auth account that signs in normally and permanently
-- has no profiles row. (Deliberately NOT changed here -- tightening that handler can hard-fail
-- signups, which is a separate decision.) An already-issued access token also outlives the
-- profile row by up to its TTL after an admin deletes a user.
--
-- This is the trap CLAUDE.md already names from S531/S579: "assume any three-valued expression
-- in a guard is a fail-open until it is wrapped". set_active_outlet (S617) is the one place that
-- got it right; these four all predate that rule.
--
-- ── Why the fix is at the guard and NOT in is_admin() ───────────────────────────────────────
-- Hardening is_admin() to return false would not close get_cooccurrence or
-- get_hr_self_service_status: their second operand (p_client_id = <profile lookup>) is
-- independently NULL for the same caller, and `false OR NULL` is still NULL, so both would keep
-- falling open while looking fixed. Wrapping the whole condition handles every NULL source at
-- once and matches what set_active_outlet already does. Changing is_admin() would also change
-- how it evaluates inside ~50 RLS policies, where NULL and false are already indistinguishable
-- -- a wide blast radius bought for no additional coverage.
--
-- get_pos_device_secret matches the same shape and is deliberately left alone: its preceding
-- `IF caller_client_id IS DISTINCT FROM p_client_id` is NULL-safe and raises first, so the
-- fail-open line below it is unreachable. Rewriting it would be churn.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- All-or-nothing: the assertions at the bottom must be able to roll the whole thing back. The
-- Dashboard SQL Editor otherwise keeps every statement before the failing one.
BEGIN;

-- ── 1. The four guards ──────────────────────────────────────────────────────────────────────
-- Bodies are otherwise byte-identical to their current definitions; only the guard line moves.

CREATE OR REPLACE FUNCTION public.admin_clear_audit_logs(
    p_client_id uuid DEFAULT NULL::uuid,
    p_table_name text DEFAULT NULL::text,
    p_cutoff timestamp with time zone DEFAULT NULL::timestamp with time zone
) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  DELETE FROM audit_logs
  WHERE
    (p_client_id  IS NULL OR client_id  = p_client_id)
    AND (p_table_name IS NULL OR table_name = p_table_name)
    AND (p_cutoff     IS NULL OR created_at >= p_cutoff);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Was `IF (SELECT role FROM profiles WHERE id = auth.uid()) <> 'admin'`, which is the same
-- fail-open in its other common spelling: NULL <> 'admin' is NULL, so the IF never fires. Uses
-- is_admin() now so this file leaves exactly one idiom behind instead of two.
CREATE OR REPLACE FUNCTION public.find_user_id_by_email(p_email text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  uid uuid;
BEGIN
  IF NOT COALESCE(public.is_admin(), false) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  SELECT id INTO uid FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
  RETURN uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_cooccurrence(
    p_client_id uuid, p_recipe_id uuid, p_days integer DEFAULT 90
) RETURNS TABLE(paired_recipe_id uuid, co_count bigint)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT COALESCE(
    public.is_admin() OR p_client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()),
    false
  ) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;

  RETURN QUERY
    SELECT b.recipe_id AS paired_recipe_id, COUNT(*) AS co_count
    FROM pos_order_items a
    JOIN pos_order_items b ON a.order_id = b.order_id AND a.recipe_id != b.recipe_id
    JOIN pos_orders o ON o.id = a.order_id
    WHERE a.client_id = p_client_id
      AND a.recipe_id = p_recipe_id
      AND o.created_at >= NOW() - (p_days || ' days')::INTERVAL
    GROUP BY b.recipe_id
    ORDER BY co_count DESC
    LIMIT 10;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_hr_self_service_status(p_client_id uuid) RETURNS TABLE(
    employee_id uuid, profile_id uuid
) LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT COALESCE(public.is_admin() OR p_client_id = public.my_client_id(), false) THEN
    RAISE EXCEPTION 'not authorized for this client';
  END IF;
  RETURN QUERY
    SELECT hr_employee_id, id FROM profiles
    WHERE client_id = p_client_id AND hr_self_service = true AND hr_employee_id IS NOT NULL;
END;
$$;

-- ── 2. submit_guest_order: the 3-arg overload was never dropped ─────────────────────────────
-- 20260707230000 added p_covers and its comment claims that appending a trailing defaulted
-- parameter is "CREATE OR REPLACE-compatible ... no DROP needed". That is wrong: Postgres keys
-- CREATE OR REPLACE on the full argument-type signature, so it created a SECOND function. Both
-- have been live and anon-executable since 2026-07-07, and every later fix landed only on the
-- 4-arg body -- the covers clamp, and the unique_violation handler that turns the
-- one-pending-per-table index into a sentence a guest can actually read.
--
-- The DoS control itself is unaffected either way: it is a partial unique index on the table,
-- not logic in the function, so it binds whichever overload writes.
--
-- Nothing calls the 3-arg one today -- GuestMenu.jsx always sends all four. What makes it worth
-- removing rather than documenting is the covers default: a 3-key call writes covers = 1, and
-- PosOrders.jsx skips the covers numpad entirely when a pending guest request exists, so staff
-- are never prompted and the bill silently records one cover into the Covers Report. Dropping it
-- makes a 3-key payload resolve to the 4-arg body through p_covers's own default, which is
-- strictly better than what such a call hits today.
DROP FUNCTION IF EXISTS public.submit_guest_order(uuid, jsonb, text);

-- ── 3. clear_stale_active_outlet kept the default PUBLIC EXECUTE ────────────────────────────
-- Created by 20260812170000, seven hours after 20260812100000 swept every other function, so it
-- missed that sweep -- it is the tenth entry on an anon-executable list whose closing note
-- predicted nine. It RETURNS trigger, so a direct RPC call raises "trigger functions can only be
-- called as triggers": this is hygiene, not a hole. The drift is the point. The first SECURITY
-- DEFINER function added after a hardening pass missed it, and so will the next one.
--
-- REVOKE ALL with no GRANT back, following guard_pos_order_close (20260819120000) rather than
-- the older assign_* pattern that grants `authenticated` back for no reason: a trigger function
-- needs EXECUTE only at CREATE TRIGGER time, never to fire. guard_pos_order_close has run on
-- every POS bill close since 2026-08-19 holding no grants at all, which is the proof.
--
-- FROM PUBLIC, never FROM anon -- a revoke aimed at a role that holds the privilege only through
-- PUBLIC reports success and changes nothing (that mistake voided 20260712210000 for a week).
REVOKE ALL ON FUNCTION public.clear_stale_active_outlet() FROM PUBLIC;

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────
-- "Success. No rows returned" is exactly what an ineffective revoke reports, and a guard that
-- still falls open compiles perfectly, so both are asserted behaviourally rather than inferred
-- from the statements above having run.
DO $guard$
DECLARE
  -- Two uuids chosen to match no profile, no client and no recipe. That matters for
  -- admin_clear_audit_logs: if its assertion below ever fails, the fall-through DELETE is
  -- filtered to a client_id that cannot exist and so still removes nothing.
  v_ghost  uuid := '00000000-0000-0000-0000-0000000000fe';
  v_ghost2 uuid := '00000000-0000-0000-0000-0000000000fd';
  v_admin  uuid;
  v_ok     boolean;
  v_n      integer;
BEGIN
  -- ── 1. The premise: a profile-less caller really does make is_admin() return NULL ─────────
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000ff","role":"authenticated"}', true);

  IF public.is_admin() IS NOT NULL THEN
    RAISE EXCEPTION 'premise broken: is_admin() returned % for a caller with no profiles row, expected NULL',
      public.is_admin();
  END IF;

  -- ── 2. All four now reject that caller ───────────────────────────────────────────────────
  v_ok := false;
  BEGIN PERFORM public.admin_clear_audit_logs(v_ghost, NULL, NULL);
  EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'admin_clear_audit_logs still falls open for a profile-less caller'; END IF;

  v_ok := false;
  BEGIN PERFORM public.find_user_id_by_email('nobody@example.invalid');
  EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'find_user_id_by_email still falls open for a profile-less caller'; END IF;

  v_ok := false;
  BEGIN PERFORM 1 FROM public.get_cooccurrence(v_ghost, v_ghost2, 30);
  EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'get_cooccurrence still falls open for a profile-less caller'; END IF;

  v_ok := false;
  BEGIN PERFORM 1 FROM public.get_hr_self_service_status(v_ghost);
  EXCEPTION WHEN OTHERS THEN v_ok := true; END;
  IF NOT v_ok THEN RAISE EXCEPTION 'get_hr_self_service_status still falls open for a profile-less caller'; END IF;

  -- ── 3. A real admin must still get through ───────────────────────────────────────────────
  -- The failure this guards against is over-tightening: COALESCE(x, false) on a condition that
  -- was already true must not change it.
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' LIMIT 1;
  IF v_admin IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'regression: a real admin no longer satisfies is_admin()';
    END IF;
    -- Read-only, and scoped to a client that matches nothing: proves an admin passes the guard
    -- without reading or touching any real row. Raises out of the DO block if it does not.
    PERFORM 1 FROM public.get_cooccurrence(v_ghost, v_ghost2, 30);
    PERFORM 1 FROM public.get_hr_self_service_status(v_ghost);
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── 4. The stale overload is gone and the live one is intact ─────────────────────────────
  -- Asserted on pg_proc.pronargs, NOT on pg_get_function_identity_arguments(). The first attempt
  -- at this migration compared that function's output against 'uuid, jsonb, text' and the whole
  -- run rolled back on a false alarm: it renders parameter NAMES too, so the real string is
  -- 'p_table_id uuid, p_items jsonb, p_notes text' and neither comparison could ever match. The
  -- failure mode is the nastier direction, because the two checks then disagree -- the "is it
  -- gone?" test passes vacuously (it finds nothing, so it never raises) while the "is it still
  -- there?" test fires. Same lesson as verifying an index by its leading column rather than its
  -- name: assert on a catalog column, never on a formatted string whose shape you have assumed.
  SELECT count(*) INTO v_n
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'submit_guest_order';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one submit_guest_order after the drop, found %', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'submit_guest_order' AND p.pronargs = 4
  ) THEN
    RAISE EXCEPTION 'the surviving submit_guest_order is not the 4-arg one -- guest ordering would be down';
  END IF;

  -- ── 5. clear_stale_active_outlet: not callable, still wired ──────────────────────────────
  IF has_function_privilege('anon', 'public.clear_stale_active_outlet()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon still holds EXECUTE on clear_stale_active_outlet()';
  END IF;
  IF has_function_privilege('authenticated', 'public.clear_stale_active_outlet()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated still holds EXECUTE on clear_stale_active_outlet()';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE NOT tgisinternal AND tgfoid = 'public.clear_stale_active_outlet()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'clear_stale_active_outlet is no longer attached to any trigger';
  END IF;
END
$guard$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── After running ───────────────────────────────────────────────────────────────────────────
-- The Advisor's anon list drops from 10 back to the 9 that 20260812100000 documented as
-- permanent and correct. The `authenticated` list (lint 0029) is unchanged and unactionable --
-- it fires on every SECURITY DEFINER function, which on a project whose entire API is RPCs can
-- never reach zero. Neither list is a number to drive down; what matters is whether each
-- function verifies the caller, which a linter cannot see.
--
-- Still granting `authenticated` EXECUTE for no reason, from the older assign_* pattern:
-- assign_asset_code, assign_ims_gate_pass_no, assign_pos_credit_note_no, assign_pos_invoice_no,
-- assign_pos_order_no, assign_pos_parking_slip_no, enforce_asset_schedule_immutable. All are
-- trigger-typed and therefore not invocable, so this is cosmetic; left alone deliberately rather
-- than swept in with a security fix.
--
-- Smoke-test after applying: place a guest order from a real QR menu (proves the surviving
-- overload still resolves and covers still lands), and open Admin -> Audit Log and clear a
-- filtered range (proves the admin path through the rewritten guard still works).
