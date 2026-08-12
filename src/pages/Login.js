import { useState } from 'react'
import { useNavigate, useLocation, Navigate } from 'react-router-dom'
import { Hexagon } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { useCapsLock } from '../shared/hooks/useCapsLock'
import { MIN_PASSWORD_LENGTH, weakPasswordReason } from '../utils/weakPasswords'
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

// Mirrors the `register_trial` Edge Function's own check exactly, so the form never accepts an
// address the server is about to reject.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Every sign-in failure used to collapse into "Invalid email or password." That generic string is
// the right answer for a *credential* failure — it's what stops this form being used to enumerate
// which addresses have accounts (OWASP) — but it was also swallowing rate limits, server errors and
// the 15s auth-fetch timeout from authFetchTimeout.js. Telling someone who has been rate-limited
// that their password is wrong makes them retry harder, which is the opposite of what the limit is
// for. So: keep one indistinguishable message across every credential outcome (wrong password, no
// such account, disabled account), and separate out only the failures that aren't about credentials
// at all and where the user's correct next action is genuinely different.
function signInErrorMessage(err) {
  const status = err?.status
  const code   = String(err?.code || '')
  const name   = String(err?.name || '')
  const msg    = String(err?.message || '')

  if (status === 429 || /rate|too many/i.test(code + msg)) {
    return 'Too many sign-in attempts. Please wait a minute and try again.'
  }
  // AuthRetryableFetchError is what auth-js returns for a network failure — including the abort
  // fired by makeAuthTimeoutFetch when /auth/v1/ exceeds 15s.
  if (name === 'AuthRetryableFetchError' || status === 0 || status >= 500 ||
      /fetch|network|aborted|timeout|failed to send/i.test(msg)) {
    return "Couldn't reach the server. Check your connection and try again."
  }
  if (code === 'email_not_confirmed') {
    return 'Please confirm your email address first, then sign in.'
  }
  return 'Invalid email or password.'
}

