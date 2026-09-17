import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { chartMotion } from '../../../shared/chartMotion'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { firstError } from '../../../shared/queryError'
import { errorInfo } from '../../../shared/errorText'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import RangePresets from './RangePresets'
import ChartCard from '../../../components/ChartCard'
import { getBsToday, formatAd, adToBs, formatBsDay, BS_MONTHS, getBsFiscalYear } from '../../../utils/bsCalendar'
import { nepalDayStartTs, nepalDayEndTs, todayNepalAdIso, bsSlash } from './reportRange'
import { nepalTime, nepalTime24, nepalBs, nepalCivilDate, nepalHour } from '../../../shared/nepalTime'
import { computeOrderAmounts } from '../../../utils/posBillingMath'
import {
  NOT_RECORDED, SPLIT_NO_BREAKDOWN, zeroAmounts, addAmounts, buildSalesEntries, paymentSharesOf,
  buildPaymentRows, sortByMethodOrder, buildGroupedRows, partyNameKey, mergeNameOnlyParties,
} from './salesReportMath'
import { viewPosBill } from '../../../utils/viewPosBill'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { PAYMENT_METHODS } from '../orders/posOrdersConstants'
import { IDENTITY_BADGE, CLOSE_TYPE_BADGE } from '../posSignals'

const fmtNpr = npr
const WALKIN_KEY = '__CASH_SALES__'
const THRESHOLD = 100000
// SVG presentation attributes only (tick fills, Bar fill) — var() does not resolve there. Never
// as HTML text: as 11px caption text MUTED measured 3.9:1 on the dark card, and GOLD is a chart
// hue rather than a theme token. Text takes the tokens. (This pair was a silent copy of
// CoversReport.jsx's, carrying neither the comment nor the reason — restored S689.)
const GOLD  = '#c9a84c'
const MUTED = '#6b7280'
const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
// The date cell shared by the three row-level tabs (Bill Register, Comped Bills, Delivery Bills).
//
// S670: these tabs showed a BS day and nothing finer, so four bills stamped "4 Bhadra 2083" could
// not be told apart or put in order. Both of the order's own timestamps go underneath it.
//
// Every value here is pinned to Nepal. adToBs() reads a Date's LOCAL getters, so pinning the clock
// time without pinning the date beside it would render a bill closed 00:15 in Kathmandu as the
// previous BS day at 12:15 AM for a viewer abroad — the time from one day, the date from another,
// on one line.

// A till whose clock is behind the server can stamp a close BEFORE the server stamped the open.
// A minute of tolerance absorbs latency and rounding; past that it is a real wrong clock and worth
// saying so, rather than flagging every three-second negative into meaninglessness.
const CLOCK_SKEW_TOLERANCE_MS = 60_000

function BillDateTimeCell({ openedAt, closedAt }) {
  const bs = nepalBs(closedAt)
  const civil = nepalCivilDate(closedAt)
  const opened = nepalTime(openedAt)
  const closed = nepalTime(closedAt)
  // The row's date is the CLOSED date, because that is what this report ranges and totals on. An
  // order opened on an earlier day therefore has to say so, or the cell reads as impossible: a
  // delivery bill opened 6:59pm and settled with the rest of the batch at 1:23pm the next day
  // renders as "06:59 PM -> 01:23 PM" under one date, which looks like a clock fault rather than
  // an overnight bill. Same rule the Purchases entry stamp follows, for the same reason.
  const openedBs = nepalBs(openedAt)
  const openedElsewhere = openedBs && bs && !(
    openedBs.year === bs.year && openedBs.month === bs.month && openedBs.day === bs.day
  )
  // Both times are shown exactly as recorded — never clamped, never swapped. This is a ledger; a
  // row that quietly corrects itself is worse than one showing something impossible. The mark is
  // a glyph rather than a colour, since red and amber collapse under deuteranopia (S661).
  const skewed = openedAt && closedAt
    && (new Date(closedAt) - new Date(openedAt)) < -CLOCK_SKEW_TOLERANCE_MS
  // Where the two fall on different days, BOTH sides carry their own date. Dating only the opening
  // side leaves the reader to infer that the closing time inherits the row's date — which is the
  // same inference that made the undated version misread as a backwards clock. Same day, neither is
  // dated: the row's own date already says it, and repeating it on every ordinary bill is noise.
  const openedLabel = openedElsewhere ? `${formatBsDay(openedBs.day, openedBs.month)} ${opened}` : opened
  const closedLabel = openedElsewhere && bs ? `${formatBsDay(bs.day, bs.month)} ${closed}` : closed
  return (
    // nowrap sits on each date+time ATOM, not on the cell — a cell-wide nowrap in a 15-column table
    // can only overflow, and this line is long in the cross-day case. Breaking at the arrow is the
    // one break that costs nothing.
    <td>
      <span style={{ whiteSpace: 'nowrap' }}>
        {bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : (civil ? formatAd(civil) : '—')}
      </span>
      {closed && (
        <span className="cell-sub">
          {opened
            ? <><span style={{ whiteSpace: 'nowrap' }}>{openedLabel}</span> <span aria-hidden="true">→</span> <span style={{ whiteSpace: 'nowrap' }}>{closedLabel}</span></>
            : closed}
          {skewed && (
            <Tip text="This bill records a close before its open. The opened time comes from the server and the closed time from the till, so a till whose clock is wrong will produce this. Both are shown exactly as recorded — check the till's date and time." width={300}>
              <span style={{ color: 'var(--theme-amber-text)', marginLeft: 5 }}>⚠</span>
            </Tip>
          )}
        </span>
      )}
    </td>
  )
}

const bsLabel = bs => bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : ''
const settledLabel = ts => { const bs = nepalBs(ts); return bs ? `${bsLabel(bs)} ${nepalTime24(ts)}` : '' }
// The sheet's Date column is the bill's PAID date, so a bare opening time is ambiguous for an order
// opened on an earlier day. This fills only in that case: blank on an ordinary same-day bill, so
// the column stays quiet, and the Opened time column keeps one format and sorts correctly.
const openedOnLabel = (openedAt, closedAt) => {
  const o = nepalBs(openedAt), c = nepalBs(closedAt)
  if (!o || !c) return ''
  return (o.year === c.year && o.month === c.month && o.day === c.day) ? '' : bsLabel(o)
}

// A Bills cell that also states the credit notes counted into the row's figures (S754). The count
// of bills stays a count of bills — a credit note is not a sale — but a row whose Net has a return
// in it must say so, or a day reads as quieter than its bill count.
function BillsCell({ bills, returns }) {
  return (
    <td style={{ textAlign: 'right' }}>
      {bills}
      {returns > 0 && <span className="cell-sub" style={{ whiteSpace: 'nowrap' }}>−{returns} credit note{returns === 1 ? '' : 's'}</span>}
    </td>
  )
}

const RETURNS_TIP = "Credit notes are shown as MINUS figures on the day they were issued. The bill they credit stays at its full value on the day it was sold, so a bill and its credit note in the same range cancel out in the totals."

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
// The DISPLAY ORDER of Payment Summary's rows, derived from posOrdersConstants.js so a method added
// there sorts into place rather than drifting. It decides order only, never membership: the rows
// are grouped dynamically (salesReportMath.js buildPaymentRows), so any method that actually appears
// on a bill or a split leg gets a row whether or not it is named here — an unlisted one sorts after
// these, and 'Split (breakdown missing)' / 'Not recorded' sort last. (This comment used to say the
// breakdown accumulated only methods it already knew; that was PosShifts' Z-report, never this tab.)
// 'Loyalty' is deliberately absent from PAYMENT_METHODS — that is the list a cashier PICKS, and a
// points redemption is applied, not picked (S290->S291 learned the same with Foodmandu/Pathao).
const PAY_METHOD_ORDER = [...PAYMENT_METHODS, 'Loyalty', 'Credit']

const ORDER_COLUMNS = 'id, order_no, invoice_no, buyer_name, buyer_pan, buyer_phone, discount_amount, opened_at, closed_at, credit_note_id, payment_method, delivery_partner, commission_amount, credit_settled_at, credit_settled_method, paid_amount, bill_remarks, closed_by, table_name'
const CREDIT_NOTE_COLUMNS = 'id, order_id, credit_note_no, invoice_fy, reason, gross_amount, discount_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount, buyer_name, buyer_pan, issued_by, created_at'

