import { useState, useEffect } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { bsToAd, getBsToday } from '../../../utils/bsCalendar'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

const inp = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6,
  padding: '6px 8px', fontSize: 13, color: '#e8e0d0', outline: 'none', fontFamily: 'inherit',
}

// Full months between an AD join date and a reference date, clamped to 0..12.
function monthsBetween(joinDateStr, ref) {
  if (!joinDateStr) return 12
  const j = new Date(joinDateStr)
  if (isNaN(j)) return 12
  let m = (ref.getFullYear() - j.getFullYear()) * 12 + (ref.getMonth() - j.getMonth())
  return Math.max(0, Math.min(12, m))
}

export default function FestivalAllowance() {
  const { clientId, isAdmin } = useAuth()
  const today = getBsToday()
  const [bsYear,    setBsYear]    = useState(today.year)
  const [festival,  setFestival]  = useState('Dashain')
  const [rows,      setRows]      = useState([])     // hr_festival_allowances rows
  const [employees, setEmployees] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState('')

  const empMap = Object.fromEntries(employees.map(e => [e.id, e]))
  const years = Array.from({ length: 6 }, (_, i) => today.year - 3 + i)
  const finalized = rows.length > 0 && rows.every(r => r.status === 'finalized')

  useEffect(() => {
    if (!clientId) return
    load()
  }, [clientId, bsYear, festival]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true); setMsg('')
    const [{ data: emps }, { data: fa }] = await Promise.all([
      supabase.from('hr_employees').select('id, full_name, employee_code, department, pay_basis, basic_salary, join_date, bank_name, bank_account_no, status')
        .eq('client_id', clientId).in('status', ['active', 'probation']).order('full_name'),
      supabase.from('hr_festival_allowances').select('*').eq('client_id', clientId).eq('bs_year', bsYear).eq('festival_name', festival),
    ])
    setEmployees(emps || [])
    setRows(fa || [])
    setLoading(false)
  }

  function buildRows() {
    const ref = bsToAd(bsYear, 6, 15)  // ~Ashwin (Dashain) of the selected BS year
    return employees.map(emp => {
      const basis = emp.pay_basis || 'monthly'
      const basic = parseFloat(emp.basic_salary) || 0
      const mw    = monthsBetween(emp.join_date, ref)
      const amount = basis === 'monthly' ? Math.round(basic * mw / 12) : 0
      return {
        client_id: clientId, employee_id: emp.id, bs_year: bsYear, festival_name: festival,
        pay_basis: basis, basic, months_worked: mw, amount, status: 'draft',
      }
    })
  }

  async function generate() {
    if (employees.length === 0) return
    setBusy(true); setMsg('')
    const { error } = await supabase.from('hr_festival_allowances')
      .upsert(buildRows(), { onConflict: 'client_id,employee_id,bs_year,festival_name' })
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); setMsg('ok:Generated'); setBusy(false)
  }

  async function regenerate() {
    if (finalized) return
    if (!window.confirm('Recompute all festival amounts from current salaries? Manual edits will be reset.')) return
    setBusy(true); setMsg('')
    const { error } = await supabase.from('hr_festival_allowances')
      .upsert(buildRows(), { onConflict: 'client_id,employee_id,bs_year,festival_name' })
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); setMsg('ok:Recomputed'); setBusy(false)
  }

  async function updateAmount(row, value) {
    if (finalized) return
    const amount = parseFloat(value) || 0
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, amount } : r))
    await supabase.from('hr_festival_allowances').update({ amount }).eq('id', row.id)
  }

  async function updateNote(row, value) {
    if (finalized) return
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, note: value } : r))
    await supabase.from('hr_festival_allowances').update({ note: value || null }).eq('id', row.id)
  }

  async function setStatus(status) {
    const verb = status === 'finalized' ? 'Finalize' : 'Reopen'
    if (!window.confirm(`${verb} this festival allowance?`)) return
    setBusy(true)
    await supabase.from('hr_festival_allowances').update({ status })
      .eq('client_id', clientId).eq('bs_year', bsYear).eq('festival_name', festival)
    await load(); setMsg(`ok:${verb}d`); setBusy(false)
  }

  const total = rows.reduce((a, r) => a + (r.amount || 0), 0)

  function exportSheet(data, name, ext = 'xlsx') {
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, name)
    XLSX.writeFile(wb, `${name.replace(/\s+/g, '_').toLowerCase()}_${festival}_${bsYear}.${ext}`, ext === 'csv' ? { bookType: 'csv' } : undefined)
  }
  function exportRegister() {
    exportSheet(rows.map(r => {
      const e = empMap[r.employee_id] || {}
      return { Employee: e.full_name || '', Code: e.employee_code || '', 'Pay Basis': r.pay_basis, Basic: r.basic, 'Months Worked': r.months_worked, Amount: r.amount }
    }), 'Festival Allowance')
  }
  function exportBank(ext) {
    exportSheet(rows.map(r => {
      const e = empMap[r.employee_id] || {}
      return { Name: e.full_name || '', Bank: e.bank_name || '', 'Account No': e.bank_account_no || '', Amount: r.amount }
    }), 'Festival Bank Transfer', ext)
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Festival Allowance</h1>
          <p className="page-subtitle">
            Annual festival bonus (Dashain / पर्व खर्च) — {festival} {bsYear}
            {rows.length > 0 && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: finalized ? '#34d399' : '#c9a84c', background: finalized ? 'rgba(52,211,153,0.1)' : 'rgba(201,168,76,0.1)', border: `1px solid ${finalized ? 'rgba(52,211,153,0.2)' : 'rgba(201,168,76,0.2)'}`, padding: '2px 8px', borderRadius: 10 }}>{finalized ? 'Finalized' : 'Draft'}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} className="no-print">
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('ok') ? '#34d399' : '#f87171' }}>{msg.split(':').slice(1).join(':')}</span>}
          <input style={{ ...inp, width: 130 }} value={festival} onChange={e => setFestival(e.target.value)} placeholder="Festival name" />
          <select className="form-select" value={bsYear} onChange={e => setBsYear(parseInt(e.target.value, 10))}>
            {years.map(y => <option key={y} value={y}>BS {y}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#6b7280' }}>No active employees. Add employees in HR → Employees first.</div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>🎉</div>
          <div style={{ fontSize: 14, color: '#e8e0d0', marginBottom: 6 }}>No {festival} allowance for BS {bsYear} yet</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 18 }}>Computes one month's basic per employee, pro-rated by months worked. Daily/hourly staff start at 0 — enter their amounts manually.</div>
          <button className="btn btn-primary" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate Allowance'}</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Total Payout', value: fmt(total), color: '#c9a84c', tip: 'Total festival bonus to disburse across all employees in this run.' },
              { label: 'Employees',    value: rows.length, color: '#e8e0d0', tip: 'Active and probation employees included in this festival run.' },
              { label: 'Average',      value: fmt(rows.length ? total / rows.length : 0), color: '#9ca3af', tip: 'Average allowance per employee (total ÷ headcount).' },
            ].map(s => (
              <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <Tip text={s.tip} width={240}>{s.label}</Tip>
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.label === 'Employees' ? s.value : `NPR ${s.value}`}</div>
              </div>
            ))}
          </div>

          <div className="card no-print" style={{ marginBottom: 14, display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportRegister}>⬇ Register</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => exportBank('xlsx')}>⬇ Bank Excel</button>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => exportBank('csv')}>⬇ Bank CSV</button>
            {!finalized && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={regenerate} disabled={busy}>↻ Regenerate</button>}
            {!finalized && <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setStatus('finalized')} disabled={busy}>Finalize</button>}
            {finalized && isAdmin && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setStatus('draft')} disabled={busy}>Reopen</button>}
          </div>

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
                    <th style={{ textAlign: 'right', color: '#c9a84c' }}>
                      <Tip text="Festival bonus. Editable while draft; daily/hourly default to 0 — enter manually." width={250}>Amount</Tip>
                    </th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const e = empMap[r.employee_id] || {}
                    const isMonthly = r.pay_basis === 'monthly'
                    const missingBank = !e.bank_name || !e.bank_account_no
                    return (
                      <tr key={r.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: '#e8e0d0', fontSize: 13 }}>{e.full_name || '—'}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                            {e.employee_code && <span style={{ fontSize: 10, color: '#6b7280' }}>{e.employee_code}</span>}
                            {!isMonthly && <span style={{ fontSize: 10, fontWeight: 700, color: '#60a5fa', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: 8, padding: '1px 6px' }}>{r.pay_basis}</span>}
                            {missingBank && <span style={{ fontSize: 10, color: '#c9a84c' }}>⚠ no bank</span>}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', color: '#9ca3af' }}>{fmt(r.basic)}</td>
                        <td style={{ textAlign: 'right', color: r.months_worked < 12 ? '#c9a84c' : '#9ca3af' }}>{r.months_worked}</td>
                        <td style={{ textAlign: 'right' }}>
                          {finalized
                            ? <span style={{ color: '#c9a84c', fontWeight: 700 }}>{fmt(r.amount)}</span>
                            : <input type="number" min="0" defaultValue={r.amount || ''} onBlur={ev => updateAmount(r, ev.target.value)} placeholder="0" style={{ ...inp, width: 110, textAlign: 'right', color: '#c9a84c', fontWeight: 600 }} />}
                        </td>
                        <td>
                          {finalized
                            ? <span style={{ color: '#6b7280', fontSize: 12 }}>{r.note || '—'}</span>
                            : <input defaultValue={r.note || ''} onBlur={ev => updateNote(r, ev.target.value)} placeholder="—" style={{ ...inp, width: '100%' }} />}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={3} style={{ color: '#6b7280' }}>Total — {rows.length}</td>
                    <td style={{ textAlign: 'right', color: '#c9a84c', fontSize: 15 }}>{fmt(total)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.6 }}>
            Monthly staff get one month's basic, pro-rated by months worked toward the festival. Daily/hourly staff start at 0 — enter an amount per person. Festival allowance is taxable income, but no tax is withheld here yet.
          </div>
        </>
      )}
    </div>
  )
}
