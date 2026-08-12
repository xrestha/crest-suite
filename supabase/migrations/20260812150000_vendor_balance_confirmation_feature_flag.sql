-- Vendor Balance Confirmation (S501) shipped its route, nav entry, PRO_KEYS membership,
-- SettingsContext default and Admin → Features checkbox, but never its feature_flags column.
--
-- The consequence was wider than one missing checkbox. FeatureAccessModal's Save sends the whole
-- flags object in a single upsert, so one unknown column fails the entire request:
--
--   Could not find the 'vendor_balance_confirmation' column of 'feature_flags' in the schema cache
--
-- Every feature-flag save, for every client, has been failing since S501 — the error names a
-- feature the admin was not touching, so it reads as unrelated to whatever they actually toggled.
-- The feature itself was unaffected: `vendor_balance_confirmation` is in PRO_KEYS, and hasFeature()
-- is "plan tier OR explicit flag", so Pro clients had the page all along. What was broken was every
-- per-client override, including the ability to grant this one below Pro.
--
-- Nullable with no default, matching fixed_asset_register (20260803120000) rather than the older
-- `DEFAULT false` columns: the modal's semantics are true = explicitly granted, null = no override,
-- and a false default would misrepresent "never touched" as "deliberately revoked".

ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS vendor_balance_confirmation boolean;

NOTIFY pgrst, 'reload schema';
