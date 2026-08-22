import { isOffDay } from '../payrollConstants'

// The Home screen's selectors, kept pure so every state can be tested without a browser or a
// Supabase client. Nothing here fetches: SelfServiceHome already loads the roster, the publish
// state and the swap list for the Roster tab, and Home is built from exactly those — no new RPC,
// no second source of truth for what an employee is working.

export const dayKey = d => `${d.bsYear}-${d.bsMonth}-${d.bsDay}`
const monthKey = d => `${d.bsYear}-${d.bsMonth}`

// A day is only "today" when the whole BS triple matches. Matching on bs_day alone would report
// next month's 6th as today the moment the employee pages the roster forward — the roster is
// fetched per BS month, so a bare day number is ambiguous by construction.
const isSameBsDay = (d, today) => d.bsYear === today.year && d.bsMonth === today.month && d.bsDay === today.day

/**
 * What is this employee doing today?
 *
 * → { state, cell, row } where state is one of:
 *   'unknown'       today is not in the loaded range at all (nothing to say — render nothing)
 *   'unpublished'   the manager has not published this month yet
 *   'not-scheduled' published, and this employee is simply not on it
 *   'off'           a real roster row that names a day off
 *   'working'       a real shift
 *
 * The distinction between the middle three is the whole point: "no shift" and "not published"
 * look identical in the data (get_my_roster only ever returns published days) and mean completely
 * different things to someone deciding whether to come in.
 */
export function todayView({ days, roster, publishMap, today }) {
  if (!days || !roster || !today) return { state: 'unknown' }
  const cell = days.find(d => isSameBsDay(d, today))
  if (!cell) return { state: 'unknown' }
  if (!publishMap?.get(monthKey(cell))) return { state: 'unpublished', cell }
  const row = roster.get(dayKey(cell))
  if (!row) return { state: 'not-scheduled', cell }
  return { state: isOffDay(row.shift_type_name) ? 'off' : 'working', cell, row }
}

/**
 * The next day this employee actually WORKS, strictly after today.
 *
 * Off days are skipped deliberately — "next shift: Day Off" answers a question nobody asked.
 * `days` is expected to cover more than the current week (SelfServiceHome passes this week and
 * next), because the useful answer on a Saturday is Monday, not "nothing".
 *
 * → { cell, row } or null.
 */
export function nextShift({ days, roster, publishMap, today }) {
  if (!days || !roster || !today) return null
  const todayIdx = days.findIndex(d => isSameBsDay(d, today))
  if (todayIdx === -1) return null
  for (const cell of days.slice(todayIdx + 1)) {
    if (!publishMap?.get(monthKey(cell))) continue
    const row = roster.get(dayKey(cell))
    if (row && !isOffDay(row.shift_type_name)) return { cell, row }
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
export function pendingSwapsForMe(swapRequests, myEmployeeId) {
  if (!swapRequests || !myEmployeeId) return []
  return swapRequests.filter(r => r.target_employee_id === myEmployeeId && r.status === 'pending_target')
}
