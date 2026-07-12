import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { BS_MONTHS } from '../../../utils/bsCalendar'

// Admin-side queue of shift-swap requests a coworker has already accepted (status='pending_admin')
// and is now waiting on final sign-off for. Approving trades the employee_id on the two underlying
// hr_roster rows — safe because they're on different bs_days, so the
// (client_id,employee_id,bs_year,bs_month,bs_day) unique constraint never collides mid-swap.
export default function SwapRequestsPanel({ employees, shiftMap }) {
  const { profile } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [requests, setRequests] = useState([])
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [msg, setMsg] = useState('')

  const nameById = Object.fromEntries(employees.map(e => [e.id, e.full_name]))

  const load = useCallback(async () => {
    const { data } = await scopedFrom('hr_shift_swap_requests').eq('status', 'pending_admin').order('created_at')
    setRequests(data || [])
  }, [scopedFrom])

  useEffect(() => { load() }, [load])

  async function approve(swap) {
    setBusyId(swap.id); setMsg('')
    const [{ data: reqRow }, { data: tgtRow }] = await Promise.all([
      scopedFrom('hr_roster').eq('employee_id', swap.requester_employee_id)
        .eq('bs_year', swap.bs_year).eq('bs_month', swap.bs_month).eq('bs_day', swap.requester_bs_day).maybeSingle(),
      scopedFrom('hr_roster').eq('employee_id', swap.target_employee_id)
        .eq('bs_year', swap.bs_year).eq('bs_month', swap.bs_month).eq('bs_day', swap.target_bs_day).maybeSingle(),
    ])
    if (!reqRow || !tgtRow) { setMsg('One of the shifts no longer exists — cannot swap.'); setBusyId(null); return }

    const { error: e1 } = await scopedUpdate('hr_roster', { employee_id: swap.target_employee_id }).eq('id', reqRow.id)
    if (e1) { setMsg('Failed to swap: ' + e1.message); setBusyId(null); return }
    const { error: e2 } = await scopedUpdate('hr_roster', { employee_id: swap.requester_employee_id }).eq('id', tgtRow.id)
    if (e2) {
      // Roll back the first update — without this, a partial failure left the roster
      // half-swapped (target owned both shifts) AND made the request unrecoverable through this
      // UI (a retry's row lookup above matches on employee_id, which the first update already
      // moved off the requester, so it would report "shift no longer exists").
      const { error: rollbackErr } = await scopedUpdate('hr_roster', { employee_id: swap.requester_employee_id }).eq('id', reqRow.id)
      setMsg(rollbackErr
        ? 'Swap failed and rollback also failed — please check the roster manually: ' + e2.message
        : 'Swap failed: ' + e2.message + ' — no changes were applied, you can retry.')
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

  if (requests.length === 0) return null

  return (
    <div className="no-print card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
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
    </div>
  )
}
