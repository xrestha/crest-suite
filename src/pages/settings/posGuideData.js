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
          'Setup once: activate each till tablet on POS Setup (every tablet gets its own key), build tables and ticket routing in Table Management, create PIN staff on POS Staff.',
          'Service: front-of-house staff PIN in and take orders on the floor grid; Send Order fires the KOT/BOT tickets (printed and on the Kitchen Display); a Supervisor or above presses Payment to close the bill. Kitchen and bar team logins only ever see the Kitchen Display.',
          'Cash discipline: a Supervisor opens a shift with a counted float BEFORE the first bill is charged (since S754 a bill cannot be charged without an open shift), and closes it against a recount; credit bills are settled later in Customers.',
          'Management: four reports (Sales, Exceptions, KOT Log, Covers) plus Credit Notes cover what sold, what was given away, what the kitchen was told, and how tables turned.',
        ],
        fields: [
          { label: 'One rank axis + three per-staff switches', desc: 'pos_role (staff < supervisor < manager) gates pages and actions. Orthogonal to it: pos_team (FOH / Kitchen / Bar — a kitchen or bar account sees ONLY the Kitchen Display, whatever its rank), a per-staff Discount Limit %, and a per-staff Allow Void checkbox. Void is deliberately NOT a rank power — promoting someone to Supervisor does not grant it.' },
          { label: 'The IMS handoff', desc: 'Closing a bill needs an OPEN IMS period covering today\'s BS month to post into. If there isn\'t one, the bill still closes and prints — refusing a sale mid-service is never acceptable — but it is stamped unposted, counted in a standing banner on the Orders floor, and recoverable via Periods → "Post POS bills to Inventory" once the period exists.' },
          { label: 'Attribution', desc: 'Every close, discount, comp and ticket send records whoever last PIN\'d in — which is why the 3-minute idle lock exists (below), and why the Exceptions report can rank staff at all.' },
        ],
        formulas: [
          'The money spine: order lines → Payment → pos_orders (invoice) → revenue into IMS sales_entries + depletion into stock_movements → every IMS food-cost report.',
        ],
        gotchas: [
          'A PIN staff session on an activated till signs back out to the PIN screen after 3 idle minutes (the Kitchen Display is exempt — it is a wall screen). Admin and Owner sessions are exempt too: if an admin is being signed out on a till machine, that is a bug, not this feature.',
          'Server-side guards enforce the discount cap, the void permission and comp rules for STAFF sessions; admin and Owner are exempt from those by design — so testing a guard from an admin login proves nothing.',
          'A printed (billed or voided) bill is locked for EVERYONE, Owner and admin included (S754): no edit, no reopen, no delete. The only correction is a Credit Note. Every rank shown in this guide is also enforced by the database, not just by which buttons a screen shows — closing a bill needs Supervisor, a Credit Note or a menu price needs a Manager, the invoice/VAT details printed on bills need the Owner.',
          'S754\'s database changes (migrations 20260916100000/110000/120000) and its two Edge Function updates were written and tested but not yet applied when this guide was updated — until they are, the screens show the new rules but the database does not yet refuse the old ones.',
          'Offline covers order-taking only: menus, tables and order edits queue locally and sync on reconnect, but billing is hard-blocked offline — no money path exists without a live server.',
        ],
        connections: 'POS feeds IMS (Sales Entry, Stock Movements, and everything downstream — Variance, COGS, Menu Engineering). Menu items come from recipes flagged On POS in Menu Pricing (documented in the Crest IMS guide). POS staff can be linked to HR employees so one person exists once. Sizes, extras and "No …" choices on a dish are the Crest Customization add-on, sold separately and documented in its own guide tab.',
      },
      {
        id: 'pos-setup',
        title: 'POS Setup',
        route: '/pos',
        plan: 'Manager only',
        summary:
          'Where each till tablet is activated and managed. Activation gives THAT tablet its own key (S754), which is what lets the PIN login screen list staff before anyone is signed in. The Tablets list shows every activated tablet, who activated it, when it was last used, and a Revoke button. Also the jumping-off link to the PIN screen.',
        workflow: [
          'On each till tablet, a Manager (or the Owner) signs in once at the main login, opens POS Setup, names the tablet ("Front counter", "Bar") and presses Activate. From then on the tablet boots straight to the PIN picker.',
          'Lost, sold or broken tablet: press Revoke beside it in the Tablets list. It stops at the PIN screen on its very next sign-in; every other tablet keeps working.',
          'Moving from the old shared key: tablets activated before S754 all share one restaurant-wide key. An amber panel says the shared key is still on and when a tablet last used it. Re-activate each old tablet so it appears in the list, then press "Switch it off" — that cannot be undone.',
          'Deactivate before rebinding a machine to a different outlet — a device bound to another client refuses to simply switch. Deactivating a tablet that has its own key also revokes that key.',
        ],
        fields: [
          { label: 'Tablet key', desc: 'A long random key per tablet, stored on that tablet at activation. The server keeps only a one-way fingerprint of it, so nobody — admin included — can read a tablet\'s key back. The pre-login staff roster is only served to a tablet presenting a live key, so a random visitor to the login URL sees nothing.' },
          { label: 'Last used', desc: 'The last time the tablet reached the staff sign-in with its key — any PIN attempt, right or wrong. A tablet not used for weeks is worth checking on.' },
          { label: 'Shared key (legacy)', desc: 'The one restaurant-wide key every tablet used before S754. It keeps working so no floor was locked out by the update, but it cannot be revoked for one tablet alone. Switching it off replaces it with a value no tablet holds.' },
        ],
        formulas: [],
        gotchas: [
          'A tablet whose key was revoked, or which still holds the shared key after it was switched off, shows a "this tablet needs activating again" screen — never an empty staff list.',
          'Tablet keys are NOT in a client backup and are not restored: after a restore each tablet is activated again, one tap each. Archiving a client, or clearing its data, revokes every tablet key and switches the shared key off (S755), so after a restore each tablet is activated again from POS Setup.',
          'Needs migration 20260916120000 and the new pos-staff-login to be live. Until then tablets keep signing in on the shared key.',
        ],
        connections: 'Activation state gates the PIN Login screen and the idle lock. The key is verified again server-side on every PIN login, and every sign-in stamps the tablet\'s Last used.',
      },
      {
        id: 'pos-login',
        title: 'PIN Login',
        route: '/pos/login',
        plan: 'Public on an activated till',
        summary:
          'The till entrance: a picker of this client\'s POS staff (photos/names), then a 4-6 digit PIN on a numpad. Sign-in completes server-side — the browser never holds the account\'s real email or password.',
        workflow: [
          'Tap your name, enter your PIN (keyboard works too). On success you land on Orders (the floor).',
          'Locked out? Five failed attempts locks the PIN for a period — any POS Manager resets it from POS Staff, and the lockout message says exactly that.',
        ],
        fields: [
          { label: 'PIN', desc: 'Never the account\'s real password: the server verifies a peppered fingerprint of it inside the login call, and lockout checks run in the same request — so they cannot be skipped from the browser, and failures are never double-counted.' },
        ],
        formulas: [],
        gotchas: [
          'An unactivated device gets its own explanatory screen ("this device isn\'t set up yet") instead of an empty staff list — and a network failure is shown as a failure, never as "no staff found, ask your manager".',
          'A failed sign-in says WHICH thing failed (S754): the server could not be reached (the PIN is kept, try again), the tablet needs activating again (its key was revoked or switched off), or the PIN was wrong.',
          'A leaver whose Final Settlement blocked their logins no longer appears on the picker.',
          'Coming back to a tablet that slept counts as idle time, not activity: if the 3 idle minutes passed while nobody was there, it locks at once instead of handing the next person the last waiter\'s session.',
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
        plan: 'Staff+ (front-of-house logins) · Payment is Supervisor+',
        summary:
          'The heart of the till: a floor grid of table tiles (covers, running total, pending items, kitchen status, offline-pending dot, guest-request badge) and, on tap-in, the full-screen order screen — menu tiles, cart, the Send Order / KOT / BOT buttons, and the Payment button that opens the Pay / Void / Complimentary billing window. Kitchen and bar team accounts cannot open this screen at all — whatever their rank, they are sent to the Kitchen Display.',
        workflow: [
          'Tap a table → enter covers → add items (search or category tiles; kitchen notes from the preset list). The FIRST Send Order saves the order and sends every item to its station at once (KOT to the kitchen, BOT to the bar). After that the button reads Update Order: if there are items not yet sent, it ASKS whether to send them to the kitchen/bar now (S754, owner decision — pressing Update and forgetting KOT/BOT was how food got billed and never cooked). KOT and BOT still send on their own.',
          'Takeaway: "+ Takeaway" starts an order with no table. Saved takeaways now sit on the floor as their own tiles (with the same kitchen-status badge as a table), so one can be reopened, added to and billed — before S754 a saved takeaway could never be found again.',
          'With Crest Customization: a dish that has choices either adds in one tap (its defaults cover every rule) or opens the choice window — except a BUILD-YOUR-OWN dish (S760, an acai bowl or a pizza), which always opens it, with each chip priced at the size picked so far. Full detail is in the Crest Customization guide tab.',
          'Served: when food has gone to the table, tap Served on the order screen — every Ready ticket for that order moves to Served, the Kitchen Display drops it and the floor stops showing food waiting.',
          'Payment (Supervisor and above only — a Staff login does not see the button, and the database refuses a close from one) opens the billing window with a live two-column bill preview. The order must be saved first, the till must be online, and — since S754 — a SHIFT MUST BE OPEN for Pay (including Credit and Split) and Complimentary, so every bill lands on a drawer count; a Void does not need one. Pay: pick tender(s), apply any discount (reason required), Confirm Payment. Void and Complimentary each demand a reason and close the bill without revenue — on the NC number series for comps, no number at all for voids.',
          'Split payment: several tenders against one invoice; non-cash tenders are capped at the remaining balance and only the last one can be undone.',
          'QR tender: a per-bill payment QR with the amount already filled in and locked (injected into the merchant\'s registered QR). The screen tells the cashier to confirm once the payment shows on the merchant app — closing the bill is a cashier action today. A background check for an automatic "payment received" signal also runs, but it can only find one after a payment provider (FonePay/eSewa) is connected to Crest, which has not happened yet, and it never runs on a split payment.',
        ],
        fields: [
          { label: 'The tile colour strip', desc: 'The band across the top of each table tile answers "does this table need me?", not "is it occupied" — a waiter can see who is sitting down. Amber = something is waiting on a person (items typed but not fired, a guest QR order to accept, an order not yet synced). Green = food is Ready in the pass. Brass = live and in hand, nothing outstanding. Quiet = available or held. The Available/Occupied/Reserved badge beside it is where the table status itself is read, and every strip colour is repeated by a labelled chip on the same tile, so nothing depends on colour alone.' },
          { label: 'Discounts', desc: 'Clamped to the signed-in staff member\'s Discount Limit (set on POS Staff; blank = unlimited) and enforced again server-side, so a modified browser gains nothing. Every discount requires a reason and the buyer\'s name + phone.' },
          { label: 'Item-level comp (Supervisor+)', desc: 'Comp individual lines off a bill that is otherwise paid — a partial comp splits the line into a paid remainder and a comped row. Each comp ACTION takes one NC number (not one per line), reserved atomically before the bill closes; the person applying it is recorded server-side.' },
          { label: 'Credit & delivery partners', desc: 'A Credit bill needs the buyer\'s name + phone (that is what builds the customer book). Foodmandu/Pathao-style partners are BUYERS on a Credit bill, not payment methods — their commission is deliberately computed at settlement in Customers, not at Payment.' },
          { label: 'Loyalty points', desc: 'Part of POS for every POS client — there is nothing to buy or switch on. Points are earned automatically only when a bill is PAID with the customer\'s phone number on it, at the rate of whichever scheme that customer is enrolled in. Voided and Complimentary bills earn nothing, and a customer not enrolled in a scheme earns nothing — so loyalty never starts itself for an existing customer book. Redeeming in the Payment window is a TENDER, not a discount: VAT on the bill is unchanged, and it does not count against the discount cap set for that cashier. Since S754 points are earned and spent only while the bill is being closed, by the person closing it — a failed award cannot be retried later from the till (the Owner can). A Credit Note takes the earned points back and returns any points spent. Schemes and enrolment live in Customers → Loyalty.' },
          { label: 'Closed bills are locked', desc: 'Once a bill is billed or voided nobody can change its items, amount, payments or buyer details, reopen it, or delete it — Owner and admin included. Only reprint counters, the Inventory posting mark, a Credit Note link and a Credit settlement can still be recorded. To correct a bill, issue a Credit Note (S754).' },
          { label: 'Prices come from the menu', desc: 'Every NEW line on an order is priced on the server from the menu (Menu Pricing), never from what the tablet sends. A dish already on the order keeps the price it was ordered at, even if the menu price changes mid-meal. A dish taken off the menu cannot be added to an order any more; the save names it.' },
          { label: 'Two tablets, one order', desc: 'If another tablet saved the same order after this one opened it, the save is refused and the screen shows the latest version ("changed on another device"), with the lines you were adding kept to review — never silently overwritten either way. A table can only ever have ONE open order.' },
          { label: 'Offline', desc: 'Order-taking queues locally (IndexedDB) and syncs on reconnect; the real bill number is assigned by the database on sync. An order another device already closed while this one was offline is surfaced as a conflict to review — never auto-discarded — and "Start new order with these" puts its items back as unsent lines on a new order. Billing is hard-blocked offline.' },
        ],
        formulas: [
          'Live cart: subtotal (ex-VAT) = Σ qty × unit price; VAT only on VAT-flagged items for a VAT-registered client; total = round(subtotal + VAT).',
          'With a discount: the discount reduces the PRE-VAT base and VAT is recomputed on the discounted amount — payable = round(subtotal − discount + VAT × (1 − discount ÷ subtotal)). Never a flat subtraction off the total.',
          'Comped lines are excluded from the payable base before any of this runs — a comp is not a 100% discount.',
        ],
        gotchas: [
          'A bill where EVERY line is comped cannot be Confirmed on the Pay tab — use the Complimentary tab instead, otherwise a sequential tax-invoice number burns on a ₨0 document.',
          'Cash: an empty tendered box means "exact cash"; an entered amount below the total blocks Confirm with the shortfall named. Change is computed, not trusted.',
          'The floor shows a standing count of closed bills not yet posted to Inventory, and a separate amber banner counting credit notes not yet taken off Inventory sales — both are cleared from Periods → "Post POS bills to Inventory" (usually a month nobody opened), never by re-ringing or re-issuing anything.',
          'Reprints increment a visible print counter on the bill — an audit trail, not a malfunction.',
          'Recent Bills (today\'s bills, reprints and the Credit Note entry) is Supervisor+ since S754 — a Staff login does not see the button.',
          '"Open a shift first" on Confirm Payment is the S754 shift rule, not a fault: open one on Shifts and charge again. Clients used to billing with no shift open (BHATTI CHOILA billed all 18 of its recent bills that way) will hit this on day one.',
          'Who closed a bill, and when, is recorded by the server — not by the tablet\'s clock. Bills closed before migration 20260916100000 carry the till\'s clock time, which is why the Sales Report still flags a close recorded before its own open.',
        ],
        connections: 'Closing posts revenue to IMS Sales Entry and depletion to Stock Movements. Tickets land in the KOT Log and on the Kitchen Display. Buyer identities build Customers; credit bills appear there for settlement. Exceptions, Sales Report and Covers all read what this screen writes.',
      },
      {
        id: 'billing-station',
        title: 'Billing (the cashier station)',
        route: '/pos/billing',
        plan: 'Supervisor+ — the same rank that may take payment anywhere else',
        summary:
          'The same Pay / Void / Complimentary window as Orders, reached without walking through the floor plan. Floor → Billing lists every open bill in the outlet — covers, item count, running total, how long the table has been sitting — longest-open first, with the uncollected total on the floor in the header. One tap on Bill opens that order and the payment window together. Added S762 for the outlet that puts a cashier on the counter and waiters on the floor: those two people were sharing one screen shaped for the waiter.',
        workflow: [
          'Open Floor → Billing. The list refreshes itself every 15 seconds, the same poll the floor grid uses, so a bill settled on another till leaves it on its own.',
          'Tap Bill on a row → that order opens with the payment window already up. Everything inside it — tenders, split, discount cap, item comp, loyalty, the live preview — is the Orders billing window, unchanged; there is no second copy of any of it.',
          '← comes back to this list, not to the floor plan.',
        ],
        fields: [
          { label: 'What the list holds', desc: 'Every OPEN order: tables by name and section, takeaways by their order number. It is built from the same floor read the Orders grid uses, so "open" cannot mean two different things on the two screens.' },
          { label: 'The header figure', desc: 'The sum of every bill still open right now — what is sitting on tables uncollected. Not takings: today\'s money is the Sales Report.' },
          { label: '⚠ N unsent', desc: 'That bill carries lines never sent to the kitchen or bar. Billing anyway charges a guest for food nobody is cooking. Open it from Orders to send them, or take them off — this screen deliberately cannot.' },
        ],
        gotchas: [
          'This screen bills; it does not take orders. There is no way from here to add a dish or edit a note — that is Orders.',
          'Offline the Bill buttons are disabled and the list says why: an invoice number is assigned by the server and Nepal\'s sequence cannot be issued offline. Order-taking on Orders keeps working.',
          'An order queued offline on this device has no invoice number yet and cannot be billed until it syncs; it is listed with a 📵 not-synced chip and its button off.',
          'If a bill was settled on another tablet between the list loading and the tap, it says so and refreshes — it never falls through to starting a fresh order on that table.',
          'A shift must be open to take payment, exactly as from Orders.',
          'Supervisor+ is enforced by the page itself, not only by the menu — a Staff PIN typing /pos/billing is sent back to Orders.',
        ],
        connections: 'Same open-order read as the Orders floor (one poll, one truth); the payment window, its print pipeline and everything it posts to IMS are literally the Orders ones. Recent Bills, Exceptions and the Sales Report read what closes here exactly as if it had closed from Orders.',
      },
      {
        id: 'kds',
        title: 'Kitchen Display',
        route: '/pos/kds',
        plan: 'Staff+ (all POS logins)',
        summary:
          'The kitchen/bar wall screen: three columns — New → In Progress → Ready — of tonight\'s tickets, advanced by tap. Runs alongside the printed tickets (every card is a real ticket from the log), refreshing every few seconds with a chime on new arrivals. "Tonight" is the service day, which runs until 6 AM Nepal time, so a ticket sent at 11:52 PM is still on the board after midnight.',
        workflow: [
          'Tap a New ticket to start it — a prompt asks for an estimated prep time, which feeds the guest\'s countdown on the QR menu. Tap again when Ready.',
          'Served (S754): once food has left the pass, the runner taps Served (here, or Served on the waiter\'s order screen) and the ticket leaves the board. There is no fourth column — a served ticket has nothing left for the kitchen to do.',
          'Kitchen notes typed on an order line ("no onion — allergy") show under that dish on the card.',
          'A line pulled or reduced after its ticket was sent is struck through on that ticket with the word "cancelled", the quantity change and the reason — the kitchen must stop cooking it (S754, owner decision).',
          'KOT/BOT station toggle: FOH, admin and Owner accounts can flip between Kitchen and Bar queues (remembered per device); a kitchen- or bar-team account is locked to its own station with no toggle.',
        ],
        fields: [
          { label: 'The unstarted alert (S763)', desc: 'The moment a ticket lands in New, a bar drops down over the board naming it and a chime sounds — three rising notes, twice, loud enough to carry across a kitchen — and it REPEATS every 20 seconds until somebody presses Start. Bar and sound both stop the instant the ticket is taken. It hardens as the ticket ages: △ past 8 minutes, red and a harder tone past 15, the same two marks the card\'s own timer uses, so the bar and the board can never disagree. Mute 5 min silences the sound and leaves the bar up, because the ticket is still unstarted. Owner decision (revised the same day it shipped): the first build only raised the bar past the 8-minute mark, to keep a working kitchen quiet — but that is 8 minutes in which a ticket is sitting there and nothing says so, which is the exact complaint this feature exists to answer.' },
          { label: 'Timing colours', desc: 'The card\'s colour band is LATENESS, not stage — stage is already the column the ticket is sitting in. A ticket turns amber with a hollow △ on its elapsed time as it ages, red with a filled ▲ once past the late threshold, and green once Ready; everything on time stays quiet, so the board is only loud when a cook is actually needed. The marks matter as much as the colours: red and amber are hard to tell apart for a red-green colour-blind reader, and △ versus ▲ survives that, a greyscale screen and a printout. Ready tickets drop off the board after 10 minutes purely to declutter — they remain in the database and in every KOT report.' },
        ],
        formulas: [
          'Actual prep time = ready time − started time (blank until both exist) — the figure the KOT Log\'s timing view reports.',
        ],
        gotchas: [
          'Tickets from a voided order disappear from the board (cancelled) — the void, and any food already fired against it, is the Exceptions/KOT-Log story, not a live cooking task. A tap on a ticket whose order was voided in the meantime cannot bring it back.',
          'If the check for cancelled lines fails, the board says so and keeps the cancellations it last saw — a line the kitchen was told is cancelled never quietly becomes un-cancelled. "Clear Occupied" on the floor deletes the orders and their tickets, so nothing is struck through here — the food already sent is recorded under KOT Log → Pulled Items as "Table cleared" (S755).',
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
          'A slip still open from a previous BUSINESS day is swept closed the next time the page opens, flagged as auto-closed — visibly distinct from a real confirmed exit, since there is no server-side scheduler to do it overnight. The business day ends at 6 AM Nepal time (S754, owner decision), so a car parked at 11:30 PM during a late service is still on the Open tab at 12:30 AM.',
          'A failed read shows an error, never "No vehicles currently parked" over cars still in the lot; a refused Mark Exited says which vehicle is still marked parked (S754).',
        ],
        connections: 'Reads today\'s billed orders for linking. Otherwise standalone — parking never touches the money path.',
      },
      {
        id: 'reservations',
        title: 'Reservations',
        route: '/pos/reservations',
        plan: 'Staff+',
        summary:
          'The booking book. A booking is a promise about a future table, kept in its own record and DERIVED onto the Orders floor — it never writes the table\'s status. Take one by phone, WhatsApp or at the door, or let customers request one from the outlet\'s booking QR / link; every online request waits for a staff Accept — the count shows on the Reservations row inside the POS → Floor menu, on the dot on the POS button in the top bar and on the dashboard\'s Bookings Tonight tile, and the Reservations page chimes while it is open. Seating hands off to Order Taking with the party size as the covers, and paying the bill marks the booking completed.',
        workflow: [
          'Take: + New booking — name, phone (looked up in the customer book: visits, unsettled credit, past no-shows), guests, BS day + time, optional held tables, how they booked. Sitting length prefills per party size.',
          'Confirm: the 💬 button opens WhatsApp on this device with the confirmation message prefilled; the number is on the row for a phone call. Nothing is sent automatically — no SMS gateway, no sender ID to register.',
          'Seat: from the booking\'s Seat button (pick the table) or by tapping the held table on the Orders floor when it is due — either way the order opens with covers filled in and the booking flips to Seated with the order linked.',
          'Close: paying the bill (any close type) marks the booking Completed. No-show… and Cancel booking… (reason required) end it otherwise; Mark done… covers a party seated by hand or offline. All three live in the row\'s ⋯ menu; the row itself shows only the one next step (Confirm → Arrived → Seat).',
          'Undo: a no-show who turns up is put back to Arrived (⋯ → They turned up), which clears the mark from their phone number; a cancelled booking is reinstated to Booked. Both only on the booking\'s own day — after that it is a record, not a guest at the door.',
          'Decline vs cancel: a request from the booking link is DECLINED with its own reason list (No table at that time, Closed that day, Party too large), because that reason is shown on the guest\'s phone. Cancel reasons are for the book.',
          'Online requests: an amber band at the top of the page, polled every 15 s with a chime — Accept confirms, Decline needs a reason, and the guest\'s phone shows the answer within seconds.',
          'Views: Upcoming (the default — every future booking under day headers, so a colleague\'s booking for next week is on screen without picking the date), Day (one day, with the hour-by-hour strip), Unconfirmed (from today), Activity (the newest hundred changes, newest first, with who took each booking; changes since this device last opened the page are marked new, and that count also sits on the Reservations row inside the POS → Floor menu).',
        ],
        fields: [
          { label: 'Status ladder', desc: 'Requested (online only) → Booked → Confirmed → Arrived → Seated → Completed; No-show and Cancelled are terminal. Seated MEANS the order exists — the database refuses a seated row with no order_id.' },
          { label: 'Guests expected by hour', desc: 'A booking occupies every hour its sitting touches (7:30 PM for 90 minutes sits in 7 and 8), summed and compared to the room\'s seats. A soft warning, never a block. Next 7 days shows which days have such an hour.' },
          { label: 'Floor chip', desc: 'Grey when quiet, brass when due within the seat window, amber only when the party has ARRIVED and its table is still occupied — the one state waiting on a person.' },
          { label: 'Booking link / QR', desc: 'Tables → Reservations: toggle "Accept online booking requests", set the largest party and minimum notice, print the QR. The public page shows a two-week calendar (BS day first, AD beside it) and half-hour slots inside opening hours; a guest never chooses a table.' },
          { label: 'Closed / walk-in / full', desc: 'Closed weekdays, closed dates (Dashain, a private function) and walk-in-only weekdays grey the day out on the public calendar; a slot is greyed as Full when ACCEPTED bookings\' covers in any hour of the sitting plus this party would exceed the room\'s seats. Since S754 an unanswered online request no longer counts toward Full — it used to block the slot for every other guest. All three are refused server-side too (codes closed_day, walk_in, full). A room with no capacity set is never "full" — the host decides at Accept.' },
          { label: 'Double-booked tables', desc: 'A table cannot be held for two bookings whose times overlap (S754, owner decision) — saving names the booking already holding it. Back-to-back is fine: a 6:00–7:30 booking and a 7:30 booking on the same table do not clash. Only live bookings count; a cancelled, no-show or completed one holds nothing.' },
        ],
        formulas: [
          'No-show rate (Covers Report → Reservations) = no-shows ÷ (kept + no-shows); cancelled and still-open bookings are neither.',
          'Booked covers vs walk-in covers = covers on bills a booking was seated onto (pos_reservations.order_id) vs the rest.',
        ],
        gotchas: [
          'The manual Reserved status on a table tile is unrelated — a hand-set hold with no record behind it. Bookings never write it and never read it.',
          'A booking for 12:15 AM belongs to the NEXT BS day in the book but shows on tonight\'s floor: the floor reads today plus six hours past midnight.',
          'Online requests are rate-limited server-side (one pending per phone, a per-network hourly cap) and there is no phone verification — the staff WhatsApp or call IS the verification. Bigger parties than the online maximum are told to call.',
          'A booking seated while the till is offline keeps its status at Arrived: the link needs the server row and is never written from the offline queue. Use ⋯ → Mark done… on it afterwards.',
          'The double-booking check runs on the screen first, naming every clashing table, and again in the database under a lock on each table (S755) — so two devices saving the same table for overlapping times in the same second cannot both succeed: the second is refused and told who holds it. Reviving a no-show or cancelled booking is checked the same way.',
        ],
        connections: 'Reads pos_customers, pos_orders (credit, visits) at booking time. Writes order_id on seat from Order Taking and completes on bill close. Feeds Covers Report → Reservations, the No-shows column on Customers, and the Dashboard\'s Bookings Tonight tile (tonight\'s live bookings, covers still to come, requests waiting). Settings live on Tables → Reservations.',
      },
      {
        id: 'tables',
        title: 'Tables (Table Management)',
        route: '/pos/tables',
        plan: 'Manager only',
        summary:
          'All POS floor configuration in seven tabs: Tables (the grid itself, plus each table\'s guest-menu QR), Ticket Routing (which menu categories print as BOT vs KOT), Quick Notes (kitchen note presets), HSC Codes (per-item codes printed on the tax invoice), Discount Reasons, Delivery Partners, and Reservations (sitting length per party size, the late/seat windows, the WhatsApp confirmation text, and the outlet\'s booking link and QR).',
        workflow: [
          'Tables: add one by one or Quick Setup bulk-creates Table 1..N; set capacity (feeds the Covers report\'s seat count and the Reservations capacity strip); cycle status available → reserved → occupied → inactive; print each table\'s QR for the guest menu.',
          'Reservations: expected sitting length per party size, with the outlet\'s own MEASURED average beside each field and a one-tap "Use measured"; the WhatsApp template; the online-booking toggle, largest party and minimum notice; Copy link / Print QR for the booking page.',
          'Ticket Routing: assign categories to the Bar ticket — everything else goes to the Kitchen. The default split sends Beverage to the bar.',
          'Delivery Partners: name + commission % + phone per partner — the list the Payment window offers as Credit buyers and Customers uses at settlement.',
        ],
        fields: [
          { label: 'HSC codes', desc: 'Per-recipe harmonized codes for the printed tax invoice — data entry here, printing on the bill.' },
          { label: 'Discount Reasons', desc: 'The preset list the billing modal offers; a discount always carries one.' },
        ],
        formulas: [],
        gotchas: [
          'Ticket Routing is the single source for the Kitchen/Bar split — the ticket printers, the Kitchen Display stations and the Sales Report\'s Kitchen-vs-Bar axis all read the same setting, so they can never disagree.',
          'Each tab loads once per visit and reloads on an admin "view as" client switch — a tab left open across a switch can never save the previous client\'s data under the new client.',
          'Manager-only is enforced by the database too (S754): below Manager, adding, renaming, moving or deleting a table, and every setup tab here (discount reasons, quick notes, ticket routing, delivery partners, reservation settings), is refused. Changing a table\'s STATUS stays open to the till, because seating and billing flip it all service long.',
          'A table with an open bill cannot be deleted — for anyone. Bill or void it first. Before S754 the delete went through and the open bill vanished from the floor with nobody able to reach it.',
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
          { label: 'Settlement methods', desc: 'Cheque and Bank Transfer exist only here — they are settlement instruments, not till tenders, which is why the Payment window never offers them.' },
        ],
        formulas: [
          'Partner commission = round(ex-VAT bill base × commission %) — the base excludes comped lines and VAT, matching how the platforms invoice.',
        ],
        gotchas: [
          'A CASH settlement also records a cash-drawer movement against the open shift — without it the drawer would count "over" by the settled amount forever, since the bill itself stays marked Credit. If no shift is open, the page says to record it as a Cash In next shift rather than losing the money trail. For a delivery partner the drawer gets what the platform actually paid — the bill LESS its commission (S754); it used to post the full bill and every such shift read short by the commission.',
          'A Credit bill that has a Credit Note against it is no longer owed, so it leaves Outstanding and every total on the tab (S754). A bill settled BEFORE it was credited stays in Collected — that money really changed hands.',
          'Settling the same bill twice (two terminals, a double tap) is refused — the second one is told it was already settled, and the drawer is not paid in twice. Settling also waits until the outlet\'s settings have really loaded, because the commission base depends on the VAT setting.',
          'Loyalty tab: schemes, the point value and who is enrolled are set by a POS Manager or the Owner (S754, owner decision), enforced by the database. A Supervisor still sees the tab, read-only.',
          'The credit list is unbounded by date on purpose (old debts are still debts) — it is paged underneath, so it stays complete however long the system runs.',
          'The No-shows column comes from the reservations book, matched on the canonical phone number; a "?" means that read failed, not that the record is clean.',
        ],
        connections: 'Built from Orders\' buyer details; settlements post drawer movements into Shifts; partner definitions come from Table Management. Credit totals appear in the Sales Report\'s payment summary. No-shows come from Reservations, and a party seated from a booking arrives on its bill with name and phone already filled in, so the book grows from bookings too.',
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
          'During service: Cash In / Cash Out record float top-ups, supplier cash payouts, and credit settlements landing in the drawer. A cash refund on a Credit Note lands here too, as Cash Out labelled Refund with the note number.',
          'Close Shift: recount by denomination; the page shows expected vs counted and the variance; print the settlement slip with signature lines. If orders are still open it names them ("Table 3, Table 7 and 2 takeaways") and asks before closing — those bills simply land on whichever shift is open when they are charged (S754, owner decision).',
        ],
        fields: [
          { label: 'X-report vs Z-report', desc: 'The live view during a shift is the X-report. At close, the full report is captured and FROZEN onto the shift — history always shows the numbers as they were signed off, even if a bill is corrected later.' },
        ],
        formulas: [
          'Expected cash = opening float + cash sales + cash in − cash out. Variance = counted − expected; balanced under one rupee, otherwise over/short.',
          'Total Sales on the report is SALES, not collection — it includes Credit bills billed but not yet collected. The drawer expectation uses cash sales only.',
        ],
        gotchas: [
          'Closing is no longer blocked by open orders (S754) — it warns and lets you close. An open table paid later lands on the NEXT open shift, never on the one already signed.',
          'No shift open = no charging. Since S754 Pay (Cash, QR, Split, Credit) and Complimentary need an open shift, so every bill is on some drawer count; open the first shift before service starts.',
          'A closed shift is a signed record: nobody can edit or delete it. A cash movement is never edited or deleted either — a mistake is fixed with a second, correcting Cash In or Cash Out. Opening and closing a shift and recording cash need a Supervisor; a cash refund needs a Manager. All enforced by the database.',
          'The recount is deliberately re-read immediately before the close is written — a drawer count takes minutes, and a bill can close mid-count. If that read FAILS the close is refused and says so; it used to freeze a report of zeros onto the signed slip.',
        ],
        connections: 'Cash sales come from Orders; credit settlements arrive from Customers as drawer movements; the frozen Z-reports are the shift-level audit trail behind the Sales Report\'s daily figures.',
      },
      {
        id: 'guest-menu',
        title: 'Guest Menu & QR Ordering',
        route: '/pos/menu/:tableId',
        plan: 'Public (via table QR) · included with the Crest POS module',
        summary:
          'What a guest sees after scanning the table\'s QR: the live menu with prices — VAT is added into the price only when the outlet is VAT-registered — and nutrition facts only when the client has the nutrition feature switched on (feature_flags.nutrition_facts). They can build a cart and submit it — which lands as a REQUEST for staff to accept, never directly on the order. Ordering comes with Crest POS; there is no separate flag to buy or switch on (S632).',
        workflow: [
          'Guest scans the QR printed from Table Management → browses the live menu.',
          'Being told at all (S763): a request no longer announces itself only on the Orders floor. A loud bar drops down over WHATEVER page anyone with POS access is on — Inventory, HR, anywhere — naming the table and how long the guest has waited, with an Open Orders button, and the chime repeats every 20 seconds until someone deals with it, turning red past three minutes. Mute 5 min silences the sound and leaves the bar up. Suppressed on Orders (which already shows it better) and on the Kitchen Display (the kitchen cannot Accept a guest order, and a kitchen-team login cannot even reach Orders).',
          'With ordering on: build a cart → submit → the Orders floor shows a request badge with a chime → staff open the table and press Accept (or Dismiss). Accept only adds the items to that staff member\'s unsaved cart — nothing is saved until they press Send Order (a new table) or Update Order (an order already running). If they leave the table without saving, the request goes back on the list.',
          'Tickets: on a new table, Send Order fires KOT/BOT as usual. On an order already running, Update Order only saves — staff must then press KOT / BOT to send the guest\'s items to the kitchen and bar.',
          'With Crest Customization: tapping a dish that has choices opens a sheet of its groups; a BUILD-YOUR-OWN dish (S760) is walked one step at a time instead — size first, so every later price is the price at that size, then a Review of the whole bowl before Add to order. Whatever the guest picks is re-priced on the server when staff accept, so a phone can never set what is charged.',
          'The guest\'s screen tracks a five-stage status — placed → confirmed → sent to kitchen → preparing → ready — driven by the real ticket status, including the prep-time countdown the kitchen entered on the KDS.',
        ],
        fields: [
          { label: 'Why requests, not direct orders', desc: 'Anyone can scan a QR — staff acceptance is the fraud gate. Items reach the kitchen only after a signed-in staff member accepts them, saves the order and sends the tickets.' },
        ],
        formulas: [],
        gotchas: [
          'The page authorizes itself server-side from the table id (table → client → POS enabled) since a guest has no login — an invalid or stale QR gets nothing.',
          'A table marked inactive in Table Management still shows the menu from its QR, but ordering is off and the server refuses a guest order for it — the floor cannot open an inactive table, so the order would have nowhere to land (S746).',
          'A dish switched on for POS with no selling price is left off the guest menu and refused in a guest order until it is priced — it used to appear, and be orderable, at NPR 0 (S746). Admin → Guest Menu counts how many were left off.',
          'Admin → Guest Menu embeds this page with Place Order switched off, so previewing can never send a real order; guests\' phones are unaffected.',
          'If ANY dish in a guest\'s order has gone off the menu (sold out, switched off, price removed) since they loaded the page, the WHOLE order is refused and the guest is told which dish, by name (S754, owner decision). The page re-reads the menu and takes that dish out of their cart, saying so, so they can send the rest. Every refusal now has its own plain sentence rather than a generic error.',
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
          { label: 'Revenue Impact', desc: 'The ranking figure: discount amounts + voided bills\' menu value + comps\' POTENTIAL sales value — one coherent would-have-been-revenue unit, all BEFORE VAT since S754 (owner decision). VAT on a sale that never happened was never your money, and counting it made a void look about 13% bigger than a discount on the same food.' },
          { label: 'Comp food cost', desc: 'What a comp actually cost in ingredients (matching the printed Complimentary Slip). Kept in its own column and NEVER added into a revenue total — cost and forgone revenue are different units.' },
        ],
        formulas: [
          'Void value = the voided bill\'s menu value EXCLUDING VAT (it included VAT before S754). Comp potential sales value is ex-VAT too; a discount is already pre-VAT, because it comes off the bill before VAT is worked out. Example: a NPR 1,000 (before VAT) dish voided counts NPR 1,000, not NPR 1,130.',
          'Item-comp events group one billing action into one row (one NC number), however many lines it comped.',
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
          'The IRD-compliant reversal instrument: issue a credit note against a paid tax invoice (always the WHOLE bill), and browse/reprint the numbered Credit Note Book. Issuing a note also tries to take that bill\'s revenue back out of Inventory, into the period that is open TODAY. If it cannot, the note is still valid and printed — it is simply marked as waiting, and a manager posts it later from Periods.',
        workflow: [
          'Issue New: find the bill (type its invoice number, or browse the date range — only paid bills not already credited are listed), write the reason (typed freely; three shortcut buttons fill in Wrong customer / Tax correction / Duplicate bill), check the buyer details, answer "Was money returned to the customer?", then Issue & Print.',
          'Money back (S754, owner decision — asked on every note, because a Credit Note fixes the VAT record but says nothing about the cash drawer): Cash = handed back from the till, recorded as a Refund on the open shift so the drawer count expects it (needs an open shift — checked BEFORE the note is issued); Other = returned by card, QR or bank, nothing taken off the drawer; None = no money returned. The answer is stored with the note and shown in the Credit Note Book\'s Money Back column — it is not printed on the note (S755).',
          'Loyalty: issuing the note takes back the points that bill earned and gives back any points the customer spent on it. A customer\'s balance can go below zero if they already spent the points the bill earned — that is the true position.',
          'If there is no open Inventory period for this month (or the month is already closed, or the save fails), the note is STILL issued, numbered and printed. The screen says it is "not yet in Inventory", the note carries a "Not in Inventory" badge in the Credit Note Book, and an amber banner on the POS floor counts the waiting notes.',
          'To post a waiting note: open its month in Periods and press "Post POS bills to Inventory" on that month — the same button that posts waiting bills. Safe to press twice; a note that already posted is skipped, never taken off twice.',
          'Credit Note Book: every issued note, reprintable with its print count.',
        ],
        fields: [
          { label: 'Whole-bill only', desc: 'Partial credits are not supported — which is exactly why "Price correction" and "Billing error" are not among the shortcut buttons: both invited fixing one wrong line by crediting the whole invoice. Correct a wrong bill by crediting it entirely and re-ringing it right. The reason box itself accepts any text and cannot be left empty.' },
          { label: 'Not in Inventory (waiting)', desc: 'The note is a valid, numbered, printed document, but Inventory still counts that bill\'s revenue — for example, a note issued on the 1st of a new month before anyone opened that month in Periods. Sales in Inventory reports stay overstated by that bill until the note is posted.' },
        ],
        formulas: [
          'CN face value = the bill total minus any item-comped lines (those never posted revenue, so there is nothing of theirs to reverse).',
          'Inventory reversal = the exact negative of what the bill posted: one minus-quantity sales row per paid item, at its price reduced by the bill\'s discount share. Comped items are skipped. Example: a NPR 1,000 bill (before VAT) with a NPR 100 discount takes NPR 900 back out, not NPR 1,000.',
        ],
        gotchas: [
          'An invoice-number search deliberately ignores the date pickers — "customer came back with last week\'s bill" is the normal case, and the pickers default to today.',
          'The note is numbered in the fiscal year it is ISSUED, not the bill\'s — a post-Shrawan note never writes into a closed FY\'s number series.',
          'The reversal lands in the month the note is ISSUED, not the bill\'s month — last month\'s closed figures stay closed. A waiting note posts into the month it was issued in, not the month someone finally presses the button.',
          'Stock is never touched — the food was served. A credit note corrects money and tax only.',
          'If the note\'s month has already been closed, only an admin can post it from Periods, and that month\'s frozen Monthly Report then needs Regenerate Snapshot to reflect it.',
          'Manager-only is enforced by the database too (S754): a Supervisor cannot issue or link a note, the issuer is recorded by the server, and an issued note can never be edited or deleted — only its print count and Inventory posting mark change afterwards. A bill is credited once.',
          'If the cash refund or the loyalty reversal fails AFTER the note is issued, the note still stands (it is a numbered tax document) and a warning says what now reads wrong and where to fix it — e.g. add the refund as a Cash Out on the shift.',
          'The amounts are checked against the bill by the database (S755): gross against the bill\'s charged lines, discount against the bill\'s discount, net against what the bill was paid, and VAT only where there is a taxable base. A note whose figures do not match is refused before it is numbered. Notes issued before S755 with Other or None still carry "(no money returned)" or "(money returned by card, QR or bank)" in their reason — a printed tax document is not rewritten.',
        ],
        connections: 'Takes Orders\' posted revenue back out of IMS Sales Entry (as negative sales rows); waiting notes are posted from Periods → "Post POS bills to Inventory" and counted on the Orders floor. A cash refund posts to the open shift\'s drawer; the loyalty reversal lands in the customer\'s points ledger. Sales Report (since S754): the credited bill stays at full value on its own day, and the note is a MINUS row on the day it was issued, on every tab. Covers Report keeps the bill\'s covers and nets the return off revenue on the issue day. A credit-noted Credit bill leaves Customers → Outstanding. Numbering shares the per-FY series machinery with tax invoices.',
      },
      {
        id: 'sales-report',
        title: 'Sales Report',
        route: '/pos/sales-report',
        plan: 'Manager only',
        summary:
          'The full POS sales picture in eleven tabs: Daily, Hourly, Bill Register, Comped Bills, Payment Summary, Delivery Partners, Category Wise, Product Type, Item Wise, Customer Wise, and the 1L+ Report. Excel export with the company letterhead on every tab.',
        workflow: [
          'Pick the date range; every tab except 1L+ is a different slice of the same bills. Payment Summary rows click through to a pre-filtered Bill Register.',
          'The 1L+ tab works on a whole FISCAL YEAR, chosen from its own Fiscal Year dropdown — the date range does not apply to it. It lists buyers whose paid bills in that year cross NPR 1,00,000 — the IRD Annexure 13 disclosure threshold — and flags a buyer over the line with no PAN recorded. That threshold is one reason buyer names are mandatory on credit and discounted bills. Since S754: every bill counts in the year it was sold and returns issued in the year are netted off; a party billed once WITH a PAN and once by name only is treated as one party (owner decision); and the walk-in row (all the unnamed customers added together) is never flagged "Missing PAN".',
        ],
        fields: [
          { label: 'By Partner rollup (Delivery Partners tab)', desc: 'One row per delivery platform — outstanding balance, commission taken, net received — plus the effective commission rate measured against the agreed one. The rate is the point: without it the tab can say how much a platform withheld but never whether that was the agreed amount. Clicking a row filters the bills, the KPIs and the export to that platform.' },
          { label: 'Date / Time (BS) column', desc: 'On the three bill-level tabs (Bill Register, Comped Bills, Delivery Partners) each row carries the order-opened and bill-paid clock times under its date. The row date is the PAID date, since that is what the report ranges and totals on, so an order opened on an earlier day shows a date on both times rather than leaving the reader to infer one. Opened comes from the server (pos_orders.opened_at, a DEFAULT now()). Paid (closed_at) came from the till device until S754; since migration 20260916100000 the server stamps it too. On older bills they are two different clocks, so a till set wrong can have recorded a close before its own open — that is flagged with a warning glyph past a minute of tolerance and both values are still shown exactly as recorded, never reordered. Every time is rendered in Nepal time regardless of the viewing device\'s timezone.' },
          { label: 'Product Type tab', desc: 'Three axes the data already carries: Kitchen vs Bar (the same ticket-routing categories that drive the printers, so the report and the tickets cannot disagree), VAT vs non-VAT as billed, and Veg vs Non-veg from the recipe flag.' },
        ],
        formulas: [
          'Every tab derives from ONE bill-math primitive: a grouping key over the same proportional-discount arithmetic, so any slice — category, item, hour, customer — reconciles exactly back to bill totals. A new slice is a new grouping, never a second copy of the math.',
          'Returns (S754, owner decision): a credit-noted bill stays at its full value on the day it was sold, and the Credit Note is a MINUS row on the day it was ISSUED — on every tab, 1L+ included, at the note\'s own printed figures. Example: a NPR 2,000 bill on Monday credited on Wednesday shows +2,000 on Monday and −2,000 on Wednesday, so both days match their Z-reports. (Before S754 the bill vanished from Daily entirely and the reversal appeared nowhere.)',
          'Split payments (S754, owner decision): a Split bill is spread across the methods it was actually paid with, in proportion to each part — NPR 600 cash + NPR 400 eSewa on a NPR 1,000 bill shows NPR 600 under Cash and NPR 400 under eSewa, not NPR 1,000 under a "Split" line. So Payment Summary\'s Cash ties to the shift Z-report. A split bill whose parts were never recorded shows as "Split (breakdown missing)".',
          'Effective commission % = settled commission ÷ ex-VAT settled base — the same base Customers settles on, never the VAT-inclusive total (that would read about 13% low on every bill and accuse every platform of over-charging). Outstanding bills are excluded from both sides of it.',
        ],
        gotchas: [
          'A Product Type axis that could only produce a single row is hidden rather than rendered — so an axis you expected but don\'t see usually means the data can\'t split it (e.g. no bar categories configured), not a fault.',
          'All reads are paged — a busy month\'s line items far exceed the database\'s silent 1,000-row page, and the 1L+ tab in particular must never drop a party below a statutory disclosure line. Since S754 the long id lists are also sent in chunks; before that the 1L+ read could not succeed at all on a real client\'s year.',
          'Day boundaries are Nepal\'s (S754): a bill closed at 00:15 in Kathmandu lands on the same day for a viewer abroad, and the pickers default to Nepal\'s today. Excel is disabled while a range is still loading, or when the company-name read for the letterhead failed.',
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
          'Seats and sitting patterns — for DINE-IN bills only since S754 (owner decision); takeaway and delivery get their own separate line on Overview: covers and average spend per cover, daily trend, table turnover time banded by party size, peak hours, per-server figures, RevPASH (revenue per available seat-hour), and a Reservations tab — booked vs walk-in covers, the no-show rate, and bookings by source and by the hour they were made for.',
        workflow: [
          'Pick the range; the Turnover tab bands sittings by party size (1-2 / 3-4 / 5-6 / 7+) because one blended average dine-duration tells a manager nothing.',
          'Reservations: bookings whose BOOKED time falls in the range. Kept = seated or completed; no-show rate = no-shows ÷ (kept + no-shows), so cancelled and still-open bookings neither help nor hurt it.',
        ],
        fields: [
          { label: 'RevPASH', desc: 'Revenue ÷ (total seats × open hours). Needs the opening and closing time set (editable inline on the report); left unset, that one card hides rather than blocking the rest. Total seats = the capacity sum from Table Management.' },
        ],
        formulas: [
          'Spend per cover = dine-in bill revenue, net of dine-in returns issued in the range ÷ dine-in covers, over the same discount-aware bill math as the Sales Report.',
        ],
        gotchas: [
          'Credit-noted bills are KEPT (S754): a Credit Note corrects the bill, not the fact that the guests sat down, so their covers, party size and turnover still count. The return nets off revenue (and revenue per cover / RevPASH) on the day the note was issued — the Sales Report\'s rule, so the two never disagree about a reversed evening. Before S754 the whole bill was dropped, taking real guests out of the covers.',
          'Why dine-in only: a takeaway bag has no covers and no table time, so it only dragged the per-cover and turn-time figures around. A tab left empty because the range held only takeaway says so.',
          'Reads are paged; truncation here would not just shrink totals, it would skew the averages the report exists for.',
        ],
        connections: 'Covers come from Orders\' cover counts; capacity from Table Management; revenue math shared with the Sales Report. The Turnover tab\'s per-band averages are the same arithmetic (coversMath.js) the Reservations settings show as "Measured", so the two can never disagree. Booked-vs-walk-in reads the order link a seated booking carries.',
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
          'Manage Roles: add as many custom job titles as the house uses (Captain, Head Waiter, Cashier…) and map each one to a permission level — Staff, Supervisor or Manager. Changing a title\'s level cascades to everyone holding it; "Reset to defaults" returns to the plain Staff / Supervisor / Manager titles.',
        ],
        fields: [
          { label: 'The three ranks', desc: 'Staff: take orders on the floor, Kitchen Display, Reservations, view Parking Slips. Supervisor: + the Payment button (close bills, discounts, comps), Recent Bills and reprints, Customers & Credit settlement, open/close Shifts and Cash In/Out, issue Parking Slips. Manager: + Table Management and every till-setup list, Menu Pricing, loyalty schemes, all reports, Credit Notes and cash refunds, POS Staff, tablet setup. Owner only: the invoice prefix, VAT number and VAT registration, property address/phone and the payment QR printed on bills. Since S754 the database enforces every one of these, not just the screens.' },
          { label: 'What a POS Manager cannot do (S754)', desc: 'Change their OWN login or another Manager\'s (role, PIN reset, delete) — that is the Owner\'s job. Make anyone a Manager — only the Owner (or admin) can. Give a Discount Limit higher than their own, or "no limit" if they have one, or tick Allow Void if they cannot void themselves. A new login a capped Manager creates starts at that Manager\'s own limit. Why: otherwise a manager capped at 10% could give a waiter an unlimited discount and then use the waiter\'s PIN.' },
          { label: 'Allow Void', desc: 'Deliberately a per-person switch, NOT a Supervisor power — promoting someone to Supervisor does not let them void, and the checkbox is the only thing that does. It once looked like a rank power on paper, and managers promoted people to grant it, got Supervisors who still couldn\'t void, and no error explained why.' },
          { label: 'Team (FOH / Kitchen / Bar)', desc: 'Which station, not how much power — a Kitchen or Bar account sees only the Kitchen Display regardless of rank, and is locked to its own ticket queue there.' },
        ],
        formulas: [],
        gotchas: [
          'Never give the OWNER\'s own login a pos_role — Owner status is the absence of staff roles, and assigning one demotes them to that rank\'s access. The owner is not on this list; the list is for staff.',
          'Updating one switch never resets the others — each field saves independently, so setting a Discount Limit cannot quietly wipe someone\'s role or team.',
          'Discount Limit and Allow Void are enforced server-side at close, not just in the till screen — a staff session cannot exceed them from a modified browser. Admin and Owner are exempt from both by design.',
          'A Manager refused an action here is shown why in plain words ("ask the account owner"). Needs the S754 admin-user-ops deploy; until then the old rules apply.',
        ],
        connections: 'Ranks gate every POS page (chips throughout this guide); the two switches bind Orders\' billing modal and the server-side close guard; teams bind the KDS and which POS pages a station account can reach at all. Linked HR employees keep one identity across modules. PIN lockout resets land here.',
      },
    ],
  },
]
