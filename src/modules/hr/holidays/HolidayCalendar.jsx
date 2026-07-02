import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import Tip from '../../../components/Tip'
import { BS_MONTHS, getBsToday, daysInBsMonth } from '../../../utils/bsCalendar'
import { fiscalYearOf } from '../payroll/tds'

// Fixed-date Nepal gazetted public holidays (same BS date every year).
// yearOffset: 0 = same BS year as FY start (Shrawan year), 1 = following BS year.
const FIXED_HOLIDAYS = [
  { name: 'Constitution Day (Sambidhan Diwas)',         bs_month: 6,  bs_day: 3,  yearOffset: 0 },
  { name: "Prithvi Narayan Shah's Birthday",            bs_month: 9,  bs_day: 27, yearOffset: 0 },
  { name: "Martyrs' Day (Sahid Diwas)",                 bs_month: 10, bs_day: 5,  yearOffset: 0 },
  { name: 'National Democracy Day (Prajatantra Diwas)', bs_month: 11, bs_day: 7,  yearOffset: 0 },
  { name: 'Republic Day (Ganatantra Diwas)',            bs_month: 2,  bs_day: 15, yearOffset: 1 },
]

// Actual BS year for a holiday given FY start year and month.
function resolveYear(fyYear, bs_month) {
  return bs_month >= 4 ? fyYear : fyYear + 1
}

function fyLabel(fy) {
  return `FY ${fy}/${(fy + 1).toString().slice(2)}`
}

function fyYearsFrom(holidays) {
  const today = getBsToday()
  const curFy = fiscalYearOf(today.year, today.month).fyStart
  const set = new Set([curFy])
  holidays.forEach(h => set.add(fiscalYearOf(h.bs_year, h.bs_month).fyStart))
  return [...set].sort((a, b) => b - a)
}

const BLANK = { name: '', bs_month: 6, bs_day: 3, holiday_type: 'public' }

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

