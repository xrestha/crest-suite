// S809 2g (migration 20261009230000): loyalty points follow the money. Kept apart from errorText.test.js
// so slices drafted at the same time do not collide in one file.
import { errorText, errorInfo } from './errorText'

describe('the S809 2g delivery-partner refusal', () => {
  const partner = {
    code: 'P0001',
    hint: 'pos_points_delivery_partner',
    message: "pos_points_delivery_partner: this bill is on a delivery partner's phone, and a delivery partner does not earn or spend loyalty points — no points were redeemed; take the payment without them",
  }

  it('says no points were used and to take the payment another way', () => {
    for (const aud of ['staff', 'operator']) {
      expect(errorText(partner, aud)).toMatch(/delivery partner/)
      expect(errorText(partner, aud)).toMatch(/none were used|No points were used/)
      expect(errorText(partner, aud)).toMatch(/take the payment another way/)
    }
  })

  it('is read from the hint or the message key, and is not the redemption-cap sentence', () => {
    expect(errorText({ message: partner.message }, 'staff')).toBe(errorText(partner, 'staff'))
    expect(errorText(partner, 'staff')).not.toBe(errorText({ code: 'P0001', hint: 'redeem_exceeds_bill', message: 'x' }, 'staff'))
  })
})

describe('the S809 2g point-value CHECK', () => {
  const zero = {
    code: '23514',
    message: 'new row for relation "settings" violates check constraint "settings_pos_loyalty_point_value_positive"',
  }

  it('names the rule rather than the generic "a value was not accepted"', () => {
    expect(errorText(zero, 'operator')).toMatch(/more than NPR 0/)
    expect(errorText(zero, 'operator')).not.toBe(errorText({ code: '23514', message: 'violates check constraint "x"' }, 'operator'))
    expect(errorText(zero, 'staff')).toMatch(/Nothing was changed/)
  })

  it('keeps the technical detail', () => {
    expect(errorInfo(zero, 'operator').detail).toMatch(/settings_pos_loyalty_point_value_positive/)
  })
})
