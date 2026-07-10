import { useState, useEffect } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { SSF_CAP } from '../payrollConstants'

const fmt  = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtD = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-NP', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

// Months of service from join_date to today.
function serviceMonths(joinDateStr) {
  if (!joinDateStr) return 0
  const j = new Date(joinDateStr + 'T00:00:00')
  if (isNaN(j)) return 0
  const today = new Date()
  return Math.max(0, (today.getFullYear() - j.getFullYear()) * 12 + (today.getMonth() - j.getMonth()))
}

// Format service duration as "X yr Y mo"
function fmtService(months) {
  const y = Math.floor(months / 12)
  const m = months % 12
  if (y === 0) return `${m} mo`
  if (m === 0) return `${y} yr`
  return `${y} yr ${m} mo`
}

// Gratuity accrual per Nepal Labour Act: 1 month basic per year of service (8.33%/yr).
// SSF employer contribution includes 3.33% of capped basic per month toward gratuity fund.
function calcGratuity(emp) {
  const basic   = parseFloat(emp.basic_salary) || 0
  const months  = serviceMonths(emp.join_date)
  const vested  = months >= 12

  // Labour Act total accrued (monthly: basic/12 × months = basic × years)
  const monthlyAccrual = basic / 12
  const totalAccrued   = monthlyAccrual * months

  // SSF gratuity portion: 3.33% of capped basic per month (employer SSF → SSF gratuity fund)
  const ssfBasic       = Math.min(basic, SSF_CAP)
  const SSF_GRATUITY_PCT = 0.0333  // share of employer SSF 20% allocated to gratuity
  const ssfMonthly     = emp.ssf_enrolled ? ssfBasic * SSF_GRATUITY_PCT : 0
  const ssfCovered     = ssfMonthly * months

  // Residual cash liability (Labour Act minus what SSF has already funded)
  const netLiability   = Math.max(0, totalAccrued - ssfCovered)

  return { basic, months, vested, monthlyAccrual, totalAccrued, ssfMonthly, ssfCovered, netLiability }
}

