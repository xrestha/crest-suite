// What the client drawer's Danger tab says when a destructive action stops, as `{ text, detail }`
// for ActionError (S852). These used to be `'error:' + err.message`, or a sentence with the raw
// message spliced into its middle, so the operator read "Failed to delete purchase_entries: …" and
// had to work out for themselves what was gone and what was safe to press next.
//
// The facts every message is built on:
//   * admin-user-ops' deleteClientData and clearModuleData delete table by table, so a refusal
//     part-way leaves the client part-cleared. Pressing the button again carries on, because each
//     delete of what is already gone is a no-op; a refusal at the same table every time is named
//     in the detail, and the message says so rather than promising a retry that cannot work.
//   * A failure with no answer from the server proves nothing about how far the server got, so it
//     says that it is not known, never that something was or was not erased.
//   * Every one of these actions takes a backup first, and pressing it again takes ANOTHER backup
//     of the part-cleared client. The one taken before the first attempt is the complete copy.
import { errorInfo } from '../../shared/errorText'
import { gotNoAnswer } from './loginOpError'

export const KEEP_BACKUP = 'Keep the backup taken just before the first attempt: it is the complete copy.'
const SAME_PLACE = 'If it stops at the same place again, the detail below says what is in the way, and that needs fixing first.'

const detailOf = err => (err ? errorInfo(err, 'operator').detail : '')

/**
 * deleteClientData or clearModuleData threw.
 * @param what    'the data of Casa' / 'the POS transactions of Casa'
 * @param button  the label to press again ('Clear Client Data')
 * @param kept    what the action never touches, as a sentence ('Logins, settings and the client record are kept.')
 * @param prefix  an optional opening sentence ('Archive did not finish. ')
 */
export function clearStopped({ what, button, kept, prefix = '', err }) {
  const detail = detailOf(err)
  if (gotNoAnswer(err)) {
    return {
      text: `${prefix}No answer came back while clearing ${what}, so it is not known how much was erased. ${kept} ${KEEP_BACKUP} Reload the page and look at this client before pressing ${button} again.`,
      detail,
    }
  }
  return {
    text: `${prefix}Clearing ${what} stopped partway: some of it may already be erased, and the rest is still there. ${kept} ${KEEP_BACKUP} Press ${button} again to carry on. ${SAME_PLACE}`,
    detail,
  }
}

/** Archive cleared the data, then the lock (is_active = false) did not confirm. */
export function archiveLockFailed(clientName, err) {
  return {
    text: `The data of ${clientName} was cleared and its logins kept, but locking the account could not be confirmed, so its logins may still sign in to an empty outlet. Lock it with Deactivate on its card in Admin → Clients. Restoring the backup reverses the clear.`,
    detail: detailOf(err),
  }
}

/**
 * Delete Client's first stage: one deleteUser per login, every one attempted, data untouched on any
 * failure. `failures` is `[{ name, err }]`.
 */
export function loginsStopped(clientName, done, total, failures) {
  const names = failures.map(f => f.name).join(', ')
  const unanswered = failures.some(f => gotNoAnswer(f.err))
  return {
    text: `Delete Client stopped after removing ${done} of ${total} logins of ${clientName}. Its data and the client record were not touched. ` +
      `${failures.length === 1 ? 'This login' : 'These logins'} could not be confirmed as removed: ${names}.` +
      `${unanswered ? ' Some got no answer from the server, so they may be gone already.' : ''} ` +
      `${KEEP_BACKUP} Press Delete Client again to carry on: a login already removed is not tried again.`,
    detail: failures.map(f => `${f.name}: ${detailOf(f.err)}`).join('; '),
  }
}

/** A later Delete Client stage failed; every login is gone by then. `stage` is the stage that failed. */
export function deleteStageFailed(clientName, stage, err) {
  const detail = detailOf(err)
  if (stage === 'operational data') {
    return clearStopped({
      what: `the data of ${clientName}`,
      prefix: 'Every login was removed. ',
      button: 'Delete Client',
      kept: 'The client record is still there.',
      err,
    })
  }
  if (stage === 'the client record') {
    return {
      text: `Every login of ${clientName} was removed and its data cleared, but deleting the client record itself could not be confirmed. Reload Admin → Clients: if ${clientName} is still listed, press Delete Client again to finish. ${KEEP_BACKUP}`,
      detail,
    }
  }
  return {
    text: `Every login of ${clientName} was removed and its data cleared, but deleting its ${stage} could not be confirmed, so the client record is still there. ${KEEP_BACKUP} Press Delete Client again to finish.`,
    detail,
  }
}

/** Something threw that the step-by-step handlers above did not catch. */
export function dangerUnexpected(clientName, err) {
  return {
    text: `That stopped on an unexpected error before it could say how far it got. Reload the page and look at ${clientName} before trying again. ${KEEP_BACKUP}`,
    detail: detailOf(err) || String(err || ''),
  }
}

/**
 * Backup tab: the restore threw (S852). `stage` is how far handleRestoreFile got: 'file' (reading
 * the .json), 'restore' (restoreClientData) or 'logins' (the staff-login steps after the data).
 * `started` is whether any table had begun inserting, which restoreClientData reports through
 * onProgress before each table's first row. Before that point nothing can have been restored, and
 * the restore's own refusals ("This client already has data …") are sentences written for the
 * operator, so they are the reason, not fine print. After it, rows may be in, and a restore will
 * not run again over a client that holds data, so the next step is to look, then clear.
 */
export function restoreStopped({ clientName, stage, started, err }) {
  const detail = detailOf(err)
  if (stage === 'file') {
    return {
      text: 'That file could not be read as a Crest backup, so nothing was restored. Choose the .json file of a backup: the .xlsx copy is for reading and cannot restore.',
      detail,
    }
  }
  if (stage === 'restore' && !started) {
    const own = err?.name === 'Error' && err.message
    return {
      text: `Nothing was restored into ${clientName}.${own ? ` ${err.message.trim()}` : ''}`,
      detail: own ? '' : detail,
    }
  }
  if (stage === 'restore') {
    return {
      text: `The restore into ${clientName} stopped partway: some of the backup may already be in, and the rest is not. A restore will not run again while the client holds data, so look at what came back first, then clear it with Clear Client Data on the Danger tab before restoring the same file again.`,
      detail,
    }
  }
  return {
    text: `The backup was restored into ${clientName}, but the staff-login steps after it stopped on an unexpected error, so its logins may not have been rebuilt or re-linked. Open the Users and Staff PINs tabs to see which logins exist before doing anything else.`,
    detail,
  }
}
