import { useState, useEffect, useCallback, Fragment } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { firstError } from '../../../shared/queryError'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import RangePresets from './RangePresets'
import RowDisclosure from '../../../components/RowDisclosure'
import { formatAd, BS_MONTHS } from '../../../utils/bsCalendar'
import { CLOSE_TYPE_BADGE, STATION_BADGE } from '../posSignals'
import { nepalTime, nepalTime24, nepalBs, nepalCivilDate } from '../../../shared/nepalTime'
import { nepalDayStartTs, nepalDayEndTs, todayNepalAdIso, bsSlash } from './reportRange'

// The BS day a timestamp fell on IN NEPAL (S754). This was adToBsSafe(new Date(ts)) — the runtime's
// day — beside a nepalTime() clock, so a ticket sent at 00:15 Kathmandu read as the previous BS day
// at 12:15 AM for a viewer abroad. The AD fallback is Nepal's civil day too, never the UTC slice.
function nepalDayLabel(ts, withYear) {
  const bs = nepalBs(ts)
  if (bs) return withYear ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : `${bs.day} ${BS_MONTHS[bs.month - 1]}`
  const civil = nepalCivilDate(ts)
  return civil ? `${formatAd(civil)} (AD)` : '—'
}

// Total ever sent, per (order_id, recipe_id) — summing every log row's printed qty gives the true
// cumulative quantity sent to the kitchen for that item across the order's lifetime. Shared by
// Reconciliation and Bill Trail so both tabs can never disagree about what counts as a discrepancy.
function sumSentQtyByOrderItem(logs) {
  const sentByOrderItem = {}
  for (const log of logs || []) {
    for (const i of (log.items || [])) {
      const key = `${log.order_id}::${i.recipe_id}`
      sentByOrderItem[key] = sentByOrderItem[key] || { orderId: log.order_id, recipeId: i.recipe_id, name: i.name, qty: 0 }
      sentByOrderItem[key].qty += i.qty
    }
  }
  return sentByOrderItem
}

// Actual prep minutes for a pos_kot_log row — null until the ticket has both been started and
// marked Ready in the Kitchen Display (KitchenDisplay.jsx). estimated_prep_minutes (entered by
// staff on Start) is read straight off the row wherever it's needed, no helper required.
// A ticket's kitchen stage (S754). 'served' is new: the floor marks a Ready ticket as delivered so
// its Ready clears. Local rather than posSignals' KOT_STATUS_LABEL, which is the till's live-floor
// vocabulary ('Sent' / 'Started') and does not know served or cancelled. Served and Ready are both
// finished food, so both take the done verdict; the label is what tells them apart.
const KOT_STAGE = {
  new:         { label: 'Sent',      badge: 'badge-gray' },
  in_progress: { label: 'Started',   badge: 'badge-yellow' },
  ready:       { label: 'Ready',     badge: 'badge-green' },
  served:      { label: 'Served',    badge: 'badge-green' },
  cancelled:   { label: 'Cancelled', badge: 'badge-gray' },
}
const kotStage = status => KOT_STAGE[status] || { label: status || '—', badge: 'badge-gray' }

function actualPrepMin(r) {
  return (r.started_at && r.ready_at) ? Math.round((new Date(r.ready_at) - new Date(r.started_at)) / 60000) : null
}

// A comped (close_type='writeoff') order shares status='billed' with a genuinely paid one — only
// close_type tells them apart. Shared by Reconciliation and Bill Trail so a manager scanning either
// tab can tell a real payment from ₨0-collected comp at a glance, instead of both reading "Billed".
function statusBadge(order) {
  if (order.status === 'voided') return { label: 'Voided', className: CLOSE_TYPE_BADGE.void }
  if (order.close_type === 'writeoff') return { label: 'Comp', className: CLOSE_TYPE_BADGE.writeoff }
  return { label: 'Billed', className: CLOSE_TYPE_BADGE.billed }
}

