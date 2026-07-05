import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { calcHours } from './laborForecast'
import { fmtTime } from './rosterHelpers'

export default function ShiftPicker({ shifts, anchorRef, onSelect, onClose, cellCount = 1 }) {
  const ref = useRef()

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
  let left = rect.left
  if (left + 210 > window.innerWidth)  left = window.innerWidth - 218
  if (top  + 320 > window.innerHeight) top  = rect.top - 320

  const active = shifts.filter(s => s.active !== false)

  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', top, left, zIndex: 2100,
      background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
      borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
      minWidth: 200, overflow: 'hidden',
    }}>
      {cellCount > 1 && (
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--theme-text3)',
          borderBottom: '1px solid var(--theme-border)', fontWeight: 600 }}>
          Apply to {cellCount} cells
        </div>
      )}
      {active.map(s => {
        const hrs = s.hours ?? calcHours(s.start_time, s.end_time)
        return (
          <button key={s.id} onClick={() => onSelect(s.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '9px 14px', background: 'none', border: 'none',
              cursor: 'pointer', color: 'var(--theme-text1)', fontSize: 13, textAlign: 'left' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none'}
          >
            <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1, fontWeight: 500 }}>{s.name}</span>
            {s.start_time && <span style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{fmtTime(s.start_time)}</span>}
            {hrs != null && <span style={{ fontSize: 11, color: 'var(--theme-text3)', fontWeight: 600 }}>{hrs}h</span>}
          </button>
        )
      })}
      <div style={{ borderTop: '1px solid var(--theme-border)', padding: '2px 0' }}>
        <button onClick={() => onSelect(null)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%',
            padding: '8px 14px', background: 'none', border: 'none',
            cursor: 'pointer', color: 'var(--theme-text3)', fontSize: 12 }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}
        >
          <span style={{ width: 12, height: 12, borderRadius: 3, border: '1px dashed var(--theme-text3)', flexShrink: 0 }} />
          Clear (Day Off)
        </button>
      </div>
    </div>,
    document.body
  )
}
