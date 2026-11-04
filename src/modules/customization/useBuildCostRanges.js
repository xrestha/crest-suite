import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { groupsForDish, defaultSelection } from '../../shared/optionPricing'
import { buildCostRange, typicalSelections } from '../../shared/buildCost'
import { loadDeltaExplosion } from '../../utils/orderLineIngredients'
import { withTimeout, settleWithin } from '../../utils/withTimeout'
import { loadOptionCatalog, CUSTOMIZATION_READ_MS } from './customizationData'

// Crest Customization (S760): the cost range of every build-your-own dish on a costing page.
// Recipe Costing and Menu Pricing (IMS branch) both render it, so the loading lives here once.
//
// The hook finds the marked dishes itself (the catalog loader reads the mark, and tolerates a
// database the S760 migration has not reached), and reads the item rates it needs itself, so a page
// adopting it adds no column to its own queries.
//
// Reads, the last three only when at least one dish is marked, and those three side by side:
//   the option catalog with its stock lines · the explosion of those lines (item yield %, sub-recipe
//   per-unit items) · the per-base-unit rate of every item · the marked dishes' order lines on bills
//   PAID in the last 30 days, for the TYPICAL build.
//
// A failed catalog, explosion or rate read is an ERROR the page shows in place of the range — never
// a range computed without the choices' stock, which would be the near-zero food cost this exists to
// replace. The order-line read is different: the typical build falls back to the dish's defaults and
// SAYS so, because a POS-fenced IMS account reads that table as empty rather than as a failure.
//
// S862 SETUP-9: every read has a time limit (CUSTOMIZATION_READ_MS), so a hang becomes the error
// state rather than "…" for the whole visit; a late order-line read falls back to the defaults.
// S862 SETUP-2: the option catalog is returned too (`catalog`, with `catalogLoading` and
// `catalogFailed`), so Recipe Costing's price box checks the dish's sizes from this read rather
// than a second one. It is kept when a later read fails: the price check needs only the catalog.
// S877: a page that reads the catalog itself (Menu Pricing, for its choice labels and price check)
// hands that read in as `catalogRead`, so one request serves both. Left out, the hook reads its own.

export const TYPICAL_WINDOW_DAYS = 30
export const TYPICAL_MIN_PLATES = 10

const EMPTY = { loading: false, error: null, catalog: null, explosion: null, rates: {}, typical: {}, catalogFailed: false }

/**
 * @param {object} args
 * @param {boolean} args.enabled                         Customization is live for this client
 * @param {object[]} args.recipes                        the page's dish rows ({ id, selling_price, category })
 * @param {(r: object) => number} args.fixedCostOf       the dish's own ingredient cost per plate
 * @param {null|{ clientId: string, catalog?: object, error?: any }} [args.catalogRead]  S877: the
 *   caller's own read of loadOptionCatalog(scopedFrom, { withIngredients: true }), tagged with the
 *   client it was read for: null (or another client's) while it is on its way, `error` for a failed
 *   or timed-out read, `catalog` for the answer. Each new answer is costed again. Left out
 *   (undefined), the hook reads the catalog itself, as Recipe Costing has it.
 * @returns {{ byRecipe: Record<string, object>, buildYourOwn: Set<string>, loading: boolean, error: string|null,
 *            catalog: object|null, catalogLoading: boolean, catalogFailed: boolean }}
 */
