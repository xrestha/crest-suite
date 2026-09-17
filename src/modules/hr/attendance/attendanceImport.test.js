import { readCell, dateTokenOf, detectMapping, readAttendance, guessMatches } from './attendanceImport'
import { planImport, machineDayKind, describeMachineDay, stillIncomplete, SKIP } from './attendanceImportPlan'
import { bsToAd } from '../../../utils/bsCalendar'

const BHADRA = { id: 'bhadra', bs_year: 2083, bs_month: 5 }
const SHRAWAN = { id: 'shrawan', bs_year: 2083, bs_month: 4 }
const pad = n => String(n).padStart(2, '0')
const adOf = day => bsToAd(2083, 5, day)
const iso = dt => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`

// Casa Açaí Cafe's Bhadra 2083 export from its ZKTeco clock, as SheetJS hands it over
// (blank rows dropped, summary columns kept).
const CASA_BHADRA = [
  ['Monthly Check In&Out Report'],
  ['Export Time: 2083-06-01 10:57'],
  ['Operator: admin'],
  ['Time Period: 2083-05-01 - 2083-05-31'],
  ['First Name', 'Last Name', 'ID', 'Department', 'Attendance Group', '05-01', '05-02', '05-03', '05-04', '05-05', '05-06', '05-07', '05-08', '05-09', '05-10', '05-11', '05-12', '05-13', '05-14', '05-15', '05-16', '05-17', '05-18', '05-19', '05-20', '05-21', '05-22', '05-23', '05-24', '05-25', '05-26', '05-27', '05-28', '05-29', '05-30', '05-31', 'Total Work Hours', 'Normal', 'Late', 'Early Leave', 'Absent', 'Workday Overtime', 'Overtime on Weekend', 'Overtime on Holidays', 'OT1', 'OT2', 'OT3'],
  ['sarita', '-', '5', 'All Departments', '-', '08:05-20:00', '10:57-20:07', '-', '11:01-20:09', '11:03-20:03', '11:04-20:05', '11:03-20:00', '07:58-20:00', '11:04-20:01', '-', '10:50-20:01', '11:01-19:23', '11:03-20:22', '16:58-None', '-', '11:10-19:59', '08:06-17:00', '08:11-17:00', '08:06-16:05', '08:06-18:31', '11:07-19:57', '11:02-20:01', '08:10-19:59', '10:59-20:28', '11:03-20:00', '11:59-19:59', '08:07-11:08', '-', '-', '-', '-', '208 : 51', '208 : 51', '00 : 00', '00 : 00', '189 : 00', '00 : 00', '00 : 00', '00 : 00', '-', '-', '-'],
  ['ronish', '-', '3', 'All Departments', '-', '-', '08:35-20:06', '08:29-20:23', '08:05-17:00', '08:12-17:09', '07:50-None', '08:09-16:59', '-', '20:01-None', '08:06-20:10', '08:07-17:00', '08:09-16:46', '08:07-17:02', '12:05-20:05', '08:11-20:00', '-', '11:09-20:00', '08:11-20:06', '11:03-20:09', '11:05-20:25', '07:58-16:59', '08:08-18:03', '-', '08:22-16:59', '08:10-17:00', '08:09-17:00', '11:01-20:02', '08:11-20:14', '08:02-20:00', '07:59-20:49', '08:07-20:03', '250 : 19', '250 : 19', '00 : 00', '00 : 00', '153 : 00', '00 : 00', '00 : 00', '00 : 00', '-', '-', '-'],
  ['dipen', '-', '2', 'All Departments', '-', '-', '-', '-', '-', '-', '-', '11:07-None', '-', '-', '10:17-12:54', '-', '-', '-', '-', '12:40-13:03', '-', '-', '11:24-None', '-', '-', '11:30-11:31', '-', '-', '-', '11:20-None', '10:02-10:08', '-', '-', '-', '10:20-12:53', '10:21-14:36', '09 : 53', '09 : 53', '00 : 00', '00 : 00', '279 : 00', '00 : 00', '00 : 00', '00 : 00', '-', '-', '-'],
  ['ananad', '-', '1', 'All Departments', '-', '08:01-20:00', '-', '10:52-20:23', '10:49-20:00', '10:49-20:00', '10:46-20:03', '11:39-20:00', '07:55-20:00', '-', '10:54-20:05', '10:56-20:00', '10:55-19:36', '11:00-20:20', '07:56-16:59', '10:49-19:59', '07:51-20:00', '07:48-17:01', '-', '07:54-16:59', '07:57-17:30', '10:52-19:59', '-', '08:02-19:59', '10:51-20:17', '10:54-19:59', '10:55-19:59', '07:54-18:00', '07:54-20:10', '07:59-19:59', '-', '07:59-20:02', '258 : 57', '258 : 57', '00 : 00', '00 : 00', '63 : 00', '00 : 00', '00 : 00', '00 : 00', '-', '-', '-'],
]

describe('readCell', () => {
  it('reads a first-in/last-out pair, a lone punch and a dash', () => {
    expect(readCell('08:05-20:00').punches).toEqual([485, 1200])
    expect(readCell('20:01-None').punches).toEqual([1201])
    expect(readCell('-')).toEqual({ punches: [], mark: null })
    expect(readCell('')).toEqual({ punches: [], mark: null })
  })
  it('reads Excel times, 12-hour clocks, dotted times and a date in the cell', () => {
    expect(readCell(0.3368055556).punches).toEqual([485])
    expect(readCell(new Date(1899, 11, 30, 20, 0, 59, 993)).punches).toEqual([1201])
    expect(readCell('8:05 AM - 8:00 p.m.').punches).toEqual([485, 1200])
    expect(readCell('12:10 am').punches).toEqual([10])
    expect(readCell('17.08.2026 8.05').punches).toEqual([485])
    expect(readCell('2026-08-17 20:01:10').punches).toEqual([1201])
    expect(readCell('08:05\n13:00\n14:00\n20:00').punches).toEqual([485, 780, 840, 1200])
  })
  it('never reads a count, hours worked or a summary total as a punch', () => {
    expect(readCell(8.5).punches).toEqual([])
    expect(readCell(5).punches).toEqual([])
    expect(readCell('208 : 51').punches).toEqual([])
  })
  it('reads a mark written instead of times, a plain leave as unpaid', () => {
    expect(readCell('A').mark).toBe('absent')
    expect(readCell('P').mark).toBe('present')
    expect(readCell('Off').mark).toBe('weekly_off')
    expect(readCell('PH').mark).toBe('holiday')
    expect(readCell('Paid Leave').mark).toBe('paid_leave')
    expect(readCell('Leave').mark).toBe('unpaid_leave')
    expect(readCell('Training').mark).toBe(null)
  })
})

describe('dateTokenOf', () => {
  it('keeps what the file wrote until the whole file decides the reading', () => {
    expect(dateTokenOf('05-01')).toEqual({ a: 5, b: 1 })
    expect(dateTokenOf('2083-05-01')).toEqual({ y: 2083, a: 5, b: 1, ymd: true })
    expect(dateTokenOf('17/08/2026')).toEqual({ y: 2026, a: 17, b: 8 })
    expect(dateTokenOf('17-Aug-26')).toEqual({ y: 2026, a: 8, b: 17, en: true })
    expect(dateTokenOf('Mon 3', { dayOnly: true })).toEqual({ d: 3 })
    expect(dateTokenOf('3', { dayOnly: true })).toEqual({ d: 3 })
    expect(dateTokenOf('3')).toBe(null)
    expect(dateTokenOf('Total Work Hours', { dayOnly: true })).toBe(null)
  })
})

describe('the Casa Açaí Bhadra 2083 machine export', () => {
  it('is found as a month grid under its four-line report heading', () => {
    expect(detectMapping(CASA_BHADRA)).toEqual({
      layout: 'grid', headerRow: 4, nameCol: 0, lastNameCol: 1, idCol: 2, firstDayCol: 5, lastDayCol: 35,
    })
  })

  it('reads 05-01 as 1 Bhadra, every person, and every day of the month', () => {
    const r = readAttendance(CASA_BHADRA, detectMapping(CASA_BHADRA), BHADRA)
    expect(r.error).toBeUndefined()
    expect(r.mode.cal).toBe('bs')
    expect(r.coverage).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
    expect(r.outside).toBe(0)
    expect(r.people.map(p => [p.id, p.name])).toEqual([['5', 'sarita'], ['3', 'ronish'], ['2', 'dipen'], ['1', 'ananad']])
    const sarita = r.people[0]
    expect(sarita.days[1]).toEqual({ in: '8:05', out: '20:00', mark: null })
    expect(sarita.days[3]).toBeUndefined()
    expect(sarita.days[14]).toEqual({ in: '16:58', out: null, mark: null })
    expect(sarita.dataDays).toBe(24)
    const ronish = r.people[1]
    expect(ronish.days[9]).toEqual({ in: '20:01', out: null, mark: null })
    expect(machineDayKind(r.people[2].days[21])).toBe('odd')
    expect(describeMachineDay(r.people[2].days[21])).toBe('11:30–11:31, 1 min apart')
  })

  it('refuses to read Bhadra into Shrawan, and names the month it is for', () => {
    expect(readAttendance(CASA_BHADRA, detectMapping(CASA_BHADRA), SHRAWAN)).toEqual({ error: 'wrong-month', fileMonth: { year: 2083, month: 5 } })
  })
})

describe('other layouts', () => {
  it('reads one row per person per day, with day-first English dates', () => {
    const dmy = d => { const dt = adOf(d); return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}` }
    const rows = [
      ['Daily Attendance'],
      ['Emp Code', 'Employee Name', 'Date', 'Clock In', 'Clock Out', 'Work Time'],
      ['E01', 'Sarita Thapa', dmy(1), '08:05', '20:00', '11:55'],
      ['E01', 'Sarita Thapa', dmy(2), '', '17:30', ''],
      ['E01', 'Sarita Thapa', dmy(3), 'Absent', '', ''],
      ['E02', 'Ronish', dmy(3), 0.3368055556, 0.7083333333, ''],
    ]
    const mapping = detectMapping(rows)
    expect(mapping).toMatchObject({ layout: 'daily', headerRow: 1, idCol: 0, nameCol: 1, dateCol: 2, inCol: 3, outCol: 4 })
    const r = readAttendance(rows, mapping, BHADRA)
    expect(r.mode).toEqual({ cal: 'ad', order: 'dm' })
    expect(r.coverage).toEqual([1, 2, 3])
    const [sarita, ronish] = r.people
    expect(sarita.days).toEqual({
      1: { in: '8:05', out: '20:00', mark: null },
      2: { in: null, out: '17:30', mark: null },
      3: { in: null, out: null, mark: 'absent' },
    })
    expect(ronish.days[3]).toEqual({ in: '8:05', out: '17:00', mark: null })
  })

  it('reads a machine log with no header, and closes a night shift after midnight', () => {
    const at = (day, time) => `${iso(adOf(day))} ${time}`
    const rows = [
      ['     1', at(1, '08:05:10'), '1', '0'],
      ['     1', at(1, '20:01:00'), '1', '1'],
      ['     1', at(2, '18:00:00'), '1', '0'],
      ['     1', at(3, '01:30:00'), '1', '1'],
      ['     2', at(2, '07:50:00'), '1', '0'],
      ['     2', at(3, '09:00:00'), '1', '0'],
      ['     2', at(3, '17:00:00'), '1', '1'],
    ]
    const mapping = detectMapping(rows)
    expect(mapping).toMatchObject({ layout: 'punches', headerRow: -1, idCol: 0, timeCol: 1 })
    const r = readAttendance(rows, mapping, BHADRA)
    const [one, two] = r.people
    expect(one.days).toEqual({
      1: { in: '8:05', out: '20:01', mark: null },
      2: { in: '18:00', out: '1:30', mark: null },
    })
    expect(two.days).toEqual({
      2: { in: '7:50', out: null, mark: null },
      3: { in: '9:00', out: '17:00', mark: null },
    })
    expect(r.coverage).toEqual([1, 2, 3])
  })

  it('reads a punch list with separate date and time columns under a header', () => {
    const rows = [
      ['User ID', 'Name', 'Date', 'Time', 'Verify Mode'],
      ['5', 'sarita', iso(adOf(4)), '11:01:00', 'FP'],
      ['5', 'sarita', iso(adOf(4)), '20:09:00', 'FP'],
    ]
    const mapping = detectMapping(rows)
    expect(mapping).toMatchObject({ layout: 'punches', headerRow: 0, idCol: 0, nameCol: 1, timeCol: 3, dateCol: 2 })
    expect(readAttendance(rows, mapping, BHADRA).people[0].days[4]).toEqual({ in: '11:01', out: '20:09', mark: null })
  })

  it('reads a hand-kept register: bare day numbers, marks, and a person over two rows', () => {
    const rows = [
      ['S.N.', 'Staff', 1, 2, 3, 4, 5, 6, 7, 8],
      [1, 'Sarita', '8:00', '8:10', 'Off', 'A', 'P', '', 'Leave', 'PL'],
      ['', '', '20:00', '17:00', '', '', '', '', '', ''],
    ]
    const mapping = detectMapping(rows)
    expect(mapping).toMatchObject({ layout: 'grid', headerRow: 0, nameCol: 1, firstDayCol: 2, lastDayCol: 9 })
    const r = readAttendance(rows, mapping, BHADRA)
    expect(r.people).toHaveLength(1)
    expect(r.people[0].days).toEqual({
      1: { in: '8:00', out: '20:00', mark: null },
      2: { in: '8:10', out: '17:00', mark: null },
      3: { in: null, out: null, mark: 'weekly_off' },
      4: { in: null, out: null, mark: 'absent' },
      5: { in: null, out: null, mark: 'present' },
      7: { in: null, out: null, mark: 'unpaid_leave' },
      8: { in: null, out: null, mark: 'paid_leave' },
    })
  })

  it('does not mistake a row of daily hours for a header or a punch', () => {
    const rows = [['Name', 'Mon', 'Tue'], ['Sarita', 8, 9.5]]
    expect(detectMapping(rows)).toBe(null)
  })
})

