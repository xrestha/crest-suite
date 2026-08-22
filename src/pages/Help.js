import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { MODULE_COLORS, MODULE_INK, colorTint, IMS_TIERS, HR_PRICING, POS_PRICING, SUITE_ADDON } from '../data/pricingPlans'

// ── IMS feature data, grouped by plan tier (Getting Started module guide — distinct from the
// IMS_TIERS pricing data imported above) ─────────────────────────────────────
const IMS_FEATURE_TIERS = [
  {
    tier: 'core', label: 'Core — All Plans', planLabel: null, planColor: 'var(--theme-text2)',
    features: [
      {
        icon: '◎', name: 'Dashboard',
        guide: 'The home screen. Shows KPI cards for the current open period: total purchases, revenue, food cost %, net margin, and top wastage. Figures update live as you add purchases, stock counts, and sales. Admin sees a platform overview; clients see their property dashboard.',
        tips: ['COGS and FC% are only accurate after closing stock is entered', 'If no open period exists, go to Periods and create one first', 'Dashboard figures always reflect the current open period', 'The "Daily Purchases vs Sales" chart overlays daily purchase spend (gold) with daily sales revenue (green), with the BS weekday initial (S/M/T/W/T/F/S) shown below each date. The green sales line only appears when sales are recorded day-by-day (Sales → pick a day); bulk monthly sales entry has no daily breakdown to plot. With 5+ days of data in the current month, a dashed line in the same colour projects both lines to month-end based on the pace so far — a live estimate that moves as more days are added — click the expand icon for the full view with running totals. A dotted "Target" line in a distinct colour (blue for sales, orange for purchases) also appears once 5+ days of data exist: unlike the dashed line, it is captured once and never changes for the rest of the period, so actual performance can be compared against the forecast made earlier in the month. Note: the gap between the lines is buying-vs-selling cash rhythm, not profit, and a purchase projection is inherently noisier than sales since restocking happens in bursts rather than a steady daily trickle.', 'The "Spend by Category" card also shows the Top Items by Spend list — switch between the two with the tab at the top of the card.']
      },
      {
        icon: '◆', name: 'Owner Dashboard',
        guide: 'A single cross-module view for owners — Revenue, Food Cost %, Labor Cost %, Prime Cost % (Food Cost % + Labor Cost %), and True Net Margin % (Revenue − Food Cost − Labor Cost − Overhead), plus Wastage Value, Items Below Par, and Overdue Payables. All figures are Month-to-Date against the current open period, same scoping as Monthly Summary. Below the KPI cards, a Cost & Margin Trend chart plots Food Cost %, Labor Cost %, Prime Cost %, and Net Margin % across your last 12 closed periods, sourced from each period\'s frozen Monthly Owner Report snapshot. Requires both Crest IMS and Crest HR enabled, plus Crest Suite Pro — an add-on bought on top of your modules rather than a bundle that replaces them, switched on from the Billing tab in Manage Clients.',
        tips: ['Labor Cost % is a prorated estimate (scaled to days elapsed this month) — it refines to the exact figure once Payroll Run is finalized for the month', 'Prime Cost % is the number most operators benchmark against directly — industry standard is roughly 60–65% of revenue', 'Items Below Par is a live inventory position, not a monthly total', 'A locked padlock means Crest Suite Pro is not active on this outlet — contact your consultant', 'The trend chart only plots periods that already have a Monthly Owner Report — a brand-new property with no closed periods yet won\'t show it until one exists']
      },
      {
        icon: '▤', name: 'Monthly Owner/Manager Report',
        guide: 'The frozen, exportable sibling of Owner Dashboard — a snapshot of every figure (IMS, HR, and POS combined) generated automatically the moment a period closes, so it never changes even if the underlying data is corrected later. Adapts to show only the modules your property actually has enabled. Pick any closed period from the dropdown to view its report, export it to Excel, or print/save it as a PDF. Requires the same Crest Suite Pro add-on as Owner Dashboard. Visible only to Owner and Admin logins.',
        tips: ['A period from before this feature existed generates its report the first time you open it — this can take a few seconds', 'Revenue here comes from Sales Entries; the separate POS Net Sales figure is derived independently from the Bill Register and will not match to the penny — that is expected', 'Only Admin can Regenerate a snapshot, and it always asks for confirmation first since it overwrites the frozen figures', '"Print / Save as PDF" uses your browser\'s print dialog — choose "Save as PDF" as the destination']
      },
      {
        icon: '⌸', name: 'Group Console (Multi-Outlet)',
        guide: 'If you run more than one outlet, your outlets can be linked into a group. An Owner login then gets an outlet switcher at the top of the sidebar — pick a branch and the whole app becomes that branch, with no second login. The Group Console itself puts every branch side by side for one BS month: Revenue, Food Cost %, Labour %, and Covers per outlet, plus group totals. Part of Crest Suite Pro, and priced per outlet — each branch needs its own Crest Suite Pro for its figures to appear. Ask your consultant to link your outlets; a single-outlet property sees none of this and is unaffected.',
        tips: ['The console shows only outlets that have Crest Suite Pro, and names the ones it left out — so a group total is never quietly missing a branch', 'Outlets keep their own periods, so one branch can still be counting a month another has already closed; a branch with no period for the month is flagged rather than shown as zero', 'A branch whose subscription has lapsed locks only itself — the switcher badges it, and your other branches keep working', 'You cannot switch outlets while POS orders are still waiting to sync — reconnect and let them finish first, or they would be saved against the wrong branch', 'Group figures are computed on group totals, not by averaging each branch\'s percentage, so a small outlet does not swing the number as hard as a large one']
      },
      {
        icon: 'Σ', name: 'Profit & Loss (Consolidated P&L)',
        guide: 'The formal statement the dashboards are not: Revenue, Cost of Goods Sold, Gross Profit, then Wastage, Staff Meals, Labour, Overheads and Tax & Fees down to Net Profit, each line with its share of revenue — for any one BS month. Every figure comes from the module that owns it: revenue and COGS use the same rules as Monthly Summary (price actually charged, comps excluded, sub-recipes counted at their raw ingredients), Labour is your finalized Payroll run (gross pay + employer SSF) or, if you don\'t run HR payroll, the Labour bucket from Overheads — never both. Defaults to your most recent closed month, because COGS needs the closing stock count; an open month shows as provisional. If your outlets are linked into a group, the same page shows one column per outlet plus a consolidated total — only outlets with their own Crest Suite Pro are included, and the ones left out are named. Part of Crest Suite Pro.',
        tips: ['Gross Profit is revenue minus COGS only — wastage and staff meals are broken out below it so spoiled stock and staff feeding are visible instead of hiding inside the food-cost line', 'If a month shows both a finalized payroll AND a manual Labour entry in Overheads, the statement uses payroll and tells you what it ignored — delete the manual entry if it duplicates payroll', 'The statement ties to Monthly Summary: same revenue rule, same COGS. Stock Count\'s Summary includes sub-recipes, so its COGS differs by exactly the prep amount', 'A month closed without a closing stock count shows a warning — its COGS treats closing stock as zero and reads high']
      },
      {
        icon: '◷', name: 'Periods',
        guide: 'Create one period per BS month. A period must be open before you can enter purchases, stock, or sales. Close a period at month end to lock the data. Closing stock auto-carries to next month opening. Periods older than 12 months are archived by default.',
        tips: ['Always create a new period before the month starts — if a POS bill is rung when no period exists for that BS month, its revenue and ingredient usage cannot reach Inventory at the time; the bill still closes and prints normally, and POS shows a banner counting them', 'If that happens, create the missing period and use "Post POS bills to Inventory" on it — this backfills those bills so Inventory reports and stock levels catch up. Safe to run more than once; already-posted bills are skipped', 'Close the period only after entering closing stock', 'Use "Show Archived" in Periods to access old months']
      },
      {
        icon: '≡', name: 'Item Master',
        guide: 'Your ingredient database. Every item needs a name, category, UOM (unit of measure), and one price: what ONE unit costs. Items are always stored in their smallest unit — sauce per ML, salt per GM — because that is what recipe costing needs. If you only know what a whole pack cost, the "Bought a pack?" line does the division for you: type 500 GM for NPR 388.50 and the price fills in as 0.777 per GM. Set conversion factors if you buy in bulk packs but consume in smaller units (e.g. 1 CTN = 24 BTL).',
        tips: ['Use consistent UOMs — GM for solids, ML for liquids', 'Two ways to price an item, same result: type the per-unit price straight in, or use "Bought a pack?" (500 GM for NPR 388.50) and let Crest divide it down', 'The "Bought a pack?" boxes are a calculator, not saved data — they are blank every time you reopen an item. If a pack size is a permanent fact about the item, put it on the Conversion tab instead, which is also what tells the Purchase Bill whether its Qty column means packs or grams', 'The Rate (NPR) / UOM column is the price of ONE unit — the exact figure recipe costing and stock valuation use. A sub-paisa rate is normal for something bought by the thousand and shows extra decimals rather than a misleading 0.00', 'Set conversion factor if 1 case = 24 bottles etc.', 'Deactivate items you no longer use — do not delete them', 'Editing many items in a row? The Edit Item dialog has ← Prev / Next → buttons that save the current item and jump straight to the next one in the list (in the order shown), with an "X of Y" counter — no need to close and reopen. (Same on the Vendors edit dialog.)']
      },
      {
        icon: '⊙', name: 'Vendors',
        guide: 'Add all your suppliers here. Linking purchases to vendors lets you track spend per supplier and identify price trends over time. Vendors can be set Active or Inactive.',
        tips: ['Add all vendors before starting purchase entries', 'Inactive vendors are hidden from purchase dropdowns but their data is preserved']
      },
      {
        icon: '⛊', name: 'Gate Passes',
        guide: 'Issue a printable gate pass for a vendor or delivery vehicle arriving at the property — pick an existing vendor or type a one-off company name, plus driver name, vehicle number, and purpose (delivery/pickup/maintenance/other). Prints an A4 pass with Security/Supervisor signature lines. No extra role gate beyond normal IMS access — anyone who can reach this page can issue one.',
        tips: ['Mark a pass "Exited" once the vehicle leaves — the Open tab is a quick live view of who\'s currently on the premises', 'The Pass No is sequential per client, separate from any other numbering in the app', 'Reprint from the log at any time if the original is lost', 'A pass left open past its day auto-closes the next time this page is opened, showing "Auto-Closed" instead of "Closed" — the record is kept, but it means staff never confirmed the vehicle actually left']
      },
      {
        icon: '↓', name: 'Purchases',
        guide: 'Record every ingredient purchase here. Each bill has a header (vendor, day, invoice ref, discount, payment method) and one row per item. Per row: select item, enter qty and rate, tick VAT if this line attracts 13% VAT, optionally enter an expiry date or shelf-life days (expiry auto-fills from the bill date). Use the Returns tab to log items sent back to suppliers.',
        tips: ['Enter purchases daily from the actual invoice — not from memory at month end', 'Always enter the actual invoice rate if it differs from the master rate', 'Add invoice reference number for audit trail', 'VAT is per-line — tick only the items that are VAT-able on that invoice', 'Enter shelf-life days and the expiry date fills automatically from the bill date', 'Returns auto-inherit rate and vendor from the original purchase', 'Daily Register tab: one row per item with a column per day plus a Total column at the end summing that item\'s purchases across the whole period — also included in Export Excel', 'The Total column stays pinned to the right edge as you scroll — no need to scroll all the way right to see it', 'Click any category header in Daily Register to collapse/expand it and cut down scrolling on a long item list']
      },
      {
        icon: '⊞', name: 'Stock Count',
        guide: 'Tabs: Opening Stock (start of month), Closing Stock (physical count at month end), Wastage (a quick monthly catch-all total per item), Daily Wastage (log spoilage by day with a reason — Spoilage, Expiry, Over-prep, etc.), and Staff Meals (internal consumption by staff). The Summary tab computes Used = Opening + Net Purchases − Wastage − Staff Meals − Closing, where Wastage = the monthly catch-all + all daily entries. Export to Excel.',
        tips: ['On the Opening Stock tab, use "↩ Pull from last month" to copy the previous period\'s counted closing stock into this period\'s opening — run it any time, e.g. if you finished the closing count after already closing the month', 'Any quantity box accepts arithmetic — type "3*24+7" for 3 cartons of 24 plus 7 loose and it commits 79. The running result shows above the box as you type; press Enter or click away to apply, Esc to cancel', 'Use the Daily Wastage tab to log spoilage by day and reason as it happens — these roll into the period total and COGS', 'The Wastage tab is the monthly catch-all: a single quick figure per item, on top of any daily entries', 'Enter opening stock before any purchases for accurate COGS', 'The Wastage Report now groups by item and includes a By-Reason breakdown', 'If an item\'s Used figure shows red (negative — more used than was ever bought or on hand), turn on "Block negative stock on save" in Settings → Thresholds to stop Save All until it\'s fixed. Off by default; the owner/admin can still override with a confirmation even when it\'s on']
      },
      {
        icon: '⌗', name: 'Quick Calculator & Inline Math',
        guide: 'Two ways to do arithmetic without leaving what you are working on. (1) Inline math: every quantity and rate box in Stock Count and Purchases accepts an expression — type "3*24+7" and it commits 79. The result previews above the box as you type; Enter or clicking away applies it, Esc cancels. (2) Quick Calculator: press Alt+C (or the ⌗ button beside the search box in the sidebar) for a small calculator that floats over any page, with a tape of your recent calculations. Click any result to copy it. The Add Purchase Bill modal has its own ⌗ button in its header for the same calculator, for working out a per-carton rate or a pack conversion without leaving the bill mid-entry.',
        tips: ['Supports + − × ÷ and brackets, e.g. "(12+8)*2.5". Commas are ignored, so "1,200/16" works', 'The calculator tape keeps your last 50 calculations for the session — click a row to reuse that expression, or click its result to copy', 'An incomplete expression like "3*" reverts to the previous value instead of saving a partial number', 'Alt+C is a toggle — press it again to close', 'The × in the calculator\'s own header closes just the calculator — Esc does too, and both leave whatever form is open behind it (e.g. Add Purchase Bill) untouched']
      },
      {
        icon: '◉', name: 'Mobile App',
        guide: 'Crest Suite can be installed on any smartphone — no app store required. On Android, open in Chrome and tap "Add to Home Screen". On iPhone, open in Safari, tap Share, and choose "Add to Home Screen". The app works offline: visit Stock Count once connected to cache all items, then count stock in the storeroom with no signal. Entries sync automatically when you reconnect.',
        tips: ['Open the app online at the start of each shift to refresh the cache', 'An amber "Offline" banner appears at the top when you have no connection', 'Cards with a dashed amber border are waiting to sync', 'Reinstall the app after a major update to ensure the latest version is cached']
      },
      {
        icon: '👥', name: 'IMS Staff', path: '/ims/staff',
        guide: 'Assign IMS roles to your team. Staff log in with their own email and password (same mechanism as the Owner account), not a shared PIN. Roles: Staff (Purchases, Stock Count, Sales Entry, Requisitions, Gate Passes only — no cost or report pages), Supervisor (+ Periods, Item Master, Vendors, Purchase Orders, Recipe Costing, and every Stock/Summary report), Manager (+ Menu Pricing, Overheads, all Finance Reports, Settings, and staff role assignment — full Owner-equivalent access). Requires Manager role or above.',
        tips: ['Start by assigning your own account the Manager role first if you plan to hand day-to-day IMS Staff management to someone else', 'Item Master and Vendors are Supervisor+ because they show purchase rates — Staff can still log purchases normally, since the item/vendor picker inside Purchases doesn\'t require visiting those pages directly', 'A staff account with no role assigned cannot see any IMS pages — the IMS section is hidden from their sidebar entirely', 'If Crest HR is also enabled, + Add Staff defaults to picking an existing HR Employee instead of typing a fresh name — the IMS login is linked to that employee record (shown with a 🔗 HR tag) so the name never drifts out of sync', 'Reset Password sets a new password immediately — there is no email/reset-link flow, so share the new password with the staff member directly']
      },
    ]
  },
  {
    tier: 'starter', label: 'Starter Plan', planLabel: 'Starter', planColor: 'var(--theme-text3)',
    features: [
      {
        icon: '₨', name: 'Menu Pricing',
        guide: 'Internal pricing review tool. Shows all active menu items with their food cost, current menu price (VAT-inclusive), and FC%. Type a new VAT-inclusive price on any row to instantly see the new FC% and the price change — then hit Save to commit it to Recipe Costing. Use the On POS toggle to control which items appear on the POS order screen without deleting the recipe.',
        tips: ['🖨 Print outputs the price list exactly as filtered on screen — the active category tab, with the category named in the print title — and the New Price boxes print BLANK so the sheet can be priced by hand and typed back in', '⬇ Excel downloads the same filtered list with a blank New Price column to fill in and send back — same workflow as the printed sheet, over email', 'Food cost is calculated live from current ingredient rates', 'The Change column shows + (price increase) or − (price decrease) vs current', 'FC% colours: green ≤30%, amber 31–38%, red >38%', 'Press Enter in the new-price field to save quickly', 'Saving updates the selling price in Recipe Costing — ex-VAT price is back-calculated automatically', 'Turn off On POS for seasonal or discontinued items — recipe history and costing are preserved', 'The POS order screen only shows items with On POS checked']
      },
      {
        icon: '↑', name: 'Sales Entry',
        guide: 'Record total qty sold per menu item for the period. Only items with a recipe appear here. Revenue is calculated automatically from selling price × qty sold, minus any per-item Discount entered on Daily Entry. Use Bulk Entry for a month-end tally. If you also run Crest POS, Bulk Entry and Daily Entry are locked: every bill closed at the till already posts its own sales, so POS is the source of truth and manual entry would duplicate or contradict it. The Daily Breakdown and Period Summary tabs stay available read-only.',
        tips: ['Sales data is required for the Variance Report to calculate theoretical usage', 'The Total Covers / Items with Sales / Period Revenue cards at the top cover the whole period — bulk and daily entries together — and price each sale at what it was actually sold for, not at the current menu price. Changing a menu price today does not restate last period revenue.', 'Sub-recipes are excluded — only top-level recipes appear here', 'You can update sales entries any time while the period is open', 'Daily Entry: click ↑ Import Excel to auto-fill qty AND discount from a vendor/POS "Sales Report Item Wise" export (.xlsx) for the currently selected day — it matches by Product Name and reads the Net qty sold and Discount columns; unmatched product names are listed in a small banner so you can fix names or enter them manually. Review the filled table, then click Save Day as usual', 'Discount (Daily Entry only) is a per-item NPR reduction for that day — e.g. staff discount or a promo — subtracted from Day Revenue and rolled up into Period Summary\'s Total Revenue. It has no effect on Bulk Entry, which has no per-day/discount concept']
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
        tips: ['For an accurate valuation, enter a closing stock count — items then show a "Physical" badge instead of "Theor."', 'A negative-stock warning means usage/wastage exceeds recorded purchases — usually a missing purchase entry', 'Total Stock Value matches the Closing value in Stock Count → Summary for a counted period', 'Needs Growth: the theoretical on-hand figure subtracts what your recipes say you consumed, so without Recipe Costing (Growth) stock would only ever go up. Existing Starter clients keep their access']
      },
      {
        icon: '⚑', name: 'Reorder Report',
        guide: 'Flags items running below their par level. Theoretical stock = Opening + Net Purchases − Wastage − Usage. Set par levels inline on the report. "✕ Clear All Par" resets all par levels at once. "🖨 Print Par Sheet" prints a category-grouped sheet with a blank fill-in column per item (respecting the Category/Search filters) — hand it to floor staff to write in par levels by hand, then type the values back into the Par Level column here afterward. "🖨 Print Reorder List" and "📱 Share via WhatsApp" both build the actual purchase list — every item currently at or below par, grouped by category, with qty to order and estimated value — always reorder-only regardless of the on-screen Status filter, but still scoped by Category/Search. WhatsApp opens with the list pre-filled as a text message so you pick who to send it to; nothing is sent automatically. Every row also has a checkbox on the left — check specific items to limit Print Reorder List, Share via WhatsApp, and ↓ Export Excel to just those; leave none checked and all three behave as described above (the whole filtered/reorder-only list). Book Stock is a separate, live column fed by Crest POS — every time a POS order is charged or marked Complimentary, the recipe is exploded into its raw ingredients (recursing through sub-recipes) and a depletion entry is recorded automatically. Book Stock shows "—" for items with no POS sales this period; it does not replace Current Stock, which still reflects manual Sales Entry too. Admins see a "✕ Clear Book Stock" button to wipe the ledger for the selected period back to "—" (e.g. to clear out bad test data) without touching physical counts or Current Stock. Click a Book Stock value to see the full itemised ledger behind it in Stock Movements.',
        tips: ['Set par levels based on supplier lead time × daily usage rate', 'Review the reorder report weekly, not just at month end', 'Book Stock only reflects POS-recorded sales/comps — if you also log sales manually, Current Stock is the more complete number', 'Use "Print Par Sheet" for a first-time par-level rollout — floor staff can fill it in without needing IMS access', 'Filter to a Category before "Share via WhatsApp" to send a shorter, station-specific list (e.g. just Meats & Poultry to the kitchen)']
      },
      {
        icon: '↺', name: 'Stock Movements',
        guide: 'The itemised ledger behind Reorder Report\'s Book Stock column — every POS-driven depletion entry for the selected period, one row per item per order. Shows the date, item, quantity depleted, source (POS Sale vs POS Comp), the order number (click it to open the exact original bill or complimentary slip), the staff member who closed that order, and the food-cost value of the depletion (qty × per-unit rate). The "Comp Value" stat card totals what was given away complimentary — food cost consumed with zero revenue collected. Arriving from Reorder Report\'s Book Stock link pre-filters to that item and period automatically. Two tabs: "Raw Items" is that ledger, and "Sub-Recipes" answers the question the ledger structurally cannot — how many batches of each prep item (sauce, base, dough) this period\'s sales actually consumed. A sub-recipe is never depleted as itself, because a recipe stores it as a reference and only the raw ingredients at the bottom of the tree ever reach the ledger, so that tab re-walks the same recipes against the period\'s sales to show the prep layer in between: Yield per Batch, Qty Used (output units, e.g. 25,000 ml of a sauce), Batches Used (Qty Used ÷ Yield per Batch), Cost per Batch, and Value. It exports as a second sheet in the same Excel file. Both tabs have a Sort control (Day/Item/Category/Qty/Source/Value on Raw Items; Sub-Recipe/Qty/Batches/Cost per Batch/Value on Sub-Recipes) with an ascending/descending toggle, a TOTAL row summing the value of whatever is currently filtered, and a Print button that prints exactly the on-screen view. The Sub-Recipes tab also has a "Find ingredient in sub-recipes" box — type "milk" to list every prep item containing it, including where it is hidden inside a nested sub-recipe.',
        tips: ['POS Comp rows are excluded from revenue everywhere else in the app, but the food cost still shows here — this is the one place to see what comps actually cost', 'Click any Order # to jump straight to the original bill for full traceability', 'Only reflects POS activity — a client without POS sales in a period will see an empty ledger even with active stock movement from purchases/wastage', 'A recipe sold via POS with no ingredients linked (Recipes → Ingredients tab) never produces a depletion entry here, even though it still shows normally in Sales Report — a "No BOM" badge on the Recipes list and a warning banner at the top of this page flag exactly which items that\'s happening for', 'The Sub-Recipes tab is NOT extra depletion on top of the Raw Items tab — it is the same ingredients grouped by the prep item they passed through. Adding the two together double-counts', 'Sub-Recipes has no Day filter, unlike Raw Items: it includes Bulk Sales Entry rows, which belong to the whole period rather than any one day', 'If the sub-recipe figures imply more raw ingredient value than the ledger recorded, an amber note explains the gap — usually a period from before manual Sales Entry started depleting stock (2026-07-30, never backfilled)']
      },
      {
        icon: '⊛', name: 'VAT Report',
        guide: 'Summarises input VAT on purchases. Toggle the VAT-inclusive flag per purchase entry in the Purchases page. Shows total VAT paid per period for use in your IRD VAT return.',
        tips: ['Only purchases marked as VAT-inclusive are counted in the VAT total', 'Match this against your supplier VAT invoices before filing']
      },
      {
        icon: '⚑', name: 'Purchase One Lakh Above Report',
        guide: 'Nepal VAT return Annexure 13 (अनुसूची १३): any single vendor whose cumulative purchases exceed NPR 1,00,000 in a fiscal year must be disclosed by name + PAN. Aggregates purchases by vendor across a full BS fiscal year and flags who crosses the threshold — the purchase-side counterpart to the POS One Lakh Above Report.',
        tips: ['⚠ Missing PAN means a vendor crossed NPR 1,00,000 without a PAN/VAT No. on file', 'Only VAT-inclusive purchase entries are counted, netted against vendor returns', 'Spans every period in the selected BS fiscal year, not just one month']
      },
      {
        icon: '⊘', name: 'Non-VAT Report',
        guide: 'Lists all purchases from non-VAT registered vendors. Useful for accounting and for separating VAT vs non-VAT purchase records. Totals are net of bill discounts and of any non-VAT goods returned to the vendor, matching how the VAT Report treats its own half of the filing.',
        tips: ['Non-VAT purchases are those not marked as VAT-inclusive in the Purchases entry', 'Returns are deducted from both the headline total and each vendor row. A Returns column appears only when there were returns in the period.']
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
      {
        icon: '⊞', name: 'Staff Meals Tracking',
        guide: 'A dedicated Staff Meals tab in Stock Count. Track food consumed by staff or given as complimentary — kept separate from wastage so it doesn\'t inflate your spoilage numbers. Staff meals are deducted from COGS separately in the Monthly Summary.',
        tips: ['Record staff meals daily, not at month end, for accurate COGS tracking', 'Separate from Wastage so management can see both figures independently']
      },
    ]
  },
  {
    tier: 'growth', label: 'Growth Plan', planLabel: 'Growth', planColor: 'var(--theme-green-text)',
    features: [
      {
        icon: '◈', name: 'Recipe Costing',
        guide: 'Build your menu items with ingredients and qty per portion. Food cost % is calculated live from latest purchase rates. Enter selling price (incl. VAT) to see margin and get a suggested price at your target FC%. Sub-recipes can be nested inside parent recipes. With the Nutrition Facts add-on, each recipe also shows a per-portion nutrition label (energy, protein, carbs, fat, sugar, sodium) plus aggregated allergens. To add many recipes at once, use ↓ Template / ↑ Import Excel at the top of the recipe list; Crest Admin also has a ↓ Export button there; to copy an existing dish use the Clone button on its row.',
        tips: ['FC% below 30% = excellent, 30–38% = acceptable, above 38% = needs review', 'Update recipes when ingredient prices change significantly', 'Product Code is filled in for you from the category as you create a dish — pick Beverage and you get BEV-001, then BEV-002, and so on. Type your own code over it (say one you already print on your menu) and Crest leaves it alone. Staff can search this code on the POS order screen, and it appears on the Item Wise sales report. For dishes created before this existed, use Settings → Product Codes → Generate Missing Product Codes, which only fills in the blanks and never changes a code you already have.', 'Bulk import: click ↓ Template to download a spreadsheet (it includes a "Your Items" sheet with your exact item names, codes & units to copy from). Fill one row per ingredient — put the Menu Item name, Category, Selling Price & Yield on the recipe\'s first row, then leave those blank for its remaining ingredient rows. Ingredient column accepts an item name, item code, or sub-recipe name; Qty is in the item\'s unit (KG↔GM and LTR↔ML auto-convert). Upload with ↑ Import Excel — a preview shows which ingredients matched and lists any unmatched ones (they\'re skipped; add those items to the Item Master first, then re-import). Recipes that already exist and rows marked category "Sub-Recipe" are skipped.', '↓ Export (Crest Admin only) downloads every current recipe and sub-recipe with its full ingredient breakdown and cost — a backup, an editable spreadsheet, or a file to hand to another location/client. It\'s the same format as ↓ Template (plus extra cost/FC% columns for reference), so an exported file can be edited and re-imported through ↑ Import Excel — even into a different client, since it only carries ingredient/recipe names, never internal IDs. Ingredients only auto-match on the other side if that client\'s Item Master has items with the same names or codes.', 'Clone: the Clone button duplicates a recipe (named "… (Copy)") into the New Recipe form with all its ingredients — tweak and save. Great for menu variants.', 'Use the overhead panel in each recipe\'s detail view to see true cost after fixed cost allocation', 'Nutrition: while editing a recipe, each ingredient row has a Nutrition button — enter values per 100 GM/ML (or per piece) there, or click DFTQC Nepal / IFCT 2017 / USDA to pull a match from that specific library (an ingredient may only have data in one of the three — DFTQC/IFCT are Nepal/India government food tables and don\'t cover every item, e.g. imported fruits like strawberry), or 🔍 Fetch from Open Food Facts for branded/packaged items (search by name or barcode). Entered once per ingredient, it fills every recipe that uses it. Tip: the ⚡ Auto-fill nutrition button (Ingredients header) fills every matching ingredient from the regional library (DFTQC Nepal / IFCT 2017 / USDA) in one click — it deliberately does NOT reach for the live USDA FoodData Central API on a miss; ingredients with no local match are listed in a small banner with a separate "🔍 Try USDA FoodData Central" button, so a live USDA lookup is always something you ask for, never a silent default. The recipe shows a data-coverage count; missing ingredients make the label an underestimate.', 'Use the "Find ingredient in recipes" box (top-right of the recipe list) to see every dish that uses an ingredient — it even matches ingredients hidden inside sub-recipes.', '📱 Share via WhatsApp sends the currently selected category tab\'s recipe list (name, food cost, FC%) as a WhatsApp message — pick a category tab first (e.g. Beverage) to share just that subset.', 'Every row has a checkbox on the left — check specific recipes to limit 🖶 Print and 📱 Share via WhatsApp to just those within the current tab, and ↓ Export (Crest Admin) to just those across every tab. Leave none checked and all three include the whole tab (or, for Export, everything) as before.', 'Description, Photo URL, and Veg/Non-Veg (below the main details, non-sub-recipe items only) are optional and feed the POS guest-facing QR menu (Table Management → ▦ QR) — leave any of them blank to omit that detail from the guest menu', 'Each recipe row has a Hide/Show button and an Active/Inactive status badge — Hide is the safer, reversible alternative to Del for a discontinued dish: it stops the recipe from appearing in Sales Entry, POS ordering, the Guest Menu, and the menu-analysis reports (Menu Engineering/Pricing/Repricing/Recipe Margin), but keeps its past sales history, revenue, and food-cost figures exactly as they were. Del permanently removes the recipe and is blocked if anything else uses it as a sub-recipe ingredient. Deactivating a sub-recipe currently has no effect on other recipes that use it — it stays fully usable as an ingredient either way.', 'If a selling price is set below the recipe\'s computed cost, a red warning appears under the price field so it\'s not an accident (e.g. a mistyped price). It doesn\'t block saving — some items are intentional loss-leaders. Turn this off in Settings → Thresholds if you don\'t want the warning at all.']
      },
      {
        icon: '△', name: 'Variance Report',
        guide: 'Compares theoretical usage (sales × recipe qty) against actual usage (Opening + Net Purchases − Wastage − Staff Meals − Closing). Positive variance means more was used than sold — indicating waste, theft, or over-portioning. The flag threshold is yours: Settings → Thresholds → Variance Flag (default 10%). The report opens on the most recent CLOSED month, because the closing stock count is what makes the comparison possible at all.',
        tips: ['Sort by NPR value to prioritise the biggest leaks', 'Items with no recipe show actual usage only — no theoretical comparison', 'Review this every month before closing the period', 'If you pick a month whose stock count is not done yet, the report says so and greys the figures out rather than showing them: without a closing count everything still on your shelves counts as "used", and every item would look over-consumed. Finish the Stock Count first — the Data Coverage card tells you whether both halves (sales + stock count) are in']
      },
      {
        icon: '₿', name: 'Outstanding Payables',
        guide: 'Tracks all credit purchases that have not been paid, grouped by vendor and by bill (invoice). Bill Total is what the vendor actually invoiced — net of any goods returned, minus the bill discount, plus 13% VAT on VAT-inclusive lines — so it matches the printed purchase voucher exactly. Aging buckets: Current / 31–60 / 61–90 / 90+ days. Click a bill to expand it and record a payment against the whole invoice at once. For a monthly credit run across several bills, use the checkboxes (or the header checkbox to select a whole vendor, or "Select All Filtered") to pick multiple bills and pay them all in full together with one shared date/note. A Month filter narrows the list to one BS period before selecting.',
        tips: ['Anything in the 61–90 day bucket needs immediate follow-up with finance', 'Filter by Vendor + Month, then "Select All Filtered" to clear an entire month\'s bills for one vendor in one action', 'Partial payments are still per-bill only — expand a single bill to pay less than the full remaining amount']
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
        icon: '⋈', name: 'Combo Builder',
        guide: 'Shows which menu items are actually ordered together most often, from real POS bills over a 30/90/180-day window, and suggests a discounted combo price. Pick an anchor item, and the table ranks its most frequent pairings with a "Bills Together" count, combined price, and suggested combo price (combined price × your Combo Discount %). Insight-only — "Create as Menu Item" links to Menu Pricing so you create the priced bundle yourself; nothing is created automatically.',
        tips: ['A menu item with very few bills yet won\'t show pairings — needs more sales history first', 'Combo Discount % is saved per client — adjust it and every suggested price updates immediately', 'Try a longer window (180d) for a lower-volume item, shorter (30d) to catch a recent trend']
      },
      {
        icon: '☑', name: 'Purchase Orders',
        guide: 'Create and manage purchase orders to send to vendors before stock arrives. POs can be drafted, approved, and marked as received. Maintains a proper procurement trail ahead of Purchases entries.',
        tips: ['Raise a PO before the vendor delivers to keep procurement organised', 'Match the received PO against the actual invoice when entering Purchases']
      },
    ]
  },
  {
    tier: 'pro', label: 'Pro Plan', planLabel: 'Pro', planColor: 'var(--theme-accent-ink)',
    features: [
      {
        icon: '≋', name: 'Period Comparison',
        guide: 'Compare key metrics across multiple periods. Shows Net Purchases, Wastage, COGS, Revenue, and FC% per period, each with a small % change line vs the previous period (and vs the same month last year when that toggle is on). Two trend charts (Revenue vs Net Purchases, and Food Cost %) plus a Revenue by Category chart sit above the table. Select last 6, 12, 24, or all periods.',
        tips: [
          'Look for seasonal FC% spikes — often signals menu pricing hasn\'t kept up with ingredient costs',
          'Use the 12-period view for annual budget planning',
          'Turn on "Compare vs last year" to tell a real seasonal swing (festival month, tourist season) apart from genuine month-to-month drift',
          '"Highest Revenue Period" and "Highest Purchases Period" stat cards call out your peak months at a glance',
          'Export Excel includes a second sheet with the Revenue by Category breakdown, not just the main comparison table',
        ]
      },
      {
        icon: '⊕', name: 'Shrinkage Report',
        guide: 'Multi-period analysis of actual vs theoretical usage per item. Flags items with consistent over-use across periods. Status: Consistent / Occasional / Once / Clear. Helps identify systematic waste or theft. Theoretical usage recurses through sub-recipes and accounts for each ingredient trim loss (yield %), so it agrees with the Variance Report.',
        tips: ['Consistent shrinkage on a high-value item over 3+ periods is a serious red flag', 'Use alongside the Variance Report for a complete picture of stock losses']
      },
      {
        icon: '⬢', name: 'Menu Engineering',
        guide: 'Classifies menu items into Star / Puzzle / Plowhorse / Dog based on profitability and popularity. FC% cutoff is 35%; volume cutoff is median qty sold. Sub-recipes are excluded from this analysis.',
        tips: ['Stars = high margin + high volume → protect and promote', 'Dogs = low margin + low volume → consider removing from the menu']
      },
      {
        icon: '⊗', name: 'FIFO / Expiry',
        guide: 'Tracks stock on a first-in, first-out basis. Shows remaining qty per purchase batch, net of returns, with purchase date and expiry. Fully returned batches are hidden. Helps prioritise use of oldest stock to minimise expiry losses.',
        tips: ['Check FIFO weekly for perishables — don\'t wait until month end', 'Set expiry dates in the Purchases entry for accurate FIFO tracking']
      },
      {
        icon: '◷', name: 'Stock Ageing',
        guide: 'Shows how long the stock you are still holding has been sitting, bucketed into 0–30, 31–60, 61–90 and 90+ days across a fiscal year. Everything sold, wasted or served as staff meals is taken off the oldest batches first, and whatever survives is aged from the day it was bought and valued at what you actually paid for it. The headline figure is the money tied up in stock older than 90 days. Every age on the page is measured to a stated as-of date, shown in the subtitle and printed on both the sheet and the Excel export.',
        tips: ['Unlike FIFO / Expiry this covers every item, not just ones with an expiry date', 'A big 90+ day figure is working capital sitting on a shelf — review those items for over-ordering or a dish that stopped selling', 'Stock already on hand when the year began is marked "c/f" — its true age is at least what is shown', 'Pick the current fiscal year and ages run to today; pick a past one and they run to the end of that year instead — otherwise every surviving batch would read as 90+ days old simply because the year is over', 'The age band columns show quantity; the TOTAL row under them shows each band\'s value, so you can see where the money sits']
      },
      {
        icon: '⊙', name: 'Vendor Report',
        guide: 'Net spend per vendor with columns for Gross, Returns, Net, % of total, average per day, and payment method breakdown (Cash / Credit / FonePay). Search by vendor name or code. Click a vendor name to drill down into every bill for that vendor this period — payment status (Paid / Partial / aging), and click any bill row to expand its line items, returns, and payment history. Searching down to a single vendor also switches the Daily Breakdown tab to show only that vendor\'s active days (no blank rows) — click any day to jump straight to that day\'s bill.',
        tips: ['Sort by Net to find your top suppliers — good candidates for negotiating credit terms', '% of Net shows vendor concentration risk', 'Click the vendor name for a bill-by-bill breakdown with payment status', 'Select a vendor in the search box, then click a day in Daily Breakdown to open that day\'s bill directly']
      },
      {
        icon: '◈', name: 'Supplier Contribution',
        guide: 'Splits the ingredient cost behind a period\'s sales across the suppliers that actually provided those ingredients. Crest stores no supplier on an item, so this is derived: what sold (Sales Entry and POS together, counted once) is exploded into raw ingredients through your recipes, valued at each item\'s per-unit rate, then split across the vendors you bought that item from this period in proportion to what you spent with each. Click a supplier to see the ingredients traced to it and, beside them, the menu items whose sales depend on it — what would come off the menu if a delivery failed. The Reliance Gap column compares a supplier\'s share of your sales cost against its share of your spend, in percentage points.',
        tips: ['"Top Supplier Share" is your concentration risk — one supplier above 50% means one delivery failure can close a section of the menu', 'A large positive Reliance Gap means you lean on that supplier more than your purchase ledger suggests — the first place to negotiate, and the first to second-source', 'The "Attributed Cost of Sales" card and the table\'s TOTAL row are deliberately different figures: the card excludes the "Not attributed" row, the TOTAL includes it, and the difference is exactly the Not Attributed card', '"Not attributed" is stock your sales used but you bought from nobody this month, usually bought in an earlier period — it is shown rather than hidden so the total always adds up', 'Figures are recipe-based (what the dishes should have used), not the actual count-based COGS — Variance is where those two are compared', 'Wastage and staff meals are excluded: this is the cost of what was sold. Complimentary items are included, since the food still came out of a delivery']
      },
      {
        icon: '✎', name: 'Vendor Balance Confirmation',
        guide: 'Printable per-vendor balance confirmation letter for a BS fiscal year — Opening Balance, Purchases, Payments/Returns, and Closing Balance, with a supporting bill-by-bill schedule showing the running balance. Matches Nepal IRD Annexure 13 (अनुसूची १३) reconciliation practice and NSA 17 external-confirmation audit evidence: sign, stamp, and return within 7 days. Reach it from Reports → Menu & Vendors, or via the "Confirm Balance" link on a vendor\'s row in Vendors.',
        tips: ['Opening Balance is computed as of the fiscal year\'s start date (Shrawan 1), not a live "today" snapshot', 'Cash/FonePay bills appear in the schedule for full-turnover visibility but never carry a balance', 'A negative Closing Balance is labelled Advance/Credit Balance rather than Amount Payable', '"Share via WhatsApp" pre-fills the Opening/Purchases/Payments/Returns summary and closing balance as a text message — the printed letter is still the document to actually sign']
      },
      {
        icon: '◫', name: 'Supplier Price Tracker',
        guide: 'Shows rate history per item per vendor with trend arrows (↑↓→). "Update Rate" syncs the item master to the latest purchase rate. Warns (⚠) if the master rate differs >5% from the last purchase.',
        tips: ['Run this monthly after entering purchases — catch price creep early', '"Update Rate" overwrites the item master rate, which affects all future recipe costs']
      },
      {
        icon: '⊞', name: 'Overheads',
        guide: 'Three-tab entry: Fixed Overheads, Labor Costs, and Tax & Fees. Generates a P&L Summary, Break-Even analysis, and Cost per Cover. Overhead allocation appears in each recipe\'s detail view as True Cost and True Net Margin.',
        tips: ['Opening a period with nothing entered yet auto-fills the most recent prior period\'s saved amounts as an editable draft — nothing is written to the database until you hit Save, so revise any line that\'s changed (a raise, a new lease rate) before saving', 'Update overheads monthly — fixed costs rarely change but labour does', 'Cost per Cover requires accurate cover count — enter it in the overhead form']
      },
      {
        icon: '🏛', name: 'Fixed Assets', path: '/fixed-assets',
        guide: 'Register of tangible fixed assets (equipment, furniture, vehicles, kitchen machinery) — separate from Item Master\'s stock/inventory tracking. Five tabs: Register (add/edit assets, categories set default useful life & Nepal tax pool), Depreciation Runs (straight-line book depreciation — Preview computes nothing, Post writes and locks the schedule), Valuation Report (portfolio cost/NBV as of any posted period, by category), Disposal Report (disposed/written-off assets with gain/loss), and Tax Depreciation (IRD) — Nepal\'s statutory pooled written-down-value method (Income Tax Act 2058), a separate system from book depreciation that\'s expected to show a different number.',
        tips: ['Staff/Supervisor IMS roles can view the register and run a Preview; only Manager/Owner can Post — this matches the payroll Finalize pattern', 'Once a depreciation run is Posted it is permanently locked — a correction is a new adjustment run, never an edit to the old one', 'The Tax Depreciation tab carries its own on-screen disclaimer — verify current pool rates and the repair-expense cap with your accountant before relying on it for an actual filing', 'Personal Use % on an asset excludes it from the default Valuation Report view — apportioned depreciation for a non-zero value isn\'t calculated in v1']
      },
      {
        icon: '△', name: 'Theoretical Variance',
        guide: 'Advanced variance analysis that isolates theoretical food cost vs actual, broken down by category. Deeper drill-down than the standard Variance Report. Compare against budget for a complete financial picture.',
        tips: ['Items with both high theoretical and high actual usage → recipe portion sizes may need revision', 'Use alongside Budget vs Actual for the most complete picture']
      },
      {
        icon: '↗', name: 'Demand Forecast',
        guide: 'Predicts covers, revenue, and per-dish quantity for the next 7 or 30 days using a day-of-week moving average over your last ~12 weeks of POS sales (falls back to manual Sales entries if POS history is thin). Click "Recompute Forecast" to generate or refresh it — it does not run automatically. Click a day\'s row to see its top forecasted items. A holiday badge means the target date matches your Holiday Calendar; if that holiday has a Demand Multiplier set, the badge shows "×N" and the covers/revenue/item numbers on that row are already scaled by it — if not, the badge shows the holiday name alone and the forecast is NOT adjusted (treat it as a floor, not a ceiling, on that day).',
        tips: ['Recompute weekly for the freshest prediction — it only reflects sales up to the last time you ran it', 'A thin or brand-new POS history produces a less confident forecast — give it a few weeks of data', 'Set a Demand Multiplier on a holiday in Holiday Calendar (e.g. 0.3 if you close/run quiet, 1.5 if it\'s your busiest day) to have this page actually scale the forecast for it, not just flag it', 'Add movable holidays (Dashain, Tihar) to the Holiday Calendar so they get flagged even before you set a multiplier for them']
      },
    ]
  },
]

// ── HR feature data ───────────────────────────────────────────────────────────
const HR_FEATURES = [
  {
    icon: '▦', name: 'HR Dashboard',
    guide: 'The HR command centre. An Approvals row up top covers every staff submission waiting on you — pending Leave requests, pending OT entries, pending TADA claims (manager-entered or Self-Service-submitted), and shift swaps that have cleared the coworker\'s accept and now need your sign-off. Below that: live headcount (active + probation), estimated basic payroll per month, advances outstanding, and employees retiring within 180 days. The payroll section summarises the last finalized run: net payable, employee SSF (11%), employer SSF (20%), and the total SSF challan amount to deposit — with the deposit deadline (15th of the following month). All four approval queues are listed further down so you can click through to approve or reject without navigating away.',
    tips: [
      'All KPI cards are clickable — click any card to jump directly to the relevant page',
      'SSF challan total = employee 11% + employer 20% from the last finalized payroll run; deposit with SSF by the 15th of the following BS month',
      'The four Approvals cards (Leave, OT, TADA, Swap) turn amber when items are waiting — clear Leave/OT before running payroll so approved entries are included',
      'Swap Pending only counts requests the coworker has already accepted (status pending_admin) — one still waiting on the coworker isn\'t something you can act on yet, so it\'s left off this count',
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
    guide: 'Daily attendance per BS month, across three tabs. Mark Attendance lets you pick a day and set every employee\'s status (Present, Half-day, Absent, Paid/Unpaid Leave, Half-day Paid/Unpaid Leave, Off, Holiday) plus Start/End clock times, hours worked (for hourly staff), and overtime hours, one day at a time. By Employee is the same data the other way round — pick one employee and fill in every day of the month for just them, useful for entering a whole month for one person in one sitting. Every day defaults to Present until you mark it otherwise — there\'s no company-wide "everyone\'s off on this weekday" assumption. The Month Summary tab shows a colour-coded grid of the whole month with per-employee totals (Present / Absent / Off / OT hours), and exports to Excel. Attendance is the data source Payroll uses to calculate actual pay for daily and hourly workers and to apply overtime.',
    tips: ['Pick the day, set statuses, then click Save Day — each day is saved as a complete set for all active employees', 'By Employee tab: pick a person from the dropdown, fill in their whole month day-by-day, then Save Month — the quick buttons (All Present/Off/Holiday) and ⚡ Generate from Roster there apply to just that one employee, not the whole team', 'Enter a Start and End time to auto-calculate Hours and OT Hours — hours beyond that day\'s Roster-assigned shift (or 8h if the employee isn\'t on the roster that day) become overtime automatically; both fields stay directly editable afterward if the auto-calc needs a manual tweak',
      'Start/End times accept plain digits too — type "0800" or just "8" and it\'s read as 8:00, no need to type the colon yourself; it\'s reformatted to H:MM once you leave the field',
      'If someone clocks in noticeably fewer hours than their Roster-assigned shift for the day, an amber "⚠ X.Xh short" note appears next to OT Hours — it\'s a heads-up only, nothing is auto-deducted (Nepal\'s Labour Act only defines a full-day absence deduction, not a per-hour one); reclassify the day as Half Day yourself if that\'s warranted',
      'Break (minutes) subtracts an unpaid lunch/break from Start-to-End before it becomes Hours Worked — enter it before or after typing Start/End, Hours and OT Hours recalculate either way; leave it blank for a shift with no unpaid break',
      'Set "Default break" once (starts at 45 min) and click Apply Break to Day / Apply Break to Month to fill it into every already-marked row that still has a blank Break — it only fills gaps, never overwrites a Break value you already typed, and never touches a day/employee you haven\'t marked at all', '⚡ Generate from Roster fills blank days from that month\'s Staff Roster shift assignments — a real shift with hours is marked Present, and a zero-hour shift type named like an off day (e.g. "OFF DAY", "LEAVE") is marked Off. It never overwrites a day you\'ve already marked, and never guesses at a day with no roster entry at all — those are left for you to mark manually', 'A roster shift with no hours that isn\'t named like an off day (an unusual custom type) is marked Holiday by Generate from Roster rather than counted as Present — both Off and Holiday are payroll-neutral, so no pay is added or deducted; use a formal Leave Request instead if the absence should show as Paid/Unpaid Leave', 'Off days are marked per employee, per day — there\'s no single company-wide off weekday anymore; if most of your team is off the same day each week, "All Off" on that date (Mark Attendance tab) is a one-click way to mark everyone at once', 'Half-day Paid/Unpaid Leave are written automatically when a half-day leave request is approved (see Leave) — Half-day Paid Leave costs the employee nothing, Half-day Unpaid Leave deducts half a day\'s pay', 'Public holidays are marked manually — use the "All Holiday" button or set Holiday per employee', 'The Hours column only appears for hourly-paid employees; OT hours can be entered (or auto-calculated) for anyone', 'Overtime is captured here and paid at 1.5× the normal hourly rate during the payroll run', 'Only active and probation employees appear on the sheet']
  },
  {
    icon: '📋', name: 'Roster',
    guide: 'Plan weekly or monthly staff shifts. Three tabs: Roster Board (the schedule itself), Shift Types (customise shift names, times, colours, hours), and Labor Forecast (demand-forecast overlay — see below). Two view modes on the board: Monthly (pick a BS month; the board splits into two halves — days 1–16 and 17–end — so nothing overflows) and Weekly (7-day grid centred on the selected week). Click a cell to assign a shift, or click-and-drag across a rectangle of cells (multiple days, multiple staff, or both) to assign the same shift to all of them in one action — useful for a multi-day Leave block or a whole week of the same shift. Most weeks repeat, so Weekly view has a ⧉ Copy to Next Week button: it stamps every shift on the week you\'re looking at onto the same weekday next week, and then moves you to that week so you can edit the exceptions. It makes the two weeks identical rather than merging them — a cell that\'s empty this week is cleared next week — and the confirmation counts exactly what will be replaced and cleared before anything is written. It copies only the departments the filter is currently showing. Print the schedule with a Company Name/Address letterhead for department heads — the Board only prints the shift assignments, never any labor-cost data. A Draft/Published badge and a Publish button appear in both Weekly and Monthly view — publishing releases just the visible days (7 in Weekly, the whole month in Monthly) to Employee Self-Service and sends a real push notification to every subscribed employee with a shift on one of those specific days; you don\'t have to finish scheduling the whole month before publishing any of it. The badge shows "◐ x/y Published" when only some of the visible days have been published so far. Editing after publishing doesn\'t auto-notify again — use Re-Publish + Notify if you want another push out. A red hatched cell means that employee has an approved leave request that day — assigning a shift there asks for confirmation instead of silently double-booking them. A collapsible "Shift Swap Requests" panel above the board shows swaps employees have already agreed between themselves and are waiting on your final Approve/Reject; a second collapsible "Swap History" panel on the same card lists everything already decided (approved, rejected, declined by the coworker, or cancelled), including who approved/rejected it and when.',
    tips: [
      'Plan the roster before the month starts — it helps forecast labour cost and avoids scheduling conflicts',
      'Roster is for planning; Attendance is the official record that feeds payroll — use ⚡ Generate from Roster on the Attendance page to pull shift assignments across as a starting point instead of retyping them',
      'Click and drag across cells to assign the same shift to multiple days/staff at once, instead of one click per cell',
      'Each employee can only have one shift per day — assigning a new one replaces whatever was there before',
      '"Clear (Unassign)" at the bottom of the shift picker removes the assignment entirely — the cell goes blank and that day disappears from the employee\'s own Self-Service roster (there\'s nothing to show). To actually mark someone off in a way that still shows up everywhere, assign a real shift type instead — e.g. the built-in "Day Off" (0h) — not Clear',
      'The Shifts tab lets you rename, recolour, and adjust the hours of any shift to match your venue\'s terminology',
      'To mark someone\'s recurring day off, assign the "Day Off" (or any zero-hour, off-named) shift type on the Roster board for those dates — Attendance → Generate from Roster then picks it up as an Off day automatically',
      '🖨 Print shows the Company Name/Address, the period, and the shift legend above the board — no Excel export, print/Save-as-PDF only',
      'Publish is per day — self-service employees never see a draft day, only what you\'ve explicitly published, even if the rest of the month is still being worked on',
      'Publish from Weekly view to release just that week; Publish from Monthly view releases every day in the visible month in one click — use whichever fits how you plan',
      'Shift Swap: an employee requests a trade with a coworker from their own Self-Service Roster tab; the coworker must accept before it lands in your Shift Swap Requests panel for final approval — approving actually trades who\'s scheduled on each day',
      'Swap History keeps every decided request, not just the last one — useful for resolving "I thought I was working that day" disputes without digging through Attendance',
      'Leave-conflict cells (red hatching) still let you assign a shift with a confirm — useful if a leave was approved in error and needs overriding',
      'Labor Forecast tab: one row per day (Weekly or Monthly, same navigation as the Board) showing Scheduled Hours, Forecast Revenue, Planned Labor Cost, Cost %, Recommended Staff, Scheduled Staff, and a Covered/Short status badge — deliberately kept off the Board and out of print since it\'s management-only data, not something to hand to staff',
      'A day shows "—" for forecast columns until Demand Forecast has been run/refreshed for that date on the Demand Forecast page',
      'A festival/holiday badge next to a date on the Labor Forecast tab means Demand Forecast matched it against Holiday Calendar — "×N" means that day\'s Forecast Revenue/Covers were scaled by the Demand Multiplier set on that holiday; no "×N" means the holiday is known but no multiplier has been set yet, so the forecast is unadjusted for it — set one in HR → Holiday Calendar if this is a day your business runs noticeably busier or quieter',
      'Recommended Staff = forecasted covers ÷ Covers/Staff target (editable on the Labor Forecast tab, saved per client, default 20) — a starting estimate, not a hard rule',
      'Cost % turns amber above 35% of that day\'s forecasted revenue',
      'On the Board itself, a short-staffed day\'s column header shows a small "Rec: N" hint (amber if you\'re currently under it) — hidden from print, screen-only, so you see the target while you\'re actually assigning shifts',
      '✨ next to a short-staffed "Rec: N" opens Suggest — a ranked pick of who to schedule (fewest hours scheduled this period first, among whoever the Department filter currently shows) — pick a name, then pick their shift, same as assigning normally',
    ]
  },
  {
    icon: '🏖️', name: 'Leave',
    guide: 'Tracks leave entitlements, requests, and balances. New clients start with Nepal\'s Labour Act 2074 leave types pre-loaded — Home/Annual (18 days), Sick (12), Bereavement (13), Maternity (98), Paternity (15), and Unpaid — which an admin can edit on the Leave Types tab. Record a request on the Requests tab (employee, type, BS start/end dates, reason); every calendar day in the range counts against the balance — there\'s no automatic exclusion for a recurring off day, so adjust the dates if the employee has one within the range. For a single-day request, a Day Type choice appears — Full Day, First Half, or Second Half. An admin approves or rejects: approving automatically marks those days in Attendance as Paid/Unpaid Leave (or the Half-day equivalent), so Payroll deducts unpaid leave on its own — a half-day of a paid leave type costs nothing, a half-day of an unpaid type deducts half a day. The Balances tab shows each employee\'s used / quota per leave type for the year, with an Excel export.',
    tips: ['Six Nepal Labour Act leave types are seeded automatically the first time you open the page', 'Every day in the picked date range counts against the balance — there\'s no automatic day-off exclusion, so double-check the range if it spans a day the employee doesn\'t normally work', 'Day Type (Full Day / First Half / Second Half) only appears when Start and End date are the same — it forces back to Full Day for a multi-day range', 'Half-day requests count as 0.5 in the balance and on Attendance, and respect the leave type\'s paid/unpaid flag same as a full day would', 'Approving a request writes the Attendance rows for you; rejecting or cancelling an approved request reverts those days to Present', 'A matching monthly Period must exist for the leave dates — if not, approval warns you which month to create, then re-approve', 'Unpaid leave flows into Payroll as an absence deduction; paid leave does not reduce pay', 'Maternity (98 days) and Paternity (15) are per-event statutory entitlements, not annual quotas', 'Carry-forward is recorded for reference but unused days do not yet roll over automatically']
  },
  {
    icon: '📆', name: 'Holiday Calendar',
    guide: 'Per-client list of Nepal public and optional holidays for each fiscal year. Two types: Public (gazetted by the Nepal government — all staff entitled to the day off; working on a public holiday attracts 2× overtime under the Nepal Labour Act) and Optional (floating holidays at employer discretion). Use "Seed Fixed" to add the 5 fixed-date gazetted holidays automatically (Constitution Day on Ashwin 3, Prithvi Narayan Shah\'s Birthday on Poush 27, Martyrs\' Day on Magh 5, National Democracy Day on Falgun 7, and Republic Day on Jestha 15). Movable holidays — Dashain, Tihar, Holi, Buddha Jayanti, Teej, Chhath, Eid-ul-Fitr, Eid-ul-Adha, and others — must be added manually each year from the Nepal government gazette, as their dates shift annually by the lunar calendar. Each holiday can optionally carry a Demand Multiplier (e.g. 0.3 for a day you close/run quiet, 1.5 for a day you\'re slammed) — set it once per specific date and it automatically scales that day\'s covers/revenue/item forecast on the Demand Forecast page and Roster\'s Labor Forecast tab; leave it blank and the day is still flagged, just not adjusted. Holidays are stored per fiscal year and scoped to each client.',
    tips: [
      '"Seed Fixed" adds only the 5 gazetted holidays with a fixed BS date every year — it skips any that already exist, so it is safe to click again after adding movable ones',
      'Movable holidays must be added manually each year: Dashain (7th-day through Vijaya Dashami), Tihar (Laxmi Puja + Mha Puja), Holi, Buddha Jayanti, Teej, Janai Purnima, Chhath, and Eid dates — check the Nepal government gazette annually',
      'FY selector groups holidays by fiscal year (Shrawan to Ashadh). Months 4–12 use the FY start BS year; months 1–3 use the following BS year — the "stored as BS year" hint in the form confirms which year a date maps to',
      'Public holidays feed into Overtime Management for automatic 2× rate suggestion when OT is logged on a holiday date',
      'Demand Multiplier is per specific date, not per holiday name — Dashain Tika might be 0.2 (closed) while the days right after might be 1.6 (family outings), so set each occurrence individually rather than expecting one "Dashain" setting to apply everywhere',
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
    icon: '🧮', name: 'Calculation',
    guide: 'A read-only page that shows the exact math behind every number Payroll displays, per employee — one step above the Payroll page in the workflow. It never generates or saves anything; every figure is computed live, right now, from current Attendance, Roster, Overtime and Advances data, using the same functions Payroll itself uses. Click any employee row to expand a full breakdown: attendance tally, the absence-deduction formula worked out step by step, overtime split by source (attendance sheet vs. approved Overtime entries), SSF, a full TDS derivation (year-to-date gross, projected annual tax, cumulative due, already withheld), advance and TADA detail, and the final Net Pay reconciliation.',
    tips: ['Because it\'s always live, this page also catches a stale Payroll run — if something in Attendance or Overtime changed since Payroll was last Generated/Regenerated, the affected employee is flagged "⚠ Stale" with both numbers shown side by side', 'When an employee has OT in both places, the expanded panel shows the attendance-sheet vs. approved-Overtime split — approved entries supersede the attendance sheet day by day, so you can see exactly which hours were paid and which were displaced', 'Use this before Finalizing a payroll run whose numbers look off — it will show you exactly which input (an absence count, a TDS projection, an OT source) produced the number you\'re questioning', 'Every formula is fully exploded step by step — Gross Salary lists Basic + each allowance component, Overtime shows hours × rate × multiplier for both the attendance sheet and the Overtime module separately, Absence Deduction and TDS walk through every intermediate number — nothing is hidden behind a hover tooltip, since this same panel is what prints', 'Click 🖨 Print on an expanded employee row to print (or save as PDF) that one employee\'s full calculation sheet — useful as backup documentation for a number you had to defend', 'Nothing here writes to the database — it\'s purely for verification, safe to open any time']
  },
  {
    icon: '💵', name: 'Payroll',
    guide: 'Runs monthly payroll for a BS period by combining each employee\'s salary structure with their attendance. Click Generate Payroll to create a draft register: monthly staff get basic + allowances minus SSF, unpaid-absence deductions, and other deductions; daily/hourly staff are paid for actual days/hours worked; everyone gets overtime at 1.5×. Edit TDS (income tax) inline while the run is a draft, Regenerate to pull the latest salary and attendance, then Finalize to lock the payslips as a permanent record. Each employee has a printable payslip, and the whole register exports to Excel.',
    tips: ['Mark attendance for the period first — payroll reads present days, hours, and overtime from it', 'A run is Draft until you Finalize it — finalized payslips are frozen even if you later change a salary', 'SSF (11% employee / 20% employer) is applied only to employees who have an SSF number on file', 'Unpaid-absence deduction = gross (basic + allowances) ÷ days in the BS month × unpaid days — an unpaid day forfeits the whole day\'s pay, and SSF is contributed on the basic actually earned',
'Overtime can be entered on the attendance sheet or approved in the Overtime module. Where a day has both, the approved entry wins and the attendance hours for that day are ignored — the same hours are never paid twice. Holiday OT at 2× is only available through the Overtime module', 'TDS (income tax) is computed automatically from the fiscal-year tax slabs using year-to-date projection — finalize earlier months first so each month builds on the last; you can still override a value while the run is a draft', 'SSF contributors get the 1% first-slab social security tax waived, so most staff under roughly NPR 83,000/month gross pay zero income tax', 'SSF is deducted only when an employee is BOTH marked SSF-enrolled and has an SSF registration number saved in Pay Setup — an enrolled employee with no number contributes nothing and is flagged "⚠ SSF no. missing" in the payroll list, because a contribution with no number cannot be filed on the SSF challan', 'The TADA column auto-fills from that employee\'s Approved TADA Claims for this period (a 🔗 icon marks a claim-linked amount) and is added after TDS, on top of net pay, without running through tax or SSF — a non-taxable add-on. You can still hand-edit or clear it. Finalizing marks those linked claims Paid in TADA Claims (so the same trip is never reimbursed twice); Reopen reverts them to Approved.', 'Use the Payslip button on any row to view and print an individual payslip', 'The payslip header shows your company name, address, and PAN (from Settings) plus the employee\'s SSF number when they\'re SSF-enrolled — fill in Settings → Property Address/PAN if the header looks incomplete']
  },
  {
    icon: '📊', name: 'HR Reports',
    guide: 'Turns a finalized payroll run into the documents you file and pay with. Five tabs: Payroll Summary (totals + employer cost by department), SSF Challan (per-employee 11% + 20% = 31% to deposit), Bank Transfer (each employee\'s bank and net pay), TDS Report (income tax this period + year-to-date), and TDS Certificate — a printable per-employee annual certificate for the whole fiscal year showing month-wise gross/SSF/TDS, taxable income computation (including insurance deductions), and signature blocks. Every report except TDS Certificate exports to Excel; the bank list also exports to CSV.',
    tips: ['Finalize the payroll run first — reports read finalized payslips (a draft shows an amber warning but still previews)', 'SSF Challan lists only employees with an SSF number and shows the grand total to deposit', 'SSF\'s own SOSYS portal has no bulk-upload feature (verified against the official SOSYS manual) — Collection is typed in one employee at a time. The SSF Challan sheet is meant as your reference while doing that: type each employee\'s SSF No + SSF Basic into SOSYS, and its calculated deposit should match this sheet\'s Total 31%.', 'Bank Transfer flags employees missing bank name or account number in amber — fix them on the Employee record', 'TDS YTD sums income tax across all finalized months of the current fiscal year', 'TDS Certificate: select fiscal year + employee — the certificate covers all finalized payslips for that employee in that FY; print it from the browser for a PDF copy', 'TDS Certificate shows the employer PAN line blank — fill it in by hand before handing to the employee (employer PAN is not stored in the system)', 'Employee PAN is shown on the certificate from the employee record — add it in HR → Employees if missing']
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
  {
    icon: '🧳', name: 'TADA Claims',
    guide: 'Tracks travel, transport, and daily-allowance expense reimbursements — actual itemized expenses, not a rate-based per-diem formula. A claim can come in two ways: entered here by a manager/admin/owner picking the employee, or submitted by the employee themselves from their Self-Service TADA tab (either way it lands as Pending, same approval flow). Add expense line items under Transport, Lodging, Daily Allowance, or Other with a description and amount each. A Manager approves or rejects the claim, then marks it Paid once reimbursed, recording the payment method — or an Approved claim gets folded into that employee\'s next Payroll run instead (see below) and is marked Paid automatically from there.',
    tips: ['Employees can submit their own claims from Employee Self-Service → TADA (no manager entry needed) — they still can\'t approve, reject, or mark their own claims Paid', 'Add as many expense line items as needed per claim — the total is the sum of all items', 'Only Pending claims can be approved or rejected; only Approved claims can be marked Paid', 'Approve, Reject, Delete, and Mark Paid all sit on the claim row itself, so a long pending list never needs scrolling to act on it — click a row to expand its expense lines directly underneath when you want to check what was actually spent before deciding', 'Mark Paid records the payment method and timestamp for your own record-keeping — it does not touch payroll', 'An Approved claim whose trip dates fall inside a payroll period auto-fills into that employee\'s TADA column in Payroll Run and gets marked Paid (method "Payroll") when that run is Finalized — so pay it out by hand here, OR let Payroll pay it, never both', 'Start Point is a second dropdown next to Destination (where the trip began) — same preset-list-plus-"Other" shape as Purpose, editable from ⚙ Settings', 'When Purpose is "Purchase," a vendor picker appears under Destination — selecting a registered vendor just fills in its name as the Destination text (no separate vendor record is linked to the claim)', 'A Transport line shows a Vehicle picker (2-Wheeler/4-Wheeler/EV) and a Distance (km) field — Amount fills in automatically as Distance × that vehicle\'s configured Rate/KM. You can still hand-edit Amount afterward if needed (e.g. to add a toll).', 'Rate/KM itself comes from ⚙ Settings and can\'t be overridden here unless you\'re an owner/admin — if a vehicle shows "No rate set," ask an owner/admin to configure it, or just enter Amount manually.', 'The ⚙ Settings button (owners/admin only) sets each vehicle\'s Rate/KM, Purpose options, and Start Point options offered when starting a new claim — both preset lists always have an "Other" choice for a one-off entry.', 'Start Date and End Date default to today when you open + New Claim — change them if the trip already happened or is scheduled ahead.']
  },
  {
    icon: '🎁', name: 'Incentives / Bonus',
    guide: 'Runs one-off bonus or incentive events — sales bonuses, performance incentives, spot awards — separately from monthly payroll, using the same Generate → draft → Finalize → Reopen flow as Festival Allowance. First define reusable incentive "types" under Manage Types (Fixed amount, % of Basic, or Manual entry), then start a named run (e.g. "Q1 Sales Bonus 2083"), pick a type, and Generate to seed a draft amount per employee based on the type\'s calculation rule. Amounts and notes are editable while draft; TDS is computed at each employee\'s marginal income tax rate the same way Festival Allowance does. Finalize to lock; an admin can Reopen if needed.',
    tips: ['Fixed pays the same amount to every employee in the run; % of Basic scales with each employee\'s basic salary; Manual starts every employee at 0 for full custom entry', 'Manage Types is where you define reusable incentive categories once — reuse the same type across multiple runs', 'Like Festival Allowance, this is a one-off event, not a recurring monthly salary component — it does not auto-run every payroll cycle', 'Export the finalized run as Excel/CSV for a bank-transfer file']
  },
  {
    icon: '📱', name: 'Employee Self-Service',
    guide: 'Gives employees a PIN-based login (no email/password) on their own phone to see their shifts, payslips, leave and travel claims — without access to the main admin app. Enable it per employee from Employees → Enable Self-Service, setting an initial PIN, then share the link via Employees → Copy Self-Service Link; the same link works for everyone at your company and each person picks their name and enters their PIN. It is built as a phone app rather than a web page: tell staff to add it to their home screen and it installs as "Crest Staff" with its own icon, opening full-screen with no browser bars. Four buttons run along the bottom. Home shows today\'s shift, the next day they actually work (days off are skipped), any swap request waiting on them, and their latest payslip. Roster shows their own Sunday–Saturday week with today marked, plus their swap requests. Requests holds Leave and TADA, each opening as a form that slides up from the bottom of the screen. Pay lists every finalised payslip; tapping one opens the full document. Light or dark follows the phone\'s own setting, since employees cannot reach Settings → Appearance. Notifications live under the ⋯ menu at the top right, and it only offers a button where pressing one can actually work — on an iPhone the app has to be added to the Home Screen first, because iOS never gives notifications to a browser tab, so opening the link inside a WhatsApp chat shows that instruction instead of a dead button. An employee can only ever see their own data, never a colleague\'s — enforced at the database level, not just hidden in the UI.',
    tips: ['One shared link per company — copy it from Employees and send it to your team (e.g. via WhatsApp)', 'Tell staff to add it to their home screen: on Android the ⋯ menu offers a button, on iPhone it is Share → Add to Home Screen. On iPhone that step is also what makes notifications work at all', 'The app opens on today\'s shift, so "am I working, and when?" is answered before anyone taps anything', 'A day the roster has not been published yet says so, instead of looking like a day with no shift — those two look identical in the data and mean very different things', 'Request Swap only appears on days the employee actually works — it used to show on days off too, which asked a colleague to trade for nothing', 'Leave requests submitted through self-service go through the exact same approval flow as leave submitted by an admin', 'A single-day leave request shows a Day Type choice (Full Day / First Half / Second Half), same as the admin Leave page', 'TADA claims are entered one expense line at a time, with the running total shown before submitting', 'Sign out lives in the ⋯ menu rather than on every screen — it is not the second most important thing an employee does'],
  },
  {
    icon: '👥', name: 'HR Staff', path: '/hr/staff',
    guide: 'Assign HR roles to your team. Staff log in with their own email and password (same mechanism as the Owner account) — distinct from Employee Self-Service, which is a PIN-based portal for an individual employee\'s own payslip/leave view. Roles: Staff (Holiday Calendar only), Supervisor (+ HR Dashboard, Attendance, Leave, Overtime, Staff Roster, TADA Claims), Manager (+ Employees, Pay Setup, Payroll/Calculation, all HR Reports, Festival Allowance, Incentives, Advances, Gratuity, Final Settlement, and staff role assignment — full Owner-equivalent access). Requires Manager role or above. Until this existed, HR was Owner/Admin-only with no delegation possible.',
    tips: ['Start by assigning your own account the Manager role first if you plan to hand day-to-day HR Staff management to someone else', 'A staff account with no role assigned cannot see any HR pages — the HR section is hidden from their sidebar entirely', '+ Add Staff defaults to picking an existing HR Employee instead of typing a fresh name — the HR staff login is linked to that employee record (shown with a 🔗 HR tag) so the name never drifts out of sync', 'A POS or IMS staff account, or an Employee Self-Service login, cannot also be assigned an HR staff role on the same login — create a separate account for that person\'s HR access instead', 'Reset Password sets a new password immediately — there is no email/reset-link flow, so share the new password with the staff member directly']
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
const POS_FEATURES = [
                {
                  icon: '🔐', name: 'POS Login', path: '/pos/login',
                  desc: 'The PIN entry screen that POS staff see when opening the system. Each staff tile shows a colorful initials avatar (like Slack/Gmail) so staff can spot their own tile at a glance on a shared device, without needing to read every name. Staff tap their tile and enter their 4–6 digit PIN to access the POS. The Owner button (top-right) lets the property owner log in with their full email + password for manager-level access. Only staff with a POS role assigned appear on the screen.',
                  tips: [
                    'PINs are set or reset in POS → Staff — staff cannot change their own PIN',
                    'Only staff with a POS role assigned appear on the login screen; users without a role see nothing',
                    'Forgotten PIN? Go to POS → Staff → Reset PIN beside the staff member\'s name',
                    'The Owner login gives full access — share it only with trusted management',
                    'Avatar colors are assigned automatically and stay fixed per staff member — they don\'t change when other staff are added or removed',
                  ],
                },
                {
                  icon: '🖨', name: 'Silent Printing Setup',
                  desc: 'By default, every print in Crest POS (KOT/BOT tickets, bills, Complimentary Slips, Shift Opening/Cash Settlement slips) opens your browser\'s normal print dialog. On a dedicated till, you can skip that dialog entirely — the browser sends the job straight to the printer the moment Print fires. This is a one-time setup on each POS device, not something toggled inside the app.',
                  tips: [
                    'First, set your receipt/thermal printer as the Windows default printer (Settings → Printers & scanners) — silent printing always targets whatever the OS considers default, not whatever\'s selected inside Chrome',
                    'Close every open Chrome window on the till, then edit (or recreate) the desktop shortcut used to launch Crest POS — right-click → Properties → Target — and append a `--kiosk-printing` flag after the .exe, e.g. "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing https://your-crest-url.com',
                    'Optional: add `--kiosk` as well for a full-screen locked-down till (no address bar, no tabs) — not required just for silent printing, but common on dedicated POS terminals',
                    'Microsoft Edge works the same way — same `--kiosk-printing` flag, launched from msedge.exe instead of chrome.exe',
                    'Always launch the till from this shortcut, never a normal browser icon — a normal window still shows the print dialog even with the printer set as default',
                    'This is a browser/OS setting, not a Crest feature — there is no in-app switch for it, and it cannot be configured remotely by Crest Admin',
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
                    '▦ QR on each table card generates that table\'s guest-facing digital menu — a page a customer sees after scanning it on their own phone, no login needed. Print it and place it on the table. Add a description, photo URL, and Veg/Non-Veg tag per dish in Recipes to make it richer; nutrition facts appear automatically if your plan has Nutrition Facts enabled. Once a table\'s order is sent to the kitchen/bar, the guest also sees a live Sent / Being prepared / Ready to serve badge on their phone — the same status Order Taking and Kitchen Display show staff, no extra setup needed. Once kitchen/bar staff enter an estimated prep time on Start (Kitchen Display), the guest\'s "Being prepared" badge also shows "about X min left"',
                    'The guest menu has a ⚙ Filters button whenever any dish has a Veg/Non-Veg tag or allergen info set — lets the guest show vegetarian-only, or hide items containing a specific allergen, without you having to do anything extra. It only appears if that data exists on at least one dish',
                    'Guest QR self-ordering (Pro plan): with this enabled, the guest menu also lets the customer add items, pick how many are dining, and submit their own order — it never goes straight to the kitchen. It lands as a request a staff member must Accept (or Dismiss) from Order Taking first, so nothing gets cooked without a human check. The guest sees a status card with exactly what they ordered, tracking through Placed → Confirmed → Sent to Kitchen → Preparing → Ready as staff progresses it, with a small chime on their own phone each time it moves to the next stage — and once the kitchen/bar has actually started (an estimate was entered on Start), the Preparing stage shows "about X min left" instead of just "Being prepared"',
                    'Ticket Routing: go to the Ticket Routing tab to set which categories print at the kitchen (KOT) vs the bar (BOT). Default is Beverage → BOT, everything else → KOT',
                    'Quick Notes: add preset instruction chips (e.g. "No onion", "Extra spicy") in the Quick Notes tab — staff can tap them instead of typing when adding a note to an order item',
                    'HSC Codes: set an optional Harmonized System Code per item in the HSC Codes tab — only needed for items that are imported goods sold as-is (e.g. imported bottled drinks). Leave blank for freshly prepared dishes; prints on the bill if set',
                    'Discounts: customize the list of reasons staff can pick when applying a discount at Charge, in the Discounts tab — comes preloaded with common reasons (Loyalty customer, Manager goodwill, etc.), fully editable',
                    'Delivery Partners: the Delivery Partners tab is a fully editable list of aggregators (comes preloaded with Foodmandu and Pathao, but add, rename, or remove platforms as those partnerships change) — each with its own Commission % and Buyer Phone. Commission % is just a starting suggestion used when you settle that platform\'s bill in Customers → Outstanding Credit, not something applied automatically at Charge (the platform doesn\'t pay you at the counter, so there\'s nothing to calculate yet when the bill closes). Buyer Phone is a placeholder number the Credit quick-select fills in at Charge so every order from that platform groups under one customer record — change it to a real account/reference number if you have one. No live order sync with any platform (that needs a real API partnership)',
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
                    'Use the search box above the category tabs to find an item by name — filters within whatever category tab is currently active',
                    'Every order gets a sequential order number (#1, #2, …) shown in the top bar and printed on each KOT/BOT ticket — kitchen, bar and bill all reference the same number',
                    'Printed tickets carry your outlet name and who took the order (Taken by), so the station knows who to call with questions',
                    'Ticket dates print in the Bikram Sambat (BS) calendar, matching the rest of the app',
                    'Tap "+ Add note" under any order item to send a special instruction (e.g. "no onion") to the kitchen/bar — it prints indented under that item on the ticket. Preset chips from Table Management → Quick Notes appear while you type',
                    'Editing or adding a note after a ticket was already sent clears its ✓ sent badge — press KOT/BOT again to send the update to the station',
                    'Tapping an item may show quick-add suggestion chips underneath it — what you get depends on your plan: Starter shows a simple nudge toward a category you haven\'t ordered from yet (e.g. no drink yet); Growth adds manually-configured pairings (a gold "PAIRED" chip, set up in Menu Pricing → Pair for POS-only clients); Growth with Crest IMS also adds real "frequently ordered together" suggestions from your own sales history; Pro with Crest IMS adds the full Menu Engineering-driven ranking, including an amber "CHEF\'S PICK" chip for Puzzle items worth pushing',
                    'The floor view shows an amber "⚠ pending" pill and per-table badge for any table with items added but not yet sent to the kitchen/bar — a quick way to catch orders that were never fired',
                    'Charge → closes the table — Supervisor role or above only, hidden entirely for Staff. Pay collects Cash/Card/eSewa/Khalti/FonePay and prints a Tax Invoice or Bill; Complimentary closes a walkout or comp — ₨0 is collected but it still counts against food-cost/inventory reporting; Void cancels a mistake with no revenue impact and is only visible to the owner/admin login by default — a manager can grant "Allow Void" to a specific trusted staff member in POS Staff so they can void without waiting for the owner',
                    'Discount on the Pay tab can be capped per staff member — set a Discount Limit (%) for a login in POS Staff and their entered discount is automatically capped at that %, however they type it (flat NPR or percent). Leave it blank for unlimited (the default, and always the case for the owner/admin login)',
                    'Foodmandu/Pathao orders close as Credit, not their own payment method — the platform doesn\'t pay you at the counter, it remits later minus commission, same as any other unpaid balance. Select Credit, then tap the Foodmandu or Pathao chip that appears (auto-fills the buyer) to mark which platform it\'s for. Track and settle it from Customers → Outstanding Credit — that\'s where the actual commission gets entered, once you know what the platform really withheld',
                    'Complimentary prints an internal Complimentary Slip, not a Tax Invoice or PAN Bill — its own sequential NC-01 style number (separate from Tax Invoice/Bill numbers), each line valued at food cost (not menu price) so comps don\'t distort your P&L',
                    'To comp just one dish instead of the whole table, stay on the Pay tab — an Items list (Supervisor+ only) lets you comp individual items with +/− qty steppers, down to part of a line\'s quantity (e.g. 1 of 3 Veg Momo) — the comped qty is removed from this bill and printed on its own mini Complimentary Slip (same NC-series numbering), while the remaining qty on that line and everything else still bills and prints normally, one Tax Invoice/Bill for the table',
                    'Both the Charge modal\'s total and item list switch to food-cost values while the Complimentary tab is open, and a live preview of the actual bill/slip layout appears in the modal as you fill in the fields — it always matches exactly what will print',
                    'Whether the printed bill says "TAX INVOICE" (with a VAT breakdown) or plain "BILL" (PAN only, no VAT) depends on the VAT Registered toggle an admin sets per client — see Settings below',
                    'Buyer Name/Address/PAN/Phone on the Charge screen are optional — IRD allows omitting them for bills up to NPR 10,000, but fill them in if a customer requests a full invoice',
                    'Discount on the Pay tab supports a flat NPR amount or a percentage (toggle between ₨/%) — it reduces the pre-VAT taxable amount, with VAT recalculated on the discounted base, not just subtracted off the total',
                    'Applying any discount makes buyer Name and Phone compulsory (not just optional) and requires picking a Discount Reason — gives an identifiable, audited record of who received it. Customize the reason list in Table Management → Discounts',
                    'Credit (red button, Supervisor role or above) closes the bill normally — it counts as a sale and consumes a Tax Invoice/Bill number — but no payment is collected now; the customer owes the amount. Buyer Name and Phone are compulsory, same as a discount. Collect it later from Customers → Outstanding Credit. The printed bill adds a Customer Signature/Date line, same as the Complimentary Slip, so there\'s a signed record of the debt',
                    'Split Payment: toggle from Single Payment to Split Payment on the Pay tab to collect one bill using more than one payment method (e.g. part eSewa, part cash) — add each tender\'s amount and method one at a time; a running Remaining balance tracks what\'s left, and cash change is calculated against that remaining balance, not the full bill. It\'s still one bill and one Tax Invoice/Bill number — only the collection is split, not the invoice. Not available with Credit. Only the most recent tender can be undone; to fix an earlier one, void the order and re-ring it',
                    'Each split tender can print its own small courtesy slip (🖨 next to the tender) — proof of that person\'s payment while the table is still settling up. It is not the Tax Invoice/PAN Bill, which still only prints once, at the very end, listing every tender',
                    '📄 Recent Bills (floor view) lists everything closed today and lets you reprint a bill — the first print carries no extra label (it is the original), every print after that is marked "COPY OF ORIGINAL - (N)" where N counts the copy itself (the 2nd print overall is copy 1, the 5th print overall is copy 4)',
                    'Scan-to-pay QR: once your admin pastes the outlet\'s merchant QR payload in Manage Clients → this client → QR tab, every bill carries a dynamic QR with that bill\'s exact amount pre-filled — the customer can\'t mistype it. The QR also appears in the Charge modal when eSewa/Khalti/FonePay is selected, updating live as discounts change. Payment confirmation is still manual — confirm once you see it land on your merchant app',
                    'Works offline for order-taking: if the connection drops, you can still open tables you\'ve already viewed this session, add items, and send KOT/BOT (an "📵 Offline" pill and a per-table "not yet synced" dot show what\'s queued) — everything uploads automatically once you reconnect and gets its real order number. A brand-new table opened offline shows "#— (pending)" until it syncs. A table whose order was never loaded on this device stays blocked offline rather than risk overwriting items you can\'t see. Charge/Payment always requires a live connection — Nepal\'s sequential invoice numbering can\'t be assigned offline',
                    'Guest QR self-ordering (Pro plan): if enabled for your restaurant, a pulsing 🔔 banner (with a one-time chime) appears at the top of the floor view the moment a guest submits an order from their phone — and the table itself glows so it stands out even if you\'re not looking at the banner. Tapping the banner or the table opens it straight to the order screen, with covers already filled in from what the guest entered (no re-typing on a numpad). A banner on that screen lists exactly what they ordered — Accept adds those items straight into your cart at the quantities they chose (adjust or add more before sending), Dismiss discards the request with no effect on the order. Nothing reaches the kitchen until you actually press Send Order/KOT, same as any item you add yourself. Enable it per client in Admin → Manage Clients → Features',
                  ],
                },
                {
                  icon: '▥', name: 'Kitchen Display', path: '/pos/kds',
                  desc: 'An on-screen ticket board for the kitchen/bar, running alongside printed KOT/BOT tickets — sending a KOT/BOT from Order Taking still prints exactly as before; this just mirrors it live on a screen. Switch between Kitchen (KOT) and Bar (BOT) at the top — pick whichever this device sits at, it remembers your choice. Each ticket moves New → In Progress → Ready with a tap.',
                  tips: [
                    'Tapping Start opens a calculator-style popup to enter the estimated prep time in minutes — required before the ticket can move to In Progress, with quick 5/10/15/20-minute preset buttons alongside the number pad',
                    'Once started, the ticket shows a live "~X min left" countdown (turning red if it runs over), and once Ready, "Done in Xm (est. Ym)" so staff can see at a glance how the estimate held up',
                    'The estimate also shows on the floor view in Order Taking (the Started badge on each table gains a "~X min" ETA), and feeds the Prep (Est/Actual) column in POS Reports → KOT Log → Register',
                    'An addition to an already-fired order shows up as its own new ticket, same as the second small paper ticket that prints for just the new items — not a change to the original ticket',
                    'A ticket\'s time-since-sent label turns amber after 8 minutes and red after 15 — a quick way to spot what\'s falling behind during a rush',
                    'Ready tickets stay visible for 10 minutes so staff can confirm pickup, then drop off the board on their own — they\'re never deleted, and still count in KOT Register/Reconciliation reports',
                    'Mount this on a tablet or spare screen at the pass — anyone with Staff role or above can open it, same PIN login as Order Taking',
                    'Printing is not replaced — if a client doesn\'t have a screen at a station yet, paper tickets keep working exactly as they do today',
                  ],
                },
                {
                  icon: '🅿', name: 'Parking Slips', path: '/pos/parking',
                  desc: 'Issue a printable parking token for a customer\'s vehicle — no order or table required, so a walk-in can get one before ordering. Enter the vehicle number (required), plus optional vehicle type, customer name, a linked bill, and notes. Requires Supervisor role or above to issue/print; any staff can view the log and mark a slip Exited once the vehicle is retrieved.',
                  tips: [
                    'Prints an 80mm thermal token with the vehicle number in large text — the single detail a valet reads back to reunite car with customer',
                    'Vehicle Type is a quick Two Wheeler / Four Wheeler toggle, not free text',
                    'Bill Number optionally links the slip to a bill already issued today (e.g. to honor a "free parking with purchase" policy) — only today\'s bills are listed, since a past day\'s bill is never the right one to link. Click the bill number in the log to view it',
                    'The Open tab shows only vehicles still parked; switch to All to see the full history',
                    'Mark Exited as soon as the vehicle is retrieved — it closes the slip and records who closed it',
                    'Reprint is available to any staff if the original token is lost',
                    'A slip left open past its day auto-closes the next time this page is opened, showing "Auto-Closed" instead of "Closed" — the record is kept, but it means staff never confirmed the vehicle actually left',
                  ],
                },
                {
                  icon: '👤', name: 'Customers', path: '/pos/customers',
                  desc: 'Customer book built automatically from billed orders — every bill closed with buyer Name + Phone (required for any discount or Credit sale) adds or updates a customer, keyed by phone number. The Outstanding Credit tab lists Credit bills awaiting collection with a one-tap Settle action. Requires Supervisor role or above.',
                  tips: [
                    'No manual data entry — the book fills itself as bills are closed with buyer details. Repeat customers are matched by phone number, so their name/address/PAN stay up to date automatically',
                    'Click any customer row to see their full order history — every billed order under that phone number, including payment method and any outstanding Credit',
                    'Outstanding Credit tab: when a customer comes back to pay, hit Settle and pick the method they actually used (Cash/Card/eSewa/Khalti/FonePay, or Cheque/Bank Transfer — the usual way a delivery platform or corporate account remits) — the bill is marked collected with who recorded it and when',
                    'A bill tagged Foodmandu or Pathao (an amber badge next to the customer name) shows a Commission % field when you Settle it — pre-filled from Table Management → Delivery Partners as a starting suggestion, confirm or adjust it to match what the platform actually remitted before picking the settlement method',
                    'The Who owes what table totals the ledger by counterparty — each delivery platform separately, plus one Direct customers row — so a balance can be chased per platform instead of read off a bill-by-bill list. It covers every Credit bill ever, settled and unsettled; for one month, and to check what a platform withheld against the rate you agreed, use Sales Report → Delivery Partners',
                    'The Age column shows how long each credit bill has been outstanding — chase the old ones first',
                    'Settling is Supervisor+ (routine cashier work); issuing credit at Charge stays Manager+ only',
                  ],
                },
                {
                  icon: '⚠', name: 'Sales Exceptions', path: '/pos/exceptions',
                  desc: 'Every discount, void, and complimentary in one report — revenue that leaked, filterable by BS date range, exception type, and staff member. Discounts show the amount knocked off; Voids show the menu value forgone (incl. VAT); Comps show food cost, matching the Complimentary Slip, plus a separate Potential Sales Value column showing what the comped item(s) would have sold for at menu price. Includes both whole-order Complimentary and individually item-comped bills (see Order Taking). Requires Manager role or above.',
                  tips: [
                    'The By Staff Member table is the report\'s real job — one cashier discounting far more than everyone else is worth a conversation (training gap or permission creep)',
                    'Staff are ranked by Revenue Impact — discounts + voided menu value + what comps would have sold for, all at sales value, so the total is one coherent number. Comp food cost stays visible in its own column',
                    'Attribution records whoever was signed in on the till when the bill closed. The till now locks back to the PIN screen after 3 idle minutes, so on a shared till that attribution stays honest — but treat an outlier as a starting point for a conversation, not proof',
                    'A quiet report is a healthy one — a sudden spike in voids usually means order-entry mistakes, not fraud',
                    'Amounts mean different things per type: Discount = NPR knocked off the bill, Void = full menu value that was cancelled, Comp = ingredient cost of what was served free (see Potential Sales Value for what it would have sold for instead)',
                    'Click any row to view the actual bill/slip in a new tab — same layout that printed, view-only (won\'t trigger your printer)',
                    'Use the ⬇ Excel button to hand the filtered list to your accountant — includes both AD date and BS Miti columns',
                    'Defaults to the current BS month — widen the range for a quarterly or fiscal-year view',
                  ],
                },
                {
                  icon: '↩', name: 'Credit Notes', path: '/pos/credit-notes',
                  desc: 'Formally correct an already-billed order — required by Nepal VAT Rules 2053, Rule 20 whenever the value of billed goods/services changes (billing errors, price corrections, tax corrections). Issue New searches past bills by BS date range or invoice number; Credit Note Book is the running register every Credit Note ever issued, as required by Rule 20(2). Requires Manager role or above.',
                  tips: [
                    'A Credit Note reduces this month\'s revenue (sales_entries) so Monthly Summary/Recipe Margin/Best Sellers stay accurate — it does not reverse stock/ingredient depletion, since the food was already served. This is a billing/tax correction, not a returned-food event',
                    'Only bills closed as Pay (not Complimentary or Void) can get a Credit Note — a Complimentary is already a ₨0 internal document, and a Void never had revenue to correct',
                    'Each bill can only be credited once — the Credit Note button disappears from a bill once one has been issued against it',
                    'The Credit Note prints with all 8 fields Rule 20 requires: serial number, date, your business details, the buyer\'s details, the original invoice number + date, item details, credited amount, and credited VAT',
                    'Reprints relabel automatically — no label the first time, then "COPY OF ORIGINAL - (N)" after that, same convention as the Tax Invoice',
                  ],
                },
                {
                  icon: '▤', name: 'Sales Report', path: '/pos/sales-report',
                  desc: 'Eleven views of the same POS sales data, one page: Daily (day-by-day totals), Hourly (revenue by time of day), Bill Register (every individual voucher — payment mode, remarks, who closed it), Comped Bills (every bill that had an item comped out of it, cross-referenced to its NC number), Payment Summary (revenue by Cash/Card/eSewa/Khalti/FonePay/Credit), Delivery Partners (every Foodmandu/Pathao bill from Credit through settlement), Category Wise and Item Wise (what drives revenue), Product Type (the same lines cut by an axis above category — Kitchen vs Bar, taxable vs non-taxable, veg vs non-veg), Customer Wise (who\'s buying and how much), and 1L+ Report (Nepal VAT Annexure 13 — parties whose cumulative transactions exceed NPR 1,00,000 in a fiscal year). Requires Manager role or above.',
                  tips: [
                    'Daily/Hourly/Bill Register/Comped Bills/Payment Summary/Delivery Partners/Category/Product Type/Item/Customer share one BS date-range filter; 1L+ Report uses its own Fiscal Year selector instead, since Annexure 13 is a whole-year compliance check, not an arbitrary range',
                    'Payment Summary groups the same VAT-ready Gross/Discount/Taxable/Net breakdown by how the bill was paid, so it reconciles against Daily and Bill Register totals for the same range — click a row to see just that method\'s bills in Bill Register',
                    'Delivery Partners lists every Foodmandu/Pathao bill (these close as Credit, not their own payment method — see Order Taking) with its settlement status; Outstanding rows have no commission/net figure yet since that\'s only entered when you Settle it in Customers → Outstanding Credit',
                    'The By Partner table above the bill list is the one that answers "what does Foodmandu still owe me, and what has Pathao taken?" — one row per platform with its outstanding balance, commission and net received. Click a row (or use the Partner dropdown) to filter the bills, the KPI cards and the Excel export down to that platform',
                    'Effective % is what a platform\'s commission actually works out to as a share of the ex-VAT, post-discount value of its settled bills — the basis Foodmandu and Pathao themselves calculate on. Set each platform\'s agreed rate in Table Management → Delivery Partners and any platform withholding more than agreed turns amber, with the gap shown in rupees. The per-bill Comm. % column then flags the individual bill responsible',
                    'Outstanding bills are left out of Effective % on purpose — they carry no commission until settled, so counting them would drag every platform\'s rate toward zero mid-month',
                    'The Excel export writes two sheets: By Partner (always every platform, with a Variance vs Agreed column) and Bills (whatever the Partner filter is showing, named in the letterhead so a filtered sheet says so)',
                    'Daily excludes bills that later got a Credit Note entirely — the revenue correction posts on the day the Credit Note is issued, not retroactively into the original bill\'s day. Bill Register instead lists every voucher and flags the ones later credited with a badge',
                    'Click any row on Bill Register to view that bill\'s actual Tax Invoice/PAN Bill in a new tab — the same layout that printed, view-only (won\'t trigger your printer). A bill with an item comped out of it also shows a "Comped (NC-xx)" badge right there',
                    'Comped Bills lists every item-level comp with the paid bill it came out of, valued both at food cost and at menu-price "Potential Value" — click a row to view that comp\'s own mini Complimentary Slip. Whole-order Complimentary orders don\'t appear here (they have no separate paid bill to cross-reference) — see Sales Exceptions for those',
                    'Category Wise and Item Wise both treat a credited bill\'s full quantity as "Return" (Crest has no partial/line-level returns) — a bill\'s discount is allocated proportionally so totals reconcile',
                    'Customer Wise groups walk-ins with no buyer details under CASH SALES',
                    '⚠ Missing PAN on the 1L+ tab means a party crossed NPR 1,00,000 without ever having their PAN recorded — worth asking for it on their next visit',
                    '⬇ Excel exports whichever tab is currently open',
                  ],
                },
                {
                  icon: '🍽', name: 'Covers Report', path: '/pos/covers-report',
                  desc: 'Guest-traffic analytics built from the covers number entered when a table is opened: average party size, revenue per guest (not per bill), how long tables actually turn over by party size, when covers peak through the day, and each server\'s covers/revenue. Requires Manager role or above.',
                  tips: [
                    'Revenue/Cover is the standard restaurant "average check per guest" metric — different from Sales Report\'s per-bill averages, since a bill for 6 people should read differently than a bill for 1',
                    'Turnover Time is bucketed by party size (1–2, 3–4, 5–6, 7+) because a 2-top and an 8-top have very different expected dine times — one blended average wouldn\'t mean much',
                    'Peak Hours buckets by when the table was opened (guests seated), not when the bill was paid — that\'s the number that tells you when to add floor staff',
                    'RevPASH (Revenue Per Available Seat-Hour) needs your Operating Hours set on the Overview tab first — without it, the card just prompts you to set them',
                    'By Server ranks staff by covers served, not bills — a server who takes fewer but larger tables can still lead here',
                  ],
                },
                {
                  icon: '🧾', name: 'KOT Log', path: '/pos/kot-log',
                  desc: 'Register is a queryable log of every kitchen/bar ticket ever sent. Reconciliation compares what was actually sent to the kitchen against what\'s currently on each order — the anti-fraud check that catches food cooked and served but quietly reduced, removed, or never billed. Bill Trail shows every paid/voided bill with its complete KOT/BOT history in one expandable view, including bills that never sent anything to the kitchen at all. Pulled Items names the person: every time a line the kitchen had already been sent was taken off a bill, with the reason they gave. Requires Manager role or above.',
                  tips: [
                    'Reconciliation only shows flagged rows — a quiet report is a healthy one, same philosophy as Sales Exceptions',
                    'A row flags when an item\'s total sent-to-kitchen quantity is more than what\'s currently on the order (cooked, then reduced or removed before billing)',
                    'Any KOT/BOT send on an order that ends up Voided is always flagged, regardless of quantity — the kitchen made food but zero revenue was ever recorded for it',
                    'Bill Trail is the complete picture — click a bill to expand its full ticket history. An amber "No KOT" badge means that bill never sent anything to the kitchen (could be a legitimate self-serve tab, or worth a second look); a red "Discrepancy" badge means the same issue Reconciliation flags',
                    'Pulled Items and Reconciliation answer the same question from opposite ends. Reconciliation INFERS a pull by comparing tickets against the order as it stands now, so it catches one however it happened but can never say who. Pulled Items is the record written at the moment of the removal — staff member, item, quantity, time and stated reason',
                    'Taking a line off a bill below what the kitchen already has now asks the person for a reason before it lets them. There is deliberately no rank gate on it — pulling a fired item is a routine, legitimate thing (the kitchen ran out, wrong item fired, customer changed their mind) and stalling a live service behind a manager would cost more than it catches. What was missing was the name against it, not the permission',
                    'A "none given" reason is not a fault — it means the removal reached the server by a path that could not ask, which today is an offline device syncing back hours later, or a till still running a bundle from before this shipped',
                    'The Register only goes back as far as this feature was added — sends from before that date were never logged',
                  ],
                },
                {
                  icon: '⏱', name: 'Shifts', path: '/pos/shifts',
                  desc: 'Open a shift with a starting cash count, watch live sales totals as the shift runs (X-report), and reconcile the drawer against expected cash when it ends (Z-report). Requires Supervisor role or above.',
                  tips: [
                    'Open Shift and Close Shift both count each note/coin (₨1000 down to ₨1) rather than a single total — more accurate, and matches how cash is actually counted',
                    'Current Shift is the X-report — a live, repeatable snapshot. Nothing about it is final; check it anytime during the shift without affecting anything',
                    'Close Shift produces the Z-report — a one-time, final reconciliation. Expected Cash = opening count + cash sales + cash in − cash out; Variance = what was actually counted minus that expectation. The figures are re-read the moment you close and then frozen onto the shift, so reprinting the Z-report later always shows exactly what was signed',
                    'Use ± Cash In / Out for money that moves without being a sale — paying a supplier from the till, a staff advance, or dropping a float to the safe. A reason is required, since this is a cash record. Without it the drawer and Expected Cash drift apart and the shift reports a variance it created itself',
                    'When a customer settles an older Credit bill in cash, that money is added to the open shift automatically (it shows as Cash In). Before, the bill stayed marked "Credit" forever and the cash appeared as an unexplained "over" on the drawer',
                    'The variance is shown live as you count the denominations, not just after closing — and closing more than NPR 100 out asks you to confirm the exact amount, so you can recount while the drawer is still open',
                    'A Balanced badge means the drawer matched exactly; red means short, amber means over — chase down shortages the same day while it\'s easy to remember why',
                    'You can run several shifts in a day (e.g. a morning cashier closes with a Z-report, an evening cashier opens a new one) — only one shift can be open at a time',
                    'Orders closed while no shift is open still bill normally — a missing shift never blocks Charge, it just means that order won\'t show up in any shift\'s totals',
                    'Shift History lists every past shift — click one to see its full frozen Z-report',
                  ],
                },
                {
                  icon: '👥', name: 'POS Staff', path: '/pos/staff',
                  desc: 'Assign POS roles to your team. Only staff with a role assigned can see POS screens. Roles: Staff (order-taking only), Supervisor (+ table setup, billing/Charge, Complimentary, Credit), Manager (+ Sales Exceptions report, role assignment). Void is owner/admin-only by default — grant "Allow Void" on a specific staff member here to delegate it. Requires Manager role or above.',
                  tips: [
                    'Start by assigning the owner/manager account the Manager role — they can then assign roles to the rest of the team',
                    'Staff role = waiters who take orders only. They cannot access Table Management or reports',
                    'Supervisor role is ideal for head waiters and floor captains who need to set table status and manage the floor',
                    'Users with no role assigned cannot see any POS screens — the POS section is hidden from their sidebar',
                    'If Crest HR is also enabled, + Add Staff defaults to picking an existing HR Employee instead of typing a fresh name — the POS login is linked to that employee record (shown with a 🔗 HR tag) so the name never drifts out of sync. Switch to POS-only Staff for someone who isn\'t in HR (e.g. a casual/part-time role).',
                    'Discount Limit caps how much % discount that login can give at billing — leave it blank for unlimited. Allow Void lets that login void a bill themselves instead of needing the owner/admin. Both default to unrestricted-off, i.e. unlimited discount and no void access, until set here.',
                    'A staff PIN session on a POS device locks back to the PIN screen after 3 minutes of no input (with a 20-second warning first) — so every bill, comp and void is recorded against the person who actually did it, not whoever signed in last. The Kitchen Display never locks, and owner email logins are unaffected.',
                  ],
                },
]

const ADMIN_FEATURES = [
                {
                  icon: '🔑', name: 'Staff Login (per client)',
                  guide: 'Every client card in Admin → Clients carries a "Staff Login ↗" button that opens that company\'s employee PIN login — the Crest Staff app — in a new tab. It is the same link the client\'s own manager shares with their team from HR → Employees → Copy Self-Service Link, but reachable without switching into the client first, without HR being enabled, and without holding a manager role. Right-click → Copy link address to send it on to a client.',
                  tips: [
                    'Signing in there with an employee PIN REPLACES your admin session in that browser — open a private window if you need to stay signed in as admin',
                    'The button is on every client, including ones with HR off; the tooltip says so, and the page shows an empty staff picker until someone is given a Self-Service login',
                    'Employees get their login from HR → Employees → Enable Self-Service, which sets their initial PIN',
                    'It opens in a new tab, so middle-click and ctrl-click work the way they do on any link',
                  ],
                },
                {
                  icon: '📱', name: 'Guest Menu Preview',
                  guide: 'Preview the currently-viewed client\'s guest QR menu without needing a printed QR code or asking the client for one. Pick a client in the sidebar switcher first, then pick one of that client\'s tables — the page embeds the exact live page a guest sees after scanning that table\'s QR (GuestMenu.jsx), including guest ordering if the client has that Pro-tier feature enabled.',
                  tips: [
                    'This is the real, live guest page, not a mockup — if guest ordering is on and you place an order, it creates a genuine pending order the client\'s own staff will see in POS Orders',
                    'Copy Link or Open in New Tab if you want to test on an actual phone instead of the embedded preview',
                    'If the client has no tables set up yet, add one in Tables first',
                  ],
                },
                {
                  icon: '◷', name: 'Audit Log',
                  guide: 'A full event log of every significant action in the system — creates, updates, deletes, period opens/closes, payroll runs, POS order voids/discounts/invoices, and admin client/feature changes. Every changed field is shown as old value → new value automatically, not just a hand-picked few, so a newly added field is covered the moment it exists. Filter by client, area, time range, or user, or search free text across all of those plus record IDs.',
                  tips: [
                    'Click a row\'s Details cell to expand every field that changed, not just the first three shown inline',
                    'Filter by "Area" to narrow down to IMS, HR, POS, or Admin actions',
                    'Filter by "User" or type into the search box to trace all actions by a specific person',
                    'A POS Order only logs meaningful transitions — void, discount, close, invoice — not every item added while the bill is still open',
                    '⬇ Export downloads the currently filtered rows as an Excel file',
                    'Admin can permanently delete matching entries with "Clear Logs" — this is not reversible, so audit history is only as durable as the last time someone chooses to keep it',
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
]

const GLOSSARY = [
  { term: 'Food Cost %',      def: 'Net Purchases ÷ Revenue × 100 — what you spent on stock this period against what you sold. The primary profitability metric for F&B operations. Industry benchmark: 28–35%. Note this is purchases-based, not consumption-based: it does not adjust for opening or closing stock, so a bulk restock makes it spike and it settles back over the month. Buy a month of rice in one go and an early-month reading can be well over 100% — the dashboards show a plain grey number with "settles at month end" until the figure is meaningful, rather than a red warning. For the consumption-based version that does account for stock, see COGS.' },
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
  { term: 'Prime Cost',       def: 'Food Cost % + Labor Cost % — the two controllable costs combined, as a % of revenue. The single figure most restaurant operators benchmark against directly (industry standard ≈60–65%). Shown on Owner Dashboard.' },
  { term: 'Book Stock',       def: 'Live stock count fed by Crest POS — decremented automatically on every POS sale/comp close, shown in the Reorder Report. Only reflects POS activity; physical stock count remains the source of truth. See Stock Movements for the itemised ledger.' },
  { term: 'SSF',              def: 'Social Security Fund (सामाजिक सुरक्षा कोष). Nepal mandatory contribution: 11% employee + 20% employer of basic salary.' },
  // — Crest HR —
  { term: 'TDS',              def: 'Tax Deducted at Source. Nepal\'s monthly income tax withholding on salary, computed via year-to-date cumulative projection against the current fiscal year\'s tax slabs.' },
  { term: 'Gratuity',         def: 'A lump-sum retirement/severance benefit under Nepal\'s Labour Act, accrued per year of service and paid at final settlement — separate from SSF.' },
  { term: 'CTC',              def: 'Cost to Company. Gross salary + Employer SSF contribution (20% of basic) — the employer\'s true monthly outlay, not the employee\'s take-home pay.' },
  { term: 'Dearness Allowance', def: 'महँगी भत्ता — a statutory monthly allowance separate from basic salary. Minimum NPR 7,380/month (set FY 2082/83, unchanged through FY 2083/84 — next review due Shrawan 2084). SSF is not computed on it.' },
  { term: 'Shift Type',       def: 'A named work-shift template (e.g. Morning, Evening, Split) with a colour and start/end time, defined in Roster → Shift Types and assigned to staff on the Roster Board.' },
  { term: 'Roster',           def: 'The weekly/monthly staff shift schedule. Planning-only — Attendance is the official record that feeds Payroll, though Attendance can be pre-filled from Roster via Generate from Roster.' },
  { term: 'Final Settlement', def: 'The full-and-final payment computed when an employee leaves — unpaid salary, leave encashment, and gratuity, minus any pending dues.' },
  { term: 'Festival Allowance', def: 'A statutory bonus (commonly tied to Dashain) equal to a proportion of annual basic salary, paid separately from monthly payroll with its own TDS treatment.' },
  { term: 'Overtime (OT)',    def: 'Extra hours worked beyond the standard shift, paid at 1.5× the normal hourly rate on weekdays and 2× on public holidays.' },
  // — Crest POS —
  { term: 'KOT / BOT',        def: 'Kitchen Order Ticket / Bar Order Ticket — the printed slip sent to the kitchen or bar when an order item is sent, listing items and quantities to prepare.' },
  { term: 'X-Report / Z-Report', def: 'End-of-shift sales summaries. X-Report is a read-only mid-shift snapshot; Z-Report closes the shift and resets running totals for the next one.' },
  { term: 'Credit Note',      def: 'A document that reverses a billed sale (VAT Rules 2053, Rule 20) instead of deleting the original invoice — used whenever a paid bill needs correcting or refunding.' },
  { term: '1L+ Report',       def: 'The "One Lakh and above" compliance report (Annexure 13) — lists every sale or purchase transaction of NPR 100,000 or more, as required for VAT recordkeeping.' },
  // — Crest IMS (Growth/Pro) —
  { term: 'Dead Stock',       def: 'Items with zero usage over the lookback window (Slow Movers = used less than 20% of available stock) — ingredients tying up money without turning over.' },
  { term: 'Shrinkage',        def: 'Recurring unexplained stock loss seen consistently across multiple periods — distinguished from a one-off Variance by checking period-over-period consistency.' },
  { term: 'Menu Engineering', def: 'Classifies menu items by popularity and profitability into four quadrants — Star (both high), Puzzle (popular but low-margin), Plowhorse (profitable but unpopular), Dog (both low) — to guide menu and pricing decisions. Note: this app\'s Plowhorse/Puzzle swap the traditional restaurant-industry meaning of those two words; the definitions here match what this app actually computes.' },
  { term: 'Demand Forecast',  def: 'A prediction of covers and revenue for upcoming days (7/30-day horizon), used to plan labour scheduling and purchasing.' },
  { term: 'Requisition',      def: 'An internal stock transfer from the main store to a department (e.g. kitchen, bar), tracked separately from external purchases.' },
]

// IMS_TIERS / HR_PRICING / POS_PRICING / SUITE_ADDON / MODULE_COLORS now come from
// ../data/pricingPlans — the single source of truth shared with Pricing.js and ClientDrawer.js.

const FAQ = [
  { q: 'How does the sidebar work? I have a lot of pages.', a: 'The sidebar has two parts: a narrow icon rail on the far left with one icon per module (Crest IMS, Crest HR, Crest POS), and a panel beside it showing only the selected module\'s pages. Click a module icon to switch panels — the panel also follows you automatically when you navigate (e.g. opening a POS page selects the POS panel). Inside the panel, pages are grouped by task (Operations, Costing, report categories) — click a group header to expand or collapse it; your choices are remembered on this device. The ‹ button near the bottom of the rail hides the panel entirely, leaving just the icon rail; Help and Sign out live on the rail too.' },
  { q: 'Why is my food cost % so high?', a: 'Common causes: purchases entered without closing stock (inflates COGS), over-portioning, wastage not recorded, theft, or supplier price increases not reflected in selling prices. Check the Variance Report to identify the biggest leaks.' },
  { q: 'What if I forgot to enter a purchase?', a: 'Go to Purchases, select the correct period, and add the entry with the correct day. The system recalculates everything automatically.' },
  { q: 'How do I correct a wrong entry?', a: 'Every entry has an Edit button. Click it, correct the values, and save. No need to delete and re-enter.' },
  { q: 'Why does my Variance Report show no theoretical usage?', a: 'Either you have not entered Sales Entries for the period, or the items have no Recipe built. Both are needed for theoretical usage to calculate.' },
  { q: 'Why did the Variance Report open on last month instead of this one?', a: 'Because variance can only be measured once the month\'s closing stock has been counted, which happens at month end. Mid-month there is no closing count, so everything still sitting on your shelves would be counted as "used" and every item would look over-consumed. The report therefore opens on the most recent closed month. You can still select the open month from the dropdown — it will tell you the count is missing and show the figures greyed out rather than flagging false losses.' },
  { q: 'Two reports show a different COGS for the same month — which is right?', a: 'They agree now. COGS is Opening + Net Purchases (after returns) − Wastage − Staff Meals − Closing, everywhere in Crest. Annual Summary used to leave staff meals out, so its COGS and food-cost % sat slightly below Monthly Summary\'s for the same month; that was fixed on 2026-08-13 and Annual Summary\'s figures for past months will have moved up a little as a result. Staff meals count as cost of goods because the food came out of the same stock.' },
  { q: 'On Purchases, the Total under the table does not match the Bill Total column. Why?', a: 'They are two different, both-correct figures, and both are now labelled. "Total goods value (ex-VAT)" is qty × rate before any bill discount and before VAT — that is what Stock Count and COGS use. "Total payable (incl. VAT)" is what actually leaves the bank, and that is what the Bill Total column adds up to. The difference is VAT minus discount.' },
  { q: 'Can two staff members enter data at the same time?', a: 'Yes. The system is cloud-based and supports multiple users simultaneously.' },
  { q: 'What happens to data when I close a period?', a: 'Closing a period locks it from further editing. All data is preserved permanently. You can view closed period reports at any time.' },
  { q: 'How do I add a new menu item to recipe costing?', a: 'Go to Recipe Costing → New Recipe. Add ingredients from your Item Master with qty per portion. The system calculates food cost instantly.' },
  { q: 'Why is there no sales line on the Dashboard "Purchases vs Sales" chart?', a: 'The sales line only plots when sales are recorded day-by-day. In Sales, pick a specific day and enter that day\'s quantities (rather than one bulk monthly total). Once a few days are entered, the green sales line appears, and with 5+ days in the current month a dashed month-end revenue projection is added. (When the POS module ships, it will feed daily sales automatically.)' },
  { q: 'Can I add many recipes at once instead of one line at a time?', a: 'Yes. In Recipe Costing, click ↓ Template to download a spreadsheet (one row per ingredient; recipe-level fields on the first row of each recipe). Fill it in Excel/Sheets — the template includes a "Your Items" sheet with your exact item names/codes/units to copy from — then click ↑ Import Excel. A preview shows what matched; unmatched ingredients are skipped (add those items to the Item Master first, then re-import). The ingredients must already exist as items because each item carries its own purchase rate and unit conversion. To copy a similar dish, use the Clone button on any recipe row.' },
  { q: 'Why won’t an item delete?', a: 'An item can only be hard-deleted if nothing references it. If it appears in any purchase, stock count, wastage, staff meal, requisition, vendor return, or recipe — even a zero-quantity one — the delete is blocked and you’ll see why. The best option is Hide: it removes the item from all lists and dropdowns while keeping its history intact. Admins also get a Force Delete option that erases the item and every record referencing it (this recalculates affected past reports and cannot be undone) — use it only for true duplicates/mistakes.' },
  { q: 'How do I quickly find an item in a long dropdown?', a: 'The item pickers in Purchases, Recipes, Stock’s Daily Wastage, and Requisitions are searchable — click the field and start typing to filter, then use ↑/↓ and Enter (or click) to choose. On Recipe Costing there is also a “Find ingredient in recipes” box that lists every recipe using a given ingredient, including ones where it’s inside a sub-recipe.' },
  // — Crest HR —
  { q: 'Why isn\'t SSF being deducted for an employee?', a: 'Check Pay Setup → Bank/SSF tab for that employee — the SSF Enrolled toggle must be switched on. It\'s off by default for new employees; until it\'s enabled, no 11%/20% SSF is computed anywhere, including Payroll.' },
  { q: 'How does Payroll handle unpaid leave?', a: 'Mark the day Unpaid Leave in Attendance (or approve an unpaid leave request in Leave Management, which marks it automatically). Payroll deducts unpaid days from monthly-basis staff and simply doesn\'t pay for that day for daily/hourly staff.' },
  { q: 'Why can\'t I delete an employee?', a: 'Because they still have TADA claims, incentive/bonus records or shift-swap requests on file. That history is kept on purpose — it covers money paid and approvals given, so deleting the employee would take real records with them. Use Deactivate instead: it removes them from payroll pickers, rosters and attendance while keeping everything. If you genuinely need them gone (a test entry, say), delete those entries first in TADA Claims, Incentives and Roster → Swap Requests, then delete the employee.' },
  { q: 'How do I stop a former employee logging into Self-Service?', a: 'Two options, depending on whether it is temporary. To suspend access but keep the account, tick their row on Employees and click Deactivate — Activate restores it, and neither affects payroll. To remove the login for good, click Remove next to their ✓ Self-Service badge; their PIN stops working immediately and the login is deleted. Both keep the employee record, payslips and leave history, and you can Enable Self-Service again later with a new PIN.' },
  { q: 'What does the "OT: 2 sources" note in Payroll mean?', a: 'It means the same employee has overtime in both the Attendance sheet\'s OT column and an approved Overtime module entry for this period. They are not added together: on any day an approved entry exists it supersedes the attendance sheet, so nothing is paid twice. Days with no approved entry still pay their attendance OT at 1.5×.' },
  // — Crest POS —
  { q: 'What\'s the difference between Void and Complimentary?', a: 'Void cancels a bill entirely — no sale is recorded. Complimentary keeps the sale on record (for stock/COGS purposes) but zeroes the amount charged to the guest. Complimentary needs Supervisor+ access; Void is owner/admin-only by default, though a manager can grant "Allow Void" to a specific staff member in POS Staff. Both require a reason.' },
  { q: 'Why didn\'t an item reach the kitchen printer?', a: 'Check POS → POS Staff → Ticket Routing — each category (e.g. Beverage) is routed to either the Kitchen or Bar ticket. An item in a category with no route configured won\'t print anywhere when sent.' },
  { q: 'Can I edit or delete a bill after it\'s been paid/closed?', a: 'No — once billed, an order can\'t be edited or deleted directly, so the original record is always preserved for audit. To correct a paid bill, issue a Credit Note, which reverses it instead of altering history.' },
  { q: 'What happens if my subscription expires?', a: 'You get a 7-day grace period first — everything keeps working normally and a red banner at the top of every page counts down the days left. After that, Crest locks and shows a renewal screen instead of the app. Nothing is deleted: your data stays exactly as it was, and renewing restores full access immediately. Free trials lock on the day the trial ends rather than getting the grace period, but trial data is still kept for the retention window shown on that screen.' },
  { q: 'Can I get a copy of all my data?', a: 'Yes — ask us and we can export your entire account to an Excel workbook: purchases, sales, stock, recipes, vendors, payroll, POS orders, the lot. You get a readable .xlsx plus a .json file that can be restored back into Crest later. It works whether your subscription is active or not, and your data is never deleted without a backup being taken first.' },
]

// ── Getting Started — Crest HR ────────────────────────────────────────────────
const HR_SETUP_STEPS = [
  { step: 1, title: 'Add your Employees', desc: 'Go to Employees → add each staff member with a name, designation, join date, and pay basis (monthly, daily, or hourly).', why: 'Every attendance mark and payslip is tied to an employee record here.' },
  { step: 2, title: 'Set up their Pay', desc: 'Go to Pay Setup → enter basic salary, allowances, SSF enrollment, and bank details for each employee.', why: 'Payroll can\'t compute anything until basic salary — and, if applicable, SSF enrollment — is set.' },
  { step: 3, title: 'Build your Roster', desc: 'Go to Staff Roster → assign shifts for the month. Optional, but unlocks ⚡ Generate from Roster in Attendance.', why: 'Without a roster, every day for every employee has to be marked by hand in Attendance.' },
  { step: 4, title: 'Mark Attendance', desc: 'Go to Attendance → click ⚡ Generate from Roster to pre-fill the month from what you scheduled, then adjust leave, offs, and OT by hand.', why: 'Payroll reads attendance directly — an incomplete month means an incomplete payslip.' },
  { step: 5, title: 'Run your first Payroll', desc: 'Go to Payroll → Generate Payroll for the period → review each payslip → Finalize.', why: 'Finalizing locks the run and is what actually commits net pay, SSF, and TDS for the month.' },
]
const HR_WORKFLOW_STEPS = [
  { step: 1, title: 'Confirm the period is open', desc: 'Periods → the current BS month should already be open from IMS, or create one if HR runs standalone.' },
  { step: 2, title: 'Update the Roster', desc: 'Staff Roster → adjust shifts for the month ahead as staffing changes.' },
  { step: 3, title: 'Mark / Generate Attendance', desc: 'Attendance → Generate from Roster, then handle leave, unscheduled offs, and OT day by day as the month goes.' },
  { step: 4, title: 'Approve Leave & Overtime requests', desc: 'Leave and Overtime → approve or reject pending requests before running payroll.' },
  { step: 5, title: 'Run Payroll', desc: 'Payroll → Generate → review TDS/SSF/deductions per employee → Finalize.' },
  { step: 6, title: 'Handle Advances & Festival Allowance', desc: 'Advances & Loans and Festival Allowance → process anything due this month; both feed back into the next payroll run automatically.' },
]
const HR_MISTAKES = [
  'Finalizing payroll before attendance, leave, and OT are fully settled for the period — Finalize locks the month, so anything entered late won\'t be reflected.',
  'Forgetting to switch on SSF Enrolled per employee in Pay Setup — it\'s off by default, and until it\'s on, no SSF is deducted or contributed for that employee anywhere, including Payroll.',
  'Assuming attendance-sheet OT and an approved Overtime entry add together — they do not: the approved entry supersedes the sheet for that day, and only the Overtime module can pay the holiday 2× rate.',
  'Finalizing months out of BS-calendar order — TDS is a year-to-date cumulative projection, so skipping ahead throws off the tax calculation for every month after it.',
]

// ── Getting Started — Crest POS ───────────────────────────────────────────────
const POS_SETUP_STEPS = [
  { step: 1, title: 'Set up your Tables', desc: 'Go to Tables → ⚡ Quick Setup to batch-generate a floor plan in one click.', why: 'Orders and billing are organised by table — there\'s nothing to bill against without them.' },
  { step: 2, title: 'Add Staff & PINs', desc: 'Go to POS Staff → add each team member with a role (Staff / Supervisor / Manager) and a 4–6 digit PIN.', why: 'Only staff with a role assigned appear on the POS login screen at all.' },
  { step: 3, title: 'Configure your Menu', desc: 'Go to Menu Pricing → add items with a menu price (and cost price, if you\'re not also running IMS Recipe Costing).', why: 'The order screen only shows items that exist here with On POS checked.' },
  { step: 4, title: 'Set up Silent Printing', desc: 'One-time device setup on a dedicated till — see the Silent Printing Setup guide below. Skip this if staff are fine using the normal browser print dialog.', why: 'Without it, every KOT/bill print pops a print dialog staff have to click through manually.' },
  { step: 5, title: 'Open your first Shift', desc: 'Go to Shifts → Open Shift → count the starting cash drawer.', why: 'Orders can be billed without an open shift, but they won\'t show up in any shift\'s reconciliation total.' },
]
const POS_WORKFLOW_STEPS = [
  { step: 1, title: 'Open Shift', desc: 'Shifts → Open Shift → count the starting cash drawer at the start of the day.' },
  { step: 2, title: 'Take Orders', desc: 'Orders → seat guests, add items, send KOT/BOT to the kitchen or bar.' },
  { step: 3, title: 'Bill & Close', desc: 'Charge the order when the guest is ready to pay — apply any discount or mark Complimentary, always with a reason.' },
  { step: 4, title: 'Close Shift', desc: 'Shifts → Close Shift at the end of the day → reconcile the counted cash against the system total → review the Z-report.' },
  { step: 5, title: 'Check the Sales Report', desc: 'Sales Report → review payment-method and category breakdowns periodically, not just at shift close.' },
]
const POS_MISTAKES = [
  'Not closing a Shift before opening a new one — only one shift can be open at a time, and orders billed with no shift open never show up in any reconciliation.',
  'Confusing Void with Complimentary — Void cancels the sale entirely (nothing recorded); Complimentary keeps the sale on record for stock/COGS but zeroes what the guest pays.',
  'Forgetting to configure Ticket Routing — an item in a category with no route assigned won\'t print to the kitchen or bar at all when sent.',
  'Letting staff share PINs — it breaks the per-staff accountability that Sales Exceptions and the audit trail depend on.',
]

export default function Help() {
  const { imsEnabled, hrEnabled, posEnabled, plan, isAdmin } = useAuth()
  const [activeSection, setActiveSection]         = useState('guide')
  const [expandedModule, setExpandedModule]       = useState(null)
  const [expandedFaq, setExpandedFaq]             = useState(null)
  const [pricingAnnual, setPricingAnnual]         = useState(false)
  const [searchQuery, setSearchQuery]             = useState('')
  const { settings } = useSettings()
  const navigate = useNavigate()
  const phone   = settings?.contact_phone   || ''
  const email   = settings?.contact_email   || ''
  const website = settings?.contact_website || ''

  // Per-module (IMS/HR/POS) collapse on the Module Guide tab — defaults *closed* (same
  // rolled-up-until-chosen pattern as the Getting Started tab's openGS below), so a Suite client
  // sees three clickable module headings instead of every feature card unrolled on first load.
  const [openModules, setOpenModules] = useState(() => {
    try { return JSON.parse(localStorage.getItem('crest_help_modules')) || {} } catch { return {} }
  })
  function moduleOpen(key, state = openModules) {
    return state[key] === true
  }
  function toggleModule(key) {
    setOpenModules(prev => {
      const next = { ...prev, [key]: !moduleOpen(key, prev) }
      localStorage.setItem('crest_help_modules', JSON.stringify(next))
      return next
    })
  }

  // Same pattern, but for the Getting Started tab's per-module sections — these default
  // *closed* (unlike Module Guide) so a Suite client sees three clickable topics instead of a
  // 12-card wall on first load, and picks the one they're actually onboarding right now.
  const [openGS, setOpenGS] = useState(() => {
    try { return JSON.parse(localStorage.getItem('crest_help_gs')) || {} } catch { return {} }
  })
  function gsOpen(key, state = openGS) {
    return state[key] === true
  }
  function toggleGS(key) {
    setOpenGS(prev => {
      const next = { ...prev, [key]: !gsOpen(key, prev) }
      localStorage.setItem('crest_help_gs', JSON.stringify(next))
      return next
    })
  }

  // Shared expandable card used for unlocked features
  function FeatureCard({ feat, moduleKey }) {
    const key = `${moduleKey}:${feat.name}`
    const isOpen = expandedModule === key
    return (
      <div className="card" style={{ padding: 0, marginBottom: 6 }}>
        {/* A real <button> with aria-expanded/aria-controls, not a <div onClick>. This page is a
            Read surface whose entire structure is disclosure, and every accordion on it used to be
            unreachable by keyboard — a keyboard or screen-reader user could tab to the search box
            and nothing else, so the product's whole documentation was closed to them. The chevron
            is aria-hidden: the expanded state is now exposed properly, so reading out "▼" adds
            nothing. */}
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={`feat-panel-${key}`}
          onClick={() => setExpandedModule(isOpen ? null : key)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px',
            width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span aria-hidden="true" style={{ fontSize: 15, width: 22, textAlign: 'center', flexShrink: 0 }}>{feat.icon}</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{feat.name}</span>
          </div>
          <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{isOpen ? '▲' : '▼'}</span>
        </button>
        {isOpen && (
          <div id={`feat-panel-${key}`} role="region" style={{ padding: '0 18px 16px', borderTop: '1px solid var(--theme-border)' }}>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginTop: 14, lineHeight: 1.75 }}>{feat.guide || feat.desc}</p>
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

  // Flat, searchable index built once from the same data every tab already renders from — a
  // module guide feature is covered by search the moment it exists in IMS_FEATURE_TIERS /
  // HR_FEATURES / POS_FEATURES / ADMIN_FEATURES, with no separate list to keep in sync. Tier
  // locking is deliberately not applied here (unlike the Module Guide tab's LockedRow) — showing
  // a locked feature's full guide text in a search result is closer to how Pricing already
  // advertises locked features openly than something that needs gating.
  const searchIndex = useMemo(() => {
    const items = []
    IMS_FEATURE_TIERS.forEach(g => g.features.forEach(f => items.push({ feat: f, moduleKey: 'ims', module: 'IMS' })))
    HR_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'hr', module: 'HR' }))
    POS_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'pos', module: 'POS' }))
    ADMIN_FEATURES.forEach(f => items.push({ feat: f, moduleKey: 'admin', module: 'Admin' }))
    return items
  }, [])

  const searchQ = searchQuery.trim().toLowerCase()
  const searching = searchQ.length > 0
  const matchedFeatures = searching ? searchIndex.filter(({ feat }) =>
    feat.name.toLowerCase().includes(searchQ) ||
    (feat.guide || feat.desc || '').toLowerCase().includes(searchQ) ||
    (feat.tips || []).some(t => t.toLowerCase().includes(searchQ))
  ) : []
  const matchedGlossary = searching ? GLOSSARY.filter(g =>
    g.term.toLowerCase().includes(searchQ) || g.def.toLowerCase().includes(searchQ)
  ) : []
  const matchedFaq = searching ? FAQ.filter(f =>
    f.q.toLowerCase().includes(searchQ) || f.a.toLowerCase().includes(searchQ)
  ) : []
  const searchResultCount = matchedFeatures.length + matchedGlossary.length + matchedFaq.length

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
      <div role="tablist" aria-label="Help sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 28, borderBottom: '1px solid var(--theme-border)' }}>
        {[
          { id: 'guide',   label: 'Getting Started' },
          { id: 'modules', label: 'Module Guide' },
          { id: 'glossary', label: 'Glossary' },
          { id: 'faq',     label: 'FAQ' },
          { id: 'pricing', label: '💎 Pricing' },
        ].map((s, i, arr) => (
          /* .panel-tab is the underline-tab family DESIGN.md added for exactly this shape, and it
             brings the hover state and the coarse-pointer 44px floor an inline style cannot carry.
             Roving tabIndex + arrow keys so the whole row is ONE stop in the page's tab order
             rather than five — per DESIGN.md's Tabs rule. */
          <button
            key={s.id}
            role="tab"
            id={`help-tab-${s.id}`}
            aria-selected={activeSection === s.id}
            aria-controls="help-tabpanel"
            tabIndex={activeSection === s.id ? 0 : -1}
            onClick={() => setActiveSection(s.id)}
            onKeyDown={e => {
              const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
              if (dir) {
                e.preventDefault()
                const next = arr[(i + dir + arr.length) % arr.length]
                setActiveSection(next.id)
                document.getElementById(`help-tab-${next.id}`)?.focus()
              } else if (e.key === 'Home') {
                e.preventDefault(); setActiveSection(arr[0].id); document.getElementById(`help-tab-${arr[0].id}`)?.focus()
              } else if (e.key === 'End') {
                e.preventDefault(); setActiveSection(arr[arr.length - 1].id); document.getElementById(`help-tab-${arr[arr.length - 1].id}`)?.focus()
              }
            }}
            className={`panel-tab${activeSection === s.id ? ' panel-tab--active' : ''}`}
          >{s.label}</button>
        ))}
      </div>

      {/* Search — spans every tab's content (Module Guide, Glossary, FAQ) from one box, since
          a client has no way to know which of 5 tabs an answer lives in otherwise. */}
      <div style={{ marginBottom: 24 }}>
        {/* Was an unlabeled input carrying .form-select — a <select> class on a text box, with a
            placeholder standing in for a label (DESIGN.md forbids exactly that). */}
        <label htmlFor="help-search" className="sr-only">Search help</label>
        <input
          id="help-search"
          type="search"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search features, glossary terms, and FAQs…"
          className="form-select"
          style={{ width: '100%', maxWidth: 480 }}
        />
      </div>

      {searching && (
        <div style={{ marginBottom: 28 }}>
          {/* role="status" so the count is announced as it changes — a sighted user watches the
              list shrink while typing; without this a screen-reader user gets nothing. */}
          <p role="status" aria-live="polite" style={{ fontSize: 13, color: 'var(--theme-text2)', marginBottom: 16 }}>
            {searchResultCount} result{searchResultCount === 1 ? '' : 's'} for "{searchQuery}"
          </p>
          {matchedFeatures.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Module Guide</p>
              {matchedFeatures.map(({ feat, moduleKey, module }) => (
                <div key={`${moduleKey}:${feat.name}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent)', width: 34, flexShrink: 0, marginTop: 14, textTransform: 'uppercase' }}>{module}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <FeatureCard feat={feat} moduleKey={`search-${moduleKey}`} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {matchedGlossary.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Glossary</p>
              {matchedGlossary.map(g => (
                <div key={g.term} className="card" style={{ padding: '12px 18px', marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{g.term}</div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{g.def}</div>
                </div>
              ))}
            </div>
          )}
          {matchedFaq.length > 0 && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>FAQ</p>
              {matchedFaq.map((item, i) => (
                <div key={i} className="card" style={{ padding: '12px 18px', marginBottom: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{item.q}</div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{item.a}</div>
                </div>
              ))}
            </div>
          )}
          {searchResultCount === 0 && (
            <div className="empty-state">No results for "{searchQuery}". Try a different term, or clear the search to browse the tabs above.</div>
          )}
        </div>
      )}

      {/* One tabpanel wrapping all five section bodies — aria-labelledby points at whichever tab
          is currently selected, so the panel is announced with its own section's name. */}
      <div id="help-tabpanel" role="tabpanel" aria-labelledby={`help-tab-${activeSection}`} tabIndex={-1}>

      {!searching && <>

      {/* GETTING STARTED */}
      {activeSection === 'guide' && (
        <div>
          {imsEnabled && (
          <div>
          <div className="card" style={{ marginBottom: 16, background: 'rgba(201,168,76,0.03)', borderColor: 'rgba(201,168,76,0.2)' }}>
            <div onClick={() => toggleGS('ims')} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', cursor: 'pointer' }}>
              <span style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⬢</span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 15, color: 'var(--theme-text1)' }}>Welcome to Crest Suite</h3>
                  <span style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{gsOpen('ims') ? '▲' : '▼'}</span>
                </div>
                {!gsOpen('ims') && (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, monthly workflow, and common mistakes to avoid.</p>
                )}
                {gsOpen('ims') && (
                  <>
                    <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                      Crest tracks your ingredient purchases, stock levels, and food cost in real time. The core idea is simple:
                    </p>
                    <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, color: 'var(--theme-accent)', fontWeight: 600 }}>Opening Stock + Purchases − Wastage − Closing Stock = COGS (what you actually used)</span>
                    </div>
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                      Follow the steps below to get set up. First-time setup takes about 30–60 minutes. After that, the monthly routine takes 15–20 minutes of admin at month end.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {gsOpen('ims') && (
          <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>First-Time Setup</h3>
            <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Do this once when you first log in. Takes 30–60 minutes.</p>
            {[
              { step: 1, title: 'Add your Ingredients', desc: 'Go to Item Master → add every ingredient you buy. Each item needs a name, category, unit of measure (UOM) and one price: what ONE unit costs. Use the smallest unit you actually cook with — sauce in ML, salt in GM. Only know the pack price? Use the "Bought a pack?" line (500 GM for NPR 388.50) and Crest works out the per-unit price for you.', why: 'Every purchase, stock count and recipe cost is priced off this per-unit rate. You cannot enter purchases without items.' },
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
              { step: 5, title: 'Enter Sales',                      desc: 'Sales Entry → enter qty sold per menu item. Use Bulk Entry for a month-end tally. Running Crest POS? Skip this step entirely — the till posts sales for you, and both entry tabs are locked.', plan: 'Starter+' },
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
          </>
          )}
          </div>
          )}

          {hrEnabled && (
          <div>
            <div className="card" style={{ marginBottom: 16, background: 'rgba(201,168,76,0.03)', borderColor: 'rgba(201,168,76,0.2)' }}>
              <div onClick={() => toggleGS('hr')} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', cursor: 'pointer' }}>
                <span style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>👤</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: 'var(--theme-text1)' }}>Welcome to Crest HR</h3>
                    <span style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{gsOpen('hr') ? '▲' : '▼'}</span>
                  </div>
                  {!gsOpen('hr') && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, monthly workflow, and common mistakes to avoid.</p>
                  )}
                  {gsOpen('hr') && (
                    <>
                      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                        Crest HR runs payroll, attendance, and Nepal-compliant SSF/TDS deductions for your staff. The core idea is simple:
                      </p>
                      <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                        <span style={{ fontSize: 13, color: 'var(--theme-green-text)', fontWeight: 600 }}>Attendance → Payroll: what you mark each day becomes what people get paid</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {gsOpen('hr') && (
            <>
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>First-Time Setup</h3>
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Do this once when you first turn on Crest HR.</p>
              {HR_SETUP_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border)' : 'none' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent)', flexShrink: 0 }}>{s.step}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{s.title}</div>
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
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Repeat this every BS month.</p>
              {HR_WORKFLOW_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                  <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent)', flexShrink: 0 }}>{s.step}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 3 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ borderColor: 'rgba(248,113,113,0.15)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
              {HR_MISTAKES.map((text, i, arr) => (
                <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                  <span style={{ color: 'var(--theme-red)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{text}</span>
                </div>
              ))}
            </div>
            </>
            )}
          </div>
          )}

          {posEnabled && (
          <div>
            <div className="card" style={{ marginBottom: 16, background: 'rgba(201,168,76,0.03)', borderColor: 'rgba(201,168,76,0.2)' }}>
              <div onClick={() => toggleGS('pos')} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', cursor: 'pointer' }}>
                <span style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⊕</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: gsOpen('pos') ? 8 : 0 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: 'var(--theme-text1)' }}>Welcome to Crest POS</h3>
                    <span style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{gsOpen('pos') ? '▲' : '▼'}</span>
                  </div>
                  {!gsOpen('pos') && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, daily workflow, and common mistakes to avoid.</p>
                  )}
                  {gsOpen('pos') && (
                    <>
                      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                        Crest POS runs your floor — tables, orders, billing, and shift reconciliation. The core idea is simple:
                      </p>
                      <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '10px 16px', display: 'inline-block' }}>
                        <span style={{ fontSize: 13, color: 'var(--theme-purple-text)', fontWeight: 600 }}>Order → Bill → Shift Close: every sale reconciles back to the cash drawer at day's end</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {gsOpen('pos') && (
            <>
            <div className="card" style={{ marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>First-Time Setup</h3>
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Do this once when you first turn on Crest POS.</p>
              {POS_SETUP_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 16, marginBottom: 16, paddingBottom: 16, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border)' : 'none' }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent)', flexShrink: 0 }}>{s.step}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{s.title}</div>
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
              <h3 style={{ margin: '0 0 6px', fontSize: 15, color: 'var(--theme-text1)' }}>Daily Workflow</h3>
              <p style={{ margin: '0 0 20px', fontSize: 12, color: 'var(--theme-text2)' }}>Repeat this every shift/day the floor is open.</p>
              {POS_WORKFLOW_STEPS.map((s, i, arr) => (
                <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                  <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent)', flexShrink: 0 }}>{s.step}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 3 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ borderColor: 'rgba(248,113,113,0.15)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
              {POS_MISTAKES.map((text, i, arr) => (
                <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                  <span style={{ color: 'var(--theme-red)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>{text}</span>
                </div>
              ))}
            </div>
            </>
            )}
          </div>
          )}
        </div>
      )}

      {/* MODULE GUIDE */}
      {activeSection === 'modules' && (
        <div>
          {/* ── Crest IMS ── */}
          {imsEnabled && (
            <div style={{ marginBottom: 32 }}>
              {/* Module header — rolled up by default; click to reveal this module's topic list. */}
              <div
                onClick={() => toggleModule('ims')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid rgba(201,168,76,0.2)', cursor: 'pointer' }}
              >
                <span style={{ fontSize: 18, color: 'var(--theme-accent)' }}>▦</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest IMS</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
                {!isAdmin && (
                  <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginLeft: 4 }}>
                    {plan === 'pro' ? 'Pro Plan' : plan === 'growth' ? 'Growth Plan' : 'Starter Plan'}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('ims') ? '▲' : '▼'}</span>
              </div>

              {moduleOpen('ims') && IMS_FEATURE_TIERS.map(tier => {
                const unlocked = isTierUnlocked(tier.tier, plan, isAdmin)
                return (
                  <div key={tier.tier} style={{ marginBottom: 20 }}>
                    {/* Tier label row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: tier.planColor, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {tier.label}
                      </span>
                      {!unlocked && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: tier.planColor, background: colorTint(tier.planColor, 8), border: `1px solid ${colorTint(tier.planColor, 19)}`, padding: '1px 7px', borderRadius: 8 }}>
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
                        background: colorTint(tier.planColor, 3), border: `1px dashed ${colorTint(tier.planColor, 19)}`,
                        borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
                      }}>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                          Upgrade to <strong style={{ color: tier.planColor }}>{tier.planLabel}</strong> to unlock {tier.features.length} features
                        </span>
                        <button
                          onClick={() => navigate('/pricing')}
                          style={{ fontSize: 11, fontWeight: 700, color: tier.planColor, background: colorTint(tier.planColor, 8), border: `1px solid ${colorTint(tier.planColor, 21)}`, borderRadius: 5, padding: '4px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
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
              <div
                onClick={() => toggleModule('hr')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid rgba(201,168,76,0.2)', cursor: 'pointer' }}
              >
                <span style={{ fontSize: 18, color: 'var(--theme-accent)' }}>👤</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest HR</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
                <span style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('hr') ? '▲' : '▼'}</span>
              </div>
              {moduleOpen('hr') && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Human Resources</span>
                  </div>
                  {HR_FEATURES.map(feat => (
                    <FeatureCard key={feat.name} feat={feat} moduleKey="hr" />
                  ))}
                </>
              )}
            </div>
          )}

          {/* ── Crest POS ── */}
          {posEnabled && (
            <div style={{ marginBottom: 32 }}>
              <div
                onClick={() => toggleModule('pos')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid rgba(201,168,76,0.2)', cursor: 'pointer' }}
              >
                <span style={{ fontSize: 18, color: 'var(--theme-accent)' }}>⊕</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest POS</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-green)', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '2px 8px', borderRadius: 10 }}>Active</span>
                <span style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('pos') ? '▲' : '▼'}</span>
              </div>
              {moduleOpen('pos') && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Point of Sale</span>
                  </div>
                  {POS_FEATURES.map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="pos" />
                  ))}
                </>
              )}
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
              {ADMIN_FEATURES.map(feat => (
                <FeatureCard key={feat.name} feat={feat} moduleKey="admin" />
              ))}
            </div>
          )}

          {/* Neither module active */}
          {!imsEnabled && !hrEnabled && !posEnabled && (
            <div className="card" style={{ textAlign: 'center', padding: '40px 24px', borderColor: 'var(--theme-border)' }}>
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
            <div style={{ display: 'flex', justifyContent: 'center', gap: 7, marginBottom: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: MODULE_COLORS.ims }} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: MODULE_COLORS.hr }} />
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: MODULE_COLORS.pos }} />
            </div>
            <h2 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 8px', fontFamily: 'Georgia, serif', color: 'var(--theme-text1)' }}>Plans & Pricing</h2>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>One system for IMS, HR, and POS — pick a module or bundle them all</p>
            <div style={{ display: 'inline-flex', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: 3, gap: 2 }}>
              <button onClick={() => setPricingAnnual(false)} style={{ background: !pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border: !pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color: !pricingAnnual ? 'var(--theme-accent)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Monthly</button>
              <button onClick={() => setPricingAnnual(true)}  style={{ background:  pricingAnnual ? 'rgba(201,168,76,0.15)' : 'none', border:  pricingAnnual ? '1px solid rgba(201,168,76,0.3)' : '1px solid transparent', color:  pricingAnnual ? 'var(--theme-accent)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                Annual <span style={{ background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.25)', color: 'var(--theme-green)', fontSize: 9, padding: '2px 7px', borderRadius: 8, fontWeight: 700 }}>Save 25%</span>
              </button>
            </div>
          </div>

          {/* Crest IMS — 3 tiers */}
          <p style={{ fontSize: 11, color: MODULE_INK.ims, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>Crest IMS</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
            {IMS_TIERS.map(plan => {
              const highlight = plan.key === 'growth'
              const price = pricingAnnual ? plan.annual : plan.monthly
              return (
                <div key={plan.key} className="card" style={{ border: highlight ? `1px solid ${colorTint(MODULE_COLORS.ims, 44)}` : '1px solid var(--theme-border)', position: 'relative', display: 'flex', flexDirection: 'column', padding: '32px 22px 22px', boxShadow: highlight ? `0 4px 32px ${colorTint(MODULE_COLORS.ims, 9)}` : 'none' }}>
                  {highlight && (
                    <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: MODULE_COLORS.ims, color: 'var(--theme-accent-text)', fontSize: 9, fontWeight: 800, padding: '3px 12px', borderRadius: 8, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                      Most Popular
                    </div>
                  )}
                  <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: MODULE_INK.ims, fontFamily: 'Georgia, serif' }}>{plan.label}</span>
                    {plan.key === 'starter' && !pricingAnnual && (
                      <span style={{ fontSize: 9, fontStyle: 'italic', fontWeight: 800, color: MODULE_INK.ims, background: colorTint(MODULE_COLORS.ims, 8), border: `1px solid ${colorTint(MODULE_COLORS.ims, 25)}`, padding: '2px 6px', borderRadius: 7, letterSpacing: '0.05em' }}>
                        FREE FOR 7 DAYS TRIAL
                      </span>
                    )}
                  </div>
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
                    {plan.key === 'starter' && !pricingAnnual ? (
                      <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {plan.monthly.toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo after trial</span></div>
                    ) : (
                      <>
                        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {price.toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo</span></div>
                        {pricingAnnual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Billed annually · NPR {(price * 12).toLocaleString()}/yr</div>}
                      </>
                    )}
                  </div>
                  {plan.includesLabel && (
                    <div style={{ fontSize: 10, color: 'var(--theme-text3)', marginBottom: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {plan.includesLabel}
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                    {plan.features.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <span style={{ color: MODULE_INK.ims, fontSize: 12, flexShrink: 0, marginTop: 1 }}>✓</span>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.4 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Crest HR + Crest POS — flat modules */}
          <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>
            <span style={{ color: MODULE_INK.hr }}>Crest HR</span>
            <span style={{ color: 'var(--theme-text3)' }}> &amp; </span>
            <span style={{ color: MODULE_INK.pos }}>Crest POS</span>
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginBottom: 24 }}>
            {[
              { key: 'hr',  name: 'Crest HR',  color: MODULE_INK.hr,  pricing: HR_PRICING },
              { key: 'pos', name: 'Crest POS', color: MODULE_INK.pos, pricing: POS_PRICING },
            ].map(mod => {
              const price = pricingAnnual ? mod.pricing.annual : mod.pricing.monthly
              return (
                <div key={mod.key} className="card" style={{ display: 'flex', flexDirection: 'column', padding: '32px 22px 22px' }}>
                  <div style={{ marginBottom: 6 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: mod.color, fontFamily: 'Georgia, serif' }}>{mod.name}</span>
                  </div>
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {price.toLocaleString()}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo</span></div>
                    {pricingAnnual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Billed annually · NPR {(price * 12).toLocaleString()}/yr</div>}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                    {mod.pricing.features.map((f, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 7 }}>
                        <span style={{ color: mod.color, fontSize: 12, flexShrink: 0, marginTop: 1 }}>✓</span>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.4 }}>{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Crest Suite Pro — an add-on on top of the modules above, not a bundle containing them */}
          <p style={{ fontSize: 11, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>Crest Suite Pro — the owner layer, added on top</p>
          <div className="card" style={{ marginBottom: 24, borderColor: 'rgba(201,168,76,0.2)' }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ minWidth: 180 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif', marginBottom: 8 }}>{SUITE_ADDON.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>
                  +NPR {(pricingAnnual ? SUITE_ADDON.annual : SUITE_ADDON.monthly).toLocaleString()}
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text2)' }}>/mo per outlet</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 6 }}>{SUITE_ADDON.requiresLabel}</div>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, flex: 1, minWidth: 240 }}>
                {SUITE_ADDON.features.map(f => (
                  <li key={f} style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 5, lineHeight: 1.5 }}>{f}</li>
                ))}
              </ul>
            </div>
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
            <div key={i} className="card" style={{ padding: 0 }}>
              <button
                type="button"
                aria-expanded={expandedFaq === i}
                aria-controls={`faq-panel-${i}`}
                onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                         width: '100%', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--theme-text1)' }}>{item.q}</span>
                <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 14 }}>{expandedFaq === i ? '▲' : '▼'}</span>
              </button>
              {expandedFaq === i && (
                <div id={`faq-panel-${i}`} role="region" style={{ padding: '0 20px 16px', borderTop: '1px solid var(--theme-border)' }}>
                  <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginTop: 12, lineHeight: 1.7 }}>{item.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      </>}
      </div>
    </div>
  )
}
