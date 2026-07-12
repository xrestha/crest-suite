import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import * as XLSX from 'xlsx'
import { getBsToday } from '../../../utils/bsCalendar'
import { computeBonusTds, fiscalYearOf } from '../payroll/tds'
import IncentiveConfigs from './IncentiveConfigs'

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

// Same YTD-marginal-rate TDS approach as FestivalAllowance.jsx's calcFestivalTds — kept as its
// own local copy rather than a shared extraction, since this is payroll tax logic already shipped
// and verified there; duplicating ~20 lines is the lower-risk choice over refactoring working,
// tax-sensitive code to share it.
function calcIncentiveTds({ emp, amount, ytd, fyStart }) {
  if (!amount) return 0
  const basic     = parseFloat(emp.basic_salary) || 0
  const ytdGross  = ytd?.gross  || 0
  const ytdSsf    = ytd?.ssf    || 0
  const ytdMonths = ytd?.months || 0
  const remaining = Math.max(0, 12 - ytdMonths)

  const projGross = ytdGross + basic * remaining
  const projSsf   = ytdSsf   + (emp.ssf_enrolled ? Math.min(basic, SSF_CAP_MONTHLY) * SSF_EMP_PCT * remaining : 0)
  const ssfDed    = Math.min(projSsf, Math.min(RETIREMENT_CAP, projGross / 3))
  const lifeIns   = Math.min(parseFloat(emp.life_insurance_premium)   || 0, LIFE_INS_CAP)
  const healthIns = Math.min(parseFloat(emp.health_insurance_premium) || 0, HEALTH_INS_CAP)
  const taxable   = Math.max(0, projGross - ssfDed - lifeIns - healthIns)

  return computeBonusTds({
    annualTaxable: taxable, bonusAmount: amount,
    isSsf: !!emp.ssf_enrolled, isMarried: emp.marital_status === 'married', fyStart,
  })
}

