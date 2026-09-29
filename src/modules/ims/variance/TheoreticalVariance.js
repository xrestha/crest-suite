import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import { COGS_FORMULA, computeUsed, varianceBand, varianceFlagPct } from '../../../shared/imsFormulas'
import { selectDepletingSales } from '../sales/salesDepletion'
import { loadDeltaExplosion, deltaItems } from '../../../utils/orderLineIngredients'
import {
  linkedItemIdsOf, varianceRowBand, hasVarianceActivity, isUncountedGap, judgedRows, closingCountMap, VARIANCE_FLAG_TEXT as FLAG_TEXT,
} from './variancePopulation'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import ReportLoadError from '../../../components/ReportLoadError'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'

export default function TheoreticalVariance() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const { settings } = useSettings()
  const biz = useBizInfo()
  // item_id -> yield_pct for EVERY item, unfiltered. A ref rather than state because init() must
  // populate it and then call computeVariance() in the same tick, before a state update lands.
  const yieldMapRef = useRef({})

  const periodReq = useLatestRequest()
  const [periods,         setPeriods]         = useState([])
  const [selectedPeriod,  setSelectedPeriod]  = useState(null)
  const [items,           setItems]           = useState([])
  const [categories,      setCategories]      = useState([])
  const [recipes,         setRecipes]         = useState([])
  const [rows,            setRows]            = useState([])
  const [loading,         setLoading]         = useState(true)
  const [loadError,       setLoadError]       = useState(null)
  const [computing,       setComputing]       = useState(false)
  const [filterCat,       setFilterCat]       = useState('all')
  const [filterType,      setFilterType]      = useState('all') // all | over | under
  const [sortBy,          setSortBy]          = useState('variance_val')
  const [hasClosing,      setHasClosing]      = useState(true)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line

  async function init() {
    setLoading(true)
    setLoadError(null)
    const initResults = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      fetchAllRows(() => scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      scopedFrom('categories').order('sort_order'),
      scopedFrom('recipes', 'id, name, yield_qty'),
    ])
    // A failed read is not "no periods yet" — surface it instead of rendering empty (S612 silent-zero rule).
    const initFailed = firstError(initResults)
    if (initFailed) { setLoadError(initFailed); setLoading(false); return }
    const [{ data: p }, { data: i }, { data: c }, { data: r }] = initResults

    const tvRecipeIds = (r || []).map(x => x.id)
    const ingResults = await Promise.all([
      // PAGED AND CHUNKED, like the shared walk in utils/recipeCost.js and Recipes.js's own
      // ingredient read (S714). This page reimplements the recursion locally (expandIngredients
      // below), and being private is exactly why it never received the S711 sweep — a rule about
      // how to read this table only reaches the reads someone opens. The seed is the client's
      // ENTIRE recipe book (`scopedFrom('recipes','id')` above, unfiltered), so this is one row
      // per ingredient across every recipe: ~120 recipes averaging 8 ingredients is already past
      // PostgREST's 1000-row cap, and a few hundred uuids in the `.in()` URL is a 414 rather than
      // a truncation.
      //
      // The direction of the error is what made it dangerous HERE in particular. Rows past the cut
      // are simply absent, so the dishes below them expand to nothing and theoretical usage comes
      // out LOW — and on this page a low theoretical does not read as missing data, it reads as
      // OVER-CONSUMPTION. That is a variance report flagging shrinkage against staff for stock
      // that was never actually short. No error, no short-array tell.
      //
      // `.order('id')` is the unique tiebreaker fetchAllRows requires: without a total order,
      // paging can repeat a row on one page and skip it on the next.
      fetchAllRowsChunked(tvRecipeIds, ids => supabase
        .from('recipe_ingredients')
        .select('recipe_id, item_id, sub_recipe_id, qty_per_portion')
        .in('recipe_id', ids)
        .order('id')),
      // Deliberately UNFILTERED, unlike the `items` fetch above that backs the display table: a
      // recipe can legitimately reference an inactive item or a sub-recipe mirror row, and its
      // trim loss is still real. Filtering here is what made yield_pct silently default to 100%.
      fetchAllRows(() => scopedFrom('items', 'id, yield_pct').order('id')),
    ])
    // S612: a failed ingredient/yield read silently understates theoretical usage — surface it.
    const ingFailed = firstError(ingResults)
    if (ingFailed) { setLoadError(ingFailed); setLoading(false); return }
    const [{ data: ri }, { data: allItems }] = ingResults
    const ym = {}
    ;(allItems || []).forEach(x => { ym[x.id] = x.yield_pct })
    yieldMapRef.current = ym

    setPeriods(p || [])
    setItems(i || [])
    setCategories(c || [])

    // Attach ingredients to recipes — grouped in one pass, as Recipes.js does. A filter per
    // recipe is O(recipes x ingredient rows), which only became worth caring about once the read
    // above stopped truncating at 1000: the full book is now genuinely every row.
    const ingsByRecipe = new Map()
    ;(ri || []).forEach(row => {
      const list = ingsByRecipe.get(row.recipe_id)
      if (list) list.push(row)
      else ingsByRecipe.set(row.recipe_id, [row])
    })
    const allRecipes = (r || []).map(recipe => ({
      ...recipe,
      recipe_ingredients: ingsByRecipe.get(recipe.id) || []
    }))
    // Attach sub_recipe object for expansion
    allRecipes.forEach(recipe => {
      recipe.recipe_ingredients.forEach(ing => {
        if (ing.sub_recipe_id) ing.sub_recipe = allRecipes.find(x => x.id === ing.sub_recipe_id) || null
      })
    })
    setRecipes(allRecipes)

    // Most recent CLOSED period by default — the "Actual" side of this comparison subtracts a
    // closing stock count that does not exist until month-end, so opening on the live month made
    // every item read as massively over-consumed. Same fix as Variance.js.
    const chosen = (p || []).find(x => x.status === 'closed') || (p || []).find(x => x.status === 'open')
    if (chosen) {
      // init() claims the page too (S756) — otherwise, once a period change has ever run, an admin
      // client switch re-runs init against a ref still holding the old client's period id and
      // computeVariance's isCurrent checks skip every setter (the S721 shape).
      periodReq.begin(chosen.id)
      setSelectedPeriod(chosen)
      await computeVariance(chosen.id, i || [], allRecipes)
    }
    // Unconditional on purpose: a period picked mid-init runs under its own `computing` flag, and
    // the table shows "Computing variance…" until THAT load clears it.
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setComputing(true)
    await computeVariance(periodId, items, recipes)
    // Only the load that still owns the page may clear the flag (S756) — a superseded one returns
    // early from computeVariance and would otherwise un-gate the newer load's half-built view.
    if (periodReq.isCurrent(periodId)) setComputing(false)
  }

  // Recursively expand a recipe's ingredients into raw { item_id, qty } pairs.
  // scale accounts for sub-recipe yield (qty used ÷ yield_qty of sub-recipe).
  // qty is as-purchased (gross), accounting for item yield_pct trim loss.
  // `depth` mirrors the shared explodeRecipeIngredients util's own cyclic guard. Recipes.js blocks
  // cycles at save time (recipeCycle.js, plus the recipe_ingredients_guard_cycle trigger since
  // S792), so this is a backstop for legacy data that predates those checks — without it a cyclic sub-recipe reference recurses until the stack blows
  // and takes the whole page down rather than degrading to a wrong number.
  function expandIngredients(recipe, allRecipes, itemList, scale = 1, depth = 0) {
    if (depth > 10) return []
    const result = []
    ;(recipe.recipe_ingredients || []).forEach(ri => {
      const qty = parseFloat(ri.qty_per_portion || 0) * scale
      if (ri.item_id) {
        // yieldMap, not itemList: `items` is loaded filtered to is_active=true + is_sub_recipe=false
        // for the DISPLAY table, so looking yield_pct up in it silently fell back to 100% (no trim
        // loss) for any ingredient that happens to be inactive or a sub-recipe mirror row —
        // understating theoretical usage. The shared util joins items(yield_pct) unfiltered and so
        // never had this hole; this page reimplements the recursion locally and did.
        const yieldFactor = (parseFloat(yieldMapRef.current[ri.item_id]) || 100) / 100
        result.push({ item_id: ri.item_id, qty: qty / yieldFactor })
      } else if (ri.sub_recipe_id) {
        const sr = ri.sub_recipe || allRecipes.find(x => x.id === ri.sub_recipe_id)
        if (sr) {
          const yieldQty = parseFloat(sr.yield_qty) || 1
          result.push(...expandIngredients(sr, allRecipes, itemList, qty / yieldQty, depth + 1))
        }
      }
    })
    return result
  }

  async function computeVariance(periodId, itemList, allRecipes) {
    setLoadError(null)
    const results = await Promise.all([
      // source + bs_day feed selectDepletingSales' POS-supersedes-manual dedup; paged so a busy
      // POS period's sales_entries can't truncate theoretical usage at 1000 rows.
      // ingredient_deltas: a customized plate also consumes (or spares) its options' stock lines (S758).
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, source, ingredient_deltas').eq('period_id', periodId).order('id')),
      // Every per-item-per-period read below is paged (S719). Each is one row per item per period,
      // so a client past 1000 items — or a multi-period window — truncates silently, and
      // truncation returns NO error for the firstError() check to catch. The direction is what
      // matters here: a missing CLOSING row makes actual usage read as "everything on the shelf
      // plus everything bought", which is a false Over variance on the report a client uses to
      // chase shrinkage. init()'s two `items` reads are paged for the same reason S717 gave on
      // Stock Report — they produce the ids every one of these is joined against, and the second
      // (yield_pct) is deliberately unfiltered, so it is the LONGER of the two.
      fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId).order('id')),
    ])
    if (!periodReq.isCurrent(periodId)) return   // stale load — its failure must not clobber the current view
    // A failed read must never flow through the `|| []`s below into a confident NPR-0 report (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); return }
    const [{ data: sales }, { data: opening }, { data: closing }, { data: purch }, { data: rets }, { data: wast }, { data: staffMeals }] = results

    // Sales map: recipe_id → total qty sold. Deduplicated via the shared POS-supersedes-manual
    // rule so a client running POS *and* manual bulk entry doesn't double-count the same dish and
    // inflate theoretical usage (which masks real over-consumption). Kept identical to Variance.js,
    // which this page must agree with.
    const depleting = selectDepletingSales(sales || [])
    const salesMap = {}
    depleting.forEach(e => { salesMap[e.recipe_id] = (salesMap[e.recipe_id] || 0) + parseFloat(e.qty_sold || 0) })

    // A customized plate consumes its options' stock lines too (S758). Those deltas can name
    // sub-recipes, which go through the ONE shared walk inside loadDeltaExplosion, not the local
    // expandIngredients below. It throws on a failed read, and a missing explosion would read a
    // Half plate as a whole one — so it fails the load like any other read here.
    let explosion
    try {
      explosion = await loadDeltaExplosion(supabase, depleting.map(e => e.ingredient_deltas))
    } catch (err) {
      if (!periodReq.isCurrent(periodId)) return
      setLoadError(err); setRows([]); return
    }
    if (!periodReq.isCurrent(periodId)) return

    // Every recipe's expansion, sold or not (S792, D36): the theoretical sum below needs the sold
    // ones, and "is this item in any recipe" needs them all. The same { recipeId: [{ item_id, qty }] }
    // shape Variance.js gets from explodeRecipeIngredients over the whole book.
    const breakdown = {}
    allRecipes.forEach(recipe => { breakdown[recipe.id] = expandIngredients(recipe, allRecipes, itemList) })

    // Theoretical consumption: item_id → qty
    const theoretical = {}
    allRecipes.forEach(recipe => {
      const sold = salesMap[recipe.id] || 0
      if (sold <= 0) return
      breakdown[recipe.id].forEach(({ item_id, qty }) => {
        theoretical[item_id] = (theoretical[item_id] || 0) + qty * sold
      })
    })
    // Option deltas × qty sold, per surviving (depleting) row — signed, so "no onion" subtracts.
    depleting.forEach(e => {
      if (!e.ingredient_deltas) return
      const n = parseFloat(e.qty_sold || 0)
      if (!n) return
      deltaItems(e.ingredient_deltas, explosion).forEach(({ item_id, qty }) => {
        theoretical[item_id] = (theoretical[item_id] || 0) + qty * n
      })
    })

    // Actual consumption maps
    const openMap = {}, purchMap = {}, retMap = {}, wastMap = {}, staffMap = {}
    ;(opening || []).forEach(r => { openMap[r.item_id]  = parseFloat(r.qty || 0) })
    // Counts only (S792): a NULL physical_qty is not a count — see closingCountMap.
    const closeMap = closingCountMap(closing)
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // Local, not the state value: setState is async, so the row builder below would otherwise read
    // the PREVIOUS period's answer. Counts, not rows: a month holding only NULL rows is uncounted.
    const hasClosingRows = Object.keys(closeMap).length > 0
    setHasClosing(hasClosingRows)
    ;(purch   || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) + parseFloat(r.qty || 0) })
    ;(rets    || []).forEach(r => { retMap[r.item_id]   = (retMap[r.item_id]   || 0) + parseFloat(r.qty || 0) })
    ;(wast    || []).forEach(r => { wastMap[r.item_id]  = (wastMap[r.item_id]  || 0) + parseFloat(r.qty || 0) })
    ;(staffMeals || []).forEach(r => { staffMap[r.item_id] = (staffMap[r.item_id] || 0) + parseFloat(r.qty || 0) })

    // THE SAME POPULATION AS Variance.js (S792, FIGURES-4 / owner decision D36). This used to be
    // `itemList.filter(item => theoretical > 0.001)`, so an ingredient whose dishes sold nothing —
    // but whose stock fell anyway — never reached this page, while Variance judged it Over and put
    // its whole usage into its loss total: "Flagged 7, NPR 18,400" there, "Items Over Tolerance 5,
    // NPR 11,200" here, for one month. Now every active item is a row (drawn when it has activity),
    // an item in no recipe gets D17's grey "no recipe linked" state, and the verdict, the flagged
    // count and the totals come from ./variancePopulation.js, which Variance.js reads too.
    const linkedItemIds = linkedItemIdsOf(breakdown, depleting, explosion)
    const computed = itemList.map(item => {
      const openQty         = openMap[item.id] || 0
      const purchQty        = (purchMap[item.id] || 0) - (retMap[item.id] || 0)   // net of returns
      // Measurability is PER ITEM (S719), exactly as on Variance.js, which this page must agree
      // with. `hasClosing` only asks whether the month has ANY closing rows; an item missing from
      // the count got closeQty 0, so actual usage read as everything on hand plus everything
      // bought and the row wore a full Over verdict built out of an absence. A count of 0 is a
      // real count (S695), so presence is `in closeMap`, never `> 0`.
      const hasCount        = item.id in closeMap
      const theoreticalUsed = theoretical[item.id] || 0
      // Staff meals are in (they were once omitted here, unlike Variance.js/Stock.js, and logged
      // staff-meal consumption read as unexplained "over-consumption"); computeUsed is the one form.
      const actualUsed      = computeUsed({
        opening: openQty, purchases: purchQty, wastage: wastMap[item.id] || 0,
        staffMeals: staffMap[item.id] || 0, closing: hasCount ? closeMap[item.id] : 0,
      })
      const variance        = actualUsed - theoreticalUsed
      // null, not 0, when nothing using it sold: the percentage is undefined and prints "—". The
      // verdict still judges the row, through the shared signed surrogate.
      const variancePct     = theoreticalUsed > 0 ? (variance / theoreticalUsed) * 100 : null
      const rate            = parseFloat(item.per_uom_rate || 0)
      return {
        item, openQty, purchQty, hasCount,
        measured: hasClosingRows && hasCount,
        noRecipe: !linkedItemIds.has(item.id),
        theoreticalUsed, actualUsed, variance, variancePct, value: variance * rate, rate,
      }
    })

    setRows(computed)
  }

  // One verdict per row per data/settings change (S792) — varianceRowBand, the one Variance.js
  // reads — so the cells, the filter, the tiles and the footer cannot give a row two answers.
  const banded = useMemo(() => rows.map(r => ({ ...r, band: varianceRowBand(r, settings) })), [rows, settings])
  // The rows drawn: the same activity test as Variance.js (something moved, was expected to, or sat
  // on the shelf), not "its dishes sold".
  const activeRows = useMemo(() => banded.filter(hasVarianceActivity), [banded])

  function filteredRows() {
    return activeRows
      .filter(r => {
        if (filterCat !== 'all' && r.item.category_id !== filterCat) return false
        // By VERDICT, the same `band.flag` each row is painted with and the over/under tiles count
        // (S756, and since S792 the shared verdict). The raw `variance > 0.01` test put nearly every
        // item of a real month under "Over-consumed" — including rows wearing a green ✓ or a quiet ≈,
        // and uncounted rows whose variance is an artefact of the missing count — so the filter
        // contradicted the tile above it.
        if (filterType === 'over'  && r.band.flag !== 'over')  return false
        if (filterType === 'under' && r.band.flag !== 'under') return false
        return true
      })
      .sort((a, b) => {
        // Judged rows first, as on Variance (S796): a row with no verdict (not counted, no recipe)
        // must not outrank a real flagged loss just because its artefact figure is bigger.
        if (sortBy === 'variance_val') {
          const tier = r => (r.band?.flag === 'over' || r.band?.flag === 'under' ? 0 : r.band?.flag === 'ok' ? 1 : 2)
          return tier(a) - tier(b) || Math.abs(b.value) - Math.abs(a.value)
        }
        // A row with no percentage (nothing using it sold) sorts last either way — there is no
        // figure to rank it by, and its value is on the value sort.
        if (sortBy === 'variance_pct') {
          if (a.variancePct == null || b.variancePct == null) return (a.variancePct == null) - (b.variancePct == null)
          return Math.abs(b.variancePct) - Math.abs(a.variancePct)
        }
        if (sortBy === 'name')          return a.item.name.localeCompare(b.item.name)
        return 0
      })
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    // Shared letterhead + the same caveats the screen shows (S756). The sheet was a bare
    // json_to_sheet with no client, no period and none of the no-closing-count warning Variance.js's
    // export carries — so the confident numbers travelled without the banner that qualifies them.
    const notes = [
      hasClosing
        ? `Tolerance ±${varianceFlagPct(settings)}% · theoretical = sales × recipe qty · actual = ${COGS_FORMULA}`
        : 'NO CLOSING COUNT ENTERED — these figures treat everything still on hand as used; finish the Stock Count before acting on them',
      hasClosing && uncountedCount > 0
        ? `${uncountedCount} item(s) have no closing count and are marked "not counted" — they are excluded from the period totals`
        : null,
      noRecipeCount > 0
        ? `${noRecipeCount} item(s) are in no recipe and are marked "no recipe linked" — excluded from the over-tolerance count and the totals`
        : null,
      'A Variance % of "" means nothing using the item sold this period; its use is still judged, as on the Variance Report',
    ].filter(Boolean)
    const scopeLine = `Period: ${periodLabel}${selectedPeriod?.status === 'open' ? ' (open — provisional)' : ''}`
    const data = filteredRows().map(({ item, theoreticalUsed, actualUsed, variance, variancePct, value, hasCount, band: b }) => ({
      'Item':                item.name,
      'Category':            item.categories?.name || '',
      'UOM':                 item.uom,
      'Theoretical Qty':     +theoreticalUsed.toFixed(3),
      'Actual Qty':          +actualUsed.toFixed(3),
      'Variance Qty':        +variance.toFixed(3),
      'Variance %':          variancePct == null ? '' : +variancePct.toFixed(1),
      'Variance Value (NPR)': Math.round(value),
      'Closing counted':     hasCount ? 'yes' : 'no',
      'Flag':                b.key === 'immaterial' ? 'immaterial' : FLAG_TEXT[b.flag],
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Theoretical vs Actual', biz, scopeLine, notes, rows: data,
    }), 'Theoretical Variance')
    XLSX.writeFile(wb, `Theoretical-Variance-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const visible          = filteredRows()
  // Measured rows linked to a recipe only — the rows Variance.js totals (S719, D17, and since S792
  // the same helper). An item with no closing count has a variance manufactured out of an absence;
  // adding it to the period total is how the page reports a loss that is really an uncounted shelf.
  // An item in no recipe has nothing to be compared against, so its whole usage is not "loss".
  const judged           = judgedRows(banded)
  const measuredCount    = rows.filter(r => r.measured).length
  const uncountedCount   = rows.filter(isUncountedGap).length
  const noRecipeCount    = activeRows.filter(r => r.band.flag === 'no_recipe').length
  const totalTheorVal    = judged.reduce((s, r) => s + r.theoreticalUsed * r.rate, 0)
  const totalActualVal   = judged.reduce((s, r) => s + r.actualUsed * r.rate, 0)
  const totalVarianceVal = judged.reduce((s, r) => s + r.value, 0)
  // Counted by VERDICT, not by `variance > 0.01`. At a quantity threshold of a hundredth of a unit
  // essentially every item in a real month counts as over-used, so the tile below was permanently
  // red and its number contradicted the rows it sat above — the table flagged a handful, the KPI
  // claimed hundreds. Both now answer the same question as Variance.js's Flagged Items: how many
  // items are outside the client's tolerance and material enough to act on — an ingredient used
  // while its dishes sold nothing included (D36).
  const overCount        = judged.filter(r => r.band.flag === 'over').length
  const underCount       = judged.filter(r => r.band.flag === 'under').length
  // The aggregate the Total Variance tile is judged on — a rupee total alone has no percentage to
  // band, and `> 0 ? red : green` gave a NPR 40 whole-period variance the same red as NPR 40,000.
  const totalVariancePct = totalTheorVal > 0 ? (totalVarianceVal / totalTheorVal) * 100 : null
  const totalBand        = varianceBand(totalVariancePct, totalVarianceVal, settings, { measured: hasClosing })
  const noSales          = activeRows.length === 0 && !loading && !computing

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  const fmtNPR  = v => `NPR ${Math.abs(Math.round(v)).toLocaleString('en-IN')}`
  const fmtQty  = v => v === 0 ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: 3 })
  const fmtPct  = v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`

  // Was a private ladder hardcoding ±5, so the tolerance the client configures in
  // Settings → Thresholds reached the Variance Report and not this page — two adjacent nav items
  // measuring the same thing against different numbers, and the client's own setting honoured on
  // one of them. `varianceBand` is the only source now, and it brings the materiality floor with
  // it: a 40% swing worth NPR 20 is rounding on a small line, and painting it the loudest red on
  // the page is how a report stops being read.
  // `measured: false` while the closing count is missing — every figure is then an artefact of
  // the gap rather than a finding, and the banner above already says so.
  const band = (pct, value, measured = hasClosing) => varianceBand(pct, value, settings, { measured })

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="this comparison" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Theoretical vs Actual</h1>
          <p className="page-subtitle">
            Compare what should have been consumed (recipes × sales) against what was actually used
          </p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <select aria-label="Period"
          style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
          value={selectedPeriod?.id || ''}
          onChange={e => handlePeriodChange(e.target.value)}
        >
          {periods.map(p => (
            <option key={p.id} value={p.id}>
              {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}
            </option>
          ))}
        </select>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {!loadError && <>
      {!loading && !computing && selectedPeriod && !hasClosing && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Closing stock hasn’t been counted for {periodLabel} yet.</strong>{' '}
          The “Actual” column subtracts the closing count, so until it exists everything still on
          your shelves is counted as consumed and every item looks over-used. Finish the Stock
          Count for this month, or pick a closed month above.
        </div>
      )}

      {/* The PARTIAL case, which had no voice before S719: the month is counted, but not all of
          it, and every uncounted item was carrying an Over verdict built out of a closing count of
          zero. They are excluded from the totals and marked in the table. */}
      {!loading && !computing && hasClosing && uncountedCount > 0 && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>△ {uncountedCount} item{uncountedCount === 1 ? ' has' : 's have'} no closing count for {periodLabel}.</strong>{' '}
          Their “Actual” is everything that was on hand, which is a figure rather than a finding, so
          they are marked <em>not counted</em> in the table and left out of the totals — those cover
          the {measuredCount} item{measuredCount === 1 ? '' : 's'} that were counted.
        </div>
      )}

      {/* Explanation banner */}
      <div className="note-banner">
        <strong style={{ color: 'var(--theme-text1)' }}>How to read this:</strong> Theoretical = what your recipes say you should have used based on sales.
        Actual = {COGS_FORMULA}. The gap reveals over-portioning, theft, or data entry errors.
        Red rows need investigation. Green = within the ±{varianceFlagPct(settings)}% tolerance set in
        Settings → Thresholds; ≈ marks a gap too small in rupees to be worth chasing. An ingredient
        used while none of its dishes sold is judged too — its whole use is unexplained. The items
        covered are the Variance Report&apos;s, so the two pages flag the same things.
      </div>

      {/* Stat cards.
          S765: `.stat-grid` rather than a hand-rolled grid at a 180px floor. The floor was raised
          to 200px product-wide precisely because a Nepali-grouped `NPR 12,48,650` wraps below it —
          and these three figures ARE that shape, on the page that tells an owner money went
          missing. The class also brings `tabular-nums`, so the figures line up digit for digit. */}
      {!loading && !computing && activeRows.length > 0 && (
        <div className="stat-grid stat-grid--pair" style={{ marginBottom: 24 }}>
          {[
            { label: 'Theoretical Cost',  value: fmtNPR(totalTheorVal),    sub: 'Based on recipes × sales',      color: 'var(--theme-text3)' },
            { label: 'Actual Cost',        value: fmtNPR(totalActualVal),   sub: 'From stock movements',          color: 'var(--theme-text1)' },
            // The mark rides the figure, not the label: a tile is the one thing on this page read
            // from across a room, and it was the only severity on it carried by hue alone.
            { label: 'Total Variance',
              value: hasClosing ? `${fmtNPR(totalVarianceVal)}${totalBand.mark ? ` ${totalBand.mark}` : ''}` : 'Not measurable yet',
              sub:   !hasClosing ? 'Closing count not entered'
                     : totalBand.key === 'immaterial' ? 'Within rounding for the period'
                     : totalVarianceVal >= 0 ? 'Over-consumed' : 'Under-consumed',
              color: totalBand.color },
            { label: 'Items Over Tolerance',
              value: hasClosing ? overCount : '—',
              sub:   !hasClosing ? 'Needs closing count'
                     : [`${underCount} under tolerance`, noRecipeCount > 0 ? `${noRecipeCount} with no recipe` : null].filter(Boolean).join(' · '),
              color: !hasClosing ? 'var(--theme-text2)' : overCount > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' },
          // `.stat-card`/`.stat-label`/`.stat-value`/`.stat-sub` — the product's own tile. The
          // hand-rolled copy sat at fontSize 22 (off the 24px figure step) with letterSpacing
          // 0.06em against `.stat-label`'s 0.1em, and inherited none of the class's later fixes.
          // Only `color` genuinely varies here, so only `color` stays inline.
          ].map(card => (
            <div key={card.label} className="stat-card">
              <div className="stat-label">{card.label}</div>
              <div className="stat-value" style={{ color: card.color }}>{card.value}</div>
              <div className="stat-sub">{card.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters + export */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select aria-label="Filter by category"
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
            value={filterCat} onChange={e => setFilterCat(e.target.value)}
          >
            <option value="all">All Categories</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <div style={{ display: 'flex', background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            {[['all', 'All'], ['over', '🔴 Over-consumed'], ['under', '🟡 Under-consumed']].map(([val, lbl]) => (
              <button key={val} onClick={() => setFilterType(val)} style={{
                background: filterType === val ? 'color-mix(in srgb, var(--theme-accent) 12%, transparent)' : 'none',
                border: 'none', borderRight: '1px solid var(--theme-border)', cursor: 'pointer',
                padding: '7px 14px', fontSize: 12, fontWeight: 600,
                color: filterType === val ? 'var(--theme-accent-ink)' : 'var(--theme-text2)',
              }}>{lbl}</button>
            ))}
          </div>

          <select aria-label="Sort by"
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '7px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
            value={sortBy} onChange={e => setSortBy(e.target.value)}
          >
            <option value="variance_val">Sort: Variance Value ↓</option>
            <option value="variance_pct">Sort: Variance % ↓</option>
            <option value="name">Sort: Name A–Z</option>
          </select>
        </div>

        {/* Gated on the load as well as the rows (S728): while a period change computes, `rows` is
            the previous month's while the filename and scope line already name the new one. */}
        <button className="btn btn-ghost" onClick={exportExcel}
          disabled={loading || computing || !!loadError || !!biz.error || rows.length === 0}
          title={biz.error ? 'Your business details could not be loaded for the letterhead — reload the page to export' : undefined}>Export Excel</button>
      </div>

      {/* Table */}
      {loading || computing ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>
          {loading ? 'Loading…' : 'Computing variance…'}
        </div>
      ) : noSales ? (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
          <div style={{ color: 'var(--theme-text1)', fontWeight: 600, marginBottom: 8 }}>No stock or sales activity for this period</div>
          <div style={{ color: 'var(--theme-text2)', fontSize: 13 }}>
            No item had opening stock, purchases, use or sales this month.<br />
            Make sure sales are recorded, recipes have ingredients set up, and the Stock Count is entered.
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="What your recipes say should have been consumed based on qty sold × ingredient qty per portion." width={240}>Theoretical</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text={`${COGS_FORMULA}. The actual stock consumed this period.`} width={250}>Actual</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Actual − Theoretical. Positive = over-consumed (waste/theft/over-portioning). Negative = under-consumed (under-portioning or missing sales data)." width={280}>Variance</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Variance as a percentage of theoretical usage — normalizes the gap so items with different volumes are comparable. “—” when none of the dishes using the item sold this period: any use of it is then unexplained, and the mark after the dash still says whether that is over tolerance." width={280}>Variance %</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Variance Qty × cost per UOM. Shows the NPR impact of the gap." width={220}>Value (NPR)</Tip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ item, theoreticalUsed, actualUsed, variance, variancePct, value, hasCount, band: b }) => {
                  return (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {item.name}
                        {!hasCount && (
                          <Tip text="No closing count was entered for this item, so its actual usage is everything that was on hand — a figure, not a finding. It is left out of the totals above." width={300}>
                            <span className="badge badge-gray" style={{ marginLeft: 6, display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>not counted</span>
                          </Tip>
                        )}
                        {hasCount && b.flag === 'no_recipe' && (
                          <Tip text="This item is not an ingredient in any recipe (gas, foil, napkins…), so there is no theoretical usage to compare against. What was used is shown; it is left out of the over-tolerance count and the totals — as on the Variance Report." width={300}>
                            <span className="badge badge-gray" style={{ marginLeft: 6, display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>no recipe linked</span>
                          </Tip>
                        )}
                      </td>
                      <td><span className="badge badge-gray">{item.categories?.name}</span></td>
                      <td style={{ color: 'var(--theme-text2)' }}>{item.uom}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmtQty(theoreticalUsed)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtQty(actualUsed)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: b.color }}>
                        {variance === 0 ? '—' : `${variance > 0 ? '+' : ''}${variance.toLocaleString('en-IN', { maximumFractionDigits: 3 })}`}
                      </td>
                      {/* The mark rides the PERCENTAGE, which is the figure the eye lands on when
                          scanning this column — it used to sit only on the rupee value, so the
                          band a row was in was a hue and nothing else on the two columns before
                          it. `title` carries the band's own sentence for hover and assistive tech;
                          it is not a substitute for the glyph, which is what a sighted
                          colour-blind reader actually gets. */}
                      {/* A null percentage (nothing using it sold) prints "—", and keeps the mark: the
                          shared verdict judges that row too (D36), so its colour is not left to say
                          it alone. */}
                      <td style={{ textAlign: 'right', fontWeight: 600, color: b.color }} title={b.label !== '—' ? b.label : undefined}>
                        {`${variancePct == null ? '—' : fmtPct(variancePct)}${b.mark ? ` ${b.mark}` : ''}`}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: b.color }}>
                        {value === 0 ? '—' : fmtNPR(value)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {visible.length > 1 && (() => {
                // Judged rows only — measured (S756) and linked to a recipe (S792, D17) — the same
                // population the KPI cards above use. The footer summed every visible row, so an
                // uncounted item's "actual = everything on hand" went into a subtotal sitting
                // directly under cards that had excluded it — two totals of one table disagreeing by
                // exactly the shelf nobody counted.
                const vis    = judgedRows(visible)
                const vTheor = vis.reduce((s, r) => s + r.theoreticalUsed * r.rate, 0)
                const vAct   = vis.reduce((s, r) => s + r.actualUsed * r.rate, 0)
                const vVal   = vis.reduce((s, r) => s + r.value, 0)
                // Was `> 0 ? red : green` on the filtered subtotal — no threshold at all, so a NPR 3
                // total wore the same red as NPR 30,000. Banded against the same tolerance as every
                // row above it.
                const vb     = band(vTheor > 0 ? (vVal / vTheor) * 100 : null, vVal)
                const excluded = visible.length - vis.length
                return (
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text1)' }}>
                        {excluded > 0
                          ? <Tip text="The totals on this row cover counted items that appear in a recipe. An item with no closing count has an 'actual' that is everything on hand — a figure, not a finding — and an item in no recipe has nothing to compare against, so both are left out, exactly as in the cards above." width={300}>
                              Total — {vis.length} judged of {visible.length} shown
                            </Tip>
                          : `Total — ${visible.length} items shown`}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text3)' }}>
                        {fmtNPR(vTheor)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {fmtNPR(vAct)}
                      </td>
                      <td colSpan={2} />
                      <td style={{ textAlign: 'right', fontWeight: 700, color: vb.color }} title={vb.label !== '—' ? vb.label : undefined}>
                        {fmtNPR(vVal)}{vb.mark ? ` ${vb.mark}` : ''}
                      </td>
                    </tr>
                  </tfoot>
                )
              })()}
            </table>
          </div>
        </div>
      )}
      </>}
    </div>
  )
}
