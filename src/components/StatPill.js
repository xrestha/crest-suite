// Small KPI callout used inside a ChartCard's expanded (modal) view — a compact card revealing a
// fuller, stat-annotated view on expand is the shared pattern across every chart on the dashboard
// and reports that uses ChartCard (see S484/S486 in README.md's Session Log). Originally local to
// ClientDashboard.jsx as TrendStatPill; promoted here once FoodBeverageSplit.jsx needed the same
// pattern (S487).
export default function StatPill({ label, value, color }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 2, padding: '7px 14px',
      background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-md)',
    }}>
      <span style={{ fontSize: 9, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 5 }}>
        {color && <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />}
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color || 'var(--theme-text1)' }}>{value}</span>
    </div>
  )
}
