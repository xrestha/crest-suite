import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import SupportContactLine from './SupportContactLine'

/**
 * What an IMS page shows before the client has a single accounting period.
 *
 * WHY (S551 / `/impeccable critique` phase 4): eighteen IMS pages default their period selector to
 * `periods.find(p => p.status === 'open')`. With no `monthly_periods` row that resolves to null,
 * and every one of them then rendered a `<select>` containing zero `<option>`s — a visibly broken
 * control — with either no empty state at all (Stock Count) or, worse, an empty state naming a
 * button that is not on the page: Purchases said "Click + Add Purchase to start" while its Fab is
 * gated on `!!selectedPeriod`. Nothing anywhere linked to /periods, which is the one thing that
 * unblocks all eighteen. This is the first ten minutes of every new customer.
 *
 * Only a Crest admin can create a period from nothing (`+ New Period` on Periods is admin-only). A
 * client's first month is opened by Crest (AdminClients' seedFirstMonth, on create and on trial
 * approval) and every later one by closing the month before it. So the client variant must not
 * send anyone to /periods — that link was a dead end — and names the one way out: Crest support.
 *
 * Render it INSTEAD of the page body when `periods.length === 0`, and suppress the empty select.
 */
export default function NoPeriodState({ what = 'this page' }) {
  const { isAdmin } = useAuth()

  return (
    <div className="card" style={{ padding: '40px 32px', textAlign: 'center', maxWidth: 560, margin: '0 auto' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }} aria-hidden="true">📅</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 8 }}>
        {isAdmin ? 'No accounting period yet' : 'No month is open yet'}
      </div>
      {isAdmin ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7, marginBottom: 20 }}>
            Every purchase, stock count and sale in Crest belongs to a Nepali month — Shrawan 2083, for
            example. Create your first period and {what} starts working straight away.
          </p>
          <Link to="/periods" className="btn btn-primary" style={{ textDecoration: 'none' }}>
            Create your first period
          </Link>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7, marginBottom: 20 }}>
            Every purchase, stock count and sale in Crest belongs to a Nepali month — Shrawan 2083, for
            example. Crest opens your first month when your account is set up, and after that each new
            month opens when you close the one before. No month has been opened for this account yet,
            and {what} needs one. Contact Crest support and we will open it for you.
          </p>
          <SupportContactLine variant="buttons" />
        </>
      )}
    </div>
  )
}
