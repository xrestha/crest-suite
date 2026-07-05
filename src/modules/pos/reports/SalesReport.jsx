import { useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import * as XLSX from 'xlsx'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import ChartCard from '../../../components/ChartCard'
import { getBsToday, formatAd, adToBs, BS_MONTHS, getBsFiscalYear } from '../../../utils/bsCalendar'
import { computeOrderAmounts, computeCategoryAmounts, computeItemAmounts } from '../../../utils/posBillingMath'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const WALKIN_KEY = '__CASH_SALES__'
const THRESHOLD = 100000
const GOLD  = '#c9a84c'
const MUTED = '#6b7280'
const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
const bsSlash = iso => { const bs = adToBs(new Date(iso)); return `${String(bs.day).padStart(2, '0')}/${String(bs.month).padStart(2, '0')}/${bs.year}` }

const TABS = [
  { key: 'daily',    label: 'Daily' },
  { key: 'hourly',   label: 'Hourly' },
  { key: 'voucher',  label: 'Bill Register' },
  { key: 'payment',  label: 'Payment Summary' },
  { key: 'category', label: 'Category Wise' },
  { key: 'item',     label: 'Item Wise' },
  { key: 'customer', label: 'Customer Wise' },
  { key: 'onelakh',  label: '1L+ Report' },
]
const PAY_METHOD_ORDER = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Credit']

export default function SalesReport() {
  const { clientId, hasPosAccess } = useAuth()
  const today = getBsToday()
  const currentFy = getBsFiscalYear(today.year, today.month)

  const [tab, setTab] = useState('daily')

  /* ── Letterhead info for Excel exports — fetched once per client, independent of date range ── */
  const [bizInfo, setBizInfo] = useState({ name: '', vat: '', address: '' })
  useEffect(() => {
    if (!clientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('vat_number, property_address').eq('client_id', clientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({ name: client?.name || '', vat: settings?.vat_number || '', address: settings?.property_address || '' })
    })
  }, [clientId])

  /* ── Daily / Hourly / Category / Customer — one shared date-range fetch ── */
  const [fromIso, setFromIso] = useState(formatAd(new Date()))
  const [toIso,   setToIso]   = useState(formatAd(new Date()))
  const [orders, setOrders] = useState([])
  const [itemsByOrder, setItemsByOrder] = useState({})
  const [vatReg, setVatReg] = useState(true)
  const [staffNames, setStaffNames] = useState({})
  const [rangeLoading, setRangeLoading] = useState(true)

  const loadRange = useCallback(async () => {
    if (!clientId) return
    setRangeLoading(true)
    const fromTs = new Date(fromIso + 'T00:00:00').toISOString()
    const toTs   = new Date(toIso + 'T23:59:59.999').toISOString()

    const [{ data: orderData }, { data: settings }, { data: profs }] = await Promise.all([
      supabase.from('pos_orders')
        .select('id, order_no, invoice_no, buyer_name, buyer_pan, buyer_phone, discount_amount, closed_at, credit_note_id, payment_method, bill_remarks, closed_by, table_name')
        .eq('client_id', clientId).eq('close_type', 'paid')
        .gte('closed_at', fromTs).lte('closed_at', toTs),
      supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
      supabase.from('profiles').select('id, full_name').eq('client_id', clientId),
    ])
    setVatReg(settings?.is_vat_registered ?? true)
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    const orderList = orderData || []
    setOrders(orderList)

    let byOrder = {}
    if (orderList.length > 0) {
      const { data: items } = await supabase.from('pos_order_items')
        .select('order_id, recipe_id, name, category, qty, unit_price, vat_rate').in('order_id', orderList.map(o => o.id))
      byOrder = (items || []).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
    }
    setItemsByOrder(byOrder)
    setRangeLoading(false)
  }, [clientId, fromIso, toIso])

  useEffect(() => { loadRange() }, [loadRange])

  const dailyRows = useMemo(() => {
    // Credit-Noted bills are excluded entirely, not shown as a "Return" row — the revenue
    // correction from a Credit Note posts into sales_entries on the day it's ISSUED (see
    // IssueCreditNoteModal.jsx), not retroactively into the original bill's day, so including a
    // since-corrected bill here would misstate that original day's actual net position.
    const map = {}
    for (const o of orders) {
      if (o.credit_note_id) continue
      const amounts = computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg)
      const bs = adToBs(new Date(o.closed_at))
      const key = `${bs.year}-${bs.month}-${bs.day}`
      map[key] = map[key] || { key, year: bs.year, month: bs.month, day: bs.day, bills: 0, qty: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 }
      const b = map[key]
      b.bills += 1; b.qty += amounts.totalQty; b.gross += amounts.grossAmt; b.discount += amounts.discount
      b.taxable += amounts.taxableBase; b.nonTaxable += amounts.nonTaxableBase; b.vat += amounts.vatAmt; b.net += amounts.net
    }
    return Object.values(map).sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day)
  }, [orders, itemsByOrder, vatReg])

  const hourlyRows = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, bills: 0, qty: 0, net: 0 }))
    for (const o of orders) {
      if (o.credit_note_id) continue // same exclusion rule as dailyRows — totals must reconcile across tabs
      const amounts = computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg)
      const h = new Date(o.closed_at).getHours()
      buckets[h].bills += 1; buckets[h].qty += amounts.totalQty; buckets[h].net += amounts.net
    }
    return buckets
  }, [orders, itemsByOrder, vatReg])

  const voucherRows = useMemo(() => {
    return orders.map(o => {
      const amounts = computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg)
      return {
        id: o.id, orderNo: o.order_no, invoiceNo: o.invoice_no, closedAt: o.closed_at,
        customer: o.buyer_name || 'CASH SALES', pan: o.buyer_pan || '',
        payMethod: o.payment_method || '—',
        orderMode: o.table_name && o.table_name !== 'Takeaway' ? `Dine-In: ${o.table_name}` : 'Takeaway',
        remarks: o.bill_remarks || '', enteredBy: staffNames[o.closed_by] || '—',
        credited: !!o.credit_note_id,
        gross: amounts.grossAmt, discount: amounts.discount, taxable: amounts.taxableBase,
        nonTaxable: amounts.nonTaxableBase, vat: amounts.vatAmt, net: amounts.net,
      }
    }).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
  }, [orders, itemsByOrder, vatReg, staffNames])

  const paymentRows = useMemo(() => {
    const grouped = {}
    const ensure = m => grouped[m] = grouped[m] || { method: m, bills: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 }
    for (const o of orders) {
      if (o.credit_note_id) continue // same exclusion rule as dailyRows — totals must reconcile across tabs
      const amounts = computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg)
      const b = ensure(o.payment_method || 'Cash')
      b.bills += 1; b.gross += amounts.grossAmt; b.discount += amounts.discount
      b.taxable += amounts.taxableBase; b.nonTaxable += amounts.nonTaxableBase; b.vat += amounts.vatAmt; b.net += amounts.net
    }
    return Object.values(grouped).sort((a, b) => {
      const ia = PAY_METHOD_ORDER.indexOf(a.method), ib = PAY_METHOD_ORDER.indexOf(b.method)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })
  }, [orders, itemsByOrder, vatReg])

  const categoryRows = useMemo(() => {
    const grouped = {}
    const ensure = cat => grouped[cat] = grouped[cat] || { name: cat, qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 }
    for (const o of orders) {
      const items = itemsByOrder[o.id] || []
      if (o.credit_note_id) {
        for (const i of items) ensure(i.category || 'Uncategorized').qtyReturn += i.qty
        continue
      }
      const byCat = computeCategoryAmounts(o, items, vatReg)
      for (const [cat, v] of Object.entries(byCat)) {
        const b = ensure(cat)
        b.qtySales += v.qty; b.gross += v.gross; b.discount += v.discount
        b.taxable += v.taxable; b.nonTaxable += v.nonTaxable; b.vat += v.vat
      }
    }
    return Object.values(grouped).sort((a, b) => (b.gross - b.discount + b.vat) - (a.gross - a.discount + a.vat))
  }, [orders, itemsByOrder, vatReg])

  const itemRows = useMemo(() => {
    const grouped = {}
    const ensure = (key, name) => grouped[key] = grouped[key] || { key, name, qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 }
    for (const o of orders) {
      const items = itemsByOrder[o.id] || []
      if (o.credit_note_id) {
        for (const i of items) ensure(i.recipe_id || i.name, i.name).qtyReturn += i.qty
        continue
      }
      const byItem = computeItemAmounts(o, items, vatReg)
      for (const [key, v] of Object.entries(byItem)) {
        const b = ensure(key, v.name)
        b.qtySales += v.qty; b.gross += v.gross; b.discount += v.discount
        b.taxable += v.taxable; b.nonTaxable += v.nonTaxable; b.vat += v.vat
      }
    }
    return Object.values(grouped).sort((a, b) => (b.gross - b.discount + b.vat) - (a.gross - a.discount + a.vat))
  }, [orders, itemsByOrder, vatReg])

  const customerRows = useMemo(() => {
    const grouped = {}
    for (const o of orders) {
      if (o.credit_note_id) continue // same exclusion rule as dailyRows — totals must reconcile across tabs
      const amounts = computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg)
      const pan = (o.buyer_pan || '').trim()
      const name = (o.buyer_name || '').trim()
      const key = pan || name || WALKIN_KEY
      grouped[key] = grouped[key] || { key, name: name || 'CASH SALES', pan, phone: o.buyer_phone || '', bills: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 }
      const b = grouped[key]
      b.bills += 1; b.gross += amounts.grossAmt; b.discount += amounts.discount
      b.taxable += amounts.taxableBase; b.nonTaxable += amounts.nonTaxableBase; b.vat += amounts.vatAmt; b.net += amounts.net
    }
    return Object.values(grouped).sort((a, b) => b.net - a.net)
  }, [orders, itemsByOrder, vatReg])

  /* ── One Lakh Above (Annexure 13) — fiscal-year scoped, separate from the date-range pipeline ── */
  const [fyOptions, setFyOptions] = useState([currentFy])
  const [selectedFy, setSelectedFy] = useState(currentFy)
  const [parties, setParties] = useState([])
  const [oneLakhLoading, setOneLakhLoading] = useState(true)

  useEffect(() => {
    if (!clientId) return
    supabase.from('pos_orders').select('invoice_fy').eq('client_id', clientId).not('invoice_fy', 'is', null)
      .then(({ data }) => {
        const fys = [...new Set((data || []).map(r => r.invoice_fy))].sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
        if (fys.length > 0) {
          setFyOptions(fys.includes(currentFy) ? fys : [currentFy, ...fys])
          if (!fys.includes(selectedFy)) setSelectedFy(fys[0])
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  const loadOneLakh = useCallback(async () => {
    if (!clientId) return
    setOneLakhLoading(true)
    const [{ data: fyOrders }, { data: settings }] = await Promise.all([
      supabase.from('pos_orders')
        .select('id, buyer_name, buyer_pan, discount_amount')
        .eq('client_id', clientId).eq('status', 'billed').eq('close_type', 'paid').eq('invoice_fy', selectedFy)
        // Credit-noted bills are excluded — a corrected/cancelled invoice must not push a party
        // over the Annexure 13 one-lakh disclosure threshold.
        .is('credit_note_id', null),
      supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
    ])
    const vr = settings?.is_vat_registered ?? true
    const list = fyOrders || []

    let byOrder = {}
    if (list.length > 0) {
      const { data: items } = await supabase.from('pos_order_items')
        .select('order_id, qty, unit_price, vat_rate').in('order_id', list.map(o => o.id))
      byOrder = (items || []).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
    }

    const grouped = {}
    for (const o of list) {
      const amounts = computeOrderAmounts(o, byOrder[o.id] || [], vr)
      const pan = (o.buyer_pan || '').trim()
      const name = (o.buyer_name || '').trim()
      const key = pan || name || WALKIN_KEY
      grouped[key] = grouped[key] || { name: name || 'CASH SALES / WALK-IN', pan, bills: 0, gross: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 }
      grouped[key].bills += 1
      grouped[key].gross += amounts.grossAmt
      grouped[key].taxable += amounts.taxableBase
      grouped[key].nonTaxable += amounts.nonTaxableBase
      grouped[key].vat += amounts.vatAmt
      grouped[key].net += amounts.net
    }
    setParties(Object.entries(grouped).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.net - a.net))
    setOneLakhLoading(false)
  }, [clientId, selectedFy])

  // Lazy — the FY-wide fetch (every paid order + all its items) only runs once the tab is opened
  useEffect(() => { if (tab === 'onelakh') loadOneLakh() }, [tab, loadOneLakh])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const dailyTotals = dailyRows.reduce((s, r) => ({ bills: s.bills + r.bills, qty: s.qty + r.qty, gross: s.gross + r.gross, discount: s.discount + r.discount, taxable: s.taxable + r.taxable, nonTaxable: s.nonTaxable + r.nonTaxable, vat: s.vat + r.vat, net: s.net + r.net }), { bills: 0, qty: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const hourlyTotals = hourlyRows.reduce((s, h) => ({ bills: s.bills + h.bills, qty: s.qty + h.qty, net: s.net + h.net }), { bills: 0, qty: 0, net: 0 })
  const voucherTotals = voucherRows.reduce((s, v) => ({ gross: s.gross + v.gross, discount: s.discount + v.discount, taxable: s.taxable + v.taxable, nonTaxable: s.nonTaxable + v.nonTaxable, vat: s.vat + v.vat, net: s.net + v.net }), { gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const paymentTotals = paymentRows.reduce((s, p) => ({ bills: s.bills + p.bills, gross: s.gross + p.gross, discount: s.discount + p.discount, taxable: s.taxable + p.taxable, nonTaxable: s.nonTaxable + p.nonTaxable, vat: s.vat + p.vat, net: s.net + p.net }), { bills: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const categoryNetOf = c => c.gross - c.discount + c.vat
  const categoryTotals = categoryRows.reduce((s, c) => ({ qtySales: s.qtySales + c.qtySales, qtyReturn: s.qtyReturn + c.qtyReturn, gross: s.gross + c.gross, discount: s.discount + c.discount, taxable: s.taxable + c.taxable, nonTaxable: s.nonTaxable + c.nonTaxable, vat: s.vat + c.vat }), { qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 })
  const itemNetOf = i => i.gross - i.discount + i.vat
  const itemTotals = itemRows.reduce((s, i) => ({ qtySales: s.qtySales + i.qtySales, qtyReturn: s.qtyReturn + i.qtyReturn, gross: s.gross + i.gross, discount: s.discount + i.discount, taxable: s.taxable + i.taxable, nonTaxable: s.nonTaxable + i.nonTaxable, vat: s.vat + i.vat }), { qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 })
  const customerTotals = customerRows.reduce((s, c) => ({ gross: s.gross + c.gross, discount: s.discount + c.discount, taxable: s.taxable + c.taxable, nonTaxable: s.nonTaxable + c.nonTaxable, vat: s.vat + c.vat, net: s.net + c.net }), { gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const oneLakhTotals = parties.reduce((s, p) => ({ gross: s.gross + p.gross, vat: s.vat + p.vat, net: s.net + p.net }), { gross: 0, vat: 0, net: 0 })

  const hourlyChartData = hourlyRows.map(h => ({ name: hourLabel(h.hour), value: h.net }))

  // Printable-statutory-document look (Company Name/VAT/Address letterhead + date-range line baked
  // into the sheet itself), matching the format competitor ERP exports use — see [[pos_reports_gap_list]].
  function withLetterhead(title, rangeLine, dataRows) {
    const aoa = [
      [title],
      [`CompanyName : ${bizInfo.name}`],
      [`${vatReg ? 'VATNO' : 'PAN No'} : ${bizInfo.vat}`],
      [`ADDRESS : ${bizInfo.address}`],
      [],
      [rangeLine],
      [],
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    XLSX.utils.sheet_add_json(ws, dataRows, { origin: -1 })
    return ws
  }
  const dateRangeLine = `@As On Dated : ${fromIso} (B.S. ${bsSlash(fromIso)})  To : ${toIso} (B.S. ${bsSlash(toIso)})  @Division : ${bizInfo.name}`

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    if (tab === 'daily') {
      const ws = withLetterhead('Sales Report - Daily', dateRangeLine, dailyRows.map(r => ({
        'Date (BS)': `${r.day} ${BS_MONTHS[r.month - 1]} ${r.year}`, 'Bills': r.bills, 'Qty': r.qty,
        'Gross (NPR)': Math.round(r.gross * 100) / 100, 'Discount (NPR)': Math.round(r.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(r.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(r.taxable * 100) / 100,
        'VAT (NPR)': Math.round(r.vat * 100) / 100, 'Net (NPR)': Math.round(r.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Daily Sales')
      XLSX.writeFile(wb, `daily-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'hourly') {
      const ws = withLetterhead('Sales Report - Hourly', dateRangeLine, hourlyRows.map(h => ({ 'Hour': hourLabel(h.hour), 'Bills': h.bills, 'Qty': h.qty, 'Net Sales (NPR)': Math.round(h.net * 100) / 100 })))
      XLSX.utils.book_append_sheet(wb, ws, 'Hourly Sales')
      XLSX.writeFile(wb, `hourly-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'voucher') {
      const ws = withLetterhead('Sales Book Report', dateRangeLine, voucherRows.map(v => {
        const bs = adToBs(new Date(v.closedAt))
        return {
          'Date (BS)': `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`, 'Voucher#': v.orderNo, 'Invoice#': v.invoiceNo || '',
          'Customer': v.customer, 'PAN': v.pan, 'Payment Mode': v.payMethod, 'Order Mode': v.orderMode,
          'Gross (NPR)': Math.round(v.gross * 100) / 100, 'Discount (NPR)': Math.round(v.discount * 100) / 100,
          'Non-Taxable (NPR)': Math.round(v.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(v.taxable * 100) / 100,
          'VAT (NPR)': Math.round(v.vat * 100) / 100, 'Net (NPR)': Math.round(v.net * 100) / 100,
          'Remarks': v.remarks, 'Entered By': v.enteredBy, 'Credit Noted': v.credited ? 'Yes' : '',
        }
      }))
      XLSX.utils.book_append_sheet(wb, ws, 'Bill Register')
      XLSX.writeFile(wb, `bill-register-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'payment') {
      const ws = withLetterhead('Sales Report - Payment Summary', dateRangeLine, paymentRows.map(p => ({
        'Payment Method': p.method, 'Bills': p.bills,
        'Gross (NPR)': Math.round(p.gross * 100) / 100, 'Discount (NPR)': Math.round(p.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(p.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(p.taxable * 100) / 100,
        'VAT (NPR)': Math.round(p.vat * 100) / 100, 'Net (NPR)': Math.round(p.net * 100) / 100,
        '% of Net Total': paymentTotals.net > 0 ? `${((p.net / paymentTotals.net) * 100).toFixed(1)}%` : '0%',
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Payment Summary')
      XLSX.writeFile(wb, `payment-summary-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'category') {
      const ws = withLetterhead('Sales Report - Category Wise', dateRangeLine, categoryRows.map(c => ({
        'Category': c.name, 'Qty Sales': c.qtySales, 'Qty Return': c.qtyReturn, 'Qty Net': c.qtySales - c.qtyReturn,
        'Gross (NPR)': Math.round(c.gross * 100) / 100, 'Discount (NPR)': Math.round(c.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(c.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(c.taxable * 100) / 100,
        'VAT (NPR)': Math.round(c.vat * 100) / 100, 'Net (NPR)': Math.round(categoryNetOf(c) * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Category Sales')
      XLSX.writeFile(wb, `category-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'item') {
      const ws = withLetterhead('Sales Report - Item Wise', dateRangeLine, itemRows.map(i => ({
        'Item': i.name, 'Qty Sales': i.qtySales, 'Qty Return': i.qtyReturn, 'Qty Net': i.qtySales - i.qtyReturn,
        'Gross (NPR)': Math.round(i.gross * 100) / 100, 'Discount (NPR)': Math.round(i.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(i.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(i.taxable * 100) / 100,
        'VAT (NPR)': Math.round(i.vat * 100) / 100, 'Net (NPR)': Math.round(itemNetOf(i) * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Item Sales')
      XLSX.writeFile(wb, `item-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'customer') {
      const ws = withLetterhead('Sales Report - Customer Wise', dateRangeLine, customerRows.map(c => ({
        'Customer Name': c.name, 'Mobile': c.phone, 'PAN': c.pan || '', 'Bills': c.bills,
        'Gross (NPR)': Math.round(c.gross * 100) / 100, 'Discount (NPR)': Math.round(c.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(c.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(c.taxable * 100) / 100,
        'VAT (NPR)': Math.round(c.vat * 100) / 100, 'Net Sales (NPR)': Math.round(c.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Customer Sales')
      XLSX.writeFile(wb, `customer-sales-${fromIso}-to-${toIso}.xlsx`)
    } else {
      const oneLakhRangeLine = `@Fiscal Year : ${selectedFy}  @Division : ${bizInfo.name}`
      const ws = withLetterhead('One Lakh Above Report (Annexure 13)', oneLakhRangeLine, parties.map(p => ({
        'Party Name': p.name, 'PAN': p.pan || '', 'Bill Count': p.bills,
        'Gross (NPR)': Math.round(p.gross * 100) / 100, 'Taxable (NPR)': Math.round(p.taxable * 100) / 100,
        'Non-Taxable (NPR)': Math.round(p.nonTaxable * 100) / 100, 'VAT (NPR)': Math.round(p.vat * 100) / 100,
        'Net (NPR)': Math.round(p.net * 100) / 100, 'Annexure 13 (>1L)': p.net > THRESHOLD ? (p.pan ? 'Yes' : 'Yes — MISSING PAN') : '',
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'One Lakh Above')
      XLSX.writeFile(wb, `one-lakh-above-${selectedFy.replace('/', '-')}.xlsx`)
    }
  }

  const loading = tab === 'onelakh' ? oneLakhLoading : rangeLoading
  const isEmpty =
    (tab === 'daily' && dailyRows.length === 0) ||
    (tab === 'hourly' && hourlyTotals.bills === 0) ||
    (tab === 'voucher' && voucherRows.length === 0) ||
    (tab === 'payment' && paymentRows.length === 0) ||
    (tab === 'category' && categoryRows.length === 0) ||
    (tab === 'item' && itemRows.length === 0) ||
    (tab === 'customer' && customerRows.length === 0) ||
    (tab === 'onelakh' && parties.length === 0)

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1150 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>
          Sales Report <Tip text="Eight views of the same POS sales data: Daily and Hourly show when revenue happens, Bill Register lists every individual voucher, Payment Summary breaks it down by how customers paid, Category, Item, and Customer show where it comes from, and 1L+ Report is the Nepal VAT Annexure 13 compliance check." width={320}>ⓘ</Tip>
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          One report, eight ways to slice it.
        </p>
      </div>

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.key} className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        {tab === 'onelakh' ? (
          <div>
            <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Fiscal Year (BS)</label>
            <select className="form-select" value={selectedFy} onChange={e => setSelectedFy(e.target.value)}>
              {fyOptions.map(fy => <option key={fy} value={fy}>{fy}</option>)}
            </select>
          </div>
        ) : (
          <>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>From (BS)</label>
              <BsCalendarPicker value={fromIso} onChange={setFromIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>To (BS)</label>
              <BsCalendarPicker value={toIso} onChange={setToIso} />
            </div>
          </>
        )}
        <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel} disabled={isEmpty}>⬇ Excel</button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : isEmpty ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {tab === 'onelakh' ? `No paid bills in FY ${selectedFy}.` : 'No paid bills in this range.'}
        </div>
      ) : tab === 'daily' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th style={{ textAlign: 'right' }}>Bills</th><th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {dailyRows.map(r => (
                <tr key={r.key}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.day} {BS_MONTHS[r.month - 1]} {r.year}</td>
                  <td style={{ textAlign: 'right' }}>{r.bills}</td>
                  <td style={{ textAlign: 'right' }}>{r.qty}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(r.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(r.discount)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(r.nonTaxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(r.taxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(r.vat)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(r.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{dailyTotals.bills}</td>
                <td style={{ textAlign: 'right' }}>{dailyTotals.qty}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(dailyTotals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(dailyTotals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(dailyTotals.nonTaxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(dailyTotals.taxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(dailyTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(dailyTotals.net)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : tab === 'hourly' ? (
        <>
          <ChartCard
            title="Net Sales by Hour"
            cardStyle={{ marginBottom: 24 }}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={hourlyChartData} margin={{ top: 0, right: 10, left: 0, bottom: 30 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED, fontSize: 11 }} angle={-45} textAnchor="end" interval={1} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} tickFormatter={v => `${Math.round(v / 1000)}k`} />
                  <Tooltip
                    contentStyle={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 8, fontSize: 12, color: '#e8e0d0' }}
                    labelStyle={{ color: '#e8e0d0' }} itemStyle={{ color: '#e8e0d0' }}
                    formatter={v => [fmtNpr(v), 'Net Sales']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={GOLD} />
                </BarChart>
              </ResponsiveContainer>
            )}
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Hour</th><th style={{ textAlign: 'right' }}>Bills</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Net Sales</th></tr></thead>
              <tbody>
                {hourlyRows.filter(h => h.bills > 0).map(h => (
                  <tr key={h.hour}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{hourLabel(h.hour)}</td>
                    <td style={{ textAlign: 'right' }}>{h.bills}</td>
                    <td style={{ textAlign: 'right' }}>{h.qty}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(h.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>TOTAL</td><td style={{ textAlign: 'right' }}>{hourlyTotals.bills}</td>
                  <td style={{ textAlign: 'right' }}>{hourlyTotals.qty}</td><td style={{ textAlign: 'right' }}>{fmtNpr(hourlyTotals.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : tab === 'voucher' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Voucher#</th><th>Invoice#</th><th>Customer</th><th>Payment Mode</th><th>Order Mode</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
                <th>Remarks</th><th>Entered By</th>
              </tr>
            </thead>
            <tbody>
              {voucherRows.map(v => {
                const bs = adToBs(new Date(v.closedAt))
                return (
                  <tr key={v.id}>
                    <td>{bs.day} {BS_MONTHS[bs.month - 1]} {bs.year}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>#{v.orderNo}</td>
                    <td>{v.invoiceNo || '—'}</td>
                    <td>{v.customer}{v.credited && <span className="badge-amber" style={{ fontSize: 10, marginLeft: 6 }}>Credit Noted</span>}</td>
                    <td>{v.payMethod}</td>
                    <td>{v.orderMode}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.gross)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.discount)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.nonTaxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.taxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.vat)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(v.net)}</td>
                    <td>{v.remarks || '—'}</td>
                    <td>{v.enteredBy}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={6}>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(voucherTotals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(voucherTotals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(voucherTotals.nonTaxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(voucherTotals.taxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(voucherTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(voucherTotals.net)}</td>
                <td></td><td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : tab === 'payment' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Payment Method</th><th style={{ textAlign: 'right' }}>Bills</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="This method's net sales as a share of total net sales in the range" width={220}>% of Net</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {paymentRows.map(p => (
                <tr key={p.method}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.method}</td>
                  <td style={{ textAlign: 'right' }}>{p.bills}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.discount)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.nonTaxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.taxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.vat)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(p.net)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{paymentTotals.net > 0 ? `${((p.net / paymentTotals.net) * 100).toFixed(1)}%` : '0%'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{paymentTotals.bills}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.nonTaxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.taxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.net)}</td>
                <td style={{ textAlign: 'right' }}>100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : tab === 'category' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Qty Sales</th><th style={{ textAlign: 'right' }}>Qty Return</th><th style={{ textAlign: 'right' }}>Qty Net</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {categoryRows.map(c => (
                <tr key={c.name}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{c.name}</td>
                  <td style={{ textAlign: 'right' }}>{c.qtySales}</td>
                  <td style={{ textAlign: 'right' }}>{c.qtyReturn}</td>
                  <td style={{ textAlign: 'right' }}>{c.qtySales - c.qtyReturn}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.discount)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.nonTaxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.taxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.vat)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(categoryNetOf(c))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{categoryTotals.qtySales}</td>
                <td style={{ textAlign: 'right' }}>{categoryTotals.qtyReturn}</td>
                <td style={{ textAlign: 'right' }}>{categoryTotals.qtySales - categoryTotals.qtyReturn}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(categoryTotals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(categoryTotals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(categoryTotals.nonTaxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(categoryTotals.taxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(categoryTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(categoryTotals.gross - categoryTotals.discount + categoryTotals.vat)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : tab === 'item' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>Qty Sales</th><th style={{ textAlign: 'right' }}>Qty Return</th><th style={{ textAlign: 'right' }}>Qty Net</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {itemRows.map(i => (
                <tr key={i.key}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{i.name}</td>
                  <td style={{ textAlign: 'right' }}>{i.qtySales}</td>
                  <td style={{ textAlign: 'right' }}>{i.qtyReturn}</td>
                  <td style={{ textAlign: 'right' }}>{i.qtySales - i.qtyReturn}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(i.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(i.discount)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(i.nonTaxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(i.taxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(i.vat)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(itemNetOf(i))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{itemTotals.qtySales}</td>
                <td style={{ textAlign: 'right' }}>{itemTotals.qtyReturn}</td>
                <td style={{ textAlign: 'right' }}>{itemTotals.qtySales - itemTotals.qtyReturn}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(itemTotals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(itemTotals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(itemTotals.nonTaxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(itemTotals.taxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(itemTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(itemTotals.gross - itemTotals.discount + itemTotals.vat)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : tab === 'customer' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Customer Name</th><th>Mobile</th><th>PAN</th><th style={{ textAlign: 'right' }}>Bills</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net Sales</th>
              </tr>
            </thead>
            <tbody>
              {customerRows.map(c => (
                <tr key={c.key}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{c.name}</td>
                  <td>{c.phone || '—'}</td>
                  <td>{c.pan || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{c.bills}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.discount)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.nonTaxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.taxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(c.vat)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(c.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={4}>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(customerTotals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(customerTotals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(customerTotals.nonTaxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(customerTotals.taxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(customerTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(customerTotals.net)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Party Name</th><th>PAN</th><th style={{ textAlign: 'right' }}>Bills</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>VAT</th>
                <th style={{ textAlign: 'right' }}>Net</th>
                <th><Tip text="Rows above NPR 1,00,000 must be disclosed in Annexure 13 of the VAT return. A missing PAN on a flagged row means the party's name alone was recorded — ask for PAN on their next visit." width={280}>Flag</Tip></th>
              </tr>
            </thead>
            <tbody>
              {parties.map(p => {
                const over = p.net > THRESHOLD
                return (
                  <tr key={p.key}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{p.name}</td>
                    <td>{p.pan || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{p.bills}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.gross)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.taxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.nonTaxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.vat)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(p.net)}</td>
                    <td>
                      {over && !p.pan && <span className="badge-red" style={{ fontSize: 11 }}>⚠ Missing PAN</span>}
                      {over && p.pan && <span className="badge-amber" style={{ fontSize: 11 }}>Annexure 13</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={3}>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(oneLakhTotals.gross)}</td>
                <td></td><td></td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(oneLakhTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(oneLakhTotals.net)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
