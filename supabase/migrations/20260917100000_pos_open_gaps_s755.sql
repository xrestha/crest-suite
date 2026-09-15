-- ════════════════════════════════════════════════════════════════════════════════════════════
-- S755 — the POS gaps S754 filed as open (POS_TODO.md A2), closed in the database.
--
--   (1) Two bookings saved in the same second could hold one table. The overlap refusal was
--       browser-only (reservationConflicts.js). A statement trigger now serialises per table and
--       refuses the overlap with HINT 'table_hold_overlap'.
--   (2) A credit note's amounts were computed in the browser and stored as sent. The insert guard
--       now checks them against the bill with invariants that need no VAT formula
--       (HINT 'credit_note_amounts').
--   (3) Deleting an open order's lines outside save_pos_order_items (Clear Occupied, or a direct
--       REST delete of the order or its lines) removed food already fired with no pulled-item
--       record. Both deletes now write pos_kot_removals, and that record survives the order.
--   (4) Archive / Clear Client Data left tablet keys live — admin-user-ops, no SQL here.
--   (5) "(no money returned)" was appended to the credit note's printed reason. It has its own
--       column now, pos_credit_notes.refund_method.
--
-- Built on the LIVE bodies of the S754 functions (pg_get_functiondef read 2026-09-15: identical to
-- 20260916100000 for guard_pos_credit_note and save_pos_order_items).
-- ════════════════════════════════════════════════════════════════════════════════════════════


