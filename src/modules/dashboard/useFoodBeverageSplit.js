// Category revenue split for the dashboard's Sales Mix tab, bucketed by the real recipes.category
// text (Food/Beverage/Dessert/Snack/Other by default, client-customizable via
// settings.recipe_categories) — the same raw categories SalesPivot.jsx's pivot table shows, not
// collapsed into a fixed Food/Beverage/Other split. 'Sub-Recipe' rows are excluded (prep items, not
// menu sales) and a missing category falls back to 'Uncategorized', matching useSalesPivotData.
//
// ONE source since S814 4d (IMS-HANDOFF-7): `sales_entries` in the 'revenue' mode, every row but
// `pos_comp` — the Inventory Revenue tile's own population (periodRevenue), so the mix splits that
// tile's figure by category. The till's bills are already in it (PosOrders stamps a `pos` row per
// bill, and a credit note a `pos_credit` reversal), so the separate POS loader this hook used to add
// counted the till twice in spirit and a credit note twice in fact: once as the manual loader's
// `pos_credit` row and again by leaving the credited bill out of the POS one.
//
// `includeManual` / `includePos` say whether the card is showing at all and for which data. With
// Inventory in scope it is the one `sales_entries` read above. A POS-only Home (`includePos` alone)
// reads the till's own bills instead (loadFromPos: after discount, VAT included, a credit note a
// minus on its issue day): an outlet without Crest IMS posts nothing to `sales_entries` (S814 4e,
// IMS-HANDOFF-9), so the Inventory read would leave its mix empty.
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { loadFromSalesEntries, loadFromPos } from './useSalesPivotData'

export function useFoodBeverageSplit({ activePeriod, includeManual, includePos }) {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [buckets, setBuckets] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const loadIdRef = useRef(0)

  useEffect(() => {
    if (!clientId || !activePeriod || (!includeManual && !includePos)) {
      setBuckets({})
      setLoading(false)
      return
    }
    const myId = ++loadIdRef.current
    setLoading(true)
    const load = includeManual
      ? loadFromSalesEntries(activePeriod, scopedFrom, { sources: 'revenue' })
      : loadFromPos(activePeriod, scopedFrom, clientId)
    load.then(rows => {
      if (loadIdRef.current !== myId) return // superseded by a newer client switch
      const b = {}
      rows.forEach(r => {
        if (r.category === 'Sub-Recipe') return
        const cat = r.category || 'Uncategorized'
        b[cat] = (b[cat] || 0) + r.amount
      })
      setBuckets(b)
      setError(null)
      setLoading(false)
    }).catch(e => {
      // The loader throws on a failed read (S682), so this hook needs the catch or the Sales Mix
      // card would spin forever — and an empty bucket map here is the same silent zero.
      if (loadIdRef.current !== myId) return
      setError(e?.message || 'Could not load the sales mix.')
      setBuckets({})
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, activePeriod?.id, includeManual, includePos])

  return { buckets, loading, error }
}
