ALTER TABLE public.hr_payslips ADD COLUMN IF NOT EXISTS tada_claim_ids uuid[] DEFAULT '{}'::uuid[];

NOTIFY pgrst, 'reload schema';
