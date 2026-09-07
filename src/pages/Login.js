import { useState } from 'react'
import { useNavigate, useLocation, Navigate, Link } from 'react-router-dom'
import { Hexagon } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { useCapsLock } from '../shared/hooks/useCapsLock'
import { TRIAL_DAYS } from '../data/pricingPlans'
import { legalPath } from '../legal'
import { supabase } from '../supabaseClient'
import SupportContactLine from '../components/SupportContactLine'
import './Login.css'

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

// The signed-out pitch. Ordered POS → IMS → HR, and kept in that structure here even though the
// module headings are no longer RENDERED: the order is the argument (POS leads because it is the
// lead product — the previous six lines gave it one indirect mention, and three of the six restated
// a single idea, "we tell you which dishes lose money", in three vocabularies), and the shape is
// what stops a future line being dropped into the wrong pair.
//
// The visible POS / IMS / HR headings were built and then taken back out. They cost about 100px of
// column height, and this page is laid out to fit one screen from ~830px of viewport height up
// (S553, tightened S560) — a budget the new copy was already straining. Grouping was the cheapest
// thing on the page to give up: the bullets still arrive module by module, they just no longer
// announce it. If they are ever restored, re-measure the fit at 1536x864 first, not after.
//
// Every line is problem-then-relief in that order, under ~16 words, two short sentences, no
// subclauses. That is not a style preference: most buyers here read English as a second or third
// language, and the failure mode is not simplicity, it is a 27-word sentence with two subclauses
// that a sharp operator skims past. Hold the constraint if these are ever reordered or rewritten,
// including within a group.
//
// Three claims are deliberately NOT made. Nothing here says live or real-time food cost —
// writeSalesEntries swallows depletion failures by design so a stock problem never blocks a bill
// closing, which means a bill can carry revenue with no stock_movements row (S573). That trade-off
// is right, and it makes running food cost best-effort; a public page must not put an accuracy
// claim on top of a known silent failure. The data line says "Ask", not "Export any time", because
// every file in the export path is admin-side and there is no client-facing self-serve button. And
// nothing promises restore: export is well tested, restore has only ever moved a single row live.
const HIGHLIGHT_GROUPS = [
  {
    module: 'POS',
    lines: [
      'One free plate looks small. Crest shows what they add up to.',
      'Guests spend more when the suggestion is right. Crest shows your staff what sells together.',
    ],
  },
  {
    module: 'IMS',
    lines: [
      "Ingredient prices move every month. Your menu prices don't. Crest shows the gap.",
      'You know what a plate sells for. Crest shows what it costs you to make.',
    ],
  },
  {
    module: 'HR',
    lines: [
      'Staff quit without notice. Crest works out the final payment for you.',
      'No HR person? Payroll for the whole team, done in one evening.',
    ],
  },
]

// Ungrouped and last: a promise about the company, not a feature of a module. Filing it under any
// one of the three would read as something only that module does.
const DATA_PROMISE = 'Your data stays yours. Ask any time and we hand it all back.'

