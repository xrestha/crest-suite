// Nepal Income Tax Act, 2058 (2002) — Schedule 2 (pooled depreciation) + Section 16
// (repair/maintenance cost cap). Sourced from a legal-database rendering of the Act's own text
// plus a corroborating web search, NOT a live IRD or chartered-accountant confirmation, and
// Nepal's Finance Act amends these periodically — same caveat this codebase's own tds.js already
// carries for income-tax slabs. VERIFY current figures with an accountant before relying on this
// for an actual filing; the same disclaimer is also shown on-screen on the Tax Depreciation tab.
//
// Deliberately hardcoded, versioned-by-Finance-Act constants — NOT an admin-editable DB setting.
// This mirrors payrollConstants.js/tds.js's existing convention for Nepal statutory figures: a
// code change reviewed by a developer when the Finance Act amends a rate, not a client-editable
// value a client could accidentally mis-set and feed straight into their own tax filing.

// Pool A: buildings & permanent structures. Pool B: computers, data processing equipment,
// furniture, fixtures, office equipment. Pool C: vehicles — automobiles, buses, minibuses.
// Pool D: construction/excavation equipment + anything not listed elsewhere. All declining
// balance (WDV). Pool E (intangibles) has no flat rate — see computeIntangibleAmortization in
// taxPoolCompute.js (cost / useful life, adjusted to the nearest half-year instead).
export const POOL_RATES = { A: 0.05, B: 0.25, C: 0.20, D: 0.15 }

// Statutory label kept first (for anyone cross-checking against the Act/an accountant), but
// reworded for a café/restaurant owner rather than quoted verbatim from Schedule 2 — "Pool D:
// construction and excavation equipment" reads as irrelevant to a cafe owner when it's actually
// the catch-all bucket most of their kitchen gear lands in. Renamed, not re-scoped: the pool
// assignment logic (POOL_RATES, computePoolMovement) is unaffected, this only changes the label.
export const POOL_LABELS = {
  A: 'Pool A — Buildings You Own',
  B: 'Pool B — Furniture, Computers & Office Equipment',
  C: 'Pool C — Vehicles',
  D: 'Pool D — Kitchen Equipment & Everything Else',
  E: 'Pool E — Intangible Assets (software, franchise rights)',
}

// Plain-language, F&B-specific examples for the tooltip on each pool — the single most useful
// piece of guidance on this whole tab, since "which pool does my espresso machine belong to" is
// the actual question a café/restaurant owner has, not "what is a depreciation pool". Written for
// someone with zero accounting background — see taxPoolCompute.js's own comments for the
// technical math these examples correspond to.
// Compact form for narrow UI (a table cell's <select>, where POOL_LABELS' full phrasing would
// wrap/truncate) — same reworded-for-F&B intent as POOL_LABELS, just shorter.
export const POOL_SHORT_LABELS = {
  A: 'A — Buildings',
  B: 'B — Furniture/Computers',
  C: 'C — Vehicles',
  D: 'D — Kitchen & Other',
  E: 'E — Intangibles',
}

export const POOL_EXAMPLES = {
  A: 'Only applies if you own your café/restaurant building outright. Most F&B businesses rent their space — if you rent, this pool is empty and that\'s completely normal.',
  B: 'POS terminals and computers, printers, dining tables and chairs, office desks, air conditioners, CCTV systems.',
  C: 'Delivery bikes, scooters, vans — any vehicle registered to and used by the business.',
  D: 'Most of your kitchen equipment lands here: ovens, refrigerators, freezers, dishwashers, mixers, coffee machines, exhaust hoods, water purifiers — plus anything else that doesn\'t fit Pools A, B, C or E.',
  E: 'Software licenses (e.g. your POS software, accounting software), franchise or trademark rights. Rare for an independent café — mainly relevant if you\'re a franchise.',
}

// Section 16 — deductible repair/maintenance expense on a pool is capped at this % of the pool's
// CLOSING depreciation base for the year. Anything above the cap is not lost; it's added to the
// pool's depreciation base for next year instead of being expensed this year. Confirmed 5%, not
// 7%, via two independent readings of the statutory text — some secondary accounting-blog sources
// state 7%, which this plan's own research found does not match the Act's own wording.
export const REPAIR_CAP_RATE = 0.05

export const DISCLAIMER_TEXT =
  'These figures are computed per the Income Tax Act 2058’s pooled depreciation method for ' +
  'informational purposes. Verify current rates with your accountant before filing — Nepal’s ' +
  'Finance Act amends these periodically.'
