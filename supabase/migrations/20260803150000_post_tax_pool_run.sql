-- Post for Nepal pooled-WDV tax depreciation — same shape and same reasoning as
-- post_asset_depreciation_run (20260803130000): one transaction covering the run-insert + N
-- pool-line-inserts, plain LANGUAGE plpgsql (no SECURITY DEFINER) so RLS keeps applying
-- untouched, no SQL-side rank check (post-only-by-manager enforced at the app layer).
CREATE FUNCTION public.post_tax_pool_run(
  p_client_id uuid, p_fiscal_year text, p_lines jsonb, p_notes text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_run_id uuid;
BEGIN
  INSERT INTO assets_tax_pool_runs (client_id, fiscal_year, status, posted_at, posted_by, created_by, notes)
  VALUES (p_client_id, p_fiscal_year, 'posted', now(), auth.uid(), auth.uid(), p_notes)
  RETURNING id INTO v_run_id;

  INSERT INTO assets_tax_pool_lines (
    client_id, run_id, pool,
    opening_wdv, additions_full, additions_two_third, additions_one_third, disposal_proceeds,
    repair_expense_total, repair_expense_deductible, repair_expense_capitalized,
    depreciation_base, depreciation_amount, closing_wdv, is_posted
  )
  SELECT
    p_client_id, v_run_id, l->>'pool',
    (l->>'opening_wdv')::numeric, (l->>'additions_full')::numeric, (l->>'additions_two_third')::numeric,
    (l->>'additions_one_third')::numeric, (l->>'disposal_proceeds')::numeric,
    (l->>'repair_expense_total')::numeric, (l->>'repair_expense_deductible')::numeric,
    (l->>'repair_expense_capitalized')::numeric,
    (l->>'depreciation_base')::numeric, (l->>'depreciation_amount')::numeric, (l->>'closing_wdv')::numeric, true
  FROM jsonb_array_elements(p_lines) AS l;

  RETURN v_run_id;
END $$;

REVOKE EXECUTE ON FUNCTION public.post_tax_pool_run(uuid, text, jsonb, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.post_tax_pool_run(uuid, text, jsonb, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
