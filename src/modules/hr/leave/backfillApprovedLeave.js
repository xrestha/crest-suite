import { supabase } from '../../../supabaseClient'
import { scopedFrom } from '../../../shared/scopedDb'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { withTimeout } from '../../../utils/withTimeout'
import { workingDaysInRange } from './leaveConstants'

/**
 * Write the attendance rows for leave that was approved BEFORE its month existed.
 *
 * WHY (S741). Approving a leave request does two things: it stamps the request `approved`, and it
 * writes an `hr_attendance` row per day — `paid_leave` / `unpaid_leave` — which is the ONLY way
 * payroll ever learns about the leave (`payrollCompute.js` sums `unpaidDays` from attendance rows
 * that exist; a day with no row is a paid day). Those rows hang off a `monthly_periods` row, and a
 * client may have only one open period at a time (`monthly_periods_one_open_per_client`). So a
 * leave approved for a month two or three ahead — which is most leave, since staff plan around
 * Dashain and family trips — had nowhere to write, and nothing back-filled it when the month came:
 * an approved unpaid leave was silently PAID in full. This runs at the one moment the write becomes
 * possible — when the period is minted — and backs the Leave page's catch-up button.
 *
 * WHERE (S798, LEAVE-OT-HOLIDAYS-1). The rules run in the database, in
 * `hr_backfill_approved_leave(p_period_id)` (SECURITY DEFINER). This file used to read the requests,
 * types, holidays and settlements with the CALLER's login, and RLS hides every HR row from an IMS
 * login — so when an IMS supervisor ended the month the read came back empty, the function reported
 * "filled 0" with no error, and the approved unpaid leave was paid. The function checks the caller
 * (admin, the Owner, an IMS or HR supervisor/manager of that client) and keeps every rule this file
 * had:
 *
 *   • **Blanks only.** A day that already carries a mark (by hand, by an approval, by Generate) is
 *     never overwritten; those are counted as `skipped`.
 *   • **One row per employee-day**, so two approved requests on one day cannot fail the batch.
 *   • **A public holiday inside the leave is marked `holiday`** (decided 2026-09-14).
 *   • **A leaver settled in the current employment is left out and counted as `settled`** (S791) —
 *     their finalized Final Settlement already paid this month. A rehire is marked like anyone else.
 *   • **A finalized payroll month is refused** (`hr_month_finalized`), row by row through the same
 *     `hr_pay_month_guard` the attendance trigger calls.
 *
 * **It reports rather than throws.** Period creation must never fail because of an HR write; the
 * caller records `{ filled, skipped, settled, employees, error }` beside its own result and surfaces
 * it, because a best-effort second write's silence proves nothing (CLAUDE.md, "one write never
 * proves another landed"). `clientId` is only a guard here — the function reads the period's own.
 *
 * @param {{clientId: string, period: {id: string, bs_year: number, bs_month: number}}} args
 * @returns {Promise<{filled: number, skipped: number, settled: number, employees: number, error: any}>}
 */
export async function backfillApprovedLeave({ clientId, period }) {
  const empty = { filled: 0, skipped: 0, settled: 0, employees: 0, error: null }
  if (!clientId || !period?.id || !period.bs_year || !period.bs_month) return empty
  try {
    const { data, error } = await withTimeout(
      supabase.rpc('hr_backfill_approved_leave', { p_period_id: period.id }),
      20000, 'Marking approved leave'
    )
    if (error) return { ...empty, error }
    const count = k => Number(data?.[k]) || 0
    return { filled: count('filled'), skipped: count('skipped'), settled: count('settled'), employees: count('employees'), error: null }
  } catch (e) {
    // A timeout may still land; the Leave page's banner finds whatever did not.
    return { ...empty, error: e }
  }
}

/**
 * The sentence for a back-fill result — what the new month now contains, not what ran.
 * Returns '' when there is nothing worth saying (the overwhelmingly common case).
 */
export function backfillLeaveText({ filled, skipped, settled, employees, error }, monthLabel) {
  if (error) {
    return `${monthLabel} was created, but leave already approved for it could not be marked on the attendance sheet. ` +
      `Open HR → Leave and use "Mark approved leave" there, or those days will not be deducted in payroll.`
  }
  // S791: nothing to do about these — the leaver's Final Settlement already paid this month.
  const left = settled ? ` ${settled} day${settled === 1 ? '' : 's'} of leave belonging to staff whose Final Settlement already paid ${monthLabel} were left out.` : ''
  if (!filled) return left.trim()
  const who = employees === 1 ? '1 employee' : `${employees} employees`
  const skip = skipped ? ` ${skipped} day${skipped === 1 ? '' : 's'} already had an attendance mark and were left alone.` : ''
  return `${filled} day${filled === 1 ? '' : 's'} of leave approved earlier for ${monthLabel} (${who}) were marked on its attendance sheet.${skip}${left}`
}

