import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { groupsForDish, defaultSelection } from '../../shared/optionPricing'
import { buildCostRange, typicalSelections } from '../../shared/buildCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { loadOptionCatalog } from './customizationData'

// Crest Customization (S760): the cost range of every build-your-own dish on a costing page.
// Recipe Costing and Menu Pricing (IMS branch) both render it, so the loading lives here once.
//
// The hook finds the marked dishes itself (the catalog loader reads the mark, and tolerates a
// database the S760 migration has not reached), and reads the item rates it needs itself, so a page
// adopting it adds no column to its own queries.
//
// Reads, the last three only when at least one dish is marked:
//   the option catalog with its stock lines · the explosion of those lines (item yield %, sub-recipe
//   per-unit items) · the per-base-unit rate of every item they reach · 30 days of order lines for
//   the marked dishes, for the TYPICAL build.
//
// A failed catalog, explosion or rate read is an ERROR the page shows in place of the range — never
// a range computed without the choices' stock, which would be the near-zero food cost this exists to
// replace. The order-line read is different: the typical build falls back to the dish's defaults and
// SAYS so, because a POS-fenced IMS account reads that table as empty rather than as a failure.

export const TYPICAL_WINDOW_DAYS = 30
export const TYPICAL_MIN_PLATES = 10

const EMPTY = { loading: false, error: null, catalog: null, explosion: null, rates: {}, typical: {} }

/**
 * @param {object} args
 * @param {boolean} args.enabled                         Customization is live for this client
 * @param {object[]} args.recipes                        the page's dish rows ({ id, selling_price, category })
 * @param {(r: object) => number} args.fixedCostOf       the dish's own ingredient cost per plate
 * @returns {{ byRecipe: Record<string, object>, buildYourOwn: Set<string>, loading: boolean, error: string|null }}
 */
export function useBuildCostRanges({ enabled, recipes, fixedCostOf }) {
  const { scopedFrom, clientId } = useScopedDb()
  const [state, setState] = useState(EMPTY)

  useEffect(() => {
    if (!enabled || !clientId) { setState(EMPTY); return }
    let cancelled = false
    setState(s => ({ ...s, loading: true, error: null }))
    ;(async () => {
      try {
        const catalog = await loadOptionCatalog(scopedFrom, { withIngredients: true })
        if (catalog.error) throw new Error(catalog.error)
        if (!catalog.buildYourOwn.length) {
          if (!cancelled) setState({ ...EMPTY, catalog })
          return
        }
        const deltas = catalog.ingredients.map(i => ({ item_id: i.item_id, sub_recipe_id: i.sub_recipe_id, qty: i.qty_per_portion }))
        const explosion = await loadDeltaExplosion(supabase, [deltas])

        const itemIds = new Set(catalog.ingredients.map(i => i.item_id).filter(Boolean))
        Object.values(explosion.subPerUnit).forEach(list => list.forEach(x => itemIds.add(x.item_id)))
        const since = new Date(Date.now() - TYPICAL_WINDOW_DAYS * 86400000).toISOString()
        const [rateRes, lines] = await Promise.all([
          fetchAllRowsChunked([...itemIds], ids => scopedFrom('items', 'id, per_uom_rate').in('id', ids).order('id')),
          fetchAllRowsChunked(catalog.buildYourOwn, ids => scopedFrom('pos_order_items', 'id, recipe_id, selection_key, qty')
            .in('recipe_id', ids).gte('created_at', since).order('id')),
        ])
        if (rateRes.error) throw new Error(rateRes.error.message || 'item rates could not be read')
        const rates = Object.fromEntries((rateRes.data || []).map(r => [r.id, Number(r.per_uom_rate) || 0]))

        const groupKind = Object.fromEntries(catalog.groups.map(g => [g.id, g.kind]))
        const sizeIds = new Set(catalog.options.filter(o => groupKind[o.group_id] === 'size').map(o => o.id))
        if (lines.error) console.error('build-your-own typical builds: order lines unreadable, using defaults', lines.error)
        const typical = lines.error ? {} : typicalSelections(lines.data, sizeIds, TYPICAL_MIN_PLATES)
        if (!cancelled) setState({ loading: false, error: null, catalog, explosion, rates, typical })
      } catch (err) {
        if (!cancelled) setState({ ...EMPTY, error: err?.message || String(err) })
      }
    })()
    return () => { cancelled = true }
  }, [enabled, clientId, scopedFrom])

  const buildYourOwn = useMemo(() => new Set(state.catalog?.buildYourOwn || []), [state.catalog])

  const byRecipe = useMemo(() => {
    const out = {}
    const { catalog, explosion, rates, typical } = state
    if (!catalog || !explosion || !buildYourOwn.size) return out
    const ctx = {
      optionsById: Object.fromEntries(catalog.options.map(o => [o.id, o])),
      groupsById: Object.fromEntries(catalog.groups.map(g => [g.id, g])),
      ingredientsByOption: catalog.ingredients.reduce((m, i) => { (m[i.option_id] = m[i.option_id] || []).push(i); return m }, {}),
      explosion,
      rateByItem: rates,
    }
    for (const r of recipes || []) {
      if (!buildYourOwn.has(r.id) || r.category === 'Sub-Recipe') continue
      const dishGroups = groupsForDish(r.id, catalog)
      if (!dishGroups.length) { out[r.id] = { empty: true }; continue }
      const t = typical[r.id]
      const range = buildCostRange({
        dishGroups,
        basePrice: Number(r.selling_price) || 0,
        fixedCost: Number(fixedCostOf(r)) || 0,
        typicalIds: t ? t.ids : defaultSelection(dishGroups),
        ctx,
      })
      out[r.id] = {
        ...range,
        typicalSource: t
          ? `the most-picked build in the last ${TYPICAL_WINDOW_DAYS} days (${t.plates} of ${t.total} plates)`
          : 'the dish’s pre-selected choices (not enough recent orders to learn from)',
      }
    }
    return out
  }, [state, buildYourOwn, recipes, fixedCostOf])

  return { byRecipe, buildYourOwn, loading: state.loading, error: state.error }
}
