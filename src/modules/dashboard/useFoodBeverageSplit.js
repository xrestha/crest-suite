// Food vs Beverage revenue split for the dashboard — combines the same two sources
// useSalesPivotData already reads (manual sales_entries + POS order items), bucketed by
// recipes.category. Category is a real <select> in Recipes.js (recipeCategories, default
// ['Food','Beverage','Dessert','Snack','Other'], client-customizable via settings.recipe_categories)
// plus the special 'Sub-Recipe' value — so an exact match on 'Food'/'Beverage' is a legitimate
// bucket, not a free-text guess. Everything else (Dessert/Snack/Other/custom categories) buckets
// as 'Other'; 'Sub-Recipe' rows are excluded (prep items, not menu sales).
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { loadFromSalesEntries, loadFromPos } from './useSalesPivotData'

const EMPTY = { Food: 0, Beverage: 0, Other: 0 }

function bucketOf(category) {
  if (category === 'Food') return 'Food'
  if (category === 'Beverage') return 'Beverage'
  return 'Other'
}

export function useFoodBeverageSplit({ activePeriod, includeManual, includePos }) {
  const { clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [buckets, setBuckets] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const loadIdRef = useRef(0)

  useEffect(() => {
    if (!clientId || !activePeriod || (!includeManual && !includePos)) {
      setBuckets(EMPTY)
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
      const b = { ...EMPTY }
      ;[...manualRows, ...posRows].forEach(r => {
        if (r.category === 'Sub-Recipe') return
        b[bucketOf(r.category)] += r.amount
      })
      setBuckets(b)
      setLoading(false)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, activePeriod?.id, includeManual, includePos])

  return { buckets, loading }
}
