// Party-size bands and the turnover-by-band roll-up, lifted out of CoversReport.jsx (S677) so the
// Reservations settings tab can show "Measured: N min" per band from the same arithmetic the
// report prints. One definition, two readers — the imsFormulas.js / operatingBands.js rule.
//
// A 2-top and an 8-top have very different expected dine durations, so one blended average
// across every order wouldn't tell a manager much; the bands are also what a reservation's
// default duration is keyed on.

export const PARTY_BANDS = [
  { key: '1-2', label: '1–2 covers', test: c => c <= 2 },
  { key: '3-4', label: '3–4 covers', test: c => c >= 3 && c <= 4 },
  { key: '5-6', label: '5–6 covers', test: c => c >= 5 && c <= 6 },
  { key: '7+',  label: '7+ covers',  test: c => c >= 7 },
]

export function bandFor(covers) {
  return PARTY_BANDS.find(b => b.test(covers || 0)) || null
}

/**
 * The longest a dine-in sitting can be and still be one: 12 hours (S814 4d, B4, owner decision D3),
 * the ceiling POS Setup → Reservations allows for a party's table time (reservationSettings.js
 * clamps each band's duration to 15–720 minutes). A bill open longer was left open past closing —
 * a table nobody closed at night — not a meal, and one such bill moved a band's average by hours.
 */
export const MAX_SITTING_MINUTES = 720

/**
 * One bill's sitting: `{ mins }`, or `{ reason }` when it cannot be one —
 *   'partBill'  a part bill (S836, isPartBill): split off a table's bill so one guest could pay, so
 *               it opened mid-meal and the sitting is the table's own bill;
 *   'untimed'   no opened_at or closed_at;
 *   'negative'  closed before it was opened (a till clock behind the server's);
 *   'overCap'   open longer than MAX_SITTING_MINUTES.
 * The one classifier behind turnoverByBand and turnoverExclusions, so the table and the line that
 * names what it left out cannot disagree.
 */
function classifySitting(o) {
  if (isPartBill(o)) return { reason: 'partBill' }
  if (!o.opened_at || !o.closed_at) return { reason: 'untimed' }
  const mins = (new Date(o.closed_at) - new Date(o.opened_at)) / 60000
  if (mins < 0) return { reason: 'negative' }
  if (mins > MAX_SITTING_MINUTES) return { reason: 'overCap' }
  return { mins }
}

/**
 * Average dwell (closed_at − opened_at) per party band.
 *
 * `netOf(order)` supplies the order's net sales; CoversReport passes computeOrderAmounts and the
 * settings tab passes nothing (it only wants minutes). The loop body is what CoversReport carried
 * inline — coversMath.test.js holds a verbatim copy and asserts equality on sittings under the cap,
 * so any drift here fails the build rather than the report.
 *
 * Skipped rows (classifySitting): a part bill (S836), no opened_at/closed_at, a negative dwell, or
 * one over MAX_SITTING_MINUTES. turnoverExclusions counts them, and the report says how many
 * (POS_TODO B4).
 */
export function turnoverByBand(orders, netOf = () => 0) {
  const buckets = PARTY_BANDS.map(b => ({ ...b, orders: 0, totalMinutes: 0, covers: 0, net: 0 }))
  for (const o of orders) {
    const sitting = classifySitting(o)
    if (sitting.reason) continue
    const mins = sitting.mins
    const band = buckets.find(b => b.test(o.covers || 0))
    if (!band) continue
    band.orders += 1; band.totalMinutes += mins; band.covers += (o.covers || 0)
    band.net += netOf(o)
  }
  return buckets.map(b => ({ ...b, avgMinutes: b.orders > 0 ? b.totalMinutes / b.orders : 0 }))
}

/** The bills turnoverByBand leaves out, by reason: { partBill, untimed, negative, overCap }. */
export function turnoverExclusions(orders) {
  const out = { partBill: 0, untimed: 0, negative: 0, overCap: 0 }
  for (const o of orders || []) {
    const sitting = classifySitting(o)
    if (sitting.reason) out[sitting.reason] += 1
  }
  return out
}

/**
 * The sentence under the Turnover table and on its export, or null when nothing was left out. Only
 * the reasons that happened are named.
 */
export function turnoverExclusionNote(ex) {
  const total = (ex?.partBill || 0) + (ex?.untimed || 0) + (ex?.negative || 0) + (ex?.overCap || 0)
  if (total === 0) return null
  const parts = []
  if (ex.partBill > 0) parts.push(`${ex.partBill} part bill${ex.partBill === 1 ? '' : 's'} (a guest paying separately; the sitting is the table's own bill)`)
  if (ex.negative > 0) parts.push(`${ex.negative} closed before ${ex.negative === 1 ? 'it was' : 'they were'} opened (a till clock behind)`)
  if (ex.overCap > 0) parts.push(`${ex.overCap} open over 12 hours (left open past closing)`)
  if (ex.untimed > 0) parts.push(`${ex.untimed} with no opening or closing time`)
  return `${total} dine-in bill${total === 1 ? ' is' : 's are'} not in this table: ${parts.join(', ')}. Their sales are still in the Overview.`
}