describe('guessMatches', () => {
  const employees = [
    { id: 'e-sarita', full_name: 'Sarita Thapa', employee_code: 'CAC-05' },
    { id: 'e-ronish', full_name: 'Ronish Shrestha', employee_code: '' },
    { id: 'e-anand', full_name: 'Anand Rai', employee_code: '' },
    { id: 'e-dipesh', full_name: 'Dipesh Karki', employee_code: '' },
  ]
  const people = [
    { key: 'id:5', id: '5', name: 'sarita' },
    { key: 'id:3', id: '3', name: 'ronish' },
    { key: 'id:2', id: '2', name: 'dipen' },
    { key: 'id:1', id: '1', name: 'ananad' },
  ]
  it('guesses from a first name and from a one-letter misspelling, and not from a different name', () => {
    const g = guessMatches(people, employees)
    expect(g['id:5']).toEqual({ employeeId: 'e-sarita', how: 'name and code' })
    expect(g['id:3']).toEqual({ employeeId: 'e-ronish', how: 'name' })
    expect(g['id:1']).toEqual({ employeeId: 'e-anand', how: 'similar spelling' })
    expect(g['id:2']).toBeUndefined()
  })
  it('makes no guess when two employees fit equally', () => {
    const g = guessMatches([{ key: 'name:sarita', id: '', name: 'sarita' }],
      [{ id: 'a', full_name: 'Sarita Thapa' }, { id: 'b', full_name: 'Sarita Rai' }])
    expect(g).toEqual({})
  })
})

