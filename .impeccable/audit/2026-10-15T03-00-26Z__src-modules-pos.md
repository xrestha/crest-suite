# Crest Suite — `/impeccable audit`, POS module (2026-10-15)

Recovered in S844 from the S841 session record: the report was given in chat and never saved here. The P3 detail below the main report is the seven helpers' own notes from that run, kept because the main report summarised P3 in one line.


**Scope:** everything under [src/modules/pos/](src/modules/pos/): about 150 files and 40,000 lines. The till's styles in [Layout.css](src/components/Layout.css) and the shared dialog, date picker and row-menu components that POS uses were included. Seven helpers each read one area. I checked every serious finding against the code myself; the ones I didn't open are marked as the helpers' word.

## Audit Health Score

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | **2** | Focus is lost to the top of the page on the till, the guest menu and several dialogs |
| 2 | Performance | **3** | Timers and polling are tidy; the order screen redraws the whole menu on every keystroke |
| 3 | Responsive | **2** | Payment-method buttons are about 34px tall on a tablet, against the project's 44px touch minimum |
| 4 | Theming | **3** | No stray colours; one link shows in the browser's default blue |
| 5 | Implementation integrity | **3** | The system holds; about 12 server requests have no time limit |
| | **Total** | **13/20** | **Acceptable: a real gap list, but a sound base** |

## Implementation integrity verdict: **Pass**

The automated design checker found **zero issues** across all of POS, even with the project's own exemptions switched off. Colours are tokens throughout, and the "red text / red fill" token split is used correctly everywhere. The shared parts are used almost everywhere: the dialog, error messages, tooltips, row menus, tabs and the confirm dialog. The drift sits in a few older setup screens, which still hand-build tab rows, stat tiles and inputs.

## Executive summary

- **1 P0, 10 P1, about 20 P2, about 10 P3.**
- The worst problems are not visual. They are **requests with no time limit** and **focus getting lost**.
- Three fixes live in shared components (the dialog, the date picker, the row menu). They will also change HR and IMS screens.

## P0: blocks the task

