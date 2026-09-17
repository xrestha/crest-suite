import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { MODULE_COLORS, MODULE_INK, colorTint } from '../data/pricingPlans'
import SupportContactLine from '../components/SupportContactLine'
// The Help sections a URL may open directly: /help?section=support is the sidebar's Support
// button (S683) — before it, "where is support?" had no answer a link could give, because the
// section lived only in component state. Anything else falls back to the guide.
const HELP_SECTIONS = ['guide', 'modules', 'glossary', 'faq', 'pricing', 'support', 'legal']
const sectionFromSearch = search => {
  const s = new URLSearchParams(search).get('section')
  return HELP_SECTIONS.includes(s) ? s : null
}


// Lazy for the same reason Settings lazy-loads its Guides tab: this one runs a query and carries
// its own table, and every other tab would otherwise pay for it on first paint of /help.
const LegalTab = lazy(() => import('./help/LegalTab'))

// ── IMS feature data, grouped by plan tier (Getting Started module guide — distinct from the
// tier pricing the Pricing tab renders from useSettings().pricing) ─────────────────────────────────────
const IMS_FEATURE_TIERS = [
  {
    tier: 'core', label: 'Core — All Plans', planLabel: null, planColor: 'var(--theme-text2)',
    features: [
      {
        icon: '◎', name: 'Dashboard',
        guide: 'The home screen. Shows KPI cards for the current open period: total purchases, revenue, food cost %, net margin, and top wastage. Figures update live as you add purchases, stock counts, and sales. Admin sees a platform overview; clients see their property dashboard.',
        tips: ['Fixed Costs % and Est. Net Margin use your finalized payroll for labour when a payroll run exists, otherwise what was typed on the Overheads Labor tab — never both — and the tile says which it used', 'COGS and FC% are only accurate after closing stock is entered', 'If no open period exists, go to Periods and create one first', 'Dashboard figures always reflect the current open period', 'The "Daily Purchases vs Sales" chart overlays daily purchase spend (gold) with daily sales revenue (green), with the BS weekday initial (S/M/T/W/T/F/S) shown below each date. The green sales line only appears when sales are recorded day-by-day (Sales → pick a day); bulk monthly sales entry has no daily breakdown to plot. With 5+ days of data in the current month, a dashed line in the same colour projects both lines to month-end based on the pace so far — a live estimate that moves as more days are added — click the expand icon for the full view with running totals. A dotted "Target" line in a distinct colour (blue for sales, orange for purchases) also appears once 5+ days of data exist: unlike the dashed line, it is captured once and never changes for the rest of the period, so actual performance can be compared against the forecast made earlier in the month. Hovering a day shows how far that day ran off its Target: the arrow points where the day actually sits (▲ above the target line, ▼ below), while the colour says whether that was the good direction for that metric — for Sales, above target is green; for Purchases it is the reverse, because spending under the pace you locked in is the win. A grey ≈ means the day landed close enough to count as on target — within 2% of it, or NPR 100, whichever is more forgiving — so the coloured days are the ones that actually moved. Note: the gap between the lines is buying-vs-selling cash rhythm, not profit, and a purchase projection is inherently noisier than sales since restocking happens in bursts rather than a steady daily trickle.', 'The "Spend by Category" card also shows the Top Items by Spend list — switch between the two with the tab at the top of the card.']
      },
      {
        icon: '◆', name: 'Owner Dashboard',
        guide: 'A single cross-module view for owners — Revenue, Food Cost %, Labor Cost %, Prime Cost % (Food Cost % + Labor Cost %), and True Net Margin % (Revenue − Food Cost − Labor Cost − Overhead), plus Wastage Value, Items Below Par, and Overdue Payables. All figures are Month-to-Date against the current open period, same scoping as Monthly Summary. Below the KPI cards, a Cost & Margin Trend chart plots Food Cost %, Labor Cost %, Prime Cost %, and Net Margin % across your last 12 closed periods, sourced from each period\'s frozen Monthly Owner Report snapshot. Requires both Crest IMS and Crest HR enabled, plus Crest Suite Pro — an add-on bought on top of your modules rather than a bundle that replaces them, switched on from the Billing tab in Manage Clients.',
        tips: ['Labor Cost % is a prorated estimate (scaled to days elapsed this month) — it refines to the exact figure once Payroll Run is finalized for the month', 'Every ratio here is banded and marked, not just coloured: ✓ healthy, △ watch, ▲ needs attention. Labour is healthy at or under 30% of revenue and watch to 37%; Prime is 60% and 65%; True Net Margin runs the other way — healthy at 20% or better. The Labor Forecast tab on Roster and the Monthly Owner Report use the same bands, so a month never looks healthy on one page and not on another', 'Prime Cost % is the number most operators benchmark against directly — industry standard is roughly 60–65% of revenue', 'Items Below Par is a live inventory position, not a monthly total', 'A locked padlock means Crest Suite Pro is not active on this outlet — either it was never added, or its own end date has passed (there is a 7-day grace, the same as the rest of the subscription). Contact your consultant', 'The trend chart only plots periods that already have a Monthly Owner Report — a brand-new property with no closed periods yet won\'t show it until one exists']
      },
      {
        icon: '▤', name: 'Monthly Owner/Manager Report',
        guide: 'The frozen, exportable sibling of Owner Dashboard — a snapshot of every figure (IMS, HR, and POS combined) generated automatically the moment a period closes, so it never changes even if the underlying data is corrected later. Adapts to show only the modules your property actually has enabled. Pick any closed period from the dropdown to view its report, export it to Excel, or print/save it as a PDF. Requires the same Crest Suite Pro add-on as Owner Dashboard. Visible only to Owner and Admin logins.',
        tips: ['A period from before this feature existed generates its report the first time you open it — this can take a few seconds', 'Revenue here comes from Sales Entries; the separate POS Net Sales figure is derived independently from the Bill Register and will not match to the penny — that is expected', 'Only Admin can Regenerate a snapshot, and it always asks for confirmation first since it overwrites the frozen figures', '"Print / Save as PDF" uses your browser\'s print dialog — choose "Save as PDF" as the destination']
      },
      {
        icon: '⌸', name: 'Group Console (Multi-Outlet)',
        guide: 'If you run more than one outlet, your outlets can be linked into a group. An Owner login then gets an outlet switcher in the top bar — pick a branch and the whole app becomes that branch, with no second login. The Group Console itself puts every branch side by side for one BS month: Revenue, Food Cost %, Labour %, and Covers per outlet, plus group totals. Part of Crest Suite Pro, and priced per outlet — each branch needs its own Crest Suite Pro for its figures to appear. Ask your consultant to link your outlets; a single-outlet property sees none of this and is unaffected. Two more sections sit below the branch table. Outlet Access decides who may work in which branch — everyone always has their own outlet, and ticking another lets that person switch into it at the same rank they already hold, so a manager covering two branches no longer has to be made an Owner. Push master data copies your HQ outlet’s items, categories, recipes and (optionally) menu prices into the branches you choose, so every branch is costing the same dish the same way.',
        tips: ['The console shows only outlets that have Crest Suite Pro, and names the ones it left out — so a group total is never quietly missing a branch', 'Outlets keep their own periods, so one branch can still be counting a month another has already closed; a branch with no period for the month is flagged rather than shown as zero', 'A branch whose subscription has lapsed locks only itself — the switcher badges it, and your other branches keep working', 'You cannot switch outlets while POS orders are still waiting to sync — reconnect and let them finish first, or they would be saved against the wrong branch', 'Group figures are computed on group totals, not by averaging each branch\'s percentage, so a small outlet does not swing the number as hard as a large one', 'Outlet Access grants reach, never rank — a storekeeper allowed into a second branch is still a storekeeper there. Removing a branch from someone also signs them out of it if they happen to be working there right now', 'A master-data push always shows a preview first: every record it would create, take over or overwrite, branch by branch. Nothing is written until you press Push', 'A push never touches a branch’s own purchase rates — those are what that branch actually pays its suppliers, and overwriting them would put another city’s prices into its food cost. Only the definition (name, unit, pack size, category) is standardised', 'Selling prices are a separate tick on the push, because a branch in a mall may legitimately charge more than one on a high street']
      },
      {
        icon: 'Σ', name: 'Profit & Loss (Consolidated P&L)',
        guide: 'The formal statement the dashboards are not: Revenue, Cost of Goods Sold, Gross Profit, then Wastage, Staff Meals, Labour, Overheads and Tax & Fees down to Net Profit, each line with its share of revenue — for any one BS month. Every figure comes from the module that owns it: revenue and COGS use the same rules as Monthly Summary (price actually charged, comps excluded, sub-recipes counted at their raw ingredients), Labour is your finalized Payroll run (gross pay + overtime + employer SSF) or, if you don\'t run HR payroll, the Labour bucket from Overheads — never both. Defaults to your most recent closed month, because COGS needs the closing stock count; an open month shows as provisional. If your outlets are linked into a group, the same page shows one column per outlet plus a consolidated total — only outlets with their own Crest Suite Pro are included, and the ones left out are named. Part of Crest Suite Pro.',
        tips: ['Gross Profit is revenue minus COGS only — wastage and staff meals are broken out below it so spoiled stock and staff feeding are visible instead of hiding inside the food-cost line', 'If a month shows both a finalized payroll AND a manual Labour entry in Overheads, the statement uses payroll and tells you what it ignored — delete the manual entry if it duplicates payroll', 'The statement ties to Monthly Summary: same revenue rule, same COGS. Stock Count\'s Summary includes sub-recipes, so its COGS differs by exactly the prep amount', 'A month closed without a closing stock count shows a warning — its COGS treats closing stock as zero and reads high']
      },
      {
        icon: '◷', name: 'Periods',
        guide: 'Create one period per BS month. A period must be open before you can enter purchases, stock, or sales. Close a period at month end to lock the data. Closing stock auto-carries to next month opening. Periods older than 12 months are archived by default.',
        tips: ['Always create a new period before the month starts — if a POS bill is rung when no period exists for that BS month, its revenue and ingredient usage cannot reach Inventory at the time; the bill still closes and prints normally, and POS shows a banner counting them', 'If that happens, create the missing period and use "Post POS bills to Inventory" on it — this backfills those bills so Inventory reports and stock levels catch up. It also posts any credit note issued that month that could not take its bill\'s revenue back out of Inventory at the time. Safe to run more than once; anything already posted is skipped. On a month that is already closed only the account owner or a Crest admin can run it, and the closed month\'s frozen Monthly Report will need Regenerate Snapshot afterwards', 'Creating a month also marks any leave already approved for it on that month\'s attendance sheet — an employee who booked Dashain leave back in Shrawan is deducted correctly without anyone having to remember, and a day already marked by hand is never overwritten. The notice after creating says how many days were marked', 'A period created by hand opens with last month\'s closing count as its opening stock, the same as closing a month normally does — the notice after creating says which month it came from, or that there was nothing to carry. If it says nothing was carried, enter the opening stock on Stock Count','Close the period only after entering closing stock', 'Closing or starting a month needs the account owner or an inventory supervisor or manager; staff logins cannot do it', 'Once a month is closed, only the account owner (or a Crest admin) can change anything in it. The server enforces this, so it also holds for a tablet that syncs late: a stock count entered offline that reaches the server after its month closed is not added, and Stock Count lists each such figure so it can be handed to the owner', 'Found a purchase bill after the month was closed? From the owner\'s login, use "Add missing bills" on that month\'s row in Periods — it opens Purchases on that month so the bill is filed against the month it belongs to. Reopening is not needed, and is blocked anyway while a later month is open; afterwards, regenerate that month\'s Monthly Report so its figures include the bill', 'Use "Show Archived" in Periods to access old months']
      },
      {
        icon: '≡', name: 'Item Master',
        guide: 'Your ingredient database. Every item needs a name, category, UOM (unit of measure), and one price: what ONE unit costs. Items are always stored in their smallest unit — sauce per ML, salt per GM — because that is what recipe costing needs. If you only know what a whole pack cost, the "Bought a pack?" line does the division for you: type 500 GM for NPR 388.50 and the price fills in as 0.777 per GM. Set conversion factors if you buy in bulk packs but consume in smaller units (e.g. 1 CTN = 24 BTL).',
        tips: ['Once an item has purchases, counts or recipe lines, its unit can no longer be changed — every past quantity was recorded in that unit. Hide the item and create a new one instead. Changing an item\'s price asks first and says how many past counts and entries it re-values', 'Use consistent UOMs — GM for solids, ML for liquids', 'Two ways to price an item, same result: type the per-unit price straight in, or use "Bought a pack?" (500 GM for NPR 388.50) and let Crest divide it down', 'Both "Bought a pack?" boxes accept arithmetic — type "12*4" for four dozen and it commits 48, with the running total previewed above the box (Enter applies, Esc cancels)', 'The "Bought a pack?" boxes are a calculator, not saved data — they are blank every time you reopen an item. If a pack size is a permanent fact about the item, put it on the Conversion tab instead, which is also what tells the Purchase Bill whether its Qty column means packs or grams', 'The Rate (NPR) / UOM column is the price of ONE unit — the exact figure recipe costing and stock valuation use. A sub-paisa rate is normal for something bought by the thousand and shows extra decimals rather than a misleading 0.00', 'Set conversion factor if 1 case = 24 bottles etc.', 'Deactivate items you no longer use — do not delete them. An item with any history behind it cannot be deleted anyway, and hiding it keeps every record it is already on (it also drops out of stock valuation, so hide it once its stock is at zero)', 'The Used In column shows where an item already has records — R Recipes, P Purchases, OS/CS opening and closing stock counts, W Wastage, SM Staff Meals and so on — and an item showing any of them cannot be deleted. A stock count of 0 counts too: "we counted and there was none" is still a record. The Unused filter lists exactly the items with no records, which are the ones Del can remove. To delete an item whose only record is a 0 count this month, clear its cell on Stock Count first (a blank cell removes the count, a 0 keeps it)','Each item name is used once per outlet. If a name is already taken — including by a sub-recipe, which is stock-counted alongside your items — the save is refused and tells you which row has it, because two rows with one name split that ingredient\'s purchases and stock between them', 'Editing many items in a row? The Edit Item dialog has ← Prev / Next → buttons that save the current item and jump straight to the next one in the list (in the order shown), with an "X of Y" counter — no need to close and reopen. (Same on the Vendors edit dialog.)']
      },
      {
        icon: '⊙', name: 'Vendors',
        guide: 'Add all your suppliers here. Linking purchases to vendors lets you track spend per supplier and identify price trends over time. Vendors can be set Active or Inactive.',
        tips: ['The account owner can archive, restore and delete suppliers. A supplier with purchase history can only be archived, never deleted', 'Add all vendors before starting purchase entries', 'Inactive vendors are hidden from purchase dropdowns but their data is preserved', 'Three ways off this page, and Crest support sees all three: a vendor with nothing recorded against it can be Deleted outright; a vendor you have bought from can be Deactivated (stays on the page, out of the dropdowns) and then Archived (leaves the page entirely, while every past bill and report keeps its name); archived vendors come back via "Show archived"']
      },
      {
        icon: '⛊', name: 'Gate Passes',
        guide: 'Issue a printable gate pass for a vendor or delivery vehicle arriving at the property — pick an existing vendor or type a one-off company name, plus driver name, vehicle number, and purpose (delivery/pickup/maintenance/other). Prints an A4 pass with Security/Supervisor signature lines. No extra role gate beyond normal IMS access — anyone who can reach this page can issue one.',
        tips: ['A gate pass day ends at 6 AM Nepal time, like the POS parking day: a truck parked overnight is only auto-closed after 6 AM. A wrongly issued pass can be voided by a supervisor with a reason — it keeps its number and shows who voided it', 'Mark a pass "Exited" once the vehicle leaves — the Open tab is a quick live view of who\'s currently on the premises', 'The Pass No is sequential per client, separate from any other numbering in the app', 'Reprint from the log at any time if the original is lost', 'A pass left open past its day auto-closes the next time this page is opened, showing "Auto-Closed" instead of "Closed" — the record is kept, but it means staff never confirmed the vehicle actually left']
      },
      {
        icon: '↓', name: 'Purchases',
        guide: 'Record every ingredient purchase here. Each bill has a header (vendor, day, invoice ref, discount, payment method) and one row per item. Per row: select item, enter qty and rate (leave the rate at 0 for free goods — buy 10 get 1 free), tick VAT if this line attracts 13% VAT, optionally enter an expiry date or shelf-life days (expiry auto-fills from the bill date). Use the Returns tab to log items sent back to suppliers, on the day they went back.',
        tips: ['Entering a bill off paper is faster from the keyboard: "+ Add Item" drops the cursor into the new line, and pressing Enter in the Days box at the end of a row starts the next line for you', 'Goods sent back after the month they were bought are recorded in the month they went back: on the Returns tab pick the bill\'s month under "Bill from". Which month the VAT on such a return is claimed in is a question for your accountant — confirm it with them before filing. You can also type the VAT and total exactly as printed on the supplier\'s bill; Crest flags any difference over NPR 1 but never stops a save', 'Each bill shows the time it was ENTERED into Crest under the vendor name — not when the goods arrived. The Day column is the delivery day; where the two differ, the entry date is shown next to the time, so a bill filed late is obvious', 'Enter purchases daily from the actual invoice — not from memory at month end', 'Always enter the actual invoice rate if it differs from the master rate', 'A row with an item but no quantity is refused by name, never silently skipped — fill it in or remove it with ×. A rate of 0 is a free line: stock goes up, spend does not', 'If the same vendor\'s bill number is already on record, Crest asks before saving it again — say Save anyway only if the vendor genuinely reused the number', 'A bill with vendor payments recorded against it (in Outstanding Payables) cannot be edited or deleted — remove the payments first. Otherwise money already paid would vanish from Payment Report', 'Delete All (the whole month) is Supervisor and above; Staff can still add, edit and delete single bills','Add invoice reference number for audit trail — the Bill no. box above the table then finds that bill instantly, matching any part of the reference (the tail digits are usually enough) with or without the leading #', 'Filter by Payment to see what you still owe: pick Credit for the unpaid bills, and the footer totals and entry count follow the filter. The list only offers methods this period actually used', 'VAT is per-line — tick only the items that are VAT-able on that invoice', 'Enter shelf-life days and the expiry date fills automatically from the bill date', 'Returns auto-inherit rate and vendor from the original purchase', 'Daily Register tab: one row per item with a column per day plus a Total column at the end summing that item\'s purchases across the whole period — also included in Export Excel', 'The Total column stays pinned to the right edge as you scroll — no need to scroll all the way right to see it', 'Click any category header in Daily Register to collapse/expand it and cut down scrolling on a long item list']
      },
      {
        icon: '⊞', name: 'Stock Count',
        guide: 'Tabs: Opening Stock (start of month), Closing Stock (physical count at month end), Wastage (a quick monthly catch-all total per item), Daily Wastage (log waste by day with a reason, picked from a grouped list covering storage and shelf life, prep and cooking losses, breakage and handling, supplier problems, and service errors), and Staff Meals (internal consumption by staff). The Summary tab computes Used = Opening + Net Purchases − Wastage − Staff Meals − Closing, where Wastage = the monthly catch-all + all daily entries. Export to Excel. On Growth and above a Manager also gets a Settings tab for handing the count out to staff — see "Assigned Stock Counting" below.',
        tips: ['On a phone or tablet you get a card per item with a big number box, a progress bar and a Save bar pinned to the bottom — not the desktop table. Each card says where its number stands: Not saved yet, Saving, Saved, or saved on this device and waiting for a connection', 'Clear All is not on the touch screen on purpose — it wipes every quantity on the tab, and next to Save under a thumb that is too easy to hit by mistake. Use a computer for it', 'On the Closing Stock tab, 0 and blank mean different things: 0 is "we counted it and there was none" and is saved as a count; blank is "not counted yet". Clear All sets cells back to blank, not to 0', 'If the page shows "Could not load" instead of your items, nothing is saved from it — reload before counting. Saving a screen the page could not read would have wiped the month\'s real figures', 'On the Opening Stock tab, use "↩ Pull from last month" to copy the previous period\'s counted closing stock into this period\'s opening — run it any time, e.g. if you finished the closing count after already closing the month. A 0 counted last month opens this month at 0', 'Any quantity box accepts arithmetic — type "3*24+7" for 3 cartons of 24 plus 7 loose and it commits 79. The running result shows above the box as you type; press Enter or click away to apply, Esc to cancel', 'Use the Daily Wastage tab to log spoilage by day and reason as it happens — these roll into the period total and COGS', 'The Wastage tab is the monthly catch-all: a single quick figure per item, on top of any daily entries', 'Enter opening stock before any purchases for accurate COGS', 'The Wastage Report now groups by item and includes a By-Reason breakdown', 'If an item\'s Used figure shows red (negative — more used than was ever bought or on hand), turn on "Block negative stock on save" in Settings → Thresholds to stop Save All until it\'s fixed. Off by default; the owner/admin can still override with a confirmation even when it\'s on']
      },
      {
        icon: '☑', name: 'Assigned Stock Counting',
        guide: 'Hand the month-end count to your staff instead of doing it yourself. In Stock Count → Settings (Manager only, Growth and above) you can: assign each counter the sections they are responsible for, so they only see and can only save their own; turn on blind counting, which hides the expected quantities so they write what is actually on the shelf; and turn on recount protection, so one counter cannot overwrite another\'s figure. Every closing count now records who entered it and when. The same tab shows a QR code — a counter scans it once on the storeroom tablet or their phone, then signs in by tapping their name and typing a 4–6 digit PIN. No email, no password. Create those PINs in IMS → IMS Staff → Count PIN. All three switches are off by default, so nothing changes until you turn them on.',
        tips: ['Assign the sections FIRST, then turn on "Limit counters to their assigned sections" — a counter with no sections ticked can save nothing at all, and the settings tab will warn you by name if anyone is in that state', 'Items with no category cannot be assigned to anyone. File them into a category in Item Master, or leave those to a supervisor', 'A PIN login opens Stock Count and nothing else — it cannot reach purchases, costs, reports or your dashboard. Inside Stock Count it gets one tab, Closing Stock, so a phone opens straight on the count instead of on seven tabs, and it never sees what an item or the shelf is worth', 'Blind counting now covers the Print Sheet and the Summary tab too, not just Closing Stock — a counter you have blinded cannot read the expected quantities off another tab or take them out of the store room on paper','The setup QR lasts 15 minutes and can set up as many devices as you like in that time. Press "Hide code" when you are finished. Devices already set up keep working', 'Five wrong PIN tries locks that person out for 15 minutes; you can reset their PIN immediately from IMS Staff', 'Blind counting hides the figures on screen — treat it as counting discipline, not as a lock', 'Supervisors, managers and you always count everything, and can always correct a figure someone else entered'],
      },
      {
        icon: '⌗', name: 'Quick Calculator & Inline Math',
        guide: 'Two ways to do arithmetic without leaving what you are working on. (1) Inline math: every quantity and rate box in Stock Count and Purchases, plus both boxes on the "Bought a pack?" line in Item Master, accepts an expression — type "3*24+7" and it commits 79. The result previews above the box as you type; Enter or clicking away applies it, Esc cancels. (2) Quick Calculator: press Alt+C (or the calculator button beside the search icon at the top right) for a small calculator that floats over any page, with a tape of your recent calculations. Click any result to copy it. The page underneath stays fully usable while it is open — scroll it, click it, type in it — and you can drag the calculator by its title bar to wherever it is out of the way. Alt+C works on the Add Purchase Bill screen too, for working out a per-carton rate or a pack conversion without leaving the bill mid-entry.',
        tips: ['Supports + − × ÷ and brackets, e.g. "(12+8)*2.5". Commas are ignored, so "1,200/16" works', 'Drag the calculator by its title bar to move it off whatever figure you are reading — it stays where you put it for the rest of the session', 'The calculator tape keeps your last 50 calculations for the session — click a row to reuse that expression, or click its result to copy', 'An incomplete expression like "3*" reverts to the previous value instead of saving a partial number', 'Alt+C is a toggle — press it again to close', 'The × in the calculator\'s own header closes just the calculator — Esc does too, and both leave whatever form is open behind it untouched']
      },
      {
        icon: '◉', name: 'Mobile App',
        guide: 'Crest Suite can be installed on any smartphone — no app store required. On Android, open in Chrome and tap "Add to Home Screen". On iPhone, open in Safari, tap Share, and choose "Add to Home Screen". The app works offline: visit Stock Count once connected to cache all items, then count stock in the storeroom with no signal. Entries sync automatically when you reconnect.',
        tips: ['Open the app online at the start of each shift to refresh the cache', 'An amber "Offline" banner appears at the top when you have no connection', 'Cards with a dashed amber border are waiting to sync', 'Reinstall the app after a major update to ensure the latest version is cached']
      },
      {
        icon: '👥', name: 'IMS Staff', path: '/ims/staff',
        guide: 'Assign IMS roles to your team. Staff log in with their own email and password (same mechanism as the Owner account), not a shared PIN. Roles: Staff (Purchases, Stock Count, Sales Entry, Requisitions, Gate Passes only — no cost or report pages), Supervisor (+ Periods, Item Master, Vendors, Purchase Orders, Recipe Costing, and every Stock/Summary report), Manager (+ Menu Pricing, Menu Engineering, Overheads, every Finance and Menu & Vendor report, Settings, and this page). A Manager runs IMS day to day but is not the Owner: only the Owner or an administrator can change or delete another Manager, reset a Manager\'s password, or give an existing login IMS access. Requires Manager role or above.',
        tips: ['Never give YOUR OWN login an IMS role. The Owner account is the one with no staff role at all — that is what makes it the Owner — so assigning it Manager demotes it to a plain IMS Manager and locks it out of HR, POS and the Suite features. To hand day-to-day IMS Staff management to someone else, create THEM a Manager login; your own account already has every IMS page', 'Item Master and Vendors are Supervisor+ because they show purchase rates — Staff can still log purchases normally, since the item/vendor picker inside Purchases doesn\'t require visiting those pages directly', 'A staff account with no role assigned cannot see any IMS pages — the IMS pages are hidden from their navigation entirely', 'If Crest HR is also enabled, + Add Staff defaults to picking an existing HR Employee instead of typing a fresh name — the IMS login is linked to that employee record (shown with a 🔗 HR tag) so the name never drifts out of sync', 'Reset Password sets a new password immediately — there is no email/reset-link flow, so share the new password with the staff member directly. It takes the same password rules as sign-up: at least 8 characters, and nothing on the common-password list or built from the business name or the email', 'Manage Roles lets you name roles your own way (Store Keeper, Purchasing Clerk). Your first custom role is added alongside Staff / Supervisor / Manager rather than replacing them, and a role that logins still hold cannot be removed — move those people to another role first', 'A Manager cannot change or delete their own row — you will see “(you)” beside your name and the controls are off. That is deliberate: a Manager who set themselves to No Access could only be restored by the Owner']
      },
    ]
  },
  {
    tier: 'starter', label: 'Starter Plan', planLabel: 'Starter', planColor: 'var(--theme-text3)',
    features: [
      {
        icon: '₨', name: 'Menu Pricing',
        guide: 'Internal pricing review tool. Shows all active menu items with their food cost, current menu price (VAT-inclusive), and FC%. Search by item or category, and click any column heading to sort — one click on FC % brings your worst-margin items to the top. Type a new VAT-inclusive price on any row to instantly see the new FC% and the price change — then hit Save to commit it to Recipe Costing. Use the On POS toggle to control which items appear on the POS order screen without deleting the recipe.',
        tips: ['Search by item or category narrows the table to matching rows. The category tab counts still count the whole category, so a line beside the box says how many of your items are actually showing while a search is active', 'Click any column heading — Item, Food Cost, Current Price, FC %, New FC %, Change, On POS — to sort by it; click again to reverse. A figure column opens on its highest value first, so one click on FC % puts your worst-margin items at the top', 'Sorting by New FC % or Change orders on prices you have not saved yet, so rows with nothing typed sit at the bottom and the order is HELD as soon as you click into a price box — otherwise the row would jump on every keystroke. Click the heading again to re-sort once you are done', '🖨 Print outputs the price list exactly as filtered and sorted on screen — the active category tab and any search, both named in the print title — and the New Price boxes print BLANK so the sheet can be priced by hand and typed back in', '⬇ Excel downloads the same filtered list with a blank New Price column to fill in and send back — same workflow as the printed sheet, over email; the filename carries the category and search so a narrowed export is never mistaken for the whole menu',  'Food cost is calculated live from current ingredient rates', 'An FC% of “—” means there is no food cost to work from yet — the dish has no ingredients costed in Recipe Costing (or, on a POS-only plan, no Cost Price). It is NOT a 0% food cost, and it is deliberately not coloured green: hover the dash for what to add', 'The Change column shows + (price increase) or − (price decrease) vs current', 'FC% colours come from your own Settings → Thresholds (green up to the warning %, amber up to the critical %, red above it) — hover any FC% figure to see which band it landed in', 'Press Enter in the new-price field to save quickly', 'Saving updates the selling price in Recipe Costing — ex-VAT price is back-calculated automatically', 'Turn off On POS for seasonal or discontinued items — recipe history and costing are preserved', 'The POS order screen only shows items with On POS checked']
      },
      {
        icon: '↑', name: 'Sales Entry',
        guide: 'Record total qty sold per menu item for the period. Only items with a recipe appear here. Revenue is calculated automatically from selling price × qty sold, minus any per-item Discount entered on Daily Entry. Use Bulk Entry for a month-end tally. If you also run Crest POS, Bulk Entry and Daily Entry are locked: every bill closed at the till already posts its own sales, so POS is the source of truth and manual entry would duplicate or contradict it. The Daily Breakdown and Period Summary tabs stay available read-only. On Daily Entry, any sales the till already posted for that day appear in a read-only From POS column beside the qty box, with their own revenue line: Save Day writes only what you type and never changes or deletes a POS sale.',
        tips: ['Sales data is required for the Variance Report to calculate theoretical usage', 'The Items Sold / Items with Sales / Period Revenue cards at the top cover the whole period — bulk and daily entries together — and price each sale at what it was actually sold for, not at the current menu price. Changing a menu price today does not restate last period revenue.', 'Sub-recipes are excluded — only top-level recipes appear here', 'You can update sales entries any time while the period is open', 'Daily Entry: click ↑ Import Excel to auto-fill qty AND discount from a vendor/POS "Sales Report Item Wise" export (.xlsx) for the currently selected day — it matches by Product Name and reads the Net qty sold and Discount columns; unmatched product names are listed in a small banner so you can fix names or enter them manually. Review the filled table, then click Save Day as usual', 'Discount (Daily Entry only) is a per-item NPR reduction for that day — e.g. staff discount or a promo — subtracted from Day Revenue and rolled up into Period Summary\'s Total Revenue. It has no effect on Bulk Entry, which has no per-day/discount concept. A discount is only ever saved against a sale, so if you enter one on an item with no quantity sold, Save Day stops and names the items rather than quietly dropping the figure', 'The Search menu item box above the tabs works on all four tabs and keeps its text as you switch between them. It only narrows which rows are shown: the stat cards still cover every item, a Bulk Entry Save still writes every recipe (not just the visible ones), and Period Summary\'s % of Revenue is still each item\'s share of the whole period — the footer says "N of M items shown" whenever the search has hidden some rows']
      },
      {
        icon: '◎', name: 'Payment Summary',
        guide: 'Breaks down what you SPENT on purchases by how each bill was settled — Cash, Credit and FonePay. Shows gross, returns and net per method with a daily breakdown for the selected period. Amounts are whole bill totals: net of the bill discount and including VAT where the supplier charged it, so they match the Purchases register and Outstanding Payables.',
        tips: ['This is money going OUT to suppliers, not sales revenue — the figures come from Purchases, not Sales Entry', 'Credit means billed but not yet paid. Outstanding Payables is where you see what is still owed and record payments against it', 'A bill counts once in the Bills column however many lines it has, because the payment method is chosen for the whole bill']
      },
      {
        icon: '◻', name: 'Monthly Summary',
        guide: 'The month-end financial report. Shows opening stock, purchases, wastage, closing stock, and COGS by category. Purchases are broken into three columns — Gross (what was invoiced), Discount (bill-level discounts) and Returns — so Net Purchases is what you actually spent, and that is what COGS is built from. Food cost % is calculated against sales revenue and banded against your own thresholds from Settings → Thresholds. Export to Excel for your accountant or management review.',
        tips: ['If some items have no closing count, a warning names them and food cost % is shown without a green or red verdict until they are counted — the figures themselves are unchanged. While the month is still open the page is marked provisional for the same reason', 'The Food Cost % figure, the tint of the box around it and the sentence under it all read your Settings → Thresholds values — change the warning level there and all three move together', 'Gross minus Net is discounts plus returns, not returns alone. Vendor Report and Consolidated P&L net off exactly the same discount, which is what keeps the three pages\' COGS tied', 'A high purchase-based FC% vs actual FC% gap often indicates closing stock errors', 'Share this report with ownership every month end']
      },
      {
        icon: '⟳', name: 'Annual Summary',
        guide: 'Rollup of all monthly periods in a BS calendar or fiscal year. See full-year COGS, purchases, discounts, returns, wastage and food cost % at a glance, one row per month with the FC% trend against the month before. Select any BS year from the dropdown, or switch to Fiscal Year (Shrawan–Ashadh).',
        tips: ['A month where some items were not counted is marked, and only that month loses its food-cost verdict', 'Each month\'s figures here match Monthly Summary for that month exactly — same COGS formula, same bill discounts netted off, same items counted', 'Use this to identify which months consistently run high food cost', 'The Trend column shows → when a month moved less than 0.3pp — a flat month is not an improvement', 'Compare annual FC% year-over-year to spot long-term trends']
      },
      {
        icon: '▤', name: 'Stock Report',
        guide: 'Your current inventory valuation: on-hand quantity and value (qty × rate) per item and category, with a total stock-value headline. On-hand uses your closing physical count if entered — a count of 0 counts — otherwise a theoretical estimate (Opening + Net Purchases − Usage − Wastage − Staff Meals), where Usage is what your recipes say the dishes you sold consumed. Requisitions are NOT deducted: what the store issues is used up by the dishes the kitchen then cooks, and deducting both counted the same stock out twice. Flags Low (at/below par) and Out-of-stock items; an item with no activity at all this month is shown as "No activity" rather than counted as out of stock. Export to Excel or print.',
        tips: ['For an accurate valuation, enter a closing stock count — items then show a "Physical" badge instead of "Theor." Entering 0 for an item you counted and found empty is a real count and shows as Physical with 0 on hand; leaving it blank means "not counted" and the report estimates it instead', 'A negative-stock warning means usage/wastage exceeds recorded purchases — usually a missing purchase entry', 'When every item has a closing count, Total Stock Value equals the Closing value in Stock Count → Summary minus any sub-recipes (which Stock Count counts as stock and this report does not). Items left uncounted are estimated and will make the two differ', 'Needs Growth: the theoretical on-hand figure subtracts what your recipes say you consumed, so without Recipe Costing (Growth) stock would only ever go up. Existing Starter clients keep their access']
      },
      {
        icon: '⚑', name: 'Reorder Report',
        guide: 'Flags items running below their par level — strictly below: an item sitting exactly at par is fine and is not listed. Current Stock is the physical closing count when one has been entered, otherwise Opening + Net Purchases − Usage − Wastage − Staff Meals, where Usage is sales × recipe with a day sold in both POS and manual entry counted once and a credit note never adding stock back. It is the same On-hand figure Stock Report shows, and the same rule behind the Dashboard\'s Items to Reorder panel, the Owner Dashboard tile and the Monthly Owner Report — one calculation, so the count on the Dashboard is the count on this page. Set par levels inline on the report. "✕ Clear All Par" resets all par levels at once. "🖨 Print Par Sheet" prints a category-grouped sheet with a blank fill-in column per item (respecting the Category/Search filters) — hand it to floor staff to write in par levels by hand, then type the values back into the Par Level column here afterward. "🖨 Print Reorder List" and "📱 Share via WhatsApp" both build the actual purchase list — every item currently below par, grouped by category, with qty to order and estimated value — always reorder-only regardless of the on-screen Status filter, but still scoped by Category/Search. WhatsApp opens with the list pre-filled as a text message so you pick who to send it to; nothing is sent automatically. Every row also has a checkbox on the left — check specific items to limit Print Reorder List, Share via WhatsApp, and ↓ Export Excel to just those; leave none checked and all three behave as described above (the whole filtered/reorder-only list). Book Stock is a separate, live column fed by the depletion ledger — every time a POS order is charged or marked Complimentary, and every time a manual Sales Entry day is saved, the recipes are exploded into their raw ingredients (recursing through sub-recipes) and a depletion entry is recorded automatically. Book Stock shows "—" for items with no ledger entry this period; it does not replace Current Stock. Admins see a "✕ Clear Book Stock" button to wipe the ledger for the selected period back to "—" (e.g. to clear out bad test data) without touching physical counts or Current Stock. Click a Book Stock value to see the full itemised ledger behind it in Stock Movements. When no month is open, the report shows the most recent one rather than an empty page.',
        tips: ['Quantities to order show in the smallest unit and in whole packs, rounded up — e.g. "12,500 GM (1 SACK of 25,000 GM)" — on screen, the printed list, WhatsApp and Excel, for every item with a pack size set in Item Master', 'Set par levels based on supplier lead time × daily usage rate', 'Review the reorder report weekly, not just at month end', 'Book Stock and Current Stock should agree once every day\'s sales are recorded — a gap between them usually means a day was sold before it was entered, or a recipe has no ingredients linked', 'A par level that did not save shows a red message under the header and the row keeps its old value — check your connection and try again; nothing is silently kept', 'Use "Print Par Sheet" for a first-time par-level rollout — floor staff can fill it in without needing IMS access', 'Filter to a Category before "Share via WhatsApp" to send a shorter, station-specific list (e.g. just Meats & Poultry to the kitchen)']
      },
      {
        icon: '↺', name: 'Stock Movements',
        guide: 'The itemised ledger behind Reorder Report\'s Book Stock column — every POS-driven depletion entry for the selected period, one row per item per order. Shows the date, item, quantity depleted, source (POS Sale vs POS Comp), the order number (click it to open the exact original bill or complimentary slip), the staff member who closed that order, and the food-cost value of the depletion (qty × per-unit rate). The "Comp Value" stat card totals what was given away complimentary — food cost consumed with zero revenue collected. Arriving from Reorder Report\'s Book Stock link pre-filters to that item and period automatically. Two tabs: "Raw Items" is that ledger, and "Sub-Recipes" answers the question the ledger structurally cannot — how many batches of each prep item (sauce, base, dough) this period\'s sales actually consumed. A sub-recipe is never depleted as itself, because a recipe stores it as a reference and only the raw ingredients at the bottom of the tree ever reach the ledger, so that tab re-walks the same recipes against the period\'s sales to show the prep layer in between: Yield per Batch, Qty Used (output units, e.g. 25,000 ml of a sauce), Batches Used (Qty Used ÷ Yield per Batch), Cost per Batch, and Value. It exports as a second sheet in the same Excel file. Both tabs have a Sort control (Day/Item/Category/Qty/Source/Value on Raw Items; Sub-Recipe/Qty/Batches/Cost per Batch/Value on Sub-Recipes) with an ascending/descending toggle, a TOTAL row summing the value of whatever is currently filtered, and a Print button that prints exactly the on-screen view. The Sub-Recipes tab also has a "Find ingredient in sub-recipes" box — type "milk" to list every prep item containing it, including where it is hidden inside a nested sub-recipe.',
        tips: ['POS Comp rows are excluded from revenue everywhere else in the app, but the food cost still shows here — this is the one place to see what comps actually cost', 'Click any Order # to jump straight to the original bill for full traceability', 'Reflects SALES depletion — every POS sale or comp, and every saved manual Sales Entry day since 2026-07-30. It is not a record of purchases, wastage or staff meals: those move stock but are not depletion entries, so a period with only those will show an empty ledger', 'The Day range never hides a Bulk Sales Entry row. Bulk belongs to the whole period rather than any one day, so it stays in range whatever From/To are set to — otherwise filtering to "1 to 32" would silently drop it', 'A recipe sold via POS with no ingredients linked (Recipes → Ingredients tab) never produces a depletion entry here, even though it still shows normally in Sales Report — a "No BOM" badge on the Recipes list and a warning banner at the top of this page flag exactly which items that\'s happening for', 'The Sub-Recipes tab is NOT extra depletion on top of the Raw Items tab — it is the same ingredients grouped by the prep item they passed through. Adding the two together double-counts', 'Sub-Recipes has no Day filter, unlike Raw Items: it includes Bulk Sales Entry rows, which belong to the whole period rather than any one day', 'If the sub-recipe figures imply more raw ingredient value than the ledger recorded, an amber note explains the gap — usually a period from before manual Sales Entry started depleting stock (2026-07-30, never backfilled)']
      },
      {
        icon: '⊛', name: 'VAT Report',
        guide: 'Summarises input VAT on purchases. Toggle the VAT-inclusive flag per purchase entry in the Purchases page. Shows total VAT paid per period for use in your IRD VAT return. A bill can mix VAT and non-VAT lines, and its discount is split between this report and the Non-VAT Report in proportion to line value, so the two halves add back to the bill.',
        tips: ['The Excel export has a Bill-wise sheet — one row per invoice with supplier, PAN, taxable, exempt and VAT — alongside the item detail. A return whose bill was later deleted or re-saved cannot be matched to VAT or non-VAT and is listed separately rather than dropped', 'Only purchases marked as VAT-inclusive are counted in the VAT total', 'The "Non-VAT Purchases" card here shows exactly the same figure the Non-VAT Report headlines — if they ever disagree, something is wrong', 'Goods sent back are credited at the discounted rate their bill carried, so returning a whole discounted bill leaves nothing to claim rather than a negative figure', 'Match this against your supplier VAT invoices before filing. The Excel export carries your company name, PAN/VAT number and the period — and says so when the period is still open and the figures can still change']
      },
      {
        icon: '⚑', name: 'Purchase One Lakh Above Report',
        guide: 'Nepal VAT return Annexure 13 (अनुसूची १३): any single vendor whose cumulative purchases exceed NPR 1,00,000 in a fiscal year must be disclosed by name + PAN. Aggregates purchases by vendor across a full BS fiscal year and flags who crosses the threshold — the purchase-side counterpart to the POS One Lakh Above Report.',
        tips: ['Suppliers that share a PAN are added together, because the tax office sees one PAN. A supplier with no PAN cannot be matched and is flagged', '⚠ Missing PAN means a vendor crossed NPR 1,00,000 without a PAN/VAT No. on file', 'EVERY purchase from the vendor counts, VAT and non-VAT alike, netted against vendor returns — the disclosure is about total purchase value, not just the taxable part', 'Two columns are checked against the threshold: Net ex-VAT (your cost basis) and Total Invoiced (that plus VAT, which is what the vendor billed and what left the bank). A vendor over NPR 1,00,000 on EITHER is flagged — a supplier at 95,000 taxable invoiced 1,07,350 once VAT is added', 'Bills counts bills, not line items', 'Spans every period in the selected BS fiscal year, not just one month']
      },
      {
        icon: '⊘', name: 'Non-VAT Report',
        guide: 'Lists all purchases entered without the VAT flag. Useful for accounting and for separating VAT vs non-VAT purchase records. Totals are net of bill discounts and of any non-VAT goods returned to the vendor, matching how the VAT Report treats its own half of the filing.',
        tips: ['Non-VAT purchases are those not marked as VAT-inclusive in the Purchases entry', 'A bill can be mixed. When it is, only the share of its discount that falls on the non-VAT lines is deducted here — the rest is deducted on the VAT Report, so the discount is never counted twice', 'Returns are deducted from both the headline total and each vendor row. A Returns column appears only when there were returns in the period.', 'The Entries table shows the gross total, then the discount and returns on their own lines, then the net — so the column adds up to the figure underneath it']
      },
      {
        icon: '⚠', name: 'Wastage Report',
        guide: 'Detailed breakdown of all wastage entered during the period. Shows total value, item count, and top category. Filter by category. Export to Excel or print for management review.',
        tips: ['Sort by value to identify highest-cost wastage items', 'High wastage on the same item repeatedly signals a process or portioning problem']
      },
      {
        icon: '◧', name: 'Settings',
        guide: 'Your operating rules, in seven tabs. Thresholds sets the food-cost warning and critical levels every report colours against, the expiry window the FIFO report flags, the variance level both variance reports flag, and two switches (block negative stock on Stock Count; warn when a menu price is below cost). Item Codes, Vendor Codes and Sub-Recipe Codes each set a prefix and can renumber the whole list; Product Codes fills in codes for menu items that have none. Recipe Categories is the dropdown Recipe Costing files dishes under. Theme is per device. Your business name, address, VAT number and logo are set by Crest for you — ask your consultant to change them. Requires the Manager role.',
        tips: ['Save Changes writes only the boxes on the tab you are looking at — something typed on another tab waits for that tab\'s own Save. Lists other pages manage on the same record — POS discount reasons, ticket routing, TADA rates, custom staff roles — are never touched by it, so leaving Settings open while a manager works on the till is safe', 'A threshold left blank uses the default shown in the box; 0 is refused, because every report would silently fall back to the default and the box would say otherwise. Critical must sit above Warning', 'Renumbering item codes skips sub-recipes — their stock-count items carry the sub-recipe\'s own SRC code, and Regenerate All Sub-Recipe Codes moves both together', 'Removing a category shows how many recipes are filed under it first. They keep the label and their own tab in Recipe Costing; the category just leaves the dropdown. Add it back from the same tab if that was a mistake', 'Follow device on the Theme tab switches light and dark with your phone or computer — the same default the Crest Staff app uses']
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
        tips: ['Photo for the guest menu: press Upload photo and choose a JPG, PNG or WebP (large phone photos are shrunk automatically, 2 MB limit). The photo is stored in Crest so every guest\'s phone can show it — links to Facebook or Google Drive are blocked on guests\' phones. On a saved recipe the photo change takes effect straight away', 'FC% below 30% = excellent, 30–38% = acceptable, above 38% = needs review', 'Update recipes when ingredient prices change significantly', 'Product Code is filled in for you from the category as you create a dish — pick Beverage and you get BEV-001, then BEV-002, and so on. Type your own code over it (say one you already print on your menu) and Crest leaves it alone. Staff can search this code on the POS order screen, and it appears on the Item Wise sales report. For dishes created before this existed, use Settings → Product Codes → Generate Missing Product Codes, which only fills in the blanks and never changes a code you already have.', 'Bulk import: click ↓ Template to download a spreadsheet (it includes a "Your Items" sheet with your exact item names, codes & units to copy from). Fill one row per ingredient — put the Menu Item name, Category, Selling Price & Yield on the recipe\'s first row, then leave those blank for its remaining ingredient rows. Ingredient column accepts an item name, item code, or sub-recipe name; Qty is in the item\'s unit (KG↔GM and LTR↔ML auto-convert). Upload with ↑ Import Excel — a preview shows which ingredients matched and lists any unmatched ones (they\'re skipped; add those items to the Item Master first, then re-import). Recipes that already exist and rows marked category "Sub-Recipe" are skipped, as is any recipe whose sheet lists the same ingredient twice (the preview names it) — combine those two rows into one before importing, since Crest will not guess which quantity you meant.', '↓ Export (Crest Admin only) downloads every current recipe and sub-recipe with its full ingredient breakdown and cost — a backup, an editable spreadsheet, or a file to hand to another location/client. It\'s the same format as ↓ Template (plus extra cost/FC% columns for reference), so an exported file can be edited and re-imported through ↑ Import Excel — even into a different client, since it only carries ingredient/recipe names, never internal IDs. Ingredients only auto-match on the other side if that client\'s Item Master has items with the same names or codes.', 'Clone: the Clone button duplicates a recipe (named "… (Copy)") into the New Recipe form with all its ingredients — tweak and save. Great for menu variants.', 'Use the overhead panel in each recipe\'s detail view to see true cost after fixed cost allocation', 'Nutrition: while editing a recipe, each ingredient row has a Nutrition button — enter values per 100 GM/ML (or per piece) there, or click DFTQC Nepal / IFCT 2017 / USDA to pull a match from that specific library (an ingredient may only have data in one of the three — DFTQC/IFCT are Nepal/India government food tables and don\'t cover every item, e.g. imported fruits like strawberry), or 🔍 Fetch from Open Food Facts for branded/packaged items (search by name or barcode). Entered once per ingredient, it fills every recipe that uses it. Tip: the ⚡ Auto-fill nutrition button (Ingredients header) fills every matching ingredient from the regional library (DFTQC Nepal / IFCT 2017 / USDA) in one click — it deliberately does NOT reach for the live USDA FoodData Central API on a miss; ingredients with no local match are listed in a small banner with a separate "🔍 Try USDA FoodData Central" button, so a live USDA lookup is always something you ask for, never a silent default. The recipe shows a data-coverage count; missing ingredients make the label an underestimate.', 'Use the "Find ingredient in recipes" box (top-right of the recipe list) to see every dish that uses an ingredient — it even matches ingredients hidden inside sub-recipes.', '📱 Share via WhatsApp sends the currently selected category tab\'s recipe list (name, food cost, FC%) as a WhatsApp message — pick a category tab first (e.g. Beverage) to share just that subset.', 'Every row has a checkbox on the left — check specific recipes to limit 🖶 Print and 📱 Share via WhatsApp to just those within the current tab, and ↓ Export (Crest Admin) to just those across every tab. Leave none checked and all three include the whole tab (or, for Export, everything) as before.', 'Description, Photo URL, and Veg/Non-Veg (below the main details, non-sub-recipe items only) are optional and feed the POS guest-facing QR menu (Table Management → ▦ QR) — leave any of them blank to omit that detail from the guest menu', 'Each recipe row has a Hide/Show button and an Active/Inactive status badge — Hide is the safer, reversible alternative to Del for a discontinued dish: it stops the recipe from appearing in Sales Entry, POS ordering, the Guest Menu, and the menu-analysis reports (Menu Engineering/Pricing/Repricing/Recipe Margin), but keeps its past sales history, revenue, and food-cost figures exactly as they were. Del permanently removes the recipe and is blocked in two cases: if anything else uses it as a sub-recipe ingredient, or if it has ever been sold (its sales records are what the revenue and food-cost history is made of). For a dish that has sold, Hide is the only route and it costs you nothing. Deactivating a sub-recipe currently has no effect on other recipes that use it — it stays fully usable as an ingredient either way. Changing its Category away from Sub-Recipe is a third blocked case: while other recipes still list it as an ingredient the save is refused and names them, because those recipes would go on consuming it while it vanished from their ingredient pickers.', 'If a selling price is set below the recipe\'s computed cost, a red warning appears under the price field so it\'s not an accident (e.g. a mistyped price). It doesn\'t block saving — some items are intentional loss-leaders. Turn this off in Settings → Thresholds if you don\'t want the warning at all.']
      },
      {
        icon: '△', name: 'Variance Report',
        guide: 'Compares theoretical usage (sales × recipe qty) against actual usage (Opening + Net Purchases − Wastage − Staff Meals − Closing). Positive variance means more was used than sold — indicating waste, theft, or over-portioning. The flag threshold is yours: Settings → Thresholds → Variance Flag (default 10%), and that one number now drives the colour, the mark and the flag badge together — before, the colours were painted at any variance above zero, so a row could be red beside a badge reading OK. The report opens on the most recent CLOSED month, because the closing stock count is what makes the comparison possible at all.',
        tips: ['Read the mark, not just the colour: ✓ within your tolerance · ▲ over-used (waste, theft, over-portioning) · ▼ under-used (under-portioning or a data gap) · ≈ too small in rupees to be worth chasing. The marks differ by shape, so they still work in a photocopy, in greyscale, and for the roughly 1 in 12 men who cannot reliably separate red from amber', 'A ≈ mark means the item moved by more than your tolerance in PERCENTAGE terms but by under NPR 500 in money — a 40% swing on a spice worth NPR 20. The percentage is still shown; it is simply not worth an investigation, and colouring it red would bury the rows that are', 'Sort by NPR value to prioritise the biggest leaks', 'Items with no recipe show actual usage only — no theoretical comparison', 'Review this every month before closing the period', 'An item that was never counted cannot have a variance, so it is marked "not measurable", left out of the totals, and counted in an amber notice at the top. That is per ITEM, not per month: a month can be 900 items counted and 100 not, and those 100 used to show a full red Over flag built out of a closing count of zero', 'If you pick a month whose stock count is not done yet, the report says so and greys the figures out rather than showing them: without a closing count everything still on your shelves counts as "used", and every item would look over-consumed. Finish the Stock Count first — the Data Coverage card tells you whether both halves (sales + stock count) are in']
      },
      {
        icon: '₿', name: 'Outstanding Payables',
        guide: 'Tracks all credit purchases that have not been paid, grouped by vendor and by bill (invoice). Bill Total is what the vendor actually invoiced — net of any goods returned, minus the bill discount, plus 13% VAT on VAT-inclusive lines — so it matches the printed purchase voucher exactly. Aging buckets: Current / 31–60 / 61–90 / 90+ days. Click a bill to expand it and record a payment against the whole invoice at once. For a monthly credit run across several bills, use the checkboxes (or the header checkbox to select a whole vendor, or "Select All Filtered") to pick multiple bills and pay them all in full together with one shared date/note. A Month filter narrows the list to one BS period before selecting.',
        tips: ['Paid a supplier one amount against several bills? Press "Pay supplier…" on the supplier: Crest settles the oldest bills first and shows exactly which bills it will clear before you save. If you returned goods on a bill you had already paid, "Use supplier credit" takes that credit off another bill from the same supplier — it shows on both bills and on the balance letter, and deleting one side removes both', 'Anything in the 61–90 day bucket needs immediate follow-up with finance', 'Filter by Vendor + Month, then "Select All Filtered" to clear an entire month\'s bills for one vendor in one action', 'Partial payments are still per-bill only — expand a single bill to pay less than the full remaining amount. A part-paid bill stays here, in one piece, with what you have already paid shown against it', 'A purple Credit badge means goods went back AFTER the bill was settled, so the vendor owes you that amount — take it off the next bill or ask for a credit note. The Vendor Credits card on Paid History totals them', 'The payment date defaults to today in Nepal. If you are recording a settlement made yesterday, change it — the date decides which fiscal year it lands in on the Vendor Balance Confirmation letter']
      },
      {
        icon: '◑', name: 'Budget vs Actual',
        guide: 'Set monthly purchase budgets per category and compare against actual spend. Actual is net purchases — gross minus bill discounts minus vendor returns — the same figure Monthly Summary shows for the period. Shows variance in NPR and % with status badges (Over / Under / No Budget). Budgets are editable inline and save when you click out of the box.',
        tips: ['While the month is still open, bills are still coming in, so spending reads low and nothing is judged over or under budget until the month is closed', 'Set budgets at the start of each month before purchases begin', 'Spend on items with no category set appears as an "Uncategorised / unbudgetable" row so the Totals still reconcile against Monthly Summary. Set a category on the item in Item Master to bring it into a budget line', 'If a budget fails to save you get a message naming the category — what you typed stays on screen, so click out of the box again to retry rather than reloading', 'Use last month\'s actuals as a baseline when setting new budgets']
      },
      {
        icon: '⇄', name: 'Requisitions',
        guide: 'Internal stock transfer from store to departments. Create a requisition with items and requested qty. Issue mode lets the store manager confirm the actual qty issued. Issued requisitions appear as a "Requisitioned" column in the Stock Summary. Each line keeps the item rate it was issued at, so a slip you print again next month still shows the figure it was signed for. Before issuing, the app estimates what is on the shelf and warns — without blocking — if a line would issue more than that.',
        tips: ['Every slip records who raised it and who issued it, with the time. A request you cannot fill can be Rejected with a reason instead of deleted — nothing is issued, it stops counting as pending, and the department raises a new one if they still need the items', 'Save as Draft first, then Issue when stock is physically transferred', 'Requisitioned qty is tracked separately in the Stock Summary — keep it up to date', 'Keyed a quantity wrong on an issued slip? A supervisor can reopen it with Correct Quantities, or delete it, until the month is closed — after that, only the account owner can']
      },
      {
        icon: '◌', name: 'Dead Stock',
        guide: 'Identifies items with zero usage (Dead) or usage below 20% of available stock (Slow Movers). Shows value at risk per item. Filter by status or category. Helps reduce over-purchasing and expiry losses. It works backwards from what is left on the shelf, so it needs the month\'s closing count — items without one are excluded and counted in a notice at the top of the page.',
        tips: ['An item is Dead only after 3 counted months in a row with none used; one or two quiet months is Slow. Each item shows how long it has been still and a suggested next step — put it on the menu as a special, ask the supplier to take it back, buy less next time, or write it off', 'Do the closing count first. Without one this report has nothing to work from, and it will say so rather than tell you nothing is dead', 'Review dead stock monthly — items here repeatedly are candidates for removal', 'Value at Risk = closing stock qty × per UOM rate', 'An item counted higher than the stock available to it usually means a purchase bill is missing — those are excluded and flagged rather than reported as "never used"']
      },
      {
        icon: '◇', name: 'Recipe Margin',
        guide: 'Contribution margin report per menu item. Total Contribution is what the dish actually earned this period — revenue at the prices you actually charged, less discounts, less ingredient cost. Sort by Total Contribution, Margin per Portion, or FC%. "Only recipes with sales" toggle hides unordered items. Footer shows the weighted average FC% for whichever category tab you are on.',
        tips: ['Focus on high-volume items with low contribution — they hurt profitability most', 'Weighted avg FC% at the bottom reflects your true blended food cost', 'Total Contribution will not always equal Contribution per Portion × Qty. That gap is real: it is the price changes and till discounts that happened during the month. Contribution per Portion is today\'s price; Total Contribution is what actually came in', 'A dash instead of a figure means the dish has no food cost recorded — no costed ingredients and no manual cost. Those rows sort last and are left out of the totals, and a line above the table says how many there are. Add ingredients in Recipe Costing, or a cost in Menu Pricing']
      },
      {
        icon: '↗', name: 'Menu Repricing',
        guide: 'Finds dishes priced below their target food-cost %, and the price to charge to fix it. For each dish: current FC% vs Target FC%, the Suggested Menu Price (VAT-inclusive, rounded), the per-portion Price Gap, and the Monthly Opportunity (gap × qty sold). Sort by Monthly Opportunity, Price Gap, or "Most over target". The Dashboard "Menu Health" card summarises it.',
        tips: ['Reprice the biggest Monthly Opportunity items first — same cost, higher margin', 'Set each dish\'s Target FC% in Recipe Costing; the suggested price aims to hit it', 'Suggested Menu Price is VAT-inclusive (what you print); the Price Gap is ex-VAT, and it is measured against that same rounded price — so charging what the page suggests captures exactly the Monthly Opportunity it shows', 'A "Not Costed" card means dishes that have a price but no food cost. They cannot be compared against a target at all, so they are neither underpriced nor fine — cost them first, or the report is only telling you about part of your menu']
      },
      {
        icon: '★', name: 'Best Sellers',
        guide: 'Ranks menu items by revenue, volume, or margin. Shows Top 10 and Bottom 10 tables plus a bar chart. Filter by category. Helps identify what to promote and what to reconsider. Only items that actually sold this period appear — Bottom 10 is the bottom of the sold list, not a list of things nobody ordered.',
        tips: ['Use "By Margin" view to find items that sell well but contribute less profit', 'Bottom 10 by volume with high FC% = candidates for menu removal', 'Bottom 10 never repeats an item from Top 10, so with fewer than 20 items sold it will be shorter than ten rows. The numbers in it are the item\'s real position in the ranking', 'A dash in the Margin column means the dish has no food cost recorded, so there is no COGS to subtract. Those items are left out of the margin ranking and out of the COGS, Gross Profit and Overall Margin figures — the line under the summary says how many', 'The chart footer\'s average margin and the Overall Margin in the summary strip are different on purpose: the footer averages each dish equally, the summary weights by revenue. The weighted one is the figure your P&L would recognise']
      },
      {
        icon: '⋈', name: 'Combo Builder',
        guide: 'Shows which menu items are actually ordered together most often, from real POS bills over a 30/90/180-day window, and suggests a discounted combo price. Pick an anchor item, and the table ranks its most frequent pairings with a "Bills Together" count (paid bills only), how often that pairing happens as a share of the anchor\'s own bills, the combined price, the suggested combo price and the food cost % that bundle would run at. Insight-only — "Create as Menu Item" links to Menu Pricing so you create the priced bundle yourself; nothing is created automatically.',
        tips: ['A menu item with very few bills yet won\'t show pairings — needs more sales history first', 'Combo Discount % is saved per client — adjust it and every suggested price updates immediately', 'Try a longer window (180d) for a lower-volume item, shorter (30d) to catch a recent trend', 'Check the Combo FC% before you commit to a bundle. The discount comes straight out of your margin, so two dishes that are each fine on their own can be a loss-maker together — the column bands against your own thresholds, same as everywhere else', 'Bills Together counts paid bills only. A voided bill, a complimentary bill and an order still open on a table are not evidence that two things sell together', 'This report reads POS bills. Without the Crest POS module there is nothing for it to read, and no amount of waiting will change that']
      },
      {
        icon: '☑', name: 'Purchase Orders',
        guide: 'Write down what you have ordered from a supplier before it arrives, then tick it off when it does. Raise a PO (vendor, items, quantities, the price you agreed), print or send it, and mark it Sent. When the delivery turns up, press Receive, enter what actually came, and Crest creates the purchase bill for you — one bill, in the month the order belongs to, with the PO number as its reference. Short delivery? Enter what arrived; the order stays Partial and you receive the rest later. Nothing arriving at all? Cancel it. A part-delivered order that is never completed gets Close Short, which keeps what came and closes the rest.',
        tips: [
          'Raise a PO before the vendor delivers, so what you ordered and what arrived can be compared',
          'Receiving IS the purchase entry — do not also type the bill into Purchases, or the month counts it twice',
          'The delivery is filed in the order\'s own month: receive a Shrawan order in Bhadra and the bill lands in Shrawan, which the screen tells you before you confirm',
          'You cannot receive more than the order still has outstanding, and two people receiving the same delivery cannot both bank it',
          'Once bills exist against an order it can no longer be deleted — cancel it instead, so the record of what you ordered stays',
        ]
      },
    ]
  },
  {
    tier: 'pro', label: 'Pro Plan', planLabel: 'Pro', planColor: 'var(--theme-accent-ink)',
    features: [
      {
        icon: '≋', name: 'Period Comparison',
        guide: 'Compare key metrics across multiple periods. Shows Net Purchases, Wastage, COGS, Revenue, and FC% per period, each with a small % change line vs the previous period (and vs the same month last year when that toggle is on). Two trend charts (Revenue vs Net Purchases, and Food Cost %) plus a Revenue by Category chart sit above the table. Select last 6, 12, 24, or all periods — the range you pick is printed on the page, on the printout, in the workbook and in its filename.',
        tips: ['Months where some items were not counted are marked on the table and the chart and left out of "Best FC% Period"', 
          'Look for seasonal FC% spikes — often signals menu pricing hasn\'t kept up with ingredient costs',
          'Use the 12-period view for annual budget planning',
          'Turn on "Compare vs last year" to tell a real seasonal swing (festival month, tourist season) apart from genuine month-to-month drift',
          '"Highest Revenue Period" and "Highest Purchases Period" stat cards call out your peak months at a glance',
          'Export Excel includes a second sheet with the Revenue by Category breakdown, not just the main comparison table, and both carry your business letterhead and the period range',
          'The FC% colour bands read your own Settings → Thresholds values, the same ones Monthly Summary and the recipe pages use — the chart\'s reference lines, its dots and the table cells all move together',
        ]
      },
      {
        icon: '⊕', name: 'Shrinkage Report',
        guide: 'Multi-period analysis of actual vs theoretical usage per item. Flags items with consistent over-use across periods. Status: Consistent / Occasional / Once / Clear. Helps identify systematic waste or theft. Theoretical usage recurses through sub-recipes and accounts for each ingredient trim loss (yield %), so it agrees with the Variance Report.',
        tips: ['A month only counts as shrinkage when usage is over the variance tolerance set in Settings AND the loss is worth more than NPR 500, and only in months the item was actually counted', 'Consistent shrinkage on a high-value item over 3+ periods is a serious red flag', 'Use alongside the Variance Report for a complete picture of stock losses']
      },
      {
        icon: '⬢', name: 'Menu Engineering',
        guide: 'Classifies menu items into Star / Puzzle / Plowhorse / Dog based on profitability and popularity. FC% cutoff is 35%; the volume cutoff is the median qty sold across your whole menu, and a dish that sold nothing is never counted as popular. Sub-recipes are excluded. A dish with no selling price, or with no costed ingredients, has no food cost to judge — it is listed as Not rated rather than being placed in a quadrant.',
        tips: ['Stars = high margin + high volume → protect and promote', 'Dogs = low margin + low volume → consider removing from the menu', 'Anything in Not rated is a gap in your own data, not a verdict on the dish — the row says which half is missing, so add a selling price in Recipe Costing or give it ingredients (or a manual cost) and it will be classified on the next visit', 'Quadrants move month to month, because the popularity cutoff is that period\'s own median — read them as "as of this period", never as a permanent label on a dish', 'Revenue is what each dish actually charged: rows keep the price they were sold at, so editing a menu price today does not restate last month\'s figures', 'Opening this page on the CURRENT period also refreshes what the POS order screen suggests to your staff (the amber "Chef\'s pick" chips). Opening an old month is read-only and changes nothing.']
      },
      {
        icon: '⊗', name: 'FIFO / Expiry',
        guide: 'Tracks stock on a first-in, first-out basis. Shows what is left of each purchase batch — net of returns and of everything sold, wasted or served to staff, taken off the oldest batches first — with the day it was bought and the day it expires. Batches with nothing left are hidden. Helps prioritise use of oldest stock to minimise expiry losses.',
        tips: ['The report looks back 12 months from the month you pick, and your stock counts take any missing stock off the oldest batches first, so the expiry list matches what is really on the shelf', 'Check FIFO weekly for perishables — don\'t wait until month end', 'Set expiry dates in the Purchases entry for accurate FIFO tracking', 'Picking a period means "what was on hand at the end of that month" — batches bought in earlier months of the same fiscal year are included, because expiry does not stop at a month boundary', 'Days Left runs to today on the current month, and to the end of the month on any past one — otherwise a month you closed a while ago would report all of its stock as long expired']
      },
      {
        icon: '◷', name: 'Stock Ageing',
        guide: 'Shows how long the stock you are still holding has been sitting, bucketed into 0–30, 31–60, 61–90 and 90+ days across a fiscal year. Everything sold, wasted or served as staff meals is taken off the oldest batches first, and whatever survives is aged from the day it was bought and valued at what you actually paid for it. The headline figure is the money tied up in stock older than 90 days — shown as a minimum, with a △ rather than a tick, whenever stock carried into the year is still sitting in a younger band because the window itself is not yet 90 days long. Every age on the page is measured to a stated as-of date, shown in the chip under the page title and printed on both the sheet and the Excel export.',
        tips: ['Quantities follow your stock counts: when a closed month was counted, the shelf is set to what was counted, taking any shortfall off the oldest batches first. Ages are estimated from purchase dates, over the 12 months up to the month you pick. Stock found in a count that no purchase explains is shown as unknown age', 'Unlike FIFO / Expiry this covers every item, not just ones with an expiry date', 'A big 90+ day figure is working capital sitting on a shelf — review those items for over-ordering or a dish that stopped selling', 'Stock already on hand when the year began is marked "c/f" — its true age is at least what is shown, and it is the one figure valued at the current Item Master rate rather than at what was paid, because there is no purchase bill behind it', 'Early in a fiscal year the window is shorter than 90 days, so carried-in stock cannot reach the 90+ band however long it has really been sitting. The headline then reads "≥" with a △ instead of a green tick, and the note says how much is unaccounted for', 'Pick the current fiscal year and ages run to today; pick a past one and they run to the end of that year instead — otherwise every surviving batch would read as 90+ days old simply because the year is over', 'The age band columns show quantity; the TOTAL row under them shows each band\'s value, and it follows whatever filter you have applied, so it always adds up to the rows on screen']
      },
      {
        icon: '⊙', name: 'Vendor Report',
        guide: 'Net spend per vendor with columns for Gross, Returns, Net, % of total, average per day, and payment method breakdown (Cash / Credit / FonePay). Search by vendor name or code. Click a vendor name to drill down into every bill for that vendor this period — payment status (Paid / Partial / aging), and click any bill row to expand its line items, returns, and payment history. Searching down to a single vendor also switches the Daily Breakdown tab to show only that vendor\'s active days (no blank rows) — click any day to jump straight to that day\'s bill.',
        tips: ['Sort by Net to find your top suppliers — good candidates for negotiating credit terms', '% of Net shows vendor concentration risk', 'Click the vendor name for a bill-by-bill breakdown with payment status', 'Select a vendor in the search box, then click a day in Daily Breakdown to open that day\'s bill directly', 'All three tabs quote the same Net: gross, less the bill discount spread across that bill\'s lines, less returns credited at the price you actually paid. Return a whole discounted bill and the vendor comes back to zero', 'Cash + Credit + FonePay add up to Net Spend. A bill entered before Crest tracked the payment method counts as Cash, the same as everywhere else', 'The TOTAL row follows your search — filter to one vendor and the footer totals that vendor, with the real share of the period beside it rather than a flat 100%']
      },
      {
        icon: '◈', name: 'Supplier Contribution',
        guide: 'Splits the ingredient cost behind a period\'s sales across the suppliers that actually provided those ingredients. Crest stores no supplier on an item, so this is derived: what sold (Sales Entry and POS together, counted once) is exploded into raw ingredients through your recipes, valued at each item\'s per-unit rate, then split across the vendors you bought that item from this period in proportion to what you spent with each. Click a supplier to see the ingredients traced to it and, beside them, the menu items whose sales depend on it — what would come off the menu if a delivery failed. The Reliance Gap column compares a supplier\'s share of your sales cost against its share of your spend, in percentage points.',
        tips: ['"Top Supplier Share" is your concentration risk — one supplier above 50% means one delivery failure can close a section of the menu', 'A large positive Reliance Gap means you lean on that supplier more than your purchase ledger suggests — the first place to negotiate, and the first to second-source', 'The "Attributed Cost of Sales" card and the table\'s TOTAL row are deliberately different figures: the card excludes the "Not attributed" row, the TOTAL includes it, and the difference is exactly the Not Attributed card', '"Not attributed" is stock your sales used but you bought from nobody this month, usually bought in an earlier period — it is shown rather than hidden so the total always adds up', 'Figures are recipe-based (what the dishes should have used), not the actual count-based COGS — Variance is where those two are compared', 'Wastage and staff meals are excluded: this is the cost of what was sold. Complimentary items are included, since the food still came out of a delivery', 'If a dish you sold used an ingredient you have since hidden in Item Master, an amber notice says so and names the dishes — that ingredient cannot be costed here, so Cost of Sales is lower than what those dishes really consumed']
      },
      {
        icon: '✎', name: 'Vendor Balance Confirmation',
        guide: 'Printable per-vendor balance confirmation letter for a BS fiscal year — Opening Balance, Purchases, Payments/Returns, and Closing Balance, with a supporting bill-by-bill schedule showing the running balance. Matches Nepal IRD Annexure 13 (अनुसूची १३) reconciliation practice and NSA 17 external-confirmation audit evidence: sign, stamp, and return within 7 days. Reach it from Reports → Menu & Vendors, or via the "Confirm Balance" link on a vendor\'s row in Vendors.',
        tips: ['Opening Balance is computed as of the fiscal year\'s start date (Shrawan 1), not a live "today" snapshot. It can be negative when goods went back against a bill settled before the year began', 'Cash/FonePay bills appear in the schedule for full-turnover visibility but never carry a balance — each one prints twice, as the purchase and as the "Paid on purchase" settlement beside it, so the Payments (FY) box can be tied back to the schedule line by line', 'The schedule\'s Amount column totals to the net movement, i.e. Closing minus Opening', 'A negative Closing Balance is labelled Advance/Credit Balance rather than Amount Payable', '"Share via WhatsApp" pre-fills the Opening/Purchases/Payments/Returns summary and closing balance as a text message — the printed letter is still the document to actually sign']
      },
      {
        icon: '◫', name: 'Supplier Price Tracker',
        guide: 'Shows rate history per item per vendor with trend arrows (↑↓→). "Update Rate" opens a box to set the item master rate by hand — it does not sync automatically. Warns (⚠) if the master rate differs >5% from the last purchase. Archived suppliers stay selectable under "No longer active", because their past purchases are still part of the price history.',
        tips: ['Run this monthly after entering purchases — catch price creep early', '"Update Rate" overwrites the item master rate, which affects all future recipe costs', 'If a rate does not save, the page now says why and keeps what you typed in the box — a value that silently snaps back has not been saved', 'Print and Export follow every filter on screen, including the search box and the trend filter, so an exported sheet is the list you were looking at']
      },
      {
        icon: '⊞', name: 'Overheads',
        guide: 'Three-tab entry: Fixed Overheads, Labor Costs, and Tax & Fees. Generates a P&L Summary, Break-Even analysis, and Cost per Dish. Overhead allocation appears in each recipe\'s detail view as True Cost and True Net Margin.',
        tips: ['Depreciation from Fixed Assets is shown as a memo line on the P&L for reference — it is not subtracted from Net Profit. On an inventory staff login payroll cannot be read, so the page says so instead of showing a profit verdict', 'Opening a period with nothing entered yet auto-fills the most recent prior period\'s saved amounts as an editable draft — nothing is written to the database until you hit Save, so revise any line that\'s changed (a raise, a new lease rate) before saving', 'Update overheads monthly — fixed costs rarely change but labour does', 'If you run payroll in Crest HR, the Labour line comes from your finalized payroll run for that month (gross pay + overtime + employer SSF) and the Labor tab is ignored — a banner says so and names the amount it left out. The two are never added together, because they are two measurements of the same wage bill. Months with no finalized run fall back to the Labor tab as before', 'A bucket you have not filled in reads "not entered", not NPR 0 — and the P&L says in so many words that Net Profit is overstated by whatever is missing. Enter all three buckets before trusting the profit figure', 'The Food Cost line here is purchase-based (net purchases for the month), not the COGS figure from Monthly Summary: it ignores opening and closing stock, so a month where you stocked up reads worse than it really was. Every panel that uses it now says so', 'Dishes means portions sold, not guests. Crest counts guests as covers, and covers only come from POS bills — so Break-Even shows the number of dishes you need, and Cost per Dish is per plate, not per table']
      },
      {
        icon: '🏛', name: 'Fixed Assets', path: '/fixed-assets',
        guide: 'Register of tangible fixed assets (equipment, furniture, vehicles, kitchen machinery) — separate from Item Master\'s stock/inventory tracking. Five tabs: Register (add/edit assets, categories set default useful life & Nepal tax pool), Depreciation Runs (straight-line book depreciation — Preview computes nothing, Post writes and locks the schedule), Valuation Report (portfolio cost/NBV as of any posted period, by category), Disposal Report (disposed/written-off assets with gain/loss), and Tax Depreciation (IRD) — Nepal\'s statutory pooled written-down-value method (Income Tax Act 2058), a separate system from book depreciation that\'s expected to show a different number.',
        tips: ['Disposing of an asset charges depreciation up to the disposal date first, so the gain or loss is measured on today\'s value. A wrong depreciation run is undone with an Adjustment run, never by editing; posting a period that already has a run asks first', 'Staff/Supervisor IMS roles can view the register and run a Preview; only Manager/Owner can Post — this matches the payroll Finalize pattern', 'Once a depreciation run is Posted it is permanently locked — a correction is a new adjustment run, never an edit to the old one', 'The Tax Depreciation tab carries its own on-screen disclaimer — verify current pool rates and the repair-expense cap with your accountant before relying on it for an actual filing', 'Personal Use % on an asset excludes it from the default Valuation Report view — apportioned depreciation for a non-zero value isn\'t calculated in v1']
      },
      {
        icon: '△', name: 'Theoretical Variance',
        guide: 'Advanced variance analysis that isolates theoretical food cost vs actual, broken down by category. Deeper drill-down than the standard Variance Report. Compare against budget for a complete financial picture. It bands every figure against the same Settings → Thresholds → Variance Flag number the Variance Report uses, and shows the same ✓ ▲ ▼ ≈ marks — previously this page judged at a fixed ±5% of its own, so the two reports could disagree about the same item.',
        tips: ['The "Items Over Tolerance" card counts items outside your configured tolerance AND worth more than NPR 500. It used to count anything that differed at all, which on a normal month was almost every item, so the number was large, permanently red, and disagreed with the handful the table below actually flagged', 'An item with no closing count is marked "not counted" beside its name and left out of the totals — without a count its Actual is simply everything that was on hand, which is a figure rather than a finding', 'Items with both high theoretical and high actual usage → recipe portion sizes may need revision', 'Use alongside Budget vs Actual for the most complete picture']
      },
      {
        icon: '↗', name: 'Demand Forecast',
        guide: 'Predicts what each of the next 7 or 30 days will sell, and what to buy for it. For every coming day it takes the last eight days that fell on the same weekday in your sales history (POS bills, or manual Sales Entries where POS history is thin), weights the recent ones more heavily, and averages — so a café that is growing or quieting down is tracked within a few weeks, and you can always be shown exactly which eight Wednesdays produced a number. Under each day the dishes are listed as whole PLATES to prep (an average of 0.8 a day shows as 1; hover to see the average and how many weekdays it came from), with dishes that sell fewer than one day in two set aside as "occasional". Below the days, "Ingredients to buy" explodes the same forecast through your recipes and sub-recipes into raw items with a quantity and value for the whole horizon. Click "Recompute Forecast" to generate or refresh it — it does not run automatically. A holiday badge means the date matches your Holiday Calendar; with a Demand Multiplier set, the badge shows "×N" and every figure on that row is already scaled by it — without one, the holiday is only flagged and the forecast is NOT adjusted (treat it as a floor, not a ceiling).',
        tips: ['The ingredient list shows forecast use, what is already in store, and what to buy. Past public holidays are left out of the normal-day averages so a festival rush is not projected onto an ordinary week', 'Recompute weekly for the freshest prediction — it only reflects sales up to the last time you ran it, and the day you run it on is never counted (a morning\'s trade would otherwise stand in for a whole day)', 'The small print under the weekday says how much evidence stood behind the row — "from the last 8 Wednesdays" is a solid forecast, "from the last 2 Wednesdays with sales" is a guess. Forecasts made before this was recorded show no small print at all', 'Plates are rounded UP on purpose: for a dish that sells most days, one spare portion costs less than running out. "Occasional" dishes are still included in the ingredient list at their average, so you have what they need without prepping a plate', 'The 30-day view repeats the weekly pattern — days 8 to 30 use the same eight samples as days 1 to 7, and only the holiday multipliers differ between one Wednesday and the next', 'Forecast Revenue is BEFORE VAT, the same Revenue figure Owner Dashboard and Sales Entries use. A "≈" means it was priced (forecast dishes × current menu price) rather than measured from POS bills. Covers appear only for outlets with Crest POS, because manual Sales Entries carry none', '"Ingredients to buy" is demand, not a shopping list — it does not know what is already on the shelf. Check it against your last stock count or the Reorder Report before ordering, and use Export Excel to hand it to whoever buys', 'A gold holiday badge reading "×N" means the forecast on that row IS scaled for the holiday; an amber ⚠ badge means the holiday is known but has no multiplier, so the row is unadjusted and should be read as a floor rather than a ceiling', 'Set a Demand Multiplier on a holiday in Holiday Calendar (e.g. 0.3 if you close/run quiet, 1.5 if it\'s your busiest day) to have this page actually scale the forecast for it, not just flag it', 'Add movable holidays (Dashain, Tihar) to the Holiday Calendar so they get flagged even before you set a multiplier for them']
      },
    ]
  },
]

