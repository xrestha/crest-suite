import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Fab from '../../../components/Fab'
import Tip from '../../../components/Tip'
import { printParkingSlip } from './parkingSlipHtml'
import NewParkingSlipModal from './NewParkingSlipModal'
import { viewPosBill } from '../../../utils/viewPosBill'

export default function PosParkingSlips() {
  const { clientId, profile, hasPosAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()

  const [slips, setSlips]     = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter]   = useState('open') // 'open' | 'all'
  const [staffNames, setStaffNames] = useState({})
  const [showNew, setShowNew] = useState(false)
  const [bizInfo, setBizInfo] = useState({ name: '', address: '' })

  const loadSlips = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: rows }, { data: profs }, { data: client }, { data: settings }] = await Promise.all([
      scopedFrom('pos_parking_slips').order('created_at', { ascending: false }),
      // Raw `profiles` reads are RLS-limited to the caller's own row — resolving OTHER staff
      // members' names needs get_client_profile_names(), a SECURITY DEFINER RPC.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address').eq('client_id', clientId).maybeSingle(),
    ])
    setSlips(rows || [])
    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setBizInfo({ name: client?.name || '', address: settings?.property_address || '' })
    setLoading(false)
  }, [clientId, scopedFrom])

  useEffect(() => { loadSlips() }, [loadSlips])

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  async function markExited(slip) {
    await scopedUpdate('pos_parking_slips', { status: 'closed', time_out: new Date().toISOString(), exited_by: profile?.id || null }).eq('id', slip.id)
    loadSlips()
  }

  async function reprint(slip) {
    await printParkingSlip(clientId, slip, bizInfo.name, bizInfo.address, staffNames[slip.issued_by])
    setSlips(prev => prev.map(s => s.id === slip.id ? { ...s, print_count: (s.print_count || 0) + 1 } : s))
  }

  const visible = filter === 'open' ? slips.filter(s => s.status === 'open') : slips

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>Parking Slips</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          Issue a parking token for a customer's vehicle — no order required. Printing a new slip needs Supervisor access.
        </p>
      </div>

      <div className="tab-bar" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${filter === 'open' ? ' tab-btn--active' : ''}`} onClick={() => setFilter('open')}>Open</button>
        <button className={`tab-btn${filter === 'all' ? ' tab-btn--active' : ''}`} onClick={() => setFilter('all')}>All</button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : visible.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {filter === 'open' ? 'No vehicles currently parked.' : 'No parking slips issued yet.'}
        </div>
      ) : (
        <div className="table-wrap">
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
                <th><Tip text="Open means the vehicle is still parked; Closed means it's been marked as exited/retrieved." width={260}>Status</Tip></th>
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
                  <td>{new Date(s.time_in).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</td>
                  <td>
                    {s.bill_invoice_no ? (
                      <button
                        onClick={() => viewPosBill(clientId, { id: s.order_id })}
                        style={{ background: 'none', border: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 13, padding: 0, textDecoration: 'underline' }}
                      >
                        #{s.bill_invoice_no}
                      </button>
                    ) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                  </td>
                  <td style={{ maxWidth: 160, whiteSpace: 'normal', color: 'var(--theme-text2)', fontSize: 12 }}>
                    {s.notes || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                  </td>
                  <td>
                    <span className={`badge ${s.status === 'open' ? 'badge-amber' : 'badge-green'}`}>
                      {s.status === 'open' ? 'Open' : 'Closed'}
                    </span>
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

      <Fab onClick={() => setShowNew(true)} label="+ New Parking Slip" show={hasPosAccess('supervisor') && !showNew} />
    </div>
  )
}
