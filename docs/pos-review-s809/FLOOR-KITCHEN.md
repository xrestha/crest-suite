# FLOOR-KITCHEN — tables, the Kitchen Display, ticket routing and the guest-order alert
Files reviewed (22): `src/modules/pos/kds/KitchenDisplay.jsx` (all), `src/modules/pos/kds/EstimateTimeModal.jsx` (all), `src/modules/pos/posChime.js` (1-82), `src/modules/pos/posSignals.js` (1-60, 80-175), `src/shared/chunkReload.js` (1-70), `src/modules/pos/tables/PosTableManagement.jsx` (1-400, 840-900, 1165-1260), `src/shared/hooks/useGuestOrderAlerts.js` (all), `src/shared/hooks/useNavBadgeCounts.js` (all), `src/shared/posTeamAccess.js` (all), `src/components/Layout.js` (600-640, 900-970, 1325-1345), `src/components/ArrivalAlert.jsx` (grep), `src/components/ArrivalAlert.css` (1-40), `src/components/Layout.css` (grep `--arrival-alert-h`), `src/components/Modal.js` (grep), `src/App.js` (96-170, 317-335), `src/modules/pos/orders/PosOrders.jsx` (153-162, 215-226, 415-461, 520-545, 1030-1112, 1195-1290, 1425-1450, 1612-1630, 1700-1885, 2160-2240, 2400-2660, 3505-3560, 3880-3962, 4015-4195, 5286-5300, 5440-5470, 5660-5800), `src/modules/pos/orders/posOrderPrintHtml.js` (grep: table name, CHANGE ONLY, VOID), `src/modules/pos/dashboard/PosDashboard.jsx` (128-136), `src/modules/pos/reports/KotLog.jsx` (76-232), `src/modules/pos/reports/SalesReport.jsx` (280-306), `src/pages/Settings.js` (400-475), `src/shared/nepalTime.js` (200-216), `src/modules/pos/login/PosLogin.jsx` (grep); also `CHANGELOG/S754-S803.md` (S763), `POS_DECISIONS.md` (S289 KDS, S577, S763), `POS_TODO.md` (all), `.claude/rules/pos-reservations-alerts.md`, `.claude/rules/settings-row.md` (246-252); live: `pos_tables_guard_rank`, `pos_tables_guard_open_order_delete`, every trigger on `pos_tables` / `pos_kot_log` / `pos_kot_removals` / `pos_guest_order_requests`, every constraint and FK touching `pos_tables`, `pos_kot_log` and `pos_kot_removals` (`confdeltype`), `pos_tables` / `pos_kot_log` indexes, `pos_kot_log` / `pos_tables` / `pos_kot_removals` / `pos_guest_order_requests` columns and defaults, a `pg_proc` search for every function body naming `pos_kot_log`, the inactive check in `submit_guest_order`, `submit_reservation_request`, `get_booking_availability` and `reservation_hour_load`, `settings.pos_bot_categories` at both POS clients, live table-status drift, `pos_kot_log` status × order status (with send dates), the tickets of every voided order and who closed it, pulls matched against stuck New tickets, every guest-order request's wait and who decided it, PIN logins and registered tablets per POS client.

Checked and sound, so the next review can skip them: `pos_tables_guard_rank` (live) is SECURITY INVOKER with `search_path`; a `status`-only UPDATE passes on `to_jsonb(NEW) - 'status' = to_jsonb(OLD) - 'status'` and every other INSERT/UPDATE/DELETE goes through `pos_caller_has_rank('manager')`, admin exempt with `COALESCE`. One correction to the reviewer: the admin test (`COALESCE(public.is_admin(), false)`) runs BEFORE the cheap status test, so every status flip makes one `is_admin()` lookup. That costs almost nothing, but it contradicts `pos-billing.md:537` ("returns before any identity lookup"); see DOCS below. `pos_tables_status_check` limits status to available/occupied/reserved/inactive. `pos_tables_guard_open_order_delete` (DEFINER, `search_path`) refuses to delete a table with an open bill, and steps aside when the client itself is being deleted. POS Setup's delete reads for an open bill first and refuses when that read fails. It checks `.select('id')` for a silent RLS zero, and its confirm names all three references: bookings lose the table (`pos_reservation_tables.table_id` is CASCADE live); a table that ever took a QR order is refused (`pos_guest_order_requests.table_id` is NO ACTION live); past bills keep their name. `pos_kot_log.order_id` is CASCADE, so Clear Occupied takes its tickets off the board. `pos_kot_removals.order_id` is SET NULL, with order no and table snapshotted. `submit_guest_order` refuses an `inactive` table (S746, read live), and `submit_reservation_request` leaves inactive tables out of the room's seats (read live).

The Kitchen Display:
- reads tickets and pulled lines paged (`fetchAllRows`, unique `id` tiebreaker) over the Nepal service day (`serviceDayStartIso`, midnight of the BS day six hours back);
- on a failed poll, keeps the last good board and the last good cancellations, and says so;
- skips re-rendering when nothing changed, using a signature that includes the derived `removalSig`;
- resets the chime bookkeeping on a station switch (but see FLOOR-KITCHEN-6 for an in-flight load);
- writes every stage change conditional on the stage it last saw, with `.select('id')`, then reverts and explains a refused tap;
- attributes a pulled line to the latest matching ticket by recipe AND selection key, and spills a large pull across tickets;
- shows a line's choices and its kitchen note;
- uses one shared `AudioContext` (`posChime.js`);
- is guarded at `hasPosAccess('staff')` after its hooks (`:348`).

