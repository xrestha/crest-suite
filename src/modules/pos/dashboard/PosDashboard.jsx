import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { RefreshCw } from 'lucide-react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { withTimeout } from '../../../utils/withTimeout'
import { npr, nprOrDash } from '../../../shared/nepalMoney'
import { nepalTime } from '../../../shared/nepalTime'
import { chartMotion } from '../../../shared/chartMotion'
import { TOOLTIP_CHROME } from '../../../shared/tooltipChrome'
import { CHART_COLORS } from '../../../shared/chartColors'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalDayStartTs, todayNepalAdIso, todayNepalBs } from '../reports/reportRange'
import { KDS_LATE_MS } from '../posSignals'
import { KOT_CHANGE_ITEMS } from '../kitchenNotes'
import ChartCard from '../../../components/ChartCard'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'
import SalesPivot from '../../dashboard/SalesPivot'
import {
  summariseBills, compareToLastWeek, hourlySales, paymentMix, channelMix, topItems,
  openBillsSummary, ticketSummary, sameWeekdayLastWeek,
} from './posDashboardMath'

// The POS Dashboard (S800 stage B) — the page the POS tab opens.
//
// Two bands, in the order every POS home the S800 research examined uses (Lightspeed, Toast):
// what needs a person RIGHT NOW (the floor band, any POS rank), then how today is going against the
// same weekday last week up to this same clock time (the sales band, supervisor and above — the
// rank that may already Pay, Void and see the money; the reports it links to are manager-only).
// Every tile links to the page that acts on it or the report that explains it. Its arithmetic is
// posDashboardMath.js, pinned by a test.
//
// It refreshes itself every minute while the tab is visible, because a floor band that is ten
// minutes stale is a floor band nobody trusts.

const REFRESH_MS = 60 * 1000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const TODAY_HEX = CHART_COLORS[0]
const LAST_WEEK_HEX = CHART_COLORS[2]
const MUTED = '#6b7280' // chart-tick, for Recharts SVG props only; the page's text takes the tokens
const hourLabel = h => h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
const ORDER_SELECT = 'id, covers, paid_amount, discount_amount, payment_method, table_id, delivery_partner, credit_note_id, close_type, closed_at'

