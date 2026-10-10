-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 3, slice 3n: the Group Console counts guests the way the Covers Report does, and cuts
-- the BS month at Nepal's midnight.
--
--   GAP-OUTLETS-3 (P2; the fourth copy of REPORTS-3's rule, which the same slice fixes on the POS
--   Dashboard and Home in the app). get_group_summary's covers summed every paid bill, takeaway and
--   delivery included (the till stores 1 cover on each), and bounded the month with
--   p_ad_start::timestamptz and (p_ad_end + 1)::timestamptz. Those casts run under the server's
--   TimeZone, which is UTC (no database or role override), so the BS month began and ended at 05:45
--   Nepal time: a bill closed between midnight and 05:45 on the 1st counted in the month before, and
--   one closed in the first 5 h 45 min after the month's last day counted in it.
--     * Covers are guests SEATED: close_type 'paid' AND table_id IS NOT NULL, coversMath.isDineIn's
--       rule (owner decision S754) and the Covers Report's count (coversMath.seatedCovers). A
--       credit-noted bill keeps its guests, as on the Covers Report; the body never looked at
--       credit_note_id, and still does not. Voids and complimentary bills count none, as before.
--     * The month's AD days come from bs_months (ad_start, days), the server's copy of the app's BS
--       calendar (bsMonthsSql.test.js holds the two equal), cut at Nepal's midnight:
--       [ad_start 00:00 NPT, ad_start + days 00:00 NPT). So the guests and the revenue (the period)
--       are always the same BS month, whatever dates a page sends. p_ad_start / p_ad_end stay in the
--       signature (the Group Console on crest-v426 sends them) and are used only for a month
--       bs_months does not hold (outside BS 2000–2087), where they are the page's own conversion, now
--       also cut at Nepal's midnight. A call without them used to get 0 guests; it now gets the month's.
--     * Revenue, net purchases and payroll are untouched, character for character. The Revenue tip
--       promised every till bill while the figure counts only bills posted to Inventory: the TIP is
--       corrected (GroupDashboard.jsx, this slice), not the figure. Revenue is Inventory sales by
--       period, before VAT and after discounts, the base the page's Food Cost % and Labour % divide
--       by and the one Consolidated P&L uses; counting unposted till bills would put a VAT-inclusive
--       till total beside it, or count a bill twice once it is posted.
--
-- Built on the LIVE body (pg_get_functiondef, md5(prosrc), read 2026-10-10 with 3j live):
--   get_group_summary(integer,integer,date,date)   498a637803cfacd2cf9c197c48459497   (S798 3c's, 20261003120000)
-- Section 0 refuses to run over any other body. The changes are the two blocks marked "S809 3n".
-- It stays plpgsql, STABLE, SECURITY DEFINER, search_path public, with the same arguments and the
-- same RETURNS TABLE. CREATE OR REPLACE keeps its grants, live proacl
-- {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} (no PUBLIC, no anon), which
-- section 3 asserts rather than re-grants.
-- Called, not replaced (their contracts are all this file relies on; the probe tests the behaviour):
--   is_admin()          4f849a5c62042e5b2caa32d67c50f341
--   is_client_owner()   bc4def4bff553cd31cf0071cdef6b1d4
--   my_group_id()       6ec5a295329116545a0ffc970d6ce679
-- Read, not replaced: bs_months (1,056 rows, BS 2000–2087).
-- Not touched (owned by other stage-3 slices drafted at the same time): 3c's tablet-key read of
-- waiting guest orders and anything of 3b's or 3h's; save_pos_order_items (3e, if it needs it).
--
-- Live before this migration (2026-10-10, 19:15 Nepal time):
--   * BLOOM CAFE and BLOOM CAFE - PKR form one group (4a0a6b29-3e20-4076-9fc1-3862ff9ccc90), both
--     suite_plan 'pro'. No other client has a group.
--   * Ashwin 2083 so far (AD 2026-09-17 … 2026-10-17), Group Covers before → after:
--       BLOOM CAFE         1,521 → 1,314   (194 takeaway and delivery bills carried 207 covers)
--       BLOOM CAFE - PKR     996 →   903   (93 such bills, 93 covers)
--       Group              2,517 → 2,217
--     Paid bills ever closed between 00:00 and 05:45 Nepal time: 0 at either outlet, so the month cut
--     moves no live bill today; the takeaway rule is the whole of today's difference.
--   * Nothing here adds a constraint, a trigger or a refusal, so no stored row is rejected.
--
-- The probe at the end runs as BLOOM CAFE's Owner (and, for the refusals, a POS PIN login and a login
-- with no profile). It compares this month and last against what the old body returned for the same
-- call (section 1): every other column identical, guests now the dine-in count by a plain SELECT. It
-- then brings its own tables and bills in Baisakh, Jestha and Ashadh 2087 (inside bs_months, far from
-- any real bill) and in May 2031 (outside it): dine-in, takeaway, delivery, a void, a complimentary
-- bill, one closed at 02:00 Nepal time on the 1st of Jestha, one at 23:50 on Jestha's last day and
-- one at 03:00 on the 1st of Ashadh, plus a bill at the other outlet. It rolls itself back. If any
-- check fails, the whole migration fails and nothing lands. Drafted against a local Postgres 17
-- replica of the live tables this function reads (columns as live, bs_months as live, the live
-- helper and function bodies and grants, TimeZone UTC): the file runs clean, again over itself, and
-- as one transaction; six broken copies (no table_id test, the old UTC casts, the page's dates
-- trusted over bs_months, no fallback, comps back in revenue, the owner check without COALESCE)
-- each fail the probe at the step meant, and the UTC copy fails on the probe's own bills alone too.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ─────────────────────────────────────────────────────────────────────────────
-- One get_group_summary, and its body is the one this file was built on, or already this file's
-- own (a re-run).
DO $$
DECLARE
  v_md5 text;
  v_n   integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace AND proname = 'get_group_summary';
  IF v_n <> 1 OR to_regprocedure('public.get_group_summary(integer,integer,date,date)') IS NULL THEN
    RAISE EXCEPTION 'S809 3n: expected one get_group_summary(integer,integer,date,date), found % signature(s)', v_n;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc
   WHERE oid = 'public.get_group_summary(integer,integer,date,date)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '498a637803cfacd2cf9c197c48459497'
     AND v_md5 IS DISTINCT FROM 'b2aee04b499dbb3ce5bc29bb0f56b2d9' THEN
    RAISE EXCEPTION 'S809 3n: get_group_summary is not the body this file was built on (live md5 %) — rebuild the 3n blocks on the live body', v_md5;
  END IF;
