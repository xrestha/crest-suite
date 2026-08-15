-- S562: decouple "block Self-Service login" from hr_employees.status.
--
-- S561 gated hr-selfservice-login on status = 'inactive', which seemed right in isolation but
-- collided with a real workflow the moment it shipped: PayrollRun.jsx, PayrollCalculation.jsx and
-- FinalSettlement.jsx all query employees with `.in('status', ['active','probation'])`, so the
-- instant an employee is marked Inactive/Resigned/Terminated (which is exactly when their FINAL
-- payroll and settlement still need to be run) they vanish from every payroll picker and any
-- already-generated draft payslip loses its name lookup. Status cannot be both "the payroll
-- eligibility flag" and "the login gate" without one breaking the other.
--
-- access_blocked is a new, independent boolean. hr-selfservice-login now checks ONLY this column,
-- never status — an admin can block/unblock Self-Service login (bulk, from Employees) without it
-- having any effect on which employees Payroll Run/Calculation/Final Settlement can see. Defaults
-- to false for every existing row, which also restores login for anyone S561's status-based check
-- had started blocking.
ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS access_blocked boolean NOT NULL DEFAULT false;
