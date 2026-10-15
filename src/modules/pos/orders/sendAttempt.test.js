// S809 ORDER-FLOW-3, -4, -5: a save whose answer was lost is settled by reading the order back, and only
// a till that holds an unanswered save of the order can take what is stored for its own.
import {
  SEND_LAND_GRACE_MS, noAnswer, newSendAttempt, stopWaiting, heldAsSent, firedElsewhere, judgeSendAttempts,
  stationsOf, firesTickets, unknownSendText, recentSaveOf, judgesById,
} from './sendAttempt'
import { toItemPayload } from './posOrdersConstants'

const ME = 'login-waiter'
const CASHIER = 'login-cashier'
const MOMO = { recipe_id: 'r-momo', name: 'Veg Momo', category: 'Food', qty: 2, unit_price: 200, vat_rate: 0, sent_to_kot: false, sent_qty: 0, notes: '' }
const TEA = { recipe_id: 'r-tea', name: 'Masala Tea', category: 'Beverage', qty: 2, unit_price: 120, vat_rate: 0, sent_to_kot: false, sent_qty: 0, notes: '' }
const sent = l => ({ ...l, sent_to_kot: true, sent_qty: l.qty })

// What save_pos_order_items stores for a payload (the parts the judge reads).
const stored = (version, lines, status = 'open') => ({
  id: 'o1', status, items_version: version,
  pos_order_items: lines.map(l => ({ ...toItemPayload(l), selection_key: l.selection_key || '' })),
})

// An attempt as performSave builds it: the cart before, the lines it marks sent, routed KOT/BOT.
function attemptFor({ cart, sendKeys, version = 4, known = [], finalAfter = null, saveId = null }) {
  const isSent = l => sendKeys.includes(l.recipe_id)
  const saved = cart.map(l => (isSent(l) ? sent(l) : l))
  const lines = cart.filter(isSent)
  const a = newSendAttempt({
    orderId: 'o1', orderNo: 12, where: 'Table 7', tableName: 'Table 7', covers: 2, expectedVersion: version,
    payload: saved.map(toItemPayload), snapshot: cart,
    kot: lines.filter(l => l.category !== 'Beverage'), bot: lines.filter(l => l.category === 'Beverage'),
    knownTicketIds: known, saveId,
  })
  a.finalAfter = finalAfter
  return a
}

describe('noAnswer — which failures leave a save not known', () => {
  test('a timeout, a dropped connection and a gateway error are no answer', () => {
    expect(noAnswer({ error: { name: 'TimeoutError', message: 'Saving timed out after 20s' } })).toBe(true)
    expect(noAnswer({ error: { message: 'TypeError: Failed to fetch' }, status: 0 })).toBe(true)
    expect(noAnswer({ error: { message: 'Bad gateway' }, status: 502 })).toBe(true)
    expect(noAnswer({ error: { message: 'something' } })).toBe(true) // no status at all: not an answer
  })
  test('a refusal is an answer, and so is a success', () => {
    expect(noAnswer({ error: { hint: 'stale_order', message: 'stale_order: …' }, status: 400 })).toBe(false)
    expect(noAnswer({ error: { code: '23505' }, status: 409 })).toBe(false)
    expect(noAnswer({ data: { items_version: 5 }, error: null, status: 200 })).toBe(false)
  })
})

describe('heldAsSent — what a save marking a line sent leaves on the order', () => {
  test('a new line is held once the order stores it sent at its quantity', () => {
    expect(heldAsSent(stored(5, [sent(MOMO)]).pos_order_items, MOMO)).toBe(true)
    expect(heldAsSent(stored(5, [MOMO]).pos_order_items, MOMO)).toBe(false)
    expect(heldAsSent(stored(5, [{ ...sent(MOMO), qty: 1, sent_qty: 1 }]).pos_order_items, MOMO)).toBe(false)
  })
  test('a line whose instruction changed counts as held only once it is flagged sent', () => {
    const changed = { ...MOMO, sent_qty: 2, notes: 'no peanuts' } // sent count already equals qty
    expect(heldAsSent(stored(5, [changed]).pos_order_items, changed)).toBe(false)
    expect(heldAsSent(stored(5, [sent(changed)]).pos_order_items, changed)).toBe(true)
  })
  test('two customizations of one dish are two lines', () => {
    const cheese = { ...MOMO, selection_key: 'opt-cheese' }
    expect(heldAsSent(stored(5, [sent(MOMO)]).pos_order_items, cheese)).toBe(false)
  })
})

