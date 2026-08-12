// Single source of truth for Crest's pricing — imported by the public marketing page
// (src/pages/Pricing.js), the logged-in Help page's Pricing tab (src/pages/Help.js), and the
// admin's per-client billing panel (src/pages/adminClients/ClientDrawer.js). Previously these
// three had their own independently hand-maintained copies of this data and had already drifted
// out of sync with each other and with the real feature-tier assignments in AuthContext.js.
//
// Colors are by MODULE (blue=IMS, green=HR, violet=POS), matching the convention already used on
// the Admin Dashboard's client-list module pills (AdminDashboardOverview.jsx) and Help.js's
// Getting Started tab — not the old per-tier gold/green/indigo scheme, since pricing is now
// organized by module (IMS has real tiers; HR/POS are flat single prices), not one universal ladder.
export const MODULE_COLORS = {
  ims: '#60a5fa',
  hr:  '#34d399',
  pos: '#a78bfa',
}

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
