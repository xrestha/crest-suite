-- S885: clear a tiny leftover on a supplier bill without paying it.
--
-- Owner decisions (2026-11-04, asked in plain words): a bill with NPR 10 or less left can be cleared by
-- the Owner or an IMS manager (the payment rank already on payable_payments), asking first and
-- recording who did it. The NPR 10 limit is per bill. A cleared amount is never money paid: it shows
-- as "written off", it can never be turned into a cash payment later, and it never backs a supplier
-- credit.
--
-- Shape: a write-off is a payable_payments row with payment_mode 'Write-off', recorded through
-- record_payable_payments like any payment, so the bill settles and moves to Paid History and every
-- reader that sums what is owed stays right with no change. The readers that present money PAID
-- (the balance letter, Vendor Report's Total paid) exclude it in the app.
--
-- 1. payable_payments_write_off_shape (CHECK): a write-off row is positive, at most 10, and is never
--    half of a supplier-credit pair.
-- 2. payable_payments_write_off_cap: a deferred constraint trigger, so a write-off split across a
--    bill's lines in one statement is judged once, at commit: the write-offs on one bill
--    (purchase_group_id, else the line) total at most NPR 10. HINT write_off_over_cap.
-- 3. payable_payments_write_off_mode: an UPDATE may not move a row into or out of 'Write-off' (the
--    page's bulk Edit Mode relabels payment modes). HINT write_off_mode_locked.
-- 4. recorded_by / recorded_by_name, stamped on insert from the signed-in login (every payment, not
--    only write-offs), so the Owner can see who recorded it; audit_logs is operator-only.
-- 5. payable_credit_link_problem: the "credit taken from a bill never exceeds what was paid on it"
--    test no longer counts write-offs as paid. Patched from the LIVE body (supabase-sql.md: rebuild a
--    function from pg_get_functiondef, never from the last migration file), asserting the one line
--    changed.
--
-- Each guard is SECURITY INVOKER keyed on current_user, so the service role (Danger Zone, restore)
-- and SECURITY DEFINER bodies pass, exactly like payable_payments_credit_pair_check.
--
-- Reverse:
--   DROP TRIGGER IF EXISTS payable_payments_write_off_cap ON public.payable_payments;
--   DROP TRIGGER IF EXISTS payable_payments_write_off_mode ON public.payable_payments;
--   DROP TRIGGER IF EXISTS payable_payments_stamp_recorder ON public.payable_payments;
--   DROP FUNCTION IF EXISTS public.payable_payments_write_off_cap_check();
--   DROP FUNCTION IF EXISTS public.payable_payments_write_off_mode_lock();
--   DROP FUNCTION IF EXISTS public.payable_payments_stamp_recorder();
--   ALTER TABLE public.payable_payments DROP CONSTRAINT IF EXISTS payable_payments_write_off_shape;
--   ALTER TABLE public.payable_payments DROP COLUMN IF EXISTS recorded_by, DROP COLUMN IF EXISTS recorded_by_name;
--   and put back "WHERE purchase_entry_id = v_src;" in payable_credit_link_problem (20260918120000:158).

-- ══ 1. Shape ═════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'payable_payments_write_off_shape' AND conrelid = 'public.payable_payments'::regclass) THEN
    ALTER TABLE public.payable_payments
      ADD CONSTRAINT payable_payments_write_off_shape
      CHECK (COALESCE(payment_mode, '') <> 'Write-off'
             OR (amount > 0 AND amount <= 10 AND credit_link_id IS NULL)) NOT VALID;
  END IF;
  BEGIN
    ALTER TABLE public.payable_payments VALIDATE CONSTRAINT payable_payments_write_off_shape;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'S885: payable_payments_write_off_shape left NOT VALID: an existing row already carries payment_mode ''Write-off'' outside the rule';
  END;
END $$;

-- ══ 2. At most NPR 10 cleared per bill ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payable_payments_write_off_cap_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group uuid;
  v_total numeric;
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NULL;
  END IF;
  IF COALESCE(NEW.payment_mode, '') <> 'Write-off' THEN
    RETURN NULL;
  END IF;

  SELECT pe.purchase_group_id INTO v_group FROM purchase_entries pe WHERE pe.id = NEW.purchase_entry_id;

  SELECT COALESCE(sum(pp.amount), 0) INTO v_total
    FROM payable_payments pp
    JOIN purchase_entries pe ON pe.id = pp.purchase_entry_id
   WHERE pp.payment_mode = 'Write-off'
     AND (pe.id = NEW.purchase_entry_id OR (v_group IS NOT NULL AND pe.purchase_group_id = v_group));

  IF v_total > 10 THEN
    RAISE EXCEPTION 'write_off_over_cap: NPR % would be cleared on one bill; at most NPR 10 may be', v_total
      USING ERRCODE = 'P0001', HINT = 'write_off_over_cap';
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION public.payable_payments_write_off_cap_check() FROM PUBLIC;

DROP TRIGGER IF EXISTS payable_payments_write_off_cap ON public.payable_payments;
CREATE CONSTRAINT TRIGGER payable_payments_write_off_cap
  AFTER INSERT OR UPDATE ON public.payable_payments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.payable_payments_write_off_cap_check();

-- ══ 3. A write-off stays a write-off ═════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.payable_payments_write_off_mode_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF (COALESCE(OLD.payment_mode, '') = 'Write-off') IS DISTINCT FROM (COALESCE(NEW.payment_mode, '') = 'Write-off') THEN
    RAISE EXCEPTION 'write_off_mode_locked: a cleared leftover and a payment cannot be relabelled as each other'
      USING ERRCODE = 'P0001', HINT = 'write_off_mode_locked';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.payable_payments_write_off_mode_lock() FROM PUBLIC;

DROP TRIGGER IF EXISTS payable_payments_write_off_mode ON public.payable_payments;
CREATE TRIGGER payable_payments_write_off_mode BEFORE UPDATE ON public.payable_payments
  FOR EACH ROW EXECUTE FUNCTION public.payable_payments_write_off_mode_lock();

-- ══ 4. Who recorded it ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.payable_payments ADD COLUMN IF NOT EXISTS recorded_by uuid;
ALTER TABLE public.payable_payments ADD COLUMN IF NOT EXISTS recorded_by_name text;
COMMENT ON COLUMN public.payable_payments.recorded_by IS
  'The login that recorded this payment, stamped by payable_payments_stamp_recorder (S885). NULL on rows recorded before S885.';

CREATE OR REPLACE FUNCTION public.payable_payments_stamp_recorder()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  -- An operator restore re-inserts old rows with their own created_at and recorder; keep them. An
  -- operator recording a payment now is stamped like anyone else. Attribution never comes from the
  -- browser for a client login (CLAUDE.md: attribution from auth.uid(), never a parameter).
  IF COALESCE(public.is_admin(), false)
     AND (NEW.recorded_by IS NOT NULL OR NEW.created_at < now() - interval '1 minute') THEN
    RETURN NEW;
  END IF;
  NEW.recorded_by := auth.uid();
  -- profiles RLS is self-or-admin, so the caller can read its own name here.
  NEW.recorded_by_name := (SELECT NULLIF(btrim(p.full_name), '') FROM profiles p WHERE p.id = auth.uid());
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.payable_payments_stamp_recorder() FROM PUBLIC;

DROP TRIGGER IF EXISTS payable_payments_stamp_recorder ON public.payable_payments;
CREATE TRIGGER payable_payments_stamp_recorder BEFORE INSERT ON public.payable_payments
  FOR EACH ROW EXECUTE FUNCTION public.payable_payments_stamp_recorder();

-- ══ 5. A supplier credit is backed by money paid, not by a write-off ═════════════════════════════
DO $$
DECLARE
  v_old text := 'FROM payable_payments WHERE purchase_entry_id = v_src;';
  v_new text := 'FROM payable_payments WHERE purchase_entry_id = v_src AND COALESCE(payment_mode, '''') <> ''Write-off'';';
  v_def text;
  v_patched text;
BEGIN
  v_def := pg_get_functiondef('public.payable_credit_link_problem(uuid)'::regprocedure);
  IF position(v_new IN v_def) > 0 THEN
    RAISE NOTICE 'S885: payable_credit_link_problem already excludes write-offs';
    RETURN;
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'S885: payable_credit_link_problem live body does not hold the expected line exactly once; nothing changed';
  END IF;
  v_patched := replace(v_def, v_old, v_new);
  EXECUTE v_patched;
  IF position(v_new IN pg_get_functiondef('public.payable_credit_link_problem(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'S885: payable_credit_link_problem patch did not take';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ══ 6. Self-check ════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payable_payments_write_off_cap'
                   AND tgrelid = 'public.payable_payments'::regclass AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'S885: payable_payments_write_off_cap must be a deferred constraint trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payable_payments_write_off_mode'
                   AND tgrelid = 'public.payable_payments'::regclass) THEN
    RAISE EXCEPTION 'S885: payable_payments_write_off_mode missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payable_payments_stamp_recorder'
                   AND tgrelid = 'public.payable_payments'::regclass) THEN
    RAISE EXCEPTION 'S885: payable_payments_stamp_recorder missing';
  END IF;
END $$;
