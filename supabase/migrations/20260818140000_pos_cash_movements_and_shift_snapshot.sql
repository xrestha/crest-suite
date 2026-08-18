-- S573 — two shift-reconciliation defects found in the phase 6 (POS) critique.
--
-- (1) Expected Cash was structurally wrong. It is computed as `opening_cash + cash sales`, but
--     cash genuinely moves in and out of a till mid-shift in this market — paying a supplier,
--     a staff advance, a float drop to the safe — and, most commonly, a customer settling an
--     older Credit bill in cash. That settlement writes `credit_settled_method` on pos_orders
--     while the order's own `payment_method` stays 'Credit' forever, so the shift's cash bucket
--     never sees it: NPR 20,000 lands in the drawer and the shift reports a 20,000 "over" that
--     nobody can explain. pos_cash_movements is the missing ledger.
--
-- (2) The Z-report a supervisor signs was computed from a snapshot taken when the page LOADED,
--     not at close, and none of its money figures were persisted. Open at 8pm, close at 11pm,
--     and three hours of takings are missing from Total Collection, Cash Sales and the Variance.
--     Worse, Shift History recomputes those figures live, so the REPRINTED Z-report shows
--     different numbers from the one that was signed, with nothing saying which is authoritative.
--     `closing_report` freezes the figures at close — the same capture-once principle the Monthly
--     Owner Report already uses. History renders the stored report when present and falls back to
--     a live recompute only for shifts closed before this migration.

-- ── 1. Cash movement ledger ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pos_cash_movements (
  id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  -- The shift the cash physically moved during. Nullable + SET NULL so deleting a shift never
  -- destroys the record that money left the drawer; an orphaned movement is still evidence.
  shift_id    uuid REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
  direction   text NOT NULL CHECK (direction IN ('in', 'out')),
  -- 'credit_settlement' is written automatically when a Credit bill is settled in cash; the
  -- other two are manual counter actions. Kept distinct from `direction` because a settlement
  -- must be reported separately from an ordinary pay-in on the Z-report.
  kind        text NOT NULL CHECK (kind IN ('pay_in', 'pay_out', 'credit_settlement')),
  amount      numeric NOT NULL CHECK (amount > 0),
  reason      text,
  -- Set for kind='credit_settlement' so the movement can be traced back to the bill it settled.
  order_id    uuid REFERENCES public.pos_orders(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pos_cash_movements_shift  ON public.pos_cash_movements (shift_id);
CREATE INDEX IF NOT EXISTS idx_pos_cash_movements_client ON public.pos_cash_movements (client_id);

ALTER TABLE public.pos_cash_movements ENABLE ROW LEVEL SECURITY;

-- Same-client-or-admin, with auth.uid() wrapped in a SELECT so the planner runs it once per
-- statement rather than once per row (the S542 initplan rule).
CREATE POLICY pos_cash_movements_client ON public.pos_cash_movements
  TO authenticated
  USING (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  )
  WITH CHECK (
    client_id = (SELECT profiles.client_id FROM public.profiles WHERE profiles.id = (SELECT auth.uid()))
    OR (SELECT profiles.role FROM public.profiles WHERE profiles.id = (SELECT auth.uid())) = 'admin'
  );

-- Staff-account isolation, mirroring pos_shifts exactly: HR self-service, IMS staff and HR staff
-- accounts are all fenced off. POS PIN staff are deliberately NOT blocked — recording a pay-out
-- is a counter action, which is the whole point of this table.
CREATE POLICY no_self_service_accounts ON public.pos_cash_movements AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_self_service()) WITH CHECK (NOT public.is_hr_self_service());
CREATE POLICY no_ims_staff ON public.pos_cash_movements AS RESTRICTIVE FOR ALL
  USING (NOT public.is_ims_staff()) WITH CHECK (NOT public.is_ims_staff());
CREATE POLICY no_hr_role_staff ON public.pos_cash_movements AS RESTRICTIVE FOR ALL
  USING (NOT public.is_hr_role_staff()) WITH CHECK (NOT public.is_hr_role_staff());

-- Raw-SQL tables get NO role grants in this project by default — without this the table is
-- invisible to the app even with RLS correct.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_cash_movements TO authenticated;
GRANT ALL ON public.pos_cash_movements TO service_role;

-- ── 2. Frozen shift close snapshot ───────────────────────────────────────────────────────────
ALTER TABLE public.pos_shifts
  ADD COLUMN IF NOT EXISTS closing_report jsonb;

COMMENT ON COLUMN public.pos_shifts.closing_report IS
  'Money figures frozen at the moment the shift was closed (sales total, per-method breakdown, cash sales, cash in/out, expected cash, variance). Shift History renders this rather than recomputing, so a reprinted Z-report always matches the signed one. NULL for shifts closed before S573.';

NOTIFY pgrst, 'reload schema';
