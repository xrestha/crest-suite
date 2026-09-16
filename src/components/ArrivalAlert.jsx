import { useEffect, useRef } from 'react'
import './ArrivalAlert.css'

// The loud one (S763). Something arrived that a person has to act on, and nobody has — a guest
// order waiting for Accept, a kitchen ticket nobody has started. Both were previously a badge on a
// page you had to already be looking at, plus one quiet two-tone chime, and both were reported as
// "I got no notification".
//
// Deliberately NOT a Modal: this must never take the focus or block the screen underneath. A
// cashier mid-bill and a chef mid-service both have something in their hands, and an alert that
// steals the keyboard is worse than the miss it is preventing. It is a fixed banner above
// everything (z-index sits above the POS till layers at 1000 and the Calculator at 2500, below
// Tip's 9999), it is `role="alert"`, and the page behind it stays fully usable.
//
// `urgent` is the escalation: a harder pulse and the red token. The pulse lives in the stylesheet,
// not inline, because an inline animation is unreachable from @media (prefers-reduced-motion)
// — the rule `.claude/rules/design-system.md` states and which this product has broken twice.
export default function ArrivalAlert({
  icon = '🔔',
  title,
  detail,
  urgent = false,
  muted = false,
  onMute,
  actionLabel,
  onAction,
  reserveSpace = false,
}) {
  const ref = useRef(null)

  // `reserveSpace` publishes the banner's own height as `--arrival-alert-h`, which `.layout-root`
  // pads by and `.app-topnav` sticks below. Without it the banner covers the module nav — the
  // alert is un-missable and the reader cannot act on it, which is the worst of both.
  //
  // MEASURED rather than declared, because the height is not a constant: the banner wraps under
  // 600px, and a two-line title on a narrow till is taller again. A hardcoded reservation is right
  // on the desktop it was written on and wrong on the device this is for.
  //
  // The KDS passes nothing — it is a position:fixed full-screen layer that pads itself, and two
  // publishers of one variable is a race with no owner.
  useEffect(() => {
    if (!reserveSpace) return
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const apply = () => root.style.setProperty('--arrival-alert-h', `${el.offsetHeight}px`)
    apply()
    // ResizeObserver, not a resize listener: the height also changes when the TEXT changes (one
    // order becoming three), which no window event reports.
    let ro
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(apply)
      ro.observe(el)
    }
    return () => {
      ro?.disconnect()
      root.style.removeProperty('--arrival-alert-h')
    }
  }, [reserveSpace])

  return (
    <div
      ref={ref}
      role="alert"
      className={`arrival-alert${urgent ? ' arrival-alert--urgent' : ''}`}
    >
      <span className="arrival-alert__icon" aria-hidden="true">{icon}</span>
      <div className="arrival-alert__body">
        <div className="arrival-alert__title">{title}</div>
        {detail && <div className="arrival-alert__detail">{detail}</div>}
      </div>
      {onAction && actionLabel && (
        <button type="button" className="btn btn-primary arrival-alert__action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {/* Mute silences the sound and leaves the banner standing. A control that makes the evidence
          disappear is how this gets missed a second time — the thing is still waiting. */}
      {onMute && (
        <button
          type="button"
          className="btn btn-ghost arrival-alert__mute"
          onClick={onMute}
          disabled={muted}
        >
          {muted ? 'Muted' : 'Mute 5 min'}
        </button>
      )}
    </div>
  )
}
