-- Consolidated P&L (/pnl): the formal statement — Revenue → COGS → Gross Profit → Wastage/Staff
-- Meals/Labour/Overheads/Tax & Fees → Net Profit — for one BS period, every line from its
-- module's canonical source. A Crest Suite Pro feature (clients.suite_plan gates it via
-- SuiteGate); this column exists ONLY as the per-client admin override that SuiteGate's
-- `tierOk || overridden` implies, exactly like owner_dashboard / monthly_owner_report. It must
-- never join the IMS tier key sets — that would hand the SKU to every IMS Pro client (see
-- SUITE_KEYS in AuthContext.js).
--
-- The column must exist before FeatureAccessModal can save: the modal upserts the whole flags
-- object in one request, so a key with no matching column rejects EVERY feature-flag save for
-- EVERY client (S547).

ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS consolidated_pnl boolean DEFAULT false;

NOTIFY pgrst, 'reload schema';
