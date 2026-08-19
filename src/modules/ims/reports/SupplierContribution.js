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
import { supabase } from '../../../supabaseClient'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import NoPeriodState from '../../../components/NoPeriodState'
import { printWithTitle } from '../../../utils/printTitle'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { selectDepletingSales } from '../sales/salesDepletion'
import {
  vendorNetByItem, vendorNetTotals, attributeConsumption, NO_VENDOR, UNATTRIBUTED,
} from './supplierAttribution'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const npr = n => `NPR ${(n || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`
const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0)

export default function SupplierContribution() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [totals, setTotals] = useState({ attributed: 0, consumed: 0, unattributed: 0 })
  const [names, setNames] = useState({ items: {}, recipes: {} })
  const [expanded, setExpanded] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const { data: p } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
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
    setLoading(true)
    await loadReport(periodId)
    setLoading(false)
  }

  async function loadReport(periodId) {
    const [
      { data: sales }, { data: purchases }, { data: returns },
      { data: items }, { data: vendors }, { data: recipes },
    ] = await Promise.all([
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

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const data = rows.map(r => ({
      'Supplier': r.name,
      'Code': r.code,
      'Cost of Sales Attributed (NPR)': Math.round(r.attributed),
      '% of Attributed': r.attributedPct.toFixed(1) + '%',
      'Net Purchases (NPR)': r.purchased === null ? '' : Math.round(r.purchased),
      '% of Purchases': r.purchasedPct === null ? '' : r.purchasedPct.toFixed(1) + '%',
      'Items': r.itemRows.length,
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Supplier Contribution')
    XLSX.writeFile(wb, `supplier-contribution-${periodLabel.replace(' ', '-')}.xlsx`)
  }

  if (authLoading) return null
  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  if (!loading && periods.length === 0) return <NoPeriodState what="supplier contribution" />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Supplier Contribution</h1>
          <p className="page-subtitle">
            Which suppliers this period&apos;s sales actually depended on — {periodLabel}
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-ghost" style={{ fontSize: 12 }}
            onClick={() => printWithTitle(`Supplier Contribution - ${periodLabel}`)}>🖨 Print</button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}>Export Excel</button>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''}
            onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">
            <Tip width={300} text="What this period's sales consumed in ingredients, valued at each item's per-unit rate, then split across the suppliers that provided them. Recipe-based (what the dishes should have used), not the actual COGS from the physical count.">
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

      <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 16px', maxWidth: 900 }}>
        Each ingredient your sales used is split across the suppliers you bought it from this period,
        in proportion to what you spent with each. Wastage and staff meals are not included — this is
        the cost of what was <strong>sold</strong>. Complimentary items are included: the food still
        came out of a supplier&apos;s delivery.
      </p>

      {loading ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: 'var(--theme-text3)' }}>
          No sales or purchases recorded for {periodLabel}.
        </p>
      ) : (
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
                  <Tip width={320} text="How far this supplier's share of your sales cost runs ahead of (or behind) its share of your spend. A large positive number means you depend on them more than your purchase ledger suggests.">Δ</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Items</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const delta = r.purchasedPct === null ? null : r.attributedPct - r.purchasedPct
                const isOpen = expanded === r.id
                const special = r.id === UNATTRIBUTED || r.id === NO_VENDOR
                return [
                  <tr key={r.id}
                    onClick={() => setExpanded(isOpen ? null : r.id)}
                    style={{ cursor: r.itemRows.length > 0 ? 'pointer' : 'default' }}>
                    <td style={{ fontWeight: 600, color: special ? 'var(--theme-text3)' : 'var(--theme-text1)' }}>
                      {r.itemRows.length > 0 && <span style={{ marginRight: 6 }}>{isOpen ? '▾' : '▸'}</span>}
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
                      {delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)} pp`}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.itemRows.length}</td>
                  </tr>,
                  isOpen && r.itemRows.length > 0 && (
                    <tr key={`${r.id}-detail`}>
                      <td colSpan={7} style={{ background: 'var(--theme-table-hover)', padding: '12px 16px' }}>
                        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                          <div style={{ minWidth: 260, flex: 1 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', marginBottom: 6 }}>
                              INGREDIENTS TRACED HERE
                            </div>
                            {r.itemRows.slice(0, 12).map(it => (
                              <div key={it.itemId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                                <span style={{ color: 'var(--theme-text2)' }}>{names.items[it.itemId] || 'Unknown item'}</span>
                                <span style={{ color: 'var(--theme-text1)' }}>{npr(it.value)}</span>
                              </div>
                            ))}
                            {r.itemRows.length > 12 && (
                              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                                + {r.itemRows.length - 12} more
                              </div>
                            )}
                          </div>
                          <div style={{ minWidth: 260, flex: 1 }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', marginBottom: 6 }}>
                              <Tip width={300} text="The menu items whose sales consumed this supplier's ingredients — what comes off the menu if a delivery fails.">
                                MENU ITEMS THAT DEPEND ON THIS
                              </Tip>
                            </div>
                            {r.recipeRows.slice(0, 12).map(rc => (
                              <div key={rc.recipeId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }}>
                                <span style={{ color: 'var(--theme-text2)' }}>{names.recipes[rc.recipeId] || 'Unknown recipe'}</span>
                                <span style={{ color: 'var(--theme-text1)' }}>{npr(rc.value)}</span>
                              </div>
                            ))}
                            {r.recipeRows.length > 12 && (
                              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                                + {r.recipeRows.length - 12} more
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{npr(totals.consumed)}</td>
                <td style={{ textAlign: 'right' }}>100.0%</td>
                <td style={{ textAlign: 'right' }}>{npr(purchaseGrandTotal)}</td>
                <td style={{ textAlign: 'right' }}>100.0%</td>
                <td />
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
