/**
 * The Owner Dashboard's figure builders (S849), pulled out of the page so each can be tested and the
 * page stops growing. The Inventory Dashboard / Home use `operatingFigures`, `revenueOf` and `netSpendOf`
 * too, so the two dashboards keep one clock and one arithmetic.
 *
 *   - tileState            which tiles may show a figure, from the page's section map (OWNER-DASHBOARD-2)
 *   - revenueOf            revenue so far and over the counted days (OWNER-DASHBOARD-8)
 *   - netSpendOf           net purchases so far and over the counted days, stock transfers included
 *                          (DASH-TRANSFERS, PNL-8)
 *   - operatingFigures     Spend %, Labour %, Prime %, True / Est. Net Margin %, Fixed Costs %
 *                          (OWNER-DASHBOARD-1, -8, PNL-1 parity)
 *   - cashCreditSplit      Purchases · Cash / Credit, the Payment Report's figures (OWNER-DASHBOARD-13),
 *                          a return against an earlier month's bill at that bill's discount (S853)
 *   - loadOverdueCreditBills  Overdue Payables valued as Outstanding Payables values them (OWNER-DASHBOARD-7)
 *   - trendWithBasis       the 12-month trend with a mark where a frozen report's method changed
 *                          (OWNER-DASHBOARD-11)
 */
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { settleWithin } from '../../utils/withTimeout'
import { BS_MONTHS_SHORT } from '../../utils/bsCalendar'
import { allocateBillDiscounts, returnCostValue } from '../ims/reports/supplierAttribution'
import { billPayables } from '../ims/reports/purchaseTaxSplit'
import { valueBillLines, groupIntoBills, EPS } from '../ims/reports/payablesAllocation'
import { transferTotals } from '../ims/transfers/transferFlows'
import { foodCostBasisOf, netMarginTaxFeesOf, labourBasisOf } from '../ownerReport/computeMonthlyReport'
import { inCountedDays, prorate } from './mtdClock'

// ── Sections and tiles ───────────────────────────────────────────────────────────────────────────

export const OWNER_SECTIONS = ['period', 'ims', 'reorder', 'payables', 'labour', 'commission', 'trend']

/**
 * A tile shows a figure only when every section it depends on is `ok`. One failed dependency is a
 * dash and "Couldn't load · Retry" (it names that section, so Retry reloads only it); a loading one is
 * a skeleton; `none` (no open month) is a dash with its own sentence.
 *
 * @param {Object<string, { status: 'loading'|'ok'|'failed'|'none' }>} sections
 * @param {string[]} deps
 * @returns {{ state: 'loading'|'failed'|'none'|'ok', failed: ?string }}
 */
export function tileState(sections, deps) {
  const list = (deps || []).filter(Boolean)
  const statusOf = d => sections?.[d]?.status || 'loading'
  const failed = list.find(d => statusOf(d) === 'failed')
  if (failed) return { state: 'failed', failed }
  if (list.some(d => statusOf(d) === 'loading')) return { state: 'loading', failed: null }
  if (list.some(d => statusOf(d) === 'none')) return { state: 'none', failed: null }
  return { state: 'ok', failed: null }
}

// ── Revenue and spend, so far and over the counted days ──────────────────────────────────────────

const num = v => parseFloat(v) || 0

/**
 * Revenue before VAT and after discounts; a comped dish (`source = 'pos_comp'`) was never paid for.
 * `unit_price` on the row, else the recipe's selling price. `all` is everything so far (today
 * included, the Revenue tile); `counted` is the finished days a ratio divides by (mtdClock).
 */
export function revenueOf(sales, priceMap, clock) {
  let all = 0, counted = 0
  for (const r of sales || []) {
    if (r.source === 'pos_comp') continue
    const price = r.unit_price != null ? num(r.unit_price) : (priceMap?.[r.recipe_id] || 0)
    const v = num(r.qty_sold) * price - num(r.discount)
    all += v
    if (inCountedDays(r.bs_day, clock)) counted += v
  }
  return { all, counted }
}

