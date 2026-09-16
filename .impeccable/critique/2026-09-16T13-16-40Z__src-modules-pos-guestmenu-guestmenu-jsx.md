---
target: guest menu
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
timestamp: 2026-09-16T13-16-40Z
slug: src-modules-pos-guestmenu-guestmenu-jsx
---
Method: dual-agent (A: design-review sub-agent · B: detector and browser-evidence sub-agent). Both ran against BHATTI CHOILA's live guest menu, served from a local dev server.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | The order tracker shows the wrong stage twice: when a second round starts, and after the bill is paid. A stalled Place Order spins forever. The highlighted category goes stale. |
| 2 | Match System / Real World | 2 | All-caps dish names copied from the till (COFFEE, PANI POORI), a section called "Other", option prices shown as differences ("−NPR 100"), and "Pick 2 to 10" on a group with only 3 options. |
| 3 | User Control and Freedom | 2 | Swiping back on Android with a sheet open leaves the menu. "Order again" starts from an empty cart. "Change" on the Review step makes the diner walk through every later step again. |
| 4 | Consistency and Standards | 2 | The loading, error and unknown-table screens use the dark staff theme with a red button. Two different close-button sizes. The review steppers show the browser's default focus ring. Square shared classes sit next to rounded inline corners of 6, 8, 10 and 20px. |
| 5 | Error Prevention | 3 | Good: the table name shows right before commit, a double tap sends one order, and picks survive a tap on the backdrop. Gaps: a price appears before any size is chosen, and covers silently default to 2 on every round. |
| 6 | Recognition Rather Than Recall | 3 | Option prices are relative to a base price the diner never sees, so they have to do sums. The five tracker dots have no labels. |
| 7 | Flexibility and Efficiency | 2 | No search. Each dish card is about 150px tall, so a 120-dish menu is 24–31 phone screens. No "same again" for a second round. |
| 8 | Aesthetic and Minimalist Design | 3 | The header is handsome and the page is calm. Below it, every dish is a large box containing a boxed "+ Add", and each section heading repeats the category button above it. |
| 9 | Error Recovery | 3 | Refusals get plain sentences, and dishes that went off the menu are removed by name. But a stalled submit never recovers, and the menu-load error is a staff-theme screen. |
| 10 | Help and Documentation | 2 | "You pay at the table" is helpful. Nothing says how long confirmation takes, what the dots mean, or how to call staff. |
| **Total** | | **24/40** | **Acceptable** |

Assessment A scored heuristic 8 at 2; the synthesis raised it to 3. The real-data screenshot is clean and calm. The trouble is density: the boxed button on its own row makes every card about twice as tall as its content. That's Priority Issue 3, not clutter.

**Cognitive load is high: 4 of 8 checks fail.**
- **Chunking:** up to 12 category buttons, and 6 nutrition values per card when nutrition is on.
- **One thing at a time:** the review dialog asks for quantity edits, covers, a note and the final order all at once. That's 10 controls for a 2-line order.
- **Minimal choices:** too many options visible at once in the dish list and the review dialog.
- **Working memory:** option prices depend on a base price the diner never sees.

On BHATTI CHOILA's 7-dish menu the first two barely matter.

## Design Specificity Verdict

**LLM assessment.** The header is designed: a pine Georgia wordmark over a thin rule and "Table 4", on bone paper. It does look like a printed menu card, but it is Crest's card, not the restaurant's. Every client gets the same pine and the same layout, so a choila bar and an acai café render identical pages. Nothing of the restaurant appears: no logo, no cover photo, no signature dish, no Nepali.

Below the header is a generic QR-ordering template that any product could ship: a sticky row of category buttons, identical bordered cards, a floating cart bar and a centred review dialog.

The content makes it worse:
- Dish names come straight from the till's item master.
- The database function sorts sections alphabetically, so Beverage comes first and "Other" becomes a heading.
- On real data there are no photos, descriptions or veg marks.

And whenever something goes wrong, or before anything has loaded, the diner sees Crest's dark staff screens.

