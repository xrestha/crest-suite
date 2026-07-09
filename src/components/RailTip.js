import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'

// Floating hover label for the icon rail — same createPortal technique as Tip.js (escapes the
// rail's own stacking context), but positioned to the right of the anchor rather than above/below
// text, and appears near-instantly instead of waiting on the browser's native title-attribute
// delay (~1s in Chrome). The rail's own layout never resizes on hover — only this portal element
// appears/disappears — so there's no reflow of .main-content's margin-transition on every hover.
export default function RailTip({ label, children }) {
  const [pos, setPos] = useState(null)
  const ref = useRef(null)

  function handleEnter() {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    setPos({ x: rect.right + 10, y: rect.top + rect.height / 2 })
  }

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex' }} onMouseEnter={handleEnter} onMouseLeave={() => setPos(null)}>
      {children}
      {pos && createPortal(
        <span className="rail-tip" style={{
          position: 'fixed', left: pos.x, top: pos.y, transform: 'translateY(-50%)',
          background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
          borderRadius: 6, padding: '5px 10px', fontSize: 'var(--font-size-nav-item)', fontWeight: 600,
          color: 'var(--theme-text1)', whiteSpace: 'nowrap', zIndex: 9999, pointerEvents: 'none',
          boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
        }}>
          {label}
        </span>,
        document.body
      )}
    </div>
  )
}
