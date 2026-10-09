// S809 2b (migration 20261009190000): the refusals guard_pos_order_close, guard_pos_credit_note and
// apply_pos_item_comps now raise. Kept apart from errorText.test.js so slices drafted at the same
// time do not collide in one file.
import { errorText } from './errorText'

const fallback = aud => errorText({ message: 'x' }, aud)

describe('the S809 2b close, shift, year and comp refusals', () => {
  const empty = { code: '23514', hint: 'pos_bill_empty', message: 'pos_orders: there is nothing on this bill, so it was not closed — add the items back, or ask someone with Void to void it' }
  const noShift = { code: '55000', hint: 'no_open_shift', message: 'pos_orders: no shift is open at this outlet, so this bill was not closed — open a shift in POS → Shifts, then close the bill again' }
  const noYear = { code: 'P0001', hint: 'pos_fiscal_year_unknown', message: "pos_orders: today's date is past the end of Crest's Nepali calendar, so no invoice number can be given and the bill was not closed — contact Crest support" }
  const missing = { code: 'P0001', hint: 'pos_comp_line_missing', message: 'pos_comp_line_missing: Veg Momo is not on this bill to be made complimentary, so nothing was made complimentary — the bill may have changed on another device' }

  it('an empty bill says it was not closed and names Void as the way to clear it (Q8 a), ahead of the generic CHECK sentence', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(empty, aud)).toMatch(/nothing on this bill|nothing on it/i)
      expect(errorText(empty, aud)).toMatch(/void/i)
      expect(errorText(empty, aud)).not.toBe(errorText({ code: '23514', message: 'x' }, aud))
    }
  })

  it('no open shift sends the cashier to open one and charge again', () => {
    expect(errorText(noShift, 'staff')).toMatch(/Open a shift in Shifts, then charge the bill again/)
    expect(errorText(noShift, 'operator')).toMatch(/still open and nothing was charged/)
    expect(errorText(noShift, 'operator')).not.toBe(fallback('operator'))
  })

  it('a date past the calendar does not offer a retry', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(noYear, aud)).toMatch(/Crest support/)
      expect(errorText(noYear, aud)).not.toMatch(/try again/i)
    }
  })

  it('a missing comp line says nothing was made complimentary, and matches on the message alone', () => {
    expect(errorText(missing, 'staff')).toMatch(/nothing was made complimentary/i)
    expect(errorText(missing, 'operator')).toMatch(/no NC number was used/)
    expect(errorText({ message: missing.message }, 'operator')).toBe(errorText(missing, 'operator'))
    // and is not the part-comp quantity sentence
    expect(errorText(missing, 'operator')).not.toBe(errorText({ code: '22023', hint: 'pos_comp_qty_invalid', message: 'x' }, 'operator'))
  })

  it('each code has its own sentence', () => {
    const texts = [empty, noShift, noYear, missing].map(e => errorText(e, 'operator'))
    expect(new Set(texts).size).toBe(4)
  })
})
