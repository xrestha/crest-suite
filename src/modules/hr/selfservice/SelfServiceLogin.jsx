import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { useTheme } from '../../../context/ThemeContext'
import { getInitials, avatarColorFor, relativeLuminance } from '../../../utils/avatarColor'
import { withTimeout } from '../../../utils/withTimeout'
import { useStaffAppManifest } from './useStaffApp'
import { employeeErrorText } from './employeeError'
import { rememberStaffClient } from './staffClient'
import './selfService.css'

// A link is only ever this shape; anything else was cut off or mistyped on the way to the phone.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Past this many names the picker gets a search box — a waiter should not scroll a wall of tiles.
const SEARCH_FROM = 9
const KEY_LABEL = { C: 'Clear PIN', '⌫': 'Delete last digit' }

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['C', '0', '⌫'],
]

// Public, unauthenticated PIN login for HR Employee Self-Service — same shape as PosLogin.jsx,
// but the client is identified by a URL param (the admin shares one link/QR per company with
// their employees) rather than a "device activation" step, since employees log in from their
// own phones, not a shared terminal that stays bound to one client.
export default function SelfServiceLogin() {
  const { clientId } = useParams()
  const navigate = useNavigate()
  const { colors } = useTheme()
  const isDark = relativeLuminance(colors.bg) < 0.5
  useStaffAppManifest(colors.bg)
  const linkOk = UUID_RE.test(clientId || '')

  const [staff,     setStaff]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selected,  setSelected]  = useState(null)
  const [pin,       setPin]       = useState('')
  const [error,     setError]     = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [query,     setQuery]     = useState('')

  const loadStaff = useCallback(async () => {
    // A malformed link never reaches the server: the database's answer was a raw
    // "invalid input syntax for type uuid" in red, with a Retry that could never succeed (S768).
    if (!UUID_RE.test(clientId || '')) { setLoading(false); return }
    setLoading(true); setLoadError('')
    try {
      const { data, error: err } = await withTimeout(
        supabase.rpc('get_hr_self_service_staff', { p_client_id: clientId }), 15000, 'Loading staff list'
      )
      if (err) throw err
      setStaff(data || [])
    } catch (e) {
      // Same hang-forever risk as handleSignIn below, one screen earlier — without this, a stalled
      // request left this page stuck on "Loading…" with no error and no way to retry.
      // The employee wording of the shared error table (S768) — this used to show e.message, so a
      // dropped connection read "TypeError: Failed to fetch" on the one screen staff meet first.
      setLoadError(employeeErrorText(e))
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!clientId) { navigate('/login', { replace: true }); return }
    // The link an employee is sent carries their company; the installed app's start_url cannot.
    // Remembering it here is what lets the home-screen icon open on this PIN pad instead of the
    // admin sign-in page nobody here has a password for.
    if (UUID_RE.test(clientId)) rememberStaffClient(clientId)
    loadStaff()
  }, [clientId, navigate, loadStaff])

  const pressKey = useCallback((k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); setError(''); return }
    if (k === 'C') { setPin(''); setError(''); return }
    if (!k) return
    setPin(p => p.length < 6 ? p + k : p)
    setError('')
  }, [])

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
    if (pin.length < 4 || signingIn) return
    setSigningIn(true); setError('')

    // Every network call here is wrapped in withTimeout — a plain await on a Supabase call (RPC,
    // Edge Function, or auth) can hang forever on a flaky connection (getSession()'s known
    // GoTrue stall, or just a dropped mobile request), which otherwise leaves the button stuck on
    // "Signing in..." with no error and no way to retry (found live, 2026-07-28, on two different
    // employees' phones — one on weak wifi, one on 4G). See withTimeout.js for the full mechanism.
    try {
      // Sign-in AND the PIN lockout both live server-side now (hr-selfservice-login). This used to
      // call check_hr_pin_lock before and record_hr_pin_attempt after, which meant the lockout was
      // only ever as real as the browser chose to make it — skipping those two RPCs and calling the
      // Edge Function directly walked a 4-digit PIN unimpeded, and every input needed to do that
      // (staff_id from the anon-callable picker, client_id from the QR link handed to all staff) is
      // public by design. See that function's comment for the full writeup. Calling
      // record_hr_pin_attempt from here as well would now double-count, locking a fat-fingered
      // employee out after 3 real attempts instead of 5.
      const { data: loginData, error: err } = await withTimeout(
        supabase.functions.invoke('hr-selfservice-login', { body: { staff_id: selected.id, pin } }), 15000, 'Signing in'
      )

      if (err || !loginData?.access_token) {
        // A locked/incorrect PIN comes back as a non-2xx, so supabase-js puts the body on
        // error.context rather than in `data` — same unwrap the shared invokeEdge() helper does.
        let lockedUntil = null
        try { const b = await err?.context?.json(); lockedUntil = b?.locked ? b.locked_until : null } catch (_) { /* keep the generic message */ }
        // Same wording as PosLogin.jsx on purpose — one lockout message across the product. The
        // employee doesn't need to know the mechanism differs (there is no reset_hr_pin action;
        // Self-Service is re-enrolled rather than reset), only who to ask.
        setError(lockedUntil
          ? `Too many incorrect attempts. Try again ${formatLockRemaining(lockedUntil)}, or ask your manager to reset your PIN.`
          : 'Incorrect PIN. Try again.')
        setPin(''); return
      }

      await withTimeout(
        supabase.auth.setSession({
          access_token: loginData.access_token,
          refresh_token: loginData.refresh_token,
        }), 15000, 'Starting your session'
      )
      navigate('/hr/self-service', { replace: true })
    } catch (e) {
      setError(employeeErrorText(e))
      setPin('')
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
  const q = query.trim().toLowerCase()
  const shownStaff = q ? staff.filter(s => (s.full_name || '').toLowerCase().includes(q)) : staff

  return (
    <div className="self-service ss-login" style={{
      minHeight: '100dvh', background: 'var(--theme-bg)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 'calc(24px + env(safe-area-inset-top)) 24px calc(24px + env(safe-area-inset-bottom))',
    }}>
    {/* Elevated card wrapper (2026-07-14 audit) — this file's own comment claims "same shape as
        PosLogin.jsx", but the content previously floated bare on the page background instead of
        getting the same .card treatment. */}
    <div className="card ss-login-card" style={{
      borderRadius: 0,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      width: '100%', maxWidth: 540,
    }}>
      <div style={{ marginBottom: 28, textAlign: 'center' }}>
        {/* The app's own name — the one on the phone's home screen — and the page's only h1. */}
        <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--theme-text1)', letterSpacing: 0.5, margin: 0 }}>Crest Staff</h1>
        <div style={{ fontSize: selected ? 18 : 15, fontWeight: 600, color: selected ? 'var(--theme-text1)' : 'var(--theme-text2)', marginTop: 8 }}>
          {selected ? `Enter PIN for ${selected.full_name}` : 'Who are you?'}
        </div>
      </div>

      {!selected ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32, width: '100%' }}>
          {!linkOk ? (
            <p role="alert" style={{ color: 'var(--theme-text1)', textAlign: 'center', maxWidth: 320, margin: 0, lineHeight: 1.6 }}>
              This link isn't complete. Ask your manager to send the Crest Staff link or QR code again.
            </p>
          ) : loading ? (
            <p style={{ color: 'var(--theme-text2)' }}>Loading…</p>
          ) : loadError ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
              <p role="alert" style={{ color: 'var(--theme-red-text)', textAlign: 'center', maxWidth: 300, margin: 0 }}>{loadError}</p>
              <button className="btn btn-ghost" onClick={loadStaff}>Retry</button>
            </div>
          ) : staff.length === 0 ? (
            // An unknown restaurant and a restaurant with no Crest Staff logins answer identically here,
            // so the sentence covers both rather than blaming the manager for a mistyped link.
            <p style={{ color: 'var(--theme-text2)', textAlign: 'center', maxWidth: 320, lineHeight: 1.6, margin: 0 }}>
              Nobody can sign in with this link yet. Your manager may not have turned Crest Staff on for you — or this link is for a different restaurant. Ask them for your link.
            </p>
          ) : (
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {staff.length >= SEARCH_FROM && (
              <input type="search" className="form-input" aria-label="Find your name" placeholder="Find your name"
                autoComplete="off" value={query} onChange={e => setQuery(e.target.value)} />
            )}
            {shownStaff.length === 0 && <p style={{ margin: 0, textAlign: 'center', color: 'var(--theme-text2)' }}>No name matches "{query}".</p>}
            <div className="ss-staff-grid">
              {shownStaff.map(s => {
                const avatar = avatarColorFor(s.id, isDark)
                return (
                  <button
                    key={s.id} type="button" onClick={() => pickStaff(s)}
                    style={{
                      minHeight: 110, display: 'flex', flexDirection: 'column', alignItems: 'center',
                      background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 0,
                      color: 'var(--theme-text1)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                      padding: '12px 8px 10px', lineHeight: 1.3, transition: 'border-color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; e.currentTarget.style.background = 'var(--theme-table-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; e.currentTarget.style.background = 'var(--theme-card)' }}
                  >
                    <div style={{
                      width: 52, height: 52, borderRadius: 0, background: avatar.bg, color: avatar.fg,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700,
                      marginBottom: 8, flexShrink: 0,
                    }}>
                      {getInitials(s.full_name)}
                    </div>
                    <div style={{ textAlign: 'center', overflowWrap: 'anywhere' }}>{s.full_name}</div>
                  </button>
                )
              })}
            </div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, width: 240 }}>
          {/* Empty dots are an outline in the secondary ink (they measured 1.36:1 as a border-grey fill,
              under the 3:1 a meaningful graphic needs); filled ones take the accent. The count is also
              spoken, because a screen reader otherwise hears nothing as digits go in (S768). */}
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }} aria-hidden="true">
            {Array.from({ length: pinDots }).map((_, i) => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: 0, boxSizing: 'border-box',
                background: i < pin.length ? 'var(--theme-accent)' : 'transparent',
                border: `2px solid ${i < pin.length ? 'var(--theme-accent)' : 'var(--theme-text2)'}`,
              }} />
            ))}
          </div>
          <div className="sr-only" aria-live="polite">{pin.length === 0 ? 'No digits entered' : `${pin.length} digit${pin.length === 1 ? '' : 's'} entered`}</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 12 }}>
            {KEYS.flat().map((k, i) => (
              <button
                key={i} type="button" onClick={() => pressKey(k)} disabled={!k || signingIn}
                aria-label={KEY_LABEL[k]}
                style={{
                  width: 72, height: 72, background: k ? 'var(--theme-card)' : 'transparent',
                  border: k ? '1px solid var(--theme-border)' : 'none', borderRadius: 0,
                  color: k === 'C' ? 'var(--theme-text2)' : 'var(--theme-text1)',
                  fontSize: k === '⌫' ? 20 : k === 'C' ? 15 : 22,
                  fontWeight: k === 'C' ? 600 : 500,
                  letterSpacing: k === 'C' ? '0.04em' : 'normal',
                  cursor: k ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {k}
              </button>
            ))}
          </div>

          {error && <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 13, textAlign: 'center', margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
            <button type="button" className="btn btn-ghost" onClick={back} style={{ flex: 1, justifyContent: 'center' }}>← Back</button>
            <button
              type="button" className="btn btn-primary"
              style={{ flex: 1, justifyContent: 'center' }}
              disabled={pin.length < 4 || signingIn} onClick={handleSignIn}
            >
              {signingIn ? 'Signing in…' : 'Login →'}
            </button>
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
