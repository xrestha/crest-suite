// Category revenue split for the dashboard — combines the same two sources useSalesPivotData
// already reads (manual sales_entries + POS order items), bucketed by the real recipes.category
// text (Food/Beverage/Dessert/Snack/Other by default, client-customizable via
// settings.recipe_categories) — the same raw categories SalesPivot.jsx's pivot table shows,
// not collapsed into a fixed Food/Beverage/Other split. 'Sub-Recipe' rows are excluded (prep
// items, not menu sales) and a missing category falls back to 'Uncategorized', matching
// useSalesPivotData's own convention.
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
    Promise.all([
      includeManual ? loadFromSalesEntries(activePeriod, scopedFrom) : Promise.resolve([]),
      includePos ? loadFromPos(activePeriod, scopedFrom) : Promise.resolve([]),
    ]).then(([manualRows, posRows]) => {
      if (loadIdRef.current !== myId) return // superseded by a newer client switch
      const b = {}
      ;[...manualRows, ...posRows].forEach(r => {
        if (r.category === 'Sub-Recipe') return
        const cat = r.category || 'Uncategorized'
        b[cat] = (b[cat] || 0) + r.amount
      })
      setBuckets(b)
      setError(null)
      setLoading(false)
    }).catch(e => {
      // Both loaders now throw on a failed read (S682), so this hook needs the catch or the Sales
      // Mix card would spin forever — and an empty bucket map here is the same silent zero.
      if (loadIdRef.current !== myId) return
      setError(e?.message || 'Could not load the sales mix.')
      setBuckets({})
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, activePeriod?.id, includeManual, includePos])

  return { buckets, loading, error }
}
