import { useState } from 'react'
import { createPortal } from 'react-dom'

const ExpandIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M1 4.5V1h3.5M7.5 1H11v3.5M11 7.5V11H7.5M4.5 11H1V7.5"/>
  </svg>
)

const DEFAULT_TITLE_STYLE = {
  fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
}

export default function ChartCard({
  title, legend, footer, cardStyle, smallHeight = 160,
  renderChart, titleStyle,
}) {
  const [expanded, setExpanded] = useState(false)
  const ts = titleStyle || DEFAULT_TITLE_STYLE

  const modal = expanded ? createPortal(
    <div
      onClick={() => setExpanded(false)}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-xl)', padding: '20px 28px', width: '92%', maxWidth: 1100, boxShadow: '0 8px 60px rgba(0,0,0,0.5)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>{title}</div>
          <div style={{ display: 'flex', gap: 18, fontSize: 11, alignItems: 'center' }}>
            {legend}
            <button
              onClick={() => setExpanded(false)}
              style={{ background: 'none', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', color: 'var(--theme-text2)', fontSize: 12 }}
            >✕ Close</button>
          </div>
        </div>
        {renderChart(440)}
        {footer && <div style={{ marginTop: 12 }}>{footer}</div>}
      </div>
    </div>,
    document.body
  ) : null

  return (
    <div className="card" style={{ padding: '14px 16px', ...cardStyle }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={ts}>{title}</div>
        <div style={{ display: 'flex', gap: 14, fontSize: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {legend}
          <button
            onClick={() => setExpanded(true)}
            title="Expand chart"
            style={{ background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer', color: 'var(--theme-text3)', lineHeight: 1, borderRadius: 4 }}
          >
            <ExpandIcon />
          </button>
        </div>
      </div>
      {renderChart(smallHeight)}
      {footer}
      {modal}
    </div>
  )
}