**[P0] The till cannot load its menu when Wi-Fi is up but the internet is down**
- **Where:** [PosOrders.jsx:2337](src/modules/pos/orders/PosOrders.jsx#L2337)
- **What happens:** the menu loader checks only whether the device has a network connection. Everywhere else the till uses its own "is the link really down" check. With the router up and the internet down (common in Nepal), a till that has been reloaded or reopened asks the server for the menu.
- **Impact:** a failed request keeps the "last menu", and on a fresh screen that is an empty one. It never falls back to the menu copy saved on the tablet. Result: no menu, so no order can be taken, in exactly the outage offline mode exists for.
- **Fix:** use the till's own offline check, fall back to the saved menu on a network error, and put a time limit on the reads.

## P1: fix before release

1. **Opening a table has no time limit and no protection against double taps**
   - [PosOrders.jsx:3075](src/modules/pos/orders/PosOrders.jsx#L3075), [:2842](src/modules/pos/orders/PosOrders.jsx#L2842)
   - The tile shows nothing while it waits, so waiters tap again.
   - Whichever answer arrives last wins: a slow reply for T3 can replace T5's open screen and its unsaved dishes.
   - Fix: a "latest request wins" guard, an "Opening…" state on the tile, and a time limit.
2. **The PIN screen can sit on "Loading…" forever**
   - [PosLogin.jsx:72](src/modules/pos/login/PosLogin.jsx#L72)
   - The staff-list request has no time limit and nothing catches a failure, so no "Try again" ever appears.
   - Every till rests on this screen.
3. **The app behind the full-screen till can still be reached by keyboard and screen reader**
   - [PosOrders.jsx:6573](src/modules/pos/orders/PosOrders.jsx#L6573)
   - Focus also drops to the top of the page whenever the screen switches between floor and order.
   - Fix: make the shell behind it inactive (`inert`) while the order screen is up, and place focus deliberately on the way in and out.
4. **Shared dialog: focus is lost on close when a field inside it grabs focus on open**
   - [Modal.js:89](src/components/Modal.js#L89)
   - The dialog remembers that field as the button that opened it. On close it tries to return focus to a field that no longer exists.
   - Affects Reset PIN, Add Staff and Add Table, and HR/IMS dialogs built the same way.
5. **Shared date picker can't be reached by keyboard inside a dialog**
   - [BsCalendarPicker.js:191](src/components/BsCalendarPicker.js#L191)
   - Focus never moves into the calendar when it opens, so a keyboard user can't change a booking's date.
   - Its month arrows have no names.
6. **Guest menu and booking: the result is never reliably read out**
   - [GuestMenu.jsx:870](src/modules/pos/guestmenu/GuestMenu.jsx#L870)
   - A screen-reader guest hears a chime and no words, even when the order was refused.
   - Focus drops after the order is sent.
7. **Payment-method buttons are about 34px tall on a tablet**
   - [Layout.css:3345](src/components/Layout.css#L3345)
   - This covers Cash, Card, eSewa, Single/Split and the delivery partners.
   - Ten more order-screen buttons miss the 44px floor: Served, Reprint, Retry, Apply and others. So do the kitchen display's station chips and Dismiss buttons (the helpers' count).
8. **Which option is selected is shown by colour alone, on about nine rows**
   - Kitchen/bar station toggles ([PosTableManagement.jsx:1041](src/modules/pos/tables/PosTableManagement.jsx#L1041)), POS Setup's 10 section tabs, the Customers and Credit Notes tabs, the menu categories, the floor sections, Pay/Void/Complimentary, and ₨/%.
   - The shared tab and filter-chip components that fix this already exist.
9. **The Issue Credit Note dialog can be closed while it is issuing**
   - [IssueCreditNoteModal.jsx:416](src/modules/pos/creditnotes/IssueCreditNoteModal.jsx#L416)
   - Escape, × or a tap outside closes it. The "did not print / not in Inventory" notice is lost, and the bill keeps a live Credit Note button.
   - Its sibling dialogs already guard this.
10. **The "Periods" link on the Inventory-posting banner shows in the browser's default blue**
    - [PosImsPostingBanner.jsx:171](src/modules/pos/orders/PosImsPostingBanner.jsx#L171)
    - The app sets no default link colour, so it is about 1.7:1 against its background (the guideline minimum is 4.5:1).

## P2: next pass (short form)

**Speed**
- Every keystroke on the order screen redraws the whole menu grid. The helper puts it at about 10–30 ms on a cheap tablet, an estimate still to be measured.
- The guest menu's order-status checks redraw the whole menu every 5 seconds even when nothing changed.
- Guest dish photos are stored at 1,200px but shown at about 72px.
- The Bill Register and KOT Register draw up to 100,000 rows with no paging.
- The till's 5-second checks ignore "link down" and pile up during an outage.

**Taps and focus**
- Cart lines are keyed by position, so after a removal a double tap hits the next dish.
- Focus is lost after row-menu actions and after the floating Add button disappears (Reservations, Loyalty), and after removing a line in the guest's order.

**Losing a half-filled form**
- One stray tap outside a dialog discards a half-filled Adjust Points, Move Points, Credit Note or Reservation form. The dialog's "unsaved changes" guard only works for bottom sheets.
- The phone's Back button throws away a half-built guest dish or combo.

**Wrong or unclear messages**
- The kitchen display shows an empty board after a failed first read, or the other station's tickets after a failed switch.
- The Covers Report's Reservations tab can never show "No bookings"; it shows a wrong "No dine-in bills" message instead.
- The Sales Exceptions staff filter stays applied after its name disappears from the list.
- Raw error text reaches staff in two places ([TillOutletGate.jsx:99](src/modules/pos/TillOutletGate.jsx#L99) and the PIN screen).
- About 15 save and result messages are never read out to screen readers.

**Layout**
- The kitchen display is a fixed 3-column grid with no narrow-screen layout.
- Quick Setup's grid squeezes on a phone.
- The billing panel can be cut off at the top when the guest-order alert is showing.

**Money actions**
- Settling a Credit bill is one irreversible tap among seven side-by-side method buttons.

**Contrast and colour**
- The guest-order banner pulses its own text below the contrast minimum, half of each cycle.
- The highlighted delivery-partner row in the Sales Report fails contrast. It is missing the class that keeps faint text readable on tinted rows.
- Guest orders are brass on the floor banner but amber on the tile, against POS's own colour rules.

**P3 (polish):** emoji used as icons, headings that skip a level, the diet mark copied three times, a missing colour token behind one table's row highlight, and tap targets on the booking page's day picker.

## Patterns behind the findings

1. **Requests with no time limit, about 12 places:** the PIN screen, opening a table, the menu, the till's polls, four reports, booking, credit notes, points history and parking. CLAUDE.md requires a time limit on any request that blocks the user. A sweep finds them all.
2. **Focus falls to the top of the page when the thing that had it disappears.** Two shared fixes (the dialog and the row menu) plus making the shell inactive behind the till cover most of them.
3. **Status lines that appear together with their text** are often not read out. One always-present message area per screen would fix this.
4. **Controls whose classes the touch rules don't cover** miss the 44px floor: payment buttons, dashboard links and badge-buttons.

## What's working (keep it)

- **Clean code underneath:** zero checker findings, every timer and listener is cleaned up, and polls skip redraws when nothing changed.
- **Honest failure handling:** reports never show a figure they didn't compute, and figures and Excel buttons wait until the data has loaded.
- **The PIN pad:** it announces how many digits are entered, tells "wrong PIN" apart from "no connection", and keeps the digits on a network failure.
- **Reduce-motion handling:** it switches off specific animations rather than all motion at once.
- **The kitchen display's polling,** and buttons that stay pressable and say what's missing instead of going dead.

## Recommended actions

1. **[P0/P1] `/impeccable harden`:** time limits and the double-tap guard on the till (menu with the saved-copy fallback, opening a table, the PIN screen, polls); the credit-note close guard.
2. **[P1] `/impeccable harden`:** focus fixes (shell made inactive behind the till, the shared dialog and date picker, the row menu) and read-aloud result messages on the till and guest pages.
3. **[P1] `/impeccable adapt`:** touch sizes (payment buttons, order-screen buttons, kitchen display controls) and the kitchen display's narrow-screen layout.
4. **[P1] `/impeccable polish`:** swap the colour-only rows onto the shared tab and filter-chip components; style the banner link.
5. **[P2] `/impeccable optimize`:** a memoised menu grid, guest-menu polling, photo thumbnails, register paging.
6. **[P2] `/impeccable clarify`:** the empty-state and staff-error wording, and a confirm step before settling a Credit bill.
7. **`/impeccable polish`** as the final pass.


## Appendix — P3 detail from the helpers (verbatim)


---
[P3] Three id sets on the kitchen display never shrink.** `KitchenDisplay.jsx:272` (`autoServing`, deleted only on failure at `409-415`), `279` (`voidDismissed`), `280` (`voidFirstSeen`). Memory.
  - The amounts are small (a few hundred ids a day), but the board is reloaded only when a release arrives.
  - Fix: after each successful read, delete ids that are no longer in `readyIds` or `vrows`.
  
  **[P3] The estimate keypad has unnamed C and ⌫ keys.** `EstimateTimeModal.jsx:95-111`. A11y.
  - PosLogin names the same keys (`:492`).
  - The minutes readout (`75`) is not a live region.
  - Fix: copy PosLogin's `aria-label`s and add `aria-live="polite"` to the readout.
  
  **[P3] PIN key and tile feedback is mouse-only.** `PosLogin.jsx:507-510`, `417-418`. Integrity.
  - The `onMouseDown`/`Up` scale and glow fire after the finger lifts on touch. `onMouseEnter` leaves the last-tapped key tinted.
  - The two Back buttons (`446-456`, `525-535`) are inline copies of `btn btn-ghost`.
  - Fix: a `.pin-key` class with `:active` and `@media (hover:hover)`; `btn btn-ghost` for Back.
  
  **[P3] Two fixed layers ignore the safe area.** Responsive.
  - `StationPrintAlerts.css`: `bottom: 16px` puts the action row in the iPhone home-indicator zone.
  - PosLogin's `main` pads 24px only, so a tall staff grid on an installed iPhone sits under the status bar.
  - Fix: `calc(16px + env(safe-area-inset-bottom, 0px))` and the equivalent top padding.
  
  **[P3] Parking still has local shortcuts.**
  - `NewParkingSlipModal.jsx:90` formats money with `toLocaleString('en-IN')` instead of `nprInt`.
  - The Open/All row (`PosParkingSlips.jsx:423-426`) is a hand-built `.tab-btn` row; `FilterChips` would give it `role="group"` and arrow keys.
  - The modal's bills read (`:69-75`) has no time limit.
  
  ### 3. False positives checked and dismissed
  - **Flashing:** the ArrivalAlert pulse is 1.1s and the bell ring 1.6s, well under 3 flashes a second, and reduced motion is honoured.
  - **Lateness by colour only:** the ▲/△ marks and "N min ago" text carry it, and the stage is the column heading.
  - **Audio-only alerts:** every chime has a banner, and sound-off has its own `role="alert"` banner.
  - **`type="password"` / `autoComplete`:** there are no password inputs in the slice; the PIN pad is buttons.
  - **Kitchen display polling while the tab is hidden:** needed for the chime and the auto-serve. The panels and parking do pause; the print station uses a worker on purpose.
  - **EstimateTimeModal has no `zIndex`:** `Modal` does not portal, so it renders inside the 1000 layer.
  - **Estimate readout is 32px, not 48px:** DESIGN.md fixes it at 32.
  - **Double Escape handler (window and Modal):** both call the same close, so it is harmless.
  - **The 30s clock tick re-renders every card:** negligible, and the polls already skip unchanged renders.
  - **`pp-stations-err` reference:** it matches FieldError's `${id}-err`.
  
  ### 4. Positives worth keeping
  - **The kitchen display's poll design:** unchanged polls skip the render, stale reads are dropped by station and sequence, a tap's stage survives an older read, every read has a time limit, and there is one shared AudioContext.
  - **The PIN pad:** the digit count is announced to screen readers, "couldn't reach the server" is kept apart from "wrong PIN" and keeps the digits entered, and lockout messages say how to get unlocked.
  - **The print station:** its own `100dvh` scrollport, a worker for the tick, a wake lock that is cleaned up, a status line that scales to 48px with words carrying the tone, and a 20-row cap on its list.
  - **The printers and devices panels:** stale lists and failed reads are told apart, actions confirm with the consequence spelled out, and `RowMenu` and `Tip` are used throughout.
  


---
[P3] Dead row tint on new Activity rows** — `Layout.css:2687` — theming
  - `--theme-yellow` is defined nowhere, so the tint never paints. The "new" badge still marks the row.
  - **Fix:** `var(--theme-table-hover)`, which is what the comment says it should be.
  
  **[P3] Hand-rolled copies of shared parts** — integrity
  - `IssueCreditNoteModal` `inputStyle`/`labelStyle` (`:597-598`) plus an inline `1fr 1fr` grid (`:464`): no `[aria-invalid]` or `:disabled` styling, and fields stay editable during "Issuing…".
  - Stat tiles in `PosCustomers.jsx:603-616` instead of `stat-card`.
  - Coloured `<p>` messages instead of `ActionError` in `LoyaltyTab.jsx:322` and `IssueCreditNoteModal.jsx:558`.
  
  **[P3] Inconsistent money formatting** — `LoyaltyTab.jsx:576`, `AdjustPointsModal.jsx:91` — integrity
  - Hand-built `NPR ${…toLocaleString('en-IN')}`, while Move and History use `nprPoints`.
  
  **[P3] Emoji and glyphs as icons** — integrity
  - 🎉 (`PosCustomers.jsx:691`), ⬇ (`CreditNotes.jsx:328`), 🔔/💬 (`PosReservations.jsx:427, 529`), and "ⓘ" `Tip` triggers inside `<h1>`s.
  
  **[P3] Heading order skips a level** — accessibility
  - `h1` goes straight to `h3` (LoyaltyTab and dialog titles). "Who owes what" and "Collected" are styled `<p>`s, not headings.
  
  ### 3. Checked and dismissed
  - The PosCustomers onClick you asked me to find is a `<tr onClick>` at `:516`, not a div or span. It is backed by `RowDisclosure` with `aria-hidden` on the hint cell, which is the documented pattern, so it is not a defect.
  - `outline: 'none'` in IssueCN's `inputStyle`: the bare `input/textarea:focus-visible` box-shadow in `Layout.css:2801` still shows a focus ring.
  - IssueCN `:319`'s `(code · message)` is the sanctioned `errorLine` form.
  - `key={idx}` (IssueCN `:438`) and the picker's day keys: static lists.
  - Calendar day cells (26px): `button:not([class])` gets the 44px min-height under a coarse pointer.
  - The out-of-service table chip's ✕ (`ReservationModal.jsx:330`) has an `aria-label`.
  - Every interval and listener in Reservations and Seat has cleanup.
  - Status is never shown by colour alone: badges carry words, and ledger rows carry +/−.
  
  ### 4. Worth keeping
  - **`Modal` is a real dialog:** `role="dialog"`, `aria-modal`, a labelled title, initial focus, a Tab trap, a stack of open dialogs so one Escape closes only the top one, and `defaultPrevented` respected. The picker grabs Escape in the capture phase so it never closes the dialog behind it.
  - **The `aria-disabled` "press says what's missing and moves you there" pattern** on Issue & Print, Add/Take points, Move and + Add scheme.
  - **Reservations rows:** one next step, `stepBtn` keeping the pressed button enabled with `aria-busy`, `RowMenu` with destructive items last, and `ConfirmModal` with consequence copy.
  - **Failed reads are honest everywhere:** `ReportLoadError` instead of an empty state, a stale-list warning, `useLatestRequest`, `setIfChanged` on polls, and a debounced invoice search.
  


---
[P3] Heading outline.** Category: a11y.
  - `ChartCard` defaults to h3 directly under the h1 at `SalesReport.jsx:1296` and `CoversReport.jsx:582` and `:754`. Pass `headingLevel={2}`.
  - Section labels "By partner", "Bills" and "By Staff Member" are styled `<p>`s (`SalesReport.jsx:1625`, `:1709`; `PosExceptionReport.jsx:416`). Make them h2s with a class.
  
  **[P3] Dashboard hourly chart has no text alternative.** `PosDashboard.jsx:361`. Category: a11y.
  - Supervisors see the dashboard but cannot open Sales Report's Hourly table.
  - Recharts 3's keyboard layer only partly covers this. Add a footer summary (totals, peak hour vs last week), as SalesReport has.
  
  **[P3] Error and notice handling has forked across the four pages.** Category: integrity.
  - Covers' hours-save message is the hand-rolled `<p role="alert">` with red text (`:573`) instead of `ActionError`.
  - A failed letterhead read is a `.report-error` card on Sales/Covers but a 12px amber `<p>` on `KotLog:529` and `Exceptions:358`.
  - Exceptions passes `.message` strings to `ReportLoadError` (`:138`, `:197`), which drops the detail line and the row-cap code wording.
  - Sales and Covers keep private `withLetterhead` copies (`SalesReport.jsx:947`, `CoversReport.jsx:394`) instead of the shared `sheetWithLetterhead`.
  
  **[P3] Totals and labels.** Category: integrity.
  - The 1L+ totals row leaves Taxable and Non-Taxable blank (`SalesReport.jsx:2041-2047`) although each row shows them.
  - Covers' Trend, Peak and Server tables have no totals row.
  - Covers' "busiest 12/5" is a bare day/month (`:589`); use `formatBsDay`.
  
  **[P3] Polish.**
  - 🎉 in the empty states of anti-fraud views: `KotLog.jsx:542-543`, `PosExceptionReport.jsx:460`.
  - Private `GOLD = '#c9a84c'` copies of `CHART_COLORS[0]` at `SalesReport.jsx:45` and `CoversReport.jsx:32`; import it instead.
  
  ### 3. Dismissed false positives
  - **Clickable rows:** `<tr onClick>` at `SalesReport.jsx` 1391/1487/1552/1657/1736, `PosExceptionReport.jsx:488` and `KotLog.jsx:681` each have a `.btn-linklike` or `RowDisclosure` in the cell that identifies the row (bill or order number), with `stopPropagation`. This is the documented S613 pattern, not a defect.
  - **Hex literals:** `#c9a84c` and `#6b7280` appear only in SVG series and ticks.
  - **Coloured figures:** the red Voided Value, accent-ink comp figures and green Net Received follow the `posSignals.js` colour scheme (void is red, money totals are brass/accent, settled is green).
  - **`xlsx`:** every load is `await import('xlsx')` inside `exportExcel`.
  - **`Tabs` without `hasPanel`:** deliberate, per the `Tabs.jsx` comment.
  - **Sortable headers / `aria-sort`:** no sortable columns exist in the slice.
  - **Outline removal:** no `outline: none` anywhere.
  - **Unmemoised footer totals:** O(n) over rows that are already memoised, and no text inputs re-render the page.
  - **Stale dashboard tiles after a failed refresh:** deliberate keep-last-good behaviour with a `role="alert"` banner.
  
  ### 4. Positives to keep
  - **Failed-read handling is strict:** `firstError` per batch, an error slot per tab on `KotLog`, and a separate `bizError` slot. KPI strips and Excel buttons are gated on `loading`, error and the letterhead read.
  - **Overlapping loads can't win:** `useLatestRequest` is keyed on client + range on every loader, and the dashboard uses `withTimeout` with keep-last-good polling and cleans up its interval.
  - **Drill-downs and filters are accessible:** `RowDisclosure` with `aria-expanded`, `aria-pressed` on the partner toggle, and `FilterChips` for the range presets and the type filter.
  - **`CompareLine` on the dashboard:** a glyph plus colour, a dead zone, and reversed polarity for Discounts. `ShareRows` shows each share by bar length, not by colour.
  
  Files: `/home/aashish/crest-suite/src/modules/pos/reports/{SalesReport,CoversReport,KotLog,PosExceptionReport}.jsx`, `/home/aashish/crest-suite/src/modules/pos/dashboard/PosDashboard.jsx`, `/home/aashish/crest-suite/src/components/Layout.css`.


---
[P3] Duplicated code.** Integrity.
  - The diet mark has three copies: GuestMenu.jsx:1398, GuestOptionSheet.jsx:53, GuestComboSheet.jsx:178.
  - The option-chip group has two copies: GuestOptionSheet.jsx:~249–315 and GuestComboSheet.jsx:~520–580.
  - **Fix:** move both into one shared module.
  
  **[P3] The thumbnail's alt text repeats the dish name** beside it (GuestMenu.jsx:1477). Use `alt=""`, the same reasoning the logo already follows.
  
  **[P3] Booking day cells are smaller than their comment claims.** guestBooking.css:75–76 says about 44px at 360px; the CSS works out to 38.6px at 360 and 32.9px at 320. The 10px "Walk-in" and AD-date labels likely get cut off ("Wal…").
  
  **[P3] The sheet's height cap only works on newer browsers.** `.modal-sheet` sets `max-height: 88dvh` with no `vh` fallback (Layout.css:86), and the overlay doesn't scroll (Modal.js:137). On a browser without `dvh`, the top of a tall sheet (title, size group) is clipped and cannot be reached. Also, the 16px side gutters take no side safe-area inset in landscape with `viewport-fit=cover`.
  
  **[P3] The filter sheet's "Show N dishes" counts dishes only** (GuestMenu.jsx:1145), although the filters also narrow combos.
  
  ### 3. Checked and dismissed
  - **Missing alt text:** every image has alt. Logos use `alt=""` on purpose.
  - **iOS zoom on focus:** Layout.css is loaded eagerly (App.js:18), and its coarse-pointer `input/select/textarea { 16px !important }` reaches the menu's search box and note field. The booking page sets 16px on its own fields.
  - **44px floor:** `.btn` gets it from Layout.css; `.btn-sm` and `.tab-btn` get it from guestMenu.css's own coarse-pointer block. The booking page declares 44–56px itself, and its unclassed stepper buttons are also caught by `button:not([class])`.
  - **Scroll containers:** both roots are `100dvh`, `overflow-y: auto`, `overscroll-behavior: contain`, with no `min-height`. The booking page lacks the `vh` fallback but has nothing sticky or fixed that depends on it.
  - **`rgba(0,0,0,…)` cart-bar shadow:** a black shadow, matching precedent in Layout.css and the Night card shadow. Not a signal colour.
  - **Five `outline: none` rules:** each has a replacement or sits on a `tabIndex=-1` target that only scripts focus.
  - **Veg/non-veg marks by hue only:** they have aria-labels, and green vs red measured ΔE about 18.5 (deuteranopia) and 23.5 (protanopia), above the project's floor of 8.
  - **Disabled-chip text at 3.54:1:** inactive controls are exempt.
  - **Effect cleanup:** intervals, observers and listeners are all removed. The chime uses the shared AudioContext.
  - **Reduced motion:** the glow, sheet entrance and shimmer are switched off by Layout.css, and the bars by guestMenu.css. The booking page's `no-preference` opt-in fits with that.
  
  ### 4. Worth keeping
  - Every sheet goes through `Modal`, plus the Back-closes-sheet history stack and the `dirty` backdrop guard.
  - Focus moves from Add to the new "+", and back to Add at zero. Stepper labels name the dish.
  - Progress bars use `scaleX` and the tracker is a labelled `<ol>` with `aria-current="step"`. Every small-text pairing clears 4.8:1.
  - No raw `err.message` on either public page. Refusals are worded by code and name the outlet.
  


---
[P3] The payment QR is regenerated on every keystroke** — 1056-1064.
  - Each change to `payTotal`/`tenderAmtStr` runs `QRCode.toDataURL` on the main thread, then an extra full render. `cancelled` only throws the result away.
  - Fix: debounce it by `PREVIEW_DEBOUNCE_MS`, as the bill preview already is.
  
  **[P3] Some poll paths still set state unconditionally** — re-render every 5-15 s when nothing changed.
  - 1844 `setKotStatusByTable({})` on a floor with no open orders.
  - 1869 `setOrderKotTickets([])` every 5 s while offline.
  - 1453/1462 on the link-down branch of the floor poll.
  - useStationPrinting.js:102, where `flatMap` returns a new array on every tick while a slip is being watched.
  - Fix: return early when the state is already empty, or use `setIfChanged`.
  
  **[P3] An old Escape listener closes Recent Bills under the Credit Note dialog** — 1219-1227.
  - Covers and Recent Bills are now on `Modal`, but this document listener ignores Modal's stack, so one Escape closes both layers. Its comment saying "none use Modal.js" is out of date.
  - Fix: delete it.
  
  **[P3] Idle lock** — two small issues:
  - usePosIdleLock.js:112 writes to localStorage on every pointerdown, touchstart, keydown and wheel event, synchronously. Throttle to once a second.
  - The countdown (146 → Layout.js:2288) is a `role="alert"` whose text changes every second, so a screen reader re-announces it 20 times. Announce once and mark the ticking number `aria-hidden`.
  
  ## 3. False positives checked and dismissed
  - `publishTillGuestView` runs after every render, but it is a signature compare that notifies nobody when nothing changed.
  - Layout's 1 s guest-alert tick and idle countdown do not re-render PosOrders: the Outlet element is the same object, so React skips it.
  - The floor KOT poll lists `tableOrders` in its deps, but `setIfChanged` means it restarts only on real changes, about every 15 s at most, so it never starves.
  - `tenders` uses `key={i}`, which is safe: the list is append and undo-last only.
  - The resize listeners set booleans, so an unchanged value skips the render.
  - Polls don't pause in a hidden tab, but browsers throttle hidden tabs to about one timer a minute and Android freezes them, and the guest-order chime has to keep sounding anyway.
  - The covers keydown handler re-subscribes on each digit: cheap and deliberate, and it skips inputs.
  - No `xlsx` import, no layout reads in render, no BroadcastChannel.
  
  ## 4. Positives worth keeping
  - Every interval and listener is cleaned up. `setIfChanged` signatures cover the KOT, guest-order, floor and reservation polls.
  - The latest-ref pattern (`closeOrderRef`, `loadFloorRef`, `sendPollRef`, `payTotalRef`) keeps intervals from restarting on keystrokes.
  - The bill preview iframe is debounced (200 ms) and the loyalty lookup too (400 ms), and the `Intl` formatters are built once (nepalMoney, nepalTime).
  - The `savingRef`/`closingRef` re-entry guards stop double sends and charges. The idle lock measures from the last real input, so it never locks someone mid-typing.



## Resolution (S841, S842, S844 — 2026-10-15)

Every finding is closed, in three releases, each with a CHANGELOG entry in `CHANGELOG/S804-S853.md`.

| Release | What it closed |
| --- | --- |
| S841 (crest-v457) | P0 and P1: the till's saved menu on a dead internet (`tillOffline()`, 10 s bound), one table opening at a time, the shell `inert` behind the order screen, Modal / RowMenu / BsCalendarPicker focus, 44px touch targets, `aria-pressed` on selected controls, the PIN list bounded, guest pages' spoken status |
| S842 (crest-v458) | The P2 list: memoised menu grid, keyed cart lines, polls paused offline, bounded report reads, register paging, `dirty` backdrop guard on every Modal variant, guest Back asks, Credit settle confirms, KDS error card and narrow layout, dish-photo thumbnails, read-out save results |
| S844 (crest-v460) | The P3 list above (all helpers' items, including the KDS id sets, estimate keypad names, PIN key touch feedback, safe areas, Parking leftovers, heading outline, the hourly chart's text alternative, report error forms and the shared letterhead, totals rows, emoji icons, the diet mark and option chips, booking day labels, the filter count, `.modal-sheet`'s `vh` fallback), the Bill Register phone cards, and the floor's `window.alert`s replaced by a till notice (owner decision) |

Found while fixing and filed in `POS_TODO.md` B3, not fixed: `useBizInfo()` has no loaded flag, so three
reports offer Excel before the letterhead has loaded; `sheetWithLetterhead`'s closing blank row never
reaches the sheet.
