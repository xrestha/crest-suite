-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Final Settlement becomes a record, not a calculation (S600)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- /hr/settlement has always computed a leaver's payout and printed it, writing nothing. The
-- consequences were left to the operator as a checklist — settle the recovered advances, mark the
-- employee, record the encashment — and the first of those has teeth: an advance recovered in a
-- settlement but left Active is deducted again on the employee's next payroll run.
--
-- This adds the artifact the feature was missing, plus the one column that makes the advance
-- recovery reversible.

-- ── 1. The settlement itself ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hr_final_settlements (
  id                    uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  client_id             uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,

  -- draft → finalized. A draft has no authority: it does not close advances, does not stamp the
  -- employee, and is ignored by the leave balance. Finalize walks the ledgers and flips this LAST,
  -- so a crash part-way leaves a draft rather than a document asserting money moved that didn't.
  status                text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  finalized_at          timestamptz,
  -- Finalized means computed and locked. PAID is a separate fact — a settlement sits unpaid for
  -- days in real life, which is why hr_tada_claims already models the same distinction.
  paid_at               timestamptz,
  paid_method           text,

  -- ── Inputs, so the document can be reproduced exactly ──
  separation_reason     text NOT NULL DEFAULT 'resignation'
                          CHECK (separation_reason IN ('resignation', 'termination', 'retirement', 'mutual')),
  last_working_date     date NOT NULL,
  notice_days           numeric(5,1) DEFAULT 0,
  notice_served         boolean NOT NULL DEFAULT true,
  leave_days_encashed   numeric(5,1) DEFAULT 0,
  -- Which leave type was encashed. Quotas are per type and type codes are user-editable, so a
  -- bare day count could not be subtracted from any balance deterministically.
  leave_type_id         uuid REFERENCES public.hr_leave_types(id) ON DELETE SET NULL,
  festival_paid         boolean NOT NULL DEFAULT true,

  -- ── Frozen context ──
  -- The printed statement shows its own workings ("50,000 ÷ 26 × 12"). Re-deriving these from the
  -- live employee record means a reprint after any raise visibly contradicts the frozen amount
  -- next to it. Same rule as the Monthly Owner Report: resolve display values at generation time.
  employee_name         text,
  employee_code         text,
  department            text,
  basic_salary          numeric(12,2) DEFAULT 0,
  join_date             date,
  ssf_enrolled          boolean,
  ssf_no                text,
  -- The rate assumptions this payout was computed under. payrollConstants.js opens by saying these
  -- change on government revision, and Reopen re-derives figures — without these frozen, reopening
  -- an old settlement after a rate change would silently restate what someone was paid.
  ssf_cap               numeric(12,2),
  ssf_gratuity_pct      numeric(6,4),
  vesting_months        integer,
  day_divisor           integer,

  -- ── Frozen figures ──
  service_months        integer DEFAULT 0,
  partial_salary        numeric(12,2) DEFAULT 0,
  leave_encashment      numeric(12,2) DEFAULT 0,
  gratuity_accrued      numeric(12,2) DEFAULT 0,
  gratuity_ssf_covered  numeric(12,2) DEFAULT 0,
  gratuity              numeric(12,2) DEFAULT 0,
  festival_pro          numeric(12,2) DEFAULT 0,
  notice_deduction      numeric(12,2) DEFAULT 0,
  advance_deduction     numeric(12,2) DEFAULT 0,
  lump_tds              numeric(12,2) DEFAULT 0,
  gross_payout          numeric(12,2) DEFAULT 0,
  net_payout            numeric(12,2) DEFAULT 0,

  -- ── What Reopen has to put back ──
  -- All three are editable elsewhere (the Employee form has an end-date picker; the Employees list
  -- has a bulk Deactivate for access_blocked), so Finalize can overwrite a value a human set.
  prior_status          text,
  prior_end_date        date,
  prior_access_blocked  boolean,

  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Deliberately NO unique constraint on (client_id, employee_id): an employee can be rehired and
-- settled again, and employee_code carries no unique constraint either, so both re-use and
-- re-creation are viable paths. Readers must take the latest by last_working_date, never
-- .maybeSingle().
CREATE INDEX IF NOT EXISTS idx_hr_final_settlements_client   ON public.hr_final_settlements (client_id);
CREATE INDEX IF NOT EXISTS idx_hr_final_settlements_employee ON public.hr_final_settlements (employee_id);

ALTER TABLE public.hr_final_settlements ENABLE ROW LEVEL SECURITY;

-- One permissive policy for all commands, matching hr_advances. Self-service accounts are excluded
-- inline (the hr_* convention) rather than by a separate restrictive policy.
CREATE POLICY hr_final_settlements_all ON public.hr_final_settlements
  TO authenticated
  USING (
    (public.is_admin() OR client_id = public.my_client_id())
    AND NOT public.is_hr_self_service()
  )
  WITH CHECK (
    (public.is_admin() OR client_id = public.my_client_id())
    AND NOT public.is_hr_self_service()
  );

-- Staff-account isolation. A POS PIN account and an IMS staff account have no business reading
-- anyone's gratuity. NOT no_hr_role_staff — HR staff must reach their own module's screens.
CREATE POLICY no_pos_pin_staff ON public.hr_final_settlements AS RESTRICTIVE FOR ALL
  USING (NOT public.is_pos_pin_staff()) WITH CHECK (NOT public.is_pos_pin_staff());
CREATE POLICY no_ims_staff ON public.hr_final_settlements AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());

-- Raw-SQL tables get NO role grants in this project by default — without this the table is
-- invisible to the app even with RLS correct.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_final_settlements TO authenticated;
GRANT ALL ON public.hr_final_settlements TO service_role;

-- A settlement is money paid to a person on the strength of stored figures; it belongs in the
-- audit trail alongside payslips and payroll runs.
CREATE OR REPLACE TRIGGER audit_hr_final_settlements
  AFTER INSERT OR DELETE OR UPDATE ON public.hr_final_settlements
  FOR EACH ROW EXECUTE FUNCTION public.log_audit();

-- ── 2. Make the advance recovery reversible ──────────────────────────────────────────────────
-- The exact mirror of payroll_run_id, which is the only reason payroll's Reopen can undo what its
-- Finalize did. Without it a settlement-created repayment is indistinguishable from one a manager
-- entered by hand, and Reopen could not safely delete either.
ALTER TABLE public.hr_advance_repayments
  ADD COLUMN IF NOT EXISTS final_settlement_id uuid REFERENCES public.hr_final_settlements(id) ON DELETE SET NULL;

-- Indexed because a scopedDelete filters on it — the same reason payroll_run_id is indexed, and
-- not merely because a linter would list it.
CREATE INDEX IF NOT EXISTS idx_hr_advance_repayments_settlement
  ON public.hr_advance_repayments (final_settlement_id);

NOTIFY pgrst, 'reload schema';