-- ── 1. One table, one party at a time — the database half ──────────────────────────────────
--
-- THE WINDOW is reservationStatus.windowOf(): [reserved_for, reserved_for + duration_minutes).
-- duration_minutes is NOT NULL, 15..720, so the JS `|| 90` fallback never applies to a stored row.
-- Half-open, exactly as reservationConflicts.windowsOverlap(): a 6:00–7:30 booking and a 7:30
-- booking on one table do not clash. LIVE is reservationStatus.LIVE_STATUSES, written once below in
-- pos_reservation_is_live() — reservationConflicts.test.js reads this file and asserts the two lists
-- are the same.
--
-- EVERY WRITER of pos_reservation_tables, enumerated (src/, supabase/functions/, every pg_proc body):
--   ReservationModal.save()        delete + insert of a booking's links (the only app writer)
--   restoreClientData.js           INSERT, as `authenticated` with role admin — exempt below
--   admin-user-ops                 DELETE only (Danger Zone)
--   pos_tables / pos_reservations  ON DELETE CASCADE — deletes only
-- No SQL function writes it; submit_reservation_request inserts the booking only, never a table.
--
-- AND every write that MOVES a booking holding tables: ReservationModal's edit (reserved_for,
-- duration_minutes) and PosReservations.transition()'s two reversals (no_show → arrived,
-- cancelled → booked) — a revived booking holds its tables again. Forward moves (booked → seated
-- → completed, seatReservation, closeOrder) stay live→live or go live→ended and are not checked.
--
-- SERIALISATION. The check runs AFTER the write, under pg_advisory_xact_lock on each table id (in
-- id order, so two multi-table saves cannot deadlock). The second of two concurrent saves waits
-- for the first to commit, then its check statement takes a fresh snapshot (READ COMMITTED, one
-- snapshot per statement in a VOLATILE plpgsql body) and sees the first booking. Whichever save
-- takes the lock second is the one refused.
--
-- SECURITY DEFINER, so the check reads every booking on the table rather than only what the
-- caller's RLS view happens to include (the S749 lesson: a guard whose read is narrower than its
-- target passes vacuously). It is a trigger function, so PostgREST cannot serve it as an RPC.
CREATE OR REPLACE FUNCTION public.pos_reservation_is_live(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(p_status = ANY (ARRAY['requested', 'booked', 'confirmed', 'arrived', 'seated']), false)
$fn$;
REVOKE ALL ON FUNCTION public.pos_reservation_is_live(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.guard_pos_reservation_table_hold()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_ids   uuid[];
  v_table uuid;
  v_hit   record;
BEGIN
  IF TG_TABLE_NAME = 'pos_reservation_tables' THEN
    -- The operator's restore re-inserts a client's history as it was. A backup taken before this
    -- trigger can carry two stale 'booked' rows that overlap, and restoreClientData drops a whole
    -- table on its first failing chunk — every booking's tables, not only the pair.
    IF TG_OP = 'INSERT' AND COALESCE(public.is_admin(), false) THEN
      RETURN NULL;
    END IF;
    SELECT array_agg(DISTINCT n.reservation_id) INTO v_ids FROM new_rows n;
  ELSE
    -- pos_reservations: only a write that moves a LIVE booking's window, or brings one back to life.
    SELECT array_agg(n.id) INTO v_ids
      FROM new_rows n
      JOIN old_rows o ON o.id = n.id
     WHERE public.pos_reservation_is_live(n.status)
       AND (n.reserved_for     IS DISTINCT FROM o.reserved_for
         OR n.duration_minutes IS DISTINCT FROM o.duration_minutes
         OR NOT public.pos_reservation_is_live(o.status));
  END IF;

  IF v_ids IS NULL THEN
    RETURN NULL;
  END IF;

  FOR v_table IN
    SELECT DISTINCT rt.table_id
      FROM pos_reservation_tables rt
      JOIN pos_reservations r ON r.id = rt.reservation_id
     WHERE rt.reservation_id = ANY (v_ids)
       AND public.pos_reservation_is_live(r.status)
     ORDER BY rt.table_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('pos_table_hold:' || v_table::text, 0));
  END LOOP;

  SELECT mt.table_id, t.name AS table_name,
         o.id AS other_id, o.customer_name, o.party_size, o.reserved_for, o.duration_minutes
    INTO v_hit
    FROM pos_reservations me
    JOIN pos_reservation_tables mt ON mt.reservation_id = me.id
    JOIN pos_reservation_tables ot ON ot.table_id = mt.table_id AND ot.reservation_id <> me.id
    JOIN pos_reservations o        ON o.id = ot.reservation_id
    LEFT JOIN pos_tables t         ON t.id = mt.table_id
   WHERE me.id = ANY (v_ids)
     AND public.pos_reservation_is_live(me.status)
     AND public.pos_reservation_is_live(o.status)
     AND me.reserved_for < o.reserved_for  + make_interval(mins => o.duration_minutes)
     AND o.reserved_for  < me.reserved_for + make_interval(mins => me.duration_minutes)
   ORDER BY o.reserved_for, o.id
   LIMIT 1;

  IF FOUND THEN
    -- The DETAIL is structured so the page can word it with its own clock and calendar
    -- (reservationConflicts.describeHoldRefusal); the message is the fallback, in Nepal time.
    RAISE EXCEPTION 'table_hold_overlap: % is already held for % ×% at % on % (Nepal time) — pick another table or change the time',
      COALESCE(v_hit.table_name, 'This table'), v_hit.customer_name, v_hit.party_size,
      to_char(v_hit.reserved_for AT TIME ZONE 'Asia/Kathmandu', 'FMHH12:MI AM'),
      to_char(v_hit.reserved_for AT TIME ZONE 'Asia/Kathmandu', 'YYYY-MM-DD')
      USING ERRCODE = '23P01', HINT = 'table_hold_overlap',
            DETAIL = jsonb_build_object(
              'table_id', v_hit.table_id, 'table_name', v_hit.table_name,
              'reservation_id', v_hit.other_id, 'customer_name', v_hit.customer_name,
              'party_size', v_hit.party_size, 'reserved_for', v_hit.reserved_for,
              'duration_minutes', v_hit.duration_minutes)::text;
  END IF;

  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.guard_pos_reservation_table_hold() FROM PUBLIC;

-- Transition tables cannot be combined with a column list (UPDATE OF …), so the UPDATE trigger
-- fires on every update and the body filters to the window/status moves itself.
DROP TRIGGER IF EXISTS guard_pos_reservation_table_hold_ins ON public.pos_reservation_tables;
DROP TRIGGER IF EXISTS guard_pos_reservation_table_hold_upd ON public.pos_reservation_tables;
DROP TRIGGER IF EXISTS guard_pos_reservation_table_hold     ON public.pos_reservations;
CREATE TRIGGER guard_pos_reservation_table_hold_ins AFTER INSERT ON public.pos_reservation_tables
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_reservation_table_hold();
CREATE TRIGGER guard_pos_reservation_table_hold_upd AFTER UPDATE ON public.pos_reservation_tables
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_reservation_table_hold();
CREATE TRIGGER guard_pos_reservation_table_hold AFTER UPDATE ON public.pos_reservations
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.guard_pos_reservation_table_hold();


-- ── 2. Credit notes: the amounts are the bill's, and how money went back has its own column ──
--
-- (5) refund_method. IssueCreditNoteModal appended " (no money returned)" / " (money returned by
-- card, QR or bank)" to `reason`, which prints on the statutory note as if it were the reason.
-- NULL on every note issued before S755 (their reason text is left as issued — a printed tax
-- document is not rewritten). Never updated after the insert: guard_pos_credit_note's UPDATE
-- allow-list is print_count and ims_posted_at only. Exported and restored with the row
-- (select('*') in exportClientData.js); nothing to register — it is not generated.
ALTER TABLE public.pos_credit_notes
  ADD COLUMN IF NOT EXISTS refund_method text
  CHECK (refund_method IN ('cash', 'other', 'none'));

