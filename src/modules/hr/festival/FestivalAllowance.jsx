import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { bsToAd, getBsToday } from '../../../utils/bsCalendar'
import { computeBonusTds, fiscalYearOf } from '../payroll/tds'

const LIFE_INS_CAP    = 40000
const HEALTH_INS_CAP  = 20000
const SSF_CAP_MONTHLY = 100000
const SSF_EMP_PCT     = 0.11
const RETIREMENT_CAP  = 500000

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6,
  padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', fontFamily: 'inherit',
}

function monthsBetween(joinDateStr, ref) {
  if (!joinDateStr) return 12
  const j = new Date(joinDateStr)
  if (isNaN(j)) return 12
  const m = (ref.getFullYear() - j.getFullYear()) * 12 + (ref.getMonth() - j.getMonth())
  return Math.max(0, Math.min(12, m))
}

// Festival TDS using actual YTD payslip data for accurate marginal rate.
// ytd = { gross, ssf, months } from finalized payslips in this FY so far.
// Falls back to salary projection if no payslips exist.
function calcFestivalTds({ emp, amount, ytd, fyStart }) {
  if (!amount) return 0
  const basic           = parseFloat(emp.basic_salary) || 0
  const ytdGross        = ytd?.gross  || 0
  const ytdSsf          = ytd?.ssf    || 0
  const ytdMonths       = ytd?.months || 0
  const remaining       = Math.max(0, 12 - ytdMonths)

  const projGross  = ytdGross + basic * remaining
  const projSsf    = ytdSsf   + (emp.ssf_enrolled ? Math.min(basic, SSF_CAP_MONTHLY) * SSF_EMP_PCT * remaining : 0)
  const ssfDed     = Math.min(projSsf, Math.min(RETIREMENT_CAP, projGross / 3))
  const lifeIns    = Math.min(parseFloat(emp.life_insurance_premium)   || 0, LIFE_INS_CAP)
  const healthIns  = Math.min(parseFloat(emp.health_insurance_premium) || 0, HEALTH_INS_CAP)
  const taxable    = Math.max(0, projGross - ssfDed - lifeIns - healthIns)

  return computeBonusTds({
    annualTaxable: taxable, bonusAmount: amount,
    isSsf: !!emp.ssf_enrolled, isMarried: emp.marital_status === 'married', fyStart,
  })
}

