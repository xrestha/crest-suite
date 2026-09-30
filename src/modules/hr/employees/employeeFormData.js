// Pure helpers behind EmployeeForm — no React, no Supabase — so the rule that decides what a save
// WRITES can be tested without rendering a four-tab modal.

// Columns whose empty value must be NULL rather than '' (dates, a uuid, an integer, an enum), plus
// the employee code: '' was stored for a blank code while the tip promised one would be generated.
const NULL_WHEN_BLANK = new Set([
  'employee_code', 'gender', 'date_of_birth', 'pan_no', 'citizenship_no', 'end_date',
  'supervisor_id', 'retirement_date', 'marital_status',
])

// Permanent-address columns mirrored into the current address when "same as permanent" is ticked.
const ADDRESS_PARTS = ['province', 'district', 'municipality', 'ward', 'tole']

// The value a form field is SAVED as.
export function normaliseEmployeeField(key, value) {
  if (key === 'full_name') return String(value || '').trim()
  if (key === 'children_count') {
    if (value === '' || value == null) return null
    const n = parseInt(value, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  if (key === 'same_as_permanent') return !!value
  if (NULL_WHEN_BLANK.has(key)) return value === '' || value == null ? null : value
  return value == null ? '' : value
}

// Two stored values that mean the same thing: NULL and '' are both "blank" for a text column.
function sameValue(a, b) {
  const blank = v => v == null || v === ''
  if (blank(a) && blank(b)) return true
  return String(a) === String(b)
}

// The full payload for a NEW employee: every field the form owns, normalised.
export function newEmployeePayload(form, keys) {
  const out = {}
  keys.forEach(k => { out[k] = normaliseEmployeeField(k, form[k]) })
  return withMirroredAddress(out)
}

// The patch for an EDIT: only the fields whose saved value would actually change.
//
// The form used to write `{ ...form }`, and `form` was the whole row as the list loaded it — up to
// ten minutes old from the session cache — so every Save wrote back basic salary, bank, SSF, pay
// basis, access_blocked, status and end_date as they were when the modal opened. A raise made in
// Pay Setup, a Final Settlement (status resigned, end date, login blocked) or a Deactivate from the
// list, done in the meantime, was silently reversed by an unrelated edit to a phone number. Only
// fields this form OWNS are considered (`keys`), and of those only the ones that differ from the
// row the form opened with — so a concurrent change to anything the user did not touch survives.
export function changedEmployeeFields(original, form, keys) {
  const next = withMirroredAddress(Object.fromEntries(keys.map(k => [k, normaliseEmployeeField(k, form[k])])))
  const patch = {}
  keys.forEach(k => {
    if (!sameValue(original?.[k], next[k])) patch[k] = next[k]
  })
  return patch
}

function withMirroredAddress(row) {
  if (!row.same_as_permanent) return row
  const out = { ...row }
  ADDRESS_PARTS.forEach(p => { out[`temp_${p}`] = out[`perm_${p}`] })
  return out
}

// What `employee_pay_history()` reports, in words. The database refuses the delete for any of
// these (migration 20260914150000); the page asks first so it can say which.
export const PAY_HISTORY_LABELS = {
  finalized_payslips:  'finalized payslips',
  final_settlements:   'a finalized Final Settlement',
  festival_allowances: 'finalized festival allowances',
  advances:            'advances or loans',
  self_service_login:  'a Self-Service login',
}

// An employee write that came back as 0 rows with no error: RLS refused it (writes need HR manager
// rank or the Owner since S798, hr_employees_write_rank_*) or the record went on another screen.
// Employees and Pay Setup are manager pages, so for their readers this is a rank changed mid-session.
export const NOT_SAVED_RLS = 'Nothing was changed: this login may no longer have HR manager rank, or the employee was removed on another screen. Reload to see the record as it is.'

// Statuses that take an employee OFF every payroll picker (Payroll Run, Calculation, Final
// Settlement all filter on active/probation).
export const OFF_PAYROLL_STATUSES = new Set(['inactive', 'resigned', 'terminated'])

// A leaver whose finalized Final Settlement paid their last month cannot simply be set back on
// payroll (S791). Payroll refuses them in that month and every later one, in the CURRENT employment
// — so an employee made Active again with the old join date was rebuilt into every later payslip and
// every Finalize refused it, with no way out named. Taking them back is a rehire: a join date after
// the settled last day starts a new employment, and that is paid. Returns the settled last working
// day (AD 'YYYY-MM-DD') when the save must be refused, or null.
export function rehireNeedsNewJoinDate({ settledLastDay, joinDate, status }) {
  if (status !== 'active' && status !== 'probation') return null
  if (!settledLastDay) return null
  const last = String(settledLastDay).slice(0, 10)
  const join = joinDate ? String(joinDate).slice(0, 10) : null
  return join && join > last ? null : last
}

// Is a stored end date already behind us while the employee is still on payroll? Payroll pays a
// monthly employee NOTHING for days after end_date, so this state zeroes their pay — and before
// S748 the field was hidden unless the type was Contract or Part-time, so it could not be seen.
export function endDateHasPassed(endDate, status, todayAd) {
  if (!endDate || OFF_PAYROLL_STATUSES.has(status)) return false
  return String(endDate).slice(0, 10) < todayAd
}
