// ONE definition of the chart-tooltip card chrome, shared like chartMotion() is — a Recharts
// `contentStyle` (or a custom tooltip's container style) every chart needs, so a border/radius/
// padding change lands everywhere instead of the sites a grep happens to find. Lifted out of
// ClientDashboard.jsx (S623 review): the byte-identical object still sits inline in
// OwnerDashboard.jsx, SalesReport.jsx, PeriodComparison.js, BestSellers.js and (drifted — no
// borderRadius) ValuationReportTab.js. Migrate those here as they're touched; never add a new copy.
export const TOOLTIP_CHROME = {
  background: 'var(--theme-card)',
  border: '1px solid var(--theme-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 11,
}
