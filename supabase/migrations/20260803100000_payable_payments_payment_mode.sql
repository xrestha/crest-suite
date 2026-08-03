-- How a Credit bill's settlement was actually paid (Cash/FonePay/Bank Transfer/Cheque) — distinct
-- from purchase_entries.payment_method, which describes how the ORIGINAL purchase was made
-- (Cash/Credit/FonePay). A Credit bill's later settlement can be paid via any of these, and the
-- Vendor Balance Confirmation letter's "Payment Mode" column reads this for Payment rows.
ALTER TABLE public.payable_payments ADD COLUMN IF NOT EXISTS payment_mode text;
