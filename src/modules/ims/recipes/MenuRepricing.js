import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { getSuggestedPrice, computeRecipeCosts } from '../../../utils/recipeCost'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { useSettings } from '../../../context/SettingsContext'
import { fcFigure, menuFcPct, recipeCostOf, unratedReason } from '../../../shared/imsFormulas'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate } from 'react-router-dom'
import { BS_MONTHS } from '../../../utils/bsCalendar'

// vat_rate may be 0 (No VAT); null/undefined falls back to 13%.
function vatOf(r) {
  return (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
}

export default function MenuRepricing() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  // Banding goes through `fcFigure(pct, settings)` at the one cell that prints it — colour, the
  // ✓/△/▲ mark and the band name arrive together, so a call site cannot take the colour and drop
  // the mark (S608), and a null cannot reach `toFixed`. The three separate wrappers this page used
  // to keep were exactly the shape S713 took apart on Menu Pricing.

  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [rows, setRows]               = useState([])
  const [sortBy, setSortBy]           = useState('opportunity')
  const [catFilter, setCatFilter]     = useState('All')
  const [onlyUnderpriced, setOnlyUnderpriced] = useState(true)
  const [onlyWithSales, setOnlyWithSales]     = useState(false)
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
      // Repricing suggestions weigh recipes by sales volume/revenue at the current price —
      // comps (source='pos_comp') never generated revenue at that price, so they're excluded.
      // Filtered in JS over a SELECTED `source`, never `.neq('source', …)`: the column is nullable
      // and `NULL <> 'pos_comp'` is NULL, so the server-side form silently drops every legacy row
      // (S724). Qty here is the multiplier on Monthly Opportunity, this page's headline KPI.
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, source').eq('period_id', periodId).order('id')),
      // `.neq('category', …)` on a NULLABLE column also drops every NULL row, server-side and
      // silently — a recipe with no category disappeared from the repricing list with nothing to
      // say it had. Same trap, same fix, as Menu Pricing's own load. `is_active` is nullable the
      // same way, so `.eq('is_active', true)` dropped rows that are neither active nor inactive;
      // it is tested in JS below, in the one NULL-safe form the Dashboard tile also uses (S724).
      scopedFrom('recipes', 'id, name, category, selling_price, vat_rate, target_fc_pct, cost_price, is_active')
        .or('category.is.null,category.neq.Sub-Recipe'),
    ])
    // A failed read must not render the celebratory "no underpriced dishes 🎉" empty state (S612).
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setLoading(false); return }
    const [{ data: salesData }, { data: recipes }] = results

    // computeRecipeCosts recurses through sub-recipe ingredients and applies yield_pct — a
    // hand-rolled costMap reading only direct item_id ingredients (as this used to) silently
    // costs any sub-recipe-based ingredient at zero, understating cost and repricing suggestions.
    const recipeIds = (recipes || []).map(r => r.id)
    // computeRecipeCosts THROWS on a failed read (S695/S711) and this call site did not catch
    // it, so a dead `items` read rejected the loader's promise before `setLoading(false)` and
    // left the page on the loading state indefinitely — no error card, nothing to retry (S715).
    let costMap = {}
    try {
      costMap = await computeRecipeCosts(supabase, recipeIds)
    } catch (err) {
      if (!periodReq.isCurrent(periodId)) return
      setLoadError(err); setRows([]); setLoading(false); return
    }

    const qtyMap = {}
    for (const s of (salesData || [])) {
      if (s.source === 'pos_comp') continue   // see the read above — filtered here, not server-side
      qtyMap[s.recipe_id] = (qtyMap[s.recipe_id] || 0) + parseFloat(s.qty_sold || 0)
    }

    const built = (recipes || [])
      .filter(r => r.selling_price != null && parseFloat(r.selling_price) > 0 && r.is_active !== false)
      .map(r => {
        const price    = parseFloat(r.selling_price || 0)
        // Computed cost, else the manually-entered cost_price, else NULL — one shared decision
        // (S724). S713 added the cost_price fallback here and kept the `|| 0` beneath it, which
        // left the original defect standing for every dish that has NEITHER: cost 0 makes FC% 0,
        // 0 is never above target, so the dish is not "underpriced" and is therefore SILENTLY
        // ABSENT from the list, from the Monthly Opportunity total and from the Underpriced count
        // — and with "Only underpriced" on by default, a menu nobody has costed renders the
        // celebratory "No underpriced dishes 🎉" empty state this file already guards against for
        // load failures. Unknown is not the same as fine.
        const cost     = recipeCostOf(costMap, r)
        const qty      = parseFloat(qtyMap[r.id] || 0)
        const targetPct = parseFloat(r.target_fc_pct) || 30
        const currentFcPct = menuFcPct(cost, price)
        const vat = vatOf(r)
        // VAT-inclusive, rounded up to NPR 5 — the number to print on the menu.
        const suggestedMenuPrice = cost == null ? null : getSuggestedPrice(cost, vat, targetPct / 100)
        // The gap is measured against the price the page actually TELLS YOU TO CHARGE, de-VATed
        // back to the ex-VAT basis every other column on this page uses. It used to be measured
        // against the raw `cost / target` figure, which is neither rounded nor the number in the
        // Suggested Menu Price column beside it — so repricing to what the page said captured a
        // different amount from the Monthly Opportunity it promised (S724).
        const suggestedExVat = suggestedMenuPrice == null ? null : suggestedMenuPrice / (1 + vat)
        const priceGap = suggestedExVat == null ? null : Math.max(0, suggestedExVat - price)
        return {
          id: r.id,
          name: r.name,
          category: r.category,
          price, cost, qty, targetPct, currentFcPct,
          priceGap,
          // Only a positive gap on positive volume is an opportunity. A Credit Note can push a
          // period's net qty negative, which used to make this negative — hidden by the table's
          // `> 0 ? … : '—'` while still being summed into the KPI above it.
          monthlyOpportunity: priceGap == null ? null : Math.max(0, priceGap * qty),
          suggestedMenuPrice,
          notCosted: cost == null,
          costReason: cost == null ? unratedReason(0, price) : null,
          underpriced: currentFcPct != null && currentFcPct > targetPct,
        }
      })

    setRows(built)
    setCatFilter('All')
    setLoading(false)
  }

  const underpricedRows = rows.filter(r => r.underpriced)
  const totalOpportunity = underpricedRows.reduce((s, r) => s + (r.monthlyOpportunity || 0), 0)
  const notCostedRows = rows.filter(r => r.notCosted)
  const biggestLeak = [...underpricedRows].sort((a, b) =>
    (b.monthlyOpportunity - a.monthlyOpportunity) || (b.priceGap - a.priceGap))[0]
  // `.filter(Boolean)` because `recipes.category` is nullable and S714 made those rows visible —
  // without it an uncategorised dish added a blank, unlabelled tab to the bar (S724).
  const categories = ['All', ...Array.from(new Set(rows.map(r => r.category).filter(Boolean))).sort()]

  // A dish with no cost has no gap, no opportunity and no FC% to sort on — those rows go to the
  // end of every sort rather than wherever a NaN comparison happens to drop them.
  const byMetric = (fn) => (a, b) => {
    const av = fn(a), bv = fn(b)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return bv - av
  }

  let display = rows
  if (onlyUnderpriced) display = display.filter(r => r.underpriced)
  if (onlyWithSales)   display = display.filter(r => r.qty > 0)
  if (catFilter !== 'All') display = display.filter(r => r.category === catFilter)
  if (sortBy === 'opportunity')   display = [...display].sort(byMetric(r => r.monthlyOpportunity))
  else if (sortBy === 'gap')      display = [...display].sort(byMetric(r => r.priceGap))
  else if (sortBy === 'fc')       display = [...display].sort(byMetric(r => r.currentFcPct == null ? null : r.currentFcPct - r.targetPct))

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : ''

  function fmtNPR(n) {
    if (!n && n !== 0) return '—'
    return 'NPR ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb   = XLSX.utils.book_new()
    // An unknown figure exports BLANK, never 0 — this sheet is what a repricing decision gets made
    // from, and "Suggested Menu Price 0" is a number someone will act on (S724).
    const data = display.map((r, i) => ({
      '#':                          i + 1,
      'Recipe':                     r.name,
      'Category':                   r.category,
      'Qty Sold':                   r.qty || '',
      'Food Cost / Portion':        r.cost != null ? r.cost.toFixed(2) : '',
      'Current Price (ex-VAT)':     r.price.toFixed(2),
      'Current FC%':                r.currentFcPct != null ? r.currentFcPct.toFixed(1) + '%' : '',
      'Target FC%':                 r.targetPct.toFixed(0) + '%',
      'Suggested Menu Price (incl VAT)': r.suggestedMenuPrice != null ? r.suggestedMenuPrice.toFixed(0) : '',
      'Price Gap (ex-VAT)':         r.priceGap != null ? r.priceGap.toFixed(2) : '',
      'Monthly Opportunity (NPR)':  r.monthlyOpportunity ? r.monthlyOpportunity.toFixed(0) : '',
      'Status':                     r.notCosted ? 'Not costed' : r.underpriced ? 'Underpriced' : 'At or below target',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Menu Repricing')
    XLSX.writeFile(wb, `MenuRepricing-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div className="page-container">

      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Menu Repricing — {periodLabel}</h2>
      </div>

      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Menu Repricing</h1>
          <p className="page-subtitle">Dishes priced below their target food-cost % — and the price to charge to fix it</p>
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
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Menu Repricing - ${periodLabel}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!display.length}>Export Excel</button>
        </div>
      </div>

      {/* KPI strip waits for the load and never survives a failure: unloaded or failed,
          Underpriced Dishes / Monthly Opportunity read as confident green zeros (S594). */}
      {!loading && !loadError && (
      <div className="stat-grid no-print">
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Number of priced dishes whose current food-cost % is above their target — i.e. priced too low to hit the margin you set." width={300}>Underpriced Dishes</Tip>
          </div>
          <div className="stat-value" style={{ color: underpricedRows.length ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
            {underpricedRows.length}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Sum of (Price Gap × Qty Sold) across all underpriced dishes this period. Extra margin you'd capture by repricing to target — ingredient cost is unchanged, so it drops straight to the bottom line." width={320}>Monthly Opportunity</Tip>
          </div>
          <div className="stat-value" style={{ color: totalOpportunity ? 'var(--theme-accent-ink)' : 'var(--theme-green-text)' }}>{fmtNPR(totalOpportunity)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Biggest Leak</div>
          <div className="stat-value" style={{ fontSize: 14 }}>{biggestLeak ? biggestLeak.name : '—'}</div>
          {biggestLeak && <div className="stat-label" style={{ marginTop: 4 }}>{fmtNPR(biggestLeak.monthlyOpportunity || biggestLeak.priceGap)}{biggestLeak.monthlyOpportunity ? '/mo' : '/portion'}</div>}
        </div>
        {/* The fourth card exists only when it has something to say. A dish with no food cost
            cannot be tested against its target at all, so it is neither underpriced nor fine —
            and without this card that distinction is invisible on a page whose headline number is
            a count of problems and whose empty state congratulates you. */}
        {notCostedRows.length > 0 && (
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Dishes with a price but no food cost — no costed ingredients and no manual cost. They cannot be compared against a target FC%, so they are counted here instead of being silently left out of Underpriced Dishes." width={320}>Not Costed</Tip>
            </div>
            <div className="stat-value" style={{ color: 'var(--theme-amber-text)' }}>{notCostedRows.length}</div>
          </div>
        )}
      </div>
      )}

      {/* Sort + filter bar */}
      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Sort:</span>
        {[
          ['opportunity', 'Monthly Opportunity'],
          ['gap',         'Price Gap'],
          ['fc',          'Most over target'],
        ].map(([key, label]) => (
          <button key={key} className={`tab-btn${sortBy === key ? ' tab-btn--active' : ''}`} onClick={() => setSortBy(key)}>{label}</button>
        ))}
        <label style={{ marginLeft: 12, fontSize: 12, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyUnderpriced} onChange={e => setOnlyUnderpriced(e.target.checked)} />
          Only underpriced
        </label>
        <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyWithSales} onChange={e => setOnlyWithSales(e.target.checked)} />
          Only with sales
        </label>
      </div>

      {categories.length > 2 && (
        <div className="tab-bar no-print" style={{ marginBottom: 16 }}>
          {categories.map(c => (
            <button key={c} className={`tab-btn${catFilter === c ? ' tab-btn--active' : ''}`} onClick={() => setCatFilter(c)}>{c}</button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="loading-state">Loading...</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : display.length === 0 ? (
        <div className="empty-state">
          {/* The 🎉 is a claim about every priced dish, so it may only be made when every priced
              dish was actually testable. With dishes that have no cost, the honest answer is that
              none of the ones we COULD check are underpriced — and here is what we could not. */}
          {!onlyUnderpriced
            ? 'No priced recipes found for this period.'
            : notCostedRows.length === 0
              ? 'No underpriced dishes — every priced dish is at or below its target food cost. 🎉'
              : `None of the costed dishes are underpriced — but ${notCostedRows.length} ${notCostedRows.length === 1 ? 'dish has' : 'dishes have'} no food cost recorded and could not be checked at all. Add ingredients in Recipe Costing, or a cost in Menu Pricing, then look again.`}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Recipe</th>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Qty Sold</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total ingredient cost per portion based on current item rates." width={240}>Food Cost / Portion</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Current selling price excluding VAT (as entered in Recipe Costing)." width={240}>Current Price</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Food Cost ÷ Current Price. How much of each sale goes to ingredients right now." width={260}>Current FC%</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="The food-cost % you set as the goal for this dish (Recipe Costing → Target FC%)." width={260}>Target FC%</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Price to charge to hit the target FC%, VAT-inclusive and rounded up to NPR 5 — the number to print on the menu. Shows — when the dish has no food cost to work back from." width={320}>Suggested Menu Price</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="How much you're under per portion: the Suggested Menu Price beside it, taken back to ex-VAT, less the current ex-VAT price. Measured against the rounded price actually suggested, so repricing to it captures exactly the Monthly Opportunity shown." width={340}>Price Gap</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Price Gap × Qty Sold this period. Extra margin captured by repricing to target." width={280}>Monthly Opportunity</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => {
                const fcFig = fcFigure(r.currentFcPct, settings)
                return (
                <tr key={r.id} style={{ opacity: r.underpriced ? 1 : 0.5 }}>
                  <td style={{ color: 'var(--theme-text2)' }}>{i + 1}</td>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category}</td>
                  <td style={{ textAlign: 'right' }}>{r.qty ? Number(r.qty).toLocaleString('en-IN') : '—'}</td>
                  <td style={{ textAlign: 'right', color: r.cost == null ? 'var(--theme-text3)' : undefined }} title={r.costReason || undefined}>
                    {r.cost != null ? `NPR ${r.cost.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>NPR {r.price.toFixed(0)}</td>
                  <td style={{ textAlign: 'right', fontWeight: r.currentFcPct != null ? 700 : 400, ...fcFig.style }} title={fcFig.title || r.costReason}>{fcFig.text}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.targetPct.toFixed(0)}%</td>
                  {/* A suggested price is derived from a cost. With no cost this used to print
                      "NPR 0" in green under a column captioned "the number to print on the menu". */}
                  <td style={{ textAlign: 'right', fontWeight: r.suggestedMenuPrice != null ? 600 : 400, color: r.suggestedMenuPrice != null ? 'var(--theme-green-text)' : 'var(--theme-text3)' }}
                      title={r.suggestedMenuPrice == null ? r.costReason : undefined}>
                    {r.suggestedMenuPrice != null ? `NPR ${r.suggestedMenuPrice.toFixed(0)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: r.priceGap > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>
                    {r.priceGap > 0 ? `NPR ${r.priceGap.toFixed(2)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: r.monthlyOpportunity > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)' }}>
                    {r.monthlyOpportunity > 0 ? fmtNPR(r.monthlyOpportunity) : '—'}
                  </td>
                </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={10}>
                  Total ({display.filter(r => r.underpriced).length} underpriced
                  {display.filter(r => r.notCosted).length > 0 ? `, ${display.filter(r => r.notCosted).length} not costed` : ''})
                </td>
                <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                  {fmtNPR(display.reduce((s, r) => s + (r.monthlyOpportunity || 0), 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
