import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useTheme } from '../../../context/ThemeContext'
import { getInitials, avatarColorFor, relativeLuminance } from '../../../utils/avatarColor'
import { withTimeout } from '../../../utils/withTimeout'
import { listLockedCarts } from '../posLockedCart'
import { useReleaseReload } from '../../../shared/releaseWatch'
import ArrivalAlert from '../../../components/ArrivalAlert'
import { useGuestOrderAlerts, REPEAT_MS } from '../../../shared/hooks/useGuestOrderAlerts'
import { guestAlertTitle, guestAlertDetail } from '../../../shared/guestAlertBridge'
import { playGuestAlert, soundBlocked, unlockAudio } from '../posChime'

// The PIN screen is every till's resting state, so it is where a new release is picked up (S809 1b).
// A few quiet seconds first, so a reload never lands under a waiter typing a PIN. Locked carts are in
// localStorage and survive it.
const RELEASE_IDLE_MS = 10 * 1000

// The exact `error` strings pos-staff-login returns on a 401 (supabase/functions/pos-staff-login).
const ERR_INVALID_CREDENTIALS = 'Invalid credentials'
const ERR_DEVICE_NOT_ACTIVATED = 'This device is not activated'
// S754: a connection or server failure is not a wrong PIN, and the PIN stays in the dots so the
// waiter can press Login again once the signal is back.
const UNREACHABLE_MSG = "Couldn't reach the server — check the connection"

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['C', '0', '⌫'],
]

