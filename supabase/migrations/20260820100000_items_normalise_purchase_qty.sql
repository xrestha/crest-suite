-- Items are stored in their SMALLEST unit: `purchase_qty` is always 1, so `items.rate` is the
-- price of ONE base unit and is identical to the generated `per_uom_rate` column.
--
-- Why this exists
-- ---------------
-- `per_uom_rate` is `rate / NULLIF(purchase_qty, 0)`, so the pair (500, 388.50) and the pair
-- (1, 0.777) describe the same 500 GM bottle of sauce and value stock identically. Every IMS
-- valuation reads `per_uom_rate`, so both forms costed recipes correctly and nothing complained.
--
-- What broke is everything that reads `items.rate` itself. The Add Purchase Bill form prefilled
-- that column into a rate box whose Qty is counted in BASE units — so a bottle stored as
-- (500, 388.50) prefilled NPR 388.50 against a qty of 500 GM and billed NPR 194,250 for a
-- NPR 388.50 bottle. 253 of 254 items in the reference client were already (1, per-unit), which
-- is why this sat unnoticed: `items.rate` meant "price per GM" for all of them and "price per
-- bottle" for the one entered with a pack size.
--
-- The Add/Edit Item form still ACCEPTS a pack ("1000 GM for NPR 500") — that is the natural way to
-- read an invoice line — but now divides it out before writing, and no longer mirrors
-- `conversion_factor` into `purchase_qty`. A buy-in-CTN / count-in-BTL relationship belongs to the
-- conversion columns, which is what the Purchase Bill reads to decide its qty unit.
--
-- This backfill is VALUE-PRESERVING: `per_uom_rate` is unchanged for every row, so no stock
-- valuation, COGS, variance, reorder figure or frozen Owner Report moves. `rate` and
-- `purchase_qty` are unconstrained `numeric`, so the division is exact.
-- Same arithmetic as ClientDrawer.js's Clear Conversions, which already had to solve this.

-- Preview before running the UPDATE:
--   SELECT id, name, purchase_qty, rate, per_uom_rate, purchase_unit, conversion_factor
--   FROM public.items WHERE purchase_qty IS DISTINCT FROM 1;

UPDATE public.items
   SET rate = rate / purchase_qty,
       purchase_qty = 1
 WHERE purchase_qty IS DISTINCT FROM 1
   AND purchase_qty > 0;

-- Nothing writes a pack size any more: the item form normalises, the sub-recipe mirror in
-- Recipes.js has always written 1, Supplier Price Tracker writes a per-UOM rate directly, and
-- restoreClientData.js normalises a pre-rule backup on the way in. The constraint is what stops a
-- fourth path appearing later and silently reintroducing two meanings for one column.
ALTER TABLE public.items
  DROP CONSTRAINT IF EXISTS items_purchase_qty_normalised;

ALTER TABLE public.items
  ADD CONSTRAINT items_purchase_qty_normalised CHECK (purchase_qty = 1);

-- ---------------------------------------------------------------------------------------------
-- Companion audit (READ ONLY — not part of this migration, run it by hand)
--
-- Bills entered before the prefill fix may carry a PACK rate against a base-unit qty, which
-- inflates that period's purchases, COGS, stock valuation and the VAT/Non-VAT reports. This finds
-- the candidates; it does not correct them. The right figure per bill is a human reading the
-- invoice, so fix them by editing the bill in Purchases — a bulk repair that guesses is worse.
--
--   SELECT pe.id, i.name, mp.bs_year, mp.bs_month, pe.bs_day, pe.qty, pe.rate, i.per_uom_rate,
--          ROUND(pe.rate / NULLIF(i.per_uom_rate, 0), 1) AS times_master,
--          ROUND(pe.qty * pe.rate, 2) AS line_total
--     FROM public.purchase_entries pe
--     JOIN public.items i           ON i.id = pe.item_id
--     JOIN public.monthly_periods mp ON mp.id = pe.period_id
--    WHERE i.per_uom_rate > 0
--      AND pe.rate > i.per_uom_rate * 5
--    ORDER BY times_master DESC;
--
-- A high ratio is a candidate, not a verdict: a genuine price rise, or an item whose master rate
-- was never updated, lands here too. Compare against the vendor invoice before changing anything.
