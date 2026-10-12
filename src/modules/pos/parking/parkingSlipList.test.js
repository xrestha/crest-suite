/**
 * POS → Parking Slips' pure rules (S814, POS stage 4f): the two lists kept current from the server's
 * answers, the day's sweep, the All tab's date range, and every sentence the page says.
 */

import {
  sweepCutoffIso, staleOpenSlips, nextAdIso, slipRangeBounds, inSlipRange, patchSlip, patchSlips,
  printNoticeKind, parkingSlipNotice, noAnswer, slipTimeIn, LIST_STALE_TEXT,
} from './parkingSlipList'

const at = iso => Date.parse(iso)
const slip = (id, slipNo, extra = {}) => ({
  id, slip_no: slipNo, vehicle_number: `BA ${slipNo}`, status: 'open', time_in: '2026-10-12T10:00:00+05:45', ...extra,
})

describe('patchSlip', () => {
  test('a slip marked exited leaves the Open list', () => {
    const open = [slip('a', 3), slip('b', 2)]
    const next = patchSlip(open, { id: 'a', status: 'closed', time_out: '2026-10-12T11:00:00+05:45' }, { openOnly: true })
    expect(next.map(s => s.id)).toEqual(['b'])
  })

  test('on the All list the same answer updates the row in place', () => {
    const all = [slip('a', 3), slip('b', 2)]
    const next = patchSlip(all, { id: 'a', status: 'closed', exited_by: 'u1', auto_closed: false })
    expect(next[0]).toMatchObject({ id: 'a', slip_no: 3, status: 'closed', exited_by: 'u1' })
    expect(next).toHaveLength(2)
  })

  test('a new slip joins the Open list in number order', () => {
    const next = patchSlip([slip('a', 3), slip('b', 1)], slip('c', 2), { openOnly: true })
    expect(next.map(s => s.slip_no)).toEqual([3, 2, 1])
  })

  test('a part row the list does not hold (a print count) is never added as a slip', () => {
    expect(patchSlip([slip('a', 3)], { id: 'z', print_count: 2 })).toHaveLength(1)
  })

  test('a new slip joins the All list only when its Time In is in the range shown', () => {
    const range = { from: '2026-10-01', to: '2026-10-12' }
    expect(patchSlip([], slip('c', 9), { range })).toHaveLength(1)
    expect(patchSlip([], slip('d', 9, { time_in: '2026-10-13T08:00:00+05:45' }), { range })).toHaveLength(0)
  })

  test('a print count merges into the row', () => {
    expect(patchSlip([slip('a', 3, { print_count: 1 })], { id: 'a', print_count: 4 })[0].print_count).toBe(4)
  })

  test('patchSlips applies rows in order', () => {
    const next = patchSlips([slip('a', 3)], [slip('b', 4), { id: 'a', status: 'closed' }], { openOnly: true })
    expect(next.map(s => s.id)).toEqual(['b'])
  })
})

describe('the day\'s sweep', () => {
  test('the cut-off is the 6 AM Nepal that began today\'s parking day', () => {
    expect(sweepCutoffIso(at('2026-10-12T07:00:00+05:45'))).toBe('2026-10-12T00:15:00.000Z')
    // 5 AM is still yesterday's parking day, so the cut-off is yesterday's 6 AM.
    expect(sweepCutoffIso(at('2026-10-12T05:00:00+05:45'))).toBe('2026-10-11T00:15:00.000Z')
  })

  test('only open slips from before the cut-off are stale', () => {
    const cutoff = '2026-10-12T00:15:00.000Z' // 6 AM Nepal
    const rows = [
      slip('late', 1, { time_in: '2026-10-11T23:30:00+05:45' }),
      slip('early', 2, { time_in: '2026-10-12T05:59:00+05:45' }),
      slip('today', 3, { time_in: '2026-10-12T06:00:00+05:45' }),
      slip('closed', 4, { time_in: '2026-10-11T20:00:00+05:45', status: 'closed' }),
    ]
    expect(staleOpenSlips(rows, cutoff).map(s => s.id)).toEqual(['late', 'early'])
  })
})

describe('the All tab\'s date range', () => {
  test('the day after an AD date crosses months and years', () => {
    expect(nextAdIso('2026-10-12')).toBe('2026-10-13')
    expect(nextAdIso('2026-10-31')).toBe('2026-11-01')
    expect(nextAdIso('2026-12-31')).toBe('2027-01-01')
  })

  test('bounds run from From\'s Nepal midnight to the midnight after To', () => {
    expect(slipRangeBounds('2026-09-17', '2026-10-12')).toEqual({
      startIso: '2026-09-17T00:00:00+05:45',
      endIso: '2026-10-13T00:00:00+05:45',
    })
  })

  test('a slip belongs to the Nepal day it was issued on, whatever the viewer\'s clock', () => {
    const range = { from: '2026-10-01', to: '2026-10-12' }
    expect(inSlipRange('2026-09-30T18:14:59Z', range)).toBe(false) // 23:59:59 on 30 Sep, Nepal
    expect(inSlipRange('2026-09-30T18:15:00Z', range)).toBe(true)  // 00:00 on 1 Oct, Nepal
    expect(inSlipRange('2026-10-12T23:59:00+05:45', range)).toBe(true)
    expect(inSlipRange('2026-10-13T00:00:00+05:45', range)).toBe(false)
    expect(inSlipRange(null, range)).toBe(false)
    expect(inSlipRange('2026-10-05T10:00:00+05:45', null)).toBe(false)
  })
})

