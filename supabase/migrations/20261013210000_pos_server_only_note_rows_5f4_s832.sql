-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S832, POS stage 5, slice 5f-4, step 2 of 2: a credit note's Inventory rows and its mark are the
-- server's to write, and the till floor goes to crest-v448.
--
--   Since step 1 (20261013200000, crest-v448) the issue posts its own note
--   (pos_credit_notes_post_to_inventory) and the floor banner and Periods ask the server to post
--   waiting notes (post_waiting_credit_notes). Both write as the owner (SECURITY DEFINER), which the
--   INVOKER guards wave through on their first line. So no page writes a note's reversal, its stock
--   put back, or its mark any more, and this file makes that the tables' rule, as 20261013180000 did
--   for a till's sales and stock lines:
--   * ims_sales_entries_guard refuses a 'pos_credit' or 'pos_credit_restock' row from any login, the
--     Owner's and the operator's included (pos_credit_server_only), and an update turning another row
--     into one. The operator's restore and corrections already returned above that point (S828 5d),
--     so a restore still re-inserts a backup's reversals as they were.
--   * ims_stock_movements_guard does the same for a 'pos_credit_restock' line, keeping the operator's
--     restore (a line dated before this transaction) and its corrections, as for a till stock line.
--   * guard_pos_credit_note refuses a login setting a note's Inventory mark (pos_credit_server_only):
--     set by hand, it would leave the bill's revenue in Inventory for good with nothing counting the
--     note as waiting. The mark is set as the reversal lands (sales_entries_stamp_pos_source) or by
--     the server's post, both as the owner. A set mark still stands, as before.
--   * pos_min_till_build() returns 448: a page still on crest-v447 or older posts a note from the
--     browser after issuing it (refused now, and reported as not posted), so it must reload first.
--     Issuing a note marks its bill credited, a pos_orders write the floor already gates, so an
--     older page is told to reload before it can issue one.
--   The rank branch for credit-note inserts further down the sales guard, and the one for
--   'pos_credit_restock' lines in the stock guard, are now unreachable; they are left as they were.
--   errorText.js has no sentence for pos_credit_server_only, because no current page can meet it.
--
-- Apply only once Vercel reports crest-v448 deployed: an older page posting a note, or a waiting
-- month's notes, from the browser would be refused. Section 0 refuses unless step 1 is live.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13: ims_sales_entries_guard
-- ace91816eec08c9f8cdb09a49e961f3c (20261013180000), ims_stock_movements_guard 63d4eac768c9ddd6da676dffb88ff3ee
-- (20261013180000), guard_pos_credit_note 181ee4ec9c5a4656fcbd33eee08a0422 (20261013140000), pos_min_till_build
-- 34a017016e0a5a843ac60adeeac03c2f (20261013180000). Each body below is the live one with only the marked S832
-- block added (the note guard: one branch replaced). Each second hash in section 0 is the body this
-- file writes, so a re-run passes. Signatures, return types, SECURITY (all INVOKER) and search_path
-- are unchanged, so CREATE OR REPLACE keeps every trigger attached and pos_min_till_build's grants.
-- No RPC changes shape.
--
-- To undo: re-run the CREATE OR REPLACE of ims_sales_entries_guard and ims_stock_movements_guard
-- from 20261013180000, of guard_pos_credit_note from 20261013140000, and of pos_min_till_build from
-- 20261013180000 (446).
--
-- The probe (section 5) acts at BLOOM CAFE (or the first POS outlet with Inventory, an open month
-- holding today, an Owner and an unblocked POS manager), as the migration's role, that manager, that
-- Owner and the operator, inside a block that rolls itself back. It switches the outlet's Inventory
-- off for a moment and holds its invoice-number and credit-note-number locks for a second or so, so
-- a till closing a bill or issuing a note there in that moment waits. If any check fails, nothing
-- lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.post_waiting_credit_notes(uuid, integer)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '7f87fa72e0242613b7bd983fca18e439' THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 pre-flight: step 1 (20261013200000) is not live (post_waiting_credit_notes md5 %). Apply it, deploy crest-v448, then this.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_post_credit_note_into(uuid, uuid)'::regprocedure;
  IF v_md5 IS DISTINCT FROM '98b79990011ca18e20e5cef39ab75e99' THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 pre-flight: step 1''s pos_post_credit_note_into is not the one this was written against (md5 %).', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('ace91816eec08c9f8cdb09a49e961f3c', '4caa406e21c9295512f50e1421948577') THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 pre-flight: ims_sales_entries_guard changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_stock_movements_guard()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('63d4eac768c9ddd6da676dffb88ff3ee', '320154561a3392f514c3e3ee9fa46744') THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 pre-flight: ims_stock_movements_guard changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('181ee4ec9c5a4656fcbd33eee08a0422', '0d8903dbac7ea38f51a46150e9f3d526') THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 pre-flight: guard_pos_credit_note changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.pos_min_till_build()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('34a017016e0a5a843ac60adeeac03c2f', 'ba2522796b17071a3162b60457f28191') THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 pre-flight: pos_min_till_build changed since this was written (md5 %).', v_md5;
  END IF;
