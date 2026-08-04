-- Post collapses a run-insert + N schedule-line-inserts into one statement-level transaction
-- (same motivation as save_sales_day, 20260727120000_save_sales_day_atomic.sql): two sequential
-- round trips from the browser risk a stall between them leaving an orphaned 'posted' run row
-- with zero/partial schedule lines — which, thanks to the immutability trigger above, could never
-- be corrected or cleaned up by anything but Danger Zone.
--
-- Deliberately NOT SECURITY DEFINER, for the exact reason save_sales_day gives: running as
-- INVOKER means assets_depreciation_runs/assets_depreciation_schedule's own RLS (permissive
-- same-client + the 3 RESTRICTIVE staff-isolation policies) keeps applying with no
-- reimplementation. No SQL-side rank check either — post-only-by-manager is enforced at the app
-- layer (hasImsAccess('manager') gate on the Post button/handler), matching this codebase's
-- existing precedent exactly (hr_payroll_runs.finalize() also has no server-side rank check,
-- only PayrollRun.jsx's route guard).
CREATE FUNCTION public.post_asset_depreciation_run(
  p_client_id uuid, p_period_start date, p_period_end date, p_lines jsonb, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_run_id uuid;
BEGIN
  INSERT INTO assets_depreciation_runs (client_id, period_start, period_end, status, posted_at, posted_by, created_by, notes)
  VALUES (p_client_id, p_period_start, p_period_end, 'posted', now(), auth.uid(), auth.uid(), p_notes)
  RETURNING id INTO v_run_id;

  INSERT INTO assets_depreciation_schedule (
    client_id, run_id, asset_id, period_start, period_end,
    opening_nbv, annual_depreciation, depreciation_amount, override_amount, override_reason,
    closing_nbv, is_posted
  )
  SELECT
    p_client_id, v_run_id, (l->>'asset_id')::uuid, p_period_start, p_period_end,
    (l->>'opening_nbv')::numeric, (l->>'annual_depreciation')::numeric,
    (l->>'depreciation_amount')::numeric, NULLIF(l->>'override_amount','')::numeric, l->>'override_reason',
    (l->>'closing_nbv')::numeric, true
  FROM jsonb_array_elements(p_lines) AS l;

  RETURN v_run_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.post_asset_depreciation_run(uuid, date, date, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.post_asset_depreciation_run(uuid, date, date, jsonb, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
