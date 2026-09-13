-- S742: a shift type's NORMAL hours, separate from its length.
--
-- hr_shift_types carried one number, `hours`, and everything treated all of it as normal time — so
-- a rostered 12-hour "Full Day" could never carry the overtime it was scheduled with. Generate from
-- Roster wrote ot_hours = 0, and a punched 8am–8pm measured OT as 12 − 12 = 0. The only workaround
-- was to shorten the shift to 9h, which then under-reported the roster board and labour cost.
--
-- NULL means "the whole shift is normal time" — exactly the behaviour before this column — so no
-- existing shift, attendance row or payslip changes until a manager fills it in. Clock time, lunch
-- included (the Attendance sheet compares the Start-to-End span against it).
--
-- No RLS or grant change: the column inherits the table's existing policies (client_own +
-- the restrictive staff-isolation families), and `get_my_roster()` selects named columns, so
-- Self-Service is unaffected.

ALTER TABLE public.hr_shift_types
  ADD COLUMN IF NOT EXISTS regular_hours numeric;

ALTER TABLE public.hr_shift_types
  DROP CONSTRAINT IF EXISTS hr_shift_types_regular_hours_range;
ALTER TABLE public.hr_shift_types
  ADD CONSTRAINT hr_shift_types_regular_hours_range
  CHECK (regular_hours IS NULL OR (regular_hours >= 0 AND regular_hours <= 24));

COMMENT ON COLUMN public.hr_shift_types.regular_hours IS
  'Hours of this shift paid as normal time before overtime starts (clock time, lunch included). NULL = the whole shift is normal time.';

NOTIFY pgrst, 'reload schema';
