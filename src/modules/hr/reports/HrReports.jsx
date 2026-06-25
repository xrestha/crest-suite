import { useState, useEffect } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { fiscalYearOf } from '../payroll/tds'
import { SSF_CAP } from '../payrollConstants'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

const RETIRE_SOON_DAYS = 180
// Retirement status from a retirement_date (AD): retired (past) / soon (≤180d) / null.
function retireInfo(dateStr) {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0)
  const days = Math.round((d - today) / 86400000)
  if (days < 0)               return { retired: true, label: 'Retired',       color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' }
  if (days <= RETIRE_SOON_DAYS) return { soon: true,  label: 'Retiring soon', color: '#c9a84c', bg: 'rgba(201,168,76,0.1)', border: 'rgba(201,168,76,0.2)' }
  return null
}

export default function HrReports() {
  const { clientId } = useAuth()
  const [periods,   setPeriods]   = useState([])
  const [period,    setPeriod]    = useState(null)
  const [run,       setRun]       = useState(null)
  const [payslips,  setPayslips]  = useState([])
  const [employees, setEmployees] = useState([])
  const [ytdTds,    setYtdTds]    = useState({})   // employee_id -> YTD tds (incl this period)
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState('summary')
  const [rosterRetiringOnly, setRosterRetiringOnly] = useState(false)

  const empMap = Object.fromEntries(employees.map(e => [e.id, e]))
  const nameById = Object.fromEntries(employees.map(e => [e.id, e.full_name]))

  useEffect(() => {
    if (!clientId) return
    async function init() {
      setLoading(true)
      const { data: p } = await supabase.from('monthly_periods').select('*').eq('client_id', clientId)
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      setPeriods(p || [])
      // Employee master loads independently of any payroll run (powers the Roster tab).
      const { data: emps } = await supabase.from('hr_employees')
        .select('id, full_name, employee_code, department, designation, employment_type, supervisor_id, retirement_date, join_date, pay_basis, bank_name, bank_account_no, bank_branch, ssf_no, pan_no, status')
        .eq('client_id', clientId).order('full_name')
      setEmployees(emps || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      if (open) { setPeriod(open); await loadAll(open.id, open) }
      setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll(periodId, p) {
    const { data: runRow } = await supabase.from('hr_payroll_runs').select('*').eq('client_id', clientId).eq('period_id', periodId).maybeSingle()
    setRun(runRow || null)
    if (runRow) {
      const { data: slips } = await supabase.from('hr_payslips').select('*').eq('run_id', runRow.id)
      setPayslips(slips || [])
    } else {
      setPayslips([])
    }
    await loadYtd(p)
  }

  // YTD TDS per employee: sum tds from finalized payslips in the same fiscal year, up to this period.
  async function loadYtd(p) {
    if (!p) { setYtdTds({}); return }
    const cur = fiscalYearOf(p.bs_year, p.bs_month)
    const { data } = await supabase.from('hr_payslips')
      .select('employee_id, tds, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
      .eq('client_id', clientId).eq('hr_payroll_runs.status', 'finalized')
    const map = {}
    ;(data || []).forEach(r => {
      if (r.hr_payroll_runs?.status !== 'finalized') return
      const mp = r.hr_payroll_runs?.monthly_periods
      if (!mp) return
      const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
      if (fy.fyStart !== cur.fyStart || fy.monthInFy > cur.monthInFy) return
      map[r.employee_id] = (map[r.employee_id] || 0) + (r.tds || 0)
    })
    setYtdTds(map)
  }

  async function handlePeriodChange(id) {
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setLoading(true)
    await loadAll(id, p); setLoading(false)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'
  const fileLabel = period ? `${BS_MONTHS[period.bs_month - 1]}-${period.bs_year}` : ''
  const finalized = run?.status === 'finalized'

  // ── Derived rows ────────────────────────────────────────────────────────────
  const rows = payslips.map(s => ({ s, emp: empMap[s.employee_id] || {} }))
  const ssfRows = rows.filter(({ emp }) => emp.ssf_no && String(emp.ssf_no).trim())
  const noSsfCount = rows.length - ssfRows.length

  function downloadSheet(data, sheet, ext = 'xlsx') {
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, sheet)
    XLSX.writeFile(wb, `${sheet.replace(/\s+/g, '_').toLowerCase()}_${fileLabel}.${ext}`, ext === 'csv' ? { bookType: 'csv' } : undefined)
  }

  // Summary totals
  const tot = rows.reduce((a, { s }) => {
    a.gross += s.gross + s.ot_amount
    a.ded   += s.absence_deduction + s.ssf_employee + s.other_deductions + s.tds
    a.net   += s.net_pay
    a.empCost += s.gross + s.ot_amount + s.ssf_employer
    return a
  }, { gross: 0, ded: 0, net: 0, empCost: 0 })

  // Department breakdown
  const deptMap = {}
  rows.forEach(({ s, emp }) => {
    const d = emp.department || '—'
    const e = deptMap[d] || { dept: d, count: 0, gross: 0, ded: 0, net: 0 }
    e.count += 1; e.gross += s.gross + s.ot_amount
    e.ded += s.absence_deduction + s.ssf_employee + s.other_deductions + s.tds
    e.net += s.net_pay
    deptMap[d] = e
  })
  const depts = Object.values(deptMap).sort((a, b) => b.net - a.net)

  const ssfTotals = ssfRows.reduce((a, { s }) => {
    const base = Math.min(s.basic, SSF_CAP)
    a.base += base; a.emp += s.ssf_employee; a.empr += s.ssf_employer; a.total += s.ssf_employee + s.ssf_employer
    return a
  }, { base: 0, emp: 0, empr: 0, total: 0 })

  const TABS = [
    { id: 'roster',   label: 'Roster' },
    { id: 'summary',  label: 'Payroll Summary' },
    { id: 'ssf',      label: 'SSF Challan' },
    { id: 'bank',     label: 'Bank Transfer' },
    { id: 'tds',      label: 'TDS Report' },
  ]

  // Roster = employee master directory (independent of any payroll run).
  const rosterRows = (rosterRetiringOnly
    ? employees.filter(e => !!retireInfo(e.retirement_date))
    : employees)
  const retiringCount = employees.filter(e =>
    (e.status === 'active' || e.status === 'probation') && retireInfo(e.retirement_date)?.soon).length

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">HR Reports</h1>
          <p className="page-subtitle">
            Payroll filing & disbursement — {periodLabel}
            {run && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: finalized ? '#34d399' : '#c9a84c', background: finalized ? 'rgba(52,211,153,0.1)' : 'rgba(201,168,76,0.1)', border: `1px solid ${finalized ? 'rgba(52,211,153,0.2)' : 'rgba(201,168,76,0.2)'}`, padding: '2px 8px', borderRadius: 10 }}>{finalized ? 'Finalized' : 'Draft'}</span>}
          </p>
        </div>
        <select className="form-select no-print" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
          {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
      ) : (
        <>
          <div className="tab-bar no-print" style={{ marginBottom: 18 }}>
            {TABS.map(t => (
              <button key={t.id} className={`tab-btn${tab === t.id ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>

          {/* ── ROSTER (employee master — independent of payroll run) ── */}
          {tab === 'roster' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #2a2f3d', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>Employee Roster</span>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                    {employees.length} employee{employees.length !== 1 ? 's' : ''}
                    {retiringCount > 0 && <span> · <span style={{ color: '#c9a84c' }}>{retiringCount} retiring within 180 days</span></span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="no-print">
                  <button className={`tab-btn${rosterRetiringOnly ? ' tab-btn--active' : ''}`} onClick={() => setRosterRetiringOnly(v => !v)}>Retiring soon</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                    rosterRows.map(e => ({
                      Code: e.employee_code || '', Name: e.full_name, Department: e.department || '', Designation: e.designation || '',
                      Supervisor: e.supervisor_id ? (nameById[e.supervisor_id] || '') : '',
                      'Join Date': fmtDate(e.join_date), 'Retirement Date': e.retirement_date ? fmtDate(e.retirement_date) : '', Status: e.status,
                    })), 'Roster')}>⬇ Export</button>
                </div>
              </div>
              {rosterRows.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No employees{rosterRetiringOnly ? ' retiring soon' : ''}.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Designation</th><th>Supervisor</th><th>Join Date</th><th>Retirement</th><th style={{ textAlign: 'center' }}>Status</th></tr></thead>
                    <tbody>
                      {rosterRows.map(e => {
                        const r = retireInfo(e.retirement_date)
                        return (
                          <tr key={e.id}>
                            <td style={{ color: '#c9a84c', fontWeight: 700, fontSize: 12 }}>{e.employee_code || '—'}</td>
                            <td style={{ color: '#e8e0d0', fontWeight: 600 }}>{e.full_name}</td>
                            <td style={{ color: '#9ca3af' }}>{e.department || '—'}</td>
                            <td style={{ color: '#9ca3af' }}>{e.designation || '—'}</td>
                            <td style={{ color: '#9ca3af', fontSize: 12 }}>{e.supervisor_id ? (nameById[e.supervisor_id] || '—') : '—'}</td>
                            <td style={{ color: '#6b7280', fontSize: 12 }}>{fmtDate(e.join_date)}</td>
                            <td style={{ fontSize: 12 }}>
                              {e.retirement_date ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ color: '#6b7280' }}>{fmtDate(e.retirement_date)}</span>
                                  {r && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, color: r.color, background: r.bg, border: `1px solid ${r.border}` }}>{r.label}</span>}
                                </span>
                              ) : <span style={{ color: '#4b5563' }}>—</span>}
                            </td>
                            <td style={{ textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>{e.status.charAt(0).toUpperCase() + e.status.slice(1)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {tab !== 'roster' && (!run ? (
            <div className="card" style={{ padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>📊</div>
              <div style={{ fontSize: 14, color: '#e8e0d0', marginBottom: 6 }}>No payroll run for {periodLabel}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Generate and finalize payroll in HR → Payroll first, then its reports appear here.</div>
            </div>
          ) : (
            <>
              {!finalized && (
                <div className="no-print" style={{ marginBottom: 14, padding: '10px 14px', background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.25)', borderRadius: 8, fontSize: 12, color: '#c9a84c' }}>
                  ⚠ This payroll is still a draft — figures may change. Finalize it in Payroll before filing or paying.
                </div>
              )}

          {/* ── SUMMARY ── */}
          {tab === 'summary' && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
                {[
                  { label: 'Total Gross',    value: tot.gross,   color: '#c9a84c', tip: 'Gross earnings + overtime across all payslips.' },
                  { label: 'Total Deductions', value: tot.ded,   color: '#f87171', tip: 'Absence + SSF employee + other deductions + TDS.' },
                  { label: 'Net Payable',    value: tot.net,     color: '#34d399', tip: 'Total take-home pay to disburse.' },
                  { label: 'Employer Cost',  value: tot.empCost, color: '#9ca3af', tip: 'What the business spends: gross + overtime + employer SSF (20%).' },
                ].map(s => (
                  <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      <Tip text={s.tip} width={250}>{s.label}</Tip>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {fmt(s.value)}</div>
                  </div>
                ))}
              </div>

              <div className="card" style={{ padding: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #2a2f3d' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>By Department</span>
                  <button className="btn btn-ghost no-print" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                    depts.map(d => ({ Department: d.dept, Headcount: d.count, 'Gross (NPR)': Math.round(d.gross), 'Deductions (NPR)': Math.round(d.ded), 'Net (NPR)': Math.round(d.net) })),
                    'Payroll Summary')}>⬇ Export</button>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Department</th><th style={{ textAlign: 'right' }}>Headcount</th><th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Deductions</th><th style={{ textAlign: 'right', color: '#c9a84c' }}>Net</th></tr></thead>
                    <tbody>
                      {depts.map(d => (
                        <tr key={d.dept}>
                          <td style={{ color: '#e8e0d0' }}>{d.dept}</td>
                          <td style={{ textAlign: 'right', color: '#9ca3af' }}>{d.count}</td>
                          <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(d.gross)}</td>
                          <td style={{ textAlign: 'right', color: '#f87171' }}>−{fmt(d.ded)}</td>
                          <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 600 }}>{fmt(d.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                      <td style={{ color: '#6b7280' }}>Total</td>
                      <td style={{ textAlign: 'right', color: '#9ca3af' }}>{rows.length}</td>
                      <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(tot.gross)}</td>
                      <td style={{ textAlign: 'right', color: '#f87171' }}>−{fmt(tot.ded)}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c' }}>{fmt(tot.net)}</td>
                    </tr></tfoot>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── SSF CHALLAN ── */}
          {tab === 'ssf' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #2a2f3d' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>SSF Challan — {periodLabel}</span>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                    Total to deposit: <strong style={{ color: '#c9a84c' }}>NPR {fmt(ssfTotals.total)}</strong>
                    {noSsfCount > 0 && <span> · {noSsfCount} employee{noSsfCount > 1 ? 's' : ''} without an SSF number excluded</span>}
                  </div>
                </div>
                <button className="btn btn-ghost no-print" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                  ssfRows.map(({ s, emp }) => ({ 'SSF No': emp.ssf_no, Employee: emp.full_name, 'SSF Basic': Math.round(Math.min(s.basic, SSF_CAP)), 'Employee 11%': s.ssf_employee, 'Employer 20%': s.ssf_employer, 'Total 31%': s.ssf_employee + s.ssf_employer })),
                  'SSF Challan')}>⬇ Export</button>
              </div>
              {ssfRows.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No SSF-enrolled employees in this run.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>SSF No</th><th>Employee</th><th style={{ textAlign: 'right' }}><Tip text="Basic salary capped at NPR 100,000 — the SSF contribution base." width={240}>SSF Basic</Tip></th><th style={{ textAlign: 'right' }}>Employee 11%</th><th style={{ textAlign: 'right' }}>Employer 20%</th><th style={{ textAlign: 'right', color: '#c9a84c' }}>Total 31%</th></tr></thead>
                    <tbody>
                      {ssfRows.map(({ s, emp }) => (
                        <tr key={s.id}>
                          <td style={{ color: '#9ca3af', fontSize: 12 }}>{emp.ssf_no}</td>
                          <td style={{ color: '#e8e0d0', fontWeight: 600 }}>{emp.full_name}</td>
                          <td style={{ textAlign: 'right', color: '#9ca3af' }}>{fmt(Math.min(s.basic, SSF_CAP))}</td>
                          <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(s.ssf_employee)}</td>
                          <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(s.ssf_employer)}</td>
                          <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 600 }}>{fmt(s.ssf_employee + s.ssf_employer)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                      <td colSpan={2} style={{ color: '#6b7280' }}>Total — {ssfRows.length}</td>
                      <td style={{ textAlign: 'right', color: '#9ca3af' }}>{fmt(ssfTotals.base)}</td>
                      <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(ssfTotals.emp)}</td>
                      <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(ssfTotals.empr)}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c' }}>{fmt(ssfTotals.total)}</td>
                    </tr></tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── BANK TRANSFER ── */}
          {tab === 'bank' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #2a2f3d' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>Salary Disbursement — {periodLabel}</span>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Total: <strong style={{ color: '#34d399' }}>NPR {fmt(tot.net)}</strong></div>
                </div>
                <div style={{ display: 'flex', gap: 8 }} className="no-print">
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => downloadSheet(bankData(), 'Bank Transfer')}>⬇ Excel</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => downloadSheet(bankData(), 'Bank Transfer', 'csv')}>⬇ CSV</button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Employee</th><th>Bank</th><th>Account No</th><th style={{ textAlign: 'right', color: '#34d399' }}>Net Pay</th></tr></thead>
                  <tbody>
                    {rows.map(({ s, emp }) => {
                      const missing = !emp.bank_name || !emp.bank_account_no
                      return (
                        <tr key={s.id}>
                          <td style={{ color: '#e8e0d0', fontWeight: 600 }}>{emp.full_name}</td>
                          <td style={{ color: missing ? '#c9a84c' : '#9ca3af' }}>{emp.bank_name || '⚠ missing'}</td>
                          <td style={{ color: missing ? '#c9a84c' : '#9ca3af' }}>{emp.bank_account_no || '⚠ missing'}</td>
                          <td style={{ textAlign: 'right', color: '#34d399', fontWeight: 600 }}>{fmt(s.net_pay)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={3} style={{ color: '#6b7280' }}>Total — {rows.length}</td>
                    <td style={{ textAlign: 'right', color: '#34d399' }}>{fmt(tot.net)}</td>
                  </tr></tfoot>
                </table>
              </div>
            </div>
          )}

          {/* ── TDS ── */}
          {tab === 'tds' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #2a2f3d' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>TDS / Income Tax — {periodLabel}</span>
                <button className="btn btn-ghost no-print" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                  rows.map(({ s, emp }) => ({ Employee: emp.full_name, PAN: emp.pan_no || '', 'Taxable (period)': Math.round(s.gross + s.ot_amount - s.ssf_employee), 'TDS (period)': s.tds, 'TDS YTD': ytdTds[s.employee_id] || s.tds })),
                  'TDS Report')}>⬇ Export</button>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Employee</th><th>PAN</th><th style={{ textAlign: 'right' }}><Tip text="Taxable pay this period = gross + overtime − SSF employee contribution." width={250}>Taxable</Tip></th><th style={{ textAlign: 'right' }}>TDS (period)</th><th style={{ textAlign: 'right' }}><Tip text="Total income tax withheld so far this fiscal year (finalized months)." width={250}>TDS YTD</Tip></th></tr></thead>
                  <tbody>
                    {rows.map(({ s, emp }) => (
                      <tr key={s.id}>
                        <td style={{ color: '#e8e0d0', fontWeight: 600 }}>{emp.full_name}</td>
                        <td style={{ color: '#9ca3af', fontSize: 12 }}>{emp.pan_no || '—'}</td>
                        <td style={{ textAlign: 'right', color: '#9ca3af' }}>{fmt(s.gross + s.ot_amount - s.ssf_employee)}</td>
                        <td style={{ textAlign: 'right', color: s.tds > 0 ? '#f87171' : '#4b5563' }}>{s.tds > 0 ? fmt(s.tds) : '—'}</td>
                        <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(ytdTds[s.employee_id] || s.tds)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={3} style={{ color: '#6b7280' }}>Total — {rows.length}</td>
                    <td style={{ textAlign: 'right', color: '#f87171' }}>{fmt(rows.reduce((a, { s }) => a + s.tds, 0))}</td>
                    <td style={{ textAlign: 'right', color: '#e8e0d0' }}>{fmt(rows.reduce((a, { s }) => a + (ytdTds[s.employee_id] || s.tds), 0))}</td>
                  </tr></tfoot>
                </table>
              </div>
            </div>
          )}
            </>
          ))}
        </>
      )}
    </div>
  )

  function bankData() {
    return rows.map(({ s, emp }) => ({ Name: emp.full_name, Bank: emp.bank_name || '', 'Account No': emp.bank_account_no || '', Amount: s.net_pay }))
  }
}
