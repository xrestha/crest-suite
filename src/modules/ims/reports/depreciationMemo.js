/**
 * The month's depreciation MEMO (D23, owner decision S756): depreciation from POSTED Fixed Asset runs
 * whose dates overlap the month's AD dates, pro-rated by overlapping days. A memo only: Overheads and
 * Consolidated P&L print it under their statements and never subtract it (Net Profit is before
 * depreciation, interest and income tax).
 *
 * Lifted unchanged out of Overheads.js (S849, OVERHEADS-DEPR / PNL-3) so the P&L reads the same figure
 * without pulling in the Overheads page chunk. Overheads.js re-exports it.
 */
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
import { depreciationInWindow } from '../assets/depreciationCompute'

export const DEPRECIATION_MEMO_COLUMNS = 'id, period_start, period_end, depreciation_amount, override_amount'

/**
 * @param {(table: string, columns: string) => object} scopedFrom  the page's client-scoped builder
 * @param {{ bs_year: number, bs_month: number }} period
 * @returns {Promise<{ amount: number, count: number, prorated: boolean } | { error: object }>}
 *   Never throws: a failed or rejected read comes back as `{ error }`.
 */
export async function loadDepreciationMemo(scopedFrom, { bs_year, bs_month } = {}) {
  try {
    if (!bs_year || !bs_month) return { error: new Error('No month to read depreciation for') }
    // formatAd, never toISOString: bsToAd is local midnight, a day early in UTC.
    const start = formatAd(bsToAd(bs_year, bs_month, 1))
    const end = formatAd(bsToAd(bs_year, bs_month, daysInBsMonth(bs_year, bs_month)))
    const { data, error } = await fetchAllRows(() => scopedFrom('assets_depreciation_schedule', DEPRECIATION_MEMO_COLUMNS)
      .eq('is_posted', true).lte('period_start', end).gte('period_end', start)
      .order('period_end').order('id'))
    if (error) return { error }
    return depreciationInWindow(data || [], start, end)
  } catch (error) {
    return { error }
  }
}
