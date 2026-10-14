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
import { kotStage } from '../kds/ticketStage'
// A CHANGE ticket's line (S809 3a) reads "Chicken Momo — now: No peanuts", never "×0".
import { kotItemText } from '../kitchenNotes'
import { nepalTime, nepalTime24, nepalBs, nepalCivilDate } from '../../../shared/nepalTime'
import { nepalDayStartTs, nepalDayEndTs, todayNepalAdIso, bsSlash } from './reportRange'
// Sent vs held, moves included (S836): the arithmetic Reconciliation and Bill Trail share.
import {
  KOT_MOVE_KINDS, MOVE_KIND_LABEL, sumSentQtyByOrderItem, sumCurrentQtyByOrderItem, mergeMovesById,
  netMovedOutSent, expectedHeldByOrderItem, flagOrderDiscrepancies, sentFoodMovedIn, movedText, moveDishesText,
  moveSideText,
} from './kotMoves'

// The BS day a timestamp fell on IN NEPAL (S754). This was adToBsSafe(new Date(ts)) — the runtime's
// day — beside a nepalTime() clock, so a ticket sent at 00:15 Kathmandu read as the previous BS day
// at 12:15 AM for a viewer abroad. The AD fallback is Nepal's civil day too, never the UTC slice.
function nepalDayLabel(ts, withYear) {
  const bs = nepalBs(ts)
  if (bs) return withYear ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : `${bs.day} ${BS_MONTHS[bs.month - 1]}`
  const civil = nepalCivilDate(ts)
  return civil ? `${formatAd(civil)} (AD)` : '—'
}

// The record of sent food that changed bills, for the range's bills (S836). Two reads, FROM side
// and TO side, because PostgREST cannot OR two `.in()` lists without spelling every id twice in one
// filter; mergeMovesById drops the rows both return. Chunked and paged like the ticket reads beside
// them, and only the three kinds that leave the ticket behind (kotMoves.js). Returned as two promises
// for the caller's own Promise.all, so a failed read fails the tab through its firstError batch
// rather than letting every moved dish read as removed.
function readSentMoves(scopedFrom, orderIds) {
  // The order numbers, names and time are for Bill Trail's expanded row; the arithmetic needs the rest.
  const cols = 'id, kind, from_order_id, to_order_id, from_order_no, to_order_no, from_table_name, to_table_name, lines, moved_at'
  return [
    fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_table_moves', cols).in('kind', KOT_MOVE_KINDS).in('from_order_id', ids).order('id')),
    fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_table_moves', cols).in('kind', KOT_MOVE_KINDS).in('to_order_id', ids).order('id')),
  ]
}

// Actual prep minutes for a pos_kot_log row — null until the ticket has both been started and
// marked Ready in the Kitchen Display (KitchenDisplay.jsx). estimated_prep_minutes (entered by
// staff on Start) is read straight off the row wherever it's needed, no helper required.
// The Stage column's label and badge are kotStage (kds/ticketStage.js): Cleared vs Voided since S833.
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

