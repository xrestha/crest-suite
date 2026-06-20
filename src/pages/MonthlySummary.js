import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function MonthlySummary() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const { data: p } = await supabase
      .from('monthly_periods').select('*')
      .eq('client_id', effectiveClientId)
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
      supabase.from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order'),
      supabase.from('items').select('*, categories(id, name)').eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('opening_stock').select('*').eq('period_id', periodId),
      supabase.from('closing_stock').select('*').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty, rate').eq('period_id', periodId),
      supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId),
      supabase.from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId),
      supabase.from('recipes').select('id, selling_price').eq('client_id', effectiveClientId)
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
    const soldMap = {}
    ;(salesData || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold) })
    const totalRevenue = (recipes || []).reduce((s, r) => s + (soldMap[r.id] || 0) * (parseFloat(r.selling_price) || 0), 0)

    // Per-category summary — COGS now uses net purchases (purchases − returns)
    const catRows = (categories || []).map(cat => {
      const catItems = (items || []).filter(i => i.categories?.id === cat.id)

      const openingVal  = catItems.reduce((s, i) => s + (openMap[i.id] || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const purchaseVal = catItems.reduce((s, i) => s + (purchMap[i.id]?.value || 0), 0)
      const returnVal   = catItems.reduce((s, i) => s + (retMap[i.id]?.value || 0), 0)
      const netPurchaseVal = purchaseVal - returnVal
      const wastageVal    = catItems.reduce((s, i) => s + (wasteMap[i.id]     || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const staffMealsVal = catItems.reduce((s, i) => s + (staffMealMap[i.id] || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const closingVal    = catItems.reduce((s, i) => s + (closeMap[i.id]     || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const cogsVal = openingVal + netPurchaseVal - wastageVal - staffMealsVal - closingVal

      return {
        category: cat.name,
        openingVal, purchaseVal, returnVal, netPurchaseVal, wastageVal, staffMealsVal, closingVal, cogsVal,
        itemCount: catItems.length
      }
    }).filter(r => r.openingVal > 0 || r.purchaseVal > 0 || r.closingVal > 0)

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
            style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
            value={selectedPeriod?.id || ''}
            onChange={e => handlePeriodChange(e.target.value)}
          >
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}
              </option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => window.print()} style={{ fontSize: 13 }}>⎙ Print</button>
        </div>
      </div>

      {loading ? (
        <div className="card"><p style={{ color: '#6b7280', fontSize: 13 }}>Building report…</p></div>
      ) : !report ? (
        <div className="card"><p style={{ color: '#6b7280', fontSize: 13 }}>No data for this period yet.</p></div>
      ) : (
        <>
          {/* KPI row */}
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(6,1fr)', marginBottom: 24 }}>
            {[
              { label: 'Opening Stock',    value: fmt(report.totalOpening),     color: '#e8e0d0' },
              { label: 'Gross Purchases',  value: fmt(report.totalPurchase),    color: '#c9a84c' },
              { label: 'Returns',          value: fmt(report.totalReturn),      color: '#f87171',
                sub: report.totalReturn > 0 ? `Net: ${fmt(report.totalNetPurchase)}` : 'None this period' },
              { label: 'Wastage',          value: fmt(report.totalWastage),     color: '#f87171' },
              { label: 'Closing Stock',    value: fmt(report.totalClosing),     color: '#34d399' },
              { label: 'COGS',             value: fmt(report.totalCOGS),        color: '#c9a84c',
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
            border: `1px solid ${report.fcPct == null ? '#2a2f3d' :
              report.fcPct <= 35 ? 'rgba(52,211,153,0.2)' :
              report.fcPct <= 45 ? 'rgba(201,168,76,0.2)' : 'rgba(248,113,113,0.2)'}`,
            borderRadius: 10, padding: '20px 24px', marginBottom: 24,
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px,1fr))', gap: 20
          }}>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Net Sales Revenue</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#34d399' }}>{fmt(report.totalRevenue)}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>From sales entries (excl. VAT)</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text="Opening Stock + Net Purchases − Wastage − Staff Meals − Closing Stock. This is the actual ingredient cost consumed during the period." width={260}>Cost of Goods Used (COGS)</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#c9a84c' }}>{fmt(report.totalCOGS)}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Opening + Net Purchases − Wastage − Staff Meals − Closing</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text="COGS ÷ Net Sales Revenue × 100. Tells you how much of every rupee earned went to ingredients. Target: 28–35%." width={240}>Food Cost %</Tip>
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, color: report.fcPct == null ? '#6b7280' : report.fcPct <= 35 ? '#34d399' : report.fcPct <= 45 ? '#c9a84c' : '#f87171' }}>
                {report.fcPct != null ? `${report.fcPct.toFixed(1)}%` : '—'}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                {report.fcPct == null ? 'Add sales entries to calculate' :
                  report.fcPct <= 35 ? '✓ Within benchmark (28–35%)' :
                  report.fcPct <= 45 ? '⚠ Above benchmark — review purchases' :
                  '✗ Critical — immediate review needed'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                <Tip text="Net Purchases ÷ Revenue. A simpler estimate that ignores opening/closing stock. Useful when stock counts are unavailable." width={250}>Purchase-Based FC%</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#6b7280' }}>
                {report.purchaseFcPct != null ? `${report.purchaseFcPct.toFixed(1)}%` : '—'}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Net purchases ÷ revenue</div>
            </div>
          </div>

          {/* Category breakdown table */}
          <div className="card">
            <h3 style={{ margin: '0 0 20px', fontSize: 14, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Category Breakdown — {clientName} · {periodLabel}
            </h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th style={{ textAlign: 'right' }}>Opening Stock</th>
                    <th style={{ textAlign: 'right' }}>Gross Purchases</th>
                    <th style={{ textAlign: 'right', color: '#f87171' }}>Returns</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Gross purchases minus returns to vendor. The true amount spent on stock this period." width={220}>Net Purchases</Tip></th>
                    <th style={{ textAlign: 'right' }}>Wastage</th>
                    <th style={{ textAlign: 'right', color: '#a78bfa' }}><Tip text="Staff & complimentary consumption recorded this period. Deducted from COGS separately from wastage." width={240}>Staff Meals</Tip></th>
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
                        <td style={{ fontWeight: 600, color: '#e8e0d0' }}>
                          {row.category}
                          <span style={{ fontSize: 11, color: '#9ca3af', marginLeft: 8 }}>{row.itemCount} items</span>
                        </td>
                        <td style={{ textAlign: 'right', color: '#6b7280' }}>
                          {row.openingVal > 0 ? fmt(row.openingVal) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 600 }}>
                          {row.purchaseVal > 0 ? fmt(row.purchaseVal) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: '#f87171' }}>
                          {row.returnVal > 0 ? `−${fmt(row.returnVal)}` : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: '#c9a84c' }}>
                          {row.netPurchaseVal !== row.purchaseVal ? fmt(row.netPurchaseVal) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: '#f87171' }}>
                          {row.wastageVal > 0 ? fmt(row.wastageVal) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: '#a78bfa' }}>
                          {(row.staffMealsVal || 0) > 0 ? fmt(row.staffMealsVal) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: '#34d399' }}>
                          {row.closingVal > 0 ? fmt(row.closingVal) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#e8e0d0' }}>
                          {row.cogsVal !== 0 ? fmt(row.cogsVal) : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {cogsPct > 0 ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                              <div style={{ width: 70, height: 5, background: '#2a2f3d', borderRadius: 3 }}>
                                <div style={{ width: `${Math.min(cogsPct, 100)}%`, height: '100%', background: '#c9a84c', borderRadius: 3 }} />
                              </div>
                              <span style={{ fontSize: 12, color: '#6b7280', minWidth: 38 }}>{cogsPct.toFixed(1)}%</span>
                            </div>
                          ) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                    <td style={{ fontWeight: 800, color: '#e8e0d0', paddingTop: 14, fontSize: 14 }}>TOTAL</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#6b7280', paddingTop: 14 }}>{fmt(report.totalOpening)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', paddingTop: 14 }}>{fmt(report.totalPurchase)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', paddingTop: 14 }}>
                      {report.totalReturn > 0 ? `−${fmt(report.totalReturn)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', paddingTop: 14 }}>{fmt(report.totalNetPurchase)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', paddingTop: 14 }}>{fmt(report.totalWastage)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#34d399', paddingTop: 14 }}>{fmt(report.totalClosing)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 800, color: '#c9a84c', paddingTop: 14, fontSize: 15 }}>{fmt(report.totalCOGS)}</td>
                    <td style={{ textAlign: 'right', paddingTop: 14, fontWeight: 700, color: '#6b7280' }}>100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div style={{ marginTop: 20, padding: '12px 16px', background: '#0f1117', borderRadius: 6, fontSize: 12, color: '#9ca3af' }}>
              COGS = Opening Stock + (Purchases − Returns) − Wastage − Closing Stock &nbsp;·&nbsp;
              Food Cost % = COGS ÷ Net Sales Revenue × 100
            </div>
          </div>
        </>
      )}
    </div>
  )
}
