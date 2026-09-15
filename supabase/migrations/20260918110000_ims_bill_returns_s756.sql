-- S756 — IMS re-analysis, stage 2: a bill with a return against it is not edited, and a bill
-- discount is never negative.
--
-- (1) Editing a bill orphaned its returns. save_purchase_bill replaces a bill's lines by DELETE +
-- INSERT with new ids, and vendor_returns.purchase_entry_id is ON DELETE SET NULL, so fixing a
-- typo on a 5,000 bill with a 1,200 return unlinked the return: Outstanding Payables and the
-- Vendor Balance Confirmation letter (both read returns by purchase_entry_id) put the 1,200 back
-- on what is owed, the VAT and Non-VAT reports dropped the return from input VAT, and ReturnsTab's
-- over-return cap reset so the same goods could be returned twice — with nothing on screen.
-- Owner decision D26 (2026-09-15): refuse the edit until the return is removed, the same shape
-- as purchase_bill_has_payments. Bill DELETE is left as it is: its confirm already says returns
-- are unlinked, and the tax reports now name unlinked returns rather than dropping them.
--
-- (2) purchase_entries.discount_amount had no CHECK and the form's min="0" sits outside a <form>,
-- so it enforced nothing; a mistyped -500 wrote a negative grand total into payables, the VAT base
-- and COGS. Live had no negative rows on 2026-09-15, so the constraint validates in place.
--
-- Body of save_purchase_bill is the live definition read on 2026-09-15 with one check added.

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
    -- would SET NULL them. An RLS-hidden return still blocks, which is the safe direction.
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
$function$;

ALTER TABLE public.purchase_entries DROP CONSTRAINT IF EXISTS purchase_entries_discount_nonnegative;
ALTER TABLE public.purchase_entries
  ADD CONSTRAINT purchase_entries_discount_nonnegative CHECK (discount_amount >= 0);

-- (3) Gate passes can be voided (owner decision D27). A wrongly issued pass could only be reprinted;
-- a void keeps its number and records who voided it and why, and a voided pass is final. Voiding
-- is supervisor+ (the page's own rank for correcting a pass); ims_caller_has_rank is 20260918100000.
ALTER TABLE public.ims_gate_passes
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason text;
ALTER TABLE public.ims_gate_passes DROP CONSTRAINT IF EXISTS ims_gate_passes_status_check;
ALTER TABLE public.ims_gate_passes ADD CONSTRAINT ims_gate_passes_status_check
  CHECK (status IN ('open', 'closed', 'voided'));
ALTER TABLE public.ims_gate_passes DROP CONSTRAINT IF EXISTS ims_gate_passes_void_complete;
ALTER TABLE public.ims_gate_passes ADD CONSTRAINT ims_gate_passes_void_complete
  CHECK ((status = 'voided') = (voided_at IS NOT NULL AND void_reason IS NOT NULL AND btrim(void_reason) <> ''));

CREATE OR REPLACE FUNCTION public.ims_gate_pass_void_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') OR COALESCE(public.is_admin(), false) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'ims_gate_passes: a voided gate pass cannot be changed'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  IF NEW.status = 'voided' AND NOT public.ims_caller_has_rank('supervisor') THEN
    RAISE EXCEPTION 'ims_gate_passes: voiding a gate pass needs an IMS supervisor, a manager or the account owner'
      USING ERRCODE = '42501', HINT = 'ims_rank';
  END IF;
  -- Attribution the subject can choose is not attribution.
  IF NEW.status = 'voided' THEN
    NEW.voided_by := (select auth.uid());
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.ims_gate_pass_void_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS ims_gate_pass_void_guard ON public.ims_gate_passes;
CREATE TRIGGER ims_gate_pass_void_guard BEFORE UPDATE ON public.ims_gate_passes
  FOR EACH ROW EXECUTE FUNCTION public.ims_gate_pass_void_guard();

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ims_gate_passes' AND column_name = 'void_reason') THEN
    RAISE EXCEPTION 'S756: ims_gate_passes.void_reason missing';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'save_purchase_bill') NOT LIKE '%purchase_bill_has_returns%' THEN
    RAISE EXCEPTION 'S756: save_purchase_bill is missing the returns refusal';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_entries_discount_nonnegative') THEN
    RAISE EXCEPTION 'S756: purchase_entries_discount_nonnegative missing';
  END IF;
END $$;
