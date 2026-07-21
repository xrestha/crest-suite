-- Monthly Owner/Manager Report — frozen per-period snapshot combining IMS + HR + POS figures,
-- generated when a monthly_periods row closes (see src/modules/ownerReport/generateMonthlyReport.js).
-- Deliberately a snapshot table, not a live view: admin can edit a closed period's data in place
-- (Stock.js's isLocked exemption), and a report must never silently reflect a later correction.

CREATE TABLE public.monthly_owner_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES public.clients(id),
  period_id          uuid NOT NULL REFERENCES public.monthly_periods(id),
  bs_year            integer NOT NULL,
  bs_month           integer NOT NULL,
  modules_included   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { ims, hr, pos } AT GENERATION TIME
  snapshot           jsonb NOT NULL,                        -- computed report body (see computeMonthlyReport.js)
  schema_version     integer NOT NULL DEFAULT 1,
  generation_source  text NOT NULL DEFAULT 'period_close'
                       CHECK (generation_source IN ('period_close', 'backfill', 'manual_regenerate')),
  generated_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  generated_at       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT monthly_owner_reports_client_period_unique UNIQUE (client_id, period_id)
);

CREATE INDEX monthly_owner_reports_client_bsym_idx
  ON public.monthly_owner_reports (client_id, bs_year DESC, bs_month DESC);

ALTER TABLE public.monthly_owner_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY monthly_owner_reports_all ON public.monthly_owner_reports
  USING (client_id = public.my_client_id() OR public.is_admin())
  WITH CHECK (client_id = public.my_client_id() OR public.is_admin());

-- Carries HR payroll/headcount detail alongside IMS/POS financials — same "owner/admin only,
-- no staff account type at all" posture this codebase already applies to its most sensitive
-- tables (see 20260708130000, 20260719120000, 20260720170000). Deliberately NOT rank-aware.
CREATE POLICY no_self_service_accounts ON public.monthly_owner_reports AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_pos_pin_staff ON public.monthly_owner_reports AS RESTRICTIVE FOR ALL
  USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff());
CREATE POLICY no_ims_staff ON public.monthly_owner_reports AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
CREATE POLICY no_hr_role_staff ON public.monthly_owner_reports AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

NOTIFY pgrst, 'reload schema';
