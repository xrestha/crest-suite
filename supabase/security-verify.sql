-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Crest Suite — live security verification
-- Run in Supabase Dashboard → SQL Editor. Read-only: every statement is a SELECT.
--
-- Supersedes rls-audit.sql, which hardcoded an 18-table list from before HR/POS existed and so
-- silently skipped ~55 tables. Nothing here names a table explicitly — the point is to catch the
-- table nobody remembered to add to a list.
--
-- HOW TO RUN: the Supabase SQL Editor returns only the LAST statement's result set, so running
-- this whole file at once shows you §8 and silently discards §1-§7. Select ONE section with the
-- mouse and press Ctrl+Enter — that runs just the highlighted text. Do §4 first.
--
-- Each section answers one question. A section returning ZERO rows is a pass, except §1b/§4/§5/§6
-- which are inventories.
--
-- If your editor underlines this file in red: that is a SQL Server (T-SQL) language server, which
-- does not understand `::` casts or VALUES inside a CTE. The SQL is valid PostgreSQL.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ── §1a. Tables with RLS OFF ────────────────────────────────────────────────────────────────
-- Expect: zero rows. Anything here is readable by every authenticated user of every tenant.
SELECT c.relname AS table_without_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
ORDER BY 1;

-- ── §1b. Tables with RLS ON but ZERO policies ───────────────────────────────────────────────
-- Not automatically a bug: RLS-on + no-policy is fail-CLOSED, which is how trial_signup_attempts
-- is deliberately locked to service_role. It IS a bug if the app expects to read the table.
-- Cross-check anything listed here against CLIENT_SCOPED_TABLES in src/shared/scopedDb.js.
SELECT c.relname AS table_rls_on_but_no_policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)
ORDER BY 1;

-- ── §2. Restrictive staff-isolation coverage, per table ─────────────────────────────────────
-- The four families from CLAUDE.md. A client-scoped BUSINESS table showing 'f' in a column its
-- peers show 't' in is the drift this catches — a new table does NOT inherit these policies.
-- Reference tables (clients, settings, audit_logs, client_secrets, trial_signup_attempts) are
-- expected to be all-'f'; judge each row against the module it belongs to, not against a total.
SELECT
  c.relname AS tbl,
  bool_or(p.policyname = 'no_self_service_accounts') AS blocks_selfservice,
  bool_or(p.policyname = 'no_pos_pin_staff')         AS blocks_pos_staff,
  bool_or(p.policyname = 'no_ims_staff')             AS blocks_ims_staff,
  bool_or(p.policyname = 'no_hr_role_staff')         AS blocks_hr_staff
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
GROUP BY c.relname
ORDER BY 1;

-- ── §3. SECURITY DEFINER functions missing an explicit search_path ──────────────────────────
-- Expect: zero rows. (Supabase Advisor calls this function_search_path_mutable.)
SELECT p.proname AS secdef_without_search_path
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%')
ORDER BY 1;

-- ── §4. What `anon` can actually EXECUTE  ◀── THE ONE THAT MATTERS ──────────────────────────
-- has_function_privilege is the ONLY trustworthy answer: a REVOKE ... FROM anon is a silent
-- no-op while PUBLIC still holds the grant, and this project has already shipped a whole
-- migration of revokes that took effect on exactly zero functions (see the PUBLIC grant/revoke
-- note in CLAUDE.md). "Success. No rows returned" from the SQL Editor proves nothing.
--
-- Expect EXACTLY these 16 rows and nothing else (verified live 2026-08-10, after 20260810190000).
-- The list is exhaustive on purpose: a section whose "expected" set is vaguer than its output
-- produces standing false positives, and a check people learn to skim is a check that finds
-- nothing.
--   _nutrition_convert_qty, _nutrition_item_contribution, _nutrition_rollup
--     — SECURITY INVOKER, so an anon caller hits RLS on items/recipes and gets nothing back
--   get_guest_menu, get_guest_table_status, get_guest_order_request_status,
--   submit_guest_order  (TWO rows — 3-arg and 4-arg overloads, both live)
--     — the public QR-menu surface; guests are anonymous by design
--   get_hr_self_service_staff  — pre-auth staff picker, returns only id + full_name (S464)
--   get_pos_staff              — pre-auth, gated on the device secret it takes as an argument
--   is_admin, is_hr_self_service, is_pos_pin_staff, is_ims_staff, is_hr_role_staff, my_client_id
--     — embedded in RLS policies across dozens of tables; revoking breaks anon's legitimate
--       pre-login settings read (tested in a rolled-back transaction — see CLAUDE.md)
--
-- ANY OTHER NAME HERE IS A FINDING. In particular record_pos_pin_attempt / record_hr_pin_attempt
-- appearing below means the PIN lockout is bypassable: both reset the failure counter to zero for
-- an arbitrary staff_id when called with p_success := true, and neither performs any auth check.
SELECT p.proname AS anon_executable, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND has_function_privilege('anon', p.oid, 'EXECUTE')
ORDER BY 1;

-- ── §5. Table-level privileges held by anon ─────────────────────────────────────────────────
-- Expect: only `settings` SELECT (the pre-login app_name read). Anything else, especially on
-- profiles / clients / sales_entries, is a finding even if a policy currently covers it.
--
-- Uses has_table_privilege, NOT `information_schema.role_table_grants WHERE grantee = 'anon'`.
-- That view lists grants by their literal grantee, so a privilege anon holds *through PUBLIC*
-- does not appear under 'anon' at all and the table reads as clean — the exact additive-ACL trap
-- §4 above warns about, reproduced one layer down. (This section had that bug when first written.)
SELECT c.relname AS tbl,
       string_agg(p.priv, ', ' ORDER BY p.priv) AS anon_privileges
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                   ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND has_table_privilege('anon', c.oid, p.priv)
GROUP BY c.relname
ORDER BY 1;

