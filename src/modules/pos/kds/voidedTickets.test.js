import { voidColumn, visibleVoids, VOID_VISIBLE_MS, VOID_READ_WINDOW_MS } from './voidedTickets'

describe('voidColumn', () => {
  it('puts a voided ticket back in the column it was in', () => {
    expect(voidColumn({ ready_at: '2026-10-12T10:00:00Z', started_at: '2026-10-12T09:50:00Z' })).toBe('ready')
    expect(voidColumn({ started_at: '2026-10-12T09:50:00Z' })).toBe('in_progress')
    expect(voidColumn({})).toBe('new')
    expect(voidColumn(null)).toBe('new')
  })
})

describe('visibleVoids', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }

  it('keeps a card for ten minutes after this screen first saw it', () => {
    const firstSeen = new Map([['a', 0], ['b', 0]])
    expect(visibleVoids([a, b], { firstSeen, dismissed: new Set(), now: VOID_VISIBLE_MS - 1 }).map(t => t.id)).toEqual(['a', 'b'])
    expect(visibleVoids([a, b], { firstSeen, dismissed: new Set(), now: VOID_VISIBLE_MS })).toEqual([])
  })

  it('drops a card a cook tapped OK on, and only that one', () => {
    const firstSeen = new Map([['a', 0], ['b', 0]])
    expect(visibleVoids([a, b], { firstSeen, dismissed: new Set(['a']), now: 1000 }).map(t => t.id)).toEqual(['b'])
  })

  it('shows a card not yet stamped as seen', () => {
    expect(visibleVoids([c], { firstSeen: new Map(), dismissed: new Set(), now: 5 }).map(t => t.id)).toEqual(['c'])
  })

  it('reads further back than it shows, so a fast tablet clock still sees a void', () => {
    expect(VOID_READ_WINDOW_MS).toBeGreaterThan(VOID_VISIBLE_MS)
  })
})
