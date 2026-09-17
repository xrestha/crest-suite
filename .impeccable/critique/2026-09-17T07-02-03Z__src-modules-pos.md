---
target: pos module
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-09-17T07-02-03Z
slug: src-modules-pos
---
Method: dual-agent (A: design review from source, no browser · B: detector + live browser on BHATTI CHOILA, Light and Dark, 1366 / 820-touch / 390-touch)

Limits: the billing modal, KDS ticket actions and the PIN pad were NOT measured live — BHATTI CHOILA had no open orders (opening billing requires a saved order), and enrolling the PIN pad calls register_pos_device (a write). P1s 1–3 are verified in source by the parent, not in the browser. Loading /pos/parking ran its approved stale-slip sweep once.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Idle-lock countdown renders underneath the order screen; payment ends with no closing statement (invoice no., amount, change) |
| 2 | Match System / Real World | 3 | Excellent domain vocabulary, but "Tender", "Voucher#", "Z-Report" reach waiters; one page is "Tables" / "Table Management" / "POS Setup" |
| 3 | User Control and Freedom | 2 | Cancel disabled during a close that has no timeout; idle lock discards the unsaved order without asking |
| 4 | Consistency and Standards | 2 | Classed controls get the 2px focus pair, unclassed till controls (tiles, qty ±, ×) the browser's 1px default; money formatted two ways; shift variance in three colour schemes |
| 5 | Error Prevention | 3 | Strong server guards, cash-shortfall block, stale-order check; but Void has no confirm and a table status badge cycles state on tap |
| 6 | Recognition Rather Than Recall | 3 | Reasons for disabled buttons live in hover-only Tips a tablet can't show; comp-reason select hidden in a collapsible section |
| 7 | Flexibility and Efficiency | 2 | Reports open on today with no BS-month presets; Enter in Tender does nothing; KDS Start is three taps |
| 8 | Aesthetic and Minimalist Design | 2 | Up to ~12 banners stack above the floor grid; Send Order and Payment are identical accent fills side by side |
| 9 | Error Recovery | 2 | ~17 till sites show raw Postgres/fetch text; a lost close response is blamed on another till |
| 10 | Help and Documentation | 3 | Tips everywhere, good empty states; Help points to a "POS Setup → Guest Menu" that doesn't exist |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment**: the vocabulary and paper are unmistakably local — KOTs print `+2`, `↓1 (now 3)` and `CHANGE ONLY — not a new order`; bills carry Date and Miti, TI/PB invoice series, Round Off and amount in words; Foodmandu/Pathao close as Credit; eSewa/Khalti/FonePay get a live QR; the drawer counts Nepali notes; comps have an NC series. The screens are not: the till is the generic tile grid + fixed 320px cart + four buttons, built from inline styles that skip the product's own focus pair, pressed states and type tiers, and the KDS uses 13–16px desktop type on a board read across a pass. Content-specific, interaction-borrowed.

**Deterministic scan**: `detect.mjs --json src/modules/pos` → exit 0, 0 findings across 77 files (July: 38). A canary file proved the detector reads .jsx, so the clean result is real. Live injection: order screen 12 findings (5 POS: "PAIRED" chip 9px; "Choices" and "+NPR 200/260" 10px; cramped tip-trigger), KDS 10 (3 POS: h1→h3 skip, ~86-char line, heavy-shadow empty card), Sales Report 7 (all shell). False positives: uppercase 10px micro-caps ("CREST POS", "VIEWING", "ADMIN") are the documented step.

Agreement: phone order screen (A predicted from `width: 320`; B measured a 70px menu column); unclassed till controls lacking the focus pair; report tabs and KDS station chips with no selected state for assistive tech; undersized table status badges.

Browser caught what source missed: browser-default grey placeholders (3.65:1 menu search, 3.44:1 "+ Kitchen note", Dark); "Pair with" 4.24:1 on Light only; note presets vanish on Tab; `/pos` overflows at 390px (scrollWidth 478) from an sr-only span escaping `.table-wrap`; the shell top bar runs past the right edge at 820px — parent confirmed on /dashboard too, so app-wide.

