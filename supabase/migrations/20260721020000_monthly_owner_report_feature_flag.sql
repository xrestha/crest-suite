-- Admin per-client override for the Monthly Owner/Manager Report — same convention as
-- feature_flags.owner_dashboard (20260708140000): lets one client in below their suite_plan
-- tier. Gated via SuiteGate (requireModules=['ims'], minTier='growth') in
-- src/pages/dashboard/MonthlyOwnerReport.jsx.
ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS monthly_owner_report boolean DEFAULT false;

NOTIFY pgrst, 'reload schema';