// ── HR feature data ───────────────────────────────────────────────────────────
const HR_FEATURES = [
  {
    icon: '▦', name: 'HR Dashboard',
    guide: 'The HR command centre. For managers and the owner, a strip at the very top says where the current payroll month stands, as four linked steps: Attendance (how many days are still unmarked for daily and hourly staff — those days pay nothing), Approvals (leave, overtime and travel claims touching the month), Payroll (not generated, draft, out of date or finalized) and the SSF deposit (the amount and the date it is due). Below it, an Approvals row covers every staff submission waiting on you — pending Leave requests, pending OT entries, pending TADA claims (manager-entered or Self-Service-submitted), and shift swaps that have cleared the coworker\'s accept and now need your sign-off. Below that: live headcount (active + probation), estimated basic payroll per month, advances outstanding, and employees retiring within 180 days. The payroll section summarises the last finalized run: net payable, employee SSF (11%), employer SSF (20%), and the total SSF challan amount to deposit — with the deposit deadline (25th of the following month — the law gives 25 days after the month ends; late deposits attract 10% interest). All four approval queues are listed further down so you can click through to approve or reject without navigating away.',
    tips: [
      'All KPI cards are clickable — click any card to jump directly to the relevant page',
      'The payroll strip picks the newest month that has started and is not finalized yet — so on 3rd Ashwin it usually shows Bhadra. Each step links to the page that moves it. The SSF step never says a deposit was missed: the app does not record deposits, so once the date passes it only says what was due',
      'SSF challan total = employee 11% + employer 20% from the last finalized payroll run; deposit with SSF by the 25th of the following BS month (25 days after the month ends, since the July 2025 amendment)',
      'The four Approvals cards (Leave, OT, TADA, Swap) turn amber when items are waiting — clear Leave/OT before running payroll so approved entries are included',
      'HR uses one status colour language everywhere — on these queues, on Leave, Overtime, TADA Claims, Advances and Shift Swaps, and in the employee Self-Service app: amber means it is still open and waiting on someone, gold means you have approved it but the money has not gone out yet, green means done, red means refused, and grey means withdrawn. The same request now looks the same to you and to the employee who filed it',
      'Swap Pending only counts requests the coworker has already accepted (status pending_admin) — one still waiting on the coworker isn\'t something you can act on yet, so it\'s left off this count',
      'The Basic Payroll / Month figure is basic salary only; full payroll (allowances, SSF, TDS, OT) appears in the Last Finalized Payroll section after the first payroll run',
      '"Retiring Soon" counts active/probation employees whose retirement date (DOB + 60 years, from the Employee record) falls within 180 days — click to see them in the Employees list',
    ]
  },
  {
    icon: '👤', name: 'Employees',
    guide: 'The Employee Master for Crest HR. Add and manage all staff — personal details, employment type, department, join date, and status (Active / Probation / Inactive / Resigned / Terminated). Four tabs per employee: Personal (code, name, PAN, NID, date of birth, phone, email, emergency contact), Employment (designation, department, type, dates, status, supervisor, retirement date), Address (permanent and current) and Family (parents, spouse, children, nominee). Salary, pay basis, bank details and SSF are not on this form — they are set in Pay Setup. Saving the form writes only the fields you changed, so it never undoes a pay change, a Final Settlement or a login block made somewhere else. Join and retirement dates on the list show in BS. Stat cards show Total Employees, Active (with an "N on probation" line underneath), Basic Payroll / Month and Retiring Soon — click Retiring Soon to filter the list.',
    tips: ['Employee code is optional and typed by hand (e.g. EMP-001) — nothing generates one if you leave it blank', 'SSF (11% employee + 20% employer, on basic salary capped at NPR 100,000/month) is set up in Pay Setup, and applies only to staff with SSF switched on and an SSF number entered', 'The Active card counts active staff only; probation staff are on the line underneath. Basic Payroll / Month includes both, but only monthly-paid staff and basic salary only — a daily or hourly rate is left out', 'End Date shows for Contract and Part-time staff, and on anyone who already has one. Payroll pays a monthly employee nothing for days after it, and Final Settlement sets it when someone leaves. An amber warning appears if the date has passed while the employee is still Active or on Probation',
      'There are two different Deactivate buttons. Deactivate inside the Edit form (for Active or Probation staff) sets the status to Inactive — it takes them off Final Settlement, the Roster and Attendance — and off Payroll unless they have an end date in that month (a leaver is paid up to their last working day whatever their status), but does NOT block their Self-Service login. If they are leaving, run Final Settlement first. On the list, ticking rows and pressing Deactivate (block login) only blocks their Self-Service PIN and never changes payroll; Activate (allow login) restores it. The bar only acts on ticked rows you can still see under the current filter',
      'Delete is refused for anyone with finalized payslips, a finalized Final Settlement, finalized festival allowances, an advance or loan, a Self-Service login, or TADA claims, incentives or shift-swap requests — use Deactivate instead. Someone added by mistake, with none of those, can still be deleted',
      'Enable / Remove Self-Service is available to the Owner and HR Managers. Each employee can have only one login: to give them a new PIN, Remove it and then Enable again. Copy Self-Service Link gives you the one link your whole team uses',
      'HR module must be enabled by your admin before the Employees page appears in your navigation']
  },
  {
    icon: '⚙', name: 'Pay Setup',
    guide: 'Configure and review salary, allowances, deductions, SSF, and bank details for every employee — all in one place. Click any employee row to open the Pay Setup form with two tabs: Salary and Bank/SSF. The Salary tab has three dedicated fields — Basic Salary, Dearness Allowance (महँगी भत्ता), and Other Allowances — plus deductions. The live Monthly Summary on the right shows the full breakdown: Basic → Dearness → Other Allowances → Gross → SSF and other deductions → Net before income tax → Cost to Company (CTC). Every figure on this page is a full month before income tax: Payroll works out TDS, absences, overtime, advance recovery and TADA each month, so the payslip\'s take-home pay will differ. If the pay falls below a Nepal minimum, a compliance panel checks all three minimums at once; otherwise a single ✓ line confirms it meets them. The Bank/SSF tab also has a Tax Deduction Declarations section where you enter the employee\'s annual life and health insurance premiums — these reduce taxable income before TDS is computed in Payroll. The list has three tabs — On payroll (active and probation staff, the default), All, and Not on payroll (inactive, resigned and terminated) — and the totals follow the tab you have open. The summary table shows Basic / Allowances / Gross / Deductions / Net before tax / Employer SSF with totals and an Excel export.',
    tips: ['Enter Basic Salary, Dearness Allowance, and Other Allowances as separate fields — dearness is stored and tracked independently per Nepal Labour Act', 'Nepal minimum wage (FY 2083/84 — the rates fixed from Shrawan 2082 under the Labour Act 2074): Basic ≥ NPR 12,170 · Dearness ≥ NPR 7,380 · Gross ≥ NPR 19,550/month; daily ≥ NPR 754, hourly ≥ NPR 101, part-time hourly ≥ NPR 107 — if any monthly check fails, the compliance panel shows all three at once', 'SSF is computed on basic salary only (capped at NPR 100,000) — dearness and other allowances are excluded from the SSF base', 'SSF (11% employee / 20% employer) applies only when SSF Enrolled is switched on AND an SSF No. is entered — the same rule Payroll uses. With the switch on and no number, Payroll deducts no SSF and charges the 1% social security tax instead, and the row shows an amber "⚠ SSF no. missing" chip', 'Nepal Labour Act requires basic salary to be at least 60% of gross — an amber warning appears if it is lower', 'Insurance premium deductions (Tax Deduction Declarations): Life insurance up to NPR 40,000/year and health insurance up to NPR 20,000/year — enter the employee\'s annual declared premium amount; Payroll applies the cap automatically', 'Each deduction row has a "Retirement fund — reduces taxable income" tick box, and the CIT / Provident Fund chip arrives already ticked. Payroll takes ticked deductions off taxable income together with SSF, up to NPR 5,00,000 a year or a third of annual income, whichever is lower — in monthly TDS, in Final Settlement, and in the tax on Festival Allowance and Incentive runs. Leave it unticked for anything else, such as an advance recovery', 'Cost to Company (CTC) = Gross + Employer SSF (20%) — the CTC row shows the employer\'s true monthly outlay', 'Net before income tax = Gross − SSF − other deductions. It is not what the employee receives: income tax (TDS), absences, overtime, advance recovery and TADA are applied in the Payroll run', 'If an employee\'s allowances and deductions fail to load in the form, Save is switched off — saving would erase them. Close and reopen to try again', 'Bank details added here flow into payroll — employees without a bank account show an amber warning']
  },
  {
    icon: '🗓️', name: 'Attendance',
    guide: 'Daily attendance per BS month, across three tabs. Mark Attendance lets you pick a day and set every employee\'s status (Present, Half-day, Absent, Paid/Unpaid Leave, Half-day Paid/Unpaid Leave, Off, Holiday) plus Start/End clock times, hours worked (for hourly staff), and overtime hours, one day at a time. By Employee is the same data the other way round — pick one employee and fill in every day of the month for just them, useful for entering a whole month for one person in one sitting. Every day defaults to Present until you mark it otherwise — there\'s no company-wide "everyone\'s off on this weekday" assumption. The Month Summary tab shows a colour-coded grid of the whole month with per-employee totals (Present / Absent / Off / OT hours), and exports to Excel. Attendance is the data source Payroll uses to calculate actual pay for daily and hourly workers and to apply overtime.',
    tips: ['↑ Import from machine (top right) brings in a month of punches from your fingerprint or face machine. Export the check-in and check-out report from the machine\'s software as Excel or CSV (not PDF) and choose it. Crest works out the layout itself — if it can\'t, you show it which columns hold the name, date and times. Then you pick which employee each person on the machine is (Crest guesses from the names, but check every guess), and see what will change before anything goes on the sheet',
      'What an import marks: a full in and out on a blank day becomes Present with those times, the break, and hours and overtime worked out as if you had typed them. A day already marked Present takes the machine\'s times (untick any you want to keep). Leave, Off, Holiday and Absent days are never changed. A day with no punch follows the roster — Absent if they were rostered to work, Off (or the leave or holiday) if they were rostered off, and left blank if they weren\'t on the roster. Days after today, and days before someone joined, are never marked',
      'An imported day with only one punch (someone forgot to punch in or out), or an in and out a few minutes apart, comes in amber with hours blank. Type the missing time, or change the day to Half-day, Absent or Off. Nothing from an import is saved until you press Save, and Save asks first if any amber day is still unfixed',
      'Mark as many days and people as you like, on either tab, then press Save once — the button counts your unsaved changes (e.g. "Save 12 changes · 3 days") and saves all of them together. Unsaved days are marked "— unsaved" in the Day and Employee pickers and on each row, and an amber banner names them. Only cells you actually marked or typed into are saved; anyone you did not touch stays blank', 'Switching to another month with unsaved marks asks first, and closing or reloading the tab warns you. Leaving the page from the menu does NOT ask — press Save first. For daily and hourly staff an unsaved day pays nothing', 'All Present / All Off / All Holiday fill only the blanks — a day already marked (approved leave, an absence, anything typed) is left as it is, and a message says how many were skipped. Change those one at a time', 'Setting a day to Absent, Paid or Unpaid Leave, Off or Holiday empties its Start, End, Break, Hours and OT boxes and switches them off — a day that was not worked takes no hours or overtime, because payroll pays overtime from every row whatever its status', 'Once payroll for a month is finalized, that month\'s sheet is locked: an amber banner says so and nothing can be changed. Reopen the payroll run first if the month really needs correcting, then finalize again', 'If the roster or its shift types cannot be read, an amber banner says overtime is not being calculated: typing Start/End will not fill Hours or OT and Generate from Roster is switched off, so nothing is measured against the wrong length of day. Type the figures yourself or reload', 'Clear Day clears only the staff listed on the sheet — someone who has left keeps their days, which Final Settlement reads', 'By Employee tab: pick a person from the dropdown, fill in their whole month day-by-day, then Save — the quick buttons (All Present/Off/Holiday) and ⚡ Generate from Roster there apply to just that one employee, not the whole team', 'Enter a Start and End time to auto-calculate Hours and OT Hours — hours beyond that day\'s Roster-assigned shift (or 8h if the employee isn\'t on the roster that day) become overtime automatically; both fields stay directly editable afterward if the auto-calc needs a manual tweak',
      '🗑 Clear Month on the Month Summary tab wipes the whole month for every staff member listed, to start the month over (e.g. clear, then ⚡ Generate from Roster again). It won\'t run once that month\'s payroll is finalized. Approved leave days are removed too — use Leave → Mark approved leave to put them back',
      'If the day\'s shift has Normal hours set (Roster → Shift Types), overtime is counted in clock time from Start to End, lunch included — e.g. a Full Day with 9 normal hours punched 8:00 to 20:00 is 3h OT, whatever you enter as Break',
      'Start/End times accept plain digits too — type "0800" or just "8" and it\'s read as 8:00, no need to type the colon yourself; it\'s reformatted to H:MM once you leave the field',
      'If someone clocks in noticeably fewer hours than their Roster-assigned shift for the day, an amber "⚠ X.Xh short" note appears next to OT Hours — it\'s a heads-up only, nothing is auto-deducted (Nepal\'s Labour Act only defines a full-day absence deduction, not a per-hour one); reclassify the day as Half Day yourself if that\'s warranted',
      'Break (minutes) subtracts an unpaid lunch/break from Start-to-End before it becomes Hours Worked — enter it before or after typing Start/End, Hours and OT Hours recalculate either way; leave it blank for a shift with no unpaid break',
      'Set "Default break" once (starts at 45 min) and click Apply Break to Day / Apply Break to Month to fill it into every already-marked row that still has a blank Break — it only fills gaps, never overwrites a Break value you already typed, and never touches a day/employee you haven\'t marked at all', '⚡ Generate from Roster fills blank days from that month\'s Staff Roster shift assignments — a real shift with hours is marked Present, with any hours beyond the shift\'s Normal hours filled in as OT. A zero-hour shift type is read by its name: "PAID LEAVE" becomes Paid Leave, any other "LEAVE" becomes Unpaid Leave (name a paid kind so it says paid, e.g. "Paid Sick Leave"), "Holiday" becomes Holiday, and "OFF DAY" becomes Off. It never overwrites a day you\'ve already marked, and never guesses at a day with no roster entry at all — those are left for you to mark manually', 'A roster shift with no hours whose name says none of leave, holiday or off (an unusual custom type, e.g. "Training") is marked Off by Generate from Roster — only a shift named Holiday becomes a Holiday. The difference matters for daily- and hourly-paid staff: a Holiday day is paid (a day\'s wage, or 8 hours), an Off day is not. For monthly staff both are pay-neutral. Use a formal Leave Request if the absence should show as Paid/Unpaid Leave', 'Off days are marked per employee, per day — there\'s no single company-wide off weekday anymore; if most of your team is off the same day each week, "All Off" on that date (Mark Attendance tab) is a one-click way to mark everyone at once', 'Half-day Paid/Unpaid Leave are written automatically when a half-day leave request is approved (see Leave) — Half-day Paid Leave costs the employee nothing, Half-day Unpaid Leave deducts half a day\'s pay', 'Public holidays are marked manually — use the "All Holiday" button or set Holiday per employee', 'The Hours column only appears for hourly-paid employees; OT hours can be entered (or auto-calculated) for anyone', 'Overtime is captured here and paid at 1.5× the normal hourly rate during the payroll run', 'Only active and probation employees appear on the sheet']
  },
  {
    icon: '📋', name: 'Roster',
    guide: 'Plan weekly or monthly staff shifts. Four tabs: Roster Board (the schedule itself), Shift Types (customise shift names, times, colours, hours), Labor Forecast (demand-forecast overlay — see below), and Shift Swaps (approvals + the permanent swap record). Two view modes on the board: Monthly (pick a BS month; the board splits into two halves — days 1–16 and 17–end — so nothing overflows) and Weekly (7-day grid centred on the selected week). Click a cell to assign a shift, or click-and-drag across a rectangle of cells (multiple days, multiple staff, or both) to assign the same shift to all of them in one action — useful for a multi-day Leave block or a whole week of the same shift. Most weeks repeat, so Weekly view has a ⧉ Copy to Next Week button: it stamps every shift on the week you\'re looking at onto the same weekday next week, and then moves you to that week so you can edit the exceptions. It makes the two weeks identical rather than merging them — a cell that\'s empty this week is cleared next week — and the confirmation counts exactly what will be replaced and cleared before anything is written. It copies only the departments the filter is currently showing. Print the schedule with a Company Name/Address letterhead for department heads — the Board only prints the shift assignments, never any labor-cost data. A Draft/Published badge and a Publish button appear in both Weekly and Monthly view — publishing releases just the visible days (7 in Weekly, the whole month in Monthly) to Employee Self-Service and sends a real push notification to every subscribed employee with a shift on one of those specific days; you don\'t have to finish scheduling the whole month before publishing any of it. The badge shows "◐ x/y Published" when only some of the visible days have been published so far. Editing after publishing doesn\'t auto-notify again — use Re-Publish + Notify if you want another push out. A red hatched cell means that employee has an approved leave request that day — assigning a shift there asks for confirmation instead of silently double-booking them. The Shift Swaps tab holds both halves of that feature: "Waiting on your approval" lists swaps employees have already agreed between themselves and need your final Approve/Reject, and "Swap History" is a table of everything already decided (approved, rejected, declined by the coworker, or withdrawn), with who settled it and when. While anything is waiting, an amber count sits on the tab button itself, so you can see there is something to approve without opening it. History covers every month, not the week or month the board is showing — which is why it is a tab rather than a drop-down over the board.',
    tips: [
      'Plan the roster before the month starts — it helps forecast labour cost and avoids scheduling conflicts',
      'Roster is for planning; Attendance is the official record that feeds payroll — use ⚡ Generate from Roster on the Attendance page to pull shift assignments across as a starting point instead of retyping them',
      'Click and drag across cells to assign the same shift to multiple days/staff at once, instead of one click per cell',
      'Each employee can only have one shift per day — assigning a new one replaces whatever was there before',
      '"Clear (Unassign)" at the bottom of the shift picker removes the assignment entirely — the cell goes blank and that day disappears from the employee\'s own Self-Service roster (there\'s nothing to show). To actually mark someone off in a way that still shows up everywhere, assign a real shift type instead — e.g. the built-in "Day Off" (0h) — not Clear',
      'The Shifts tab lets you rename, recolour, and adjust the hours of any shift to match your venue\'s terminology',
      'For a long shift, fill in Normal hrs on the Shift Types tab: Full Day 8am–8pm is 12 hours, and 9 normal hours makes the other 3 overtime — Attendance → Generate from Roster fills that OT in, and the Labor Forecast prices it at the overtime rate. Leave it blank when the whole shift is normal time',
      'To mark someone\'s recurring day off, assign the "Day Off" (or any zero-hour, off-named) shift type on the Roster board for those dates — Attendance → Generate from Roster then picks it up as an Off day automatically',
      '🖨 Print shows the Company Name/Address, the period, and the shift legend above the board — no Excel export, print/Save-as-PDF only',
      'Publish is per day — self-service employees never see a draft day, only what you\'ve explicitly published, even if the rest of the month is still being worked on',
      'Publish from Weekly view to release just that week; Publish from Monthly view releases every day in the visible month in one click — use whichever fits how you plan',
      'Shift Swap: an employee requests a trade with a coworker from their own Self-Service Roster tab; the coworker must accept before it lands in your Shift Swaps tab for final approval — approving actually trades who\'s scheduled on each day',
      'Swap History keeps every decided request, not just the last one — useful for resolving "I thought I was working that day" disputes without digging through Attendance',
      'Leave-conflict cells (red hatching) still let you assign a shift with a confirm — useful if a leave was approved in error and needs overriding',
      'Each shift type needs its own name — a second "Morning" is refused, so call it "Morning – Kitchen". A shift type that is on the roster cannot be deleted (it would blank those days, and Generate from Roster would then mark them Off); untick Active to retire it instead',
      'Approving a swap happens in one step and refuses — leaving the roster untouched — if the swap was withdrawn or already decided, if either day no longer carries the shift the two employees agreed to trade, or if one of them already works the other day. Reject it and ask them to request it again from the current roster',
      'Suggest leaves out anyone on approved leave that day',
      'Labor Forecast tab: one row per day (Weekly or Monthly, same navigation as the Board) showing Hours, Revenue, Labor Cost, Cost %, Recommended Staff, Staff, and a Covered/Short status badge, with a Week/Month total row underneath — deliberately kept off the Board and out of print since it\'s management-only data, not something to hand to staff',
      'Days that have already happened are marked "actual" and show what was recorded rather than a forecast: hours and staff from Attendance, revenue from Sales Entries (the same figure Owner Dashboard calls Revenue), covers from closed POS bills, each with the rostered figure in small print underneath. Demand Forecast only ever covers the days ahead, which is why a past day never has a forecast — this is how you check whether the Covers/Staff target and the roster held up. A past day with no attendance entered yet uses the rostered shifts instead, labelled "as rostered" — the roster is the day\'s best record until Attendance is marked, and the row switches to the hours actually worked once it is',
      'The total row mixes the two honestly: past days at actual figures, coming days at plan and forecast, with a badge saying how many of each went in. If a month\'s sales were entered as one bulk figure rather than day by day, the tab says so — those days\' actual revenue is understated and their Cost % reads high',
      'Each day also shows what it NEEDS, on the second line under Hours: the revenue for that day divided by the sales per labour hour this outlet has actually been running, learned from its own last 120 days. Recommended Staff comes from the same place — required hours divided by the shift length your outlet really runs — so an outlet with no POS at all now gets a staffing figure for the first time. Where there is not enough history yet it falls back to covers ÷ your Covers/Staff target, and the small print under each number says which was used',
      'The line above the table says what the figures were learned from: how many days, how recent, the sales per labour hour, and how many days had no Attendance so their rostered hours stood in. Because Attendance is often entered in one batch at month end, that evidence is routinely a few weeks old, which is why the tab states its age rather than letting a learned number look live',
      'When some days had no Attendance, the app measures the gap between what you roster and what your staff actually work, and adjusts those days by it — you will see something like "adjusted by the 17% gap measured over 63 days that had both". That gap is worth knowing on its own',
      'It says what your outlet normally uses per rupee of sales, not what it ideally should. If you have been running heavy, it learns that too — treat it as a starting point you can argue with, not a rule',
      'A dash always has a reason written under it in small print: "no forecast" on a coming day means Demand Forecast has not been run far enough ahead to reach it, "as rostered · no attendance" on a past day means nobody has entered that day in Attendance yet, so the rostered shifts stand in for it (a day is never shown as 0h just because attendance is missing). Recommended Staff and Covered/Short only appear for outlets with Crest POS, because covers are counted from POS bills and manual Sales Entries carry none',
      'Planned Labor Cost is what the hour costs the business, not just basic pay: monthly basic plus that person\'s earning allowances from Pay Setup spread over the month\'s working hours (or the daily/hourly wage), plus the 20% employer SSF share for anyone enrolled with an SSF number. That is the same definition the Owner Dashboard uses for Labour Cost %, which is what makes the two comparable',
      'Cost % on that tab is banded and marked, not just coloured: ✓ at or under 30% of forecast revenue, △ from 30 to 37%, ▲ above it. Those are the same thresholds and the same marks the Owner Dashboard and the Monthly Owner Report put on Labour Cost %, so a day that reads healthy here reads healthy there. Read the total row for the verdict — the band is a monthly benchmark, so a single quiet weekday can show ▲ while the week is fine',
      'Scheduled Staff counts people rostered on duty. Day Off, Leave, Holiday and any other zero-hour shift are not counted — so marking six people off does not read as six people covering the floor',
      'A "⚠ N unpriced" badge on Scheduled Hours means that many working shifts that day have no hours set (the built-in Split shift ships without any) — they add a head to Scheduled Staff but nothing to hours or cost until you set the hours on the Shift Types tab',
      'The Department filter is on this tab too, and it only narrows Scheduled Hours and Planned Labor Cost. Forecast Revenue, Recommended Staff and Scheduled Staff always stay whole-outlet, because the forecast covers are served by everyone — a kitchen-only Cost % is that department\'s cost against total revenue, which the tab says while the filter is on',
      'A "Forecast last generated" line shows how old the forecast under these rows is, and turns amber past a week — re-run Demand Forecast when it does',
      'A day shows "—" for forecast columns until Demand Forecast has been run/refreshed for that date on the Demand Forecast page',
      'A festival/holiday badge next to a date on the Labor Forecast tab means Demand Forecast matched it against Holiday Calendar — "×N" means that day\'s Forecast Revenue/Covers were scaled by the Demand Multiplier set on that holiday; an amber ⚠ badge with no "×N" means the holiday is known but no multiplier has been set yet, so the forecast is unadjusted for it and is a floor rather than a ceiling (the adjusted badge is gold; the two used to look identical) — set one in HR → Holiday Calendar if this is a day your business runs noticeably busier or quieter',
      'Recommended Staff = forecasted covers ÷ Covers/Staff target (editable on the Labor Forecast tab, saved per client, default 20) — a starting estimate, not a hard rule',
      'On the Board itself, a short-staffed day\'s column header shows a small "Rec: N" hint (amber if you\'re currently under it) — hidden from print, screen-only, so you see the target while you\'re actually assigning shifts',
      '✨ next to a short-staffed "Rec: N" opens Suggest — a ranked pick of who to schedule (fewest hours scheduled this period first, among whoever the Department filter currently shows) — pick a name, then pick their shift, same as assigning normally',
    ]
  },
  {
    icon: '🏖️', name: 'Leave',
    guide: 'Tracks leave entitlements, requests, and balances. New clients start with Nepal\'s Labour Act 2074 leave types pre-loaded — Home/Annual (18 days), Sick (12), Bereavement (13), Maternity (98), Paternity (15), and Unpaid — which an admin can edit on the Leave Types tab. Record a request on the Requests tab (employee, type, BS start/end dates, reason); every calendar day in the range counts against the balance except public holidays from the Holiday Calendar, which are not charged and are marked Holiday on attendance — a recurring off day still counts, so adjust the dates if the employee has one within the range. For a single-day request, a Day Type choice appears — Full Day, First Half, or Second Half. An admin approves or rejects: approving automatically marks those days in Attendance as Paid/Unpaid Leave (or the Half-day equivalent), so Payroll deducts unpaid leave on its own — a half-day of a paid leave type costs nothing, a half-day of an unpaid type deducts half a day. The Balances tab shows each employee\'s used / quota per leave type for the year, with an Excel export. Rejected or cancelled by mistake? An HR manager (or the owner) gets a Reopen button on that row, which puts the request back to Pending with its original dates and reason so it can be approved again.',
    tips: ['"Approve all N…" above the requests approves every pending request that can go through without a question, marking their attendance days exactly as approving one does. A request over its yearly quota, or in a month whose payroll is finalized, is left out and named so you decide it on its own', 'Six Nepal Labour Act leave types are seeded automatically the first time you open the page', 'Every day in the picked date range counts against the balance except public holidays in your Holiday Calendar — the form shows how many were left out. There\'s no automatic day-off exclusion, so double-check the range if it spans a day the employee doesn\'t normally work', 'Day Type (Full Day / First Half / Second Half) only appears when Start and End date are the same — it forces back to Full Day for a multi-day range', 'Half-day requests count as 0.5 in the balance and on Attendance, and respect the leave type\'s paid/unpaid flag same as a full day would', 'Approving a request writes the Attendance rows for you; rejecting or cancelling an approved request clears those days back to blank — not to Present, since nobody knows whether the employee actually worked, so re-mark them in Attendance if they did',
      'Reopen (HR managers and the owner only) undoes a mistaken reject or cancel — the request returns to Pending, keeping its dates, reason and history. It marks nothing on Attendance and moves no balance on its own: approve it again to put those days back', 'Leave approved for a month that has not been opened yet cannot be written to an attendance sheet that does not exist — approval says so, and those days are marked automatically the moment that month is created. Nothing to do, and nothing is lost', 'A banner at the top of the Leave page counts any approved leave still missing from an attendance sheet — "waiting for the month" needs no action, anything else gets a Mark approved leave button. It never overwrites a day you marked by hand', 'Unpaid leave flows into Payroll as an absence deduction; paid leave does not reduce pay', 'Maternity (98 days) and Paternity (15) are per-event statutory entitlements, not annual quotas', 'Carry-forward is recorded for reference but unused days do not yet roll over automatically', 'Two requests for the same employee cannot share a day while either is pending or approved — cancel or reject the other one first. This applies to requests from the Staff app too', 'Approving a request that takes the employee past the leave type\'s yearly quota asks first, and says how many days over it goes — you decide; to pay only the days within the quota, reject it and file the extra days as Unpaid Leave', 'The number of days is always worked out from the dates (every calendar day except public holidays, 0.5 for a half day) — it cannot be typed or sent differently, including from the Staff app. A request made only of public holidays, or a half day on one, is refused', 'Once payroll for a month is finalized, leave touching that month can no longer be approved or cancelled, because its days are on payslips already issued — reopen that payroll run first']
  },
  {
    icon: '📆', name: 'Holiday Calendar',
    guide: 'Per-client list of Nepal public and optional holidays for each fiscal year. Two types: Public (gazetted by the Nepal government — all staff entitled to the day off; overtime entered in Overtime for a public holiday is suggested at the 2× holiday rate) and Optional (gazetted only for part of the country or a community — Teej, Gai Jatra, Christmas — plus any floating day you add). Any HR login can view the calendar; adding, editing, deleting and seeding are for HR Supervisors and Managers, the Owner and Crest admin, so HR Staff see it read-only. Use the "Seed FY …" button to fill the year from the Nepal Gazette in one press. It adds the seven fixed-date national holidays (New Year on Baishakh 1, Republic Day on Jestha 15, Constitution Day on Ashwin 3, Prithvi Jayanti on Poush 27, Maghe Sankranti on Magh 1, Martyrs\' Day on Magh 16, National Democracy Day on Falgun 7) AND every gazetted movable holiday held for that year — Dashain, Tihar, Chhath, Janai Purnima, Krishna Janmashtami, Teej, Shivaratri, the three Lhosars, Holi and the rest. It never changes the date or type of a holiday you entered or edited, and it tells you what it could not cover — including any BS year with no gazette yet. The one thing it does change: a fixed-date holiday found on the wrong date is corrected. A holiday you removed stays removed — Seed never adds it back. Seed is switched off if the calendar failed to load, and the same holiday twice (same date and name) is refused. Two limits it states on screen: movable dates are transcribed per BS year from the gazette Nepal publishes only in Falgun of the year before, so the last quarter of the current fiscal year (Baishakh–Ashadh) carries fixed-date holidays only until then; and Eid al-Fitr, Eid al-Adha, Mohammad Jayanti, Guru Nanak Jayanti and Bhoto Jatra have no gazetted date at all, so they always need adding by hand. Holi is seeded for both Hill (Chaitra 7) and Terai (Chaitra 8) — remove whichever does not apply to your outlet; it moves to the Removed list under the calendar, where Put back restores it and Delete for good erases it (a gazetted holiday deleted for good would be seeded again). Each holiday can optionally carry a Demand Multiplier (e.g. 0.3 for a day you close/run quiet, 1.5 for a day you\'re slammed) — set it once per specific date and it automatically scales that day\'s covers/revenue/item forecast on the Demand Forecast page and Roster\'s Labor Forecast tab; leave it blank and the day is still flagged, just not adjusted. Holidays are stored per fiscal year and scoped to each client.',
    tips: [
      '"Seed FY …" adds the 7 fixed-date holidays plus every gazetted movable holiday we hold for that fiscal year\'s BS years, and names any BS year with no gazette yet — it skips holidays already there, including ones you removed',
      'Only the sighted holidays — Eid al-Fitr, Eid al-Adha, Mohammad Jayanti, Guru Nanak Jayanti and Bhoto Jatra — always need adding by hand each year (plus, until Nepal publishes the gazette, the movable holidays of a BS year Seed says it does not cover yet)',
      'FY selector groups holidays by fiscal year (Shrawan to Ashadh). Months 4–12 use the FY start BS year; months 1–3 use the following BS year — the "stored as BS year" hint in the form confirms which year a date maps to',
      'Overtime entered in Overtime for a public holiday date is suggested at the 2× holiday rate. Each overtime entry keeps the rate it was entered at, so editing or deleting a holiday later does not reprice overtime already entered',
      'HR Staff-rank logins see the calendar read-only — the database enforces this, not just the page. Every holiday added, changed or deleted is recorded in the Audit Log',
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
      'Attendance OT (captured in Attendance Sheet → OT Hours column) and Overtime entries do not stack — on a day that has an approved Overtime entry, that entry is what payroll pays and the attendance OT for that day is ignored. Use OT entries for the formal approval trail and the holiday 2× rate; attendance OT for quick daily capture.',
      'The Pending Approval number is a button — press it to show pending entries only',
      'With two or more entries waiting, a bar above the list offers "Approve all N…": it states the total hours, asks once, then approves each entry in turn and names any it could not (for example your own entry, which someone else has to decide)',
      'Rejected entries are kept for the audit trail — they are NOT included in payroll and cannot be undone without clicking Undo first',
      'One entry per person per day — every approved entry is paid, so a second entry for the same day is refused. If someone did 2 hours in the morning and 2 at night, log one 4-hour entry',
      'Once payroll for a month is finalized, its overtime is locked — nothing on that month\'s list can be approved, edited, undone or deleted, and new entries for that month are refused. Reopen the payroll run first',
      'Every overtime entry added, approved, changed or deleted is recorded in the Audit Log',
      'An entry for someone who has since left still shows their name',
    ]
  },
  {
    icon: '🧮', name: 'Calculation (on the Payroll page)',
    guide: 'The exact math behind every number on a payslip, per employee — open the ▸ beside a name on the Payroll page. (It used to be a separate Calculation page; it now sits right under the figure it explains, and old links open Payroll.) Nothing is generated or saved from it. On a month that is still a draft, every figure is worked out right now from current Attendance, Roster, Overtime and Advances data, using the same functions Payroll itself uses. On a finalized month nothing is recalculated: each payslip is shown exactly as it was paid, with every figure explained in plain words — so a raise you give in Magh never makes Bhadra\'s paid payroll look wrong. The working shows the attendance tally, the absence-deduction formula step by step, overtime split by source (attendance sheet vs. approved Overtime entries), SSF, a full income tax (TDS) working, advance and TADA detail, and the final Net Pay reconciliation.',
    tips: ['On a draft month, if something changed since the run was last Generated/Regenerated, the working opens with "△ This payslip is out of date" and names what changed (e.g. "Overtime NPR 1,200 → 1,800") — the figures under it are then current data, not the stored row above. Fix it with Regenerate. A finalized month never shows this', 'A draft payslip for someone this run should not pay (for example someone who left before the month started) shows the stored figures with a note that Regenerate will remove it. People whose finalized Final Settlement already paid the month are named on the Payroll page instead', 'The income tax panel shows the year\'s tax band by band (e.g. "first NPR 10,00,000 at 1% — waived because SSF"), how many months are left in the tax year, and the "tax due by this month". Earlier months include any festival allowance or bonus income. If one month\'s pay was too low to take all the tax due, later months pick up the rest', 'The advance lines show the cut due against the cut actually taken — if pay after tax could not cover the whole instalment, the rest is still owed and comes off later salaries', 'A day left unmarked on the attendance sheet is PAID for monthly staff — only absences, unpaid leave and half days take pay off. For daily and hourly staff an unmarked day pays nothing', '"Travel claims paid by this payroll" counts Approved TADA claims whose trip ended by the end of the month — a trip still going on at month end waits for the next payroll', 'When an employee has OT in both places, the working shows the attendance-sheet vs. approved-Overtime split — approved entries supersede the attendance sheet day by day, so you can see exactly which hours were paid and which were displaced', 'Open it before Finalizing a payroll run whose numbers look off — it shows exactly which input (an absence count, a TDS projection, an OT source) produced the number you\'re questioning', 'Press 🖨 Print working on an open row to print (or save as PDF) that one employee\'s full calculation sheet — nothing in it hides behind a hover, so the paper copy says everything the screen does']
  },
  {
    icon: '💵', name: 'Payroll',
    guide: 'Runs monthly payroll for a BS period by combining each employee\'s salary structure with their attendance. Click Generate Payroll to create a draft register: monthly staff get basic + allowances minus SSF, unpaid-absence deductions, and other deductions; daily/hourly staff are paid for actual days/hours worked, plus paid leave and Holiday days (a day\'s wage, or 8 hours — the Labour Act gives every worker paid public holidays); everyone gets overtime at 1.5×. Who is paid: active and probation staff, plus anyone who left during the month — paid up to their last working day, whatever their status now. Someone whose finalized Final Settlement already paid the month is left out and named on the page, and nobody gets a payslip for a month they did not work a single day of. Type over TDS (income tax) while the run is a draft, Regenerate to pull the latest salary, attendance and tax, then Finalize to lock the payslips as a permanent record. Each employee has a printable payslip, and the whole register exports to Excel. Only an HR manager or the owner can generate, finalize, reopen or edit payroll — the database enforces this, not just the page. The Cost to Business card shows what the month really costs: pay earned plus the employer\'s 20% SSF.',
    tips: ['The strip at the top of the page shows where the month stands — attendance, approvals, this run and the SSF deposit — with links. Once the run is finalized, "Next for <month>" links straight to that month\'s bank transfer sheet, SSF challan and TDS report', 'Correct deductions are printed in the normal text colour with a minus sign — colour is kept for things that need you, such as "⚠ SSF no. missing"', 'Mark attendance for the period first — payroll reads present days, hours, and overtime from it', 'Cost to Business is more than Net Payable because the business still pays the staff SSF, CIT and income tax it withholds — to the SSF fund and the tax office instead of to staff. Example: net pay NPR 1,76,572, but the month costs NPR 1,84,868 once employer SSF is added. Travel claims are shown underneath it, not inside it', 'Finalize and Reopen each happen as one step: every ledger — the payslips lock, the travel claims marked Paid, the advance repayments — is written together or not at all. If the run was regenerated in another tab while you were finalizing, nothing is written and you are asked to reload', 'Advance repayments that payroll recorded cannot be deleted by hand in Advances & Loans — Reopen the payroll run instead', 'A run is Draft until you Finalize it — finalized payslips are frozen even if you later change a salary. A finalized run and its payslips are locked by the database, not just the page, so Reopen it before changing anything. A month with finalized payroll cannot be deleted from Periods', 'Finalize checks everything once more against current data before writing anything, and refuses if the draft is out of date, if anyone is missing a payslip, or if there is a payslip for someone this run should not pay — Regenerate fixes all three. The confirmation also tells you if the month is not over yet (how many days are left) and how many leave or overtime requests are still pending. Finalizing early is allowed, but anything decided afterwards needs a Reopen', 'SSF (11% employee / 20% employer) is applied only to employees who have an SSF number on file', 'Unpaid-absence deduction = gross (basic + allowances) ÷ days in the BS month × unpaid days — an unpaid day forfeits the whole day\'s pay, and SSF is contributed on the basic actually earned',
'Overtime can be entered on the attendance sheet or approved in the Overtime module. Where a day has both, the approved entry wins and the attendance hours for that day are ignored — the same hours are never paid twice. Holiday OT at 2× is only available through the Overtime module', 'TDS (income tax) is computed automatically from the fiscal-year tax slabs using year-to-date projection — finalize earlier months first so each month builds on the last', 'You can type over a TDS figure while the run is a draft. A typed figure is kept when you Finalize — it counts as a deliberate override — and the ↺ button beside it puts back the calculated figure. A TDS that would take someone\'s pay below zero is refused', 'Anything else that changes income tax — an earlier month finalized late, an insurance premium entered in Pay Setup, a festival allowance or bonus paid — makes the draft out of date. Press Regenerate before you Finalize', 'SSF contributors get the 1% first-slab social security tax waived, so most staff under roughly NPR 83,000/month gross pay zero income tax', 'SSF is deducted only when an employee is BOTH marked SSF-enrolled and has an SSF registration number saved in Pay Setup — an enrolled employee with no number contributes nothing and is flagged "⚠ SSF no. missing" in the payroll list, because a contribution with no number cannot be filed on the SSF challan', 'The TADA column cannot be edited here. An Approved TADA claim is paid by the first payroll after approval once the trip is over (its end date is on or before the last day of the month) — a trip from 30 Bhadra to 2 Ashwin is paid in the Ashwin payroll, and never twice. It is added after TDS, on top of net pay, without running through tax or SSF (a 🔗 icon shows how many claims). To change the amount, change or reject the claim in TADA Claims, then Regenerate. Finalizing marks exactly those claims Paid (Payroll); Reopen puts them back to Approved', 'An advance or loan cut never takes take-home pay below zero — if pay after tax is less than the instalment, only what is there is taken and the rest stays owed for later salaries. A fixed deduction such as CIT is cut the same way in a short month (for example someone who joined on the 25th)', 'Use the Payslip button on any row to view and print an individual payslip — while the run is still a draft it prints stamped "Draft — not final", so nobody mistakes it for the real one', 'The Excel export includes Department, Status, Unpaid Days, Worked Days, Hours Worked and Retirement (CIT) columns; a draft\'s file name ends in _DRAFT', 'The payslip header shows your company name, address, and PAN (from Settings) plus the employee\'s SSF number when they\'re SSF-enrolled — fill in Settings → Property Address/PAN if the header looks incomplete']
  },
  {
    icon: '📊', name: 'HR Reports',
    guide: 'Turns a finalized payroll run into the documents you file and pay with. Five tabs: Payroll Summary (totals + employer cost by department), SSF Challan (per-employee 11% + 20% = 31% to deposit), Bank Transfer (each employee\'s bank and net pay), TDS Report (income tax this period + year-to-date, including festival allowances and incentives paid that month), and TDS Certificate — a printable per-employee annual certificate for the whole fiscal year showing month-wise gross/SSF/TDS, festival allowances and incentives listed separately, taxable income computation (including insurance deductions), and signature blocks. Every report except TDS Certificate exports to Excel; the bank list also exports to CSV.',
    tips: ['Finalize the payroll run first — reports read finalized payslips (a draft shows an amber warning but still previews)', 'SSF Challan lists only employees with an SSF number and shows the grand total to deposit', 'SSF\'s own SOSYS portal has no bulk-upload feature (verified against the official SOSYS manual) — Collection is typed in one employee at a time. The SSF Challan sheet is meant as your reference while doing that: type each employee\'s SSF No + SSF Basic into SOSYS, and its calculated deposit should match this sheet\'s Total 31%.', 'Bank Transfer flags employees missing bank name or account number in amber — fix them in Pay Setup', 'TDS Report includes festival allowances and incentives that were finalized with this month as their "Paid in" month. "Total to deposit" = tax on salary + tax on those bonuses — the amount to deposit with the IRD for the month. The sheet still appears for a month that had, say, a Dashain allowance but no payroll run yet', '"Withheld this year" adds up income tax from Shrawan to this month — finalized payslips plus finalized festival allowances and incentives, and this month\'s own tax even while its payroll is still a draft', 'TDS Certificate: select fiscal year + employee — the certificate covers all finalized payslips for that employee in that FY, lists their festival allowances and incentives separately, and counts them in total income and total tax withheld; print it from the browser for a PDF copy', 'The employer PAN on the TDS Certificate comes from Settings → Property → VAT Registration Number (Nepal uses one number for both) — if it prints as a blank line, add the number there', 'Employee PAN is shown on the certificate from the employee record — add it in HR → Employees if missing']
  },
  {
    icon: '💳', name: 'Advances & Loans',
    guide: 'Track money given to staff ahead of their salary. There are two types: One-time (an advance — the whole amount comes off the next salary) and In instalments (a loan — a set amount comes off each salary until it is paid back). No interest is charged: what is issued is exactly what is recovered. Issue one from the top-right button — set the employee, type, issued date, total amount, and the monthly instalment. When payroll is generated, each employee\'s due cuts are deducted from their net pay and appear as a named "Advance / Loan Recovery" line on the payslip. On Finalize, payroll records those repayments in this ledger itself — never enter salary cuts by hand. Click any row to open the detail panel with the repayment history and a progress bar. Once nothing is owed, the advance is marked Settled automatically. The first cut comes from the payroll of the month AFTER the advance was given — an advance given any day in Bhadra is first recovered from Ashwin pay, and the issue form says which month.',
    tips: ['One-time = the whole amount comes off the next salary, unless you fill in a monthly instalment to spread it out. In instalments = a loan, and the monthly instalment is required', 'The monthly instalment is a real salary cut, not a reminder — NPR 20,000 at NPR 5,000 a month comes off four salaries. A cut is never more than that month\'s pay: if a waiter\'s pay after tax is short one month, less is taken, the rest stays owed and the loan simply runs a month longer', 'An advance is never deducted from the month it was given, or any month before it — the first cut is the next month\'s payroll. If you back-date an advance into a month whose payroll is already finalized, the first cut is the first month without finalized payroll, and the form says which. Final Settlement is the exception: someone leaving repays everything outstanding', 'Don\'t record salary cuts yourself — payroll writes them itself when you Finalize. Use + Record Repayment only for money the employee paid back in cash or by bank; it cannot be more than what is still owed', 'The Source column in the repayment history shows where each repayment came from: Payroll, Final Settlement or Manual. A Manual repayment can be deleted (it is logged, and the advance goes back to owing and becomes Active again). Payroll and Final Settlement repayments show a lock — undo them by reopening that payroll run or settlement', 'Reopening a finalized payroll removes the repayments it recorded and reactivates any advance it had settled', '✓ Settle only appears when nothing is owed — normally it happens on its own the moment the last repayment is recorded. An advance that still has a balance cannot be settled; write it off instead', 'Write off forgives what is still owed — for example a cook who left and the business decided not to chase the last NPR 3,000. It needs a reason, is logged with who and when, gets its own grey Written off badge, and can be Reactivated if the money does come back. Payroll stops cutting a written-off balance and Final Settlement will not recover it', 'Total Outstanding leaves written-off balances out; the Written Off card shows their total separately', 'You can delete an advance only if no repayments have been recorded against it — once there are any, write it off instead', 'Status colours: Active is gold (the money is not back yet — nothing is wrong), Settled is green, Written off is grey', 'On the HR Dashboard, Advances Outstanding shows "—" when the figures could not be read — never NPR 0'],
  },
  {
    icon: '🎉', name: 'Festival Allowance',
    guide: 'Issues the annual festival bonus (Dashain / पर्व खर्च) that Nepal law requires — broadly one month\'s basic salary per year. Name the festival, pick the BS year and the "Paid in" month (Ashwin by default), then Generate: monthly staff get one month\'s basic shared out by the completed months they have worked up to the festival (basic × months ÷ 12). Daily and hourly staff start at zero, marked "amount needed" — type their amounts by hand. Income tax (TDS) is worked out on the whole year — salary paid so far, salary still to come, and other bonuses already paid — so the allowance is taxed at the rate each person really falls in. Both gross and TDS are editable while draft; Finalize to lock. Export a detailed register or a bank-transfer file (Excel/CSV) showing Gross, TDS, and Net Transfer columns.',
    tips: ['The "Paid in" month decides which tax year the allowance belongs to, and months of service are counted up to the 15th of that month. It is locked once the run is finalized', 'Share for months worked = completed Nepali months from the join date to the festival (up to 12). A cook who joined 6 months before Dashain gets half a month\'s basic; anyone with a year or more gets a full month. Someone who has left stops counting at their last working day', 'Runs you have already made for the year show as chips above the table — click one to open it. You can pay more than one festival allowance in a year (Dashain and Tihar, say); the page warns you, and warns again if a new name differs from an existing run only by capital letters or spaces ("Dashain" / "dashain")', 'Daily and hourly staff start at 0 with an "amount needed" chip — type a figure based on their typical earnings, or remove them if they get nothing. Finalize stays blocked until each of them has an amount', 'A row for someone who left before the pay month, joins after it, or was already paid a festival share by Final Settlement is named with a chip — take it out with "Remove from this run" before you Finalize', '"Add missing staff" adds only people who are not in the run yet (for example a waiter who joined after you generated) — amounts you already typed are not touched', '↻ Recompute counts months again and works out each monthly employee\'s amount from today\'s basic salary, keeps the amounts you typed for daily and hourly staff, and works the income tax out again on every row. Press it after a raise or after finalizing more payroll months', 'An "estimate" note under someone\'s tax means no payroll month is finalized for them yet this tax year, so the tax is worked out from salary alone — finalize earlier payroll months and Recompute for an exact figure', 'Changing an amount works its tax out again; you can also type the tax directly while the run is a draft. A tax you type, or keep with "Keep the tax as entered", is saved with the row — so a later change in the calculation does not hold up Finalize, and it is listed in the Finalize confirmation instead. Recompute, or changing the amount, puts the calculated tax back', 'Net payout = gross − TDS; the bank export\'s "Net Transfer" column is what each employee receives. Bank files skip anyone with nothing to transfer, and say MISSING BANK DETAILS where an employee has no bank name or account number', 'Finalized allowances appear on HR Reports → TDS Report for the Paid in month, as tax to deposit that month, and on each employee\'s TDS Certificate. Monthly payroll tax counts them too', 'Reopen makes amounts editable again, but the run counts as NOT paid until you finalize it again — a leaver settled in the meantime gets a festival share in their Final Settlement, and monthly payroll tax stops counting the allowance', 'A finalized run is locked by the database, so a browser tab left open from before can no longer turn it back into a draft']
  },
  {
    icon: '💰', name: 'Gratuity',
    guide: 'Shows the total gratuity owed to all active monthly-paid employees under the Nepal Labour Act, if each one left today. Gratuity builds at one month\'s basic salary per year of service (basic ÷ 12 for each COMPLETED month — a month counts only once the day of the month is reached, so someone who joined on the 15th completes a month on the 15th). It vests after 12 completed months — anyone short of that is shown as "Vesting". SSF Funded shows how much the employer has already put into the SSF gratuity fund for that person, worked out from the employer SSF actually recorded on their finalized payslips and settlements (3.33 of every 20 rupees); an employee with no SSF recorded shows "No contributions yet" and gets no offset. Net Liability = Labour Act total − SSF funded — the extra cash you may need when they leave. Filter by vesting status or department; export to Excel.',
    tips: ['Only monthly-paid employees appear — daily and hourly gratuity is worked out at Final Settlement', 'Example: Sita joined on 15 Shrawan 2082. On 14 Shrawan 2083 she has 11 completed months and nothing is vested; on 15 Shrawan 2083 she has 12 and a full month\'s basic is owed', 'The SSF offset only counts money that was really paid into SSF for that person — an employee enrolled two years ago is not treated as funded for their whole ten years', 'The 12-month rule and the SSF offset are how Crest reads the Labour Act — confirm both with your accountant before paying a large amount', 'A banner names any finalized settlement not yet marked paid, so a leaver\'s gratuity is not forgotten', 'The "Monthly Accrual" card shows how fast your total gratuity pool is growing — useful for cash-flow planning']
  },
  {
    icon: '🧾', name: 'Final Settlement',
    guide: 'Works out, records and settles everything owed when an employee resigns, is terminated or retires. Pick the employee and their last working day (BS). The final month is run through the same engine as payroll — basic plus allowances up to the last day, overtime, absences, SSF, CIT and the month\'s income tax — so the leaver does not also need a payslip for that month. On top of it: approved travel (TADA) claims not yet paid, leave encashment (days earned so far this year, at basic ÷ 26 per day), gratuity once 12 months are completed, the festival share for months worked if it has not been paid this fiscal year, and notice pay. Notice is basic ÷ 30 per day: someone who resigns without serving notice has the missing days deducted; someone you terminate without notice is PAID the missing days; mutual separation and retirement have none. Outstanding advances come off the end, and tax is taken on the lump sum. Save it as a draft, then Finalize: in one step it records the advance repayments, marks the travel claims paid, marks the employee resigned/terminated/inactive with their last working day, turns off their Crest Staff app access, and blocks any HR, IMS or POS staff login linked to them. A finalized settlement is locked and is shown exactly as it was finalized. The Owner or an HR manager can Reopen it with a reason, which puts the advances and travel claims back; the employee stays marked as left. The final month and the exit payments appear in HR Reports\' SSF challan, TDS sheet and TDS certificate.',
    tips: ['Run this BEFORE marking anyone resigned or inactive — the picker lists active and probation staff, so deactivating someone first hides them from the page built for people who just left', 'Do not also run payroll for the final month — the settlement pays it. Finalize refuses if a finalized payroll run already pays that month, and payroll refuses to finalize a month a settlement already paid', 'Mark attendance for the final month first: absences and overtime up to the last working day are read from it', 'Example: a waiter on NPR 30,000 basic resigns and works 10 of the 30 days\' notice. The 20 missing days, 20 × (30,000 ÷ 30) = NPR 20,000, come off the payout. Had you terminated them without notice, the same NPR 20,000 would be added instead', 'Leave encashment counts only leave EARNED so far this year: with 18 days a year and 6 completed months, 9 days are earned — minus days already taken or encashed', 'If an advance, a travel claim or payroll changes after you saved the draft, Finalize refuses and asks you to reload rather than paying stale figures', 'A settlement that nets negative does not close the advances it could not cover — that money is still owed', 'Finalized is not the same as paid: use Mark paid once the money actually leaves', 'If the leaver also had an HR, IMS or POS staff login linked to their employee record, Finalize blocks it: it stops working at once and a device already signed in is signed out. It is blocked, not deleted, so their name stays on every bill, KOT and shift they recorded — and Reopen lets it work again. The confirmation names each login first. A login that was never linked to the employee record cannot be found this way; delete it on its Staff page', 'Nobody below the Owner can finalize or reopen their own settlement', 'Monthly-salaried employees only — daily and hourly settlement is not supported yet'],
  },
  {
    icon: '🧳', name: 'TADA Claims',
    guide: 'Tracks TADA — travel and daily allowance: money staff spent on work trips and are paid back, such as a bus fare to collect supplies or a night\'s lodging on a vendor visit. These are actual itemized expenses, not a rate-based per-diem formula. A claim can come in two ways: entered here by a supervisor, manager or owner picking the employee, or submitted by the employee themselves from their Self-Service TADA tab (either way it lands as Pending, same approval flow). Add expense line items under Transport, Lodging, Daily Allowance, or Other with a description and amount each. A Supervisor or above approves or rejects the claim — never their own. An Approved claim is then paid automatically by the first payroll after approval once the trip is over, and finalizing that payroll marks it Paid (Payroll). If the money is handed over in cash or by bank instead, an HR Manager marks it Paid by hand — pay a claim one way or the other, never both.',
    tips: ['With two or more claims you can decide waiting, "Approve all N…" above the list approves them in one go after showing the total — your own claims are left out, and any that could not be approved are named', 'Employees can submit their own claims from Employee Self-Service → TADA (no manager entry needed) — they still can\'t approve, reject, or mark their own claims Paid', 'Add as many expense line items as needed per claim — the total is the sum of all items', 'Only Pending claims can be approved or rejected; only Approved claims can be marked Paid', 'A supervisor can approve or reject other people\'s claims but never their own — the row says "Your own claim" and someone else has to decide it. The database enforces this, not just the page', 'Approve, Reject, Delete, and Mark Paid all sit on the claim row itself, so a long pending list never needs scrolling to act on it — click a row to expand its expense lines directly underneath when you want to check what was actually spent before deciding', 'Each Approved claim says where it stands: "In the <month> payroll draft" when a payroll draft already includes it, or "Will be paid by the next payroll" while it waits. Payroll picks a claim up in the first month that ends on or after the trip\'s end date — a trip from 30 Bhadra to 2 Ashwin is paid in the Ashwin payroll', 'Mark Paid is for a claim paid in cash or by bank transfer outside payroll, and needs an HR Manager. If the claim is already in a payroll draft, paying it by hand takes it out of that payroll — the page asks first, and you must Regenerate that payroll before finalizing it or the draft still carries the amount', 'Only Pending claims can be deleted. Once a claim is approved or rejected, its employee, dates and total can no longer be changed', 'The Pending and Approved tabs show every open claim from any month, so last month\'s trip never hides; the month filter only narrows the Paid, Rejected and All tabs', 'A trip cannot end before it starts, and amounts cannot be negative. A claim matching another one on employee, dates and total gets a duplicate warning, and the Staff app refuses the same claim sent twice', 'Only the Owner or an HR manager can change the TADA settings (per-km rates, purposes and start points) — the database enforces this', 'Start Point is a second dropdown next to Destination (where the trip began) — same preset-list-plus-"Other" shape as Purpose, editable from ⚙ Settings', 'When Purpose is "Purchase," a vendor picker appears under Destination — selecting a registered vendor just fills in its name as the Destination text (no separate vendor record is linked to the claim)', 'A Transport line shows a Vehicle picker (2-Wheeler/4-Wheeler/EV) and a Distance (km) field — Amount fills in automatically as Distance × that vehicle\'s configured Rate/KM. You can still hand-edit Amount afterward if needed (e.g. to add a toll).', 'Rate/KM itself comes from ⚙ Settings and can\'t be overridden here unless you\'re an owner/admin — if a vehicle shows "No rate set," ask an owner/admin to configure it, or just enter Amount manually.', 'The ⚙ Settings button (owners/admin only) sets each vehicle\'s Rate/KM, Purpose options, and Start Point options offered when starting a new claim — both preset lists always have an "Other" choice for a one-off entry.', 'Start Date and End Date default to today when you open + New Claim — change them if the trip already happened or is scheduled ahead.']
  },
  {
    icon: '🎁', name: 'Incentives / Bonus',
    guide: 'Runs one-off bonus or incentive events — sales bonuses, performance incentives, spot awards — separately from monthly payroll, using the same Generate → draft → Finalize → Reopen flow as Festival Allowance. First define reusable bonus types under ⚙ Manage Types (a fixed amount, a % of monthly basic, or typed by hand each run), then name a run (e.g. "Q1 Sales Bonus 2083"), pick a type, the BS year and the "Paid in" month, and Generate Run to seed a draft amount per employee based on the type\'s calculation rule. The run keeps its type — come back to it later and the type is restored. Amounts and notes are editable while draft. Income tax (TDS) is worked out the same way Festival Allowance does — on the whole year: salary paid so far, salary still to come, and other bonuses already paid — so a bonus is taxed at the rate each person really falls in, not as if it were their only income. Finalize to lock; an HR manager (or the owner) can Reopen if needed.',
    tips: ['Fixed pays the same amount to every employee in the run; % of monthly basic scales with each employee\'s basic salary (up to 100%); "typed by hand each run" starts every employee at 0 for full custom entry', '% of basic does not work for daily or hourly staff — a percentage of a day rate is not a bonus — so their rows start at 0 with an "amount needed" chip, and Finalize is blocked until each has an amount. A fixed type pays them the fixed amount like everyone else', '⚙ Manage Types is where you define reusable bonus types once and use them across runs. A type can be edited later — its name, calculation, value, and whether it is Active (inactive types are hidden from new runs). Runs already generated keep their amounts; Recompute on a draft run uses the new setting, and finalized runs never change', '"Reduce for months worked" shares a type\'s amount out by service: amount × completed months worked up to the 15th of the Paid in month ÷ 12. A NPR 6,000 bonus for a cook who joined 4 months before pays NPR 2,000; anyone with a year or more gets the full NPR 6,000', '↻ Recompute names the run\'s type before it runs. For a fixed or % type it works every amount out again from today\'s salaries (typed amounts are replaced, except daily/hourly amounts on a % type); for a run typed by hand every amount stays exactly as it is. Income tax is worked out again on every row either way', 'The "Paid in" month decides which tax year the bonus belongs to. This year\'s runs show as clickable chips above the table; starting a second run, or a name that differs from an existing one only by capital letters or spaces ("Q1 Bonus" / "q1 bonus"), gets a warning first', 'A row for someone who is not on the payroll in the Paid in month (left before it, or joins after it) is named with a chip and must be taken out with "Remove from this run" before Finalize. "Add missing staff" adds only people not in the run yet, without touching typed amounts', 'Finalized bonuses appear on HR Reports → TDS Report for their Paid in month and on each employee\'s TDS Certificate, and monthly payroll tax counts them', 'Reopen makes amounts editable again, but the run counts as NOT paid until it is finalized again, so monthly payroll tax stops counting it. A finalized run is locked by the database — a browser tab left open from before cannot turn it back into a draft', 'Like Festival Allowance, this is a one-off event, not a recurring monthly salary component — it does not auto-run every payroll cycle', 'Export the run as a register or a bank-transfer file (Excel/CSV) — bank files skip anyone with nothing to transfer and say MISSING BANK DETAILS where an employee has none on file']
  },
  {
    icon: '📱', name: 'Employee Self-Service',
    guide: 'Gives employees a PIN-based login (no email/password) on their own phone to see their shifts, payslips, leave and travel claims — without access to the main admin app. Enable it per employee from Employees → Enable Self-Service, setting an initial PIN, then share the link via Employees → Copy Self-Service Link; the same link works for everyone at your company and each person picks their name and enters their PIN. It is built as a phone app rather than a web page: tell staff to add it to their home screen and it installs as "Crest Staff" with its own icon, opening full-screen with no browser bars. Four buttons run along the bottom. Home shows today\'s shift, the next day they actually work (days off are skipped), any swap request waiting on them, and their latest payslip. Roster shows their own Sunday–Saturday week with today marked, plus their swap requests. Requests holds Leave and TADA, each opening as a form that slides up from the bottom of the screen. Pay lists every finalised payslip; tapping one opens the full document. Light or dark follows the phone\'s own setting, since employees cannot reach Settings → Appearance. Notifications live under the ⋯ menu at the top right, and it only offers a button where pressing one can actually work — on an iPhone the app has to be added to the Home Screen first, because iOS never gives notifications to a browser tab, so opening the link inside a WhatsApp chat shows that instruction instead of a dead button. An employee can only ever see their own data, never a colleague\'s — enforced at the database level, not just hidden in the UI.',
    tips: ['Signing out returns to your restaurant\'s PIN pad, not the owner sign-in page. A broken or cut-off link says so and asks for the link again, and a dropped connection says to check the signal — never a technical error', 'An employee can save or share any payslip as a PDF from the payslip screen ("Save or share as PDF") — useful when a bank or landlord asks for one', 'One shared link per company — copy it from Employees and send it to your team (e.g. via WhatsApp)', 'Tell staff to add it to their home screen: on Android the ⋯ menu offers a button, on iPhone it is Share → Add to Home Screen. On iPhone that step is also what makes notifications work at all', 'The app opens on today\'s shift, so "am I working, and when?" is answered before anyone taps anything', 'A day the roster has not been published yet says so, instead of looking like a day with no shift — those two look identical in the data and mean very different things', 'Request Swap only appears on days the employee actually works — it used to show on days off too, which asked a colleague to trade for nothing', 'Leave requests submitted through self-service go through the exact same approval flow as leave submitted by an admin', 'A single-day leave request shows a Day Type choice (Full Day / First Half / Second Half), same as the admin Leave page', 'TADA claims are entered one expense line at a time, with the running total shown before submitting', 'Sign out lives in the ⋯ menu rather than on every screen — it is not the second most important thing an employee does'],
  },
  {
    icon: '👥', name: 'HR Staff', path: '/hr/staff',
    guide: 'Assign HR roles to your team. Staff log in with their own email and password (same mechanism as the Owner account) — distinct from Employee Self-Service, which is a PIN-based portal for an individual employee\'s own payslip/leave view. Roles: Staff (view the Holiday Calendar only), Supervisor (+ editing the Holiday Calendar, HR Dashboard, Attendance, Leave, Overtime, Staff Roster, TADA Claims), Manager (+ Employees, Pay Setup, Payroll, all HR Reports, Festival Allowance, Incentives, Advances, Gratuity, Final Settlement, marking TADA claims Paid, and staff role assignment). Nobody below the Owner can approve their own leave, overtime, travel claim or advance — someone else must decide it. Only the Owner can give a login Manager rank, change a manager\'s login, or turn an existing plain login into HR staff. The payroll money records are Manager-only in the database itself, not just hidden from the menu.',
    tips: ['Never give YOUR OWN login an HR role. The Owner is the login with no staff role at all — that is what makes it the Owner — so a role demotes it. The person taking over HR gets a Manager login of their own', 'To take someone\'s HR access away, delete their login — there is no "No Access" setting, because a login with no role looks exactly like the Owner', 'Changing a role\'s permission level in Manage Roles asks first and names everyone who moves with it. If a login\'s level ever stops matching its role, an amber banner lists it and nothing changes until you press Apply', 'A role people hold cannot be removed — move them to another role first', '+ Add Staff defaults to picking an existing HR Employee — the login is linked to that record (🔗 HR) so the name stays in sync', 'A POS or IMS staff account, or an Employee Self-Service login, cannot also be given an HR role on the same login — create a separate account', 'Reset Password sets a new password immediately — share it with the staff member directly']
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
                    'After a correct PIN the till opens on Orders (the floor)',
                    'If sign-in fails, the message says which thing went wrong: the internet or server could not be reached (your PIN is kept — just try again), this tablet needs to be activated again by a manager, or the PIN was wrong',
                    'Each till tablet has its own key. A manager or the Owner activates a tablet once from POS Setup (sign in with email on that tablet, open POS → Setup, give the tablet a name such as "Front counter", press Activate). A tablet that is lost or sold can be revoked there without affecting the others',
                    'Tablets activated before this update share one key for the whole restaurant. They keep working. Once every tablet has been activated again, a manager switches the shared key off in POS Setup — it cannot be switched back on',
                    'A tablet left asleep locks as soon as it wakes if it has been idle longer than 3 minutes, so the next person cannot bill under the last waiter\'s name',
                    'Items you tapped in but had not sent or saved are NOT lost when the till locks (or when you press Lock POS). They are kept on that tablet for your PIN only: the PIN screen says so ("Kept for Ram: 3 items not sent on Table 5"), and when you sign in again the table reopens with them back as unsent, ready to send. Another waiter signing in never gets them. Anything left for more than 12 hours is dropped',
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
                    'Who can open Menu Pricing: the Owner, a POS Manager or an IMS Manager. Menu prices, VAT and the On POS switch can only be changed by those same people — a Supervisor cannot change a price anywhere, including from Recipe Costing',
                    'A new dish a Supervisor creates in Recipe Costing arrives with On POS switched OFF. It does not appear on the till until a manager or the Owner turns it on here, where its price is on screen',
                    'A new price applies to items added to an order from then on. A dish already on a running table keeps the price it was ordered at',
                  ],
                },
                {
                  icon: '⊞', name: 'Table Management', path: '/pos/tables',
                  desc: 'Set up your restaurant floor plan — create tables, assign them to sections (Main Hall, Bar, Outdoor), set capacity, and track status (Available / Occupied / Reserved / Inactive). The Ticket Routing tab lets you assign each recipe category to KOT (kitchen) or BOT (bar) so tickets print at the right station automatically. The Reservations tab holds the booking settings — expected sitting length per party size, the WhatsApp confirmation text, and the outlet\'s booking link and printable QR. The Guest Menu tab sets what guests see at the top of every table\'s QR menu — your restaurant\'s name and logo — and the order of the menu\'s sections. Requires Manager role or above (the Owner always has it).',
                  tips: [
                    'Click a status badge directly on the floor grid to cycle it — no need to open the editor',
                    'Use sections to group tables by area; the section filter tabs appear automatically once you have more than one section',
                    'Sort Order controls the display sequence within a section — use multiples of 10 (10, 20, 30) to leave room for reordering',
                    'Inactive status removes a table from active service without deleting it — useful for tables under repair or seasonal areas',
                    'A table with an open bill cannot be deleted — bill or void that order first, so it never disappears from the floor with nobody able to reach it',
                    'Waiters and supervisors still change a table\'s status as they seat and bill guests; adding, renaming, moving or deleting tables and editing the lists in the other tabs is for a Manager or the Owner',
                    '▦ QR on each table card generates that table\'s guest-facing digital menu — a page a customer sees after scanning it on their own phone, no login needed. Print it and place it on the table. Add a description, photo URL, and Veg/Non-Veg tag per dish in Recipes to make it richer; nutrition facts appear automatically if your plan has Nutrition Facts enabled. Once a table\'s order is sent to the kitchen/bar, the guest also sees a live Sent / Being prepared / Ready to serve badge on their phone — the same status Order Taking and Kitchen Display show staff, no extra setup needed. Once kitchen/bar staff enter an estimated prep time on Start (Kitchen Display), the guest\'s "Being prepared" badge also shows "about X min left"',
                    'The guest menu has a Filters button whenever any dish has a Veg/Non-Veg tag or allergen info — lets the guest show vegetarian dishes only, or hide dishes containing a specific allergen. Allergen warnings show for every restaurant, built from the allergens recorded on your ingredients; calories and nutrition figures still need the Nutrition Facts feature',
                    'Guest Menu tab (Owner): type your restaurant\'s name as guests should read it (for example "Bhatti Choila") and upload a logo — both show at the top of every table\'s QR menu and your online booking page straight away. Leave the name empty and the menu uses your account name, with names typed in ALL CAPITALS shown in normal capitals. Managers see these read-only. The same tab sets the order of the menu\'s sections with the up and down arrows (it is the same list as Settings → Recipe Categories)',
                    'Dish names typed in ALL CAPITALS on the till show on the guest menu in normal capitals ("PANI POORI" → "Pani Poori"). Names with any small letters are shown exactly as typed. The till, bills and reports are not changed',
                    'Guest QR ordering (comes with Crest POS): the guest menu also lets the customer add dishes, say how many people are eating, and send their own order — it never goes straight to the kitchen. It lands as a request a staff member must Accept (or Dismiss) from Order Taking first, so nothing gets cooked without a human check. The guest\'s phone shows exactly what they ordered and follows THAT order through Sent → Accepted → In kitchen → Cooking → Ready, with a small chime at each step — including "about X min" once the kitchen enters an estimate on Start. When the bill is closed it says so and thanks them; if staff dismiss the order, the guest can put it back in their order and send it again. A second order from the same table is tracked on its own, so it never shows the first order\'s "Ready"',
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
                    'Update Order (existing table) saves the order. If you added items that have not gone to the kitchen or bar yet, it asks whether to send them now — say yes unless you are still adding. The KOT/BOT buttons still send additions on their own',
                    '+ Takeaway starts an order with no table. A saved takeaway shows on the floor as its own tile, so you can reopen it, add to it and bill it later',
                    'Served: when the food has gone to the table, tap Served on the order screen. The kitchen screen drops those tickets and the table stops showing food waiting',
                    'If another tablet changed the same order after you opened it, your save is stopped and the screen shows the latest version ("changed on another device"), with what you were adding kept so you can add it again. Nothing is overwritten either way',
                    'A table can only have one open order at a time',
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
                    'A shift must be open to take payment. Pay (including Credit and Split) and Complimentary will not go through until a supervisor opens a shift on POS → Shifts, so every rupee lands on a cash count. A Void does not need one. If your team usually bills without opening a shift, start each day by opening one',
                    'Once a bill is printed it is locked for everyone, including the Owner: its items, amount, payments and buyer details cannot be changed, and it cannot be reopened or deleted. To correct a bill, a manager issues a Credit Note (POS → Credit Notes)',
                    'Prices on a bill always come from your menu (Menu Pricing), never from what a tablet sends — so a price cannot be typed in at the till',
                    'Charge → closes the table — Supervisor role or above only, hidden entirely for Staff. Pay collects Cash/Card/eSewa/Khalti/FonePay and prints a Tax Invoice or Bill; Complimentary closes a walkout or comp — ₨0 is collected but it still counts against food-cost/inventory reporting; Void cancels a mistake with no revenue impact and is only visible to the owner/admin login by default — a manager can grant "Allow Void" to a specific trusted staff member in POS Staff so they can void without waiting for the owner',
                    'While a bill is closing, the button says what it is doing (Saving the order…, Closing the bill…, Printing…), and no step waits more than about 20 seconds. The bill prints first; Inventory posting and loyalty points follow it, so the guest is never kept waiting on bookkeeping. When it is done, the floor names the bill number, the amount and the change to hand back (e.g. "TI2238 closed · Table 4 · NPR 3,425 · change NPR 75")',
                    'If the connection drops just as you press Confirm Payment, the till checks whether the bill actually closed before saying anything. If it did, it prints and finishes normally. If the till cannot tell, it says so. Do NOT take the payment again: press Confirm once the signal is back, and the till checks first and never charges the bill twice',
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
                    'If you are on the till only to take payment, POS → Floor → Billing skips this screen entirely: it lists every open bill with its total and goes straight to the same Charge window on one tap (Supervisor role or above)',
                    '📄 Recent Bills (floor view, Supervisor role or above) lists everything closed today and lets you reprint a bill — the first print carries no extra label (it is the original), every print after that is marked "COPY OF ORIGINAL - (N)" where N counts the copy itself (the 2nd print overall is copy 1, the 5th print overall is copy 4)',
                    'Scan-to-pay QR: once your admin pastes the outlet\'s merchant QR payload in Manage Clients → this client → QR tab, every bill carries a dynamic QR with that bill\'s exact amount pre-filled — the customer can\'t mistype it. The QR also appears in the Charge modal when eSewa/Khalti/FonePay is selected, updating live as discounts change. Payment confirmation is still manual — confirm once you see it land on your merchant app',
                    'Works offline for order-taking: if the connection drops, you can still open tables you\'ve already viewed this session, add items, and send KOT/BOT (an "📵 Offline" pill and a per-table "not yet synced" dot show what\'s queued) — everything uploads automatically once you reconnect and gets its real order number. A brand-new table opened offline shows "#— (pending)" until it syncs. A table whose order was never loaded on this device stays blocked offline rather than risk overwriting items you can\'t see. If a table you worked on offline was billed on another tablet in the meantime, it is listed for you to review instead of overwritten — "Start new order with these" puts those items back as unsent lines on a new order. Charge/Payment always requires a live connection — Nepal\'s sequential invoice numbering can\'t be assigned offline',
                    'You no longer have to be on this screen to be told a guest has ordered. A loud alert bar drops down over whatever page you are on — anywhere in Inventory, HR or POS — with the table name, how long they have been waiting and an Open Orders button, and it keeps chiming every 20 seconds until someone deals with it, turning red after three minutes. Mute 5 min silences the sound; the bar stays, because the order is still waiting. It does not appear on Order Taking itself (this screen already shows it) or on the Kitchen Display (the kitchen cannot accept a guest order — that screen raises its own alert for tickets nobody has started)',
                    'Guest QR self-ordering (Pro plan): if enabled for your restaurant, a pulsing 🔔 banner (with a one-time chime) appears at the top of the floor view the moment a guest submits an order from their phone — and the table itself glows so it stands out even if you\'re not looking at the banner. Tapping the banner or the table opens it straight to the order screen, with covers already filled in from what the guest entered (no re-typing on a numpad). A banner on that screen lists exactly what they ordered — Accept adds those items straight into your cart at the quantities they chose (adjust or add more before sending), Dismiss discards the request with no effect on the order. Nothing reaches the kitchen until you actually press Send Order/KOT, same as any item you add yourself. Enable it per client in Admin → Manage Clients → Features',
                  ],
                },
                {
                  icon: '💵', name: 'Billing', path: '/pos/billing',
                  desc: 'A cashier\'s way straight to the money. Instead of finding the table on the floor plan, opening its order and then pressing Charge, this lists every bill open in the outlet — covers, item count, running total and how long the table has been sitting — and one tap on Bill opens the same Pay / Void / Complimentary window with its live bill preview. Supervisor role or above, the same people who may take payment anywhere else.',
                  tips: [
                    'Longest-open bill first, so the table most likely to be asking for the bill is at the top. The figure in the header is everything still uncollected on the floor right now — not today\'s takings, which are on POS Reports → Sales Report',
                    'This screen bills; it does not take orders. To add a dish, change a note or comp before printing, open the table from Order Taking instead — the Bill button here goes straight past the menu',
                    'An amber "⚠ N unsent" pill means items are on that bill that were never sent to the kitchen or bar. Billing anyway charges the guest for food nobody is cooking — open it from Order Taking and send them, or take them off',
                    'Takeaways appear here too, by their order number, alongside the tables',
                    'Billing needs a live connection — a Nepali invoice number is assigned by the server and cannot be issued offline. Offline, the Bill buttons are disabled and the list says so; order-taking on Order Taking keeps working as normal',
                    'If a bill was settled on another tablet between the list loading and your tap, it says so and refreshes rather than starting a new order on that table. The list also refreshes itself every 15 seconds',
                    '← from the payment screen comes back to this list, not to the floor plan',
                    'A shift still has to be open to take payment, exactly as from Order Taking',
                  ],
                },
                {
                  icon: '✚', name: 'Crest Customization', path: '/customization/groups',
                  desc: 'A paid add-on to Crest POS that lets guests and waiters choose a dish\'s size, extras, "No …" requests and spice or cooking choices. Build a few shared groups once in Custom → Option Groups (Size, Extras, Spice — a "No onion" is an option inside Extras marked as taking something off), put each group on its dishes with "Put it on dishes" or per dish from the Dishes tab and Menu Pricing, and every such dish offers a choice window on the till and a choice sheet on the QR guest menu. The dish itself stays where it is — Recipe Costing or Menu Pricing.',
                  tips: [
                    'A size is entered as its full price (Half NPR 150, Full NPR 250); an extra as what it adds (+NPR 50). The bill shows one line per dish at the combined price, with the choices listed underneath',
                    'Options and groups are shown in the order you list them — Move up / Move down on Option Groups, ↑↓ in a dish\'s Choices dialog. "First N free" on an add-on group makes the EARLIEST-listed of a guest\'s picks free (not the cheapest), so put the options you are happy to give away first; the till and guest sheet mark a free pick as Included and count "1 of 2 free picks used"',
                    'On the till, a dish whose required groups all have a pre-selected default adds in one tap; the choice window opens only when something still has to be chosen, or from Choices / Change on the order line. It remembers the last picks for that dish ("Same as last") and takes a quantity',
                    'The same dish with different choices is two lines: "Momo, Half" and "Momo, Full". A dish already sent to the kitchen cannot have its choices changed — remove it (with a reason, recorded as a pulled item) and add it again, which prints a fresh ticket',
                    'Kitchen tickets and the Kitchen Display print each choice under the dish: "+ Extra cheese", and "NO onion" in bold. Fill in a choice\'s Kitchen ticket name if the kitchen uses a short name',
                    'With Crest IMS, give a choice its stock lines (+30 g cheese, −20 g onion, −5 pcs for a Half) and a closed bill deducts the recipe plus or minus those lines. Stock Report, Reorder, Variance, Shrinkage, FIFO, Stock Ageing and the Monthly Owner Report all count them. A choice with no stock lines changes nothing in stock, and Option Groups flags it',
                    'Guests see "From NPR x" on a dish with sizes, the veg/egg mark and any allergens on each choice, and can edit a dish\'s choices from their order before sending it',
                    'Custom → Customization Report (Owner and managers) opens on this BS month and shows what the extras earned, what sizes took off, the most added extra, how often each dish is customized, the most common "No …" requests and — with IMS — whether each paid choice earns more than its stock lines cost. Choice prices there are before VAT and before bill discounts',
                    'Build-your-own dishes (acai bowl, pizza, salad): tick Build-your-own on the dish in Recipe Costing, or use Build-your-own template on Option Groups to create its Size, Base, Sauces and Toppings in one go. The till always opens its choices, the QR menu walks the guest through one step at a time with a Review before Add, and the dish keeps its own category',
                    'A size can carry a Portion (Small 0.75, Large 1.5). Each group chooses what a bigger size does to its picks: nothing, more stock, or more stock and a higher price. Chicken popcorn on a Large bowl then uses 1.5× the chicken and costs 1.5× as much, and IMS deducts the larger amount',
                    'With IMS, a build-your-own dish shows its food cost as a range on Recipe Costing and Menu Pricing: the cheapest build and what guests usually build, for every size. Open the row to see each size',
                    'Customization needs Crest POS switched on; switching POS off switches Customization off too. Works offline for order-taking like everything else on the till',
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
                    'Tap Served once the food has left the pass (or the waiter taps Served on the order screen) and the ticket leaves the board straight away',
                    'Kitchen notes typed on an order line, such as "no onion — allergy", show under that dish on the ticket',
                    'If a waiter removes or reduces a dish after its ticket was sent, that line is crossed out on the ticket with the word "cancelled" and the reason — stop cooking it',
                    'The board runs on the service day, not the calendar day: tickets sent late in the evening stay on screen after midnight (until 6 AM) so they can still be finished and marked Ready',
                    'Mount this on a tablet or spare screen at the pass — anyone with Staff role or above can open it, same PIN login as Order Taking',
                    'You cannot miss a ticket now. The moment one lands in New, an alert bar drops down over the board naming it, and it keeps chiming every 20 seconds until somebody presses Start — the bar and the sound both stop the instant the ticket is taken. It gets louder as the ticket ages: △ past 8 minutes, red and a harder tone past 15, the same two marks the card\'s own timer uses. Mute 5 min silences the sound and leaves the bar up, because the ticket is still waiting',
                    'Printing is not replaced — if a client doesn\'t have a screen at a station yet, paper tickets keep working exactly as they do today',
                  ],
                },
                {
                  icon: '🕗', name: 'Reservations', path: '/pos/reservations',
                  desc: 'The booking book. Take a booking by phone, WhatsApp or at the door (name, phone, party size, day and time, optional tables), or let customers request one themselves from the outlet\'s booking QR / link. A booking shows as a chip on its table on the Orders floor; tapping that table when the party sits down opens the order with the covers already filled in, and paying the bill marks the booking completed. Any POS staff rank can use it.',
                  tips: [
                    'Booked → Confirmed → Arrived → Seated → Completed. Each row shows its one next step; No-show, Cancel and Mark done sit in the ⋯ menu. The 💬 button opens WhatsApp with the confirmation message prefilled — sent from your own phone, nothing goes out automatically',
                    'Marked someone no-show and they walk in? ⋯ → They turned up puts them back as Arrived and clears the mark from their number. A cancelled booking can be reinstated the same way. Both only until the end of that day',
                    'Typing a phone number looks the guest up: visits, unsettled credit and past no-shows appear under the field, from the customer book you already have',
                    'Guests expected by hour is compared against the room\'s seats and only WARNS — the ninth booking for a forty-seat room is still yours to take. Upcoming lists which days have an hour over seats',
                    'One table cannot be held for two bookings at overlapping times, even when two devices save at the same moment — the save tells you which booking already has it. Back-to-back is fine: a 6:00–7:30 booking and a 7:30 booking can share a table',
                    'The page opens on Upcoming — every future booking, grouped by day — so a booking a colleague took for next week is on screen without picking a date. Day is the service view for one day; Unconfirmed is every future booking still waiting on the guest',
                    'Activity lists the latest changes newest first — booked, edited, confirmed, arrived, seated, done, no-show, cancelled — with who took each booking. Anything changed since you last opened this page on this device is marked new, and the same count sits on the Reservations row inside the POS → Floor menu. Who confirmed or cancelled is not recorded, only who booked',
                    'Online requests wait in an amber band at the top for Accept or Decline; the guest\'s phone shows the answer within seconds. From anywhere else in the app the count sits on the Reservations row inside the POS → Floor menu and lights the dot on the POS button in the top bar (refreshed every minute), and the dashboard\'s Bookings Tonight tile says how many are waiting. Switch the link on and print its QR under Tables → Reservations',
                    'The booking page greys out what you cannot have: days you mark Closed or Walk-ins only (Tables → Reservations), specific closed dates such as Dashain, and any slot where guests from bookings you have ACCEPTED plus the party would exceed your seats — a request you have not answered yet does not fill a slot. The server refuses the same cases, so a stale page cannot slip one through',
                    'A party seated while the till was offline stays Arrived — ⋯ → Mark done once they have eaten; the visit counts as kept',
                    'Sitting length per party size is prefilled from your own measured turn times (Tables → Reservations), so nobody has to guess how long a table of six takes',
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
                    'A parking day ends at 6 AM Nepal time, not at midnight — a car parked at 11:30 PM during a late service is still on the Open tab at 12:30 AM',
                  ],
                },
                {
                  icon: '👤', name: 'Customers', path: '/pos/customers',
                  desc: 'Customer book built automatically from billed orders — every bill closed with buyer Name + Phone (required for any discount or Credit sale) adds or updates a customer, keyed by phone number. The Outstanding Credit tab lists Credit bills awaiting collection with a one-tap Settle action. If Loyalty is switched on for your outlet, a third tab sets up points schemes and shows who is enrolled. Requires Supervisor role or above.',
                  tips: [
                    'No manual data entry — the book fills itself as bills are closed with buyer details. Repeat customers are matched by phone number, so their name/address/PAN stay up to date automatically',
                    'Click any customer row to see their full order history — every billed order under that phone number, including payment method and any outstanding Credit',
                    'Outstanding Credit tab: when a customer comes back to pay, hit Settle and pick the method they actually used (Cash/Card/eSewa/Khalti/FonePay, or Cheque/Bank Transfer — the usual way a delivery platform or corporate account remits) — the bill is marked collected with who recorded it and when',
                    'A bill tagged Foodmandu or Pathao (an amber badge next to the customer name) shows a Commission % field when you Settle it — pre-filled from Table Management → Delivery Partners as a starting suggestion, confirm or adjust it to match what the platform actually remitted before picking the settlement method',
                    'The Who owes what table totals the ledger by counterparty — each delivery platform separately, plus one Direct customers row — so a balance can be chased per platform instead of read off a bill-by-bill list. It covers every Credit bill ever, settled and unsettled; for one month, and to check what a platform withheld against the rate you agreed, use Sales Report → Delivery Partners',
                    'The Age column shows how long each credit bill has been outstanding — chase the old ones first',
                    'A Credit bill that has had a Credit Note issued against it is cancelled, so it leaves Outstanding Credit and is no longer counted as owed',
                    'When Foodmandu or Pathao settles in cash, the drawer is credited with what they actually paid — the bill minus their commission — so the shift does not read short',
                    'The same bill cannot be settled twice, even from two tablets at once',
                    'No-shows counts bookings under that phone number marked No-show on the Reservations page; the same count appears on the booking form the next time they book, so the host decides knowingly',
                    'Settling is Supervisor+ (routine cashier work); issuing credit at Charge stays Manager+ only',
                    'Loyalty tab (changes need a POS Manager or the Owner; a Supervisor sees it read-only): create one or more schemes (how many points per NPR 100, and a minimum spend below which a bill earns nothing), then enrol customers one at a time. Anyone left on “Not enrolled” earns nothing at all — switching Loyalty on never starts accruing points for your whole existing customer book',
                    'A customer belongs to one scheme at a time. What a point is WORTH is a single number for the outlet, set at the top of the same tab — schemes differ only in how fast points are earned, so staff only ever have to explain one redemption rate at the till',
                    'Points are earned automatically on any bill closed with a name and phone; the Orders floor shows what the last bill earned. They are spent at Charge, where the Pay tab shows the balance and lets the cashier apply some of it. Points can only be added or spent while a bill is being closed, by the person closing it — if adding them failed, the Owner can add them later',
                    'A Credit Note takes back the points that bill earned and gives back any points spent on it. A balance can dip below zero if the customer already used the points — that is the true position',
                    'Redeeming behaves like a gift card, not a discount: the bill’s VAT is unchanged and the points settle part of what is owed. That also means it does not count against a cashier’s discount limit',
                    'Worth knowing for your accounts: revenue is recorded in full and the redemption shows as a non-cash payment, so the cost of a reward appears as less cash taken rather than as an expense line',
                  ],
                },
                {
                  icon: '⚠', name: 'Sales Exceptions', path: '/pos/exceptions',
                  desc: 'Every discount, void, and complimentary in one report — revenue that leaked, filterable by BS date range, exception type, and staff member. Discounts show the amount knocked off; Voids show the menu value forgone, before VAT; Comps show food cost, matching the Complimentary Slip, plus a separate Potential Sales Value column showing what the comped item(s) would have sold for at menu price, also before VAT. Includes both whole-order Complimentary and individually item-comped bills (see Order Taking). Requires Manager role or above.',
                  tips: [
                    'The By Staff Member table is the report\'s real job — one cashier discounting far more than everyone else is worth a conversation (training gap or permission creep)',
                    'Staff are ranked by Revenue Impact — discounts + voided menu value + what comps would have sold for, all at sales value BEFORE VAT, so the total is one coherent number. Comp food cost stays visible in its own column',
                    'Why before VAT: the VAT on a sale that never happened was never your money. Counting it made a void look about 13% bigger than a discount on the same food — a NPR 1,000 dish voided now counts NPR 1,000, not NPR 1,130',
                    'Attribution records whoever was signed in on the till when the bill closed. The till now locks back to the PIN screen after 3 idle minutes, so on a shared till that attribution stays honest — but treat an outlier as a starting point for a conversation, not proof',
                    'A quiet report is a healthy one — a sudden spike in voids usually means order-entry mistakes, not fraud',
                    'Amounts mean different things per type: Discount = NPR knocked off the bill, Void = menu value (before VAT) that was cancelled, Comp = ingredient cost of what was served free (see Potential Sales Value for what it would have sold for instead)',
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
                    'It takes back exactly what the bill put into Inventory — after the bill\'s discount, and leaving out complimentary items. If no Inventory period is open for this month, the note is still issued and printed, but the screen says it is not yet in Inventory, it shows a "Not in Inventory" badge in the Credit Note Book, and the POS floor counts it. Open the month in Periods and press "Post POS bills to Inventory" on it to finish the job',
                    'Only bills closed as Pay (not Complimentary or Void) can get a Credit Note — a Complimentary is already a ₨0 internal document, and a Void never had revenue to correct',
                    'Each bill can only be credited once — the Credit Note button disappears from a bill once one has been issued against it',
                    'A Credit Note is the only way to correct a printed bill — nobody, the Owner included, can edit or delete one. Once issued, a Credit Note itself cannot be edited or deleted either; it is a numbered tax document',
                    'Before issuing, the screen asks "Was money returned to the customer?". Cash = you handed cash back from the till: it is recorded as a Refund on the open shift, so the drawer count at closing expects it (a shift must be open). Other = returned by card, QR or bank transfer: nothing comes off the drawer. None = no money went back, for example a billing mistake corrected before the customer paid. The answer shows in the Credit Note Book\'s Money Back column; it is not printed on the Credit Note',
                    'A Credit Note\'s figures must match the bill it corrects. If they don\'t (for example the bill changed on another device while the dialog was open), it is refused before it gets a number — close the dialog and issue it again',
                    'Issuing a Credit Note also takes back the loyalty points that bill earned, and gives back any points the customer spent on it',
                    'In the Sales Report the original bill stays on the day it was sold, and the Credit Note shows as a minus line on the day it was issued',
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
                    'A split bill is shared out across the methods it was really paid with. Example: a NPR 1,000 bill paid NPR 600 cash and NPR 400 eSewa adds NPR 600 to Cash and NPR 400 to eSewa — so the Cash line matches the cash in your shift report',
                    'Delivery Partners lists every Foodmandu/Pathao bill (these close as Credit, not their own payment method — see Order Taking) with its settlement status; Outstanding rows have no commission/net figure yet since that\'s only entered when you Settle it in Customers → Outstanding Credit',
                    'The By Partner table above the bill list is the one that answers "what does Foodmandu still owe me, and what has Pathao taken?" — one row per platform with its outstanding balance, commission and net received. Click a row (or use the Partner dropdown) to filter the bills, the KPI cards and the Excel export down to that platform',
                    'Effective % is what a platform\'s commission actually works out to as a share of the ex-VAT, post-discount value of its settled bills — the basis Foodmandu and Pathao themselves calculate on. Set each platform\'s agreed rate in Table Management → Delivery Partners and any platform withholding more than agreed turns amber, with the gap shown in rupees. The per-bill Comm. % column then flags the individual bill responsible',
                    'Outstanding bills are left out of Effective % on purpose — they carry no commission until settled, so counting them would drag every platform\'s rate toward zero mid-month',
                    'The Excel export writes two sheets: By Partner (always every platform, with a Variance vs Agreed column) and Bills (whatever the Partner filter is showing, named in the letterhead so a filtered sheet says so)',
                    'Returns show as minus lines. A bill that later got a Credit Note stays at its full value on the day it was sold, and the Credit Note appears as a minus line on the day it was issued — on every tab. Example: a NPR 2,000 bill on Sunday credited on Tuesday shows +2,000 on Sunday and −2,000 on Tuesday, so each day still matches that day\'s shift report. Bill Register also flags the credited bill with a badge',
                    'Bill Register, Comped Bills and the Delivery Partners bill list show each bill\'s clock times under its date: when the order was opened, then when it was paid. Where the order was opened on an earlier day — an overnight table, or a bill held for late settlement — both times carry their own date, so the pair cannot read as a backwards clock. A ⚠ beside them means the till recorded a close before its own open, which points at that till\'s date and time being wrong rather than at the bill',
                    'Every time in Crest is Nepal time, whatever timezone the device showing it is set to — so a report read from abroad shows the same clock as the one read in the outlet',
                    'Click any row on Bill Register to view that bill\'s actual Tax Invoice/PAN Bill in a new tab — the same layout that printed, view-only (won\'t trigger your printer). A bill with an item comped out of it also shows a "Comped (NC-xx)" badge right there',
                    'Comped Bills lists every item-level comp with the paid bill it came out of, valued both at food cost and at menu-price "Potential Value" — click a row to view that comp\'s own mini Complimentary Slip. Whole-order Complimentary orders don\'t appear here (they have no separate paid bill to cross-reference) — see Sales Exceptions for those',
                    'Category Wise and Item Wise show a Credit Note\'s full quantity as a return on the day it was issued (Crest has no partial/line-level returns) — a bill\'s discount is allocated proportionally so totals reconcile',
                    'Customer Wise groups walk-ins with no buyer details under CASH SALES',
                    '⚠ Missing PAN on the 1L+ tab means a party crossed NPR 1,00,000 without ever having their PAN recorded — worth asking for it on their next visit. The walk-in line (all unnamed customers added together) is never flagged',
                    'On the 1L+ tab, a customer billed once with a PAN and another time by the same name with no PAN is counted as one party under that PAN, and Credit Notes issued in the year are subtracted',
                    'Excel stays greyed out while a report is still loading, so a workbook can never carry one range\'s figures under another range\'s name',
                    'The Bill Register, Comped Bills and Delivery bill sheets carry Opened and Closed as separate 24-hour columns so they sort correctly, plus an "Opened On (BS)" column that fills only where the order was opened on a different day from the one it was paid',
                    '⬇ Excel exports whichever tab is currently open',
                  ],
                },
                {
                  icon: '🍽', name: 'Covers Report', path: '/pos/covers-report',
                  desc: 'Guest-traffic analytics built from the covers number entered when a table is opened: average party size, revenue per guest (not per bill), how long tables actually turn over by party size, when covers peak through the day, and each server\'s covers/revenue. Dine-in tables only — takeaway and delivery have no guests seated, so they get their own separate line instead of pulling the per-guest figures around. Requires Manager role or above.',
                  tips: [
                    'Revenue/Cover is the standard restaurant "average check per guest" metric — different from Sales Report\'s per-bill averages, since a bill for 6 people should read differently than a bill for 1',
                    'Turnover Time is bucketed by party size (1–2, 3–4, 5–6, 7+) because a 2-top and an 8-top have very different expected dine times — one blended average wouldn\'t mean much',
                    'Peak Hours buckets by when the table was opened (guests seated), not when the bill was paid — that\'s the number that tells you when to add floor staff',
                    'RevPASH (Revenue Per Available Seat-Hour) needs your Operating Hours set on the Overview tab first — without it, the card just prompts you to set them',
                    'By Server ranks staff by covers served, not bills — a server who takes fewer but larger tables can still lead here',
                    'A bill that later got a Credit Note still counts its guests — the guests really sat down. Its money comes off revenue per guest on the day the Credit Note was issued, the same way the Sales Report shows it',
                    'Reservations splits the range\'s covers into booked (bills a booking was seated onto) and walk-in, gives the no-show rate (no-shows ÷ kept + no-shows — cancelled bookings are neither), and breaks bookings down by how they were made and by the hour they were made for',
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
                    'Clearing an occupied table also leaves a Pulled Items row, reason "Table cleared", for any food that had already gone to the kitchen — the row stays even though the order itself is deleted, and is marked "order deleted"',
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
                    'A cash entry cannot be edited or deleted once saved. If one is wrong, add a second entry that corrects it (e.g. a Cash In of NPR 500 to undo a mistaken Cash Out of NPR 500), so the record shows both',
                    'Cash handed back to a customer on a Credit Note appears here as a Refund under Cash Out, with the Credit Note number',
                    'When a customer settles an older Credit bill in cash, that money is added to the open shift automatically (it shows as Cash In). Before, the bill stayed marked "Credit" forever and the cash appeared as an unexplained "over" on the drawer',
                    'The variance is shown live as you count the denominations, not just after closing — and closing more than NPR 100 out asks you to confirm the exact amount, so you can recount while the drawer is still open',
                    'A Balanced badge means the drawer matched exactly; red means short, amber means over — chase down shortages the same day while it\'s easy to remember why',
                    'You can run several shifts in a day (e.g. a morning cashier closes with a Z-report, an evening cashier opens a new one) — only one shift can be open at a time',
                    'Open a shift before the first bill of the day. Pay (including Credit and Split) and Complimentary cannot be charged while no shift is open, so every bill lands on a cash count. A Void does not need a shift',
                    'Closing a shift while tables are still open is allowed: the screen names the open orders (e.g. "Table 3 and 2 takeaways") and asks first. Those bills count on whichever shift is open when they are finally charged',
                    'A closed shift is a signed record — it cannot be edited or deleted. If the shift report could not be loaded, Close Shift refuses and says so, instead of signing off a report of zeros',
                    'Shift History lists every past shift — click one to see its full frozen Z-report',
                  ],
                },
                {
                  icon: '👥', name: 'POS Staff', path: '/pos/staff',
                  desc: 'Assign POS roles to your team. Only staff with a role assigned can see POS screens. Roles: Staff (order-taking only), Supervisor (+ billing/Charge, Complimentary, Credit, Recent Bills, shifts and cash in/out, settling credit), Manager (+ table setup, menu prices, Credit Notes, loyalty schemes, reports, role assignment). The Owner alone sets the invoice and VAT details printed on bills. Void is owner/admin-only by default — grant "Allow Void" on a specific staff member here to delegate it. Requires Manager role or above.',
                  tips: [
                    'Start by assigning the owner/manager account the Manager role — they can then assign roles to the rest of the team',
                    'Staff role = waiters who take orders only. They cannot access Table Management or reports',
                    'Supervisor role is ideal for head waiters and floor captains who need to set table status and manage the floor',
                    'Users with no role assigned cannot see any POS screens — the POS pages are hidden from their navigation',
                    'If Crest HR is also enabled, + Add Staff defaults to picking an existing HR Employee instead of typing a fresh name — the POS login is linked to that employee record (shown with a 🔗 HR tag) so the name never drifts out of sync. Switch to POS-only Staff for someone who isn\'t in HR (e.g. a casual/part-time role).',
                    'Discount Limit caps how much % discount that login can give at billing — leave it blank for unlimited. Allow Void lets that login void a bill themselves instead of needing the owner/admin. Both default to unrestricted-off, i.e. unlimited discount and no void access, until set here — except that a login created by a Manager who has a limit of their own starts at that Manager\'s limit.',
                    'What a POS Manager cannot do here: change their own login or another Manager\'s (role, PIN reset or removal), make anyone a Manager, give a Discount Limit bigger than their own (or "no limit" if they have one), or tick Allow Void when they cannot void themselves. Only the Owner can. This stops a manager handing a waiter more power than they have and then using that waiter\'s PIN.',
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
                  guide: 'Preview the currently-viewed client\'s guest QR menu without needing a printed QR code or asking the client for one. Pick a client in the top-bar switcher first, then pick one of that client\'s tables — the page embeds the exact live page a guest sees after scanning that table\'s QR (GuestMenu.jsx), including guest ordering if the client has that Pro-tier feature enabled.',
                  tips: [
                    'This is the real, live guest page, not a mockup — but Place Order is switched off inside the preview, so nothing added there reaches the client\'s staff. Open in New Tab is the real page, where an order is a genuine pending order in POS Orders',
                    'Copy Link or Open in New Tab if you want to test on an actual phone instead of the embedded preview',
                    'The page says why a guest menu looks the way it does: POS switched off (no menu at all), dishes switched on for POS with no selling price (left off the guest menu until priced), tables marked inactive (listed as "(inactive)" — their QR still shows the menu, but guests cannot order from it), and a menu that still opens with the account name or no logo (the Owner sets both in POS Setup → Guest Menu)',
                    'If the client has no tables set up yet, add one in Table Management first',
                  ],
                },
                {
                  icon: '◷', name: 'Audit Log',
                  guide: 'A full event log of every significant action in the system — creates, updates, deletes, period opens/closes, payroll runs, POS order voids/discounts/invoices, and admin client/feature changes. Every changed field is shown as old value → new value automatically, not just a hand-picked few, so a newly added field is covered the moment it exists. Filter by client, area, time range, or user, or search free text across all of those plus record IDs.',
                  tips: [
                    'Open a row\'s details (the ▸ button, or click the Details cell) to see every field that changed, not just the first three shown inline',
                    'Times are the BS date and Nepal time, whatever timezone the viewing computer is in',
                    'Filter by "Area" to narrow down to IMS, HR, POS, Fixed Assets, Staff PIN reveals or Admin actions',
                    'Filter by "User" or type into the search box to trace all actions by a specific person — these two only look through the entries loaded so far, so load more to search further back',
                    '"System" in the User column means a server process made the change with no signed-in user — an admin operation run through the server, or the trial purge job',
                    'A POS Order only logs meaningful transitions — void, discount, close, invoice — not every item added while the bill is still open',
                    '⬇ Export downloads the loaded, filtered rows as an Excel file, with a Scope sheet naming the filters',
                    '🗑 Delete old entries removes entries older than 90 days, 6 months, 1 year or 2 years (for one client or all). Recent history cannot be deleted, and every deletion is itself recorded in the log as "Purged"',
                  ],
                },
                {
                  icon: '🧾', name: 'POS Billing Setup',
                  guide: 'Per-client invoice settings, set in Manage Clients → a client → Settings tab. VAT Registered controls whether POS bills print as a Tax Invoice with a VAT breakdown or a plain Bill with PAN only. Invoice Prefix is the short client code used in invoice numbers (e.g. TI2238-CAC-82/83). It is never filled in for you: left blank, bills print without one (TI2238-82/83). Setting a code for the first time, or changing it, asks first — every bill already issued reprints with the new code, because the number is put together when a bill is printed. The client\'s scan-to-pay merchant QR payload is a separate QR tab in the same drawer.',
                  tips: [
                    'Turn VAT Registered off for clients billing on PAN only (not yet VAT-registered with IRD) — the bill header switches from "TAX INVOICE" to "BILL" and drops the VAT line',
                    'Invoice numbers reset to 1 at the start of each Nepal fiscal year (Shrawan) automatically — no manual reset needed',
                    'Payment QR: paste the client\'s raw merchant QR text (scanned off their physical FonePay/NepalPay/eSewa standee with any QR-reader app) into the QR tab — it live-validates and previews before saving, and every POS bill then carries a dynamic per-bill QR with the exact amount pre-filled',
                    'Invoice Prefix is uppercased automatically; keep it short (3–5 letters) so it fits the 80mm receipt width',
                  ],
                },
]

