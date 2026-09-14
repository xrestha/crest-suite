-- S747: the Logos storage bucket accepts writes from Crest admins only.
--
-- The bucket's write policies were created in the Supabase dashboard and never recorded here
-- (20260714120000's comment called them "loose, dashboard-only, undocumented"). Read live on
-- 2026-09-14 they were:
--   "Authenticated upload"  INSERT  TO authenticated  WITH CHECK (bucket_id = 'Logos')
--   "Authenticated update"  UPDATE  TO authenticated  USING      (bucket_id = 'Logos')
--   "Authenticated delete"  DELETE  TO authenticated  USING      (bucket_id = 'Logos')
-- i.e. ANY signed-in account of ANY client -- a POS PIN waiter included -- could overwrite or
-- delete any object in the bucket: another client's logo at `<client_id>/logo.png`, or Crest's own
-- at `admin/logo.png`, which is the mark on the login, signup and pricing pages.
--
-- Nothing but an admin uploads a logo: Settings → Branding is admin-only (a client's own Settings
-- page shows branding read-only, "Contact your consultant"), and ClientDrawer is an admin screen.
-- So the writes narrow to admin rather than to "own client folder" (the staff-photos shape), which
-- would still have let any staff account replace its own outlet's brand.
--
-- Reads are untouched: the bucket is public, logos load through getPublicUrl() + <img>, and the
-- listing SELECT policy was already dropped in 20260712210000.

DROP POLICY IF EXISTS "Authenticated upload" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated update" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated delete" ON storage.objects;

-- COALESCE: is_admin() returns NULL, not false, for a caller with no profile row (S630).
CREATE POLICY logos_insert_admin ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'Logos' AND COALESCE(public.is_admin(), false));

-- upsert: true is an UPDATE on an existing path, so it needs both USING and WITH CHECK.
CREATE POLICY logos_update_admin ON storage.objects
  FOR UPDATE TO authenticated
  USING      (bucket_id = 'Logos' AND COALESCE(public.is_admin(), false))
  WITH CHECK (bucket_id = 'Logos' AND COALESCE(public.is_admin(), false));

CREATE POLICY logos_delete_admin ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'Logos' AND COALESCE(public.is_admin(), false));

-- Verification ---------------------------------------------------------------------------------
--   SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname = 'storage' AND tablename = 'objects'
--      AND (qual LIKE '%Logos%' OR with_check LIKE '%Logos%') ORDER BY policyname;
--   -- expect exactly logos_delete_admin / logos_insert_admin / logos_update_admin
-- Live check after deploy: an admin replaces a client's logo in Settings → Branding (must work),
-- and a non-admin session's storage.from('Logos').upload(...) is refused with a 403.
