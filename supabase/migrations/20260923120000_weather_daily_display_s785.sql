-- S785 — the Dashboard header's weather strip: temperature, cloud and thunder beside the rain.
--
-- `weather_daily` (S784) keeps only rain, because rain is all the sales forecast uses. The strip
-- shows each day as a picture, a high/low and a plain word (Sunny … Heavy rain, Thunderstorms), so
-- the weather-forecast Edge Function now keeps four more figures it was already receiving from MET
-- Norway and throwing away. All four are measured over the same 05:45–23:45 Nepal window as the
-- rain and ride the same `complete` rule: a part-day row never overwrites a full-day one.
--
--   temp_max / temp_min  the highest and lowest air temperature forecast inside the window, °C
--   cloud_pct            the mean cloud cover over the window, 0–100
--   thunder              whether any forecast block overlapping the window names thunder
--
-- All nullable with no default: rows written before this migration carry NULL until the next
-- fetch rewrites them, and the strip shows a day without a temperature rather than a made-up one.
-- No grant changes: the table is service-role only (S784), and table-level privileges cover new
-- columns. The function must be deployed AFTER this is applied — deployed first, its upsert names
-- columns that do not exist, every save fails and it backs off as cache_write_failed.
--
-- Reverse: ALTER TABLE public.weather_daily DROP COLUMN temp_max, DROP COLUMN temp_min,
-- DROP COLUMN cloud_pct, DROP COLUMN thunder (after redeploying the S784 function body).

ALTER TABLE public.weather_daily ADD COLUMN IF NOT EXISTS temp_max  numeric(4,1);
ALTER TABLE public.weather_daily ADD COLUMN IF NOT EXISTS temp_min  numeric(4,1);
ALTER TABLE public.weather_daily ADD COLUMN IF NOT EXISTS cloud_pct smallint;
ALTER TABLE public.weather_daily ADD COLUMN IF NOT EXISTS thunder   boolean;

ALTER TABLE public.weather_daily DROP CONSTRAINT IF EXISTS weather_daily_cloud_pct_range;
ALTER TABLE public.weather_daily ADD CONSTRAINT weather_daily_cloud_pct_range
  CHECK (cloud_pct IS NULL OR cloud_pct BETWEEN 0 AND 100);

-- Both or neither, and never inverted: the function writes the pair from one pass.
ALTER TABLE public.weather_daily DROP CONSTRAINT IF EXISTS weather_daily_temp_pair;
ALTER TABLE public.weather_daily ADD CONSTRAINT weather_daily_temp_pair
  CHECK ((temp_max IS NULL) = (temp_min IS NULL) AND (temp_max IS NULL OR temp_max >= temp_min));

-- Assertions: on catalog values, never on formatted strings (supabase-sql.md, S630). ------------

DO $$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['temp_max', 'temp_min', 'cloud_pct', 'thunder'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'weather_daily' AND column_name = c) THEN
      RAISE EXCEPTION 'S785: weather_daily.% is missing', c;
    END IF;
    IF has_column_privilege('authenticated', 'public.weather_daily', c, 'SELECT')
       OR has_column_privilege('anon', 'public.weather_daily', c, 'SELECT') THEN
      RAISE EXCEPTION 'S785: weather_daily.% is readable by a client role', c;
    END IF;
    IF NOT (has_column_privilege('service_role', 'public.weather_daily', c, 'SELECT')
            AND has_column_privilege('service_role', 'public.weather_daily', c, 'INSERT')
            AND has_column_privilege('service_role', 'public.weather_daily', c, 'UPDATE')) THEN
      RAISE EXCEPTION 'S785: service_role cannot write weather_daily.% — the Edge Function would fail', c;
    END IF;
  END LOOP;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.weather_daily'::regclass) THEN
    RAISE EXCEPTION 'S785: RLS is off on weather_daily';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