describe('planImport', () => {
  const read = readAttendance(CASA_BHADRA, detectMapping(CASA_BHADRA), BHADRA)
  const shiftTypesById = {
    morning: { id: 'morning', name: 'Morning', hours: 9 },
    dayoff: { id: 'dayoff', name: 'Day Off', hours: 0 },
    pl: { id: 'pl', name: 'PAID LEAVE', hours: 0 },
  }
  const employees = [
    { id: 'e-sarita', full_name: 'Sarita Thapa', join_date: null, end_date: null },
    { id: 'e-ronish', full_name: 'Ronish Shrestha', join_date: iso(adOf(5)), end_date: null },
  ]
  const autoHours = (empId, day, start, end, breakMinutes) => ({ hours_worked: 11, ot_hours: 2, breakSeen: breakMinutes })
  const base = {
    people: read.people, coverage: read.coverage,
    matches: { 'id:5': 'e-sarita', 'id:3': 'e-ronish', 'id:2': SKIP, 'id:1': SKIP },
    employees, period: BHADRA, shiftTypesById, autoHours, breakMinutes: 45,
    today: { year: 2083, month: 5, day: 20 },
  }
  const run = (records = {}, rosterByKey = {}) => planImport({ ...base, records, rosterByKey })
  const find = (plan, key) => plan.changes.find(c => c.key === key)

  it('fills a blank worked day with the machine times, the break and the sheet\'s own hours', () => {
    const c = find(run(), 'e-sarita:1')
    expect(c.kind).toBe('worked')
    expect(c.cell).toMatchObject({ employee_id: 'e-sarita', bs_day: 1, status: 'present', start_time: '8:05', end_time: '20:00', break_minutes: 45, hours_worked: 11, ot_hours: 2 })
  })

  it('flags an incomplete day as Present with hours blank', () => {
    const c = find(run(), 'e-sarita:14')
    expect(c.kind).toBe('flagged')
    expect(c.cell).toMatchObject({ status: 'present', start_time: '16:58', end_time: '', hours_worked: '', ot_hours: '' })
    expect(c.machine).toBe('16:58 only')
  })

  it('follows the roster on a day with no punch, and leaves an unrostered one blank', () => {
    const plan = run({}, { 'e-sarita:3': 'dayoff', 'e-sarita:10': 'morning', 'e-sarita:15': 'pl' })
    expect(find(plan, 'e-sarita:3').cell).toEqual({ employee_id: 'e-sarita', bs_day: 3, status: 'weekly_off', start_time: '', end_time: '', break_minutes: '', hours_worked: '', ot_hours: '' })
    expect(find(plan, 'e-sarita:10').kind).toBe('absent')
    expect(find(plan, 'e-sarita:15').cell.status).toBe('paid_leave')
    expect(plan.byEmployee['e-sarita']).toMatchObject({ off: 2, absent: 1, blank: 0 })
    expect(find(run(), 'e-sarita:10')).toBeUndefined()
    expect(run().byEmployee['e-sarita'].blank).toBe(3)
  })

  it('changes a Present day\'s times, keeps its own break, and never touches leave', () => {
    const records = {
      'e-sarita:2': { employee_id: 'e-sarita', bs_day: 2, status: 'present', start_time: '11:00', end_time: '20:00', break_minutes: 30 },
      'e-sarita:4': { employee_id: 'e-sarita', bs_day: 4, status: 'paid_leave' },
      'e-sarita:5': { employee_id: 'e-sarita', bs_day: 5, status: 'present', start_time: '11:03', end_time: '20:03' },
    }
    const plan = run(records)
    const upd = find(plan, 'e-sarita:2')
    expect(upd.kind).toBe('updated')
    expect(upd.before).toBe(records['e-sarita:2'])
    expect(upd.cell).toMatchObject({ start_time: '10:57', end_time: '20:07', break_minutes: 30 })
    expect(find(plan, 'e-sarita:4')).toBeUndefined()
    expect(plan.conflicts).toEqual([{ key: 'e-sarita:4', employeeId: 'e-sarita', day: 4, status: 'paid_leave', machine: '11:01–20:09' }])
    expect(find(plan, 'e-sarita:5')).toBeUndefined()
  })

  it('marks nothing after today, nor before an employee joined', () => {
    const plan = run({}, { 'e-sarita:28': 'morning' })
    expect(plan.changes.some(c => c.day > 20)).toBe(false)
    expect(plan.changes.some(c => c.employeeId === 'e-ronish' && c.day < 5)).toBe(false)
    expect(plan.skipped.future).toBe(22)
    expect(plan.skipped.notEmployed).toBe(4)
  })

  it('leaves a day with no punch yet today alone', () => {
    const plan = planImport({ ...base, today: { year: 2083, month: 5, day: 3 }, records: {}, rosterByKey: { 'e-sarita:3': 'morning' } })
    expect(find(plan, 'e-sarita:3')).toBeUndefined()
  })
})

describe('stillIncomplete', () => {
  it('holds until both times make a shift, or the day stops being a working day', () => {
    expect(stillIncomplete({ status: 'present', start_time: '16:58', end_time: '' })).toBe(true)
    expect(stillIncomplete({ status: 'present', start_time: '11:30', end_time: '11:31' })).toBe(true)
    expect(stillIncomplete({ status: 'present', start_time: '11:00', end_time: '20:00' })).toBe(false)
    expect(stillIncomplete({ status: 'absent' })).toBe(false)
    expect(stillIncomplete(undefined)).toBe(false)
  })
})
