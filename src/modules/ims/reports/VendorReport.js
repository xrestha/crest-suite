import { Fragment, useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import { bsToAd } from '../../../utils/bsCalendar'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const EPS = 0.001

function billAging(days) {
  if (days <= 30) return { label: 'Current',    color: 'var(--theme-green)' }
  if (days <= 60) return { label: '31–60 days', color: 'var(--theme-accent)' }
  if (days <= 90) return { label: '61–90 days', color: 'var(--theme-amber)' }
  return                 { label: '90+ days',   color: 'var(--theme-red)' }
}

// Vendor split needs up to 8 distinct hues for an arbitrary vendor count — reuses theme tokens
// where available (accent/green/red/purple) and falls back to fixed hex for the rest, same
// reasoning as a chart legend needing more distinct colors than the semantic token set provides.
const VENDOR_SPLIT_COLORS = ['var(--theme-accent)','var(--theme-green)','#60a5fa','var(--theme-red)','var(--theme-purple)','#fb923c','#22d3ee','#f472b6']

export default function VendorReport() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [returns, setReturns] = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState('summary')
  const [vendorSearch, setVendorSearch] = useState('')
  const [showVendorDrop, setShowVendorDrop] = useState(false)
  const [paymentsMap, setPaymentsMap] = useState({})
  const [drilldownVendor, setDrilldownVendor] = useState(null)
  const [drilldownDay, setDrilldownDay] = useState(null)
  const [expandedBillKey, setExpandedBillKey] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: v }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('vendors').eq('is_active', true).order('name')
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
      scopedFrom('vendor_returns', '*, items(name), vendors(name), payment_method').eq('period_id', periodId).order('bs_day')
    ])
    setPurchases(p || [])
    setReturns(r || [])

    const creditIds = (p || []).filter(e => e.payment_method === 'Credit').map(e => e.id)
    if (creditIds.length > 0) {
      const { data: pmts } = await scopedFrom('payable_payments').in('purchase_entry_id', creditIds)
      const map = {}
      ;(pmts || []).forEach(pm => {
        if (!map[pm.purchase_entry_id]) map[pm.purchase_entry_id] = []
        map[pm.purchase_entry_id].push(pm)
      })
      setPaymentsMap(map)
    } else {
      setPaymentsMap({})
    }
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

  // Bill-level drilldown — one row per bill (vendor + invoice + day), any payment method,
  // with a payment status: Cash/FonePay settle immediately, Credit follows payable_payments/aging.
  const allBills = (() => {
    const seen = new Set()
    const bills = []
    purchases.forEach(e => {
      const gid = e.purchase_group_id || `${e.vendor_id}|${e.invoice_ref || ''}|${e.bs_day}`
      if (seen.has(gid)) return
      seen.add(gid)
      const billEntries = purchases.filter(p =>
        (p.purchase_group_id || `${p.vendor_id}|${p.invoice_ref || ''}|${p.bs_day}`) === gid
      )
      const total = billEntries.reduce((s, p) => s + p.qty * p.rate, 0)
      const disc  = Math.max(0, ...billEntries.map(p => parseFloat(p.discount_amount) || 0))
      const billReturns = returns.filter(r => billEntries.some(p => p.id === r.purchase_entry_id))
      const returnedAmt = billReturns.reduce((s, r) => s + r.qty * r.rate, 0)
      const net = total - disc - returnedAmt
      const paymentMethod = e.payment_method || 'Cash'

      let status, remaining = 0
      if (paymentMethod !== 'Credit') {
        status = { label: 'Paid', color: 'var(--theme-green)' }
      } else {
        const paid = billEntries.reduce((s, p) =>
          s + (paymentsMap[p.id] || []).reduce((s2, pm) => s2 + parseFloat(pm.amount), 0), 0)
        remaining = Math.max(0, total - paid)
        if (remaining <= EPS) status = { label: 'Paid', color: 'var(--theme-green)' }
        else if (paid > EPS) status = { label: 'Partial', color: 'var(--theme-purple)' }
        else if (selectedPeriod) {
          const adDate = bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, e.bs_day || 1)
          const daysOld = Math.max(0, Math.floor((new Date() - adDate) / (1000 * 60 * 60 * 24)))
          status = billAging(daysOld)
        } else {
          status = { label: 'Outstanding', color: 'var(--theme-red)' }
        }
      }

      const payments = billEntries.flatMap(p => paymentsMap[p.id] || []).sort((x, y) => (x.paid_at > y.paid_at ? 1 : -1))

      bills.push({
        key: gid, vendor_id: e.vendor_id, vendorName: e.vendors?.name || 'Unassigned',
        day: e.bs_day, invoice: e.invoice_ref, itemCount: billEntries.length,
        total, discount: disc, returned: returnedAmt, net, paymentMethod, status, remaining,
        entries: billEntries, billReturns, payments,
      })
    })
    return bills.sort((a, b) => a.day - b.day)
  })()

  const drilldownBills = drilldownVendor
    ? allBills.filter(b => b.vendor_id === drilldownVendor.id && (drilldownDay == null || b.day === drilldownDay))
    : []
  const drilldownOutstanding = drilldownBills.reduce((s, b) => s + b.remaining, 0)

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
  // A search narrowed to exactly one vendor switches Daily Breakdown into a
  // per-vendor view: blank days dropped, each day drills into its bill(s).
  const singleVendor = vendorSearch && filteredActiveVendors.length === 1 ? filteredActiveVendors[0] : null
  const singleVendorDays = singleVendor ? allDays.filter(day => vendorDayNet(singleVendor.id, day) !== 0) : []

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

  function openVendorDrilldown(vendor, day = null) {
    setDrilldownVendor(vendor)
    setDrilldownDay(day)
    setExpandedBillKey(null)
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
              const colors = VENDOR_SPLIT_COLORS
              return (
                <div key={r.vendor.id} style={{ width: `${pct}%`, background: colors[i % colors.length], minWidth: 2 }} />
              )
            })}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            {vendorSummary.map((r, i) => {
              const pct = (r.net / grandNet) * 100
              const colors = VENDOR_SPLIT_COLORS
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
            <button onClick={() => { setVendorSearch(''); setShowVendorDrop(false) }} aria-label="Clear vendor search" style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-text3)', fontSize: 14, lineHeight: 1, padding: 8 }}>×</button>
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
                        <span
                          onClick={() => openVendorDrilldown(r.vendor)}
                          title="View purchase bills"
                          style={{ cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                          onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                        >
                          {r.vendor.vendor_code && (
                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--theme-accent)', marginRight: 8 }}>{r.vendor.vendor_code}</span>
                          )}
                          {r.vendor.name}
                        </span>
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
                      <td style={{ textAlign: 'right', color: r.fonepay > 0 ? 'var(--theme-purple)' : 'var(--theme-text3)' }}>{fmt(r.fonepay)}</td>
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
          singleVendor ? (
            singleVendorDays.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">⊙</div>
                <p className="empty-state-text">No purchases from {singleVendor.name} this period.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th style={{ textAlign: 'right' }}>{singleVendor.name}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {singleVendorDays.map(day => {
                      const val = vendorDayNet(singleVendor.id, day)
                      return (
                        <tr
                          key={day}
                          style={{ cursor: 'pointer' }}
                          onClick={() => openVendorDrilldown(singleVendor, day)}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--theme-table-hover)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          title="View bill(s) for this day"
                        >
                          <td style={{ fontWeight: 700, color: 'var(--theme-accent)' }}>{day}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>
                            NPR {val.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                          </td>
                          <td style={{ color: 'var(--theme-text3)', fontSize: 12, whiteSpace: 'nowrap' }}>▸ View bill</td>
                        </tr>
                      )
                    })}
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 12 }}>TOTAL</td>
                      <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>
                        NPR {vendorNet(singleVendor.id).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                      </td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          ) : (
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
                            <td
                              key={v.id}
                              onClick={val !== 0 ? () => openVendorDrilldown(v, day) : undefined}
                              title={val !== 0 ? 'View bill(s) for this day' : undefined}
                              style={{ textAlign: 'right', color: val !== 0 ? 'var(--theme-text1)' : 'var(--theme-border)', cursor: val !== 0 ? 'pointer' : 'default' }}
                            >
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
          )
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

      {drilldownVendor && (
        <Modal
          title={`${drilldownVendor.name} — Purchase Bills${drilldownDay != null ? ` (Day ${drilldownDay})` : ''}`}
          onClose={() => { setDrilldownVendor(null); setDrilldownDay(null); setExpandedBillKey(null) }}
          maxWidth={900}
        >
          <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '-8px 0 14px' }}>
            {periodLabel}
            {drilldownDay != null && (
              <>
                {' · '}
                <span
                  onClick={() => setDrilldownDay(null)}
                  style={{ color: 'var(--theme-accent)', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Show all days
                </span>
              </>
            )}
          </p>
          {drilldownBills.length === 0 ? (
            <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>No bills recorded for this vendor this period.</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 20, marginBottom: 14, fontSize: 12, color: 'var(--theme-text2)' }}>
                <span>{drilldownBills.length} bill{drilldownBills.length !== 1 ? 's' : ''}</span>
                <span>Net: <strong style={{ color: 'var(--theme-accent)' }}>NPR {drilldownBills.reduce((s, b) => s + b.net, 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}</strong></span>
                {drilldownOutstanding > 0 && (
                  <span>Outstanding: <strong style={{ color: 'var(--theme-red)' }}>NPR {drilldownOutstanding.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</strong></span>
                )}
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Invoice</th>
                      <th style={{ textAlign: 'right' }}>Items</th>
                      <th>Payment</th>
                      <th style={{ textAlign: 'right' }}>Bill Total</th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-green)' }}>Discount</th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}>Returns</th>
                      <th style={{ textAlign: 'right' }}>Net</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {drilldownBills.map(b => {
                      const isExpanded = expandedBillKey === b.key
                      return (
                        <Fragment key={b.key}>
                          <tr style={{ cursor: 'pointer' }} onClick={() => setExpandedBillKey(prev => prev === b.key ? null : b.key)}>
                            <td style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>{b.day}</td>
                            <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{b.invoice || '—'}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{b.itemCount}</td>
                            <td><span className={`badge ${b.paymentMethod === 'Cash' ? 'badge-green' : b.paymentMethod === 'Credit' ? 'badge-red' : 'badge-gray'}`}>{b.paymentMethod}</span></td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {b.total.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-green)' }}>{b.discount > 0 ? `−NPR ${b.discount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>{b.returned > 0 ? `−NPR ${b.returned.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)' }}>NPR {b.net.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                            <td>
                              <span style={{ fontSize: 11, fontWeight: 700, color: b.status.color, background: `color-mix(in srgb, ${b.status.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${b.status.color} 40%, transparent)`, borderRadius: 4, padding: '2px 8px', whiteSpace: 'nowrap' }}>{b.status.label}</span>
                            </td>
                            <td style={{ color: 'var(--theme-text3)', fontSize: 12, whiteSpace: 'nowrap' }}>{isExpanded ? '▲ Hide' : '▼ Details'}</td>
                          </tr>

                          {isExpanded && (
                            <tr>
                              <td colSpan={9} style={{ padding: 0, background: 'var(--theme-bg)' }}>
                                <div style={{ padding: '16px 20px' }}>
                                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Items in this bill ({b.entries.length})</div>
                                  <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%', maxWidth: 620, marginBottom: b.payments.length > 0 || b.billReturns.length > 0 ? 20 : 0 }}>
                                    <thead>
                                      <tr>
                                        <th style={{ textAlign: 'left', padding: '4px 16px 4px 0', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Item</th>
                                        <th style={{ textAlign: 'right', padding: '4px 16px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Qty</th>
                                        <th style={{ textAlign: 'right', padding: '4px 16px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Rate</th>
                                        <th style={{ textAlign: 'right', padding: '4px 0 4px 16px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11 }}>Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {b.entries.map(e => (
                                        <tr key={e.id}>
                                          <td style={{ padding: '4px 16px 4px 0', color: 'var(--theme-text1)' }}>{e.items?.name}</td>
                                          <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(e.qty).toLocaleString()}</td>
                                          <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(e.rate).toLocaleString()}</td>
                                          <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>NPR {(e.qty * e.rate).toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>

                                  {b.billReturns.length > 0 && (
                                    <div style={{ marginBottom: b.payments.length > 0 ? 20 : 0 }}>
                                      <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Returns Against This Bill</div>
                                      <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 400 }}>
                                        <tbody>
                                          {b.billReturns.map(r => (
                                            <tr key={r.id}>
                                              <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text1)' }}>{r.items?.name}</td>
                                              <td style={{ padding: '5px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(r.qty).toLocaleString()}</td>
                                              <td style={{ padding: '5px 0 5px 16px', textAlign: 'right', color: 'var(--theme-red)', fontWeight: 600 }}>−NPR {(r.qty * r.rate).toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}

                                  {b.payments.length > 0 && (
                                    <div>
                                      <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Payment History</div>
                                      <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 400 }}>
                                        <tbody>
                                          {b.payments.map(p => (
                                            <tr key={p.id}>
                                              <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-green)' }}>{p.paid_at}</td>
                                              <td style={{ padding: '5px 16px', textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>NPR {parseFloat(p.amount).toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                                              <td style={{ padding: '5px 0 5px 16px', color: 'var(--theme-text3)' }}>{p.note || '—'}</td>
                                            </tr>
                                          ))}
                                          <tr style={{ borderTop: '1px solid var(--theme-border)' }}>
                                            <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)', fontSize: 11 }}>Total paid</td>
                                            <td style={{ padding: '5px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--theme-green)' }}>NPR {(b.total - b.remaining).toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                                            <td />
                                          </tr>
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
