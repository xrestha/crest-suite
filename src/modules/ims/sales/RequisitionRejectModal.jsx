import { useState } from 'react'
import Modal from '../../../components/Modal'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError from '../../../components/ActionError'
import Tip from '../../../components/Tip'

// The longest reason the dialog accepts. A reason is a sentence for the person who raised the
// slip, not a report; the database sets no cap, so this is a UI courtesy only.
export const REJECT_REASON_MAX = 500

/**
 * Reject a draft requisition, with the reason it was refused (S756, owner decision D14).
 *
 * Its own dialog rather than useConfirm(): the reason is REQUIRED, so the confirm button has to
 * react to what is typed, and a useConfirm body is captured once when asked. And on a refused write
 * the dialog stays open with the reason still in the box — useConfirm closes either way, which
 * would throw away the sentence someone just wrote.
 *
 * `onConfirm(reason)` resolves to an error (string or { text, detail }) or null on success; the
 * page closes the dialog on success.
 */
export default function RequisitionRejectModal({ slipLabel, onConfirm, onCancel }) {
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const blank = reason.trim() === ''
  const fieldMsg = touched && blank ? 'Say why this requisition is being rejected — the person who raised it will read this.' : ''

  async function submit() {
    setTouched(true)
    if (blank || busy) return
    setBusy(true)
    setError('')
    const err = await onConfirm(reason.trim())
    // On success the page unmounts this dialog, so only a failure touches state again.
    if (err) { setError(err); setBusy(false) }
  }

  return (
    <Modal title="Reject this requisition?" onClose={busy ? () => {} : onCancel} maxWidth={480}>
      <div style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        <p style={{ margin: '0 0 12px' }}>
          {slipLabel} will be marked <strong>Rejected</strong>. Nothing leaves the store, it stops
          counting as pending, and it cannot be issued or edited afterwards — the department raises
          a new requisition if they still need the items. The slip and your reason stay on record.
        </p>
        <div className="form-field">
          <label htmlFor="req-reject-reason">
            <Tip text="Required. Shown on the slip, in the list and on the printed and exported copy, so the department knows why nothing was issued." width={260}>Reason for rejecting *</Tip>
          </label>
          <textarea
            id="req-reject-reason"
            className="form-input"
            rows={3}
            maxLength={REJECT_REASON_MAX}
            value={reason}
            onChange={e => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. Out of stock until Friday's delivery; already issued on the morning slip"
            disabled={busy}
            {...fieldAria('req-reject-reason', fieldMsg)}
          />
          <FieldError id="req-reject-reason" message={fieldMsg} />
        </div>
      </div>
      <ActionError error={error} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={submit} disabled={busy || (touched && blank)}>
          {busy ? 'Rejecting…' : 'Reject Requisition'}
        </button>
      </div>
    </Modal>
  )
}
