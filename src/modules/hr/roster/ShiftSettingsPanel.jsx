import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import ConfirmModal from '../../../components/ConfirmModal'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { calcHours, hasUnknownHours } from './laborForecast'
import { fmtTime } from './rosterHelpers'
import { rosterDayShape } from '../attendance/attendanceFromRoster'
import { BS_MONTHS, adToBs, formatAd, formatAdAsBs } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'
import { STANDARD_HOURS_PER_DAY } from '../payrollConstants'

const EMPTY_FORM = { name: '', color: '#6B7280', start_time: '', end_time: '', hours: '', regular_hours: '' }

// Blank stays NULL — "the whole shift is normal time", the behaviour every shift had before S742.
function resolveRegular(val) {
  if (val === '' || val == null) return null
  const n = parseFloat(val)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// An AD 'YYYY-MM-DD' as its BS date, built from its parts (`new Date('YYYY-MM-DD')` is UTC midnight,
// the previous day at Nepal's +05:45). `offsetDays` moves it first: -1 is the day before.
function bsOfIso(iso, offsetDays = 0) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? adToBs(new Date(+m[1], +m[2] - 1, +m[3] + offsetDays)) : null
}
const bsLabel = bs => (bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : '—')

// Typed times move a stored Hours that was simply the old times' length (S798, ROSTER-1). The editor
// preloads the stored figure, so changing only the times used to move nothing: the panel then showed
// 10:00–21:00 beside 12h. A length typed apart from the times (a split shift's break) is kept.
function withTimes(prev, patch) {
  const next = { ...prev, ...patch }
  const typed = prev.hours === '' || prev.hours == null ? null : parseFloat(prev.hours)
  const oldLength = calcHours(prev.start_time || null, prev.end_time || null)
  if (typed != null && oldLength != null && Math.abs(typed - oldLength) < 0.05) {
    next.hours = calcHours(next.start_time || null, next.end_time || null) ?? ''
  }
  return next
}

