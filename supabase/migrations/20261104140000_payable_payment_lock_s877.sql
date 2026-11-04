-- S877: a supplier bill can no longer be paid twice by two screens at once.
--
-- Outstanding Payables re-reads what is already paid on a bill just before it records a payment
-- (S792, PURCHASES-10), but the read and the insert are two requests. Two managers pressing Pay on
-- the same bill in the same second both pass the read, and both payments land: the bill then reads
-- as a Credit and the supplier appears to owe the outlet money. The settle stamp
-- (purchase_entries.paid_at) was a third request, so a refused stamp left a payment recorded on a
-- bill still listed as outstanding.
--
-- record_payable_payments() does all three in one transaction:
--   1. locks every bill line the payment touches (and every line a supplier credit is taken from),
--      in id order, FOR NO KEY UPDATE, so a second payer waits here for the first to commit;
--   2. compares the payments now on those lines with the ones the page saw (p_seen: id and amount),
--      and refuses with HINT payables_moved if anything moved, before writing anything;
--   3. inserts the payment rows and stamps paid_at on the lines the payment settles, refusing with
--      HINT payables_settle_short (and so writing nothing) if fewer lines could be stamped.
-- No money formula lives here: what a bill owes stays the page's arithmetic (payablesAllocation.js).
-- The guard is about what moved, never about how much is owed.
--
-- SECURITY INVOKER: the payment rank guard, RLS, the closed-month guard (a paid_at-only update
-- passes it by design) and the deferred supplier-credit pair check all still apply to the caller.
-- A page from before this release still inserts directly; it gains the lock once it reloads.
--
-- Reverse: DROP FUNCTION public.record_payable_payments(uuid, jsonb, jsonb, uuid[], uuid[], date);
-- the page's direct insert path is in git history (OutstandingPayables.js before S877).

CREATE OR REPLACE FUNCTION public.record_payable_payments(
  p_client_id  uuid,
  p_rows       jsonb,
  p_seen       jsonb,
  p_line_ids   uuid[],
  p_settle_ids uuid[] DEFAULT NULL::uuid[],
  p_paid_at    date   DEFAULT NULL::date
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lines    uuid[];
  v_locked   integer;
  v_moved    boolean;
  v_inserted integer;
  v_settle   uuid[];
  v_settled  integer := 0;
BEGIN
  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'p_client_id is required';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'p_rows must be a non-empty json array';
  END IF;
  IF p_seen IS NULL OR jsonb_typeof(p_seen) <> 'array' THEN
    RAISE EXCEPTION 'p_seen must be a json array (empty when the page saw no payments)';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE NULLIF(r->>'purchase_entry_id', '') IS NULL) THEN
    RAISE EXCEPTION 'every payment row must name its bill line (purchase_entry_id)';
  END IF;

  -- Every line checked: the ones named by the page, plus every line a row pays, so a caller cannot
  -- write to a line it did not ask to have checked.
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_lines
    FROM (
      SELECT unnest(COALESCE(p_line_ids, '{}'::uuid[])) AS x
      UNION
      SELECT (r->>'purchase_entry_id')::uuid FROM jsonb_array_elements(p_rows) r
    ) s
   WHERE x IS NOT NULL;

  -- 1. Lock. Rows this login cannot see or update are not locked, and a payment against a line it
  -- cannot lock is not one it can check, so that refuses too.
  SELECT count(*) INTO v_locked
    FROM (SELECT pe.id FROM purchase_entries pe
           WHERE pe.id = ANY (v_lines)
           ORDER BY pe.id
           FOR NO KEY UPDATE) l;
  IF v_locked < COALESCE(cardinality(v_lines), 0) THEN
    RAISE EXCEPTION 'payables_lines_unreadable: % of % bill lines could be checked', v_locked, cardinality(v_lines)
      USING ERRCODE = 'P0001', HINT = 'payables_lines_unreadable';
  END IF;

  -- 2. Has anything been paid on these lines since the page read them? Compared to the paisa.
  SELECT EXISTS (
           (SELECT pp.id, round(pp.amount * 100)::bigint FROM payable_payments pp
             WHERE pp.purchase_entry_id = ANY (v_lines)
            EXCEPT
            SELECT (s->>'id')::uuid, round((s->>'amount')::numeric * 100)::bigint
              FROM jsonb_array_elements(p_seen) s)
           UNION ALL
           (SELECT (s->>'id')::uuid, round((s->>'amount')::numeric * 100)::bigint
              FROM jsonb_array_elements(p_seen) s
            EXCEPT
            SELECT pp.id, round(pp.amount * 100)::bigint FROM payable_payments pp
             WHERE pp.purchase_entry_id = ANY (v_lines))
         ) INTO v_moved;
  IF v_moved THEN
    RAISE EXCEPTION 'payables_moved: a payment on these bills changed since the page read them'
      USING ERRCODE = 'P0001', HINT = 'payables_moved';
  END IF;

  -- 3. Write. One statement for every row, so both halves of a supplier-credit pair are inserted
  -- together and the deferred pair check sees them at commit.
  INSERT INTO payable_payments (client_id, purchase_entry_id, amount, paid_at, note, payment_mode, credit_link_id)
  SELECT p_client_id, r.purchase_entry_id, r.amount, COALESCE(r.paid_at, p_paid_at, (now() AT TIME ZONE 'Asia/Kathmandu')::date),
         r.note, r.payment_mode, r.credit_link_id
    FROM jsonb_to_recordset(p_rows) AS r(purchase_entry_id uuid, amount numeric, paid_at date, note text,
                                         payment_mode text, credit_link_id uuid);
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  SELECT array_agg(DISTINCT x) INTO v_settle
    FROM unnest(COALESCE(p_settle_ids, '{}'::uuid[])) x WHERE x IS NOT NULL;
  IF COALESCE(cardinality(v_settle), 0) > 0 THEN
    IF NOT (v_settle <@ v_lines) THEN
      RAISE EXCEPTION 'p_settle_ids must be lines this payment checked';
    END IF;
    UPDATE purchase_entries SET paid_at = COALESCE(p_paid_at, (now() AT TIME ZONE 'Asia/Kathmandu')::date)
     WHERE id = ANY (v_settle);
    GET DIAGNOSTICS v_settled = ROW_COUNT;
    IF v_settled < cardinality(v_settle) THEN
      RAISE EXCEPTION 'payables_settle_short: % of % bill lines could be marked as paid', v_settled, cardinality(v_settle)
        USING ERRCODE = 'P0001', HINT = 'payables_settle_short';
    END IF;
  END IF;

  RETURN jsonb_build_object('inserted', v_inserted, 'settled', v_settled);
END
$function$;

REVOKE ALL ON FUNCTION public.record_payable_payments(uuid, jsonb, jsonb, uuid[], uuid[], date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_payable_payments(uuid, jsonb, jsonb, uuid[], uuid[], date) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_payable_payments(uuid, jsonb, jsonb, uuid[], uuid[], date) TO authenticated;

NOTIFY pgrst, 'reload schema';
