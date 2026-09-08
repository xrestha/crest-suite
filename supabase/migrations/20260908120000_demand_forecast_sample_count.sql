-- Demand Forecast records how much evidence stood behind each day (S694).
--
-- runForecast() always knew how many same-weekday history days fed a forecast (sampleCount) and
-- how many of those were POS bills (posSampleCount), but never stored either, so a day averaged
-- over one week and one averaged over eight looked identical on the page. Both are persisted on
-- the covers-level row (recipe_id IS NULL) beside holiday_name/holiday_multiplier, for the same
-- reason those are: the page reloads a stored run and must not re-derive history to explain it.
--
-- Rows written by earlier runs carry NULL here; the page omits the evidence line for them rather
-- than inventing one. The next Recompute fills them.
ALTER TABLE public.demand_forecast_daily
  ADD COLUMN IF NOT EXISTS sample_count integer,
  ADD COLUMN IF NOT EXISTS pos_sample_count integer;

-- The run log's `method` is free text; new runs write 'weekday_weighted_average' (recency-weighted
-- 8..1 over the last eight same-weekday days) where they wrote 'weekday_moving_average' (plain
-- mean). No constraint to change.

NOTIFY pgrst, 'reload schema';
