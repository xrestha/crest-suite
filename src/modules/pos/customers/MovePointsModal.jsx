import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'
import { pointsMove, pointsValue, nprPoints, MAX_ADJUST_REASON } from './loyaltyPoints'

// Move a regular's points to their new phone number (owner addition, S815 4g).
//
// Before this it was two hand corrections in Adjust (take off here, add there), which nothing tied
// together. move_loyalty_points writes the pair in one transaction, with the reason on both rows and
// the signed-in login as the author. The rules, all the server's (this window only says them first):
//   * D11: only points that can be spent move; points from a Credit bill not paid yet stay on this
//     number until it is settled.
//   * D12: the new number joins this customer's scheme if it is in none, and this number leaves its
//     scheme.
//   * D14: a new number not yet in the customer book is added with this customer's name, PAN and address.

const CALL_MS = 20000

export default function MovePointsModal({ customer, schemeName = null, balance, held, pointValue, partners = [], onClose, onMoved }) {
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const spendable = Math.max(0, (balance || 0) - (held || 0))
  const check = pointsMove({ toPhone: phone, reason, fromPhone: customer.phone, partners })
  const blocker = check.errors.phone ? { label: 'Enter the new number', focus: 'move-phone' }
    : check.errors.reason ? { label: 'Say why', focus: 'move-reason' }
    : null
  const shown = showErrors ? check.errors : {}
  const fmt = n => Number(n).toLocaleString('en-IN')

  async function save() {
    if (busy) return
    if (blocker) {
      setShowErrors(true)
      document.getElementById(blocker.focus)?.focus()
      return
    }
    setBusy(true)
    setError(null)
    const { data, error: err } = await settleWithin(
      supabase.rpc('move_loyalty_points', { p_from_customer_id: customer.id, p_to_phone: phone.trim(), p_note: reason.trim() }),
      CALL_MS, 'Moving the points')
    setBusy(false)
    if (err) {
      // A lost answer is not a refusal: the move may have landed, and a second one would find only the
      // points left. Say so, rather than inviting a retry.
      if (isTimeout(err) || isNetworkError(err)) {
        setError({
          text: 'It is not known whether the points were moved — the connection dropped before the answer came back. Close this, reload the page and check both numbers’ History before trying again.',
          detail: asActionError(err, 'operator').detail,
        })
        return
      }
      setError(asActionError(err, 'operator'))
      return
    }
    onMoved(data)
  }

  return (
    <Modal title={`Move points — ${customer.name}`} onClose={() => { if (!busy) onClose() }} maxWidth={520}
      dirty={phone !== '' || reason !== ''}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        From {customer.phone} · <strong style={{ color: 'var(--theme-text1)' }}>{fmt(spendable)} points</strong> to move
        {pointValue != null && spendable > 0 ? ` (worth ${nprPoints(pointsValue(spendable, pointValue))})` : ''}
      </p>
      {held > 0 && (
        <p role="note" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
          {fmt(held)} more point{held === 1 ? '' : 's'} came from a Credit bill that is not paid yet. They stay on this
          number until it is settled, and can be moved then.
        </p>
      )}

      <div className="form-field" style={{ marginBottom: 12, maxWidth: 260 }}>
        <label htmlFor="move-phone">
          <Tip text="The guest's new phone number, typed any way (+977, spaces and dashes are fine). If it is not in the customer book yet, it is added with this customer's name and PAN." width={320}>
            New phone number
          </Tip>
        </label>
        <input id="move-phone" className="form-input" type="tel" inputMode="tel" autoComplete="off" value={phone}
          onChange={e => setPhone(e.target.value)} placeholder="98XXXXXXXX" disabled={busy}
          {...fieldAria('move-phone', shown.phone)} />
        <FieldError id="move-phone" message={shown.phone} />
      </div>

      <div className="form-field" style={{ marginBottom: 12 }}>
        <label htmlFor="move-reason">
          <Tip text="Kept on both numbers' points history, with your name and the time." width={300}>
            Reason
          </Tip>{' '}<span style={{ color: 'var(--theme-red-text)' }}>*</span>
        </label>
        <textarea id="move-reason" className="form-input" rows={2} maxLength={MAX_ADJUST_REASON} value={reason}
          onChange={e => setReason(e.target.value)} placeholder="e.g. Guest changed their number" disabled={busy}
          style={{ width: '100%', resize: 'vertical' }} {...fieldAria('move-reason', shown.reason)} />
        <FieldError id="move-reason" message={shown.reason} />
      </div>

      {check.toNumber && !check.errors.phone && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text1)' }}>
          {fmt(spendable)} points move to <strong>{check.toNumber}</strong>.
          {schemeName ? ` The new number joins ${schemeName} if it is in no scheme yet, and ${customer.phone} leaves ${schemeName}.` : ''}
        </p>
      )}

      <ActionError error={error} />

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', margin: '12px 0 4px' }}>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        {/* aria-disabled, not disabled (the S759 pattern): a press says what is missing and moves to it. */}
        <button className="btn btn-primary" onClick={save} disabled={busy}
          aria-disabled={!busy && blocker ? true : undefined}>
          {busy ? 'Moving…' : blocker ? blocker.label : `Move ${fmt(spendable)} points`}
        </button>
      </div>
    </Modal>
  )
}