END;
$$;


-- ── 1. Sales: a credit note's reversal is the server's to write ────────────────────────────────
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

  -- ── S832 5f-4 step 2: a credit note's reversal is the server's to write ─────────────────────────
  -- The issue posts its own note (pos_credit_notes_post_to_inventory, 5f-4) and Post to Inventory and
  -- Periods ask the server (post_waiting_credit_notes). Both write as the owner (SECURITY DEFINER),
  -- which the first line of this function lets through, so no page writes a note's reversal any
  -- more. A 'pos_credit' or 'pos_credit_restock' row from a login is refused, the Owner's and the
  -- operator's included, and so is turning another row into one. The operator's restore and its
  -- corrections returned above.
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.source, 'manual') IN ('pos_credit', 'pos_credit_restock') THEN
      RAISE EXCEPTION 'pos_credit_server_only: a credit note reaches Inventory only through the server''s own post (as it is issued, or Post to Inventory), so this % row was not recorded', NEW.source
        USING ERRCODE = '42501', HINT = 'pos_credit_server_only';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF COALESCE(NEW.source, 'manual') IN ('pos_credit', 'pos_credit_restock')
       AND COALESCE(OLD.source, 'manual') NOT IN ('pos_credit', 'pos_credit_restock') THEN
      RAISE EXCEPTION 'pos_credit_server_only: a credit note reaches Inventory only through the server''s own post, so this row was not turned into a credit note''s reversal'
        USING ERRCODE = '42501', HINT = 'pos_credit_server_only';
    END IF;
  END IF;
  -- ── end S832 5f-4 step 2 ───────────────────────────────────────────────────────────────────────

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


-- ── 2. Stock movements: the stock a credit note puts back is the server's to write ─────────────
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

  -- ── S832 5f-4 step 2: the stock a credit note puts back is the server's to write ───────────────
  -- A "not served" note's stock lines go in with its reversal, in the server's post (5f-4). A
  -- 'pos_credit_restock' line from a login is refused, the Owner's and the operator's included, and
  -- so is turning another line into one. The operator keeps its restore (a line dated before this
  -- transaction) and its corrections, as for a till stock line above.
  IF NOT (COALESCE(public.is_admin(), false) AND (TG_OP <> 'INSERT' OR COALESCE(NEW.created_at < now(), true))) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.source = 'pos_credit_restock' THEN
        RAISE EXCEPTION 'pos_credit_server_only: the stock a credit note puts back reaches Inventory only through the server''s own post (as the note is issued, or Post to Inventory), so this line was not recorded'
          USING ERRCODE = '42501', HINT = 'pos_credit_server_only';
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.source = 'pos_credit_restock' AND OLD.source IS DISTINCT FROM 'pos_credit_restock' THEN
        RAISE EXCEPTION 'pos_credit_server_only: the stock a credit note puts back reaches Inventory only through the server''s own post, so this line was not turned into one'
          USING ERRCODE = '42501', HINT = 'pos_credit_server_only';
      END IF;
    END IF;
  END IF;
  -- ── end S832 5f-4 step 2 ───────────────────────────────────────────────────────────────────────

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


