import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { errorText } from '../../../shared/errorText'
import Tip from '../../../components/Tip'
import { FilterChips } from '../../../components/Tabs'
import { SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT, PAY_BASES, EMPLOYEE_STATUS_COLORS as STATUS_COLORS } from '../payrollConstants'
import { calcAmount, isSsfContributor } from '../payroll/payrollCompute'
import PayForm from './PayForm'

const fmt = nprInt
const payUnitOf = emp => (PAY_BASES.find(p => p.key === (emp.pay_basis || 'monthly')) || PAY_BASES[0]).unit

// Payroll pays active AND probation staff (every payroll picker filters on exactly these two), so
// the default tab is both. It was `status === 'active'`, which hid probation staff from the page's
// opening view and left their pay out of every headline total (S748).
const ON_PAYROLL = new Set(['active', 'probation'])
const TAB_MATCH = {
  payroll: e => ON_PAYROLL.has(e.status),
  all:     () => true,
  left:    e => !ON_PAYROLL.has(e.status),
}

export default function PaySetup() {
  const { clientId, profile, hasHrAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [employees, setEmployees]   = useState([])
  const [components, setComponents] = useState([])
  const [loading, setLoading]       = useState(true)
  const [loadError, setLoadError]   = useState('')
  const [statusFilter, setStatusFilter] = useState('payroll')
  const [editing, setEditing]       = useState(null)

  const load = useCallback(async () => {
    if (!effectiveClientId) return
    setLoading(true)
    const results = await Promise.all([
      scopedFrom('hr_employees').order('full_name'),
      // One row per component per employee, so paged: a truncated read would show allowances
      // missing with no error, on the page that totals the payroll.
      fetchAllRows(() => scopedFrom('hr_salary_components').order('id')),
    ])
    // A failed read is not "no employees" — it used to render "No employees found. Add employees
    // first" and NPR 0 totals over a staff list that exists.
    const failed = firstError(results)
    if (failed) {
      setLoadError(errorText(failed, 'operator'))
      setEmployees([]); setComponents([])
      setLoading(false)
      return
    }
    setLoadError('')
    setEmployees(results[0].data || [])
    setComponents(results[1].data || [])
    setLoading(false)
  }, [effectiveClientId, scopedFrom])

  useEffect(() => { load() }, [load])

  const filtered = employees.filter(TAB_MATCH[statusFilter] || TAB_MATCH.payroll)

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
    // Every earning through calcAmount, exactly as payroll sums them — the Dearness Allowance row is
    // only split out for display.
    const isDa       = c => c.type === 'earning' && c.name === 'Dearness Allowance'
    const dearnessAmt = comps.filter(isDa).reduce((s, c) => s + calcAmount(c, basic), 0)
    const earnings   = comps.filter(c => c.type === 'earning' && !isDa(c))
    const deductions = comps.filter(c => c.type === 'deduction')
    const otherAllowances = earnings.reduce((s, c)   => s + calcAmount(c, basic), 0)
    const totalAllowances = dearnessAmt + otherAllowances
    const totalOtherDed   = deductions.reduce((s, c) => s + calcAmount(c, basic), 0)
    // Payroll's SSF rule — the switch AND a registration number. The switch alone showed 11% coming
    // off for staff payroll deducts nothing from.
    const ssfActive = isSsfContributor(emp)
    const ssf_base  = ssfActive ? Math.min(basic, SSF_CAP) : 0
    const ssf_emp   = Math.round(ssf_base * SSF_EMPLOYEE_PCT)
    const ssf_emp_  = Math.round(ssf_base * SSF_EMPLOYER_PCT)
    const gross     = basic + totalAllowances
    const totalDed  = ssf_emp + totalOtherDed
    return { monthly: true, basic, dearnessAmt, otherAllowances, totalAllowances, ssf_emp, ssf_employer: ssf_emp_, totalOtherDed, gross, totalDed, net: gross - totalDed, ssfNoMissing: !!emp.ssf_enrolled && !ssfActive }
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
        'Net before income tax (NPR)': s.net, 'SSF Employer 20% (NPR)': s.ssf_employer,
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Pay Setup')
    XLSX.writeFile(wb, 'pay_setup.xlsx')
  }

  const tabs = [
    { key: 'payroll', label: 'On payroll', tip: 'Active and probation staff — everyone Payroll Run pays.' },
    { key: 'all',     label: 'All' },
    { key: 'left',    label: 'Not on payroll', tip: 'Inactive, resigned and terminated staff.' },
  ]
  const tabLabel = (tabs.find(t => t.key === statusFilter) || tabs[0]).label

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Pay Setup</h1>
          <p className="page-subtitle">Salary, allowances, deductions, SSF and bank per employee — click a row to edit. Daily/hourly staff are paid via payroll from attendance.</p>
        </div>
        <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>⬇ Export Excel</button>
      </div>

      {/* Stat cards — not while loading or after a failed read, where every total would be a
          confident NPR 0 (S594's rule). */}
      {!loading && !loadError && <div className="stat-grid">
        {[
          { label: 'Total Gross Payroll', value: fmt(totals.gross),        color: 'var(--theme-accent-ink)', tip: 'Gross earnings (basic + allowances) for a full month, across the monthly-paid employees on the tab you have open. Daily/hourly workers are excluded — their pay is computed at payroll.' },
          { label: 'SSF — Employee',       value: fmt(totals.ssf_emp),      color: 'var(--theme-red-text)', tip: '11% SSF on basic salary (capped at NPR 100,000 each), for employees with SSF switched on AND an SSF number — the same rule payroll uses.' },
          { label: 'SSF — Employer',       value: fmt(totals.ssf_employer), color: 'var(--theme-text2)', tip: 'The 20% SSF the company pays on top of salaries — not deducted from employee net pay.' },
          { label: 'Net before income tax', value: fmt(totals.net),         color: 'var(--theme-green-text)', tip: 'Gross − SSF employee − other deductions, for a full month. Income tax (TDS), absences, overtime, advance recovery and TADA are worked out in Payroll, so actual take-home pay differs.' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <Tip text={s.tip} width={260}>{s.label}</Tip>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {s.value}</div>
            <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 3 }}>{totals.count} monthly employee{totals.count === 1 ? '' : 's'} · {tabLabel}</div>
          </div>
        ))}
      </div>}

      {/* Status filter */}
      <FilterChips label="Filter by payroll status" active={statusFilter} onChange={setStatusFilter} style={{ marginBottom: 16 }}
        options={tabs.map(t => ({
          key: t.key, title: t.tip,
          label: <>{t.label}<span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)' }}>{employees.filter(TAB_MATCH[t.key]).length}</span></>,
        }))} />

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
        ) : loadError ? (
          <div role="alert" style={{ padding: 24, fontSize: 13, color: 'var(--theme-red-text)' }}>
            Couldn't load employees and their pay, so no figures are shown — the payroll totals are unknown, not zero. {loadError}
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>
            {employees.length === 0 ? 'No employees yet. Add them first in HR → Employees.' : 'No employees on this tab.'}
          </div>
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
                    <Tip text="SSF Employee (11% of basic, when SSF is switched on and an SSF number is entered) plus any other deductions configured for the employee." width={250}>Deductions</Tip>
                  </th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                    <Tip text="Gross − deductions for a full month, before income tax (TDS). Payroll also applies absences, overtime, advance recovery and TADA, so the payslip's take-home pay differs." width={260}>Net before tax</Tip>
                  </th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    <Tip text="20% SSF the company pays on top — not deducted from the employee's net salary." width={240}>SSF Employer</Tip>
                  </th>
                  <th>
                    <Tip text="Whether bank name + account number are on file for salary disbursement." width={240}>Bank</Tip>
                  </th>
                  <th><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(emp => {
                  const s = getSalary(emp)
                  const st = STATUS_COLORS[emp.status] || STATUS_COLORS.inactive
                  const hasBank = emp.bank_name && emp.bank_account_no
                  // The row click stays as a pointer convenience; the Edit button in the last cell
                  // is the keyboard/screen-reader path. Before S682 the <tr onClick> was the ONLY
                  // way into pay + bank details, so a keyboard user could not set pay.
                  return (
                    <tr key={emp.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(emp)}>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
                          {emp.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{emp.employee_code}</span>}
                          <span style={{ fontSize: 10, fontWeight: 700, color: st.color, background: st.bg, border: `1px solid ${st.border}`, borderRadius: 0, padding: '1px 6px' }}>{emp.status}</span>
                          {!s.monthly && (
                            <span className="badge badge-gray" style={{ fontSize: 10, fontWeight: 700 }}>per {s.unit}</span>
                          )}
                          {s.ssfNoMissing && (
                            <Tip text="SSF is switched on but there is no SSF number, so payroll deducts no SSF and charges the 1% social security tax. Enter the number under Edit → Bank / SSF." style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                              <span className="badge badge-amber" style={{ fontSize: 10 }}>⚠ SSF no. missing</span>
                            </Tip>
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
                          {/* ONE column (SSF Employer). It was colSpan 2, which made every daily/hourly
                              row a cell too wide: Bank sat under Actions and Edit under nothing. */}
                          <td style={{ color: 'var(--theme-text2)', fontSize: 11, fontStyle: 'italic' }}>from attendance</td>
                        </>
                      )}
                      <td style={{ fontSize: 12 }}>
                        {hasBank ? <span style={{ color: 'var(--theme-text3)' }}>{emp.bank_name}</span> : <span style={{ color: 'var(--theme-amber-text)' }}>⚠ not set</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="btn btn-ghost btn-sm" aria-label={`Edit pay and bank details for ${emp.full_name}`}
                          onClick={e => { e.stopPropagation(); setEditing(emp) }}>
                          Edit
                        </button>
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
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        Deductions = SSF Employee (11% of basic, capped at NPR 100,000 basic — only for staff with SSF switched on and an SSF number) + any additional deductions configured per employee. Employer SSF (20%) is paid by the company and not deducted from net salary.
        Every figure is a full month before income tax (TDS); Payroll works out tax, absences, overtime, advance recovery and TADA each month.
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
