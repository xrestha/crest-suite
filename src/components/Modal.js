import { useEffect, useId, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Centered modal overlay — hosts a create/edit form so it pops up in front of the
// user instead of rendering at the top of the page (no scrolling to reach it).
// Backdrop click and the × button both call onClose; the panel itself stops propagation.
export default function Modal({ onClose, title, headerExtra, children, maxWidth = 960 }) {
  const titleId = useId()
  const panelRef = useRef(null)
  const triggerRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    // Remember whatever had focus before the modal opened (the button that triggered it)
    // so it can be restored on close instead of leaving focus on a now-removed element.
    triggerRef.current = document.activeElement
    const panel = panelRef.current
    const focusable = panel?.querySelector(FOCUSABLE)
    ;(focusable || panel)?.focus()

    const onKeyDown = e => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      // Trap Tab within the panel — without this, keyboard focus can walk out into the
      // page behind the overlay, which is only visually obscured, not actually inert.
      if (e.key === 'Tab' && panel) {
        const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null)
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      triggerRef.current?.focus?.()
    }
    // Deliberately mount-only: `onClose` is almost always a fresh inline arrow function from the
    // caller, so depending on it here would re-run this effect (and re-steal focus into the panel's
    // first field) on every parent re-render — e.g. every keystroke in a controlled form field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      onClick={onClose}
      className="no-print"
      style={{
        position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.6)',
        overflowY: 'auto', padding: '40px 16px',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      }}
    >
      <div
        ref={panelRef}
        onClick={e => e.stopPropagation()}
        className="card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width: '100%', maxWidth, margin: 'auto', outline: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 id={titleId} style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>{title}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: -4 }}>
            {headerExtra}
            <button
              className="btn btn-ghost"
              style={{ fontSize: 18, lineHeight: 1, padding: '2px 10px' }}
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >×</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
