// The till, day by day: bills with their lines, choices, kitchen tickets, payments, loyalty,
// shifts, cash movements, credit notes, bookings — and what each bill posts to Inventory.
import { rngFor, uid, ts, tsSec, round2, round4 } from './lib.mjs'
import { MENU, FIRST, LAST, FY, BASE_CUTOFF } from './config.mjs'
import { tradeFactor, BS_MONTHS, monthDays } from './calendar.mjs'

const DAYPARTS = {
  ktm: [['breakfast', 480, 660, 18], ['lunch', 690, 900, 36], ['afternoon', 900, 1050, 20], ['dinner', 1050, 1185, 26]],
  pkr: [['breakfast', 480, 660, 20], ['lunch', 690, 900, 30], ['afternoon', 900, 1050, 19], ['dinner', 1050, 1245, 31]],
}
const WEEKDAY = [0.96, 0.9, 0.92, 0.95, 1.0, 1.14, 1.24]          // Sun … Sat (Saturday is the weekend)
const DENOMS = [1000, 500, 100, 50, 20, 10, 5, 2, 1]
const VOID_REASONS = ['Guest left before the food came', 'Order punched on the wrong table', 'Duplicate order entered']
const COMP_BILL_REASONS = ["Owner's guests — tasting", 'Long wait — apology to the table', 'Supplier meeting']
const ITEM_COMP_REASONS = ['Hair in food — replaced, not charged', 'Wrong item served', 'Birthday treat for a regular', 'Coffee spilled — remade free', 'Cold food — not charged']
const PULL_REASONS = ['Guest changed their order', 'Kitchen ran out', 'Entered twice by mistake']
const PAY_KEYS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay', 'Loyalty', 'Credit']

export function denominationsFor(amount) {
  let left = Math.round(amount)
  const out = {}
  for (const d of DENOMS) { out[d] = Math.floor(left / d); left -= out[d] * d }
  return out
}