export default function KotLog() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom } = useScopedDb()

  const [tab, setTab] = useState('register') // 'register' | 'reconciliation' | 'trail' | 'pulled' | 'moves'
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
  const [loadErrors, setLoadErrors] = useState({ register: null, reconciliation: null, trail: null, pulled: null, moves: null })
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
      // S833: the ticket's order status rides along (`pos_orders(status)`, one embed, no second read),
      // so a cancelled ticket reads Cleared or Voided (kds/ticketStage.js).
      fetchAllRows(() => scopedFrom('pos_kot_log', '*, pos_orders(status)')
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
      // S836: sent food moved to another bill keeps its ticket here, so it is moved, not removed.
      ...readSentMoves(scopedFrom, orderIds),
    ])
    if (!reconReq.isCurrent(reqKey)) return
    // S612: worse than a zero here — a failed pos_order_items read would flag EVERY sent line as
    // a discrepancy, and a failed pos_kot_log read would clear the report entirely. A failed moves
    // read would flag every dish moved to another table as removed after sending (S836).
    const reconFailed = firstError(reconResults)
    if (reconFailed) { setTabError('reconciliation', reconFailed); setDiscrepancies([]); setReconLoading(false); return }
    const [{ data: logs }, { data: currentItems }, { data: movesFrom }, { data: movesTo }] = reconResults

    // What each bill should still hold (tickets sent − sent food moved to another bill) against what
    // it holds now. A partly comped line is two rows of one dish, summed (kotMoves.js).
    const held = expectedHeldByOrderItem(sumSentQtyByOrderItem(logs), netMovedOutSent(mergeMovesById(movesFrom, movesTo)))
    const rows = flagOrderDiscrepancies(orderById, held, sumCurrentQtyByOrderItem(currentItems))
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
      // S836, as in loadReconciliation: a dish moved to another table is moved, not removed.
      ...readSentMoves(scopedFrom, orderIds),
    ])
    if (!trailReq.isCurrent(reqKey)) return
    // S612: a failed ticket-log read would badge every bill "No KOT" — the alarming direction. A
    // failed moves read would badge every bill a dish moved off "Discrepancy" (S836).
    const trailFailed = firstError(trailResults)
    if (trailFailed) { setTabError('trail', trailFailed); setBillTrailRows([]); setBillTrailLoading(false); return }
    const [{ data: logs }, { data: currentItems }, { data: profs }, { data: movesFrom }, { data: movesTo }] = trailResults
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))

    const logsByOrder = {}
    for (const log of logs || []) {
      ;(logsByOrder[log.order_id] = logsByOrder[log.order_id] || []).push(log)
    }
    // The same arithmetic as loadReconciliation's, so the two tabs flag the same bills (kotMoves.js).
    const moves = mergeMovesById(movesFrom, movesTo)
    const held = expectedHeldByOrderItem(sumSentQtyByOrderItem(logs), netMovedOutSent(moves))
    const flagsByOrder = {}
    for (const f of flagOrderDiscrepancies(orderById, held, sumCurrentQtyByOrderItem(currentItems))) {
      ;(flagsByOrder[f.order.id] = flagsByOrder[f.order.id] || []).push(f.reason)
    }
    // Each bill's moves of sent food, oldest first, for its expanded trail (S836).
    const movesByOrder = {}
    for (const m of [...moves].sort((a, b) => new Date(a.moved_at) - new Date(b.moved_at))) {
      for (const id of new Set([m.from_order_id, m.to_order_id])) {
        if (id && orderById[id]) (movesByOrder[id] = movesByOrder[id] || []).push(m)
      }
    }

    const rows = orderList
      .map(o => ({
        order: o, logs: logsByOrder[o.id] || [], reasons: [...new Set(flagsByOrder[o.id] || [])],
        moves: movesByOrder[o.id] || [], movedIn: sentFoodMovedIn(moves, o.id),
      }))
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

  /* ── Moves ──
     Every table move, join, release, dish move, part bill and put-back (pos_table_moves, S836), with
     who did it and when. The record is written only by the move functions, so it is the named answer
     to "where did table 3's momo go" that Reconciliation now accounts for silently. */
  const [moveRows, setMoveRows] = useState([])
  const [movesLoading, setMovesLoading] = useState(true)
  const movesReq = useLatestRequest()

  const loadMoves = useCallback(async () => {
    if (!clientId) return
    const reqKey = movesReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setMovesLoading(true)
    setTabError('moves', null)
    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)
    const movesResults = await Promise.all([
      // Paged like every other tab here, oldest first: a move reads as a sequence (split, then put
      // back), and `id` is the unique tiebreaker for moves made in one second.
      fetchAllRows(() => scopedFrom('pos_table_moves',
        'id, kind, from_order_no, to_order_no, from_table_name, to_table_name, lines, covers_moved, moved_by, moved_at')
        .gte('moved_at', fromTs).lte('moved_at', toTs)
        .order('moved_at').order('id')),
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
    ])
    if (!movesReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read is not "nothing was moved in this range".
    const movesFailed = firstError(movesResults)
    if (movesFailed) { setTabError('moves', movesFailed); setMoveRows([]); setMovesLoading(false); return }
    const [{ data: rows }, { data: profs }] = movesResults
    setStaffNames(prev => ({ ...prev, ...Object.fromEntries((profs || []).map(p => [p.id, p.full_name])) }))
    setMoveRows(rows || [])
    setMovesLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, movesReq, setTabError])

  useEffect(() => { if (tab === 'moves') loadMoves() }, [tab, loadMoves])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const TAB_LABEL = { register: 'Register', reconciliation: 'Reconciliation', trail: 'Bill Trail', pulled: 'Pulled Items', moves: 'Moves' }
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
          'Stage': kotStage(r).label,
          'Items': (r.items || []).map(kotItemText).join(', '),
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
        'Item': d.name, 'Sent Qty': d.sentQty,
        // S836: sent food that changed bills, net. Negative is food moved IN from another bill's ticket.
        'Moved Out (net; minus = in)': d.movedOut,
        'Current Qty': d.currentQty, 'Discrepancy': d.discrepancy, 'Reason': d.reason,
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'KOT Reconciliation')
      XLSX.writeFile(wb, `kot-reconciliation-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'moves') {
      const ws = letterhead(XLSX, 'KOT Log - Moves', moveRows.map(r => ({
        'Date (BS)': nepalDayLabel(r.moved_at, true),
        'Time': nepalTime24(r.moved_at),
        'What': MOVE_KIND_LABEL[r.kind] || r.kind,
        'From': moveSideText(r.from_table_name, r.from_order_no),
        'To': moveSideText(r.to_table_name, r.to_order_no),
        'Dishes': moveDishesText(r.lines),
        'Guests': r.covers_moved ?? '',
        'By': staffNames[r.moved_by] || '—',
      })))
      XLSX.utils.book_append_sheet(wb, ws, 'Moves')
      XLSX.writeFile(wb, `kot-moves-${fromIso}-to-${toIso}.xlsx`)
    } else if (tab === 'trail') {
      const rows = []
      for (const row of billTrailRows) {
        const o = row.order
        const dateBs = nepalDayLabel(o.closed_at, true)
        const flag = row.reasons.length > 0 ? `Discrepancy: ${row.reasons.join('; ')}` : ''
        const base = { 'Date (BS)': dateBs, 'Order#': o.order_no, 'Invoice#': o.invoice_no || '', 'Table': o.table_name || 'Takeaway', 'Status': statusBadge(o).label }
        if (row.logs.length === 0) {
          // S836: a part bill's food can reach the kitchen on the table bill's ticket before the split.
          rows.push({ ...base, 'Station': '', 'Time': '', 'Items': '', 'Sent By': '', 'Flag': flag || (row.movedIn ? "No KOT Sent (food sent on another bill's ticket, moved here)" : 'No KOT Sent') })
        } else {
          for (const log of row.logs) {
            rows.push({
              ...base, 'Station': log.station,
              'Time': nepalTime24(log.sent_at),
              'Items': (log.items || []).map(kotItemText).join(', '),
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

  // One entry per tab, no default arm (S836): a fifth tab added to a `? :` chain ending in Bill
  // Trail's flags inherited Bill Trail's loading and emptiness (component-library.md, S737c).
  const TAB_STATE = {
    register:       { loading: registerLoading,  empty: logRows.length === 0 },
    reconciliation: { loading: reconLoading,     empty: discrepancies.length === 0 },
    trail:          { loading: billTrailLoading, empty: billTrailRows.length === 0 },
    pulled:         { loading: pulledLoading,    empty: pulledRows.length === 0 },
    moves:          { loading: movesLoading,     empty: moveRows.length === 0 },
  }
  const loading = TAB_STATE[tab]?.loading ?? true
  // The ACTIVE tab's own failure only — another tab's stale error must not paint over this one.
  const loadError = loadErrors[tab] || null
  const isEmpty = TAB_STATE[tab]?.empty ?? true

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">
            KOT Log <Tip text="Register is a queryable log of every kitchen/bar ticket ever sent. Reconciliation compares what was sent to the kitchen against what's currently on each order, flagging food that was cooked but then reduced, removed, or the order was voided entirely — the anti-fraud check. Bill Trail shows every paid/voided bill with its complete KOT/BOT history, including bills that never sent anything to the kitchen at all. Pulled Items is the named record: who took an already-cooked line off a bill, when, and why — Reconciliation can only infer that it happened. Moves lists every table moved, joined or released and every dish moved or split off to a part bill, with who did it; food the kitchen already had that moved to another bill counts in Reconciliation as moved, not removed." width={360}>ⓘ</Tip>
          </h1>
          <p className="page-subtitle">
            Every ticket sent to the kitchen, whether it matches what was actually billed, who pulled anything that no longer does, and every table moved, joined or split.
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
          { key: 'moves', label: 'Moves' },
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
            : tab === 'moves' ? 'No table was moved, joined or split in this range.'
            : 'No paid or voided bills in this range.'}
        </div>
      ) : tab === 'register' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Date/Time (BS)</th><th>Table</th><th>Order#</th><th>Station</th><th><Tip text="Where the ticket got to on the Kitchen Display: Sent, Started, Ready, then Served once the floor has taken it to the table. Cleared: the kitchen took it off the board because every dish on it was taken off the order. Voided: the bill was voided, which stops its tickets still in the kitchen." width={280}>Stage</Tip></th><th>Items</th><th>Sent By</th><th style={{ textAlign: 'right' }}><Tip text="Estimated prep time (entered by kitchen/bar staff on Start) vs. actual time from Start to Ready. Red when actual ran over the estimate." width={280}>Prep (Est/Actual)</Tip></th></tr>
            </thead>
            <tbody>
              {logRows.map(r => {
                const stage = kotStage(r)
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
                    <td><span className={stage.badge} style={{ fontSize: 11 }}>{stage.label}</span></td>
                    <td>{(r.items || []).map(kotItemText).join(', ')}</td>
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
      ) : tab === 'moves' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th><Tip text="Moved bill: the whole bill went to another table. Joined table: another table joined this bill, bringing its own bill's dishes if it had one. Released table: a joined table came off the bill and is free again. Moved dishes: some dishes went to another table's bill. Part bill: some dishes went onto a bill of their own so one guest could pay separately. Put back: a part bill's dishes went back onto the table's bill." width={360}>What</Tip></th>
                <th>From</th>
                <th><Tip text="The table and bill the move went to, as they were named at the time. A part bill has no table of its own: it carries its table's name and its own bill number." width={300}>To</Tip></th>
                <th><Tip text="The dishes that changed bills. Food the kitchen already had keeps its ticket on the bill it was sent from, so Reconciliation counts it as moved, not removed." width={300}>Dishes</Tip></th>
                <th style={{ textAlign: 'right' }}><Tip text="Guests who went with the move: the whole party for a moved bill, the joining table's party for a join, and for moved dishes or a part bill the guests who went with them (0 when only the food moved, or one guest pays and stays at the table). They come off the bill they left." width={320}>Guests</Tip></th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {moveRows.map(r => (
                <tr key={r.id}>
                  <td>
                    {nepalDayLabel(r.moved_at, false)}
                    <span style={{ color: 'var(--theme-text3)', fontSize: 11, marginLeft: 6 }}>
                      {nepalTime(r.moved_at)}
                    </span>
                  </td>
                  <td>{MOVE_KIND_LABEL[r.kind] || r.kind}</td>
                  <td>{moveSideText(r.from_table_name, r.from_order_no)}</td>
                  <td>{moveSideText(r.to_table_name, r.to_order_no)}</td>
                  <td>{moveDishesText(r.lines)}</td>
                  <td style={{ textAlign: 'right' }}>{r.covers_moved ?? '—'}</td>
                  {/* A name or a dash, never a raw id: the record keeps the login's id only. */}
                  <td>{staffNames[r.moved_by] || '—'}</td>
                </tr>
              ))}
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
                        {/* S836: no ticket of its own, but its food was sent on another bill's and moved
                            here (a part bill split off after sending) — a fact, not the "No KOT" warning. */}
                        {noKot && row.movedIn
                          ? (
                            <Tip width={300} style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}
                              text="No ticket was sent from this bill: its food reached the kitchen on another bill's ticket and was moved here afterwards. Open the trail to see the move.">
                              <span className="badge-gray" style={{ fontSize: 11 }}>Sent on another bill</span>
                            </Tip>
                          )
                          : noKot
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
                            <span style={{ fontSize: 12, color: 'var(--theme-text3)', fontStyle: 'italic' }}>
                              {row.movedIn ? 'No kitchen/bar tickets were sent from this bill; its food was sent on another bill\'s ticket (below).' : 'No kitchen/bar tickets were ever sent for this bill.'}
                            </span>
                          ) : (
                            <table className="data-table">
                              <thead><tr><th>Time</th><th>Station</th><th>Items</th><th>Sent By</th></tr></thead>
                              <tbody>
                                {row.logs.map(log => (
                                  <tr key={log.id}>
                                    <td>{nepalTime(log.sent_at)}</td>
                                    {/* Same KOT-purple / BOT-yellow category colours as the Register tab (S613). */}
                                    <td><span className={STATION_BADGE[log.station] || 'badge-gray'} style={{ fontSize: 11 }}>{log.station}</span></td>
                                    <td>{(log.items || []).map(kotItemText).join(', ')}</td>
                                    <td>{staffNames[log.sent_by] || '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          {/* S836: sent food that changed bills. Its ticket stays above, on the bill it was
                              sent from, so these lines are what make the tickets and the bill agree. */}
                          {row.moves.length > 0 && (
                            <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--theme-text2)' }}>
                              {row.moves.map(m => {
                                const out = m.from_order_id === o.id
                                return (
                                  <li key={m.id}>
                                    {nepalTime(m.moved_at)} · {MOVE_KIND_LABEL[m.kind] || m.kind}: {moveDishesText(m.lines)}{' '}
                                    {out
                                      ? `to ${moveSideText(m.to_table_name, m.to_order_no)}`
                                      : `from ${moveSideText(m.from_table_name, m.from_order_no)}`}
                                  </li>
                                )
                              })}
                            </ul>
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
      ) : tab === 'reconciliation' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Order#</th><th>Table</th><th>Status</th><th>Item</th>
                <th style={{ textAlign: 'right' }}>Sent Qty</th>
                {/* S836: without this column a row whose dish partly moved would not add up. */}
                <th style={{ textAlign: 'right' }}><Tip text="Food the kitchen already had that changed bills afterwards (see Moves). 'Out' went from this bill to another; 'in' came here on another bill's ticket. The bill should still hold Sent − out + in, and Discrepancy is how much less than that it holds." width={320}>Moved</Tip></th>
                <th style={{ textAlign: 'right' }}>Current Qty</th>
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
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{movedText(d.movedOut)}</td>
                  <td style={{ textAlign: 'right' }}>{d.currentQty}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{d.discrepancy}</td>
                  <td>{d.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
