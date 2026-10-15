import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { cancelReasonProblem } from './creditLedger'
import { cancelCreditReceipt, cancelConsequence, cancelOutcome } from './settleCredit'

// Cancelling a payment entered by mistake (S843, owner decision): a supervisor or a manager, with a
// reason of 3 to 300 characters. The receipt is never deleted; it stays on Collected as Cancelled with
// the reason, its bills owe again, and a Cash receipt's money goes on the OPEN shift as cash taken out
// (the server writes that entry in the same transaction). This dialog is the confirm: it names the
// amount and where the cash goes before anything is written.

export default function CancelReceiptModal({ receipt, onClose, onAnswered }) {
  const [reason, setReason] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const problem = cancelReasonProblem(reason)
  const lines = cancelConsequence(receipt)

  async function confirm() {
    if (busy) return
    if (problem) { setShowErrors(true); document.getElementById('cancel-reason')?.focus(); return }
    setBusy(true)
    setError(null)
    let result
    try {
      result = await cancelCreditReceipt({
        rpc: (name, args, signal) => (signal ? supabase.rpc(name, args).abortSignal(signal) : supabase.rpc(name, args)),
        receiptId: receipt.id, reason,
      })
    } catch (err) {
      console.error('cancelling a payment failed unexpectedly:', err)
      result = { status: 'unknown', error: err }
    }
    setBusy(false)
    const out = cancelOutcome(result, receipt)
    if (result.status === 'refused') {
      setError({ text: out.text, detail: asActionError(result.error, 'operator').detail })
      return
    }
    onAnswered({ result, outcome: out })
  }

  return (
    <Modal title={`Cancel receipt RC-${receipt.receipt_no}?`} onClose={() => { if (!busy) onClose() }} maxWidth={520} dirty={reason !== ''}>
      {lines.map((line, i) => (
        <p key={i} style={{ margin: i ? '8px 0 0' : 0, fontSize: 13, color: i === 2 && receipt.method === 'Cash' ? 'var(--theme-amber-text)' : 'var(--theme-text1)' }}>{line}</p>
      ))}
      <div className="form-field" style={{ margin: '14px 0 12px' }}>
        <label htmlFor="cancel-reason">
          <Tip text="Kept on the receipt with your name and the time, and printed on any reprint, so anyone can see later why it was cancelled. For example: Entered twice, or Wrong customer." width={300}>
            Why is it being cancelled?
          </Tip>{' '}<span style={{ color: 'var(--theme-red-text)' }}>*</span>
        </label>
        <textarea id="cancel-reason" className="form-input" rows={2} maxLength={300} value={reason} disabled={busy}
          onChange={e => setReason(e.target.value)} placeholder="e.g. Entered twice" style={{ width: '100%', resize: 'vertical' }}
          {...fieldAria('cancel-reason', showErrors ? problem : '')} />
        <FieldError id="cancel-reason" message={showErrors ? problem : ''} />
      </div>
      <ActionError error={error} />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', margin: '12px 0 4px' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Keep it</button>
        <button type="button" className="btn btn-danger" onClick={confirm} aria-busy={busy || undefined}
          aria-disabled={!busy && problem ? true : undefined}>
          {busy ? 'Cancelling…' : problem ? 'Say why first' : `Cancel this receipt`}
        </button>
      </div>
    </Modal>
  )
}
