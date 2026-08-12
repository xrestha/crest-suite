-- Corrects the grandfather sweep in 20260812160000, which under-granted.
--
-- That migration used COALESCE(f.<flag>, true), on the assumption that an existing `false` was a
-- deliberate admin revoke worth preserving. It is not. hasFeature() in AuthContext.js reads:
--
--     if (flagVal === true) return true
--     // null / undefined / false -> fall back to plan
--     if (STARTER_KEYS.has(featureKey)) return true
--
-- so `false` is NOT a revoke — it falls through to the plan check exactly like NULL. A Starter
-- client with reorder_report = false still had Reorder Report, because STARTER_KEYS granted it
-- unconditionally; the flag was a no-op. Preserving that `false` therefore removed access the
-- client actually had, which is precisely what the sweep existed to prevent.
--
-- Found by the post-apply verification rather than by review: starter_missing_flags = 1 and
-- pro_missing_flags = 2 where all three should have been 0.
--
-- The fix is to set true unconditionally for the affected clients. There is no case where that
-- is wrong: before the retier, every client in each set below could reach these features
-- regardless of their flag value, so `true` restores exactly the prior behaviour.
--
-- 20260812160000 is deliberately left as-is. It is the record of what actually ran, and this
-- file is idempotent, so a replay from scratch lands in the same place either way.

-- Starter clients: reorder_report and stock_movement_log moved Starter -> Growth.
UPDATE public.feature_flags f
   SET reorder_report     = true,
       stock_movement_log = true
  FROM public.clients c
 WHERE c.id = f.client_id
   AND COALESCE(c.plan, 'starter') = 'starter'
   AND (f.reorder_report IS DISTINCT FROM true OR f.stock_movement_log IS DISTINCT FROM true);

-- Pro clients: demand_forecast and fixed_asset_register moved Pro -> Crest Suite Pro.
UPDATE public.feature_flags f
   SET demand_forecast      = true,
       fixed_asset_register = true
  FROM public.clients c
 WHERE c.id = f.client_id
   AND c.plan = 'pro'
   AND (f.demand_forecast IS DISTINCT FROM true OR f.fixed_asset_register IS DISTINCT FROM true);

-- ── Verification — all three must be 0 ───────────────────────────────────────────────────────
--   SELECT 'starter_missing_flags' AS check, count(*) FROM clients c
--     JOIN feature_flags f ON f.client_id = c.id
--    WHERE COALESCE(c.plan,'starter') = 'starter'
--      AND (f.reorder_report IS DISTINCT FROM true OR f.stock_movement_log IS DISTINCT FROM true)
--   UNION ALL
--   SELECT 'pro_missing_flags', count(*) FROM clients c
--     JOIN feature_flags f ON f.client_id = c.id
--    WHERE c.plan = 'pro'
--      AND (f.demand_forecast IS DISTINCT FROM true OR f.fixed_asset_register IS DISTINCT FROM true)
--   UNION ALL
--   SELECT 'stray_active_outlet', count(*) FROM profiles WHERE active_client_id IS NOT NULL;
