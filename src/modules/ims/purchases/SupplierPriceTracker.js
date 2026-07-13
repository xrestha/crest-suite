import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'
import { getCf } from './purchasesHelpers'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function SupplierPriceTracker() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [vendors, setVendors]           = useState([])
  const [items, setItems]               = useState([])
  const [periods, setPeriods]           = useState([])
  const [allPurchases, setAllPurchases] = useState([])
  const [loading, setLoading]           = useState(true)

  const [selectedVendorId, setSelectedVendorId] = useState('all')
  const [search, setSearch]             = useState('')
  const [filterTrend, setFilterTrend]   = useState('all')
  const [expandedItems, setExpandedItems] = useState({})

  const [editingPrice, setEditingPrice]     = useState({})
  const [savingPrice, setSavingPrice]       = useState({})
  const [affectedRecipes, setAffectedRecipes] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [effectiveClientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: v }, { data: i }, { data: p }, { data: pu }] = await Promise.all([
      scopedFrom('vendors', 'id, name').eq('is_active', true).order('name'),
      scopedFrom('items', 'id, name, item_code, uom, rate, per_uom_rate, purchase_qty, purchase_unit, conversion_factor, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
      scopedFrom('monthly_periods').order('bs_year').order('bs_month'),
      supabase.from('purchase_entries').select('id, item_id, vendor_id, period_id, rate, qty, bs_day, monthly_periods!inner(client_id)')
        .eq('monthly_periods.client_id', effectiveClientId)
    ])

    setVendors(v || [])
    setItems(i || [])
    setPeriods(p || [])
    setAllPurchases(pu || [])
    setLoading(false)
  }

  // ── Data derivation ────────────────────────────────────────────────────────

  const periodMap = {}
  periods.forEach(p => { periodMap[p.id] = p })

  const itemMap = {}
  items.forEach(i => { itemMap[i.id] = i })

  const vendorMap = {}
  vendors.forEach(v => { vendorMap[v.id] = v })

  function getPurchasesForVendor(vendorId) {
    const relevant = vendorId === 'all'
      ? allPurchases
      : allPurchases.filter(p => p.vendor_id === vendorId)
    const byItem = {}
    relevant.forEach(pe => {
      const period = periodMap[pe.period_id]
      if (!period) return
      const item = itemMap[pe.item_id]
      if (!item) return
      // purchase_entries.rate is stored ex-VAT and ALREADY converted to base-unit terms at entry
      // time (rate = entered_rate / conversion_factor — see PurchaseBillModal.jsx's saveBill).
      // This used to divide it AGAIN, by items.purchase_qty — an unrelated legacy field (paired
      // with items.rate for that table's own generated per_uom_rate column, nothing to do with
      // purchase-unit-to-base-unit conversion) — corrupting every converted item's tracked rate.
      // pe.rate IS the per-base-unit rate already; "per pack" is reconstructed by multiplying
      // back by the item's CURRENT conversion factor (the true factor at time of purchase isn't
      // stored per-entry, so this is a best-effort approximation if it's since changed).
      const cf = getCf(item)
      // For "all vendors" mode, key by vendor+item so same item from different vendors shows separately
      const key = vendorId === 'all' ? `${pe.vendor_id}__${pe.item_id}` : pe.item_id
      const entry = {
        id: pe.id,
        rate: parseFloat(pe.rate) * cf,
        perUomRate: parseFloat(pe.rate),
        qty: parseFloat(pe.qty),
        bs_day: pe.bs_day || 1,
        period_label: `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`,
        sort_key: period.bs_year * 100 + period.bs_month,
        vendor_id: pe.vendor_id,
        item_id: pe.item_id,
      }
      if (!byItem[key]) byItem[key] = []
      byItem[key].push(entry)
    })
    Object.keys(byItem).forEach(k => {
      byItem[k].sort((a, b) => a.sort_key - b.sort_key || a.bs_day - b.bs_day)
    })
    return byItem
  }

  function getTrend(history) {
    if (!history || history.length < 2) return 'nodata'
    const last = history[history.length - 1].perUomRate
    const prev = history[history.length - 2].perUomRate
    if (Math.abs(last - prev) < 0.01) return 'stable'
    return last > prev ? 'up' : 'down'
  }

  function getPctChange(history) {
    if (!history || history.length < 2) return null
    const last = history[history.length - 1].perUomRate
    const prev = history[history.length - 2].perUomRate
    if (prev === 0) return null
    return ((last - prev) / prev) * 100
  }

  function trendBadge(trend) {
    if (trend === 'up')     return <span className="badge badge-red">↑ Up</span>
    if (trend === 'down')   return <span className="badge badge-green">↓ Down</span>
    if (trend === 'stable') return <span className="badge badge-gray">→ Stable</span>
    return <span className="badge badge-gray">— —</span>
  }

  // ── Price update ────────────────────────────────────────────────────────────

  async function savePrice(item) {
    const newPerUomRate = parseFloat(editingPrice[item.id])
    if (isNaN(newPerUomRate) || newPerUomRate <= 0) {
      setEditingPrice(p => { const n = { ...p }; delete n[item.id]; return n })
      return
    }
    const { data: recipeIngs } = await supabase
      .from('recipe_ingredients').select('recipe_id, recipes(name)').eq('item_id', item.id)
    const affected = (recipeIngs || []).filter(ri => ri.recipes).map(ri => ri.recipes.name).filter((v, i, a) => a.indexOf(v) === i)

    setSavingPrice(p => ({ ...p, [item.id]: true }))
    const purchaseQty = parseFloat(item.purchase_qty) || 1
    const newPackRate = newPerUomRate * purchaseQty
    const { error } = await scopedUpdate('items', { rate: newPackRate }).eq('id', item.id)
    if (!error) {
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, rate: newPackRate, per_uom_rate: newPerUomRate } : i))
      if (affected.length > 0) setAffectedRecipes({ itemName: item.name, recipes: affected, newRate: newPerUomRate, uom: item.uom })
    }
    setSavingPrice(p => { const n = { ...p }; delete n[item.id]; return n })
    setEditingPrice(p => { const n = { ...p }; delete n[item.id]; return n })
  }

  function handlePriceKey(e, item) {
    if (e.key === 'Enter') savePrice(item)
    if (e.key === 'Escape') setEditingPrice(p => { const n = { ...p }; delete n[item.id]; return n })
  }

  // ── Excel export ───────────────────────────────────────────────────────────

  function exportExcel() {
    const byItem = getPurchasesForVendor(selectedVendorId)
    const wb = XLSX.utils.book_new()
    const vendorLabel = selectedVendorId === 'all' ? 'All_Vendors' : (vendorMap[selectedVendorId]?.name?.replace(/\s+/g, '_') || 'Vendor')

    const summaryRows = Object.entries(byItem).map(([key, history]) => {
      const item = itemMap[history[0]?.item_id] || itemMap[key]
      const vendor = vendorMap[history[0]?.vendor_id]
      const lastEntry = history[history.length - 1]
      const trend = getTrend(history)
      const pct = getPctChange(history)
      return {
        'Vendor': vendor?.name || '',
        'Item': item?.name || key,
        'Category': item?.categories?.name || '',
        'UOM': item?.uom || '',
        'Master Rate (per UOM)': parseFloat(item?.per_uom_rate) || 0,
        'Last Purchase Rate': lastEntry?.perUomRate?.toFixed(4) || '',
        'Last Period': lastEntry?.period_label || '',
        'Trend': trend,
        'Change %': pct != null ? parseFloat(pct.toFixed(2)) : '',
        'Total Purchases': history.length
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary')

    const detailRows = []
    Object.entries(byItem).forEach(([key, history]) => {
      const item = itemMap[history[0]?.item_id] || itemMap[key]
      const vendor = vendorMap[history[0]?.vendor_id]
      history.forEach(entry => {
        detailRows.push({
          'Vendor': vendor?.name || '',
          'Item': item?.name || key,
          'UOM': item?.uom || '',
          'Period': entry.period_label,
          'Day': entry.bs_day,
          'Rate (per pack)': entry.rate,
          'Rate (per UOM)': entry.perUomRate?.toFixed(4),
          'Qty': entry.qty
        })
      })
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detailRows), 'Purchase History')
    XLSX.writeFile(wb, `PriceTracker_${vendorLabel}.xlsx`)
  }

  // ── Derived data for table ─────────────────────────────────────────────────

  const vendorPurchases = getPurchasesForVendor(selectedVendorId)

  const filteredKeys = Object.keys(vendorPurchases).filter(key => {
    const history = vendorPurchases[key]
    const item = itemMap[history[0]?.item_id] || itemMap[key]
    if (!item) return false
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (filterTrend !== 'all' && getTrend(history) !== filterTrend) return false
    return true
  }).sort((a, b) => {
    const ta = getTrend(vendorPurchases[a])
    const tb = getTrend(vendorPurchases[b])
    if (ta === 'up' && tb !== 'up') return -1
    if (ta !== 'up' && tb === 'up') return 1
    const ia = itemMap[vendorPurchases[a][0]?.item_id]
    const ib = itemMap[vendorPurchases[b][0]?.item_id]
    return (ia?.name || '').localeCompare(ib?.name || '')
  })

  const risingCount = filteredKeys.filter(k => getTrend(vendorPurchases[k]) === 'up').length

  if (loading) {
    return (
      <div className="page-header">
        <h1 className="page-title">Price Tracker</h1>
        <p style={{ color: 'var(--theme-text2)', fontSize: 13, marginTop: 12 }}>Loading…</p>
      </div>
    )
  }

  return (
    <div>
      {/* Page header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Price Tracker</h1>
          <p className="page-subtitle">Purchase price history by vendor</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }} className="no-print">
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => printWithTitle(`Supplier Price Tracker - ${selectedVendorId === 'all' ? 'All Vendors' : (vendorMap[selectedVendorId]?.name || 'Vendor')}`)}>
            🖨 Print
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}>
            ↓ Export Excel
          </button>
        </div>
      </div>

      {/* Recipe impact banner */}
      {affectedRecipes && (
        <div className="card no-print" style={{ marginBottom: 16, borderColor: 'rgba(201,168,76,0.4)', background: 'rgba(201,168,76,0.05)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <p style={{ fontSize: 13, color: 'var(--theme-accent)', margin: '0 0 6px', fontWeight: 600 }}>
                ⚠ Rate updated — {affectedRecipes.recipes.length} recipe{affectedRecipes.recipes.length !== 1 ? 's' : ''} affected for {affectedRecipes.itemName}
              </p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {affectedRecipes.recipes.map(r => <span key={r} className="badge badge-yellow">{r}</span>)}
              </div>
            </div>
            <button className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }} onClick={() => setAffectedRecipes(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Filters bar */}
      <div className="no-print" style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          className="form-select" style={{ minWidth: 220 }}
          value={selectedVendorId}
          onChange={e => { setSelectedVendorId(e.target.value); setExpandedItems({}) }}
        >
          <option value="all">All Vendors ({vendors.length})</option>
          {vendors.map(v => {
            const count = Object.keys(getPurchasesForVendor(v.id)).length
            return <option key={v.id} value={v.id}>{v.name} ({count} item{count !== 1 ? 's' : ''})</option>
          })}
        </select>

        <input
          className="form-select" style={{ width: 200 }}
          placeholder="Search items…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        <select className="form-select" value={filterTrend} onChange={e => setFilterTrend(e.target.value)}>
          <option value="all">All Trends</option>
          <option value="up">↑ Rising Only</option>
          <option value="down">↓ Decreasing</option>
          <option value="stable">→ Stable</option>
          <option value="nodata">No Data</option>
        </select>

        <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 4 }}>
          {filteredKeys.length} item{filteredKeys.length !== 1 ? 's' : ''}
          {risingCount > 0 && <span style={{ color: 'var(--theme-red)', marginLeft: 8 }}>· {risingCount} ↑ rising</span>}
        </span>
      </div>

      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 12 }}>
        <p style={{ fontSize: 13 }}>
          Vendor: <strong>{selectedVendorId === 'all' ? 'All Vendors' : vendorMap[selectedVendorId]?.name}</strong>
          {filterTrend !== 'all' && <> &nbsp;·&nbsp; Trend: <strong>{filterTrend}</strong></>}
          {search && <> &nbsp;·&nbsp; Search: <strong>{search}</strong></>}
        </p>
      </div>

      {/* Main table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {filteredKeys.length === 0 ? (
          <div className="empty-state" style={{ padding: 32 }}>
            <div className="empty-state-icon">₨</div>
            <p className="empty-state-text">
              {Object.keys(vendorPurchases).length === 0
                ? selectedVendorId === 'all'
                  ? 'No purchases recorded yet.'
                  : `No purchases recorded from ${vendorMap[selectedVendorId]?.name} yet.`
                : 'No items match the current filters.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
          <table className="data-table" style={{ marginBottom: 0 }}>
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                {selectedVendorId === 'all' && <th>Vendor</th>}
                <th>Item</th>
                <th>Category</th>
                <th>UOM</th>
                <th style={{ textAlign: 'right' }}><Tip text="Current rate per UOM in the Item Master — what recipe costing uses. Gold ⚠ means it differs from last purchase by >5%." width={260}>Master Rate</Tip></th>
                <th style={{ textAlign: 'right' }} className="no-print"><Tip text="Manually set a new master rate. Updates the Item Master and affects all recipe costs immediately." width={240}>Update Rate</Tip></th>
                <th style={{ textAlign: 'right' }}><Tip text="Rate per UOM from the most recent purchase entry across all periods.">Last Rate</Tip></th>
                <th>Last Period</th>
                <th><Tip text="Price direction vs. previous purchase: ↑ Rising (red), ↓ Falling (green), → Stable.">Trend</Tip></th>
                <th style={{ textAlign: 'right' }}><Tip text="% change from the second-to-last purchase to the most recent one. Red = price increase." width={240}>Change %</Tip></th>
                <th style={{ textAlign: 'right' }}>Purchases</th>
              </tr>
            </thead>
            <tbody>
              {filteredKeys.map(key => {
                const history = vendorPurchases[key]
                const item = itemMap[history[0]?.item_id] || itemMap[key]
                const vendor = vendorMap[history[0]?.vendor_id]
                if (!item) return null
                const lastEntry = history[history.length - 1]
                const trend = getTrend(history)
                const pct = getPctChange(history)
                const masterRate = parseFloat(item.per_uom_rate) || 0
                const lastRate = lastEntry?.perUomRate
                const rateMismatch = lastRate && Math.abs(masterRate - lastRate) / lastRate > 0.05
                const isExpanded = !!expandedItems[key]
                const isEditing = item.id in editingPrice
                const isSaving = savingPrice[item.id]

                return (
                  <>
                    <tr
                      key={`row-${key}`}
                      style={{ background: trend === 'up' ? 'rgba(248,113,113,0.03)' : 'transparent', cursor: 'pointer' }}
                      onClick={() => setExpandedItems(prev => ({ ...prev, [key]: !prev[key] }))}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpandedItems(prev => ({ ...prev, [key]: !prev[key] }))
                        }
                      }}
                    >
                      <td style={{ textAlign: 'center', color: 'var(--theme-text2)', fontSize: 12, userSelect: 'none' }}>
                        {isExpanded ? '▾' : '▸'}
                      </td>
                      {selectedVendorId === 'all' && (
                        <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{vendor?.name || '—'}</td>
                      )}
                      <td>
                        <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{item.name}</div>
                        {item.item_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace' }}>{item.item_code}</div>}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{item.categories?.name || '—'}</td>
                      <td style={{ color: 'var(--theme-text2)' }}>{item.uom}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span style={{ color: rateMismatch ? 'var(--theme-accent)' : 'var(--theme-text1)', fontWeight: 600 }}
                          title={rateMismatch ? 'Master rate differs from last purchase by >5%' : ''}>
                          {masterRate > 0 ? masterRate.toFixed(4) : '—'}
                        </span>
                        {rateMismatch && <span style={{ fontSize: 10, color: 'var(--theme-accent)', marginLeft: 4 }}>⚠</span>}
                      </td>
                      <td className="no-print" style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                        {isEditing ? (
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', alignItems: 'center' }}>
                            <input
                              type="number" min="0" step="0.0001"
                              value={editingPrice[item.id]}
                              onChange={e => setEditingPrice(p => ({ ...p, [item.id]: e.target.value }))}
                              onKeyDown={e => handlePriceKey(e, item)}
                              autoFocus
                              style={{
                                width: 90, textAlign: 'right',
                                background: 'var(--theme-bg)', border: '1px solid var(--theme-accent)',
                                borderRadius: 4, padding: '4px 8px', fontSize: 13,
                                color: 'var(--theme-text1)', outline: 'none'
                              }}
                            />
                            <button className="btn btn-primary" style={{ fontSize: 11, padding: '7px 11px' }}
                              aria-label="Save price" onClick={() => savePrice(item)} disabled={isSaving}>
                              {isSaving ? '…' : '✓'}
                            </button>
                            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '7px 11px' }}
                              aria-label="Cancel edit"
                              onClick={() => setEditingPrice(p => { const n = { ...p }; delete n[item.id]; return n })}>
                              ✕
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => setEditingPrice(p => ({ ...p, [item.id]: String(masterRate || '') }))}>
                            Edit
                          </button>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', color: trend === 'up' ? 'var(--theme-red)' : trend === 'down' ? 'var(--theme-green)' : 'var(--theme-text3)' }}>
                        {lastEntry ? lastEntry.perUomRate.toFixed(4) : '—'}
                      </td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{lastEntry?.period_label || '—'}</td>
                      <td>{trendBadge(trend)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: pct == null ? 'var(--theme-text2)' : pct > 0 ? 'var(--theme-red)' : pct < 0 ? 'var(--theme-green)' : 'var(--theme-text2)' }}>
                        {pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{history.length}</td>
                    </tr>

                    {/* Expanded history rows */}
                    {isExpanded && history.map((entry, idx) => {
                      const isFirst = idx === 0
                      const prevRate = isFirst ? null : history[idx - 1].perUomRate
                      const entryPct = prevRate ? ((entry.perUomRate - prevRate) / prevRate) * 100 : null
                      return (
                        <tr key={`hist-${key}-${idx}`} style={{ background: 'var(--theme-bg)' }}>
                          <td></td>
                          {selectedVendorId === 'all' && <td></td>}
                          <td colSpan={3} style={{ paddingLeft: 32, fontSize: 12, color: 'var(--theme-text3)' }}>
                            {entry.period_label}
                            {entry.bs_day > 1 && <span style={{ marginLeft: 6, color: 'var(--theme-text3)' }}>Day {entry.bs_day}</span>}
                          </td>
                          <td colSpan={2}></td>
                          <td className="no-print"></td>
                          <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--theme-text2)' }}>
                            {entry.perUomRate.toFixed(4)}
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Qty: {entry.qty}</td>
                          <td></td>
                          <td style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: entryPct == null ? 'var(--theme-text3)' : entryPct > 0 ? 'var(--theme-red)' : entryPct < 0 ? 'var(--theme-green)' : 'var(--theme-text3)' }}>
                            {entryPct != null ? `${entryPct > 0 ? '+' : ''}${entryPct.toFixed(1)}%` : <span style={{ color: 'var(--theme-text3)' }}>first</span>}
                          </td>
                          <td></td>
                        </tr>
                      )
                    })}
                  </>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <p className="no-print" style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-text3)' }}>
        Click any row to expand full purchase history. Rates are per UOM. "Update Rate" sets the item master cost used in recipe costing.
      </p>
    </div>
  )
}