**Visual overlays**: injected on order screen, KDS, Sales Report; the [Human] tab was left on /pos/sales-report. Dev server stopped afterwards.

## Overall Impression

The most operationally mature module in the product — KOT delta tickets, shift reconciliation, offline order queue. It fails where PRODUCT.md says it matters most: the person on a shared device who won't report a bug. Biggest opportunity: the payment close, the highest-stakes tap in the app, can freeze, print late and say something false.

## What's Working

1. Printed documents settle floor arguments: KOT `+N`, `↓N (now M)`, CHANGE ONLY, REPRINT (posOrderPrintHtml.js:57); IRD-shaped bill.
2. Shift close is a real reconciliation instrument: Nepali denominations, live "Short by NPR X", sales re-read before write, short-close confirm while the drawer is open, "not known whether the shift closed — reload first" on a dropped connection.
3. Billing station (S762) is a list, longest-open first, with a Tip that says the total is "not today's takings"; at 820px Send/Payment sit in the thumb zone (y≈1073/1180) with the total visible; discard dialog takes focus and Escape keeps the cart.

## Priority Issues

**[P1] 1. Payment close can freeze, prints late, and blames "another till" for its own lost response**
- What: 0 `withTimeout` in PosOrders.jsx; Cancel disabled while closing (:4701); bill prints at :3266 after the Inventory stamp (:3209) and loyalty RPC (:3244); if the close UPDATE (:3090) lands but the response is lost, a retry hits `order_not_open` → "billed or voided on another till… nothing on this screen was saved" (~:4816). No closing statement on success.
- Why: the cashier is holding a guest; "Processing…" with no exit then a false message is "the app is broken".
- Fix: withTimeout on every close-path await; on timeout/network error re-read the order by id and, if closed by this session, finish the tail (print) instead of reporting a conflict; print right after the close UPDATE and move posting/customer/loyalty behind it via warnWrite; end with "TI-2238 closed · NPR 3,425 · change NPR 75".
- Command: /impeccable harden

**[P1] 2. Idle-lock warning hidden under the till; the lock discards the unsaved order**
- What: toast zIndex 400 (Layout.js:2024) vs order screen 1000 (PosOrders.jsx:3684); `usePosIdleLock(…, handleSignOut)` (Layout.js:573) bypasses the "Discard N unsaved items?" ask; cart is React state only.
- Why: a waiter at a table for 3 minutes returns to the PIN pad with no warning seen and the order gone.
- Fix: toast between till layers (1100) and ArrivalAlert (3000); snapshot the unsent cart before locking and restore it after sign-in; say on the PIN screen what was kept.
- Command: /impeccable harden

**[P1] 3. Confirm Payment goes dead without saying why**
- What: 8 disable conditions (PosOrders.jsx:4680); label explains 3. Discount without reason, required buyer ID, item comp without reason, all items comped → still reads "Confirm Payment — NPR X". Comp-reason select inside collapsible Items (4376–4420). Same shape: IssueCreditNoteModal Issue & Print; Payment on an unsent takeaway explained only by a hover Tip.
- Why: guest waiting, button looks ready, nothing happens.
- Fix: S759 aria-disabled pattern so the press runs closeOrder's existing messages (2829–2853) into closeMsg (already role=alert); relabel with the missing thing; auto-expand Items when the comp reason is the blocker.
- Command: /impeccable clarify

**[P1] 4. The order screen isn't built for a phone or a thumb**
- What: cart `width: 320` fixed (3905) → 70px menu column at 390px, cart overlaps tiles, tile-centre taps land on the cart, names cut to "COFFE". At 820 touch, 24 of 36 controls < 44px: remove × 15px wide, kitchen-note input 292×17, Pair-with dismiss 11px wide. Send/save failures print at 12px in the top bar (3747), far from Send.
- Why: PRODUCT.md's waiter is standing at a table, thumb-driven. Tablet mostly works; phone does not.
- Fix: under ~700px, menu full width + cart as bottom sheet with sticky Total + Send; 44px hit areas via padding; send errors as ActionError directly above Send.
- Command: /impeccable adapt

