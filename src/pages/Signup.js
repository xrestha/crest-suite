import { useState } from 'react'
import { useNavigate, Navigate, Link } from 'react-router-dom'
import { Hexagon } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { useCapsLock } from '../shared/hooks/useCapsLock'
import { MIN_PASSWORD_LENGTH, weakPasswordReason } from '../utils/weakPasswords'
import { TRIAL_DAYS } from '../data/pricingPlans'
import { acceptancePayload, legalPath } from '../legal'
import { supabase } from '../supabaseClient'
import FieldError, { fieldAria } from '../components/FieldError'
import SupportContactLine from '../components/SupportContactLine'
import './Login.css'
import './Signup.css'

// Account creation lived inside /login until Modernist split it out. The login page was carrying
// two jobs with opposite consequences — one signs you in, the other creates a live client record —
// and the design's answer is that the second one is its own page with its own heading, reached
// from a slim band where the form used to sit.
//
// This file owns EVERYTHING trial-specific. Login.js keeps the sign-in card, the forgot-password
// flow and the hero; it no longer imports weakPasswords, acceptancePayload or FieldError at all.
// The chrome (header, footer) and the form primitives in Login.css are deliberately SHARED rather
// than duplicated: Login.css is already a three-consumer file (ResetPassword.js imports it too),
// and a second copy of `.login-field` is how the two pages start diverging.

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

