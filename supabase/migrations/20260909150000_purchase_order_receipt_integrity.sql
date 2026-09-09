-- S709 — Purchase Orders: a receipt is one transaction, and the bills it writes point back at it.
--
-- Findings from the S709 re-analysis of Purchase Orders, which had never had the sweep its own
-- sibling got. `Purchases.js` was rebuilt in S698 — atomic save, asserted row counts, a paid-bill
-- guard in a trigger — and `PurchaseOrders.js` writes the SAME table (`purchase_entries`) through
-- a path that had none of it. Four defects met in one place, so they are fixed in one function.
--
-- (1) THE RECEIPT WAS FOUR ROUND TRIPS AND THE LAST TWO COULD FAIL SILENTLY. `confirmReceive`
--     inserted the purchase entries, then fired one `qty_received` UPDATE per line, then updated
--     the PO's status — and the status write dropped its error entirely. A dropped status write
--     leaves the PO on `draft` with `qty_received` already banked, and `draft` is exactly the
--     status that still offers **Edit** — whose save replaces every line row with a fresh one at
--     `qty_received = 0`. The delivery then reads as never received and can be received, and
--     billed, a second time. Every step of that chain shipped.
--
-- (2) `qty_received` WAS A READ-MODIFY-WRITE OFF THE BROWSER'S SNAPSHOT. The value written was
--     `l.qty_received + receiving`, where `l.qty_received` was read when the screen opened. Two
--     people receiving against one PO — a storekeeper at the door and a manager at the desk, the
--     ordinary case for a delivery — and the second write erases the first. The remaining-quantity
--     check was computed off the same stale number, so the over-receive guard cannot see it either.
--     `qty_received = qty_received + delta` inside the statement is the only form that survives
--     this, and it is what makes the guard's arithmetic true at the moment it is applied.
--
-- (3) NOTHING LINKED A BILL BACK TO THE PO IT CAME FROM. `purchase_entries` had no `po_id`; the
--     only trace was `invoice_ref = po_number`, free text that Purchases lets anyone overwrite.
--     So: delete the bill and the PO still reads **Received** with the Receive button gone and no
--     way back; edit the bill's quantity and ordered-versus-billed silently diverges; and no report
--     can ever answer "what did we order, and what actually arrived against it". This is the
--     two-writes-diverge rule (CLAUDE.md) with the second write in a different table — the fix it
--     prescribes is the same, give each table its own link back to the source row.
--
-- (4) THE DELETE GUARD LIVED ONLY IN THE PAGE. `deletePo` is `if (!isAdmin) return`, and that is
--     the whole of it. `purchase_orders` carries the S542 permissive policy plus RESTRICTIVE
--     fences against POS PIN staff and HR self-service — there is no `no_ims_staff` fence, because
--     IMS needs its orders — so `DELETE /rest/v1/purchase_orders?id=eq.<uuid>` succeeds today for
--     every IMS account of any rank, including `ims_role = 'staff'`, which cannot open the page
--     (`hasImsAccess('supervisor')`) and never sees the button. S707's sentence, one table over:
--     a delete guard that lives only in the page is a guard on the page, not on the table.
--
-- WHY THE RPC IS SECURITY INVOKER. Same reason `save_purchase_bill` and `save_sales_day` are:
-- `purchase_entries` and `purchase_order_items` both carry the restrictive staff-isolation
-- families on top of their permissive policies, and every one of them must keep applying here
-- exactly as it does to a plain insert. Nothing in this function needs to bypass RLS, so it must
-- not. The one thing it deliberately DOES enforce beyond RLS is the closed-period lock, which is
-- policy rather than isolation and had no server-side existence at all before this.
--
-- WHAT THIS FUNCTION DOES NOT VALIDATE: the BS day. The calendar table is JavaScript
-- (`src/utils/bsCalendar.js`), so `daysInBsMonth` has no SQL twin and day 32 in a 30-day Ashwin
-- can only be caught in the page — which now does it, against the PO's OWN period rather than the
-- 1..32 the column's CHECK allows. Duplicating the era table here to close that would put a second
-- copy of the calendar in the schema, which is a worse bug than the one it fixes.

