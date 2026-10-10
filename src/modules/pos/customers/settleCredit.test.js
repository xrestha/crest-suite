// S809 CUSTOMERS-PARKING-6, SHIFTS-4: a Settle whose answer was lost is read back, never reported as
// "not settled" and then as "already settled"; and the cash it brings is added to the drawer once.
import {
  SETTLE_TRY_MS, judgeSettled, settledWhen, postSettlementCash, settleCreditBill,
} from './settleCredit'
import { nepalTime } from '../../../shared/nepalTime'

const ME = 'login-me'
const SITA = 'login-sita'
const NAMES = { [ME]: 'Ram Supervisor', [SITA]: 'Sita' }
const T0 = Date.parse('2026-10-10T04:57:00.000Z') // 10:42 AM in Nepal
const SETTLED_AT = '2026-10-10T04:57:00.000+00:00'

const BILL = { id: 'b1', buyer_name: 'Hari', paid_amount: 3000, delivery_partner: null }
const PATHAO = { id: 'b2', buyer_name: 'Pathao', paid_amount: 5650, delivery_partner: 'Pathao' }

const ok = data => ({ data, error: null, status: 200 })
const TIMEOUT = { data: null, error: { name: 'TimeoutError', message: 'Settling the bill timed out after 20s — check your connection and try again.' } }
const DROPPED = { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }
const RANK = { data: null, status: 403, error: { code: '42501', hint: 'rank_required', message: 'pos_orders: settling a credit bill needs POS Supervisor access or above' } }
const stored = (over = {}) => ok({
  id: 'b1', paid_amount: 3000, commission_amount: null,
  credit_settled_at: SETTLED_AT, credit_settled_by: ME, credit_settled_method: 'Cash', ...over,
})
const unsettled = (over = {}) => stored({ credit_settled_at: null, credit_settled_by: null, credit_settled_method: null, ...over })

// The page's five calls, each answering from its own queue in order. An unexpected call throws.
function fakeDb(q = {}) {
  const queues = { settle: [], readBill: [], openShift: [], cashFor: [], addCash: [], ...q }
  const calls = { settle: [], readBill: [], openShift: 0, cashFor: [], addCash: [] }
  const take = name => {
    if (!queues[name].length) throw new Error(`unexpected ${name} call`)
    return Promise.resolve(queues[name].shift())
  }
  return {
    calls,
    settle: (id, patch, signal) => { calls.settle.push({ id, patch, signal }); return take('settle') },
    readBill: id => { calls.readBill.push(id); return take('readBill') },
    openShift: () => { calls.openShift += 1; return take('openShift') },
    cashFor: id => { calls.cashFor.push(id); return take('cashFor') },
    addCash: row => { calls.addCash.push(row); return take('addCash') },
  }
}
const SHIFT = ok({ id: 'shift-1' })
const ids = () => { let n = 0; return () => `cash-${++n}` }
const press = (db, extra = {}) => settleCreditBill({
  db, order: BILL, method: 'Cash', profileId: ME, tries: new Map(), names: NAMES, newId: ids(), now: () => T0, ...extra,
})

describe('judgeSettled — whose settlement a bill read back holds', () => {
  const tries = [{ method: 'Cash', at: T0 }]
  test('not found, not settled, and settled by another login', () => {
    expect(judgeSettled(null, { profileId: ME, method: 'Cash', tries, now: T0 })).toBe('unknown')
    expect(judgeSettled(unsettled().data, { profileId: ME, method: 'Cash', tries, now: T0 })).toBe('open')
    expect(judgeSettled(stored({ credit_settled_by: SITA }).data, { profileId: ME, method: 'Cash', tries, now: T0 })).toBe('other')
    expect(judgeSettled(stored({ credit_settled_by: null }).data, { profileId: ME, method: 'Cash', tries, now: T0 })).toBe('other')
    expect(judgeSettled(stored().data, { profileId: null, method: 'Cash', tries, now: T0 })).toBe('other')
  })
  test('this login, the method pressed, and an unanswered press of it on this page: it is that press', () => {
    expect(judgeSettled(stored().data, { profileId: ME, method: 'Cash', tries, now: T0 + 60000 })).toBe('mine')
  })
  test('this login but no such press here, another method, or a press too old: not taken as this one', () => {
    expect(judgeSettled(stored().data, { profileId: ME, method: 'Cash', tries: [], now: T0 })).toBe('yours')
    expect(judgeSettled(stored().data, { profileId: ME, method: 'eSewa', tries: [{ method: 'eSewa', at: T0 }], now: T0 })).toBe('yours')
    expect(judgeSettled(stored().data, { profileId: ME, method: 'Cash', tries, now: T0 + SETTLE_TRY_MS + 1 })).toBe('yours')
  })
})

