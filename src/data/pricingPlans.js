// Single source of truth for Crest's pricing — imported by the public marketing page
// (src/pages/Pricing.js), the logged-in Help page's Pricing tab (src/pages/Help.js), and the
// admin's per-client billing panel (src/pages/adminClients/ClientDrawer.js). Previously these
// three had their own independently hand-maintained copies of this data and had already drifted
// out of sync with each other and with the real feature-tier assignments in AuthContext.js.
//
// Colors are by MODULE, using the mapping DESIGN.md already establishes: IMS = accent, HR = green,
// POS = purple.
//
// These were literal hex (`#60a5fa` / `#34d399` / `#a78bfa`) until 2026-08-12. Two problems, both
// measured: `#60a5fa` was the eighth recorded occurrence of the undocumented indigo DESIGN.md
// tracks by name — and it had become the primary brand colour of the public pricing page. And
// because a literal cannot track the active preset, using these as TEXT failed AA badly on the
// light presets: on Latte, "Crest HR" measured 1.92:1 and every plan name 2.54:1 against white.
// The header comment used to cite AdminDashboardOverview.jsx as precedent for the indigo; DESIGN.md
// records that file as having been FIXED, so the precedent had stopped existing.
//
// Two maps, because a signal colour does two jobs: COLORS fills (dots, borders, tints, solid
// buttons), INK is the same role used as text and resolves to the darker, AA-passing variant on
// light presets. Same split as ThemeContext's `*Text` tokens — see the block comment there.
// Trial length, stated in one place. It used to be written out at four separate call sites and one
// of them disagreed: the FAQ asked "Is the 1-month trial really free?" and answered "7 days", on a
// page headlined "Simple, honest pricing". For a trust-led sale to a buyer who is not a software
// buyer, a page contradicting itself about a number is expensive out of proportion to the fix.
export const TRIAL_DAYS = 7

export const MODULE_COLORS = {
  ims: 'var(--theme-accent)',
  hr:  'var(--theme-green)',
  pos: 'var(--theme-purple)',
}

export const MODULE_INK = {
  ims: 'var(--theme-accent-ink)',
  hr:  'var(--theme-green-text)',
  pos: 'var(--theme-purple-text)',
}

