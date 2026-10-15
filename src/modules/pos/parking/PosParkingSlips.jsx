import { useState, useEffect, useCallback, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { settleWithin } from '../../../utils/withTimeout'
import { profileNamesRpc, namesMapOf, useMissingProfileNames } from '../../../shared/profileNames'
import Fab from '../../../components/Fab'
import Tip from '../../../components/Tip'
import { FilterChips } from '../../../components/Tabs'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import RangePresets from '../reports/RangePresets'
import { bsMonthRangeIso } from '../reports/reportRange'
import { openSlipWindow, printParkingSlip } from './parkingSlipHtml'
import NewParkingSlipModal from './NewParkingSlipModal'
import { viewPosBill } from '../../../utils/viewPosBill'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import {
  sweepCutoffIso, staleOpenSlips, slipRangeBounds, patchSlips, noAnswer, printNoticeKind,
  parkingSlipNotice, slipTimeIn, LIST_STALE_TEXT,
} from './parkingSlipList'
import './parking.css'

// Every read and write on this page waits at most this long (S814). A hung request used to leave
// "Loading…" up for ever, and a hung Mark Exited left the vehicle looking parked with no word.
const LIST_READ_MS = 20000
const WRITE_MS = 20000
// Open is the vehicles still parked; All is every slip in a date range. A filter on one list, so
// FilterChips (role="group", aria-pressed, arrow keys), not a tab row.
const SLIP_FILTERS = [{ key: 'open', label: 'Open' }, { key: 'all', label: 'All' }]
// The columns a close answers with: what Mark Exited and the sweep change, as the server stored them.
const CLOSE_COLUMNS = 'id, status, time_out, exited_by, auto_closed'

// S814 (CUSTOMERS-PARKING-15, owner decision D9): the page no longer reads every slip ever issued.
// The Open tab reads the open slips; the All tab reads a From/To range of Time In (this BS month by
// default), only while it is open. What the page itself changes — an issue, a Mark Exited, a print,
// the day's sweep — is applied to both lists from the row the server answered with (patchSlip), and
// kept in `local` so a read that was already in flight cannot put the old state back.
export default function PosParkingSlips() {
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [filter, setFilter]   = useState('open') // 'open' | 'all'
  const [staffNames, setStaffNames] = useState({})
  const [bizInfo, setBizInfo] = useState({ name: '', address: '' })
  const [metaLoaded, setMetaLoaded] = useState(false)
  const [metaError, setMetaError]   = useState(null)   // the first read of names/outlet failed
  const [open, setOpen] = useState({ rows: null, error: null, stale: false })
  const [openBusy, setOpenBusy] = useState(false)
  const [range, setRange] = useState(() => bsMonthRangeIso(0))
  const [all, setAll] = useState({ key: null, range: null, rows: null, error: null, stale: false })
  const [allBusy, setAllBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [sweepFailed, setSweepFailed] = useState(false) // some stale slips could not be auto-closed
  const [actionError, setActionError] = useState(null)  // the last action's notice
  const [busy, setBusy] = useState({})                  // slip id → 'exit' | 'print'

  const metaLoadedRef = useRef(false)
  const openReq = useLatestRequest()
  const openSeq = useRef(0)
  const allReq = useLatestRequest()
  const allSeq = useRef(0)

  // Rows this page wrote, in order. A load applies the ones written after it started, because the
  // database may have answered it from before them.
  const localSeq = useRef(0)
  const local = useRef([])
  const remember = useCallback(rows => {
    for (const row of rows) local.current.push({ seq: ++localSeq.current, row })
    if (local.current.length > 200) local.current.splice(0, local.current.length - 200)
  }, [])
  const changesSince = useCallback(seq => local.current.filter(c => c.seq > seq).map(c => c.row), [])

  const loadMeta = useCallback(async () => {
    if (!clientId) return
    const results = await Promise.all([
      // Raw `profiles` reads are RLS-limited to the caller's own row — resolving OTHER staff
      // members' names needs get_client_profile_names(), a SECURITY DEFINER RPC.
      settleWithin(profileNamesRpc(supabase, clientId), LIST_READ_MS, 'Reading staff names'),
      settleWithin(supabase.from('clients').select('name').eq('id', clientId).single(), LIST_READ_MS, 'Reading the outlet'),
      settleWithin(supabase.from('settings').select('property_address').eq('client_id', clientId).maybeSingle(), LIST_READ_MS, 'Reading the outlet address'),
    ])
    // S754: the names and the outlet header are what a printed token carries, so the first read
    // gates the page. A later one that fails keeps what was loaded.
    const readErr = results.find(r => r.error)?.error
    if (readErr) {
      if (!metaLoadedRef.current) setMetaError(readErr)
      else console.error('Parking slips: staff names / outlet not refreshed:', readErr)
      return
    }
    const [{ data: profs }, { data: client }, { data: settings }] = results
    setStaffNames(namesMapOf(profs))
    setBizInfo({ name: client?.name || '', address: settings?.property_address || '' })
    metaLoadedRef.current = true
    setMetaLoaded(true)
    setMetaError(null)
  }, [clientId])

  // S840: the names read above leaves out Crest support, which the RPC names only for an id asked
  // for, so a slip it issued would print and list with no issuer. Once both lists are in, the issuers
  // the names read did not name are asked for (usually none, and then nothing is sent).
  useMissingProfileNames({
    supabase, clientId, names: staffNames, ready: metaLoaded,
    ids: [...(open.rows || []), ...(all.rows || [])].map(slip => slip.issued_by),
    onFound: found => setStaffNames(prev => ({ ...prev, ...found })),
  })

  const loadOpen = useCallback(async () => {
    if (!clientId) return
    const key = openReq.begin(++openSeq.current)
    const startedAt = localSeq.current
    setOpenBusy(true)
    const { data, error } = await settleWithin(
      fetchAllRows(() => scopedFrom('pos_parking_slips').eq('status', 'open').order('slip_no', { ascending: false }).order('id')),
      LIST_READ_MS, 'Reading the parked vehicles',
    )
    if (!openReq.isCurrent(key)) return
    // S754: a failed read is not an empty car park. Before anything has loaded it is the page's error;
    // after, the last good list stays up and says it may be out of date.
    if (error) {
      setOpenBusy(false)
      setOpen(prev => (prev.rows ? { ...prev, stale: true } : { rows: null, error, stale: false }))
      return
    }
    let rows = patchSlips(data, changesSince(startedAt), { openOnly: true })

    // Sweep-close any slip still open from an earlier parking day, so the Open tab starts fresh each
    // day. No server cron in this project, so this runs the moment the page next loads its Open list.
    // The record is kept and flagged auto_closed, visibly distinct from a confirmed exit. A day ends
    // at 6 AM Nepal (S754/S756, owner decisions), and pos_parking_slips_guard refuses anything newer.
    // S754: only rows the update actually closed are shown closed; `.select()` also catches the
    // zero-row RLS refusal, which returns no error at all. S814: the write names the rule, not the
    // ids, so it no longer carries a URL that grows with the backlog.
    const cutoffIso = sweepCutoffIso()
    const stale = staleOpenSlips(rows, cutoffIso)
    let sweepShort = false
    if (stale.length > 0) {
      const { data: closed, error: sweepErr } = await settleWithin(
        scopedUpdate('pos_parking_slips', { status: 'closed', time_out: new Date().toISOString(), auto_closed: true })
          .eq('status', 'open').lt('time_in', cutoffIso).select(CLOSE_COLUMNS),
        WRITE_MS, 'Closing earlier days’ slips',
      )
      if (sweepErr) console.error('Parking slips: earlier days’ slips not auto-closed:', sweepErr)
      const closedRows = sweepErr ? [] : (closed || [])
      remember(closedRows)
      rows = patchSlips(rows, closedRows, { openOnly: true })
      if (closedRows.length) setAll(prev => (prev.rows ? { ...prev, rows: patchSlips(prev.rows, closedRows, { range: prev.range }) } : prev))
      const closedIds = new Set(closedRows.map(r => r.id))
      sweepShort = stale.some(s => !closedIds.has(s.id))
      if (!openReq.isCurrent(key)) return
    }
    setSweepFailed(sweepShort)
    setOpen({ rows, error: null, stale: false })
    setOpenBusy(false)
  }, [clientId, scopedFrom, scopedUpdate, openReq, remember, changesSince])

  const loadAll = useCallback(async r => {
    if (!clientId || !r?.from || !r?.to) return
    const rangeKey = `${clientId}:${r.from}:${r.to}`
    // Keyed on the range plus a counter, so a refresh of the same range also retires an older load.
    const key = allReq.begin(`${rangeKey}#${++allSeq.current}`)
    const startedAt = localSeq.current
    setAllBusy(true)
    const { startIso, endIso } = slipRangeBounds(r.from, r.to)
    const { data, error } = await settleWithin(
      fetchAllRows(() => scopedFrom('pos_parking_slips').gte('time_in', startIso).lt('time_in', endIso)
        .order('slip_no', { ascending: false }).order('id')),
      LIST_READ_MS, 'Reading the parking slips',
    )
    if (!allReq.isCurrent(key)) return
    setAllBusy(false)
    if (error) {
      setAll(prev => (prev.key === rangeKey && prev.rows
        ? { ...prev, stale: true }
        : { key: rangeKey, range: r, rows: null, error, stale: false }))
      return
    }
    setAll({ key: rangeKey, range: r, rows: patchSlips(data, changesSince(startedAt), { range: r }), error: null, stale: false })
  }, [clientId, scopedFrom, allReq, changesSince])

  const rangeFrom = range.from
  const rangeTo = range.to
  const reloadLists = useCallback(({ withMeta = false } = {}) => {
    if (withMeta || !metaLoadedRef.current) loadMeta()
    loadOpen()
    if (filter === 'all') loadAll({ from: rangeFrom, to: rangeTo })
  }, [filter, rangeFrom, rangeTo, loadMeta, loadOpen, loadAll])

  useEffect(() => { loadMeta(); loadOpen() }, [loadMeta, loadOpen])
  // The All tab reads only while it is open, and again whenever its range moves.
  useEffect(() => {
    if (filter === 'all') loadAll({ from: rangeFrom, to: rangeTo })
  }, [filter, rangeFrom, rangeTo, loadAll])
  // Back on the page after another app or tab: re-read, never on a timer (the PosShifts pattern).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reloadLists() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reloadLists])

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  const markBusy = (id, what) => setBusy(b => ({ ...b, [id]: what }))
  const clearBusy = id => setBusy(b => { const next = { ...b }; delete next[id]; return next })

  // Apply rows the server answered with to both lists, and keep them for any load in flight.
  function applyLocal(rows) {
    remember(rows)
    setOpen(prev => (prev.rows ? { ...prev, rows: patchSlips(prev.rows, rows, { openOnly: true }) } : prev))
    setAll(prev => (prev.rows ? { ...prev, rows: patchSlips(prev.rows, rows, { range: prev.range }) } : prev))
  }

  function showPrintNotice(slip, print, issuing) {
    const kind = printNoticeKind(print, { issuing })
    if (!kind) return
    setActionError({
      text: parkingSlipNotice(kind, { slip, count: print.count }),
      detail: print.countError ? asActionError(print.countError, 'staff').detail : '',
    })
  }

  async function markExited(slip) {
    if (busy[slip.id]) return
    setActionError(null)
    markBusy(slip.id, 'exit')
    const { data, error } = await settleWithin(
      scopedUpdate('pos_parking_slips', { status: 'closed', time_out: new Date().toISOString(), exited_by: profile?.id || null })
        .eq('id', slip.id).select(CLOSE_COLUMNS),
      WRITE_MS, 'Marking the vehicle exited',
    )
    clearBusy(slip.id)
    if (error) {
      const { text, detail } = asActionError(error, 'staff')
      if (noAnswer(error)) {
        // It may have landed. Pressing again is safe: the guard keeps a slip's first close.
        setActionError({ text: parkingSlipNotice('exit-unknown', { slip }), detail })
        reloadLists()
        return
      }
      // S754: a refusal is said, naming which vehicle is still marked parked.
      setActionError({ text: `${slip.vehicle_number} (P-${slip.slip_no}) could not be confirmed as exited — it still shows as parked here. ${text}`, detail })
      return
    }
    const row = data?.[0]
    if (!row) {
      setActionError({ text: `${slip.vehicle_number} (P-${slip.slip_no}) was not marked exited — this account may not change it, or it was removed on another device. The list has been refreshed.` })
      reloadLists()
      return
    }
    applyLocal([row])
    loadOpen()
  }

  async function reprint(slip) {
    if (busy[slip.id]) return
    setActionError(null)
    // On the tap, before any await (owner decision D10) — see openSlipWindow.
    const w = openSlipWindow()
    markBusy(slip.id, 'print')
    const print = await printParkingSlip({
      w, clientId, slip, outletName: bizInfo.name, propertyAddress: bizInfo.address, issuedByName: staffNames[slip.issued_by],
    })
    clearBusy(slip.id)
    // The count is the server's answer, never this page's guess: a print that did not happen, or whose
    // count did not save, leaves the stored count where it is.
    if (print.count != null && !print.countError) applyLocal([{ id: slip.id, print_count: print.count }])
    showPrintNotice(slip, print, false)
  }

  function handleIssued(slip, print) {
    setShowNew(false)
    setActionError(null)
    applyLocal([print.count != null && !print.countError ? { ...slip, print_count: print.count } : slip])
    showPrintNotice(slip, print, true)
  }

  const loadError = metaError || (open.rows === null ? open.error : null)
  const loading = !loadError && (!metaLoaded || open.rows === null)
  const refreshing = openBusy || (filter === 'all' && allBusy)
  const rangeKey = `${clientId}:${rangeFrom}:${rangeTo}`
  const allShown = all.key === rangeKey ? all : null

  const staleNote = (
    <p role="status" className="parking-note parking-note--warn">{LIST_STALE_TEXT}</p>
  )

  const renderTable = rows => (
    <div className="table-wrap table-wrap--fab-clear">
      <table className="data-table">
        <thead>
          <tr>
            <th>Slip No</th>
            <th>Vehicle No</th>
            <th>Type</th>
            <th>Customer</th>
            <th>Time In</th>
            <th><Tip text="If this slip was linked to a bill at issue time (e.g. to honor a 'free parking with purchase' policy) — click to view that bill." width={280}>Bill No</Tip></th>
            <th>Notes</th>
            <th><Tip text="Open means the vehicle is still parked; Closed means staff marked it exited/retrieved; Auto-Closed means it rolled over from a previous day unattended and was closed automatically — the vehicle's actual exit was never confirmed." width={300}>Status</Tip></th>
            <th>Issued By</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => (
            <tr key={s.id}>
              <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>P-{s.slip_no}</td>
              <td style={{ fontWeight: 600 }}>{s.vehicle_number}</td>
              <td>{s.vehicle_type || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
              <td>{s.customer_name || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
              <td style={{ whiteSpace: 'nowrap' }}>{slipTimeIn(s.time_in)}</td>
              <td>
                {/* S842: the shared link-like class, not an unclassed button: a coarse pointer's 44px
                    `button:not([class])` floor made every linked row tall, it had no focus pair, and
                    print hides every button (--prints brings the number back on paper). */}
                {s.bill_invoice_no ? (
                  <button type="button" className="btn-linklike btn-linklike--prints" style={{ whiteSpace: 'nowrap' }}
                    onClick={() => viewPosBill(clientId, { id: s.order_id })}>
                    #{s.bill_invoice_no}
                  </button>
                ) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
              </td>
              <td style={{ maxWidth: 160, whiteSpace: 'normal', color: 'var(--theme-text2)', fontSize: 12 }}>
                {s.notes || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
              </td>
              <td>
                {s.status === 'open' ? (
                  <span className="badge badge-amber">Open</span>
                ) : s.auto_closed ? (
                  <Tip text="Automatically closed when the page was next opened after this slip's day ended — staff never confirmed the vehicle actually exited." width={280}>
                    <span className="badge badge-gray">Auto-Closed</span>
                  </Tip>
                ) : (
                  <span className="badge badge-green">Closed</span>
                )}
              </td>
              <td>{staffNames[s.issued_by] || '—'}</td>
              {/* S842: a flex <td> stops being a table cell (its borders and height leave the row);
                  the buttons sit in an inline-flex span instead (parking.css). */}
              <td style={{ textAlign: 'right' }}>
                <span className="parking-row-actions">
                  {s.status === 'open' && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => markExited(s)} disabled={!!busy[s.id]}
                      aria-busy={busy[s.id] === 'exit' ? 'true' : undefined}>
                      {busy[s.id] === 'exit' ? 'Marking…' : 'Mark Exited'}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => reprint(s)} disabled={!!busy[s.id]}
                    aria-busy={busy[s.id] === 'print' ? 'true' : undefined}>
                    {busy[s.id] === 'print' ? 'Printing…' : 'Reprint'}
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  let body
  if (loading) {
    body = <p className="parking-note">Loading…</p>
  } else if (loadError) {
    body = <ReportLoadError error={loadError} />
  } else if (filter === 'open') {
    body = (
      <>
        {sweepFailed && (
          <p role="status" className="parking-note parking-note--warn">
            Some slips from an earlier day could not be closed automatically, so they still show as parked. Mark them Exited, or press Refresh to try again.
          </p>
        )}
        {open.stale && staleNote}
        {open.rows.length === 0
          ? <div className="card empty-state">No vehicles currently parked.</div>
          : renderTable(open.rows)}
      </>
    )
  } else {
    body = (
      <>
        <div className="parking-range">
          <RangePresets fromIso={rangeFrom} toIso={rangeTo} onPick={r => setRange({ from: r.from, to: r.to })} />
          <div>
            <label className="parking-range-label" htmlFor="parking-from-bs">From (BS)</label>
            <BsCalendarPicker id="parking-from-bs" value={rangeFrom} onChange={v => setRange(r => ({ ...r, from: v }))} />
          </div>
          <div>
            <label className="parking-range-label" htmlFor="parking-to-bs">To (BS)</label>
            <BsCalendarPicker id="parking-to-bs" value={rangeTo} onChange={v => setRange(r => ({ ...r, to: v }))} />
          </div>
        </div>
        {!allShown ? (
          <p className="parking-note">Loading…</p>
        ) : allShown.rows === null ? (
          <ReportLoadError error={allShown.error} />
        ) : (
          <>
            {allShown.stale && staleNote}
            {allShown.rows.length === 0
              ? <div className="card empty-state">No parking slips were issued in these dates.</div>
              : renderTable(allShown.rows)}
          </>
        )}
      </>
    )
  }

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Parking Slips</h1>
          <p className="page-subtitle">
            Issue a parking token for a customer's vehicle — no order required. Printing a new slip needs Supervisor access.
          </p>
        </div>
        <div className="parking-actions">
          <button type="button" className="btn btn-ghost" onClick={() => reloadLists({ withMeta: true })} disabled={refreshing}
            aria-busy={refreshing ? 'true' : undefined}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {/* Not gated on the dialog's own open state: the Fab is the trigger the dialog hands focus back to. */}
          <Fab onClick={() => setShowNew(true)} label="+ New Parking Slip" show={hasPosAccess('supervisor') && !loading && !loadError} />
        </div>
      </div>

      <FilterChips label="Which slips" options={SLIP_FILTERS} active={filter} onChange={setFilter} style={{ marginBottom: 20 }} />

      <ActionError error={actionError} className="action-error--top" />
      {body}

      {showNew && (
        <NewParkingSlipModal
          outletName={bizInfo.name}
          propertyAddress={bizInfo.address}
          onClose={() => setShowNew(false)}
          onIssued={handleIssued}
          onUnknown={() => reloadLists()}
        />
      )}
    </div>
  )
}
