import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

// The till's notice bar (owner decision, 2026-10-15 audit): what the floor's refusals used to say in a
// window.alert. A browser pop-up froze the whole page until OK was tapped, so the guest-order chime and
// every poll stopped while it stood. The words are the same; only the box changed.
//
// It stays until staff tap ✕, because these are refusals a waiter must not walk past mid-service (a
// table that may already have an order, a bill reprinted without its lines, a clear-all that half ran).
// A newer notice replaces the older one.
//
// Portalled to <body> and fixed at the top, so it shows from the floor, the Billing station and the
// order screen alike, and above a Recent Bills, Covers or billing dialog the action was started from:
// the till layers sit at 1000 and Modal callers pass up to 2100. Below the Quick Calculator (2500) and
// the guest-order banner (3000), and it starts below that banner, which publishes its own height.
export const TILL_NOTICE_Z = 2200

// What Modal's Tab trap counts as focusable (Modal.js FOCUSABLE), so the edges found here are its edges.
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
const OPEN_DIALOG = '[role="dialog"][aria-modal="true"]'
const focusablesIn = el => Array.from(el.querySelectorAll(FOCUSABLE)).filter(n => n.offsetParent !== null)

/**
 * Where Tab or Shift+Tab should go from `from` while a notice stands over an open dialog (S852), or
 * null to leave the key alone. The notice sits ABOVE every Modal on purpose (S844: so a Recent Bills
 * reprint failure is read over the dialog it came from), which put its ✕ outside the dialog's Tab
 * trap, unreachable by keyboard. Rather than sink the notice beneath the scrim, where it could not be
 * read, the ✕ joins the dialog's Tab cycle: Tab past the dialog's last control reaches ✕, Shift+Tab
 * before its first control too, and from ✕ Tab goes back into the dialog.
 */
export function tabTargetPastNotice({ from, shift, dismiss, dialog }) {
  if (!dismiss || !dialog) return null
  const items = focusablesIn(dialog)
  if (from === dismiss) return (shift ? items[items.length - 1] : items[0]) || dialog
  if (!dialog.contains(from) || items.length === 0) return null
  const edge = shift ? items[0] : items[items.length - 1]
  return from === edge ? dismiss : null
}

/** A notice's lines: the sentence, then the "Nothing was changed…" line after its blank line. */
export function noticeLines(text) {
  return String(text || '').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
}

/**
 * @param {{ notice: { id: number, text: string } | null, onDismiss: () => void }} props
 *   `id` changes with every notice, so the same words raised twice are announced twice.
 */
export default function TillNotice({ notice, onDismiss }) {
  // Where focus was when this notice appeared, handed back on ✕: the dismiss button leaves with the
  // bar, and focus dropped to <body> would land behind an open dialog.
  const returnFocusRef = useRef(null)
  const dismissRef = useRef(null)
  // The dialog the ✕ was reached from by Tab, so leaving the ✕ goes back into that same dialog.
  const fromDialogRef = useRef(null)
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const id = notice?.text ? notice.id : null
  useEffect(() => {
    if (id == null) return
    const el = document.activeElement
    returnFocusRef.current = el && el !== document.body ? el : null
  }, [id])

  // S852: keep the ✕ reachable from the keyboard while a dialog's Tab trap holds focus (see
  // tabTargetPastNotice). Capture phase, so this runs before Modal's own document listener, which
  // then sees defaultPrevented and leaves the key alone. Escape on the ✕ dismisses the notice,
  // not the dialog under it.
  useEffect(() => {
    if (id == null) return undefined
    const onKeyDown = e => {
      const dismissEl = dismissRef.current
      if (!dismissEl || e.defaultPrevented) return
      const from = document.activeElement
      if (e.key === 'Escape' && from === dismissEl) {
        e.preventDefault()
        e.stopPropagation()
        dismissNow()
        return
      }
      if (e.key !== 'Tab') return
      const dialogs = Array.from(document.querySelectorAll(OPEN_DIALOG))
      const dialog = from === dismissEl
        ? (fromDialogRef.current?.isConnected ? fromDialogRef.current : dialogs[dialogs.length - 1])
        : from?.closest?.(OPEN_DIALOG)
      const to = tabTargetPastNotice({ from, shift: e.shiftKey, dismiss: dismissEl, dialog })
      if (!to) return
      e.preventDefault()
      e.stopPropagation()
      if (to === dismissEl) fromDialogRef.current = dialog
      to.focus?.()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  function dismissNow() {
    // Back to where focus was when the notice appeared, or else into the dialog the ✕ was reached from.
    const back = returnFocusRef.current?.isConnected ? returnFocusRef.current : fromDialogRef.current
    fromDialogRef.current = null
    onDismissRef.current()
    if (back?.isConnected) back.focus?.()
  }

  if (id == null) return null
  const dismiss = dismissNow
  const lines = noticeLines(notice.text)
  const bar = (
    <div
      key={id}
      role="alert"
      className="action-error no-print"
      style={{
        position: 'fixed', left: 0, right: 0, top: 'var(--arrival-alert-h, 0px)', zIndex: TILL_NOTICE_Z,
        margin: 0, display: 'flex', alignItems: 'center', gap: 12,
        // An installed iPhone draws under its status bar; the guest-order banner covers that inset itself
        // when it is up, so only what it leaves is added (the shell bars' rule, S797).
        padding: 'calc(10px + max(0px, env(safe-area-inset-top, 0px) - var(--arrival-alert-h, 0px))) 16px 10px',
        // The floor banner's red tint, mixed into the card so nothing behind shows through.
        background: 'color-mix(in srgb, var(--theme-red) 8%, var(--theme-card))',
        borderBottom: '1px solid color-mix(in srgb, var(--theme-red) 35%, transparent)',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {lines.map((line, i) => (
          <p key={i} className="action-error-text" style={i ? { marginTop: 4 } : undefined}>{line}</p>
        ))}
      </div>
      <button ref={dismissRef} type="button" className="btn btn-ghost btn-sm till-hit" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
  return createPortal(bar, document.body)
}
