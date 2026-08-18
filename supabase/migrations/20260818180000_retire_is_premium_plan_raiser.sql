-- Retire clients.is_premium as a plan-raiser (S574, phase 7 of the critique campaign).
--
-- AuthContext resolved `plan` as max(clients.plan, is_premium ? 'pro' : null) — the last
-- surviving raiser after S548 removed hr_plan/pos_plan/ims_plan from that max. The flag was
-- rendered on NO admin screen, priced into no MRR figure, and editable from no control, so a
-- client at plan='starter' with is_premium=true received every IMS Pro feature while every
-- admin surface said, and billed, Starter.
--
-- This sweep folds the entitlement into clients.plan so removing the raiser changes what no
-- client receives — the standard grandfather rule for any entitlement move. After it runs,
-- is_premium is vestigial (never read, never written, same status as hr_plan/pos_plan); it is
-- deliberately NOT zeroed, so it remains a historical record of which clients were legacy
-- premium. The affected clients become visible as Pro on the client list and in MRR — which is
-- the point: the leak stops being invisible and becomes a plan the operator can see and reprice.
--
-- ORDER MATTERS: apply this in the SQL Editor BEFORE deploying the AuthContext change that
-- stops reading is_premium, or a starter+is_premium client loses Pro access for the gap.

UPDATE public.clients
SET plan = 'pro'
WHERE is_premium IS TRUE
  AND (plan IS DISTINCT FROM 'pro');

-- Verification (run by hand; both should return 0 rows):
--   SELECT id, name, plan, is_premium FROM clients WHERE is_premium IS TRUE AND plan <> 'pro';
--   -- and to see the blast radius that was folded:
--   SELECT count(*) AS was_premium FROM clients WHERE is_premium IS TRUE;