/**
 * Net purchases: each bill net of its discount on the cost basis (`lineCost`, S792 D32), less returns
 * at their line's cost basis, plus stock RECEIVED from another outlet, less stock SENT to one (PNL-8:
 * `direction = 'in'` adds like a purchase, `'out'` comes off like a return, at the sender's frozen
 * value). `counted` keeps only rows dated in the finished days (a Bulk / undated row counts).
 */
export function netSpendOf({ purchases, returns, transfers, clock } = {}) {
  const allocated = allocateBillDiscounts(purchases || [])
  let all = 0, counted = 0
  for (const p of allocated) {
    all += p.lineCost
    if (inCountedDays(p.bs_day, clock)) counted += p.lineCost
  }
  for (const r of returns || []) {
    const v = returnCostValue(r)
    all -= v
    if (inCountedDays(r.bs_day, clock)) counted -= v
  }
  const tAll = transferTotals(transfers || [])
  const tCounted = transferTotals((transfers || []).filter(t => inCountedDays(t.bs_day, clock)))
  all += tAll.inVal - tAll.outVal
  counted += tCounted.inVal - tCounted.outVal
  return {
    all, counted,
    transfers: { inAll: tAll.inVal, outAll: tAll.outVal, inCounted: tCounted.inVal, outCounted: tCounted.outVal },
  }
}

// ── The operating ratios ─────────────────────────────────────────────────────────────────────────

/**
 * The ratios both dashboards show, on one clock (mtdClock).
 *
 * @param {object} a
 * @param {?number} a.revenue    counted-days revenue
 * @param {?number} a.spend      counted-days net purchases (transfers included)
 * @param {?number} a.labour     resolveOutletLabour(...).amount (null: no labour figure)
 * @param {number}  a.overhead   the month's Overheads, WHOLE month as typed
 * @param {number}  a.taxFees    the month's Tax & Fees, whole month as typed
 * @param {?number} [a.commission] delivery commission on bills sold in the counted days; null = a failed
 *                                 or unreadable read (no margin); 0/undefined = none (or no POS)
 * @param {object}  a.clock      mtdClock(period)
 * @returns {{ spendPct, labourPct, primePct, marginPct, fixedCostsPct, fixedCounted, fixedMissing, firstDay }}
 *   Fixed costs are counted for the finished days (prorate, SU4 (a)); `fixedMissing` is a month with no
 *   Overheads and no Tax & Fees at all (the margin is shown and not judged). Day 1: every ratio null.
 */
export function operatingFigures({ revenue, spend, labour, overhead = 0, taxFees = 0, commission, clock }) {
  const fixedWhole = num(overhead) + num(taxFees)
  const fixedCounted = prorate(fixedWhole, clock) ?? 0
  const fixedMissing = fixedWhole === 0
  const none = { spendPct: null, labourPct: null, primePct: null, marginPct: null, fixedCostsPct: null, fixedCounted, fixedMissing }
  if (clock?.firstDay) return { ...none, firstDay: true }
  const revOk = revenue != null && revenue > 0
  if (!revOk) return { ...none, firstDay: false }
  const spendPct = spend != null ? (spend / revenue) * 100 : null
  const labourPct = labour != null ? (labour / revenue) * 100 : null
  const primePct = spendPct != null && labourPct != null ? spendPct + labourPct : null
  const marginPct = spend != null && labour != null && commission !== null
    ? ((revenue - spend - labour - fixedCounted - (commission || 0)) / revenue) * 100
    : null
  const fixedCostsPct = labour != null ? ((fixedCounted + labour) / revenue) * 100 : null
  return { spendPct, labourPct, primePct, marginPct, fixedCostsPct, fixedCounted, fixedMissing, firstDay: false }
}

// ── Purchases · Cash / Credit ────────────────────────────────────────────────────────────────────

