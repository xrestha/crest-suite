// Reading a time-clock or attendance export into days — no React, no Supabase and no xlsx: the
// dialog reads the workbook and hands each sheet over as rows of cells (S775).
//
// Every machine, and every clerk who retypes one, lays the sheet out differently, so nothing here
// assumes a fixed shape. Three layouts are recognised from the header row, wherever it sits:
//   • grid    — one row per person, one column per day, the day's punches in the cell
//               ("08:05-20:00" — a ZKTeco "Monthly Check In&Out Report")
//   • daily   — one row per person per day: a date column plus In / Out columns
//   • punches — one row per punch: a person and a date-time
// When none is found, the dialog lets the reader name the columns (a `mapping`) and the same
// reader runs on what they picked. A cell may also hold a mark instead of times (P, A, Off, H,
// Leave), which is how a hand-kept register reads.
import { adToBs, bsToAd, daysInBsMonth } from '../../../utils/bsCalendar'
import { zeroHourStatus } from './attendanceFromRoster'

export const HEADER_SCAN_ROWS = 40
const MIN_GRID_DAYS = 7
// A lone punch before 5 AM in a punch list closes the shift that began the evening before, when
// that evening has a punch of its own.
export const NIGHT_CUTOFF_MIN = 5 * 60

const clean = v => (v == null || v instanceof Date ? '' : String(v)).replace(/[\s ]+/g, ' ').trim()
const low = v => clean(v).toLowerCase()
const isDashes = s => /^[-–—_./]*$/.test(s)

// ── Times ────────────────────────────────────────────────────────────────────

