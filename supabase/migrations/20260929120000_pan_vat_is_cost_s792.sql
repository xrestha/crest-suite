-- S792 stage 4, owner decision D32: on a PAN-bill outlet, supplier VAT counts as food cost.
--
-- A PAN-bill outlet (settings.is_vat_registered = false) cannot claim input VAT back, so the 13% on a
-- VAT-ticked purchase line is part of what its food cost. Every purchase figure in IMS was ex-VAT, so
-- food cost read ~13% low on every VAT bill. Design: docs/ims-review-s792/STAGE4-DESIGN.md, D32.
-- Owner answers (2026-09-29): Q1 (a) backfill the OPEN month only; Q2 a later switch is followed by
-- new bills at save time; Q3 a Help line saying to confirm the treatment with an accountant.
--
-- 1. purchase_entries.vat_is_cost boolean NOT NULL DEFAULT false — the bill's cost basis, stored per
--    line (repeated on every line of a bill like discount_amount). Readers use the ROW, never the
--    live switch, so flipping the switch does not re-value history (D29). On a row with
--    vat_inclusive AND vat_is_cost the line's COST is its net × 1.13 (allocateBillDiscounts'
--    `lineCost` in supplierAttribution.js); tax reports, payables and bill totals are unchanged.
-- 2. Backfill (Q1 a): every line in a period whose status is 'open', for clients whose settings row
--    says is_vat_registered = false EXPLICITLY (NULL / no row bills WITH VAT — vatModeOf's rule).
--    Closed months and frozen Monthly Owner Reports keep the ex-VAT basis they were made on.
--    Triggers on purchase_entries and the UPDATE:
--      - ims_closed_period_guard: open months only, and the migration role passes its
--        current_user seam anyway (closed-periods.md);
--      - ims_rank_guard (UPDATE = IMS manager): the same current_user seam lets the migration role by;
--      - ims_item_same_client: item_id/period_id do not change;
--      - purchase_entries_guard_paid_delete: DELETE only;
--      - audit_purchase_entries (log_audit): DELIBERATELY left firing. It writes one audit row per
--        backfilled line with a NULL user — a true record that the migration changed the row.
-- 3. save_purchase_bill: stamps vat_is_cost. A NEW bill takes it from settings at save time
--    (is_vat_registered IS FALSE); an EDIT keeps the basis of the lines it replaces (read before the
--    delete, like po_id), so correcting an old bill never re-values its month. Signature unchanged,
--    so CREATE OR REPLACE keeps the grants and does not fork an overload.
-- 4. receive_purchase_order: the PO receipt is the other writer of purchase_entries; patched from its
--    LIVE body (the S753 technique) to stamp vat_is_cost from settings. Nothing else in it moves.
-- 5. get_group_pnl: purchases_val and returns_val on the cost basis — a purchase line × 1.13 when
--    vat_inclusive AND vat_is_cost (after its discount share, which is still apportioned over the
--    bill's ex-VAT gross), a return × 1.13 when the line it went back against is. Mirrors
--    periodCost.js by hand. Everything else in the body is 20260928160000's, unchanged.
--
-- ══ HOW TO REVERSE ═══════════════════════════════════════════════════════════════════════════════
--   a) Re-apply the previous bodies: save_purchase_bill from 20260918130000_ims_purchases_s756.sql,
--      receive_purchase_order from 20260928140000_ims_integrity_s792.sql (section 7), get_group_pnl
--      from 20260928160000_ims_group_figures_s792.sql — each a plain CREATE OR REPLACE of its own
--      section (signatures are unchanged here, so grants survive).
--   b) Then `ALTER TABLE public.purchase_entries DROP COLUMN vat_is_cost;` — the frontend reads the
--      column through `vat_is_cost === true`, so a select that names it will FAIL (42703) once it is
--      gone: revert the D32 frontend first, or drop the column last. Dropping the column is also the
--      way to undo the backfill; there is no other record of which rows it set (audit_logs has one
--      entry per row if needed).
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- ══ 0. The bodies this file replaces are still the ones it was written from ══════════════════════
-- md5(prosrc) of the bodies in the files named above. If either function changed out of band since,
-- this refuses rather than silently reverting that change (rebuild it from the live body).
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
   WHERE p.oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '9cd771c016863c840d4b507ad8f0495e' THEN
    RAISE EXCEPTION 'D32: save_purchase_bill changed since 20260918130000 (live md5 %) — rebuild this file''s body from the live one', v_md5;
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p
   WHERE p.oid = 'public.get_group_pnl(integer, integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '335fb87f8523fc5ca401aef95b610074' THEN
    RAISE EXCEPTION 'D32: get_group_pnl changed since 20260928160000 (live md5 %) — rebuild this file''s body from the live one', v_md5;
  END IF;
