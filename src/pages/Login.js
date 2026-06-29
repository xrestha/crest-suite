import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import './Login.css'

// All auth-admin operations go through the Edge Function — service role stays server-side
async function edgeOp(action, params = {}) {
  const { data, error } = await supabase.functions.invoke('admin-user-ops', {
    body: { action, ...params },
  })
  if (error) {
    let detail = error.message || 'Error'
    try { const b = await error.context.json(); detail = b?.error?.message || b?.error || b?.message || detail } catch (_) {}
    throw new Error(detail)
  }
  if (data?.error) throw new Error(data.error.message || data.error || 'Failed')
  return data
}

export default function Login() {
  const location  = useLocation()
  const isTrial   = new URLSearchParams(location.search).get('trial') === '1'

  const [tab, setTab]               = useState(isTrial ? 'trial' : 'signin')

  // Sign-in state
  const [email, setEmail]           = useState('')
  const [password, setPassword]     = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError]           = useState('')
  const [loading, setLoading]       = useState(false)

  // Trial signup state
  const [tBiz, setTBiz]             = useState('')
  const [tName, setTName]           = useState('')
  const [tPhone, setTPhone]         = useState('')
  const [tEmail, setTEmail]         = useState('')
  const [tPass, setTPass]           = useState('')
  const [tShowPass, setTShowPass]   = useState(false)
  const [tError, setTError]         = useState('')
  const [tLoading, setTLoading]     = useState(false)

  const { signIn } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()

  async function handleSignIn(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) {
      setError('Invalid email or password.')
      setLoading(false)
    } else {
      navigate('/dashboard')
    }
  }

  async function handleTrialSignup(e) {
    e.preventDefault()
    setTError('')
    if (!tBiz.trim()) { setTError('Business name is required.'); return }
    if (!tPhone.trim()) { setTError('Phone number is required.'); return }
    if (!tEmail.trim()) { setTError('Email is required.'); return }
    if (tPass.length < 6) { setTError('Password must be at least 6 characters.'); return }
    setTLoading(true)
    try {
      await edgeOp('register_trial', {
        business_name: tBiz.trim(),
        full_name:     tName.trim() || tBiz.trim(),
        phone:         tPhone.trim(),
        email:         tEmail.trim().toLowerCase(),
        password:      tPass,
      })
      // Auto sign in after account creation
      const { error: signInErr } = await signIn(tEmail.trim().toLowerCase(), tPass)
      if (signInErr) {
        setTError('Account created — please sign in.')
        setTab('signin')
        setEmail(tEmail.trim().toLowerCase())
      } else {
        navigate('/dashboard')
      }
    } catch (err) {
      setTError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setTLoading(false)
    }
  }

  return (
    <div className="login-root">
      <div className="login-card" style={{ maxWidth: tab === 'trial' ? 420 : 360 }}>
        <div className="login-brand">
          <span aria-label="Crest" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, fontSize: 34, lineHeight: 1, color: 'var(--theme-accent)' }}>⬢</span>
          <span className="login-brand-name">{settings?.app_name || 'Crest'}</span>
          <span className="login-brand-sub">Inventory</span>
        </div>

        {/* Tab switcher — always rendered; trial tab is reachable from the CTA banner */}
        {tab === 'trial' && (
          <div style={{ display: 'flex', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: 3, gap: 3, marginBottom: 24 }}>
            <button
              onClick={() => setTab('trial')}
              style={{ flex: 1, padding: '8px 0', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                background: 'var(--theme-accent)',
                color: 'var(--theme-bg)' }}>
              Start Free Trial
            </button>
            <button
              onClick={() => setTab('signin')}
              style={{ flex: 1, padding: '8px 0', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                background: 'transparent',
                color: 'var(--theme-text2)' }}>
              Sign In
            </button>
          </div>
        )}

        {/* ── Trial signup form ── */}
        {tab === 'trial' ? (
          <>
            <div style={{ marginBottom: 20, padding: '12px 14px', background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-green)', marginBottom: 3 }}>7-day free trial · Starter plan</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>Full access. No credit card needed. After 7 days your account is deactivated and your data is retained for 15 days while you decide.</div>
            </div>
            <form onSubmit={handleTrialSignup} className="login-form">
              <div className="login-field">
                <label>Business Name *</label>
                <input value={tBiz} onChange={e => setTBiz(e.target.value)} placeholder="e.g. Sunrise Café" required autoFocus />
              </div>
              <div className="login-field">
                <label>Your Name <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>(optional)</span></label>
                <input value={tName} onChange={e => setTName(e.target.value)} placeholder="e.g. Ramesh Shrestha" />
              </div>
              <div className="login-field">
                <label>Phone *</label>
                <input type="tel" value={tPhone} onChange={e => setTPhone(e.target.value)} placeholder="e.g. 98XXXXXXXX" required />
              </div>
              <div className="login-field">
                <label>Email *</label>
                <input type="email" value={tEmail} onChange={e => setTEmail(e.target.value)} placeholder="you@restaurant.com" required />
              </div>
              <div className="login-field">
                <label>Password *</label>
                <input
                  type={tShowPass ? 'text' : 'password'}
                  value={tPass} onChange={e => setTPass(e.target.value)}
                  placeholder="Min. 6 characters" required />
                <label className="login-show-pw">
                  <input type="checkbox" checked={tShowPass} onChange={e => setTShowPass(e.target.checked)} />
                  Show password
                </label>
              </div>
              {tError && <p className="login-error">{tError}</p>}
              <button type="submit" className="login-btn" disabled={tLoading}>
                {tLoading ? 'Creating your account…' : 'Start Free Trial →'}
              </button>
            </form>
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', textAlign: 'center', marginTop: 14, lineHeight: 1.6 }}>
              Already have an account?{' '}
              <button onClick={() => setTab('signin')} style={{ background: 'none', border: 'none', color: 'var(--theme-accent)', cursor: 'pointer', fontSize: 11, padding: 0 }}>Sign in →</button>
            </p>
          </>
        ) : (
          /* ── Sign-in form ── */
          <>
            {!isTrial && (
              <>
                <h1 className="login-heading">Sign in</h1>
                <p className="login-sub">{settings?.app_tagline || 'Hospitality cost control, built for Nepal.'}</p>
              </>
            )}
            <form onSubmit={handleSignIn} className="login-form">
              <div className="login-field">
                <label>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@restaurant.com" required autoFocus />
              </div>
              <div className="login-field">
                <label>Password</label>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••" required />
                <label className="login-show-pw">
                  <input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} />
                  Show password
                </label>
              </div>
              {error && <p className="login-error">{error}</p>}
              <button type="submit" className="login-btn" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
            {!isTrial && (
              <div
                onClick={() => setTab('trial')}
                style={{ marginTop: 16, padding: '12px 16px', background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-green)' }}>New to Crest?</div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>Start your 7-day free trial — no credit card needed.</div>
                </div>
                <span style={{ fontSize: 18, color: 'var(--theme-green)', flexShrink: 0 }}>→</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