/** Minutes past midnight as the sheet shows a time: "8:05" (AttendanceSheet's parseTimeInput). */
export function formatMinutes(min) {
  const m = ((min % 1440) + 1440) % 1440
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

// Excel stores a time as a fraction of a day, so 20:01 can come back as 20:00:59.993. Rounding to
// the second first keeps that on 20:01; a real 20:01:40 still reads 20:01, as a clock shows it.
const minutesOfSeconds = secs => Math.floor(Math.round(secs) / 60) % 1440
const minutesOfDate = d => minutesOfSeconds(d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000)

function timesInText(s) {
  // A date in the same cell ("2026-08-17 08:05:12", "17.08.2026 8.05") goes first, or its
  // separators could read as a time. A dot only separates hours from minutes when no colon does.
  const text = s
    .replace(/\d{4}([-/.])\d{1,2}\1\d{1,2}/g, ' ')
    .replace(/(^|\D)\d{1,2}([-/.])\d{1,2}\2\d{2,4}(?=\D|$)/g, '$1 ')
  const re = text.includes(':')
    ? /(^|\D)(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:\s*([ap])\.?\s*m\b\.?)?/gi
    : /(^|\D)(\d{1,2})\.(\d{2})(?:\s*([ap])\.?\s*m\b\.?)?/gi
  const out = []
  let m
  while ((m = re.exec(text))) {
    let h = parseInt(m[2], 10)
    const min = parseInt(m[3], 10)
    if (min > 59) continue
    const ap = (m[4] || '').toLowerCase()
    if (ap) {
      if (h < 1 || h > 12) continue
      if (ap === 'a' && h === 12) h = 0
      if (ap === 'p' && h < 12) h += 12
    }
    if (h === 24 && min === 0) h = 0
    if (h > 23) continue
    out.push(h * 60 + min)
  }
  return out
}

// A mark written instead of times. A leave that does not say paid is UNPAID — the reading
// Generate from Roster gives a roster "LEAVE" (zeroHourStatus, decided 2026-09-13).
const MARKS = [
  [/^(p|pr|present)$/, 'present'],
  [/^(a|ab|abs|absent)$/, 'absent'],
  [/^(hd|half|half ?day|½|1\/2)$/, 'half_day'],
  [/^(w|o|wo|w\/o|off|off ?day|day ?off|weekly ?off|week ?off|rest|rest ?day)$/, 'weekly_off'],
  [/^(h|ph|hol|holiday|public ?holiday)$/, 'holiday'],
  [/^pl$/, 'paid_leave'],
  [/^(ul|lwp|l|lv)$/, 'unpaid_leave'],
]
function markOf(s) {
  const t = s.toLowerCase().replace(/\./g, '').trim()
  for (const [re, status] of MARKS) if (re.test(t)) return status
  return t.includes('leave') ? zeroHourStatus(t) : null
}

const EMPTY_CELL = Object.freeze({ punches: [], mark: null })

/**
 * What one cell says about a day: the clock times in it, in the order written, or a mark.
 * "-", "None", a blank, a count or anything unrecognised says nothing.
 */
export function readCell(v) {
  if (v == null || v === '') return EMPTY_CELL
  if (v instanceof Date) return isNaN(v.getTime()) ? EMPTY_CELL : { punches: [minutesOfDate(v)], mark: null }
  if (typeof v === 'number') {
    // Only a fraction of a day (a time) or a serial date-time carries a clock time. A whole number
    // is a count or a code, and 8.5 is hours worked — neither is a punch.
    if (!Number.isFinite(v) || v <= 0) return EMPTY_CELL
    if (v < 1) return { punches: [minutesOfSeconds(v * 86400)], mark: null }
    if (v > 20000 && v % 1 > 0) return { punches: [minutesOfSeconds((v % 1) * 86400)], mark: null }
    return EMPTY_CELL
  }
  const s = clean(v)
  if (isDashes(s)) return EMPTY_CELL
  const punches = timesInText(s)
  if (punches.length) return { punches, mark: null }
  return { punches: [], mark: markOf(s) }
}

// ── Dates ────────────────────────────────────────────────────────────────────

const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const enMonth = word => { const i = EN_MONTHS.indexOf(word.slice(0, 3)); return i === -1 ? null : i + 1 }
// A two-digit year: 83 is BS 2083, 26 is AD 2026.
const fullYear = y => (y.length === 4 ? parseInt(y, 10) : 2000 + parseInt(y, 10))

/**
 * A date as the file wrote it, before its calendar or its order is known:
 *   { y, a, b, ymd } — with a year; `ymd` when the year came first, so a/b are month/day
 *   { a, b }         — "05-01": month-day or day-month, decided across the whole file
 *   { y?, a, b, en } — an English month name was written, so a is the month and the date is AD
 *   { d }            — a bare day number, only where `dayOnly` (a grid's column headings)
 */
export function dateTokenOf(v, { dayOnly = false } = {}) {
  if (v instanceof Date) {
    if (isNaN(v.getTime()) || v.getFullYear() < 1901) return null
    return { y: v.getFullYear(), a: v.getMonth() + 1, b: v.getDate(), ymd: true }
  }
  if (typeof v === 'number') {
    if (dayOnly && Number.isInteger(v) && v >= 1 && v <= 32) return { d: v }
    if (v > 20000 && v < 80000) {
      const dt = new Date(1899, 11, 30 + Math.floor(v))
      return { y: dt.getFullYear(), a: dt.getMonth() + 1, b: dt.getDate(), ymd: true }
    }
    return null
  }
  const s = low(v)
    .replace(/t?\s*\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(\s*[ap]\.?\s*m\.?)?/g, ' ')
    .replace(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b\.?/g, ' ')
    .replace(/[()[\],]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return null
  let m
  if ((m = s.match(/^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/))) return { y: +m[1], a: +m[3], b: +m[4], ymd: true }
  if ((m = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})$/))) return { y: fullYear(m[4]), a: +m[1], b: +m[3] }
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/))) return { a: +m[1], b: +m[2] }
  if ((m = s.match(/^(\d{1,2})[- ]?([a-z]{3,9})\.?[- ]?(\d{4}|\d{2})?$/)) && enMonth(m[2])) {
    return { y: m[3] ? fullYear(m[3]) : null, a: enMonth(m[2]), b: +m[1], en: true }
  }
  if ((m = s.match(/^([a-z]{3,9})\.?[- ]?(\d{1,2})[- ]?(\d{4}|\d{2})?$/)) && enMonth(m[1])) {
    return { y: m[3] ? fullYear(m[3]) : null, a: enMonth(m[1]), b: +m[2], en: true }
  }
  if (dayOnly && (m = s.match(/^(?:d|day)?\s*(\d{1,2})(?:st|nd|rd|th)?$/))) {
    const d = +m[1]
    return d >= 1 && d <= 32 ? { d } : null
  }
  return null
}

