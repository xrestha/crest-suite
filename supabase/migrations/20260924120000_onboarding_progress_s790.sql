-- S790 — onboarding_progress: each person's own getting-started checklist choices, per outlet.
--
-- One row per (person, outlet, step). `step_key` names a checklist step (the frontend owns that
-- vocabulary; the CHECK only keeps it a short slug) and `state` is the last thing that person did
-- with it: opened (started), done (ticked by hand), skipped, hidden, dismissed (the whole card put
-- away), finished, reopened, chosen (the focus they picked). Keyed by outlet as well as person
-- because a grouped Owner sets up each outlet separately, and `my_client_id()` resolves to the
-- outlet they are switched to (multi-outlet.md).
--
-- Decisions, and why:
--
--   * OUT of the restrictive staff-isolation lists (no_self_service_accounts / no_pos_pin_staff /
--     no_ims_staff / no_hr_role_staff). Those families exist to stop a bare same-client policy
--     handing a staff login the Owner's business rows. There is no same-client policy here to fence:
--     every client read and write is keyed on `user_id = auth.uid()`, so an account reaches its own
--     rows and nobody else's. Precedent: push_subscriptions (own-row `own_subscription`,
--     20260707270000), which S316 lists as deliberately open because it "is already own-row"
--     (20260708130000, header) and S430 leaves open for the same reason (20260720170000). A staff
--     login that is given a checklist of its own then works without a migration.
--
--   * IN CLIENT_SCOPED_TABLES (src/shared/scopedDb.js). client_id is NOT NULL, and the admin SELECT
--     below spans every client, so Crest's view-as session reads a client's rows through
--     scopedFrom, whose client_id filter is the only thing narrowing it to the outlet being viewed.
--     Being on that list is also what puts the table in the client export.
--
--   * Admin may READ and never WRITE. Crest's view-as is a look at the client's screen, and a tick,
--     skip or dismiss made while looking must never land on a client's checklist, or turn up in the
--     client's backup as if they had made it. The NOT is_admin() on every write policy makes that a
--     database fact rather than a page rule. A refused INSERT is a 42501 error; a refused UPDATE or
--     DELETE is 0 rows and no error, so the page must skip its writes for an admin session rather
--     than rely on either.
--
--   * Policies split per command, not one <x>_all (the supabase-sql.md house rule). This is the
--     client_groups exception (20260907120000, multi-outlet.md): admin reads while only the owner of
--     a row writes. A single FOR ALL would have to carry the admin read in USING, and DELETE is
--     checked against USING alone, so the collapse would let an admin session delete any row. Still
--     one permissive policy per (table, command), so no multiple_permissive_policies lint.
--
--   * No log_audit() trigger: high-volume, low-value, personal UI state. Every step opened or
--     ticked would write a full row snapshot into audit_logs and bury the entries that matter.
--   * No feature_flags column: the checklist is not plan-gated, so nothing reads a flag for it.
--   * updated_at is kept by touch_updated_at() (supabase-sql.md: a bare `DEFAULT now()` column
--     fires on INSERT only, a promise the schema does not keep), so it reads as "when this state
--     was set".
--
--   * Deleted by Danger Zone: deleteClientDataFor in admin-user-ops (Clear Client Data, Archive,
--     Delete Client, the trial purge). Both FKs cascade, but Clear and Archive keep the clients row
--     and the logins, so without the explicit delete a wiped client's checklist would still say its
--     setup steps were done.
--   * Exported, NOT restored. Exported because it is in CLIENT_SCOPED_TABLES and harmless to carry.
--     Left out of restoreClientData.js's RESTORE_ORDER for ims_count_assignments' reason (S737, the
--     comment at the top of that file): every row keys on a profiles id, and a restore re-provisions
--     staff accounts as NEW auth users with new ids, so the rows would fail their FK or, worse,
--     point at whoever inherited the id. It is personal UI state; a restored client starts its
--     checklist again.
--
-- Reverse: DROP TABLE public.onboarding_progress; and take it back out of CLIENT_SCOPED_TABLES and
-- deleteClientDataFor.

