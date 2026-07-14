-- clients.suite_plan (added 20260708140000) had no expiry tracking of its own — Owner Dashboard
-- gating and the Admin Dashboard's Suite-Bundle-aware MRR calc (AdminDashboardOverview.jsx)
-- could only infer "is the Suite subscription still active" by borrowing IMS's own end date,
-- since every bundle key requires IMS. That's a real gap: a client's Suite subscription can run
-- on its own renewal schedule, independent of any single module's expiry. Mirrors the existing
-- ims_ends_at/hr_ends_at/pos_ends_at columns (same type, same nullable-means-not-tracked convention).
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS suite_ends_at timestamp with time zone;

NOTIFY pgrst, 'reload schema';
