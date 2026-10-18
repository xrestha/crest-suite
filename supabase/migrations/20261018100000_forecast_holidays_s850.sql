-- S850: the Daily Purchases vs Sales chart reads the Holiday Calendar.
--
-- The chart's Target and forecast now leave festival days out of the 28 days they learn a usual
-- weekday from, and apply the Owner's per-holiday sales figure (demand_multiplier) on the festival
-- itself (dailyForecast.js). They read the calendar through this function rather than the table
-- because of WHO captures the Target: whichever login opens the dashboard first in a new month, and
-- hr_holiday_calendar carries the RESTRICTIVE no_ims_staff and no_pos_pin_staff policies. For an
-- IMS staff login (a store-room or counting login) or a till PIN the table reads EMPTY, with no
-- error, so a Target captured by one of them would count Dashain as an ordinary week and stay that
-- way for the whole month.
--
-- What it hands back is the calendar's dates, names, types and festival figures for a range of
-- months, and nothing else. The month's holidays are not a secret from the staff who work them; the
-- table stays fenced exactly as it was, so writes and its other columns are untouched. A removed
-- holiday (removed_at, S748) is left out, as Demand Forecast's own read leaves it out.
--
-- Who: the operator for any outlet; otherwise a login of this outlet (my_client_id(), which follows
-- a switched outlet) that is not an HR Self-Service login, the same audience as the table's own
-- client_own policy before the staff fences. Wrapped whole in COALESCE: is_admin() and
-- my_client_id() are NULL for a login with no profile, and NULL must refuse.
--
-- Must be applied BEFORE the S850 frontend deploys: the dashboard treats a failed holiday read like a
-- failed history read (no Target captured, forecast from this month only), and a missing function is
-- a failed read.
--
-- Reversal: revert the S850 frontend first, then
--   DROP FUNCTION public.get_forecast_holidays(uuid, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.get_forecast_holidays(
  p_client_id uuid,
  p_from_year integer,
  p_from_month integer,
  p_to_year integer,
  p_to_month integer
)
RETURNS TABLE (bs_year integer, bs_month integer, bs_day integer, name text, holiday_type text, demand_multiplier numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT COALESCE(public.is_admin()
                  OR (p_client_id = public.my_client_id() AND NOT public.is_hr_self_service()), false) THEN
    RAISE EXCEPTION 'get_forecast_holidays: an outlet''s holiday calendar is read by that outlet''s own logins'
      USING ERRCODE = '42501', HINT = 'other_client';
  END IF;

  RETURN QUERY
  SELECT h.bs_year, h.bs_month, h.bs_day, h.name, h.holiday_type, h.demand_multiplier
    FROM hr_holiday_calendar h
   WHERE h.client_id = p_client_id
     AND h.removed_at IS NULL
     AND (h.bs_year, h.bs_month) >= (p_from_year, p_from_month)
     AND (h.bs_year, h.bs_month) <= (p_to_year, p_to_month)
   ORDER BY h.bs_year, h.bs_month, h.bs_day, h.id;
END;
$function$;

COMMENT ON FUNCTION public.get_forecast_holidays(uuid, integer, integer, integer, integer) IS
  'S850: the Holiday Calendar''s dates, names, types and festival figures for a range of BS months, for the dashboard forecast. Any login of the outlet except HR Self-Service; the operator for any outlet.';

-- PUBLIC first: a REVOKE from anon alone is a silent no-op while PUBLIC holds the grant.
REVOKE ALL ON FUNCTION public.get_forecast_holidays(uuid, integer, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_forecast_holidays(uuid, integer, integer, integer, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
