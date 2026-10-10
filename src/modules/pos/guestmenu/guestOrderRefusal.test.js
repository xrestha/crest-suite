import { guestOrderRefusal, joinNames, unavailableNames } from './guestOrderRefusal'

// S754. submit_guest_order raises a stable code in HINT; the page words each one itself and never
// renders the raw message to an anonymous diner.
describe('guestOrderRefusal', () => {
  const refused = (hint, extra = {}) => ({ code: 'P0001', hint, message: 'Some items in this order are no longer available', ...extra })

  it('names the dishes that are no longer available, and asks for a menu refresh', () => {
    const r = guestOrderRefusal(refused('unavailable_items', { details: '["Momo","Thukpa"]' }), 'Himalayan Cafe')
    expect(r.text).toBe('Momo and Thukpa are no longer available, so your order was not sent — remove them and send again.')
    expect(r.refreshMenu).toBe(true)
  })

  it('reads one dish in the singular', () => {
    expect(guestOrderRefusal(refused('unavailable_items', { details: '["Sel Roti"]' })).text)
      .toBe('Sel Roti is no longer available, so your order was not sent — remove it and send again.')
  })

  it('does not print "An item" as if it were a dish name', () => {
    expect(guestOrderRefusal(refused('unavailable_items', { details: '["An item"]' })).text).toMatch(/^Something in your order is no longer available/)
    expect(guestOrderRefusal(refused('unavailable_items', { details: '["An item","Momo"]' })).text).toMatch(/^Momo and another item are/)
  })

  it('survives a missing or malformed detail', () => {
    expect(unavailableNames({ details: 'not json' })).toEqual([])
    expect(guestOrderRefusal(refused('unavailable_items')).text).toMatch(/no longer available/)
  })

  it('names the outlet rather than "the restaurant" when it knows it', () => {
    expect(guestOrderRefusal(refused('not_accepting'), 'Bhatti Choila').text).toMatch(/^Bhatti Choila isn't taking orders/)
  })

  it('never shows the raw server message, whatever the code', () => {
    for (const hint of ['table_not_found', 'not_accepting', 'inactive', 'empty', 'too_many_items', 'unavailable_items', 'no_valid_items', 'pending', 'something_new']) {
      const r = guestOrderRefusal({ hint, message: 'new row violates row-level security policy for table "pos_guest_order_requests"' }, 'X')
      expect(r.text).not.toMatch(/row-level|pos_guest_order_requests/)
    }
  })

  it('does not claim a dropped connection sent nothing', () => {
    const r = guestOrderRefusal({ message: 'TypeError: Failed to fetch' }, 'X')
    expect(r.text).not.toMatch(/was not sent/)
    expect(guestOrderRefusal({ message: 'anything' }, 'X', { online: false }).text).toMatch(/can't tell/)
  })

  it('reads a timed-out submit as an unknown outcome, not a refusal (S767)', () => {
    const r = guestOrderRefusal(new Error('Sending your order timed out after 20s — check your connection and try again.'), 'X')
    expect(r.text).toMatch(/can't tell/)
    expect(r.text).not.toMatch(/was not sent/)
  })

  it('marks a dropped connection or a timeout as an unknown outcome, and a refusal as not (S809 3b)', () => {
    // `unknown` is what keeps the order key for the resend; a refusal sent nothing under it.
    expect(guestOrderRefusal({ message: 'TypeError: Failed to fetch' }, 'X').unknown).toBe(true)
    expect(guestOrderRefusal(new Error('Sending your order timed out after 20s'), 'X').unknown).toBe(true)
    expect(guestOrderRefusal({ message: 'anything' }, 'X', { online: false }).unknown).toBe(true)
    for (const hint of ['pending', 'unavailable_items', 'unavailable_options', 'not_accepting', 'inactive', 'request_key_conflict']) {
      expect([hint, guestOrderRefusal(refused(hint), 'X').unknown]).toEqual([hint, undefined])
    }
  })

  it('an order key of another table asks for a new key and claims nothing about the order (S809 3b)', () => {
    const r = guestOrderRefusal(refused('request_key_conflict'), 'X')
    expect(r.resetKey).toBe(true)
    expect(r.refreshMenu).toBe(false)
    expect(r.text).not.toMatch(/key|table/i)
  })

  it('keeps the network sentence short enough to read mid-service (S767)', () => {
    const words = guestOrderRefusal({ message: 'Failed to fetch' }, 'X').text.split(/\s+/).length
    expect(words).toBeLessThanOrEqual(20)
  })

  it('joins names the way a sentence does', () => {
    expect(joinNames(['A'])).toBe('A')
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C')
    expect(joinNames([])).toBe('')
  })
})