describe('firedElsewhere — another till fired the same dishes while this one waited', () => {
  const a = attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], known: ['t-old'] })
  const ticket = (id, by, items) => ({ id, sent_by: by, items })
  test('a new ticket from another login carrying the dish', () => {
    expect(firedElsewhere(a, [ticket('t-new', CASHIER, [{ recipe_id: 'r-momo', qty: 2 }])], ME)).toBe(true)
  })
  test('not this login\'s own ticket, not a ticket the screen knew, not another dish, not a change line', () => {
    expect(firedElsewhere(a, [ticket('t-new', ME, [{ recipe_id: 'r-momo', qty: 2 }])], ME)).toBe(false)
    expect(firedElsewhere(a, [ticket('t-old', CASHIER, [{ recipe_id: 'r-momo', qty: 2 }])], ME)).toBe(false)
    expect(firedElsewhere(a, [ticket('t-new', CASHIER, [{ recipe_id: 'r-tea', qty: 1 }])], ME)).toBe(false)
    expect(firedElsewhere(a, [ticket('t-new', CASHIER, [{ recipe_id: 'r-momo', qty: 0, change: true }])], ME)).toBe(false)
  })
})

describe('judgeSendAttempts — ORDER-FLOW-3: a lost Send is found and finished, however it is retried', () => {
  // Table 7, a new order: 2 Veg Momo for the kitchen, 2 Masala Tea for the bar; Send Order lands, its answer is lost.
  const first = attemptFor({ cart: [MOMO, TEA], sendKeys: ['r-momo', 'r-tea'], version: 0 })

  test('the order as it landed: that send, exactly', () => {
    const v = judgeSendAttempts([first], stored(1, [sent(MOMO), sent(TEA)]), { profileId: ME })
    expect(v).toEqual({ verdict: 'landed', attempt: first, exact: true })
    expect(stationsOf(v.attempt)).toBe('KOT and BOT')
  })

  test('landed, then another tablet saved on top (one more dish): still that send', () => {
    const extra = { recipe_id: 'r-coke', name: 'Coke', category: 'Beverage', qty: 1, sent_to_kot: false, sent_qty: 0 }
    const v = judgeSendAttempts([first], stored(2, [sent(MOMO), sent(TEA), extra]), { profileId: ME })
    expect(v.verdict).toBe('landed')
    expect(v.exact).toBe(false) // the screen reloads rather than adopting the version over the other change
  })

  test('nothing landed yet, and the try may still be travelling: pending', () => {
    const a = stopWaiting(attemptFor({ cart: [MOMO], sendKeys: ['r-momo'] }), 1000)
    expect(judgeSendAttempts([a], stored(4, [MOMO]), { now: 1000 + SEND_LAND_GRACE_MS - 1 }).verdict).toBe('pending')
    expect(judgeSendAttempts([a], stored(4, [MOMO]), { now: 1000 + SEND_LAND_GRACE_MS }).verdict).toBe('lost')
  })

  test('another device saved instead, without these dishes sent: lost (it can no longer land)', () => {
    const a = stopWaiting(attemptFor({ cart: [MOMO], sendKeys: ['r-momo'] }), 1000)
    expect(judgeSendAttempts([a], stored(5, [MOMO, TEA]), { now: 1001 }).verdict).toBe('lost')
  })

  test('a closed bill settles it', () => {
    expect(judgeSendAttempts([first], stored(3, [sent(MOMO)], 'billed')).verdict).toBe('closed')
    expect(judgeSendAttempts([first], null).verdict).toBe('closed')
  })

  test('KOT lost, then Send for everything also lost: the one that matches what is stored landed', () => {
    const kot = attemptFor({ cart: [MOMO, TEA], sendKeys: ['r-momo'] })
    const all = attemptFor({ cart: [MOMO, TEA], sendKeys: ['r-momo', 'r-tea'] })
    expect(judgeSendAttempts([kot, all], stored(5, [sent(MOMO), sent(TEA)]), { profileId: ME }).attempt).toBe(all)
    expect(judgeSendAttempts([kot, all], stored(5, [sent(MOMO), TEA]), { profileId: ME }).attempt).toBe(kot)
  })

  test('a save that fires nothing is this till\'s only when the order is exactly what it saved', () => {
    const plain = attemptFor({ cart: [sent(MOMO), TEA], sendKeys: [] })
    expect(firesTickets(plain)).toBe(false)
    expect(judgeSendAttempts([plain], stored(5, [sent(MOMO), TEA])).verdict).toBe('landed')
    expect(judgeSendAttempts([plain], stored(5, [sent(MOMO), { ...TEA, qty: 3 }]), { now: 0 }).verdict).toBe('lost')
  })

  test('a save sent with no version check stays pending until its lines show up or the grace ends', () => {
    const a = stopWaiting(attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], version: null }), 1000)
    expect(judgeSendAttempts([a], stored(7, [MOMO]), { now: 2000 }).verdict).toBe('pending')
    expect(judgeSendAttempts([a], stored(8, [sent(MOMO)]), { now: 2000, profileId: ME }).verdict).toBe('landed')
  })
})