-- ── 3. Credit notes: only the server marks a note as in Inventory ──────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_pos_credit_note()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order record;
  v_lines numeric;
  v_allowed CONSTANT text[] := ARRAY['print_count', 'ims_posted_at'];
  -- S828 5d
  v_vat_now  boolean;
  v_prefix   text;
  v_vat_reg  boolean;
  v_day      date;
  v_bs_year  integer;
  v_bs_month integer;
  v_bs_day   integer;
  v_months CONSTANT text[] := ARRAY['Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
                                    'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pos_credit_notes: an issued credit note is a numbered tax document and cannot be deleted'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
      RAISE EXCEPTION 'pos_credit_notes: an issued credit note cannot be changed — only its print count and Inventory posting mark are recorded afterwards'
        USING ERRCODE = '42501', HINT = 'bill_locked';
    END IF;

    -- ── S809 1c (CREDIT-NOTES-6): the two columns that may still move, each one way ─────────
    -- ims_posted_at says the note's reversal reached Inventory: set on a note that never posted,
    -- the bill's revenue stays in Inventory for good. It is set by the people who post a note — a
    -- POS manager (who issues it), the Owner or the operator (Periods) — and once set it stands.
    -- ── S828 5d (S809.4): a print is one more copy, whatever count the page last saw ─────────
    -- The parking slip's rule (pos_parking_slips_guard). Any print_count that differs from the
    -- stored one becomes the stored one + 1, and the page labels from the count the write returns
    -- (it sends -1, which no stored count can equal). It took the higher of the two before, so two
    -- reprints at one moment, each sending its page's count + 1, stored one count and printed the
    -- same copy number. A second print waits on the first's row lock and counts after it.
    IF NEW.print_count IS DISTINCT FROM OLD.print_count THEN
      NEW.print_count := OLD.print_count + 1;
    END IF;
    -- ── end S828 5d ──────────────────────────────────────────────────────────────────────────
    IF NEW.ims_posted_at IS DISTINCT FROM OLD.ims_posted_at THEN
      IF OLD.ims_posted_at IS NOT NULL THEN
        NEW.ims_posted_at := OLD.ims_posted_at;
      ELSE
        -- ── S832 5f-4 step 2: only the server marks a note posted ────────────────────────────────
        -- The mark is set as the note's reversal lands (sales_entries_stamp_pos_source, SECURITY
        -- DEFINER) or by the server's post (pos_post_credit_note_into), both as the owner, which
        -- the first line of this function lets through. A login setting it by hand would leave the
        -- bill's revenue in Inventory for good with nothing counting the note as waiting, so it is
        -- refused, the Owner's and the operator's included.
        RAISE EXCEPTION 'pos_credit_server_only: a Credit Note is marked as in Inventory only by the server, as its reversal lands, so the mark was not set'
          USING ERRCODE = '42501', HINT = 'pos_credit_server_only';
      END IF;
    END IF;
    -- ── end S809 1c ────────────────────────────────────────────────────────────────────────

    RETURN NEW;
  END IF;

  -- INSERT. The operator's restore carries the historical rows as they were.
  -- ── S809 1l (GAP-OPERATOR-1, Q26 a): the restore, and nothing else the operator sends ─────
  -- A restored note carries the time it was first issued. Issue Credit Note never sends created_at,
  -- so a note issued from the screen (by the operator too) is dated now() by the column default and
  -- meets every check below. That includes the S755 amount match: a note worked out under today's
  -- VAT setting against a bill printed under another is refused for Crest support as it is for the
  -- manager. The rank test below still admits the operator.
  IF COALESCE(public.is_admin(), false) AND NEW.created_at < now() THEN
    RETURN NEW;
  END IF;
  -- ── end S809 1l ──────────────────────────────────────────────────────────────────────────

  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'pos_credit_notes: issuing a Credit Note needs POS Manager access or above'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- The bill: this client's, a paid bill that is billed and numbered, with no note yet. Locked so
  -- two managers issuing against one bill queue, and the second sees the first note.
  SELECT o.id, o.client_id, o.status, o.close_type, o.credit_note_id, o.discount_amount, o.paid_amount,
         o.invoice_no, o.invoice_fy, o.vat_registered, o.closed_at
    INTO v_order
    FROM pos_orders o WHERE o.id = NEW.order_id
    FOR UPDATE;
  IF v_order.id IS NULL OR v_order.client_id IS DISTINCT FROM NEW.client_id
     OR v_order.status IS DISTINCT FROM 'billed' OR v_order.close_type IS DISTINCT FROM 'paid'
     OR v_order.invoice_no IS NULL THEN
    RAISE EXCEPTION 'pos_credit_notes: a Credit Note is issued against a paid bill of this outlet'
      USING ERRCODE = '42501', HINT = 'bill_locked';
  END IF;
  IF v_order.credit_note_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM pos_credit_notes n WHERE n.order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'pos_credit_notes: this bill already has a Credit Note — a bill is credited once'
      USING ERRCODE = '23505', HINT = 'credit_note_exists';
  END IF;

  -- S755: the amounts are the bill's. A line this session cannot see lowers v_lines and is
  -- refused, never passed. The lines of a billed order are locked (S754), so they are the lines
  -- the bill was charged for.
  SELECT COALESCE(SUM(i.qty * i.unit_price), 0) INTO v_lines
    FROM pos_order_items i
   WHERE i.order_id = NEW.order_id AND NOT COALESCE(i.comped, false);

  IF NOT COALESCE(
        NEW.gross_amount >= 0 AND NEW.discount_amount >= 0 AND NEW.taxable_amount >= 0
    AND NEW.non_taxable_amount >= 0 AND NEW.vat_amount >= 0 AND NEW.net_amount > 0
    AND abs(NEW.gross_amount - v_lines) <= 0.01
    AND abs(NEW.discount_amount - COALESCE(v_order.discount_amount, 0)) <= 0.01
    AND abs((NEW.taxable_amount + NEW.non_taxable_amount) - (NEW.gross_amount - NEW.discount_amount)) <= 0.01
    AND abs(NEW.net_amount - (NEW.taxable_amount + NEW.non_taxable_amount + NEW.vat_amount)) <= 0.51
    AND abs(NEW.net_amount - COALESCE(v_order.paid_amount, 0)) <= 1
    AND (NEW.taxable_amount > 0.01 OR NEW.vat_amount <= 0.01)
  , false) THEN
    RAISE EXCEPTION 'pos_credit_notes: the amounts on this Credit Note do not match the bill it credits'
      USING ERRCODE = '23514', HINT = 'credit_note_amounts',
            DETAIL = format('note gross %s, discount %s, taxable %s, non-taxable %s, VAT %s, net %s; bill lines %s, discount %s, paid %s',
                            NEW.gross_amount, NEW.discount_amount, NEW.taxable_amount, NEW.non_taxable_amount,
                            NEW.vat_amount, NEW.net_amount, v_lines, COALESCE(v_order.discount_amount, 0),
                            v_order.paid_amount);
  END IF;

  -- ── S828 5d (CREDIT-NOTES-5, server half): the note names its bill as the bill was printed ───
  -- Kept as the request sent them until now. The label is Issue Credit Note's invoiceLabel(): TI
  -- for a Tax Invoice or PB for a PAN bill, by the bill's own VAT stamp (S809 2c; today's setting
  -- only for an unstamped bill, as billVatRegistered reads it), the number, then today's invoice
  -- prefix, as the page reads it (the prefix is not stored on the bill), and the bill's year:
  -- "TI1147-BC-83/84", "PB12-83/84". The Miti is the Nepali date the bill closed, read in Nepal:
  -- "27 Ashwin 2083", nepalBsLong's form, from bs_months (pos_invoice_fy's table; change the two
  -- together). Past that table's end it is the AD day, "2031-04-14 (AD)", as the page falls back.
  -- A billed bill always has closed_at; were it missing, the sent date would stand.
  SELECT s.is_vat_registered, s.invoice_prefix INTO v_vat_now, v_prefix
    FROM settings s WHERE s.client_id = NEW.client_id;
  v_vat_reg := COALESCE(v_order.vat_registered, v_vat_now, true);
  v_prefix  := COALESCE(v_prefix, '');
  NEW.original_invoice_no    := v_order.invoice_no;
  NEW.original_invoice_label := CASE WHEN v_vat_reg THEN 'TI' ELSE 'PB' END || v_order.invoice_no::text || '-'
                                || v_prefix || CASE WHEN v_prefix <> '' THEN '-' ELSE '' END
                                || COALESCE(v_order.invoice_fy, '');
  v_day := (v_order.closed_at AT TIME ZONE 'Asia/Kathmandu')::date;
  SELECT m.bs_year, m.bs_month, (v_day - m.ad_start) + 1
    INTO v_bs_year, v_bs_month, v_bs_day
    FROM bs_months m
   WHERE v_day >= m.ad_start AND v_day < m.ad_start + m.days;
  NEW.original_invoice_date_bs := COALESCE(
    v_bs_day::text || ' ' || v_months[v_bs_month] || ' ' || v_bs_year::text,
    to_char(v_day, 'YYYY-MM-DD') || ' (AD)',
    NEW.original_invoice_date_bs);
  -- ── end S828 5d ──────────────────────────────────────────────────────────────────────────

  -- ── S809 2b (CREDIT-NOTES-4): the note's year is Nepal's date at this instant ───────────────
  -- It picks the numbered series the note joins, and trg_assign_pos_credit_note_no fires after this
  -- trigger (guard_ sorts before trg_), so the request's year is ignored: a tablet on another time
  -- zone or a wrong date cannot file the note in last year's series, and a REST insert cannot name
  -- a closed year or start a new series with a stray string. The restore (above) keeps its year.
  NEW.invoice_fy := public.pos_invoice_fy(now());
  IF NEW.invoice_fy IS NULL THEN
    RAISE EXCEPTION 'pos_credit_notes: today''s date is past the end of Crest''s Nepali calendar, so no credit note number can be given and no note was issued — contact Crest support'
      USING ERRCODE = 'P0001', HINT = 'pos_fiscal_year_unknown';
  END IF;
  -- ── end S809 2b ──────────────────────────────────────────────────────────────────────────

  NEW.issued_by := (SELECT auth.uid());
  -- ── S809 2e (S809.4): the printed Date and Miti are read from created_at, so it is the server's ─
  -- The screen never sends it; a REST insert that did kept it and printed a backdated note. The
  -- restore (above) keeps the time a note was first issued.
  NEW.created_at := now();
  -- ── end S809 2e ──────────────────────────────────────────────────────────────────────────
  NEW.credit_note_no := NULL;   -- numbered by trg_assign_pos_credit_note_no, never by the request
  NEW.ims_posted_at := NULL;
  NEW.print_count := 0;
  RETURN NEW;
