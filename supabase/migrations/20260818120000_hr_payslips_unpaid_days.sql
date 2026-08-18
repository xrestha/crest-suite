-- S570: the payslip's absence line printed a day count that disagreed with its own amount.
--
-- `hr_payslips.absent_days` holds literal absences (t.absent). The absence deduction it sits
-- beside covers absences PLUS unpaid leave, half days and pre-join days (payrollCompute.js's
-- `unpaidDays`). So an employee with 1 absence and 3 unpaid-leave days read
-- "Absence / Unpaid Leave (1.0 days)" against four days' worth of money — on the one line of the
-- document whose comment says the day count exists precisely so it can be audited from memory.
--
-- absent_days could not simply be redefined: Payroll Run's Excel export renders it under the
-- header "Absent Days", where the narrow meaning is the correct one. Hence a second column.
--
-- Nullable with no default on purpose: payslips finalized before this migration genuinely do not
-- know their unpaid-day count, and PayslipBody prints no count at all when the value is absent
-- rather than substituting a figure it cannot verify.
ALTER TABLE public.hr_payslips
  ADD COLUMN IF NOT EXISTS unpaid_days numeric;

COMMENT ON COLUMN public.hr_payslips.unpaid_days IS
  'Total days the absence deduction docks: absences + unpaid leave + half days + pre-join days. Distinct from absent_days, which counts literal absences only.';
