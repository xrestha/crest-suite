import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'

export default function Pos() {
  const { clientId, profile, isAdmin, adminViewClientName, hasPosAccess } = useAuth()
  const navigate = useNavigate()

  const clientName = isAdmin
    ? adminViewClientName
    : (profile?.clients?.name || 'this restaurant')

  const [activated, setActivated] = useState(!!localStorage.getItem('pos_device_client_id'))
  const [activating, setActivating] = useState(false)

  const storedClientId   = localStorage.getItem('pos_device_client_id')
  const storedClientName = localStorage.getItem('pos_device_client_name')
  const boundToOther     = activated && storedClientId !== clientId

  // The device secret (not the raw client_id) is what get_pos_staff actually checks — fetched
  // here from an authenticated session so an unauthenticated PosLogin visit can never obtain it
  // for a client it isn't already bound to.
  //
  // Read through get_pos_device_secret() rather than straight off the clients row: the secret has
  // moved to the admin-only client_secrets table, because clients_select allowed `id =
  // my_client_id()` with no staff restriction — so every POS PIN waiter and HR self-service
  // employee of the client could read the secret that was added specifically to stop outsiders
  // enumerating the staff roster. The RPC enforces the same admin/Owner/POS-manager rank the
  // Activate button below is already gated on (canManage), but on the server.
  async function activate() {
    if (!clientId || activating) return
    setActivating(true)
    const { data: secret, error } = await supabase.rpc('get_pos_device_secret', { p_client_id: clientId })
    setActivating(false)
    if (error || !secret) return
    localStorage.setItem('pos_device_client_id', clientId)
    localStorage.setItem('pos_device_client_name', clientName)
    localStorage.setItem('pos_device_secret', secret)
    setActivated(true)
  }

  function deactivate() {
    localStorage.removeItem('pos_device_client_id')
    localStorage.removeItem('pos_device_client_name')
    localStorage.removeItem('pos_device_secret')
    setActivated(false)
  }

  const canManage = hasPosAccess('manager')

  // Layout.js tags this nav item minPosRole:'manager' and the module guide documents it as
  // "Manager only", but nothing enforced that at the route — a staff PIN account could reach /pos
  // by URL and get the page with its one control hidden. Not a leak (the device secret is behind a
  // rank check inside get_pos_device_secret, server-side, which is where it belongs), but it is the
  // reachable-but-hidden mismatch CLAUDE.md's "a page reachable by URL needs the guard its nav item
  // implies" rule exists to close. Placed after every hook, per that rule.
  if (!canManage) return <Navigate to="/dashboard" replace />

  return (
    <div style={{ maxWidth: 520 }}>
      <div className="page-header">
        <h1 className="page-title">Crest POS</h1>
        <p className="page-subtitle">
          Point of Sale — set up this device so your staff can log in with a PIN.
        </p>
      </div>

      {canManage && (
        activated ? (
          <div className="card" style={{ padding: 24, marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{ fontSize: 22, color: 'var(--theme-green-text)' }}>✓</span>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>Device activated</div>
                <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                  Bound to: <strong>{storedClientName}</strong>
                </div>
              </div>
            </div>
            {boundToOther && (
              <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginBottom: 16 }}>
                This device is bound to a different client. Deactivate first to rebind.
              </p>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => navigate('/pos/login')}>
                Open POS Login Screen
              </button>
              <button
                className="btn btn-ghost"
                style={{ color: 'var(--theme-red-text)' }}
                onClick={deactivate}
              >
                Deactivate Device
              </button>
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 24, marginBottom: 24 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--theme-text1)' }}>
              Activate this device as a POS terminal
            </h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 20, lineHeight: 1.6 }}>
              Once activated, staff can log in on this device with their name and PIN —
              no email or password needed.
            </p>
            <button className="btn btn-primary" onClick={activate} disabled={!clientId || activating}>
              {activating ? 'Activating…' : `Activate for ${clientName}`}
            </button>
          </div>
        )
      )}
    </div>
  )
}
