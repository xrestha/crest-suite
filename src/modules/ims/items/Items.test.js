import { nextCodeAfter, bookWith } from './Items'
import { deleteGuard, HIDE_INSTEAD } from './itemDeleteGuard'

// Items.js imports AuthContext/scopedDb, which import the real supabaseClient — mock it so this
// test exercises only the pure helpers exported beside the page (S756).
// jest.mock is hoisted above the import by babel-jest, so the mock is in place before it loads.
jest.mock('../../../supabaseClient', () => ({ supabase: { from: jest.fn(), rpc: jest.fn(), auth: {} } }))

describe('nextCodeAfter (S756: the prefix is escaped before it reaches RegExp)', () => {
  test('takes the max over matching codes', () => {
    expect(nextCodeAfter('itm', ['ITM-001', 'ITM-012', 'ITM-003'])).toBe('ITM-013')
  })

  test('a prefix with regex metacharacters matches literally', () => {
    // Unescaped, "A+" meant "one or more A", so AAA-050 counted as an A+ code.
    expect(nextCodeAfter('A+', ['A+-004', 'AAA-050'])).toBe('A+-005')
    // Unescaped, "V.N" matched "VXN-900".
    expect(nextCodeAfter('V.N', ['V.N-002', 'VXN-900'])).toBe('V.N-003')
  })

  test('a prefix that is not a valid pattern on its own does not throw', () => {
    expect(() => nextCodeAfter('(', ['(-001'])).not.toThrow()
    expect(nextCodeAfter('(', ['(-001'])).toBe('(-002')
  })

  test('an empty book starts at 001', () => {
    expect(nextCodeAfter('ITM', [])).toBe('ITM-001')
  })
})

// S792 (MASTER-5): `rememberInBook` is `setBook(b => bookWith(b, row, previousName))`. The book was
// rebuilt only on page load, so two items added in one visit were both minted ITM-010, and Recipe
// Import (which resolves an ingredient by code first) then linked the wrong one.
describe('bookWith (what a save adds to the item book, S792 MASTER-5)', () => {
  const loaded = () => ({
    byName: new Map([['milk', { id: 'i1', name: 'MILK', item_code: 'ITM-009' }]]),
    codes: ['ITM-009', 'SRC-001'],
  })

  test('two items added in one visit get different codes', () => {
    let book = loaded()
    // writeItem: mint from the book, insert, then remember what was written.
    const first = nextCodeAfter('ITM', book.codes)
    book = bookWith(book, { id: 'i2', name: 'ITEM A', item_code: first, is_sub_recipe: false })
    const second = nextCodeAfter('ITM', book.codes)
    book = bookWith(book, { id: 'i3', name: 'ITEM B', item_code: second, is_sub_recipe: false })
    expect(first).toBe('ITM-010')
    expect(second).toBe('ITM-011')
    expect(nextCodeAfter('ITM', book.codes)).toBe('ITM-012')
  })

  test('a name added earlier in the visit reads as taken, keyed to its own id', () => {
    const book = bookWith(loaded(), { id: 'i2', name: 'ITEM A', item_code: 'ITM-010' })
    expect(book.byName.get('item a')).toMatchObject({ id: 'i2' })
    // An edit of that same item is not a clash with itself — the name check compares ids.
    expect(book.byName.get('item a').id).toBe('i2')
  })

  test('a rename releases the old name and takes the new one', () => {
    const book = bookWith(loaded(), { id: 'i1', name: 'FULL CREAM MILK' }, 'MILK')
    expect(book.byName.has('milk')).toBe(false)
    expect(book.byName.get('full cream milk')).toMatchObject({ id: 'i1' })
    expect(book.codes).toEqual(['ITM-009', 'SRC-001'])  // an edit mints no code
  })

  test('a rename does not release a name another row holds', () => {
    const book = bookWith(loaded(), { id: 'i7', name: 'OAT MILK' }, 'MILK')
    expect(book.byName.get('milk')).toMatchObject({ id: 'i1' })
  })

  test('does not mutate the book it was given', () => {
    const before = loaded()
    bookWith(before, { id: 'i2', name: 'ITEM A', item_code: 'ITM-010' })
    expect(before.codes).toEqual(['ITM-009', 'SRC-001'])
    expect(before.byName.has('item a')).toBe(false)
  })

  test('a book that was never read stays unread, so the name check falls back to `items`', () => {
    expect(bookWith(null, { id: 'i2', name: 'ITEM A', item_code: 'ITM-010' })).toBeNull()
  })
})

