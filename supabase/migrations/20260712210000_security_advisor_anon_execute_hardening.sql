-- Supabase Security Advisor pass (2026-07-12): 36 SECURITY DEFINER functions flagged as
-- executable by the anon (unauthenticated) role. Investigation (read every current function
-- definition in supabase/migrations/*.sql) found this is 100% Postgres's default "EXECUTE
-- granted to PUBLIC on CREATE FUNCTION" behavior — no migration has ever explicitly granted
-- anon anything, and none has ever revoked it either. Triaged into three groups:
--
-- Left alone (9 functions, verified anon-callable by design — guest QR ordering / pre-session
-- staff pickers for PIN login screens, each already scoped to whitelisted columns or an
-- unguessable id): get_guest_menu, get_guest_order_request_status, get_guest_table_status,
-- get_hr_self_service_staff, get_pos_staff, submit_guest_order. Also 3 trigger-typed functions
-- (assign_pos_credit_note_no/invoice_no/order_no) — Postgres refuses to execute a
-- RETURNS trigger function outside trigger context, so the anon grant on these is inert;
-- revoked below anyway since it's free and quiets the linter, not because it's a real gap.
--
-- Left alone, NOT revoked (4 functions — PIN-lock check/record for POS and HR self-service
-- login): check_hr_pin_lock, check_pos_pin_lock, record_hr_pin_attempt, record_pos_pin_attempt.
-- These MUST stay anon-callable — they run before any session exists, which is the entire
-- point of a PIN-pad login screen. The record_* functions are freely-callable write endpoints
-- keyed only by a staff UUID (no CAPTCHA/IP rate-limit), a known, previously-accepted trade-off
-- documented in 20260707240000_pos_pin_lockout.sql's own comments (griefing risk deemed smaller
-- than an unlimited-attempt brute-forceable PIN). Not touched here — revisit only as a deliberate
-- product decision (e.g. an Edge Function proxy with real rate limiting), not a blanket revoke.
--
-- Revoked below (22 functions): meant for an authenticated session (payroll, personal HR
-- records, POS financial writes, admin lookups). Most already have the standard
-- is_admin() OR client_id-match caller check internally (RLS-bypass safe on its own merits),
-- so this is defense-in-depth — closing the "nobody ever revoked the default PUBLIC grant" gap,
-- not fixing an active hole. Confirmed safe: a SECURITY DEFINER function calling is_admin()/
-- my_client_id()/is_hr_self_service()/is_pos_pin_staff() internally does so as its own definer
-- role, not the original caller's role, so revoking anon's direct EXECUTE on those 4 helpers
-- does not break any of the other functions that call them internally.

-- Trigger functions — inert as anon RPC targets, revoked for hygiene only.
REVOKE EXECUTE ON FUNCTION public.assign_pos_credit_note_no() FROM anon;
REVOKE EXECUTE ON FUNCTION public.assign_pos_invoice_no() FROM anon;
REVOKE EXECUTE ON FUNCTION public.assign_pos_order_no() FROM anon;

-- Real defense-in-depth revokes — authenticated-session-only functions.
REVOKE EXECUTE ON FUNCTION public.apply_pos_item_comps(uuid, uuid, text, text, uuid, uuid[], jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_client_profile_names(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_cooccurrence(uuid, uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_coworker_roster(integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_hr_self_service_status(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_client_vendors() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_hr_payslips() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_leave_requests() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_leave_types() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_roster(integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_roster_publish_status(integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_swap_requests() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_tada_claim_items(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_my_tada_claims() FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_next_pos_comp_slip_no(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_pos_staff_list(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_hr_self_service() FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_pos_pin_staff() FROM anon;
REVOKE EXECUTE ON FUNCTION public.my_client_id() FROM anon;
REVOKE EXECUTE ON FUNCTION public.request_shift_swap(uuid, integer, integer, integer, integer, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.respond_shift_swap(uuid, boolean) FROM anon;

-- Storage: the "Logos" bucket's public SELECT policy on storage.objects also permits LISTING
-- every file in the bucket, not just fetching a known object by URL. The app never needs
-- listing — both upload call sites (src/pages/Settings.js, src/pages/adminClients/ClientDrawer.js)
-- use supabase.storage.from('Logos').getPublicUrl(path), which is pure client-side URL string
-- construction (no RLS-gated API call), fed straight into a plain <img src>. Actual file GETs
-- for a public bucket are served by Storage's own public-bucket path, independent of this RLS
-- policy — so dropping it removes the tenant-enumeration-via-listing surface without touching
-- how logos actually load.
DROP POLICY IF EXISTS "Public read" ON storage.objects;

NOTIFY pgrst, 'reload schema';
