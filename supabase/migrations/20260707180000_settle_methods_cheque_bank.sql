-- Credit / delivery-partner receivables are usually remitted by cheque or bank transfer, not paid
-- at the counter — but credit_settled_method's CHECK only allowed the five counter-payment methods
-- (Cash/Card/eSewa/Khalti/FonePay). Add Cheque and Bank Transfer so a settlement can record how
-- the money actually came in. (Left off PAYMENT_METHODS itself, which is counter payment at Charge
-- — these two are settlement-only, for collecting an existing receivable.)

ALTER TABLE public.pos_orders DROP CONSTRAINT pos_orders_credit_settled_method_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_credit_settled_method_check
  CHECK (credit_settled_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Cheque'::text, 'Bank Transfer'::text]));

NOTIFY pgrst, 'reload schema';
