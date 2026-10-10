// S809 3j (migration 20261010140000): the refusal sales_entries_stamp_pos_source now raises for a
// Credit Note posted twice. Kept apart from errorText.test.js so slices drafted at the same time do
// not collide in one file.
import { errorText } from './errorText'

describe('the S809 3j credit-note refusal', () => {
  const twice = { code: '23505', hint: 'pos_credit_note_already_posted', message: 'sales_entries: this Credit Note is already taken off Inventory sales, so it was not taken off a second time' }
  const bill = { code: '23505', hint: 'pos_bill_already_posted', message: "sales_entries: this bill's sales are already in Inventory, so they were not recorded a second time" }

  it('says the note is already off Inventory sales and asks for nothing, ahead of the generic duplicate sentence', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(twice, aud)).toMatch(/already taken off Inventory sales/i)
      expect(errorText(twice, aud)).toMatch(/Nothing needs doing/)
      expect(errorText(twice, aud)).not.toBe(errorText({ code: '23505', message: 'x' }, aud))
    }
  })

  it('matches on the hint alone, and is not the bill sentence', () => {
    expect(errorText({ hint: 'pos_credit_note_already_posted' }, 'operator')).toBe(errorText(twice, 'operator'))
    expect(errorText(twice, 'operator')).not.toBe(errorText(bill, 'operator'))
  })
})
