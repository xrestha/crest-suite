-- ════════════════════════════════════════════════════════════════════════════════════════════
-- The PIN lockout counter can be reset by anyone: record_*_pin_attempt is still anon-executable.
--
-- S531 fixed invariant #3 ("a lockout the client calls around an operation is not a lockout") by
-- moving check_*_pin_lock / record_*_pin_attempt INSIDE pos-staff-login / hr-selfservice-login,
-- so the browser can no longer skip them. That half is correct and verified: a grep of src/ finds
-- zero call sites for all four functions, only comments explaining why they are gone.
--
-- What that pass did NOT do is revoke the EXECUTE grant the browser used to need. All four
-- functions were created without any explicit GRANT/REVOKE, so they carry Postgres's default
-- `GRANT EXECUTE TO PUBLIC` -- and PUBLIC includes anon. Before S531 that was load-bearing
-- (PosLogin.jsx / SelfServiceLogin.jsx called them straight from an unauthenticated page); after
-- S531 it is pure leftover attack surface.
--
-- It is not merely redundant, because record_*_pin_attempt has no authorization check of any kind
-- (SECURITY DEFINER, no is_admin(), no auth.uid(), no secret) and its success branch is:
--
--     IF p_success THEN
--       UPDATE profiles SET hr_pin_failed_attempts = 0, hr_pin_locked_until = NULL
--       WHERE id = p_staff_id AND hr_self_service = true;
--
-- So POST /rest/v1/rpc/record_hr_pin_attempt {"p_staff_id":"<uuid>","p_success":true} clears the
-- counter for an arbitrary employee, from an anonymous browser, with only the anon key.
--
-- The HR Self-Service path is the exploitable one end to end:
--   1. hr-selfservice-login takes {staff_id, pin} and NOTHING else -- no device secret, unlike
--      pos-staff-login, which is gated on client_secrets.pos_device_secret first.
--   2. get_hr_self_service_staff(client_id) hands out the staff_id list to any anonymous caller
--      by design -- that URL is distributed to the whole workforce as a QR code (S464).
--   3. The 5-attempt / 15-minute lockout is therefore the ONLY control standing between a
--      4-digit PIN and the account; there is no other rate limit on that function.
--   4. Reset the counter after every 4th guess and the lockout never fires. 10,000 combinations,
--      unthrottled, ending in full Self-Service takeover (payslips, salary, personal data).
--
-- POS is the same bug but not the same severity: pos-staff-login rejects an unknown device before
-- it ever reaches the lockout, so an attacker needs a valid pos_device_secret first.
--
-- Fix is the grant, not the function body: nothing that legitimately calls these is
-- unauthenticated any more. Both Edge Functions reach them through a service-role client, and
-- service_role needs its own explicit grant here -- it is NOT a superuser in this project, only
-- rolbypassrls, so it does not inherit PUBLIC's grant once PUBLIC's is gone.
--
-- REVOKE ... FROM PUBLIC, never FROM anon: a revoke aimed at a role that only ever held the
-- privilege *through* PUBLIC reports success and changes nothing. That exact mistake voided the
-- whole 20260712210000 hardening migration for a week (see 20260720150000, and the PUBLIC
-- grant/revoke note in CLAUDE.md). These four were never in either of those migrations' lists --
-- correctly so at the time, since the frontend still called them then.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- Wrapped in a transaction: the Dashboard SQL Editor aborts at the first failing statement but
-- keeps everything before it. A partial apply here is worse than no apply -- if the REVOKEs land
-- and the GRANTs do not, service_role loses EXECUTE, and because both Edge Functions FAIL OPEN
-- (console.error only, see below) logins keep succeeding while the lockout is silently dead. That
-- is precisely the failure this migration exists to end, so it must be all-or-nothing.
BEGIN;

