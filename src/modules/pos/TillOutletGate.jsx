import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import ActionError, { asActionError } from '../../components/ActionError'
import { withTimeout, isTimeout } from '../../utils/withTimeout'
import { outletHeldText } from '../../shared/outletWatch'
import { readTillDevice, tillStop } from './tillOutlet'
import { lockedCartFor, lockedCartWhere } from './posLockedCart'

// How often a stopped till asks whether its login is back. One two-column read of the login's own
// row (AuthContext's checkOutletStillCurrent), and only while the notice is showing.
const RECHECK_MS = 20000

/**
 * The till pages (Orders, Billing, Shifts, Kitchen Display) run only in the outlet the till belongs
 * to (S809 GAP-OUTLETS-1 and ACCESS-4, owner decision Q24 (a)). See tillOutlet.js for why.
 *
 * A route gate, inside ModuleGate, so the page under it is never MOUNTED while stopped: PosOrders'
 * mount effect sends the offline queue and loads the floor for whatever outlet it is handed, and a
 * page that rendered once under the wrong outlet has already done both. Its unsent cart was kept
 * before the stop (AuthContext parks it the way a till lock does), and comes back when the page
 * mounts again in its own outlet.
 */
export default function TillOutletGate({ children }) {
  const {
    clientId, isAdmin, profile, outlets, outletHeld, returnToOutlet, switchAdminClient,
    adminViewClientName, checkOutlet,
  } = useAuth()
  // The outlet this page opened in, for a browser that is no till (below).
  const [openedIn] = useState(clientId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const device = readTillDevice()
  const stop = tillStop({ deviceClientId: device.clientId, clientId, held: !!outletHeld })

  // A stopped till carries on by itself once the login is back, wherever it was switched back.
  useEffect(() => {
    if (!stop || isAdmin) return undefined
    const t = setInterval(() => checkOutlet(), RECHECK_MS)
    return () => clearInterval(t)
  }, [stop, isAdmin, checkOutlet])

  if (!stop) {
    // A browser that is no till follows its login (S798), and Layout takes it to the dashboard after
    // a move. Until it does, the page must not run one render under the new outlet.
    if (!device.clientId && openedIn && clientId && clientId !== openedIn) return null
    return children
  }

  const nameOf = id => outlets.find(o => o.id === id)?.name || null
  const tillName = nameOf(device.clientId) || device.clientName || 'this outlet'
  const hereName = isAdmin ? (adminViewClientName || 'another client') : (nameOf(clientId) || profile?.clients?.name || 'another outlet')
  // Where the login has to be for this till to carry on: the tablet's outlet, or for a window held by
  // its own offline changes, the outlet those changes belong to (the one it shows).
  const targetId = stop === 'held' ? clientId : device.clientId
  const targetName = stop === 'held' ? hereName : tillName
  const isPin = !isAdmin && !!profile?.pos_email
  const kept = profile?.id ? lockedCartFor(profile.id, targetId) : null
  const keptUnits = Number(kept?.unsentUnits) || 0

  async function goBack() {
    setError(null)
    if (isAdmin) { switchAdminClient(device.clientId, tillName); return }
    setBusy(true)
    let res
    try {
      res = await withTimeout(returnToOutlet(targetId), 20000, 'Switching back')
    } catch (err) {
      res = { error: err }
    }
    setBusy(false)
    const err = res?.error
    if (!err) return
    if (isTimeout(err)) setError('The server took too long to answer. If the switch went through, this till carries on by itself in a moment; if not, press the button again.')
    // set_active_outlet's own refusals are sentences (RAISE with no code of its own); keep them.
    else if (err.code === 'P0001' && err.message) setError(err.message)
    else if (err.code || err.hint) setError(asActionError(err, isPin ? 'staff' : 'operator'))
    else setError(err.message || 'Could not switch back.')
  }

  return (
    <div className="card" role="alert" style={{ maxWidth: 640, margin: '24px auto', padding: 24 }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 18, color: 'var(--theme-text1)' }}>
        {stop === 'held' ? 'This till is waiting for your account to come back' : `This till belongs to ${tillName}`}
      </h2>

      <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.6, color: 'var(--theme-text2)' }}>
        {stop === 'held'
          ? outletHeldText({ here: hereName, there: outletHeld?.name || null, pending: outletHeld?.pending })
          : isAdmin
            ? `This browser is set up as ${tillName}'s till, and you are viewing ${hereName}. A till runs only for the outlet it was set up for, so its bills, kitchen tickets and shifts never go into another outlet's books.`
            : `Your account is now working in ${hereName}: it was switched on another device, in another window, or here. A till stays with the outlet it was set up for, so nothing can be billed, sent to the kitchen or opened as a shift on it until your account is back on ${tillName}.`}
      </p>

      {keptUnits > 0 && (
        <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.6, color: 'var(--theme-text1)' }}>
          {keptUnits} item{keptUnits === 1 ? '' : 's'} you had not sent for {lockedCartWhere(kept)} {keptUnits === 1 ? 'is' : 'are'} kept
          on this till, and come{keptUnits === 1 ? 's' : ''} back when it carries on.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, margin: '16px 0 8px' }}>
        <button type="button" className="btn btn-primary" onClick={goBack} disabled={busy}>
          {busy ? 'Switching…' : isAdmin ? `View ${tillName}` : `Back to ${targetName}`}
        </button>
      </div>
      {!isAdmin && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text3)', lineHeight: 1.5 }}>
          This moves your account back to {targetName} everywhere it is signed in, your phone included. The till
          also carries on by itself once your account is back there.
        </p>
      )}
      <ActionError error={error} />

      {stop === 'away' && (
        <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--theme-text3)', lineHeight: 1.5 }}>
          {isAdmin
            ? 'To use this browser as another client’s till, deactivate it under POS → Till Devices first.'
            : isPin
              ? 'Ask your manager if this keeps happening.'
              : 'To keep this till billing while you work in another outlet, give it a login of its own: add a staff PIN login under POS Staff, and sign in here with it.'}
        </p>
      )}
    </div>
  )
}
