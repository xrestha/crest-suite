import { scopedFrom, scopedUpsert } from '../../../shared/scopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
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
 * Dashain and family trips — had nowhere to write. `approveRequest()` approved it anyway, which is
 * right, and printed "Create the period(s), then re-approve to mark those days".
 *
 * That instruction could not be followed. The period cannot be opened early (the index refuses it),
 * an approved row has no Approve button to press later, and nothing anywhere back-filled: the
 * Attendance Sheet reads `hr_attendance` and never looks at `hr_leave_requests`. The result was an
 * approved unpaid leave that was silently PAID in full when its month finally came round, with the
 * Leave page and the attendance sheet each looking correct on their own.
 *
 * This runs at the one moment the write becomes possible — when the period is minted — so no one
 * has to remember a warning from three months ago.
 *
 * Two properties are deliberate:
 *
 *   • **It only fills days that have no attendance row yet.** At period creation that is every day,
 *     so the common path is unaffected; but the same helper is what the Leave page's catch-up
 *     banner calls, and there a month may already have marks on it. A months-old approval silently
 *     overwriting a day someone marked `present` by hand is a worse failure than the one being
 *     fixed. Skipped days are counted and reported rather than dropped.
 *   • **It reports rather than throws.** Period creation must never fail because of an HR read;
 *     the caller records `{ filled, skipped, error }` alongside its own result and surfaces it,
 *     because a best-effort second write's silence proves nothing (CLAUDE.md, "two writes in one
 *     function can diverge").
 *
 * @param {{clientId: string, period: {id: string, bs_year: number, bs_month: number}}} args
 * @returns {Promise<{filled: number, skipped: number, employees: number, error: any}>}
 */
export async function backfillApprovedLeave({ clientId, period }) {
  const empty = { filled: 0, skipped: 0, employees: 0, error: null }
  if (!clientId || !period?.id || !period.bs_year || !period.bs_month) return empty

  // The AD window this BS month occupies, as plain date strings — `start_date`/`end_date` are
  // `date` columns. formatAd, never .toISOString(): bsToAd returns LOCAL midnight, and at Nepal's
  // UTC+05:45 .toISOString() lands on the previous day (CLAUDE.md).
  const firstAd = bsToAd(period.bs_year, period.bs_month, 1)
  const lastAd = bsToAd(period.bs_year, period.bs_month, daysInBsMonth(period.bs_year, period.bs_month))
  if (!firstAd || !lastAd || isNaN(firstAd) || isNaN(lastAd)) return empty
  const monthStart = formatAd(firstAd)
  const monthEnd = formatAd(lastAd)

  // Overlap, not containment: a leave running Ashwin 29 → Kartik 3 belongs partly to this month,
  // and the day filter below keeps only the days that are actually in it.
  const [reqRes, typeRes, attRes] = await Promise.all([
    scopedFrom('hr_leave_requests', clientId, 'id, employee_id, leave_type_id, start_date, end_date, day_type')
      .eq('status', 'approved').lte('start_date', monthEnd).gte('end_date', monthStart),
    scopedFrom('hr_leave_types', clientId, 'id, paid'),
    // One row per employee per day: 40 staff on a 31-day month is already 1,240, so a bare
    // .select() would silently truncate at 1,000 — and a truncated "already marked" set does not
    // read as an error, it reads as free days to fill, which would overwrite real marks.
    fetchAllRows(() => scopedFrom('hr_attendance', clientId, 'employee_id, bs_day')
      .eq('period_id', period.id).order('employee_id').order('bs_day').order('id')),
  ])
  // A failed read is not "no approved leave" — returning `filled: 0` on an error would report the
  // month as fully synced and hide exactly the days this exists to rescue.
  const readErr = reqRes.error || typeRes.error || attRes.error
  if (readErr) return { ...empty, error: readErr }

  const requests = reqRes.data || []
  if (requests.length === 0) return empty
  const paidById = Object.fromEntries((typeRes.data || []).map(t => [t.id, t.paid !== false]))
  // Days already carrying a mark — keyed employee:day, so a pre-existing row is never overwritten.
  const taken = new Set((attRes.data || []).map(a => `${a.employee_id}:${a.bs_day}`))

  const rows = []
  let skipped = 0
  for (const req of requests) {
    const isHalf = req.day_type && req.day_type !== 'full'
    const status = paidById[req.leave_type_id]
      ? (isHalf ? 'half_paid_leave' : 'paid_leave')
      : (isHalf ? 'half_unpaid_leave' : 'unpaid_leave')
    for (const d of workingDaysInRange(req.start_date, req.end_date)) {
      if (d.bsYear !== period.bs_year || d.bsMonth !== period.bs_month) continue
      const key = `${req.employee_id}:${d.bsDay}`
      if (taken.has(key)) { skipped += 1; continue }
      // Two approved requests overlapping one day would otherwise send the same key twice in one
      // upsert, which Postgres refuses outright ("cannot affect row a second time") and would lose
      // the whole month's back-fill over one double-booking.
      taken.add(key)
      rows.push({ employee_id: req.employee_id, period_id: period.id, bs_day: d.bsDay, status })
    }
  }
  if (rows.length === 0) return { ...empty, skipped }

  const { error } = await scopedUpsert('hr_attendance', clientId, rows, { onConflict: 'employee_id,period_id,bs_day' })
  if (error) return { filled: 0, skipped, employees: 0, error }
  return { filled: rows.length, skipped, employees: new Set(rows.map(r => r.employee_id)).size, error: null }
}

/**
 * The sentence for a back-fill result — what the new month now contains, not what ran.
 * Returns '' when there is nothing worth saying (the overwhelmingly common case).
 */
export function backfillLeaveText({ filled, skipped, employees, error }, monthLabel) {
  if (error) {
    return `${monthLabel} was created, but leave already approved for it could not be marked on the attendance sheet. ` +
      `Open HR → Leave and use "Mark approved leave" there, or those days will not be deducted in payroll.`
  }
  if (!filled) return ''
  const who = employees === 1 ? '1 employee' : `${employees} employees`
  const skip = skipped ? ` ${skipped} day${skipped === 1 ? '' : 's'} already had an attendance mark and were left alone.` : ''
  return `${filled} day${filled === 1 ? '' : 's'} of leave approved earlier for ${monthLabel} (${who}) were marked on its attendance sheet.${skip}`
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