/**
 * What the month's bills cost by how they were paid — the Payment Report's own figures
 * (`billPayables`): each bill at its grand total (VAT included, after the bill discount), each return
 * off the method it was paid by at the discounted price, plus its VAT. Cash is every method but Credit
 * (FonePay counts with Cash). A transfer is not a bill and is not here. `purchases` need `id`,
 * `payment_method`, `discount_amount` and the bill keys; `returns` need `purchase_entry_id` and
 * `payment_method`.
 *
 * `priorBillLines` (S853): every line of each earlier-month bill a return points at
 * (`readPriorBillLines` over `returnsAgainstEarlierBills`), so such a return comes off at its own
 * bill's discounted price, as the Payment Report takes it off. Without them it came off at list price.
 */
export function cashCreditSplit(purchases, returns, period, { priorBillLines } = {}) {
  const { bills, returns: priced } = billPayables(purchases || [], returns || [], period, { priorBillLines })
  let cash = 0, credit = 0
  for (const b of bills) {
    if (b.method === 'Credit') credit += b.total
    else cash += b.total
  }
  for (const r of priced) {
    if (r.method === 'Credit') credit -= r.value
    else cash -= r.value
  }
  return { cash, credit }
}

/**
 * The purchase lines this month's returns point at that sit in an EARLIER month (S756, D10), read off
 * each return's own `purchase_entries(period_id)` embed, so the bills can be read as soon as the
 * returns land, without waiting for the month's purchases. The same set `returnLinesOutsidePeriod`
 * gives from the purchases: every line of this month is among them, so a line from another month is
 * exactly a line that is not. An unlinked return has no line and is not listed.
 */
export function returnsAgainstEarlierBills(returns, periodId) {
  return [...new Set((returns || [])
    .filter(r => r.purchase_entry_id != null && r.purchase_entries?.period_id !== periodId)
    .map(r => r.purchase_entry_id))]
}

// ── Overdue Payables ─────────────────────────────────────────────────────────────────────────────

const OVERDUE_BILL_COLUMNS = 'id, created_at, bs_day, qty, rate, invoice_ref, paid_at, vat_inclusive, discount_amount, purchase_group_id, vendor_id, monthly_periods!inner(client_id, bs_year, bs_month)'
export const OVERDUE_DAYS = 60

/**
 * Credit BILLS with money still owed more than 60 days after the bill date, valued exactly as
 * Outstanding Payables values them (its load, its `valueBillLines` + `groupIntoBills`): the supplier's
 * invoice after the bill discount and returns, VAT included, less what has been paid. The tile counted
 * LINES at qty × rate before (S747): 24 lines for 2 bills, ex-VAT and before returns.
 *
 * 1. every unpaid Credit line of the client, across periods (paged); 2. every line of those bills by
 * `purchase_group_id` (chunked; a legacy line with no group is its own bill); 3. payments and returns
 * by line id (chunked + paged).
 *
 * @returns {Promise<{ overdueTotal: ?number, overdueCount: ?number, error: ?object }>}
 */
