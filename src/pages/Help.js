import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'

// ── IMS feature data, grouped by plan tier ───────────────────────────────────
const IMS_TIERS = [
  {
    tier: 'core', label: 'Core — All Plans', planLabel: null, planColor: '#6b7280',
    features: [
      {
        icon: '◎', name: 'Dashboard',
        guide: 'The home screen. Shows KPI cards for the current open period: total purchases, revenue, food cost %, net margin, and top wastage. Figures update live as you add purchases, stock counts, and sales. Admin sees a platform overview; clients see their property dashboard.',
        tips: ['COGS and FC% are only accurate after closing stock is entered', 'If no open period exists, go to Periods and create one first', 'Dashboard figures always reflect the current open period']
      },
      {
        icon: '◷', name: 'Periods',
        guide: 'Create one period per BS month. A period must be open before you can enter purchases, stock, or sales. Close a period at month end to lock the data. Closing stock auto-carries to next month opening. Periods older than 12 months are archived by default.',
        tips: ['Always create a new period before the month starts', 'Close the period only after entering closing stock', 'Use "Show Archived" in Periods to access old months']
      },
      {
        icon: '≡', name: 'Item Master',
        guide: 'Your ingredient database. Every item needs a name, category, UOM (unit of measure), and rate. The system calculates Per UOM Rate automatically. Set conversion factors if you buy in bulk packs but consume in smaller units (e.g. 1 CTN = 24 BTL).',
        tips: ['Use consistent UOMs — GM for solids, ML for liquids', 'Set conversion factor if 1 case = 24 bottles etc.', 'Deactivate items you no longer use — do not delete them']
      },
      {
        icon: '⊙', name: 'Vendors',
        guide: 'Add all your suppliers here. Linking purchases to vendors lets you track spend per supplier and identify price trends over time. Vendors can be set Active or Inactive.',
        tips: ['Add all vendors before starting purchase entries', 'Inactive vendors are hidden from purchase dropdowns but their data is preserved']
      },
      {
        icon: '↓', name: 'Purchases',
        guide: 'Record every ingredient purchase here. Select the item, vendor, day of month, quantity, rate, and payment method (Cash/Credit/FonePay). The rate auto-fills from the item master but can be overridden. Use the Returns tab to log items sent back to suppliers.',
        tips: ['Enter purchases daily from the actual invoice — not from memory at month end', 'Always enter the actual invoice rate if it differs from the master rate', 'Add invoice reference number for audit trail', 'Returns auto-inherit rate and vendor from the original purchase']
      },
      {
        icon: '⊞', name: 'Stock Count',
        guide: 'Tabs: Opening Stock (start of month), Closing Stock (physical count at month end), Wastage (spoilage during the month), and Staff Meals (Growth+ only — internal consumption by staff). The Summary tab computes Used = Opening + Net Purchases − Wastage − Staff Meals − Closing. Export to Excel.',
        tips: ['Print the Stock Count Sheet and do a physical walk before entering closing stock', 'Enter opening stock before any purchases for accurate COGS', 'Wastage should be recorded as it happens, not estimated at month end', 'Staff Meals tab only appears on Growth plan and above']
      },
      {
        icon: '◉', name: 'Mobile App',
        guide: 'Crest Inventory can be installed on any smartphone — no app store required. On Android, open in Chrome and tap "Add to Home Screen". On iPhone, open in Safari, tap Share, and choose "Add to Home Screen". The app works offline: visit Stock Count once connected to cache all items, then count stock in the storeroom with no signal. Entries sync automatically when you reconnect.',
        tips: ['Open the app online at the start of each shift to refresh the cache', 'An amber "Offline" banner appears at the top when you have no connection', 'Cards with a dashed amber border are waiting to sync', 'Reinstall the app after a major update to ensure the latest version is cached']
      },
    ]
  },
  {
    tier: 'starter', label: 'Starter Plan', planLabel: 'Starter', planColor: '#9ca3af',
    features: [
      {
        icon: '↑', name: 'Sales Entry',
        guide: 'Record total qty sold per menu item for the period. Only items with a recipe appear here. Revenue is calculated automatically from selling price × qty sold. Use Bulk Entry for monthly POS totals.',
        tips: ['Sales data is required for the Variance Report to calculate theoretical usage', 'Sub-recipes are excluded — only top-level recipes appear here', 'You can update sales entries any time while the period is open']
      },
      {
        icon: '◎', name: 'Payment Summary',
        guide: 'Breaks down total revenue by payment method — Cash, Credit, and FonePay. Shows gross sales, returns, and net per method with a daily breakdown for the selected period.',
        tips: ['Match this against your POS or daily cash counts for reconciliation', 'Revenue here comes from Sales Entry — make sure sales are entered first']
      },
      {
        icon: '◻', name: 'Monthly Summary',
        guide: 'The month-end financial report. Shows opening stock, purchases, wastage, closing stock, and COGS by category. Food cost % is calculated against sales revenue. Export to Excel for your accountant or management review.',
        tips: ['FC% benchmark for cafes: 28–35%', 'A high purchase-based FC% vs actual FC% gap often indicates closing stock errors', 'Share this report with ownership every month end']
      },
      {
        icon: '⟳', name: 'Annual Summary',
        guide: 'Rollup of all monthly periods in a BS fiscal year. See full-year COGS, purchases, wastage, and food cost % at a glance. Select any BS year from the dropdown.',
        tips: ['Use this to identify which months consistently run high food cost', 'Compare annual FC% year-over-year to spot long-term trends']
      },
      {
        icon: '⚑', name: 'Reorder Report',
        guide: 'Flags items running below their par level. Theoretical stock = Opening + Net Purchases − Wastage − Usage. Set par levels inline on the report. "✕ Clear All Par" resets all par levels at once.',
        tips: ['Set par levels based on supplier lead time × daily usage rate', 'Review the reorder report weekly, not just at month end']
      },
      {
        icon: '⊛', name: 'VAT Report',
        guide: 'Summarises input VAT on purchases. Toggle the VAT-inclusive flag per purchase entry in the Purchases page. Shows total VAT paid per period for use in your IRD VAT return.',
        tips: ['Only purchases marked as VAT-inclusive are counted in the VAT total', 'Match this against your supplier VAT invoices before filing']
      },
      {
        icon: '⊘', name: 'Non-VAT Report',
        guide: 'Lists all purchases from non-VAT registered vendors. Useful for accounting and for separating VAT vs non-VAT purchase records.',
        tips: ['Non-VAT purchases are those not marked as VAT-inclusive in the Purchases entry']
      },
      {
        icon: '⚠', name: 'Wastage Report',
        guide: 'Detailed breakdown of all wastage entered during the period. Shows total value, item count, and top category. Filter by category. Export to Excel or print for management review.',
        tips: ['Sort by value to identify highest-cost wastage items', 'High wastage on the same item repeatedly signals a process or portioning problem']
      },
      {
        icon: '◧', name: 'Settings',
        guide: 'Configure your outlet details — business name, location, VAT number, contact phone, email, and website. These appear on printed sheets and reports. Also set thresholds for FC% warnings and item codes. Theme tab lets you switch between Dark and Light mode.',
        tips: ['Set the correct contact details — they appear in the Help page footer for staff', 'Only admins can change settings for a client account']
      },
    ]
  },
  {
    tier: 'growth', label: 'Growth Plan', planLabel: 'Growth', planColor: '#34d399',
    features: [
      {
        icon: '◈', name: 'Recipe Costing',
        guide: 'Build your menu items with ingredients and qty per portion. Food cost % is calculated live from latest purchase rates. Enter selling price (incl. VAT) to see margin and get a suggested price at your target FC%. Sub-recipes can be nested inside parent recipes.',
        tips: ['FC% below 30% = excellent, 30–38% = acceptable, above 38% = needs review', 'Update recipes when ingredient prices change significantly', 'Use the overhead panel in each recipe\'s detail view to see true cost after fixed cost allocation']
      },
      {
        icon: '△', name: 'Variance Report',
        guide: 'Compares theoretical usage (sales × recipe qty) against actual usage (opening + purchases − closing − wastage). Positive variance means more was used than sold — indicating waste, theft, or over-portioning. Items with >10% variance are flagged.',
        tips: ['Sort by NPR value to prioritise the biggest leaks', 'Items with no recipe show actual usage only — no theoretical comparison', 'Review this every month before closing the period']
      },
      {
        icon: '₿', name: 'Outstanding Payables',
        guide: 'Tracks all credit purchases that have not been paid. Groups payables by vendor with aging buckets: Current / 31–60 / 61–90 / 90+ days. Mark individual entries as paid directly from this report.',
        tips: ['Anything in the 61–90 day bucket needs immediate follow-up with finance', 'Mark Paid once the vendor is settled — it removes the entry from the outstanding list']
      },
      {
        icon: '◑', name: 'Budget vs Actual',
        guide: 'Set monthly purchase budgets per category and compare against actual spend. Shows variance in NPR and % with status badges (On Track / Over / Under). Budgets are editable inline directly on the report.',
        tips: ['Set budgets at the start of each month before purchases begin', 'Use last month\'s actuals as a baseline when setting new budgets']
      },
      {
        icon: '⇄', name: 'Requisitions',
        guide: 'Internal stock transfer from store to departments. Create a requisition with items and requested qty. Issue mode lets the store manager confirm actual qty issued. Issued requisitions appear as a "Requisitioned" column in the Stock Summary.',
        tips: ['Save as Draft first, then Issue when stock is physically transferred', 'Requisitioned qty is tracked separately in the Stock Summary — keep it up to date']
      },
      {
        icon: '◌', name: 'Dead Stock',
        guide: 'Identifies items with zero usage (Dead) or usage below 20% of available stock (Slow Movers). Shows value at risk per item. Filter by status or category. Helps reduce over-purchasing and expiry losses.',
        tips: ['Review dead stock monthly — items here repeatedly are candidates for removal', 'Value at Risk = closing stock qty × per UOM rate']
      },
      {
        icon: '◇', name: 'Recipe Margin',
        guide: 'Contribution margin report per menu item. Shows (Selling Price − Food Cost) × Qty Sold. Sort by Total Contribution, Margin per Portion, or FC%. "Only recipes with sales" toggle hides unordered items. Footer shows weighted average FC% across all sold items.',
        tips: ['Focus on high-volume items with low contribution — they hurt profitability most', 'Weighted avg FC% at the bottom reflects your true blended food cost']
      },
      {
        icon: '★', name: 'Best Sellers',
        guide: 'Ranks menu items by revenue, volume, or margin. Shows Top 10 and Bottom 10 tables plus a bar chart. Filter by category. Helps identify what to promote and what to reconsider.',
        tips: ['Use "By Margin" view to find items that sell well but contribute less profit', 'Bottom 10 by volume with high FC% = candidates for menu removal']
      },
      {
        icon: '☑', name: 'Purchase Orders',
        guide: 'Create and manage purchase orders to send to vendors before stock arrives. POs can be drafted, approved, and marked as received. Maintains a proper procurement trail ahead of Purchases entries.',
        tips: ['Raise a PO before the vendor delivers to keep procurement organised', 'Match the received PO against the actual invoice when entering Purchases']
      },
      {
        icon: '⊞', name: 'Staff Meals Tracking',
        guide: 'A dedicated Staff Meals tab appears in Stock Count (Growth plan and above). Track food consumed by staff or given as complimentary — kept separate from wastage so it doesn\'t inflate your spoilage numbers. Staff meals are deducted from COGS separately in the Monthly Summary.',
        tips: ['Record staff meals daily, not at month end, for accurate COGS tracking', 'Separate from Wastage so management can see both figures independently']
      },
    ]
  },
  {
    tier: 'pro', label: 'Pro Plan', planLabel: 'Pro', planColor: '#818cf8',
    features: [
      {
        icon: '≋', name: 'Period Comparison',
        guide: 'Compare key metrics across multiple periods. Shows Net Purchases, Wastage, COGS, Revenue, and FC% per period with vs-previous trend arrows (↑↓). Select last 6, 12, 24, or all periods.',
        tips: ['Look for seasonal FC% spikes — often signals menu pricing hasn\'t kept up with ingredient costs', 'Use the 12-period view for annual budget planning']
      },
      {
        icon: '⊕', name: 'Shrinkage Report',
        guide: 'Multi-period analysis of actual vs theoretical usage per item. Flags items with consistent over-use across periods. Status: Consistent / Occasional / Once / Clear. Helps identify systematic waste or theft.',
        tips: ['Consistent shrinkage on a high-value item over 3+ periods is a serious red flag', 'Use alongside the Variance Report for a complete picture of stock losses']
      },
      {
        icon: '⬡', name: 'Menu Engineering',
        guide: 'Classifies menu items into Star / Puzzle / Plowhouse / Dog based on profitability and popularity. FC% cutoff is 35%; volume cutoff is median qty sold. Sub-recipes are excluded from this analysis.',
        tips: ['Stars = high margin + high volume → protect and promote', 'Dogs = low margin + low volume → consider removing from the menu']
      },
      {
        icon: '⊗', name: 'FIFO / Expiry',
        guide: 'Tracks stock on a first-in, first-out basis. Shows remaining qty per purchase batch, net of returns, with purchase date and expiry. Fully returned batches are hidden. Helps prioritise use of oldest stock to minimise expiry losses.',
        tips: ['Check FIFO weekly for perishables — don\'t wait until month end', 'Set expiry dates in the Purchases entry for accurate FIFO tracking']
      },
      {
        icon: '⊙', name: 'Vendor Report',
        guide: 'Net spend per vendor with columns for Gross, Returns, Net, % of total, average per day, and payment method breakdown (Cash / Credit / FonePay). Search by vendor name or code.',
        tips: ['Sort by Net to find your top suppliers — good candidates for negotiating credit terms', '% of Net shows vendor concentration risk']
      },
      {
        icon: '◫', name: 'Supplier Price Tracker',
        guide: 'Shows rate history per item per vendor with trend arrows (↑↓→). "Update Rate" syncs the item master to the latest purchase rate. Warns (⚠) if the master rate differs >5% from the last purchase.',
        tips: ['Run this monthly after entering purchases — catch price creep early', '"Update Rate" overwrites the item master rate, which affects all future recipe costs']
      },
      {
        icon: '⊞', name: 'Overheads',
        guide: 'Three-tab entry: Fixed Overheads, Labor Costs, and Tax & Fees. Generates a P&L Summary, Break-Even analysis, and Cost per Cover. Overhead allocation appears in each recipe\'s detail view as True Cost and True Net Margin.',
        tips: ['Update overheads monthly — fixed costs rarely change but labour does', 'Cost per Cover requires accurate cover count — enter it in the overhead form']
      },
      {
        icon: '△', name: 'Theoretical Variance',
        guide: 'Advanced variance analysis that isolates theoretical food cost vs actual, broken down by category. Deeper drill-down than the standard Variance Report. Compare against budget for a complete financial picture.',
        tips: ['Items with both high theoretical and high actual usage → recipe portion sizes may need revision', 'Use alongside Budget vs Actual for the most complete picture']
      },
    ]
  },
]

