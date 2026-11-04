// S876 (the IMS speed fixes): every refusal code the S876 migrations raise has its own sentence,
// ahead of the generic rule its errcode would otherwise fall to. Kept apart from errorText.test.js
// as errorText.s849.test.js is.
import { errorText } from './errorText'

// [hint, errcode] exactly as renumber_codes and get_ims_cost_trend raise them.
const CODES = [
  ['renumber_wrong_outlet', '42501'],
  ['renumber_refused', '42501'],
  ['renumber_no_prefix', '22023'],
  ['renumber_bad_kind', '22023'],
  ['trend_wrong_outlet', '42501'],
]

const FALLBACK_RE = /reason isn't one we recognise|That didn't work\. Try again/i

describe('S876 refusal codes', () => {
  it.each(CODES)('%s (%s) has its own sentence for both audiences', (hint, code) => {
    const err = { code, hint, message: `renumber_codes: ${hint}` }
    const generic = { code, message: 'refused' }
    for (const aud of ['staff', 'operator']) {
      const text = errorText(err, aud)
      expect(text).not.toMatch(FALLBACK_RE)
      expect(text).not.toBe(errorText(generic, aud))
      expect(errorText({ code, hint }, aud)).toBe(text)
    }
  })

  it('a refused renumber says no code changed, because it is one transaction', () => {
    const text = errorText({ code: '42501', hint: 'renumber_refused', message: 'renumber_codes: some items could not be changed, so none were' }, 'operator')
    expect(text).toMatch(/no code was changed/i)
  })
})
