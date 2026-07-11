-- Mark Attendance: let an admin enter an employee's actual clock-in/clock-out time per day
-- instead of only a status + manually-typed OT hours number. hours_worked/ot_hours are still
-- the columns payroll actually reads (see payrollCompute.js) — start_time/end_time are the raw
-- input the frontend uses to compute them (against that day's Roster-assigned shift hours, or
-- STANDARD_HOURS_PER_DAY if unrostered), kept alongside for reference/audit.
ALTER TABLE public.hr_attendance ADD COLUMN IF NOT EXISTS start_time time;
ALTER TABLE public.hr_attendance ADD COLUMN IF NOT EXISTS end_time   time;

NOTIFY pgrst, 'reload schema';
