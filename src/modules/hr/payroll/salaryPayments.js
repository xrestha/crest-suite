// Salary payments (S782): the record that staff were actually PAID, which Finalize never said.
//
// A payment is its own row (hr_salary_payments), keyed by run + employee, never a column on the
// payslip: Reopen stays allowed after payment (decided with Aashish, 2026-09-23) and Regenerate
// deletes and re-inserts payslips, which would silently wipe a paid mark. So a payment outlives a
// Reopen, and when the month's figures then move, the difference is what this module reports — still
// to pay, or overpaid — instead of a tick that no longer means anything.
//
// Written only through two database functions (record_salary_payments / void_salary_payment); a
// trigger refuses every direct write. Undo is a void with a reason, never a delete.
//
// No supabase import: the caller passes its client, so the arithmetic stays testable without one.
import { formatAd } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'
import { groupByEmployee } from './payrollData'

// The database CHECK allows exactly these keys. The labels are the owner's words, not the column's.
export const PAYMENT_METHODS = [
  { key: 'bank',   label: 'Bank transfer' },
  { key: 'cash',   label: 'Cash' },
  { key: 'wallet', label: 'eSewa / Khalti' },
  { key: 'cheque', label: 'Cheque' },
]
export const methodLabel = key => PAYMENT_METHODS.find(m => m.key === key)?.label || key || '—'

const r2 = v => Math.round((parseFloat(v) || 0) * 100) / 100

// Today in Kathmandu as 'YYYY-MM-DD' — the payment date's default. Not `new Date()` formatted
// locally: a manager viewing from abroad would default to their own day.
export const todayNepalAd = () => formatAd(nepalCivilDate(new Date()))

// Where one payslip stands against the payments recorded for it.
//   state 'none'   — nothing to pay (net pay zero or less)
//         'unpaid' — nothing recorded yet
//         'short'  — part recorded; the figures moved up after a Reopen, so `due` is still owed
//         'paid'   — recorded payments equal net pay
//         'over'   — recorded payments exceed net pay; the figures moved down after a Reopen
// `payments` are that employee's rows for this run; undone ones are kept in the list for the record
// but never counted. Paisa-rounded both sides, so float residue never reads as a rupee owed.
export function paymentState(netPay, payments) {
  const all = payments || []
  const active = all.filter(p => !p.voided_at)
  const paid = r2(active.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0))
  const net = r2(netPay)
  const due = r2(net - paid)
  const last = [...active].sort((a, b) =>
    String(b.paid_on).localeCompare(String(a.paid_on)) || String(b.created_at).localeCompare(String(a.created_at)))[0] || null
  let state
  if (net <= 0 && paid === 0) state = 'none'
  else if (paid === 0) state = 'unpaid'
  else if (due >= 0.01) state = 'short'
  else if (due <= -0.01) state = 'over'
  else state = 'paid'
  return { state, net, paid, due, active, voided: all.filter(p => p.voided_at), last }
}

// The whole run: how many of its payslips are settled, who is still to be paid (the ids Mark
// everyone paid sends), and the money on each side. `payments` is every row for the run.
export function runPaymentSummary(payslips, payments) {
  const byEmp = groupByEmployee(payments)
  const out = { owed: 0, paid: 0, over: 0, toPay: [], dueTotal: 0, paidTotal: 0, byEmployee: new Map() }
  for (const s of payslips || []) {
    const st = paymentState(s.net_pay, byEmp.get(s.employee_id))
    out.byEmployee.set(s.employee_id, st)
    out.paidTotal = r2(out.paidTotal + st.paid)
    if (st.state === 'none') continue
    out.owed += 1
    if (st.state === 'paid') out.paid += 1
    else if (st.state === 'over') { out.paid += 1; out.over += 1 }
    else { out.toPay.push(s.employee_id); out.dueTotal = r2(out.dueTotal + st.due) }
  }
  return out
}

// Every payment row for one run, undone ones included (the page shows them as history). One run's
// rows are a few per employee at most, so no paging.
export function fetchRunPayments(scopedFrom, runId) {
  return scopedFrom('hr_salary_payments', 'id, run_id, employee_id, amount, paid_on, method, reference, paid_by, created_at, voided_at, voided_by, void_reason')
    .eq('run_id', runId).order('created_at').order('id')
}

export function recordSalaryPayments(supabase, { runId, employeeIds, paidOn, method, reference }) {
  return supabase.rpc('record_salary_payments', {
    p_run_id: runId, p_employee_ids: employeeIds, p_paid_on: paidOn, p_method: method,
    p_reference: reference ? String(reference).trim() || null : null,
  })
}

export function voidSalaryPayment(supabase, { paymentId, reason }) {
  return supabase.rpc('void_salary_payment', { p_payment_id: paymentId, p_reason: String(reason || '').trim() })
}
