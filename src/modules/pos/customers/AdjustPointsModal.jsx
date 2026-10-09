import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { isNetworkError } from '../../../shared/errorText'
import { nepalBsLong, nepalDateLong, nepalTime } from '../../../shared/nepalTime'
import { pointsAdjustment, pointsValue, describeLedgerRow, MAX_ADJUST_REASON } from './loyaltyPoints'

// Add points to a customer's balance, or take them off, by hand (S809 3k, CUSTOMERS-PARKING-5).
//
// Owner decision Q13 (b), 2026-10-09: the Owner and POS managers may add or correct a balance by hand.
// Every till message about points that did not land ("not added", "not known whether they were added",
// "can no longer be handed back") now sends the reader here. adjust_loyalty_points decides: it checks the
// rank, the outlet, the reason and the balance again, stamps the signed-in login, and writes one
// 'adjust' row with no bill (a row on a bill would be handed back or reversed with it).
//
// The latest points history is shown under the form, because "check before adding any by hand" is the
// first thing a lost award asks for, and the balance alone cannot say whether one bill's points landed.

const HISTORY_ROWS = 10
const CALL_MS = 20000

export default function AdjustPointsModal({ customer, balance, pointValue, isPartner = false, onClose, onAdjusted }) {
  const { scopedFrom } = useScopedDb()
  const [direction, setDirection] = useState(isPartner ? 'take' : 'add')
  const [pointsStr, setPointsStr] = useState('')
  const [reason, setReason] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [history, setHistory] = useState({ loading: true, rows: [], error: null })

  const loadHistory = useCallback(async () => {
    setHistory(h => ({ ...h, loading: true, error: null }))
    const { data, error: err } = await settleWithin(
      scopedFrom('pos_loyalty_ledger', 'id, kind, points, note, created_at, pos_orders(order_no, invoice_no)')
        .eq('customer_id', customer.id)
        .order('created_at', { ascending: false }).order('id', { ascending: false })
        .limit(HISTORY_ROWS),
      CALL_MS, 'Reading the points history')
    // A failed read keeps the rows already shown rather than blanking them.
    if (err) { setHistory(h => ({ ...h, loading: false, error: err })); return }
    setHistory({ loading: false, rows: data || [], error: null })
  }, [scopedFrom, customer.id])

  useEffect(() => { loadHistory() }, [loadHistory])

  const check = pointsAdjustment({ direction, pointsStr, reason, balance, isPartner })
  const blocker = check.errors.direction ? { label: 'Choose add or take off', focus: 'adjust-dir-take' }
    : check.errors.points ? { label: 'Enter the points', focus: 'adjust-points' }
    : check.errors.reason ? { label: 'Say why', focus: 'adjust-reason' }
    : null
  const shown = showErrors ? check.errors : {}

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
      supabase.rpc('adjust_loyalty_points', { p_customer_id: customer.id, p_points: check.points, p_note: reason.trim() }),
      CALL_MS, 'Changing the points')
    setBusy(false)
    if (err) {
      // A lost answer is not a refusal: the correction may have landed. Re-read the history so the
      // manager can see whether it is there before pressing Save again (which would add it twice).
      if (isTimeout(err) || isNetworkError(err)) {
        setError({
          text: 'It is not known whether the points were changed — the connection dropped before the answer came back. Check the points history below (it was just read again) before saving again, or the change could be made twice.',
          detail: asActionError(err, 'operator').detail,
        })
        loadHistory()
        return
      }
      setError(asActionError(err, 'operator'))
      return
    }
    onAdjusted(Number(data), check.points)
  }

  const fmt = n => Number(n).toLocaleString('en-IN')
  const worth = n => (pointValue != null && n > 0 ? ` (worth NPR ${pointsValue(n, pointValue).toLocaleString('en-IN')})` : '')

  return (
    <Modal title={`Adjust points — ${customer.name}`} onClose={() => { if (!busy) onClose() }} maxWidth={520}
      dirty={pointsStr !== '' || reason !== ''}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        {customer.phone} · holds <strong style={{ color: 'var(--theme-text1)' }}>{balance == null ? '—' : `${fmt(balance)} points`}</strong>{balance == null ? '' : worth(balance)}
      </p>
      {isPartner && (
        <p role="note" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This is a delivery partner’s number. A partner owes its bills and pays later, so it does not earn or
          spend points — points can only be taken off it.
        </p>
      )}

      <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
        <legend style={{ padding: 0, fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', marginBottom: 6 }}>
          <Tip text="Add: points that should have been earned and were not (a bill whose points did not reach the till), a goodwill gift, or points moved here from the guest's old number. Take off: points added by mistake, or points moving to the guest's new number (add them there next). A balance is never taken below 0 by hand." width={340}>
            Add or take off
          </Tip>
        </legend>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
          {[{ v: 'add', label: 'Add points', off: isPartner }, { v: 'take', label: 'Take points off', off: false }].map(o => (
            <label key={o.v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: o.off ? 'var(--theme-text3)' : 'var(--theme-text1)', cursor: o.off ? 'not-allowed' : 'pointer' }}>
              <input type="radio" name="adjust-dir" id={`adjust-dir-${o.v}`} value={o.v} checked={direction === o.v} disabled={o.off || busy}
                onChange={() => setDirection(o.v)} />
              {o.label}
            </label>
          ))}
        </div>
        <FieldError id="adjust-dir-take" message={shown.direction} />
      </fieldset>

      <div className="form-field" style={{ marginBottom: 12, maxWidth: 200 }}>
        <label htmlFor="adjust-points">
          <Tip text="Whole points, not rupees. What they are worth depends on the outlet's value of one point, shown above the schemes." width={300}>
            Points
          </Tip>
        </label>
        <input id="adjust-points" className="form-input" inputMode="numeric" autoComplete="off" value={pointsStr}
          onChange={e => setPointsStr(e.target.value)} placeholder="50" disabled={busy}
          {...fieldAria('adjust-points', shown.points)} />
        <FieldError id="adjust-points" message={shown.points} />
      </div>

      <div className="form-field" style={{ marginBottom: 12 }}>
        <label htmlFor="adjust-reason">
          <Tip text="Kept with the change in this customer's points history, with your name and the time, so anyone can see later why the balance moved. For example: Bill 1234's points did not reach the till." width={320}>
            Reason
          </Tip>{' '}<span style={{ color: 'var(--theme-red-text)' }}>*</span>
        </label>
        <textarea id="adjust-reason" className="form-input" rows={2} maxLength={MAX_ADJUST_REASON} value={reason}
          onChange={e => setReason(e.target.value)} placeholder="e.g. Bill 1234's points did not reach the till" disabled={busy}
          style={{ width: '100%', resize: 'vertical' }} {...fieldAria('adjust-reason', shown.reason)} />
        <FieldError id="adjust-reason" message={shown.reason} />
      </div>

      {check.newBalance !== null && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text1)' }}>
          New balance: <strong>{fmt(check.newBalance)} points</strong>{worth(check.newBalance)}
        </p>
      )}

      <ActionError error={error} />

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', margin: '12px 0 16px' }}>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        {/* aria-disabled, not disabled (the S759 pattern): a press says what is missing and moves to it. */}
        <button className="btn btn-primary" onClick={save} disabled={busy}
          aria-disabled={!busy && blocker ? true : undefined}>
          {busy ? 'Saving…' : blocker ? blocker.label : direction === 'take' ? 'Take points off' : 'Add points'}
        </button>
      </div>

      <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>
        <Tip text="The latest changes to this customer's points, newest first: points earned and spent on bills, points handed back from an unfinished payment, credit-note reversals and hand corrections." width={320}>
          Recent points
        </Tip>
      </h3>
      {history.error && (
        <ActionError error={{ text: `The points history could not be read, so it is not shown. ${asActionError(history.error, 'operator').text}`, detail: asActionError(history.error, 'operator').detail }} />
      )}
      {history.loading && history.rows.length === 0 ? (
        <p role="status" style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>Reading the points history…</p>
      ) : !history.error && history.rows.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>No points earned or spent yet.</p>
      ) : history.rows.length > 0 && (
        <div className="table-wrap">
          <table className="data-table" style={{ fontSize: 12 }}>
            <thead>
              <tr><th>When</th><th>What</th><th style={{ textAlign: 'right' }}>Points</th></tr>
            </thead>
            <tbody>
              {history.rows.map(r => {
                const d = describeLedgerRow(r)
                return (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{nepalBsLong(r.created_at) || nepalDateLong(r.created_at)} · {nepalTime(r.created_at)}</td>
                    <td>{d.what}{d.bill ? ` · ${d.bill}` : ''}</td>
                    {/* A ledger line is a record, not an alarm: earned points take the loyalty purple the
                        balances use, a minus stays quiet (DESIGN.md: loudness tracks demand for action). */}
                    <td style={{ textAlign: 'right', fontWeight: 600, color: r.points > 0 ? 'var(--theme-purple-text)' : r.points < 0 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>
                      {r.points > 0 ? '+' : ''}{fmt(r.points)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
