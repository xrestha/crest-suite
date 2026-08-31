import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { BS_MONTHS, bsDayOrdinal } from '../../../utils/bsCalendar'
import { errorText } from '../../../shared/errorText'
import Tip from '../../../components/Tip'
import { HR_REQUEST_STATUS } from '../payrollConstants'

// The Shift Swaps tab: the queue of swaps waiting on a manager's sign-off, and the permanent
// record of every one already decided.
//
// It used to be two collapsible drop-downs stacked above the Roster Board. That put a log of
// Shrawan and Ashadh decisions on top of a Bhadra schedule (reported live) — history is not
// scoped to the week the board happens to be showing, and never was, so it had no business
// sharing the board's period controls. It is a tab of its own now, and the pending count rides
// on the tab button so moving it off the board doesn't bury an action queue.
//
// Approving trades the employee_id on the two underlying hr_roster rows — each day keeps its own
// shift, only who's scheduled on it changes (per Help.js's own description of this feature).
// Found live (2026-07-28): the original two-step version (target's row -> requester's id, then
// requester's row -> target's id) assumed the two swapped days are always different, which breaks
// the moment they're the SAME calendar day (e.g. trading Morning<->Afternoon on one date — a
// normal request, not an edge case): for one instant two rows would share the same
// (client_id,employee_id,bs_year,bs_month,bs_day) key, which the unique constraint rejects no
// matter which row is updated first. Routed around it with a 3-step dance through an impossible
// sentinel bs_day (hr_roster.bs_day has no range CHECK, unlike every other bs_day column in this
// schema, so -1 can never collide with a real row): park the requester's row on the sentinel day,
// move the target's row onto the requester's old identity, then bring the requester's row back
// onto the target's old identity. Each step only ever collides with itself.
const HISTORY_STATUSES = ['approved', 'rejected_by_target', 'rejected_by_admin', 'cancelled']
// Same ladder as every other HR queue and as the employee's own view of this swap — the labels
// below, not a second hue, are what separate "declined by coworker" from "rejected".
const STATUS_BADGE = {
  approved: HR_REQUEST_STATUS.approved.badge,
  rejected_by_target: HR_REQUEST_STATUS.rejected.badge, rejected_by_admin: HR_REQUEST_STATUS.rejected.badge,
  cancelled: HR_REQUEST_STATUS.cancelled.badge,
}
const STATUS_LABEL = {
  approved: 'Approved', rejected_by_target: 'Declined by coworker', rejected_by_admin: 'Rejected', cancelled: 'Cancelled',
}

