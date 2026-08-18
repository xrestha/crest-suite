function fmt(days) {
  if (days >= 30) {
    const m = Math.floor(days / 30)
    return `${m} month${m !== 1 ? 's' : ''} left`
  }
  return `${days}d left`
}

// `color` is the full-opacity SIGNAL TEXT and must be a theme token, never a literal: it is
// rendered as text on the card/sidebar surface, and the ten presets move that surface from
// #0f1117 to #e6e9ef. Hardcoding the Dark preset's own #34d399 here put the subscription badge
// at 1.58:1 on Latte — every light preset failed AA on the one line that says how long a client
// has left. The `bg`/`border` alpha tints stay literal rgba: that is the codebase's documented
// convention (DESIGN.md's tint pattern is "alpha fill + full-opacity signal text"), and a faint
// tint reads correctly as red/amber/green on every preset because only the text carries meaning.
function statusFromDays(days) {
  if (days < 0)   return { label: 'Expired',  days, color: 'var(--theme-red-text)',   bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.3)'  }
  if (days <= 7)  return { label: fmt(days),   days, color: 'var(--theme-red-text)',   bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.25)' }
  if (days <= 30) return { label: fmt(days),   days, color: 'var(--theme-amber-text)', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)'  }
  return            { label: fmt(days),   days, color: 'var(--theme-green-text)', bg: 'rgba(52,211,153,0.10)',  border: 'rgba(52,211,153,0.25)'  }
}

// Per-date status helper — pass any date string directly
export function getDateStatus(endsAt) {
  if (!endsAt) return { label: null, days: null, color: 'var(--theme-text3)', bg: 'transparent', border: 'transparent' }
  const days = Math.ceil((new Date(endsAt) - Date.now()) / 86400000)
  return statusFromDays(days)
}

// Days of continued access after the last module end date passes. A lapsed invoice here is
// usually a collection delay (cheque/cash pickup), not a decision to leave — cutting a live
// restaurant off at midnight on the due date would strand a service in progress, so expiry
// warns for a week first and only then locks.
export const GRACE_DAYS = 7

// The single source of truth behind the app-wide lock — see ProtectedRoute.
//
// Deliberately fails OPEN: a client carrying no end date on any module has never been given
// one (most of the existing book predates per-module dates), and must keep working. Only a
// date that exists AND has passed, or an explicit admin deactivation, locks anything.
export function getAccessState(client) {
  const open = { locked: false, reason: null, daysLeft: null, graceLeft: null }
  if (!client) return open

  // An explicit admin deactivation outranks every date in both directions — it locks a client
  // whose dates are still valid, and it is the switch that actually means something now.
  if (client.is_active === false) return { ...open, locked: true, reason: 'deactivated' }

  // Self-service trial. The retention window that follows expiry (trial_purge_at) is about how
  // long the DATA is kept, not about continued access, so the lock lands on the expiry date.
  if (client.is_trial && client.trial_expires_at && new Date(client.trial_expires_at) < new Date()) {
    return { ...open, locked: true, reason: 'trial' }
  }

  const ends = [
    client.ims_ends_at,
    client.hr_ends_at,
    client.pos_ends_at,
    client.suite_ends_at,
    client.subscription_ends_at,
  ].filter(Boolean).map(d => new Date(d).getTime())

  if (ends.length === 0) return open

  const daysLeft = Math.ceil((Math.max(...ends) - Date.now()) / 86400000)
  if (daysLeft >= 0) return { ...open, daysLeft }
  if (-daysLeft <= GRACE_DAYS) {
    return { ...open, reason: 'grace', daysLeft, graceLeft: GRACE_DAYS + daysLeft }
  }
  return { ...open, locked: true, reason: 'expired', daysLeft }
}

// Client-level badge — uses the latest active end date across all modules, falls back to trial
export function getSubStatus(client) {
  const now = Date.now()
  // Take the farthest end date across all module subscriptions
  const candidates = [
    client?.ims_ends_at,
    client?.hr_ends_at,
    client?.pos_ends_at,
    client?.suite_ends_at,
    client?.subscription_ends_at,
  ].filter(Boolean).map(d => new Date(d).getTime())

  if (candidates.length > 0) {
    const latest = Math.max(...candidates)
    const days   = Math.ceil((latest - now) / 86400000)
    return statusFromDays(days)
  }
  // Trials read the canonical pair register_trial writes (is_trial + trial_expires_at) —
  // trial_ends_at was a second, legacy trial column that only the admin "+ New Client" form
  // wrote and only this fallback read, so an admin-created client and a self-service trial were
  // invisible to each other's screens (S574; migration 20260818190000 folded it in).
  if (client?.is_trial && client?.trial_expires_at) {
    const days = Math.ceil((new Date(client.trial_expires_at) - now) / 86400000)
    if (days < 0) return { label: 'Trial expired', days, color: 'var(--theme-red-text)', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.25)' }
    const m = Math.floor(days / 30)
    const trialLabel = days >= 30 ? `Trial · ${m}mo` : `Trial · ${days}d`
    return { label: trialLabel, days, color: 'var(--theme-accent-ink)', bg: 'rgba(201,168,76,0.10)', border: 'rgba(201,168,76,0.25)' }
  }
  // Explicit, not a silent "—": a client with no dates at all fails OPEN in getAccessState
  // (unlimited access) and is skipped by the auto-deactivation sweep, so this is the one state
  // an operator must notice and price — a converted trial lands here until dates are set (S574).
  return { label: 'No end date', days: null, color: 'var(--theme-text2)', bg: 'rgba(138,146,163,0.12)', border: 'rgba(138,146,163,0.3)' }
}
