-- Admin per-client override for Fixed Asset Register — same convention as most other
-- feature_flags columns (nullable, no DEFAULT — null/undefined/false all fall back to plan tier
-- in AuthContext.js's hasFeature()). Gated via PremiumGate (featureKey="fixed_asset_register",
-- minPlan="pro") in App.js.
ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS fixed_asset_register boolean;

NOTIFY pgrst, 'reload schema';
