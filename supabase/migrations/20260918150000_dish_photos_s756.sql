-- S756 (IMS re-analysis, stage 3, owner decision D16): dish photos are uploaded INTO Crest.
--
-- Until now `recipes.image_url` was a pasted link, and the guest QR menu only renders images the
-- Content-Security-Policy allows (`img-src 'self' data: blob: https://*.supabase.co`, vercel.json).
-- A Facebook, Google Drive or Imgur link therefore rendered as a monogram tile on every guest's
-- phone while the recipe form showed the link as saved. Decision (Aashish, 2026-09-15): an Upload
-- button that stores the photo in a Supabase Storage bucket, so the URL it saves is one the CSP
-- already admits.
--
-- Path convention, written only by src/modules/ims/recipes/DishPhotoField.jsx:
--     <client_id>/<recipe_id or 'new'>-<epoch ms>.<jpg|png|webp>
-- A NEW path per upload (never upsert onto a stable one), which is what makes the policies below
-- sufficient and also keeps a replaced photo from being served stale out of a CDN cache (the S739
-- logo rule, settled by construction rather than by a ?v= alone).
--
--
-- ══ Why the 2026-07 staff-photo bucket failed with 42501, and why this one does not ══════════════
--
-- 20260714120000_hr_employee_photo.sql created INSERT and UPDATE policies only, and its page called
-- `upload(path, file, { upsert: true })`. 20260714140000's revert records that every upload was
-- refused with "new row violates row-level security policy" — even under a temporary
-- `FOR INSERT TO public WITH CHECK (true)` — and concluded it was a Storage API fault. It was not.
--
-- The Storage API checks an upload by running the object-row write AS THE CALLER inside a
-- rolled-back probe (supabase/storage, src/storage/uploader.ts `canUpload` → pg.ts). For
-- `upsert: true` that statement is
--     INSERT INTO storage.objects (...) VALUES (...) ON CONFLICT (...) DO UPDATE SET ... RETURNING *
-- and Postgres applies the table's SELECT policies to the new row of any INSERT ... RETURNING and
-- of any INSERT ... ON CONFLICT DO UPDATE. A row that no SELECT policy admits does not come back
-- filtered — the statement raises exactly "new row violates row-level security policy" (42501).
-- The bucket had no SELECT policy at all: the Logos "Public read" policy had been dropped two days
-- earlier (20260712210000) to stop anonymous listing. So no INSERT policy, however permissive,
-- could ever have passed, which is precisely the diagnostic the revert found inexplicable.
-- (Supabase's own docs say the same thing from the other side: upsert needs INSERT, SELECT and
-- UPDATE.) remove() has the same dependency: it runs `DELETE ... RETURNING *` as the caller, and a
-- row the caller cannot SELECT is silently not deleted — no error, the file stays public.
--
-- So this migration does three things differently:
--   1. The page never upserts. A plain upload is a plain INSERT with no RETURNING, needing only the
--      INSERT policy.
--   2. There IS a SELECT policy — narrowed to the same writers and their own folder, so it does not
--      reopen the anonymous listing 20260712210000 closed. It is what lets remove() find the row,
--      and it keeps a future switch to upsert from failing the S386 way.
--   3. No UPDATE policy: nothing moves or overwrites an object, so none is granted.
-- Public GETs of the image are unaffected by all of this: a public bucket serves
-- /storage/v1/object/public/... without consulting storage.objects RLS.
--
-- The same diagnosis applies to the Logos bucket today (reported, not changed here — not this
-- migration's bucket): 20260914140100 left it with INSERT/UPDATE/DELETE and no SELECT, and both
-- logo handlers upload with `upsert: true` and remove() old files.
--
--
-- ══ Who may write ═════════════════════════════════════════════════════════════════════════════════
--
-- Exactly who may change a recipe row today, mirroring guard_recipe_rank (20260918100000):
--   * admin (any client folder — an operator "viewing as" a client has their own my_client_id());
--   * in the caller's OWN client folder, an IMS supervisor or above or the Owner
--     (ims_caller_has_rank('supervisor'), which also refuses a count-PIN login and a
--     settlement-blocked account), or a POS or IMS manager (caller_can_set_menu_price(), the
--     POS-only client's Menu Pricing rank).
-- A POS PIN waiter, an HR login, a Self-Service login and a count tablet are refused.
-- Every operand is COALESCE'd: is_admin() and my_client_id() return NULL for a profile-less
-- session, and NULL OR NULL never admits but NOT NULL never refuses either (S630).
-- Functions are wrapped in (SELECT ...) so each is evaluated once per statement, not per row (S542);
-- storage.foldername(name) reads the row and cannot be.


-- ── 1. The bucket ────────────────────────────────────────────────────────────────────────────────
-- 2 MB and three raster types, enforced by the Storage API before anything is written. The page
-- refuses the same things first so the message is its own; this is what holds when the page is
-- skipped. SVG is deliberately absent: an SVG served from our storage origin can carry script.
-- DO NOTHING on conflict: storage.buckets carries project-side protection triggers (the revert
-- above met protect_delete), so an existing bucket is corrected in the Dashboard, and the
-- assertion block below refuses to pass until it matches.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dish-photos', 'dish-photos', true, 2097152, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;


-- ── 2. Policies ──────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS dish_photos_insert ON storage.objects;
DROP POLICY IF EXISTS dish_photos_select ON storage.objects;
DROP POLICY IF EXISTS dish_photos_delete ON storage.objects;

CREATE POLICY dish_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'dish-photos'
    AND (
      COALESCE((SELECT public.is_admin()), false)
      OR (
        COALESCE((storage.foldername(name))[1] = (SELECT public.my_client_id())::text, false)
        AND (
          COALESCE((SELECT public.ims_caller_has_rank('supervisor')), false)
          OR COALESCE((SELECT public.caller_can_set_menu_price()), false)
        )
      )
    )
  );

-- Needed by remove() (DELETE ... RETURNING) and by any INSERT ... RETURNING; see the header.
-- Scoped to the writers, so it lists nothing to an anonymous caller or to another client.
CREATE POLICY dish_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'dish-photos'
    AND (
      COALESCE((SELECT public.is_admin()), false)
      OR (
        COALESCE((storage.foldername(name))[1] = (SELECT public.my_client_id())::text, false)
        AND (
          COALESCE((SELECT public.ims_caller_has_rank('supervisor')), false)
          OR COALESCE((SELECT public.caller_can_set_menu_price()), false)
        )
      )
    )
  );

