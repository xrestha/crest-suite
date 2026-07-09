import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { BS_MONTHS, bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'
import { computePayslip } from './payrollCompute'
import { computeMonthlyTds, fiscalYearOf } from './tds'
import { printWithTitle } from '../../../utils/printTitle'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

const inp = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6,
  padding: '6px 8px', fontSize: 13, color: '#e8e0d0', outline: 'none', fontFamily: 'inherit',
}

export default function PayrollRun() {
  const { clientId, isAdmin } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [periods,    setPeriods]    = useState([])
  const [period,     setPeriod]     = useState(null)
  const [run,        setRun]        = useState(null)
  const [payslips,   setPayslips]   = useState([])
  const [employees,  setEmployees]  = useState([])
  const [components, setComponents] = useState([])
  const [attendance, setAttendance] = useState([])
  const [otEntries,  setOtEntries]  = useState([])
  const [advances,   setAdvances]   = useState([])
  const [repayments, setRepayments] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [busy,       setBusy]       = useState(false)
  const [msg,        setMsg]        = useState('')
  const [viewSlip,   setViewSlip]   = useState(null)
  const [printSlip,  setPrintSlip]  = useState(null)

  const empMap = Object.fromEntries(employees.map(e => [e.id, e]))

  useEffect(() => {
    if (!clientId) return
    async function init() {
      setLoading(true)
      const { data: p } = await scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      setPeriods(p || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      if (open) { setPeriod(open); await loadAll(open.id, open.bs_year, open.bs_month) }
      setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll(periodId, bsYear, bsMonth) {
    const [
      { data: runRow }, { data: emps }, { data: comps }, { data: att }, { data: ot },
      { data: advs },   { data: reps },
    ] = await Promise.all([
      scopedFrom('hr_payroll_runs').eq('period_id', periodId).maybeSingle(),
      scopedFrom('hr_employees', 'id, full_name, employee_code, pay_basis, basic_salary, ssf_no, ssf_enrolled, life_insurance_premium, health_insurance_premium, marital_status, department, status')
        .in('status', ['active', 'probation']).order('full_name'),
      scopedFrom('hr_salary_components'),
      scopedFrom('hr_attendance').eq('period_id', periodId),
      scopedFrom('hr_overtime_entries', 'employee_id, ot_hours, ot_type')
        .eq('bs_year', bsYear).eq('bs_month', bsMonth).eq('status', 'approved'),
      scopedFrom('hr_advances').order('issued_date'),
      scopedFrom('hr_advance_repayments'),
    ])
    setEmployees(emps || [])
    setComponents(comps || [])
    setAttendance(att || [])
    setOtEntries(ot || [])
    setAdvances(advs || [])
    setRepayments(reps || [])
    setRun(runRow || null)
    if (runRow) {
      const { data: slips } = await scopedFrom('hr_payslips').eq('run_id', runRow.id)
      setPayslips(slips || [])
    } else {
      setPayslips([])
    }
  }

  async function handlePeriodChange(id) {
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setMsg(''); setLoading(true)
    await loadAll(id, p.bs_year, p.bs_month); setLoading(false)
  }

  // Year-to-date taxable per employee: sum of (gross − SSF) and tds from PRIOR
  // finalized payslips in the same fiscal year (months before the current one).
  async function fetchYtdMap() {
    const cur = fiscalYearOf(period.bs_year, period.bs_month)
    const { data } = await scopedFrom('hr_payslips', 'employee_id, gross, ssf_employee, tds, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
      .eq('hr_payroll_runs.status', 'finalized')
    const map = {}
    ;(data || []).forEach(r => {
      if (r.hr_payroll_runs?.status !== 'finalized') return
      const mp = r.hr_payroll_runs?.monthly_periods
      if (!mp) return
      const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
      if (fy.fyStart !== cur.fyStart || fy.monthInFy >= cur.monthInFy) return
      const e = map[r.employee_id] || { gross: 0, ssf: 0, withheld: 0 }
      e.gross += r.gross || 0
      e.ssf   += r.ssf_employee || 0
      e.withheld += r.tds || 0
      map[r.employee_id] = e
    })
    return map
  }

  // Approved TADA claims (from the TADA Claims ledger) whose trip dates fall inside this BS
  // period, per employee. Feeds the TADA column's auto-fill — Finalize marks these claims Paid
  // so the same trip is never reimbursed both through TADA Claims and through payroll.
  async function fetchApprovedTadaMap() {
    const periodStart = formatAd(bsToAd(period.bs_year, period.bs_month, 1))
    const periodEnd   = formatAd(bsToAd(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month)))
    const { data } = await scopedFrom('hr_tada_claims', 'id, employee_id, total_amount, start_date, end_date')
      .eq('status', 'approved')
    const map = {}
    ;(data || []).forEach(c => {
      if (c.start_date > periodEnd || c.end_date < periodStart) return
      const e = map[c.employee_id] || { total: 0, ids: [] }
      e.total += parseFloat(c.total_amount) || 0
      e.ids.push(c.id)
      map[c.employee_id] = e
    })
    return map
  }

  // Per-employee scheduled advance deduction for this period.
  // For each active advance: deduct min(installment, outstanding).
  // If no installment set, deduct full outstanding (treated as one-time advance).
  function buildAdvanceMap() {
    const repaidMap = {}
    repayments.forEach(r => {
      repaidMap[r.advance_id] = (repaidMap[r.advance_id] || 0) + (parseFloat(r.amount) || 0)
    })
    const advMap = {}
    advances.filter(a => a.status === 'active').forEach(adv => {
      const repaid = repaidMap[adv.id] || 0
      const outstanding = Math.max(0, parseFloat(adv.amount) - repaid)
      if (outstanding <= 0) return
      const installment = parseFloat(adv.installment_amount) || outstanding
      const deduction = Math.min(installment, outstanding)
      advMap[adv.employee_id] = (advMap[adv.employee_id] || 0) + deduction
    })
    return advMap
  }

  function buildRows(runId, ytdMap, tadaMap) {
    const advMap = buildAdvanceMap()
    return employees.map(emp => {
      const comps        = components.filter(c => c.employee_id === emp.id)
      const att          = attendance.filter(a => a.employee_id === emp.id)
      const empOtEntries = otEntries.filter(e => e.employee_id === emp.id)
      const advDed       = Math.round(advMap[emp.id] || 0)
      const slip         = computePayslip(emp, comps, att, period, 0, empOtEntries, advDed)
      const isSsf    = !!(emp.ssf_enrolled)
      const isMarried = emp.marital_status === 'married'
      const ytd   = ytdMap[emp.id] || { gross: 0, ssf: 0, withheld: 0 }
      const tds   = computeMonthlyTds({
        period,
        monthlyGross:          slip.gross,
        monthlySsf:            slip.ssf_employee,
        ytdGross:              ytd.gross,
        ytdSsf:                ytd.ssf,
        ytdWithheld:           ytd.withheld,
        isSsf,
        isMarried,
        annualLifeInsurance:   parseFloat(emp.life_insurance_premium) || 0,
        annualHealthInsurance: parseFloat(emp.health_insurance_premium) || 0,
      })
      const tada = tadaMap[emp.id] || { total: 0, ids: [] }
      const tadaAmount = Math.round(tada.total)
      const net = slip.net_pay - tds + tadaAmount
      return { run_id: runId, employee_id: emp.id, ...slip, tds, tada_amount: tadaAmount, tada_claim_ids: tada.ids, net_pay: net }
    })
  }

  async function generate() {
    if (!period || employees.length === 0) return
    setBusy(true); setMsg('')
    const ytdMap = await fetchYtdMap()
    const tadaMap = await fetchApprovedTadaMap()
    const { data: runRow, error: rErr } = await scopedInsert('hr_payroll_runs', { period_id: period.id, status: 'draft' }, { single: true })
    if (rErr) { setMsg('error:' + rErr.message); setBusy(false); return }
    const { error: pErr } = await scopedInsert('hr_payslips', buildRows(runRow.id, ytdMap, tadaMap))
    if (pErr) { setMsg('error:' + pErr.message); setBusy(false); return }
    await loadAll(period.id, period.bs_year, period.bs_month)
    setMsg('ok:Payroll generated'); setBusy(false)
  }

  async function regenerate() {
    if (!run || run.status === 'finalized') return
    if (!window.confirm('Recompute all payslips from current salary, attendance & tax? Manual TDS and TADA overrides will be reset (TADA re-fills from currently Approved claims for this period).')) return
    setBusy(true); setMsg('')
    const ytdMap = await fetchYtdMap()
    const tadaMap = await fetchApprovedTadaMap()
    await scopedDelete('hr_payslips').eq('run_id', run.id)
    const { error } = await scopedInsert('hr_payslips', buildRows(run.id, ytdMap, tadaMap))
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await loadAll(period.id, period.bs_year, period.bs_month)
    setMsg('ok:Recomputed'); setBusy(false)
  }

  async function updateTds(slip, value) {
    if (run?.status === 'finalized') return
    const tds = parseFloat(value) || 0
    const net = slip.gross + slip.ot_amount - slip.absence_deduction - slip.ssf_employee - slip.other_deductions - (slip.advance_deduction || 0) - tds + (slip.tada_amount || 0)
    setPayslips(ps => ps.map(s => s.id === slip.id ? { ...s, tds, net_pay: net } : s))
    await scopedUpdate('hr_payslips', { tds, net_pay: net }).eq('id', slip.id)
  }

  // TADA (travel/daily allowance) is a non-taxable reimbursement — added after TDS,
  // not run through gross/tax computation like the rest of the payslip.
  async function updateTada(slip, value) {
    if (run?.status === 'finalized') return
    const tada = parseFloat(value) || 0
    const net = slip.gross + slip.ot_amount - slip.absence_deduction - slip.ssf_employee - slip.other_deductions - (slip.advance_deduction || 0) - slip.tds + tada
    setPayslips(ps => ps.map(s => s.id === slip.id ? { ...s, tada_amount: tada, net_pay: net } : s))
    await scopedUpdate('hr_payslips', { tada_amount: tada, net_pay: net }).eq('id', slip.id)
  }

  async function finalize() {
    if (!run) return
    if (!window.confirm('Finalize this payroll? Payslips will be locked as a permanent record.')) return
    setBusy(true)

    // Build per-advance repaid totals, excluding any prior auto-entries for this run
    // (idempotent: on re-finalize after reopen, exclude stale rows we're about to replace)
    const repaidMap = {}
    repayments.filter(r => r.payroll_run_id !== run.id).forEach(r => {
      repaidMap[r.advance_id] = (repaidMap[r.advance_id] || 0) + (parseFloat(r.amount) || 0)
    })

    // Build auto-repayment rows and track which advances become fully settled
    const repayRows = []
    const settleIds = []
    const today = new Date().toISOString().split('T')[0]
    const monthLabel = `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} payroll`

    for (const slip of payslips) {
      if (!slip.advance_deduction || slip.advance_deduction <= 0) continue
      const empAdvs = advances.filter(a => a.employee_id === slip.employee_id && a.status === 'active')
      let remaining = slip.advance_deduction

      for (const adv of empAdvs) {
        if (remaining <= 0) break
        const repaid = repaidMap[adv.id] || 0
        const outstanding = Math.max(0, parseFloat(adv.amount) - repaid)
        if (outstanding <= 0) continue
        const installment = parseFloat(adv.installment_amount) || outstanding
        const thisPayment = Math.min(Math.min(installment, outstanding), remaining)
        repayRows.push({
          advance_id: adv.id,
          employee_id: slip.employee_id,
          repaid_date: today,
          amount: thisPayment,
          notes: monthLabel,
          payroll_run_id: run.id,
        })
        if (repaid + thisPayment >= parseFloat(adv.amount) - 0.01) settleIds.push(adv.id)
        remaining -= thisPayment
      }
    }

    // TADA claims auto-filled into a payslip get marked Paid so the same trip is never
    // reimbursed both through TADA Claims and through this payroll run. Skipped for any
    // payslip where the clerk zeroed TADA back out — those claims stay Approved, unpaid.
    const tadaClaimIds = []
    payslips.forEach(s => {
      if ((s.tada_amount || 0) > 0 && Array.isArray(s.tada_claim_ids)) tadaClaimIds.push(...s.tada_claim_ids)
    })

    await scopedUpdate('hr_payroll_runs', { status: 'finalized', finalized_at: new Date().toISOString() }).eq('id', run.id)
    // Idempotent: delete prior auto-repayments for this run, then re-insert
    await scopedDelete('hr_advance_repayments').eq('payroll_run_id', run.id)
    if (repayRows.length > 0) {
      await scopedInsert('hr_advance_repayments', repayRows)
    }
    if (settleIds.length > 0) {
      await scopedUpdate('hr_advances', { status: 'settled' }).in('id', settleIds)
    }
    if (tadaClaimIds.length > 0) {
      await scopedUpdate('hr_tada_claims', { status: 'paid', paid_at: new Date().toISOString(), paid_method: 'Payroll' })
        .in('id', tadaClaimIds).eq('status', 'approved')
    }

    await loadAll(period.id, period.bs_year, period.bs_month)
    const suffix = repayRows.length > 0 ? ` — ${repayRows.length} advance repayment(s) auto-recorded` : ''
    setMsg('ok:Finalized' + suffix)
    setBusy(false)
  }

  async function reopen() {
    if (!run) return
    if (!window.confirm('Reopen this payroll for editing? It will return to draft, advance repayments auto-recorded by this run will be reversed, and TADA claims auto-marked Paid by this run will revert to Approved.')) return
    setBusy(true)

    // Reverse auto-repayments created by this run
    await scopedDelete('hr_advance_repayments').eq('payroll_run_id', run.id)

    // Reactivate any advances that were auto-settled by this run but now have outstanding balance
    const { data: updatedReps } = await scopedFrom('hr_advance_repayments', 'advance_id, amount')
    const updatedRepaidMap = {}
    ;(updatedReps || []).forEach(r => {
      updatedRepaidMap[r.advance_id] = (updatedRepaidMap[r.advance_id] || 0) + (parseFloat(r.amount) || 0)
    })
    const reactivateIds = advances
      .filter(a => a.status === 'settled')
      .filter(a => Math.max(0, parseFloat(a.amount) - (updatedRepaidMap[a.id] || 0)) > 0.01)
      .map(a => a.id)
    if (reactivateIds.length > 0) {
      await scopedUpdate('hr_advances', { status: 'active' }).in('id', reactivateIds)
    }

    // Revert TADA claims this run auto-marked Paid — but only ones marked paid BY payroll,
    // never a claim a manager separately paid by hand via TADA Claims.
    const tadaClaimIds = []
    payslips.forEach(s => {
      if (Array.isArray(s.tada_claim_ids) && s.tada_claim_ids.length > 0) tadaClaimIds.push(...s.tada_claim_ids)
    })
    if (tadaClaimIds.length > 0) {
      await scopedUpdate('hr_tada_claims', { status: 'approved', paid_at: null, paid_method: null })
        .in('id', tadaClaimIds).eq('paid_method', 'Payroll')
    }

    await scopedUpdate('hr_payroll_runs', { status: 'draft', finalized_at: null }).eq('id', run.id)
    await loadAll(period.id, period.bs_year, period.bs_month)
    setMsg('ok:Reopened'); setBusy(false)
  }

  function printPayslip(slip, emp) {
    setPrintSlip({ slip, emp })
    setTimeout(() => { printWithTitle(`Payslip - ${emp.full_name} - ${periodLabel}`); setPrintSlip(null) }, 60)
  }

  function exportExcel() {
    const rows = payslips.map(s => {
      const emp = empMap[s.employee_id] || {}
      return {
        'Employee': emp.full_name || '', 'Code': emp.employee_code || '', 'Pay Basis': s.pay_basis,
        'Basic/Rate': s.basic, 'Allowances': s.allowances, 'Gross': s.gross,
        'Present Days': s.present_days, 'Absent Days': s.absent_days,
        'OT Hours': s.ot_hours, 'OT Amount': s.ot_amount,
        'Absence Ded': s.absence_deduction, 'SSF Employee': s.ssf_employee,
        'Other Ded': s.other_deductions, 'Advance Ded': s.advance_deduction || 0,
        'TDS': s.tds, 'TADA': s.tada_amount || 0, 'Net Pay': s.net_pay,
        'SSF Employer': s.ssf_employer,
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Payroll')
    const label = period ? `${BS_MONTHS[period.bs_month - 1]}-${period.bs_year}` : ''
    XLSX.writeFile(wb, `payroll_${label}.xlsx`)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'
  const finalized = run?.status === 'finalized'
  const totals = payslips.reduce((a, s) => {
    a.gross  += s.gross; a.ot += s.ot_amount; a.ssfEmp += s.ssf_employee; a.ssfEmpr += s.ssf_employer
    a.advDed += s.advance_deduction || 0
    a.ded    += s.absence_deduction + s.other_deductions + s.tds
    a.tada   += s.tada_amount || 0
    a.net    += s.net_pay
    return a
  }, { gross: 0, ot: 0, ssfEmp: 0, ssfEmpr: 0, ded: 0, advDed: 0, tada: 0, net: 0 })

  return (
    <div>
      <div className={printSlip ? 'no-print' : ''}>
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 className="page-title">Payroll</h1>
            <p className="page-subtitle">
              Monthly payroll run — {periodLabel}
              {run && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: finalized ? '#34d399' : '#c9a84c', background: finalized ? 'rgba(52,211,153,0.1)' : 'rgba(201,168,76,0.1)', border: `1px solid ${finalized ? 'rgba(52,211,153,0.2)' : 'rgba(201,168,76,0.2)'}`, padding: '2px 8px', borderRadius: 10 }}>{finalized ? 'Finalized' : 'Draft'}</span>}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {msg && <span style={{ fontSize: 12, color: msg.startsWith('ok') ? '#34d399' : '#f87171' }}>{msg.split(':').slice(1).join(':')}</span>}
            <select className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
              {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
            </select>
            {run && <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>⬇ Export</button>}
            {run && !finalized && <button className="btn btn-ghost" onClick={regenerate} disabled={busy} style={{ fontSize: 12 }}>↻ Regenerate</button>}
            {run && !finalized && <button className="btn btn-primary" onClick={finalize} disabled={busy} style={{ fontSize: 12 }}>Finalize</button>}
            {run && finalized && isAdmin && <button className="btn btn-ghost" onClick={reopen} disabled={busy} style={{ fontSize: 12 }}>Reopen</button>}
          </div>
        </div>

        {loading ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
        ) : employees.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>No active employees. Add employees in HR → Employees first.</div>
        ) : !run ? (
          <div className="card" style={{ padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>💵</div>
            <div style={{ fontSize: 14, color: '#e8e0d0', marginBottom: 6 }}>No payroll run for {periodLabel} yet</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 18 }}>Generates a draft from each employee's salary structure and {periodLabel} attendance. You can review and edit before finalizing.</div>
            <button className="btn btn-primary" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate Payroll'}</button>
          </div>
        ) : (
          <>
            {/* Stat cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
              {[
                { label: 'Total Gross',  value: totals.gross, color: '#c9a84c', tip: 'Sum of gross earnings (basic + allowances, or earned wage) across all payslips.' },
                { label: 'Deductions',   value: totals.ded + totals.ssfEmp + totals.advDed, color: '#f87171', tip: 'SSF employee + absence deductions + other deductions + advance recovery + TDS.' },
                { label: 'Net Payable',  value: totals.net, color: '#34d399', tip: 'Total take-home pay to disburse this period.' },
                { label: 'Employer SSF', value: totals.ssfEmpr, color: '#6b7280', tip: '20% SSF the company pays on top — not part of net payable.' },
              ].map(s => (
                <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    <Tip text={s.tip} width={260}>{s.label}</Tip>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {fmt(s.value)}</div>
                  <div style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>{payslips.length} employees</div>
                </div>
              ))}
            </div>

            {/* Register */}
            <div className="card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross earnings: basic + allowances (monthly) or earned wage (daily/hourly)." width={250}>Gross</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Overtime pay at 1.5× the hourly rate." width={200}>OT</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Pay deducted for unpaid days — absences, unpaid leave, and half-days (gross ÷ days in month × unpaid days, allowances included)." width={270}>Absence</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="11% SSF — only for employees with an SSF number on file." width={230}>SSF</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="All configured deductions except SSF — CIT/PF, etc." width={250}>Other Ded</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Advance or loan installment auto-recovered this period from active advances in the Advances & Loans ledger. Repayment rows are written on Finalize." width={290}>Advance</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Income tax, computed automatically from FY tax slabs using year-to-date projection. Editable while draft if you need to override." width={270}>TDS</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Travel/Daily Allowance reimbursement — a non-taxable amount added after TDS, not part of the taxable gross. Editable while draft." width={290}>TADA</Tip></th>
                      <th style={{ textAlign: 'right', color: '#c9a84c' }}>Net Pay</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {payslips.map(s => {
                      const emp = empMap[s.employee_id] || {}
                      const isMonthly = s.pay_basis === 'monthly'
                      const advDed = s.advance_deduction || 0
                      // Overtime recorded in BOTH the attendance sheet's OT column AND approved
                      // Overtime entries pays twice — flag it so the payroll runner can fix the source.
                      const attOtHrs = attendance.filter(a => a.employee_id === s.employee_id)
                        .reduce((sum, a) => sum + (parseFloat(a.ot_hours) || 0), 0)
                      const otBothSources = attOtHrs > 0 && otEntries.some(e => e.employee_id === s.employee_id)
                      return (
                        <tr key={s.id}>
                          <td>
                            <div style={{ fontWeight: 600, color: '#e8e0d0', fontSize: 13 }}>{emp.full_name || '—'}</div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                              {emp.employee_code && <span style={{ fontSize: 10, color: '#6b7280' }}>{emp.employee_code}</span>}
                              {!isMonthly && <span style={{ fontSize: 10, fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: 8, padding: '1px 6px' }}>{s.pay_basis}</span>}
                              {!emp.ssf_enrolled && <span style={{ fontSize: 10, color: '#4b5563' }}>no SSF</span>}
                              {otBothSources && (
                                <Tip text={`OT recorded in TWO places for this employee — ${attOtHrs} hr in the attendance sheet's OT column AND approved Overtime entries. Both are paid, so the same hours may be paid twice. Zero out one source and Regenerate.`} width={290}>
                                  <span style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '1px 6px', cursor: 'help' }}>⚠ OT ×2?</span>
                                </Tip>
                              )}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(s.gross)}</td>
                          <td style={{ textAlign: 'right', color: s.ot_amount > 0 ? '#34d399' : '#4b5563' }}>{s.ot_amount > 0 ? `+${fmt(s.ot_amount)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: s.absence_deduction > 0 ? '#f87171' : '#4b5563' }}>{s.absence_deduction > 0 ? `−${fmt(s.absence_deduction)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: s.ssf_employee > 0 ? '#f87171' : '#4b5563' }}>{s.ssf_employee > 0 ? `−${fmt(s.ssf_employee)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: s.other_deductions > 0 ? '#f87171' : '#4b5563' }}>{s.other_deductions > 0 ? `−${fmt(s.other_deductions)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: advDed > 0 ? '#fb923c' : '#4b5563' }}>{advDed > 0 ? `−${fmt(advDed)}` : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {finalized
                              ? <span style={{ color: s.tds > 0 ? '#f87171' : '#4b5563' }}>{s.tds > 0 ? `−${fmt(s.tds)}` : '—'}</span>
                              : <input type="number" min="0" defaultValue={s.tds || ''} onBlur={e => updateTds(s, e.target.value)} placeholder="0" style={{ ...inp, width: 80, textAlign: 'right' }} />}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
                              {(s.tada_claim_ids || []).length > 0 && (
                                <Tip text={finalized
                                  ? `Auto-paid from ${s.tada_claim_ids.length} approved TADA claim(s) for this period — marked Paid in TADA Claims when this run was finalized.`
                                  : `Auto-filled from ${s.tada_claim_ids.length} approved TADA claim(s) for this period. Finalizing will mark them Paid — clear this to 0 to skip paying them via payroll.`} width={280}>
                                  <span style={{ fontSize: 10, cursor: 'help' }}>🔗</span>
                                </Tip>
                              )}
                              {finalized
                                ? <span style={{ color: (s.tada_amount || 0) > 0 ? '#34d399' : '#4b5563' }}>{(s.tada_amount || 0) > 0 ? `+${fmt(s.tada_amount)}` : '—'}</span>
                                : <input type="number" min="0" defaultValue={s.tada_amount || ''} onBlur={e => updateTada(s, e.target.value)} placeholder="0" style={{ ...inp, width: 80, textAlign: 'right' }} />}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 700, fontSize: 14 }}>{fmt(s.net_pay)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setViewSlip({ slip: s, emp })}>Payslip</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                      <td style={{ color: '#6b7280', fontSize: 12 }}>Total — {payslips.length}</td>
                      <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(totals.gross)}</td>
                      <td style={{ textAlign: 'right', color: '#34d399' }}>{totals.ot > 0 ? `+${fmt(totals.ot)}` : '—'}</td>
                      <td colSpan={4} style={{ textAlign: 'right', color: '#f87171' }}>−{fmt(totals.ded + totals.ssfEmp + totals.advDed)}</td>
                      <td></td>
                      <td style={{ textAlign: 'right', color: totals.tada > 0 ? '#34d399' : '#4b5563' }}>{totals.tada > 0 ? `+${fmt(totals.tada)}` : '—'}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c', fontSize: 15 }}>{fmt(totals.net)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.6 }}>
              {finalized ? 'This payroll is finalized — payslips are locked as a permanent record.' : 'Draft — Regenerate to pull the latest salary, attendance & tax, then Finalize to lock. You can override any TDS value inline.'} SSF is applied only to employees with an SSF number. TDS is computed automatically from the fiscal-year tax slabs using year-to-date projection; finalize earlier months first so each month\'s tax builds on the last. TADA (travel/daily allowance) auto-fills from that employee's Approved TADA Claims for this period (🔗 marks a claim-linked amount) and is added after TDS as a non-taxable reimbursement, not part of taxable gross — you can still hand-edit or clear it. Finalize marks linked claims Paid in TADA Claims; Reopen reverts them to Approved. Active advance installments are auto-deducted; repayment rows are written to Advances & Loans on Finalize.
            </div>
          </>
        )}
      </div>

      {/* On-screen payslip modal */}
      {viewSlip && (
        <PayslipModal data={viewSlip} period={period} periodLabel={periodLabel} onClose={() => setViewSlip(null)} onPrint={() => printPayslip(viewSlip.slip, viewSlip.emp)} />
      )}

      {/* Print-only payslip */}
      {printSlip && (
        <div className="print-only">
          <PayslipBody slip={printSlip.slip} emp={printSlip.emp} periodLabel={periodLabel} forPrint />
        </div>
      )}
    </div>
  )
}

function PayslipModal({ data, periodLabel, onClose, onPrint }) {
  const { slip, emp } = data
  return (
    <div className="no-print" style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflowY: 'auto', padding: '40px 16px' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} onClick={onClose} />
      <div style={{ position: 'relative', width: 460, maxWidth: '100%', background: '#141820', border: '1px solid #2a2f3d', borderRadius: 12, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, color: '#e8e0d0' }}>Payslip</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 18, cursor: 'pointer' }}>✕</button>
        </div>
        <PayslipBody slip={slip} emp={emp} periodLabel={periodLabel} />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={onPrint}>🖨 Print</button>
        </div>
      </div>
    </div>
  )
}

function PayslipBody({ slip, emp, periodLabel, forPrint }) {
  const c1 = forPrint ? '#000' : '#9ca3af'
  const c2 = forPrint ? '#000' : '#e8e0d0'
  const fmtn = n => `NPR ${Math.round(n || 0).toLocaleString('en-NP')}`
  const Row = ({ label, value, strong, neg }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13, fontWeight: strong ? 700 : 400 }}>
      <span style={{ color: strong ? c2 : c1 }}>{label}</span>
      <span style={{ color: strong ? (forPrint ? '#000' : '#c9a84c') : (neg ? '#f87171' : c2) }}>{neg ? '− ' : ''}{fmtn(value)}</span>
    </div>
  )
  const isMonthly = slip.pay_basis === 'monthly'
  return (
    <div>
      <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${forPrint ? '#ccc' : '#2a2f3d'}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: c2 }}>{emp.full_name}</div>
        <div style={{ fontSize: 12, color: c1 }}>
          {[emp.employee_code, emp.department, `${slip.pay_basis} pay`].filter(Boolean).join(' · ')} — {periodLabel}
        </div>
      </div>

      <div style={{ fontSize: 10, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Earnings</div>
      <Row label={isMonthly ? 'Basic Salary' : `Wage (${slip.pay_basis})`} value={slip.basic} />
      {isMonthly && slip.allowances > 0 && <Row label="Allowances (incl. Dearness)" value={slip.allowances} />}
      {!isMonthly && <Row label={slip.pay_basis === 'hourly' ? `Hours worked (${slip.hours_worked})` : `Days worked (${slip.worked_days})`} value={slip.gross} />}
      {slip.ot_amount > 0 && <Row label={`Overtime (${slip.ot_hours} hrs)`} value={slip.ot_amount} />}
      <Row label="Gross Earnings" value={slip.gross + slip.ot_amount} strong />

      <div style={{ fontSize: 10, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Deductions</div>
      {slip.absence_deduction > 0 && <Row label="Absence / Unpaid Leave" value={slip.absence_deduction} neg />}
      {slip.ssf_employee > 0 && <Row label="SSF Employee (11%)" value={slip.ssf_employee} neg />}
      {slip.other_deductions > 0 && <Row label="Other Deductions" value={slip.other_deductions} neg />}
      {(slip.advance_deduction || 0) > 0 && <Row label="Advance / Loan Recovery" value={slip.advance_deduction} neg />}
      {slip.tds > 0 && <Row label="TDS (income tax)" value={slip.tds} neg />}
      {(slip.absence_deduction + slip.ssf_employee + slip.other_deductions + (slip.advance_deduction || 0) + slip.tds) === 0 && (
        <div style={{ fontSize: 12, color: c1, padding: '5px 0' }}>None</div>
      )}

      {(slip.tada_amount || 0) > 0 && (
        <>
          <div style={{ fontSize: 10, color: c1, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 4px' }}>Reimbursement</div>
          <Row label="TADA (non-taxable)" value={slip.tada_amount} />
        </>
      )}

      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `2px solid ${forPrint ? '#000' : '#2a2f3d'}` }}>
        <Row label="Net Pay" value={slip.net_pay} strong />
      </div>
      {slip.ssf_employer > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: c1 }}>
          Employer SSF (20%, paid by company): {fmtn(slip.ssf_employer)}
        </div>
      )}
    </div>
  )
}