A kitchen or bar `pos_team` login is locked to its own station. The Estimate dialog renders inside the KDS's fixed layer (`Modal` does not portal), so its default z-index is correct. The floor's KOT-stage poll keeps last-good on a failed read and ignores cancelled tickets: `.neq('status','cancelled')` is safe, because `pos_kot_log.status` is NOT NULL, default `'new'`. "Served" on the order screen is conditional on `ready`. `useGuestOrderAlerts` keeps the last list on a failed poll, re-renders only when the set of ids moves, and its mute leaves the banner up. One correction to the reviewer: on an operator's client switch it does not clear the previous client's list until the new client's first poll succeeds. That is an operator-only edge that needs a failed read, and it is not filed. `useNavBadgeCounts` starts each client at 0 and keeps last-good per count.

POS Setup's settings tabs (routing, notes, discounts, delivery, reservations, HSC):
- stay "not loaded", with Save disabled, after a failed read;
- never fall into an INSERT after a failed read of the existing row.

Quick Setup is hidden while the floor read has failed. No live client has an empty `pos_bot_categories` today: both POS clients, BLOOM CAFE and BLOOM CAFE - PKR, hold NULL. There is no table-status drift live: all 15 tables are `available`, with no open order. The KDS ticket states have no server-side guard at all (`pos_kot_log` has no trigger and a same-client `FOR ALL` policy). DATABASE-1 owns that and it is not filed again here.

### FLOOR-KITCHEN-1 [P2] A guest QR order waiting for Accept is never announced loudly on a till. The repeating alarm is off on the Orders screen: the floor chimes once, and while a table's order is open the screen shows nothing about other tables. A till resting on the PIN screen hears nothing at all.
- Where: `src/components/Layout.js:939` (`guestAlertRoute = location.pathname !== '/pos/orders' && location.pathname !== '/pos/kds'`), `:940-949` (the repeating alarm); `src/App.js:156` (`/pos/login` is declared outside `<Layout>`, `:169`); `src/components/Layout.js:617, 631-636` (a PIN till signs out to `/pos/login`; idle lock after `POS_IDLE_LOCK_MS` = 3 minutes, `src/modules/pos/usePosIdleLock.js:15`); `src/modules/pos/login/PosLogin.jsx:152` (sign-in lands on `/pos/orders`); `src/modules/pos/orders/PosOrders.jsx:536-540` (the till's own 5 s poll); `:1075-1090` + `:1108` (one soft `playChime()` per new request, none on the first poll); `:4164-4186` (the order screen's only guest UI, for `activeTable.id` only); `:5444-5463` (the floor-view banner).
- What happens: a quiet 3 PM at a café with two tills on Staff PINs and a Kitchen Display. Both tills have idle-locked to the PIN screen. A couple at Table 7 scans the QR code and orders 2 × Chicken Chowmein and 2 × Lemon Soda (NPR 820). Nothing sounds anywhere:
  - the PIN screen is outside the app shell and has no session;
  - the KDS suppresses guest orders by design;
  - the Owner is not signed in.

  A waiter signs in eight minutes later. The till opens on Orders, where the shell alarm is off, and the floor's first poll deliberately does not chime for a request that was already waiting. Only a banner on the floor shows it. In service, the cashier may have Table 2's order open when Table 7 orders. The till then plays one soft two-tone chime and shows nothing about Table 7, because the order screen's banner is only for the table on screen; the chime never repeats. A floor view left open on an email-login till with nobody near it also gets one chime, which is the "single chime into an empty room" the S763 owner decision was taken to end. The Billing station (`/pos/billing`) is the one till screen where the repeating alarm does run (but see FLOOR-KITCHEN-10). So in a PIN-run restaurant, the repeating alarm sounds only on a device that is signed in with an email login, is on some other page, and is awake in someone's hand.
- Evidence: `const guestAlertRoute = location.pathname !== '/pos/orders' && location.pathname !== '/pos/kds'`. The reason given beside it is "/pos/orders — has the floor banner, the per-table 🔔 chip and its own chime". All three live in the floor return (`:5286` onward); none is in the order return (`:4068-5285`), whose only guest UI is `{activeTable && (pendingGuestOrders[activeTable.id]?.length > 0) && …}`. The chime code is `if (guestOrdersLoadedOnce.current && rows.some(r => !seenGuestRequestIds.current.has(r.id))) { playGuestOrderChime() }` with `function playGuestOrderChime() { playChime() }`. `playChime` is the one-shot chime the rules reserve for "an event a person is already sitting in front of". `<Route path="/pos/login" element={<PosLogin />} />` is declared above `<Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>`, and `PosLogin.jsx` has no poll and no sound. `useGuestOrderAlerts` is called only from `Layout.js:940`. The S763 record backs the reading: CHANGELOG S763 (`S754-S803.md:4319`) says "`/pos/orders` already answers it better (floor banner, per-table chip, its own chime)", and its live check (`:4358`) found the banner "absent on `/pos/orders`, where the floor's own banner shows". Only the floor view was considered or checked.
- Status: NEW. The route suppression was a deliberate S763 choice, recorded under the session's "Decisions worth keeping". It is not one of the owner decisions listed in `POS_DECISIONS.md:222`. Nobody wrote down three consequences:
  - the owner decision that the alert "repeats until acted on" does not run on the one screen PIN tills rest on;
  - the order view is not covered by the floor's banner;
  - a locked till is outside the shell entirely.
- Fix:
  - (a) Suppress the shell banner on `/pos/orders` only while the FLOOR view is showing. PosOrders can publish its view through a small context or a `data-pos-view` attribute the shell reads. The order view then gets the shell banner for other tables. It must pad its top by `--arrival-alert-h`, as the KDS does (`KitchenDisplay.jsx:390`), or the banner covers its Back button: that padding is FLOOR-KITCHEN-10's fix and is needed first.
  - (b) Make the floor's own sound repeat: `playGuestAlert` on `REPEAT_MS` while any request is pending. It should also sound on the first poll when a request is older than a few seconds.
  - (c) Give the PIN screen a device-key RPC on the `get_pos_device_staff` pattern. It returns only the count and the oldest age of pending guest requests for the bound outlet, is polled every 15 s, and raises `ArrivalAlert` there. Migration needed for (c), and it is an anon-reachable function, so it needs the device-key check and nothing else in its answer.
