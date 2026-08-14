-- Daily Purchases vs Sales chart (ClientDashboard.jsx) draws a dashed month-end projection that
-- recalculates from ALL actuals on every load — useful as "if today's pace continues" but it means
-- there is no record of what was projected earlier in the period; by the time you check whether an
-- early forecast held up, the forecast itself has already moved on to reflect today's data.
--
-- These columns hold a ONE-TIME snapshot of the trend fit (slope/intercept/cap — not just its
-- resulting total), captured client-side the first time each metric crosses the existing 5-point
-- threshold in projectTrend(), and never overwritten after that — so a full-month reference line
-- can be drawn and compared against as the period actually plays out. Same "frozen once, useful
-- precisely because it doesn't move" shape as monthly_owner_reports' snapshot.
ALTER TABLE monthly_periods ADD COLUMN IF NOT EXISTS sales_projection_snapshot jsonb;
ALTER TABLE monthly_periods ADD COLUMN IF NOT EXISTS purch_projection_snapshot jsonb;
