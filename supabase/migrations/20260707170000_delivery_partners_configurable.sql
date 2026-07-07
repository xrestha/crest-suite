-- Delivery partners (Foodmandu/Pathao today) become a fully client-editable list instead of two
-- hardcoded platforms, so a client can add/rename/remove aggregators as those partnerships come
-- and go, without a schema change. Replaces the two fixed pos_foodmandu_commission_pct/
-- pos_pathao_commission_pct columns with one jsonb array: [{ name, commission_pct, phone }].
-- "phone" is the sentinel buyer_phone the Credit quick-select fills in (PosOrders.jsx) so every
-- order from that platform groups under one pos_customers row.

ALTER TABLE public.settings ADD COLUMN pos_delivery_partners jsonb;

-- Backfill any already-configured Foodmandu/Pathao commission rates into the new shape, seeding
-- the same sentinel phone numbers the app has used since 20260707160000.
UPDATE public.settings
SET pos_delivery_partners = (
  SELECT jsonb_agg(p) FROM (
    SELECT jsonb_build_object('name', 'Foodmandu', 'commission_pct', pos_foodmandu_commission_pct, 'phone', '9800000001') AS p
    WHERE pos_foodmandu_commission_pct IS NOT NULL
    UNION ALL
    SELECT jsonb_build_object('name', 'Pathao', 'commission_pct', pos_pathao_commission_pct, 'phone', '9800000002')
    WHERE pos_pathao_commission_pct IS NOT NULL
  ) sub
)
WHERE pos_foodmandu_commission_pct IS NOT NULL OR pos_pathao_commission_pct IS NOT NULL;

ALTER TABLE public.settings DROP COLUMN pos_foodmandu_commission_pct;
ALTER TABLE public.settings DROP COLUMN pos_pathao_commission_pct;

-- pos_orders.delivery_partner (20260707160000) was constrained to exactly Foodmandu/Pathao — now
-- that the platform list is client-editable, any non-empty name must be storable without a
-- migration every time a client adds a new one.
ALTER TABLE public.pos_orders DROP CONSTRAINT pos_orders_delivery_partner_check;
ALTER TABLE public.pos_orders ADD CONSTRAINT pos_orders_delivery_partner_check
  CHECK (delivery_partner IS NULL OR length(trim(delivery_partner)) > 0);

NOTIFY pgrst, 'reload schema';
