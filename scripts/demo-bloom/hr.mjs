// Staff: records, pay setup, roster, attendance, leave, overtime, a loan, travel claims, a shift
// swap — and the Shrawan and Bhadra payroll, worked out by the app's own payroll code.
import { rngFor, uid, ts, round2 } from './lib.mjs'
import { STAFF, OWNER_ID, BS_YEAR, BASE_CUTOFF, MONTHS } from './config.mjs'
import { adOf, monthDays, BS_MONTHS } from './calendar.mjs'
import { buildPayrollRows, ytdFromPayslips, allocateAdvanceRepayments } from '../../src/modules/hr/payroll/payrollData.js'
import { DEFAULT_LEAVE_TYPES } from '../../src/modules/hr/leave/leaveConstants.js'
import { planSeed } from '../../src/modules/hr/holidays/holidayData.js'

const SHIFT_DEFS = {
  ktm: { morning: ['Morning', '#3B82F6', '07:00', '15:00', 8, 8], mid: ['Day', '#06B6D4', '09:00', '17:00', 8, 8],
         evening: ['Evening', '#8B5CF6', '12:00', '20:00', 8, 8], full: ['Full Day', '#4338CA', '08:00', '20:00', 12, 8], off: ['Day Off', '#6B7280', null, null, 0, null] },
  pkr: { morning: ['Morning', '#3B82F6', '07:00', '15:00', 8, 8], mid: ['Day', '#06B6D4', '09:00', '17:00', 8, 8],
         evening: ['Evening', '#8B5CF6', '13:00', '21:00', 8, 8], full: ['Full Day', '#4338CA', '08:00', '21:00', 13, 8], off: ['Day Off', '#6B7280', null, null, 0, null] },
}
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }

// Who has which weekday off (0 Sunday … 6 Saturday; nobody is off on busy Saturday).
const WEEKLY_OFF = { sita: 2, ramesh: 3, bikash: 1, sunita: 4, prakash: 1, anjali: 3, hari: 0, kamala: 4,
  rajan: 2, mina: 4, suman: 3, dipak: 1, laxmi: 0 }
// The till logins at each outlet and the role each plays.
export const TILL = { ktm: { manager: 'sita', cashier: 'anjali', captain: 'prakash' }, pkr: { manager: 'rajan', cashier: 'suman', captain: 'dipak' } }

