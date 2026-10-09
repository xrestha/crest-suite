// S809 2e (migration 20261009210000): the refusals pos_credit_note_settle, ims_sales_entries_guard and
// ims_stock_movements_guard now raise. Kept apart from errorText.test.js so slices drafted at the same
// time do not collide in one file.
import { errorText } from './errorText'

const generic42501 = aud => errorText({ code: '42501', message: 'x' }, aud)
const fallback = aud => errorText({ message: 'x' }, aud)

describe('the S809 2e credit-note and restock refusals', () => {
  const noShift = { code: 'P0001', hint: 'credit_note_refund_no_shift', message: 'pos_credit_notes: no shift is open, so the cash refund has no drawer count to go on and no Credit Note was issued — open a shift, or choose Other or None' }
  const linkFailed = { code: 'P0001', hint: 'credit_note_link_failed', message: 'pos_credit_notes: the bill could not be marked as credited, so no Credit Note was issued' }
  const mismatch = { code: '42501', hint: 'credit_note_restock_mismatch', message: 'credit_note_restock_mismatch: this Credit Note said its food was not served, so its Inventory posting must put the food back — post it again from a page that is up to date' }
  const invalid = { code: '42501', hint: 'pos_credit_restock_invalid', message: 'pos_credit_restock_invalid: stock goes back into Inventory only through a Credit Note that said its bill\'s food was not served, and only as stock added' }

  it('a cash refund with no shift open says no note was issued and offers the two ways on', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(noShift, aud)).toMatch(/No Credit Note was issued|no Credit Note was issued/)
      expect(errorText(noShift, aud)).toMatch(/Other or None/)
      expect(errorText(noShift, aud)).not.toBe(fallback(aud))
    }
  })

  it('a failed link says nothing was issued, so a retry is safe', () => {
    expect(errorText(linkFailed, 'operator')).toMatch(/no Credit Note was issued and nothing was numbered/)
    expect(errorText(linkFailed, 'staff')).not.toBe(fallback('staff'))
  })

  it('a plain reversal of a not-served note sends the reader to reload, ahead of the generic refusal', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(mismatch, aud)).toMatch(/reload the page/i)
      expect(errorText(mismatch, aud)).not.toBe(generic42501(aud))
    }
    // matches on the message alone too (a wrapper that dropped the hint)
    expect(errorText({ message: mismatch.message }, 'operator')).toBe(errorText(mismatch, 'operator'))
  })

  it('a restock row with no not-served note behind it says nothing was recorded', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(invalid, aud)).toMatch(/Nothing was recorded/)
      expect(errorText(invalid, aud)).not.toBe(generic42501(aud))
    }
  })

  it('each code has its own sentence', () => {
    const texts = [noShift, linkFailed, mismatch, invalid].map(e => errorText(e, 'operator'))
    expect(new Set(texts).size).toBe(4)
  })
})
