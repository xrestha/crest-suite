// Opportunistic pre-purge backup: when a trial's purge deadline comes within 72 hours, capture
// the client's data to disk before anything can act on that deadline.
//
// "Opportunistic" is doing real work in that sentence. A browser cannot run when it is closed, so
// this fires on an admin's page load inside the window and nowhere else. That is acceptable here
// precisely because nothing currently deletes on trial_purge_at — this is insurance being put in
// place ahead of the risk, not a race against it. When a purge is eventually built it must gate
// on clients.last_backup_at rather than on this having fired at the right moment.
import { useEffect, useMemo, useRef, useState } from 'react'
import { runBackup } from './runBackup'
import { ensureBackupDirectory } from './backupDirectory'

const WINDOW_HOURS = 72

export function needsPrePurgeBackup(client, now = Date.now()) {
  if (!client?.is_trial || !client?.trial_purge_at) return false
  const purgeAt = new Date(client.trial_purge_at).getTime()
  if (purgeAt - now > WINDOW_HOURS * 3600_000) return false   // deadline still far off
  if (!client.last_backup_at) return true
  // A backup taken after the trial expired captures the final state, because an expired trial is
  // locked out of the app (S544) and its data has stopped changing. An older backup does not.
  // (Two doors do remain open after the lock — HR Self-Service and the public guest-menu ordering
  // route — so this is very nearly, not strictly, a freeze.)
  if (!client.trial_expires_at) return false
  return new Date(client.last_backup_at) < new Date(client.trial_expires_at)
}

/**
 * @param clients  the already-loaded client list from AdminClients
 * @returns { pending, blocked, busy, message } for the banner
 */
export function useAutoPurgeBackup(clients, onDone = () => {}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [blocked, setBlocked] = useState(false)
  // The client this page load has already tried, and whether a backup is writing now. Refs, not
  // state, because starting a backup re-renders the page and the run must still finish and report.
  // Until S890 `busy` was a dependency of the effect below and the effect cancelled itself on
  // cleanup, so setBusy(true) cancelled the very run that set it: the files were written and
  // stamped, but the banner stayed on "Backing up…" for good and the list was never reloaded.
  const runningFor = useRef(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Memoised on the list, so the effect re-runs whenever AdminClients reloads it. That reload is
  // the only signal after "Choose backup folder…" grants permission; keyed on the pending COUNT,
  // the effect never looked again and the banner kept asking for a folder (S890).
  const pending = useMemo(() => (clients || []).filter(c => needsPrePurgeBackup(c)), [clients])

  useEffect(() => {
    if (pending.length === 0 || inFlight.current) return
    const target = pending[0]
    if (runningFor.current === target.id) return

    ;(async () => {
      // request:false — no user gesture is available here, so a prompt would be rejected anyway.
      // Without granted permission this becomes a visible banner rather than a silent no-op.
      const { state } = await ensureBackupDirectory({ request: false })
      // Another run of this effect may have claimed the backup while this one waited.
      if (!alive.current || inFlight.current || runningFor.current === target.id) return
      if (state !== 'granted') { setBlocked(true); return }

      setBlocked(false)
      runningFor.current = target.id
      inFlight.current = true
      setBusy(true)
      setMessage(`Backing up ${target.name} before its purge deadline…`)
      try {
        // One client per page load. Several trials can enter the window together, and firing
        // five 55-table exports at once would mean hundreds of parallel queries and five
        // workbooks held in memory simultaneously. The next load takes the next one.
        await runBackup(target.id, target.name, 'prepurge', {
          allowPrompt: false,
          allowDownloadFallback: false, // never spray files into Downloads unattended
        })
        if (!alive.current) return
        setMessage(`✓ ${target.name} backed up before its purge deadline.`)
        onDone()
      } catch (err) {
        if (alive.current) setMessage(`Could not back up ${target.name}: ${err.message}`)
      } finally {
        inFlight.current = false
        if (alive.current) setBusy(false)
      }
    })()
  }, [pending]) // eslint-disable-line react-hooks/exhaustive-deps -- onDone is a fresh arrow each render; it only reloads the list

  return { pending, blocked, busy, message }
}

// Exported for the banner's "choose folder" action to re-check afterwards.
export async function refreshBackupPermission() {
  const { state } = await ensureBackupDirectory({ request: true })
  return state
}

// reloadClientBackupStamps was deleted here (S574): its comment claimed AdminClients used it,
// but the refresh actually goes through the hook's onDone callback (loadClients re-reads the
// whole list) and a grep found zero importers — the same dead-code-with-a-live-comment shape
// as shared/constants/shiftTypes.js.
