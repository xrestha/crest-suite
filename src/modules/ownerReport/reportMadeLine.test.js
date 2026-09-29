// S792 (D42): the Owner Report header says when the report was made — a BS date and Nepal time,
// whatever the viewer's clock — and says plainly when it was made at the first view rather than at
// the close, because its figures are then the month as it stood that day.
import { madeAtText, reportMadeText } from './reportMadeLine'

// 09:14 in Kathmandu on 28 September 2026.
const MORNING = '2026-09-28T03:29:00Z'
// 01:45 in Kathmandu on the SAME day, but still 27 September in UTC and everywhere west of it.
const SMALL_HOURS = '2026-09-27T20:00:00Z'

describe('madeAtText', () => {
  test('a BS date and a Nepal clock time', () => {
    const t = madeAtText(MORNING)
    expect(t).toMatch(/^\d{1,2} [A-Z][a-z]+ 2083, 09:14 AM \(Nepal time\)$/)
  })

  test("the date is Nepal's, not the viewer's: 01:45 in Kathmandu is the same BS day as 09:14", () => {
    const early = madeAtText(SMALL_HOURS)
    expect(early).toMatch(/01:45 AM \(Nepal time\)$/)
    expect(early.split(',')[0]).toBe(madeAtText(MORNING).split(',')[0])
  })

  test('nothing recorded is null, never "Invalid Date"', () => {
    expect(madeAtText(null)).toBeNull()
    expect(madeAtText('not a date')).toBeNull()
  })
})

describe('reportMadeText', () => {
  const base = { generatedAt: MORNING, byName: 'Aashish Shrestha', monthLabel: 'Bhadra 2083' }

  test('made at the close', () => {
    const r = reportMadeText({ ...base, source: 'period_close' })
    expect(r.line).toMatch(/^Made when Bhadra 2083 was ended: .*09:14 AM \(Nepal time\) by Aashish Shrestha\.$/)
    expect(r.note).toBeNull()
  })

  test('made at the first view after someone else ended the month says so, and what it means', () => {
    const r = reportMadeText({ ...base, source: 'backfill' })
    expect(r.line).toMatch(/the first time this report was opened\.$/)
    expect(r.note).toMatch(/not made when Bhadra 2083 was ended/)
    expect(r.note).toMatch(/supervisor/)
    expect(r.note).toMatch(/a bill added to Bhadra 2083 after it was ended is included/)
  })

  test('regenerated', () => {
    const r = reportMadeText({ ...base, source: 'manual_regenerate' })
    expect(r.line).toMatch(/^Regenerated .* by Aashish Shrestha, from Bhadra 2083's figures as they stood then\.$/)
    expect(r.note).toBeNull()
  })

  test('an unknown maker or time is left out rather than printed as a dash', () => {
    const r = reportMadeText({ generatedAt: null, source: 'period_close', byName: '', monthLabel: 'Bhadra 2083' })
    expect(r.line).toBe('Made when Bhadra 2083 was ended: at a time that was not recorded.')
    expect(r.line).not.toMatch(/—| by /)
  })
})
