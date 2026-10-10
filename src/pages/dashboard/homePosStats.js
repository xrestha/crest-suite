// Home's POS card (also a POS-only client's POS Overview) and the kitchen or bar team's card, after
// a load where a read failed (S809 3n, REPORTS-8). A failed read is not an empty period: the cards
// used to sum their figures from `data || []`, so a dropped connection painted Revenue NPR 0 in
// green and "0 open, 0 late" on a kitchen tablet, and cached those zeros for the next visit.
//
// Each card's figures are grouped by the read that computes them, so one failed read costs only
// its own tiles. The loader caches a load only when every read succeeded; this decides what a
// failed load shows instead.

/** Home's front-of-house POS card: the figures each read computes. */
export const HOME_POS_READS = {
  sales: ['revenueTotal', 'coversTotal', 'dineInBills', 'billCount', 'avgCheck'],
  tables: ['tablesOccupied', 'tablesTotal'],
  bookings: ['bookingsTonight', 'coversToCome', 'requestsPending'],
}

/** The kitchen or bar team's card: one read, today's tickets for its own station. */
export const HOME_KITCHEN_READS = {
  tickets: ['openNow', 'lateCount', 'readyWaiting', 'avgPrepMin', 'completedToday'],
}

/** True when any read of the load failed. */
export function anyReadFailed(failed) {
  return Object.values(failed || {}).some(Boolean)
}

/**
 * The card to show after a load.
 *
 *   prev    what the card showed before this load (state, possibly from the dashboard cache), or null
 *   fresh   the figures this load computed; those of a failed read are meaningless
 *   failed  { [read]: true } for each read that failed
 *   reads   HOME_POS_READS or HOME_KITCHEN_READS
 *
 * A failed read's figures keep the last good ones when the card before was the same card (front of
 * house, or the same kitchen/bar station) and had them. Otherwise they are null, and the read is
 * listed in `unavailable`, which its tiles render as "—" with "Couldn't load". The figures of the
 * reads that succeeded are this load's own. With nothing failed, `fresh` comes back as it is.
 */
export function keepLastGood(prev, fresh, failed, reads) {
  const failedReads = Object.keys(reads).filter(r => failed?.[r])
  if (failedReads.length === 0) return fresh
  const sameCard = prev != null && !!prev.kitchen === !!fresh.kitchen && (prev.station ?? null) === (fresh.station ?? null)
  const stats = { ...fresh }
  delete stats.unavailable
  const unavailable = []
  for (const read of failedReads) {
    const usable = sameCard && !(prev.unavailable || []).includes(read)
    for (const field of reads[read]) stats[field] = usable ? (prev[field] ?? null) : null
    if (!usable) unavailable.push(read)
  }
  if (unavailable.length > 0) stats.unavailable = unavailable
  return stats
}

/** Whether a tile's read is unavailable on the card being shown. */
export function readUnavailable(stats, read) {
  return !!stats?.unavailable?.includes(read)
}
