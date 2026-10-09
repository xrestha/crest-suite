// S809 2c (migration 20261009200000): guard_pos_order_close refuses a Charge whose total the till
// worked out under the other VAT status. Kept apart from errorText.test.js so slices drafted at the
// same time do not collide in one file.
import { errorText } from './errorText'

describe('the S809 2c VAT-status refusal', () => {
  const changed = { code: '55000', hint: 'pos_vat_status_changed', message: "pos_orders: this outlet's VAT registration was changed since this till loaded it, so the bill was not charged — the till is reloading it; check the new total with the guest, then charge again" }

  it('says nothing was charged and to charge the new total again', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(changed, aud)).toMatch(/not charged|Nothing was charged/)
      expect(errorText(changed, aud)).toMatch(/charge again/)
      expect(errorText(changed, aud)).toMatch(/VAT/)
    }
  })

  it('is read from the hint, and is not the no-open-shift sentence that shares its code', () => {
    expect(errorText(changed, 'operator')).not.toBe(errorText({ code: '55000', message: changed.message }, 'operator'))
    expect(errorText(changed, 'operator')).not.toBe(errorText({ code: '55000', hint: 'no_open_shift', message: 'x' }, 'operator'))
  })
})