const GLOSSARY = [
  { term: 'Food Cost %',      def: 'Net Purchases ÷ Revenue × 100 — what you spent on stock this period against what you sold. The primary profitability metric for F&B operations. Industry benchmark: 28–35%. Note this is purchases-based, not consumption-based: it does not adjust for opening or closing stock, so a bulk restock makes it spike and it settles back over the month. Buy a month of rice in one go and an early-month reading can be well over 100% — the dashboards show a plain grey number with "settles at month end" until the figure is meaningful, rather than a red warning. The Food Cost % — Monthly Trend chart applies the same rule: the current month is held off the line for its first 9 days (and named underneath, so you know it exists), then drawn in grey — and it never counts toward the Average, Best month or Highest month, which cover completed months only. That Average is blended (total purchases ÷ total revenue across those months), not the mean of the individual monthly percentages, so a quiet month cannot outweigh a busy one. The Good/Watch/High bands on the chart follow your own Warning/Critical values from Settings → Thresholds. For the consumption-based version that does account for stock, see COGS.' },
  { term: 'COGS',             def: 'Cost of Goods Sold. Opening Stock + Purchases − Wastage − Staff Meals − Closing Stock. The actual cost of ingredients consumed in the period.' },
  { term: 'Per UOM Rate',     def: 'Cost per single unit of measure. If 1 KG of chicken costs NPR 700, the per UOM rate is NPR 0.70 per gram.' },
  { term: 'Theoretical Usage', def: 'What should have been used based on qty sold × recipe ingredient qty. Calculated from sales entries and recipes.' },
  { term: 'Actual Usage',     def: 'What was actually used: Opening Stock + Purchases − Closing Stock − Wastage.' },
  { term: 'Variance',         def: 'Actual Usage − Theoretical Usage. Positive variance = more used than expected. Indicates waste, theft, or over-portioning.' },
  { term: 'Variance Tolerance', def: 'The percentage a figure may differ by before Crest flags it, set per client in Settings → Thresholds → Variance Flag (default 10%). One number drives the colour, the mark and the flag badge on both variance reports.' },
  { term: 'Immaterial (≈)',   def: 'A variance that is outside your tolerance in percentage terms but worth under NPR 500 — shown in muted type with a ≈ mark rather than red, so small rupee amounts do not bury the rows that actually cost money.' },
  { term: 'FIFO',             def: 'First In, First Out. Use oldest stock before newer stock. Critical for perishables to minimise expiry waste.' },
  { term: 'Opening Stock',    def: 'Quantity of each ingredient at the start of the period (carried over from previous month closing stock).' },
  { term: 'Closing Stock',    def: 'Physical count of each ingredient at the end of the period.' },
  { term: 'Conversion Factor', def: 'How many base units are in one purchase unit. E.g. 1 case = 24 bottles → conversion factor = 24.' },
  { term: 'BS Calendar',      def: 'Bikram Sambat calendar used in Nepal. The system works natively in BS months.' },
  { term: 'Par Level',        def: 'Minimum stock quantity you want on hand. An item is flagged for reorder when its stock falls BELOW par — sitting exactly at par is fine. One rule everywhere it appears: Reorder Report, Stock Report, the Dashboard panel, the Owner Dashboard tile and the Monthly Owner Report.' },
  { term: 'Prime Cost',       def: 'Food Cost % + Labor Cost % — the two controllable costs combined, as a % of revenue. The single figure most restaurant operators benchmark against directly (industry standard ≈60–65%). Shown on Owner Dashboard.' },
  { term: 'Book Stock',       def: 'Live stock figure fed by the depletion ledger — decremented automatically on every POS sale/comp close and every saved manual Sales Entry day, shown in the Reorder Report. The physical stock count remains the source of truth. See Stock Movements for the itemised ledger.' },
  { term: 'SSF',              def: 'Social Security Fund (सामाजिक सुरक्षा कोष). Nepal mandatory contribution: 11% employee + 20% employer of basic salary.' },
  // — Crest HR —
  { term: 'TDS',              def: 'Tax Deducted at Source. Nepal\'s monthly income tax withholding on salary, computed via year-to-date cumulative projection against the current fiscal year\'s tax slabs.' },
  { term: 'Gratuity',         def: 'A lump-sum retirement/severance benefit under Nepal\'s Labour Act, accrued per year of service and paid at final settlement — separate from SSF.' },
  { term: 'CTC',              def: 'Cost to Company. Gross salary + Employer SSF contribution (20% of basic) — the employer\'s true monthly outlay, not the employee\'s take-home pay.' },
  { term: 'Dearness Allowance', def: 'महँगी भत्ता — a statutory monthly allowance separate from basic salary. Minimum NPR 7,380/month (set FY 2082/83, unchanged through FY 2083/84 — next review due Shrawan 2084). SSF is not computed on it.' },
  { term: 'Shift Type',       def: 'A named work-shift template (e.g. Morning, Evening, Split) with a colour and start/end time, defined in Roster → Shift Types and assigned to staff on the Roster Board.' },
  { term: 'Roster',           def: 'The weekly/monthly staff shift schedule. Planning-only — Attendance is the official record that feeds Payroll, though Attendance can be pre-filled from Roster via Generate from Roster.' },
  { term: 'Final Settlement', def: 'The full-and-final payment when an employee leaves — the final month\'s salary, unpaid travel claims, leave encashment, gratuity and notice pay, minus advances and tax.' },
  { term: 'Festival Allowance', def: 'A statutory bonus (commonly tied to Dashain) of up to one month\'s basic salary, shared out by the months a person has worked, and paid separately from monthly payroll. Its income tax is worked out on the person\'s whole year of income and is deposited with the tax for the month it is paid in.' },
  { term: 'Overtime (OT)',    def: 'Extra hours worked beyond the standard shift, paid at 1.5× the normal hourly rate on weekdays and 2× on public holidays.' },
  // — Crest POS —
  { term: 'KOT / BOT',        def: 'Kitchen Order Ticket / Bar Order Ticket — the printed slip sent to the kitchen or bar when an order item is sent, listing items and quantities to prepare.' },
  { term: 'X-Report / Z-Report', def: 'End-of-shift sales summaries. X-Report is a read-only mid-shift snapshot; Z-Report closes the shift and resets running totals for the next one.' },
  { term: 'Credit Note',      def: 'A document that reverses a billed sale (VAT Rules 2053, Rule 20) instead of deleting the original invoice — used whenever a paid bill needs correcting or refunding.' },
  { term: '1L+ Report',       def: 'The "One Lakh and above" compliance report (Annexure 13) — lists every party whose cumulative sales or purchases in a fiscal year come to ABOVE NPR 1,00,000, as required for VAT recordkeeping. On the purchase side a vendor is flagged on either the ex-VAT net or the invoiced total, whichever crosses first.' },
  // — Crest IMS (Growth/Pro) —
  { term: 'Dead Stock',       def: 'Items with zero usage over the period (Slow Movers = used less than 20% of available stock) — ingredients tying up money without turning over. Measured from the closing count, so an item that was never counted cannot be judged either way.' },
  { term: 'Shrinkage',        def: 'Recurring unexplained stock loss seen consistently across multiple periods — distinguished from a one-off Variance by checking period-over-period consistency.' },
  { term: 'Menu Engineering', def: 'Classifies menu items by popularity and profitability into four quadrants — Star (both high), Puzzle (popular but low-margin), Plowhorse (profitable but unpopular), Dog (both low) — to guide menu and pricing decisions. Note: this app\'s Plowhorse/Puzzle swap the traditional restaurant-industry meaning of those two words; the definitions here match what this app actually computes.' },
  { term: 'Demand Forecast',  def: 'A prediction of plates per dish, revenue and (with POS) covers for upcoming days (7/30-day horizon), exploded into the raw ingredients it will consume. Feeds the Roster\'s Labor Forecast and purchasing.' },
  { term: 'Requisition',      def: 'An internal stock transfer from the main store to a department (e.g. kitchen, bar), tracked separately from external purchases.' },
]

