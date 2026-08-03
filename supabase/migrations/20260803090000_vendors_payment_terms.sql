-- Free-text payment terms per vendor (e.g. "Net 30", "COD", "50% Advance") — editable from the
-- Vendors page and as a quick-edit on Outstanding Payables' vendor group header row.
ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS payment_terms text;