CREATE POLICY dish_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'dish-photos'
    AND (
      COALESCE((SELECT public.is_admin()), false)
      OR (
        COALESCE((storage.foldername(name))[1] = (SELECT public.my_client_id())::text, false)
        AND (
          COALESCE((SELECT public.ims_caller_has_rank('supervisor')), false)
          OR COALESCE((SELECT public.caller_can_set_menu_price()), false)
        )
      )
    )
  );


-- ── 3. Self-check ────────────────────────────────────────────────────────────────────────────────
-- Asserts on catalog columns, never on formatted strings (S630).
DO $$
DECLARE
  v_bucket storage.buckets%ROWTYPE;
  v_n int;
BEGIN
  SELECT * INTO v_bucket FROM storage.buckets WHERE id = 'dish-photos';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'S756 dish-photos: bucket was not created — create it in Dashboard → Storage (public, 2 MB, image/jpeg, image/png, image/webp) and re-run';
  END IF;
  IF v_bucket.public IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'S756 dish-photos: bucket is not public — the anonymous guest menu could not load a photo';
  END IF;
  IF v_bucket.file_size_limit IS DISTINCT FROM 2097152 THEN
    RAISE EXCEPTION 'S756 dish-photos: file_size_limit is %, expected 2097152 — correct it in the Dashboard', v_bucket.file_size_limit;
  END IF;
  IF v_bucket.allowed_mime_types IS NULL
     OR NOT (v_bucket.allowed_mime_types @> ARRAY['image/jpeg', 'image/png', 'image/webp']
             AND ARRAY['image/jpeg', 'image/png', 'image/webp'] @> v_bucket.allowed_mime_types) THEN
    RAISE EXCEPTION 'S756 dish-photos: allowed_mime_types is %, expected exactly jpeg/png/webp', v_bucket.allowed_mime_types;
  END IF;

  -- Exactly the three policies, each permissive, each for authenticated, each on its command.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND ((policyname = 'dish_photos_insert' AND cmd = 'INSERT')
       OR (policyname = 'dish_photos_select' AND cmd = 'SELECT')
       OR (policyname = 'dish_photos_delete' AND cmd = 'DELETE'))
     AND permissive = 'PERMISSIVE'
     AND roles = ARRAY['authenticated']::name[];
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'S756 dish-photos: expected 3 policies (insert/select/delete, permissive, authenticated), found %', v_n;
  END IF;

  -- The S386 failure: an upload path that needs SELECT with no SELECT policy. Also refuse any
  -- UPDATE policy naming this bucket — nothing here overwrites an object.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'UPDATE'
                AND (COALESCE(qual, '') LIKE '%dish-photos%' OR COALESCE(with_check, '') LIKE '%dish-photos%')) THEN
    RAISE EXCEPTION 'S756 dish-photos: an UPDATE policy names this bucket — none is intended';
  END IF;

  -- A RESTRICTIVE policy on storage.objects would AND with these and could refuse every upload
  -- with the same 42501; name it rather than leave the next session to rediscover S387. A WARNING,
  -- not a refusal: one could be benign, and it has to be read to know.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND permissive = 'RESTRICTIVE';
  IF v_n > 0 THEN
    RAISE WARNING 'S756 dish-photos: % RESTRICTIVE policies exist on storage.objects — check they admit dish-photos before relying on it', v_n;
  END IF;

  -- A policy calling a function the caller cannot EXECUTE fails with 42501 too
  -- ("permission denied for function"). Every function the policies name must be executable.
  IF NOT has_function_privilege('authenticated', 'public.is_admin()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.my_client_id()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.ims_caller_has_rank(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.caller_can_set_menu_price()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'storage.foldername(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S756 dish-photos: authenticated cannot EXECUTE a function the policies call';
  END IF;

  -- The helpers must stay DEFINER (they read profiles past its self-only RLS).
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('ims_caller_has_rank', 'caller_can_set_menu_price')
                AND NOT p.prosecdef) THEN
    RAISE EXCEPTION 'S756 dish-photos: a rank helper is no longer SECURITY DEFINER — it would see only the caller''s own profile row through RLS and refuse every manager';
  END IF;
END $$;


-- ── Dry run (do NOT paste as part of the migration; run separately, it rolls itself back) ────────
-- Exercises the INSERT policy as a real caller, the way the Storage API's permission probe does.
-- Replace the two uuids with a real profile id and that profile's client id.
--
-- DO $$
-- DECLARE v_ok_own boolean := false; v_ok_other boolean := false;
-- BEGIN
--   PERFORM set_config('request.jwt.claims',
--     json_build_object('sub', '<PROFILE_UUID>', 'role', 'authenticated')::text, true);
--   SET LOCAL ROLE authenticated;
--   BEGIN
--     INSERT INTO storage.objects (bucket_id, name) VALUES ('dish-photos', '<CLIENT_UUID>/dryrun-1.jpg');
--     v_ok_own := true;
--   EXCEPTION WHEN insufficient_privilege THEN v_ok_own := false; END;
--   BEGIN
--     INSERT INTO storage.objects (bucket_id, name) VALUES ('dish-photos', '00000000-0000-0000-0000-000000000000/dryrun-2.jpg');
--     v_ok_other := true;
--   EXCEPTION WHEN insufficient_privilege THEN v_ok_other := false; END;
--   RAISE EXCEPTION 'DRY RUN (rolled back): own folder admitted=%, other folder admitted=%', v_ok_own, v_ok_other;
-- END $$;