-- (2) The amounts. Credit notes are WHOLE-BILL only (decision 2026-08-18). What the modal stores,
-- from computeOrderAmounts(order, lines where NOT comped, vatReg):
--   gross_amount       = Σ qty × unit_price                         (non-comped lines)
--   discount_amount    = order.discount_amount || 0
--   taxable_amount     = Σ taxable lines   × (1 − discount/gross)
--   non_taxable_amount = Σ untaxed lines   × (1 − discount/gross)   → the two sum to gross − discount
--   vat_amount         = Σ line × vat_rate × (1 − discount/gross)   (0 on a PAN-bill client)
--   net_amount         = round(gross − discount + vat) to the rupee
-- and the bill's paid_amount is PosOrders' payTotal = round(paySubEx − discountAmt + payVatAmt) over
-- the same non-comped lines — the same expression, so net_amount and paid_amount agree.
--
-- So every stored figure is pinned WITHOUT a second copy of the VAT arithmetic (the S576 reason
-- paid_amount itself is never re-derived): gross from the lines, discount from the bill, the
-- taxable split from gross − discount, net from paid_amount, and VAT from net − (taxable split).
-- Tolerances: 1 paisa for sums of 2dp line totals; 0.51 for the rupee rounding of net; NPR 1 for
-- net against paid_amount. And VAT cannot exist without a taxable base.
--
-- Measured on live before choosing (read-only, 2026-09-15): 1 note on 1 client, 0 violations of
-- each invariant (max |net − paid| 0, max |gross − lines| 0, max |taxable+non_taxable − (gross −
-- discount)| 0, max |net − (taxable + non_taxable + vat)| 0). One note is a thin sample, which is
-- why each invariant above is also derived from the code that writes both sides.
--
-- Consequence worth knowing: a client whose VAT registration changed between the bill and the note
-- computes a different VAT and is refused. That is correct — a note must credit what the invoice
-- charged — and the sentence in errorText.js says so.
CREATE OR REPLACE FUNCTION public.guard_pos_credit_note()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_order record;
  v_lines numeric;
  v_allowed CONSTANT text[] := ARRAY['print_count', 'ims_posted_at'];
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
    RETURN NEW;
  END IF;

  -- INSERT. The operator's restore carries the historical rows as they were.
  IF COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;

  IF NOT public.pos_caller_has_rank('manager') THEN
    RAISE EXCEPTION 'pos_credit_notes: issuing a Credit Note needs POS Manager access or above'
      USING ERRCODE = '42501', HINT = 'rank_required';
  END IF;

  -- The bill: this client's, a paid bill that is billed, with no note yet. Locked so two managers
  -- issuing against one bill queue, and the second sees the first note.
  SELECT o.id, o.client_id, o.status, o.close_type, o.credit_note_id, o.discount_amount, o.paid_amount
    INTO v_order
    FROM pos_orders o WHERE o.id = NEW.order_id
    FOR UPDATE;
  IF v_order.id IS NULL OR v_order.client_id IS DISTINCT FROM NEW.client_id
     OR v_order.status IS DISTINCT FROM 'billed' OR v_order.close_type IS DISTINCT FROM 'paid' THEN
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

  NEW.issued_by := (SELECT auth.uid());
  NEW.credit_note_no := NULL;   -- numbered by trg_assign_pos_credit_note_no, never by the request
  NEW.ims_posted_at := NULL;
  NEW.print_count := 0;
  RETURN NEW;