END;
$function$;


-- ── 4. The till floor: crest-v448 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_min_till_build()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT 448
$$;


-- ── 5. Prove it ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_today   date := (now() AT TIME ZONE 'Asia/Kathmandu')::date;
  v_client  uuid;
  v_period  uuid;
  v_start   date;
  v_mgr     uuid;
  v_owner   uuid;
  v_admin   uuid;
  v_fy      text;
  v_day1    timestamptz;
  v_chicken uuid;
  v_wrap    uuid;
  v_b1 uuid; v_b2 uuid; v_b3 uuid; v_b4 uuid; v_b5 uuid;
  v_n1 uuid; v_n3 uuid; v_n4 uuid; v_n5 uuid;
  v_row     uuid;
  v_r       jsonb;
  v_who     record;
  v_hint    text;
  v_msg     text;
BEGIN
  -- ── Where: a POS outlet with Inventory, an open month holding today, an Owner and an unblocked
  --    POS manager till login; and the operator ───────────────────────────────────────────────────
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
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 probe: no POS outlet with Inventory, an open month holding today, an Owner and an unblocked POS manager';
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
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'S832 5f-4 step 2 probe: no operator login';
  END IF;
  v_fy   := public.pos_invoice_fy(now());
  v_day1 := (v_start + time '00:15') AT TIME ZONE 'Asia/Kathmandu';

  BEGIN
    -- ── Setup, as the migration's own role: a dish and five PAN bills, each posted as it closes ──
    UPDATE public.clients SET ims_since = NULL WHERE id = v_client;
    INSERT INTO public.items (client_id, name, uom, purchase_qty, rate, yield_pct)
      VALUES (v_client, 'S832 5f-4b probe chicken', 'kg', 1, 0, 85) RETURNING id INTO v_chicken;
    INSERT INTO public.recipes (client_id, name, category, yield_qty)
      VALUES (v_client, 'S832 5f-4b probe wrap', 'Food', 1) RETURNING id INTO v_wrap;
    INSERT INTO public.recipe_ingredients (recipe_id, item_id, qty_per_portion) VALUES (v_wrap, v_chicken, 0.3);
    -- order_no is given, so the probe takes no lock on the outlet's real order series.
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990851, 'S832 5f-4b probe') RETURNING id INTO v_b1;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990852, 'S832 5f-4b probe') RETURNING id INTO v_b2;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990853, 'S832 5f-4b probe') RETURNING id INTO v_b3;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990854, 'S832 5f-4b probe') RETURNING id INTO v_b4;
    INSERT INTO public.pos_orders (client_id, order_no, table_name) VALUES (v_client, 990855, 'S832 5f-4b probe') RETURNING id INTO v_b5;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_b1, v_client, 'S832 5f-4b probe wrap', v_wrap, 1, 300, 0),
      (v_b2, v_client, 'S832 5f-4b probe wrap', v_wrap, 1, 300, 0),
      (v_b3, v_client, 'S832 5f-4b probe wrap', v_wrap, 1, 300, 0),
      (v_b4, v_client, 'S832 5f-4b probe wrap', v_wrap, 1, 300, 0),
      (v_b5, v_client, 'S832 5f-4b probe wrap', v_wrap, 1, 300, 0);
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 300,
           vat_registered = false, invoice_fy = v_fy, closed_at = v_day1
     WHERE id IN (v_b1, v_b2, v_b3, v_b4, v_b5);
    IF (SELECT count(*) FROM public.pos_orders WHERE id IN (v_b1, v_b2, v_b3, v_b4, v_b5) AND ims_posted_at IS NOT NULL) <> 5 THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: the fixture bills were not posted at their close';
    END IF;

    -- ── Notes, as the outlet's POS manager, on a page of this release ──────────────────────────
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v448"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;
    -- (1) A "not served" note still posts as it is issued, its stock put back, under the new guards.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b1, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4b probe', 'none', true, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n1;
    RESET ROLE;
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n1) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n1 AND source = 'pos_credit_restock' AND qty_sold = -1) <> 1
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b1 AND source = 'pos_credit_restock'
            AND item_id = v_chicken AND abs(qty - 0.3 / 0.85) < 1e-9) <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: the issue no longer posts a not-served note with its stock';
    END IF;

    -- (2) N3 and N4 are issued while Inventory is off, so they wait, unmarked.
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b3, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4b probe', 'none', false, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n3;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b4, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4b probe', 'none', false, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n4;
    RESET ROLE;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    UPDATE public.clients SET ims_since = NULL WHERE id = v_client;
    IF (SELECT count(*) FROM public.pos_credit_notes WHERE id IN (v_n3, v_n4) AND ims_posted_at IS NULL) <> 2 THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: a note issued with Inventory off was marked';
    END IF;

    -- (3) A note's reversal row, its "not served" reversal row, its stock put back, and its mark, each
    --     from the manager, the Owner and the operator (not a restore), are refused as the server's.
    SET LOCAL ROLE authenticated;
    FOR v_who IN SELECT * FROM (VALUES ('manager', v_mgr), ('Owner', v_owner), ('operator', v_admin)) x(label, id) LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_who.id)::text, true);
      v_hint := NULL;
      BEGIN
        INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
          VALUES (v_period, v_wrap, 1, -1, 'pos_credit', 300, 0, v_n4);
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'pos_credit_server_only' THEN
        RAISE EXCEPTION 'S832 5f-4 step 2 probe: a credit note reversal from the % answered % (%)', v_who.label, COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
      v_hint := NULL;
      BEGIN
        INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
          VALUES (v_period, v_wrap, 1, -1, 'pos_credit_restock', 300, 0, v_n1);
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'pos_credit_server_only' THEN
        RAISE EXCEPTION 'S832 5f-4 step 2 probe: a not-served reversal from the % answered % (%)', v_who.label, COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
      v_hint := NULL;
      BEGIN
        INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id)
          VALUES (v_client, v_chicken, v_period, 1, 0.3, 'pos_credit_restock', v_b4);
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'pos_credit_server_only' THEN
        RAISE EXCEPTION 'S832 5f-4 step 2 probe: stock put back by the % answered % (%)', v_who.label, COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
      v_hint := NULL;
      BEGIN
        UPDATE public.pos_credit_notes SET ims_posted_at = now() WHERE id = v_n4;
      EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'pos_credit_server_only' THEN
        RAISE EXCEPTION 'S832 5f-4 step 2 probe: the % marking a note as in Inventory answered % (%)', v_who.label, COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
    END LOOP;

    -- (4) The Owner's hand-entered sale still lands; turning it into a note's reversal is refused.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_owner)::text, true);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate)
      VALUES (v_period, v_wrap, 2, 1, 'manual', 300, 0) RETURNING id INTO v_row;
    v_hint := NULL;
    BEGIN
      UPDATE public.sales_entries SET source = 'pos_credit' WHERE id = v_row;
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_credit_server_only' THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: the Owner turning a hand-entered sale into a reversal answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (5) The operator's restore still re-inserts a note's reversal and its stock as they were, and
    --     the reversal marks the note.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id, created_at)
      VALUES (v_period, v_wrap, 1, -1, 'pos_credit', 300, 0, v_n4, now() - interval '1 day');
    INSERT INTO public.stock_movements (client_id, item_id, period_id, bs_day, qty, source, ref_id, created_at)
      VALUES (v_client, v_chicken, v_period, 1, 0.3 / 0.85, 'pos_credit_restock', v_b4, now() - interval '1 day');
    RESET ROLE;
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n4) IS NULL
       OR (SELECT count(*) FROM public.stock_movements WHERE ref_id = v_b4 AND source = 'pos_credit_restock') <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: the operator''s restore of a note''s reversal and stock did not land';
    END IF;

    -- (6) The server's post of waiting notes still writes, for the manager: N3 goes in.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;
    v_r := public.post_waiting_credit_notes(v_period, 200);
    RESET ROLE;
    IF (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n3) IS NULL
       OR (SELECT count(*) FROM public.sales_entries WHERE pos_credit_note_id = v_n3 AND source = 'pos_credit') <> 1 THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: the server''s post of the waiting notes did not post N3: %', v_r;
    END IF;

    -- (7) The till floor: a crest-v447 page is turned away from issuing a note (its bill is marked
    --     credited, a gated write), and nothing of it is left; crest-v448 issues it, posted.
    IF public.pos_min_till_build() IS DISTINCT FROM 448 THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: the till floor is %, not 448', public.pos_min_till_build();
    END IF;
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v447"}', true);
    SET LOCAL ROLE authenticated;
    v_hint := NULL;
    BEGIN
      INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
          original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
          non_taxable_amount, vat_amount, net_amount)
        VALUES (v_client, v_b5, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4b probe', 'none', false, 300, 0, 0, 300, 0, 300);
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_till_build_too_old' THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: a crest-v447 page issuing a note answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v448"}', true);
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_b5, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S832 5f-4b probe', 'none', false, 300, 0, 0, 300, 0, 300)
      RETURNING id INTO v_n5;
    RESET ROLE;
    IF (SELECT count(*) FROM public.pos_credit_notes WHERE order_id = v_b5) <> 1
       OR (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_n5) IS NULL THEN
      RAISE EXCEPTION 'S832 5f-4 step 2 probe: the refused crest-v447 note left a trace, or the crest-v448 one was not posted';
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's832_5f4b_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's832_5f4b_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 6. What this step acts on, live (the last statement, so `db query` prints it) ─────────────
SELECT
  public.pos_min_till_build() AS till_floor,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure) AS sales_guard_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ims_stock_movements_guard()'::regprocedure) AS stock_guard_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure) AS note_guard_md5,
  (SELECT string_agg(t.tgname || ':' || t.tgenabled::text, ', ' ORDER BY t.tgname) FROM pg_trigger t
    WHERE NOT t.tgisinternal
      AND t.tgfoid IN ('public.ims_sales_entries_guard()'::regprocedure, 'public.ims_stock_movements_guard()'::regprocedure,
                       'public.guard_pos_credit_note()'::regprocedure)) AS guard_triggers,
  (SELECT count(*) FROM public.pos_credit_notes WHERE ims_posted_at IS NULL) AS notes_waiting;
