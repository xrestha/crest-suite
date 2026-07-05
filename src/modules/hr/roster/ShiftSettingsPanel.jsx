import { useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import { calcHours } from './laborForecast'
import { fmtTime } from './rosterHelpers'

const INP = {
  background: 'var(--theme-input-bg)',
  border: '1px solid var(--theme-border)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  color: 'var(--theme-text1)',
  outline: 'none',
  fontFamily: 'inherit',
}

export default function ShiftSettingsPanel({ clientId, shiftTypes, setShiftTypes }) {
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [editing, setEditing] = useState(null)
  const [adding,  setAdding]  = useState(false)
  const [form,    setForm]    = useState({ name: '', color: '#6B7280', start_time: '', end_time: '', hours: '' })
  const [saving,  setSaving]  = useState(false)

  function resolveHours(startT, endT, hoursVal) {
    if (hoursVal !== '' && hoursVal != null) return parseFloat(hoursVal)
    return calcHours(startT || null, endT || null)
  }

  async function saveEdit() {
    if (!editing?.name?.trim()) return
    setSaving(true)
    const { data } = await scopedUpdate('hr_shift_types', {
      name:       editing.name.trim(),
      color:      editing.color,
      start_time: editing.start_time || null,
      end_time:   editing.end_time   || null,
      hours:      resolveHours(editing.start_time, editing.end_time, editing.hours),
    }).eq('id', editing.id).select().single()
    if (data) setShiftTypes(prev => prev.map(s => s.id === data.id ? data : s))
    setEditing(null)
    setSaving(false)
  }

  async function saveNew() {
    if (!form.name.trim() || !clientId) return
    setSaving(true)
    const { data } = await scopedInsert('hr_shift_types', {
      name:       form.name.trim(),
      color:      form.color,
      start_time: form.start_time || null,
      end_time:   form.end_time   || null,
      hours:      resolveHours(form.start_time, form.end_time, form.hours),
      sort_order: shiftTypes.length + 1,
    }, { single: true })
    if (data) {
      setShiftTypes(prev => [...prev, data])
      setForm({ name: '', color: '#6B7280', start_time: '', end_time: '', hours: '' })
      setAdding(false)
    }
    setSaving(false)
  }

  async function toggleActive(s) {
    const { data } = await scopedUpdate('hr_shift_types', { active: !s.active }).eq('id', s.id).select().single()
    if (data) setShiftTypes(prev => prev.map(x => x.id === data.id ? data : x))
  }

  async function deleteShift(id) {
    if (!window.confirm('Delete this shift type? Roster entries that use it will appear blank.')) return
    await scopedDelete('hr_shift_types').eq('id', id)
    setShiftTypes(prev => prev.filter(s => s.id !== id))
  }

  // Inline auto-hint for hours field
  function HoursHint({ startT, endT, val }) {
    if (val !== '' && val != null) return null
    const c = calcHours(startT, endT)
    if (c == null) return <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>auto</span>
    return <span style={{ fontSize: 10, color: 'var(--theme-accent)' }}>= {c}h</span>
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Shift Types</h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>
            Customize the shift templates shown on the roster board
          </p>
        </div>
        {!adding && (
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => setAdding(true)}>
            + Add Shift
          </button>
        )}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 44 }}>Color</th>
              <th>Name</th>
              <th><Tip text="When the shift starts (24-hour time). Used for display on the roster board.">Start</Tip></th>
              <th><Tip text="When the shift ends. Overnight shifts (e.g. 21:00–07:00) wrap correctly.">End</Tip></th>
              <th style={{ textAlign: 'right' }}>
                <Tip text="Total hours for this shift. Auto-calculated from start/end times if left blank. Set manually for split or flexible shifts.">Hours</Tip>
              </th>
              <th style={{ textAlign: 'center' }}>
                <Tip text="Inactive shifts are hidden from the picker but existing roster assignments are preserved.">Active</Tip>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shiftTypes.map(s => {
              const compH  = calcHours(s.start_time, s.end_time)
              const dispH  = s.hours ?? compH
              const isEd   = editing?.id === s.id

              return (
                <tr key={s.id}>
                  {isEd ? (
                    <>
                      <td>
                        <input type="color" value={editing.color}
                          onChange={e => setEditing(p => ({ ...p, color: e.target.value }))}
                          style={{ width: 34, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 2, background: 'none' }} />
                      </td>
                      <td>
                        <input style={{ ...INP, minWidth: 120 }} value={editing.name}
                          onChange={e => setEditing(p => ({ ...p, name: e.target.value }))} />
                      </td>
                      <td>
                        <input type="time" style={{ ...INP, width: 112 }} value={editing.start_time || ''}
                          onChange={e => setEditing(p => ({ ...p, start_time: e.target.value }))} />
                      </td>
                      <td>
                        <input type="time" style={{ ...INP, width: 112 }} value={editing.end_time || ''}
                          onChange={e => setEditing(p => ({ ...p, end_time: e.target.value }))} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <HoursHint startT={editing.start_time} endT={editing.end_time} val={editing.hours} />
                          <input type="number" style={{ ...INP, width: 64 }} step="0.5" min="0" max="24"
                            placeholder="auto" value={editing.hours ?? ''}
                            onChange={e => setEditing(p => ({ ...p, hours: e.target.value }))} />
                        </div>
                      </td>
                      <td />
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={saveEdit} disabled={saving || !editing.name?.trim()}>Save</button>
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <span style={{ display: 'inline-block', width: 22, height: 22, borderRadius: 4, background: s.color }} />
                      </td>
                      <td style={{ fontWeight: 600, color: s.color }}>{s.name}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.start_time ? fmtTime(s.start_time) : '—'}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.end_time   ? fmtTime(s.end_time)   : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{dispH != null ? `${dispH}h` : '—'}</td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={s.active !== false} onChange={() => toggleActive(s)} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost" style={{ fontSize: 11 }}
                            onClick={() => setEditing({ ...s, hours: s.hours ?? '' })}>Edit</button>
                          <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red)' }}
                            onClick={() => deleteShift(s.id)}>Delete</button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}

            {adding && (
              <tr>
                <td>
                  <input type="color" value={form.color}
                    onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                    style={{ width: 34, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', padding: 2, background: 'none' }} />
                </td>
                <td>
                  <input style={{ ...INP, minWidth: 120 }} placeholder="e.g. Morning"
                    value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                </td>
                <td>
                  <input type="time" style={{ ...INP, width: 112 }} value={form.start_time}
                    onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))} />
                </td>
                <td>
                  <input type="time" style={{ ...INP, width: 112 }} value={form.end_time}
                    onChange={e => setForm(p => ({ ...p, end_time: e.target.value }))} />
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <HoursHint startT={form.start_time} endT={form.end_time} val={form.hours} />
                    <input type="number" style={{ ...INP, width: 64 }} step="0.5" min="0" max="24"
                      placeholder="auto" value={form.hours}
                      onChange={e => setForm(p => ({ ...p, hours: e.target.value }))} />
                  </div>
                </td>
                <td />
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={saveNew} disabled={saving || !form.name.trim()}>Add</button>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                      onClick={() => { setAdding(false); setForm({ name: '', color: '#6B7280', start_time: '', end_time: '', hours: '' }) }}>
                      Cancel
                    </button>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 10, marginBottom: 0 }}>
        Leave Hours blank to auto-calculate from start/end times. Overnight shifts (e.g. Night 21:00–07:00) wrap past midnight automatically.
      </p>
    </div>
  )
}
