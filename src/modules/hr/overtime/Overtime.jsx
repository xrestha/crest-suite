import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import { BS_MONTHS, getBsToday, daysInBsMonth } from '../../../utils/bsCalendar'
import { OT_MULTIPLIER, OT_HOLIDAY_MULTIPLIER } from '../payrollConstants'

const STATUS_COLORS = {
  pending:  { color: '#c9a84c', bg: 'rgba(201,168,76,0.1)',  border: 'rgba(201,168,76,0.2)'  },
  approved: { color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.2)'  },
  rejected: { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' },
}

const lbl = {
  fontSize: 11, color: '#9ca3af', fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase',
  display: 'block', marginBottom: 4,
}
const inp = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6,
  padding: '8px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none',
  fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
}

const BLANK = {
  employee_id: '',
  bs_year: 0, bs_month: 0, bs_day: 1,
  ot_hours: '',
  ot_type: 'weekday',
  reason: '',
}

export default function Overtime() {
  const { clientId } = useAuth()

  const [periods,   setPeriods]   = useState([])
  const [period,    setPeriod]    = useState(null)
  const [employees, setEmployees] = useState([])
  const [holidays,  setHolidays]  = useState([])  // for auto-suggest OT type
  const [entries,   setEntries]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [statusTab, setStatusTab] = useState('all')
  const [form,      setForm]      = useState({ open: false, editing: null, ...BLANK })
  const [busy,      setBusy]      = useState(false)
  const [msg,       setMsg]       = useState('')
  const [drawerOpen, setDrawer]   = useState(false)

  // ── Initial load ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!clientId) return
    async function init() {
      setLoading(true)
      const today = getBsToday()
      const [{ data: p }, { data: emps }, { data: hols }] = await Promise.all([
        supabase.from('monthly_periods').select('*').eq('client_id', clientId)
          .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
        supabase.from('hr_employees').select('id, full_name, employee_code, pay_basis, basic_salary, status')
          .eq('client_id', clientId).in('status', ['active', 'probation']).order('full_name'),
        supabase.from('hr_holiday_calendar').select('bs_year, bs_month, bs_day, name, holiday_type')
          .eq('client_id', clientId),
      ])
      setPeriods(p || [])
      setEmployees(emps || [])
      setHolidays(hols || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      if (open) {
        setPeriod(open)
        await loadEntries(open.bs_year, open.bs_month)
        // default form month to current period
        setForm(f => ({ ...f, bs_year: open.bs_year, bs_month: open.bs_month }))
      } else {
        // no period yet — use today
        setForm(f => ({ ...f, bs_year: today.year, bs_month: today.month }))
      }
      setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line

  const loadEntries = useCallback(async (bsYear, bsMonth) => {
    const { data } = await supabase
      .from('hr_overtime_entries')
      .select('*')
      .eq('client_id', clientId)
      .eq('bs_year', bsYear)
      .eq('bs_month', bsMonth)
      .order('bs_day').order('created_at')
    setEntries(data || [])
  }, [clientId])

  async function handlePeriodChange(id) {
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setMsg('')
    await loadEntries(p.bs_year, p.bs_month)
    setForm(f => ({ ...f, bs_year: p.bs_year, bs_month: p.bs_month }))
  }

  // ── Holiday auto-suggest ──────────────────────────────────────────────────────
  function isHoliday(bs_year, bs_month, bs_day) {
    return holidays.some(h =>
      h.bs_year === bs_year && h.bs_month === bs_month && h.bs_day === bs_day && h.holiday_type === 'public'
    )
  }

  function onDateChange(field, value) {
    setForm(f => {
      const next = { ...f, [field]: parseInt(value, 10) || f[field] }
      const yr  = field === 'bs_year'  ? parseInt(value, 10) : f.bs_year
      const mo  = field === 'bs_month' ? parseInt(value, 10) : f.bs_month
      const dy  = field === 'bs_day'   ? parseInt(value, 10) : f.bs_day
      if (yr && mo && dy) next.ot_type = isHoliday(yr, mo, dy) ? 'holiday' : 'weekday'
      return next
    })
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────────
  function openAdd() {
    setForm(f => ({ ...f, open: true, editing: null, employee_id: '', ot_hours: '', reason: '', ot_type: 'weekday', bs_day: 1 }))
    setMsg(''); setDrawer(true)
  }
  function openEdit(e) {
    setForm({ open: true, editing: e, employee_id: e.employee_id, bs_year: e.bs_year, bs_month: e.bs_month, bs_day: e.bs_day, ot_hours: e.ot_hours, ot_type: e.ot_type, reason: e.reason || '' })
    setMsg(''); setDrawer(true)
  }
  function closeDrawer() { setDrawer(false); setForm(f => ({ ...f, open: false, editing: null })) }

  async function save() {
    if (!clientId) { setMsg('error:No client selected'); return }
    if (!form.employee_id) { setMsg('error:Select an employee'); return }
    const hrs = parseFloat(form.ot_hours)
    if (!hrs || hrs <= 0) { setMsg('error:Enter valid OT hours'); return }
    const bs_day = parseInt(form.bs_day, 10)
    const maxDay = daysInBsMonth(form.bs_year, form.bs_month)
    if (bs_day < 1 || bs_day > maxDay) { setMsg(`error:Day must be 1–${maxDay}`); return }

    setBusy(true); setMsg('')
    const payload = {
      client_id: clientId,
      employee_id: form.employee_id,
      bs_year: form.bs_year, bs_month: form.bs_month, bs_day,
      ot_hours: hrs,
      ot_type: form.ot_type,
      reason: form.reason.trim() || null,
      status: 'pending',
    }
    const { error } = form.editing
      ? await supabase.from('hr_overtime_entries').update({ ...payload, status: form.editing.status }).eq('id', form.editing.id)
      : await supabase.from('hr_overtime_entries').insert(payload)
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await loadEntries(form.bs_year, form.bs_month)
    closeDrawer(); setMsg('ok:Saved'); setBusy(false)
  }

  async function setStatus(id, status) {
    await supabase.from('hr_overtime_entries').update({ status }).eq('id', id)
    await loadEntries(period?.bs_year, period?.bs_month)
  }

  async function del(id) {
    if (!window.confirm('Delete this OT entry?')) return
    await supabase.from('hr_overtime_entries').delete().eq('id', id)
    await loadEntries(period?.bs_year, period?.bs_month)
  }

  // ── Derived ───────────────────────────────────────────────────────────────────
  const empMap = Object.fromEntries(employees.map(e => [e.id, e]))

  const filtered = entries.filter(e => statusTab === 'all' || e.status === statusTab)

  const pendingCount  = entries.filter(e => e.status === 'pending').length
  const approvedCount = entries.filter(e => e.status === 'approved').length
  const approvedHrs   = entries.filter(e => e.status === 'approved').reduce((s, e) => s + parseFloat(e.ot_hours || 0), 0)

  const maxDay = daysInBsMonth(form.bs_year, form.bs_month)

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'

  function otLabel(ot_type, ot_hours) {
    const mult = ot_type === 'holiday' ? OT_HOLIDAY_MULTIPLIER : OT_MULTIPLIER
    return `${ot_hours}h × ${mult}×`
  }

  // Estimated OT pay for one entry. Returns null if no salary data.
  function otAmt(entry, emp) {
    const basic = parseFloat(emp?.basic_salary) || 0
    if (!basic) return null
    const mult = entry.ot_type === 'holiday' ? OT_HOLIDAY_MULTIPLIER : OT_MULTIPLIER
    const hrs = parseFloat(entry.ot_hours) || 0
    const monthDays = daysInBsMonth(entry.bs_year, entry.bs_month)
    if (emp.pay_basis === 'hourly') return Math.round(hrs * basic * mult)
    if (emp.pay_basis === 'daily')  return Math.round(hrs * (basic / 8) * mult)
    return Math.round(hrs * (basic / (monthDays * 8)) * mult)
  }

  const approvedAmt = entries
    .filter(e => e.status === 'approved')
    .reduce((s, e) => { const a = otAmt(e, empMap[e.employee_id]); return a !== null ? s + a : s }, 0)

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Overtime</h1>
          <p className="page-subtitle">Log, approve, and track employee OT — feeds into payroll at 1.5× weekday / 2× public holiday</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('ok') ? '#34d399' : '#f87171' }}>{msg.split(':').slice(1).join(':')}</span>}
          <select className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card" style={pendingCount > 0 ? { cursor: 'pointer' } : undefined} onClick={() => pendingCount > 0 && setStatusTab('pending')}>
          <div className="stat-label">
            <Tip text="OT entries logged but not yet approved or rejected. Click to filter." width={240}>
              Pending Approval
            </Tip>
          </div>
          <div className="stat-value" style={{ color: pendingCount > 0 ? '#c9a84c' : '#34d399' }}>{pendingCount}</div>
          <div className="stat-sub">{periodLabel}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Approved OT entries this period — these are included in the payroll run." width={260}>
              Approved
            </Tip>
          </div>
          <div className="stat-value" style={{ color: '#34d399' }}>{approvedCount}</div>
          <div className="stat-sub">{approvedHrs > 0 ? `${approvedHrs}h total` : 'no hours'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Total approved OT hours this period across all employees." width={240}>
              Total OT Hours
            </Tip>
          </div>
          <div className="stat-value">{approvedHrs}</div>
          <div className="stat-sub">approved this period</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Estimated OT pay for all approved entries this period. Based on each employee's basic salary and OT multiplier. Employees with no salary on file are excluded." width={300}>
              Est. OT Cost
            </Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 18, color: '#c9a84c' }}>
            {approvedAmt > 0 ? `NPR ${approvedAmt.toLocaleString('en-NP')}` : '—'}
          </div>
          <div className="stat-sub">approved entries</div>
        </div>
      </div>

      {/* Status filter */}
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {['all', 'pending', 'approved', 'rejected'].map(s => (
          <button key={s} className={`tab-btn${statusTab === s ? ' tab-btn--active' : ''}`} onClick={() => setStatusTab(s)}>
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            {s !== 'all' && (
              <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.7 }}>
                ({entries.filter(e => e.status === s).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">⏱</div>
          <p className="empty-state-text">
            {entries.length === 0
              ? `No OT entries for ${periodLabel} yet. Click + Log OT to add one.`
              : 'No entries match the current filter.'}
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th style={{ textAlign: 'center' }}>
                    <Tip text="BS date the overtime was worked." width={180}>Date</Tip>
                  </th>
                  <th style={{ textAlign: 'center' }}>
                    <Tip text="Overtime hours worked. Weekday OT = 1.5× hourly rate. Public holiday OT = 2× hourly rate (Nepal Labour Act)." width={280}>Hours × Rate</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Estimated OT pay = hours × (basic ÷ days-in-month ÷ 8) × multiplier for monthly staff. Shown as '—' if no salary is on file." width={280}>Est. Amount</Tip>
                  </th>
                  <th>
                    <Tip text="Weekday = 1.5×. Holiday = 2× (gazetted public holiday). Auto-detected from your Holiday Calendar when logging." width={280}>Type</Tip>
                  </th>
                  <th>Reason</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(e => {
                  const emp = empMap[e.employee_id] || {}
                  const sc  = STATUS_COLORS[e.status] || STATUS_COLORS.pending
                  return (
                    <tr key={e.id}>
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 13 }}>{emp.full_name || '—'}</div>
                        {emp.employee_code && <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{emp.employee_code}</div>}
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--theme-text2)', fontSize: 12 }}>
                        {BS_MONTHS[e.bs_month - 1]} {e.bs_day}, {e.bs_year}
                      </td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: '#34d399' }}>
                        {otLabel(e.ot_type, e.ot_hours)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: '#c9a84c', fontSize: 13 }}>
                        {(() => { const a = otAmt(e, emp); return a !== null ? `NPR ${a.toLocaleString('en-NP')}` : <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}>—</span> })()}
                      </td>
                      <td>
                        <span className={e.ot_type === 'holiday' ? 'badge-amber' : 'badge-gray'} style={{ fontSize: 11 }}>
                          {e.ot_type === 'holiday' ? 'Holiday 2×' : 'Weekday 1.5×'}
                        </span>
                      </td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12, maxWidth: 200 }}>
                        {e.reason || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, color: sc.color, background: sc.bg, border: `1px solid ${sc.border}` }}>
                          {e.status.charAt(0).toUpperCase() + e.status.slice(1)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          {e.status === 'pending' && (
                            <>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px', color: '#34d399' }} onClick={() => setStatus(e.id, 'approved')}>Approve</button>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px', color: '#f87171' }} onClick={() => setStatus(e.id, 'rejected')}>Reject</button>
                            </>
                          )}
                          {e.status !== 'pending' && (
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => setStatus(e.id, 'pending')}>Undo</button>
                          )}
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => openEdit(e)}>Edit</button>
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px', color: '#f87171' }} onClick={() => del(e.id)}>Del</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.7 }}>
        <strong style={{ color: '#6b7280' }}>Payroll integration:</strong> only <strong>Approved</strong> entries feed into the payroll run.
        Approved weekday OT is paid at <strong>1.5×</strong> the normal hourly rate; public holiday OT at <strong>2×</strong>.
        Regenerate payroll after approving new entries to include them.
      </div>

      {/* Add / Edit drawer */}
      {drawerOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflowY: 'auto', padding: '40px 16px' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} onClick={closeDrawer} />
          <div style={{ position: 'relative', width: 480, maxWidth: '100%', background: '#141820', border: '1px solid #2a2f3d', borderRadius: 12, padding: 24 }}>
            <h2 style={{ margin: '0 0 18px', fontSize: 15, color: '#e8e0d0' }}>
              {form.editing ? 'Edit OT Entry' : 'Log Overtime'}
            </h2>

            {/* Employee */}
            <label style={lbl}>Employee *</label>
            <select
              className="form-select"
              style={{ width: '100%', marginBottom: 14 }}
              value={form.employee_id}
              onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
            >
              <option value="">— select employee —</option>
              {employees.map(e => (
                <option key={e.id} value={e.id}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ''}</option>
              ))}
            </select>

            {/* Date */}
            <label style={lbl}>
              <Tip text="BS date the overtime was worked. Date automatically detects if it falls on a public holiday from your Holiday Calendar." width={300}>
                Date (BS) *
              </Tip>
            </label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <select className="form-select" style={{ flex: 2 }} value={form.bs_year} onChange={e => onDateChange('bs_year', e.target.value)}>
                {[form.bs_year - 1, form.bs_year, form.bs_year + 1].filter(Boolean).map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <select className="form-select" style={{ flex: 3 }} value={form.bs_month} onChange={e => onDateChange('bs_month', e.target.value)}>
                {BS_MONTHS.map((name, i) => <option key={i + 1} value={i + 1}>{i + 1} — {name}</option>)}
              </select>
              <input
                type="number" min={1} max={maxDay}
                style={{ ...inp, flex: 1, textAlign: 'center' }}
                value={form.bs_day}
                onChange={e => onDateChange('bs_day', e.target.value)}
                placeholder="Day"
              />
            </div>

            {/* Hours */}
            <label style={lbl}>OT Hours *</label>
            <input
              type="number" min="0.5" step="0.5"
              style={{ ...inp, marginBottom: 14 }}
              value={form.ot_hours}
              onChange={e => setForm(f => ({ ...f, ot_hours: e.target.value }))}
              placeholder="e.g. 2.5"
            />

            {/* OT Type */}
            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>
                <Tip text="Auto-detected from the date: if the date matches a gazetted public holiday in your Holiday Calendar, Holiday (2×) is selected. You can override manually." width={300}>
                  OT Type *
                </Tip>
              </label>
              <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
                {[
                  { key: 'weekday', label: 'Weekday (1.5×)' },
                  { key: 'holiday', label: 'Public Holiday (2×)' },
                ].map(t => (
                  <label key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#e8e0d0' }}>
                    <input type="radio" name="ot_type" value={t.key} checked={form.ot_type === t.key} onChange={() => setForm(f => ({ ...f, ot_type: t.key }))} />
                    {t.label}
                  </label>
                ))}
              </div>
              {form.ot_type === 'holiday' && isHoliday(form.bs_year, form.bs_month, form.bs_day) && (
                <div style={{ fontSize: 11, color: '#c9a84c', marginTop: 6 }}>
                  ✓ {holidays.find(h => h.bs_year === form.bs_year && h.bs_month === form.bs_month && h.bs_day === form.bs_day)?.name}
                </div>
              )}
            </div>

            {/* Reason */}
            <label style={lbl}>Reason / Notes</label>
            <textarea
              rows={2}
              style={{ ...inp, resize: 'vertical', marginBottom: 14 }}
              value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="e.g. Event setup, Kitchen cover, Inventory count…"
            />

            {msg && <div style={{ marginBottom: 12, fontSize: 12, color: msg.startsWith('ok') ? '#34d399' : '#f87171' }}>{msg.split(':').slice(1).join(':')}</div>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={closeDrawer}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save OT Entry'}</button>
            </div>
          </div>
        </div>
      )}

      <Fab onClick={openAdd} label="+ Log OT" show={!drawerOpen} />
    </div>
  )
}
