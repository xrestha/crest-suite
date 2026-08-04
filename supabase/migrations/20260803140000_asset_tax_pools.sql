-- Nepal Income Tax Act 2058 (Schedule 2 + Section 16) statutory pooled-WDV tax depreciation —
-- a genuinely separate system from the "book" (straight-line, per-asset) depreciation in
-- 20260803110000_fixed_asset_register.sql. Assets are grouped into 5 government-defined pools
-- (not tracked individually); each pool has its own declining-balance rate; disposal proceeds
-- reduce the pool directly (no per-asset gain/loss for tax purposes). The two systems are
-- expected to disagree with each other — that's normal, not a bug.
--
-- Rates/caps sourced from a legal-database rendering of the Act (Schedule 2 + Section 16) plus a
-- corroborating web search, not a live IRD/accountant confirmation — see
-- src/modules/ims/assets/taxPoolConstants.js for the verify-before-filing caveat carried into the
-- UI itself.

CREATE TABLE public.assets_tax_pool_runs (
    id           uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    -- e.g. "2082/83", matching getBsFiscalYear()'s output format (already used by Vendor Balance
    -- Confirmation) — a BS fiscal year, not the generic AD date range the book runs use, since
    -- Nepal tax depreciation is inherently tied to the real Shrawan-Ashadh fiscal year.
    fiscal_year  text NOT NULL,
    status       text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft', 'posted')),
    posted_at    timestamp with time zone,
    posted_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    notes        text,
    created_at   timestamp with time zone DEFAULT now()
    -- No UNIQUE(client_id, fiscal_year) — same reasoning as assets_depreciation_runs: a
    -- correction is a new run, never an edit to a posted one.
);

CREATE INDEX assets_tax_pool_runs_client_fy_idx ON public.assets_tax_pool_runs (client_id, fiscal_year);

CREATE TABLE public.assets_tax_pool_lines (
    id                          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id                   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    run_id                      uuid NOT NULL REFERENCES public.assets_tax_pool_runs(id) ON DELETE CASCADE,
    pool                        text NOT NULL CHECK (pool IN ('A','B','C','D','E')),
    opening_wdv                 numeric NOT NULL,
    additions_full              numeric NOT NULL DEFAULT 0, -- acquired in first third of FY
    additions_two_third         numeric NOT NULL DEFAULT 0, -- acquired in middle third
    additions_one_third         numeric NOT NULL DEFAULT 0, -- acquired in last third
    -- Reduces the pool directly, no per-asset gain/loss for tax purposes.
    disposal_proceeds           numeric NOT NULL DEFAULT 0,
    repair_expense_total        numeric NOT NULL DEFAULT 0,
    repair_expense_deductible   numeric NOT NULL DEFAULT 0, -- min(total, 5% of closing base)
    repair_expense_capitalized  numeric NOT NULL DEFAULT 0, -- excess rolled into NEXT year's opening
    -- opening + additions - disposals + prior year's capitalized repair excess.
    depreciation_base           numeric NOT NULL,
    depreciation_amount         numeric NOT NULL,
    closing_wdv                 numeric NOT NULL,
    is_posted                   boolean NOT NULL DEFAULT true,
    created_at                  timestamp with time zone DEFAULT now()
);

CREATE INDEX assets_tax_pool_lines_client_idx ON public.assets_tax_pool_lines (client_id, pool);
CREATE INDEX assets_tax_pool_lines_run_idx ON public.assets_tax_pool_lines (run_id);

-- Repair/maintenance expense ledger — feeds the Section 16 cap check above. NOT immutable like
-- the pool lines: it's ordinary data entry, editable any time. Editing an entry after its fiscal
-- year's pool run is already posted does NOT retroactively change that posted run's numbers —
-- same "posted = frozen snapshot" philosophy as Monthly Owner Report.
CREATE TABLE public.assets_repair_expenses (
    id           uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    asset_id     uuid REFERENCES public.assets_register(id) ON DELETE SET NULL, -- optional link
    -- Denormalized from the asset's tax_pool at entry time, so a later pool reassignment doesn't
    -- rewrite history.
    pool         text NOT NULL CHECK (pool IN ('A','B','C','D','E')),
    fiscal_year  text NOT NULL,
    expense_date date NOT NULL,
    amount       numeric NOT NULL CHECK (amount > 0),
    description  text,
    created_by   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at   timestamp with time zone DEFAULT now()
);

CREATE INDEX assets_repair_expenses_client_fy_idx ON public.assets_repair_expenses (client_id, fiscal_year, pool);

-- Same immutability trigger shape/function as assets_depreciation_schedule — reused, new binding,
-- since the guard logic (auth.uid() IS NOT NULL AND OLD.is_posted) is identical.
CREATE TRIGGER trg_enforce_tax_pool_lines_immutable
  BEFORE UPDATE OR DELETE ON public.assets_tax_pool_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_asset_schedule_immutable();

ALTER TABLE public.assets_tax_pool_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets_tax_pool_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assets_repair_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY assets_tax_pool_runs_client ON public.assets_tax_pool_runs FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY assets_tax_pool_lines_client ON public.assets_tax_pool_lines FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY assets_repair_expenses_client ON public.assets_repair_expenses FOR ALL
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
         OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid()));

-- Same 3-of-4 RESTRICTIVE staff-isolation shape as the book depreciation tables (excluding
-- no_ims_staff — see 20260803110000's comment for why).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assets_tax_pool_runs', 'assets_tax_pool_lines', 'assets_repair_expenses'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY no_self_service_accounts ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service())', t);
    EXECUTE format(
      'CREATE POLICY no_pos_pin_staff ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff())', t);
    EXECUTE format(
      'CREATE POLICY no_hr_role_staff ON public.%I AS RESTRICTIVE FOR ALL '
      || 'USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff())', t);
  END LOOP;
END $$;

CREATE TRIGGER audit_assets_tax_pool_runs AFTER INSERT OR DELETE OR UPDATE ON public.assets_tax_pool_runs
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_tax_pool_runs    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_tax_pool_lines   TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.assets_repair_expenses  TO authenticated;

NOTIFY pgrst, 'reload schema';
