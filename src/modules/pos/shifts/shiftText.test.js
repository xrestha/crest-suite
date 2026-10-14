import {
  bsDayLabel, shiftDates, historyRowLabel, asOfLabel, noAnswerLead, isNoAnswer,
  openUnknownText, closeUnknownText, slipNotPrintedText, shiftReadFailLead, cashUnknownText,
  SHIFT_ALREADY_CLOSED_TEXT, SHIFT_ALREADY_OPEN_TEXT, openOrdersLabel,
} from './shiftText'

const timeout = Object.assign(new Error('Opening the shift timed out after 20s'), { name: 'TimeoutError' })
const dropped = { message: 'TypeError: Failed to fetch' }
const refused = { code: '42501', message: 'pos_shifts: needs POS Supervisor', hint: 'pos_shift_rank' }

// 6:15 PM on 30th Bhadra 2083 in Nepal, and 12:05 AM the next day.
const EVENING = '2026-09-15T12:30:00Z'
const LATE_SAME_DAY = '2026-09-15T18:10:00Z' // 11:55 PM, still 30th Bhadra
const AFTER_MIDNIGHT = '2026-09-15T18:20:00Z' // 12:05 AM, 31st Bhadra

describe('History dates (SHIFTS-8)', () => {
  it('names the Nepali day the way PosReservations does', () => {
    expect(bsDayLabel(EVENING)).toBe('30th Bhadra 2083')
  })

  it('falls back to the AD date past the verified BS table, never a guessed BS date', () => {
    expect(bsDayLabel('2045-01-01T00:00:00Z')).toBe('01/01/2045')
  })

  it('shows no close day when the shift closed the day it opened, by Nepal time', () => {
    expect(shiftDates(EVENING, LATE_SAME_DAY)).toEqual({ opened: '30th Bhadra 2083', closed: '' })
  })

  it('shows the close day and time when the shift ran past midnight in Nepal', () => {
    expect(shiftDates(EVENING, AFTER_MIDNIGHT)).toEqual({ opened: '30th Bhadra 2083', closed: '31st Bhadra 2083, 12:05 AM' })
  })

  it('has nothing to say about a shift with no times', () => {
    expect(shiftDates(null, null)).toEqual({ opened: '', closed: '' })
  })

  it('puts the date in the row button name, not the duration', () => {
    expect(historyRowLabel({ label: 'Evening', opened_at: EVENING, closed_at: LATE_SAME_DAY }))
      .toBe('Closing report for Evening, 30th Bhadra 2083')
    expect(historyRowLabel({ label: null, opened_at: EVENING, closed_at: AFTER_MIDNIGHT }))
      .toBe('Closing report for shift, 30th Bhadra 2083 to 31st Bhadra 2083, 12:05 AM')
  })
})

describe('Current Shift freshness (SHIFTS-10)', () => {
  it('says when the totals were read, in Nepal time', () => {
    expect(asOfLabel(EVENING)).toBe('as of 06:15 PM')
    expect(asOfLabel(null)).toBe('')
  })
})

describe('no answer is not "not done" (SHIFTS-9)', () => {
  it('treats a timeout and a dropped connection as no answer, and a refusal as an answer', () => {
    expect(isNoAnswer(timeout)).toBe(true)
    expect(isNoAnswer(dropped)).toBe(true)
    expect(isNoAnswer(refused)).toBe(false)
  })

  it('names which kind of no-answer it was', () => {
    expect(noAnswerLead(timeout)).toBe('The server took too long to answer')
    expect(noAnswerLead(dropped)).toBe('The connection dropped')
  })

  it('never says the shift was not opened after a lost Open reply', () => {
    for (const found of [{ id: 's1' }, null, undefined]) {
      const text = openUnknownText(timeout, found)
      expect(text).not.toMatch(/not opened|was not opened/i)
      expect(text).toMatch(/opened/)
    }
  })

  it('says a shift is open when the read-back found one, and keeps the count when it did not', () => {
    expect(openUnknownText(dropped, { id: 's1' })).toMatch(/now shows what it holds: a shift is open/)
    expect(openUnknownText(dropped, null)).toMatch(/server shows no open shift right now.*count is still here/)
    expect(openUnknownText(dropped, undefined)).toMatch(/could not read the server.*count is still here/)
  })

  it('words a lost Close reply as unknown, for a timeout too', () => {
    expect(closeUnknownText(timeout)).toMatch(/^The server took too long to answer, so it is not known whether the shift closed/)
    expect(closeUnknownText(dropped)).toMatch(/^The connection dropped, so it is not known whether the shift closed/)
    expect(closeUnknownText(timeout)).toMatch(/Shift History/)
  })

  it('words a lost cash entry as unknown, for a timeout too', () => {
    expect(cashUnknownText(timeout)).toMatch(/^The server took too long to answer, so it is not known whether this was recorded/)
  })

  it('points a blocked closing slip to its reprint, and says the opening slip did not print', () => {
    expect(slipNotPrintedText('close')).toMatch(/did not print.*Shift History → Reprint closing report/)
    expect(slipNotPrintedText('open')).toMatch(/opening slip did not print/)
    expect(slipNotPrintedText('reprint')).toMatch(/did not print/)
  })
})

describe('page-level sentences (SHIFTS-10, SHIFTS-11)', () => {
  it('names Shift History when the shift was closed elsewhere', () => {
    expect(SHIFT_ALREADY_CLOSED_TEXT).toMatch(/already closed elsewhere/)
    expect(SHIFT_ALREADY_CLOSED_TEXT).toMatch(/Shift History/)
  })

  it('says a second shift was not opened when one is already open', () => {
    expect(SHIFT_ALREADY_OPEN_TEXT).toMatch(/already open, so a second one was not opened/)
  })

  it('only claims a last known state when there is one', () => {
    expect(shiftReadFailLead(true)).toBe('Could not check whether a shift is open.')
    expect(shiftReadFailLead(false)).toMatch(/shows the last state it read/)
  })
})

describe('the open-orders warning at Close Shift (S754)', () => {
  const table = (name, no) => ({ id: `o${no}`, order_no: no, table_id: `t-${name}`, part_of_order_id: null, table_name: name })
  const takeaway = no => ({ id: `o${no}`, order_no: no, table_id: null, part_of_order_id: null, table_name: 'Takeaway' })

  it('names tables, then counts takeaways with their numbers', () => {
    expect(openOrdersLabel([table('Table 3', 40), table('Table 7', 43), takeaway(41), takeaway(42)]))
      .toBe('Table 3, Table 7 and 2 takeaways (#41, #42)')
    expect(openOrdersLabel([takeaway(41)])).toBe('1 takeaway (#41)')
    expect(openOrdersLabel([])).toBe('')
  })

  // S836: a part bill has no table of its own but was split off one, so it is found at its table on
  // the floor, never among the takeaways.
  it('names an open part bill by its table, the way the floor does, and never as a takeaway', () => {
    const part = { id: 'o44', order_no: 44, table_id: null, part_of_order_id: 'o40', table_name: 'Table 3' }
    expect(openOrdersLabel([table('Table 3', 40), part, takeaway(41)]))
      .toBe('Table 3, Table 3 · part bill #44 and 1 takeaway (#41)')
    expect(openOrdersLabel([part])).toBe('Table 3 · part bill #44')
  })
})