describe('settledWhen', () => {
  test('the Nepal day and clock time', () => {
    expect(settledWhen(SETTLED_AT)).toContain(` at ${nepalTime(SETTLED_AT)}`)
    expect(settledWhen(SETTLED_AT)).toMatch(/2083/)
  })
})

describe('settleCreditBill — an answered settle', () => {
  test('Cash: settled once, the whole bill added to the open shift with a minted id', async () => {
    const db = fakeDb({ settle: [ok([{ id: 'b1' }])], openShift: [SHIFT], addCash: [ok([{ id: 'cash-1' }])] })
    const tries = new Map()
    const out = await press(db, { tries })
    expect(out).toEqual({ msg: "ok:NPR 3,000 collected from Hari via Cash. Added to the open shift's cash count.", closePanel: true, reload: true })
    expect(db.calls.settle[0].patch).toEqual({ credit_settled_at: new Date(T0).toISOString(), credit_settled_by: ME, credit_settled_method: 'Cash' })
    expect(db.calls.addCash).toEqual([{
      id: 'cash-1', shift_id: 'shift-1', direction: 'in', kind: 'credit_settlement', amount: 3000,
      reason: 'Credit bill settled — Hari', order_id: 'b1', created_by: ME,
    }])
    expect(db.calls.readBill).toEqual([])
    expect(tries.has('b1')).toBe(false)
  })
  test('a delivery partner pays the bill less its commission; a non-cash method touches no drawer', async () => {
    const cash = fakeDb({ settle: [ok([{ id: 'b2' }])], openShift: [SHIFT], addCash: [ok([{}])] })
    await press(cash, { order: PATHAO, commission: 1000 })
    expect(cash.calls.settle[0].patch.commission_amount).toBe(1000)
    expect(cash.calls.addCash[0].amount).toBe(4650)

    const bank = fakeDb({ settle: [ok([{ id: 'b2' }])] })
    const out = await press(bank, { order: PATHAO, commission: 1000, method: 'Bank Transfer' })
    expect(out.msg).toBe('ok:NPR 4,650 collected from Pathao via Bank Transfer.')
    expect(bank.calls.openShift).toBe(0)
  })
  test("the server's refusal is not settled, and says why", async () => {
    const db = fakeDb({ settle: [RANK] })
    const tries = new Map()
    const out = await press(db, { tries })
    expect(out.msg).toMatch(/^error:The bill was not marked as settled\. /)
    expect(out.closePanel).toBe(false)
    expect(db.calls.readBill).toEqual([])
    expect(tries.get('b1')).toEqual([])
  })
})

