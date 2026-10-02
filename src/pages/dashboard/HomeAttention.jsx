import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { withTimeout } from '../../utils/withTimeout'
import { nepalDayStartTs, todayNepalAdIso } from '../../modules/pos/reports/reportRange'
import { KDS_LATE_MS } from '../../modules/pos/posSignals'
import { ticketSummary } from '../../modules/pos/dashboard/posDashboardMath'
import { closingCountPreflight } from '../periods/closePeriod'
import { BS_MONTHS, daysInBsMonth, getBsToday } from '../../utils/bsCalendar'

// Home's "Needs attention" list (S800 stage C) — the first thing a multi-module Home says.
//
// Stephen Few's first stage of a monitoring screen is "what needs me?", before any figure, and the
// S800 research found every suite home ordering itself that way: waiting work first, then a few
// headline numbers. So this lists, across every module this login sees, only things a person has to
// DO, each with its count and a link to the page that clears it; the module cards below stay the
// headline figures. Nothing waiting is said out loud, because an empty box reads as "not loaded".
//
// `mode="ims"` (S800 stage F) is the same list on the Inventory Dashboard, IMS items only, plus the
// month-end count: in the last three days of the open month, or once it has ended, how many active
// items still have no closing count (closingCountPreflight — the close dialog's own numbers).
//
// A count that could not be read is "couldn't check", never 0 (S734): on a queue, zero is the answer
// the reader wants, so a failed read must not be able to give it.

const REFRESH_MS = 60 * 1000

