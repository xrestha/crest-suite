import { countSaveFailureText } from './countSaveFailure'

// S792, STOCK-7: every refused count read "…Re-enter it and save again", including the refusals
// no retry can pass. The retry sentence is a claim about the future (S706), so it is kept only
// where a second try can work.
const RETRY = /Re-enter it and save again/

describe('countSaveFailureText', () => {
  test('a dropped connection keeps the retry, after naming the figure', () => {
    const r = countSaveFailureText({ label: 'closing count', name: 'Rice', err: { message: 'TypeError: Failed to fetch' } })
    expect(r.text).toMatch(/^The closing count figure for Rice was not saved — what is on screen is not known to be stored\./)
    expect(r.text).toMatch(RETRY)
    expect(r.detail).toMatch(/Failed to fetch/)
  })

  test('a timed-out request keeps the retry too', () => {
    const err = Object.assign(new Error('Saving timed out after 20s — check your connection and try again.'), { name: 'TimeoutError' })
    expect(countSaveFailureText({ label: 'wastage', name: 'Oil', err }).text).toMatch(RETRY)
  })

  test('a closed month leads with its reason and offers no retry', () => {
    const err = { code: '42501', message: 'period_closed: that month is closed', hint: 'period_closed' }
    const r = countSaveFailureText({ label: 'closing count', name: 'Rice', err })
    expect(r.text).toMatch(/^That month is closed/)
    expect(r.text).toMatch(/The closing count figure for Rice was not saved/)
    expect(r.text).not.toMatch(RETRY)
    expect(r.detail).toMatch(/42501/)
  })

  test('recount protection leads with its reason and offers no retry', () => {
    const r = countSaveFailureText({ label: 'closing count', name: 'Rice', err: { code: 'P0001', message: 'closing_count_locked' } })
    expect(r.text).toMatch(/already counted by another staff member/)
    expect(r.text).not.toMatch(RETRY)
  })

  test('an item outside the counter\'s sections leads with its reason and offers no retry', () => {
    const err = { code: '42501', message: 'new row violates row-level security policy for table "closing_stock"' }
    const r = countSaveFailureText({ label: 'closing count', name: 'Rice', err, audience: 'staff' })
    expect(r.text).toMatch(/^That item is not in a section you have been given to count/)
    expect(r.text).not.toMatch(RETRY)
  })

  test('a delete that landed before its insert was refused says the server now holds nothing', () => {
    const err = { code: '42501', message: 'period_closed', hint: 'period_closed' }
    const r = countSaveFailureText({ label: 'wastage', name: 'Oil', cleared: true, err })
    expect(r.text).toMatch(/the server now holds no wastage figure for it/)
    expect(r.text).not.toMatch(/not known to be stored/)
  })

  test('an unrecognised failure is not promised a retry either', () => {
    expect(countSaveFailureText({ label: 'opening stock', name: 'Flour', err: { code: 'XX000', message: 'boom' } }).text).not.toMatch(RETRY)
  })
})
