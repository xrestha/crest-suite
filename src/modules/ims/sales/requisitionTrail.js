import { nepalTime, nepalTime24, nepalBsLong, nepalDateLong } from '../../../shared/nepalTime'

/**
 * Who raised, issued or rejected a requisition, and when — as the sentences a slip shows.
 *
 * WHY (S756, owner decision D14). A signed slip answered "what left the store" and never "who
 * handed it over". The columns behind these lines are stamped by the database from the session
 * (`ims_requisition_attribution`), never by the page, so nothing here is a claim the browser made.
 *
 * Kept pure so the three places a slip goes — the screen, the printed slip and the workbook — read
 * one wording, and so a slip written before S756 (every column NULL) is described as unrecorded
 * rather than silently omitted: an issued slip with no "Issued by" line reads as if nobody issued
 * it, which is a different claim from "this was not recorded at the time".
 */

// The three statuses, each with the badge it wears. Rejected is a decided-not-to-act state, so it
// takes the neutral chip — never red (a failure) or amber (this product's "needs attention").
export const REQUISITION_STATUS = {
  draft:    { label: 'Draft',    badge: 'badge-amber' },
  issued:   { label: 'Issued',   badge: 'badge-green' },
  rejected: { label: 'Rejected', badge: 'badge-gray' },
}

export function statusMeta(status) {
  return REQUISITION_STATUS[status] || REQUISITION_STATUS.draft
}

/**
 * A timestamptz as a reader in Nepal says it. `clock: '24'` is for spreadsheet cells, where a
 * 12-hour column mis-sorts (nepalTime24's own rule). BS first, AD when the BS table cannot name it.
 */
export function whenLabel(ts, { clock = '12' } = {}) {
  if (!ts) return ''
  const day = nepalBsLong(ts) || nepalDateLong(ts)
  const time = clock === '24' ? nepalTime24(ts) : nepalTime(ts)
  return [day, time].filter(Boolean).join(', ')
}

/**
 * The person behind an attribution id.
 *
 * `names` is the id→name map from get_client_profile_names; `namesFailed` says that read did not
 * come back, which must not look like "this person no longer exists" (a failed read is not an
 * empty one). An id with no name after a successful read belongs to no login of THIS client: a Crest
 * operator acting on it, or a group Owner whose home is a sibling outlet (get_client_profile_names
 * lists this client's profiles only). A deleted login never reaches here — the FK is ON DELETE SET
 * NULL. Neither case is worth guessing between on a slip, so the wording names neither.
 */
export function personLabel(id, names, namesFailed) {
  if (!id) return null
  const name = names?.[id]
  if (name) return name
  return namesFailed ? 'name could not be loaded' : 'a login from outside this outlet'
}

/**
 * The trail as ordered parts: `{ key, text }`. Screen, print and Excel each join them their own way.
 */
export function trailParts(req, { names, namesFailed, clock = '12' } = {}) {
  if (!req) return []
  const parts = []
  const who = id => personLabel(id, names, namesFailed)

  const raisedBy = who(req.requested_by)
  const raisedAt = whenLabel(req.created_at, { clock })
  parts.push({
    key: 'raised',
    text: raisedBy
      ? `Raised by ${raisedBy}${raisedAt ? ` · ${raisedAt}` : ''}`
      : 'Raised before who-raised-it was recorded',
  })

  if (req.status === 'issued') {
    const issuedBy = who(req.issued_by)
    const issuedAt = whenLabel(req.issued_at, { clock })
    parts.push({
      key: 'issued',
      text: issuedBy
        ? `Issued by ${issuedBy}${issuedAt ? ` at ${issuedAt}` : ''}`
        : issuedAt
          ? `Issued at ${issuedAt}`
          : 'Issued before who-issued-it was recorded',
    })
  }

  if (req.status === 'rejected') {
    const rejectedBy = who(req.rejected_by)
    const rejectedAt = whenLabel(req.rejected_at, { clock })
    parts.push({
      key: 'rejected',
      text: `Rejected${rejectedBy ? ` by ${rejectedBy}` : ''}${rejectedAt ? ` at ${rejectedAt}` : ''}`,
    })
  }
  return parts
}
