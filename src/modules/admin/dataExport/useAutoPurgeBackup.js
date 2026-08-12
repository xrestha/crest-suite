// Opportunistic pre-purge backup: when a trial's purge deadline comes within 72 hours, capture
// the client's data to disk before anything can act on that deadline.
//
// "Opportunistic" is doing real work in that sentence. A browser cannot run when it is closed, so
// this fires on an admin's page load inside the window and nowhere else. That is acceptable here
// precisely because nothing currently deletes on trial_purge_at — this is insurance being put in
// place ahead of the risk, not a race against it. When a purge is eventually built it must gate
// on clients.last_backup_at rather than on this having fired at the right moment.
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
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
  // Guards against a re-render or a refreshed client list starting a second run for the same
  // client while the first is still writing.
  const runningFor = useRef(null)

  const pending = (clients || []).filter(c => needsPrePurgeBackup(c))

  useEffect(() => {
    if (pending.length === 0 || busy) return
    const target = pending[0]
    if (runningFor.current === target.id) return

    let cancelled = false
    ;(async () => {
      // request:false — no user gesture is available here, so a prompt would be rejected anyway.
      // Without granted permission this becomes a visible banner rather than a silent no-op.
      const { state } = await ensureBackupDirectory({ request: false })
      if (cancelled) return
      if (state !== 'granted') { setBlocked(true); return }

      setBlocked(false)
      runningFor.current = target.id
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
        if (cancelled) return
        setMessage(`✓ ${target.name} backed up before its purge deadline.`)
        onDone()
      } catch (err) {
        if (!cancelled) setMessage(`Could not back up ${target.name}: ${err.message}`)
      } finally {
        if (!cancelled) setBusy(false)
      }
    })()

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.length, busy])

  return { pending, blocked, busy, message }
}

// Exported for the banner's "choose folder" action to re-check afterwards.
export async function refreshBackupPermission() {
  const { state } = await ensureBackupDirectory({ request: true })
  return state
}

// Used by AdminClients to refresh its own list after a background backup stamps last_backup_at.
export async function reloadClientBackupStamps(ids) {
  if (!ids?.length) return {}
  const { data } = await supabase.from('clients').select('id, last_backup_at').in('id', ids)
  return Object.fromEntries((data || []).map(c => [c.id, c.last_backup_at]))
}