function weekdayOf(adIso) {
  const [y, m, d] = adIso.split('-').map(Number)
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

// Shape is the fact, colour is the verdict (design-system.md): the arrow says which way the figure
// moved, the colour whether that is good for THIS figure. Within the dead zone it is ≈ in grey.
function CompareLine({ cmp, then, money = false }) {
  if (!cmp) return <div className="stat-sub">Nothing last week by this time to compare</div>
  const color = cmp.good == null ? 'var(--theme-text3)' : cmp.good ? 'var(--theme-green-text)' : 'var(--theme-red-text)'
  const pct = cmp.gapPct < 1 ? cmp.gapPct.toFixed(1) : Math.round(cmp.gapPct)
  return (
    <div className="stat-sub">
      <span style={{ color, fontWeight: 600 }}>{cmp.glyph} {pct}%</span>
      {' '}· last week {money ? npr(then) : Math.round(then).toLocaleString('en-IN')}
    </div>
  )
}

function Tile({ label, tip, value, sub, to, tone }) {
  const valueColor = tone === 'bad' ? 'var(--theme-red-text)' : tone === 'warn' ? 'var(--theme-amber-text)' : 'var(--theme-text1)'
  const body = (
    <>
      <div className="stat-label">{tip ? <Tip text={tip} width={260}>{label}</Tip> : label}</div>
      <div className="stat-value" style={{ color: valueColor }}>{value}</div>
      {sub}
    </>
  )
  return (
    <div className="stat-card stat-card--compact">
      {body}
      {to && <Link to={to} className="dash-tile-link" aria-label={`Open ${label}`}>Open →</Link>}
    </div>
  )
}

function ShareRows({ rows, labelOf, valueOf, emptyText }) {
  if (!rows.length) return <p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>{emptyText}</p>
  const max = Math.max(...rows.map(valueOf), 1)
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rows.map(r => (
        <div key={labelOf(r)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
            <span style={{ color: 'var(--theme-text1)' }}>{labelOf(r)}</span>
            <span style={{ color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{npr(valueOf(r))}</span>
          </div>
          {/* A length, not a colour, carries the share: a neutral fill from the text token. */}
          <div aria-hidden="true" style={{ height: 6, marginTop: 4, background: 'color-mix(in srgb, var(--theme-text2) 12%, transparent)' }}>
            <div style={{ height: '100%', width: `${(valueOf(r) / max) * 100}%`, background: 'color-mix(in srgb, var(--theme-text2) 55%, transparent)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

export default function PosDashboard() {
  const { hasPosAccess, profile, isAdmin, adminViewClientName, clientId } = useAuth()
  const { scopedFrom } = useScopedDb()
  const latest = useLatestRequest()
  const canMoney = hasPosAccess('supervisor')
  const canReports = hasPosAccess('manager')

  const [floor, setFloor] = useState(null)
  const [sales, setSales] = useState(null)
  const [period, setPeriod] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState(null)

  const load = useCallback(async () => {
    if (!clientId) return
    const id = latest.begin(Symbol('pos-dashboard'))
    setLoading(true)
    const nowMs = Date.now()
    const today = todayNepalAdIso()
    const lastWeek = sameWeekdayLastWeek(today)
    const todayStart = nepalDayStartTs(today)
    try {
      const floorReads = Promise.all([
        // Open bills are a handful at most, so no paging; the items ride along for the value.
        scopedFrom('pos_orders', 'id, table_id, opened_at, pos_order_items(qty, unit_price, comped)').eq('status', 'open'),
        scopedFrom('pos_tables', 'status').neq('status', 'inactive'),
        scopedFrom('pos_guest_order_requests', 'id, created_at').eq('status', 'pending'),
        // A CHANGE ticket (S809 3a) is an instruction for the kitchen to read, not food being made.
        scopedFrom('pos_kot_log', 'status, sent_at').in('status', ['new', 'in_progress']).gte('sent_at', todayStart).not('items', 'cs', KOT_CHANGE_ITEMS),
        canMoney ? scopedFrom('pos_shifts', 'opened_at').eq('status', 'open').maybeSingle() : Promise.resolve({ data: null, error: null }),
        scopedFrom('monthly_periods', 'id, bs_year, bs_month').eq('status', 'open').maybeSingle(),
      ])
      // The two days are cut at the same clock time: today up to now, last week up to now − 7 days.
      const salesReads = canMoney ? Promise.all([
        fetchAllRows(() => scopedFrom('pos_orders', ORDER_SELECT).in('close_type', ['paid', 'void', 'writeoff'])
          .gte('closed_at', todayStart).lte('closed_at', new Date(nowMs).toISOString()).order('id')),
        fetchAllRows(() => scopedFrom('pos_orders', ORDER_SELECT).in('close_type', ['paid', 'void', 'writeoff'])
          .gte('closed_at', nepalDayStartTs(lastWeek)).lte('closed_at', new Date(nowMs - 7 * 86400000).toISOString()).order('id')),
      ]) : Promise.resolve(null)
      const [floorRes, salesRes] = await withTimeout(Promise.all([floorReads, salesReads]), 25000, 'POS Dashboard')
      const err = firstError(floorRes) || (salesRes && firstError(salesRes))
      if (err) throw err

      let todayOrders = [], lastWeekOrders = [], legs = new Map(), items = []
      if (salesRes) {
        todayOrders = salesRes[0].data || []
        lastWeekOrders = salesRes[1].data || []
        const paidIds = todayOrders.filter(o => o.close_type === 'paid').map(o => o.id)
        const splitIds = todayOrders.filter(o => o.payment_method === 'Split').map(o => o.id)
        const [legRes, itemRes] = await withTimeout(Promise.all([
          fetchAllRowsChunked(splitIds, ids => scopedFrom('pos_order_payments', 'id, order_id, payment_method, amount').in('order_id', ids).order('id')),
          fetchAllRowsChunked(paidIds, ids => scopedFrom('pos_order_items', 'id, order_id, recipe_id, name, qty, comped').in('order_id', ids).order('id')),
        ]), 25000, 'POS Dashboard')
        const err2 = legRes.error || itemRes.error
        if (err2) throw err2
        for (const l of legRes.data || []) legs.set(l.order_id, [...(legs.get(l.order_id) || []), l])
        items = itemRes.data || []
      }
      if (!latest.isCurrent(id)) return

      const [openRes, tablesRes, guestRes, kotRes, shiftRes, periodRes] = floorRes
      const guest = guestRes.data || []
      const oldestGuest = guest.reduce((m, g) => Math.min(m, Date.parse(g.created_at)), Infinity)
      setFloor({
        open: openBillsSummary(openRes.data, nowMs),
        tablesOccupied: (tablesRes.data || []).filter(t => t.status === 'occupied').length,
        tablesTotal: (tablesRes.data || []).length,
        guestWaiting: guest.length,
        guestOldestMins: Number.isFinite(oldestGuest) ? Math.floor((nowMs - oldestGuest) / 60000) : null,
        tickets: ticketSummary(kotRes.data, KDS_LATE_MS, nowMs),
        shift: canMoney ? (shiftRes.data || null) : undefined,
      })
      setPeriod(periodRes.data || null)
      setSales(salesRes ? {
        today: summariseBills(todayOrders),
        lastWeek: summariseBills(lastWeekOrders),
        hourly: hourlySales(todayOrders, lastWeekOrders, { currentHour: new Date(nowMs + 345 * 60000).getUTCHours() }),
        payments: paymentMix(todayOrders, legs),
        channels: channelMix(todayOrders),
        top: topItems(items),
      } : null)
      setError(null)
      setUpdatedAt(nowMs)
    } catch (e) {
      // A failed refresh keeps the last good figures on screen and says so; it never blanks them.
      if (!latest.isCurrent(id)) return
      setError(e)
    } finally {
      if (latest.isCurrent(id)) setLoading(false)
    }
  }, [clientId, canMoney, scopedFrom, latest])

  useEffect(() => {
    load()
    const t = setInterval(() => { if (document.visibilityState === 'visible') load() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  // After every hook. ModuleGate has already sent a kitchen or bar station team to its KDS.
  if (!hasPosAccess('staff')) return <Navigate to="/dashboard" replace />

  const today = todayNepalAdIso()
  const bsToday = todayNepalBs()
  const weekday = weekdayOf(today)
  const clientName = isAdmin ? adminViewClientName : profile?.clients?.name
  const t = sales?.today, lw = sales?.lastWeek
  const ready = !!floor && (!canMoney || !!sales)

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">POS Dashboard</h1>
          <p className="page-subtitle">
            {clientName ? `${clientName} · ` : ''}{weekday}, {bsToday ? `${bsToday.day} ${BS_MONTHS[bsToday.month - 1]} ${bsToday.year}` : today}
            {updatedAt && <> · updated {nepalTime(updatedAt)}</>}
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load} aria-busy={loading || undefined}>
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </button>
      </div>

      {error && (
        ready
          ? <div role="alert" className="note-banner dash-row">
              <strong>Could not refresh.</strong> The figures below are from {nepalTime(updatedAt)}; it will try again within a minute.
            </div>
          : <ReportLoadError error={error} />
      )}

      {!ready && !error && (
        <div className="stat-grid stat-grid--compact dash-section" aria-busy="true">
          {[0, 1, 2, 3].map(i => <div key={i} className="stat-card stat-card--compact"><span className="skeleton" style={{ display: 'inline-block', width: '60%', height: '2.2em' }} /></div>)}
        </div>
      )}

      {ready && (
        <>
          {/* ── The floor, right now ── */}
          <h2 className="dash-heading">On the floor now</h2>
          <div className="stat-grid stat-grid--compact dash-section">
            <Tile
              label="Open bills"
              tip="Bills still running — food ordered, not yet paid. The oldest one's age is how long a table has been sitting with an open bill."
              value={floor.open.count}
              sub={<div className="stat-sub">
                {floor.open.count === 0 ? 'None open' : `Oldest ${floor.open.oldestMins} min`}
                {canMoney && floor.open.count > 0 && <> · {npr(floor.open.value)} on them before VAT</>}
              </div>}
              to={canMoney ? '/pos/billing' : '/pos/orders'}
            />
            <Tile label="Tables in use" value={`${floor.tablesOccupied} / ${floor.tablesTotal}`}
              sub={<div className="stat-sub">{floor.tablesTotal - floor.tablesOccupied} free</div>} to="/pos/orders" />
            <Tile
              label="QR orders waiting"
              tip="Orders guests placed from the table QR menu that nobody has accepted yet. Until someone accepts, the kitchen has not seen them."
              value={floor.guestWaiting}
              tone={floor.guestWaiting > 0 ? 'warn' : null}
              sub={<div className="stat-sub">{floor.guestWaiting > 0 ? `Oldest waiting ${floor.guestOldestMins} min` : 'Nothing waiting'}</div>}
              to="/pos/orders"
            />
            <Tile
              label="Kitchen tickets"
              tip={`Tickets sent to the kitchen or bar today that are not ready yet. Late means more than ${KDS_LATE_MS / 60000} minutes since it was sent — the same line the Kitchen Display uses.`}
              value={floor.tickets.working}
              tone={floor.tickets.late > 0 ? 'bad' : null}
              sub={<div className="stat-sub">{floor.tickets.late > 0 ? `▲ ${floor.tickets.late} late` : 'None late'}</div>}
              to="/pos/kds"
            />
            {canMoney && (
              <Tile
                label="Cash drawer shift"
                tip="Whether a cashier shift is open. Bills closed with no shift open are not counted in any drawer's cash-up."
                value={floor.shift ? 'Open' : 'Not open'}
                tone={!floor.shift && floor.open.count > 0 ? 'warn' : null}
                sub={<div className="stat-sub">{floor.shift ? `Since ${nepalTime(floor.shift.opened_at)}` : floor.open.count > 0 ? 'Bills are running with no shift open' : 'No shift open'}</div>}
                to="/pos/shifts"
              />
            )}
          </div>

          {/* ── Today against last week, to this time ── */}
          {canMoney && sales && (
            <>
              <h2 className="dash-heading">
                <Tip text={`Today so far, against last ${weekday} up to the same time of day — so a lunchtime figure is compared with last week's lunchtime, not with last week's whole day. Sales are what the bills charged, VAT included, as on Home's POS card; a bill later credit-noted is left out.`} width={300}>
                  Today so far vs last {weekday}
                </Tip>
              </h2>
              <div className="stat-grid stat-grid--compact dash-section">
                <Tile label="Sales" value={npr(t.sales)} sub={<CompareLine cmp={compareToLastWeek(t.sales, lw.sales, { floor: 100 })} then={lw.sales} money />}
                  to={canReports ? '/pos/sales-report' : null} />
                <Tile label="Bills" value={t.bills} sub={<CompareLine cmp={compareToLastWeek(t.bills, lw.bills, { floor: 1 })} then={lw.bills} />} />
                <Tile label="Covers" tip="Guests seated at tables on today's paid bills, as entered when the table was opened: the Covers Report's count. Takeaway and delivery bills seat no guests, so they are not counted here; a bill later credit-noted still counts its guests."
                  value={t.covers} sub={<CompareLine cmp={compareToLastWeek(t.covers, lw.covers, { floor: 1 })} then={lw.covers} />}
                  to={canReports ? '/pos/covers-report' : null} />
                <Tile label="Avg per cover" tip="What today's dine-in bills charged, VAT included, divided by the guests seated at them. A bill later credit-noted gives its money back but keeps its guests, as on the Covers Report. Takeaway and delivery sales are left out: they have no guests to divide by."
                  value={nprOrDash(t.avgCover)}
                  sub={<CompareLine cmp={compareToLastWeek(t.avgCover, lw.avgCover, { floor: 20 })} then={lw.avgCover} money />} />
                <Tile label="Discounts" tip="Bill discounts given today. Here less is the better direction, so a rise shows red."
                  value={npr(t.discount)} sub={<CompareLine cmp={compareToLastWeek(t.discount, lw.discount, { goodDirection: -1, floor: 100 })} then={lw.discount} money />}
                  to={canReports ? '/pos/exceptions' : null} />
                <Tile label="Voids · complimentary" tip="Bills voided, and bills closed as complimentary (no charge), today. Each one is listed on the Exceptions report."
                  value={`${t.voids} · ${t.comps}`} tone={t.voids + t.comps > 0 ? 'warn' : null}
                  sub={<div className="stat-sub">last week {lw.voids} · {lw.comps}</div>}
                  to={canReports ? '/pos/exceptions' : null} />
              </div>

              <div className="dash-section">
                <ChartCard
                  title={`Sales by hour — today vs last ${weekday}`}
                  legend={<span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>
                    <span style={{ color: TODAY_HEX }}>■</span> Today · <span style={{ color: LAST_WEEK_HEX }}>━</span> Last {weekday}
                  </span>}
                  renderChart={h => sales.hourly.length === 0
                    ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>No bills closed yet today or by this time last {weekday}.</p>
                    : (
                      <ResponsiveContainer width="100%" height={h}>
                        <ComposedChart data={sales.hourly} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={MUTED} strokeOpacity={0.2} vertical={false} />
                          <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fill: MUTED, fontSize: 11 }} />
                          <YAxis tick={{ fill: MUTED, fontSize: 11 }} width={56} tickFormatter={v => v >= 1000 ? `${Math.round(v / 1000)}k` : v} />
                          <Tooltip
                            contentStyle={{ ...TOOLTIP_CHROME, fontSize: 12, color: 'var(--theme-text1)' }}
                            labelStyle={{ color: 'var(--theme-text1)' }} itemStyle={{ color: 'var(--theme-text1)' }}
                            labelFormatter={hourLabel}
                            formatter={(v, name) => [npr(v), name]}
                          />
                          <Bar dataKey="today" name="Today" fill={TODAY_HEX} {...chartMotion()} />
                          <Line dataKey="lastWeek" name={`Last ${weekday}`} stroke={LAST_WEEK_HEX} strokeWidth={2} dot={false} type="monotone" {...chartMotion()} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    )}
                />
              </div>

              <div className="dash-section dash-card-grid">
                <div className="card card--compact">
                  <h3 className="dash-card-title">
                    <Tip text="How today's bills were paid. eSewa, Khalti and FonePay are one line; a split bill is shared across its payments. Credit is billed but not yet paid." width={280}>Payments today</Tip>
                  </h3>
                  <ShareRows rows={sales.payments} labelOf={r => r.method} valueOf={r => r.amount} emptyText="No bills paid yet today." />
                </div>
                <div className="card card--compact">
                  <h3 className="dash-card-title">
                    <Tip text="Dine-in is a bill opened at a table, takeaway one with no table, delivery one billed to a delivery partner." width={260}>Where today's sales came from</Tip>
                  </h3>
                  <ShareRows rows={sales.channels} labelOf={r => `${r.channel} · ${r.bills} bill${r.bills === 1 ? '' : 's'}`} valueOf={r => r.amount} emptyText="No bills paid yet today." />
                </div>
                <div className="card card--compact">
                  <h3 className="dash-card-title">
                    <Tip text="The dishes sold most today, by quantity. Complimentary items are not counted." width={240}>Top 5 today</Tip>
                  </h3>
                  {sales.top.length === 0
                    ? <p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Nothing sold yet today.</p>
                    : (
                      <ol style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 13 }}>
                        {sales.top.map(r => (
                          <li key={r.key} style={{ color: 'var(--theme-text1)' }}>
                            <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <span>{r.name}</span>
                              <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{Math.round(r.qty * 100) / 100}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                </div>
              </div>
            </>
          )}

          {/* The month's POS sales by category — moved here from Home with the rest of POS (S800). */}
          <div className="dash-section">
            <SalesPivot activePeriod={period} posEnabled={true} title="POS Sales by Category" />
          </div>
        </>
      )}
    </div>
  )
}
