import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { FilterChips } from '../../../components/Tabs'
import { calcGratuity } from './gratuityCompute'
import { fetchSsfContributions, ssfFundedFor } from './ssfEnrolment'
import ReportLoadError from '../../../components/ReportLoadError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { firstError } from '../../../shared/queryError'
import { GRATUITY_VESTING_MONTHS } from '../payrollConstants'
import { formatAd } from '../../../utils/bsCalendar'

const fmt = nprInt
const fmtD = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
const VEST = GRATUITY_VESTING_MONTHS

// Format service duration as "X yr Y mo"
function fmtService(months) {
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0) return `${m} mo`
  if (m === 0) return `${y} yr`
  return `${y} yr ${m} mo`
}

export default function GratuityTracker() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [employees, setEmployees] = useState([])
  // The employer SSF actually contributed, per employee, from finalized payslips and settlements —
  // the gratuity share of it is what the SSF has already funded (S752, see ssfEnrolment.js).
  const [ssfRows,   setSsfRows]   = useState({})
  // Finalized settlements not yet recorded as paid: their gratuity is still owed, but the employee
  // has left the active list above, so without this it was owed and counted nowhere.
  const [unpaidSettlements, setUnpaidSettlements] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [loadError, setLoadError] = useState(null) // a failed read is not "no active employees"
  const [filter,    setFilter]    = useState('all')   // all | vested | vesting
  const [dept,      setDept]      = useState('all')
  const clientReq = useLatestRequest()

  useEffect(() => {
    if (!clientId) return
    load(clientId)
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load(forClient) {
    clientReq.begin(forClient)   // an operator switching clients must not land the previous one's list
    setLoading(true)
    // ssf_no is selected because the SSF gate is `ssf_enrolled AND ssf_no`, matching payroll — a
    // flagged employee with a blank number had nothing contributed on their behalf.
    const [emps, ssf, unpaid] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, department, designation, join_date, basic_salary, pay_basis, ssf_enrolled, ssf_no, status')
        .in('status', ['active', 'probation'])
        .order('full_name'),
      fetchSsfContributions(scopedFrom),
      scopedFrom('hr_final_settlements', 'id, employee_name, gratuity, last_working_date')
        .eq('status', 'finalized').is('paid_at', null),
    ])
    if (!clientReq.isCurrent(forClient)) return
    // The SSF read failing is a failed report, not "no SSF offset": the page would otherwise show every
    // enrolled employee's full accrual as the liability (S752 — a figure the page has not computed).
    const error = firstError([emps, ssf, unpaid])
    if (error) { setLoadError(error); setLoading(false); return }
    setLoadError(null)
    setEmployees(emps.data || [])
    setSsfRows(ssf.data || {})
    setUnpaidSettlements(unpaid.data || [])
    setLoading(false)
  }

  const gratuityOf = useCallback(
    e => calcGratuity(e, { ssfFunded: ssfFundedFor(ssfRows[e.id], { joinDate: e.join_date }) }), [ssfRows])

  // `allRows` is the same set as `rows` minus the vested/vesting filter, so calcGratuity used to
  // run TWICE per employee — once for the table and once again for the filter-pill counts, on
  // every render including each click of those pills. Computed once here and filtered below;
  // `.filter()` preserves order, so both lists are exactly what they were.
  const allRows = useMemo(() => employees
    .filter(e => (e.pay_basis || 'monthly') === 'monthly')  // only monthly staff; daily/hourly have no fixed monthly basic
    .filter(r => dept === 'all' || r.department === dept)
    .map(e => ({ ...e, g: gratuityOf(e) })), [employees, dept, gratuityOf])

  const rows = useMemo(() => allRows.filter(r => {
    if (filter === 'vested')  return r.g.vested
    if (filter === 'vesting') return !r.g.vested
    return true
  }), [allRows, filter])

  const depts = useMemo(
    () => [...new Set(employees.map(e => e.department).filter(Boolean))].sort(), [employees])

  // One pass for the five figures below the table, rather than five walks of the same list.
  const { totalAccrued, totalSsf, totalNet, totalMonthly, vestedCount } = useMemo(() => {
    let totalAccrued = 0, totalSsf = 0, totalNet = 0, totalMonthly = 0, vestedCount = 0
    for (const r of rows) {
      totalAccrued  += r.g.totalAccrued
      totalSsf      += r.g.ssfCovered
      totalNet      += r.g.netLiability
      totalMonthly  += r.g.monthlyAccrual
      if (r.g.vested) vestedCount++
    }
    return { totalAccrued, totalSsf, totalNet, totalMonthly, vestedCount }
  }, [rows])
  const nonMonthly = useMemo(
    () => employees.filter(e => (e.pay_basis || 'monthly') !== 'monthly').length, [employees])
  const unpaidGratuity = useMemo(
    () => unpaidSettlements.reduce((a, s) => a + (parseFloat(s.gratuity) || 0), 0), [unpaidSettlements])

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const today = formatAd(new Date())
    // The scope goes in the sheet: the filters are not visible in a workbook opened a month later.
    const scope = `Gratuity accrual as of ${today} · ${dept === 'all' ? 'all departments' : dept}`
      + ` · ${filter === 'vested' ? `vested (${VEST}+ months) only` : filter === 'vesting' ? `under ${VEST} months only` : 'all service lengths'}`
      + ` · monthly-paid active and probation staff${nonMonthly > 0 ? ` (${nonMonthly} daily/hourly not included)` : ''}`
    const ws = XLSX.utils.aoa_to_sheet([[scope], []])
    XLSX.utils.sheet_add_json(ws, rows.map(r => ({
      'Employee':          r.full_name,
      'Code':              r.employee_code || '',
      'Department':        r.department || '',
      'Designation':       r.designation || '',
      'Join Date':         r.join_date || '',
      'Service':           fmtService(r.g.months),
      [`Vested (${VEST}+ mo)`]: r.g.vested ? 'Yes' : 'No',
      'Basic (NPR)':       r.g.basic,
      'Monthly Accrual':   Math.round(r.g.monthlyAccrual),
      'Total Accrued':     Math.round(r.g.totalAccrued),
      'SSF Funded':        r.g.coveredMonths > 0 ? Math.round(r.g.ssfCovered) : 'No SSF contributions',
      'SSF Months':        r.g.coveredMonths,
      'Net Liability':     Math.round(r.g.netLiability),
    })), { origin: 'A3' })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Gratuity Accrual')
    XLSX.writeFile(wb, `Gratuity_Accrual_${today}.xlsx`)
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Gratuity Accrual</h1>
          <p className="page-subtitle">
            Labour Act: 1 month basic per year of service ·{' '}
            <Tip text={`The ${VEST}-month threshold shown here is a commonly applied assumption, not something this app has confirmed in the current 2074 Act's own text — Sections 52/53 read as a defined-contribution scheme (a portable SSF balance) accruing monthly from day 1, with no explicit tenure threshold found. Other sources still cite 1-year or 5-year thresholds. Service counts completed months only: someone who joined on the 20th completes a month on the 20th of the next. Confirm with an accountant before relying on this for an actual payout, especially for anyone close to the threshold.`} width={340}>
              Vests after {VEST} completed months (unconfirmed — verify with an accountant)
            </Tip>
          </p>
        </div>
        <div className="no-print">
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}>⬇ Export Excel</button>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>No active employees found.</div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="stat-grid">
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="Gratuity still owed in cash for active monthly-paid employees: the Labour Act accrual (basic ÷ 12 × completed months of service) minus what their employer SSF contributions have already funded. The gross accrual before that is shown underneath." width={280}>Total Liability</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>NPR {fmt(totalNet)}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>Gross accrued: NPR {fmt(totalAccrued)}</div>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="Monthly accrual rate — how fast the total gratuity pool is growing. Sum of (basic ÷ 12) across all monthly employees." width={280}>Monthly Accrual</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>NPR {fmt(totalMonthly)}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>Added to liability per month</div>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text={`Employees who have completed ${VEST} months of service, commonly treated as eligible for gratuity payment on departure. This threshold is not confirmed in the current Labour Act 2074 text (which reads as day-1 accrual with no explicit vesting gate) — verify with an accountant before relying on it for an actual payout.`} width={320}>Vested Employees</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>{vestedCount}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>{rows.length - vestedCount} still vesting</div>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="The gratuity share of the employer SSF actually contributed this spell of service — 3.33 out of every 20 the employer paid, summed from finalized payslips and settlements. A raise, an unpaid month or a month with no payroll is counted as it really was." width={300}>SSF Funded</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)' }}>NPR {fmt(totalSsf)}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>from contributions actually paid</div>
            </div>
          </div>

          {/* An enrolled employee with no stored SSF contribution gets NO offset, which is right —
              nothing was contributed — but it inflates the liability above, so it is said. */}
          {rows.filter(r => r.g.enrolled && r.g.coveredMonths === 0).length > 0 && (
            <div className="card" style={{ marginBottom: 14, padding: '10px 16px', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 6%, transparent)', fontSize: 12, color: 'var(--theme-text3)' }}>
              ⚠ {rows.filter(r => r.g.enrolled && r.g.coveredMonths === 0).length} SSF-enrolled staff have no finalized payslip carrying an SSF contribution yet, so nothing is netted off their gratuity — their liability above is the full Labour Act accrual.
            </div>
          )}

          {unpaidSettlements.length > 0 && (
            <div className="card" style={{ marginBottom: 14, padding: '10px 16px', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 6%, transparent)', fontSize: 12, color: 'var(--theme-text3)' }}>
              ⚠ Not in the figures above: {unpaidSettlements.length} finalized Final Settlement{unpaidSettlements.length === 1 ? '' : 's'} not yet recorded as paid, carrying NPR {fmt(unpaidGratuity)} of gratuity ({unpaidSettlements.map(s => s.employee_name || 'a leaver').join(', ')}). Mark {unpaidSettlements.length === 1 ? 'it' : 'them'} paid on Final Settlement once the money has gone.
            </div>
          )}

          {nonMonthly > 0 && (
            <div className="card" style={{ marginBottom: 14, padding: '10px 16px', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 6%, transparent)', fontSize: 12, color: 'var(--theme-text3)' }}>
              ⚠ {nonMonthly} daily/hourly staff are not shown. Crest does not calculate gratuity for wage workers yet — here or on Final Settlement — so work theirs out with your accountant.
            </div>
          )}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }} className="no-print">
            <FilterChips label="Filter by vesting" active={filter} onChange={setFilter}
              options={[
                { key: 'all',     label: `All (${allRows.length})` },
                { key: 'vested',  label: `Vested ${VEST}+ mo (${allRows.filter(r => r.g.vested).length})` },
                { key: 'vesting', label: `Under ${VEST} mo (${allRows.filter(r => !r.g.vested).length})` },
              ]} />
            {depts.length > 0 && (
              <select aria-label="Filter by department" className="form-select" style={{ fontSize: 12 }} value={dept} onChange={e => setDept(e.target.value)}>
                <option value="all">All Departments</option>
                {depts.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </div>

          {/* Table */}
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Join Date</th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Completed months of service from the join date to today. A month completes on the same day of the next month." width={220}>Service</Tip>
                    </th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text={`Vested = ${VEST} completed months of service, commonly treated as eligible for full gratuity payment on departure — this threshold is not confirmed in the current Labour Act 2074 text. Verify with an accountant.`} width={300}>Vested</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Basic salary ÷ 12 = amount added to the gratuity pool each month." width={240}>Monthly Accrual</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Total accrued under Nepal Labour Act: (basic ÷ 12) × completed months of service. Equals one month's basic per year." width={280}>Labour Act Total</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="The gratuity share of the employer SSF actually contributed during this spell of service (3.33 of every 20 paid), from finalized payslips. Blank when nothing has been contributed." width={300}>SSF Funded</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Estimated additional cash liability beyond the SSF fund. Labour Act Total − SSF Covered. This is what you may need to pay in addition to SSF on departure." width={300}>Net Liability</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{r.full_name}</div>
                        <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{r.department || ''}{r.designation ? ` · ${r.designation}` : ''}</div>
                      </td>
                      <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>{fmtD(r.join_date)}</td>
                      <td style={{ textAlign: 'center', color: 'var(--theme-text1)' }}>{fmtService(r.g.months)}</td>
                      <td style={{ textAlign: 'center' }}>
                        {r.g.vested
                          ? <span className="badge badge-gray">Vested</span>
                          : <span className="badge badge-gray">Vesting · {VEST - r.g.months} mo left</span>}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(r.g.monthlyAccrual)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>{fmt(r.g.totalAccrued)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>
                        {r.g.coveredMonths > 0
                          ? <>{fmt(r.g.ssfCovered)}<span style={{ display: 'block', fontSize: 10, color: 'var(--theme-text2)' }}>{r.g.coveredMonths} mo</span></>
                          : <span style={{ color: 'var(--theme-text2)', fontSize: 11 }}>{r.g.enrolled ? 'No contributions yet' : 'Not enrolled'}</span>}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 700 }}>{fmt(r.g.netLiability)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={4} style={{ color: 'var(--theme-text2)' }}>Total — {rows.length} employees</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(totalMonthly)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(totalAccrued)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(totalSsf)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontSize: 15 }}>{fmt(totalNet)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.7 }}>
            <strong style={{ color: 'var(--theme-text2)' }}>Nepal Labour Act:</strong> Gratuity accrues at 1 month basic salary per year of service, payable on departure after {VEST} completed months (an assumption — see the note at the top). &nbsp;
            <strong style={{ color: 'var(--theme-text2)' }}>SSF note:</strong> The employer's 20% SSF contribution includes a 3.33% gratuity sub-fund. Whether SSF fully satisfies the Labour Act obligation is a legal question — consult your CA. The <em>Net Liability</em> column shows the residual after subtracting what SSF has actually been paid. &nbsp;
            Only monthly-paid employees are shown.
          </div>
        </>
      )}
    </div>
  )
}