describe('what a print result needs said', () => {
  test('maps each print outcome to its notice', () => {
    expect(printNoticeKind({ printed: true, countError: null })).toBeNull()
    expect(printNoticeKind({ printed: false, closed: false }, { issuing: true })).toBe('issue-blocked')
    expect(printNoticeKind({ printed: false, closed: false })).toBe('reprint-blocked')
    expect(printNoticeKind({ printed: false, closed: true }, { issuing: true })).toBe('issue-closed')
    expect(printNoticeKind({ printed: false, closed: true })).toBe('reprint-closed')
    expect(printNoticeKind({ printed: true, countError: { code: '42501', message: 'denied' } })).toBe('count-refused')
    const timeout = Object.assign(new Error('timed out after 8s'), { name: 'TimeoutError' })
    expect(printNoticeKind({ printed: true, countError: timeout })).toBe('count-timeout')
    expect(printNoticeKind({ printed: true, countError: { message: 'TypeError: Failed to fetch' } })).toBe('count-timeout')
  })

  test('no answer is a timeout or a dropped connection, never a refusal', () => {
    expect(noAnswer({ name: 'TimeoutError', message: 'x' })).toBe(true)
    expect(noAnswer({ message: 'Failed to fetch' })).toBe(true)
    expect(noAnswer({ code: '42501', message: 'denied' })).toBe(false)
  })
})

describe('parkingSlipNotice — one case per sentence', () => {
  const s = { slip_no: 12, vehicle_number: 'BA 2 KHA 1234' }

  test('a blocked first print', () => {
    expect(parkingSlipNotice('issue-blocked', { slip: s })).toBe(
      'P-12 (BA 2 KHA 1234) is saved, but its token did not print: the browser blocked the print window. Allow pop-ups for this site, then press Reprint on P-12. It prints as the original, because nothing has printed yet.')
  })

  test('a blocked reprint', () => {
    expect(parkingSlipNotice('reprint-blocked', { slip: s })).toBe(
      'Nothing printed for P-12: the browser blocked the print window. Allow pop-ups for this site, then press Reprint again.')
  })

  test('a print window closed before the token went in', () => {
    expect(parkingSlipNotice('issue-closed', { slip: s })).toMatch(/^P-12 \(BA 2 KHA 1234\) is saved, but its token did not print: the print window was closed/)
    expect(parkingSlipNotice('reprint-closed', { slip: s })).toMatch(/^Nothing printed for P-12: the print window was closed/)
  })

  test('a refused count', () => {
    expect(parkingSlipNotice('count-refused', { slip: s, count: 3 })).toBe(
      'P-12 printed, but its print count could not be saved, so the next reprint will carry the same copy label as this one.')
    expect(parkingSlipNotice('count-refused', { slip: s, count: 1 })).toBe(
      'P-12 printed, but its print count could not be saved, so a reprint will also print as the original.')
  })

  test('a count that did not answer in time', () => {
    expect(parkingSlipNotice('count-timeout', { slip: s, count: 3 })).toBe(
      'P-12 printed, but saving its print count did not answer in time, so the next reprint may carry the same copy label as this one.')
    expect(parkingSlipNotice('count-timeout', { slip: s, count: 1 })).toMatch(/may also print as the original\.$/)
  })

  test('an issue whose answer never came', () => {
    expect(parkingSlipNotice('issue-unknown', { vehicle: 'BA 2 KHA 1234' })).toBe(
      'It is not known whether the slip for BA 2 KHA 1234 was saved: the answer did not arrive, and nothing printed. Check the Open list for BA 2 KHA 1234 before issuing it again — if it is there, press Reprint on it.')
  })

  test('a Mark Exited whose answer never came', () => {
    expect(parkingSlipNotice('exit-unknown', { slip: s })).toBe(
      'It is not known whether BA 2 KHA 1234 (P-12) was marked exited: the answer did not arrive. The list has been refreshed; if it is still there, press Mark Exited again — a slip closes only once.')
  })

  test('a reload that failed over a list already shown', () => {
    expect(LIST_STALE_TEXT).toBe('Could not refresh the list — it shows what was last loaded.')
  })

  test('no notice never claims a failed write did not land', () => {
    const kinds = ['issue-blocked', 'reprint-blocked', 'issue-closed', 'reprint-closed', 'count-refused', 'count-timeout', 'issue-unknown', 'exit-unknown']
    for (const k of kinds) {
      const text = parkingSlipNotice(k, { slip: s, count: 2, vehicle: 'X' })
      expect(text).not.toMatch(/nothing was saved|was not saved|REPRINT #/i)
    }
  })
})

test('a Time In carries its Nepal day as well as its time', () => {
  expect(slipTimeIn('2026-10-12T23:30:00+05:45')).toMatch(/^\d+\w\w \w+ \d{4}, 11:30 PM$/)
  expect(slipTimeIn(null)).toBe('')
})
