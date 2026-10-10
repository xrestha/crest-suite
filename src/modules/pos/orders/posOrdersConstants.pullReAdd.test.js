// S809 ORDER-FLOW-13: a dish pulled, saved, then added back prints "+1" (and is made again), not
// "CHANGE ONLY". The ticket label is buildKotBotHtml's, so the test reads the printed label.
import { sentQtyAfterQtyChange } from './posOrdersConstants'
import { isChangeOnlyLine } from '../kitchenNotes'
import { buildKotBotHtml } from './posOrderPrintHtml'

const SEKUWA = { recipe_id: 'r-sekuwa', name: 'Pork Sekuwa', category: 'Food', qty: 3, sent_to_kot: true, sent_qty: 3, notes: '' }
// applyQty's rule for one line.
const setQty = (item, qty, pullSaved = false) => ({
  ...item, qty,
  sent_to_kot: item.qty === qty ? item.sent_to_kot : false,
  sent_qty: sentQtyAfterQtyChange(item, qty, pullSaved),
})
const label = line => {
  const html = buildKotBotHtml({ station: 'KOT', items: [line], ticketNo: 12, tableName: 'Table 4', covers: 2 })
  return html.includes('CHANGE ONLY') ? 'CHANGE ONLY' : (html.match(/class="qty">([^<]+)</) || [])[1]
}

describe('sentQtyAfterQtyChange — the count a ticket prints against', () => {
  test('unchanged for every case the old rule covered', () => {
    expect(sentQtyAfterQtyChange(SEKUWA, 4)).toBe(3)                                        // sent line, +1
    expect(sentQtyAfterQtyChange({ ...SEKUWA, sent_to_kot: false, sent_qty: 0 }, 4)).toBe(0) // never sent
    expect(sentQtyAfterQtyChange({ ...SEKUWA, sent_to_kot: false, sent_qty: 2 }, 4)).toBe(2) // 2 of 3 sent
    expect(sentQtyAfterQtyChange({ ...SEKUWA, sent_to_kot: false, sent_qty: 3, qty: 2 }, 1)).toBe(3) // a second cut
  })

  test('3 sent, cut to 2 and saved, added back to 3: the ticket reads +1, not CHANGE ONLY', () => {
    const pulled = setQty(SEKUWA, 2)                      // the pull: 2, unsent, still counting 3
    expect(label(pulled)).toBe('↓1 (now 2)')              // a KOT now still tells the kitchen to cut one
    const back = setQty(pulled, 3, true)                  // saved, then + again
    expect(back.sent_qty).toBe(2)
    expect(label(back)).toBe('+1')
    expect(isChangeOnlyLine(back)).toBe(false)            // no CHANGE card on the Kitchen Display either
  })

  test('the same, but the cut was never saved: the kitchen still has 3, so nothing new to make', () => {
    const back = setQty(setQty(SEKUWA, 2), 3, false)
    expect(back.sent_qty).toBe(3)
  })

  test('cut to 1 and saved, then up to 2 and 3: +1, then +2, against the saved 1', () => {
    const one = setQty(SEKUWA, 1)
    const two = setQty(one, 2, true)
    expect(label(two)).toBe('+1')
    const three = setQty(two, 3, true)
    expect(label(three)).toBe('+2')
  })
})
