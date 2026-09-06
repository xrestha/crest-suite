/**
 * The feature catalog: every gated feature's key, label and tier, in one data-only file.
 *
 * WHY (S683): this list lived inside FeatureAccessModal.js, an admin screen, so nothing outside
 * the admin chunk could turn a `featureKey` into a name — and PremiumGate, which is the page a
 * client sees when they click a feature their plan does not include, headlined the PLAN ("Growth
 * Plan Required") and buried the feature they had just clicked in a ten-item paragraph. The gate
 * now says "Variance Report is on the Growth plan". Importing the modal for its constant would
 * have dragged the whole admin modal into the main bundle; a data file costs nothing.
 *
 * `featureCatalog.test.js` reads App.js and fails if a routed `featureKey` has no label here, so
 * the gate can never fall back to the plan-only headline for a real route.
 */

// Each group carries TWO colour keys — `color` drives fills (checkbox background, chip tint) and
// `textColor` drives every glyph and label. One key used to do both jobs, which is the documented
// S551 trap: the base tokens fail AA as text on the light presets (measured "Growth Plan" 3.30:1,
// "Pro Plan" 2.74:1 on Rosé Dawn), and darkening them to fix the text would wreck the fills.
export const FEATURE_GROUPS = [
  { tier: 'core',    label: 'Core — All Plans', color: 'var(--theme-text2)', textColor: 'var(--theme-text2)', features: [
    { key: null, label: 'Dashboard' },
    { key: null, label: 'Periods' },
    { key: null, label: 'Item Master' },
    { key: null, label: 'Vendors' },
    { key: null, label: 'Purchases' },
    { key: null, label: 'Stock Count' },
  ]},
  // Starter sells Record & Comply. Note Reorder Report and Stock Movements are NOT here: both
  // derive their core figure from recipe explosion, and recipe_costing is Growth, so a Starter
  // client could never get a number out of either. Outstanding Payables and Vendor Balance
  // Confirmation moved down in exchange — the first is plain record-keeping, the second is
  // statutory (IRD Annexure 13), and statutory never gates above the base tier.
  { tier: 'starter', label: 'Starter Plan',     color: 'var(--theme-text3)', textColor: 'var(--theme-text2)', features: [
    { key: 'menu_pricing',    label: 'Menu Pricing' },
    { key: 'sales_entry',     label: 'Sales Entry' },
    { key: 'payment_summary', label: 'Payment Summary' },
    { key: 'monthly_summary', label: 'Monthly Summary' },
    { key: 'annual_summary',  label: 'Annual Summary' },
    { key: 'outstanding_payables', label: 'Outstanding Payables' },
    { key: 'vat_report',      label: 'VAT Report' },
    { key: 'non_vat_report',  label: 'Non-VAT Report' },
    { key: 'vendor_balance_confirmation', label: 'Vendor Balance Confirmation' },
    { key: 'wastage_report',  label: 'Wastage Report' },
    { key: 'settings',        label: 'Settings' },
    { key: 'staff_meals',     label: 'Staff Meals' },
  ]},
  // Growth sells Control — the recipe-driven cost loop. Overheads lives here rather than Pro
  // because it is the data-entry page behind Fixed Costs %/Est. Net Margin and Recipes' True
  // Cost allocation: a data-entry page must not sit above the tier of figures that consume it.
  { tier: 'growth',  label: 'Growth Plan',      color: 'var(--theme-green)', textColor: 'var(--theme-green-text)', features: [
    { key: 'recipe_costing',       label: 'Recipe Costing' },
    { key: 'purchase_orders',      label: 'Purchase Orders' },
    { key: 'requisitions',         label: 'Requisitions' },
    { key: 'variance_report',      label: 'Variance Report' },
    { key: 'reorder_report',       label: 'Reorder Report' },
    { key: 'stock_movement_log',   label: 'Stock Movements' },
    // stock_report moved Starter→Growth in the S551 retier (its On-hand figure subtracts a
    // recipe-explosion usage term, meaningless on Starter). AuthContext/App/Layout all moved
    // then; this grid lagged a session behind, which made the feature ungrantable to Starter
    // clients — the row rendered locked + pre-checked in the wrong column (phase 7, S574).
    { key: 'stock_report',         label: 'Stock Report' },
    { key: 'overheads',            label: 'Overheads' },
    { key: 'budget_vs_actual',     label: 'Budget vs Actual' },
    { key: 'best_sellers',         label: 'Best & Worst Sellers' },
    { key: 'dead_stock',           label: 'Dead Stock' },
    { key: 'recipe_margin',        label: 'Recipe Margin' },
    { key: 'nutrition_facts',      label: 'Nutrition Facts' },
    { key: 'menu_repricing',       label: 'Menu Repricing' },
    { key: 'combo_builder',        label: 'Combo Builder' },
  ]},
  // Pro sells Strategy. Demand Forecast and Fixed Assets left this tier for Crest Suite Pro (see
  // the Suite band below) — the first is genuinely cross-module, the second is owner/finance
  // altitude and self-contained.
  { tier: 'pro',     label: 'Pro Plan',         color: 'var(--theme-accent)', textColor: 'var(--theme-accent-ink)', features: [
    { key: 'menu_engineering',     label: 'Menu Engineering' },
    { key: 'vendor_report',        label: 'Vendor Report' },
    { key: 'fifo_report',          label: 'FIFO / Expiry' },
    { key: 'stock_ageing',         label: 'Stock Ageing' },
    { key: 'price_tracker',        label: 'Price Tracker' },
    { key: 'theoretical_variance', label: 'Theoretical Variance' },
    { key: 'period_comparison',    label: 'Period Comparison' },
    { key: 'shrinkage_report',     label: 'Shrinkage Report' },
    { key: 'supplier_contribution', label: 'Supplier Contribution' },
  ]},
  // POS is flat — no tiers — so its features unlock with the module itself. guest_ordering used
  // to sit in the Pro column above, which gated a POS feature on the IMS plan: a POS client on
  // IMS Starter could not buy it at any price, even though it already declared planSource: 'pos'.
  { tier: 'pos',     label: 'Crest POS Module', color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)', features: [
    { key: 'guest_ordering',       label: 'Guest QR Self-Ordering', planSource: 'pos' },
    { key: 'loyalty',              label: 'Loyalty & Rewards', planSource: 'pos' },
  ]},
]

/** `featureKey` → label, for every feature in every tier. Core (null-key) rows are skipped. */
export const FEATURE_LABELS = Object.fromEntries(
  FEATURE_GROUPS.flatMap(g => g.features).filter(f => f.key).map(f => [f.key, f.label])
)

/** The tier a feature is sold in — 'starter' | 'growth' | 'pro' | 'pos'. */
export const FEATURE_TIER = Object.fromEntries(
  FEATURE_GROUPS.flatMap(g => g.features.filter(f => f.key).map(f => [f.key, g.tier]))
)
