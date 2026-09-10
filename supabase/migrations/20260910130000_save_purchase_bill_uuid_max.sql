-- S735 — save_purchase_bill: editing any bill failed with `42883 function max(uuid) does not exist`.
--
-- S709 taught `save_purchase_bill` to carry `po_id` through an edit with one line:
--
--     SELECT max(po_id) INTO v_po_id FROM purchase_entries WHERE id = ANY (p_superseded_ids);
--
-- `po_id` is a uuid, and Postgres ships no `max(uuid)` aggregate — uuid has no ordering
-- operator class the btree aggregates can use. The migration still applied cleanly, because
-- plpgsql does not resolve the SQL inside a function body at CREATE time; it resolves each
-- statement the first time it runs. So the function existed, the S709 assertion that its source
-- mentions `v_po_id` passed, and the first person to open an existing bill and press Save got
-- the error above — on EVERY edit, not just edits of a received delivery, because the read runs
-- whenever `p_superseded_ids` is non-empty, and it is non-empty for every edit. New bills
-- (no superseded rows) were unaffected, which is why it took a day to surface.
--
-- The frontend rendered it as "This part of the app is ahead of the database — a migration
-- hasn't been applied yet", which is what 42883 usually means and was wrong here: the migration
-- HAD been applied. Nothing was saved either way — the read is the first statement inside the
-- superseded branch, before the DELETE, so no bill was half-replaced.
--
-- The replacement keeps S709's intent exactly: one bill is one receipt from one order, so there
-- is a single non-NULL `po_id` to inherit whether the form kept every line or dropped some, and
-- NULL for a bill typed in by hand. `WHERE po_id IS NOT NULL … LIMIT 1` picks it without needing
-- an aggregate. Nothing else about the function changes — the S709 body reproduced in full,
-- because CREATE OR REPLACE has no other form.
--
-- The assertion at the bottom now also checks that the source no longer contains `max(po_id)`,
-- which is the check S709 should have had: a source-text assertion can confirm a feature is
-- present, but not that the statement expressing it is executable. The verification block runs
-- the function once against a throwaway bill inside a rolled-back transaction, which is the only
-- thing that actually proves it.

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

    -- Read BEFORE the delete, or there is nothing left to read it from (S709). Not an aggregate:
    -- Postgres has no max() over uuid, and plpgsql only resolves the expression on first
    -- execution, so S709's form created fine and failed the first edit (S735).
    SELECT pe.po_id INTO v_po_id
      FROM purchase_entries pe
     WHERE pe.id = ANY (p_superseded_ids)
       AND pe.po_id IS NOT NULL
     LIMIT 1;

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

-- Assertions -----------------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE proname = 'save_purchase_bill') THEN
    RAISE EXCEPTION 'save_purchase_bill must stay SECURITY INVOKER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'save_purchase_bill' AND prosrc LIKE '%v_po_id%'
  ) THEN
    RAISE EXCEPTION 'save_purchase_bill is not carrying po_id through an edit';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'save_purchase_bill' AND prosrc LIKE '%max(po_id)%'
  ) THEN
    RAISE EXCEPTION 'save_purchase_bill still aggregates a uuid with max()';
  END IF;
  -- Belt and braces: the aggregate must genuinely not exist for uuid, or this migration is
  -- fixing nothing and the real cause is elsewhere.
  IF to_regprocedure('pg_catalog.max(uuid)') IS NOT NULL THEN
    RAISE NOTICE 'max(uuid) exists on this server — the fix is harmless but was not the cause';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- Verification ---------------------------------------------------------------------------------
--   -- the source no longer carries the uuid aggregate
--   SELECT prosrc LIKE '%max(po_id)%' AS still_broken FROM pg_proc WHERE proname = 'save_purchase_bill';
--   -- expected: false
--
--   -- the superseded branch actually executes: pick any bill and replace it with itself
--   BEGIN;
--   SELECT save_purchase_bill(pe.period_id, pe.purchase_group_id,
--            jsonb_build_array(jsonb_build_object('item_id', pe.item_id, 'vendor_id', pe.vendor_id,
--              'bs_day', pe.bs_day, 'qty', pe.qty, 'rate', pe.rate)),
--            ARRAY[pe.id], pe.created_at)
--     FROM purchase_entries pe LIMIT 1;
--   ROLLBACK;
--   -- expected: one timestamptz, no 42883
