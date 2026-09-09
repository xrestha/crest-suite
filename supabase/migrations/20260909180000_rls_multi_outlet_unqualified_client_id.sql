-- S710 (3 of 3) — the same defect, in the spelling the first pass could not see.
--
-- 20260909160000 fixed 25 policies that inlined `my_client_id()`'s pre-S548 body. It was written
-- from a scan of the migration FILES, and it missed thirteen more, every one of them from
-- 20260812130000. The live `pg_policies` check that same session added is what found them:
--
--   inline policies remaining | 13
--
-- The reason is worth more than the fix. These thirteen are written with UNQUALIFIED columns:
--
--   client_id = (SELECT client_id FROM profiles WHERE id = (select auth.uid()))     -- the file
--   client_id = (SELECT profiles.client_id FROM profiles WHERE profiles.id = ...)   -- pg_policies
--
-- Postgres parses the expression and re-prints it qualified, so the source text in the repo and the
-- stored text in the catalog are two spellings of one thing, and a grep tuned to either is blind to
-- the other. **A policy audit runs against `pg_policies`, not against the migration files.** The
-- files are what you edit; the catalog is what is true.
--
-- The thirteen are the whole Fixed Assets module (all seven tables), Gate Passes, guest order
-- requests, parking slips and payment confirmations. So until this ran, an Owner who switched
-- outlets would have been shown the asset register of the outlet they had just left — with no error
-- anywhere to say which one they were looking at.
--
-- Same substitution as 20260909160000 and semantics-preserving in the same way; the SELECT- and
-- UPDATE-only policies keep only their USING clause. After this, the check must return zero:
--
--   SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
--    AND (qual LIKE '%profiles.client_id%' OR with_check LIKE '%profiles.client_id%');

BEGIN;

ALTER POLICY assets_categories_client ON public.assets_categories
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY assets_depreciation_runs_client ON public.assets_depreciation_runs
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY assets_depreciation_schedule_client ON public.assets_depreciation_schedule
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY assets_register_client ON public.assets_register
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY assets_repair_expenses_client ON public.assets_repair_expenses
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY assets_tax_pool_lines_client ON public.assets_tax_pool_lines
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY assets_tax_pool_runs_client ON public.assets_tax_pool_runs
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY ims_gate_passes_client ON public.ims_gate_passes
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY pos_guest_order_requests_select ON public.pos_guest_order_requests
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY pos_guest_order_requests_update ON public.pos_guest_order_requests
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY pos_parking_slips_client ON public.pos_parking_slips
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) )
  WITH CHECK ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY pos_payment_confirmations_select ON public.pos_payment_confirmations
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

ALTER POLICY pos_payment_confirmations_update ON public.pos_payment_confirmations
  USING ( (SELECT role FROM profiles WHERE id = (select auth.uid())) = 'admin' OR client_id = (select public.my_client_id()) );

COMMIT;