-- ── (a) The link ────────────────────────────────────────────────────────────────────────────
--
-- ON DELETE SET NULL, and then a trigger in (d) that stops the app ever firing it. The two are not
-- in tension: the FK's job here is to keep `deleteClientData` working (it empties purchase_entries
-- well before it reaches purchase_orders, so the SET NULL never fires there either) and to make
-- the column impossible to orphan; the trigger's job is to make sure a client account cannot
-- delete a PO out from under bills that cite it. Per the `confdeltype` rule, the FK is NOT the
-- guard — it is the thing that fails silently if you mistake it for one.
--
-- Nullable, and permanently so: every receipt written before this migration has no PO to point at,
-- and every bill entered by hand in Purchases has no PO by definition. `po_id IS NULL` means "not
-- from a purchase order", never "unknown".

ALTER TABLE public.purchase_entries
  ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.purchase_entries.po_id IS
  'The purchase order this bill line was received against (S709). NULL for a bill entered directly '
  'in Purchases, and for every receipt written before 2026-09-09 — the pre-S709 receipt path left '
  'no link but invoice_ref = po_number, which is free text. Never infer "unknown" from NULL.';

-- The FK filter column, per the project's index discipline: the delete guard below reads it on
-- every PO delete, and the page reads it per PO to show what has already been billed.
CREATE INDEX IF NOT EXISTS idx_purchase_entries_po_id
  ON public.purchase_entries (po_id) WHERE po_id IS NOT NULL;

-- ── (b) The receipt lookup ──────────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER for the reason the S708 sibling is: a guard that drops its read passes
-- vacuously. The delete guard in (d) asks this whether a PO has been billed, and if the caller's
-- RLS view of `purchase_entries` were ever narrower than its view of `purchase_orders`, the honest
-- answer "I cannot see any" would arrive as "there are none" and the guard would fail open for
-- precisely the account it exists to stop. The caller check is on the PO's client, wrapped in
-- COALESCE per the fail-open rule (`is_admin()` returns NULL, not false, for a client account),
-- and the service role is recognised by the absence of a JWT subject rather than by role name.
--
-- Output columns are prefixed `ref_`: a RETURNS TABLE column name is in scope inside the body and
-- `po_id` is a real column on purchase_entries, so naming it that makes the WHERE ambiguous.
--
-- `entry_total` is the ex-VAT, pre-discount goods value (qty × rate) — the same base every other
-- purchase figure in IMS is built on, NOT a bill total. It exists so the receive screen can say
-- what has already been billed against this PO; nothing costs a period from it.

