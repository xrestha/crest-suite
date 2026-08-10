-- ════════════════════════════════════════════════════════════════════════════════════════════
-- MEDIUM: any authenticated account of a client could grant that client every paid feature.
--
-- feature_flags_rls was a single FOR ALL policy -- `is_admin() OR client_id = my_client_id()` --
-- covering SELECT *and* INSERT/UPDATE/DELETE with the same predicate. PremiumGate resolves
-- entitlement through hasFeature(), which is "plan tier OR explicit flag", so one PATCH setting
-- every column true unlocked the whole Pro feature set on a Starter subscription:
--
--   await supabase.from('feature_flags')
--     .update({ menu_engineering: true, fifo_report: true, demand_forecast: true, ... })
--     .eq('client_id', '<own client>')
--
-- clients.plan is already correctly admin-only (clients_update is `is_admin()`), so this table was
-- the one remaining way to move up a tier without paying. Reachable from any account type of the
-- client, staff accounts included -- feature_flags is in the set S316 documented as deliberately
-- staying readable to staff, and that was right for reads but silently carried the writes along.
--
-- Revenue/entitlement impact rather than data confidentiality, which is why it is MEDIUM: the
-- flags gate which pages render, not whose data they render.
--
-- Fix: keep SELECT exactly as it was (the app reads these flags on every page load to drive
-- PremiumGate and the nav) and narrow the three write verbs to admin. FeatureAccessModal.js is the
-- only writer anywhere in the app and it lives behind the admin-only Admin -> Clients route, so
-- nothing legitimate loses a capability.
-- ════════════════════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS feature_flags_rls ON public.feature_flags;

CREATE POLICY feature_flags_select ON public.feature_flags
  FOR SELECT USING (public.is_admin() OR client_id = public.my_client_id());

CREATE POLICY feature_flags_insert ON public.feature_flags
  FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY feature_flags_update ON public.feature_flags
  FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY feature_flags_delete ON public.feature_flags
  FOR DELETE USING (public.is_admin());

NOTIFY pgrst, 'reload schema';

-- ── Verification ─────────────────────────────────────────────────────────────────────────────
-- As a real (non-admin) client login:
--   await supabase.from('feature_flags').select('*')
--   -- expect: still returns the client's own row (nav and PremiumGate depend on this)
--
--   await supabase.from('feature_flags').update({ menu_engineering: true }).eq('client_id', '<own>')
--   -- expect: data = [] and NO error. An RLS-blocked UPDATE reports zero rows changed rather
--   -- than throwing (the same silent-no-op shape that hid the settings write bug until S290) --
--   -- so confirm by re-reading the row, not by checking for an error.
--
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'feature_flags' ORDER BY policyname;
--   -- expect 4 rows: _delete/DELETE, _insert/INSERT, _select/SELECT, _update/UPDATE
--   -- (and NOT the old feature_flags_rls/ALL)