// MODULE_COLORS comes from ../data/pricingPlans — the single source of truth shared with
// Pricing.js and ClientDrawer.js. The PRICES no longer come from there directly (S701): this tab
// reads `useSettings().pricing`, so an admin's Settings > Plan Pricing edit shows up here and on
// the public page together. Importing the constants was what let the two disagree.

const FAQ = [
  { q: 'How does the navigation work? I have a lot of pages.', a: 'On a computer the navigation is a bar across the top, in two rows. The top row is your session: the Crest logo, one button per module you have (Crest IMS, Crest HR, Crest POS, plus Crest Customization and Crest Suite if your property has those), which property and BS period you are looking at, search, the calculator, and your name. The second row is the pages of whichever module is selected — Dashboard on its own, then one menu per group (Operations, Costing, the report categories). Click a module button to switch panels; the bar also follows you automatically when you navigate, so opening a POS page selects POS. Star a page inside any menu and it joins a Pinned menu at the front of the row. Help, Support and Sign out live under your name. On a phone the top bar is replaced by the ☰ button, which slides the same pages in from the left.' },
  { q: 'Why is my food cost % so high?', a: 'Common causes: purchases entered without closing stock (inflates COGS), over-portioning, wastage not recorded, theft, or supplier price increases not reflected in selling prices. Check the Variance Report to identify the biggest leaks.' },
  { q: 'What if I forgot to enter a purchase?', a: 'Go to Purchases, select the correct period, and add the entry with the correct day. The system recalculates everything automatically.' },
  { q: 'How do I correct a wrong entry?', a: 'Every entry has an Edit button. Click it, correct the values, and save. No need to delete and re-enter.' },
  { q: 'Why does my Variance Report show no theoretical usage?', a: 'Either you have not entered Sales Entries for the period, or the items have no Recipe built. Both are needed for theoretical usage to calculate.' },
  { q: 'Why did the Variance Report open on last month instead of this one?', a: 'Because variance can only be measured once the month\'s closing stock has been counted, which happens at month end. Mid-month there is no closing count, so everything still sitting on your shelves would be counted as "used" and every item would look over-consumed. The report therefore opens on the most recent closed month. You can still select the open month from the dropdown — it will tell you the count is missing and show the figures greyed out rather than flagging false losses.' },
  { q: 'What do the ✓ ▲ ▼ ≈ marks next to a variance figure mean?', a: 'They are the same verdict the colour gives, in a form that survives a photocopy, a greyscale print and colour blindness — worth knowing that red and amber are hard to tell apart for roughly 1 in 12 men, and those are exactly the two the variance reports use most. ✓ means the item is inside the tolerance you set in Settings → Thresholds. ▲ means more was used than your recipes and sales say should have been — waste, theft or over-portioning. ▼ means less was used than expected, usually under-portioning or a gap in the data. ≈ means the gap is too small in rupees to be worth chasing. The arrow always points the way the number actually went; the colour is the judgement about whether that is good or bad.' },
  { q: 'An item is 40% out but shows ≈ instead of red. Is that a bug?', a: 'No — it is under NPR 500 of value. A percentage on its own is misleading at the small end: a spice that should have used 50 GM and used 70 GM is 40% out and worth about NPR 20. If every one of those were painted red, the handful of rows that genuinely cost you money would be buried in them. The percentage is still printed, so you can see exactly what is being called immaterial rather than having it hidden from you.' },
  { q: 'What is the chip under a report title that says a month and Open or Closed?', a: 'It is the period the report covers. It used to be the last few words of the grey sentence under the title, which is easy to scan past — and it is the one thing worth checking before you trust any number on the page. Closed means the month is finished and its figures are final. Open means the month is still being entered; on a data-entry screen that is completely normal, but on a report whose figures depend on the closing stock count the chip is drawn with a dashed edge and a △ to say the numbers are provisional until the month is closed.' },
  { q: 'Two reports show a different COGS for the same month — which is right?', a: 'They agree now. COGS is Opening + Net Purchases − Wastage − Staff Meals − Closing everywhere in Crest, where Net Purchases means gross minus any bill-level discount minus vendor returns. Two things had to be fixed to make that true. Annual Summary used to leave staff meals out, so its COGS sat slightly BELOW Monthly Summary\'s for the same month (fixed 2026-08-13). And Annual Summary, Period Comparison and Budget vs Actual all left the bill DISCOUNT in, so their purchases and COGS sat ABOVE Monthly Summary\'s by exactly the discount (fixed 2026-09-09). The Dashboard, Owner Dashboard, Monthly Owner Report and Group Console had the same gap in their Food Cost % and were brought into line on 2026-09-14 — Owner Reports generated before that date keep the figures they were made with. Past months on those three pages will have moved as a result — they are right now. The one difference that is deliberate: Stock Count\'s Summary counts sub-recipes as stock and Monthly Summary does not, so its COGS is higher by exactly the prep amount, and both pages say so.' },
  { q: 'On Purchases, the Total under the table does not match the Bill Total column. Why?', a: 'They are two different, both-correct figures, and both are now labelled. "Total goods value (ex-VAT)" is qty × rate before any bill discount and before VAT — that is what Stock Count and COGS use. "Total payable (incl. VAT)" is what actually leaves the bank, and that is what the Bill Total column adds up to. The difference is VAT minus discount.' },
  { q: 'Can two staff members enter data at the same time?', a: 'Yes. The system is cloud-based and supports multiple users simultaneously.' },
  { q: 'What happens to data when I close a period?', a: 'Closing a period locks it from further editing by every login except the account owner\'s, and freezes that month\'s Monthly Report. All data is preserved permanently and you can view closed period reports at any time. If a purchase bill turns up afterwards, the account owner (or your Crest admin) can still enter it — Periods carries an "Add missing bills" action on every closed month that opens Purchases on that month. Afterwards, press Regenerate Snapshot on that month\'s Monthly Report so it includes the change.' },
  { q: 'How do I add a new menu item to recipe costing?', a: 'Go to Recipe Costing → New Recipe. Add ingredients from your Item Master with qty per portion. The system calculates food cost instantly.' },
  { q: 'Why is there no sales line on the Dashboard "Purchases vs Sales" chart?', a: 'The sales line only plots when sales are recorded day-by-day. In Sales, pick a specific day and enter that day\'s quantities (rather than one bulk monthly total). Once a few days are entered, the green sales line appears, and with 5+ days in the current month a dashed month-end revenue projection is added. (When the POS module ships, it will feed daily sales automatically.)' },
  { q: 'Can I add many recipes at once instead of one line at a time?', a: 'Yes. In Recipe Costing, click ↓ Template to download a spreadsheet (one row per ingredient; recipe-level fields on the first row of each recipe). Fill it in Excel/Sheets — the template includes a "Your Items" sheet with your exact item names/codes/units to copy from — then click ↑ Import Excel. A preview shows what matched; unmatched ingredients are skipped (add those items to the Item Master first, then re-import). The ingredients must already exist as items because each item carries its own purchase rate and unit conversion. To copy a similar dish, use the Clone button on any recipe row.' },
  { q: 'Why won’t a vendor delete?', a: 'A vendor can only be deleted outright while nothing is recorded against it — no purchase entry, purchase order, vendor return or gate pass. That is because the vendor row is the only place its name is stored: every bill, return and report keeps a link to it rather than a copy of the name, so deleting the row is what would erase that supplier from your own history. For a vendor you have actually bought from, Deactivate it and then Archive it. Archiving takes it off the Vendors page and out of every dropdown, and because the row is kept and hidden rather than deleted, every past bill, Vendor Report, Outstanding Payables line and balance confirmation still names it. Archived vendors are listed under "Show archived" and can be restored at any time. All three actions are visible to Crest support only.' },
  { q: 'Why won’t an item delete?', a: 'An item can only be hard-deleted if nothing references it. If it appears in any purchase, stock count, wastage, staff meal, requisition, vendor return, or recipe — even a zero-quantity one — the delete is blocked and you’ll see why. The best option is Hide: it removes the item from all lists and dropdowns while keeping its history intact. Admins also get a Force Delete option that erases the item and every record referencing it (this recalculates affected past reports and cannot be undone) — use it only for true duplicates/mistakes.' },
  { q: 'How do I quickly find an item in a long dropdown?', a: 'The item pickers in Purchases, Recipes, Stock’s Daily Wastage, and Requisitions are searchable — click the field and start typing to filter, then use ↑/↓ and Enter (or click) to choose. On Recipe Costing there is also a “Find ingredient in recipes” box that lists every recipe using a given ingredient, including ones where it’s inside a sub-recipe.' },
  // — Crest HR —
  { q: 'Why isn\'t SSF being deducted for an employee?', a: 'Check Pay Setup → Bank/SSF tab for that employee — the SSF Enrolled toggle must be switched on AND an SSF No. entered. The toggle is off by default for new employees. Until both are there, no 11%/20% SSF is computed anywhere, including Payroll — with the toggle on but no number, Payroll charges the 1% social security tax instead, and Pay Setup marks the row "⚠ SSF no. missing".' },
  { q: 'How does Payroll handle unpaid leave?', a: 'Mark the day Unpaid Leave in Attendance (or approve an unpaid leave request in Leave Management, which marks it automatically). Payroll deducts unpaid days from monthly-basis staff and simply doesn\'t pay for that day for daily/hourly staff.' },
  { q: 'Why can\'t I delete an employee?', a: 'Because they have history on file: finalized payslips, a finalized Final Settlement, finalized festival allowances, an advance or loan, a Self-Service login, or TADA claims, incentive/bonus records or shift-swap requests. That history is kept on purpose — it covers money paid and approvals given — so the delete is refused, by the database as well as the page. Use Deactivate in their Edit form instead: it removes them from payroll pickers, rosters and attendance while keeping everything. An employee with none of those on record (someone added by mistake, say) can still be deleted; if a Self-Service login is the only thing in the way, Remove it from the Employees list first.' },
  { q: 'How do I stop a former employee logging into Self-Service?', a: 'Two options, depending on whether it is temporary. To suspend access but keep the account, tick their row on Employees and click Deactivate (block login) — Activate (allow login) restores it, and neither affects payroll. (The Deactivate button inside the Edit form is a different thing: it takes them off payroll and does not block the login.) To remove the login for good, click Remove next to their ✓ Self-Service badge; their PIN stops working immediately and the login is deleted. Both keep the employee record, payslips and leave history, and you can Enable Self-Service again later with a new PIN.' },
  { q: 'What does the "OT: 2 sources" note in Payroll mean?', a: 'It means the same employee has overtime in both the Attendance sheet\'s OT column and an approved Overtime module entry for this period. They are not added together: on any day an approved entry exists it supersedes the attendance sheet, so nothing is paid twice. Days with no approved entry still pay their attendance OT at 1.5×.' },
  // — Crest POS —
  { q: 'What\'s the difference between Void and Complimentary?', a: 'Void cancels a bill entirely — no sale is recorded. Complimentary keeps the sale on record (for stock/COGS purposes) but zeroes the amount charged to the guest. Complimentary needs Supervisor+ access; Void is owner/admin-only by default, though a manager can grant "Allow Void" to a specific staff member in POS Staff. Both require a reason.' },
  { q: 'An item printed to the wrong station — or nothing printed at all. Why?', a: 'For the wrong station, check POS → Table Management → Ticket Routing: you tick the categories that go to the BAR ticket, and every category you do not tick goes to the Kitchen. So an unrouted drinks category prints to the kitchen, not nowhere. If nothing printed at all, it is the browser, not the routing — a blocked pop-up stops the ticket opening (allow pop-ups for this site, then use Reprint last KOT/BOT on the order screen), or the item was never sent, which the amber "⚠ pending" pill on the floor is there to catch.' },
  { q: 'Can I edit or delete a bill after it\'s been paid/closed?', a: 'No — once billed, an order can\'t be edited or deleted directly, so the original record is always preserved for audit. To correct a paid bill, issue a Credit Note, which reverses it instead of altering history.' },
  { q: 'I signed up — why does it say you will call me?', a: 'Every Crest trial is switched on by a person. We call the number you gave within one working day, confirm you run a restaurant, café or hotel, and press Approve — your 7-day trial starts on that day, not on the day you signed up, so waiting costs you nothing. The trial runs at the Growth level with IMS, HR and POS all on, and the current BS month is already open for you when you first log in. If you have not heard from us in a working day, the Support button on the left has our number.' },
  { q: 'What happens if my subscription expires?', a: 'You get a 7-day grace period first — everything keeps working normally and a red banner at the top of every page counts down the days left. After that, Crest locks and shows a renewal screen instead of the app. Nothing is deleted: your data stays exactly as it was, and renewing restores full access immediately. Free trials lock on the day the trial ends rather than getting the grace period, but trial data is still kept for the retention window shown on that screen.' },
  { q: 'Can I get a copy of all my data?', a: 'Yes — ask us and we can export your entire account to an Excel workbook: purchases, sales, stock, recipes, vendors, payroll, POS orders, the lot. You get a readable .xlsx plus a .json file that can be restored back into Crest later. It works whether your subscription is active or not, and your data is never deleted without a backup being taken first.' },
]