export default function IncentiveRun() {
  const { clientId, isAdmin } = useAuth()
  const { scopedFrom, scopedUpsert, scopedUpdate } = useScopedDb()
  const today = getBsToday()

  const [configs,   setConfigs]   = useState([])
  const [configId,  setConfigId]  = useState('')
  const [runLabel,  setRunLabel]  = useState('')
  const [bsYear,    setBsYear]    = useState(today.year)
  const [rows,      setRows]      = useState([])
  const [employees, setEmployees] = useState([])
  const [ytdMap,    setYtdMap]    = useState({})
  const [loading,   setLoading]   = useState(true)
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState('')
  const [showConfigs, setShowConfigs] = useState(false)

  const empMap    = Object.fromEntries(employees.map(e => [e.id, e]))
  const years     = Array.from({ length: 6 }, (_, i) => today.year - 3 + i)
  const activeConfigs = configs.filter(c => c.active)
  const selectedConfig = configs.find(c => c.id === configId)
  const finalized = rows.length > 0 && rows.every(r => r.status === 'finalized')
  const { fyStart } = fiscalYearOf(bsYear, 6)
  const hasYtd    = Object.keys(ytdMap).length > 0

  const loadConfigs = useCallback(async () => {
    const { data } = await scopedFrom('hr_incentive_configs').order('name')
    setConfigs(data || [])
  }, [scopedFrom])

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true); setMsg('')
    const [{ data: emps }, { data: inc }, { data: psData }] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, department, pay_basis, basic_salary, join_date, bank_name, bank_account_no, status, marital_status, ssf_enrolled, life_insurance_premium, health_insurance_premium')
        .in('status', ['active', 'probation']).order('full_name'),
      runLabel ? scopedFrom('hr_incentives').eq('bs_year', bsYear).eq('run_label', runLabel) : Promise.resolve({ data: [] }),
      scopedFrom('hr_payslips', 'employee_id, gross, ssf_employee, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
        .eq('hr_payroll_runs.status', 'finalized'),
    ])
    setEmployees(emps || [])
    setRows(inc || [])

    const ytd = {}
    ;(psData || []).forEach(r => {
      const mp = r.hr_payroll_runs?.monthly_periods
      if (!mp) return
      const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
      if (fy.fyStart !== fyStart) return
      const e = ytd[r.employee_id] || { gross: 0, ssf: 0, months: 0 }
      e.gross += r.gross || 0; e.ssf += r.ssf_employee || 0; e.months += 1
      ytd[r.employee_id] = e
    })
    setYtdMap(ytd)
    setLoading(false)
  }, [clientId, bsYear, runLabel, fyStart, scopedFrom])

  useEffect(() => { loadConfigs() }, [loadConfigs])
  useEffect(() => { load() }, [load])

  function buildRows() {
    return employees.map(emp => {
      const basic = parseFloat(emp.basic_salary) || 0
      let amount = 0
      if (selectedConfig?.calc_type === 'fixed') amount = selectedConfig.default_value
      else if (selectedConfig?.calc_type === 'percent_of_basic') amount = Math.round(basic * (selectedConfig.default_value / 100))
      const tds = calcIncentiveTds({ emp, amount, ytd: ytdMap[emp.id], fyStart })
      return {
        employee_id: emp.id, config_id: configId || null, run_label: runLabel, bs_year: bsYear,
        amount, tds, status: 'draft',
      }
    })
  }

  async function generate() {
    if (!clientId || !runLabel.trim()) { setMsg('error:Enter a run label first.'); return }
    if (employees.length === 0) return
    setBusy(true); setMsg('')
    const { error } = await scopedUpsert('hr_incentives', buildRows(), { onConflict: 'client_id,employee_id,bs_year,run_label' })
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); setMsg('ok:Generated'); setBusy(false)
  }

  async function regenerate() {
    if (finalized) return
    if (!window.confirm('Recompute all amounts from current salaries/config? Manual edits will be reset.')) return
    setBusy(true); setMsg('')
    const { error } = await scopedUpsert('hr_incentives', buildRows(), { onConflict: 'client_id,employee_id,bs_year,run_label' })
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); setMsg('ok:Recomputed'); setBusy(false)
  }

  async function updateAmount(row, value) {
    if (finalized) return
    const amount = parseFloat(value) || 0
    const emp = empMap[row.employee_id] || {}
    const tds = calcIncentiveTds({ emp, amount, ytd: ytdMap[row.employee_id], fyStart })
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, amount, tds } : r))
    await scopedUpdate('hr_incentives', { amount, tds }).eq('id', row.id)
  }

  async function updateTds(row, value) {
    if (finalized) return
    const tds = parseFloat(value) || 0
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, tds } : r))
    await scopedUpdate('hr_incentives', { tds }).eq('id', row.id)
  }

  async function updateNote(row, value) {
    if (finalized) return
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, note: value } : r))
    await scopedUpdate('hr_incentives', { note: value || null }).eq('id', row.id)
  }

  async function setStatus(status) {
    const verb = status === 'finalized' ? 'Finalize' : 'Reopen'
    if (!window.confirm(`${verb} this incentive run?`)) return
    setBusy(true)
    await scopedUpdate('hr_incentives', { status }).eq('bs_year', bsYear).eq('run_label', runLabel)
    await load(); setMsg(`ok:${verb}d`); setBusy(false)
  }

  const total    = rows.reduce((a, r) => a + (r.amount || 0), 0)
  const totalTds = rows.reduce((a, r) => a + (r.tds || 0), 0)

  function exportSheet(data, name, ext = 'xlsx') {
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, name)
    XLSX.writeFile(wb, `${name.replace(/\s+/g, '_').toLowerCase()}_${runLabel}_${bsYear}.${ext}`, ext === 'csv' ? { bookType: 'csv' } : undefined)
  }
  function exportRegister() {
    exportSheet(rows.map(r => {
      const e = empMap[r.employee_id] || {}
      return {
        Employee: e.full_name || '', Code: e.employee_code || '',
        'Gross Amount': r.amount, 'TDS Withheld': r.tds || 0, 'Net Amount': (r.amount || 0) - (r.tds || 0),
      }
    }), 'Incentive Register')
  }
  function exportBank(ext) {
    exportSheet(rows.map(r => {
      const e = empMap[r.employee_id] || {}
      return {
        Name: e.full_name || '', Bank: e.bank_name || '', 'Account No': e.bank_account_no || '',
        Gross: r.amount, TDS: r.tds || 0, 'Net Transfer': (r.amount || 0) - (r.tds || 0),
      }
    }), 'Incentive Bank Transfer', ext)
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Incentives / Bonus</h1>
          <p className="page-subtitle">
            One-off bonus runs — {runLabel || 'unnamed run'} {bsYear}
            {rows.length > 0 && (
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: finalized ? 'var(--theme-green)' : 'var(--theme-accent)', background: finalized ? 'rgba(52,211,153,0.1)' : 'rgba(201,168,76,0.1)', border: `1px solid ${finalized ? 'rgba(52,211,153,0.2)' : 'rgba(201,168,76,0.2)'}`, padding: '2px 8px', borderRadius: 10 }}>
                {finalized ? 'Finalized' : 'Draft'}
              </span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} className="no-print">
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green)' : 'var(--theme-red)' }}>{msg.split(':').slice(1).join(':')}</span>}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowConfigs(true)}>⚙ Manage Types</button>
          <select className="form-select" value={configId} onChange={e => {
            setConfigId(e.target.value)
            const cfg = configs.find(c => c.id === e.target.value)
            if (cfg && !runLabel) setRunLabel(cfg.name)
          }}>
            <option value="">— Ad-hoc (manual) —</option>
            {activeConfigs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input style={{ ...inp, width: 150 }} value={runLabel} onChange={e => setRunLabel(e.target.value)} placeholder="Run label, e.g. Q1 Sales Bonus" />
          <select className="form-select" value={bsYear} onChange={e => setBsYear(parseInt(e.target.value, 10))}>
            {years.map(y => <option key={y} value={y}>BS {y}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)' }}>Loading…</div>
      ) : employees.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)' }}>No active employees. Add employees in HR → Employees first.</div>
      ) : !runLabel.trim() ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
          Enter a run label (and optionally pick an incentive type) above to get started.
        </div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>🎁</div>
          <div style={{ fontSize: 14, color: 'var(--theme-text1)', marginBottom: 6 }}>No "{runLabel}" run for BS {bsYear} yet</div>
          <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginBottom: 18 }}>
            {selectedConfig
              ? `Seeds each employee's amount per "${selectedConfig.name}" (${selectedConfig.calc_type === 'manual' ? 'enter manually' : selectedConfig.calc_type === 'fixed' ? `NPR ${fmt(selectedConfig.default_value)} fixed` : `${selectedConfig.default_value}% of basic`}), editable before finalizing.`
              : 'No type selected — every employee starts at 0, enter amounts manually.'}
          </div>
          <button className="btn btn-primary" onClick={generate} disabled={busy}>{busy ? 'Generating…' : 'Generate Run'}</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Gross Payout', value: fmt(total), color: 'var(--theme-accent)', tip: 'Total gross incentive before TDS withholding.' },
              { label: 'TDS Withheld', value: fmt(totalTds), color: 'var(--theme-red)', tip: 'Income tax withheld from this incentive, at each employee\'s marginal rate.' },
              { label: 'Net Payout', value: fmt(total - totalTds), color: 'var(--theme-green)', tip: 'Amount to disburse after TDS deduction.' },
              { label: 'Employees', value: rows.length, color: 'var(--theme-text1)', tip: 'Active and probation employees included in this run.' },
              { label: 'Average Gross', value: fmt(rows.length ? total / rows.length : 0), color: 'var(--theme-text2)', tip: 'Average gross incentive per employee.' },
            ].map(s => (
              <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <Tip text={s.tip} width={260}>{s.label}</Tip>
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
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>
                      <Tip text="Incentive amount. Editable while draft." width={220}>Gross</Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}>
                      <Tip text={hasYtd ? 'TDS at marginal rate using YTD payroll data. Editable while draft.' : 'TDS based on projected annual salary (no finalized payroll yet this FY). Editable while draft.'} width={280}>
                        TDS {hasYtd && <span style={{ fontSize: 9, color: 'var(--theme-green)', fontWeight: 400, marginLeft: 3 }}>YTD</span>}
                      </Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-green)' }}>Net</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const e = empMap[r.employee_id] || {}
                    const missingBank = !e.bank_name || !e.bank_account_no
                    const net = (r.amount || 0) - (r.tds || 0)
                    return (
                      <tr key={r.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{e.full_name || '—'}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                            {e.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{e.employee_code}</span>}
                            {missingBank && <span style={{ fontSize: 10, color: 'var(--theme-accent)' }}>⚠ no bank</span>}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {finalized
                            ? <span style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>{fmt(r.amount)}</span>
                            : <input type="number" min="0" defaultValue={r.amount || ''} onBlur={ev => updateAmount(r, ev.target.value)} placeholder="0" style={{ ...inp, width: 110, textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }} />}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {finalized
                            ? <span style={{ color: r.tds > 0 ? 'var(--theme-red)' : 'var(--theme-text3)' }}>{r.tds > 0 ? fmt(r.tds) : '—'}</span>
                            : <input key={r.tds} type="number" min="0" defaultValue={r.tds || ''} onBlur={ev => updateTds(r, ev.target.value)} placeholder="0" style={{ ...inp, width: 80, textAlign: 'right' }} />}
                        </td>
                        <td style={{ textAlign: 'right', color: net > 0 ? 'var(--theme-green)' : 'var(--theme-text2)', fontWeight: 600 }}>{net > 0 ? fmt(net) : '—'}</td>
                        <td>
                          {finalized
                            ? <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>{r.note || '—'}</span>
                            : <input defaultValue={r.note || ''} onBlur={ev => updateNote(r, ev.target.value)} placeholder="—" style={{ ...inp, width: '100%' }} />}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td style={{ color: 'var(--theme-text3)' }}>Total — {rows.length}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontSize: 15 }}>{fmt(total)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontSize: 15 }}>{totalTds > 0 ? fmt(totalTds) : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-green)', fontSize: 15 }}>{fmt(total - totalTds)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {showConfigs && (
        <IncentiveConfigs configs={configs} onClose={() => setShowConfigs(false)} onChanged={loadConfigs} />
      )}
    </div>
  )
}
