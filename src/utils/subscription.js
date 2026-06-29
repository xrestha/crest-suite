function fmt(days) {
  if (days >= 30) {
    const m = Math.floor(days / 30)
    return `${m} month${m !== 1 ? 's' : ''} left`
  }
  return `${days}d left`
}

function statusFromDays(days) {
  if (days < 0)   return { label: 'Expired',  days, color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.3)'  }
  if (days <= 7)  return { label: fmt(days),   days, color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.25)' }
  if (days <= 30) return { label: fmt(days),   days, color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)'  }
  return            { label: fmt(days),   days, color: '#34d399', bg: 'rgba(52,211,153,0.10)',  border: 'rgba(52,211,153,0.25)'  }
}

// Per-date status helper — pass any date string directly
export function getDateStatus(endsAt) {
  if (!endsAt) return { label: null, days: null, color: '#4b5563', bg: 'transparent', border: 'transparent' }
  const days = Math.ceil((new Date(endsAt) - Date.now()) / 86400000)
  return statusFromDays(days)
}

// Client-level badge — uses ims_ends_at as primary, falls back to subscription_ends_at, then trial
export function getSubStatus(client) {
  const now = Date.now()
  const endDate = client?.ims_ends_at || client?.subscription_ends_at
  if (endDate) {
    const days = Math.ceil((new Date(endDate) - now) / 86400000)
    return statusFromDays(days)
  }
  if (client?.trial_ends_at) {
    const days = Math.ceil((new Date(client.trial_ends_at) - now) / 86400000)
    if (days < 0) return { label: 'Trial expired', days, color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.25)' }
    const m = Math.floor(days / 30)
    const trialLabel = days >= 30 ? `Trial · ${m}mo` : `Trial · ${days}d`
    return { label: trialLabel, days, color: '#c9a84c', bg: 'rgba(201,168,76,0.10)', border: 'rgba(201,168,76,0.25)' }
  }
  return { label: null, days: null, color: '#4b5563', bg: 'transparent', border: 'transparent' }
}
