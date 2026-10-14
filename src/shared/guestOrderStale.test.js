// S834 (D34): the app's 30 minutes and the database's are one rule.
import fs from 'fs'
import path from 'path'
import { GUEST_ORDER_STALE_MS, isStaleGuestOrder, staleGuestOrderCutoffIso, turnedAwayUnanswered } from './guestOrderStale'

const MIGRATION = path.join(__dirname, '../../supabase/migrations/20261014100000_pos_small_leftovers_s834.sql')

describe('guest orders past the limit', () => {
  test('the JS limit equals pos_guest_order_stale_after() in the migration', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8')
    const m = sql.match(/FUNCTION public\.pos_guest_order_stale_after\(\)[\s\S]*?SELECT interval '(\d+) minutes'/)
    expect(m).not.toBeNull()
    expect(Number(m[1]) * 60 * 1000).toBe(GUEST_ORDER_STALE_MS)
  })

  test('30 minutes is the line', () => {
    const now = Date.parse('2026-10-14T10:00:00Z')
    expect(isStaleGuestOrder('2026-10-14T09:30:00Z', now)).toBe(true)
    expect(isStaleGuestOrder('2026-10-14T09:30:01Z', now)).toBe(false)
    expect(isStaleGuestOrder('not a date', now)).toBe(false)
    expect(isStaleGuestOrder(null, now)).toBe(false)
    expect(staleGuestOrderCutoffIso(now)).toBe('2026-10-14T09:30:00.000Z')
  })

  test('a turn-away 30 minutes on reads as unanswered; a staff answer sooner does not', () => {
    expect(turnedAwayUnanswered('2026-10-14T09:00:00Z', '2026-10-14T09:31:00Z')).toBe(true)
    expect(turnedAwayUnanswered('2026-10-14T09:00:00Z', '2026-10-14T09:05:00Z')).toBe(false)
    expect(turnedAwayUnanswered(null, '2026-10-14T09:31:00Z')).toBe(false)
  })
})