export default function PosLogin() {
  const navigate = useNavigate()
  const { colors } = useTheme()
  const isDark = relativeLuminance(colors.bg) < 0.5
  const clientId     = localStorage.getItem('pos_device_client_id')
  const clientName   = localStorage.getItem('pos_device_client_name') || 'Crest POS'
  const deviceSecret = localStorage.getItem('pos_device_secret')
  // S754: a tablet activated since per-tablet keys holds its own device id beside its secret. One
  // activated before holds only the restaurant's shared secret, which is off at every client (S809 1j)
  // and no longer read at all (S809 3h): that tablet is activated again, like a revoked one.
  const deviceId     = localStorage.getItem('pos_device_id')

  const [staff,     setStaff]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [selected,  setSelected]  = useState(null)
  const [pin,       setPin]       = useState('')
  const [error,     setError]     = useState('')
  const [loadError, setLoadError] = useState('')
  const [retryToken, setRetryToken] = useState(0)
  const [signingIn, setSigningIn] = useState(false)
  // The device key was refused by the picker itself — revoked from Till Devices, or never registered.
  const [deviceDead, setDeviceDead] = useState(false)

  useReleaseReload(!signingIn, RELEASE_IDLE_MS)

  useEffect(() => {
    // No silent bounce — an unactivated device shows its own explanatory screen below
    // instead of instantly redirecting to /login with no indication of why.
    if (!clientId || !deviceSecret) { setLoading(false); return }
    // S809 3h: only the restaurant's old shared key, no key of its own. Nothing can sign in with it.
    if (!deviceId) { setDeviceDead(true); setLoading(false); return }
    setLoadError('')
    setDeviceDead(false)
    setLoading(true)
    // The RPC's `error` used to be discarded, so a network failure fell through to the empty-state
    // copy — a till mid-service was told "No staff accounts found. Ask your manager to add staff",
    // which sends the manager to the wrong page to fix a problem that isn't there. Self-Service's
    // equivalent screen already separated these two; this is that fix ported back.
    const request = supabase.rpc('get_pos_device_staff', { p_client_id: clientId, p_device_id: deviceId, p_device_secret: deviceSecret })
    request.then(({ data, error }) => {
      // get_pos_device_staff RAISES on a dead key (rather than returning no rows) precisely so this
      // screen can say "activate again" instead of "no staff accounts found", which would send the
      // manager to POS Staff to fix a problem that is not there.
      if (error && String(error.message || '').includes('pos_device_not_active')) setDeviceDead(true)
      else if (error) setLoadError("Couldn't reach the server. Check this device's connection and try again.")
      else setStaff(data || [])
      setLoading(false)
    })
  }, [clientId, deviceId, deviceSecret, retryToken])

  // ── Nobody stays signed in behind the PIN screen (S809 ACCESS-1) ──
  // This screen looks signed out. When a login was still live on the tablet, the Owner who had just
  // activated it or the Crest operator, its "← Back" (and the browser's) went straight into that
  // account with no PIN. So on an activated tablet it signs out any session it finds, on this tablet
  // only ('local', so an Owner's phone and laptop stay signed in), and shows no staff until that is
  // done. A PIN session is signed out too: none should be live while this screen shows.
  // The one session it must never touch is the one its own PIN sign-in creates: `ownSessionRef` is
  // set just before setSession, and no sign-out starts while a sign-in is in flight, because both
  // write the one stored session and the later write would win.
  const { session, ready, signOut } = useAuth()
  const ownSessionRef = useRef(false)
  const clearStartedRef = useRef(false)
  const [clearing, setClearing] = useState(false)
  const staleSession = !!clientId && !!deviceSecret && !!ready && !!session && !ownSessionRef.current && !signingIn
  useEffect(() => {
    if (!staleSession || clearStartedRef.current || typeof signOut !== 'function') return
    clearStartedRef.current = true
    setClearing(true)
    // false: /logout could not be reached; AuthContext cleared this tablet itself and is reloading it
    // here. true: the session is gone, so a login that appears later (another tab) is caught again.
    // A throw (none is expected: deviceSignOut catches its own) keeps the staff hidden: a PIN screen
    // over a live login is the state this exists to prevent.
    signOut({ to: '/pos/login', scope: 'local' }).then(clean => {
      if (!clean) return
      clearStartedRef.current = false
      setClearing(false)
    }, e => console.error('Could not sign out the login left on this tablet:', e))
  }, [staleSession, signOut])
  const holdForSignOut = staleSession || clearing

  // ── A guest's QR order, announced on the locked till (S809 3c, FLOOR-KITCHEN-1; owner Q14 1) ──
  // This screen is every PIN till's resting state: three idle minutes and it is back here, outside
  // the app shell and its alert, with nobody signed in. A guest order placed then was heard nowhere
  // (the Kitchen Display leaves guest orders to the floor by design). It now asks through this
  // tablet's own key, as the staff picker above does, and gets table names and times only; a tablet
  // on the pre-S754 shared key (no device id) is not asked about. Same banner, repeat and Mute as
  // the shell's, and the Mute is the same one (guestAlertBridge.js).
  const guestAlerts = useGuestOrderAlerts(!!(clientId && deviceId && deviceSecret) && !deviceDead, { device: { clientId, deviceId, deviceSecret } })
  const guestWaiting = guestAlerts.requests.length > 0
  useEffect(() => {
    if (!guestWaiting || guestAlerts.muted) return
    playGuestAlert({ urgent: guestAlerts.urgent })
    const id = setInterval(() => playGuestAlert({ urgent: guestAlerts.urgent }), REPEAT_MS)
    return () => clearInterval(id)
  }, [guestWaiting, guestAlerts.muted, guestAlerts.urgent])
  // This screen reloads itself to take a release, and a page nobody has touched since loading may
  // not play sound. Any tap or key here lets it; until one comes, the banner says the sound is off.
  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('keydown', unlockAudio)
    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
    }
  }, [])

  const pressKey = useCallback((k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); setError(''); return }
    if (k === 'C') { setPin(''); setError(''); return }
    if (!k) return
    setPin(p => p.length < 6 ? p + k : p)
    setError('')
  }, [])

  // Keyboard support
  useEffect(() => {
    if (!selected) return
    function onKey(e) {
      if (e.key >= '0' && e.key <= '9') pressKey(e.key)
      else if (e.key === 'Backspace')    pressKey('⌫')
      else if (e.key === 'Escape')       pressKey('C')
      else if (e.key === 'Enter')        handleSignIn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, pin, pressKey]) // eslint-disable-line

  async function handleSignIn() {
    if (pin.length < 4 || signingIn || holdForSignOut) return
    setSigningIn(true); setError('')

    try {
      // Sign-in and the PIN lockout both run server-side now (pos-staff-login). This used to call
      // check_pos_pin_lock, then signInWithPassword directly with selected.pos_email, then
      // record_pos_pin_attempt — which made the lockout advisory: the PIN literally IS the Supabase
      // Auth password, so anyone holding a pos_email could call signInWithPassword in a loop and
      // walk the 4-digit keyspace with those two RPCs never on the path. And pos_email itself no
      // longer comes back from the staff picker at all, so the browser never holds a working login
      // identifier — same fix S464 applied to HR Self-Service. See the Edge Function's comment.
      // withTimeout: a supabase-js call can stall before it reaches fetch (utils/withTimeout.js),
      // which would leave "Signing in…" on screen with no way back but a reload.
      const { data, error: err } = await withTimeout(supabase.functions.invoke('pos-staff-login', {
        body: { client_id: clientId, device_id: deviceId, device_secret: deviceSecret, staff_id: selected.id, pin },
      }), 20000, 'Sign-in')

      if (err) {
        // S754: every failure used to read "Incorrect PIN" — a dropped connection, a deactivated
        // till and a crashed function alike — and cleared the PIN. supabase-js resolves a non-2xx
        // as a FunctionsHttpError whose `context` is the Response; a network failure is a
        // FunctionsFetchError and a gateway failure a FunctionsRelayError, both with no body worth
        // reading. Only a 4xx from the function itself says anything about the PIN.
        const status = err.name === 'FunctionsHttpError' ? err.context?.status : null
        if (!status || status >= 500) { setError(UNREACHABLE_MSG); return }
        let body = null
        try { body = await err.context.json() } catch (_) { /* no JSON body — handled below */ }

        if (status === 423 || body?.locked) {
          // Names the way out, not just the wall. The lockout clears on its own, but 15 minutes is
          // a long time mid-service, and the person who can fix it immediately is standing in the
          // same building: a reset from POS Staff ends the lockout (S809 DOCS-1; before that the new
          // PIN was refused until the lock ran out). "a manager or the owner", not "your manager":
          // a manager's own PIN, and the PIN of anyone holding a power their manager lacks (S809
          // ACCESS-3), are reset by the Owner. Never support — this never needs to reach Crest.
          const when = body?.locked_until ? formatLockRemaining(body.locked_until) : 'later'
          setError(`Too many incorrect attempts. Try again ${when}, or ask a manager or the owner to reset your PIN.`)
          setPin('')
        } else if (status === 401 && body?.error === ERR_DEVICE_NOT_ACTIVATED) {
          // The device key no longer works: this tablet was revoked in Till Devices, or it still
          // holds the shared key a manager has since switched off (S754). No PIN will work until a
          // manager activates it again from /pos.
          setError('This till needs to be activated again by a manager')
        } else if (status === 401 && body?.error === ERR_INVALID_CREDENTIALS) {
          setError('Incorrect PIN. Try again.')
          setPin('')
        } else if (status === 403 && body?.switched_off) {
          // S809 3h: a login POS Staff blocked, or a leaver's after Final Settlement, picked from a list
          // read before the block. Not a wrong PIN, and the try is not counted toward the lockout. The
          // list is read again, so the name is gone when the waiter steps back.
          setError('This login is switched off. Ask a manager or the owner.')
          setPin('')
          setRetryToken(t => t + 1)
        } else {
          // A 4xx this screen does not recognise. Not a wrong PIN, so don't say it is.
          setError(`Couldn't sign in${body?.error ? ` (${body.error})` : ''}. Ask your manager.`)
        }
        return
      }
      if (!data?.access_token) { setError(UNREACHABLE_MSG); return }

      // From here the session on this tablet is the one this screen signed in (S809 ACCESS-1).
      ownSessionRef.current = true
      const { error: sessionErr } = await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      })
      // S809 ACCESS-12: setSession checks the tokens over the network before it keeps them, and
      // resolves { error } rather than throwing. Unread, a dropped connection here stored no session,
      // and the next screen bounced a waiter who typed the right PIN to the owner's email login.
      if (sessionErr) {
        ownSessionRef.current = false
        setError(UNREACHABLE_MSG)
        return
      }
      // S754: /pos is Till Devices, manager-only, and bounced every waiter to /dashboard. The till is
      // /pos/orders; a kitchen/bar station account is sent on to its KDS by ModuleGate
      // (canReachPosPath → STATION_TEAM_HOME), so no team check is needed here.
      navigate('/pos/orders', { replace: true })
    } catch (_) {
      // withTimeout's rejection, or anything else thrown on the way: the connection, not the PIN.
      // Keep the PIN (S754).
      setError(UNREACHABLE_MSG)
    } finally {
      setSigningIn(false)
    }
  }

  function formatLockRemaining(lockedUntil) {
    const mins = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000))
    return `in ${mins} minute${mins !== 1 ? 's' : ''}`
  }

  function pickStaff(s) { setSelected(s); setPin(''); setError('') }
  function back()        { setSelected(null); setPin(''); setError('') }

