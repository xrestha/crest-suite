import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { useTheme } from '../../../context/ThemeContext'
import { errorText } from '../../../shared/errorText'
import { getInitials, avatarColorFor, relativeLuminance } from '../../../utils/avatarColor'
import { IMS_COUNT_HOME } from '../../../shared/imsCountAccess'

// The stock-count tablet's front door (S737). Structural mirror of PosLogin.jsx — same roster, same
// keypad, same server-side sign-in — with one deliberate difference: enrolment.
//
// POS activates a device by pressing a button ON that device while signed in as a manager. A store
// room tablet has no such session, so the manager displays a QR from Stock Count → Settings and the
// tablet scans it. The QR carries a SHORT-LIVED TOKEN, never the device secret: it is shown in a
// room with people in it. redeem_ims_enrol_token exchanges one for the secret, server-side.

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['C', '0', '⌫'],
]

const LS_CLIENT = 'ims_count_client_id'
const LS_NAME   = 'ims_count_client_name'
const LS_SECRET = 'ims_count_device_secret'

function readStored(key) {
  try { return localStorage.getItem(key) } catch (_) { return null }
}

export default function ImsCountLogin() {
  const navigate = useNavigate()
  const { colors } = useTheme()
  const isDark = relativeLuminance(colors.bg) < 0.5

  const [device, setDevice] = useState(() => ({
    clientId: readStored(LS_CLIENT),
    clientName: readStored(LS_NAME) || 'Crest Stock Count',
    secret: readStored(LS_SECRET),
  }))

  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const [signingIn, setSigningIn] = useState(false)

  // ── Enrolment: a scanned QR lands here with #e=<token> ────────────────────────────────────
  useEffect(() => {
    const token = (window.location.hash || '').match(/[#&]e=([A-Za-z0-9]+)/)?.[1]
    if (!token) return
    // Strip it immediately, whatever happens next: a token sitting in the address bar of a shared
    // tablet is the one thing this design exists to avoid handing around.
    window.history.replaceState(null, '', window.location.pathname)
    setEnrolling(true)
    supabase.rpc('redeem_ims_enrol_token', { p_token: token })
      .then(({ data, error: rpcErr }) => {
        const row = Array.isArray(data) ? data[0] : data
        if (rpcErr || !row?.device_secret) {
          // A refusal and an expiry are the same response by design — the token is the whole
          // authorisation, so the page must not become an oracle for which tokens exist.
          setLoadError('That setup code has expired or is not valid any more. Ask your manager to show the code again.')
          setEnrolling(false)
          return
        }
        try {
          localStorage.setItem(LS_CLIENT, row.client_id)
          localStorage.setItem(LS_NAME, row.client_name || 'Crest Stock Count')
          localStorage.setItem(LS_SECRET, row.device_secret)
        } catch (_) {
          // Private browsing, or storage refused. The roster still loads for this visit; it simply
          // will not be remembered, which is worth saying rather than silently failing next time.
          setLoadError('This device cannot remember the setup (private browsing may be on), so the code will be needed again next time.')
        }
        setDevice({ clientId: row.client_id, clientName: row.client_name || 'Crest Stock Count', secret: row.device_secret })
        setEnrolling(false)
        setRetryToken(t => t + 1)
      })
  }, [])

  // ── The roster ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!device.clientId || !device.secret) { setLoading(false); return }
    setLoadError('')
    setLoading(true)
    supabase.rpc('get_ims_count_staff', { p_client_id: device.clientId, p_device_secret: device.secret })
      .then(({ data, error: rpcErr }) => {
        // A failed read is not an empty roster. Telling a counter "ask your manager to add staff"
        // when the connection dropped sends them to the wrong person to fix a problem that is not
        // theirs — the fix PosLogin already carries.
        if (rpcErr) setLoadError("Couldn't reach the server. Check this device's connection and try again.")
        else setStaff(data || [])
        setLoading(false)
      })
  }, [device.clientId, device.secret, retryToken])

  const pressKey = useCallback((k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); setError(''); return }
    if (k === 'C') { setPin(''); setError(''); return }
    if (!k) return
    setPin(p => (p.length < 6 ? p + k : p))
    setError('')
  }, [])

  async function handleSignIn() {
    if (pin.length < 4 || signingIn) return
    setSigningIn(true)
    setError('')
    try {
      // Sign-in and the lockout both run inside the Edge Function. The PIN is not the password —
      // the stored value is HMAC(pepper, email:pin) — so there is no credential here to brute
      // force against GoTrue directly, and every path to a session enforces the lockout.
      const { data, error: err } = await supabase.functions.invoke('ims-staff-login', {
        body: { client_id: device.clientId, device_secret: device.secret, staff_id: selected.id, pin },
      })

      if (err || !data?.access_token) {
        let lockedUntil = null
        try { const b = await err?.context?.json(); lockedUntil = b?.locked ? b.locked_until : null } catch (_) { /* generic message */ }
        setError(lockedUntil
          ? `Too many incorrect attempts. Try again ${formatLockRemaining(lockedUntil)}, or ask your manager to reset your PIN.`
          : 'Incorrect PIN. Try again.')
        setPin('')
        return
      }

      await supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      })
      navigate(IMS_COUNT_HOME, { replace: true })
    } catch (e) {
      // The staff audience: a counter can only escalate, and a raw fetch error is not a sentence
      // they can act on.
      setError(errorText(e, 'staff'))
      setPin('')
    } finally {
      setSigningIn(false)
    }
  }

  function formatLockRemaining(lockedUntil) {
    const mins = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000))
    return `in ${mins} minute${mins !== 1 ? 's' : ''}`
  }

  useEffect(() => {
    if (!selected) return
    function onKey(e) {
      if (e.key >= '0' && e.key <= '9') pressKey(e.key)
      else if (e.key === 'Backspace') pressKey('⌫')
      else if (e.key === 'Escape') pressKey('C')
      else if (e.key === 'Enter') handleSignIn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, pin, pressKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const pinDots = Math.max(4, pin.length)

  // Not set up yet — explain, rather than bouncing to /login with no indication of why.
  if (!enrolling && (!device.clientId || !device.secret)) {
    return (
      <div style={{ minHeight: '100dvh', background: 'var(--theme-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <div className="card" style={{ padding: 32, maxWidth: 380, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 8 }}>
            This device isn't set up yet
          </div>
          <p style={{ fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6, marginBottom: 24 }}>
            Ask your manager to open <strong>Stock Count → Settings</strong> and show the setup code,
            then scan it with this device's camera.
          </p>
          {loadError && <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 13, marginBottom: 16 }}>{loadError}</p>}
          <button className="btn btn-ghost" onClick={() => navigate('/login')}>Sign in with an email instead</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--theme-bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div className="card" style={{ padding: '40px 36px', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: 540 }}>

        <div style={{ marginBottom: 36, textAlign: 'center' }}>
          <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'Georgia, serif', letterSpacing: '0.02em', color: 'var(--theme-text1)', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
            {device.clientName}
          </div>
          <div style={{ fontSize: selected ? 18 : 14, fontWeight: selected ? 600 : 400, color: selected ? 'var(--theme-text1)' : 'var(--theme-text3)', marginTop: 10, letterSpacing: 0.2 }}>
            {selected ? `Enter PIN for ${selected.full_name}` : 'Stock count — who are you?'}
          </div>
        </div>

        {!selected ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
            {enrolling || loading ? (
              <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
            ) : loadError ? (
              <div style={{ textAlign: 'center', maxWidth: 320 }}>
                <p role="alert" style={{ color: 'var(--theme-red-text)', marginBottom: 14 }}>{loadError}</p>
                <button type="button" className="btn btn-ghost" onClick={() => setRetryToken(t => t + 1)}>Try again</button>
              </div>
            ) : staff.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', textAlign: 'center', maxWidth: 320 }}>
                No counting PINs have been set up yet. Ask your manager to add them in IMS → IMS Staff.
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center', maxWidth: 500 }}>
                {staff.map(s => {
                  const avatar = avatarColorFor(s.id, isDark)
                  return (
                    <button
                      key={s.id}
                      onClick={() => { setSelected(s); setPin(''); setError('') }}
                      style={{
                        width: 130, minHeight: 128,
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
                        color: 'var(--theme-text1)', fontSize: 14, fontWeight: 600,
                        cursor: 'pointer', padding: '12px 8px 10px', lineHeight: 1.3,
                      }}
                    >
                      <span style={{
                        width: 52, height: 52, borderRadius: 'var(--radius-full)',
                        background: avatar.bg, color: avatar.fg,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 18, fontWeight: 700, marginBottom: 10,
                      }}>
                        {getInitials(s.full_name)}
                      </span>
                      <span style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>{s.full_name}</span>
                      {s.ims_job_title && (
                        <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginTop: 4 }}>{s.ims_job_title}</span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, width: '100%' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              {Array.from({ length: pinDots }).map((_, i) => (
                <span key={i} style={{
                  width: 14, height: 14, borderRadius: 'var(--radius-full)',
                  background: i < pin.length ? 'var(--theme-accent)' : 'transparent',
                  border: '1px solid var(--theme-border)',
                }} />
              ))}
            </div>

            {error && <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 13, textAlign: 'center', margin: 0, maxWidth: 320 }}>{error}</p>}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 12 }}>
              {KEYS.flat().map(k => (
                <button
                  key={k}
                  onClick={() => pressKey(k)}
                  style={{
                    height: 64, fontSize: 20, fontWeight: 600,
                    background: 'var(--theme-card)', border: '1px solid var(--theme-border)',
                    color: 'var(--theme-text1)', cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {k}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => { setSelected(null); setPin(''); setError('') }}>Back</button>
              <button className="btn btn-primary" onClick={handleSignIn} disabled={pin.length < 4 || signingIn}>
                {signingIn ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
