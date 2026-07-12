-- Bug: hr_incentives_unique was (client_id, employee_id, run_label) — missing bs_year.
-- IncentiveRun.jsx's generate()/regenerate() upsert with onConflict matching that key, so
-- re-running a bonus with a reused run_label (e.g. "Dashain Bonus") in a later bs_year silently
-- overwrote the prior year's finalized amount/tds instead of inserting a new row. Widening the
-- constraint to include bs_year (matching hr_festival_allowances' equivalent constraint, which
-- already does this correctly) fixes it going forward.
ALTER TABLE public.hr_incentives DROP CONSTRAINT hr_incentives_unique;
ALTER TABLE public.hr_incentives ADD CONSTRAINT hr_incentives_unique UNIQUE (client_id, employee_id, bs_year, run_label);
