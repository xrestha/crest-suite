// S809 2f (migration 20261009220000): the two refusals sales_entries_stamp_pos_source raises. Kept apart
// from errorText.test.js so slices drafted at the same time do not collide in one file.
import { errorText } from './errorText'

describe('the S809 2f till-sale refusals', () => {
  const twice = { code: '23505', hint: 'pos_bill_already_posted', message: "sales_entries: this bill's sales are already in Inventory, so they were not recorded a second time" }
  const unlinked = { code: '23514', hint: 'pos_sale_unlinked', message: 'sales_entries: a till sale is recorded under the bill it came from, and this one named no bill, so it was not recorded' }

  it('a second post of a bill says it is already in Inventory and asks for nothing, ahead of the generic duplicate sentence', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(twice, aud)).toMatch(/already in Inventory/i)
      expect(errorText(twice, aud)).toMatch(/Nothing needs doing/)
      expect(errorText(twice, aud)).not.toBe(errorText({ code: '23505', message: 'x' }, aud))
    }
  })

  it('a sale that names no closed bill says nothing was added, ahead of the generic CHECK sentence', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(unlinked, aud)).toMatch(/not added to Inventory|nothing was added/i)
      expect(errorText(unlinked, aud)).not.toBe(errorText({ code: '23514', message: 'x' }, aud))
    }
    expect(errorText(unlinked, 'operator')).toMatch(/Post POS bills to Inventory/)
  })

  it('each matches on the hint alone, and the two differ', () => {
    expect(errorText({ hint: 'pos_bill_already_posted' }, 'operator')).toBe(errorText(twice, 'operator'))
    expect(errorText({ hint: 'pos_sale_unlinked' }, 'operator')).toBe(errorText(unlinked, 'operator'))
    expect(errorText(twice, 'operator')).not.toBe(errorText(unlinked, 'operator'))
  })
})
