// Supplier Contribution — which suppliers this period's sales actually depend on.
//
// The competitor ERP this was scoped from has a "Sales Report – Supplier Wise", which makes sense
// for a trading business that resells what it buys. Crest is not that: `items` carries no vendor
// column, so no sale can name a supplier directly. What CAN be answered — and is the more useful
// question for a restaurant anyway — is where the cost of what you sold came from. That is this
// page. The arithmetic lives in supplierAttribution.js; this file loads the period and renders it.
//
// Three things worth knowing before changing anything here:
//
// • The consumption figure is RECIPE-THEORETICAL (what the sold dishes should have used), not the
//   actual COGS from the physical count. Variance draws exactly this distinction, and the page
//   says so on screen rather than leaving it to be discovered.
// • Wastage and staff meals are deliberately excluded — this is the cost of what was SOLD.
// • Every period-scoped read is fetchAllRows-paged. On a busy period a bare .select() truncates at
//   1000 rows with no error, and a truncated purchase set silently reassigns supplier shares.
import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { supabase } from '../../../supabaseClient'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import Tip from '../../../components/Tip'
import ReportPage from '../../../components/ReportPage'
import { printWithTitle } from '../../../utils/printTitle'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { selectDepletingSales } from '../sales/salesDepletion'
import {
  vendorNetByItem, vendorNetTotals, attributeConsumption, NO_VENDOR, UNATTRIBUTED,
} from './supplierAttribution'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const npr = n => `NPR ${(n || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0)

// How many detail lines an expanded supplier shows before offering the rest. The cap exists so an
// expanded row does not push the whole table off screen; it used to be a dead end ("+ 14 more"
// with no way to see them, and the export shipped a COUNT rather than the rows), which is why
// there is now both a Show-all control and an Ingredient Detail sheet in the workbook.
const DETAIL_PREVIEW = 12

export default function SupplierContribution() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [totals, setTotals] = useState({ attributed: 0, consumed: 0, unattributed: 0 })
  const [names, setNames] = useState({ items: {}, recipes: {} })
  const [expanded, setExpanded] = useState(null)
  const [showAllDetail, setShowAllDetail] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  // The DENOMINATOR the per-row "% of Purchases" column is taken against — positive net spend
  // only, since a negative share is meaningless. Kept alongside `rows` because it is part of the
  // same computed result, not a render-time derivation.
  //
  // WHY it exists at all (S594): the footer used to print a hardcoded "100.0%" over this column
  // while showing `purchaseGrandTotal` (which sums NEGATIVE vendor totals too) as its Net
  // Purchases figure. A vendor whose returns exceeded that period's purchases — routine — made
  // the column sum to more than 100 while the footer asserted it summed to exactly 100. A
  // hardcoded total that can be false is worse than no total: it forecloses the check an
  // accountant came to the page to make.
  const [purchaseShareBase, setPurchaseShareBase] = useState(0)

  // authLoading in the deps for the same reason ConsolidatedPnl has it: a hard load lands here
  // while auth is still resolving, the guard fails once, and nothing re-fires (S594).
  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const { data: p, error } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    if (error) { setLoadError(error.message); setPeriods([]); setLoading(false); return }
    setPeriods(p || [])
    // No closed-period default here, unlike Variance/Shrinkage: nothing on this page subtracts a
    // closing count, so an open period gives a truthful partial-month answer rather than a
    // structurally impossible one.
    const target = (p || []).find(x => x.status === 'open') || (p || [])[0]
    if (target) { setSelectedPeriod(target); await loadReport(target.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setExpanded(null)
    setShowAllDetail(false)
    setLoading(true)
    await loadReport(periodId)
    setLoading(false)
  }

  function toggleRow(id) {
    setExpanded(prev => (prev === id ? null : id))
    setShowAllDetail(false)
  }

  async function loadReport(periodId) {
    setLoadError(null)
    const results = await Promise.all([
      // sales_entries and purchase_entries are period-scoped, not client-scoped, so they stay on
      // raw supabase.from() — scopedDb deliberately rejects them.
      fetchAllRows(() => supabase.from('sales_entries')
        .select('recipe_id, qty_sold, bs_day, source').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('item_id, vendor_id, qty, rate, bs_day, invoice_ref, discount_amount, purchase_group_id')
        .eq('period_id', periodId).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'item_id, vendor_id, qty, rate')
        .eq('period_id', periodId).order('id')),
      // is_active only: valuing stock off an inactive item is the S436 rule, and per_uom_rate is
      // what every other IMS valuation uses (it is rate ÷ purchase_qty, generated in the DB).
      scopedFrom('items', 'id, name, uom, per_uom_rate').eq('is_active', true),
      scopedFrom('vendors', 'id, name, vendor_code'),
      scopedFrom('recipes', 'id, name'),
    ])

    // Every result below flows through `|| []`, so a failed read would produce a complete report
    // of NPR 0 — indistinguishable from a genuinely quiet period, on the page an accountant
    // reconciles against Vendor Report. See shared/queryError.js.
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setTotals({ attributed: 0, consumed: 0, unattributed: 0 }); return }

    const [
      { data: sales }, { data: purchases }, { data: returns },
      { data: items }, { data: vendors }, { data: recipes },
    ] = results

    const itemById = Object.fromEntries((items || []).map(i => [i.id, i]))
    setNames({
      items: Object.fromEntries((items || []).map(i => [i.id, i.name])),
      recipes: Object.fromEntries((recipes || []).map(r => [r.id, r.name])),
    })

    // Which sales rows actually depleted stock. Without this a client running POS *and* manual
    // bulk entry double-counts the same dish — the rule is documented once, in salesDepletion.js,
    // precisely so the read paths cannot each invent their own version of it.
    const depleting = selectDepletingSales(sales || [])
    const soldByRecipe = {}
    for (const s of depleting) {
      soldByRecipe[s.recipe_id] = (soldByRecipe[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0)
    }

    const recipeIds = Object.keys(soldByRecipe)
    const breakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}

    // breakdown[recipeId] is per-one-portion, yield_pct-adjusted and already recursed through any
    // sub-recipe nesting, so a prep item never appears here — only the raw items at the bottom of
    // the tree, which are the only things a vendor ever supplied.
    const consumedByItem = {}
    for (const [recipeId, ingredients] of Object.entries(breakdown)) {
      const sold = soldByRecipe[recipeId] || 0
      if (sold <= 0) continue
      for (const { item_id, qty } of ingredients) {
        const item = itemById[item_id]
        if (!item) continue // inactive or deleted — excluded from valuation by the same S436 rule
        const usedQty = sold * qty
        const value = usedQty * (parseFloat(item.per_uom_rate) || 0)
        const c = consumedByItem[item_id] = consumedByItem[item_id] || { qty: 0, value: 0, byRecipe: {} }
        c.qty += usedQty
        c.value += value
        c.byRecipe[recipeId] = (c.byRecipe[recipeId] || 0) + value
      }
    }

    const netByItem = vendorNetByItem(purchases || [], returns || [])
    const netTotals = vendorNetTotals(netByItem)
    const { total, byVendor } = attributeConsumption(consumedByItem, netByItem)

    const vendorById = Object.fromEntries((vendors || []).map(v => [v.id, v]))
    const label = vid => vid === UNATTRIBUTED ? 'Not attributed'
      : vid === NO_VENDOR ? 'No vendor recorded'
      : vendorById[vid]?.name || 'Unknown vendor'

    // Every vendor that either supplied something consumed OR bought anything this period gets a
    // row: a supplier you bought from and used none of is exactly as interesting as the reverse.
    const allVendorIds = [...new Set([...Object.keys(byVendor), ...Object.keys(netTotals)])]
    const purchaseTotal = Object.entries(netTotals)
      .filter(([, v]) => v > 0).reduce((s, [, v]) => s + v, 0)

    const built = allVendorIds.map(vid => {
      const a = byVendor[vid] || { value: 0, items: {}, recipes: {} }
      const purchased = vid === UNATTRIBUTED ? null : (netTotals[vid] || 0)
      return {
        id: vid,
        name: label(vid),
        code: vendorById[vid]?.vendor_code || '',
        attributed: a.value,
        attributedPct: pct(a.value, total),
        purchased,
        purchasedPct: purchased === null ? null : pct(purchased, purchaseTotal),
        itemRows: Object.entries(a.items)
          .map(([itemId, value]) => ({ itemId, value, qty: consumedByItem[itemId]?.qty || 0 }))
          .sort((x, y) => y.value - x.value),
        recipeRows: Object.entries(a.recipes)
          .map(([recipeId, value]) => ({ recipeId, value }))
          .sort((x, y) => y.value - x.value),
      }
    }).sort((a, b) => b.attributed - a.attributed || (b.purchased || 0) - (a.purchased || 0))

    setRows(built)
    setPurchaseShareBase(purchaseTotal)
    setTotals({
      attributed: total - (byVendor[UNATTRIBUTED]?.value || 0),
      consumed: total,
      unattributed: byVendor[UNATTRIBUTED]?.value || 0,
    })
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : ''
  const realSuppliers = rows.filter(r => r.id !== UNATTRIBUTED && r.attributed > 0)
  const topShare = realSuppliers.length > 0 ? realSuppliers[0].attributedPct : 0
  const purchaseGrandTotal = rows.reduce((s, r) => s + (r.purchased || 0), 0)
  const purchasePctTotal = pct(purchaseGrandTotal, purchaseShareBase)
  const scopeLine = `Period : ${periodLabel} (${selectedPeriod?.status === 'open' ? 'open' : 'closed'})`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const summary = rows.map(r => ({
      'Supplier': r.name,
      'Code': r.code,
      'Cost of Sales Attributed (NPR)': Math.round(r.attributed),
      '% of Attributed': r.attributedPct.toFixed(1) + '%',
      'Net Purchases (NPR)': r.purchased === null ? '' : Math.round(r.purchased),
      '% of Purchases': r.purchasedPct === null ? '' : r.purchasedPct.toFixed(1) + '%',
      'Items': r.itemRows.length,
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Supplier Contribution',
      biz,
      scopeLine,
      rows: summary,
      notes: [
        'Recipe-theoretical consumption (what the sold dishes should have used), not count-based COGS.',
        'Wastage and staff meals excluded — this is the cost of what was sold.',
      ],
    }), 'Suppliers')

    // Every traced ingredient line, not the COUNT of them. The on-screen panel caps its preview,
    // so without this sheet the detail a supplier's figure is built from had no export at all.
    const detail = rows.flatMap(r => r.itemRows.map(it => ({
      'Supplier': r.name,
      'Ingredient': names.items[it.itemId] || 'Unknown item',
      'Qty Consumed': Number((it.qty || 0).toFixed(3)),
      'Cost Attributed (NPR)': Math.round(it.value),
    })))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Supplier Contribution — Ingredient Detail',
      biz, scopeLine, rows: detail,
    }), 'Ingredient Detail')

    XLSX.writeFile(wb, `supplier-contribution-${periodLabel.replace(/ /g, '-')}.xlsx`)
  }

  if (authLoading) return null
  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  const actions = (
    <>
      <button className="btn btn-ghost" style={{ fontSize: 12 }}
        onClick={() => printWithTitle(`Supplier Contribution - ${periodLabel}`)}>🖨 Print</button>
      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}
        disabled={loading || !!loadError || rows.length === 0}>↓ Export Excel</button>
      <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''}
        onChange={e => handlePeriodChange(e.target.value)}>
        {periods.map(p => (
          <option key={p.id} value={p.id}>
            {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}
          </option>
        ))}
      </select>
    </>
  )

  const stats = (
    <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={320} text="What this period's sales consumed in ingredients, valued at each item's per-unit rate, then split across the suppliers that provided them — EXCLUDING the part that could not be traced to any supplier. The TOTAL row at the foot of the table is the whole consumed figure including that untraced part, so the two differ by exactly the Not Attributed card.">
            Attributed Cost of Sales
          </Tip>
        </div>
        <div className="stat-value gold" style={{ fontSize: 18 }}>{npr(totals.attributed)}</div>
        <div className="stat-sub">traced to a supplier</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Suppliers</div>
        <div className="stat-value">{realSuppliers.length}</div>
        <div className="stat-sub">behind what you sold</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={280} text="Share of attributed cost coming from your single largest supplier. The higher this is, the more one delivery failure can take off your menu.">
            Top Supplier Share
          </Tip>
        </div>
        <div className="stat-value" style={{
          fontSize: 18,
          color: topShare >= 50 ? 'var(--theme-amber-text)' : 'var(--theme-text1)',
        }}>{topShare.toFixed(1)}%</div>
        <div className="stat-sub">{realSuppliers[0]?.name || '—'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={300} text="Ingredients your sales consumed that you bought from nobody this period — usually stock bought in an earlier month. Shown rather than dropped, so the figures above always add up to the whole.">
            Not Attributed
          </Tip>
        </div>
        <div className="stat-value" style={{ fontSize: 18, color: totals.unattributed > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text3)' }}>
          {npr(totals.unattributed)}
        </div>
        <div className="stat-sub">{pct(totals.unattributed, totals.consumed).toFixed(1)}% of consumption</div>
      </div>
    </div>
  )

  const note = (
    <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 16px', maxWidth: 900 }}>
      Each ingredient your sales used is split across the suppliers you bought it from this period,
      in proportion to what you spent with each. Wastage and staff meals are not included — this is
      the cost of what was <strong>sold</strong>. Complimentary items are included: the food still
      came out of a supplier&apos;s delivery.
    </p>
  )

  return (
    <ReportPage
      title="Supplier Contribution"
      subtitle={`Which suppliers this period's sales actually depended on — ${periodLabel}`}
      actions={actions}
      noPeriod={!loading && !loadError && periods.length === 0}
      noPeriodWhat="supplier contribution"
      loading={loading}
      loadingText="Tracing suppliers…"
      error={loadError}
      empty={rows.length === 0}
      emptyIcon="🚚"
      emptyText={`No sales or purchases recorded for ${periodLabel}.`}
      stats={stats}
      note={note}
    >
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Supplier</th>
              <th style={{ textAlign: 'right' }}>
                <Tip width={280} text="This supplier's share of the ingredient cost behind what you sold.">Cost of Sales</Tip>
              </th>
              <th style={{ textAlign: 'right' }}>% of Sales Cost</th>
              <th style={{ textAlign: 'right' }}>
                <Tip width={280} text="Net purchases from this supplier this period — gross less bill discounts and returns. The same figure Vendor Report calls Net Spend.">Net Purchases</Tip>
              </th>
              <th style={{ textAlign: 'right' }}>% of Purchases</th>
              <th style={{ textAlign: 'right' }}>
                <Tip width={340} text="How far this supplier's share of your sales cost runs ahead of (or behind) its share of your spend, in percentage points. A large positive number means you depend on them more than your purchase ledger suggests — you are cooking with more of their stock than you bought from them this month.">Reliance Gap</Tip>
              </th>
              <th style={{ textAlign: 'right' }}>Items</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const delta = r.purchasedPct === null ? null : r.attributedPct - r.purchasedPct
              const isOpen = expanded === r.id
              const special = r.id === UNATTRIBUTED || r.id === NO_VENDOR
              const canExpand = r.itemRows.length > 0
              return [
                <tr key={r.id}
                  // The drill-down is this page's only interaction and was a bare `<tr onClick>`
                  // until S594 — no tabIndex, no role, no key handler — so it was unreachable
                  // without a mouse and a screen reader was never told the row expanded.
                  {...(canExpand ? {
                    tabIndex: 0,
                    role: 'button',
                    'aria-expanded': isOpen,
                    'aria-label': `${r.name} — ${isOpen ? 'hide' : 'show'} the ${r.itemRows.length} ingredients traced to this supplier`,
                    onClick: () => toggleRow(r.id),
                    onKeyDown: e => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(r.id) }
                    },
                  } : {})}
                  style={{ cursor: canExpand ? 'pointer' : 'default' }}>
                  <td style={{ fontWeight: 600, color: special ? 'var(--theme-text3)' : 'var(--theme-text1)' }}>
                    {canExpand && <span aria-hidden="true" style={{ marginRight: 6 }}>{isOpen ? '▾' : '▸'}</span>}
                    {r.name}
                    {r.code && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)' }}>{r.code}</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{npr(r.attributed)}</td>
                  <td style={{ textAlign: 'right' }}>{r.attributedPct.toFixed(1)}%</td>
                  <td style={{ textAlign: 'right' }}>{r.purchased === null ? '—' : npr(r.purchased)}</td>
                  <td style={{ textAlign: 'right' }}>{r.purchasedPct === null ? '—' : `${r.purchasedPct.toFixed(1)}%`}</td>
                  <td style={{
                    textAlign: 'right', whiteSpace: 'nowrap',
                    color: delta === null ? 'var(--theme-text3)'
                      : delta > 5 ? 'var(--theme-amber-text)'
                      : delta < -5 ? 'var(--theme-text2)' : 'var(--theme-text3)',
                  }}>
                    {delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pts`}
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.itemRows.length}</td>
                </tr>,
                isOpen && canExpand && (
                  <tr key={`${r.id}-detail`} className="detail-row">
                    <td colSpan={7} style={{ background: 'var(--theme-table-hover)', padding: '12px 16px' }}>
                      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 260, flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', marginBottom: 6 }}>
                            INGREDIENTS TRACED HERE
                          </div>
                          {(showAllDetail ? r.itemRows : r.itemRows.slice(0, DETAIL_PREVIEW)).map(it => (
                            <div key={it.itemId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                              <span style={{ color: 'var(--theme-text2)' }}>{names.items[it.itemId] || 'Unknown item'}</span>
                              <span style={{ color: 'var(--theme-text1)' }}>{npr(it.value)}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{ minWidth: 260, flex: 1 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', marginBottom: 6 }}>
                            <Tip width={300} text="The menu items whose sales consumed this supplier's ingredients — what comes off the menu if a delivery fails.">
                              MENU ITEMS THAT DEPEND ON THIS
                            </Tip>
                          </div>
                          {(showAllDetail ? r.recipeRows : r.recipeRows.slice(0, DETAIL_PREVIEW)).map(rc => (
                            <div key={rc.recipeId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                              <span style={{ color: 'var(--theme-text2)' }}>{names.recipes[rc.recipeId] || 'Unknown recipe'}</span>
                              <span style={{ color: 'var(--theme-text1)' }}>{npr(rc.value)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {/* "+ N more" used to be a dead end in the UI and absent from the export.
                          Both halves are fixed: this control, and the Ingredient Detail sheet. */}
                      {!showAllDetail && (r.itemRows.length > DETAIL_PREVIEW || r.recipeRows.length > DETAIL_PREVIEW) && (
                        <button className="btn btn-ghost no-print" style={{ fontSize: 12, marginTop: 10 }}
                          onClick={e => { e.stopPropagation(); setShowAllDetail(true) }}>
                          Show all {Math.max(r.itemRows.length, r.recipeRows.length)} lines
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              ]
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <Tip width={340} text="The whole consumed figure, INCLUDING the Not attributed row above it. The Attributed Cost of Sales card at the top of the page excludes that row, so the two differ by exactly the untraced amount — they are not meant to match.">
                  TOTAL (incl. not attributed)
                </Tip>
              </td>
              <td style={{ textAlign: 'right' }}>{npr(totals.consumed)}</td>
              <td style={{ textAlign: 'right' }}>100.0%</td>
              <td style={{ textAlign: 'right' }}>{npr(purchaseGrandTotal)}</td>
              <td style={{ textAlign: 'right' }}>
                {/* Computed, never asserted: a vendor whose returns exceeded its purchases makes
                    this genuinely differ from 100, and that divergence is worth seeing. */}
                {purchaseShareBase > 0 ? `${purchasePctTotal.toFixed(1)}%` : '—'}
              </td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </ReportPage>
  )
}