// A year from 2060 on is Bikram Sambat; AD will not reach it while this code is in use.
const calendarOfYear = y => (y >= 2060 ? 'bs' : 'ad')

function realDate(cal, y, month, day) {
  if (!(month >= 1 && month <= 12 && day >= 1)) return null
  if (cal === 'bs') return day <= daysInBsMonth(y, month) ? { year: y, month, day } : null
  const dt = new Date(y, month - 1, day)
  if (dt.getMonth() !== month - 1 || dt.getDate() !== day) return null
  return adToBs(dt)
}

const inPeriod = (r, period) => !!r && r.year === period.bs_year && r.month === period.bs_month

function addMonths(year, month, by) {
  const i = year * 12 + (month - 1) + by
  return { year: Math.floor(i / 12), month: (i % 12) + 1 }
}

/**
 * A token as a BS date { year, month, day } under one reading of the file, or null when it is not
 * a real date that way. `mode` = { cal: 'bs'|'ad', order: 'md'|'dm', dayMonth? }.
 * `dayMonth` is the month a bare day number belongs to (from the report's own "Time Period"
 * line); without it a bare day is a day of the month on screen. `tok.wrap` counts the times a
 * run of day headings went back to 1.
 */
export function resolveDate(tok, mode, period) {
  if (!tok) return null
  if (tok.d != null) {
    const base = mode.dayMonth || { cal: 'bs', year: period.bs_year, month: period.bs_month }
    const { year, month } = addMonths(base.year, base.month, tok.wrap || 0)
    return realDate(base.cal, year, month, tok.d)
  }
  const [month, day] = tok.ymd || tok.en || mode.order === 'md' ? [tok.a, tok.b] : [tok.b, tok.a]
  if (tok.y != null) return realDate(tok.en ? 'ad' : calendarOfYear(tok.y), tok.y, month, day)
  if (!tok.en && mode.cal === 'bs') return realDate('bs', period.bs_year, month, day)
  // An English date with no year: whichever of the two AD years this BS month touches puts it
  // inside the month.
  const first = bsToAd(period.bs_year, period.bs_month, 1).getFullYear()
  for (const y of [first, first + 1]) {
    const r = realDate('ad', y, month, day)
    if (inPeriod(r, period)) return r
  }
  return realDate('ad', first, month, day)
}

const MODES = [
  { cal: 'bs', order: 'md' }, { cal: 'bs', order: 'dm' },
  { cal: 'ad', order: 'md' }, { cal: 'ad', order: 'dm' },
]

/**
 * Which reading of the file's dates fits: the calendar and order under which the most of them are
 * real dates, then the one putting the most inside the month on screen. Real dates must come
 * first — read day-first, a Bhadra grid's "05-04" is Shrawan 5, so "most inside Shrawan" would
 * pour one column of Bhadra punches into Shrawan. `hint` is what the report's header block
 * says; `forced` is what the reader picked. Returns { mode, inside, valid, fileMonth, calendar } —
 * `fileMonth` is the BS month most dates fall in, so a file for another month can be named, and
 * `calendar` is the one most dates were actually read in (a date with a year says its own).
 */
