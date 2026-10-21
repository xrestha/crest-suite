import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FOCUSABLE } from './Modal'

const ExpandIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" focusable="false">
    <path d="M1 4.5V1h3.5M7.5 1H11v3.5M11 7.5V11H7.5M4.5 11H1V7.5"/>
  </svg>
)

// Recharts 3 makes every chart's <svg> a Tab stop (tabindex 0, the keyboard layer that walks its
// tooltip) and gives it no name, so a keyboard or screen-reader user landed on an unnamed
// "application" once per chart (S852). This is the one place that knows the chart's title, so it
// names the surface after the title's own element. The chart is the caller's renderChart output,
// and a ResponsiveContainer draws its <svg> only after it has measured, so the name is set when the
// svg appears rather than once on mount. A caller that named its own chart keeps that name.
const FOCUSABLE_SVG = 'svg[tabindex]:not([tabindex="-1"])'
function useNamedChartSurface(rootRef, labelId) {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !labelId) return undefined
    const name = () => {
      root.querySelectorAll(FOCUSABLE_SVG).forEach(svg => {
        if (svg.hasAttribute('aria-label') || svg.getAttribute('aria-labelledby') === labelId) return
        svg.setAttribute('aria-labelledby', labelId)
      })
    }
    name()
    if (typeof MutationObserver === 'undefined') return undefined
    // childList only: setting the attribute above is not itself a change this observer reports.
    const observer = new MutationObserver(name)
    observer.observe(root, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [rootRef, labelId])
}

const DEFAULT_TITLE_STYLE = {
  fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

// The expanded panel is a real dialog, not a styled div. It keeps its own look (a darker scrim,
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
  useNamedChartSurface(panelRef, titleId)

  useEffect(() => {
    triggerRef.current = document.activeElement
    const panel = panelRef.current
    // Focus the panel itself rather than its first control: the first control is Close, and
    // landing on it makes a screen reader announce the exit before the chart it just opened.
    panel?.focus()

    const onKeyDown = e => {
      // A child that already used this key (a Tip being dismissed, S852) preventDefaults it, the
      // same contract Modal keeps: closing the chart as well would be two things for one press.
      if (e.defaultPrevented) return
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
    // The backdrop's box and scrim live in .chart-modal-backdrop (Layout.css). The blur that sat
    // here is gone (S852): it repainted the whole dashboard under the scrim for a dim the scrim
    // already gives.
    <div
      className="chart-modal-backdrop no-print"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="chart-modal-panel"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // The height cap (in .chart-modal-panel, as 100vh and then 100dvh since S852) matches the
        // backdrop's own 24px top+bottom padding (48px), with overflowY as the release valve —
        // without both, a panel taller than the viewport (a chart with a full stat-pill row, a wide
        // legend and a footer easily exceeds a laptop's height) has nowhere to go but off-screen
        // equally in both directions, since the backdrop centers it with align-items:center.
        // Scrolling inside the panel keeps Escape/backdrop-click as the way out rather than a
        // half-visible Close button no longer being reachable.
        style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-xl)', padding: '24px 32px', width: '92%', maxWidth: 1100, boxShadow: '0 8px 60px rgba(0,0,0,0.5)', outline: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
          <div id={titleId} style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>{title}</div>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, alignItems: 'center' }}>
            {legend}
            {/* No inline style: an inline border beat the class's focus and hover border (S852). */}
            <button type="button" className="chart-close-btn" onClick={onClose}>✕ Close</button>
          </div>
        </div>
        {renderChart(modalHeight)}
        {footer && <div style={{ marginTop: 16 }}>{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

export default function ChartCard({
  title, legend, footer, cardStyle, smallHeight = 160, modalHeight = 440,
  renderChart, titleStyle, headingLevel = 3,
}) {
  const [expanded, setExpanded] = useState(false)
  const cardRef = useRef(null)
  const headingId = useId()
  useNamedChartSurface(cardRef, headingId)
  const ts = titleStyle || DEFAULT_TITLE_STYLE
  // h3 fits a dashboard, where the chart sits under a section's h2. A report page that puts a
  // chart straight under its h1 passes 2, or the outline skips a level there (S794).
  const Heading = headingLevel === 2 ? 'h2' : 'h3'

  return (
    <div ref={cardRef} className="card card--compact" style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {/* A real <h3>, not a styled div, so screen-reader users can jump between charts by
            heading (dashboard critique P2, S569). margin reset since h3 otherwise adds its own. */}
        <Heading id={headingId} style={{ margin: 0, ...ts }}>{title}</Heading>
        <div style={{ display: 'flex', gap: 16, fontSize: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {legend}
          {/* aria-label, not title alone: `title` is an unreliable accessible name and is invisible
              to touch entirely. Naming the chart makes the button distinguishable when a page
              carries five of these. */}
          <button
            type="button"
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
