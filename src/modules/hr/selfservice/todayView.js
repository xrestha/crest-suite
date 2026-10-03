import { shiftKind } from '../payrollConstants'

// The Home screen's selectors, kept pure so every state can be tested without a browser or a
// Supabase client. Nothing here fetches: SelfServiceHome already loads the roster, the publish
// state and the swap list for the Roster tab, and Home is built from exactly those — no new RPC,
// no second source of truth for what an employee is working.

export const dayKey = d => `${d.bsYear}-${d.bsMonth}-${d.bsDay}`

// A day is only "today" when the whole BS triple matches. Matching on bs_day alone would report
// next month's 6th as today the moment the employee pages the roster forward — the roster is
// fetched per BS month, so a bare day number is ambiguous by construction.
const isSameBsDay = (d, today) => d.bsYear === today.year && d.bsMonth === today.month && d.bsDay === today.day

/**
 * What a row from get_my_roster / get_coworker_roster IS: 'work', 'off' or 'leave'.
 *
 * The database sends `shift_kind` (hr_shift_kind, S798), the same answer request_shift_swap decides
 * with, so a "Coffee Bar" or "Holiday Duty" shift is a shift here too. The fallback reads the same
 * rule from what an older row carries (the start time, not the hours), for a database the
 * migration has not reached yet. A row with no shift type at all is a day off, as it always was.
 */
export function rowKind(row) {
  if (!row) return 'off'
  if (row.shift_kind) return row.shift_kind
  if (!row.shift_type_name) return 'off'
  return shiftKind({ name: row.shift_type_name, start_time: row.shift_start, hours: null })
}

/**
 * What is this employee doing today?
 *
 * → { state, cell, row } where state is one of:
 *   'unknown'       today is not in the loaded range at all (nothing to say — render nothing)
 *   'unpublished'   the manager has not published today yet
 *   'not-scheduled' published, and this employee is simply not on it
 *   'off'           a real roster row that names a day off or leave
 *   'working'       a real shift
 *
 * The distinction between the middle three is the whole point: "no shift" and "not published"
 * look identical in the data (get_my_roster only ever returns published days) and mean completely
 * different things to someone deciding whether to come in. Publishing is per DAY, so the test is
 * per day too (S798, ROSTER-4): a month with one published week used to call every draft day of it
 * "not scheduled". `publishedDays` is a Set of dayKey strings.
 */
export function todayView({ days, roster, publishedDays, today }) {
  if (!days || !roster || !today) return { state: 'unknown' }
  const cell = days.find(d => isSameBsDay(d, today))
  if (!cell) return { state: 'unknown' }
  if (!publishedDays?.has(dayKey(cell))) return { state: 'unpublished', cell }
  const row = roster.get(dayKey(cell))
  if (!row) return { state: 'not-scheduled', cell }
  return { state: rowKind(row) === 'work' ? 'working' : 'off', cell, row }
}

/**
 * The next day this employee actually WORKS, strictly after today.
 *
 * Off days are skipped deliberately — "next shift: Day Off" answers a question nobody asked — and
 * so are days not yet published, which say nothing either way. `days` is expected to cover more
 * than the current week (SelfServiceHome passes this week and next), because the useful answer on
 * a Saturday is Monday, not "nothing".
 *
 * → { cell, row } or null.
 */
export function nextShift({ days, roster, publishedDays, today }) {
  if (!days || !roster || !today) return null
  const todayIdx = days.findIndex(d => isSameBsDay(d, today))
  if (todayIdx === -1) return null
  for (const cell of days.slice(todayIdx + 1)) {
    if (!publishedDays?.has(dayKey(cell))) continue
    const row = roster.get(dayKey(cell))
    if (row && rowKind(row) === 'work') return { cell, row }
  }
  return null
}

/**
 * Swap requests that are waiting on THIS employee to answer.
 *
 * Narrower than "my pending requests" on purpose: a swap I sent is waiting on somebody else, and
 * a leave request is waiting on a manager. Neither is an action for me, and putting them under a
 * heading that says something needs doing is how a badge stops meaning anything.
 */
export function pendingSwapsForMe(swapRequests, myEmployeeId, today) {
  if (!swapRequests || !myEmployeeId) return []
  return swapRequests.filter(r => r.target_employee_id === myEmployeeId && r.status === 'pending_target'
    && !(today && swapLapsed(r, today)))
}

/**
 * Whether a swap request can no longer be accepted because one of its two days has gone (S798 3d,
 * ROSTER-3): respond_shift_swap refuses it, so it is not an action, and the badge does not count it.
 * `today` is { year, month, day } in BS.
 */
export function swapLapsed(r, today) {
  if (!r || !today) return false
  const first = Math.min(r.requester_bs_day, r.target_bs_day)
  return r.bs_year * 10000 + r.bs_month * 100 + first < today.year * 10000 + today.month * 100 + today.day
}
