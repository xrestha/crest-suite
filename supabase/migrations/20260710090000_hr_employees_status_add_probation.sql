-- The Status dropdown in EmployeeForm.jsx has offered 'probation' as an option for a while
-- (used throughout EmployeeList.jsx's filters/counts, dashboards, etc.), but
-- hr_employees_status_check was never updated to allow it — only active/inactive/resigned/
-- terminated were permitted, so saving Status = Probation always violated the check constraint.
ALTER TABLE public.hr_employees DROP CONSTRAINT hr_employees_status_check;
ALTER TABLE public.hr_employees ADD CONSTRAINT hr_employees_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'probation'::text, 'inactive'::text, 'resigned'::text, 'terminated'::text]));
