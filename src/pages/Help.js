import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettings } from '../context/SettingsContext'

const MODULES = [
  // === All Plans ===
  {
    icon: '◷', name: 'Periods', plan: null, color: '#c9a84c',
    guide: 'Create one period per BS month. A period must be open before you can enter purchases, stock, or sales. Close a period at month end to lock the data. Closing stock auto-carries to next month opening. Periods older than 12 months are archived by default.',
    tips: ['Always create a new period before the month starts', 'Close the period only after entering closing stock', 'Use "Show Archived" in Periods to access old months']
  },
  {
    icon: '≡', name: 'Item Master', plan: null, color: '#c9a84c',
    guide: 'Your ingredient database. Every item needs a name, category, UOM (unit of measure), and rate. The system calculates Per UOM Rate automatically. Set conversion factors if you buy in bulk packs but consume in smaller units (e.g. 1 CTN = 24 BTL).',
    tips: ['Use consistent UOMs — GM for solids, ML for liquids', 'Set conversion factor if 1 case = 24 bottles etc.', 'Deactivate items you no longer use — do not delete them']
  },
  {
    icon: '⊙', name: 'Vendors', plan: null, color: '#c9a84c',
    guide: 'Add all your suppliers here. Linking purchases to vendors lets you track spend per supplier and identify price trends over time. Vendors can be set Active or Inactive.',
    tips: ['Add all vendors before starting purchase entries', 'Inactive vendors are hidden from purchase dropdowns but their data is preserved']
  },
  {
    icon: '↓', name: 'Purchases', plan: null, color: '#c9a84c',
    guide: 'Record every ingredient purchase here. Select the item, vendor, day of month, quantity, rate, and payment method (Cash/Credit/FonePay). The rate auto-fills from the item master but can be overridden. Use the Returns tab to log items sent back to suppliers. You can also apply a bill-level discount.',
    tips: ['Enter purchases daily from the actual invoice — not from memory at month end', 'Always enter the actual invoice rate if it differs from the master rate', 'Add invoice reference number for audit trail', 'Returns auto-inherit rate and vendor from the original purchase']
  },
  {
    icon: '⊞', name: 'Stock Count', plan: null, color: '#c9a84c',
    guide: 'Four tabs: Opening Stock (start of month), Closing Stock (physical count at month end), Wastage (spoilage during the month), and Staff Meals (internal consumption by staff). The Summary tab computes Used = Opening + Net Purchases − Wastage − Staff Meals − Closing. Export the Summary to Excel. On mobile, each tab shows a card list with a large number input per item — tap a card, enter the quantity, and it auto-saves when you move to the next item.',
    tips: ['Print the Stock Count Sheet and do a physical walk before entering closing stock', 'Enter opening stock before any purchases for accurate COGS', 'Wastage should be recorded as it happens, not estimated at month end', 'Use Staff Meals tab to track food consumed by staff — keeps it separate from wastage', 'Install the app on your phone (see Mobile App) to count stock directly from the storeroom or fridge — even without internet']
  },
  {
    icon: '◉', name: 'Mobile App', plan: null, color: '#c9a84c',
    guide: 'Crest Inventory can be installed on any smartphone as an app — no app store required. On Android, open the app in Chrome and tap "Add to Home Screen" from the browser menu. On iPhone, open in Safari, tap the Share button, and choose "Add to Home Screen". Once installed, the app opens directly to Stock Count in full-screen mode. The app works offline: visit Stock Count once while connected to cache all items and periods to your phone. You can then count stock in the walk-in fridge or storeroom with no signal — entries are saved locally and synced to the server automatically when you return to an area with internet.',
    tips: ['Open the app online at the start of each shift to refresh the cache before going offline', 'An amber "Offline" banner appears at the top when you have no connection — entries are still being saved locally', 'Cards with a dashed amber border have been saved locally and are waiting to sync', 'The green "Syncing…" banner appears briefly when the app is pushing offline entries to the server', 'Uninstall and reinstall the app after a major update to ensure the latest version is cached']
  },
  // === Starter+ ===
  {
    icon: '↑', name: 'Sales Entry', plan: 'Starter+', color: '#9ca3af',
    guide: 'Record total qty sold per menu item for the period. Only items with a recipe appear here. Revenue is calculated automatically from selling price × qty sold. Use Bulk Entry for monthly POS totals.',
    tips: ['Sales data is required for the Variance Report to calculate theoretical usage', 'Sub-recipes are excluded — only top-level recipes appear here', 'You can update sales entries any time while the period is open']
  },
  {
    icon: '◎', name: 'Payment Summary', plan: 'Starter+', color: '#9ca3af',
    guide: 'Breaks down total revenue by payment method — Cash, Credit, and FonePay. Shows gross sales, returns, and net per method with a daily breakdown for the selected period.',
    tips: ['Match this against your POS or daily cash counts for reconciliation', 'Revenue here comes from Sales Entry — make sure sales are entered first']
  },
  {
    icon: '◻', name: 'Monthly Summary', plan: 'Starter+', color: '#9ca3af',
    guide: 'The month-end financial report. Shows opening stock, purchases, wastage, closing stock, and COGS by category. Food cost % is calculated against sales revenue. Export to Excel for your accountant or management review.',
    tips: ['FC% benchmark for cafes: 28–35%', 'A high purchase-based FC% vs actual FC% gap often indicates closing stock errors', 'Share this report with ownership every month end']
  },
  {
    icon: '⟳', name: 'Annual Summary', plan: 'Starter+', color: '#9ca3af',
    guide: 'Rollup of all monthly periods in a BS fiscal year. See full-year COGS, purchases, wastage, and food cost % at a glance. Select any BS year from the dropdown.',
    tips: ['Use this to identify which months consistently run high food cost', 'Compare annual FC% year-over-year to spot long-term trends']
  },
  {
    icon: '⚑', name: 'Reorder Report', plan: 'Starter+', color: '#9ca3af',
    guide: 'Flags items running below their par level. Theoretical stock = Opening + Net Purchases − Wastage − Usage. Set par levels inline on the report. "✕ Clear All Par" resets all par levels at once.',
    tips: ['Set par levels based on supplier lead time × daily usage rate', 'Review the reorder report weekly, not just at month end']
  },
  {
    icon: '⊛', name: 'VAT Report', plan: 'Starter+', color: '#9ca3af',
    guide: 'Summarises input VAT on purchases. Toggle the VAT-inclusive flag per purchase entry in the Purchases page. Shows total VAT paid per period for use in your IRD VAT return.',
    tips: ['Only purchases marked as VAT-inclusive are counted in the VAT total', 'Match this against your supplier VAT invoices before filing']
  },
  {
    icon: '⊘', name: 'Non-VAT Report', plan: 'Starter+', color: '#9ca3af',
    guide: 'Lists all purchases from non-VAT registered vendors. Useful for accounting and for separating VAT vs non-VAT purchase records.',
    tips: ['Non-VAT purchases are those not marked as VAT-inclusive in the Purchases entry']
  },
  {
    icon: '⚠', name: 'Wastage Report', plan: 'Starter+', color: '#9ca3af',
    guide: 'Detailed breakdown of all wastage entered during the period. Shows total value, item count, and top category. Filter by category. Export to Excel or print for management review.',
    tips: ['Sort by value to identify highest-cost wastage items', 'High wastage on the same item repeatedly signals a process or portioning problem']
  },
  // === Growth+ ===
  {
    icon: '◈', name: 'Recipe Costing', plan: 'Growth+', color: '#34d399',
    guide: 'Build your menu items with ingredients and qty per portion. Food cost % is calculated live from latest purchase rates. Enter selling price (incl. VAT) to see margin and get a suggested price at your target FC%. Sub-recipes can be nested inside parent recipes.',
    tips: ['FC% below 30% = excellent, 30–38% = acceptable, above 38% = needs review', 'Update recipes when ingredient prices change significantly', 'Use the overhead panel in each recipe\'s detail view to see true cost after fixed cost allocation']
  },
  {
    icon: '△', name: 'Variance Report', plan: 'Growth+', color: '#34d399',
    guide: 'Compares theoretical usage (sales × recipe qty) against actual usage (opening + purchases − closing − wastage). Positive variance means more was used than sold — indicating waste, theft, or over-portioning. Items with >10% variance are flagged.',
    tips: ['Sort by NPR value to prioritise the biggest leaks', 'Items with no recipe show actual usage only — no theoretical comparison', 'Review this every month before closing the period']
  },
  {
    icon: '₿', name: 'Outstanding Payables', plan: 'Growth+', color: '#34d399',
    guide: 'Tracks all credit purchases that have not been paid. Groups payables by vendor with aging buckets: Current / 31–60 / 61–90 / 90+ days. Mark individual entries as paid directly from this report.',
    tips: ['Anything in the 61–90 day bucket needs immediate follow-up with finance', 'Mark Paid once the vendor is settled — it removes the entry from the outstanding list']
  },
  {
    icon: '◑', name: 'Budget vs Actual', plan: 'Growth+', color: '#34d399',
    guide: 'Set monthly purchase budgets per category and compare against actual spend. Shows variance in NPR and % with status badges (On Track / Over / Under). Budgets are editable inline directly on the report.',
    tips: ['Set budgets at the start of each month before purchases begin', 'Use last month\'s actuals as a baseline when setting new budgets']
  },
  {
    icon: '⇄', name: 'Requisitions', plan: 'Growth+', color: '#34d399',
    guide: 'Internal stock transfer from store to departments. Create a requisition with items and requested qty. Issue mode lets the store manager confirm actual qty issued. Issued requisitions appear as a "Requisitioned" column in the Stock Summary.',
    tips: ['Save as Draft first, then Issue when stock is physically transferred', 'Requisitioned qty is tracked separately in the Stock Summary — keep it up to date']
  },
  {
    icon: '◌', name: 'Dead Stock', plan: 'Growth+', color: '#34d399',
    guide: 'Identifies items with zero usage (Dead) or usage below 20% of available stock (Slow Movers). Shows value at risk per item. Filter by status or category. Helps reduce over-purchasing and expiry losses.',
    tips: ['Review dead stock monthly — items here repeatedly are candidates for removal', 'Value at Risk = closing stock qty × per UOM rate']
  },
  {
    icon: '◇', name: 'Recipe Margin', plan: 'Growth+', color: '#34d399',
    guide: 'Contribution margin report per menu item. Shows (Selling Price − Food Cost) × Qty Sold. Sort by Total Contribution, Margin per Portion, or FC%. Filter by category. "Only recipes with sales" toggle hides unordered items. Footer shows weighted average FC% across all sold items.',
    tips: ['Focus on high-volume items with low contribution — they hurt profitability most', 'Weighted avg FC% at the bottom reflects your true blended food cost']
  },
  {
    icon: '★', name: 'Best Sellers', plan: 'Growth+', color: '#34d399',
    guide: 'Ranks menu items by revenue, volume, or margin. Shows Top 10 and Bottom 10 tables plus a bar chart. Filter by category. Helps identify what to promote and what to reconsider.',
    tips: ['Use "By Margin" view to find items that sell well but contribute less profit', 'Bottom 10 by volume with high FC% = candidates for menu removal']
  },
  {
    icon: '☑', name: 'Purchase Orders', plan: 'Growth+', color: '#34d399',
    guide: 'Create and manage purchase orders to send to vendors before stock arrives. POs can be drafted, approved, and marked as received. Maintains a proper procurement trail ahead of Purchases entries.',
    tips: ['Raise a PO before the vendor delivers to keep procurement organised', 'Match the received PO against the actual invoice when entering Purchases']
  },
  // === Pro ===
  {
    icon: '≋', name: 'Period Comparison', plan: 'Pro', color: '#818cf8',
    guide: 'Compare key metrics across multiple periods. Shows Net Purchases, Wastage, COGS, Revenue, and FC% per period with vs-previous trend arrows (↑↓). Select last 6, 12, 24, or all periods.',
    tips: ['Look for seasonal FC% spikes — often signals menu pricing hasn\'t kept up with ingredient costs', 'Use the 12-period view for annual budget planning']
  },
  {
    icon: '⊕', name: 'Shrinkage Report', plan: 'Pro', color: '#818cf8',
    guide: 'Multi-period analysis of actual vs theoretical usage per item. Flags items with consistent over-use across periods. Status: Consistent / Occasional / Once / Clear. Helps identify systematic waste or theft.',
    tips: ['Consistent shrinkage on a high-value item over 3+ periods is a serious red flag', 'Use alongside the Variance Report for a complete picture of stock losses']
  },
  {
    icon: '⬡', name: 'Menu Engineering', plan: 'Pro', color: '#818cf8',
    guide: 'Classifies menu items into Star / Puzzle / Plowhouse / Dog based on profitability and popularity. FC% cutoff is 35%; volume cutoff is median qty sold. Sub-recipes are excluded from this analysis.',
    tips: ['Stars = high margin + high volume → protect and promote', 'Dogs = low margin + low volume → consider removing from the menu']
  },
  {
    icon: '⊗', name: 'FIFO / Expiry', plan: 'Pro', color: '#818cf8',
    guide: 'Tracks stock on a first-in, first-out basis. Shows remaining qty per purchase batch, net of returns, with purchase date and expiry. Fully returned batches are hidden. Helps prioritise use of oldest stock to minimise expiry losses.',
    tips: ['Check FIFO weekly for perishables — don\'t wait until month end', 'Set expiry dates in the Purchases entry for accurate FIFO tracking']
  },
  {
    icon: '⊙', name: 'Vendor Report', plan: 'Pro', color: '#818cf8',
    guide: 'Net spend per vendor with columns for Gross, Returns, Net, % of total, average per day, and payment method breakdown (Cash / Credit / FonePay). Search by vendor name or code.',
    tips: ['Sort by Net to find your top suppliers — good candidates for negotiating credit terms', '% of Net shows vendor concentration risk']
  },
  {
    icon: '◫', name: 'Supplier Price Tracker', plan: 'Pro', color: '#818cf8',
    guide: 'Shows rate history per item per vendor with trend arrows (↑↓→). "Update Rate" syncs the item master to the latest purchase rate. Warns (⚠) if the master rate differs >5% from the last purchase.',
    tips: ['Run this monthly after entering purchases — catch price creep early', '"Update Rate" overwrites the item master rate, which affects all future recipe costs']
  },
  {
    icon: '⊞', name: 'Overheads', plan: 'Pro', color: '#818cf8',
    guide: 'Three-tab entry: Fixed Overheads, Labor Costs, and Tax & Fees. Generates a P&L Summary, Break-Even analysis, and Cost per Cover. Overhead allocation appears in each recipe\'s detail view as True Cost and True Net Margin.',
    tips: ['Update overheads monthly — fixed costs rarely change but labour does', 'Cost per Cover requires accurate cover count — enter it in the overhead form']
  },
  {
    icon: '△', name: 'Theoretical Variance', plan: 'Pro', color: '#818cf8',
    guide: 'Advanced variance analysis that isolates theoretical food cost vs actual, broken down by category. Deeper drill-down than the standard Variance Report. Compare against budget for a complete financial picture.',
    tips: ['Items with both high theoretical and high actual usage → recipe portion sizes may need revision', 'Use alongside Budget vs Actual for the most complete picture']
  },
]

