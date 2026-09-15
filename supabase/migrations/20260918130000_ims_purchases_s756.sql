-- S756 — IMS re-analysis, stage 3: the supplier's printed VAT and total on a purchase bill.
--
-- Owner decision D13 (2026-09-15). Two OPTIONAL bill-level figures typed straight off the paper
-- bill — "VAT on supplier's invoice" and "Invoice total". Left blank, nothing changes. Filled in,
-- the bill form, the Purchases register and the VAT Report compare them with Crest's own
-- calcBillTotals() figures and flag a difference past NPR 1, so a mis-keyed rate, a missed line or
-- a VAT tick on the wrong row is caught the day the bill is entered rather than at the VAT filing.
-- A flag, never a refusal: the comparison lives in the browser (purchasesHelpers.js
-- invoiceMismatch), and the database only stores what was typed.
--
-- Storage follows discount_amount: purchase_entries is one row per LINE, so the bill-level figure is
-- repeated on every line of the bill and read back once. Unlike the discount, NULL is meaningful
-- (blank = not typed; a bill that prints no VAT is typed as 0), so there is no COALESCE to 0 on the
-- way in and no NOT NULL. Existing rows stay NULL — no backfill, because nothing could know what a
-- past paper bill printed.
--
-- save_purchase_bill is the live body from 20260918110000 with two columns added to the INSERT.
-- Every check it carries — purchase_bill_has_payments, purchase_bill_has_returns (D26), the asserted
-- delete count (purchase_bill_stale), the po_id carry-through — is kept exactly.
--
-- Late returns (D10) need no schema change: a return already carries its own period_id and bs_day,
-- the closed-month guard (20260918100000) checks the RETURN's period, and the over-return cap is
-- read per purchase line in the browser. Nothing here touches vendor_returns.

ALTER TABLE public.purchase_entries
  ADD COLUMN IF NOT EXISTS invoice_vat_amount   numeric,
  ADD COLUMN IF NOT EXISTS invoice_total_amount numeric;

COMMENT ON COLUMN public.purchase_entries.invoice_vat_amount IS
  'S756 D13: VAT exactly as printed on the supplier''s bill. Bill-level, repeated on every line like discount_amount. NULL = not typed.';
COMMENT ON COLUMN public.purchase_entries.invoice_total_amount IS
  'S756 D13: grand total exactly as printed on the supplier''s bill. Bill-level, repeated on every line like discount_amount. NULL = not typed.';

ALTER TABLE public.purchase_entries DROP CONSTRAINT IF EXISTS purchase_entries_invoice_vat_nonnegative;
ALTER TABLE public.purchase_entries
  ADD CONSTRAINT purchase_entries_invoice_vat_nonnegative CHECK (invoice_vat_amount IS NULL OR invoice_vat_amount >= 0);
ALTER TABLE public.purchase_entries DROP CONSTRAINT IF EXISTS purchase_entries_invoice_total_nonnegative;
ALTER TABLE public.purchase_entries
  ADD CONSTRAINT purchase_entries_invoice_total_nonnegative CHECK (invoice_total_amount IS NULL OR invoice_total_amount >= 0);

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

    DELETE FROM purchase_entries WHERE id = ANY (p_superseded_ids);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted <> v_expected THEN
      RAISE EXCEPTION 'purchase_bill_stale: expected to replace % line(s), found %', v_expected, v_deleted
        USING ERRCODE = 'P0001',
              HINT = 'The bill changed since it was opened. Nothing was saved; reopen it from the list.';
    END IF;
  END IF;

  -- S756 (D13): the two invoice figures are NULLIF(…, '') and never COALESCEd — blank stays NULL
  -- ("not typed"), a typed 0 stays 0. A negative is refused by the CHECK constraints above.
  INSERT INTO purchase_entries
    (period_id, item_id, vendor_id, bs_day, qty, rate, invoice_ref, expiry_date,
     payment_method, vat_inclusive, discount_amount, purchase_group_id, created_at, po_id,
     invoice_vat_amount, invoice_total_amount)
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
         NULLIF(l ->> 'invoice_total_amount', '')::numeric
    FROM jsonb_array_elements(p_lines) AS l;

  SELECT min(created_at) INTO v_created
    FROM purchase_entries
   WHERE purchase_group_id = p_group_id;

  RETURN v_created;
END;
$function$;

NOTIFY pgrst, 'reload schema';

