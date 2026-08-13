-- Move stock_report from Starter to Growth, and grandfather every existing Starter client.
--
-- WHY (S551, `/impeccable critique` phase 4): this is the third instance of the exact defect
-- 20260812160000 fixed for reorder_report and stock_movement_log, and that pass missed it.
-- StockReport.js:75 calls explodeRecipeIngredients and uses its output as the only consumption
-- term in On-hand:
--
--   rawTheoretical = openQty + netPurch − usageQty − wasteQty − staffQty − reqQty
--
-- recipe_costing is Growth, so a Starter client has no recipes, `usageMap` is permanently empty,
-- and their stock quantity never decreases for anything they sell. Total Stock Value only ever
-- grows, and the Low / Out status column can never fire. They were sold a report whose headline
-- figure cannot be right, and nothing on the page says why.
--
-- The tier move itself lives in code (AuthContext.js's GROWTH_KEYS, the PremiumGate minPlan prop
-- on the /stock-report route in App.js, and the minPlan tag on its Layout.js nav item — all three
-- must move together or the page ends up reachable-but-hidden or visible-but-blocked). What this
-- migration owns is the grandfather sweep: hasFeature() is "plan tier OR explicit flag", so
-- setting the flag true restores prior access with no further code change.
--
-- NOTE on COALESCE: `false` in feature_flags is inert — hasFeature() only tests `=== true`, and
-- FeatureAccessModal only ever writes true or null. COALESCE(f.stock_report, true) would preserve
-- a stray false as-is and under-grant, which is the S548 mistake 20260812180000 had to undo. This
-- sweep therefore sets true unconditionally for the affected clients.

-- ── Grandfather: Starter clients keep Stock Report ───────────────────────────────────────────
UPDATE public.feature_flags f
   SET stock_report = true
  FROM public.clients c
 WHERE c.id = f.client_id
   AND COALESCE(c.plan, 'starter') = 'starter';

-- A Starter client with no feature_flags row at all falls through the UPDATE above.
INSERT INTO public.feature_flags (client_id, stock_report)
SELECT c.id, true
  FROM public.clients c
 WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.client_id = c.id)
   AND COALESCE(c.plan, 'starter') = 'starter';

-- ── Verification (run after applying; do not trust "Success. No rows returned.") ─────────────
-- Every Starter client can still reach Stock Report:
--   SELECT count(*) FROM public.clients c JOIN public.feature_flags f ON f.client_id = c.id
--    WHERE COALESCE(c.plan,'starter') = 'starter' AND f.stock_report IS DISTINCT FROM true;
--   -- expect 0
--
-- No Starter client left without a flags row:
--   SELECT count(*) FROM public.clients c
--    WHERE COALESCE(c.plan,'starter') = 'starter'
--      AND NOT EXISTS (SELECT 1 FROM public.feature_flags f WHERE f.client_id = c.id);
--   -- expect 0
