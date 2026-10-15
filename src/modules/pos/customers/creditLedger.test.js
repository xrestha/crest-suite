/**
 * S843: customer credit takes part payments. The pure half: who a bill belongs to (the JS twin of
 * pos_credit_party_key), spreading a payment over the bills, ageing on Nepal's calendar, the
 * statement's running balance, and a receipt as at its own moment.
 */
import fs from 'fs'
import path from 'path'
import {
  creditPartyKey, partyKindOf, toPaisa, fromPaisa, parseAmount, creditBillLabel, nepalDaysBetween,
  ageBucketOf, groupByParty, ageingByParty, ageingOf, suggestedCommission, allocatePayment, balanceBefore,
  statementOf, owedAfterReceipt, receiptBalances, receiptNoLabel, legacySettlements, collectedRows,
  cancelReasonProblem,
} from './creditLedger'
import { bsToAd, daysInBsMonth, formatAd } from '../../../utils/bsCalendar'

// ── The party key and its SQL twin ───────────────────────────────────────────────────────────────

const MIGRATIONS = path.join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')
const sqlCode = s => s.replace(/--[^\n]*/g, '')
const squash = s => s.replace(/\s+/g, ' ')

// The LATEST migration defining a function, so a later rebuild of it is what gets compared.
function latestBody(signatureStart, end = '$$;') {
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
  const hits = files.filter(f => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').includes(signatureStart))
  expect(hits.length).toBeGreaterThan(0)
  const sql = fs.readFileSync(path.join(MIGRATIONS, hits[hits.length - 1]), 'utf8')
  return squash(sqlCode(sql.split(signatureStart)[1].split(end)[0]))
}

// The SQL, transcribed rule for rule, so the samples below compare the two on equal terms:
// btrim() strips spaces only; pos_phone_canonical() keeps digits, drops a leading 977 from 11+
// digits, then leading zeros.
function sqlPhoneCanonical(p) {
  const d = String(p ?? '').replace(/\D/g, '')
  return (/^977.{8,}/.test(d) ? d.slice(3) : d).replace(/^0+/, '')
}
function sqlPartyKey(partner, phone, name) {
  const bt = s => (s == null ? null : String(s).replace(/^ +| +$/g, ''))
  if (bt(partner)) return `partner:${bt(partner).toLowerCase()}`
  if (sqlPhoneCanonical(phone).length >= 7) return `phone:${sqlPhoneCanonical(phone)}`
  if (bt(name)) return `name:${bt(name).toLowerCase()}`
  return 'unknown'
}

describe('creditPartyKey — the twin of pos_credit_party_key', () => {
  test('the SQL CASE is the four branches the JS takes, in the same order', () => {
    const body = latestBody('CREATE OR REPLACE FUNCTION public.pos_credit_party_key(')
    const branches = [
      "WHEN NULLIF(btrim(p_partner), '') IS NOT NULL THEN 'partner:' || lower(btrim(p_partner))",
      "WHEN length(public.pos_phone_canonical(p_phone)) >= 7 THEN 'phone:' || public.pos_phone_canonical(p_phone)",
      "WHEN NULLIF(btrim(p_name), '') IS NOT NULL THEN 'name:' || lower(btrim(p_name))",
      "ELSE 'unknown'",
    ]
    const at = branches.map(b => body.indexOf(b))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test("the phone rule is pos_phone_canonical's, which normalizePhone already twins", () => {
    const body = latestBody('CREATE OR REPLACE FUNCTION public.pos_phone_canonical(p_phone text)', '$function$;')
    expect(body).toContain("regexp_replace(COALESCE(p_phone, ''), '\\D', '', 'g')")
    expect(body).toContain("CASE WHEN d ~ '^977.{8,}' THEN substr(d, 4) ELSE d END")
    expect(body).toContain("'^0+', ''")
  })

  test.each([
    [{ delivery_partner: 'Foodmandu', buyer_phone: '9800000001', buyer_name: 'Hari' }, 'partner:foodmandu'],
    [{ delivery_partner: '  Pathao  ', buyer_name: 'x' }, 'partner:pathao'],
    [{ delivery_partner: '', buyer_phone: '+977-984-1234567', buyer_name: 'Hari' }, 'phone:9841234567'],
    [{ buyer_phone: '098 4123 4567' }, 'phone:9841234567'],
    [{ buyer_phone: '00977 9841234567' }, 'phone:9779841234567'],
    [{ buyer_phone: '977123456', buyer_name: 'Short' }, 'phone:977123456'],
    [{ buyer_phone: '12345', buyer_name: ' Sita Rai ' }, 'name:sita rai'],
    [{ buyer_phone: null, buyer_name: 'RAM' }, 'name:ram'],
    [{ buyer_name: '   ' }, 'unknown'],
    [{}, 'unknown'],
  ])('%j → %s', (bill, key) => {
    expect(creditPartyKey(bill)).toBe(key)
    expect(sqlPartyKey(bill.delivery_partner, bill.buyer_phone, bill.buyer_name)).toBe(key)
  })

  test('only spaces are trimmed, as btrim() trims them, so both keys keep a tab', () => {
    const bill = { buyer_name: '\tHari ' }
    expect(creditPartyKey(bill)).toBe(sqlPartyKey(null, null, '\tHari '))
    expect(creditPartyKey(bill)).toBe('name:\thari')
  })

  test('partyKindOf', () => {
    expect(partyKindOf('partner:pathao')).toBe('partner')
    expect(partyKindOf('phone:9841234567')).toBe('customer')
    expect(partyKindOf('name:hari')).toBe('customer')
    expect(partyKindOf('unknown')).toBe(null)
  })
})

// ── Money ────────────────────────────────────────────────────────────────────────────────────────

describe('paisa', () => {
  test('rupees to paisa round half up, through the float noise', () => {
    expect(toPaisa(1.005)).toBe(101)
    expect(toPaisa(0.1 + 0.2)).toBe(30)
    expect(toPaisa('1500.50')).toBe(150050)
    expect(toPaisa(-2.5)).toBe(-250)
    expect(toPaisa(null)).toBe(0)
    expect(fromPaisa(30)).toBe(0.3)
  })
  test('parseAmount: commas allowed, two decimals at most, nothing typed is null', () => {
    expect(parseAmount('12,48,650.5')).toEqual({ paisa: 124865050, error: null })
    expect(parseAmount('')).toEqual({ paisa: null, error: null })
    expect(parseAmount('10.555').error).toMatch(/two figures after the point/)
    expect(parseAmount('-5').error).toMatch(/as a number/)
    expect(parseAmount('abc').error).toMatch(/as a number/)
  })
})

describe('creditBillLabel', () => {
  test('TI or PB from the bill’s own stamp, the code it was issued under', () => {
    expect(creditBillLabel({ invoice_no: 12, invoice_fy: '82/83', invoice_prefix: 'CAC', vat_registered: true }, false, 'NEW')).toBe('TI12-CAC-82/83')
    expect(creditBillLabel({ invoice_no: 12, invoice_fy: '82/83', invoice_prefix: null, vat_registered: false }, true, 'NEW')).toBe('PB12-NEW-82/83')
    expect(creditBillLabel({ invoice_no: 3, invoice_fy: '82/83', invoice_prefix: '' }, true, 'NEW')).toBe('TI3-82/83')
    expect(creditBillLabel({ order_no: 9 }, true, '')).toBe('#9')
  })
})

// ── Ageing on Nepal's calendar ───────────────────────────────────────────────────────────────────

const npt = (iso, hm) => `${iso}T${hm}:00+05:45`

describe('nepalDaysBetween and the age bands', () => {
  test('a Nepal day, not the UTC one: 23:55 is yesterday at 00:05, 00:05 is today all day', () => {
    expect(nepalDaysBetween(npt('2026-10-14', '23:55'), npt('2026-10-15', '00:05'))).toBe(1)
    // 00:05 Nepal is still the 14th in UTC; it is the same Nepal day as noon.
    expect(nepalDaysBetween(npt('2026-10-15', '00:05'), npt('2026-10-15', '23:59'))).toBe(0)
    expect(nepalDaysBetween(null, npt('2026-10-15', '10:00'))).toBe(null)
  })

  test('across Chaitra → Baisakh (the BS new year) the count runs on without a break', () => {
    const lastChaitra = formatAd(bsToAd(2082, 12, daysInBsMonth(2082, 12)))
    const baisakh1 = formatAd(bsToAd(2083, 1, 1))
    expect(nepalDaysBetween(npt(lastChaitra, '23:50'), npt(baisakh1, '00:10'))).toBe(1)
    const baisakh31 = formatAd(bsToAd(2083, 1, 31))
    expect(nepalDaysBetween(npt(lastChaitra, '12:00'), npt(baisakh31, '12:00'))).toBe(31)
  })

  test('the band edges: 30 / 31, 60 / 61, 90 / 91', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 400].map(ageBucketOf)).toEqual(['d30', 'd30', 'd60', 'd60', 'd90', 'd90', 'over90', 'over90'])
    expect(ageBucketOf(null)).toBe('over90')
    expect(ageBucketOf(-1)).toBe('d30')
  })
})

