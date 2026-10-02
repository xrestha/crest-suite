import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { withTimeout } from '../../../utils/withTimeout'
import { npr } from '../../../shared/nepalMoney'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { previousExistingPeriod } from '../../../pages/periods/closePeriod'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'
import { priceMovers } from './priceMovers'
import { unitRateParts } from '../../../shared/unitRate'

// "1,180.00 → 1,260.00/KG": the rate in the unit it is bought in (per KG / LTR for a gram or
// millilitre item, the S797 rule), with the precision a moving price needs (Price Tracker's).
function rateMove(r) {
  const before = unitRateParts(r.rateBefore, r.uom, { precise: true })
  const now = unitRateParts(r.rateNow, r.uom, { precise: true })
  if (!before || !now) return ''
  return `${before.primary.value} → ${now.primary.value}${now.primary.unit ? `/${now.primary.unit}` : ''}`
}

// The Inventory Dashboard's "price movers" card (S800 stage F): the five purchase items whose price
// change cost the most this month, in rupees. The arithmetic is priceMovers.js. The card is the
// Price Tracker's headline, so it carries that report's gate (Pro, IMS manager) and links to it.
//
// "The month before" is the previous month that EXISTS (closePeriod.js), never bs_month − 1: a
// client paused for a month has a gap in its list.

export default function ImsPriceMovers({ activePeriod }) {
  const { scopedFrom } = useScopedDb()
  const latest = useLatestRequest()
  const [state, setState] = useState(null) // { rows, beforeLabel } | { error }

  const load = useCallback(async () => {
    if (!activePeriod?.id) return
    const id = latest.begin(activePeriod.id)
    try {
      const periodsRes = await withTimeout(scopedFrom('monthly_periods', 'id, bs_year, bs_month'), 20000, 'Price movers')
      if (periodsRes.error) throw periodsRes.error
      const before = previousExistingPeriod(periodsRes.data || [], activePeriod)
      if (!before) { if (latest.isCurrent(id)) setState({ rows: [], beforeLabel: null }); return }
      // purchase_entries is period-scoped, not client-scoped, so it stays on supabase.from() as
      // ClientDashboard's own reads do. One row per bill line per period: paged.
      const [nowRes, beforeRes] = await withTimeout(Promise.all([
        fetchAllRows(() => supabase.from('purchase_entries').select('id, item_id, qty, rate').eq('period_id', activePeriod.id).order('id')),
        fetchAllRows(() => supabase.from('purchase_entries').select('id, item_id, qty, rate').eq('period_id', before.id).order('id')),
      ]), 25000, 'Price movers')
      if (nowRes.error) throw nowRes.error
      if (beforeRes.error) throw beforeRes.error
      const itemIds = [...new Set((nowRes.data || []).map(r => r.item_id).filter(Boolean))]
      const itemsRes = await withTimeout(fetchAllRowsChunked(itemIds, ids => scopedFrom('items', 'id, name, uom').in('id', ids).order('id')), 20000, 'Price movers')
      if (itemsRes.error) throw itemsRes.error
      if (!latest.isCurrent(id)) return
      const itemsById = Object.fromEntries((itemsRes.data || []).map(i => [i.id, i]))
      setState({ rows: priceMovers(nowRes.data, beforeRes.data, itemsById), beforeLabel: `${BS_MONTHS[before.bs_month - 1]} ${before.bs_year}` })
    } catch (e) {
      if (latest.isCurrent(id)) setState({ error: e })
    }
  }, [activePeriod, scopedFrom, latest])

  useEffect(() => { load() }, [load])

  return (
    <div className="card card--compact">
      <h3 className="dash-card-title">
        <Tip text="Items bought this month and last whose average price changed, ranked by what the change cost this month: the new price minus the old, times what you bought. Prices are the bills' own, before any bill discount." width={300}>
          Price movers
        </Tip>
      </h3>
      {state === null
        ? <div><span className="skeleton" style={{ display: 'inline-block', width: '70%', height: '1.2em' }} /></div>
        : state.error
          ? <ReportLoadError error={state.error} />
          : state.rows.length === 0
            ? <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
                {state.beforeLabel ? `No item's price moved against ${state.beforeLabel} yet.` : 'No earlier month to compare with yet.'}
              </p>
            : (
              <>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6, fontSize: 13 }}>
                  {state.rows.map(r => {
                    const up = r.impact > 0
                    return (
                      <li key={r.item_id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ color: 'var(--theme-text1)', minWidth: 0 }}>
                          {r.name}
                          <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}> · {rateMove(r)}</span>
                        </span>
                        {/* A rise costs money, so it is the red direction here; the arrow stays the fact. */}
                        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: up ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                          {up ? '▲' : '▼'} {npr(Math.abs(Math.round(r.impact)))}
                        </span>
                      </li>
                    )
                  })}
                </ul>
                <div className="stat-sub" style={{ marginTop: 8 }}>Against {state.beforeLabel}</div>
              </>
            )}
      <Link to="/supplier-prices" className="dash-tile-link">Price Tracker →</Link>
    </div>
  )
}
