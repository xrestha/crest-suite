-- S756 — the Logos bucket has had no SELECT policy since 20260914140100, so replacing or removing a
-- logo cannot work.
--
-- Found while building dish photos (20260918150000). Supabase Storage checks an upload with
-- `upsert: true` by running `INSERT … ON CONFLICT DO UPDATE … RETURNING *` as the caller, and a
-- remove as `DELETE … RETURNING`. Postgres applies SELECT policies to a RETURNING clause, so with no
-- SELECT policy the upsert raises 42501 ("new row violates row-level security policy") however
-- permissive the INSERT policy is, and the delete matches nothing and reports success. Both logo
-- upload handlers (Settings → Branding, Admin → Clients → Manage) use `upsert: true` and `remove()`.
-- 20260914140100 replaced the dashboard-made policies with admin-only INSERT/UPDATE/DELETE and left
-- no SELECT — the same shape the reverted hr_employee_photo bucket had.
--
-- Reads by the app and by guests are unaffected either way: a public bucket serves objects through
-- its public URL without consulting RLS. This policy only lets the writer's own RETURNING see the
-- row it wrote, so it is scoped exactly like the write policies: the Logos bucket, admin only.
DROP POLICY IF EXISTS logos_select_admin ON storage.objects;
CREATE POLICY logos_select_admin ON storage.objects
  FOR SELECT TO authenticated
  USING ((bucket_id = 'Logos') AND COALESCE((SELECT public.is_admin()), false));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'logos_select_admin' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'S756: logos_select_admin missing';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'logos_%') <> 4 THEN
    RAISE EXCEPTION 'S756: expected exactly four logos_* policies (select/insert/update/delete)';
  END IF;
END $$;