CREATE OR REPLACE FUNCTION public.purchase_order_receipts(p_ids uuid[])
RETURNS TABLE (ref_po_id uuid, entry_count bigint, entry_total numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT pe.po_id, count(*)::bigint, COALESCE(sum(pe.qty * pe.rate), 0)
    FROM purchase_entries pe
    JOIN purchase_orders po ON po.id = pe.po_id
   WHERE pe.po_id = ANY (p_ids)
     AND COALESCE(
           (select auth.uid()) IS NULL
           OR is_admin()
           OR po.client_id = my_client_id(),
           false)
   GROUP BY pe.po_id;
$fn$;

REVOKE EXECUTE ON FUNCTION public.purchase_order_receipts(uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.purchase_order_receipts(uuid[]) TO authenticated, service_role;

-- ── (c) The atomic receipt ──────────────────────────────────────────────────────────────────
--
-- p_lines: json array of { po_item_id, qty, rate } — qty and rate in BASE units, already
--          VAT-adjusted by the caller if the vendor's rates were VAT-inclusive. The rate comes
--          from the browser rather than from `purchase_order_items.unit_price` for the same reason
--          `save_purchase_bill` takes its rates from the form: the 13% divisor is JavaScript's
--          (`calcBillTotals`), and a second copy of a tax rate in the schema is how the two come
--          to disagree. What the browser may NOT choose is which item, which vendor, which period
--          or which invoice reference — all four are read from the PO here, so a receipt cannot
--          name a line the order does not have.
--
-- Returns the PO's recomputed status so the caller renders what the database decided rather than
-- what it predicted.
--
-- Every refusal happens BEFORE the insert, and every write is in one statement-level transaction:
-- either the bills, the quantities and the status all land, or none of them do. That is the whole
-- point — the old path could and did stop between them.

CREATE OR REPLACE FUNCTION public.receive_purchase_order(
  p_po_id          uuid,
  p_bs_day         integer,
  p_payment_method text,
  p_vat_inclusive  boolean,
  p_group_id       uuid,
  p_lines          jsonb
) RETURNS text
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_po        purchase_orders%ROWTYPE;
  v_period    monthly_periods%ROWTYPE;
  v_line      jsonb;
  v_item      purchase_order_items%ROWTYPE;
  v_qty       numeric;
  v_remaining numeric;
  v_updated   integer;
  v_all       boolean;
  v_any       boolean;
  v_status    text;
BEGIN
  IF p_po_id IS NULL THEN
    RAISE EXCEPTION 'p_po_id is required';
  END IF;
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'p_group_id is required';
  END IF;
  IF p_bs_day IS NULL OR p_bs_day < 1 OR p_bs_day > 32 THEN
    RAISE EXCEPTION 'p_bs_day must be 1-32';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'p_lines must be a non-empty json array';
  END IF;

  -- FOR UPDATE: this is the row every concurrent receipt against this PO must queue behind, so
  -- the remaining-quantity checks below are evaluated one receipt at a time rather than by two
  -- browsers reading the same "remaining" and each deciding it fits.
  SELECT * INTO v_po FROM purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Also the RLS answer: a PO of another client is invisible, not forbidden. Same message
    -- either way, because from here the two are the same fact.
    RAISE EXCEPTION 'po_not_found: purchase order % is not available', p_po_id
      USING ERRCODE = 'P0001',
            HINT = 'Reload the Purchase Orders list.';
  END IF;

  IF v_po.status IN ('cancelled', 'received') THEN
    RAISE EXCEPTION 'po_not_receivable: purchase order % is %', v_po.po_number, v_po.status
      USING ERRCODE = 'P0001',
            HINT = 'A cancelled or fully received order cannot take another delivery. Raise a new PO.';
  END IF;

  -- Fail CLOSED if the period cannot be read: an unreadable period is not an open one, and
  -- defaulting it to 'open' would make the lock below evaluate in the permissive direction for
  -- exactly the caller whose view is narrowest.
  SELECT * INTO v_period FROM monthly_periods WHERE id = v_po.period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'po_not_found: the period behind purchase order % is not available', v_po.po_number
      USING ERRCODE = 'P0001',
            HINT = 'Reload the Purchase Orders list.';
  END IF;

  -- The closed-period lock, server-side for the first time. `!isAdmin && status === 'closed'` is
  -- spelled in five entry pages (closed-periods.md) and was missing from this one, which meant the
  -- one page in the module with no lock was writing the same table as the four that have it. The
  -- admin carve-out is the same one those five make, and is the feature, not an oversight.
  IF v_period.status = 'closed' AND NOT COALESCE(is_admin(), false) THEN
    RAISE EXCEPTION 'po_period_closed: period % is closed', v_po.period_id
      USING ERRCODE = 'P0001',
            HINT = 'Ask a Crest operator to enter it, or receive the delivery into the open period.';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_qty := round(COALESCE((v_line ->> 'qty')::numeric, 0), 3);
    IF v_qty <= 0 THEN
      CONTINUE;
    END IF;

    SELECT * INTO v_item
      FROM purchase_order_items
     WHERE id = (v_line ->> 'po_item_id')::uuid
       AND po_id = p_po_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'po_receipt_stale: line % is not on purchase order %', v_line ->> 'po_item_id', v_po.po_number
        USING ERRCODE = 'P0001',
              HINT = 'The order changed since this screen was opened. Nothing was received; reopen it from the list.';
    END IF;

    -- Evaluated against the row as it is NOW, under the lock — not against the number the browser
    -- was holding. numeric is exact, so the rounding above is only to absorb the float the
    -- browser's own arithmetic produces (0.1 + 0.2 in a qty box), never to widen the check.
    v_remaining := round(v_item.qty_ordered - COALESCE(v_item.qty_received, 0), 3);
    IF v_qty > v_remaining THEN
      RAISE EXCEPTION 'po_over_receive: % over the % still on order for line %', v_qty - v_remaining, v_remaining, v_item.id
        USING ERRCODE = 'P0001',
              HINT = 'Someone may have received against this order already. Reopen it to see what is left.';
    END IF;

    INSERT INTO purchase_entries
      (period_id, item_id, vendor_id, bs_day, qty, rate, invoice_ref,
       payment_method, vat_inclusive, purchase_group_id, po_id)
    VALUES
      (v_po.period_id, v_item.item_id, v_po.vendor_id, p_bs_day, v_qty,
       COALESCE(round((v_line ->> 'rate')::numeric, 2), 0),
       v_po.po_number,
       COALESCE(NULLIF(p_payment_method, ''), 'Credit'),
       COALESCE(p_vat_inclusive, false),
       p_group_id,
       p_po_id);

    -- The increment, not an assignment. See (2) in the header.
    UPDATE purchase_order_items
       SET qty_received = COALESCE(qty_received, 0) + v_qty
     WHERE id = v_item.id AND po_id = p_po_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      -- Under RLS a row the caller may not update simply does not update, silently. Unasserted,
      -- that is a bill written against a quantity that never moved — the exact divergence this
      -- function exists to make impossible.
      RAISE EXCEPTION 'po_receipt_stale: could not record the received quantity for line %', v_item.id
        USING ERRCODE = 'P0001',
              HINT = 'Nothing was received. Reopen the order from the list and try again.';
    END IF;
  END LOOP;

  -- Recomputed from the table, not from what the browser thought the totals would become. Over
  -- zero rows bool_and returns NULL, so a PO with no lines keeps the status it had.
  SELECT bool_and(COALESCE(qty_received, 0) >= qty_ordered),
         bool_or(COALESCE(qty_received, 0) > 0)
    INTO v_all, v_any
    FROM purchase_order_items WHERE po_id = p_po_id;

  v_status := CASE WHEN v_all THEN 'received'
                   WHEN v_any THEN 'partial'
                   ELSE v_po.status END;

  IF v_status IS DISTINCT FROM v_po.status THEN
    UPDATE purchase_orders SET status = v_status WHERE id = p_po_id;
  END IF;

  RETURN v_status;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.receive_purchase_order(uuid, integer, text, boolean, uuid, jsonb) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.receive_purchase_order(uuid, integer, text, boolean, uuid, jsonb) TO authenticated, service_role;

-- ── (d) The delete guard ────────────────────────────────────────────────────────────────────
--
-- Two refusals, in the order the page offers them.
--
-- `po_delete_not_permitted` enforces what the page already claims — Delete renders only for
-- `isAdmin`, the Crest operator, and the tooltip says "Admin only". It was true of the button and
-- of nothing else. Note this is the OPERATOR, not the client's Owner: a PO is a document the
-- client can cancel (which keeps it on the list as a record) and an operator can remove.
--
-- `po_has_receipts` is new policy, and the decision behind it is the one the vendors and items
-- guards already made twice: a document with history is archived or cancelled, never deleted. A
-- PO that has been billed against is the order those bills came from; deleting it would strip
-- `po_id` off them through the FK's SET NULL and take the reconciliation with it — silently, which
-- is the half of `confdeltype` that has no error. Cancel is the way through and loses nothing.
-- Only receipts written from S709 onward carry `po_id`, so this refuses on real evidence and stays
-- quiet where there is none.
--
-- SECURITY INVOKER, for the third time in this codebase and the same reason: `current_user` is the
-- only seam that separates a browser JWT from the service role, and under DEFINER it would be the
-- owner every time and the carve-out could never fire. Danger Zone (service role) must stay able
-- to empty a client — it deletes purchase_entries long before purchase_orders, so by the time it
-- arrives here there are no receipts to find anyway.

CREATE OR REPLACE FUNCTION public.purchase_orders_guard_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF NOT COALESCE(is_admin(), false) THEN
      RAISE EXCEPTION 'po_delete_not_permitted: purchase order % may only be deleted by an operator', OLD.po_number
        USING ERRCODE = 'P0001',
              HINT = 'Cancel the order instead — it stays on the list as a record and can no longer be received against.';
    END IF;

    IF EXISTS (SELECT 1 FROM purchase_order_receipts(ARRAY[OLD.id])) THEN
      RAISE EXCEPTION 'po_has_receipts: purchase order % has bills received against it', OLD.po_number
        USING ERRCODE = 'P0001',
              HINT = 'Cancel the order instead, or delete its bills in Purchases first.';
    END IF;
  END IF;
  RETURN OLD;
END;
$fn$;

DROP TRIGGER IF EXISTS purchase_orders_guard_delete ON public.purchase_orders;
CREATE TRIGGER purchase_orders_guard_delete
  BEFORE DELETE ON public.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.purchase_orders_guard_delete();

-- ── (e) The link has to survive an EDIT of the bill it is on ────────────────────────────────
--
-- `save_purchase_bill` (S698) replaces a bill by deleting its rows and inserting the replacements
-- in one transaction. Its INSERT names its columns explicitly and knew nothing of `po_id`, so the
-- first time anyone opened a received delivery in Purchases and corrected a quantity, the new rows
-- came back with po_id NULL — the order would show no bills, become deletable again, and the
-- receive screen would stop saying what it had already produced. A link that survives everything
-- except the ordinary act of correcting a typo is not a link.
--
-- The replacement rows inherit the po_id of the rows they supersede. One bill is one receipt from
-- one order, so there is a single value to inherit; `max()` over the superseded set picks it
-- whether the form kept every line or dropped some, and stays NULL for a bill that was typed in
-- by hand, which is the overwhelming majority. Nothing else about the function changes — this is
-- the S698 body with two lines added, reproduced in full because CREATE OR REPLACE has no other
-- form. Keep the two copies' history in mind when editing either.

CREATE OR REPLACE FUNCTION public.save_purchase_bill(
  p_period_id      uuid,
  p_group_id       uuid,
  p_lines          jsonb,
  p_superseded_ids uuid[] DEFAULT NULL,
  p_created_at     timestamptz DEFAULT NULL
) RETURNS timestamptz
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_deleted  integer := 0;
  v_expected integer := COALESCE(cardinality(p_superseded_ids), 0);
  v_created  timestamptz;
  v_po_id    uuid;
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

    -- Read BEFORE the delete, or there is nothing left to read it from (S709).
    SELECT max(po_id) INTO v_po_id FROM purchase_entries WHERE id = ANY (p_superseded_ids);

    DELETE FROM purchase_entries WHERE id = ANY (p_superseded_ids);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> v_expected THEN
      RAISE EXCEPTION 'purchase_bill_stale: expected to replace % line(s), found %', v_expected, v_deleted
        USING ERRCODE = 'P0001',
              HINT = 'The bill changed since it was opened. Nothing was saved; reopen it from the list.';
    END IF;
  END IF;

  INSERT INTO purchase_entries
    (period_id, item_id, vendor_id, bs_day, qty, rate, invoice_ref, expiry_date,
     payment_method, vat_inclusive, discount_amount, purchase_group_id, created_at, po_id)
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
         v_po_id
    FROM jsonb_array_elements(p_lines) AS l;

  SELECT min(created_at) INTO v_created
    FROM purchase_entries
   WHERE purchase_group_id = p_group_id;

  RETURN v_created;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz) TO authenticated, service_role;

-- ── (f) Assertions ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'purchase_entries' AND column_name = 'po_id'
  ) THEN
    RAISE EXCEPTION 'purchase_entries.po_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'purchase_orders' AND t.tgname = 'purchase_orders_guard_delete' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'purchase_orders_guard_delete trigger missing';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE proname = 'receive_purchase_order') THEN
    RAISE EXCEPTION 'receive_purchase_order must stay SECURITY INVOKER';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE proname = 'purchase_orders_guard_delete') THEN
    RAISE EXCEPTION 'purchase_orders_guard_delete must stay SECURITY INVOKER';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'purchase_order_receipts') THEN
    RAISE EXCEPTION 'purchase_order_receipts must be SECURITY DEFINER';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE proname = 'save_purchase_bill') THEN
    RAISE EXCEPTION 'save_purchase_bill must stay SECURITY INVOKER';
  END IF;
  -- The replacement carries po_id through an edit; without this the link dies on the first
  -- correction anyone makes to a received bill in Purchases.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'save_purchase_bill' AND prosrc LIKE '%v_po_id%'
  ) THEN
    RAISE EXCEPTION 'save_purchase_bill is not carrying po_id through an edit';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   -- the link exists and is indexed
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name = 'purchase_entries' AND column_name = 'po_id';
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_purchase_entries_po_id';
--
--   -- the FK is SET NULL (n), which is why the trigger above exists rather than being trusted
--   SELECT conname, confdeltype FROM pg_constraint
--    WHERE conrelid = 'public.purchase_entries'::regclass AND conname LIKE '%po_id%';
--
--   -- a receipt is atomic: run as a client JWT in a transaction you roll back
--   BEGIN;
--     SELECT receive_purchase_order(
--       '<po id>', 15, 'Credit', false, gen_random_uuid(),
--       '[{"po_item_id":"<line id>","qty":5,"rate":120}]'::jsonb);   -- expect 'partial' or 'received'
--     SELECT qty_received FROM purchase_order_items WHERE id = '<line id>';
--     SELECT po_id, qty, rate, invoice_ref FROM purchase_entries WHERE po_id = '<po id>';
--   ROLLBACK;
--
--   -- over-receiving is refused against the CURRENT remaining, not the browser's
--   BEGIN;
--     SELECT receive_purchase_order('<po id>', 15, 'Credit', false, gen_random_uuid(),
--       '[{"po_item_id":"<line id>","qty":999999,"rate":120}]'::jsonb);  -- expect P0001 po_over_receive
--   ROLLBACK;
--
--   -- a closed period refuses for a client account and passes for an operator
--   BEGIN;
--     SELECT receive_purchase_order('<po in a closed period>', 15, 'Credit', false,
--       gen_random_uuid(), '[{"po_item_id":"<line id>","qty":1,"rate":10}]'::jsonb);
--     -- expect P0001 po_period_closed as a client, and a status string as admin
--   ROLLBACK;
--
--   -- and the delete guard refuses on both counts. Before this migration BOTH succeeded:
--   BEGIN;
--     DELETE FROM purchase_orders WHERE id = '<any po>';        -- as a non-admin IMS account
--     -- expect P0001 po_delete_not_permitted
--   ROLLBACK;
--   BEGIN;
--     DELETE FROM purchase_orders WHERE id = '<a po with receipts>';  -- as admin
--     -- expect P0001 po_has_receipts
--   ROLLBACK;