function flagOrderDiscrepancies(orderById, sentByOrderItem, currentByOrderItem) {
  const rows = []
  for (const entry of Object.values(sentByOrderItem)) {
    const order = orderById[entry.orderId]
    if (!order) continue
    const currentQty = currentByOrderItem[`${entry.orderId}::${entry.recipeId}`] || 0
    const discrepancy = entry.qty - currentQty
    const voided = order.status === 'voided'
    if (discrepancy > 0 || voided) {
      rows.push({
        key: `${entry.orderId}::${entry.recipeId}`,
        order, name: entry.name, sentQty: entry.qty, currentQty, discrepancy,
        reason: voided ? 'Order voided — food was sent' : 'Reduced/removed after sending',
      })
    }
  }
  return rows
}

export default function KotLog() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom } = useScopedDb()

  const [tab, setTab] = useState('register') // 'register' | 'reconciliation' | 'trail' | 'pulled'
  const biz = useBizInfo()
  // Nepal's today, not the viewer's (S754) — see reportRange.js.
  const [fromIso, setFromIso] = useState(todayNepalAdIso)
  const [toIso,   setToIso]   = useState(todayNepalAdIso)
  // S612 silent-zero rule: a failed read must render as a failure, never as an empty range —
  // worst here on Reconciliation, whose empty state actively celebrates a quiet report.
  //
  // One slot PER TAB (S754). This was one shared slot on the reasoning that each loader re-runs on
  // activation and clears it — but a loader only re-runs when its tab is active, while a picker
  // change re-runs none of the others. So a Register failure stayed on screen after switching to a
  // tab whose load had succeeded, and the Reconciliation loader's clear could wipe a Register
  // failure still in flight. A shared error slot with concurrent writers is a guard that switches
  // itself off (report-pages.md, S699).
  const [loadErrors, setLoadErrors] = useState({ register: null, reconciliation: null, trail: null, pulled: null })
  const setTabError = useCallback((key, err) => setLoadErrors(prev => (prev[key] === err ? prev : { ...prev, [key]: err })), [])

  /* ── Register ── */
  const [logRows, setLogRows] = useState([])
  const [staffNames, setStaffNames] = useState({})
  const [registerLoading, setRegisterLoading] = useState(true)
  // S754 overlapping-load guards, one per loader so the four tabs never cancel each other. Each is
  // keyed on client + range: two quick picker changes used to let the slower load win the table
  // while the pickers (and the export's filename and scope line) named the other range.
  const registerReq = useLatestRequest()

  const loadRegister = useCallback(async () => {
    if (!clientId) return
    const reqKey = registerReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setRegisterLoading(true)
    setTabError('register', null)
    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)

    const results = await Promise.all([
      // Paged: the Reconciliation and Bill Trail tabs below were already wrapped, and this — the
      // KOT Register, the one tab whose entire purpose is being a COMPLETE log — was not. A busy
      // outlet's month silently showed the most recent 1000 tickets as if that were all of them.
      fetchAllRows(() => scopedFrom('pos_kot_log')
        .gte('sent_at', fromTs).lte('sent_at', toTs)
        .order('sent_at', { ascending: false }).order('id')),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin) —
      // resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
    ])
    if (!registerReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read would render an empty Register as if no tickets went out.
    const failed = firstError(results)
    if (failed) { setTabError('register', failed); setLogRows([]); setRegisterLoading(false); return }
    const [{ data: logs }, { data: profs }] = results
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setLogRows(logs || [])
    setRegisterLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, registerReq, setTabError])

  useEffect(() => { if (tab === 'register') loadRegister() }, [tab, loadRegister])

  /* ── Reconciliation ── */
  const [discrepancies, setDiscrepancies] = useState([])
  const [reconLoading, setReconLoading] = useState(true)
  const reconReq = useLatestRequest()

  const loadReconciliation = useCallback(async () => {
    if (!clientId) return
    const reqKey = reconReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setReconLoading(true)
    setTabError('reconciliation', null)
    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)

    // Paged (S754): every billed and voided order in the range — a busy month crosses 1000, and the
    // orders past the cut would simply never be checked by the anti-fraud comparison below, which
    // then celebrates a clean report. `id` is the unique tiebreaker; display order is set in JS.
    const { data: orders, error: ordersError } = await fetchAllRows(() => scopedFrom('pos_orders', 'id, status, close_type, table_name, order_no, closed_at')
      .in('status', ['billed', 'voided'])
      .gte('closed_at', fromTs).lte('closed_at', toTs)
      .order('id'))
    if (!reconReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read here would render the celebratory "no discrepancies"
    // empty state over an anti-fraud check that never ran.
    if (ordersError) { setTabError('reconciliation', ordersError); setDiscrepancies([]); setReconLoading(false); return }
    const orderList = orders || []
    if (orderList.length === 0) { setDiscrepancies([]); setReconLoading(false); return }
    const orderIds = orderList.map(o => o.id)
    const orderById = Object.fromEntries(orderList.map(o => [o.id, o]))

    // Both paged: one row per ticket send and one per bill line respectively, so a month of
    // service pushes both past PostgREST's silent 1000-row cap. Truncated, the sent-vs-current
    // comparison below would flag phantom discrepancies from missing rows alone (S529).
    // Chunked too (S754): `orderIds` is every order in the range, past a URL's limit well before
    // it is past the row cap.
    const reconResults = await Promise.all([
      fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_kot_log', 'order_id, items').in('order_id', ids).order('id')),
      fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_order_items', 'order_id, recipe_id, name, qty').in('order_id', ids).order('id')),
    ])
    if (!reconReq.isCurrent(reqKey)) return
    // S612: worse than a zero here — a failed pos_order_items read would flag EVERY sent line as
    // a discrepancy, and a failed pos_kot_log read would clear the report entirely.
    const reconFailed = firstError(reconResults)
    if (reconFailed) { setTabError('reconciliation', reconFailed); setDiscrepancies([]); setReconLoading(false); return }
    const [{ data: logs }, { data: currentItems }] = reconResults

    const sentByOrderItem = sumSentQtyByOrderItem(logs)
    // Sum, not assign — a partially-comped line (apply_pos_item_comps splits it into two
    // pos_order_items rows sharing the same order_id+recipe_id: the shrunk paid remainder and a
    // new comped row) would otherwise have one row silently overwrite the other, understating the
    // true current qty and falsely flagging a legitimate comp as a shrinkage discrepancy.
    const currentByOrderItem = {}
    for (const i of (currentItems || [])) {
      const key = `${i.order_id}::${i.recipe_id}`
      currentByOrderItem[key] = (currentByOrderItem[key] || 0) + i.qty
    }
    const rows = flagOrderDiscrepancies(orderById, sentByOrderItem, currentByOrderItem)
    setDiscrepancies(rows.sort((a, b) => new Date(b.order.closed_at) - new Date(a.order.closed_at)))
    setReconLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, reconReq, setTabError])

  useEffect(() => { if (tab === 'reconciliation') loadReconciliation() }, [tab, loadReconciliation])

  /* ── Bill Trail — every paid/voided bill and its complete KOT/BOT send history ── */
  const [billTrailRows, setBillTrailRows] = useState([])
  const [billTrailLoading, setBillTrailLoading] = useState(true)
  const [expandedOrderId, setExpandedOrderId] = useState(null)
  const trailReq = useLatestRequest()

  const loadBillTrail = useCallback(async () => {
    if (!clientId) return
    const reqKey = trailReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setBillTrailLoading(true)
    setTabError('trail', null)
    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)

    // Paged (S754), as in loadReconciliation: past 1000 orders the rest of the range was simply
    // missing from the trail. Display order is the closed_at sort in JS below.
    const { data: orders, error: ordersError } = await fetchAllRows(() => scopedFrom('pos_orders', 'id, order_no, invoice_no, status, close_type, table_name, closed_at, buyer_name')
      .in('status', ['billed', 'voided'])
      .gte('closed_at', fromTs).lte('closed_at', toTs)
      .order('id'))
    if (!trailReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read is not "no paid or voided bills in this range".
    if (ordersError) { setTabError('trail', ordersError); setBillTrailRows([]); setBillTrailLoading(false); return }
    const orderList = orders || []
    if (orderList.length === 0) { setBillTrailRows([]); setBillTrailLoading(false); return }
    const orderIds = orderList.map(o => o.id)
    const orderById = Object.fromEntries(orderList.map(o => [o.id, o]))

    const trailResults = await Promise.all([
      // Paged, same as the summary load above. `id` follows sent_at as the unique tiebreaker —
      // several tickets can share a timestamp, and paging a non-unique sort can repeat a row on
      // one page and skip it on the next.
      // Chunked (S754). Each order's tickets sit in one chunk, so their sent_at order survives
      // the concatenation — and they are only ever read grouped by order below.
      fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_kot_log', 'id, order_id, station, items, sent_at, sent_by')
        .in('order_id', ids).order('sent_at', { ascending: true }).order('id')),
      fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_order_items', 'order_id, recipe_id, name, qty').in('order_id', ids).order('id')),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin) —
      // resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
    ])
    if (!trailReq.isCurrent(reqKey)) return
    // S612: a failed ticket-log read would badge every bill "No KOT" — the alarming direction.
    const trailFailed = firstError(trailResults)
    if (trailFailed) { setTabError('trail', trailFailed); setBillTrailRows([]); setBillTrailLoading(false); return }
    const [{ data: logs }, { data: currentItems }, { data: profs }] = trailResults
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))

    const logsByOrder = {}
    for (const log of logs || []) {
      ;(logsByOrder[log.order_id] = logsByOrder[log.order_id] || []).push(log)
    }
    const sentByOrderItem = sumSentQtyByOrderItem(logs)
    // Sum, not assign — see loadReconciliation's identical comment above.
    const currentByOrderItem = {}
    for (const i of (currentItems || [])) {
      const key = `${i.order_id}::${i.recipe_id}`
      currentByOrderItem[key] = (currentByOrderItem[key] || 0) + i.qty
    }
    const flagsByOrder = {}
    for (const f of flagOrderDiscrepancies(orderById, sentByOrderItem, currentByOrderItem)) {
      ;(flagsByOrder[f.order.id] = flagsByOrder[f.order.id] || []).push(f.reason)
    }

    const rows = orderList
      .map(o => ({ order: o, logs: logsByOrder[o.id] || [], reasons: [...new Set(flagsByOrder[o.id] || [])] }))
      .sort((a, b) => new Date(b.order.closed_at) - new Date(a.order.closed_at))
    setBillTrailRows(rows)
    setBillTrailLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, trailReq, setTabError])

  useEffect(() => { if (tab === 'trail') loadBillTrail() }, [tab, loadBillTrail])

  /* ── Pulled Items ──
     Reconciliation INFERS a pulled line by comparing tickets against the order as it stands now,
     which is why it can say "this was cooked and is no longer on the bill" but never who did it or
     why. pos_kot_removals is the record itself, written inside save_pos_order_items (migration
     20260819130000) at the moment the line is replaced — and, since S755 (20260917100000), by the
     delete triggers when an open order's fired lines are deleted outside it (Clear Occupied), with
     reason "Table cleared" and a row that outlives the order. The two tabs answer different questions
     and are both worth having: this one is attributable, that one still catches a removal made by
     a path that predates the record. */
  const [pulledRows, setPulledRows] = useState([])
  const [pulledLoading, setPulledLoading] = useState(true)
  const pulledReq = useLatestRequest()

  const loadPulled = useCallback(async () => {
    if (!clientId) return
    const reqKey = pulledReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setPulledLoading(true)
    setTabError('pulled', null)
    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)
    const pulledResults = await Promise.all([
      // Paged like every other tab here: one row per pulled line, so a busy month crosses 1000
      // sooner than the ticket log does on a client that edits orders a lot.
      fetchAllRows(() => scopedFrom('pos_kot_removals',
        'id, order_id, order_no, table_name, item_name, qty_removed, reason, removed_by, removed_at, pos_orders(order_no, table_name, invoice_no, close_type)')
        .gte('removed_at', fromTs).lte('removed_at', toTs)
        .order('removed_at', { ascending: false }).order('id')),
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
    ])
    if (!pulledReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read would render the celebratory "nothing pulled" state.
    const pulledFailed = firstError(pulledResults)
    if (pulledFailed) { setTabError('pulled', pulledFailed); setPulledRows([]); setPulledLoading(false); return }
    const [{ data: rows }, { data: profs }] = pulledResults
    setStaffNames(prev => ({ ...prev, ...Object.fromEntries((profs || []).map(p => [p.id, p.full_name])) }))
    setPulledRows(rows || [])
    setPulledLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, pulledReq, setTabError])

  useEffect(() => { if (tab === 'pulled') loadPulled() }, [tab, loadPulled])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const TAB_LABEL = { register: 'Register', reconciliation: 'Reconciliation', trail: 'Bill Trail', pulled: 'Pulled Items' }
  // Every sheet states what it covers (S594/S754): these were bare json_to_sheet exports with no
  // client name, no date range and nothing saying which clock the times are on.
  const scopeLine = `@Date Range : ${fromIso} (B.S. ${bsSlash(fromIso)})  To : ${toIso} (B.S. ${bsSlash(toIso)})  @View : ${TAB_LABEL[tab]}  @Times : Nepal time (UTC+05:45), 24-hour`
  const letterhead = (XLSX, title, rows) => sheetWithLetterhead(XLSX, { title, biz, scopeLine, rows })

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    if (tab === 'register') {
      const ws = letterhead(XLSX, 'KOT Log - Register', logRows.map(r => {
        return {
          'Date (BS)': nepalDayLabel(r.sent_at, true),
          // 24-hour in a sheet cell (S754): "06:50 PM" sorts before "11:30 AM" as text.
          'Time': nepalTime24(r.sent_at),
          'Table': r.table_name || 'Takeaway',
          'Order#': r.order_no,
          'Station': r.station,
          'Stage': kotStage(r.status).label,
          'Items': (r.items || []).map(i => `${i.name} ×${i.qty}`).join(', '),
          'Sent By': staffNames[r.sent_by] || '—',
          'Est. Prep (min)': r.estimated_prep_minutes ?? '',
          'Actual Prep (min)': actualPrepMin(r) ?? '',
        }
      }))
      XLSX.utils.book_append_sheet(wb, ws, 'KOT Register')
      XLSX.writeFile(wb, `kot-register-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'pulled') {
      const ws = letterhead(XLSX, 'KOT Log - Pulled Items', pulledRows.map(r => {
        return {
          'Date (BS)': nepalDayLabel(r.removed_at, true),
          'Time': nepalTime24(r.removed_at),
          // S755: an order deleted with fired food on it (Clear Occupied) keeps its removals, with
          // the order number and table snapshotted onto the row, because the join returns nothing.
          'Order#': r.pos_orders?.order_no ?? r.order_no ?? '',
          'Invoice#': r.pos_orders?.invoice_no || (r.order_id ? '' : 'order deleted'),
          'Table': r.pos_orders?.table_name || r.table_name || 'Takeaway',
          'Item': r.item_name,
          'Qty Pulled': r.qty_removed,
          'Reason': r.reason || '(none given)',
          'Removed By': staffNames[r.removed_by] || '—',
        }
      }))
      XLSX.utils.book_append_sheet(wb, ws, 'Pulled Items')
      XLSX.writeFile(wb, `kot-pulled-items-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'reconciliation') {
      const ws = letterhead(XLSX, 'KOT Log - Reconciliation', discrepancies.map(d => ({
        'Order#': d.order.order_no, 'Table': d.order.table_name || 'Takeaway', 'Status': statusBadge(d.order).label,
        'Item': d.name, 'Sent Qty': d.sentQty, 'Current Qty': d.currentQty, 'Discrepancy': d.discrepancy, 'Reason': d.reason,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'KOT Reconciliation')
      XLSX.writeFile(wb, `kot-reconciliation-${fromIso}-to-${toIso}.xlsx`)
    } else {
      const rows = []
      for (const row of billTrailRows) {
        const o = row.order
        const dateBs = nepalDayLabel(o.closed_at, true)
        const flag = row.reasons.length > 0 ? `Discrepancy: ${row.reasons.join('; ')}` : ''
        const base = { 'Date (BS)': dateBs, 'Order#': o.order_no, 'Invoice#': o.invoice_no || '', 'Table': o.table_name || 'Takeaway', 'Status': statusBadge(o).label }
        if (row.logs.length === 0) {
          rows.push({ ...base, 'Station': '', 'Time': '', 'Items': '', 'Sent By': '', 'Flag': flag || 'No KOT Sent' })
        } else {
          for (const log of row.logs) {
            rows.push({
              ...base, 'Station': log.station,
              'Time': nepalTime24(log.sent_at),
              'Items': (log.items || []).map(i => `${i.name} ×${i.qty}`).join(', '),
              'Sent By': staffNames[log.sent_by] || '—', 'Flag': flag,
            })
          }
        }
      }
      const ws = letterhead(XLSX, 'KOT Log - Bill Trail', rows)
      XLSX.utils.book_append_sheet(wb, ws, 'Bill Trail')
      XLSX.writeFile(wb, `bill-trail-${fromIso}-to-${toIso}.xlsx`)
    }
  }

  const loading = tab === 'register' ? registerLoading : tab === 'reconciliation' ? reconLoading : tab === 'pulled' ? pulledLoading : billTrailLoading
  // The ACTIVE tab's own failure only — another tab's stale error must not paint over this one.
  const loadError = loadErrors[tab] || null
  const isEmpty = tab === 'register' ? logRows.length === 0 : tab === 'reconciliation' ? discrepancies.length === 0 : tab === 'pulled' ? pulledRows.length === 0 : billTrailRows.length === 0

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">
            KOT Log <Tip text="Register is a queryable log of every kitchen/bar ticket ever sent. Reconciliation compares what was sent to the kitchen against what's currently on each order, flagging food that was cooked but then reduced, removed, or the order was voided entirely — the anti-fraud check. Bill Trail shows every paid/voided bill with its complete KOT/BOT history, including bills that never sent anything to the kitchen at all. Pulled Items is the named record: who took an already-cooked line off a bill, when, and why — Reconciliation can only infer that it happened." width={360}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">
            Every ticket sent to the kitchen, whether it matches what was actually billed, and who pulled anything that no longer does.
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Off while the active tab is loading or failed, not only when empty (S728/S754). */}
          {/* …and off while the letterhead's client-name read has failed (useBizInfo, S754). */}
          <button className="btn btn-ghost" onClick={exportExcel} disabled={isEmpty || loading || !!loadError || !!biz.error}>⬇ Excel</button>
        </div>
      </div>

      <Tabs idBase="pos-kot-log" label="KOT Log views" active={tab} onChange={setTab} style={{ marginBottom: 16 }}
        tabs={[
          { key: 'register', label: 'Register' },
          { key: 'reconciliation', label: 'Reconciliation' },
          { key: 'trail', label: 'Bill Trail' },
          { key: 'pulled', label: 'Pulled Items' },
        ]} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <RangePresets fromIso={fromIso} toIso={toIso} onPick={r => { setFromIso(r.from); setToIso(r.to) }} />
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="kot-log-from-bs">From (BS)</label>
          <BsCalendarPicker id="kot-log-from-bs" value={fromIso} onChange={setFromIso} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="kot-log-to-bs">To (BS)</label>
          <BsCalendarPicker id="kot-log-to-bs" value={toIso} onChange={setToIso} />
        </div>
      </div>

      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a sheet
          with a blank company name. The log below is unaffected. Reload the page to try again.
        </p>
      )}
      {/* S612: a failed read renders as a failure — never as the empty state or a zero table. */}
      {loadError ? (
        <ReportLoadError error={loadError} />
      ) : loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : isEmpty ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {tab === 'register' ? 'No KOT/BOT tickets sent in this range.'
            : tab === 'reconciliation' ? 'No discrepancies — a quiet report is a healthy one. 🎉'
            : tab === 'pulled' ? 'Nothing already sent to the kitchen was taken off a bill in this range. 🎉'
            : 'No paid or voided bills in this range.'}
        </div>
      ) : tab === 'register' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Date/Time (BS)</th><th>Table</th><th>Order#</th><th>Station</th><th><Tip text="Where the ticket got to on the Kitchen Display: Sent, Started, Ready, then Served once the floor has taken it to the table. Cancelled tickets were withdrawn." width={280}>Stage</Tip></th><th>Items</th><th>Sent By</th><th style={{ textAlign: 'right' }}><Tip text="Estimated prep time (entered by kitchen/bar staff on Start) vs. actual time from Start to Ready. Red when actual ran over the estimate." width={280}>Prep (Est/Actual)</Tip></th></tr>
            </thead>
            <tbody>
              {logRows.map(r => {
                const actual = actualPrepMin(r)
                const est = r.estimated_prep_minutes
                const overEst = est != null && actual != null && actual > est
                return (
                  <tr key={r.id}>
                    <td>
                      {nepalDayLabel(r.sent_at, false)}
                      <span style={{ color: 'var(--theme-text3)', fontSize: 11, marginLeft: 6 }}>
                        {nepalTime(r.sent_at)}
                      </span>
                    </td>
                    <td>{r.table_name || 'Takeaway'}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>#{r.order_no}</td>
                    {/* KOT/BOT is a CATEGORY split, not a success state — green is reserved for
                        outcomes (statusBadge's 'Billed'), so KOT takes purple, BOT yellow (S613). */}
                    <td><span className={STATION_BADGE[r.station] || 'badge-gray'} style={{ fontSize: 11 }}>{r.station}</span></td>
                    <td><span className={kotStage(r.status).badge} style={{ fontSize: 11 }}>{kotStage(r.status).label}</span></td>
                    <td>{(r.items || []).map(i => `${i.name} ×${i.qty}`).join(', ')}</td>
                    <td>{staffNames[r.sent_by] || '—'}</td>
                    <td style={{ textAlign: 'right', color: overEst ? 'var(--theme-red-text)' : undefined }}>
                      {est == null && actual == null ? '—' : `${est ?? '—'}m / ${actual ?? '—'}m`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : tab === 'pulled' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date/Time (BS)</th><th>Table</th><th>Order#</th><th>Item</th>
                <th style={{ textAlign: 'right' }}>Qty Pulled</th>
                <th><Tip text="Chosen by the person removing the line at the moment they removed it. '(none given)' means the removal came through a path that could not ask — an offline sync, or a device still running a bundle from before this was added." width={320}>Reason</Tip></th>
                <th>Removed By</th>
              </tr>
            </thead>
            <tbody>
              {pulledRows.map(r => {
                const o = r.pos_orders
                return (
                  <tr key={r.id}>
                    <td>
                      {nepalDayLabel(r.removed_at, false)}
                      <span style={{ color: 'var(--theme-text3)', fontSize: 11, marginLeft: 6 }}>
                        {nepalTime(r.removed_at)}
                      </span>
                    </td>
                    <td>{o?.table_name || r.table_name || 'Takeaway'}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      #{o?.order_no ?? r.order_no ?? '—'}
                      {o?.invoice_no && <span style={{ color: 'var(--theme-text3)', fontSize: 11, marginLeft: 6 }}>{o.invoice_no}</span>}
                      {/* S755: the order was deleted unbilled (Clear Occupied); the record outlives it. */}
                      {!r.order_id && (
                        <Tip width={280} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default', marginLeft: 6 }}
                          text="This order was deleted without being billed (Clear Occupied), after this food had already been sent to the kitchen or bar. The removal is kept so the pull stays on record; the order itself no longer exists.">
                          <span className="badge-gray">order deleted</span>
                        </Tip>
                      )}
                    </td>
                    <td>{r.item_name}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{r.qty_removed}</td>
                    <td>
                      {r.reason
                        ? r.reason
                        : <span className="badge-amber" style={{ fontSize: 11 }}>none given</span>}
                    </td>
                    <td>{staffNames[r.removed_by] || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : tab === 'trail' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Order#</th><th>Table</th><th>Status</th><th>KOT Sends</th><th>Discrepancy</th><th></th></tr>
            </thead>
            <tbody>
              {billTrailRows.map(row => {
                const o = row.order
                const flagged = row.reasons.length > 0
                const noKot = row.logs.length === 0
                const expanded = expandedOrderId === o.id
                return (
                  <Fragment key={o.id}>
                    <tr onClick={() => setExpandedOrderId(expanded ? null : o.id)} style={{ cursor: 'pointer' }}>
                      {/* RowDisclosure is the keyboard/SR path to the expansion — the row onClick
                          stays as the mouse convenience, never role="button" on the tr (S613). */}
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        <RowDisclosure
                          expanded={expanded}
                          onToggle={() => setExpandedOrderId(expanded ? null : o.id)}
                          label={`KOT trail for order #${o.order_no}`}
                        /> #{o.order_no}
                      </td>
                      <td>{o.table_name || 'Takeaway'}</td>
                      <td><span className={statusBadge(o).className} style={{ fontSize: 11 }}>{statusBadge(o).label}</span></td>
                      <td>
                        {noKot
                          ? <span className="badge-amber" style={{ fontSize: 11 }}>No KOT</span>
                          : <span className="badge-gray" style={{ fontSize: 11 }}>{row.logs.length} ticket{row.logs.length > 1 ? 's' : ''}</span>}
                      </td>
                      <td>{flagged && <span className="badge-red" style={{ fontSize: 11 }}>Discrepancy</span>}</td>
                      {/* Mouse affordance only — the RowDisclosure carries aria-expanded, so this
                          duplicate hint stays out of the accessibility tree (S613). */}
                      <td aria-hidden="true" style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>{expanded ? '▲ hide' : '▼ trail'}</td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--theme-bg)', padding: '16px 18px' }}>
                          {row.logs.length === 0 ? (
                            <span style={{ fontSize: 12, color: 'var(--theme-text3)', fontStyle: 'italic' }}>No kitchen/bar tickets were ever sent for this bill.</span>
                          ) : (
                            <table className="data-table">
                              <thead><tr><th>Time</th><th>Station</th><th>Items</th><th>Sent By</th></tr></thead>
                              <tbody>
                                {row.logs.map(log => (
                                  <tr key={log.id}>
                                    <td>{nepalTime(log.sent_at)}</td>
                                    {/* Same KOT-purple / BOT-yellow category colours as the Register tab (S613). */}
                                    <td><span className={STATION_BADGE[log.station] || 'badge-gray'} style={{ fontSize: 11 }}>{log.station}</span></td>
                                    <td>{(log.items || []).map(i => `${i.name} ×${i.qty}`).join(', ')}</td>
                                    <td>{staffNames[log.sent_by] || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {flagged && (
                            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--theme-red-text)' }}>
                              ⚠ {row.reasons.join('; ')}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order#</th><th>Table</th><th>Status</th><th>Item</th>
                <th style={{ textAlign: 'right' }}>Sent Qty</th><th style={{ textAlign: 'right' }}>Current Qty</th>
                <th style={{ textAlign: 'right' }}>Discrepancy</th><th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {discrepancies.map(d => (
                <tr key={d.key}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>#{d.order.order_no}</td>
                  <td>{d.order.table_name || 'Takeaway'}</td>
                  <td><span className={statusBadge(d.order).className} style={{ fontSize: 11 }}>{statusBadge(d.order).label}</span></td>
                  <td>{d.name}</td>
                  <td style={{ textAlign: 'right' }}>{d.sentQty}</td>
                  <td style={{ textAlign: 'right' }}>{d.currentQty}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{d.discrepancy}</td>
                  <td>{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