function Row({ count, failed, text, to, linkText, tone = 'amber' }) {
  if (!failed && !(count > 0)) return null
  return (
    <li className="home-attention__row">
      <span className={failed ? 'badge-gray' : tone === 'red' ? 'badge-red' : 'badge-amber'} style={{ minWidth: 28, textAlign: 'center' }}>
        {failed ? '—' : count > 99 ? '99+' : count}
      </span>
      <span className="home-attention__text">{failed ? <>{text} <span style={{ color: 'var(--theme-text3)' }}>— couldn't check</span></> : text}</span>
      {to && <Link to={to} className="dash-tile-link" style={{ marginTop: 0 }}>{linkText} →</Link>}
    </li>
  )
}

export default function HomeAttention({
  mode = 'home', showIms, showHr, showPos, posIsStationTeam, canSeeImsPosting, canHrApprove,
  hrApprovals, reorderCount, canReorder, bookingRequests, clientId, activePeriod, periodExpired,
}) {
  const { scopedFrom } = useScopedDb()
  const latest = useLatestRequest()
  const imsMode = mode === 'ims'
  const posFront = !imsMode && showPos && !posIsStationTeam
  const wantPosting = showIms && showPos && canSeeImsPosting
  // The month-end count, IMS mode only: from three days before the open month ends.
  const today = getBsToday()
  const daysLeft = activePeriod && activePeriod.bs_year === today.year && activePeriod.bs_month === today.month
    ? daysInBsMonth(today.year, today.month) - today.day : null
  const wantCount = imsMode && !!activePeriod?.id && (periodExpired || (daysLeft != null && daysLeft <= 3))
  const [counts, setCounts] = useState(null) // { guest, late, unposted } with null = couldn't check
  const load = useCallback(async () => {
    if (!clientId || (!posFront && !wantPosting && !wantCount)) { setCounts({}); return }
    const id = latest.begin(Symbol('home-attention'))
    const todayStart = nepalDayStartTs(todayNepalAdIso())
    const none = Promise.resolve({ data: null, count: null, error: null })
    try {
      const [guest, kot, unposted, count] = await withTimeout(Promise.all([
        posFront ? scopedFrom('pos_guest_order_requests', 'id', { count: 'exact', head: true }).eq('status', 'pending') : none,
        posFront ? scopedFrom('pos_kot_log', 'status, sent_at').in('status', ['new', 'in_progress']).gte('sent_at', todayStart) : none,
        // The floor's own count (PosOrders.jsx): billed and never confirmed into Inventory.
        wantPosting ? scopedFrom('pos_orders', 'id', { count: 'exact', head: true }).eq('status', 'billed').is('ims_posted_at', null) : none,
        // null when it could not check — the close dialog says the same.
        wantCount ? closingCountPreflight(activePeriod.id, clientId) : Promise.resolve(undefined),
      ]), 20000, 'Needs attention')
      if (!latest.isCurrent(id)) return
      setCounts({
        guest: posFront ? (guest.error ? null : guest.count || 0) : undefined,
        late: posFront ? (kot.error ? null : ticketSummary(kot.data, KDS_LATE_MS).late) : undefined,
        unposted: wantPosting ? (unposted.error ? null : unposted.count || 0) : undefined,
        uncounted: wantCount ? (count ? Math.max(0, count.items - count.counted) : null) : undefined,
        countTotal: wantCount && count ? count.items : undefined,
      })
    } catch {
      if (latest.isCurrent(id)) setCounts(prev => prev || { guest: posFront ? null : undefined, late: posFront ? null : undefined, unposted: wantPosting ? null : undefined, uncounted: wantCount ? null : undefined })
    }
  }, [clientId, posFront, wantPosting, wantCount, activePeriod, scopedFrom, latest])

  useEffect(() => {
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  const hrCount = !imsMode && showHr && canHrApprove ? (hrApprovals?.error ? null : hrApprovals?.total ?? 0) : undefined
  const loading = counts === null || (hrCount !== undefined && hrApprovals?.loading)
  const items = [
    posFront && { key: 'guest', count: counts?.guest, failed: counts?.guest === null, tone: 'red',
      text: 'QR orders from guests nobody has accepted — the kitchen has not seen them', to: '/pos/orders', linkText: 'Accept' },
    posFront && { key: 'late', count: counts?.late, failed: counts?.late === null, tone: 'red',
      text: 'kitchen or bar tickets running late', to: '/pos/kds', linkText: 'Kitchen Display' },
    wantCount && { key: 'count', count: counts?.uncounted, failed: counts?.uncounted === null,
      text: periodExpired
        ? `active items still have no closing count for ${BS_MONTHS[activePeriod.bs_month - 1]}, which has ended${counts?.countTotal ? ` (of ${counts.countTotal})` : ''}`
        : `active items still to count before ${BS_MONTHS[activePeriod.bs_month - 1]} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}${counts?.countTotal ? ` (of ${counts.countTotal})` : ''}`,
      to: '/stock', linkText: 'Stock Count' },
    posFront && bookingRequests > 0 && { key: 'book', count: bookingRequests,
      text: 'table bookings waiting for you to accept', to: '/pos/reservations', linkText: 'Reservations' },
    hrCount !== undefined && { key: 'hr', count: hrCount, failed: hrCount === null,
      text: 'leave, overtime, travel or shift-swap requests waiting for a decision', to: '/hr/dashboard', linkText: 'HR Dashboard' },
    wantPosting && { key: 'post', count: counts?.unposted, failed: counts?.unposted === null,
      text: 'paid POS bills not yet in Inventory, so the month’s sales and stock use are short', to: '/periods', linkText: 'Post them from Periods' },
    showIms && canReorder && { key: 'par', count: reorderCount, failed: false,
      text: 'stock items below their par level', to: '/reorder', linkText: 'Reorder Report' },
  ].filter(Boolean)
  const anyShown = items.some(i => i.failed || i.count > 0)

  return (
    <section className="card card--compact dash-section" aria-labelledby="home-attention-h">
      <h2 id="home-attention-h" className="dash-card-title">Needs attention</h2>
      {loading && !anyShown
        ? <span className="skeleton" style={{ display: 'inline-block', width: '60%', height: '1.2em' }} />
        : anyShown
          ? <ul className="home-attention">{items.map(({ key, ...item }) => <Row key={key} {...item} />)}</ul>
          : <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}><span style={{ color: 'var(--theme-green-text)' }}>✓</span> Nothing is waiting on you right now.</p>}
    </section>
  )
}