describe('settleCreditBill — a lost answer is read back (CUSTOMERS-PARKING-6)', () => {
  test('the settle landed: it is this press, and its cash reaches the drawer once', async () => {
    const db = fakeDb({
      settle: [TIMEOUT], readBill: [stored()], cashFor: [ok([])], openShift: [SHIFT], addCash: [ok([{}])],
    })
    const out = await press(db)
    expect(db.calls.settle[0].signal.aborted).toBe(true)
    expect(out.msg).toMatch(/^ok:NPR 3,000 collected from Hari via Cash \(checked by reading the bill back: it is settled once\)\. Added/)
    expect(out.msg).not.toMatch(/not marked as settled|already been settled/)
    expect(db.calls.addCash).toHaveLength(1)
  })
  test('unreadable, then pressed again: the second press finds the first one\'s settlement and finishes it', async () => {
    const tries = new Map()
    const first = await press(fakeDb({ settle: [DROPPED], readBill: [DROPPED] }), { tries })
    expect(first.msg).toMatch(/^warn:It is not known whether this bill was settled/)
    expect(first.msg).toMatch(/Do not hand any money back/)
    expect(first.msg).toMatch(/not on the drawer record yet/)
    expect(first).toMatchObject({ closePanel: false, reload: false })
    expect(tries.get('b1')).toHaveLength(1)

    const db = fakeDb({ settle: [ok([])], readBill: [stored()], cashFor: [ok([])], openShift: [SHIFT], addCash: [ok([{}])] })
    const second = await press(db, { tries, now: () => T0 + 90000 })
    expect(second.msg).toMatch(/^ok:NPR 3,000 collected from Hari via Cash/)
    expect(db.calls.addCash).toHaveLength(1)
    expect(db.calls.addCash[0].amount).toBe(3000)
    expect(tries.has('b1')).toBe(false)
  })
  test('the cash of that settlement already on the drawer record is not added again', async () => {
    const db = fakeDb({ settle: [TIMEOUT], readBill: [stored()], cashFor: [ok([{ id: 'm1' }])] })
    const out = await press(db)
    expect(out.msg).toMatch(/already on the drawer record, so it was not added again\.$/)
    expect(db.calls.openShift).toBe(0)
  })
  test('the cash entry is read with the stored commission, not the one on screen now', async () => {
    const db = fakeDb({
      settle: [TIMEOUT], readBill: [stored({ id: 'b2', paid_amount: 5650, commission_amount: 1000 })],
      cashFor: [ok([])], openShift: [SHIFT], addCash: [ok([{}])],
    })
    await press(db, { order: PATHAO, commission: 300 })
    expect(db.calls.addCash[0].amount).toBe(4650)
  })
  test('still not settled after no answer: it may yet land, so wait and press again, which then settles it once', async () => {
    const tries = new Map()
    const first = await press(fakeDb({ settle: [TIMEOUT], readBill: [unsettled()] }), { tries })
    expect(first.msg).toMatch(/^warn:No answer came back, and the bill still shows as not settled — the settlement may still arrive/)
    expect(first.msg).toMatch(/press Cash again/)
    expect(first.closePanel).toBe(false)

    const db = fakeDb({ settle: [ok([{ id: 'b1' }])], openShift: [SHIFT], addCash: [ok([{}])] })
    const second = await press(db, { tries })
    expect(second.msg).toMatch(/^ok:/)
    expect(db.calls.addCash).toHaveLength(1)
  })
})

