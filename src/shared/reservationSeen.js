// When this device last looked at the Reservations page, per client — the marker behind the
// Activity tab's "new since you last looked" count and the sidebar's Reservations chip (S687).
// Per DEVICE on purpose (owner's decision): no migration, and a manager's own phone and the till
// count separately. Missing (first visit, cleared site data) means "count nothing", never "count
// everything since the outlet opened".
//
// A stamp is a real instant, so toISOString() is right here — the bsToAd rule is about calendar
// days, not timestamps.
const keyOf = clientId => `crest:resv-seen:${clientId}`

export function readSeenStamp(clientId) {
  if (!clientId) return null
  try {
    const v = localStorage.getItem(keyOf(clientId))
    return v && !Number.isNaN(Date.parse(v)) ? v : null
  } catch { return null }
}

export function writeSeenStamp(clientId, at = new Date()) {
  if (!clientId) return
  try { localStorage.setItem(keyOf(clientId), new Date(at).toISOString()) } catch { /* private mode */ }
}
