-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S834, POS small leftovers: a guest QR order nobody answers is turned away after 30 minutes, a bill
-- and a credit note keep the invoice code they were printed with, and a dead PIN-lock check goes.
--
--   D34 (owner, 2026-10-14). A guest order nobody accepted, on a table that never got a bill, rang on
--   every till for ever (get_pos_device_guest_alerts has no age limit; S809.4, 4i), and it also kept
--   the table's one waiting place (pos_guest_order_requests_one_pending_per_table), so the table could
--   not order again. Now one that has waited pos_guest_order_stale_after() (30 minutes) is turned away
--   ('dismissed', decided_by empty) by pos_turn_away_stale_guest_orders, which runs from:
--   * get_guest_order_progress, the guest page's own poll (now VOLATILE, same answer), and the older
--     get_guest_order_request_status it falls back to (now plpgsql and VOLATILE, same answer);
--   * submit_guest_order, for its table, before the one-waiting-place insert;
--   * get_pos_device_guest_alerts, the PIN screen's banner read (now VOLATILE);
--   * turn_away_stale_guest_orders(), new, for the tills (authenticated, the caller's own outlet).
--
--   D35 (owner, 2026-10-14). The printed bill number is put together at print time from
--   settings.invoice_prefix, so changing the code relabelled every bill and credit note already
--   issued (settings-row.md). New columns pos_orders.invoice_prefix and pos_credit_notes.invoice_prefix:
--   * pos_orders_stamp_invoice_prefix (BEFORE INSERT / UPDATE, DEFINER, two triggers): the close
--     stamps the outlet's code as it stands, an open order carries none, a closed bill keeps its own,
--     and the operator's restore keeps a backup's. After guard_pos_order_close by name, which already
--     refuses a client changing a closed bill's columns.
--   * guard_pos_credit_note stamps the note's own code at issue and names its bill under the bill's
--     stamped code (today's only for a bill closed before this file). Locked once issued.
--   NULL on every row before this file means "printed under today's code", as the screens read it now.
--
--   check_pos_pin_lock(uuid) is dropped: no caller since pos-staff-login v11 (S829). Its HR and IMS
--   twins stay while their login functions are still deployed.
--
-- Built on the live bodies, md5(prosrc), read 2026-10-14: guard_pos_credit_note
-- 0d8903dbac7ea38f51a46150e9f3d526 (20261013210000), submit_guest_order b4312146f6c5da5e01f3d51c9fe99936
-- (20261010120000), get_pos_device_guest_alerts 7f534b42d95ff5c5b5a811d424b86c62 (20261010150000),
-- get_guest_order_request_status f6a8b19004636e952957678a669a6d82 (20260707210000), get_guest_order_progress
-- da520833ee99b22acf79366b1372361e (20261010120000), check_pos_pin_lock
-- 0e27c2114eb8b3564258f8758f26d571. Each replaced body is the live one with only the marked S834 lines
-- added, except get_guest_order_request_status, rewritten. Signatures and return types are unchanged,
-- so CREATE OR REPLACE keeps grants and triggers. Each second hash in section 0 is the body this file
-- writes, so a re-run passes.
--
-- No app is required first: an older till never sends the new columns, and still prints under
-- today's code. crest-v450 prints from the stamp and calls turn_away_stale_guest_orders. No till
-- floor change.
--
-- To undo: DROP TRIGGER pos_orders_stamp_invoice_prefix and pos_orders_stamp_invoice_prefix_ins ON
-- pos_orders, DROP FUNCTION pos_orders_stamp_invoice_prefix(); re-create guard_pos_credit_note,
-- submit_guest_order, get_pos_device_guest_alerts, get_guest_order_progress and
-- get_guest_order_request_status from the files named above (the last three as STABLE again, the
-- last as LANGUAGE sql); DROP FUNCTION
-- turn_away_stale_guest_orders(), pos_turn_away_stale_guest_orders(uuid, uuid),
-- pos_guest_order_stale_after(); then the two columns. check_pos_pin_lock from 20260810190000.
--
-- The probe (section 6) acts at BLOOM CAFE (or the first POS outlet with three free tables and an
-- unblocked POS manager) as the migration's role, an anonymous guest and that manager, inside a block
-- that rolls itself back. It holds the outlet's invoice-number and credit-note-number locks for a
-- moment, so a till closing a bill there in that moment waits. If any check fails, nothing lands.
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 0. Pre-flight ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('0d8903dbac7ea38f51a46150e9f3d526', '3280e538120b701413d57ac4db9c2ea1') THEN
    RAISE EXCEPTION 'S834 pre-flight: guard_pos_credit_note changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.submit_guest_order(uuid, jsonb, text, integer, uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('b4312146f6c5da5e01f3d51c9fe99936', '8dcdb6f40c30b80449e4bb8547c350e8') THEN
    RAISE EXCEPTION 'S834 pre-flight: submit_guest_order changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_pos_device_guest_alerts(uuid, uuid, text)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('7f534b42d95ff5c5b5a811d424b86c62', 'd27d6cdf7749e9e909fc2acc97eb8168') THEN
    RAISE EXCEPTION 'S834 pre-flight: get_pos_device_guest_alerts changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_guest_order_progress(uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('da520833ee99b22acf79366b1372361e', 'a240937de44f510fa4b41c3310238a51') THEN
    RAISE EXCEPTION 'S834 pre-flight: get_guest_order_progress changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.get_guest_order_request_status(uuid)'::regprocedure;
  IF v_md5 IS NULL OR v_md5 NOT IN ('f6a8b19004636e952957678a669a6d82', '8a65f73077b7fa27f6dda97af6938049') THEN
    RAISE EXCEPTION 'S834 pre-flight: get_guest_order_request_status changed since this was written (md5 %). Rebuild from the live body.', v_md5;
  END IF;
  -- The dead function: gone already (a re-run), or the body this was written against, and named by
  -- no other function outside a comment.
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_pos_pin_lock';
  IF v_md5 IS NOT NULL AND v_md5 <> '0e27c2114eb8b3564258f8758f26d571' THEN
    RAISE EXCEPTION 'S834 pre-flight: check_pos_pin_lock changed since this was written (md5 %).', v_md5;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname <> 'check_pos_pin_lock'
                AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ILIKE '%check_pos_pin_lock%') THEN
    RAISE EXCEPTION 'S834 pre-flight: another function still calls check_pos_pin_lock';
  END IF;
END;
$$;


-- ── 1. The columns ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pos_orders ADD COLUMN IF NOT EXISTS invoice_prefix text;
ALTER TABLE public.pos_credit_notes ADD COLUMN IF NOT EXISTS invoice_prefix text;
COMMENT ON COLUMN public.pos_orders.invoice_prefix IS
  'S834 (D35): the invoice code this bill was printed under, stamped at the close by pos_orders_stamp_invoice_prefix. '''' = no code; NULL = closed before S834 (read under today''s code).';
COMMENT ON COLUMN public.pos_credit_notes.invoice_prefix IS
  'S834 (D35): the invoice code this credit note was printed under, stamped at issue by guard_pos_credit_note. NULL = issued before S834.';


-- ── 2. A bill keeps its code ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pos_orders_stamp_invoice_prefix()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- S834 (owner decision D35, 2026-10-14): a bill keeps the invoice code it was printed with. The
  -- printed number is put together at print time from settings.invoice_prefix, so changing the code
  -- (CAC to CASA) relabelled every bill already issued: reprints, reports and a credit note's
  -- reference. The close stamps the outlet's code as it stands, in the close's transaction, and the
  -- till prints from the row the close returns. '' is a bill printed with no code; NULL is a bill
  -- closed before this column, which the screens read under today's code, as before.
  -- After guard_pos_order_close (name order), so a client changing a closed bill's code is refused
  -- there; this keeps it as stamped for everyone else.
  IF TG_OP = 'INSERT' THEN
    -- An order opens with no code. Only a closed bill the operator restores keeps its backup's.
    IF NEW.status = 'open' THEN
      NEW.invoice_prefix := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'billed' AND OLD.status IS DISTINCT FROM 'billed' THEN
    NEW.invoice_prefix := COALESCE((SELECT s.invoice_prefix FROM settings s WHERE s.client_id = NEW.client_id LIMIT 1), '');
  ELSIF NEW.status = 'open' THEN
    NEW.invoice_prefix := NULL;
  ELSE
    NEW.invoice_prefix := OLD.invoice_prefix;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.pos_orders_stamp_invoice_prefix() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_orders_stamp_invoice_prefix ON public.pos_orders;
CREATE TRIGGER pos_orders_stamp_invoice_prefix
  BEFORE UPDATE ON public.pos_orders
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status OR NEW.invoice_prefix IS DISTINCT FROM OLD.invoice_prefix)
  EXECUTE FUNCTION public.pos_orders_stamp_invoice_prefix();
DROP TRIGGER IF EXISTS pos_orders_stamp_invoice_prefix_ins ON public.pos_orders;
CREATE TRIGGER pos_orders_stamp_invoice_prefix_ins
  BEFORE INSERT ON public.pos_orders
  FOR EACH ROW
  WHEN (NEW.invoice_prefix IS NOT NULL)
  EXECUTE FUNCTION public.pos_orders_stamp_invoice_prefix();


-- ── 3. A credit note keeps its code, and names its bill under the bill's ───────────────────────
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
         o.invoice_no, o.invoice_fy, o.vat_registered, o.closed_at, o.invoice_prefix
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
  -- prefix, as the page reads it (S834: the code the bill was printed with, below), and the bill's year:
  -- "TI1147-BC-83/84", "PB12-83/84". The Miti is the Nepali date the bill closed, read in Nepal:
  -- "27 Ashwin 2083", nepalBsLong's form, from bs_months (pos_invoice_fy's table; change the two
  -- together). Past that table's end it is the AD day, "2031-04-14 (AD)", as the page falls back.
  -- A billed bill always has closed_at; were it missing, the sent date would stand.
  SELECT s.is_vat_registered, s.invoice_prefix INTO v_vat_now, v_prefix
    FROM settings s WHERE s.client_id = NEW.client_id;
  v_vat_reg := COALESCE(v_order.vat_registered, v_vat_now, true);
  v_prefix  := COALESCE(v_prefix, '');
  -- ── S834 (owner decision D35): a note keeps the invoice code it is printed under, and names its
  -- bill under the code the bill was printed with (pos_orders.invoice_prefix, stamped at the close).
  -- Today's code stands in only for a bill closed before bills kept theirs. The code is locked once
  -- issued (not on v_allowed). The operator's restore returned above with the backup's own.
  NEW.invoice_prefix := v_prefix;
  v_prefix := COALESCE(v_order.invoice_prefix, v_prefix);
  -- ── end S834 ───────────────────────────────────────────────────────────────────────────────
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
$function$
;


-- ── 4. A guest order nobody answers is turned away after 30 minutes ───────────────────────────
-- One definition of the wait. Its JS twin is GUEST_ORDER_STALE_MS (src/shared/guestOrderStale.js),
-- held to it by guestOrderStale.test.js.
CREATE OR REPLACE FUNCTION public.pos_guest_order_stale_after()
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$ SELECT interval '30 minutes' $function$;
REVOKE ALL ON FUNCTION public.pos_guest_order_stale_after() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.pos_turn_away_stale_guest_orders(p_client_id uuid, p_table_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  -- S834 (owner decision D34, 2026-10-14): a guest QR order nobody has answered for
  -- pos_guest_order_stale_after() is turned away, as a bill closing on its table turns one away
  -- (S817 D21). The guest's page reads it as not answered, every alert stops ringing for it, and the
  -- table may order again (one waiting order per table). No login answered it, so decided_by stays
  -- empty. Internal: called by the guest's own poll, a new guest order, the PIN screen's alert read
  -- and the tills (turn_away_stale_guest_orders). As the owner, guard_pos_guest_order_request lets
  -- it through on its first line.
  IF p_client_id IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE pos_guest_order_requests q
     SET status = 'dismissed', order_id = NULL, decided_at = now(), decided_by = NULL
   WHERE q.client_id = p_client_id
     AND (p_table_id IS NULL OR q.table_id = p_table_id)
     AND q.status = 'pending'
     AND q.created_at < now() - public.pos_guest_order_stale_after();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION public.pos_turn_away_stale_guest_orders(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.turn_away_stale_guest_orders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client uuid := public.my_client_id();
BEGIN
  -- S834 (D34): the tills' way to the same step, for the signed-in login's own outlet only. It turns
  -- away nothing but orders that have waited past the limit, whoever asks.
  IF v_client IS NULL THEN
    RETURN 0;
  END IF;
  RETURN public.pos_turn_away_stale_guest_orders(v_client, NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public.turn_away_stale_guest_orders() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.turn_away_stale_guest_orders() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_guest_order_request_status(p_request_id uuid)
 RETURNS TABLE(status text, decided_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client uuid;
  v_table  uuid;
BEGIN
  -- S834 (owner decision D34): the guest's own poll turns its order away once nobody has answered it
  -- for pos_guest_order_stale_after(), so the guest is told and the table may order again. The
  -- answer keeps its shape: a turned-away order reads 'dismissed', and the guest's page tells an
  -- unanswered one by when it was decided. VOLATILE since S834, for this write.
  SELECT r.client_id, r.table_id INTO v_client, v_table
    FROM pos_guest_order_requests r
   WHERE r.id = p_request_id AND r.status = 'pending'
     AND r.created_at < now() - public.pos_guest_order_stale_after();
  IF v_client IS NOT NULL THEN
    PERFORM public.pos_turn_away_stale_guest_orders(v_client, v_table);
  END IF;

  RETURN QUERY SELECT r.status, r.decided_at FROM pos_guest_order_requests r WHERE r.id = p_request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_guest_order_progress(p_request_id uuid)
 RETURNS TABLE(status text, kot_status text, remaining_minutes integer, order_closed boolean)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_req public.pos_guest_order_requests%ROWTYPE;
  v_pos_enabled boolean;
  v_order_id uuid;
  v_order_status text;
  v_recipe_ids text[];
  v_worst int;
  v_max_ready timestamptz;
  v_rank int;
  v_ready timestamptz;
  r RECORD;
BEGIN
  SELECT * INTO v_req FROM public.pos_guest_order_requests q WHERE q.id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- pos_enabled stays the first gate on every guest read (S632).
  SELECT c.pos_enabled INTO v_pos_enabled FROM public.clients c WHERE c.id = v_req.client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN RETURN; END IF;
  -- S809 (GUEST-4): and a locked outlet reads as POS switched off (no row: the page keeps what it had).
  IF NOT COALESCE(public.client_access_open(v_req.client_id), false) THEN RETURN; END IF;

  -- S834 (owner decision D34): the guest's own poll turns its order away once nobody has answered it
  -- for pos_guest_order_stale_after(), so the guest is told and the table may order again. VOLATILE
  -- since S834, for this write.
  IF v_req.status = 'pending' AND v_req.created_at < now() - public.pos_guest_order_stale_after() THEN
    PERFORM public.pos_turn_away_stale_guest_orders(v_req.client_id, v_req.table_id);
    SELECT * INTO v_req FROM public.pos_guest_order_requests q WHERE q.id = p_request_id;
  END IF;

  status := v_req.status;
  kot_status := NULL;
  remaining_minutes := NULL;
  order_closed := false;

  IF v_req.status IS DISTINCT FROM 'accepted' THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_req.order_id IS NOT NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status FROM public.pos_orders o WHERE o.id = v_req.order_id;
  END IF;
  -- An accept written before S767, or by a till still on an older bundle, has no order_id. The
  -- bill that took it is the earliest one on this table that was still open when the guest sent
  -- the order — created_at is the SERVER's clock, unlike decided_at, which the tablet writes.
  IF v_order_id IS NULL THEN
    SELECT o.id, o.status INTO v_order_id, v_order_status
      FROM public.pos_orders o
     WHERE o.table_id = v_req.table_id
       AND (o.closed_at IS NULL OR o.closed_at >= v_req.created_at)
     ORDER BY o.opened_at ASC
     LIMIT 1;
  END IF;

  IF v_order_id IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  order_closed := v_order_status IS DISTINCT FROM 'open';

  SELECT COALESCE(array_agg(DISTINCT e->>'recipe_id'), '{}')
    INTO v_recipe_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_req.items) = 'array' THEN v_req.items ELSE '[]'::jsonb END) e
   WHERE e->>'recipe_id' IS NOT NULL;

  v_worst := NULL;
  v_max_ready := NULL;
  FOR r IN
    SELECT k.status AS kstatus, k.started_at, k.estimated_prep_minutes
      FROM public.pos_kot_log k
     WHERE k.order_id = v_order_id
       AND k.sent_at >= v_req.created_at
       AND k.status IS DISTINCT FROM 'cancelled'
       -- S809 3b (S809.4): a CHANGE ticket (slice 3a: every line {qty: 0, change: true}) tells the
       -- kitchen an instruction changed. No food waits on it, and it stays "new" until the kitchen
       -- presses Seen, so it held the guest's tracker below Ready meanwhile.
       AND NOT COALESCE(k.items @> '[{"change": true}]'::jsonb, false)
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(k.items) = 'array' THEN k.items ELSE '[]'::jsonb END) i
          WHERE i->>'recipe_id' = ANY (v_recipe_ids)
       )
  LOOP
    v_rank := CASE r.kstatus WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'ready' THEN 2 WHEN 'served' THEN 2 ELSE 0 END;
    IF v_worst IS NULL OR v_rank < v_worst THEN v_worst := v_rank; END IF;
    IF r.kstatus = 'in_progress' AND r.started_at IS NOT NULL AND r.estimated_prep_minutes IS NOT NULL THEN
      v_ready := r.started_at + (r.estimated_prep_minutes * interval '1 minute');
      IF v_max_ready IS NULL OR v_ready > v_max_ready THEN v_max_ready := v_ready; END IF;
    END IF;
  END LOOP;

  kot_status := CASE v_worst WHEN 0 THEN 'new' WHEN 1 THEN 'in_progress' WHEN 2 THEN 'ready' ELSE NULL END;
  remaining_minutes := CASE
    WHEN kot_status = 'in_progress' AND v_max_ready IS NOT NULL
      THEN CEIL(EXTRACT(EPOCH FROM (v_max_ready - now())) / 60)::integer
    ELSE NULL
  END;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_pos_device_guest_alerts(p_client_id uuid, p_device_id uuid, p_device_secret text)
 RETURNS TABLE(table_name text, waiting_since timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_enabled boolean;
BEGIN
  -- S809 3c (FLOOR-KITCHEN-1, Q14): the tablet's own key, tested as the staff picker tests it
  -- (get_pos_device_staff), and refused the same way, so the PIN screen reads both answers alike.
  -- A key is good for the outlet it was activated for and no other.
  IF NOT COALESCE(public.pos_device_key_valid(p_client_id, p_device_id, p_device_secret), false) THEN
    RAISE EXCEPTION 'pos_device_not_active' USING ERRCODE = '28000',
      HINT = 'This till needs to be activated again by a manager.';
  END IF;

  -- An outlet that takes no guest orders has nothing to announce: POS switched off, or the account
  -- locked (the two gates submit_guest_order applies). Silence, not a refusal: the tablet is fine.
  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = p_client_id;
  IF NOT COALESCE(v_pos_enabled, false) OR NOT COALESCE(public.client_access_open(p_client_id), false) THEN
    RETURN;
  END IF;

  -- S834 (owner decision D34): an order nobody answered in time is turned away first, so the PIN
  -- screen stops announcing it (VOLATILE since S834, for this write).
  PERFORM public.pos_turn_away_stale_guest_orders(p_client_id, NULL);

  -- What the banner says, and nothing more: which table, and since when. No request id (the
  -- guest's tracker key), no dish, no note, no covers.
  RETURN QUERY
    SELECT t.name::text, q.created_at
      FROM pos_guest_order_requests q
      LEFT JOIN pos_tables t ON t.id = q.table_id AND t.client_id = q.client_id
     WHERE q.client_id = p_client_id
       AND q.status = 'pending'
     ORDER BY q.created_at, q.id
     LIMIT 50;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.submit_guest_order(p_table_id uuid, p_items jsonb, p_notes text DEFAULT NULL::text, p_covers integer DEFAULT 1, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_client_id uuid;
  v_table_status text;
  v_pos_enabled boolean;
  v_cust boolean;
  v_request_id uuid;
  v_snapshot jsonb := '[]'::jsonb;
  v_unavailable text[] := '{}';
  v_bad_options text[] := '{}';
  r RECORD;
  item RECORD;
  v_qty numeric;
  v_note text;
  v_opt_ids uuid[];
  v_has_groups boolean;
  v_sel jsonb;
  v_key_table uuid;
BEGIN
  SELECT t.client_id, t.status INTO v_client_id, v_table_status FROM pos_tables t WHERE t.id = p_table_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'Table not found' USING HINT = 'table_not_found';
  END IF;

  SELECT c.pos_enabled INTO v_pos_enabled FROM clients c WHERE c.id = v_client_id;
  IF NOT COALESCE(v_pos_enabled, false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  -- S809 (GUEST-4): a locked outlet refuses with POS switched off's own message and code, so the
  -- guest's page reads it the same way (guestOrderRefusal 'not_accepting', then the menu re-reads
  -- as empty) and the refusal says nothing about the outlet's account. Before the inactive-table
  -- test, because POS switched off is refused before it too.
  IF NOT COALESCE(public.client_access_open(v_client_id), false) THEN
    RAISE EXCEPTION 'POS not enabled for this restaurant' USING HINT = 'not_accepting';
  END IF;

  -- S809 3b (GUEST-2): the guest page sends one key per order, and the same key with every retry of
  -- it. A key that already landed for this table is that order: it is answered with that request
  -- whatever the retry carries (accepted, turned away or still waiting, the guest's tracker reads it),
  -- and nothing is stored twice. Answered before the menu checks, because those checks judge a new
  -- order, and this one was sent already. A key of another table's order is refused, and the page
  -- makes a new key.
  IF p_request_id IS NOT NULL THEN
    SELECT q.table_id INTO v_key_table FROM pos_guest_order_requests q WHERE q.id = p_request_id;
    IF FOUND THEN
      IF v_key_table IS DISTINCT FROM p_table_id THEN
        RAISE EXCEPTION 'This order key belongs to another table' USING HINT = 'request_key_conflict';
      END IF;
      RETURN p_request_id;
    END IF;
  END IF;

  -- S746: the floor cannot open an inactive table, so an order for one would strand on a tile
  -- nobody can click.
  IF v_table_status = 'inactive' THEN
    RAISE EXCEPTION 'This table is not taking orders' USING HINT = 'inactive';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Order is empty' USING HINT = 'empty';
  END IF;
  IF jsonb_array_length(p_items) > 30 THEN
    RAISE EXCEPTION 'Too many items in one order' USING HINT = 'too_many_items';
  END IF;

  v_cust := public.customization_live(v_client_id);

  FOR item IN SELECT * FROM jsonb_to_recordset(p_items) AS x(recipe_id uuid, qty numeric, note text, options jsonb)
  LOOP
    IF item.recipe_id IS NULL THEN CONTINUE; END IF;
    v_qty := LEAST(GREATEST(FLOOR(COALESCE(item.qty, 0)), 0), 50);
    IF v_qty <= 0 THEN CONTINUE; END IF;
    v_note := NULLIF(left(COALESCE(item.note, ''), 200), '');

    SELECT rc.id, rc.name, rc.category, rc.selling_price, rc.vat_rate, rc.is_active, rc.pos_enabled INTO r
    FROM recipes rc
    WHERE rc.id = item.recipe_id AND rc.client_id = v_client_id;

    IF r.id IS NULL
       OR NOT COALESCE(r.is_active = true AND r.pos_enabled = true
                       AND r.category IS DISTINCT FROM 'Sub-Recipe' AND r.selling_price > 0, false) THEN
      v_unavailable := v_unavailable || COALESCE(NULLIF(btrim(r.name), ''), 'An item');
      CONTINUE;
    END IF;

    -- S758: the picks, as uuids. Anything unreadable is a pick that does not exist.
    BEGIN
      SELECT COALESCE(array_agg(e::uuid), ARRAY[]::uuid[]) INTO v_opt_ids
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(item.options) = 'array' THEN item.options ELSE '[]'::jsonb END) e;
    EXCEPTION WHEN invalid_text_representation THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END;

    v_has_groups := v_cust AND EXISTS (
      SELECT 1 FROM pos_recipe_option_groups a JOIN pos_option_groups g ON g.id = a.group_id AND g.is_active
       WHERE a.recipe_id = r.id AND EXISTS (SELECT 1 FROM pos_options o WHERE o.group_id = g.id AND o.is_active));

    IF cardinality(v_opt_ids) > 0 AND NOT v_cust THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END IF;

    -- S809 3b (GUEST-5): choices sent for a dish that offers none any more (its last group or option
    -- was switched off after the guest's menu loaded) used to be dropped, and the dish went through
    -- plain at its base price while the guest's tracker named the choice. Refused like a choice taken
    -- off a dish that still has others: the page takes the dish off and asks for it again.
    IF cardinality(v_opt_ids) > 0 AND NOT v_has_groups THEN
      v_bad_options := v_bad_options || r.name;
      CONTINUE;
    END IF;

    IF v_has_groups THEN
      -- A customizable dish is always checked, picks or not: one that must have a size cannot
      -- arrive without one from a page that was loaded before the dish had choices.
      v_sel := public.pos_price_selection(v_client_id, r.id, v_opt_ids);
      IF v_sel->>'problem' IS NOT NULL THEN
        v_bad_options := v_bad_options || r.name;
        CONTINUE;
      END IF;
    ELSE
      v_sel := NULL;
    END IF;

    IF v_sel IS NOT NULL AND v_sel->>'selection_key' <> '' THEN
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price + (v_sel->>'delta')::numeric, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note,
        'base_unit_price', r.selling_price, 'options_delta', (v_sel->>'delta')::numeric,
        'selection_key', v_sel->>'selection_key', 'option_ids', v_sel->'option_ids',
        'option_summary', v_sel->>'summary', 'options', v_sel->'options'
      );
    ELSE
      v_snapshot := v_snapshot || jsonb_build_object(
        'recipe_id', r.id, 'name', r.name, 'category', r.category,
        'unit_price', r.selling_price, 'vat_rate', r.vat_rate,
        'qty', v_qty, 'note', v_note
      );
    END IF;
  END LOOP;

  IF cardinality(v_unavailable) > 0 THEN
    RAISE EXCEPTION 'Some items in this order are no longer available'
      USING HINT = 'unavailable_items',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_unavailable) u ORDER BY 1))::text;
  END IF;

  IF cardinality(v_bad_options) > 0 THEN
    RAISE EXCEPTION 'The choices on some dishes are no longer available'
      USING HINT = 'unavailable_options',
            DETAIL = to_jsonb(ARRAY(SELECT DISTINCT u FROM unnest(v_bad_options) u ORDER BY 1))::text;
  END IF;

  IF jsonb_array_length(v_snapshot) = 0 THEN
    RAISE EXCEPTION 'No valid items in order' USING HINT = 'no_valid_items';
  END IF;

  -- S834 (owner decision D34): an order on this table that nobody answered in time no longer holds
  -- the table's one waiting place (pos_guest_order_requests_one_pending_per_table): it is turned
  -- away first, so the guest can order again.
  PERFORM public.pos_turn_away_stale_guest_orders(v_client_id, p_table_id);

  -- S809 3b (GUEST-2): stored under the page's key (a new one when the page sent none). A retry that
  -- arrives while the first send is still being written waits for it here, then finds its own order.
  BEGIN
    INSERT INTO pos_guest_order_requests (id, client_id, table_id, items, guest_notes, covers)
    VALUES (
      COALESCE(p_request_id, gen_random_uuid()), v_client_id, p_table_id, v_snapshot,
      NULLIF(left(COALESCE(p_notes, ''), 500), ''),
      LEAST(GREATEST(COALESCE(p_covers, 1), 1), 50)
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id INTO v_request_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This table already has an order request waiting for staff — please wait for it to be reviewed before sending another.'
      USING HINT = 'pending';
  END;

  IF v_request_id IS NULL THEN
    SELECT q.table_id INTO v_key_table FROM pos_guest_order_requests q WHERE q.id = p_request_id;
    IF v_key_table IS DISTINCT FROM p_table_id THEN
      RAISE EXCEPTION 'This order key belongs to another table' USING HINT = 'request_key_conflict';
    END IF;
    v_request_id := p_request_id;
  END IF;

  RETURN v_request_id;
END;
$function$
;


-- ── 5. The dead PIN-lock check ─────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.check_pos_pin_lock(uuid);


-- ── 6. Prove it ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_client uuid;
  v_mgr    uuid;
  v_t1 uuid; v_t2 uuid; v_t3 uuid;
  v_dish   uuid;
  v_dev    uuid;
  v_req1 uuid; v_req2 uuid; v_req3 uuid; v_req4 uuid; v_req5 uuid; v_new uuid;
  v_bill   uuid;
  v_note   uuid;
  v_fy     text;
  v_n      integer;
  v_s      text;
  v_hint   text;
  v_old    timestamptz := now() - interval '31 minutes';
  c_secret CONSTANT text := 's834-probe-device-secret-0f3b9c2e';
  c_item   CONSTANT jsonb := '[{"recipe_id":null,"name":"S834 probe","qty":1}]';
BEGIN
  -- ── Where: a POS outlet taking orders, three tables in service with no guest order waiting, an
  --    unblocked POS manager till login, and a settings row ─────────────────────────────────────
  SELECT c.id INTO v_client
    FROM public.clients c
   WHERE c.pos_enabled AND COALESCE(public.client_access_open(c.id), false)
     AND EXISTS (SELECT 1 FROM public.settings s WHERE s.client_id = c.id)
     AND (SELECT count(*) FROM public.pos_tables t
           WHERE t.client_id = c.id AND t.status IS DISTINCT FROM 'inactive'
             AND NOT EXISTS (SELECT 1 FROM public.pos_guest_order_requests q WHERE q.table_id = t.id AND q.status = 'pending')) >= 3
     AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.client_id = c.id AND p.active_client_id IS NULL
                    AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
                    AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL)
   ORDER BY (c.name = 'BLOOM CAFE') DESC, c.name LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'S834 probe: no POS outlet with three free tables, settings and an unblocked POS manager';
  END IF;
  SELECT p.id INTO v_mgr FROM public.profiles p
   WHERE p.client_id = v_client AND p.active_client_id IS NULL AND p.pos_role = 'manager' AND p.pos_email IS NOT NULL
     AND p.settlement_blocked_by IS NULL AND p.pos_blocked_at IS NULL ORDER BY p.id LIMIT 1;
  SELECT t.id INTO v_t1 FROM public.pos_tables t WHERE t.client_id = v_client AND t.status IS DISTINCT FROM 'inactive'
     AND NOT EXISTS (SELECT 1 FROM public.pos_guest_order_requests q WHERE q.table_id = t.id AND q.status = 'pending')
   ORDER BY t.id LIMIT 1;
  SELECT t.id INTO v_t2 FROM public.pos_tables t WHERE t.client_id = v_client AND t.status IS DISTINCT FROM 'inactive'
     AND NOT EXISTS (SELECT 1 FROM public.pos_guest_order_requests q WHERE q.table_id = t.id AND q.status = 'pending')
     AND t.id > v_t1 ORDER BY t.id LIMIT 1;
  SELECT t.id INTO v_t3 FROM public.pos_tables t WHERE t.client_id = v_client AND t.status IS DISTINCT FROM 'inactive'
     AND NOT EXISTS (SELECT 1 FROM public.pos_guest_order_requests q WHERE q.table_id = t.id AND q.status = 'pending')
     AND t.id > v_t2 ORDER BY t.id LIMIT 1;
  v_fy := public.pos_invoice_fy(now());

  BEGIN
    -- ── Setup, as the migration's own role: a dish on the till, and a tablet key ────────────────
    INSERT INTO public.recipes (client_id, name, category, yield_qty, selling_price, vat_rate, pos_enabled, is_active)
      VALUES (v_client, 'S834 probe dish', 'Food', 1, 300, 0, true, true) RETURNING id INTO v_dish;
    INSERT INTO public.pos_devices (client_id, name, secret_hash)
      VALUES (v_client, 'S834 probe', public.pos_device_secret_hash(c_secret)) RETURNING id INTO v_dev;

    -- ── D34 (1): the guest's own poll turns away an order nobody answered for 30 minutes ───────
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items, covers, created_at)
      VALUES (v_client, v_t1, c_item, 1, v_old) RETURNING id INTO v_req1;
    SET LOCAL ROLE anon;
    SELECT r.status INTO v_s FROM public.get_guest_order_request_status(v_req1) r;
    RESET ROLE;
    IF v_s IS DISTINCT FROM 'dismissed'
       OR NOT EXISTS (SELECT 1 FROM public.pos_guest_order_requests
                       WHERE id = v_req1 AND status = 'dismissed' AND decided_by IS NULL AND decided_at IS NOT NULL) THEN
      RAISE EXCEPTION 'S834 probe: the guest''s poll answered % for an order waiting 31 minutes', COALESCE(v_s, 'nothing');
    END IF;

    -- (1b) the guest page's own poll (get_guest_order_progress) does the same
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items, covers, created_at)
      VALUES (v_client, v_t3, c_item, 1, v_old) RETURNING id INTO v_req5;
    SET LOCAL ROLE anon;
    SELECT r.status INTO v_s FROM public.get_guest_order_progress(v_req5) r;
    RESET ROLE;
    IF v_s IS DISTINCT FROM 'dismissed'
       OR (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req5) IS DISTINCT FROM 'dismissed' THEN
      RAISE EXCEPTION 'S834 probe: the guest page''s progress poll answered % for an order waiting 31 minutes', COALESCE(v_s, 'nothing');
    END IF;

    -- (2) an order sent a minute ago stays waiting, and still holds its table's place
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items, covers, created_at)
      VALUES (v_client, v_t2, c_item, 1, now() - interval '1 minute') RETURNING id INTO v_req2;
    SET LOCAL ROLE anon;
    SELECT r.status INTO v_s FROM public.get_guest_order_request_status(v_req2) r;
    v_hint := NULL;
    BEGIN
      PERFORM public.submit_guest_order(v_t2, jsonb_build_array(jsonb_build_object('recipe_id', v_dish, 'qty', 1)), NULL, 1, NULL);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT;
    END;
    RESET ROLE;
    IF v_s IS DISTINCT FROM 'pending' OR v_hint IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'S834 probe: a fresh order read % and a second order on its table answered %', COALESCE(v_s, 'nothing'), COALESCE(v_hint, 'nothing');
    END IF;

    -- (3) a new guest order on a table whose waiting order is past the limit takes its place
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items, covers, created_at)
      VALUES (v_client, v_t1, c_item, 1, v_old) RETURNING id INTO v_req3;
    SET LOCAL ROLE anon;
    v_new := public.submit_guest_order(v_t1, jsonb_build_array(jsonb_build_object('recipe_id', v_dish, 'qty', 1)), NULL, 2, NULL);
    RESET ROLE;
    IF v_new IS NULL
       OR (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req3) IS DISTINCT FROM 'dismissed'
       OR (SELECT status FROM public.pos_guest_order_requests WHERE id = v_new) IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'S834 probe: a new guest order did not take the place of one past the limit';
    END IF;

    -- (4) the PIN screen's banner read turns one away and still announces the fresh ones
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items, covers, created_at)
      VALUES (v_client, v_t3, c_item, 1, v_old) RETURNING id INTO v_req4;
    SET LOCAL ROLE anon;
    SELECT count(*) INTO v_n FROM public.get_pos_device_guest_alerts(v_client, v_dev, c_secret) a
     WHERE a.waiting_since >= now() - interval '2 minutes';
    RESET ROLE;
    IF (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req4) IS DISTINCT FROM 'dismissed' OR v_n < 2 THEN
      RAISE EXCEPTION 'S834 probe: the PIN screen''s read left the stale order % and announced % fresh', 
        (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req4), v_n;
    END IF;

    -- (5) a till's call does the same for its own outlet, and nothing younger
    INSERT INTO public.pos_guest_order_requests (client_id, table_id, items, covers, created_at)
      VALUES (v_client, v_t3, c_item, 1, v_old) RETURNING id INTO v_req5;
    PERFORM set_config('request.headers', '{"x-crest-build":"crest-v450"}', true);
    PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_mgr)::text, true);
    SET LOCAL ROLE authenticated;
    v_n := public.turn_away_stale_guest_orders();
    RESET ROLE;
    IF v_n < 1 OR (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req5) IS DISTINCT FROM 'dismissed'
       OR (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req2) IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'S834 probe: the till''s call turned away % (the stale one %, the fresh one %)', v_n,
        (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req5),
        (SELECT status FROM public.pos_guest_order_requests WHERE id = v_req2);
    END IF;

    -- ── D35 (1): an open order carries no code, whatever is sent ───────────────────────────────
    UPDATE public.settings SET invoice_prefix = 'S834A' WHERE client_id = v_client;
    -- order_no is given, so the probe takes no lock on the outlet's real order series.
    INSERT INTO public.pos_orders (client_id, order_no, table_name, invoice_prefix)
      VALUES (v_client, 990861, 'S834 probe', 'S834X') RETURNING id INTO v_bill;
    IF (SELECT invoice_prefix FROM public.pos_orders WHERE id = v_bill) IS NOT NULL THEN
      RAISE EXCEPTION 'S834 probe: an open order kept the code it was sent';
    END IF;
    INSERT INTO public.pos_order_items (order_id, client_id, name, recipe_id, qty, unit_price, vat_rate)
      VALUES (v_bill, v_client, 'S834 probe dish', v_dish, 1, 300, 0);

    -- (2) the close stamps the outlet's code as it stands
    UPDATE public.pos_orders
       SET status = 'billed', close_type = 'paid', payment_method = 'Cash', discount_amount = 0, paid_amount = 300,
           vat_registered = false, invoice_fy = v_fy, closed_at = now()
     WHERE id = v_bill;
    IF (SELECT invoice_prefix FROM public.pos_orders WHERE id = v_bill) IS DISTINCT FROM 'S834A' THEN
      RAISE EXCEPTION 'S834 probe: the close stamped %, not the outlet''s code', (SELECT invoice_prefix FROM public.pos_orders WHERE id = v_bill);
    END IF;

    -- (3) the code changes; the bill keeps its own, through a reprint and through a login's write
    UPDATE public.settings SET invoice_prefix = 'S834B' WHERE client_id = v_client;
    UPDATE public.pos_orders SET print_count = print_count + 1 WHERE id = v_bill;
    SET LOCAL ROLE authenticated;
    BEGIN
      UPDATE public.pos_orders SET invoice_prefix = 'S834Y' WHERE id = v_bill;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- refused by guard_pos_order_close (a closed bill), as expected
    END;
    RESET ROLE;
    IF (SELECT invoice_prefix FROM public.pos_orders WHERE id = v_bill) IS DISTINCT FROM 'S834A' THEN
      RAISE EXCEPTION 'S834 probe: a closed bill''s code moved to %', (SELECT invoice_prefix FROM public.pos_orders WHERE id = v_bill);
    END IF;

    -- (4) a credit note, issued by the manager: its own code is today's, its bill's is the bill's
    SET LOCAL ROLE authenticated;
    INSERT INTO public.pos_credit_notes (client_id, order_id, invoice_fy, original_invoice_no, original_invoice_label,
        original_invoice_date_bs, reason, refund_method, restock, gross_amount, discount_amount, taxable_amount,
        non_taxable_amount, vat_amount, net_amount, invoice_prefix)
      VALUES (v_client, v_bill, v_fy, 1, 'PB1', '1 Baisakh 2000', 'S834 probe', 'none', false, 300, 0, 0, 300, 0, 300, 'S834Z')
      RETURNING id INTO v_note;
    BEGIN
      UPDATE public.pos_credit_notes SET invoice_prefix = 'S834Y' WHERE id = v_note;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- refused: an issued note is locked, as expected
    END;
    RESET ROLE;
    IF (SELECT invoice_prefix FROM public.pos_credit_notes WHERE id = v_note) IS DISTINCT FROM 'S834B'
       OR (SELECT original_invoice_label FROM public.pos_credit_notes WHERE id = v_note) NOT LIKE 'PB%-S834A-%' THEN
      RAISE EXCEPTION 'S834 probe: the note kept % and named its bill %',
        (SELECT invoice_prefix FROM public.pos_credit_notes WHERE id = v_note),
        (SELECT original_invoice_label FROM public.pos_credit_notes WHERE id = v_note);
    END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    PERFORM set_config('request.headers', '', true);

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 's834_probe_rollback';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 's834_probe_rollback' THEN RAISE; END IF;
  END;
END;
$$;


NOTIFY pgrst, 'reload schema';


-- ── 7. What this file changed, live (the last statement, so `db query` prints it) ─────────────
SELECT
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure) = '3280e538120b701413d57ac4db9c2ea1' AS note_guard_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.submit_guest_order(uuid, jsonb, text, integer, uuid)'::regprocedure) = '8dcdb6f40c30b80449e4bb8547c350e8' AS submit_ok,
  (SELECT md5(prosrc) || ':' || provolatile::text FROM pg_proc WHERE oid = 'public.get_pos_device_guest_alerts(uuid, uuid, text)'::regprocedure) = 'd27d6cdf7749e9e909fc2acc97eb8168:v' AS alerts_ok,
  (SELECT md5(prosrc) || ':' || provolatile::text FROM pg_proc WHERE oid = 'public.get_guest_order_request_status(uuid)'::regprocedure) = '8a65f73077b7fa27f6dda97af6938049:v' AS status_ok,
  (SELECT md5(prosrc) || ':' || provolatile::text FROM pg_proc WHERE oid = 'public.get_guest_order_progress(uuid)'::regprocedure) = 'a240937de44f510fa4b41c3310238a51:v' AS progress_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_turn_away_stale_guest_orders(uuid, uuid)'::regprocedure) = '1d6d6d35c007560969f6f7ae5a258d66' AS turn_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.turn_away_stale_guest_orders()'::regprocedure) = '40e82e29d13716d6aba164d55706b2c8' AS tills_ok,
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.pos_orders_stamp_invoice_prefix()'::regprocedure) = '1268c9db97a4fcc137bb9dc1dbe548fa' AS stamp_ok,
  has_function_privilege('anon', 'public.turn_away_stale_guest_orders()', 'EXECUTE') AS anon_can_turn_away,
  has_function_privilege('authenticated', 'public.turn_away_stale_guest_orders()', 'EXECUTE') AS tills_can_turn_away,
  has_function_privilege('anon', 'public.pos_turn_away_stale_guest_orders(uuid, uuid)', 'EXECUTE') AS anon_can_call_internal,
  has_function_privilege('anon', 'public.get_guest_order_request_status(uuid)', 'EXECUTE') AS guest_can_poll,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'check_pos_pin_lock') AS pin_lock_left,
  (SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.pos_orders'::regclass AND tgname LIKE 'pos_orders_stamp%') AS stamp_triggers,
  (SELECT count(*) FROM public.pos_guest_order_requests WHERE status = 'pending') AS guest_orders_waiting;