export default function SwapRequestsPanel({ employees, shiftMap, onPendingCount }) {
  const { profile, clientId } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [requests, setRequests] = useState([])
  const [busyId, setBusyId] = useState(null)
  const [msg, setMsg] = useState('')

  // Every swap request already lands a permanent row in hr_shift_swap_requests — this just
  // surfaces the resolved ones (the pending queue only ever shows status='pending_admin', so once
  // a request is decided it silently vanished with no way to look back at who swapped with whom,
  // or who approved/rejected it). No new table, no new RPC.
  const [history, setHistory] = useState([])
  const [adminNames, setAdminNames] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState(null)

  // Roster.jsx loads only active/probation staff for the board, but a swap outlives the people in
  // it: a resigned employee rendered as a bare "—" beside a named coworker (seen live), which is
  // exactly the row someone opens this tab to settle. Fill in whoever the board didn't load.
  // attemptedRef keeps an id that resolves to nothing (a deleted employee) from re-querying
  // forever — the fetch only ever runs once per unknown id.
  const [extraNames, setExtraNames] = useState({})
  const attemptedRef = useRef(new Set())

  const nameById = useMemo(
    () => ({ ...extraNames, ...Object.fromEntries(employees.map(e => [e.id, e.full_name])) }),
    [employees, extraNames])

  const load = useCallback(async () => {
    const [{ data: pending, error: e1 }, { data: hist, error: e2 }] = await Promise.all([
      scopedFrom('hr_shift_swap_requests').eq('status', 'pending_admin').order('created_at'),
      scopedFrom('hr_shift_swap_requests')
        .in('status', HISTORY_STATUSES).order('created_at', { ascending: false }).limit(50),
    ])
    // A failed read is not an empty queue: "nothing waiting" over a dropped connection tells a
    // manager there is nothing to approve when there may be three, and swaps are time-bound.
    const err = e1 || e2
    setLoadErr(err || null)
    if (!err) {
      setRequests(pending || [])
      setHistory(hist || [])
      onPendingCount?.((pending || []).length)
    }
    setLoading(false)
  }, [scopedFrom, onPendingCount])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const known = new Set(employees.map(e => e.id))
    const missing = [...new Set([...requests, ...history]
      .flatMap(r => [r.requester_employee_id, r.target_employee_id]))]
      .filter(id => id && !known.has(id) && !attemptedRef.current.has(id))
    if (missing.length === 0) return
    missing.forEach(id => attemptedRef.current.add(id))
    scopedFrom('hr_employees', 'id, full_name').in('id', missing).then(({ data }) => {
      if (data?.length) setExtraNames(p => ({ ...p, ...Object.fromEntries(data.map(e => [e.id, e.full_name])) }))
    })
  }, [requests, history, employees, scopedFrom])

  // admin_decided_by is a profiles.id, not an hr_employees.id like requester/target — profiles
  // RLS only ever returns the caller's own row on a raw query, so resolving another admin/HR
  // manager's name needs get_client_profile_names() (same pattern PosShifts.jsx etc. already use).
  useEffect(() => {
    if (!clientId) return
    supabase.rpc('get_client_profile_names', { p_client_id: clientId })
      .then(({ data }) => setAdminNames(Object.fromEntries((data || []).map(p => [p.id, p.full_name]))))
  }, [clientId])

  async function approve(swap) {
    setBusyId(swap.id); setMsg('')
    const [{ data: reqRow }, { data: tgtRow }] = await Promise.all([
      scopedFrom('hr_roster').eq('employee_id', swap.requester_employee_id)
        .eq('bs_year', swap.bs_year).eq('bs_month', swap.bs_month).eq('bs_day', swap.requester_bs_day).maybeSingle(),
      scopedFrom('hr_roster').eq('employee_id', swap.target_employee_id)
        .eq('bs_year', swap.bs_year).eq('bs_month', swap.bs_month).eq('bs_day', swap.target_bs_day).maybeSingle(),
    ])
    if (!reqRow || !tgtRow) { setMsg('One of the shifts no longer exists — cannot swap.'); setBusyId(null); return }

    const SENTINEL_DAY = -1

    const { error: e1 } = await scopedUpdate('hr_roster', { bs_day: SENTINEL_DAY }).eq('id', reqRow.id)
    if (e1) { setMsg('Failed to swap: ' + e1.message); setBusyId(null); return }

    const { error: e2 } = await scopedUpdate('hr_roster', { employee_id: swap.requester_employee_id }).eq('id', tgtRow.id)
    if (e2) {
      const { error: rollbackErr } = await scopedUpdate('hr_roster', { bs_day: swap.requester_bs_day }).eq('id', reqRow.id)
      setMsg(rollbackErr
        ? 'Swap failed and rollback also failed — please check the roster manually: ' + e2.message
        : 'Swap failed: ' + e2.message + ' — no changes were applied, you can retry.')
      setBusyId(null)
      return
    }

    const { error: e3 } = await scopedUpdate('hr_roster', { employee_id: swap.target_employee_id, bs_day: swap.requester_bs_day }).eq('id', reqRow.id)
    if (e3) {
      // tgtRow already carries the requester's identity at this point, and reqRow is stranded on
      // the sentinel day — undo both to get back to the pre-swap state.
      const [{ error: rb1 }, { error: rb2 }] = await Promise.all([
        scopedUpdate('hr_roster', { employee_id: swap.target_employee_id }).eq('id', tgtRow.id),
        scopedUpdate('hr_roster', { employee_id: swap.requester_employee_id, bs_day: swap.requester_bs_day }).eq('id', reqRow.id),
      ])
      setMsg((rb1 || rb2)
        ? 'Swap failed and rollback also failed — please check the roster manually: ' + e3.message
        : 'Swap failed: ' + e3.message + ' — no changes were applied, you can retry.')
      setBusyId(null)
      return
    }

    await scopedUpdate('hr_shift_swap_requests', {
      status: 'approved', admin_decided_by: profile?.id, admin_decided_at: new Date().toISOString(),
    }).eq('id', swap.id)
    supabase.functions.invoke('hr-push', { body: { action: 'notify_swap_admin_decision', request_id: swap.id } })
    setBusyId(null)
    load()
  }

  async function reject(swap) {
    setBusyId(swap.id); setMsg('')
    await scopedUpdate('hr_shift_swap_requests', {
      status: 'rejected_by_admin', admin_decided_by: profile?.id, admin_decided_at: new Date().toISOString(),
    }).eq('id', swap.id)
    supabase.functions.invoke('hr-push', { body: { action: 'notify_swap_admin_decision', request_id: swap.id } })
    setBusyId(null)
    load()
  }

  function decidedOn(r) {
    const dt = r.admin_decided_at || r.target_responded_at || r.created_at
    return dt ? new Date(dt).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
  }

  // A coworker's decline and a requester's cancellation never reach a manager, so there is no
  // admin_decided_by on those rows — naming the person who actually ended it beats a bare dash.
  function decidedBy(r) {
    if (r.status === 'rejected_by_target') return nameById[r.target_employee_id] || 'Coworker'
    if (r.status === 'cancelled') return nameById[r.requester_employee_id] || 'Requester'
    if (r.admin_decided_by) return adminNames[r.admin_decided_by] || '—'
    return '—'
  }

  const side = (empId, day, shiftId) => (
    <>
      <b style={{ color: 'var(--theme-text1)' }}>{nameById[empId] || '—'}</b>
      <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
        {bsDayOrdinal(day)} · {shiftMap[shiftId]?.name || '—'}
      </div>
    </>
  )

  if (loading) {
    return <div className="card" style={{ padding: 24, fontSize: 13, color: 'var(--theme-text3)' }}>Loading shift swaps…</div>
  }

  if (loadErr) {
    return (
      <div className="card" style={{ padding: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-red-text)', marginBottom: 6 }}>
          Could not load shift swaps
        </div>
        <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{errorText(loadErr, 'operator')}</div>
        <button
          className="btn btn-ghost" style={{ fontSize: 12, marginTop: 12 }}
          onClick={() => { setLoading(true); setLoadErr(null); load() }}
        >
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="no-print">
      {/* ── Waiting on a manager's decision ── */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: requests.length ? 12 : 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>🔁 Waiting on your approval</span>
          {requests.length > 0 && <span className="badge-amber" style={{ fontSize: 10 }}>{requests.length}</span>}
          <Tip
            text="A swap only reaches you once the coworker has already accepted it. Approving trades who is scheduled on each of the two days — the shifts themselves stay where they are."
            width={250}
          >
            <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>What reaches this list?</span>
          </Tip>
        </div>

        {msg && <div role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', marginBottom: 10 }}>{msg}</div>}

        {requests.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: 0 }}>
            Nothing waiting — every swap your staff have agreed between themselves has been decided.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {requests.map(r => (
              <div
                key={r.id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12,
                  paddingBottom: 10, borderBottom: '1px solid var(--theme-border-lt)',
                }}
              >
                <div style={{ color: 'var(--theme-text2)' }}>
                  <b style={{ color: 'var(--theme-text1)' }}>{nameById[r.requester_employee_id] || '—'}</b>
                  {' '}({bsDayOrdinal(r.requester_bs_day)}, {shiftMap[r.requester_shift_type_id]?.name || '—'})
                  {' ⇄ '}
                  <b style={{ color: 'var(--theme-text1)' }}>{nameById[r.target_employee_id] || '—'}</b>
                  {' '}({bsDayOrdinal(r.target_bs_day)}, {shiftMap[r.target_shift_type_id]?.name || '—'})
                  {' — '}{BS_MONTHS[r.bs_month - 1]} {r.bs_year}
                  {r.note && <span style={{ color: 'var(--theme-text3)' }}> · "{r.note}"</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 10px' }} disabled={busyId === r.id} onClick={() => reject(r)}>Reject</button>
                  <button className="btn btn-primary" style={{ fontSize: 11, padding: '3px 10px' }} disabled={busyId === r.id} onClick={() => approve(r)}>Approve</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Everything already decided ── */}
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>🕘 Swap History</span>
          {history.length > 0 && <span className="badge-gray" style={{ fontSize: 10 }}>{history.length}</span>}
        </div>
        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
          The last 50 decided requests, newest first — across every month, not just the one on the board.
        </p>

        {history.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🕘</div>
            <p className="empty-state-text">
              No swaps have been decided yet. Once one is approved, rejected, declined by the coworker
              or withdrawn, it stays here permanently.
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Requested by</th>
                  <th />
                  <th>Swapped with</th>
                  <th>
                    <Tip text="The reason the employee gave when they asked for the swap." width={200}>Reason</Tip>
                  </th>
                  <th>
                    <Tip text="Who settled it, and when. A coworker's decline or the requester's own withdrawal never reaches a manager, so those show that employee's name instead." width={240}>Decided</Tip>
                  </th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map(r => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{BS_MONTHS[r.bs_month - 1]} {r.bs_year}</td>
                    <td>{side(r.requester_employee_id, r.requester_bs_day, r.requester_shift_type_id)}</td>
                    <td style={{ color: 'var(--theme-text3)', textAlign: 'center' }}>⇄</td>
                    <td>{side(r.target_employee_id, r.target_bs_day, r.target_shift_type_id)}</td>
                    <td style={{ color: 'var(--theme-text3)' }}>{r.note ? `"${r.note}"` : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {decidedBy(r)}
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{decidedOn(r)}</div>
                    </td>
                    <td>
                      <span className={STATUS_BADGE[r.status] || 'badge-gray'} style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                        {STATUS_LABEL[r.status] || r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