const GLOSSARY = [
  { term: 'Food Cost %', def: 'Cost of ingredients used ÷ Revenue × 100. The primary profitability metric for F&B operations. Industry benchmark: 28–35%.' },
  { term: 'COGS', def: 'Cost of Goods Sold. Opening Stock + Purchases − Wastage − Closing Stock. The actual cost of ingredients consumed in the period.' },
  { term: 'Per UOM Rate', def: 'Cost per single unit of measure. If 1 KG of chicken costs NPR 700, the per UOM rate is NPR 0.70 per gram.' },
  { term: 'Theoretical Usage', def: 'What should have been used based on qty sold × recipe ingredient qty. Calculated from sales entries and recipes.' },
  { term: 'Actual Usage', def: 'What was actually used: Opening Stock + Purchases − Closing Stock − Wastage.' },
  { term: 'Variance', def: 'Actual Usage − Theoretical Usage. Positive variance = more used than expected. Indicates waste, theft, or over-portioning.' },
  { term: 'FIFO', def: 'First In, First Out. Use oldest stock before newer stock. Critical for perishables to minimise expiry waste.' },
  { term: 'Opening Stock', def: 'Quantity of each ingredient at the start of the period (carried over from previous month closing stock).' },
  { term: 'Closing Stock', def: 'Physical count of each ingredient at the end of the period.' },
  { term: 'Conversion Factor', def: 'How many base units are in one purchase unit. E.g. 1 case = 24 bottles → conversion factor = 24.' },
  { term: 'BS Calendar', def: 'Bikram Sambat calendar used in Nepal. The system works natively in BS months.' },
  { term: 'Par Level', def: 'Minimum stock quantity before reordering. Used in the Reorder Report to flag items running low.' },
]

