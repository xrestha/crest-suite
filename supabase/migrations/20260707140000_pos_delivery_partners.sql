-- Delivery-partner tagging (Foodmandu/Pathao), lightweight v1: no live order-injection API
-- integration (that needs a real partner relationship with Foodmandu/Pathao — see product
-- roadmap), just the ability to mark a bill as having come through one of them, alongside the
-- existing tender types, plus the commission math to reconcile gross (what the customer paid the
-- platform) vs net (what the restaurant actually receives).
--
-- Modeled as two new payment_method values rather than a separate "order source" — an aggregator
-- order is, from the restaurant's own settlement point of view, just another way a bill gets
-- paid (the platform stands in for the customer), so it reuses every existing payment_method
-- code path (Payment Summary breakdown, shift totals, discount rules) rather than needing a
-- parallel concept.
ALTER TABLE public.pos_orders DROP CONSTRAINT pos_orders_payment_method_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_payment_method_check
  CHECK (payment_method = ANY (ARRAY['Cash'::text, 'Card'::text, 'eSewa'::text, 'Khalti'::text, 'FonePay'::text, 'Credit'::text, 'Split'::text, 'Foodmandu'::text, 'Pathao'::text]));

-- Deliberately NOT added to pos_order_payments_payment_method_check (the per-leg method on a
-- Split payment) — an aggregator order isn't split with cash/card the way a table's bill can be;
-- Foodmandu/Pathao are top-level payment_method selections only.

-- Commission this specific bill was charged, computed at Charge time from the client's
-- configured rate (settings.pos_foodmandu_commission_pct / pos_pathao_commission_pct) —
-- stored per-order (not just the rate) since a client's negotiated rate can change over time
-- and past bills should keep reporting what was actually withheld at the time.
ALTER TABLE public.pos_orders ADD COLUMN commission_amount numeric;

-- Per-client negotiated commission rate with each platform — configured once (Table Management →
-- Delivery Partners), applied automatically to every Foodmandu/Pathao bill going forward.
ALTER TABLE public.settings ADD COLUMN pos_foodmandu_commission_pct numeric;
ALTER TABLE public.settings ADD COLUMN pos_pathao_commission_pct numeric;

NOTIFY pgrst, 'reload schema';