- Decision: should a locked till announce a guest order?
  - (1) Yes, through a device-key RPC on the PIN screen. Recommended, because the PIN screen is every PIN till's resting state.
  - (2) No; let the Kitchen Display raise guest orders too. It stays signed in, and the cook can call the floor. The KDS would keep its own banner with no Accept.
  - (3) No change, and tell restaurants in Help that one email-login device must stay on a non-Orders page.

  Recommend (1), with (a) and (b).
- Confidence: confirmed by reading (route table, both returns, the poll and both sound helpers). Live frequency measured; not pressed live.
- Verified: re-read `Layout.js:929-949`, all of `useGuestOrderAlerts`, PosOrders' poll and `loadPendingGuestOrders`, both returns, the App.js routes, PosLogin (no poll, no sound), and the S763 CHANGELOG, `POS_DECISIONS.md` and `pos-reservations-alerts.md:172-175`. S763 did leave the alarm off on Orders on purpose, but only on the strength of the floor view. No recorded decision considers the order view, the non-repeating floor chime or the PIN screen.

  How often it bites, measured live:
  - 11 guest requests ever, all at BLOOM CAFE, every one decided by an email login (Owner or operator) and none by a PIN login.
  - Median wait 0.9 min. The one long wait (61.7 min, 2026-09-16 07:36 NPT) is the order that opened S763; the three since S763 waited 0.8–1.2 min.
  - BLOOM CAFE has 2 PIN logins and 1 registered tablet that has never been used (`last_used_at` NULL).

  So the gap has never bitten live. It opens at the first outlet that runs PIN tills and QR ordering together: for every guest order placed while every till has idle-locked (3 untouched minutes, the normal state in a quiet hour) and no awake email-login device is on another page. In service, the order-view gap lasts only until the waiter goes back to the floor, usually a minute or two. CONFIRMED, P2 kept.

### FLOOR-KITCHEN-2 [P2] When every dish on a kitchen ticket has been taken off the order, the ticket stays in New. The Kitchen Display keeps sounding for it and turns it red as late. The only way to clear it is to "Start" and then "Ready" food that does not exist, which tells the floor the table's food is waiting.
- Where: `src/modules/pos/kds/KitchenDisplay.jsx:329-336` (`alertOn = newTickets.length > 0` over every New ticket), `:342-346` (the 20 s repeat), `:526-545` (a pulled line is drawn "Cancelled", but the card keeps its Start/Ready/Served button, `:571-578`), `:482-486` (lateness from `sent_at`, whatever the ticket holds); `src/modules/pos/kds/EstimateTimeModal.jsx:46-55` (the Start dialog lists every line with no cancellation mark and no choices); `src/modules/pos/posSignals.js:91-100` (`summarizeTicketStages` counts the ticket); `src/modules/pos/dashboard/PosDashboard.jsx:133` (counts New and In Progress tickets). Live: no trigger on `pos_kot_log`, and the only SQL bodies that name `pos_kot_log` are `get_guest_table_status` and `get_guest_order_progress`, so nothing ever closes a fully pulled ticket.
- What happens: at Table 4 the waiter fires KOT #57, "2 × Chicken Momo" (NPR 350 each). The guests asked for Veg Momo, so the waiter pulls the chicken with the reason "Wrong item fired" and sends 2 × Veg Momo. The KDS now shows two cards for #57 in New: the Veg Momo, and "~~2 × Chicken Momo~~ Cancelled 7:42 PM · Wrong item fired" with a Start button.
  - The cook starts the Veg Momo. The banner still reads "New ticket — #57 · Table 4 … Tap Start on the card to take it", and the three-note alarm repeats every 20 s.
  - At 8 minutes the card and the banner turn △ amber; at 15 minutes ▲ red. Mute buys five minutes.
  - To silence it, the cook must press Start on the empty ticket and pick a prep estimate in a dialog that lists "2× Chicken Momo" as if it were live. Then comes Ready, at which point Table 4's floor tile shows "1 ready" and turns green ("food in the pass, run it") for food nobody cooked. Then Served.

  Left alone, the ticket:
  - keeps the POS Dashboard's open/late ticket count up;
  - keeps Table 4's chip on "Sent" after everything real is served;
  - adds an uncooked ticket to KOT Log's prep times once someone clears it.