export function simulatePos({ outlet, M, days, cutoff, staff, periodIdOf, partners }) {
  const o = outlet.key, cid = outlet.clientId
  const id = (...k) => uid(o, ...k)
  const R = rngFor(o, 'pos')
  const dishes = MENU.map(d => M.dishByCode[d.code])
  const dayparts = DAYPARTS[o]

  // ── Regulars (the loyalty book) ──
  const nRegulars = o === 'ktm' ? 42 : 22
  const Rc = rngFor(o, 'customers')
  const regulars = []
  const used = new Set()
  for (let i = 0; i < nRegulars; i++) {
    let name
    do { name = `${Rc.pick(FIRST)} ${Rc.pick(LAST)}` } while (used.has(name))
    used.add(name)
    const phone = `98000${o === 'ktm' ? '3' : '4'}${String(1000 + i * 37 + Rc.int(0, 30)).padStart(4, '0')}`
    regulars.push({
      id: id('customer', i), client_id: cid, name, phone, weight: Rc.weighted([[6, 2], [3, 4], [1, 10]]),
      address: o === 'ktm' ? Rc.pick(['Jhamsikhel', 'Sanepa', 'Kupondole', 'Pulchowk', 'Bakhundole', 'Jawalakhel', 'Baneshwor']) : Rc.pick(['Lakeside', 'Baidam', 'Chipledhunga', 'Nayabazar']),
      loyalty_scheme_id: id('loyalty'), created_at: ts(days[0].ad, 600 - Rc.int(0, 300)), points: 0, firstDay: Rc.int(0, 25),
    })
  }
  const schemes = [{ id: id('loyalty'), client_id: cid, name: 'Bloom Rewards', points_per_100: 5, min_spend_to_earn: 0, is_active: true, created_at: ts(days[0].ad, 420) }]

  const byDay = {}
  const allOrders = []
  const ncEvents = []           // writeoff bills + item comps, numbered from one pool
  const creditNotes = []
  const reservations = [], resTables = []
  const openTableIds = new Set()

  // Event days, chosen once (never the cut-off day itself).
  const past = days.filter(d => d.ad < BASE_CUTOFF.ad)
  const Re = rngFor(o, 'events')
  const pickDays = n => Re.shuffle(past.slice(3)).slice(0, n).map(d => d.key)
  const ev = {
    void: new Set(o === 'ktm' ? ['4-9', '5-3', '5-27', '6-15'] : ['4-18', '6-11']),
    writeoff: new Set(o === 'ktm' ? ['4-20', '5-14', '6-10'] : ['5-6', '6-16']),
    itemComp: new Set(pickDays(o === 'ktm' ? 9 : 5)),
    creditNote: o === 'ktm' ? { '5-8': 'cash', '6-18': 'other' } : { '6-7': 'cash' },
    pull: new Set(pickDays(o === 'ktm' ? 6 : 3)),
    corporate: new Set(o === 'ktm' ? ['4-12', '4-26', '5-10', '5-24', '6-8', '6-21'] : []),
    short: o === 'ktm' ? { '5-21': -350, '4-15': -20, '6-5': 50 } : { '6-12': -120, '5-2': 30 },
    payOut: o === 'ktm'
      ? { '4-6': [350, 'Ice and lemons from the market'], '4-23': [600, 'Plumber — sink repair'], '5-11': [400, 'Flowers for the counter'], '5-30': [250, 'Courier — documents to the bank'], '6-9': [500, 'Extra milk from the shop'] }
      : { '4-13': [300, 'Ice from the market'], '5-17': [450, 'Gas cylinder porter'], '6-13': [250, 'Lemons from the shop'] },
  }

  const monthPaid = {}

  for (const day of days) {
    const Rd = rngFor(o, 'day', day.key)
    const isCut = day.ad === cutoff.ad
    const out = byDay[day.key] = { orders: [], items: [], itemOptions: [], payments: [], kot: [], removals: [], ledger: [], cashMoves: [], sales: [], moves: [], usage: {}, usageBase: {}, notes: [], creditSales: [], shift: null }
    const isBaseDay = day.ad === BASE_CUTOFF.ad
    const periodId = periodIdOf(day.m)

    // Who is in today, and who is at the till at a given minute.
    const sup = [staff.cashier, staff.manager].filter(k => staff.working(k, day))
    const supAt = (t, prefer) => [prefer, staff.cashier, staff.manager].find(k => k && staff.onAt(k, day, t)) || sup[0] || staff.manager
    const openerAt = (t, dine) => (dine && staff.onAt(staff.captain, day, t) ? staff.captain : supAt(t))
    const mgrOn = staff.working(staff.manager, day)

    // How many bills.
    let n = outlet.billsPerDay * WEEKDAY[day.wd] * outlet.monthFactor[day.m] * tradeFactor(o, day.key) * Rd.float(0.88, 1.12)
    if (o === 'ktm' && day.m === 4 && day.d >= 5 && day.d <= 8) n *= 0.85     // heavy monsoon rain week
    n = Math.round(n)
    const cap = outlet.maxPaidBillsPerMonth
    const soFar = monthPaid[day.m] || 0
    const daysLeft = day.ad <= BASE_CUTOFF.ad
      ? days.filter(x => x.m === day.m && x.idx >= day.idx && x.ad <= BASE_CUTOFF.ad).length
      : monthDays(day.m) - day.d + 1
    if (soFar + n > cap - (daysLeft - 1) * outlet.billsPerDay * 0.8) n = Math.max(12, Math.floor((cap - soFar) / Math.max(1, daysLeft)))

    // Bill times.
    const times = []
    for (let i = 0; i < n; i++) {
      const [part, a, b] = Rd.weighted(dayparts.map(p => [p, p[3]]))
      times.push({ part, t: Rd.int(a, b) })
    }
    times.sort((x, y) => x.t - y.t)

    const tableFreeAt = Object.fromEntries(M.tables.map(t => [t.id, 0]))
    const shiftOpen = outlet.open - 20 + Rd.int(-5, 5)
    const lastClose = outlet.close + 5

    const bills = []
    // A bill the first build already loaded draws from the day's shared stream, exactly as it did
    // then. Anything later (days after it, and its own evening) draws from a stream of its own, so
    // adding it never changes a bill already loaded.
    const ownStream = t => day.ad > BASE_CUTOFF.ad || (isBaseDay && t > BASE_CUTOFF.minutes - 6)
    for (const [bi, { part, t }] of times.entries()) {
      if (isCut && t > cutoff.minutes - 6) continue
      const Rb = ownStream(t) ? rngFor(o, 'bill-a', day.key, bi) : Rd
      let channel = Rb.weighted(outlet.channel)
      if (part === 'breakfast' && channel === 'delivery') channel = 'takeaway'
      let covers = channel === 'dine' ? Rb.weighted([[1, 22], [2, 45], [3, 17], [4, 11], [5, 3], [6, 2]]) : 1
      const corporate = ev.corporate.has(day.key) && part === 'lunch' && !bills.some(b => b.corporate)
      if (corporate) { channel = 'dine'; covers = Rb.int(7, 9) }

      // Lines.
      const pFood = { breakfast: 0.5, lunch: 0.92, afternoon: 0.5, dinner: 0.9 }[part]
      const pDrink = { breakfast: 0.96, lunch: 0.72, afternoon: 0.95, dinner: 0.68 }[part]
      const picks = []
      const nPeople = channel === 'delivery' ? Rb.int(1, 3) : covers
      for (let c = 0; c < nPeople; c++) {
        if (Rb.chance(channel === 'delivery' ? 0.95 : pFood)) picks.push(pickDish(Rb, dishes, 'Food', part))
        if (Rb.chance(channel === 'delivery' ? 0.45 : pDrink)) picks.push(pickDish(Rb, dishes, 'Beverage', part, channel === 'delivery'))
      }
      if (covers >= 3 && picks.filter(p => p.cat === 'Food').length >= 3 && Rb.chance(0.35)) picks.splice(picks.findIndex(p => p.cat === 'Food'), 1)
      if (!picks.length) picks.push(pickDish(Rb, dishes, 'Beverage', part))
      const lineMap = new Map()
      for (const dish of picks) {
        const optIds = chooseOptions(Rb, dish, M, o)
        const key = dish.code + '#' + [...optIds].sort().join('+')
        const l = lineMap.get(key) || { dish, optIds, qty: 0 }
        l.qty += 1
        lineMap.set(key, l)
      }
      const lines = [...lineMap.values()]

      // Table.
      let table = null
      if (channel === 'dine') {
        table = M.tables.filter(tb => tb.capacity >= Math.min(covers, 6) && tableFreeAt[tb.id] <= t)
          .sort((x, y) => x.capacity - y.capacity)[0] || null
        if (!table) channel = 'takeaway'
      }
      const dwell = channel === 'dine' ? Rb.int(28, 40) + covers * Rb.int(4, 9) : channel === 'takeaway' ? Rb.int(8, 16) : Rb.int(12, 22)
      let closeAt = Math.min(t + dwell, lastClose - 2)
      if (closeAt <= t) closeAt = t + 3
      if (table) tableFreeAt[table.id] = closeAt + 5

      bills.push({ part, t, closeAt, channel, covers, lines, table, corporate, bi })
    }

    // Shape each bill.
    const dayBills = []
    let voidDone = false, woDone = false, compDone = false, cnDone = false, pullDone = false
    const shapeBill = (b, Rs, { isOpenNow, cutMin, allowEvents, orderIndex }) => {
      const orderId = id('order', day.key, orderIndex)
      const ord = {
        id: orderId, client_id: cid, table_id: b.table?.id || null, table_name: b.table?.name || 'Takeaway',
        status: 'open', covers: b.covers, notes: null,
        opened_by: profileFor(staff, openerAt(b.t, b.channel === 'dine')),
        opened_at: ts(day.ad, b.t), created_at: ts(day.ad, b.t), order_no: null,
        print_count: 0, comp_print_count: 0, items_version: 1,
        _t: b.t, _close: b.closeAt, _day: day, _lines: b.lines, _channel: b.channel,
      }

      // Kind of close.
      let kind = 'paid'
      if (isOpenNow) kind = 'open'
      else if (allowEvents && !voidDone && ev.void.has(day.key) && b.part !== 'breakfast' && b.lines.length >= 2 && staff.onAt(staff.manager, day, b.closeAt)) { kind = 'void'; voidDone = true }
      else if (allowEvents && !woDone && ev.writeoff.has(day.key) && b.channel === 'dine' && b.part !== 'breakfast' && staff.onAt(staff.manager, day, b.closeAt)) { kind = 'writeoff'; woDone = true }

      // Lines → rows (a comp splits one portion off a line).
      let compLine = null
      if (allowEvents && kind === 'paid' && !compDone && ev.itemComp.has(day.key) && b.channel === 'dine') { compLine = 0; compDone = true }
      const itemRows = []
      b.lines.forEach((l, li) => {
        const price = l.dish.price + l.optIds.reduce((s, oid) => s + M.optionById[oid].delta, 0)
        const sel = [...l.optIds].sort()
        const opts = sel.map(oid => M.optionById[oid])
        const summary = opts.length ? [...opts].sort((x, y) => (x.groupSort * 1000 + x.sort) - (y.groupSort * 1000 + y.sort)).map(x => x.name).join(' · ') : null
        const base = {
          order_id: orderId, client_id: cid, recipe_id: l.dish.id, name: l.dish.name, unit_price: price, vat_rate: 0.13,
          notes: null, sent_to_kot: true, created_at: ts(day.ad, b.t + 1), category: l.dish.cat,
          selection_key: sel.join('+'), base_unit_price: sel.length ? l.dish.price : null,
          options_delta: sel.length ? price - l.dish.price : null, option_summary: summary,
          comped: false, _line: l, _opts: opts,
        }
        if (compLine === li) {
          if (l.qty > 1) itemRows.push({ ...base, id: id('oi', orderId, li, 'a'), qty: l.qty - 1, sent_qty: l.qty - 1 })
          itemRows.push({ ...base, id: id('oi', orderId, li, 'c'), qty: 1, sent_qty: 1, comped: true,
            comp_reason: Rs.pick(ITEM_COMP_REASONS), comped_by: profileFor(staff, supAt(b.closeAt - 3, staff.manager)), comped_at: ts(day.ad, b.closeAt - 3), comp_fy: FY, comp_no: null })
        } else {
          itemRows.push({ ...base, id: id('oi', orderId, li), qty: l.qty, sent_qty: l.qty })
        }
      })

      // Pulled item: one extra portion went to the kitchen and was taken off the bill.
      let pulled = null
      if (allowEvents && kind === 'paid' && !pullDone && ev.pull.has(day.key) && b.channel === 'dine' && b.lines.length >= 2) {
        pullDone = true
        const l = b.lines[b.lines.length - 1]
        pulled = { line: l, qty: 1, reason: Rs.pick(PULL_REASONS) }
      }

      // Kitchen tickets, one per station.
      const sentAt = b.t + 2
      for (const station of ['KOT', 'BOT']) {
        const stLines = b.lines.filter(l => (l.dish.cat === 'Beverage') === (station === 'BOT'))
        if (!stLines.length) continue
        const prep = station === 'KOT' ? Rs.int(9, 18) : Rs.int(3, 6)
        const ready = Math.min(sentAt + 1 + prep, b.closeAt - 1)
        const isLast = isOpenNow && station === 'KOT'
        out.kot.push({
          id: id('kot', orderId, station), client_id: cid, order_id: orderId, order_no: null, table_name: ord.table_name, station,
          items: stLines.map(l => {
            const sel = [...l.optIds].sort()
            const opts = sel.map(oid => M.optionById[oid])
            return {
              recipe_id: l.dish.id, name: l.dish.name, category: l.dish.cat,
              ...(sel.length ? { selection_key: sel.join('+'), options: opts.map(x => ({ kitchen: x.kitchen, is_removal: false, group_kind: x.groupKind })) } : {}),
              notes: null, qty: l.qty + (pulled && pulled.line === l ? pulled.qty : 0),
            }
          }),
          sent_by: ord.opened_by, sent_at: ts(day.ad, sentAt),
          status: kind === 'void' ? 'cancelled' : (isLast && cutMin - sentAt < 25 ? 'in_progress' : 'served'),
          started_at: ts(day.ad, sentAt + 1),
          ready_at: kind === 'void' || (isLast && cutMin - sentAt < 25) ? null : ts(day.ad, ready),
          served_at: kind === 'void' || (isLast && cutMin - sentAt < 25) ? null : ts(day.ad, Math.min(ready + 2, b.closeAt)),
          status_updated_by: null, estimated_prep_minutes: null,
        })
      }
      if (pulled) {
        const l = pulled.line
        const sel = [...l.optIds].sort()
        out.removals.push({
          id: id('pull', orderId), client_id: cid, order_id: orderId, recipe_id: l.dish.id, item_name: l.dish.name,
          qty_removed: pulled.qty, reason: pulled.reason, removed_by: ord.opened_by, removed_at: ts(day.ad, sentAt + 6),
          order_no: null, table_name: ord.table_name, selection_key: sel.join('+'),
          option_summary: sel.length ? sel.map(oid => M.optionById[oid].name).join(' · ') : null,
        })
      }

      // Money.
      const payable = itemRows.filter(r => !r.comped)
      const subEx = payable.reduce((s, r) => s + r.qty * r.unit_price, 0)
      let customer = null, discount = 0, discountReason = null
      if (kind === 'paid' && b.channel !== 'delivery') {
        if (b.corporate) {
          customer = { name: 'Himal Tech Pvt. Ltd.', phone: '9800050505', address: 'New Baneshwor, Kathmandu', pan: '609112233' }
          discount = round2(subEx * 0.15); discountReason = 'Corporate'
        } else if (Rs.chance(o === 'ktm' ? 0.22 : 0.15)) {
          const pool = regulars.filter(r => r.firstDay <= day.idx)
          if (pool.length) {
            customer = Rs.weighted(pool.map(r => [r, r.weight]))
            if (Rs.chance(0.16)) { discount = round2(subEx * 0.10); discountReason = 'Regular guest' }
          }
        }
      }
      const discRatio = subEx > 0 ? discount / subEx : 0
      const vatRaw = payable.reduce((s, r) => s + r.qty * r.unit_price * 0.13, 0)
      const vat = vatRaw * (1 - discRatio)
      const paid = Math.round(subEx - discount + vat)
      if (kind === 'paid' && paid > 10000 && !customer) customer = { name: Rs.pick(regulars).name, phone: Rs.pick(regulars).phone, address: 'Lalitpur' }

      const closer = profileFor(staff, kind === 'void' || kind === 'writeoff' ? staff.manager : supAt(b.closeAt, Rs.chance(0.8) ? staff.cashier : staff.manager))
      let payMethod = null, tendered = null, partner = null, legs = []
      if (kind === 'paid') {
        if (b.channel === 'delivery') {
          payMethod = 'Credit'
          partner = Rs.chance(0.6) ? partners[0] : partners[partners.length - 1]
        } else {
          payMethod = Rs.weighted(outlet.pay)
          if (Rs.chance(0.03) && paid > 600) payMethod = 'Split'
        }
        // Loyalty redemption: a Split with a Loyalty leg.
        if (customer?.id && customer.points >= 150 && payMethod !== 'Credit' && Rs.chance(0.15)) {
          const pts = Math.min(customer.points, Math.floor(paid * 0.4 / 10) * 10)
          if (pts >= 50) {
            const rest = paid - pts
            const restMethod = Rs.chance(0.5) ? 'Cash' : 'FonePay'
            legs = [{ method: 'Loyalty', amount: pts }, { method: restMethod, amount: rest }]
            payMethod = 'Split'
            customer.points -= pts
            out.ledger.push({ id: id('ledger', orderId, 'redeem'), client_id: cid, customer_id: customer.id, order_id: orderId, kind: 'redeem', points: -pts,
              scheme_id: customer.loyalty_scheme_id, note: null, created_by: closer, created_at: ts(day.ad, b.closeAt - 1) })
          }
        }
        if (payMethod === 'Split' && !legs.length) {
          const cash = Math.max(100, Math.round(paid * Rs.float(0.3, 0.6) / 100) * 100)
          legs = [{ method: 'Cash', amount: Math.min(cash, paid - 1) }, { method: 'FonePay', amount: paid - Math.min(cash, paid - 1) }]
        }
        if (payMethod === 'Cash') tendered = Rs.weighted([[paid, 3], [Math.ceil(paid / 100) * 100, 3], [Math.ceil(paid / 500) * 500, 3], [Math.ceil(paid / 1000) * 1000, 2]])
        if (customer?.id && customer.loyalty_scheme_id) {
          const pts = Math.floor((subEx - discount) / 100 * 5)
          if (pts > 0) {
            customer.points += pts
            out.ledger.push({ id: id('ledger', orderId, 'earn'), client_id: cid, customer_id: customer.id, order_id: orderId, kind: 'earn', points: pts,
              scheme_id: customer.loyalty_scheme_id, note: null, created_by: closer, created_at: tsSec(day.ad, b.closeAt * 60 + 5) })
          }
          customer.lastSeen = day.idx
        }
      }

      Object.assign(ord, {
        _kind: kind, _subEx: subEx, _paid: paid, _discount: discount, _closer: closer,
      })
      if (kind !== 'open') {
        Object.assign(ord, {
          status: kind === 'void' ? 'voided' : 'billed', close_type: kind,
          payment_method: kind === 'paid' ? payMethod : null,
          paid_amount: kind === 'paid' ? paid : (kind === 'writeoff' ? 0 : null),
          tendered_amount: tendered,
          close_reason: kind === 'void' ? Rs.pick(VOID_REASONS) : kind === 'writeoff' ? Rs.pick(COMP_BILL_REASONS) : null,
          closed_by: closer, closed_at: ts(day.ad, b.closeAt),
          buyer_name: partner ? partner.name : customer?.name || null,
          buyer_address: partner ? `Delivery — ${Rs.pick(o === 'ktm' ? ['Sanepa', 'Kupondole', 'Jhamsikhel', 'Pulchowk', 'Thapathali'] : ['Lakeside', 'Baidam', 'Nayabazar'])}` : customer?.address || null,
          buyer_pan: customer?.pan || null,
          buyer_phone: partner ? partner.phone : customer?.phone || null,
          invoice_fy: kind === 'void' ? null : FY,
          print_count: kind === 'void' ? 0 : 1,
          comp_print_count: kind === 'writeoff' || itemRows.some(r => r.comped) ? 1 : 0,
          discount_amount: kind === 'paid' ? discount : null,
          discount_reason: kind === 'paid' ? discountReason : null,
          delivery_partner: partner ? partner.name : null,
          vat_registered: true,
          ims_posted_at: kind === 'void' ? null : ts(day.ad, b.closeAt),
          _legs: legs, _partner: partner, _customer: customer,
        })
        if (kind === 'paid') monthPaid[day.m] = (monthPaid[day.m] || 0) + 1
      }
      if (legs.length) legs.forEach((lg, i) => out.payments.push({
        id: id('pay', orderId, i), order_id: orderId, client_id: cid, payment_method: lg.method, amount: lg.amount,
        tendered_amount: null, recorded_by: closer, recorded_at: tsSec(day.ad, b.closeAt * 60 + 3),
      }))

      out.orders.push(ord)
      itemRows.forEach(r => out.items.push(r))
      // The options snapshot (pos_order_item_options), per stored line.
      for (const r of itemRows) {
        for (const op of r._opts) {
          out.itemOptions.push({
            id: id('oio', r.id, op.id), client_id: cid, order_id: orderId, order_item_id: r.id, recipe_id: r.recipe_id,
            group_id: op.groupId, option_id: op.id, group_name: op.groupName, group_kind: op.groupKind, option_name: op.name,
            kitchen_name: op.kitchen, is_removal: false, price_delta: op.delta, list_price_delta: op.delta, included: false,
            ingredient_deltas: op.deltas.map(dl => ({ item_id: dl.item_id, qty: dl.qty })), sort: op.groupSort * 1000 + op.sort,
            created_at: r.created_at,
          })
        }
      }
      if (kind === 'writeoff') ncEvents.push({ type: 'bill', at: ord.closed_at, order: ord })
      itemRows.filter(r => r.comped).forEach(r => ncEvents.push({ type: 'item', at: r.comped_at, row: r, order: ord }))

      // Inventory posting (sales_entries + stock_movements), as backfillPosToIms would write it.
      if (kind === 'paid' || kind === 'writeoff') {
        const wholeComp = kind === 'writeoff'
        const dr = subEx > 0 ? Math.max(0, 1 - discount / subEx) : 1
        const agg = { pos_sale: {}, pos_comp: {} }
        for (const r of itemRows) {
          const isComp = wholeComp || r.comped
          const deltas = r._opts.flatMap(op => op.deltas)
          out.sales.push({
            id: id('se', r.id), period_id: periodId, recipe_id: r.recipe_id, bs_day: day.d, qty_sold: r.qty,
            source: isComp ? 'pos_comp' : 'pos', unit_price: isComp ? r.unit_price : round4(r.unit_price * dr), vat_rate: 0.13,
            discount: 0, pos_order_id: orderId, created_at: tsSec(day.ad, b.closeAt * 60 + 1),
            ...(deltas.length ? { ingredient_deltas: deltas } : {}),
          })
          const bucket = isComp ? 'pos_comp' : 'pos_sale'
          const usage = { ...r._line.dish.usage }
          for (const op of r._opts) for (const [code, q] of Object.entries(op.usage)) usage[code] = (usage[code] || 0) + q
          for (const [code, q] of Object.entries(usage)) {
            agg[bucket][code] = (agg[bucket][code] || 0) + q * r.qty
            out.usage[code] = (out.usage[code] || 0) + q * r.qty
            // What this day had used by the first build's cut-off: ordering decisions on that day read it.
            if (!isBaseDay || b.closeAt <= BASE_CUTOFF.minutes - 2) out.usageBase[code] = (out.usageBase[code] || 0) + q * r.qty
          }
        }
        for (const [source, m] of Object.entries(agg)) {
          for (const [code, q] of Object.entries(m)) {
            if (Math.abs(q) < 1e-9) continue
            out.moves.push({ id: id('mv', orderId, source, code), client_id: cid, item_id: M.itemByCode[code].id, period_id: periodId, bs_day: day.d,
              qty: -round4(q), source, ref_id: orderId, created_at: tsSec(day.ad, b.closeAt * 60 + 1) })
          }
        }
      }
      return ord
    }
    // Drops an order's rows from today's output (used when an order loaded as open is finished).
    const dropOrder = oid => {
      for (const k of ['orders', 'items', 'itemOptions', 'kot', 'removals', 'payments', 'ledger', 'sales', 'moves']) {
        out[k] = out[k].filter(r => r.id !== oid && r.order_id !== oid && r.ref_id !== oid && r.pos_order_id !== oid)
      }
      for (let i = ncEvents.length - 1; i >= 0; i--) if (ncEvents[i].order.id === oid) ncEvents.splice(i, 1)
    }
    for (const b of bills) {
      const orderIndex = dayBills.length
      let ord
      if (ownStream(b.t)) {
        ord = shapeBill(b, rngFor(o, 'bill-b', day.key, b.bi), { isOpenNow: isCut && b.closeAt > cutoff.minutes - 2, cutMin: cutoff.minutes, allowEvents: day.ad > BASE_CUTOFF.ad, orderIndex })
      } else {
        // Built exactly as the first build built it: on its cut-off day, open meant open at 17:15.
        const openAtBase = isBaseDay && b.closeAt > BASE_CUTOFF.minutes - 2
        ord = shapeBill(b, Rd, { isOpenNow: openAtBase || (isCut && !isBaseDay && b.closeAt > cutoff.minutes - 2), cutMin: isBaseDay ? BASE_CUTOFF.minutes : cutoff.minutes, allowEvents: true, orderIndex })
        if (openAtBase && !(isCut && b.closeAt > cutoff.minutes - 2)) {
          // Open at the first cut-off and paid since: finished from a stream of its own.
          dropOrder(ord.id)
          ord = shapeBill(b, rngFor(o, 'bill-finish', day.key, b.bi), { isOpenNow: false, cutMin: cutoff.minutes, allowEvents: false, orderIndex })
        }
      }
      dayBills.push(ord)
      allOrders.push(ord)
    }

    // Credit note (a returned bill).
    const cnMode = ev.creditNote[day.key]
    if (cnMode && !isCut) {
      const cand = dayBills.find(x => x._kind === 'paid' && !x._customer && !x._partner && x._legs.length === 0 && x.discount_amount === 0 &&
        (cnMode === 'cash' ? x.payment_method === 'Cash' : x.payment_method === 'FonePay') && x._t > 700 && x._paid < 2000)
      if (cand) {
        const taxable = cand._subEx
        const vatAmt = round2(taxable * 0.13)
        const cnAt = cand._close + 25
        const cn = {
          id: id('cn', day.key), client_id: cid, order_id: cand.id, credit_note_no: null, invoice_fy: FY,
          original_invoice_no: null, original_invoice_label: null,
          original_invoice_date_bs: `${day.d} ${BS_MONTHS[day.m - 1]} 2083`,
          reason: cnMode === 'cash' ? 'Guest found the food undercooked — refunded in full' : 'Charged for the wrong dishes — refunded to the guest’s FonePay',
          gross_amount: round2(cand._subEx), discount_amount: 0, taxable_amount: round2(taxable), non_taxable_amount: 0,
          vat_amount: vatAmt, net_amount: round2(taxable + vatAmt), buyer_name: null, buyer_address: null, buyer_pan: null, buyer_phone: null,
          issued_by: profileFor(staff, mgrOn ? staff.manager : staff.cashier), print_count: 1, created_at: ts(day.ad, cnAt),
          ims_posted_at: null, refund_method: cnMode === 'cash' ? 'cash' : 'other', restock: false,
          _order: cand, _at: cnAt,
        }
        creditNotes.push(cn)
        out.notes.push(cn)
        if (cnMode === 'cash') {
          out.cashMoves.push({ id: id('cash', day.key, 'refund'), client_id: cid, shift_id: null, direction: 'out', kind: 'refund',
            amount: Math.min(cand._paid, cn.net_amount), reason: 'Credit note refund', order_id: cand.id, created_at: ts(day.ad, cnAt),
            created_by: cn.issued_by, pos_credit_note_id: cn.id })
        }
        // Inventory reversal: pos_credit rows on the note's day (food was served, so no restock).
        out.items.filter(r => r.order_id === cand.id && !r.comped).forEach(r => {
          out.creditSales.push({ id: id('se-cn', r.id), period_id: periodId, recipe_id: r.recipe_id, bs_day: day.d, qty_sold: -r.qty,
            source: 'pos_credit', unit_price: r.unit_price, vat_rate: 0.13, discount: 0, pos_order_id: null, pos_credit_note_id: cn.id,
            created_at: ts(day.ad, cnAt) })
        })
      }
    }

    // Cash in / out during the day.
    const po = ev.payOut[day.key]
    if (po && !isCut) out.cashMoves.push({ id: id('cash', day.key, 'out'), client_id: cid, shift_id: null, direction: 'out', kind: 'pay_out',
      amount: po[0], reason: po[1], order_id: null, created_at: ts(day.ad, 760), created_by: profileFor(staff, supAt(760)), pos_credit_note_id: null })

    // The shift.
    const shiftId = id('shift', day.key)
    out.cashMoves.forEach(c => { c.shift_id = shiftId })
    const opening = 5000
    const closedOrders = out.orders.filter(x => x._kind !== 'open')
    const shift = {
      id: shiftId, client_id: cid, label: null, status: 'open', opened_at: ts(day.ad, shiftOpen),
      opened_by: profileFor(staff, supAt(shiftOpen + 25, staff.manager)),
      opening_cash: opening, opening_denominations: denominationsFor(opening),
      closed_at: null, closed_by: null, closing_cash: null, closing_denominations: null, closing_report: null,
    }
    closedOrders.filter(x => x._kind !== 'void').forEach(x => { x.shift_id = shiftId })
    if (!isCut || cutoff.minutes > outlet.close + 40) {
      const rep = shiftReport(closedOrders, out, M)
      const expected = opening + rep.cashSales + rep.cashIn - rep.cashOut
      const variance = ev.short[day.key] ?? 0
      const closing = Math.round(expected + variance)
      const closeMin = Math.max(...closedOrders.map(x => x._close), outlet.close) + Rd.int(8, 20)
      Object.assign(shift, {
        status: 'closed', closed_at: ts(day.ad, closeMin), closed_by: profileFor(staff, supAt(outlet.close - 10, staff.cashier)), closing_cash: closing,
        closing_denominations: denominationsFor(closing),
        closing_report: { ...rep, movements: out.cashMoves.map(stripPrivate).sort((a, b) => a.created_at.localeCompare(b.created_at)),
          openingCash: opening, closingCash: closing, expectedCash: round2(expected), variance: round2(closing - expected),
          capturedAt: new Date(Date.parse(ts(day.ad, closeMin).replace(' ', 'T'))).toISOString() },
      })
    }
    out.shift = shift
  }

  // Tables with an order still open at the cut-off.
  for (const x of allOrders) if (x._kind === 'open' && x.table_id) openTableIds.add(x.table_id)

  // ── Numbering, in the order the database would have given them ──
  allOrders.sort((a, b) => a.opened_at.localeCompare(b.opened_at))
  allOrders.forEach((x, i) => { x.order_no = i + 1 })
  const paidOrdered = allOrders.filter(x => x._kind === 'paid').sort((a, b) => a.closed_at.localeCompare(b.closed_at) || a.order_no - b.order_no)
  paidOrdered.forEach((x, i) => { x.invoice_no = i + 1 })
  ncEvents.sort((a, b) => a.at.localeCompare(b.at))
  ncEvents.forEach((e, i) => { if (e.type === 'bill') e.order.invoice_no = i + 1; else e.row.comp_no = i + 1 })
  creditNotes.sort((a, b) => a.created_at.localeCompare(b.created_at))
  creditNotes.forEach((cn, i) => {
    cn.credit_note_no = i + 1
    cn.original_invoice_no = cn._order.invoice_no
    cn.original_invoice_label = `TI${cn._order.invoice_no}-${outlet.invoicePrefix}-${FY}`
  })
  for (const day of days) {
    const out = byDay[day.key]
    const noOf = new Map(out.orders.map(x => [x.id, x.order_no]))
    out.kot.forEach(k => { k.order_no = noOf.get(k.order_id) })
    out.removals.forEach(r => { r.order_no = noOf.get(r.order_id) })
  }

  // ── Delivery partner settlements (weekly, by bank transfer, recent ones still owed) ──
  const lastAd = cutoff.ad
  for (const x of allOrders) {
    if (!x._partner) continue
    const dayIdx = x._day.idx
    const settleIdx = Math.ceil((dayIdx + 4) / 7) * 7       // the next weekly settlement after a 4-day lag
    const settleDay = days[settleIdx]
    if (!settleDay || settleDay.ad >= lastAd) continue
    const base = x._subEx - (x.discount_amount || 0)
    Object.assign(x, {
      credit_settled_at: ts(settleDay.ad, 900), credit_settled_by: profileFor(staff, staff.manager),
      credit_settled_method: 'Bank Transfer', commission_amount: Math.round(base * x._partner.pct / 100),
    })
  }

  // ── Bookings ──
  const Rr = rngFor(o, 'bookings')
  const sources = [['phone', 45], ['whatsapp', 22], ['instagram', 15], ['website', 13], ['facebook', 5]]
  for (const day of days) {
    if (day.ad >= cutoff.ad) continue
    const out = byDay[day.key]
    const weekly = o === 'ktm' ? 3.5 : 2
    const nBook = Rr.chance(weekly / 7 * (day.wd >= 5 ? 1.8 : 0.8)) ? (Rr.chance(0.3) ? 2 : 1) : 0
    const cands = out.orders.filter(x => x._kind === 'paid' && x.table_id && x.covers >= 2 && x._t >= 690 && x._customer?.id)
    for (let k = 0; k < nBook && k < cands.length; k++) {
      const x = cands[Rr.int(0, cands.length - 1)]
      if (reservations.some(r => r.order_id === x.id)) continue
      const at = Math.floor((x._t - 5) / 15) * 15
      const madeDaysBefore = Rr.int(1, 4)
      const made = days[Math.max(0, day.idx - madeDaysBefore)].ad
      const rid = id('res', x.id)
      const src = Rr.weighted(sources)
      reservations.push({
        id: rid, client_id: cid, customer_name: x._customer.name, phone: x._customer.phone, party_size: x.covers,
        reserved_for: ts(day.ad, at), duration_minutes: x.covers <= 2 ? 60 : x.covers <= 4 ? 90 : 105, status: 'completed', source: src,
        occasion: Rr.chance(0.2) ? Rr.pick(['Birthday', 'Anniversary', 'Team lunch']) : null, notes: null, cancel_reason: null, order_id: x.id,
        confirmed_at: ts(made, 720), arrived_at: ts(day.ad, x._t - 2), seated_at: ts(day.ad, x._t), completed_at: x.closed_at,
        no_show_at: null, cancelled_at: null, created_by: src === 'website' ? null : profileFor(staff, staff.manager),
        created_at: ts(made, 690), updated_at: x.closed_at,
      })
      resTables.push({ id: id('rest', rid), client_id: cid, reservation_id: rid, table_id: x.table_id })
    }
    // No-shows and cancellations now and then.
    if (Rr.chance(o === 'ktm' ? 0.07 : 0.04)) {
      const r = Rr.pick(regulars)
      const at = Rr.pick([780, 1110, 1140])
      const noShow = Rr.chance(0.55)
      const rid = id('res-x', day.key)
      const tb = M.tables.find(t => t.capacity >= 4) || M.tables[0]
      const made = days[Math.max(0, day.idx - 2)].ad
      reservations.push({
        id: rid, client_id: cid, customer_name: r.name, phone: r.phone, party_size: Rr.int(2, 4), reserved_for: ts(day.ad, at),
        duration_minutes: 90, status: noShow ? 'no_show' : 'cancelled', source: Rr.weighted(sources), occasion: null, notes: null,
        cancel_reason: noShow ? null : 'Guest cancelled', order_id: null, confirmed_at: ts(made, 700), arrived_at: null, seated_at: null,
        completed_at: null, no_show_at: noShow ? ts(day.ad, at + 25) : null, cancelled_at: noShow ? null : ts(day.ad, at - 180),
        created_by: profileFor(staff, staff.manager), created_at: ts(made, 680), updated_at: noShow ? ts(day.ad, at + 25) : ts(day.ad, at - 180),
      })
      resTables.push({ id: id('rest', rid), client_id: cid, reservation_id: rid, table_id: tb.id })
    }
  }

  const customers = regulars.filter(r => r.lastSeen != null).map(r => ({
    id: r.id, client_id: cid, name: r.name, phone: r.phone, address: r.address, pan: null, created_at: r.created_at, updated_at: r.created_at,
    loyalty_scheme_id: r.loyalty_scheme_id,
  }))

  return { byDay, allOrders, customers, schemes, regulars, reservations, resTables, creditNotes, openTableIds }
}