export default function Login() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  // /login?trial=1 used to scroll to the in-page signup band and focus its first field. The band
  // is a route now, so the deep link becomes a redirect and keeps working from every place that
  // still points at it (Pricing's two CTAs, and any link a visitor has bookmarked).
  const wantsTrial = params.get('trial') === '1'
  // Set by Signup's post-creation notice when auto sign-in failed, so the address does not have
  // to be retyped on the page that was just told it exists.
  const prefillEmail = params.get('email') || ''

  // Sign-in state
  const [email, setEmail]               = useState(prefillEmail)
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

  // The ?trial=1 deep link, preserved. It used to scroll to the in-page band and focus its first
  // field; the band is a route now, so the same URL forwards there instead of landing someone on
  // a sign-in page they did not ask for. `replace` so Back returns to wherever they came from
  // rather than bouncing through this redirect again. Kept AFTER the signed-in check on purpose:
  // an authenticated visitor following an old trial link wants their dashboard, not a signup form.
  if (wantsTrial) return <Navigate to="/signup?trial=1" replace />

  return (
    <div className="login-page">

      {/* ── Site header ─────────────────────────────────────────────────────────────────────
          This page reads as a real page rather than one boxed card floating in the middle of a
          dark field: a sticky header, a hero, a signup band and a footer, matching Pricing.js's
          own structure (sticky nav, brand row, centred max-width content) so the two public pages are
          recognisably one site rather than two unrelated screens. ── */}
      <header className="login-nav">
        <div className="login-nav-inner">
          {/* The mark and the name have to come from the same place. This read app_name while
              always drawing Crest's own hexagon, so a white-labelled client met their own brand
              name beside somebody else's mark on the page they log in through (S606) — the sidebar
              has had this conditional since it was built and the public pages never adopted it.
              alt is empty for the same reason the hexagon is aria-hidden: the wordmark beside it
              already names the brand, and a labelled mark announces it twice. */}
          <div className="login-brand-mark">
            {settings?.logo_url
              ? <img src={settings.logo_url} alt="" style={{ width: 26, height: 26, objectFit: 'contain', borderRadius: 0, flexShrink: 0 }} />
              : <Hexagon size={26} strokeWidth={2.25} aria-hidden="true" style={{ color: 'var(--theme-accent)', flexShrink: 0 }} />}
            <span className="login-brand-name">{settings?.app_name || 'Crest Suite'}</span>
          </div>
          <nav className="login-nav-actions" aria-label="Site">
            {/* type="button" explicitly — a <button> with no type defaults to submit, which is
                harmless only for as long as these stay outside a <form>. */}
            <button
              type="button"
              onClick={() => navigate('/pricing')}
              className="login-btn login-btn--pricing">
              Pricing
            </button>
            {/* A router navigation, not the `<a href="#start-trial">` in-page jump this was:
                the band it jumped to is a route now. As a button it also stops being the one
                underlined blue-ish thing in the header on a preset that styles links. */}
            <button
              type="button"
              onClick={() => navigate('/signup')}
              className="login-btn login-btn--trial login-btn--nav">
              <span>Start free trial</span><span aria-hidden="true">→</span>
            </button>
          </nav>
        </div>
      </header>

      <main>
        <section className="login-hero">
          {/* ── Pitch ── */}
          <div className="login-hero-copy">
            {/* Trial length comes from TRIAL_DAYS, never a literal. Between them this page and
                Pricing.js used to state it four different ways, one of which was a month. */}
            <span className="login-eyebrow">{TRIAL_DAYS}-day free trial · No credit card needed</span>
            {/* Two blocks, so the break lands after "screen" at every width instead of wherever
                the measure happens to run out — unforced, a phone broke it after "the", which
                orphans an article on a line and reads as a mistake rather than as a clause. The
                type size is untouched: this page's whole layout is budgeted against a measured
                viewport, and shrinking the one thing a visitor reads first is the wrong saving. */}
            <h1 className="login-pitch-headline">
              <span className="login-pitch-line">Your business, on one screen,</span>
              <span className="login-pitch-line">one system for the cash, the store and the staff.</span>
            </h1>
            <p className="login-pitch-sub">Built for Nepal's F&amp;B industry.</p>

            {/* One list, one lit spine. Six module lines in POS → IMS → HR order; the seventh sits
                outside the list below, because it is a promise about the company rather than a
                feature of any module. */}
            {/* Numbered rows, not bullet beads (Modernist). The number is the ordering device the
                lit spine used to be — six lines in POS → IMS → HR order, each on its own 1px rule,
                so the list reads as a specification rather than as marketing. `index` is a safe
                key input here only because it is paired with the text: the array is a module-level
                constant that never reorders. */}
            <ul className="login-highlights">
              {HIGHLIGHT_GROUPS.flatMap(group => group.lines).map((text, i) => (
                <li key={text}>
                  <span className="login-highlight-num" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
                  <span>{text}</span>
                </li>
              ))}
            </ul>

            {/* Outside the <ul>, not the last row in it. The lit spine belongs to .login-highlights
                and ends where the list does, so stepping out is what actually detaches this line —
                inside, with the rule still running past it, it read as a third HR bullet no matter
                how much space sat above it. It keeps the bead: it is still one of the promises,
                just not one a module makes. */}
            <p className="login-data-promise">
              <span className="login-promise-mark" aria-hidden="true" />
              <span>{DATA_PROMISE}</span>
            </p>
          </div>

          {/* ── Sign in ── */}
          <div className="login-card">
            {forgotMode ? (
              <>
                {/* h2, not h1 — the page's h1 is the hero headline above; the card is a section
                    of the page now, not the page itself. */}
                <h2 className="login-heading">Reset password</h2>
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
                <h2 className="login-heading">Welcome back</h2>
                <p className="login-sub">Sign in to your account</p>
                <form onSubmit={handleSignIn} className="login-form">
                  <div className="login-field">
                    <label htmlFor="signin-email">Email</label>
                    <input id="signin-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@restaurant.com" required autoFocus />
                  </div>
                  <div className="login-field">
                    {/* "Forgot password?" sits in the label row rather than on its own line below
                        the field — it is the conventional place for it, and it buys back a full
                        36px row in a card that has to fit the viewport alongside everything else. */}
                    <div className="login-label-row">
                      <label htmlFor="signin-password">Password</label>
                      <button
                        type="button" className="login-forgot"
                        onClick={() => { setForgotMode(true); setForgotEmail(email) }}>
                        Forgot password?
                      </button>
                    </div>
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
                  {error && <p className="login-error" role="alert">{error}</p>}
                  {/* Sign in and Staff Login share a row rather than stacking. Staff Login stays
                      inside the card — it is a login alternative and belongs where someone looks
                      for a way in, not in the header among the marketing links — and paired like
                      this it costs the page a column instead of a whole row. type="button" keeps
                      it from submitting the form it now sits inside. */}
                  {/* Stacked and full-width, not side by side. Two 50% buttons made Staff Login
                      read as the equal-weight alternative to signing in, which it is not — it is
                      the way in for a till, and most visitors here are not one. Stacked, the
                      primary owns the row and the secondary is plainly the second option.
                      Both take the flush-left label + trailing arrow. */}
                  <div className="login-actions">
                    <button type="submit" className="login-btn login-btn--flush" disabled={loading}>
                      <span>{loading ? 'Signing in…' : 'Sign in'}</span><span aria-hidden="true">→</span>
                    </button>
                    <button type="button" className="login-staff-btn login-btn--flush" onClick={() => navigate('/pos/login')}>
                      <span>Staff Login</span><span aria-hidden="true">→</span>
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        </section>

        {/* ── The signup band, after the form moved to /signup ─────────────────────────────
            This used to be the whole trial form: seven fields, a consent checkbox and a submit,
            inside a full-bleed accent-lit band. It was the page's second job, and the page could
            not fit its own viewport budget while carrying it (measured 146px of overflow at
            1366x768, S553/S560).

            What is left is the invitation, not the form: a 2px rule, the question, the terms in
            one line, and the way through on the right. Both this button and the header's go to
            the same route, so there is one destination rather than an in-page jump and a link
            that disagreed about where signing up happens. ── */}
        <section className="login-signup-band">
          <div className="login-signup-copy">
            <h2 className="login-signup-title">New to {settings?.app_name || 'Crest Suite'}?</h2>
            <p className="login-signup-sub">
              Starter plan, free for {TRIAL_DAYS} days · No credit card · Nothing to install
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/signup')}
            className="login-btn login-btn--trial login-btn--flush login-signup-cta">
            <span>Start your free trial</span><span aria-hidden="true">→</span>
          </button>
        </section>
      </main>

      {/* Was one line with no links, on the reasoning that its only candidate (Pricing) was
          already a button in the header. Terms and Privacy are the exception that earns a place:
          a legal document nobody can find from the page that binds them to it is not published,
          and every other public surface now carries the same pair. */}
      <footer className="login-footer">
        © {new Date().getFullYear()} {settings?.app_name || 'Crest Suite'} · Built for Nepal's F&amp;B industry
        {/* Link, not a plain <a>: the router owns both of these routes, so a bare href threw away
            the loaded bundle and reloaded the whole app to move one route sideways. The consent
            links above stay plain anchors — they carry target="_blank" on purpose, so the half-
            filled signup form survives the trip. */}
        <span className="login-footer-legal">
          <Link to={legalPath('terms')}>Terms of Service</Link>
          <span aria-hidden="true"> · </span>
          <Link to={legalPath('privacy')}>Privacy Policy</Link>
          {/* Kept on this SAME line rather than a third footer row — this page is laid out to a
              measured viewport budget with 0px of slack (S553/S560), and a wrapped long line costs
              more than a longer short one (see the comment on .login-footer-legal below). */}
          <SupportContactLine variant="inline" leadSeparator className="login-footer-support-inline" />
        </span>
      </footer>
    </div>
  )
}