export function buildHr({ outlet, days, cutoff, periodIdOf }) {
  const o = outlet.key, cid = outlet.clientId
  const id = (...k) => uid(o, ...k)
  const R = rngFor(o, 'hr')
  const staff = STAFF[o]
  const empId = k => id('emp', k)
  const firstAd = days[0].ad

  // ── Records ──
  const employees = staff.map((s, i) => ({
    id: empId(s.key), client_id: cid, employee_code: `${o === 'ktm' ? 'BC' : 'BP'}-${String(i + 1).padStart(3, '0')}`,
    full_name: s.name, gender: s.gender, date_of_birth: s.dob, pan_no: s.pan || null, citizenship_no: `${R.int(10, 75)}-01-${R.int(70, 81)}-${R.int(10000, 99999)}`,
    designation: s.designation, department: s.dept, employment_type: s.employment || 'permanent', join_date: s.join,
    status: s.status || 'active', phone: `98000${o === 'ktm' ? '6' : '7'}${String(1100 + i * 13).padStart(4, '0')}`,
    address: o === 'ktm' ? R.pick(['Kalanki, Kathmandu', 'Kirtipur', 'Satdobato, Lalitpur', 'Balkhu, Kathmandu', 'Imadol, Lalitpur']) : R.pick(['Bagar, Pokhara', 'Lamachaur, Pokhara', 'Hemja, Kaski']),
    emergency_contact_name: `${R.pick(['Hari', 'Maya', 'Kumar', 'Gita', 'Ram'])} ${s.name.split(' ').slice(-1)[0]}`, emergency_contact_phone: `98000${o === 'ktm' ? '8' : '9'}${String(2000 + i * 17).padStart(4, '0')}`,
    bank_name: s.bank || null, bank_account_no: s.acct || null, bank_branch: s.bank ? (o === 'ktm' ? 'Jhamsikhel' : 'Lakeside') : null,
    ssf_no: s.ssf, basic_salary: s.basic, pay_basis: s.payBasis || 'monthly', marital_status: s.marital,
    ssf_enrolled: s.ssfEnrolled ?? !!s.ssf, life_insurance_premium: 0, health_insurance_premium: 0, access_blocked: false,
    created_at: ts(s.join < firstAd ? addDaysIso(firstAd, -30) : s.join, 600), updated_at: ts(s.join < firstAd ? addDaysIso(firstAd, -30) : s.join, 600),
  }))
  const supervisorKey = o === 'ktm' ? 'sita' : 'rajan'
  const supervisorLinks = staff.filter(s => s.key !== supervisorKey).map(s => ({ id: empId(s.key), supervisor_id: empId(supervisorKey) }))

  const components = []
  for (const s of staff) {
    if (s.allowance > 0) components.push({ id: id('comp', s.key, 'allow'), client_id: cid, employee_id: empId(s.key), name: 'Allowance', type: 'earning', calc_type: 'fixed', value: s.allowance, retirement_fund: false, created_at: ts(firstAd, 500) })
  }
  components.push({ id: id('comp', supervisorKey, 'cit'), client_id: cid, employee_id: empId(supervisorKey), name: 'CIT Contribution', type: 'deduction', calc_type: 'fixed', value: o === 'ktm' ? 1500 : 1000, retirement_fund: true, created_at: ts(firstAd, 500) })

  const shiftDefs = SHIFT_DEFS[o]
  const shiftTypes = Object.entries(shiftDefs).map(([k, [name, color, st, en, hours, regular]], i) => ({
    id: id('shift-type', k), client_id: cid, name, color, start_time: st, end_time: en, hours, sort_order: i + 1, active: true,
    regular_hours: regular, created_at: ts(firstAd, 480),
  }))
  const shiftTypeId = k => id('shift-type', k)

  const leaveTypes = DEFAULT_LEAVE_TYPES.map(t => ({ id: id('leave-type', t.code), client_id: cid, name: t.name, code: t.code, paid: t.paid,
    annual_quota: t.annual_quota, carry_forward: t.carry_forward, color: t.color, active: true, sort_order: t.sort_order, created_at: ts(firstAd, 480) }))

  // Holiday calendar (the gazette seed), with demand multipliers on the Dashain days for the forecast.
  const holidays = planSeed(BS_YEAR, []).toInsert.map(h => {
    let mult = null
    if (/Ghatasthapana/.test(h.name)) mult = o === 'ktm' ? 1.1 : 1.2
    else if (/Fulpati/.test(h.name)) mult = o === 'ktm' ? 0.9 : 1.25
    else if (/Dashain/.test(h.name)) mult = o === 'ktm' ? 0.65 : 1.35
    else if (/Tihar|Laxmi Puja|Bhai Tika|Mha Puja/.test(h.name)) mult = o === 'ktm' ? 0.8 : 1.15
    return { id: id('holiday', h.bs_year, h.bs_month, h.bs_day, h.name), client_id: cid, ...h, created_at: ts(firstAd, 470), demand_multiplier: mult }
  })
  const publicHoliday = new Set(holidays.filter(h => h.holiday_type === 'public' && h.bs_year === BS_YEAR).map(h => `${h.bs_month}-${h.bs_day}`))

  // ── Leave, absences ──
  const L = o === 'ktm'
    ? [['sunita', 'sick', 4, 14, 4, 15, 'approved', 'Fever'], ['ramesh', 'home', 5, 24, 5, 26, 'approved', 'Family puja at home'],
       ['kamala', 'unpaid', 6, 8, 6, 8, 'approved', 'Personal work'],
       ['ramesh', 'home', 6, 26, 6, 30, 'pending', 'Going home for Dashain'], ['kamala', 'home', 7, 7, 7, 9, 'pending', 'Dashain — visiting the village']]
    : [['mina', 'home', 5, 10, 5, 11, 'approved', 'Sister’s wedding'], ['laxmi', 'home', 6, 27, 6, 29, 'pending', 'Going home before Dashain']]
  const leaveRequests = []
  const leaveDay = {}        // `${key}:${m}-${d}` → paid_leave | unpaid_leave
  for (const [k, code, m1, d1, m2, d2, status0, reason] of L) {
    const start = adOf(m1, d1), end = adOf(m2, d2)
    // Waiting on the demo day; a top-up that reaches two days before the leave approves it.
    const status = status0 === 'pending' && addDaysIso(start, -2) <= cutoff.ad ? 'approved' : status0
    const nDays = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1
    const madeAd = addDaysIso(start, -R.int(4, 9))
    leaveRequests.push({ id: id('leave', k, start), client_id: cid, employee_id: empId(k), leave_type_id: id('leave-type', code),
      start_date: start, end_date: end, days: nDays, reason, status, decided_at: status === 'approved' ? ts(addDaysIso(madeAd, 1), 660) : null,
      note: null, created_at: ts(madeAd, 630), day_type: 'full', decided_by: status === 'approved' ? OWNER_ID : null })
    if (status0 === 'pending' && status === 'approved') leaveRequests[leaveRequests.length - 1].decided_at = ts(addDaysIso(start, -2), 660)
    if (status === 'approved') {
      for (let i = 0; i < nDays; i++) {
        const ad = addDaysIso(start, i)
        const day = days.find(x => x.ad === ad)
        if (day) leaveDay[`${k}:${day.key}`] = code === 'unpaid' ? 'unpaid_leave' : 'paid_leave'
      }
    }
  }
  const absent = new Set(o === 'ktm' ? ['prakash:5-5', 'prakash:5-6', 'prakash:6-14'] : ['dipak:6-4'])

  // ── Roster (through the end of Ashoj) and who is in each day ──
  const rosterDays = []
  // Rostered and published to the end of Ashoj, or a week past a later cut-off.
  const rosterUntil = [adOf(6, monthDays(6)), addDaysIso(cutoff.ad, 7)].sort()[1]
  for (const m of MONTHS) for (let d = 1; d <= monthDays(m); d++) if (adOf(m, d) <= rosterUntil) rosterDays.push({ m, d, ad: adOf(m, d), wd: new Date(adOf(m, d) + 'T00:00:00Z').getUTCDay(), key: `${m}-${d}` })
  const roster = []
  const shiftOf = {}          // `${key}:${dayKey}` → shift kind
  const till = TILL[o]
  for (const day of rosterDays) {
    for (const s of staff) {
      if (s.join > day.ad) continue
      let kind = s.shift
      if (WEEKLY_OFF[s.key] === day.wd) kind = 'off'
      // When one of the two till supervisors is off, the other covers the whole day.
      const other = s.key === till.manager ? till.cashier : s.key === till.cashier ? till.manager : null
      if (other && WEEKLY_OFF[other] === day.wd && kind !== 'off') kind = 'full'
      shiftOf[`${s.key}:${day.key}`] = kind
      roster.push({ id: id('roster', s.key, day.key), client_id: cid, employee_id: empId(s.key), shift_type_id: shiftTypeId(kind),
        bs_year: BS_YEAR, bs_month: day.m, bs_day: day.d, note: null, created_at: ts(addDaysIso(day.ad, -7 - day.wd), 1000) })
    }
  }
  const publishState = rosterDays.map(day => ({ id: id('pub', day.key), client_id: cid, bs_year: BS_YEAR, bs_month: day.m, bs_day: day.d,
    published_at: ts(addDaysIso(day.ad, -((day.wd + 2) % 7) - 1), 1080), published_by: OWNER_ID }))

  const working = (k, day) => {
    const kind = shiftOf[`${k}:${day.key}`]
    return kind && kind !== 'off' && !leaveDay[`${k}:${day.key}`] && !absent.has(`${k}:${day.key}`)
  }
  const shiftWindow = (k, day) => {
    const kind = shiftOf[`${k}:${day.key}`]
    const def = shiftDefs[kind]
    return def && def[2] ? [toMin(def[2]), toMin(def[3])] : null
  }
  // A till login on duty at minute t, best rank first.
  const onAt = (k, day, t) => { if (!working(k, day)) return false; const w = shiftWindow(k, day); return w && t >= w[0] && t <= w[1] }

  // ── Overtime ──
  const otEntries = []
  // The three public holidays the first build covered, plus every public holiday a top-up reaches.
  const otHolidays = ['5-12', '5-19', '6-3', ...[...publicHoliday].filter(k => { const [m, d] = k.split('-').map(Number); return MONTHS.includes(m) && adOf(m, d) > BASE_CUTOFF.ad })]
  for (const dk of otHolidays) {
    const day = days.find(x => x.key === dk)
    if (!day) continue
    for (const s of staff) if (working(s.key, day)) otEntries.push({ id: id('ot', s.key, dk), client_id: cid, employee_id: empId(s.key), bs_year: BS_YEAR,
      bs_month: day.m, bs_day: day.d, ot_hours: 8, ot_type: 'holiday', reason: 'Worked on a public holiday', status: 'approved', created_at: ts(day.ad, 1230) })
  }
  const satExtra = o === 'ktm' ? [['ramesh', '4-24'], ['sunita', '5-21'], ['ramesh', '6-6']] : [['mina', '5-14']]
  const extraHours = {}
  for (const [k, dk] of satExtra) {
    const day = days.find(x => x.key === dk)
    if (!day || !working(k, day)) continue
    extraHours[`${k}:${dk}`] = 2
    otEntries.push({ id: id('ot', k, dk), client_id: cid, employee_id: empId(k), bs_year: BS_YEAR, bs_month: day.m, bs_day: day.d,
      ot_hours: 2, ot_type: 'weekday', reason: 'Busy Saturday — stayed late', status: 'approved', created_at: ts(day.ad, 1260) })
  }
  const pendingOt = o === 'ktm' ? [['prakash', '6-20', 3, 'Stayed for a private party booking']] : [['suman', '6-21', 2, 'Late tourist group']]
  for (const [k, dk, h, reason] of pendingOt) {
    const day = days.find(x => x.key === dk)
    if (!day || !working(k, day)) continue
    extraHours[`${k}:${dk}`] = h
    otEntries.push({ id: id('ot', k, dk), client_id: cid, employee_id: empId(k), bs_year: BS_YEAR, bs_month: day.m, bs_day: day.d,
      // Waiting on the demo day; approved once that month's payroll is run (the 3rd of the next month).
      ot_hours: h, ot_type: 'weekday', reason, status: cutoff.ad >= adOf(day.m + 1, 3) ? 'approved' : 'pending', created_at: ts(day.ad, 1290) })
  }

  // ── Attendance, up to the cut-off day ──
  const attendance = []
  for (const day of days) {
    for (const s of staff) {
      if (s.join > day.ad) continue
      const k = s.key, kind = shiftOf[`${k}:${day.key}`]
      const base = { id: id('att', k, day.key), client_id: cid, employee_id: empId(k), period_id: periodIdOf(day.m), bs_day: day.d,
        note: null, created_at: ts(day.ad, 1290), start_time: null, end_time: null, break_minutes: null, hours_worked: 0, ot_hours: 0 }
      if (leaveDay[`${k}:${day.key}`]) { attendance.push({ ...base, status: leaveDay[`${k}:${day.key}`] }); continue }
      if (absent.has(`${k}:${day.key}`)) { attendance.push({ ...base, status: 'absent', note: 'Did not come, no call' }); continue }
      if (kind === 'off') { attendance.push({ ...base, status: publicHoliday.has(day.key) ? 'holiday' : 'weekly_off' }); continue }
      const def = shiftDefs[kind]
      const extra = extraHours[`${k}:${day.key}`] || 0
      const late = R.chance(0.08) ? R.int(5, 20) : 0
      const st = toMin(def[2]) + late, en = toMin(def[3]) + extra * 60
      attendance.push({ ...base, status: 'present', start_time: hhmm(st), end_time: hhmm(en), break_minutes: 30,
        hours_worked: def[4] + extra, ot_hours: (def[4] - (def[5] ?? def[4])) + extra })
    }
  }

  // ── Advances and travel claims ──
  const advances = []
  if (o === 'ktm') {
    advances.push({ id: id('adv', 'ramesh'), client_id: cid, employee_id: empId('ramesh'), type: 'loan', issued_date: adOf(4, 11), amount: 30000,
      installment_amount: 5000, purpose: 'Family medical expense', status: 'active', notes: null, created_at: ts(adOf(4, 11), 700) })
    advances.push({ id: id('adv', 'sunita'), client_id: cid, employee_id: empId('sunita'), type: 'advance', issued_date: adOf(5, 20), amount: 5000,
      installment_amount: 5000, purpose: 'Advance before Dashain shopping', status: 'active', notes: null, created_at: ts(adOf(5, 20), 700) })
  } else {
    advances.push({ id: id('adv', 'dipak'), client_id: cid, employee_id: empId('dipak'), type: 'advance', issued_date: adOf(6, 12), amount: 4000,
      installment_amount: 4000, purpose: 'Rent deposit', status: 'active', notes: null, created_at: ts(adOf(6, 12), 700) })
  }
  const tada = [], tadaItems = []
  const addClaim = (k, key, purpose, dest, m1, d1, m2, d2, status, lines, approvedAt) => {
    const cl = { id: id('tada', key), client_id: cid, employee_id: empId(k), trip_purpose: purpose, destination: dest,
      start_date: adOf(m1, d1), end_date: adOf(m2, d2), total_amount: lines.reduce((s, l) => s + l[2], 0), status,
      submitted_by: OWNER_ID, approved_by: status === 'pending' ? null : OWNER_ID, approved_at: approvedAt || null, paid_at: null, paid_method: null,
      notes: null, created_at: ts(adOf(m2, d2), 1100), start_point: 'Cafe', final_settlement_id: null }
    tada.push(cl)
    lines.forEach(([cat, desc, amt], i) => tadaItems.push({ id: id('tada-item', key, i), claim_id: cl.id, category: cat, description: desc, amount: amt }))
    return cl
  }
  if (o === 'ktm') addClaim('sita', 'sita-pkr', 'Branch visit', 'Pokhara — Lakeside branch', 5, 22, 5, 23, 'approved',
    [['Transport', 'Tourist bus Kathmandu–Pokhara, return', 2400], ['Lodging', 'Guest house, 1 night', 2500], ['Daily Allowance', '2 days × NPR 750', 1500]], ts(adOf(5, 25), 640))
  if (o === 'pkr') addClaim('rajan', 'rajan-ktm', 'Purchase', 'Kathmandu — coffee roaster and suppliers', 6, 15, 6, 16, cutoff.ad >= adOf(6, 25) ? 'approved' : 'pending',
    [['Transport', 'Bus Pokhara–Kathmandu, return', 2200], ['Daily Allowance', '2 days × NPR 750', 1500]], cutoff.ad >= adOf(6, 25) ? ts(adOf(6, 25), 640) : null)

  // ── A shift swap waiting for the manager ──
  const swaps = []
  if (o === 'pkr') swaps.push({ id: id('swap', 1), client_id: cid, requester_employee_id: empId('dipak'), target_employee_id: empId('suman'),
    bs_year: BS_YEAR, bs_month: 6, requester_bs_day: 26, target_bs_day: 26, requester_shift_type_id: shiftTypeId(shiftOf['dipak:6-26']),
    target_shift_type_id: shiftTypeId(shiftOf['suman:6-26']), status: 'pending_admin', note: 'Family function in the evening',
    target_responded_at: ts(BASE_CUTOFF.ad, 600), created_at: ts(addDaysIso(BASE_CUTOFF.ad, -1), 1260) })
  if (o === 'ktm') swaps.push({ id: id('swap', 1), client_id: cid, requester_employee_id: empId('sunita'), target_employee_id: empId('anjali'),
    bs_year: BS_YEAR, bs_month: 6, requester_bs_day: 27, target_bs_day: 27, requester_shift_type_id: shiftTypeId(shiftOf['sunita:6-27']),
    target_shift_type_id: shiftTypeId(shiftOf['anjali:6-27']), status: 'pending_admin', note: 'Doctor appointment in the morning',
    target_responded_at: ts(BASE_CUTOFF.ad, 560), created_at: ts(addDaysIso(BASE_CUTOFF.ad, -1), 1200) })

  // A swap still waiting when its day comes is turned down by the manager (the roster stands).
  for (const sw of swaps) {
    const dayAd = adOf(sw.bs_month, sw.requester_bs_day)
    if (addDaysIso(dayAd, -1) <= cutoff.ad) Object.assign(sw, { status: 'rejected_by_admin', admin_decided_by: OWNER_ID, admin_decided_at: ts(addDaysIso(dayAd, -1), 600) })
  }
  const headcountOf = day => staff.filter(s => s.join <= day.ad && working(s.key, day)).length

  return { employees, supervisorLinks, components, shiftTypes, leaveTypes, holidays, leaveRequests, roster, publishState,
    otEntries, attendance, advances, tada, tadaItems, swaps, working, onAt, headcountOf, empId, shiftOf }
}