// S855 (PERF-3): the list paints before the usage scan lands, so Del can be pressed while the scan
// is still running. The guard reads the scan's tri-state and fails CLOSED on anything but 'ok':
// three of the referencing tables CASCADE, so a delete on an unchecked item takes their rows with it.
describe('deleteGuard (S855: refuses on anything but a scan that answered)', () => {
  const base = { name: 'MILK', refs: [], failed: [], isAdmin: false }

  test('pending refuses with a plain wait sentence, marked so the page can take it down', () => {
    const v = deleteGuard({ ...base, status: 'pending' })
    expect(v).toEqual({ action: 'refuse', scanPending: true, text: 'Still checking where "MILK" is used. Try again in a moment.' })
  })

  test('pending refuses an admin too, and never offers force-delete off a map still being built', () => {
    const v = deleteGuard({ ...base, status: 'pending', isAdmin: true, refs: ['P'] })
    expect(v.action).toBe('refuse')
    expect(v.scanPending).toBe(true)
  })

  test('pending is not worded as a failure', () => {
    const v = deleteGuard({ ...base, status: 'pending' })
    expect(v.text).not.toMatch(/could not/i)
  })

  test('failed refuses with the could-not-check sentence, naming what could not be read', () => {
    const v = deleteGuard({ ...base, status: 'failed', failed: ['the usage records'] })
    expect(v.action).toBe('refuse')
    expect(v.scanPending).toBeUndefined()
    expect(v.text).toMatch(/^Crest could not check where "MILK" is used — the usage records could not be read, so it will not delete it\./)
    expect(v.text).toMatch(/there is no undo/)
  })

  test('failed refuses an admin with known references rather than offering force-delete', () => {
    expect(deleteGuard({ ...base, status: 'failed', isAdmin: true, refs: ['P'] }).action).toBe('refuse')
  })

  test('an unknown status refuses (fail closed)', () => {
    expect(deleteGuard({ ...base, status: undefined }).action).toBe('refuse')
    expect(deleteGuard({ ...base, status: 'ok?' }).action).toBe('refuse')
  })

  test('ok with no references opens the plain confirm', () => {
    expect(deleteGuard({ ...base, status: 'ok' })).toEqual({ action: 'confirm' })
    expect(deleteGuard({ ...base, status: 'ok', isAdmin: true })).toEqual({ action: 'confirm' })
  })

  test('ok with references refuses a non-admin, names the records and ends on Hide', () => {
    const v = deleteGuard({ ...base, status: 'ok', refs: ['CS', 'P'] })
    expect(v.action).toBe('refuse')
    expect(v.text).toMatch(/^"MILK" cannot be deleted — it has records in Closing Stock, Purchases,/)
    expect(v.text.endsWith(HIDE_INSTEAD)).toBe(true)
    // Neither table cascades, so the refusal claims no erasure (S766).
    expect(v.text).not.toMatch(/erase/)
  })

  test('erasure is claimed only for the tables that cascade', () => {
    const v = deleteGuard({ ...base, status: 'ok', refs: ['SM', 'P'] })
    expect(v.text).toMatch(/Deleting it would also erase its Staff Meals records\./)
  })

  test('ok with references offers an admin the force-delete, led by what holds the item', () => {
    expect(deleteGuard({ ...base, status: 'ok', isAdmin: true, refs: ['R', 'W'] }))
      .toEqual({ action: 'force', lead: '"MILK" is referenced in Recipes, Wastage.' })
  })

  test('a stock transfer blocks the force-delete outright (S849)', () => {
    const v = deleteGuard({ ...base, status: 'ok', isAdmin: true, refs: ['TR', 'P'] })
    expect(v.action).toBe('refuse')
    expect(v.text).toMatch(/cannot be force-deleted/)
  })
})