**Deterministic scan.** The CLI detector found **0 issues** in the four guest-menu files, and that result is real: test files with planted violations came back with 1, 5 and 17 findings. Two caveats:
- The folder-wide radius ignore hides two real corner values in guestMenu.css (8px and 4px). DESIGN.md → Shapes allows these.
- The JSX check doesn't read numeric inline `borderRadius`, so "0 issues" says nothing about the rounded inline corners: stepper 8px, cart bar 10px, text box 6px, allergen chips 20px, and a 10px glow around a square card.

Run inside the live page, the detector found 9–12 issues per state, and none on the unknown-table screen.
- **False positives (most of them):** `gray-on-color` on bone-on-pine text (measured 9.17:1), `cream-palette` on the documented `guest-ground` colour, and `thin-border-wide-shadow` on the shared card style.
- **Real, by the project's own type scale:** 11.5px fine print ("Staff confirm this order…", the VAT line, "Going to Table") and 10.5px "Required" and nutrition text. Neither size is on DESIGN.md's scale.
- **Missed:** both agents measured the dimmed **Next** button in the build-your-own sheet at **3.36:1**, below the AA minimum. The detector can't see it: the colours pass on their own, and the failure comes from the 0.6 opacity.

**Visual overlays.** None was visible to the user. The Playwright MCP server didn't connect, so the detector was injected into a headless Chromium only; injection worked in all five states. For the tooling: each in-page scan took 56–67 seconds on this small page.

## Overall Impression

With a good connection, a short menu and nothing going wrong, this is a pleasant, readable page. The top third is the best-looking public screen in the product. It falls down at the edges, and the edges are where a diner forms an opinion:
- **The first seconds:** a white screen, then dark staff screens.
- **The failure screens:** dark, with a red button.
- **The wait for food:** a tracker that can say "Ready" too early, and "heading to the kitchen" after the diner has paid.
- **A real 60–120-dish menu:** more than 20 phone screens of scrolling, with no search.

The biggest opportunity is making the page tell the truth about this diner's own order, from placing it to paying. That is the screen they keep open for half an hour.

## What's Working

1. **The scoped bone-and-pine palette.**
   - Pine on bone measures 9.17:1 and dish names 14.73:1.
   - The palette is shielded from staff theme settings, so a phone that once opened the admin app still gets the menu card.
   - Every text style on the loaded menu passes AA except the dimmed Next.
2. **The build-your-own stepper handles the hard parts.**
   - Size comes first, so later prices don't jump under the diner's thumb.
   - Next stays pressable, says what's missing and moves focus there.
   - A tap on the backdrop after picking doesn't throw the picks away.
   - Reduced motion turns off the sheet animation.
3. **Honesty and safety at the moment of ordering.**
   - "Sending to Table 3" appears right before the button, with "you pay at the table".
   - Refusals become plain sentences, and dishes that went off the menu are removed by name.
   - A double tap sends one order, and the cart and note survive a reload.
   - When the status check fails, the tracker says its information is out of date instead of silently freezing.

## Priority Issues

**[P1] The order tracker shows the wrong stage when a second round starts and after the bill closes.**
- **Why it matters:** this is the screen a waiting diner watches.
  - A second-round order that staff haven't accepted yet shows "Ready to serve" if the first round is ready, so the diner waves staff over for food nobody has taken.
  - After paying, the phone chimes and says "Confirmed by staff, heading to the kitchen", which looks like a double order.
- **Cause (confirmed in the code):**
  - `computeStage` (GuestMenu.jsx:48-54) lets the table's kitchen status override the status of this diner's own order.
  - `get_guest_table_status` returns the least-advanced ticket on the table's open bill (20260916110000_pos_rank_guards_s754.sql:693-704). That describes the table, not this order.
  - When the bill closes, GuestMenu.jsx:288 clears the kitchen status and the stage drops back to "confirmed".
- **Fix:**
  - Limit the kitchen status to the tickets that carry this diner's items. This is a database change.
  - Never move the stage backwards, and never chime on a backwards move.
  - When the open bill disappears after "confirmed", show a final state such as "Bill settled — thank you".
- **Suggested command:** /impeccable harden

**[P1] The first screens and every failure screen are Crest's staff theme, not the restaurant's menu.**
- **Why it matters:** the palette was separated precisely so a diner never sees the staff product. The screens it left out are the first ones a diner on a weak signal sees.
- **On throttled 3G:** these timings are from the dev build, so production will be faster, but the order of screens is built in.
  - The page is blank white for about 15 seconds, because `index.html` has no content of its own.
  - Then a dark "Loading…", then a dark "Loading menu…", then the bone menu.