describe('settleCreditBill — a press that matched nothing says who settled it', () => {
  test('another login: named, with the time and method, and no cash added', async () => {
    const db = fakeDb({ settle: [ok([])], readBill: [stored({ credit_settled_by: SITA })] })
    const out = await press(db)
    expect(out.msg).toBe(
      `error:This bill was already settled by Sita on ${settledWhen(SETTLED_AT)}, by Cash. Nothing was changed by this press and no cash was added to the drawer. ` +
      'If the customer is paying you now, check with Sita before taking or handing back any money — it may already have been paid.')
    expect(out).toMatchObject({ closePanel: true, reload: true })
    expect(db.calls.openShift).toBe(0)
  })
  test('a login whose name is unknown is "another login"', async () => {
    const out = await press(fakeDb({ settle: [ok([])], readBill: [stored({ credit_settled_by: 'login-gone' })] }))
    expect(out.msg).toMatch(/settled by another login on .* find out who settled it/)
  })
  test('this login, but not a press on this page: reported, never added to the drawer by itself', async () => {
    const db = fakeDb({ settle: [ok([])], readBill: [stored()] })
    const out = await press(db)
    expect(out.msg).toMatch(/^error:This bill was already settled from your login on .*, by Cash\. Nothing was changed/)
    expect(out.msg).toMatch(/look in Shifts for a "Credit settled" entry for Hari, and add it as a Cash In only if there is none\.$/)
    expect(db.calls.addCash).toEqual([])
  })
  test('pressed again with another method after a lost Cash press: the method stands, no cash is added', async () => {
    const tries = new Map()
    await press(fakeDb({ settle: [DROPPED], readBill: [DROPPED] }), { tries })
    const db = fakeDb({ settle: [ok([])], readBill: [stored()] })
    const out = await press(db, { tries, method: 'eSewa' })
    expect(out.msg).toMatch(/by Cash\. A settlement's method cannot be changed afterwards\./)
    expect(db.calls.addCash).toEqual([])
  })
  test('an unanswered press older than SETTLE_TRY_MS is not finished by itself', async () => {
    const tries = new Map()
    await press(fakeDb({ settle: [DROPPED], readBill: [DROPPED] }), { tries })
    const db = fakeDb({ settle: [ok([])], readBill: [stored()] })
    const out = await press(db, { tries, now: () => T0 + SETTLE_TRY_MS + 1000 })
    expect(out.msg).toMatch(/from your login/)
    expect(db.calls.addCash).toEqual([])
  })
  test('matched nothing and the read-back failed: who settled it is on Collected', async () => {
    const out = await press(fakeDb({ settle: [ok([])], readBill: [DROPPED] }))
    expect(out.msg).toMatch(/^error:This press changed nothing — the bill looks already settled/)
    expect(out.msg).toMatch(/under Collected says who settled it/)
  })
})

describe('postSettlementCash — the drawer entry (SHIFTS-4)', () => {
  const cash = (db, extra = {}) => postSettlementCash({ db, order: BILL, amount: 3000, profileId: ME, newId: ids(), ...extra })

  test('no shift open: keep it out of the next float and record it, or count it and record nothing', async () => {
    const out = await cash(fakeDb({ openShift: [ok(null)] }))
    expect(out.warn).toBe(true)
    expect(out.text).toBe(' No shift is open, so this NPR 3,000 is not on any drawer count. Keep it out of the float you count when the next shift opens, then record it as a Cash In on that shift. If it stays in the drawer and is counted in the float, record nothing.')
  })
  test('a failed shift read says nothing was added, never "no shift"', async () => {
    const out = await cash(fakeDb({ openShift: [DROPPED] }))
    expect(out.text).toMatch(/^ Could not check whether a shift is open, so this NPR 3,000 was not added to any drawer count\. If a shift is open, add it there as a Cash In\./)
  })
  test('a refused entry leaves the drawer OVER, not short', async () => {
    const out = await cash(fakeDb({ openShift: [SHIFT], addCash: [{ data: null, status: 403, error: { code: '42501', hint: 'pos_cash_movement_rank', message: 'pos_cash_movement_rank: recording cash …' } }] }))
    expect(out.text).toMatch(/the drawer will read NPR 3,000 over — add it as a Cash In on that shift\./)
    expect(out.text).not.toMatch(/short/)
  })
  test('a shift that closed in between: the no-shift steps', async () => {
    const out = await cash(fakeDb({ openShift: [SHIFT], addCash: [{ data: null, status: 400, error: { code: 'P0001', hint: 'pos_cash_movement_shift_closed', message: 'pos_cash_movement_shift_closed: that shift is closed' } }] }))
    expect(out.text).toMatch(/^ The shift closed before this NPR 3,000 could be added.*record nothing\.$/)
  })
  test('a lost answer is sent again with the same id; landing then, or a duplicate key, is added', async () => {
    const db = fakeDb({ openShift: [SHIFT], addCash: [DROPPED, ok([{}])] })
    expect(await cash(db)).toEqual({ warn: false, text: " Added to the open shift's cash count." })
    expect(db.calls.addCash.map(r => r.id)).toEqual(['cash-1', 'cash-1'])

    const dup = fakeDb({ openShift: [SHIFT], addCash: [TIMEOUT, { data: null, status: 409, error: { code: '23505', message: 'duplicate key value violates unique constraint "pos_cash_movements_pkey"' } }] })
    expect((await cash(dup)).warn).toBe(false)
  })
  test('no answer twice: not known — look before adding, never "could not be added"', async () => {
    const out = await cash(fakeDb({ openShift: [SHIFT], addCash: [DROPPED, TIMEOUT] }))
    expect(out.text).toBe(' It is not known whether this NPR 3,000 reached the open shift\'s cash count: the answer was lost. Before adding anything, look in Shifts for a "Credit settled" entry for Hari, and add it as a Cash In only if there is none.')
  })
  test('checkFirst: a failed look adds nothing', async () => {
    const db = fakeDb({ cashFor: [DROPPED] })
    const out = await cash(db, { checkFirst: true })
    expect(out.text).toMatch(/^ Could not check whether this NPR 3,000 is already on the drawer record, so nothing was added/)
    expect(db.calls.openShift).toBe(0)
  })
})
