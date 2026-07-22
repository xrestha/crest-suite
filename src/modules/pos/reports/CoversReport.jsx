import { useState, useEffect, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import * as XLSX from 'xlsx'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import ChartCard from '../../../components/ChartCard'
import { formatAd, adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { computeOrderAmounts } from '../../../utils/posBillingMath'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const GOLD  = '#c9a84c'
const MUTED = '#6b7280'
const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
const bsSlash = iso => { const bs = adToBs(new Date(iso)); return `${String(bs.day).padStart(2, '0')}/${String(bs.month).padStart(2, '0')}/${bs.year}` }

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'trend',    label: 'Daily Trend' },
  { key: 'turnover', label: 'Turnover Time' },
  { key: 'peak',     label: 'Peak Hours' },
  { key: 'server',   label: 'By Server' },
]

// Party-size bands for Turnover Time — a 2-top and an 8-top have very different expected dine
// durations, so one blended average across every order wouldn't tell a manager much.
const PARTY_BANDS = [
  { key: '1-2', label: '1–2 covers', test: c => c <= 2 },
  { key: '3-4', label: '3–4 covers', test: c => c >= 3 && c <= 4 },
  { key: '5-6', label: '5–6 covers', test: c => c >= 5 && c <= 6 },
  { key: '7+',  label: '7+ covers',  test: c => c >= 7 },
]

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
  const [vatReg,       setVatReg]       = useState(true)
  const [staffNames,   setStaffNames]   = useState({})
  const [totalSeats,   setTotalSeats]   = useState(0)
  const [loading,      setLoading]      = useState(true)
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
      .then(({ data }) => setBizInfo({ name: data?.name || '' }))
  }, [clientId])

  const loadRange = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const fromTs = new Date(fromIso + 'T00:00:00').toISOString()
    const toTs   = new Date(toIso + 'T23:59:59.999').toISOString()

    const [{ data: orderData }, { data: settings }, { data: profs }, { data: tbls }] = await Promise.all([
      scopedFrom('pos_orders', 'id, table_id, table_name, covers, opened_at, closed_at, opened_by, discount_amount, credit_note_id')
        .eq('close_type', 'paid')
        .gte('closed_at', fromTs).lte('closed_at', toTs),
      supabase.from('settings').select('id, is_vat_registered, pos_open_time, pos_close_time').eq('client_id', clientId).maybeSingle(),
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      scopedFrom('pos_tables', 'id, capacity'),
    ])
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
      const { data: items } = await scopedFrom('pos_order_items', 'order_id, qty, unit_price, vat_rate, comped').in('order_id', orderList.map(o => o.id))
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

  const peakRows = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, covers: 0, bills: 0 }))
    for (const o of orders) {
      if (!o.opened_at) continue
      const h = new Date(o.opened_at).getHours()
      buckets[h].covers += (o.covers || 0); buckets[h].bills += 1
    }
    return buckets
  }, [orders])
  const peakChartData = peakRows.map(h => ({ name: hourLabel(h.hour), value: h.covers }))

  const turnoverRows = useMemo(() => {
    const buckets = PARTY_BANDS.map(b => ({ ...b, orders: 0, totalMinutes: 0, covers: 0, net: 0 }))
    for (const o of orders) {
      if (!o.opened_at || !o.closed_at) continue
      const mins = (new Date(o.closed_at) - new Date(o.opened_at)) / 60000
      if (mins < 0) continue
      const band = buckets.find(b => b.test(o.covers || 0))
      if (!band) continue
      band.orders += 1; band.totalMinutes += mins; band.covers += (o.covers || 0)
      band.net += computeOrderAmounts(o, itemsByOrder[o.id] || [], vatReg).net
    }
    return buckets.map(b => ({ ...b, avgMinutes: b.orders > 0 ? b.totalMinutes / b.orders : 0 }))
  }, [orders, itemsByOrder, vatReg])

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
  function withLetterhead(title, dataRows) {
    const aoa = [[title], [`CompanyName : ${bizInfo.name}`], [dateRangeLine], []]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    XLSX.utils.sheet_add_json(ws, dataRows, { origin: -1 })
    return ws
  }

  function exportExcel() {
    const wb = XLSX.utils.book_new()
    if (tab === 'trend') {
      const ws = withLetterhead('Covers Report - Daily Trend', trendRows.map(r => ({
        'Date (BS)': `${r.day} ${BS_MONTHS[r.month - 1]} ${r.year}`, 'Bills': r.bills, 'Covers': r.covers,
        'Net Sales (NPR)': Math.round(r.net * 100) / 100, 'Revenue/Cover (NPR)': Math.round(r.revPerCover * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Daily Trend')
      XLSX.writeFile(wb, `covers-daily-trend-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'turnover') {
      const ws = withLetterhead('Covers Report - Turnover Time', turnoverRows.map(r => ({
        'Party Size': r.label, 'Orders': r.orders, 'Covers': r.covers,
        'Avg Turnover (min)': Math.round(r.avgMinutes * 10) / 10, 'Net Sales (NPR)': Math.round(r.net * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Turnover Time')
      XLSX.writeFile(wb, `covers-turnover-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'peak') {
      const ws = withLetterhead('Covers Report - Peak Hours', peakRows.filter(h => h.covers > 0).map(h => ({
        'Hour': hourLabel(h.hour), 'Bills': h.bills, 'Covers': h.covers,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Peak Hours')
      XLSX.writeFile(wb, `covers-peak-hours-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'server') {
      const ws = withLetterhead('Covers Report - By Server', serverRows.map(r => ({
        'Staff': r.name, 'Bills': r.bills, 'Covers': r.covers,
        'Net Sales (NPR)': Math.round(r.net * 100) / 100, 'Revenue/Cover (NPR)': Math.round(r.revPerCover * 100) / 100,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'By Server')
      XLSX.writeFile(wb, `covers-by-server-${fromIso}-to-${toIso}.xlsx`)
    }
  }

  const isEmpty = orders.length === 0

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1150 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>
          Covers Report <Tip text="How guest traffic (not just revenue) moves through the floor — average party size, revenue per guest, how long tables turn, and when covers actually peak." width={320}>ⓘ</Tip>
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          Covers = the "How many guests?" number entered when a table is opened.
        </p>
      </div>

      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <button key={t.key} className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>From (BS)</label>
          <BsCalendarPicker value={fromIso} onChange={setFromIso} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>To (BS)</label>
          <BsCalendarPicker value={toIso} onChange={setToIso} />
        </div>
        {tab !== 'overview' && (
          <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel} disabled={isEmpty}>⬇ Excel</button>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : isEmpty ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          No paid bills in this range.
        </div>
      ) : tab === 'overview' ? (
        <>
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Sum of the covers entered when each table was opened, across every paid bill in this range" width={250}>Covers Served</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{totals.covers}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{totals.bills} bill{totals.bills !== 1 ? 's' : ''}</div>
            </div>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Covers served ÷ bills — are you mostly seating couples, families, or large groups?" width={250}>Avg Party Size</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{totals.avgParty.toFixed(1)}</div>
            </div>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Net sales ÷ covers served — the standard restaurant 'average check per guest' metric" width={260}>Revenue / Cover</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-accent)' }}>{fmtNpr(totals.revPerCover)}</div>
            </div>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Revenue Per Available Seat-Hour — net sales ÷ (total seats × operating hours in this range). Set your operating hours below to see this." width={300}>RevPASH</Tip>
              </div>
              {revPash !== null ? (
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{fmtNpr(revPash)}</div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Set operating hours below</div>
              )}
            </div>
          </div>

          <div className="card" style={{ padding: '16px 18px', maxWidth: 420 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', marginBottom: 10 }}>
              Operating Hours <Tip text="Used only to compute RevPASH above — a single daily open/close time, not per-weekday" width={260}>ⓘ</Tip>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Open</label>
                <input type="time" className="form-select" value={openTime} onChange={e => setOpenTime(e.target.value)} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Close</label>
                <input type="time" className="form-select" value={closeTime} onChange={e => setCloseTime(e.target.value)} />
              </div>
              <button className="btn btn-primary" disabled={hoursSaving} onClick={saveOperatingHours}>
                {hoursSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            {hoursMsg && (
              <p style={{ margin: '10px 0 0', fontSize: 12, color: hoursMsg.startsWith('error') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
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
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={GOLD} />
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
      ) : tab === 'peak' ? (
        <>
          <ChartCard
            title="Covers by Hour Seated"
            cardStyle={{ marginBottom: 24 }}
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
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} fill={GOLD} />
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
