-- S885, second read of the old supplier notes (owner decision 2026-11-05, asked in plain words):
-- "Weekly credit" is 7 days and "Monthly credit" is 30. A bare "credit" says nothing about how long,
-- so it stays blank (the default 60 days). The notes themselves are kept.
--
-- 20261104170000 read plain day counts and cash on delivery; this adds the two words it left, and
-- parsePayTerms in src/modules/ims/vendors/payTerms.js reads them the same way from now on (imports and
-- the supplier form). Only rows still blank are touched, so a number set by hand is never overwritten.
--
-- Live before this (2026-11-05): 2 x "Weekly credit" and 4 x "Monthly credit" (BLOOM CAFE and
-- BLOOM CAFE - PKR); CASA ACAI CAFE's two "credit" / "CREDIT" stay on 60.
--
-- Reverse: UPDATE public.vendors SET pay_within_days = NULL
--           WHERE lower(btrim(payment_terms)) IN ('weekly', 'weekly credit', 'monthly', 'monthly credit');

UPDATE public.vendors
   SET pay_within_days = CASE
         WHEN lower(btrim(regexp_replace(payment_terms, '\s+', ' ', 'g'))) IN ('weekly', 'weekly credit')   THEN 7
         WHEN lower(btrim(regexp_replace(payment_terms, '\s+', ' ', 'g'))) IN ('monthly', 'monthly credit') THEN 30
       END
 WHERE pay_within_days IS NULL
   AND lower(btrim(regexp_replace(payment_terms, '\s+', ' ', 'g'))) IN ('weekly', 'weekly credit', 'monthly', 'monthly credit');