const NOW = new Date('2026-10-15T06:00:00Z') // 11:45 in Nepal
const daysBefore = n => new Date(NOW.getTime() - n * 86400000).toISOString()
const bill = (id, over = {}) => ({
  order_id: id, buyer_name: 'Hari', buyer_phone: '9841234567', delivery_partner: null, invoice_no: Number(String(id).replace(/\D/g, '')) || 1,
  invoice_fy: '82/83', invoice_prefix: 'CAC', paid_amount: 1000, received: 0, commission: 0, owed: 1000, closed_at: daysBefore(5), ...over,
})

describe('groupByParty', () => {
  test('one row per party, owed summed to the paisa, the latest bill names it, most owed first', () => {
    const bills = [
      bill('a1', { owed: 100.1, closed_at: daysBefore(40), buyer_name: 'hari' }),
      bill('a2', { owed: 200.2, closed_at: daysBefore(3), buyer_name: 'Hari Bahadur', buyer_phone: '+977 9841234567' }),
      bill('b1', { delivery_partner: 'Foodmandu', buyer_name: 'Foodmandu', buyer_phone: '', owed: 5000, closed_at: daysBefore(10) }),
      bill('c1', { buyer_phone: '', buyer_name: 'Walk In', owed: 50 }),
    ]
    const parties = groupByParty(bills, { now: NOW, limits: { 'phone:9841234567': 250 } })
    expect(parties.map(p => [p.key, p.owed, p.billCount])).toEqual([
      ['partner:foodmandu', 5000, 1], ['phone:9841234567', 300.3, 2], ['name:walk in', 50, 1],
    ])
    const hari = parties[1]
    expect(hari.name).toBe('Hari Bahadur')
    expect(hari.oldestDays).toBe(40)
    expect(hari.limit).toBe(250)
    expect(hari.overLimit).toBe(true)
    expect(parties[0]).toMatchObject({ kind: 'partner', partner: 'Foodmandu', limit: null, overLimit: false })
  })

  test('at the limit is not over it, and no limit is never over', () => {
    const at = groupByParty([bill('a1', { owed: 250 })], { limits: { 'phone:9841234567': 250 } })
    expect(at[0].overLimit).toBe(false)
    expect(groupByParty([bill('a1', { owed: 9e6 })])[0].overLimit).toBe(false)
  })
})

