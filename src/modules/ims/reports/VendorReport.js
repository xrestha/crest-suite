import { Fragment, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { calcBillTotals, methodOf } from '../purchases/purchasesHelpers'
import { allocateBillDiscounts } from './supplierAttribution'
import { netFactors, returnBase } from './purchaseTaxSplit'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import RowDisclosure from '../../../components/RowDisclosure'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import Modal from '../../../components/Modal'
import { BS_MONTHS, bsToAd, formatBsDay } from '../../../utils/bsCalendar'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

const EPS = 0.001

function billAging(days) {
  if (days <= 30) return { label: 'Current',    color: 'var(--theme-green-text)' }
  if (days <= 60) return { label: '31–60 days', color: 'var(--theme-accent-ink)' }
  if (days <= 90) return { label: '61–90 days', color: 'var(--theme-amber-text)' }
  return                 { label: '90+ days',   color: 'var(--theme-red-text)' }
}

// Vendor split needs up to 8 distinct hues for an arbitrary vendor count — a qualitative
// chart-series palette, not a semantic status colour.
//
// It used to mix theme tokens into that palette, which is the collision DESIGN.md warns about:
// --theme-accent and --theme-purple are the SAME hex on Dracula, Catppuccin Mocha and Latte, so
// slots 1 and 5 painted two different vendors identically on three of the ten presets (measured
// S551; Tokyo Night additionally put slots 1 and 3 at ΔE 6.4, and Catppuccin slots 4 and 8 at
// ΔE 5.7 under deuteranopia, both below the floor). Now the same fixed literal set
// ClientDashboard's CHART_COLORS uses — theme-independent on purpose, which is correct for a
// series palette and is NOT the undocumented-accent violation that rule is about.
const VENDOR_SPLIT_COLORS = ['#c9a84c', '#34d399', '#60a5fa', '#f87171', '#8b5cf6', '#ea580c', '#22d3ee', '#f472b6']

export default function VendorReport() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [purchases, setPurchases] = useState([])
  const [returns, setReturns] = useState([])
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
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
    setLoadError(null)
    const initResults = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      // Every vendor, ACTIVE OR NOT. This list is not a picker — it is the row set of a historical
      // report, and `.eq('is_active', true)` was the picker convention applied one file too far.
      // `vendorSummary` below already drops anything with no activity in the period, so an inactive
      // vendor only appears here if it genuinely has purchases or returns in the month being read.
      //
      // What it cost: the footer TOTAL, the four KPI cards and `% of Net Total` are all computed
      // over EVERY purchase row in the period, so a vendor deactivated mid-year had its spend in
      // the total with no row above it — the rows visibly failing to sum to their own footer, which
      // discredits the rows that were right (S594). S671's archive forces `is_active = false`, so
      // it turned an occasional divergence into the guaranteed outcome of using the feature.
      scopedFrom('vendors').order('name')
    ])
    // A failed read must never render as an empty period or NoPeriodState (S612 silent-zero rule).
    const initFailed = firstError(initResults)
    if (initFailed) { setLoadError(initFailed); setLoading(false); return }
    const [{ data: p }, { data: v }] = initResults
    setPeriods(p || [])
    setVendors(v || [])
    // Defaulting to the open period is not a default (S722, Payment Summary). Close the month and
    // `find` returns undefined — the page then selected nothing, loaded nothing, and still rendered
    // the whole stat grid at NPR 0 with a footer reading 100% and a period chip reading "—", over a
    // dropdown still listing every period. `periods` is ordered newest-first, so [0] is the month
    // just closed, which is the one an owner opens this page to reconcile.
    const target = (p || []).find(x => x.status === 'open') || (p || [])[0]
    if (target) {
      periodReq.begin(target.id)   // the auto-select claims the page too (S721): once ANY claim has
      setSelectedPeriod(target)    // been made the ref stops failing open, and an admin switching
      await loadData(target.id)    // client re-runs init() with the previous client's id in the ref
    }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadData(periodId)
    setLoading(false)
  }

  async function loadData(periodId) {
    setLoadError(null)
    const results = await Promise.all([
      fetchAllRows(() => supabase.from('purchase_entries').select('*, items(name, categories(name)), vendors(name), payment_method').eq('period_id', periodId).order('bs_day').order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', '*, items(name), vendors(name), payment_method').eq('period_id', periodId).order('bs_day').order('id'))
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must never flow through the `|| []`s below into a confident NPR-0 vendor
    // ledger (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setPurchases([]); setReturns([]); setPaymentsMap({}); return }
    const [{ data: p }, { data: r }] = results
    setPurchases(p || [])
    setReturns(r || [])

    const creditIds = (p || []).filter(e => methodOf(e) === 'Credit').map(e => e.id)
    if (creditIds.length > 0) {
      // Chunked AND paged (S723). `payable_payments` is one row per LINE per settlement, so it
      // grows faster than the bills it hangs off — a bare read truncates at 1000 with no error and
      // renders settled credit bills as unpaid, and the id list is a URL besides. Outstanding
      // Payables and Vendor Balance Confirmation both read this table the same way and were fixed;
      // this was the third page and it was still bare.
      const { data: pmts, error: pmtErr } = await fetchAllRowsChunked(creditIds, ids =>
        scopedFrom('payable_payments').in('purchase_entry_id', ids).order('id'))
      if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
      // Cash/Credit splits and the payment-status column derive from this map — refuse rather
      // than render every credit bill as unpaid (S612).
      if (pmtErr) { setLoadError(pmtErr.message); setPurchases([]); setReturns([]); setPaymentsMap({}); return }
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

  // One pass over purchases/returns into index maps. Everything below reads these — the old shape
  // re-filtered the full purchases array per vendor (eight passes each), per bill, and per CELL of
  // the Daily Breakdown matrix (days × vendors × entries — millions of element visits on every
  // keystroke of the vendor search box).
  const ix = useMemo(() => {
    const billKey = e => e.purchase_group_id || `${e.vendor_id}|${e.invoice_ref || ''}|${e.bs_day}`

    // ── The one definition of "net" on this page ──────────────────────────────
    // Every net figure the page prints — the summary column, the Daily Breakdown matrix, the
    // per-method columns, the drilldown and both Excel sheets — comes from these two lookups.
    //
    // They used to disagree. The maps below were built from a raw `qty * rate` with returns
    // subtracted and NO bill discount, while `vendorSummary` beside them computed
    // `gross - discount - returned`, and both were labelled "Net". One bill of 10,000 with a 1,000
    // trade discount read 9,000 on the Vendor Summary tab and 10,000 on the Daily Breakdown tab —
    // under a KPI card, still on screen, saying 9,000. That is the S551 defect class one tab apart.
    //
    // `allocateBillDiscounts` is the one way a bill-level discount reaches a line (S601): max not
    // sum, apportioned proportionally over the bill's own gross. `returnBase` credits a return at
    // its bill's DISCOUNTED rate (S722) — `vendor_returns.rate` stores the line's LIST rate, so
    // subtracting it from a base that has already lost the discount drives a fully-returned
    // discounted bill negative by exactly that discount. Returning all of the 10,000 bill above
    // used to leave this vendor at Net Spend −1,000; it nets to 0.
    const allocated = allocateBillDiscounts(purchases)
    const factors = netFactors(allocated)
    const netById = new Map(allocated.map(r => [r.id, r.lineNet]))
    const lineNetOf = p => {
      const v = netById.get(p.id)
      return v === undefined ? (parseFloat(p.qty) || 0) * (parseFloat(p.rate) || 0) : v
    }
    const retValueOf = r => returnBase(r, factors)

    const purByVendor = new Map()     // vendor_id (or null) -> purchase entries
    const retByVendor = new Map()
    const retByEntry = new Map()      // purchase_entry_id -> return rows
    const billMap = new Map()         // bill key -> entries, insertion order = first encounter
    const netByVendorDay = new Map()  // vendor_id -> Map(bs_day -> net)
    const netByDay = new Map()
    const netByVendor = new Map()
    const addNet = (vid, day, amt) => {
      netByDay.set(day, (netByDay.get(day) || 0) + amt)
      netByVendor.set(vid, (netByVendor.get(vid) || 0) + amt)
      let m = netByVendorDay.get(vid)
      if (!m) { m = new Map(); netByVendorDay.set(vid, m) }
      m.set(day, (m.get(day) || 0) + amt)
    }
    purchases.forEach(p => {
      const vid = p.vendor_id ?? null
      let list = purByVendor.get(vid)
      if (!list) { list = []; purByVendor.set(vid, list) }
      list.push(p)
      const gid = billKey(p)
      let bl = billMap.get(gid)
      if (!bl) { bl = []; billMap.set(gid, bl) }
      bl.push(p)
      addNet(vid, p.bs_day, lineNetOf(p))
    })
    returns.forEach(r => {
      const vid = r.vendor_id ?? null
      let list = retByVendor.get(vid)
      if (!list) { list = []; retByVendor.set(vid, list) }
      list.push(r)
      if (r.purchase_entry_id != null) {
        let l = retByEntry.get(r.purchase_entry_id)
        if (!l) { l = []; retByEntry.set(r.purchase_entry_id, l) }
        l.push(r)
      }
      addNet(vid, r.bs_day, -retValueOf(r))
    })
    return { billKey, lineNetOf, retValueOf, purByVendor, retByVendor, retByEntry, billMap, netByVendorDay, netByDay, netByVendor }
  }, [purchases, returns])

  // (`vendorDiscountMap` lived here — a second, independent per-vendor discount rollup. Every
  // consumer now derives its discount as `gross - allocatedNet`, so the Discount column, the Net
  // Spend beside it and the Daily Breakdown behind it are one arithmetic rather than three.)

  // Vendor summary — net spend (ex-VAT, after discount and returns)
  const vendorSummary = useMemo(() => vendors.map(vendor => {
    const vPurchases  = ix.purByVendor.get(vendor.id) || []
    const vReturns    = ix.retByVendor.get(vendor.id) || []
    const gross       = vPurchases.reduce((s, p) => s + p.qty * p.rate, 0)
    const netPurch    = vPurchases.reduce((s, p) => s + ix.lineNetOf(p), 0)
    // Derived from the allocation rather than read from a parallel map, so the Discount column and
    // the Net Spend beside it can never be computed two different ways. They are equal for every
    // ordinary bill; they diverge only on a degenerate one (every line free, a discount recorded
    // against it), where the allocation's answer — nothing to discount — is the right one and the
    // parallel map's was a negative net spend conjured out of a zero-value bill.
    const discount    = gross - netPurch
    const returned    = vReturns.reduce((s, r) => s + ix.retValueOf(r), 0)
    const net         = netPurch - returned
    const count       = vPurchases.length
    const returnCount = vReturns.length
    const days        = [...new Set(vPurchases.map(p => p.bs_day))].length
    // `methodOf`, not the raw column: NULL is Cash everywhere else in the product (S650), and a
    // raw test put every bill written before that column existed into NONE of these three, so the
    // trio could not sum to the Net Spend two cells to its left. Net of the allocated discount for
    // the same reason — the header says "(Net)".
    const byMethod = m =>
      vPurchases.filter(p => methodOf(p) === m).reduce((s, p) => s + ix.lineNetOf(p), 0)
      - vReturns.filter(r => methodOf(r) === m).reduce((s, r) => s + ix.retValueOf(r), 0)
    const cash    = byMethod('Cash')
    const credit  = byMethod('Credit')
    const fonepay = byMethod('FonePay')
    return { vendor, gross, discount, returned, net, count, returnCount, days, cash, credit, fonepay }
  }).filter(r => r.gross > 0 || r.returned > 0), [vendors, ix])

  // A bill with no vendor is still a bill, and it used to appear as a count and a gross with
  // `colSpan={8}` swallowing its discount, returns and net — while the footer counted all three.
  // It gets the same shape as a vendor row now, so the column can be added up on screen.
  const unassigned = ix.purByVendor.get(null) || []
  const unassignedReturns = ix.retByVendor.get(null) || []
  const unassignedGross = unassigned.reduce((s, p) => s + p.qty * p.rate, 0)
  const unassignedNetPurch = unassigned.reduce((s, p) => s + ix.lineNetOf(p), 0)
  const unassignedDiscount = unassignedGross - unassignedNetPurch
  const unassignedReturned = unassignedReturns.reduce((s, r) => s + ix.retValueOf(r), 0)
  const unassignedNet = unassignedNetPurch - unassignedReturned
  const unassignedTotal = unassignedGross
  const unassignedByMethod = m =>
    unassigned.filter(p => methodOf(p) === m).reduce((s, p) => s + ix.lineNetOf(p), 0)
    - unassignedReturns.filter(r => methodOf(r) === m).reduce((s, r) => s + ix.retValueOf(r), 0)
  const unassignedRow = {
    count: unassigned.length, gross: unassignedGross, discount: unassignedDiscount,
    returned: unassignedReturned, net: unassignedNet,
    cash: unassignedByMethod('Cash'), credit: unassignedByMethod('Credit'),
    fonepay: unassignedByMethod('FonePay'),
  }

  const grandGross    = purchases.reduce((s, p) => s + p.qty * p.rate, 0)
  const grandNetPurch = purchases.reduce((s, p) => s + ix.lineNetOf(p), 0)
  const grandDiscount = grandGross - grandNetPurch
  const grandReturn   = returns.reduce((s, r) => s + ix.retValueOf(r), 0)
  const grandNet      = grandNetPurch - grandReturn

  const allDays = useMemo(() => [...ix.netByDay.keys()].sort((a, b) => a - b), [ix])
  const activeVendors = useMemo(
    () => vendors.filter(v => (ix.purByVendor.get(v.id) || []).length > 0),
    [vendors, ix])

  // Discount Received — one row per bill that has a discount
  const discountedBills = useMemo(() => {
    const bills = []
    ix.billMap.forEach(billEntries => {
      const disc = Math.max(0, ...billEntries.map(p => parseFloat(p.discount_amount) || 0))
      if (disc <= 0) return
      const e = billEntries[0]
      // `calcBillTotals`, not a fourth copy of the same expression. This page was named in
      // `purchaseTaxSplit.js`'s own comment and in the rules file as one of the four that reach it
      // — and it never imported it; it re-typed the discount-apportioned VAT base inline. The
      // arithmetic was identical, which is exactly what makes an independent copy dangerous: it
      // agrees until someone changes one of them.
      const t = calcBillTotals(billEntries, disc)
      bills.push({
        day: e.bs_day, vendor: e.vendors?.name || 'Unknown', vendor_id: e.vendor_id,
        invoice: e.invoice_ref, billTotal: t.subTotal, discount: t.discount,
        discPct: t.subTotal > 0 ? (t.discount / t.subTotal) * 100 : 0,
        vat: t.vatTotal, grand: t.grandTotal,
        paymentMethod: methodOf(e),
      })
    })
    return bills.sort((a, b) => a.day - b.day)
  }, [ix])

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
  const allBills = useMemo(() => {
    const bills = []
    ix.billMap.forEach((billEntries, gid) => {
      const e = billEntries[0]
      const total = billEntries.reduce((s, p) => s + p.qty * p.rate, 0)
      const disc  = Math.max(0, ...billEntries.map(p => parseFloat(p.discount_amount) || 0))
      const billReturns = billEntries.flatMap(p => ix.retByEntry.get(p.id) || [])
      const returnedAmt = billReturns.reduce((s, r) => s + r.qty * r.rate, 0)
      const net = total - disc - returnedAmt
      const paymentMethod = e.payment_method || 'Cash'

      let status, remaining = 0
      if (paymentMethod !== 'Credit') {
        status = { label: 'Paid', color: 'var(--theme-green-text)' }
      } else {
        const paid = billEntries.reduce((s, p) =>
          s + (paymentsMap[p.id] || []).reduce((s2, pm) => s2 + parseFloat(pm.amount), 0), 0)
        remaining = Math.max(0, total - paid)
        if (remaining <= EPS) status = { label: 'Paid', color: 'var(--theme-green-text)' }
        else if (paid > EPS) status = { label: 'Partial', color: 'var(--theme-purple-text)' }
        else if (selectedPeriod) {
          const adDate = bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, e.bs_day || 1)
          const daysOld = Math.max(0, Math.floor((new Date() - adDate) / (1000 * 60 * 60 * 24)))
          status = billAging(daysOld)
        } else {
          status = { label: 'Outstanding', color: 'var(--theme-red-text)' }
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
  }, [ix, paymentsMap, selectedPeriod])

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
  // The footer totals EXACTLY the rows rendered above it. It used to print the whole period's
  // grand totals under a search-filtered list — narrow to one vendor and you got one row above a
  // TOTAL for every vendor — and it asserted a hardcoded `100%` in the `% of Net Total` column,
  // which is S594's Supplier Contribution finding verbatim on a page it never travelled to. The
  // divergence was never only the search: `grandNet` also carries the Unassigned bills, which had
  // no Net cell of their own to be added up.
  const showUnassigned = unassignedTotal > 0 && !vendorSearch
  const footRows = showUnassigned ? filteredSummary.concat([unassignedRow]) : filteredSummary
  const foot = footRows.reduce((a, r) => ({
    count:    a.count + r.count,
    gross:    a.gross + r.gross,
    discount: a.discount + r.discount,
    returned: a.returned + r.returned,
    net:      a.net + r.net,
    cash:     a.cash + r.cash,
    credit:   a.credit + r.credit,
    fonepay:  a.fonepay + r.fonepay,
  }), { count: 0, gross: 0, discount: 0, returned: 0, net: 0, cash: 0, credit: 0, fonepay: 0 })
  // Computed, never asserted. It reads 100.0% when nothing is filtered and the period has no
  // unassigned bills, and states the real share the moment either is false.
  const footPct = grandNet !== 0 ? (foot.net / grandNet) * 100 : 0

  // A search narrowed to exactly one vendor switches Daily Breakdown into a
  // per-vendor view: blank days dropped, each day drills into its bill(s).
  const singleVendor = vendorSearch && filteredActiveVendors.length === 1 ? filteredActiveVendors[0] : null
  const singleVendorDays = singleVendor ? allDays.filter(day => vendorDayNet(singleVendor.id, day) !== 0) : []

  // Map lookups off `ix` — each of these used to be two full filter+reduce passes over purchases
  // AND returns, called once per matrix cell.
  function vendorDayNet(vendorId, day) {
    return ix.netByVendorDay.get(vendorId)?.get(day) || 0
  }

  function dayNet(day) {
    return ix.netByDay.get(day) || 0
  }

  function vendorNet(vendorId) {
    return ix.netByVendor.get(vendorId) || 0
  }

  function openVendorDrilldown(vendor, day = null) {
    setDrilldownVendor(vendor)
    setDrilldownDay(day)
    setExpandedBillKey(null)
  }

  function fmt(val) {
    return val !== 0 ? `NPR ${Number(val.toFixed(0)).toLocaleString('en-IN')}` : '—'
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    // Every money cell is a NUMBER. Two sheets in this one workbook disagreed: 'Discounts
    // Received' wrote `Number(x.toFixed(2))` while 'Vendor Summary' and 'Daily Breakdown' wrote
    // `x.toFixed(0)` — a string, which Excel neither sums, sorts nor formats as currency, on the
    // sheet an accountant opens precisely to total it.
    const n = v => Number((v || 0).toFixed(2))
    const share = v => grandNet !== 0 ? Number(((v / grandNet) * 100).toFixed(1)) : 0
    const summaryRow = (name, r, days) => ({
      'Vendor': name,
      'Transactions': r.count,
      'Days Active': days,
      'Gross Purchases (NPR)': n(r.gross),
      'Discount Received (NPR)': n(-r.discount),
      'Returns (NPR)': n(-r.returned),
      'Net Spend (NPR)': n(r.net),
      '% of Net Total': share(r.net),
      'Cash Net (NPR)': n(r.cash),
      'Credit Net (NPR)': n(r.credit),
      'FonePay Net (NPR)': n(r.fonepay),
    })
    const summaryData = vendorSummary.map(r => summaryRow(r.vendor.name, r, r.days))
    // The unassigned row used to omit Discount entirely (a blank cell, not a zero), hardcode
    // Returns to '0', and report its GROSS as its Net Spend — so the one row on the sheet nobody
    // can chase down to a supplier was also the one whose arithmetic did not hold.
    if (unassignedTotal > 0) {
      summaryData.push(summaryRow('Unassigned', unassignedRow,
        [...new Set(unassigned.map(p => p.bs_day))].length))
    }
    // A sheet a reader is asked to reconcile needs the total printed on it (S723). Without one,
    // the only way to check the export against the screen is to sum eleven columns by hand.
    summaryData.push(summaryRow('TOTAL', {
      count: purchases.length, gross: grandGross, discount: grandDiscount,
      returned: grandReturn, net: grandNet,
      cash: vendorSummary.reduce((s, r) => s + r.cash, 0) + (unassignedTotal > 0 ? unassignedRow.cash : 0),
      credit: vendorSummary.reduce((s, r) => s + r.credit, 0) + (unassignedTotal > 0 ? unassignedRow.credit : 0),
      fonepay: vendorSummary.reduce((s, r) => s + r.fonepay, 0) + (unassignedTotal > 0 ? unassignedRow.fonepay : 0),
    }, allDays.length))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Vendor Purchase Report — Net spend by supplier', biz, scopeLine,
      rows: summaryData, notes: [BASIS_NOTE],
    }), 'Vendor Summary')

    // Columns are keyed by vendor NAME, and `vendors` still has no unique-name constraint (S708) —
    // so two suppliers entered under one name silently merged into a single column and one of them
    // vanished from the sheet. The code disambiguates where the product cannot yet prevent it.
    const nameCount = {}
    activeVendors.forEach(v => { nameCount[v.name] = (nameCount[v.name] || 0) + 1 })
    const colOf = v => (nameCount[v.name] > 1 && v.vendor_code) ? `${v.name} (${v.vendor_code})` : v.name
    const dailyData = allDays.map(day => {
      const row = { 'Day': day }
      activeVendors.forEach(v => { const val = vendorDayNet(v.id, day); row[colOf(v)] = val !== 0 ? n(val) : '' })
      row['Day Net Total (NPR)'] = n(dayNet(day))
      return row
    })
    const dailyTotal = { 'Day': 'TOTAL' }
    activeVendors.forEach(v => { const val = vendorNet(v.id); dailyTotal[colOf(v)] = val !== 0 ? n(val) : '' })
    dailyTotal['Day Net Total (NPR)'] = n(grandNet)
    dailyData.push(dailyTotal)
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Vendor Purchase Report — Daily Breakdown', biz, scopeLine,
      rows: dailyData, notes: [BASIS_NOTE],
    }), 'Daily Breakdown')

    if (discountedBills.length > 0) {
      const discData = discountedBills.map(b => ({
        'Day': b.day, 'Vendor': b.vendor, 'Invoice Ref': b.invoice || '',
        'Bill Total (ex-VAT)': n(b.billTotal),
        'Discount (NPR)': n(b.discount),
        'Discount %': n(b.discPct),
        'VAT on Taxable (13%)': n(b.vat),
        'Grand Total (incl. VAT)': n(b.grand),
        'Payment Method': b.paymentMethod || '',
      }))
      discData.push({
        'Day': 'TOTAL', 'Vendor': '', 'Invoice Ref': '',
        'Bill Total (ex-VAT)': n(discountedBills.reduce((s, b) => s + b.billTotal, 0)),
        'Discount (NPR)': n(discountedBills.reduce((s, b) => s + b.discount, 0)),
        'Discount %': '',
        'VAT on Taxable (13%)': n(discountedBills.reduce((s, b) => s + b.vat, 0)),
        'Grand Total (incl. VAT)': n(discountedBills.reduce((s, b) => s + b.grand, 0)),
        'Payment Method': '',
      })
      XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
        title: 'Vendor Purchase Report — Discounts Received', biz, scopeLine,
        rows: discData, notes: [BASIS_NOTE],
      }), 'Discounts Received')
    }
    XLSX.writeFile(wb, `Vendor-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  // A report that states a scope must state it everywhere the report goes (S594). The workbook
  // carried the period in its FILENAME and nowhere inside it, so a sheet detached from its
  // download — mailed on, or opened weeks later — named no month and no business at all.
  const scopeLine = `Period : ${periodLabel}${selectedPeriod?.status === 'open'
    ? ' (PROVISIONAL — period still open, figures can change)'
    : ' (period closed)'}`
  const BASIS_NOTE = 'Figures are ex-VAT and net of bill discounts, apportioned across each bill’s own lines. Returns are credited at the price actually paid, i.e. net of that bill’s discount. Bill totals including VAT are on the Discounts Received sheet and in Outstanding Payables.'

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read leaves periods empty, and NoPeriodState would wear the
  // failure as "no periods yet" (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the vendor report" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Vendor Purchase Report</h1>
          <p className="page-subtitle">Net spend by supplier (gross purchases − returns)</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!!loadError}>Export Excel</button>
        </div>
      </div>

      {/* A failed read renders as a failure — never as a confident NPR-0 vendor ledger (S612). */}
      {loadError ? <ReportLoadError error={loadError} /> : <>

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">Gross Purchases</div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandGross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Returns</div>
          <div className="stat-value" style={{ fontSize: 17, color: grandReturn > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
            {grandReturn > 0 ? `−NPR ${grandReturn.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Spend</div>
          <div className="stat-value gold" style={{ fontSize: 17 }}>NPR {grandNet.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
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
          <div className="stat-value" style={{ fontSize: 17, color: grandDiscount > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>
            {grandDiscount > 0 ? `NPR ${grandDiscount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
          </div>
          {grandDiscount > 0 && <div className="stat-sub">{discountedBills.length} bill{discountedBills.length !== 1 ? 's' : ''}</div>}
        </div>
      </div>

      {/* Visual spend split */}
      {grandNet > 0 && vendorSummary.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10 }}>Vendor Net Spend Split</div>
          <div style={{ display: 'flex', height: 18, borderRadius: 'var(--radius-sm)', overflow: 'hidden', gap: 2 }}>
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
                  <div style={{ width: 10, height: 10, borderRadius: 'var(--radius-xs)', background: colors[i % colors.length], flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{r.vendor.name}</span>
                  {/* The swatch beside this carries the series colour; the number carries the contrast
                      — a chart hex set as 11px/700 type measured 2.2:1 on Rosé Dawn. */}
                  <span style={{ fontSize: 11, color: 'var(--theme-text1)', fontWeight: 700 }}>{pct.toFixed(1)}%</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Vendor search — combobox */}
      <div style={{ marginBottom: 16, position: 'relative', width: 300 }}>
        <div style={{ position: 'relative' }}>
          <input aria-label="Search vendors"
            value={vendorSearch}
            onChange={e => { setVendorSearch(e.target.value); setShowVendorDrop(true) }}
            onFocus={() => setShowVendorDrop(true)}
            onBlur={() => setTimeout(() => setShowVendorDrop(false), 150)}
            placeholder="Search or select a vendor…"
            style={{
              background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
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
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', marginTop: 4, zIndex: 100, maxHeight: 220, overflowY: 'auto', boxShadow: '0 4px 16px rgba(0,0,0,0.3)' }}>
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
                  {r.vendor.vendor_code && <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--theme-accent-ink)', marginRight: 8 }}>{r.vendor.vendor_code}</span>}
                  {r.vendor.name}
                  <span style={{ float: 'right', fontSize: 11, color: 'var(--theme-text3)' }}>NPR {r.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                </div>
              ))
            }
            {vendorSummary.filter(r => !vendorSearch || r.vendor.name.toLowerCase().includes(vendorSearch.toLowerCase()) || (r.vendor.vendor_code || '').toLowerCase().includes(vendorSearch.toLowerCase())).length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--theme-text3)' }}>No vendors matched</div>
            )}
          </div>
        )}
      </div>

      <div className="panel-tab-bar" role="tablist" aria-label="Vendor report views">
        {[['summary', 'Vendor Summary'], ['daily', 'Daily Breakdown'], ['discounts', 'Discounts Received']].map(([m, label]) => (
          <button key={m} type="button" role="tab" aria-selected={viewMode === m}
            className={`panel-tab${viewMode === m ? ' panel-tab--active' : ''}`}
            onClick={() => setViewMode(m)}>{label}</button>
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
                  <th style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}><Tip text="Trade/promo discount received from this vendor — deducted from net spend." width={230}>Discount</Tip></th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}><Tip text="Value of goods returned to this vendor this period, credited at the price actually paid — if the original bill carried a trade discount, the return is credited net of its share. Return a whole discounted bill and net spend comes back to zero, not to minus the discount." width={280}>Returns</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net spend = Gross − Discount − Returns (ex-VAT). Your true cost obligation to this vendor." width={250}>Net Spend</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="This vendor's share of total net purchase spend for the period." width={220}>% of Net Total</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Average daily spend (net) across days this vendor had deliveries.">Avg/Day</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net spend on bills settled in cash. A bill has one payment method for all its lines; a bill recorded before the method was tracked counts as Cash. These three columns add up to Net Spend." width={250}>Cash (Net)</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net spend on bills bought on credit — what became a payable. Outstanding Payables tracks what is still owed against them." width={250}>Credit (Net)</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net spend on bills settled by FonePay." width={220}>FonePay (Net)</Tip></th>
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
                            <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--theme-accent-ink)', marginRight: 8 }}>{r.vendor.vendor_code}</span>
                          )}
                          {r.vendor.name}
                        </span>
                        {r.returnCount > 0 && <span style={{ fontSize: 11, color: 'var(--theme-red-text)', marginLeft: 6 }}>({r.returnCount} return{r.returnCount > 1 ? 's' : ''})</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.count}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>NPR {r.gross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green-text)', fontWeight: r.discount > 0 ? 600 : 400 }}>{r.discount > 0 ? `−NPR ${r.discount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{r.returned > 0 ? `−NPR ${r.returned.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>NPR {r.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                          <div style={{ width: 70, height: 5, background: 'var(--theme-border)', borderRadius: 'var(--radius-xs)' }}>
                            <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: 'var(--theme-accent)', borderRadius: 'var(--radius-xs)' }} />
                          </div>
                          <span style={{ fontSize: 12, color: 'var(--theme-text2)', minWidth: 38 }}>{pct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                        NPR {r.days > 0 ? (r.net / r.days).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: r.cash > 0 ? 'var(--theme-green-text)' : 'var(--theme-text3)' }}>{fmt(r.cash)}</td>
                      <td style={{ textAlign: 'right', color: r.credit > 0 ? 'var(--theme-red-text)' : 'var(--theme-text3)' }}>{fmt(r.credit)}</td>
                      <td style={{ textAlign: 'right', color: r.fonepay > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text3)' }}>{fmt(r.fonepay)}</td>
                    </tr>
                  )
                })}
                {showUnassigned && (
                  <tr>
                    <td style={{ color: 'var(--theme-text3)', fontStyle: 'italic' }}>
                      <Tip text="Purchase bills recorded with no vendor selected. They are in every total on this page, so they are shown as their own row rather than left to make the column fail to add up." width={260}>Unassigned</Tip>
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{unassignedRow.count}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>NPR {unassignedRow.gross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{unassignedRow.discount > 0 ? `−NPR ${unassignedRow.discount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{unassignedRow.returned > 0 ? `−NPR ${unassignedRow.returned.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>NPR {unassignedRow.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                      {grandNet !== 0 ? `${((unassignedRow.net / grandNet) * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td></td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(unassignedRow.cash)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(unassignedRow.credit)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(unassignedRow.fonepay)}</td>
                  </tr>
                )}
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 12 }}>TOTAL</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>{foot.count}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12 }}>NPR {foot.gross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)', paddingTop: 12 }}>{foot.discount > 0 ? `−NPR ${foot.discount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 12 }}>{foot.returned > 0 ? `−NPR ${foot.returned.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 12 }}>NPR {foot.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>{footPct.toFixed(1)}%</td>
                  <td style={{ paddingTop: 12 }}></td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>{fmt(foot.cash)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>{fmt(foot.credit)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>{fmt(foot.fonepay)}</td>
                </tr>
                {vendorSearch && (
                  <tr>
                    <td colSpan={11} style={{ fontSize: 12, color: 'var(--theme-text3)', paddingTop: 6 }}>
                      Filtered by “{vendorSearch}”. The period's own totals are NPR {grandGross.toLocaleString('en-IN', { maximumFractionDigits: 0 })} gross / NPR {grandNet.toLocaleString('en-IN', { maximumFractionDigits: 0 })} net across {purchases.length} entries.
                    </td>
                  </tr>
                )}
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
                          <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{formatBsDay(day, selectedPeriod?.bs_month)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>
                            NPR {val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </td>
                          <td style={{ color: 'var(--theme-text3)', fontSize: 12, whiteSpace: 'nowrap' }}>▸ View bill</td>
                        </tr>
                      )
                    })}
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 12 }}>TOTAL</td>
                      <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 12 }}>
                        NPR {vendorNet(singleVendor.id).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
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
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>Day Net Total</th>
                  </tr>
                </thead>
                <tbody>
                  {allDays.map(day => {
                    const dn = dayNet(day)
                    return (
                      <tr key={day}>
                        <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{formatBsDay(day, selectedPeriod?.bs_month)}</td>
                        {filteredActiveVendors.map(v => {
                          const val = vendorDayNet(v.id, day)
                          return (
                            <td
                              key={v.id}
                              onClick={val !== 0 ? () => openVendorDrilldown(v, day) : undefined}
                              title={val !== 0 ? 'View bill(s) for this day' : undefined}
                              style={{ textAlign: 'right', color: val !== 0 ? 'var(--theme-text1)' : 'var(--theme-border)', cursor: val !== 0 ? 'pointer' : 'default' }}
                            >
                              {val !== 0 ? val.toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'}
                            </td>
                          )
                        })}
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                          NPR {dn.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                    <td style={{ fontWeight: 800, color: 'var(--theme-text1)', paddingTop: 12 }}>TOTAL</td>
                    {filteredActiveVendors.map(v => (
                      <td key={v.id} style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12 }}>
                        NPR {vendorNet(v.id).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 12 }}>
                      NPR {grandNet.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
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
                        <th style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}><Tip text="Total discount amount received from this vendor across all bills.">Discount Received</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Average discount rate = Total Discount ÷ Bill Total × 100." width={220}>Avg Disc %</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorDiscountRows.map((v, i) => (
                        <tr key={i}>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.count}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {v.totalGross.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-green-text)', fontWeight: 700 }}>NPR {v.totalDiscount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.totalGross > 0 ? ((v.totalDiscount / v.totalGross) * 100).toFixed(1) : '0'}%</td>
                        </tr>
                      ))}
                      <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>TOTAL</td>
                        <td style={{ textAlign: 'right' }}>{discountedBills.length}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {discountedBills.reduce((s, b) => s + b.billTotal, 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>NPR {grandDiscount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
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
                      <th style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}><Tip text="Trade/promo discount amount as shown on the vendor invoice.">Discount</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Discount as a percentage of the bill total ex-VAT.">Disc %</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-amber-text)' }}><Tip text="VAT computed on the taxable base (bill total minus discount), per Nepal IRD." width={250}>VAT (13%)</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Grand Total = (Bill Total − Discount) + VAT on taxable amount." width={230}>Grand Total</Tip></th>
                      <th>Payment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discountedBills.map((b, i) => (
                      <tr key={i}>
                        <td style={{ color: 'var(--theme-accent-ink)', fontWeight: 700, whiteSpace: 'nowrap' }}>{formatBsDay(b.day, selectedPeriod?.bs_month)}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{b.vendor}</td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{b.invoice || '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {b.billTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)', fontWeight: 700 }}>NPR {b.discount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{b.discPct.toFixed(1)}%</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-amber-text)' }}>{b.vat > 0 ? `NPR ${b.vat.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 700 }}>NPR {b.grand.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
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
          title={`${drilldownVendor.name} — Purchase Bills${drilldownDay != null ? ` (${formatBsDay(drilldownDay, selectedPeriod?.bs_month)})` : ''}`}
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
                  style={{ color: 'var(--theme-accent-ink)', cursor: 'pointer', textDecoration: 'underline' }}
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
                <span>Net: <strong style={{ color: 'var(--theme-accent-ink)' }}>NPR {drilldownBills.reduce((s, b) => s + b.net, 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong></span>
                {drilldownOutstanding > 0 && (
                  <span>Outstanding: <strong style={{ color: 'var(--theme-red-text)' }}>NPR {drilldownOutstanding.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong></span>
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
                      <th style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>Discount</th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returns</th>
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
                          {/* The <tr> keeps its implicit `row` role: role="button" on a row takes it out of the
                              table's structure and its cells stop being associated with their column headers.
                              The control lives in a cell instead — see components/RowDisclosure.jsx (S595). */}
                          <tr style={{ cursor: 'pointer' }}
                            onClick={() => setExpandedBillKey(prev => prev === b.key ? null : b.key)}>
                            <td style={{ color: 'var(--theme-accent-ink)', fontWeight: 700, whiteSpace: 'nowrap' }}>{formatBsDay(b.day, selectedPeriod?.bs_month)}</td>
                            <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{b.invoice || '—'}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{b.itemCount}</td>
                            <td><span className={`badge ${b.paymentMethod === 'Cash' ? 'badge-green' : b.paymentMethod === 'Credit' ? 'badge-red' : 'badge-gray'}`}>{b.paymentMethod}</span></td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>NPR {b.total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{b.discount > 0 ? `−NPR ${b.discount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{b.returned > 0 ? `−NPR ${b.returned.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}</td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>NPR {b.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                            <td>
                              <span style={{ fontSize: 11, fontWeight: 700, color: b.status.color, background: `color-mix(in srgb, ${b.status.color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${b.status.color} 40%, transparent)`, borderRadius: 'var(--radius-xs)', padding: '2px 8px', whiteSpace: 'nowrap' }}>{b.status.label}</span>
                            </td>
                            <td style={{ color: 'var(--theme-text3)', fontSize: 12, whiteSpace: 'nowrap' }}>
                              <RowDisclosure
                                expanded={isExpanded}
                                onToggle={() => setExpandedBillKey(prev => prev === b.key ? null : b.key)}
                                controls={`vendor-bill-detail-${b.key}`}
                                label={`Bill ${b.invoice || b.day} — ${isExpanded ? 'hide' : 'show'} line items, returns and payment history`}
                              >
                                <span aria-hidden="true">{isExpanded ? '▲ Hide' : '▼ Details'}</span>
                              </RowDisclosure>
                            </td>
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
                                          <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(e.qty).toLocaleString('en-IN')}</td>
                                          <td style={{ padding: '4px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(e.rate).toLocaleString('en-IN')}</td>
                                          <td style={{ padding: '4px 0 4px 16px', textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>NPR {(e.qty * e.rate).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
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
                                              <td style={{ padding: '5px 16px', textAlign: 'right', color: 'var(--theme-text2)' }}>{parseFloat(r.qty).toLocaleString('en-IN')}</td>
                                              <td style={{ padding: '5px 0 5px 16px', textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 600 }}>−NPR {(r.qty * r.rate).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
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
                                              <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-green-text)' }}>{p.paid_at}</td>
                                              <td style={{ padding: '5px 16px', textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>NPR {parseFloat(p.amount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                                              <td style={{ padding: '5px 0 5px 16px', color: 'var(--theme-text3)' }}>{p.note || '—'}</td>
                                            </tr>
                                          ))}
                                          <tr style={{ borderTop: '1px solid var(--theme-border)' }}>
                                            <td style={{ padding: '5px 16px 5px 0', color: 'var(--theme-text2)', fontSize: 11 }}>Total paid</td>
                                            <td style={{ padding: '5px 16px', textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)' }}>NPR {(b.total - b.remaining).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
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
      </>}
    </div>
  )
}