const STARTER_FEATURES = [
  'Dashboard & KPI overview',
  'Periods (BS calendar)',
  'Item Master with unit conversion',
  'Vendor management',
  'Purchases & vendor returns',
  'Stock count (opening / closing / wastage / staff meals)',
  'Mobile app — installable PWA, offline stock counting',
  'Sales entry (bulk or daily)',
  'Payment summary (Cash / Credit / FonePay)',
  'Monthly summary & COGS by category',
  'Annual summary (BS fiscal year rollup)',
  'Reorder report & par levels',
  'VAT & Non-VAT reports',
  'Wastage report with Excel export',
  'Settings & customisation',
]
const GROWTH_EXTRAS = [
  'Recipe costing & live FC%',
  'Variance report (theoretical vs actual)',
  'Outstanding payables with aging buckets',
  'Budget vs Actual per category',
  'Internal requisitions (store to department)',
  'Dead stock & slow mover detection',
  'Recipe contribution margin report',
  'Best & worst sellers analysis',
  'Purchase orders',
  'Staff meals tracking',
]
const PRO_EXTRAS = [
  'Period comparison (6 / 12 / 24 / All periods)',
  'Shrinkage report (multi-period consistency)',
  'Menu engineering (Star / Puzzle / Dog)',
  'FIFO / expiry batch tracking',
  'Vendor spend report',
  'Supplier price tracker & rate alerts',
  'Overheads, P&L, and break-even analysis',
  'Theoretical variance (advanced drill-down)',
]
const PRICE_PLANS = [
  { name: 'Starter', icon: '◎', color: '#c9a84c', badge: '1 Month Free', badgeBg: '#c9a84c',               monthly: 5000,  annual: 3750, features: STARTER_FEATURES, highlight: false, cta: 'Start Free Trial' },
  { name: 'Growth',  icon: '◈', color: '#34d399', badge: 'Most Popular',   badgeBg: 'rgba(52,211,153,0.9)', monthly: 8000,  annual: 6000, features: GROWTH_EXTRAS,   highlight: true,  cta: 'Get Growth' },
  { name: 'Pro',     icon: '⬡', color: '#818cf8', badge: 'Full Suite',     badgeBg: '#818cf8',               monthly: 12000, annual: 9000, features: PRO_EXTRAS,      highlight: false, cta: 'Get Pro' },
]

