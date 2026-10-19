-- STATUS: complete (draft for review; apply only on the owner's "apply")
--
-- S849 FORECAST — Demand Forecast reads its history through one server read, records who ran it,
-- learns how rainy its history was, and the weather cache is bounded.
-- Findings: FORECAST-1 (P1, SU1 a), FORECAST-2, FORECAST-4, FORECAST-5 (server's Nepal date),
--           FORECAST-7, FORECAST-8 (run log per horizon), GAPS-13.
-- Proposed file name: supabase/migrations/2026101612xxxx_demand_forecast_history_s849.sql
--
-- OBJECTS (all NEW; no existing function body is redefined, so there is no live-body pre-flight):
--   §1 FUNCTION public.demand_forecast_history(uuid, integer) RETURNS jsonb — SECURITY DEFINER,
--      caller-checked (operator, or the caller's own outlet at IMS supervisor+ via
--      ims_caller_has_rank('supervisor'), which already admits the Owner and refuses a count PIN).
--      Returns Nepal's today by the SERVER clock, the window start, one object per Nepal day with a
--      paid till bill {date, bills, covers, revenue (ex-VAT, gross of non-comped lines less the bill
--      discount), qty {recipe_id: plates, comped and Complimentary-bill plates included}}, and the
--      client's non-removed holidays. Never a bill row.
--      Rollback: DROP FUNCTION public.demand_forecast_history(uuid, integer);
--   §2 demand_forecast_run_log: ADD COLUMN run_by uuid, run_by_name text, horizon_days integer,
--      run_id uuid; CHECK demand_forecast_run_log_horizon_check; FUNCTION
--      public.demand_forecast_run_log_stamp() + TRIGGER demand_forecast_run_log_stamp (BEFORE INSERT
--      OR UPDATE): a browser login's row is stamped run_at = now(), run_by = auth.uid(), run_by_name =
--      its full name, whatever it sent; an UPDATE keeps the stamps.
--      Rollback: DROP TRIGGER demand_forecast_run_log_stamp ON public.demand_forecast_run_log;
--      DROP FUNCTION public.demand_forecast_run_log_stamp(); ALTER TABLE public.demand_forecast_run_log
--      DROP CONSTRAINT demand_forecast_run_log_horizon_check, DROP COLUMN run_by, DROP COLUMN run_by_name,
--      DROP COLUMN horizon_days, DROP COLUMN run_id;
--   §3 demand_forecast_daily: ADD COLUMN sample_rain_factor numeric, rainy_sample_count integer;
--      CHECK demand_forecast_daily_sample_rain_factor_check.
--      Rollback: ALTER TABLE public.demand_forecast_daily DROP CONSTRAINT
--      demand_forecast_daily_sample_rain_factor_check, DROP COLUMN sample_rain_factor,
--      DROP COLUMN rainy_sample_count;
--   §4 weather_locations: ADD COLUMN created_for_client uuid (FK clients ON DELETE SET NULL),
--      created_at timestamptz DEFAULT now(); INDEX weather_locations_created_for_client_idx.
--      Rollback: DROP INDEX public.weather_locations_created_for_client_idx; ALTER TABLE
--      public.weather_locations DROP COLUMN created_for_client, DROP COLUMN created_at;
--   §5 DATA: weather_daily / weather_locations rows moved from the 0.01° grid to the 0.1° grid the
--      redeployed weather-forecast function keys by (3 locations live: Kathmandu, Pokhara, Janakpur).
--      Rollback: none needed for correctness (the old function re-fetches its 0.01° keys); the moved
--      rows are public weather, not client data.
--   §6 Self-check (catalog) and a rolled-back behavioural probe.
--
-- No new table, so no staff-isolation list changes. New columns need no grants (table privileges
-- cover them). The browser keeps INSERT on the run log through client_own + ims_rank_guard.
--
-- DEPLOY ORDER: apply this migration, then deploy supabase/functions/weather-forecast at once (it
-- now keys by 0.1°). Between the two, the old function may re-create a 0.01° row for a city; such a
-- row is harmless and is listed by verify-FORECAST.sql query 12. Then ship the app bundle.

BEGIN;

-- ══ §1 The training read (FORECAST-1, -2, -5, -10b) ══════════════════════════════════════════════
--
-- Why DEFINER: pos_orders, pos_order_items and hr_holiday_calendar carry the RESTRICTIVE
-- no_ims_staff policy (20260719120000), so under an IMS supervisor's or manager's JWT the page's own
-- reads came back empty with no error and Recompute replaced the Owner's forecast with an empty one
-- (FORECAST-1). Owner decision SU1 (a): supervisors and managers may rebuild it, through a read that
-- hands back daily totals only — figures they already see on the page. Same shape as
-- ims_first_till_bill_at (20261013190000 §6) and hr_labour_actuals (20261001200000).
--
-- Revenue is BEFORE VAT and net of the bill discount: Σ qty × unit_price over the bill's lines that
-- were not comped, less pos_orders.discount_amount — what computeOrderAmounts' grossAmt − discount
-- meant, and what the server post nets into sales_entries (S830). The browser never read
-- discount_amount, so the forecast ran above Revenue by the discount share (FORECAST-2).
--
-- A day belongs to Nepal's calendar (FORECAST-5): closed_at AT TIME ZONE 'Asia/Kathmandu', and
-- "today" is the server's Nepal date, so a Recompute from Sydney neither moves dinner onto the next
-- day nor counts a part day. Today is never a sample: the window ends at the start of today.
--
-- Complimentary (writeoff) bills add their dishes' plates — the server post still depletes them as
-- pos_comp (FORECAST-10b) — but never covers, revenue or a day of their own: a day enters the
-- history only when it has a paid bill, so a staff-meal-only day is not a zero-revenue sample.
CREATE OR REPLACE FUNCTION public.demand_forecast_history(p_client_id uuid, p_lookback_days integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today     date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_from      date;
  v_start     timestamptz;
  v_end       timestamptz;
  v_from_year integer;
  v_days      jsonb;
  v_hols      jsonb;
BEGIN
  -- Wrapped as a whole: is_admin() and my_client_id() are NULL for a caller with no profile.
  IF NOT COALESCE(public.is_admin()
                  OR (p_client_id = public.my_client_id() AND public.ims_caller_has_rank('supervisor')), false) THEN
    RAISE EXCEPTION 'demand_forecast_forbidden: this login cannot rebuild this outlet''s demand forecast'
      USING ERRCODE = '42501';
  END IF;
  IF p_client_id IS NULL OR p_lookback_days IS NULL OR p_lookback_days < 7 OR p_lookback_days > 120 THEN
    RAISE EXCEPTION 'demand_forecast_range: ask for between 7 and 120 days of history'
      USING ERRCODE = '22023';
  END IF;

  v_from  := v_today - p_lookback_days;
  v_start := v_from::timestamp AT TIME ZONE 'Asia/Kathmandu';
  v_end   := v_today::timestamp AT TIME ZONE 'Asia/Kathmandu';

  WITH bills AS (
    SELECT o.id, o.close_type,
           COALESCE(NULLIF(o.covers, 0), 1) AS covers,
           COALESCE(o.discount_amount, 0)   AS discount,
           (o.closed_at AT TIME ZONE 'Asia/Kathmandu')::date AS d
      FROM pos_orders o
     WHERE o.client_id = p_client_id
       AND o.status = 'billed'
       AND o.close_type IN ('paid', 'writeoff')
       AND o.credit_note_id IS NULL
       AND o.closed_at >= v_start
       AND o.closed_at <  v_end
  ),
  lines AS (
    SELECT b.id AS order_id, b.d, i.recipe_id, i.qty, i.unit_price, COALESCE(i.comped, false) AS comped
      FROM bills b
      JOIN pos_order_items i ON i.order_id = b.id
  ),
  gross AS (
    SELECT l.order_id, sum(l.qty * l.unit_price) AS gross
      FROM lines l
     WHERE NOT l.comped
     GROUP BY l.order_id
  ),
  day_tot AS (
    SELECT b.d, count(*) AS bills, sum(b.covers) AS covers,
           sum(COALESCE(g.gross, 0) - b.discount) AS revenue
      FROM bills b
      LEFT JOIN gross g ON g.order_id = b.id
     WHERE b.close_type = 'paid'
     GROUP BY b.d
  ),
  dish AS (
    SELECT l.d, l.recipe_id, sum(l.qty) AS qty
      FROM lines l
     WHERE l.recipe_id IS NOT NULL
       AND l.d IN (SELECT t.d FROM day_tot t)
     GROUP BY l.d, l.recipe_id
  ),
  dish_by_day AS (
    SELECT dish.d, jsonb_object_agg(dish.recipe_id::text, dish.qty) AS qty
      FROM dish
     GROUP BY dish.d
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'date',    to_char(t.d, 'YYYY-MM-DD'),
           'bills',   t.bills,
           'covers',  t.covers,
           'revenue', round(t.revenue, 2),
           'qty',     COALESCE(q.qty, '{}'::jsonb)) ORDER BY t.d), '[]'::jsonb)
    INTO v_days
    FROM day_tot t
    LEFT JOIN dish_by_day q ON q.d = t.d;

  -- Holidays: past ones are left out of the averages, coming ones carry the multiplier. The year the
  -- window opens in onward; a date outside the BS table reads every year (COALESCE 0).
  SELECT b.bs_year INTO v_from_year
    FROM bs_months b
   WHERE v_from >= b.ad_start AND v_from < b.ad_start + b.days;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'bs_year',           h.bs_year,
           'bs_month',          h.bs_month,
           'bs_day',            h.bs_day,
           'name',              h.name,
           'holiday_type',      h.holiday_type,
           'demand_multiplier', h.demand_multiplier)
           ORDER BY h.bs_year, h.bs_month, h.bs_day, h.id), '[]'::jsonb)
    INTO v_hols
    FROM hr_holiday_calendar h
   WHERE h.client_id = p_client_id
     AND h.removed_at IS NULL
     AND h.bs_year >= COALESCE(v_from_year, 0);

  RETURN jsonb_build_object(
    'today',    to_char(v_today, 'YYYY-MM-DD'),
    'from',     to_char(v_from, 'YYYY-MM-DD'),
    'days',     v_days,
    'holidays', v_hols);
