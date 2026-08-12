import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Hexagon } from 'lucide-react'
import { useSettings } from '../context/SettingsContext'
import { useCapsLock } from '../shared/hooks/useCapsLock'
import { MIN_PASSWORD_LENGTH, weakPasswordReason } from '../utils/weakPasswords'
import { supabase } from '../supabaseClient'
import './Login.css'

// Landing page for the link in a Supabase password-reset email. Supabase redirects here with a
// recovery token in the URL hash; supabase-js parses it automatically and fires a PASSWORD_RECOVERY
// auth event once the recovery session is established — only then is it safe to call updateUser().
export default function ResetPassword() {
  const { settings } = useSettings()
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [linkFailed, setLinkFailed] = useState(false)
  const [capsOn, capsHandlers] = useCapsLock()

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setReady(true)
    })
    // Covers the case where the recovery hash was already processed (and the event already
    // fired) before this listener was attached.
    supabase.auth.getSession().then(({ data }) => { if (data.session) setReady(true) })

    // `ready` only ever flips TRUE, so without this the page had a terminal dead end: arriving
    // here directly, with an expired token, or with the hash stripped by a mail client left
    // "Waiting for the reset link to verify…" on screen forever — no timeout, no error, no way
    // back to sign-in. This is a recovery flow, so the user is already here because something
    // went wrong, and reset links expire routinely.
    const timer = setTimeout(() => setLinkFailed(true), 8000)
    return () => { sub.subscription.unsubscribe(); clearTimeout(timer) }
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`); return
    }
    const weak = weakPasswordReason(password)
    if (weak) { setError(weak); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)
    if (error) { setError(error.message || 'Could not update password. The link may have expired — request a new one from the sign-in page.'); return }
    setDone(true)
  }

  return (
    <main className="login-root">
      <div className="login-split" style={{ maxWidth: 440, margin: '0 auto' }}>
        {/* 34px horizontal, matching .login-right's own padding — this overrode it to 0, so the
            heading sat 1px from the card edge and physically intruded on the 24px corner radius.
            First thing a user sees after clicking a link in an email. */}
        <div className="login-right" style={{ padding: '48px 34px' }}>
          <div className="login-brand" style={{ marginBottom: 24 }}>
            <Hexagon size={26} strokeWidth={2.25} aria-hidden="true" style={{ color: 'var(--theme-accent)', flexShrink: 0 }} />
            <span className="login-brand-name">{settings?.app_name || 'Crest Suite'}</span>
          </div>

          {done ? (
            <>
              <h1 className="login-heading">Password updated</h1>
              <p className="login-sub" style={{ marginBottom: 20 }}>You can now sign in with your new password.</p>
              <button type="button" className="login-btn" onClick={() => navigate('/login')}>Go to Sign In →</button>
            </>
          ) : !ready ? (
            <>
              <h1 className="login-heading">Reset your password</h1>
              {linkFailed ? (
                <>
                  <p className="login-error" role="alert" style={{ marginBottom: 18 }}>
                    This reset link didn't work. It may have expired, or already been used —
                    reset links are single-use and time-limited.
                  </p>
                  <button type="button" className="login-btn" onClick={() => navigate('/login')}>
                    Back to sign in →
                  </button>
                </>
              ) : (
                <p className="login-sub" role="status">Waiting for the reset link to verify…</p>
              )}
            </>
          ) : (
            <>
              <h1 className="login-heading">Set a new password</h1>
              <p className="login-sub">Choose a new password for your account.</p>
              <form onSubmit={handleSubmit} className="login-form">
                <div className="login-field">
                  <label htmlFor="new-password">New Password</label>
                  <input
                    id="new-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password} onChange={e => setPassword(e.target.value)}
                    {...capsHandlers}
                    placeholder={`Min. ${MIN_PASSWORD_LENGTH} characters`} required autoFocus />
                  {capsOn && <span className="login-caps-hint" role="status">Caps Lock is on</span>}
                </div>
                <div className="login-field">
                  <label htmlFor="confirm-password">Confirm Password</label>
                  <input
                    id="confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirm} onChange={e => setConfirm(e.target.value)}
                    placeholder="••••••••" required />
                  <label className="login-show-pw">
                    <input type="checkbox" checked={showPassword} onChange={e => setShowPassword(e.target.checked)} />
                    Show password
                  </label>
                </div>
                {error && <p className="login-error" role="alert">{error}</p>}
                <button type="submit" className="login-btn" disabled={loading}>
                  {loading ? 'Updating…' : 'Update Password'}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  )
}
