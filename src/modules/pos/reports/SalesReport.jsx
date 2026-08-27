import { useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { chartMotion } from '../../../shared/chartMotion'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import ChartCard from '../../../components/ChartCard'
import { getBsToday, formatAd, adToBs, BS_MONTHS, getBsFiscalYear } from '../../../utils/bsCalendar'
import { computeOrderAmounts, computeGroupAmounts } from '../../../utils/posBillingMath'
import { viewPosBill } from '../../../utils/viewPosBill'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { PAYMENT_METHODS } from '../orders/posOrdersConstants'

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
  { key: 'compxref', label: 'Comped Bills' },
  { key: 'payment',  label: 'Payment Summary' },
  { key: 'delivery', label: 'Delivery Partners' },
  { key: 'category', label: 'Category Wise' },
  { key: 'producttype', label: 'Product Type' },
  { key: 'item',     label: 'Item Wise' },
  { key: 'customer', label: 'Customer Wise' },
  { key: 'onelakh',  label: '1L+ Report' },
]
// Was its own hardcoded copy of the tender-type list (drifted from posOrdersConstants.js) — a
// new payment method added there would have silently sorted last here instead of vanishing
// outright (grouping itself is dynamic), but still worth deriving from the same source of truth.
// 'Loyalty' is appended here but is deliberately absent from PAYMENT_METHODS: that constant is
// the list a cashier can PICK, and a points redemption is not picked — it is applied when the
// customer has a balance (S290->S291 learned the same distinction with Foodmandu/Pathao). It has
// to be in THIS list though, because the breakdown below only accumulates methods it already
// knows: `if (byMethod[p.payment_method] !== undefined)` silently drops anything else, so a
// redeemed bill would leave the method breakdown short of the bill total with nothing saying so.
const PAY_METHOD_ORDER = [...PAYMENT_METHODS, 'Loyalty', 'Credit']

