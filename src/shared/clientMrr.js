import { DEFAULT_PLAN_PRICES, SUITE_ADDON } from '../data/pricingPlans'

// What one client pays us per month, in one place.
//
// This lived inside AdminDashboardOverview.jsx and nowhere else, which meant Admin → Clients — the
// screen where an operator actually activates modules, extends dates and answers "what is this
// account worth" — showed no money at all. The two obvious ways to fix that were to import this or
// to write it again on the other page; there is no version of the second that stays correct,
// because every rule below is a rule someone got wrong once:
//
//   * A module counts only when it is ENABLED **and** its date is in the future. Checking the date
//     alone billed a client who had HR switched off without `hr_ends_at` ever being cleared.
//   * Crest Suite Pro ADDS to the module sum; it is not a bundle that replaces it. It used to be
//     the latter, and the branch returned early and ignored the modules entirely.
//   * Suite resolves through `suite_ends_at`, falling back to the IMS window only for rows written
//     before that column existed — the same resolution the ★ SUITE pill uses, so the pill and the
//     money can never disagree on the same screen (S552/S574).
//   * Annual billing is 25% off the monthly rate, applied uniformly wherever annual pricing
//     appears, so an annually-billed client contributes the discounted figure and not the list one.
//
// Pure: takes the client row and the resolved price table, touches no context and no network.

/** Days from now until `date`, rounded up. Negative once it has passed. */
const daysLeft = date => Math.ceil((new Date(date) - Date.now()) / 86400000)

/** A module's own window: enabled, with a date that has not passed. */
const windowOpen = (enabled, endDate) => Boolean(enabled && endDate && daysLeft(endDate) > 0)

export function monthlyRate(base, billingCycle) {
  return billingCycle === 'annual' ? Math.round(base * 0.75) : base
}

/**
 * Per-module breakdown plus the total, so a caller can show either without recomputing.
 * `lines` holds only what the client is actually billed for — an absent module is absent, not zero,
 * because a list of zeros reads as "we charge for this and they pay nothing".
 *
 * @param {object} c            a `clients` row
 * @param {object} [planPrices] `settings.plan_prices`, falling back to the shipped defaults
 * @returns {{ total: number, lines: Array<{key: string, label: string, amount: number}> }}
 */
export function clientMrrBreakdown(c, planPrices) {
  const prices    = planPrices || DEFAULT_PLAN_PRICES
  const imsPrices = prices.ims || DEFAULT_PLAN_PRICES.ims
  const hrPrice   = prices.hr ?? DEFAULT_PLAN_PRICES.hr
  const posPrice  = prices.pos ?? DEFAULT_PLAN_PRICES.pos

  const imsEnd    = c.ims_ends_at || c.subscription_ends_at
  const imsActive = windowOpen(c.ims_enabled !== false, imsEnd)

  // `suite_ends_at` is independent of any single module's expiry; the IMS fallback covers rows
  // written before that column existed and applies only while IMS itself is live.
  const suiteEnd    = c.suite_ends_at || (imsActive ? imsEnd : null)
  const suiteActive = Boolean(c.suite_plan) && Boolean(suiteEnd) && daysLeft(suiteEnd) > 0

  const lines = []
  if (imsActive) {
    const amount = monthlyRate(imsPrices[c.plan] || 0, c.billing_cycle)
    // A Starter tier priced at 0 is a real configuration, so it is listed rather than dropped —
    // "IMS · Starter, NPR 0" is information; a missing line would read as IMS being off.
    lines.push({ key: 'ims', label: `IMS · ${c.plan || 'starter'}`, amount })
  }
  if (windowOpen(c.hr_enabled, c.hr_ends_at)) {
    lines.push({ key: 'hr', label: 'HR', amount: monthlyRate(hrPrice, c.billing_cycle) })
  }
  if (windowOpen(c.pos_enabled, c.pos_ends_at)) {
    lines.push({ key: 'pos', label: 'POS', amount: monthlyRate(posPrice, c.billing_cycle) })
  }
  if (suiteActive) {
    // Suite's own annual figure is a published price, not a 25% derivation, so it is read from
    // SUITE_ADDON rather than run through monthlyRate.
    lines.push({
      key: 'suite',
      label: 'Crest Suite Pro',
      amount: c.billing_cycle === 'annual' ? SUITE_ADDON.annual : SUITE_ADDON.monthly,
    })
  }

  return { total: lines.reduce((sum, l) => sum + l.amount, 0), lines }
}

/** The monthly figure alone. */
export function clientMRR(c, planPrices) {
  return clientMrrBreakdown(c, planPrices).total
}
