import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { COGS_FORMULA, fcBand, fcFigure } from '../../../shared/imsFormulas'
import { useSettings } from '../../../context/SettingsContext'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { allocateBillDiscounts } from './supplierAttribution'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { BS_MONTHS } from '../../../utils/bsCalendar'

export default function MonthlySummary() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const { data: p, error } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    if (error) { setLoadError(error.message); setLoading(false); return }
    setPeriods(p || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await buildReport(open.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await buildReport(periodId)
    setLoading(false)
  }

  async function buildReport(periodId) {
    setLoadError(null)
    const results = await Promise.all([
      scopedFrom('categories').order('sort_order'),
      // Every per-item-per-period read below is paged: one row per item per period is already
      // within reach of PostgREST's silent 1000-row cap on a large item master, and staff_meals
      // is per-item-per-DAY. A truncated opening/closing read is indistinguishable from an
      // uncounted shelf and produces a believable wrong COGS (S719's rule, applied here).
      fetchAllRows(() => scopedFrom('items', '*, categories(id, name)').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('item_id, qty, rate, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day')
        .eq('period_id', periodId).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'item_id, qty, rate').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId).order('id')),
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for. See
      // migration 20260706170000 for why sales_entries now carries that source separately.
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount').eq('period_id', periodId).neq('source', 'pos_comp').order('id')),
      scopedFrom('recipes', 'id, selling_price')
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded — a stale load's failure must not clobber the current view either
    // A failed read must not render as a quiet month of NPR 0 (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setReport(null); return }
    const [
      { data: categories },
      { data: items },
      { data: opening },
      { data: closing },
      { data: purchases },
      { data: returns },
      { data: wastages },
      { data: staffMealsData },
      { data: salesData },
      { data: recipes }
    ] = results

    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) || 0 })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) || 0 })
    const wasteMap = {}; (wastages || []).forEach(r => { wasteMap[r.item_id] = (wasteMap[r.item_id] || 0) + parseFloat(r.qty) })
    const staffMealMap = {}; (staffMealsData || []).forEach(r => { staffMealMap[r.item_id] = (staffMealMap[r.item_id] || 0) + parseFloat(r.qty) })

    // Purchase map: item_id -> { qty, gross, value }
    // `value` is NET of bill discounts (allocateBillDiscounts spreads each bill's single
    // discount_amount across its own lines by line value); `qty` is untouched, since a discount
    // changes what was paid, not what arrived. Consolidated P&L uses the same helper on the same
    // rows, which is what keeps the two pages' COGS tied.
    //
    // `gross` is kept separately because the column headed "Gross Purchases" was being fed
    // `lineNet` — the post-discount figure under a pre-discount label — so gross − net read as
    // "returns" when part of it was the bill discount, and the Net Purchases column printed a
    // dash on every bill that had a discount but no return.
    const purchMap = {}
    ;allocateBillDiscounts(purchases).forEach(p => {
      if (!purchMap[p.item_id]) purchMap[p.item_id] = { qty: 0, gross: 0, value: 0 }
      purchMap[p.item_id].qty += parseFloat(p.qty)
      purchMap[p.item_id].gross += p.lineGross
      purchMap[p.item_id].value += p.lineNet
    })

    // Returns map: item_id -> { qty, value }
    const retMap = {}
    ;(returns || []).forEach(r => {
      if (!retMap[r.item_id]) retMap[r.item_id] = { qty: 0, value: 0 }
      retMap[r.item_id].qty += parseFloat(r.qty)
      retMap[r.item_id].value += parseFloat(r.qty) * parseFloat(r.rate)
    })

    // Revenue
    // Revenue is computed per sale row using the price actually charged at the time (unit_price,
    // captured on the row) — falling back to the recipe's current price only for historical rows
    // recorded before that column existed (unit_price NULL). Previously always used the recipe's
    // CURRENT price for every row, so a closed period's revenue silently shifted whenever a menu
    // price changed later.
    const currentPriceMap = {}
    ;(recipes || []).forEach(r => { currentPriceMap[r.id] = parseFloat(r.selling_price) || 0 })
    const totalRevenue = (salesData || []).reduce((s, row) => {
      const price = row.unit_price != null ? parseFloat(row.unit_price) : (currentPriceMap[row.recipe_id] || 0)
      return s + parseFloat(row.qty_sold || 0) * price - (parseFloat(row.discount) || 0)
    }, 0)

    // Per-category summary — COGS now uses net purchases (purchases − returns)
    // items.category_id is nullable — an uncategorized item used to match no category's
    // catItems filter and so was silently excluded from every total on this report with no
    // indication. Grouped into a synthetic "Uncategorized" row instead, same shape as a real one.
    function buildCatRow(catName, catItems) {
      const openingVal  = catItems.reduce((s, i) => s + (openMap[i.id] || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const purchaseVal = catItems.reduce((s, i) => s + (purchMap[i.id]?.gross || 0), 0)
      const discountVal = purchaseVal - catItems.reduce((s, i) => s + (purchMap[i.id]?.value || 0), 0)
      const returnVal   = catItems.reduce((s, i) => s + (retMap[i.id]?.value || 0), 0)
      const netPurchaseVal = purchaseVal - discountVal - returnVal
      const wastageVal    = catItems.reduce((s, i) => s + (wasteMap[i.id]     || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const staffMealsVal = catItems.reduce((s, i) => s + (staffMealMap[i.id] || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const closingVal    = catItems.reduce((s, i) => s + (closeMap[i.id]     || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const cogsVal = openingVal + netPurchaseVal - wastageVal - staffMealsVal - closingVal
      return {
        category: catName,
        openingVal, purchaseVal, discountVal, returnVal, netPurchaseVal, wastageVal, staffMealsVal, closingVal, cogsVal,
        itemCount: catItems.length
      }
    }

    const uncategorizedItems = (items || []).filter(i => !i.categories?.id)
    const catRows = [
      ...(categories || []).map(cat => buildCatRow(cat.name, (items || []).filter(i => i.categories?.id === cat.id))),
      ...(uncategorizedItems.length > 0 ? [buildCatRow('Uncategorized', uncategorizedItems)] : []),
    ]
      // A category whose only activity this period was wastage/staff-meals (no opening/purchase/
      // closing) used to be dropped here entirely — including its wastage/staff-meals value —
      // from every downstream total (totalWastage, totalStaffMeals, totalCOGS).
      //
      // `returnVal` was the column that fix missed. Returning goods bought in an EARLIER period
      // is ordinary — the bill is in Shrawan, the spoiled case goes back in Bhadra — and such a
      // category has a return and nothing else, so it was dropped, its credit never reached
      // totalReturn (the KPI read "None this period" beside a real return) and totalCOGS was
      // overstated by the whole amount.
      .filter(r => r.openingVal > 0 || r.purchaseVal > 0 || r.closingVal > 0 || r.wastageVal > 0 || r.staffMealsVal > 0 || r.returnVal > 0)

    const totalOpening     = catRows.reduce((s, r) => s + r.openingVal, 0)
    const totalPurchase    = catRows.reduce((s, r) => s + r.purchaseVal, 0)
    const totalDiscount    = catRows.reduce((s, r) => s + r.discountVal, 0)
    const totalReturn      = catRows.reduce((s, r) => s + r.returnVal, 0)
    const totalNetPurchase = totalPurchase - totalDiscount - totalReturn
    const totalWastage     = catRows.reduce((s, r) => s + r.wastageVal, 0)
    const totalStaffMeals  = catRows.reduce((s, r) => s + (r.staffMealsVal || 0), 0)
    const totalClosing     = catRows.reduce((s, r) => s + r.closingVal, 0)
    const totalCOGS        = catRows.reduce((s, r) => s + r.cogsVal, 0)
    const fcPct            = totalRevenue > 0 ? (totalCOGS / totalRevenue) * 100 : null
    const purchaseFcPct    = totalRevenue > 0 ? (totalNetPurchase / totalRevenue) * 100 : null

    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setReport({
      catRows, totalOpening, totalPurchase, totalDiscount, totalReturn, totalNetPurchase,
      totalWastage, totalStaffMeals, totalClosing, totalCOGS, totalRevenue, fcPct, purchaseFcPct
    })
  }

  function fmt(val) {
    return `NPR ${Number(val).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const clientName = profile?.clients?.name || 'Property'

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the monthly summary" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Monthly Summary</h1>
          <p className="page-subtitle">Stock valuation &amp; food cost report</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Monthly Summary - ${periodLabel}`)} style={{ fontSize: 13 }}>⎙ Print</button>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {loadError ? null : loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p></div>
      ) : !report ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>No data for this period yet.</p></div>
      ) : (
        <>
          {/* KPI row */}
          <div className="stat-grid">
            {[
              { label: 'Opening Stock',    value: fmt(report.totalOpening),     color: 'var(--theme-text1)' },
              { label: 'Gross Purchases',  value: fmt(report.totalPurchase),    color: 'var(--theme-accent-ink)' },
              { label: 'Returns',          value: fmt(report.totalReturn),      color: 'var(--theme-red-text)',
                sub: report.totalReturn > 0 || report.totalDiscount > 0
                  ? `Net purchases: ${fmt(report.totalNetPurchase)}${report.totalDiscount > 0 ? ` (after ${fmt(report.totalDiscount)} discount)` : ''}`
                  : 'None this period' },
              { label: 'Wastage',          value: fmt(report.totalWastage),     color: 'var(--theme-red-text)' },
              { label: 'Closing Stock',    value: fmt(report.totalClosing),     color: 'var(--theme-green-text)' },
              { label: 'COGS',             value: fmt(report.totalCOGS),        color: 'var(--theme-accent-ink)',
                sub: report.fcPct != null ? `${report.fcPct.toFixed(1)}% of revenue` : 'No sales data',
                tip: `Cost of Goods Used: ${COGS_FORMULA}. The actual ingredient cost consumed.` }
            ].map(s => (
              <div key={s.label} className="stat-card">
                <div className="stat-label">{s.tip ? <Tip text={s.tip} width={230}>{s.label}</Tip> : s.label}</div>
                <div className="stat-value" style={{ fontSize: 14, color: s.color }}>{s.value}</div>
                {s.sub && <div className="stat-sub">{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Food cost summary box.
              The BOX and the sentence under the figure were the two things S682 left behind when
              it routed the number through fcFigure(): both kept a hardcoded 35/45, so a client who
              set fc_warning_pct to 30 got a ▲ red figure sitting inside a green box captioned
              "✓ Within benchmark (28–35%)". One band now drives the tint, the number and the
              sentence, all off the client's own thresholds. */}
          {(() => { const box = fcBand(report.fcPct, settings)
          const tint = () =>
            box.key === 'none' ? 'var(--theme-text2)' : box.key === 'good' ? 'var(--theme-green)' : box.key === 'watch' ? 'var(--theme-accent)' : 'var(--theme-red)'
          return (
          <div style={{
            background: `color-mix(in srgb, ${tint()} ${box.key === 'none' ? 8 : 6}%, transparent)`,
            border: `1px solid ${box.key === 'none' ? 'var(--theme-border)' : `color-mix(in srgb, ${tint()} 20%, transparent)`}`,
            borderRadius: 'var(--radius-md)', padding: '20px 24px', marginBottom: 24,
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 20
          }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Net Sales Revenue</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-green-text)' }}>{fmt(report.totalRevenue)}</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4 }}>From sales entries (excl. VAT)</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text={`${COGS_FORMULA}. This is the actual ingredient cost consumed during the period.`} width={260}>Cost of Goods Used (COGS)</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{fmt(report.totalCOGS)}</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4 }}>{COGS_FORMULA}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text={`COGS ÷ Net Sales Revenue × 100. Tells you how much of every rupee earned went to ingredients. Healthy up to ${box.warn}%, watch to ${box.critical}%, above that needs review — set in Settings → Thresholds.`} width={240}>Food Cost %</Tip>
              </div>
              {/* Banded through fcFigure(settings) — this was a local 35/45 ternary with no mark, a
                  third definition beside fcBand and Recipes' own, so the same month read green here
                  and amber on the dashboard (S682). 24px is the figure step; 28 was off the ramp. */}
              {(() => { const f = fcFigure(report.fcPct, settings); return (
                <div style={{ fontSize: 24, fontWeight: 800, ...f.style }} title={f.title}>{f.text}</div>
              ) })()}
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4 }}>
                {box.key === 'none' ? 'Add sales entries to calculate' :
                  box.key === 'good'  ? `✓ Within your target (≤${box.warn}%)` :
                  box.key === 'watch' ? `△ Above target — review purchases (${box.warn}–${box.critical}%)` :
                  `▲ Critical — immediate review needed (>${box.critical}%)`}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text="Net Purchases ÷ Revenue. A simpler estimate that ignores opening/closing stock. Useful when stock counts are unavailable." width={250}>Purchase-Based FC%</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text2)' }}>
                {report.purchaseFcPct != null ? `${report.purchaseFcPct.toFixed(1)}%` : '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4 }}>Net purchases ÷ revenue</div>
            </div>
          </div>
          ) })()}

          {/* Category breakdown table */}
          <div className="card">
            <h3 style={{ margin: '0 0 20px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Category Breakdown — {clientName} · {periodLabel}
            </h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th style={{ textAlign: 'right' }}>Opening Stock</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Bill value before any bill-level discount and before returns — what was invoiced." width={230}>Gross Purchases</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}><Tip text="Bill-level discounts, spread across each bill's lines in proportion to line value. Vendor Report and Consolidated P&amp;L net the same amount off." width={250}>Discount</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returns</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Gross purchases minus bill discounts minus returns to vendor. The true amount spent on stock this period, and what COGS is built from." width={240}>Net Purchases</Tip></th>
                    <th style={{ textAlign: 'right' }}>Wastage</th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-purple-text)' }}><Tip text="Staff & complimentary consumption recorded this period. Deducted from COGS separately from wastage." width={240}>Staff Meals</Tip></th>
                    <th style={{ textAlign: 'right' }}>Closing Stock</th>
                    <th style={{ textAlign: 'right' }}><Tip text={`Cost of Goods Used: ${COGS_FORMULA}. Ingredient cost actually consumed.`} width={250}>COGS</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="This category's COGS as a share of total COGS. Shows which category drives your ingredient spend." width={230}>% of Total COGS</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {report.catRows.map(row => {
                    const cogsPct = report.totalCOGS > 0 ? (row.cogsVal / report.totalCOGS) * 100 : 0
                    return (
                      <tr key={row.category}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          {row.category}
                          <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 8 }}>{row.itemCount} items</span>
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                          {row.openingVal > 0 ? fmt(row.openingVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>
                          {row.purchaseVal > 0 ? fmt(row.purchaseVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>
                          {row.discountVal > 0 ? `−${fmt(row.discountVal)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>
                          {row.returnVal > 0 ? `−${fmt(row.returnVal)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        {/* Always printed, never a dash: this column has a TOTAL under it, and a
                            column whose cells cannot be added up to its own total is unreadable.
                            It previously showed "—" whenever net equalled gross. */}
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                          {fmt(row.netPurchaseVal)}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>
                          {row.wastageVal > 0 ? fmt(row.wastageVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-purple-text)' }}>
                          {(row.staffMealsVal || 0) > 0 ? fmt(row.staffMealsVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>
                          {row.closingVal > 0 ? fmt(row.closingVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>
                          {row.cogsVal !== 0 ? fmt(row.cogsVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {cogsPct > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                              <div style={{ width: 70, height: 5, background: 'var(--theme-border)', borderRadius: 'var(--radius-xs)' }}>
                                <div style={{ width: `${Math.min(cogsPct, 100)}%`, height: '100%', background: 'var(--theme-accent)', borderRadius: 'var(--radius-xs)' }} />
                              </div>
                              <span style={{ fontSize: 12, color: 'var(--theme-text2)', minWidth: 38 }}>{cogsPct.toFixed(1)}%</span>
                            </div>
                          ) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                    <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 14, fontSize: 14 }}>TOTAL</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 14 }}>{fmt(report.totalOpening)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 14 }}>{fmt(report.totalPurchase)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 14 }}>
                      {report.totalDiscount > 0 ? `−${fmt(report.totalDiscount)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 14 }}>
                      {report.totalReturn > 0 ? `−${fmt(report.totalReturn)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 14 }}>{fmt(report.totalNetPurchase)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 14 }}>{fmt(report.totalWastage)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-purple-text)', paddingTop: 14 }}>{report.totalStaffMeals > 0 ? fmt(report.totalStaffMeals) : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)', paddingTop: 14 }}>{fmt(report.totalClosing)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent-ink)', paddingTop: 14, fontSize: 14 }}>{fmt(report.totalCOGS)}</td>
                    <td style={{ textAlign: 'right', paddingTop: 14, fontWeight: 700, color: 'var(--theme-text2)' }}>100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div style={{ marginTop: 20, padding: '12px 16px', background: 'var(--theme-bg)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--theme-text3)' }}>
              COGS = {COGS_FORMULA} &nbsp;·&nbsp;
              Net Purchases = Gross − bill discounts − returns &nbsp;·&nbsp;
              Food Cost % = COGS ÷ Net Sales Revenue × 100
              {/* Sub-recipe disclosure — Stock Count's Summary counts prep as stock, this page
                  deliberately excludes it (is_sub_recipe = false), so the two COGS figures differ
                  by exactly the sub-recipe amount. Stating it here saves the reconciler an
                  afternoon (S575). */}
              <div style={{ marginTop: 6 }}>
                Excludes <strong>sub-recipes</strong> (prep items). Stock Count&apos;s Summary includes
                them, so its COGS differs from this page by exactly the sub-recipe amount; both are
                correct for what they count.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