// These are `var()` now, so the old `${MODULE_COLORS.ims}22` hex-alpha concatenation no longer
// produces a valid colour. Use these instead — this is the one place the alpha maths lives.
// colorTint takes any colour value (a var() token included); moduleTint keys off MODULE_COLORS.
export const colorTint = (color, pct) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`
export const moduleTint = (key, pct) =>
  colorTint(MODULE_COLORS[key] || MODULE_COLORS.ims, pct)

// Each tier sells one job. Starter records and complies, Growth controls cost, Pro decides
// strategy — see the same rule expressed as key sets in AuthContext.js. Keep these lists in step
// with STARTER_KEYS/GROWTH_KEYS/PRO_KEYS there; this file is what the public pricing page, the
// Help page's Pricing tab and the admin billing panel all read.
const STARTER_FEATURES = [
  'Dashboard & KPI Overview',
  'Periods (BS Calendar)',
  'Item Master with Unit Conversion',
  'Vendor Management',
  'Purchases & Vendor Returns',
  'Stock Count (Opening / Closing / Wastage)',
  'Mobile App — Installable PWA, Offline Stock Counting',
  'Sales Entry (Bulk or Daily)',
  'Payment Summary (Cash / Credit / FonePay)',
  'Monthly Summary & COGS by Category',
  'Annual Summary (BS Fiscal Year Rollup)',
  'Outstanding Payables with Aging Buckets',
  'VAT & Non-VAT Reports',
  'Vendor Balance Confirmation (IRD Annexure 13)',
  'Wastage Report with Excel Export',
  'Settings & Outlet Customisation',
  'Staff Meals Tracking',
]

const GROWTH_EXTRAS = [
  'Recipe Costing & Live FC%',
  'Variance Report (Theoretical vs Actual)',
  'Reorder Report & Par Levels',
  'Stock Movements Ledger (Book vs Physical)',
  'Overheads, P&L, and Break-Even Analysis',
  'Budget vs Actual per Category',
  'Internal Requisitions (Store to Department)',
  'Dead Stock & Slow Mover Detection',
  'Recipe Contribution Margin Report',
  'Menu Repricing (Underpriced Dish Finder)',
  'Best & Worst Sellers Analysis',
  'Purchase Orders',
  'Nutrition Facts & Allergen Labels',
  'Combo Builder',
]

const PRO_EXTRAS = [
  'Period Comparison (6 / 12 / 24 / All Periods)',
  'Shrinkage Report (Multi-Period Consistency)',
  'Menu Engineering (Star / Puzzle / Dog)',
  'FIFO / Expiry Batch Tracking',
  'Vendor Spend Report',
  'Supplier Contribution (Cost of Sales by Supplier)',
  'Supplier Price Tracker & Rate Alerts',
  'Theoretical Variance (Advanced Drill-Down)',
]

export const IMS_TIERS = [
  { key: 'starter', label: 'Starter', monthly: 2000, annual: 1500, features: STARTER_FEATURES, includesLabel: null },
  { key: 'growth',  label: 'Growth',  monthly: 2600, annual: 1950, features: GROWTH_EXTRAS,    includesLabel: '+ Everything in Starter' },
  { key: 'pro',     label: 'Pro',     monthly: 3500, annual: 2625, features: PRO_EXTRAS,       includesLabel: '+ Everything in Growth' },
]

export const HR_PRICING = {
  monthly: 2600, annual: 1950,
  features: [
    'Employee Records & Pay Setup',
    'Attendance & Staff Roster (auto-generate from schedule)',
    'Payroll — SSF, TDS & Nepal Compliance Built In',
    'Leave, Overtime & Holiday Calendar',
    'Advances, Loans & Festival Allowance',
    'Gratuity & Final Settlement',
    'HR Reports & Analytics',
  ],
}

export const POS_PRICING = {
  monthly: 2000, annual: 1500,
  features: [
    'Table Management & Order Taking',
    'KOT/BOT to Kitchen & Bar',
    'Billing — Discounts, Complimentary, Credit Notes',
    'Shift Reconciliation (X/Z Reports)',
    'Staff PIN Login & Role-Based Access',
    'Sales Reports & Exceptions Tracking',
    'Menu Pricing (works standalone or with IMS Recipe Costing)',
  ],
}

// Crest Suite Pro — an ADD-ON bought on top of whatever modules a client already has, not a
// bundle that contains them. It used to be three tiers priced at ~20% off the sum of all three
// modules, which had two problems: Suite Starter unlocked no Suite feature at all (both
// SuiteGate call sites were minTier="growth"), and Suite Pro added nothing over Suite Growth on
// its own axis — the only difference was the bundled IMS tier. One SKU, one price, real features.
//
// Sold PER OUTLET. Six of the seven features are per-outlet by nature (each outlet has its own
// Owner Dashboard, Monthly Report, Fixed Asset Register); Multi-Outlet is the group-level one,
// and it resolves under the same rule — the group console rolls up exactly those outlets whose
// suite_plan = 'pro' and names the ones it excluded.
export const SUITE_ADDON = {
  key: 'pro',
  label: 'Crest Suite Pro',
  monthly: 2000, annual: 1500,
  requiresLabel: 'Requires Crest IMS · added on top of your modules',
  features: [
    'Owner Dashboard — live margin & labour cost % across modules',
    'Monthly Owner/Manager Report — frozen snapshot per closed period',
    'Multi-Outlet Group Console — every branch on one screen',
    'Demand Forecast (7/30-Day Covers & Revenue Prediction)',
    'Fixed Assets — depreciation, valuation & Nepal statutory tax pools',
  ],
}

// Admin-analytics pricing table (Settings > Plan Pricing, used by AdminDashboardOverview.jsx's
// MRR/ARR estimate) — derived from the same tiers/prices above so a fresh install's internal
// revenue estimate starts in sync with the actual advertised pricing, not an independently
// hand-typed placeholder table that can silently drift out of step with it.
export const DEFAULT_PLAN_PRICES = {
  ims: Object.fromEntries(IMS_TIERS.map(t => [t.key, t.monthly])),
  hr: HR_PRICING.monthly,
  pos: POS_PRICING.monthly,
}