export default function FestivalAllowance() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedUpsert, scopedUpdate } = useScopedDb()
  const today = getBsToday()
  const [bsYear,    setBsYear]    = useState(today.year)
  const [festival,  setFestival]  = useState('Dashain')
  const [rows,      setRows]      = useState([])
  const [employees, setEmployees] = useState([])
  const [ytdMap,    setYtdMap]    = useState({})  // employee_id → { gross, ssf, months }
  const [loading,   setLoading]   = useState(true)
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState('')

  const empMap    = Object.fromEntries(employees.map(e => [e.id, e]))
  const years     = Array.from({ length: 6 }, (_, i) => today.year - 3 + i)
  const finalized = rows.length > 0 && rows.every(r => r.status === 'finalized')
  const { fyStart } = fiscalYearOf(bsYear, 6)   // Ashwin ≈ Dashain month
  const hasYtd    = Object.keys(ytdMap).length > 0

  useEffect(() => {
    if (!clientId) return
    load()
  }, [clientId, bsYear, festival]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true); setMsg('')
    const [{ data: emps }, { data: fa }, { data: psData }] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, department, pay_basis, basic_salary, join_date, bank_name, bank_account_no, status, marital_status, ssf_enrolled, life_insurance_premium, health_insurance_premium')
        .in('status', ['active', 'probation']).order('full_name'),
      scopedFrom('hr_festival_allowances')
        .eq('bs_year', bsYear).eq('festival_name', festival),
      scopedFrom('hr_payslips', 'employee_id, gross, ssf_employee, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
        .eq('hr_payroll_runs.status', 'finalized'),
    ])
    setEmployees(emps || [])
    setRows(fa || [])

    // Build YTD: sum finalized payslip gross+SSF in this FY
    const ytd = {}
    ;(psData || []).forEach(r => {
      const mp = r.hr_payroll_runs?.monthly_periods
      if (!mp) return
      const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
      if (fy.fyStart !== fyStart) return
      const e = ytd[r.employee_id] || { gross: 0, ssf: 0, months: 0 }
      e.gross  += r.gross || 0
      e.ssf    += r.ssf_employee || 0
      e.months += 1
      ytd[r.employee_id] = e
    })
    setYtdMap(ytd)
    setLoading(false)
  }

  function buildRows() {
    const ref = bsToAd(bsYear, 6, 15)
    return employees.map(emp => {
      const basis  = emp.pay_basis || 'monthly'
      const basic  = parseFloat(emp.basic_salary) || 0
      const mw     = monthsBetween(emp.join_date, ref)
      const amount = basis === 'monthly' ? Math.round(basic * mw / 12) : 0
      const tds    = calcFestivalTds({ emp, amount, ytd: ytdMap[emp.id], fyStart })
      return {
        employee_id: emp.id, bs_year: bsYear, festival_name: festival,
        pay_basis: basis, basic, months_worked: mw, amount, tds, status: 'draft',
      }
    })
  }

  async function generate() {
    if (!clientId) { setMsg('error:No client selected'); return }
    if (employees.length === 0) return
    setBusy(true); setMsg('')
    const { error } = await scopedUpsert('hr_festival_allowances', buildRows(), { onConflict: 'client_id,employee_id,bs_year,festival_name' })
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); setMsg('ok:Generated'); setBusy(false)
  }

  async function regenerate() {
    if (!clientId) { setMsg('error:No client selected'); return }
    if (finalized) return
    if (!window.confirm('Recompute all festival amounts from current salaries? Manual edits will be reset.')) return
    setBusy(true); setMsg('')
    const { error } = await scopedUpsert('hr_festival_allowances', buildRows(), { onConflict: 'client_id,employee_id,bs_year,festival_name' })
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); setMsg('ok:Recomputed'); setBusy(false)
  }

  async function updateAmount(row, value) {
    if (finalized) return
    const amount = parseFloat(value) || 0
    const emp    = empMap[row.employee_id] || {}
    const tds    = calcFestivalTds({ emp, amount, ytd: ytdMap[row.employee_id], fyStart })
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, amount, tds } : r))
    await scopedUpdate('hr_festival_allowances', { amount, tds }).eq('id', row.id)
  }

  async function updateTds(row, value) {
    if (finalized) return
    const tds = parseFloat(value) || 0
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, tds } : r))
    await scopedUpdate('hr_festival_allowances', { tds }).eq('id', row.id)
  }

  async function updateNote(row, value) {
    if (finalized) return
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, note: value } : r))
    await scopedUpdate('hr_festival_allowances', { note: value || null }).eq('id', row.id)
  }

  async function setStatus(status) {
    const verb = status === 'finalized' ? 'Finalize' : 'Reopen'
    if (!window.confirm(`${verb} this festival allowance?`)) return
    setBusy(true)
    await scopedUpdate('hr_festival_allowances', { status })
      .eq('bs_year', bsYear).eq('festival_name', festival)
    await load(); setMsg(`ok:${verb}d`); setBusy(false)
  }

  const total    = rows.reduce((a, r) => a + (r.amount || 0), 0)
  const totalTds = rows.reduce((a, r) => a + (r.tds    || 0), 0)

  async function exportSheet(data, name, ext = 'xlsx') {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, name)
    XLSX.writeFile(wb, `${name.replace(/\s+/g, '_').toLowerCase()}_${festival}_${bsYear}.${ext}`, ext === 'csv' ? { bookType: 'csv' } : undefined)
  }
  function exportRegister() {
    exportSheet(rows.map(r => {
      const e = empMap[r.employee_id] || {}
      return {
        Employee: e.full_name || '', Code: e.employee_code || '', 'Pay Basis': r.pay_basis,
        Basic: r.basic, 'Months Worked': r.months_worked,
        'Gross Amount': r.amount, 'TDS Withheld': r.tds || 0,
        'Net Amount': (r.amount || 0) - (r.tds || 0),
      }
    }), 'Festival Allowance')
  }
  function exportBank(ext) {
    exportSheet(rows.map(r => {
      const e = empMap[r.employee_id] || {}
      return {
        Name: e.full_name || '', Bank: e.bank_name || '', 'Account No': e.bank_account_no || '',
        Gross: r.amount, 'TDS': r.tds || 0, 'Net Transfer': (r.amount || 0) - (r.tds || 0),
      }
    }), 'Festival Bank Transfer', ext)
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Festival Allowance</h1>
          <p className="page-subtitle">
            Annual festival bonus (Dashain / पर्व खर्च) — {festival} {bsYear}
            {rows.length > 0 && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: finalized ? 'var(--theme-green-text)' : 'var(--theme-accent-ink)', background: `color-mix(in srgb, ${finalized ? 'var(--theme-green)' : 'var(--theme-accent)'} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${finalized ? 'var(--theme-green)' : 'var(--theme-accent)'} 20%, transparent)`, padding: '2px 8px', borderRadius: 10 }}>
                {finalized ? 'Finalized' : 'Draft'}
              </span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} className="no-print">
          <input aria-label="Festival name" style={{ ...inp, width: 130 }} value={festival} onChange={e => setFestival(e.target.value)} placeholder="Festival name" />
          <select className="form-select" aria-label="BS year" value={bsYear} onChange={e => setBsYear(parseInt(e.target.value, 10))}>
            {years.map(y => <option key={y} value={y}>BS {y}</option>)}
          </select>
          {msg && <span role="status" style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)', marginLeft: 'auto' }}>{msg.split(':').slice(1).join(':')}</span>}
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>No active employees. Add employees in HR → Employees first.</div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>🎉</div>
          <div style={{ fontSize: 14, color: 'var(--theme-text1)', marginBottom: 6 }}>No {festival} allowance for BS {bsYear} yet</div>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 18 }}>Computes one month's basic per employee, pro-rated by months worked. Daily/hourly staff start at 0 — enter their amounts manually.</div>
          <button className="btn btn-primary" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate Allowance'}</button>
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="stat-grid">
            {[
              { label: 'Gross Payout',  value: fmt(total),                              color: 'var(--theme-accent-ink)', tip: 'Total gross festival bonus before TDS withholding.' },
              { label: 'TDS Withheld',  value: fmt(totalTds),                            color: 'var(--theme-red-text)', ytd: true, tip: hasYtd ? 'Income tax (TDS) withheld from festival bonuses. Computed at each employee\'s marginal rate using actual YTD payroll data from this fiscal year.' : 'Income tax (TDS) withheld. Based on projected annual salary — finalize earlier payroll months for YTD-accurate figures.' },
              { label: 'Net Payout',    value: fmt(total - totalTds),                   color: 'var(--theme-green-text)', tip: 'Amount to disburse to employees after TDS deduction.' },
              { label: 'Employees',     value: rows.length,                             color: 'var(--theme-text1)', tip: 'Active and probation employees included in this festival run.' },
              { label: 'Average Gross', value: fmt(rows.length ? total / rows.length : 0), color: 'var(--theme-text3)', tip: 'Average gross bonus per employee (total ÷ headcount).' },
            ].map(s => (
              <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <Tip text={s.tip} width={260}>{s.label}</Tip>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>
                  {s.label === 'Employees' ? s.value : `NPR ${s.value}`}
                </div>
                {s.ytd && hasYtd && (
                  <div style={{ fontSize: 10, color: 'var(--theme-green-text)', marginTop: 2 }}>YTD-based</div>
                )}
              </div>
            ))}
          </div>

          {/* Action bar */}
          <div className="card no-print" style={{ marginBottom: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportRegister}>⬇ Register</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => exportBank('xlsx')}>⬇ Bank Excel</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => exportBank('csv')}>⬇ Bank CSV</button>
            {!finalized && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={regenerate} disabled={busy}>↻ Regenerate</button>}
            {!finalized && <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setStatus('finalized')} disabled={busy}>Finalize</button>}
            {/* hasHrAccess('manager'), not isAdmin: `isAdmin` is the Crest platform operator, while
                the tenant's own Owner is `isOwner` — both resolve hrRole to 'manager'. Gating this on
                isAdmin made a client contact support to reopen their own finalized run. */}
            {finalized && hasHrAccess('manager') && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setStatus('draft')} disabled={busy}>Reopen</button>}
          </div>

          {/* Table */}
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Monthly basic salary, or the daily/hourly rate for wage staff (snapshot at generation)." width={250}>Basic / Rate</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Full months worked toward this festival (capped at 12). Allowance = basic × months ÷ 12 for monthly staff." width={280}>Months</Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                      <Tip text="Festival bonus. Editable while draft; daily/hourly default to 0 — enter manually." width={250}>Gross</Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>
                      <Tip text={hasYtd ? 'TDS to withhold from this bonus. Computed at the employee\'s marginal income tax rate using actual YTD payroll data from this fiscal year. Editable while draft.' : 'TDS to withhold from this bonus. Computed at the marginal rate based on projected annual salary. Finalize earlier payroll months for YTD-accurate figures. Editable while draft.'} width={300}>
                        TDS {hasYtd && <span style={{ fontSize: 9, color: 'var(--theme-green-text)', fontWeight: 400, marginLeft: 3 }}>YTD</span>}
                      </Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>
                      <Tip text="Net amount to disburse (gross − TDS). This is the bank transfer amount." width={240}>Net</Tip>
                    </th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const e          = empMap[r.employee_id] || {}
                    const isMonthly  = r.pay_basis === 'monthly'
                    const missingBank = !e.bank_name || !e.bank_account_no
                    const net        = (r.amount || 0) - (r.tds || 0)
                    return (
                      <tr key={r.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{e.full_name || '—'}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                            {e.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{e.employee_code}</span>}
                            {!isMonthly && <span className="badge badge-gray" style={{ fontSize: 10, fontWeight: 700 }}>{r.pay_basis}</span>}
                            {missingBank && <span style={{ fontSize: 10, color: 'var(--theme-amber-text)' }}>⚠ no bank</span>}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(r.basic)}</td>
                        <td style={{ textAlign: 'right', color: r.months_worked < 12 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>{r.months_worked}</td>
                        <td style={{ textAlign: 'right' }}>
                          {finalized
                            ? <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 700 }}>{fmt(r.amount)}</span>
                            : <input aria-label={`Gross festival allowance for ${e.full_name || 'employee'}`} type="number" min="0" defaultValue={r.amount || ''} onBlur={ev => updateAmount(r, ev.target.value)} placeholder="0" style={{ ...inp, width: 110, textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }} />}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {finalized
                            ? <span style={{ color: r.tds > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{r.tds > 0 ? fmt(r.tds) : '—'}</span>
                            : <input aria-label={`TDS for ${e.full_name || 'employee'}`} key={r.tds} type="number" min="0" defaultValue={r.tds || ''} onBlur={ev => updateTds(r, ev.target.value)} placeholder="0" style={{ ...inp, width: 80, textAlign: 'right' }} />}
                        </td>
                        <td style={{ textAlign: 'right', color: net > 0 ? 'var(--theme-green-text)' : 'var(--theme-text3)', fontWeight: 600 }}>
                          {net > 0 ? fmt(net) : '—'}
                        </td>
                        <td>
                          {finalized
                            ? <span style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{r.note || '—'}</span>
                            : <input aria-label={`Note for ${e.full_name || 'employee'}`} defaultValue={r.note || ''} onBlur={ev => updateNote(r, ev.target.value)} placeholder="—" style={{ ...inp, width: '100%' }} />}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)' }}>Total — {rows.length}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 15 }}>{fmt(total)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontSize: 15 }}>{totalTds > 0 ? fmt(totalTds) : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-green-text)', fontSize: 15 }}>{fmt(total - totalTds)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Monthly staff get one month's basic, pro-rated by months worked. Daily/hourly staff start at 0 — enter an amount per person.
            TDS is computed at the marginal income tax rate{hasYtd ? ' using actual YTD payroll data from this fiscal year' : ' (no finalized payroll months found for this FY — using salary projection; finalize earlier months for a more accurate figure)'}.
            Override any TDS inline while draft. Regenerate to recompute from updated salaries or after finalizing new payroll months.
          </div>
        </>
      )}
    </div>
  )
}
