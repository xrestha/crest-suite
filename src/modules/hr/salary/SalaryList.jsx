import { useState, useEffect } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import * as XLSX from 'xlsx'
import { SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT, PAY_BASES } from '../payrollConstants'

function payUnitOf(emp) {
  return (PAY_BASES.find(p => p.key === (emp.pay_basis || 'monthly')) || PAY_BASES[0]).unit
}

const STATUS_COLORS = {
  active:     { color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.2)'  },
  probation:  { color: '#c9a84c', bg: 'rgba(201,168,76,0.1)', border: 'rgba(201,168,76,0.2)'  },
  inactive:   { color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.2)' },
  resigned:   { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' },
  terminated: { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' },
}

function fmt(n) { return Math.round(n).toLocaleString('en-NP') }

function calcAmount(comp, basic) {
  const v = parseFloat(comp.value) || 0
  if (comp.calc_type === 'percent_of_basic') return Math.round((parseFloat(basic) || 0) * v / 100)
  return Math.round(v)
}

export default function SalaryList() {
  const { clientId } = useAuth()
  const [employees,   setEmployees]   = useState([])
  const [components,  setComponents]  = useState([])
  const [loading,     setLoading]     = useState(true)
  const [statusFilter, setStatusFilter] = useState('active')

  useEffect(() => {
    if (!clientId) return
    async function load() {
      setLoading(true)
      const [{ data: emps }, { data: comps }] = await Promise.all([
        supabase.from('hr_employees').select('*').eq('client_id', clientId).order('full_name'),
        supabase.from('hr_salary_components').select('*').eq('client_id', clientId),
      ])
      setEmployees(emps || [])
      setComponents(comps || [])
      setLoading(false)
    }
    load()
  }, [clientId])

  const filtered = employees.filter(e => statusFilter === 'all' || e.status === statusFilter)

  // Per-employee computed salary. Monthly only — daily/hourly pay resolves at payroll.
  function getSalary(emp) {
    const monthly   = (emp.pay_basis || 'monthly') === 'monthly'
    const basic     = parseFloat(emp.basic_salary) || 0
    if (!monthly) return { monthly: false, rate: basic, unit: payUnitOf(emp) }
    const comps     = components.filter(c => c.employee_id === emp.id)
    const earnings  = comps.filter(c => c.type === 'earning')
    const deductions = comps.filter(c => c.type === 'deduction')
    const totalAllowances = earnings.reduce((s, c)    => s + calcAmount(c, basic), 0)
    const totalOtherDed   = deductions.reduce((s, c)  => s + calcAmount(c, basic), 0)
    const ssf_base  = Math.min(basic, SSF_CAP)
    const ssf_emp   = Math.round(ssf_base * SSF_EMPLOYEE_PCT)
    const ssf_emp_  = Math.round(ssf_base * SSF_EMPLOYER_PCT)
    const gross     = basic + totalAllowances
    const totalDed  = ssf_emp + totalOtherDed
    const net       = gross - totalDed
    return { monthly: true, basic, totalAllowances, ssf_emp, ssf_employer: ssf_emp_, totalOtherDed, gross, totalDed, net }
  }

  // Totals — monthly employees only.
  const totals = filtered.reduce((acc, emp) => {
    const s = getSalary(emp)
    if (!s.monthly) return acc
    acc.gross       += s.gross
    acc.ssf_emp     += s.ssf_emp
    acc.ssf_employer += s.ssf_employer
    acc.deductions  += s.totalDed
    acc.net         += s.net
    acc.count       += 1
    return acc
  }, { gross: 0, ssf_emp: 0, ssf_employer: 0, deductions: 0, net: 0, count: 0 })

  function exportExcel() {
    const rows = filtered.map(emp => {
      const s = getSalary(emp)
      const base = {
        'Employee Code': emp.employee_code || '',
        'Name':          emp.full_name,
        'Designation':   emp.designation || '',
        'Department':    emp.department || '',
        'Status':        emp.status,
        'Pay Basis':     emp.pay_basis || 'monthly',
      }
      if (!s.monthly) {
        return { ...base, [`Rate (NPR / ${s.unit})`]: s.rate, 'Note': 'Pay computed at payroll from attendance' }
      }
      return {
        ...base,
        'Basic (NPR)':   s.basic,
        'Allowances (NPR)': s.totalAllowances,
        'Gross (NPR)':   s.gross,
        'SSF Emp 11% (NPR)': s.ssf_emp,
        'Other Ded (NPR)':   s.totalOtherDed,
        'Total Ded (NPR)':   s.totalDed,
        'Net Salary (NPR)':  s.net,
        'SSF Employer 20% (NPR)': s.ssf_employer,
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Salary Structure')
    XLSX.writeFile(wb, 'salary_structure.xlsx')
  }

  const tabs = [
    { key: 'active',   label: 'Active' },
    { key: 'all',      label: 'All' },
    { key: 'inactive', label: 'Inactive' },
  ]

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Salary Structure</h1>
          <p className="page-subtitle">Monthly salary breakdown per employee — allowances, deductions, and net pay</p>
        </div>
        <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>⬇ Export Excel</button>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Gross Payroll', value: fmt(totals.gross),       color: '#c9a84c' },
          { label: 'SSF — Employee',      value: fmt(totals.ssf_emp),     color: '#f87171' },
          { label: 'SSF — Employer',      value: fmt(totals.ssf_employer), color: '#6b7280' },
          { label: 'Net Payroll',         value: fmt(totals.net),         color: '#34d399' },
        ].map(s => (
          <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {s.value}</div>
            <div style={{ fontSize: 10, color: '#4b5563', marginTop: 3 }}>{totals.count} monthly employees</div>
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
          <div style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>No employees found.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  <th style={{ textAlign: 'right' }}>Basic</th>
                  <th style={{ textAlign: 'right' }}>Allowances</th>
                  <th style={{ textAlign: 'right' }}>Gross</th>
                  <th style={{ textAlign: 'right' }}>
                    <span title="SSF Employee 11% + other deductions">Deductions</span>
                  </th>
                  <th style={{ textAlign: 'right', color: '#c9a84c' }}>Net Salary</th>
                  <th style={{ textAlign: 'right', color: '#6b7280' }}>SSF Employer</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(emp => {
                  const s = getSalary(emp)
                  const st = STATUS_COLORS[emp.status] || STATUS_COLORS.inactive
                  return (
                    <tr key={emp.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: '#e8e0d0', fontSize: 13 }}>{emp.full_name}</div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center' }}>
                          {emp.employee_code && <span style={{ fontSize: 10, color: '#6b7280' }}>{emp.employee_code}</span>}
                          <span style={{ fontSize: 10, fontWeight: 700, color: st.color, background: st.bg, border: `1px solid ${st.border}`, borderRadius: 8, padding: '1px 6px' }}>
                            {emp.status}
                          </span>
                          {!s.monthly && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: 8, padding: '1px 6px' }}>
                              per {s.unit}
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ color: '#6b7280', fontSize: 12 }}>
                        {emp.department || '—'}{emp.designation ? <><br/><span style={{ fontSize: 11, color: '#4b5563' }}>{emp.designation}</span></> : null}
                      </td>
                      {s.monthly ? (
                        <>
                          <td style={{ textAlign: 'right', color: '#9ca3af', fontSize: 13 }}>{fmt(s.basic)}</td>
                          <td style={{ textAlign: 'right', color: s.totalAllowances > 0 ? '#34d399' : '#4b5563', fontSize: 13 }}>
                            {s.totalAllowances > 0 ? `+${fmt(s.totalAllowances)}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', color: '#e8e0d0', fontSize: 13, fontWeight: 500 }}>{fmt(s.gross)}</td>
                          <td style={{ textAlign: 'right', color: '#f87171', fontSize: 13 }}>−{fmt(s.totalDed)}</td>
                          <td style={{ textAlign: 'right', color: '#c9a84c', fontSize: 14, fontWeight: 700 }}>{fmt(s.net)}</td>
                          <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 12 }}>{fmt(s.ssf_employer)}</td>
                        </>
                      ) : (
                        <td colSpan={6} style={{ textAlign: 'right', color: '#6b7280', fontSize: 12, fontStyle: 'italic' }}>
                          NPR {fmt(s.rate)} / {s.unit} · paid via payroll from attendance
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                  <td colSpan={2} style={{ color: '#6b7280', fontSize: 12 }}>Total — {totals.count} monthly employees</td>
                  <td />
                  <td />
                  <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(totals.gross)}</td>
                  <td style={{ textAlign: 'right', color: '#f87171' }}>−{fmt(totals.deductions)}</td>
                  <td style={{ textAlign: 'right', color: '#c9a84c', fontSize: 15 }}>{fmt(totals.net)}</td>
                  <td style={{ textAlign: 'right', color: '#6b7280' }}>{fmt(totals.ssf_employer)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.6 }}>
        Deductions = SSF Employee (11% of basic, capped at NPR 100,000 basic) + any additional deductions configured per employee. Employer SSF (20%) is paid by the company and not deducted from net salary.
        Daily/hourly workers show their rate only — their pay is computed each period from attendance in Payroll (coming soon) and is excluded from the monthly payroll totals above.
      </div>
    </div>
  )
}
