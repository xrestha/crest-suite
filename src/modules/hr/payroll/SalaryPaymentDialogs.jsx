import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { supabase } from '../../../supabaseClient'
import { formatAdAsBs } from '../../../utils/bsCalendar'
import { nprInt } from '../../../shared/nepalMoney'
import { PAYMENT_METHODS, methodLabel, recordSalaryPayments, todayNepalAd, voidSalaryPayment } from './salaryPayments'

const fmt = nprInt

// Mark one person or everyone paid (S782). Records what is still owed on each payslip — the database
// works the amount out itself, so this dialog only says how much it expects that to be. It moves no
// money; the copy says so, because "Mark paid" pressed before the transfer is the likely mistake.
export function MarkPaidDialog({ people, periodLabel, runId, onClose, onDone }) {
  const [paidOn, setPaidOn] = useState(todayNepalAd())
  const [method, setMethod] = useState('bank')
  const [reference, setReference] = useState('')
  const [fieldErr, setFieldErr] = useState({})
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const total = people.reduce((s, p) => s + p.due, 0)
  const one = people.length === 1
  const shown = people.slice(0, 6)

  async function submit() {
    if (busy) return
    const fe = {}
    if (!paidOn) fe['pay-date'] = 'Pick the date the salary was paid.'
    else if (paidOn > todayNepalAd()) fe['pay-date'] = 'The payment date cannot be in the future — record it once the money has gone out.'
    if (reference.trim().length > 100) fe['pay-ref'] = 'Keep the reference to 100 characters.'
    setFieldErr(fe)
    if (Object.keys(fe).length > 0) return
    setBusy(true); setError(null)
    const { data, error: err } = await recordSalaryPayments(supabase, {
      runId, employeeIds: people.map(p => p.employee_id), paidOn, method, reference,
    })
    setBusy(false)
    if (err) { setError(asActionError(err, 'operator')); return }
    onDone(data)
  }

  return (
    <Modal onClose={busy ? () => {} : onClose} title={one ? `Mark ${people[0].name} paid` : `Mark ${people.length} staff paid`} maxWidth={440}
      dirty={reference.trim() !== '' || method !== 'bank'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--theme-text1)' }}>
          <strong>NPR {fmt(total)}</strong> {one ? `for ${periodLabel}` : `to ${people.length} staff for ${periodLabel}`}
          {!one && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              {shown.map(p => <li key={p.employee_id}>{p.name} — NPR {fmt(p.due)}</li>)}
              {people.length > shown.length && <li>and {people.length - shown.length} more</li>}
            </ul>
          )}
        </div>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
          This records that the money was paid. It does not send any money — make the transfer or hand over the cash first.
        </p>

        <div className="form-field">
          <label htmlFor="pay-date">
            <Tip text="The day the salary actually reached the staff member — the transfer date or the day the cash was handed over. Staff see it in the Crest Staff app." width={260}>Date paid (BS)</Tip>
          </label>
          <BsCalendarPicker id="pay-date" value={paidOn} onChange={v => setPaidOn(v)} placeholder="Select date" invalid={fieldErr['pay-date']} />
          <FieldError id="pay-date" message={fieldErr['pay-date']} />
        </div>

        <div className="form-field">
          <label htmlFor="pay-method">How it was paid</label>
          <select id="pay-method" className="form-select" value={method} onChange={e => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>

        <div className="form-field">
          <label htmlFor="pay-ref">
            <Tip text="Optional. Something that finds the payment later: the bank batch or transfer number, the cheque number, or the wallet transaction ID." width={260}>Reference</Tip>
          </label>
          <input id="pay-ref" type="text" maxLength={100} value={reference} onChange={e => setReference(e.target.value)}
            placeholder="e.g. bank batch no. or cheque no." {...fieldAria('pay-ref', fieldErr['pay-ref'])} />
          <FieldError id="pay-ref" message={fieldErr['pay-ref']} />
        </div>

        <ActionError error={error} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Recording…' : one ? 'Mark paid' : `Mark ${people.length} paid`}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// Undo one payment (S782): a void with a reason, never a delete. The row stays, with who undid it,
// when and why, so the record of what was paid is never shorter than what happened.
export function UndoPaymentDialog({ payment, name, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [fieldErr, setFieldErr] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (busy) return
    const r = reason.trim()
    if (r.length < 3) { setFieldErr('Say why this payment is being undone — for example, "marked the wrong person".'); return }
    setFieldErr('')
    setBusy(true); setError(null)
    const { error: err } = await voidSalaryPayment(supabase, { paymentId: payment.id, reason: r })
    setBusy(false)
    if (err) { setError(asActionError(err, 'operator')); return }
    onDone()
  }

  return (
    <Modal onClose={busy ? () => {} : onClose} title={`Undo ${name}'s payment?`} maxWidth={420} dirty={reason.trim() !== ''}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.5 }}>
          NPR {fmt(payment.amount)} recorded as paid on {formatAdAsBs(payment.paid_on)} by {methodLabel(payment.method).toLowerCase()}
          {payment.reference ? ` (ref. ${payment.reference})` : ''}.
        </p>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
          {name} will show as not paid for this amount. The record is kept, marked undone, with your reason — it is not deleted. Undo only corrects the record; it does not take any money back.
        </p>
        <div className="form-field">
          <label htmlFor="undo-reason">Why is it being undone?</label>
          <textarea id="undo-reason" rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)}
            placeholder="e.g. Marked the wrong person; the transfer bounced" {...fieldAria('undo-reason', fieldErr)} />
          <FieldError id="undo-reason" message={fieldErr} />
        </div>
        <ActionError error={error} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" onClick={submit} disabled={busy} aria-busy={busy || undefined}>
            {busy ? 'Undoing…' : 'Undo payment'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
