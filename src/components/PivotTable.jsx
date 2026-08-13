// Generic rows×columns-with-totals pivot renderer — extracted from Sales.js's "Daily Breakdown"
// pivot (recipe × BS-day, sticky first column, row/col/grand totals), which was the 2nd/3rd place
// in this codebase wanting this exact shape (the other being Purchases.js's referenced-but-never-
// built "Daily Register" pivot). Keep this presentational-only — no data fetching here.
// `rowTotals`/`grandTotal` are optional overrides for callers whose totals are NOT simply the sum
// of the rendered cells — e.g. a tile that shows the last 7 days as detail but wants each row's
// total to cover the whole period. Omit them and totals are derived from `values` as before.
// `totalsHeader` lets that column say something other than the corner label ("Period" vs "Total"),
// which matters precisely when the two differ.
export default function PivotTable({ rows, cols, values, rowHeader = 'Row', totalsLabel = 'Total', totalsHeader, formatValue = n => n.toLocaleString(), emptyDash = '—', rowTotals, grandTotal: grandTotalProp }) {
  const rowTotal = rowKey => (
    rowTotals ? (rowTotals[rowKey] || 0) : Object.values(values[rowKey] || {}).reduce((s, v) => s + (v || 0), 0)
  )
  // Column totals stay derived from the rendered cells — a day column's total IS the sum of what
  // is in it, regardless of how the row/grand totals are scoped.
  const colTotal = colKey => rows.reduce((s, r) => s + (values[r.key]?.[colKey] || 0), 0)
  const grandTotal = grandTotalProp != null ? grandTotalProp : rows.reduce((s, r) => s + rowTotal(r.key), 0)

  return (
    <div className="table-wrap">
      <table className="data-table" style={{ minWidth: 'max-content' }}>
        <thead>
          <tr>
            <th style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', zIndex: 1, minWidth: 120 }}>{rowHeader}</th>
            {cols.map(c => <th key={c.key} style={{ textAlign: 'right', minWidth: 56 }}>{c.label}</th>)}
            <th style={{ textAlign: 'right', minWidth: 70, fontWeight: 700 }}>{totalsHeader || totalsLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const total = rowTotal(r.key)
            return (
              <tr key={r.key}>
                <td style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', fontWeight: 600, color: 'var(--theme-text1)' }}>{r.label}</td>
                {cols.map(c => {
                  const v = values[r.key]?.[c.key] || 0
                  return (
                    <td key={c.key} style={{ textAlign: 'right', color: v > 0 ? 'var(--theme-text1)' : undefined }}>
                      {/* text3, not --theme-border. A border token has no text contract at all and
                          measured 1.35:1 here — the dash read as a rendering artifact rather than
                          as "no sales in this cell". text3 is the quietest tier that is still AA. */}
                      {v > 0 ? formatValue(v) : <span style={{ color: 'var(--theme-text3)' }}>{emptyDash}</span>}
                    </td>
                  )
                })}
                <td style={{ textAlign: 'right', fontWeight: 700, color: total > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)' }}>
                  {total > 0 ? formatValue(total) : emptyDash}
                </td>
              </tr>
            )
          })}
          <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
            <td style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', color: 'var(--theme-text2)', fontSize: 12 }}>{totalsLabel.toUpperCase()}</td>
            {cols.map(c => {
              const t = colTotal(c.key)
              return <td key={c.key} style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{t > 0 ? formatValue(t) : emptyDash}</td>
            })}
            <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 15 }}>{formatValue(grandTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
