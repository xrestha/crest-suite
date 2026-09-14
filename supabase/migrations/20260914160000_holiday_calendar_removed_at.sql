-- S748 (2 of 2) — a holiday the owner removed stays removed.
--
-- Seed dedupes by NAME against the calendar, so deleting a seeded holiday (the Terai Holi row at a
-- hill outlet, which the seed report itself tells the owner to delete) put it back the next time
-- anyone pressed Seed — and seeding is something an owner does again, because the gazette for the
-- second half of a fiscal year arrives months after the first. Decided with Aashish 2026-09-14:
-- remember what was removed.
--
-- Remove is now a stamp, not a DELETE: the row stays, so Seed still finds it by name and skips it,
-- and the page lists it under "Removed" with Put back. Every reader of this table must ignore a
-- stamped row — there are exactly two outside the page (Overtime.jsx's 2× suggestion,
-- demandForecastData.js's multiplier), both filter `removed_at IS NULL`, and the page reads both
-- halves. No new policy is needed: stamping is an UPDATE, which 20260914150000 already restricts to
-- HR supervisor rank. The (client, date, name) unique index still holds, so a removed holiday is put
-- back, never typed in twice.

ALTER TABLE public.hr_holiday_calendar
  ADD COLUMN IF NOT EXISTS removed_at timestamptz;

NOTIFY pgrst, 'reload schema';