- Evidence: `const alertOn = newTickets.length > 0` where `newTickets = tickets.filter(t => t.status === 'new')`. The pulled-line branch renders `{nowQty === 0 ? (<s …>{i.qty} × {i.name}</s>) : …}` and `'Cancelled'`, but the card's footer is unchanged (`{action && (<button … onClick={() => isStartAction ? onRequestEstimate(ticket) : onAdvance(ticket, next)}>`). `EstimateTimeModal` maps `(ticket.items || []).map(i => … {i.qty}× {i.name} …)` and never reads `ticket.removals` or `i.options`. `pos_kot_removals` is written inside `save_pos_order_items`, which does not touch `pos_kot_log` (live `pg_proc` search).
- Status: NEW. The S754 owner decision ("a pulled or reduced line shows on the ticket that sent it, so the kitchen stops cooking it") is honoured line by line. Nobody wrote down what it means for a ticket with nothing left on it. The server half overlaps DATABASE-1: `pos_kot_log` has no trigger, so the "Clear" write below should be designed with DATABASE-1's trigger, which must then admit `new|in_progress → cancelled` from the KDS.
- Fix: in `KitchenDisplay.jsx`:
  - derive `allPulled` per ticket in `attachRemovals` (every line's removed quantity is at least its sent quantity);
  - leave such a ticket out of `newTickets`, `alertOn` and the late styling;
  - replace its action with "Clear", which writes `status: 'cancelled'` conditional on its current status (the same `.eq('status', prev).select('id')` shape as `advance`);
  - in the Estimate dialog, strike cancelled lines and show each line's choices.

  The floor (`loadKotStatus`) already ignores cancelled tickets, so the Clear write fixes the chip too. No migration beyond DATABASE-1's.
- Confidence: confirmed by reading; one live instance.
- Verified: re-read the alert, repeat, card and Estimate dialog code, `summarizeTicketStages` and the dashboard read, plus the live trigger list and the `pg_proc` search. Live, one ticket matches: 2026-08-19 08:16 NPT, a one-dish ticket whose dish was pulled after it was sent, still `new`. 10 of the 12 `new` tickets live are one-dish tickets, so on most tickets "every dish pulled" is a single pull. CONFIRMED, P2 kept.

### FLOOR-KITCHEN-3 [P2] Setting every menu category to Kitchen in POS Setup → Ticket Routing is saved and shown as saved, but every till keeps printing Beverage dishes on a Bar ticket and sending them to the Bar board
- Where: `src/modules/pos/tables/PosTableManagement.jsx:355` (`settingsData?.pos_bot_categories ?? ['Beverage']`) and `:376-392` (`saveRouting` writes `Array.from(botCats)`, i.e. `[]`). These are against `src/modules/pos/orders/PosOrders.jsx:426` and `:448` (`if (arr?.length) setBotCategories(new Set(arr))`, default `new Set(['Beverage'])` at `:224`), `src/modules/pos/reports/SalesReport.jsx:304-305` and `src/pages/Settings.js:423, 471`, all of which treat empty as `['Beverage']`.
- What happens: take a café with a few Beverage dishes and no bar; BLOOM CAFE has three on its till today. The cook makes the tea and lassi and signs in on the Kitchen Display with a kitchen-team login, which is locked to KOT.
  - The Owner opens POS Setup → Ticket Routing, flips Beverage from BOT to KOT and presses Save Routing: "Routing saved." Reopening the tab shows Beverage on KOT.
  - The tills read the stored `[]` as "use the default". A Masala Tea (NPR 60) still prints on a separate "BOT" ticket and lands on the Bar board, which nobody watches; the kitchen's screen never shows it.
  - Sales Report's Kitchen/Bar axis keeps counting it as Bar, under a Tip that calls it "the same split the tills print BOT tickets from, set in POS Setup → Ticket Routing".
  - A later rename of the Beverage category in Settings (`:471`) reads `[]` as `['Beverage']` and writes the new name back as a bar category.

  The routing screen offers no way to say "nothing goes to the bar".
- Evidence: POS Setup reads `const botArr = settingsData?.pos_bot_categories ?? ['Beverage']` (`??` keeps `[]`). The till reads `const arr = data?.pos_bot_categories; if (arr?.length) setBotCategories(new Set(arr))`, so an empty array leaves the `['Beverage']` default. Sales Report has `Array.isArray(...) && ....length > 0 ? ... : ['Beverage']`. Settings.js has "What the till routes to the bar today: a missing or empty list means ['Beverage'] there." Live: both POS clients hold NULL today, so nobody has hit it yet.
- Status: NEW. It shares lines `PosOrders.jsx:444-448` with ORDER-FLOW-1 (that mount read also drops its `error`); fix the two together.
- Fix: make `[]` mean "nothing to the bar", and only NULL mean the `['Beverage']` default, in every reader:
  - `PosOrders.jsx:426,448` (`if (Array.isArray(arr)) setBotCategories(new Set(arr))`);
  - `SalesReport.jsx:304`;
  - `Settings.js:423,471`;
  - the `imsGuideData.js:1533` and `settings-row.md:249-250` sentences.

  POS Setup already reads it that way. Alternatively, if the owner prefers empty to keep meaning the default, POS Setup must refuse to save an empty set and say why. No migration (no live row is `[]`).
- Decision: what should an all-Kitchen routing mean?
  - (1) Honour the screen: empty means everything goes to the kitchen. Recommended: it is what the manager chose and saw saved.
  - (2) Keep empty meaning Beverage to the bar, and make POS Setup refuse an all-Kitchen save with a sentence saying why.

  Recommend (1).
- Confidence: confirmed by reading.
- Verified: re-read every `pos_bot_categories` reader in `src/` (8 sites) and the two docs. Live: both rows NULL, and 3 Beverage dishes on BLOOM CAFE's till. Added the Settings rename consequence (`:471`). CONFIRMED, P2 kept.

### FLOOR-KITCHEN-4 [P3] A voided order's tickets vanish from the Kitchen Display without a word, mid-cook included, and nothing prints for the kitchen. A pulled dish, by contrast, is struck through with its reason.
- Where: `src/modules/pos/orders/PosOrders.jsx:3523-3534` (`scopedUpdate('pos_kot_log', { status: 'cancelled' }).eq('order_id', orderId)`: best-effort, `bounded`, `console.error` on failure); `src/modules/pos/kds/KitchenDisplay.jsx:128-130, 189-201` (`BOARD_STATUSES` excludes `cancelled`, so the card simply disappears). Live: `pos_kot_log` has no trigger, so a void that does not go through the till's `closeOrder` leaves its tickets live.
- What happens: Table 9 orders a Mixed Grill (NPR 1,450) and the cook starts it ("~18 min left"). Ten minutes later the party leaves and a supervisor voids the bill.
  - On the KDS the card just disappears from In Progress, with no "cancelled", no reason and no time.
  - The paper KOT is still on the rail. A cook who glances back sees an empty column, assumes a mis-tap or a refresh, and plates the grill from the paper ticket.

  A pulled dish, by contrast, stays on its ticket struck through with "Cancelled 8:05 PM · reason" (the S754 owner decision, "so the kitchen stops cooking it"). If the cancel write fails or times out (it is best-effort and only logged to the console), its tickets stay in New. So do the tickets of a bill voided any other way, such as a REST void (CHECKOUT-2). Either way they keep the KDS alarm going for the rest of that service day, for an order that no longer exists.
- Evidence: the KDS's own comment says "'cancelled' (set by PosOrders.jsx's closeOrder when the parent order is voided) … excluded entirely". The void path says "Best-effort by design … Failure leaves a cancelled order's ticket on the kitchen board accruing 'late' alerts, which is worth a console line." `posOrderPrintHtml.js` has no void or cancel slip.
- Status: NEW. The "vanish" behaviour dates from S289 ("nothing left for kitchen/bar to do with a ticket whose order no longer exists"). It is an engineering choice, and it predates the S754 owner decision about telling the kitchen to stop.
- Fix:
  - Show a voided order's tickets for a few minutes as "VOIDED — stop": read `cancelled` tickets that carry a recent cancel time, or keep them in their column struck through.
  - Stamp `status_updated_by` and a time on the cancel write.
  - Have the void print a one-line "VOID — Table 9 #57" slip through `printTicket` for each station that has a live ticket.

  Retrying a failed cancel, or surfacing it on the floor banner (`warnWrite`), closes the stuck-ticket half. A server-side cancel on void (a trigger on `pos_orders`, with DATABASE-1) would cover the REST path. Migration needed only for that last part.
