-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Advisor 0028/0029 triage: two real items in a list that is otherwise expected.
--
-- Most of both lints is by design and documented: the guest/booking/PIN-picker functions are
-- deliberately anon-callable pre-auth entry points, each with its own internal authorization
-- (20260713010859, 20260728100000, 20260904200000/220000), and is_admin()/my_client_id() are
-- the two permanent anon exemptions -- revoking either blanks the app name for every signed-out
-- visitor (20260812100000 re-tested and asserted exactly that). The 0029 list is mostly
-- functions `authenticated` is SUPPOSED to call. Two things in it are not.
--
-- ── 1. Seven trigger functions hold an EXECUTE grant that does nothing ──────────────────────
-- EXECUTE on a trigger function is checked at CREATE TRIGGER time, never at fire time, so a
-- trigger function needs no grant at all -- guard_pos_order_close has fired on every POS bill
-- close since 2026-08-19 holding none. These seven follow the older `assign_*` pattern of
-- REVOKE-from-PUBLIC-then-GRANT-authenticated-back, and that grant back is the entire reason
-- they appear under 0029. Revoking changes no behaviour: all seven RETURN trigger, so PostgREST
-- will not expose them as RPC either way.
--
-- ── 2. Two stale overloads, the same fault 20260829120000 fixed for submit_guest_order ──────
-- CREATE OR REPLACE keys on the full argument-type signature, so appending a defaulted
-- parameter creates a SECOND function rather than replacing the first. Both HR self-service
-- submitters did it, and 20260810190000 then granted BOTH signatures -- it saw two and treated
-- that as the shape rather than the bug.
--
-- Neither stale body is a hole: both carry the same `hr_self_service = true` check as their
-- live counterpart, and the columns they omit (hr_leave_requests.day_type DEFAULT 'full',
-- hr_tada_claims.start_point) default to what the old call meant anyway. What makes them worth
-- removing is drift -- every later fix lands on one body only, and PostgREST binds by the
-- argument keys in the payload, so a short call silently reaches the older code. After the drop
-- a short payload resolves to the live body through its own parameter default instead.
--
-- SelfServiceHome.jsx sends the full key set at both call sites today, so nothing changes for
-- the app.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- All-or-nothing: the assertions at the bottom must be able to roll the whole thing back. The
-- Dashboard SQL Editor otherwise keeps every statement before the failing one.
BEGIN;

-- ── 1. Trigger functions: no grant, no lint ─────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.assign_asset_code()                FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_ims_gate_pass_no()          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_pos_credit_note_no()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_pos_invoice_no()            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_pos_order_no()              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_pos_parking_slip_no()       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_asset_schedule_immutable() FROM PUBLIC, anon, authenticated;

-- ── 2. The two stale overloads ──────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.submit_my_leave_request(uuid, date, date, numeric, text);
DROP FUNCTION IF EXISTS public.submit_my_tada_claim(text, text, date, date, text, jsonb);

NOTIFY pgrst, 'reload schema';

-- ── Assertions ──────────────────────────────────────────────────────────────────────────────
-- On catalog columns Postgres computes (pronargs, pg_trigger), never on a formatted signature
-- string -- pg_get_function_identity_arguments renders parameter NAMES too, which is how a
-- prior migration's overload assertion came to pass vacuously (S630).
DO $$
DECLARE
  v_fn text;
BEGIN
  -- The seven are un-callable by client roles, and still attached to their triggers.
  FOREACH v_fn IN ARRAY ARRAY[
    'assign_asset_code', 'assign_ims_gate_pass_no', 'assign_pos_credit_note_no',
    'assign_pos_invoice_no', 'assign_pos_order_no', 'assign_pos_parking_slip_no',
    'enforce_asset_schedule_immutable'
  ] LOOP
    IF has_function_privilege('authenticated', 'public.' || v_fn || '()', 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated still holds EXECUTE on %()', v_fn;
    END IF;
    IF has_function_privilege('anon', 'public.' || v_fn || '()', 'EXECUTE') THEN
      RAISE EXCEPTION 'anon still holds EXECUTE on %()', v_fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE NOT tgisinternal AND tgfoid = ('public.' || v_fn || '()')::regprocedure
    ) THEN
      RAISE EXCEPTION '%() is no longer attached to any trigger', v_fn;
    END IF;
  END LOOP;

  -- Exactly one submit_my_leave_request survives, and it is the six-parameter one.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'submit_my_leave_request') <> 1 THEN
    RAISE EXCEPTION 'submit_my_leave_request is not down to one overload';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'submit_my_leave_request' AND p.pronargs = 6
  ) THEN
    RAISE EXCEPTION 'the surviving submit_my_leave_request is not the p_day_type one';
  END IF;

  -- Same for submit_my_tada_claim: one left, the seven-parameter (p_start_point) one.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'submit_my_tada_claim') <> 1 THEN
    RAISE EXCEPTION 'submit_my_tada_claim is not down to one overload';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'submit_my_tada_claim' AND p.pronargs = 7
  ) THEN
    RAISE EXCEPTION 'the surviving submit_my_tada_claim is not the p_start_point one';
  END IF;

  -- Still reachable by the accounts that must call them.
  IF NOT has_function_privilege('authenticated',
      'public.submit_my_leave_request(uuid, date, date, numeric, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on submit_my_leave_request';
  END IF;
  IF NOT has_function_privilege('authenticated',
      'public.submit_my_tada_claim(text, text, date, date, text, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost EXECUTE on submit_my_tada_claim';
  END IF;
END $$;

COMMIT;

-- Smoke test after applying: open Crest Staff (/hr/self-service) and submit one leave request
-- (half-day, so p_day_type is exercised) and one TADA claim with a start point. Then close one
-- POS bill -- that fires assign_pos_order_no and assign_pos_invoice_no, the two revokes with
-- the most traffic behind them.
