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
  'Reorder Report & Par Levels',
  'VAT & Non-VAT Reports',
  'Wastage Report with Excel Export',
  'Settings & Outlet Customisation',
  'Staff Meals Tracking',
]

const GROWTH_EXTRAS = [
  'Recipe Costing & Live FC%',
  'Variance Report (Theoretical vs Actual)',
  'Outstanding Payables with Aging Buckets',
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
  'Overheads, P&L, and Break-Even Analysis',
  'Theoretical Variance (Advanced Drill-Down)',
  'Demand Forecast (7/30-Day Covers & Revenue Prediction)',
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

// Suite = IMS (at the matching tier) + HR + POS, bundled at a discount vs buying separately.
// ~20% off the sum of buying each module at its listed price (2000+2600+2000=6600 / 2600+2600+2000=7200 / 3500+2600+2000=8100).
export const SUITE_BUNDLES = [
  { key: 'starter', label: 'Suite Starter', monthly: 5300, annual: 3975 },
  { key: 'growth',  label: 'Suite Growth',  monthly: 5800, annual: 4350 },
  { key: 'pro',     label: 'Suite Pro',     monthly: 6500, annual: 4875 },
]
