-- Reverts 20260714120000_hr_employee_photo.sql — the staff-photo feature is being backed out.
-- Root cause never resolved: an exhaustive diagnostic pass (table grants, schema USAGE,
-- triggers, constraints, restrictive-policy check, the bucket row itself, a second bucket
-- with no hyphen in the name, even a temporary unconditional `WITH CHECK (true) TO public`
-- policy) all confirmed correct/permissive, yet every INSERT into storage.objects for this
-- bucket still failed with "new row violates row-level security policy" (SQLSTATE 42501).
-- This has the signature of a Supabase Storage API-side issue, not anything fixable from the
-- SQL side — kept as a migration (not just ad hoc dashboard SQL) per this repo's convention
-- that migrations are the source of truth for schema history, including reverts.

DROP POLICY IF EXISTS "staff_photos_insert_own_client" ON storage.objects;
DROP POLICY IF EXISTS "staff_photos_update_own_client" ON storage.objects;
DROP POLICY IF EXISTS "staff_photos_insert_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "staff_photos_update_authenticated" ON storage.objects;
DROP POLICY IF EXISTS "staff_photos_insert_debug_open" ON storage.objects;
DROP POLICY IF EXISTS "staff_photos_update_debug_open" ON storage.objects;
DROP POLICY IF EXISTS "staffphotos_insert_own_client" ON storage.objects;
DROP POLICY IF EXISTS "staffphotos_update_own_client" ON storage.objects;

DROP FUNCTION IF EXISTS public.debug_photo_auth(text);

-- storage.objects/buckets have a custom storage.protect_delete() trigger (this project only —
-- not vanilla Supabase) that blocks direct SQL DELETE with SQLSTATE 42501, requiring the
-- Storage API instead. The two test buckets (staff-photos, staffphotos — both empty; every
-- upload attempt failed) were deleted manually via Dashboard → Storage, not by this migration.

ALTER TABLE public.hr_employees DROP COLUMN IF EXISTS photo_url;

NOTIFY pgrst, 'reload schema';
