# Crest Suite: `/impeccable audit`, whole product (2026-10-20)

**Scope.** The whole product, read at the code level (586 source files, about 10,000 lines of CSS). The three module audits since the last whole-product pass (IMS 29 Sept, HR 6 Oct, POS 15 Oct) were each fixed and closed, so this pass spent most of its reading where no audit has been since 5 Sept:

- the app shell and shared components (`src/components`, the shared hooks, theme presets);
- the dashboards and the Crest Suite Pro pages (Home, Inventory Dashboard, Owner Dashboard, Group Console, Consolidated P&L, Monthly Owner Report, Demand Forecast, Fixed Assets);
- the operator screens (Settings, Admin → Clients and the client drawer, Help, Audit Log, Periods, Customization, data export);
- everything seen without a full login (login, sign-up, reset, Pricing, Legal, the guest menu and booking page, the PIN logins, Crest Staff);
- a regression check of every line of IMS, HR and POS UI changed after its own audit.

Five read-only helpers each took one area. I opened every P0 and P1 below in the code myself. Contrast figures were computed from the preset values in `ThemeContext.js`, and I recomputed one of them by hand. **Nothing was measured in a browser this pass**, so overflow widths are worked out from the CSS and say so.

**Method note.** The detector (`detect.mjs`) was run over `src/` both with the project config and without it.

## Audit Health Score

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 2 | Shared components drop focus. Two examples: the searchable dropdown after a pick, and the closed phone drawer, which stays in the Tab order. Text-field borders measure about 1.4:1 on both themes. |
| 2 | Performance | 3 | Lean and lazy throughout. What is left is waiting: Home's four loaders, Settings saves and the Customization dialogs have no time limit. |
| 3 | Responsive Design | 3 | The phone-first surfaces hold. Pricing scrolls sideways on every phone, and the Crest Staff header never sticks. |
| 4 | Theming | 3 | Detector-clean. Home and the Owner Report paint correct figures red, green and crimson, while the Owner Dashboard paints the same figures in ink. |
| 5 | Implementation Integrity | 2 | Home's Top Variance treats an uncounted item as counted at zero. The client backup and Delete Client both carry on past a failed read. |
| **Total** | | **13/20** | **Acceptable (significant work needed)** |

**Against the 2026-09-05 baseline (13/20):** the total is the same, but the findings behind it are not. Every defect class that audit named in IMS, HR and POS was fixed and has not come back. In particular, HR is clean since its audit, and the classes the IMS audit fixed did not reappear in the new IMS code. What is left sits in two places:

- **Shared components.** Fixing one there fixes every page that uses it.
- **Pages no module audit owned:** Home, the admin screens and the signed-out pages.

## Implementation Integrity Verdict: **Pass on specificity, held at 2 by data honesty**

The system is coherent and product-specific.

- **Detector.** It reports **zero** generic anti-pattern findings across all 586 files. It reports four design-system advisories:
  - Three are legitimate exceptions: the guide's print stylesheet at `ModuleGuideTab.jsx:242/256`, and the one-line popup error page at `viewPosBill.js:25`. In both, the theme variables cannot resolve.
  - The fourth (`Login.css:561`) is a stale brass literal from before the Modernist re-theme. It never paints, because `Layout.css` sets the variable first.
- **Clickable rows.** All 15 `<tr onClick>` rows have a real keyboard button in the row.
- **Imports and fields.** No `xlsx` import loads at startup, and every password field sets `autoComplete`.

The score is held at 2 by one class of defect: **a figure shown that the page did not compute.** The pages built or audited since August handle this well: the Owner Dashboard, Group Console and Consolidated P&L each track loading, failed and empty separately. Home, the admin overview, the client backup and Delete Client do not.

## Executive Summary

- **Audit Health Score: 13/20 (Acceptable).**
- **Issues: 1 P0, 10 P1, 24 P2, about 30 P3.** P2 and P3 are grouped where one fix covers several sites.
- **Top issues:**
  1. **[P0] Home's Top Variance Items.** It lists every bought item as "Over-used", in red with a rupee "Value at Risk", for most of every month.
  2. **[P1] Home shows failed reads as real figures, and caches them.** Examples: "0 employees, NPR 0 payroll", a green "0 of 0" on Menu Health, and "✓ Nothing is waiting on you".
  3. **[P1] The client backup can succeed with no logins, PINs or settings in it.** That backup is what Delete Client and the trial purge check before they delete.
  4. **[P1] Four shared-component accessibility gaps that reach every page:**
     - the phone drawer stays in the Tab order while closed;
     - the searchable dropdown drops focus;
     - the chart Close button shows no focus;
     - text-field borders measure about 1.4:1.
  5. **[P1] The Pricing page's "Ask about" and "Email us" buttons** mail `hello@cresthospitality.com`, which the code itself marks as a placeholder, not the support address.
