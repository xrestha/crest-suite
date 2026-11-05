// The rows an Excel import left out, each with its sheet row number and the reason (S885). Shared
// by the Item Master and Supplier imports, in the preview and again in the result, so the reader
// can find each row in the file they uploaded.
export default function ImportSkippedList({ rows, title, open = true }) {
  if (!rows?.length) return null
  return (
    <details open={open} style={{ margin: '0 0 12px' }}>
      <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
        {title || `Skipped rows (${rows.length})`}
      </summary>
      <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto', marginTop: 8 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ whiteSpace: 'nowrap' }}>Row</th>
              <th>Name</th>
              <th>Why it was skipped</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.rowNo}-${i}`}>
                <td style={{ whiteSpace: 'nowrap', color: 'var(--theme-text2)' }}>{r.rowNo ?? '—'}</td>
                <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name || '—'}</td>
                <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}
