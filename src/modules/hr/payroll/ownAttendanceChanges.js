import { ATTENDANCE_STATUSES } from '../payrollConstants'

// Attendance marks someone made, changed or removed on their OWN row this month, for Payroll Run's
// Finalize confirm (S798 3a, LEAVE-OT-HOLIDAYS-5, owner decision H2 (a)). The rows come from
// hr_own_attendance_changes(period), which reads audit_logs, ordered by employee, day, then time.
// Nothing is refused: daily marking stays easy, and whoever finalizes sees the list first.

const LABEL = Object.fromEntries(ATTENDANCE_STATUSES.map(s => [s.key, s.label]))

// "blank" is the honest word for a removed mark: payroll pays a blank day as worked for monthly staff,
// so removing your own Absent is the same change as marking yourself Present.
const statusLabel = s => (s ? LABEL[s] || s : 'blank')
const num = v => (v === null || v === undefined || v === '' ? null : Number(v))
const hrs = v => (v === null ? '—' : String(Math.round(v * 100) / 100))

export function describeOwnChange(c) {
  const from = c.action === 'INSERT' ? 'blank' : statusLabel(c.old_status)
  const to = c.action === 'DELETE' ? 'blank' : statusLabel(c.new_status)
  const parts = []
  if (from !== to) parts.push(`${from} → ${to}`)
  if (c.action === 'UPDATE') {
    const [oh, nh] = [num(c.old_hours), num(c.new_hours)]
    if (oh !== nh) parts.push(`hours ${hrs(oh)} → ${hrs(nh)}`)
    const [oo, no] = [num(c.old_ot_hours), num(c.new_ot_hours)]
    if (oo !== no) parts.push(`overtime ${hrs(oo)} → ${hrs(no)}`)
  }
  // The function lists an UPDATE only when a paid column changed; times alone are what is left.
  if (parts.length === 0) parts.push(`${to}, times changed`)
  return `day ${c.bs_day}: ${parts.join(', ')}`
}

// One entry per employee, in the order the rows arrived: { employeeId, name, markedBy, lines }.
export function groupOwnChanges(rows) {
  const byEmp = new Map()
  for (const c of rows || []) {
    let g = byEmp.get(c.employee_id)
    if (!g) {
      g = { employeeId: c.employee_id, name: c.employee_name, markedBy: [], lines: [] }
      byEmp.set(c.employee_id, g)
    }
    if (c.marked_by_name && !g.markedBy.includes(c.marked_by_name)) g.markedBy.push(c.marked_by_name)
    g.lines.push(describeOwnChange(c))
  }
  return [...byEmp.values()]
}