// ── Getting Started — Crest HR ────────────────────────────────────────────────
const HR_SETUP_STEPS = [
  { step: 1, title: 'Add your Employees', desc: 'Go to Employees → add each staff member with a name, join date, employment type and status. Designation, department and the rest are optional.', why: 'Every attendance mark and payslip is tied to an employee record here.' },
  { step: 2, title: 'Set up their Pay', desc: 'Go to Pay Setup → enter pay basis (monthly, daily, or hourly), basic salary, allowances, SSF enrollment with the SSF number, and bank details for each employee.', why: 'Payroll can\'t compute anything until basic salary — and, if applicable, SSF enrollment plus the SSF number — is set.' },
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
  { step: 6, title: 'Handle Advances & Festival Allowance', desc: 'Advances & Loans and Festival Allowance → process anything due this month. Advance cuts come off the next payroll, and the salary cuts are recorded automatically when you Finalize it — don\'t enter them by hand; use Record Repayment only for cash an employee paid back. A finalized festival allowance is counted in later months\' income tax.' },
]
const HR_MISTAKES = [
  'Finalizing payroll before attendance, leave, and OT are fully settled for the period — Finalize locks the month, so anything entered late won\'t be reflected.',
  'Forgetting to switch on SSF Enrolled and enter the SSF No. per employee in Pay Setup — the switch is off by default, and until both are there, no SSF is deducted or contributed for that employee anywhere, including Payroll.',
  'Assuming attendance-sheet OT and an approved Overtime entry add together — they do not: the approved entry supersedes the sheet for that day, and only the Overtime module can pay the holiday 2× rate.',
  'Finalizing months out of BS-calendar order — TDS is a year-to-date cumulative projection, so skipping ahead throws off the tax calculation for every month after it.',
]

