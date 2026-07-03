import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'

// ── IMS feature data, grouped by plan tier ───────────────────────────────────
const IMS_TIERS = [
  {
    tier: 'core', label: 'Core — All Plans', planLabel: null, planColor: 'var(--theme-text2)',
    features: [
      {
        icon: '◎', name: 'Dashboard',
        guide: 'The home screen. Shows KPI cards for the current open period: total purchases, revenue, food cost %, net margin, and top wastage. Figures update live as you add purchases, stock counts, and sales. Admin sees a platform overview; clients see their property dashboard.',
        tips: ['COGS and FC% are only accurate after closing stock is entered', 'If no open period exists, go to Periods and create one first', 'Dashboard figures always reflect the current open period', 'The "Daily Purchases vs Sales" chart overlays daily purchase spend (gold) with daily sales revenue (green). The green sales line only appears when you record sales day-by-day (Sales → pick a day); bulk monthly sales entry has no daily breakdown to plot. With 5+ days of daily sales in the current month, a dashed line projects revenue to month-end (trend estimate). Note: the gap between the lines is buying-vs-selling cash rhythm, not profit.']
      },
      {
        icon: '◷', name: 'Periods',
        guide: 'Create one period per BS month. A period must be open before you can enter purchases, stock, or sales. Close a period at month end to lock the data. Closing stock auto-carries to next month opening. Periods older than 12 months are archived by default.',
        tips: ['Always create a new period before the month starts', 'Close the period only after entering closing stock', 'Use "Show Archived" in Periods to access old months']
      },
      {
        icon: '≡', name: 'Item Master',
        guide: 'Your ingredient database. Every item needs a name, category, UOM (unit of measure), and rate. The system calculates Per UOM Rate automatically. Set conversion factors if you buy in bulk packs but consume in smaller units (e.g. 1 CTN = 24 BTL).',
        tips: ['Use consistent UOMs — GM for solids, ML for liquids', 'Set conversion factor if 1 case = 24 bottles etc.', 'Deactivate items you no longer use — do not delete them', 'Editing many items in a row? The Edit Item dialog has ← Prev / Next → buttons that save the current item and jump straight to the next one in the list (in the order shown), with an "X of Y" counter — no need to close and reopen. (Same on the Vendors edit dialog.)']
      },
      {
        icon: '⊙', name: 'Vendors',
        guide: 'Add all your suppliers here. Linking purchases to vendors lets you track spend per supplier and identify price trends over time. Vendors can be set Active or Inactive.',
        tips: ['Add all vendors before starting purchase entries', 'Inactive vendors are hidden from purchase dropdowns but their data is preserved']
      },
      {
        icon: '↓', name: 'Purchases',
        guide: 'Record every ingredient purchase here. Each bill has a header (vendor, day, invoice ref, discount, payment method) and one row per item. Per row: select item, enter qty and rate, tick VAT if this line attracts 13% VAT, optionally enter an expiry date or shelf-life days (expiry auto-fills from the bill date). Use the Returns tab to log items sent back to suppliers.',
        tips: ['Enter purchases daily from the actual invoice — not from memory at month end', 'Always enter the actual invoice rate if it differs from the master rate', 'Add invoice reference number for audit trail', 'VAT is per-line — tick only the items that are VAT-able on that invoice', 'Enter shelf-life days and the expiry date fills automatically from the bill date', 'Returns auto-inherit rate and vendor from the original purchase']
      },
      {
        icon: '⊞', name: 'Stock Count',
        guide: 'Tabs: Opening Stock (start of month), Closing Stock (physical count at month end), Wastage (a quick monthly catch-all total per item), Daily Wastage (log spoilage by day with a reason — Spoilage, Expiry, Over-prep, etc.), and Staff Meals (Growth+ only — internal consumption by staff). The Summary tab computes Used = Opening + Net Purchases − Wastage − Staff Meals − Closing, where Wastage = the monthly catch-all + all daily entries. Export to Excel.',
        tips: ['Use the Daily Wastage tab to log spoilage by day and reason as it happens — these roll into the period total and COGS', 'The Wastage tab is the monthly catch-all: a single quick figure per item, on top of any daily entries', 'Enter opening stock before any purchases for accurate COGS', 'The Wastage Report now groups by item and includes a By-Reason breakdown', 'Staff Meals tab only appears on Growth plan and above']
      },
      {
        icon: '◉', name: 'Mobile App',
        guide: 'Crest Inventory can be installed on any smartphone — no app store required. On Android, open in Chrome and tap "Add to Home Screen". On iPhone, open in Safari, tap Share, and choose "Add to Home Screen". The app works offline: visit Stock Count once connected to cache all items, then count stock in the storeroom with no signal. Entries sync automatically when you reconnect.',
        tips: ['Open the app online at the start of each shift to refresh the cache', 'An amber "Offline" banner appears at the top when you have no connection', 'Cards with a dashed amber border are waiting to sync', 'Reinstall the app after a major update to ensure the latest version is cached']
      },
    ]
  },
  {
    tier: 'starter', label: 'Starter Plan', planLabel: 'Starter', planColor: 'var(--theme-text3)',
    features: [
      {
        icon: '₨', name: 'Menu Pricing',
        guide: 'Internal pricing review tool. Shows all active menu items with their food cost, current menu price (VAT-inclusive), and FC%. Type a new VAT-inclusive price on any row to instantly see the new FC% and the price change — then hit Save to commit it to Recipe Costing. Use the On POS toggle to control which items appear on the POS order screen without deleting the recipe.',
        tips: ['Food cost is calculated live from current ingredient rates', 'The Change column shows + (price increase) or − (price decrease) vs current', 'FC% colours: green ≤30%, amber 31–38%, red >38%', 'Press Enter in the new-price field to save quickly', 'Saving updates the selling price in Recipe Costing — ex-VAT price is back-calculated automatically', 'Turn off On POS for seasonal or discontinued items — recipe history and costing are preserved', 'The POS order screen only shows items with On POS checked']
      },
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
        icon: '▤', name: 'Stock Report',
        guide: 'Your current inventory valuation: on-hand quantity and value (qty × rate) per item and category, with a total stock-value headline. On-hand uses your closing physical count if entered, otherwise a theoretical estimate (Opening + Net Purchases − Usage − Wastage − Staff Meals − Requisitioned). Flags Low (at/below par) and Out-of-stock items. Export to Excel or print.',
        tips: ['For an accurate valuation, enter a closing stock count — items then show a "Physical" badge instead of "Theor."', 'A negative-stock warning means usage/wastage exceeds recorded purchases — usually a missing purchase entry', 'Total Stock Value matches the Closing value in Stock Count → Summary for a counted period']
      },
      {
        icon: '⚑', name: 'Reorder Report',
        guide: 'Flags items running below their par level. Theoretical stock = Opening + Net Purchases − Wastage − Usage. Set par levels inline on the report. "✕ Clear All Par" resets all par levels at once. Book Stock is a separate, live column fed by Crest POS — every time a POS order is charged or marked Complimentary, the recipe is exploded into its raw ingredients (recursing through sub-recipes) and a depletion entry is recorded automatically. Book Stock shows "—" for items with no POS sales this period; it does not replace Current Stock, which still reflects manual Sales Entry too. Admins see a "✕ Clear Book Stock" button to wipe the ledger for the selected period back to "—" (e.g. to clear out bad test data) without touching physical counts or Current Stock.',
        tips: ['Set par levels based on supplier lead time × daily usage rate', 'Review the reorder report weekly, not just at month end', 'Book Stock only reflects POS-recorded sales/comps — if you also log sales manually, Current Stock is the more complete number']
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
    tier: 'growth', label: 'Growth Plan', planLabel: 'Growth', planColor: 'var(--theme-green)',
    features: [
      {
        icon: '◈', name: 'Recipe Costing',
        guide: 'Build your menu items with ingredients and qty per portion. Food cost % is calculated live from latest purchase rates. Enter selling price (incl. VAT) to see margin and get a suggested price at your target FC%. Sub-recipes can be nested inside parent recipes. With the Nutrition Facts add-on, each recipe also shows a per-portion nutrition label (energy, protein, carbs, fat, sugar, sodium) plus aggregated allergens. To add many recipes at once, use ↓ Template / ↑ Import Excel at the top of the recipe list; to copy an existing dish use the Clone button on its row.',
        tips: ['FC% below 30% = excellent, 30–38% = acceptable, above 38% = needs review', 'Update recipes when ingredient prices change significantly', 'Bulk import: click ↓ Template to download a spreadsheet (it includes a "Your Items" sheet with your exact item names, codes & units to copy from). Fill one row per ingredient — put the Menu Item name, Category, Selling Price & Yield on the recipe\'s first row, then leave those blank for its remaining ingredient rows. Ingredient column accepts an item name, item code, or sub-recipe name; Qty is in the item\'s unit (KG↔GM and LTR↔ML auto-convert). Upload with ↑ Import Excel — a preview shows which ingredients matched and lists any unmatched ones (they\'re skipped; add those items to the Item Master first, then re-import). Recipes that already exist and rows marked category "Sub-Recipe" are skipped.', 'Clone: the Clone button duplicates a recipe (named "… (Copy)") into the New Recipe form with all its ingredients — tweak and save. Great for menu variants.', 'Use the overhead panel in each recipe\'s detail view to see true cost after fixed cost allocation', 'Nutrition: while editing a recipe, each ingredient row has a Nutrition button — enter values per 100 GM/ML (or per piece) there, or use ⚡ Suggest from library (USDA / IFCT 2017 / Nepal), or 🔍 Fetch from Open Food Facts for branded/packaged items (search by name or barcode). Entered once per ingredient, it fills every recipe that uses it. Tip: the ⚡ Auto-fill nutrition button (Ingredients header) fills all matching ingredients from the library in one click. The recipe shows a data-coverage count; missing ingredients make the label an underestimate.', 'Use the "Find ingredient in recipes" box (top-right of the recipe list) to see every dish that uses an ingredient — it even matches ingredients hidden inside sub-recipes.']
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
        icon: '↗', name: 'Menu Repricing',
        guide: 'Finds dishes priced below their target food-cost %, and the price to charge to fix it. For each dish: current FC% vs Target FC%, the Suggested Menu Price (VAT-inclusive, rounded), the per-portion Price Gap, and the Monthly Opportunity (gap × qty sold). Sort by Monthly Opportunity, Price Gap, or "Most over target". The Dashboard "Menu Health" card summarises it.',
        tips: ['Reprice the biggest Monthly Opportunity items first — same cost, higher margin', 'Set each dish\'s Target FC% in Recipe Costing; the suggested price aims to hit it', 'Suggested Menu Price is VAT-inclusive (what you print); the Price Gap is ex-VAT']
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
        icon: '⬢', name: 'Menu Engineering',
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
    icon: '▦', name: 'HR Dashboard',
    guide: 'The HR command centre. Shows live headcount (active + probation), estimated basic payroll per month, pending leave requests, pending OT entries, advances outstanding, and employees retiring within 180 days. The payroll section summarises the last finalized run: net payable, employee SSF (11%), employer SSF (20%), and the total SSF challan amount to deposit — with the deposit deadline (15th of the following month). Pending leave requests and pending OT entries are listed below so you can click through to approve or reject without navigating away.',
    tips: [
      'All KPI cards are clickable — click any card to jump directly to the relevant page',
      'SSF challan total = employee 11% + employer 20% from the last finalized payroll run; deposit with SSF by the 15th of the following BS month',
      'Pending Leave and Pending OT count cards turn amber when items are waiting — clear them before running payroll so approved entries are included',
      'The Basic Payroll / Month figure is basic salary only; full payroll (allowances, SSF, TDS, OT) appears in the Last Finalized Payroll section after the first payroll run',
      '"Retiring Soon" counts active/probation employees whose retirement date (DOB + 60 years, from the Employee record) falls within 180 days — click to see them in the Employees list',
    ]
  },
  {
    icon: '👤', name: 'Employees',
    guide: 'The Employee Master for Crest HR. Add and manage all staff — personal details, employment type, department, join date, and status (Active / Probation / Resigned / Terminated). Four tabs per employee: Personal (name, NID, date of birth, phone, address, emergency contact), Employment (type, department, designation, dates), Salary (basic salary, allowances, deductions with live net preview), and Bank / SSF (bank name, account number, branch, SSF number). Dashboard HR stat cards show Total Employees, Active count, and combined basic payroll/month.',
    tips: ['Employee code is auto-generated (EMP-001) — do not change it after payroll records are created', 'SSF contribution uses the standard 11% employee + 20% employer split, computed on basic salary capped at NPR 100,000/month', 'Probation employees are included in the active headcount and payroll total', 'HR module must be enabled by your admin before the Employees page appears in your sidebar']
  },
  {
    icon: '⚙', name: 'Pay Setup',
    guide: 'Configure and review salary, allowances, deductions, SSF, and bank details for every employee — all in one place. Click any employee row to open the Pay Setup form with two tabs: Salary and Bank/SSF. The Salary tab has three dedicated fields — Basic Salary, Dearness Allowance (महँगी भत्ता), and Other Allowances — plus deductions. The live Monthly Summary on the right shows the full breakdown: Basic → Dearness → Other Allowances → Gross → SSF deduction → Net (Cash in Hand) → Cost to Company (CTC). The compliance panel checks all three Nepal minimums simultaneously. The Bank/SSF tab also has a Tax Deduction Declarations section where you enter the employee\'s annual life and health insurance premiums — these reduce taxable income before TDS is computed in Payroll. The summary table shows Basic / Allowances / Gross / Deductions / Net / Employer SSF with totals and an Excel export.',
    tips: ['Enter Basic Salary, Dearness Allowance, and Other Allowances as separate fields — dearness is stored and tracked independently per Nepal Labour Act', 'Nepal minimum wage (FY 2082/83): Basic ≥ NPR 12,170 · Dearness ≥ NPR 7,380 · Gross ≥ NPR 19,550/month — the compliance panel shows all three checks at once', 'SSF is computed on basic salary only (capped at NPR 100,000) — dearness and other allowances are excluded from the SSF base', 'Nepal Labour Act requires basic salary to be at least 60% of gross — an amber warning appears if it is lower', 'Insurance premium deductions (Tax Deduction Declarations): Life insurance up to NPR 40,000/year and health insurance up to NPR 20,000/year — enter the employee\'s annual declared premium amount; Payroll applies the cap automatically', 'Cost to Company (CTC) = Gross + Employer SSF (20%) — the blue CTC row shows the employer\'s true monthly outlay', 'Net (Cash in Hand) = Gross − SSF − other deductions; TDS is not pre-computed here — it is applied during the Payroll run', 'Bank details added here flow into payroll — employees without a bank account show an amber warning']
  },
  {
    icon: '🗓️', name: 'Attendance',
    guide: 'Daily attendance per BS month. The Mark Attendance tab lets you pick a day and set each employee\'s status (Present, Half-day, Absent, Paid/Unpaid Leave, Weekly Off, Holiday), plus hours worked (for hourly staff) and overtime hours. Saturdays are auto-defaulted to Weekly Off; use the quick buttons to mark the whole team Present, Weekly Off, or Holiday in one click. The Month Summary tab shows a colour-coded grid of the whole month with per-employee totals, and exports to Excel. Attendance is the data source the upcoming Payroll module uses to calculate actual pay for daily and hourly workers and to apply overtime.',
    tips: ['Pick the day, set statuses, then click Save Day — each day is saved as a complete set for all active employees', 'Saturdays default to Weekly Off (Nepal standard) — change anyone who actually worked', 'Public holidays are marked manually — use the "All Holiday" button or set Holiday per employee', 'The Hours column only appears for hourly-paid employees; OT hours can be entered for anyone', 'Overtime is captured here and paid at 1.5× the normal hourly rate during the payroll run', 'Only active and probation employees appear on the sheet']
  },
  {
    icon: '📋', name: 'Roster',
    guide: 'Plan weekly or monthly staff shifts. Two view modes: Monthly (pick a BS month, click any cell to assign a shift for that employee on that day) and Weekly (7-day grid centred on the selected week). Built-in shifts — Morning, Afternoon, Evening, Night, Full Day, Split — each colour-coded; right-click a cell for a quick action menu or click the + / × icons. An employee can have multiple shifts on the same day. The Shifts tab lets you customise shift names, times, and colours. Export to Excel to share or print the schedule.',
    tips: [
      'Plan the roster before the month starts — it helps forecast labour cost and avoids scheduling conflicts',
      'Roster is for planning only — Attendance is the official record that feeds payroll',
      'Right-click a cell (or use the inline icons) to assign or clear a shift quickly',
      'An employee can carry more than one shift on the same day — useful for split shifts',
      'The Shifts tab lets you rename and recolour any shift to match your venue\'s terminology',
      'Use Export Excel to share the printed schedule with department heads',
    ]
  },
  {
    icon: '🏖️', name: 'Leave',
    guide: 'Tracks leave entitlements, requests, and balances. New clients start with Nepal\'s Labour Act 2074 leave types pre-loaded — Home/Annual (18 days), Sick (12), Bereavement (13), Maternity (98), Paternity (15), and Unpaid — which an admin can edit on the Leave Types tab. Record a request on the Requests tab (employee, type, BS start/end dates, reason); the system counts working days only, excluding Saturdays. An admin approves or rejects: approving automatically marks those days in Attendance as Paid or Unpaid Leave for the matching month, so Payroll deducts unpaid leave on its own. The Balances tab shows each employee\'s used / quota per leave type for the year, with an Excel export.',
    tips: ['Six Nepal Labour Act leave types are seeded automatically the first time you open the page', 'Leave is counted in working days — Saturdays (weekly off) are never deducted from the balance', 'Approving a request writes the Attendance rows for you; rejecting or cancelling an approved request reverts those days to Present', 'A matching monthly Period must exist for the leave dates — if not, approval warns you which month to create, then re-approve', 'Unpaid leave flows into Payroll as an absence deduction; paid leave does not reduce pay', 'Maternity (98 days) and Paternity (15) are per-event statutory entitlements, not annual quotas', 'Carry-forward is recorded for reference but unused days do not yet roll over automatically']
  },
  {
    icon: '📆', name: 'Holiday Calendar',
    guide: 'Per-client list of Nepal public and optional holidays for each fiscal year. Two types: Public (gazetted by the Nepal government — all staff entitled to the day off; working on a public holiday attracts 2× overtime under the Nepal Labour Act) and Optional (floating holidays at employer discretion). Use "Seed Fixed" to add the 5 fixed-date gazetted holidays automatically (Constitution Day on Ashwin 3, Prithvi Narayan Shah\'s Birthday on Poush 27, Martyrs\' Day on Magh 5, National Democracy Day on Falgun 7, and Republic Day on Jestha 15). Movable holidays — Dashain, Tihar, Holi, Buddha Jayanti, Teej, Chhath, Eid-ul-Fitr, Eid-ul-Adha, and others — must be added manually each year from the Nepal government gazette, as their dates shift annually by the lunar calendar. Holidays are stored per fiscal year and scoped to each client.',
    tips: [
      '"Seed Fixed" adds only the 5 gazetted holidays with a fixed BS date every year — it skips any that already exist, so it is safe to click again after adding movable ones',
      'Movable holidays must be added manually each year: Dashain (7th-day through Vijaya Dashami), Tihar (Laxmi Puja + Mha Puja), Holi, Buddha Jayanti, Teej, Janai Purnima, Chhath, and Eid dates — check the Nepal government gazette annually',
      'FY selector groups holidays by fiscal year (Shrawan to Ashadh). Months 4–12 use the FY start BS year; months 1–3 use the following BS year — the "stored as BS year" hint in the form confirms which year a date maps to',
      'Public holidays feed into Overtime Management for automatic 2× rate suggestion when OT is logged on a holiday date',
      'Holiday Count stat cards show Public and Optional separately — Nepal Labour Act requires at least 13 days of public holiday leave per year',
    ]
  },
  {
    icon: '⏱', name: 'Overtime',
    guide: 'Log, approve, and track employee overtime — approved entries feed directly into the payroll run at the correct rate. Two rates apply under the Nepal Labour Act: Weekday OT at 1.5× the employee\'s normal hourly rate, and Public Holiday OT at 2×. When you log an OT entry and select the date, the system automatically detects whether that date is in your Holiday Calendar (gazetted public holidays) and pre-selects the correct type. Each entry goes through an approval flow: Pending → Approved (or Rejected). Only Approved entries are included when you Generate or Regenerate payroll — so you can log everything and approve only what is confirmed. An "Undo" button on any approved or rejected entry returns it to Pending.',
    tips: [
      'Log OT entries first, then approve after confirming with the employee and manager — only Approved entries flow into payroll',
      'Date auto-detects holiday type: if the date matches a gazetted public holiday in HR → Holiday Calendar, "Public Holiday (2×)" is pre-selected — you can still override manually',
      'After approving new OT entries, go to Payroll → Regenerate to include them in the current payroll run',
      'Attendance OT (captured in Attendance Sheet → OT Hours column) and Overtime entries are both included in payroll — they stack. Use OT entries for the formal approval trail; attendance OT for quick daily capture.',
      'The Pending Approval stat card is clickable — click it to filter the list to pending entries only',
      'Rejected entries are kept for the audit trail — they are NOT included in payroll and cannot be undone without clicking Undo first',
    ]
  },
  {
    icon: '💵', name: 'Payroll',
    guide: 'Runs monthly payroll for a BS period by combining each employee\'s salary structure with their attendance. Click Generate Payroll to create a draft register: monthly staff get basic + allowances minus SSF, unpaid-absence deductions, and other deductions; daily/hourly staff are paid for actual days/hours worked; everyone gets overtime at 1.5×. Edit TDS (income tax) inline while the run is a draft, Regenerate to pull the latest salary and attendance, then Finalize to lock the payslips as a permanent record. Each employee has a printable payslip, and the whole register exports to Excel.',
    tips: ['Mark attendance for the period first — payroll reads present days, hours, and overtime from it', 'A run is Draft until you Finalize it — finalized payslips are frozen even if you later change a salary', 'SSF (11% employee / 20% employer) is applied only to employees who have an SSF number on file', 'Unpaid-absence deduction = gross (basic + allowances) ÷ days in the BS month × unpaid days — an unpaid day forfeits the whole day\'s pay, and SSF is contributed on the basic actually earned',
'Record overtime in ONE place — either the attendance sheet\'s OT column or the Overtime module. Both are paid, so the same hours entered in both pay twice; the payroll register flags affected employees with an ⚠ OT ×2? badge', 'TDS (income tax) is computed automatically from the fiscal-year tax slabs using year-to-date projection — finalize earlier months first so each month builds on the last; you can still override a value while the run is a draft', 'SSF contributors get the 1% first-slab social security tax waived, so most staff under roughly NPR 83,000/month gross pay zero income tax', 'Use the Payslip button on any row to view and print an individual payslip']
  },
  {
    icon: '📊', name: 'HR Reports',
    guide: 'Turns a finalized payroll run into the documents you file and pay with. Five tabs: Payroll Summary (totals + employer cost by department), SSF Challan (per-employee 11% + 20% = 31% to deposit), Bank Transfer (each employee\'s bank and net pay), TDS Report (income tax this period + year-to-date), and TDS Certificate — a printable per-employee annual certificate for the whole fiscal year showing month-wise gross/SSF/TDS, taxable income computation (including insurance deductions), and signature blocks. Every report except TDS Certificate exports to Excel; the bank list also exports to CSV.',
    tips: ['Finalize the payroll run first — reports read finalized payslips (a draft shows an amber warning but still previews)', 'SSF Challan lists only employees with an SSF number and shows the grand total to deposit', 'Bank Transfer flags employees missing bank name or account number in amber — fix them on the Employee record', 'TDS YTD sums income tax across all finalized months of the current fiscal year', 'TDS Certificate: select fiscal year + employee — the certificate covers all finalized payslips for that employee in that FY; print it from the browser for a PDF copy', 'TDS Certificate shows the employer PAN line blank — fill it in by hand before handing to the employee (employer PAN is not stored in the system)', 'Employee PAN is shown on the certificate from the employee record — add it in HR → Employees if missing']
  },
  {
    icon: '💳', name: 'Advances & Loans',
    guide: 'Track salary advances (short-term, recovered in the next payslip) and employee loans (multi-month, with scheduled installments). Issue a new advance or loan from the top-right button — set the employee, type, issued date, total amount, and an optional monthly installment amount. When payroll is generated, each employee\'s active advance installments are automatically deducted from their net pay and appear as a named "Advance / Loan Recovery" line on the payslip. On Finalize, repayment rows are written to this ledger automatically — no manual entry needed. Click any row to open the detail panel to see the repayment history and a progress bar. When an advance is fully repaid, it is automatically marked as Settled.',
    tips: ['Advance = short-term, typically recovered in full next payslip. Loan = multi-month with a fixed installment.', 'Set an Installment/Month amount — payroll will deduct exactly that amount each month until the balance is cleared', 'If no installment amount is set, the full outstanding balance is deducted in the next payroll run', 'Repayment rows are written automatically when you Finalize a payroll — go to Advances & Loans to see the updated ledger', 'Reopening a finalized payroll reverses the auto-recorded repayments and reactivates any advances that were auto-settled', 'You can still record manual repayments (e.g. cash repayments outside payroll) using the detail panel', 'Use "Settle" to manually close out an advance — you\'ll get a warning if there is still an outstanding balance', 'You can delete an advance only if no repayments have been recorded against it'],
  },
  {
    icon: '🎉', name: 'Festival Allowance',
    guide: 'Issues the annual festival bonus (Dashain / पर्व खर्च) that Nepal law requires — broadly one month\'s basic salary per year. Pick the BS year and festival name, then Generate: monthly staff get one month\'s basic pro-rated by how long they\'ve worked (basic × months ÷ 12). Daily and hourly staff start at zero — enter amounts manually. TDS is computed at each employee\'s marginal income tax rate using actual YTD payroll data from the same fiscal year (falls back to salary projection if no payroll months are finalized yet). Both gross and TDS are editable while draft; Finalize to lock. Export a detailed register or a bank-transfer file (Excel/CSV) showing Gross, TDS, and Net Transfer columns.',
    tips: ['Generate computes one month\'s basic, pro-rated by months worked toward the festival (capped at 12 months)', 'Recent joiners are automatically pro-rated — a 6-month employee gets about half a month\'s basic', 'Daily/hourly staff default to 0 — enter a figure based on their typical earnings', 'TDS is computed at the marginal income tax rate using actual YTD payroll data — finalize earlier payroll months first for the most accurate figure', 'TDS column shows a "YTD" badge when real payslip data was used; without it, the figure is a projection from salary × 12', 'Override TDS inline for any employee while the run is a draft — the system recomputes automatically when you change the gross amount', 'Regenerate after finalizing new payroll months to refresh TDS with updated YTD figures', 'Net payout = gross − TDS; the bank export\'s "Net Transfer" column is what each employee receives', 'TDS withheld must be deposited with the IRD separately from regular monthly payroll TDS']
  },
  {
    icon: '💰', name: 'Gratuity',
    guide: 'Shows the total gratuity accrual liability for all active monthly-paid employees under the Nepal Labour Act. Gratuity accrues at 1 month\'s basic salary per year of service (basic ÷ 12 per month). It vests after 1 year of continuous service — employees with less than 12 months are shown as "Vesting." The SSF Covered column shows how much of the Labour Act liability has already been funded through the employer\'s SSF gratuity sub-fund (3.33% of capped basic per month). Net Liability = Labour Act Total − SSF Covered — this is the estimated additional cash you may need to pay on departure. Filter by vesting status or department; export to Excel.',
    tips: ['Only monthly-paid employees appear — daily/hourly gratuity is based on actual days worked and is computed at Final Settlement', 'The SSF gratuity sub-fund (3.33% of capped basic) reduces but may not fully cover the Labour Act obligation — consult your CA', 'Net Liability is an estimate; actual payment depends on the employee\'s exact last working day, which is computed on the Final Settlement page', 'Vested = ≥ 12 months of continuous service. Employees who resign before 1 year forfeit gratuity.', 'The "Monthly Accrual" stat card shows how fast your total gratuity pool is growing — useful for cash flow planning']
  },
  {
    icon: '🧾', name: 'Final Settlement',
    guide: 'Calculator for the full final-settlement payout when an employee resigns, is terminated, or retires. Select the employee and enter their last working date (BS calendar), unused annual leave days, whether they served their notice period, and whether festival allowance has been paid this FY. The calculator computes: partial-month salary (basic ÷ days in last BS month × days worked), leave encashment (basic ÷ 26 per day, Nepal Labour Act rate), gratuity (if ≥ 1 year service — shown net of the portion already funded through employer SSF contributions for enrolled staff), festival pro-ration (if not yet paid this FY), notice-period deduction (if notice was not served), advance recovery (outstanding balance auto-fetched), and estimated TDS on lump-sum components at the marginal income tax rate. Print a settlement statement for your records.',
    tips: ['Partial salary uses the actual day count of the last BS month — not 30 days — because BS months have 28–32 days', 'Leave encashment rate is basic ÷ 26 per day (Nepal Labour Act — 26 working days per month)', 'Gratuity is not paid if service is under 1 year; the vesting status is shown next to the employee name', 'Festival pro-ration is included only if you uncheck "Festival allowance paid this FY" — it covers Shrawan to last working month', 'TDS on lump sum is estimated at the marginal rate using annual basic as the income baseline — final tax may differ based on actual YTD income', 'Outstanding advances are auto-fetched; each is shown as a separate deduction line with its description', 'Use the Print button to generate a clean settlement statement — the input panel is hidden in print mode']
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
  { term: 'Book Stock',       def: 'Live stock count fed by Crest POS — decremented automatically on every POS sale/comp close, shown in the Reorder Report. Only reflects POS activity; physical stock count remains the source of truth.' },
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
  'Menu Repricing (Underpriced Dish Finder)',
  'Best & Worst Sellers Analysis',
  'Purchase Orders',
  'Staff Meals Tracking',
  'Nutrition Facts & Allergen Labels',
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
  { name: 'Starter', icon: '◎', color: 'var(--theme-accent)', badge: '1 Month Free', badgeBg: 'var(--theme-accent)',               monthly: 5000,  annual: 3750, features: STARTER_FEATURES, highlight: false, cta: 'Start Free Trial' },
  { name: 'Growth',  icon: '◈', color: 'var(--theme-green)', badge: 'Most Popular',   badgeBg: 'rgba(52,211,153,0.9)', monthly: 8000,  annual: 6000, features: GROWTH_EXTRAS,   highlight: true,  cta: 'Get Growth' },
  { name: 'Pro',     icon: '⬢', color: '#818cf8', badge: 'Full Suite',     badgeBg: '#818cf8',               monthly: 12000, annual: 9000, features: PRO_EXTRAS,      highlight: false, cta: 'Get Pro' },
]

const FAQ = [
  { q: 'How does the sidebar work? I have a lot of pages.', a: 'The sidebar has two parts: a narrow icon rail on the far left with one icon per module (Crest IMS, Crest HR, Crest POS), and a panel beside it showing only the selected module\'s pages. Click a module icon to switch panels — the panel also follows you automatically when you navigate (e.g. opening a POS page selects the POS panel). Inside the panel, pages are grouped by task (Operations, Costing, report categories) — click a group header to expand or collapse it; your choices are remembered on this device. The ‹ button near the bottom of the rail hides the panel entirely, leaving just the icon rail; Help and Sign out live on the rail too.' },
  { q: 'Why is my food cost % so high?', a: 'Common causes: purchases entered without closing stock (inflates COGS), over-portioning, wastage not recorded, theft, or supplier price increases not reflected in selling prices. Check the Variance Report to identify the biggest leaks.' },
  { q: 'What if I forgot to enter a purchase?', a: 'Go to Purchases, select the correct period, and add the entry with the correct day. The system recalculates everything automatically.' },
  { q: 'How do I correct a wrong entry?', a: 'Every entry has an Edit button. Click it, correct the values, and save. No need to delete and re-enter.' },
  { q: 'Why does my Variance Report show no theoretical usage?', a: 'Either you have not entered Sales Entries for the period, or the items have no Recipe built. Both are needed for theoretical usage to calculate.' },
  { q: 'Can two staff members enter data at the same time?', a: 'Yes. The system is cloud-based and supports multiple users simultaneously.' },
  { q: 'What happens to data when I close a period?', a: 'Closing a period locks it from further editing. All data is preserved permanently. You can view closed period reports at any time.' },
  { q: 'How do I add a new menu item to recipe costing?', a: 'Go to Recipe Costing → New Recipe. Add ingredients from your Item Master with qty per portion. The system calculates food cost instantly.' },
  { q: 'Why is there no sales line on the Dashboard "Purchases vs Sales" chart?', a: 'The sales line only plots when sales are recorded day-by-day. In Sales, pick a specific day and enter that day\'s quantities (rather than one bulk monthly total). Once a few days are entered, the green sales line appears, and with 5+ days in the current month a dashed month-end revenue projection is added. (When the POS module ships, it will feed daily sales automatically.)' },
  { q: 'Can I add many recipes at once instead of one line at a time?', a: 'Yes. In Recipe Costing, click ↓ Template to download a spreadsheet (one row per ingredient; recipe-level fields on the first row of each recipe). Fill it in Excel/Sheets — the template includes a "Your Items" sheet with your exact item names/codes/units to copy from — then click ↑ Import Excel. A preview shows what matched; unmatched ingredients are skipped (add those items to the Item Master first, then re-import). The ingredients must already exist as items because each item carries its own purchase rate and unit conversion. To copy a similar dish, use the Clone button on any recipe row.' },
  { q: 'Why won’t an item delete?', a: 'An item can only be hard-deleted if nothing references it. If it appears in any purchase, stock count, wastage, staff meal, requisition, vendor return, or recipe — even a zero-quantity one — the delete is blocked and you’ll see why. The best option is Hide: it removes the item from all lists and dropdowns while keeping its history intact. Admins also get a Force Delete option that erases the item and every record referencing it (this recalculates affected past reports and cannot be undone) — use it only for true duplicates/mistakes.' },
  { q: 'How do I quickly find an item in a long dropdown?', a: 'The item pickers in Purchases, Recipes, Stock’s Daily Wastage, and Requisitions are searchable — click the field and start typing to filter, then use ↑/↓ and Enter (or click) to choose. On Recipe Costing there is also a “Find ingredient in recipes” box that lists every recipe using a given ingredient, including ones where it’s inside a sub-recipe.' },
]

export default function Help() {
  const { imsEnabled, hrEnabled, posEnabled, plan, isAdmin } = useAuth()
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
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{feat.name}</span>
          </div>
          <span style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{isOpen ? '▲' : '▼'}</span>
        </div>
        {isOpen && (
          <div style={{ padding: '0 18px 16px', borderTop: '1px solid var(--theme-border)' }}>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginTop: 14, lineHeight: 1.75 }}>{feat.guide}</p>
            {feat.tips?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 10, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>Tips</p>
                {feat.tips.map((tip, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <span style={{ color: 'var(--theme-accent)', fontSize: 11, marginTop: 2, flexShrink: 0 }}>→</span>
                    <span style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{tip}</span>
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
        background: 'var(--theme-card)', border: '1px solid var(--theme-border-lt)', borderRadius: 8, marginBottom: 4,
        opacity: 0.45,
      }}>
        <span style={{ fontSize: 14, width: 22, textAlign: 'center', flexShrink: 0 }}>{feat.icon}</span>
        <span style={{ fontSize: 13, color: 'var(--theme-text3)' }}>{feat.name}</span>
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
      <div style={{ display: 'flex', gap: 4, marginBottom: 28, borderBottom: '1px solid var(--theme-border)' }}>
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
            color: activeSection === s.id ? 'var(--theme-accent)' : 'var(--theme-text2)',
            borderBottom: activeSection === s.id ? '2px solid var(--theme-accent)' : '2px solid transparent',
            marginBottom: -1
          }}>{s.label}</button>
        ))}
      </div>

      {/* GETTING STARTED */}
      {activeSection === 'guide' && (
        <div>
          <div className="card" style={{ marginBottom: 16, background: 'rgba(201,168,76,0.03)', borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⬢</span>
              <div>
                <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--theme-text1)' }}>Welcome to Crest Inventory</h3>
                <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                  Crest tracks your ingredient purchases, stock levels, and food cost in real time. The core idea is simple:
                </p>
                <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: 'var(--theme-accent)', fontWeight: 600 }}>Opening Stock + Purchases − Wastage − Closing Stock = COGS (what you actually used)</span>
                </div>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                  Follow the steps below to get set up. First-time setup takes about 30–60 minutes. After that, the monthly routine takes 15–20 minutes of admin at month end.
                </p>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>First-Time Setup</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Do this once when you first log in. Takes 30–60 minutes.</p>
            {[
              { step: 1, title: 'Add your Ingredients', desc: 'Go to Item Master → add every ingredient you buy. Each item needs a name, category, unit of measure (UOM), pack size, and rate per pack.', why: 'Every purchase and stock count is linked to items here. You cannot enter purchases without items.' },
              { step: 2, title: 'Add your Vendors', desc: 'Go to Vendors → add all your suppliers.', why: 'Every purchase must be linked to a vendor. Add at least one before entering any purchase.' },
              { step: 3, title: 'Create your first Period', desc: 'Go to Periods → New Period → select the current BS year and month → Create.', why: 'All purchases, stock, and sales live inside a period. Nothing can be entered without an open period.' },
              { step: 4, title: 'Enter Opening Stock', desc: 'Go to Stock Count → Opening Stock tab → enter the quantity of each ingredient you have right now.', why: 'COGS calculation starts from opening stock. Skip this and your food cost % will be wrong for the first month.' },
              { step: 5, title: 'Build your Recipes', desc: 'Go to Recipe Costing → New Recipe → add each menu item with its ingredients and selling price.', why: 'Required for the Variance Report and food cost % per dish. Skip this step if you are on the Starter plan.', plan: 'Growth+' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border)' : 'none' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent)', flexShrink: 0 }}>{s.step}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 6 }}>{s.desc}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--theme-accent)', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
                    <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.why}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>Monthly Workflow</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Repeat this every BS month. Steps 1–4 are ongoing during the month; steps 5–9 happen at month end.</p>
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
              <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent)', flexShrink: 0 }}>{s.step}</div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 10, fontWeight: 700, color: s.plan === 'Growth+' ? 'var(--theme-green)' : 'var(--theme-text3)', background: s.plan === 'Growth+' ? 'rgba(52,211,153,0.1)' : 'rgba(156,163,175,0.1)', border: `1px solid ${s.plan === 'Growth+' ? 'rgba(52,211,153,0.2)' : 'rgba(156,163,175,0.2)'}`, padding: '1px 7px', borderRadius: 8 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ borderColor: 'rgba(248,113,113,0.15)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
            {[
              'Closing a period before entering closing stock — your COGS will be inflated with no closing offset.',
              'Skipping opening stock in month 1 — your food cost % will be artificially high.',
              'Entering all purchases at month end from memory — enter them daily from the actual invoice for an accurate rate and vendor record.',
              'Ignoring the Variance Report — if you don\'t check it, waste and over-portioning go undetected for months.',
              'Using estimated closing stock — always do a physical count. Estimated numbers make every report inaccurate.',
            ].map((text, i, arr) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                <span style={{ color: 'var(--theme-red)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
                <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{text}</span>
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
                <span style={{ fontSize: 18, color: 'var(--theme-accent)' }}>▦</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest IMS</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
                {!isAdmin && (
                  <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginLeft: 4 }}>
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
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
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
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest HR</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Human Resources</span>
              </div>
              {HR_FEATURES.map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="hr" />
              ))}
            </div>
          )}

          {/* ── Crest POS ── */}
          {posEnabled && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid rgba(201,168,76,0.2)' }}>
                <span style={{ fontSize: 18, color: 'var(--theme-accent)' }}>⊕</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest POS</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Point of Sale</span>
              </div>
              {[
                {
                  icon: '🔐', name: 'POS Login', path: '/pos/login',
                  desc: 'The PIN entry screen that POS staff see when opening the system. Staff tap their name and enter their 4–6 digit PIN to access the POS. The Owner button (top-right) lets the property owner log in with their full email + password for manager-level access. Only staff with a POS role assigned appear on the screen.',
                  tips: [
                    'PINs are set or reset in POS → Staff — staff cannot change their own PIN',
                    'Only staff with a POS role assigned appear on the login screen; users without a role see nothing',
                    'Forgotten PIN? Go to POS → Staff → Reset PIN beside the staff member\'s name',
                    'The Owner login gives full access — share it only with trusted management',
                  ],
                },
                {
                  icon: '₨', name: 'Menu Pricing', path: '/menu-pricing',
                  desc: 'Build your menu directly here — no Item Master or IMS setup needed on a POS-only plan. + Add Item takes a name, category, VAT status, menu price, and an optional Cost Price (what you pay to buy/produce it). Use the On POS toggle to control what shows on the order screen without deleting the item.',
                  tips: [
                    'Cost Price is optional but recommended — on a POS-only plan there\'s no Item Master to link an ingredient to, so this is the only food-cost figure the system can ever have. It values the Complimentary Slip and the Comp column on Sales Exceptions instead of showing NPR 0',
                    'Click Edit next to any item to change its name, category, VAT, menu price, or Cost Price — same modal as Add Item, just pre-filled with the current values',
                    'Turn off On POS for seasonal or discontinued items — the item and its history are preserved, it just disappears from the order screen',
                    'Pair sets which items appear as quick "pair with" suggestions when staff tap this item while taking an order',
                  ],
                },
                {
                  icon: '⊞', name: 'Table Management', path: '/pos/tables',
                  desc: 'Set up your restaurant floor plan — create tables, assign them to sections (Main Hall, Bar, Outdoor), set capacity, and track status (Available / Occupied / Reserved / Inactive). The Ticket Routing tab lets you assign each recipe category to KOT (kitchen) or BOT (bar) so tickets print at the right station automatically. Requires Supervisor role or above.',
                  tips: [
                    'Click a status badge directly on the floor grid to cycle it — no need to open the editor',
                    'Use sections to group tables by area; the section filter tabs appear automatically once you have more than one section',
                    'Sort Order controls the display sequence within a section — use multiples of 10 (10, 20, 30) to leave room for reordering',
                    'Inactive status removes a table from active service without deleting it — useful for tables under repair or seasonal areas',
                    'Ticket Routing: go to the Ticket Routing tab to set which categories print at the kitchen (KOT) vs the bar (BOT). Default is Beverage → BOT, everything else → KOT',
                    'Quick Notes: add preset instruction chips (e.g. "No onion", "Extra spicy") in the Quick Notes tab — staff can tap them instead of typing when adding a note to an order item',
                    'HSC Codes: set an optional Harmonized System Code per item in the HSC Codes tab — only needed for items that are imported goods sold as-is (e.g. imported bottled drinks). Leave blank for freshly prepared dishes; prints on the bill if set',
                    'Discounts: customize the list of reasons staff can pick when applying a discount at Charge, in the Discounts tab — comes preloaded with common reasons (Loyalty customer, Manager goodwill, etc.), fully editable',
                  ],
                },
                {
                  icon: '🍽', name: 'Order Taking', path: '/pos/orders',
                  desc: 'Full-screen order entry. Tap a table from the floor plan to open it — enter covers, browse the menu by category, and tap items to add them. Pressing Send Order saves the order and automatically fires KOT and BOT tickets to their respective stations in one tap. For additions to an existing order, add the item (an amber +N badge shows the new quantity), then press KOT or BOT when ready to send just the additions.',
                  tips: [
                    'Send Order (new table) = save + auto-print KOT and BOT in one tap — no extra button presses needed',
                    'Update Order (existing table) = save only; use KOT/BOT buttons to send additions to the kitchen or bar',
                    'The amber +N badge on an item means that many extra have been added since the last ticket was sent',
                    'The green ✓ KOT / ✓ BOT badge means the ticket for that item has already been sent to the station',
                    'KOT and BOT badges on the buttons show how many unsent items are waiting to be sent',
                    'Configure which categories go to KOT vs BOT in Table Management → Ticket Routing',
                    'Every order gets a sequential order number (#1, #2, …) shown in the top bar and printed on each KOT/BOT ticket — kitchen, bar and bill all reference the same number',
                    'Printed tickets carry your outlet name and who took the order (Taken by), so the station knows who to call with questions',
                    'Ticket dates print in the Bikram Sambat (BS) calendar, matching the rest of the app',
                    'Tap "+ Add note" under any order item to send a special instruction (e.g. "no onion") to the kitchen/bar — it prints indented under that item on the ticket. Preset chips from Table Management → Quick Notes appear while you type',
                    'Editing or adding a note after a ticket was already sent clears its ✓ sent badge — press KOT/BOT again to send the update to the station',
                    'The floor view shows an amber "⚠ pending" pill and per-table badge for any table with items added but not yet sent to the kitchen/bar — a quick way to catch orders that were never fired',
                    'Charge → closes the table — Supervisor role or above only, hidden entirely for Staff. Pay collects Cash/Card/eSewa/Khalti/FonePay and prints a Tax Invoice or Bill; Complimentary closes a walkout or comp — ₨0 is collected but it still counts against food-cost/inventory reporting; Void cancels a mistake with no revenue impact but is reserved for the owner/admin login — no PIN-based role (Staff, Supervisor, or Manager) can void a bill',
                    'Complimentary prints an internal Complimentary Slip, not a Tax Invoice or PAN Bill — its own sequential NC-01 style number (separate from Tax Invoice/Bill numbers), each line valued at food cost (not menu price) so comps don\'t distort your P&L',
                    'Both the Charge modal\'s total and item list switch to food-cost values while the Complimentary tab is open, and a live preview of the actual bill/slip layout appears in the modal as you fill in the fields — it always matches exactly what will print',
                    'Whether the printed bill says "TAX INVOICE" (with a VAT breakdown) or plain "BILL" (PAN only, no VAT) depends on the VAT Registered toggle an admin sets per client — see Settings below',
                    'Buyer Name/Address/PAN/Phone on the Charge screen are optional — IRD allows omitting them for bills up to NPR 10,000, but fill them in if a customer requests a full invoice',
                    'Discount on the Pay tab supports a flat NPR amount or a percentage (toggle between ₨/%) — it reduces the pre-VAT taxable amount, with VAT recalculated on the discounted base, not just subtracted off the total',
                    'Applying any discount makes buyer Name and Phone compulsory (not just optional) and requires picking a Discount Reason — gives an identifiable, audited record of who received it. Customize the reason list in Table Management → Discounts',
                    'Credit (red button, Supervisor role or above) closes the bill normally — it counts as a sale and consumes a Tax Invoice/Bill number — but no payment is collected now; the customer owes the amount. Buyer Name and Phone are compulsory, same as a discount. Collect it later from Customers → Outstanding Credit',
                    '📄 Recent Bills (floor view) lists everything closed today and lets you reprint a bill — the printout is labelled ORIGINAL-COPY the first time, SECOND-COPY the second, THIRD-COPY the third, and REPRINT #N after that (matches Nepal IRD\'s Rule 17 buyer/authority/seller copy terminology)',
                    'Scan-to-pay QR: once your admin pastes the outlet\'s merchant QR payload in Manage Clients → this client → QR tab, every bill carries a dynamic QR with that bill\'s exact amount pre-filled — the customer can\'t mistype it. The QR also appears in the Charge modal when eSewa/Khalti/FonePay is selected, updating live as discounts change. Payment confirmation is still manual — confirm once you see it land on your merchant app',
                  ],
                },
                {
                  icon: '👤', name: 'Customers', path: '/pos/customers',
                  desc: 'Customer book built automatically from billed orders — every bill closed with buyer Name + Phone (required for any discount or Credit sale) adds or updates a customer, keyed by phone number. The Outstanding Credit tab lists Credit bills awaiting collection with a one-tap Settle action. Requires Supervisor role or above.',
                  tips: [
                    'No manual data entry — the book fills itself as bills are closed with buyer details. Repeat customers are matched by phone number, so their name/address/PAN stay up to date automatically',
                    'Click any customer row to see their full order history — every billed order under that phone number, including payment method and any outstanding Credit',
                    'Outstanding Credit tab: when a customer comes back to pay, hit Settle and pick the payment method they actually used (Cash/Card/eSewa/Khalti/FonePay) — the bill is marked collected with who recorded it and when',
                    'The Age column shows how long each credit bill has been outstanding — chase the old ones first',
                    'Settling is Supervisor+ (routine cashier work); issuing credit at Charge stays Manager+ only',
                  ],
                },
                {
                  icon: '⚠', name: 'Sales Exceptions', path: '/pos/exceptions',
                  desc: 'Every discount, void, and complimentary in one report — revenue that leaked, filterable by BS date range, exception type, and staff member. Discounts show the amount knocked off; Voids show the menu value forgone (incl. VAT); Comps show food cost, matching the Complimentary Slip. Requires Manager role or above.',
                  tips: [
                    'The By Staff Member table is the report\'s real job — one cashier discounting far more than everyone else is worth a conversation (training gap or permission creep)',
                    'A quiet report is a healthy one — a sudden spike in voids usually means order-entry mistakes, not fraud',
                    'Amounts mean different things per type: Discount = NPR knocked off the bill, Void = full menu value that was cancelled, Comp = ingredient cost of what was served free',
                    'Use the ⬇ Excel button to hand the filtered list to your accountant — includes both AD date and BS Miti columns',
                    'Defaults to the current BS month — widen the range for a quarterly or fiscal-year view',
                  ],
                },
                {
                  icon: '⏱', name: 'Shifts', path: '/pos/shifts',
                  desc: 'Open a shift with a starting cash count, watch live sales totals as the shift runs (X-report), and reconcile the drawer against expected cash when it ends (Z-report). Requires Supervisor role or above.',
                  tips: [
                    'Open Shift and Close Shift both count each note/coin (₨1000 down to ₨1) rather than a single total — more accurate, and matches how cash is actually counted',
                    'Current Shift is the X-report — a live, repeatable snapshot. Nothing about it is final; check it anytime during the shift without affecting anything',
                    'Close Shift produces the Z-report — a one-time, final reconciliation. Expected Cash = opening count + cash sales during the shift; Variance = what was actually counted minus that expectation',
                    'A Balanced badge means the drawer matched exactly; red means short, amber means over — chase down shortages the same day while it\'s easy to remember why',
                    'You can run several shifts in a day (e.g. a morning cashier closes with a Z-report, an evening cashier opens a new one) — only one shift can be open at a time',
                    'Orders closed while no shift is open still bill normally — a missing shift never blocks Charge, it just means that order won\'t show up in any shift\'s totals',
                    'Shift History lists every past shift — click one to see its full frozen Z-report',
                  ],
                },
                {
                  icon: '👥', name: 'POS Staff', path: '/pos/staff',
                  desc: 'Assign POS roles to your team. Only staff with a role assigned can see POS screens. Roles: Staff (order-taking only), Supervisor (+ table setup, billing/Charge, Complimentary, Credit), Manager (+ Sales Exceptions report, role assignment). Void is not available to any PIN-based role — only the owner/admin login can void a bill. Requires Manager role or above.',
                  tips: [
                    'Start by assigning the owner/manager account the Manager role — they can then assign roles to the rest of the team',
                    'Staff role = waiters who take orders only. They cannot access Table Management or reports',
                    'Supervisor role is ideal for head waiters and floor captains who need to set table status and manage the floor',
                    'Users with no role assigned cannot see any POS screens — the POS section is hidden from their sidebar',
                  ],
                },
              ].map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="pos" />
              ))}
            </div>
          )}

          {/* ── Admin Tools ── */}
          {isAdmin && (
            <div style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid rgba(248,113,113,0.2)' }}>
                <span style={{ fontSize: 18, color: 'var(--theme-red)' }}>⚙</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Admin Tools</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-red)', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', padding: '2px 8px', borderRadius: 10 }}>Crest Admin Only</span>
              </div>
              {[
                {
                  icon: '◷', name: 'Audit Log',
                  guide: 'A full event log of every significant action in the system — creates, updates, deletes, period opens/closes, payroll runs, and admin operations. Each row shows the timestamp, client, user, action type, module area, and a plain-English summary of what changed. Filter by area (IMS, HR, POS, Admin) or search by user. Useful for investigating data discrepancies or tracking who changed what.',
                  tips: [
                    'Filter by "Area" to narrow down to IMS, HR, POS, or Admin actions',
                    'Search by user name or email to trace all actions by a specific person',
                    'The Summary column shows a human-readable description — e.g. "Updated selling price on Chicken Momo to NPR 300"',
                    'Audit entries cannot be edited or deleted — they are the permanent record',
                  ],
                },
                {
                  icon: '🧾', name: 'POS Billing Setup',
                  guide: 'Per-client invoice settings, set in Manage Clients → a client → Settings tab. VAT Registered controls whether POS bills print as a Tax Invoice with a VAT breakdown or a plain Bill with PAN only. Invoice Prefix is the short client code used in invoice numbers (e.g. TI2238-CAC-82/83) — auto-suggested from the property name, editable. The client\'s scan-to-pay merchant QR payload is a separate QR tab in the same drawer.',
                  tips: [
                    'Turn VAT Registered off for clients billing on PAN only (not yet VAT-registered with IRD) — the bill header switches from "TAX INVOICE" to "BILL" and drops the VAT line',
                    'Invoice numbers reset to 1 at the start of each Nepal fiscal year (Shrawan) automatically — no manual reset needed',
                    'Payment QR: paste the client\'s raw merchant QR text (scanned off their physical FonePay/NepalPay/eSewa standee with any QR-reader app) into the QR tab — it live-validates and previews before saving, and every POS bill then carries a dynamic per-bill QR with the exact amount pre-filled',
                    'Invoice Prefix is uppercased automatically; keep it short (3–5 letters) so it fits the 80mm receipt width',
                  ],
                },
              ].map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="admin" />
              ))}
            </div>
          )}

          {/* Neither module active */}
          {!imsEnabled && !hrEnabled && !posEnabled && (
            <div className="card" style={{ textAlign: 'center', padding: '40px 24px', borderColor: 'rgba(107,114,128,0.2)' }}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>⊘</div>
              <div style={{ fontSize: 14, color: 'var(--theme-text2)', marginBottom: 6 }}>No modules are currently active</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>Contact your Crest consultant to activate your subscription.</div>
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
                    <td style={{ fontWeight: 700, color: 'var(--theme-accent)' }}>{g.term}</td>
                    <td style={{ color: 'var(--theme-text2)', lineHeight: 1.6 }}>{g.def}</td>
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
            <h2 style={{ fontSize: 20, margin: '0 0 8px', fontFamily: 'Georgia, serif', color: 'var(--theme-text1)' }}>Plans & Pricing</h2>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>Choose the plan that fits your property</p>
            <div style={{ display: 'inline-flex', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: 3, gap: 2 }}>
              <button onClick={() => setPricingAnnual(false)} style={{ background: !pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border: !pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color: !pricingAnnual ? 'var(--theme-accent)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Monthly</button>
              <button onClick={() => setPricingAnnual(true)}  style={{ background:  pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border:  pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color:  pricingAnnual ? 'var(--theme-accent)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                Annual <span style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)', color: 'var(--theme-green)', fontSize: 9, padding: '2px 7px', borderRadius: 8, fontWeight: 700 }}>Save 25%</span>
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {PRICE_PLANS.map(plan => (
              <div key={plan.name} className="card" style={{ border: plan.highlight ? '1px solid rgba(201,168,76,0.45)' : '1px solid var(--theme-border)', position: 'relative', display: 'flex', flexDirection: 'column', padding: '32px 22px 22px', boxShadow: plan.highlight ? '0 4px 32px rgba(201,168,76,0.07)' : 'none' }}>
                <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: plan.badgeBg, color: 'var(--theme-bg)', fontSize: 9, fontWeight: 800, padding: '3px 12px', borderRadius: 8, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                  {plan.badge}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 18, color: plan.color }}>{plan.icon}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>{plan.name}</span>
                </div>
                <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
                  {plan.name === 'Starter' && !pricingAnnual ? (
                    <>
                      <div style={{ fontSize: 10, color: 'var(--theme-accent)', fontWeight: 800, marginBottom: 4, letterSpacing: '0.07em' }}>FREE FOR 1 MONTH</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {plan.monthly.toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo after</span></div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {(pricingAnnual ? plan.annual : plan.monthly).toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo</span></div>
                      {pricingAnnual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Billed annually · NPR {((pricingAnnual ? plan.annual : plan.monthly) * 12).toLocaleString()}/yr</div>}
                    </>
                  )}
                </div>
                {plan.name !== 'Starter' && (
                  <div style={{ fontSize: 10, color: 'var(--theme-text3)', marginBottom: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {plan.name === 'Growth' ? '+ Everything in Starter' : '+ Everything in Growth'}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                  {plan.features.map((f, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                      <span style={{ color: plan.color, fontSize: 12, flexShrink: 0, marginTop: 1 }}>✓</span>
                      <span style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.4 }}>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, color: 'var(--theme-text1)' }}>Ready to upgrade?</h3>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Contact your Crest consultant to change your plan.</p>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {phone   && <a href={`tel:${phone}`}    style={{ color: 'var(--theme-accent)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>📞 {phone}</a>}
                {email   && <a href={`mailto:${email}`} style={{ color: 'var(--theme-accent)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>✉ {email}</a>}
                {website && <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--theme-accent)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>🌐 {website}</a>}
                {!phone && !email && !website && <span style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Contact your Crest consultant to upgrade.</span>}
                <button onClick={() => navigate('/pricing')} style={{ background: 'rgba(201,168,76,0.1)', border: '1px solid rgba(201,168,76,0.3)', color: 'var(--theme-accent)', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
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
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--theme-text1)' }}>{item.q}</span>
                <span style={{ color: 'var(--theme-text3)', fontSize: 14 }}>{expandedFaq === i ? '▲' : '▼'}</span>
              </div>
              {expandedFaq === i && (
                <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--theme-border)' }}>
                  <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginTop: 12, lineHeight: 1.7 }}>{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
