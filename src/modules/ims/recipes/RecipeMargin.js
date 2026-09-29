import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { useSettings } from '../../../context/SettingsContext'
import { fcBand, fcFigure, menuFcPct, recipeCostOf, unratedReason } from '../../../shared/imsFormulas'
import { printWithTitle } from '../../../utils/printTitle'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { Navigate } from 'react-router-dom'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { FilterChips } from '../../../components/Tabs'
import { extrasCostByRecipe, loadExtrasCosting } from './extrasCost'
import { BYO_REASON, BYO_TIP, isCostedByBuild } from './buildYourOwnRating'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'

export default function RecipeMargin() {
  const { clientId, profile, hasImsAccess, customizationEnabled } = useAuth()
  const { settings } = useSettings()
  // Was a hardcoded 30/38 scale in every one of these files, which disagreed with the client's
  // own configured fc_warning_pct/fc_critical_pct that Recipe Costing's filter pills use.
  const fcColor = pct => fcBand(pct, settings).color
  // The band must not be carried by colour alone (S608) — see fcBand's note.
  const fcLabel = pct => fcBand(pct, settings).label
  const fcMark  = pct => fcBand(pct, settings).mark

  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [rows, setRows]               = useState([])
  const [sortBy, setSortBy]           = useState('contribution')
  const [catFilter, setCatFilter]     = useState('All')
  const [onlyWithSales, setOnlyWithSales] = useState(true)
  const [loading, setLoading]         = useState(false)
  const [loadError, setLoadError]     = useState(null)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data, error }) => {
        // A failed read must not impersonate "no periods yet" (S612 silent-zero rule).
        if (error) { setLoadError(error.message); return }
        setPeriods(data || [])
        if (data?.length) setSelected(data[0])
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line

  async function fetchData(periodId) {
    periodReq.begin(periodId)   // claim the page before any await (S601)
    setLoading(true)
    setLoadError(null)
    const results = await Promise.all([
      // Margin is revenue-based — comps (source='pos_comp') never sold at menu price and would
      // understate the true margin percentage if counted as if they had. Filtered in JS over a
      // SELECTED `source`, never `.neq('source', …)`: the column is nullable, `NULL <> 'pos_comp'`
      // is NULL rather than true, and the server-side form silently drops every legacy row (S724).
      // Total Contribution is this page's headline, its default sort and its Top Contributor KPI,
      // so a short qty map does not shorten one column — it re-orders the whole report.
      //
      // `unit_price` is the price actually charged on that sale. Without it this page joined the
      // recipe's CURRENT selling_price to every historical row, which is precisely what migration
      // 20260713065928 exists to stop: a closed period's contribution silently restated itself
      // whenever anyone edited a menu price. It also made every POS bill discount invisible, since
      // those are folded into unit_price and never written to `discount`.
      //
      // `ingredient_deltas` (S792 RECIPES-3): a customized sale's unit_price includes its choices'
      // upcharges, so its choices' STOCK has to be in the cost too — see extrasCost.js.
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount, source, ingredient_deltas').eq('period_id', periodId).order('id')),
      // NULL-safe (S714): a nullable column's NULL rows are dropped by .neq as well. `is_active`
      // is nullable too (DEFAULT true, no NOT NULL), so `.eq('is_active', true)` dropped rows that
      // are neither active nor inactive — and made this page's population differ from Best
      // Sellers', which filters none, and the Dashboard's, which tests `=== false` in JS (S724).
      // Tested in JS below for exactly that reason: one NULL-safe form, not a second dialect of it.
      // `cost_price` is the manual cost Menu Pricing's + Add Item writes — this page had no
      // fallback to it, so a hand-costed dish read as costed there and free to make here.
      // `is_build_your_own` (S792 RECIPES-1): such a dish is not rated here — buildYourOwnRating.js.
      scopedFrom('recipes', 'id, name, category, selling_price, cost_price, is_active, is_build_your_own')
        .or('category.is.null,category.neq.Sub-Recipe'),
    ])
    // A failed read must not zero every margin and contribution figure (S612 silent-zero rule).
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setLoading(false); return }
    const [{ data: salesData }, { data: recipes }] = results

    // computeRecipeCosts recurses through sub-recipe ingredients and applies yield_pct — a
    // hand-rolled costMap reading only direct item_id ingredients (as this used to) silently
    // costs any sub-recipe-based ingredient (sauces, batters, prepped components) at zero and
    // ignores trim/prep loss, understating food cost and margin for exactly those dishes.
    const recipeIds = (recipes || []).map(r => r.id)
    // The rows this page counts: every sale except comps, credit notes included (their negative qty
    // reverses the sale). The extras' cost is taken over exactly these, so it covers the same plates
    // as the revenue and the recipe cost beside it.
    const counted = (salesData || []).filter(s => s.source !== 'pos_comp')   // see the read above — filtered here, not server-side

    // computeRecipeCosts THROWS on a failed read (S695/S711) and this call site did not catch
    // it, so a dead `items` read rejected the loader's promise before `setLoading(false)` and
    // left the page on the loading state indefinitely — no error card, nothing to retry (S715).
    // The extras' stock (S792 RECIPES-3) is read beside the recipe walk and under the same catch:
    // `loadExtrasCosting` throws on a failed read too, and a failed rate read must stop the page
    // rather than cost every extra at 0 — the flattering margin the fix exists to remove.
    let costMap = {}, extrasCosting = null
    try {
      const [costs, extras] = await Promise.all([
        computeRecipeCosts(supabase, recipeIds),
        loadExtrasCosting(supabase, scopedFrom, counted),
      ])
      costMap = costs
      extrasCosting = extras
    } catch (err) {
      if (!periodReq.isCurrent(periodId)) return
      setLoadError(err); setRows([]); setLoading(false); return
    }
    if (!periodReq.isCurrent(periodId)) return
    const extrasMap = extrasCostByRecipe(counted, extrasCosting)

    // Revenue is built exactly the way `Sales.js`'s `recipeRevenue()` builds it, which is the
    // house basis: each sale at its own captured price, rows predating that column falling back to
    // the recipe's current price, less discounts. Not `qty × today's price`.
    const qtyMap = {}, pricedRev = {}, unpricedQty = {}, discMap = {}
    for (const s of counted) {
      const qty = parseFloat(s.qty_sold || 0)
      qtyMap[s.recipe_id] = (qtyMap[s.recipe_id] || 0) + qty
      if (s.unit_price != null) pricedRev[s.recipe_id] = (pricedRev[s.recipe_id] || 0) + qty * parseFloat(s.unit_price)
      else unpricedQty[s.recipe_id] = (unpricedQty[s.recipe_id] || 0) + qty
      discMap[s.recipe_id] = (discMap[s.recipe_id] || 0) + (parseFloat(s.discount) || 0)
    }

    const built = (recipes || [])
      .filter(r => r.selling_price != null && r.is_active !== false)
      .map(r => {
        const price  = parseFloat(r.selling_price || 0)
        // S792 RECIPES-1: a build-your-own dish's recipe is its bowl and spoon, so rating it here
        // made a NPR 8 cost against NPR 300 the Top Contributor. It is listed with its sales and
        // not rated — no cost, margin, FC% or contribution, and out of every total — exactly as an
        // uncosted dish is, but with its own reason and its own count.
        const byo    = isCostedByBuild(r, customizationEnabled)
        // null, never 0, when nothing has costed this dish (S713's rule, reached on this page in
        // S724). `parseFloat(costMap[r.id] || 0)` made FC% a flat 0.0% that `fcBand` paints green
        // with a ✓ — "Healthy", on a dish whose food cost is simply unknown — and made Contribution
        // per Portion the entire selling price, which is enough to win the Top Contributor KPI.
        const cost   = byo ? null : recipeCostOf(costMap, r)
        const margin = cost == null ? null : price - cost
        const qty    = parseFloat(qtyMap[r.id] || 0)
        const discount = parseFloat(discMap[r.id] || 0)
        const revenue = (pricedRev[r.id] || 0) + (unpricedQty[r.id] || 0) * price - discount
        // The stock of the extras guests added (S792 RECIPES-3): their upcharges are already in
        // `revenue` through unit_price, so their cost belongs in COGS. `cost` and `margin` stay the
        // dish AS LISTED — a per-portion figure at today's price, with nothing added.
        const extrasCost = extrasMap[r.id] || 0
        const cogs   = cost == null ? null : cost * qty + extrasCost
        const fcPct  = menuFcPct(cost, price)
        return {
          id: r.id,
          name: r.name,
          category: r.category,
          price, cost, margin, qty, discount, revenue, cogs, extrasCost, byo,
          // What the dish actually contributed: revenue at the prices charged, less ingredient
          // cost. It will not always equal margin × qty — that is the point, since a price change,
          // a bill discount or an extra a guest added is exactly the difference between the two.
          totalContribution: cost == null ? null : revenue - cogs,
          fcPct,
          costReason: byo ? BYO_REASON : cost == null ? unratedReason(0, price) : null,
        }
      })

    setRows(built)
    setCatFilter('All')
    setLoading(false)
  }

  // Every total on this page follows the category filter. The footer row used to be computed from
  // `withSales` — the WHOLE period — and rendered directly under a table showing one category, so
  // "Total (N recipes sold)" described a different set of rows from the ones above it (S724). The
  // KPI strip is the page-level figure and stays unfiltered, which is why it now says so.
  const inCat           = catFilter === 'All' ? rows : rows.filter(r => r.category === catFilter)
  const withSales       = rows.filter(r => r.qty > 0)
  const catWithSales    = inCat.filter(r => r.qty > 0)
  // Contribution, cost and FC% can only be summed over dishes that have a cost. A build-your-own
  // dish has none here either (S792 RECIPES-1) and is counted on its own, because the next step for
  // it is not the uncosted dish's "add a recipe or a manual cost".
  const totals = (list) => {
    const costed = list.filter(r => r.totalContribution != null)
    const revenue = costed.reduce((s, r) => s + r.revenue, 0)
    const cost    = costed.reduce((s, r) => s + r.cogs, 0)
    const byoCount = list.filter(r => r.byo).length
    return {
      contrib: costed.reduce((s, r) => s + r.totalContribution, 0),
      revenue, cost,
      extras: costed.reduce((s, r) => s + r.extrasCost, 0),
      fcPct: revenue > 0 ? (cost / revenue) * 100 : null,
      costedCount: costed.length,
      byoCount,
      uncostedCount: list.length - costed.length - byoCount,
    }
  }
  const pageTotals      = totals(withSales)
  const catTotals       = totals(catWithSales)
  const totalContrib    = pageTotals.contrib
  const avgFcPct        = pageTotals.fcPct
  const topRecipe       = [...withSales]
    .filter(r => r.totalContribution != null)
    .sort((a, b) => b.totalContribution - a.totalContribution)[0]
  // `.filter(Boolean)` because `recipes.category` is nullable and S714 made those rows visible —
  // without it an uncategorised dish added a blank, unlabelled tab to the bar (S724).
  const categories      = ['All', ...Array.from(new Set(rows.map(r => r.category).filter(Boolean))).sort()]
  // The extras column appears only when a costed dish sold with choices this period (S792
  // RECIPES-3) — a client without Crest Customization never has one, and an always-on column of
  // dashes would claim a cost it does not have.
  const showExtras      = rows.some(r => r.cost != null && r.extrasCost !== 0)

  // A dish with no cost has no contribution, margin or FC% to sort on. Sorting it as `null`
  // produces NaN comparisons and an arbitrary order, so those rows go to the end of every sort
  // rather than landing wherever the comparator happens to drop them.
  const byMetric = (key, dir = 'desc') => (a, b) => {
    const av = a[key], bv = b[key]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return dir === 'asc' ? av - bv : bv - av
  }

  let display = onlyWithSales ? rows.filter(r => r.qty > 0) : rows
  if (catFilter !== 'All') display = display.filter(r => r.category === catFilter)
  if (sortBy === 'contribution') display = [...display].sort(byMetric('totalContribution'))
  else if (sortBy === 'margin')  display = [...display].sort(byMetric('margin'))
  else if (sortBy === 'fc')      display = [...display].sort(byMetric('fcPct', 'asc'))

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : ''

  function fmtNPR(n) {
    if (!n && n !== 0) return '—'
    return 'NPR ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })
  }

  // Gated on the load, a failed read and the letterhead's outlet name, not just on having rows
  // (S792, IMS_TODO S792.4; the S728 rule for a control that emits a FILE). On `display.length`
  // alone it stayed live while a period change was loading, so the previous month's rows could
  // leave in a file named for the new one; and a failed read was refused only because it happens
  // to clear the rows, which is not a gate anyone can see.
  const exportBlocked = loading || !!loadError || !!biz.error || !display.length
  async function exportExcel() {
    if (exportBlocked) return
    const XLSX = await import('xlsx')
    const wb   = XLSX.utils.book_new()
    // An unknown figure exports BLANK, never 0.0% — this sheet leaves the building and gets priced
    // against, and a zero in it is a number someone will trust (S713's rule for Menu Pricing's
    // export, applied here in S724).
    // S792: the extras' stock cost rides along when the page shows it, and a blank row says why it
    // is blank — "not rated, costed by build" and "no food cost" are different next steps.
    const data = display.map((r, i) => ({
      '#':                       i + 1,
      'Recipe':                  r.name,
      'Category':                r.category,
      'Selling Price (ex-VAT)':  r.price.toFixed(2),
      'Food Cost / Portion':     r.cost != null ? r.cost.toFixed(2) : '',
      'Contribution / Portion':  r.margin != null ? r.margin.toFixed(2) : '',
      'Qty Sold':                r.qty || '',
      'Revenue (NPR)':           r.revenue ? r.revenue.toFixed(0) : '',
      ...(showExtras ? { 'Extras Stock Cost (NPR)': r.cost != null && r.extrasCost ? r.extrasCost.toFixed(0) : '' } : {}),
      'Total Contribution (NPR)':r.totalContribution != null ? r.totalContribution.toFixed(0) : '',
      'FC%':                     r.fcPct != null ? r.fcPct.toFixed(1) + '%' : '',
      'Note':                    r.costReason || '',
    }))
    // The scope line states what the rows are: the period (and whether it is still open), the tab
    // and the "with sales" filter — the filter bar is not in the file, so the sheet must say it.
    const scopeLine = [
      `Period : ${periodLabel}${selectedPeriod?.status === 'open' ? ' (open — figures still moving)' : ''}`,
      catFilter === 'All' ? 'all categories' : `category: ${catFilter}`,
      onlyWithSales ? 'recipes with sales only' : 'all recipes, sold or not',
      'revenue at the prices actually charged; food cost at today\'s item rates',
    ].join(' · ')
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, { title: 'Recipe Contribution Margin', biz, scopeLine, rows: data }), 'Recipe Margin')
    XLSX.writeFile(wb, `RecipeMargin-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div className="page-container">

      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Recipe Contribution Margin — {periodLabel}</h2>
      </div>

      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Recipe Contribution Margin</h1>
          <p className="page-subtitle">Revenue at the prices actually charged, less ingredient cost — total NPR profit contribution per recipe</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Recipe Contribution Margin - ${periodLabel}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={exportBlocked}>Export Excel</button>
        </div>
      </div>

      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a sheet
          with a blank company name. The report below is unaffected. Reload the page to try again.
        </p>
      )}

      {/* KPI strip waits for the load and never survives a failure: unloaded or failed,
          Total Contribution reads as a confident green NPR 0 (S594). */}
      {!loading && !loadError && (
      <div className="stat-grid no-print">
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Revenue less ingredient cost, across every costed recipe with sales this period — the whole period, not the category tab selected below. Revenue is valued at the prices actually charged, extras guests paid for included, and the cost includes the stock those extras used, so it will not always equal Contribution per Portion × Qty." width={320}>Total Contribution</Tip>
          </div>
          <div className="stat-value" style={{ color: 'var(--theme-green-text)' }}>{fmtNPR(totalContrib)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Weighted average FC% = Total Food Cost ÷ Total Revenue across the costed recipes sold this period. Food cost includes the stock of any extras guests added, as revenue includes what they paid for them." width={280}>Weighted Avg FC%</Tip>
          </div>
          <div className="stat-value" style={{ color: fcColor(avgFcPct) }} title={fcLabel(avgFcPct)}>
            {avgFcPct != null ? `${avgFcPct.toFixed(1)}% ${fcMark(avgFcPct)}` : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top Contributor</div>
          <div className="stat-value" style={{ fontSize: 14 }}>{topRecipe ? topRecipe.name : '—'}</div>
          {topRecipe && <div className="stat-label" style={{ marginTop: 4 }}>{fmtNPR(topRecipe.totalContribution)}</div>}
        </div>
      </div>
      )}

      {/* The absence has to be countable, or a dish with no cost is simply missing from three
          figures with nothing on the page saying how many. */}
      {!loading && !loadError && pageTotals.uncostedCount > 0 && (
        <p className="no-print" style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
          {pageTotals.uncostedCount} of {withSales.length} recipes sold this period
          {pageTotals.uncostedCount === 1 ? ' has' : ' have'} no food cost — neither costed ingredients nor a manual cost — so
          {pageTotals.uncostedCount === 1 ? ' it is' : ' they are'} listed with a — and left out of the totals above.
          Add ingredients in Recipe Costing, or a cost in Menu Pricing.
        </p>
      )}
      {/* S792 RECIPES-1: counted apart from the uncosted dishes, because the next step differs —
          nothing is missing from a build-your-own recipe; its plate is the guest's picks. */}
      {!loading && !loadError && pageTotals.byoCount > 0 && (
        <p className="no-print" style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 12px' }}>
          {pageTotals.byoCount} of {withSales.length} recipes sold this period
          {pageTotals.byoCount === 1 ? ' is' : ' are'} build-your-own, so {pageTotals.byoCount === 1 ? 'it is' : 'they are'}{' '}
          <Tip text={BYO_TIP} width={320}>not rated — costed by build</Tip> and left out of the totals above.
          Recipe Costing shows what each costs as a range.
        </p>
      )}

      {/* Sort + filter bar */}
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Sort:</span>
        <FilterChips
          label="Sort by"
          options={[
            { key: 'contribution', label: 'Total Contribution' },
            { key: 'margin', label: 'Margin / Portion' },
            { key: 'fc', label: 'FC% (best first)' },
          ]}
          active={sortBy}
          onChange={setSortBy}
        />
        <label style={{ marginLeft: 12, fontSize: 12, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyWithSales} onChange={e => setOnlyWithSales(e.target.checked)} />
          Only recipes with sales
        </label>
      </div>

      {categories.length > 2 && (
        <FilterChips
          label="Filter by category"
          className="no-print"
          style={{ marginBottom: 16 }}
          options={categories.map(c => ({ key: c, label: c }))}
          active={catFilter}
          onChange={setCatFilter}
        />
      )}

      {loading ? (
        <div className="loading-state">Loading...</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : display.length === 0 ? (
        <div className="empty-state">
          No recipes found.{onlyWithSales ? ' Try unchecking "Only recipes with sales".' : ''}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Recipe</th>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Selling price excluding VAT (as entered in Recipe Costing)." width={220}>Selling Price</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total ingredient cost per portion of the dish as listed, based on current item rates, or the manual cost entered in Menu Pricing. Shows — when the dish has neither. Extras a guest adds are not in this figure; their stock is costed in Total Contribution." width={280}>Food Cost / Portion</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Selling Price − Food Cost per portion, at today's price. What each sale earns if you sell one more right now." width={280}>Contribution / Portion</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Qty Sold</th>
                {showExtras && (
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="What the stock on guests' choices cost this period, at today's item rates: extra cheese, a Large size's bigger portion, less a 'no onion'. Counted in Total Contribution, because what guests paid for those choices is counted in its revenue. A credit note takes its plate's extras back off." width={320}>Extras' Stock</Tip>
                  </th>
                )}
                <th style={{ textAlign: 'right' }}>
                  <Tip text="What this recipe actually contributed this period: revenue at the prices charged on each sale (what guests paid for extras included), less discounts, less ingredient cost — the recipe's and the stock of any extras added. It will not always equal Contribution per Portion × Qty — a price change, a bill discount or an extra during the period is exactly that difference." width={340}>Total Contribution</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Food Cost ÷ Selling Price. Banded against your own thresholds in Settings → Thresholds. Shows — when the dish has no food cost, rather than 0%." width={300}>FC%</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => {
                // One rendered form for the banded figure — colour, ✓/△/▲ and band name together —
                // so a null cannot be handed to `toFixed` and a band cannot arrive colour-only.
                const fcFig = fcFigure(r.fcPct, settings)
                // S765: this row carried `opacity: 0.45` when a dish had sold nothing. Opacity
                // multiplies through the text colour (~2.8:1 on Night), and on a MARGIN report a
                // dish with no sales is among the rows most worth reading — so it dimmed exactly
                // the wrong ones. The Sold column already prints a dash; DESIGN.md: label the
                // state, never dim the row.
                return (
                <tr key={r.id}>
                  <td style={{ color: 'var(--theme-text2)' }}>{i + 1}</td>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category}</td>
                  <td style={{ textAlign: 'right' }}>NPR {r.price.toFixed(0)}</td>
                  <td style={{ textAlign: 'right' }} title={r.cost == null && !r.byo ? r.costReason : undefined}>
                    {r.cost != null
                      ? `NPR ${r.cost.toFixed(2)}`
                      : r.byo
                        // S792 RECIPES-1: the row state, named, where a figure would be.
                        ? <Tip text={BYO_TIP} width={320}><span style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>By build</span></Tip>
                        : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: r.margin != null ? 600 : 400, color: r.margin == null ? 'var(--theme-text3)' : r.margin >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}
                      title={r.margin == null ? r.costReason : undefined}>
                    {r.margin != null ? `NPR ${r.margin.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.qty ? Number(r.qty).toLocaleString('en-IN') : '—'}</td>
                  {showExtras && (
                    <td style={{ textAlign: 'right', color: r.cost != null && r.extrasCost ? 'var(--theme-text1)' : 'var(--theme-text3)' }}
                        title={r.cost == null ? r.costReason : undefined}>
                      {r.cost != null && r.extrasCost ? fmtNPR(r.extrasCost) : '—'}
                    </td>
                  )}
                  <td style={{ textAlign: 'right', fontWeight: 600, color: r.totalContribution != null ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}
                      title={r.totalContribution == null ? r.costReason : undefined}>
                    {r.totalContribution != null ? fmtNPR(r.totalContribution) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: r.fcPct != null ? 700 : 400, ...fcFig.style }} title={fcFig.title || r.costReason}>
                    {fcFig.text}
                  </td>
                </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={6}>
                  Total ({catTotals.costedCount} costed {catTotals.costedCount === 1 ? 'recipe' : 'recipes'} sold
                  {catFilter !== 'All' ? ` in ${catFilter}` : ''}
                  {catTotals.uncostedCount > 0 ? `, ${catTotals.uncostedCount} uncosted excluded` : ''}
                  {catTotals.byoCount > 0 ? `, ${catTotals.byoCount} build-your-own excluded` : ''})
                </td>
                <td style={{ textAlign: 'right' }}>{catWithSales.reduce((s, r) => s + r.qty, 0).toLocaleString('en-IN')}</td>
                {showExtras && <td style={{ textAlign: 'right' }}>{fmtNPR(catTotals.extras)}</td>}
                <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmtNPR(catTotals.contrib)}</td>
                <td style={{ textAlign: 'right', ...fcFigure(catTotals.fcPct, settings).style }} title={fcFigure(catTotals.fcPct, settings).title}>
                  {fcFigure(catTotals.fcPct, settings).text}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