// What a delivery row adds to Outstanding: an unsettled bill its amount; a credit note its (minus)
// amount only while the bill it credits is still unsettled — a credit note cannot un-remit money.
const outstandingOf = r => r.isReturn ? (r.originalSettled ? 0 : r.amount) : (r.settled ? 0 : r.amount)

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
  // Its own error slot (S754). This read used to report into `rangeError` — which loadRange clears
  // on its first line, and both effects fire on mount — so a failed letterhead/master-data read was
  // wiped by the range load that started beside it, and the page went on to export a workbook with
  // a blank CompanyName and VAT number and a Delivery Partners tab with every Agreed % silently gone.
  const [bizError, setBizError] = useState(null)
  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    setBizError(null)
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('vat_number, property_address, pos_delivery_partners').eq('client_id', clientId).maybeSingle(),
      scopedFrom('recipes', 'id, is_veg, recipe_code'),
    ]).then(results => {
      // An admin switching client mid-read must not have the previous client's letterhead land.
      if (cancelled) return
      // S612 silent-zero rule: a failed read here isn't cosmetic — it blanks the letterhead and
      // silently drops every Agreed % commission check on the Delivery Partners tab.
      const failed = firstError(results)
      if (failed) { setBizError(failed); return }
      const [{ data: client }, { data: settings }, { data: recipeRows }] = results
      setBizInfo({ name: client?.name || '', vat: settings?.vat_number || '', address: settings?.property_address || '' })
      // The CONTRACTED commission rate per partner (POS Setup -> Delivery Partners). It is
      // the only thing a settled bill's actual commission can be checked against - without it the
      // Delivery Partners tab can say how much a platform took but never whether that was right.
      setPartnerRates(Object.fromEntries((settings?.pos_delivery_partners || [])
        .filter(p => p?.name)
        .map(p => [p.name, p.commission_pct === '' || p.commission_pct == null ? null : parseFloat(p.commission_pct)])))
      setVegById(Object.fromEntries((recipeRows || []).map(r => [r.id, r.is_veg])))
      setCodeById(Object.fromEntries((recipeRows || []).map(r => [r.id, r.recipe_code])))
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  /* ── Daily / Hourly / Category / Customer — one shared date-range fetch ── */
  // Nepal's today, not the viewer's (S754) — see reportRange.js.
  const [fromIso, setFromIso] = useState(todayNepalAdIso)
  const [toIso,   setToIso]   = useState(todayNepalAdIso)
  // Paid bills CLOSED in the range — every one of them, credit-noted or not (S754): a credit note
  // no longer removes its bill from the day it was sold on; it adds a minus row on the day it was
  // issued instead (see salesReportMath.js).
  const [orders, setOrders] = useState([])
  // Credit notes ISSUED in the range (pos_credit_notes.created_at).
  const [creditNotes, setCreditNotes] = useState([])
  // Every bill the page holds, by id: the range's bills plus any bill a note in the range credits
  // that closed before the range began. A minus row needs its original bill's lines, payment
  // method, customer and delivery partner.
  const [orderById, setOrderById] = useState({})
  const [itemsByOrder, setItemsByOrder] = useState({})
  // pos_order_payments legs for the Split bills in orderById — the only bills paid more than one way.
  const [paymentsByOrder, setPaymentsByOrder] = useState({})
  const [compsByOrder, setCompsByOrder] = useState({}) // { order_id: [{ compNo, reason, items, foodCost, potentialValue }] }
  const [vatReg, setVatReg] = useState(true)
  // For the credit note number on a minus row, as the Credit Note Book prints it.
  const [invoicePrefix, setInvoicePrefix] = useState('')
  // The same Kitchen/Bar split the tills route tickets by (POS Setup → Ticket Routing),
  // and the same ['Beverage'] fallback PosOrders.jsx and PosTableManagement.jsx use — if this
  // page disagreed with them, the Bar figure would not match the BOT tickets it came from.
  const [botCategories, setBotCategories] = useState(new Set(['Beverage']))
  const [staffNames, setStaffNames] = useState({})
  const [rangeLoading, setRangeLoading] = useState(true)
  // S612 silent-zero rule: a failed read must render as a failure, never as an empty range.
  // Two error states because the page runs two independent pipelines (date-range vs 1L+ FY),
  // mirroring the rangeLoading/oneLakhLoading split below.
  const [rangeError, setRangeError] = useState(null)
  // S754 overlapping-load guard: every picker change starts a new loadRange, and the slower of two
  // overlapping ones used to win `orders` while the pickers (and so the export's scope line and
  // filename) named the other range. Keyed on client + range, so a reload of the same range passes.
  const rangeReq = useLatestRequest()

  const loadRange = useCallback(async () => {
    if (!clientId) return
    const reqKey = rangeReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setRangeLoading(true)
    setRangeError(null)
    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)
    const fail = err => {
      setRangeError(err)
      setOrders([]); setCreditNotes([]); setOrderById({}); setItemsByOrder({}); setPaymentsByOrder({}); setCompsByOrder({})
      setRangeLoading(false)
    }

    const results = await Promise.all([
      // Paged: the child pos_order_items read below was already wrapped (S529) while this parent
      // was not, so on a busy month every one of this page's ten tabs silently reported the first
      // 1000 bills as if they were all of them — a believable total, not an error.
      fetchAllRows(() => scopedFrom('pos_orders', ORDER_COLUMNS)
        .eq('close_type', 'paid')
        .gte('closed_at', fromTs).lte('closed_at', toTs)
        .order('id')),
      supabase.from('settings').select('is_vat_registered, pos_bot_categories, invoice_prefix').eq('client_id', clientId).maybeSingle(),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin)
      // — resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      // Credit notes by the moment they were ISSUED, on the same Nepal-day bounds as the bills.
      // Paged with a unique sort like every other read here: a note is rare, but this spans
      // whatever range the pickers hold, and a truncated read would silently drop minus rows.
      fetchAllRows(() => scopedFrom('pos_credit_notes', CREDIT_NOTE_COLUMNS)
        .gte('created_at', fromTs).lte('created_at', toTs)
        .order('id')),
    ])
    if (!rangeReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read here would run every tab's arithmetic over `|| []`
    // and render a confident report of NPR 0, visually identical to a quiet range.
    const rangeFailed = firstError(results)
    if (rangeFailed) { fail(rangeFailed); return }
    const [{ data: orderData }, { data: settings }, { data: profs }, { data: noteData }] = results
    setVatReg(settings?.is_vat_registered ?? true)
    setInvoicePrefix(settings?.invoice_prefix || '')
    setBotCategories(new Set(Array.isArray(settings?.pos_bot_categories) && settings.pos_bot_categories.length > 0
      ? settings.pos_bot_categories : ['Beverage']))
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    const orderList = orderData || []
    const noteList = noteData || []
    const inRangeIds = new Set(orderList.map(o => o.id))

    // The bills this range's credit notes credit but that closed BEFORE the range — a note issued
    // today against last week's bill still needs that bill's lines, method and customer.
    const outsideIds = [...new Set(noteList.map(n => n.order_id).filter(id => id && !inRangeIds.has(id)))]
    let creditedOutside = []
    if (outsideIds.length > 0) {
      const { data, error } = await fetchAllRowsChunked(outsideIds,
        ids => scopedFrom('pos_orders', ORDER_COLUMNS).in('id', ids).order('id'))
      if (!rangeReq.isCurrent(reqKey)) return
      // A dropped read here would leave every such note with no lines and no payment method —
      // a minus row valued but unattributed on four tabs.
      if (error) { fail(error); return }
      creditedOutside = data || []
    }
    const allOrders = [...orderList, ...creditedOutside]
    const byIdNext = Object.fromEntries(allOrders.map(o => [o.id, o]))

    let byOrder = {}
    let paymentsNext = {}
    let compsByOrderNext = {}
    if (allOrders.length > 0) {
      const splitIds = allOrders.filter(o => o.payment_method === 'Split').map(o => o.id)
      const lineResults = await Promise.all([
        // Excludes item-level comps (comped=true) — those never billed at menu price (they print
        // on their own Complimentary Slip instead, see PosOrders.jsx), so every tab built from
        // itemsByOrder must exclude them too or Gross/Taxable/Net overstate actual revenue.
        // Paged: pos_order_items is the highest-volume table in the app — one row per line per
        // bill, so a month of ordinary service runs to thousands and blows straight past
        // PostgREST's silent 1000-row cap. Truncated, every figure on this page would be built
        // from roughly the first tenth of the month while looking like a full month (S529).
        // Chunked as well (S754): the `.in()` list is every paid bill in the range, and a few hundred
        // uuids is past what a proxy accepts in a URL — a 414 that would fail the whole page.
        fetchAllRowsChunked(allOrders.map(o => o.id),
          ids => scopedFrom('pos_order_items', 'order_id, recipe_id, name, category, qty, unit_price, vat_rate, comped, comp_no, comp_reason').in('order_id', ids).order('id')),
        // The legs of every Split bill — what Payment Summary spreads the bill across. The same
        // read the shift Z-report makes (PosShifts.jsx loadShiftReport), so the two count the
        // same legs. Both reads derive their ids from the orders and nothing from each other.
        fetchAllRowsChunked(splitIds,
          ids => scopedFrom('pos_order_payments', 'order_id, payment_method, amount').in('order_id', ids).order('id')),
      ])
      if (!rangeReq.isCurrent(reqKey)) return
      // S612 silent-zero rule: with the parent orders loaded but the lines dropped, every figure
      // built from itemsByOrder would be a believable zero — and with the legs dropped every split
      // bill would fall into "breakdown missing" and Cash would stop tying to the Z-report.
      const linesFailed = firstError(lineResults)
      if (linesFailed) { fail(linesFailed); return }
      const [{ data: items }, { data: payments }] = lineResults
      byOrder = (items || []).filter(i => !i.comped).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
      paymentsNext = (payments || []).reduce((acc, p) => {
        ;(acc[p.order_id] = acc[p.order_id] || []).push(p)
        return acc
      }, {})

      // Comped-out rows aren't discarded — they feed the "Comped Bills" cross-reference tab and
      // the Bill Register badge, both of which need to know which paid bills had an item comped
      // out of them and what NC number that comp got. Only the range's own bills: a bill pulled in
      // because a note credits it belongs to an earlier range's comps.
      const compedItems = (items || []).filter(i => i.comped && inRangeIds.has(i.order_id))
      if (compedItems.length > 0) {
        const recipeIds = [...new Set(compedItems.map(i => i.recipe_id).filter(Boolean))]
        // computeRecipeCosts THROWS on a failed read (S695). Unwrapped, that rejection escaped
        // loadRange entirely: rangeLoading never went false and the page sat on "Loading…" for
        // good, with no error anywhere (S754).
        let costMap = {}
        try {
          costMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}
        } catch (err) {
          if (!rangeReq.isCurrent(reqKey)) return
          fail(err)
          return
        }
        if (!rangeReq.isCurrent(reqKey)) return
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
    setOrders(orderList)
    setCreditNotes(noteList)
    setOrderById(byIdNext)
    setItemsByOrder(byOrder)
    setPaymentsByOrder(paymentsNext)
    setCompsByOrder(compsByOrderNext)
    setRangeLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, rangeReq])

  useEffect(() => { loadRange() }, [loadRange])

  // Every bill closed in the range at full value, plus every credit note issued in it as a minus row
  // (S754). Daily, Hourly, Bill Register, Payment Summary and Customer Wise are all built from this
  // one list, so they cannot disagree about a return. It replaces the old rule that dropped a
  // credit-noted bill from every tab — which took a real sale off the day it happened and put the
  // reversal nowhere, so no tab here could be matched to the Z-report or the credit note book.
  const salesEntries = useMemo(
    () => buildSalesEntries({ orders, creditNotes, orderById, itemsByOrder, vatReg }),
    [orders, creditNotes, orderById, itemsByOrder, vatReg])

  const cnLabel = useCallback(n => (
    `CN${n.credit_note_no ?? ''}-${invoicePrefix}${invoicePrefix ? '-' : ''}${n.invoice_fy || ''}`
  ), [invoicePrefix])

  const dailyRows = useMemo(() => {
    const map = {}
    for (const e of salesEntries) {
      // The BS day this row belongs to IN NEPAL — the bill's close, or the note's issue. adToBs
      // reads a Date's local getters, so a bill closed just after midnight Kathmandu bucketed into
      // the PREVIOUS day for a viewer abroad — and the Daily and Hourly tabs then disagreed.
      const civil = nepalCivilDate(e.at)
      if (!civil) continue
      const bs = adToBs(civil)
      const key = `${bs.year}-${bs.month}-${bs.day}`
      map[key] = map[key] || { key, year: bs.year, month: bs.month, day: bs.day, bills: 0, returns: 0, ...zeroAmounts() }
      const b = map[key]
      if (e.kind === 'bill') b.bills += 1
      else b.returns += 1
      addAmounts(b, e.amounts)
    }
    return Object.values(map).sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day)
  }, [salesEntries])

  const hourlyRows = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, bills: 0, returns: 0, qty: 0, net: 0 }))
    for (const e of salesEntries) {
      // A credit note by the hour it was ISSUED, the same rule as Daily's day.
      const h = nepalHour(e.at)
      if (h == null) continue
      if (e.kind === 'bill') buckets[h].bills += 1
      else buckets[h].returns += 1
      buckets[h].qty += e.amounts.qty; buckets[h].net += e.amounts.net
    }
    return buckets
  }, [salesEntries])

  const voucherRows = useMemo(() => {
    const orderModeOf = o => o && o.table_name && o.table_name !== 'Takeaway' ? `Dine-In: ${o.table_name}` : 'Takeaway'
    return salesEntries.map(e => {
      const o = e.order
      const shares = o ? paymentSharesOf(o, paymentsByOrder[o.id]) : [{ method: NOT_RECORDED, share: 1 }]
      const methods = shares.map(s => s.method)
      const payMethod = o && o.payment_method === 'Split' && shares[0].method !== SPLIT_NO_BREAKDOWN
        ? `Split (${methods.join(' + ')})`
        : methods[0]
      const base = {
        payMethod, payMethods: methods,
        gross: e.amounts.gross, discount: e.amounts.discount, taxable: e.amounts.taxable,
        nonTaxable: e.amounts.nonTaxable, vat: e.amounts.vat, net: e.amounts.net,
      }
      if (e.kind === 'return') {
        const n = e.note
        return {
          ...base, id: e.key, isCreditNote: true, billId: o?.id || null,
          orderNo: o?.order_no, invoiceNo: o?.invoice_no, creditNoteLabel: cnLabel(n),
          openedAt: null, closedAt: n.created_at,
          customer: n.buyer_name || o?.buyer_name || 'CASH SALES', pan: n.buyer_pan || o?.buyer_pan || '',
          orderMode: orderModeOf(o), remarks: n.reason || '', enteredBy: staffNames[n.issued_by] || '—',
          credited: false, compNos: [],
        }
      }
      return {
        ...base, id: o.id, isCreditNote: false, billId: o.id,
        orderNo: o.order_no, invoiceNo: o.invoice_no, openedAt: o.opened_at, closedAt: o.closed_at,
        customer: o.buyer_name || 'CASH SALES', pan: o.buyer_pan || '',
        orderMode: orderModeOf(o), remarks: o.bill_remarks || '', enteredBy: staffNames[o.closed_by] || '—',
        credited: !!o.credit_note_id,
        compNos: (compsByOrder[o.id] || []).map(c => c.compNo),
      }
    }).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
  }, [salesEntries, paymentsByOrder, compsByOrder, staffNames, cnLabel])

  // Drill-down target for Payment Summary — same rows, narrowed to the bills that USED this method.
  // A split bill appears under each method it was paid with, and a credit note under its original
  // bill's methods, so a method's drill-down lists exactly the rows its summary line was built from.
  // Blank methods read 'Not recorded' on both sides (they used to be 'Cash' in the summary and '—'
  // here, so that drill-down could never find its own bills).
  const filteredVoucherRows = useMemo(() => (
    paymentFilter ? voucherRows.filter(v => v.payMethods.includes(paymentFilter)) : voucherRows
  ), [voucherRows, paymentFilter])
  const filterHasSplit = paymentFilter != null && filteredVoucherRows.some(v => v.payMethods.length > 1)

  const paymentRows = useMemo(
    () => sortByMethodOrder(buildPaymentRows(salesEntries, paymentsByOrder), PAY_METHOD_ORDER),
    [salesEntries, paymentsByOrder])

  // Foodmandu/Pathao bills — these close as Credit (see PosOrders.jsx: the platform doesn't pay
  // at the counter, it remits later minus commission, so it's a receivable like any other Credit
  // customer), tagged via delivery_partner rather than payment_method. Commission/settlement
  // come from Customers → Outstanding Credit → Settle, not Charge time, so an unsettled row here
  // has no commission/net-received yet — that's expected, not missing data.
  //
  // A credit-noted delivery bill stays in at full value on the day it closed, and its credit note is
  // a MINUS row on the day it was issued (S754): it takes the bill's value off the partner's Billed
  // figure and, if the bill was never settled, off what the partner owes. It never touches a SETTLED
  // bill's commission, base or net received — those are what the platform actually remitted, and the
  // effective commission rate is measured on them.
  const deliveryPartnerRows = useMemo(() => {
    const rows = []
    for (const e of salesEntries) {
      const o = e.order
      if (!o || !o.delivery_partner) continue
      if (e.kind === 'return') {
        const n = e.note
        rows.push({
          id: e.key, isReturn: true, billId: o.id, creditNoteLabel: cnLabel(n),
          orderNo: o.order_no, invoiceNo: o.invoice_no, openedAt: null, closedAt: n.created_at,
          deliveryPartner: o.delivery_partner, tableName: o.table_name,
          amount: -(Number(n.net_amount) || 0),
          exVatBase: -((Number(n.taxable_amount) || 0) + (Number(n.non_taxable_amount) || 0)),
          // The ORIGINAL bill's settlement state decides whether this reduces what is owed.
          originalSettled: !!o.credit_settled_at,
          settled: false, settledAt: null, settledMethod: null, commission: 0,
        })
        continue
      }
      // exVatBase is the basis commission is actually withheld on - the bill's ex-VAT,
      // post-discount value with comped lines excluded - NOT paid_amount. That is what
      // PosCustomers.jsx settles against (both platforms calculate on it), so an effective
      // rate measured off the VAT-inclusive total would read ~13% low on every bill of a
      // VAT-registered client and report every partner as under-remitting.
      rows.push({
        id: o.id, isReturn: false, billId: o.id, credited: !!o.credit_note_id,
        orderNo: o.order_no, invoiceNo: o.invoice_no, openedAt: o.opened_at, closedAt: o.closed_at,
        deliveryPartner: o.delivery_partner, tableName: o.table_name,
        amount: o.paid_amount || 0,
        exVatBase: e.amounts.taxable + e.amounts.nonTaxable,
        settled: !!o.credit_settled_at, settledAt: o.credit_settled_at, settledMethod: o.credit_settled_method,
        commission: parseFloat(o.commission_amount) || 0,
      })
    }
    return rows.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt))
  }, [salesEntries, cnLabel])

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
  // manufacture a discrepancy out of nothing. Credit notes stay out of it for the same reason.
  const deliveryPartnerSummary = useMemo(() => {
    const grouped = {}
    for (const r of deliveryPartnerRows) {
      const g = grouped[r.deliveryPartner] = grouped[r.deliveryPartner] || {
        partner: r.deliveryPartner, bills: 0, returns: 0, amount: 0, outstandingBills: 0, outstanding: 0,
        settledBills: 0, settledBase: 0, commission: 0, netReceived: 0,
      }
      g.amount += r.amount
      g.outstanding += outstandingOf(r)
      if (r.isReturn) { g.returns += 1; continue }
      g.bills += 1
      if (r.settled) {
        g.settledBills += 1
        g.settledBase += r.exVatBase
        g.commission += r.commission
        g.netReceived += r.amount - r.commission
      } else {
        g.outstandingBills += 1
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
    bills: s.bills + g.bills, returns: s.returns + g.returns, amount: s.amount + g.amount,
    outstanding: s.outstanding + g.outstanding, settledBase: s.settledBase + g.settledBase,
    commission: s.commission + g.commission, netReceived: s.netReceived + g.netReceived,
  }), { bills: 0, returns: 0, amount: 0, outstanding: 0, settledBase: 0, commission: 0, netReceived: 0 })

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
    bills: s.bills + (r.isReturn ? 0 : 1),
    returns: s.returns + (r.isReturn ? 1 : 0),
    amount: s.amount + r.amount,
    outstanding: s.outstanding + outstandingOf(r),
    commission: s.commission + (r.settled ? r.commission : 0),
    netReceived: s.netReceived + (r.settled ? r.amount - r.commission : 0),
  }), { bills: 0, returns: 0, amount: 0, outstanding: 0, commission: 0, netReceived: 0 })

  // One builder behind Category Wise, Item Wise and Product Type - they differ only in which
  // bucket a line falls into and what that bucket is called. The credit-note branch is part of
  // the rule rather than incidental: a credit note issued in the range RETURNS the credited bill's
  // charged lines — Qty Return up, every amount down — on the day it was issued, while the bill's
  // own lines stay in Qty Sales (S754; salesReportMath.js buildGroupedRows). Three hand-written
  // copies of that is how the tabs would come to disagree about a return.
  const groupedRowsOf = useCallback((keyOf, labelOf) => buildGroupedRows({
    orders, creditNotes, orderById, itemsByOrder, vatReg, keyOf, labelOf,
  }), [orders, creditNotes, orderById, itemsByOrder, vatReg])

  const categoryRows = useMemo(
    () => groupedRowsOf(i => i.category || 'Uncategorized', i => i.category || 'Uncategorized'),
    [groupedRowsOf])

  const itemRows = useMemo(
    () => groupedRowsOf(i => i.recipe_id || i.name, i => i.name),
    [groupedRowsOf])

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
    () => groupedRowsOf(productTypeKeyOf, productTypeKeyOf),
    [groupedRowsOf, productTypeKeyOf])

  const customerRows = useMemo(() => {
    const grouped = {}
    for (const e of salesEntries) {
      // A credit note nets the ORIGINAL bill's customer — the party whose sale it reverses — so a
      // customer's bill and its note cancel on this tab even if the note's printed buyer was edited.
      const o = e.order || {}
      const pan = (o.buyer_pan || '').trim()
      const name = (o.buyer_name || '').trim()
      const key = pan || name || WALKIN_KEY
      grouped[key] = grouped[key] || { key, name: name || 'CASH SALES', pan, phone: o.buyer_phone || '', bills: 0, returns: 0, ...zeroAmounts() }
      const b = grouped[key]
      if (e.kind === 'bill') b.bills += 1
      else b.returns += 1
      addAmounts(b, e.amounts)
    }
    return Object.values(grouped).sort((a, b) => b.net - a.net)
  }, [salesEntries])

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
          openedAt: o.opened_at, closedAt: o.closed_at, tableName: o.table_name, compNo: c.compNo, reason: c.reason,
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

  // Separate from rangeReq: the two pipelines are independent, and one shared guard would have each
  // cancelling the other. Keyed on the fiscal year, which is what arrowing the FY <select> moves.
  const oneLakhReq = useLatestRequest()

  const loadOneLakh = useCallback(async () => {
    if (!clientId) return
    const reqKey = oneLakhReq.begin(`${clientId}:${selectedFy}`)
    setOneLakhLoading(true)
    setOneLakhError(null)
    const fail = err => { setOneLakhError(err); setParties([]); setOneLakhLoading(false) }
    const results = await Promise.all([
      // Paged for the same reason the item read below it already was: this feeds the IRD
      // Annexure 13 one-lakh threshold over a whole fiscal year, so a truncated read drops a
      // party below the threshold and understates a statutory disclosure.
      //
      // Credit-noted bills are INCLUDED (S754). They used to be filtered out here, which removed a
      // bill from the fiscal year it was sold in even when its credit note was issued in the next
      // one. Now every bill counts in its own year, and the returns issued in the year are netted
      // off below — the same bills-plus-minus-rows rule as the date-range tabs.
      fetchAllRows(() => scopedFrom('pos_orders', 'id, buyer_name, buyer_pan, discount_amount')
        .eq('status', 'billed').eq('close_type', 'paid').eq('invoice_fy', selectedFy)
        .order('id')),
      supabase.from('settings').select('is_vat_registered').eq('client_id', clientId).maybeSingle(),
      // Credit notes ISSUED in this fiscal year. A note's own invoice_fy is the year it was issued
      // in (IssueCreditNoteModal numbers it into that year's sequence), not the credited bill's.
      fetchAllRows(() => scopedFrom('pos_credit_notes', 'id, order_id, gross_amount, taxable_amount, non_taxable_amount, vat_amount, net_amount')
        .eq('invoice_fy', selectedFy)
        .order('id')),
    ])
    if (!oneLakhReq.isCurrent(reqKey)) return
    // S612 silent-zero rule — and this one feeds an IRD Annexure 13 disclosure, where a silent
    // zero reads as "no party crossed one lakh".
    const oneLakhFailed = firstError(results)
    if (oneLakhFailed) { fail(oneLakhFailed); return }
    const [{ data: fyOrders }, { data: settings }, { data: fyNotes }] = results
    const vr = settings?.is_vat_registered ?? true
    const list = fyOrders || []
    const notes = fyNotes || []

    // A note nets the party of the bill it credits, so that bill's buyer is needed even when it was
    // billed in an earlier fiscal year and so is not in `list`.
    const listIds = new Set(list.map(o => o.id))
    const outsideIds = [...new Set(notes.map(n => n.order_id).filter(id => id && !listIds.has(id)))]

    const secondWave = await Promise.all([
      // Same comped exclusion as loadRange above — an item-level comp isn't part of what the
      // party actually paid, so it can't count toward their Annexure 13 one-lakh threshold.
      // Paged for the same reason as loadRange above — and this one feeds an IRD Annexure 13
      // threshold, so a truncated read could drop a customer below one lakh incorrectly (S529).
      // Chunked (S754): the id list is every paid bill in a fiscal year — thousands of uuids, far
      // past any URL limit, so this read could not succeed at all on a real client's year.
      fetchAllRowsChunked(list.map(o => o.id),
        ids => scopedFrom('pos_order_items', 'order_id, qty, unit_price, vat_rate, comped').in('order_id', ids).order('id')),
      fetchAllRowsChunked(outsideIds,
        ids => scopedFrom('pos_orders', 'id, buyer_name, buyer_pan').in('id', ids).order('id')),
    ])
    if (!oneLakhReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: lines missing means every party's net reads zero — below threshold;
    // credited bills missing means a return nets no one and the walk-in row absorbs it.
    const secondFailed = firstError(secondWave)
    if (secondFailed) { fail(secondFailed); return }
    const [{ data: items }, { data: outsideOrders }] = secondWave
    const byOrder = (items || []).filter(i => !i.comped).reduce((acc, i) => {
      ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
      return acc
    }, {})
    const buyerById = Object.fromEntries([...list, ...(outsideOrders || [])].map(o => [o.id, o]))

    const grouped = {}
    const partyRow = order => {
      const pan = (order?.buyer_pan || '').trim()
      // Internal whitespace collapsed for display and for the key, so "Ram  Thapa" and "Ram Thapa"
      // are one name-only party before the PAN merge below even runs.
      const name = (order?.buyer_name || '').trim().replace(/\s+/g, ' ')
      const key = pan ? `pan:${pan}` : name ? `name:${partyNameKey(name)}` : WALKIN_KEY
      // `walkIn` marks the one aggregate row that is not a party (S754). Every anonymous bill in the
      // year sums into it, so on any real outlet it crosses one lakh — and it was then flagged
      // "Missing PAN", telling the owner to go and collect a PAN from a row that is hundreds of
      // unnamed customers. It carries no Annexure 13 flag of either kind.
      return grouped[key] = grouped[key] || { key, name: name || 'CASH SALES / WALK-IN', pan, walkIn: key === WALKIN_KEY, bills: 0, returns: 0, gross: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 }
    }
    for (const o of list) {
      const amounts = computeOrderAmounts(o, byOrder[o.id] || [], vr)
      const g = partyRow(o)
      g.bills += 1
      g.gross += amounts.grossAmt
      g.taxable += amounts.taxableBase
      g.nonTaxable += amounts.nonTaxableBase
      g.vat += amounts.vatAmt
      g.net += amounts.net
    }
    // Returns issued this fiscal year, at the credit note's own stored figures (the document's).
    for (const n of notes) {
      const g = partyRow(buyerById[n.order_id])
      g.returns += 1
      g.gross -= Number(n.gross_amount) || 0
      g.taxable -= Number(n.taxable_amount) || 0
      g.nonTaxable -= Number(n.non_taxable_amount) || 0
      g.vat -= Number(n.vat_amount) || 0
      g.net -= Number(n.net_amount) || 0
    }
    // A party billed once with a PAN and once by name alone is one party (owner decision, S754) —
    // see mergeNameOnlyParties for the one case it refuses to guess.
    setParties(mergeNameOnlyParties(Object.values(grouped)).sort((a, b) => b.net - a.net))
    setOneLakhLoading(false)
  }, [clientId, selectedFy, scopedFrom, oneLakhReq])

  // Lazy — the FY-wide fetch (every paid order + all its items) only runs once the tab is opened
  useEffect(() => { if (tab === 'onelakh') loadOneLakh() }, [tab, loadOneLakh])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const dailyTotals = dailyRows.reduce((s, r) => ({ bills: s.bills + r.bills, returns: s.returns + r.returns, qty: s.qty + r.qty, gross: s.gross + r.gross, discount: s.discount + r.discount, taxable: s.taxable + r.taxable, nonTaxable: s.nonTaxable + r.nonTaxable, vat: s.vat + r.vat, net: s.net + r.net }), { bills: 0, returns: 0, qty: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const hourlyTotals = hourlyRows.reduce((s, h) => ({ bills: s.bills + h.bills, returns: s.returns + h.returns, qty: s.qty + h.qty, net: s.net + h.net }), { bills: 0, returns: 0, qty: 0, net: 0 })
  // Every row counts toward the footer now — bills at full value AND credit notes as minus rows
  // (S754). The old footer left credited bills out, which only reconciled because every other tab
  // left them out too; with the bill on its own day and the note on its issue day, bills + minus
  // rows is the figure Daily, Payment Summary, Category and Customer Wise all total to.
  const voucherTotals = filteredVoucherRows.reduce((s, v) => ({ gross: s.gross + v.gross, discount: s.discount + v.discount, taxable: s.taxable + v.taxable, nonTaxable: s.nonTaxable + v.nonTaxable, vat: s.vat + v.vat, net: s.net + v.net }), { gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
  const paymentTotals = paymentRows.reduce((s, p) => ({ gross: s.gross + p.gross, discount: s.discount + p.discount, taxable: s.taxable + p.taxable, nonTaxable: s.nonTaxable + p.nonTaxable, vat: s.vat + p.vat, net: s.net + p.net, returnNet: s.returnNet + p.returnNet }), { gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0, returnNet: 0 })
  // Distinct bills and notes, not the column sum: a split bill is counted under each method it used.
  paymentTotals.bills = orders.length
  paymentTotals.returns = creditNotes.length
  const groupNetOf = r => r.gross - r.discount + r.vat
  const totalsOf = rows => rows.reduce((s, r) => ({ qtySales: s.qtySales + r.qtySales, qtyReturn: s.qtyReturn + r.qtyReturn, gross: s.gross + r.gross, discount: s.discount + r.discount, taxable: s.taxable + r.taxable, nonTaxable: s.nonTaxable + r.nonTaxable, vat: s.vat + r.vat }), { qtySales: 0, qtyReturn: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0 })
  const categoryNetOf = groupNetOf
  const itemNetOf = groupNetOf
  const categoryTotals = totalsOf(categoryRows)
  const itemTotals = totalsOf(itemRows)
  const productTypeTotals = totalsOf(productTypeRows)
  const customerTotals = customerRows.reduce((s, c) => ({ bills: s.bills + c.bills, returns: s.returns + c.returns, gross: s.gross + c.gross, discount: s.discount + c.discount, taxable: s.taxable + c.taxable, nonTaxable: s.nonTaxable + c.nonTaxable, vat: s.vat + c.vat, net: s.net + c.net }), { bills: 0, returns: 0, gross: 0, discount: 0, taxable: 0, nonTaxable: 0, vat: 0, net: 0 })
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
  // The letterhead line every sheet in the workbook carries. It now states the timezone too: a
  // sheet that leaves the building with bare clock times has to say which clock (S594 — a sheet
  // that does not state its own scope cannot be reconciled a month later).
  const dateRangeLine = `@As On Dated : ${fromIso} (B.S. ${bsSlash(fromIso)})  To : ${toIso} (B.S. ${bsSlash(toIso)})  @Division : ${bizInfo.name}  @Times : Nepal time (UTC+05:45), 24-hour`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    if (tab === 'daily') {
      const ws = withLetterhead(XLSX, 'Sales Report - Daily', dateRangeLine, dailyRows.map(r => ({
        // Credit Notes is its own column (S754): the amounts include each note as a minus figure on
        // the day it was issued, and a sheet has to be able to say how many there were.
        'Date (BS)': `${r.day} ${BS_MONTHS[r.month - 1]} ${r.year}`, 'Bills': r.bills, 'Credit Notes': r.returns, 'Net Qty': r.qty,
        'Gross (NPR)': Math.round(r.gross * 100) / 100, 'Discount (NPR)': Math.round(r.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(r.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(r.taxable * 100) / 100,
        'VAT (NPR)': Math.round(r.vat * 100) / 100, 'Net (NPR)': Math.round(r.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Daily Sales')
      XLSX.writeFile(wb, `daily-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'hourly') {
      const ws = withLetterhead(XLSX, 'Sales Report - Hourly', dateRangeLine, hourlyRows.map(h => ({ 'Hour': hourLabel(h.hour), 'Bills': h.bills, 'Credit Notes': h.returns, 'Net Qty': h.qty, 'Net Sales (NPR)': Math.round(h.net * 100) / 100 })))
      XLSX.utils.book_append_sheet(wb, ws, 'Hourly Sales')
      XLSX.writeFile(wb, `hourly-sales-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'voucher') {
      // The payment filter is part of the sheet's scope — and a split bill under a method filter is
      // its WHOLE amount, which the scope line says so the sheet is not read as that method's share.
      const voucherScope = paymentFilter
        ? `${dateRangeLine}  @Payment Mode : bills paid wholly or partly by ${paymentFilter} (split bills at their full amount)`
        : dateRangeLine
      const ws = withLetterhead(XLSX, 'Sales Book Report', voucherScope, filteredVoucherRows.map(v => {
        const bs = nepalBs(v.closedAt)
        return {
          // Two discrete columns rather than the screen's single "opened -> closed" line: a sheet
          // has no width pressure and a reader needs to be able to sort and filter on either.
          'Date (BS)': bsLabel(bs), 'Opened On (BS)': openedOnLabel(v.openedAt, v.closedAt), 'Opened': nepalTime24(v.openedAt), 'Closed': nepalTime24(v.closedAt),
          // A credit note is its own row, minus amounts, carrying its own number and the invoice it
          // credits (S754). Voucher# / Invoice# stay the ORIGINAL bill's so the pair can be matched.
          'Type': v.isCreditNote ? 'Credit Note' : 'Bill',
          'Credit Note#': v.isCreditNote ? v.creditNoteLabel : '',
          'Voucher#': v.orderNo ?? '', 'Invoice#': v.invoiceNo || '',
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
        const bs = nepalBs(c.closedAt)
        return {
          'Date (BS)': bsLabel(bs), 'Opened On (BS)': openedOnLabel(c.openedAt, c.closedAt), 'Opened': nepalTime24(c.openedAt), 'Closed': nepalTime24(c.closedAt),
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
      const paymentScope = `${dateRangeLine}  @Basis : split bills spread across their payment legs by amount (VAT and net shares proportional); credit notes attributed to the original bill's payment method(s)`
      const ws = withLetterhead(XLSX, 'Sales Report - Payment Summary', paymentScope, paymentRows.map(p => ({
        'Payment Method': p.method, 'Bills': p.bills, 'Credit Notes': p.returns,
        'Gross (NPR)': Math.round(p.gross * 100) / 100, 'Discount (NPR)': Math.round(p.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(p.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(p.taxable * 100) / 100,
        'VAT (NPR)': Math.round(p.vat * 100) / 100,
        'Returns in Net (NPR)': Math.round(p.returnNet * 100) / 100,
        'Bills Collected (NPR)': Math.round((p.net - p.returnNet) * 100) / 100,
        'Net (NPR)': Math.round(p.net * 100) / 100,
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
        'Partner': g.partner, 'Bills': g.bills, 'Credit Notes': g.returns,
        // paid_amount, i.e. post-discount and VAT-inclusive — NOT the pre-discount Gross every
        // other sheet in this workbook family means by that word (S754).
        // Net of credit notes issued in the range (S754).
        'Billed incl. VAT, net of credit notes (NPR)': Math.round(g.amount * 100) / 100,
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
        const bs = nepalBs(r.closedAt)
        const billPct = r.settled && r.exVatBase > 0 ? (r.commission / r.exVatBase) * 100 : null
        return {
          'Date (BS)': bsLabel(bs), 'Opened On (BS)': openedOnLabel(r.openedAt, r.closedAt), 'Opened': nepalTime24(r.openedAt), 'Closed': nepalTime24(r.closedAt),
          'Bill No': r.invoiceNo != null ? `#${r.invoiceNo}` : `Order #${r.orderNo}`,
          'Credit Note#': r.isReturn ? r.creditNoteLabel : '',
          'Partner': r.deliveryPartner, 'Table': r.tableName || 'Takeaway',
          'Amount (NPR)': Math.round(r.amount * 100) / 100,
          'Commission Base, ex-VAT (NPR)': Math.round(r.exVatBase * 100) / 100,
          'Status': r.isReturn ? (r.originalSettled ? 'Credit note (bill was settled)' : 'Credit note') : r.settled ? 'Settled' : 'Outstanding',
          'Commission (NPR)': r.settled ? Math.round(r.commission * 100) / 100 : '',
          'Comm. %': billPct == null ? '' : `${billPct.toFixed(2)}%`,
          'Net Received (NPR)': r.settled ? Math.round((r.amount - r.commission) * 100) / 100 : '',
          'Settled Via': r.settled ? r.settledMethod : '',
          // settledAt has been on the row object since the tab was written and never exported —
          // 'Settled Via' told you how but never when.
          'Settled On': r.settled ? settledLabel(r.settledAt) : '',
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
        'Customer Name': c.name, 'Mobile': c.phone, 'PAN': c.pan || '', 'Bills': c.bills, 'Credit Notes': c.returns,
        'Gross (NPR)': Math.round(c.gross * 100) / 100, 'Discount (NPR)': Math.round(c.discount * 100) / 100,
        'Non-Taxable (NPR)': Math.round(c.nonTaxable * 100) / 100, 'Taxable (NPR)': Math.round(c.taxable * 100) / 100,
        'VAT (NPR)': Math.round(c.vat * 100) / 100, 'Net Sales (NPR)': Math.round(c.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Customer Sales')
      XLSX.writeFile(wb, `customer-sales-${fromIso}-to-${toIso}.xlsx`)
    } else {
      const oneLakhRangeLine = `@Fiscal Year : ${selectedFy}  @Division : ${bizInfo.name}  @Basis : bills billed in the year, less credit notes issued in it; a party's name-only bills merged into its PAN row when that name has one PAN`
      const ws = withLetterhead(XLSX, 'One Lakh Above Report (Annexure 13)', oneLakhRangeLine, parties.map(p => ({
        'Party Name': p.name, 'PAN': p.pan || '', 'Bill Count': p.bills, 'Credit Notes': p.returns,
        'Name-only Bills Merged': p.mergedNameOnlyBills || '',
        'Gross (NPR)': Math.round(p.gross * 100) / 100, 'Taxable (NPR)': Math.round(p.taxable * 100) / 100,
        'Non-Taxable (NPR)': Math.round(p.nonTaxable * 100) / 100, 'VAT (NPR)': Math.round(p.vat * 100) / 100,
        'Net (NPR)': Math.round(p.net * 100) / 100, 'Annexure 13 (>1L)': p.net > THRESHOLD && !p.walkIn ? (p.pan ? 'Yes' : 'Yes — MISSING PAN') : '',
        'Check': p.multiplePans ? 'Same name, multiple PANs — check' : '',
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'One Lakh Above')
      XLSX.writeFile(wb, `one-lakh-above-${selectedFy.replace('/', '-')}.xlsx`)
    }
  }

  const loading = tab === 'onelakh' ? oneLakhLoading : rangeLoading
  // Same per-pipeline split as `loading`: the tab decides which pipeline's failure it must report.
  const loadError = tab === 'onelakh' ? oneLakhError : rangeError
  const bizErrorInfo = bizError ? errorInfo(bizError, 'operator') : null
  const isEmpty =
    (tab === 'daily' && dailyRows.length === 0) ||
    (tab === 'hourly' && hourlyTotals.bills + hourlyTotals.returns === 0) ||
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
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">
          Sales Report <Tip text="Eleven views of the same POS sales data: Daily and Hourly show when revenue happens, Bill Register lists every individual voucher, Comped Bills cross-references paid bills with the item(s) comped out of them, Payment Summary breaks it down by how customers paid, Delivery Partners tracks Foodmandu/Pathao bills from Credit through settlement and checks what each platform withheld against the rate you agreed with it, Category, Product Type, Item, and Customer show where it comes from, and 1L+ Report is the Nepal VAT Annexure 13 compliance check." width={340}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">
            One report, eleven ways to slice it.
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Figure-bearing control (S728): off while the active tab's pipeline is loading or has
              failed — the filename and scope line come from the pickers, which move before the data
              does — and off while the letterhead read has failed, or the sheet ships blank (S754). */}
          <button className="btn btn-ghost" onClick={exportExcel} disabled={isEmpty || loading || !!loadError || !!bizError}>⬇ Excel</button>
        </div>
      </div>

      {/* Tabs (S776): the row had no selected state a screen reader could hear, and every tab was its own Tab stop. */}
      <Tabs idBase="pos-sales-report" label="Sales Report views" tabs={TABS} active={tab}
        onChange={key => { setTab(key); setPaymentFilter(null); setPartnerFilter('all') }} style={{ marginBottom: 16 }} />

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
            <RangePresets fromIso={fromIso} toIso={toIso} onPick={r => { setFromIso(r.from); setToIso(r.to) }} />
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

      {/* S754: the letterhead + master-data read fails independently of either pipeline, so it has
          its own notice on every tab rather than borrowing rangeError (which loadRange clears). */}
      {bizErrorInfo && (
        <div className="card report-error" role="alert" style={{ marginBottom: 16 }}>
          <div className="report-error-title">Could not load this outlet's details</div>
          <p className="report-error-body">{bizErrorInfo.text}</p>
          <p className="report-error-hint">
            The company name, VAT number and address for the Excel letterhead, the agreed commission
            rates on Delivery Partners, and the product codes and veg flags did not load — so Excel is
            switched off and those columns are blank rather than real. Reload the page to try again.
          </p>
          {bizErrorInfo.detail && <p className="action-error-detail">{bizErrorInfo.detail}</p>}
        </div>
      )}
      {/* S612: a failed read renders as a failure — never as the empty state or a zero table. */}
      {loadError ? (
        <ReportLoadError error={loadError} />
      ) : loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : isEmpty ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {tab === 'onelakh' ? `No paid bills in FY ${selectedFy}.`
            : tab === 'compxref' ? 'No bills had an item comped out of them in this range.'
            : tab === 'voucher' && paymentFilter ? `No bills or credit notes paid by ${paymentFilter} in this range.`
            : tab === 'delivery' ? 'No Foodmandu/Pathao bills in this range.'
            : 'No paid bills or credit notes in this range.'}
        </div>
      ) : tab === 'daily' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th>
                <th style={{ textAlign: 'right' }}><Tip text={`Bills closed that day. ${RETURNS_TIP}`} width={300}>Bills</Tip></th>
                <th style={{ textAlign: 'right' }}><Tip text="Items sold less items returned on credit notes issued that day" width={240}>Qty</Tip></th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>VAT</th><th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {dailyRows.map(r => (
                <tr key={r.key}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.day} {BS_MONTHS[r.month - 1]} {r.year}</td>
                  <BillsCell bills={r.bills} returns={r.returns} />
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
                <BillsCell bills={dailyTotals.bills} returns={dailyTotals.returns} />
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
                {hourlyPeak && hourlyPeak.net > 0 && <> · peak hour <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{hourLabel(hourlyPeak.hour)}</span> ({fmtNpr(hourlyPeak.net)})</>}
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
              <thead><tr><th>Hour</th><th style={{ textAlign: 'right' }}><Tip text={`Bills closed in that hour. A credit note is counted in the hour it was ISSUED. ${RETURNS_TIP}`} width={300}>Bills</Tip></th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Net Sales</th></tr></thead>
              <tbody>
                {hourlyRows.filter(h => h.bills > 0 || h.returns > 0).map(h => (
                  <tr key={h.hour}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{hourLabel(h.hour)}</td>
                    <BillsCell bills={h.bills} returns={h.returns} />
                    <td style={{ textAlign: 'right' }}>{h.qty}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(h.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>TOTAL</td><BillsCell bills={hourlyTotals.bills} returns={hourlyTotals.returns} />
                  <td style={{ textAlign: 'right' }}>{hourlyTotals.qty}</td><td style={{ textAlign: 'right' }}>{fmtNpr(hourlyTotals.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      ) : tab === 'voucher' ? (
        <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>
            Click any row to view the actual bill — a credit note row opens the bill it credits.{' '}
            <Tip text={RETURNS_TIP} width={300}>Credit notes are minus rows.</Tip>
          </p>
          {paymentFilter && (
            <span style={{
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 600,
              padding: '3px 6px 3px 10px', borderRadius: 'var(--radius-md)', background: 'var(--theme-input-bg)',
              border: '1px solid var(--theme-accent)', color: 'var(--theme-accent-ink)',
            }}>
              Filtered: paid by {paymentFilter}
              <button onClick={() => setPaymentFilter(null)} title="Clear filter" style={{
                background: 'none', border: 'none', color: 'var(--theme-accent-ink)', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1,
              }}>×</button>
            </span>
          )}
        </div>
        {filterHasSplit && (
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text2)' }}>
            Split bills paid partly by {paymentFilter} are listed at their <strong style={{ color: 'var(--theme-text1)' }}>whole</strong> amount here,
            so this total is larger than the {paymentFilter} line on Payment Summary, which counts only its share.
          </p>
        )}
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th><Tip text="The BS day the bill was paid, with the order's own clock times beneath it — when the order was opened, then when it was paid. Both in Nepal time, whatever timezone you are reading from. The row's date is the date it was PAID — where the order was opened on an earlier day, that day is shown next to the opening time. For an order taken while the till was offline, the opened time is when it synced rather than when the guest sat down." width={320}>Date/Time (BS)</Tip></th><th>Voucher#</th><th>Invoice#</th><th>Customer</th><th>Payment Mode</th><th>Order Mode</th>
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
                return (
                  <tr key={v.id} onClick={() => v.billId && viewPosBill(clientId, { id: v.billId })} style={{ cursor: v.billId ? 'pointer' : undefined }}>
                    <BillDateTimeCell openedAt={v.openedAt} closedAt={v.closedAt} />
                    {/* The row keeps its onClick as the mouse convenience; this button is the
                        keyboard/SR path. Never role="button" on the tr — that overrides the
                        implicit row role and unhooks every currency cell from its header. */}
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {v.billId ? (
                        <button className="btn-linklike" onClick={e => { e.stopPropagation(); viewPosBill(clientId, { id: v.billId }) }}>
                          #{v.orderNo}
                        </button>
                      ) : '—'}
                    </td>
                    <td>
                      {v.isCreditNote ? (
                        <>
                          {/* A glyph and a word as well as the chip, so the row reads as a return
                              without relying on colour (S661). */}
                          <span className={CLOSE_TYPE_BADGE.writeoff} style={{ fontSize: 10, whiteSpace: 'nowrap' }}>− Credit Note</span>
                          <span className="cell-sub" style={{ whiteSpace: 'nowrap' }}>{v.creditNoteLabel}</span>
                          <span className="cell-sub" style={{ whiteSpace: 'nowrap' }}>against {v.invoiceNo != null ? `#${v.invoiceNo}` : 'the bill'}</span>
                        </>
                      ) : (v.invoiceNo || '—')}
                    </td>
                    <td>
                      {v.customer}
                      {v.credited && (
                        <Tip text="A credit note was issued against this bill. The bill stays at its full value here, on the day it was sold; the credit note is its own minus row on the day it was issued.">
                          <span className={CLOSE_TYPE_BADGE.writeoff} style={{ fontSize: 10, marginLeft: 6 }}>Credit Noted</span>
                        </Tip>
                      )}
                      {v.compNos.length > 0 && (
                        <Tip text="This bill had one or more items comped out of it — see the Comped Bills tab for detail. Excluded from the Gross/Net figures shown here.">
                          <span className={CLOSE_TYPE_BADGE.writeoff} style={{ fontSize: 10, marginLeft: 6 }}>
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
                      {v.billId && (
                        <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }}
                          onClick={e => { e.stopPropagation(); viewPosBill(clientId, { id: v.billId }) }}>{v.isCreditNote ? 'View original bill' : 'View bill'}</button>
                      )}
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
                <th><Tip text="The BS day the bill was paid, with the order's own clock times beneath it — when the order was opened, then when it was paid. Both in Nepal time, whatever timezone you are reading from. The row's date is the date it was PAID — where the order was opened on an earlier day, that day is shown next to the opening time. For an order taken while the till was offline, the opened time is when it synced rather than when the guest sat down." width={320}>Date/Time (BS)</Tip></th><th>Bill No</th><th>NC No</th><th>Table</th><th>Items Comped</th>
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
                return (
                  <tr key={c.key} onClick={() => viewPosBill(clientId, { isItemComp: true, parentOrderId: c.orderId, compNo: c.compNo })} style={{ cursor: 'pointer' }}>
                    <BillDateTimeCell openedAt={c.openedAt} closedAt={c.closedAt} />
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      <button className="btn-linklike"
                        onClick={e => { e.stopPropagation(); viewPosBill(clientId, { isItemComp: true, parentOrderId: c.orderId, compNo: c.compNo }) }}>
                        {c.invoiceNo != null ? `#${c.invoiceNo}` : `Order #${c.orderNo}`}
                      </button>
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-accent-ink)' }}>NC-{String(c.compNo).padStart(2, '0')}</td>
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
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text3)' }}>
          Click a row to see its bills in Bill Register. A split bill is spread across the methods it was paid with, and a
          credit note is taken off the method(s) its original bill was paid with.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  <Tip text="How the bill was paid. A split bill (including one where loyalty points paid part) is spread across its payment methods in proportion to how much each one paid — so its Cash, Card and Loyalty parts each land on their own row, the way the shift Z-report counts them. 'Split (breakdown missing)' is a split bill whose payment breakdown did not save; 'Not recorded' is a bill with no payment method stored." width={340}>Payment Method</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Bills that used this method. A split bill counts under each method it used, so these can add up to more than the TOTAL, which counts each bill once." width={280}>Bills</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="For a split bill, each method's VAT (and every other figure on this row) is its proportional share of the bill's, by the amount that method paid — not a separate VAT calculation." width={300}>VAT</Tip>
                </th>
                <th style={{ textAlign: 'right' }}><Tip text={RETURNS_TIP} width={300}>Net</Tip></th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="This method's net sales as a share of total net sales in the range" width={220}>% of Net</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Credit notes issued in this range against bills paid this way — already included (as a minus) in Net. Net minus this column is what the bills themselves collected, the figure the shift Z-report counts for this method." width={320}>Returns in Net</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {paymentRows.map(p => (
                <tr key={p.method} onClick={() => { setPaymentFilter(p.method); setTab('voucher') }} style={{ cursor: 'pointer' }}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                    <button className="btn-linklike"
                      onClick={e => { e.stopPropagation(); setPaymentFilter(p.method); setTab('voucher') }}>
                      {p.method}
                    </button>
                  </td>
                  <BillsCell bills={p.bills} returns={p.returns} />
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.gross)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.discount)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.nonTaxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.taxable)}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(p.vat)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(p.net)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{paymentTotals.net > 0 ? `${((p.net / paymentTotals.net) * 100).toFixed(1)}%` : '0%'}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{p.returns > 0 ? fmtNpr(p.returnNet) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td>TOTAL</td>
                <BillsCell bills={paymentTotals.bills} returns={paymentTotals.returns} />
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.nonTaxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.taxable)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.vat)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(paymentTotals.net)}</td>
                <td style={{ textAlign: 'right' }}>100%</td>
                <td style={{ textAlign: 'right' }}>{paymentTotals.returns > 0 ? fmtNpr(paymentTotals.returnNet) : '—'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        </div>
      ) : tab === 'delivery' ? (
        <div>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
          Foodmandu/Pathao bills close as Credit (the platform doesn't pay at the counter — it remits later, minus commission), so an outstanding row here has no commission/net yet. Settle it from Customers → Outstanding Credit to record the platform's actual remittance. A credit note against a delivery bill is a minus row on the day it was issued: it comes off the partner's Billed figure, and off Outstanding if that bill was never settled — it never changes a settled bill's commission or the effective rate. Click a partner below to see only its bills; click any bill to view it.
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
            {deliveryPartnerTotals.returns > 0 && (
              <div className="stat-sub">−{deliveryPartnerTotals.returns} credit note{deliveryPartnerTotals.returns === 1 ? '' : 's'}</div>
            )}
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
                <th style={{ textAlign: 'right' }}>
                  {/* Was "Gross" — but the figure is paid_amount, after discount and including VAT,
                      while Gross on every other tab of this report is before discount (S754). */}
                  <Tip text="What the customers were billed for this platform's orders — after any discount, and including VAT — less credit notes issued in this range against its bills. Not the same as Gross on the other tabs, which is before discount." width={300}>Billed (incl. VAT)</Tip>
                </th>
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
                  <Tip text="The rate you agreed with this platform, from POS Setup → Delivery Partners. Fill it in there and any partner withholding more than agreed turns amber in the column to the left." width={320}>Agreed %</Tip>
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
                    <td>
                      {/* aria-pressed, not a link: this filters the table below in place rather
                          than going anywhere. The underline is suppressed because the content is
                          a badge — btn-linklike's underline lands INSIDE the pill and no chip in
                          the product is underlined; the pill plus the row tint carry the
                          affordance, and :focus-visible still supplies the keyboard ring. */}
                      <button className="btn-linklike" aria-pressed={active} style={{ textDecoration: 'none' }}
                        onClick={e => { e.stopPropagation(); setPartnerFilter(active ? 'all' : g.partner) }}>
                        <span className={IDENTITY_BADGE} style={{ fontSize: 10 }}>{g.partner}</span>
                      </button>
                    </td>
                    <BillsCell bills={g.bills} returns={g.returns} />
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
                <BillsCell bills={deliverySummaryTotals.bills} returns={deliverySummaryTotals.returns} />
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
                <th><Tip text="The BS day the bill was paid, with the order's own clock times beneath it — when the order was opened, then when it was paid. Both in Nepal time, whatever timezone you are reading from. The row's date is the date it was PAID — where the order was opened on an earlier day, that day is shown next to the opening time. For an order taken while the till was offline, the opened time is when it synced rather than when the guest sat down." width={320}>Date/Time (BS)</Tip></th><th>Bill No</th><th>Partner</th><th>Table</th>
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
                const billPct = r.settled && r.exVatBase > 0 ? (r.commission / r.exVatBase) * 100 : null
                const agreed = partnerRates[r.deliveryPartner]
                // Same two-part tolerance as the rollup, at one bill's scale: rounding to the
                // rupee can only move a single bill by NPR 0.5, so anything past NPR 1 is real.
                const billOff = billPct != null && agreed != null && !Number.isNaN(agreed)
                  && Math.abs(billPct - agreed) >= 0.5
                  && Math.abs(r.commission - r.exVatBase * agreed / 100) > 1
                return (
                  <tr key={r.id} onClick={() => viewPosBill(clientId, { id: r.billId })} style={{ cursor: 'pointer' }}>
                    <BillDateTimeCell openedAt={r.openedAt} closedAt={r.closedAt} />
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      <button className="btn-linklike" onClick={e => { e.stopPropagation(); viewPosBill(clientId, { id: r.billId }) }}>
                        {r.invoiceNo != null ? `#${r.invoiceNo}` : `Order #${r.orderNo}`}
                      </button>
                      {r.isReturn && <span className="cell-sub" style={{ whiteSpace: 'nowrap', fontWeight: 400 }}>{r.creditNoteLabel}</span>}
                    </td>
                    <td><span className={IDENTITY_BADGE} style={{ fontSize: 10 }}>{r.deliveryPartner}</span></td>
                    <td>{r.tableName || 'Takeaway'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(r.amount)}</td>
                    <td>
                      {r.isReturn
                        ? (
                          <Tip text={r.originalSettled
                            ? 'A credit note against a bill the platform had already settled. It comes off Billed; the settled commission and net received are left as the platform remitted them.'
                            : 'A credit note against a bill still outstanding. It comes off Billed and off what the platform owes.'} width={280}>
                            <span className={CLOSE_TYPE_BADGE.writeoff} style={{ fontSize: 11, whiteSpace: 'nowrap' }}>− Credit Note</span>
                          </Tip>
                        )
                        : r.settled ? <span className="badge-green" style={{ fontSize: 11 }}>Settled</span> : <span className="badge-amber" style={{ fontSize: 11 }}>Outstanding</span>}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{r.settled ? fmtNpr(r.commission) : '—'}</td>
                    <td style={{ textAlign: 'right', color: billOff ? 'var(--theme-amber-text)' : 'var(--theme-text3)', fontWeight: billOff ? 700 : 400 }}>
                      {billPct == null ? '—' : `${billPct.toFixed(1)}%${billOff ? ' ⚠' : ''}`}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.settled ? fmtNpr(r.amount - r.commission) : '—'}</td>
                    <td>{r.settled ? r.settledMethod : '—'}</td>
                    <td className="no-print">
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 9px' }}
                        onClick={e => { e.stopPropagation(); viewPosBill(clientId, { id: r.billId }) }}>{r.isReturn ? 'View original bill' : 'View bill'}</button>
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
                <th style={{ textAlign: 'right' }}>Qty Sales</th><th style={{ textAlign: 'right' }}><Tip text="Items on credit notes issued in this range — the whole credited bill's charged lines. Every amount column on the row is net of them (the bill's discount comes back off by the same share it went on). The bill itself stays in Qty Sales, on the day it was sold." width={320}>Qty Return</Tip></th><th style={{ textAlign: 'right' }}>Qty Net</th>
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
                ? `Bar (BOT) is every line in a bar category (${[...botCategories].join(', ')}) — the same split the tills print BOT tickets from, set in POS Setup → Ticket Routing. Everything else is Kitchen (KOT).`
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
                  <th style={{ textAlign: 'right' }}>Qty Sales</th><th style={{ textAlign: 'right' }}><Tip text="Items on credit notes issued in this range — the whole credited bill's charged lines. Every amount column on the row is net of them (the bill's discount comes back off by the same share it went on). The bill itself stays in Qty Sales, on the day it was sold." width={320}>Qty Return</Tip></th><th style={{ textAlign: 'right' }}>Qty Net</th>
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
                <th style={{ textAlign: 'right' }}>Qty Sales</th><th style={{ textAlign: 'right' }}><Tip text="Items on credit notes issued in this range — the whole credited bill's charged lines. Every amount column on the row is net of them (the bill's discount comes back off by the same share it went on). The bill itself stays in Qty Sales, on the day it was sold." width={320}>Qty Return</Tip></th><th style={{ textAlign: 'right' }}>Qty Net</th>
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
                <th>Customer Name</th><th>Mobile</th><th>PAN</th>
                <th style={{ textAlign: 'right' }}><Tip text={`${RETURNS_TIP} A credit note is netted against the customer on the bill it credits.`} width={300}>Bills</Tip></th>
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
                  <BillsCell bills={c.bills} returns={c.returns} />
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
                <th>
                  <Tip text="A customer billed once with a PAN and once by name only is one party: the name-only bills are added to the row with that PAN when the names match (ignoring capitals and extra spaces) and that name has only one PAN." width={320}>Party Name</Tip>
                </th>
                <th>PAN</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Bills billed in this fiscal year. Credit notes issued in the year are taken off the party's figures, including a note against a bill from the year before." width={300}>Bills</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Gross</th><th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>Non-Taxable</th><th style={{ textAlign: 'right' }}>VAT</th>
                <th style={{ textAlign: 'right' }}>Net</th>
                <th><Tip text="Rows above NPR 1,00,000 must be disclosed in Annexure 13 of the VAT return. A missing PAN on a flagged row means the party's name alone was recorded — ask for PAN on their next visit. 'Same name, multiple PANs' means these name-only bills could belong to more than one registered party, so they were not merged into any of them — check which one they belong to." width={320}>Flag</Tip></th>
              </tr>
            </thead>
            <tbody>
              {parties.map(p => {
                // The walk-in aggregate is not a party, so it never carries a flag (see loadOneLakh).
                const over = p.net > THRESHOLD && !p.walkIn
                return (
                  <tr key={p.key}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {p.name}
                      {p.mergedNameOnlyBills > 0 && (
                        <span className="cell-sub" style={{ fontWeight: 400 }}>
                          incl. {p.mergedNameOnlyBills} bill{p.mergedNameOnlyBills === 1 ? '' : 's'} recorded by name only
                        </span>
                      )}
                    </td>
                    <td>{p.pan || '—'}</td>
                    <BillsCell bills={p.bills} returns={p.returns} />
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.gross)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.taxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.nonTaxable)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(p.vat)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(p.net)}</td>
                    <td>
                      {over && !p.pan && <span className="badge-red" style={{ fontSize: 11 }}>⚠ Missing PAN</span>}
                      {over && p.pan && <span className={IDENTITY_BADGE} style={{ fontSize: 11 }}>Annexure 13</span>}
                      {p.multiplePans && <span className="badge-amber" style={{ fontSize: 11, marginLeft: over ? 6 : 0 }}>⚠ Same name, multiple PANs — check</span>}
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