describe('judgeSendAttempts — ORDER-FLOW-4: the same dishes fired from two tablets print once', () => {
  test('no unanswered save of this order here: nothing to judge (the screen reloads)', () => {
    expect(judgeSendAttempts([], stored(5, [sent(MOMO)])).verdict).toBe('none')
  })

  test('this till\'s KOT got no answer and the cashier fired the same dishes: theirs, not reprinted', () => {
    const mine = attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], known: [] })
    const tickets = [{ id: 't-cashier', sent_by: CASHIER, items: [{ recipe_id: 'r-momo', qty: 2 }] }]
    const v = judgeSendAttempts([mine], stored(5, [sent(MOMO)]), { tickets, profileId: ME })
    expect(v.verdict).toBe('elsewhere')
  })

  test('this till\'s own earlier ticket for the dish does not count against it (a "+1" sent again)', () => {
    const before = { ...MOMO, qty: 3, sent_qty: 2 } // 2 sent earlier from this till, 1 more now
    const mine = attemptFor({ cart: [before], sendKeys: ['r-momo'], known: [] })
    const tickets = [{ id: 't-mine', sent_by: ME, items: [{ recipe_id: 'r-momo', qty: 2 }] }]
    expect(judgeSendAttempts([mine], stored(5, [sent(before)]), { tickets, profileId: ME }).verdict).toBe('landed')
  })
})

// S840: the server lists the saves that landed on the order by the id each was sent with.
const withSaves = (order, saves) => ({ ...order, recent_saves: saves })

describe('recentSaveOf / judgesById — the order\'s record of the saves that landed (S840)', () => {
  test('a save is found by its id, whatever its case, with the version it left', () => {
    const saves = [{ id: 'b2', v: 6 }, { id: 'a1', v: 5 }]
    expect(recentSaveOf(saves, 'A1')).toEqual({ id: 'a1', v: 5 })
    expect(recentSaveOf(saves, 'zz')).toBeNull()
    expect(recentSaveOf(null, 'a1')).toBeNull() // not read: a server before the column
    expect(recentSaveOf(saves, null)).toBeNull()
  })
  test('an attempt keeps its id lowercase, as the server stores it', () => {
    expect(newSendAttempt({ orderId: 'o1', saveId: 'ABC-1' }).saveId).toBe('abc-1')
    expect(newSendAttempt({ orderId: 'o1' }).saveId).toBeNull()
  })
  test('ids decide only when the list was read and every attempt was sent with one', () => {
    const a = attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], saveId: 'a1' })
    const old = attemptFor({ cart: [MOMO], sendKeys: ['r-momo'] })
    expect(judgesById([a], withSaves(stored(5, [sent(MOMO)]), []))).toBe(true)
    expect(judgesById([a], stored(5, [sent(MOMO)]))).toBe(false)
    expect(judgesById([a, old], withSaves(stored(5, [sent(MOMO)]), []))).toBe(false)
  })
})

