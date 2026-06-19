function fmt(days) {
  if (days >= 30) {
    const m = Math.floor(days / 30)
    return `${m} month${m !== 1 ? 's' : ''} left`
  }
  return `${days}d left`
}

export function getSubStatus(client) {
  const now = Date.now()
  if (client?.subscription_ends_at) {
    const days = Math.ceil((new Date(client.subscription_ends_at) - now) / 86400000)
    if (days < 0)   return { label: 'Expired',  days, color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.3)'  }
    if (days <= 7)  return { label: fmt(days),   days, color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.25)' }
    if (days <= 30) return { label: fmt(days),   days, color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)'  }
    return                { label: fmt(days),   days, color: '#34d399', bg: 'rgba(52,211,153,0.10)',  border: 'rgba(52,211,153,0.25)'  }
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
