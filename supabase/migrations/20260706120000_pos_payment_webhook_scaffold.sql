-- Scaffold for QR payment auto-confirmation (product-roadmap memory: "QR payment
-- auto-confirmation", Low priority). This lands the receiving side only: a per-client
-- webhook secret and a staging table for incoming provider payment notifications.
-- Real signature verification + payload field mapping still need to be wired up against
-- FonePay/eSewa's actual merchant API docs once that account is onboarded — see
-- supabase/functions/pos-payment-webhook/index.ts, which uses a placeholder HMAC scheme
-- in the meantime.

ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS pos_webhook_secret text;

CREATE TABLE public.pos_payment_confirmations (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    client_id uuid NOT NULL REFERENCES public.clients(id),
    provider text NOT NULL,
    amount numeric NOT NULL,
    reference text,
    txn_ref text NOT NULL,
    matched_order_id uuid REFERENCES public.pos_orders(id),
    consumed_at timestamp with time zone,
    raw_payload jsonb,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pos_payment_confirmations_txn_ref_unique UNIQUE (client_id, provider, txn_ref)
);

CREATE INDEX pos_payment_confirmations_pending_idx ON public.pos_payment_confirmations (client_id, matched_order_id)
  WHERE consumed_at IS NULL;

ALTER TABLE public.pos_payment_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY pos_payment_confirmations_select ON public.pos_payment_confirmations
  FOR SELECT USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
  );

-- The POS floor screen marks a confirmation consumed once it auto-closes the matching
-- order (see PosOrders.jsx) — same-client staff need UPDATE, not just SELECT.
CREATE POLICY pos_payment_confirmations_update ON public.pos_payment_confirmations
  FOR UPDATE USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR client_id = (SELECT client_id FROM profiles WHERE id = auth.uid())
  );

GRANT SELECT, UPDATE ON public.pos_payment_confirmations TO authenticated;

NOTIFY pgrst, 'reload schema';
