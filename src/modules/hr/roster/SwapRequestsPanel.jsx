import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { BS_MONTHS } from '../../../utils/bsCalendar'

// Admin-side queue of shift-swap requests a coworker has already accepted (status='pending_admin')
// and is now waiting on final sign-off for. Approving trades the employee_id on the two underlying
// hr_roster rows — each day keeps its own shift, only who's scheduled on it changes (per Help.js's
// own description of this feature). Found live (2026-07-28): the original two-step version
// (target's row -> requester's id, then requester's row -> target's id) assumed the two swapped
// days are always different, which breaks the moment they're the SAME calendar day (e.g. trading
// Morning<->Afternoon on one date — a normal request, not an edge case): for one instant two rows
// would share the same (client_id,employee_id,bs_year,bs_month,bs_day) key, which the unique
// constraint rejects no matter which row is updated first. Routed around it with a 3-step dance
// through an impossible sentinel bs_day (hr_roster.bs_day has no range CHECK, unlike every other
// bs_day column in this schema, so -1 can never collide with a real row): park the requester's row
// on the sentinel day, move the target's row onto the requester's old identity, then bring the
// requester's row back onto the target's old identity. Each step only ever collides with itself.
const HISTORY_STATUSES = ['approved', 'rejected_by_target', 'rejected_by_admin', 'cancelled']
const STATUS_BADGE = {
  approved: 'badge-green', rejected_by_target: 'badge-red', rejected_by_admin: 'badge-red', cancelled: 'badge-gray',
}
const STATUS_LABEL = {
  approved: 'Approved', rejected_by_target: 'Declined by coworker', rejected_by_admin: 'Rejected', cancelled: 'Cancelled',
}

export default function SwapRequestsPanel({ employees, shiftMap }) {
  const { profile, clientId } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [requests, setRequests] = useState([])
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [msg, setMsg] = useState('')

  // Every swap request already lands a permanent row in hr_shift_swap_requests — this just
  // surfaces the resolved ones (the pending queue above only ever shows status='pending_admin',
  // so once a request is decided it silently vanished with no way to look back at who swapped
  // with whom, or who approved/rejected it). No new table, no new RPC.
  const [history, setHistory] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [adminNames, setAdminNames] = useState({})

  const nameById = Object.fromEntries(employees.map(e => [e.id, e.full_name]))

  const load = useCallback(async () => {
    const { data } = await scopedFrom('hr_shift_swap_requests').eq('status', 'pending_admin').order('created_at')
    setRequests(data || [])
  }, [scopedFrom])

  const loadHistory = useCallback(async () => {
    const { data } = await scopedFrom('hr_shift_swap_requests')
      .in('status', HISTORY_STATUSES).order('created_at', { ascending: false }).limit(50)
    setHistory(data || [])
  }, [scopedFrom])

  useEffect(() => { load(); loadHistory() }, [load, loadHistory])

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
    load(); loadHistory()
  }

  async function reject(swap) {
    setBusyId(swap.id); setMsg('')
    await scopedUpdate('hr_shift_swap_requests', {
      status: 'rejected_by_admin', admin_decided_by: profile?.id, admin_decided_at: new Date().toISOString(),
    }).eq('id', swap.id)
    supabase.functions.invoke('hr-push', { body: { action: 'notify_swap_admin_decision', request_id: swap.id } })
    setBusyId(null)
    load(); loadHistory()
  }

  function decidedLine(r) {
    const dt = r.admin_decided_at || r.target_responded_at || r.created_at
    const dateStr = dt ? new Date(dt).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
    if (r.status === 'rejected_by_target') return `Declined by ${nameById[r.target_employee_id] || 'coworker'} · ${dateStr}`
    if (r.admin_decided_by) return `${STATUS_LABEL[r.status] || r.status} by ${adminNames[r.admin_decided_by] || '—'} · ${dateStr}`
    return `${STATUS_LABEL[r.status] || r.status} · ${dateStr}`
  }

  if (requests.length === 0 && history.length === 0) return null

  return (
    <div className="no-print card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
      {requests.length > 0 && (
        <>
          <button
            onClick={() => setOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
              🔁 Shift Swap Requests <span className="badge-amber" style={{ fontSize: 10, marginLeft: 6 }}>{requests.length}</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{open ? '▲' : '▼'}</span>
          </button>
          {open && (
            <div style={{ borderTop: '1px solid var(--theme-border-lt)', padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {msg && <div style={{ fontSize: 12, color: 'var(--theme-red)' }}>{msg}</div>}
              {requests.map(r => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, fontSize: 12 }}>
                  <div style={{ color: 'var(--theme-text2)' }}>
                    <b style={{ color: 'var(--theme-text1)' }}>{nameById[r.requester_employee_id] || '—'}</b>
                    {' '}(day {r.requester_bs_day}, {shiftMap[r.requester_shift_type_id]?.name || '—'})
                    {' ⇄ '}
                    <b style={{ color: 'var(--theme-text1)' }}>{nameById[r.target_employee_id] || '—'}</b>
                    {' '}(day {r.target_bs_day}, {shiftMap[r.target_shift_type_id]?.name || '—'})
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
        </>
      )}

      {history.length > 0 && (
        <>
          <button
            onClick={() => setHistoryOpen(o => !o)}
            style={{
              width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 16px', background: 'none', border: 'none',
              borderTop: requests.length > 0 ? '1px solid var(--theme-border-lt)' : 'none',
              cursor: 'pointer',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
              🕘 Swap History <span className="badge-gray" style={{ fontSize: 10, marginLeft: 6 }}>{history.length}</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{historyOpen ? '▲' : '▼'}</span>
          </button>
          {historyOpen && (
            <div style={{ borderTop: '1px solid var(--theme-border-lt)', padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto' }}>
              {history.map(r => (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, fontSize: 12 }}>
                  <div style={{ color: 'var(--theme-text2)' }}>
                    <b style={{ color: 'var(--theme-text1)' }}>{nameById[r.requester_employee_id] || '—'}</b>
                    {' '}(day {r.requester_bs_day}, {shiftMap[r.requester_shift_type_id]?.name || '—'})
                    {' ⇄ '}
                    <b style={{ color: 'var(--theme-text1)' }}>{nameById[r.target_employee_id] || '—'}</b>
                    {' '}(day {r.target_bs_day}, {shiftMap[r.target_shift_type_id]?.name || '—'})
                    {' — '}{BS_MONTHS[r.bs_month - 1]} {r.bs_year}
                    {r.note && <span style={{ color: 'var(--theme-text3)' }}> · "{r.note}"</span>}
                    <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>{decidedLine(r)}</div>
                  </div>
                  <span className={STATUS_BADGE[r.status] || 'badge-gray'} style={{ fontSize: 10, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {STATUS_LABEL[r.status] || r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
