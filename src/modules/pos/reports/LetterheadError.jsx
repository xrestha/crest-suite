// The notice for a failed letterhead read on the four POS reports (2026-10-15 audit).
//
// Each report reads the outlet's name (and Sales, its VAT number and address) for the Excel
// letterhead in its own slot, apart from the range load that clears `loadError` on its first line
// (S754). Sales and Covers said so in a `.report-error` card; KOT Log and Sales Exceptions in a 12px
// amber line, so one failure read as two different kinds of thing on four sibling pages. This is the
// card, once. `children` is the page's own hint: what is switched off and what is unaffected.
// errorInfo words the failure for the operator and keeps the code and raw message as fine print.
import { errorInfo } from '../../../shared/errorText'

export default function LetterheadError({ error, title = "Could not load this outlet's name", children }) {
  if (!error) return null
  const { text, detail } = errorInfo(error, 'operator')
  return (
    <div className="card report-error" role="alert" style={{ marginBottom: 16 }}>
      <div className="report-error-title">{title}</div>
      <p className="report-error-body">{text}</p>
      <p className="report-error-hint">{children}</p>
      {detail && <p className="action-error-detail">{detail}</p>}
    </div>
  )
}
