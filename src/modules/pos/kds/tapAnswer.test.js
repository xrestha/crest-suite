// S833 (POS_TODO S809.4 3d): a Kitchen Display tap with no answer is not known, and the board reads
// itself again; only the database's own refusal says the ticket is back where it was.
import { tapMiss } from './tapAnswer'

const opts = { tableName: 'Table 4', nextStatus: 'ready' }

describe('tapMiss', () => {
  test('a tap that landed is no miss', () => {
    expect(tapMiss({ data: [{ id: 't1' }], error: null, status: 200 }, opts)).toBeNull()
  })

  test('a timeout, a dropped connection and a gateway error are not known, and re-read the board', () => {
    const answers = [
      { data: null, error: { name: 'TimeoutError', message: 'Moving the ticket timed out after 15s — check your connection and try again.' } },
      { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 },
      { data: null, error: { message: 'Bad gateway' }, status: 502 },
    ]
    for (const res of answers) {
      const miss = tapMiss(res, opts)
      expect(miss.reread).toBe(true)
      expect(miss.text).toMatch(/^No answer came back, so Table 4 may or may not have moved — the board is checking again/)
      expect(miss.text).not.toMatch(/back where it was|was not moved|didn't work/i)
    }
  })

  test('the technical detail rides along as fine print, never as the headline', () => {
    const miss = tapMiss({ data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }, opts)
    expect(miss.text).toMatch(/\(TypeError: Failed to fetch\)$/)
  })

  test('a Clear with no answer says cleared', () => {
    const miss = tapMiss({ data: null, error: { message: 'Failed to fetch' }, status: 0 }, { tableName: 'Table 9', nextStatus: 'cancelled' })
    expect(miss.text).toMatch(/^No answer came back, so Table 9 may or may not have cleared/)
  })

  test('a refusal from the database says it is back where it was, and does not re-read', () => {
    const res = { data: null, error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 }
    const miss = tapMiss(res, opts)
    expect(miss.reread).toBe(false)
    expect(miss.text).toMatch(/^Table 4 was not moved — it is back where it was\. /)
    // Through errorText, with the detail kept: never the bare message as the sentence.
    expect(miss.text).toMatch(/\(42501 · new row violates row-level security policy\)$/)
  })

  test('a refused Clear says not cleared', () => {
    const res = { data: null, error: { message: 'pos_kot_log: refused' }, status: 400 }
    expect(tapMiss(res, { tableName: 'Table 2', nextStatus: 'cancelled' }).text).toMatch(/^Table 2 was not cleared — it is back where it was/)
  })

  test('a write that matched nothing means the ticket had already moved, and re-reads', () => {
    const miss = tapMiss({ data: [], error: null, status: 200 }, opts)
    expect(miss).toEqual({ reread: true, text: 'This ticket was already moved, served from the floor, or cancelled' })
  })

  test('a ticket with no table name is "This ticket"', () => {
    const miss = tapMiss({ data: null, error: { message: 'Failed to fetch' }, status: 0 }, { nextStatus: 'in_progress' })
    expect(miss.text).toMatch(/^No answer came back, so This ticket may or may not have moved/)
  })
})
