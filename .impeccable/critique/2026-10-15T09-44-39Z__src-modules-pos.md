---
target: the pos module
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
timestamp: 2026-10-15T09-44-39Z
slug: src-modules-pos
---
Method: dual-agent (design-review agent · detector agent), isolated; the scan was read only after the review finished. Five priority issues spot-checked against source by the parent.
Visual evidence: no Chrome extension connected, so no live overlay. Headless screenshots of signed-out pages only (/pos/login unbound gate, guest menu and booking with a made-up id). Floor, order screen, payment window, KDS, shifts and reports judged from source.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Offline/no-internet chips, sent marks, live kitchen timers, the "TI123 closed · T5 · NPR 2,450 · change NPR 50" sentence are excellent; Close Shift shows a red verdict before anything is counted |
| 2 | Match System / Real World | 3 | BS dates, NPR grouping, KOT/BOT, covers, eSewa/Khalti/FonePay native; "NC-07", "HSC Codes", "1L+ Report", "comp" leak through |
| 3 | User Control and Freedom | 3 | Discard/pull confirms and "Add them back as unsent" are good; only the last tender can be undone |
| 4 | Consistency and Standards | 2 | Four send controls with different behaviour; POS still paints figures in the accent after IMS and HR moved to ink; inline-styled controls beside classed ones |
| 5 | Error Prevention | 3 | Money path near 4; veg/non-veg by hue only; "Just save" quietly leaves dishes unfired |
| 6 | Recognition Rather Than Recall | 3 | Quantities on tiles, sent marks, code search; Tips are hover-first on a touch tablet |
| 7 | Flexibility and Efficiency | 2 | Cash preselected is good; Enter in menu search adds nothing, no Send/Pay shortcut, every KDS Start opens a dialog |
| 8 | Aesthetic and Minimalist Design | 2 | Accent on nearly every element; a note box on every cart line; up to ~12 banners stacked above the tables after an outage |
| 9 | Error Recovery | 4 | Best in the product: staff-worded errors, lost close read back, stale-order recovery list, "This is not an empty kitchen… work from the printed tickets" |
| 10 | Help and Documentation | 3 | Tips everywhere, support line on the offline banner; POS Setup tab help is a native title tooltip, "device not set up" names no one to call |
| **Total** | | **28/40** | **Good (low end)** |

## Design Specificity Verdict

**LLM assessment.** The till behaves like a Nepal F&B floor and looks like any POS. Behaviour is local: KOT/BOT routing, TI vs PB invoices from VAT registration, the abbreviated-invoice threshold, eSewa/Khalti/FonePay tenders with Foodmandu/Pathao as credit parties, a ₨1000→₨1 denomination grid, BS Miti on every slip, "Wi-Fi is on but the till can't reach the server", PIN face tiles that keep an idle waiter's unsent cart. Form is generic: a uniform card grid for the floor (not a map of the room), a menu/cart two-pane, a category tab row, a long modal payment sheet — the Petpooja/Square/Toast composition in Modernist dress. The one visual idea the till owns is the S661 attention strip on the floor tiles. ~1,400 lines of inline-styled order-screen JSX mean every visual decision is local, which is why the till never got a form of its own.

**Deterministic scan.** Detector: 0 findings on src/modules/pos (158 .js, 81 .jsx, 7 .css). Proven real: a planted bad file fires 7–20 findings; a whole-src run finds 4 elsewhere. Four POS findings are suppressed by .impeccable/config.json: 26px on the parking slip (correct, print) and #666 on three print-popup "Printing…" lines — print is exempt, but #666 is off the documented print ramp (#555/#777), and the ignore entry has no files: scope, so it exempts #666 across all of src. Blind spots closed by grep: 750 inline font sizes all on the ramp, 0 non-zero radii, 56 hex literals all legitimate (print templates, chart ticks, QR quiet zones). AST scan: 11 class-less buttons, 9 real. Agreement: both flagged the covers numpad, "Pair with" chips and 11px "↩ Undo" as missing the focus pair and touch floor, and the booking page's dead-end unavailable state. Scan-only: KDS estimate keypad and the payment window's Buyer details/Items toggles. Tooling: the detector's URL mode exits 0 with [] when puppeteer is missing.

**Visual overlays.** None; no browser connected.

## Overall Impression

The money path is the best-built part of Crest: every failure names the money, a lost answer is read back, Confirm states the amount. What lets it down is surface: the till spends its one accent on everything, the payment window puts rare adjustments above the method the cashier taps on every bill, and a handful of controls sit outside the touch/keyboard system. Biggest opportunity: make the cashier's default path one screen (amount, method, Confirm) and make Send the only lit thing on the order screen.

## What's Working

1. A close that never lies — aria-disabled close buttons whose Confirm label names the blocker, read-back of a lost close, an ending on invoice number plus change.
2. Waiter and cashier are different screens — BillingStation.jsx:133-207 is a list sorted longest-open first with age, covers, an unsent chip and a find-table search.
3. Loudness tracks demand for action — the floor strip (posSignals.js:171-179) shows guest order → unfired → food ready, doubled by labelled chips; the KDS strip carries lateness with △/▲ shapes.

## Priority Issues

