-- STATUS: complete (draft for review; apply only on the owner's "apply")
--
-- Suggested file name: supabase/migrations/20261016120000_owner_report_frozen_s849.sql
--
-- S849, cluster OR. The frozen Monthly Owner Report becomes frozen in the DATABASE, not only on the
-- page (OWNER-REPORT-4, owner decision SU9 (a)), and a report can no longer be filed under one
-- business for another business's month (GAPS-2's backstop; S848.2: "nothing ties a report's period
-- to its own client — the fix should check that too").
--
-- Live state this starts from (S848.2, read 2026-10-15): one permissive policy
-- monthly_owner_reports_all ((client_id = my_client_id()) OR is_admin()), four RESTRICTIVE staff
-- policies, `authenticated` holding SELECT/INSERT/UPDATE/DELETE, NO trigger of any kind, 8 reports at
-- 3 clients, none on another client's period, no client with two reports for one month.
--
-- Who writes this table today, and what each path needs from the guard (grep of src/ and
-- supabase/functions/, 2026-10-16):
--   * the Owner's / operator's browser: INSERT at the close (closePeriod.js, 'period_close') and at
--     first view (MonthlyOwnerReport.jsx, 'backfill'); UPDATE on Regenerate Snapshot.
--   * the operator's Restore (restoreClientData.js, browser session, is_admin()): INSERT of rows as
--     they were first made (generated_at in the past, generated_by already emptied by prepareRow).
--   * admin-user-ops (service role): DELETE in Danger Zone / Archive / trial purge.
--   * the generated_by foreign key's ON DELETE SET NULL when a profile is deleted: Postgres runs the
--     referential action as the referencing table's OWNER, so current_user is not a browser role.
--   No browser path DELETEs a report (grep: the only delete is admin-user-ops/index.ts:400).
--   Re-checked 2026-10-19 (review V3) against the current src/: restoreClientData.js has no replace mode
--   (insert-only; assertEmpty refuses a client holding data, and its one browser DELETE is the empty
--   seed monthly_periods row of a new client, which holds no report); ClientDrawer and the admin pages
--   never name the table; generateMonthlyReport.js only inserts/updates. monthly_owner_reports.period_id
--   is a plain NO ACTION foreign key (20260721010000:8; not a cascade, whatever review F says), so a
--   month that has a report cannot be deleted from anywhere, before or after this file; that is why
--   admin-user-ops deletes reports first (:399-400, service role, which keeps its DELETE).
--
-- Objects:
--   1. FUNCTION public.monthly_owner_reports_same_client()  NEW, trigger, SECURITY DEFINER.
--      Every caller: the row's month must belong to the row's business; bs_year/bs_month are copied
--      from the month itself. Read past RLS on purpose, so the check cannot pass vacuously.
--      Rollback: DROP TRIGGER owner_report_1_same_client ON public.monthly_owner_reports;
--                DROP FUNCTION public.monthly_owner_reports_same_client();
--   2. TRIGGER owner_report_1_same_client  NEW, BEFORE INSERT OR UPDATE OF client_id, period_id,
--      bs_year, bs_month. Named "_1_" so it fires before the guard (same-timing triggers fire in
--      name order), so a foreign month is refused as foreign, not as "not closed".
--      Rollback: as (1).
--   3. FUNCTION public.monthly_owner_reports_guard()  NEW, trigger, SECURITY INVOKER (it keys on
--      current_user, which a DEFINER body would always see as the owner).
--      Browser roles only:
--        - DELETE: refused (never deleted; Regenerate refreshes it).
--        - only the Owner or the operator may write (COALESCE'd; the RESTRICTIVE policies already
--          refuse staff, this keeps the rule true if a policy is ever loosened);
--        - INSERT: the operator's restore (is_admin() and generated_at before now()) keeps the row
--          as backed up; otherwise the month must be closed, generation_source is 'period_close' or
--          becomes 'backfill', and generated_at := now(), generated_by := auth.uid();
--        - UPDATE (= Regenerate Snapshot): id, client_id, period_id, bs_year, bs_month cannot
--          change; the month must still be closed; generation_source := 'manual_regenerate',
--          generated_at := now(), generated_by := auth.uid().
--      Rollback: DROP TRIGGER owner_report_2_guard ON public.monthly_owner_reports;
--                DROP FUNCTION public.monthly_owner_reports_guard();
--   4. TRIGGER owner_report_2_guard  NEW, BEFORE INSERT OR UPDATE OR DELETE. Rollback: as (3).
--   5. GRANT: REVOKE DELETE ON public.monthly_owner_reports FROM authenticated.
--      Rollback: GRANT DELETE ON public.monthly_owner_reports TO authenticated;
--   Functions called, not redefined: public.is_admin(), public.is_client_owner() (latest body
--   20260914230000), public.ims_period_is_closed(uuid) (20260918100000; DEFINER, granted to
--   authenticated, which this INVOKER guard needs), auth.uid().
--
-- Not changed here, on purpose:
--   * the policies (one permissive + four restrictive) stay exactly as they are;
--   * no history table: SU9 chose (a), not (b) "keep every earlier version";
--   * no audit trigger: DATABASE-5 (ACCESS cluster) owns log_audit(); see plan-OR.md CROSS for the
--     request that, if it attaches log_audit() here, it strips `snapshot` from both images;
--   * DATABASE-3 (ACCESS cluster) must NOT also add a same-client kind for
--     monthly_owner_reports.period_id: object (1) is that check for this table (plan-OR.md CROSS).
--
-- Residual, accepted: on INSERT the browser still chooses 'period_close' or 'backfill' (the database
-- has no record of when a month was closed). Both are now stamped with the database's own time and
-- the real maker, so the worst a forged 'period_close' says is "Made when Ashadh was ended: <the
-- real day> by <the Owner>".

BEGIN;

-- ── Pre-flight: nothing already breaks the rule the triggers start enforcing ──────────────────────
-- S848.2 read 0 cross-client rows; if one has appeared since, stop and let the owner decide (the
-- triggers would not touch it, but the report would sit on another business's month for good).
DO $$
DECLARE
  v_foreign integer;
  v_relabelled integer;
BEGIN
  SELECT count(*) INTO v_foreign
    FROM public.monthly_owner_reports r JOIN public.monthly_periods mp ON mp.id = r.period_id
   WHERE mp.client_id <> r.client_id;
  IF v_foreign > 0 THEN
    RAISE EXCEPTION 'S849 OR pre-flight: % monthly report(s) sit on another business''s month; resolve them before applying', v_foreign;
  END IF;
  -- Informational only: a month relabelled after its report was made (Periods' rename) leaves the
  -- report's own bs_year/bs_month behind. Nothing is rewritten here.
  SELECT count(*) INTO v_relabelled
    FROM public.monthly_owner_reports r JOIN public.monthly_periods mp ON mp.id = r.period_id
   WHERE mp.bs_year <> r.bs_year OR mp.bs_month <> r.bs_month;
  IF v_relabelled > 0 THEN
    RAISE NOTICE 'S849 OR pre-flight: % report(s) name a different month than their period now does (left as they are)', v_relabelled;
  END IF;
END;
$$;

-- ── 1–2. The month belongs to the report's business (every caller) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.monthly_owner_reports_same_client()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_client uuid;
  v_year   integer;
  v_month  integer;
BEGIN
  -- Past RLS on purpose: an INVOKER read of another business's month comes back empty, and an
  -- empty read must not be the thing that lets the row through.
  SELECT mp.client_id, mp.bs_year, mp.bs_month INTO v_client, v_year, v_month
    FROM monthly_periods mp WHERE mp.id = NEW.period_id;
  IF NOT FOUND THEN
    -- The foreign key refuses a month that does not exist; nothing to add here.
    RETURN NEW;
  END IF;
  IF v_client IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION 'owner_report_other_client: that month belongs to another business, so its report cannot be filed here'
      USING ERRCODE = '23503', HINT = 'owner_report_other_client';
  END IF;
  -- The month a report names is the month its period is. Copied, not trusted: a report labelled
  -- Bhadra over Ashwin's figures is the GAPS-2 picture from the other side.
  NEW.bs_year  := v_year;
  NEW.bs_month := v_month;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.monthly_owner_reports_same_client() FROM PUBLIC;

DROP TRIGGER IF EXISTS owner_report_1_same_client ON public.monthly_owner_reports;
CREATE TRIGGER owner_report_1_same_client
  BEFORE INSERT OR UPDATE OF client_id, period_id, bs_year, bs_month ON public.monthly_owner_reports
  FOR EACH ROW EXECUTE FUNCTION public.monthly_owner_reports_same_client();

-- ── 3–4. Frozen: made once, refreshed only by Regenerate, never deleted; the database says who ────
CREATE OR REPLACE FUNCTION public.monthly_owner_reports_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- The service role (Danger Zone, Archive, trial purge), SECURITY DEFINER bodies, and the
  -- generated_by foreign key's ON DELETE SET NULL (run as the table owner) are not browser writes.
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'owner_report_locked: a monthly report is never deleted; Regenerate Snapshot refreshes its figures'
      USING ERRCODE = '42501', HINT = 'owner_report_locked';
  END IF;

  -- The four RESTRICTIVE policies already refuse every staff login; this keeps the rule true on its
  -- own. COALESCE: is_admin() is NULL for a session with no profile (S630).
  IF NOT COALESCE(public.is_admin() OR public.is_client_owner(), false) THEN
    RAISE EXCEPTION 'owner_report_owner_only: only the Owner or Crest support makes or regenerates the monthly report'
      USING ERRCODE = '42501', HINT = 'owner_report_owner_only';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- The operator's restore re-inserts a report as it was first made (the S809 1l / S843 shape:
    -- dated before this transaction). An ordinary insert sends no generated_at, so its DEFAULT now()
    -- is not before now() and it takes the stamped path below.
    IF COALESCE(public.is_admin(), false) AND NEW.generated_at < now() THEN
      RETURN NEW;
    END IF;
    IF NOT COALESCE(public.ims_period_is_closed(NEW.period_id), false) THEN
      RAISE EXCEPTION 'owner_report_period_open: a monthly report is made only for a closed month'
        USING ERRCODE = '42501', HINT = 'owner_report_period_open';
    END IF;
    -- A new report is made at the close or later, never "regenerated".
    IF NEW.generation_source IS DISTINCT FROM 'period_close' THEN
      NEW.generation_source := 'backfill';
    END IF;
    -- Who and when come from the database, never from the browser (the S579 attribution rule).
    NEW.generated_at := now();
    NEW.generated_by := auth.uid();
    RETURN NEW;
  END IF;

  -- UPDATE: the only overwrite is Regenerate Snapshot.
  -- bs_year / bs_month are not compared (lead, S849 merge, review M5): owner_report_1_same_client has
  -- already copied them from the month itself, so on a month renamed since the report was made a
  -- Regenerate brings the label up to date instead of being refused.
  IF NEW.id        IS DISTINCT FROM OLD.id
  OR NEW.client_id IS DISTINCT FROM OLD.client_id
  OR NEW.period_id IS DISTINCT FROM OLD.period_id THEN
    RAISE EXCEPTION 'owner_report_locked: a monthly report stays on the business and month it was made for'
      USING ERRCODE = '42501', HINT = 'owner_report_locked';
  END IF;
  IF NOT COALESCE(public.ims_period_is_closed(NEW.period_id), false) THEN
    RAISE EXCEPTION 'owner_report_period_open: a monthly report is regenerated only while its month is closed'
      USING ERRCODE = '42501', HINT = 'owner_report_period_open';
  END IF;
  NEW.generation_source := 'manual_regenerate';
  NEW.generated_at      := now();
  NEW.generated_by      := auth.uid();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.monthly_owner_reports_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS owner_report_2_guard ON public.monthly_owner_reports;
CREATE TRIGGER owner_report_2_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.monthly_owner_reports
  FOR EACH ROW EXECUTE FUNCTION public.monthly_owner_reports_guard();

-- ── 5. No browser delete at all (the trigger refuses it too; this stops it before RLS runs) ──────
REVOKE DELETE ON public.monthly_owner_reports FROM authenticated;

COMMENT ON TABLE public.monthly_owner_reports IS
  'Frozen Monthly Owner Report, one per client and closed month. Since S849 (SU9 a): made once at the close or first view, refreshed only by Regenerate (any UPDATE is stamped manual_regenerate), never deleted from the browser; generated_at/generated_by are set by owner_report_2_guard, and owner_report_1_same_client ties period_id to client_id.';

-- ── Post-assert (catalog only; the behaviour is proved in verify-OR.sql) ──────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.monthly_owner_reports'::regclass AND NOT tgisinternal
         AND tgname IN ('owner_report_1_same_client', 'owner_report_2_guard')) <> 2 THEN
    RAISE EXCEPTION 'S849 OR: the two monthly_owner_reports triggers are not both in place';
  END IF;
  IF has_table_privilege('authenticated', 'public.monthly_owner_reports', 'DELETE') THEN
    RAISE EXCEPTION 'S849 OR: authenticated still holds DELETE on monthly_owner_reports';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.monthly_owner_reports_same_client()'::regprocedure)
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.monthly_owner_reports_guard()'::regprocedure) THEN
    RAISE EXCEPTION 'S849 OR: same_client must be SECURITY DEFINER and guard SECURITY INVOKER';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── Data clean-up ─────────────────────────────────────────────────────────────────────────────────
-- None. S848.2 found no report on another business's month and no client with two reports for one
-- month; the pre-flight above stops the migration if that has changed.
