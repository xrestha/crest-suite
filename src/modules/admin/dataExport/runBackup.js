// One backup sequence, shared by all three callers: the Export/Import tab's button, the T-72h
// pre-purge trigger, and the pre-flight before every destructive Danger Zone action.
//
// Kept in its own file rather than inlined at each call site so the three can never drift on the
// part that matters — that `clients.last_backup_at` is stamped only after the bytes are actually
// on disk. A stamp written before the write would mark a client as backed up when it isn't, and
// the whole point of that column is to be trustworthy enough for a future purge to gate on.
import { supabase } from '../../../supabaseClient'
import { exportClientData } from './exportClientData'
import {
  ensureBackupDirectory,
  writeBackup,
  downloadFallback,
  isFileSystemAccessSupported,
} from './backupDirectory'

export class BackupNotConfiguredError extends Error {
  constructor(message) { super(message); this.name = 'BackupNotConfiguredError' }
}

/**
 * @param reason  'manual' | 'prepurge' | 'predelete' | 'archive'
 * @param allowPrompt  true when called from a click (may show the folder permission prompt);
 *                     false from the background trigger, which has no user gesture to spend.
 * @param allowDownloadFallback  true for interactive use; false for the background trigger,
 *                     which must not spray files into Downloads unattended.
 */
export async function runBackup(clientId, clientName, reason, {
  onProgress = () => {},
  allowPrompt = true,
  allowDownloadFallback = true,
} = {}) {
  const { handle, state } = await ensureBackupDirectory({ request: allowPrompt })

  // Resolve where this is going BEFORE spending a minute building the workbook — failing after
  // the export is done wastes the work and reads like the export itself broke.
  const canWriteToFolder = handle && state === 'granted'
  if (!canWriteToFolder && !allowDownloadFallback) {
    throw new BackupNotConfiguredError(
      state === 'none'
        ? 'No backup folder has been chosen yet.'
        : 'Write permission for the backup folder is not currently granted.',
    )
  }
  if (!canWriteToFolder && !isFileSystemAccessSupported()) {
    // Downloads still work here, so this is a warning the caller may proceed past — not a stop.
    onProgress('This browser cannot write to a folder; falling back to a download.', 0, 1)
  }

  const { manifest, xlsxBlob, jsonBlob } = await exportClientData(clientId, onProgress)

  const location = canWriteToFolder
    ? await writeBackup(handle, clientName, reason, { xlsxBlob, jsonBlob, manifest })
    : await downloadFallback(clientName, reason, { xlsxBlob, jsonBlob })

  // Only now, with the files written. Best-effort: a client row that cannot be stamped (the full
  // delete path removes it moments later anyway) must not turn a successful backup into a failure.
  const { error } = await supabase
    .from('clients')
    .update({ last_backup_at: new Date().toISOString() })
    .eq('id', clientId)
  if (error) console.error('Backup written but last_backup_at not stamped:', error.message)

  return { location, manifest, method: canWriteToFolder ? 'folder' : 'download' }
}