export function useBuildCostRanges({ enabled, recipes, fixedCostOf, catalogRead }) {
  const { scopedFrom, clientId } = useScopedDb()
  const [state, setState] = useState(EMPTY)
  const supplied = catalogRead !== undefined
  // Only an answer for THIS client counts; anything else is still on its way. Keyed on the answer
  // itself, not the wrapper, so a caller building a fresh wrapper per render does not re-read.
  const given = supplied && catalogRead && catalogRead.clientId === clientId ? catalogRead : null
  const givenCatalog = given?.catalog || null
  const givenError = given?.error || null

  useEffect(() => {
    if (!enabled || !clientId) { setState(EMPTY); return }
    let cancelled = false
    // A re-run is a new client (scopedFrom follows it): nothing read for the last one is kept, or a
    // catalog that lands first would be costed against the last client's rates.
    setState({ ...EMPTY, loading: true })
    if (supplied && !givenCatalog && !givenError) return
    ;(async () => {
      let catalog = null
      try {
        const read = supplied
          ? (givenError ? { error: givenError } : givenCatalog)
          : await settleWithin(loadOptionCatalog(scopedFrom, { withIngredients: true }), CUSTOMIZATION_READ_MS, 'Loading the choices')
        if (read.error) throw read.error instanceof Error ? read.error : new Error(read.error)
        catalog = read
        if (!catalog.buildYourOwn.length) {
          if (!cancelled) setState({ ...EMPTY, catalog })
          return
        }
        if (!cancelled) setState(s => ({ ...s, catalog }))
        const deltas = catalog.ingredients.map(i => ({ item_id: i.item_id, sub_recipe_id: i.sub_recipe_id, qty: i.qty_per_portion }))
        const since = new Date(Date.now() - TYPICAL_WINDOW_DAYS * 86400000).toISOString()
        // S869: the rates and the recent orders go out WITH the explosion, not after it: neither needs
        // its answer. The rates are every item's (a few KB), because which raw items a sub-recipe line
        // reaches is only known once the walk lands, and a read after it was one more wait on Recipe
        // Costing and Menu Pricing than the page's own reads.
        const [explosion, rateRes, lines] = await Promise.all([
          withTimeout(loadDeltaExplosion(supabase, [deltas]), CUSTOMIZATION_READ_MS, 'Reading the stock lines of the choices'),
          settleWithin(fetchAllRows(() => scopedFrom('items', 'id, per_uom_rate').order('id')),
            CUSTOMIZATION_READ_MS, 'Reading item rates'),
          // Only builds a guest paid for (S792, RECIPES-10): the line's bill closed 'paid' — the house
          // definition get_cooccurrence and the POS reports use — windowed by when the BILL closed.
          // This read every line by its own created_at, so a voided bill, a table still open and a
          // bill written off all taught "the most-picked build". A comped line on a paid bill still
          // counts: the plate was built and served.
          settleWithin(fetchAllRowsChunked(catalog.buildYourOwn, ids => scopedFrom('pos_order_items', 'id, recipe_id, selection_key, qty, pos_orders!inner(close_type, closed_at)')
            .in('recipe_id', ids).eq('pos_orders.close_type', 'paid').gte('pos_orders.closed_at', since).order('id')),
            CUSTOMIZATION_READ_MS, 'Reading recent orders'),
        ])
        if (rateRes.error) throw new Error(rateRes.error.message || 'item rates could not be read')
        const rates = Object.fromEntries((rateRes.data || []).map(r => [r.id, Number(r.per_uom_rate) || 0]))

        const groupKind = Object.fromEntries(catalog.groups.map(g => [g.id, g.kind]))
        const sizeIds = new Set(catalog.options.filter(o => groupKind[o.group_id] === 'size').map(o => o.id))
        if (lines.error) console.error('build-your-own typical builds: order lines unreadable, using defaults', lines.error)
        const typical = lines.error ? {} : typicalSelections(lines.data, sizeIds, TYPICAL_MIN_PLATES)
        if (!cancelled) setState({ ...EMPTY, catalog, explosion, rates, typical })
      } catch (err) {
        if (!cancelled) setState({ ...EMPTY, error: err?.message || String(err), catalog, catalogFailed: !catalog })
      }
    })()
    return () => { cancelled = true }
  }, [enabled, clientId, scopedFrom, supplied, givenCatalog, givenError])

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
        typicalSource: range.typicalFilled
          // S856: the build that would have been shown is not one a guest can order.
          ? (t
            ? `the cheapest build a guest can order, because the most-picked build in the last ${TYPICAL_WINDOW_DAYS} days no longer fits the choices`
            : 'the cheapest build a guest can order, because the pre-selected choices leave a required choice empty (not enough recent orders to learn from)')
          : t
            ? `the most-picked build in the last ${TYPICAL_WINDOW_DAYS} days (${t.plates} of ${t.total} plates)`
            : 'the dish’s pre-selected choices (not enough recent orders to learn from)',
      }
    }
    return out
  }, [state, buildYourOwn, recipes, fixedCostOf])

  return {
    byRecipe, buildYourOwn, loading: state.loading, error: state.error,
    catalog: state.catalog,
    // Neither answered nor failed yet (the first render, before the effect has started, included).
    catalogLoading: !!enabled && !!clientId && !state.catalog && !state.catalogFailed,
    catalogFailed: state.catalogFailed,
  }
}