-- ── §6. Migration drift ─────────────────────────────────────────────────────────────────────
-- There is NO migration ledger in this project. `supabase_migrations.schema_migrations` is
-- created by `supabase db push`; migrations here are pasted into the Dashboard SQL Editor by
-- hand, so that table has never existed and querying it errors with 42P01. (An earlier version
-- of this file did exactly that.)
--
-- So drift is detected by asking whether each migration's signature object actually exists.
-- Expect: every row 'PRESENT'. Any 'MISSING' row names a migration file that was written and
-- committed but never actually run against production.
WITH expected(migration, kind, obj) AS (VALUES
  ('20260803110000_fixed_asset_register',        'table',   'assets_register'),
  ('20260803120000_..._feature_flag',            'column',  'feature_flags.fixed_asset_register'),
  ('20260803130000_post_asset_depreciation_run', 'routine', 'post_asset_depreciation_run'),
  ('20260803140000_asset_tax_pools',             'table',   'assets_tax_pool_runs'),
  ('20260803150000_post_tax_pool_run',           'routine', 'post_tax_pool_run'),
  ('20260804010000_assets_disposal_reason',      'column',  'assets_register.disposal_reason'),
  ('20260804020000_pos_discount_limit_and_void', 'column',  'profiles.pos_discount_limit'),
  ('20260804030000_stock_and_pricing_guard',     'column',  'settings.block_negative_stock'),
  ('20260810120000_profiles_privilege_guard',    'routine', 'guard_profiles_privileged_columns'),
  ('20260810130000_eligible_users_owner_only',   'routine', 'is_client_owner'),
  ('20260810140000_client_secrets_table',        'table',   'client_secrets'),
  ('20260810140000_client_secrets_table',        'routine', 'get_pos_device_secret'),
  ('20260810170000_trial_signup_rate_limit',     'table',   'trial_signup_attempts'),
  ('20260810180000_retire_pos_email_and_secret', 'gone',    'clients.pos_device_secret'),
  ('20260810180000_retire_pos_email_and_secret', 'gone',    'settings.pos_webhook_secret')
)
SELECT
  e.migration,
  e.kind,
  e.obj,
  CASE
    WHEN e.kind = 'table' THEN
      CASE WHEN to_regclass('public.' || e.obj) IS NOT NULL THEN 'PRESENT' ELSE 'MISSING' END
    WHEN e.kind = 'routine' THEN
      CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.proname = e.obj)
           THEN 'PRESENT' ELSE 'MISSING' END
    WHEN e.kind = 'column' THEN
      CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name  = split_part(e.obj, '.', 1)
                          AND column_name = split_part(e.obj, '.', 2))
           THEN 'PRESENT' ELSE 'MISSING' END
    WHEN e.kind = 'gone' THEN
      -- inverted: this column SHOULD have been dropped. 'PRESENT' here means the drop never ran
      -- and the secret is still sitting on a row every staff account of the client can read.
      CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public'
                          AND table_name  = split_part(e.obj, '.', 1)
                          AND column_name = split_part(e.obj, '.', 2))
           THEN 'STILL THERE — DROP NEVER RAN' ELSE 'PRESENT (correctly dropped)' END
  END AS status
FROM expected e
ORDER BY e.migration, e.obj;

-- ── §7. Audit-log noise guard, deployed-body check ──────────────────────────────────────────
-- Confirms the shipped log_audit() really carries the housekeeping-column skip clauses.
-- Expect all three 't'. Reads the ACTUAL deployed body, not the migration file.
--
-- Comments are stripped before matching. log_audit()'s body explains each skip clause in prose
-- directly above it, so a plain LIKE over the raw definition still matches after the clause
-- itself is deleted and only its comment survives — a check that passes on the explanation of
-- the thing rather than the thing.
WITH body AS (
  SELECT regexp_replace(
           pg_get_functiondef('public.log_audit()'::regprocedure),
           '--[^\n]*', '', 'g') AS src
)
SELECT
  src LIKE '%last_seen_at%' AS skips_last_seen_at,
  src LIKE '%pin_failed%'   AS skips_pin_attempts,
  src LIKE '%print_count%'  AS skips_print_count
FROM body;

-- ── §8. The profiles privilege-column guard is actually attached ────────────────────────────
-- Expect exactly ONE row reading: tgenabled = 'O', is_security_invoker = true.
--
-- Zero rows means invariant #1 in CLAUDE.md is not enforced at all — the policy alone still
-- permits the write, so any client session could PATCH role='admin'.
--
-- is_security_invoker = false is just as bad and much easier to miss: the guard keys off
-- `current_user NOT IN ('anon','authenticated')` to let the service role and SECURITY DEFINER
-- bodies through, and under SECURITY DEFINER current_user would be the function owner on every
-- call — so the check would never fire and the trigger would sit there looking installed while
-- permitting everything.
SELECT t.tgname,
       t.tgenabled,
       NOT p.prosecdef AS is_security_invoker
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.profiles'::regclass
  AND t.tgname = 'guard_profiles_privileged_columns';