// ── Getting Started — Crest POS ───────────────────────────────────────────────
const POS_SETUP_STEPS = [
  { step: 1, title: 'Set up your Tables', desc: 'Go to Tables → ⚡ Quick Setup to batch-generate a floor plan in one click.', why: 'Orders and billing are organised by table — there\'s nothing to bill against without them.' },
  { step: 2, title: 'Add Staff & PINs', desc: 'Go to POS Staff → add each team member with a role (Staff / Supervisor / Manager) and a 4–6 digit PIN.', why: 'Only staff with a role assigned appear on the POS login screen at all.' },
  { step: 3, title: 'Configure your Menu', desc: 'Go to Menu Pricing → add items with a menu price (and cost price, if you\'re not also running IMS Recipe Costing).', why: 'The order screen only shows items that exist here with On POS checked.' },
  { step: 4, title: 'Activate each till tablet', desc: 'On the tablet itself, sign in with your email and go to POS → Setup → give it a name ("Front counter", "Bar") → Activate.', why: 'A tablet that has never been activated shows no staff list at /pos/login, so nobody can sign in with a PIN. Each tablet gets its own key, so a lost one can be revoked on its own.' },
  { step: 5, title: 'Set up Silent Printing', desc: 'One-time device setup on a dedicated till — see the Silent Printing Setup guide below. Skip this if staff are fine using the normal browser print dialog.', why: 'Without it, every KOT/bill print pops a print dialog staff have to click through manually.' },
  { step: 6, title: 'Open your first Shift', desc: 'Go to Shifts → Open Shift → count the starting cash drawer — do this before the first bill of the day.', why: 'No shift open means no charging: Crest refuses a Charge (Cash, QR, Split, Credit) or a Complimentary until a shift is open, so every bill lands on a drawer count and a Z-report. Only a Void is allowed without one.' },
]
const POS_WORKFLOW_STEPS = [
  { step: 1, title: 'Open Shift', desc: 'Shifts → Open Shift → count the starting cash drawer at the start of the day.' },
  { step: 2, title: 'Take Orders', desc: 'Orders → seat guests, add items, send KOT/BOT to the kitchen or bar.' },
  { step: 3, title: 'Bill & Close', desc: 'Charge the order when the guest is ready to pay — apply any discount or mark Complimentary, always with a reason.' },
  { step: 4, title: 'Close Shift', desc: 'Shifts → Close Shift at the end of the day → reconcile the counted cash against the system total → review the Z-report.' },
  { step: 5, title: 'Check the Sales Report', desc: 'Sales Report → review payment-method and category breakdowns periodically, not just at shift close.' },
]
const POS_MISTAKES = [
  'Leaving the shift closed at the start of service — Pay and Complimentary are both refused until one is open, so the first guest of the day cannot be charged. Only one shift can be open at a time, so close the old one before opening the new.',
  'Confusing Void with Complimentary — Void cancels the sale entirely (nothing recorded); Complimentary keeps the sale on record for stock/COGS but zeroes what the guest pays.',
  'Forgetting to configure Ticket Routing — only the categories you assign go to the Bar ticket, and everything else goes to the Kitchen. A drinks category you never routed prints to the kitchen instead of the bar, where nobody is watching for it.',
  'Letting staff share PINs — it breaks the per-staff accountability that Sales Exceptions and the audit trail depend on.',
]

