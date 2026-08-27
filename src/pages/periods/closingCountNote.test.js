import { closingCountNote } from './closingCountNote'

// The four branches are the only warning a client owner gets before an irreversible write, and
// S613 shipped them untested against real data ("not smoke-tested live"). What each one must
// promise is asserted here rather than described in prose.

describe('closingCountNote', () => {
  test('a FAILED preflight admits it could not check, and is never red', () => {
    // The close must still be reachable — a preflight that could not run is not evidence of
    // anything, so dressing it in the danger treatment would cry wolf on every network blip.
    const note = closingCountNote(null)
    expect(note.danger).toBe(false)
    expect(note.text).toMatch(/couldn't check/i)
    expect(note.text).not.toMatch(/\b0 of\b/)
  })

  test('ZERO counted is the red branch and names the COGS consequence', () => {
    const note = closingCountNote({ counted: 0, items: 214 })
    expect(note.danger).toBe(true)
    expect(note.text).toContain('0 of 214')
    expect(note.text).toContain('ZERO')
    expect(note.text).toMatch(/COGS/)
    expect(note.text).toMatch(/Monthly Report/)
  })

  test('a PARTIAL count states both numbers and stays advisory', () => {
    const note = closingCountNote({ counted: 118, items: 214 })
    expect(note.danger).toBe(false)
    expect(note.text).toContain('118 of 214')
    expect(note.text).toMatch(/treated as zero stock/)
  })

  test('a COMPLETE count reports all-clear with no warning language', () => {
    const note = closingCountNote({ counted: 214, items: 214 })
    expect(note.danger).toBe(false)
    expect(note.text).toBe('All 214 active items have a closing count.')
  })

  test('counted > items does not fall through to the partial branch', () => {
    // Reachable in real data: an item deactivated after being counted still has a closing_stock
    // row, so `counted` can exceed the active-item count. "216 of 214 items" would read as a bug
    // in the product to the person about to close their month.
    expect(closingCountNote({ counted: 216, items: 214 }).text).toBe('All 214 active items have a closing count.')
  })

  test('an empty item master is all-clear, not a red alarm', () => {
    // A brand-new client closing their first (empty) month must not be told in red that nothing
    // was counted — there was nothing to count.
    const note = closingCountNote({ counted: 0, items: 0 })
    expect(note.danger).toBe(false)
    expect(note.text).not.toContain('0 of 0')
    expect(note.text).toMatch(/no active items to count/)
  })
})
