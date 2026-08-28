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
//
// `variant="sheet"` docks the panel to the bottom edge of the screen instead of centring it — the
// phone form for a long form, used by the Crest Staff employee portal. It is three style
// expressions and a class, NOT a second component, because the focus trap, the Escape stack,
// `role="dialog"` and focus restoration above are exactly what a sheet needs too and a separate
// primitive would have to reimplement all four. Size, the rounded top edge, the safe-area padding
// and the slide-up live in `.modal-sheet` (Layout.css) — the animation in particular cannot be an
// inline style, or `prefers-reduced-motion` could never switch it off.
export default function Modal({
  onClose, title, headerExtra, children, maxWidth = 960,
  zIndex = 100, unstyled = false, panelStyle, variant,
}) {
  const sheet = variant === 'sheet'
  // A sheet renders its OWN header — a 44px close target and usually a subtitle, neither of which
  // the desktop title bar provides — so the built-in one is suppressed rather than stacked on top
  // of it, exactly as `unstyled` does. `title` then becomes the accessible name, so a sheet can
  // still never go unnamed.
  const ownHeader = unstyled || sheet
  const titleId = useId()
  const panelRef = useRef(null)
  const triggerRef = useRef(null)
  const dirtyRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // A sheet's backdrop is a thin strip above a panel filling the bottom of a phone screen, i.e.
  // the easiest thing in the app to hit by accident with a thumb — and behind it may be a
  // half-filled TADA claim with six fields and three expense lines. So once anything inside has
  // been typed or picked, a backdrop tap is ignored; Escape and the sheet's own Close button
  // still work, and nothing is trapped. A read-only sheet never fires these events, so it keeps
  // closing on backdrop exactly as a dialog does.
  const onBackdrop = () => { if (!(sheet && dirtyRef.current)) onClose() }
  const markDirty = () => { dirtyRef.current = true }

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
      // A child that already consumed this key (QtyInput's Escape-cancels-the-expression)
      // preventDefaults it; closing the whole dialog on top of that turns "cancel this box"
      // into "discard the entire form" (S623). Belt to QtyInput's own stopPropagation.
      if (e.defaultPrevented) return
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
      onClick={onBackdrop}
      className="no-print"
      style={{
        position: 'fixed', inset: 0, zIndex, background: 'rgba(0,0,0,0.6)',
        // A sheet scrolls inside its own panel, so the overlay must not scroll too — two nested
        // scrollers on a phone means the backdrop drags out from under the sheet.
        overflowY: sheet ? 'hidden' : 'auto',
        padding: sheet ? 0 : (unstyled ? 16 : '40px 16px'),
        display: 'flex',
        alignItems: sheet ? 'flex-end' : (unstyled ? 'center' : 'flex-start'),
        justifyContent: 'center',
      }}
    >
      <div
        ref={panelRef}
        onClick={e => e.stopPropagation()}
        onInput={sheet ? markDirty : undefined}
        onChange={sheet ? markDirty : undefined}
        className={sheet ? 'card modal-sheet' : (unstyled ? undefined : 'card')}
        role="dialog"
        aria-modal="true"
        {...(ownHeader ? { 'aria-label': title } : { 'aria-labelledby': titleId })}
        tabIndex={-1}
        style={unstyled
          ? { outline: 'none', ...panelStyle }
          : { width: '100%', maxWidth: sheet ? 640 : maxWidth, margin: sheet ? 0 : 'auto', outline: 'none', ...panelStyle }}
      >
        {!ownHeader && (
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