- **Recommended next steps:**
  - First, `harden` Home and the admin data paths: the P0 and the failed-read P1s.
  - Then one pass over the shared components. It is the cheapest fix with the widest reach.
  - Then `colorize` the dashboards and `adapt` the signed-out pages.

## Detailed Findings by Severity

### P0: Blocking

**[P0] Home's Top Variance Items treats "not counted yet" as "counted zero"**
- **Location:** [ClientDashboard.jsx:838-846](src/pages/dashboard/ClientDashboard.jsx#L838-L846). Rendered at :3191-3226.
- **Category:** Implementation Integrity
- **Impact:** The card reads the open month, where closing counts mostly do not exist yet. The code computes `actual = opening + purchases − (closeMap[id] || 0)`, so a missing count becomes 0.
  - Every item bought and not yet used up by recipe sales therefore shows as "Over-used", in red, with "Value at Risk NPR …".
  - It shows every day until the count, on the first screen the Owner opens.
  - An owner reading it could conclude staff are wasting or stealing stock.
  - The Variance page and the Owner Report already avoid this through `closingCountMap` / `judgedRows` in [variancePopulation.js](src/modules/ims/variance/variancePopulation.js). This card was never moved onto them.
- **Standard:** CLAUDE.md "A report never shows a number it did not compute"; `ims-figures.md` (an open month's variance is not a verdict).
- **Recommendation:** Build the rows through `closingCountMap` / `judgedRows`. When nothing is counted, show "Needs a stock count", with a link to Stock Count, in place of the table.
- **Suggested command:** `/impeccable harden`

### P1: Major

**[P1] Home renders failed reads as real figures, and caches some of them**
- **Location:** [ClientDashboard.jsx](src/pages/dashboard/ClientDashboard.jsx) and [HomeAttention.jsx:128](src/pages/dashboard/HomeAttention.jsx#L128)
  - `loadHrStats` :1125-1137 (verified). A failed `hr_employees` read gives `total/active/payroll = 0`, and `setAndCache` stores those zeros for the next visit.
  - Sales Mix (:2006, :3125-3130) destructures `{ buckets, loading }` and drops `error`, so a failed read says "No sales data".
  - `figuresFailed` (:722) covers reads 0, 1, 2, 5 and 8 only. So a failed wastage read shows "NPR 0", and a failed recipes read shows Menu Health "0 of 0" in green. Failed purchases and par reads show as empty states.
  - HomeAttention's par row is hard-coded `failed: false` (verified), so it can say "✓ Nothing is waiting on you right now" over a read that failed.
- **Category:** Implementation Integrity
- **Impact:** A banner saying "may be incomplete" sits above tiles that read as real, some in green. Cached zeros outlive the failure.
- **Recommendation:**
  - Give each tile its own failure flag, and show "—" with "Couldn't load".
  - Never cache a load that had a failed read (the `homePosStats.keepLastGood` pattern).
  - Pass a null `reorderCount` to HomeAttention as `failed`.
- **Suggested command:** `/impeccable harden`

**[P1] The client backup succeeds with missing parts**
- **Location:** [exportClientData.js:144-166](src/modules/admin/dataExport/exportClientData.js#L144-L166) (verified)
- **Category:** Implementation Integrity
- **Impact:** Four reads are destructured with no `error`: the staff-names RPC, `settings`, the `profiles` roster and `staff_pin_vault`.
  - If any of them fails, the backup is written with that part empty, and `last_backup_at` is stamped.
  - That stamp is guard 6 of the trial purge, and it is what `preflightBackup` checks before Delete Client.
  - So a client could be deleted on a backup that cannot restore their logins, PINs, branding, VAT number or payment QR.
- **Standard:** PRODUCT.md, Data Ownership: "never destroyed silently".
- **Recommendation:** Check each `error` and throw, as `readAll` in the same file already does.
- **Suggested command:** `/impeccable harden`

**[P1] Delete Client carries on past a failed login read**
- **Location:** [ClientDrawer.js:1355](src/pages/adminClients/ClientDrawer.js#L1355) (verified)
- **Category:** Implementation Integrity
- **Impact:** The `profiles` read drops `error`. On failure the logins loop does nothing and `userFailures` stays empty, so the code goes on to clear the client's data.
  - The final `clients` delete is then refused by the profiles foreign key.
  - The message says the logins were removed, and they were not.
  - This breaks the comment's own guarantee: "stop BEFORE touching data".
- **Recommendation:** Stop on `error` before any delete, and say nothing was changed.
- **Suggested command:** `/impeccable harden`

**[P1] The closed phone drawer stays in the Tab and screen-reader order**
- **Location:** [Layout.js:1470](src/components/Layout.js#L1470), [Layout.css:4303-4317](src/components/Layout.css#L4303-L4317) (verified)
- **Category:** Accessibility
- **Impact:** Under 768px the closed drawer is only moved off screen with `translateX(-100%)`. `inert` is set only while the till layer is up.
  - A keyboard user on a phone, or on an iPad in portrait, tabs through about 41 invisible links before reaching the page.
  - VoiceOver and TalkBack swipe through the whole hidden menu.
- **Standard:** WCAG 2.4.3 Focus Order (A)
- **Recommendation:** Set `inert={tillLayerUp || (isPhone && !mobileSidebarOpen)}`, or use `visibility: hidden` on the closed state with the visibility change delayed until after the slide.
- **Suggested command:** `/impeccable harden`

**[P1] The searchable dropdown drops focus to the top of the page**
- **Location:** [SearchableSelect.js:63, 97](src/components/SearchableSelect.js#L63) (verified)
- **Category:** Accessibility
- **Impact:** `pick()` and Escape call `close()`, which unmounts the focused filter box and never returns focus to the trigger. Focus falls to `<body>`.
  - This is the product's long-list picker: vendors, items, employees.
  - Inside a dialog, the next Tab leaves the dialog altogether.
  - `BsCalendarPicker` already works around the same shape, so the pattern is known.
- **Standard:** WCAG 2.4.3 (A)
- **Recommendation:** Keep a ref to the trigger and focus it in `pick()` and on Escape.
- **Suggested command:** `/impeccable harden`

**[P1] The chart expand and Close buttons show no focus**
- **Location:** [Layout.css:146-172](src/components/Layout.css#L146-L172), [ChartCard.js:84-86](src/components/ChartCard.js#L84-L86) (verified)
- **Category:** Accessibility
- **Impact:** Focus shows only the soft ring, which measures 1.19:1 on Light and 1.22:1 on Night. There is no `--theme-focus-outline`.
  - On Close, an inline border also beats the class's accent border.
  - The Close control of every expanded chart dialog therefore has no visible focus.
- **Standard:** WCAG 2.4.7 (AA); DESIGN.md "pair the soft ring with the solid outline".
- **Recommendation:** Use the 2px `--theme-focus-outline` plus ring pair, and move the border into the class.
- **Suggested command:** `/impeccable polish`

**[P1] Text-field borders are too faint to find**
- **Location:** The input border and well tokens, which reach every `.form-input`, `.form-select` and the custom select and date triggers.
- **Category:** Accessibility / Theming
- **Impact:** Measured from the presets:
  - border against the input well: 1.48:1 on Light, 1.44:1 on Night;
  - well against the card: 1.21:1 on Light, 1.06:1 on Night.
  
  A low-vision owner or an outdoor tablet user cannot see where a field is.
- **Standard:** WCAG 1.4.11 Non-text Contrast (AA), 3:1
- **Recommendation:** An input-only border token at 3:1 or better against both the card and the well. It is one token per preset, plus `check-design-layers.mjs`.
- **Suggested command:** `/impeccable colorize`

**[P1] The urgent arrival banner's text fails AA, worst at the pulse peak**
- **Location:** [ArrivalAlert.css](src/components/ArrivalAlert.css), lines 58-64, 86-107 (Night figure re-computed by hand)
- **Category:** Accessibility / Theming
- **Impact:** The urgent title is `--theme-red-text` at 17px/700, which is not large text, set on its own red fill:
  - Night: 3.87:1 at rest, 2.65:1 at the pulse peak, 3.20:1 under reduced motion.
  - Light: 4.86:1 at rest, 3.57:1 at the peak.
  
  The detail line is text2. It measures 3.77:1 on Light's urgent fill and 4.05:1 on the amber banner. This is the banner a cashier has to read mid-service, and it carries the "sound is off" notice.
- **Standard:** WCAG 1.4.3 (AA)
- **Recommendation:** Set the title and detail in `--theme-text1`. The fill, border, icon and pulse already carry the red.
- **Suggested command:** `/impeccable colorize`

**[P1] Pricing's "Ask about" and "Email us" go to a placeholder address**
- **Location:** [Pricing.js:15, 139, 496](src/pages/Pricing.js#L15) (verified)
- **Category:** Implementation Integrity
- **Impact:** `const CONTACT_EMAIL = 'hello@cresthospitality.com'` sits under "Change this to the contact email when ready".
  - The support address everywhere else is `COMPANY.supportEmail` (`src/legal/index.js:95`), editable through `useSupportContact()`.
  - Every upgrade enquiry from a signed-in Owner, and every "Email us", goes to an address used nowhere else in the product.
- **Recommendation:** Read `useSupportContact().email`, with `COMPANY.supportEmail` as the fallback.
- **Suggested command:** `/impeccable harden`

### P2: Minor

Grouped where one fix covers several sites.

**Dashboards and Suite**
- **[P2] Correct figures painted as verdicts, and the pages disagree.**
  - Home paints figures with no band behind them: Net Purchases accent-ink (:2045), Revenue green (:2069), Wastage red above 0 (:2228), Active green (:2271), Basic Payroll accent-ink (:2281), POS Revenue green, Tables accent-ink.
  - [MonthlyOwnerReport.jsx](src/pages/dashboard/MonthlyOwnerReport.jsx) does the same at :877, :892 and :971.
  - The Owner Dashboard paints the same Revenue and Wastage in text1 (:518, :597). So one month's wastage is red on Home and neutral on the Owner Dashboard. On Light, accent-ink is a near-danger crimson.
  - IMS (S796), HR (S804) and POS (S846) each adopted the One Signal Meaning Rule; the dashboards never did.
  - **Fix:** text1 for figures, colour only from a band. `/impeccable colorize`
- **[P2] Home's clickable KPI cards are `role="button"` containers holding Tip triggers.**
  - Location: [ClientDashboard.jsx:1895-1904, 1919](src/pages/dashboard/ClientDashboard.jsx#L1895). A screen reader hears the whole card as one button, and the nested trigger is invalid inside it.
  - The Owner Dashboard's `button.stat-card__open` (S803) is the pattern.
  - `UpsellCard` is also declared inside render, so it remounts on every Home re-render.
  - `/impeccable harden`
- **[P2] Home can freeze a wrong Target for the month.** Capture checks `!historyFailed` but not `hadRealError` (:936), so a load whose recipes or sales read failed can still write the snapshot that the database then freezes. `/impeccable harden`
- **[P2] The Admin overview tiles render after a failed read.**
  - Location: [AdminDashboardOverview.jsx:64, 284ff](src/pages/dashboard/AdminDashboardOverview.jsx#L64).
  - A failed `monthly_periods` read puts every client in the red "No Open Period" tile.
  - A failed clients read shows "Est. Monthly Revenue NPR 0".
  - `/impeccable harden`
- **[P2] Fixed Assets shows NBV and % Depreciated after a failed depreciation read** ([AssetRegisterTab.js:183, 205](src/modules/ims/assets/AssetRegisterTab.js#L183)). The explanation sits below a long table. `/impeccable harden`
- **[P2] The Owner Dashboard trend's screen-reader text has no numbers** ([OwnerDashboard.jsx:685-688](src/pages/dashboard/OwnerDashboard.jsx#L685)). Home's `fcTrendSummary` is the pattern. `/impeccable clarify`
- **[P2] The S851 hollow "today so far" dot is explained only in one branch of the footer.** When the history or festival read fails, or there is no projection, the dot appears with no words (:2588-2612, :2677-2692). Add a legend chip that does not depend on the footer. `/impeccable clarify`

**Shared components**
- **[P2] The Confirm button disables itself while working.**
  - Location: [ConfirmModal.js:33](src/components/ConfirmModal.js#L33).
  - Focus falls to `<body>` for up to `CONFIRM_TIMEOUT_MS` (30s), Tab leaves the dialog, and "Working…" is never announced.
  - **Fix:** `aria-busy` plus a re-entry guard in `useConfirm.run`.
  - `/impeccable harden`
- **[P2] RowMenu's Tab closes the menu without returning focus** ([RowMenu.jsx:72](src/components/RowMenu.jsx#L72)). This contradicts its own comment at :17. `/impeccable harden`
- **[P2] Tip cannot be dismissed with Escape and cannot be hovered** ([Tip.js](src/components/Tip.js), about 60 sites). The 220px bubble covers the field below a label. WCAG 1.4.13 (AA). `/impeccable harden`
- **[P2] Custom controls fall back to the browser's focus ring.**
  - Affected: the SearchableSelect and BsCalendarPicker triggers (inline `boxShadow: 'none'`), the picker's arrow, Today and Clear buttons, and the Calculator keys.
  - Shell nav focus (Layout.css:1575-1584) uses `--theme-accent`, not `--theme-focus-outline`, which measures 3.91:1 on the Light sidebar.
  - `/impeccable polish`
- **[P2] The command palette can show the previous outlet's pages after a switch.** `paletteItems` (Layout.js:1104-1140) leaves out `hasFeature`, the rank helpers, `imsCountOnly`, `groupId` and `clientId` from its dependencies. This is the S638 class of bug. `/impeccable harden`
- **[P2] The outlet switcher declares `role="listbox"`** (with no name) around tabbable `role="option"` buttons, with no arrow-key model (Layout.js:1656, 1934, 1266-1280). Drop the roles and use `aria-current`. `/impeccable harden`
- **[P2] The Calculator's copy and tape actions are `div`/`span` elements, and ⌫ and C have no names** (Calculator.js:282, 302-303, 316, 327). `/impeccable harden`
- **[P2] The base accent is used as text.** ProtectedRoute's "Loading" (ProtectedRoute.js:22) measures 4.25:1 on the Light page, and it shows on every sign-in. `.print-sheet-cat` on screen in Stock Count's Print tab measures 3.91:1. Use `--theme-accent-ink`. `/impeccable colorize`
- **[P2] Four overlays size to `100vh`:** the phone drawer (Layout.css:732, 739), the chart modal, the Calculator and the command palette. On a phone the drawer's Support, Help and Sign-out row sits under the browser toolbar, and the palette list under the keyboard. Use `100vh` then `100dvh`. `/impeccable adapt`

**Waiting without a limit (systemic: outside HR and POS, nothing was swept)**
- **[P2] No timeout on reads and saves outside HR and POS:**
  - Home's `loadStats`, `loadHrStats`, `loadPosStats` and `loadFcTrend` (a hang means shimmering tiles and no Retry);
  - Settings' `commitPatch`, `saveCategories`, `savePlatform` and `commitPrices`, where `if (saving) return` blocks every retry;
  - all six Customization dialogs and the OptionGroups load;
  - Signup's `register_trial`;
  - Audit Log's purge, inside a busy confirm that cannot be cancelled;
  - the till's credit-limit lookup (PosOrders.jsx:1165), where a hang means the over-limit warning silently never shows.
  
  The Owner Dashboard's `settleWithin` and the Combo dialogs are the pattern. `/impeccable harden`

**Raw errors and lost input**
- **[P2] Raw technical text reaches users** in:
  - Login's forgot-password (Login.js:149);
  - ResetPassword.js:63;
  - Signup.js:124-128 ("Failed to send a request to the Edge Function");
  - the credit-receipt print path (CreditTab.jsx:248: `TypeError: Failed to fetch` run into "Press Reprint…");
  - the client drawer's Users tab (ClientDrawer.js:439-592, `'… failed: ' + error.message` in a hand-rolled alert).
  
  Route each through `errorText` / `asActionError`. `/impeccable clarify`
- **[P2] A backdrop tap discards typed figures** in the new "Correct FY openings" dialog (TaxPoolOpeningsCard.jsx:400, no `dirty`). POS adopted `dirty` in S842; IMS and HR never did. Audit their data-entry dialogs. `/impeccable harden`
- **[P2] Focus is lost after a row action that reloads.**
  - Stock Transfers swaps the whole tab for "Loading…" after Receive, Refuse, Cancel and Send (StockTransfers.jsx:81).
  - Membership card-type delete (MembershipTab.jsx:316), the transfer form's remove × and the customer agreement toggle do the same.
  - CreditTab's `outcomeRef` is the pattern.
  - `/impeccable harden`

**Operator screens**
- **[P2] Periods' admin all-clients table dims inactive rows with `opacity: 0.45`** (Periods.js:865). This takes the name and three action buttons below AA.
  - The same rows' rename controls are inline-styled, their errors carry no `role="alert"`, and five row actions are classless 22px buttons with End Period beside Close & Start Next.
  - `/impeccable harden`
- **[P2] Admin → Clients' Trial Accounts rows do not wrap.** The actions cluster is `flexShrink: 0` inside an `overflow: hidden` panel, so Manage is cut off at 390px (AdminClients.js:472-563, worked out from the CSS).
  - In the same rows, text3 sits on a red tint and Manage is painted red.
  - `/impeccable adapt`
- **[P2] The module guide's two columns never stack.** The content is `flex: 1` with a zero basis, so at 390px the guide text gets about 48px of width (ModuleGuideTab.jsx:59-62, 115). `/impeccable adapt`
- **[P2] Help's Module Guide tier chips have three problems:**
  - 9px text;
  - Starter is text3 on an 8% tint of itself;
  - Growth is painted green, a verdict colour on a category.
  
  Location: Help.js:1781-1810, with more 9px text at :1892, :2001 and :2008. `/impeccable typeset`

**Signed-out and phone-first pages**
- **[P2] Pricing scrolls sideways on every phone.** The Suite card's `gridColumn: 'span 2'` in a one-column auto-fit grid adds a second track, overflowing by about 6px at 390 and 36px at 360 (Pricing.js:403, 429, computed). `/impeccable adapt`
- **[P2] Pricing sits outside the class system.**
  - 103 inline style objects and 12 unclassed buttons, so no call-to-action has the focus pair.
  - The FAQ dialog is hand-rolled: `aria-modal` but no focus move, trap or restore, and a 13px × button (Pricing.js:450-470).
  - **Fix:** a Pricing.css plus `btn` variants, and `Modal` for the FAQ.
  - `/impeccable polish`
- **[P2] Login, sign-up and reset fields lose the solid focus outline.** `.login-field input:focus` (Login.css:559-562) beats the global `input:focus-visible` pair and leaves a 1px border plus the faint ring. The file's own comment at :354 says otherwise. `/impeccable harden`
- **[P2] The Crest Staff header never sticks.** `.ss-topbar` is `position: sticky` in the body flow (selfService.css:62-75), which is the dead-sticky S604 shape. The ⋯ account and sign-out menu scrolls away. In the installed app, content scrolls under the status bar. `/impeccable adapt`
- **[P2] The signed-out pages ignore the safe area that index.html opts into.** Login.css, Signup.css, Legal.css and Pricing all have this gap. An installed app opening on /login puts the clock over the brand and the trial button. `/impeccable adapt`
- **[P2] Login's sticky header grows to about 104px on a phone at 640px and below** (Login.css:1021-1053), with nothing keeping the focused field clear when the keyboard is up. Legal.css makes its header static at this width for exactly this reason. `/impeccable adapt`
- **[P2] Signed-out forms and links:**
  - Every signed-out route is titled "Crest Suite" (WCAG 2.4.2, Level A).
  - Sign-up's business name, name, phone and address carry no `autoComplete` tokens (1.3.5).
  - Sign-up's "please sign in" link is the browser's blue, about 2:1 (Signup.js:185).
  
  `/impeccable clarify`

### P3: Polish (compact)

**Type below the 10px floor**
- 9px and 8px text in app UI: Layout.js:921/977/1318-1319 (PRO badge, upgrade panel), BsCalendarPicker.js:356, StatPill.js:20, and the chart ticks and weekday initials on Home (:2779, :2774/2818, :2548, :2952-2954).
- The type-ramp test allows 9px as the chevron step, so it cannot catch 9px used as text.

**Motion**
- `pulse-dot` and `arrival-alert-pulse` repaint every frame for ever.
- ChartCard's `blur(3px)` covers the whole dashboard.
- The drawer slide (Layout.css:4307) and the dropdown arrow (:1031) are missing from the reduced-motion block.
- Inline 160ms transitions use `--motion-fast`, which reduced motion does not zero.

**Polling and loading**
- `useNavBadgeCounts` polls five queries every 60s in hidden tabs.
- index.html loads a render-blocking Google Fonts stylesheet with six faces. Self-host the two or three weights in use.
- The platform settings row is read on every guest-menu load.

**Charts**
- Recharts 3 gives every chart an unnamed `svg tabindex=0`. ChartCard is the one place to name it.
- `interval={0}` axes overlap at 390px (OwnerDashboard.jsx:694, Home's expanded daily chart).
- The Owner Dashboard tooltip hand-rolls its chrome instead of using `TOOLTIP_CHROME`.

**Theme odds and ends**
- No `color-scheme` is declared, so native controls render light on Night.
- `theme-color` and the `html` background are fixed at #191817 for Light users.
- AppErrorBoundary.jsx:154 uses a frozen `rgba(248,113,113,…)`, and AdminDashboardOverview.jsx:387 a frozen `rgba(217,119,6,0.15)`.

**Colour on facts, not verdicts**
- The till's "Remaining" is amber or green with no mark (PosOrders.jsx:7749).
- Credit's "Over 90 days" is amber above 0 with no △ (CreditTab.jsx:440, 577).
- Price movers are red ▲ or green ▼ with no dead zone (ImsPriceMovers.jsx:93).
- Asset "disposed" is `badge-red`, and the Owner Report's menu-engineering quadrants are painted in signal colours.

**Headings and landmarks**
- Settings tabs jump from h1 to h3, as does Help's Getting Started when the guide renders nothing.
- Demand Forecast puts Tip ⓘ inside its h1 and h2 (DemandForecast.js:706, 913).
- GuestBooking and LegalReacceptance have no `<main>`.

**Accessible names and announcements**
- Repeated row actions with generic names: "Receive" on every incoming transfer; "Create purchase order" per supplier.
- ReceivePaymentModal's `role="status"` paragraph re-announces on every keystroke.
- The rail's Support, Help and Sign-out have `title` but no `aria-label`.

**Small controls**
- 10–11px "Full Report →" buttons, and "Set par levels →" at 105×26 (flagged 5 Sept, still open).
- SelfServiceLogin's keypad is a copy of PosLogin's that missed the S844 `.pos-pin-key` fix.
- posLogin.css uses `min-height: 100vh`.

**Copy**
- Pricing's FAQ lists "Cash, Credit, and FonePay"; the till offers five methods.
- index.html and manifest.json still describe "Food cost & inventory management".
- LegalReacceptance says "We've updated our terms" on v1.0 to Owners who never accepted anything.
- Login copy lines :71, :72 and :78 break the problem-then-relief, no-subclause rule.

**Small residue**
- Georgia on client and module names (AdminClients.js:640, ClientDrawer.js:1499, Help.js).
- Employee "Reactivate" still uses `window.confirm` (EmployeeForm.jsx:315). It is not a routine delete, so it falls outside the documented exception.
- `loadLastSeen` drops its error (AdminClients.js:100, flagged 5 Sept).
- Header navigation is `<button onClick={navigate}>` on Login and Signup, so it cannot be middle-clicked.
- The two new wide tables (transfers, membership) have no phone cards.
- TillNotice at z-index 2200 sits above an open dialog's trap, so its ✕ cannot be reached by keyboard.

## Patterns & Systemic Issues

1. **A figure the page did not compute is still the leading defect, now outside the modules.** Every module audit fixed this class in its own pages. Home, the admin overview, the client backup and Delete Client were never in a module audit, and all four still have it. The Owner Dashboard, which tracks each section as loading, ok, failed or none with its own Retry, is the template for Home.
2. **Waits with no limit, outside HR and POS.** The HR (S803) and POS audits bounded every await in their modules. Home, Settings, Customization, Signup and Audit Log were never swept.
3. **Shared components that lose focus.** SearchableSelect, RowMenu's Tab, ConfirmModal's busy state, and the phone drawer. Each is one fix that covers every page using it, which makes them the best value in this report.
4. **The dashboards missed the One Signal Meaning Rule.** IMS, HR and POS each took colour off correct figures. Home and the Owner Report did not, so the same month's wastage reads as a verdict on one page and a fact on the next.
5. **The signed-out pages invent their own controls and miss the shell's protections.** They miss the focus pair, the touch floor, the safe area and dead-sticky handling. Pricing is the extreme case: 103 inline style objects and one class.
6. **Two contrast floors were never measured: field borders, and text on a tinted fill.** The field-border case is 1.4.11 on both themes. The tinted-fill cases are the urgent banner, text3 on a hovered row (4.34:1 on Light) and the trial rows. The `*-text` work in S549 and S608 measured text on cards and the page ground only.

## Positive Findings

- **Detector-clean at scale.** There are zero generic anti-pattern findings in 586 files, and every `var(--x, #hex)` fallback matches the DESIGN.md frontmatter. The four advisories are three legitimate exceptions and one dead literal.
- **The module audits held.**
  - HR has had no regressions since 6 Oct, across 18 commits and 2,442 added lines.
  - The defect classes the IMS audit fixed (phone clipping, unnamed count boxes, opacity rows) did not come back in 7,000 lines of new IMS code.
  - New POS credit and membership code is a model: bounded, paged and chunked reads; phone cards on every view; row actions named after the party; `table-stack` instead of duplicated inputs.
- **Strong primitives.**
  - `Modal`: stacking, a trap, focus restore, `dirty`.
  - `CommandPalette`: a real dialog with a combobox and a live count.
  - `Tabs` and `FilterChips`: the correct tablist versus pressed-group split.
  - `RowDisclosure`.
  - All 15 clickable table rows have a real keyboard button.
- **Motion is disciplined.** Every stylesheet that animates carries its own reduced-motion guard, Recharts goes through `chartMotion()`, and nothing animates layout properties.
- **The phone-first guest surfaces are solid:**
  - the guest menu's steppers are named and 44px;
  - the booking page has roving radiogroups and refusals worded by code;
  - PosLogin's keys are named and the digit count is announced;
  - each runs in its own `100dvh` scrollport.
- **Performance basics are right.** Every route is lazy, `xlsx` loads on click only, guest polls pause in hidden tabs and skip re-renders through `setIfChanged`, and reads are paged with `fetchAllRows`.

## Recommended Actions

1. **[P0/P1] `/impeccable harden` on Home and the admin data paths.**
   - Top Variance onto `judgedRows`.
   - Per-tile failure flags, with no caching of a failed load.
   - HomeAttention's par row.
   - The Target capture guard.
   - The backup's four reads and Delete Client's login read.
   - The admin overview and Fixed Assets NBV after a failed read.
2. **[P1] `/impeccable harden` on the shared components.**
   - The drawer `inert` when closed.
   - SearchableSelect returns focus.
   - RowMenu Tab, ConfirmModal busy, Tip Escape and hover.
   - The outlet switcher's roles, the Calculator controls, and the palette's dependencies.
3. **[P1] `/impeccable colorize`.**
   - The field-border token.
   - Arrival alert text in ink.
   - Accent-as-text to `accent-ink`.
   - Then figures in ink on Home and the Owner Report.
4. **[P1] `/impeccable harden` on Pricing's contact address**, together with timeouts on Home, Settings, Customization, Signup, Audit Log's purge and the till credit lookup.
5. **[P1/P2] `/impeccable polish` on focus.** Chart buttons and custom controls onto the focus pair; the login fields' focus.
6. **[P2] `/impeccable adapt`.**
   - Pricing's grid span and the Crest Staff scrollport.
   - Safe areas on the signed-out pages, and Login's header on phones.
   - The admin Trial Accounts rows and the module guide stacking.
   - The `100vh` overlays.
7. **[P2] `/impeccable clarify`.**
   - Raw error text on the signed-out forms, the credit print path and the client drawer.
   - Per-route titles and sign-up autocomplete.
   - The Owner Dashboard trend's screen-reader figures and the hollow-dot legend.
8. **[P2/P3] `/impeccable typeset`.** The 9px text sites and the Help tier chips.
9. **`/impeccable polish`.** The final pass.

You can ask me to run these one at a time, all at once, or in any order you prefer.

Re-run `/impeccable audit` after fixes to see your score improve.

## Resolution (S852, 2026-10-21)

Every finding is closed in one release, S852 (crest-v467), with its CHANGELOG entry in
`CHANGELOG/S804-S853.md`. Seven helpers took one area each on separate files; one build, one release.
Owner decisions are listed in that entry.

| Area | What it closed |
| --- | --- |
| Home | The P0 (Top Variance over `closingCountMap` / `judgedRows`, "Needs a stock count"), per-tile failure flags with no caching of a failed load, HomeAttention's par row, the Target capture guard, bounded loaders, figures in ink, `stat-card__open` figures, the hollow-dot legend, 10px chart text, real small buttons |
| Admin data | The backup's four reads, Delete Client's login read, the client drawer's raw errors (Users, Staff PINs, Backup, Danger), Periods' all-clients table, Trial Accounts rows, the Audit Log purge bound, Georgia, `loadLastSeen` |
| Shell and shared components | The closed drawer `inert`, palette dependencies, the outlet switcher's roles, rail names, SearchableSelect / RowMenu focus, ConfirmModal busy, Tip Escape and hover, the focus pair on chart, picker and calculator controls, `100dvh` overlays, Calculator buttons, chart SVG names, motion, hidden-tab polling, the 9px rule, frozen rgba tints, and `Modal`'s typing guard on every variant (the IMS/HR `dirty` sweep) |
| Theme | `--theme-input-border` (3:1 on every ground, both presets), arrival banner text in ink, accent-as-text to `accent-ink`, `color-scheme` and `theme-color` following the theme |
| Signed-out pages | Pricing's support address, sideways scroll, class system and FAQ dialog; Login / Sign-up / Reset focus, errors, safe area, phone header, titles, autocomplete and link; the Sign-up bound; Crest Staff's sticky header and keypad; PosLogin `100dvh`; first-time terms wording; `<main>` landmarks; the guest platform-settings read |
| Owner pages | Owner Report figures and quadrant names in ink, the Owner Dashboard trend's screen-reader figures, ticks and tooltip chrome, the Admin overview after a failed read, Fixed Assets NBV after a failed read and its status chips, the price-mover dead zone, Demand Forecast's heading tips |
| Settings, Customization, Help | Bounded saves (logo and code runs included), bounded Option Groups and dialogs with Try again, chunked detach, the module guide stacking, Help's tier chips, 9px text, headings and Georgia |
| Module leftovers | Credit print errors, focus after Stock Transfers / Membership / transfer-form / agreement actions, the till credit-limit bound, △/✓ marks on Remaining and Over 90 days, named Receive and Create purchase order actions, the settled payment announcement, Reactivate on `useConfirm`, phone cards for transfers and members, TillNotice's ✕ in a dialog's Tab cycle, Period Comparison's 9px text |
| Performance | Archivo bundled (`@fontsource-variable/archivo`), no Google Fonts link, CSP narrowed to `'self'` for styles and fonts |

Found while fixing and filed, not fixed: the live Menu Engineering page still colours its quadrants
(its scatter chart uses the hue as identity, so it needs its own decision); Disposal Report colours
gain/loss by sign; Membership's Card types table overflows a 390px phone; `LegalReacceptance` cannot
tell a first acceptance from a re-acceptance exactly until `AuthContext` exposes `legalAccepted`; on
Modernist Light the installed app's black-translucent status bar draws white text on a light strip.
