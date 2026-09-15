import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Fab from '../../../components/Fab'
import Tip from '../../../components/Tip'
import { printParkingSlip } from './parkingSlipHtml'
import NewParkingSlipModal from './NewParkingSlipModal'
import { viewPosBill } from '../../../utils/viewPosBill'
import { nepalTime, serviceDayStartIso } from '../../../shared/nepalTime'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'

export default function PosParkingSlips() {
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [slips, setSlips]     = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter]   = useState('open') // 'open' | 'all'
  const [staffNames, setStaffNames] = useState({})
  const [showNew, setShowNew] = useState(false)
  const [bizInfo, setBizInfo] = useState({ name: '', address: '' })
  const [loadError, setLoadError]     = useState(null)  // a read the page depends on failed (S754)
  const [sweepFailed, setSweepFailed] = useState(false) // some stale slips could not be auto-closed
  const [actionError, setActionError] = useState(null)  // the last Mark Exited that did not land

  const loadSlips = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const results = await Promise.all([
      // Paged: nothing bounds this by date, so it is every slip the outlet has ever written and
      // it only gets longer. A bare select stops at 1000 with no error, which here would also
      // silently shrink the stale-slip sweep below to whatever happened to fit.
      fetchAllRows(() => scopedFrom('pos_parking_slips').order('created_at', { ascending: false }).order('id')),
      // Raw `profiles` reads are RLS-limited to the caller's own row — resolving OTHER staff
      // members' names needs get_client_profile_names(), a SECURITY DEFINER RPC.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address').eq('client_id', clientId).maybeSingle(),
    ])
    // S754: a failed read is not an empty car park. Every one of these used to drop its error, so a
    // dead connection rendered "No vehicles currently parked" over vehicles still in the lot — and
    // the names and the outlet header are what a printed token carries, so they gate the page too.
    const readErr = results.find(r => r.error)?.error
    if (readErr) { setSlips([]); setLoadError(readErr); setLoading(false); return }
    setLoadError(null)
    const [{ data: rows }, { data: profs }, { data: client }, { data: settings }] = results

    // Sweep-close any slip still "open" from a previous day — the Open tab should start fresh
    // each day, not accumulate vehicles staff forgot to Mark Exited. No server cron in this
    // project (see Periods.js's own client-side expired-period check), so this runs the moment
    // the page is next opened, whatever day that is. Data is never deleted, just flagged
    // auto_closed so it stays distinguishable from a real confirmed exit.
    // S754 (owner decision): a slip rolls over at 6 AM Nepal time, not at the device's midnight — a
    // car parked at 11:30 PM during a late service must still be on the Open tab at 12:30 AM.
    const startOfDay = new Date(serviceDayStartIso())
    const stale = (rows || []).filter(s => s.status === 'open' && new Date(s.time_in) < startOfDay)
    setSweepFailed(false)
    if (stale.length > 0) {
      const nowIso = new Date().toISOString()
      // S754: only rows the update actually closed are shown closed. The error used to be dropped
      // while every stale row was flipped on screen, so a refused sweep showed vehicles as
      // Auto-Closed that the database still held open. `.select('id')` also catches the zero-row
      // RLS refusal, which returns no error at all.
      const { data: closed, error: sweepErr } = await scopedUpdate('pos_parking_slips', { status: 'closed', time_out: nowIso, auto_closed: true })
        .in('id', stale.map(s => s.id)).select('id')
      const closedIds = new Set((sweepErr ? [] : closed || []).map(s => s.id))
      if (closedIds.size < stale.length) setSweepFailed(true)
      ;(rows || []).forEach(s => { if (closedIds.has(s.id)) { s.status = 'closed'; s.time_out = nowIso; s.auto_closed = true } })
    }

    setSlips(rows || [])
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setBizInfo({ name: client?.name || '', address: settings?.property_address || '' })
    setLoading(false)
  }, [clientId, scopedFrom, scopedUpdate])

  useEffect(() => { loadSlips() }, [loadSlips])

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  async function markExited(slip) {
    setActionError(null)
    // S754: the write error was ignored and the list reloaded unchanged, which reads as "that did
    // nothing" rather than as a refusal. Say which vehicle is still marked parked.
    const { data, error } = await scopedUpdate('pos_parking_slips', { status: 'closed', time_out: new Date().toISOString(), exited_by: profile?.id || null })
      .eq('id', slip.id).select('id')
    if (error) {
      const { text, detail } = asActionError(error, 'staff')
      setActionError({ text: `${slip.vehicle_number} (P-${slip.slip_no}) could not be confirmed as exited — it still shows as parked here. ${text}`, detail })
      return
    }
    if (!data?.length) {
      setActionError({ text: `${slip.vehicle_number} (P-${slip.slip_no}) was not marked exited — this account may not change it, or it was removed on another device. The list has been refreshed.` })
    }
    loadSlips()
  }

  async function reprint(slip) {
    await printParkingSlip(clientId, slip, bizInfo.name, bizInfo.address, staffNames[slip.issued_by])
    setSlips(prev => prev.map(s => s.id === slip.id ? { ...s, print_count: (s.print_count || 0) + 1 } : s))
  }

  const visible = filter === 'open' ? slips.filter(s => s.status === 'open') : slips

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Parking Slips</h1>
        <p className="page-subtitle">
          Issue a parking token for a customer's vehicle — no order required. Printing a new slip needs Supervisor access.
        </p>
      </div>

      <div className="tab-bar" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${filter === 'open' ? ' tab-btn--active' : ''}`} onClick={() => setFilter('open')}>Open</button>
        <button className={`tab-btn${filter === 'all' ? ' tab-btn--active' : ''}`} onClick={() => setFilter('all')}>All</button>
      </div>

      <ActionError error={actionError} className="action-error--top" />
      {!loading && !loadError && sweepFailed && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          Some slips from an earlier day could not be closed automatically, so they still show as parked. Mark them Exited, or reload the page to try again.
        </p>
      )}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : visible.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {filter === 'open' ? 'No vehicles currently parked.' : 'No parking slips issued yet.'}
        </div>
      ) : (
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
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(s => (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>P-{s.slip_no}</td>
                  <td style={{ fontWeight: 600 }}>{s.vehicle_number}</td>
                  <td>{s.vehicle_type || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                  <td>{s.customer_name || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                  <td>{nepalTime(s.time_in)}</td>
                  <td>
                    {s.bill_invoice_no ? (
                      <button
                        onClick={() => viewPosBill(clientId, { id: s.order_id })}
                        style={{ background: 'none', border: 'none', color: 'var(--theme-accent-ink)', cursor: 'pointer', fontSize: 13, padding: 0, textDecoration: 'underline' }}
                      >
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
                  <td style={{ textAlign: 'right', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    {s.status === 'open' && (
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => markExited(s)}>Mark Exited</button>
                    )}
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprint(s)}>Reprint</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewParkingSlipModal
          outletName={bizInfo.name}
          propertyAddress={bizInfo.address}
          onClose={() => setShowNew(false)}
          onIssued={() => { setShowNew(false); loadSlips() }}
        />
      )}

      <Fab onClick={() => setShowNew(true)} label="+ New Parking Slip" show={hasPosAccess('supervisor') && !showNew && !loading && !loadError} />
    </div>
  )
}