describe('ageingByParty and ageingOf', () => {
  test('each party split into the four bands, rows and totals tie to the paisa', () => {
    const bills = [
      bill('a1', { owed: 10.01, closed_at: daysBefore(0) }),
      bill('a2', { owed: 20.02, closed_at: daysBefore(31) }),
      bill('a3', { owed: 30.03, closed_at: daysBefore(61) }),
      bill('a4', { owed: 40.04, closed_at: daysBefore(91) }),
      bill('p1', { delivery_partner: 'Pathao', owed: 0.1, closed_at: daysBefore(30) }),
    ]
    const a = ageingByParty(bills, { now: NOW })
    const hari = a.rows.find(r => r.key === 'phone:9841234567')
    expect(hari.buckets).toEqual({ d30: 10.01, d60: 20.02, d90: 30.03, over90: 40.04 })
    expect(hari.total).toBe(100.1)
    expect(a.totals).toEqual({ d30: 10.11, d60: 20.02, d90: 30.03, over90: 40.04 })
    expect(a.total).toBe(100.2)
    expect(ageingOf(bills.slice(0, 2), { now: NOW })).toEqual({ buckets: { d30: 10.01, d60: 20.02, d90: 0, over90: 0 }, total: 30.03 })
  })
})

// ── Spreading a payment ──────────────────────────────────────────────────────────────────────────

