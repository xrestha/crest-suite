// Inventory, day by day: what the café buys (and pays for), throws away, feeds its staff, and
// counts at month end. Stock never goes negative: a day that would run short gets a top-up bill.
import { rngFor, uid, ts, round2 } from './lib.mjs'
import { ITEMS, OVERHEADS, BASE_CUTOFF } from './config.mjs'
import { monthDays, adOf } from './calendar.mjs'

const STAFF_MEAL = [['ITM-029', 150], ['ITM-030', 30], ['ITM-026', 60], ['ITM-020', 60], ['ITM-032', 10], ['ITM-033', 2],
  ['ITM-039', 2], ['ITM-013', 15], ['ITM-047', 6], ['ITM-005', 120], ['ITM-034', 16]]

// Price movement through the season (multiplier on the item's base rate).
function trend(code, m, d) {
  if (code === 'ITM-014') return m === 5 ? 1.65 : m === 6 ? 1.25 : 1          // tomato: monsoon spike in Bhadra
  if (code === 'ITM-017') return m === 5 ? 1.4 : 1                              // coriander
  if (code === 'ITM-022') return m === 5 ? 1.2 : 1                              // lemon
  if (code === 'ITM-013') return m === 6 ? 1.15 : 1                             // onion before Dashain
  if (['ITM-001', 'ITM-002', 'ITM-003'].includes(code)) return m === 6 && d >= 10 ? 1.08 : 1   // chicken before Dashain
  if (code === 'ITM-007') return m === 5 ? 1.05 : 1
  return 1
}

