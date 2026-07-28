-- Two IMS staff-management functions still carry the ineffective revoke that
-- 20260720150000_fix_ineffective_anon_execute_revokes.sql was written to eliminate:
--
--   get_ims_staff_list(uuid)     -- 20260719120000, line 93
--   get_ims_eligible_users(uuid) -- 20260719140000, line 43
--
-- Both did `REVOKE EXECUTE ... FROM anon`, which is a silent no-op while PUBLIC still holds the
-- privilege: Postgres ACLs are additive, so a role's effective privilege is its own grants UNION
-- PUBLIC's, and revoking from a role that never had a separate grant entry changes nothing and
-- raises no error. The 20260720150000 sweep listed 23 functions but predates neither of these --
-- get_ims_staff_list shipped the day before it and was simply missed, and get_ims_eligible_users
-- was later re-issued as CREATE OR REPLACE in 20260720170000 (which preserves the existing ACL,
-- so the stale PUBLIC grant survived that too).
--
-- Every other function created since then already uses the correct FROM PUBLIC form
-- (get_hr_role_staff_list, get_hr_role_eligible_users, get_pos_staff_list, save_sales_day) --
-- these two are the last stragglers.
--
-- Not an active hole: both are SECURITY DEFINER but check the caller themselves
-- (`caller_role = 'admin' OR caller_client_id = p_client_id`), and for an anonymous caller
-- auth.uid() is NULL, so caller_client_id is NULL and `NULL = p_client_id` evaluates to NULL --
-- not true -- and the function returns no rows. This is defence in depth, closing the gap between
-- what the migrations claim and what the database actually enforces. Fixing it also means the next
-- person auditing execute grants doesn't have to re-derive that reasoning to clear these two.
--
-- Deliberately NOT touched, same as the 20260720150000 decision: is_admin(), is_hr_self_service(),
-- is_pos_pin_staff(), is_ims_staff(), is_hr_role_staff() and my_client_id(). They are embedded in
-- RLS policies across dozens of tables, and anon has a genuine SELECT grant on `settings` for the
-- pre-login app_name read whose policy calls my_client_id() -- revoking from PUBLIC there breaks
-- that read with "permission denied for function my_client_id", as tested in a rolled-back
-- transaction at the time.

REVOKE EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_staff_list(uuid) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_ims_eligible_users(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_ims_eligible_users(uuid) TO authenticated, service_role;

-- Verify, because "Success. No rows returned" is exactly what the ineffective revokes reported.
-- Expect: anon false, authenticated true, service_role true (service_role is NOT a superuser in
-- this project -- only rolbypassrls -- so it needs its own explicit grant).
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.get_ims_staff_list(uuid)',
    'public.get_ims_eligible_users(uuid)'
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
END $$;

NOTIFY pgrst, 'reload schema';
