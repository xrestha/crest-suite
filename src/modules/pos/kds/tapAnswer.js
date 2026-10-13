import { noAnswer } from '../orders/sendAttempt'
import { errorInfo, errorLine } from '../../../shared/errorText'

// What the answer to a Kitchen Display tap (Start, Ready, Served, Seen, Clear) means, and what the
// board says about it — the pure half of advance() in KitchenDisplay.jsx.
//
// S833 (POS_TODO S809.4 3d): only a timeout used to read as "not known". A dropped connection or a
// gateway error read "was not moved — it is back where it was", although the write may have landed.
// No answer is now the till's one rule for it (`noAnswer`, sendAttempt.js): the board says it is not
// known and reads itself again, so the card shows where the ticket really is. Only the database's own
// refusal says the ticket is back where it was.

/** Null when the tap landed. Otherwise { text, reread }: the line for the board, and whether to read
 *  the board again at once. `res` is the conditional update's answer as settleWithin returns it; it
 *  selects `id`, so no row back means it matched nothing (the ticket had already moved). */
export function tapMiss(res, { tableName, nextStatus } = {}) {
  if (!res?.error && res?.data?.length) return null
  const who = tableName || 'This ticket'
  const did = nextStatus === 'cancelled' ? 'cleared' : 'moved'
  if (res?.error && noAnswer(res)) {
    // errorText's own sentence for a 5xx is "That didn't work", which is the claim this branch must
    // not make, so only the technical detail rides along, as fine print.
    const { detail } = errorInfo(res.error, 'staff')
    return {
      reread: true,
      text: `No answer came back, so ${who} may or may not have ${did} — the board is checking again and will show where it really is.${detail ? ` (${detail})` : ''}`,
    }
  }
  // errorLine, not error.message: the reader is a cook, and "Failed to fetch" is not a sentence they
  // can act on (S683). The database answered no, so the ticket is back where it was; say so.
  if (res?.error) return { reread: false, text: `${who} was not ${did} — it is back where it was. ${errorLine(res.error, 'staff')}` }
  return { reread: true, text: 'This ticket was already moved, served from the floor, or cancelled' }
}