// Payroll for one closed month, through the app's own engine. `prior` carries earlier months'
// finalized payslips (for the year-to-date tax) and repayments.
export function runPayroll({ outlet, hr, period, monthAd, prior, finalizedAt, createdAt, runId }) {
  const cid = outlet.clientId
  const periodEnd = monthAd.end
  const employees = hr.employees.filter(e => e.join_date <= periodEnd)
  const attendance = hr.attendance.filter(a => a.period_id === period.id)
  const otEntries = hr.otEntries.filter(x => x.bs_month === period.bs_month && x.status === 'approved')
  const tadaMap = {}
  hr.tada.filter(c => (c.status === 'approved' || c._paidBy === runId) && c.end_date <= periodEnd && !c._paidBy).forEach(c => {
    const e = tadaMap[c.employee_id] || { total: 0, ids: [] }
    e.total += c.total_amount; e.ids.push(c.id)
    tadaMap[c.employee_id] = e
  })
  const ytdMap = ytdFromPayslips(prior.payslips, [], period)
  const rows = buildPayrollRows({ runId, period, employees, components: hr.components, attendance, otEntries,
    advances: hr.advances, repayments: prior.repayments, ytdMap, tadaMap })
  const payslips = rows.map(r => ({ ...r.payslip, id: uid(outlet.key, 'payslip', runId, r.payslip.employee_id), run_id: runId, client_id: cid, created_at: createdAt }))
  const { repayRows } = allocateAdvanceRepayments({ payslips, advances: hr.advances, repayments: prior.repayments, period, runId,
    repaidDate: finalizedAt.slice(0, 10), note: `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} payroll` })
  const repayments = repayRows.map((r, i) => ({ ...r, id: uid(outlet.key, 'repay', runId, i), client_id: cid, created_at: finalizedAt }))
  // Travel claims this run pays become Paid.
  for (const ids of Object.values(tadaMap)) for (const cid2 of ids.ids) {
    const c = hr.tada.find(x => x.id === cid2)
    Object.assign(c, { status: 'paid', paid_at: finalizedAt, paid_method: 'Payroll', _paidBy: runId })
  }
  const run = { id: runId, client_id: cid, period_id: period.id, status: 'finalized', created_at: createdAt, finalized_at: finalizedAt }
  // Embedded shape ytdFromPayslips expects, for the next month.
  const embedded = payslips.map(p => ({ ...p, hr_payroll_runs: { status: 'finalized', monthly_periods: { bs_year: period.bs_year, bs_month: period.bs_month } } }))
  return { run, payslips, repayments, embedded, rows }
}

function hhmm(min) { return `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}` }
function addDaysIso(ad, n) { return new Date(Date.parse(ad + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10) }
export { round2 }
