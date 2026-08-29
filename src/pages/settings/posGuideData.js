// Crest POS — deep per-page reference for Admin Settings → Guides → Crest POS.
// Same shape and voice as imsGuideData.js: groups mirror Layout.js's POS_GROUPS nav order, and
// every section defines all 10 keys (ModuleGuideTab renders `.length` with no null guards).
// POS is a FLAT module — clients.pos_enabled only, no plan tiers, and its features (Guest QR
// Ordering, Loyalty) come WITH the module rather than being sold separately (S632). So the
// `plan` chip carries the RANK gate instead — pos_role staff/supervisor/manager is the real
// access axis.

export const POS_GUIDE_GROUPS = [
  // ───────────────────────────── Overview ─────────────────────────────
  {
    key: 'overview',
    label: 'Overview',
    sections: [
      {
        id: 'overview',
        title: 'How the POS module fits together',
        route: null,
        plan: null,
        summary:
          'Crest POS is a till system built to feed the rest of Crest: every closed bill posts its revenue into IMS Sales Entry and its ingredient depletion into the Stock Movements ledger, so the food-cost figures the suite is sold on come from real service, not re-typed totals. It is sold flat — pos_enabled on or off, no tiers, and no feature flag of its own: everything in this guide, Guest QR Ordering and Loyalty included, comes WITH the module (S632). pos_enabled is the only thing standing between a client and a public guest menu.',
        workflow: [
          'Setup once: activate the till device on POS Setup, build tables and ticket routing in Table Management, create PIN staff on POS Staff.',
          'Service: staff PIN in, take orders on the floor grid, Send Order fires KOT/BOT tickets (printed and on the Kitchen Display), Charge closes the bill.',
          'Cash discipline: a Supervisor opens a shift with a counted float, closes it against a recount; credit bills are settled later in Customers.',
          'Management: four reports (Sales, Exceptions, KOT Log, Covers) plus Credit Notes cover what sold, what was given away, what the kitchen was told, and how tables turned.',
        ],
        fields: [
          { label: 'One rank axis + three per-staff switches', desc: 'pos_role (staff < supervisor < manager) gates pages and actions. Orthogonal to it: pos_team (FOH / Kitchen / Bar — a kitchen or bar account sees ONLY the Kitchen Display, whatever its rank), a per-staff Discount Limit %, and a per-staff Allow Void checkbox. Void is deliberately NOT a rank power — promoting someone to Supervisor does not grant it.' },
          { label: 'The IMS handoff', desc: 'Closing a bill needs an OPEN IMS period covering today\'s BS month to post into. If there isn\'t one, the bill still closes and prints — refusing a sale mid-service is never acceptable — but it is stamped unposted, counted in a standing banner on the Orders floor, and recoverable via Periods → "Post POS bills to Inventory" once the period exists.' },
          { label: 'Attribution', desc: 'Every close, discount, comp and ticket send records whoever last PIN\'d in — which is why the 3-minute idle lock exists (below), and why the Exceptions report can rank staff at all.' },
        ],
        formulas: [
          'The money spine: order lines → Charge → pos_orders (invoice) → revenue into IMS sales_entries + depletion into stock_movements → every IMS food-cost report.',
        ],
        gotchas: [
          'A PIN staff session on an activated till signs back out to the PIN screen after 3 idle minutes (the Kitchen Display is exempt — it is a wall screen). Admin and Owner sessions are exempt too: if an admin is being signed out on a till machine, that is a bug, not this feature.',
          'Server-side guards enforce the discount cap, the void permission and comp rules for STAFF sessions; admin and Owner are exempt from all of them by design — so testing a guard from an admin login proves nothing.',
          'Offline covers order-taking only: menus, tables and order edits queue locally and sync on reconnect, but billing is hard-blocked offline — no money path exists without a live server.',
        ],
        connections: 'POS feeds IMS (Sales Entry, Stock Movements, and everything downstream — Variance, COGS, Menu Engineering). Menu items come from recipes flagged On POS in Menu Pricing (documented in the Crest IMS guide). POS staff can be linked to HR employees so one person exists once.',
      },
      {
        id: 'pos-setup',
        title: 'POS Setup',
        route: '/pos',
        plan: 'Manager only',
        summary:
          'Where a physical till device is activated: binding stores the client\'s device secret on that machine, which is what lets the PIN login screen list staff before anyone is signed in. Also the jumping-off link to the PIN screen.',
        workflow: [
          'On each till machine, a Manager (or the Owner) signs in once at the main login, opens POS Setup, and presses Activate. From then on the machine boots straight to the PIN picker.',
          'Deactivate before rebinding a machine to a different outlet — a device bound to another client refuses to simply switch.',
        ],
        fields: [
          { label: 'Device secret', desc: 'A per-client secret stored on the device at activation. The pre-login staff roster is only served to a device presenting it, so a random visitor to the login URL sees nothing. It lives in an admin-only table server-side and is fetched through a rank-checked call — staff logins can never read it.' },
        ],
        formulas: [],
        gotchas: [
          'A device activated long ago, before secret verification existed, may need a one-time re-activation — the PIN screen says so explicitly rather than silently showing no staff.',
        ],
        connections: 'Activation state gates the PIN Login screen and the idle lock. The secret is verified again server-side on every PIN login.',
      },
      {
        id: 'pos-login',
        title: 'PIN Login',
        route: '/pos/login',
        plan: 'Public on an activated till',
        summary:
          'The till entrance: a picker of this client\'s POS staff (photos/names), then a 4-6 digit PIN on a numpad. Sign-in completes server-side — the browser never holds the account\'s real email or password.',
        workflow: [
          'Tap your name, enter your PIN (keyboard works too). On success you land on the floor.',
          'Locked out? Five failed attempts locks the PIN for a period — any POS Manager resets it from POS Staff, and the lockout message says exactly that.',
        ],
        fields: [
          { label: 'PIN', desc: 'Never the account\'s real password: the server verifies a peppered fingerprint of it inside the login call, and lockout checks run in the same request — so they cannot be skipped from the browser, and failures are never double-counted.' },
        ],
        formulas: [],
        gotchas: [
          'An unactivated device gets its own explanatory screen ("this device isn\'t set up yet") instead of an empty staff list — and a network failure is shown as a failure, never as "no staff found, ask your manager".',
          'Forgotten PINs are recoverable only by the platform admin (Admin → Clients → Staff PINs); within the product the remedy is a reset, which sets a new one.',
        ],
        connections: 'Roster and verification both depend on POS Setup\'s device secret. Lockout state is what the idle lock returns staff to; PIN resets live on POS Staff.',
      },
    ],
  },

  // ───────────────────────────── Floor ─────────────────────────────
  {
    key: 'pos-floor',
    label: 'Floor',
    sections: [
      {
        id: 'orders',
        title: 'Orders & Billing',
        route: '/pos/orders',
        plan: 'Staff+ (all POS logins)',
        summary:
          'The heart of the till: a floor grid of table tiles (covers, running total, pending items, kitchen status, offline-pending dot, guest-request badge) and, on tap-in, the full-screen order screen — menu tiles, cart, kitchen tickets, and the Charge flow with its Pay / Void / Complimentary billing modal.',
        workflow: [
          'Tap a table → enter covers → add items (search or category tiles; kitchen notes from the preset list). The FIRST Send Order saves the order and auto-fires both KOT and BOT tickets; later additions go out via Send KOT / Send BOT.',
          'Charge opens the billing modal with a live two-column bill preview. Pay: pick tender(s), apply any discount (reason required), confirm. Void and Complimentary each demand a reason and close the bill without revenue — on the NC number series for comps, no number at all for voids.',
          'Split payment: several tenders against one invoice; non-cash tenders are capped at the remaining balance and only the last one can be undone.',
          'QR tender: a per-bill dynamic payment QR (the amount is injected into the merchant\'s registered QR); a confirmation poll auto-closes the bill when the payment lands.',
        ],
        fields: [
          { label: 'Discounts', desc: 'Clamped to the signed-in staff member\'s Discount Limit (set on POS Staff; blank = unlimited) and enforced again server-side, so a modified browser gains nothing. Every discount requires a reason and the buyer\'s name + phone.' },
          { label: 'Item-level comp (Supervisor+)', desc: 'Comp individual lines off a bill that is otherwise paid — a partial comp splits the line into a paid remainder and a comped row. Each comp ACTION takes one NC number (not one per line), reserved atomically before the bill closes; the person applying it is recorded server-side.' },
          { label: 'Credit & delivery partners', desc: 'A Credit bill needs the buyer\'s name + phone (that is what builds the customer book). Foodmandu/Pathao-style partners are BUYERS on a Credit bill, not payment methods — their commission is deliberately computed at settlement in Customers, not at Charge.' },
          { label: 'Loyalty points', desc: 'Optional per client (the loyalty flag). Points are earned automatically on any bill closed with a name and phone, at the rate of whichever scheme that customer is enrolled in — an untagged customer earns nothing, so it never switches itself on for an existing book. Redeeming at Charge is a TENDER, not a discount: VAT on the bill is unchanged, and it does not count against the discount cap set for that cashier. Schemes and enrolment live in Customers → Loyalty.' },
          { label: 'Offline', desc: 'Order-taking queues locally (IndexedDB) and syncs on reconnect; the real bill number is assigned by the database on sync. An order another device already closed while this one was offline is surfaced as a conflict to review — never auto-discarded. Billing is hard-blocked offline.' },
        ],
        formulas: [
          'Live cart: subtotal (ex-VAT) = Σ qty × unit price; VAT only on VAT-flagged items for a VAT-registered client; total = round(subtotal + VAT).',
          'With a discount: the discount reduces the PRE-VAT base and VAT is recomputed on the discounted amount — payable = round(subtotal − discount + VAT × (1 − discount ÷ subtotal)). Never a flat subtraction off the total.',
          'Comped lines are excluded from the payable base before any of this runs — a comp is not a 100% discount.',
        ],
        gotchas: [
          'A bill where EVERY line is comped is blocked at Charge — use the Complimentary tab instead, otherwise a sequential tax-invoice number burns on a ₨0 document.',
          'Cash: an empty tendered box means "exact cash"; an entered amount below the total blocks Confirm with the shortfall named. Change is computed, not trusted.',
          'The floor shows a standing count of closed bills not yet posted to Inventory — investigate via Periods (usually a month nobody opened) rather than re-ringing anything.',
          'Reprints increment a visible print counter on the bill — an audit trail, not a malfunction.',
        ],
        connections: 'Closing posts revenue to IMS Sales Entry and depletion to Stock Movements. Tickets land in the KOT Log and on the Kitchen Display. Buyer identities build Customers; credit bills appear there for settlement. Exceptions, Sales Report and Covers all read what this screen writes.',
      },
      {
        id: 'kds',
        title: 'Kitchen Display',
        route: '/pos/kds',
        plan: 'Staff+ (all POS logins)',
        summary:
          'The kitchen/bar wall screen: three columns — New → In Progress → Ready — of today\'s tickets, advanced by tap. Runs alongside the printed tickets (every card is a real ticket from the log), refreshing every few seconds with a chime on new arrivals.',
        workflow: [
          'Tap a New ticket to start it — a prompt asks for an estimated prep time, which feeds the guest\'s countdown on the QR menu. Tap again when Ready.',
          'KOT/BOT station toggle: FOH, admin and Owner accounts can flip between Kitchen and Bar queues (remembered per device); a kitchen- or bar-team account is locked to its own station with no toggle.',
        ],
        fields: [
          { label: 'Timing colours', desc: 'A ticket warns as it ages and flags late past the threshold; Ready tickets drop off the board after 10 minutes purely to declutter — they remain in the database and in every KOT report.' },
        ],
        formulas: [
          'Actual prep time = ready time − started time (blank until both exist) — the figure the KOT Log\'s timing view reports.',
        ],
        gotchas: [
          'Tickets from a voided order disappear from the board (cancelled) — the void, and any food already fired against it, is the Exceptions/KOT-Log story, not a live cooking task.',
          'The board is deliberately exempt from the 3-minute idle lock — it is meant to sit untouched on a wall. A double-tap cannot advance a ticket twice, and a failed write reverts visibly instead of showing a phantom "done".',
        ],
        connections: 'Cards map one-to-one onto KOT Log tickets. The prep estimate feeds the Guest Menu\'s status countdown. Station routing follows Table Management\'s ticket-routing categories.',
      },
      {
        id: 'parking',
        title: 'Parking Slips',
        route: '/pos/parking',
        plan: 'Staff+ to view · Supervisor+ to issue',
        summary:
          'Vehicle token slips for guest parking: issue and print a numbered slip, optionally linked to one of today\'s bills, then mark it exited when the vehicle leaves. Open/All filters and reprint (with a visible reprint count).',
        workflow: [
          'Issue: vehicle number/type, optional link to one of TODAY\'s billed orders, print the slip. Mark Exited on departure.',
        ],
        fields: [
          { label: 'Bill link', desc: 'Only today\'s bills are offered — a slip issued today can never belong to last week\'s bill.' },
        ],
        formulas: [],
        gotchas: [
          'A slip still open from a previous day is swept closed the next time the page opens, flagged as auto-closed — visibly distinct from a real confirmed exit, since there is no server-side scheduler to do it overnight.',
        ],
        connections: 'Reads today\'s billed orders for linking. Otherwise standalone — parking never touches the money path.',
      },
      {
        id: 'tables',
        title: 'Tables (Table Management)',
        route: '/pos/tables',
        plan: 'Manager only',
        summary:
          'All POS floor configuration in six tabs: Tables (the grid itself, plus each table\'s guest-menu QR), Ticket Routing (which menu categories print as BOT vs KOT), Quick Notes (kitchen note presets), HSC Codes (per-item codes printed on the tax invoice), Discount Reasons, and Delivery Partners.',
        workflow: [
          'Tables: add one by one or Quick Setup bulk-creates Table 1..N; set capacity (feeds the Covers report\'s seat count); cycle status available → reserved → occupied → inactive; print each table\'s QR for the guest menu.',
          'Ticket Routing: assign categories to the Bar ticket — everything else goes to the Kitchen. The default split sends Beverage to the bar.',
          'Delivery Partners: name + commission % + phone per partner — the list the Charge screen offers as Credit buyers and Customers uses at settlement.',
        ],
        fields: [
          { label: 'HSC codes', desc: 'Per-recipe harmonized codes for the printed tax invoice — data entry here, printing on the bill.' },
          { label: 'Discount Reasons', desc: 'The preset list the billing modal offers; a discount always carries one.' },
        ],
        formulas: [],
        gotchas: [
          'Ticket Routing is the single source for the Kitchen/Bar split — the ticket printers, the Kitchen Display stations and the Sales Report\'s Kitchen-vs-Bar axis all read the same setting, so they can never disagree.',
          'Each tab loads once per visit and reloads on an admin "view as" client switch — a tab left open across a switch can never save the previous client\'s data under the new client.',
        ],
        connections: 'Tables/capacity → Orders floor + Covers report. QR → Guest Menu. Routing → ticket printing, KDS, Sales Report\'s Product Type tab. Partners → Orders\' Credit buyers + Customers\' settlement commission.',
      },
      {
        id: 'customers',
        title: 'Customers & Credit',
        route: '/pos/customers',
        plan: 'Supervisor+',
        summary:
          'The customer book and the credit ledger. Customers are built automatically from any bill carrying a buyer name + phone; the Credit tab lists every unsettled Credit bill for collection, including delivery-partner balances, with a settle flow and commission calculation.',
        workflow: [
          'Browse or search customers; expand one for their recent bills. The Credit tab is the collection worklist — settle a bill with the method actually received (cash, card, wallet, cheque, bank transfer).',
          'For a delivery partner, settlement is where the commission is computed and recorded — on the ex-VAT base the platforms themselves calculate on.',
        ],
        fields: [
          { label: 'Who owes what', desc: 'The credit ledger totalled by counterparty — each delivery platform separately, plus one Direct customers row so the rollup still ties to the Outstanding figure above it. Covers every Credit bill ever, unlike the date-ranged report.' },
          { label: 'Settlement methods', desc: 'Cheque and Bank Transfer exist only here — they are settlement instruments, not till tenders, which is why the Charge screen never offers them.' },
        ],
        formulas: [
          'Partner commission = round(ex-VAT bill base × commission %) — the base excludes comped lines and VAT, matching how the platforms invoice.',
        ],
        gotchas: [
          'A CASH settlement also records a cash-drawer movement against the open shift — without it the drawer would count "over" by the settled amount forever, since the bill itself stays marked Credit. If no shift is open, the page says to record it as a Cash In next shift rather than losing the money trail.',
          'The credit list is unbounded by date on purpose (old debts are still debts) — it is paged underneath, so it stays complete however long the system runs.',
        ],
        connections: 'Built from Orders\' buyer details; settlements post drawer movements into Shifts; partner definitions come from Table Management. Credit totals appear in the Sales Report\'s payment summary.',
      },
      {
        id: 'shifts',
        title: 'Shifts (till sessions)',
        route: '/pos/shifts',
        plan: 'Supervisor+',
        summary:
          'Cash-drawer discipline: open a shift with a counted float (denomination grid), watch a live X-report through service, record non-sale cash in/out, then close against a physical recount — printing a signed Cash Settlement slip. History keeps every closed shift\'s frozen Z-report.',
        workflow: [
          'Open Shift: count the float by denomination (1000s down to 1s), pick a label (Morning/Afternoon/Evening/Night suggested), print the opening slip.',
          'During service: Cash In / Cash Out record float top-ups, supplier cash payouts, and credit settlements landing in the drawer.',
          'Close Shift: recount by denomination; the page shows expected vs counted and the variance; print the settlement slip with signature lines.',
        ],
        fields: [
          { label: 'X-report vs Z-report', desc: 'The live view during a shift is the X-report. At close, the full report is captured and FROZEN onto the shift — history always shows the numbers as they were signed off, even if a bill is corrected later.' },
        ],
        formulas: [
          'Expected cash = opening float + cash sales + cash in − cash out. Variance = counted − expected; balanced under one rupee, otherwise over/short.',
          'Total Sales on the report is SALES, not collection — it includes Credit bills billed but not yet collected. The drawer expectation uses cash sales only.',
        ],
        gotchas: [
          'Closing is blocked while any order on the shift is still open — an open table paid after sign-off would land on an already-signed shift.',
          'The recount is deliberately re-read immediately before the close is written — a drawer count takes minutes, and a bill can close mid-count.',
        ],
        connections: 'Cash sales come from Orders; credit settlements arrive from Customers as drawer movements; the frozen Z-reports are the shift-level audit trail behind the Sales Report\'s daily figures.',
      },
      {
        id: 'guest-menu',
        title: 'Guest Menu & QR Ordering',
        route: '/pos/menu/:tableId',
        plan: 'Public (via table QR) · included with the Crest POS module',
        summary:
          'What a guest sees after scanning the table\'s QR: the live menu with VAT-inclusive prices and nutrition facts. They can build a cart and submit it — which lands as a REQUEST for staff to accept, never directly on the order. Ordering comes with Crest POS; there is no separate flag to buy or switch on (S632).',
        workflow: [
          'Guest scans the QR printed from Table Management → browses the live menu.',
          'With ordering on: build a cart → submit → the Orders floor shows a request badge with a chime → staff review and Accept, which merges the items into the table\'s order and fires tickets as usual.',
          'The guest\'s screen tracks a five-stage status — placed → confirmed → sent to kitchen → preparing → ready — driven by the real ticket status, including the prep-time countdown the kitchen entered on the KDS.',
        ],
        fields: [
          { label: 'Why requests, not direct orders', desc: 'Anyone can scan a QR — staff acceptance is the fraud gate. Items reach the kitchen only after a signed-in staff member accepts them onto the order.' },
        ],
        formulas: [],
        gotchas: [
          'The page authorizes itself server-side from the table id (table → client → POS enabled) since a guest has no login — an invalid or stale QR gets nothing.',
          'The guest\'s cart and submitted request survive a page reload (kept on the device), and the countdown simply disappears rather than ever showing negative "your food is late" minutes.',
        ],
        connections: 'Menu content and On-POS visibility come from Menu Pricing (IMS guide). Requests surface on the Orders floor; ticket status flows back from the KDS. The QR itself is printed per table in Table Management. There is nothing to toggle: guest ordering is gated on pos_enabled alone, so it is live the moment POS is on. The feature_flags.guest_ordering switch still shown in the admin Feature Access modal is inert and grants nothing (S632).',
      },
    ],
  },

  // ───────────────────────────── Reports ─────────────────────────────
  {
    key: 'pos-reports',
    label: 'Reports',
    sections: [
      {
        id: 'exceptions',
        title: 'Exceptions',
        route: '/pos/exceptions',
        plan: 'Manager only',
        summary:
          'Every discount, void, whole-bill comp and item-level comp in a date range, filterable by type and by staff member, each drilling down to the underlying bill. This is the leakage report — the reason attribution (PIN sessions, the idle lock, server-recorded comp identities) exists.',
        workflow: [
          'Pick the range; scan the By Staff Member ranking for concentration; drill any row to the bill it came from.',
        ],
        fields: [
          { label: 'Revenue Impact', desc: 'The ranking figure: discount amounts + voided bills\' menu value + comps\' POTENTIAL sales value — one coherent would-have-been-revenue unit.' },
          { label: 'Comp food cost', desc: 'What a comp actually cost in ingredients (matching the printed Complimentary Slip). Kept in its own column and NEVER added into a revenue total — cost and forgone revenue are different units.' },
        ],
        formulas: [
          'Void value = the voided bill\'s full menu value including VAT. Item-comp events group one Charge action into one row (one NC number), however many lines it comped.',
        ],
        gotchas: [
          'Item-level comps live on bills that are otherwise ordinary PAID invoices — the report fetches them separately and cross-references both ways, so neither the paid bill nor the comp hides the other.',
          'Both underlying reads are paged — a busy quarter can exceed the database\'s silent 1,000-row cap, and truncation here would hide exactly the rows the report exists to surface.',
        ],
        connections: 'Reads what Orders writes (reasons, identities, NC numbers). The per-staff Discount Limit and Allow Void switches on POS Staff are the preventive controls; this is the detective one.',
      },
      {
        id: 'credit-notes',
        title: 'Credit Notes',
        route: '/pos/credit-notes',
        plan: 'Manager only',
        summary:
          'The IRD-compliant reversal instrument: issue a credit note against a paid tax invoice (always the WHOLE bill), and browse/reprint the numbered Credit Note Book. The note reverses the bill\'s revenue in IMS on the day it is issued.',
        workflow: [
          'Issue New: find the bill (search by invoice number or browse the date range), pick a reason — Wrong customer / Tax correction / Duplicate bill — confirm, print.',
          'Credit Note Book: every issued note, reprintable with its print count.',
        ],
        fields: [
          { label: 'Whole-bill only', desc: 'Partial credits are not supported — which is exactly why "price correction" is not on the reason list: it invited fixing one line by crediting the whole invoice. Correct a wrong bill by crediting it entirely and re-ringing it right.' },
        ],
        formulas: [
          'CN face value = the bill total minus any item-comped lines (those never posted revenue, so there is nothing of theirs to reverse). The IMS revenue reversal excludes them identically.',
        ],
        gotchas: [
          'An invoice-number search deliberately ignores the date pickers — "customer came back with last week\'s bill" is the normal case, and the pickers default to today.',
          'The note is numbered in the fiscal year it is ISSUED, not the bill\'s — a post-Shrawan note never writes into a closed FY\'s number series.',
          'The reversal posts on the issue day, not retroactively — last month\'s closed figures stay closed.',
        ],
        connections: 'Reverses Orders\' posted revenue in IMS Sales Entry. Credit-noted bills contribute returned quantity — never revenue — to the Sales and Covers reports. Numbering shares the per-FY series machinery with tax invoices.',
      },
      {
        id: 'sales-report',
        title: 'Sales Report',
        route: '/pos/sales-report',
        plan: 'Manager only',
        summary:
          'The full POS sales picture in eleven tabs: Daily, Hourly, Bill Register, Comped Bills, Payment Summary, Delivery Partners, Category Wise, Product Type, Item Wise, Customer Wise, and the 1L+ Report. Excel export with the company letterhead on every tab.',
        workflow: [
          'Pick the date range; every tab is a different slice of the same bills. Payment Summary rows click through to a pre-filtered Bill Register.',
          'The 1L+ tab lists buyers whose purchases cross NPR 100,000 — the IRD Annexure 13 disclosure threshold — which is one reason buyer names are mandatory on credit and discounted bills.',
        ],
        fields: [
          { label: 'By Partner rollup (Delivery Partners tab)', desc: 'One row per delivery platform — outstanding balance, commission taken, net received — plus the effective commission rate measured against the agreed one. The rate is the point: without it the tab can say how much a platform withheld but never whether that was the agreed amount. Clicking a row filters the bills, the KPIs and the export to that platform.' },
          { label: 'Product Type tab', desc: 'Three axes the data already carries: Kitchen vs Bar (the same ticket-routing categories that drive the printers, so the report and the tickets cannot disagree), VAT vs non-VAT as billed, and Veg vs Non-veg from the recipe flag.' },
        ],
        formulas: [
          'Every tab derives from ONE bill-math primitive: a grouping key over the same proportional-discount arithmetic, so any slice — category, item, hour, customer — reconciles exactly back to bill totals. A new slice is a new grouping, never a second copy of the math.',
          'A credit-noted bill contributes returned quantity only, never revenue, on every tab identically.',
          'Effective commission % = settled commission ÷ ex-VAT settled base — the same base Customers settles on, never the VAT-inclusive total (that would read about 13% low on every bill and accuse every platform of over-charging). Outstanding bills are excluded from both sides of it.',
        ],
        gotchas: [
          'A Product Type axis that could only produce a single row is hidden rather than rendered — so an axis you expected but don\'t see usually means the data can\'t split it (e.g. no bar categories configured), not a fault.',
          'All reads are paged — a busy month\'s line items far exceed the database\'s silent 1,000-row page, and the 1L+ tab in particular must never drop a party below a statutory disclosure line.',
          'An off-rate flag needs BOTH a gap of half a percentage point AND a rupee gap bigger than per-bill rounding can explain. Commission is rounded to the rupee at settlement, so one tolerance alone flags honest platforms on small bills.',
        ],
        connections: 'Reads Orders\' bills and payments; the Kitchen/Bar axis reads Table Management\'s ticket routing; Comped Bills cross-references Exceptions; daily totals reconcile to Shifts\' frozen Z-reports.',
      },
      {
        id: 'kot-log',
        title: 'KOT Log',
        route: '/pos/kot-log',
        plan: 'Manager only',
        summary:
          'What the kitchen and bar were actually told, in four tabs: Register (every physical ticket send), Reconciliation (inferred discrepancies between what was sent and what was billed), Bill Trail (a bill\'s full ticket history), and Pulled Items (the attributable record of items removed after being fired).',
        workflow: [
          'Register for the raw ticket log with prep timings; Reconciliation to catch food that was fired but never billed (including voided orders where food had already gone out); Pulled Items for the named, reasoned removal record.',
        ],
        fields: [
          { label: 'Pulled Items vs Reconciliation', desc: 'Pulled Items is written at the moment of removal — who, what, why — inside the same operation that changes the order. Reconciliation infers by comparing cumulative sends against the order as it stands. Keep reading both: inference still catches anything a direct record predates.' },
        ],
        formulas: [
          'Prep time per ticket = ready − started, from the Kitchen Display\'s taps.',
          'Current quantity per item is SUMMED across a bill\'s rows before comparing against sends — a partial comp legitimately splits one line into two rows, and comparing row-by-row would falsely flag it as shrinkage.',
        ],
        gotchas: [
          'A pulled item whose reason reads "none given" is what an offline sync (or a till on a stale version) honestly looks like — shown, never hidden, so the gap is visible rather than invented.',
          'Removing a fired item is deliberately a RECORD, not a rank-gated block — running out, mis-fires and changed minds are routine service; what was missing was a name against the removal, not a manager in the way.',
        ],
        connections: 'Tickets come from Orders\' sends; timings from the KDS; removals are written by the same order-save machinery; voided-with-food-sent rows cross-reference Exceptions.',
      },
      {
        id: 'covers-report',
        title: 'Covers Report',
        route: '/pos/covers-report',
        plan: 'Manager only',
        summary:
          'Seats and sitting patterns: covers and average spend per cover, daily trend, table turnover time banded by party size, peak hours, per-server figures, and RevPASH (revenue per available seat-hour).',
        workflow: [
          'Pick the range; the Turnover tab bands sittings by party size (1-2 / 3-4 / 5-6 / 7+) because one blended average dine-duration tells a manager nothing.',
        ],
        fields: [
          { label: 'RevPASH', desc: 'Revenue ÷ (total seats × open hours). Needs the opening and closing time set (editable inline on the report); left unset, that one card hides rather than blocking the rest. Total seats = the capacity sum from Table Management.' },
        ],
        formulas: [
          'Spend per cover = bill revenue ÷ covers, over the same discount-aware bill math as the Sales Report.',
        ],
        gotchas: [
          'Credit-noted bills are excluded — same rule as the Sales Report, so the two never disagree about a reversed evening.',
          'Reads are paged; truncation here would not just shrink totals, it would skew the averages the report exists for.',
        ],
        connections: 'Covers come from Orders\' cover counts; capacity from Table Management; revenue math shared with the Sales Report.',
      },
    ],
  },

  // ───────────────────────────── Admin ─────────────────────────────
  {
    key: 'pos-admin',
    label: 'Admin',
    sections: [
      {
        id: 'pos-staff',
        title: 'POS Staff & the role system',
        route: '/pos/staff',
        plan: 'Manager only',
        summary:
          'Creates and manages till PIN logins: name (or an existing HR employee, so one person exists once), job title carrying a rank, station team, and the two per-person switches — Discount Limit % and Allow Void. Plus PIN resets and custom role names.',
        workflow: [
          'Add Staff: from an HR employee (when HR is on) or manually; set the job title (rank), team (FOH / Kitchen / Bar) and a 4-6 digit PIN.',
          'Per staff member: set a Discount Limit (blank = unlimited), tick Allow Void where trusted, Reset PIN when forgotten or after five failed attempts.',
          'Rename the three rank levels to house titles; changing a title\'s level cascades to everyone holding it.',
        ],
        fields: [
          { label: 'The three ranks', desc: 'Staff: take orders, view the floor. Supervisor: + close bills, apply discounts/comps, table setup, open/close shifts. Manager: + all reports, credit notes, staff management, device setup.' },
          { label: 'Allow Void', desc: 'Deliberately a per-person switch, NOT a Supervisor power — promoting someone to Supervisor does not let them void, and the checkbox is the only thing that does. It once looked like a rank power on paper, and managers promoted people to grant it, got Supervisors who still couldn\'t void, and no error explained why.' },
          { label: 'Team (FOH / Kitchen / Bar)', desc: 'Which station, not how much power — a Kitchen or Bar account sees only the Kitchen Display regardless of rank, and is locked to its own ticket queue there.' },
        ],
        formulas: [],
        gotchas: [
          'Never give the OWNER\'s own login a pos_role — Owner status is the absence of staff roles, and assigning one demotes them to that rank\'s access. The owner is not on this list; the list is for staff.',
          'Updating one switch never resets the others — each field saves independently, so setting a Discount Limit cannot quietly wipe someone\'s role or team.',
          'Discount Limit and Allow Void are enforced server-side at close, not just in the till screen — a staff session cannot exceed them from a modified browser. Admin and Owner are exempt from both by design.',
        ],
        connections: 'Ranks gate every POS page (chips throughout this guide); the two switches bind Orders\' billing modal and the server-side close guard; teams bind the KDS and the sidebar. Linked HR employees keep one identity across modules. PIN lockout resets land here.',
      },
    ],
  },
]
