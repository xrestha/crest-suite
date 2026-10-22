import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../supabaseClient'
import Tip from '../../components/Tip'
import ReportLoadError from '../../components/ReportLoadError'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { settleWithin } from '../../utils/withTimeout'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { npr } from '../../shared/nepalMoney'
import { unitRateParts } from '../../shared/unitRate'
import { fmtQty } from '../../modules/ims/stockcount/reorderPacks'
import { BS_MONTHS } from '../../utils/bsCalendar'
import { compareItemPrices } from './groupItemPriceMath'

// "Same item, different price" (S800) — what each Crest Suite Pro outlet in the group paid this
// month for the same item, so an owner can see which branch is buying dearer and ask why.
//
// get_group_item_prices does the reading (Owner/admin, Suite Pro outlets only, server-side) and
// returns sums; compareItemPrices works out the per-unit prices. Owner decisions: an item is "the
// same" only when the HQ master-data push linked it (master_id), never by name; prices are before
// VAT, after each bill's discount; the month is the one picked at the top of the Group Console.
//
// Its own read and its own states: a failure here costs this panel only, never the branch table.
//
// S849: the read is paged (GROUP-6) — a group of five outlets buying a few hundred linked items passes
// PostgREST's 1,000-row cut, and a cut list silently drops an outlet's price — on the RPC's own unique
// order (item_key, client_id, uom). An outlet is compared while its own Crest Suite Pro is live
// (ACCESS-1), free lines are left out in SQL (SU22), and Crest support reads a client's group by id
// (ACCESS-8, `readGroupId`). `refreshKey` is bumped by the page's Refresh, so this panel re-reads too.

const LIMIT = 10

const rateText = (rate, uom) => {
  const p = unitRateParts(rate, uom, { precise: true })
  return p ? `${p.primary.value}${p.primary.unit ? ` / ${p.primary.unit}` : ''}` : '—'
}

// readGroupId: null for the Owner (the server reads their own group); the viewed client's group for
// Crest support. refreshKey: the page's Refresh counter.
export default function GroupItemPrices({ bsYear, bsMonth, readGroupId = null, refreshKey = 0 }) {
  const [state, setState] = useState({ loading: true, error: null, rows: [] })
  const [showAll, setShowAll] = useState(false)
  const latest = useLatestRequest()

  useEffect(() => {
    const key = `${bsYear}-${bsMonth}-${readGroupId || 'own'}-${refreshKey}`
    latest.begin(key)
    setState(s => ({ ...s, loading: true, error: null }))
    setShowAll(false)
    const args = { p_bs_year: bsYear, p_bs_month: bsMonth, ...(readGroupId ? { p_group_id: readGroupId } : {}) }
    ;(async () => {
      const res = await settleWithin(
        fetchAllRows(() => supabase.rpc('get_group_item_prices', args).order('item_key').order('client_id').order('uom')),
        20000, 'Same item, different price')
      if (!latest.isCurrent(key)) return
      if (res.error) setState({ loading: false, error: res.error, rows: [] })
      else setState({ loading: false, error: null, rows: res.data || [] })
    })()
  }, [bsYear, bsMonth, readGroupId, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const cmp = useMemo(() => compareItemPrices(state.rows), [state.rows])
  // One column per outlet that bought any compared item, in name order.
  const outletCols = useMemo(() => {
    const m = new Map()
    for (const it of cmp.items) for (const o of it.outlets) if (!m.has(o.clientId)) m.set(o.clientId, o.clientName)
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [cmp])
  const monthLabel = `${BS_MONTHS[bsMonth - 1]} ${bsYear}`
  const shown = showAll ? cmp.items : cmp.items.slice(0, LIMIT)

  return (
    <div className="card" style={{ marginTop: 28 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px', color: 'var(--theme-text1)' }}>
          Same item, different price{' '}
          {/* S857: two plain sentences; the rest of the method (never by name, free lines left out,
              VAT and PAN outlets alike, live Suite only) is on the Help page. */}
          <Tip text="Only items your HQ pushed to the branches count as the same item. Prices are before VAT and after each bill discount, averaged over the month." width={300}>ⓘ</Tip>
        </h2>
        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0 }}>
          What each outlet paid in {monthLabel} for the same item, cheapest marked. A higher price can have a reason — a smaller order, a nearer supplier, a better grade — so this shows where to ask, not who is wrong.
        </p>
      </div>

      {state.loading ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>Comparing prices…</p>
      ) : state.error ? (
        <ReportLoadError error={state.error} />
      ) : cmp.items.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
          No linked item was bought by two or more outlets in {monthLabel}. Items are linked when your HQ pushes its items to a branch with Push master data below; until then there is nothing to compare.
        </p>
      ) : (
        <>
          {cmp.totalExtra > 0 && (
            <p className="note-banner" style={{ margin: '0 0 12px', fontSize: 12 }}>
              Had every outlet paid the group&apos;s lowest price for {cmp.comparable === 1 ? 'this item' : `these ${cmp.comparable} items`}, {monthLabel} would have cost <strong>{npr(cmp.totalExtra)}</strong> less.
            </p>
          )}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  {outletCols.map(c => (
                    <th key={c.id} style={{ textAlign: 'right' }}>{c.name}</th>
                  ))}
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="What the group paid above its own lowest price for this item this month." width={280}>Above the lowest</Tip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map(it => (
                  <tr key={it.key}>
                    <td>
                      {it.name}
                      {it.otherNames.length > 0 && (
                        <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>also called {it.otherNames.join(', ')}</div>
                      )}
                    </td>
                    {outletCols.map(c => {
                      const os = it.outlets.filter(o => o.clientId === c.id)
                      if (os.length === 0) return <td key={c.id} style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>—</td>
                      if (it.unitsDiffer) {
                        return (
                          <td key={c.id} style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                            {os.map(o => <div key={o.uom} style={{ whiteSpace: 'nowrap' }}>{fmtQty(o.qty)} {o.uom}</div>)}
                          </td>
                        )
                      }
                      const o = os[0]
                      return (
                        <td key={c.id} style={{ textAlign: 'right' }}>
                          <span style={{ whiteSpace: 'nowrap' }}>{o.rate != null ? rateText(o.rate, o.uom) : '—'}</span>
                          {o.cheapest && <div><span className="badge-gray" style={{ fontSize: 10 }}>Lowest</span></div>}
                          <div style={{ fontSize: 11, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>bought {fmtQty(o.qty)} {o.uom}</div>
                        </td>
                      )
                    })}
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {it.unitsDiffer ? (
                        <Tip text="The outlets count this item in different units, so their prices are not compared. Set the same unit in each outlet's Item Master to compare them." width={260}
                          style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                          <span className="badge-amber">Units differ</span>
                        </Tip>
                      ) : it.extra > 0 ? (
                        <>
                          {npr(it.extra)}
                          <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>top price {Math.round(it.spreadPct)}% above lowest</div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--theme-text2)' }}>Same price</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cmp.items.length > LIMIT && (
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAll(v => !v)}>
              {showAll ? `Show the top ${LIMIT}` : `Show all ${cmp.items.length} items`}
            </button>
          )}
        </>
      )}
    </div>
  )
}
