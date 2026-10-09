-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S809 stage 2, slice 2f: a till bill's sales and its "posted to Inventory" mark land together, and
-- a till signed in on a Staff PIN reads the trim loss and food costs it was blind to.
--
--   IMS-HANDOFF-2 (P2). A closed bill reaches Inventory as sales_entries rows (source pos / pos_comp,
--   each carrying pos_order_id), and its mark, pos_orders.ims_posted_at, was a SECOND request the till
--   (or Periods → Post POS bills to Inventory) sent afterwards. When the rows landed and the mark did
--   not (a post that outlived the till's 30-second wait, an answer lost on bad Wi-Fi), the bill stayed
--   "not posted" for good: the floor banner and the Home tile kept counting it, and Periods said there
--   was nothing to post (its count leaves out bills that already have rows) and returned before the
--   code that marks them. BLOOM CAFE's bill 40 (NPR 1,880) sat like that from 2026-10-04 to the
--   owner's clear. A credit note's reversal (pos_credit rows, pos_credit_note_id) has the same shape.
--   Now an AFTER INSERT statement trigger, sales_entries_stamp_pos_source(), marks the bill (from its
--   pos / pos_comp rows) and the credit note (from its pos_credit reversal rows only, which is what
--   the note's mark has always meant) in the same transaction as the rows: either both land or
--   neither does. The till's and Periods' own mark writes stay and are harmless
--   (guard_pos_order_close and guard_pos_credit_note keep the first mark, S809 1c); they are still
--   what marks a bill with nothing to post (no recipe line) and a note that reverses nothing (a
--   Complimentary bill's), which write no row.
--   The trigger also makes the link it rests on dependable for till sale rows (pos, pos_comp),
--   for every login, outside the operator's restore:
--     * a till sale row names its bill, and that bill is a closed (billed) bill of the outlet whose
--       month the row is filed in (HINT pos_sale_unlinked). Every writer sends it today.
--     * a bill's till sale rows arrive in ONE statement: rows for a bill that already has till sale
--       rows from an earlier statement are refused (HINT pos_bill_already_posted). That closes the
--       double post the review recorded under "Considered and not filed": a till post that outlived
--       its wait landing after Periods had posted the same bill, or two Periods posts at once. The
--       bill row is locked FOR NO KEY UPDATE before the look, so two posts of one bill queue, and
--       the second one's look (a new statement, so a new snapshot under READ COMMITTED) sees the rows
--       the first committed.
--   The operator's restore (restoreClientData re-inserts history in chunks of 500 rows, dated when
--   each row was first written; no screen sends created_at) is recognised as the operator inserting
--   rows all dated before this transaction, as guard_pos_credit_note and pos_shifts_guard do since
--   S809 1l. It meets neither refusal, because a chunk can split one bill's rows and old rows predate
--   the link (20260818170000); its bills are still marked.
--   A one-time repair (section 3) marks every bill or note that already has rows and no mark.
--
--   IMS-HANDOFF-3 (P2). items carries RESTRICTIVE no_pos_pin_staff (20260708130000, which listed
--   items as having "no POS code path"), so a POS PIN login, which is every staff login at a till,
--   reads it as empty, with no error. The till reads items for two things: each ingredient's yield %
--   when it writes a closing bill's stock lines (explodeRecipeTree's items embed, loadDeltaExplosion's
--   yield read), and each ingredient's rate when it values a comp (computeRecipeCosts). So a bill
--   closed on a PIN took 4.00 kg of chicken off the ledger where an 85% yield needs 4.71 kg, and a
--   comp was valued at the dish's typed Cost Price (usually NPR 0) on the Pay and Complimentary tabs,
--   on the printed Complimentary Slip and in the frozen Z-report. The Owner closing the same bill got
--   the right figures. New: pos_recipe_book(p_client_id, p_recipe_ids, p_item_ids), SECURITY
--   DEFINER, returns the part of the outlet's recipe book those recipes reach (each recipe's
--   yield_qty and cost_price, its ingredient rows, its sub-recipes to any depth, and each
--   ingredient's yield_pct and per_uom_rate), plus the loose items named (a customized dish's choice
--   lines): only quantities and costs, no names, suppliers or stock. The till hands it to the ONE
--   recipe walk (recipeCost.js' explodeRecipeTree / computeRecipeCosts with { book }, S793), so no
--   third cost walk is written in SQL (recipes-and-subrecipes.md: "there must never be a third").
--   It answers the operator for any outlet, and otherwise only a POS Supervisor or above, or the
--   Owner, of the outlet it is asked about (every condition COALESCE'd).
--
-- No live function body is replaced: every object below is new. Section 0 refuses to run if a name
-- is already taken by another signature. The live bodies this file relies on, and does not change
-- (2c owns guard_pos_order_close, 2e owns guard_pos_credit_note and the sales_entries source CHECK):
--   guard_pos_order_close()     5a50b8bc5ea06f2102e6440e16173e1d  keeps the first ims_posted_at; lets
--                                                                  a DEFINER body through (current_user)
--   guard_pos_credit_note()     698df246f07fb00a23a1dda876aff6f8  the same for a note
--   ims_sales_entries_guard()   b33d9b1e7ea6ccae944d602d5f6e2fe6  who may insert pos / pos_comp / pos_credit
--   pos_caller_has_rank(text)   7d34792c8f392e49bc47274d1e8045ce
--   my_client_id()              e1dbe771403bcf13601c323b74d0c07b
-- The probe tests the behaviour this relies on (the kept mark, the DEFINER pass-through), not the
-- hashes, so a 2c or 2e body that keeps those rules does not stop this file.
--
-- Live before this migration (2026-10-09, every client):
--   * pos_orders 0 rows and pos_credit_notes 0 (the owner cleared BLOOM CAFE; no other client has
--     bills). sales_entries 1,829 rows, all manual: 0 pos, 0 pos_comp, 0 pos_credit, 0 with
--     pos_order_id or pos_credit_note_id, 0 with a NULL created_at. So the repair marks 0 bills and
--     0 notes, and no stored row breaks a new rule.
--   * items: 38 below 100% yield (CASA ACAI CAFE, which has no POS).
--   * sales_entries triggers: ims_closed_period_guard and ims_rank_guard (both BEFORE ROW); indexes
--     idx_sales_entries_pos_order and idx_sales_entries_pos_credit_note_id serve the new trigger.
--
-- The probe at the end runs as BLOOM CAFE's POS PIN supervisor, its Owner and the operator, brings
-- every row it needs (a month, items with a trim loss, a recipe with a sub-recipe, a shift, bills, a
-- comp, a credit note) and rolls itself back. If any check fails, the whole migration fails and
-- nothing lands. Drafted against a local Postgres 17 copy of these tables, policies, grants,
-- triggers and live function bodies (read 2026-10-09): the file runs clean, and again over itself.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the two names are free, or hold only this file's own signature ──────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc
              WHERE pronamespace = 'public'::regnamespace AND proname = 'pos_recipe_book'
                AND oid <> to_regprocedure('public.pos_recipe_book(uuid,uuid[],uuid[])'))
     OR EXISTS (SELECT 1 FROM pg_proc
                 WHERE pronamespace = 'public'::regnamespace AND proname = 'sales_entries_stamp_pos_source'
                   AND oid <> to_regprocedure('public.sales_entries_stamp_pos_source()')) THEN
    RAISE EXCEPTION 'S809 2f: pos_recipe_book or sales_entries_stamp_pos_source already exists with another signature';
  END IF;
END;
$$;


-- ── 1. IMS-HANDOFF-2: the mark lands with the rows ──────────────────────────────────────────
--
-- SECURITY DEFINER so the mark is the database's fact, not the inserting login's privilege: a POS
-- supervisor, the Owner, the operator and a future server-side post all mark alike, and the two
-- guards above let a DEFINER body through by current_user. Every read and write here names the
-- outlet explicitly (the bill's client must be the client of the month the row is filed in), so
-- bypassing RLS cannot reach another outlet's bill or note. The bill's UPDATE still meets
-- pos_till_build_gate (a statement trigger on pos_orders keyed on the browser's JWT, not on
-- current_user): with a build floor set, a page too old to write bills cannot post them either, and
-- rows and mark are refused together rather than the rows landing without their mark.
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
REVOKE ALL ON FUNCTION public.sales_entries_stamp_pos_source() FROM PUBLIC;

DROP TRIGGER IF EXISTS sales_entries_stamp_pos_source ON public.sales_entries;
CREATE TRIGGER sales_entries_stamp_pos_source
  AFTER INSERT ON public.sales_entries
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.sales_entries_stamp_pos_source();


-- ── 2. IMS-HANDOFF-3: the till's read of the recipe book ─────────────────────────────────────
--
-- The shape is RECIPE_BOOK_SELECT's (recipeCost.js) without the names: recipes [{ id, yield_qty,
-- cost_price, recipe_ingredients: [{ id, recipe_id, qty_per_portion, item_id, sub_recipe_id,
-- items: { yield_pct, per_uom_rate } | null }] }], plus items [{ id, yield_pct, per_uom_rate }] for
-- the loose item ids. Ingredient rows in id order, as the walk reads them. A sub-recipe or item of
-- another outlet is left out, as RLS leaves it out for the Owner, so the walk treats both alike.
-- One jsonb value, not a set of rows, so PostgREST's row cap cannot cut a large book short.
CREATE OR REPLACE FUNCTION public.pos_recipe_book(p_client_id uuid, p_recipe_ids uuid[], p_item_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT COALESCE(public.is_admin()
                  OR (p_client_id = public.my_client_id() AND public.pos_caller_has_rank('supervisor')), false) THEN
    RAISE EXCEPTION 'pos_recipe_book: the till''s food costs and stock lines are read by a POS Supervisor or above at this outlet'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  WITH RECURSIVE reach(id) AS (
    SELECT r.id
      FROM recipes r
     WHERE r.client_id = p_client_id
       AND r.id = ANY (COALESCE(p_recipe_ids, '{}'::uuid[]))
    UNION   -- not UNION ALL: a recipe reached twice is listed once, and a cycle ends
    SELECT s.id
      FROM reach x
      JOIN recipe_ingredients ri ON ri.recipe_id = x.id AND ri.sub_recipe_id IS NOT NULL
      JOIN recipes s ON s.id = ri.sub_recipe_id AND s.client_id = p_client_id
  )
  SELECT jsonb_build_object(
    'recipes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id,
               'yield_qty', r.yield_qty,
               'cost_price', r.cost_price,
               'recipe_ingredients', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', ri.id,
                          'recipe_id', ri.recipe_id,
                          'qty_per_portion', ri.qty_per_portion,
                          'item_id', ri.item_id,
                          'sub_recipe_id', ri.sub_recipe_id,
                          'items', CASE WHEN i.id IS NULL THEN NULL
                                        ELSE jsonb_build_object('yield_pct', i.yield_pct, 'per_uom_rate', i.per_uom_rate) END)
                        ORDER BY ri.id)
                   FROM recipe_ingredients ri
                   LEFT JOIN items i ON i.id = ri.item_id AND i.client_id = p_client_id
                  WHERE ri.recipe_id = r.id), '[]'::jsonb))
             ORDER BY r.id)
        FROM recipes r
       WHERE r.id IN (SELECT id FROM reach)), '[]'::jsonb),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', i.id, 'yield_pct', i.yield_pct, 'per_uom_rate', i.per_uom_rate)
                       ORDER BY i.id)
        FROM items i
       WHERE i.client_id = p_client_id
         AND i.id = ANY (COALESCE(p_item_ids, '{}'::uuid[]))), '[]'::jsonb))
    INTO v_out;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.pos_recipe_book(uuid, uuid[], uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_recipe_book(uuid, uuid[], uuid[]) TO authenticated;


-- ── 3. The one-time repair: bills and notes whose rows landed and whose mark did not ──────────
--
-- A pg_temp function so the probe below runs the very same statements again over a fixture. Run as
-- the migration's role, so the guards let it through (current_user). Live 2026-10-09: 0 and 0.
CREATE FUNCTION pg_temp.s809_2f_mark_posted(OUT bills integer, OUT notes integer)
LANGUAGE plpgsql
AS $function$
BEGIN
  UPDATE public.pos_orders o
     SET ims_posted_at = x.first_at
    FROM (SELECT s.pos_order_id, p.client_id, LEAST(now(), COALESCE(min(s.created_at), now())) AS first_at
            FROM public.sales_entries s
            JOIN public.monthly_periods p ON p.id = s.period_id
           WHERE s.source IN ('pos', 'pos_comp') AND s.pos_order_id IS NOT NULL
           GROUP BY s.pos_order_id, p.client_id) x
   WHERE o.id = x.pos_order_id
     AND o.client_id = x.client_id
     AND o.status = 'billed'
     AND o.ims_posted_at IS NULL;
  GET DIAGNOSTICS bills = ROW_COUNT;

  UPDATE public.pos_credit_notes c
     SET ims_posted_at = x.first_at
    FROM (SELECT s.pos_credit_note_id, p.client_id, LEAST(now(), COALESCE(min(s.created_at), now())) AS first_at
            FROM public.sales_entries s
            JOIN public.monthly_periods p ON p.id = s.period_id
           WHERE s.pos_credit_note_id IS NOT NULL AND s.source IN ('pos_credit', 'pos_credit_restock')
           GROUP BY s.pos_credit_note_id, p.client_id) x
   WHERE c.id = x.pos_credit_note_id
     AND c.client_id = x.client_id
     AND c.ims_posted_at IS NULL;
  GET DIAGNOSTICS notes = ROW_COUNT;
END;
$function$;

DO $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM pg_temp.s809_2f_mark_posted();
  RAISE NOTICE 'S809 2f repair: % bill(s) and % credit note(s) marked posted to Inventory', r.bills, r.notes;
END;
$$;


-- ── 4. Prove it ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_c        uuid;    -- BLOOM CAFE
  v_c2       uuid;    -- BLOOM CAFE - PKR, standing in as "another outlet"
  v_pin      uuid;    -- a POS PIN login of BLOOM CAFE, made a plain POS supervisor
  v_owner    uuid;
  v_admin    uuid;
  v_p        uuid;    -- an open month of BLOOM CAFE (the probe's own when there is none)
  v_s        uuid;    -- the probe's open shift
  v_chicken  uuid;    -- items of BLOOM CAFE: chicken at 85% yield, onion at 50%, tomato, cheese at 80%
  v_onion    uuid;
  v_tomato   uuid;
  v_cheese   uuid;
  v_i_other  uuid;    -- an item of the other outlet
  v_momo     uuid;    -- 100 g chicken + 20 g of the sauce
  v_sauce    uuid;    -- a sub-recipe: 1,000 g from 800 g tomato + 100 g onion
  v_coke     uuid;    -- no ingredients, Cost Price NPR 40
  v_r_other  uuid;    -- a recipe of the other outlet
  v_o1       uuid;    -- 2 × Momo NPR 250 + 1 × Coke comped, charged NPR 500
  v_o2       uuid;    -- 1 × Momo, NPR 250
  v_o3       uuid;    -- 1 × Coke, NPR 100
  v_o_open   uuid;    -- stays open
  v_o_other  uuid;    -- a billed bill of the other outlet
  v_o_rest   uuid;    -- a bill the operator restores
  v_note     uuid;
  v_x        uuid;
  v_y        uuid;
  v_book     jsonb;
  v_ids      uuid[];
  v_n        integer;
  v_m        integer;
  v_num      numeric;
  v_num2     numeric;
  v_ts       timestamptz;
  v_hint     text;
  v_msg      text;
  v_txt      text;
  r          record;
  v_past     timestamptz := now() - interval '40 days';
BEGIN
  -- ── Catalog. Asserted on catalog columns, never on formatted text ─────────────────────────
  -- tgtype 4 = AFTER, FOR EACH STATEMENT, INSERT; the transition table is named new_rows.
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgrelid = 'public.sales_entries'::regclass AND tgname = 'sales_entries_stamp_pos_source'
     AND NOT tgisinternal AND tgenabled = 'O' AND tgtype = 4 AND tgnewtable = 'new_rows'
     AND tgfoid = 'public.sales_entries_stamp_pos_source()'::regprocedure;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'S809 2f: sales_entries_stamp_pos_source is not an enabled AFTER INSERT statement trigger with new_rows';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN ('public.sales_entries_stamp_pos_source()'::regprocedure, 'public.pos_recipe_book(uuid,uuid[],uuid[])'::regprocedure)
     AND prosecdef AND proconfig = ARRAY['search_path=public'];
  IF v_n <> 2 OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.pos_recipe_book(uuid,uuid[],uuid[])'::regprocedure) <> 's' THEN
    RAISE EXCEPTION 'S809 2f: a new function is not SECURITY DEFINER with search_path public, or pos_recipe_book is not STABLE';
  END IF;
  -- pos_recipe_book: EXECUTE for authenticated and nobody else but its owner (no PUBLIC, no anon);
  -- the trigger function: nobody but its owner.
  SELECT array_agg(a.grantee::regrole::text ORDER BY a.grantee::regrole::text) INTO v_txt
    FROM pg_proc p, aclexplode(p.proacl) a
   WHERE p.oid = 'public.pos_recipe_book(uuid,uuid[],uuid[])'::regprocedure AND a.grantee <> p.proowner;
  IF v_txt IS DISTINCT FROM '{authenticated}'
     OR has_function_privilege('anon', 'public.pos_recipe_book(uuid,uuid[],uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pos_recipe_book(uuid,uuid[],uuid[])', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.oid = 'public.sales_entries_stamp_pos_source()'::regprocedure AND a.grantee <> p.proowner)
     OR (SELECT proacl IS NULL FROM pg_proc WHERE oid = 'public.sales_entries_stamp_pos_source()'::regprocedure) THEN
    RAISE EXCEPTION 'S809 2f: the grants are not EXECUTE to authenticated only (pos_recipe_book: %)', v_txt;
  END IF;

  -- ── The logins: BLOOM CAFE's POS PIN login (its supervisor where there is one), its Owner, the
  -- operator; BLOOM CAFE - PKR as another outlet ─────────────────────────────────────────────
  SELECT id INTO v_c  FROM public.clients WHERE name = 'BLOOM CAFE';
  SELECT id INTO v_c2 FROM public.clients WHERE name = 'BLOOM CAFE - PKR';
  SELECT p.id INTO v_pin
    FROM public.profiles p
   WHERE p.role = 'client' AND COALESCE(p.active_client_id, p.client_id) = v_c AND p.pos_email IS NOT NULL
   ORDER BY (p.pos_role = 'supervisor') DESC NULLS LAST, p.id
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
  IF v_c IS NULL OR v_c2 IS NULL OR v_pin IS NULL OR v_owner IS NULL OR v_admin IS NULL THEN
    RAISE EXCEPTION 'S809 2f probe: needs BLOOM CAFE, BLOOM CAFE - PKR, a POS PIN login and the Owner of BLOOM CAFE, and the operator (got %, %, %, %, %)',
      v_c, v_c2, v_pin, v_owner, v_admin;
  END IF;

  BEGIN
    -- Slice 1b's build gate (if a floor is set when this runs) reads this header.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999999"}', true);

    -- ── Setup, as the migration's own role. BLOOM CAFE's data was cleared on 2026-10-09, so the
    -- probe brings everything: a month, items, recipes, a shift, bills. Rolled back below. ───────
    -- The stand-in loses every other staff marker, or a restrictive policy would turn an "allowed"
    -- into a vacuous 0 rows (the S792 lesson).
    UPDATE public.profiles
       SET pos_role = 'supervisor', pos_allow_void = false, pos_discount_limit = NULL,
           settlement_blocked_by = NULL, ims_role = NULL, hr_role = NULL, hr_self_service = false
     WHERE id = v_pin;

    SELECT id INTO v_p FROM public.monthly_periods WHERE client_id = v_c AND status = 'open';
    IF v_p IS NULL THEN
      INSERT INTO public.monthly_periods (client_id, bs_year, bs_month, status)
        VALUES (v_c, 2099, 12, 'open') RETURNING id INTO v_p;
    END IF;

    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_c, 'S809 2f probe chicken', 'GM', 1, 0.5, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_c, 'S809 2f probe onion', 'GM', 1, 0.1, 50) RETURNING id INTO v_onion;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_c, 'S809 2f probe tomato', 'GM', 1, 0.2, 100) RETURNING id INTO v_tomato;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_c, 'S809 2f probe cheese', 'GM', 1, 2, 80) RETURNING id INTO v_cheese;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_c2, 'S809 2f probe other', 'GM', 1, 9, 70) RETURNING id INTO v_i_other;

    INSERT INTO public.recipes (client_id, name, category, selling_price, yield_qty, cost_price)
      VALUES (v_c, 'S809 2f probe sauce', 'Sub-Recipe', NULL, 1000, NULL) RETURNING id INTO v_sauce;
    INSERT INTO public.recipes (client_id, name, category, selling_price, yield_qty, cost_price)
      VALUES (v_c, 'S809 2f probe momo', 'Food', 250, 1, 0) RETURNING id INTO v_momo;
    INSERT INTO public.recipes (client_id, name, category, selling_price, yield_qty, cost_price)
      VALUES (v_c, 'S809 2f probe coke', 'Beverage', 100, 1, 40) RETURNING id INTO v_coke;
    INSERT INTO public.recipes (client_id, name, category, selling_price, yield_qty, cost_price)
      VALUES (v_c2, 'S809 2f probe other', 'Food', 300, 1, 0) RETURNING id INTO v_r_other;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, sub_recipe_id, qty_per_portion)
      VALUES (v_momo, v_chicken, NULL, 100), (v_momo, NULL, v_sauce, 20),
             (v_sauce, v_tomato, NULL, 800), (v_sauce, v_onion, NULL, 100),
             (v_r_other, v_i_other, NULL, 50);

    -- One open shift per outlet: the outlet's own is closed for the length of the probe.
    UPDATE public.pos_shifts SET status = 'closed', closed_at = now() WHERE client_id = v_c AND status = 'open';
    INSERT INTO public.pos_shifts (client_id, status, label, opening_cash, opening_denominations)
      VALUES (v_c, 'open', 'S809 2f probe', 0, '{}') RETURNING id INTO v_s;

    -- Takeaway orders. order_no is given, so the probe takes no lock on the outlet's real series.
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2f probe', 990601) RETURNING id INTO v_o1;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2f probe', 990602) RETURNING id INTO v_o2;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2f probe', 990603) RETURNING id INTO v_o3;
    INSERT INTO public.pos_orders (client_id, status, table_name, order_no) VALUES (v_c, 'open', 'S809 2f probe', 990604) RETURNING id INTO v_o_open;
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate)
      VALUES (v_o1, v_c, v_momo, 'S809 2f probe momo', 2, 250, 0),
             (v_o2, v_c, v_momo, 'S809 2f probe momo', 1, 250, 0),
             (v_o3, v_c, v_coke, 'S809 2f probe coke', 1, 100, 0),
             (v_o_open, v_c, v_momo, 'S809 2f probe momo', 1, 250, 0);
    INSERT INTO public.pos_order_items (order_id, client_id, recipe_id, name, qty, unit_price, vat_rate, comped, comp_reason, comp_no, comp_fy)
      VALUES (v_o1, v_c, v_coke, 'S809 2f probe coke', 1, 100, 0, true, 'probe', 990, 'S809-2f');
    -- A billed bill of the other outlet.
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c2, 'billed', 'paid', 'Cash', 300, 'S809 2f probe other', 990605, now()) RETURNING id INTO v_o_other;

    -- ══ As the POS PIN supervisor ════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pin, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)
       OR NOT public.pos_caller_has_rank('supervisor') OR public.pos_caller_has_rank('manager')
       OR NOT COALESCE(public.is_pos_pin_staff(), false) THEN
      RAISE EXCEPTION 'S809 2f probe: the stand-in % is not a plain POS PIN supervisor', v_pin;
    END IF;

    -- ── (a) IMS-HANDOFF-3: what the till could not see. items is fenced from a PIN login (no
    -- error, no rows), while the recipes and their ingredient rows are not. ───────────────────
    SELECT count(*) INTO v_n FROM public.items WHERE id IN (v_chicken, v_onion, v_tomato, v_cheese);
    SELECT count(*) INTO v_m FROM public.recipe_ingredients WHERE recipe_id IN (v_momo, v_sauce);
    IF v_n <> 0 OR v_m <> 4 THEN
      RAISE EXCEPTION 'S809 2f probe: expected a PIN login to see 0 items and 4 ingredient rows, saw % and %', v_n, v_m;
    END IF;

    -- ── (b) The till's read: the momo, its sauce (reached through it) and the coke; not the other
    -- outlet's recipe even when asked; each ingredient's yield and rate; the loose item asked for. ─
    v_book := public.pos_recipe_book(v_c, ARRAY[v_momo, v_coke, v_r_other, NULL], ARRAY[v_cheese, v_i_other]);
    SELECT array_agg((x ->> 'id')::uuid ORDER BY (x ->> 'id')::uuid) INTO v_ids FROM jsonb_array_elements(v_book -> 'recipes') x;
    IF v_ids IS DISTINCT FROM (SELECT array_agg(y ORDER BY y) FROM unnest(ARRAY[v_momo, v_sauce, v_coke]) y) THEN
      RAISE EXCEPTION 'S809 2f probe: the book for the momo and the coke held recipes %', v_ids;
    END IF;
    SELECT (i -> 'items' ->> 'yield_pct')::numeric, (i -> 'items' ->> 'per_uom_rate')::numeric
      INTO v_num, v_num2
      FROM jsonb_array_elements(v_book -> 'recipes') x, jsonb_array_elements(x -> 'recipe_ingredients') i
     WHERE (x ->> 'id')::uuid = v_momo AND (i ->> 'item_id')::uuid = v_chicken;
    IF v_num IS DISTINCT FROM 85 OR v_num2 IS DISTINCT FROM 0.5 THEN
      RAISE EXCEPTION 'S809 2f probe: the momo''s chicken line came back at yield % and rate % (want 85 and 0.5)', v_num, v_num2;
    END IF;
    SELECT count(*) INTO v_n
      FROM jsonb_array_elements(v_book -> 'recipes') x, jsonb_array_elements(x -> 'recipe_ingredients') i
     WHERE (x ->> 'id')::uuid = v_momo AND (i ->> 'sub_recipe_id')::uuid = v_sauce
       AND jsonb_typeof(i -> 'items') = 'null' AND (i ->> 'qty_per_portion')::numeric = 20;
    SELECT (x ->> 'yield_qty')::numeric INTO v_num FROM jsonb_array_elements(v_book -> 'recipes') x WHERE (x ->> 'id')::uuid = v_sauce;
    SELECT (x ->> 'cost_price')::numeric INTO v_num2 FROM jsonb_array_elements(v_book -> 'recipes') x WHERE (x ->> 'id')::uuid = v_coke;
    IF v_n <> 1 OR v_num IS DISTINCT FROM 1000 OR v_num2 IS DISTINCT FROM 40 THEN
      RAISE EXCEPTION 'S809 2f probe: the sauce line (%), the sauce''s yield (%) or the coke''s Cost Price (%) came back wrong', v_n, v_num, v_num2;
    END IF;
    SELECT count(*), max((x ->> 'yield_pct')::numeric) INTO v_n, v_num
      FROM jsonb_array_elements(v_book -> 'items') x WHERE (x ->> 'id')::uuid = v_cheese;
    IF v_n <> 1 OR v_num IS DISTINCT FROM 80 OR jsonb_array_length(v_book -> 'items') <> 1 THEN
      RAISE EXCEPTION 'S809 2f probe: the loose items came back as %', v_book -> 'items';
    END IF;
    -- Nothing asked for, nothing back (the till asks with empty lists when a bill has no dish).
    IF public.pos_recipe_book(v_c, '{}', '{}') IS DISTINCT FROM '{"items": [], "recipes": []}'::jsonb THEN
      RAISE EXCEPTION 'S809 2f probe: an empty ask did not come back empty';
    END IF;

    -- ── (c) Not for another outlet ────────────────────────────────────────────────────────────
    BEGIN
      PERFORM public.pos_recipe_book(v_c2, ARRAY[v_r_other], ARRAY[v_i_other]);
      RAISE EXCEPTION 'S809 2f probe: a PIN supervisor read another outlet''s book';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 2f probe: another outlet''s book — expected rank_required, got: %', v_msg;
      END IF;
    END;

    -- ── (d) Not below Supervisor (a Staff-rank PIN login cannot open the Payment window either) ─
    RESET ROLE;
    UPDATE public.profiles SET pos_role = 'staff' WHERE id = v_pin;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.pos_recipe_book(v_c, ARRAY[v_momo], '{}');
      RAISE EXCEPTION 'S809 2f probe: a Staff-rank PIN login read the book';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'rank_required' THEN
        RAISE EXCEPTION 'S809 2f probe: a Staff-rank read — expected rank_required, got: %', v_msg;
      END IF;
    END;
    RESET ROLE;
    UPDATE public.profiles SET pos_role = 'supervisor' WHERE id = v_pin;
    SET LOCAL ROLE authenticated;

    -- ── (e) IMS-HANDOFF-2: the supervisor closes three bills ─────────────────────────────────
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 500 WHERE id = v_o1;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 250 WHERE id = v_o2;
    UPDATE public.pos_orders SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 100 WHERE id = v_o3;
    SELECT count(*) INTO v_n FROM public.pos_orders WHERE id IN (v_o1, v_o2, v_o3) AND status = 'billed' AND ims_posted_at IS NULL;
    IF v_n <> 3 THEN
      RAISE EXCEPTION 'S809 2f probe: the three closes did not leave three unposted bills (%)', v_n;
    END IF;

    -- (f) The till posts bill 1 as writeSalesEntries does: one statement, a sale and a comp. The mark
    -- is on the bill when the insert returns, in the same transaction.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_p, v_momo, 1, 2, 'pos', 250, 0, v_o1),
             (v_p, v_coke, 1, 1, 'pos_comp', 100, 0, v_o1);
    SELECT ims_posted_at INTO v_ts FROM public.pos_orders WHERE id = v_o1;
    IF v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 2f probe: bill 1 was marked % after its rows landed (want now())', v_ts;
    END IF;

    -- (g) A till on crest-v416..v419 still sends its own mark after the post, from the tablet's
    -- clock. It is not refused, and the first mark stands.
    UPDATE public.pos_orders SET ims_posted_at = '2020-01-01 00:00:00+00' WHERE id = v_o1 RETURNING ims_posted_at INTO v_ts;
    IF NOT FOUND OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 2f probe: the old till''s mark write was refused or replaced the mark (%)', v_ts;
    END IF;

    -- (h) The same bill posted again (a late post landing after Periods posted it) is refused.
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
        VALUES (v_p, v_momo, 1, 2, 'pos', 250, 0, v_o1);
      RAISE EXCEPTION 'S809 2f probe: bill 1 was posted to Inventory a second time';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_bill_already_posted' THEN
        RAISE EXCEPTION 'S809 2f probe: a second post — expected pos_bill_already_posted, got: %', v_msg;
      END IF;
    END;

    -- (i) A till sale that names no bill, an open order, or another outlet's bill is refused. The
    -- last one mixes bill 2 into the same statement: refused whole, and bill 2 stays unmarked.
    FOR v_txt, v_x, v_y IN
      SELECT * FROM (VALUES ('no bill', NULL::uuid, NULL::uuid),
                            ('an open order', v_o_open, NULL::uuid),
                            ('another outlet''s bill', v_o_other, NULL::uuid),
                            ('no bill beside bill 2', NULL::uuid, v_o2)) AS t(what, a, b)
    LOOP
      BEGIN
        INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
          SELECT v_p, v_momo, 1, 1, 'pos', 250, 0, v_x
          UNION ALL
          SELECT v_p, v_momo, 1, 1, 'pos', 250, 0, v_y WHERE v_y IS NOT NULL;
        RAISE EXCEPTION 'S809 2f probe: a till sale naming % was recorded', v_txt;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
        IF v_hint IS DISTINCT FROM 'pos_sale_unlinked' THEN
          RAISE EXCEPTION 'S809 2f probe: a till sale naming % — expected pos_sale_unlinked, got: %', v_txt, v_msg;
        END IF;
      END;
    END LOOP;
    SELECT count(*) INTO v_n FROM public.sales_entries WHERE pos_order_id IN (v_o2, v_o_open, v_o_other) OR (period_id = v_p AND pos_order_id IS NULL AND source = 'pos');
    SELECT count(*) INTO v_m FROM public.pos_orders WHERE id = v_o2 AND ims_posted_at IS NULL;
    IF v_n <> 0 OR v_m <> 1 THEN
      RAISE EXCEPTION 'S809 2f probe: a refused post left % row(s) behind, or bill 2 was marked (% unmarked)', v_n, v_m;
    END IF;

    -- ══ As the Owner ═════════════════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_client_owner(), false) THEN
      RAISE EXCEPTION 'S809 2f probe: % is not an Owner login', v_owner;
    END IF;

    -- (j) A hand-entered sale is untouched by any of this.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, unit_price, vat_rate)
      VALUES (v_p, v_momo, 2, 3, 250, 0);

    -- (k) Periods → Post POS bills to Inventory: two bills in one statement, both marked.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_p, v_momo, 1, 1, 'pos', 250, 0, v_o2),
             (v_p, v_coke, 1, 1, 'pos', 100, 0, v_o3);
    SELECT count(*) INTO v_n FROM public.pos_orders WHERE id IN (v_o2, v_o3) AND ims_posted_at = now();
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'S809 2f probe: a two-bill post marked % of them', v_n;
    END IF;

    -- (l) The Owner reads the book too.
    IF jsonb_array_length(public.pos_recipe_book(v_c, ARRAY[v_momo], '{}') -> 'recipes') <> 2 THEN
      RAISE EXCEPTION 'S809 2f probe: the Owner''s book for the momo is not the momo and its sauce';
    END IF;

    -- (m) A Credit Note on bill 1 and its reversal: the note is marked with its rows, and the old
    -- till's own mark write afterwards is not refused and does not move it.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
                                         original_invoice_date_bs, reason, refund_method, gross_amount, discount_amount,
                                         taxable_amount, non_taxable_amount, vat_amount, net_amount)
      VALUES (v_c, v_o1, '83/84', 1, 'S809 2f probe', '23 Ashwin 2083', 'S809 2f probe', 'none', 500, 0, 0, 500, 0, 500)
      RETURNING id, ims_posted_at INTO v_note, v_ts;
    IF v_ts IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2f probe: a new Credit Note was born marked posted';
    END IF;
    -- A row naming the note that is not its reversal does not mark it.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, unit_price, vat_rate, pos_credit_note_id)
      VALUES (v_p, v_momo, 3, 1, 250, 0, v_note);
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_note) IS NOT NULL THEN
      RAISE EXCEPTION 'S809 2f probe: a hand-entered row naming the Credit Note marked it posted';
    END IF;
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
      VALUES (v_p, v_momo, 3, -2, 'pos_credit', 250, 0, v_note);
    UPDATE public.pos_credit_notes SET ims_posted_at = '2020-01-01 00:00:00+00' WHERE id = v_note RETURNING ims_posted_at INTO v_ts;
    IF NOT FOUND OR v_ts IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'S809 2f probe: the Credit Note was not marked with its reversal, or the old mark write moved it (%)', v_ts;
    END IF;

    -- ══ As the operator ══════════════════════════════════════════════════════════════════════
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    IF NOT COALESCE(public.is_admin(), false) THEN
      RAISE EXCEPTION 'S809 2f probe: % is not the operator', v_admin;
    END IF;

    -- (n) Any outlet's book.
    v_book := public.pos_recipe_book(v_c2, ARRAY[v_r_other], ARRAY[v_i_other]);
    IF jsonb_array_length(v_book -> 'recipes') <> 1 OR jsonb_array_length(v_book -> 'items') <> 1 THEN
      RAISE EXCEPTION 'S809 2f probe: the operator''s book for the other outlet is %', v_book;
    END IF;

    -- (o) The restore: a bill brought back with its rows in two chunks, plus an old row from before
    -- the link. All dated in the past, so none is refused, and the bill is marked when its rows were
    -- first written.
    INSERT INTO public.pos_orders (client_id, status, close_type, payment_method, paid_amount, table_name, order_no, closed_at)
      VALUES (v_c, 'billed', 'paid', 'Cash', 500, 'S809 2f restored', 990606, v_past) RETURNING id INTO v_o_rest;
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id, created_at)
      VALUES (v_p, v_momo, 4, 1, 'pos', 250, 0, v_o_rest, v_past);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id, created_at)
      VALUES (v_p, v_momo, 4, 1, 'pos', 250, 0, v_o_rest, v_past + interval '1 second'),
             (v_p, v_coke, 4, 1, 'pos', 100, 0, NULL, v_past);
    SELECT ims_posted_at INTO v_ts FROM public.pos_orders WHERE id = v_o_rest;
    IF v_ts IS DISTINCT FROM v_past THEN
      RAISE EXCEPTION 'S809 2f probe: the restored bill was marked % (want %)', v_ts, v_past;
    END IF;

    -- (p) Outside a restore the operator meets the same rule: no second post of a bill.
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
        VALUES (v_p, v_momo, 4, 1, 'pos', 250, 0, v_o_rest);
      RAISE EXCEPTION 'S809 2f probe: the operator posted a bill a second time';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      IF v_hint IS DISTINCT FROM 'pos_bill_already_posted' THEN
        RAISE EXCEPTION 'S809 2f probe: the operator''s second post — expected pos_bill_already_posted, got: %', v_msg;
      END IF;
    END;

    -- ══ The repair, as the migration's role ══════════════════════════════════════════════════
    -- (q) A bill and a note whose rows are in and whose mark is not (the state before this file):
    -- the repair marks exactly those two, at the moment their rows were written, and then nothing.
    RESET ROLE;
    UPDATE public.pos_orders SET ims_posted_at = NULL WHERE id = v_o2;
    UPDATE public.pos_credit_notes SET ims_posted_at = NULL WHERE id = v_note;
    SELECT * INTO r FROM pg_temp.s809_2f_mark_posted();
    IF r.bills <> 1 OR r.notes <> 1 THEN
      RAISE EXCEPTION 'S809 2f probe: the repair marked % bill(s) and % note(s) (want 1 and 1)', r.bills, r.notes;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_orders WHERE id = v_o2 AND ims_posted_at = now();
    SELECT count(*) INTO v_m FROM public.pos_credit_notes WHERE id = v_note AND ims_posted_at = now();
    IF v_n <> 1 OR v_m <> 1 THEN
      RAISE EXCEPTION 'S809 2f probe: the repair''s marks are not the rows'' own moment';
    END IF;
    SELECT * INTO r FROM pg_temp.s809_2f_mark_posted();
    IF r.bills <> 0 OR r.notes <> 0 THEN
      RAISE EXCEPTION 'S809 2f probe: the repair run again marked % and %', r.bills, r.notes;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's809_2f_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's809_2f_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;