export function chooseDateMode(tokens, period, { hint = null, forced = {} } = {}) {
  let modes = MODES.filter(m => (!forced.cal || m.cal === forced.cal) && (!forced.order || m.order === forced.order))
  if (!forced.cal && hint?.cal) {
    const hinted = modes.filter(m => m.cal === hint.cal)
    if (hinted.length) modes = hinted
  }
  const dayMonth = forced.cal && hint?.dayMonth && hint.dayMonth.cal !== forced.cal ? null : (hint?.dayMonth || null)
  let best = null
  for (const base of modes) {
    const mode = { ...base, dayMonth }
    let inside = 0, valid = 0, bs = 0
    const months = new Map()
    for (const t of tokens) {
      const r = resolveDate(t, mode, period)
      if (!r) continue
      valid += 1
      if (inPeriod(r, period)) inside += 1
      const cal = t.en ? 'ad' : t.y != null ? calendarOfYear(t.y) : t.d != null ? (dayMonth?.cal || 'bs') : mode.cal
      if (cal === 'bs') bs += 1
      const k = r.year * 12 + r.month - 1
      months.set(k, (months.get(k) || 0) + 1)
    }
    if (!best || valid > best.valid || (valid === best.valid && inside > best.inside)) {
      let fileMonth = null, most = 0
      for (const [k, n] of months) if (n > most) { most = n; fileMonth = { year: Math.floor(k / 12), month: (k % 12) + 1 } }
      best = { mode, inside, valid, fileMonth, calendar: bs * 2 >= valid ? 'bs' : 'ad' }
    }
  }
  return best
}

// What the report says it covers, from the rows above its table — "Time Period: 2083-05-01 -
// 2083-05-31". A cell holding two dates is the range; a lone date is used only when it is not the
// export or print stamp. It decides the calendar for dates written without a year and the month a
// bare day number belongs to.
export function headerBlockHint(aoa, headerRow) {
  let range = null, single = null
  for (let r = 0; r < Math.max(0, headerRow); r++) {
    for (const cell of aoa[r] || []) {
      const s = clean(cell)
      const dates = [...s.matchAll(/(\d{4})([-/.])(\d{1,2})\2(\d{1,2})/g)].map(m => ({ y: +m[1], a: +m[3], b: +m[4], ymd: true }))
      if (dates.length >= 2 && !range) range = [dates[0], dates[dates.length - 1]]
      else if (dates.length === 1 && !single && !/export|print|generat|creat|download|run|operator/i.test(s)) single = dates[0]
    }
  }
  const first = range ? range[0] : single
  if (!first) return null
  const cal = calendarOfYear(first.y)
  return { cal, dayMonth: { cal, year: first.y, month: first.a }, range }
}

// ── Layout ───────────────────────────────────────────────────────────────────

const HEADER = {
  id: /^((employee|emp|user|staff|person|badge|card|enroll(ment)?|ac|machine|device|att(endance)?|bio(metric)?|member)[\s._-]*)?(id|no|num|number|code|pin)$|^ac-no$/,
  name: /^((employee|emp|staff|person|user|member)[\s._-]*)?(full[\s._-]*)?name$|^(first|given)[\s._-]*name$|^employee$|^staff$/,
  lastName: /^(last|sur|family)[\s._-]*name$|^surname$/,
  punches: /^(punches|punch[\s._-]*records?|records|times|check[\s._-]*in[\s._&/-]*out|in[\s._&/-]*out|all[\s._-]*punches)$/,
  in: /^((check|clock|punch|time|sign)[\s._-]*in|in|first[\s._-]*(in|punch)|on[\s._-]*duty|arrival|entry|start)([\s._-]*time)?$/,
  out: /^((check|clock|punch|time|sign)[\s._-]*out|out|last[\s._-]*(out|punch)|off[\s._-]*duty|departure|exit|end)([\s._-]*time)?$/,
  time: /^((punch|check|clock|record|log|att(endance)?|verify)[\s._-]*)?(date[\s._/&-]*)?time$|^timestamp$|^datetime$/,
  date: /^((att(endance)?|work|punch|record|log|check)[\s._-]*)?date$|^day$/,
}
const HEADER_ORDER = ['id', 'name', 'lastName', 'punches', 'in', 'out', 'time', 'date']
// A row number, not anyone's identity.
const SERIAL = /^(s|sl|sr|serial|row)[\s._-]*(n|no|num|number)?$|^#$/

const headerText = v => low(v).replace(/\(.*?\)/g, '').replace(/[:*]+$/, '').replace(/\.$/, '').trim()

/** Which column holds what, read from a header row's words. -1 where there is none. */
export function namedColumns(row) {
  const cols = { id: -1, name: -1, lastName: -1, punches: -1, in: -1, out: -1, time: -1, date: -1 }
  ;(row || []).forEach((cell, c) => {
    const h = headerText(cell)
    if (!h || SERIAL.test(h)) return
    for (const key of HEADER_ORDER) {
      if (cols[key] === -1 && HEADER[key].test(h)) { cols[key] = c; break }
    }
  })
  return cols
}