- Confidence: confirmed by reading; live counts confirmed and re-read.
- Verified: re-read the void path. It is `bounded`, so a stall becomes a logged error rather than a hang; the reviewer's "stalls" is right in effect. Correction to the reviewer's live evidence:
  - Every ticket of an order voided through the till is `cancelled` (6 of 6; closers were the operator and the Owner).
  - The 2 tickets still `new` belong to one order voided 2026-08-19 11:10 NPT with no `closed_by`. That was the morning of the S577 REST smoke tests, so it was most likely voided straight through the API, not through `closeOrder`. It is evidence for the non-till half, not for a failed cancel write.
  - Those two are outside today's service-day window, so they are on no board.

  CONFIRMED, P3 kept.

### FLOOR-KITCHEN-5 [P3] A Ready ticket drops off the Kitchen Display after 10 minutes, but nothing marks it served. The floor keeps calling that table's food "Ready" and keeps its strip green for the rest of the meal.
- Where: `src/modules/pos/kds/KitchenDisplay.jsx:107-109, 350-354` (`READY_VISIBLE_MS`, display-only); `src/modules/pos/posSignals.js:91-111, 155-160` (`ready > 0` gives the "Ready"/"N ready" chip and the green "food in the pass" strip, which outranks "live and in hand"); `src/modules/pos/orders/PosOrders.jsx:1264-1274, 4142-4149` (Served exists only on the open table's order screen).
- What happens: Table 3's starters go Ready at 7:10 PM, and the runner takes them without tapping Served, the step S754 added. At 7:20 the ticket leaves the board, so the kitchen can no longer tap Served either. For the rest of the meal Table 3's tile shows "Ready" and a green strip, the one colour that means "food in the pass, run it". When the mains are sent the chip reads "1 ready" over a pass with nothing on it, and a waiter crossing the room walks to the pass for it. Only opening Table 3 and pressing ✓ Served clears it. The waiter who opens Table 3 to send the mains does see ✓ Served in the order screen's top bar, which softens it.
- Evidence: `const READY_VISIBLE_MS = 10 * 60 * 1000`, with the comment "this is display-only decluttering, not a delete". `if (foodReady) return 'var(--theme-green)'  // food in the pass, run it` comes ahead of `if (order || status === 'occupied') return 'var(--theme-accent)'`.
- Status: NEW. The S289 decision ("Ready tickets auto-drop from the board after 10 min") predates S754's Served; its consequence for the floor was not written down.
- Fix: when the KDS hides a Ready ticket past `READY_VISIBLE_MS`, write it `served` instead of only hiding it, conditional on `ready`, with `status_updated_by` set to the KDS login. Or have `summarizeTicketStages` treat a Ready ticket older than the same window as served, sharing the constant through `posSignals.js`.
- Confidence: confirmed by reading. No live instance since Served shipped.
- Verified: re-read the hide filter, the summary and the strip, and the order screen's ✓ Served button. Correction to the reviewer's live evidence: the 19 `ready` tickets on paid bills were all sent on or before 2026-08-14, before S754 added Served, when Ready was the last state a ticket could reach. Since Served shipped, all 11 tickets that reached Ready were served, within seconds, on test bills. The mechanism stands on reading alone. CONFIRMED, P3 kept.

### FLOOR-KITCHEN-6 [P3] The Kitchen Display's poll has no guard against an older answer landing last, and its taps have no time limit: on slow kitchen Wi-Fi a started ticket can jump back to New and re-sound, a station switch can paint the other station's tickets, and one stalled tap freezes that ticket's button until the page is reloaded
- Where: `src/modules/pos/kds/KitchenDisplay.jsx:260-263` (`setInterval(load, POLL_MS)` every 4 s with no in-flight or latest-request check), `:224-241` (the result is applied whenever it lands, and `seenTicketIds` is rebuilt from it), `:258-259` (a station switch resets the chime bookkeeping but not an in-flight load), `:275-308` (`advance` awaits `scopedUpdate` with no `withTimeout`; `advancing` is cleared only after it returns); `src/modules/pos/orders/PosOrders.jsx:1264-1274` (`markOrderServed`, the same shape: `servingTickets` is never reset if the write stalls).
- What happens: a kitchen tablet on a weak signal, where each poll takes 5–6 s.
  - The cook starts Table 6's ticket. A poll that left before the Start landed comes back afterwards and puts the card back in New. The newer poll had already dropped it from `seenTicketIds`, so the stale one plays the new-ticket alarm for it. The cook taps Start again and gets "This ticket was already moved, served from the floor, or cancelled".
  - A floor manager switches the board from Kitchen to Bar while a poll is in flight. They see the kitchen's tickets under the Bar heading for up to 4 s, and one of the two landings alarms for every ticket in New, because the seen-set holds the other station's ids.
  - A Ready tap's request stalls. That card's button stays "…" and disabled, even after the poll moves the card, until the KDS is reloaded (the KDS is exempt from the idle lock).
  - The floor's ✓ Served button behaves the same way. It then refuses every table on that till, until the till next idle-locks (within 3 minutes on a PIN till) or for good on an email-login till.
- Evidence: `useEffect(() => { const poll = setInterval(load, POLL_MS); … }, [load])`, with no `useLatestRequest` or in-flight flag in `load`. `seenTicketIds.current = new Set(newTickets.map(t => t.id))` runs on every landing. `const { data: moved, error } = await scopedUpdate('pos_kot_log', patch)…` is followed by `setAdvancing(prev => { … next.delete(ticket.id) … })` only after it resolves. `if (!orderId || !navigator.onLine || servingTickets) return`, with `setServingTickets(false)` only after the await. CLAUDE.md: "An overlapping load must not win the page" and "Wrap any await that blocks the user in `withTimeout()`".
- Status: NEW. ORDER-FLOW-5 is the same no-time-limit shape on Send/KOT/BOT; this finding owns the KDS taps and ✓ Served.
- Fix:
  - Give `load` a sequence number (or `useLatestRequest` keyed on `station` plus a counter), and drop any result older than the last applied one or for another station.
  - Skip a tick while a load is in flight.
  - Wrap `advance`'s and `markOrderServed`'s writes in `withTimeout`. On a timeout, clear the busy flag and re-poll; the conditional write makes a late landing harmless.
- Confidence: plausible. Traced in code; the out-of-order landing needs a slow link and was not reproduced.
- Verified: re-read the load, the interval and the station effects (effect order: the reset at `:258` runs before the reload at `:259`, so either landing order produces the spurious alarm), `advance`, and `markOrderServed`. Corrected "for the night": a PIN till's stuck ✓ Served clears at its next idle lock. CONFIRMED, P3 kept.

### FLOOR-KITCHEN-7 [P3] POS Setup lets a manager mark a table Inactive while it has an open bill. The floor tile then refuses every tap with no message, and billing it from the Billing station silently puts the retired table back in service.
- Where: `src/modules/pos/tables/PosTableManagement.jsx:323-336` (`setTableStatus` / `handleStatusChange` write any status with no open-bill check); `src/modules/pos/orders/PosOrders.jsx:5701` (`onClick={() => !inactive && openTable(t)}`, no message); `:1772` (`openTable`, no inactive check), `:1855-1880` (`billOrder` → `openTable(table, { existingOnly: true })`); `:4016-4027` (the Billing list includes any table with an order); `:3544-3547` (the close writes `status: 'available'` unconditionally); `:1724` (the till-lock restore refuses an inactive table); `:5451` (the floor's guest banner opens a table through `openTable`). Live `pos_tables_guard_rank`: a status-only change takes the cheap path for any login.
- What happens: Patio 2 has a party with NPR 2,340 on the bill. The manager, setting up for rain, marks Patio 2 Inactive in POS Setup.
  - The waiter taps Patio 2 on the floor to add desserts. Nothing happens and no message appears, though the tile still shows the bill.
  - A waiter whose till locked with unsent items for Patio 2 signs back in and is told "that table is no longer in use", although its bill is still open.
  - A cashier can still bill it from `/pos/billing`. When that bill closes, the till writes Patio 2 back to Available, so the table the manager retired is offered to the next walk-in and accepts QR orders again.
  - The floor's guest-order banner can also open an inactive table (GUEST's seam), with the same Available write at the close.
- Evidence: `const { error } = await scopedUpdate('pos_tables', { status: next }).eq('id', t.id)` runs with no read of `pos_orders`. The close runs `bounded(scopedUpdate('pos_tables', { status: 'available' }).eq('id', activeTable.id), 'Freeing the table')`. `if (!table || table.status === 'inactive') { setFloorMsg(… 'that table is no longer in use' …) }`.
- Status: NEW. The till-lock restore half was added by the verifier. GUEST's seam (the floor banner opens an inactive table) is the same gap and is folded in here.
- Fix:
  - In POS Setup, refuse Inactive (and Available) on a table with an open bill, reading `pos_orders` first the way `handleDelete` does.
  - Make the floor tile of an inactive table that still has a bill open the bill, or say "Inactive — bill it from Billing".
  - Let the till-lock restore put items back on an inactive table whose bill is still open.
  - Make the close's release conditional (`.eq('status', 'occupied')`), so it never overwrites Inactive or a manual Reserved.
  - Optionally, narrow `pos_tables_guard_rank`'s cheap path to `available`↔`occupied`, so only a POS manager can set `inactive`. Migration needed only for that last part.
- Confidence: confirmed by reading.
- Verified: re-read both status writers, the floor tile, `openTable`, `billOrder`, the Billing list, the release and the lock restore, plus the live guard body. CONFIRMED, P3 kept.

### FLOOR-KITCHEN-8 [P3] Nothing stops two tables sharing a name: Quick Setup's defaults recreate "Table 1–10" on a floor that already has them. A rename mid-meal splits one order's kitchen tickets and bill between two names.
- Where: `src/modules/pos/tables/PosTableManagement.jsx:31` (`QS_EMPTY = { prefix: 'Table', start: 1, count: 10, … }`), `:193-212` (`handleGenerate` inserts with no name check), `:228-243` (Add/Edit, no name check); live `pg_indexes`: `pos_tables` has only `pos_tables_pkey` and `idx_pos_tables_client_id`, with no unique name. `src/modules/pos/orders/PosOrders.jsx:2591` (tickets take `activeTable.name`), `:2194` (the order snapshots `table_name` only at its first save), `:3693` (the live bill prints `activeTable.name` first); `src/utils/viewPosBill.js:56` (a reprint prints `order.table_name`).
- What happens: a café with Table 1–10 adds a garden. The manager opens Quick Setup, types section "Garden", leaves Prefix "Table" and Start 1, sets Count 5, and presses Generate. A second Table 1–5 appears, and the preview line ("Table 1, Table 2 …") never says they already exist. From then on two KOTs can both say "Table 3", the runner cannot tell which, and Reservations, Covers and the Bill Register show two "Table 3"s. Separately, renaming Table 4 to "Garden 4" while it has an open order splits the order between two names:
  - later tickets and the printed bill say "Garden 4";
  - the stored bill, every reprint from the Bill Register and the order's earlier tickets keep "Table 4".
- Evidence: `const rows = Array.from({ length: count }, (_, i) => ({ name: \`${qs.prefix.trim()} ${start + i}\`, … }))`, then `scopedInsert('pos_tables', rows)`. No unique index live; 0 duplicate names today. The Quick Setup comment at `:1169-1170` records that "Table 1–10 got created twice" once before. S754 closed only the failed-read route to it.
- Status: NEW
- Fix:
  - Refuse a name already on the floor (trimmed, case-insensitive) in Quick Setup's preview and Generate and in Add/Edit, naming the clash.
  - Default Quick Setup's Start to one past the highest number already used with that prefix.
  - Back it with a unique index on `(client_id, lower(btrim(name)))`. Migration needed; 0 duplicates live, so it applies cleanly. Make the index partial (`WHERE status <> 'inactive'`) unless GUEST-7's rotatable QR token lands first: GUEST-7's only way to a new QR link today is to retire a table and add a second one with the same name.
  - Refuse or warn on a rename while the table has an open bill.
  - While in `handleGenerate`: its failure line says "The quick-service setting was not saved" for a failed table insert.
- Confidence: confirmed by reading; live index and duplicate count confirmed.
- Verified: re-read Quick Setup, Add/Edit, the four name sources and the S754 comment, plus live indexes and the duplicate count (0). Added the GUEST-7 interaction to the fix. CONFIRMED, P3 kept.

### FLOOR-KITCHEN-9 [P3] A Kitchen Display that the browser reloads or restores (a crash, a restored tab, a power cut) makes no sound at all until someone touches it, and nothing on the board says the sound is off
- Where: `src/modules/pos/posChime.js:11-12` ("staff reach these screens through a PIN login or a tap, so in practice the gesture has already happened"), `:41-49` (`getCtx` creates the context lazily on the first chime, not in a tap handler, and calls `resume()` without awaiting it: "if it is still blocked the notes simply do not sound"); `src/modules/pos/kds/KitchenDisplay.jsx:227-229, 342-346` (the new-ticket and repeat sounds); `src/components/ArrivalAlert.jsx` (no muted-by-browser state).
- What happens: the kitchen tablet's browser closes overnight and reopens the Kitchen Display from its restored tab in the morning. The login is still valid, so nobody types a PIN or taps anything. The first order of the day lands: the card and the banner appear, but the browser refuses to start the audio without a gesture on the page. Neither the new-ticket alarm nor the 20-second repeat makes a sound. That is exactly the "board with a ticket on it and nothing saying so" the S763 decision was taken to end. Sound comes back only after a cook happens to tap the screen. The same holds for the shell's guest-order alarm on any device that reloaded.
- Evidence: the code's own assumption quoted above; `if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {})`, with no state reported back to any screen. There is no audio-unlock listener anywhere in `src/` (grep for `resume()`/`AudioContext`/`pointerdown`).
- Status: NEW
- Fix:
  - Export a `soundBlocked()` from `posChime.js` (true when the context is not `running`).
  - When it is true, show a "🔇 Sound is off on this screen — tap anywhere to turn it on" strip on the KDS and inside `ArrivalAlert`.
  - Add a one-time `pointerdown` listener that creates or resumes the shared context INSIDE the tap, which also covers browsers that need the start to happen in a gesture.
- Confidence: plausible. It follows from the browsers' autoplay rules and the code's stated assumption, but was not measured on a real kitchen tablet. Chrome lets an installed app on Android, or a site with high media engagement on desktop, play without a gesture, so exposure varies by device.
- Verified: re-read `getCtx`, both KDS sound sites, `chunkReload.js` and the service worker. Nothing reloads a page on its own except after a failed chunk load, which follows a tap. Two additions:
  - S763's proof ("9 oscillators in a 24-second window, 0 contexts created") counted oscillator creation, which happens on a suspended context too. It shows there is no context leak, not that sound played.
  - On iPadOS Safari, which has historically required Web Audio to be started from a tap, the board may be silent even without a reload, because the context is first created from a poll callback. Not measured.

  CONFIRMED, P3 kept.

### FLOOR-KITCHEN-10 [P3] On the Billing station, a waiting guest order's banner covers the top bar of the bill being settled, until someone accepts the guest order: the ← Back button, the order number and the covers buttons. Mute leaves it there.
- Where: `src/components/Layout.js:939` (`/pos/billing` is not suppressed), `:1330-1343` (`ArrivalAlert reserveSpace`, "Open Orders" → `/pos/orders`); `src/components/ArrivalAlert.css:8-16` (`position: fixed; top: 0; … z-index: 3000`); `src/components/Layout.css:401` (only `.layout-root` pads by `--arrival-alert-h`); `src/modules/pos/orders/PosOrders.jsx:4068-4077` (the order screen is `position: 'fixed', inset: 0, zIndex: 1000`, with no top padding for the banner), `:4080-4094` (its top bar, at least 52 px, with "← Table" first); compare `src/modules/pos/kds/KitchenDisplay.jsx:390` (the KDS pads its header by the variable).
- What happens: at 8 PM the cashier at the counter works the Billing station. A couple at Table 7 scans the QR code and orders (NPR 820), and the waiter is busy.
  - The cashier taps Bill on Table 2 (NPR 2,340). The bill opens full screen, and the amber banner "New guest order — Table 7 … Open Orders · Mute" sits across its top, about 66 px high, over "← Table 2", the order number and the covers buttons.
  - Mute stops the sound and keeps the banner (by design).
  - To leave the bill, the cashier must either finish it or tap Open Orders, which jumps to the Orders floor. Nothing on the Billing station can accept Table 7's order unless Table 7 itself is the bill on screen.
  - Every bill opened there wears the banner until someone accepts the guest order, and it turns red after three minutes.
- Evidence: `const guestAlertRoute = location.pathname !== '/pos/orders' && location.pathname !== '/pos/kds'`. `.arrival-alert { position: fixed; top: 0; … z-index: 3000 }` is commented "Above the POS till layers (position: fixed at 1000)". `padding-top: var(--arrival-alert-h, 0px)` appears only in `Layout.css:401` (`.layout-root`) and the KDS header. The order return has `position: 'fixed', inset: 0, zIndex: 1000` and pads only its bottom. S762 shipped the Billing station one session before S763, and S763's live check covered Item Master, `/pos/orders` and `/pos/kds`, not `/pos/billing`.
- Status: NEW (found by verifier). Same root as FLOOR-KITCHEN-1's fix (a): the order screen never reserves the banner's height.
- Fix: pad the order screen's top bar by `var(--arrival-alert-h, 0px)`, as the KDS header does. It is one style change in PosOrders.jsx's order return, and it is the precondition for FLOOR-KITCHEN-1 (a). Optionally, give the Billing list an Accept for a waiting guest order (it is a supervisor screen). No migration.
- Confidence: confirmed by reading (both layers' CSS and the route test); not pressed live.
- Verified: verifier's own finding.

### Considered and not filed
- A kitchen or bar `pos_team` login on Dashboard (where the KDS's Exit sends it) gets the shell's guest-order alarm, with an "Open Orders" button that `ModuleGate` bounces back to the KDS. It is a dead-end button, but the sound may be useful in a kitchen; not a wrong action.
- `logKotSend` failing leaves a printed ticket with no KDS card and only a console line. That is deliberate best-effort (the KDS mirrors paper), and ORDER-FLOW checked the send paths.
- The Estimate dialog's double-tap: React flushes a click's state before the next click task, so `advancing` does guard it.
- A table deleted while a till is offline and holding a new order for it. The delete's open-bill checks read only the server, the replay's insert has no FK on `pos_orders.table_id`, and the order then shows on neither the floor nor the Billing list. Real, but it needs an offline till and a delete in the same window (DATABASE-7 covers the missing FK).
- Routing changed while a till is open: the till reads `pos_bot_categories` once per mount (`PosOrders.jsx:420-461`). Every PIN till remounts Orders at each idle-lock sign-in, so it catches up within minutes. Only an email-login till left on Orders all day keeps the old split.
- The KDS service-day window starts at midnight of the BS day six hours back, so a ticket sent at 11:50 PM stays on the board until 6 AM. REPORTS-11 covers the dashboards' different window.
- `useGuestOrderAlerts` keeps the previous client's pending list after an operator's client switch until the new client's first good poll (the `Layout` stays mounted; only `<Outlet>` is keyed on the client). It is operator-only and needs a failed read.

Seams for other areas:
- GUEST: `get_guest_order_progress` reads non-cancelled tickets (`k.status IS DISTINCT FROM 'cancelled'`, live). A dish pulled by a waiter (FLOOR-KITCHEN-2's ticket) therefore still shows on the guest's tracker as sent to the kitchen; check the tracker against `pos_kot_removals`.
- RESERVATIONS: deleting a table cascades `pos_reservation_tables`, and the confirm says bookings "lose this table" but not which ones. A booking that held only that table drops off the floor plan and is shown nowhere as table-less (also DATABASE's seam). Separately, live `get_booking_availability` and `reservation_hour_load` contain no `inactive` filter, while `submit_reservation_request` leaves inactive tables out of the seats. Check whether the public page can offer a slot that the submit then refuses as full (REPORTS' seam asked the same of `reservation_hour_load`).
- REPORTS: the POS Dashboard's "Tables in use" and POS Setup's own Occupied count read the stored `pos_tables.status`, which POS Setup's status picker can set to anything regardless of open bills (FLOOR-KITCHEN-7); there is no drift live today. KOT Log's prep-time figures include tickets cleared without cooking (FLOOR-KITCHEN-2).
- ACCESS: the status-only cheap path in `pos_tables_guard_rank` lets any login, a Staff PIN included, set a table `inactive`, which also blocks QR ordering on it. The S754 table records `status` as open to all, but `inactive` is a setup decision.
- DATABASE: the KDS's ticket stages have no server guard (DATABASE-1). FLOOR-KITCHEN-2's "Clear" and FLOOR-KITCHEN-4's server-side cancel on void should land in the same trigger.
- DOCS:
  - `.claude/rules/pos-reservations-alerts.md:172-175` says "Two routes suppress the shell banner … `/pos/orders` answers it better already". That is true only of the floor view (FLOOR-KITCHEN-1).
  - `imsGuideData.js:1533` and `settings-row.md:249-250` say "an empty routing list means ['Beverage'] on the till", which POS Setup contradicts (FLOOR-KITCHEN-3).
  - `posChime.js:35` still says "`playChime` above builds a NEW AudioContext on every call and never closes it", which has been false since S763.
  - `POS_DECISIONS.md:235` says the KDS banner fires on the 8- and 15-minute marks, "deliberately not on 'any unstarted ticket'". The same entry, the CHANGELOG and the code all say it fires on any New ticket.
  - `pos-billing.md:537` says `pos_tables_guard_rank` "returns before any identity lookup" on a status-only change, but the live body calls `is_admin()` first.

Old → new numbering: raw 1–9 keep their numbers; FLOOR-KITCHEN-10 is new (found by verifier).

## Rejected
None. All nine raw findings survived the adversarial check. Two carry corrected live evidence (4 and 5), one has its "for the night" claim narrowed (6), and two gained detail (3: the Settings rename; 7: the till-lock restore).
