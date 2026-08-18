import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT, PAY_BASES, EMPLOYEE_STATUS_COLORS as STATUS_COLORS } from '../payrollConstants'
import PayForm from './PayForm'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')
const payUnitOf = emp => (PAY_BASES.find(p => p.key === (emp.pay_basis || 'monthly')) || PAY_BASES[0]).unit

function calcAmount(comp, basic) {
  const v = parseFloat(comp.value) || 0
  if (comp.calc_type === 'percent_of_basic') return Math.round((parseFloat(basic) || 0) * v / 100)
  return Math.round(v)
}

export default function PaySetup() {
  const { clientId, profile, hasHrAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [employees, setEmployees]   = useState([])
  const [components, setComponents] = useState([])
  const [loading, setLoading]       = useState(true)
  const [statusFilter, setStatusFilter] = useState('active')
  const [editing, setEditing]       = useState(null)

  const load = useCallback(async () => {
    if (!effectiveClientId) return
    setLoading(true)
    const [{ data: emps }, { data: comps }] = await Promise.all([
      scopedFrom('hr_employees').order('full_name'),
      scopedFrom('hr_salary_components'),
    ])
    setEmployees(emps || [])
    setComponents(comps || [])
    setLoading(false)
  }, [effectiveClientId, scopedFrom])

  useEffect(() => { load() }, [load])

  const filtered = employees.filter(e => statusFilter === 'all' || e.status === statusFilter)

  // Per-employee computed salary.
  // Monthly: derives from basic + dearness + other allowances + deductions.
  // Daily/hourly: returns rate + an estimated monthly cost (rate × 26 days or rate × 8h × 26).
  function getSalary(emp) {
    const basis = emp.pay_basis || 'monthly'
    const basic = parseFloat(emp.basic_salary) || 0
    if (basis !== 'monthly') {
      const unit    = payUnitOf(emp)
      const estMonthly = basis === 'daily' ? basic * 26 : basic * 8 * 26
      return { monthly: false, rate: basic, unit, estMonthly }
    }
    const comps      = components.filter(c => c.employee_id === emp.id)
    const dearness   = comps.find(c => c.name === 'Dearness Allowance' && c.type === 'earning')
    const dearnessAmt = parseFloat(dearness?.value) || 0
    const earnings   = comps.filter(c => c.type === 'earning' && c.name !== 'Dearness Allowance')
    const deductions = comps.filter(c => c.type === 'deduction')
    const otherAllowances = earnings.reduce((s, c)   => s + calcAmount(c, basic), 0)
    const totalAllowances = dearnessAmt + otherAllowances
    const totalOtherDed   = deductions.reduce((s, c) => s + calcAmount(c, basic), 0)
    const ssf_base  = emp.ssf_enrolled ? Math.min(basic, SSF_CAP) : 0
    const ssf_emp   = Math.round(ssf_base * SSF_EMPLOYEE_PCT)
    const ssf_emp_  = Math.round(ssf_base * SSF_EMPLOYER_PCT)
    const gross     = basic + totalAllowances
    const totalDed  = ssf_emp + totalOtherDed
    return { monthly: true, basic, dearnessAmt, otherAllowances, totalAllowances, ssf_emp, ssf_employer: ssf_emp_, totalOtherDed, gross, totalDed, net: gross - totalDed }
  }

  // Totals — monthly employees only.
  const totals = filtered.reduce((acc, emp) => {
    const s = getSalary(emp)
    if (!s.monthly) return acc
    acc.gross += s.gross; acc.ssf_emp += s.ssf_emp; acc.ssf_employer += s.ssf_employer
    acc.deductions += s.totalDed; acc.net += s.net; acc.count += 1
    return acc
  }, { gross: 0, ssf_emp: 0, ssf_employer: 0, deductions: 0, net: 0, count: 0 })

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const rows = filtered.map(emp => {
      const s = getSalary(emp)
      const base = {
        'Employee Code': emp.employee_code || '', 'Name': emp.full_name,
        'Designation': emp.designation || '', 'Department': emp.department || '',
        'Status': emp.status, 'Pay Basis': emp.pay_basis || 'monthly',
        'Bank': emp.bank_name || '', 'Account No': emp.bank_account_no || '',
      }
      if (!s.monthly) return { ...base, [`Rate (NPR / ${s.unit})`]: s.rate, 'Note': 'Pay computed at payroll from attendance' }
      return {
        ...base,
        'Basic (NPR)': s.basic, 'Dearness Allowance (NPR)': s.dearnessAmt, 'Other Allowances (NPR)': s.otherAllowances, 'Gross (NPR)': s.gross,
        'SSF Emp 11% (NPR)': s.ssf_emp, 'Other Ded (NPR)': s.totalOtherDed, 'Total Ded (NPR)': s.totalDed,
        'Net Salary (NPR)': s.net, 'SSF Employer 20% (NPR)': s.ssf_employer,
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Pay Setup')
    XLSX.writeFile(wb, 'pay_setup.xlsx')
  }

  const tabs = [
    { key: 'active',   label: 'Active' },
    { key: 'all',      label: 'All' },
    { key: 'inactive', label: 'Inactive' },
  ]

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Pay Setup</h1>
          <p className="page-subtitle">Salary, allowances, deductions, SSF and bank per employee — click a row to edit. Daily/hourly staff are paid via payroll from attendance.</p>
        </div>
        <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>⬇ Export Excel</button>
      </div>

      {/* Stat cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        {[
          { label: 'Total Gross Payroll', value: fmt(totals.gross),        color: 'var(--theme-accent-ink)', tip: 'Sum of gross earnings (basic + allowances) across all monthly employees. Daily/hourly workers are excluded — their pay is computed at payroll.' },
          { label: 'SSF — Employee',       value: fmt(totals.ssf_emp),      color: 'var(--theme-red-text)', tip: 'Total 11% SSF deducted from employees this month, computed on basic salary (capped at NPR 100,000 each).' },
          { label: 'SSF — Employer',       value: fmt(totals.ssf_employer), color: 'var(--theme-text2)', tip: 'Total 20% SSF the company pays on top of salaries — not deducted from employee net pay.' },
          { label: 'Net Payroll',          value: fmt(totals.net),          color: 'var(--theme-green-text)', tip: 'Total take-home pay (gross − SSF employee − other deductions) across all monthly employees.' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <Tip text={s.tip} width={260}>{s.label}</Tip>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {s.value}</div>
            <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 3 }}>{totals.count} monthly employees</div>
          </div>
        ))}
      </div>

      {/* Status filter */}
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {tabs.map(t => (
          <button key={t.key} className={`tab-btn${statusFilter === t.key ? ' tab-btn--active' : ''}`} onClick={() => setStatusFilter(t.key)}>
            {t.label}
            <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.7 }}>
              {employees.filter(e => t.key === 'all' || e.status === t.key).length}
            </span>
          </button>
        ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>No employees found. Add employees first in HR → Employees.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Monthly basic salary. SSF and the 60% rule are computed on this." width={240}>Basic</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Sum of all allowances including Dearness Allowance, housing, transport, etc. — fixed or % of basic." width={260}>Allowances</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Gross earnings = basic + allowances, before any deduction." width={220}>Gross</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="SSF Employee (11% of basic) plus any other deductions configured for the employee." width={250}>Deductions</Tip>
                  </th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                    <Tip text="Take-home pay = gross − deductions. What the employee actually receives." width={230}>Net Salary</Tip>
                  </th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    <Tip text="20% SSF the company pays on top — not deducted from the employee's net salary." width={240}>SSF Employer</Tip>
                  </th>
                  <th>
                    <Tip text="Whether bank name + account number are on file for salary disbursement." width={240}>Bank</Tip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(emp => {
                  const s = getSalary(emp)
                  const st = STATUS_COLORS[emp.status] || STATUS_COLORS.inactive
                  const hasBank = emp.bank_name && emp.bank_account_no
                  return (
                    <tr key={emp.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(emp)} title="Click to edit pay & bank details">
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
                          {emp.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{emp.employee_code}</span>}
                          <span style={{ fontSize: 10, fontWeight: 700, color: st.color, background: st.bg, border: `1px solid ${st.border}`, borderRadius: 8, padding: '1px 6px' }}>{emp.status}</span>
                          {!s.monthly && (
                            <span className="badge badge-gray" style={{ fontSize: 10, fontWeight: 700 }}>per {s.unit}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                        {emp.department || '—'}{emp.designation ? <><br/><span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{emp.designation}</span></> : null}
                      </td>
                      {s.monthly ? (
                        <>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 13 }}>{fmt(s.basic)}</td>
                          <td style={{ textAlign: 'right', color: s.totalAllowances > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)', fontSize: 13 }}>{s.totalAllowances > 0 ? `+${fmt(s.totalAllowances)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontSize: 13, fontWeight: 500 }}>{fmt(s.gross)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontSize: 13 }}>−{fmt(s.totalDed)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 14, fontWeight: 700 }}>{fmt(s.net)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>{fmt(s.ssf_employer)}</td>
                        </>
                      ) : (
                        <>
                          <td colSpan={4} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                            NPR {fmt(s.rate)} / {s.unit}
                          </td>
                          <td style={{ textAlign: 'right', fontSize: 12 }}>
                            <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 600 }}>~{fmt(s.estMonthly)}</span>
                            <span style={{ color: 'var(--theme-text2)', fontSize: 10, marginLeft: 4 }}>est/mo</span>
                          </td>
                          <td colSpan={2} style={{ color: 'var(--theme-text2)', fontSize: 11, fontStyle: 'italic' }}>from attendance</td>
                        </>
                      )}
                      <td style={{ fontSize: 12 }}>
                        {hasBank ? <span style={{ color: 'var(--theme-text3)' }}>{emp.bank_name}</span> : <span style={{ color: 'var(--theme-amber-text)' }}>⚠ not set</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={2} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Total — {totals.count} monthly employees</td>
                  <td />
                  <td />
                  <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(totals.gross)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmt(totals.deductions)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 15 }}>{fmt(totals.net)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmt(totals.ssf_employer)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        Deductions = SSF Employee (11% of basic, capped at NPR 100,000 basic) + any additional deductions configured per employee. Employer SSF (20%) is paid by the company and not deducted from net salary.
        Daily/hourly workers show their rate only — their pay is computed each period from attendance in Payroll and is excluded from the monthly payroll totals above.
      </div>

      {editing && (
        <PayForm
          employee={editing}
          onSave={() => { setEditing(null); load() }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
