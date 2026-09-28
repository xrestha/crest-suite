-- S792 stage 2 — PLANNING-1: Demand Forecast clears the previous run by run id, not by listing
-- every new row's id in the URL.
--
-- runForecast() writes the new run first and only then clears the old one, so a failed insert
-- never leaves the page with nothing (S683). demand_forecast_daily has no natural key (a day
-- carries one covers-level row plus one row per dish), so the old run was found by exclusion:
-- DELETE … WHERE id NOT IN (<every id just inserted>). A 30-day run on a 40-dish menu is ~1,230
-- rows, ~45 KB of uuids in one query string — past what the gateway accepts, so the delete failed
-- with the new rows already in, the old run stayed, and every Recompute stacked another full set.
-- The page then kept whichever copy of each day it read last.
--
-- One uuid per Recompute, stamped on every row it writes, lets the clear be one short filter:
-- DELETE … WHERE horizon_days = h AND (run_id IS NULL OR run_id <> <this run>). The IS NULL arm is
-- load-bearing: `<>` alone drops NULL rows, and every row written before this column (and by a
-- cached older bundle after it) has none.
--
-- NULLABLE on purpose, with no backfill: existing rows belong to no known run, and the next
-- Recompute of their horizon removes them through the IS NULL arm. No index: the delete is already
-- narrowed to one client (idx_demand_forecast_daily_client_id), a few thousand rows at most, and
-- nothing reads by run_id alone.
--
-- Nothing else moves. A new column needs no grant (table privileges cover it), the S792 stage-1
-- ims_rank_guard trigger on this table (20260928140000) checks the caller's rank per row whatever
-- the columns, and no audit trigger or restrictive policy names columns here.

ALTER TABLE public.demand_forecast_daily
  ADD COLUMN IF NOT EXISTS run_id uuid;

COMMENT ON COLUMN public.demand_forecast_daily.run_id IS
  'The Recompute that wrote this row (S792 PLANNING-1). NULL = written before the column existed; cleared by the next Recompute of its horizon.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.demand_forecast_daily'::regclass
       AND attname = 'run_id' AND NOT attisdropped
       AND atttypid = 'uuid'::regtype AND NOT attnotnull
  ) THEN
    RAISE EXCEPTION 'demand_forecast_daily.run_id is missing, not uuid, or NOT NULL';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
