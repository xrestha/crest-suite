import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import './Login.css'

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

const HIGHLIGHTS = [
  { icon: '📊', text: 'Recipe FC% recalculates on every purchase — always see your real food cost' },
  { icon: '📦', text: 'Track stock & catch variance before it hurts' },
  { icon: '📅', text: 'Bikram Sambat calendar · Supplier tracking · Payables aging' },
  { icon: '📈', text: 'Menu engineering, reports & food cost trends' },
]

export default function Login() {
  const location = useLocation()
  const startOnTrial = new URLSearchParams(location.search).get('trial') === '1'

  // Sign-in state
  const [email, setEmail]               = useState('')
  const [password, setPassword]         = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError]               = useState('')
  const [loading, setLoading]           = useState(false)

  // Trial signup state
  const [tBiz, setTBiz]         = useState('')
  const [tName, setTName]       = useState('')
  const [tPhone, setTPhone]     = useState('')
  const [tEmail, setTEmail]     = useState('')
  const [tPass, setTPass]       = useState('')
  const [tShowPass, setTShowPass] = useState(false)
  const [tError, setTError]     = useState('')
  const [tLoading, setTLoading] = useState(false)
  const [trialSuccess, setTrialSuccess] = useState(false)

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
    if (!tBiz.trim())    { setTError('Business name is required.'); return }
    if (!tPhone.trim())  { setTError('Phone number is required.'); return }
    if (!tEmail.trim())  { setTError('Email is required.'); return }
    if (tPass.length < 6){ setTError('Password must be at least 6 characters.'); return }
    setTLoading(true)
    try {
      await edgeOp('register_trial', {
        business_name: tBiz.trim(),
        full_name:     tName.trim() || tBiz.trim(),
        phone:         tPhone.trim(),
        email:         tEmail.trim().toLowerCase(),
        password:      tPass,
      })
      const { error: signInErr } = await signIn(tEmail.trim().toLowerCase(), tPass)
      if (signInErr) {
        setTrialSuccess(true)
        setEmail(tEmail.trim().toLowerCase())
      } else {
        navigate('/dashboard')
      }
    } catch (err) {
      const msg = err.message || 'Something went wrong. Please try again.'
      const isAlreadyRegistered = msg.includes('already exists') || msg.includes('already registered') || msg.includes('profiles_pkey')
      setTError(isAlreadyRegistered
        ? 'An account with this email already exists. Use the sign-in form above.'
        : msg)
    } finally {
      setTLoading(false)
    }
  }

  return (
    <div className="login-root">
      <div className="login-split">

        {/* ── Left: Trial signup ── */}
        <div className="login-left">
          <div className="login-brand" style={{ justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{ fontSize: 30, color: 'var(--theme-accent)', lineHeight: 1 }}>⬢</span>
              <span className="login-brand-name">{settings?.app_name || 'Crest Inventory'}</span>
            </div>
            <button
              onClick={() => navigate('/pricing')}
              className="login-btn login-btn--trial"
              style={{ padding: '7px 16px', fontSize: 12, marginTop: 0 }}>
              View Pricing →
            </button>
          </div>

          <div className="login-pitch">
            <div className="login-pitch-headline">Smarter menus. Better margins.</div>
            <div className="login-pitch-sub">Built for Nepal's F&amp;B industry.</div>
          </div>

          <ul className="login-highlights">
            {HIGHLIGHTS.map((h, i) => (
              <li key={i}>
                <span className="login-highlight-icon">{h.icon}</span>
                <span>{h.text}</span>
              </li>
            ))}
          </ul>

          <div className="login-divider-label">Start your free trial</div>

          {trialSuccess ? (
            <div style={{ padding: '16px', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: 8, fontSize: 13, color: 'var(--theme-green)', lineHeight: 1.6 }}>
              Account created! Sign in on the right with your email and password.
            </div>
          ) : (
            <form onSubmit={handleTrialSignup} className="login-form">
              <div className="login-field">
                <label>Business Name *</label>
                <input value={tBiz} onChange={e => setTBiz(e.target.value)} placeholder="e.g. Sunrise Café" autoFocus={startOnTrial} />
              </div>
              <div className="login-2col">
                <div className="login-field">
                  <label>Your Name <span className="login-optional">(optional)</span></label>
                  <input value={tName} onChange={e => setTName(e.target.value)} placeholder="e.g. Ramesh Shrestha" />
                </div>
                <div className="login-field">
                  <label>Phone *</label>
                  <input type="tel" value={tPhone} onChange={e => setTPhone(e.target.value)} placeholder="98XXXXXXXX" />
                </div>
              </div>
              <div className="login-2col">
                <div className="login-field">
                  <label>Email *</label>
                  <input type="email" value={tEmail} onChange={e => setTEmail(e.target.value)} placeholder="you@restaurant.com" />
                </div>
                <div className="login-field">
                  <label>Password *</label>
                  <input type={tShowPass ? 'text' : 'password'} value={tPass} onChange={e => setTPass(e.target.value)} placeholder="Min. 6 characters" />
                </div>
              </div>
              <label className="login-show-pw">
                <input type="checkbox" checked={tShowPass} onChange={e => setTShowPass(e.target.checked)} />
                Show password
              </label>
              {tError && <p className="login-error">{tError}</p>}
              <button type="submit" className="login-btn login-btn--trial" disabled={tLoading}>
                {tLoading ? 'Creating your account…' : 'Start Free Trial →'}
              </button>
              <p className="login-trial-note">7-day free trial · Starter plan · No credit card needed</p>
            </form>
          )}
        </div>

        {/* ── Divider ── */}
        <div className="login-vdivider" />

        {/* ── Right: Sign in ── */}
        <div className="login-right">
          <h1 className="login-heading">Welcome back</h1>
          <p className="login-sub">Sign in to your account</p>
          <form onSubmit={handleSignIn} className="login-form">
            <div className="login-field">
              <label>Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@restaurant.com" required autoFocus={!startOnTrial} />
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
          <button type="button" className="login-staff-btn" onClick={() => navigate('/pos/login')}>
            Staff Login →
          </button>
        </div>

      </div>
    </div>
  )
}