END;
$$;

-- ══ 1. The column ════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.purchase_entries
  ADD COLUMN IF NOT EXISTS vat_is_cost boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.purchase_entries.vat_is_cost IS
  'S792 D32: this bill was saved while the outlet was NOT VAT-registered (PAN bill), so the 13% VAT on a vat_inclusive line is food cost (line cost = net x 1.13). Set by save_purchase_bill / receive_purchase_order from settings.is_vat_registered at save time; an edit keeps the replaced lines'' value. Readers use this, never the live switch. Tax reports and payables ignore it.';

-- ══ 2. Backfill: the OPEN month of every explicitly PAN-bill client (Q1 a) ══════════════════════
UPDATE public.purchase_entries pe
   SET vat_is_cost = true
  FROM public.monthly_periods mp
 WHERE mp.id = pe.period_id
   AND mp.status = 'open'
   AND pe.vat_is_cost = false
   AND EXISTS (SELECT 1 FROM public.settings s
                WHERE s.client_id = mp.client_id
                  AND s.is_vat_registered IS FALSE);

-- ══ 3. save_purchase_bill ═══════════════════════════════════════════════════════════════════════
-- Body: 20260918130000, plus v_vat_is_cost (marked -- D32). SECURITY INVOKER as before: the settings
-- read runs under the caller's RLS, where settings_select lets every account of the client read its
-- own row. A row the caller cannot see reads as "not PAN" — the pre-D32 ex-VAT basis, never a guess
-- in the other direction.
CREATE OR REPLACE FUNCTION public.save_purchase_bill(p_period_id uuid, p_group_id uuid, p_lines jsonb, p_superseded_ids uuid[] DEFAULT NULL::uuid[], p_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted  integer := 0;
  v_expected integer := COALESCE(cardinality(p_superseded_ids), 0);
  v_created  timestamptz;
  v_po_id    uuid;
  v_vat_is_cost boolean;  -- D32
BEGIN
  IF p_period_id IS NULL THEN
    RAISE EXCEPTION 'p_period_id is required';
  END IF;
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'p_group_id is required';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty json array';
  END IF;

  IF v_expected > 0 THEN
    -- Said here, before any write, in the bill's own words — the trigger below would also refuse,
    -- but per row and after the insert had already been attempted.
    IF EXISTS (SELECT 1 FROM purchase_bill_payments(p_superseded_ids)) THEN
      RAISE EXCEPTION 'purchase_bill_has_payments: this bill has vendor payments recorded against it'
        USING ERRCODE = 'P0001',
              HINT = 'Remove the payments in Outstanding Payables first, then edit the bill.';
    END IF;

    -- S756 (D26): the replaced lines' ids are what every return points at, and the delete below
    -- would SET NULL them. An RLS-hidden return still blocks, which is the safe direction. Since D10
    -- that includes a return sitting in a LATER month than this bill — the check is by line id, not
    -- by period, so it already sees them.
    IF EXISTS (SELECT 1 FROM vendor_returns vr WHERE vr.purchase_entry_id = ANY (p_superseded_ids)) THEN
      RAISE EXCEPTION 'purchase_bill_has_returns: this bill has goods returned against it'
        USING ERRCODE = 'P0001',
              HINT = 'Remove the return on the Returns tab first, then edit the bill.';
    END IF;

    -- Read BEFORE the delete, or there is nothing left to read it from (S709). Not an aggregate:
    -- Postgres has no max() over uuid, and plpgsql only resolves the expression on first
    -- execution, so S709's form created fine and failed the first edit (S735).
    SELECT pe.po_id INTO v_po_id
      FROM purchase_entries pe
     WHERE pe.id = ANY (p_superseded_ids)
       AND pe.po_id IS NOT NULL
     LIMIT 1;

    -- D32: an edit keeps the cost basis the bill was saved on, so correcting a typo never re-values
    -- its month (D29). Read before the delete, like po_id. bool_or over boolean is fine (not uuid).
    SELECT bool_or(pe.vat_is_cost) INTO v_vat_is_cost
      FROM purchase_entries pe
     WHERE pe.id = ANY (p_superseded_ids);

    DELETE FROM purchase_entries WHERE id = ANY (p_superseded_ids);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> v_expected THEN
      RAISE EXCEPTION 'purchase_bill_stale: expected to replace % line(s), found %', v_expected, v_deleted
        USING ERRCODE = 'P0001',
              HINT = 'The bill changed since it was opened. Nothing was saved; reopen it from the list.';
    END IF;
  END IF;

  -- D32: a NEW bill follows the outlet's switch at save time. Only an explicit false is a PAN-bill
  -- outlet; NULL or no settings row bills WITH VAT (vatModeOf's rule, and the till's).
  IF v_vat_is_cost IS NULL THEN
    SELECT COALESCE(bool_or(s.is_vat_registered IS FALSE), false) INTO v_vat_is_cost
      FROM monthly_periods mp
      JOIN settings s ON s.client_id = mp.client_id
     WHERE mp.id = p_period_id;
    v_vat_is_cost := COALESCE(v_vat_is_cost, false);
  END IF;

  -- S756 (D13): the two invoice figures are NULLIF(…, '') and never COALESCEd — blank stays NULL
  -- ("not typed"), a typed 0 stays 0. A negative is refused by the CHECK constraints above.
  INSERT INTO purchase_entries
    (period_id, item_id, vendor_id, bs_day, qty, rate, invoice_ref, expiry_date,
     payment_method, vat_inclusive, discount_amount, purchase_group_id, created_at, po_id,
     invoice_vat_amount, invoice_total_amount, vat_is_cost)
  SELECT p_period_id,
         (l ->> 'item_id')::uuid,
         NULLIF(l ->> 'vendor_id', '')::uuid,
         (l ->> 'bs_day')::integer,
         (l ->> 'qty')::numeric,
         COALESCE(NULLIF(l ->> 'rate', '')::numeric, 0),
         NULLIF(l ->> 'invoice_ref', ''),
         NULLIF(l ->> 'expiry_date', '')::date,
         COALESCE(NULLIF(l ->> 'payment_method', ''), 'Cash'),
         COALESCE((l ->> 'vat_inclusive')::boolean, false),
         COALESCE(NULLIF(l ->> 'discount_amount', '')::numeric, 0),
         p_group_id,
         COALESCE(p_created_at, now()),
         v_po_id,
         NULLIF(l ->> 'invoice_vat_amount', '')::numeric,
         NULLIF(l ->> 'invoice_total_amount', '')::numeric,
         v_vat_is_cost
    FROM jsonb_array_elements(p_lines) AS l;

  SELECT min(created_at) INTO v_created
    FROM purchase_entries
   WHERE purchase_group_id = p_group_id;

  RETURN v_created;
END;
$function$;

-- ══ 4. receive_purchase_order — patched from the LIVE body ═════════════════════════════════════
-- Two text insertions into its one INSERT: the column, and the value from settings (the same
-- explicit-false rule as above; v_period is the PO's period row, already read FOR the lock check).
-- Each insertion must match exactly once, or nothing is executed and the migration stops.
DO $$
DECLARE
  v_def  text;
  v_new  text;
  c_cols_old constant text := 'payment_method, vat_inclusive, purchase_group_id, po_id)';
  c_cols_new constant text := 'payment_method, vat_inclusive, purchase_group_id, po_id, vat_is_cost)';
  c_vals_old constant text := E'p_group_id,\n       p_po_id);';
  c_vals_new constant text := E'p_group_id,\n       p_po_id,\n       -- D32: the bill''s cost basis, from the outlet''s switch at receipt (explicit false = PAN bill).\n       COALESCE((SELECT bool_or(s.is_vat_registered IS FALSE) FROM settings s WHERE s.client_id = v_period.client_id), false));';
BEGIN
  v_def := pg_get_functiondef('public.receive_purchase_order(uuid, integer, text, boolean, uuid, jsonb)'::regprocedure);
  IF v_def LIKE '%vat_is_cost%' THEN
    RAISE NOTICE 'D32: receive_purchase_order already stamps vat_is_cost; left as it is';
    RETURN;
  END IF;
  -- Normalise CRLF first: some live bodies were saved with it (S753), and the patterns are LF.
  v_def := replace(v_def, E'\r\n', E'\n');
  IF (length(v_def) - length(replace(v_def, c_cols_old, ''))) / length(c_cols_old) <> 1
     OR (length(v_def) - length(replace(v_def, c_vals_old, ''))) / length(c_vals_old) <> 1 THEN
    RAISE EXCEPTION 'D32: receive_purchase_order''s INSERT no longer has the shape this patch expects — patch it by hand';
  END IF;
  v_new := replace(replace(v_def, c_cols_old, c_cols_new), c_vals_old, c_vals_new);
  EXECUTE v_new;
END;
$$;

-- ══ 5. get_group_pnl ════════════════════════════════════════════════════════════════════════════
-- Body: 20260928160000 with purchases_val and returns_val on the cost basis (marked -- D32). 1.13 is
-- 1 + VAT_RATE (supplierAttribution.js); SQL cannot import it, so it is mirrored here by hand.
CREATE OR REPLACE FUNCTION public.get_group_pnl(p_bs_year integer, p_bs_month integer)
 RETURNS TABLE(client_id uuid, client_name text, is_included boolean, has_period boolean, period_status text, revenue numeric, opening_val numeric, purchases_val numeric, returns_val numeric, wastage_val numeric, staff_meals_val numeric, closing_val numeric, has_closing boolean, labour_payroll numeric, labour_bucket numeric, overheads_val numeric, tax_fees_val numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
BEGIN
  -- Owner or admin, exactly as get_group_summary() since S617 (20260827140000). This function
  -- checked group MEMBERSHIP alone and called it authorisation, so any staff login of a grouped
  -- client -- a POS PIN waiter included -- could POST it and read every Suite outlet's revenue,
  -- COGS, labour and overheads. COALESCE on both: each returns NULL, not false, for a caller with
  -- no profile, and NOT(NULL OR NULL) never fires the branch (the S579/S630 fail-open shape).
  IF NOT (COALESCE(public.is_admin(), false) OR COALESCE(public.is_client_owner(), false)) THEN
    RAISE EXCEPTION 'Not permitted: only an owner can see group figures.';
  END IF;

  v_group := public.my_group_id();
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'Not permitted: you are not part of an outlet group.';
  END IF;

  RETURN QUERY
  WITH outlets AS (
    SELECT c.id, c.name, (c.suite_plan = 'pro') AS included
      FROM clients c
     WHERE c.group_id = v_group
  ),
  per AS (
    SELECT o.id AS cid, mp.id AS period_id, mp.status
      FROM outlets o
      LEFT JOIN monthly_periods mp
        ON mp.client_id = o.id AND mp.bs_year = p_bs_year AND mp.bs_month = p_bs_month
  ),
  -- One row per bill per period: its single discount, and its gross over ALL lines.
  bill AS (
    SELECT pe.period_id,
           COALESCE(
             pe.purchase_group_id::text,
             COALESCE(pe.vendor_id::text, '') || '|' ||
             COALESCE(pe.invoice_ref, '')     || '|' ||
             COALESCE(pe.bs_day::text, '')
           )                                    AS bill_key,
           max(COALESCE(pe.discount_amount, 0)) AS discount,
           sum(pe.qty * pe.rate)                AS gross
      FROM purchase_entries pe
      JOIN per ON per.period_id = pe.period_id
     GROUP BY 1, 2
  )
  SELECT
    o.id,
    o.name,
    o.included,
    (per.period_id IS NOT NULL),
    per.status,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(se.qty_sold * COALESCE(se.unit_price, r.selling_price, 0) - COALESCE(se.discount, 0))
        FROM sales_entries se JOIN recipes r ON r.id = se.recipe_id
       WHERE se.period_id = per.period_id AND se.source IS DISTINCT FROM 'pos_comp'  -- NULL-safe: a legacy row predates the column
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(os.qty * COALESCE(i.per_uom_rate, 0))
        FROM opening_stock os
        JOIN items i ON i.id = os.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE os.period_id = per.period_id
    ), 0) END,
    -- purchases_val: gross line value LESS this line's proportional share of its bill's discount,
    -- then on the COST basis (D32): × 1.13 on a VAT line of a vat_is_cost (PAN-bill) bill.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(
               (pe.qty * pe.rate
                - COALESCE(b.discount, 0) * (pe.qty * pe.rate) / NULLIF(b.gross, 0))
               * CASE WHEN COALESCE(pe.vat_inclusive, false) AND pe.vat_is_cost THEN 1.13 ELSE 1 END  -- D32
             )
        FROM purchase_entries pe
        JOIN items i ON i.id = pe.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
        LEFT JOIN bill b
          ON b.period_id = pe.period_id
         AND b.bill_key  = COALESCE(
               pe.purchase_group_id::text,
               COALESCE(pe.vendor_id::text, '') || '|' ||
               COALESCE(pe.invoice_ref, '')     || '|' ||
               COALESCE(pe.bs_day::text, '')
             )
       WHERE pe.period_id = per.period_id
    ), 0) END,
    -- returns_val: list value, on the basis of the line it went back against (D32). An unlinked
    -- return (no line) stays ex-VAT, as periodCost.js's returnCostValue does.
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(vr.qty * vr.rate
                 * CASE WHEN COALESCE(lp.vat_inclusive, false) AND COALESCE(lp.vat_is_cost, false) THEN 1.13 ELSE 1 END)  -- D32
        FROM vendor_returns vr
        JOIN items i ON i.id = vr.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
        LEFT JOIN purchase_entries lp ON lp.id = vr.purchase_entry_id  -- D32
       WHERE vr.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(w.qty * COALESCE(i.per_uom_rate, 0))
        FROM wastages w
        JOIN items i ON i.id = w.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE w.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(sm.qty * COALESCE(i.per_uom_rate, 0))
        FROM staff_meals sm
        JOIN items i ON i.id = sm.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE sm.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(cs.physical_qty * COALESCE(i.per_uom_rate, 0))
        FROM closing_stock cs
        JOIN items i ON i.id = cs.item_id AND NOT i.is_sub_recipe  -- S792 (D29): hidden items keep their history
       WHERE cs.period_id = per.period_id
    ), 0) END,
    CASE WHEN o.included THEN EXISTS (
      SELECT 1 FROM closing_stock cs WHERE cs.period_id = per.period_id
    ) ELSE false END,
    CASE WHEN o.included THEN (
      SELECT sum(ps.gross + COALESCE(ps.ot_amount, 0) + COALESCE(ps.ssf_employer, 0))
        FROM hr_payslips ps JOIN hr_payroll_runs pr ON pr.id = ps.run_id
       WHERE pr.client_id = o.id AND pr.period_id = per.period_id AND pr.status = 'finalized'
    ) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'labor'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'overhead'
    ), 0) END,
    CASE WHEN o.included THEN COALESCE((
      SELECT sum(oh.amount) FROM overheads oh
       WHERE oh.period_id = per.period_id AND COALESCE(oh.bucket, 'overhead') = 'tax_fees'
    ), 0) END
  FROM outlets o JOIN per ON per.cid = o.id
  ORDER BY o.name;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_group_pnl(integer, integer) TO authenticated, service_role;