export function simulateIms({ outlet, M, days, cutoff, posByDay, headcountOf, periodIdOf, counterName }) {
  const o = outlet.key, cid = outlet.clientId
  const id = (...k) => uid(o, ...k)
  const R = rngFor(o, 'ims')
  const codes = ITEMS.map(i => i.code)
  const past = days.filter(d => d.ad <= cutoff.ad)
  const basePast = days.filter(d => d.ad <= BASE_CUTOFF.ad)

  // Average daily use per item (till + staff meals + a wastage allowance), for ordering.
  const avg = Object.fromEntries(codes.map(c => [c, 0]))
  for (const d of basePast) for (const [c, q] of Object.entries(posByDay[d.key].usageBase)) avg[c] += q / basePast.length
  const avgHead = basePast.reduce((s, d) => s + headcountOf(d), 0) / basePast.length
  for (const [c, q] of STAFF_MEAL) avg[c] += q * avgHead
  for (const c of codes) avg[c] *= 1.04

  const stock = {}
  const opening = { 4: {} }
  for (const it of ITEMS) {
    const q = roundCount(it, avg[it.code] * (it.cover * 0.7 + 1))
    stock[it.code] = q
    opening[4][it.code] = q
  }

  const purchases = []          // purchase_entries rows
  const bills = []              // per bill: { id, vendor, day, lines[], payDate, total }
  const payments = [], returns = [], wastages = [], pos = [], poItems = []
  const staffMeals = {}         // month → code → qty
  const closings = {}           // month → code → qty
  const wasteByDay = {}
  let invSeq = Object.fromEntries(Object.keys(M.vendorByKey).map(k => [k, R.int(310, 870)]))
  let poSeq = 0
  let pendingReturn = null, returnDone = false

  const schedule = (vk, day) => {
    switch (vk) {
      case 'veg': return day.idx % 2 === 0
      case 'bakery': return true
      case 'meat': return day.idx % 3 === 0
      case 'dairy': return day.idx % 3 === 1
      case 'grocery': return day.wd === 0
      case 'coffee': return day.idx % 10 === 2
      default: return false
    }
  }

  for (const day of past) {
    const Rd = rngFor(o, 'ims-day', day.key)
    const periodId = periodIdOf(day.m)
    const isCut = day.ad === cutoff.ad

    // A supplier return booked yesterday leaves stock today.
    if (pendingReturn && pendingReturn.dayIdx === day.idx) {
      const { line, qty, bill } = pendingReturn
      stock[line._code] -= qty
      returns.push({ id: id('ret', bill.id), client_id: cid, period_id: periodId, purchase_entry_id: line.id, item_id: line.item_id,
        vendor_id: bill.vendor.id, qty, rate: line.rate, payment_method: 'Credit', bs_day: day.d,
        notes: 'Mozzarella expired on arrival — sent back', created_at: ts(day.ad, 600) })
      line._returned = round2(qty * line.rate * 1.13)
      pendingReturn = null
      returnDone = true
    }

    // Today's planned outflows. Ordering reads what the day had used by the first build's cut-off
    // (the same thing on every other day), so a top-up never re-sizes a bill already loaded.
    const use = { ...posByDay[day.key].usageBase }
    const lateUse = {}
    for (const [c, q] of Object.entries(posByDay[day.key].usage)) { const extra = q - (posByDay[day.key].usageBase[c] || 0); if (extra > 1e-9) lateUse[c] = extra }
    const head = headcountOf(day)
    if (!staffMeals[day.m]) staffMeals[day.m] = {}
    for (const [c, q] of STAFF_MEAL) {
      use[c] = (use[c] || 0) + q * head
      staffMeals[day.m][c] = (staffMeals[day.m][c] || 0) + q * head
    }
    const waste = plannedWaste(Rd, o, day)
    wasteByDay[day.key] = waste
    for (const w of waste) use[w.code] = (use[w.code] || 0) + w.qty

    // Purchases: the scheduled suppliers, then a top-up for anything that would run out.
    const buy = {}
    for (const it of ITEMS) {
      const v = it.vendor
      if (!schedule(v, day)) continue
      const target = avg[it.code] * (it.cover + 1)
      const reorderAt = avg[it.code] * (it.cover * 0.6 + 0.5)
      if (v === 'bakery' ? true : stock[it.code] < reorderAt) {
        const need = (v === 'bakery' ? (use[it.code] || 0) * 1.12 + avg[it.code] * 0.2 : target) - stock[it.code]
        if (need > 0) buy[it.code] = Math.max(it.step, Math.ceil(need / it.step) * it.step)
      }
    }
    for (const it of ITEMS) {
      const after = stock[it.code] + (buy[it.code] || 0) - (use[it.code] || 0)
      if (after < avg[it.code] * 0.25) {
        const extra = Math.ceil((avg[it.code] * 0.6 - after) / it.step) * it.step
        buy[it.code] = (buy[it.code] || 0) + Math.max(it.step, extra)
      }
    }

    // Bills, one per supplier.
    const byVendor = {}
    for (const [code, qty] of Object.entries(buy)) {
      const it = M.itemByCode[code]
      ;(byVendor[it.vendor] = byVendor[it.vendor] || []).push({ code, qty })
    }
    for (const [vk, lines] of Object.entries(byVendor)) {
      const v = M.vendorByKey[vk]
      const billId = id('pg', vk, day.key)
      invSeq[vk] += 1
      const invoice = `${v.name.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase()}-${invSeq[vk]}`
      const at = ts(day.ad, Rd.int(510, 600))
      const payMethod = vk === 'veg' && o === 'pkr' && Rd.chance(0.3) ? 'FonePay' : v.pay
      const rows = lines.map(({ code, qty }) => {
        const it = M.itemByCode[code]
        const factor = trend(code, day.m, day.d) * Rd.float(0.98, 1.025)
        const cf = it.cf || 1
        const unitPrice = Math.max(1, Math.round(it.baseRate * factor * cf))   // price per purchase unit
        const rate = Math.round(unitPrice / cf * 1e6) / 1e6
        return {
          id: id('pe', billId, code), period_id: periodId, item_id: it.id, vendor_id: v.id, bs_day: day.d, qty, rate,
          invoice_ref: invoice, created_at: at, payment_method: payMethod, vat_inclusive: !!it.vat, paid_at: null,
          purchase_group_id: billId, discount_amount: 0, po_id: null, vat_is_cost: false, _code: code, _late: day.ad > BASE_CUTOFF.ad,
        }
      })
      // A volume discount on the bigger grocery bills.
      const gross = rows.reduce((s, r) => s + r.qty * r.rate, 0)
      if (vk === 'grocery' && gross > 9000 && Rd.chance(0.5)) {
        const disc = Math.round(gross * 0.02)
        rows.forEach(r => { r.discount_amount = disc })
      }
      // Line values the way Outstanding Payables settles them (bill discount spread, VAT on top, to the paisa).
      const discount = rows[0].discount_amount
      rows.forEach(r => {
        const line = r.qty * r.rate * (gross > 0 ? 1 - discount / gross : 1)
        r._value = round2(line * (r.vat_inclusive ? 1.13 : 1))
      })
      // Grocery comes in against a purchase order at the main café.
      if (vk === 'grocery' && o === 'ktm') {
        poSeq += 1
        const poId = id('po', billId)
        // The first build's open order holds the number after its last received one, so later
        // orders skip it.
        const poNo = `PO-${String(poSeq + (day.ad > BASE_CUTOFF.ad ? 1 : 0)).padStart(3, '0')}`
        pos.push({ id: poId, client_id: cid, vendor_id: v.id, period_id: periodId, po_number: poNo, status: 'received',
          notes: 'Weekly dry goods order', expected_date: day.ad, created_at: ts(days[Math.max(0, day.idx - 2)].ad, 1140), _late: day.ad > BASE_CUTOFF.ad })
        rows.forEach(r => {
          r.po_id = poId; r.invoice_ref = poNo
          poItems.push({ id: id('poi', poId, r._code), po_id: poId, item_id: r.item_id, qty_ordered: r.qty, unit_price: r.rate, qty_received: r.qty })
        })
      }
      purchases.push(...rows)
      const bill = { id: billId, vk, vendor: v, day, rows, method: payMethod }
      bills.push(bill)
      // The return story: one mozzarella delivery in Bhadra at the main café was already expired.
      if (o === 'ktm' && !returnDone && !pendingReturn && vk === 'dairy' && day.m === 5 && day.d >= 12) {
        const line = rows.find(r => r._code === 'ITM-007')
        if (line && line.qty >= 1000) pendingReturn = { dayIdx: day.idx + 1, line, qty: 1000, bill }
      }
      for (const r of rows) stock[r._code] += r.qty
    }

    // Wastage rows.
    for (const w of waste) {
      wastages.push({ id: id('waste', day.key, w.code), period_id: periodId, item_id: M.itemByCode[w.code].id, bs_day: day.d, qty: w.qty,
        reason: w.reason, created_at: ts(day.ad, 1230) })
    }

    // Out it goes.
    for (const [c, q] of Object.entries(use)) stock[c] -= q
    // Evening sales a top-up adds to the first build's last day: an evening delivery covers any shortfall.
    const lateShort = []
    for (const [c, q] of Object.entries(lateUse)) { stock[c] -= q; if (stock[c] < 0) lateShort.push(c) }
    if (lateShort.length) {
      const byV = {}
      for (const c of lateShort) { const it = M.itemByCode[c]; (byV[it.vendor] = byV[it.vendor] || []).push(c) }
      for (const [vk, cs] of Object.entries(byV)) {
        const v = M.vendorByKey[vk]
        const billId = id('pg', vk, day.key, 'pm')
        const at = ts(day.ad, 1110)
        const rows = cs.map(code => { const it = M.itemByCode[code]; const qty = Math.ceil((-stock[code] + avg[code] * 0.6) / it.step) * it.step; stock[code] += qty
          const unitPrice = Math.max(1, Math.round(it.baseRate * trend(code, day.m, day.d) * (it.cf || 1))); const rate = Math.round(unitPrice / (it.cf || 1) * 1e6) / 1e6
          return { id: id('pe', billId, code), period_id: periodId, item_id: it.id, vendor_id: v.id, bs_day: day.d, qty, rate, invoice_ref: `${vk.toUpperCase()}-PM-${day.d}`, created_at: at,
            payment_method: 'Cash', vat_inclusive: !!it.vat, paid_at: day.ad, purchase_group_id: billId, discount_amount: 0, po_id: null, vat_is_cost: false, _code: code, _value: round2(qty * rate * (it.vat ? 1.13 : 1)), _late: true } })
        purchases.push(...rows)
        bills.push({ id: billId, vk, vendor: v, day, rows, method: 'Cash' })
      }
    }
    for (const c of codes) if (stock[c] < -1e-6) throw new Error(`${o} ${day.key}: ${c} went negative (${stock[c].toFixed(1)})`)

    // Month end: the count. Shrinkage is small, except the Bhadra story at the main café.
    if (day.d === monthDays(day.m) && !isCut) {
      const counted = {}
      for (const it of ITEMS) {
        // Shrawan and Bhadra drew from the shared stream when they were first built; later months
        // draw from their own, so a top-up's month end never moves anything already loaded.
        let shrink = day.m <= 5 ? R.float(0, 0.012) : rngFor(o, 'shrink', day.m, it.code).float(0, 0.012)
        if (o === 'ktm' && day.m === 5) shrink = { 'ITM-001': 0.05, 'ITM-002': 0.04, 'ITM-007': 0.06 }[it.code] ?? shrink
        if (o === 'pkr' && day.m === 5 && it.code === 'ITM-045') shrink = 0.03
        const q = Math.max(0, roundCount(it, stock[it.code] * (1 - shrink), true))
        counted[it.code] = q
        stock[it.code] = q
      }
      closings[day.m] = counted
      opening[day.m + 1] = { ...counted }
    }
  }

  // ── Paying the suppliers ──
  const payDays = []
  const findDay = (pred, fromIdx) => past.find(d => d.idx > fromIdx && pred(d))
  const held = new Set()       // the overdue story: two early Shrawan grocery bills still unpaid
  if (o === 'ktm') bills.filter(b => b.vk === 'grocery' && b.day.m === 4).slice(0, 2).forEach(b => held.add(b.id))
  if (o === 'pkr') bills.filter(b => b.vk === 'grocery' && b.day.m === 4).slice(0, 1).forEach(b => held.add(b.id))
  for (const b of bills) {
    if (b.method !== 'Credit' || held.has(b.id)) continue
    let pd = null
    if (b.vk === 'meat') pd = findDay(d => d.wd === 5, b.day.idx + 1)
    if (b.vk === 'dairy' || b.vk === 'coffee') pd = past.find(d => d.m === b.day.m + 1 && d.d === 7)
    if (b.vk === 'grocery') pd = findDay(d => d.wd === 0, b.day.idx + 27)
    if (!pd || pd.ad >= cutoff.ad) continue
    b.payDay = pd
  }
  for (const b of bills) {
    if (b.method === 'Credit') {
      if (!b.payDay) continue
      // A bill paid by the first build's cut-off keeps the shared stream it was paid from; later
      // payments draw from their own.
      const Rp = b.payDay.ad < BASE_CUTOFF.ad && b.day.ad <= BASE_CUTOFF.ad && !b.rows[0]._late ? R : rngFor(o, 'paymode', b.id)
      const mode = b.vk === 'meat' ? (Rp.chance(0.6) ? 'FonePay' : 'Bank Transfer') : b.vk === 'grocery' ? Rp.pick(['Cheque', 'Bank Transfer']) : 'Bank Transfer'
      for (const r of b.rows) {
        const amt = round2(r._value - (r._returned || 0))
        if (amt > 0) payments.push({ id: id('pp', r.id), purchase_entry_id: r.id, amount: amt, paid_at: b.payDay.ad,
          note: `Paid ${b.rows[0].invoice_ref}`, created_at: ts(b.payDay.ad, 960), client_id: cid, payment_mode: mode })
        r.paid_at = b.payDay.ad
      }
    } else {
      // Cash and FonePay bills are settled on the spot.
      for (const r of b.rows) r.paid_at = b.day.ad
    }
  }
  // Staff meals: one row per item per month (the Stock Count page's shape).
  const mealRows = []
  for (const [m, map] of Object.entries(staffMeals)) {
    for (const [c, q] of Object.entries(map)) mealRows.push({ id: id('meal', m, c), period_id: periodIdOf(Number(m)), item_id: M.itemByCode[c].id, qty: Math.round(q), type: 'staff' })
  }

  // Overheads: a full set for each closed month, and what is already paid in Ashoj.
  const overheads = []
  // A month that has ended carries the full set; the running month only what is paid up front.
  for (const m of [...new Set(past.map(d => d.m))]) {
    const ended = cutoff.ad > adOf(m, monthDays(m))
    const list = OVERHEADS[o].filter(([cat]) => ended || ['Rent', 'Internet & Phone', 'Marketing'].includes(cat))
    for (const [cat, amt] of list) {
      const a = Math.round(amt * (cat === 'Electricity' || cat === 'LPG Gas' ? R.float(0.92, 1.08) : 1))
      overheads.push({ id: id('oh', m, cat), client_id: cid, period_id: periodIdOf(m), category: cat, description: null, amount: a,
        created_at: ts(past.find(d => d.m === m)?.ad, 1100), bucket: 'overhead' })
    }
  }

  // Par levels from what the café really uses.
  const pars = ITEMS.map(it => ({ id: id('par', it.code), client_id: cid, item_id: M.itemByCode[it.code].id,
    par_qty: roundCount(it, avg[it.code] * (it.cover * 0.45 + 0.5)), updated_at: ts(days[0].ad, 600) }))

  // The latest price paid becomes each item's master price.
  const lastRate = {}
  for (const r of purchases) lastRate[r._code] = r.rate

  return { purchases, bills, payments, returns, wastages, mealRows, opening, closings, overheads, pars, pos, poItems, lastRate, stock, avg }
}

