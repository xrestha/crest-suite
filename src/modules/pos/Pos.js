import { useState } from 'react'
import { useNavigate, Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import ActionError, { asActionError } from '../../components/ActionError'
import Tip from '../../components/Tip'
import { withTimeout } from '../../utils/withTimeout'
import { useConfirm } from '../../shared/hooks/useConfirm'
import { usePosDevices } from './devices/usePosDevices'
import PosDevicesPanel from './devices/PosDevicesPanel'

// What this tablet holds in localStorage. `pos_device_client_id` keeps its meaning — "this browser
// is a bound till" — because App.js, Layout.js's idle lock and its sign-out routing all read it.
// S754 adds `pos_device_id` (+ its name): a tablet holding one signs in with its own key; a tablet
// holding only `pos_device_secret` is on the restaurant's pre-S754 shared key, which is off at every
// client and no longer read (S809 3h), so it is shown as needing activation again.
const LS = {
  clientId: 'pos_device_client_id',
  clientName: 'pos_device_client_name',
  secret: 'pos_device_secret',
  deviceId: 'pos_device_id',
  deviceName: 'pos_device_name',
}

function readStoredDevice() {
  return {
    clientId: localStorage.getItem(LS.clientId),
    clientName: localStorage.getItem(LS.clientName),
    deviceId: localStorage.getItem(LS.deviceId),
    deviceName: localStorage.getItem(LS.deviceName),
  }
}

export default function Pos() {
  const { clientId, profile, isAdmin, adminViewClientName, hasPosAccess, signOut } = useAuth()
  const navigate = useNavigate()
  const { ask, confirmEl } = useConfirm()

  const clientName = isAdmin
    ? adminViewClientName
    : (profile?.clients?.name || 'this restaurant')

  const [stored, setStored] = useState(readStoredDevice)
  const [deviceName, setDeviceName] = useState('')
  const [activating, setActivating] = useState(false)
  const [activateError, setActivateError] = useState(null)
  const [notice, setNotice] = useState('')
  const [leaving, setLeaving] = useState(false)

  const canManage = hasPosAccess('manager')
  const { devices, loading: devicesLoading, error: devicesError, reload } = usePosDevices(canManage ? clientId : null)

  const activated    = !!stored.clientId
  const boundToOther = activated && stored.clientId !== clientId
  // Only claim "revoked" once the list has actually loaded: a failed or pending read proves nothing.
  // A tablet with no key of its own (only the old shared key, S809 3h) needs activating again too.
  const thisDevice   = stored.deviceId ? devices.find(d => d.id === stored.deviceId) : null
  const keyRevoked   = activated && !boundToOther && (!stored.deviceId || (!devicesLoading && !devicesError &&
                       (!thisDevice || !!thisDevice.revoked_at)))

  // Issues this tablet its own key (register_pos_device, migration 20260916120000). The secret comes
  // back exactly once — only its hash is kept on the server — so it goes straight into
  // localStorage and nowhere else. The RPC carries the Owner / admin / POS-manager check itself;
  // `canManage` below only decides whether the page renders.
  async function activate(e) {
    e?.preventDefault()
    if (!clientId || activating) return
    const name = deviceName.trim()
    if (!name) { setActivateError('Give this tablet a name first — for example “Front counter” or “Bar”.'); return }
    setActivating(true)
    setActivateError(null)
    setNotice('')
    let data, error
    try {
      ({ data, error } = await withTimeout(
        supabase.rpc('register_pos_device', { p_client_id: clientId, p_name: name }), 20000, 'Activation'))
    } catch (err) {
      error = err
    }
    setActivating(false)
    const row = Array.isArray(data) ? data[0] : data
    if (error || !row?.device_id || !row?.device_secret) {
      setActivateError(error ? asActionError(error, 'operator') : 'This tablet was not activated — no key came back. Try again.')
      return
    }
    localStorage.setItem(LS.clientId, clientId)
    localStorage.setItem(LS.clientName, clientName)
    localStorage.setItem(LS.secret, row.device_secret)
    localStorage.setItem(LS.deviceId, row.device_id)
    localStorage.setItem(LS.deviceName, name)
    setStored(readStoredDevice())
    setDeviceName('')
    setNotice(`“${name}” is activated. Press “Sign out and open the PIN screen” below before you hand it to your staff.`)
    reload()
  }

  // S809 ACCESS-1. This button used to open the PIN screen with whoever activated the tablet still
  // signed in behind it: the Owner, or the Crest operator on site. The screen looked signed out, but
  // its "← Back", the browser's back button and an installed app's relaunch all went straight into
  // that account with no PIN, and an Owner session never idle-locks. Now it signs out first, on this
  // tablet only ('local'), so the Owner's phone and laptop stay signed in. PosLogin also signs out any
  // session it finds on an activated tablet, for every other way of reaching the PIN screen.
  async function openPinScreen() {
    if (leaving) return
    setLeaving(true)
    // false: the network sign-out failed, and AuthContext cleared this tablet and is reloading it
    // to the PIN screen itself.
    if (!(await signOut({ to: '/pos/login', scope: 'local' }))) return
    navigate('/pos/login', { replace: true })
  }

  function forgetLocally() {
    Object.values(LS).forEach(k => localStorage.removeItem(k))
    setStored(readStoredDevice())
  }

  // Deactivating a tablet that has its own key also revokes that key, so a copy of this browser's
  // storage stops working too. If the revoke cannot be done (a dropped connection, or the key
  // belongs to another outlet this login cannot manage) the tablet still forgets it, and the page
  // says which key is still live and where to revoke it.
  function askDeactivate() {
    setActivateError(null); setNotice('')
    const name = stored.deviceName || 'this tablet'
    ask({
      title: 'Deactivate this tablet?',
      body: stored.deviceId ? (
        <p style={{ margin: 0 }}>
          Staff will no longer be able to sign in with a PIN here, and the key for “{name}” is revoked.
          The tablet must be activated again before it can be used as a till.
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          This tablet forgets its old key. Staff will no longer be able to sign in with a PIN here
          until it is activated again.
        </p>
      ),
      confirmLabel: 'Deactivate',
      busyLabel: 'Deactivating…',
      danger: true,
      run: async () => {
        // S809 ACCESS-11: a PIN login deactivating the tablet it is signed in on is signed out of it
        // straight after. Without the tablet's binding its idle lock stopped and Sign out no longer led
        // to the PIN screen, so the session stayed open on a shared tablet. While the key cannot be
        // revoked, the tablet stays as it was (bound, locking) and says so, since this login could not
        // read the error on the PIN screen.
        const pinSession = !!profile?.pos_role
        if (stored.deviceId) {
          let error
          try {
            ({ error } = await withTimeout(
              supabase.rpc('revoke_pos_device', { p_device_id: stored.deviceId }), 20000, 'Revoke'))
          } catch (err) { error = err }
          if (error && pinSession) {
            const { detail } = asActionError(error, 'operator')
            setActivateError({ text: `This tablet was not deactivated: the key for “${name}” could not be revoked. Check the connection and try again.`, detail })
            return
          }
          forgetLocally()
          if (pinSession) { await openPinScreen(); return }
          if (error) {
            const { detail } = asActionError(error, 'operator')
            setActivateError({
              text: `This tablet was deactivated, but the key for “${name}” could not be revoked and still works. Revoke it from the Tablets list${boundToOther ? ` of ${stored.clientName || 'the restaurant it was bound to'}` : ' below'}.`,
              detail,
            })
          } else {
            setNotice(`This tablet is deactivated and “${name}” is revoked.`)
          }
          reload()
          return
        }
        forgetLocally()
        if (pinSession) { await openPinScreen(); return }
        setNotice('This tablet is deactivated.')
      },
    })
  }

  // Layout.js tags this nav item minPosRole:'manager' and the module guide documents it as
  // "Manager only", but nothing enforced that at the route — a staff PIN account could reach /pos
  // by URL and get the page with its one control hidden. Not a leak (every device-key function
  // carries its own rank check server-side, which is where it belongs), but it is the
  // reachable-but-hidden mismatch CLAUDE.md's "a page reachable by URL needs the guard its nav item
  // implies" rule exists to close. Placed after every hook, per that rule.
  if (!canManage) return <Navigate to="/dashboard" replace />

  const activationForm = (label) => (
    <form onSubmit={activate}>
      <div className="form-field" style={{ maxWidth: 360, marginBottom: 12 }}>
        <label htmlFor="pos-device-name">
          <Tip text="Shown in the Tablets list below, so you can tell your tills apart and revoke the right one if a tablet is lost. It is not shown to staff.">
            Tablet name
          </Tip>
        </label>
        <input
          id="pos-device-name"
          type="text"
          maxLength={60}
          autoComplete="off"
          placeholder="e.g. Front counter"
          value={deviceName}
          onChange={e => setDeviceName(e.target.value)}
          disabled={activating}
        />
      </div>
      <button type="submit" className="btn btn-primary" disabled={!clientId || activating}>
        {activating ? 'Activating…' : label}
      </button>
      <ActionError error={activateError} />
    </form>
  )

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Till Devices</h1>
        <p className="page-subtitle">
          Point of Sale — set up this device so your staff can log in with a PIN.
        </p>
      </div>

      {notice && (
        <p role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', margin: '0 0 16px' }}>{notice}</p>
      )}

      {!activated || keyRevoked ? (
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 16, color: 'var(--theme-text1)' }}>
            {keyRevoked ? 'This tablet needs to be activated again' : 'Activate this device as a POS terminal'}
          </h3>
          <p style={{ fontSize: 13, color: keyRevoked ? 'var(--theme-red-text)' : 'var(--theme-text3)', marginBottom: 20, lineHeight: 1.6 }}>
            {keyRevoked
              ? (stored.deviceId
                ? `The key for “${stored.deviceName || 'this tablet'}” was revoked, so staff cannot sign in here. Activating it again issues a new key.`
                : 'This tablet still holds the restaurant’s old shared key, which is switched off, so staff cannot sign in here. Activating it gives it a key of its own.')
              : 'Once activated, staff can log in on this device with their name and PIN — no email or password needed. This tablet gets its own key, which you can revoke on its own.'}
          </p>
          {activationForm(`Activate for ${clientName}`)}
        </div>
      ) : (
        <div className="card" style={{ padding: 24, marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 22, color: 'var(--theme-green-text)' }}>✓</span>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                Device activated{stored.deviceName ? ` — ${stored.deviceName}` : ''}
              </div>
              <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                Bound to: <strong>{stored.clientName}</strong>
              </div>
            </div>
          </div>
          {boundToOther && (
            <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginBottom: 16 }}>
              This device is bound to a different client. Deactivate first to rebind.
            </p>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={openPinScreen} disabled={leaving}>
              {leaving ? 'Signing out…' : 'Sign out and open the PIN screen'}
            </button>
            <button className="btn btn-danger" onClick={askDeactivate} disabled={leaving}>
              Deactivate Device
            </button>
          </div>
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '12px 0 0', lineHeight: 1.6 }}>
            Your login is signed out on this tablet only, so nobody can tap Back into it. You stay
            signed in on your other devices.
          </p>
          <ActionError error={activateError} />
        </div>
      )}

      {clientId && <PosDevicesPanel
        clientName={clientName}
        devices={devices}
        loading={devicesLoading}
        error={devicesError}
        thisDeviceId={boundToOther ? null : stored.deviceId}
        onChanged={reload}
      />}

      {confirmEl}
    </div>
  )
}
