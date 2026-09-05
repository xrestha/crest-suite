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

**Exception:** Recharts SVG props (`fill`, `stroke`, `tick`) must stay as literal hex — CSS `var()` does not resolve inside SVG presentation attributes. The exemption is for SVG only: a Recharts tooltip is a plain HTML `<div>`, so it takes `var()` tokens directly — no `useTheme()`-resolved hex needed — and its card chrome is `TOOLTIP_CHROME` from `src/shared/tooltipChrome.js` (S624, the `chartMotion.js` precedent). Several older chart files still carry inline copies, named in that file's comment; migrate them as touched, never add a new copy.

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
- `page-header` — the block every page opens with (28px bottom margin, and under 768px the 60px left padding that clears the fixed hamburger). **Add `page-header--split` whenever the header has actions on the right** — it owns the flex row, `space-between`, `flex-wrap` and the gap, so no page hand-rolls them. A title-only header takes `page-header` alone; the base is deliberately not `display: flex`, or the 29 title-only headers would put their `<h1>` and `<p>` side by side
- `stat-grid` — horizontal KPI card row. **Its `minmax()` floor is 200px because of what a card HOLDS** — `.stat-value` is 24px/700 and a Nepali-grouped rupee figure needs ~200px. It was 180px, and the headline number wrapped at 1280px, 900px, 414px and 430px. If a new card needs a longer figure, raise the floor; do not let the value wrap
- `stat-card` / `stat-label` / `stat-value` / `stat-sub` — the tile inside that grid. **Build it from `<div>`s.** There is no global `p { margin: 0 }` here, so a `<p class="stat-value">` takes a UA `1em` (=24px) top and bottom margin: measured on the Group Console — the only place in the product doing it, 8 sites against 323 — the card stood 153.6px instead of 102.6px and the label sat 24px from its figure instead of 8, because `.stat-label`'s own bottom margin collapsed away under the value's inherited top one. Nothing looks wrong in the source. `.stat-value` also carries `line-height: 1.15` since S657; before that it inherited body's 1.5, so a 24px numeral sat in a 36px line box and the class's 8px/4px intervals rendered as 14px/10px at every site
- **A hand-rolled copy of one of these keeps only the rules the class had on the copy date.** The three dashboards' inline `kpiCard()` is legitimate — it is a denser padding tier `.stat-card` does not offer — but it could not receive `tabular-nums` (S594) or `line-height` (S657), and the *grid* around it had been hand-rolled for no reason at all, landing on a fourth `minmax()` floor (160px) and a group break equal to its own peer gap. Separate the decisions: take the class for everything it still describes, hand-roll only the property that genuinely differs. **The tell that a copy has gone stale is a value on it that exists nowhere else in the product**
- `row-menu` / `row-menu-item` / `row-menu-item--danger` / `row-menu-sep` / `row-menu-hint` — the overflow menu `RowMenu` renders (S681). Not for hand-rolling: reach for the component, which owns the keyboard and focus behaviour these classes only dress. The hover/focus fill is `--theme-focus-ring`, the product's existing "this one" tint, not a new grey
- `btn-sm` — the small step (12px on 5/10, `gap: 4`). **Real since S680**; before that the class had only a coarse-pointer `min-height` and was byte-identical to `btn` on a mouse device, across 24 sites in 8 files that all believed they were rendering something smaller. `.btn[aria-busy="true"]` is the in-flight treatment for the one button just pressed — see DESIGN.md → Buttons for why it exists instead of `disabled`
- `btn`, `btn-ghost`, `btn-primary`, `btn-danger`, `btn-danger--strong` — button variants. `btn-danger` is a tinted red button, **not** a solid `--theme-red` fill: red has no paired foreground token (it ranges from light `#f87171` to dark `#dc2626` across the ten presets, so no single foreground contrasts on all of them), which is why the destructive variant is a tint plus full-opacity red text
- `badge-green`, `badge-red`, `badge-amber`, `badge-yellow`, `badge-purple`, `badge-gray` — status chips. **That is the complete set — there is no `badge-gold`.** This list named one for a long time and 7 real call sites (HR/IMS/POS Staff rank pills, Advances' loan tag, KOT Log's BOT chip, POS Exception Report's discount row) used it, so all seven rendered as bare unstyled `<span>`s — no tint, no padding, no radius, no 11px size, just inherited text — with nothing to signal the class was missing. Fixed 2026-08-12 by repointing all seven to `badge-yellow`, which is what they meant: every one is a *categorical* distinction, and `badge-yellow` is the accent-tinted categorical-tag badge (see DESIGN.md), not a warning. `badge-amber` is the real warning color; don't reach for `badge-yellow` for a caution state. A class name that doesn't exist fails silently in CSS, so verify a badge class against `Layout.css` before using it rather than copying a nearby line.
- `action-error` / `action-error-text` / `action-error-detail` — the message for an action that failed, rendered by `ActionError` (S658). Sits between `.field-error` (one control) and `.report-error` (a whole report that could not be read). Deliberately not a card: it appears under a form the user is still looking at, where a filled panel reads as a second section rather than as a consequence of the click. `.action-error--top` puts it above the content instead of below. The detail line is the one place monospace is earned — it quotes a Postgres `code · message` — and is toned to be findable, not readable (`--theme-text3`, 5.45:1 on the dark card). **Do not hand-roll the old shape** (`{error && <p style={{ color: 'var(--theme-red-text)', fontSize: 13 }}>{error}</p>}`): it appeared at ~20 sites in IMS alone, and at most of them what it was handed was `error.message` straight from Postgres
- `no-print` / `print-only` — print visibility. `print-blank-input` (S582) blanks an input's value AND placeholder in print while its border still prints — a fill-in-by-hand box for sheets meant to be priced with a pen (Chrome prints placeholder text as if it were a value, which is why hiding the value alone is not enough)

### Half a class is worse than no class, because it looks adopted (S655)

`.page-header` carried a bottom margin and the mobile hamburger clearance — but **not the row**,
so all 78 sites in the product hand-rolled the row, and the hand-rolls split into two shapes each
holding exactly the half the other was missing. Pages that wrote the inline flex object on the
class got the clearance and no wrap; pages that hand-rolled the whole `<div>` got the wrap and no
clearance. Measured on the built CSS: an unclassed header put **40×33px of the hamburger over the
`<h1>`** (`elementFromPoint` at the title's first character returned the button, not the text),
while a no-wrap header squeezed that title from 298px to **154px**, and one carrying a period
`<select>` overflowed its own container by **29.7px** — clipped rather than scrollable, because of
`html { overflow-x: hidden }`. Neither is visible above 768px, which is why both survived every
desktop review; S652 fixed POS by hand without the shape being named.

**The tell is an identical inline style object appearing on the class itself at more than a couple
of sites.** `.panel-tab-bar` (S551) and `.stat-grid--compact` (S569) were both found exactly this
way. When you see it, move the properties into the class rather than fixing the call sites.

**And a wrapping row whose children are themselves rows is only half-wrapped.** Verifying the
sweep at 360px found a three-control header still overflowing by 15.7px: the class wraps the title
block against the action group, but each page hand-rolls the action group as its own
`display: flex`. `.page-header--split > *` sets `flex-wrap: wrap` (inert on the title block, which
is not a flex container) **and** `min-width: 0`, which undoes the `min-width: auto` a flex item
defaults to and is what actually held the group wider than its share. Neither alone is enough.

**Related, from the same pass: a sub-route has no nav item and inherits no page chrome.**
`PurchaseOrders`' Receive and PO-form views re-padded their own root (`padding: 32px 24px` on top
of the shell's own) and led with a **Back button** rather than a title — so a real control, not
just text, sat under the hamburger. Both now fold the button and the title into one
`.page-header`. Full measurements and the rationale live in DESIGN.md's Layout section.

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

### A signal colour is a verdict, so it inverts where "down" is the good direction (S634)

Green and red are never neutral in a product an owner reads between services — there is no reading
of a red ▼ that isn't "something went wrong here". So a figure compared against a target has to
decide **which direction is good for that metric**, not just which side of the line it landed on.

The Daily Purchases vs Sales tooltip coloured both actual rows ▲ green / ▼ red literally, on the
reasoning that a glyph "states where the line sits, not a verdict". That is right for a *shape* and
wrong for a *colour*: reported live, `Purchases : NPR 2,295` against a NPR 3,112 target wore a red ▼
for running under the spending pace you had locked in — the outcome you wanted.

**Shape is the fact, colour is the verdict.** Keep ▲/▼ literal, because it has to agree with the
line the reader can see; let the colour ask whether that direction is good for this metric. A
`GOOD_DIRECTION` map keyed by series (`sales: +1`, `purchases: -1`) is the whole mechanism. Applies
anywhere a cost sits beside a revenue: variance, budget-vs-actual, food-cost trend, wastage.

**A verdict needs a dead zone, or it cries wolf (S644).** Without one, every value earns a colour —
NPR 3,115 against a NPR 3,112 target painted red — and a chart where all thirty days are lit green
or red has stopped saying anything. Inside the band the DIRECTION is noise too, so the glyph goes
neutral as well (`≈`, in `--theme-text3`) rather than showing a ▲/▼ nobody should read into; the
percentage still prints, because showing what you are calling on-target is more honest than hiding
it. Use **two thresholds, whichever is more forgiving** — a percentage and an absolute floor —
because one is wrong at each end of the range: 2% of a NPR 3,000 day is fairly ignored, while on a
quiet day with a NPR 200 target even a 10% swing is NPR 20 and means nothing. Same shape as the
delivery-partner commission check in POS, which needed both before it stopped raising false alarms
on per-bill rounding.

**Two consequences worth pricing in.** Colour becomes the sole carrier of the verdict once shape
stops being redundant with it (a green ▼ and a red ▼ now both exist), so give the reader the
magnitude in text — the gap as a **percentage of target** rather than a second currency figure, so
it reads the same on a quiet Sunday as on a delivery day. And say the polarity out loud wherever the
legend explains the line, because the two series on one chart are now coloured by opposite
conventions and nothing on screen would otherwise admit it.

### A nav item's visibility condition belongs on the ITEM, not at each render site (S638/S639)

The sidebar is not the only thing that reads the nav: the **command palette** flattens every
destination into one searchable list, and `isItemVisible()` is the predicate both go through. A
condition written *around* a render site is therefore applied to one consumer and not the other.

This has now produced the same bug three times. S617 found the palette offering `/group-dashboard`
on group membership alone while the sidebar required `isAdmin || isOwner` — and **fixed only that
one row**: Owner Dashboard and Owner Report kept the mismatch until S638, so any staff account could
search its way onto them. (`/pnl` was in neither list, so the Owner could not search for it at all.)

The fix is structural, not vigilance: put the flag on the item (`ownerOnly: true` alongside the
existing `featureKey`/`minPlan`/`minPosRole`/`minImsRole`/`minHrRole`), teach `isItemVisible()`
about it once, and have every consumer build from the same array. `SUITE_NAV` is the worked example
— the palette maps it through a `longLabel` swap (it is searched by typing a full name; the sidebar
has 240px) and re-states **no** visibility condition of its own.

Corollary: a group whose members have *different* gates must gate per item, never on the group.
Gating the Crest Suite group owner-only would have revoked Demand Forecast and Fixed Assets from
every IMS supervisor who has them; `renderGroup` already returns `null` when nothing inside is
reachable, so per-item gating degrades correctly on its own.

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

**Lowering the floor is only half the change (S642).** Narrowing a column without narrowing its
contents just moves the wrapping somewhere else. The Admin Dashboard had six tiles against a 190px
floor, which fits five — so one tile sat alone on a second row and the table below started a full
row lower. Getting six across meant the floor (190→158, gap 14→10) *and* everything inside coming
down with it: card padding, the headline numbers, and the adoption pills, which had been sized for
the old inner width and would have re-wrapped at the new one. Budget the inner width first — column
floor minus the card's horizontal padding — and check the widest real string against it.

**Every tile in a strip shares the row's height, so one long value makes all of them taller.** A
list of client names inside a KPI tile takes `nowrap` + `ellipsis` + a `title`, never wrapping: a
single long property name would otherwise undo the row you just reclaimed.

**10px is the floor for real text.** `--font-size-micro` is 10px and `--font-size-chevron`'s 9px is
for a glyph, not a label — so when a pill will not fit at 10px, take the space from padding,
gap and borders (a tinted fill carries the colour identity without one), or shorten the label. Do
not invent a 9px text step.

**POS REPORT pages use the product shell; POS TILL screens do not.** `SalesReport`, `CoversReport`,
`KotLog` and `PosExceptionReport` are reports that happen to read POS data — they now carry
`page-header`/`page-title`/`page-subtitle`, `stat-grid`/`stat-card` tiles, `tab-bar` tabs and
keyboard-reachable drill-downs like every other report in the product. `PosOrders` and
`KitchenDisplay` keep their full-screen till idiom: they are `position: fixed` layers built for a
thumb mid-service, which is a real difference in kind (it is also why those nine overlays needed
`Modal`'s `zIndex` prop in S578). **A new POS page is a report unless it is operated during
service** — and if it is a report, it gets the shell, not a hand-rolled header.

### The page root takes no padding, and the header is `.page-header` (S652)

`.main-content` already pads every page (32px, forced to `16px !important` under 768px), and the
mobile rule that clears the fixed 44px hamburger is written against that — `.page-header` earns
`padding-left: 60px` at the breakpoint. **A page that re-pads its own root steps out from under
that arithmetic.** Eleven of thirteen POS pages opened
`<div style={{ padding: '24px 28px', maxWidth: … }}>`; the eight that also hand-rolled
`<h2 style={{ fontSize: 20 }}>` inherited no clearance at all and had **12×16px of the hamburger
sitting on the page title** at 390px, while the four that used `.page-header` got the 60px on top
of their own 28px and indented the title 60px past their own table. Invisible above 768px, where
the hamburger is `display: none`. Full rule and measurements in DESIGN.md → Layout. A `maxWidth` on
a page root is a claim about a reading measure, which a working surface does not have. S656 closed
the last five (IMS); the reliable grep for stragglers is the CLUSTER, not the class —
`padding: '24px 28px'` on a return-statement root travels with the cap and the hand-rolled `<h2>`.

### A card grid cannot always take the container role (S653)

Order Taking's floor grid puts `role="button" + tabIndex + onKeyDown` on the card, which is right —
its cards hold no interactive children. Table Management's grid *looks identical*, had a bare
`<div onClick>`, and was entirely mouse-only. It could not be fixed by copying the sibling: those
cards hold three controls (name, status badge, QR), and interactive content inside a `button` role
is invalid and unfocusable. **The tell is whether the card holds controls**; if it does, the
affordance goes on the children — the same "a real control inside, never a role on the container"
move as the `<tr>` rule. A badge that is a control becomes a `<button>` wearing the badge class,
which needs `border: none` and `fontFamily: 'inherit'` because the badge styles assume a `<span>`.

### A table column collapses where you didn't choose it to (S614)

`table-layout` is `auto` everywhere, so a column's width is **bid for against its neighbours** and a
neighbour carrying `white-space: nowrap` always wins. Three consequences, all reported from
screenshots of the same Purchases bill list rather than found by any detector:

**A cell holding two things is the one that collapses.** The Item cell holds the item name *and* its
category badge, the Vendor cell beside it is `nowrap` — so a two-word name broke over two lines with
the badge dropping onto a third, and the row stood three lines tall to show one line of figures.

**The fix is `nowrap` on the ATOM, never a fixed width — and never the whole cell** (corrected
S646; the original rule said the cell, and see the section below for what that cost). A width pins
the column and moves the wrap somewhere else on the next screen size. Same failure with no second
element at all: a Day cell holding `2026-08-17` collapsed to its widest *unbreakable fragment*,
`2026-`, and broke the date at every hyphen — a date, a code, an invoice ref and a phone number all
need `nowrap` for this reason, not just crowded cells. But a cell holding a name *and* a badge needs
it on the name only: nowrap the cell and the badge becomes unbreakable too, for no reason.

**Row density is a table-level decision.** The global `td` padding is 11px; a table read as a dense
ledger opts down through its own scoped class (`table.purchases-table`, 7px), never per cell — a
per-cell inline padding leaves one row taller than its neighbours the first time someone adds a
column, and inline beats the class silently.

**Day columns say the month.** `formatBsDay(day, bsMonth)` → "1st Bhadra", not a bare `1` that only
reads correctly while the page header is on screen. Full rule in `DESIGN.md` and
`.claude/rules/bs-calendar.md`; Excel exports keep the numeric column.

### A table where every column is `nowrap` can only overflow (S646)

The section above is the fix that caused this one. Each nowrap was individually right — a date must
not break at its hyphens, an item name must not break mid-name — but they accumulate, and
`data-table th` is `white-space: nowrap` **globally**, so every header is load-bearing width too.
By S646 the Purchases bill list had nine columns and not one of them could give width back: its
min-content was **1134px against 1086px of room at a 1440px window**. It needed a 1382px window
before it fit at all, and it had been overflowing on every ordinary desktop since.

**A table needs at least one column that can absorb the squeeze**, and that column should be chosen
rather than discovered — the widest text column, with the nowrap pushed down onto the one fragment
that genuinely cannot break. The item cell went from `nowrap` to `normal` with the *name* wrapped in
a nowrap span: the name still never breaks, and the badge beside it drops to a second line only when
there is no room. Min-content fell 1134 → 912.

**Which column absorbs it is a decision, and text is the only honest candidate (S649).** S646 chose
the Item column because its category badge could drop to a second line — but the reported screen still
sliced the Del button, because with the badge gone the *names* were the wall: a real
"BHAT BHATENI CHICKEN SAUSAGE" is 239px of unbreakable text and "Bhat Bhateni Super Market" 186px,
both `nowrap`. Sample data chosen from a screenshot measured 1030px min-content where invented data
had measured 912. **Measure with the longest values the client actually has, not with a plausible
row.** The answer was to let both NAMES wrap and keep everything else nowrap: a day, a figure, a
unit, an invoice ref, an expiry and a button are all things a line break either corrupts or cuts,
and a name is not. A word stays atomic, so a name never breaks mid-word. No horizontal scroll from
1152px up, Actions holds its full width at every size, and nothing wraps at all at 1440+.

**A long header is a column width, and it can be two lines.** `Bill Total (incl. VAT)` cost 150px to
label figures needing 75px. A `display: block` child inside the `th` breaks the line regardless of
the inherited nowrap, so nothing has to be deleted to halve the column. Same for a second line of
supporting detail in a body cell — `#3066 · 5 items` under a vendor name rather than trailing it took
that column 223px → 122px, and reads better besides.

**Measure it, don't eyeball it.** Every number above came from the real `Layout.css` and a
representative row rendered in a headless browser and queried for `scrollWidth` vs `clientWidth` per
viewport. A table that fits on the machine it was built on tells you nothing about the one it was
reported from.

**But a harness lies quietly, and S671 got two different wrong answers before a right one.** Both
failures produced *plausible* numbers, which is the whole danger — neither looked wrong, and the
only tell was two passes disagreeing with each other:

- **The harness double-debited the sidebar.** It placed a 240px `<div>` beside `.main-content` — but
  Layout.css's own `.main-content` already reserves the sidebar with `margin-left`, so every reading
  came in 240px pessimistic (854px of room reported at a 1440px viewport, against a true 1094px).
- **Then it resized a wrapper instead of the viewport.** Setting `.shell { width: 1440px }` inside a
  671px browser window reports `overflow: 0` for a table that overflows badly in the real one — the
  scroll container is sized by the window, not by the div you widened.

So: **resize the viewport** (`page.setViewportSize`), never an element, and reload between passes so
no inline style from the previous one survives. Before trusting a single figure, **check the
harness's own reported room against the arithmetic** — viewport, minus the shell's reservations,
minus the card's padding. If it does not come out, the harness is wrong and every number in it is.

**A table's identity column needs a `min-width`, because under `table-layout: auto` it is the one
that pays.** Everything to its right is typically nowrap — a phone, a code, a badge, a row of
controls, none of which can give width back — so the wrappable name column absorbs the entire
squeeze and keeps doing so past the point of usefulness: Vendors' collapsed to **111px** at a 1024px
window and broke real supplier names over five lines, standing rows **145px** tall. A 180px floor
took those rows to 86px for 59px more horizontal scroll. **That trade is only worth making when the
column is also sticky** — otherwise you have bought taller-legible names at the cost of scrolling
the name off screen, which is the same defect wearing the other hat.

**A scroll container's clearance must be MARGIN, not padding.** `.table-wrap--fab-clear` (21 tables)
reserved its 88px of Fab clearance with `padding-bottom` — inside the scroll container, so the
horizontal scrollbar rendered 88px below the last row: below the fold on any table long enough to
scroll the page, and with Windows' overlay scrollbars, not on screen at all. So the overflow above
never presented as *scrollable*; it presented as an Edit button sliced down the middle, which is how
it got reported. Margin gives byte-identical clearance (a margin on the last child of a padded
`.card` cannot collapse out of it) and puts the scrollbar directly under the table. **Generally: any
padding on an `overflow: auto` element pushes its scrollbar away from the content it scrolls.**


## `.btn` with no colour variant renders as browser chrome (S678)

`.btn` is the BOX — padding, radius, 13px/500, cursor, transition, focus ring, `:disabled`. It
declares **no `background` and no `color`**. `.btn-primary` / `-ghost` / `-danger` / `-danger--strong`
supply those, and one of them is mandatory.

Without one the element inherits, and what it inherits depends on the tag, which is why this is
hard to see in review:

- on a **`<button>`**, the UA's own chrome — `background: #f0f0f0`, `color: #000`. On a dark card
  it is the only light-filled thing on the page and reads as a rendering fault.
- on an **`<a>`**, the UA link styling — `#0000EE`, underlined. Measured on the public Terms page's
  current-document link: **1.81:1** against the Dark nav card, against AA's 4.5:1. It was also the
  *only* underlined, blue thing in the header, so the page the reader was already on looked like
  the one control worth pressing while the page they could travel to looked like a resting button.
  A second brand colour, arrived at by omission rather than by choice.

**This is the `badge-green`-written-alone failure on the class it was never applied to.** The
badges were made self-sufficient in S576 precisely because CSS raises no error for a class that
does half a job; `.btn` kept the hazard. `btn btn-sm` is the shape that hides it best — `btn-sm`
is a real class, so the pair reads complete and only the colour is missing.

Grep for `className="btn"` and `'btn btn-sm'` with no variant beside them. Three sites had it in
the legal surface alone, two of them on a public page.

**The same failure one level up: a class styled only under one ancestor is half a job everywhere
else (S679).** `.legal-link` and `.legal-p` were written as `.legal-body .legal-link` and
`.legal-body .legal-p`, and the not-found page's two links and the Loading line sit OUTSIDE
`.legal-body` — so they fell through to the UA: `#0000EE` at 16px, roughly **2.0:1** on Dark, blue
beside visited-purple on Light, on the branch a stale external link lands on. The class name on the
element reads as adopted; only the selector knows it is conditional. When a class carries an
identity (a link, a paragraph, a badge), style it bare and scope only the genuinely contextual
overrides (a hover thickness, a print colour). Before trusting a stylesheet, grep its
`.parent .child` pairs for a `.child` that is also used outside `.parent`.

## A badge whose content is a sentence takes `.badge-sentence` (S678)

The badge box carries `text-transform: capitalize`. Right for `paid`; wrong for prose. The admin
Legal tab borrowed `.badge-amber` for a two-sentence readiness warning and shipped **"Not Ready To
Publish — Still Missing SITE_ORIGIN. Do Not Send An Agreement To A Client Until These Are Filled
In And The Pages Are Republished."** at 11px, and Help → Legal's draft chip read "Draft — Not Yet
In Force".

`.badge-sentence` turns the transform off and touches nothing else. Reach for it only when the
badge genuinely is the right container: a chip needing two sentences is usually a banner wearing a
chip's class, and the modifier makes that easier to ignore than to fix.

## A page that invents its own class names opts out of the touch tier (S678)

`Layout.css`'s `@media (pointer: coarse)` block can only reach selectors it knows about — `.btn`,
`.tab-btn`, `.sidebar-link`, the bare-element floor. **A stylesheet that names its own controls
gets none of it, silently.** `Legal.css` had no coarse block at all, so on the public Terms page
measured at 390px: contents-rail links **28.2px tall with a 0px gap** between eighteen of them,
the verify disclosure 28px, footer links 18px — on the one surface in the product that is pure
reading and pure thumb.

The tell is a CSS file with its own component prefix and no `pointer: coarse` block in it. Scope
the tier to the input method, never to a width: a narrow desktop window keeps its density.

## A clock time is rendered by `nepalTime()`, never by `toLocaleTimeString` (S670)

`src/shared/nepalTime.js` is the one place a `timestamptz` becomes a time a person reads. Reach for
it — `nepalTime` on screen, `nepalTime24` in a spreadsheet cell (`"06:50 PM"` sorts before
`"11:30 AM"` as text, so a 12-hour column mis-orders any workbook a reader sorts by time),
`nepalDateAd` on a printed slip.

**The rule exists because the obvious form is wrong in a way nothing surfaces.** All 18 clock renders
in the product were the byte-identical inline
`toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })`, and every one rendered in the
**runtime's** timezone. On a till in Kathmandu that is right by accident; for the operator viewing a
client's data from anywhere else every time on every screen was 5h45m out, with nothing on the page
to say so. The repo already knew the failure mode — `bsDayBoundaryIso()` pins `+05:45` and explains
why — but that is date-boundary CONSTRUCTION. Nothing had pinned DISPLAY.

**Pinning a time forces pinning the date beside it.** `adToBs()` reads a Date's LOCAL getters, so a
bill closed 00:15 Kathmandu renders under the *previous* BS day for a viewer abroad: pin one and not
the other and the cell shows the date from one day and the time from the next, which is strictly
worse than being consistently wrong. Any `adToBs(new Date(<timestamptz>))` in a cell that shows a
time must be `nepalBs(...)`; bucket with `nepalHour`/`nepalCivilDate`, never `.getHours()`.

**Two times in one cell must each carry a date when they fall on different days.** An order opened
one evening and closed the next afternoon renders as `06:59 PM → 01:23 PM` under a single date,
which reads as a broken clock rather than an overnight bill. Both sides get dated when they differ,
neither when they do not — the row's own date already says it. Same rule the Purchases entry stamp
follows. Where two timestamps come from *different clocks* (POS `opened_at` is the server's default,
`closed_at` is the till's), show both exactly as recorded and flag an inversion past a minute's
tolerance; never clamp and never swap.

## A saved theme pins the user to the preset as it was, so a corrected token never ships (S620)

`switchPreset` persists the **full** colours object to `localStorage`, and `loadSaved` merged
`saved.colors` over the preset defaults. That merge existed to protect a snapshot taken before a new
field (e.g. `cardShadow`) was added — but it also meant anyone who had ever picked a theme carried a
frozen copy of it, so **fixing a palette value shipped to new installs only.** Found while
correcting the dark text ladder, which would otherwise have reached almost nobody.

`updateColor` flips the key to `'custom'` the moment anything is changed, so a saved blob under a
**preset** key is always an unedited snapshot — its colours are pure redundancy. Preset keys now
resolve fresh from `PRESETS`, which also subsumes what the merge was written for. Only `'custom'`
still merges, because there the saved values genuinely are the user's own edits.

The corollary for any future palette work: **a token is not shipped until `loadSaved` will hand it
to an existing user.** Check that path before assuming a colour change is live.

## A token lives in four layers and only one of them ships (S627)

`ThemeContext.js`'s `PRESETS` is the only layer a user ever sees. `DESIGN.md`'s **frontmatter** is
the normative machine-readable copy, its **prose** is what a human or an agent actually reads, and
`.impeccable/design.json` is generated from both. A value that moves has to reach all four, or the
lower three describe a product that no longer exists — and because nothing renders from them,
**nothing fails when they are wrong.** That is the whole difficulty: this class of drift has no
symptom.

Found by refreshing the sidecar, not by any audit. S620 swapped `text2`/`text3` in the code and
rewrote the Colors prose but left the **frontmatter** on the pre-swap pairing, so the normative
layer contradicted both the code it describes and its own prose 290 lines below; the sidecar had
inherited the inversion. The same pass found all five `*-text` variants in the sidecar holding
*Light* preset values captured before S608's colour-blindness retune — `redText`/`amberText` still
at the exact ΔE 3.2 pair that retune existed to eliminate — and `accent-ink` holding **purple's**
hex outright.

Two checks whenever a preset value moves:

- **Grep the token name across `DESIGN.md` and confirm frontmatter, prose and `PRESETS` agree.**
  The frontmatter carries the **Dark** default by convention, and on a dark preset every `*-text`
  variant resolves to its own base colour (`applyTheme` does `t.greenText || t.green`) — so a
  variant sharing its base's hex up there is correct, not a redundancy to clean up.
- **Re-run `/impeccable document` so the sidecar is regenerated rather than left describing the
  previous palette.** `context.mjs` reports sidecar staleness, but it only compares timestamps: it
  cannot see a value that is merely wrong, which is how five of them survived two refreshes.

**`/impeccable document` defaults to SIDECAR ONLY (S645), and the full rewrite is the user's call
to make (S662).** Its playbook offers three paths and the destructive one is the default reading: a
full run re-extracts tokens from the code and **rewrites `DESIGN.md`**. That is safe for an
auto-generated file and expensive here, so the command stops and asks. **Answer its stop-and-ask
with "sidecar only" unless the user says otherwise** — the playbook sanctions the narrow path
explicitly (*"If the user only asks to refresh the sidecar, preserve DESIGN.md and write only
`.impeccable/design.json`"*). Present the trade honestly and let them choose; do not refuse the
rewrite, and do not perform it unasked.

Two things make the narrow refresh cheap and safe. **Diff before regenerating**: the sidecar's
`rules` array is extracted more broadly than the `**The X Rule.**` pattern, so a naive re-extract
silently drops the rest — compare and append instead. And **verify `colorMeta` against
`ThemeContext`**, because that is the one check the staleness hint cannot perform and the S627
finding above is exactly what it misses.

**The middle path is usually the right answer, and it now has a name (S668).** Neither of the two
the paragraph above frames: refresh the sidecar, *and* edit `DESIGN.md` surgically wherever the
code has moved past it — no re-extraction, no rewrite. The useful result of running it end to end
was how little there was to do. Every integrity assertion passed: 51/51 frontmatter colours carry a
`colorMeta` entry and 17/17 type roles a `typographyMeta` one, every `canonical` equals its
frontmatter value, every mapped token equals `PRESETS.dark`, the four `*-text` variants plus
`accent-ink` and `focus-outline` all resolve to their dark fallbacks, and the do's, don'ts and key
characteristics were already verbatim-identical to the prose. The entire drift was **one rule the
code had acquired and the file had never been told about**, plus two `typographyMeta` purposes.

**Write those checks as assertions, not as a reading pass.** They run in seconds against
`DESIGN.md`'s frontmatter, the sidecar and `ThemeContext.js`, and they are the only thing that
catches the S627 class of defect at all. A clean pass is worth as much as a find — it is what
tells you the narrow path was sufficient, instead of leaving a rewrite as the only way to be sure.
Assert the counts across the edit too: the sidecar's `rules`, `dos`, `donts`, `colorMeta`,
`typographyMeta`, `shadows`, `motion` and `breakpoints` should come out unchanged except where you
meant to add, which is what proves nothing was silently dropped.

**When a full rewrite IS chosen, the risk is not what it deletes — it is what it silently stops
covering (S662, 2026-08-31, the one time it has been run).** The rewrite went from 1,022 lines to
~900, which was the point; the real damage was in the machine layer, where three omissions each
turned working, deliberate code into apparent drift, and none of them announced itself:

- **The type ramp narrowed from 16 roles to 8.** The frontmatter is what the detector checks a
  literal against, so documenting only the roles a designer reasons in made real *tokenised* sizes
  (`--font-size-micro` 10px, `--font-size-chevron` 9px) read as off-ramp. Keep the complete ramp in
  the frontmatter and the readable subset in the prose — that split is what the spec is for.
- **Whole palettes vanished**: the 13-token print grayscale ramp and the guest menu's 14-token
  bone-and-pine set. Both are real, reused, deliberately theme-independent scales.
- **A sanctioned exception lost its rationale.** The sidebar's `width`/`margin-left` collapse
  animation is recorded in `.impeccable/config.json`'s `ignoreValues`, but the *reason* lived only
  in DESIGN.md — so the config entry survived and the argument did not.

So: after any rewrite, **re-derive coverage rather than re-reading the prose.** Diff the old and new
frontmatter key sets, grep `config.json`'s ignore reasons for `DESIGN.md` and confirm each still has
a home, and check that every frontmatter token has a `colorMeta`/`typographyMeta` entry (a
completeness assertion, not a spot check). The hook found all three of these within minutes of the
rewrite landing, which is the argument for editing a UI file straight afterwards rather than
committing the docs alone.

**`:root` parity is now a test, not a habit** (`src/context/themeTokenParity.test.js`). It asserts
every `--theme-*` in `Layout.css`'s `:root` block equals its `PRESETS.dark` field, and fails if a
preset gains a colour that `:root` never declares. It exists because that block drifted twice
(2026-08-12's `#6b7280`/alpha pair; S620's text2/text3 role swap, live for eleven days) and **the
failure has no symptom** — the wrong values are overwritten milliseconds later, so nothing looks
broken and no other test fails. Verified by re-introducing the S620 inversion and watching three
assertions fail. Adding a colour field to a preset now requires adding it to that test's `TOKEN_OF`
map, which is deliberate: that is where "does `:root` need this too?" gets asked.

## A signal colour carries one meaning per module, and a category carries none (S660)

Found in HR, where five approval queues and the employee Self-Service app show the same rows.
"Pending" was **brass** on Leave and Overtime, **grey** on TADA — grey being that module's
withdrawn/void colour, so the one queue actually awaiting a decision read as the most inert thing on
the page — and **amber** on the HR Dashboard and in the employee app. Amber meanwhile meant "waiting
on you" on the dashboard and "already approved" on TADA: one hue, opposite verdicts, on two screens
a manager works in one sitting.

Three transferable moves came out of the fix (full rule in `DESIGN.md` → **The One Signal Meaning
Rule**; the HR map itself is in `hr-payroll.md`):

- **The already-consistent surface is the spec.** Self-Service was internally correct, so its ladder
  was adopted rather than a sixth scheme invented. A colour decision made twice will be made a third
  way.
- **Two open states on one page separate by LABEL plus a shade of the same verdict**, never a new
  hue. TADA's pending-vs-approved-unpaid is amber-vs-brass; adding a colour to split two states of
  one verdict is how a five-token palette becomes eight.
- **A category that borrowed a signal colour gives it back.** Public-vs-optional holidays and
  holiday-vs-weekday OT rates were amber-vs-grey — a gazetted holiday in the same colour as an
  overdue approval. Both are brass now (`badge-yellow`, the accent-tinted categorical tag), which
  also made Holiday Calendar's table agree with its own two stat cards for the first time. The freed
  amber immediately did real work: a demand-forecast holiday badge is brass when a multiplier is set
  and amber `⚠` when it is not — two states that had been painted identically while only one of them
  needed anyone to act.

**POS is the same rule with a different failure (S661, `src/modules/pos/posSignals.js`).** Not
inconsistency — on the floor plan and the kitchen board the **loudest mark carried the least
information and spent the hue the urgent thing needed**. The floor's 6px strip painted an empty
table green and a full one red (a category as a verdict, and the polarity inverted: a full room is
the outcome you want), while telling a waiter something they can already see with their own eyes; it
answers *does this table need me?* now, and status keeps its labelled badge. The KDS strip was
red/amber/green for a stage the board already sorts into three labelled columns and puts on the
action button — so an on-time New ticket and a twenty-minute-late one wore the same red; it carries
lateness now. Same shape in the cart: `✓ KOT` was a solid green fill asking for nothing beside the
amber `+2` that does, and the KOT count badge was red for the normal state of every order ever
taken.

Three things generalise. **Green is not a button colour here** — the Payment button was the only
green fill in the product, against a vocabulary of `.btn-primary`/`-ghost`/`-danger`/`-danger--strong`,
and green is this palette's *done* verdict while the bill is unpaid. **The non-colour cue belongs on
the element a person READS, not the one that is loudest**: measuring the change found the KDS's late
vs going-late pair at **ΔE 3.1 under deuteranopia on Light** — S608's collision, still live in the
*base* red/amber the strip and border fill from — on a card with no labelled chip. Fixed with
`fcBand()`'s `△`/`▲` on the elapsed-time readout, not a sixth hue.

And **when the same colour decision exists in three files, the fix is a fourth file, not three
edits.** Staff rank had been decided independently in `HrStaff`, `ImsStaff` and `PosStaff`, and two
of the three drifted — a Supervisor was amber in IMS and POS (the same amber those modules use for
"needs attention") and brass in HR. `src/shared/staffLevelBadge.js` is now the one value, with
`STAFF_LEVEL_BADGE_NONE` for the no-access case. Same move as `operatingBands.js`. **The tell that a
constant wants a shared home is that it appears in files nobody would think to open together** —
nothing failed here; three near-identical screens simply had to be remembered at once, and were not.

**A banded ratio has one definition, marks included.** `fcBand()` settled food cost in S551/S608 and
the other three operating ratios were left to drift the same way — Labour Cost % was banded three
ways at once (30/37 with marks in the Monthly Owner Report, the same 30/37 inline and mark-less on
the Owner Dashboard, and `costPct > 35 ? amber` on the Roster board). `src/shared/operatingBands.js`
is the one definition. **Reach for `bandFigure(pct, bander)` and render its `text`**, never
`bander(pct).color`: the helper appends the ✓/△/▲, which is the mechanism that stops a call site
taking the colour and dropping the shape — exactly how the dashboard's copy lost it.