END;
$$;
-- Trigger guard_pos_credit_note (BEFORE INSERT OR UPDATE OR DELETE) already points at this function.


-- ── 3. A fired line that leaves an open order outside save_pos_order_items is recorded ──────
--
-- Deletes of pos_order_items / pos_orders, enumerated:
--   save_pos_order_items (INVOKER)   DELETE of every line, then re-insert — records removals by
--                                    diff itself, and marks its transaction crest.pos_items_rpc=on
--   PosOrders Clear Occupied (admin) DELETE lines .in(order ids), then DELETE the open orders
--   any browser session over REST    DELETE an open order (guard_pos_order_delete allows open) or
--                                    its lines (guard_pos_item_price is INSERT/UPDATE only)
--   admin-user-ops (service role)    clearModuleData / deleteClientData — deletes pos_kot_removals
--                                    first, then the orders; not a "pull", nothing to record
--   ClientDrawer Delete Client       DELETE clients as `authenticated` admin → cascade
--
-- WHY THE FOREIGN KEY CHANGES. pos_kot_removals.order_id was NOT NULL ON DELETE CASCADE, so a
-- removal recorded for an order that is then deleted — Clear Occupied's second statement, or a
-- direct delete of the order — was destroyed with it. The record has to outlive the order to be a
-- record, so order_id becomes nullable ON DELETE SET NULL and the row snapshots the order number
-- and table name it would otherwise have read through the join (KotLog's Pulled Items). The 20260819
-- comment ("an orphan row would be evidence of nothing in particular") was true without the
-- snapshot; with it the row still says which order, which table, what, how many, who and when.
ALTER TABLE public.pos_kot_removals ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE public.pos_kot_removals DROP CONSTRAINT IF EXISTS pos_kot_removals_order_id_fkey;
ALTER TABLE public.pos_kot_removals
  ADD CONSTRAINT pos_kot_removals_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES public.pos_orders(id) ON DELETE SET NULL;
ALTER TABLE public.pos_kot_removals ADD COLUMN IF NOT EXISTS order_no   integer;
ALTER TABLE public.pos_kot_removals ADD COLUMN IF NOT EXISTS table_name text;

UPDATE public.pos_kot_removals r
   SET order_no = o.order_no, table_name = o.table_name
  FROM public.pos_orders o
 WHERE o.id = r.order_id AND r.order_no IS NULL;

-- Filled on every insert that does not carry them — save_pos_order_items (unchanged), the two
-- triggers below, and a restore of a backup taken before these columns existed (pos_orders is
-- restored first). INVOKER: every such writer can already see the order it names.
CREATE OR REPLACE FUNCTION public.pos_kot_removal_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_o record;
BEGIN
  IF NEW.order_id IS NOT NULL AND (NEW.order_no IS NULL OR NEW.table_name IS NULL) THEN
    SELECT o.order_no, o.table_name INTO v_o FROM pos_orders o WHERE o.id = NEW.order_id;
    IF FOUND THEN
      NEW.order_no   := COALESCE(NEW.order_no, v_o.order_no);
      NEW.table_name := COALESCE(NEW.table_name, v_o.table_name);
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.pos_kot_removal_snapshot() FROM PUBLIC;

DROP TRIGGER IF EXISTS pos_kot_removal_snapshot ON public.pos_kot_removals;
CREATE TRIGGER pos_kot_removal_snapshot
  BEFORE INSERT ON public.pos_kot_removals
  FOR EACH ROW EXECUTE FUNCTION public.pos_kot_removal_snapshot();

-- WHEN a delete is recorded — all four must hold:
--   * not inside save_pos_order_items (crest.pos_items_rpc = 'on'): it already recorded the diff;
--   * a browser session made the request (the JWT role claim is 'authenticated'). Not
--     current_user: a foreign-key cascade runs as the table owner (measured S754), so the
--     claim is the only thing that still says who asked. The service role's Danger Zone clears
--     and a migration run from the SQL editor carry no 'authenticated' claim and record nothing;
--   * the order is still open (a closed bill cannot be deleted by a browser at all), and still
--     exists — inside a pos_orders cascade the order is already gone and its BEFORE DELETE
--     trigger below has recorded the lines, so the line-level trigger finds nothing to join;
--   * the client still exists — a whole-client delete cascades here, and inserting a removal for
--     a deleted client would fail its foreign key and abort the client deletion.
--
-- WHAT is recorded is save_pos_order_items' own definition of "fired": per recipe (or name), over
-- non-comped lines, GREATEST(sent_qty, qty when sent_to_kot) — capped at the line's qty, since a
-- delete removes at most what the line holds. Reason 'Table cleared' (the one app path is Clear
-- Occupied); removed_by from the session, NULL when the session has no profile row (the FK).
-- recipe_id only when the recipe still exists (pos_order_items.recipe_id has no FK, the record's
-- does) — item_name carries the dish either way.
--
-- SECURITY DEFINER for the insert (pos_kot_removals grants a browser INSERT, but Clear Occupied is
-- run by the operator viewing as a client, and the lookup must see every line) and so the client
-- and order existence tests are not narrowed by RLS.
CREATE OR REPLACE FUNCTION public.record_pos_kot_removals_on_line_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF COALESCE((SELECT auth.jwt() ->> 'role'), '') <> 'authenticated' THEN
    RETURN NULL;
  END IF;

  INSERT INTO pos_kot_removals (client_id, order_id, order_no, table_name, recipe_id, item_name, qty_removed, reason, removed_by)
  SELECT o.client_id, o.id, o.order_no, o.table_name,
         MIN(rec.id::text)::uuid, MIN(l.name), SUM(l.sent)::integer, 'Table cleared',
         (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid()))
    FROM (
      SELECT r.order_id, r.recipe_id, r.name,
             LEAST(r.qty, GREATEST(COALESCE(r.sent_qty, 0),
                                   CASE WHEN COALESCE(r.sent_to_kot, false) THEN r.qty ELSE 0 END)) AS sent
        FROM old_rows r
       WHERE NOT COALESCE(r.comped, false)
    ) l
    JOIN pos_orders o    ON o.id = l.order_id AND o.status = 'open'
    JOIN clients c       ON c.id = o.client_id
    LEFT JOIN recipes rec ON rec.id = l.recipe_id
   GROUP BY o.client_id, o.id, o.order_no, o.table_name, COALESCE(l.recipe_id::text, l.name)
  HAVING SUM(l.sent) > 0;

  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.record_pos_kot_removals_on_line_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS record_pos_kot_removals_on_line_delete ON public.pos_order_items;
