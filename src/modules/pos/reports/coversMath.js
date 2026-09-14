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
 * Average dwell (closed_at − opened_at) per party band.
 *
 * `netOf(order)` supplies the order's net sales; CoversReport passes computeOrderAmounts and the
 * settings tab passes nothing (it only wants minutes). The loop body is byte-for-byte what
 * CoversReport carried inline — coversMath.test.js holds a verbatim copy and asserts equality,
 * so any drift here fails the build rather than the report.
 *
 * Skipped rows: no opened_at/closed_at, or a negative dwell (a till clock behind the server's —
 * POS_TODO B4 wants the excluded count surfaced; that is a separate change).
 */
export function turnoverByBand(orders, netOf = () => 0) {
  const buckets = PARTY_BANDS.map(b => ({ ...b, orders: 0, totalMinutes: 0, covers: 0, net: 0 }))
  for (const o of orders) {
    if (!o.opened_at || !o.closed_at) continue
    const mins = (new Date(o.closed_at) - new Date(o.opened_at)) / 60000
    if (mins < 0) continue
    const band = buckets.find(b => b.test(o.covers || 0))
    if (!band) continue
    band.orders += 1; band.totalMinutes += mins; band.covers += (o.covers || 0)
    band.net += netOf(o)
  }
  return buckets.map(b => ({ ...b, avgMinutes: b.orders > 0 ? b.totalMinutes / b.orders : 0 }))
}

/**
 * A bill served at a table. Covers are guests SEATED, so every cover figure — covers served, average
 * party size, turnover, RevPASH, revenue per cover — is dine-in only (owner decision, S754). A
 * takeaway or delivery bill has no table (table_id null); its "covers" is whatever the till
 * defaulted to, and counting it made a takeaway-heavy outlet's average party look like 1.1 and its
 * table turnover look like four minutes.
 *
 * `table_id` must be in the query's select list — a row read without it counts as takeaway.
 */
export function isDineIn(order) {
  return order != null && order.table_id != null
}

export function dineInOnly(orders) {
  return (orders || []).filter(isDineIn)
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
  const dineIn = { bills: 0, covers: 0, net: 0, returns: 0 }
  const takeaway = { bills: 0, net: 0, returns: 0 }
  for (const o of orders || []) {
    if (isDineIn(o)) { dineIn.bills += 1; dineIn.covers += (o.covers || 0); dineIn.net += netOf(o) }
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
 * covers and minutes are untouched — a return is not a sitting. Returns a new array.
 */
export function addReturnsByBand(rows, returns) {
  const out = rows.map(r => ({ ...r }))
  for (const ret of returns || []) {
    if (!isDineIn(ret.order)) continue
    const band = bandFor(ret.order.covers)
    const row = band && out.find(r => r.key === band.key)
    if (row) row.net += ret.net || 0
  }
  return out
}