/**
 * A bill served at a table. Covers are guests SEATED, so every cover figure — covers served, average
 * party size, turnover, RevPASH, revenue per cover — is dine-in only (owner decision, S754). A
 * takeaway or delivery bill has no table (table_id null); its "covers" is whatever the till
 * defaulted to, and counting it made a takeaway-heavy outlet's average party look like 1.1 and its
 * table turnover look like four minutes.
 *
 * A part bill (S836, isPartBill) is dine-in too, though it has no table of its own: it was split off
 * a table's bill so one guest could pay separately, and its covers are guests who sat at that table
 * (the split moves them off the table's bill, so nobody is counted twice). It is not a sitting of
 * its own, so turnover leaves it out (classifySitting above).
 *
 * `table_id` AND `part_of_order_id` must be in the query's select list — a row read without them
 * counts as takeaway. The Group Console's SQL (get_group_summary, S836) carries this rule separately and
 * must follow it; the POS Dashboard's channelOf, the Owner Report and Close Shift call this one.
 */
export function isDineIn(order) {
  return order != null && (order.table_id != null || isPartBill(order))
}

/** A part bill: its own bill and invoice, split off an open table bill (pos_orders.part_of_order_id, S836). */
export function isPartBill(order) {
  return order != null && order.part_of_order_id != null
}

export function dineInOnly(orders) {
  return (orders || []).filter(isDineIn)
}

/**
 * Guests seated, over a set of PAID bills: the covers of every dine-in bill, a credit-noted one
 * included (a credit note corrects billing, it does not un-seat the guests). The one count behind the
 * Covers Report's headline (coversTotals below), the POS Dashboard's Covers tile and Home's Covers
 * Served, so none of them can drift from the report they link to (S809 3n, REPORTS-3). The Group
 * Console's SQL, get_group_summary, carries the same rule: close_type 'paid' AND table_id IS NOT NULL
 * (and, since S836, a part bill: part_of_order_id IS NOT NULL — see isDineIn).
 *
 * The caller passes paid bills only: a void or a complimentary bill counts no guests on any of them.
 */
export function seatedCovers(paidOrders) {
  let covers = 0
  for (const o of paidOrders || []) if (isDineIn(o)) covers += parseInt(o.covers, 10) || 0
  return covers
}

/**
 * The Covers Report's headline figures.
 *
 *   orders   paid bills closed in the range — credit-noted ones INCLUDED: a credit note corrects
 *            billing, it does not un-seat the guests, so the bill's covers still count.
 *   netOf    a bill's net sales.
 *   returns  credit notes issued in the range as [{ order, net }] with `net` NEGATIVE and `order`
 *            the bill it credits (which may have closed before the range). A return comes off the
 *            revenue of the side — dine-in or takeaway — its original bill belongs to, so revenue per
 *            cover and RevPASH are net of returns the same way the Sales Report's Net is.
 *
 * Takeaway/delivery is reported beside dine-in as bills and revenue only; it has no covers.
 */
export function coversTotals(orders, netOf = () => 0, returns = []) {
  const dineIn = { bills: 0, covers: seatedCovers(orders), net: 0, returns: 0 }
  const takeaway = { bills: 0, net: 0, returns: 0 }
  for (const o of orders || []) {
    if (isDineIn(o)) { dineIn.bills += 1; dineIn.net += netOf(o) }
    else { takeaway.bills += 1; takeaway.net += netOf(o) }
  }
  for (const r of returns || []) {
    const side = isDineIn(r.order) ? dineIn : takeaway
    side.net += r.net || 0
    side.returns += 1
  }
  return {
    ...dineIn,
    avgParty: dineIn.bills > 0 ? dineIn.covers / dineIn.bills : 0,
    revPerCover: dineIn.covers > 0 ? dineIn.net / dineIn.covers : 0,
    takeaway,
  }
}

/**
 * Adds dine-in returns into turnoverByBand's rows by the party band of the bill each one credits,
 * so a band's Net Sales is net of returns like every other revenue figure on the page. Orders,
 * covers and minutes are untouched — a return is not a sitting. A part bill's return is left out
 * (S836), as its sales are: it is in no band. Returns a new array.
 */
export function addReturnsByBand(rows, returns) {
  const out = rows.map(r => ({ ...r }))
  for (const ret of returns || []) {
    if (!isDineIn(ret.order) || isPartBill(ret.order)) continue
    const band = bandFor(ret.order.covers)
    const row = band && out.find(r => r.key === band.key)
    if (row) row.net += ret.net || 0
  }
  return out
}

/**
 * The TOTAL row under a table of cover rows (Daily Trend, Peak Hours, By Server; 2026-10-15 audit):
 * bills, covers and net sales summed down their columns, and revenue per cover worked out from those
 * sums, never an average of the rows' own averages, which would weigh a two-cover day the same as a
 * forty-cover one. `revPerCover` is null when no covers were served: there is nothing to divide by,
 * which is not a figure of 0. A row with no `net` (Peak Hours) adds nothing to it.
 */
export function coverRowsTotal(rows) {
  let bills = 0, covers = 0, net = 0
  for (const r of rows || []) {
    bills += r.bills || 0
    covers += r.covers || 0
    net += Number(r.net) || 0
  }
  return { bills, covers, net, revPerCover: covers > 0 ? net / covers : null }
}
