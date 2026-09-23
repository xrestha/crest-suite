import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { nprInt } from '../../../shared/nepalMoney'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { fetchPayrollEmployees, periodAdBounds } from './payrollData'
import { attendanceGaps, pickStatusPeriod, ssfDeadline } from './monthStatus'
import { fetchRunPayments, runPaymentSummary } from './salaryPayments'

// Where one month's payroll stands, as four linked steps (S768): attendance → approvals → the run →
// the SSF deposit. It is the answer to the owner's actual question — "is Bhadra's payroll right and
// done?" — which no screen gave: the HR Dashboard showed only the last FINALIZED run, the ten pages a
// month passes through linked to none of the others, and the SSF deadline appeared only on a card.
//
// Every step is a state in words plus a mark (✓ done, △ still needs someone, — nothing to say), never
// a colour alone. A step that could not be read says so; it does not fall back to a reassuring ✓.
//
// Two ways in. `period` shows that month (the Payroll page passes the one it is on, and its own loaded
// `employees`/`attendance`/`run`/`payslips` so nothing is read twice). `auto` picks the month itself —
// the newest started month whose payroll is not finalized — for the HR Dashboard.
//
// "Staff paid" (S782) sits between the run and the SSF deposit: Finalize pays nobody. The Payroll page
// passes its own `payments`/`paymentsError`, so the step always agrees with the Paid column; without
// them the step reads the run's payments itself.
export default function PayrollMonthStatus({ period: givenPeriod, auto = false, employees, attendance, run, payslips, payments, paymentsError, runStale, onPayrollPage = false, refreshKey }) {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [state, setState] = useState({ loading: true })

  useEffect(() => {
    if (!clientId || (!auto && !givenPeriod)) { setState({ loading: false, none: true }); return }
    let live = true
    setState(s => ({ ...s, loading: true }))
    ;(async () => {
      let period = givenPeriod
      if (auto) {
        const { data: periods, error } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
          .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }).limit(12)
        if (!live) return
        if (error) { setState({ loading: false, periodError: error }); return }
        const ids = (periods || []).map(p => p.id)
        const runs = ids.length ? await scopedFrom('hr_payroll_runs', 'period_id, status').in('period_id', ids) : { data: [] }
        if (!live) return
        if (runs.error) { setState({ loading: false, periodError: runs.error }); return }
        period = pickStatusPeriod(periods, Object.fromEntries((runs.data || []).map(r => [r.period_id, r.status])))
        if (!period) { setState({ loading: false, none: true }); return }
      }

      const b = periodAdBounds(period)
      const haveOwn = employees && attendance && run !== undefined
      const [who, att, runRes, leave, ot, tada] = await Promise.all([
        haveOwn ? { data: { employees } } : fetchPayrollEmployees(scopedFrom, period),
        haveOwn ? { data: attendance } : fetchAllRows(() => scopedFrom('hr_attendance', 'employee_id, bs_day').eq('period_id', period.id).order('id')),
        haveOwn ? { data: run } : scopedFrom('hr_payroll_runs', 'id, status').eq('period_id', period.id).maybeSingle(),
        scopedFrom('hr_leave_requests', 'id', { count: 'exact', head: true }).eq('status', 'pending').lte('start_date', b.end).gte('end_date', b.start),
        scopedFrom('hr_overtime_entries', 'id', { count: 'exact', head: true }).eq('status', 'pending').eq('bs_year', period.bs_year).eq('bs_month', period.bs_month),
        // Only a claim whose trip is over by month end is paid by this payroll.
        scopedFrom('hr_tada_claims', 'id', { count: 'exact', head: true }).eq('status', 'pending').lte('end_date', b.end),
      ])
      if (!live) return
      const runRow = runRes.error ? null : (runRes.data || null)
      let ssf = null
      let paid = null
      if (runRow?.status === 'finalized') {
        const ownPayments = payments !== undefined
        const [slips, pays] = await Promise.all([
          payslips ? { data: payslips } : scopedFrom('hr_payslips', 'employee_id, net_pay, ssf_employee, ssf_employer').eq('run_id', runRow.id),
          ownPayments ? { data: payments, error: paymentsError || null } : fetchRunPayments(scopedFrom, runRow.id),
        ])
        if (!live) return
        ssf = slips.error ? { error: slips.error } : { total: (slips.data || []).reduce((s, p) => s + (parseFloat(p.ssf_employee) || 0) + (parseFloat(p.ssf_employer) || 0), 0) }
        // Kept only when read here; the page's own payments are summarised at render, so a Mark paid
        // there updates this step without a re-read.
        if (!ownPayments) paid = slips.error || pays.error ? { error: slips.error || pays.error } : runPaymentSummary(slips.data, pays.data)
      }
      const approvalsFailed = [leave, ot, tada].some(r => r.error || r.count == null)
      setState({
        loading: false,
        period,
        attendance: who.error || att.error ? { error: who.error || att.error } : attendanceGaps({ period, employees: who.data.employees, attendance: att.data }),
        approvals: approvalsFailed ? { error: true } : { leave: leave.count, ot: ot.count, tada: tada.count },
        run: runRes.error ? { error: runRes.error } : { status: runRow?.status || 'none' },
        ssf,
        paid,
      })
    })()
    return () => { live = false }
  }, [clientId, auto, givenPeriod?.id, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (state.none) return null
  if (state.periodError) {
    return <div className="card month-status" role="note"><span className="month-status__state">Payroll status could not be read — reload to try again.</span></div>
  }
  const period = state.period || givenPeriod
  if (!period) return null
  const month = BS_MONTHS[period.bs_month - 1]
  const label = `${month} ${period.bs_year}`
  const deadline = ssfDeadline(period.bs_year, period.bs_month)
  const dueLabel = `${deadline.day} ${BS_MONTHS[deadline.month - 1]}`
  const reports = tab => `/hr/reports?tab=${tab}&period=${period.id}`

  const steps = []
  if (state.loading) {
    for (const name of ['Attendance', 'Approvals', 'Payroll', 'Staff paid', 'SSF deposit']) steps.push({ name, tone: 'none', mark: '…', text: 'Checking…' })
  } else {
    const a = state.attendance
    steps.push(a.error ? { name: 'Attendance', tone: 'none', mark: '—', text: 'Could not check', link: ['/hr/attendance', 'Open Attendance'] }
      : a.future ? { name: 'Attendance', tone: 'none', mark: '—', text: `${month} has not started` }
      : a.wageStaff === 0 ? { name: 'Attendance', tone: 'done', mark: '✓', text: 'Monthly staff only — an unmarked day is paid', link: ['/hr/attendance', 'Open Attendance'] }
      : a.gaps === 0 ? { name: 'Attendance', tone: 'done', mark: '✓', text: `Every day marked for daily and hourly staff${a.cutoff < 28 ? ' so far' : ''}`, link: ['/hr/attendance', 'Open Attendance'] }
      : { name: 'Attendance', tone: 'open', mark: '△', text: `${a.gaps} unmarked day${a.gaps === 1 ? '' : 's'} for ${a.staffWithGaps} daily/hourly staff — an unmarked day pays them nothing`, link: ['/hr/attendance', 'Mark attendance'] })

    const ap = state.approvals
    const waiting = ap.error ? 0 : ap.leave + ap.ot + ap.tada
    steps.push(ap.error ? { name: 'Approvals', tone: 'none', mark: '—', text: 'Could not check — open Leave, Overtime and TADA' }
      : waiting === 0 ? { name: 'Approvals', tone: 'done', mark: '✓', text: `Nothing touching ${month} is waiting` }
      : {
        name: 'Approvals', tone: 'open', mark: '△', text: `${waiting} waiting for a decision`,
        links: [ap.leave > 0 && ['/hr/leave', `Leave ${ap.leave}`], ap.ot > 0 && ['/hr/overtime', `Overtime ${ap.ot}`], ap.tada > 0 && ['/hr/tada', `TADA ${ap.tada}`]].filter(Boolean),
      })

    const r = state.run
    const payrollLink = onPayrollPage ? null : ['/hr/payroll', 'Open Payroll']
    steps.push(r.error ? { name: 'Payroll', tone: 'none', mark: '—', text: 'Could not check', link: payrollLink }
      : r.status === 'finalized' ? { name: 'Payroll', tone: 'done', mark: '✓', text: 'Finalized', link: payrollLink }
      : r.status === 'draft' ? { name: 'Payroll', tone: 'open', mark: '△', text: runStale ? 'Draft — out of date, Regenerate before finalizing' : 'Draft — not finalized yet', link: payrollLink }
      : { name: 'Payroll', tone: 'none', mark: '—', text: 'Not generated yet', link: payrollLink && ['/hr/payroll', 'Generate'] })

    // Staff paid (S782). "Not paid" is never inferred from a failed read.
    const pd = r.status !== 'finalized' ? null
      : payments !== undefined ? (paymentsError ? { error: paymentsError } : runPaymentSummary(payslips, payments))
      : state.paid
    const due = pd && !pd.error ? pd.owed - pd.paid : 0
    steps.push(r.status !== 'finalized' ? { name: 'Staff paid', tone: 'none', mark: '—', text: 'After Finalize — finalizing pays nobody' }
      : !pd || pd.error ? { name: 'Staff paid', tone: 'none', mark: '—', text: 'Could not check', link: payrollLink }
      : pd.owed === 0 ? { name: 'Staff paid', tone: 'done', mark: '✓', text: 'Nothing to pay' }
      : pd.over > 0 ? { name: 'Staff paid', tone: 'open', mark: '△', text: `${pd.over} paid more than their payslip — check Payroll`, link: payrollLink }
      : due === 0 ? { name: 'Staff paid', tone: 'done', mark: '✓', text: `All ${pd.owed} marked paid` }
      : { name: 'Staff paid', tone: 'open', mark: '△', text: `${pd.paid} of ${pd.owed} marked paid — NPR ${nprInt(pd.dueTotal)} still to pay`, link: payrollLink })

    const s = state.ssf
    steps.push(r.status !== 'finalized' ? { name: 'SSF deposit', tone: 'none', mark: '—', text: `After Finalize — due by ${dueLabel}` }
      : !s || s.error ? { name: 'SSF deposit', tone: 'none', mark: '—', text: `Could not read the amount — due by ${dueLabel}`, link: [reports('ssf'), 'SSF challan'] }
      : s.total === 0 ? { name: 'SSF deposit', tone: 'done', mark: '✓', text: 'Nothing to deposit — nobody on SSF' }
      // A passed date is not a missed deposit: the product does not record deposits, so it says
      // what was due rather than asserting it is late.
      : deadline.overdue ? { name: 'SSF deposit', tone: 'none', mark: '—', text: `NPR ${nprInt(s.total)} was due by ${dueLabel}`, link: [reports('ssf'), 'SSF challan'] }
      : { name: 'SSF deposit', tone: 'open', mark: '△', text: `Deposit NPR ${nprInt(s.total)} by ${dueLabel}${deadline.dueThisMonth ? ' — this month' : ''}`, link: [reports('ssf'), 'SSF challan'] })
  }

  return (
    <nav className="card month-status" aria-label={`${label} payroll — where it stands`} aria-busy={state.loading || undefined}>
      <div className="month-status__head">{label} payroll</div>
      <ol className="month-status__steps">
        {steps.map(step => (
          <li key={step.name} className="month-status__step">
            <span className="month-status__label">{step.name}</span>
            <span className="month-status__state">
              <span className={`month-status__mark month-status__mark--${step.tone}`} aria-hidden="true">{step.mark}</span>{' '}
              {step.text}
            </span>
            {step.link && <Link className="month-status__link" to={step.link[0]}>{step.link[1]}</Link>}
            {step.links?.length > 0 && (
              <span className="month-status__links">
                {step.links.map(([to, text], i) => <span key={to}>{i > 0 && ' · '}<Link className="month-status__link" to={to}>{text}</Link></span>)}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
