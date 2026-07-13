import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function MonthlySummary() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const { data: p } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    setPeriods(p || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await buildReport(open.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await buildReport(periodId)
    setLoading(false)
  }

  async function buildReport(periodId) {
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
    ] = await Promise.all([
      scopedFrom('categories').order('sort_order'),
      scopedFrom('items', '*, categories(id, name)').eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('opening_stock').select('*').eq('period_id', periodId),
      supabase.from('closing_stock').select('*').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty, rate').eq('period_id', periodId),
      scopedFrom('vendor_returns', 'item_id, qty, rate').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId),
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for. See
      // migration 20260706170000 for why sales_entries now carries that source separately.
      supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price').eq('period_id', periodId).neq('source', 'pos_comp'),
      scopedFrom('recipes', 'id, selling_price')
    ])

    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) || 0 })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) || 0 })
    const wasteMap = {}; (wastages || []).forEach(r => { wasteMap[r.item_id] = (wasteMap[r.item_id] || 0) + parseFloat(r.qty) })
    const staffMealMap = {}; (staffMealsData || []).forEach(r => { staffMealMap[r.item_id] = (staffMealMap[r.item_id] || 0) + parseFloat(r.qty) })

    // Purchase map: item_id -> { qty, value }
    const purchMap = {}
    ;(purchases || []).forEach(p => {
      if (!purchMap[p.item_id]) purchMap[p.item_id] = { qty: 0, value: 0 }
      purchMap[p.item_id].qty += parseFloat(p.qty)
      purchMap[p.item_id].value += parseFloat(p.qty) * parseFloat(p.rate)
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
      return s + parseFloat(row.qty_sold || 0) * price
    }, 0)

    // Per-category summary — COGS now uses net purchases (purchases − returns)
    // items.category_id is nullable — an uncategorized item used to match no category's
    // catItems filter and so was silently excluded from every total on this report with no
    // indication. Grouped into a synthetic "Uncategorized" row instead, same shape as a real one.
    function buildCatRow(catName, catItems) {
      const openingVal  = catItems.reduce((s, i) => s + (openMap[i.id] || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const purchaseVal = catItems.reduce((s, i) => s + (purchMap[i.id]?.value || 0), 0)
      const returnVal   = catItems.reduce((s, i) => s + (retMap[i.id]?.value || 0), 0)
      const netPurchaseVal = purchaseVal - returnVal
      const wastageVal    = catItems.reduce((s, i) => s + (wasteMap[i.id]     || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const staffMealsVal = catItems.reduce((s, i) => s + (staffMealMap[i.id] || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const closingVal    = catItems.reduce((s, i) => s + (closeMap[i.id]     || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const cogsVal = openingVal + netPurchaseVal - wastageVal - staffMealsVal - closingVal
      return {
        category: catName,
        openingVal, purchaseVal, returnVal, netPurchaseVal, wastageVal, staffMealsVal, closingVal, cogsVal,
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
      .filter(r => r.openingVal > 0 || r.purchaseVal > 0 || r.closingVal > 0 || r.wastageVal > 0 || r.staffMealsVal > 0)

    const totalOpening     = catRows.reduce((s, r) => s + r.openingVal, 0)
    const totalPurchase    = catRows.reduce((s, r) => s + r.purchaseVal, 0)
    const totalReturn      = catRows.reduce((s, r) => s + r.returnVal, 0)
    const totalNetPurchase = totalPurchase - totalReturn
    const totalWastage     = catRows.reduce((s, r) => s + r.wastageVal, 0)
    const totalStaffMeals  = catRows.reduce((s, r) => s + (r.staffMealsVal || 0), 0)
    const totalClosing     = catRows.reduce((s, r) => s + r.closingVal, 0)
    const totalCOGS        = catRows.reduce((s, r) => s + r.cogsVal, 0)
    const fcPct            = totalRevenue > 0 ? (totalCOGS / totalRevenue) * 100 : null
    const purchaseFcPct    = totalRevenue > 0 ? (totalNetPurchase / totalRevenue) * 100 : null

    setReport({
      catRows, totalOpening, totalPurchase, totalReturn, totalNetPurchase,
      totalWastage, totalStaffMeals, totalClosing, totalCOGS, totalRevenue, fcPct, purchaseFcPct
    })
  }

  function fmt(val) {
    return `NPR ${Number(val).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const clientName = profile?.clients?.name || 'Property'

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Monthly Summary</h1>
          <p className="page-subtitle">Stock valuation & food cost report — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
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

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p></div>
      ) : !report ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>No data for this period yet.</p></div>
      ) : (
        <>
          {/* KPI row */}
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(6,1fr)', marginBottom: 24 }}>
            {[
              { label: 'Opening Stock',    value: fmt(report.totalOpening),     color: 'var(--theme-text1)' },
              { label: 'Gross Purchases',  value: fmt(report.totalPurchase),    color: 'var(--theme-accent)' },
              { label: 'Returns',          value: fmt(report.totalReturn),      color: 'var(--theme-red)',
                sub: report.totalReturn > 0 ? `Net: ${fmt(report.totalNetPurchase)}` : 'None this period' },
              { label: 'Wastage',          value: fmt(report.totalWastage),     color: 'var(--theme-red)' },
              { label: 'Closing Stock',    value: fmt(report.totalClosing),     color: 'var(--theme-green)' },
              { label: 'COGS',             value: fmt(report.totalCOGS),        color: 'var(--theme-accent)',
                sub: report.fcPct != null ? `${report.fcPct.toFixed(1)}% of revenue` : 'No sales data',
                tip: 'Cost of Goods Used: Opening + Net Purchases − Wastage − Closing Stock. The actual ingredient cost consumed.' }
            ].map(s => (
              <div key={s.label} className="stat-card">
                <div className="stat-label">{s.tip ? <Tip text={s.tip} width={230}>{s.label}</Tip> : s.label}</div>
                <div className="stat-value" style={{ fontSize: 15, color: s.color }}>{s.value}</div>
                {s.sub && <div className="stat-sub">{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Food cost summary box */}
          <div style={{
            background: report.fcPct == null ? 'rgba(107,114,128,0.08)' :
              report.fcPct <= 35 ? 'rgba(52,211,153,0.06)' :
              report.fcPct <= 45 ? 'rgba(201,168,76,0.06)' : 'rgba(248,113,113,0.06)',
            border: `1px solid ${report.fcPct == null ? 'var(--theme-border)' :
              report.fcPct <= 35 ? 'rgba(52,211,153,0.2)' :
              report.fcPct <= 45 ? 'rgba(201,168,76,0.2)' : 'rgba(248,113,113,0.2)'}`,
            borderRadius: 10, padding: '20px 24px', marginBottom: 24,
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 20
          }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Net Sales Revenue</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-green)' }}>{fmt(report.totalRevenue)}</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4 }}>From sales entries (excl. VAT)</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text="Opening Stock + Net Purchases − Wastage − Staff Meals − Closing Stock. This is the actual ingredient cost consumed during the period." width={260}>Cost of Goods Used (COGS)</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-accent)' }}>{fmt(report.totalCOGS)}</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4 }}>Opening + Net Purchases − Wastage − Staff Meals − Closing</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text="COGS ÷ Net Sales Revenue × 100. Tells you how much of every rupee earned went to ingredients. Target: 28–35%." width={240}>Food Cost %</Tip>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: report.fcPct == null ? 'var(--theme-text2)' : report.fcPct <= 35 ? 'var(--theme-green)' : report.fcPct <= 45 ? 'var(--theme-accent)' : 'var(--theme-red)' }}>
                {report.fcPct != null ? `${report.fcPct.toFixed(1)}%` : '—'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 4 }}>
                {report.fcPct == null ? 'Add sales entries to calculate' :
                  report.fcPct <= 35 ? '✓ Within benchmark (28–35%)' :
                  report.fcPct <= 45 ? '⚠ Above benchmark — review purchases' :
                  '✗ Critical — immediate review needed'}
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
                    <th style={{ textAlign: 'right' }}>Gross Purchases</th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}>Returns</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Gross purchases minus returns to vendor. The true amount spent on stock this period." width={220}>Net Purchases</Tip></th>
                    <th style={{ textAlign: 'right' }}>Wastage</th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-purple)' }}><Tip text="Staff & complimentary consumption recorded this period. Deducted from COGS separately from wastage." width={240}>Staff Meals</Tip></th>
                    <th style={{ textAlign: 'right' }}>Closing Stock</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Cost of Goods Used: Opening + Net Purchases − Wastage − Staff Meals − Closing. Ingredient cost actually consumed." width={250}>COGS</Tip></th>
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
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>
                          {row.purchaseVal > 0 ? fmt(row.purchaseVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>
                          {row.returnVal > 0 ? `−${fmt(row.returnVal)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>
                          {row.netPurchaseVal !== row.purchaseVal ? fmt(row.netPurchaseVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>
                          {row.wastageVal > 0 ? fmt(row.wastageVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-purple)' }}>
                          {(row.staffMealsVal || 0) > 0 ? fmt(row.staffMealsVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green)' }}>
                          {row.closingVal > 0 ? fmt(row.closingVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>
                          {row.cogsVal !== 0 ? fmt(row.cogsVal) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {cogsPct > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                              <div style={{ width: 70, height: 5, background: 'var(--theme-border)', borderRadius: 3 }}>
                                <div style={{ width: `${Math.min(cogsPct, 100)}%`, height: '100%', background: 'var(--theme-accent)', borderRadius: 3 }} />
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
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 14 }}>{fmt(report.totalPurchase)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', paddingTop: 14 }}>
                      {report.totalReturn > 0 ? `−${fmt(report.totalReturn)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 14 }}>{fmt(report.totalNetPurchase)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', paddingTop: 14 }}>{fmt(report.totalWastage)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-purple)', paddingTop: 14 }}>{report.totalStaffMeals > 0 ? fmt(report.totalStaffMeals) : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green)', paddingTop: 14 }}>{fmt(report.totalClosing)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent)', paddingTop: 14, fontSize: 15 }}>{fmt(report.totalCOGS)}</td>
                    <td style={{ textAlign: 'right', paddingTop: 14, fontWeight: 700, color: 'var(--theme-text2)' }}>100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div style={{ marginTop: 20, padding: '12px 16px', background: 'var(--theme-bg)', borderRadius: 6, fontSize: 12, color: 'var(--theme-text3)' }}>
              COGS = Opening Stock + (Purchases − Returns) − Wastage − Staff Meals − Closing Stock &nbsp;·&nbsp;
              Food Cost % = COGS ÷ Net Sales Revenue × 100
            </div>
          </div>
        </>
      )}
    </div>
  )
}
