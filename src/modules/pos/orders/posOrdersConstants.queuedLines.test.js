// S809 3f (review): a customized dish read back from the offline queue keeps its choices. Queued rows are a
// save's payload (`options` = the option ids) with the cart's display copy beside them; read as a plain
// dish, the next save dropped the choices and a conflict recovery doubled the line.
import { cartLineFromStored, lineKeyOf, toItemPayload, missingFromServer, storedLinesMatchPayload } from './posOrdersConstants'
import { queuedRows, replayRows } from './offlineUpload'

const CHEESE = { option_id: 'opt-cheese', option_name: 'Extra cheese', kitchen_name: 'XTRA CHEESE', is_removal: false, sort: 2 }
const ONION = { option_id: 'opt-onion', option_name: 'No onion', kitchen_name: 'NO ONION', is_removal: true, sort: 1 }
// A customized cart line as the choice window builds it.
const MOMO_CUSTOM = {
  recipe_id: 'r-momo', name: 'Veg Momo', category: 'Food', qty: 2, unit_price: 260, vat_rate: 0,
  sent_to_kot: true, sent_qty: 2, notes: null,
  selection_key: 'opt-cheese+opt-onion', option_ids: ['opt-cheese', 'opt-onion'],
  option_summary: 'Extra cheese, No onion', options: [CHEESE, ONION],
}
const MOMO_PLAIN = { recipe_id: 'r-momo', name: 'Veg Momo', category: 'Food', qty: 1, unit_price: 200, vat_rate: 0, sent_to_kot: true, sent_qty: 1, notes: null }

const queued = queuedRows([MOMO_CUSTOM, MOMO_PLAIN].map(toItemPayload), [MOMO_CUSTOM, MOMO_PLAIN])

describe('a queued row read back as a cart line', () => {
  test('keeps its choices, its line key and what the screen and the ticket show', () => {
    const line = cartLineFromStored(queued[0])
    expect(line.option_ids).toEqual(['opt-cheese', 'opt-onion'])
    expect(lineKeyOf(line)).toBe(lineKeyOf(MOMO_CUSTOM))
    expect(line.option_summary).toBe('Extra cheese, No onion')
    expect(line.options.map(o => o.option_name)).toEqual(['No onion', 'Extra cheese']) // display order
    expect(line.option_snapshot).toBeUndefined()
  })

  test('its next save carries the same choices', () => {
    expect(toItemPayload(cartLineFromStored(queued[0])).options).toEqual(toItemPayload(MOMO_CUSTOM).options)
  })

  test('a plain dish stays plain', () => {
    const line = cartLineFromStored(queued[1])
    expect(line.selection_key).toBeUndefined()
    expect(lineKeyOf(line)).toBe('r-momo')
  })

  test('a row queued before the display copy existed still keeps its choices (shown without names)', () => {
    const line = cartLineFromStored(toItemPayload(MOMO_CUSTOM))
    expect(lineKeyOf(line)).toBe(lineKeyOf(MOMO_CUSTOM))
    expect(line.options).toEqual([])
  })

  test('a conflict recovery puts back nothing the order already holds', () => {
    const stored = [{ ...toItemPayload(MOMO_CUSTOM), selection_key: 'opt-cheese+opt-onion' }, { ...toItemPayload(MOMO_PLAIN), selection_key: '' }]
    expect(missingFromServer(queued.map(cartLineFromStored), stored)).toEqual([])
  })

  test('a stored line from the server reads as before', () => {
    const fromServer = { ...toItemPayload(MOMO_CUSTOM), options: undefined, selection_key: 'opt-cheese+opt-onion', pos_order_item_options: [CHEESE, ONION] }
    const line = cartLineFromStored(fromServer)
    expect(line.option_ids).toEqual(['opt-cheese', 'opt-onion'])
    expect(line.options).toEqual([ONION, CHEESE])
  })
})

describe('the upload sends the payload as built', () => {
  test('the display copy never reaches save_pos_order_items, and the read-back still matches', () => {
    const rows = replayRows(queued)
    expect(rows).toEqual([MOMO_CUSTOM, MOMO_PLAIN].map(toItemPayload))
    expect(storedLinesMatchPayload(rows, queued)).toBe(true)
  })
})
