-- Redesign of S290's delivery-partner tagging, based on real feedback: Foodmandu/Pathao don't
-- pay the restaurant at the counter — they collect from the customer and remit to the
-- restaurant later (weekly/monthly), minus commission. That's a receivable, not an instant
-- payment method — structurally the same as the existing Credit flow (bill closes now, no cash
-- collected, tracked as outstanding, settled later), not like Cash/Card/eSewa. So this migration
-- reverses the "Foodmandu/Pathao as payment_method" approach from 20260707140000 and replaces it
-- with "Foodmandu/Pathao as the buyer on a Credit bill" instead.

-- New: an explicit flag for which delivery partner (if any) this Credit bill's buyer is — not
-- inferred from buyer_name (a free-text field a cashier could edit/typo), so reporting and the
-- settlement flow have something authoritative to key off. buyer_name is still separately set to
-- "Foodmandu"/"Pathao" by the same UI action, for display purposes (e.g. Outstanding Credit's
-- Customer column) — this column is the source of truth, that one is just presentation.
ALTER TABLE public.pos_orders ADD COLUMN delivery_partner text;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_delivery_partner_check
  CHECK (delivery_partner IS NULL OR delivery_partner = ANY (ARRAY['Foodmandu'::text, 'Pathao'::text]));

-- Data migration: any live-tested S290-era rows already have payment_method = 'Foodmandu'/'Pathao'.
-- Convert them to the new shape (Credit + delivery_partner) BEFORE the stricter CHECK constraint
-- below is re-added, or that ADD CONSTRAINT would fail against existing data.
UPDATE public.pos_orders
SET delivery_partner = payment_method, payment_method = 'Credit'
WHERE payment_method IN ('Foodmandu', 'Pathao');

-- Revert: Foodmandu/Pathao are no longer valid payment_method values — back to the original 7.
ALTER TABLE public.pos_orders DROP CONSTRAINT pos_orders_payment_method_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_payment_method_check
  CHECK (payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Credit'::text, 'Split'::text]));

-- pos_orders.commission_amount (added in 20260707140000) and settings.pos_foodmandu_commission_pct/
-- pos_pathao_commission_pct (same migration) are both kept, but now mean something different:
-- commission is no longer computed and locked in at Charge time (that was "staff expectation
-- coming into the billing terms" — not wanted). The settings % is now only a starting suggestion
-- shown at settlement time (Customers → Outstanding Credit → Settle), which the person settling
-- confirms or adjusts to match the platform's actual remittance statement — commission_amount is
-- written then, not at Charge.

NOTIFY pgrst, 'reload schema';
