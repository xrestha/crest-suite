import { STATUS_LABEL } from './reservationStatus'

// Pure helpers for the Activity view (S687): what a row's latest change was, how long ago, and
// whether it is new since this device last looked. Kept out of the page so they can be tested
// without rendering it.

const EDIT_SLACK_MS = 60000

/**
 * The row's latest change as { label, at }. `at` is always updated_at (the one column a trigger
 * maintains on every write), so the list orders by what actually moved last. Who confirmed,
 * arrived or cancelled is NOT stored — only created_by is — so the label carries no actor; the
 * page prints "by <name>" for a new booking and nothing else.
 */
export function activityEvent(r) {
  const at = r.updated_at || r.created_at || null
  switch (r.status) {
    case 'booked': {
      const edited = r.updated_at && r.created_at && (Date.parse(r.updated_at) - Date.parse(r.created_at) > EDIT_SLACK_MS)
      return { label: edited ? 'Edited' : 'Booked', at }
    }
    case 'confirmed': return { label: r.source === 'website' ? 'Accepted' : 'Confirmed', at }
    case 'cancelled': return { label: r.source === 'website' && !r.confirmed_at ? 'Declined' : 'Cancelled', at }
    default:          return { label: STATUS_LABEL[r.status] || r.status || '', at }
  }
}

/** "just now" / "12 min ago" / "3 h ago" / "yesterday" / "5 days ago"; '' for nothing usable. */
export function agoLabel(ts, now = Date.now()) {
  const t = ts ? Date.parse(ts) : NaN
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  return `${d} days ago`
}

/** True when the row changed after the stamp. No stamp (first visit on this device) = nothing is new. */
export function isNewSince(r, stamp) {
  if (!stamp || !r?.updated_at) return false
  const a = Date.parse(r.updated_at), b = Date.parse(stamp)
  return !Number.isNaN(a) && !Number.isNaN(b) && a > b
}

/**
 * Rows bucketed by the key `dayOf` returns, in order of first appearance — so a list already
 * sorted by reserved_for comes out as consecutive day groups. Rows with no key are skipped.
 */
export function groupByDay(rows, dayOf) {
  const out = []
  const idx = new Map()
  for (const r of rows || []) {
    const k = dayOf(r)
    if (!k) continue
    if (!idx.has(k)) { idx.set(k, out.length); out.push({ iso: k, rows: [] }) }
    out[idx.get(k)].rows.push(r)
  }
  return out
}
