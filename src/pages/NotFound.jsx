import { Link, useLocation } from 'react-router-dom'

/**
 * The page for a URL that matches nothing (S683).
 *
 * App.js had no `path="*"` at any level, so a typo, a truncated link or a bookmark to a route
 * that has since moved rendered an EMPTY #root — no shell, no sentence, nothing to click. It had
 * been fixed once, for /legal alone, with a comment there explaining why truncating a URL is
 * ordinary behaviour; it was never generalised.
 *
 * Mounted INSIDE the Layout route group, so the sidebar stays and a signed-in reader is one click
 * from anywhere. A signed-out visitor never reaches it — ProtectedRoute sends them to /login,
 * which is the right front door for someone holding a bad link. A second `*` outside the group
 * would be dead code: the nested splat is matched first for every unmatched URL.
 */
export default function NotFound() {
  const { pathname } = useLocation()
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Nothing at this address</h1>
        <p className="page-subtitle"><code>{pathname}</code></p>
      </div>
      <div className="card" style={{ padding: '40px 32px', textAlign: 'center', maxWidth: 560, margin: '0 auto' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }} aria-hidden="true">🧭</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 8 }}>
          There is no page here
        </div>
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7, marginBottom: 20 }}>
          The link may be old, the page may have moved, or the address was mistyped. Nothing in your
          data has changed.
        </p>
        <Link to="/dashboard" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}