END;
$$;


-- ── 1. What the Group Console shows before this file ─────────────────────────────────────────
-- This month and last (the page reads both), as BLOOM CAFE's Owner, with the dates the page sends
-- (formatAd of day 1 and of the last day). Kept in a temporary table for the probe's comparison;
-- nothing is written. The caller's identity is set inside a block that rolls itself back, so the
-- role and the claims end with it.
CREATE TEMP TABLE IF NOT EXISTS s809_3n_before (
  bs_year integer, bs_month integer, ad_start date, ad_end date,
  client_id uuid, client_name text, is_included boolean, has_period boolean,
  revenue numeric, net_purchases numeric, payroll numeric, covers bigint
);
CREATE TEMP TABLE IF NOT EXISTS s809_3n_after (
  bs_year integer, bs_month integer, client_id uuid, client_name text, covers bigint
);
DELETE FROM pg_temp.s809_3n_before;
DELETE FROM pg_temp.s809_3n_after;

DO $$
DECLARE
  v_c      uuid;
  v_owner  uuid;
  v_today  date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_months jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_part   jsonb;
  m        record;
BEGIN
  SELECT id INTO v_c FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.client_id = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  IF v_c IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'S809 3n: needs BLOOM CAFE and its Owner (got %, %)', v_c, v_owner;
  END IF;
  -- This month (the one today's Nepal date falls in) and the one before it.
  SELECT jsonb_agg(jsonb_build_object('y', bm.bs_year, 'm', bm.bs_month, 's', bm.ad_start, 'e', bm.ad_start + bm.days - 1))
    INTO v_months
    FROM public.bs_months bm
   WHERE bm.ad_start <= v_today AND bm.ad_start + bm.days > v_today
      OR bm.ad_start + bm.days = (SELECT c.ad_start FROM public.bs_months c
                                   WHERE c.ad_start <= v_today AND c.ad_start + c.days > v_today);
  IF jsonb_array_length(COALESCE(v_months, '[]'::jsonb)) <> 2 THEN
    RAISE EXCEPTION 'S809 3n: bs_months does not hold this month and the one before (today %)', v_today;
  END IF;

  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    FOR m IN SELECT (x ->> 'y')::integer AS y, (x ->> 'm')::integer AS mo, (x ->> 's')::date AS s, (x ->> 'e')::date AS e
               FROM jsonb_array_elements(v_months) x
    LOOP
      SELECT COALESCE(jsonb_agg(to_jsonb(g) || jsonb_build_object('bs_year', m.y, 'bs_month', m.mo, 'ad_start', m.s, 'ad_end', m.e)), '[]'::jsonb)
        INTO v_part
        FROM public.get_group_summary(m.y, m.mo, m.s, m.e) g;
      v_rows := v_rows || v_part;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3n_capture_done';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3n_capture_done' THEN RAISE; END IF;
  END;

  INSERT INTO pg_temp.s809_3n_before
  SELECT * FROM jsonb_populate_recordset(NULL::pg_temp.s809_3n_before, v_rows);
END;
$$;


-- ── 2. get_group_summary: dine-in guests, the Nepal month ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_group_summary(p_bs_year integer, p_bs_month integer, p_ad_start date DEFAULT NULL::date, p_ad_end date DEFAULT NULL::date)
 RETURNS TABLE(client_id uuid, client_name text, is_included boolean, has_period boolean, revenue numeric, net_purchases numeric, payroll numeric, covers bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
  v_from  timestamptz;
  v_to    timestamptz;
BEGIN
  -- COALESCE on both: each reads a profiles row and returns NULL rather than false when the
  -- caller has none, and NULL OR NULL is NULL, which NOT() leaves NULL, which never fires the
  -- branch -- the fail-open shape S579 documents. Group figures are owner-altitude by
  -- definition: this is the one screen in the product that crosses tenants.
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can see group figures.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  -- S809 3n (GAP-OUTLETS-3): the month's guests are cut at Nepal's midnight, not the server's.
  -- `date::timestamptz` runs under the server's TimeZone (UTC), so the old bounds began and ended
  -- the BS month at 05:45 Nepal time. The month's AD days come from bs_months, so the guests and
  -- the revenue (the period) are always the same BS month; the page's p_ad_start / p_ad_end are
  -- used only for a month bs_months does not hold (outside BS 2000-2087), as the page's own
  -- conversion, cut at Nepal's midnight too.
  SELECT bm.ad_start::timestamp AT TIME ZONE 'Asia/Kathmandu',
         (bm.ad_start + bm.days)::timestamp AT TIME ZONE 'Asia/Kathmandu'
    INTO v_from, v_to
    FROM bs_months bm
   WHERE bm.bs_year = p_bs_year AND bm.bs_month = p_bs_month;
  IF v_from IS NULL AND p_ad_start IS NOT NULL AND p_ad_end IS NOT NULL THEN
    v_from := p_ad_start::timestamp AT TIME ZONE 'Asia/Kathmandu';
    v_to   := (p_ad_end + 1)::timestamp AT TIME ZONE 'Asia/Kathmandu';
  END IF;

  RETURN QUERY
  WITH outlets AS (
    SELECT c.id, c.name, (c.suite_plan = 'pro') AS included
      FROM clients c
     WHERE c.group_id = v_group
  ),
  per AS (
    SELECT o.id AS cid, mp.id AS period_id
      FROM outlets o
      LEFT JOIN monthly_periods mp
        ON mp.client_id = o.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
  )
  SELECT
    o.id,
    o.name,
    o.included,
    (per.period_id IS NOT NULL),
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(se.qty_sold * COALESCE(se.unit_price, r.selling_price, 0) - COALESCE(se.discount, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id AND se.source IS DISTINCT FROM 'pos_comp'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(b.gross) - sum(b.discount)
        FROM (
          -- One row per bill: its gross over all lines and its ONE discount (max, not sum -- the
          -- value is repeated on every line). Bill identity mirrors billKeyOf().
          SELECT sum(pe.qty * pe.rate)                AS gross,
                 max(COALESCE(pe.discount_amount, 0)) AS discount
            FROM purchase_entries pe
           WHERE pe.period_id = per.period_id
           GROUP BY COALESCE(
                      pe.purchase_group_id::text,
                      COALESCE(pe.vendor_id::text, '') || '|' ||
                      COALESCE(pe.invoice_ref, '')     || '|' ||
                      COALESCE(pe.bs_day::text, ''))
        ) b
    ), 0) - COALESCE((
      SELECT sum(vr.qty * vr.rate) FROM vendor_returns vr WHERE vr.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      -- S798 3c (H19): pay EARNED — gross less the absence deduction — as payrollLabourTotal.
      SELECT sum(ps.gross - COALESCE(ps.absence_deduction, 0) + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))
        FROM hr_payslips ps JOIN hr_payroll_runs pr ON pr.id = ps.run_id
       WHERE pr.client_id = o.id AND pr.period_id = per.period_id AND pr.status = 'finalized'
    ), 0) END,
    -- S809 3n (GAP-OUTLETS-3, REPORTS-3): guests SEATED, the Covers Report's count
    -- (coversMath.seatedCovers, owner decision S754): a paid bill served at a table. A takeaway or
    -- delivery bill has no table and its "covers" is the till's default; a bill later credit-noted
    -- keeps its guests.
    CASE WHEN o.included AND v_from IS NOT NULL THEN COALESCE((
      SELECT sum(po.covers)::bigint FROM pos_orders po
       WHERE po.client_id = o.id
         AND po.close_type = 'paid'
         AND po.table_id IS NOT NULL
         AND po.closed_at >= v_from
         AND po.closed_at <  v_to
    ), 0) ELSE 0 END
  FROM outlets o JOIN per ON per.cid = o.id
  ORDER BY o.name;
END;
$function$;


-- ── 3. Catalog, then the probe ────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c       uuid;
  v_c2      uuid;
  v_owner   uuid;
  v_pos     uuid;
  v_nobody  uuid := '5a3c0f1e-8093-4e1d-9b2f-0c3a5e7d9b11';  -- no profile (checked below)
  v_before  jsonb;
  v_expect  jsonb;
  v_after   jsonb := '[]'::jsonb;
  v_d1      date;   -- 1 Baisakh 2087
  v_d2      date;   -- 1 Jestha 2087
  v_d3      date;   -- 1 Ashadh 2087
  v_days1   integer;
  v_days2   integer;
  v_days3   integer;
  v_t1      uuid;
  v_t2      uuid;
  v_n       bigint;
  v_m       bigint;
  v_txt     text;
  v_msg     text;
  r         record;
  g         record;
  b         record;
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  SELECT count(*) INTO v_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_group_summary';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 3n: get_group_summary has % signatures (want 1)', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.get_group_summary(integer,integer,date,date)'::regprocedure
       AND prosecdef AND provolatile = 's' AND proretset AND pronargs = 4 AND pronargdefaults = 2
       AND proconfig = ARRAY['search_path=public']
       AND proargnames = ARRAY['p_bs_year','p_bs_month','p_ad_start','p_ad_end','client_id','client_name',
                               'is_included','has_period','revenue','net_purchases','payroll','covers']
       AND proallargtypes = ARRAY['integer','integer','date','date','uuid','text','boolean','boolean',
                                  'numeric','numeric','numeric','bigint']::regtype[]::oid[]) THEN
    RAISE EXCEPTION 'S809 3n: get_group_summary is not SECURITY DEFINER, STABLE, search_path public with its own arguments and columns';
  END IF;
  -- EXECUTE for authenticated and service_role and nobody else but its owner (no PUBLIC, no anon).
  SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) INTO v_txt
    FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = 'public.get_group_summary(integer,integer,date,date)'::regprocedure AND a.grantee <> p.proowner;
  IF v_txt IS DISTINCT FROM '{authenticated,service_role}'
     OR has_function_privilege('anon', 'public.get_group_summary(integer,integer,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_group_summary(integer,integer,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'S809 3n: the grants are not as they were live (%)', v_txt;
  END IF;

  -- ── The logins and the outlets ─────────────────────────────────────────────────────────────
  SELECT id INTO v_c  FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_c2 FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_owner
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.client_id = v_c
     AND p.pos_email IS NULL AND p.pos_role IS NULL AND p.ims_role IS NULL AND p.hr_role IS NULL
     AND NOT COALESCE(p.hr_self_service, false)
   ORDER BY p.id
   LIMIT 1;
  SELECT p.id INTO v_pos
    FROM public.profiles p
   WHERE p.role = 'client' AND p.client_id = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'manager') DESC NULLS LAST, p.id
   LIMIT 1;
  IF v_c IS NULL OR v_c2 IS NULL OR v_owner IS NULL OR v_pos IS NULL THEN
    RAISE EXCEPTION 'S809 3n probe: needs BLOOM CAFE, BLOOM CAFE - PKR, the Owner of BLOOM CAFE and one of its POS logins (got %, %, %, %)',
      v_c, v_c2, v_owner, v_pos;
  END IF;
  IF (SELECT group_id FROM public.clients WHERE id = v_c) IS NULL
     OR (SELECT group_id FROM public.clients WHERE id = v_c) IS DISTINCT FROM (SELECT group_id FROM public.clients WHERE id = v_c2)
     OR EXISTS (SELECT 1 FROM public.clients WHERE id IN (v_c, v_c2) AND suite_plan IS DISTINCT FROM 'pro') THEN
    RAISE EXCEPTION 'S809 3n probe: BLOOM CAFE and BLOOM CAFE - PKR are no longer one group of Suite Pro outlets';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = v_nobody) THEN
    RAISE EXCEPTION 'S809 3n probe: the no-profile stand-in id % has a profile', v_nobody;
  END IF;

  -- ── The probe's months ─────────────────────────────────────────────────────────────────────
  SELECT ad_start, days INTO v_d1, v_days1 FROM public.bs_months WHERE bs_year = 2087 AND bs_month = 1;
  SELECT ad_start, days INTO v_d2, v_days2 FROM public.bs_months WHERE bs_year = 2087 AND bs_month = 2;
  SELECT ad_start, days INTO v_d3, v_days3 FROM public.bs_months WHERE bs_year = 2087 AND bs_month = 3;
  IF v_d1 IS NULL OR v_d2 IS NULL OR v_d3 IS NULL OR v_d1 + v_days1 <> v_d2 OR v_d2 + v_days2 <> v_d3 THEN
    RAISE EXCEPTION 'S809 3n probe: bs_months does not hold Baisakh, Jestha and Ashadh 2087 back to back';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bs_months WHERE bs_year = 2088 AND bs_month = 1) THEN
    RAISE EXCEPTION 'S809 3n probe: bs_months now holds Baisakh 2088; move the fallback step to a month it does not hold';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_orders
              WHERE client_id IN (v_c, v_c2)
                AND (closed_at >= ((v_d1 - 1)::timestamp AT TIME ZONE 'Asia/Kathmandu') AND closed_at < ((v_d3 + v_days3 + 1)::timestamp AT TIME ZONE 'Asia/Kathmandu')
                  OR closed_at >= (date '2031-04-30')::timestamp AT TIME ZONE 'Asia/Kathmandu' AND closed_at < (date '2031-06-02')::timestamp AT TIME ZONE 'Asia/Kathmandu')) THEN
    RAISE EXCEPTION 'S809 3n probe: BLOOM already has bills in Baisakh–Ashadh 2087 or May 2031; move the probe';
  END IF;

  -- ── This month and last, against section 1 ─────────────────────────────────────────────────
  -- What the old body returned, and the new rule's guests by a plain SELECT (dine-in, paid, the
  -- Nepal month from bs_months) for each included outlet. Read here, as the migration's own role.
  SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_before FROM pg_temp.s809_3n_before x;
  IF jsonb_array_length(v_before) < 2 THEN
    RAISE EXCEPTION 'S809 3n probe: section 1 captured % row(s) (want both outlets, this month and last)', jsonb_array_length(v_before);
  END IF;
  SELECT COALESCE(jsonb_object_agg(x.bs_year || '-' || x.bs_month || '-' || x.client_id, (
           SELECT COALESCE(sum(po.covers), 0) FROM public.pos_orders po
            WHERE po.client_id = x.client_id AND po.close_type = 'paid' AND po.table_id IS NOT NULL
              AND po.closed_at >= (bm.ad_start::timestamp AT TIME ZONE 'Asia/Kathmandu')
              AND po.closed_at <  ((bm.ad_start + bm.days)::timestamp AT TIME ZONE 'Asia/Kathmandu'))), '{}'::jsonb)
    INTO v_expect
    FROM pg_temp.s809_3n_before x JOIN public.bs_months bm ON bm.bs_year = x.bs_year AND bm.bs_month = x.bs_month;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role. Rolled back below. ─────────────────────────────────
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_c,  'S809 3n probe table') RETURNING id INTO v_t1;
    INSERT INTO public.pos_tables (client_id, name) VALUES (v_c2, 'S809 3n probe table') RETURNING id INTO v_t2;
    -- order_no is given, so the probe takes no lock on the outlets' real series; no invoice_fy, so
    -- no invoice number is drawn.
    INSERT INTO public.pos_orders (client_id, table_id, table_name, status, close_type, payment_method, paid_amount, covers, delivery_partner, order_no, opened_at, closed_at)
    SELECT v_c_, v_tbl, v_name, v_status, v_close, v_pay, v_amt, v_cov, v_partner, v_no,
           (v_day + v_time) AT TIME ZONE 'Asia/Kathmandu' - interval '1 hour', (v_day + v_time) AT TIME ZONE 'Asia/Kathmandu'
      FROM (VALUES
        -- A: dine-in, 3 guests, 02:00 Nepal time on 1 Jestha (20:15 UTC the day before).
        (v_c,  v_t1, 'S809 3n probe table', 'billed', 'paid',     'Cash', 900::numeric, 3, NULL::text,               980301, v_d2,               time '02:00'),
        -- B: dine-in, 2 guests, mid-Jestha.
        (v_c,  v_t1, 'S809 3n probe table', 'billed', 'paid',     'Cash', 600,          2, NULL,                     980302, v_d2 + 10,          time '13:00'),
        -- C: takeaway, the till's default 1 cover.
        (v_c,  NULL, 'Takeaway',            'billed', 'paid',     'Cash', 300,          1, NULL,                     980303, v_d2 + 10,          time '13:10'),
        -- D: delivery, through a partner, 1 cover.
        (v_c,  NULL, 'Delivery',            'billed', 'paid',     'Cash', 450,          1, 'S809 3n probe partner',  980304, v_d2 + 10,          time '13:20'),
        -- E: a void at a table, 4 guests.
        (v_c,  v_t1, 'S809 3n probe table', 'voided', 'void',     NULL,   NULL,         4, NULL,                     980305, v_d2 + 11,          time '12:00'),
        -- F: complimentary at a table, 2 guests.
        (v_c,  v_t1, 'S809 3n probe table', 'billed', 'writeoff', NULL,   0,            2, NULL,                     980306, v_d2 + 12,          time '12:00'),
        -- G: dine-in, 5 guests, 03:00 Nepal time on 1 Ashadh, the NEXT month (21:15 UTC on Jestha's last day).
        (v_c,  v_t1, 'S809 3n probe table', 'billed', 'paid',     'Cash', 1500,         5, NULL,                     980307, v_d3,               time '03:00'),
        -- H: the other outlet, dine-in, 6 guests, mid-Jestha.
        (v_c2, v_t2, 'S809 3n probe table', 'billed', 'paid',     'Cash', 1800,         6, NULL,                     980308, v_d2 + 10,          time '19:00'),
        -- I: outside bs_months, dine-in, 7 guests, 02:00 Nepal time on 1 May 2031.
        (v_c,  v_t1, 'S809 3n probe table', 'billed', 'paid',     'Cash', 2100,         7, NULL,                     980309, date '2031-05-01',  time '02:00'),
        -- J: dine-in, 2 guests, 23:50 Nepal time on Jestha's last day.
        (v_c,  v_t1, 'S809 3n probe table', 'billed', 'paid',     'Cash', 600,          2, NULL,                     980310, v_d2 + v_days2 - 1, time '23:50')
      ) AS f(v_c_, v_tbl, v_name, v_status, v_close, v_pay, v_amt, v_cov, v_partner, v_no, v_day, v_time);

    -- The fixture shows both defects under the OLD rule (every paid bill, the month cut at UTC
    -- midnight = 05:45 Nepal time): Jestha would read B 2 + C 1 + D 1 + J 2 + G 5 = 11, with A's 3
    -- in Baisakh. The new rule reads A 3 + B 2 + J 2 = 7.
    SELECT COALESCE(sum(covers), 0) INTO v_n FROM public.pos_orders
     WHERE client_id = v_c AND close_type = 'paid'
       AND closed_at >= (v_d2::timestamp AT TIME ZONE 'UTC') AND closed_at < ((v_d2 + v_days2)::timestamp AT TIME ZONE 'UTC');
    IF v_n <> 11 THEN
      RAISE EXCEPTION 'S809 3n probe: the fixture does not show the old defects (the old rule gives % for Jestha, want 11)', v_n;
    END IF;

    -- ══ As BLOOM CAFE's Owner ══════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF NOT COALESCE(public.is_client_owner(), false) OR COALESCE(public.is_admin(), false) OR public.my_group_id() IS NULL THEN
      RAISE EXCEPTION 'S809 3n probe: % is not an Owner in an outlet group', v_owner;
    END IF;

    -- (a) This month and last, with the dates the page sends: every column but the guests is what
    --     the old body returned; the guests are the dine-in count.
    FOR r IN SELECT DISTINCT x.bs_year, x.bs_month, x.ad_start, x.ad_end
               FROM jsonb_to_recordset(v_before) AS x(bs_year integer, bs_month integer, ad_start date, ad_end date)
    LOOP
      v_m := 0;
      FOR g IN SELECT * FROM public.get_group_summary(r.bs_year, r.bs_month, r.ad_start, r.ad_end) LOOP
        v_m := v_m + 1;
        SELECT * INTO b
          FROM jsonb_to_recordset(v_before) AS x(bs_year integer, bs_month integer, client_id uuid, client_name text,
                                                 is_included boolean, has_period boolean, revenue numeric,
                                                 net_purchases numeric, payroll numeric, covers bigint)
         WHERE x.bs_year = r.bs_year AND x.bs_month = r.bs_month AND x.client_id = g.client_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'S809 3n probe: % appeared in %/% only after this file', g.client_name, r.bs_month, r.bs_year;
        END IF;
        IF (g.client_name, g.is_included, g.has_period, g.revenue, g.net_purchases, g.payroll)
           IS DISTINCT FROM (b.client_name, b.is_included, b.has_period, b.revenue, b.net_purchases, b.payroll) THEN
          RAISE EXCEPTION 'S809 3n probe: % %/% changed more than its guests (before %, after %)',
            g.client_name, r.bs_month, r.bs_year,
            row(b.is_included, b.has_period, b.revenue, b.net_purchases, b.payroll),
            row(g.is_included, g.has_period, g.revenue, g.net_purchases, g.payroll);
        END IF;
        v_n := CASE WHEN g.is_included THEN (v_expect ->> (r.bs_year || '-' || r.bs_month || '-' || g.client_id))::bigint ELSE 0 END;
        IF g.covers IS DISTINCT FROM v_n THEN
          RAISE EXCEPTION 'S809 3n probe: % %/% guests % (the dine-in count is %)', g.client_name, r.bs_month, r.bs_year, g.covers, v_n;
        END IF;
        v_after := v_after || jsonb_build_array(jsonb_build_object('bs_year', r.bs_year, 'bs_month', r.bs_month,
                     'client_id', g.client_id, 'client_name', g.client_name, 'covers', g.covers));
        RAISE NOTICE 'S809 3n: % %/% guests: % before, % now', g.client_name, r.bs_month, r.bs_year, b.covers, g.covers;
      END LOOP;
      SELECT count(*) INTO v_n FROM jsonb_to_recordset(v_before) AS x(bs_year integer, bs_month integer)
       WHERE x.bs_year = r.bs_year AND x.bs_month = r.bs_month;
      IF v_m <> v_n THEN
        RAISE EXCEPTION 'S809 3n probe: %/% returned % outlet(s), the old body %', r.bs_month, r.bs_year, v_m, v_n;
      END IF;
    END LOOP;

    -- (b) Jestha 2087 with the page's dates: dine-in guests only, the 02:00 bill on the 1st in, the
    --     03:00 bill on the 1st of the next month out. The other outlet has its own.
    SELECT covers INTO v_n FROM public.get_group_summary(2087, 2, v_d2, v_d2 + v_days2 - 1) WHERE client_id = v_c;
    SELECT covers INTO v_m FROM public.get_group_summary(2087, 2, v_d2, v_d2 + v_days2 - 1) WHERE client_id = v_c2;
    IF v_n IS DISTINCT FROM 7 OR v_m IS DISTINCT FROM 6 THEN
      RAISE EXCEPTION 'S809 3n probe: Jestha 2087 guests % and % (want BLOOM CAFE 7 = 3 + 2 + 2, BLOOM CAFE - PKR 6)', v_n, v_m;
    END IF;
    -- (c) The same month with no dates: the server knows the month.
    SELECT covers INTO v_n FROM public.get_group_summary(2087, 2) WHERE client_id = v_c;
    IF v_n IS DISTINCT FROM 7 THEN
      RAISE EXCEPTION 'S809 3n probe: Jestha 2087 with no dates gave % guests (want 7)', v_n;
    END IF;
    -- (d) The same month with another month's dates: the page cannot move the cut.
    SELECT covers INTO v_n FROM public.get_group_summary(2087, 2, v_d1, v_d1 + v_days1 - 1) WHERE client_id = v_c;
    IF v_n IS DISTINCT FROM 7 THEN
      RAISE EXCEPTION 'S809 3n probe: Jestha 2087 sent with Baisakh''s dates gave % guests (want 7)', v_n;
    END IF;
    -- (e) Baisakh 2087: nothing (bill A belongs to Jestha).
    SELECT covers INTO v_n FROM public.get_group_summary(2087, 1, v_d1, v_d1 + v_days1 - 1) WHERE client_id = v_c;
    IF v_n IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 3n probe: Baisakh 2087 gave % guests (want 0; the 02:00 bill on 1 Jestha is Jestha''s)', v_n;
    END IF;
    -- (f) Ashadh 2087: bill G's 5.
    SELECT covers INTO v_n FROM public.get_group_summary(2087, 3, v_d3, v_d3 + v_days3 - 1) WHERE client_id = v_c;
    IF v_n IS DISTINCT FROM 5 THEN
      RAISE EXCEPTION 'S809 3n probe: Ashadh 2087 gave % guests (want 5)', v_n;
    END IF;
    -- (g) A month bs_months does not hold: the page's dates, cut at Nepal's midnight (bill I, 02:00 on
    --     the 1st, is in); with no dates there is no month to count.
    SELECT covers INTO v_n FROM public.get_group_summary(2088, 1, date '2031-05-01', date '2031-05-31') WHERE client_id = v_c;
    SELECT covers INTO v_m FROM public.get_group_summary(2088, 1) WHERE client_id = v_c;
    IF v_n IS DISTINCT FROM 7 OR v_m IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'S809 3n probe: a month outside bs_months gave % guests with the page''s dates (want 7) and % without (want 0)', v_n, v_m;
    END IF;

    -- ══ As one of BLOOM CAFE's POS logins: still refused ══════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pos, 'role', 'authenticated')::text, true);
    IF COALESCE(public.is_client_owner(), false) OR COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 3n probe: % is not a plain POS login', v_pos;
    END IF;
    BEGIN
      PERFORM * FROM public.get_group_summary(2087, 2, v_d2, v_d2 + v_days2 - 1);
      RAISE EXCEPTION 'S809 3n probe: a POS login read the group figures';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'Not permitted: only an owner%' THEN
        RAISE EXCEPTION 'S809 3n probe: a POS login — expected the owner-only refusal, got: %', v_msg;
      END IF;
    END;

    -- ══ As a login with no profile: still refused ═══════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
    IF public.is_admin() IS NOT NULL THEN
      RAISE EXCEPTION 'S809 3n probe: is_admin() is not NULL for a login with no profile, so this step proves nothing';
    END IF;
    BEGIN
      PERFORM * FROM public.get_group_summary(2087, 2, v_d2, v_d2 + v_days2 - 1);
      RAISE EXCEPTION 'S809 3n probe: a login with no profile read the group figures';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'Not permitted: only an owner%' THEN
        RAISE EXCEPTION 'S809 3n probe: a no-profile login — expected the owner-only refusal, got: %', v_msg;
      END IF;
    END;

    RESET ROLE;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_3n_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_3n_probe_rollback' THEN RAISE; END IF;
  END;

  -- The live figures, kept for the read-back below (the rows the probe wrote are gone with it).
  INSERT INTO pg_temp.s809_3n_after
  SELECT * FROM jsonb_populate_recordset(NULL::pg_temp.s809_3n_after, v_after);
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT md5(prosrc), prosecdef, provolatile, proconfig, proacl FROM pg_proc
--    WHERE oid = 'public.get_group_summary(integer,integer,date,date)'::regprocedure;
--     expect b2aee04b499dbb3ce5bc29bb0f56b2d9 (this file as written, LF), true, 's', {search_path=public},
--     {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
--   SELECT has_function_privilege('anon', 'public.get_group_summary(integer,integer,date,date)', 'EXECUTE');  -- false
--   SELECT count(*) FROM public.pos_tables WHERE name = 'S809 3n probe table';                               -- 0 (rolled back)
--   SELECT count(*) FROM public.pos_orders WHERE order_no BETWEEN 980301 AND 980310;                          -- 0 (rolled back)
--   This month's Group Covers for BLOOM, the figure the Group Console now shows (BS month from
--   bs_months, Nepal midnight; 1,314 and 903 for Ashwin 2083 on 2026-10-10 at 19:15):
--   SELECT c.name, COALESCE(sum(po.covers), 0) AS guests
--     FROM public.clients c
--     JOIN public.bs_months bm ON bm.ad_start <= (now() AT TIME ZONE 'Asia/Kathmandu')::date
--                             AND bm.ad_start + bm.days > (now() AT TIME ZONE 'Asia/Kathmandu')::date
--     LEFT JOIN public.pos_orders po ON po.client_id = c.id AND po.close_type = 'paid' AND po.table_id IS NOT NULL
--          AND po.closed_at >= (bm.ad_start::timestamp AT TIME ZONE 'Asia/Kathmandu')
--          AND po.closed_at <  ((bm.ad_start + bm.days)::timestamp AT TIME ZONE 'Asia/Kathmandu')
--    WHERE c.group_id = '4a0a6b29-3e20-4076-9fc1-3862ff9ccc90'
--    GROUP BY c.name ORDER BY c.name;

-- What the Group Console showed for BLOOM before this file and shows now, this month and last (the
-- result of applying this file is this table):
SELECT b.client_name, b.bs_year, b.bs_month, b.covers AS guests_before, a.covers AS guests_now,
       b.revenue, b.net_purchases, b.payroll
  FROM pg_temp.s809_3n_before b
  JOIN pg_temp.s809_3n_after a USING (bs_year, bs_month, client_id)
 ORDER BY b.bs_year, b.bs_month, b.client_name;