const pinDots = Math.max(4, pin.length)
  // What a till lock kept on this device (S776, posLockedCart.js). Said here because this is the
  // screen the waiter comes back to — the lock itself happened while nobody was looking.
  const keptCarts = listLockedCarts(clientId)
  const keptForSelected = selected ? keptCarts.find(k => k.profileId === selected.id) : null
  const itemsWord = n => `${n} item${n === 1 ? '' : 's'}`

  // Device not yet activated for any client — explain why, instead of silently bouncing
  // to /login. Activation itself happens from Till Devices (/pos) by an owner/manager.
  // Also catches a device activated before device-secret verification was introduced — its
  // stored client_id is still present but there's no secret to show staff with, so it needs a
  // one-time re-activation rather than silently showing "no staff found".
  // Its key was refused — revoked — or it holds only the restaurant's old shared key, which is off
  // (S809 3h). Same screen shape as never activated, because the way out is the same: activating
  // this tablet again in /pos.
  if (deviceDead) {
    return (
      <main style={{
        minHeight: '100vh', background: 'var(--theme-bg)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div className="card" role="alert" style={{ padding: 32, maxWidth: 380, textAlign: 'center' }}>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', margin: '0 0 8px' }}>
            This till needs to be activated again by a manager
          </h1>
          <p style={{ fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6, marginBottom: 24 }}>
            Its device key no longer works, so staff can't sign in on it. An owner or POS manager can sign
            in here, open <strong>POS → Admin → Till Devices</strong>, activate this tablet again, then
            press <strong>Sign out and open the PIN screen</strong>.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/login')}>
            Owner Login
          </button>
        </div>
      </main>
    )
  }

  if (!clientId || !deviceSecret) {
    return (
      <main style={{
        minHeight: '100vh', background: 'var(--theme-bg)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div className="card" style={{ padding: 32, maxWidth: 380, textAlign: 'center' }}>
          <div aria-hidden="true" style={{ fontSize: 32, marginBottom: 12 }}>📱</div>
          <h1 style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', margin: '0 0 8px' }}>
            This device isn't set up yet
          </h1>
          <p style={{ fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6, marginBottom: 24 }}>
            Staff PIN login only works on a device an owner or manager has activated first.
            Log in with your owner account, open <strong>POS → Admin → Till Devices</strong>, click
            <strong> Activate</strong>, then <strong>Sign out and open the PIN screen</strong> — this
            screen will then show your staff.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/login')}>
            Owner Login
          </button>
        </div>
      </main>
    )
  }

  return (
    <main style={{
      minHeight: '100vh',
      background: 'var(--theme-bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      // The guest-order banner is fixed at the top and publishes its measured height; 0 without it.
      padding: 'calc(24px + var(--arrival-alert-h, 0px)) 24px 24px',
    }}>
    {guestWaiting && (
      <ArrivalAlert
        reserveSpace
        urgent={guestAlerts.urgent}
        muted={guestAlerts.muted}
        onMute={guestAlerts.mute}
        title={guestAlertTitle(guestAlerts.requests)}
        detail={guestAlertDetail({ waitedMs: guestAlerts.waitedMs, where: 'pin', soundOff: soundBlocked() })}
      />
    )}
    <div className="card" style={{
      padding: '40px 36px', borderRadius: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      width: '100%', maxWidth: 540,
    }}>

      {/* Header — Georgia serif is reserved for exactly two places in this product: the
          sidebar wordmark and this login screen (DESIGN.md §3, The One Serif Rule). */}
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, fontFamily: 'Georgia, serif', letterSpacing: '0.02em', color: 'var(--theme-text1)', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
          {clientName}
        </h1>
        <div style={{ fontSize: selected ? 18 : 14, fontWeight: selected ? 600 : 400, color: selected ? 'var(--theme-text1)' : 'var(--theme-text3)', marginTop: 10, letterSpacing: 0.2 }}>
          {selected ? `Enter PIN for ${selected.full_name}` : 'Who are you?'}
        </div>
      </div>

      {holdForSignOut ? (
        /* No staff and no PIN pad while a login left on this tablet is being signed out (S809). */
        <p role="status" style={{ color: 'var(--theme-text3)', textAlign: 'center', maxWidth: 320, margin: 0 }}>
          Signing out the login that was left open on this tablet…
        </p>
      ) : !selected ? (
        /* ── Staff grid ─────────────────────────────────────────────────── */
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
          {keptCarts.length > 0 && (
            <div role="status" style={{
              width: '100%', maxWidth: 440, padding: '12px 16px', fontSize: 14, lineHeight: 1.5,
              color: 'var(--theme-text1)', background: 'color-mix(in srgb, var(--theme-accent) 8%, transparent)',
              border: '1px solid var(--theme-border)',
            }}>
              {keptCarts.map(k => (
                <div key={k.profileId}>
                  Kept for <strong>{k.name}</strong>: {itemsWord(k.units)} not sent on {k.where}. They come back when {k.name} signs in.
                </div>
              ))}
            </div>
          )}
          {loading ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          ) : loadError ? (
            <div style={{ textAlign: 'center', maxWidth: 320 }}>
              <p role="alert" style={{ color: 'var(--theme-red-text)', marginBottom: 14 }}>{loadError}</p>
              <button type="button" className="btn btn-ghost" onClick={() => setRetryToken(t => t + 1)}>
                Try again
              </button>
            </div>
          ) : staff.length === 0 ? (
            <p style={{ color: 'var(--theme-text3)', textAlign: 'center', maxWidth: 300 }}>
              No staff accounts found. Ask your manager to add staff in POS → POS Staff.
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center', maxWidth: 500 }}>
              {staff.map(s => {
                const avatar = avatarColorFor(s.id, isDark)
                return (
                  <button
                    key={s.id}
                    onClick={() => pickStaff(s)}
                    style={{
                      width: 130, minHeight: 128,
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      background: 'var(--theme-card)',
                      border: '1px solid var(--theme-border)',
                      borderRadius: 0,
                      color: 'var(--theme-text1)',
                      fontSize: 14, fontWeight: 600,
                      cursor: 'pointer',
                      padding: '12px 8px 10px',
                      lineHeight: 1.3,
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; e.currentTarget.style.background = 'var(--theme-table-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; e.currentTarget.style.background = 'var(--theme-card)' }}
                  >
                    <div style={{
                      width: 52, height: 52, borderRadius: 0,
                      background: avatar.bg, color: avatar.fg,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 18, fontWeight: 700, letterSpacing: 0.5,
                      marginBottom: 8, flexShrink: 0,
                    }}>
                      {getInitials(s.full_name)}
                    </div>
                    <div style={{
                      textAlign: 'center', width: '100%',
                      overflowWrap: 'break-word', wordBreak: 'break-word',
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                    }}>{s.full_name}</div>
                    {s.pos_job_title && (
                      <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginTop: 3, textAlign: 'center' }}>
                        {s.pos_job_title}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button
              onClick={() => navigate('/login')}
              style={{
                padding: '10px 24px', fontSize: 14,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
                borderRadius: 0, color: 'var(--theme-text2)', cursor: 'pointer',
              }}
            >
              ← Back
            </button>
          </div>
        </div>
      ) : (
        /* ── PIN entry ──────────────────────────────────────────────────── */
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, width: 240 }}>

          {keptForSelected && (
            <p role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--theme-text2)', textAlign: 'center' }}>
              Your {itemsWord(keptForSelected.units)} not sent on {keptForSelected.where} come{keptForSelected.units === 1 ? 's' : ''} back when you sign in.
            </p>
          )}

          {/* PIN dots. The dots are hidden from a screen reader, and the count is announced instead
              (S776): the pad had given no feedback at all to someone who cannot see it fill. */}
          <p className="sr-only" aria-live="polite">
            {pin.length === 0 ? 'No digits entered' : `${pin.length} digit${pin.length === 1 ? '' : 's'} entered`}
          </p>
          <div aria-hidden="true" style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
            {Array.from({ length: pinDots }).map((_, i) => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: 0,
                background: i < pin.length ? 'var(--theme-accent)' : 'var(--theme-border)',
                transition: 'background 0.15s',
                boxShadow: i < pin.length ? '0 0 6px var(--theme-accent)' : 'none',
              }} />
            ))}
          </div>

          {/* Numpad */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 12 }}>
            {KEYS.flat().map((k, i) => (
              <button
                key={i}
                onClick={() => pressKey(k)}
                disabled={!k || signingIn}
                aria-label={k === 'C' ? 'Clear PIN' : k === '⌫' ? 'Delete last digit' : undefined}
                style={{
                  width: 72, height: 72,
                  background: k ? 'var(--theme-card)' : 'transparent',
                  border: k ? '1px solid var(--theme-border)' : 'none',
                  borderRadius: 0,
                  color: k === 'C' ? 'var(--theme-text3)' : 'var(--theme-text1)',
                  fontSize: k === '⌫' ? 20 : k === 'C' ? 15 : 22,
                  fontWeight: k === 'C' ? 600 : 500,
                  letterSpacing: k === 'C' ? '0.04em' : 'normal',
                  cursor: k ? 'pointer' : 'default',
                  transition: 'background 0.12s, transform 0.08s, box-shadow 0.12s',
                  boxShadow: 'none',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                onMouseEnter={e => { if (k) e.currentTarget.style.background = 'var(--theme-table-hover)' }}
                onMouseLeave={e => { if (k) { e.currentTarget.style.background = k ? 'var(--theme-card)' : 'transparent'; e.currentTarget.style.boxShadow = 'none' } }}
                onMouseDown={e => { if (k) { e.currentTarget.style.transform = 'scale(0.92)'; e.currentTarget.style.boxShadow = '0 0 0 4px var(--theme-focus-ring), 0 0 14px var(--theme-accent)' } }}
                onMouseUp={e => { if (k) { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none' } }}
              >
                {k}
              </button>
            ))}
          </div>

          {error && (
            <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 13, textAlign: 'center', margin: 0 }}>
              {error}
            </p>
          )}

          {/* Back + Login row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
            <button
              onClick={back}
              style={{
                width: 108, padding: '13px 0', fontSize: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
                borderRadius: 0, color: 'var(--theme-text2)', cursor: 'pointer',
              }}
            >
              ← Back
            </button>
            <button
              className="btn btn-primary"
              style={{ width: 120, padding: '13px 0', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              disabled={pin.length < 4 || signingIn}
              onClick={handleSignIn}
            >
              {signingIn ? 'Signing in…' : 'Login →'}
            </button>
          </div>
        </div>
      )}
    </div>
    </main>
  )
}
