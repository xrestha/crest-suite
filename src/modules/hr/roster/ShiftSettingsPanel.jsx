import { useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import ConfirmModal from '../../../components/ConfirmModal'
import { calcHours } from './laborForecast'
import { fmtTime } from './rosterHelpers'

const EMPTY_FORM = { name: '', color: '#6B7280', start_time: '', end_time: '', hours: '', regular_hours: '' }

// Blank stays NULL — "the whole shift is normal time", the behaviour every shift had before S742.
function resolveRegular(val) {
  if (val === '' || val == null) return null
  const n = parseFloat(val)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export default function ShiftSettingsPanel({ clientId, shiftTypes, setShiftTypes }) {
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [editing, setEditing] = useState(null)
  const [adding,  setAdding]  = useState(false)
  const [form,    setForm]    = useState(EMPTY_FORM)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState(null)
  // Pending delete awaiting its ConfirmModal: { shift, run }. A deleted shift type SET NULLs every
  // hr_roster row pointing at it (FK is ON DELETE SET NULL), so the confirm has to say that.
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [confirmBusy,    setConfirmBusy]    = useState(false)

  function resolveHours(startT, endT, hoursVal) {
    if (hoursVal !== '' && hoursVal != null) return parseFloat(hoursVal)
    return calcHours(startT || null, endT || null)
  }

  // S682: each write used to be `const { data } = …; if (data) …` and then closed the editor
  // regardless, so a refused write looked exactly like a saved one. On error the editor now stays
  // open with the values the manager typed, and the failure is shown.
  async function saveEdit() {
    if (!editing?.name?.trim()) return
    setSaving(true)
    setError(null)
    const { data, error: err } = await scopedUpdate('hr_shift_types', {
      name:       editing.name.trim(),
      color:      editing.color,
      start_time: editing.start_time || null,
      end_time:   editing.end_time   || null,
      hours:      resolveHours(editing.start_time, editing.end_time, editing.hours),
      regular_hours: resolveRegular(editing.regular_hours),
    }).eq('id', editing.id).select().single()
    setSaving(false)
    if (err) { setError(asActionError(err, 'operator')); return }
    if (data) setShiftTypes(prev => prev.map(s => s.id === data.id ? data : s))
    setEditing(null)
  }

  async function saveNew() {
    if (!form.name.trim() || !clientId) return
    setSaving(true)
    setError(null)
    const { data, error: err } = await scopedInsert('hr_shift_types', {
      name:       form.name.trim(),
      color:      form.color,
      start_time: form.start_time || null,
      end_time:   form.end_time   || null,
      hours:      resolveHours(form.start_time, form.end_time, form.hours),
      regular_hours: resolveRegular(form.regular_hours),
      sort_order: shiftTypes.length + 1,
    }, { single: true })
    setSaving(false)
    if (err) { setError(asActionError(err, 'operator')); return }
    if (data) {
      setShiftTypes(prev => [...prev, data])
      setForm(EMPTY_FORM)
      setAdding(false)
    }
  }

  async function toggleActive(s) {
    setError(null)
    const { data, error: err } = await scopedUpdate('hr_shift_types', { active: !s.active }).eq('id', s.id).select().single()
    if (err) { setError(asActionError(err, 'operator')); return }
    if (data) setShiftTypes(prev => prev.map(x => x.id === data.id ? data : x))
  }

  function deleteShift(s) {
    setPendingConfirm({
      shift: s,
      run: async () => {
        setError(null)
        const { error: err } = await scopedDelete('hr_shift_types').eq('id', s.id)
        if (err) { setError(asActionError(err, 'operator')); return }
        setShiftTypes(prev => prev.filter(x => x.id !== s.id))
      },
    })
  }

  async function runPendingConfirm() {
    if (!pendingConfirm) return
    setConfirmBusy(true)
    try { await pendingConfirm.run() } finally { setConfirmBusy(false); setPendingConfirm(null) }
  }

  // Inline auto-hint for hours field
  function HoursHint({ startT, endT, val }) {
    if (val !== '' && val != null) return null
    const c = calcHours(startT, endT)
    if (c == null) return <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>auto</span>
    return <span style={{ fontSize: 10, color: 'var(--theme-accent-ink)' }}>= {c}h</span>
  }

  // What the Normal hours box means for this shift, in the only unit a manager cares about.
  function OvertimeHint({ startT, endT, hoursVal, regularVal }) {
    const regular = resolveRegular(regularVal)
    if (regular == null) return null
    const length = resolveHours(startT, endT, hoursVal)
    if (length == null) return null
    const ot = Math.max(0, parseFloat((length - regular).toFixed(1)))
    return <span style={{ fontSize: 10, color: ot > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>{ot > 0 ? `+${ot}h OT` : 'no OT'}</span>
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
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            + Add Shift
          </button>
        )}
      </div>

      <ActionError error={error} />

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
              <th style={{ textAlign: 'right' }}>
                <Tip text="How many of this shift's hours are paid as normal time. Anything beyond them is overtime. Example: Full Day 8am–8pm is 12 hours; put 9 here and every Full Day carries 3 hours of overtime — Generate from Roster fills it in, and a punched 8am–8pm counts it. Counted in clock time, lunch included. Leave blank if the whole shift is normal time." width={300}>Normal hrs</Tip>
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
                        <input type="color" id={`shift-color-${s.id}`} aria-label="Shift colour" value={editing.color}
                          onChange={e => setEditing(p => ({ ...p, color: e.target.value }))}
                          style={{ width: 34, height: 28, border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', padding: 2, background: 'none' }} />
                      </td>
                      <td>
                        <input id={`shift-name-${s.id}`} aria-label="Shift name" className="form-input" style={{ minWidth: 120 }} value={editing.name}
                          onChange={e => setEditing(p => ({ ...p, name: e.target.value }))} />
                      </td>
                      <td>
                        <input type="time" id={`shift-start-${s.id}`} aria-label="Shift start time" className="form-input" style={{ width: 112 }} value={editing.start_time || ''}
                          onChange={e => setEditing(p => ({ ...p, start_time: e.target.value }))} />
                      </td>
                      <td>
                        <input type="time" id={`shift-end-${s.id}`} aria-label="Shift end time" className="form-input" style={{ width: 112 }} value={editing.end_time || ''}
                          onChange={e => setEditing(p => ({ ...p, end_time: e.target.value }))} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <HoursHint startT={editing.start_time} endT={editing.end_time} val={editing.hours} />
                          <input type="number" id={`shift-hours-${s.id}`} aria-label="Shift hours (blank to auto-calculate)"
                            className="form-input" style={{ width: 64 }} step="0.5" min="0" max="24"
                            placeholder="auto" value={editing.hours ?? ''}
                            onChange={e => setEditing(p => ({ ...p, hours: e.target.value }))} />
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                          <OvertimeHint startT={editing.start_time} endT={editing.end_time} hoursVal={editing.hours} regularVal={editing.regular_hours} />
                          <input type="number" id={`shift-regular-${s.id}`} aria-label="Normal hours before overtime (blank if the whole shift is normal time)"
                            className="form-input" style={{ width: 64 }} step="0.5" min="0" max="24"
                            placeholder="all" value={editing.regular_hours ?? ''}
                            onChange={e => setEditing(p => ({ ...p, regular_hours: e.target.value }))} />
                        </div>
                      </td>
                      <td />
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm"
                            onClick={saveEdit} disabled={saving || !editing.name?.trim()}>Save</button>
                          <button className="btn btn-ghost btn-sm"
                            onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <span style={{ display: 'inline-block', width: 22, height: 22, borderRadius: 'var(--radius-xs)', background: s.color }} />
                      </td>
                      {/* The shift's own hue is already carried by the swatch in the Color cell
                          immediately to the left, so the name doesn't need to repeat it — and
                          repeating it put an arbitrary user-picked colour on plain card as 13px
                          type, which no palette can guarantee reads. */}
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{s.name}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.start_time ? fmtTime(s.start_time) : '—'}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.end_time   ? fmtTime(s.end_time)   : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{dispH != null ? `${dispH}h` : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                        {s.regular_hours != null ? (
                          <>
                            {`${s.regular_hours}h`}
                            {dispH != null && dispH > s.regular_hours && (
                              <div style={{ fontSize: 10, color: 'var(--theme-accent-ink)' }}>+{parseFloat((dispH - s.regular_hours).toFixed(1))}h OT</div>
                            )}
                          </>
                        ) : <span style={{ color: 'var(--theme-text3)' }}>all</span>}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" aria-label={`${s.name} active`} checked={s.active !== false} onChange={() => toggleActive(s)} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-ghost btn-sm"
                            onClick={() => setEditing({ ...s, hours: s.hours ?? '', regular_hours: s.regular_hours ?? '' })}>Edit</button>
                          <button className="btn btn-danger btn-sm"
                            onClick={() => deleteShift(s)}>Delete</button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              )
            })}

            {shiftTypes.length === 0 && !adding && (
              <tr>
                <td colSpan={8} style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
                  No shift types yet. The roster board has nothing to assign until you add one —
                  click <strong style={{ color: 'var(--theme-text2)' }}>+ Add Shift</strong> to start.
                </td>
              </tr>
            )}

            {adding && (
              <tr>
                <td>
                  <input type="color" aria-label="Shift colour" value={form.color}
                    onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                    style={{ width: 34, height: 28, border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer', padding: 2, background: 'none' }} />
                </td>
                <td>
                  <input className="form-input" style={{ minWidth: 120 }} placeholder="e.g. Morning" aria-label="Shift name"
                    value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                </td>
                <td>
                  <input type="time" aria-label="Shift start time" className="form-input" style={{ width: 112 }} value={form.start_time}
                    onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))} />
                </td>
                <td>
                  <input type="time" aria-label="Shift end time" className="form-input" style={{ width: 112 }} value={form.end_time}
                    onChange={e => setForm(p => ({ ...p, end_time: e.target.value }))} />
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <HoursHint startT={form.start_time} endT={form.end_time} val={form.hours} />
                    <input type="number" aria-label="Shift hours (blank to auto-calculate)" className="form-input" style={{ width: 64 }} step="0.5" min="0" max="24"
                      placeholder="auto" value={form.hours}
                      onChange={e => setForm(p => ({ ...p, hours: e.target.value }))} />
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                    <OvertimeHint startT={form.start_time} endT={form.end_time} hoursVal={form.hours} regularVal={form.regular_hours} />
                    <input type="number" aria-label="Normal hours before overtime (blank if the whole shift is normal time)" className="form-input" style={{ width: 64 }} step="0.5" min="0" max="24"
                      placeholder="all" value={form.regular_hours}
                      onChange={e => setForm(p => ({ ...p, regular_hours: e.target.value }))} />
                  </div>
                </td>
                <td />
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-primary btn-sm"
                      onClick={saveNew} disabled={saving || !form.name.trim()}>Add</button>
                    <button className="btn btn-ghost btn-sm"
                      onClick={() => { setAdding(false); setForm(EMPTY_FORM) }}>
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
        Normal hrs splits a long shift into normal time and overtime (e.g. 12h with 9 normal = 3h OT); blank means the whole shift is normal time.
        Attendance → Generate from Roster reads a zero-hour shift by its name: "PAID LEAVE" becomes Paid Leave, any other "LEAVE" becomes Unpaid Leave, "Holiday" becomes Holiday, and "OFF DAY" becomes Off.
      </p>

      {pendingConfirm && (
        <ConfirmModal
          title={`Delete the "${pendingConfirm.shift.name}" shift type?`}
          confirmLabel="Delete Shift Type"
          danger
          busy={confirmBusy} busyLabel="Deleting…"
          onConfirm={runPendingConfirm}
          onCancel={() => setPendingConfirm(null)}
        >
          <p style={{ margin: '0 0 8px' }}>
            Every roster cell that uses it goes blank — the days stay on the board with no shift assigned, and the
            hours it carried drop out of the labour forecast and Attendance → Generate from Roster.
          </p>
          <p style={{ margin: 0 }}>To keep the history, untick Active instead: an inactive shift type is hidden from the picker but existing assignments are preserved.</p>
        </ConfirmModal>
      )}
    </div>
  )
}
