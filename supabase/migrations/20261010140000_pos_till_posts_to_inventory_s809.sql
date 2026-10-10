-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3j: a POS manager posts waiting till bills and credit notes into Inventory
-- from the till's floor, and an Inventory login is told how many wait and who posts them.
--
--   IMS-HANDOFF-1 and CREDIT-NOTES-3 (P2, owner decision Q12 c). A till bill closed while its month
--   was not open in Inventory (and a credit note issued then) waits, unposted, for "Post POS bills
--   to Inventory" in Periods. Only the Owner and the operator could really do that: Periods sends a
--   POS manager back to the dashboard, and an IMS supervisor or manager, who can open Periods, reads
--   pos_orders and pos_credit_notes through the RESTRICTIVE no_ims_staff policies, which hand any
--   login holding an IMS role an EMPTY table with no error, so the page told them "everything the
--   till sold and corrected that month is already in Inventory".
--   The owner's answer (2026-10-09): POS managers may post them too, from the POS side, beside the
--   Owner and the operator; an IMS login that cannot post is told who can, never "nothing waits".
--   The no_ims_staff policies stay exactly as they are.
--     * The post itself needs nothing new in the database. A POS manager (email or Staff PIN) can
--       already read every row the browser's post reads (pos_orders and their lines and choices,
--       pos_credit_notes, monthly_periods, recipes, recipe_ingredients, sales_entries,
--       stock_movements; items is fenced from a PIN login, and the post reads the recipe book
--       through pos_recipe_book, slice 2f), and the live guards admit every write it makes:
--       ims_sales_entries_guard (pos / pos_comp at POS Supervisor, pos_credit / pos_credit_restock at
--       POS Manager), ims_stock_movements_guard (pos_sale / pos_comp at Supervisor,
--       pos_credit_restock at Manager), guard_pos_order_close and guard_pos_credit_note (the posted
--       mark at Supervisor / Manager). ims_closed_period_guard refuses any sales row in a CLOSED
--       month from anyone but the Owner and the operator, so a POS manager cannot post into a
--       closed month; the till's screen offers only the open month anyway. The probe below proves
--       each of these as a real PIN manager.
--     * New: pos_ims_waiting_counts(p_client_id), SECURITY DEFINER, STABLE. How many till bills and
--       credit notes wait for Inventory, per Nepali month (the bill's close date, the note's issue
--       date, in Nepal), with that month's period id and status (NULL when the month has no period
--       yet). Numbers only: no bill, line, amount or name. "Waiting" is what Periods' own counts
--       mean (countUnpostedForPeriod, countUnpostedCreditNotesForPeriod): no posted mark and no
--       sales row naming it. It answers the operator for any outlet, and otherwise the Owner, a POS
--       manager or an IMS supervisor or manager of the outlet asked about (every condition
--       COALESCE'd, so a login with no profile, no rank or another outlet is refused rank_required).
--       Periods reads it for an IMS login's month rows, Home and the Inventory Dashboard for their
--       "Needs attention" row, and the till's floor banner for which months can be posted from there.
--
--   S809.4 (2f, made reachable by Q12 c): a credit note's reversal had no double-post refusal. Two
--   posts at once (the Owner's Periods post and a POS manager's floor post, or either of them and
--   the note's own post as it is issued) each read the note as waiting and each wrote its reversal,
--   taking the bill's revenue out of Inventory twice. sales_entries_stamp_pos_source now does for a
--   note what it does for a bill since 2f: outside the operator's restore it locks the note
--   FOR NO KEY UPDATE before it looks, and refuses reversal rows for a note that already has
--   reversal rows from an earlier statement (HINT pos_credit_note_already_posted, 23505). A note's
--   reversal goes in ONE statement (postCreditNoteToIms and backfillCreditNotesToIms both send it so).
--   A row naming no note, or a note of another outlet than the month it is filed in, is left as it
--   was: no lock and no look (the mark below never reached it either).
--
-- Built on the LIVE body (pg_get_functiondef, md5(prosrc), read 2026-10-10 with 3i and 3k live).
-- Section 0 refuses to run over any other body. The change inside it is the block marked "S809 3j".
--   sales_entries_stamp_pos_source()   bdcb42ee81b48cc6c76dc4310c6a31ea  (slice 2f's, 20261009220000)
-- It stays SECURITY DEFINER, search_path public, proacl {postgres=X/postgres}; CREATE OR REPLACE
-- keeps the grant and the trigger (AFTER INSERT, FOR EACH STATEMENT, new_rows).
-- Called, not replaced (their contracts are all this file relies on; the probe tests the behaviour):
--   is_admin()                       4f849a5c62042e5b2caa32d67c50f341
--   my_client_id()                   e1dbe771403bcf13601c323b74d0c07b
--   pos_caller_has_rank(text)        100bd1bd1e2a1a1c3a6f4cb105a8e887  (3i's: admin, the Owner, or an unblocked POS login at the rank)
--   ims_caller_has_rank(text)        b1b5a0e6f6c73e7a819923d8ca43c2f9  (admin, the Owner, or an IMS email login at the rank)
--   is_client_owner()                bc4def4bff553cd31cf0071cdef6b1d4
--   is_ims_staff()                   6465370717db6f76c482ab8a09a782a0  (the no_ims_staff fence)
-- Read, not replaced (the post relies on them as they are):
--   ims_sales_entries_guard()        492abc0353f288a2bcb9daba12f60434
--   ims_stock_movements_guard()      0243bef6e3ee9694384e63166fbe9474
--   ims_closed_period_guard()        ac776093d871ec080cf76b63387cd2ec
--   caller_can_edit_closed_period()  2b709a507baf8bc81cd1f659319bc58f
--   guard_pos_order_close()          2b5f4cd801170bafc620052cf40d2620
--   guard_pos_credit_note()          5d47faa30c2b2ebccca7d1abab6d335a
--   pos_recipe_book(uuid,uuid[],uuid[])  179bb1a754740f83078f8f480a283cc4
-- New: pos_ims_waiting_counts(uuid) (DEFINER, STABLE; EXECUTE to authenticated only).
-- Not touched (owned by other stage-3 slices drafted at the same time): submit_guest_order,
-- get_guest_order_progress, get_guest_table_status, pos_min_till_build (3b); guard_pos_kot_log (3d).
-- The no_ims_staff policies on pos_orders, pos_order_items, pos_order_item_options and
-- pos_credit_notes are NOT touched.
--
-- Live before this migration (2026-10-10, after the Bloom demo seed):
--   * Waiting now: 0 billed bills without a posted mark (BLOOM CAFE 2,642 billed, BLOOM CAFE - PKR
--     1,606), 0 credit notes without one (BLOOM CAFE 2 notes, both posted). 0 bills or notes with
--     sales rows and no mark (2f's repair state holds).
--   * Credit-note reversal rows: 3 rows for 2 notes, 0 without a note, 0 notes whose rows were
--     written in more than one statement (distinct created_at). So the new refusal meets no stored
--     row, and nothing written today depends on a second statement for one note.
--   * Open months: BLOOM CAFE and BLOOM CAFE - PKR Ashwin 2083 (each also Shrawan and Bhadra, closed).
--   * POS logins: every POS staff login at both outlets is a Staff PIN login (one manager, one
--     supervisor, one staff each). No live login holds both an IMS and a POS rank.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN manager, its PIN supervisor, an IMS supervisor
-- and an IMS staff stand-in, its Owner, a login with no profile, and the operator. It brings every
-- row it needs (its own months in 2087, a dish, an ingredient, five bills, a credit note), closes
-- BLOOM CAFE's own open month for its length, and rolls itself back. If any check fails, the whole
-- migration fails and nothing lands. Drafted against a local Postgres 17 replica of the live
-- catalog read 2026-10-10 (tables, constraints, functions, triggers, policies, grants, bs_months):
-- the file runs clean, and again over itself; five deliberately broken copies (no note rule, a POS
-- supervisor told, no COALESCE, any outlet, IMS staff told) each fail the probe at the step meant.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ─────────────────────────────────────────────────────────────────────────────
-- The new name is free (or holds only this file's own signature), and the stamp trigger's body is
-- the one this file was built on (2f's), or already this file's own (a re-run).
DO $$
DECLARE
  v_md5 text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'pos_ims_waiting_counts'
                AND oid <> COALESCE(to_regprocedure('public.pos_ims_waiting_counts(uuid)'), 0::oid)) THEN
    RAISE EXCEPTION 'S809 3j: pos_ims_waiting_counts already exists with another signature';
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.sales_entries_stamp_pos_source()');
  IF v_md5 IS DISTINCT FROM 'bdcb42ee81b48cc6c76dc4310c6a31ea'
     AND v_md5 IS DISTINCT FROM '639217f30a83b1ecc600cae2d4de7f39' THEN
    RAISE EXCEPTION 'S809 3j: sales_entries_stamp_pos_source is not the body this file was built on (live md5 %) — rebuild the 3j block on the live body', v_md5;
  END IF;
END;
$$;


-- ── 1. How many till bills and credit notes wait for Inventory, and in which month ──────────
--
-- SECURITY DEFINER because the logins it is for cannot read the rows it counts: an IMS login meets
-- no_ims_staff on pos_orders and pos_credit_notes. Every read names the outlet asked about, and
-- the caller check pins that outlet to the caller's own (the operator excepted), so bypassing RLS
-- reaches no other outlet. It returns counts, never a bill.
--
-- A month is Nepal's calendar month of the bill's close (the note's issue) through bs_months, the
-- same month Periods' backfill gives it (bsDayBoundaryIso over the period's BS month, S792). A
-- date outside bs_months (none today) comes back with NULL year and month. The month's period is
-- matched by year and month; none means the month has not been started in Inventory.
CREATE OR REPLACE FUNCTION public.pos_ims_waiting_counts(p_client_id uuid)
RETURNS TABLE (bs_year integer, bs_month integer, period_id uuid, period_status text, bills integer, notes integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  -- The operator for any outlet; otherwise the outlet's own Owner, a POS manager, or an IMS
  -- supervisor or manager (pos_caller_has_rank and ims_caller_has_rank each also answer true for
  -- the Owner and the operator, and false for a blocked login). Wrapped whole: is_admin() and
  -- my_client_id() are NULL for a login with no profile, and NULL must refuse.
  IF NOT COALESCE(public.is_admin()
                  OR (p_client_id = public.my_client_id()
                      AND (public.pos_caller_has_rank('manager') OR public.ims_caller_has_rank('supervisor'))), false) THEN
    RAISE EXCEPTION 'pos_ims_waiting_counts: how many till bills wait for Inventory is shown to the Owner, a POS manager or an Inventory supervisor of this outlet'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  RETURN QUERY
  WITH waiting AS (
    SELECT (o.closed_at AT TIME ZONE 'Asia/Kathmandu')::date AS d, 1 AS b, 0 AS n
      FROM pos_orders o
     WHERE o.client_id = p_client_id
       AND o.status = 'billed'
       AND o.ims_posted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_order_id = o.id)
    UNION ALL
    SELECT (c.created_at AT TIME ZONE 'Asia/Kathmandu')::date, 0, 1
      FROM pos_credit_notes c
     WHERE c.client_id = p_client_id
       AND c.ims_posted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM sales_entries s WHERE s.pos_credit_note_id = c.id)
  ), dated AS (
    SELECT m.bs_year AS y, m.bs_month AS mo, w.b, w.n
      FROM waiting w
      LEFT JOIN bs_months m ON w.d >= m.ad_start AND w.d < m.ad_start + m.days
  )
  SELECT d.y::integer, d.mo::integer, p.id, p.status, sum(d.b)::integer, sum(d.n)::integer
    FROM dated d
    LEFT JOIN monthly_periods p ON p.client_id = p_client_id AND p.bs_year = d.y AND p.bs_month = d.mo
   GROUP BY d.y, d.mo, p.id, p.status
   ORDER BY d.y NULLS LAST, d.mo NULLS LAST;
END;
$function$;

-- authenticated only, as pos_recipe_book (2f). service_role is named so the grant is the same
-- whatever default privileges the applying role carries; no Edge Function calls this.
REVOKE ALL ON FUNCTION public.pos_ims_waiting_counts(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.pos_ims_waiting_counts(uuid) TO authenticated;


-- ── 2. A credit note's reversal goes into Inventory once ────────────────────────────────────
-- The live body (2f's, with the restock source added at its integration) and one new block,
-- marked S809 3j. Nothing else in it changes.
CREATE OR REPLACE FUNCTION public.sales_entries_stamp_pos_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_restore boolean;
  v_bill    record;
  v_status  text;
  v_client  uuid;
  v_note    record;
  v_note_id uuid;
BEGIN
  -- Most inserts are hand-entered sales (Sales Entry): nothing to do.
  IF NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.source IN ('pos', 'pos_comp', 'pos_credit', 'pos_credit_restock')) THEN
    RETURN NULL;
  END IF;

  -- The operator's restore: every row dated before this transaction. No screen sends created_at, so
  -- a post from the till or from Periods (by the operator too) is dated now() by the column default.
  v_restore := COALESCE(public.is_admin(), false)
               AND NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.created_at >= now());

  -- ── Till sale rows, one bill at a time, in id order (two batch posts lock in the same order) ──
  FOR v_bill IN
    SELECT n.pos_order_id AS order_id, p.client_id AS period_client,
           LEAST(now(), COALESCE(min(n.created_at), now())) AS first_at
      FROM new_rows n
      LEFT JOIN monthly_periods p ON p.id = n.period_id
     WHERE n.source IN ('pos', 'pos_comp')
     GROUP BY n.pos_order_id, p.client_id
     ORDER BY n.pos_order_id NULLS FIRST
  LOOP
    IF v_bill.order_id IS NULL THEN
      IF v_restore THEN CONTINUE; END IF;
      RAISE EXCEPTION 'sales_entries: a till sale is recorded under the bill it came from, and this one named no bill, so it was not recorded'
        USING ERRCODE = '23514', HINT = 'pos_sale_unlinked';
    END IF;

    -- The foreign key has already found the bill (its check runs before a statement trigger) and holds
    -- it from deletion. Locked before the look below, so a second post of this bill waits here for
    -- the first to commit or roll back.
    SELECT o.status, o.client_id INTO v_status, v_client
      FROM pos_orders o
     WHERE o.id = v_bill.order_id
       FOR NO KEY UPDATE;

    IF NOT v_restore THEN
      IF v_client IS DISTINCT FROM v_bill.period_client OR v_status IS DISTINCT FROM 'billed' THEN
        RAISE EXCEPTION 'sales_entries: a till sale is recorded under a closed bill of the outlet whose month it is filed in, and this one named an open bill or another outlet''s, so it was not recorded'
          USING ERRCODE = '23514', HINT = 'pos_sale_unlinked';
      END IF;
      IF EXISTS (SELECT 1 FROM sales_entries s
                  WHERE s.pos_order_id = v_bill.order_id
                    AND s.source IN ('pos', 'pos_comp')
                    AND NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.id = s.id)) THEN
        RAISE EXCEPTION 'sales_entries: this bill''s sales are already in Inventory, so they were not recorded a second time'
          USING ERRCODE = '23505', HINT = 'pos_bill_already_posted';
      END IF;
    END IF;

    -- The mark is the moment the bill's rows were written (now(), or a restored row's own date).
    UPDATE pos_orders o
       SET ims_posted_at = v_bill.first_at
     WHERE o.id = v_bill.order_id
       AND o.client_id = v_bill.period_client
       AND o.status = 'billed'
       AND o.ims_posted_at IS NULL;
  END LOOP;

  -- ── S809 3j: a credit note's reversal goes in once ──────────────────────────────────────────
  -- Since Q12 (c) a POS manager posts waiting notes from the till's floor while the Owner posts them
  -- from Periods, and the note's own screen posts it as it is issued. Two of those at once each
  -- read the note as waiting and each wrote its reversal, taking the bill's revenue out twice. So,
  -- as for a bill: one note at a time in id order, the note row locked before the look (a second
  -- post waits here for the first to commit, then its look, a new statement, sees the first's rows),
  -- and reversal rows for a note that already has reversal rows from an earlier statement are
  -- refused. A note's reversal goes in one statement. The operator's restore is exempt (a chunk can
  -- split one note's rows). A row naming no note, or a note of another outlet than the month it is
  -- filed in, is left as before: no lock, no look, and the mark below does not reach it.
  IF NOT v_restore THEN
    FOR v_note IN
      SELECT DISTINCT n.pos_credit_note_id AS note_id, p.client_id AS period_client
        FROM new_rows n
        JOIN monthly_periods p ON p.id = n.period_id
       WHERE n.pos_credit_note_id IS NOT NULL AND n.source IN ('pos_credit', 'pos_credit_restock')
       ORDER BY 1, 2
    LOOP
      v_note_id := NULL;
      SELECT c.id INTO v_note_id
        FROM pos_credit_notes c
       WHERE c.id = v_note.note_id AND c.client_id = v_note.period_client
         FOR NO KEY UPDATE;
      IF v_note_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM sales_entries s
                      WHERE s.pos_credit_note_id = v_note_id
                        AND s.source IN ('pos_credit', 'pos_credit_restock')
                        AND NOT EXISTS (SELECT 1 FROM new_rows n WHERE n.id = s.id)) THEN
        RAISE EXCEPTION 'sales_entries: this Credit Note is already taken off Inventory sales, so it was not taken off a second time'
          USING ERRCODE = '23505', HINT = 'pos_credit_note_already_posted';
      END IF;
    END LOOP;
  END IF;
  -- ── end S809 3j ──────────────────────────────────────────────────────────────────────────────

  -- ── A credit note's reversal rows (pos_credit) mark the note ───────────────────────────────
  -- Only the reversal, which is what the mark has always meant (guard_pos_credit_note: "the note's
  -- reversal reached Inventory"); anything else a note posts keeps its own mark write. A note that
  -- said its food was not served posts its reversal as 'pos_credit_restock' (S809 2e), so that
  -- source marks it too.
  UPDATE pos_credit_notes c
     SET ims_posted_at = x.first_at
    FROM (SELECT n.pos_credit_note_id AS note_id, p.client_id,
                 LEAST(now(), COALESCE(min(n.created_at), now())) AS first_at
            FROM new_rows n
            JOIN monthly_periods p ON p.id = n.period_id
           WHERE n.pos_credit_note_id IS NOT NULL AND n.source IN ('pos_credit', 'pos_credit_restock')
           GROUP BY n.pos_credit_note_id, p.client_id) x
   WHERE c.id = x.note_id
     AND c.client_id = x.client_id
     AND c.ims_posted_at IS NULL;

  RETURN NULL;
END;
$function$;

-- A trigger function needs no grant (EXECUTE is checked at CREATE TRIGGER, never at fire time).
-- CREATE OR REPLACE kept the trigger and the empty grant; said again so a re-read is plain.
REVOKE ALL ON FUNCTION public.sales_entries_stamp_pos_source() FROM PUBLIC;


-- ── 3. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c        uuid;    -- BLOOM CAFE
  v_c2       uuid;    -- BLOOM CAFE - PKR, standing in as "another outlet"
  v_mgr      uuid;    -- BLOOM CAFE's POS PIN manager
  v_sup      uuid;    -- its POS PIN supervisor
  v_ims      uuid;    -- a third login of BLOOM CAFE, made an IMS supervisor (then IMS staff) stand-in
  v_owner    uuid;
  v_admin    uuid;
  v_nobody   uuid := '00000000-0000-4000-8000-0000000003a0';   -- a login with no profile row
  v_real     uuid;    -- BLOOM CAFE's own open month, closed for the length of the probe
  v_p        uuid;    -- the probe's open month: Baisakh 2087
  v_pc       uuid;    -- the probe's closed month: Bhadra 2087 (Ashwin 2087 gets no month at all)
  v_momo     uuid;
  v_chicken  uuid;
  v_o1       uuid;    -- billed in Baisakh, waiting; the PIN manager posts it
  v_o2       uuid;    -- billed in Baisakh, waiting
  v_o3       uuid;    -- billed in Bhadra (closed), waiting
  v_o4       uuid;    -- billed in Ashwin (no month), waiting
  v_o5       uuid;    -- billed in Baisakh, already posted; the probe's credit note is on it
  v_n1       uuid;    -- issued in Baisakh, waiting
  v_d1       date;    -- a day in each month (Nepal)
  v_d5       date;
  v_d6       date;
  v_n        integer;
  v_m        integer;
  v_ts       timestamptz;
  v_hint     text;
  v_msg      text;
  v_txt      text;
  r          record;
  v_past     timestamptz := now() - interval '40 days';
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.pos_ims_waiting_counts(uuid)'::regprocedure, 'public.sales_entries_stamp_pos_source()'::regprocedure)
     AND prosecdef AND proconfig = ARRAY['search_path=public'];
  IF v_n <> 2 OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.pos_ims_waiting_counts(uuid)'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'S809 3j: a function is not SECURITY DEFINER with search_path public, or pos_ims_waiting_counts is not STABLE';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'pos_ims_waiting_counts';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3j: pos_ims_waiting_counts has % signatures (want 1)', v_n;
  END IF;
  -- pos_ims_waiting_counts: EXECUTE for authenticated and nobody else but its owner (no PUBLIC, no
  -- anon); the trigger function: nobody but its owner.
  SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) INTO v_txt
    FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = 'public.pos_ims_waiting_counts(uuid)'::regprocedure AND a.grantee <> p.proowner;
  IF v_txt IS DISTINCT FROM '{authenticated}'
     OR has_function_privilege('anon', 'public.pos_ims_waiting_counts(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pos_ims_waiting_counts(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = 'public.sales_entries_stamp_pos_source()'::regprocedure AND a.grantee <> p.proowner)
     OR (SELECT proacl IS NULL FROM pg_proc WHERE oid = 'public.sales_entries_stamp_pos_source()'::regprocedure) THEN
    RAISE EXCEPTION 'S809 3j: the grants are not as intended (pos_ims_waiting_counts: %)', v_txt;
  END IF;
  -- The stamp trigger is still attached as 2f made it: AFTER INSERT, FOR EACH STATEMENT, new_rows.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.sales_entries'::regclass AND tgname = 'sales_entries_stamp_pos_source'
     AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 4 AND tgnewtable = 'new_rows'
     AND tgfoid = 'public.sales_entries_stamp_pos_source()'::regprocedure;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3j: sales_entries_stamp_pos_source is not an enabled AFTER INSERT statement trigger with new_rows';
  END IF;
  -- The fence this slice works around, not through: no_ims_staff is still RESTRICTIVE on the four tables.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND policyname = 'no_ims_staff' AND permissive = 'RESTRICTIVE' AND cmd = 'ALL'
     AND tablename IN ('pos_orders', 'pos_order_items', 'pos_order_item_options', 'pos_credit_notes');
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'S809 3j: expected no_ims_staff RESTRICTIVE on the four POS tables, found %', v_n;
  END IF;

  -- ── The logins ─────────────────────────────────────────────────────────────────────────────
  SELECT id INTO v_c  FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_c2 FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_mgr
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_sup
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
     AND p.id <> v_mgr
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
   LIMIT 1;
  SELECT p.id INTO v_ims
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c
     AND (p.pos_email IS NOT NULL OR p.ims_role IS NOT NULL) AND p.id NOT IN (v_mgr, v_sup)
   ORDER BY (p.ims_role IS NOT NULL) DESC, p.id
   LIMIT 1;
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND pos_role IS NULL AND ims_role IS NULL AND hr_role IS NULL
     AND pos_email IS NULL AND NOT COALESCE(hr_self_service, false)
   ORDER BY id LIMIT 1;
  IF v_c IS NULL OR v_c2 IS NULL OR v_mgr IS NULL OR v_sup IS NULL OR v_ims IS NULL OR v_owner IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 3j probe: needs BLOOM CAFE, BLOOM CAFE - PKR, three staff logins and the Owner of BLOOM CAFE, and the operator (got %, %, %, %, %, %, %)',
      v_c, v_c2, v_mgr, v_sup, v_ims, v_owner, v_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_nobody) THEN
    RAISE EXCEPTION 'S809 3j probe: the no-profile stand-in id % has a profile', v_nobody;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role. Rolled back below. ─────────────────────────────────
    -- Each stand-in loses every other staff marker, or a restrictive policy would turn an "allowed"
    -- into a vacuous 0 rows (the S792 lesson).
    UPDATE public.profiles
       SET pos_role = 'manager', settlement_blocked_by = NULL, pos_blocked_at = NULL,
           ims_role = NULL, ims_email = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_mgr;
    UPDATE public.profiles
       SET pos_role = 'supervisor', settlement_blocked_by = NULL, pos_blocked_at = NULL,
           ims_role = NULL, ims_email = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_sup;
    UPDATE public.profiles
       SET pos_role = NULL, pos_email = NULL, ims_role = 'supervisor', ims_email = NULL,
           settlement_blocked_by = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_ims;

    -- One open month per outlet: BLOOM CAFE's own is closed for the length of the probe, and the
    -- probe's months sit in 2087 (inside bs_months, far from any real bill).
    SELECT id INTO v_real FROM public.monthly_periods WHERE client_id = v_c AND status = 'open';
    UPDATE public.monthly_periods SET status = 'closed' WHERE id = v_real;
    IF EXISTS (SELECT 1 FROM public.monthly_periods WHERE client_id = v_c AND bs_year = 2087 AND bs_month IN (1, 5, 6)) THEN
      RAISE EXCEPTION 'S809 3j probe: BLOOM CAFE already has a month in Baisakh, Bhadra or Ashwin 2087';
    END IF;
    INSERT INTO public.monthly_periods (client_id, bs_year, bs_month, status) VALUES (v_c, 2087, 1, 'open') RETURNING id INTO v_p;
    INSERT INTO public.monthly_periods (client_id, bs_year, bs_month, status) VALUES (v_c, 2087, 5, 'closed') RETURNING id INTO v_pc;
    SELECT ad_start + 1 INTO v_d1 FROM public.bs_months WHERE bs_year = 2087 AND bs_month = 1;
    SELECT ad_start + 1 INTO v_d5 FROM public.bs_months WHERE bs_year = 2087 AND bs_month = 5;
    SELECT ad_start + 1 INTO v_d6 FROM public.bs_months WHERE bs_year = 2087 AND bs_month = 6;
    IF v_d1 IS NULL OR v_d5 IS NULL OR v_d6 IS NULL THEN
      RAISE EXCEPTION 'S809 3j probe: bs_months does not cover Baisakh, Bhadra and Ashwin 2087';
    END IF;

    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_c, 'S809 3j probe chicken', 'GM', 1, 0.5, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.recipes (client_id, name, category, selling_price, yield_qty, cost_price)
      VALUES (v_c, 'S809 3j probe momo', 'Food', 250, 1, 0) RETURNING id INTO v_momo;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, sub_recipe_id, qty_per_portion)
      VALUES (v_momo, v_chicken, NULL, 100);

    -- Bills, closed at noon (Nepal) on day 2 of each month. order_no is given, so the probe takes no
    -- lock on the outlet's real series.
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 250, 'S809 3j probe', 990701, (v_d1 + time '12:00') AT TIME ZONE 'Asia/Kathmandu') RETURNING id INTO v_o1;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 250, 'S809 3j probe', 990702, (v_d1 + time '12:00') AT TIME ZONE 'Asia/Kathmandu') RETURNING id INTO v_o2;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 250, 'S809 3j probe', 990703, (v_d5 + time '12:00') AT TIME ZONE 'Asia/Kathmandu') RETURNING id INTO v_o3;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 250, 'S809 3j probe', 990704, (v_d6 + time '12:00') AT TIME ZONE 'Asia/Kathmandu') RETURNING id INTO v_o4;
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at, ims_posted_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 500, 'S809 3j probe', 990705, (v_d1 + time '11:00') AT TIME ZONE 'Asia/Kathmandu', now()) RETURNING id INTO v_o5;
    -- A credit note on the posted bill, issued in Baisakh, not yet taken off Inventory sales.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                         taxable_amount, non_taxable_amount, vat_amount, net_amount, restock, created_at)
      VALUES (v_c, v_o5, '86/87', 1, 'S809 3j probe', '2 Baisakh 2087', 'S809 3j probe', 'none', 500, 0, 0, 500, 0, 500, false,
              (v_d1 + time '13:00') AT TIME ZONE 'Asia/Kathmandu')
      RETURNING id INTO v_n1;

    -- ══ As the POS PIN manager ═════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('manager') OR NOT COALESCE(public.is_pos_pin_staff(), false)
       OR COALESCE(public.is_ims_staff(), false) THEN
      RAISE EXCEPTION 'S809 3j probe: the stand-in % is not a plain POS PIN manager', v_mgr;
    END IF;

    -- (a) What the post reads. items is fenced from a PIN login (no error, no rows); the recipe book
    -- comes through pos_recipe_book with the ingredient's trim loss; the bills, their note, the
    -- months and the sales rows are all readable.
    SELECT count(*) INTO v_n FROM public.items WHERE id = v_chicken;
    IF v_n <> 0 THEN
      RAISE EXCEPTION 'S809 3j probe: a PIN manager read items directly (% rows)', v_n;
    END IF;
    SELECT count(*) INTO v_n
      FROM jsonb_array_elements(public.pos_recipe_book(v_c, ARRAY[v_momo], '{}') -> 'recipes') x,
           jsonb_array_elements(x -> 'recipe_ingredients') i
     WHERE (i ->> 'item_id')::uuid = v_chicken AND (i -> 'items' ->> 'yield_pct')::numeric = 85;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'S809 3j probe: the PIN manager''s recipe book did not carry the chicken''s 85%% yield';
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_orders WHERE id IN (v_o1, v_o2, v_o3, v_o4, v_o5);
    SELECT count(*) INTO v_m FROM public.pos_credit_notes WHERE id = v_n1;
    IF v_n <> 5 OR v_m <> 1 OR NOT EXISTS (SELECT 1 FROM public.monthly_periods WHERE id = v_p) THEN
      RAISE EXCEPTION 'S809 3j probe: the PIN manager could not read the bills (%), the note (%) or the month', v_n, v_m;
    END IF;

    -- (b) The counts: Baisakh (open) 2 bills and 1 note; Bhadra (closed) 1 bill; Ashwin (no month) 1.
    SELECT * INTO r FROM public.pos_ims_waiting_counts(v_c) w WHERE w.bs_year = 2087 AND w.bs_month = 1;
    IF r.bills IS DISTINCT FROM 2 OR r.notes IS DISTINCT FROM 1 OR r.period_id IS DISTINCT FROM v_p OR r.period_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'S809 3j probe: Baisakh 2087 came back %', row_to_json(r);
    END IF;
    SELECT * INTO r FROM public.pos_ims_waiting_counts(v_c) w WHERE w.bs_year = 2087 AND w.bs_month = 5;
    IF r.bills IS DISTINCT FROM 1 OR r.notes IS DISTINCT FROM 0 OR r.period_id IS DISTINCT FROM v_pc OR r.period_status IS DISTINCT FROM 'closed' THEN
      RAISE EXCEPTION 'S809 3j probe: Bhadra 2087 came back %', row_to_json(r);
    END IF;
    SELECT * INTO r FROM public.pos_ims_waiting_counts(v_c) w WHERE w.bs_year = 2087 AND w.bs_month = 6;
    IF r.bills IS DISTINCT FROM 1 OR r.notes IS DISTINCT FROM 0 OR r.period_id IS NOT NULL OR r.period_status IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3j probe: Ashwin 2087 (no month) came back %', row_to_json(r);
    END IF;
    -- Another outlet: refused.
    BEGIN
      PERFORM * FROM public.pos_ims_waiting_counts(v_c2);
      RAISE EXCEPTION 'S809 3j probe: a POS manager read another outlet''s waiting counts';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 3j probe: another outlet''s counts — expected rank_required, got: %', v_msg;
      END IF;
    END;

    -- (c) The floor's post of an open-month bill: its sales in one statement, then its stock lines.
    -- The bill is marked with its rows.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_p, v_momo, 2, 1, 'pos', 250, 0, v_o1);
    SELECT ims_posted_at INTO v_ts FROM public.pos_orders WHERE id = v_o1;
    IF v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 3j probe: the PIN manager''s post left bill 1 marked % (want now())', v_ts;
    END IF;
    INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
      VALUES (v_c, v_chicken, v_p, 2, -117.65, 'pos_sale', v_o1);
    -- The same bill again (a second press, or the Owner's Periods post a moment later): refused.
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
        VALUES (v_p, v_momo, 2, 1, 'pos', 250, 0, v_o1);
      RAISE EXCEPTION 'S809 3j probe: bill 1 was posted to Inventory a second time';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_bill_already_posted' THEN
        RAISE EXCEPTION 'S809 3j probe: a second post of bill 1 — expected pos_bill_already_posted, got: %', v_msg;
      END IF;
    END;

    -- (d) Not into a closed month: a POS manager's sales row in Bhadra is refused.
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
        VALUES (v_pc, v_momo, 2, 1, 'pos', 250, 0, v_o3);
      RAISE EXCEPTION 'S809 3j probe: a POS manager posted into a closed month';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'period_closed' THEN
        RAISE EXCEPTION 'S809 3j probe: a post into a closed month — expected period_closed, got: %', v_msg;
      END IF;
    END;

    -- (e) The note's reversal, two lines in one statement: it lands and marks the note.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
      VALUES (v_p, v_momo, 2, -1, 'pos_credit', 250, 0, v_n1),
             (v_p, v_momo, 2, -1, 'pos_credit', 250, 0, v_n1);
    SELECT ims_posted_at INTO v_ts FROM public.pos_credit_notes WHERE id = v_n1;
    IF v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 3j probe: the note''s reversal left it marked % (want now())', v_ts;
    END IF;
    -- (f) The same note again: refused, and no third row.
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
        VALUES (v_p, v_momo, 2, -1, 'pos_credit', 250, 0, v_n1);
      RAISE EXCEPTION 'S809 3j probe: a Credit Note was taken off Inventory sales a second time';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_credit_note_already_posted' THEN
        RAISE EXCEPTION 'S809 3j probe: a second reversal — expected pos_credit_note_already_posted, got: %', v_msg;
      END IF;
    END;
    SELECT count(*) INTO v_n FROM public.sales_entries WHERE pos_credit_note_id = v_n1;
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 3j probe: the note has % reversal rows (want 2)', v_n;
    END IF;

    -- (g) The counts follow: Baisakh now 1 bill and no note.
    SELECT * INTO r FROM public.pos_ims_waiting_counts(v_c) w WHERE w.bs_year = 2087 AND w.bs_month = 1;
    IF r.bills IS DISTINCT FROM 1 OR r.notes IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 3j probe: after the posts Baisakh 2087 came back %', row_to_json(r);
    END IF;

    -- ══ As the POS PIN supervisor: not among those told ════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sup, 'role', 'authenticated')::text, true);
    IF NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager') THEN
      RAISE EXCEPTION 'S809 3j probe: the stand-in % is not a plain POS supervisor', v_sup;
    END IF;
    BEGIN
      PERFORM * FROM public.pos_ims_waiting_counts(v_c);
      RAISE EXCEPTION 'S809 3j probe: a POS supervisor read the waiting counts';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 3j probe: a POS supervisor''s counts — expected rank_required, got: %', v_msg;
      END IF;
    END;

    -- ══ As an IMS supervisor ═══════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_ims, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_ims_staff(), false) OR NOT public.ims_caller_has_rank('supervisor')
       OR COALESCE(public.is_client_owner(), false) OR public.pos_caller_has_rank('staff') THEN
      RAISE EXCEPTION 'S809 3j probe: the stand-in % is not a plain IMS supervisor', v_ims;
    END IF;
    -- (h) The root cause, kept: an IMS login reads no bill and no note (no error, no rows) ...
    SELECT count(*) INTO v_n FROM public.pos_orders WHERE id IN (v_o2, v_o3, v_o4);
    SELECT count(*) INTO v_m FROM public.pos_credit_notes WHERE client_id = v_c;
    IF v_n <> 0 OR v_m <> 0 THEN
      RAISE EXCEPTION 'S809 3j probe: an IMS login read % bill(s) and % note(s) — no_ims_staff no longer holds', v_n, v_m;
    END IF;
    -- (i) ... and learns from the count how many wait, and where.
    SELECT * INTO r FROM public.pos_ims_waiting_counts(v_c) w WHERE w.bs_year = 2087 AND w.bs_month = 1;
    IF r.bills IS DISTINCT FROM 1 OR r.notes IS DISTINCT FROM 0 OR r.period_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'S809 3j probe: the IMS supervisor''s Baisakh 2087 came back %', row_to_json(r);
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_ims_waiting_counts(v_c) w
     WHERE w.bs_year = 2087 AND ((w.bs_month = 5 AND w.bills = 1 AND w.period_status = 'closed')
                              OR (w.bs_month = 6 AND w.bills = 1 AND w.period_id IS NULL));
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 3j probe: the IMS supervisor did not see Bhadra and Ashwin 2087 waiting';
    END IF;
    -- (j) IMS staff rank is not told (the "Needs attention" row is for supervisors and up).
    RESET ROLE;
    UPDATE public.profiles SET ims_role = 'staff' WHERE id = v_ims;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM * FROM public.pos_ims_waiting_counts(v_c);
      RAISE EXCEPTION 'S809 3j probe: an IMS staff login read the waiting counts';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 3j probe: an IMS staff login''s counts — expected rank_required, got: %', v_msg;
      END IF;
    END;

    -- ══ As a login with no profile ═════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
    IF public.is_admin() IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3j probe: is_admin() is not NULL for a login with no profile, so this step proves nothing';
    END IF;
    BEGIN
      PERFORM * FROM public.pos_ims_waiting_counts(v_c);
      RAISE EXCEPTION 'S809 3j probe: a login with no profile read the waiting counts';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 3j probe: a no-profile login''s counts — expected rank_required, got: %', v_msg;
      END IF;
    END;

    -- ══ As the Owner ═══════════════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 3j probe: % is not an Owner login', v_owner;
    END IF;
    -- (k) The Owner's counts are the PIN manager's.
    SELECT * INTO r FROM public.pos_ims_waiting_counts(v_c) w WHERE w.bs_year = 2087 AND w.bs_month = 1;
    IF r.bills IS DISTINCT FROM 1 OR r.notes IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 3j probe: the Owner''s Baisakh 2087 came back %', row_to_json(r);
    END IF;
    BEGIN
      PERFORM * FROM public.pos_ims_waiting_counts(v_c2);
      RAISE EXCEPTION 'S809 3j probe: the Owner read another outlet''s waiting counts';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 3j probe: the Owner and another outlet — expected rank_required, got: %', v_msg;
      END IF;
    END;
    -- (l) The Owner meets the note rule too (a Periods post after the floor's).
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
        VALUES (v_p, v_momo, 2, -1, 'pos_credit', 250, 0, v_n1);
      RAISE EXCEPTION 'S809 3j probe: the Owner took the Credit Note off Inventory sales a second time';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_credit_note_already_posted' THEN
        RAISE EXCEPTION 'S809 3j probe: the Owner''s second reversal — expected pos_credit_note_already_posted, got: %', v_msg;
      END IF;
    END;
    -- (m) The Owner may still post into the closed month (the closed-period carve-out is untouched).
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_pc, v_momo, 2, 1, 'pos', 250, 0, v_o3);
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_o3) IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 3j probe: the Owner''s post into the closed month did not mark its bill';
    END IF;

    -- ══ As the operator ════════════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 3j probe: % is not the operator', v_admin;
    END IF;
    -- (n) Any outlet's counts, without an error.
    PERFORM * FROM public.pos_ims_waiting_counts(v_c2);
    SELECT count(*) INTO v_n FROM public.pos_ims_waiting_counts(v_c) w WHERE w.bs_year = 2087 AND w.bills + w.notes > 0;
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 3j probe: the operator saw % probe month(s) waiting (want Baisakh and Ashwin)', v_n;
    END IF;
    -- (o) The restore (rows dated in the past) is not refused, though the note already has rows.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id, created_at)
      VALUES (v_p, v_momo, 2, -1, 'pos_credit', 250, 0, v_n1, v_past);
    -- (p) Outside a restore the operator meets the same rule.
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
        VALUES (v_p, v_momo, 2, -1, 'pos_credit', 250, 0, v_n1);
      RAISE EXCEPTION 'S809 3j probe: the operator took the Credit Note off Inventory sales a second time';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_credit_note_already_posted' THEN
        RAISE EXCEPTION 'S809 3j probe: the operator''s second reversal — expected pos_credit_note_already_posted, got: %', v_msg;
      END IF;
    END;

    RESET ROLE;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3j_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3j_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, provolatile, proconfig, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace AND proname IN ('pos_ims_waiting_counts', 'sales_entries_stamp_pos_source');
