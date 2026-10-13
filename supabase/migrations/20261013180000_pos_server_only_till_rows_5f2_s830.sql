-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S830, POS stage 5, slice 5f-2, step 2 of 2: a till's sales and stock lines are the server's to
-- write, and the till floor goes to crest-v446.
--
--   Since 5f-1 (20261013160000) the close posts its own bill, and since step 1 (20261013170000,
--   crest-v446) the floor banner and Periods ask the server to post waiting bills
--   (post_waiting_pos_bills). Both write as the owner (SECURITY DEFINER), which the INVOKER guards
--   wave through on their first line. So no page writes a till sale or a till stock line any more,
--   and this file makes that the table's rule:
--   * ims_sales_entries_guard refuses a 'pos' or 'pos_comp' row from any login, the Owner's and the
--     operator's included (pos_sale_server_only), and an update turning another row into one. The
--     operator's restore and corrections already returned above that point (S828 5d), so a restore
--     still re-inserts a backup's till sales as they were.
--   * ims_stock_movements_guard does the same for a 'pos_sale' or 'pos_comp' line. The operator was
--     waved through everything there; it now keeps its restore (a line dated before this
--     transaction, as the export keeps created_at) and its corrections, and nothing else for these two
--     sources.
--   * pos_min_till_build() returns 446: a till still on crest-v445 or older posts from the browser
--     after a close (refused now, and reported as not posted), so it must reload before it closes
--     another bill.
--   Credit notes are untouched: 'pos_credit' and 'pos_credit_restock' rows are still the page's to
--   write until slice 5f-4. The rank branch for 'pos'/'pos_comp' inserts further down the sales guard
--   is now unreachable; it is left as it was rather than rewritten in a step about something else.
--
-- Apply only once crest-v446 is live: an older page posting a bill or a waiting month from the
-- browser would be refused. Section 0 refuses unless step 1 is live.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13: ims_sales_entries_guard
-- fb3674837ab09d384f2f089190672158 (20261013140000), ims_stock_movements_guard
-- 0243bef6e3ee9694384e63166fbe9474 (20261009210000), pos_min_till_build 24490060a1847d8dcd8f98a1696784b3
-- (20261013100100). Each second hash in section 0 is the body this file writes, so a re-run passes.
-- Signatures, return types, SECURITY (all INVOKER) and search_path are unchanged, so CREATE OR
-- REPLACE keeps both triggers attached and pos_min_till_build's grants. No RPC changes shape.
--
-- To undo: re-run the CREATE OR REPLACE of ims_sales_entries_guard from 20261013140000, of
-- ims_stock_movements_guard from 20261009210000, and of pos_min_till_build from 20261013100100 (438).
--
-- The probe (section 4) acts at BLOOM CAFE (or the first POS outlet with Inventory, an open month
-- holding today, an Owner and unblocked manager and supervisor till logins), as the migration's
-- role, those logins and the operator, inside a block that rolls itself back. It switches the
-- outlet's Inventory off for a moment and holds its invoice-number lock for a second or so, so a till
-- closing a bill there in that moment waits. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.post_waiting_pos_bills(uuid, integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '1ffbfea7b3dd9cbcf1b426b2adbc8d5a' THEN
    RAISE EXCEPTION 'S830 5f-2 step 2 pre-flight: step 1 (20261013170000) is not live (post_waiting_pos_bills md5 %). Apply it, deploy crest-v446, then this.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('fb3674837ab09d384f2f089190672158', 'ace91816eec08c9f8cdb09a49e961f3c') THEN
    RAISE EXCEPTION 'S830 5f-2 step 2 pre-flight: ims_sales_entries_guard changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_stock_movements_guard()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('0243bef6e3ee9694384e63166fbe9474', '63d4eac768c9ddd6da676dffb88ff3ee') THEN
    RAISE EXCEPTION 'S830 5f-2 step 2 pre-flight: ims_stock_movements_guard changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('24490060a1847d8dcd8f98a1696784b3', '34a017016e0a5a843ac60adeeac03c2f') THEN
    RAISE EXCEPTION 'S830 5f-2 step 2 pre-flight: pos_min_till_build changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
END;
$$;


-- ── 1. Sales: a till sale is the server's to write ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ims_sales_entries_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old text;
  v_new text;
  -- S828 5d
  v_period_client uuid;
  v_ims           boolean;
  v_note_client   uuid;
  v_note_restock  boolean;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── S828 5d: the operator keeps its restore and its corrections, and nothing else ────────────
  -- It was waved through everything here (S809 2e), though the comment below said only its restore
  -- was. The restore re-inserts rows as they were, each dated before this transaction; a NULL date
  -- counts as a restore, as sales_entries_stamp_pos_source reads it. A post from the till, the
  -- floor or Periods is dated now() by the column default, so an operator's post meets the record
  -- checks below like anyone's; only the rank block is skipped for it (exempt from rank, never from
  -- the record). Its updates and deletes are corrections and stay exempt.
  IF COALESCE(public.is_admin(), false)
     AND (TG_OP <> 'INSERT' OR COALESCE(NEW.created_at < now(), true)) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- ── end S828 5d ──────────────────────────────────────────────────────────────────────────────

  -- ── S830 5f-2: a till's sales are the server's to write ────────────────────────────────────────
  -- The close posts its own bill (pos_orders_post_to_inventory, 5f-1) and Post to Inventory and
  -- Periods ask the server (post_waiting_pos_bills, 5f-2). Both write as the owner (SECURITY
  -- DEFINER), which the first line of this function lets through, so no page writes a till sale
  -- any more. A 'pos' or 'pos_comp' row from a login is refused, the Owner's and the operator's
  -- included, and so is turning another row into one. The operator's restore and its corrections
  -- returned just above.
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.source, 'manual') IN ('pos', 'pos_comp') THEN
      RAISE EXCEPTION 'pos_sale_server_only: a till''s sales reach Inventory only through the server''s own post (as the bill closes, or Post to Inventory), so this % row was not recorded', NEW.source
        USING ERRCODE = '42501', HINT = 'pos_sale_server_only';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.source, 'manual') IN ('pos', 'pos_comp') AND COALESCE(OLD.source, 'manual') NOT IN ('pos', 'pos_comp') THEN
      RAISE EXCEPTION 'pos_sale_server_only: a till''s sales reach Inventory only through the server''s own post, so this row was not turned into one'
        USING ERRCODE = '42501', HINT = 'pos_sale_server_only';
    END IF;
  END IF;
  -- ── end S830 5f-2 ──────────────────────────────────────────────────────────────────────────────

  IF TG_OP <> 'INSERT' THEN v_old := COALESCE(OLD.source, 'manual'); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := COALESCE(NEW.source, 'manual'); END IF;

  IF TG_OP <> 'DELETE' THEN
    -- ── S828 5d (a): each kind of row names only its own record ─────────────────────────────────
    -- The "already posted?" reads (the floor, Periods, the note screen) ask by pos_order_id or by
    -- pos_credit_note_id without looking at source, so a stray link made a bill or a note look
    -- posted when it was not. A hand-entered sale names neither, a till sale names no note (its bill
    -- is sales_entries_stamp_pos_source's to require), and a note's reversal names its note and no
    -- bill. On an UPDATE a link may be cleared (a foreign key's SET NULL), never pointed at the
    -- wrong kind of record.
    IF NOT COALESCE(CASE
         WHEN v_new = 'manual' THEN NEW.pos_order_id IS NULL AND NEW.pos_credit_note_id IS NULL
         WHEN v_new IN ('pos', 'pos_comp') THEN NEW.pos_credit_note_id IS NULL
         ELSE NEW.pos_order_id IS NULL AND (NEW.pos_credit_note_id IS NOT NULL OR TG_OP = 'UPDATE')
       END, false) THEN
      RAISE EXCEPTION 'sales_entry_link_mismatch: a hand-entered sale names no bill or credit note, a till sale names no credit note, and a credit note''s reversal names its note and no bill, so this % row was not recorded', v_new
        USING ERRCODE = '42501', HINT = 'sales_entry_link_mismatch';
    END IF;

    IF v_new <> 'manual' THEN
      -- The month's outlet, through this login's policies. sales_entries' own policy needs the same
      -- month visible as this login's outlet, so a month it cannot see is refused there anyway.
      SELECT p.client_id, c.ims_enabled INTO v_period_client, v_ims
        FROM monthly_periods p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = NEW.period_id;

      -- ── S828 5d (b, S809.4 4e): a till's sales go to Inventory only where Inventory is on ────
      -- The page posts nothing for such an outlet and leaves its bills and notes unmarked (D6, D7),
      -- so switching Inventory on later still finds them; this is the table's half. NULL counts as
      -- on, as the app reads it (`?? true`). A new row only: a correction of an old one is not a post.
      IF TG_OP = 'INSERT' AND v_ims IS FALSE THEN
        RAISE EXCEPTION 'pos_outlet_no_ims: this outlet does not have Crest Inventory, so its till sales and credit notes are not posted to Inventory, and this % row was not recorded', v_new
          USING ERRCODE = '42501', HINT = 'pos_outlet_no_ims';
      END IF;
    END IF;

    -- A Credit Note's reversal follows the note's own answer (CREDIT-NOTES-1, Q10 a). A note that
    -- said its food was not served posts 'pos_credit_restock' rows, which take the plates back out of
    -- stock usage; any other note posts 'pos_credit'. Checked for the Owner as well as staff (only the
    -- operator's restore is exempt): a page older than this release posts every note as 'pos_credit',
    -- and the food would then never come back, so that post is refused and the note stays waiting for
    -- a page that posts it right. A restock row must take sales back (qty < 0) and name such a note.
    -- The note is read through this login's policies: a note it cannot see fails closed.
    IF v_new IN ('pos_credit', 'pos_credit_restock') THEN
      IF NEW.pos_credit_note_id IS NOT NULL THEN
        SELECT n.client_id, n.restock INTO v_note_client, v_note_restock
          FROM pos_credit_notes n WHERE n.id = NEW.pos_credit_note_id;
        -- ── S828 5d (c): the note is the month's own outlet's ─────────────────────────────────
        -- sales_entries_stamp_pos_source let a reversal naming another outlet's note in unmarked,
        -- so another outlet's revenue could be taken off this one's month.
        IF v_note_client IS NULL OR v_note_client IS DISTINCT FROM v_period_client THEN
          RAISE EXCEPTION 'pos_credit_note_other_outlet: a credit note''s reversal is recorded in its own outlet''s month, and this one named a note of another outlet, or one this login cannot see, so it was not recorded'
            USING ERRCODE = '42501', HINT = 'pos_credit_note_other_outlet';
        END IF;
      END IF;
      IF v_new = 'pos_credit' AND COALESCE(v_note_restock, false) THEN
        RAISE EXCEPTION 'credit_note_restock_mismatch: this Credit Note said its food was not served, so its Inventory posting must put the food back — post it again from a page that is up to date'
          USING ERRCODE = '42501', HINT = 'credit_note_restock_mismatch';
      END IF;
      IF v_new = 'pos_credit_restock'
         AND (NOT COALESCE(NEW.qty_sold < 0, false) OR NOT COALESCE(v_note_restock, false)) THEN
        RAISE EXCEPTION 'pos_credit_restock_invalid: food goes back into Inventory only through a Credit Note that said it was not served, and only as sales taken back'
          USING ERRCODE = '42501', HINT = 'pos_credit_restock_invalid';
      END IF;
    END IF;
  END IF;

  -- S809 2e: the Owner is not waved through the record checks above; S828 5d: nor the operator.
  IF COALESCE(public.is_client_owner(), false) OR COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_new = 'manual' AND public.ims_caller_has_rank('staff') THEN
      RETURN NEW;
    ELSIF v_new IN ('pos', 'pos_comp')
          AND (COALESCE(public.pos_caller_has_rank('supervisor'), false) OR public.ims_caller_has_rank('supervisor')) THEN
      RETURN NEW;
    -- S809 2e: a "not served" note's reversal is posted by the same people as any other note's.
    ELSIF v_new IN ('pos_credit', 'pos_credit_restock')
          AND (COALESCE(public.pos_caller_has_rank('manager'), false) OR public.ims_caller_has_rank('supervisor')) THEN
      RETURN NEW;
    END IF;
  ELSIF v_old = 'manual' AND COALESCE(v_new, 'manual') = 'manual' AND public.ims_caller_has_rank('staff') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'sales_entries: this sale (%) cannot be % from this login', COALESCE(v_new, v_old),
    CASE TG_OP WHEN 'INSERT' THEN 'recorded' WHEN 'DELETE' THEN 'removed' ELSE 'changed' END
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$function$;


-- ── 2. Stock movements: a till stock line is the server's to write ──────────────────────────────
CREATE OR REPLACE FUNCTION public.ims_stock_movements_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source text;
BEGIN
  -- ── S809 2e: the Owner is no longer waved through here; the operator still is ───────────────
  -- (S830 5f-2: except for a till stock line, below.)
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── S830 5f-2: a till's stock lines are the server's to write ──────────────────────────────────
  -- The close and Post to Inventory write them as the owner (SECURITY DEFINER), which the line above
  -- lets through, so a 'pos_sale' or 'pos_comp' line from a login is refused, the Owner's and the
  -- operator's included, and so is turning another line into one. The operator keeps its restore (a
  -- line dated before this transaction) and its corrections.
  IF NOT (COALESCE(public.is_admin(), false) AND (TG_OP <> 'INSERT' OR COALESCE(NEW.created_at < now(), true))) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.source IN ('pos_sale', 'pos_comp') THEN
        RAISE EXCEPTION 'pos_sale_server_only: a till''s stock lines reach Inventory only through the server''s own post (as the bill closes, or Post to Inventory), so this % line was not recorded', NEW.source
          USING ERRCODE = '42501', HINT = 'pos_sale_server_only';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.source IN ('pos_sale', 'pos_comp') AND OLD.source NOT IN ('pos_sale', 'pos_comp') THEN
        RAISE EXCEPTION 'pos_sale_server_only: a till''s stock lines reach Inventory only through the server''s own post, so this line was not turned into one'
          USING ERRCODE = '42501', HINT = 'pos_sale_server_only';
      END IF;
    END IF;
  END IF;
  -- ── end S830 5f-2 ──────────────────────────────────────────────────────────────────────────────

  IF COALESCE(public.is_admin(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- A Credit Note that said its bill's food was not served puts that food back (CREDIT-NOTES-1,
  -- Q10 a): positive rows, the bill's own 'pos_sale' depletion negated, ref_id the credited bill. The
  -- Owner meets this too; only the operator's restore is exempt. A restock row must add stock and
  -- name a bill of this outlet whose note said so. One per bill and item
  -- (stock_movements_one_restock_per_bill_item).
  IF TG_OP = 'INSERT' AND NEW.source = 'pos_credit_restock'
     AND (NOT COALESCE(NEW.qty > 0, false)
          OR NOT EXISTS (SELECT 1 FROM pos_credit_notes n
                          WHERE n.order_id = NEW.ref_id AND n.client_id = NEW.client_id AND n.restock)) THEN
    RAISE EXCEPTION 'pos_credit_restock_invalid: stock goes back into Inventory only through a Credit Note that said its bill''s food was not served, and only as stock added'
      USING ERRCODE = '42501', HINT = 'pos_credit_restock_invalid';
  END IF;

  IF COALESCE(public.is_client_owner(), false) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- ── end S809 2e ──────────────────────────────────────────────────────────────────────────

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'stock_movements: a stock movement is a ledger record and is not edited — delete and re-post the day instead'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;

  v_source := CASE WHEN TG_OP = 'INSERT' THEN NEW.source ELSE OLD.source END;
  IF v_source = 'manual' THEN
    IF public.ims_caller_has_rank('staff') THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  ELSIF v_source IN ('pos_sale', 'pos_comp') AND TG_OP = 'INSERT' THEN
    IF COALESCE(public.pos_caller_has_rank('supervisor'), false) OR public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
  -- S809 2e: posted with the note's revenue reversal, by the same people (ims_sales_entries_guard).
  ELSIF v_source = 'pos_credit_restock' AND TG_OP = 'INSERT' THEN
    IF COALESCE(public.pos_caller_has_rank('manager'), false) OR public.ims_caller_has_rank('supervisor') THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'stock_movements: this stock movement (%) cannot be % from this login', COALESCE(v_source, 'no source'),
    CASE TG_OP WHEN 'INSERT' THEN 'recorded' ELSE 'removed' END
    USING ERRCODE = '42501', HINT = 'ims_rank';
END;
$function$;


-- ── 3. The till floor: crest-v446 ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_min_till_build()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 446
$$;


-- ── 4. Prove it ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_client  uuid;
  v_period  uuid;
  v_start   date;
  v_mgr     uuid;
  v_sup     uuid;
  v_owner   uuid;
  v_admin   uuid;
  v_fy      text;
  v_chicken uuid;
  v_wrap    uuid;
  v_w1 uuid; v_w2 uuid; v_w3 uuid;
  v_r       jsonb;
  v_row     uuid;
  v_hint    text;
  v_msg     text;
  v_who     record;
BEGIN
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND c.ims_enabled IS NOT FALSE
     AND EXISTS (SELECT 1 FROM public.monthly_periods mp
                   JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
                  WHERE mp.client_id = c.id AND mp.status = 'open'
                    AND v_today >= m.ad_start AND v_today < m.ad_start + m.days)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND COALESCE(p.active_client_id, p.client_id) = c.id
                    AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
                    AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false))
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S830 5f-2 step 2 probe: no POS outlet with Inventory, an open month holding today, an Owner and unblocked manager and supervisor till logins';
  END IF;
  SELECT mp.id, m.ad_start INTO v_period, v_start
    FROM public.monthly_periods mp JOIN public.bs_months m ON m.bs_year = mp.bs_year AND m.bs_month = mp.bs_month
   WHERE mp.client_id = v_client AND mp.status = 'open';
  SELECT p.id INTO v_owner FROM public.profiles p
   WHERE p.client_id = v_client AND COALESCE(p.active_client_id, p.client_id) = v_client
     AND p.role = 'client' AND p.pos_role IS NULL AND p.pos_email IS NULL AND p.ims_role IS NULL
     AND p.hr_role IS NULL AND NOT COALESCE(p.hr_self_service, false) ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_mgr FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_sup FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'S830 5f-2 step 2 probe: no operator login';
  END IF;
  v_fy := public.pos_invoice_fy(now());

  BEGIN
    -- ── Setup, as the migration's own role: a dish, and three bills closed while Inventory is off,
    --    so they wait (W1 and W2 for the refusals and the server's post, W3 for the restore) ──────
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S830 5f-2b probe chicken', 'kg', 1, 0, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S830 5f-2b probe wrap', 'Food', 1) RETURNING id INTO v_wrap;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_wrap, v_chicken, 0.3);
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w1;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w2;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_w3;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_w1, v_client, 'S830 5f-2b probe wrap', v_wrap, 1, 300, 0.13),
      (v_w2, v_client, 'S830 5f-2b probe wrap', v_wrap, 1, 300, 0.13),
      (v_w3, v_client, 'S830 5f-2b probe wrap', v_wrap, 1, 300, 0.13);
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', paid_amount = 339, invoice_fy = v_fy,
           closed_at = (v_start + time '00:15') AT TIME ZONE 'Asia/Kathmandu'
     WHERE id IN (v_w1, v_w2, v_w3);
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;

    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v446"}', true);
    SET LOCAL ROLE authenticated;

    -- (1) A till sale and a till stock line from the supervisor, the manager, the Owner and the
    --     operator (not a restore) are each refused as the server's to write.
    FOR v_who IN SELECT * FROM (VALUES ('supervisor', v_sup), ('manager', v_mgr), ('Owner', v_owner), ('operator', v_admin)) x(label, id) LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_who.id)::text, true);
      v_hint := NULL;
      BEGIN
        INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
          VALUES (v_period, v_wrap, 1, 1, 'pos', 300, 0.13, v_w1);
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'pos_sale_server_only' THEN
        RAISE EXCEPTION 'S830 5f-2 step 2 probe: a till sale from the % answered % (%)', v_who.label, COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
      v_hint := NULL;
      BEGIN
        INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
          VALUES (v_client, v_chicken, v_period, 1, -1, 'pos_sale', v_w1);
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'pos_sale_server_only' THEN
        RAISE EXCEPTION 'S830 5f-2 step 2 probe: a till stock line from the % answered % (%)', v_who.label, COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
    END LOOP;

    -- (2) The Owner's hand-entered sale and manual stock line still land; turning the sale into a
    --     till sale is refused.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate)
      VALUES (v_period, v_wrap, 2, 1, 'manual', 300, 0.13) RETURNING id INTO v_row;
    INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source)
      VALUES (v_client, v_chicken, v_period, 2, -0.3, 'manual');
    v_hint := NULL;
    BEGIN
      UPDATE public.sales_entries SET source = 'pos' WHERE id = v_row;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_sale_server_only' THEN
      RAISE EXCEPTION 'S830 5f-2 step 2 probe: the Owner turning a hand-entered sale into a till sale answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (3) The operator's restore still re-inserts a bill's till sale and stock line as they were.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id, created_at)
      VALUES (v_period, v_wrap, 1, 1, 'pos', 300, 0.13, v_w3, now() - interval '1 day');
    INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id, created_at)
      VALUES (v_client, v_chicken, v_period, 1, -0.3 / 0.85, 'pos_sale', v_w3, now() - interval '1 day');

    -- (4) The server's post of a waiting month still writes both, for the manager.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    v_r := public.post_waiting_pos_bills(v_period, 200);
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w1) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_order_id = v_w1 AND source = 'pos') <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_w1 AND source = 'pos_sale' AND abs(qty + 0.3 / 0.85) < 1e-9) <> 1
       OR (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_w2) IS NULL THEN
      RAISE EXCEPTION 'S830 5f-2 step 2 probe: the server''s post of the waiting month did not write W1 and W2: %', v_r;
    END IF;

    -- (5) The till floor: crest-v445 is turned away from a bill write, crest-v446 is not.
    IF public.pos_min_till_build() IS DISTINCT FROM 446 THEN
      RAISE EXCEPTION 'S830 5f-2 step 2 probe: the till floor is %, not 446', public.pos_min_till_build();
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sup)::text, true);
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v445"}', true);
    v_hint := NULL;
    BEGIN
      UPDATE public.pos_orders SET print_count = print_count WHERE id = v_w2;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_till_build_too_old' THEN
      RAISE EXCEPTION 'S830 5f-2 step 2 probe: a crest-v445 till writing a bill answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v446"}', true);
    UPDATE public.pos_orders SET print_count = print_count WHERE id = v_w2;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's830_5f2b_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's830_5f2b_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 5. What this step acts on, live (the last statement, so `db query` prints it) ─────────────
SELECT
  public.pos_min_till_build() AS till_floor,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure) AS sales_guard_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ims_stock_movements_guard()'::regprocedure) AS movements_guard_md5,
  (SELECT count(*) FROM public.pos_orders WHERE status = 'billed' AND ims_posted_at IS NULL) AS bills_waiting;
