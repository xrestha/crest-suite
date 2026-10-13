-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S828, POS stage 5, slice 5d: a credit note names its bill as the bill was printed, its copies are
-- counted by the server, and Inventory takes a till's sales only as the records they claim to be.
--
--   CREDIT-NOTES-5, server half. The Original Invoice No., its label and its Miti print on every
--   credit note (VAT Rules 2053 r.20(1)(e)), and guard_pos_credit_note kept them as the request sent
--   them, so a REST insert could print any bill number and date on a numbered tax document. They are
--   now the bill's: its number; its label as Issue Credit Note builds it; the Nepali date it closed.
--   Checked live 2026-10-13: both notes issued so far store exactly what this derives (section 3
--   re-checks every live note at apply time). The page still sends them (the columns are NOT NULL)
--   and is overwritten with the same values.
--
--   The credit-note copy counter (S809.4, 1c / 4c). A reprint's "COPY OF ORIGINAL - (n)" label comes
--   from print_count, which took the higher of the stored and the sent count. Two managers reprinting
--   one note at the same moment each sent their page's count + 1, so both stored one count and printed
--   the same copy number. Now any print_count that differs from the stored one becomes the stored
--   one + 1, the parking slip's rule (pos_parking_slips_guard, S814): the page sends -1 and labels
--   from the count the write returns (crest-v443). An older page still sends its count + 1, which is
--   now counted right; only its own label is still worked out on the page.
--
--   ims_sales_entries_guard (S809.4 3j, 4e). Three things, on INSERT and UPDATE:
--   (a) each kind of row names only its own record. The "already posted?" reads (the floor, Periods,
--       the note screen) ask by pos_order_id or pos_credit_note_id without looking at source, so a
--       hand-entered row naming a bill, a till sale naming a note or a note's reversal naming a bill
--       made a bill or a note look posted when it was not. Live: 11,910 pos and 26 pos_comp rows name
--       a bill and no note, 3 pos_credit rows a note and no bill, 1,890 manual rows neither.
--   (b) a till row (pos, pos_comp, pos_credit, pos_credit_restock) is refused for an outlet whose
--       clients.ims_enabled is false (pos_outlet_no_ims). The page already posts nothing there (4e,
--       D6/D7); this is the table's half. NULL counts as on, as the app's `?? true` reads it. Live:
--       every POS outlet has Inventory on, so nothing live is refused.
--   (c) a credit note's reversal names a note of the month's own outlet (pos_credit_note_other_outlet).
--       sales_entries_stamp_pos_source let such a row in unmarked ("left as before"), so another
--       outlet's revenue could be taken off this one's month.
--   The operator was waved through everything here although the function's own comment said only
--   its restore was. It now keeps its restore (an insert dated before the transaction, or with no
--   date, as the stamp trigger reads it) and its corrections (updates and deletes); any other insert
--   meets (a) to (c), and only the rank block is skipped for it ("exempt from rank, never from the
--   record", pos-billing.md). The Owner meets them too.
--
-- Not in this slice: the comp-cost read the stage plan listed (2f). The two screens it was for,
-- the bill viewer and the Customization report, switch to the existing pos_recipe_book in the app
-- (crest-v443). The IMS logins it was meant to admit cannot read till bills at all (no_ims_staff),
-- so a new read would have opened costs to nobody who could use them.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-13: guard_pos_credit_note
-- 5d47faa30c2b2ebccca7d1abab6d335a and ims_sales_entries_guard 492abc0353f288a2bcb9daba12f60434
-- (both last written by 20261009210000). Section 0 refuses any other body. Signatures, return types,
-- SECURITY (both INVOKER) and search_path are unchanged, so CREATE OR REPLACE keeps both triggers
-- attached. No RPC changes shape, so no schema reload. No till build floor change: nothing here
-- changes what a till sends to pos_orders or pos_order_items.
--
-- Deploy order: this file, then the app release crest-v443, which sends -1 for a credit-note print
-- and reads the count back. An older page works against this file as before.
--
-- To undo: re-run both CREATE OR REPLACE statements from 20261009210000 (the md5s above), then
-- revert the app. The new app against the old guard prints with "its reprint count could not be
-- saved" (the old guard keeps the higher count, so -1 changes nothing and the page notices).
--
-- The probe at the end acts as a POS outlet's manager and supervisor till logins and as the
-- operator, inside a block that rolls itself back. For a second or so it holds that outlet's
-- invoice and credit-note number locks (numbers are the highest + 1, so a rollback uses none up)
-- and its clients row, so a till closing a bill there in that moment waits for it. If any check
-- fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight: the bodies this file replaces ─────────────────────────────────────────────
-- Each second hash is the body this migration writes, so a re-run passes.
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('5d47faa30c2b2ebccca7d1abab6d335a', '181ee4ec9c5a4656fcbd33eee08a0422') THEN
    RAISE EXCEPTION 'S828 5d pre-flight: guard_pos_credit_note changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('492abc0353f288a2bcb9daba12f60434', 'fb3674837ab09d384f2f089190672158') THEN
    RAISE EXCEPTION 'S828 5d pre-flight: ims_sales_entries_guard changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
END;
$$;


-- ── 1. A credit note: its bill's own references, and copies counted by the server ─────────────
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
      ELSIF NOT COALESCE(public.pos_caller_has_rank('manager'), false) THEN
        RAISE EXCEPTION 'pos_credit_notes: marking a Credit Note as posted to Inventory needs POS Manager access or above'
          USING ERRCODE = '42501', HINT = 'rank_required';
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


-- ── 2. Inventory's sales: each row names its own record, at an outlet with Inventory ──────────
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


-- ── 3. Prove it ───────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_months CONSTANT text[] := ARRAY['Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
                                    'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
  v_client  uuid;
  v_period  uuid;
  v_other   uuid;
  v_operiod uuid;
  v_mgr     uuid;
  v_sup     uuid;
  v_admin   uuid;
  v_prefix  text;
  v_fy      text;
  v_recipe  uuid;
  v_bill_pb uuid;
  v_bill_ti uuid;
  v_bill_c  uuid;
  v_note_a  uuid;
  v_note_b  uuid;
  v_note_c  uuid;
  v_row     record;
  v_expect  text;
  v_n       bigint;
  v_hint    text;
  v_msg     text;
BEGIN
  -- Catalog: both guards still INVOKER with their triggers attached and enabled.
  IF (SELECT count(*) FROM pg_proc WHERE NOT prosecdef AND oid IN (
        'public.guard_pos_credit_note()'::regprocedure, 'public.ims_sales_entries_guard()'::regprocedure)) <> 2 THEN
    RAISE EXCEPTION 'S828 5d: a replaced guard changed its SECURITY';
  END IF;
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE NOT tgisinternal AND tgenabled = 'O'
     AND ((tgrelid = 'public.pos_credit_notes'::regclass AND tgname = 'guard_pos_credit_note')
       OR (tgrelid = 'public.sales_entries'::regclass AND tgname = 'ims_rank_guard'));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'S828 5d: % of the 2 guard triggers are attached and enabled', v_n;
  END IF;

  -- Live parity: every note issued so far stores what the guard now derives. The stored values are
  -- the page's (invoiceLabel, nepalBsLong), so this is the JS twin checked against the SQL one on
  -- real bills. The expressions below are written out again on purpose, not read from the guard.
  FOR v_row IN
    SELECT n.credit_note_no, n.original_invoice_no, n.original_invoice_label, n.original_invoice_date_bs,
           o.invoice_no, o.invoice_fy,
           COALESCE(o.vat_registered, s.is_vat_registered, true) AS vat,
           COALESCE(s.invoice_prefix, '') AS prefix,
           (o.closed_at AT TIME ZONE 'Asia/Kathmandu')::date AS d
      FROM public.pos_credit_notes n
      JOIN public.pos_orders o ON o.id = n.order_id
      LEFT JOIN public.settings s ON s.client_id = n.client_id
  LOOP
    SELECT (v_row.d - m.ad_start + 1)::text || ' ' || v_months[m.bs_month] || ' ' || m.bs_year::text
      INTO v_expect
      FROM public.bs_months m WHERE v_row.d >= m.ad_start AND v_row.d < m.ad_start + m.days;
    IF v_row.original_invoice_no IS DISTINCT FROM v_row.invoice_no
       OR v_row.original_invoice_label IS DISTINCT FROM
          format('%s%s-%s%s%s', CASE WHEN v_row.vat THEN 'TI' ELSE 'PB' END, v_row.invoice_no,
                 v_row.prefix, CASE WHEN v_row.prefix <> '' THEN '-' ELSE '' END, COALESCE(v_row.invoice_fy, ''))
       OR v_row.original_invoice_date_bs IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'S828 5d probe: CN% stores % / % / %, which the server would not write (it derives % and %)',
        v_row.credit_note_no, v_row.original_invoice_no, v_row.original_invoice_label, v_row.original_invoice_date_bs,
        v_row.invoice_no, v_expect;
    END IF;
  END LOOP;

  -- ── Who acts: BLOOM CAFE (or the first POS outlet with an open month, an unblocked manager
  --    and supervisor till login), the operator, and another outlet's open month ──────────────
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled
     AND EXISTS (SELECT 1 FROM public.monthly_periods mp WHERE mp.client_id = c.id AND mp.status = 'open')
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S828 5d probe: no POS outlet with an open month, a settings row and unblocked manager and supervisor till logins';
  END IF;
  SELECT id INTO v_period FROM public.monthly_periods WHERE client_id = v_client AND status = 'open';
  SELECT p.id INTO v_mgr FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_sup FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'supervisor' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' ORDER BY id LIMIT 1;
  SELECT mp.id, mp.client_id INTO v_operiod, v_other
    FROM public.monthly_periods mp JOIN public.clients c ON c.id = mp.client_id
   WHERE mp.status = 'open' AND mp.client_id <> v_client
   ORDER BY (c.name = 'BLOOM CAFE - PKR') DESC, c.name LIMIT 1;
  IF v_admin IS NULL OR v_operiod IS NULL THEN
    RAISE EXCEPTION 'S828 5d probe: no operator login, or no other outlet with an open month';
  END IF;
  SELECT COALESCE(invoice_prefix, '') INTO v_prefix FROM public.settings WHERE client_id = v_client;
  v_fy := public.pos_invoice_fy(now());

  BEGIN
    -- Setup, as the migration's own role (every guard lets it through): a test dish, and three paid
    -- bills of one NPR 100 line each, closed at 00:15 on 13 October 2026 in Nepal (18:30 the day
    -- before in UTC, so a date read in UTC would be a day early): a PAN bill (A), a Tax Invoice (B,
    -- NPR 113 with VAT) and a PAN bill for the restore (C). The numbering trigger gives each its
    -- invoice number.
    INSERT INTO public.recipes (client_id, name) VALUES (v_client, 'S828 5d probe dish') RETURNING id INTO v_recipe;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_bill_pb;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_bill_ti;
    INSERT INTO public.pos_orders (client_id) VALUES (v_client) RETURNING id INTO v_bill_c;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate) VALUES
      (v_bill_pb, v_client, 'S828 5d probe dish', v_recipe, 1, 100, 0),
      (v_bill_ti, v_client, 'S828 5d probe dish', v_recipe, 1, 100, 0.13),
      (v_bill_c,  v_client, 'S828 5d probe dish', v_recipe, 1, 100, 0);
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0,
           paid_amount = CASE WHEN id = v_bill_ti THEN 113 ELSE 100 END,
           vat_registered = (id = v_bill_ti), invoice_fy = v_fy,
           closed_at = '2026-10-12 18:30:00+00'
     WHERE id IN (v_bill_pb, v_bill_ti, v_bill_c);

    -- From here on, the outlet's POS manager on a till of this release.
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v999"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;

    -- (1) A note on the PAN bill sending made-up references stores the bill's own.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_bill_pb, '00/01', 999999, 'FAKE', '1 Baisakh 2000', 'S828 5d probe', 'none', false,
              100, 0, 0, 100, 0, 100)
      RETURNING id INTO v_note_a;
    SELECT n.original_invoice_no, n.original_invoice_label, n.original_invoice_date_bs, n.print_count, o.invoice_no
      INTO v_row
      FROM public.pos_credit_notes n JOIN public.pos_orders o ON o.id = n.order_id WHERE n.id = v_note_a;
    IF v_row.original_invoice_no IS DISTINCT FROM v_row.invoice_no
       OR v_row.original_invoice_label IS DISTINCT FROM
          format('PB%s-%s%s%s', v_row.invoice_no, v_prefix, CASE WHEN v_prefix <> '' THEN '-' ELSE '' END, v_fy)
       OR v_row.original_invoice_date_bs IS DISTINCT FROM '27 Ashwin 2083'
       OR v_row.print_count <> 0 THEN
      RAISE EXCEPTION 'S828 5d probe: a PAN bill''s note stored % / % / % (print count %), bill %',
        v_row.original_invoice_no, v_row.original_invoice_label, v_row.original_invoice_date_bs, v_row.print_count, v_row.invoice_no;
    END IF;

    -- (2) A note on the Tax Invoice, food not served: labelled TI.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount)
      VALUES (v_client, v_bill_ti, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S828 5d probe', 'none', true,
              100, 0, 100, 0, 13, 113)
      RETURNING id INTO v_note_b;
    SELECT n.original_invoice_label, o.invoice_no INTO v_row
      FROM public.pos_credit_notes n JOIN public.pos_orders o ON o.id = n.order_id WHERE n.id = v_note_b;
    IF v_row.original_invoice_label IS DISTINCT FROM
       format('TI%s-%s%s%s', v_row.invoice_no, v_prefix, CASE WHEN v_prefix <> '' THEN '-' ELSE '' END, v_fy) THEN
      RAISE EXCEPTION 'S828 5d probe: a Tax Invoice''s note stored label % (bill %)', v_row.original_invoice_label, v_row.invoice_no;
    END IF;

    -- (3) Copies: -1 → 1, -1 → 2, 7 → 3, the stored 3 again → 3. A changed reason is still refused.
    UPDATE public.pos_credit_notes SET print_count = -1 WHERE id = v_note_a;
    UPDATE public.pos_credit_notes SET print_count = -1 WHERE id = v_note_a;
    SELECT print_count INTO v_n FROM public.pos_credit_notes WHERE id = v_note_a;
    IF v_n <> 2 THEN RAISE EXCEPTION 'S828 5d probe: two prints sending -1 stored %', v_n; END IF;
    UPDATE public.pos_credit_notes SET print_count = 7 WHERE id = v_note_a;
    UPDATE public.pos_credit_notes SET print_count = 3 WHERE id = v_note_a;
    SELECT print_count INTO v_n FROM public.pos_credit_notes WHERE id = v_note_a;
    IF v_n <> 3 THEN RAISE EXCEPTION 'S828 5d probe: a print sending 7, then the stored count, stored %', v_n; END IF;
    v_hint := NULL;
    BEGIN
      UPDATE public.pos_credit_notes SET reason = 'changed' WHERE id = v_note_a;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'bill_locked' THEN
      RAISE EXCEPTION 'S828 5d probe: changing a note''s reason answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- (4) Inventory: a row naming the wrong kind of record is refused, whatever else it would meet.
    FOR v_row IN
      SELECT * FROM (VALUES
        ('manual',     v_bill_pb, NULL::uuid, 'a hand-entered sale naming a bill'),
        ('pos',        v_bill_pb, v_note_a,   'a till sale naming a note'),
        ('pos_credit', v_bill_pb, v_note_a,   'a note''s reversal naming a bill'),
        ('pos_credit', NULL,      NULL,       'a note''s reversal naming no note')
      ) AS t(source, bill, note, what)
    LOOP
      v_hint := NULL;
      BEGIN
        INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id, pos_credit_note_id)
          VALUES (v_period, v_recipe, 1, CASE WHEN v_row.source = 'pos_credit' THEN -1 ELSE 1 END, v_row.source, 100, 0, v_row.bill, v_row.note);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
      END;
      IF v_hint IS DISTINCT FROM 'sales_entry_link_mismatch' THEN
        RAISE EXCEPTION 'S828 5d probe: % answered % (%)', v_row.what, COALESCE(v_hint, 'nothing'), v_msg;
      END IF;
    END LOOP;

    -- Controls: the PAN bill's sale and its note's reversal land and mark both; the "not served"
    -- note's reversal posted as an ordinary one is still refused, and as a put-back it lands.
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_period, v_recipe, 1, 1, 'pos', 100, 0, v_bill_pb);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
      VALUES (v_period, v_recipe, 1, -1, 'pos_credit', 100, 0, v_note_a);
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_bill_pb) IS NULL
       OR (SELECT ims_posted_at FROM public.pos_credit_notes WHERE id = v_note_a) IS NULL THEN
      RAISE EXCEPTION 'S828 5d probe: a manager''s post of a bill and its note did not mark both';
    END IF;
    v_hint := NULL;
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
        VALUES (v_period, v_recipe, 1, -1, 'pos_credit', 100, 0, v_note_b);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'credit_note_restock_mismatch' THEN
      RAISE EXCEPTION 'S828 5d probe: a "not served" note posted as an ordinary reversal answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
      VALUES (v_period, v_recipe, 1, -1, 'pos_credit_restock', 100, 0, v_note_b);

    -- (5) The operator outside a restore: a reversal in another outlet's month naming this outlet's
    --     note is refused. Restored (dated yesterday), the operator's rows pass as before.
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    v_hint := NULL;
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_credit_note_id)
        VALUES (v_operiod, v_recipe, 1, -1, 'pos_credit', 100, 0, v_note_a);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_credit_note_other_outlet' THEN
      RAISE EXCEPTION 'S828 5d probe: the operator''s reversal in another outlet''s month answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;

    -- A restored note (dated yesterday) keeps the references it sends.
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount, created_at)
      VALUES (v_client, v_bill_c, v_fy, 424242, 'RESTORED-LABEL', '1 Baisakh 2083', 'S828 5d probe restore', 'none', false,
              100, 0, 0, 100, 0, 100, now() - interval '1 day')
      RETURNING id INTO v_note_c;
    SELECT original_invoice_no, original_invoice_label INTO v_row FROM public.pos_credit_notes WHERE id = v_note_c;
    IF v_row.original_invoice_no <> 424242 OR v_row.original_invoice_label <> 'RESTORED-LABEL' THEN
      RAISE EXCEPTION 'S828 5d probe: a restored note stored % / %', v_row.original_invoice_no, v_row.original_invoice_label;
    END IF;

    -- (6) Inventory switched off for the outlet: a supervisor's till sale is refused; the operator's
    --     restore of one and an operator's hand-entered sale still land. Then on again: it lands.
    RESET ROLE;
    UPDATE public.clients SET ims_enabled = false WHERE id = v_client;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sup)::text, true);
    v_hint := NULL;
    BEGIN
      INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
        VALUES (v_period, v_recipe, 1, 1, 'pos', 100, 0.13, v_bill_ti);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_msg = MESSAGE_TEXT;
    END;
    IF v_hint IS DISTINCT FROM 'pos_outlet_no_ims' THEN
      RAISE EXCEPTION 'S828 5d probe: a till sale at an outlet without Inventory answered % (%)', COALESCE(v_hint, 'nothing'), v_msg;
    END IF;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_admin)::text, true);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id, created_at)
      VALUES (v_period, v_recipe, 1, 1, 'pos', 100, 0, v_bill_c, now() - interval '1 day');
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate)
      VALUES (v_period, v_recipe, 1, 1, 'manual', 100, 0);
    RESET ROLE;
    UPDATE public.clients SET ims_enabled = true WHERE id = v_client;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_sup)::text, true);
    INSERT INTO public.sales_entries (period_id, recipe_id, bs_day, qty_sold, source, unit_price, vat_rate, pos_order_id)
      VALUES (v_period, v_recipe, 1, 1, 'pos', 100, 0.13, v_bill_ti);
    IF (SELECT ims_posted_at FROM public.pos_orders WHERE id = v_bill_ti) IS NULL THEN
      RAISE EXCEPTION 'S828 5d probe: a supervisor''s post of the Tax Invoice did not mark it';
    END IF;

    RESET ROLE;
    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's828_5d_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's828_5d_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


