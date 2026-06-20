import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function Stock() {
  const { clientId, profile, loading: authLoading, isAdmin } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [items, setItems] = useState([])
  const [categories, setCategories] = useState([])
  const [stockData, setStockData] = useState({})
  const [purchases, setPurchases] = useState({})
  const [returns, setReturns] = useState({}) // { item_id: total_returned_qty }
  const [requisitioned, setRequisitioned] = useState({}) // { item_id: total_qty_issued }
  const [purchFreq, setPurchFreq] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState({})
  const [activeTab, setActiveTab] = useState('opening')
  const [filterCat, setFilterCat] = useState('all')
  const [search, setSearch] = useState('')
  const [saveAllLoading, setSaveAllLoading] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: i }, { data: c }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('items').select('*, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).order('name'),
      supabase.from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order')
    ])
    setPeriods(p || [])
    setItems(i || [])
    setCategories(c || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      setSelectedPeriod(open)
      await loadStockData(open.id, i || [])
    }
    setLoading(false)
  }

  async function loadStockData(periodId, itemList) {
    const [{ data: opening }, { data: closing }, { data: wastages }, { data: staffMealsData }, { data: purch }, { data: rets }] = await Promise.all([
      supabase.from('opening_stock').select('*').eq('period_id', periodId),
      supabase.from('closing_stock').select('*').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId),
      supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId),
      supabase.from('vendor_returns').select('item_id, qty').eq('period_id', periodId)
    ])

    const data = {}
    const items = itemList || []
    items.forEach(item => { data[item.id] = { opening: '', closing: '', wastage: '', staff_meal: '' } })
    ;(opening || []).forEach(r => { if (data[r.item_id]) data[r.item_id].opening = r.qty })
    ;(closing || []).forEach(r => { if (data[r.item_id]) data[r.item_id].closing = r.physical_qty })

    const wastageMap = {}
    ;(wastages || []).forEach(r => { wastageMap[r.item_id] = (wastageMap[r.item_id] || 0) + parseFloat(r.qty) })
    Object.keys(wastageMap).forEach(id => { if (data[id]) data[id].wastage = wastageMap[id] })

    const staffMealMap = {}
    ;(staffMealsData || []).forEach(r => { staffMealMap[r.item_id] = (staffMealMap[r.item_id] || 0) + parseFloat(r.qty) })
    Object.keys(staffMealMap).forEach(id => { if (data[id]) data[id].staff_meal = staffMealMap[id] })

    setStockData(data)

    const purchMap = {}
    const freqMap = {}
    ;(purch || []).forEach(r => {
      purchMap[r.item_id] = (purchMap[r.item_id] || 0) + parseFloat(r.qty)
      freqMap[r.item_id] = (freqMap[r.item_id] || 0) + 1
    })
    setPurchases(purchMap)
    setPurchFreq(freqMap)

    // Returns map
    const retMap = {}
    ;(rets || []).forEach(r => { retMap[r.item_id] = (retMap[r.item_id] || 0) + parseFloat(r.qty) })
    setReturns(retMap)

    // Requisitioned map — qty issued via store requisitions
    try {
      const { data: reqLines } = await supabase
        .from('requisition_lines')
        .select('item_id, qty_issued, requisitions!inner(client_id, period_id, status)')
        .eq('requisitions.period_id', periodId)
        .eq('requisitions.status', 'issued')
      const reqMap = {}
      ;(reqLines || []).forEach(r => { reqMap[r.item_id] = (reqMap[r.item_id] || 0) + parseFloat(r.qty_issued || 0) })
      setRequisitioned(reqMap)
    } catch (_) {
      setRequisitioned({})
    }
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    await loadStockData(periodId, items)
  }

  function updateField(itemId, field, value) {
    setStockData(prev => ({ ...prev, [itemId]: { ...prev[itemId], [field]: value } }))
  }

  async function persistValue(itemId, fieldKey, qty) {
    if (fieldKey === 'opening') {
      if (qty <= 0) {
        await supabase.from('opening_stock').delete().eq('period_id', selectedPeriod.id).eq('item_id', itemId)
      } else {
        await supabase.from('opening_stock').upsert({ period_id: selectedPeriod.id, item_id: itemId, qty }, { onConflict: 'period_id,item_id' })
      }
    }
    if (fieldKey === 'closing') {
      if (qty <= 0) {
        await supabase.from('closing_stock').delete().eq('period_id', selectedPeriod.id).eq('item_id', itemId)
      } else {
        await supabase.from('closing_stock').upsert({ period_id: selectedPeriod.id, item_id: itemId, physical_qty: qty, counted_at: new Date().toISOString() }, { onConflict: 'period_id,item_id' })
      }
    }
    if (fieldKey === 'wastage') {
      await supabase.from('wastages').delete().eq('period_id', selectedPeriod.id).eq('item_id', itemId)
      if (qty > 0) {
        await supabase.from('wastages').insert({ period_id: selectedPeriod.id, item_id: itemId, qty })
      }
    }
    if (fieldKey === 'staff_meal') {
      await supabase.from('staff_meals').delete().eq('period_id', selectedPeriod.id).eq('item_id', itemId)
      if (qty > 0) {
        await supabase.from('staff_meals').insert({ period_id: selectedPeriod.id, item_id: itemId, qty, type: 'staff' })
      }
    }
  }

  async function saveRow(itemId) {
    setSaving(prev => ({ ...prev, [itemId]: true }))
    const row = stockData[itemId] || {}
    const fieldKey = activeTab === 'opening' ? 'opening' : activeTab === 'closing' ? 'closing' : activeTab === 'staff_meal' ? 'staff_meal' : 'wastage'
    const qty = parseFloat(row[fieldKey]) || 0
    await persistValue(itemId, fieldKey, qty)
    setSaving(prev => ({ ...prev, [itemId]: false }))
  }

  async function saveAll() {
    setSaveAllLoading(true)
    const visibleItems = filteredItems()
    for (const item of visibleItems) { await saveRow(item.id) }
    setSaveAllLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function clearAll() {
    const fieldKey = activeTab === 'opening' ? 'opening' : activeTab === 'closing' ? 'closing' : activeTab === 'staff_meal' ? 'staff_meal' : 'wastage'
    const label = TABS.find(t => t.id === activeTab)?.label || 'these'
    const visibleItems = filteredItems()
    if (!window.confirm(`Clear all entered ${label} values for the ${visibleItems.length} item(s) currently shown? This cannot be undone.`)) return
    setSaveAllLoading(true)
    for (const item of visibleItems) { await persistValue(item.id, fieldKey, 0) }
    setStockData(prev => {
      const next = { ...prev }
      visibleItems.forEach(item => { next[item.id] = { ...next[item.id], [fieldKey]: 0 } })
      return next
    })
    setSaveAllLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  function filteredItems() {
    return items.filter(item => {
      const matchCat = filterCat === 'all' || item.category_id === filterCat
      const matchSearch = item.name.toLowerCase().includes(search.toLowerCase())
      return matchCat && matchSearch
    })
  }

  // PATCHED: subtract returns from used calculation
  function getUsed(itemId) {
    const row = stockData[itemId] || {}
    const opening = parseFloat(row.opening) || 0
    const purchased = parseFloat(purchases[itemId]) || 0
    const returned = parseFloat(returns[itemId]) || 0
    const closing = parseFloat(row.closing) || 0
    const wastage    = parseFloat(row.wastage)    || 0
    const staffMeal  = parseFloat(row.staff_meal) || 0
    return opening + purchased - returned - closing - wastage - staffMeal
  }

  // PATCHED: subtract returns from system ref qty
  function getSystemRefQty(itemId) {
    const row = stockData[itemId] || {}
    const opening = parseFloat(row.opening) || 0
    const purchased = parseFloat(purchases[itemId]) || 0
    const returned = parseFloat(returns[itemId]) || 0
    return opening + purchased - returned
  }

  function getStockValue(itemId, item) {
    return getSystemRefQty(itemId) * parseFloat(item.per_uom_rate || 0)
  }

  function getHighValueFlags() {
    const values = items.map(i => getStockValue(i.id, i)).filter(v => v > 0)
    if (values.length === 0) return new Set()
    const sorted = [...values].sort((a, b) => b - a)
    const cutoffIdx = Math.max(0, Math.ceil(sorted.length * 0.25) - 1)
    const valueThreshold = sorted[cutoffIdx] || 0
    const freqThreshold = 3
    const flagged = new Set()
    items.forEach(item => {
      const value = getStockValue(item.id, item)
      const freq = purchFreq[item.id] || 0
      if (value >= valueThreshold && value > 0 && freq >= freqThreshold) flagged.add(item.id)
    })
    return flagged
  }

  function getSummary() {
    const byCategory = {}
    categories.forEach(c => {
      const catItems = items.filter(i => i.category_id === c.id)
      const openingVal   = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.opening) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const closingVal   = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.closing) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const purchasesVal = catItems.reduce((sum, i) => sum + (parseFloat(purchases[i.id]) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const wastageVal    = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.wastage)    || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const staffMealsVal = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.staff_meal) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const cogsVal       = catItems.reduce((sum, i) => sum + getUsed(i.id) * parseFloat(i.per_uom_rate || 0), 0)
      byCategory[c.name] = { opening: openingVal, closing: closingVal, purchases: purchasesVal, wastage: wastageVal, staffMeals: staffMealsVal, cogs: cogsVal }
    })
    return byCategory
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    const rows = items.map(item => {
      const row      = stockData[item.id] || {}
      const rate     = parseFloat(item.per_uom_rate || 0)
      const openQty  = parseFloat(row.opening  || 0)
      const purchQty = parseFloat(purchases[item.id] || 0)
      const retQty   = parseFloat(returns[item.id]   || 0)
      const wastQty  = parseFloat(row.wastage    || 0)
      const staffQty = parseFloat(row.staff_meal || 0)
      const closeQty = parseFloat(row.closing    || 0)
      const usedQty  = getUsed(item.id)
      return {
        'Item':              item.name,
        'Category':          item.categories?.name || '',
        'UOM':               item.uom,
        'Opening Qty':       openQty   || '',
        'Opening Value':     rate > 0 ? Math.round(openQty  * rate) : '',
        'Purchased Qty':     purchQty  || '',
        'Purchase Value':    rate > 0 ? Math.round(purchQty * rate) : '',
        'Returned Qty':      retQty    || '',
        'Returns Value':     rate > 0 ? Math.round(retQty   * rate) : '',
        'Wastage Qty':       wastQty   || '',
        'Wastage Value':     rate > 0 ? Math.round(wastQty  * rate) : '',
        'Staff Meals Qty':   staffQty  || '',
        'Staff Meals Value': rate > 0 ? Math.round(staffQty * rate) : '',
        'Closing Qty':       closeQty  || '',
        'Closing Value':     rate > 0 ? Math.round(closeQty * rate) : '',
        'Used Qty':          usedQty   || '',
        'COGS (NPR)':        rate > 0 ? Math.round(usedQty  * rate) : '',
        'Requisitioned Qty': requisitioned[item.id] || '',
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stock Register')
    XLSX.writeFile(wb, `Stock-Register-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'
  const visible = filteredItems()

  const TABS = [
    { id: 'opening',    label: 'Opening Stock', desc: 'Stock at start of month' },
    { id: 'closing',    label: 'Closing Stock', desc: 'Physical count at month end' },
    { id: 'wastage',    label: 'Wastage',       desc: 'Spoilage & waste recorded' },
    { id: 'staff_meal', label: 'Staff Meals',   desc: 'Staff & complimentary consumption — tracked separately from wastage' },
    { id: 'summary',    label: 'Summary',       desc: 'Full picture per item' },
    { id: 'print',      label: 'Print Sheet',   desc: 'Physical count sheet for the floor' },
  ]

  return (
    <div>
      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Stock Count</h1>
          <p className="page-subtitle">Opening stock, physical closing count & wastage — {periodLabel}</p>
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
        </div>
      </div>

      {isLocked && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#f87171' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}

      <div className="no-print" style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid #2a2f3d', paddingBottom: 0 }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '10px 20px', fontSize: 13, fontWeight: 500,
            color: activeTab === tab.id ? '#c9a84c' : '#6b7280',
            borderBottom: activeTab === tab.id ? '2px solid #c9a84c' : '2px solid transparent',
            marginBottom: -1, transition: 'color 0.12s'
          }}>{tab.label}</button>
        ))}
      </div>

      {/* Summary Tab */}
      {activeTab === 'summary' && (
        <div>
          {(() => {
              const summary = getSummary()
              const rows = categories.map(c => summary[c.name] || { opening: 0, purchases: 0, closing: 0, wastage: 0, staffMeals: 0, cogs: 0 })
              const totals = {
                opening:    rows.reduce((s, r) => s + r.opening,            0),
                purchases:  rows.reduce((s, r) => s + r.purchases,          0),
                closing:    rows.reduce((s, r) => s + r.closing,            0),
                wastage:    rows.reduce((s, r) => s + r.wastage,            0),
                staffMeals: rows.reduce((s, r) => s + (r.staffMeals || 0), 0),
                cogs:       rows.reduce((s, r) => s + r.cogs,               0),
              }
              const fmt = v => v.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
              const thStyle = { textAlign: 'right', whiteSpace: 'nowrap' }
              const tdStyle = (color) => ({ textAlign: 'right', color: color || '#e8e0d0', whiteSpace: 'nowrap' })
              return (
                <div className="card" style={{ marginBottom: 24 }}>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: 36, textAlign: 'center', color: '#6b7280' }}>S.No</th>
                          <th>Category</th>
                          <th style={thStyle}>Opening Stock (NPR)</th>
                          <th style={thStyle}>Production / Purchase (NPR)</th>
                          <th style={thStyle}>Closing Stock (NPR)</th>
                          <th style={thStyle}>Wastage (NPR)</th>
                          <th style={thStyle}>Staff Meals (NPR)</th>
                          <th style={thStyle}>COGS (NPR)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {categories.map((c, idx) => {
                          const s = summary[c.name] || { opening: 0, purchases: 0, closing: 0, wastage: 0, staffMeals: 0, cogs: 0 }
                          return (
                            <tr key={c.id}>
                              <td style={{ textAlign: 'center', color: '#6b7280' }}>{idx + 1}</td>
                              <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{c.name}</td>
                              <td style={tdStyle('#9ca3af')}>{s.opening > 0 ? fmt(s.opening) : '—'}</td>
                              <td style={tdStyle('#c9a84c')}>{s.purchases > 0 ? fmt(s.purchases) : '—'}</td>
                              <td style={tdStyle('#34d399')}>{s.closing > 0 ? fmt(s.closing) : '—'}</td>
                              <td style={tdStyle('#f87171')}>{s.wastage > 0 ? fmt(s.wastage) : '—'}</td>
                              <td style={tdStyle('#a78bfa')}>{(s.staffMeals || 0) > 0 ? fmt(s.staffMeals) : '—'}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600, color: s.cogs < 0 ? '#f87171' : '#e8e0d0', whiteSpace: 'nowrap' }}>{fmt(s.cogs)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                          <td></td>
                          <td style={{ fontWeight: 700, color: '#c9a84c' }}>Totals</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmt(totals.opening)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', whiteSpace: 'nowrap' }}>{fmt(totals.purchases)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#34d399', whiteSpace: 'nowrap' }}>{fmt(totals.closing)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', whiteSpace: 'nowrap' }}>{fmt(totals.wastage)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#a78bfa', whiteSpace: 'nowrap' }}>{fmt(totals.staffMeals)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', whiteSpace: 'nowrap' }}>{fmt(totals.cogs)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )
            })()}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-ghost" onClick={exportExcel}>Export Excel</button>
          </div>

          <div className="card">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>Opening</th>
                    <th style={{ textAlign: 'right' }}>Purchased</th>
                    <th style={{ textAlign: 'right', color: '#f87171' }}>Returned</th>
                    <th style={{ textAlign: 'right' }}>Wastage</th>
                    <th style={{ textAlign: 'right', color: '#a78bfa' }}><Tip text="Staff & complimentary consumption recorded this period. Deducted from Used separately from wastage." width={240}>Staff Meals</Tip></th>
                    <th style={{ textAlign: 'right' }}>Closing</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Opening + Purchased − Returned − Wastage − Staff Meals − Closing. What was actually consumed this period." width={240}>Used</Tip></th>
                    <th style={{ textAlign: 'right', color: '#a78bfa' }}><Tip text="Total qty issued from the store via requisition slips this period. Should align with Used quantity." width={240}>Requisitioned</Tip></th>
                    <th style={{ textAlign: 'right', color: '#9ca3af', borderLeft: '1px solid #2a2f3d' }}>Open. Value</th>
                    <th style={{ textAlign: 'right', color: '#c9a84c' }}>Purch. Value</th>
                    <th style={{ textAlign: 'right', color: '#f87171' }}>Wastage Value</th>
                    <th style={{ textAlign: 'right', color: '#a78bfa' }}>Staff Meals Value</th>
                    <th style={{ textAlign: 'right', color: '#34d399' }}>Close Value</th>
                    <th style={{ textAlign: 'right', color: '#c9a84c' }}>COGS (NPR)</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const row      = stockData[item.id] || {}
                    const used     = getUsed(item.id)
                    const returned = returns[item.id] || 0
                    const hasData  = row.opening !== '' || row.closing !== '' || purchases[item.id]
                    const rate     = parseFloat(item.per_uom_rate || 0)
                    const openQty  = parseFloat(row.opening     || 0)
                    const purchQty = parseFloat(purchases[item.id] || 0)
                    const wastQty  = parseFloat(row.wastage     || 0)
                    const staffQty = parseFloat(row.staff_meal  || 0)
                    const closeQty = parseFloat(row.closing     || 0)
                    const fmtVal   = (qty) => rate > 0 && qty !== 0
                      ? `NPR ${Math.round(qty * rate).toLocaleString('en-NP')}`
                      : '—'
                    return (
                      <tr key={item.id} style={{ opacity: hasData ? 1 : 0.4 }}>
                        <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{item.name}</td>
                        <td><span className="badge badge-yellow">{item.categories?.name}</span></td>
                        <td style={{ color: '#6b7280' }}>{item.uom}</td>
                        <td style={{ textAlign: 'right' }}>{row.opening !== '' ? Number(row.opening).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: '#c9a84c' }}>{purchases[item.id] ? Number(purchases[item.id]).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: '#f87171' }}>{returned > 0 ? `−${Number(returned).toLocaleString()}` : '—'}</td>
                        <td style={{ textAlign: 'right', color: '#f87171' }}>{row.wastage ? Number(row.wastage).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: '#a78bfa' }}>{staffQty > 0 ? Number(staffQty).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: '#34d399' }}>{row.closing !== '' ? Number(row.closing).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: used < 0 ? '#f87171' : '#e8e0d0' }}>
                          {hasData ? Number(used).toLocaleString() : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: '#a78bfa' }}>
                          {requisitioned[item.id] ? Number(requisitioned[item.id]).toLocaleString() : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: '#9ca3af', borderLeft: '1px solid #2a2f3d' }}>{fmtVal(openQty)}</td>
                        <td style={{ textAlign: 'right', color: '#c9a84c' }}>{fmtVal(purchQty)}</td>
                        <td style={{ textAlign: 'right', color: '#f87171' }}>{fmtVal(wastQty)}</td>
                        <td style={{ textAlign: 'right', color: '#a78bfa' }}>{fmtVal(staffQty)}</td>
                        <td style={{ textAlign: 'right', color: '#34d399' }}>{fmtVal(closeQty)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: used < 0 ? '#f87171' : '#c9a84c' }}>
                          {hasData ? fmtVal(used) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Print Sheet Tab */}
      {activeTab === 'print' && (
        <div>
          <div className="no-print" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <input
                style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 200 }}
                placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
              />
              <select
                style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
                value={filterCat} onChange={e => setFilterCat(e.target.value)}
              >
                <option value="all">All Categories</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" onClick={() => window.print()}>🖨 Print Sheet</button>
          </div>

          <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#c9a84c' }} className="no-print">
            System Ref Qty = Opening Stock + Purchases − Returns recorded this period. ★ marks high-value, fast-moving items — count these first and double-check the figures.
          </div>

          <div className="card print-sheet">
            <div className="print-sheet-header">
              <h2 style={{ margin: '0 0 2px', fontSize: 18, color: '#e8e0d0' }}>Physical Stock Count Sheet</h2>
              <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
                Period: {periodLabel} &nbsp;·&nbsp; Printed: {new Date().toLocaleDateString('en-GB')}
              </p>
            </div>

            {(() => {
              const flagged = getHighValueFlags()
              const grouped = categories
                .map(c => ({ category: c, catItems: visible.filter(i => i.category_id === c.id) }))
                .filter(g => g.catItems.length > 0)
              const uncategorized = visible.filter(i => !i.category_id)
              if (uncategorized.length > 0) grouped.push({ category: { id: 'none', name: 'Uncategorized' }, catItems: uncategorized })
              if (grouped.length === 0) return <p style={{ color: '#6b7280', fontSize: 13 }}>No items match the current filters.</p>
              return grouped.map(({ category, catItems }) => (
                <div key={category.id} className="print-sheet-section">
                  <h3 className="print-sheet-cat">{category.name}</h3>
                  <table className="data-table print-sheet-table">
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}><Tip text="High-value, fast-moving items. Count these first — errors here have the biggest financial impact." width={220}>★</Tip></th>
                        <th>Item</th>
                        <th>UOM</th>
                        <th style={{ textAlign: 'right' }}><Tip text="Opening Stock + Purchases − Returns recorded this period. Use as a reference — your physical count may differ due to usage or shrinkage." width={250}>System Ref Qty</Tip></th>
                        <th style={{ textAlign: 'right' }}>Physical Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catItems.map(item => (
                        <tr key={item.id}>
                          <td style={{ textAlign: 'center', color: '#c9a84c' }}>{flagged.has(item.id) ? '★' : ''}</td>
                          <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{item.name}</td>
                          <td style={{ color: '#6b7280' }}>{item.uom}</td>
                          <td style={{ textAlign: 'right' }}>{Number(getSystemRefQty(item.id)).toLocaleString()}</td>
                          <td className="print-sheet-blank"></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            })()}
          </div>
        </div>
      )}

      {activeTab !== 'summary' && activeTab !== 'print' && (
        <>
          <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#c9a84c' }}>
            {TABS.find(t => t.id === activeTab)?.desc} — enter quantities in the item's UOM, then click Save All.
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <input
                style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 200 }}
                placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
              />
              <select
                style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
                value={filterCat} onChange={e => setFilterCat(e.target.value)}
              >
                <option value="all">All Categories</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }} onClick={clearAll} disabled={saveAllLoading || isLocked}>Clear All</button>
              <button className="btn btn-primary" onClick={saveAll} disabled={saveAllLoading || isLocked}>
                {saveAllLoading ? 'Saving…' : saved ? '✓ Saved' : 'Save All'}
              </button>
            </div>
          </div>

          <div className="card">
            {loading ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Category</th>
                      <th style={{ textAlign: 'right' }}>UOM</th>
                      <th style={{ textAlign: 'right', color: '#c9a84c' }}>
                        {activeTab === 'opening' ? 'Opening Qty' : activeTab === 'closing' ? 'Physical Count' : activeTab === 'staff_meal' ? 'Staff Meals Qty' : 'Wastage Qty'}
                      </th>
                      <th style={{ textAlign: 'right' }}>Purchased</th>
                      <th style={{ textAlign: 'right', color: '#f87171' }}>Returned</th>
                      <th style={{ textAlign: 'right', color: '#c9a84c' }}>
                        <Tip text="Qty entered × unit rate (per_uom_rate). Gives the NPR value of this item's stock entry." width={220}>Value (NPR)</Tip>
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map(item => {
                      const row = stockData[item.id] || {}
                      const fieldKey = activeTab === 'opening' ? 'opening' : activeTab === 'closing' ? 'closing' : activeTab === 'staff_meal' ? 'staff_meal' : 'wastage'
                      const val = row[fieldKey]
                      const isSaving = saving[item.id]
                      const returned = returns[item.id] || 0
                      const rate = parseFloat(item.per_uom_rate || 0)
                      const qty = parseFloat(val || 0)
                      const lineValue = rate > 0 && qty > 0 ? Math.round(qty * rate) : null
                      return (
                        <tr key={item.id}>
                          <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{item.name}</td>
                          <td><span className="badge badge-yellow">{item.categories?.name}</span></td>
                          <td style={{ textAlign: 'right', color: '#6b7280' }}>{item.uom}</td>
                          <td style={{ textAlign: 'right', width: 140 }}>
                            <input
                              type="number" min="0"
                              value={val === '' ? '' : val}
                              onChange={e => updateField(item.id, fieldKey, e.target.value)}
                              onBlur={() => saveRow(item.id)}
                              placeholder="0"
                              disabled={isLocked}
                              style={{
                                background: '#0f1117', border: '1px solid #2a2f3d',
                                borderRadius: 5, padding: '6px 10px', fontSize: 13,
                                color: '#e8e0d0', outline: 'none', width: 110,
                                textAlign: 'right',
                                borderColor: val > 0 ? 'rgba(201,168,76,0.4)' : '#2a2f3d'
                              }}
                            />
                          </td>
                          <td style={{ textAlign: 'right', color: '#6b7280', fontSize: 13 }}>
                            {purchases[item.id] ? `${Number(purchases[item.id]).toLocaleString()} ${item.uom}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', color: returned > 0 ? '#f87171' : '#9ca3af', fontSize: 13 }}>
                            {returned > 0 ? `−${Number(returned).toLocaleString()} ${item.uom}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', color: '#c9a84c', fontSize: 13, fontWeight: lineValue ? 600 : 400 }}>
                            {lineValue != null ? `NPR ${lineValue.toLocaleString('en-NP')}` : '—'}
                          </td>
                          <td style={{ width: 40, textAlign: 'center' }}>
                            {isSaving && <span style={{ fontSize: 11, color: '#6b7280' }}>…</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
