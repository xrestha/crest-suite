import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const ExpandIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
    <path d="M1 4.5V1h3.5M7.5 1H11v3.5M11 7.5V11H7.5M4.5 11H1V7.5"/>
  </svg>
)

const DEFAULT_TITLE_STYLE = {
  fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

// The expanded panel is a real dialog, not a styled div. It keeps its own look (blurred backdrop,
// wider panel, legend inline in the header) rather than routing through Modal.js, but it carries
// the same four behaviours Modal gained at S521 — dialog semantics, initial focus, a Tab trap and
// focus restore — because without them the page behind an overlay stays fully focusable and
// Escape does nothing. This component backs every chart in the product, so the fix lands ~9 places.
function ChartModal({ title, legend, footer, renderChart, onClose, modalHeight }) {
  const titleId = useId()
  const panelRef = useRef(null)
  const triggerRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    triggerRef.current = document.activeElement
    const panel = panelRef.current
    // Focus the panel itself rather than its first control: the first control is Close, and
    // landing on it makes a screen reader announce the exit before the chart it just opened.
    panel?.focus()

    const onKeyDown = e => {
      if (e.key === 'Escape') { onCloseRef.current(); return }
      if (e.key === 'Tab' && panel) {
        const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null)
        if (items.length === 0) { e.preventDefault(); return }
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
    // Mount-only, for the same reason Modal.js documents: onClose is a fresh arrow on every
    // parent render, so depending on it would re-steal focus continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createPortal(
    <div
      className="chart-modal-backdrop no-print"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div
        ref={panelRef}
        className="chart-modal-panel"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // maxHeight matches the backdrop's own 24px top+bottom padding (48px), with overflowY as
        // the release valve — without both, a panel taller than the viewport (a chart with a full
        // stat-pill row, a wide legend and a footer easily exceeds a laptop's height) has nowhere
        // to go but off-screen equally in both directions, since the backdrop centers it with
        // align-items:center. Scrolling inside the panel keeps Escape/backdrop-click as the way
        // out rather than a half-visible Close button no longer being reachable.
        style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-xl)', padding: '20px 28px', width: '92%', maxWidth: 1100, maxHeight: 'calc(100vh - 48px)', overflowY: 'auto', boxShadow: '0 8px 60px rgba(0,0,0,0.5)', outline: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--theme-border)' }}>
          <div id={titleId} style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>{title}</div>
          <div style={{ display: 'flex', gap: 18, fontSize: 11, alignItems: 'center' }}>
            {legend}
            <button
              className="chart-close-btn"
              onClick={onClose}
              style={{ border: '1px solid var(--theme-border)', padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}
            >✕ Close</button>
          </div>
        </div>
        {renderChart(modalHeight)}
        {footer && <div style={{ marginTop: 12 }}>{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export default function ChartCard({
  title, legend, footer, cardStyle, smallHeight = 160, modalHeight = 440,
  renderChart, titleStyle,
}) {
  const [expanded, setExpanded] = useState(false)
  const ts = titleStyle || DEFAULT_TITLE_STYLE

  return (
    <div className="card" style={{ padding: '14px 16px', ...cardStyle }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {/* A real <h3>, not a styled div, so screen-reader users can jump between charts by
            heading (dashboard critique P2, S569). margin reset since h3 otherwise adds its own. */}
        <h3 style={{ margin: 0, ...ts }}>{title}</h3>
        <div style={{ display: 'flex', gap: 14, fontSize: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {legend}
          {/* aria-label, not title alone: `title` is an unreliable accessible name and is invisible
              to touch entirely. Naming the chart makes the button distinguishable when a page
              carries five of these. */}
          <button
            className="chart-icon-btn"
            onClick={() => setExpanded(true)}
            title="Expand chart"
            aria-label={typeof title === 'string' ? `Expand chart: ${title}` : 'Expand chart'}
            aria-haspopup="dialog"
          >
            <ExpandIcon />
          </button>
        </div>
      </div>
      {renderChart(smallHeight)}
      {footer}
      {expanded && (
        <ChartModal
          title={title}
          legend={legend}
          footer={footer}
          renderChart={renderChart}
          modalHeight={modalHeight}
          onClose={() => setExpanded(false)}
        />
      )}
    </div>
  )
}