CREATE TRIGGER record_pos_kot_removals_on_line_delete AFTER DELETE ON public.pos_order_items
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.record_pos_kot_removals_on_line_delete();

-- The order itself deleted with its lines still on it: recorded BEFORE the delete, while the lines
-- and the order are both still readable. The row's order_id is then SET NULL by the new foreign key
-- in the same statement. Named to sort after guard_pos_order_delete, which refuses a closed bill
-- first.
--
-- MEASURED (rolled back, 2026-09-15): today a browser cannot reach this path at all. Deleting an
-- open order that still has lines is refused by S754's guard_pos_order_items_closed_del with the
-- misleading "this bill is closed and printed" — its AFTER STATEMENT trigger fires once the outer
-- statement ends, as `authenticated` (not as the table owner the cascade itself ran as), and its
-- LEFT JOIN reads the just-deleted parent as "not open". Clear Occupied is unaffected because it
-- deletes the lines first. Fail-closed, so nothing is lost; this trigger is the recorder for the
-- day that guard learns to tell a deleted parent from a closed one (POS_TODO.md A2).
CREATE OR REPLACE FUNCTION public.record_pos_kot_removals_on_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF OLD.status IS DISTINCT FROM 'open' THEN
    RETURN OLD;
  END IF;
  IF current_setting('crest.pos_items_rpc', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF COALESCE((SELECT auth.jwt() ->> 'role'), '') <> 'authenticated' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM clients c WHERE c.id = OLD.client_id) THEN
    RETURN OLD;
  END IF;

  INSERT INTO pos_kot_removals (client_id, order_id, order_no, table_name, recipe_id, item_name, qty_removed, reason, removed_by)
  SELECT OLD.client_id, OLD.id, OLD.order_no, OLD.table_name,
         MIN(rec.id::text)::uuid, MIN(l.name), SUM(l.sent)::integer, 'Table cleared',
         (SELECT p.id FROM profiles p WHERE p.id = (SELECT auth.uid()))
    FROM (
      SELECT i.recipe_id, i.name,
             LEAST(i.qty, GREATEST(COALESCE(i.sent_qty, 0),
                                   CASE WHEN COALESCE(i.sent_to_kot, false) THEN i.qty ELSE 0 END)) AS sent
        FROM pos_order_items i
       WHERE i.order_id = OLD.id AND NOT COALESCE(i.comped, false)
    ) l
    LEFT JOIN recipes rec ON rec.id = l.recipe_id
   GROUP BY COALESCE(l.recipe_id::text, l.name)
  HAVING SUM(l.sent) > 0;

  RETURN OLD;
