-- Fold the legacy trial_ends_at into the canonical trial columns (S574, phase 7).
--
-- Two trial columns were live at once and the three trial code paths each used a different one:
-- register_trial (the public form) writes is_trial/trial_start_date/trial_expires_at/
-- trial_purge_at and never trial_ends_at; Admin "+ New Client" wrote trial_ends_at and none of
-- the others; the Trial Accounts panel filters on is_trial, extendTrial writes trial_expires_at,
-- and getSubStatus's fallback read trial_ends_at. Net: an admin-created client never appeared in
-- the Trial panel, +7 Days wrote a column nothing displayed for it, and after Convert to Paid a
-- self-service trial fell out of every status badge entirely.
--
-- The code now reads/writes ONLY the register_trial set. This fold moves still-relevant
-- trial_ends_at values across so no admin-created trial loses its badge.
--
-- Deliberately narrow: only clients that look like admin-created trials — no canonical trial
-- expiry yet, and NO real subscription dates. A paying client with a leftover trial_ends_at from
-- its onboarding must NOT get is_trial=true (that would put paying clients in the Trial panel,
-- and an old date would trip getAccessState's trial lock).
UPDATE public.clients
SET is_trial         = true,
    trial_start_date = COALESCE(trial_start_date, created_at, now()),
    trial_expires_at = trial_ends_at,
    trial_purge_at   = COALESCE(trial_purge_at, trial_ends_at + interval '15 days')
WHERE trial_ends_at IS NOT NULL
  AND trial_expires_at IS NULL
  AND is_trial IS NOT TRUE
  AND ims_ends_at IS NULL
  AND hr_ends_at IS NULL
  AND pos_ends_at IS NULL
  AND suite_ends_at IS NULL
  AND subscription_ends_at IS NULL
  -- An already-expired legacy trial with no dates was either swept inactive long ago or is a
  -- real client the operator simply never dated; setting is_trial on it would lock them out
  -- the moment this runs. Only fold trials that still have time left.
  AND trial_ends_at > now();

-- trial_ends_at itself is left in place (vestigial, same treatment as hr_plan/pos_plan and
-- is_premium): no code reads or writes it after S574.

-- Verification (run by hand):
--   -- folded rows now carry the canonical set:
--   SELECT count(*) FROM clients WHERE is_trial AND trial_expires_at IS NOT NULL;
--   -- nothing still depends on the legacy column alone:
--   SELECT id, name, trial_ends_at FROM clients
--   WHERE trial_ends_at IS NOT NULL AND trial_expires_at IS NULL AND trial_ends_at > now();