export default function Signup() {
  const [tBiz, setTBiz]         = useState('')
  const [tName, setTName]       = useState('')
  const [tPhone, setTPhone]     = useState('')
  const [tEmail, setTEmail]     = useState('')
  const [tPass, setTPass]       = useState('')
  const [tShowPass, setTShowPass] = useState(false)
  const [tError, setTError]     = useState('')
  const [tFieldErr, setTFieldErr] = useState({})
  const [tLoading, setTLoading] = useState(false)
  // Unchecked by default and required, which is the whole difference between a clickwrap and
  // the passive sentence this replaced. The server refuses the signup without it too --
  // a consent control the browser can skip is not a consent control.
  const [tLegal, setTLegal]     = useState(false)
  const [trialSuccess, setTrialSuccess] = useState(false)
  const [trialCaps, trialCapsHandlers] = useCapsLock()

  const { signIn, session, ready, profile } = useAuth()
  const { settings } = useSettings()
  const navigate = useNavigate()

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
    if (!tLegal)                             errs['trial-legal'] = 'Please accept the Terms of Service and Privacy Policy to continue.'
    if (!tPass)                              errs['trial-password'] = 'Password is required.'
    else if (tPass.length < MIN_PASSWORD_LENGTH) {
      errs['trial-password'] = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
    } else {
      const weak = weakPasswordReason(tPass, { businessName: tBiz, email: tEmail })
      if (weak) errs['trial-password'] = weak
    }

    setTFieldErr(errs)
    const firstInvalid = ['trial-biz', 'trial-email', 'trial-password', 'trial-phone', 'trial-legal'].find(id => errs[id])
    if (firstInvalid) { document.getElementById(firstInvalid)?.focus(); return }

    setTLoading(true)
    try {
      await edgeOp('register_trial', {
        business_name: tBiz.trim(),
        full_name:     tName.trim() || tBiz.trim(),
        phone:         tPhone.trim(),
        email:         tEmail.trim().toLowerCase(),
        password:      tPass,
        // The version and hash of what was actually on screen, from the bundle this browser has
        // loaded -- not what the server happens to think is current. The two can differ for as
        // long as a cached bundle survives a deploy. No IP, no user agent, no identity: those are
        // read server-side off the request, because a subject that supplies its own attribution
        // has not been attributed.
        accepted_legal: acceptancePayload(),
      })
      const { error: signInErr } = await signIn(tEmail.trim().toLowerCase(), tPass)
      if (signInErr) {
        // The account EXISTS; only the automatic sign-in failed. On /login this used to pre-fill
        // the sign-in card sitting 300px below — there is no sign-in card on this page, so the
        // honest move is to say so and hand them the route, carrying the address so they do not
        // retype it. Never a silent redirect: an account was created and they should be told.
        setTrialSuccess(true)
      } else {
        navigate('/dashboard')
      }
    } catch (err) {
      const msg = err.message || 'Something went wrong. Please try again.'
      const isAlreadyRegistered = msg.includes('already exists') || msg.includes('already registered') || msg.includes('profiles_pkey')
      setTError(isAlreadyRegistered
        ? 'An account with this email already exists. Sign in instead.'
        : msg)
    } finally {
      setTLoading(false)
    }
  }

  // Reproduced from Login.js rather than inherited: without it a signed-in tab that lands here —
  // a stale bookmark, a back-button press — is shown an account-creation form for an account it
  // already has. Gated on `ready` so it never fires during the auth-resolution window, and on
  // `profile` so a session whose profile fetch failed lands somewhere it can be fixed.
  if (ready && session && profile) return <Navigate to="/dashboard" replace />

  const trialFieldError = (id) => <FieldError id={id} message={tFieldErr[id]} />
  const trialFieldAria  = (id) => fieldAria(id, tFieldErr[id])

  return (
    <div className="login-page signup-page">

      <header className="login-nav">
        <div className="login-nav-inner">
          <div className="login-brand-mark">
            {settings?.logo_url
              ? <img src={settings.logo_url} alt="" style={{ width: 26, height: 26, objectFit: 'contain', borderRadius: 0, flexShrink: 0 }} />
              : <Hexagon size={26} strokeWidth={2.25} aria-hidden="true" style={{ color: 'var(--theme-accent)', flexShrink: 0 }} />}
            <span className="login-brand-name">{settings?.app_name || 'Crest Suite'}</span>
          </div>
          <nav className="login-nav-actions" aria-label="Site">
            <button
              type="button"
              onClick={() => navigate('/pricing')}
              className="login-btn login-btn--pricing">
              Pricing
            </button>
            {/* The mirror of /login's "Start your free trial": from here the way out is back to
                sign-in, so the header CTA points there rather than at the page you are on. */}
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="login-btn login-btn--trial login-btn--nav">
              <span>Sign in</span><span aria-hidden="true">→</span>
            </button>
          </nav>
        </div>
      </header>

      <main className="signup-main">
        {/* One column, flush left, no hero: this page has one job and the form IS the content.
            h1 rather than h2 — on /login the trial block was a section of someone else's page and
            had to be an h2 under the hero headline; here it is the page. */}
        <div className="signup-inner">
          <h1 className="signup-title">Start your free trial</h1>
          <p className="signup-sub">
            Starter plan, free for {TRIAL_DAYS} days · No credit card · Nothing to install
          </p>

          {trialSuccess ? (
            <div className="login-notice" role="status">
              Account created. <Link to={`/login?email=${encodeURIComponent(tEmail.trim().toLowerCase())}`}>Sign in</Link> with
              the email and password you just chose.
            </div>
          ) : (
            // noValidate so our own per-field messages are what the user sees, rather than the
            // browser's native bubbles firing first and pre-empting them. `required` stays on the
            // inputs regardless — it's what conveys "this field is mandatory" to assistive tech.
            <form onSubmit={handleTrialSignup} className="login-form" noValidate>
              {/* One grid for both rows, not two stacked grids. As two, each row's `fr` tracks
                  resolved against its own content, so Your Name's right edge sat ~45px past
                  Business Name's directly above it — the kind of misalignment that is obvious in
                  a render and invisible in the source. */}
              <div className="login-trial-grid">
                <div className="login-field">
                  <label htmlFor="trial-biz">Business Name *</label>
                  {/* Unconditional autoFocus now. On /login this was `autoFocus={startOnTrial}` —
                      it had to compete with the sign-in email field on the same page, and only won
                      when ?trial=1 said the visitor came to sign up. On a page that is nothing but
                      this form there is no competition and no condition. /signup?trial=1 still
                      works; the parameter simply no longer decides anything. */}
                  <input id="trial-biz" value={tBiz} onChange={e => setTBiz(e.target.value)} placeholder="e.g. Sunrise Café" required {...trialFieldAria('trial-biz')} autoFocus />
                  {trialFieldError('trial-biz')}
                </div>
                <div className="login-field">
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
                <div className="login-field">
                  <label htmlFor="trial-name">Your Name <span className="login-optional">(optional)</span></label>
                  <input id="trial-name" value={tName} onChange={e => setTName(e.target.value)} placeholder="e.g. Ramesh Shrestha" />
                </div>
                <div className="login-field">
                  <label htmlFor="trial-phone">Phone *</label>
                  <input id="trial-phone" type="tel" value={tPhone} onChange={e => setTPhone(e.target.value)} placeholder="98XXXXXXXX" required {...trialFieldAria('trial-phone')} />
                  {trialFieldError('trial-phone')}
                </div>
                <button type="submit" className="login-btn login-btn--trial login-btn--inline login-btn--flush" disabled={tLoading}>
                  <span>{tLoading ? 'Creating your account…' : 'Start Free Trial'}</span>
                  <span aria-hidden="true">→</span>
                </button>
              </div>
              {tError && <p className="login-error" role="alert">{tError}</p>}

              {/* This was a passive sentence — "By starting a trial you agree to our Terms of
                  Service and Privacy Policy" — naming two documents that did not exist, as plain
                  unlinked text, with nothing recorded anywhere. Under the Electronic Transactions
                  Act 2063 an e-contract needs clearly expressed offer and acceptance; passive
                  notice is the weakest form of both, and unlinked passive notice of a document
                  nobody can read is not notice at all.

                  Now: unchecked by default, required, with both documents one click away in a new
                  tab so the form state survives the trip. The acceptance is recorded server-side
                  against the version and hash shown here. The label wraps the checkbox, so it is
                  associated without needing htmlFor. */}
              <label className="login-consent login-consent--check">
                <input
                  id="trial-legal"
                  type="checkbox"
                  checked={tLegal}
                  onChange={e => { setTLegal(e.target.checked); if (e.target.checked) setTFieldErr(p => ({ ...p, 'trial-legal': undefined })) }}
                  {...trialFieldAria('trial-legal')}
                />
                <span>
                  I have read and agree to the{' '}
                  <a href={legalPath('terms')} target="_blank" rel="noopener noreferrer">Terms of Service</a>
                  {' '}and{' '}
                  <a href={legalPath('privacy')} target="_blank" rel="noopener noreferrer">Privacy Policy</a>
                  {' '}on behalf of my business.
                </span>
              </label>
              {trialFieldError('trial-legal')}
              <p className="login-consent login-consent--sub">
                You are creating a {TRIAL_DAYS}-day free trial. No card required.
              </p>
            </form>
          )}
        </div>
      </main>

      {/* Duplicated from Login.js deliberately, and it is not decoration: Login.trialConsent's
          successor test asserts each legal href appears at least TWICE on the page carrying the
          form — the consent pair plus this footer pair — because a document reachable only from a
          checkbox someone has already ticked is not published. */}
      <footer className="login-footer">
        © {new Date().getFullYear()} {settings?.app_name || 'Crest Suite'} · Built for Nepal's F&amp;B industry
        <span className="login-footer-legal">
          <Link to={legalPath('terms')}>Terms of Service</Link>
          <span aria-hidden="true"> · </span>
          <Link to={legalPath('privacy')}>Privacy Policy</Link>
          <SupportContactLine variant="inline" leadSeparator className="login-footer-support-inline" />
        </span>
      </footer>
    </div>
  )
}