/**
 * Which approved leave has NOT reached an attendance sheet, split by why (S741).
 *
 * The back-fill above closes the gap going forward. This is what makes an existing gap visible,
 * because until now the only notice was a transient banner at approval time — a warning about a
 * month three ahead, shown once, to whoever happened to be approving.
 *
 * Two kinds, and they need different sentences because only one of them is anyone's to act on:
 *
 *   • `waiting` — the month has no period row yet. Nothing to do: the period cannot be opened
 *     early (one open period per client) and creating it will mark these days automatically.
 *     Saying so is the point; a manager who reads "not marked" with no explanation goes looking
 *     for a mistake that is not there.
 *   • `unmarked` — the month EXISTS and the days are still missing. After S741 that can only come
 *     from a failed back-fill or a hand-deleted row, and it IS actionable: `backfillApprovedLeave`
 *     on each named period writes them.
 *
 * Months earlier than the client's first period are ignored entirely — that is before they were
 * on Crest, so an approved request back there is imported history, not a gap anyone will close.
 *
 * @returns {Promise<{waiting: Array, unmarked: Array, error: any}>}
 */
export async function findApprovedLeaveGaps({ clientId, requests, periods }) {
  const none = { waiting: [], unmarked: [], error: null }
  if (!clientId || !(periods || []).length) return none

  // The floor: the earliest month this client has a period for.
  const floor = (periods || []).reduce(
    (min, p) => (p.bs_year * 12 + p.bs_month < min ? p.bs_year * 12 + p.bs_month : min),
    Infinity
  )
  const periodMap = {}
  for (const p of periods) periodMap[`${p.bs_year}:${p.bs_month}`] = p

  const byMonth = new Map()
  const empIds = new Set()
  for (const req of requests || []) {
    if (req.status !== 'approved') continue
    for (const d of workingDaysInRange(req.start_date, req.end_date)) {
      if (d.bsYear * 12 + d.bsMonth < floor) continue
      const k = `${d.bsYear}:${d.bsMonth}`
      if (!byMonth.has(k)) byMonth.set(k, { bsYear: d.bsYear, bsMonth: d.bsMonth, keys: new Set() })
      // employee:day, so two requests covering one day for one person count once — the same key
      // the attendance table is unique on.
      byMonth.get(k).keys.add(`${req.employee_id}:${d.bsDay}`)
      empIds.add(req.employee_id)
    }
  }
  if (byMonth.size === 0) return none

  const waiting = []
  const withPeriod = []
  for (const m of byMonth.values()) {
    const p = periodMap[`${m.bsYear}:${m.bsMonth}`]
    if (p) withPeriod.push({ period: p, keys: m.keys })
    else waiting.push({ bsYear: m.bsYear, bsMonth: m.bsMonth, days: m.keys.size })
  }
  if (withPeriod.length === 0) return { waiting, unmarked: [], error: null }

  // Only the employees who actually have approved leave, so this is a fraction of the month's
  // attendance rather than all of it. Chunked because the id list travels in the URL.
  const periodIds = withPeriod.map(w => w.period.id)
  const { data, error } = await fetchAllRowsChunked([...empIds], chunk =>
    scopedFrom('hr_attendance', clientId, 'period_id, employee_id, bs_day')
      .in('period_id', periodIds).in('employee_id', chunk).order('id'))
  // A failed read here must not report "nothing is missing" — that is the most reassuring answer
  // the function has, and it is exactly what an error would produce.
  if (error) return { waiting, unmarked: [], error }

  const markedByPeriod = new Map()
  for (const a of data || []) {
    if (!markedByPeriod.has(a.period_id)) markedByPeriod.set(a.period_id, new Set())
    markedByPeriod.get(a.period_id).add(`${a.employee_id}:${a.bs_day}`)
  }
  const unmarked = []
  for (const w of withPeriod) {
    const marked = markedByPeriod.get(w.period.id) || new Set()
    const missing = [...w.keys].filter(k => !marked.has(k)).length
    if (missing) unmarked.push({ period: w.period, days: missing })
  }
  return { waiting, unmarked, error: null }
}
