-- Retier IMS features, collapse Crest Suite to a single add-on SKU, and grandfather every
-- existing client so nobody loses access.
--
-- Three problems this fixes, all found by reanalysing the plan structure:
--
-- 1. reorder_report and stock_movement_log were sold in STARTER_KEYS, but both derive their core
--    figure from recipe explosion (ReorderReport.js's explodeRecipeIngredients, StockMovements.js's
--    subRecipeUsage) and recipe_costing is Growth — so a Starter client was sold a Reorder Report
--    with no consumption figure and a permanently empty stock ledger. Both move to Growth.
--    outstanding_payables (plain record-keeping) and vendor_balance_confirmation (statutory, IRD
--    Annexure 13 — same class as VAT/Non-VAT which were already Starter) move down in exchange.
--    overheads moves Pro -> Growth: it is the data-entry page behind Fixed Costs %/Est. Net Margin
--    and Recipes' True Cost allocation, and a data-entry page must not sit above the tier of the
--    figures that consume it.
--
-- 2. demand_forecast and fixed_asset_register move from Pro to Crest Suite Pro. The first is
--    genuinely cross-module (Roster.jsx overlays demand_forecast_daily onto the HR roster); the
--    second is owner/finance altitude and self-contained.
--
-- 3. clients.suite_plan collapses from starter|growth|pro to NULL | 'pro'. Both SuiteGate call
--    sites were minTier="growth", so Suite Starter unlocked nothing at all and Suite Pro added
--    nothing over Suite Growth on its own axis. suite_plan has no CHECK constraint (it was added
--    bare by 20260708140000), so this is a data migration only.
--
-- The tier moves live in code (AuthContext.js's key sets + PremiumGate minPlan props). What this
-- migration owns is the DB column the new key needs, and the grandfather sweeps that keep every
-- existing client whole. hasFeature() is "plan tier OR explicit flag", and SuiteGate's own
-- `overridden` branch reads hasFeature(), so setting a flag true is the supported way to grant a
-- feature above a client's tier — which is exactly what grandfathering is.

-- ── 1. The new Suite key needs its feature_flags column ──────────────────────────────────────
-- Skipping this is the S547 failure mode: FeatureAccessModal's Save upserts the WHOLE flags
-- object, so one key with no matching column rejects every feature-flag save for every client,
-- with an error naming a feature the admin was not touching.
ALTER TABLE public.feature_flags
  ADD COLUMN IF NOT EXISTS multi_outlet boolean;

-- ── 2. Grandfather: features that moved UP a tier ────────────────────────────────────────────
-- Anyone who could reach these before must still reach them. Upward-available moves
-- (outstanding_payables, vendor_balance_confirmation, overheads becoming available at LOWER
-- tiers) need no sweep — they only widen access.

-- Starter clients keep Reorder Report and Stock Movements.
UPDATE public.feature_flags f
   SET reorder_report    = COALESCE(f.reorder_report, true),
       stock_movement_log = COALESCE(f.stock_movement_log, true)
  FROM public.clients c
 WHERE c.id = f.client_id
   AND COALESCE(c.plan, 'starter') = 'starter';

-- Pro clients keep Demand Forecast and Fixed Assets, which are now Suite features.
UPDATE public.feature_flags f
   SET demand_forecast      = COALESCE(f.demand_forecast, true),
       fixed_asset_register = COALESCE(f.fixed_asset_register, true)
  FROM public.clients c
 WHERE c.id = f.client_id
   AND c.plan = 'pro';

-- A client with no feature_flags row at all falls through both UPDATEs above. Give the affected
-- ones a row rather than leaving them to lose access silently.
INSERT INTO public.feature_flags (client_id, reorder_report, stock_movement_log, demand_forecast, fixed_asset_register)
SELECT c.id,
       CASE WHEN COALESCE(c.plan, 'starter') = 'starter' THEN true END,
       CASE WHEN COALESCE(c.plan, 'starter') = 'starter' THEN true END,
       CASE WHEN c.plan = 'pro' THEN true END,
       CASE WHEN c.plan = 'pro' THEN true END
  FROM public.clients c
 WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.client_id = c.id)
   AND (COALESCE(c.plan, 'starter') = 'starter' OR c.plan = 'pro');

-- ── 3. Collapse suite_plan to a single tier ──────────────────────────────────────────────────
-- 'growth' had the two Suite features and now gets five: a pure upgrade, safe to sweep.
UPDATE public.clients SET suite_plan = 'pro' WHERE suite_plan = 'growth';

-- 'starter' is deliberately NOT swept. Those clients paid the Suite Starter bundle price for a
-- tier that unlocked no Suite feature at all, AND the bundle implied their module subscriptions
-- (plan/hr_enabled/pos_enabled and the *_ends_at dates) which the add-on model no longer does.
-- Both halves are a billing conversation per client, not a blanket UPDATE. Find them with:
--
--   SELECT id, name, plan, hr_enabled, pos_enabled, ims_ends_at, hr_ends_at, pos_ends_at,
--          suite_ends_at, billing_cycle
--     FROM public.clients WHERE suite_plan = 'starter';
--
-- For each: decide 'pro' or NULL, then set the module columns explicitly. Verify against
-- getAccessState (src/utils/subscription.js) before deploying, or they lock out of the app.

-- Any other legacy value is not a tier this system ever understood.
UPDATE public.clients
   SET suite_plan = NULL
 WHERE suite_plan IS NOT NULL
   AND suite_plan NOT IN ('pro', 'starter');

-- ── Verification (run after applying; do not trust "Success. No rows returned.") ─────────────
-- Every Starter client can still reach the two moved reports:
--   SELECT count(*) FROM public.clients c JOIN public.feature_flags f ON f.client_id = c.id
--    WHERE COALESCE(c.plan,'starter') = 'starter'
--      AND (f.reorder_report IS DISTINCT FROM true OR f.stock_movement_log IS DISTINCT FROM true);
--   -- expect 0
--
-- Every Pro client can still reach the two features that became Suite:
--   SELECT count(*) FROM public.clients c JOIN public.feature_flags f ON f.client_id = c.id
--    WHERE c.plan = 'pro'
--      AND (f.demand_forecast IS DISTINCT FROM true OR f.fixed_asset_register IS DISTINCT FROM true);
--   -- expect 0
--
-- No suite_plan value outside the new domain, ignoring the deliberate 'starter' holdouts:
--   SELECT suite_plan, count(*) FROM public.clients GROUP BY suite_plan;
