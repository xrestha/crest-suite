ALTER TABLE public.hr_attendance ADD COLUMN IF NOT EXISTS break_minutes integer;

NOTIFY pgrst, 'reload schema';