export default function ShiftSettingsPanel({ clientId, shiftTypes, setShiftTypes, onRosterChanged }) {
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [editing, setEditing] = useState(null)
  const [adding,  setAdding]  = useState(false)
  const [form,    setForm]    = useState(EMPTY_FORM)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState(null)
  // Pending delete awaiting its ConfirmModal: { shift, run }. Only reachable for a shift type the
  // roster does not use (S749) — see deleteShift.
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [confirmBusy,    setConfirmBusy]    = useState(false)
  // An edit that changes pay on days not yet generated, waiting on "from which day?" (S798, ROSTER-1):
  // { shift, payload, days, firstDay, lastDay, fromIso }.
  const [split,     setSplit]     = useState(null)
  const [splitBusy, setSplitBusy] = useState(false)

  function resolveHours(startT, endT, hoursVal) {
    if (hoursVal !== '' && hoursVal != null) return parseFloat(hoursVal)
    return calcHours(startT || null, endT || null)
  }

  // S682: each write used to be `const { data } = …; if (data) …` and then closed the editor
  // regardless, so a refused write looked exactly like a saved one. On error the editor now stays
  // open with the values the manager typed, and the failure is shown.
  //
  // S798 (ROSTER-1, H12 (a)): hr_roster stores only the shift type, and Generate from Roster reads the
  // type as it is when it runs. So an edit that changes what a rostered day becomes (rosterDayShape:
  // its hours, Normal hrs, or what a zero-hour name means) used to re-price every earlier day of the
  // month not yet generated: shortening Full Day on the 15th paid the 1st–14th an hour short. Such an
  // edit now asks from which day it applies whenever earlier days are still to be generated, and
  // split_shift_type keeps the old values for the days before it. Any other edit saves as before.
  async function saveEdit() {
    if (!editing?.name?.trim()) return
    const orig = shiftTypes.find(s => s.id === editing.id)
    const payload = {
      name:       editing.name.trim(),
      color:      editing.color,
      start_time: editing.start_time || null,
      end_time:   editing.end_time   || null,
      hours:      resolveHours(editing.start_time, editing.end_time, editing.hours),
      regular_hours: resolveRegular(editing.regular_hours),
    }
    setSaving(true)
    setError(null)
    if (orig && rosterDayShape(orig) !== rosterDayShape({ ...orig, ...payload })) {
      const { data: counted, error: countErr } = await supabase.rpc('shift_type_days_to_generate', { p_shift_type_id: orig.id })
      if (countErr) {
        setSaving(false)
        const a = asActionError(countErr, 'operator')
        setError({ text: `Could not check whether "${orig.name}" has earlier days still to be put in Attendance, so nothing was saved. Reload to try again. ` + a.text, detail: a.detail })
        return
      }
      const row = Array.isArray(counted) ? counted[0] : counted
      if (row?.days > 0) {
        setSaving(false)
        const today = nepalCivilDate(new Date())
        setSplit({ shift: orig, payload, days: row.days, firstDay: row.first_day, lastDay: row.last_day, fromIso: today ? formatAd(today) : row.last_day })
        return
      }
    }
    const { data, error: err } = await scopedUpdate('hr_shift_types', payload).eq('id', editing.id).select().single()
    setSaving(false)
    if (err) { setError(asActionError(err, 'operator')); return }
    if (data) setShiftTypes(prev => prev.map(s => s.id === data.id ? data : s))
    setEditing(null)
  }

  // The name the old values keep for the days before the chosen one: "Full Day (until 14 Kartik 2083)",
  // made unique against the other shift types (the name is unique per client, case-insensitive).
  function archiveName(s, fromIso) {
    const base = `${s.name} (until ${bsLabel(bsOfIso(fromIso, -1))})`
    const taken = new Set(shiftTypes.filter(x => x.id !== s.id).map(x => String(x.name).trim().toLowerCase()))
    let name = base
    for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `${base} ${i}`
    return name
  }

  async function runSplit() {
    if (!split) return
    const from = bsOfIso(split.fromIso)
    if (!from) { setError('Pick the day the new values start from.'); return }
    const { shift, payload } = split
    setSplitBusy(true)
    setError(null)
    const { error: err } = await supabase.rpc('split_shift_type', {
      p_shift_type_id: shift.id, p_from_year: from.year, p_from_month: from.month, p_from_day: from.day,
      p_old_name: archiveName(shift, split.fromIso), p_name: payload.name, p_color: payload.color,
      p_start_time: payload.start_time, p_end_time: payload.end_time,
      p_hours: payload.hours, p_regular_hours: payload.regular_hours,
    })
    setSplitBusy(false)
    setSplit(null)
    // One transaction: on a refusal the shift type and the roster are exactly as they were.
    if (err) { setError(asActionError(err, 'operator')); return }
    setEditing(null)
    // Re-read: the split may have renamed one type and added another, and moved roster days.
    const { data, error: readErr } = await scopedFrom('hr_shift_types').order('sort_order')
    if (readErr) {
      const a = asActionError(readErr, 'operator')
      setError({ text: 'The change was saved, but the shift list could not be re-read. Reload the page to see it. ' + a.text, detail: a.detail })
    } else {
      setShiftTypes(data || [])
    }
    if (onRosterChanged) onRosterChanged()
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

  // Refused while the roster uses it (decided 2026-09-14). hr_roster.shift_type_id is ON DELETE SET
  // NULL, so the delete blanked those days, and Generate from Roster then read each blank row as a
  // zero-hour marker and wrote Off — a daily-wage employee's rostered working days stopped paying.
  // hr_shift_types_guard_delete refuses it too; this says so before anything is attempted, and a
  // count that could not be read refuses as well.
  async function deleteShift(s) {
    setError(null)
    const { count, error: countErr } = await scopedFrom('hr_roster', 'id', { count: 'exact', head: true }).eq('shift_type_id', s.id)
    if (countErr) {
      const a = asActionError(countErr, 'operator')
      setError({ text: `Could not check whether "${s.name}" is on the roster, so it was not deleted. Reload to try again. ` + a.text, detail: a.detail })
      return
    }
    if (count > 0) {
      setError(`"${s.name}" is on the roster for ${count} day${count === 1 ? '' : 's'}, so it cannot be deleted — deleting it would blank those days, and Generate from Roster would then mark them Off. Untick Active instead: it disappears from the shift picker and every assigned day keeps its shift.`)
      return
    }
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
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Shift Types</h2>
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
                          onChange={e => setEditing(p => withTimes(p, { start_time: e.target.value }))} />
                      </td>
                      <td>
                        <input type="time" id={`shift-end-${s.id}`} aria-label="Shift end time" className="form-input" style={{ width: 112 }} value={editing.end_time || ''}
                          onChange={e => setEditing(p => withTimes(p, { end_time: e.target.value }))} />
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
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {s.name}
                        {/* The old values of a shift whose hours changed part-way (S798, ROSTER-1). */}
                        {s.replaced_by && (
                          <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)' }}>
                            Earlier days only — from {formatAdAsBs(s.replaced_from)} the roster uses {shiftTypes.find(x => x.id === s.replaced_by)?.name || 'its replacement'}
                          </div>
                        )}
                      </td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.start_time ? fmtTime(s.start_time) : '—'}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{s.end_time   ? fmtTime(s.end_time)   : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                        {hasUnknownHours(s) ? (
                          <Tip text={`A working shift with no hours or times set. Attendance counts each of its days as an ordinary ${STANDARD_HOURS_PER_DAY}-hour day, with overtime only past ${STANDARD_HOURS_PER_DAY} hours. Set its hours, or its start and end, so each day is measured against the real shift.`} width={260}>
                            <span style={{ color: 'var(--theme-amber-text)' }}>△ not set</span>
                          </Tip>
                        ) : dispH != null ? `${dispH}h` : '—'}
                      </td>
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
        Each shift type needs its own name. A shift type used on the roster cannot be deleted — untick Active to retire it.
        Leave Hours blank to auto-calculate from start/end times. Overnight shifts (e.g. Night 21:00–07:00) wrap past midnight automatically.
        Normal hrs splits a long shift into normal time and overtime (e.g. 12h with 9 normal = 3h OT); blank means the whole shift is normal time.
        Attendance → Generate from Roster reads a zero-hour shift by its name: "PAID LEAVE" becomes Paid Leave, any other "LEAVE" becomes Unpaid Leave, "Holiday" becomes Holiday, and "OFF DAY" becomes Off.
        Changing a shift&apos;s hours, Normal hrs or what its name means, while earlier days on it are not yet in Attendance, asks from which day the change applies; the days before it keep the old values.
      </p>

      {split && (() => {
        const fromBs = bsOfIso(split.fromIso)
        const fromLabel = bsLabel(fromBs)
        const oldName = archiveName(split.shift, split.fromIso)
        const firstLabel = formatAdAsBs(split.firstDay)
        return (
          <ConfirmModal
            title={`Change "${split.shift.name}" from which day?`}
            confirmLabel={fromBs ? `Apply from ${fromLabel}` : 'Apply'}
            busy={splitBusy} busyLabel="Applying…"
            onConfirm={runSplit}
            onCancel={() => setSplit(null)}
          >
            <p style={{ margin: '0 0 10px' }}>
              &ldquo;{split.shift.name}&rdquo; is on the roster for <strong>{split.days}</strong> day{split.days === 1 ? '' : 's'} up to today that {split.days === 1 ? 'is' : 'are'} not in Attendance yet
              ({split.days === 1 ? firstLabel : `${firstLabel} to ${formatAdAsBs(split.lastDay)}`}). Generate from Roster fills those days with the shift as it is when it runs, so this change would alter their pay too.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <label htmlFor="shift-split-from" style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text1)' }}>New values start on</label>
              <BsCalendarPicker id="shift-split-from" value={split.fromIso} onChange={v => setSplit(p => ({ ...p, fromIso: v }))} />
              {split.firstDay && split.fromIso !== split.firstDay && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSplit(p => ({ ...p, fromIso: p.firstDay }))}>
                  From {firstLabel} (fixes a mistake on every one of them)
                </button>
              )}
            </div>
            <p style={{ margin: 0 }}>
              Days before {fromLabel} keep the current values, under the name &ldquo;{oldName}&rdquo;, which leaves the shift picker.
              From {fromLabel} on, the roster uses &ldquo;{split.payload.name}&rdquo; with the new values. Days already in Attendance do not change either way.
            </p>
          </ConfirmModal>
        )
      })()}

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
            Nothing on the roster uses it, so no day changes. It disappears from the shift picker, and a past
            swap request that named it shows a dash where the shift name was.
          </p>
          <p style={{ margin: 0 }}>To keep it for later, untick Active instead — an inactive shift type is hidden from the picker and can be switched back on.</p>
        </ConfirmModal>
      )}
    </div>
  )
}
