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
  const id = notice?.text ? notice.id : null
  useEffect(() => {
    if (id == null) return
    const el = document.activeElement
    returnFocusRef.current = el && el !== document.body ? el : null
  }, [id])

  if (id == null) return null
  const dismiss = () => {
    const back = returnFocusRef.current
    onDismiss()
    if (back?.isConnected) back.focus?.()
  }
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
      <button type="button" className="btn btn-ghost btn-sm till-hit" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
  return createPortal(bar, document.body)
}