const HIGHLIGHTS = [
  'Stop guessing which dishes lose money — Menu Repricing finds them',
  'Catch ingredient waste before it eats your margin — Theoretical Variance',
  'Roster, attendance & payroll in one place — no manual hour reconciliation',
  'SSF & TDS calculated automatically, deadline-ready every month',
  'Count stock without losing your place when the wifi drops',
  'See which dishes actually sell well together — real order data, not guesswork',
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
  const [signInCaps, signInCapsHandlers] = useCapsLock()

  // Forgot-password state
  const [forgotMode, setForgotMode]     = useState(false)
  const [forgotEmail, setForgotEmail]   = useState('')
  const [forgotError, setForgotError]   = useState('')
  const [forgotLoading, setForgotLoading] = useState(false)
  const [forgotSent, setForgotSent]     = useState(false)

  // Trial signup state
  const [tBiz, setTBiz]         = useState('')
  const [tName, setTName]       = useState('')
  const [tPhone, setTPhone]     = useState('')
  const [tEmail, setTEmail]     = useState('')
  const [tPass, setTPass]       = useState('')
  const [tShowPass, setTShowPass] = useState(false)
  const [tError, setTError]     = useState('')
  const [tFieldErr, setTFieldErr] = useState({})
  const [tLoading, setTLoading] = useState(false)
  const [trialSuccess, setTrialSuccess] = useState(false)
  const [trialCaps, trialCapsHandlers] = useCapsLock()

  const { signIn, session, ready, profile } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()

  async function handleSignIn(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) {
      setError(signInErrorMessage(error))
      setLoading(false)
    } else {
      navigate('/dashboard')
    }
  }

  async function handleForgotPassword(e) {
    e.preventDefault()
    setForgotError('')
    setForgotLoading(true)
    // Supabase itself returns success (no error) even for an unregistered email, specifically to
    // prevent using this form to enumerate which addresses have accounts — so surfacing `error`
    // here doesn't reopen that hole, it only ever fires for genuine failures (rate limit, etc.).
    const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setForgotLoading(false)
    if (error) { setForgotError(error.message || 'Could not send reset email. Please try again.'); return }
    setForgotSent(true)
  }

  async function handleTrialSignup(e) {
    e.preventDefault()
    setTError('')

    // Validated per field rather than as one message at the bottom of the form: a single shared
    // error line means someone who missed Phone reads about it nowhere near Phone. The first
    // offending field also takes focus, so keyboard and screen-reader users land on the thing
    // they need to fix instead of hunting for it.
    const errs = {}
    if (!tBiz.trim())                        errs['trial-biz']   = 'Business name is required.'
    if (!tEmail.trim())                      errs['trial-email'] = 'Email is required.'
    else if (!EMAIL_RE.test(tEmail.trim()))  errs['trial-email'] = 'Enter a valid email address.'
    if (!tPhone.trim())                      errs['trial-phone'] = 'Phone number is required.'
    if (!tPass)                              errs['trial-password'] = 'Password is required.'
    else if (tPass.length < MIN_PASSWORD_LENGTH) {
      errs['trial-password'] = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    } else {
      const weak = weakPasswordReason(tPass, { businessName: tBiz, email: tEmail })
      if (weak) errs['trial-password'] = weak
    }

    setTFieldErr(errs)
    const firstInvalid = ['trial-biz', 'trial-email', 'trial-password', 'trial-phone'].find(id => errs[id])
    if (firstInvalid) { document.getElementById(firstInvalid)?.focus(); return }

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

  // Someone who is already signed in has no business being shown a sign-in form — `/` redirects
  // via RootRedirect but `/login` had no equivalent, so a stale tab or a back-button press landed
  // on an empty login form for an authenticated session. Gated on `ready` so this never fires
  // during the auth-resolution window and bounces a genuinely logged-out visitor.
  //
  // `profile` is required too, and that is the second half of the sign-in redirect loop fixed
  // alongside ProtectedRoute: a session whose profile fetch FAILED would otherwise be sent to
  // /dashboard, rejected back here for having no profile, and sent again forever. Requiring the
  // profile means a broken session lands on the sign-in form — where it can actually be fixed —
  // instead of ping-ponging.
  if (ready && session && profile) return <Navigate to="/dashboard" replace />

  const trialFieldError = (id) => tFieldErr[id]
    ? <span className="login-field-error" id={`${id}-err`} role="alert">{tFieldErr[id]}</span>
    : null

  // aria-invalid tells assistive tech the field is the problem; aria-describedby points at the
  // message explaining why. Without both, an inline error is visible but not announced.
  const trialFieldAria = (id) => ({
    'aria-invalid': tFieldErr[id] ? 'true' : undefined,
    'aria-describedby': tFieldErr[id] ? `${id}-err` : undefined,
  })

  return (
    <main className="login-root">
      <div className="login-split">

        <div className="login-top">
          {/* ── Left: Pitch ── */}
          <div className="login-left">
            <div className="login-brand login-brand--split">
              <div className="login-brand-mark">
                <Hexagon size={26} strokeWidth={2.25} aria-hidden="true" style={{ color: 'var(--theme-accent)', flexShrink: 0 }} />
                <span className="login-brand-name">{settings?.app_name || 'Crest Suite'}</span>
              </div>
              {/* type="button" explicitly — a <button> with no type defaults to submit, which is
                  harmless only for as long as this stays outside a <form>. */}
              <button
                type="button"
                onClick={() => navigate('/pricing')}
                className="login-btn login-btn--trial login-btn--pricing">
                View Pricing →
              </button>
            </div>

            <div className="login-pitch">
              <div className="login-pitch-headline">Smarter menus. Better margins.</div>
              <div className="login-pitch-sub">Built for Nepal's F&amp;B industry.</div>
            </div>

            <ul className="login-highlights">
              {HIGHLIGHTS.map((text, i) => (
                <li key={i}>
                  <span className="login-highlight-bullet" />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* ── Divider ── */}
          <div className="login-vdivider" />

          {/* ── Right: Sign in ── */}
          <div className="login-right">
            {forgotMode ? (
              <>
                <h1 className="login-heading">Reset password</h1>
                <p className="login-sub">We'll email you a link to set a new one</p>
                {forgotSent ? (
                  <div className="login-notice" role="status">
                    If an account exists for that email, a reset link is on its way. Check your inbox.
                  </div>
                ) : (
                  <form onSubmit={handleForgotPassword} className="login-form">
                    <div className="login-field">
                      <label htmlFor="forgot-email">Email</label>
                      <input id="forgot-email" type="email" autoComplete="username" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder="you@restaurant.com" required autoFocus />
                    </div>
                    {forgotError && <p className="login-error" role="alert">{forgotError}</p>}
                    <button type="submit" className="login-btn" disabled={forgotLoading}>
                      {forgotLoading ? 'Sending…' : 'Send Reset Link'}
                    </button>
                  </form>
                )}
                <button type="button" className="login-staff-btn" onClick={() => { setForgotMode(false); setForgotSent(false); setForgotError('') }}>
                  ← Back to sign in
                </button>
              </>
            ) : (
              <>
                <h1 className="login-heading">Welcome back</h1>
                <p className="login-sub">Sign in to your account</p>
                <form onSubmit={handleSignIn} className="login-form">
                  <div className="login-field">
                    <label htmlFor="signin-email">Email</label>
                    <input id="signin-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@restaurant.com" required autoFocus={!startOnTrial} />
                  </div>
                  <div className="login-field">
                    <label htmlFor="signin-password">Password</label>
                    <input
                      id="signin-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password} onChange={e => setPassword(e.target.value)}
                      {...signInCapsHandlers}
                      placeholder="••••••••" required />
                    {signInCaps && <span className="login-caps-hint" role="status">Caps Lock is on</span>}
                    <label className="login-show-pw">
                      <input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} />
                      Show password
                    </label>
                  </div>
                  <button
                    type="button" className="login-forgot"
                    onClick={() => { setForgotMode(true); setForgotEmail(email) }}>
                    Forgot password?
                  </button>
                  {error && <p className="login-error" role="alert">{error}</p>}
                  <button type="submit" className="login-btn" disabled={loading}>
                    {loading ? 'Signing in…' : 'Sign in'}
                  </button>
                </form>
                <button type="button" className="login-staff-btn" onClick={() => navigate('/pos/login')}>
                  Staff Login →
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Trial signup: one full-width block below both columns, so the whole form reads
            left-to-right in a single continuous flow instead of being split by the vertical
            divider above. ── */}
        <div className="login-hdivider" />
        <div className="login-trial-block">
          {/* A real heading, not a styled div: this block creates a live client account, and the
              page's only heading was "Welcome back" — so the sign-in form and the account-creation
              form were indistinguishable in the heading outline, and the conversion CTA sat under
              the quietest text tier in the system. */}
          <h2 className="login-divider-label">Start your free trial</h2>

          {trialSuccess ? (
            <div className="login-notice" role="status">
              Account created! Sign in above with your email and password.
            </div>
          ) : (
            // noValidate so our own per-field messages are what the user sees, rather than the
            // browser's native bubbles firing first and pre-empting them. `required` stays on the
            // inputs regardless — it's what conveys "this field is mandatory" to assistive tech.
            <form onSubmit={handleTrialSignup} className="login-form" noValidate>
              <div className="login-row-top">
                <div className="login-field">
                  <label htmlFor="trial-biz">Business Name *</label>
                  <input id="trial-biz" value={tBiz} onChange={e => setTBiz(e.target.value)} placeholder="e.g. Sunrise Café" required {...trialFieldAria('trial-biz')} autoFocus={startOnTrial} />
                  {trialFieldError('trial-biz')}
                </div>
                <div className="login-field">
                  {/* "Business email" / "Create a password", not "Email" / "Password": the
                      sign-in form 300px above uses those exact labels with the same placeholder,
                      and the two forms have opposite consequences — one signs you in, the other
                      creates a real client record. Nothing but proximity distinguished them. */}
                  <label htmlFor="trial-email">Business email *</label>
                  <input id="trial-email" type="email" autoComplete="email" value={tEmail} onChange={e => setTEmail(e.target.value)} placeholder="you@restaurant.com" required {...trialFieldAria('trial-email')} />
                  {trialFieldError('trial-email')}
                </div>
                <div className="login-field">
                  <label htmlFor="trial-password">Create a password *</label>
                  <input id="trial-password" type={tShowPass ? 'text' : 'password'} autoComplete="new-password" value={tPass} onChange={e => setTPass(e.target.value)} {...trialCapsHandlers} placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`} required {...trialFieldAria('trial-password')} />
                  {trialCaps && <span className="login-caps-hint" role="status">Caps Lock is on</span>}
                  {trialFieldError('trial-password')}
                </div>
                <label className="login-show-pw login-show-pw--inline">
                  <input type="checkbox" checked={tShowPass} onChange={e => setTShowPass(e.target.checked)} />
                  Show password
                </label>
              </div>
              <div className="login-row-second">
                <div className="login-field">
                  <label htmlFor="trial-name">Your Name <span className="login-optional">(optional)</span></label>
                  <input id="trial-name" value={tName} onChange={e => setTName(e.target.value)} placeholder="e.g. Ramesh Shrestha" />
                </div>
                <div className="login-field">
                  <label htmlFor="trial-phone">Phone *</label>
                  <input id="trial-phone" type="tel" value={tPhone} onChange={e => setTPhone(e.target.value)} placeholder="98XXXXXXXX" required {...trialFieldAria('trial-phone')} />
                  {trialFieldError('trial-phone')}
                </div>
                <button type="submit" className="login-btn login-btn--trial login-btn--inline" disabled={tLoading}>
                  {tLoading ? 'Creating your account…' : 'Start Free Trial →'}
                </button>
              </div>
              {tError && <p className="login-error" role="alert">{tError}</p>}
              <p className="login-trial-note">7-day free trial · Starter plan · No credit card needed</p>
              <p className="login-consent">
                By starting a trial you agree to our Terms of Service and Privacy Policy.
              </p>
            </form>
          )}
        </div>

      </div>
    </main>
  )
}
