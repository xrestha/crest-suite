-- Records when a client's data was last exported to a verified backup file.
--
-- Two consumers, one now and one later:
--
--   1. useAutoPurgeBackup (now) — the T-72h pre-purge trigger reads this to decide whether a
--      backup is still needed. Without it the hook would re-export the same client on every
--      admin page load, since a browser has nowhere else to remember that it already ran.
--
--   2. The purge (later, not built) — whenever trial_purge_at is made to actually delete
--      anything, it must refuse to run for any client whose last_backup_at is null. That turns
--      an irreversible mass delete into a recoverable one, and removes the dependence on the
--      backup having fired at the right moment: if it never happened, the purge simply waits.
--
-- Deliberately nullable with no default. NULL means "never backed up", which is the correct
-- and safe reading for every client that exists today.
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS last_backup_at timestamptz;

COMMENT ON COLUMN public.clients.last_backup_at IS
  'When this client''s data was last exported to a backup file (Admin -> Clients -> Export/Import). '
  'NULL = never. Read by the T-72h pre-purge backup trigger, and intended as the gate any future '
  'purge must check before deleting anything.';