-- ── 4. What this slice acts on, live (the last statement, so `db query` prints it) ────────────
SELECT
  (SELECT count(*) FROM public.pos_credit_notes) AS credit_notes,
  (SELECT count(*) FROM public.clients WHERE pos_enabled AND ims_enabled IS FALSE) AS pos_outlets_without_ims,
  (SELECT count(*) FROM public.sales_entries
    WHERE (COALESCE(source, 'manual') = 'manual' AND (pos_order_id IS NOT NULL OR pos_credit_note_id IS NOT NULL))
       OR (source IN ('pos', 'pos_comp') AND pos_credit_note_id IS NOT NULL)
       OR (source IN ('pos_credit', 'pos_credit_restock') AND pos_order_id IS NOT NULL)) AS rows_naming_the_wrong_record,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure) AS credit_note_md5,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.ims_sales_entries_guard()'::regprocedure) AS sales_guard_md5;

-- Read back after applying (one statement per call):
--   SELECT p.proname, md5(prosrc), prosecdef FROM pg_proc p
--    WHERE p.oid IN ('public.guard_pos_credit_note()'::regprocedure, 'public.ims_sales_entries_guard()'::regprocedure);
--     expect the second hash of each in section 0, prosecdef f / f.
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgname IN ('guard_pos_credit_note', 'ims_rank_guard') AND NOT tgisinternal;   -- both O