**[P1] Veg, non-veg and egg marks differ only by colour**
- What: DietMark.jsx draws the same 12px square + round dot for all three, coloured green/red/amber (guestMenu.css:276-295); the word is only in aria-label and a title tooltip. Till tiles carry no mark (MenuGrid.jsx).
- Why: red vs green is the classic colour-blind collision (~8% of men); a vegetarian guest ordering meat by mistake is real harm, on the page a paying customer sees.
- Fix: shape-encode — dot for veg, filled triangle for non-veg (FSSAI 2020; confirm for Nepal), distinct mark or "E" for egg; print the word on the dish sheet; add the mark to till tiles.
- Command: /impeccable harden

**[P2] The payment window buries the money decision**
- What: Pay tab runs close type → Buyer details → Loyalty → Items → Single/Split → Share slips → methods → Discount → Cash received (PosOrders.jsx:7454-7898); ~15–18 controls before Confirm; methods below the fold on a narrow sheet; member card hidden in Buyer details.
- Why: the method is the tap on every bill, under five rarer rows, while a guest waits.
- Fix: Amount → Method → tender/QR → Confirm; one "Adjust this bill" fold with a summary line; Void/Complimentary as a quiet "Other ways to close" row.
- Command: /impeccable layout

**[P2] Some till controls are outside the touch and keyboard system (both assessments)**
- What: floor/takeaway tiles are role="button" divs holding up to four Tip triggers (PosOrders.jsx:8663-8738), ~6 tab stops per tile, while design-system.md (S653) blesses the tile because it "holds no interactive children". Class-less buttons with no focus pair or 44px floor: covers numpad (:8273-8277), Pair-with chips (:7223), Buyer details/Items toggles (:7482, :7606), "↩ Undo" tender (:7939, 11px), KDS estimate keypad (EstimateTimeModal.jsx:98).
- Why: keyboard/screen-reader users lose their place; the money-reversing Undo is the smallest, faintest control on the payment screen.
- Fix: .till-hit / .till-hit--row on each; on tiles, make chips plain text with one Tip on the name, or put "open" on a real <button> inside the tile.
- Command: /impeccable harden

**[P2] Close Shift opens on a red "Short by" before anything is counted**
- What: diff = counted − expected, so the dialog opens on "▲ Short by NPR 38,450" in red (PosShifts.jsx:1263-1286).
- Why: breaks DESIGN.md's "no verdict on an unsettled figure" at the cashier's most accountable moment.
- Fix: neutral "Still to count NPR 38,450" in ink until the first denomination is entered; then ✓/▲/△.
- Command: /impeccable clarify

**[P2] The till spends its one accent on almost everything**
- What: tile prices (MenuGrid.jsx:76), in-cart tint/border/badge, order-number chip, ✓ KOT/BOT marks, TOTAL, Payment outline, occupied borders, a filled Bill on every billing row (BillingStation.jsx:196-206), a primary button on every KDS card. On Night the accent is Signal Red beside danger.
- Why: DESIGN.md: the accent never spends itself twice; POS keeps the old vocabulary only "until it is reviewed the same way" as IMS (S796) and HR (S804).
- Fix: S796/S804 pass — figures in ink with tabular numbers, in-cart by an ink quantity badge, occupancy by the strip, Bill/KDS as ghost; accent only for Send, selected method, active tab, focus.
- Command: /impeccable quieter

## Persona Red Flags

- Alex: Enter in till search adds nothing (:7026-7039); no Send/Payment shortcut; only last tender undoable; Sales Report 11 tabs; discard dialog has no "Send and go back".
- Sam: ~6 tab stops per floor tile; five class-less control families fall back to the browser outline; hue-only diet mark. Positives: aria-pressed chip groups, spoken PIN count, always-mounted live regions.
- Casey: order-screen top bar at the top edge; Pair-with chips, ↩ Undo, floor Retry and "Reservations →" under 44px; ~12 banners after an outage push the tables below the fold (:8379-8548).
- Bishnu (waiter, shared tablet): four send controls behave differently ("Just save" leaves dishes unfired); a "+ Kitchen note" box on every cart line; guest-order Accept/Dismiss at 12px (:6988-6993); a de-activated tablet offers only "Owner Login", no one to call.
- Sunita (cashier, FonePay): FonePay below six rows, QR only after picking it; member card behind Buyer details; the Confirm label carrying the amount saves her.

## Minor Observations

- KDS: every Start opens the estimate dialog (KitchenDisplay.jsx:1012) — two taps minimum, covers the board.
- suggestShiftLabel uses new Date().getHours(), not Nepal time (PosShifts.jsx:60-66).
- Booking unavailable state: no heading; "call or message directly" with no number possible; "Powered by Crest POS" on a white-labelled page (GuestBooking.jsx:436-447).
- Device-not-set-up gate: six-line centred paragraph on a phone.
- Dashboard "open bills" before VAT vs billing list VAT-inclusive.
- POS Setup tab help in native title tooltips (PosTableManagement.jsx:943-952); 9–10 tabs in one row.
- Inline opacity 0.6/0.5/0.4 vs the class's 0.55.
- Till button labels centred vs DESIGN's flush-left rule — document it if intended.
- PIN dots glow: decorative shadow in a flat system.
- Menu search placeholder starts with an emoji; 128px wide on a phone.
- #666 print placeholders off the print ramp; scope the config ignore to its file.

## Questions to Consider

1. Should the floor be a map of the room rather than an alphabetical card grid?
2. Why four controls to send to the kitchen? What about one "Send 3 to kitchen" and no "save without sending"?
3. What does the till look like when Send is the only lit thing?
4. Is the estimate at Start for the cook or the dashboard? Would a per-dish median be more honest?
5. Should the cashier's default be one screen (amount, method, tender, Confirm), with the other seven intents a level down?