export default function SalesReport() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const today = getBsToday()
  const currentFy = getBsFiscalYear(today.year, today.month)

  const [tab, setTab] = useState('daily')
  // Drill-down from Payment Summary → Bill Register: clicking a payment-method row filters the
  // Bill Register tab down to just that method's bills. Cleared on any direct tab-bar click so a
  // manual visit to Bill Register always starts unfiltered.
  const [paymentFilter, setPaymentFilter] = useState(null)
  // Delivery Partners tab: 'all' or one partner name. Drives the KPI cards, the bill table and
  // the Excel export together - and the export's scope line says which, since a filtered sheet
  // that doesn't state its filter can't be reconciled later (S594). The per-partner rollup above
  // them deliberately ignores it: that table IS the who-owes-what answer, and filtering it away
  // would remove the comparison the filter exists to drill into.
  const [partnerFilter, setPartnerFilter] = useState('all')

  /* ── Letterhead info for Excel exports — fetched once per client, independent of date range ── */
  const [bizInfo, setBizInfo] = useState({ name: '', vat: '', address: '' })
  // recipes.is_veg backs one of the Product Type tab's axes. Master data, so it rides along with
  // the letterhead fetch (once per client) rather than the date-range one, and needs no paging —
  // no client's menu comes close to PostgREST's 1000-row cap.
  const [vegById, setVegById] = useState({})
  // recipe_code → shown as the Product Code column on the Item Wise tab. Rides the same once-per-
  // client master-data fetch as is_veg.
  const [codeById, setCodeById] = useState({})
  // { partnerName: agreedCommissionPct | null } - see the settings fetch below.
  const [partnerRates, setPartnerRates] = useState({})
  useEffect(() => {
    if (!clientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('vat_number, property_address, pos_delivery_partners').eq('client_id', clientId).maybeSingle(),
      scopedFrom('recipes', 'id, is_veg, recipe_code'),
    ]).then(results => {
      // S612 silent-zero rule: a failed read here isn't cosmetic — it blanks the letterhead and
      // silently drops every Agreed % commission check on the Delivery Partners tab.
      const failed = firstError(results)
      if (failed) { setRangeError(failed); return }
      const [{ data: client }, { data: settings }, { data: recipeRows }] = results
      setBizInfo({ name: client?.name || '', vat: settings?.vat_number || '', address: settings?.property_address || '' })
      // The CONTRACTED commission rate per partner (Table Management -> Delivery Partners). It is
      // the only thing a settled bill's actual commission can be checked against - without it the
      // Delivery Partners tab can say how much a platform took but never whether that was right.
      setPartnerRates(Object.fromEntries((settings?.pos_delivery_partners || [])
        .filter(p => p?.name)
        .map(p => [p.name, p.commission_pct === '' || p.commission_pct == null ? null : parseFloat(p.commission_pct)])))
      setVegById(Object.fromEntries((recipeRows || []).map(r => [r.id, r.is_veg])))
      setCodeById(Object.fromEntries((recipeRows || []).map(r => [r.id, r.recipe_code])))
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  /* ── Daily / Hourly / Category / Customer — one shared date-range fetch ── */
  const [fromIso, setFromIso] = useState(formatAd(new Date()))
  const [toIso,   setToIso]   = useState(formatAd(new Date()))
  const [orders, setOrders] = useState([])
  const [itemsByOrder, setItemsByOrder] = useState({})
  const [compsByOrder, setCompsByOrder] = useState({}) // { order_id: [{ compNo, reason, items, foodCost, potentialValue }] }
  const [vatReg, setVatReg] = useState(true)
  // The same Kitchen/Bar split the tills route tickets by (Table Management → Ticket Routing),
  // and the same ['Beverage'] fallback PosOrders.jsx and PosTableManagement.jsx use — if this
  // page disagreed with them, the Bar figure would not match the BOT tickets it came from.
  const [botCategories, setBotCategories] = useState(new Set(['Beverage']))
  const [staffNames, setStaffNames] = useState({})
  const [rangeLoading, setRangeLoading] = useState(true)
  // S612 silent-zero rule: a failed read must render as a failure, never as an empty range.
  // Two error states because the page runs two independent pipelines (date-range vs 1L+ FY),
  // mirroring the rangeLoading/oneLakhLoading split below.
  const [rangeError, setRangeError] = useState(null)

  const loadRange = useCallback(async () => {
    if (!clientId) return
    setRangeLoading(true)
    setRangeError(null)
    const fromTs = new Date(fromIso + 'T00:00:00').toISOString()
    const toTs   = new Date(toIso + 'T23:59:59.999').toISOString()

    const results = await Promise.all([
      // Paged: the child pos_order_items read below was already wrapped (S529) while this parent
      // was not, so on a busy month every one of this page's ten tabs silently reported the first
      // 1000 bills as if they were all of them — a believable total, not an error.
      fetchAllRows(() => scopedFrom('pos_orders', 'id, order_no, invoice_no, buyer_name, buyer_pan, buyer_phone, discount_amount, closed_at, credit_note_id, payment_method, delivery_partner, commission_amount, credit_settled_at, credit_settled_method, paid_amount, bill_remarks, closed_by, table_name')
        .eq('close_type', 'paid')
        .gte('closed_at', fromTs).lte('closed_at', toTs)
        .order('id')),
      supabase.from('settings').select('is_vat_registered, pos_bot_categories').eq('client_id', clientId).maybeSingle(),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin)
      // — resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
    ])
    // S612 silent-zero rule: a failed read here would run every tab's arithmetic over `|| []`
    // and render a confident report of NPR 0, visually identical to a quiet range.
    const rangeFailed = firstError(results)
    if (rangeFailed) {
      setRangeError(rangeFailed)
      setOrders([]); setItemsByOrder({}); setCompsByOrder({})
      setRangeLoading(false)
      return
    }
    const [{ data: orderData }, { data: settings }, { data: profs }] = results
    setVatReg(settings?.is_vat_registered ?? true)
    setBotCategories(new Set(Array.isArray(settings?.pos_bot_categories) && settings.pos_bot_categories.length > 0
      ? settings.pos_bot_categories : ['Beverage']))
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    const orderList = orderData || []
    setOrders(orderList)

    let byOrder = {}
    let compsByOrderNext = {}
    if (orderList.length > 0) {
      // Excludes item-level comps (comped=true) — those never billed at menu price (they print
      // on their own Complimentary Slip instead, see PosOrders.jsx), so every tab built from
      // itemsByOrder must exclude them too or Gross/Taxable/Net overstate actual revenue.
      // Paged: pos_order_items is the highest-volume table in the app — one row per line per
      // bill, so a month of ordinary service runs to thousands and blows straight past
      // PostgREST's silent 1000-row cap. Truncated, every figure on this page would be built
      // from roughly the first tenth of the month while looking like a full month (S529).
      const { data: items, error: itemsError } = await fetchAllRows(() => scopedFrom('pos_order_items', 'order_id, recipe_id, name, category, qty, unit_price, vat_rate, comped, comp_no, comp_reason').in('order_id', orderList.map(o => o.id)).order('id'))
      // S612 silent-zero rule: with the parent orders loaded but the lines dropped, every figure
      // built from itemsByOrder would be a believable zero.
      if (itemsError) {
        setRangeError(itemsError.message || String(itemsError))
        setOrders([]); setItemsByOrder({}); setCompsByOrder({})
        setRangeLoading(false)
        return
      }
      byOrder = (items || []).filter(i => !i.comped).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})

      // Comped-out rows aren't discarded — they feed the "Comped Bills" cross-reference tab and
      // the Bill Register badge, both of which need to know which paid bills had an item comped
      // out of them and what NC number that comp got.
      const compedItems = (items || []).filter(i => i.comped)
      if (compedItems.length > 0) {
        const recipeIds = [...new Set(compedItems.map(i => i.recipe_id).filter(Boolean))]
        const costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}
        const groups = {}
        for (const i of compedItems) {
          const key = `${i.order_id}:${i.comp_no}`
          const g = groups[key] = groups[key] || {
            orderId: i.order_id, compNo: i.comp_no, reason: i.comp_reason || '—',
            items: [], foodCost: 0, potentialValue: 0,
          }
          g.items.push(i)
          g.foodCost += i.qty * (costMap[i.recipe_id] || 0)
          g.potentialValue += i.qty * i.unit_price * (1 + (i.vat_rate ?? 0))
        }
        for (const g of Object.values(groups)) {
          (compsByOrderNext[g.orderId] = compsByOrderNext[g.orderId] || []).push(g)
        }
      }
    }
    setItemsByOrder(byOrder)
    setCompsByOrder(compsByOrderNext)
    setRangeLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom])

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
        compNos: (compsByOrder[o.id] || []).map(c => c.compNo),
        gross: amounts.grossAmt, discount: amounts.discount, taxable: amounts.taxableBase,
        nonTaxable: amounts.nonTaxableBase, vat: amounts.vatAmt, net: amounts.net,
      }
    }).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
  }, [orders, itemsByOrder, compsByOrder, vatReg, staffNames])

  // Drill-down target for Payment Summary — same rows, narrowed to one payment method.
  const filteredVoucherRows = useMemo(() => (
    paymentFilter ? voucherRows.filter(v => v.payMethod === paymentFilter) : voucherRows
  ), [voucherRows, paymentFilter])

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

  // Foodmandu/Pathao bills — these close as Credit (see PosOrders.jsx: the platform doesn't pay
  // at the counter, it remits later minus commission, so it's a receivable like any other Credit
  // customer), tagged via delivery_partner rather than payment_method. Commission/settlement
  // come from Customers → Outstanding Credit → Settle, not Charge time, so an unsettled row here
  // has no commission/net-received yet — that's expected, not missing data.
  // Unlike Bill Register (an invoice-number ledger), this is a working settlement-tracking list —
  // a credited order has nothing left to settle/commission on, so it's excluded entirely rather
  // than kept with a badge (same exclusion rule as dailyRows/paymentRows).
  const deliveryPartnerRows = useMemo(() => (
    orders
      .filter(o => o.delivery_partner && !o.credit_note_id)
      .map(o => {
        // exVatBase is the basis commission is actually withheld on - the bill's ex-VAT,
        // post-discount value with comped lines excluded - NOT paid_amount. That is what
        // PosCustomers.jsx settles against (both platforms calculate on it), so an effective
        // rate measured off the VAT-inclusive total would read ~13% low on every bill of a
        // VAT-registered client and report every partner as under-remitting.
        const a = computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg)
        return {
          id: o.id, orderNo: o.order_no, invoiceNo: o.invoice_no, closedAt: o.closed_at,
          deliveryPartner: o.delivery_partner, tableName: o.table_name,
          amount: o.paid_amount || 0,
          exVatBase: a.taxableBase + a.nonTaxableBase,
          settled: !!o.credit_settled_at, settledAt: o.credit_settled_at, settledMethod: o.credit_settled_method,
          commission: parseFloat(o.commission_amount) || 0,
        }
      })
      .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
  ), [orders, itemsByOrder, vatReg])

  // One row per partner. Until this existed the tab could only answer "how much delivery business
  // did we do" - "what does Foodmandu owe me, and what has Pathao taken" meant reading down the
  // Partner column and adding it up by eye, and nowhere else in the product grouped by partner
  // either (Customers -> Outstanding Credit is bill-by-bill too, so it was the same gap twice).
  //
  // Built from ALL delivery rows, never the filtered ones: this table is the index the partner
  // filter drills down FROM.
  //
  // effectivePct is measured over SETTLED bills only, base and commission alike. An outstanding
  // bill has no commission yet by design (it's recorded at settlement, not at Charge), so letting
  // its base into the denominator would drag every partner's rate toward zero mid-month and
  // manufacture a discrepancy out of nothing.
  const deliveryPartnerSummary = useMemo(() => {
    const grouped = {}
    for (const r of deliveryPartnerRows) {
      const g = grouped[r.deliveryPartner] = grouped[r.deliveryPartner] || {
        partner: r.deliveryPartner, bills: 0, amount: 0, outstandingBills: 0, outstanding: 0,
        settledBills: 0, settledBase: 0, commission: 0, netReceived: 0,
      }
      g.bills += 1
      g.amount += r.amount
      if (r.settled) {
        g.settledBills += 1
        g.settledBase += r.exVatBase
        g.commission += r.commission
        g.netReceived += r.amount - r.commission
      } else {
        g.outstandingBills += 1
        g.outstanding += r.amount
      }
    }
    return Object.values(grouped).map(g => {
      const rate = partnerRates[g.partner]
      const agreedPct = rate == null || Number.isNaN(rate) ? null : rate
      const effectivePct = g.settledBase > 0 ? (g.commission / g.settledBase) * 100 : null
      return {
        ...g, agreedPct, effectivePct,
        // Expected commission at the contracted rate, so the gap can be stated in rupees - a
        // percentage point means nothing to someone chasing a platform's remittance statement.
        expectedCommission: agreedPct != null ? g.settledBase * agreedPct / 100 : null,
        // Two tolerances, because either one alone raises false alarms. Each bill's commission is
        // rounded to the rupee at settlement (PosCustomers.jsx), so a partner charging exactly its
        // agreed rate still lands up to NPR 0.5 off PER BILL - on a handful of small delivery bills
        // that is a visible percentage swing. So: flag only when the gap is both worth more than
        // rounding can explain AND at least half a point wide.
        offRate: agreedPct != null && effectivePct != null
          && Math.abs(effectivePct - agreedPct) >= 0.5
          && Math.abs(g.commission - g.settledBase * agreedPct / 100) > Math.max(1, g.settledBills * 0.5),
      }
    }).sort((a, b) => b.amount - a.amount)
  }, [deliveryPartnerRows, partnerRates])

  const deliverySummaryTotals = deliveryPartnerSummary.reduce((s, g) => ({
    bills: s.bills + g.bills, amount: s.amount + g.amount,
    outstanding: s.outstanding + g.outstanding, settledBase: s.settledBase + g.settledBase,
    commission: s.commission + g.commission, netReceived: s.netReceived + g.netReceived,
  }), { bills: 0, amount: 0, outstanding: 0, settledBase: 0, commission: 0, netReceived: 0 })

  const visibleDeliveryRows = partnerFilter === 'all'
    ? deliveryPartnerRows
    : deliveryPartnerRows.filter(r => r.deliveryPartner === partnerFilter)

  // A partner selected under one date range can have no bills under the next one, which would
  // leave the select showing a name that matches nothing and an empty table under it.
  useEffect(() => {
    if (partnerFilter !== 'all' && !deliveryPartnerRows.some(r => r.deliveryPartner === partnerFilter)) {
      setPartnerFilter('all')
    }
  }, [deliveryPartnerRows, partnerFilter])

  const deliveryPartnerTotals = visibleDeliveryRows.reduce((s, r) => ({
    bills: s.bills + 1,
    amount: s.amount + r.amount,
    outstanding: s.outstanding + (r.settled ? 0 : r.amount),
    commission: s.commission + (r.settled ? r.commission : 0),
    netReceived: s.netReceived + (r.settled ? r.amount - r.commission : 0),
  }), { bills: 0, amount: 0, outstanding: 0, commission: 0, netReceived: 0 })

  // One builder behind Category Wise, Item Wise and Product Type - they differ only in which
  // bucket a line falls into and what that bucket is called. The credit-note branch is part of
  // the rule rather than incidental: a credit-noted bill contributes returned QUANTITY only and
  // never revenue, since the reversal posts on the day the note is issued (see dailyRows). Three
  // hand-written copies of that is how the tabs would come to disagree about a return.
  const buildGroupedRows = useCallback((keyOf, labelOf) => {
    const grouped = {}
    const ensure = (key, name) => grouped[key] = grouped[key] || { key, name, qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 }
    for (const o of orders) {
      const items = itemsByOrder[o.id] || []
      if (o.credit_note_id) {
        for (const i of items) ensure(keyOf(i), labelOf(i)).qtyReturn += i.qty
        continue
      }
      const byKey = computeGroupAmounts(o, items, vatReg, keyOf, i => ({ name: labelOf(i) }))
      for (const [key, v] of Object.entries(byKey)) {
        const b = ensure(key, v.name)
        b.qtySales += v.qty; b.gross += v.gross; b.discount += v.discount
        b.taxable += v.taxable; b.nonTaxable += v.nonTaxable; b.vat += v.vat
      }
    }
    return Object.values(grouped).sort((a, b) => (b.gross - b.discount + b.vat) - (a.gross - a.discount + a.vat))
  }, [orders, itemsByOrder, vatReg])

  const categoryRows = useMemo(
    () => buildGroupedRows(i => i.category || 'Uncategorized', i => i.category || 'Uncategorized'),
    [buildGroupedRows])

  const itemRows = useMemo(
    () => buildGroupedRows(i => i.recipe_id || i.name, i => i.name),
    [buildGroupedRows])

  /* -- Product Type: the same bill data cut by an axis ABOVE category ----------------------
     Crest has one menu axis (recipes.category) where the competitor ERP has two, so 'Product
     Type' has to be a real second axis rather than a rename of the first. All three below
     already exist in the data and none was reportable before: the Kitchen/Bar split the tills
     route tickets by, the VAT mode each line was billed at, and the veg flag set in Recipes. */
  const [productAxis, setProductAxis] = useState('station')
  const hasVegData = useMemo(() => Object.values(vegById).some(v => v === true || v === false), [vegById])
  // An axis that can only ever produce one row is hidden rather than rendered empty: VAT Mode
  // collapses to a single Non-Taxable row for a client that is not VAT-registered, and Veg/
  // Non-Veg to a single 'Not set' row until someone has actually set the flag on a recipe.
  const productAxes = useMemo(() => [
    { key: 'station', label: 'Kitchen / Bar' },
    ...(vatReg ? [{ key: 'vat', label: 'VAT Mode' }] : []),
    ...(hasVegData ? [{ key: 'veg', label: 'Veg / Non-Veg' }] : []),
  ], [vatReg, hasVegData])
  useEffect(() => {
    if (!productAxes.some(a => a.key === productAxis)) setProductAxis('station')
  }, [productAxes, productAxis])

  const productTypeKeyOf = useCallback(i => {
    if (productAxis === 'vat') return (i.vat_rate ?? 0) > 0 ? 'Taxable' : 'Non-Taxable'
    if (productAxis === 'veg') {
      const v = vegById[i.recipe_id]
      return v === true ? 'Veg' : v === false ? 'Non-Veg' : 'Not set'
    }
    // Matches sendTicket()'s own rule in PosOrders.jsx exactly, default category included, so
    // the Bar figure here is the same set of lines that printed on BOT tickets.
    return botCategories.has(i.category || 'Other') ? 'Bar (BOT)' : 'Kitchen (KOT)'
  }, [productAxis, vegById, botCategories])

  const productTypeRows = useMemo(
    () => buildGroupedRows(productTypeKeyOf, productTypeKeyOf),
    [buildGroupedRows, productTypeKeyOf])

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

  // Bill ↔ Comp cross-reference — one row per comp event (an order can have more than one, though
  // rare), joined back to the paid bill it was carved out of. `orders` here is already scoped to
  // close_type='paid' within the date range (see loadRange), so every order in it has a real
  // invoice_no to show.
  const compedBillRows = useMemo(() => {
    const rows = []
    for (const o of orders) {
      for (const c of compsByOrder[o.id] || []) {
        rows.push({
          key: `${o.id}:${c.compNo}`, orderId: o.id, orderNo: o.order_no, invoiceNo: o.invoice_no,
          closedAt: o.closed_at, tableName: o.table_name, compNo: c.compNo, reason: c.reason,
          itemNames: c.items.map(i => `${i.qty}x ${i.name}`).join(', '),
          foodCost: c.foodCost, potentialValue: c.potentialValue,
        })
      }
    }
    return rows.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
  }, [orders, compsByOrder])

  /* ── One Lakh Above (Annexure 13) — fiscal-year scoped, separate from the date-range pipeline ── */
  const [fyOptions, setFyOptions] = useState([currentFy])
  const [selectedFy, setSelectedFy] = useState(currentFy)
  const [parties, setParties] = useState([])
  const [oneLakhLoading, setOneLakhLoading] = useState(true)
  const [oneLakhError, setOneLakhError] = useState(null)

  useEffect(() => {
    if (!clientId) return
    // Paged: this builds the fiscal-year dropdown, so a truncated read makes older fiscal years
    // simply not appear as options — the 1L+ report for a past year then can't be opened at all.
    // One narrow column, once per page load, so the extra round trips are cheap.
    fetchAllRows(() => scopedFrom('pos_orders', 'invoice_fy').not('invoice_fy', 'is', null).order('id'))
      .then(({ data, error }) => {
        // S612 silent-zero rule: a failed read here silently drops past fiscal years from the picker.
        if (error) { setOneLakhError(error.message || String(error)); return }
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
    setOneLakhError(null)
    const results = await Promise.all([
      // Paged for the same reason the item read below it already was: this feeds the IRD
      // Annexure 13 one-lakh threshold over a whole fiscal year, so a truncated read drops a
      // party below the threshold and understates a statutory disclosure.
      fetchAllRows(() => scopedFrom('pos_orders', 'id, buyer_name, buyer_pan, discount_amount')
        .eq('status', 'billed').eq('close_type', 'paid').eq('invoice_fy', selectedFy)
        // Credit-noted bills are excluded — a corrected/cancelled invoice must not push a party
        // over the Annexure 13 one-lakh disclosure threshold.
        .is('credit_note_id', null)
        .order('id')),
      supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
    ])
    // S612 silent-zero rule — and this one feeds an IRD Annexure 13 disclosure, where a silent
    // zero reads as "no party crossed one lakh".
    const oneLakhFailed = firstError(results)
    if (oneLakhFailed) {
      setOneLakhError(oneLakhFailed)
      setParties([])
      setOneLakhLoading(false)
      return
    }
    const [{ data: fyOrders }, { data: settings }] = results
    const vr = settings?.is_vat_registered ?? true
    const list = fyOrders || []

    let byOrder = {}
    if (list.length > 0) {
      // Same comped exclusion as loadRange above — an item-level comp isn't part of what the
      // party actually paid, so it can't count toward their Annexure 13 one-lakh threshold.
      // Paged for the same reason as loadRange above — and this one feeds an IRD Annexure 13
      // threshold, so a truncated read could drop a customer below one lakh incorrectly (S529).
      const { data: items, error: itemsError } = await fetchAllRows(() => scopedFrom('pos_order_items', 'order_id, qty, unit_price, vat_rate, comped').in('order_id', list.map(o => o.id)).order('id'))
      // S612 silent-zero rule: lines missing means every party's net reads zero — below threshold.
      if (itemsError) {
        setOneLakhError(itemsError.message || String(itemsError))
        setParties([])
        setOneLakhLoading(false)
        return
      }
      byOrder = (items || []).filter(i => !i.comped).reduce((acc, i) => {
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
  }, [clientId, selectedFy, scopedFrom])

  // Lazy — the FY-wide fetch (every paid order + all its items) only runs once the tab is opened
  useEffect(() => { if (tab === 'onelakh') loadOneLakh() }, [tab, loadOneLakh])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const dailyTotals = dailyRows.reduce((s, r) => ({ bills: s.bills + r.bills, qty: s.qty + r.qty, gross: s.gross + r.gross, discount: s.discount + r.discount, taxable: s.taxable + r.taxable, nonTaxable: s.nonTaxable + r.nonTaxable, vat: s.vat + r.vat, net: s.net + r.net }), { bills: 0, qty: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const hourlyTotals = hourlyRows.reduce((s, h) => ({ bills: s.bills + h.bills, qty: s.qty + h.qty, net: s.net + h.net }), { bills: 0, qty: 0, net: 0 })
  // Rows stay visible even when credited (Bill Register is an invoice-number ledger — every
  // issued sequential number must be accounted for, reversed or not — see the "Credit Noted"
  // badge on the row itself), but the footer TOTAL excludes them, same exclusion rule as every
  // other tab, so this tab's total reconciles with Daily/Payment/Category/Customer instead of
  // double-counting a bill whose revenue was already reversed.
  const voucherTotals = filteredVoucherRows.filter(v => !v.credited).reduce((s, v) => ({ gross: s.gross + v.gross, discount: s.discount + v.discount, taxable: s.taxable + v.taxable, nonTaxable: s.nonTaxable + v.nonTaxable, vat: s.vat + v.vat, net: s.net + v.net }), { gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const paymentTotals = paymentRows.reduce((s, p) => ({ bills: s.bills + p.bills, gross: s.gross + p.gross, discount: s.discount + p.discount, taxable: s.taxable + p.taxable, nonTaxable: s.nonTaxable + p.nonTaxable, vat: s.vat + p.vat, net: s.net + p.net }), { bills: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const groupNetOf = r => r.gross - r.discount + r.vat
  const totalsOf = rows => rows.reduce((s, r) => ({ qtySales: s.qtySales + r.qtySales, qtyReturn: s.qtyReturn + r.qtyReturn, gross: s.gross + r.gross, discount: s.discount + r.discount, taxable: s.taxable + r.taxable, nonTaxable: s.nonTaxable + r.nonTaxable, vat: s.vat + r.vat }), { qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 })
  const categoryNetOf = groupNetOf
  const itemNetOf = groupNetOf
  const categoryTotals = totalsOf(categoryRows)
  const itemTotals = totalsOf(itemRows)
  const productTypeTotals = totalsOf(productTypeRows)
  const customerTotals = customerRows.reduce((s, c) => ({ gross: s.gross + c.gross, discount: s.discount + c.discount, taxable: s.taxable + c.taxable, nonTaxable: s.nonTaxable + c.nonTaxable, vat: s.vat + c.vat, net: s.net + c.net }), { gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const compedBillTotals = compedBillRows.reduce((s, c) => ({ foodCost: s.foodCost + c.foodCost, potentialValue: s.potentialValue + c.potentialValue }), { foodCost: 0, potentialValue: 0 })
  const oneLakhTotals = parties.reduce((s, p) => ({ gross: s.gross + p.gross, vat: s.vat + p.vat, net: s.net + p.net }), { gross: 0, vat: 0, net: 0 })

  const hourlyChartData = hourlyRows.map(h => ({ name: hourLabel(h.hour), value: h.net }))
  const hourlyTotalNet = hourlyRows.reduce((s, h) => s + h.net, 0)
  const hourlyPeak = hourlyRows.reduce((best, h) => h.net > best.net ? h : best, hourlyRows[0])

  // Printable-statutory-document look (Company Name/VAT/Address letterhead + date-range line baked
  // into the sheet itself), matching the format competitor ERP exports use — see [[pos_reports_gap_list]].
  function withLetterhead(XLSX, title, rangeLine, dataRows) {
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

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    if (tab === 'daily') {
      const ws = withLetterhead(XLSX, 'Sales Report - Daily', dateRangeLine, dailyRows.map(r => ({
        'Date (BS)': `${r.day} ${BS_MONTHS[r.month - 1]} ${r.year}`, 'Bills': r.bills, 'Qty': r.qty,
        'Gross (NPR)': Math.round(r.gross * 100) / 100, 'Discount (NPR)': Math.round(r.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(r.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(r.taxable * 100) / 100,
        'VAT (NPR)': Math.round(r.vat * 100) / 100, 'Net (NPR)': Math.round(r.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Daily Sales')
      XLSX.writeFile(wb, `daily-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'hourly') {
      const ws = withLetterhead(XLSX, 'Sales Report - Hourly', dateRangeLine, hourlyRows.map(h => ({ 'Hour': hourLabel(h.hour), 'Bills': h.bills, 'Qty': h.qty, 'Net Sales (NPR)': Math.round(h.net * 100) / 100 })))
      XLSX.utils.book_append_sheet(wb, ws, 'Hourly Sales')
      XLSX.writeFile(wb, `hourly-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'voucher') {
      const ws = withLetterhead(XLSX, 'Sales Book Report', dateRangeLine, filteredVoucherRows.map(v => {
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
    } else if (tab === 'compxref') {
      const ws = withLetterhead(XLSX, 'Comped Bills', dateRangeLine, compedBillRows.map(c => {
        const bs = adToBs(new Date(c.closedAt))
        return {
          'Date (BS)': `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`,
          'Bill No': c.invoiceNo != null ? `#${c.invoiceNo}` : `Order #${c.orderNo}`,
          'NC No': `NC-${String(c.compNo).padStart(2, '0')}`, 'Table': c.tableName || 'Takeaway',
          'Items Comped': c.itemNames,
          'Food Cost (NPR)': Math.round(c.foodCost * 100) / 100,
          'Potential Value (NPR)': Math.round(c.potentialValue * 100) / 100,
          'Reason': c.reason,
        }
      }))
      XLSX.utils.book_append_sheet(wb, ws, 'Comped Bills')
      XLSX.writeFile(wb, `comped-bills-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'payment') {
      const ws = withLetterhead(XLSX, 'Sales Report - Payment Summary', dateRangeLine, paymentRows.map(p => ({
        'Payment Method': p.method, 'Bills': p.bills,
        'Gross (NPR)': Math.round(p.gross * 100) / 100, 'Discount (NPR)': Math.round(p.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(p.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(p.taxable * 100) / 100,
        'VAT (NPR)': Math.round(p.vat * 100) / 100, 'Net (NPR)': Math.round(p.net * 100) / 100,
        '% of Net Total': paymentTotals.net > 0 ? `${((p.net / paymentTotals.net) * 100).toFixed(1)}%` : '0%',
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Payment Summary')
      XLSX.writeFile(wb, `payment-summary-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'delivery') {
      // Two sheets, because they answer different questions and the second one can be filtered:
      // By Partner is always every partner (it's the reconciliation), Bills follows whatever the
      // screen is showing. Each states its own scope in the letterhead rather than relying on the
      // reader to remember what was selected when they pressed the button.
      const wsSummary = withLetterhead(XLSX, 'Sales Report - Delivery Partners (By Partner)', `${dateRangeLine}  @Partner : All partners`, deliveryPartnerSummary.map(g => ({
        'Partner': g.partner, 'Bills': g.bills,
        'Gross (NPR)': Math.round(g.amount * 100) / 100,
        'Outstanding Bills': g.outstandingBills,
        'Outstanding (NPR)': Math.round(g.outstanding * 100) / 100,
        'Settled Bills': g.settledBills,
        'Commission Base, ex-VAT (NPR)': Math.round(g.settledBase * 100) / 100,
        'Commission (NPR)': Math.round(g.commission * 100) / 100,
        'Effective %': g.effectivePct == null ? '' : `${g.effectivePct.toFixed(2)}%`,
        'Agreed %': g.agreedPct == null ? '' : `${g.agreedPct}%`,
        'Variance vs Agreed (NPR)': g.expectedCommission == null || g.settledBills === 0 ? '' : Math.round((g.commission - g.expectedCommission) * 100) / 100,
        'Net Received (NPR)': Math.round(g.netReceived * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, wsSummary, 'By Partner')
      const partnerScope = partnerFilter === 'all' ? 'All partners' : partnerFilter
      const ws = withLetterhead(XLSX, 'Sales Report - Delivery Partners', `${dateRangeLine}  @Partner : ${partnerScope}`, visibleDeliveryRows.map(r => {
        const bs = adToBs(new Date(r.closedAt))
        const billPct = r.settled && r.exVatBase > 0 ? (r.commission / r.exVatBase) * 100 : null
        return {
          'Date (BS)': `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`,
          'Bill No': r.invoiceNo != null ? `#${r.invoiceNo}` : `Order #${r.orderNo}`,
          'Partner': r.deliveryPartner, 'Table': r.tableName || 'Takeaway',
          'Amount (NPR)': Math.round(r.amount * 100) / 100,
          'Commission Base, ex-VAT (NPR)': Math.round(r.exVatBase * 100) / 100,
          'Status': r.settled ? 'Settled' : 'Outstanding',
          'Commission (NPR)': r.settled ? Math.round(r.commission * 100) / 100 : '',
          'Comm. %': billPct == null ? '' : `${billPct.toFixed(2)}%`,
          'Net Received (NPR)': r.settled ? Math.round((r.amount - r.commission) * 100) / 100 : '',
          'Settled Via': r.settled ? r.settledMethod : '',
        }
      }))
      XLSX.utils.book_append_sheet(wb, ws, 'Bills')
      const partnerSlug = partnerFilter === 'all' ? '' : `${partnerFilter.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`
      XLSX.writeFile(wb, `delivery-partners-${partnerSlug}${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'category') {
      const ws = withLetterhead(XLSX, 'Sales Report - Category Wise', dateRangeLine, categoryRows.map(c => ({
        'Category': c.name, 'Qty Sales': c.qtySales, 'Qty Return': c.qtyReturn, 'Qty Net': c.qtySales - c.qtyReturn,
        'Gross (NPR)': Math.round(c.gross * 100) / 100, 'Discount (NPR)': Math.round(c.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(c.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(c.taxable * 100) / 100,
        'VAT (NPR)': Math.round(c.vat * 100) / 100, 'Net (NPR)': Math.round(categoryNetOf(c) * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Category Sales')
      XLSX.writeFile(wb, `category-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'producttype') {
      // The axis is named in the sheet title: an exported file that just said 'Product Type'
      // would be ambiguous about which of the three cuts it holds.
      const axisLabel = productAxes.find(a => a.key === productAxis)?.label || 'Kitchen / Bar'
      const ws = withLetterhead(XLSX, `Sales Report - Product Type Wise (${axisLabel})`, dateRangeLine, productTypeRows.map(r => ({
        'Product Type': r.name, 'Qty Sales': r.qtySales, 'Qty Return': r.qtyReturn, 'Qty Net': r.qtySales - r.qtyReturn,
        'Gross (NPR)': Math.round(r.gross * 100) / 100, 'Discount (NPR)': Math.round(r.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(r.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(r.taxable * 100) / 100,
        'VAT (NPR)': Math.round(r.vat * 100) / 100, 'Net (NPR)': Math.round(groupNetOf(r) * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Product Type Sales')
      XLSX.writeFile(wb, `product-type-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'item') {
      const ws = withLetterhead(XLSX, 'Sales Report - Item Wise', dateRangeLine, itemRows.map(i => ({
        'Product Code': codeById[i.key] || '', 'Item': i.name, 'Qty Sales': i.qtySales, 'Qty Return': i.qtyReturn, 'Qty Net': i.qtySales - i.qtyReturn,
        'Gross (NPR)': Math.round(i.gross * 100) / 100, 'Discount (NPR)': Math.round(i.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(i.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(i.taxable * 100) / 100,
        'VAT (NPR)': Math.round(i.vat * 100) / 100, 'Net (NPR)': Math.round(itemNetOf(i) * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Item Sales')
      XLSX.writeFile(wb, `item-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'customer') {
      const ws = withLetterhead(XLSX, 'Sales Report - Customer Wise', dateRangeLine, customerRows.map(c => ({
        'Customer Name': c.name, 'Mobile': c.phone, 'PAN': c.pan || '', 'Bills': c.bills,
        'Gross (NPR)': Math.round(c.gross * 100) / 100, 'Discount (NPR)': Math.round(c.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(c.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(c.taxable * 100) / 100,
        'VAT (NPR)': Math.round(c.vat * 100) / 100, 'Net Sales (NPR)': Math.round(c.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Customer Sales')
      XLSX.writeFile(wb, `customer-sales-${fromIso}-to-${toIso}.xlsx`)
    } else {
      const oneLakhRangeLine = `@Fiscal Year : ${selectedFy}  @Division : ${bizInfo.name}`
      const ws = withLetterhead(XLSX, 'One Lakh Above Report (Annexure 13)', oneLakhRangeLine, parties.map(p => ({
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
  // Same per-pipeline split as `loading`: the tab decides which pipeline's failure it must report.
  const loadError = tab === 'onelakh' ? oneLakhError : rangeError
  const isEmpty =
    (tab === 'daily' && dailyRows.length === 0) ||
    (tab === 'hourly' && hourlyTotals.bills === 0) ||
    (tab === 'voucher' && filteredVoucherRows.length === 0) ||
    (tab === 'compxref' && compedBillRows.length === 0) ||
    (tab === 'payment' && paymentRows.length === 0) ||
    (tab === 'delivery' && deliveryPartnerRows.length === 0) ||
    (tab === 'category' && categoryRows.length === 0) ||
    (tab === 'producttype' && productTypeRows.length === 0) ||
    (tab === 'item' && itemRows.length === 0) ||
    (tab === 'customer' && customerRows.length === 0) ||
    (tab === 'onelakh' && parties.length === 0)

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1150 }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">
          Sales Report <Tip text="Ten views of the same POS sales data: Daily and Hourly show when revenue happens, Bill Register lists every individual voucher, Comped Bills cross-references paid bills with the item(s) comped out of them, Payment Summary breaks it down by how customers paid, Delivery Partners tracks Foodmandu/Pathao bills from Credit through settlement and checks what each platform withheld against the rate you agreed with it, Category, Item, and Customer show where it comes from, and 1L+ Report is the Nepal VAT Annexure 13 compliance check." width={340}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">
            One report, eleven ways to slice it.
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={isEmpty}>⬇ Excel</button>
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.key} className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => { setTab(t.key); setPaymentFilter(null); setPartnerFilter('all') }}>{t.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        {tab === 'onelakh' ? (
          <div>
            <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="sales-report-fiscal-year-bs">Fiscal Year (BS)</label>
            <select id="sales-report-fiscal-year-bs" className="form-select" value={selectedFy} onChange={e => setSelectedFy(e.target.value)}>
              {fyOptions.map(fy => <option key={fy} value={fy}>{fy}</option>)}
            </select>
          </div>
        ) : (
          <>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="sales-report-from-bs">From (BS)</label>
              <BsCalendarPicker id="sales-report-from-bs" value={fromIso} onChange={setFromIso} />
            </div>
            <div>
              <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="sales-report-to-bs">To (BS)</label>
              <BsCalendarPicker id="sales-report-to-bs" value={toIso} onChange={setToIso} />
            </div>
            {tab === 'delivery' && deliveryPartnerSummary.length > 1 && (
              <div>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="sales-report-delivery-partner">Partner</label>
                <select id="sales-report-delivery-partner" className="form-select" value={partnerFilter} onChange={e => setPartnerFilter(e.target.value)}>
                  <option value="all">All partners</option>
                  {deliveryPartnerSummary.map(g => <option key={g.partner} value={g.partner}>{g.partner}</option>)}
                </select>
              </div>
            )}
          </>
        )}
      </div>

      {/* S612: a failed read renders as a failure — never as the empty state or a zero table. */}
      {loadError ? (
        <ReportLoadError error={loadError} />
      ) : loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : isEmpty ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {tab === 'onelakh' ? `No paid bills in FY ${selectedFy}.`
            : tab === 'compxref' ? 'No bills had an item comped out of them in this range.'
            : tab === 'voucher' && paymentFilter ? `No ${paymentFilter} bills in this range.`
            : tab === 'delivery' ? 'No Foodmandu/Pathao bills in this range.'
            : 'No paid bills in this range.'}
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
            // MUTED is the documented `chart-tick` token: correct inside the SVG, a chart colour
            // worn as UI chrome out here (the S540 role mismatch), so the footer takes text2.
            footer={hourlyTotalNet > 0 && (
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 8 }}>
                Total <strong style={{ color: 'var(--theme-text1)' }}>{fmtNpr(hourlyTotalNet)}</strong>
                {hourlyPeak && hourlyPeak.net > 0 && <> · peak hour <span style={{ color: GOLD, fontWeight: 600 }}>{hourLabel(hourlyPeak.hour)}</span> ({fmtNpr(hourlyPeak.net)})</>}
              </div>
            )}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={hourlyChartData} margin={{ top: 0, right: 10, left: 0, bottom: 30 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED, fontSize: 11 }} angle={-45} textAnchor="end" interval={1} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} tickFormatter={v => `${Math.round(v / 1000)}k`} />
                  <Tooltip
                    // Recharts renders its tooltip as an HTML <div>, NOT an SVG node, so these are
                    // real React style objects and var() resolves fine here — the SVG-attribute
                    // exemption that covers `fill`/`stroke`/`tick` does not apply. They were the
                    // DARK preset's literals, so the tooltip stayed dark on all five light presets.
                    contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }} itemStyle={{ color: 'var(--theme-text1)' }}
                    formatter={v => [fmtNpr(v), 'Net Sales']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={GOLD} {...chartMotion()} />
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
        <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>Click any row to view the actual bill.</p>
          {paymentFilter && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
              padding: '3px 6px 3px 10px', borderRadius: 'var(--radius-md)', background: 'var(--theme-input-bg)',
              border: '1px solid var(--theme-accent)', color: 'var(--theme-accent-ink)',
            }}>
              Filtered: {paymentFilter}
              <button onClick={() => setPaymentFilter(null)} title="Clear filter" style={{
                background: 'none', border: 'none', color: 'var(--theme-accent-ink)', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1,
              }}>×</button>
            </span>
          )}
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Voucher#</th><th>Invoice#</th><th>Customer</th><th>Payment Mode</th><th>Order Mode</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
                <th>Remarks</th><th>Entered By</th>
                {/* Keyboard-reachable drill-down (S613): the row onClick stays for mouse users,
                    but a click target must also be tabbable — a <tr> is not. */}
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {filteredVoucherRows.map(v => {
                const bs = adToBs(new Date(v.closedAt))
                return (
                  <tr key={v.id} onClick={() => viewPosBill(clientId, { id: v.id })} style={{ cursor: 'pointer' }}>
                    <td>{bs.day} {BS_MONTHS[bs.month - 1]} {bs.year}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>#{v.orderNo}</td>
                    <td>{v.invoiceNo || '—'}</td>
                    <td>
                      {v.customer}
                      {v.credited && <span className="badge-amber" style={{ fontSize: 10, marginLeft: 6 }}>Credit Noted</span>}
                      {v.compNos.length > 0 && (
                        <Tip text="This bill had one or more items comped out of it — see the Comped Bills tab for detail. Excluded from the Gross/Net figures shown here.">
                          <span className="badge-amber" style={{ fontSize: 10, marginLeft: 6 }}>
                            Comped ({v.compNos.map(n => `NC-${String(n).padStart(2, '0')}`).join(', ')})
                          </span>
                        </Tip>
                      )}
                    </td>
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
                    <td className="no-print">
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }}
                        onClick={e => { e.stopPropagation(); viewPosBill(clientId, { id: v.id }) }}>View bill</button>
                    </td>
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
                <td></td><td></td><td className="no-print"></td>
              </tr>
            </tfoot>
          </table>
        </div>
        </div>
      ) : tab === 'compxref' ? (
        <div>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text3)' }}>
          Every bill that had one or more items comped out of it — click a row to view the mini Complimentary Slip for that comp.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Bill No</th><th>NC No</th><th>Table</th><th>Items Comped</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Ingredient cost of the comped item(s) — matches the Complimentary Slip valuation" width={240}>Food Cost</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="What the comped item(s) would have sold for at menu price incl. VAT" width={240}>Potential Value</Tip>
                </th>
                <th>Reason</th>
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {compedBillRows.map(c => {
                const bs = adToBs(new Date(c.closedAt))
                return (
                  <tr key={c.key} onClick={() => viewPosBill(clientId, { isItemComp: true, parentOrderId: c.orderId, compNo: c.compNo })} style={{ cursor: 'pointer' }}>
                    <td>{bs.day} {BS_MONTHS[bs.month - 1]} {bs.year}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{c.invoiceNo != null ? `#${c.invoiceNo}` : `Order #${c.orderNo}`}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-amber-text)' }}>NC-{String(c.compNo).padStart(2, '0')}</td>
                    <td>{c.tableName || 'Takeaway'}</td>
                    <td>{c.itemNames}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(c.foodCost)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(c.potentialValue)}</td>
                    <td>{c.reason}</td>
                    <td className="no-print">
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }}
                        onClick={e => { e.stopPropagation(); viewPosBill(clientId, { isItemComp: true, parentOrderId: c.orderId, compNo: c.compNo }) }}>View bill</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={5}>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(compedBillTotals.foodCost)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(compedBillTotals.potentialValue)}</td>
                <td></td><td className="no-print"></td>
              </tr>
            </tfoot>
          </table>
        </div>
        </div>
      ) : tab === 'payment' ? (
        <div>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text3)' }}>Click a row to see its bills in Bill Register.</p>
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
                <tr key={p.method} onClick={() => { setPaymentFilter(p.method); setTab('voucher') }} style={{ cursor: 'pointer' }}>
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
        </div>
      ) : tab === 'delivery' ? (
        <div>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
          Foodmandu/Pathao bills close as Credit (the platform doesn't pay at the counter — it remits later, minus commission), so an outstanding row here has no commission/net yet. Settle it from Customers → Outstanding Credit to record the platform's actual remittance. Click a partner below to see only its bills; click any bill to view it.
        </p>
        {partnerFilter !== 'all' && (
          <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
            Totals and bills below are <strong style={{ color: 'var(--theme-text1)' }}>{partnerFilter}</strong> only.{' '}
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 10px' }} onClick={() => setPartnerFilter('all')}>Show all partners</button>
          </p>
        )}
        {/* Shared stat-grid/stat-card grammar (S613) — was four hand-rolled `card` tiles. */}
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat-card">
            <div className="stat-label">Bills</div>
            <div className="stat-value">{deliveryPartnerTotals.bills}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Bills not yet settled from Customers → Outstanding Credit" width={220}>Outstanding</Tip>
            </div>
            <div className="stat-value" style={{ color: deliveryPartnerTotals.outstanding > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>{fmtNpr(deliveryPartnerTotals.outstanding)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Commission (settled)</div>
            <div className="stat-value">{fmtNpr(deliveryPartnerTotals.commission)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Net Received (settled)</div>
            <div className="stat-value" style={{ color: 'var(--theme-green-text)' }}>{fmtNpr(deliveryPartnerTotals.netReceived)}</div>
          </div>
        </div>

        <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
          By partner
        </p>
        <div className="table-wrap" style={{ marginBottom: 26 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Partner</th>
                <th style={{ textAlign: 'right' }}>Bills</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="What this platform still owes you — bills it took the money for but hasn't remitted yet. The figure in brackets is how many bills that is. Record a remittance from Customers → Outstanding Credit." width={300}>Outstanding</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Commission this platform withheld across its settled bills, as entered at settlement from its own remittance statement." width={280}>Commission</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="What that commission actually works out to, as a % of the ex-VAT, post-discount value of the settled bills — the basis Foodmandu and Pathao calculate on. Outstanding bills are left out: they carry no commission yet, so counting them would drag the rate down mid-month." width={330}>Effective %</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="The rate you agreed with this platform, from Table Management → Delivery Partners. Fill it in there and any partner withholding more than agreed turns amber in the column to the left." width={320}>Agreed %</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Net Received</th>
              </tr>
            </thead>
            <tbody>
              {deliveryPartnerSummary.map(g => {
                const active = partnerFilter === g.partner
                return (
                  <tr key={g.partner} onClick={() => setPartnerFilter(active ? 'all' : g.partner)}
                    style={{ cursor: 'pointer', background: active ? 'var(--theme-focus-ring)' : undefined }}>
                    <td><span className="badge-amber" style={{ fontSize: 10 }}>{g.partner}</span></td>
                    <td style={{ textAlign: 'right' }}>{g.bills}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(g.amount)}</td>
                    <td style={{ textAlign: 'right', fontWeight: g.outstanding > 0 ? 700 : 400, color: g.outstanding > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text3)' }}>
                      {g.outstanding > 0
                        ? <>{fmtNpr(g.outstanding)} <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)' }}>({g.outstandingBills})</span></>
                        : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{g.settledBills > 0 ? fmtNpr(g.commission) : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: g.offRate ? 700 : 400, color: g.offRate ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>
                      {g.effectivePct == null ? '—' : g.offRate ? (
                        <Tip width={330} text={`Commission on ${g.settledBills} settled bill${g.settledBills === 1 ? '' : 's'} works out to ${g.effectivePct.toFixed(1)}% of ex-VAT sales against the ${g.agreedPct}% agreed — ${fmtNpr(Math.abs(g.commission - g.expectedCommission))} ${g.commission > g.expectedCommission ? 'more' : 'less'} than the agreed rate. Check it against the platform's remittance statement.`}>
                          {g.effectivePct.toFixed(1)}% ⚠
                        </Tip>
                      ) : `${g.effectivePct.toFixed(1)}%`}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{g.agreedPct == null ? '—' : `${g.agreedPct}%`}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{g.settledBills > 0 ? fmtNpr(g.netReceived) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{deliverySummaryTotals.bills}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(deliverySummaryTotals.amount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(deliverySummaryTotals.outstanding)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(deliverySummaryTotals.commission)}</td>
                <td style={{ textAlign: 'right' }}>
                  {deliverySummaryTotals.settledBase > 0 ? `${((deliverySummaryTotals.commission / deliverySummaryTotals.settledBase) * 100).toFixed(1)}%` : '—'}
                </td>
                <td></td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(deliverySummaryTotals.netReceived)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
          {partnerFilter === 'all' ? 'Bills' : `${partnerFilter} bills`}
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Bill No</th><th>Partner</th><th>Table</th>
                <th style={{ textAlign: 'right' }}>Amount</th><th>Status</th>
                <th style={{ textAlign: 'right' }}>Commission</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="This bill's commission as a % of its own ex-VAT, post-discount value — so a single bill the platform over-deducted on can be found, not just an average that looks slightly off." width={310}>Comm. %</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Net Received</th>
                <th>Settled Via</th>
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {visibleDeliveryRows.map(r => {
                const bs = adToBs(new Date(r.closedAt))
                const billPct = r.settled && r.exVatBase > 0 ? (r.commission / r.exVatBase) * 100 : null
                const agreed = partnerRates[r.deliveryPartner]
                // Same two-part tolerance as the rollup, at one bill's scale: rounding to the
                // rupee can only move a single bill by NPR 0.5, so anything past NPR 1 is real.
                const billOff = billPct != null && agreed != null && !Number.isNaN(agreed)
                  && Math.abs(billPct - agreed) >= 0.5
                  && Math.abs(r.commission - r.exVatBase * agreed / 100) > 1
                return (
                  <tr key={r.id} onClick={() => viewPosBill(clientId, { id: r.id })} style={{ cursor: 'pointer' }}>
                    <td>{bs.day} {BS_MONTHS[bs.month - 1]} {bs.year}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.invoiceNo != null ? `#${r.invoiceNo}` : `Order #${r.orderNo}`}</td>
                    <td><span className="badge-amber" style={{ fontSize: 10 }}>{r.deliveryPartner}</span></td>
                    <td>{r.tableName || 'Takeaway'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(r.amount)}</td>
                    <td>{r.settled ? <span className="badge-green" style={{ fontSize: 11 }}>Settled</span> : <span className="badge-amber" style={{ fontSize: 11 }}>Outstanding</span>}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{r.settled ? fmtNpr(r.commission) : '—'}</td>
                    <td style={{ textAlign: 'right', color: billOff ? 'var(--theme-amber-text)' : 'var(--theme-text3)', fontWeight: billOff ? 700 : 400 }}>
                      {billPct == null ? '—' : `${billPct.toFixed(1)}%${billOff ? ' ⚠' : ''}`}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.settled ? fmtNpr(r.amount - r.commission) : '—'}</td>
                    <td>{r.settled ? r.settledMethod : '—'}</td>
                    <td className="no-print">
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }}
                        onClick={e => { e.stopPropagation(); viewPosBill(clientId, { id: r.id }) }}>View bill</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={4}>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(deliveryPartnerTotals.amount)}</td>
                <td></td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(deliveryPartnerTotals.commission)}</td>
                <td></td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(deliveryPartnerTotals.netReceived)}</td>
                <td></td><td className="no-print"></td>
              </tr>
            </tfoot>
          </table>
        </div>
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
      ) : tab === 'producttype' ? (
        <>
          <div className="form-field" style={{ marginBottom: 12 }}>
            <span className="field-label" id="product-axis-label">
              <Tip text="Category Wise groups by the menu category each item sits in. Product Type groups by an axis ABOVE that — the same lines, cut a different way." width={300}>Group by</Tip>
            </span>
            <div className="tab-bar" role="group" aria-labelledby="product-axis-label">
              {productAxes.map(a => (
                <button
                  key={a.key} type="button"
                  className={`tab-btn${productAxis === a.key ? ' tab-btn--active' : ''}`}
                  aria-pressed={productAxis === a.key}
                  onClick={() => setProductAxis(a.key)}
                >{a.label}</button>
              ))}
            </div>
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>
              {productAxis === 'station'
                ? `Bar (BOT) is every line in a bar category (${[...botCategories].join(', ')}) — the same split the tills print BOT tickets from, set in Table Management → Ticket Routing. Everything else is Kitchen (KOT).`
                : productAxis === 'vat'
                ? 'Taxable is every line billed at a VAT rate above zero, Non-Taxable everything else — as billed, not as the item is configured today.'
                : 'Veg / Non-Veg comes from the flag on each recipe. Items with the flag unset are shown separately rather than assumed.'}
            </p>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product Type</th>
                  <th style={{ textAlign: 'right' }}>Qty Sales</th><th style={{ textAlign: 'right' }}>Qty Return</th><th style={{ textAlign: 'right' }}>Qty Net</th>
                  <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                  <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                  <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
                </tr>
              </thead>
              <tbody>
                {productTypeRows.map(r => (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</td>
                    <td style={{ textAlign: 'right' }}>{r.qtySales}</td>
                    <td style={{ textAlign: 'right' }}>{r.qtyReturn}</td>
                    <td style={{ textAlign: 'right' }}>{r.qtySales - r.qtyReturn}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(r.gross)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(r.discount)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(r.nonTaxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(r.taxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(r.vat)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(groupNetOf(r))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>TOTAL</td>
                  <td style={{ textAlign: 'right' }}>{productTypeTotals.qtySales}</td>
                  <td style={{ textAlign: 'right' }}>{productTypeTotals.qtyReturn}</td>
                  <td style={{ textAlign: 'right' }}>{productTypeTotals.qtySales - productTypeTotals.qtyReturn}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(productTypeTotals.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(productTypeTotals.discount)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(productTypeTotals.nonTaxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(productTypeTotals.taxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(productTypeTotals.vat)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(productTypeTotals.gross - productTypeTotals.discount + productTypeTotals.vat)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : tab === 'item' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th><th>Item</th>
                <th style={{ textAlign: 'right' }}>Qty Sales</th><th style={{ textAlign: 'right' }}>Qty Return</th><th style={{ textAlign: 'right' }}>Qty Net</th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {itemRows.map(i => (
                <tr key={i.key}>
                  <td style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--theme-text2)' }}>{codeById[i.key] || '—'}</td>
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
                <td></td>
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
