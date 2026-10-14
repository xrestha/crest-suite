// Equal split (S836, owner decision 2026-10-14): the table keeps ONE tax invoice, and each guest is
// handed a printed share slip saying what to pay (buildShareSlipsHtml). This is the one place the
// shares are worked out, so the slips, the screen and anything that totals them cannot disagree.
//
// Shares are whole rupees when the bill is, with the rupees left over going on the first slips:
// 3,542 ÷ 3 → 1,181 / 1,181 / 1,180. A total with paisa is split in paisa the same way, the leftover
// paisa on the first slips. Either way the shares add back to the total exactly, counted in paisa:
// a total finer than the paisa is taken to the paisa first, as every printed bill figure is.

export const MIN_SHARES = 2
export const MAX_SHARES = 20

/**
 * `total` (rupees, ≥ 0) split `n` ways (an integer, 2 to 20) → an array of `n` amounts in rupees,
 * largest first. `[]` for anything else, so a caller never prints a share it did not ask for.
 */
export function equalShares(total, n) {
  if (!Number.isInteger(n) || n < MIN_SHARES || n > MAX_SHARES) return []
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return []
  const paisa = Math.round(total * 100) || 0 // `|| 0` turns a -0 into 0
  const unit  = paisa % 100 === 0 ? 100 : 1  // whole rupees when the bill is, else paisa
  const units = paisa / unit
  const base  = Math.floor(units / n)
  const extra = units - base * n             // fewer than n, one each on the first slips
  return Array.from({ length: n }, (_, i) => ((base + (i < extra ? 1 : 0)) * unit) / 100)
}