function pickDish(R, dishes, cat, part, delivery = false) {
  const pool = dishes.filter(d => d.cat === cat && !(delivery && /Americano|Latte|Cappuccino|Masala Tea/.test(d.name)))
  return R.weighted(pool.map(d => [d, Math.max(0.01, d.pop[part] || 0.01)]))
}

function chooseOptions(R, dish, M, o) {
  if (!dish.groups?.length) return []
  const ids = []
  for (const g of dish.groups) {
    if (g.key === 'size_black') ids.push(uid(o, 'option', 'size_black', R.chance(0.3) ? 'lrg' : 'reg'))
    if (g.key === 'size_milk') ids.push(uid(o, 'option', 'size_milk', R.chance(0.25) ? 'lrg' : 'reg'))
    if (g.key === 'addons') {
      if (dish.sizes === 'milk' && R.chance(0.12)) ids.push(uid(o, 'option', 'addons', 'oat'))
      if (R.chance(0.07)) ids.push(uid(o, 'option', 'addons', 'shot'))
    }
  }
  return ids
}

const profileFor = (staff, key) => staff.profiles[key]
const stripPrivate = r => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')))

// loadShiftReport, from the rows this shift holds.
function shiftReport(orders, out, M) {
  const byMethod = Object.fromEntries(PAY_KEYS.map(m => [m, 0]))
  let discountTotal = 0, voidTotal = 0, compTotal = 0, salesTotal = 0, orderCount = 0, paidCount = 0, voidCount = 0, compCount = 0
  for (const x of orders) {
    const items = out.items.filter(r => r.order_id === x.id)
    if (x._kind === 'paid') {
      orderCount++; paidCount++
      salesTotal += x.paid_amount; discountTotal += x.discount_amount || 0
      if (x.payment_method === 'Split') x._legs.forEach(l => { byMethod[l.method] += l.amount })
      else byMethod[x.payment_method] += x.paid_amount
    } else if (x._kind === 'void') {
      orderCount++; voidCount++
      voidTotal += items.reduce((s, i) => s + i.qty * i.unit_price * 1.13, 0)
    } else if (x._kind === 'writeoff') {
      orderCount++; compCount++
      compTotal += items.reduce((s, i) => s + i.qty * (Object.values(M.dishByCode).find(d => d.id === i.recipe_id)?.cost || 0), 0)
    }
  }
  const cashIn = out.cashMoves.filter(m => m.direction === 'in').reduce((s, m) => s + m.amount, 0)
  const cashOut = out.cashMoves.filter(m => m.direction === 'out').reduce((s, m) => s + m.amount, 0)
  const refundsCash = out.cashMoves.filter(m => m.kind === 'refund').reduce((s, m) => s + m.amount, 0)
  return {
    orderCount, paidCount, voidCount, compCount, byMethod,
    discountTotal: round2(discountTotal), voidTotal: round2(voidTotal), compTotal: round2(compTotal), salesTotal,
    cashSales: byMethod.Cash, cashIn, cashOut, creditSettlementsCash: 0, refundsCash,
  }
}
