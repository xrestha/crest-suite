// When this device last looked at the Reservations page, per client — the marker behind the
// Activity tab's "new since you last looked" count and the sidebar's Reservations chip (S687).
// Per DEVICE on purpose (owner's decision): no migration, and a manager's own phone and the till
// count separately. Missing (first visit, cleared site data) means "count nothing", never "count
// everything since the outlet opened".
//
// A stamp is a real instant, so toISOString() is right here — the bsToAd rule is about calendar
// days, not timestamps. The same holds for the request cut-off below.
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

// Which booking requests count as waiting (S834, S809.4 4j). The Reservations band and the sidebar
// chip both count from here, so the two cannot disagree. A request whose time has passed is not
// waiting for an Accept any more: it stays in the band marked "time passed" until staff decline it,
// its own phone asks again (S818's server expiry) or the page closes it on opening, and neither count
// includes it. "Passed" is the band's own mark: reserved_for before now.
export function requestTimePassed(row, nowMs = Date.now()) {
  return new Date(row?.reserved_for).getTime() < nowMs
}

// The same line for a server-side filter. Two functions, not one with a switch: the passed half
// scopes a WRITE (the page's sweep), and a mistyped switch value must not fall into it.
const cutoffIso = nowMs => new Date(nowMs).toISOString()
/** Requests still to come (reserved_for at or after now): what the counts count. */
export function waitingRequests(query, nowMs = Date.now()) {
  return query.eq('status', 'requested').gte('reserved_for', cutoffIso(nowMs))
}
/** Requests requestTimePassed() marks (reserved_for before now). */
export function passedRequests(query, nowMs = Date.now()) {
  return query.eq('status', 'requested').lt('reserved_for', cutoffIso(nowMs))
}
