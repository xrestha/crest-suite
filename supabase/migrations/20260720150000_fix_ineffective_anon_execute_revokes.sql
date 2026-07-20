-- 20260712210000 revoked EXECUTE on 25 SECURITY DEFINER functions FROM anon, intending to close
-- the "PUBLIC grants EXECUTE by default on CREATE FUNCTION" gap for authenticated-session-only
-- RPCs. It never took effect on any of them. Postgres ACLs are additive: a role's effective
-- privilege is its own grants UNION PUBLIC's, and REVOKE ... FROM <role> only removes that
-- role's own grant entry -- it cannot subtract a privilege PUBLIC still holds. None of these 25
-- functions had ever been given a separate anon grant to revoke; every one still shows the
-- original bare `{=X/postgres,...}` ACL (the `=` with no role name is PUBLIC), and
-- has_function_privilege('anon', ..., 'EXECUTE') returns true for all of them today. Found
-- 2026-07-20 while re-verifying the get_my_hr_payslips fix (20260720120000) actually landed.
--
-- Correct fix: REVOKE ... FROM PUBLIC (removes the blanket grant), then GRANT ... TO the specific
-- roles that legitimately need it. Scoped to exactly the same 22 "real defense-in-depth" functions
-- from 20260712210000 plus its 3 trigger-hygiene ones -- verified by querying pg_proc/pg_policy
-- that none of these 25 appear inside any RLS policy USING clause or inside another function's
-- body, so nothing else in the database depends on their PUBLIC grant.
--
-- Granted to both authenticated AND service_role. service_role is not a Postgres superuser here
-- (rolsuper=false, only rolbypassrls=true) and is not a member of authenticated, so it currently
-- reaches these 25 functions only through the same stale PUBLIC grant this migration removes.
-- No Edge Function calls any of them today (grepped supabase/functions/ for `.rpc(`, zero hits),
-- so this isn't fixing a live break -- it's avoiding turning "works today, silently, for the
-- wrong reason" into "breaks the day someone adds a service-role caller".
--
-- Deliberately NOT touched: is_admin(), is_hr_self_service(), is_pos_pin_staff(), my_client_id().
-- These 4 ARE embedded in RLS policies across dozens of tables, including at least one anon
-- legitimately reaches today -- settings_select allows `client_id IS NULL OR client_id =
-- my_client_id() OR is_admin()` to roles `{-}` (PUBLIC), and anon holds a real base SELECT grant
-- on `settings` so a pre-login page can read the global app_name/app_tagline row. Verified by
-- direct test (in a transaction, rolled back) that revoking my_client_id() from PUBLIC breaks that
-- read with `permission denied for function my_client_id` even when the query filters
-- `WHERE client_id IS NULL` -- Postgres does not reliably short-circuit past the second OR operand
-- once RLS folds its USING clause into the row filter, so the safe row and the unsafe row are not
-- evaluated differently. Revoking these 4 has no meaningful security upside (calling them directly
-- as anon returns null/false, never another tenant's data) and a real chance of breaking that read
-- path in a way not fully provable safe without a plan-level audit of every table that reaches
-- them. Leaving their (also ineffective) revokes from 20260712210000 in place is the correct,
-- lower-risk outcome, not an oversight.

REVOKE EXECUTE ON FUNCTION public.assign_pos_credit_note_no() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_pos_invoice_no() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_pos_order_no() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_pos_credit_note_no() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_pos_invoice_no() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assign_pos_order_no() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_client_profile_names(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_coworker_roster(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_hr_self_service_status(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_client_vendors() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_hr_payslips() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_leave_requests() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_leave_types() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_roster(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_roster_publish_status(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_swap_requests() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_tada_claim_items(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_my_tada_claims() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_next_pos_comp_slip_no(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.request_shift_swap(uuid, integer, integer, integer, integer, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.respond_shift_swap(uuid, boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_client_profile_names(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_coworker_roster(integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_hr_self_service_status(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_client_vendors() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_hr_payslips() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_leave_requests() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_leave_types() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_roster(integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_roster_publish_status(integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_swap_requests() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_tada_claim_items(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_tada_claims() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_next_pos_comp_slip_no(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_shift_swap(uuid, integer, integer, integer, integer, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.respond_shift_swap(uuid, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
