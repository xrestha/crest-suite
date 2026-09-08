-- S698 — Purchases: a bill saves in ONE transaction, and a bill with payments cannot be deleted.
--
-- Two findings from the S698 re-analysis of the purchases module, fixed together because they
-- meet in the same place — the edit path deletes purchase_entries rows.
--
-- (1) The edit path was two HTTP requests: INSERT the replacement lines, then DELETE the ids the
--     form was opened on. A failure between them left the bill holding BOTH versions, and every
--     purchase figure in IMS counted it twice until someone noticed (the S648 error copy existed
--     precisely because this could happen). `save_purchase_bill` does both inside one statement-
--     level transaction: either the whole replacement lands or none of it does. Same shape as
--     `save_sales_day` (20260727120000), for the same reason.
--
-- (2) `payable_payments.purchase_entry_id` is ON DELETE CASCADE. So deleting a bill — or EDITING
--     one, since the edit path deletes its lines — silently erased every vendor payment recorded
--     against it in Outstanding Payables: money that actually left the bank vanished from Payment
--     Report and Vendor Balance Confirmation with no trace. Decision (Aashish, 2026-09-08): BLOCK.
--     A bill with payments cannot be deleted or edited until the payments are removed first.
--
--     The block lives in a BEFORE DELETE trigger, not only in the RPC and not only in the browser:
--     a delete the browser can skip is advisory (CLAUDE.md invariant #3), and the list page's own
--     Delete / Delete All never go through the RPC. The trigger keys off `current_user` exactly as
--     `guard_profiles_privileged_columns()` does, so the service role — Danger Zone deletes a
--     client's payable_payments BEFORE its purchase_entries anyway — passes through.
--
-- `purchase_bill_payments()` is the one lookup behind all three doors (trigger, RPC, and the list
-- page's pre-check so the refusal is worded before any write is attempted). It is SECURITY DEFINER
-- so the guard cannot pass vacuously for an account whose RLS view of payable_payments is narrower
-- than its view of purchase_entries — a guard that drops its read passes vacuously — and it checks
-- the caller itself (only entries of the caller's own client, or any for admin), wrapped in
-- COALESCE per the fail-open rule.

-- ── (a) The lookup ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_bill_payments(p_ids uuid[])
RETURNS TABLE (purchase_entry_id uuid, payment_count bigint, paid_total numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT pp.purchase_entry_id, count(*)::bigint, COALESCE(sum(pp.amount), 0)
    FROM payable_payments pp
    JOIN purchase_entries pe ON pe.id = pp.purchase_entry_id
    JOIN monthly_periods mp ON mp.id = pe.period_id
   WHERE pp.purchase_entry_id = ANY (p_ids)
     -- The caller check. current_user is the owner under DEFINER, so the service role is
     -- recognised by the absence of a JWT subject rather than by role name.
     AND COALESCE(
           (select auth.uid()) IS NULL
           OR is_admin()
           OR mp.client_id = my_client_id(),
           false)
   GROUP BY pp.purchase_entry_id;
$$;

REVOKE EXECUTE ON FUNCTION public.purchase_bill_payments(uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.purchase_bill_payments(uuid[]) TO authenticated, service_role;

-- ── (b) The delete guard ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.purchase_entries_guard_paid_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- SECURITY INVOKER on purpose: under DEFINER current_user would be the owner every time and the
  -- service-role carve-out could never fire (same reasoning as guard_profiles_privileged_columns).
  IF current_user IN ('anon', 'authenticated')
     AND EXISTS (SELECT 1 FROM purchase_bill_payments(ARRAY[OLD.id])) THEN
    RAISE EXCEPTION 'purchase_bill_has_payments: purchase entry % has vendor payments recorded against it', OLD.id
      USING ERRCODE = 'P0001',
            HINT = 'Remove the payments in Outstanding Payables first, then delete or edit the bill.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS purchase_entries_guard_paid_delete ON public.purchase_entries;
CREATE TRIGGER purchase_entries_guard_paid_delete
  BEFORE DELETE ON public.purchase_entries
  FOR EACH ROW EXECUTE FUNCTION public.purchase_entries_guard_paid_delete();

-- ── (c) The atomic save ─────────────────────────────────────────────────────────────────────
--
-- p_lines: json array of { item_id, vendor_id, bs_day, qty, rate, invoice_ref, expiry_date,
--          payment_method, vat_inclusive, discount_amount } — already in BASE units, exactly the
--          objects PurchaseBillForm built before (the qty × cf / rate ÷ cf convention is the
--          form's, not this function's).
-- p_superseded_ids: the ids the form was opened on (an edit), or NULL / empty (a new bill).
-- p_created_at: the bill's original entry stamp to carry forward on an edit (S670); NULL lets
--          DEFAULT now() fire, which is the new-bill path.
--
-- Returns the bill's created_at so the auto-printed voucher prints the server's stamp.
--
-- Deliberately NOT SECURITY DEFINER: purchase_entries carries the restrictive staff-isolation
-- families on top of its permissive period-scoped policy, and every one of them must keep
-- applying here exactly as it does to a plain insert. Nothing in this function needs to bypass
-- RLS, so it must not.
--
-- The delete runs FIRST inside the transaction and its row count is asserted. Under RLS a row the
-- caller may not delete simply does not delete, silently — and a row someone else already deleted
-- is the same silence — so an unasserted count is the S648 duplicate one layer down. A mismatch
-- rolls the whole save back with a message the form can act on.

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
     payment_method, vat_inclusive, discount_amount, purchase_group_id, created_at)
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
         COALESCE(p_created_at, now())
    FROM jsonb_array_elements(p_lines) AS l;

  SELECT min(created_at) INTO v_created
    FROM purchase_entries
   WHERE purchase_group_id = p_group_id;

  RETURN v_created;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.save_purchase_bill(uuid, uuid, jsonb, uuid[], timestamptz) TO authenticated, service_role;

-- ── (d) Assertions ──────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'purchase_entries' AND t.tgname = 'purchase_entries_guard_paid_delete' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'purchase_entries_guard_paid_delete trigger missing';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE proname = 'save_purchase_bill') THEN
    RAISE EXCEPTION 'save_purchase_bill must stay SECURITY INVOKER';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE proname = 'purchase_bill_payments') THEN
    RAISE EXCEPTION 'purchase_bill_payments must be SECURITY DEFINER';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
