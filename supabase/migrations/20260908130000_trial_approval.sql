-- Trials are approved by a person before they open (S697).
--
-- The public signup form used to hand out a working account to anyone with an email address —
-- including a competitor wanting a screenshot tour. Aashish chose "I approve first": the account
-- is still created by register_trial, but it opens on the day an admin presses Approve in
-- Admin -> Clients, and the 7-day clock starts THEN, not at signup, so a day spent waiting for
-- the call is not a day taken off the trial.
--
-- One column carries the state. `trial_approved_at IS NULL` on a row with `is_trial = true` means
-- "signed up, not yet approved"; getAccessState() locks that client with reason 'pending' and
-- SubscriptionLock shows the "we will call you" screen. The column is NOT a boolean on purpose:
-- the timestamp is the audit trail of who-approved-when (paired with audit_logs on clients), and
-- it is the value the approval action resets the trial dates from.
--
-- Backfill: every trial that exists today was created before approval existed and is therefore
-- approved. Without this line the deploy would lock every live trial the moment it landed.
-- getAccessState() reads this column on the auth hot path, so this migration MUST be applied
-- before the frontend that reads it is deployed (a missing column fails the whole profile read).

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS trial_approved_at timestamptz;

COMMENT ON COLUMN public.clients.trial_approved_at IS
  'When an admin approved this self-service trial. NULL with is_trial = true means the signup is awaiting approval and the app is locked (getAccessState reason ''pending''). Set by AdminClients approveTrial, which also restarts the trial clock. Admin-created clients are stamped at creation.';

UPDATE public.clients
   SET trial_approved_at = COALESCE(trial_start_date, created_at, now())
 WHERE is_trial IS TRUE
   AND trial_approved_at IS NULL;

-- Nothing below the UPDATE may still be pending: a pre-existing trial that stayed NULL here would
-- be locked out by the very deploy that is meant to welcome new ones.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.clients WHERE is_trial IS TRUE AND trial_approved_at IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'trial_approval backfill left % trial(s) unapproved', n;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