REVOKE EXECUTE ON FUNCTION public.record_pos_pin_attempt(uuid, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_hr_pin_attempt(uuid, boolean)  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_pos_pin_lock(uuid)              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_hr_pin_lock(uuid)               FROM PUBLIC;

-- service_role only. Deliberately NOT granted to `authenticated`: an already-signed-in session
-- has no reason to touch another account's lockout state either, and both callers are Edge
-- Functions holding SUPABASE_SERVICE_ROLE_KEY.
GRANT EXECUTE ON FUNCTION public.record_pos_pin_attempt(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_hr_pin_attempt(uuid, boolean)  TO service_role;
GRANT EXECUTE ON FUNCTION public.check_pos_pin_lock(uuid)              TO service_role;
GRANT EXECUTE ON FUNCTION public.check_hr_pin_lock(uuid)               TO service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Second half: everything else `has_function_privilege('anon', ...)` turned up, none of which is
-- exploitable, all of which is leftover surface from the same cause.
--
-- THE STRUCTURAL LESSON, which is worth more than any single line below: an EXECUTE grant is per
-- SIGNATURE, not per name. `REVOKE ... FROM PUBLIC` on foo(a, b) does nothing to foo(a, b, c),
-- and adding a parameter to an existing function creates a brand-new signature carrying a fresh
-- default PUBLIC grant. So a function that was correctly hardened once silently re-opens the next
-- time anyone adds an argument to it. That is what happened to all three functions below: each
-- was extended with one extra parameter after the 20260712210000/20260720150000 sweeps, and the
-- new signature was never revoked. Both overloads of each are currently anon-executable.
--
-- This compounds the already-documented PUBLIC-vs-role trap in CLAUDE.md: that one is "your
-- revoke went to the wrong grantee", this one is "your revoke went to the wrong function".
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── HR Self-Service writers ──────────────────────────────────────────────────────────────────
-- Both already fail closed against an anonymous caller on their own:
--     SELECT client_id, hr_employee_id INTO ... FROM profiles
--     WHERE id = auth.uid() AND hr_self_service = true;
--     IF v_employee_id IS NULL THEN RAISE EXCEPTION 'not authorized'; END IF;
-- auth.uid() is NULL for anon, so the row never matches and the call raises. This is
-- defense-in-depth, not a fix -- but there is no reason an unauthenticated caller should be able
-- to reach an INSERT path into hr_leave_requests / hr_tada_claims at all.
--
-- Granted to `authenticated` rather than service_role: these are called directly from
-- SelfServiceHome.jsx by a real signed-in session, unlike the lockout functions above.
-- The superseded overloads are revoked but deliberately NOT dropped -- the service worker is
-- cache-first (CLAUDE.md), so a staff device can still be running a bundle that predates the
-- extra parameter, and DROP would turn that into a hard failure instead of a stale-but-working
-- form. They are dead code to delete on a later pass, once CACHE_NAME has rolled forward.
REVOKE EXECUTE ON FUNCTION public.submit_my_leave_request(uuid, date, date, numeric, text)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_my_leave_request(uuid, date, date, numeric, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.submit_my_leave_request(uuid, date, date, numeric, text)       TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.submit_my_leave_request(uuid, date, date, numeric, text, text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.submit_my_tada_claim(text, text, date, date, text, jsonb)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_my_tada_claim(text, text, date, date, text, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.submit_my_tada_claim(text, text, date, date, text, jsonb)       TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.submit_my_tada_claim(text, text, date, date, text, jsonb, text) TO authenticated, service_role;

-- ── Trigger functions ────────────────────────────────────────────────────────────────────────
-- Not callable as RPCs in practice (Postgres refuses a direct call to a function returning
-- `trigger`, and PostgREST does not expose them), so this is hygiene, not a hole. Exactly mirrors
-- what 20260720150000 already did for assign_pos_order_no / assign_pos_invoice_no /
-- assign_pos_credit_note_no, including the grant back to authenticated -- these two are simply
-- the ones created afterwards (parking slips + gate passes, 20260717120000) and so missed by it.
-- guard_profiles_privileged_columns is the same case from 20260810120000, three weeks later.
REVOKE EXECUTE ON FUNCTION public.assign_ims_gate_pass_no()              FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_pos_parking_slip_no()           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.guard_profiles_privileged_columns()    FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.assign_ims_gate_pass_no()              TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.assign_pos_parking_slip_no()           TO authenticated, service_role;
GRANT  EXECUTE ON FUNCTION public.guard_profiles_privileged_columns()    TO authenticated, service_role;

COMMIT;

-- ── Deliberately NOT touched ─────────────────────────────────────────────────────────────────
-- submit_guest_order (both overloads)   guests are anonymous by design; that is the feature
-- get_guest_menu / get_guest_table_status / get_guest_order_request_status
--                                       same, the public QR-menu surface
-- get_hr_self_service_staff             pre-auth staff picker, returns only id + full_name (S464)
-- get_pos_staff                         pre-auth, gated on the device secret it takes as an arg
-- is_admin / is_hr_self_service / is_pos_pin_staff / is_ims_staff / is_hr_role_staff /
-- my_client_id                          embedded in RLS policies across dozens of tables;
--                                       revoking breaks anon's legitimate pre-login settings read
--                                       (tested and documented in CLAUDE.md -- do not "fix" these)
-- _nutrition_convert_qty / _nutrition_item_contribution / _nutrition_rollup
--                                       SECURITY INVOKER, so an anon caller hits RLS on
--                                       items/recipes and gets nothing back

-- ── Verification — run this AFTER the statements above, in the same SQL Editor session ───────
-- Every anon/authenticated column must read false, every service_role column true. Do not treat
-- "Success. No rows returned" from the statements above as proof of anything.
--
--   SELECT p.proname,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
--          has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN ('record_pos_pin_attempt','record_hr_pin_attempt',
--                       'check_pos_pin_lock','check_hr_pin_lock')
--   ORDER BY 1;
--
-- Then smoke-test both real login paths — a wrong PIN must still report "Invalid credentials"
-- and still lock after 5 tries. If either login starts failing with "permission denied for
-- function ...", the Edge Function is not using the service-role client and that is the real bug
-- to fix; do not restore the PUBLIC grant to make the symptom go away.
