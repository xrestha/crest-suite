import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { useTheme } from '../../../context/ThemeContext'
import { getInitials, avatarColorFor, relativeLuminance } from '../../../utils/avatarColor'
import { withTimeout } from '../../../utils/withTimeout'

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

  const [staff,     setStaff]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selected,  setSelected]  = useState(null)
  const [pin,       setPin]       = useState('')
  const [error,     setError]     = useState('')
  const [signingIn, setSigningIn] = useState(false)

  const loadStaff = useCallback(async () => {
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
      setLoadError(e.message || 'Could not load the staff list. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!clientId) { navigate('/login', { replace: true }); return }
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
      // Same PIN-brute-force mitigation as PosLogin.jsx — checked before attempting sign-in so an
      // already-locked account doesn't burn a real auth attempt.
      const { data: lockData } = await withTimeout(
        supabase.rpc('check_hr_pin_lock', { p_staff_id: selected.id }), 15000, 'Checking account status'
      )
      if (lockData?.[0]?.locked) {
        setError(`Too many incorrect attempts. Try again ${formatLockRemaining(lockData[0].locked_until)}.`)
        setPin(''); return
      }

      // The actual sign-in now happens server-side (hr-selfservice-login Edge Function) so the
      // browser never has to hold the account's real email — get_hr_self_service_staff above no
      // longer returns it at all. See that function's own comment for the full incident writeup
      // (2026-07-28): the picker's client_id is a link an admin hands out to their whole staff by
      // design, so anything sensitive it returned to an anonymous caller was effectively public.
      const { data: loginData, error: err } = await withTimeout(
        supabase.functions.invoke('hr-selfservice-login', { body: { staff_id: selected.id, pin } }), 15000, 'Signing in'
      )
      const { data: attemptData } = await withTimeout(
        supabase.rpc('record_hr_pin_attempt', { p_staff_id: selected.id, p_success: !err }), 15000, 'Recording attempt'
      )

      if (!err && loginData?.access_token) {
        await withTimeout(
          supabase.auth.setSession({
            access_token: loginData.access_token,
            refresh_token: loginData.refresh_token,
          }), 15000, 'Starting your session'
        )
      }

      if (err || !loginData?.access_token) {
        const afterAttempt = attemptData?.[0]
        setError(afterAttempt?.locked
          ? `Too many incorrect attempts. Try again ${formatLockRemaining(afterAttempt.locked_until)}.`
          : 'Incorrect PIN. Try again.')
        setPin(''); return
      }
      navigate('/hr/self-service', { replace: true })
    } catch (e) {
      setError(e.message || 'Something went wrong. Check your connection and try again.')
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

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--theme-bg)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
    {/* Elevated card wrapper (2026-07-14 audit) — this file's own comment claims "same shape as
        PosLogin.jsx", but the content previously floated bare on the page background instead of
        getting the same .card treatment. */}
    <div className="card" style={{
      padding: '40px 36px', borderRadius: 10,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      width: '100%', maxWidth: 540,
    }}>
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--theme-text1)', letterSpacing: 0.5 }}>Employee Self-Service</div>
        <div style={{ fontSize: selected ? 18 : 14, fontWeight: selected ? 600 : 400, color: selected ? 'var(--theme-text1)' : 'var(--theme-text3)', marginTop: 8 }}>
          {selected ? `Enter PIN for ${selected.full_name}` : 'Who are you?'}
        </div>
      </div>

      {!selected ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
          {loading ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          ) : loadError ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
              <p role="alert" style={{ color: 'var(--theme-red)', textAlign: 'center', maxWidth: 300, margin: 0 }}>{loadError}</p>
              <button className="btn btn-ghost" onClick={loadStaff}>Retry</button>
            </div>
          ) : staff.length === 0 ? (
            <p style={{ color: 'var(--theme-text3)', textAlign: 'center', maxWidth: 300 }}>
              Self-service isn't enabled for anyone yet. Ask HR to enable it for you from Employees.
            </p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center', maxWidth: 500 }}>
              {staff.map(s => {
                const avatar = avatarColorFor(s.id, isDark)
                return (
                  <button
                    key={s.id} onClick={() => pickStaff(s)}
                    style={{
                      width: 130, height: 110, display: 'flex', flexDirection: 'column', alignItems: 'center',
                      background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12,
                      color: 'var(--theme-text1)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
                      padding: '12px 8px 10px', lineHeight: 1.3, transition: 'border-color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; e.currentTarget.style.background = 'var(--theme-table-hover)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; e.currentTarget.style.background = 'var(--theme-card)' }}
                  >
                    <div style={{
                      width: 52, height: 52, borderRadius: '50%', background: avatar.bg, color: avatar.fg,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700,
                      marginBottom: 8, flexShrink: 0,
                    }}>
                      {getInitials(s.full_name)}
                    </div>
                    <div style={{ textAlign: 'center' }}>{s.full_name}</div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, width: 240 }}>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
            {Array.from({ length: pinDots }).map((_, i) => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: '50%',
                background: i < pin.length ? 'var(--theme-accent)' : 'var(--theme-border)',
                transition: 'background 0.15s', boxShadow: i < pin.length ? '0 0 6px var(--theme-accent)' : 'none',
              }} />
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 12 }}>
            {KEYS.flat().map((k, i) => (
              <button
                key={i} onClick={() => pressKey(k)} disabled={!k || signingIn}
                style={{
                  width: 72, height: 72, background: k ? 'var(--theme-card)' : 'transparent',
                  border: k ? '1px solid var(--theme-border)' : 'none', borderRadius: '50%',
                  color: k === 'C' ? 'var(--theme-text3)' : 'var(--theme-text1)',
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

          {error && <p role="alert" style={{ color: 'var(--theme-red)', fontSize: 13, textAlign: 'center', margin: 0 }}>{error}</p>}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
            <button onClick={back} style={{
              width: 108, padding: '13px 0', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 8,
              color: 'var(--theme-text2)', cursor: 'pointer',
            }}>← Back</button>
            <button
              className="btn btn-primary"
              style={{ width: 120, padding: '13px 0', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