export default function Help() {
  const { imsEnabled, hrEnabled, posEnabled, plan, isAdmin } = useAuth()
  const location = useLocation()
  const [activeSection, setActiveSection]         = useState(() => sectionFromSearch(location.search) || 'guide')
  // Clicking the rail's Support button while already on /help changes only the query string, so
  // the initializer above does not rerun — follow the URL when it names a section.
  useEffect(() => { const s = sectionFromSearch(location.search); if (s) setActiveSection(s) }, [location.search])
  const [expandedModule, setExpandedModule]       = useState(null)
  const [expandedFaq, setExpandedFaq]             = useState(null)
  const [pricingAnnual, setPricingAnnual]         = useState(false)
  const [searchQuery, setSearchQuery]             = useState('')
  const { settings, pricing } = useSettings()
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
  // The Getting-Started headers are real disclosure buttons inside their <h3> (the same shape as
  // the feature accordion and the FAQ further down). They were <div onClick> until S682, which
  // closed the onboarding walkthrough to every keyboard and screen-reader user.
  const GS_TOGGLE_STYLE = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
    background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
    font: 'inherit', color: 'inherit',
  }
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
                    <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 2, flexShrink: 0 }}>→</span>
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
        background: 'var(--theme-card)', border: '1px solid var(--theme-border-lt)', borderRadius: 'var(--radius-sm)', marginBottom: 4,
      }}>
        {/* Label the state, never dim the row: opacity multiplies through the text colour and took
            these below AA — on the names of the features an owner would upgrade FOR (S682). */}
        <span aria-hidden="true" style={{ fontSize: 14, width: 22, textAlign: 'center', flexShrink: 0 }}>{feat.icon}</span>
        <span style={{ fontSize: 13, color: 'var(--theme-text3)' }}>{feat.name}</span>
        <span className="badge badge-gray" style={{ marginLeft: 'auto', flexShrink: 0 }}>Not on your plan</span>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Help & Guide</h1>
        <p className="page-subtitle">How to use every feature — glossary, FAQ, and tips</p>
      </div>

      {/* Visible on every tab without a click, not just the Support one below (S673) — the guide
          answers "how", this answers "who do I ask when the guide doesn't". */}
      <div className="no-print" style={{ marginBottom: 16, fontSize: 12, color: 'var(--theme-text3)' }}>
        Need help? <SupportContactLine variant="inline" />
      </div>

      {/* Section tabs */}
      <div role="tablist" aria-label="Help sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 28, borderBottom: '1px solid var(--theme-border)' }}>
        {[
          { id: 'guide',   label: 'Getting Started' },
          { id: 'modules', label: 'Module Guide' },
          { id: 'glossary', label: 'Glossary' },
          { id: 'faq',     label: 'FAQ' },
          { id: 'pricing', label: '💎 Pricing' },
          { id: 'support', label: 'Support' },
          { id: 'legal',   label: 'Legal' },
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
          className="form-input"
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
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent-ink)', width: 34, flexShrink: 0, marginTop: 14, textTransform: 'uppercase' }}>{module}</span>
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
          <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-accent) 3%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⬢</span>
              <div style={{ flex: 1 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--theme-text1)' }}>
                  <button type="button" aria-expanded={gsOpen('ims')} onClick={() => toggleGS('ims')} style={GS_TOGGLE_STYLE}>
                    <span>Welcome to Crest Suite</span>
                    <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13, fontWeight: 400 }}>{gsOpen('ims') ? '▲' : '▼'}</span>
                  </button>
                </h3>
                {!gsOpen('ims') && (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, monthly workflow, and common mistakes to avoid.</p>
                )}
                {gsOpen('ims') && (
                  <>
                    <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                      Crest tracks your ingredient purchases, stock levels, and food cost in real time. The core idea is simple:
                    </p>
                    <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, color: 'var(--theme-accent-ink)', fontWeight: 600 }}>Opening Stock + Purchases − Wastage − Closing Stock = COGS (what you actually used)</span>
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
                <div style={{ width: 32, height: 32, borderRadius: 0, background: 'color-mix(in srgb, var(--theme-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '1px 7px', borderRadius: 0 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 6 }}>{s.desc}</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
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
              { step: 3, title: 'Record Purchases as they arrive',  desc: 'Purchases → Add Purchase opens a full-page bill screen — enter vendor, item, qty, rate, payment method, then Save to return to the list. Enter each bill on the day it arrives.' },
              { step: 4, title: 'Record Wastage as it happens',     desc: 'Stock Count → Wastage tab → log any spoilage or discards on the day.' },
              { step: 5, title: 'Enter Sales',                      desc: 'Sales Entry → enter qty sold per menu item. Use Bulk Entry for a month-end tally. Running Crest POS? Skip this step entirely — the till posts sales for you, and both entry tabs are locked.', plan: 'Starter+' },
              { step: 6, title: 'Physical Stock Count',             desc: 'On the last day: print the Stock Count Sheet (Stock → Print Sheet), do a physical walk of your storeroom, enter counts in Stock Count → Closing Stock.' },
              { step: 7, title: 'Review Monthly Summary',           desc: 'Monthly Summary → check food cost %, COGS per category, and revenue. Export to Excel for management.' },
              { step: 8, title: 'Review Variance Report',           desc: 'Variance → sort by NPR value → investigate every row marked ▲. High variance = waste, theft, or over-portioning. The threshold is yours (Settings → Thresholds → Variance Flag, default 10%).', plan: 'Growth+' },
              { step: 9, title: 'Close the Period',                 desc: 'Periods → Close → confirm. Locks all data. Closing stock automatically becomes opening stock for next month.' },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: 'flex', gap: 14, marginBottom: 12, paddingBottom: 12, borderBottom: i < arr.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                <div style={{ width: 26, height: 26, borderRadius: 0, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{s.title}</span>
                    {s.plan && <span style={{ fontSize: 11, fontWeight: 700, color: s.plan === 'Growth+' ? 'var(--theme-green-text)' : 'var(--theme-text3)', background: s.plan === 'Growth+' ? 'color-mix(in srgb, var(--theme-green) 10%, transparent)' : 'rgba(156,163,175,0.1)', border: `1px solid ${s.plan === 'Growth+' ? 'color-mix(in srgb, var(--theme-green) 20%, transparent)' : 'rgba(156,163,175,0.2)'}`, padding: '1px 7px', borderRadius: 0 }}>{s.plan}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 15%, transparent)' }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
            {[
              'Closing a period before entering closing stock — your COGS will be inflated with no closing offset.',
              'Skipping opening stock in month 1 — your food cost % will be artificially high.',
              'Entering all purchases at month end from memory — enter them daily from the actual invoice for an accurate rate and vendor record.',
              'Ignoring the Variance Report — if you don\'t check it, waste and over-portioning go undetected for months.',
              'Using estimated closing stock — always do a physical count. Estimated numbers make every report inaccurate.',
            ].map((text, i, arr) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                <span style={{ color: 'var(--theme-red-text)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
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
            <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-accent) 3%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>👤</span>
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: '0 0 8px', fontSize: 15, color: 'var(--theme-text1)' }}>
                    <button type="button" aria-expanded={gsOpen('hr')} onClick={() => toggleGS('hr')} style={GS_TOGGLE_STYLE}>
                      <span>Welcome to Crest HR</span>
                      <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13, fontWeight: 400 }}>{gsOpen('hr') ? '▲' : '▼'}</span>
                    </button>
                  </h3>
                  {!gsOpen('hr') && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, monthly workflow, and common mistakes to avoid.</p>
                  )}
                  {gsOpen('hr') && (
                    <>
                      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                        Crest HR runs payroll, attendance, and Nepal-compliant SSF/TDS deductions for your staff. The core idea is simple:
                      </p>
                      <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '10px 16px', display: 'inline-block', marginBottom: 8 }}>
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
                  <div style={{ width: 32, height: 32, borderRadius: 0, background: 'color-mix(in srgb, var(--theme-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{s.title}</div>
                    <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 6 }}>{s.desc}</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
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
                  <div style={{ width: 26, height: 26, borderRadius: 0, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 3 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 15%, transparent)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
              {HR_MISTAKES.map((text, i, arr) => (
                <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                  <span style={{ color: 'var(--theme-red-text)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
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
            <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-accent) 3%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                <span aria-hidden="true" style={{ fontSize: 32, lineHeight: 1, flexShrink: 0 }}>⊕</span>
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: gsOpen('pos') ? '0 0 8px' : 0, fontSize: 15, color: 'var(--theme-text1)' }}>
                    <button type="button" aria-expanded={gsOpen('pos')} onClick={() => toggleGS('pos')} style={GS_TOGGLE_STYLE}>
                      <span>Welcome to Crest POS</span>
                      <span aria-hidden="true" style={{ color: 'var(--theme-text3)', fontSize: 13, fontWeight: 400 }}>{gsOpen('pos') ? '▲' : '▼'}</span>
                    </button>
                  </h3>
                  {!gsOpen('pos') && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>Click to see first-time setup, daily workflow, and common mistakes to avoid.</p>
                  )}
                  {gsOpen('pos') && (
                    <>
                      <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.75 }}>
                        Crest POS runs your floor — tables, orders, billing, and shift reconciliation. The core idea is simple:
                      </p>
                      <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '10px 16px', display: 'inline-block' }}>
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
                  <div style={{ width: 32, height: 32, borderRadius: 0, background: 'color-mix(in srgb, var(--theme-accent) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{s.title}</div>
                    <div style={{ fontSize: 13, color: 'var(--theme-text3)', marginBottom: 6 }}>{s.desc}</div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11, marginTop: 1, flexShrink: 0 }}>Why:</span>
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
                  <div style={{ width: 26, height: 26, borderRadius: 0, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', flexShrink: 0 }}>{s.step}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 3 }}>{s.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{s.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-red) 15%, transparent)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: 'var(--theme-text1)' }}>Common Mistakes to Avoid</h3>
              {POS_MISTAKES.map((text, i, arr) => (
                <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < arr.length - 1 ? 10 : 0 }}>
                  <span style={{ color: 'var(--theme-red-text)', fontSize: 12, flexShrink: 0, marginTop: 1 }}>✕</span>
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
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', cursor: 'pointer' }}
              >
                <span style={{ fontSize: 18, color: 'var(--theme-accent-ink)' }}>▦</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest IMS</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Active</span>
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
                        <span style={{ fontSize: 9, fontWeight: 700, color: tier.planColor, background: colorTint(tier.planColor, 8), border: `1px solid ${colorTint(tier.planColor, 19)}`, padding: '1px 7px', borderRadius: 0 }}>
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
                        borderRadius: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12
                      }}>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                          Upgrade to <strong style={{ color: tier.planColor }}>{tier.planLabel}</strong> to unlock {tier.features.length} features
                        </span>
                        <button
                          onClick={() => navigate('/pricing')}
                          style={{ fontSize: 11, fontWeight: 700, color: tier.planColor, background: colorTint(tier.planColor, 8), border: `1px solid ${colorTint(tier.planColor, 21)}`, borderRadius: 0, padding: '4px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}
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
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', cursor: 'pointer' }}
              >
                <span style={{ fontSize: 18, color: 'var(--theme-accent-ink)' }}>👤</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest HR</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Active</span>
                <span style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('hr') ? '▲' : '▼'}</span>
              </div>
              {moduleOpen('hr') && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Human Resources</span>
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
                style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', cursor: 'pointer' }}
              >
                <span style={{ fontSize: 18, color: 'var(--theme-accent-ink)' }}>⊕</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Crest POS</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', background: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Active</span>
                <span style={{ marginLeft: 'auto', color: 'var(--theme-text3)', fontSize: 13 }}>{moduleOpen('pos') ? '▲' : '▼'}</span>
              </div>
              {moduleOpen('pos') && (
                <>
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Point of Sale</span>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: '2px solid color-mix(in srgb, var(--theme-red) 20%, transparent)' }}>
                <span style={{ fontSize: 18, color: 'var(--theme-red-text)' }}>⚙</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif' }}>Admin Tools</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-red-text)', background: 'color-mix(in srgb, var(--theme-red) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 20%, transparent)', padding: '2px 8px', borderRadius: 0 }}>Crest Admin Only</span>
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
                    <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{g.term}</td>
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
              <span style={{ width: 8, height: 8, borderRadius: 0, background: MODULE_COLORS.ims }} />
              <span style={{ width: 8, height: 8, borderRadius: 0, background: MODULE_COLORS.hr }} />
              <span style={{ width: 8, height: 8, borderRadius: 0, background: MODULE_COLORS.pos }} />
            </div>
            <h2 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 8px', fontFamily: 'Georgia, serif', color: 'var(--theme-text1)' }}>Plans & Pricing</h2>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>One system for IMS, HR, and POS — pick a module or bundle them all</p>
            <div style={{ display: 'inline-flex', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: 3, gap: 2 }}>
              <button onClick={() => setPricingAnnual(false)} style={{ background: !pricingAnnual ? 'color-mix(in srgb, var(--theme-accent) 15%, transparent)' : 'none', border: !pricingAnnual ? '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)' : '1px solid transparent', color: !pricingAnnual ? 'var(--theme-accent-ink)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Monthly</button>
              <button onClick={() => setPricingAnnual(true)}  style={{ background:  pricingAnnual ? 'color-mix(in srgb, var(--theme-accent) 15%, transparent)' : 'none', border:  pricingAnnual ? '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)' : '1px solid transparent', color:  pricingAnnual ? 'var(--theme-accent-ink)' : 'var(--theme-text2)', padding: '6px 18px', borderRadius: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                Annual <span style={{ background: 'color-mix(in srgb, var(--theme-green) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 25%, transparent)', color: 'var(--theme-green-text)', fontSize: 9, padding: '2px 7px', borderRadius: 0, fontWeight: 700 }}>Save 25%</span>
              </button>
            </div>
          </div>

          {/* Crest IMS — 3 tiers */}
          <p style={{ fontSize: 11, color: MODULE_INK.ims, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>Crest IMS</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 24 }}>
            {pricing.imsTiers.map(plan => {
              const highlight = plan.key === 'growth'
              const price = pricingAnnual ? plan.annual : plan.monthly
              return (
                <div key={plan.key} className="card" style={{ border: highlight ? `1px solid ${colorTint(MODULE_COLORS.ims, 44)}` : '1px solid var(--theme-border)', position: 'relative', display: 'flex', flexDirection: 'column', padding: '32px 22px 22px', boxShadow: highlight ? `0 4px 32px ${colorTint(MODULE_COLORS.ims, 9)}` : 'none' }}>
                  {highlight && (
                    <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: MODULE_COLORS.ims, color: 'var(--theme-accent-text)', fontSize: 9, fontWeight: 800, padding: '3px 12px', borderRadius: 0, letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                      Most Popular
                    </div>
                  )}
                  <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: MODULE_INK.ims, fontFamily: 'Georgia, serif' }}>{plan.label}</span>
                    {highlight && (
                      <span style={{ fontSize: 9, fontStyle: 'italic', fontWeight: 800, color: MODULE_INK.ims, background: colorTint(MODULE_COLORS.ims, 8), border: `1px solid ${colorTint(MODULE_COLORS.ims, 25)}`, padding: '2px 6px', borderRadius: 0, letterSpacing: '0.05em' }}>
                        TRIALS RUN HERE
                      </span>
                    )}
                  </div>
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {price.toLocaleString('en-IN')}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/month</span></div>
                    {pricingAnnual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Billed annually · NPR {(price * 12).toLocaleString('en-IN')}/year</div>}
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

          {/* Crest HR + Crest POS + Crest Customization — flat modules */}
          <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, marginBottom: 10 }}>
            <span style={{ color: MODULE_INK.hr }}>Crest HR</span>
            <span style={{ color: 'var(--theme-text3)' }}>, </span>
            <span style={{ color: MODULE_INK.pos }}>Crest POS</span>
            <span style={{ color: 'var(--theme-text3)' }}> &amp; </span>
            <span style={{ color: MODULE_INK.customization }}>Crest Customization</span>
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }}>
            {[
              { key: 'hr',  name: 'Crest HR',  color: MODULE_INK.hr,  pricing: pricing.hr },
              { key: 'pos', name: 'Crest POS', color: MODULE_INK.pos, pricing: pricing.pos },
              { key: 'customization', name: 'Crest Customization', color: MODULE_INK.customization, pricing: pricing.customization },
            ].map(mod => {
              const price = pricingAnnual ? mod.pricing.annual : mod.pricing.monthly
              return (
                <div key={mod.key} className="card" style={{ display: 'flex', flexDirection: 'column', padding: '32px 22px 22px' }}>
                  <div style={{ marginBottom: 6 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: mod.color, fontFamily: 'Georgia, serif' }}>{mod.name}</span>
                  </div>
                  <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid var(--theme-border)' }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>NPR {price.toLocaleString('en-IN')}<span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)' }}>/month</span></div>
                    {pricingAnnual && <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>Billed annually · NPR {(price * 12).toLocaleString('en-IN')}/year</div>}
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
          <div className="card" style={{ marginBottom: 24, borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ minWidth: 180 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', fontFamily: 'Georgia, serif', marginBottom: 8 }}>{pricing.suite.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--theme-text1)' }}>
                  +NPR {(pricingAnnual ? pricing.suite.annual : pricing.suite.monthly).toLocaleString('en-IN')}
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text2)' }}>/month per outlet</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 6 }}>{pricing.suite.requiresLabel}</div>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, flex: 1, minWidth: 240 }}>
                {pricing.suite.features.map(f => (
                  <li key={f} style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 5, lineHeight: 1.5 }}>{f}</li>
                ))}
              </ul>
            </div>
          </div>

          <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <h3 style={{ margin: '0 0 4px', fontSize: 15, color: 'var(--theme-text1)' }}>Ready to upgrade?</h3>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Contact your Crest consultant to change your plan.</p>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                {phone   && <a href={`tel:${phone}`}    style={{ color: 'var(--theme-accent-ink)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>📞 {phone}</a>}
                {email   && <a href={`mailto:${email}`} style={{ color: 'var(--theme-accent-ink)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>✉ {email}</a>}
                {website && <a href={website.startsWith('http') ? website : `https://${website}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--theme-accent-ink)', fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 5 }}>🌐 {website}</a>}
                {!phone && !email && !website && <span style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Contact your Crest consultant to upgrade.</span>}
                <button onClick={() => navigate('/pricing')} style={{ background: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 30%, transparent)', color: 'var(--theme-accent-ink)', padding: '8px 16px', borderRadius: 0, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
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

      {/* Support (S673) */}
      {activeSection === 'support' && (
        <div style={{ maxWidth: 560 }}>
          <div className="card">
            <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Get in touch</h3>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
              For anything the guide above doesn't answer — a bug, a question, or your outlet is down.
            </p>
            {/* Hours and the outlet-down promise come from the block itself (S683): both are now
                admin-edited in Settings → Support, so a hardcoded gloss here would drift from them. */}
            <SupportContactLine variant="block" />
          </div>
        </div>
      )}

      {activeSection === 'legal' && (
        <Suspense fallback={<p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Loading…</p>}>
          <LegalTab />
        </Suspense>
      )}

      </>}
      </div>
    </div>
  )
}
