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