-- ══ 6. Self-check ════════════════════════════════════════════════════════════════════════════════
-- Catalog first, then save_purchase_bill is CALLED inside a sub-block whose closing RAISE rolls the
-- write back (a plpgsql body is only resolved on first execution — S735). It runs as the migration
-- role, which the closed-month and rank triggers let through, and borrows an existing line's period
-- and item so no FK or client pairing can differ from a real save.
DO $$
DECLARE
  v_period   uuid;
  v_item     uuid;
  v_group    uuid := gen_random_uuid();
  v_expected boolean;
  v_detail   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'purchase_entries' AND column_name = 'vat_is_cost'
                    AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false') THEN
    RAISE EXCEPTION 'D32: purchase_entries.vat_is_cost missing, nullable, or not DEFAULT false';
  END IF;

  -- The backfill reached every open-month line of every explicit PAN client, and nothing else
  -- (a closed month, or a client that is not explicitly PAN) was touched by it.
  IF EXISTS (SELECT 1 FROM purchase_entries pe JOIN monthly_periods mp ON mp.id = pe.period_id
              WHERE mp.status = 'open' AND NOT pe.vat_is_cost
                AND EXISTS (SELECT 1 FROM settings s WHERE s.client_id = mp.client_id AND s.is_vat_registered IS FALSE)) THEN
    RAISE EXCEPTION 'D32: an open-month line of a PAN-bill client was not backfilled';
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure) NOT LIKE '%v_vat_is_cost%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure) NOT LIKE '%purchase_bill_has_returns%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure) NOT LIKE '%purchase_bill_has_payments%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure) NOT LIKE '%purchase_bill_stale%' THEN
    RAISE EXCEPTION 'D32: save_purchase_bill lost vat_is_cost or one of its refusals';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_purchase_bill') <> 1 THEN
    RAISE EXCEPTION 'D32: save_purchase_bill has more than one signature';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.receive_purchase_order(uuid, integer, text, boolean, uuid, jsonb)'::regprocedure) NOT LIKE '%vat_is_cost%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.receive_purchase_order(uuid, integer, text, boolean, uuid, jsonb)'::regprocedure) NOT LIKE '%po_period_closed%' THEN
    RAISE EXCEPTION 'D32: receive_purchase_order does not stamp vat_is_cost, or lost its closed-period refusal';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_group_pnl(integer,integer)'::regprocedure) NOT LIKE '%vat_is_cost%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_group_pnl(integer,integer)'::regprocedure) LIKE '%is_active%' THEN
    RAISE EXCEPTION 'D32: get_group_pnl is not on the cost basis, or filters on is_active again';
  END IF;
  IF has_function_privilege('anon', 'public.get_group_pnl(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D32: anon can execute get_group_pnl';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_group_pnl(integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'D32: authenticated lost EXECUTE on get_group_pnl';
  END IF;

  SELECT pe.period_id, pe.item_id INTO v_period, v_item FROM purchase_entries pe LIMIT 1;
  IF v_period IS NULL THEN
    RAISE NOTICE 'D32: no purchase_entries rows to borrow a period from; save_purchase_bill was not exercised';
    RETURN;
  END IF;
  SELECT COALESCE(bool_or(s.is_vat_registered IS FALSE), false) INTO v_expected
    FROM monthly_periods mp JOIN settings s ON s.client_id = mp.client_id WHERE mp.id = v_period;
  v_expected := COALESCE(v_expected, false);

  BEGIN
    PERFORM public.save_purchase_bill(v_period, v_group, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'bs_day', 1, 'qty', 1, 'rate', 100, 'vat_inclusive', true),
      jsonb_build_object('item_id', v_item, 'bs_day', 1, 'qty', 2, 'rate', 50)), NULL, NULL);
    SELECT string_agg(vat_is_cost::text, ',' ORDER BY qty) INTO v_detail
      FROM purchase_entries WHERE purchase_group_id = v_group;
    RAISE EXCEPTION 'D32_rollback' USING DETAIL = v_detail;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'D32_rollback' THEN RAISE; END IF;
    IF v_detail IS DISTINCT FROM (v_expected::text || ',' || v_expected::text) THEN
      RAISE EXCEPTION 'D32: a new bill stored vat_is_cost as %, expected % on both lines', v_detail, v_expected;
    END IF;
  END;
END;
$$;

NOTIFY pgrst, 'reload schema';
