import { Link } from 'react-router-dom'

/**
 * What an IMS page shows before the client has created a single accounting period.
 *
 * WHY (S551 / `/impeccable critique` phase 4): eighteen IMS pages default their period selector to
 * `periods.find(p => p.status === 'open')`. With no `monthly_periods` row that resolves to null,
 * and every one of them then rendered a `<select>` containing zero `<option>`s — a visibly broken
 * control — with either no empty state at all (Stock Count) or, worse, an empty state naming a
 * button that is not on the page: Purchases said "Click + Add Purchase to start" while its Fab is
 * gated on `!!selectedPeriod`. Nothing anywhere linked to /periods, which is the one thing that
 * unblocks all eighteen. This is the first ten minutes of every new customer.
 *
 * Render it INSTEAD of the page body when `periods.length === 0`, and suppress the empty select.
 */
export default function NoPeriodState({ what = 'this page' }) {
  return (
    <div className="card" style={{ padding: '40px 32px', textAlign: 'center', maxWidth: 560, margin: '0 auto' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>📅</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 8 }}>
        No accounting period yet
      </div>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7, marginBottom: 20 }}>
        Every purchase, stock count and sale in Crest belongs to a Nepali month — Shrawan 2083, for
        example. Create your first period and {what} starts working straight away.
      </p>
      <Link to="/periods" className="btn btn-primary" style={{ textDecoration: 'none' }}>
        Create your first period
      </Link>
    </div>
  )
}
