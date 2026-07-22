// Suspense fallback shown while a lazily-loaded route chunk is being fetched.
// Deliberately minimal and theme-aware — it renders inside <main> (sidebar stays put during
// in-app navigation) so it must not reintroduce its own chrome. Uses the same shimmer token
// as the dashboard skeletons and respects prefers-reduced-motion via that shared CSS.
export default function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '40vh',
        gap: 14,
        color: 'var(--theme-text3)',
      }}
    >
      <div className="skeleton" style={{ width: 160, height: 10 }} />
      <div style={{ fontSize: 12, letterSpacing: '0.02em' }}>Loading…</div>
    </div>
  )
}
