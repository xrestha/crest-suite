-- Fixes a gap in 20260803110000_fixed_asset_register.sql: the original spec called for
-- disposal_reason (nullable text) on assets_register alongside disposal_date/disposal_proceeds/
-- disposal_gain_loss, but the column was dropped while writing that migration's DDL — found live
-- during smoke testing (AssetCard.jsx's Dispose/Write Off action writes disposal_reason and got a
-- 400 back from PostgREST since the column didn't exist). Same class of gotcha as this project's
-- other "shipped once, fixed as a same-day follow-up migration" incidents — never edit an
-- already-applied migration file in place, always a new one.
ALTER TABLE public.assets_register
  ADD COLUMN IF NOT EXISTS disposal_reason text;

NOTIFY pgrst, 'reload schema';
