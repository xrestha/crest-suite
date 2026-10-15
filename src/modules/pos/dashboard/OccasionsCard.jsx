import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { settleWithin } from '../../../utils/withTimeout'
import { nepalTime } from '../../../shared/nepalTime'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import { customerBookAfterRead } from '../customers/customerBook'
import { OCCASION_COLUMNS, upcomingOccasions } from '../customers/occasions'
import { todayNepalAdIso } from '../reports/reportRange'
import OccasionsList from '../customers/OccasionsList'

// The POS Dashboard's "Birthdays & anniversaries — next 7 days" (S843).
//
// Its OWN read, never part of the dashboard's 60-second load() (dashboards.md: each panel its own
// pipeline): the customers who agreed and have a date, paged (the customer book grows for ever), on
// mount and whenever `refreshKey` moves (the page's Refresh, and its tick at most every 5 minutes, the
// sales-by-category table's key). Called by the page at its top, so the read starts with the page's
// own rather than after it. A failed refresh keeps the last list and says when it is from; a failed
// first read says the list could not be read, never "no birthdays".

const READ_MS = 20000

export function useUpcomingOccasions({ enabled, refreshKey }) {
  const { clientId, scopedFrom } = useScopedDb()
  const req = useLatestRequest()
  const seq = useRef(0)
  const [state, setState] = useState({ clientId: null, rows: null, error: null, stale: null, at: null })

  useEffect(() => {
    if (!enabled || !clientId) return
    const forClient = clientId
    const key = req.begin(`${forClient}#${++seq.current}`) // before any await
    settleWithin(
      fetchAllRows(() => scopedFrom('pos_customers', OCCASION_COLUMNS)
        .not('consent_at', 'is', null)
        .or('birth_month.not.is.null,anniv_month.not.is.null')
        .order('name').order('id')),
      READ_MS, 'Reading birthdays and anniversaries',
    ).then(({ data, error }) => {
      if (!req.isCurrent(key)) return
      if (error) console.error('birthdays and anniversaries read failed:', error)
      setState(prev => ({
        ...customerBookAfterRead(prev, forClient, { data, error }),
        at: error ? (prev.clientId === forClient ? prev.at : null) : Date.now(),
      }))
    })
  }, [enabled, clientId, scopedFrom, req, refreshKey])

  return state
}

export default function OccasionsCard({ state, clientId, outletName = '' }) {
  const today = todayNepalAdIso()
  const items = useMemo(() => (state.rows ? upcomingOccasions(state.rows, 7) : []), [state.rows, today]) // eslint-disable-line react-hooks/exhaustive-deps
  const loading = !clientId || state.clientId !== clientId

  return (
    <div className="card card--compact">
      <h3 className="dash-card-title">
        <Tip text="Customers whose birthday or anniversary falls today or in the next six days, in the Nepali calendar day it falls on. Only customers who agreed to keep their dates are listed. WhatsApp opens a wish to send from your own phone." width={300}>
          Birthdays &amp; anniversaries — next 7 days
        </Tip>
      </h3>
      {loading ? (
        <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Reading birthdays…</p>
      ) : state.error ? (
        (() => {
          const why = asActionError(state.error, 'operator')
          return <ActionError error={{ text: `Birthdays and anniversaries could not be read, so this list is not shown. Press Refresh to try again. ${why.text}`, detail: why.detail }} />
        })()
      ) : (
        <>
          {state.stale && (
            <p role="alert" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
              <span aria-hidden="true">△ </span>Could not refresh. This list is from {nepalTime(state.at)}; it will try again with the next refresh.
            </p>
          )}
          {items.length === 0
            ? <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>No birthdays or anniversaries in the next 7 days.</p>
            : <OccasionsList items={items} outletName={outletName} variant="list" />}
          <Link to="/pos/customers?tab=membership" className="dash-tile-link">Next 30 days, in Customers → Membership →</Link>
        </>
      )}
    </div>
  )
}