--     expect sales_entries_stamp_pos_source 639217f30a83b1ecc600cae2d4de7f39 (this file as written, LF),
--     prosecdef true, proconfig {search_path=public}, proacl {postgres=X/postgres}; pos_ims_waiting_counts
--     3898b87725dd5d4dc6177596ddd18bcf, prosecdef true, 's', {search_path=public}, {postgres=X/postgres,authenticated=X/postgres}.
--   SELECT has_function_privilege('anon', 'public.pos_ims_waiting_counts(uuid)', 'EXECUTE');   -- false
--   SELECT tgname, tgtype, tgenabled, tgnewtable FROM pg_trigger
--    WHERE tgrelid = 'public.sales_entries'::regclass AND NOT tgisinternal ORDER BY tgname;
--     expect ims_closed_period_guard 31, ims_rank_guard 31, sales_entries_stamp_pos_source 4 new_rows, all 'O'.
--   SELECT count(*) FROM public.pos_orders WHERE status = 'billed' AND ims_posted_at IS NULL;      -- unchanged (0 on 2026-10-10)
--   SELECT count(*) FROM public.items WHERE name LIKE 'S809 3j probe%';                            -- 0 (the probe rolled back)
--   SELECT client_id, bs_year, bs_month, status FROM public.monthly_periods WHERE status = 'open' ORDER BY 1;
--     expect BLOOM CAFE's own open month still open (the probe closed it only inside its rollback)
