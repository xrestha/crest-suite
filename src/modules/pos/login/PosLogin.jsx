import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'

const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['',  '0', '⌫'],
]

export default function PosLogin() {
  const navigate = useNavigate()
  const clientId   = localStorage.getItem('pos_device_client_id')
  const clientName = localStorage.getItem('pos_device_client_name') || 'Crest POS'

  const [staff,     setStaff]     = useState([])
  const [loading,   setLoading]   = useState(true)
  const [selected,  setSelected]  = useState(null)
  const [pin,       setPin]       = useState('')
  const [error,     setError]     = useState('')
  const [signingIn, setSigningIn] = useState(false)

  useEffect(() => {
    if (!clientId) { navigate('/login', { replace: true }); return }
    supabase.rpc('get_pos_staff', { p_client_id: clientId })
      .then(({ data }) => { setStaff(data || []); setLoading(false) })
  }, [clientId, navigate])

  const pressKey = useCallback((k) => {
    if (k === '⌫') { setPin(p => p.slice(0, -1)); setError(''); return }
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
      else if (e.key === 'Enter')        handleSignIn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, pin, pressKey]) // eslint-disable-line

  async function handleSignIn() {
    if (pin.length < 4 || signingIn) return
    setSigningIn(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({
      email:    selected.pos_email,
      password: pin,
    })
    if (error) {
      setError('Incorrect PIN. Try again.')
      setPin('')
      setSigningIn(false)
      return
    }
    navigate('/pos', { replace: true })
  }

  function pickStaff(s) { setSelected(s); setPin(''); setError('') }
  function back()        { setSelected(null); setPin(''); setError('') }

  function deactivate() {
    localStorage.removeItem('pos_device_client_id')
    localStorage.removeItem('pos_device_client_name')
    navigate('/login', { replace: true })
  }

  const pinDots = Math.max(4, pin.length)

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

      {/* Header */}
      <div style={{ marginBottom: 36, textAlign: 'center' }}>
        <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--theme-text1)', letterSpacing: 0.5 }}>
          {clientName}
        </div>
        <div style={{ fontSize: selected ? 18 : 14, fontWeight: selected ? 600 : 400, color: selected ? 'var(--theme-text1)' : 'var(--theme-text3)', marginTop: 8, letterSpacing: 0.2 }}>
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
              {staff.map(s => (
                <button
                  key={s.id}
                  onClick={() => pickStaff(s)}
                  style={{
                    width: 130, height: 80,
                    background: 'var(--theme-card)',
                    border: '1px solid var(--theme-border)',
                    borderRadius: 12,
                    color: 'var(--theme-text1)',
                    fontSize: 14, fontWeight: 600,
                    cursor: 'pointer',
                    padding: '10px 8px',
                    lineHeight: 1.3,
                    transition: 'border-color 0.15s, background 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--theme-accent)'; e.currentTarget.style.background = 'var(--theme-table-hover)' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--theme-border)'; e.currentTarget.style.background = 'var(--theme-card)' }}
                >
                  {s.full_name}
                </button>
              ))}
            </div>
          )}

          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <a href="/login" style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
              Owner login
            </a>
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
                  color: 'var(--theme-text1)',
                  fontSize: k === '⌫' ? 20 : 22,
                  fontWeight: 500,
                  cursor: k ? 'pointer' : 'default',
                  transition: 'background 0.12s, transform 0.08s',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
                onMouseEnter={e => { if (k) e.currentTarget.style.background = 'var(--theme-table-hover)' }}
                onMouseLeave={e => { if (k) e.currentTarget.style.background = k ? 'var(--theme-card)' : 'transparent' }}
                onMouseDown={e => { if (k) e.currentTarget.style.transform = 'scale(0.92)' }}
                onMouseUp={e => { if (k) e.currentTarget.style.transform = 'scale(1)' }}
              >
                {k}
              </button>
            ))}
          </div>

          {error && (
            <p style={{ color: 'var(--theme-red)', fontSize: 13, textAlign: 'center', margin: 0 }}>
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
  )
}