describe('judgeSendAttempts by save id — ORDER-FLOW-4\'s residual (S840)', () => {
  test('two tablets on the SAME login fire the same dishes: the save not listed is not this till\'s, so no second ticket', () => {
    // This tablet's KOT (a1) got no answer. The other tablet, signed in as the same waiter, sent the
    // identical cart (b1) and landed first; a1 was refused as stale. Its ticket names this same login.
    const mine = stopWaiting(attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], known: [], saveId: 'a1' }), 1000)
    const theirs = [{ id: 't-other-tablet', sent_by: ME, items: [{ recipe_id: 'r-momo', qty: 2 }] }]
    const order = stored(5, [sent(MOMO)])
    // The content test alone took the identical lines for this till's own save, and printed again.
    expect(judgeSendAttempts([mine], order, { tickets: theirs, profileId: ME, now: 2000 }).verdict).toBe('landed')
    // By id: not listed, so another till's. Nothing prints, the waiter is told it was already sent.
    const v = judgeSendAttempts([mine], withSaves(order, [{ id: 'b1', v: 5 }]), { tickets: theirs, profileId: ME, now: 2000 })
    expect(v.verdict).toBe('elsewhere')
    expect(v.attempt).toBe(mine)
  })

  test('listed: it landed — exactly, or with another save on top since', () => {
    const a = attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], saveId: 'a1' })
    const exact = judgeSendAttempts([a], withSaves(stored(5, [sent(MOMO)]), [{ id: 'a1', v: 5 }]), { profileId: ME })
    expect(exact).toEqual({ verdict: 'landed', attempt: a, exact: true })
    const extra = { ...TEA, sent_to_kot: false }
    const onTop = judgeSendAttempts([a], withSaves(stored(6, [sent(MOMO), extra]), [{ id: 'b1', v: 6 }, { id: 'a1', v: 5 }]), { profileId: ME })
    expect(onTop).toEqual({ verdict: 'landed', attempt: a, exact: false })
  })

  test('listed: it landed even when another login logged a ticket for the same dish since (that ticket is the later save\'s +1)', () => {
    const a = attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], known: [], saveId: 'a1' })
    const tickets = [{ id: 't-cashier', sent_by: CASHIER, items: [{ recipe_id: 'r-momo', qty: 1 }] }]
    const v = judgeSendAttempts([a], withSaves(stored(6, [sent({ ...MOMO, qty: 3 })]), [{ id: 'c1', v: 6 }, { id: 'a1', v: 5 }]), { tickets, profileId: ME })
    expect(v.verdict).toBe('landed')
  })

  test('not listed and its version still stands: pending while it may land, then lost', () => {
    const a = stopWaiting(attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], saveId: 'a1' }), 1000)
    const order = withSaves(stored(4, [MOMO]), [{ id: 'z9', v: 4 }])
    expect(judgeSendAttempts([a], order, { now: 1000 + SEND_LAND_GRACE_MS - 1 }).verdict).toBe('pending')
    expect(judgeSendAttempts([a], order, { now: 1000 + SEND_LAND_GRACE_MS }).verdict).toBe('lost')
  })

  test('not listed, another save moved the order and its dishes are not sent: lost', () => {
    const a = stopWaiting(attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], saveId: 'a1' }), 1000)
    expect(judgeSendAttempts([a], withSaves(stored(5, [MOMO, TEA]), [{ id: 'b1', v: 5 }]), { now: 1001 }).verdict).toBe('lost')
  })

  test('a save that fires nothing and is not listed is lost, whatever the order holds', () => {
    const plain = stopWaiting(attemptFor({ cart: [sent(MOMO), TEA], sendKeys: [], saveId: 'a1' }), 0)
    expect(judgeSendAttempts([plain], withSaves(stored(5, [sent(MOMO), TEA]), [{ id: 'b1', v: 5 }]), { now: SEND_LAND_GRACE_MS }).verdict).toBe('lost')
  })

  test('KOT lost, then Send for everything also lost: the listed one landed', () => {
    const kot = attemptFor({ cart: [MOMO, TEA], sendKeys: ['r-momo'], saveId: 'k1' })
    const all = attemptFor({ cart: [MOMO, TEA], sendKeys: ['r-momo', 'r-tea'], saveId: 's1' })
    const order = stored(5, [sent(MOMO), sent(TEA)])
    expect(judgeSendAttempts([kot, all], withSaves(order, [{ id: 's1', v: 5 }]), { profileId: ME }).attempt).toBe(all)
    expect(judgeSendAttempts([kot, all], withSaves(stored(5, [sent(MOMO), TEA]), [{ id: 'k1', v: 5 }]), { profileId: ME }).attempt).toBe(kot)
  })

  test('a closed bill still settles it first', () => {
    const a = attemptFor({ cart: [MOMO], sendKeys: ['r-momo'], saveId: 'a1' })
    expect(judgeSendAttempts([a], withSaves(stored(5, [sent(MOMO)], 'billed'), [{ id: 'a1', v: 5 }])).verdict).toBe('closed')
  })
})

describe('unknownSendText — never says a send did not land when it may have', () => {
  test('the order was not confirmed: nothing has gone to a station', () => {
    expect(unknownSendText({ stage: 'order', press: 'Send Order' })).toMatch(/nothing has gone to the kitchen or bar/)
  })
  test('the lines may have landed: not known, and pressing again is safe', () => {
    const t = unknownSendText({ stage: 'lines', what: 'the KOT', press: 'KOT' })
    expect(t).toMatch(/not known yet whether the KOT went through/)
    expect(t).not.toMatch(/did not go through|nothing printed|not saved|nothing reached|nothing has gone/i)
    expect(t.startsWith('error:')).toBe(true)
  })
  test('a Just save that got no answer promises no ticket', () => {
    const t = unknownSendText({ stage: 'lines', what: 'your changes', press: 'Update Order', fires: false })
    expect(t).toMatch(/not known yet whether your changes saved/)
    expect(t).not.toMatch(/ticket/i)
  })
})
