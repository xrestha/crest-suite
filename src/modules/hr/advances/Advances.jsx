import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import SearchableSelect from '../../../components/SearchableSelect'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { adToBs } from '../../../utils/bsCalendar'

const fmt  = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtD = iso => {
  if (!iso) return '—'
  const bs = adToBs(new Date(iso + 'T00:00:00'))
  return `${bs.year}-${String(bs.month).padStart(2,'0')}-${String(bs.day).padStart(2,'0')}`
}
const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 6, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)',
  outline: 'none', width: '100%', fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4, display: 'block' }

const EMPTY_ADD = {
  employee_id: '', type: 'advance', issued_date: '', amount: '',
  installment_amount: '', purpose: '', notes: '',
}
const EMPTY_REPAY = { repaid_date: '', amount: '', notes: '' }

export default function Advances() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [employees,  setEmployees]  = useState([])
  const [advances,   setAdvances]   = useState([])
  const [repayments, setRepayments] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [filterType,   setFilterType]   = useState('all')    // all | advance | loan
  const [filterStatus, setFilterStatus] = useState('active') // active | settled | all
  const [selected,   setSelected]   = useState(null)  // advance id for detail panel
  const [showAdd,    setShowAdd]    = useState(false)
  const [showRepay,  setShowRepay]  = useState(false)
  const [addForm,    setAddForm]    = useState(EMPTY_ADD)
  const [repayForm,  setRepayForm]  = useState(EMPTY_REPAY)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState('')
  const [settleTarget, setSettleTarget] = useState(null)

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: emps }, { data: advs }, { data: reps }] = await Promise.all([
      scopedFrom('hr_employees', 'id, full_name, employee_code, status').order('full_name'),
      scopedFrom('hr_advances').order('issued_date', { ascending: false }),
      scopedFrom('hr_advance_repayments').order('repaid_date'),
    ])
    setEmployees(emps || [])
    setAdvances(advs || [])
    setRepayments(reps || [])
    setLoading(false)
  }, [clientId, scopedFrom])

  useEffect(() => { load() }, [load])

  const empMap = Object.fromEntries((employees || []).map(e => [e.id, e]))

  // Per-advance repayment totals and rows
  const repayMap = {}
  ;(repayments || []).forEach(r => {
    if (!repayMap[r.advance_id]) repayMap[r.advance_id] = { total: 0, rows: [] }
    repayMap[r.advance_id].total += parseFloat(r.amount) || 0
    repayMap[r.advance_id].rows.push(r)
  })

  const filtered = (advances || []).filter(a => {
    if (filterType !== 'all' && a.type !== filterType) return false
    if (filterStatus !== 'all' && a.status !== filterStatus) return false
    return true
  })

  // Summary stats (active only)
  const activeAdvances = advances.filter(a => a.status === 'active')
  const totalOutstanding = activeAdvances.reduce((s, a) => {
    const repaid = repayMap[a.id]?.total || 0
    return s + Math.max(0, parseFloat(a.amount) - repaid)
  }, 0)
  const employeesWithActive = new Set(activeAdvances.map(a => a.employee_id)).size
  const advanceCount = activeAdvances.filter(a => a.type === 'advance').length
  const loanCount    = activeAdvances.filter(a => a.type === 'loan').length

  function setAdd(f, v) { setAddForm(p => ({ ...p, [f]: v })) }
  function setRepay(f, v) { setRepayForm(p => ({ ...p, [f]: v })) }

  async function handleAdd() {
    if (!clientId) return
    if (!addForm.employee_id) { setError('Select an employee.'); return }
    if (!addForm.issued_date) { setError('Set the issued date.'); return }
    if (!addForm.amount || parseFloat(addForm.amount) <= 0) { setError('Enter a valid amount.'); return }
    setError(''); setSaving(true)
    const { error: err } = await scopedInsert('hr_advances', {
      employee_id:        addForm.employee_id,
      type:               addForm.type,
      issued_date:        addForm.issued_date,
      amount:             parseFloat(addForm.amount),
      installment_amount: parseFloat(addForm.installment_amount) || null,
      purpose:            addForm.purpose || null,
      notes:              addForm.notes || null,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    setShowAdd(false); setAddForm(EMPTY_ADD); load()
  }

  async function handleRepay() {
    if (!clientId || !selected) return
    if (!repayForm.repaid_date) { setError('Set the repayment date.'); return }
    if (!repayForm.amount || parseFloat(repayForm.amount) <= 0) { setError('Enter a valid amount.'); return }
    const adv = advances.find(a => a.id === selected)
    if (!adv) return
    setError(''); setSaving(true)
    const { error: err } = await scopedInsert('hr_advance_repayments', {
      advance_id:  selected,
      employee_id: adv.employee_id,
      repaid_date: repayForm.repaid_date,
      amount:      parseFloat(repayForm.amount),
      notes:       repayForm.notes || null,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    setShowRepay(false); setRepayForm(EMPTY_REPAY); load()
  }

  async function handleSettle(advId) {
    await scopedUpdate('hr_advances', { status: 'settled' }).eq('id', advId)
    setSettleTarget(null)
    if (selected === advId) setSelected(null)
    load()
  }

  async function handleDelete(advId) {
    const hasReps = (repayMap[advId]?.rows || []).length > 0
    if (hasReps) return // button shouldn't show if repayments exist
    if (!window.confirm('Delete this advance? This cannot be undone.')) return
    await scopedDelete('hr_advances').eq('id', advId)
    if (selected === advId) setSelected(null)
    load()
  }

  const selectedAdv = selected ? advances.find(a => a.id === selected) : null
  const selectedReps = selected ? (repayMap[selected]?.rows || []) : []
  const selectedRepaid = selected ? (repayMap[selected]?.total || 0) : 0
  const selectedOutstanding = selectedAdv ? Math.max(0, parseFloat(selectedAdv.amount) - selectedRepaid) : 0

  const tabBtn = (val, cur, set, label) => (
    <button className={`tab-btn${cur === val ? ' tab-btn--active' : ''}`}
      onClick={() => set(val)}>{label}</button>
  )

  if (loading) return <div style={{ padding: 32, color: 'var(--theme-text3)' }}>Loading…</div>
  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Advances &amp; Loans</h1>
          <p className="page-subtitle">Track salary advances and employee loans</p>
        </div>
        <button className="btn btn-primary" onClick={() => { setAddForm(EMPTY_ADD); setError(''); setShowAdd(true) }}>
          + Issue Advance / Loan
        </button>
      </div>

      {/* Summary cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        {[
          { label: 'Total Outstanding', value: `NPR ${fmt(totalOutstanding)}`, tip: 'Sum of unpaid balances across all active advances and loans.' },
          { label: 'Employees Affected', value: employeesWithActive, tip: 'Number of employees with at least one active advance or loan.' },
          { label: 'Active Advances', value: advanceCount, tip: 'Short-term advances (typically recovered in the next payslip).' },
          { label: 'Active Loans', value: loanCount, tip: 'Multi-month loans with scheduled installment repayments.' },
        ].map(c => (
          <div key={c.label} className="card" style={{ padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginBottom: 4 }}>
              <Tip text={c.tip}>{c.label}</Tip>
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <div className="tab-bar">
          {tabBtn('all',     filterType,   setFilterType,   'All')}
          {tabBtn('advance', filterType,   setFilterType,   'Advances')}
          {tabBtn('loan',    filterType,   setFilterType,   'Loans')}
        </div>
        <div className="tab-bar" style={{ marginLeft: 8 }}>
          {tabBtn('active',  filterStatus, setFilterStatus, 'Active')}
          {tabBtn('settled', filterStatus, setFilterStatus, 'Settled')}
          {tabBtn('all',     filterStatus, setFilterStatus, 'All')}
        </div>
      </div>

      {/* Main table */}
      <div className="table-wrap" style={{ marginBottom: selected ? 12 : 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th><Tip text="Advance = short-term, next payslip. Loan = multi-month installment.">Type</Tip></th>
              <th>Issued (BS)</th>
              <th style={{ textAlign: 'right' }}><Tip text="Original amount issued.">Amount</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="Scheduled monthly deduction from payroll.">Installment/Mo</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="Total repaid so far via recorded repayments.">Repaid</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="Amount still to be recovered.">Outstanding</Tip></th>
              <th>Purpose</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--theme-text3)', padding: 32 }}>
                No records found.
              </td></tr>
            )}
            {filtered.map(a => {
              const emp      = empMap[a.employee_id] || {}
              const repaid   = repayMap[a.id]?.total || 0
              const outstanding = Math.max(0, parseFloat(a.amount) - repaid)
              const isActive = a.status === 'active'
              const isSel    = selected === a.id
              return (
                <tr key={a.id}
                  onClick={() => setSelected(isSel ? null : a.id)}
                  style={{ cursor: 'pointer', background: isSel ? 'color-mix(in srgb, var(--theme-accent) 7%, transparent)' : undefined }}
                >
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{emp.full_name || '—'}</div>
                    {emp.employee_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{emp.employee_code}</div>}
                  </td>
                  <td>
                    <span className={a.type === 'loan' ? 'badge-yellow' : 'badge-gray'} style={{ textTransform: 'capitalize' }}>
                      {a.type}
                    </span>
                  </td>
                  <td style={{ color: 'var(--theme-text2)', fontSize: 13 }}>{fmtD(a.issued_date)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{fmt(a.amount)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    {a.installment_amount ? fmt(a.installment_amount) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{fmt(repaid)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: outstanding > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                    {fmt(outstanding)}
                  </td>
                  <td style={{ color: 'var(--theme-text3)', fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.purpose || '—'}
                  </td>
                  <td>
                    <span className={isActive ? 'badge-amber' : 'badge-green'} style={{ textTransform: 'capitalize' }}>
                      {a.status}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Detail panel */}
      {selectedAdv && (
        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>
                {empMap[selectedAdv.employee_id]?.full_name} — {selectedAdv.type === 'loan' ? 'Loan' : 'Advance'} of NPR {fmt(selectedAdv.amount)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 3 }}>
                Issued {fmtD(selectedAdv.issued_date)}
                {selectedAdv.purpose && ` · ${selectedAdv.purpose}`}
                {selectedAdv.installment_amount && ` · NPR ${fmt(selectedAdv.installment_amount)}/mo installment`}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {selectedAdv.status === 'active' && (
                <>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }}
                    onClick={() => { setRepayForm({ ...EMPTY_REPAY, amount: selectedAdv.installment_amount || '' }); setError(''); setShowRepay(true) }}>
                    + Record Repayment
                  </button>
                  <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-green-text)' }}
                    onClick={() => setSettleTarget(selectedAdv)}>
                    ✓ Settle
                  </button>
                </>
              )}
              {(repayMap[selectedAdv.id]?.rows || []).length === 0 && (
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}
                  onClick={() => handleDelete(selectedAdv.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>

          {/* Balance bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--theme-text3)', marginBottom: 4 }}>
              <span>Repaid: NPR {fmt(selectedRepaid)}</span>
              <span>Outstanding: NPR {fmt(selectedOutstanding)}</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--theme-border)', overflow: 'hidden' }}>
              <div style={{
                width: '100%', height: '100%', borderRadius: 3,
                transform: `scaleX(${Math.min(100, (selectedRepaid / parseFloat(selectedAdv.amount)) * 100) / 100})`,
                transformOrigin: 'left',
                background: selectedOutstanding === 0 ? 'var(--theme-green)' : 'var(--theme-accent)',
                transition: 'transform 0.3s',
              }} />
            </div>
          </div>

          {/* Repayment history */}
          {selectedReps.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--theme-text3)', padding: '8px 0' }}>No repayments recorded yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    <th>Date (BS)</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedReps.map(r => (
                    <tr key={r.id}>
                      <td>{fmtD(r.repaid_date)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green-text)', fontWeight: 600 }}>NPR {fmt(r.amount)}</td>
                      <td style={{ color: 'var(--theme-text3)' }}>{r.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add Advance/Loan modal */}
      {showAdd && (
        <Modal onClose={() => { setShowAdd(false); setError('') }} title="Issue Advance / Loan" maxWidth={480}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div>
              <label style={lbl} htmlFor="adv-employee">Employee</label>
              <SearchableSelect
                id="adv-employee"
                options={employees.filter(e => e.status === 'active' || e.status === 'probation').map(e => ({ value: e.id, label: `${e.full_name}${e.employee_code ? ` (${e.employee_code})` : ''}` }))}
                value={addForm.employee_id}
                onChange={v => setAdd('employee_id', v)}
                placeholder="Select employee…"
              />
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="adv-type">Type</label>
                <select id="adv-type" className="form-select" value={addForm.type} onChange={e => setAdd('type', e.target.value)}>
                  <option value="advance">Advance (short-term)</option>
                  <option value="loan">Loan (multi-month)</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="adv-issued-date">Issued Date (BS)</label>
                <BsCalendarPicker id="adv-issued-date" value={addForm.issued_date} onChange={v => setAdd('issued_date', v)} placeholder="Select date" clearable />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="adv-amount"><Tip text="Total amount issued to the employee." width={200}>Amount (NPR)</Tip></label>
                <input id="adv-amount" style={inp} type="number" min="1" placeholder="e.g. 20000" value={addForm.amount} onChange={e => setAdd('amount', e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl} htmlFor="adv-installment"><Tip text="Monthly deduction amount. Shows in the detail panel as a reminder during payroll." width={240}>Installment / Month (NPR)</Tip></label>
                <input id="adv-installment" style={inp} type="number" min="0" placeholder="e.g. 5000" value={addForm.installment_amount} onChange={e => setAdd('installment_amount', e.target.value)} />
              </div>
            </div>

            <div>
              <label style={lbl} htmlFor="adv-purpose">Purpose</label>
              <input id="adv-purpose" style={inp} placeholder="e.g. Medical emergency, festival advance…" value={addForm.purpose} onChange={e => setAdd('purpose', e.target.value)} />
            </div>

            <div>
              <label style={lbl} htmlFor="adv-notes">Notes</label>
              <textarea id="adv-notes" style={{ ...inp, height: 60, resize: 'vertical' }} placeholder="Optional internal notes" value={addForm.notes} onChange={e => setAdd('notes', e.target.value)} />
            </div>

            {error && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setShowAdd(false); setError('') }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={saving}>{saving ? 'Saving…' : 'Issue'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Record Repayment modal */}
      {showRepay && selectedAdv && (
        <Modal onClose={() => { setShowRepay(false); setError('') }} title="Record Repayment" maxWidth={400}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--theme-text3)' }}>
              {empMap[selectedAdv.employee_id]?.full_name} · Outstanding: NPR {fmt(selectedOutstanding)}
            </div>

            <div>
              <label style={lbl} htmlFor="adv-repay-date">Repayment Date (BS)</label>
              <BsCalendarPicker id="adv-repay-date" value={repayForm.repaid_date} onChange={v => setRepay('repaid_date', v)} placeholder="Select date" clearable />
            </div>

            <div>
              <label style={lbl} htmlFor="adv-repay-amount">Amount (NPR)</label>
              <input id="adv-repay-amount" style={inp} type="number" min="1" placeholder={selectedAdv.installment_amount ? `Installment: ${fmt(selectedAdv.installment_amount)}` : 'Amount'} value={repayForm.amount} onChange={e => setRepay('amount', e.target.value)} />
            </div>

            <div>
              <label style={lbl} htmlFor="adv-repay-notes">Notes</label>
              <input id="adv-repay-notes" style={inp} placeholder="e.g. Deducted from Shrawan payslip" value={repayForm.notes} onChange={e => setRepay('notes', e.target.value)} />
            </div>

            {error && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => { setShowRepay(false); setError('') }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRepay} disabled={saving}>{saving ? 'Saving…' : 'Record'}</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Settle confirmation */}
      {settleTarget && (
        <Modal onClose={() => setSettleTarget(null)} title={`Settle ${settleTarget.type === 'loan' ? 'Loan' : 'Advance'}?`} maxWidth={360}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(() => {
              const outstanding = Math.max(0, parseFloat(settleTarget.amount) - (repayMap[settleTarget.id]?.total || 0))
              return outstanding > 0
                ? <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-red-text)' }}>NPR {fmt(outstanding)} is still outstanding. Mark as settled anyway?</p>
                : <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Fully repaid. Mark as settled?</p>
            })()}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setSettleTarget(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => handleSettle(settleTarget.id)}>Settle</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
