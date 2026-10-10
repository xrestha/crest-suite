// S809 3d (migration 20261010130000): a kitchen login's Clear of a ticket whose dishes were all taken
// off is checked against the order. Kept apart from errorText.test.js so slices drafted at the same
// time do not collide in one file.
import { errorText, errorInfo } from './errorText'

describe('the S809 3d kitchen-clear refusal', () => {
  const refused = {
    code: '42501',
    hint: 'pos_kot_clear_food_left',
    message: 'pos_kot_clear_food_left: the kitchen clears a ticket only once every dish on it has been taken off the order, and this order still holds some of what it carries — make it, or have a POS supervisor clear the ticket',
  }

  it('has its own sentence in both audiences, ahead of the generic 42501 and the fallback', () => {
    for (const aud of ['staff', 'operator']) {
      const text = errorText(refused, aud)
      expect(text).not.toBe(errorText({ code: '42501' }, aud))
      expect(text).not.toBe(errorText({ message: 'x' }, aud))
      expect(text).not.toBe(errorText({ code: '42501', hint: 'pos_kot_cancel_rank', message: 'x' }, aud))
    }
  })

  it('says nothing changed and what to do next', () => {
    expect(errorText(refused, 'staff')).toMatch(/Nothing was changed/)
    expect(errorText(refused, 'staff')).toMatch(/supervisor/i)
    expect(errorText(refused, 'operator')).toMatch(/take the dish off there/i)
  })

  it('is read from the hint or the message key alone', () => {
    expect(errorText({ message: refused.message }, 'staff')).toBe(errorText(refused, 'staff'))
    expect(errorText({ code: '42501', hint: 'pos_kot_clear_food_left', message: 'x' }, 'operator')).toBe(errorText(refused, 'operator'))
  })

  it('keeps the technical detail', () => {
    expect(errorInfo(refused, 'operator').detail).toMatch(/pos_kot_clear_food_left/)
  })
})