const FAQ = [
  { q: 'Why is my food cost % so high?', a: 'Common causes: purchases entered without closing stock (inflates COGS), over-portioning, wastage not recorded, theft, or supplier price increases not reflected in selling prices. Check the Variance Report to identify the biggest leaks.' },
  { q: 'What if I forgot to enter a purchase?', a: 'Go to Purchases, select the correct period, and add the entry with the correct day. The system recalculates everything automatically.' },
  { q: 'How do I correct a wrong entry?', a: 'Every entry has an Edit button. Click it, correct the values, and save. No need to delete and re-enter.' },
  { q: 'Why does my Variance Report show no theoretical usage?', a: 'Either you have not entered Sales Entries for the period, or the items have no Recipe built. Both are needed for theoretical usage to calculate.' },
  { q: 'Can two staff members enter data at the same time?', a: 'Yes. The system is cloud-based and supports multiple users simultaneously.' },
  { q: 'What happens to data when I close a period?', a: 'Closing a period locks it from further editing. All data is preserved permanently. You can view closed period reports at any time.' },
  { q: 'How do I add a new menu item to recipe costing?', a: 'Go to Recipe Costing → New Recipe. Add ingredients from your Item Master with qty per portion. The system calculates food cost instantly.' },
]

export default function Help() {
  const [activeSection, setActiveSection] = useState('guide')
  const [expandedModule, setExpandedModule] = useState(null)
  const [expandedFaq, setExpandedFaq] = useState(null)
  const [pricingAnnual, setPricingAnnual] = useState(false)
  const { settings } = useSettings()
  const navigate = useNavigate()
  const phone   = settings?.contact_phone   || ''
  const email   = settings?.contact_email   || ''
  const website = settings?.contact_website || ''

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Help & Guide</h1>
        <p className="page-subtitle">How to use every feature — glossary, FAQ, and tips</p>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 28, borderBottom: '1px solid #2a2f3d' }}>
        {[
          { id: 'guide', label: 'Getting Started' },
          { id: 'modules', label: 'Module Guide' },
          { id: 'glossary', label: 'Glossary' },
          { id: 'faq', label: 'FAQ' },
          { id: 'pricing', label: '💎 Pricing' },
        ].map(s => (
          <button key={s.id} onClick={() => setActiveSection(s.id)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '10px 20px', fontSize: 13, fontWeight: 500,
            color: activeSection === s.id ? '#c9a84c' : '#6b7280',
            borderBottom: activeSection === s.id ? '2px solid #c9a84c' : '2px solid transparent',
            marginBottom: -1
          }}>{s.label}</button>
        ))}
      </div>

      {/* GETTING STARTED */}
      {activeSection === 'guide' && (
        <div>

          {/* Welcome */}
          <div className="card" style={{ marginBottom: 16, background: 'rgba(201,168,76,0.03)', borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⬡</span>
              <div>
                <h3 style={{ margin: '0 0 8px', fontSize: 15, color: '#e8e0d0' }}>Welcome to Crest Inventory</h3>
                <p style={{ margin: '0 0 8px', fontSize: 13, color: '#6b7280', lineHeight: 1.75 }}>
                  Crest tracks your ingredient purchases, stock levels, and food cost in real time. The core idea is simple:
                </p>
                <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#c9a84c', fontWeight: 600 }}>Opening Stock + Purchases − Wastage − Closing Stock = COGS (what you actually used)</span>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280', lineHeight: 1.75 }}>
                  Follow the steps below to get set up. First-time setup takes about 30–60 minutes. After that, the monthly routine takes 15–20 minutes of admin at month end.
                </p>
              </div>
            </div>
          </div>

          {/* First-Time Setup */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: '#e8e0d0' }}>First-Time Setup</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280' }}>Do this once when you first log in. Takes 30–60 minutes.</p>
            {[
              {
                step: 1, title: 'Add your Ingredients', route: 'Item Master',
                desc: 'Go to Item Master → add every ingredient you buy. Each item needs a name, category, unit of measure (UOM), pack size, and rate per pack.',
                why: 'Every purchase and stock count is linked to items here. You cannot enter purchases without items.',
              },
              {
                step: 2, title: 'Add your Vendors', route: 'Vendors',
                desc: 'Go to Vendors → add all your suppliers.',
                why: 'Every purchase must be linked to a vendor. Add at least one before entering any purchase.',
              },
              {
                step: 3, title: 'Create your first Period', route: 'Periods',
                desc: 'Go to Periods → New Period → select the current BS year and month → Create.',
                why: 'All purchases, stock, and sales live inside a period. Nothing can be entered without an open period.',
              },
              {
                step: 4, title: 'Enter Opening Stock', route: 'Stock Count',
                desc: 'Go to Stock Count → Opening Stock tab → enter the quantity of each ingredient you have right now.',
                why: 'COGS calculation starts from opening stock. Skip this and your food cost % will be wrong for the first month.',
              },
              {
                step: 5, title: 'Build your Recipes', route: 'Recipe Costing', plan: 'Growth+',
                desc: 'Go to Recipe Costing → New Recipe → add each menu item with its ingredients and selling price.',
                why: 'Required for the Variance Report and food cost % per dish. Skip this step if you are on the Starter plan.',
              },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid #2a2f3d' : 'none' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#c9a84c', flexShrink: 0 }}>{s.step}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#e8e0d0' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: '#818cf8', background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.2)', padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 6 }}>{s.desc}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ color: '#c9a84c', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{s.why}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Monthly Workflow */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: '#e8e0d0' }}>Monthly Workflow</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280' }}>Repeat this every BS month. Steps 1–4 are ongoing during the month; steps 5–9 happen at month end.</p>
            {[
              { step: 1, title: 'Open a new Period',            desc: 'Periods → New Period → select BS month → Create. Do this on day 1 of the month.' },
              { step: 2, title: 'Enter Opening Stock',           desc: 'Stock Count → Opening Stock tab → enter qty for each item. For month 2 onward, this auto-carries from last month\'s closing.' },
              { step: 3, title: 'Record Purchases as they arrive', desc: 'Purchases → Add Purchase → enter vendor, item, qty, rate, payment method. Enter each bill on the day it arrives.' },
              { step: 4, title: 'Record Wastage as it happens',  desc: 'Stock Count → Wastage tab → log any spoilage or discards on the day.' },
              { step: 5, title: 'Enter Sales', plan: 'Starter+',  desc: 'Sales Entry → enter qty sold per menu item. Use Bulk Entry if you have a POS or month-end tally.' },
              { step: 6, title: 'Physical Stock Count',           desc: 'On the last day: print the Stock Count Sheet (Stock → Print Sheet), do a physical walk of your storeroom, enter counts in Stock Count → Closing Stock.' },
              { step: 7, title: 'Review Monthly Summary',        desc: 'Monthly Summary → check food cost %, COGS per category, and revenue. Export to Excel for management.' },
              { step: 8, title: 'Review Variance Report', plan: 'Growth+', desc: 'Variance → sort by NPR value → investigate any item with >10% variance. High variance = waste, theft, or over-portioning.' },
              { step: 9, title: 'Close the Period',              desc: 'Periods → Close → confirm. Locks all data. Closing stock automatically becomes opening stock for next month.' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid #1e2330' : 'none' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#0f1117', border: '1px solid #2a2f3d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#c9a84c', flexShrink: 0 }}>{s.step}</div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: '#818cf8', background: 'rgba(129,140,248,0.1)', border: '1px solid rgba(129,140,248,0.2)', padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Common Mistakes */}
          <div className="card" style={{ borderColor: 'rgba(248,113,113,0.15)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#e8e0d0' }}>Common Mistakes to Avoid</h3>
            {[
              { icon: '✕', text: 'Closing a period before entering closing stock — your COGS will be inflated with no closing offset.' },
              { icon: '✕', text: 'Skipping opening stock in month 1 — your food cost % will be artificially high.' },
              { icon: '✕', text: 'Entering all purchases at month end from memory — enter them daily from the actual invoice for an accurate rate and vendor record.' },
              { icon: '✕', text: 'Ignoring the Variance Report — if you don\'t check it, waste and over-portioning go undetected for months.' },
              { icon: '✕', text: 'Using estimated closing stock — always do a physical count. Estimated numbers make every report inaccurate.' },
            ].map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < 4 ? 10 : 0 }}>
                <span style={{ color: '#f87171', fontSize: 12, flexShrink: 0, marginTop: 1 }}>{m.icon}</span>
                <span style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>{m.text}</span>
              </div>
            ))}
          </div>

        </div>
      )}

      {/* MODULE GUIDE */}
      {activeSection === 'modules' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {MODULES.map(mod => (
            <div key={mod.name} className="card" style={{ cursor: 'pointer', padding: '0' }}>
              <div
                onClick={() => setExpandedModule(expandedModule === mod.name ? null : mod.name)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 16, color: mod.color }}>{mod.icon}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#e8e0d0' }}>{mod.name}</span>
                  {mod.plan && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 8,
                      color: mod.plan === 'Pro' ? '#818cf8' : mod.plan === 'Growth+' ? '#34d399' : '#9ca3af',
                      background: mod.plan === 'Pro' ? 'rgba(129,140,248,0.1)' : mod.plan === 'Growth+' ? 'rgba(52,211,153,0.1)' : 'rgba(156,163,175,0.1)',
                      border: `1px solid ${mod.plan === 'Pro' ? 'rgba(129,140,248,0.25)' : mod.plan === 'Growth+' ? 'rgba(52,211,153,0.25)' : 'rgba(156,163,175,0.25)'}`,
                    }}>{mod.plan}</span>
                  )}
                </div>
                <span style={{ color: '#9ca3af', fontSize: 16 }}>{expandedModule === mod.name ? '▲' : '▼'}</span>
              </div>
              {expandedModule === mod.name && (
                <div style={{ padding: '0 20px 20px', borderTop: '1px solid #2a2f3d' }}>
                  <p style={{ fontSize: 13, color: '#6b7280', marginTop: 16, lineHeight: 1.7 }}>{mod.guide}</p>
                  <div style={{ marginTop: 12 }}>
                    <p style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Tips</p>
                    {mod.tips.map((tip, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                        <span style={{ color: '#c9a84c', fontSize: 12, marginTop: 1 }}>→</span>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>{tip}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* GLOSSARY */}
      {activeSection === 'glossary' && (
        <div className="card">
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '30%' }}>Term</th>
                <th>Definition</th>
              </tr>
            </thead>
            <tbody>
              {GLOSSARY.map(g => (
                <tr key={g.term}>
                  <td style={{ fontWeight: 700, color: '#c9a84c' }}>{g.term}</td>
                  <td style={{ color: '#6b7280', lineHeight: 1.6 }}>{g.def}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* PRICING */}
      {activeSection === 'pricing' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <h2 style={{ fontSize: 20, margin: '0 0 8px', fontFamily: 'Georgia, serif', color: '#e8e0d0' }}>Plans & Pricing</h2>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>Choose the plan that fits your property</p>
            <div style={{ display: 'inline-flex', background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, padding: 3, gap: 2 }}>
              <button onClick={() => setPricingAnnual(false)} style={{ background: !pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border: !pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color: !pricingAnnual ? '#c9a84c' : '#6b7280', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Monthly</button>
              <button onClick={() => setPricingAnnual(true)}  style={{ background:  pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border:  pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color:  pricingAnnual ? '#c9a84c' : '#6b7280', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                Annual <span style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)', color: '#34d399', fontSize: 9, padding: '2px 7px', borderRadius: 8, fontWeight: 700 }}>Save 25%</span>
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {PRICE_PLANS.map(plan => (
              <div key={plan.name} className="card" style={{ border: plan.highlight ? '1px solid rgba(201,168,76,0.45)' : '1px solid #2a2f3d', position: 'relative', display: 'flex', flexDirection: 'column', padding: '32px 22px 22px', boxShadow: plan.highlight ? '0 4px 32px rgba(201,168,76,0.07)' : 'none' }}>
                <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: plan.badgeBg, color: '#0f1117', fontSize: 9, fontWeight: 800, padding: '3px 12px', borderRadius: 8, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                  {plan.badge}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 18, color: plan.color }}>{plan.icon}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>{plan.name}</span>
                </div>

                <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #2a2f3d' }}>
                  {plan.name === 'Starter' && !pricingAnnual ? (
                    <>
                      <div style={{ fontSize: 10, color: '#c9a84c', fontWeight: 800, marginBottom: 4, letterSpacing: '0.07em' }}>FREE FOR 1 MONTH</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#e8e0d0' }}>NPR {plan.monthly.toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280' }}>/mo after</span></div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#e8e0d0' }}>NPR {(pricingAnnual ? plan.annual : plan.monthly).toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280' }}>/mo</span></div>
                      {pricingAnnual && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Billed annually · NPR {((pricingAnnual ? plan.annual : plan.monthly) * 12).toLocaleString()}/yr</div>}
                    </>
                  )}
                </div>

                {plan.name !== 'Starter' && (
                  <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {plan.name === 'Growth' ? '+ Everything in Starter' : '+ Everything in Growth'}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                  {plan.features.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                      <span style={{ color: plan.color, fontSize: 12, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <span style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.4 }}>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Contact to upgrade */}
          <div className="card" style={{ borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, color: '#e8e0d0' }}>Ready to upgrade?</h3>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Contact your Crest consultant to change your plan.</p>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {phone   && <a href={`tel:${phone}`}   style={{ color: '#c9a84c', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>📞 {phone}</a>}
                {email   && <a href={`mailto:${email}`} style={{ color: '#c9a84c', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>✉ {email}</a>}
                {website && <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" style={{ color: '#c9a84c', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>🌐 {website}</a>}
                {!phone && !email && !website && <span style={{ fontSize: 13, color: '#9ca3af' }}>Contact your Crest consultant to upgrade.</span>}
                <button onClick={() => navigate('/pricing')} style={{ background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.3)', color: '#c9a84c', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  View full pricing page →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FAQ */}
      {activeSection === 'faq' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {FAQ.map((item, i) => (
            <div key={i} className="card" style={{ padding: 0, cursor: 'pointer' }}>
              <div onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: '#e8e0d0' }}>{item.q}</span>
                <span style={{ color: '#9ca3af', fontSize: 14 }}>{expandedFaq === i ? '▲' : '▼'}</span>
              </div>
              {expandedFaq === i && (
                <div style={{ padding: '0 20px 16px', borderTop: '1px solid #2a2f3d' }}>
                  <p style={{ fontSize: 13, color: '#6b7280', marginTop: 12, lineHeight: 1.7 }}>{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
