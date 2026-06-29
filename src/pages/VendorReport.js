import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function VendorReport() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [returns, setReturns] = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('summary')
  const [vendorSearch, setVendorSearch] = useState('')
  const [showVendorDrop, setShowVendorDrop] = useState(false)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: v }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('vendors').select('*').eq('client_id', effectiveClientId).eq('is_active', true).order('name')
    ])
    setPeriods(p || [])
    setVendors(v || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await loadData(open.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadData(periodId)
    setLoading(false)
  }

  async function loadData(periodId) {
    const [{ data: p }, { data: r }] = await Promise.all([
      supabase.from('purchase_entries').select('*, items(name, categories(name)), vendors(name), payment_method').eq('period_id', periodId).order('bs_day'),
      supabase.from('vendor_returns').select('*, items(name), vendors(name), payment_method').eq('period_id', periodId).order('bs_day')
    ])
    setPurchases(p || [])
    setReturns(r || [])
  }

  // Per-vendor discount: sum unique bill discounts attributed to each vendor
  const vendorDiscountMap = (() => {
    const seen = new Set()
    const map = {}
    purchases.forEach(e => {
      const disc = parseFloat(e.discount_amount) || 0
      if (disc <= 0) return
      const gid = e.purchase_group_id || `${e.vendor_id}|${e.invoice_ref || ''}|${e.bs_day}`
      if (seen.has(gid)) return
      seen.add(gid)
      const vid = e.vendor_id || '__none__'
      map[vid] = (map[vid] || 0) + disc
    })
    return map
  })()

  // Vendor summary — net spend (ex-VAT, after discount and returns)
  const vendorSummary = vendors.map(vendor => {
    const vPurchases  = purchases.filter(p => p.vendor_id === vendor.id)
    const vReturns    = returns.filter(r => r.vendor_id === vendor.id)
    const gross       = vPurchases.reduce((s, p) => s + p.qty * p.rate, 0)
    const discount    = vendorDiscountMap[vendor.id] || 0
    const returned    = vReturns.reduce((s, r) => s + r.qty * r.rate, 0)
    const net         = gross - discount - returned
    const count       = vPurchases.length
    const returnCount = vReturns.length
    const days        = [...new Set(vPurchases.map(p => p.bs_day))].length
    const cash    = vPurchases.filter(p => p.payment_method === 'Cash').reduce((s, p) => s + p.qty * p.rate, 0)
      - vReturns.filter(r => r.payment_method === 'Cash').reduce((s, r) => s + r.qty * r.rate, 0)
    const credit  = vPurchases.filter(p => p.payment_method === 'Credit').reduce((s, p) => s + p.qty * p.rate, 0)
      - vReturns.filter(r => r.payment_method === 'Credit').reduce((s, r) => s + r.qty * r.rate, 0)
    const fonepay = vPurchases.filter(p => p.payment_method === 'FonePay').reduce((s, p) => s + p.qty * p.rate, 0)
      - vReturns.filter(r => r.payment_method === 'FonePay').reduce((s, r) => s + r.qty * r.rate, 0)
    return { vendor, gross, discount, returned, net, count, returnCount, days, cash, credit, fonepay }
  }).filter(r => r.gross > 0 || r.returned > 0)

  const unassigned = purchases.filter(p => !p.vendor_id)
  const unassignedTotal = unassigned.reduce((s, p) => s + p.qty * p.rate, 0)

  const grandGross    = purchases.reduce((s, p) => s + p.qty * p.rate, 0)
  const grandDiscount = Object.values(vendorDiscountMap).reduce((s, d) => s + d, 0)
  const grandReturn   = returns.reduce((s, r) => s + r.qty * r.rate, 0)
  const grandNet      = grandGross - grandDiscount - grandReturn

  const allDays = [...new Set([...purchases.map(p => p.bs_day), ...returns.map(r => r.bs_day)])].sort((a, b) => a - b)
  const activeVendors = vendors.filter(v => purchases.some(p => p.vendor_id === v.id))

  // Discount Received — one row per bill that has a discount
  const discountedBills = (() => {
    const seen = new Set()
    const bills = []
    purchases.forEach(e => {
      const disc = parseFloat(e.discount_amount) || 0
      if (disc <= 0) return
      const gid = e.purchase_group_id || `${e.vendor_id}|${e.invoice_ref || ''}|${e.bs_day}`
      if (seen.has(gid)) return
      seen.add(gid)
      const billEntries = purchases.filter(p =>
        (p.purchase_group_id || `${p.vendor_id}|${p.invoice_ref || ''}|${p.bs_day}`) === gid
      )
      const billTotal   = billEntries.reduce((s, p) => s + p.qty * p.rate, 0)
      const vatSubtotal = billEntries.filter(p => p.vat_inclusive).reduce((s, p) => s + p.qty * p.rate, 0)
      const vatTaxable  = billTotal > 0 ? vatSubtotal * (1 - disc / billTotal) : 0
      const vat         = vatTaxable * 0.13
      bills.push({
        day: e.bs_day, vendor: e.vendors?.name || 'Unknown', vendor_id: e.vendor_id,
        invoice: e.invoice_ref, billTotal, discount: disc,
        discPct: billTotal > 0 ? (disc / billTotal) * 100 : 0,
        vat, grand: (billTotal - disc) + vat,
        paymentMethod: e.payment_method,
      })
    })
    return bills.sort((a, b) => a.day - b.day)
  })()

  const vendorDiscountRows = (() => {
    const map = {}
    discountedBills.forEach(b => {
      const k = b.vendor_id || '__unknown__'
      if (!map[k]) map[k] = { name: b.vendor, count: 0, totalDiscount: 0, totalGross: 0 }
      map[k].count++
      map[k].totalDiscount += b.discount
      map[k].totalGross   += b.billTotal
    })
    return Object.values(map).sort((a, b) => b.totalDiscount - a.totalDiscount)
  })()

  const searchLower = vendorSearch.toLowerCase()
  const filteredSummary = vendorSearch
    ? vendorSummary.filter(r =>
        r.vendor.name.toLowerCase().includes(searchLower) ||
        (r.vendor.vendor_code || '').toLowerCase().includes(searchLower)
      )
    : vendorSummary
  const filteredActiveVendors = vendorSearch
    ? activeVendors.filter(v =>
        v.name.toLowerCase().includes(searchLower) ||
        (v.vendor_code || '').toLowerCase().includes(searchLower)
      )
    : activeVendors

  function vendorDayNet(vendorId, day) {
    const gross = purchases.filter(p => p.vendor_id === vendorId && p.bs_day === day).reduce((s, p) => s + p.qty * p.rate, 0)
    const ret   = returns.filter(r => r.vendor_id === vendorId && r.bs_day === day).reduce((s, r) => s + r.qty * r.rate, 0)
    return gross - ret
  }

  function dayNet(day) {
    const gross = purchases.filter(p => p.bs_day === day).reduce((s, p) => s + p.qty * p.rate, 0)
    const ret   = returns.filter(r => r.bs_day === day).reduce((s, r) => s + r.qty * r.rate, 0)
    return gross - ret
  }

  function vendorNet(vendorId) {
    const gross = purchases.filter(p => p.vendor_id === vendorId).reduce((s, p) => s + p.qty * p.rate, 0)
    const ret   = returns.filter(r => r.vendor_id === vendorId).reduce((s, r) => s + r.qty * r.rate, 0)
    return gross - ret
  }

  function fmt(val) {
    return val !== 0 ? `NPR ${Number(val.toFixed(0)).toLocaleString('en-NP')}` : '—'
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    const summaryData = vendorSummary.map(r => ({
      'Vendor': r.vendor.name,
      'Transactions': r.count,
      'Days Active': r.days,
      'Gross Purchases (NPR)': r.gross.toFixed(0),
      'Discount Received (NPR)': r.discount > 0 ? (-r.discount).toFixed(0) : 0,
      'Returns (NPR)': r.returned.toFixed(0),
      'Net Spend (NPR)': r.net.toFixed(0),
      '% of Net Total': grandNet > 0 ? ((r.net / grandNet) * 100).toFixed(1) + '%' : '0%'
    }))
    if (unassignedTotal > 0) summaryData.push({
      'Vendor': 'Unassigned', 'Transactions': unassigned.length,
      'Days Active': [...new Set(unassigned.map(p => p.bs_day))].length,
      'Gross Purchases (NPR)': unassignedTotal.toFixed(0), 'Returns (NPR)': '0',
      'Net Spend (NPR)': unassignedTotal.toFixed(0),
      '% of Net Total': grandNet > 0 ? ((unassignedTotal / grandNet) * 100).toFixed(1) + '%' : '0%'
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), 'Vendor Summary')
    const dailyData = allDays.map(day => {
      const row = { 'Day': day }
      activeVendors.forEach(v => { const val = vendorDayNet(v.id, day); row[v.name] = val !== 0 ? val.toFixed(0) : '' })
      row['Day Net Total (NPR)'] = dayNet(day).toFixed(0)
      return row
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dailyData), 'Daily Breakdown')
    if (discountedBills.length > 0) {
      const discData = discountedBills.map(b => ({
        'Day': b.day, 'Vendor': b.vendor, 'Invoice Ref': b.invoice || '',
        'Bill Total (ex-VAT)': Number(b.billTotal.toFixed(2)),
        'Discount (NPR)': Number(b.discount.toFixed(2)),
        'Discount %': Number(b.discPct.toFixed(2)),
        'VAT on Taxable (13%)': Number(b.vat.toFixed(2)),
        'Grand Total (incl. VAT)': Number(b.grand.toFixed(2)),
        'Payment Method': b.paymentMethod || '',
      }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(discData), 'Discounts Received')
    }
    XLSX.writeFile(wb, `Vendor-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Vendor Purchase Report</h1>
          <p className="page-subtitle">Net spend by supplier (gross purchases − returns) — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={exportExcel}>⬇ Export Excel</button>
        </div>
      </div>

      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5,1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Gross Purchases</div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandGross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Returns</div>
          <div className="stat-value" style={{ fontSize: 17, color: grandReturn > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
            {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Spend</div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active Vendors</div>
          <div className="stat-value">{vendorSummary.length}</div>
          <div className="stat-sub">With purchases this period</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Days with Purchases</div>
          <div className="stat-value">{allDays.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Total trade/promo discounts received from vendors this period across all bills." width={240}>Discounts Received</Tip></div>
          <div className="stat-value" style={{ fontSize: 17, color: grandDiscount > 0 ? 'var(--theme-green)' : 'var(--theme-text2)' }}>
            {grandDiscount > 0 ? `NPR ${grandDiscount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
          </div>
          {grandDiscount > 0 && <div className="stat-sub">{discountedBills.length} bill{discountedBills.length !== 1 ? 's' : ''}</div>}
        </div>
      </div>

      {/* Visual spend split */}
      {grandNet > 0 && vendorSummary.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10 }}>Vendor Net Spend Split</div>
          <div style={{ display: 'flex', height: 18, borderRadius: 6, overflow: 'hidden', gap: 2 }}>
            {vendorSummary.map((r, i) => {
              const pct = (r.net / grandNet) * 100
              const colors = ['var(--theme-accent)','var(--theme-green)','#60a5fa','var(--theme-red)','#a78bfa','#fb923c','#22d3ee','#f472b6']
              return (
                <div key={r.vendor.id} style={{ width: `${pct}%`, background: colors[i % colors.length], minWidth: 2 }} />
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            {vendorSummary.map((r, i) => {
              const pct = (r.net / grandNet) * 100
              const colors = ['var(--theme-accent)','var(--theme-green)','#60a5fa','var(--theme-red)','#a78bfa','#fb923c','#22d3ee','#f472b6']
              return (
                <div key={r.vendor.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: colors[i % colors.length], flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{r.vendor.name}</span>
                  <span style={{ fontSize: 11, color: colors[i % colors.length], fontWeight: 700 }}>{pct.toFixed(1)}%</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Vendor search — combobox */}
      <div style={{ marginBottom: 16, position: 'relative', width: 300 }}>
        <div style={{ position: 'relative' }}>
          <input
            value={vendorSearch}
            onChange={e => { setVendorSearch(e.target.value); setShowVendorDrop(true) }}
            onFocus={() => setShowVendorDrop(true)}
            onBlur={() => setTimeout(() => setShowVendorDrop(false), 150)}
            placeholder="Search or select a vendor…"
            style={{
              background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6,
              padding: '8px 32px 8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', boxSizing: 'border-box'
            }}
          />
          {vendorSearch ? (
            <button onClick={() => { setVendorSearch(''); setShowVendorDrop(false) }} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text3)', fontSize: 14, lineHeight: 1, padding: 2 }}>×</button>
          ) : (
            <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--theme-text3)', fontSize: 10, pointerEvents: 'none' }}>▼</span>
          )}
        </div>
        {showVendorDrop && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, marginTop: 4, zIndex: 100, maxHeight: 220, overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.3)' }}>
            {vendorSearch && (
              <div
                onMouseDown={() => { setVendorSearch(''); setShowVendorDrop(false) }}
                style={{ padding: '8px 12px', fontSize: 12, color: 'var(--theme-text3)', cursor: 'pointer', borderBottom: '1px solid var(--theme-border-lt)' }}
              >
                Show all vendors
              </div>
            )}
            {vendorSummary
              .filter(r => !vendorSearch || r.vendor.name.toLowerCase().includes(vendorSearch.toLowerCase()) || (r.vendor.vendor_code || '').toLowerCase().includes(vendorSearch.toLowerCase()))
              .map(r => (
                <div
                  key={r.vendor.id}
                  onMouseDown={() => { setVendorSearch(r.vendor.name); setShowVendorDrop(false) }}
                  style={{ padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer', borderBottom: '1px solid var(--theme-border-lt)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {r.vendor.vendor_code && <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--theme-accent)', marginRight: 8 }}>{r.vendor.vendor_code}</span>}
                  {r.vendor.name}
                  <span style={{ float: 'right', fontSize: 11, color: 'var(--theme-text3)' }}>NPR {r.net.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</span>
                </div>
              ))
            }
            {vendorSummary.filter(r => !vendorSearch || r.vendor.name.toLowerCase().includes(vendorSearch.toLowerCase()) || (r.vendor.vendor_code || '').toLowerCase().includes(vendorSearch.toLowerCase())).length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--theme-text3)' }}>No vendors matched</div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--theme-border)' }}>
        {[['summary', 'Vendor Summary'], ['daily', 'Daily Breakdown'], ['discounts', 'Discounts Received']].map(([m, label]) => (
          <button key={m} onClick={() => setViewMode(m)} style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '10px 20px', fontSize: 13, fontWeight: 500,
            color: viewMode === m ? 'var(--theme-accent)' : 'var(--theme-text2)',
            borderBottom: viewMode === m ? '2px solid var(--theme-accent)' : '2px solid transparent', marginBottom: -1
          }}>{label}</button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : purchases.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">No purchases recorded for this period yet.</p>
          </div>
        ) : viewMode === 'summary' ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th style={{ textAlign: 'right' }}>Transactions</th>
                  <th style={{ textAlign: 'right' }}>Gross Purchases</th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-green)' }}><Tip text="Trade/promo discount received from this vendor — deducted from net spend." width={230}>Discount</Tip></th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}><Tip text="Total value of items returned to this vendor this period.">Returns</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net spend = Gross − Discount − Returns (ex-VAT). Your true cost obligation to this vendor." width={250}>Net Spend</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="This vendor's share of total net purchase spend for the period." width={220}>% of Net Total</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Average daily spend (net) across days this vendor had deliveries.">Avg/Day</Tip></th>
                  <th style={{ textAlign: 'right' }}>Cash (Net)</th>
                  <th style={{ textAlign: 'right' }}>Credit (Net)</th>
                  <th style={{ textAlign: 'right' }}>FonePay (Net)</th>
                </tr>
              </thead>
              <tbody>
                {filteredSummary.sort((a, b) => b.net - a.net).map(r => {
                  const pct = grandNet > 0 ? (r.net / grandNet) * 100 : 0
                  return (
                    <tr key={r.vendor.id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {r.vendor.vendor_code && (
                          <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--theme-accent)', marginRight: 8 }}>{r.vendor.vendor_code}</span>
                        )}
                        {r.vendor.name}
                        {r.returnCount > 0 && <span style={{ fontSize: 11, color: 'var(--theme-red)', marginLeft: 6 }}>({r.returnCount} return{r.returnCount > 1 ? 's' : ''})</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.count}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>NPR {r.gross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green)', fontWeight: r.discount > 0 ? 600 : 400 }}>{r.discount > 0 ? `−NPR ${r.discount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>{r.returned > 0 ? `−NPR ${r.returned.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)' }}>NPR {r.net.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                          <div style={{ width: 70, height: 5, background: 'var(--theme-border)', borderRadius: 3 }}>
                            <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: 'var(--theme-accent)', borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--theme-text2)', minWidth: 38 }}>{pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                        NPR {r.days > 0 ? (r.net / r.days).toLocaleString('en-NP', { maximumFractionDigits: 0 }) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: r.cash > 0 ? 'var(--theme-green)' : 'var(--theme-text3)' }}>{fmt(r.cash)}</td>
                      <td style={{ textAlign: 'right', color: r.credit > 0 ? 'var(--theme-red)' : 'var(--theme-text3)' }}>{fmt(r.credit)}</td>
                      <td style={{ textAlign: 'right', color: r.fonepay > 0 ? '#60a5fa' : 'var(--theme-text3)' }}>{fmt(r.fonepay)}</td>
                    </tr>
                  )
                })}
                {unassignedTotal > 0 && (
                  <tr>
                    <td style={{ color: 'var(--theme-text3)', fontStyle: 'italic' }}>Unassigned</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{unassigned.length}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>NPR {unassignedTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                    <td colSpan={8}></td>
                  </tr>
                )}
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 12 }}>TOTAL</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>{purchases.length}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 12 }}>NPR {grandGross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green)', paddingTop: 12 }}>{grandDiscount > 0 ? `−NPR ${grandDiscount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', paddingTop: 12 }}>{grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>100%</td>
                  <td colSpan={4}></td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : viewMode === 'daily' ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Day</th>
                  {filteredActiveVendors.map(v => <th key={v.id} style={{ textAlign: 'right' }}>{v.name}</th>)}
                  <th style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>Day Net Total</th>
                </tr>
              </thead>
              <tbody>
                {allDays.map(day => {
                  const dn = dayNet(day)
                  return (
                    <tr key={day}>
                      <td style={{ fontWeight: 700, color: 'var(--theme-accent)' }}>{day}</td>
                      {filteredActiveVendors.map(v => {
                        const val = vendorDayNet(v.id, day)
                        return (
                          <td key={v.id} style={{ textAlign: 'right', color: val !== 0 ? 'var(--theme-text1)' : 'var(--theme-border)' }}>
                            {val !== 0 ? val.toLocaleString('en-NP', { maximumFractionDigits: 0 }) : '—'}
                          </td>
                        )
                      })}
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)' }}>
                        NPR {dn.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                  )
                })}
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 12 }}>TOTAL</td>
                  {filteredActiveVendors.map(v => (
                    <td key={v.id} style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 12 }}>
                      NPR {vendorNet(v.id).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                    </td>
                  ))}
                  <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>
                    NPR {grandNet.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          /* ── DISCOUNTS TAB ── */
          discountedBills.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">%</div>
              <p className="empty-state-text">No bills with discounts recorded this period.</p>
            </div>
          ) : (
            <>
              {/* Vendor discount summary */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>By Vendor</div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Vendor</th>
                        <th style={{ textAlign: 'right' }}><Tip text="Number of bills from this vendor that included a trade discount."># Discounted Bills</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Total ex-VAT list price of all discounted bills from this vendor.">Bill Total (ex-VAT)</Tip></th>
                        <th style={{ textAlign: 'right', color: 'var(--theme-green)' }}><Tip text="Total discount amount received from this vendor across all bills.">Discount Received</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Average discount rate = Total Discount ÷ Bill Total × 100." width={220}>Avg Disc %</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorDiscountRows.map((v, i) => (
                        <tr key={i}>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.count}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {v.totalGross.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-green)', fontWeight: 700 }}>NPR {v.totalDiscount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.totalGross > 0 ? ((v.totalDiscount / v.totalGross) * 100).toFixed(1) : '0'}%</td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>TOTAL</td>
                        <td style={{ textAlign: 'right' }}>{discountedBills.length}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {discountedBills.reduce((s, b) => s + b.billTotal, 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green)' }}>NPR {grandDiscount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                          {discountedBills.reduce((s, b) => s + b.billTotal, 0) > 0
                            ? ((grandDiscount / discountedBills.reduce((s, b) => s + b.billTotal, 0)) * 100).toFixed(1)
                            : '0'}%
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Bill-level detail */}
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Bill Detail</div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Vendor</th>
                      <th>Invoice</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Sum of qty × rate for all items on the bill, before discount and VAT.">Bill Total (ex-VAT)</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-green)' }}><Tip text="Trade/promo discount amount as shown on the vendor invoice.">Discount</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Discount as a percentage of the bill total ex-VAT.">Disc %</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-amber)' }}><Tip text="VAT computed on the taxable base (bill total minus discount), per Nepal IRD." width={250}>VAT (13%)</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Grand Total = (Bill Total − Discount) + VAT on taxable amount." width={230}>Grand Total</Tip></th>
                      <th>Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discountedBills.map((b, i) => (
                      <tr key={i}>
                        <td style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>{b.day}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{b.vendor}</td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{b.invoice || '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {b.billTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green)', fontWeight: 700 }}>NPR {b.discount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{b.discPct.toFixed(1)}%</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-amber)' }}>{b.vat > 0 ? `NPR ${b.vat.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 700 }}>NPR {b.grand.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                        <td><span className={`badge ${b.paymentMethod === 'Cash' ? 'badge-green' : b.paymentMethod === 'Credit' ? 'badge-red' : 'badge-gray'}`}>{b.paymentMethod || '—'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )
        )}
      </div>
    </div>
  )
}