DROP FUNCTION pg_temp.s809_2f_mark_posted();

NOTIFY pgrst, 'reload schema';

-- Read back after applying (one statement per call):
--   SELECT proname, md5(prosrc), prosecdef, provolatile, proconfig, proacl FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace AND proname IN ('pos_recipe_book', 'sales_entries_stamp_pos_source');
--     expect pos_recipe_book 179bb1a754740f83078f8f480a283cc4, sales_entries_stamp_pos_source
--     bdcb42ee81b48cc6c76dc4310c6a31ea (this file as written, LF; the restock source added at integration); both prosecdef true and proconfig
--     {search_path=public}; pos_recipe_book 's' and {postgres=X/postgres,authenticated=X/postgres};
--     sales_entries_stamp_pos_source {postgres=X/postgres}.
--   SELECT tgname, tgtype, tgenabled, tgnewtable FROM pg_trigger
--    WHERE tgrelid = 'public.sales_entries'::regclass AND NOT tgisinternal ORDER BY tgname;
--     expect ims_closed_period_guard 31, ims_rank_guard 31, sales_entries_stamp_pos_source 4 new_rows, all 'O'.
--   SELECT has_function_privilege('anon', 'public.pos_recipe_book(uuid,uuid[],uuid[])', 'EXECUTE');   -- false
--   SELECT count(*) FROM public.pos_orders o WHERE o.status = 'billed' AND o.ims_posted_at IS NULL
--      AND EXISTS (SELECT 1 FROM public.sales_entries s WHERE s.pos_order_id = o.id);                 -- 0
--   SELECT count(*) FROM public.pos_credit_notes n WHERE n.ims_posted_at IS NULL
--      AND EXISTS (SELECT 1 FROM public.sales_entries s WHERE s.pos_credit_note_id = n.id AND s.source IN ('pos_credit', 'pos_credit_restock'));   -- 0
--   SELECT count(*) FROM public.sales_entries WHERE source <> 'manual';   -- unchanged (0 on 2026-10-09)
--   SELECT count(*) FROM public.items WHERE name LIKE 'S809 2f probe%';   -- 0 (the probe rolled back)