// ── HR feature data ───────────────────────────────────────────────────────────
const HR_FEATURES = [
  {
    icon: '👤', name: 'Employees',
    guide: 'The Employee Master for Crest HR. Add and manage all staff — personal details, employment type, department, join date, and status (Active / Probation / Resigned / Terminated). Four tabs per employee: Personal (name, NID, date of birth, phone, address, emergency contact), Employment (type, department, designation, dates), Salary (basic salary, allowances, deductions with live net preview), and Bank / SSF (bank name, account number, branch, SSF number). Dashboard HR stat cards show Total Employees, Active count, and combined basic payroll/month.',
    tips: ['Employee code is auto-generated (EMP-001) — do not change it after payroll records are created', 'SSF contribution uses the standard 11% employee + 20% employer split, computed on basic salary capped at NPR 100,000/month', 'Probation employees are included in the active headcount and payroll total', 'HR module must be enabled by your admin before the Employees page appears in your sidebar']
  },
  {
    icon: '₿', name: 'Salary Structure',
    guide: 'Per-employee monthly salary breakdown. On each employee\'s Salary tab, set basic salary then add Allowances (Housing, Transport, Medical, Food, etc.) and Deductions (CIT/PF, advances) — each as a fixed NPR amount or a percentage of basic. SSF Employee (11%) is added automatically. The live Monthly Summary shows Gross Earnings → Deductions → Net Salary. The Salary Structure page lists every employee with Basic / Allowances / Gross / Deductions / Net / Employer SSF, plus payroll totals and an Excel export.',
    tips: ['Set Pay Basis to Monthly for salaried staff, or Daily / Hourly for wage workers — daily/hourly pay is calculated later from attendance in Payroll', 'SSF is computed on basic salary capped at NPR 100,000 — the cap is applied automatically', 'Minimum wage is NPR 19,550/month (12,170 basic) for full-time staff, NPR 754/day, or NPR 101/hour (107 part-time) — a warning appears below the minimum', 'Nepal Labour Act requires basic salary to be at least 60% of gross — an amber warning appears if it is lower', 'Use "Split from gross salary" to enter a total figure and auto-split it into basic and allowances', 'Employer SSF (20%) is paid by the company and is not deducted from the employee\'s net salary', 'Income tax / TDS is not deducted here yet — it will arrive in a future Crest HR update']
  },
  {
    icon: '🗓️', name: 'Attendance',
    guide: 'Daily attendance per BS month. The Mark Attendance tab lets you pick a day and set each employee\'s status (Present, Half-day, Absent, Paid/Unpaid Leave, Weekly Off, Holiday), plus hours worked (for hourly staff) and overtime hours. Saturdays are auto-defaulted to Weekly Off; use the quick buttons to mark the whole team Present, Weekly Off, or Holiday in one click. The Month Summary tab shows a colour-coded grid of the whole month with per-employee totals, and exports to Excel. Attendance is the data source the upcoming Payroll module uses to calculate actual pay for daily and hourly workers and to apply overtime.',
    tips: ['Pick the day, set statuses, then click Save Day — each day is saved as a complete set for all active employees', 'Saturdays default to Weekly Off (Nepal standard) — change anyone who actually worked', 'Public holidays are marked manually — use the "All Holiday" button or set Holiday per employee', 'The Hours column only appears for hourly-paid employees; OT hours can be entered for anyone', 'Overtime is captured here and paid at 1.5× the normal hourly rate during the payroll run', 'Only active and probation employees appear on the sheet']
  },
  {
    icon: '🏖️', name: 'Leave',
    guide: 'Tracks leave entitlements, requests, and balances. New clients start with Nepal\'s Labour Act 2074 leave types pre-loaded — Home/Annual (18 days), Sick (12), Bereavement (13), Maternity (98), Paternity (15), and Unpaid — which an admin can edit on the Leave Types tab. Record a request on the Requests tab (employee, type, BS start/end dates, reason); the system counts working days only, excluding Saturdays. An admin approves or rejects: approving automatically marks those days in Attendance as Paid or Unpaid Leave for the matching month, so Payroll deducts unpaid leave on its own. The Balances tab shows each employee\'s used / quota per leave type for the year, with an Excel export.',
    tips: ['Six Nepal Labour Act leave types are seeded automatically the first time you open the page', 'Leave is counted in working days — Saturdays (weekly off) are never deducted from the balance', 'Approving a request writes the Attendance rows for you; rejecting or cancelling an approved request reverts those days to Present', 'A matching monthly Period must exist for the leave dates — if not, approval warns you which month to create, then re-approve', 'Unpaid leave flows into Payroll as an absence deduction; paid leave does not reduce pay', 'Maternity (98 days) and Paternity (15) are per-event statutory entitlements, not annual quotas', 'Carry-forward is recorded for reference but unused days do not yet roll over automatically']
  },
  {
    icon: '💵', name: 'Payroll',
    guide: 'Runs monthly payroll for a BS period by combining each employee\'s salary structure with their attendance. Click Generate Payroll to create a draft register: monthly staff get basic + allowances minus SSF, unpaid-absence deductions, and other deductions; daily/hourly staff are paid for actual days/hours worked; everyone gets overtime at 1.5×. Edit TDS (income tax) inline while the run is a draft, Regenerate to pull the latest salary and attendance, then Finalize to lock the payslips as a permanent record. Each employee has a printable payslip, and the whole register exports to Excel.',
    tips: ['Mark attendance for the period first — payroll reads present days, hours, and overtime from it', 'A run is Draft until you Finalize it — finalized payslips are frozen even if you later change a salary', 'SSF (11% employee / 20% employer) is applied only to employees who have an SSF number on file', 'Unpaid-absence deduction = basic ÷ days in the BS month × unpaid days', 'TDS (income tax) is computed automatically from the fiscal-year tax slabs using year-to-date projection — finalize earlier months first so each month builds on the last; you can still override a value while the run is a draft', 'SSF contributors get the 1% first-slab social security tax waived, so most staff under roughly NPR 83,000/month gross pay zero income tax', 'Use the Payslip button on any row to view and print an individual payslip']
  },
  {
    icon: '📊', name: 'HR Reports',
    guide: 'Turns a finalized payroll run into the documents you file and pay with. Four reports per period: Payroll Summary (totals + employer cost, broken down by department), SSF Challan (per-employee 11% + 20% = 31% to deposit with the Social Security Fund), Bank Transfer / Salary Disbursement (each employee\'s bank, account number, and net pay), and TDS Report (income tax this period plus year-to-date). Every report exports to Excel; the bank list also exports to CSV for upload to your bank.',
    tips: ['Finalize the payroll run first — reports read finalized payslips (a draft shows an amber warning but still previews)', 'SSF Challan lists only employees with an SSF number and shows the grand total to deposit', 'Bank Transfer flags employees missing bank name or account number in amber — fix them on the Employee record', 'The bank file uses generic columns (Name, Bank, Account No, Amount) that work for manual upload to any bank', 'TDS YTD sums income tax across all finalized months of the current fiscal year', 'Every report prints cleanly — use your browser\'s print to PDF for a filing copy']
  },
  {
    icon: '🎉', name: 'Festival Allowance',
    guide: 'Issues the annual festival bonus (Dashain / पर्व खर्च) that Nepal law requires — broadly one month\'s basic salary per year. Pick the BS year and festival name, then Generate: monthly staff get one month\'s basic pro-rated by how long they\'ve worked (basic × months ÷ 12), so a half-year employee gets roughly half. Daily and hourly staff start at zero — you enter their amount manually. Review and edit amounts, Finalize to lock the record, and export a register or a bank-transfer file (Excel/CSV) to pay it.',
    tips: ['Generate computes one month\'s basic, pro-rated by months worked toward the festival (capped at 12 months)', 'Recent joiners are automatically pro-rated — a 6-month employee gets about half a month\'s basic', 'Daily/hourly staff default to 0 — enter a figure based on their typical earnings', 'Amounts are editable while the run is a draft; Finalize locks it as a permanent record', 'Export the bank file (generic Name / Bank / Account / Amount columns) to disburse the bonus', 'Festival allowance is taxable income, but no tax is withheld here yet — it is recorded as a gross payment']
  },
]