const B = [
  { order_id: 'o1', owed: 600 },
  { order_id: 'o2', owed: 300.5 },
  { order_id: 'o3', owed: 1000 },
]
const P = n => Math.round(n * 100) // rupees → paisa, for the inputs

describe('allocatePayment', () => {
  test('the oldest bills fill first, each up to what it owes', () => {
    const a = allocatePayment({ bills: B, total: P(1000) })
    expect(a.ok).toBe(true)
    expect(a.lines).toEqual([
      { order_id: 'o1', amount: 600, commission: 0 },
      { order_id: 'o2', amount: 300.5, commission: 0 },
      { order_id: 'o3', amount: 99.5, commission: 0 },
    ])
    expect(a.rows.map(r => [r.ticked, r.owedAfter])).toEqual([[true, 0], [true, 0], [true, P(900.5)]])
    expect(a.placed).toBe(P(1000))
  })

  test('a part of the oldest bill only', () => {
    const a = allocatePayment({ bills: B, total: P(250.25) })
    expect(a.lines).toEqual([{ order_id: 'o1', amount: 250.25, commission: 0 }])
    expect(a.rows[1].ticked).toBe(false)
  })

  test('to the paisa: the lines add up to exactly the amount received', () => {
    const bills = [{ order_id: 'x', owed: 0.1 }, { order_id: 'y', owed: 0.2 }, { order_id: 'z', owed: 333.33 }]
    const a = allocatePayment({ bills, total: P(333.63) })
    expect(a.ok).toBe(true)
    const sum = a.lines.reduce((s, l) => s + toPaisa(l.amount), 0)
    expect(sum).toBe(33363)
    expect(a.lines.map(l => l.amount)).toEqual([0.1, 0.2, 333.33])
  })

  test('more than is owed is refused: no advances', () => {
    const a = allocatePayment({ bills: B, total: P(1900.51) })
    expect(a.ok).toBe(false)
    expect(a.left).toBe(1)
    expect(a.problems.find(p => p.over).text).toMatch(/NPR 1,900.51 is more than the NPR 1,900.50 still owed\. A customer can never pay more than they owe/)
    expect(allocatePayment({ bills: B, total: P(1900.5) }).ok).toBe(true)
  })

  test('an unticked bill is skipped by the fill; ticked again it is paid in full first', () => {
    const skip = allocatePayment({ bills: B, total: P(700), excluded: ['o1'] })
    expect(skip.lines).toEqual([{ order_id: 'o2', amount: 300.5, commission: 0 }, { order_id: 'o3', amount: 399.5, commission: 0 }])
    expect(skip.rows[0]).toMatchObject({ ticked: false, excluded: true, amount: 0, owedAfter: P(600) })
    // Retick o1 (the dialog pins its whole room) and untick nothing: o1 takes 600 first, o2 the rest.
    const back = allocatePayment({ bills: B, total: P(700), pinned: { o1: P(600) } })
    expect(back.lines).toEqual([{ order_id: 'o1', amount: 600, commission: 0 }, { order_id: 'o2', amount: 100, commission: 0 }])
  })

  test('with the oldest unticked, too much for the rest says to tick more bills', () => {
    const a = allocatePayment({ bills: B, total: P(1500), excluded: ['o1'] })
    expect(a.ok).toBe(false)
    expect(a.problems.find(p => p.over).text).toMatch(/more than the NPR 1,300.50 the ticked bills still owe\. Tick more bills/)
  })

  test('a bill set by hand is placed first; the rest of the amount fills the others oldest first', () => {
    const a = allocatePayment({ bills: B, total: P(1000), pinned: { o3: P(800) } })
    expect(a.lines).toEqual([{ order_id: 'o1', amount: 200, commission: 0 }, { order_id: 'o3', amount: 800, commission: 0 }])
  })

  test('with no amount typed, the amount is what the ticked bills add up to', () => {
    const a = allocatePayment({ bills: B, total: null, pinned: { o2: P(300.5), o3: P(50) } })
    expect(a.total).toBe(P(350.5))
    expect(a.ok).toBe(true)
  })

  test('bills set to more than the amount received, or a bill above what it owes, are refused', () => {
    const a = allocatePayment({ bills: B, total: P(100), pinned: { o1: P(600) } })
    expect(a.ok).toBe(false)
    expect(a.problems.some(p => /add up to NPR 600, more than the NPR 100 received/.test(p.text))).toBe(true)
    const b = allocatePayment({ bills: B, total: null, pinned: { o2: P(300.51) } })
    expect(b.problems.find(p => p.orderId === 'o2').text).toMatch(/More than this bill still owes \(NPR 300.50/)
  })

  test('nothing typed and nothing ticked asks for the amount', () => {
    const a = allocatePayment({ bills: B })
    expect(a.ok).toBe(false)
    expect(a.problems[0]).toMatchObject({ empty: true })
  })

  test('a delivery partner: each bill takes the amount less its commission, and the line carries both', () => {
    const a = allocatePayment({ bills: B, total: P(810), commission: { o1: P(60), o2: P(30.5), o3: P(100) } })
    expect(a.ok).toBe(true)
    expect(a.lines).toEqual([
      { order_id: 'o1', amount: 540, commission: 60 },
      { order_id: 'o2', amount: 270, commission: 30.5 },
    ])
    expect(a.rows.map(r => r.owedAfter)).toEqual([0, 0, P(1000)])
    // The commission on a bill that takes no part is not counted.
    expect(a.commissionTotal).toBe(P(90.5))
    const over = allocatePayment({ bills: B, total: P(10), commission: { o1: P(700) } })
    expect(over.problems.find(p => p.orderId === 'o1').text).toMatch(/commission is more than this bill still owes/)
  })
})

describe('suggestedCommission', () => {
  test('the agreed rate on the ex-VAT base, to the rupee, less what was already kept, within what is owed', () => {
    expect(suggestedCommission({ base: 1327.43, pct: 15, alreadyKept: 0, owed: 1500 })).toBe(199)
    expect(suggestedCommission({ base: 1327.43, pct: 15, alreadyKept: 150, owed: 700 })).toBe(49)
    expect(suggestedCommission({ base: 1327.43, pct: 15, alreadyKept: 300, owed: 700 })).toBe(0)
    expect(suggestedCommission({ base: 10000, pct: 20, alreadyKept: 0, owed: 1500 })).toBe(1500)
    expect(suggestedCommission({ base: null, pct: 15, owed: 100 })).toBe(null)
    expect(suggestedCommission({ base: 100, pct: '', owed: 100 })).toBe(null)
  })
})

// ── The statement and a receipt as at its moment ─────────────────────────────────────────────────

const EV = [
  { event_at: '2026-09-01T05:00:00+00:00', kind: 'bill', order_id: 'o1', debit: 1000, credit: 0 },
  { event_at: '2026-09-20T05:00:00+00:00', kind: 'receipt', receipt_id: 'r1', debit: 0, credit: 400 },
  { event_at: '2026-10-01T05:00:00+00:00', kind: 'bill', order_id: 'o2', debit: 500.5, credit: 0 },
  { event_at: '2026-10-02T05:00:00+00:00', kind: 'receipt_cancelled', receipt_id: 'r1', debit: 400, credit: 0 },
  { event_at: '2026-10-05T05:00:00+00:00', kind: 'receipt', receipt_id: 'r2', debit: 0, credit: 1000 },
]

describe('statementOf', () => {
  test('brought forward, a running balance, and the balance at the end', () => {
    const s = statementOf(EV, { fromTs: '2026-09-21T00:00:00+05:45', toTs: '2026-10-02T23:59:59.999+05:45' })
    expect(s.opening).toBe(600)
    expect(s.rows.map(r => [r.kind, r.balance])).toEqual([['bill', 1100.5], ['receipt_cancelled', 1500.5]])
    expect(s.closing).toBe(1500.5)
    expect(s.totalDebit).toBe(900.5)
    expect(s.totalCredit).toBe(0)
  })
  test('the whole history ends at what is owed', () => {
    const s = statementOf(EV, { fromTs: null, toTs: null })
    expect(s.opening).toBe(0)
    expect(s.closing).toBe(500.5)
    expect(balanceBefore(EV, '2026-10-05T05:00:00+00:00')).toBe(1500.5)
  })
})

describe('a receipt as at its own moment', () => {
  const r1 = { id: 'r1', received_at: '2026-09-20T05:00:00+00:00', cancelled_at: '2026-10-02T05:00:00+00:00' }
  const r2 = { id: 'r2', received_at: '2026-10-05T05:00:00+00:00', cancelled_at: null }
  const r3 = { id: 'r3', received_at: '2026-10-10T05:00:00+00:00', cancelled_at: null }
  const lines = [
    { receipt_id: 'r1', order_id: 'o1', amount: 400, commission: 0 },
    { receipt_id: 'r2', order_id: 'o1', amount: 1000, commission: 0 },
    { receipt_id: 'r3', order_id: 'o1', amount: 50, commission: 0 },
  ]
  const byId = { r1, r2, r3 }
  test('what the bill still owed straight after it: earlier live receipts and itself, not later ones', () => {
    expect(owedAfterReceipt({ paid: 1500, lines, receiptsById: byId, receipt: r2 })).toBe(500)
    // r1 is reprinted after it was cancelled: as at its own moment it was live.
    expect(owedAfterReceipt({ paid: 1500, lines, receiptsById: byId, receipt: r1 })).toBe(1100)
    // r3: r1 had been cancelled by then, r2 counts.
    expect(owedAfterReceipt({ paid: 1500, lines, receiptsById: byId, receipt: r3 })).toBe(450)
  })
  test('the balances either side of it', () => {
    expect(receiptBalances(EV, r2, 1000)).toEqual({ previous: 1500.5, next: 500.5 })
  })
})

describe('the Collected list', () => {
  test('old whole-bill settlements are the settled bills with no receipt line', () => {
    const bills = [{ id: 'b1', credit_settled_at: 'x' }, { id: 'b2', credit_settled_at: 'y' }, { id: 'b3', credit_settled_at: null }]
    expect(legacySettlements(bills, new Set(['b2'])).map(b => b.id)).toEqual(['b1'])
    expect(legacySettlements(bills, ['b1', 'b2'])).toEqual([])
  })
  test('receipts and old settlements together, newest first', () => {
    const rows = collectedRows(
      [{ id: 'r1', received_at: '2026-10-01T05:00:00Z' }, { id: 'r2', received_at: '2026-10-03T05:00:00Z' }],
      [{ id: 'b1', credit_settled_at: '2026-10-02T05:00:00Z' }],
    )
    expect(rows.map(r => r.id)).toEqual(['r:r2', 'b:b1', 'r:r1'])
    expect(receiptNoLabel({ receipt_no: 12 })).toBe('RC-12')
  })
  test('a cancel reason is 3 to 300 characters, trimmed', () => {
    expect(cancelReasonProblem('  ab ')).toMatch(/at least 3/)
    expect(cancelReasonProblem('Entered twice')).toBe(null)
    expect(cancelReasonProblem('x'.repeat(301))).toMatch(/300 characters/)
  })
})
