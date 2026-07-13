-- sales_entries only ever stored qty_sold — every revenue calculation across the IMS reports
-- (MonthlySummary, AnnualSummary, PeriodComparison, BestSellers, Overheads) joined the recipe's
-- CURRENT selling_price/vat_rate to compute revenue, so a closed period's revenue and Food Cost %
-- silently recomputed against today's menu price whenever it changed later — not stable over time
-- the way a closed accounting period should be.
--
-- New nullable unit_price/vat_rate columns capture the price actually charged at the moment a
-- sale is recorded (POS: the bill's own line-item price; manual IMS entry: the recipe's price at
-- entry time — the closest available approximation, still far more stable than recomputing at
-- report-view time). Existing historical rows are left NULL rather than backfilled with a guess;
-- readers fall back to the recipe's current price for any row where unit_price is NULL, so old
-- data keeps behaving exactly as it did before this migration.

ALTER TABLE public.sales_entries
  ADD COLUMN IF NOT EXISTS unit_price numeric,
  ADD COLUMN IF NOT EXISTS vat_rate numeric;

NOTIFY pgrst, 'reload schema';