- **Every other state:**
  - The menu-load error is dark, with a Signal Red "Try again" squeezed onto two lines beside the sentence.
  - The unknown-table screen is dark too.
  - The tab title stays "Crest Suite" on both.
  - `theme-color` tints the Android address bar `#191817` above a bone page.
  - The manifest's `start_url` is `/dashboard`, so "Add to Home Screen" from the menu installs Crest Suite.
- **Fix:**
  - Render the loading, error and unavailable states inside `.guest-menu`.
  - Show a bone background and a skeleton (wordmark bar plus three placeholder cards) from the moment the route opens.
  - Set `theme-color` and the page title on mount.
  - Use `100dvh` instead of `100vh` in `CenteredMessage` (GuestMenu.jsx:1133-1142).
  - Put the error sentence above a pine button.
- **Suggested command:** /impeccable harden

**[P2; P1 once a menu passes about 30 dishes] Menu navigation breaks down beyond a handful of dishes.**
- **Why it matters:** finding one dish on a real menu means scrolling blind, with a category bar that points at the wrong section.
- **Measured:**
  - After scrolling back to the top, "Food" stays highlighted and marked current (`aria-current`).
  - Tapping the last category, "Snack", highlights "Food", because the page can't scroll far enough for Snack's heading to reach the top.
  - A tapped section lands 13px under the bar: the scroll offset is 52px but the bar is 65px tall on touch screens.
  - The highlighted button is never scrolled into view within the bar.
- **Scale:**
  - Each card is about 150px tall for one line of content, so 120 dishes is 24–31 phone screens, and there is no search.
  - Categories are alphabetical, and the owner can't reorder them.
- **Fix:**
  - Scroll the highlighted button into view.
  - Keep the tapped button highlighted until scrolling stops.
  - Add space at the bottom so the last section can reach the top.
  - Set the scroll offset from the bar's real height.
  - When a dish has no photo or description, show a single row: name, price and an inline +.
  - Show a search box beyond about 30 dishes.
  - Let the owner set the category order.
- **Suggested command:** /impeccable layout

**[P2] The build-your-own sheet (part of the paid Crest Customization add-on) makes the diner do sums.**
- **Why it matters:** this is where the diner decides what they will pay.
- **What:**
  - Option prices are differences from a base price the sheet never shows ("Half −NPR 100").
  - The card says "From NPR 245", then the sheet's button says "Next · NPR 260" before any size is chosen.
  - The dimmed Next measures 3.36:1.
  - The sticky header covers 4px of the "Step N of 4" label on every step.
  - `guestRuleText` says "Pick 2 to 10" for a group with 3 options.
  - "Change" on the Review step walks through every later step again.
- **Fix:**
  - Show the full price for each size ("Half · NPR 160").
  - Label the button "Choose a size", with no price, until a size is picked.
  - Remove the dimming and let the button's words say what's missing.
  - Limit the maximum to the number of options.
  - Make "Change" return straight to Review.
  - Start the step content below the sticky header.
- **Suggested command:** /impeccable clarify

**[P2] Placing the order, and what happens after, has loose ends.**
- **Submitting:**
  - `submit_guest_order` has no `withTimeout`, so a stalled call left "Placing order…" on screen for more than 25 seconds. The booking page stops waiting at 20.
  - Changes made in the review sheet while the order is sending are silently dropped.
- **Navigation and focus:**
  - After "+ Add", keyboard focus drops to the page body, because the button is replaced by the quantity stepper.
  - Swiping back on Android with a sheet open leaves the menu.
  - "Order again" after staff dismiss an order starts from an empty cart.
- **Accessibility:**
  - Screen readers don't hear the cart bar's count and total change.
  - The review sheet's × is only 33.5px wide.
  - The review sheet's steppers use the browser's default focus ring.
