import { useId, useState, useRef, Children, isValidElement, cloneElement } from 'react'
import { createPortal } from 'react-dom'

// Native elements that are already a tab stop. When a Tip's ONLY child is one of these, the Tip
// must not add a second one: the child keeps focus, and the tooltip describes the child. Before
// S680 every tipped action button was two Tab presses (the wrapper span, then the button), so a
// Reservations row with four tipped actions took eight stops to cross — and `aria-describedby`
// sat on the span, so a screen reader focused on the actual button never heard the tip. Custom
// components (a react-router `Link`) cannot be detected here and keep the wrapper behaviour.
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary'])

export default function Tip({ text, children, width = 220, style }) {
  const [pos, setPos] = useState(null)
  const ref = useRef(null)
  const tooltipId = useId()

  const kids = Children.toArray(children)
  const host = kids.length === 1 && isValidElement(kids[0]) && typeof kids[0].type === 'string' && INTERACTIVE_TAGS.has(kids[0].type)
    ? kids[0] : null

  const show = () => {
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
  const hide = () => setPos(null)

  const bubble = pos && createPortal(
    <span
      role="tooltip"
      id={tooltipId}
      style={{
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
  )

  if (host) {
    // The child is the focus target and the described element; this span only carries hover and
    // the anchor rect. No dashed underline and no `help` cursor — those signal "hover this text",
    // and a button already signals what it is. Hover still works on a disabled child, which
    // cannot take focus at all.
    const described = [host.props['aria-describedby'], pos ? tooltipId : null].filter(Boolean).join(' ') || undefined
    return (
      <span
        ref={ref}
        className="tip-host"
        style={{ position: 'relative', display: 'inline-flex', ...style }}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {cloneElement(host, {
          'aria-describedby': described,
          onFocus: e => { host.props.onFocus?.(e); show() },
          onBlur:  e => { host.props.onBlur?.(e); hide() },
        })}
        {bubble}
      </span>
    )
  }

  return (
    <span
      ref={ref}
      className="tip-trigger"
      tabIndex={0}
      aria-describedby={pos ? tooltipId : undefined}
      style={{ position: 'relative', cursor: 'help', borderBottom: '1px dashed var(--theme-border)', display: 'inline', ...style }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {bubble}
    </span>
  )
}