// The run of day columns in a header row: at least a week of date-like headings side by side.
// Bare numbers must count up (1, 2, 3 … back to 1 after a month end), so a row of figures is never
// mistaken for one.
function dayRunOf(row, taken) {
  let best = [], run = []
  ;(row || []).forEach((cell, c) => {
    if (taken.has(c)) return
    const tok = dateTokenOf(cell, { dayOnly: true })
    if (!tok) return
    if (run.length && c - run[run.length - 1].c > 2) { if (run.length > best.length) best = run; run = [] }
    run.push({ c, tok })
  })
  if (run.length > best.length) best = run
  if (best.length < MIN_GRID_DAYS) return null
  if (best.every(f => f.tok.d != null)) {
    let steps = 0
    for (let i = 1; i < best.length; i++) {
      const prev = best[i - 1].tok.d, d = best[i].tok.d
      if (d === prev + 1 || (d === 1 && prev >= 28)) steps += 1
    }
    if (steps < (best.length - 1) * 0.8) return null
  }
  return { first: best[0].c, last: best[best.length - 1].c }
}

// A grid whose name column has no recognisable heading: the column left of the days whose values
// are mostly words.
function wordColumnLeftOf(aoa, headerRow, beforeCol, skip) {
  const rows = aoa.slice(headerRow + 1, headerRow + 16)
  for (let c = 0; c < beforeCol; c++) {
    if (skip.has(c)) continue
    const vals = rows.map(r => clean((r || [])[c])).filter(v => v && !isDashes(v))
    if (vals.length && vals.filter(v => /[a-z]{2}/i.test(v)).length / vals.length >= 0.7) return c
  }
  return -1
}

