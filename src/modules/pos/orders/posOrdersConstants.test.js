// lineKeyOf is the ONE definition of a cart line's identity (S758, Crest Customization). Every
// merge, diff, send and comp path in PosOrders.jsx keys on it. Two things are asserted here: that a
// line WITHOUT a customization keys exactly as it always did (recipe id, or `name:` for a
// recipe-less line) — the OFF path for every client without the module — and that two
// customizations of one recipe are two lines.
import {
  lineKeyOf, selectionKeyOf, missingFromServer, mergeUnsentLines, storedLinesMatchPayload,
  menuDrift, withServerLineFields, toItemPayload,
} from './posOrdersConstants'

const A = 'a1b2c3d4-0000-4000-8000-000000000001'
const B = 'a1b2c3d4-0000-4000-8000-000000000002'
const R = 'r-momo'

describe('lineKeyOf — the OFF path is byte-identical to the old key', () => {
  test('a plain line keys on its recipe id', () => {
    expect(lineKeyOf({ recipe_id: R, name: 'Momo' })).toBe(R)
    expect(lineKeyOf({ recipe_id: R, selection_key: '' })).toBe(R)
    expect(lineKeyOf({ recipe_id: R, option_ids: [] })).toBe(R)
  })
  test('a recipe-less line keys on its name, as before', () => {
    expect(lineKeyOf({ name: 'Open item' })).toBe('name:Open item')
  })
  test('a stored line_key wins', () => {
    expect(lineKeyOf({ line_key: 'x', recipe_id: R })).toBe('x')
  })
})

describe('lineKeyOf — a customization is part of the identity', () => {
  test('selection_key splits one recipe into distinct lines', () => {
    expect(lineKeyOf({ recipe_id: R, selection_key: A })).toBe(`${R}#${A}`)
    expect(lineKeyOf({ recipe_id: R, selection_key: A })).not.toBe(lineKeyOf({ recipe_id: R, selection_key: B }))
    expect(lineKeyOf({ recipe_id: R, selection_key: A })).not.toBe(lineKeyOf({ recipe_id: R }))
  })
  test('option_ids derive the same key the server computes, order-independent', () => {
    expect(selectionKeyOf([B, A])).toBe(`${A}+${B}`)
    expect(selectionKeyOf([A, B])).toBe(selectionKeyOf([B, A]))
    expect(selectionKeyOf([])).toBe('')
    expect(selectionKeyOf(null)).toBe('')
    expect(lineKeyOf({ recipe_id: R, option_ids: [B, A] })).toBe(`${R}#${A}+${B}`)
  })
})

describe('the helpers key on lineKeyOf', () => {
  const plain = { recipe_id: R, name: 'Momo', qty: 2, unit_price: 100, vat_rate: 0.13, notes: '', sent_to_kot: false, sent_qty: 0 }
  const custom = { ...plain, selection_key: A, unit_price: 150 }

  test('mergeUnsentLines merges the same line and keeps a customized one separate', () => {
    expect(mergeUnsentLines([plain], [{ ...plain, qty: 1 }])).toHaveLength(1)
    expect(mergeUnsentLines([plain], [{ ...plain, qty: 1 }])[0].qty).toBe(3)
    const merged = mergeUnsentLines([plain], [custom])
    expect(merged).toHaveLength(2)
    expect(merged.map(lineKeyOf).sort()).toEqual([R, `${R}#${A}`].sort())
  })

  test('missingFromServer diffs per line and carries the customization on what it puts back', () => {
    const missing = missingFromServer([plain, custom], [plain])
    expect(missing).toHaveLength(1)
    expect(missing[0].selection_key).toBe(A)
    // A plain line put back carries no customization keys at all — the old row shape exactly.
    const back = missingFromServer([plain], [])
    expect(Object.keys(back[0])).not.toContain('selection_key')
  })

  test('storedLinesMatchPayload tells two customizations of one recipe apart', () => {
    const stored = [{ ...plain, selection_key: A }]
    expect(storedLinesMatchPayload(stored, [{ ...plain, selection_key: A }])).toBe(true)
    expect(storedLinesMatchPayload(stored, [{ ...plain, selection_key: B }])).toBe(false)
    // OFF path: a stored row with no selection_key column at all matches a payload without one.
    expect(storedLinesMatchPayload([plain], [toItemPayload(plain)])).toBe(true)
  })

  test('menuDrift / withServerLineFields match the server line by key, not by recipe', () => {
    const server = [{ ...plain, unit_price: 100 }, { ...custom, unit_price: 175 }]
    expect(menuDrift([plain], server)).toBeNull()
    expect(menuDrift([custom], server)).toBe('price')
    const next = withServerLineFields([plain, custom], server)
    expect(next[0]).toBe(plain)               // untouched line keeps its identity
    expect(next[1].unit_price).toBe(175)      // the customized line took the server price
  })

  test('toItemPayload of a plain line is the old row shape — no options key', () => {
    expect(Object.keys(toItemPayload(plain))).not.toContain('options')
  })
})
