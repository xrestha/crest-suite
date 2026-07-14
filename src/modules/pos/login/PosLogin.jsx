import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { useTheme } from '../../../context/ThemeContext'
import { getInitials, avatarColorFor, relativeLuminance } from '../../../utils/avatarColor'

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

  const [staff,     setStaff]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [selected,  setSelected]  = useState(null)
  const [pin,       setPin]       = useState('')
  const [error,     setError]     = useState('')
  const [signingIn, setSigningIn] = useState(false)

  useEffect(() => {
    // No silent bounce — an unactivated device shows its own explanatory screen below
    // instead of instantly redirecting to /login with no indication of why.
    if (!clientId || !deviceSecret) { setLoading(false); return }
    supabase.rpc('get_pos_staff', { p_client_id: clientId, p_device_secret: deviceSecret })
      .then(({ data }) => { setStaff(data || []); setLoading(false) })
  }, [clientId, deviceSecret])

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
    if (pin.length < 4 || signingIn) return
    setSigningIn(true); setError('')

    // The PIN doubles as the full Supabase Auth password, so an app-level lockout is the standard
    // mitigation for its low entropy — see migration 20260707240000_pos_pin_lockout.sql. Checked
    // before attempting sign-in so an already-locked account doesn't burn a real auth attempt.
    const { data: lockData } = await supabase.rpc('check_pos_pin_lock', { p_staff_id: selected.id })
    if (lockData?.[0]?.locked) {
      setError(`Too many incorrect attempts. Try again ${formatLockRemaining(lockData[0].locked_until)}.`)
      setPin('')
      setSigningIn(false)
      return
    }

    const { error } = await supabase.auth.signInWithPassword({
      email:    selected.pos_email,
      password: pin,
    })
    const { data: attemptData } = await supabase.rpc('record_pos_pin_attempt', {
      p_staff_id: selected.id, p_success: !error,
    })

    if (error) {
      const afterAttempt = attemptData?.[0]
      setError(afterAttempt?.locked
        ? `Too many incorrect attempts. Try again ${formatLockRemaining(afterAttempt.locked_until)}.`
        : 'Incorrect PIN. Try again.')
      setPin('')
      setSigningIn(false)
      return
    }
    navigate('/pos', { replace: true })
  }

  function formatLockRemaining(lockedUntil) {
    const mins = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000))
    return `in ${mins} minute${mins !== 1 ? 's' : ''}`
  }

  function pickStaff(s) { setSelected(s); setPin(''); setError('') }
  function back()        { setSelected(null); setPin(''); setError('') }

const pinDots = Math.max(4, pin.length)

  // Device not yet activated for any client — explain why, instead of silently bouncing
  // to /login. Activation itself happens from Crest POS (/pos) by an owner/manager.
  // Also catches a device activated before device-secret verification was introduced — its
  // stored client_id is still present but there's no secret to authorize get_pos_staff with,
  // so it needs a one-time re-activation rather than silently showing "no staff found".
  if (!clientId || !deviceSecret) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--theme-bg)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div className="card" style={{ padding: 32, maxWidth: 380, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📱</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 8 }}>
            This device isn't set up yet
          </div>
          <p style={{ fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6, marginBottom: 24 }}>
            Staff PIN login only works on a device an owner or manager has activated first.
            Log in with your owner account, open <strong>Crest POS</strong>, and click
            <strong> Activate</strong> — then this screen will show your staff.
          </p>
          <button className="btn btn-primary" onClick={() => navigate('/login')}>
            Owner Login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--theme-bg)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
    <div className="card" style={{
      padding: '40px 36px', borderRadius: 10,
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      width: '100%', maxWidth: 540,
    }}>

      {/* Header — Georgia serif is reserved for exactly two places in this product: the
          sidebar wordmark and this login screen (DESIGN.md §3, The One Serif Rule). */}
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'Georgia, serif', letterSpacing: '0.02em', color: 'var(--theme-text1)', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
          {clientName}
        </div>
        <div style={{ fontSize: selected ? 18 : 14, fontWeight: selected ? 600 : 400, color: selected ? 'var(--theme-text1)' : 'var(--theme-text3)', marginTop: 10, letterSpacing: 0.2 }}>
          {selected ? `Enter PIN for ${selected.full_name}` : 'Who are you?'}
        </div>
      </div>

      {!selected ? (
        /* ── Staff grid ─────────────────────────────────────────────────── */
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 32 }}>
          {loading ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
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
                      borderRadius: 12,
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
                      width: 52, height: 52, borderRadius: '50%',
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
                borderRadius: 8, color: 'var(--theme-text2)', cursor: 'pointer',
              }}
            >
              ← Back
            </button>
          </div>
        </div>
      ) : (
        /* ── PIN entry ──────────────────────────────────────────────────── */
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, width: 240 }}>

          {/* PIN dots */}
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center' }}>
            {Array.from({ length: pinDots }).map((_, i) => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: '50%',
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
                style={{
                  width: 72, height: 72,
                  background: k ? 'var(--theme-card)' : 'transparent',
                  border: k ? '1px solid var(--theme-border)' : 'none',
                  borderRadius: '50%',
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
            <p role="alert" style={{ color: 'var(--theme-red)', fontSize: 13, textAlign: 'center', margin: 0 }}>
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
                borderRadius: 8, color: 'var(--theme-text2)', cursor: 'pointer',
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
    </div>
  )
}
