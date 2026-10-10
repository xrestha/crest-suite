import { BS_MONTHS } from '../../../utils/bsCalendar'
import { withTimeout } from '../../../utils/withTimeout'
import { backfillPosOrdersToIms } from './backfillPosToIms'
import { backfillCreditNotesToIms } from '../creditnotes/creditNotePosting'
import { posStockLines } from './posRecipeBook'

// Till bills and credit notes waiting for Inventory: who is told, and who posts (S809 3j).
//
// IMS-HANDOFF-1 / CREDIT-NOTES-3, owner decision Q12 (c), 2026-10-09: the Owner and the operator
// post waiting till bills and credit notes into Inventory (Periods, or the floor), and so does a POS
// manager, from the till's floor. An Inventory login cannot post them: the RESTRICTIVE no_ims_staff
// policies hand any login with an IMS role an EMPTY pos_orders / pos_credit_notes, with no error, so
// a count it makes itself reads 0 and it used to be told "everything is already in Inventory". It is
// told how many wait, and who posts them, through pos_ims_waiting_counts (SECURITY DEFINER,
// migration 20261010140000), which returns numbers per Nepali month and nothing else.

/**
 * How many bills and notes wait, per Nepali month: [{ bs_year, bs_month, period_id, period_status,
 * bills, notes }], period_id/period_status NULL when the month has no Inventory period yet. Never
 * throws: a failed or timed-out read is `{ rows: null, error }`, which a caller shows as "couldn't
 * check" and never as 0 (S734: on a queue, zero is the answer the reader wants).
 */
export async function loadImsWaiting(supabase, clientId) {
  if (!clientId) return { rows: [], error: null }
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('pos_ims_waiting_counts', { p_client_id: clientId }),
      20000, 'Checking which till bills wait for Inventory')
    if (error) return { rows: null, error }
    return { rows: data || [], error: null }
  } catch (err) {
    return { rows: null, error: err }
  }
}

const monthLabel = r => (r.bs_year && r.bs_month ? `${BS_MONTHS[r.bs_month - 1]} ${r.bs_year}` : 'a date outside the Nepali calendar')

/**
 * The rows, sorted into what the till's floor can post (the month OPEN in Inventory), what only the
 * Owner can post (a CLOSED month: ims_closed_period_guard admits the Owner and the operator alone),
 * and what waits for its month to be started in Inventory (no period yet). Pure.
 */
export function summarizeWaiting(rows) {
  const out = { bills: 0, notes: 0, open: null, closed: [], unstarted: [] }
  for (const r of rows || []) {
    const bills = Number(r.bills) || 0
    const notes = Number(r.notes) || 0
    if (bills + notes === 0) continue
    out.bills += bills
    out.notes += notes
    const month = { year: r.bs_year, month: r.bs_month, periodId: r.period_id || null, bills, notes, label: monthLabel(r) }
    if (r.period_status === 'open') out.open = month
    else if (r.period_status === 'closed') out.closed.push(month)
    else out.unstarted.push(month)
  }
  return out
}

/** One period's counts out of the rows, { bills, notes } (0 and 0 when it has none). Pure. */
export function waitingForPeriod(rows, periodId) {
  const r = (rows || []).find(x => x.period_id === periodId)
  return { bills: Number(r?.bills) || 0, notes: Number(r?.notes) || 0 }
}

/** "3 bills and 1 credit note", "1 bill", "2 credit notes"; '' for none. Pure. */
export function countPhrase(bills, notes) {
  return [
    bills > 0 && `${bills} bill${bills === 1 ? '' : 's'}`,
    notes > 0 && `${notes} credit note${notes === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' and ')
}

/**
 * The till floor's "Post to Inventory" (Q12 c): the waiting bills, then the waiting credit notes, of
 * the month OPEN in Inventory, through the same two functions Periods runs. Never a closed month:
 * the database refuses a sales row there from anyone but the Owner and the operator, and the Owner
 * posts those from Periods. The recipe book is read through pos_recipe_book (posStockLines): a Staff
 * PIN login cannot read `items`, and the stock lines would otherwise take every trim loss as 100%.
 * A bill is never posted twice: the database refuses a second post (pos_bill_already_posted, and
 * pos_credit_note_already_posted for a note), so two people pressing at once cost nothing.
 *
 * Each step is bounded, as Periods bounds it. Throws only on a timeout (the caller words it).
 * @returns {Promise<{ period?, bills?, notes?, reason?: 'no_open', step?: 'period'|'bills'|'notes', error? }>}
 */
export async function postWaitingFromTill({ supabase, scopedFrom, scopedInsert, scopedUpdate, clientId }) {
  const { data: period, error: pErr } = await withTimeout(
    scopedFrom('monthly_periods', 'id, bs_year, bs_month, status').eq('status', 'open').maybeSingle(),
    20000, 'Checking which month is open in Inventory')
  if (pErr) return { step: 'period', error: pErr }
  if (!period) return { reason: 'no_open' }

  const loadStockLines = (recipeIds, deltaLists) => posStockLines(supabase, clientId, recipeIds, deltaLists)
  const bills = await withTimeout(
    backfillPosOrdersToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, period, loadStockLines }),
    120000, 'Posting till bills to Inventory')
  if (bills.error) return { period, step: 'bills', error: bills.error }
  // After the bills, so a credit note never goes into a month its own bill has not reached.
  const notes = await withTimeout(
    backfillCreditNotesToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, period }),
    60000, 'Posting credit notes to Inventory')
  if (notes.error) return { period, bills, step: 'notes', error: notes.error }
  return { period, bills, notes }
}
