import { useEffect, useRef, useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError from '../../../components/ActionError'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { settleWithin } from '../../../utils/withTimeout'
import { randomUUID } from '../../../utils/uuid'
import { nepalBs, nepalTime } from '../../../shared/nepalTime'
import { formatBsDay } from '../../../utils/bsCalendar'
import { openPrintWindow, closeQuietly } from '../customers/creditReceiptHtml'
import { DEPOSIT_METHODS, depositMoney, parseDepositAmount } from './depositState'
import { DEPOSIT_READ_MS, depositErrorInfo, recordDeposit, recordOutcome } from './depositApi'

// Take deposit (S854): money a guest pays in advance for a party booking. A supervisor or a manager
// takes it (the server checks the rank itself); the guest gets a numbered deposit receipt with NO VAT on
// it, because VAT is charged on the final bill, which the deposit then pays in part as a tender. Owner
// decision: whatever is not used is always refunded, the way it came.
//
// The dialog writes nothing until Record, and Record is ONE call (record_booking_deposit). The print
// window is opened on that press, before anything is awaited, so the browser keeps the click permission
// to open it; the page prints into it once the deposit is recorded (`onAnswered`). A press with no
// answer keeps the dialog open on Check again, which sends the SAME request id: the server answers it
// with the first deposit, so a deposit is never taken twice.

const bookingWhen = r => {
  const bs = nepalBs(r?.reserved_for)
  return `${bs ? `${formatBsDay(bs.day, bs.month)} ${bs.year}, ` : ''}${nepalTime(r?.reserved_for)}`
}

export default function DepositModal({ reservation, onClose, onAnswered }) {
  const { scopedFrom } = useScopedDb()
  const [amountText, setAmountText] = useState('')
  const [method, setMethod] = useState('')
  const [note, setNote] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState(null) // { kind: 'warn' | 'error', text, detail }
  const [lost, setLost] = useState(false)
  const [shift, setShift] = useState({ open: null, error: null })
  // One id for this dialog: a retry, Check again included, is the same press to the server. Minted once,
  // on the first render, not on every render.
  const requestId = useRef(null)
  if (requestId.current === null) requestId.current = randomUUID()

  // Is a drawer open? Only to say so before a Cash deposit is pressed; the server decides.
  useEffect(() => {
    let gone = false
    settleWithin(scopedFrom('pos_shifts', 'id').eq('status', 'open').limit(1), DEPOSIT_READ_MS, 'Checking for an open shift')
      .then(({ data, error }) => {
        if (gone) return
        setShift(error ? { open: null, error } : { open: (data || []).length > 0, error: null })
      })
    return () => { gone = true }
  }, [scopedFrom])

  const parsed = parseDepositAmount(amountText)
  const amountMsg = showErrors ? parsed.error : ''
  const methodMsg = showErrors && !method ? 'Choose how the guest paid.' : ''
  const dirty = amountText !== '' || method !== '' || note !== ''
  const ready = !parsed.error && !!method

  async function record() {
    if (busy) return
    if (!ready) {
      setShowErrors(true)
      document.getElementById(parsed.error ? 'dep-amount' : 'dep-method')?.focus()
      return
    }
    const w = openPrintWindow()
    setBusy(true)
    setOutcome(null)
    let result
    try {
      result = await recordDeposit({
        reservationId: reservation.id, amount: parsed.amount, method, requestId: requestId.current, note, priorLost: lost,
      })
    } catch (err) {
      console.error('taking a deposit failed unexpectedly:', err)
      result = { status: 'unknown', error: err }
    }
    setBusy(false)
    if (result.status === 'recorded' || result.status === 'replayed') {
      onAnswered({ result, w })
      return
    }
    closeQuietly(w)
    if (result.status === 'unknown') setLost(true)
    const out = recordOutcome(result, { customerName: reservation.customer_name })
    setOutcome({ kind: out.kind, text: out.text, detail: result.error ? depositErrorInfo(result.error).detail : '' })
  }

  const summary = ready ? [
    `${depositMoney(parsed.amount)} from ${reservation.customer_name} by ${method}. A numbered deposit receipt is recorded and printed, with no VAT on it.`,
    'VAT is charged on the final bill, which this deposit pays in part. Whatever is not used is refunded the same way, and a cancellation or a no-show refunds all of it.',
    method === 'Cash'
      ? (shift.open === false
        ? 'No shift is open, so a Cash deposit will be refused: open a shift first, or pick the way the money really came.'
        : 'The cash goes on the open shift drawer count.')
      : 'Nothing goes into the cash drawer count. Only Cash does.',
  ] : null

  return (
    <Modal title={`Take deposit — ${reservation.customer_name}`} onClose={() => { if (!busy) onClose() }} maxWidth={560} dirty={dirty}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        Party of {reservation.party_size} · {bookingWhen(reservation)}
      </p>
      <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
        <div className="field-grid" style={{ marginBottom: 12 }}>
          <div className="form-field">
            <label htmlFor="dep-amount">
              <Tip text="What the guest pays now, in rupees. A sum works too, like 2500*4. This receipt carries no VAT: VAT is charged on the final bill, which the deposit pays in part." width={300}>
                Deposit amount
              </Tip>
            </label>
            <input id="dep-amount" className="form-input" inputMode="decimal" autoComplete="off" value={amountText}
              onChange={e => { setAmountText(e.target.value); setOutcome(o => (o?.kind === 'error' ? null : o)) }}
              placeholder="NPR" {...fieldAria('dep-amount', amountMsg)} />
            <FieldError id="dep-amount" message={amountMsg} />
          </div>
          <div className="form-field">
            <label htmlFor="dep-method">
              <Tip text="How the money came. Only Cash goes into the open shift drawer count. A refund goes back the same way." width={260}>
                Paid by
              </Tip>
            </label>
            <select id="dep-method" className="form-select" value={method} onChange={e => setMethod(e.target.value)}
              {...fieldAria('dep-method', methodMsg)}>
              <option value="">Choose…</option>
              {DEPOSIT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <FieldError id="dep-method" message={methodMsg} />
          </div>
          <div className="form-field field-grid__wide">
            <label htmlFor="dep-note">
              <Tip text="A transaction ID from the wallet or the card slip, or anything worth keeping with this deposit. It prints on the receipt. Optional." width={280}>
                Note
              </Tip>
            </label>
            <input id="dep-note" className="form-input" maxLength={300} autoComplete="off" value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
        {summary && (
          <div style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text1)' }}>
            {summary.map((line, i) => <p key={i} style={{ margin: i ? '6px 0 0' : 0 }}>{line}</p>)}
          </div>
        )}
      </fieldset>

      {outcome?.kind === 'warn' && <p className="note-banner" role="status" style={{ margin: '0 0 12px' }}>{outcome.text}</p>}
      {outcome?.kind === 'error' && <ActionError error={{ text: outcome.text, detail: outcome.detail }} />}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', margin: '12px 0 4px' }}>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        {/* aria-disabled, not disabled (the S759 pattern): a press says what is missing and moves to it. */}
        <button type="button" className="btn btn-primary" onClick={record} aria-busy={busy || undefined}
          aria-disabled={!busy && !ready ? true : undefined}>
          {busy ? 'Recording…' : lost ? 'Check again' : ready ? `Record ${depositMoney(parsed.amount)}` : 'Record deposit'}
        </button>
      </div>
    </Modal>
  )
}