export default function GratuityTracker() {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [employees, setEmployees] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [filter,    setFilter]    = useState('all')   // all | vested | vesting
  const [dept,      setDept]      = useState('all')

  useEffect(() => {
    if (!clientId) return
    load()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    const { data } = await scopedFrom('hr_employees', 'id, full_name, employee_code, department, designation, join_date, basic_salary, pay_basis, ssf_enrolled, status')
      .in('status', ['active', 'probation'])
      .order('full_name')
    setEmployees(data || [])
    setLoading(false)
  }

  const rows = employees
    .filter(e => (e.pay_basis || 'monthly') === 'monthly')  // only monthly staff; daily/hourly have no fixed monthly basic
    .map(e => ({ ...e, g: calcGratuity(e) }))
    .filter(r => {
      if (filter === 'vested')  return r.g.vested
      if (filter === 'vesting') return !r.g.vested
      return true
    })
    .filter(r => dept === 'all' || r.department === dept)

  const depts = [...new Set(employees.map(e => e.department).filter(Boolean))].sort()

  const totalAccrued   = rows.reduce((a, r) => a + r.g.totalAccrued,   0)
  const totalSsf       = rows.reduce((a, r) => a + r.g.ssfCovered,     0)
  const totalNet       = rows.reduce((a, r) => a + r.g.netLiability,   0)
  const totalMonthly   = rows.reduce((a, r) => a + r.g.monthlyAccrual, 0)
  const vestedCount    = rows.filter(r => r.g.vested).length
  const nonMonthly     = employees.filter(e => (e.pay_basis || 'monthly') !== 'monthly').length

  function exportExcel() {
    const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
      'Employee':          r.full_name,
      'Code':              r.employee_code || '',
      'Department':        r.department || '',
      'Designation':       r.designation || '',
      'Join Date':         r.join_date || '',
      'Service':           fmtService(r.g.months),
      'Vested (≥1 yr)':    r.g.vested ? 'Yes' : 'No',
      'Basic (NPR)':       r.g.basic,
      'Monthly Accrual':   Math.round(r.g.monthlyAccrual),
      'Total Accrued':     Math.round(r.g.totalAccrued),
      'SSF Covered':       r.ssf_enrolled ? Math.round(r.g.ssfCovered) : 'Not enrolled',
      'Net Liability':     Math.round(r.g.netLiability),
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Gratuity Accrual')
    XLSX.writeFile(wb, `Gratuity_Accrual_${new Date().toISOString().slice(0,10)}.xlsx`)
  }

  // Re-compute filter counts without the current filter applied
  const allRows = employees.filter(e => (e.pay_basis || 'monthly') === 'monthly')
    .filter(r => dept === 'all' || r.department === dept)
    .map(e => ({ ...e, g: calcGratuity(e) }))

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Gratuity Accrual</h1>
          <p className="page-subtitle">
            Labour Act: 1 month basic per year of service ·{' '}
            <Tip text="The 12-month vesting cliff shown here is a commonly applied assumption, not something this app has confirmed in the current 2074 Act's own text — Sections 52/53 read as a defined-contribution scheme (a portable SSF balance) accruing monthly from day 1, with no explicit tenure threshold found. Other sources still cite 1-year or 5-year thresholds. Confirm with an accountant before relying on this for an actual payout, especially for anyone close to the 1-year mark." width={340}>
              Vests after 1 year (unconfirmed — verify with an accountant)
            </Tip>
          </p>
        </div>
        <div className="no-print">
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}>⬇ Export Excel</button>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>No active employees found.</div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="stat-grid" style={{ marginBottom: 20 }}>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="Total gratuity liability accrued under the Nepal Labour Act for all active monthly-paid employees. Formula: basic ÷ 12 × months of service." width={280}>Total Liability</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#f87171' }}>NPR {fmt(totalNet)}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Gross accrued: NPR {fmt(totalAccrued)}</div>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="Monthly accrual rate — how fast the total gratuity pool is growing. Sum of (basic ÷ 12) across all monthly employees." width={280}>Monthly Accrual</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a84c' }}>NPR {fmt(totalMonthly)}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Added to liability per month</div>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="Employees who have completed ≥ 1 year of service, commonly treated as eligible for gratuity payment on departure. This 1-year threshold is not confirmed in the current Labour Act 2074 text (which reads as day-1 accrual with no explicit vesting gate) — verify with an accountant before relying on it for an actual payout." width={320}>Vested Employees</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#34d399' }}>{vestedCount}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{rows.length - vestedCount} still vesting</div>
            </div>
            <div className="card" style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="Amount already funded through the SSF employer gratuity contribution (3.33% of capped basic per month). Reduces the additional cash liability for SSF-enrolled employees." width={300}>SSF Fund (est.)</Tip>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: '#60a5fa' }}>NPR {fmt(totalSsf)}</div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>3.33% employer SSF → gratuity fund</div>
            </div>
          </div>

          {nonMonthly > 0 && (
            <div className="card" style={{ marginBottom: 14, padding: '10px 16px', borderLeft: '3px solid #c9a84c', fontSize: 12, color: '#9ca3af' }}>
              ⚠ {nonMonthly} daily/hourly staff excluded — gratuity for wage workers is computed at settlement based on actual days/hours worked.
            </div>
          )}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }} className="no-print">
            <div className="tab-bar">
              {[
                { key: 'all',     label: `All (${allRows.length})` },
                { key: 'vested',  label: `Vested ≥1 yr (${allRows.filter(r => r.g.vested).length})` },
                { key: 'vesting', label: `Vesting <1 yr (${allRows.filter(r => !r.g.vested).length})` },
              ].map(f => (
                <button key={f.key} className={`tab-btn${filter === f.key ? ' tab-btn--active' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
              ))}
            </div>
            {depts.length > 0 && (
              <select className="form-select" style={{ fontSize: 12 }} value={dept} onChange={e => setDept(e.target.value)}>
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
                      <Tip text="Total months of continuous service from join date to today." width={220}>Service</Tip>
                    </th>
                    <th style={{ textAlign: 'center' }}>
                      <Tip text="Vested = ≥ 12 months of service, commonly treated as eligible for full gratuity payment on departure — this threshold is not confirmed in the current Labour Act 2074 text. Verify with an accountant." width={300}>Vested</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Basic salary ÷ 12 = amount added to the gratuity pool each month." width={240}>Monthly Accrual</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Total accrued under Nepal Labour Act: (basic ÷ 12) × months of service. Equals one month's basic per year." width={280}>Labour Act Total</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Estimated amount already funded via the SSF employer gratuity sub-fund (3.33% of capped basic per month × months). Only for SSF-enrolled employees." width={300}>SSF Covered</Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: '#f87171' }}>
                      <Tip text="Estimated additional cash liability beyond the SSF fund. Labour Act Total − SSF Covered. This is what you may need to pay in addition to SSF on departure." width={300}>Net Liability</Tip>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: '#e8e0d0', fontSize: 13 }}>{r.full_name}</div>
                        <div style={{ fontSize: 10, color: '#6b7280' }}>{r.department || ''}{r.designation ? ` · ${r.designation}` : ''}</div>
                      </td>
                      <td style={{ color: '#9ca3af', fontSize: 12 }}>{fmtD(r.join_date)}</td>
                      <td style={{ textAlign: 'center', color: '#e8e0d0' }}>{fmtService(r.g.months)}</td>
                      <td style={{ textAlign: 'center' }}>
                        {r.g.vested
                          ? <span className="badge-green">Vested</span>
                          : <span className="badge-amber">Vesting · {12 - r.g.months} mo left</span>}
                      </td>
                      <td style={{ textAlign: 'right', color: '#9ca3af' }}>{fmt(r.g.monthlyAccrual)}</td>
                      <td style={{ textAlign: 'right', color: '#e8e0d0', fontWeight: 600 }}>{fmt(r.g.totalAccrued)}</td>
                      <td style={{ textAlign: 'right', color: '#60a5fa' }}>
                        {r.ssf_enrolled ? fmt(r.g.ssfCovered) : <span style={{ color: '#4b5563', fontSize: 11 }}>Not enrolled</span>}
                      </td>
                      <td style={{ textAlign: 'right', color: '#f87171', fontWeight: 700 }}>{fmt(r.g.netLiability)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={4} style={{ color: '#6b7280' }}>Total — {rows.length} employees</td>
                    <td style={{ textAlign: 'right', color: '#9ca3af' }}>{fmt(totalMonthly)}</td>
                    <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(totalAccrued)}</td>
                    <td style={{ textAlign: 'right', color: '#60a5fa' }}>{fmt(totalSsf)}</td>
                    <td style={{ textAlign: 'right', color: '#f87171', fontSize: 15 }}>{fmt(totalNet)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.7 }}>
            <strong style={{ color: '#6b7280' }}>Nepal Labour Act:</strong> Gratuity accrues at 1 month basic salary per year of service, payable on departure after completing ≥ 1 year. &nbsp;
            <strong style={{ color: '#6b7280' }}>SSF note:</strong> The employer's 20% SSF contribution includes a 3.33% gratuity sub-fund. Whether SSF fully satisfies the Labour Act obligation is a legal question — consult your CA. The <em>Net Liability</em> column shows the residual after subtracting the SSF portion. &nbsp;
            Only monthly-paid employees are shown; daily/hourly gratuity depends on actual days worked and is computed at final settlement.
          </div>
        </>
      )}
    </div>
  )
}