**[P2] 5. Till errors speak Postgres, aren't announced, and selection states are weak**
- What: ~17 raw `error.message` sites in PosOrders.jsx (e.g. 908, 1453, 2975, 3106, six window.alerts) while management pages convert via errorText; send/save msg and floorMsg (5034) have no live region; selected payment method = bold + 1px grey border while hover paints the full accent, no focus-visible (`.pay-method-btn`, Layout.css:2825); KDS station chips and report tab rows have no aria-pressed/aria-selected.
- Why: a cashier who can't see the selected method charges the wrong one; "TypeError: Failed to fetch" tells no one what to do.
- Fix: errorLine(err, 'staff'); role="alert" on both message lines; selected method = accent fill + aria-pressed; one shared class for unclassed till buttons carrying the focus pair.
- Command: /impeccable harden, then /impeccable polish

## Persona Red Flags

- **The waiter**: lock warning hidden and order lost (#2); Owner "N bills not posted to Inventory" banners show to Staff rank with no rank gate (confirmed, 5089–5122); table status badge (57×15, 10px) cycles state on tap.
- **The cashier**: dead Confirm Payment (#3); frozen "Processing…" with Cancel disabled (#1); bill prints after bookkeeping; no closing statement; near-invisible selected payment method.
- **Casey (phone)**: 70px menu column (#4); 10px note preset chips; 20px-wide comp ±; hidden category scrollbar.
- **Sam (keyboard/SR)**: note presets vanish on Tab; tiles/qty/× on browser-default 1px outline; billInput outline:none; "Buyer details"/"Items" lack aria-expanded; PIN pad C/⌫ unlabelled, digit count unannounced; unenrolled /pos/login has no heading or main landmark.
- **Alex (power cashier)**: covers numpad click-only; Enter in Tender does nothing; Update Order always opens a "Send / Just save" modal duplicating KOT/BOT; Billing station not searchable by table.

## Minor Observations

- Shell (app-wide): top bar client switcher and "Bhadra 2083" overflow at 820px on every page.
- `/pos` overflows at 390px from an absolutely positioned sr-only span escaping `.table-wrap`.
- "PAIRED" chip 9px, below the 10px floor; placeholders use browser-default grey.
- One page, three names: "Tables" / "Table Management" / "POS Setup"; AdminGuestMenu's "Open POS Setup →" goes to /pos/tables.
- `bsMonthRangeIso` (reportRange.js) exists for report presets; only the Customization report uses it.
- KDS type 13–16px at wall distance; △/▲ elapsed line 13px; alert reservation hard-coded `paddingTop: 76`.
- Void/Complimentary are solid red/amber fills; DESIGN.md says danger is a tint and `btn-danger--strong` exists. Covers modal Cancel is `btn-danger`.
- Credit note and shift slip print Date/Miti via `toLocaleDateString` rather than the BS helpers; Staff "Last Seen" is AD-only.
- Shift variance: under NPR 100 short is green while counting; over is red in the modal, amber in history.
- Inactive table tiles at opacity 0.4 drop text below AA.
- Blank discount limit on PosStaff = unlimited, the least safe default for a new login.
- Covers Report's settings write has no `.select()`, falls back to INSERT, shows raw error.message.
- "Pair with" 4.24:1 on Light only.

## Questions to Consider

- The idle lock exists so bills carry the right waiter's name. Is a lock that throws away a half-taken order better than a till that stays signed in?
- The bill is legally final when the close write returns. Why does the guest wait for Inventory posting and loyalty before the paper comes out?
- The guest says "Table 12's bill, please." Should the Billing station be searchable by table, not just sorted by age?
- The covers numpad got a named 48px readout. Why is the KDS, read across a pass, set like a desktop report?
