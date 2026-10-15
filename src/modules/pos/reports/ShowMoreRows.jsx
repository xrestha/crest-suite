// The control under a register that renders a page of rows at a time (S842, useRowWindow.js).
// "N of M shown" says the table is not the whole list, and `note` says what still counts all of
// it (the TOTAL row, the Excel export), so a reader never takes a page's rows for the range. Nothing
// renders when the list fits in one page. Screen-only: a print renders every row.
const count = n => n.toLocaleString('en-IN')

export default function ShowMoreRows({ shown, total, step, noun, note, onMore, onAll, onFirst }) {
  if (total <= step) return null
  const all = shown >= total
  const more = Math.min(step, total - shown)
  return (
    <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--theme-text2)' }}>
      <span role="status">
        {all ? `All ${count(total)} ${noun} shown.` : `${count(shown)} of ${count(total)} ${noun} shown.`}
        {note ? ` ${note}` : ''}
      </span>
      {/* The second button keeps its place (and so its focus) when the first goes. */}
      {!all && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onMore}>Show {count(more)} more</button>
      )}
      <button type="button" className="btn btn-ghost btn-sm" onClick={all ? onFirst : onAll}>
        {all ? `Show the first ${count(step)} only` : `Show all ${count(total)}`}
      </button>
    </div>
  )
}
