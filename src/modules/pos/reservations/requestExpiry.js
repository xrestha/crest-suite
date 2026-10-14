// Closing booking requests whose time has passed, when the Reservations page opens (S834, S809.4 4j).
//
// Since S818 the server closes a passed request only when the same phone asks again
// (submit_reservation_request). Every other one waited for staff, marked "time passed", and the
// guest's own page already says it was not answered in time. The page now closes them the way the
// server does: status 'cancelled', cancelled_at, cancel_reason EXPIRED_REQUEST_REASON.
//
// One update, filtered on status = 'requested' plus the band's own "passed" test (reservationSeen.js),
// so a request a colleague accepted or declined meanwhile is not touched, and `.select('id')` says
// which rows it closed. Bounded: a hung write is a failed one, and the caller only logs it.
import { stampFor, EXPIRED_REQUEST_REASON } from './reservationStatus'
import { passedRequests } from '../../../shared/reservationSeen'
import { settleWithin } from '../../../utils/withTimeout'

export const EXPIRE_WRITE_MS = 20000

/** The UPDATE payload: what stampFor() sets for requested → cancelled, plus the server's reason. */
export function expiredRequestPatch(nowIso) {
  return { ...stampFor('cancelled', nowIso, 'requested'), cancel_reason: EXPIRED_REQUEST_REASON }
}

/**
 * Closes this outlet's passed requests. `scopedUpdate` is useScopedDb()'s, so the write is held to
 * the outlet. Resolves { ids, error }: the ids closed (none is an ordinary answer), or the error. A
 * timed-out write may still land, which is harmless: the next read shows whatever it did.
 */
export async function closePassedRequests(scopedUpdate, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString()
  const { data, error } = await settleWithin(
    passedRequests(scopedUpdate('pos_reservations', expiredRequestPatch(nowIso)), nowMs).select('id'),
    EXPIRE_WRITE_MS, 'Closing booking requests whose time has passed',
  )
  if (error) return { ids: [], error }
  return { ids: (data || []).map(r => r.id), error: null }
}
