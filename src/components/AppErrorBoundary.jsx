import { Component } from 'react'
import { TriangleAlert } from 'lucide-react'
import SupportContactLine from './SupportContactLine'
import { APP_VERSION } from '../shared/appVersion'

// Catches a render throw in a lazy route — or, mounted at app scope, in the providers themselves
// — and renders a fallback instead of letting React unmount the whole tree to a blank page (S673).
// There was no error boundary anywhere in this codebase before this file: nothing here catches
// `window.onerror`, `unhandledrejection`, `componentDidCatch` or a router `errorElement`, so a
// throw in any lazy route propagated past both `Suspense` boundaries (Suspense catches promises,
// not errors) straight to the React root, which unmounted everything with no error surfaced
// anywhere and a reload as the only exit.
//
// WHAT THIS CANNOT CATCH — React's own restriction, stated here because it is the natural place to
// forget: an error thrown from an event handler (a button's onClick), a rejected promise nothing
// awaits, anything thrown before React has mounted, and an error thrown by the fallback itself.
//
// Deliberately uses NO router hooks so it can mount both above BrowserRouter (App.js) and inside
// Layout — navigation from the fallback is a real browser navigation (`window.location`), which is
// the right behaviour regardless of whether client-side routing is even in a working state.
const STACK_LINES = 3

// Redacts anything credential-shaped before it can reach a clipboard destined for WhatsApp: a
// thrown error's message or stack can carry a query string, and this is deliberately broad rather
// than exhaustive — a false positive here costs nothing, a missed secret costs a lot.
function redact(text) {
  if (!text) return ''
  return String(text)
    .replace(/\b(pin|password|token|secret|key|bearer)\b\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]') // JWT-shaped
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted]') // long base64-shaped runs
}

function stackHeadOf(error) {
  return redact(error?.stack || '').split('\n').slice(0, STACK_LINES).join('\n')
}

// About ten plain-text lines: app version, when, the route, the error, a few stack frames, and
// enough device context to skip "which screen were you on?". Deliberately excludes the user's
// email, the client name and anything auth-shaped — this text is going into WhatsApp or email, not
// staying inside the product.
function buildDetails(error, route) {
  const stack = stackHeadOf(error)
  return [
    'Crest Suite crash report',
    `App version: ${APP_VERSION}`,
    `When: ${new Date().toString()}`,
    `Route: ${route || 'unknown'}`,
    `Browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
    `Screen: ${typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'unknown'}`,
    `Online: ${typeof navigator !== 'undefined' ? navigator.onLine : 'unknown'}`,
    `Error: ${redact(error?.message || String(error))}`,
    stack ? `Stack:\n${stack}` : null,
  ].filter(Boolean).join('\n')
}

async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_) {
      // fall through to the execCommand path below
    }
  }
  // Fallback for a non-secure context — execCommand is deprecated but still the only synchronous
  // copy path with no Clipboard API.
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch (_) { ok = false }
  document.body.removeChild(ta)
  return ok
}

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, copyState: 'idle', showText: false }
    this.handleCopy = this.handleCopy.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('AppErrorBoundary caught:', error, info)
  }

  componentDidUpdate(prevProps) {
    // resetKey is the current route (Layout passes location.pathname) — navigating away from the
    // page that crashed clears the error, so the sidebar and the rest of the app keep working.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, copyState: 'idle', showText: false })
    }
  }

  async handleCopy() {
    const route = this.props.route || (typeof window !== 'undefined' ? window.location.pathname : '')
    const text = buildDetails(this.state.error, route)
    const ok = await copyText(text)
    if (ok) {
      this.setState({ copyState: 'copied' })
      setTimeout(() => this.setState((s) => (s.copyState === 'copied' ? { copyState: 'idle' } : s)), 3000)
    } else {
      this.setState({ showText: true })
    }
  }

  render() {
    const { error, copyState, showText } = this.state
    if (!error) return this.props.children

    const route = this.props.route || (typeof window !== 'undefined' ? window.location.pathname : '')
    const details = buildDetails(error, route)
    const stack = stackHeadOf(error)

    return (
      <div style={{
        minHeight: this.props.fullPage === false ? '60vh' : '100vh',
        background: 'var(--theme-bg, #0f1117)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}>
        <div style={{
          maxWidth: 520, width: '100%', background: 'var(--theme-card, #181c27)',
          border: '1px solid var(--theme-border, #2a2f3d)', borderRadius: 'var(--radius-lg, 18px)',
          padding: '32px 34px', textAlign: 'center',
        }}>
          {/* Alpha tint + full-opacity signal text, same reasoning as SubscriptionLock's icon
              badge — --theme-red has no paired foreground token and ranges from light to dark
              across presets, so a solid fill is unreadable on one of them (DESIGN.md). */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 52, height: 52, borderRadius: 'var(--radius-full, 999px)',
            background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.3)',
            marginBottom: 18, color: 'var(--theme-red-text, #f87171)',
          }}><TriangleAlert size={22} strokeWidth={2} aria-hidden="true" /></div>

          <h1 style={{
            margin: '0 0 8px', fontSize: 20, fontWeight: 700,
            color: 'var(--theme-text1, #e8e0d0)', fontFamily: 'Georgia, serif',
          }}>Something went wrong on this screen</h1>

          <p style={{ margin: '0 0 20px', fontSize: 13, lineHeight: 1.65, color: 'var(--theme-text2, #9ca3af)' }}>
            Nothing you had already saved is affected. Reloading usually fixes it — if it keeps
            happening, copy the details below and send them to support.
          </p>

          <div className="no-print" style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
            <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
            <button className="btn btn-ghost" onClick={() => window.location.assign('/dashboard')}>Back to Dashboard</button>
            <button className="btn btn-ghost" onClick={this.handleCopy}>
              {copyState === 'copied' ? '✓ Copied' : 'Copy details'}
            </button>
          </div>

          {showText && (
            <textarea
              readOnly
              aria-label="Crash report details — select and copy"
              value={details}
              onFocus={(e) => e.target.select()}
              style={{
                width: '100%', minHeight: 100, marginBottom: 20, fontSize: 11, fontFamily: 'monospace',
                background: 'var(--theme-input-bg, #0f1117)', color: 'var(--theme-text2, #9ca3af)',
                border: '1px solid var(--theme-border, #2a2f3d)', borderRadius: 'var(--radius-sm, 8px)',
                padding: 10, boxSizing: 'border-box',
              }}
            />
          )}

          <div style={{ marginBottom: 20 }}>
            <SupportContactLine variant="buttons" />
          </div>

          <details style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text3, #8a92a3)' }}>
            <summary style={{ cursor: 'pointer', marginBottom: 6 }}>Technical detail</summary>
            <div style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {redact(error?.message || String(error))}
              {stack ? `\n${stack}` : ''}
            </div>
          </details>
        </div>
      </div>
    )
  }
}