// With no header row at all (a machine's raw log: "  1  2026-08-17 08:05:00  1  0"), a column
// that is nearly all date-times is the punch time and a column of short codes is the person.
function headerlessPunchMapping(aoa) {
  const rows = aoa.filter(r => (r || []).some(c => c instanceof Date || clean(c))).slice(0, 50)
  if (rows.length < 2) return null
  const width = Math.max(...rows.map(r => r.length))
  const share = test => Array.from({ length: width }, (_, c) => rows.filter(r => test(r[c])).length / rows.length)
  const isStamp = v => {
    const tok = dateTokenOf(v)
    if (!tok || tok.y == null) return false
    return v instanceof Date ? minutesOfDate(v) > 0 : readCell(v).punches.length > 0
  }
  const timeCol = share(isStamp).findIndex(s => s >= 0.8)
  if (timeCol === -1) return null
  const idCol = share(v => !(v instanceof Date) && /^[a-z]{0,4}\d{1,10}$/i.test(clean(v))).findIndex((s, c) => c !== timeCol && s >= 0.8)
  const nameCol = share(v => !(v instanceof Date) && /^[a-z][a-z .'-]{1,40}$/i.test(clean(v))).findIndex((s, c) => c !== timeCol && c !== idCol && s >= 0.8)
  if (idCol === -1 && nameCol === -1) return null
  return { layout: 'punches', headerRow: -1, idCol, nameCol, lastNameCol: -1, timeCol, dateCol: -1 }
}

/**
 * How a sheet is laid out, or null when it cannot be told. The mapping is also what the dialog's
 * "choose the columns" form edits, so a guess and a hand-picked layout run through one reader.
 *   grid:    { layout, headerRow, nameCol, lastNameCol, idCol, firstDayCol, lastDayCol }
 *   daily:   { layout, headerRow, nameCol, lastNameCol, idCol, dateCol, inCol, outCol, cellCol }
 *   punches: { layout, headerRow, nameCol, lastNameCol, idCol, timeCol, dateCol }
 */
export function detectMapping(aoa) {
  const limit = Math.min(aoa.length, HEADER_SCAN_ROWS)
  for (let r = 0; r < limit; r++) {
    const row = aoa[r] || []
    const cols = namedColumns(row)
    const taken = new Set(Object.values(cols).filter(c => c !== -1))
    const days = dayRunOf(row, taken)
    if (days) {
      const nameCol = cols.name !== -1 ? cols.name : wordColumnLeftOf(aoa, r, days.first, taken)
      if (nameCol === -1 && cols.id === -1) continue
      return { layout: 'grid', headerRow: r, nameCol, lastNameCol: cols.lastName, idCol: cols.id, firstDayCol: days.first, lastDayCol: days.last }
    }
    if (cols.name === -1 && cols.id === -1) continue
    const who = { nameCol: cols.name, lastNameCol: cols.lastName, idCol: cols.id }
    if (cols.date !== -1 && (cols.in !== -1 || cols.out !== -1 || cols.punches !== -1)) {
      return { layout: 'daily', headerRow: r, ...who, dateCol: cols.date, inCol: cols.in, outCol: cols.out, cellCol: cols.punches }
    }
    if (cols.time !== -1) {
      return { layout: 'punches', headerRow: r, ...who, timeCol: cols.time, dateCol: cols.date }
    }
  }
  return headerlessPunchMapping(aoa)
}

// ── Reading ──────────────────────────────────────────────────────────────────

const TOTAL_ROW = /^(total|grand total|sub ?total|summary|sum)\b/i

function personOf(row, mapping) {
  const part = c => {
    if (c == null || c < 0) return ''
    const s = clean(row[c])
    return isDashes(s) ? '' : s
  }
  const name = [part(mapping.nameCol), part(mapping.lastNameCol)].filter(Boolean).join(' ')
  const id = part(mapping.idCol)
  if ((!name && !id) || TOTAL_ROW.test(name)) return null
  return { key: id ? `id:${id.toLowerCase()}` : `name:${name.toLowerCase()}`, id, name: name || `ID ${id}` }
}

// The day each grid column stands for. A hand-picked grid whose headings are not dates counts its
// columns as days 1, 2, 3 …
function gridColumns(aoa, mapping) {
  const header = aoa[mapping.headerRow] || []
  const cols = []
  for (let c = mapping.firstDayCol; c <= mapping.lastDayCol; c++) cols.push({ col: c, tok: dateTokenOf(header[c], { dayOnly: true }) })
  if (cols.some(x => !x.tok)) return cols.map((x, i) => ({ col: x.col, tok: { d: i + 1 } }))
  let wrap = 0, prev = 0
  return cols.map(x => {
    if (x.tok.d == null) return x
    if (x.tok.d < prev) wrap += 1
    prev = x.tok.d
    return { col: x.col, tok: { ...x.tok, wrap } }
  })
}

const hasPunch = cell => !!cell && cell.punches.length > 0
const saysSomething = cell => !!cell && (cell.punches.length > 0 || !!cell.mark)

/**
 * Reads the sheet with a mapping. Returns { error, fileMonth? } — 'no-dates', 'wrong-month',
 * 'no-people', 'no-times' — or
 *   {
 *     layout, mode: { cal, order },
 *     people: [{ key, id, name, days: { [bsDay]: { in, out, mark } }, dataDays }],
 *     coverage: [bsDay…]  the days of this month the file speaks for,
 *     outside: number     person-days in the file outside this month,
 *   }
 * `in` / `out` are "H:MM" or null; a day with one distinct time has only `in` (or only `out`,
 * where the file said which). `mark` is a status written instead of times.
 */
export function readAttendance(aoa, mapping, period, { forced = {} } = {}) {
  if (!mapping) return { error: 'no-layout' }
  const hint = headerBlockHint(aoa, mapping.headerRow)
  const entries = []
  const grid = mapping.layout === 'grid' ? gridColumns(aoa, mapping) : null
  let above = null

  for (let r = mapping.headerRow + 1; r < aoa.length; r++) {
    const row = aoa[r] || []
    if (grid) {
      const cells = grid.map(g => ({ tok: g.tok, cell: readCell(row[g.col]) }))
      let person = personOf(row, mapping)
      // A person can run over two rows (check-ins on one, check-outs on the next, the name on the
      // first only); a nameless row carrying times belongs to the person above it.
      if (!person) {
        if (!above || !cells.some(x => saysSomething(x.cell))) continue
        person = above
      }
      above = person
      for (const x of cells) entries.push({ person, tok: x.tok, cell: x.cell })
      continue
    }
    const person = personOf(row, mapping)
    if (!person) continue
    if (mapping.layout === 'daily') {
      const tok = dateTokenOf(row[mapping.dateCol])
      if (!tok) continue
      entries.push({
        person, tok,
        cell: mapping.cellCol >= 0 ? readCell(row[mapping.cellCol]) : null,
        inCell: mapping.inCol >= 0 ? readCell(row[mapping.inCol]) : null,
        outCell: mapping.outCol >= 0 ? readCell(row[mapping.outCol]) : null,
      })
    } else {
      const cell = readCell(row[mapping.timeCol])
      const tok = dateTokenOf(mapping.dateCol >= 0 ? row[mapping.dateCol] : row[mapping.timeCol])
      if (tok && hasPunch(cell)) entries.push({ person, tok, cell, stamp: true })
    }
  }

  if (!entries.length) return { error: 'no-dates' }
  const choice = chooseDateMode(entries.map(e => e.tok), period, { hint, forced })
  if (!choice || choice.valid === 0) return { error: 'no-dates' }
  if (choice.inside === 0) return { error: 'wrong-month', fileMonth: choice.fileMonth }

  const monthDays = daysInBsMonth(period.bs_year, period.bs_month)
  const monthStart = bsToAd(period.bs_year, period.bs_month, 1)
  // The day of this month a resolved date is, counting on past either end (0 is the last day of
  // the month before, monthDays + 1 the first of the next), so a shift can close across the edge.
  const dayIndex = r => {
    if (inPeriod(r, period)) return r.day
    const diff = Math.round((bsToAd(r.year, r.month, r.day) - monthStart) / 86400000)
    return diff + 1
  }

  const people = new Map()
  const coverage = new Set()
  const outsideDays = new Set()
  const slot = (person, idx) => {
    if (!people.has(person.key)) people.set(person.key, { ...person, raw: new Map() })
    const p = people.get(person.key)
    if (!p.raw.has(idx)) p.raw.set(idx, { punches: [], inAt: null, outAt: null, mark: null, stamps: [] })
    return p.raw.get(idx)
  }

  for (const e of entries) {
    const r = resolveDate(e.tok, choice.mode, period)
    if (!r) continue
    const idx = dayIndex(r)
    const inside = idx >= 1 && idx <= monthDays
    if (inside) coverage.add(idx)
    else if (!e.stamp || idx !== monthDays + 1) {
      if (saysSomething(e.cell) || saysSomething(e.inCell) || saysSomething(e.outCell)) outsideDays.add(`${e.person.key}:${r.year}-${r.month}-${r.day}`)
      continue
    }
    const d = slot(e.person, idx)
    if (e.stamp) {
      if (e.cell.punches.length === 1) d.stamps.push(e.cell.punches[0])
      else d.punches.push(...e.cell.punches)
      continue
    }
    if (hasPunch(e.inCell) && d.inAt == null) d.inAt = e.inCell.punches[0]
    if (hasPunch(e.outCell)) d.outAt = e.outCell.punches[e.outCell.punches.length - 1]
    if (e.cell) d.punches.push(...e.cell.punches)
    d.mark = d.mark || e.cell?.mark || e.inCell?.mark || e.outCell?.mark || null
  }

  // A punch list says which days it covers only through its dates — a stretch between the first
  // and last day, widened to the report's own "Time Period" when it states one.
  if (mapping.layout !== 'grid' && coverage.size) {
    let lo = Math.min(...coverage), hi = Math.max(...coverage)
    const range = hint?.range?.map(t => resolveDate(t, choice.mode, period))
    if (range?.[0] && range?.[1]) {
      lo = Math.max(1, Math.min(lo, dayIndex(range[0])))
      hi = Math.min(monthDays, Math.max(hi, dayIndex(range[1])))
    }
    for (let d = lo; d <= hi; d++) coverage.add(d)
  }

  const list = []
  for (const p of people.values()) {
    // Lone stamps before the cutoff close the evening before, when that evening has a stamp.
    for (const [idx, d] of p.raw) {
      const prev = p.raw.get(idx - 1)
      const early = d.stamps.filter(at => at < NIGHT_CUTOFF_MIN)
      if (!early.length || !prev || !(prev.stamps.some(at => at >= NIGHT_CUTOFF_MIN) || prev.punches.length)) continue
      prev.late = (prev.late || []).concat(early.map(at => at + 1440))
      d.stamps = d.stamps.filter(at => at >= NIGHT_CUTOFF_MIN)
    }
    const days = {}
    for (const [idx, d] of [...p.raw].sort((a, b) => a[0] - b[0])) {
      if (idx < 1 || idx > monthDays) continue
      let inAt = d.inAt, outAt = d.outAt
      if (inAt == null && outAt == null) {
        const times = d.punches.length ? d.punches : [...d.stamps, ...(d.late || [])].sort((a, b) => a - b)
        if (times.length) {
          inAt = times[0]
          const last = times[times.length - 1]
          outAt = last !== inAt ? last : null
        }
      } else if (inAt === outAt) {
        outAt = null
      }
      const mark = inAt == null && outAt == null ? d.mark : null
      if (inAt == null && outAt == null && !mark) continue
      days[idx] = { in: inAt == null ? null : formatMinutes(inAt), out: outAt == null ? null : formatMinutes(outAt), mark }
    }
    list.push({ key: p.key, id: p.id, name: p.name, days, dataDays: Object.keys(days).length })
  }
  if (!list.length) return { error: 'no-people' }
  if (!list.some(p => p.dataDays > 0)) return { error: 'no-times' }

  return {
    layout: mapping.layout,
    mode: { cal: choice.calendar, order: choice.mode.order },
    people: list,
    coverage: [...coverage].sort((a, b) => a - b),
    outside: outsideDays.size,
  }
}

// ── Matching people ──────────────────────────────────────────────────────────

const letters = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return row[b.length]
}
const closeSpelling = (a, b) => a.length >= 4 && b.length >= 4 && editDistance(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1)
const trailingNumber = s => { const m = String(s || '').match(/(\d+)\s*$/); return m ? parseInt(m[1], 10) : null }

/**
 * Crest's guess at who each person in the file is, for the reader to confirm (decided 2026-09-17:
 * confirmed on every import, nothing remembered). A name that matches, is contained in the
 * employee's name, or is one letter off their first name ("ananad" → Anand); an employee code
 * equal to the machine ID. Two employees scoring the same for one person is no guess at all.
 * Returns { [personKey]: { employeeId, how } }.
 */
export function guessMatches(people, employees) {
  const scored = []
  for (const p of people) {
    const pn = letters(p.name)
    const pt = pn.split(' ').filter(Boolean)
    for (const e of employees) {
      const en = letters(e.full_name)
      const et = en.split(' ').filter(Boolean)
      let score = 0, how = ''
      if (pn && pn === en) { score = 100; how = 'same name' }
      else if (pt.length && pt.every(t => et.includes(t))) { score = 85; how = 'name' }
      else if (pt.length && et.length && pt.some(t => closeSpelling(t, et[0]))) { score = 65; how = 'similar spelling' }
      const code = clean(e.employee_code)
      if (p.id && code) {
        if (code.toLowerCase() === p.id.toLowerCase()) { score += 65; how = how ? `${how} and code` : 'employee code' }
        else if (score > 0 && trailingNumber(code) != null && trailingNumber(code) === trailingNumber(p.id)) { score += 20; how = `${how} and code` }
      }
      if (score >= 60) scored.push({ person: p.key, employeeId: e.id, score, how })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const out = {}
  const decided = new Set(), used = new Set()
  for (const s of scored) {
    if (decided.has(s.person) || used.has(s.employeeId)) continue
    decided.add(s.person)
    const tied = scored.filter(x => x.person === s.person && x.score === s.score && !used.has(x.employeeId))
    if (tied.length > 1) continue
    out[s.person] = { employeeId: s.employeeId, how: s.how }
    used.add(s.employeeId)
  }
  return out
}
