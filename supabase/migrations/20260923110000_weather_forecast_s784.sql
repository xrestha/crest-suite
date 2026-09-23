-- S784 — weather-adjusted sales forecast on the dashboard's Daily Purchases vs Sales chart.
--
-- Three things:
--   1. Four columns on `settings` (one row per client, and each outlet is its own client): the
--      outlet's city and its coordinates, and the Owner's "a rainy day sells about N% of a normal
--      day". The city picker writes all three location columns together; the coordinates are what
--      the weather-forecast Edge Function reads, and it reads them from HERE, never from the
--      request, so the function cannot be pointed at an arbitrary place.
--   2. Two tables the weather-forecast Edge Function owns: `weather_locations` (one row per rounded
--      coordinate pair, the fetch bookkeeping MET Norway's terms ask for: Expires / Last-Modified)
--      and `weather_daily` (rain per Nepal-local day). A past day's row is the last COMPLETE
--      full-day forecast made before it began, so the table doubles as the recorded weather the
--      dashboard measures a rainy-day effect against. Public weather, not client data: no
--      client_id, so neither joins CLIENT_SCOPED_TABLES, the staff-isolation lists, Danger Zone or
--      the export's RESTORE_ORDER.
--   3. `feature_flags.weather_forecast`, the column without which every other flag save for every
--      other client fails (new-feature-checklist). Growth tier; no grandfather sweep, it is new.
--
-- The four settings columns are deliberately NOT added to settings_guard_staff_roles. That guard
-- holds what is printed on a bill or shown to a guest; these only move a dashed forecast line, the
-- same kind of preference as fc_warning_pct, which is unguarded. The Settings → Weather tab is
-- Owner-only in the UI.
--
-- Reverse: DROP TABLE public.weather_daily, public.weather_locations; ALTER TABLE public.settings
-- DROP COLUMN weather_city, weather_lat, weather_lon, rain_sales_pct (the CHECKs go with them);
-- ALTER TABLE public.feature_flags DROP COLUMN weather_forecast.

-- 1. settings -------------------------------------------------------------------------------

ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS weather_city text;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS weather_lat numeric(5,2);
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS weather_lon numeric(5,2);
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS rain_sales_pct smallint;

-- 0 is refused rather than read as "use the default": settings-row.md's `|| default` rule. A
-- cleared box is NULL, which means no adjustment.
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_rain_sales_pct_range;
ALTER TABLE public.settings ADD CONSTRAINT settings_rain_sales_pct_range
  CHECK (rain_sales_pct IS NULL OR rain_sales_pct BETWEEN 30 AND 150);

ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_weather_coords_pair;
ALTER TABLE public.settings ADD CONSTRAINT settings_weather_coords_pair
  CHECK ((weather_lat IS NULL) = (weather_lon IS NULL));

-- Nepal's bounding box. The Edge Function checks it again, as a second line.
ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_weather_coords_nepal;
ALTER TABLE public.settings ADD CONSTRAINT settings_weather_coords_nepal
  CHECK (weather_lat IS NULL OR (weather_lat BETWEEN 26.3 AND 30.5 AND weather_lon BETWEEN 80.0 AND 88.3));

-- 2. weather tables ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.weather_locations (
  lat_key       numeric(5,2) NOT NULL,
  lon_key       numeric(5,2) NOT NULL,
  fetched_at    timestamptz,
  expires_at    timestamptz,
  last_modified text,
  last_error    text,
  PRIMARY KEY (lat_key, lon_key)
);

CREATE TABLE IF NOT EXISTS public.weather_daily (
  lat_key    numeric(5,2) NOT NULL,
  lon_key    numeric(5,2) NOT NULL,
  ad_date    date NOT NULL,
  precip_mm  numeric(6,1) NOT NULL,
  -- true when the fetch that wrote this row began before the day's 05:45–23:45 window, so the
  -- figure covers the whole trading day. An incomplete row never overwrites a complete one.
  complete   boolean NOT NULL DEFAULT false,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lat_key, lon_key, ad_date)
);

-- RLS on with no policies: the Edge Function (service role) is the only reader and writer. The
-- browser never touches either table. REVOKE ALL also takes the TRUNCATE / REFERENCES / TRIGGER /
-- MAINTAIN that the schema's default privileges hand anon and authenticated (S782).
ALTER TABLE public.weather_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weather_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.weather_locations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.weather_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.weather_locations TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.weather_daily TO service_role;

-- 3. feature flag -----------------------------------------------------------------------------

ALTER TABLE public.feature_flags ADD COLUMN IF NOT EXISTS weather_forecast boolean DEFAULT false;

-- Assertions: on catalog values, never on formatted strings (supabase-sql.md, S630). ------------

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.weather_locations', 'public.weather_daily'] LOOP
    IF has_table_privilege('anon', t, 'SELECT')
       OR has_table_privilege('authenticated', t, 'SELECT')
       OR has_table_privilege('authenticated', t, 'INSERT')
       OR has_table_privilege('authenticated', t, 'TRUNCATE')
       OR has_table_privilege('authenticated', t, 'REFERENCES')
       OR has_table_privilege('authenticated', t, 'TRIGGER')
       OR has_table_privilege('anon', t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'S784: % still grants something to a client role', t;
    END IF;
    IF NOT (has_table_privilege('service_role', t, 'SELECT')
            AND has_table_privilege('service_role', t, 'INSERT')
            AND has_table_privilege('service_role', t, 'UPDATE')) THEN
      RAISE EXCEPTION 'S784: service_role cannot read and write % — the Edge Function would fail', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
      RAISE EXCEPTION 'S784: RLS is off on %', t;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'settings'
        AND column_name IN ('weather_city', 'weather_lat', 'weather_lon', 'rain_sales_pct')) <> 4 THEN
    RAISE EXCEPTION 'S784: settings is missing a weather column';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'feature_flags'
                   AND column_name = 'weather_forecast') THEN
    RAISE EXCEPTION 'S784: feature_flags.weather_forecast is missing — every flag save would fail';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
