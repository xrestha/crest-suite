import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'

export default function Tip({ text, children, width = 220, style }) {
  const [pos, setPos] = useState(null)
  const ref = useRef(null)

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const clampedX = Math.min(Math.max(x, width / 2 + 8), window.innerWidth - width / 2 - 8)
      // Default is above the anchor — flip below when there isn't enough headroom (e.g. a
      // tooltip on a page heading sitting right under the topbar), same edge-flip pattern
      // ShiftPicker/SearchableSelect already use for their own dropdowns.
      const below = rect.top < 120
      setPos({ x: clampedX, y: below ? rect.bottom : rect.top, below })
    }
  }

  return (
    <span
      ref={ref}
      style={{ position: 'relative', cursor: 'help', borderBottom: '1px dashed #4b5563', display: 'inline', ...style }}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && createPortal(
        <span style={{
          position: 'fixed',
          top: pos.below ? pos.y + 6 : pos.y - 6,
          left: pos.x,
          transform: pos.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
          background: 'var(--theme-card)',
          border: '1px solid var(--theme-border)',
          borderRadius: 6,
          padding: '7px 11px',
          fontSize: 11,
          color: 'var(--theme-text2)',
          width,
          whiteSpace: 'normal',
          zIndex: 9999,
          pointerEvents: 'none',
          boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
          lineHeight: 1.6,
          display: 'block'
        }}>
          {text}
        </span>,
        document.body
      )}
    </span>
  )
}