export default function HolidayCalendar() {
  const { clientId } = useAuth()
  const [holidays, setHolidays] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [fyYear,   setFyYear]   = useState(() => {
    const t = getBsToday()
    return fiscalYearOf(t.year, t.month).fyStart
  })
  const [form, setForm] = useState({ open: false, editing: null, ...BLANK })
  const [busy, setBusy] = useState(false)
  const [msg,  setMsg]  = useState('')

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const { data } = await supabase
      .from('hr_holiday_calendar')
      .select('*')
      .eq('client_id', clientId)
      .order('bs_year').order('bs_month').order('bs_day')
    setHolidays(data || [])
    setLoading(false)
  }, [clientId])

  useEffect(() => { load() }, [load])

  const fyYears = fyYearsFrom(holidays)
  if (!fyYears.includes(fyYear)) fyYears.unshift(fyYear)

  const fyHolidays = holidays
    .filter(h => fiscalYearOf(h.bs_year, h.bs_month).fyStart === fyYear)

  function openAdd() { setForm({ open: true, editing: null, ...BLANK }); setMsg('') }
  function openEdit(h) {
    setForm({ open: true, editing: h, name: h.name, bs_month: h.bs_month, bs_day: h.bs_day, holiday_type: h.holiday_type })
    setMsg('')
  }
  function closeForm() { setForm(f => ({ ...f, open: false, editing: null })) }

  async function saveForm() {
    if (!clientId) { setMsg('error:No client selected'); return }
    if (!form.name.trim()) { setMsg('error:Holiday name is required'); return }
    const bs_month = parseInt(form.bs_month, 10)
    const bs_day   = parseInt(form.bs_day, 10)
    const bs_year  = resolveYear(fyYear, bs_month)
    const maxDay   = daysInBsMonth(bs_year, bs_month)
    if (!bs_day || bs_day < 1 || bs_day > maxDay) {
      setMsg(`error:Day must be 1–${maxDay} for ${BS_MONTHS[bs_month - 1]}`); return
    }
    setBusy(true); setMsg('')
    const payload = { client_id: clientId, bs_year, bs_month, bs_day, name: form.name.trim(), holiday_type: form.holiday_type }
    const { error } = form.editing
      ? await supabase.from('hr_holiday_calendar').update(payload).eq('id', form.editing.id)
      : await supabase.from('hr_holiday_calendar').insert(payload)
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); closeForm(); setMsg('ok:Saved'); setBusy(false)
  }

  async function del(id) {
    if (!window.confirm('Delete this holiday?')) return
    await supabase.from('hr_holiday_calendar').delete().eq('id', id)
    await load()
  }

  async function seedFixed() {
    if (!clientId) { setMsg('error:No client selected'); return }
    const existingNames = new Set(fyHolidays.map(h => h.name))
    const toInsert = FIXED_HOLIDAYS
      .filter(h => !existingNames.has(h.name))
      .map(h => ({
        client_id: clientId,
        bs_year: fyYear + h.yearOffset,
        bs_month: h.bs_month,
        bs_day: h.bs_day,
        name: h.name,
        holiday_type: 'public',
      }))
    if (toInsert.length === 0) { setMsg('ok:All fixed holidays already added'); return }
    setBusy(true)
    const { error } = await supabase.from('hr_holiday_calendar').insert(toInsert)
    if (error) { setMsg('error:' + error.message); setBusy(false); return }
    await load(); setMsg(`ok:Added ${toInsert.length} fixed holiday${toInsert.length > 1 ? 's' : ''}`); setBusy(false)
  }

  const bs_month_form = parseInt(form.bs_month, 10)
  const bs_year_form  = resolveYear(fyYear, bs_month_form)
  const maxDay        = daysInBsMonth(bs_year_form, bs_month_form)

  const publicCount   = fyHolidays.filter(h => h.holiday_type === 'public').length
  const optionalCount = fyHolidays.filter(h => h.holiday_type === 'optional').length

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Holiday Calendar</h1>
          <p className="page-subtitle">Nepal public and optional holidays per fiscal year — used for OT rate and attendance reference</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('ok') ? '#34d399' : '#f87171' }}>{msg.split(':').slice(1).join(':')}</span>}
          <select
            className="form-select"
            value={fyYear}
            onChange={e => { setFyYear(parseInt(e.target.value, 10)); setMsg('') }}
          >
            {fyYears.map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
          </select>
          <Tip text="Adds 5 fixed-date Nepal gazetted holidays for this FY: Constitution Day (Ashwin 3), Prithvi Narayan Shah's Birthday (Poush 27), Martyrs' Day (Magh 5), Democracy Day (Falgun 7), Republic Day (Jestha 15). Movable holidays (Dashain, Tihar, Holi, etc.) must be added manually each year." width={340}>
            <button className="btn btn-ghost" onClick={seedFixed} disabled={busy} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              ＋ Seed Fixed
            </button>
          </Tip>
          <button className="btn btn-primary" onClick={openAdd} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
            + Add Holiday
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Gazetted public holidays — staff are entitled to the day off. Working on a public holiday attracts 2× overtime under the Nepal Labour Act." width={280}>
              Public Holidays
            </Tip>
          </div>
          <div className="stat-value" style={{ color: '#c9a84c' }}>{publicCount}</div>
          <div className="stat-sub">{fyLabel(fyYear)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Optional / floating holidays — not gazetted. Employees may be asked to work; the day off is at the employer's discretion." width={280}>
              Optional Holidays
            </Tip>
          </div>
          <div className="stat-value" style={{ color: '#818cf8' }}>{optionalCount}</div>
          <div className="stat-sub">{fyLabel(fyYear)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total</div>
          <div className="stat-value">{publicCount + optionalCount}</div>
          <div className="stat-sub">this fiscal year</div>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : fyHolidays.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📆</div>
          <p className="empty-state-text">
            No holidays for {fyLabel(fyYear)} yet.{' '}
            Click <strong>Seed Fixed</strong> to add the 5 fixed-date Nepal gazetted holidays, then add movable ones (Dashain, Tihar, Holi, etc.) manually.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 32, textAlign: 'center' }}>#</th>
                  <th>Holiday Name</th>
                  <th><Tip text="BS month the holiday falls in." width={160}>Month</Tip></th>
                  <th style={{ textAlign: 'center' }}>Day</th>
                  <th style={{ textAlign: 'center' }}>
                    <Tip text="The actual BS year of this date. Months 1–3 (Baishakh–Ashadh) belong to the second BS year of the fiscal year." width={280}>
                      BS Year
                    </Tip>
                  </th>
                  <th>
                    <Tip text="Public = gazetted (2× OT if staff work). Optional = floating, at employer discretion." width={260}>
                      Type
                    </Tip>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {fyHolidays.map((h, i) => (
                  <tr key={h.id}>
                    <td style={{ textAlign: 'center', color: 'var(--theme-text3)', fontSize: 11 }}>{i + 1}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{h.name}</td>
                    <td style={{ color: 'var(--theme-text2)' }}>{BS_MONTHS[h.bs_month - 1]}</td>
                    <td style={{ textAlign: 'center', color: 'var(--theme-text3)' }}>{h.bs_day}</td>
                    <td style={{ textAlign: 'center', color: 'var(--theme-text3)', fontSize: 12 }}>{h.bs_year}</td>
                    <td>
                      <span className={h.holiday_type === 'public' ? 'badge-amber' : 'badge-gray'} style={{ fontSize: 11 }}>
                        {h.holiday_type === 'public' ? 'Public' : 'Optional'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} onClick={() => openEdit(h)}>Edit</button>
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px', color: '#f87171' }} onClick={() => del(h.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: '#4b5563', lineHeight: 1.7 }}>
        <strong style={{ color: '#6b7280' }}>Nepal Labour Act — holiday OT:</strong> working on a gazetted public holiday entitles the employee to 2× the regular hourly rate. Optional holidays follow company policy.
        <br />Movable holidays (Dashain, Tihar, Holi, Buddha Jayanti, Teej, etc.) must be added manually each fiscal year from the Nepal government gazette.
      </div>

      {/* Add / Edit Modal */}
      {form.open && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflowY: 'auto', padding: '40px 16px' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.6)' }} onClick={closeForm} />
          <div style={{ position: 'relative', width: 460, maxWidth: '100%', background: '#141820', border: '1px solid #2a2f3d', borderRadius: 12, padding: 24 }}>
            <h2 style={{ margin: '0 0 18px', fontSize: 15, color: '#e8e0d0' }}>
              {form.editing ? 'Edit Holiday' : `Add Holiday — ${fyLabel(fyYear)}`}
            </h2>

            {/* Name */}
            <label style={lbl}>Holiday Name *</label>
            <input
              style={inp}
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Vijaya Dashami"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && saveForm()}
            />

            {/* Month + Day */}
            <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
              <div style={{ flex: 2 }}>
                <label style={lbl}>
                  <Tip text="Select the BS month. FY months 4–12 are Shrawan–Chaitra of the FY start year; months 1–3 are Baishakh–Ashadh of the following BS year." width={300}>
                    BS Month *
                  </Tip>
                </label>
                <select
                  className="form-select"
                  style={{ width: '100%' }}
                  value={form.bs_month}
                  onChange={e => setForm(f => ({ ...f, bs_month: parseInt(e.target.value, 10), bs_day: 1 }))}
                >
                  {BS_MONTHS.map((name, i) => (
                    <option key={i + 1} value={i + 1}>{i + 1} — {name}</option>
                  ))}
                </select>
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
                  stored as BS year {bs_year_form}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>Day *</label>
                <input
                  type="number"
                  style={{ ...inp, textAlign: 'center' }}
                  value={form.bs_day}
                  min={1}
                  max={maxDay}
                  onChange={e => setForm(f => ({ ...f, bs_day: e.target.value }))}
                />
                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4, textAlign: 'center' }}>
                  max {maxDay}
                </div>
              </div>
            </div>

            {/* Type */}
            <div style={{ marginTop: 14 }}>
              <label style={lbl}>
                <Tip text="Public = gazetted by Nepal government (all staff entitled to day off; 2× OT rate if worked). Optional = employer-discretion floating holiday." width={300}>
                  Holiday Type *
                </Tip>
              </label>
              <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
                {[{ key: 'public', label: 'Public (Gazetted)' }, { key: 'optional', label: 'Optional / Floating' }].map(t => (
                  <label key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: '#e8e0d0' }}>
                    <input
                      type="radio"
                      name="htype"
                      value={t.key}
                      checked={form.holiday_type === t.key}
                      onChange={() => setForm(f => ({ ...f, holiday_type: t.key }))}
                    />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>

            {msg && (
              <div style={{ marginTop: 12, fontSize: 12, color: msg.startsWith('ok') ? '#34d399' : '#f87171' }}>
                {msg.split(':').slice(1).join(':')}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-ghost" onClick={closeForm}>Cancel</button>
              <button className="btn btn-primary" onClick={saveForm} disabled={busy}>
                {busy ? 'Saving…' : 'Save Holiday'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