END;
$fn$;
REVOKE ALL ON FUNCTION public.record_pos_kot_removals_on_order_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_pos_order_delete_kot_removals ON public.pos_orders;
CREATE TRIGGER trg_pos_order_delete_kot_removals
  BEFORE DELETE ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public.record_pos_kot_removals_on_order_delete();


-- ── 4. Assertions (catalog values, never formatted strings) ────────────────────────────────
DO $assert$
BEGIN
  IF (SELECT attnotnull FROM pg_attribute
       WHERE attrelid = 'public.pos_kot_removals'::regclass AND attname = 'order_id') THEN
    RAISE EXCEPTION 'S755: pos_kot_removals.order_id is still NOT NULL';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'public.pos_kot_removals'::regclass AND conname = 'pos_kot_removals_order_id_fkey') IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION 'S755: pos_kot_removals.order_id must be ON DELETE SET NULL, or a removal dies with its order';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.pos_credit_notes'::regclass
                  AND attname = 'refund_method' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'S755: pos_credit_notes.refund_method is missing';
  END IF;
  -- guard_pos_credit_note keys on current_user and must stay INVOKER; the three new record/check
  -- trigger functions read past RLS and must be DEFINER.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.guard_pos_credit_note()'::regprocedure) THEN
    RAISE EXCEPTION 'S755: guard_pos_credit_note became SECURITY DEFINER — current_user would never be a client role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND NOT prosecdef
              AND proname IN ('guard_pos_reservation_table_hold', 'record_pos_kot_removals_on_line_delete',
                              'record_pos_kot_removals_on_order_delete')) THEN
    RAISE EXCEPTION 'S755: a table-hold / KOT-removal trigger function is not SECURITY DEFINER';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
        'guard_pos_reservation_table_hold_ins', 'guard_pos_reservation_table_hold_upd',
        'guard_pos_reservation_table_hold', 'pos_kot_removal_snapshot',
        'record_pos_kot_removals_on_line_delete', 'trg_pos_order_delete_kot_removals')) <> 6 THEN
    RAISE EXCEPTION 'S755: expected six new triggers';
  END IF;
  -- The live-status list is the page's LIVE_STATUSES.
  IF NOT (public.pos_reservation_is_live('seated') AND public.pos_reservation_is_live('requested')
          AND NOT public.pos_reservation_is_live('completed') AND NOT public.pos_reservation_is_live(NULL)) THEN
    RAISE EXCEPTION 'S755: pos_reservation_is_live() disagrees with LIVE_STATUSES';
  END IF;
END
$assert$;

NOTIFY pgrst, 'reload schema';