-- ══ Self-check ═══════════════════════════════════════════════════════════════════════════════════
--
-- Catalog assertions first, then the body is CALLED (a plpgsql body is only resolved on first
-- execution — S735), inside a sub-block whose closing RAISE rolls every write back. It runs as the
-- migration role, which the closed-month and rank triggers let through on their current_user seam,
-- so it exercises the INSERT and the constraints rather than being refused at a guard (S737). It
-- borrows the period and item of an existing bill line so no foreign key or client pairing can
-- differ from a real save; on an empty database it skips the call and says so.
DO $$
DECLARE
  v_period  uuid;
  v_item    uuid;
  v_group   uuid := gen_random_uuid();
  v_detail  text;
  v_refused boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'purchase_entries' AND column_name = 'invoice_vat_amount'
                    AND data_type = 'numeric' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'S756: purchase_entries.invoice_vat_amount missing or not nullable numeric';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'purchase_entries' AND column_name = 'invoice_total_amount'
                    AND data_type = 'numeric' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'S756: purchase_entries.invoice_total_amount missing or not nullable numeric';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid = 'public.purchase_entries'::regclass
         AND conname IN ('purchase_entries_invoice_vat_nonnegative', 'purchase_entries_invoice_total_nonnegative')
         AND contype = 'c') <> 2 THEN
    RAISE EXCEPTION 'S756: invoice amount CHECK constraints missing';
  END IF;
  -- The earlier refusals must have survived the replace.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure)
       NOT LIKE '%purchase_bill_has_returns%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure)
       NOT LIKE '%purchase_bill_has_payments%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz)'::regprocedure)
       NOT LIKE '%purchase_bill_stale%' THEN
    RAISE EXCEPTION 'S756: save_purchase_bill lost one of its refusals';
  END IF;
  -- One signature only: CREATE OR REPLACE on the same argument list must not have forked it.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'save_purchase_bill') <> 1 THEN
    RAISE EXCEPTION 'S756: save_purchase_bill has more than one signature';
  END IF;

  SELECT pe.period_id, pe.item_id INTO v_period, v_item FROM purchase_entries pe LIMIT 1;
  IF v_period IS NULL THEN
    RAISE NOTICE 'S756: no purchase_entries rows to borrow a period from; save_purchase_bill was not exercised';
    RETURN;
  END IF;

  -- (a) typed figures are stored on every line; blank stays NULL; a typed 0 stays 0.
  BEGIN
    PERFORM public.save_purchase_bill(v_period, v_group, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'bs_day', 1, 'qty', 1, 'rate', 100, 'vat_inclusive', true,
                         'invoice_vat_amount', '13', 'invoice_total_amount', '113'),
      jsonb_build_object('item_id', v_item, 'bs_day', 1, 'qty', 2, 'rate', 50, 'vat_inclusive', true,
                         'invoice_vat_amount', '13', 'invoice_total_amount', '113')), NULL, NULL);
    SELECT string_agg(COALESCE(invoice_vat_amount::text, 'null') || '/' || COALESCE(invoice_total_amount::text, 'null'), ',' ORDER BY qty)
      INTO v_detail FROM purchase_entries WHERE purchase_group_id = v_group;
    RAISE EXCEPTION 'S756_rollback' USING DETAIL = v_detail;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'S756_rollback' THEN RAISE; END IF;
    IF v_detail IS DISTINCT FROM '13/113,13/113' THEN
      RAISE EXCEPTION 'S756: save_purchase_bill stored invoice figures as %, expected 13/113 on both lines', v_detail;
    END IF;
  END;

  BEGIN
    PERFORM public.save_purchase_bill(v_period, v_group, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'bs_day', 1, 'qty', 1, 'rate', 100,
                         'invoice_vat_amount', '', 'invoice_total_amount', '0')), NULL, NULL);
    SELECT COALESCE(invoice_vat_amount::text, 'null') || '/' || COALESCE(invoice_total_amount::text, 'null')
      INTO v_detail FROM purchase_entries WHERE purchase_group_id = v_group;
    RAISE EXCEPTION 'S756_rollback' USING DETAIL = v_detail;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'S756_rollback' THEN RAISE; END IF;
    IF v_detail IS DISTINCT FROM 'null/0' THEN
      RAISE EXCEPTION 'S756: blank/zero invoice figures stored as %, expected null/0', v_detail;
    END IF;
  END;

  -- (b) a payload with neither key (an older bundle) still saves, both NULL.
  BEGIN
    PERFORM public.save_purchase_bill(v_period, v_group, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'bs_day', 1, 'qty', 1, 'rate', 100)), NULL, NULL);
    SELECT COALESCE(invoice_vat_amount::text, 'null') || '/' || COALESCE(invoice_total_amount::text, 'null')
      INTO v_detail FROM purchase_entries WHERE purchase_group_id = v_group;
    RAISE EXCEPTION 'S756_rollback' USING DETAIL = v_detail;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'S756_rollback' THEN RAISE; END IF;
    IF v_detail IS DISTINCT FROM 'null/null' THEN
      RAISE EXCEPTION 'S756: a payload without invoice keys stored %, expected null/null', v_detail;
    END IF;
  END;

  -- (c) a negative figure is refused by the CHECK.
  BEGIN
    PERFORM public.save_purchase_bill(v_period, v_group, jsonb_build_array(
      jsonb_build_object('item_id', v_item, 'bs_day', 1, 'qty', 1, 'rate', 100, 'invoice_total_amount', '-5')), NULL, NULL);
    RAISE EXCEPTION 'S756_rollback';
  EXCEPTION
    WHEN check_violation THEN v_refused := true;
    WHEN raise_exception THEN
      IF SQLERRM <> 'S756_rollback' THEN RAISE; END IF;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'S756: a negative invoice total was accepted';
  END IF;
END $$;