// ── Tier unlock logic ─────────────────────────────────────────────────────────
function isTierUnlocked(tier, plan, isAdmin) {
  if (isAdmin) return true
  if (tier === 'core' || tier === 'starter') return true
  if (tier === 'growth') return plan === 'growth' || plan === 'pro'
  if (tier === 'pro')    return plan === 'pro'
  return false
}

// ── Glossary ──────────────────────────────────────────────────────────────────
const GLOSSARY = [
  { term: 'Food Cost %',      def: 'Cost of ingredients used ÷ Revenue × 100. The primary profitability metric for F&B operations. Industry benchmark: 28–35%.' },
  { term: 'COGS',             def: 'Cost of Goods Sold. Opening Stock + Purchases − Wastage − Staff Meals − Closing Stock. The actual cost of ingredients consumed in the period.' },
  { term: 'Per UOM Rate',     def: 'Cost per single unit of measure. If 1 KG of chicken costs NPR 700, the per UOM rate is NPR 0.70 per gram.' },
  { term: 'Theoretical Usage', def: 'What should have been used based on qty sold × recipe ingredient qty. Calculated from sales entries and recipes.' },
  { term: 'Actual Usage',     def: 'What was actually used: Opening Stock + Purchases − Closing Stock − Wastage.' },
  { term: 'Variance',         def: 'Actual Usage − Theoretical Usage. Positive variance = more used than expected. Indicates waste, theft, or over-portioning.' },
  { term: 'FIFO',             def: 'First In, First Out. Use oldest stock before newer stock. Critical for perishables to minimise expiry waste.' },
  { term: 'Opening Stock',    def: 'Quantity of each ingredient at the start of the period (carried over from previous month closing stock).' },
  { term: 'Closing Stock',    def: 'Physical count of each ingredient at the end of the period.' },
  { term: 'Conversion Factor', def: 'How many base units are in one purchase unit. E.g. 1 case = 24 bottles → conversion factor = 24.' },
  { term: 'BS Calendar',      def: 'Bikram Sambat calendar used in Nepal. The system works natively in BS months.' },
  { term: 'Par Level',        def: 'Minimum stock quantity before reordering. Used in the Reorder Report to flag items running low.' },
  { term: 'SSF',              def: 'Social Security Fund (सामाजिक सुरक्षा कोष). Nepal mandatory contribution: 11% employee + 20% employer of basic salary.' },
]

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
]
const GROWTH_EXTRAS = [
  'Recipe Costing & Live FC%',
  'Variance Report (Theoretical vs Actual)',
  'Outstanding Payables with Aging Buckets',
  'Budget vs Actual per Category',
  'Internal Requisitions (Store to Department)',
  'Dead Stock & Slow Mover Detection',
  'Recipe Contribution Margin Report',
  'Best & Worst Sellers Analysis',
  'Purchase Orders',
  'Staff Meals Tracking',
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
  const { imsEnabled, hrEnabled, plan, isAdmin } = useAuth()
  const [activeSection, setActiveSection]         = useState('guide')
  const [expandedModule, setExpandedModule]       = useState(null)
  const [expandedFaq, setExpandedFaq]             = useState(null)
  const [pricingAnnual, setPricingAnnual]         = useState(false)
  const { settings } = useSettings()
  const navigate = useNavigate()
  const phone   = settings?.contact_phone   || ''
  const email   = settings?.contact_email   || ''
  const website = settings?.contact_website || ''

  // Shared expandable card used for unlocked features
  function FeatureCard({ feat, moduleKey }) {
    const key = `${moduleKey}:${feat.name}`
    const isOpen = expandedModule === key
    return (
      <div className="card" style={{ padding: 0, marginBottom: 6, cursor: 'pointer' }}>
        <div
          onClick={() => setExpandedModule(isOpen ? null : key)}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 15, width: 22, textAlign: 'center', flexShrink: 0 }}>{feat.icon}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>{feat.name}</span>
          </div>
          <span style={{ color: '#9ca3af', fontSize: 13 }}>{isOpen ? '▲' : '▼'}</span>
        </div>
        {isOpen && (
          <div style={{ padding: '0 18px 16px', borderTop: '1px solid #2a2f3d' }}>
            <p style={{ fontSize: 13, color: '#6b7280', marginTop: 14, lineHeight: 1.75 }}>{feat.guide}</p>
            {feat.tips?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Tips</p>
                {feat.tips.map((tip, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: '#c9a84c', fontSize: 11, marginTop: 2, flexShrink: 0 }}>→</span>
                    <span style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.6 }}>{tip}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Locked feature row — compact, non-expandable
  function LockedRow({ feat }) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px',
        background: '#181c27', border: '1px solid #1e2330', borderRadius: 8, marginBottom: 4,
        opacity: 0.45,
      }}>
        <span style={{ fontSize: 14, width: 22, textAlign: 'center', flexShrink: 0 }}>{feat.icon}</span>
        <span style={{ fontSize: 13, color: '#9ca3af' }}>{feat.name}</span>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Help & Guide</h1>
        <p className="page-subtitle">How to use every feature — glossary, FAQ, and tips</p>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 28, borderBottom: '1px solid #2a2f3d' }}>
        {[
          { id: 'guide',   label: 'Getting Started' },
          { id: 'modules', label: 'Module Guide' },
          { id: 'glossary', label: 'Glossary' },
          { id: 'faq',     label: 'FAQ' },
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

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: '#e8e0d0' }}>First-Time Setup</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280' }}>Do this once when you first log in. Takes 30–60 minutes.</p>
            {[
              { step: 1, title: 'Add your Ingredients', desc: 'Go to Item Master → add every ingredient you buy. Each item needs a name, category, unit of measure (UOM), pack size, and rate per pack.', why: 'Every purchase and stock count is linked to items here. You cannot enter purchases without items.' },
              { step: 2, title: 'Add your Vendors', desc: 'Go to Vendors → add all your suppliers.', why: 'Every purchase must be linked to a vendor. Add at least one before entering any purchase.' },
              { step: 3, title: 'Create your first Period', desc: 'Go to Periods → New Period → select the current BS year and month → Create.', why: 'All purchases, stock, and sales live inside a period. Nothing can be entered without an open period.' },
              { step: 4, title: 'Enter Opening Stock', desc: 'Go to Stock Count → Opening Stock tab → enter the quantity of each ingredient you have right now.', why: 'COGS calculation starts from opening stock. Skip this and your food cost % will be wrong for the first month.' },
              { step: 5, title: 'Build your Recipes', desc: 'Go to Recipe Costing → New Recipe → add each menu item with its ingredients and selling price.', why: 'Required for the Variance Report and food cost % per dish. Skip this step if you are on the Starter plan.', plan: 'Growth+' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid #2a2f3d' : 'none' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#c9a84c', flexShrink: 0 }}>{s.step}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#e8e0d0' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
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

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: '#e8e0d0' }}>Monthly Workflow</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: '#6b7280' }}>Repeat this every BS month. Steps 1–4 are ongoing during the month; steps 5–9 happen at month end.</p>
            {[
              { step: 1, title: 'Open a new Period',               desc: 'Periods → New Period → select BS month → Create. Do this on day 1 of the month.' },
              { step: 2, title: 'Enter Opening Stock',              desc: 'Stock Count → Opening Stock tab → enter qty for each item. For month 2 onward, this auto-carries from last month\'s closing.' },
              { step: 3, title: 'Record Purchases as they arrive',  desc: 'Purchases → Add Purchase → enter vendor, item, qty, rate, payment method. Enter each bill on the day it arrives.' },
              { step: 4, title: 'Record Wastage as it happens',     desc: 'Stock Count → Wastage tab → log any spoilage or discards on the day.' },
              { step: 5, title: 'Enter Sales',                      desc: 'Sales Entry → enter qty sold per menu item. Use Bulk Entry if you have a POS or month-end tally.', plan: 'Starter+' },
              { step: 6, title: 'Physical Stock Count',             desc: 'On the last day: print the Stock Count Sheet (Stock → Print Sheet), do a physical walk of your storeroom, enter counts in Stock Count → Closing Stock.' },
              { step: 7, title: 'Review Monthly Summary',           desc: 'Monthly Summary → check food cost %, COGS per category, and revenue. Export to Excel for management.' },
              { step: 8, title: 'Review Variance Report',           desc: 'Variance → sort by NPR value → investigate any item with >10% variance. High variance = waste, theft, or over-portioning.', plan: 'Growth+' },
              { step: 9, title: 'Close the Period',                 desc: 'Periods → Close → confirm. Locks all data. Closing stock automatically becomes opening stock for next month.' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid #1e2330' : 'none' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#0f1117', border: '1px solid #2a2f3d', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#c9a84c', flexShrink: 0 }}>{s.step}</div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: s.plan === 'Growth+' ? '#34d399' : '#9ca3af', background: s.plan === 'Growth+' ? 'rgba(52,211,153,0.1)' : 'rgba(156,163,175,0.1)', border: `1px solid ${s.plan === 'Growth+' ? 'rgba(52,211,153,0.2)' : 'rgba(156,163,175,0.2)'}`, padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ borderColor: 'rgba(248,113,113,0.15)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#e8e0d0' }}>Common Mistakes to Avoid</h3>
            {[
              'Closing a period before entering closing stock — your COGS will be inflated with no closing offset.',
              'Skipping opening stock in month 1 — your food cost % will be artificially high.',
              'Entering all purchases at month end from memory — enter them daily from the actual invoice for an accurate rate and vendor record.',
              'Ignoring the Variance Report — if you don\'t check it, waste and over-portioning go undetected for months.',
              'Using estimated closing stock — always do a physical count. Estimated numbers make every report inaccurate.',
            ].map((text, i, arr) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                <span style={{ color: '#f87171', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
                <span style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6 }}>{text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* MODULE GUIDE */}
      {activeSection === 'modules' && (
        <div>
          {/* ── Crest IMS ── */}
          {imsEnabled && (
            <div style={{ marginBottom: 32 }}>
              {/* Module header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid rgba(201,168,76,0.2)' }}>
                <span style={{ fontSize: 18, color: '#c9a84c' }}>▦</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>Crest IMS</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
                {!isAdmin && (
                  <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 4 }}>
                    {plan === 'pro' ? 'Pro Plan' : plan === 'growth' ? 'Growth Plan' : 'Starter Plan'}
                  </span>
                )}
              </div>

              {IMS_TIERS.map(tier => {
                const unlocked = isTierUnlocked(tier.tier, plan, isAdmin)
                return (
                  <div key={tier.tier} style={{ marginBottom: 20 }}>
                    {/* Tier label row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: tier.planColor, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {tier.label}
                      </span>
                      {!unlocked && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: tier.planColor, background: `${tier.planColor}15`, border: `1px solid ${tier.planColor}30`, padding: '1px 7px', borderRadius: 8 }}>
                          🔒 {tier.features.length} features locked
                        </span>
                      )}
                    </div>

                    {/* Features */}
                    {tier.features.map(feat =>
                      unlocked
                        ? <FeatureCard key={feat.name} feat={feat} moduleKey="ims" />
                        : <LockedRow key={feat.name} feat={feat} />
                    )}

                    {/* Upgrade nudge for locked tiers */}
                    {!unlocked && (
                      <div style={{
                        marginTop: 8, padding: '10px 14px',
                        background: `${tier.planColor}08`, border: `1px dashed ${tier.planColor}30`,
                        borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
                      }}>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>
                          Upgrade to <strong style={{ color: tier.planColor }}>{tier.planLabel}</strong> to unlock {tier.features.length} features
                        </span>
                        <button
                          onClick={() => navigate('/pricing')}
                          style={{ fontSize: 11, fontWeight: 700, color: tier.planColor, background: `${tier.planColor}15`, border: `1px solid ${tier.planColor}35`, borderRadius: 5, padding: '4px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
                        >
                          View plans →
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* ── Crest HR ── */}
          {hrEnabled && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid rgba(96,165,250,0.2)' }}>
                <span style={{ fontSize: 18, color: '#60a5fa' }}>👤</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: '#e8e0d0', fontFamily: 'Georgia, serif' }}>Crest HR</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Human Resources</span>
              </div>
              {HR_FEATURES.map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="hr" />
              ))}
            </div>
          )}

          {/* Neither module active */}
          {!imsEnabled && !hrEnabled && (
            <div className="card" style={{ textAlign: 'center', padding: '40px 24px', borderColor: 'rgba(107,114,128,0.2)' }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>⊘</div>
              <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 6 }}>No modules are currently active</div>
              <div style={{ fontSize: 12, color: '#4b5563' }}>Contact your Crest consultant to activate your subscription.</div>
            </div>
          )}
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

          <div className="card" style={{ borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, color: '#e8e0d0' }}>Ready to upgrade?</h3>
                <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Contact your Crest consultant to change your plan.</p>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {phone   && <a href={`tel:${phone}`}    style={{ color: '#c9a84c', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>📞 {phone}</a>}
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
