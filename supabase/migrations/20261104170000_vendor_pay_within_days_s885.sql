-- S885: "Overdue" follows each supplier's own payment days.
--
-- Owner decisions (2026-11-04, asked in plain words): each supplier gets a whole-number "pay within
-- N days"; a supplier with none set keeps the 60 days every supplier had before; 0 is cash on delivery
-- (an unpaid bill is overdue from the next day). The free-text vendors.payment_terms stays, shown as a
-- Terms note. Existing notes are read once into the number: plain day counts ("30", "30 days",
-- "Net 30", "within 15 days", "30 days credit", "credit 45 days") and cash on delivery ("COD", "Cash",
-- "Cash on delivery", "On delivery") -> 0. Anything else ("50% advance", "Monthly", "30-60 days") is
-- left blank, so it stays on 60 days, and is listed for the owner after the apply.
--
-- The browser twin of the parse is parsePayTerms in src/modules/ims/vendors/payTerms.js (with tests);
-- change one, change the other. Writes stay behind ims_vendors_guard (supervisor+); the migration runs
-- as the owner, which that guard lets through. vendors has no audit trigger.
--
-- Reverse: ALTER TABLE public.vendors DROP COLUMN IF EXISTS pay_within_days;

ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS pay_within_days integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'vendors_pay_within_days_range' AND conrelid = 'public.vendors'::regclass) THEN
    ALTER TABLE public.vendors
      ADD CONSTRAINT vendors_pay_within_days_range
      CHECK (pay_within_days IS NULL OR (pay_within_days >= 0 AND pay_within_days <= 365));
  END IF;
END $$;

COMMENT ON COLUMN public.vendors.pay_within_days IS
  'Days a bill from this supplier may stay unpaid before it counts as overdue. NULL = the default 60; 0 = cash on delivery (S885).';

-- One-time read of the old notes. Only rows with no number yet, so a re-run never overwrites one set by hand.
WITH t AS (
  SELECT id, lower(btrim(regexp_replace(payment_terms, '\s+', ' ', 'g'))) AS s
    FROM public.vendors
   WHERE pay_within_days IS NULL
     AND payment_terms IS NOT NULL
     AND btrim(payment_terms) <> ''
), p AS (
  SELECT id,
         CASE
           WHEN s ~ '^(cod|c\.o\.d\.?|cash|cash on delivery|on delivery|payment on delivery)$' THEN 0
           WHEN s ~ '^(net\s*)?[0-9]{1,3}(\s*(days?|d))?(\s+credit)?$' THEN substring(s FROM '[0-9]{1,3}')::integer
           WHEN s ~ '^(within|in)\s+[0-9]{1,3}\s+days?$'               THEN substring(s FROM '[0-9]{1,3}')::integer
           WHEN s ~ '^credit\s+(of\s+)?[0-9]{1,3}\s*days?$'            THEN substring(s FROM '[0-9]{1,3}')::integer
         END AS d
    FROM t
)
UPDATE public.vendors v
   SET pay_within_days = p.d
  FROM p
 WHERE v.id = p.id
   AND p.d IS NOT NULL
   AND p.d BETWEEN 0 AND 365;

NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'pay_within_days'
                    AND data_type = 'integer') THEN
    RAISE EXCEPTION 'S885: vendors.pay_within_days missing';
  END IF;
END $$;
