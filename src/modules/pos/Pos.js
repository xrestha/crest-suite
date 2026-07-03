import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

export default function Pos() {
  const { clientId, profile, isAdmin, adminViewClientName, hasPosAccess } = useAuth()
  const navigate = useNavigate()

  const clientName = isAdmin
    ? adminViewClientName
    : (profile?.clients?.name || 'this restaurant')

  const [activated, setActivated] = useState(!!localStorage.getItem('pos_device_client_id'))

  const storedClientId   = localStorage.getItem('pos_device_client_id')
  const storedClientName = localStorage.getItem('pos_device_client_name')
  const boundToOther     = activated && storedClientId !== clientId

  function activate() {
    if (!clientId) return
    localStorage.setItem('pos_device_client_id', clientId)
    localStorage.setItem('pos_device_client_name', clientName)
    setActivated(true)
  }

  function deactivate() {
    localStorage.removeItem('pos_device_client_id')
    localStorage.removeItem('pos_device_client_name')
    setActivated(false)
  }

  const canManage = hasPosAccess('manager')

  return (
    <div style={{ padding: '40px 28px', maxWidth: 520 }}>
      <h2 style={{ color: 'var(--theme-text1)', margin: '0 0 8px' }}>Crest POS</h2>
      <p style={{ color: 'var(--theme-text3)', fontSize: 13, marginBottom: 32 }}>
        Point of Sale — set up this device so your staff can log in with a PIN.
      </p>

      {canManage && (
        activated ? (
          <div className="card" style={{ padding: 24, marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{ fontSize: 22, color: 'var(--theme-green)' }}>✓</span>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>Device activated</div>
                <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                  Bound to: <strong>{storedClientName}</strong>
                </div>
              </div>
            </div>
            {boundToOther && (
              <p style={{ fontSize: 12, color: 'var(--theme-amber)', marginBottom: 16 }}>
                This device is bound to a different client. Deactivate first to rebind.
              </p>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => navigate('/pos/login')}>
                Open POS Login Screen
              </button>
              <button
                className="btn btn-ghost"
                style={{ color: 'var(--theme-red)' }}
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
            <button className="btn btn-primary" onClick={activate} disabled={!clientId}>
              Activate for {clientName}
            </button>
          </div>
        )
      )}
    </div>
  )
}