-- ── 1. The table ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  step_key    text NOT NULL CHECK (step_key ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'),
  state       text NOT NULL CHECK (state IN ('opened', 'done', 'skipped', 'hidden', 'dismissed', 'finished', 'reopened', 'chosen')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_progress_user_client_step_key UNIQUE (user_id, client_id, step_key)
);

-- The unique constraint leads with user_id, which covers the person's own read and the profiles
-- cascade. client_id is what the admin view-as read (scopedFrom) and Danger Zone filter by.
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_client ON public.onboarding_progress (client_id);

DROP TRIGGER IF EXISTS onboarding_progress_touch ON public.onboarding_progress;
CREATE TRIGGER onboarding_progress_touch
  BEFORE UPDATE ON public.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 2. RLS ──────────────────────────────────────────────────────────────────────────────────
-- Every condition COALESCE'd: is_admin() returns NULL for a session with no profiles row, and
-- my_client_id() does too, so a bare NOT is_admin() is NULL and the natural spelling falls open
-- (supabase-sql.md, S630). Helpers wrapped as (select ...) so each is evaluated once per query.
ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_progress_select ON public.onboarding_progress;
CREATE POLICY onboarding_progress_select ON public.onboarding_progress
  FOR SELECT TO authenticated
  USING (
    COALESCE(user_id = (select auth.uid()), false)
    OR COALESCE((select public.is_admin()), false)
  );

-- Writes: your own row, at the outlet you are switched to, and never from an admin session.
DROP POLICY IF EXISTS onboarding_progress_insert ON public.onboarding_progress;
CREATE POLICY onboarding_progress_insert ON public.onboarding_progress
  FOR INSERT TO authenticated
  WITH CHECK (
    COALESCE(user_id = (select auth.uid()), false)
    AND COALESCE(client_id = (select public.my_client_id()), false)
    AND NOT COALESCE((select public.is_admin()), false)
  );

DROP POLICY IF EXISTS onboarding_progress_update ON public.onboarding_progress;
CREATE POLICY onboarding_progress_update ON public.onboarding_progress
  FOR UPDATE TO authenticated
  USING (
    COALESCE(user_id = (select auth.uid()), false)
    AND COALESCE(client_id = (select public.my_client_id()), false)
    AND NOT COALESCE((select public.is_admin()), false)
  )
  WITH CHECK (
    COALESCE(user_id = (select auth.uid()), false)
    AND COALESCE(client_id = (select public.my_client_id()), false)
    AND NOT COALESCE((select public.is_admin()), false)
  );

-- No outlet test on DELETE: a person may clear their own rows wherever they have any, and nothing
-- of anyone else's is reachable.
DROP POLICY IF EXISTS onboarding_progress_delete ON public.onboarding_progress;
CREATE POLICY onboarding_progress_delete ON public.onboarding_progress
  FOR DELETE TO authenticated
  USING (
    COALESCE(user_id = (select auth.uid()), false)
    AND NOT COALESCE((select public.is_admin()), false)
  );

-- ── 3. Grants (the S782 pattern) ────────────────────────────────────────────────────────────
-- Raw-SQL tables get no SELECT/INSERT/UPDATE/DELETE grants here, but DO get TRUNCATE / REFERENCES /
-- TRIGGER / MAINTAIN for anon and authenticated from the schema's default privileges
-- (20260923100100). TRUNCATE bypasses RLS, so those four go explicitly.
REVOKE ALL ON public.onboarding_progress FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.onboarding_progress TO authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.onboarding_progress FROM authenticated, anon, PUBLIC;
GRANT ALL ON public.onboarding_progress TO service_role;

-- ── 4. Assertions ───────────────────────────────────────────────────────────────────────────
-- On catalog values Postgres computes, never on formatted strings (supabase-sql.md, S630).
DO $$
DECLARE
  t CONSTANT text := 'public.onboarding_progress';
BEGIN
  IF NOT (has_table_privilege('authenticated', t, 'SELECT')
          AND has_table_privilege('authenticated', t, 'INSERT')
          AND has_table_privilege('authenticated', t, 'UPDATE')
          AND has_table_privilege('authenticated', t, 'DELETE')) THEN
    RAISE EXCEPTION 'S790: authenticated is missing a SELECT/INSERT/UPDATE/DELETE grant on onboarding_progress — the checklist could not save';
  END IF;
  IF has_table_privilege('authenticated', t, 'TRUNCATE')
     OR has_table_privilege('authenticated', t, 'REFERENCES')
     OR has_table_privilege('authenticated', t, 'TRIGGER') THEN
    RAISE EXCEPTION 'S790: onboarding_progress still grants TRUNCATE/REFERENCES/TRIGGER to authenticated';
  END IF;
  IF has_table_privilege('anon', t, 'SELECT')
     OR has_table_privilege('anon', t, 'INSERT')
     OR has_table_privilege('anon', t, 'UPDATE')
     OR has_table_privilege('anon', t, 'DELETE')
     OR has_table_privilege('anon', t, 'TRUNCATE') THEN
    RAISE EXCEPTION 'S790: anon holds a privilege on onboarding_progress';
  END IF;
  IF NOT (has_table_privilege('service_role', t, 'SELECT')
          AND has_table_privilege('service_role', t, 'DELETE')) THEN
    RAISE EXCEPTION 'S790: service_role cannot read and delete onboarding_progress — Danger Zone would fail';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
    RAISE EXCEPTION 'S790: RLS is off on onboarding_progress';
  END IF;
  -- Exactly one permissive policy per command, and no FOR ALL ('*') that would reopen admin writes.
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = t::regclass) <> 4
     OR (SELECT count(DISTINCT polcmd) FROM pg_policy
         WHERE polrelid = t::regclass AND polpermissive AND polcmd IN ('r', 'a', 'w', 'd')) <> 4 THEN
    RAISE EXCEPTION 'S790: onboarding_progress should carry exactly four permissive policies, one per command';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = t::regclass AND tgname = 'onboarding_progress_touch' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'S790: onboarding_progress_touch is missing — updated_at would freeze at insert time';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