- **Fix:**
  - Wrap the submit in `withTimeout`, with a short sentence about the connection.
  - Lock the sheet while the order is sending.
  - Move focus to the new + button.
  - Add a browser history entry when a sheet opens, so back closes the sheet.
  - Make "Order again" restore the refused items and open the review.
  - Announce the cart total to screen readers (a polite live region).
  - Give the close button and the steppers the guest-menu classes.
- **Suggested command:** /impeccable harden

## Persona Red Flags

**Casey (one-handed, weak signal)**
- On throttled 3G: blank white for about 15 seconds, then two dark screens before the first dish.
- A stalled Place Order spins with no way out.
- The dropped-connection message is 37 words long.
- Swiping back to close a sheet exits the menu.

**Riley (stress tester)**
- Taps "Snack" and "Food" highlights. Scrolls to the top and "Food" is still highlighted.
- Orders a second round while the first is ready and sees "Ready to serve" for food nobody has accepted.
- Pays, then gets a chime saying the food is heading to the kitchen.
- At 360px, a long dish name wraps onto 11 lines in the review, and "NPR 1,25,000" splits across two lines.

**Jordan (first-timer, reads literally)**
- Reads the ⚙ Filters icon as settings.
- Sees "From NPR 245" become NPR 260, and "−NPR 100" with no explanation.
- Reads the red "Order Sent To Kitchen" badge as an error.
- Can't tell what the five unlabelled dots mean.
- Presses "Order again" and nothing is reordered.
- Leaves covers at the default of 2.

**Sunita (English as a second language, budget Android, 360px)**
- All-caps names are slower to read.
- The "options failed to load" banner is 33 words and the network error is 37; PRODUCT.md asks for about 16.
- Nutrition text is 10.5px.
- There is no Nepali anywhere.

**BHATTI CHOILA's owner**
- Their guests' first screens and every error screen use their software vendor's dark theme and red button.
- Their name appears as it's stored on their account record, in capitals, next to till inventory names.
- Categories are alphabetical, including "Other".
- There is no place for a logo or photo.
- Their menu looks identical to every other Crest client's.

## Minor Observations

- **Kitchen badge:** the fallback badge says "Order Sent To Kitchen" in red with forced title case (GuestMenu.jsx:33-34). That is the danger colour for a normal state.
- **Tracker dots:** the ones not yet reached are `#D3CCBC` on paper (about 1.37:1). None of the dots is labelled, so only the sentence tells the diner the stage.
- **Allergens:** they only appear when the client pays for the nutrition feature and the dish has full nutrition data, and that also hides the allergen filter. Safety information sits behind a paid feature; this needs a deliberate decision.
- **Corners:** the corner style is inconsistent.
  - The shared styles became square in the Modernist redesign: cards, category buttons, sheets and "+ Add" are all 0px.
  - Inline corners of 6, 8, 10 and 20px survived, including a rounded 10px glow around a square confirmation card.
  - DESIGN.md exempts this page from the square-corner rule, but no separate corner style was ever defined for it.
- **Type sizes:** the 11.5px and 10.5px text is off the DESIGN.md type scale.
- **Screen-reader structure:** there are no `main` or `nav` landmarks, and dishes aren't marked up as a list, so a screen reader gets one long run of text and buttons.
- **Duplicate labels:** each section heading repeats the category button right above it ("Beverage" / "BEVERAGE").
- **Sticky hover:** after a tap on a touch screen, `.guest-menu .tab-btn:hover` leaves a darker border on the tapped button.
- **Notes:** `submit_guest_order` accepts a note per item, but the page only offers one note for the whole order.
- **Settings reads:** on this public page, the app shell still reads the global settings row twice on mount.
- **Filter sheet:** the checkbox is 20×20 and its label's tap area is only 26px tall.

## Questions to Consider

- Does one fixed pine for every client really make this "the one brand-facing surface", or does it just move Crest's brand down a layer? What would the owner's logo, a cover photo and an AA-checked accent colour do here?
- Is a table-wide kitchen status ever a true statement about "your order"?
- Should a dish have a guest-facing name, description and Nepali name, separate from the till's item master, so "COFFEE" and "BASE FOOD ITEM" never reach a diner?
- What does a diner need after "Ready to serve": call a waiter, ask for the bill, order more, or a warm goodbye?
- What would a printed-menu row (name, dotted leader, price, tap to add) do to a 24-screen scroll?