END;
$function$;

REVOKE ALL ON FUNCTION public.demand_forecast_history(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demand_forecast_history(uuid, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.demand_forecast_history(uuid, integer) IS
  'Demand Forecast''s training read (S849, FORECAST-1/SU1 a): Nepal''s today, and per Nepal day the paid till bills'' covers, ex-VAT revenue net of the bill discount and plates per dish; plus non-removed holidays. Operator, Owner or IMS supervisor+ of the caller''s own outlet.';


-- ══ §2 The run log says who ran it, when by the server's clock, and for which horizon ═════════════
-- (GAPS-13, FORECAST-8)
--
-- run_by has no foreign key on purpose: the operator's restore re-creates staff with new ids, and a
-- historic run row must not refuse to restore or lose its name. run_by_name is the snapshot.
-- A refused rebuild (no sales history to learn from) is logged as rows_written = 0 with no error;
-- every written run has at least one row per day, so the two can never be confused.
ALTER TABLE public.demand_forecast_run_log
  ADD COLUMN IF NOT EXISTS run_by       uuid,
  ADD COLUMN IF NOT EXISTS run_by_name  text,
  ADD COLUMN IF NOT EXISTS horizon_days integer,
  ADD COLUMN IF NOT EXISTS run_id       uuid;

ALTER TABLE public.demand_forecast_run_log DROP CONSTRAINT IF EXISTS demand_forecast_run_log_horizon_check;
ALTER TABLE public.demand_forecast_run_log ADD CONSTRAINT demand_forecast_run_log_horizon_check
  CHECK (horizon_days IS NULL OR horizon_days IN (7, 30));

COMMENT ON COLUMN public.demand_forecast_run_log.run_by IS
  'Who pressed Recompute (S849, GAPS-13). Stamped by demand_forecast_run_log_stamp from auth.uid(); NULL on rows written before S849.';
COMMENT ON COLUMN public.demand_forecast_run_log.run_by_name IS
  'Name snapshot of run_by at the time ("Crest support" for the operator). Survives the account''s deletion.';
COMMENT ON COLUMN public.demand_forecast_run_log.horizon_days IS
  'The horizon the run was for (7 or 30). NULL on rows written before S849.';
COMMENT ON COLUMN public.demand_forecast_run_log.run_id IS
  'demand_forecast_daily.run_id of the rows this run wrote; NULL for a refused or failed run.';
COMMENT ON COLUMN public.demand_forecast_run_log.rows_written IS
  'Rows the run wrote. 0 with error NULL = refused because there was no sales history to learn from (S849); nothing was replaced.';

CREATE OR REPLACE FUNCTION public.demand_forecast_run_log_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Who ran it and when is history: no later write moves it.
    NEW.run_at      := OLD.run_at;
    NEW.run_by      := OLD.run_by;
    NEW.run_by_name := OLD.run_by_name;
    RETURN NEW;
  END IF;

  IF current_user IN ('anon', 'authenticated') AND NOT COALESCE(public.is_admin(), false) THEN
    -- A client's own login: always the server's clock and the caller, whatever was sent.
    NEW.run_at      := now();
    NEW.run_by      := (select auth.uid());
    NEW.run_by_name := (SELECT p.full_name FROM profiles p WHERE p.id = (select auth.uid()));
  ELSE
    -- The operator, or a server role. A fresh row (the operator's own Recompute) is stamped as
    -- Crest support; a historic row arriving whole (the operator's restore) keeps its own stamps.
    NEW.run_at := COALESCE(NEW.run_at, now());
    IF NEW.run_by IS NULL AND NEW.run_at >= now() - interval '10 minutes' THEN
      NEW.run_by      := (select auth.uid());
      NEW.run_by_name := CASE WHEN COALESCE(public.is_admin(), false) THEN 'Crest support' ELSE NEW.run_by_name END;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- A trigger function needs no EXECUTE grant (checked at CREATE TRIGGER, never at fire time).
REVOKE ALL ON FUNCTION public.demand_forecast_run_log_stamp() FROM PUBLIC;

DROP TRIGGER IF EXISTS demand_forecast_run_log_stamp ON public.demand_forecast_run_log;
CREATE TRIGGER demand_forecast_run_log_stamp
  BEFORE INSERT OR UPDATE ON public.demand_forecast_run_log
  FOR EACH ROW EXECUTE FUNCTION public.demand_forecast_run_log_stamp();


-- ══ §3 How rainy the history behind each day was (FORECAST-4) ════════════════════════════════════
--
-- The buying list scales a rainy day ahead by the Owner's rain percentage, but the weekday average
-- it scales already holds the rainy days it learned from, so in a wet spell the rain was counted
-- twice (~37% short at 50%). The run now stores, on each day's covers-level row, the recency-
-- weighted mean of its samples' rain factors (1 for a dry or unrecorded day, the Owner's % for a
-- recorded rainy one) and how many of its samples were rainy. The page divides by the first, so the
-- list buys for a dry day's level × the rain ahead. The dish table and the Roster keep the observed
-- average, as before. NULL = the run had no rain setting or no weather.
ALTER TABLE public.demand_forecast_daily
  ADD COLUMN IF NOT EXISTS sample_rain_factor numeric,
  ADD COLUMN IF NOT EXISTS rainy_sample_count integer;

ALTER TABLE public.demand_forecast_daily DROP CONSTRAINT IF EXISTS demand_forecast_daily_sample_rain_factor_check;
ALTER TABLE public.demand_forecast_daily ADD CONSTRAINT demand_forecast_daily_sample_rain_factor_check
  CHECK ((sample_rain_factor IS NULL OR sample_rain_factor BETWEEN 0.3 AND 1.5)
     AND (rainy_sample_count IS NULL OR rainy_sample_count BETWEEN 0 AND 8));

COMMENT ON COLUMN public.demand_forecast_daily.sample_rain_factor IS
  'Recency-weighted mean rain factor of the samples behind this day (covers-level row only; S849, FORECAST-4). The buying list divides by it. NULL = no rain setting or no weather at run time.';
COMMENT ON COLUMN public.demand_forecast_daily.rainy_sample_count IS
  'How many of this day''s samples were recorded rainy days (covers-level row only; S849).';


-- ══ §4 The weather cache knows which outlet first asked for each point (FORECAST-7) ═══════════════
--
-- The weather-forecast function (redeployed with this) keys the cache on a 0.1° grid (~3,600 points
-- in Nepal's box instead of ~350,000; MET's model outside the Nordics is about that coarse anyway),
-- refuses to open more than 3 NEW points per outlet in 24 hours (the operator is exempt), and lets
-- only one caller fetch a point at a time. created_for_client is written once, on the row's first
-- insert; later upserts do not name it.
ALTER TABLE public.weather_locations
  ADD COLUMN IF NOT EXISTS created_for_client uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS weather_locations_created_for_client_idx
  ON public.weather_locations (created_for_client, created_at)
  WHERE created_for_client IS NOT NULL;

COMMENT ON COLUMN public.weather_locations.created_for_client IS
  'The outlet whose request first opened this point (S849, FORECAST-7); the per-outlet budget of new points counts these. NULL for points opened before S849.';


-- ══ §5 DATA — move the cached weather onto the 0.1° grid ═════════════════════════════════════════
--
-- What it does: every weather_daily row keyed off the 0.1° grid gets a copy at its rounded key
-- (a complete row preferred, then the latest fetch, where two old keys meet), then the off-grid rows
-- are deleted. weather_locations gets one row per rounded key, keeping the last fetch time but
-- dropping Last-Modified (it belongs to the old point, and sent for the new one it could earn a 304
-- for a point never fetched), then its off-grid rows are deleted. Live today: 3 points, no two of
-- which round to the same key, so nothing is merged; the past rain the dashboard and the forecast
-- measure against is kept.
-- Schema facts this relies on (review V1, checked 2026-10-19 against 20260923110000:53-72 and
-- 20260923120000; no later migration alters either table):
--   * lat_key / lon_key are numeric(5,2) on both tables (not double precision), so round(x, 1) is
--     round(numeric, integer) and needs no cast; a 0.1° value is stored as e.g. 27.70.
--   * weather_daily PRIMARY KEY (lat_key, lon_key, ad_date) and weather_locations PRIMARY KEY
--     (lat_key, lon_key) are the unique indexes behind the two ON CONFLICT clauses.
--   * weather_locations.expires_at (and fetched_at, last_modified, last_error) are nullable, so the
--     NULLs inserted below are legal; precip_mm NOT NULL is copied from the old row.
--   * No foreign key joins the two tables (neither migration declares one; the only FK either table
--     gets is §4's created_for_client → clients), so the order of the four statements is free; daily
--     goes first. verify-FORECAST's block 4b reads this back.
--   * The two DELETEs run as the migration role. service_role (the Edge Function) still has only
--     SELECT, INSERT, UPDATE on both tables (20260923110000:80-83), which is enough: the redeployed
--     function upserts and updates and never deletes (plan-FORECAST.md FORECAST-7). A future prune in
--     the function needs a GRANT DELETE ... TO service_role in a migration first.
INSERT INTO public.weather_daily (lat_key, lon_key, ad_date, precip_mm, complete, fetched_at,
                                  temp_max, temp_min, cloud_pct, thunder)
SELECT DISTINCT ON (round(w.lat_key, 1), round(w.lon_key, 1), w.ad_date)
       round(w.lat_key, 1), round(w.lon_key, 1), w.ad_date, w.precip_mm, w.complete, w.fetched_at,
       w.temp_max, w.temp_min, w.cloud_pct, w.thunder
  FROM public.weather_daily w
 WHERE w.lat_key <> round(w.lat_key, 1) OR w.lon_key <> round(w.lon_key, 1)
 ORDER BY round(w.lat_key, 1), round(w.lon_key, 1), w.ad_date, w.complete DESC, w.fetched_at DESC
ON CONFLICT (lat_key, lon_key, ad_date) DO NOTHING;

DELETE FROM public.weather_daily
 WHERE lat_key <> round(lat_key, 1) OR lon_key <> round(lon_key, 1);

INSERT INTO public.weather_locations (lat_key, lon_key, fetched_at, expires_at, last_modified, last_error)
SELECT DISTINCT ON (round(l.lat_key, 1), round(l.lon_key, 1))
       round(l.lat_key, 1), round(l.lon_key, 1), l.fetched_at, NULL, NULL, NULL
  FROM public.weather_locations l
 WHERE l.lat_key <> round(l.lat_key, 1) OR l.lon_key <> round(l.lon_key, 1)
 ORDER BY round(l.lat_key, 1), round(l.lon_key, 1), l.fetched_at DESC NULLS LAST
ON CONFLICT (lat_key, lon_key) DO NOTHING;

DELETE FROM public.weather_locations
 WHERE lat_key <> round(lat_key, 1) OR lon_key <> round(lon_key, 1);


-- ══ §6 Prove it ══════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_client   uuid;
  v_owner    uuid;
  v_name     text;
  v_ok       jsonb;
  v_sup      jsonb;
  v_from     date;
  v_today    date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_bills    bigint; v_covers bigint; v_rev numeric;
  v_rbills   bigint; v_rcovers bigint; v_rrev numeric;
  v_qty_paid numeric; v_qty_all numeric; v_rqty numeric;
  v_seen     integer;
  v_raised   boolean;
  v_log      record;
BEGIN
  -- Catalog: DEFINER, search_path pinned, grants as written, the trigger in place.
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.demand_forecast_history(uuid,integer)'::regprocedure) THEN
    RAISE EXCEPTION 'S849 FORECAST: demand_forecast_history is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.demand_forecast_history(uuid,integer)'::regprocedure
                    AND proconfig @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'S849 FORECAST: demand_forecast_history has no pinned search_path';
  END IF;
  IF has_function_privilege('anon', 'public.demand_forecast_history(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.demand_forecast_history(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.demand_forecast_history(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.demand_forecast_run_log_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'S849 FORECAST: a grant is not what this file says';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.demand_forecast_run_log'::regclass
                    AND tgname = 'demand_forecast_run_log_stamp' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S849 FORECAST: the run-log stamp trigger is missing';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
        AND ((table_name = 'demand_forecast_run_log' AND column_name IN ('run_by', 'run_by_name', 'horizon_days', 'run_id'))
          OR (table_name = 'demand_forecast_daily' AND column_name IN ('sample_rain_factor', 'rainy_sample_count'))
          OR (table_name = 'weather_locations' AND column_name IN ('created_for_client', 'created_at')))) <> 8 THEN
    RAISE EXCEPTION 'S849 FORECAST: a new column is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.weather_daily WHERE lat_key <> round(lat_key, 1) OR lon_key <> round(lon_key, 1))
     OR EXISTS (SELECT 1 FROM public.weather_locations WHERE lat_key <> round(lat_key, 1) OR lon_key <> round(lon_key, 1)) THEN
    RAISE EXCEPTION 'S849 FORECAST: a weather row is still off the 0.1° grid';
  END IF;

  -- Behaviour, at the outlet with the most till bills in the window that has an Owner login.
  v_from := v_today - 84;
  SELECT o.client_id INTO v_client
    FROM public.pos_orders o
   WHERE o.status = 'billed' AND o.close_type = 'paid'
     AND o.closed_at >= (v_from::timestamp AT TIME ZONE 'Asia/Kathmandu')
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = o.client_id
                    AND COALESCE(p.active_client_id, p.client_id) = o.client_id
                    AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
                    AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false))
   GROUP BY o.client_id ORDER BY count(*) DESC LIMIT 1;
  IF v_client IS NULL THEN
    RAISE NOTICE 'S849 FORECAST probe skipped: no outlet with till bills in the last 84 days and an Owner login';
    RETURN;
  END IF;
  SELECT p.id, p.full_name INTO v_owner, v_name FROM public.profiles p
   WHERE p.client_id = v_client AND COALESCE(p.active_client_id, p.client_id) = v_client
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
     AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id LIMIT 1;

  -- What the window holds, read directly as the migration's role.
  SELECT count(*), sum(COALESCE(NULLIF(o.covers, 0), 1)),
         sum(COALESCE((SELECT sum(i.qty * i.unit_price) FROM public.pos_order_items i
                        WHERE i.order_id = o.id AND NOT COALESCE(i.comped, false)), 0) - COALESCE(o.discount_amount, 0))
    INTO v_bills, v_covers, v_rev
    FROM public.pos_orders o
   WHERE o.client_id = v_client AND o.status = 'billed' AND o.close_type = 'paid' AND o.credit_note_id IS NULL
     AND o.closed_at >= (v_from::timestamp AT TIME ZONE 'Asia/Kathmandu')
     AND o.closed_at <  (v_today::timestamp AT TIME ZONE 'Asia/Kathmandu');
  SELECT COALESCE(sum(i.qty) FILTER (WHERE o.close_type = 'paid'), 0), COALESCE(sum(i.qty), 0)
    INTO v_qty_paid, v_qty_all
    FROM public.pos_orders o JOIN public.pos_order_items i ON i.order_id = o.id
   WHERE o.client_id = v_client AND o.status = 'billed' AND o.close_type IN ('paid', 'writeoff')
     AND o.credit_note_id IS NULL AND i.recipe_id IS NOT NULL
     AND o.closed_at >= (v_from::timestamp AT TIME ZONE 'Asia/Kathmandu')
     AND o.closed_at <  (v_today::timestamp AT TIME ZONE 'Asia/Kathmandu');

  BEGIN
    -- (1) The Owner's read agrees with the window.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := public.demand_forecast_history(v_client, 84);
    RESET ROLE;
    SELECT COALESCE(sum((d ->> 'bills')::bigint), 0), COALESCE(sum((d ->> 'covers')::bigint), 0),
           COALESCE(sum((d ->> 'revenue')::numeric), 0)
      INTO v_rbills, v_rcovers, v_rrev
      FROM jsonb_array_elements(v_ok -> 'days') d;
    SELECT COALESCE(sum(q.value::numeric), 0) INTO v_rqty
      FROM jsonb_array_elements(v_ok -> 'days') d, jsonb_each_text(d -> 'qty') q;
    IF v_ok ->> 'today' IS DISTINCT FROM to_char(v_today, 'YYYY-MM-DD')
       OR v_rbills <> v_bills OR v_rcovers <> v_covers OR abs(v_rrev - v_rev) > 0.05 * GREATEST(v_bills, 1)
       OR v_rqty < v_qty_paid OR v_rqty > v_qty_all THEN
      RAISE EXCEPTION 'S849 FORECAST probe: the read disagrees with the window (bills % vs %, covers % vs %, revenue % vs %, plates % in [%, %], today %)',
        v_rbills, v_bills, v_rcovers, v_covers, v_rrev, v_rev, v_rqty, v_qty_paid, v_qty_all, v_ok ->> 'today';
    END IF;

    -- (2) The same login as an IMS supervisor (a stand-in, rolled back): the till is still fenced
    --     from its direct reads, and the server read hands back exactly the Owner's figures.
    UPDATE public.profiles SET ims_role = 'supervisor' WHERE id = v_owner;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_seen FROM public.pos_orders WHERE client_id = v_client;
    v_sup := public.demand_forecast_history(v_client, 84);
    RESET ROLE;
    IF v_seen <> 0 THEN
      RAISE EXCEPTION 'S849 FORECAST probe: an IMS supervisor read % till bills directly; the fence is not what FORECAST-1 says', v_seen;
    END IF;
    IF (v_sup -> 'days') IS DISTINCT FROM (v_ok -> 'days') OR (v_sup -> 'holidays') IS DISTINCT FROM (v_ok -> 'holidays') THEN
      RAISE EXCEPTION 'S849 FORECAST probe: the IMS supervisor''s read differs from the Owner''s';
    END IF;

    -- (3) The run log stamps the supervisor, by the server's clock, whatever was sent; an UPDATE
    --     cannot move the stamps.
    SET LOCAL ROLE authenticated;
    INSERT INTO public.demand_forecast_run_log (client_id, run_at, method, rows_written, error, run_by, run_by_name, horizon_days)
      VALUES (v_client, '2020-01-01T00:00:00Z', 'weekday_weighted_average', 0, NULL, gen_random_uuid(), 'forged', 7)
      RETURNING * INTO v_log;
    UPDATE public.demand_forecast_run_log SET run_at = '2020-01-01T00:00:00Z', run_by = NULL WHERE id = v_log.id;
    RESET ROLE;
    IF v_log.run_by IS DISTINCT FROM v_owner OR v_log.run_by_name IS DISTINCT FROM v_name
       OR v_log.run_at < now() - interval '1 minute'
       OR (SELECT run_at FROM public.demand_forecast_run_log WHERE id = v_log.id) IS DISTINCT FROM v_log.run_at
       OR (SELECT run_by FROM public.demand_forecast_run_log WHERE id = v_log.id) IS DISTINCT FROM v_owner THEN
      RAISE EXCEPTION 'S849 FORECAST probe: the run log took the sent stamp (run_by %, name %, run_at %)',
        v_log.run_by, v_log.run_by_name, v_log.run_at;
    END IF;

    -- (4) An IMS staff rank, and a signed-in login with no profile, are refused.
    UPDATE public.profiles SET ims_role = 'staff' WHERE id = v_owner;
    v_raised := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.demand_forecast_history(v_client, 84);
    EXCEPTION WHEN insufficient_privilege THEN v_raised := true;
    END;
    RESET ROLE;
    IF NOT v_raised THEN RAISE EXCEPTION 'S849 FORECAST probe: an IMS staff rank read the forecast history'; END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', gen_random_uuid())::text, true);
    v_raised := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.demand_forecast_history(v_client, 84);
    EXCEPTION WHEN insufficient_privilege THEN v_raised := true;
    END;
    RESET ROLE;
    IF NOT v_raised THEN RAISE EXCEPTION 'S849 FORECAST probe: a login with no profile read the forecast history'; END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's849_forecast_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's849_forecast_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
