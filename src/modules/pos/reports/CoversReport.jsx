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
import { formatAd, adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { computeOrderAmounts } from '../../../utils/posBillingMath'
import { nepalHour } from '../../../shared/nepalTime'
import { turnoverByBand } from './coversMath'
import { SOURCE_LABEL } from '../reservations/reservationStatus'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const GOLD  = '#c9a84c'
const MUTED = '#6b7280'
const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
const bsSlash = iso => { const bs = adToBs(new Date(iso)); return `${String(bs.day).padStart(2, '0')}/${String(bs.month).padStart(2, '0')}/${bs.year}` }

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
  const [fromIso, setFromIso] = useState(formatAd(new Date()))
  const [toIso,   setToIso]   = useState(formatAd(new Date()))
  const [orders,       setOrders]       = useState([])
  const [itemsByOrder, setItemsByOrder] = useState({})
  const [reservations, setReservations] = useState([]) // bookings whose time falls in the range (S677)
  const [vatReg,       setVatReg]       = useState(true)
  const [staffNames,   setStaffNames]   = useState({})
  const [totalSeats,   setTotalSeats]   = useState(0)
  const [loading,      setLoading]      = useState(true)
  // S612 silent-zero rule: a failed read must render as a failure, never as an empty range.
  const [loadError,    setLoadError]    = useState(null)
  const [bizInfo,      setBizInfo]      = useState({ name: '' })

  // Operating hours — used only for RevPASH; NULL/unset just hides that one card rather than
  // blocking the rest of the report.
  const [settingsId, setSettingsId] = useState(null)
  const [openTime,  setOpenTime]  = useState('')
  const [closeTime, setCloseTime] = useState('')
  const [hoursSaving, setHoursSaving] = useState(false)
  const [hoursMsg,     setHoursMsg]    = useState('')

  useEffect(() => {
    if (!clientId) return
    supabase.from('clients').select('name').eq('id', clientId).single()
      // S612 silent-zero rule: a dropped error here would just blank the export letterhead.
      .then(({ data, error }) => {
        if (error) { setLoadError(error.message); return }
        setBizInfo({ name: data?.name || '' })
      })
  }, [clientId])

  const loadRange = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    setLoadError(null)
    const fromTs = new Date(fromIso + 'T00:00:00').toISOString()
    const toTs   = new Date(toIso + 'T23:59:59.999').toISOString()

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
    ])
    // S612 silent-zero rule: a failed read here would render a confident report of 0 covers,
    // visually identical to a genuinely quiet range.
    const failed = firstError(results)
    if (failed) {
      setLoadError(failed)
      setOrders([]); setItemsByOrder({}); setReservations([])
      setLoading(false)
      return
    }
    const [{ data: orderData }, { data: settings }, { data: profs }, { data: tbls }, { data: resvData }] = results
    setReservations(resvData || [])
    setVatReg(settings?.is_vat_registered ?? true)
    setSettingsId(settings?.id || null)
    setOpenTime(settings?.pos_open_time || '')
    setCloseTime(settings?.pos_close_time || '')
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setTotalSeats((tbls || []).reduce((s, t) => s + (t.capacity || 0), 0))

    // Same exclusion rule as Sales Report — a since-Credit-Noted bill's revenue correction posts
    // on the day the Credit Note is issued, not retroactively here.
    const orderList = (orderData || []).filter(o => !o.credit_note_id)
    setOrders(orderList)

    let byOrder = {}
    if (orderList.length > 0) {
      // Paged — a month of bill lines runs to thousands, past the silent 1000-row cap (S529).
      const { data: items, error: itemsError } = await fetchAllRows(() => scopedFrom('pos_order_items', 'order_id, qty, unit_price, vat_rate, comped').in('order_id', orderList.map(o => o.id)).order('id'))
      // S612 silent-zero rule: with orders loaded but their lines dropped, every Net/RevPASH
      // figure would be a believable zero.
      if (itemsError) {
        setLoadError(itemsError.message || String(itemsError))
        setOrders([]); setItemsByOrder({})
        setLoading(false)
        return
      }
      byOrder = (items || []).filter(i => !i.comped).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
    }
    setItemsByOrder(byOrder)
    setLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom])

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

  const totals = useMemo(() => {
    let bills = 0, covers = 0, net = 0
    for (const o of orders) {
      bills += 1; covers += (o.covers || 0)
      net += computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg).net
    }
    return {
      bills, covers, net,
      avgParty:    bills  > 0 ? covers / bills  : 0,
      revPerCover: covers > 0 ? net / covers    : 0,
    }
  }, [orders, itemsByOrder, vatReg])

  const openH  = parseHM(openTime)
  const closeH = parseHM(closeTime)
  const hoursPerDay = (openH != null && closeH != null)
    ? (closeH > openH ? closeH - openH : (24 - openH) + closeH) // handles an overnight close (e.g. 11:00 -> 01:00)
    : null
  const daysInRange = Math.max(1, Math.round((new Date(toIso) - new Date(fromIso)) / 86400000) + 1)
  const revPash = (hoursPerDay && totalSeats > 0)
    ? totals.net / (totalSeats * hoursPerDay * daysInRange)
    : null

  const trendRows = useMemo(() => {
    const map = {}
    for (const o of orders) {
      const amounts = computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg)
      const bs = adToBs(new Date(o.closed_at))
      const key = `${bs.year}-${bs.month}-${bs.day}`
      map[key] = map[key] || { key, year: bs.year, month: bs.month, day: bs.day, bills: 0, covers: 0, net: 0 }
      const b = map[key]
      b.bills += 1; b.covers += (o.covers || 0); b.net += amounts.net
    }
    return Object.values(map)
      .sort((a, b) => a.year - b.year || a.month - b.month || a.day - b.day)
      .map(r => ({ ...r, revPerCover: r.covers > 0 ? r.net / r.covers : 0 }))
  }, [orders, itemsByOrder, vatReg])

  const trendChartData = trendRows.map(r => ({ name: `${r.day}/${r.month}`, value: r.covers }))
  const trendTotalCovers = trendRows.reduce((s, r) => s + r.covers, 0)
  const trendAvgPerDay = trendRows.length > 0 ? trendTotalCovers / trendRows.length : 0
  const trendBusiestDay = trendRows.length > 0 ? trendRows.reduce((best, r) => r.covers > best.covers ? r : best) : null

  const peakRows = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, covers: 0, bills: 0 }))
    for (const o of orders) {
      if (!o.opened_at) continue
      // Nepal's hour, not the runtime's — .getHours() put a client's dinner rush in the afternoon
      // for anyone viewing from outside the country, and named the wrong Peak Hour (S670).
      const h = nepalHour(o.opened_at)
      if (h == null) continue
      buckets[h].covers += (o.covers || 0); buckets[h].bills += 1
    }
    return buckets
  }, [orders])
  const peakChartData = peakRows.map(h => ({ name: hourLabel(h.hour), value: h.covers }))
  const peakTotalCovers = peakRows.reduce((s, h) => s + h.covers, 0)
  const peakBusiestHour = peakRows.reduce((best, h) => h.covers > best.covers ? h : best, peakRows[0])

  const turnoverRows = useMemo(
    () => turnoverByBand(orders, o => computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg).net),
    [orders, itemsByOrder, vatReg]
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
    for (const o of orders) {
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
  }, [reservations, orders])

  const serverRows = useMemo(() => {
    const map = {}
    for (const o of orders) {
      const key = o.opened_by || 'unknown'
      map[key] = map[key] || { staffId: key, name: staffNames[key] || '—', bills: 0, covers: 0, net: 0 }
      const b = map[key]
      b.bills += 1; b.covers += (o.covers || 0)
      b.net += computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg).net
    }
    return Object.values(map)
      .map(r => ({ ...r, revPerCover: r.covers > 0 ? r.net / r.covers : 0 }))
      .sort((a, b) => b.covers - a.covers)
  }, [orders, itemsByOrder, vatReg, staffNames])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const dateRangeLine = `@As On Dated : ${fromIso} (B.S. ${bsSlash(fromIso)})  To : ${toIso} (B.S. ${bsSlash(toIso)})  @Division : ${bizInfo.name}`
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
        'Date (BS)': `${r.day} ${BS_MONTHS[r.month - 1]} ${r.year}`, 'Bills': r.bills, 'Covers': r.covers,
        'Net Sales (NPR)': Math.round(r.net * 100) / 100, 'Revenue/Cover (NPR)': Math.round(r.revPerCover * 100) / 100,
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
        'Staff': r.name, 'Bills': r.bills, 'Covers': r.covers,
        'Net Sales (NPR)': Math.round(r.net * 100) / 100, 'Revenue/Cover (NPR)': Math.round(r.revPerCover * 100) / 100,
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

  const isEmpty = tab === 'reservations' ? reservations.length === 0 : orders.length === 0

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">
            Covers Report <Tip text="How guest traffic (not just revenue) moves through the floor — average party size, revenue per guest, how long tables turn, and when covers actually peak." width={320}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">
            Covers = the "How many guests?" number entered when a table is opened.
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Overview is KPI cards + a settings form — nothing tabular to export (S613). */}
          {tab !== 'overview' && (
            <button className="btn btn-ghost" onClick={exportExcel} disabled={isEmpty}>⬇ Excel</button>
          )}
        </div>
      </div>

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.key} className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

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

      {/* S612: a failed read renders as a failure — never as the empty state or a zero table. */}
      {loadError ? (
        <ReportLoadError error={loadError} />
      ) : loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : isEmpty ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          No paid bills in this range.
        </div>
      ) : tab === 'overview' ? (
        <>
          {/* KPI strip — the shared stat-grid/stat-card grammar (S613); `gold` is the shell's
              accent-as-text class, same accent-ink the hand-rolled tile used. */}
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Sum of the covers entered when each table was opened, across every paid bill in this range" width={250}>Covers Served</Tip>
              </div>
              <div className="stat-value">{totals.covers}</div>
              <div className="stat-sub">{totals.bills} bill{totals.bills !== 1 ? 's' : ''}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Covers served ÷ bills — are you mostly seating couples, families, or large groups?" width={250}>Avg Party Size</Tip>
              </div>
              <div className="stat-value">{totals.avgParty.toFixed(1)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Net sales ÷ covers served — the standard restaurant 'average check per guest' metric" width={260}>Revenue / Cover</Tip>
              </div>
              <div className="stat-value gold">{fmtNpr(totals.revPerCover)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Revenue Per Available Seat-Hour — net sales ÷ (total seats × operating hours in this range). Set your operating hours below to see this." width={300}>RevPASH</Tip>
              </div>
              {revPash !== null ? (
                <div className="stat-value">{fmtNpr(revPash)}</div>
              ) : (
                <div className="stat-sub" style={{ marginTop: 0 }}>Set operating hours below</div>
              )}
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
              <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
                Total <strong style={{ color: 'var(--theme-text1)' }}>{trendTotalCovers.toLocaleString()}</strong> covers
                {' '}· avg <strong style={{ color: 'var(--theme-text1)' }}>{trendAvgPerDay.toFixed(1)}</strong>/day
                {trendBusiestDay && <> · busiest <span style={{ color: GOLD, fontWeight: 600 }}>{trendBusiestDay.day}/{trendBusiestDay.month}</span> ({trendBusiestDay.covers} covers)</>}
              </div>
            )}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={trendChartData} margin={{ top: 0, right: 10, left: 0, bottom: 10 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED, fontSize: 11 }} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 8, fontSize: 12, color: '#e8e0d0' }}
                    labelStyle={{ color: '#e8e0d0' }} itemStyle={{ color: '#e8e0d0' }}
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
                  <th>Date (BS)</th><th style={{ textAlign: 'right' }}>Bills</th><th style={{ textAlign: 'right' }}>Covers</th>
                  <th style={{ textAlign: 'right' }}>Net Sales</th><th style={{ textAlign: 'right' }}>Revenue/Cover</th>
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
                <th>Party Size <Tip text="Orders bucketed by the covers entered at table-open time">ⓘ</Tip></th>
                <th style={{ textAlign: 'right' }}>Orders</th><th style={{ textAlign: 'right' }}>Covers</th>
                <th style={{ textAlign: 'right' }}>Avg Turnover <Tip text="Average time from opening the table to closing/paying the bill, for orders in this band">ⓘ</Tip></th>
                <th style={{ textAlign: 'right' }}>Net Sales</th>
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
                <div className="stat-value">{resvStats.bookedCovers.toLocaleString()}</div>
                <div className="stat-sub">
                  {resvStats.bookedCovers + resvStats.walkInCovers > 0
                    ? `${Math.round(100 * resvStats.bookedCovers / (resvStats.bookedCovers + resvStats.walkInCovers))}% of covers served`
                    : 'no covers served'}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Walk-in covers</div>
                <div className="stat-value">{resvStats.walkInCovers.toLocaleString()}</div>
                <div className="stat-sub">bills with no booking behind them</div>
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
              <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
                Total <strong style={{ color: 'var(--theme-text1)' }}>{peakTotalCovers.toLocaleString()}</strong> covers
                {peakBusiestHour && peakBusiestHour.covers > 0 && <> · peak hour <span style={{ color: GOLD, fontWeight: 600 }}>{hourLabel(peakBusiestHour.hour)}</span> ({peakBusiestHour.covers} covers)</>}
              </div>
            )}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={peakChartData} margin={{ top: 0, right: 10, left: 0, bottom: 30 }}>
                  <XAxis dataKey="name" tick={{ fill: MUTED, fontSize: 11 }} angle={-45} textAnchor="end" interval={1} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 8, fontSize: 12, color: '#e8e0d0' }}
                    labelStyle={{ color: '#e8e0d0' }} itemStyle={{ color: '#e8e0d0' }}
                    formatter={v => [v, 'Covers']}
                  />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={GOLD} {...chartMotion()} />
                </BarChart>
              </ResponsiveContainer>
            )}
          />
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Hour <Tip text="Hour the table was opened (guests seated), not when the bill was paid">ⓘ</Tip></th><th style={{ textAlign: 'right' }}>Bills</th><th style={{ textAlign: 'right' }}>Covers</th></tr></thead>
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
                <th>Staff</th><th style={{ textAlign: 'right' }}>Bills</th><th style={{ textAlign: 'right' }}>Covers</th>
                <th style={{ textAlign: 'right' }}>Net Sales</th><th style={{ textAlign: 'right' }}>Revenue/Cover</th>
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
