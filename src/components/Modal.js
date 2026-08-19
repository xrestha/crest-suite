import { useEffect, useId, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Stack of currently-open modals, outermost first. Both Escape and the Tab trap listen on
// `document`, so with two Modals open (e.g. a typed-name confirm inside ClientDrawer) BOTH
// handlers fired on every keypress — one Escape closed the confirm AND the drawer behind it,
// and two competing Tab traps fought over focus. Only the modal on top of this stack responds;
// the ones beneath ignore keys until it closes (S574).
const modalStack = []

// Centered modal overlay — hosts a create/edit form so it pops up in front of the
// user instead of rendering at the top of the page (no scrolling to reach it).
// Backdrop click and the × button both call onClose; the panel itself stops propagation.
//
// `zIndex` (default 100) exists because POS's order screen is a `position: fixed` full-screen
// layer at 1000 and therefore its own stacking context: a dialog opened from it needs a higher
// value or it renders *underneath* the screen that opened it. That is precisely why POS grew nine
// hand-rolled overlays instead of using this component, so raising it is what lets them come back.
// Keep the default — a page-level dialog at 1100 would sit over the command palette and toasts.
//
// `unstyled` hands the panel to the caller: no `.card`, no title bar, no padding, just the
// overlay plus the behaviour that actually matters (focus capture and restore, the Tab trap, the
// Escape stack, `role="dialog"`). It is for a dialog whose shape genuinely is not a card — POS's
// two-column billing modal with a live bill preview down one side, and its shift-close counting
// sheet. `title` is then the accessible name rather than a rendered heading, so a dialog can never
// go unnamed either way. Reach for it only when the standard card shape would have to be undone.
export default function Modal({
  onClose, title, headerExtra, children, maxWidth = 960,
  zIndex = 100, unstyled = false, panelStyle,
}) {
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

    const stackToken = {}
    modalStack.push(stackToken)

    const onKeyDown = e => {
      if (modalStack[modalStack.length - 1] !== stackToken) return
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
      const i = modalStack.indexOf(stackToken)
      if (i !== -1) modalStack.splice(i, 1)
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
        position: 'fixed', inset: 0, zIndex, background: 'rgba(0,0,0,0.6)',
        overflowY: 'auto', padding: unstyled ? 16 : '40px 16px',
        display: 'flex', alignItems: unstyled ? 'center' : 'flex-start', justifyContent: 'center',
      }}
    >
      <div
        ref={panelRef}
        onClick={e => e.stopPropagation()}
        className={unstyled ? undefined : 'card'}
        role="dialog"
        aria-modal="true"
        {...(unstyled ? { 'aria-label': title } : { 'aria-labelledby': titleId })}
        tabIndex={-1}
        style={unstyled
          ? { outline: 'none', ...panelStyle }
          : { width: '100%', maxWidth, margin: 'auto', outline: 'none' }}
      >
        {!unstyled && (
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
        )}
        {children}
      </div>
    </div>
  )
}