function plannedWaste(R, o, day) {
  const w = []
  const add = (code, qty, reason) => w.push({ code, qty, reason })
  if (R.chance(0.25)) add('ITM-005', R.int(3, 8) * 100, 'Milk turned sour')
  if (R.chance(0.3)) add('ITM-010', R.int(2, 4), 'Bread gone stale')
  if (R.chance(0.3)) add('ITM-021', R.int(5, 12) * 10, 'Lettuce wilted')
  if (R.chance(0.22)) add('ITM-017', R.int(5, 10) * 10, 'Coriander wilted')
  if (R.chance(0.2)) add('ITM-014', R.int(2, 5) * 100, 'Tomatoes overripe')
  if (R.chance(0.12)) add('ITM-009', R.int(1, 2), 'Bun dropped')
  if (R.chance(0.06)) add('ITM-011', 1, 'Pizza base burnt')
  if (o === 'ktm' && day.key === '5-9') {
    add('ITM-001', 3500, 'Fridge compressor failed overnight')
    add('ITM-002', 2000, 'Fridge compressor failed overnight')
  } else if (R.chance(0.04)) add('ITM-001', R.int(2, 4) * 100, 'Dropped while prepping')
  return w
}

export function roundCount(it, q, floor = false) {
  if (q <= 0) return 0
  const f = floor ? Math.floor : Math.round
  if (it.uom === 'PCS') return f(q)
  const unit = q >= 2000 ? 50 : 10
  return f(q / unit) * unit
}
