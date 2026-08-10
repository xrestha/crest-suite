// Content for Admin Settings → Guides → Crest IMS. Static reference data, not fetched from the DB —
// edit this file directly and redeploy to update the guide (see CLAUDE.md decision log, S417).
// Grouped to mirror the IMS sidebar's own NAV_GROUPS in Layout.js so the guide reads in the same
// order a user encounters the module.

export const IMS_GUIDE_GROUPS = [
  {
    key: 'overview',
    label: 'Overview',
    sections: [
      {
        id: 'overview',
        title: 'How the IMS module fits together',
        route: null,
        plan: null,
        summary:
          'Crest IMS is a periodic, physical-count-based inventory and food-cost system for Nepali F&B businesses — not a live perpetual-inventory ledger. Almost every page on this list is scoped to one BS (Bikram Sambat) monthly Period, and most of the numbers you will ever be asked about ultimately come from the same handful of tables: purchase_entries, vendor_returns, opening_stock, closing_stock, wastages, staff_meals, sales_entries, and recipe_ingredients.',
        workflow: [
          'Everything starts with Periods — a client must have an open BS month before anything else (Purchases, Stock Count, Sales Entry, Overheads) will accept data.',
          'Day to day, purchases are logged in Purchases and sales in Sales Entry (or synced automatically from POS if the client also runs Crest POS).',
          'At month end, a physical Closing Stock count is taken in Stock Count. Closing this period auto-carries that physical count forward as next month\'s Opening Stock — opening stock is never re-derived, it is always last month\'s real count.',
          'Reports (Monthly Summary, Variance, Stock Report, and everything under Stock/Finance/Menu & Vendor Reports) are all read-only views built by combining the tables above for the selected period — they store nothing new themselves except a few cached fields (e.g. Menu Engineering\'s me_class, Demand Forecast\'s stored run).',
          'Cutting across all of the above: a three-tier role system (Staff / Supervisor / Manager) decides which of these pages a given login can reach at all. Two people can therefore describe "the IMS module" completely differently depending on their tier — worth establishing before troubleshooting a "the page isn\'t there" report. See IMS Staff under Admin for the full tier-by-tier breakdown.',
        ],
        fields: [],
        formulas: [
          'Nearly every "food cost" figure in this module reduces to some version of: COGS = Opening Stock + Net Purchases − Wastage − Staff Meals − Closing Stock, where Net Purchases = Gross Purchases − Vendor Returns.',
          'Revenue is almost always: Σ(qty_sold × unit_price), excluding sales_entries rows with source = \'pos_comp\' (comped/free dishes never billed).',
        ],
        gotchas: [
          'Different reports compute "food cost" slightly differently on purpose — Overheads.js uses pure purchase spend (no opening/closing adjustment), Monthly/Annual Summary and Period Comparison use the full COGS formula above, and these can legitimately show different percentages for the same month. This is the single most common source of "why don\'t these two pages match" support questions — see the callout on Overheads and Monthly Summary below.',
          'purchase_entries.qty and .rate are always stored in BASE units (grams, ml, single pieces), never in the purchase unit the user typed (cartons, packs, KG) — see the Purchases section for the exact conversion math. Every report that reads purchase_entries directly relies on this convention.',
          'A recipe tagged with category = "Sub-Recipe" automatically mirrors itself into the items table (is_sub_recipe = true) so it can be used as an ingredient in other recipes. These mirror rows are deliberately filtered out of Item Master, Purchases, Purchase Orders, Requisitions, Reorder Report, and Price Tracker (.eq(\'is_sub_recipe\', false)) — if a "missing" item is actually a sub-recipe, that\'s expected.',
          'Every quantity and rate box in Purchases and Stock Count accepts arithmetic, not just a plain number — "3*24+7" commits 79. Alt+C opens a standalone Quick Calculator over any page. Worth mentioning to anyone still counting stock with a phone calculator in the other hand, since re-typing a total is where transcription errors get in.',
        ],
        connections:
          'Everything downstream of Periods, Purchases, Stock Count, Sales Entry, and Recipe Costing — which is effectively the entire rest of this guide.',
      },
    ],
  },

  // ───────────────────────────── Operations ─────────────────────────────
  {
    key: 'operations',
    label: 'Operations',
    sections: [
      {
        id: 'dashboard',
        title: 'Dashboard',
        route: '/dashboard',
        plan: 'All plans (some tiles Growth/Pro-gated)',
        summary:
          'A single-screen KPI and chart snapshot of the client\'s currently open period — purchases, revenue, food cost %, variance, and reorder needs — with quick links into the deeper pages. Read-only; no data entry happens here.',
        workflow: [
          'Loads the client\'s open monthly_periods row automatically. If none exists, shows a banner linking to Periods.',
          'Renders two KPI rows, then four charts (Spend by Category, Daily Purchases vs Sales with a projected month-end trendline, Top Items by Spend, Food Cost % monthly trend).',
          'Below the charts: a Top Variance Items table and an Items to Reorder panel (both Growth+), each linking to their full report.',
          'If the open period\'s BS month has already passed, a banner offers a one-click "Close & Start Next" shortcut.',
        ],
        fields: [
          { label: 'Menu Health tile', desc: 'Count of recipes priced under their target_fc_pct, with an estimated monthly NPR opportunity if repriced to target — the same underlying calculation as Menu Repricing, just summarized to one number.' },
          { label: 'Fixed Costs % of Revenue / Est. Net Margin % (Pro)', desc: 'Pulls every overhead bucket (Fixed + Labor + Tax & Fees combined), unlike Recipe Costing\'s per-recipe allocation which uses only the Fixed Overheads bucket.' },
          { label: 'Projection dashed line', desc: 'Only appears on the current open BS month once ≥5 days of dated sales entries exist; a least-squares trendline extended to month-end, clamped to 1.25× the last 7 days\' actual peak so one wild day can\'t blow up the projection.' },
        ],
        formulas: [
          'Food Cost % = Net Purchases ÷ Revenue × 100 (green ≤35%, amber ≤45%, red >45%).',
          'Est. Net Margin % = (Revenue − Net Purchases − Overhead Total) ÷ Revenue × 100.',
          'Reorder shortfall = Par Qty − Current Stock, where Current Stock is the physical closing count if one exists, else max(0, Opening + Net Purchases − theoretical usage).',
        ],
        gotchas: [
          'Gated tiles (Variance, Recipe Costing, Menu Repricing, Reorder, Overheads) don\'t just hide the number on a lower plan — the underlying query is skipped entirely, so a Starter browser never even holds the Growth-tier figures in memory.',
          'The Dashboard\'s own "Close & Start Next" shortcut does NOT carry forward physical closing counts into next month\'s opening stock — only Periods\' own Close button does that. Always close periods from Periods, not this shortcut, if the physical count matters (it almost always does).',
        ],
        connections: 'Reads from Periods, Purchases, Sales Entry, Recipe Costing, Stock Count, and Overheads. Links out to all of them plus Variance Report and Reorder Report.',
      },
      {
        id: 'periods',
        title: 'Periods',
        route: '/periods',
        plan: 'All plans',
        summary:
          'Creates, edits, and closes/reopens the BS monthly periods that every other IMS page\'s data is scoped to. This is the first thing that must exist before anything else works.',
        workflow: [
          'Client view: a table of the client\'s own periods, newest first, with a + New Period button (pick BS Year + BS Month) and a Close & Start Next / Reopen action per row.',
          'Admin "all clients" view (no client selected): one row per property showing its currently open period, an EXPIRED flag if that month has passed, and inline Close & Start Next / End Period / Create / Edit actions.',
          'Closing a period: confirms, sets status=closed, creates next month\'s period as open, then carries the closed period\'s physical Closing Stock counts forward into the new period\'s Opening Stock.',
          '"End Period" (admin only, all-clients view) closes the current period without opening a new one — blocks further entry until someone creates the next period manually.',
        ],
        fields: [
          { label: 'BS Year / BS Month', desc: 'Nepali calendar, years 2070–2100 supported. Month 1 = Baisakh … 12 = Chaitra. Nepal\'s fiscal year runs Shrawan (month 4) through Ashadh (month 3 of the following BS year).' },
          { label: 'Show Archived', desc: 'Closed periods older than 12 months are hidden by default; toggle to reveal them.' },
          { label: 'Reopen', desc: 'Sets a closed period back to open. No carry-forward logic re-runs — opening stock for that period already exists from when it was first created.' },
        ],
        formulas: [
          'Carry-forward on close: for every item with a non-null physical_qty in the closed period\'s closing_stock, upsert opening_stock(new_period, item, qty = physical_qty). An item never counted contributes nothing — same as leaving it blank. This month\'s closing IS next month\'s opening; it is never recomputed or estimated.',
        ],
        gotchas: [
          'Two different unique-constraint errors can fire on Create: "already have an open period" (one_open_per_client) vs "a period for that exact month already exists" — the UI must distinguish which, since the fix is different.',
          'The app warns but does not hard-block having more than one open period at once for a client.',
        ],
        connections: 'Every other IMS page reads/writes against the period selected here. Closing here directly feeds Stock Count\'s Opening tab for the new period.',
      },
      {
        id: 'items',
        title: 'Item Master',
        route: '/items',
        plan: 'All plans',
        summary:
          'The master ingredient list — every purchasable/stockable item, its purchase rate, base unit of measure, optional bulk-purchase-unit conversion, and trim/yield loss %. Nearly everything else in the module (Purchases, Recipe Costing, Stock Count, Requisitions) draws from this list.',
        workflow: [
          'If no categories exist yet, a "Load Default Categories" button seeds 7 standard ones (Dairy & Bakery, Meats & Poultry, Groceries, Veg & Fruits, Beverage, Misc. Items).',
          'Add/Edit via a 2-tab modal: Details (name, category, Yield %, UOM, Purchase Qty, Rate, or an optional "Total (NPR)" field that back-solves Rate) and Conversion (Purchase Unit / Base Unit / Conversion Factor).',
          'List view: search, category tabs, a "Used In" usage-badge filter (Recipes/Purchases/Stock/Unused), and a "With Conversion" sort toggle.',
          'Delete is blocked with an explanation if the item is referenced anywhere across 8 tables — unless you\'re admin, in which case a force-delete option cascades the delete across all of them.',
          '"Hide"/"Show" toggles is_active instead of deleting — inactive items disappear from pickers but their history stays intact. Prefer this over delete in almost every real case.',
        ],
        fields: [
          { label: 'Yield %', desc: 'Usable percentage after trim/prep/cook loss (whole chicken ≈70%, spinach ≈60%, onion ≈85%). Default 100 = no loss. Factors into recipe costing (you must buy more than you serve) but NOT into nutrition (the diner eats exactly what\'s in the recipe).' },
          { label: 'Purchase Qty / Rate', desc: 'Stored so that Rate ÷ Purchase Qty = per-base-unit cost (per_uom_rate) — the generated field every downstream calculation actually reads.' },
          { label: 'Conversion (Purchase Unit / Base Unit / Conversion Factor)', desc: 'Set only when you buy in one unit (e.g. CTN) but track in another (e.g. BTL). All three fields are required together or not at all — a partial conversion is rejected at save.' },
          { label: '"Total (NPR)" field', desc: 'Type the total amount paid instead of a per-unit rate; Rate is back-computed as Total ÷ Purchase Qty.' },
          { label: 'Clear All Conversions (admin)', desc: 'Bulk-resets every item\'s conversion setup to none — an undo-everything button, use with care.' },
        ],
        formulas: [
          'per_uom_rate = rate ÷ purchase_qty — the field consumed everywhere (recipe costing, stock valuation, every report).',
          'Conversion preview: 1 {purchase_unit} = {conversion_factor} {base_unit}; per-base-unit cost = rate ÷ conversion_factor.',
        ],
        gotchas: [
          'Item names are always upper-cased on save.',
          'A category literally named "Sub-Recipes" is reserved and excluded from this page\'s category list — it\'s managed automatically by Recipe Costing\'s sub-recipe mirroring, not editable here.',
          'The "Used In" reference check is scoped to the client\'s own item IDs specifically because several referencing tables aren\'t directly client_id-scoped — an earlier unscoped version of this check was a real cross-tenant data leak risk for admins in "view as client" mode. Don\'t simplify this back to a raw client_id filter.',
        ],
        connections: 'Feeds Purchases (item picker + conversion math), Recipe Costing (ingredient cost/yield), Stock Count, Requisitions, Price Tracker, and every cost report. Sub-recipe mirror rows (is_sub_recipe=true) are created/maintained by Recipe Costing, not this page.',
      },
      {
        id: 'vendors',
        title: 'Vendors',
        route: '/vendors',
        plan: 'All plans',
        summary: 'The supplier directory used by Purchases, Purchase Orders, and Gate Passes.',
        workflow: [
          'Add/Edit via modal: Vendor Name (required), Contact Person, Phone, Address, PAN/VAT No.',
          'List with search (name or vendor code), Edit / Deactivate-Activate / Delete (admin-only).',
          'Prev/Next buttons in the edit modal let an admin walk the whole vendor list without closing/reopening it.',
        ],
        fields: [
          { label: 'Vendor Code', desc: 'Auto-generated ({prefix}-{3 digits}, prefix set in Settings → Vendor Codes, default VND), immutable once created — shown as a badge everywhere the vendor appears.' },
          { label: 'PAN/VAT No.', desc: 'The supplier\'s tax registration number — required for clean VAT Report reconciliation and IRD Annexure 13 disclosure (Purchase 1L+ Report). Free text, not validated.' },
        ],
        formulas: [],
        gotchas: [
          'Delete is hard-blocked (not even admin can force it) if the vendor has any purchase history — the only path for a vendor with history is Deactivate.',
        ],
        connections: 'Feeds the vendor picker in Purchases, Purchase Orders, Gate Passes; feeds Vendor Report, Outstanding Payables, Price Tracker.',
      },
      {
        id: 'purchases',
        title: 'Purchases',
        route: '/purchases',
        plan: 'All plans',
        summary:
          'The most important operational page in IMS: a daily log of multi-line vendor purchase bills and vendor returns for the selected period, plus a read-only Daily Register pivot. Nearly every cost report in the module ultimately traces back to data entered here.',
        workflow: [
          'Pick a period (defaults to open). "+ Add Purchase" opens a bill-entry modal mirroring a real vendor invoice: header (Vendor, Day, Invoice Ref, VAT toggle, Discount, Payment Method) + one row per item.',
          'All lines saved in one go share a purchase_group_id — this is what lets the list treat a multi-item bill as one editable/deletable unit.',
          'Saving a NEW bill auto-triggers a browser print of a purchase voucher (edits don\'t re-print).',
          'If an entered rate differs from the Item Master rate, a "Rate changes detected" prompt offers to sync the Item Master to the new rate — this affects future recipe costing, not retroactively.',
          'Returns tab: pick an existing purchase line, enter a return qty in the same unit — Rate, Vendor, and Payment Method are always inherited from the linked purchase, never independently set.',
          '"Delete All" (purchases or returns) requires typing the exact period label to confirm — deliberately higher friction than a single-bill delete.',
        ],
        fields: [
          { label: 'Qty / Rate storage convention', desc: 'purchase_entries.qty and .rate are ALWAYS stored in base units, never the purchase unit typed. On save: stored_qty = entered_qty × conversion_factor; stored_rate = entered_rate ÷ conversion_factor. Every downstream calculation (Stock, Variance, FIFO, Reorder) reads these base-unit values directly — see CLAUDE.md.' },
          { label: 'VAT toggle (per-line + bill-level 3-state)', desc: 'The entered Rate is always ex-VAT. Checking VAT adds 13% on top for display/total purposes only — the stored rate field itself stays ex-VAT.' },
          { label: 'Discount (NPR)', desc: 'A bill-level, pre-VAT discount spread proportionally across the taxable base before VAT is computed.' },
          { label: 'Total (NPR) per line', desc: 'Type a line total instead of a rate; Rate is reverse-computed as amount ÷ qty ÷ (1.13 if VAT else 1).' },
          { label: 'Shelf Life (days)', desc: 'Auto-computes Expiry Date from the bill\'s day + N days; changing the bill Day recomputes expiry for every line with a shelf-life set.' },
          { label: 'Arithmetic in Qty / Rate', desc: 'Both fields accept an expression as well as a plain number — "12*4" in Qty, or "450/12" to work a per-unit rate back out of a case price. The result previews above the field and commits on Enter or blur. The expression is evaluated before the base-unit conversion above, so what gets stored is still entered_qty × conversion_factor with the evaluated number as entered_qty. Same behaviour as Stock Count\'s qty boxes; Alt+C opens a standalone Quick Calculator anywhere in the app.' },
          { label: '⌗ button (modal header)', desc: 'The Add/Edit Purchase Bill modal has its own Quick Calculator button next to its close (×) button — the same calculator as Alt+C, opened without leaving the bill. Pressing Esc closes only the calculator, never the bill underneath.' },
        ],
        formulas: [
          'Bill totals: taxableBase = Σ(qty×rate) of VAT lines; nonTaxableBase = Σ(qty×rate) of non-VAT lines; subTotal = taxableBase + nonTaxableBase; vatTaxable = subTotal>0 ? taxableBase × (1 − discount/subTotal) : 0 (discount spread proportionally); vatTotal = vatTaxable × 0.13; grandTotal = subTotal − discount + vatTotal.',
          'Net Purchases (used everywhere) = Gross Purchases − Vendor Returns, both Σ(qty×rate) in base units.',
          'Return validation: enteredReturnQty (converted to base units) must be ≤ linkedPurchase.qty − qty already returned against that same purchase — prevents over-returning.',
        ],
        gotchas: [
          'Editing a bill inserts the new lines BEFORE deleting the old ones (not delete-then-insert) — a partial failure mid-save leaves the previous valid bill intact instead of an empty one.',
          'A vendor return is NOT a negative line in purchase_entries — it lives in a separate vendor_returns table that must be explicitly netted out anywhere purchases are totaled. Forgetting to subtract returns is the most common home-grown-report mistake.',
          'Closed periods are read-only for non-admins — no add/edit/delete.',
          'See the S416 fix (2026-07-19): the Qty field placeholder used to show the item\'s unit (e.g. "GM") in a way that could be mistaken for an entered value when the field was actually empty — fixed so the unit now shows as a persistent label instead of the placeholder text.',
        ],
        connections: 'Requires an existing period. Feeds Stock Count, Variance Report, VAT/Non-VAT Report, Vendor Report, Outstanding Payables, FIFO Report, Payment Summary, and (via the rate-sync prompt) Item Master.',
      },
      {
        id: 'gate-passes',
        title: 'Gate Passes',
        route: '/gate-passes',
        plan: 'All plans',
        summary: 'Issue and print a physical gate pass for a vendor/delivery vehicle entering the premises, and track when it exits.',
        workflow: [
          '"+ New Gate Pass": pick an existing Vendor or type a free-text company name, plus Driver Name, Vehicle Number, Purpose (Delivery/Pickup/Maintenance/Other), optional Notes.',
          'Saving auto-prints a gate-pass voucher and sets status = open.',
          '"Mark Exited" sets status = closed and records the exit time. "Reprint" re-prints and increments a print counter.',
          'Any pass still open from a previous calendar day is auto-swept to closed (flagged auto_closed) the next time the page loads — there is no server-side cron for this.',
        ],
        fields: [
          { label: 'Auto-Closed badge', desc: 'Visually distinct (gray) from a real staff-confirmed Closed (green) — it means the vehicle\'s actual exit time was never verified by staff, which matters for security review.' },
        ],
        formulas: [],
        gotchas: [
          'No role gate beyond basic IMS module access — any Owner/Admin who can reach the page can issue a pass (unlike POS\'s staff/supervisor split).',
        ],
        connections: 'Vendor picker reads active Vendors. Otherwise self-contained — doesn\'t feed cost or stock calculations anywhere.',
      },
      {
        id: 'sales-entry',
        title: 'Sales Entry',
        route: '/sales',
        plan: 'Starter+',
        summary:
          'Records how many portions of each recipe sold in the period — the revenue side of Food Cost % and the demand driver behind every variance calculation.',
        workflow: [
          'POS-enabled clients: Bulk Entry and Daily Entry are DISABLED (locked, with a tooltip). Manual sales entry exists for IMS clients who do not run POS; where both modules are on, POS is the source of truth and supersedes manual entry. The two read-only tabs stay available. Admin is exempt.',
          'Bulk Entry tab: one input per recipe for the whole period\'s total qty (stored as bs_day = 0).',
          'Daily Entry tab: pick a specific BS day, enter qty per recipe for just that day (bs_day > 0).',
          'Daily Breakdown tab: read-only Item × Day pivot with totals.',
          'Period Summary tab: read-only ranked list — Total Sold, Selling Price, Total Revenue, % of Revenue.',
        ],
        fields: [
          { label: 'unit_price / vat_rate (snapshotted)', desc: 'Captured from the recipe\'s current selling_price/vat_rate at the moment the sale is saved — deliberately, so a later menu price change never retroactively distorts past periods\' revenue/FC% history. Reports prefer the row\'s own unit_price over the recipe\'s live price whenever it\'s present.' },
        ],
        formulas: [
          'Period Revenue = Sum over EVERY row of the period (bulk + daily) of qty_sold x unit_price - discount, where unit_price is the price-at-entry snapshot on the row and the recipe current selling_price is only a fallback for rows written before that snapshot existed. Until 2026-07-27 this page priced everything at the current selling_price, so editing a menu price restated the whole period retroactively — the exact thing the snapshot exists to prevent, and a reason this total disagreed with the dashboard Sales Breakdown tile.',
          'The three stat cards at the top (Total Covers / Items with Sales / Period Revenue) read the same all-rows totals as the Period Summary tab. They used to read the BULK-only map (loaded with bs_day = 0), so a client entering sales daily saw them read near zero while the Period Summary tab below showed the real figure.',
          '% of Revenue (per item) = itemRevenue ÷ totalRevenue × 100.',
        ],
        gotchas: [
          'Bulk and Daily entry are mutually exclusive per recipe by application logic only — the DB constraint (period, recipe, bs_day) treats bulk (bs_day=0) and daily (bs_day>0) rows as different keys, so nothing at the DB level stops both existing for the same recipe simultaneously, which would double-count revenue everywhere. The app enforces this itself: saving a Daily entry deletes that recipe\'s bulk row and vice versa — never bypass this by writing to sales_entries directly.',
          'save_sales_day() scopes every one of its deletes to source=manual. Until 2026-07-27 it did not, so on a POS client one Save Day wiped the POS bill rows for that day, and one Bulk save wiped a whole month of them for every recipe in the payload — comp and credit-note rows were deleted with nothing re-inserted, since neither is ever part of the payload this page builds. Fixed in both the RPC and the legacy JS fallback; the disabled entry tabs above are the product-level half of the same fix.',
          'Comps (source=\'pos_comp\', written automatically by POS) are excluded from every read here — manual entries from this page are never comps by construction.',
          'Sub-recipes never appear on any tab — you record sales of finished dishes only.',
        ],
        connections: 'Reads Recipe Costing\'s recipe list. Feeds Dashboard, Overheads, Variance Report, Menu Engineering, and every finance/menu report that touches revenue.',
      },
      {
        id: 'purchase-orders',
        title: 'Purchase Orders',
        route: '/purchase-orders',
        plan: 'Growth+',
        summary: 'A formal PO-to-vendor workflow — draft, send, receive goods (which auto-creates real purchase entries), and track partial fulfillment.',
        workflow: [
          '"+ New PO": Vendor, Period, optional Expected Delivery + Notes, then line items (Item, Qty, Unit Price auto-filled from Item Master). Saves as draft.',
          '"Mark Sent" is informational only — doesn\'t block receiving.',
          '"Receive" (Goods Receipt Note): shows Ordered/Received/Remaining per line, an editable Receiving Now qty (capped at Remaining), a shared BS Day, Payment Method (defaults to Credit), and a VAT-Incl. checkbox.',
          '"Confirm Receipt": for every line with a receiving qty > 0, inserts a real purchase_entries row and updates qty_received. Status auto-advances to partial or received.',
          '"Cancel" (draft/sent/partial only) creates no purchase entries. Delete (admin only) removes the PO but does NOT touch any purchase entries already created from a prior receive.',
        ],
        fields: [
          { label: 'PO Number', desc: 'Auto-generated PO-{3 digits} from the current max, with a 3-attempt retry against a unique-constraint collision (two tabs open, fast double-click).' },
          { label: 'Unit Price on the PO', desc: 'A pre-agreed price carried straight through to the resulting purchase entry — it does not re-check against the item\'s live Item Master rate at receive time.' },
        ],
        formulas: [
          'PO Total = Σ(qty_ordered × unit_price).',
          'Remaining = max(0, qty_ordered − qty_received).',
        ],
        gotchas: [
          'Over-receiving (typing more than Remaining) is rejected server-side, not just capped by the input\'s HTML max attribute — a typo of 100 instead of 10 can\'t silently inflate qty_received past qty_ordered.',
          'If the qty_received update fails partway through a multi-line receive after entries were already inserted, the error explicitly warns to reload the PO before receiving again — otherwise the same delivery could be double-booked.',
          'Editing is only allowed while a PO is still draft.',
        ],
        connections: 'Requires Vendors and Items. Confirmed receipts write directly into purchase_entries — the same table Purchases reads — so received goods show up everywhere a manual purchase would.',
      },
      {
        id: 'stock-count',
        title: 'Stock Count',
        route: '/stock',
        plan: 'All plans',
        summary:
          'The physical inventory workflow: opening stock, month-end physical closing count, wastage (a monthly catch-all plus a dated/reasoned daily log), staff meals, and the Summary/Print Sheet views that tie it all together. This is where the real, physically-counted numbers that everything else compares against come from.',
        workflow: [
          'Opening Stock: per-item qty at start of month — manual only for a client\'s very first-ever period; every period after that is auto-carried-forward from the prior period\'s closing count when that period is closed. A "↩ Pull from last month" button on this tab re-runs that same carry-forward on demand, for when the automatic one had nothing to copy (see gotchas).',
          'Closing Stock: the physical count taken at month-end, entered per item.',
          'Wastage tab: a single quick monthly total per item, no reason/day. Daily Wastage tab: dated, reason-tagged log (Spoilage/Expiry/Over-prep/Breakage/Spillage/Customer return/Other) — both roll into the same period total.',
          'Staff Meals tab (feature-gated): staff/complimentary consumption, tracked separately from wastage.',
          'Summary tab: full per-category and per-item picture in both qty and NPR value. Print Sheet: a blank physical-count sheet grouped by category, showing a System Ref Qty hint (not the answer) and starring (★) high-value/fast-moving items to count first.',
          'Every field auto-saves on blur; "Save All" forces a save of every visible row; "Clear All" zeroes them.',
          'Every quantity box accepts arithmetic as well as a plain number — typing "3*24+7" (3 cartons of 24, plus 7 loose) commits 79. The running result previews above the box while typing; Enter or clicking away applies it, Esc cancels.',
        ],
        fields: [
          { label: 'System Ref Qty', desc: 'Opening + Purchases − Returns. An estimate/reference for the counter, not the correct answer — real physical counts should and will differ due to actual usage and shrinkage.' },
          { label: '↩ Pull from last month', desc: 'Opening Stock tab only. Finds the chronologically-previous BS period, reads its counted closing_stock.physical_qty, and upserts those into this period\'s opening_stock — the same "closing IS next opening" rule the period-close path uses, but re-runnable at any time. Confirms before overwriting, only carries items actually counted (qty > 0), and needs to be online. Disabled on a locked period.' },
          { label: 'Arithmetic in qty fields', desc: 'Supports + − × ÷ and brackets, e.g. "(12+8)*2.5". Commas are ignored so "1,200/16" works. An incomplete expression ("3*", "2+(4") reverts to the previous value rather than saving a partial reading of it. Also available on the Purchase Bill qty and rate fields, and as a standalone Quick Calculator on Alt+C from anywhere in the app.' },
          { label: '★ High-value flag', desc: 'An item is starred if its stock value is in the top 25% by value AND it was purchased ≥3 times this period — the fast-moving, high-value combination where a counting error costs the most.' },
          { label: 'Requisitioned column', desc: 'Total qty issued via issued-status Requisitions for the period — shown for cross-checking against Used, but is NOT itself part of the Used/COGS formula.' },
        ],
        formulas: [
          'Used (per item) = Opening + Net Purchases − Closing − Wastage (catch-all + daily) − Staff Meals.',
          'Stock Value = System Ref Qty × per_uom_rate. Category/item COGS = Used × per_uom_rate, summed per category.',
        ],
        gotchas: [
          'Wastage/staff-meal saves are delete-then-insert (two round trips), unlike opening/closing\'s atomic upsert — a per-cell save lock serializes concurrent autosave-vs-Save-All/Clear-All so the delete/insert pairs can never interleave into duplicate, double-counted rows.',
          'A closing_stock row can exist with a NULL physical_qty (an aborted save) — always treat this as 0, never NaN, or the item silently drops out of Reorder/Variance math.',
          'The Summary tab\'s header text for the COGS formula omits "− Returns," but the actual calculation does subtract returns — the label is slightly out of sync with the real math; trust the formula above, not the on-screen wording.',
          'Offline mode queues edits locally and replays them on reconnect — a "N pending" badge shows queued writes that haven\'t synced yet.',
          'The automatic carry-forward is a one-time snapshot taken at the instant the period is closed — it is not a live link. If the closing count was not fully saved at that moment (the common real-world case: the month gets closed first and physically counted afterwards), the new period\'s Opening Stock is left blank and nothing re-triggers it on its own. This is the single most likely cause of a "my opening stock is empty even though I counted last month" report; the fix is the "↩ Pull from last month" button on the Opening Stock tab, which is safe to run at any point.',
          'Only items with a counted closing quantity carry forward. An item with no closing_stock row is not carried at all — identical to never having entered it manually, not a zero.',
        ],
        connections: 'Feeds Variance Report, Dashboard\'s Reorder/Variance panels, Wastage Report, Stock Report, Reorder Report, Dead Stock, and Periods\' carry-forward logic when the period closes.',
      },
      {
        id: 'requisitions',
        title: 'Requisitions',
        route: '/requisitions',
        plan: 'Growth+',
        summary: 'Internal store-to-department stock transfer slips (e.g. Main Store → Kitchen/Bar), tracked draft → issued.',
        workflow: [
          '"+ New Requisition": Day, Department (fixed list — Kitchen, Bar, Pastry/Bakery, Banquet/Events, Room Service, Café, Staff Cafeteria, Housekeeping, and more), Notes, and line items (Item, Qty Requested, Qty Issued).',
          'Save as Draft (qty_issued = whatever\'s typed, possibly 0) or Save & Issue (qty_issued defaults to qty_requested if left blank).',
          'From a draft\'s detail view, "Issue" opens an editable Confirm Issue Quantities table (adjust down if issuing less than requested), then Confirm Issue finalizes it.',
          'Before issuing, the app estimates on-hand stock per item and warns — non-blocking — if a line would issue more than what\'s estimated on hand.',
        ],
        fields: [
          { label: 'Qty Issued vs Qty Requested', desc: 'Requested is what the department asked for; Issued is what the store actually gave — can be less. Never validated as ≤ requested at the DB level, only nudged by the shortfall warning.' },
        ],
        formulas: [
          'Estimated On-Hand = the same theoretical-stock formula Stock Report uses: Opening + Net Purchases − recipe-driven usage − Wastage − Staff Meals − already-issued Requisitions, clamped to a physical closing count when one exists.',
        ],
        gotchas: [
          'The stock-shortfall check is a soft warning only, never a hard block — this module\'s stock model is periodic/physical-count based, so "on hand" is always an estimate between counts.',
          'Draft → Issued is one-way in the UI — there is no "un-issue."',
        ],
        connections: 'Reads the same tables as Stock Report\'s on-hand estimate. Writes requisition_lines, which Stock Count\'s Summary tab reads back as the Requisitioned cross-check column.',
      },
    ],
  },

  // ───────────────────────────── Costing ─────────────────────────────
  {
    key: 'costing',
    label: 'Costing',
    sections: [
      {
        id: 'recipes',
        title: 'Recipe Costing',
        route: '/recipes',
        plan: 'Growth+',
        summary:
          'Builds and costs every recipe (dishes and reusable sub-recipes/batches) from Item Master ingredients, sets a target food-cost %, and shows true cost including allocated overhead and nutrition facts. The recursive ingredient-cost engine here (src/utils/recipeCost.js) is shared by Menu Pricing, Menu Engineering, Best Sellers, Recipe Margin, and Menu Repricing — a change here ripples everywhere.',
        workflow: [
          '"+ New Recipe": Name, Category (a normal category, or the special "Sub-Recipe" category), Selling Price (ex-VAT), VAT Rate, Yield Qty + Yield UOM, Target FC %, optional Description/Image/Veg-NonVeg for the guest QR menu.',
          'Ingredient rows are each either an Item or another recipe tagged Sub-Recipe. A sub-recipe can\'t directly list itself; indirect cycles are checked at save time and rejected.',
          'A live cost/FC%/suggested-price preview updates as ingredients are typed, before saving.',
          'Saving a recipe with category = "Sub-Recipe" auto-creates/updates a mirror row in items (is_sub_recipe=true) so it can be referenced as an ingredient elsewhere. Changing a recipe away from "Sub-Recipe" deactivates and unlinks its mirror item.',
          'Nutrition auto-fill: a one-click bulk match against a local regional library (DFTQC Nepal / IFCT 2017 / USDA seed data); a separate, explicit live USDA FoodData Central lookup is available only for ingredients the local library couldn\'t match.',
        ],
        fields: [
          { label: 'Target FC %', desc: 'Per-recipe target food cost percentage (default 30) — drives the Suggested Price figure and Menu Repricing/Dashboard\'s "underpriced" flagging.' },
          { label: 'Yield Qty / Yield UOM', desc: 'For a normal dish, almost always "1 portion." For a sub-recipe, this is the batch size the ingredient list produces (e.g. a sauce recipe yields "5000 GM") — cost per unit divides the batch cost by this yield.' },
          { label: 'VAT Rate', desc: 'Stored as a fraction (0.13 = 13%). 0 is a valid, distinct value from "unset" — the app explicitly guards against treating an intentional 0% as falsy and silently defaulting back to 13%.' },
        ],
        formulas: [
          'Ingredient cost = (qty_per_portion ÷ (yield_pct/100)) × item.per_uom_rate.',
          'Sub-recipe cost per unit = Σ(its own ingredient costs) ÷ yield_qty — computed recursively.',
          'Recipe total cost (1 portion) = Σ over all ingredients, whether items or nested sub-recipes.',
          'Food Cost % = cost ÷ selling_price × 100.',
          'Suggested Price = ceil((cost ÷ target FC fraction) × (1 + VAT rate) ÷ 5) × 5 — rounds UP to the nearest NPR 5, retail-friendly.',
          'True Cost with Overheads (when the period has both overhead entries and sales revenue): overhead per portion = (Fixed Overheads bucket only × this recipe\'s revenue share of the period) ÷ covers sold; True Cost = ingredient cost + overhead per portion.',
        ],
        gotchas: [
          'Overhead allocation uses ONLY the Fixed Overheads bucket from Overheads.js — Labor and Tax & Fees stay period-level and are never distributed to individual recipes.',
          'If an ingredient row references a sub-recipe that has since been deleted, its cost silently contributes 0 with no warning — this is exactly why deleting a sub-recipe currently used elsewhere is blocked at the UI level.',
          'Cyclic sub-recipe references are defensively guarded in the cost/nutrition recursion (a cycle costs as 0 for the re-entering ingredient rather than crashing), but a cycle shouldn\'t be reachable in the first place given the save-time check.',
          'Nutrition math does NOT divide by yield %, unlike cost math — the diner eats exactly what\'s in the recipe; only cost accounts for trim/prep loss.',
        ],
        connections: 'Feeds Sales Entry\'s recipe list, Menu Pricing, Menu Engineering, Menu Repricing, Best Sellers, Recipe Margin, Dashboard\'s Menu Health, Overheads\' allocation panel, and Requisitions\' on-hand estimate.',
      },
      {
        id: 'menu-pricing',
        title: 'Menu Pricing',
        route: '/menu-pricing',
        plan: 'Starter+',
        summary:
          'A fast, spreadsheet-style price-editing surface for every sellable recipe, plus the POS on/off toggle and "Pair With" cross-sell suggestions. Renders two genuinely different branches depending on whether the client has the IMS module at all.',
        workflow: [
          'POS-only clients (no IMS): no Item Master exists, so this page is the only place to create a menu item at all — columns are On POS toggle, Item, a manually-entered Cost Price (used only to value comps), and Price (VAT-inclusive).',
          'IMS clients: full food-cost table — Food Cost is computed from real ingredients (same recursive engine as Recipe Costing), plus Current Price, FC % (color-coded), a New Price (incl. VAT) input, live New FC % preview, and NPR Change. A "↻ Refresh Costs" button recomputes every recipe\'s cost from current Item Master rates.',
          'Both branches: type a new VAT-inclusive price and press Enter to save; toggle On POS to control order-screen visibility (also how staff "86" an item that\'s run out); click Pair to save cross-sell suggestions shown on the POS order screen.',
        ],
        fields: [
          { label: 'On POS toggle', desc: 'Controls recipes.pos_enabled — whether the item appears on the POS order screen, and the mechanism staff use to temporarily disable a sold-out item.' },
        ],
        formulas: [
          'IMS branch: FC% = ingredientCost ÷ exVatPrice × 100. On save: new ex-VAT price = typed incl-VAT price ÷ (1 + vat_rate), written to the same recipes.selling_price field Recipe Costing displays.',
        ],
        gotchas: [
          'The two branches (POS-only vs IMS) share most of their UI but are genuinely different code paths — worth confirming which branch you\'re looking at before troubleshooting a client\'s report, per the project\'s standing "always ask which branch" convention.',
          'In the IMS branch, the manually-entered Cost Price is only used as a fallback when a recipe has literally zero costed ingredients — the moment any ingredient is added in Recipe Costing, the manual cost_price is ignored in favor of real ingredient math.',
        ],
        connections: 'Reads/writes the same recipes/recipe_ingredients tables as Recipe Costing. Feeds the POS order screen and every revenue-based report.',
      },
      {
        id: 'menu-engineering',
        title: 'Menu Engineering',
        route: '/menu-engineering',
        plan: 'Pro',
        summary:
          'Classic profitability-×-popularity matrix — classifies every sold recipe into one of four quadrants to guide menu decisions (promote, reprice, cut).',
        workflow: [
          'Select a period. Loads recipes (excluding sub-recipes/inactive), computes ingredient cost, and pulls sales qty for the period.',
          'Classifies every recipe into a quadrant and writes the result back to recipes.me_class in the background — this field is also read live by the POS suggestion engine, so this page\'s classification has an effect beyond its own display.',
          'Three views: Table (sortable list), Matrix (4 grouped panels), Charts (scatter + top-10 bar + category pivot).',
          'Quadrant summary cards act as click-to-filter toggles.',
        ],
        fields: [
          { label: 'Quadrant names', desc: 'Star, Plowhorse, Puzzle, Dog. Note this app\'s Plowhorse/Puzzle definitions are swapped from the traditional restaurant-menu-engineering meaning of those two words: here Plowhorse means high profit / low popularity (the industry\'s usual "Puzzle") and Puzzle means low profit / high popularity (the industry\'s usual "Plowhorse") — worth knowing so it doesn\'t read as backwards when training someone.' },
        ],
        formulas: [
          'FC% (per recipe) = ingredientCost ÷ sellingPrice × 100 (0 if unpriced).',
          'medianQty = median qty sold across all active recipes this period.',
          'Star = FC% ≤35 AND qty ≥ median. Plowhorse = FC% ≤35 AND qty < median. Puzzle = FC% >35 AND qty ≥ median. Dog = FC% >35 AND qty < median.',
        ],
        gotchas: [
          'A recipe with zero sales this period is automatically Dog or Plowhorse (never counts as "high popularity" by definition) — a brand-new or seasonal item will always land in the low-popularity half regardless of how healthy its food cost is.',
          'Because the popularity cutoff is the median qty sold THIS period, quadrant assignments are not stable month to month — always read them as "as of this period\'s sales," not a permanent label.',
        ],
        connections: 'Reads Recipe Costing and Sales Entry data. Writes recipes.me_class, which the POS module\'s suggestion engine reads.',
      },
      {
        id: 'overheads',
        title: 'Overheads',
        route: '/overheads',
        plan: 'Pro',
        summary:
          'Enter the period\'s fixed costs across three buckets (Fixed Overheads, Labor, Tax & Fees), see a true P&L against revenue, and get a break-even calculation.',
        workflow: [
          'Select a period. Three bucket tabs: Fixed Overheads (target 25% of revenue — Rent, Utilities, Tech, Marketing, Insurance, Misc.), Labor Costs (target 30% — Manager/Chef, Kitchen, Service, Part-time, Benefits), Tax & Fees (target 5% — VAT Compliance, Card Processing, Bank Charges, License, Accountant).',
          'Each bucket is a free-form table: Category (preset dropdown + "Custom…"), Description, Amount, with a live % of Bucket column.',
          'Save deletes and reinserts every non-empty row across all 3 buckets for the period in one shot — there is no per-row incremental save.',
          'Below the entry card: P&L Summary (traffic-light target-vs-actual for Food/Labor/Overhead/Tax/Net Profit), a Cost Visualisation stacked bar, a cross-bucket "All Cost Lines Ranked by Spend" table, and Break-Even + Cost-per-Cover panels — all four only render once the period has sales revenue.',
        ],
        fields: [
          { label: 'Daily Fixed Cost', desc: 'Divides by the actual number of days in that specific BS month (28–32, never a flat 30) — a flat /30 would misstate daily burn by up to ~7%.' },
        ],
        formulas: [
          'Food Cost here (Purchase-Based) = Gross Purchases − Vendor Returns for the whole period — NOT the Stock Count "Used"/COGS figure. This is the single biggest source of "why don\'t these two food-cost numbers agree" confusion; Monthly Summary uses the full opening+purchase−closing−wastage COGS formula instead. Always clarify which "food cost" a client means.',
          'Net Profit = Revenue − Purchase-Based Food Cost − Total Fixed Costs (only computed once revenue > 0).',
          'Break-even revenue = Total Fixed ÷ (1 − Food Cost %); Break-even covers = Break-even Revenue ÷ Average Ticket.',
          'Cost per Cover (Fixed OH, Labor, Tax & Fees, Total) = each bucket\'s total ÷ covers sold.',
        ],
        gotchas: [
          'Break-even is explicitly undefined when purchase-based Food Cost % is ≥100% of revenue (shown as "✗ Purchase cost exceeds revenue").',
          'Only the Fixed Overheads bucket feeds Recipe Costing\'s per-recipe True Cost panel — Labor and Tax & Fees never get distributed per-portion.',
          'Save has no per-row granularity and no "unsaved changes" warning beyond an internal flag — navigating away mid-edit loses unsaved rows.',
        ],
        connections: 'Reads Purchases, Vendor Returns, Sales Entry, Recipe Costing (for revenue). Feeds Recipe Costing\'s overhead-allocation panel and Dashboard\'s Fixed Costs %/Net Margin % KPIs (which sum all 3 buckets, unlike Recipe Costing\'s Fixed-only allocation).',
      },
      {
        id: 'fixed-assets',
        title: 'Fixed Assets',
        route: '/fixed-assets',
        plan: 'Pro',
        summary:
          'Tracks equipment, furniture, vehicles, and kitchen machinery from purchase to disposal — book (straight-line) depreciation for internal accounts, plus a genuinely separate Nepal statutory pooled-WDV tax depreciation basis (Income Tax Act 2058) for annual IRD filing. Viewing is supervisor+, posting a depreciation/tax run is manager+ only.',
        workflow: [
          'Manage Categories seeds a default useful life and a Nepal tax pool hint per category (e.g. "Kitchen Equipment" → Pool D) — every new asset in that category auto-fills both, still freely editable per asset.',
          '+ Add Asset: name, quantity, unit cost, acquisition date, useful life, salvage value, and Tax Pool (A-E or untracked). asset_code is auto-numbered (AST-0001…).',
          'Depreciation Runs tab: pick a period, Preview (computes but writes nothing), optionally override a line\'s depreciation amount (requires a reason), then Post — this freezes the period\'s schedule rows permanently at the database level; a correction is a brand new run, never an edit to an old one.',
          'Valuation Report: portfolio Net Book Value as of any posted period, by category. Disposal Report: every disposed/written-off asset with its gain or loss. Both print with the standard "Generated by Crest Suite" footer.',
          'Tax Depreciation (IRD) tab: pick a BS fiscal year, log any repair/maintenance expenses against a pool, Preview the 5-pool pooled-WDV schedule, then Post — same one-way freeze as the book depreciation runs. Written in plain language with F&B examples (e.g. Pool D\'s tooltip lists ovens/fridges/dishwashers) since most users here are café/restaurant owners, not accountants.',
        ],
        fields: [
          { label: 'Tax Pool (A-E)', desc: 'Nepal groups assets into 5 statutory pools instead of depreciating each item separately — A: buildings you own, B: furniture/computers/office equipment, C: vehicles, D: kitchen equipment & everything else (the catch-all most gear lands in), E: intangibles (software, franchise rights). Optional — "untracked" is fine if a client only cares about book depreciation.' },
          { label: 'Salvage Value', desc: 'Estimated value at the end of an asset\'s useful life. Book depreciation never brings NBV below this floor — once reached, further runs post 0 rather than going negative.' },
          { label: 'Override + Reason (Depreciation Runs)', desc: 'A manager can override a computed line (e.g. for impairment) but only with a typed reason — enforced both in the UI (blocks Post) and as a DB CHECK constraint on the posted row.' },
          { label: 'Repair/Maintenance cap (Tax Depreciation tab)', desc: 'Nepal tax law caps deductible repair expense at 5% of a pool\'s closing depreciation base for the year — spend more and the excess isn\'t lost, it rolls into next year\'s opening base instead of being expensed this year.' },
        ],
        formulas: [
          'Book depreciation (straight-line): annual amount = (Total Cost − Salvage Value) ÷ Useful Life Years, pro-rated by days for a partial period and clamped so NBV never drops below Salvage Value.',
          'Tax pool depreciation (declining-balance): each pool\'s own statutory rate (A 5%, B 25%, C 20%, D 15%) applied to a shrinking pool balance, not per-asset — an asset acquired in the first third of the BS fiscal year gets the full rate in year one, the middle third gets 2/3, the last third gets 1/3. Pool E (intangibles) is straight-line instead: cost ÷ useful life, rounded to the nearest half-year.',
          'Disposal gain/loss = Disposal Proceeds − NBV at Disposal (book side only — Nepal tax pooling just reduces the pool balance by the proceeds, with no separate per-asset gain/loss).',
        ],
        gotchas: [
          'Book depreciation and Nepal tax depreciation are expected to disagree with each other — different methods (straight-line per-asset vs. declining-balance pooled), different starting rules. That is normal, not a bug; the Tax Depreciation tab carries its own on-screen disclaimer to verify current rates with an accountant before filing, since Nepal\'s Finance Act amends these periodically.',
          'Once a depreciation run or tax pool run is Posted, its schedule rows are immutable at the database level — there is no Reopen. Fixing a mistake means posting a new adjustment run for the same period, not editing the old one.',
          'Preview never writes anything — only Post does. Safe to Preview repeatedly while checking numbers.',
          'Only admin can permanently delete an asset (and its posted depreciation history) — a real, server-enforced action, not just a hidden UI button; no client-side login, including Owner, can do this.',
        ],
        connections: 'Reads Item Master-style category defaults it manages itself (assets_categories, separate from Item Master\'s own categories). Self-contained — doesn\'t feed or read from Purchases/Stock Count/Recipe Costing.',
      },
    ],
  },

  // ───────────────────────────── Summary Reports ─────────────────────────────
  {
    key: 'reports-summary',
    label: 'Summary Reports',
    sections: [
      {
        id: 'monthly-summary',
        title: 'Monthly Summary',
        route: '/summary',
        plan: 'Starter+',
        summary: 'The core monthly P&L-style food-cost report for a single selected BS period — stock valuation, COGS, and Food Cost % overall and per category.',
        workflow: [
          'Auto-selects the open period; switch via dropdown. Print or view the Category Breakdown table (Opening, Gross Purchases, Returns, Net Purchases, Wastage, Staff Meals, Closing, COGS, % of Total COGS).',
          'Items with no category are grouped into a synthetic "Uncategorized" row rather than being dropped from totals.',
        ],
        fields: [],
        formulas: [
          'COGS (per category, summed to total) = Opening + Net Purchases − Wastage − Staff Meals − Closing.',
          'Food Cost % = COGS ÷ Net Sales Revenue × 100 (green ≤35%, amber 36–45%, red >45%; stated target band 28–35%).',
          'Purchase-Based FC% = Net Purchases ÷ Revenue × 100 — a simpler proxy ignoring opening/closing stock, useful when physical counts are missing.',
        ],
        gotchas: [
          'A category is only included if it had ANY activity — a category with only wastage/staff-meal entries and no purchase/opening/closing used to be dropped entirely from totals; now correctly counted.',
          'Compare this page\'s FC% color bands (35/45) against Period Comparison\'s (30/38) — they differ, so the same period can show as "amber" on one report and "red" on another. Not a bug, just inconsistent thresholds worth knowing about.',
        ],
        connections: 'Shares its exact COGS formula with Annual Summary (yearly rollup) and Period Comparison (multi-period trend).',
      },
      {
        id: 'annual-summary',
        title: 'Annual Summary',
        route: '/annual-summary',
        plan: 'Starter+',
        summary: 'Rolls up Monthly Summary\'s math across an entire year — either BS Calendar Year or Nepali Fiscal Year (Shrawan → Ashadh).',
        workflow: [
          'Toggle Calendar Year vs Fiscal Year, pick a year (auto-populated from periods that exist). One row per month, total row at the bottom. Print or Export Excel.',
        ],
        fields: [],
        formulas: [
          'Per month: COGS = Opening + Net Purchases − Wastage − Closing (note: unlike Monthly Summary, this version does NOT subtract Staff Meals — a subtle inconsistency between the two reports worth flagging if numbers are compared side by side).',
          'Annual FC% = totalCOGS ÷ totalRevenue × 100 — summed then divided, explicitly NOT an average of each month\'s FC% (more accurate, since it weights by each month\'s actual size).',
        ],
        gotchas: [
          'Fiscal year bucketing: getFiscalYear = bs_month ≥ 4 ? bs_year : bs_year − 1.',
        ],
        connections: 'Same source tables as Monthly Summary, queried across many periods at once.',
      },
      {
        id: 'period-comparison',
        title: 'Period Comparison',
        route: '/period-comparison',
        plan: 'Pro',
        summary: 'A trend table comparing Net Purchases, Wastage, COGS, Revenue, and FC% across the last N periods (any mix of months, not tied to one calendar/fiscal year).',
        workflow: [
          'Choose Last 6/12/24 periods or All. Table sorted newest-first with a "vs Prev" trend arrow against the next-older row. Stat cards: Latest FC% (+ trend), Best FC% Period, Latest Revenue.',
        ],
        fields: [],
        formulas: [
          'Same COGS formula as Monthly/Annual Summary (again without Staff Meals subtracted). Color bands here: green ≤30%, amber 31–38%, red >38% — different thresholds than Monthly Summary\'s 35/45.',
          'Trend arrow treats differences under 0.3 percentage points as flat/neutral.',
        ],
        gotchas: [
          'Revenue excludes rows with neither a snapshotted unit_price nor a joined current selling_price.',
        ],
        connections: 'Same source tables as Monthly/Annual Summary — the "at a glance trend" companion to Monthly Summary\'s single-period deep-dive.',
      },
      {
        id: 'budget-vs-actual',
        title: 'Budget vs Actual',
        route: '/budget',
        plan: 'Growth+',
        summary: 'Lets an admin set a per-category NPR spend budget for a period and compares it against actual net purchases.',
        workflow: [
          'Select period. Type a budget amount per category directly into the table — auto-saves on blur (no explicit Save button).',
        ],
        fields: [
          { label: 'Status badge', desc: 'No Budget (grey, budget=0) / Over Budget (red) / Under Budget (green).' },
        ],
        formulas: [
          'Actual Net (per category) = Σ(purchases.qty×rate) − Σ(returns.qty×rate) for items in that category.',
          'Variance = Budget − Actual (positive = under budget). Variance % = Variance ÷ Budget × 100.',
        ],
        gotchas: [
          'This is purchasing spend only, not full COGS — it does not account for opening/closing stock or wastage the way Monthly Summary does.',
          'No explicit save button, only blur — a user who navigates away mid-typing without blurring could lose that edit.',
        ],
        connections: 'Reads the same purchase_entries/vendor_returns tables as Monthly Summary, but per-category purchase-only.',
      },
    ],
  },

  // ───────────────────────────── Stock Reports ─────────────────────────────
  {
    key: 'reports-stock',
    label: 'Stock Reports',
    sections: [
      {
        id: 'stock-report',
        title: 'Stock Report',
        route: '/stock-report',
        plan: 'Starter+',
        summary: 'Current on-hand quantity and NPR valuation per item for a selected period, with low/out-of-stock flags.',
        workflow: [
          'Select period. Filter by category/status (All/Low/Out/OK). Each row shows a Source badge: Physical (a real closing count exists) vs Theor. (calculated, less reliable).',
        ],
        fields: [],
        formulas: [
          'Theoretical on-hand = max(0, Opening + Net Purchases − recipe-driven Usage − Wastage − Staff Meals − issued Requisitions).',
          'On-hand = physical closing count if one exists, else the theoretical figure above. Stock Value = On-hand × per_uom_rate.',
          'Status: Out if on-hand ≤0; Low if par>0 and on-hand ≤ par; else OK.',
        ],
        gotchas: [
          'A negative theoretical result (usage/wastage exceeds recorded purchases+opening — usually a data-entry problem) triggers a warning banner and is clamped to 0 for display, with a ⚠ marker on the affected rows.',
          'Requisitioned qty (issued status only) is subtracted from theoretical on-hand here — a subtlety not present in every other stock page.',
        ],
        connections: 'Feeds Reorder Report conceptually. Shares usage-explosion logic with Variance and FIFO Report. Is the "current state" companion to Stock Movements (the transactional ledger behind POS-driven depletions).',
      },
      {
        id: 'reorder-report',
        title: 'Reorder Report',
        route: '/reorder',
        plan: 'Starter+',
        summary: 'Auto-generates a purchase shopping list of items at/below their par level, with inline par-level editing.',
        workflow: [
          'Select period (default filter: Reorder Only). Click a Par Level cell to edit inline (Enter=save, Escape=cancel). Search/filter by category.',
          '"Book Stock" column (when the item has any POS-driven stock_movements this period) links to Stock Movements filtered to that item/period.',
          'Admin-only "Clear Book Stock" deletes stock_movements for the period (destructive, confirm-gated). "Clear All Par" resets every item\'s par level to 0 across the whole client (also confirm-gated).',
        ],
        fields: [
          { label: 'Book Stock', desc: 'Opening + Net Purchases − Wastage + Σ POS stock_movements for the period — a live, POS-depletion-aware figure shown only if the item has movement rows.' },
        ],
        formulas: [
          'Current Stock = physical closing count if present, else max(0, Opening + Net Purchases − Wastage − Usage).',
          'Shortfall = max(0, Par − Current Stock). Est. Value = Shortfall × unit rate.',
        ],
        gotchas: [
          'Items with Par = 0 are labeled "No Par" and excluded from the default Reorder Only filter — check "All Items" to see them.',
          '"Clear Book Stock" only deletes the raw movement ledger, never touches physical counts or Current Stock. "Clear All Par" resets par levels client-wide, not just the current filtered view — both are genuinely destructive, confirm before using.',
        ],
        connections: 'Book Stock deep-links to Stock Movements. Shares theoretical-stock logic with Stock Report. Used as a purchasing shopping list.',
      },
      {
        id: 'stock-movements',
        title: 'Stock Movements',
        route: '/stock-movements',
        plan: 'Starter+',
        summary: 'A raw, non-editable transactional ledger of every POS-driven stock depletion (sale or comp) for a period — the audit trail behind Book Stock and usage calculations. Two tabs: Raw Items (the ledger) and Sub-Recipes (a derived prep-level rollup).',
        workflow: [
          'Select period (or arrive via a deep link from Reorder Report). Search by item, filter by source (POS Sale / POS Comp). Export Excel.',
          'Order # is clickable and opens the original POS bill.',
          'Sub-Recipes tab: how many batches of each prep item this period\'s sales consumed. Shares the search + source filters; has no Day filter (see gotchas). Exports as a second Excel sheet, "Sub-Recipe Usage", leaving the first sheet unchanged.',
          'Both tabs: a Sort dropdown (per-tab keys, shared asc/desc toggle), a TOTAL footer row summing the Value of the current filtered set, and a Print button (printWithTitle, so "Save as PDF" gets a useful filename). Filters/tabs/buttons carry no-print so the printout is the header, stat cards and table only.',
          'Sub-Recipes tab names the sub-recipes NOT used this period ("9 of your 57 …"), which is why its count is lower than Recipe Costing\'s header: that page counts the master list (Recipes.js:177, category === \'Sub-Recipe\', unfiltered), this one counts what the period\'s sales consumed. A separate amber note flags any recipe used via sub_recipe_id whose category isn\'t Sub-Recipe — counted here but not by Recipe Costing, so used + unused would exceed the master total until the category is fixed.',
          'Sub-Recipes tab also has "Find ingredient in sub-recipes" — the same idea as Recipes.js\'s recipeHasIngredient() search, backed by subRecipeHasIngredient() over each row\'s fully-exploded raw-ingredient list, so it matches through nesting (a sauce whose only raw items come from a base sub-recipe still matches that base\'s ingredients).',
        ],
        fields: [
          { label: 'Value', desc: '|qty| × item.per_uom_rate. Stat cards include "Comp Value" — value given away with zero revenue (source=pos_comp movements only).' },
          { label: 'Qty Used (Sub-Recipes tab)', desc: 'Output units of the sub-recipe consumed — the unit its yield_uom names, e.g. 25,000 ml of a sauce. Summed across every dish sold that uses it, including via other sub-recipes.' },
          { label: 'Batches Used', desc: 'Qty Used ÷ recipes.yield_qty. Full batches of prep the period\'s sales actually consumed.' },
          { label: 'Cost / Batch', desc: 'computeRecipeCosts() for the sub-recipe — whole-batch ingredient cost with nested sub-recipes included. Note it does NOT divide by yield_qty (unlike calcSubRecipeCostPerUnit in recipeCostCalc.js), which is why Value = Batches × this.' },
          { label: 'TOTAL row', desc: 'Sums the Value of the currently filtered rows on both tabs. Qty is deliberately NOT summed on Raw Items (rows span different items in different UOMs) and only sums on Sub-Recipes when every visible row shares one yield UOM — otherwise it shows a dash, same rule as Purchases\' Qty total.' },
        ],
        formulas: [
          'Sub-recipe usage = Σ over depleting sales rows of (per-portion output units from explodeRecipeTree × qty_sold); batches = that ÷ yield_qty; value = batches × whole-batch cost.',
        ],
        gotchas: [
          'A warning banner appears if any recipe sold this period has zero recipe_ingredients — those sales deplete no stock at all and would otherwise silently vanish from this ledger; it lists the offending recipes by name.',
          'This table is never manually editable — movements appear automatically the instant a POS bill is charged or comped.',
          'The Sub-Recipes tab is DERIVED from sales_entries, not read from stock_movements — recipe_ingredients stores a sub-recipe as sub_recipe_id with item_id NULL, so a sub-recipe can never be a leaf and never reaches the ledger, and the table has no column for the path a depletion took. It re-walks the recipes at read time via explodeRecipeTree (src/utils/recipeCost.js), filtered through the same POS-supersedes-manual rule the write path uses (src/modules/ims/sales/salesDepletion.js, shared with depleteManualSales so the two cannot drift).',
          'Sub-recipe rows are deliberately NOT written into stock_movements: a sub-recipe\'s mirror item (items.is_sub_recipe) carries its own per_uom_rate, so extra ledger rows would double-count this page\'s own "Value Depleted" KPI against the raw-item rows already there. The two tabs are the same ingredients at different grains — never add them together.',
          'No Day filter on the Sub-Recipes tab: the derivation includes Bulk Sales Entry rows, which carry bs_day 0 and belong to the whole period, so a day filter would silently drop them rather than narrow the view.',
          'An amber reconciliation note appears when the derived raw-item value differs from the ledger\'s own total by more than 0.5%. Legitimate causes: a recipe edited after a sale (the ledger froze each depletion at the ingredients in force at sale time, while this view re-walks today\'s recipe — the two part ways permanently for anything sold before the edit); manual Sales Entry only began depleting stock on 2026-07-30 with no backfill; pos_credit rows reverse revenue but never restore stock; no-BOM recipes deplete nothing.',
          'Both this page\'s ledger read and Reorder Report\'s stock_movements/sales_entries reads go through fetchAllRows() (src/shared/fetchAllRows.js). A bare .select() silently caps at PostgREST\'s 1000 rows — this page showed "1000 movements / NPR 49,241" for a period that really had 1753 / NPR 87,043 until S528 fixed it. Any new period-scoped transaction read here must page the same way.',
        ],
        connections: 'The source ledger behind Reorder Report\'s Book Stock column and part of Stock Report\'s usage math (for POS-driven depletion specifically). The Sub-Recipes tab shares explodeRecipeTree with Variance/Reorder/Stock Report and computeRecipeCosts with Recipe Costing, so its batch cost always agrees with what Recipe Costing shows.',
      },
      {
        id: 'demand-forecast',
        title: 'Demand Forecast',
        route: '/demand-forecast',
        plan: 'Pro',
        summary:
          'Predicts covers, revenue, and per-dish quantity for the next 7 or 30 days for purchasing/prep planning, using a simple, auditable day-of-week moving average — explicitly not a trained AI model, by design, so results stay explainable.',
        workflow: [
          'Toggle horizon (7 or 30 days). Click "Recompute Forecast" to rebuild — this does NOT run automatically; a stale forecast persists until manually recomputed. Results expand to show per-dish quantities.',
        ],
        fields: [
          { label: 'Holiday badge / festival multiplier', desc: 'If the target date matches an entry in the Holiday Calendar with a demand_multiplier set, ALL of that date\'s qty/covers/revenue are multiplied by it. A holiday with no multiplier configured is still flagged but left unadjusted — treat it as a floor, not a ceiling, on a festival day.' },
        ],
        formulas: [
          'Lookback window: 84 days, capped at 8 most-recent same-weekday samples per forecast day. Forecast Qty = average qty across those samples.',
          'Forecast Covers/Revenue are averaged ONLY over POS-sourced history samples (never manual sales-entry rows, which structurally have covers=revenue=0 and would wrongly drag the average toward zero) — null if no POS samples exist for that weekday yet.',
          'If no POS revenue signal exists but a qty forecast does (from manual entries), revenue is instead estimated as Σ(forecastQty × recipe.selling_price) and shown with a "≈" prefix.',
        ],
        gotchas: [
          'Manual sales-entry history only kicks in as a fallback/supplement once POS history covers fewer than 42 days — and only for the qty signal, never covers/revenue.',
          'New forecast rows are inserted before the old run is deleted (not delete-then-insert) — a failed recompute can\'t wipe out the last good forecast.',
        ],
        connections: 'Reads POS orders, Sales Entry, Recipe Costing, and the Holiday Calendar (an HR admin page). Conceptually upstream of Reorder Report\'s par-driven purchasing.',
      },
      {
        id: 'wastage-report',
        title: 'Wastage Report',
        route: '/wastage-report',
        plan: 'Starter+',
        summary: 'Lists every item logged as waste in a period, with quantity and NPR cost, aggregated by item and by reason.',
        workflow: [
          'Select period. Filter by category. Print or Export Excel (Wastage-by-item sheet + By-Reason sheet).',
        ],
        fields: [],
        formulas: [
          'Value = qty × per_uom_rate, aggregated per item across any number of wastage rows. % of Total = itemValue ÷ totalValue × 100.',
        ],
        gotchas: [
          'Reason grouping: rows with no bs_day (the monthly catch-all entry) are grouped as "Monthly (untagged)"; dated rows use their own reason field or "Other."',
        ],
        connections: 'Feeds the Wastage figure used identically in Monthly/Annual Summary, Variance, Theoretical Variance, Dead Stock, and FIFO Report.',
      },
      {
        id: 'dead-stock',
        title: 'Dead Stock',
        route: '/dead-stock',
        plan: 'Growth+',
        summary: 'Flags items with zero or very low consumption this period — capital tied up in idle inventory.',
        workflow: [
          'Select period. Filter by status (All/Dead/Slow) and category.',
        ],
        fields: [],
        formulas: [
          'available = Opening + Purchased − Returned. used = max(0, available − wasted − closing).',
          'Dead = used === 0. Slow = available>0 AND used/available < 20%.',
          'Value at Risk = Closing Stock × per_uom_rate (only closing value counts, not opening/purchased).',
        ],
        gotchas: [
          'Items with zero stock presence at all (available≤0 and closing≤0) are skipped entirely — nothing to flag.',
          'Only items actually classified Dead or Slow are built into the report at all — this is a real filter on the data, not just a UI toggle.',
        ],
        connections: 'Same source tables as every other stock report; the opposite-problem companion to Reorder Report.',
      },
      {
        id: 'variance-report',
        title: 'Variance Report',
        route: '/variance',
        plan: 'Growth+',
        summary: '"The money report" — compares actual ingredient usage (from stock movement math) against theoretical usage (recipes × sales) and flags over/under variance.',
        workflow: [
          'Select period. Filter by category and flag (Over/Under/OK). An in-app banner explains what Theoretical vs Actual and Over/Under mean.',
        ],
        fields: [],
        formulas: [
          'Actual Used = Opening + Net Purchased − Closing − Wastage − Staff Meals.',
          'Theoretical Used = Σ over sold recipes of (qty sold × exploded ingredient qty), recursive through sub-recipes with yield adjustment.',
          'Variance = Actual − Theoretical. Variance % = Variance ÷ Theoretical × 100. Value = Variance × per_uom_rate.',
          'Flag: Over if Variance% >10; Under if <−10; else OK. Special case: Theoretical=0 but Actual>0 → forced Over (no recipe data explains any consumption at all).',
        ],
        gotchas: [
          'This uses the shared explodeRecipeIngredients() utility. Theoretical Variance (below) reimplements the same recursion locally in its own file — the two pages CAN disagree if the two code paths ever drift, since a fix to one doesn\'t automatically apply to the other. Worth checking both if a client disputes a variance number.',
          'Rows only appear if they show real activity (nonzero actual/theoretical/opening/purchased) — a completely inactive item is filtered out even under "All Items."',
        ],
        connections: 'Feeds Shrinkage Report, which tracks this same actual-vs-theoretical gap persistently across multiple closed periods.',
      },
      {
        id: 'fifo-report',
        title: 'FIFO / Expiry',
        route: '/fifo',
        plan: 'Pro',
        summary:
          'Tracks which purchased stock batches (lots with expiry dates) are expired or expiring soon, net of returns and this period\'s consumption, using FIFO (oldest-batch-first) allocation. The most algorithmically involved report in the module.',
        workflow: [
          'Select period. Filter by expiry status (All/Expired/Expiring Soon/OK) and category. The "expiring soon" window is set in Settings → Thresholds (expiry_warning_days, default 7).',
        ],
        fields: [],
        formulas: [
          'Only purchase_entries rows with a non-null expiry_date are considered, sorted oldest-first per item.',
          'Total period consumption per item (sold via exploded recipes + wastage + staff meals) is computed once per item, then allocated against that item\'s batches oldest-first — this is a documented approximation, not true batch-precise FIFO, since the schema has no batch-level consumption ledger. It\'s described in code comments as "the same level of precision every other report in this app already works at."',
          'Net Qty (per batch) = max(0, originalQty − returnedForThisBatch) − allocated consumption. Rows with Net Qty ≈0 are hidden.',
        ],
        gotchas: [
          'This report is entirely empty/useless unless purchase entries are logged with expiry dates — the empty state says so explicitly.',
          'A batch used to only net against returns, never against actual consumption since purchase — meaning old, fully-used batches kept showing their full original qty as "at risk." Fixed by the consumption-allocation logic above; worth knowing if a client remembers "used to look different."',
        ],
        connections: 'Shares consumption logic with Variance and Stock Report. The expiry-risk leg of the "three risks" trio alongside Dead Stock (idle capital) and Reorder Report (understocking).',
      },
      {
        id: 'theoretical-variance',
        title: 'Theoretical Variance',
        route: '/theoretical-variance',
        plan: 'Pro',
        summary: 'Conceptually a near-duplicate of Variance Report — theoretical vs actual consumption — but with its own locally-reimplemented ingredient-explosion logic and a tighter tolerance band.',
        workflow: [
          'Select period. Filter by category and type (All/Over-consumed/Under-consumed). Sort by Variance Value / Variance % / Name.',
        ],
        fields: [],
        formulas: [
          'Actual = Opening + Purchased − Returned − Closing − Wastage − Staff Meals.',
          'Theoretical = its own local expandIngredients() recursion (NOT the shared explodeRecipeIngredients util Variance Report uses) — same conceptual math (yield_pct trim-loss, sub-recipe recursion via yield_qty scaling) but a separately maintained implementation.',
          'Color band: red if Variance% >5, amber if <−5, green within ±5% — a TIGHTER tolerance than Variance Report\'s ±10% flag threshold, so the same item can be flagged here and not there.',
        ],
        gotchas: [
          'This page and Variance Report are functionally near-duplicates with independently maintained recursion logic — a real maintenance risk. If Variance Report\'s shared util gets a bug fix, this page\'s local copy does not automatically inherit it.',
          'Only items with theoretical usage > 0 appear at all here — unlike Variance Report, which still surfaces zero-theoretical items and force-flags them Over.',
        ],
        connections: 'Conceptual sibling of Variance Report; also feeds into the pattern Shrinkage Report tracks across periods.',
      },
      {
        id: 'shrinkage-report',
        title: 'Shrinkage Report',
        route: '/shrinkage',
        plan: 'Pro',
        summary:
          'Detects consistent, unexplained stock loss across multiple CLOSED periods — as opposed to Variance/Theoretical Variance which only look at one period at a time. The "is this theft or systematic over-portioning, not just a one-off" report.',
        workflow: [
          'Select how many recent closed periods to analyze (3/6/12) — open periods are excluded entirely. Filter by category and status.',
        ],
        fields: [
          { label: 'Status classification', desc: 'Consistent (red, ≥67% of tracked periods showed over-use, min 2 occurrences) / Occasional (amber, ≥2 occurrences but under 67%) / Once (gold, exactly 1) / Clear (green, 0).' },
        ],
        formulas: [
          'Per covered period (theoretical>0 for that item): variance = Actual − Theoretical. If variance>0, that period counts as a shrinkage occurrence.',
          'Total Loss (NPR) = Σ variance qty across occurrences × per_uom_rate.',
          'Theoretical usage comes from the shared explodeRecipeIngredients() util — the same one Variance Report, Stock Report and Reorder use — so it recurses through sub-recipes and divides by each ingredient yield_pct. Until 2026-07-27 this page read recipe_ingredients flat instead, dropping sub-recipe ingredients entirely and ignoring yield_pct; both errors understated theoretical usage, which OVERSTATED shrinkage. Figures from before that date read high.',
        ],
        gotchas: [
          'Items with zero covered periods (no recipe/sales linkage in any selected period) are excluded from the report entirely — not just hidden.',
          'Requires closed periods to exist at all — an all-open-periods client sees an empty report with a prompt to close a period first.',
          'Comped covers ARE counted in theoretical usage (unlike every revenue report, which excludes source=pos_comp). A comped dish collected no money but its ingredients were still consumed, so excluding it would show up as fake shrinkage.',
        ],
        connections: 'A statistical/longitudinal extension of Variance Report\'s per-period gap, tracked the way Annual Summary tracks multiple periods at once.',
      },
    ],
  },

  // ───────────────────────────── Finance Reports ─────────────────────────────
  {
    key: 'reports-money',
    label: 'Finance Reports',
    sections: [
      {
        id: 'vat-report',
        title: 'VAT Report',
        route: '/vat-report',
        plan: 'Starter+',
        summary: 'Summarizes input VAT (13%) on VAT-inclusive purchases for a selected BS month, for filing Nepal\'s IRD VAT return and reconciling with a CA.',
        workflow: [
          'Pick a period. Entries tab (line-item detail + returns) and CA Summary tab (vendor-grouped totals for the accountant). Print or Export Excel.',
        ],
        fields: [
          { label: 'CA Summary → PAN/VAT No.', desc: 'Flagged red "Missing" if the vendor has no PAN on file — a real compliance issue since Annexure filings need it.' },
        ],
        formulas: [
          'Only entries with the per-line VAT toggle checked are included. Bill-level discount is prorated to the VAT-taxable share of each bill (discountScope=\'vat\'): scopedDisc = bill.discount × (vatBase/billTotal).',
          'Net Input VAT (the number to actually file) = (Taxable Base − Returns\' Base) × 0.13.',
          'Discount is applied BEFORE VAT — VAT is levied only on the net taxable amount, matching IRD convention.',
        ],
        gotchas: [
          'Only purchases entered with the "VAT Incl. (13%)" toggle ticked appear here at all — non-VAT purchases are entirely on the Non-VAT Report instead.',
          'The page explicitly says "For reference only — verify bills with your CA before filing."',
        ],
        connections: 'Its buildVendorSummary() helper is reused (with different discount-scoping) by Purchase 1L+ Report below — the two can show slightly different vendor totals as a result.',
      },
      {
        id: 'non-vat-report',
        title: 'Non-VAT Report',
        route: '/non-vat-report',
        plan: 'Starter+',
        summary: 'Lists every purchase entered with the VAT toggle OFF for a period — pure expense with zero input tax credit.',
        workflow: ['Same period-picker/tab pattern as VAT Report: Entries + CA Summary.'],
        fields: [],
        formulas: [
          'Total = Σ(qty×rate) of non-VAT lines − unique-per-bill discount − non-VAT returns. "Input VAT Credit: NIL" is a fixed, deliberate stat card contrasting this report against VAT Report.',
        ],
        gotchas: [
          'Returns were not deducted here until 2026-07-27, while VAT Report had always deducted its own — so the two halves of the same IRD filing used different definitions of "purchases". Figures from before that date read high by the value of any non-VAT goods sent back.',
          'A return is counted as non-VAT by joining back to its purchase_entries.vat_inclusive — vendor_returns has no VAT flag of its own.',
        ],
        connections: 'Mutually exclusive dataset with VAT Report — same purchase_entries table, split by the vat_inclusive flag set at purchase-entry time.',
      },
      {
        id: 'payment-summary',
        title: 'Payment Summary',
        route: '/payments',
        plan: 'Starter+',
        summary: 'Breaks down purchase spend by payment method (Cash / Credit / FonePay), net of returns, for a period.',
        workflow: [
          'Defaults to the currently open period. Method Summary tab (aggregate) and Daily Breakdown tab (per-day, per-method).',
        ],
        fields: [],
        formulas: [
          'Per method: Net = Gross − Returns (returns inherit their linked purchase\'s payment method). % of Net Total = method.net ÷ grandNet × 100.',
        ],
        gotchas: [
          'This report has NO discount handling — "Gross" here is literally qty×rate with bill-level discount never subtracted, unlike VAT/Non-VAT/Vendor Report which are all discount-aware. Numbers here can look higher than the equivalent figure on Vendor Report for the same period.',
          '"Credit" total is gross Credit-method purchase value regardless of whether it\'s since been paid off — not the same concept as "outstanding." See Outstanding Payables for actual payment status.',
        ],
        connections: 'Feeds conceptually into Outstanding Payables (Credit bills becoming payables) and Vendor Report (which splits the same three methods per-vendor, correctly discount-aware).',
      },
      {
        id: 'outstanding-payables',
        title: 'Outstanding Payables',
        route: '/payables',
        plan: 'Growth+',
        summary: 'Tracks unpaid Credit-method purchase bills, their age, and lets an admin record full or partial payments directly on the page.',
        workflow: [
          'Outstanding tab (unpaid bills) and Paid History tab. Bills are grouped by vendor + invoice ref + period + day.',
          'Click a bill to expand line items, payment history, and (Outstanding only) a payment form — Amount, Date, Note, with a "Pay in full" shortcut.',
          'Payment allocation is automatic and oldest-line-first across the bill\'s unpaid lines, clamped so it can never exceed the bill\'s remaining balance.',
        ],
        fields: [
          { label: 'Aging buckets', desc: 'Current (≤30 days), 31–60, 61–90, 90+ — colored green/accent/amber/red, computed from the bill\'s BS date converted to AD, not from any separate "due date" concept.' },
          { label: 'Status badge', desc: 'Partial (purple, some payment recorded but not full) vs the aging-bucket label.' },
        ],
        formulas: [
          'Bill Total = what the vendor actually invoiced, via the SAME calcBillTotals() helper that backs the live total in PurchaseBillModal and the printed purchase voucher: line values net of any goods returned against them, minus the bill-level discount (deduped per purchase_group_id), plus 13% VAT on the VAT-inclusive portion net of its share of that discount.',
          'That grand total is then spread back across the lines of the bill in proportion to their net value, because payments allocate per purchase_entry_id.',
          'Remaining (per line) = max(0, value − Σ payments against it). A bill only moves to Paid History once EVERY one of its line items individually reaches full payment.',
        ],
        gotchas: [
          'Until 2026-07-27 Bill Total was a bare qty x rate — no VAT, no bill discount, no returns. A VAT-inclusive credit bill therefore read about 13% LOW, and "Pay in full" settled it at roughly 88.5% of what was actually owed, while discounts and returns pushed the figure the other way. Any bill settled before that date is worth re-checking against its printed voucher.',
          'Only payment_method=\'Credit\' purchases appear here at all — Cash/FonePay purchases are assumed settled at time of purchase and never show up.',
          'Requires a one-time DB migration (a paid_at column on purchase_entries) — if missing, the page shows a setup banner with the exact SQL to run.',
          'There is no way from this UI to pay a single line item independently of its bill — payment always allocates automatically across the whole bill.',
        ],
        connections: 'Vendor Report\'s bill-drill-down independently reimplements the same aging/status logic (duplicated, not shared code) — the two should agree in practice but aren\'t literally the same function.',
      },
      {
        id: 'purchase-1l-report',
        title: 'Purchase 1L+ Report',
        route: '/purchase-one-lakh-report',
        plan: 'Starter+',
        summary:
          'Nepal IRD VAT return Annexure 13 (अनुसूची १३) compliance report — flags any single vendor whose cumulative purchases across a fiscal year exceed NPR 1,00,000, which must be disclosed by name + PAN.',
        workflow: [
          'Select a BS Fiscal Year (not a single month — this is the one report scoped to a fiscal year instead of a monthly period, a common point of confusion).',
        ],
        fields: [
          { label: 'Flag badge', desc: 'Amber "Annexure 13" if PAN is on file and the vendor is over threshold; red "⚠ Missing PAN" if over threshold with no PAN — a hard compliance flag that needs fixing before filing.' },
        ],
        formulas: [
          'Reuses VAT Report\'s buildVendorSummary(), but with discountScope=\'all\' (proration across the WHOLE bill, not just the VAT-taxable slice) and includes every purchase — VAT and non-VAT alike — since Annexure 13 discloses total cumulative spend, not just VAT-taxable spend.',
          'Threshold = NPR 100,000, checked against Net (after discount and returns), not Gross — a vendor with high gross spend but large discounts can net below threshold and won\'t be flagged.',
        ],
        gotchas: [
          'Because this shares code with VAT Report but with different discount-scoping, the same vendor\'s totals can differ slightly between the two reports — expected, not a bug.',
        ],
        connections: 'Code-sibling of VAT Report (same buildVendorSummary() helper, different parameters).',
      },
    ],
  },

  // ───────────────────────────── Menu & Vendor Reports ─────────────────────────────
  {
    key: 'reports-menu',
    label: 'Menu & Vendors',
    sections: [
      {
        id: 'best-sellers',
        title: 'Best & Worst Sellers',
        route: '/best-sellers',
        plan: 'Growth+',
        summary: 'Ranks menu items by revenue, volume, or margin % for a period, showing top 10 and bottom 10 performers with a bar chart.',
        workflow: [
          'Select period, toggle sort metric (Revenue/Volume/Margin %). Shows a Top 10 chart plus side-by-side Top 10/Bottom 10 tables.',
        ],
        fields: [],
        formulas: [
          'Revenue per recipe = Σ(qty × price), using each sale\'s own snapshotted unit_price where available rather than a single blended current price.',
          'Margin% = (Revenue − COGS) ÷ Revenue × 100, using computeRecipeCosts() — the same recursive cost engine as Recipe Costing.',
        ],
        gotchas: [
          'Comped sales (source=pos_comp) are excluded — comps never sold at menu price and would misleadingly inflate rank if included.',
          'Recipes with zero sales this period never appear at all, even in "Bottom 10" — that list is the bottom of the sold list, not a list of unsold items. With very few active recipes, Top 10 and Bottom 10 can overlap.',
        ],
        connections: 'Shares computeRecipeCosts() with Recipe Margin and Menu Repricing — one cost engine, three views on it.',
      },
      {
        id: 'recipe-margin',
        title: 'Recipe Margin',
        route: '/recipe-margin',
        plan: 'Growth+',
        summary: 'Shows the total NPR profit CONTRIBUTION each recipe generated in a period — (Selling Price − Food Cost) × Qty Sold — to find which dishes drive the most profit dollars, not just the best margin %.',
        workflow: [
          'Select period. Filters: category, "Only recipes with sales" (default on), sort by Total Contribution / Margin per Portion / best FC%.',
        ],
        fields: [],
        formulas: [
          'Margin/Portion = Selling Price − Cost. Total Contribution = Margin/Portion × Qty Sold (the headline number and default sort).',
          'Weighted Avg FC% (footer) = totalCost ÷ totalRevenue × 100 — a revenue-weighted average, not a simple average of each recipe\'s own FC%.',
        ],
        gotchas: [
          'Sorting defaults to Total Contribution, not Margin per Portion — a high-margin-but-rarely-sold dish won\'t rank at the top unless you explicitly re-sort by Margin/Portion. Both views answer genuinely different questions.',
          'Recipes with no selling_price set are excluded entirely, even in "all" mode.',
        ],
        connections: 'Shares computeRecipeCosts() with Best Sellers and Menu Repricing.',
      },
      {
        id: 'combo-builder',
        title: 'Combo Builder',
        route: '/combo-builder',
        plan: 'Growth+',
        summary: 'Market-basket / co-occurrence analysis — shows which menu items are actually ordered together most often on real POS bills, and suggests a discounted bundle price. Insight-only; never auto-creates the combo.',
        workflow: [
          'Pick an Anchor Item, a lookback window (30/90/180 days), and a Combo Discount % (saved per-client). Table shows each paired item\'s bill co-occurrence count, combined price, suggested combo price, and savings.',
        ],
        fields: [],
        formulas: [
          'Combo price = (anchor price + paired price) × (1 − discount%/100). Savings = combined − combo.',
        ],
        gotchas: [
          'Only items toggled On POS in Menu Pricing are eligible as anchors or pairing suggestions at all.',
          'This tool never writes anything back to the menu — the "Create as Menu Item" link only opens Menu Pricing; the bundle has to be created there manually.',
        ],
        connections: 'Reads recipes.selling_price and POS-enabled flags from Menu Pricing.',
      },
      {
        id: 'menu-repricing',
        title: 'Menu Repricing',
        route: '/menu-repricing',
        plan: 'Growth+',
        summary: 'Flags dishes currently priced below their target food-cost %, and calculates the exact price needed to fix it, along with the monthly NPR opportunity being left on the table.',
        workflow: [
          'Select period. Filters: "Only underpriced" (default on), "Only with sales," category. Sort by Monthly Opportunity / Price Gap / most-over-target.',
        ],
        fields: [],
        formulas: [
          'Underpriced = current FC% > target_fc_pct (defaults to 30 if unset on the recipe).',
          'Price Gap = max(0, target ex-VAT price − current price) — never negative; overpriced dishes show 0 and are excluded from "underpriced."',
          'Monthly Opportunity = Price Gap × Qty Sold — the extra margin already left on the table this period.',
          'Suggested Menu Price = ceil((cost ÷ target FC%) × (1 + VAT rate) ÷ 5) × 5 — the ONE VAT-inclusive, retail-rounded number on an otherwise all-ex-VAT page.',
        ],
        gotchas: [
          'Suggested Menu Price is VAT-inclusive while every other price/cost column here is ex-VAT — flag this explicitly when explaining the table to a client.',
          'target_fc_pct is per-recipe (set in Recipe Costing) and silently defaults to 30% if never set — may not reflect the client\'s actual target for that dish category.',
        ],
        connections: 'Shares computeRecipeCosts() and getSuggestedPrice() with Recipe Costing and Best Sellers/Recipe Margin. The "what to do about it" companion to Recipe Margin\'s "current state" view.',
      },
      {
        id: 'price-tracker',
        title: 'Price Tracker',
        route: '/supplier-prices',
        plan: 'Pro',
        summary: 'Tracks historical purchase rate per item per vendor over time, flags rising-price trends, and lets an admin update the Item Master\'s cost rate directly from observed purchase history.',
        workflow: [
          'Filter by Vendor and item search, plus a Trend filter. Click a row to expand full purchase history. Inline-edit the Master Rate to write straight to Item Master — if the item is used in any recipes, a banner lists every affected recipe after saving.',
        ],
        fields: [
          { label: 'Master Rate vs Last Rate', desc: 'Master Rate is the current Item Master rate actually used by Recipe Costing right now. Last Rate is the most recent purchase\'s rate. An amber ⚠ warns if they differ by more than 5%.' },
        ],
        formulas: [
          'purchase_entries.rate is already stored ex-VAT and in base-unit terms — the tracker reconstructs a "per pack" display rate by multiplying back by the item\'s CURRENT conversion factor, which is a best-effort approximation if that factor has changed since the purchase was made.',
        ],
        gotchas: [
          'Editing the Master Rate here is a live, immediate write to Item Master — not a preview. The affected-recipes banner only appears AFTER saving, as a heads-up, not as a pre-save confirmation.',
          'The 5% mismatch warning can\'t distinguish "stale rate that needs updating" from "a rate the admin deliberately overrode ahead of an expected price change" — use judgment before applying it.',
        ],
        connections: 'Writes directly to items.rate/per_uom_rate — the exact field Best Sellers, Recipe Margin, and Menu Repricing all read via computeRecipeCosts(), so an edit here ripples into all three on next load.',
      },
      {
        id: 'vendor-report',
        title: 'Vendor Report',
        route: '/vendors-report',
        plan: 'Pro',
        summary:
          'The most comprehensive vendor-spend report: net spend per vendor (discount- and return-aware, split by Cash/Credit/FonePay), a clickable Daily Breakdown grid, a Discounts Received tab, and a 3-level drill-down (Vendor → Day → Bill → Line items/payments).',
        workflow: [
          'Defaults to the open period. Three tabs: Vendor Summary, Daily Breakdown, Discounts Received. A vendor search combobox filters by name or vendor code.',
          'Click a vendor name (Summary) or a day-cell (Daily Breakdown) to open the drill-down modal — lists that vendor\'s bills, each expandable to line items, any returns against it, and full payment history.',
        ],
        fields: [
          { label: 'Net Spend', desc: 'Gross − Discount − Returns — explicitly contrasted against Payment Summary\'s Gross, which does NOT subtract discount.' },
        ],
        formulas: [
          'Per vendor: Net = Gross − Discount (unique per bill, summed once regardless of line count) − Returns.',
          'Bill-level payment status reuses the same aging buckets as Outstanding Payables (Current/31-60/61-90/90+), but is independently reimplemented in this file rather than shared code.',
        ],
        gotchas: [
          'The vendor color palette in the Net Spend Split chart maxes out at 8 distinct colors and cycles beyond that — with more than 8 active vendors, two will visually share a color.',
          'The Discounts tab\'s Grand Total includes VAT, while the Vendor Summary tab\'s Net Spend figures are all ex-VAT — not directly comparable line-for-line without adjusting for VAT.',
        ],
        connections: 'Overlaps conceptually with Outstanding Payables (bill status/aging) and VAT Report (discount-VAT proration), both independently implemented here rather than shared — a good report to present first when introducing vendor analytics, with Payment Summary, Outstanding Payables, and VAT/Non-VAT as narrower cuts of the same underlying data.',
      },
      {
        id: 'vendor-balance-confirmation',
        title: 'Vendor Balance Confirmation',
        route: '/vendor-balance-confirmation',
        plan: 'Pro',
        summary:
          'A printable per-vendor balance confirmation letter for a Nepal BS fiscal year — built specifically for IRD Annexure 13 reconciliation, where a vendor confirms in writing what they show as owed to them. Pick a vendor and fiscal year to get an Opening Balance carried forward from before the year started, plus every bill/payment/return dated within the year shown as its own line.',
        workflow: [
          'Select a vendor and a BS fiscal year (Shrawan → Ashadh). The letter shows Opening Balance, then every Purchase (gross), Payment, and Return dated within that fiscal year as its own running-balance line, ending in a Closing Balance.',
          'Print via the standard browser print flow — formatted as a formal letter with a signature line for the vendor to countersign and return.',
        ],
        fields: [
          { label: 'Opening Balance', desc: 'The balance as of the fiscal year\'s first day — nets only payments/returns dated BEFORE the cutoff, unlike Outstanding Payables\' live "as of today" figure which nets against everything ever recorded. A single carried-forward lump sum, same convention as a bank statement\'s "Balance Brought Forward" — no line-item breakdown before the cutoff.',
          },
          { label: 'Return lines (within the FY)', desc: 'Always shown as their own separate line at their VAT-adjusted effective value, never silently netted into the bill\'s total — a bill\'s displayed Purchase amount is always its gross value. This matters because VAT recalculates on the shrinking post-return base each time a bill has more than one return, so a return\'s displayed value is rarely a flat qty×rate.' },
        ],
        formulas: [
          'Closing Balance = Opening Balance + Purchases (gross, this FY) − Payments/Returns (this FY).',
          'A return against a bill is walked chronologically through calcBillTotals from that bill\'s gross total, so Purchase (gross) + Return (VAT-adjusted) always sums to exactly what a single netted line would have shown — nothing lost, just not hidden the way a netted figure would hide it.',
        ],
        gotchas: [
          'This report deliberately uses its own local billKeyOf/aging logic rather than the shared purchasesHelpers.js version Outstanding Payables uses — it is single-fiscal-year-scoped by construction, and pointing it at the cross-period-safe shared helper would silently misgroup bills across year boundaries instead of simplifying anything.',
          'If a bill shows a stray sub-paisa balance even after being marked fully paid elsewhere, the cause can be in three different layers (this report\'s own rounding, Outstanding Payables\' payment-allocation rounding, or unrounded per-line rates) — check all three independently rather than assuming one fix covers it, see Outstanding Payables\' own gotchas for the same underlying issue.',
        ],
        connections: 'Reads the same purchase_entries/vendor_returns/payable_payments tables as Outstanding Payables and Vendor Report, but scoped to one vendor and one BS fiscal year rather than a period or a live snapshot.',
      },
    ],
  },

  // ───────────────────────────── Admin ─────────────────────────────
  {
    key: 'ims-admin',
    label: 'Admin',
    sections: [
      {
        id: 'ims-staff',
        title: 'IMS Staff & the role system',
        route: '/ims/staff',
        plan: 'All plans · Manager-tier only',
        summary:
          'Crest IMS has a three-tier role system (Staff / Supervisor / Manager) that decides which IMS pages a login can reach. It mirrors the POS role system deliberately — same shape, same rank comparison — but is a completely separate axis: ims_role on the profiles row, independent of pos_role. This page is where an Owner or Manager creates IMS logins and assigns those roles.',
        workflow: [
          'Roles rank Staff (1) < Supervisor (2) < Manager (3). Every gated page declares a minimum, and access is a simple rank comparison — hasImsAccess(min) in AuthContext, plus a matching minImsRole tag on the sidebar/command-palette entry so a page a user cannot open is never shown as a link.',
          'The Owner login and any platform admin both resolve to Manager automatically — they never need an ims_role set. Note the Owner test is negative: an account counts as Owner only when it has none of pos_role, hr_self_service, or ims_role set, so giving someone an ims_role deliberately demotes them out of Owner-level access.',
          '"+ Add Staff" has three modes. HR Employee links the new login to an existing hr_employees record so the name never drifts between modules. IMS-only Staff creates a fresh email + password login. Existing User (added later, see below) assigns a role to a login that already exists rather than creating anything.',
          'Reset Password sets a new password immediately — there is no email or reset-link flow, so the new password has to be handed to the person directly.',
        ],
        fields: [
          { label: 'Staff (no gate)', desc: 'The day-to-day data-entry tier: Dashboard, Purchases, Gate Passes, Sales Entry, Stock Count, Requisitions. Enough to run a shift and record what physically happened, with no access to rates, margins, or configuration.' },
          { label: 'Supervisor', desc: 'Everything Staff has, plus Periods, Item Master, Vendors, Purchase Orders, Recipe Costing, and the Stock and Summary reports (Monthly/Annual Summary, Period Comparison, Budget vs Actual, Stock Report, Reorder, Stock Movements, Demand Forecast, Wastage, Dead Stock, Variance, FIFO, Theoretical Variance, Shrinkage). Item Master and Vendors sit at this tier specifically because they expose purchase rates — Staff can still log purchases normally, since the item/vendor picker inside Purchases does not require visiting those pages.' },
          { label: 'Manager', desc: 'Everything above, plus this page, Settings, Overheads, Menu Pricing, Menu Engineering, Menu Repricing, every Finance report (VAT, Non-VAT, Payment Summary, Outstanding Payables, Purchase 1L+), and every Menu & Vendor report (Best & Worst Sellers, Recipe Margin, Combo Builder, Price Tracker, Vendor Report). The dividing line is money: this tier is what exposes margin, payables, and supplier pricing.' },
          { label: '"Existing User" mode', desc: 'Assigns an IMS role to a login the client already has (e.g. one created through Admin → Clients → Manage → Users) rather than creating a second account for the same person. Picks from the get_ims_eligible_users RPC and calls update_ims_role — no new login, and no email/password fields are shown.' },
        ],
        formulas: [],
        gotchas: [
          'A staff account with no ims_role at all cannot see any IMS page — the whole IMS section disappears from their sidebar rather than showing locked entries. That is the intended state for, say, an HR-only or POS-only login, not a misconfiguration.',
          '"Existing User" eligibility is deliberately narrow, and it is an architectural constraint rather than a UI nicety: only accounts with none of pos_role, hr_self_service, or ims_role already set are offered. Assigning ims_role to an account that is already POS PIN staff or HR self-service would appear to work in the UI while every actual table read and write kept silently failing — the S316 RESTRICTIVE isolation policies (no_pos_pin_staff, no_self_service_accounts) key off pos_email IS NOT NULL / hr_self_service = true directly, entirely independent of ims_role. The same check is enforced server-side in update_ims_role, not just in the picker, so calling the action directly cannot bypass it.',
          'Role changes take effect on the affected user\'s next profile load — an already-signed-in session keeps its old menu until it refreshes. When in doubt, have them sign out and back in rather than assuming the change failed.',
          'Route guards and nav visibility are two separate things and both matter. A page whose route guard bounces an under-privileged user is secure but still a trust problem if its link stays visible and dead-ends — every gated entry therefore carries minImsRole so the sidebar and ⌘K palette hide it too. This was a real bug once: the Settings link is rendered directly in Layout.js outside the nav groups, so it initially skipped the visibility filter and Staff accounts saw a clickable link to a page that bounced them.',
        ],
        connections:
          'Gates every page in this guide — see the tier lists above for exactly which. Reads and writes profiles.ims_role through the admin-user-ops Edge Function; overlaps with POS Staff and HR Self-Service only in that all three write staff-account markers onto the same profiles row, which is why the eligibility rule above exists.',
      },
    ],
  },

  // ───────────────────────────── IMS Settings ─────────────────────────────
  {
    key: 'settings',
    label: 'IMS Settings',
    sections: [
      {
        id: 'ims-settings',
        title: 'IMS-relevant Settings tabs',
        route: '/settings',
        plan: 'Client-facing tabs (not shown to admin)',
        summary: 'Five tabs in Settings configure IMS-specific behavior. All are client-facing only — they don\'t appear in the admin\'s own Settings view, which shows a different tab set (Branding/Property/Contact/Plan Pricing/Theme/Data).',
        workflow: [],
        fields: [
          { label: 'Item Codes', desc: 'Sets item_code_prefix (default ITM). New items get the next sequential number automatically. "Regenerate All" renumbers every item alphabetically from {prefix}-001 — used to close gaps after deletions. Surfaces on Price Tracker, purchase entries, stock sheets, audit trails.' },
          { label: 'Vendor Codes', desc: 'Same pattern for vendor_code_prefix (default VND). Shown as a badge in Vendor Report and used as a secondary search field there.' },
          { label: 'Sub-Recipe Codes', desc: 'Same pattern for sub_recipe_code_prefix (default SRC), scoped to recipes where category = "Sub-Recipe." Gated behind the recipe_costing feature flag.' },
          { label: 'Recipe Categories', desc: 'Free-form list feeding the recipe-form category dropdown and the category filter tabs on Best Sellers, Recipe Margin, and Menu Repricing. "Sub-Recipe / Prep Item" is a protected, system-managed category that can\'t be added/removed here — it\'s the sentinel value every cost report explicitly excludes. Removing a category from this list does NOT retag existing recipes; they keep showing under their now-orphaned category name.' },
          { label: 'Thresholds', desc: 'fc_warning_pct (35) / fc_critical_pct (45) color the Dashboard\'s Food Cost % card and Recipe Costing\'s FC filter pills. expiry_warning_days (7) sets FIFO/Expiry Report\'s "expiring soon" window. variance_flag_pct (10) is the intended Variance Report flag threshold. None of these four feed the Finance/Menu/Vendor reports — they\'re specifically Dashboard/Recipe Costing/FIFO/Variance-facing.' },
        ],
        formulas: [],
        gotchas: [
          'Regenerating codes (Item/Vendor/Sub-Recipe) is a bulk renumber — always confirms before running since it changes every existing code, not just new ones going forward.',
        ],
        connections: 'See each field above for exactly which downstream pages consume that setting.',
      },
    ],
  },
]
