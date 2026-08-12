-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Four of the six "do not touch" RLS helpers were never actually load-bearing for anon.
--
-- 20260720150000 and 20260727190000 both list the same six functions as deliberately exempt from
-- the anon-execute hardening:
--
--   is_admin()  my_client_id()  is_hr_self_service()  is_pos_pin_staff()  is_ims_staff()  is_hr_role_staff()
--
-- The stated reason is that anon holds a genuine SELECT grant on `settings` for the pre-login
-- app_name read, and revoking a function that read's policy calls breaks it with "permission
-- denied for function" -- Postgres does not reliably short-circuit past the second OR operand
-- once RLS folds into the row filter, so even a query filtered to the safe row still evaluates
-- them. That reasoning is correct, and it was tested in a rolled-back transaction at the time.
--
-- But it was only ever tested against my_client_id(). Reading the policy settles which functions
-- the anon path actually touches:
--
--   CREATE POLICY settings_select ON public.settings FOR SELECT
--   USING (((client_id IS NULL) OR (client_id = public.my_client_id()) OR public.is_admin()));
--
-- my_client_id() and is_admin() -- and nothing else. The four staff-marker helpers appear only in
-- the RESTRICTIVE policies added by 20260708130000 and its successors, and on `settings` those
-- cover INSERT and UPDATE only (no_self_service_insert / no_self_service_update), never SELECT.
-- So they were carried onto the exemption list alongside my_client_id() by association, not
-- because anything anon does invokes them.
--
-- Verified before writing this, in a rolled-back transaction on the live database: with all four
-- revoked from PUBLIC, `SET LOCAL ROLE anon; SELECT app_name FROM settings WHERE client_id IS
-- NULL;` still returns 'Crest Suite'. The same test is baked in below so this cannot commit if
-- that ever stops being true.
--
-- NOT a live hole being closed -- this is defense in depth. All four are boolean tests keyed on
-- auth.uid(), which is NULL for anon, so an anonymous caller invoking one gets `false` and learns
-- nothing. The reason to do it is that a six-function exemption where only two functions are
-- provably exempt is an invitation for the next person to assume the whole list was reasoned
-- through, and to extend it by the same association.
--
-- is_admin() and my_client_id() stay exempt, permanently, and the settings_select policy above is
-- the reason. Do not "finish the cleanup" by revoking those two -- it breaks the login page for
-- every unauthenticated visitor, and the failure is a blank app name rather than an obvious error.
--
-- REVOKE FROM PUBLIC, never FROM anon: a revoke aimed at a role that only ever held the privilege
-- *through* PUBLIC reports success and changes nothing. That mistake voided the whole
-- 20260712210000 migration for a week (see 20260720150000 and CLAUDE.md).
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- All-or-nothing: the guards below must be able to roll the REVOKEs back. The Dashboard SQL
-- Editor otherwise keeps every statement before the failing one, which here would mean anon
-- losing EXECUTE with nothing to report that the pre-login read had broken.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.is_ims_staff()       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_hr_role_staff()   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_pos_pin_staff()   FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_hr_self_service() FROM PUBLIC;

-- service_role needs its own grant -- it is NOT a superuser in this project, only rolbypassrls,
-- so it does not inherit PUBLIC's grant once PUBLIC's is gone.
GRANT EXECUTE ON FUNCTION public.is_ims_staff()       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_hr_role_staff()   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_pos_pin_staff()   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_hr_self_service() TO authenticated, service_role;

-- ── Guard 1: the pre-login settings read must still work ────────────────────────────────────
-- This is the exact query Login.js depends on before anyone has signed in. If any of the four
-- revokes above were in fact reachable from settings_select, this raises "permission denied for
-- function" and the whole migration rolls back rather than shipping a broken login page.
SET LOCAL ROLE anon;
SELECT app_name FROM public.settings WHERE client_id IS NULL;
RESET ROLE;

-- ── Guard 2: the revokes actually took, and authenticated did not lose access ───────────────
-- "Success. No rows returned" is exactly what the ineffective FROM anon revokes reported, so the
-- privilege is asserted directly rather than inferred from the statements having run.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.is_ims_staff()',
    'public.is_hr_role_staff()',
    'public.is_pos_pin_staff()',
    'public.is_hr_self_service()'
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon still holds EXECUTE on % after revoke', fn;
    END IF;
    IF NOT has_function_privilege('authenticated', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated lost EXECUTE on %', fn;
    END IF;
    IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lost EXECUTE on %', fn;
    END IF;
  END LOOP;

  -- The two that must NOT have been touched. Catches a future edit that extends the revoke list
  -- by association, which is the exact mistake this migration exists to undo.
  IF NOT has_function_privilege('anon', 'public.my_client_id()', 'EXECUTE') THEN
    RAISE EXCEPTION 'my_client_id() was revoked from anon -- this breaks the pre-login settings read';
  END IF;
  IF NOT has_function_privilege('anon', 'public.is_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION 'is_admin() was revoked from anon -- this breaks the pre-login settings read';
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ── After running ───────────────────────────────────────────────────────────────────────────
-- Expect the Advisor's "Public Can Execute SECURITY DEFINER Function" list to drop from 13 to 9.
-- The remaining 9 are permanent and correct: the guest QR surface (get_guest_menu,
-- get_guest_table_status, get_guest_order_request_status, both submit_guest_order overloads), the
-- two pre-auth staff pickers (get_hr_self_service_staff, get_pos_staff), and is_admin() /
-- my_client_id(). Anon execution IS the feature for the first seven. This lint can never reach
-- zero on this project, and should not be treated as a number to drive down.
--
-- Smoke-test after applying: load the login page signed out and confirm the app name still
-- renders (Guard 1 covers the SQL path, but only the real page proves PostgREST reloaded).
