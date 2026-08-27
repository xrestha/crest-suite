---
paths:
  - "src/**/*.css"
  - "src/components/**"
  - "src/pages/**"
  - "src/modules/**"
  - "DESIGN.md"
---

# Design system — tokens, motion, class names, and the field-state rules

Extracted from `CLAUDE.md` so it loads when you touch UI files rather than in every session.
`DESIGN.md` remains the source of truth for the closed radius/type scales; this file is the
accumulated set of rules and traps behind them.

### CSS variable theme system

All colors must use CSS variables, not hardcoded hex. The full token set:

```text
--theme-bg          --theme-card        --theme-border      --theme-border-lt
--theme-text1       --theme-text2       --theme-text3
--theme-accent      --theme-green       --theme-red         --theme-amber       --theme-purple
--theme-sidebar     --theme-input-bg    --theme-table-hover --theme-focus-ring  --theme-focus-outline
--theme-green-text  --theme-red-text    --theme-amber-text  --theme-purple-text --theme-accent-ink
```

**Three exceptions to the `*-text` rule, all found by applying it too broadly (S550).** A **legend swatch** keeps the series colour — it must equal the line it labels, and the label text beside it carries the contrast. A prop that receives a **series colour** (`StatPill`'s `color`, which drives its dot) keeps it; that component now takes a separate `textColor` for the value, because a chart hex set as 13px/700 type measured ~1.9:1 on a light card. And **a `color:` inside a ternary is still a `color:`** — about half the real sites are `x <= 35 ? green : amber : red`, which a property-level regex silently skips, so a sweep can report success having fixed under half. For JS (Recharts reads values, not CSS variables), `useTheme()`'s `colors` resolves `greenText`/`redText`/`amberText`/`purpleText`/`accentInk` with base fallbacks so they are defined on dark presets too. **The worst light preset is Rosé Dawn/Solarized (10/10 combinations failing, worst 2.05:1), not Latte (4/10)** — spot-check colour work on Rosé Dawn.

**A map whose `color:` key drives both a fill and a label needs two keys, not one (S551).** The IMS sweep converted 605 sites automatically but had to skip `Overheads.js` and `PaymentReport.js` by hand: their colour maps paint bucket dots, stacked-bar segments and progress bars *and* label the figures beside them. Both now carry `color` (fill, base token) plus `textColor` (label, `*-text` variant) — the same split `StatPill` got in S550. Before running a bulk `color:` transform over a file, grep it for `background: x.color` / `fill={x.color}`. Two more traps from the same sweep: a value-expression walker that stops at a newline **misses a ternary that wraps**, and a `borderRadius` transform must emit `'var(--radius-sm)'` **quoted** — a JS style object takes a string, and unquoted `var()` is a syntax error the build catches only if a build is actually run.

**`.tab-btn--active`, `.btn-primary` and `.stat-value.gold` were all failing AA, and they are shell rules (S551).** Found during the IMS phase but they render everywhere: the first failed on **7 of 10** presets (accent-as-text on a tint of that same accent), the second on 3 (white on the accent — i.e. every primary button in the product on Rosé Dawn, Light and Solarized). Fixed at the token level: those three light presets got a dark hue-matched `accentText`, and **Tokyo Night, Dracula and Nord gained an `accentInk`** — a light accent on a dark card is not automatically safe once the card is tinted with the accent itself. Also `.btn` and `.tab-btn` had **no `:focus-visible` rule at all** until S551, so most controls on a page fell back to the browser default outline.

**`--theme-focus-ring` is a TINT, `--theme-focus-outline` is the keyboard-focus indicator (S574).** The ring token doubles as the active-state *background* for rail buttons, module tabs and sidebar links, so its alpha must stay low — measured on Rosé Dawn the ring alone composited to 1.15:1, 2.6× below WCAG 2.2's 3:1 focus floor. Every `:focus-visible` rule now pairs the soft ring with a 2px solid `--theme-focus-outline` (ThemeContext resolves it per preset: `accentInk` on light, accent on dark). A new focusable control's `:focus-visible` should use the pair, never the ring alone. Related: `colorTint(color, pct)` in `pricingPlans.js` is the generic one-place alpha maths for tinting a `var()` token (`moduleTint` delegates to it) — reach for it instead of ever concatenating `${token}22`.

**A signal color used as TEXT takes the `*-text` variant; used as a FILL it takes the base token (S549).** This is not a style preference — one value cannot do both jobs on a light preset. Measured across the five light presets, **23 of 25 signal-color/surface combinations failed WCAG AA**, and `--theme-text3` failed on all five. `ThemeContext.js` now emits a darkened, hue-preserving text variant per light preset (dark presets fall back to the base color, so nothing changes there), and the neutral ramp was corrected in place. The palettes themselves are deliberately untouched — Latte/Rosé Dawn/Solarized are faithful reproductions people pick *because* they recognise those values, and the base tokens are still correct for charts, tints, borders and dots.

Practical rules: `.badge-*` classes already point at the variants, so anything using them is covered. Reach for a variant whenever you write `color:` with a signal token. **`--theme-accent-ink` is not `--theme-accent-text`** — `accent-ink` is the accent used *as* text (a link, an active nav item); `accent-text` is the foreground that sits *on* an accent fill. And when a constant is consumed by string concatenation for alpha (`${color}22`), a `var()` breaks it — use `color-mix()` or a tint helper, as `pricingPlans.js`'s `moduleTint()` does.

**Form controls do not inherit `font-family`.** `body` sets Poppins; every browser substitutes its own default into `input`/`button`/`select`/`textarea`, so before S549 every control in the app rendered in Arial. `index.css` now sets `font-family: inherit` on all four (plus `optgroup`, which Firefox styles separately). Don't re-add the per-class patches `Layout.css` had accumulated.

`--theme-purple` (added during the UI/UX audit pass) is for a genuine 4th/5th categorical color — e.g. Staff Meals in Stock.js/MonthlySummary.js, the sub-recipe tab underline in Recipes.js — that several files had previously hardcoded independently as the same violet hex with no shared source of truth. It is not a general-purpose semantic color like green/red/amber; reach for it only when a page already needs a distinct categorical hue beyond what accent/green/red/amber cover.

**Never build a multi-series chart palette out of the semantic tokens.** `accent`/`green`/`red`/`amber`/`purple` are five *roles*, not five distinguishable hues — `--theme-accent` and `--theme-purple` are the same hex in three presets (Dracula `#bd93f9`, Catppuccin Mocha `#cba6f7`, Latte `#8839ef`), and accent sits next to amber in Dark and Warm. A 5-slice pie built from them (S526's Revenue vs Cost Breakdown) drew near-identical slices in 5 of the 10 themes: measured on the Dark card surface, Tax & Fees↔Food Cost was ΔE 10.6 for normal vision (floor 15) and Overheads↔Food Cost was ΔE 5.1 under deuteranopia (floor 8). Note those were *different pairs* — the collision a sighted reader reports is not necessarily the worst one. Chart series use fixed literal hex instead (`CHART_COLORS` in `ClientDashboard.jsx` for cycled/unknown-length series; a named fixed-slot map like `COST_BREAKDOWN_COLORS` when the slices are a known set), which is the same exemption that already applies because CSS `var()` doesn't resolve inside Recharts' SVG `fill`. A fixed-hex chart palette is deliberately theme-independent — that's correct, not drift, and a hex appearing in a chart palette is **not** the S521 undocumented-accent violation (that rule is about UI chrome). Verify a new palette with the `dataviz` skill's `scripts/validate_palette.js` against the real card surfaces rather than by eye; Crest's hues will always fail its lightness band (they're brighter pastels than its reference steps) and warn on contrast against white cards — those two are properties of the whole existing palette, so treat only the CVD-separation and normal-vision floors as blocking.

**Exception:** Recharts SVG props (`fill`, `stroke`, `tick`) must stay as literal hex — CSS `var()` does not resolve inside SVG presentation attributes.

Shape and type have their own token sets at the top of `Layout.css`: `--radius-sm|md|lg|xl|full` (8/12/18/24/999px) and `--font-size-rail-icon|brand|nav-icon|nav-item|group-label|micro|chevron`. Both scales are **closed sets** — DESIGN.md's frontmatter is the source of truth for which steps exist, and the `/impeccable` hook flags any literal off those scales. If a genuinely new step is needed, add it to DESIGN.md first, then use it.

### Motion, and the two systems that don't talk to each other (S533)

`Layout.css`'s `:root` carries four motion tokens: `--motion-fast` (160ms) / `--ease-standard` for a state change in place (hover, active), and `--motion-slow` (260ms) / `--ease-entrance` (`cubic-bezier(0.16,1,0.3,1)`) for something arriving that wasn't on screen. Prefer these over a per-component literal — the sidebar comment already states the intent ("one deliberate system rather than several different per-rule timings") and `--ease-entrance` exists precisely because `ChartCard.js` had been shipping that curve as an inline literal.

**Recharts series animation is unreachable from CSS, and that is the whole reason `src/shared/chartMotion.js` exists.** Recharts interpolates SVG attributes in JavaScript, not through CSS transitions — so `@media (prefers-reduced-motion: reduce)` blocks in `Layout.css` do nothing to a chart, and for a long time every chart in the product animated at Recharts' default 1500ms regardless of what the user's OS asked for. Spread `{...chartMotion()}` onto every **series** element (`<Line>`/`<Bar>`/`<Pie>`/`<Area>`/`<Scatter>`), never the chart container; it returns `isAnimationActive:false` under reduced motion and 450ms/`ease-out` otherwise. Two constraints worth knowing before changing it: **Recharts accepts only `ease|ease-in|ease-out|ease-in-out|linear` for `animationEasing`** — a `cubic-bezier()` string is not valid, so `--ease-entrance` genuinely cannot be mirrored onto a series and the two systems agree on duration band only. And it is a **function called per render**, not a frozen object, so an OS-level preference change is picked up on the next render without a `matchMedia` subscription (same live-read approach `GuestMenu.jsx` uses).

**Charts get no page-load entrance motion on purpose.** These are Operate-mode surfaces; a dashboard mounting four charts that each animate for 1.5s reads as the page still loading. The 450ms figure is chosen to sit inside the same band as `ChartCard`'s expand sequence (panel 180ms, stat strip settling ~410ms) so a chart resolves *with* the card it arrived in.

**When moving an inline style to a class, migrate every property or the leftovers win silently.** Inline styles outrank class rules, so a half-migrated element fails only on the properties left behind — with no error. This shipped once (S533): `ChartCard`'s buttons kept an inline `background:'none'` after their colors moved to classes, so the hover *color* applied and the hover *background* never did. Caught by reading `getComputedStyle` in a real browser, not by inspection — the code looks correct on the page. Corollary for reduced-motion work specifically: an inline `style={{ animation }}` cannot be switched off by a media query at all, which is why the chart-modal animations had to become classes before they could be guarded.

**A tint built by string concatenation breaks the moment the colour is a `var()` — and it fails silently, four times over.** `` `${c.color}22` `` works when `c.color` is a hex literal and produces the invalid `var(--theme-green)22` when it isn't, so the element renders with *no* fill and *no* border and nothing errors. Found in Attendance's status legend (S570), then independently in Leave Management's type badges and Overtime's status pills (S572) — in the Leave case two of six leave types had been rendering untinted for as long as the seeds had contained tokens — then a fourth time in `Help.js`'s tier lock-chips, upgrade panel and plan cards (S576), against `tier.planColor`/`MODULE_COLORS.*`, which became `var()` tokens when the pricing data moved into `pricingPlans.js`. Use `colorTint(color, pct)` from `pricingPlans.js` (or `color-mix(in srgb, <c> 13%, transparent)` directly) instead. **Any constant that stores a colour and is later interpolated into a style string is a candidate**; grep for `}` followed by two hex digits inside a template literal before assuming a page is clean. As of S576 the codebase is clean — the only remaining matches are inside comments describing the bug.

**Alpha tints must be an rgba() of a documented color, not a near-miss.** The codebase's convention is a literal `rgba(201,168,76,0.35)`-style tint rather than `color-mix()`; the hook resolves those back to the palette, so `rgba(248,113,113,…)` (signal-danger) passes while `rgba(220,38,38,…)` (a second, undocumented red) is flagged as drift. Two named traps, both of which shipped as real bugs and were fixed in S424: **a solid signal-color fill needs a paired foreground token, and only `--theme-accent` has one** (`--theme-accent-text`). `--theme-red` ranges from light (`#f87171` Dark) to dark (`#dc2626` Bright) across the ten presets, so no single foreground contrasts on all of them — use DESIGN.md's tint pattern (alpha fill + full-opacity signal text) for red/amber/green instead of a solid fill. And **`rgba(255,255,255,…)` as a "slightly brighter border" is invisible on the five light presets** — step the border to the accent at low alpha instead.

**S424's two named traps both recurred once more, found by a full `/impeccable audit` pass (S521) rather than the hook** (the hook only runs on edited files — `AdminClients.js` hadn't been touched since before the S424 fix shipped, so its violations sat undetected). `AdminClients.js`'s Trial Accounts panel had a `linear-gradient()` header (the codebase's only confirmed instance of the no-gradient Cards rule being broken), solid `background:'#f87171'`/`color:'#fff'` fills on its count pill and "Wants to Subscribe" badge instead of the alpha-tint pattern, and a hardcoded `color:'#000'` on `var(--theme-accent)` for its "Annual" badge — the exact accent-text bug from S424, recurring. Same file's module pills and "Features" button also carried a second, undocumented accent color (`#60a5fa`/`#818cf8`, an indigo/blue with no home in the palette), independently duplicated in `SuiteGate.js`'s upsell card — both fixed to `var(--theme-accent)`/`var(--theme-focus-ring)`, matching the identical upsell card in `PremiumGate.js`, which never had the bug. All fixed in place rather than reworked — same components, same layout, just reading tokens instead of literals. Lesson: a hook that only fires on touched files will never catch drift in a file nobody has opened in months; a periodic full-project `/impeccable audit` is the only thing that does.

**The canonical neutral tint is `rgba(138,146,163,…)` — `--theme-text2` "Slate Text", the same value `.badge-gray` uses.** Three different greys were in play for one role until S540: the canonical slate; `rgba(107,114,128,…)` (`#6b7280`, which *is* documented — but as `chart-tick`, so using it for UI chrome passes a literal-value check while breaking DESIGN.md's chart/chrome separation); and `rgba(120,113,108,…)` (`#78716c`, documented nowhere at all). The plan badge in `ClientDrawer.js` and its duplicate in `AdminDashboardOverview.jsx` used *two different* greys within the same element — one for fill, another for border. All five sites now point at the slate. **The lesson is that "the hook didn't flag it" is not the same as "it's right":** the hook only reported the undocumented `#78716c` and stayed silent on the chart color being used as a badge border, because its check is per-value, not per-role. When reaching for a neutral, use `badge-gray` if a class fits, or `rgba(138,146,163,…)` if the element needs inline styling.

**Drift concentrates in inline-styled controls, and two app-wide gaps were found behind it (S546).** An `/impeccable audit` of `ClientDrawer.js` scored 10/20, and every finding in the theming and integrity dimensions sat on an element that had opted out of a class — where the file uses `.btn`/`.badge-*`/`.data-table`/`Tip`/`Modal` it follows the system almost perfectly. Two of those were behavioral, not cosmetic, and both are the S424→S521 recurrence again: `color:'#fff'` on a helper line (every light preset has `card:#ffffff`, so it was invisible on five of ten themes) and `color:'#000'` on `var(--theme-accent)` (3.85:1 on Latte, below AA). **Twenty of the file's twenty-six `borderRadius` literals were off the closed 8/12/18/24/999 scale** — the file predates the 2026-07-12 step-up and nobody had opened it since. Two gaps behind those are wider than one file and only one is closed:

- **`@media (pointer: coarse)` existed in exactly one place, `Login.css`** — so DESIGN.md's touch-sizing strategy covered the signed-out pages and nothing else, and the whole authenticated app was desktop-density on a tablet. `Layout.css` now carries the equivalent for `.btn` and `.panel-tab`. An inline-styled control still escapes it, which is the other half of the reason to reach for a class.
- **Label association: swept app-wide as of S569, POS included as of S576.** A `<label>` that is merely a *sibling* of its input names nothing — screen readers announce an unnamed edit box and clicking the label focuses nothing. Every `.form-field` file now wires `id` + `htmlFor` (S546 fixed `ClientDrawer.js`; S569 swept the remaining ~22 files, including Settings/Periods/AdminClients and a real duplicate-id bug in `NutritionEditorModal.jsx` where all six nutrient inputs shared one id; S569 missed POS entirely, which S576 closed — 52 bare labels → 0). Custom controls take ids too: `SearchableSelect`, `BsCalendarPicker` and `QtyInput` all forward an `id` prop to a focusable element. **New form fields need `id` + `htmlFor` from the start** — labels that WRAP their control (checkbox pattern) are already associated and need neither.

  Two shapes are NOT a missing `htmlFor` and must not be fixed as one, because **a `<label>` that references no labelable element is worse than no label** — it announces a name the browser never binds to anything. A caption over a **button group** (toggle chips, tab-bars, radio-style pills) or over a **read-only figure** (POS Orders' "Short by / Change", the parking slip's Date) becomes a `<span>` — `.form-field .field-label` in `Layout.css` gives it the same typography a `<label>` had, so the fix costs no visual change — with `role="group"`/`role="radiogroup"` + `aria-labelledby` on the container and `aria-pressed` on the buttons. Column headings over a repeating row (Delivery Partners) are `<span>`s too, and each row's inputs carry their own `aria-label` naming the column and the row. A `<button>` can never be named by a `<label>` at all.

- **A `<select>` needs an accessible name even when it has no visible caption.** Filter toolbars are the whole product's blind spot here: 86 unnamed `<select>`s across 43 files (S576) — period pickers, category/status/vendor filters, sort orders — each reading to a screen reader as an unlabelled combo box announcing only its current option. Use `aria-label` where there is no visible text, `id`/`htmlFor` where there is, and a **template** `aria-label` for a select inside a `.map()` (`Permission level for ${r.label}`) so the name identifies the row rather than repeating down the list.

Also worth knowing before touching a page's status messages: `.btn:disabled` now carries one shared treatment. Every call site had been writing its own inline `opacity: busy ? 0.6 : 1`, so a button reaching for the class alone had *no* disabled state — it stopped responding while looking unchanged.

**`shared/constants/shiftTypes.js` (`SHIFT_TYPES`/`SHIFT_BY_CODE`) was deleted (S521) as dead code** — it looked at first glance like a second, drifted copy of `Roster.jsx`'s `DEFAULT_SHIFTS` (their "Night" shift disagreed, `#1E293B` vs `#64748B`), but a full-codebase grep for both export names found zero real importers anywhere — every apparent "consumer" found by an earlier, looser grep for the substring `shiftTypes` was actually matching an unrelated local variable (`shiftTypesById` state in `AttendanceSheet.jsx`, a DB-driven query result in `computeLaborAnalyticsSection.js`) that happens to share the name, not an import of this file. `Roster.jsx`'s `DEFAULT_SHIFTS` was always the sole live source; deleted rather than reconciled since there was nothing real to reconcile. **Lesson for grepping this codebase specifically: a bare substring match for an exported constant's name is not proof of an import** — a same-shaped local variable or DB-query-result binding can produce an identical-looking hit list. Verify with the exact export name (`SHIFT_TYPES`/`SHIFT_BY_CODE`, not `shiftTypes`) before concluding two files are both live.

### Class names

Use these global classes from `Layout.css` — don't repeat inline styles:

- `data-table` — styled table
- `table-wrap` — horizontal scroll wrapper (required on all wide tables). **Add `table-wrap--fab-clear` alongside it on any page that also renders a `Fab`** — `Fab` is `position: fixed` with no space reserved for it, so without this modifier the last table row's action buttons sit underneath it (found live, S442, on HR Employees — fixed there and on the other 10 pages with the same pairing). A new page combining a table with `Fab` should include this modifier from the start.
- `tab-btn` / `tab-btn--active` / `tab-bar` — pill filter/sort buttons
- `form-select` — styled `<select>`. **Not for a text input** — it carries `cursor: pointer`, so a field wearing it reads as a menu
- `form-input` — styled standalone `<input>` (S593). An input inside a `.form-field` wrapper is styled by that wrapper's descendant rule and needs no class; an input **outside** one had nothing to reach for until this existed, so it rendered as the browser's native white box — obvious on the dark presets, near-invisible on the light ones. Shares one declaration block with `.form-field input` so the two cannot drift
- `stat-grid` — horizontal KPI card row
- `btn`, `btn-ghost`, `btn-primary`, `btn-danger`, `btn-danger--strong` — button variants. `btn-danger` is a tinted red button, **not** a solid `--theme-red` fill: red has no paired foreground token (it ranges from light `#f87171` to dark `#dc2626` across the ten presets, so no single foreground contrasts on all of them), which is why the destructive variant is a tint plus full-opacity red text
- `badge-green`, `badge-red`, `badge-amber`, `badge-yellow`, `badge-purple`, `badge-gray` — status chips. **That is the complete set — there is no `badge-gold`.** This list named one for a long time and 7 real call sites (HR/IMS/POS Staff rank pills, Advances' loan tag, KOT Log's BOT chip, POS Exception Report's discount row) used it, so all seven rendered as bare unstyled `<span>`s — no tint, no padding, no radius, no 11px size, just inherited text — with nothing to signal the class was missing. Fixed 2026-08-12 by repointing all seven to `badge-yellow`, which is what they meant: every one is a *categorical* distinction, and `badge-yellow` is the accent-tinted categorical-tag badge (see DESIGN.md), not a warning. `badge-amber` is the real warning color; don't reach for `badge-yellow` for a caution state. A class name that doesn't exist fails silently in CSS, so verify a badge class against `Layout.css` before using it rather than copying a nearby line.
- `no-print` / `print-only` — print visibility. `print-blank-input` (S582) blanks an input's value AND placeholder in print while its border still prints — a fill-in-by-hand box for sheets meant to be priced with a pen (Chrome prints placeholder text as if it were a value, which is why hiding the value alone is not enough)

### A disabled field had no treatment at all, and inline styles were why (S603)

`.form-field input` sets its own `background`, `border` and `color`, which override the UA's
disabled styling — so with no `:disabled` rule of its own, **a disabled field rendered identical to
an editable one**. Sales and Overheads disable their whole grid on a closed period; those two pages
are exactly where a locked month must be obvious, and nothing said so. The boxes just stopped
responding.

The rule (`Layout.css`) flattens the well to `transparent` and steps the border to
`--theme-border-lt`, leaving the value's colour alone. **Not `.btn:disabled`'s `opacity: 0.55`** — a
button's label is a verb you may not press, a field's content is data, and a locked period's figures
must stay legible precisely because they can no longer be corrected (opacity multiplies through the
text colour and takes it below AA, which DESIGN.md already forbids for rows). Read-only shares the
treatment but keeps a text caret: it is not refusal, and the value is meant to be selected.

Two UA behaviours must be overridden explicitly or none of it takes effect: WebKit paints a disabled
control's text with **`-webkit-text-fill-color`**, which plain `color` does not override, and iOS
Safari layers **its own opacity** on top.

**An inline-styled control escapes the rule** — as it escapes the `[aria-invalid]` hook and the
`@media (pointer: coarse)` sizing — and the period-lock inputs are all inline. `disabledStyle(base,
isDisabled)` and `invalidStyle(base, message)` in `src/shared/inlineFieldState.js` compose the same
treatments into an inline object so each state has one definition; applied on `Sales.js` (3),
`Overheads.js` (4) and `LeaveManagement.jsx` (1). Reaching for a class is still the real fix.

### The 16px touch floor had never left the login page (S603)

DESIGN.md described "under `@media (pointer: coarse)` inputs go to 16px" as the product's strategy
for a year. It existed as **`.login-field input` in `Login.css` and nowhere else** — so every field
in IMS, HR and POS stayed 13px on a tablet, and 16px is the threshold below which iOS Safari zooms
the viewport on focus and never zooms back. On a product whose till and stock count *are* tablet
surfaces, tapping any field turned "enter the quantity" into "now pan sideways to find Save".

`Layout.css`'s coarse block now carries an **element-level** rule — `input` (checkbox, radio, range,
color, file and the button-shaped types excluded), `select`, `textarea` — at `font-size: 16px
!important`, plus `min-height: 44px` on `button:not([class])`.

**`!important` is load-bearing here**, same justification as the reduced-motion block above it: 370
form controls across ~46 files set their font-size in an inline `style` object, and no selector
beats an inline style. Without it the floor reaches the controls that least need it and skips every
one that does. The button rule is `:not([class])` rather than bare `button` because every classed
button already has a tuned value (`.btn` 44, `.btn-sm`/`.tab-btn` 32, `.sidebar-link` 40) and a bare
selector would silently re-decide the ones that merely have no rule yet — `min-height` only, since
`min-width` on a narrow icon button squeezes its neighbours.

**This does not retire "reach for a class."** A class also brings the `[aria-invalid]` hook, the
`:disabled` treatment and the closed shape scale, none of which an `!important` floor supplies. The
floor exists so the zoom trap does not wait on a 370-site sweep.

### `.form-select` on a text input, at scale — and why the swap is not a rename (S603)

62 text controls across 22 files (`<input>`, `QtyInput`, one `<textarea>`) carried
`className="form-select"`, which sets `cursor: pointer` — a text field announcing itself as a menu.
That is S593's rule, and it had been copied 62 times because `.form-select` was the class that
existed when those files were written. All now on `.form-input`.

**`.form-input` sets `width: 100%` and `.form-select` does not**, so a blind substitution would have
stretched every toolbar search box and filter field that never pinned its own width — and in a flex
row a `flex-basis` of 100% wraps its neighbours. `.form-input--auto` (`width: auto`) is the
difference; 14 of the 62 take it. Classification was mechanical: not inside a `.form-field`, no
`width:` in its inline style, no `flex:`. Width is layout, not control identity — reach for the
modifier, never an inline `width: auto`.

`EmployeeForm.jsx`'s `inp` constant went at the same time: a hand-rolled copy of `.form-input` on 33
controls, carrying a `borderRadius: 6` off the closed 8/12/18/24 scale. Its `<select>`s needed
`.form-select` **plus** an explicit `width: '100%'`, since that is the one declaration `inp` was
supplying that the class does not.

### `position: sticky` is dead in the body flow, app-wide (S604)

`src/index.css` opens with `html, body { overflow-x: hidden }` — an app-wide horizontal-overflow
guard. Because `html`'s overflow is then not `visible` it stops propagating to the viewport, `body`
becomes its own scroll container sized exactly to its content, and **a `position: sticky` child of
the body has a scrollport that never scrolls**. It renders, it computes to `sticky`, and it moves
1:1 with the content forever.

Every screen in IMS/HR/POS is immune because the app shell scrolls its own div. The pages that are
not are the three that render directly into the body: the guest menu, `/login` and `/pricing`. All
three had a sticky bar that had never stuck in production — measured on the built pages at 390×780,
the nav's viewport `top` went `0 → −250 → −600`.

**The one-line fix does not work, and this was measured rather than reasoned.** Dropping the rule to
`html { overflow-x: hidden }` alone does restore sticky, but the guard stops working entirely — a
probe page with a deliberately 2000px-wide child reported **1610px** of horizontal overflow, byte
for byte what it reports with no rule at all. So the fix is per-page: give the page root its own
scrollport (`height: 100dvh; overflow-y: auto; overscroll-behavior: contain`) and **remove any
`min-height: 100vh` it was carrying** — 100vh ≥ 100dvh, so a min-height pushes the root taller than
its own scrollport and hands the scroll straight back to the body, which is the original bug.

`dvh`, not `vh`: on a phone `100vh` is the tallest the viewport ever gets, so the fold — where a
cart button or a primary CTA lives — sits under the URL bar.

Two things to re-verify after making a page its own scrollport, because they silently change
meaning: an `IntersectionObserver` with `root: null` measures against the *viewport*, which only
agrees with the container while the container is exactly viewport-height — pass the container
explicitly; and `element.scrollHeight` vs `window.innerHeight` stops being the fit test, since the
body no longer scrolls.

**Verify by measurement, never by eye.** This is correct-looking in code and in review; only reading
`getBoundingClientRect().top` across real scroll positions catches it. A harness that reproduces the
two structural facts (the index.css rule + a sticky child) is enough — it does not need the app.

### A nav icon is unique per route, because the command palette flattens the modules (S606)

`CommandPalette.js:134` renders each nav item's `icon` and lists **every module's items in one
searchable list**. The sidebar shows one module panel at a time, so an icon shared by two routes in
different modules looks fine there and sits directly beside its twin in the palette. Sixteen such
collisions had accumulated — `Users` was Customers *and* Employees, `Banknote` was Purchase 1L+
Report *and* Payroll, `CalendarClock` was FIFO/Expiry *and* Staff Roster, `Building2` was three
things.

Audit by keying on `to:`, never on label — an item listed in two panels (Settings, Periods, Guest
Menu) shares one route and is **not** a collision. Resolve by keeping the icon on whichever route it
fits most literally and moving the other.

**Not every repetition is a collision.** `LayoutDashboard` (Dashboard / HR Dashboard) and `Users2`
(IMS / POS / HR Staff) are deliberately shared: they are one concept expressed once per module, and
the labels disambiguate. Splitting those makes the palette harder to scan.

Two related traps. **`AlertTriangle` is a deprecated alias of `TriangleAlert`** — in lucide-react
1.24.0 `alert-triangle.mjs` is literally `export { default } from './triangle-alert.mjs'`, so both
names render one SVG and a codebase using both looks inconsistent for no reason. And a **mirror-image
pair** (`ArrowLeftRight` / `ArrowRightLeft`) used for one concept is worse than an exact duplicate:
the reader cannot tell whether the difference is meaningful.

Before adding a nav entry, check its icon is not already on another route, and verify the export
exists (`grep "declare const <Name>:" node_modules/lucide-react/dist/lucide-react.d.ts`) — a
misspelled icon name is a build failure, and a *wrong-but-real* one is silent.

### Two decisions settled in S613, so they stop being re-litigated

**The phone IS a supported reporting surface.** `.stat-grid` is
`repeat(auto-fit, minmax(180px, 1fr))` and reflows on its own; **25 report pages had overridden it
with an inline `gridTemplateColumns: 'repeat(N, 1fr)'`** (N up to 6), and an inline style beats
every media query — so an owner checking food cost on a phone between services got six crushed
columns on exactly the pages that matter most. All 20 stat-grid overrides were deleted and the four
hand-rolled KPI grids (Overheads ×2, TheoreticalVariance, MenuEngineering) moved to `auto-fit`
`minmax`. Desktop renders identically; the phone stops shredding.

**Never pin a KPI strip's column count.** If a row genuinely needs a different density, change the
`minmax` floor (the wider the tile's content, the higher the floor) — never the track count. The
same reasoning already produced `.dash-3col-*` and `.dash-spend-purchases-row`: a fixed-count grid
belongs in a CSS class with a breakpoint, never in an inline style.

**POS REPORT pages use the product shell; POS TILL screens do not.** `SalesReport`, `CoversReport`,
`KotLog` and `PosExceptionReport` are reports that happen to read POS data — they now carry
`page-header`/`page-title`/`page-subtitle`, `stat-grid`/`stat-card` tiles, `tab-bar` tabs and
keyboard-reachable drill-downs like every other report in the product. `PosOrders` and
`KitchenDisplay` keep their full-screen till idiom: they are `position: fixed` layers built for a
thumb mid-service, which is a real difference in kind (it is also why those nine overlays needed
`Modal`'s `zIndex` prop in S578). **A new POS page is a report unless it is operated during
service** — and if it is a report, it gets the shell, not a hand-rolled header.

### A table column collapses where you didn't choose it to (S614)

`table-layout` is `auto` everywhere, so a column's width is **bid for against its neighbours** and a
neighbour carrying `white-space: nowrap` always wins. Three consequences, all reported from
screenshots of the same Purchases bill list rather than found by any detector:

**A cell holding two things is the one that collapses.** The Item cell holds the item name *and* its
category badge, the Vendor cell beside it is `nowrap` — so a two-word name broke over two lines with
the badge dropping onto a third, and the row stood three lines tall to show one line of figures.

**The fix is `nowrap` on the cell, never a fixed width.** `.table-wrap`'s horizontal scroll exists
to carry exactly this; a width pins the column and moves the wrap somewhere else on the next screen
size. Same failure with no second element at all: a Day cell holding `2026-08-17` collapsed to its
widest *unbreakable fragment*, `2026-`, and broke the date at every hyphen — a date, a code, an
invoice ref and a phone number all need `nowrap` for this reason, not just crowded cells.

**Row density is a table-level decision.** The global `td` padding is 11px; a table read as a dense
ledger opts down through its own scoped class (`table.purchases-table`, 7px), never per cell — a
per-cell inline padding leaves one row taller than its neighbours the first time someone adds a
column, and inline beats the class silently.

**Day columns say the month.** `formatBsDay(day, bsMonth)` → "1st Bhadra", not a bare `1` that only
reads correctly while the page header is on screen. Full rule in `DESIGN.md` and `CLAUDE.md`'s BS
calendar section; Excel exports keep the numeric column.