export async function loadOverdueCreditBills({ supabase, scopedFrom, clientId, today = new Date(), timeoutMs = 20000 }) {
  const fail = error => ({ overdueTotal: null, overdueCount: null, error })
  if (!clientId) return fail({ message: 'No outlet is selected.' })
  const seedRes = await settleWithin(fetchAllRows(() => supabase.from('purchase_entries')
    .select(OVERDUE_BILL_COLUMNS)
    .eq('monthly_periods.client_id', clientId)
    .eq('payment_method', 'Credit')
    .is('paid_at', null)
    .order('id')), timeoutMs, 'Unpaid credit bills')
  if (seedRes.error) return fail(seedRes.error)
  const seed = seedRes.data || []
  if (seed.length === 0) return { overdueTotal: 0, overdueCount: 0, error: null }

  // A part-paid bill has some lines stamped paid: its figures need every line (calcBillTotals is not
  // linear in the bill discount, S723), so the bills are completed by group id.
  const groupIds = [...new Set(seed.map(e => e.purchase_group_id).filter(Boolean))]
  const sibRes = await settleWithin(fetchAllRowsChunked(groupIds, gids => supabase.from('purchase_entries')
    .select(OVERDUE_BILL_COLUMNS)
    .eq('monthly_periods.client_id', clientId)
    .eq('payment_method', 'Credit')
    .in('purchase_group_id', gids)
    .order('id')), timeoutMs, 'Credit bill lines')
  if (sibRes.error) return fail(sibRes.error)
  const byId = new Map()
  for (const e of sibRes.data || []) byId.set(e.id, e)
  for (const e of seed) if (!byId.has(e.id)) byId.set(e.id, e)
  const lines = [...byId.values()]
  const ids = lines.map(e => e.id)

  const [pmtRes, retRes] = await Promise.all([
    settleWithin(fetchAllRowsChunked(ids, chunk => scopedFrom('payable_payments', 'id, purchase_entry_id, amount, paid_at, payment_mode, credit_link_id')
      .in('purchase_entry_id', chunk).order('id')), timeoutMs, 'Payable payments'),
    settleWithin(fetchAllRowsChunked(ids, chunk => scopedFrom('vendor_returns', 'purchase_entry_id, qty, rate')
      .in('purchase_entry_id', chunk).order('id')), timeoutMs, 'Vendor returns'),
  ])
  if (pmtRes.error) return fail(pmtRes.error)
  if (retRes.error) return fail(retRes.error)
  const pmtMap = {}
  for (const p of pmtRes.data || []) (pmtMap[p.purchase_entry_id] = pmtMap[p.purchase_entry_id] || []).push(p)
  const returnedByEntry = {}
  for (const r of retRes.data || []) {
    returnedByEntry[r.purchase_entry_id] = (returnedByEntry[r.purchase_entry_id] || 0) + num(r.qty) * num(r.rate)
  }
  return { ...overdueFromLines(lines, pmtMap, returnedByEntry, today), error: null }
}

/** The pure half: value the lines, group them into bills, keep the overdue ones. */
export function overdueFromLines(lines, pmtMap, returnedByEntry, today = new Date()) {
  const bills = groupIntoBills(valueBillLines(lines || [], pmtMap || {}, returnedByEntry || {}, today), pmtMap || {})
  const overdue = bills.filter(b => b.daysOld > OVERDUE_DAYS && b.remaining > EPS)
  return {
    overdueTotal: overdue.reduce((s, b) => s + b.remaining, 0),
    overdueCount: overdue.length,
  }
}

// ── The 12-month trend ───────────────────────────────────────────────────────────────────────────

const pct1 = v => (v != null && Number.isFinite(Number(v)) ? Number(Number(v).toFixed(1)) : null)

/**
 * The trend points, oldest first, each with the method its frozen report used, and a mark at each month
 * whose method differs from the month before. `reports` are `{ bs_year, bs_month, combined }` rows (the
 * read selects `combined:snapshot->combined`), oldest first.
 *
 * Three changes are marked: Food Cost / Prime moved to stock used ÷ sales (schema 9, `foodCostBasis`),
 * Net Margin began taking off Tax & Fees (schema 12) and then wasted stock, staff meals and delivery
 * commission (schema 18, `netMarginPnlCosts`), and Labour moved to pay earned plus bonuses and final pay
 * (schema 13, `labourBasis`).
 *
 * @returns {{ points: object[], marks: Array<{ label: string, kinds: string[] }> }}
 */
export function trendWithBasis(reports) {
  const points = (reports || []).map(r => {
    const combined = r.combined || r.snapshot?.combined || {}
    const snap = { combined }
    return {
      label: `${BS_MONTHS_SHORT[r.bs_month - 1]} ${r.bs_year}`,
      fc: pct1(combined.foodCostPct),
      labor: pct1(combined.laborCostPct),
      prime: pct1(combined.primeCostPct),
      margin: pct1(combined.netMarginPct),
      basis: {
        food: foodCostBasisOf(snap),
        net: `${netMarginTaxFeesOf(snap)}|${combined.netMarginPnlCosts === true}`,
        labour: labourBasisOf(snap),
      },
    }
  })
  const marks = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].basis, b = points[i].basis
    const kinds = []
    if (a.food !== b.food) kinds.push('food')
    if (a.net !== b.net) kinds.push('netMargin')
    if (a.labour !== b.labour) kinds.push('labour')
    if (kinds.length) marks.push({ label: points[i].label, kinds })
  }
  return { points, marks }
}
