import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { chartMotion } from '../../../shared/chartMotion'
import { TOOLTIP_CHROME } from '../../../shared/tooltipChrome'
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
import ChartCard from '../../../components/ChartCard'
import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { computeOrderAmounts } from '../../../utils/posBillingMath'
import { nepalHour, nepalCivilDate } from '../../../shared/nepalTime'
import { nepalDayStartTs, nepalDayEndTs, todayNepalAdIso, bsSlash } from './reportRange'
import { turnoverByBand, isDineIn, dineInOnly, coversTotals, addReturnsByBand } from './coversMath'
import { SOURCE_LABEL } from '../reservations/reservationStatus'

const fmtNpr = npr
// SVG presentation attributes only (tick fills, Bar fill) — var() does not resolve there. Never
// as HTML text: as 11px caption text MUTED measured 3.9:1 on the Dark card and GOLD is the Dark
// accent on every preset (S682). Text takes the tokens.
const GOLD  = '#c9a84c'
const MUTED = '#6b7280'
const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`

const TABS = [
  { key: 'overview',     label: 'Overview' },
  { key: 'trend',        label: 'Daily Trend' },
  { key: 'turnover',     label: 'Turnover Time' },
  { key: 'peak',         label: 'Peak Hours' },
  { key: 'server',       label: 'By Server' },
  { key: 'reservations', label: 'Reservations' },
]

// Party-size bands and the turnover roll-up live in coversMath.js (S677) so the Reservations
// settings tab shows the same measured minutes this report prints. One definition, two readers.

// "HH:MM" -> hours as a decimal (e.g. "22:30" -> 22.5). Returns null if unset/unparseable.
function parseHM(s) {
  if (!s) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  return Number(m[1]) + Number(m[2]) / 60
}

export default function CoversReport() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom } = useScopedDb()

  const [tab, setTab] = useState('overview')
  // Nepal's today, not the viewer's (S754) — see reportRange.js.
  const [fromIso, setFromIso] = useState(todayNepalAdIso)
  const [toIso,   setToIso]   = useState(todayNepalAdIso)
  // Paid bills closed in the range — dine-in AND takeaway/delivery, credit-noted ones included
  // (S754). Every cover figure filters to dine-in (coversMath.isDineIn); takeaway gets its own line.
  const [orders,       setOrders]       = useState([])
  // Credit notes issued in the range, as { order, net (negative), at } — `order` is the bill each
  // one credits, which may have closed before the range. Revenue figures are net of these; covers
  // are not touched by them (a credit note corrects billing, it does not un-seat the guests).
  const [returns,      setReturns]      = useState([])
  const [itemsByOrder, setItemsByOrder] = useState({})
  const [reservations, setReservations] = useState([]) // bookings whose time falls in the range (S677)
  const [vatReg,       setVatReg]       = useState(true)
  const [staffNames,   setStaffNames]   = useState({})
  const [totalSeats,   setTotalSeats]   = useState(0)
  const [loading,      setLoading]      = useState(true)
  // S612 silent-zero rule: a failed read must render as a failure, never as an empty range.
  const [loadError,    setLoadError]    = useState(null)
  const [bizInfo,      setBizInfo]      = useState({ name: '' })
  // Its own error slot (S754), as SalesReport's bizError. This read reported into `loadError` —
  // which loadRange clears on its first line, and both effects fire on mount — so a failed
  // client-name read was wiped by the range load beside it and the export shipped a blank
  // CompanyName with nothing on the page to say so.
  const [bizError,     setBizError]     = useState(null)

  // Operating hours — used only for RevPASH; NULL/unset just hides that one card rather than
  // blocking the rest of the report.
  const [settingsId, setSettingsId] = useState(null)
  const [openTime,  setOpenTime]  = useState('')
  const [closeTime, setCloseTime] = useState('')
  const [hoursSaving, setHoursSaving] = useState(false)
  const [hoursMsg,     setHoursMsg]    = useState('')

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    setBizError(null)
    supabase.from('clients').select('name').eq('id', clientId).single()
      // S612 silent-zero rule: a dropped error here would just blank the export letterhead.
      .then(({ data, error }) => {
        // An admin switching client mid-read must not have the previous client's name land.
        if (cancelled) return
        if (error) { setBizError(error); return }
        setBizInfo({ name: data?.name || '' })
      })
    return () => { cancelled = true }
  }, [clientId])

  // S754 overlapping-load guard: each picker change starts a load, and the slower of two used to
  // win the figures while the pickers — and so the export's scope line and filename — named the
  // other range. Keyed on client + range, so saveOperatingHours' reload of the same range passes.
  const rangeReq = useLatestRequest()

  const loadRange = useCallback(async () => {
    if (!clientId) return
    const reqKey = rangeReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setLoading(true)
    setLoadError(null)
    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)

    const results = await Promise.all([
      // Paged: every figure on this page (covers, RevPASH, turnover) divides by a count taken
      // from this read, so a truncation doesn't just shrink a total — it skews the averages.
      fetchAllRows(() => scopedFrom('pos_orders', 'id, table_id, table_name, covers, opened_at, closed_at, opened_by, discount_amount, credit_note_id')
        .eq('close_type', 'paid')
        .gte('closed_at', fromTs).lte('closed_at', toTs)
        .order('id')),
      supabase.from('settings').select('id, is_vat_registered, pos_open_time, pos_close_time').eq('client_id', clientId).maybeSingle(),
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      scopedFrom('pos_tables', 'id, capacity'),
      // Bookings by their BOOKED time, on the same range bounds as the bills so the tabs agree
      // with each other. Paged for the same reason the orders are: every rate below divides by
      // a count taken from this read.
      fetchAllRows(() => scopedFrom('pos_reservations', 'id, status, source, party_size, reserved_for, order_id')
        .gte('reserved_for', fromTs).lte('reserved_for', toTs)
        .order('id')),
      // Credit notes by the moment they were ISSUED, the Sales Report's rule (S754): revenue per
      // cover and RevPASH are net of the returns issued in the range. Paged with a unique sort.
      fetchAllRows(() => scopedFrom('pos_credit_notes', 'id, order_id, net_amount, created_at')
        .gte('created_at', fromTs).lte('created_at', toTs)
        .order('id')),
    ])
    if (!rangeReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read here would render a confident report of 0 covers,
    // visually identical to a genuinely quiet range.
    const failed = firstError(results)
    if (failed) {
      setLoadError(failed)
      setOrders([]); setReturns([]); setItemsByOrder({}); setReservations([])
      setLoading(false)
      return
    }
    const [{ data: orderData }, { data: settings }, { data: profs }, { data: tbls }, { data: resvData }, { data: noteData }] = results
    setReservations(resvData || [])
    setVatReg(settings?.is_vat_registered ?? true)
    setSettingsId(settings?.id || null)
    setOpenTime(settings?.pos_open_time || '')
    setCloseTime(settings?.pos_close_time || '')
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setTotalSeats((tbls || []).reduce((s, t) => s + (t.capacity || 0), 0))

    // Credit-noted bills are KEPT (S754). Covers are guests served, and a credit note corrects the
    // bill, not the sitting — dropping the bill took real guests out of covers, party size, turnover
    // and the booked/walk-in split. Its revenue correction is the credit note below, on the day it
    // was issued, exactly as the Sales Report now shows it.
    const orderList = orderData || []
    const noteList = noteData || []
    const orderIds = new Set(orderList.map(o => o.id))
    const outsideIds = [...new Set(noteList.map(n => n.order_id).filter(id => id && !orderIds.has(id)))]

    // Both derive their ids from the reads above and nothing from each other — one wave.
    const secondWave = await Promise.all([
      // Paged — a month of bill lines runs to thousands, past the silent 1000-row cap (S529).
      // Chunked as well (S754): the `.in()` list is every paid bill in the range, and a few hundred
      // uuids is past what a proxy accepts in a URL.
      fetchAllRowsChunked(orderList.map(o => o.id),
        ids => scopedFrom('pos_order_items', 'order_id, qty, unit_price, vat_rate, comped').in('order_id', ids).order('id')),
      // The bills this range's credit notes credit that closed before it: a return needs its bill's
      // table (dine-in or takeaway), party size (turnover band) and server.
      fetchAllRowsChunked(outsideIds,
        ids => scopedFrom('pos_orders', 'id, table_id, covers, opened_by').in('id', ids).order('id')),
    ])
    if (!rangeReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: with orders loaded but their lines dropped, every Net/RevPASH figure
    // would be a believable zero; with the credited bills dropped, a return would land nowhere.
    const secondFailed = firstError(secondWave)
    if (secondFailed) {
      setLoadError(secondFailed)
      setOrders([]); setReturns([]); setItemsByOrder({})
      setLoading(false)
      return
    }
    const [{ data: items }, { data: outsideOrders }] = secondWave
    const byOrder = (items || []).filter(i => !i.comped).reduce((acc, i) => {
      ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
      return acc
    }, {})
    const creditedById = Object.fromEntries([...orderList, ...(outsideOrders || [])].map(o => [o.id, o]))
    setOrders(orderList)
    setReturns(noteList.map(n => ({ order: creditedById[n.order_id] || null, net: -(Number(n.net_amount) || 0), at: n.created_at })))
    setItemsByOrder(byOrder)
    setLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, rangeReq])

  useEffect(() => { loadRange() }, [loadRange])

  async function saveOperatingHours() {
    if (!clientId) return
    setHoursSaving(true); setHoursMsg('')
    const payload = { pos_open_time: openTime || null, pos_close_time: closeTime || null }
    let error
    if (settingsId) {
      ;({ error } = await supabase.from('settings').update(payload).eq('id', settingsId))
    } else {
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, ...payload }))
    }
    setHoursSaving(false)
    setHoursMsg(error ? 'error:' + error.message : 'ok:Saved.')
    if (!error) loadRange()
  }

  /* ── derived rows ── */

  const netOf = useCallback(o => computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg).net, [itemsByOrder, vatReg])
  // Dine-in bills only — the population every cover figure below is built from (S754).
  const dineInOrders = useMemo(() => dineInOnly(orders), [orders])
  const dineInReturns = useMemo(() => returns.filter(r => isDineIn(r.order)), [returns])

  // Dine-in headline figures, net of dine-in returns, plus the takeaway/delivery line beside them.
  const totals = useMemo(() => coversTotals(orders, netOf, returns), [orders, netOf, returns])

  const openH  = parseHM(openTime)
  const closeH = parseHM(closeTime)
  const hoursPerDay = (openH != null && closeH != null)
    ? (closeH > openH ? closeH - openH : (24 - openH) + closeH) // handles an overnight close (e.g. 11:00 -> 01:00)
    : null
  const daysInRange = Math.max(1, Math.round((new Date(toIso) - new Date(fromIso)) / 86400000) + 1)
  const revPash = (hoursPerDay && totalSeats > 0)
    ? totals.net / (totalSeats * hoursPerDay * daysInRange) // dine-in net: seats earn only dine-in revenue
    : null

  const trendRows = useMemo(() => {
    const map = {}
    const bucket = ts => {
      // The BS day IN NEPAL, as SalesReport's Daily tab buckets it — adToBs reads local getters, so
      // a bill closed just after midnight Kathmandu fell into the previous day for a viewer abroad
      // and the two reports disagreed about the same day (S754).
      const civil = nepalCivilDate(ts)
      if (!civil) return null
      const bs = adToBs(civil)
      const key = `${bs.year}-${bs.month}-${bs.day}`
      return map[key] = map[key] || { key, year: bs.year, month: bs.month, day: bs.day, bills: 0, covers: 0, net: 0 }
    }
    for (const o of dineInOrders) {
      const b = bucket(o.closed_at)
      if (!b) continue
      b.bills += 1; b.covers += (o.covers || 0); b.net += netOf(o)
    }
    // A dine-in return on the day it was issued — the Sales Report's Daily rule.
    for (const r of dineInReturns) {
      const b = bucket(r.at)
      if (b) b.net += r.net
    }
    return Object.values(map)
      .sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day)
      .map(r => ({ ...r, revPerCover: r.covers > 0 ? r.net / r.covers : 0 }))
  }, [dineInOrders, dineInReturns, netOf])

  const trendChartData = trendRows.map(r => ({ name: `${r.day}/${r.month}`, value: r.covers }))
  const trendTotalCovers = trendRows.reduce((s, r) => s + r.covers, 0)
  const trendAvgPerDay = trendRows.length > 0 ? trendTotalCovers / trendRows.length : 0
  const trendBusiestDay = trendRows.length > 0 ? trendRows.reduce((best, r) => r.covers > best.covers ? r : best) : null

  const peakRows = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, covers: 0, bills: 0 }))
    for (const o of dineInOrders) {
      if (!o.opened_at) continue
      // Nepal's hour, not the runtime's — .getHours() put a client's dinner rush in the afternoon
      // for anyone viewing from outside the country, and named the wrong Peak Hour (S670).
      const h = nepalHour(o.opened_at)
      if (h == null) continue
      buckets[h].covers += (o.covers || 0); buckets[h].bills += 1
    }
    return buckets
  }, [dineInOrders])
  const peakChartData = peakRows.map(h => ({ name: hourLabel(h.hour), value: h.covers }))
  const peakTotalCovers = peakRows.reduce((s, h) => s + h.covers, 0)
  const peakBusiestHour = peakRows.reduce((best, h) => h.covers > best.covers ? h : best, peakRows[0])

  // Dine-in only: a takeaway bill's "dwell" is how long the bag took, not how long a table was held.
  const turnoverRows = useMemo(
    () => addReturnsByBand(turnoverByBand(dineInOrders, netOf), dineInReturns),
    [dineInOrders, netOf, dineInReturns]
  )

  // Bookings vs walk-ins. A booking is KEPT when it reached a table (seated or completed) and a
  // NO-SHOW when staff said so; the rate is no-shows over the bookings that were decided either
  // way — cancelled and still-open bookings are neither. Covers split by whether the bill's order
  // is one a booking was seated onto (pos_reservations.order_id).
  const resvStats = useMemo(() => {
    const isKept = r => r.status === 'completed' || r.status === 'seated'
    const noShows = reservations.filter(r => r.status === 'no_show').length
    const kept = reservations.filter(isKept).length
    const cancelled = reservations.filter(r => r.status === 'cancelled').length
    const decided = kept + noShows
    const bookedOrderIds = new Set(reservations.filter(r => r.order_id).map(r => r.order_id))
    let bookedCovers = 0, walkInCovers = 0
    for (const o of dineInOrders) {
      if (bookedOrderIds.has(o.id)) bookedCovers += (o.covers || 0)
      else walkInCovers += (o.covers || 0)
    }
    const bySource = {}
    for (const r of reservations) {
      const k = r.source || 'other'
      bySource[k] = bySource[k] || { source: k, bookings: 0, covers: 0, kept: 0, noShows: 0, cancelled: 0 }
      const s = bySource[k]
      s.bookings += 1; s.covers += (r.party_size || 0)
      if (isKept(r)) s.kept += 1
      if (r.status === 'no_show') s.noShows += 1
      if (r.status === 'cancelled') s.cancelled += 1
    }
    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, bookings: 0, covers: 0 }))
    for (const r of reservations) {
      const h = nepalHour(r.reserved_for)
      if (h == null) continue
      byHour[h].bookings += 1; byHour[h].covers += (r.party_size || 0)
    }
    return {
      total: reservations.length, kept, noShows, cancelled,
      noShowRate: decided > 0 ? noShows / decided : null,
      bookedCovers, walkInCovers,
      bySource: Object.values(bySource).sort((a, b) => b.bookings - a.bookings),
      byHour,
    }
  }, [reservations, dineInOrders])

  const serverRows = useMemo(() => {
    const map = {}
    const row = key => map[key] = map[key] || { staffId: key, name: staffNames[key] || '—', bills: 0, covers: 0, net: 0 }
    for (const o of dineInOrders) {
      const b = row(o.opened_by || 'unknown')
      b.bills += 1; b.covers += (o.covers || 0)
      b.net += netOf(o)
    }
    // A return comes off the server who opened the bill it credits.
    for (const r of dineInReturns) row(r.order.opened_by || 'unknown').net += r.net
    return Object.values(map)
      .map(r => ({ ...r, revPerCover: r.covers > 0 ? r.net / r.covers : 0 }))
      .sort((a, b) => b.covers - a.covers)
  }, [dineInOrders, dineInReturns, netOf, staffNames])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const dateRangeLine = `@As On Dated : ${fromIso} (B.S. ${bsSlash(fromIso)})  To : ${toIso} (B.S. ${bsSlash(toIso)})  @Division : ${bizInfo.name}  @Basis : dine-in bills only (takeaway/delivery excluded); sales net of credit notes issued in the range`
  function withLetterhead(XLSX, title, dataRows) {
    const aoa = [[title], [`CompanyName : ${bizInfo.name}`], [dateRangeLine], []]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    XLSX.utils.sheet_add_json(ws, dataRows, { origin: -1 })
    return ws
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    if (tab === 'trend') {
      const ws = withLetterhead(XLSX, 'Covers Report - Daily Trend', trendRows.map(r => ({
        'Date (BS)': `${r.day} ${BS_MONTHS[r.month - 1]} ${r.year}`, 'Dine-in Bills': r.bills, 'Covers': r.covers,
        'Dine-in Net Sales, after credit notes (NPR)': Math.round(r.net * 100) / 100, 'Revenue/Cover (NPR)': Math.round(r.revPerCover * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Daily Trend')
      XLSX.writeFile(wb, `covers-daily-trend-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'turnover') {
      const ws = withLetterhead(XLSX, 'Covers Report - Turnover Time', turnoverRows.map(r => ({
        'Party Size': r.label, 'Orders': r.orders, 'Covers': r.covers,
        'Avg Turnover (min)': Math.round(r.avgMinutes * 10) / 10, 'Net Sales (NPR)': Math.round(r.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Turnover Time')
      XLSX.writeFile(wb, `covers-turnover-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'peak') {
      const ws = withLetterhead(XLSX, 'Covers Report - Peak Hours', peakRows.filter(h => h.covers > 0).map(h => ({
        'Hour': hourLabel(h.hour), 'Bills': h.bills, 'Covers': h.covers,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Peak Hours')
      XLSX.writeFile(wb, `covers-peak-hours-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'server') {
      const ws = withLetterhead(XLSX, 'Covers Report - By Server', serverRows.map(r => ({
        'Staff': r.name, 'Dine-in Bills': r.bills, 'Covers': r.covers,
        'Dine-in Net Sales, after credit notes (NPR)': Math.round(r.net * 100) / 100, 'Revenue/Cover (NPR)': Math.round(r.revPerCover * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'By Server')
      XLSX.writeFile(wb, `covers-by-server-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'reservations') {
      const ws = withLetterhead(XLSX, 'Covers Report - Reservations', resvStats.bySource.map(r => ({
        'Booked via': SOURCE_LABEL[r.source] || r.source, 'Bookings': r.bookings, 'Guests booked': r.covers,
        'Kept': r.kept, 'No-shows': r.noShows, 'Cancelled': r.cancelled,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Reservations')
      XLSX.writeFile(wb, `covers-reservations-${fromIso}-to-${toIso}.xlsx`)
    }
  }

  // Overview also carries the takeaway/delivery line, so it is empty only when there is nothing at
  // all; every other bill tab is dine-in only, and says so when takeaway is all there was.
  const isEmpty = tab === 'reservations' ? reservations.length === 0
    : tab === 'overview' ? orders.length === 0 && returns.length === 0
    : dineInOrders.length === 0
  const bizErrorInfo = bizError ? errorInfo(bizError, 'operator') : null

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">
            Covers Report <Tip text="How guest traffic (not just revenue) moves through the floor — average party size, revenue per guest, how long tables turn, and when covers actually peak." width={320}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">
            Covers = the "How many guests?" number entered when a table is opened. Dine-in bills only — takeaway and delivery are shown on their own line.
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Overview is KPI cards + a settings form — nothing tabular to export (S613). */}
          {tab !== 'overview' && (
            // Off while loading or failed, not only when empty (S728/S754): the filename and scope
            // line come from the pickers, which move before the data does.
            // …and off while the letterhead's client-name read has failed (S754).
            <button className="btn btn-ghost" onClick={exportExcel} disabled={isEmpty || loading || !!loadError || !!bizError}>⬇ Excel</button>
          )}
        </div>
      </div>

      <Tabs idBase="pos-covers-report" label="Covers Report views" tabs={TABS} active={tab} onChange={setTab} style={{ marginBottom: 16 }} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="covers-report-from-bs">From (BS)</label>
          <BsCalendarPicker id="covers-report-from-bs" value={fromIso} onChange={setFromIso} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="covers-report-to-bs">To (BS)</label>
          <BsCalendarPicker id="covers-report-to-bs" value={toIso} onChange={setToIso} />
        </div>
      </div>

      {/* S754: the letterhead read fails independently of the range load, so it has its own notice
          rather than borrowing loadError (which loadRange clears). */}
      {bizErrorInfo && (
        <div className="card report-error" role="alert" style={{ marginBottom: 16 }}>
          <div className="report-error-title">Could not load this outlet's name</div>
          <p className="report-error-body">{bizErrorInfo.text}</p>
          <p className="report-error-hint">
            Excel is switched off rather than exporting a sheet with a blank company name. The figures
            below are unaffected. Reload the page to try again.
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
          {tab !== 'overview' && orders.length > 0
            ? `No dine-in bills in this range — only takeaway or delivery (${orders.length} bill${orders.length === 1 ? '' : 's'}), which have no covers. See Overview for their sales.`
            : 'No paid bills in this range.'}
        </div>
      ) : tab === 'overview' ? (
        <>
          {/* KPI strip — the shared stat-grid/stat-card grammar (S613); `gold` is the shell's
              accent-as-text class, same accent-ink the hand-rolled tile used. */}
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Sum of the covers entered when each table was opened, across every paid dine-in bill in this range. Takeaway and delivery bills have no table and no guests seated, so they are counted separately. A bill later credited still counts — the guests were served." width={280}>Covers Served</Tip>
              </div>
              <div className="stat-value">{totals.covers}</div>
              <div className="stat-sub">{totals.bills} dine-in bill{totals.bills !== 1 ? 's' : ''}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Covers served ÷ dine-in bills — are you mostly seating couples, families, or large groups?" width={250}>Avg Party Size</Tip>
              </div>
              <div className="stat-value">{totals.avgParty.toFixed(1)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Dine-in net sales ÷ covers served — the standard restaurant 'average check per guest' metric. Net sales are after credit notes issued in this range against dine-in bills, the same way the Sales Report's Net is." width={290}>Revenue / Cover</Tip>
              </div>
              <div className="stat-value gold">{fmtNpr(totals.revPerCover)}</div>
              {totals.returns > 0 && <div className="stat-sub">after {totals.returns} credit note{totals.returns === 1 ? '' : 's'}</div>}
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Revenue Per Available Seat-Hour — dine-in net sales (after credit notes) ÷ (total seats × operating hours in this range). Takeaway and delivery do not use a seat, so they are left out. Set your operating hours below to see this." width={300}>RevPASH</Tip>
              </div>
              {revPash !== null ? (
                <div className="stat-value">{fmtNpr(revPash)}</div>
              ) : (
                <div className="stat-sub" style={{ marginTop: 0 }}>Set operating hours below</div>
              )}
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Paid bills with no table — takeaway and delivery. They are kept out of every cover figure on this page, because no guest was seated; this is their sales, after credit notes issued in this range against them." width={300}>Takeaway &amp; Delivery</Tip>
              </div>
              <div className="stat-value">{fmtNpr(totals.takeaway.net)}</div>
              <div className="stat-sub">
                {totals.takeaway.bills} bill{totals.takeaway.bills !== 1 ? 's' : ''}
                {totals.takeaway.returns > 0 && ` · after ${totals.takeaway.returns} credit note${totals.takeaway.returns === 1 ? '' : 's'}`}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: '16px 18px', maxWidth: 420 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', marginBottom: 10 }}>
              Operating Hours <Tip text="Used only to compute RevPASH above — a single daily open/close time, not per-weekday" width={260}>ⓘ</Tip>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="covers-report-open">Open</label>
                <input id="covers-report-open" type="time" className="form-input form-input--auto" value={openTime} onChange={e => setOpenTime(e.target.value)} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="covers-report-close">Close</label>
                <input id="covers-report-close" type="time" className="form-input form-input--auto" value={closeTime} onChange={e => setCloseTime(e.target.value)} />
              </div>
              <button className="btn btn-primary" disabled={hoursSaving} onClick={saveOperatingHours}>
                {hoursSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {hoursMsg && (
              <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, color: hoursMsg.startsWith('error') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                {hoursMsg.slice(hoursMsg.indexOf(':') + 1)}
              </p>
            )}
          </div>
        </>
      ) : tab === 'trend' ? (
        <>
          <ChartCard
            title="Covers Served by Day"
            cardStyle={{ marginBottom: 24 }}
            footer={trendRows.length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 8 }}>
                Total <strong style={{ color: 'var(--theme-text1)' }}>{trendTotalCovers.toLocaleString('en-IN')}</strong> covers
                {' '}· avg <strong style={{ color: 'var(--theme-text1)' }}>{trendAvgPerDay.toFixed(1)}</strong>/day
                {trendBusiestDay && <> · busiest <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{trendBusiestDay.day}/{trendBusiestDay.month}</span> ({trendBusiestDay.covers} covers)</>}
              </div>
            )}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={trendChartData} margin={{ top: 0, right: 10, left: 0, bottom: 10 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED, fontSize: 11 }} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ ...TOOLTIP_CHROME, fontSize: 12, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }} itemStyle={{ color: 'var(--theme-text1)' }}
                    formatter={v => [v, 'Covers']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={GOLD} {...chartMotion()} />
                </BarChart>
              </ResponsiveContainer>
            )}
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date (BS)</th><th style={{ textAlign: 'right' }}>Dine-in Bills</th><th style={{ textAlign: 'right' }}>Covers</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Dine-in net sales. A credit note against a dine-in bill comes off the day it was issued, as on the Sales Report's Daily tab." width={280}>Net Sales</Tip></th>
                  <th style={{ textAlign: 'right' }}>Revenue/Cover</th>
                </tr>
              </thead>
              <tbody>
                {trendRows.map(r => (
                  <tr key={r.key}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.day} {BS_MONTHS[r.month - 1]} {r.year}</td>
                    <td style={{ textAlign: 'right' }}>{r.bills}</td>
                    <td style={{ textAlign: 'right' }}>{r.covers}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(r.net)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(r.revPerCover)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : tab === 'turnover' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Party Size <Tip text="Dine-in orders bucketed by the covers entered at table-open time">ⓘ</Tip></th>
                <th style={{ textAlign: 'right' }}>Orders</th><th style={{ textAlign: 'right' }}>Covers</th>
                <th style={{ textAlign: 'right' }}>Avg Turnover <Tip text="Average time from opening the table to closing/paying the bill, for dine-in orders in this band. Takeaway and delivery never hold a table, so they are left out.">ⓘ</Tip></th>
                <th style={{ textAlign: 'right' }}><Tip text="Dine-in net sales for this band, less credit notes issued in this range against bills of this party size." width={280}>Net Sales</Tip></th>
              </tr>
            </thead>
            <tbody>
              {turnoverRows.map(b => (
                <tr key={b.key}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{b.label}</td>
                  <td style={{ textAlign: 'right' }}>{b.orders}</td>
                  <td style={{ textAlign: 'right' }}>{b.covers}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{b.orders > 0 ? `${Math.round(b.avgMinutes)} min` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(b.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'reservations' ? (
        reservations.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
            No bookings in this range. Bookings are taken on the Reservations page or through the outlet's booking link.
          </div>
        ) : (
          <>
            <div className="stat-grid" style={{ marginBottom: 20 }}>
              <div className="stat-card">
                <div className="stat-label">Bookings</div>
                <div className="stat-value">{resvStats.total}</div>
                <div className="stat-sub">{resvStats.kept} kept · {resvStats.cancelled} cancelled</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">No-show rate <Tip text="No-shows ÷ (kept + no-shows). Cancelled and still-open bookings are neither, so they do not dilute it." width={240}>ⓘ</Tip></div>
                <div className="stat-value" style={{ color: resvStats.noShowRate != null && resvStats.noShowRate >= 0.1 ? 'var(--theme-red-text)' : undefined }}>
                  {resvStats.noShowRate == null ? '—' : `${(resvStats.noShowRate * 100).toFixed(1)}%`}
                </div>
                <div className="stat-sub">{resvStats.noShows} no-show{resvStats.noShows === 1 ? '' : 's'}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Booked covers <Tip text="Covers on bills that a booking was seated onto — the party size becomes the order's covers at seating." width={240}>ⓘ</Tip></div>
                <div className="stat-value">{resvStats.bookedCovers.toLocaleString('en-IN')}</div>
                <div className="stat-sub">
                  {resvStats.bookedCovers + resvStats.walkInCovers > 0
                    ? `${Math.round(100 * resvStats.bookedCovers / (resvStats.bookedCovers + resvStats.walkInCovers))}% of covers served`
                    : 'no covers served'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Walk-in covers</div>
                <div className="stat-value">{resvStats.walkInCovers.toLocaleString('en-IN')}</div>
                <div className="stat-sub">dine-in bills with no booking behind them</div>
              </div>
            </div>

            <div className="table-wrap" style={{ marginBottom: 24 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Booked via <Tip text="How the booking reached you — phone, WhatsApp, a walk-in asking for later, the booking link." width={220}>ⓘ</Tip></th>
                    <th style={{ textAlign: 'right' }}>Bookings</th>
                    <th style={{ textAlign: 'right' }}>Guests booked</th>
                    <th style={{ textAlign: 'right' }}>Kept</th>
                    <th style={{ textAlign: 'right' }}>No-shows</th>
                    <th style={{ textAlign: 'right' }}>Cancelled</th>
                  </tr>
                </thead>
                <tbody>
                  {resvStats.bySource.map(r => (
                    <tr key={r.source}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{SOURCE_LABEL[r.source] || r.source}</td>
                      <td style={{ textAlign: 'right' }}>{r.bookings}</td>
                      <td style={{ textAlign: 'right' }}>{r.covers}</td>
                      <td style={{ textAlign: 'right' }}>{r.kept}</td>
                      <td style={{ textAlign: 'right', fontWeight: r.noShows > 0 ? 700 : 400 }}>{r.noShows}</td>
                      <td style={{ textAlign: 'right' }}>{r.cancelled}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td style={{ textAlign: 'right' }}>{resvStats.total}</td>
                    <td style={{ textAlign: 'right' }}>{resvStats.bySource.reduce((s, r) => s + r.covers, 0)}</td>
                    <td style={{ textAlign: 'right' }}>{resvStats.kept}</td>
                    <td style={{ textAlign: 'right' }}>{resvStats.noShows}</td>
                    <td style={{ textAlign: 'right' }}>{resvStats.cancelled}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Booked for <Tip text="The hour bookings were made FOR (their booked time), not when they were taken." width={220}>ⓘ</Tip></th>
                    <th style={{ textAlign: 'right' }}>Bookings</th>
                    <th style={{ textAlign: 'right' }}>Guests booked</th>
                  </tr>
                </thead>
                <tbody>
                  {resvStats.byHour.filter(h => h.bookings > 0).map(h => (
                    <tr key={h.hour}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{hourLabel(h.hour)}</td>
                      <td style={{ textAlign: 'right' }}>{h.bookings}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{h.covers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : tab === 'peak' ? (
        <>
          <ChartCard
            title="Covers by Hour Seated"
            cardStyle={{ marginBottom: 24 }}
            footer={peakTotalCovers > 0 && (
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 8 }}>
                Total <strong style={{ color: 'var(--theme-text1)' }}>{peakTotalCovers.toLocaleString('en-IN')}</strong> covers
                {peakBusiestHour && peakBusiestHour.covers > 0 && <> · peak hour <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{hourLabel(peakBusiestHour.hour)}</span> ({peakBusiestHour.covers} covers)</>}
              </div>
            )}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={peakChartData} margin={{ top: 0, right: 10, left: 0, bottom: 30 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED, fontSize: 11 }} angle={-45} textAnchor="end" interval={1} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ ...TOOLTIP_CHROME, fontSize: 12, color: 'var(--theme-text1)' }}
                    labelStyle={{ color: 'var(--theme-text1)' }} itemStyle={{ color: 'var(--theme-text1)' }}
                    formatter={v => [v, 'Covers']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={GOLD} {...chartMotion()} />
                </BarChart>
              </ResponsiveContainer>
            )}
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Hour <Tip text="Hour the table was opened (guests seated), not when the bill was paid. Dine-in bills only.">ⓘ</Tip></th><th style={{ textAlign: 'right' }}>Bills</th><th style={{ textAlign: 'right' }}>Covers</th></tr></thead>
              <tbody>
                {peakRows.filter(h => h.covers > 0).map(h => (
                  <tr key={h.hour}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{hourLabel(h.hour)}</td>
                    <td style={{ textAlign: 'right' }}>{h.bills}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{h.covers}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Staff</th><th style={{ textAlign: 'right' }}>Dine-in Bills</th><th style={{ textAlign: 'right' }}>Covers</th>
                <th style={{ textAlign: 'right' }}><Tip text="Dine-in net sales on the tables this person opened, less credit notes issued in this range against those bills." width={280}>Net Sales</Tip></th>
                <th style={{ textAlign: 'right' }}>Revenue/Cover</th>
              </tr>
            </thead>
            <tbody>
              {serverRows.map(r => (
                <tr key={r.staffId}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</td>
                  <td style={{ textAlign: 'right' }}>{r.bills}</td>
                  <td style={{ textAlign: 'right' }}>{r.covers}</td>
                  <td style={{ textAlign: 'right' }}>{fmtNpr(r.net)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(r.revPerCover)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
