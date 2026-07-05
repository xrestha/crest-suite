import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { calcHours } from './laborForecast'

// "who should cover this short-staffed day" — two-step: rank employees not already scheduled
// that day (fewest hours scheduled this period first — the candidate pool is whatever the
// board's current Department filter shows, so "same department" comes for free without a
// separate department concept on shifts/days), then pick a shift type for whoever is chosen.
// Reuses the same visual language as ShiftPicker.
export default function SuggestPopover({ candidates, shiftTypes, anchorRef, onAssign, onClose }) {
  const ref = useRef()
  const [pickedEmp, setPickedEmp] = useState(null)

  useEffect(() => {
    function onDown(e) {
      if (
        ref.current && !ref.current.contains(e.target) &&
        anchorRef.current && !anchorRef.current.contains(e.target)
      ) onClose()
    }
    function onKey(e) { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, anchorRef])

  const rect = anchorRef.current?.getBoundingClientRect()
  if (!rect) return null

  let top  = rect.bottom + 6
  let left = rect.left - 100
  if (left < 8) left = 8
  if (left + 240 > window.innerWidth)  left = window.innerWidth - 248
  if (top  + 320 > window.innerHeight) top  = rect.top - 320

  const active = shiftTypes.filter(s => s.active !== false)
  const rowBtn = {
    display: 'flex', alignItems: 'center', width: '100%',
    padding: '9px 14px', background: 'none', border: 'none',
    cursor: 'pointer', color: 'var(--theme-text1)', fontSize: 13, textAlign: 'left',
  }

  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', top, left, zIndex: 2100,
      background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
      borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
      minWidth: 230, maxHeight: 340, overflowY: 'auto',
    }}>
      {!pickedEmp ? (
        <>
          <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--theme-text3)', borderBottom: '1px solid var(--theme-border)', fontWeight: 600 }}>
            Suggested — fewest hours scheduled this period
          </div>
          {candidates.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
              Everyone in this view is already scheduled that day.
            </div>
          ) : candidates.slice(0, 8).map(emp => (
            <button key={emp.id} onClick={() => setPickedEmp(emp)}
              style={{ ...rowBtn, justifyContent: 'space-between', gap: 10 }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              <span>
                {emp.full_name}
                {emp.department && <span style={{ color: 'var(--theme-text3)', fontSize: 11 }}> · {emp.department}</span>}
              </span>
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', fontWeight: 600, flexShrink: 0 }}>{emp.hrsThisPeriod}h</span>
            </button>
          ))}
        </>
      ) : (
        <>
          <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--theme-text3)', borderBottom: '1px solid var(--theme-border)',
            fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Shift for {pickedEmp.full_name}</span>
            <span style={{ cursor: 'pointer', color: 'var(--theme-accent)' }} onClick={() => setPickedEmp(null)}>‹ back</span>
          </div>
          {active.map(s => {
            const hrs = s.hours ?? calcHours(s.start_time, s.end_time)
            return (
              <button key={s.id} onClick={() => onAssign(pickedEmp.id, s.id)}
                style={{ ...rowBtn, gap: 10 }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                <span style={{ flex: 1, fontWeight: 500 }}>{s.name}</span>
                {hrs != null && <span style={{ fontSize: 11, color: 'var(--theme-text3)', fontWeight: 600 }}>{hrs}h</span>}
              </button>
            )
          })}
        </>
      )}
    </div>,
    document.body
  )
}
