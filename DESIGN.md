---
name: Crest Suite
description: Cost intelligence and HR for Nepal's F&B operators, in one instrument
colors:
  aged-brass: "#c9a84c"
  aged-brass-hover: "#d4b96a"
  ink-bg: "#0f1117"
  ink-card: "#181c27"
  ink-border: "#2a2f3d"
  ink-border-lt: "#1e2330"
  ink-sidebar: "#0e1117"
  text-primary: "#e8e0d0"
  # Corrected 2026-08-29: these two were still carrying their PRE-S620 assignment. S620 swapped
  # the roles in ThemeContext (`text2: '#9ca3af', text3: '#8a92a3'`) and updated the Colors prose
  # below, but never this block — so the normative token layer disagreed with both the code it
  # describes and its own prose, and the sidecar's colorMeta inherited the inversion. Fog is the
  # secondary tier (6.70:1), Slate the quietest (5.45:1); read the Neutral section for why the
  # swap was hierarchy rather than accessibility, which is exactly why no contrast audit caught it.
  text-secondary: "#9ca3af"
  text-tertiary: "#8a92a3"
  signal-success: "#34d399"
  signal-danger: "#f87171"
  signal-warning: "#fbbf24"
  signal-categorical: "#a78bfa"
  # The paired foregrounds and the two state tints, added to the frontmatter 2026-08-19 (S594).
  # They were missing here for as long as they have existed in ThemeContext, which meant two of
  # this file's own Named Rules — the Accent-Text Pairing Rule, and the whole "Signal colors used
  # as TEXT" section — pointed at tokens the normative layer never declared, and the sidecar's
  # colorMeta carried five entries keyed to nothing.
  #
  # READ THE VALUES BELOW WITH ONE CAVEAT: the frontmatter carries the DEFAULT (Dark) preset, and
  # on a dark preset every *-text variant deliberately resolves to its own base colour —
  # applyTheme does `t.greenText || t.green`. So `signal-success` and `signal-success-text` being
  # the same hex here is correct and is not a redundancy to clean up. They diverge only on the
  # five light presets, which is the entire reason the variants exist (measured: 23 of 25
  # signal/surface combinations failed AA before they did). Same for accent-ink, which equals the
  # accent on Dark and is a darkened hue-match on Light. Never resolve one of these to a literal
  # from this file — read the token.
  accent-text: "#0f1117"          # foreground ON an accent fill. Per-preset; #241a08 on Light
  accent-ink: "#c9a84c"           # the accent used AS text (a link, an active nav item)
  signal-success-text: "#34d399"
  signal-danger-text: "#f87171"
  signal-warning-text: "#fbbf24"
  signal-categorical-text: "#a78bfa"
  # Two state tints and the input ground. focus-ring is a TINT and its alpha must stay low — it
  # doubles as the active-state background for rail buttons, module tabs and sidebar links, and
  # measured alone on Rosé Dawn it composited to 1.15:1, 2.6x below WCAG 2.2's 3:1 focus floor.
  # focus-outline is the actual keyboard indicator that fixed it (S574): a 2px solid, resolved
  # per preset as accentInk on light and the accent on dark. A new focusable control pairs the
  # two; the ring alone is not a focus indicator.
  focus-ring: "rgba(201,168,76,0.15)"
  focus-outline: "#c9a84c"
  input-bg: "#0f1117"
  table-hover: "rgba(255,255,255,0.03)"
  # Print-only, documented 2026-07-20, expanded 2026-07-28. Print is a real surface here (stock
  # count sheets, payslips, purchase bills, KOTs, gate passes, recipe cost cards, POs), but the
  # palette above is all theme-token driven and none of it survives onto paper — @media print
  # forces white bg / black-ish text. The letterhead-style print templates (GatePassPrint.jsx,
  # PurchaseBillPrint.jsx, RecipeCostCardPrint.jsx, PurchaseOrders.js's print block, and their
  # HR/POS equivalents) share one literal grayscale ramp for ink/rule/label hierarchy instead of
  # theme tokens — CSS var() still resolves fine in a print stylesheet, but these are print-only
  # documents that were never meant to shift with the active theme preset (a purchase order
  # printed on Dark must read identically to one printed on Light). Valid ONLY inside a
  # print-only component or `.print-only`/`@media print` block; do not use these on-screen.
  print-ink: "#000000"      # heading text, rule dividers, PurchaseOrders.js's own #111 is the same role
  print-text: "#333333"     # body copy needing more weight than a label
  print-label: "#555555"    # secondary meta lines (dates, addresses, PAN/VAT)
  print-label-lt: "#777777" # field labels, table body secondary text
  print-notes: "#444444"    # notes/callout box text (PurchaseOrders.js print block)
  print-muted: "#888888"    # uppercase section eyebrows, footer/index columns
  print-faint: "#aaaaaa"    # generated-by footers, least emphasis
  print-rule: "#cccccc"     # table header/footer rule lines
  print-rule-strong: "#999999" # bordered chips (e.g. status pill outline)
  print-rule-lt: "#dddddd"  # notes-box border
  print-rule-xlt: "#eeeeee" # table row divider
  print-fill: "#f3f3f3"     # table header row background
  # ImsGuideTab.jsx's buildGuidePrintHtml() (the "Print Guide" export under Admin → Settings →
  # Guides) is a step further removed than the templates above: it's a fully standalone
  # `<!doctype html>` string opened in its own print window, with no connection at all to the
  # React app's stylesheet or :root CSS custom properties — var(--radius-sm) etc. would not
  # resolve there even inside an on-screen component. Documented 2026-08-05 rather than edited:
  # its border-radius (3px/4px on .meta chips) and grayscale (#666/#555/#ccc/#f5f5f5/#96700a-as-a
  # print-safe darkened accent) are a legitimate, structurally-necessary variance from both the
  # on-screen shape scale and this print ramp, not drift to fix.
  # On-screen exceptions where a CSS var() token genuinely can't be used, documented 2026-07-28
  # instead of left as silent drift.
  chart-tick: "#6b7280"     # Recharts axis tick/label/reference-line fill — var() does not
                             # resolve inside SVG presentation attributes (see Do's and Don'ts)
  toggle-knob: "#ffffff"    # the sliding thumb inside a toggle switch (e.g. PurchaseBillModal's
                             # per-line VAT toggle) — a literal white dot regardless of theme is
                             # the near-universal toggle convention; it sits on a colored track,
                             # never directly on the page background, so contrast holds on both
                             # both presets
  # GUEST MENU ONLY — the bone-and-pine printed-card palette, scoped to .guest-menu in
  # src/modules/pos/guestmenu/guestMenu.css. Documented here rather than left as drift, on the
  # same reasoning as the print ramp above: a deliberate, structurally-necessary variance from
  # the two presets, not a fourth accent leaking into the product.
  #
  # WHY IT IS EXEMPT FROM THE PRESET SYSTEM AT ALL: /pos/menu/:tableId is the one surface a
  # paying customer sees, and PRODUCT.md already names it the deliberate brand-facing exception.
  # Reading --theme-* there meant a guest got whichever preset the SCANNING PHONE had saved in
  # localStorage (an owner or manager device rendered the public menu in whichever preset it had),
  # falling back
  # to Crest back-office charcoal for everyone else. A public page cannot inherit a private
  # staff setting, so this set is fixed and theme-independent by design.
  #
  # The two anchors are the client-specified pair and measure 9.17:1 against each other — AAA
  # both ways. Every value below was measured on guest-paper; the ratios also sit in guestMenu.css.
  # Pine is RATIONED exactly as Aged Brass is elsewhere (brand, price, category, active chip,
  # call to action) and body copy is warm ink, so the One Accent Rule holds on this surface too.
  # Do not reach for any of these from a staff screen.
  guest-paper: "#F0EDE5"      # card/input ground — the dish is read on this
  guest-ground: "#E7E3D8"     # page, one step behind the paper so a card can lift off it
  guest-pine: "#004643"       # the accent: brand, price, category heading, active chip, CTA fill
  guest-pine-deep: "#00312F"  # pressed/hover state of a pine fill
  guest-ink: "#1C1B17"        # 14.8:1 — dish names and body-strength text
  guest-sage: "#4A5C58"       #  6.1:1 — dish descriptions
  guest-sage-lt: "#566762"    #  4.7:1 on guest-ground (the tighter of the two surfaces; this
                              #  role lands on both), 5.1:1 on guest-paper — nutrition tags,
                              #  covers line, table name, smallest meta
  guest-rule: "#D3CCBC"       # structural hairline; recedes on purpose
  guest-control: "#4A7A75"    #  4.1:1 — outlines a tappable control, clearing WCAG 1.4.11
  guest-veg: "#4C7A2E"        #  4.3:1 — veg mark (a market convention, not a palette choice)
  guest-nonveg: "#A63A2B"     #  5.5:1 — non-veg mark
  guest-success: "#2F6B2A"    #  5.5:1 — ready to serve
  guest-warn: "#8A5A17"       #  5.1:1 — allergens; a safety line, so never faint
  guest-danger: "#A03328"     #  6.0:1 — order dismissed, submit failed
typography:
  wordmark:
    fontFamily: "Georgia, serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.04em"
  body:
    fontFamily: "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.08em"
  # The three roles above are the system's semantic anchors. The steps below complete the ramp
  # the product actually ships (added 2026-07-20) — previously the frontmatter captured only
  # 16/13/11px while the prose already described a 14-15px title tier and a 16-20px display
  # tier, so every other real size read as undocumented drift. The named sidebar sizes mirror
  # the --font-size-* custom properties defined at the top of Layout.css; page-level sizes are
  # inline. Sizes are a closed set: if a new one is genuinely needed, add it here first.
  stat-value-lg:
    fontSize: "32px"
    fontWeight: 700
  stat-value:
    fontSize: "24px"
    fontWeight: 700
  numeral:
    fontSize: "22px"
    fontWeight: 700
  page-title:
    fontSize: "20px"
    fontWeight: 700
  section-heading:
    fontSize: "18px"
    fontWeight: 700
  rail-icon:
    fontSize: "17px"
  # Touch text-input only, added 2026-08-22 for the Crest Staff employee app. This is not a taste
  # step and must not be used as one: 16px is the threshold below which iOS Safari zooms the
  # viewport on focus and never zooms back out, so every field an employee types into on a phone
  # has to sit at or above it. The alternative fix — pinning the viewport with
  # maximum-scale/user-scalable=no — blocks pinch-zoom for everyone and is an accessibility
  # failure, which is why it is deliberately not used. Scoped to .self-service in
  # selfService.css; the admin app's 13px `body` step is still correct on a mouse-driven screen.
  touch-input:
    fontSize: "16px"
    fontWeight: 400
  card-heading:
    fontSize: "15px"
    fontWeight: 600
  title:
    fontSize: "14px"
    fontWeight: 600
  meta:
    fontSize: "12px"
    fontWeight: 400
  micro:
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.08em"
  chevron:
    fontSize: "9px"
  # Print-only, documented 2026-08-05 alongside the print-color-ramp note below — same reasoning:
  # a thermal-printer receipt needs fixed-width columns to stay aligned, which Poppins can't give.
  # Used in creditNoteHtml.js, posOrderPrintHtml.js, parkingSlipHtml.js, PosShifts.jsx's print
  # block — never inside the live app UI.
  print-monospace:
    fontFamily: "'Courier New', monospace"
rounded:
  # Micro-elements only — legend swatches, colour dots, thin progress-bar fills — added
  # 2026-08-13 (S551). It is a real step the scale was missing rather than a licence to go
  # tighter: the 2026-07-12 step-up rounded every micro-element up to sm along with everything
  # else, and 38 sites across IMS had quietly reverted to a 2-4px literal because an 8px corner
  # on a 10x10 swatch is a circle. Anything with a label, a border and padding is sm or larger.
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  # Fully-rounded. Documented 2026-07-20 — the sidebar module switcher's pill signature (see
  # Navigation) already shipped this shape, it just wasn't in the scale. Reserved for that
  # switcher and for shapes whose radius is simply half their own height (the 6px scrollbar
  # thumb). Not a general-purpose step: see the Tabs note on why .tab-btn stays at md.
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
# Motion tokens are NOT in this frontmatter, and their absence is deliberate rather than an
# omission: the DESIGN.md schema accepts only colors / typography / rounded / spacing /
# components at the top level, so a `motion:` group here is invalid and gets dropped by any
# DESIGN.md-aware tool that validates the file. They lived here from 2026-08-11 until the
# 2026-08-12 refresh, which relocated them to `.impeccable/design.json`'s extensions.motion —
# the layer built to hold exactly what this schema can't. The Motion section below is still the
# normative prose; nothing about the token values changed, only where the machine-readable copy
# lives. Same reason shadows and breakpoints are not up here either.
components:
  button-primary:
    backgroundColor: "{colors.aged-brass}"
    textColor: "{colors.ink-bg}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.aged-brass-hover}"
  button-ghost:
    backgroundColor: "{colors.ink-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "{colors.ink-bg}"
    textColor: "{colors.signal-danger}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  card:
    backgroundColor: "{colors.ink-card}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  # One step tighter than .card's 24px. Not drift: a stat tile is a label-plus-numeral pair with
  # no internal composition to breathe around, and a row of them reads better slightly denser.
  stat-card:
    backgroundColor: "{colors.ink-card}"
    rounded: "{rounded.lg}"
    padding: "20px"
  # Badges carry an alpha tint of their own signal color as background, which this schema's
  # 8-prop set cannot express as a token ref — the literal per-variant values live in the
  # sidecar's component snippets. textColor is the honest half of the pair.
  badge:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  input:
    backgroundColor: "{colors.ink-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  tab-btn:
    backgroundColor: "{colors.ink-card}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
  tab-btn-active:
    textColor: "{colors.aged-brass}"
---

# Design System: Crest Suite

## Overview

**Creative North Star: "The Back-of-House Command Center"**

Crest Suite is operated, not visited. An owner is checking margin between service rushes; an accountant is reconciling TDS figures before a filing deadline. Neither has time for the interface to perform. The system is built around **legibility under pressure**: dense tables that stay scannable, a single restrained accent, and status communicated through color and position rather than decoration.

This deliberately rejects two things named in PRODUCT.md: the dated, hierarchy-less density of legacy Nepali ERP software, and the templated purple-gradient look of generic AI-generated SaaS. The system solves density the same problem legacy ERPs were trying to solve, but with real typographic hierarchy, a single accent used sparingly, and consistent spacing instead of cramming.

The product runs across **two** interchangeable theme presets — **Dark** (charcoal-and-gold, the shipped default) and **Light** (warm white, the same design in a light scheme). Eight others (Tokyo Night, Dracula, Nord, Catppuccin, Latte, Rosé Dawn, Solarized, Bright) were retired on 2026-08-24/S607: every theme is an independent surface that must be re-verified for every signal colour, badge and focus style, and a measured audit found 30 contrast failures concentrated in the four dark presets nobody had checked. Dark and Light both measured clean, and they are the pair `system` mode resolves between for the employee app — so they are also the two that cannot be removed. Both are built from the same token set. Every rule below is written against the default preset's values, but the *relationships* between tokens (accent used sparingly, borders and lightness-shift carrying hierarchy, alpha-blended status tints) hold across both, even where the literal shape values (radius, shadow) no longer do — see Elevation.

**Key Characteristics:**
- Depth comes primarily from a one-step background-lightness shift, with a per-preset shadow as a secondary cue (added 2026-07-12 — see Elevation; previously flat-only, see that section's history note)
- One accent color per screen, applied sparingly (buttons, active states, focus rings) never as a wash — no exceptions remain (Bright carried the only scoped one; retired with that preset in S607)
- A serif wordmark is the one deliberate ornamental choice in an otherwise all-sans, all-functional system
- Status (paid / pending / overdue, veg / non-veg, stock health) is color-coded consistently: green success, red danger, amber caution, gray neutral, with a rationed 4th color (purple) reserved for a genuine fourth or fifth category when green/red/amber aren't enough

## Colors

The palette is a dark charcoal neutral scale with a single warm accent; every other color is a semantic signal, not a decorative choice.

### Primary
- **Aged Brass** (#c9a84c): The one accent. Primary buttons, active tab/nav states, focus rings (at low alpha), links, and any "this is the interactive, on-brand element" signal. Used on a small minority of any given screen; its rarity is what makes it read as intentional rather than default-theme blue.

### Neutral
- **Ink** (#0f1117): App background and input fields.
- **Ink Card** (#181c27): Cards, stat tiles, table containers - one step lighter than the page so surfaces read as raised without a shadow.
- **Ink Border** (#2a2f3d): Structural borders (card edges, table header rule).
- **Ink Border Light** (#1e2330): Secondary/internal borders (table row dividers, input borders) - quieter than the structural border.
- **Ink Sidebar** (#0e1117): Sidebar rail, theme-matched to background.
- **Parchment Text** (#e8e0d0): Primary text - warm off-white, not pure white.
- **Fog Text** (#9ca3af): Secondary text - labels, metadata, table headers. 6.70:1 on the card.
- **Slate Text** (#8a92a3): Tertiary text - the quietest tier, timestamps and disabled-adjacent copy. 5.45:1.

These two **swapped roles in S620**, and the swap is the whole fix: the values were always in
the palette, just assigned the wrong way round, so every "quietest tier" hint was rendering
*louder* than every secondary label on the dark preset. Light was ordered correctly the whole
time (7.33 > 5.76), which is why nothing looked wrong. Both tiers cleared AA before and after —
this was hierarchy, not accessibility, which is exactly why no contrast audit had caught it.

### Signal colors
- **Success Green** (#34d399): Paid, approved, healthy stock, positive variance.
- **Danger Red** (#f87171): Overdue, rejected, negative variance, destructive actions.
- **Warning Amber** (#fbbf24): Pending, low stock, needs-attention.
- **Categorical Purple** (#a78bfa): A rationed 4th/5th categorical color for when green/red/amber genuinely aren't enough (e.g. Staff Meals as a distinct expense category, a sub-recipe tab underline). Not a general-purpose accent - reach for it only when a page needs one more distinct hue than the semantic three provide.
- **Roster shift-type swatches** (`Roster.jsx`'s `DEFAULT_SHIFTS`, seeded into the per-client-customizable `hr_shift_types` table) are a deliberate exception to the token system entirely, not an extension of it - six fixed hex swatches (`#3B82F6`/`#F59E0B`/`#8B5CF6`/`#64748B`/`#10B981`/`#EC4899`/`#6B7280`) so a roster board's color-coding stays legible and consistent regardless of which of the ten theme presets is active, the same reasoning `FoodBeverageSplit.jsx`'s categorical fallback rotation already uses. Admin can further customize these per client via Shift Settings, so they were never meant to track the theme anyway. (A second, drifted copy of this same palette in `shared/constants/shiftTypes.js` was found unused - zero real imports anywhere in the codebase - and deleted 2026-08-05 rather than reconciled.)

### Signal colors used as TEXT — the `*-text` variants (added 2026-08-12/S549)

A signal color does two different jobs and, on a light preset, one value cannot do both. It **fills** things (chart series, badge tints, borders, status dots) and it **is text** (a badge's label, a KPI figure, a variance number). On a dark preset one value serves both, because a bright green on a near-black card clears AA easily. On a light preset it does not: measured against their own surfaces, **23 of the 25 signal-color/preset combinations across the five light presets failed AA** — Latte's amber at 2.15:1, Rosé Dawn's at 1.87:1, its accent at 2.37:1, and the subscription badge on Latte at 1.58:1.

So each light preset additionally declares a darkened, hue-preserving text variant, clearing 4.5:1 against that preset's worst surface (its own sidebar). Dark presets declare none — `applyTheme` falls back to the base color, so a dark preset resolves `--theme-green-text` to `--theme-green` exactly:

- `--theme-green-text` · `--theme-red-text` · `--theme-amber-text` · `--theme-purple-text`
- `--theme-accent-ink` — the accent used **as** text.

**`--theme-accent-ink` is not `--theme-accent-text`, and the two are easy to confuse.** `accent-text` is the foreground that sits **on** an accent-colored fill (the Accent-Text Pairing Rule below). `accent-ink` is the accent itself used as text on a normal surface — a link, an active nav item, a plan label.

**The rule: if the color is text, use the `*-text` variant; if it fills, use the base token.** `.badge-green`/`-red`/`-amber`/`-purple`/`-yellow` in `Layout.css` already do this, so anything using those classes gets it for free — the alpha-tint *fill* stays the base color, only the foreground changes. The palettes themselves were deliberately left untouched: Latte, Rosé Dawn and Solarized are faithful reproductions that people choose *because* they recognise those exact values, and the same tokens paint charts and tints where the lighter value is correct.

The **neutral ramp was corrected in place** rather than given variants, because `text1`/`text2`/`text3` are only ever text — there is no fill use to preserve. `text3` had failed on all five light presets (3.72–4.02:1). The new values keep three distinct tiers (~6.5 / ~5.6 / ~4.6) instead of flattening them all onto the 4.5 floor.

**History (2026-08-13/S550): Rosé Dawn and Solarized were the floor, not Latte** — measured failing signal-colour/surface combinations per preset were Rosé Dawn 10/10, Solarized 10/10, Bright 6/10, Latte 4/10, Warm Light 3/10; worst single measurement `--theme-amber` at **2.05:1** on Rosé Dawn. All four of those presets were retired in S607 and **Light is now the only light preset**, so spot-check colour work there. The finding is kept because it is *why* the `*-text` variants exist: the base signal tokens are tuned for fills, and a light surface exposes that the moment one is used as type.

**It recurred again on 2026-08-19 (S594), in the file the hook could not see.** `ModuleGuideTab.jsx` rendered the entire "Watch out for" list — the highest-value content in a 1,000-line admin reference, and the thing that stops a consultant teaching a client a bug — in `var(--theme-amber)` as 12px body text, i.e. **2.05:1 on Rosé Dawn**, the single worst measurement in this whole section. Its route chip repeated the error twice over: `var(--theme-accent)` as text (should be `accent-ink`) on `rgba(0,0,0,0.15)`, a black wash that is a grey smear over a light preset's white card. The reason it survived is the S521 lesson restated: only `GuidesTab.jsx` was in the changed-file set, so the hook never ran on the component it renders. **A wrapper being new does not put the thing it wraps in scope** — when a critique or audit targets a page, include the components it composes, not just the files git reports.

**Three things the variants must NOT be applied to**, each of which will look like a missed site to a future sweep:

1. **A legend swatch.** It must equal the series it labels. Darkening the `●` while its line stays on the series colour desynchronises them, which is worse than the contrast it fixes. The adjacent label text carries the readable contrast, and the series identity is conveyed by that text — not by the swatch alone.
2. **Anything a caller passes as a *series* colour.** `StatPill`'s `color` prop drives its dot and is legitimately handed a chart hex; it used to drive the value text too, which made a fill hex into 13px/700 type at about 1.9:1 on a light card. The prop is now split — `color` for the dot, `textColor` for the value.
3. **A `color:` in a ternary is still a `color:`.** Roughly half the real sites are `fcPct <= 35 ? green : amber : red`, which a property-level regex does not match. A sweep that only catches `color: 'var(--theme-x)'` will report itself complete having found less than half.

For JS consumers, `useTheme()`'s `colors` object resolves the variants with base-colour fallbacks (`colors.greenText`, `colors.accentInk`, …) so they are always defined — the dark presets declare none, and Recharts reads plain values, not CSS variables.

**Never build a multi-series chart palette from the semantic tokens** (restated here because it recurred, 2026-08-13/S550). `--theme-accent` and `--theme-purple` are the *same hex* on Dracula, Catppuccin Mocha and Latte. Owner Dashboard's Cost & Margin trend drew Food Cost and Labor Cost from those two tokens, so on three of ten presets they were one indistinguishable line — on the chart whose entire purpose is telling those two apart. **Those three presets were retired in S607, and the rule survives them on fresh evidence:** measured on the two remaining presets, Dark is clean on all ten signal pairs, but **Light** collapses `red`/`amber` to ΔE 3.1 and `accent`/`red` to ΔE 5.6 under deuteranopia (floor 8). The tokens are five *roles*, not five distinguishable hues — that was always the actual reason. Chart series take fixed literal hex (`var()` does not resolve in SVG presentation attributes anyway); reuse the validated `COST_BREAKDOWN_COLORS` set rather than picking new hues. And prefer **encoding a relationship over adding a hue**: a metric's projection shares its metric's colour and is distinguished by a dash, and a derived total (Prime Cost = Food + Labor) reads as a dashed composite rather than a fifth peer. **Updated 2026-08-24/S608:** both of the concrete measurements this rule has leaned on are now gone — the same-hex presets were retired, and Light's `red`/`amber` collapse was fixed by retuning `redText`/`amberText`. The rule does not depend on either. Semantic tokens change to serve legibility and branding; series separation is a different constraint that nothing checks for them. The dedicated palettes are the answer, and they need measuring too: `CHART_COLORS` had carried a **ΔE 0.4** deuteranopia collision between its blue and violet slots since it was written — `#a78bfa` → `#8b5cf6` and `#fb923c` → `#ea580c` now clear all 28 pairs for deuteranopia and protanopia. Tritanopia is deliberately not chased: separating on the blue-yellow axis fights separating on red-green, and it is ~0.01% against ~8%.

### Named Rules
**The One Accent Rule.** Aged Brass (or the active preset's own accent) is the only non-semantic color on any screen. If a second "brand" color shows up anywhere outside the rationed purple exception, it's a mistake, not a design choice. **Bright's `ClientDashboard.jsx` KPI badges are the one named, scoped exception** (see Badges / Status Chips) - everywhere else, on every preset including Bright itself, the rule holds as written. A 2026-08-05 audit found a second undocumented accent (an indigo/blue, `#60a5fa`/`#818cf8`) had spread into `AdminClients.js` (module pills, a "Features" button) and `SuiteGate.js` (the Suite-upsell card) - fixed to `var(--theme-accent)`/`var(--theme-focus-ring)`, matching the identical upsell card in `PremiumGate.js` which never had the bug. The same `#60a5fa` turned up a third time the same day, in `AuditLog.js`'s `ACTION_STYLE.UPDATE` (an Added/Updated/Deleted status badge) - fixed to `var(--theme-purple)` rather than `var(--theme-accent)` this time, since this is a genuine 4th-category case (Added and Deleted already claim green/red, and "Updated" doesn't fit amber's caution/pending semantic) - exactly the rationed-purple exception this rule already carves out, not a second violation of it. **It recurred a fourth and fifth time** (S523, found during a full-app `/impeccable layout` pass, not a color audit): `AdminDashboardOverview.jsx`'s IMS/HR/POS module-count pills (KPI card and table rows, both hardcoding `#60a5fa`/`#a78bfa` for IMS/POS) and `HolidayCalendar.jsx`'s "Optional Holidays" stat (`#818cf8`, sitting directly next to "Public Holidays" which already correctly used `var(--theme-accent)`) - both fixed to `var(--theme-accent)`/`var(--theme-purple)` per the same mapping already established in `AdminClients.js`'s module pills (IMS=accent, HR=green, POS=purple). Five occurrences of the identical undocumented-indigo pattern across five files is no longer a one-off - any new categorical badge/pill work should grep for `#60a5fa`, `#818cf8`, and `#a78bfa` specifically before shipping. **A sixth occurrence turned up 2026-08-05 during an `/impeccable colorize` pass on the IMS module**, and it was the inverse of the usual shape: `MenuEngineering.js`'s `Q_HEX` (a hex lookup for the Menu Engineering scatter chart's SVG dot fill, since `var()` can't resolve inside SVG presentation attributes) had `Plowhorse: '#60a5fa'` while that same quadrant's legend/badge color (`QUADRANTS.Plowhorse.color`) was already correctly `var(--theme-purple)` - so the scatter-chart dot for a Plowhorse recipe visually disagreed with its own legend swatch. Fixed by changing the hex to `#a78bfa` (theme-purple's actual value) so the two representations of the same quadrant match. Distinct from the prior five in that this one didn't need a semantic remap (purple was already the intended color); the hex literal had simply drifted to a different blue than the token it was supposed to mirror. **A seventh occurrence, 2026-08-12 (S534), is a sub-shape worth naming separately: a drifted `var()` *fallback*.** `Login.css` wrote `var(--theme-purple, #8b5cf6)` in four places - the token reference is correct, so the rule reads as satisfied at a glance and every audit that greps for bare hex assignments walks straight past it, but `#8b5cf6` is a violet that exists in no preset (`--theme-purple` is `#a78bfa`). A fallback only paints in the window before `ThemeContext` sets the custom property, which is precisely when a wrong value is visible; corrected to `#a78bfa`. When checking a file for color drift, **check the fallback halves of `var()` calls too, not just standalone literals** - and note the fallback is the one place a hex is legitimately expected to appear next to a token, which is exactly why a wrong one survives there.

**A paired token is only correct while it is actually measured.** `--theme-accent-text` was plain `#ffffff` on all five light presets, and on three of them that failed: measured live 2026-08-13 (S551) at **2.84:1 on Rosé Dawn, 3.61:1 on Light and 3.68:1 on Solarized** — i.e. every `.btn-primary` in the product, on those three themes, for as long as they have existed. Fixed by giving those presets a dark hue-matched ink rather than darkening the accent itself, since the accent is a brand value that also serves as a tint, border and dot colour where it was already correct. The same pass found the inverse on the dark side: `--theme-accent-ink` now exists on **Tokyo Night, Dracula and Nord**, because a light accent on a dark card is not automatically safe once that card is tinted with the accent itself (see Tabs). Reach for the token, and then verify the token.

**The Chart Palette Rule.** Chart series come from the validated fixed-hex sets (`CHART_COLORS` /
`VENDOR_SPLIT_COLORS`, `COST_BREAKDOWN_COLORS`), never the semantic tokens — and the sets themselves
get re-measured whenever a slot moves. As shipped 2026-08-24/S609 the 8-series set is
`#c9a84c #34d399 #60a5fa #f87171 #8b5cf6 #ea580c #22d3ee #f472b6`, worst pair ΔE 37.9 normal /
**15.8 deuteranopia / 21.0 protanopia** — all 28 pairs clear. It reached that only by moving two
slots: blue and violet had sat at **ΔE 0.4** under deuteranopia since the array was written, drawing
two indistinguishable lines on any chart with five or more series.

Two limits are accepted rather than hidden, and both rest on the same mitigation — these charts
carry **secondary encoding**: paddingAngle gaps, on-slice percent labels, and name+value legends, so
colour reinforces rather than carries. **Tritanopia is not satisfied** (worst pair ΔE 0.9);
separating on the blue-yellow axis fights separating on red-green, and it is ~0.01% against ~8%.
And the palette is **tuned for the dark card** — on Light, six of eight slots fall under the 3:1
non-text floor (worst `#22d3ee` at 1.81). Closing that means re-picking six hues that clear 3:1 on
both surfaces *and* still separate under both red-green axes: a mid-tone set with a different
character from today's vivid-on-charcoal one. **That is a design decision, not a correction — do not
make it silently while fixing something else.**

**The Signal Separation Rule.** Two signal colours that a reader compares must stay distinguishable *without hue*. Measured under deuteranopia (~6% of men) and protanopia (~2%), not by eye. Light's `redText`/`amberText` shipped at **ΔE 3.2** — danger and warning were one colour for a red-green colour-blind reader — and were retuned in S608 to `#8f2440`/`#a85200`, the only pair of 120 searched that clears both axes while every variant holds ≥4.5:1. Where a band is a *scale* rather than a status (food cost healthy/watch/too-high), colour is not enough on its own at all: `fcBand()` also returns a `✓`/`△`/`▲` shape mark, distinguished by fill rather than hue, so the band survives greyscale and a monochrome print. **A figure a person reads and acts on carries the mark; a chart axis or sparkline may take colour alone.**

**The Signal Polarity Rule.** A signal colour is a **verdict**, so a figure compared against a target must be coloured by whether it moved in the *good* direction for that metric — not by which side of the line it landed on. Green and red are never neutral to an owner reading between services; there is no reading of a red ▼ that isn't "something went wrong here". The Daily Purchases vs Sales tooltip coloured both actual rows ▲ green / ▼ red literally, and reported live (S634) it painted `Purchases : NPR 2,295` against a NPR 3,112 target red — for running *under* the spending pace, which is the outcome you wanted. **Shape is the fact, colour is the verdict**: keep ▲/▼ literal so it agrees with the line the reader can see, and invert the colour per metric (`GOOD_DIRECTION` — sales `+1`, purchases `-1`). Applies wherever a cost sits beside a revenue: variance, budget-vs-actual, wastage, food-cost trend. Two consequences: shape stops being redundant with colour (a green ▼ and a red ▼ now both exist), so the magnitude must appear as **text** — the gap as a percentage of target, not a second currency figure — and any legend explaining the two series has to say the polarity out loud, because nothing else on screen admits that they are coloured by opposite conventions.

**The Accent-Text Pairing Rule.** Any element with an accent-colored background uses the theme's paired `accent-text` token for its foreground (`#0f1117` in the Dark preset, `#241a08` in Light), never a hardcoded white or black. Because the accent color changes per theme preset, a hardcoded foreground color will silently fail contrast on at least one of the two presets. This is a real bug the codebase shipped and fixed once already (a floating action button used a hardcoded white label) - treat it as the standing rule, not a one-off fix. A 2026-07-12 audit found the same class of bug in four more shared components (`SearchableSelect.js`, `BsCalendarPicker.js`, `PremiumGate.js`, `ProtectedRoute.js`) that had been hardcoding the Dark preset's exact hex values since before the theme system existed - fixed to read theme tokens, so they now actually respect every preset instead of only working by coincidence on Dark. **It recurred once more** (2026-08-05, `AdminClients.js`'s "Annual" badge, hardcoded `#000` on `var(--theme-accent)`) - fixed to `var(--theme-accent-text)`. Given it's now shipped-and-fixed twice, treat any hardcoded `#000`/`#fff`/`white`/`black` sitting next to `var(--theme-accent)` as a near-certain instance of this bug on sight, not just a style-review nit.

## Typography

**Display Font:** Georgia, serif (fallback: serif) - reserved for the wordmark only.
**Body Font:** Poppins (Google Font, weights 400/500/600/700 + italic 400), falling back to -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, sans-serif if the webfont fails to load.
**Label Font:** none distinct; labels use the body stack at a smaller size and wider tracking instead of a separate typeface.

**Mono:** `source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace`, scoped to the `<code>` element in `index.css` and used in exactly four places, all of them genuine machine strings a user may need to read or copy verbatim — a payment reference, a `you+name@` email pattern, a source file path, and a config snippet. This line previously read "none distinct", which was never true. Monospace is for code, data and measurement here; it is not available as a "technical-looking" costume.

**Form controls do not inherit `font-family`, and must be told to** (added 2026-08-12/S549). `body` sets Poppins, but every browser substitutes its own UA default into `<input>`, `<button>`, `<select>` and `<textarea>`. Measured before this was fixed: all 14 controls on the login page, all 13 pricing CTAs and **every `.btn` in the product** rendered in Arial — the product's own typeface reached its prose and none of its controls. `Layout.css` had accumulated 10 per-class `font-family: inherit` patches (none of them on `.btn` or `.form-field input`), which is the tell that inheritance was always the intent. One rule in `index.css` now covers `input, button, select, textarea, optgroup` — `optgroup` included because Firefox styles it separately from `select`. **Do not re-add per-class patches.**

**Character:** A restrained geometric sans for every working surface, broken exactly once by a serif wordmark. The serif is a signature, not a typographic system - it never appears on a second element.

### Hierarchy
- **Display** (700, 16-20px depending on placement, line-height 1.2, letter-spacing 0.04em, Georgia serif): the "Crest" wordmark only - sidebar brand mark and the login screen. Nowhere else.
- **Title** (700, 14-15px, line-height 1.4): card headings, section titles ("Submit Leave Request", stat card values).
- **Body** (400-500, 13px, line-height 1.5): table cells, form values, the default size for nearly everything a user reads.
- **Label** (500, 11px, letter-spacing 0.08-0.1em, uppercase, Slate Text or Fog Text): table column headers, stat card labels, section eyebrows. Sparse by necessity - this is a data-dense product, not a marketing page, so uppercase labels earn their place as literal column headers rather than decorative kickers.

### Named Rules
**The One Serif Rule.** Georgia appears exactly once per screen (the wordmark, if visible at all). It is never used for a heading, a callout, or emphasis - that would dilute it from signature to affectation.

## Layout

*Section added 2026-08-12. The spatial model was always real in the code but had never been written down in one place — radius and density notes were scattered across Components, and the responsive behavior was documented nowhere at all.*

**The shell is a fixed sidebar plus a flowing content column.** `.sidebar-wrap` is `position: fixed` at 240px (56px collapsed), and `.main-content` reserves that space with a matching `margin-left` on the same two values — the two animate in lockstep (see Navigation for why this is a layout-property animation and stays one). Content padding is 32px on every page; nothing is centred in a max-width reading measure, because every screen here is a working surface rather than a document.

**Spacing rhythm is a 4/8/16/24 scale**, applied by convention rather than by token — there are no `--spacing-*` custom properties, so the scale lives in the frontmatter and in usage, not in CSS. 16px is the default gap between peers (grid gaps, button rows, form field stacks); 24px is `.card`'s internal padding and the gap between major sections; 8px and 4px are for chip-level and intra-control spacing. A value off this scale in new work is drift, the same way an off-ramp font size is.

**KPI rows are auto-fitting grids, not fixed columns.** `.stat-grid` is `repeat(auto-fit, minmax(180px, 1fr))` with a 16px gap and 28px bottom margin, so a row of 4 stat cards reflows to 2×2 and then to a single column without a media query. Prefer this over hand-declared column counts — the dashboards that do declare columns (`.dash-3col-*`, for the IMS/HR/POS split) do it because the *content grouping* is meaningful, not because the widths needed pinning, and each of those collapses to `1fr` at the breakpoint.

**One breakpoint: 768px.** There is no tablet tier and no desktop max-width. Below 768px the sidebar leaves the flow entirely (`transform: translateX(-100%)` plus a hamburger and a 55%-black overlay), `.main-content` drops its reserved margin, and the multi-column dashboard grids go single-column. Touch sizing is handled separately and deliberately by `@media (pointer: coarse)` rather than by width — see Inputs / Fields for why that distinction matters.

**Wide tables scroll, they do not compress.** `.table-wrap` is `overflow-x: auto` around every wide table; the data keeps its native column widths and the container takes the scrollbar. Pair it with `.table-wrap--fab-clear` (88px bottom **margin**) on any page that also renders a `Fab` — the Fab is `position: fixed` with no reserved space, so without the modifier it sits on top of the last row's action buttons. That was found live on 11 pages at once; treat the pairing as mandatory rather than a polish step.

**A scroll container's clearance is margin, never padding** (corrected 2026-08-30/S646). `.table-wrap--fab-clear` reserved its 88px with `padding-bottom` from the day it was added (2026-07-23) — inside the scroll container, so the horizontal scrollbar rendered 88px *below* the last row: off the fold on any table long enough to scroll the page, and with Windows' overlay scrollbars, not on screen at all. The rule above therefore stopped being true in practice — a too-wide table did not read as scrollable, it read as content sliced off at the right edge, and that is how it was eventually reported. Margin gives byte-identical clearance (a margin on the last child of a padded `.card` cannot collapse out of it) and puts the scrollbar directly under the table. Generalise it: **any padding on an `overflow: auto` element pushes its scrollbar away from the content it scrolls.**

### Named Rules

**A page that renders into the body flow needs its own scrollport** (added 2026-08-23/S604). `src/index.css` sets `html, body { overflow-x: hidden }` as an app-wide horizontal guard; because html's overflow is then not `visible` it stops propagating to the viewport, **body becomes its own scroll container sized to its content, and a `position: sticky` child of the body has a scrollport that never scrolls.** Every screen in IMS/HR/POS is immune because the app shell scrolls its own div — the exceptions are the three pages that render directly into the body, and all three had a sticky bar that had never once stuck: the guest menu's category bar (its only navigation), `/login`'s header and `/pricing`'s nav. Measured on the built pages at 390×780, each nav's viewport `top` went `0 → −250 → −600`, i.e. moving 1:1 with the content. The fix is per-page — `height: 100dvh; overflow-y: auto; overscroll-behavior: contain` on the page root, **and delete the `min-height: 100vh` it was carrying**, since 100vh ≥ 100dvh pushes the root taller than its own scrollport and hands the scroll straight back to the body. Relaxing the shared rule instead was measured and rejected: `html { overflow-x: hidden }` alone restores sticky and loses the guard entirely (1610px of horizontal overflow on a probe page, identical to no rule at all). Use `dvh`, not `vh` — on a phone `100vh` is the tallest the viewport ever gets, so the fold, where a cart button or primary CTA lives, sits under the URL bar. **This one is invisible to review**: it looks correct in the code and computes to `sticky` in devtools; only `getBoundingClientRect().top` read across real scroll positions catches it.

**The Auto-Fit-First Rule.** Reach for `repeat(auto-fit, minmax(<floor>, 1fr))` before declaring a column count. A fixed count is a claim that the grouping matters at every width; if it doesn't, the fixed count is just a media query you now have to maintain.

**The Measured-Floor Rule** (added 2026-08-12, from the Admin → Clients list). When a row of chips or badges repeats down a list, give each a `minWidth` taken from the **measured** widest real label, plus `textAlign: 'center'`. Content-width chips vary on incidental things — `IMS · Starter` is wider than `IMS · Pro` — so the columns, and everything anchored after them, slide from row to row for no meaningful reason and the list reads ragged. Measure in the browser (`getBoundingClientRect().width`) rather than guessing a number: the client cards' pill floor is 100px against a measured 96px, and the subscription badge's is 112px against 108px.

**`space-between` on two controls in a wide container is an anti-pattern.** It does not distribute, it *banishes* — the two items end up at opposite edges of however wide the container happens to be, with the entire remainder as dead space. The client cards had a full-width action bar holding exactly two 10px buttons flung to either end of a ~1000px card. Group related controls with a `gap` and let the container's own alignment place the group.

**No interactive control below 12px.** The same bar's buttons were 10px with 2px vertical padding — legible in a mockup, a squint in use, and a poor hit target. Chips and buttons in dense list rows sit at 12–12.5px with roughly 5–7px vertical padding; 10px is for genuinely non-interactive micro-labels only.

## Elevation & Depth

**History note (2026-07-12):** this section previously documented a strict "Flat-By-Default Rule" — no card shadows anywhere, depth from background-lightness and borders only. That rule is retired as of the Bright theme + sidebar redesign session: every preset now gets a real `box-shadow` on cards via a per-preset `--theme-card-shadow` token, at the user's explicit request. What's below is the model that replaced it — read this section as current, not the old rule plus an exception list.

**The model: background-lightness stays primary, shadow is a secondary, per-preset-tuned layer — not inverted, not uniform.** A card is still one tone lighter than the page (dark presets) or a distinct surface tone from the page (light presets) — that hasn't changed and is still the main depth cue, especially on dark presets where a literal black shadow would be nearly invisible against an already-near-black page. Shadow is layered on top, generated by formula from each preset's own `bg`/`text1` values rather than a flat black:

- **Dark-leaning preset** (Dark): `inset 0 1px 0 0 rgba({text1}, 0.06), 0 10px 24px -8px rgba({bg}, 0.55), 0 3px 8px -3px rgba({bg}, 0.4)` — a faint light-tinted rim highlight plus a deep, theme-colored (not neutral-black) shadow, so e.g. Tokyo Night's indigo cast or Dracula's purple cast survives instead of flattening to generic black.
- **Light-leaning preset** (Light): `0 1px 2px rgba({text1}, 0.06), 0 10px 24px -8px rgba({text1}, 0.1)` — a classic soft shadow, tinted from the preset's own ink color rather than pure black.
- *(Retired 2026-08-24/S607: **Bright** had broken the light-preset formula once more, tinting its shadow's outer layer from the accent blue `rgba(58,109,240,0.16)` rather than neutral ink — it was the one preset where the accent was allowed to show up more than "sparingly". Removed with the preset.)*

Shadow was already in real use before this change beyond the two cases previously documented here (a floating cart button, live-status pulse rings) — `.sidebar-dropdown-panel`'s popover, `RailTip`'s hover tooltip, and `ChartCard`'s expand-modal all had their own shadows already. Those are unchanged; the new per-preset `--theme-card-shadow` token is additionally applied to `.card`, `.stat-card`, and the three main dashboards' inline `kpiCard()` panels.

### Shadow Vocabulary
- **Card elevation** (`box-shadow: var(--theme-card-shadow)`): the default for `.card`/`.stat-card` and equivalent panels, per-preset-tuned per the model above.
- **Floating action** (`box-shadow: 0 4px 16px rgba(0,0,0,0.3)`): unchanged — a fixed/floating element genuinely above the page (e.g. the bottom-anchored cart button, `Fab.js`).
- **Live pulse (status)** (`box-shadow: 0 0 0 0 rgba(<signal-color>, 0.5)` animating to `0 0 0 6px rgba(<signal-color>, 0.18)`): unchanged — a breathing ring on elements needing real-time attention, using the relevant signal color's own alpha.

### Named Rules
**Shadow tells you what surface you're on, not that a page is "polished."** Card elevation is now uniform policy (every preset, every card), so it no longer functions as a special signal the way the floating-action and live-pulse shadows still do — don't invent a *third* meaning for it (e.g. a stronger shadow to mean "important"). If something needs to stand out, that's a job for the accent color or position, same as always.

## Shapes

*Section added 2026-08-12. The radius scale itself was already in the frontmatter and the per-component values were already in Components; what was missing was the rule tying a step to a size class, which is the part that actually prevents drift.*

**Six radius steps, and they are a closed set:** 4px (`--radius-xs`, micro-elements only — added 2026-08-13), 8px (`--radius-sm`), 12px (`--radius-md`), 18px (`--radius-lg`), 24px (`--radius-xl`), 999px (`--radius-full`). The whole scale was stepped up on 2026-07-12 from a much tighter one (4/5/6/10px) — the product reads noticeably softer than it did, and that was a deliberate move away from the hard-cornered legacy-ERP look PRODUCT.md names as an anti-reference.

**Radius tracks the element's size class, not its importance.** Chip-sized things take `sm` (badges, small icon buttons); control-sized things take `md` (buttons, inputs, selects, tab pills, nav links); surface-sized things take `lg` (cards, stat cards, table containers); `xl` is for the largest panels only. This is why a badge and a card don't share a radius even though both are "containers" — the corner has to stay proportional to the box, or a small chip reads as a lozenge and a large card reads as a rectangle.

**`full` (999px) is reserved, not available.** It belongs to the sidebar module switcher's pill signature and to shapes whose radius is genuinely half their own height (the 6px scrollbar thumb). `.tab-btn` deliberately stays at `md` rather than going full-pill — two pill treatments on one screen would dilute the switcher from a signature into a pattern. See Tabs.

**Borders carry structure; there are two weights and they are not interchangeable.** `--theme-border` is structural (card edges, the table header rule, input outlines); `--theme-border-lt` is internal (table row dividers, ghost button edges). Using the structural weight for a row divider makes a dense table read as a grid of boxes, which is precisely the legacy-ERP failure mode.

**No clipping, no masks, no non-rectangular silhouettes anywhere in the product.** Every surface is a rounded rectangle. The one recurring non-rectangular shape is the circular status dot / pulse ring, which is a signal rather than a container.

### Named Rules

**The Proportional Corner Rule.** If a new element needs a radius, pick the step by asking how big the box is, not how important it is. An "important" card does not get a larger corner; it gets the accent color or a better position.

## Components

> This section is the **visual spec** — shape, colour, state, focus. For the *inventory* — which
> reusable component to reach for and why each exists — see `.claude/rules/component-library.md`
> (moved out of `CLAUDE.md` in the 2026-08-27 /doctor pass; it auto-loads when editing
> `src/components/**`, `src/pages/**` or `src/modules/**`).

### Buttons
- **Shape:** 12px radius (`--radius-md`; bumped from 6px 2026-07-12), no exceptions across variants.
- **Primary:** Aged Brass background, `accent-text` foreground (never hardcoded), 700 weight, 8px 16px padding, 13px label.
- **Hover:** background steps to the theme's `accent-hover` token; no scale/transform, no color-only state changes on interactive elements otherwise.
- **Ghost:** input-bg background, primary text color, 1px `border-lt`; hover shifts to `table-hover` tint with the border color stepping to accent - a quiet way of saying "this became interactive."
- **Danger:** input-bg background, red text, red border at low alpha; hover fills to a red tint. Reserved for destructive actions only (delete, void), never for "important" as a stand-in for danger.
- Feel: tactile and confident. Transitions are short (0.13s) background/color fades, no bounce, no elastic easing, no scale-on-press - firmness comes from color contrast and weight, not physics.
- **Danger, escalated** (`.btn-danger--strong`, added 2026-08-12/S546): the same variant one step up, for the single irreversible action inside a group of otherwise-recoverable destructive ones — Danger Zone's "Delete Client" beside Clear/Archive. Deeper red tint (0.16 fill, 0.55 border) and 700 weight, and deliberately **still a tint rather than a solid red fill**: `--theme-red` ranges from light (`#f87171` Dark) to dark (`#dc2626` Light) across both presets, so no single foreground contrasts on both. At most one escalated button per group, or the escalation means nothing. *(Corrected 2026-08-12/S549: this previously read "and there is no `--theme-red-text` token to pair with a fill." There is one now — but it does not change the conclusion, because `--theme-red-text` is the **red used as text**, i.e. a darkened red for a light surface, not a foreground to sit **on** a red fill. `--theme-accent-text` is still the only paired-foreground token in the system, and only the accent has one.)*
- **Disabled** (`.btn:disabled`, formalized 2026-08-12/S546): 0.55 opacity, `cursor: not-allowed`, and every variant's `:hover` is scoped `:not(:disabled)` so a dead button does not still light up under the pointer. This closes a real gap rather than adding polish — every call site had been writing its own inline `opacity: busy ? 0.6 : 1`, so a button that reached for the class alone had **no disabled state at all**: it stopped responding while looking exactly as it had. If a button can be busy or blocked, it now gets this for free; do not re-add a per-site opacity.
- **Focus:** `.btn` and `.tab-btn` had **no `:focus-visible` rule at all** until 2026-08-13/S551 — the two classes nearly every page in the product is built from. Measured on Outstanding Payables, 11 of 16 focusable elements fell back to the browser's default outline, which on a dark card is close to invisible. Both now take the same 3px `focus-ring` the inputs use, as does `Tip`'s trigger (keyboard-reachable since S465, but with nothing to see). Same page afterwards: 15 of 17.
- **Never hand-roll a button's inline style when a variant exists.** The 2026-08-12 audit of `ClientDrawer.js` found six Danger Zone buttons each carrying a near-identical eight-property inline style object, with three different red alphas serving as an ad-hoc severity ladder, all at an off-scale 6px radius and none inheriting the hover transition. `.btn-danger` had existed the whole time. Drift concentrates almost perfectly in controls that opted out of a class — that is the single most reliable place to look for it.

### Badges / Status Chips
- **Shape:** 8px radius (`--radius-sm`; bumped from 4px 2026-07-12), 2px 8px padding, 11px label, capitalized.
- **Style:** each semantic color renders as a ~10-12% alpha tint of itself as background, full-opacity as text - never a solid fill with white text. This keeps a table full of status badges calm even when every row has one.
- **Roles:** green (paid/approved/healthy), red (overdue/rejected), amber (pending/low), gray (neutral/cancelled).
- *(Retired 2026-08-24/S607: a **Bright-only exception** had given `ClientDashboard.jsx`'s five headline KPI cards a colourful per-category icon badge — the One Accent Rule's only sanctioned breach. Its hues were hardcoded from Bright's own accent blue, so it had no coherent home once that preset was cut; `kpiIcon()` and its five call sites were removed rather than re-tinted for another theme.)*
- A 2026-08-05 audit found `AdminClients.js`'s Trial Accounts panel had drifted onto a solid `background:'#f87171'`/`color:'#fff'` fill for its count pill and "Wants to Subscribe" badge — fixed to the standard `.badge`/`.badge-red` alpha-tint classes.
- **`.badge-yellow` (`Layout.css`) resolves to `var(--theme-accent)`, not amber — it is the categorical-tag badge (item/recipe category chips), a legitimate accent use, and a genuinely different class from `.badge-amber` (`var(--theme-amber)`, the real warning color).** An `/impeccable colorize` pass on the IMS module (2026-08-05) found six call sites across `Variance.js`, `StockReport.js`, and `Requisitions.js` that reused `badge-yellow`/`theme-accent` for an actual warning/caution state — "Under" variance, "No sales data," "Low" stock (badge + two matching numeric-cell colors), and a requisition's "Draft" status — none of which are category tags. This diluted the warning below the "needs-attention" semantic the Colors section already assigns to amber, and doubled as a soft One Accent Rule violation (accent standing in for a status meaning, not an interactive/brand one). All six fixed to `badge-amber`/`var(--theme-amber)`. When adding a new status badge, check what it actually represents before reaching for `badge-yellow` by pattern-matching nearby code — a categorical tag and a warning state are not interchangeable just because they render a similar gold-ish color on the Dark preset (they diverge sharply on presets like Bright, where accent is blue).

- **A tier or add-on above the module set takes the accent plus a mark, not a fourth hue** (2026-08-13/S552). The admin client list carries IMS/HR/POS pills in accent/green/purple; Crest Suite Pro had no pill at all, and adding a fourth colour would have been the exact One Accent Rule drift documented above. It renders as `★ SUITE` in the accent at a heavier fill (0.20 vs the module pills' 0.10) and 700 weight — the glyph and the weight carry the distinction, the hue stays inside the system. A lapsed one greys to `text3` on a plain border rather than disappearing, because an add-on that vanishes reads as one that was never bought.

### Cards / Containers
- **Corner style:** 18px radius (`--radius-lg`; bumped from 10px 2026-07-12) - noticeably rounded, still not pill-shaped.
- **Background:** one step lighter than the page background; no gradient, no tint toward the accent. A 2026-08-05 audit found `AdminClients.js`'s Trial Accounts panel header using a `linear-gradient()` — the one confirmed instance of this rule being broken found so far. Fixed to a flat `rgba(248,113,113,0.10)` wash (the same literal `.badge-red` background tint, scaled up for a section header rather than an inline chip).
- **Shadow strategy:** `var(--theme-card-shadow)` (added 2026-07-12 - see Elevation). Depth is background-shift + border + a per-preset-tuned shadow, no longer border-only.
- **Border:** 1px, structural border color.
- **Internal padding:** 24px on `.card`; 20px on `.stat-card`. Corrected 2026-08-12 — this line previously read "24px, consistent regardless of card content density," which was never true of the stat tile. The tighter step is deliberate and worth keeping: a stat card is a label-plus-numeral pair with no internal composition to breathe around, and a row of them reads better slightly denser. Anything with real content inside it takes 24px.

### Inputs / Fields
- **Style:** input-bg background (typically matches or nears the page background, one step darker than card), 1px border, 12px radius (`--radius-md`; bumped from 6px 2026-07-12), 13px text, label sits above the field (never a placeholder standing in for a label).
- **Focus:** border steps to accent color, plus a soft 3px ring in the theme's own `focus-ring` token (an alpha-blended version of the accent, not a generic browser-blue ring). This focus ring is themed - it changes hue with every preset.
- **Error:** a field failing validation carries `aria-invalid="true"`, which is also the styling hook - the border steps to `--theme-red` and a `.field-error` message renders directly below the field, carrying `role="alert"` so it is announced rather than merely shown. Formalized 2026-08-12 (S534) on the login/reset surface, and **extended to the app 2026-08-23 (S603)**: `.field-error` moved to `index.css` (global, so both surfaces share one rule rather than the signed-out pages owning the only copy), the `[aria-invalid="true"]` border hook covers `.form-input`/`.form-select`/`.form-field input|select|textarea` in `Layout.css`, and `src/components/FieldError.jsx` supplies the message plus `fieldAria(id, message)`. **The two halves are one thing on purpose:** `aria-invalid` is both the assistive-tech signal and the styling hook, so a field cannot be *shown* as failing without also being *announced* as failing — which a `.is-invalid` class alongside a separate aria attribute permits, and which is how a form comes to look validated and read as unlabelled. The border is never the message: colour alone conveys nothing to a screen reader or a red-blind reader (WCAG 1.4.1).

  Three things the extension had to settle, worth not re-deriving. **A form-level error and a field-level one are different channels, not the same one placed differently** — a rejected write, or a rule spanning several boxes (Items' conversion trio, Recipes' "add at least one ingredient", Purchase Bill's line table) has no field to sit under and correctly stays form-level; a message naming one box belongs under that box. `EmployeeForm.jsx` is the case that names the gap: it switched **tab** to reveal the offending field and then reported the failure as prose the box itself never carried, so the information was computed and thrown away. **Editing a field clears its own error** — a border still red under a box the user has just corrected teaches them these messages are stale and worth ignoring, which is how a real one gets scrolled past. And **invalid outranks every other border state**: focus, an unsaved-edit amber (`MenuPricing`), an open picker. Focusing the field the user has to fix is exactly when the signal must not disappear.

  Two shared controls needed a prop rather than a class, for the same reason `touch` is a prop: every colour in `BsCalendarPicker` and `SearchableSelect` is an inline style, and an attribute selector has no path to one. Both now take `invalid={message}`. Both point `aria-describedby` at the `<FieldError>` and deliberately do **not** set `aria-invalid` — their trigger is a `<button>`, and `aria-invalid` is unsupported on the button role, so assistive tech ignores it (jsx-a11y flags it). Earning it properly would mean making the trigger a real combobox, the way `SearchableSelect`'s *panel* became one in S521.
- **Disabled / read-only: the surface carries the state, never the value** (added 2026-08-23/S603, closing the last "unformalized" note in this section). Until this rule existed there was **no** disabled treatment for a field at all — and because `.form-field input` sets its own `background`, `border` and `color`, those declarations overrode the UA's own disabled styling, so a disabled field rendered **identical to an editable one**. Sales and Overheads disable their entire grid on a closed period, so the two pages where a locked month most needs to be obvious were the two where nothing said so: the boxes simply stopped responding. The well now flattens to `transparent` and the border steps to `--theme-border-lt`; the cursor is `not-allowed` when disabled and stays a text caret when read-only, because read-only is not refusal — the value is real and meant to be selected and copied.

  **This is deliberately not `.btn:disabled`'s `opacity: 0.55`, and the difference is not stylistic.** A button's label is a verb you may not press; a field's content is *data*. A locked period still shows a real month of real figures, and those have to stay legible precisely because they can no longer be corrected — dimming them is the opacity mistake this file's own Don't-list already names. Two UA behaviours have to be overridden explicitly or the treatment is defeated anyway: WebKit paints a disabled control's text with **`-webkit-text-fill-color`**, which plain `color` does not override, and iOS Safari layers **its own opacity** on top. Disabled and read-only render identically because the message to the reader is identical — not editable here; what differs is the tab order and selectability, which is the browser's job and not the palette's.

  A control still styled **inline** escapes all of this, exactly as it escapes the `[aria-invalid]` hook and the touch-sizing media query — and the period-lock inputs are inline, i.e. the sites that need it most. `disabledStyle(base, isDisabled)` in `src/shared/inlineFieldState.js` composes the same treatment into an inline object so there is one definition rather than a grey per call site; it sits beside `invalidStyle(base, message)` because both exist for that one reason. The real fix is still the control moving onto a class.

- **Every field needs `id` + `htmlFor`** (added 2026-08-12/S546; **swept complete 2026-08-23/S603 records it**). A `<label>` that is merely a *sibling* of its input, which is what `.form-field` renders by default, names nothing: screen readers announce an unnamed edit box and clicking the label focuses nothing. `ClientDrawer.js` shipped 22 such fields, and when this rule was written only `Login.js`, `ResetPassword.js` and `SelfServiceHome.jsx` associated theirs — so it read as "the pattern to extend". It has since been extended and the sweep is finished: **S546** did `ClientDrawer.js`, **S551** the whole IMS module (96 pairs across 23 files), **S569** the remaining app including Settings/Periods/AdminClients — and a real duplicate-id bug in `NutritionEditorModal.jsx`, where all six nutrient inputs shared one id — and **S576** closed POS, which S569 had missed entirely (52 bare labels → 0). Measured 2026-08-23: **all 27 files using `.form-field` associate their labels, 345 `htmlFor` pairs across 61 files, and of 189 real `<select>` elements none is unnamed.** Write new fields with the pair from the start; this is now a rule to keep rather than one to roll out.

  Two things learned doing it, both still live. Custom controls take ids too — `SearchableSelect` had to be given an `id` prop, because a custom widget with no id is an unnamed button to a screen reader no matter what sits beside it, and `BsCalendarPicker` and `QtyInput` forward one for the same reason. And a warning about doing it in bulk: **a regex whose label-inner group can match across `</label>` will backtrack past a custom control** and bind a label to the *next* field's input, which looks entirely correct in a diff. Assert afterwards that every `htmlFor` resolves to exactly one `id` in its file.

- **A `<label>` that names nothing is worse than no label** (added 2026-08-19/S576). The corollary to the rule above, and the shape that survives every `htmlFor` sweep because it *looks* correct: a `<label>` sitting over a **button group** (toggle chips, tab-bars, radio-style pills), over a **read-only figure** (POS Orders' "Short by / Change", a parking slip's date), or over a **repeating row's column** is announced as a name the browser will never bind to a control. Those become a `<span class="field-label">` — `.form-field .field-label` in `Layout.css` carries the same typography a `<label>` had, so the fix never costs a visual change — with `role="group"`/`role="radiogroup"` + `aria-labelledby` on the container and `aria-pressed` on the buttons. A column heading over a repeating row is a `<span>` too, and each row's controls carry their own `aria-label` naming the column *and* the row. **A `<button>` can never be named by a `<label>` at all**, however adjacent; it takes `aria-label`, and `aria-pressed` (which accepts `"mixed"` — Purchase Bill's all-lines VAT toggle has a real tri-state).
- **A `<select>` needs an accessible name even where the design gives it no visible caption** (added 2026-08-19/S576, closed in the same pass). Filter toolbars *were* the product's blind spot: 86 unnamed `<select>`s across 43 files — period pickers, category/status/vendor filters, day ranges, sort orders — each announcing only its current option, with nothing to say what it selects. All named; re-measured 2026-08-23 at zero remaining out of 189. `aria-label` where there is no visible text, `id`/`htmlFor` where there is. Inside a `.map()`, use a **template** `aria-label` naming the row (`Permission level for ${r.label}`), never a constant that repeats identically down the list.
- **A control the user must reach cannot be `display: none`.** Hiding a real input behind a styled stand-in is fine; hiding it with `display: none` (or `visibility: hidden`) removes it from the tab order, so there is no keyboard path to it at all. Use `.visually-hidden` (clip-based, `Layout.css`) when the input itself must stay reachable, or forward a real `<button>`'s click to it. `ClientDrawer.js`'s logo upload had the broken shape — `display:none` input behind a `<span>` carrying `pointerEvents:'none'` — and was unusable without a mouse.
- **A standalone input takes `.form-input`; only a `.form-field` child is styled for free** (added 2026-08-19/S593). Until this class existed the *only* themed input rule was the descendant selector `.form-field input`, so an input placed in a plain flex row — the natural shape whenever a field sits inline beside a button — received **no** treatment at all and rendered as the browser's native white box. On the five dark presets that is unmissable; on the light ones it is nearly invisible, which is how ClientDrawer's "or create a new group…" box sat next to a properly themed `<select>` through several reviews. The tell that the gap was real rather than incidental is what the sites which *did* notice reached for: one hand-copied all six declarations inline, and two borrowed **`.form-select`** — which carries `cursor: pointer`, so a text field announced itself as a menu. `.form-input` shares one rule with `.form-field input` so the two can never drift, and the same edit gave both the `:focus-visible` solid-outline pairing S574 established (`.form-field` inputs had only ever had the soft 1.15:1 ring, since the `:focus` rule's specificity shadowed the bare `input:focus-visible` backstop). **Reach for a class before styling an input inline** — an inline style also escapes the `[aria-invalid]` hook, the `:disabled` treatment and the touch-sizing media query below.

  **The scale of it, measured 2026-08-23/S603: 62 text controls across 22 files were wearing `.form-select`** — `<input>`s and `QtyInput`s announcing themselves as menus, because that is the class that was there to copy when `.form-input` did not yet exist. All swapped. The swap was not a rename, and the reason is worth keeping: **`.form-input` sets `width: 100%` and `.form-select` does not**, so a blind substitution would have stretched every toolbar search box and filter field that had never pinned its own width, and in a flex row a `flex-basis` of 100% wraps its neighbours. `.form-input--auto` is the difference — 14 of the 62 take it. **Width is layout, not control identity**; reach for that modifier rather than an inline `width: auto`.
- **A native `<input type="file">` is never shippable UI.** Its "Choose File / No file chosen" chrome is drawn by the browser: no token reaches it, it ignores the type scale, and it renders in the *OS* language rather than the app's. The pattern is a `.visually-hidden` input (not `display:none`, per the rule above) with a real `.btn` forwarding the click — which four of the app's five file inputs already used; ClientDrawer's Restore box was the last raw one, fixed 2026-08-19/S593.
- **Touch sizing:** under `@media (pointer: coarse)` inputs go to 16px text and buttons to a 44px minimum height. 16px is the threshold below which iOS Safari zooms the viewport on focus and never zooms back out - a 14px field turns "tap the email box" into "now pan the page sideways to find the password box". Scoped to the pointer type rather than a width breakpoint on purpose: the trigger is the input method, not the screen size, so a desktop layout tuned at a specific density is left untouched. WCAG 2.2 SC 2.5.8's 24x24 floor is the hard minimum everywhere (a bare unpadded text button will fail it - the login page's "Forgot password?" was a 96x14px target); 44x44 is the target on touch. **Corrected twice.** S546 found this block lived only in `Login.css` and so covered only the signed-out pages, and gave `Layout.css` the `.btn` (44px) and `.panel-tab` equivalents. **S603 then found the 16px half had never been ported at all** — it existed as `.login-field input` and nowhere else, so every field in IMS, HR and POS stayed 13px on a tablet, on a product whose till and stock count *are* tablet surfaces. `Layout.css`'s coarse block now carries an element-level rule for `input`/`select`/`textarea` (checkbox, radio, range, color, file and the button-shaped types excluded) plus `min-height: 44px` for `button:not([class])`.

  **That rule uses `!important`, and it is load-bearing rather than defensive** — the same justification the reduced-motion block in the same file already carries. 370 form controls across ~46 files set their font-size in an inline `style` object, and no selector beats an inline style; without it the floor would reach the controls that least needed it and skip every one that did. The 44px button rule is scoped to `:not([class])` instead, because every classed button already has a tuned value here (`.btn` 44, `.btn-sm`/`.tab-btn` 32, `.sidebar-link` 40) and a bare `button` selector would quietly re-decide the ones that merely have no rule yet; `min-height` only, since `min-width` on a narrow icon button squeezes its neighbours while extra height just makes the row taller, which on a tablet is the point.

  **This does not retire "reach for a class."** A control on a class also gets the `[aria-invalid]` hook, the `:disabled` treatment and the shape scale — none of which an `!important` floor can supply, and none of which an inline style can receive. The floor exists so the zoom trap does not wait on a 370-site sweep.

### Tabs (pill filters)
- **Style:** 12px radius (`--radius-md`; bumped from 5px 2026-07-12 - see the pill-shape note below), 1px border, 4px 12px padding, 12px label, secondary text color at rest.
- **Active state:** accent-colored text, accent border at 50% alpha, `focus-ring` token as background fill, weight steps up to 600. The active tab looks "selected," not "pressed" - it's a persistent state, not a momentary one. **The label takes `--theme-accent-ink`, not `--theme-accent`** (corrected 2026-08-13/S551): this is the accent used as *text*, on a tint of that same accent, and the base token failed AA on **7 of the 10 presets** — worst 2.27:1 on Rosé Dawn, on a rule that renders on 19 IMS routes alone. The underline keeps the base token, where it is a fill.
- **Not pill-shaped, on purpose:** the sidebar's module switcher (see Navigation) is true pill-shaped (`border-radius: 999px`) as its own deliberate, singular signature. `.tab-btn` deliberately stays at the standard `--radius-md` rather than also going full pill - two different pill treatments on the same screen would dilute the switcher from "one special treatment" to "just another pill row," the same restraint problem the One Serif Rule guards against for the wordmark.

**Underline tabs are a second, distinct tab family** (`.panel-tab`, added 2026-08-12/S546) — sections *within* one surface, typically a modal panel (`ClientDrawer`'s eight), as opposed to `.tab-btn`'s filter/sort pills which change what a single view shows. Bordered pill for a filter, underline for a section; do not mix the two in one row. Rest is `text2`; active is accent text plus a 2px accent underline and 600 weight; a danger section keeps `--theme-red` in both states and takes the underline in red. The row wraps rather than overflowing — an overflowing tab bar silently hides its **last** tab, which is how `ClientDrawer`'s `⚠ Danger` went missing for a release.

**Use `.panel-tab-bar` for the row itself** (added 2026-08-13/S551). It carries `display:flex` + `gap` + `flex-wrap` + the bottom rule, so the wrap behaviour above is a property of the class rather than something each page has to remember. Seven IMS pages had hand-rolled the row inline; Stock Count's had **seven tabs and no `flexWrap`** — the exact shape that hid `ClientDrawer`'s Danger tab, with "Print Sheet" the one at risk.

**Any tab row needs real tablist semantics**, not just buttons that look selected: `role="tablist"` on the row, `role="tab"` + `aria-selected` + `aria-controls` per tab, `role="tabpanel"` + `aria-labelledby` on the body, and a **roving `tabIndex`** so the whole row is one stop in the page's tab order with the arrow keys (plus Home/End) moving inside it. Without the roving index, reaching the eighth tab by keyboard costs eight Tab presses — and the eighth tab is where the destructive actions live.

**A filter row's options come from the DATA, not from the enum** (added 2026-08-30/S650). Purchases
carries five filters on one row — day pills, Item, Vendor, a Bill no. search and Payment — and the
day pills had always been built from the days that have bills, never 1..32. The Payment select now
follows: it lists the methods the selected period actually used, in the source enum's order, with
any unrecognised value **appended rather than dropped**, and it hides entirely when a period used
only one method. The two failures it avoids are not symmetric — an option that returns nothing is
noise, but a value present in the data with no option is a row nothing can reach.

**And a column with a display fallback must have that fallback applied in every predicate that
filters on it.** `payment_method` is NULL on bills written before the column existed; every screen
renders `|| 'Cash'`, so filtering the raw column would have hidden rows the page itself labels
Cash. One helper (`methodOf`) now resolves it for the filter, the option list and the row badge
alike. Generally: **if a value is displayed through a fallback, it must be filtered, grouped and
counted through the same fallback** — the same shape as the `.neq drops NULL rows` trap, and as
S648's `purchase_group_id || id`.

**Every filter must reach the totals.** Purchases' entry count and *both* footer figures (goods
value ex-VAT, payable incl. VAT) derive from the one filtered set, so a filter can never leave a
total describing rows that are no longer on screen. Changing period clears all five.

### Navigation
**Rewritten 2026-07-12** — the sidebar was restructured from a 56px icon rail + separate 220px flyout panel into one unified column.
- **Structure:** `.sidebar-shell`, one column, 240px expanded / 56px collapsed (`--main-content` margin-left tracks the same two values). Top to bottom: brand (logo + wordmark, Georgia serif per the One Serif Rule + Ctrl-K search trigger) → module switcher (see below) → scrollable nav content (client badge, nav groups, footer) → a fixed bottom row (Help / collapse toggle / Sign out), always visible regardless of collapsed state.
- **Module switcher:** a horizontal pill row (`.module-switcher`/`.module-tab`, `border-radius: 999px`-adjacent full-pill shape) when expanded, one tab per module the user can see (Admin/IMS/HR/POS - 1 to 4 tabs depending on role and what the client has enabled). Collapses to a vertical icon-only column (same buttons, `flex-direction` flip) when the sidebar is collapsed - visually equivalent to the pre-2026-07-12 icon rail. **Hidden entirely when only one module is visible** - a one-pill switcher reads as broken UI, not a real choice.
- **Collapsed state:** a CSS class toggle (`.sidebar-wrap--collapsed`), not a JSX unmount - the nav content stays mounted and is hidden via `display:none`, so scroll position and any open dropdown state survive a collapse/expand toggle instead of resetting.
- **Style:** sidebar background matched to the active theme (dark sidebar on dark themes, light on light themes) so it never reads as a fixed dark strip on a light theme. Nav items use the accent color for active/hover state, using the `--motion-fast`/`--ease-standard` pairing from the Motion section below (this sidebar is where those two tokens originated) rather than a timing invented per-component.
- **Row density (revised 2026-08-26/S611):** `.sidebar-link` is `padding: 4px 12px` with no vertical margin — a ~28px row for a 13px label — with `.sidebar-divider` at `4px` top margin and `.sidebar-section-label` at `2px` vertical padding, so group gaps stay proportional to the rows they separate. **Density and touch target are separate controls here and must stay that way:** the `@media (pointer: coarse)` block holds `.sidebar-link` at `min-height: 40px`, which is what a finger actually hits, so this padding only decides desktop density. Tighten it further and the next 4px has to come from the 18px `.sidebar-icon` box or the 10px section label — *not* the 13px `--font-size-nav-item`, which is the bottom of the closed type scale.
- **Accepted exception:** `.sidebar-shell`'s collapse toggle animates `width`, and `.main-content`'s tracks it by animating `margin-left` (`Layout.css`, both `transition: ... 0.22s ease`) rather than `transform`/`opacity`. Normally a layout-property animation, flagged as such. Kept as-is (confirmed 2026-07-12, reasoning unchanged from the original single-rail version): `.sidebar-wrap` is `position: fixed`, so real space must be reserved for whichever width the sidebar currently is - a `transform`-only fix would mean restructuring the sidebar's positioning strategy app-wide, and the animation only fires on a rare, manual, user-triggered toggle, not a continuous or scroll-linked one, so the real jank risk is low. Revisit only if the sidebar's positioning mechanism changes for other reasons.

### Skip link + context bar (shell chrome, added 2026-08-12/S549)

**`.skip-link`** is the first focusable element in `.layout-root`, hidden until focused, then a real 132×40 target. It exists because **41 focusable controls sit inside the sidebar before the first control in `<main>`, on every one of ~86 routes** — WCAG 2.4.1 Bypass Blocks (Level A). `<main>` carries `id="main-content"` and `tabIndex={-1}` as its target. The sidebar also now has three labelled landmarks (`Modules`, `<panel> pages`, `Help and account`); before this the module switcher and the bottom rail sat in no landmark at all.

**`.context-bar`** renders above the `<Outlet />` on every route: client · active BS period · Open/Closed · plan, plus a "Viewing as admin" tag. A hairline and a row of text, never a card — it must not compete with the page's own H1 directly beneath it, and it wraps rather than truncating because on a phone it is the *only* place this information appears (the sidebar that otherwise carries it is off-canvas). The period is the emphasised token because it is the one that silently changes underneath you. It deliberately does not hide on the dashboard that happens to repeat the same facts in its own subtitle: a self-locating chrome element that is present on 85 routes and absent on one is worse than one that is always there.

The reasoning is product-specific rather than generic: every IMS figure is period-scoped, an admin can be "viewing as" another tenant, and an Owner can switch outlets — three independent ways to read a real number off the wrong books, on a product whose whole thesis is trusting the number enough to act on it.

### Report shell (`ReportPage`, added 2026-08-19/S594)

Every IMS/Suite report renders inside one component that owns the **six states a report can be in**: no period, loading, could-not-load, empty, filtered-to-nothing, and content. It exists because this design system governs colour and shape rigorously and governed *report grammar* — which is what this product almost entirely consists of — not at all: three report pages shipped in three days and each invented its own empty state, its own totals row, and (for two of the three) no error state whatever.

**Its one load-bearing rule is that the KPI strip does not render while loading or after a failure.** Both pages painted four stat cards *above* their `loading` guard, so a multi-second fiscal-year read showed "Capital in 90+ Day Stock: NPR 0" in green until the real number arrived, and on a failed read it stayed there. A number the page has not computed yet is not a number, and on a light-preset green it reads as a healthy one. `stats`, `note`, `filters` and `footnote` are all gated on `!loading && !error`. `banners` survives loading and the empty state — a provisional/period warning qualifies the whole page including its absence of data — but **not** a failed read, which is a correction made 2026-08-22/S601 after the first version of this rule shipped the other way. A banner is derived from state the caller set *before* the read, so ConsolidatedPnl's "Provisional — this period is still open… the statement is reliable once the period is closed" printed directly above this component's own "Nothing here is a real figure — this is a failed read": two contradictory sentences on one screen, one of them asserting a statement exists.

**The could-not-load state is deliberately not the empty state.** `.report-error` is a red-bordered card with `role="alert"` that says the figures are not real, where `.empty-state` says there is nothing to show — different facts, and only one of them means the page can be trusted. A failed read rendering as a clean zero is worse than a crash: a crash gets reported, a zero gets believed.

**What "every report renders inside it" actually means, measured (2026-08-26/S613).** Three pages render the full `ReportPage` shell; ~30 report pages render its *grammar* by hand — the shared `ReportLoadError` card (extracted from this component in S612 precisely so a pre-shell page could adopt the failed≠empty rule without a structural rewrite), `firstError`, `NoPeriodState`, and the strip/note/filter gating. **That is the supported state, not a migration debt**: the doctrine is mandatory, the wrapper is optional. A page that renders the grammar by hand must gate its own `stats`/`note`/`filters` on `!loading && !error` — a rule the wrapper enforces for free and a hand-rolled page can forget, which is why a new report page should still start from `ReportPage` unless it has a shape the shell cannot express.

### Report pages are one dialect, till screens are another (settled 2026-08-26/S613)

POS's four **report** pages (`SalesReport`, `CoversReport`, `KotLog`, `PosExceptionReport`) had grown their own grammar — an inline-styled `h2` where every other page opens with `page-title`, hand-rolled KPI tiles instead of `stat-grid`, a third tab family, and mouse-only `<tr onClick>` drill-downs. That was drift, not a decision, and it is now converged: a report is a report whichever module it belongs to, because the person reading it is the same owner or accountant, arriving with the same expectations, often on the same afternoon.

**The till screens are the deliberate exception.** `PosOrders` and `KitchenDisplay` are `position: fixed` full-screen layers with their own idiom — big touch targets, no sidebar, no page header — because they are operated on a busy floor at arm's length, not read at a desk. Their `Modal` usage needs its own `zIndex` for exactly this reason (see Components). Do not "converge" them.

### The phone is a supported reporting surface (settled 2026-08-26/S613)

`.stat-grid` is `repeat(auto-fit, minmax(180px, 1fr))` and reflows on its own. Twenty-five report pages had been overriding it inline with `repeat(N, 1fr)` up to N=6 — **an inline style outranks every media query**, so a phone rendered six crushed KPI columns on precisely the pages an owner checks between services. All removed; the desktop rendering is unchanged because auto-fit lands on the same column count at desktop widths.

The rule that follows: **never pin a fixed column count on a KPI strip.** If a row genuinely needs a different density, add a named variant to `Layout.css` (as `.stat-grid--compact` and `.dash-3col-*` already are) so it carries its own breakpoint, rather than an inline override that has none. Entry surfaces (Stock Count, POS) were already phone/tablet-first; this settles the reporting half.

### Data Tables (signature component)
Dense, functional, and the component most of the product's screens are actually built around. Column headers are 11px uppercase labels at wide tracking; rows are 13px body text with a light bottom border between them (no border on the last row); row hover applies a barely-there tint (`table-hover`, 2-8% alpha depending on theme) rather than a solid highlight. Wide tables always live inside a horizontal-scroll wrapper rather than compressing columns to fit - the data stays legible at native width instead of getting cramped to avoid a scrollbar.

**Row actions belong on the row.** A table whose rows can be acted on carries a right-aligned, `white-space: nowrap` Actions column of `.btn-ghost` buttons at 11px, tinted with the semantic color of what they do (green approve, red reject/delete) rather than filled. `LeaveManagement.jsx` is the reference implementation. The failure mode this prevents is real and shipped twice: putting the only actions inside a detail panel rendered *below* the table means the distance between "the row I decided about" and "the button that acts on it" grows with the list, so a 20-row approval queue becomes 20 round trips to the bottom of the page.

**The totals row and lining figures are the table's own, not the call site's** (added 2026-08-19/S594). `.data-table tfoot td` carries a 2px top rule, 700 weight and no bottom border, and suppresses the row-hover tint — a totals row is not a data row. Until S594 `tfoot` had **no rule at all**, so every totals row in the product was hand-styled where it was written, and three report pages built in the same week produced three different treatments. `font-variant-numeric: tabular-nums` now sits on every `.data-table td` and on `.stat-value` for the same reason: Poppins' default figures are **proportional**, so a right-aligned currency column does not line up digit-for-digit, and one page had independently discovered the fix inline while every other currency column in the product stayed ragged. Only digits are affected; text cells are unchanged.

**`.data-table--sticky-first` is opt-in, for a matrix whose first column is the row label.** Consolidated P&L with one column per outlet is the case it was built for: inside `.table-wrap`, scrolling right to reach the last column scrolls the labels away, leaving the reader matching numbers to remembered row order. A sticky cell needs an opaque background (`var(--theme-card)`) or the scrolling columns show through underneath it — the same requirement `Stock.js`'s Summary tab already documents.

**Never put `role="button"` on a `<tr>`.** The role *overrides* the row's implicit `row` role, which takes it out of the table's structure: a screen reader stops associating that row's cells with their column headers, so every figure in it loses the label that gave it meaning. On a table of currency columns that is the entire content.

The control belongs **in a cell**, as a real `<button>` — the row keeps its header associations, the button is natively focusable and operable, and no `onKeyDown` has to re-implement Enter/Space. `RowDisclosure` (`src/components/RowDisclosure.jsx`, added 2026-08-19/S595) is that button: it takes `expanded`/`onToggle`/`label` and an optional `controls`, sets `aria-expanded`, and `stopPropagation()`s so the row's own `onClick` — which every one of these tables already had, and which still works — cannot double-fire against it. `controls` is deliberately optional: `aria-controls` needs exactly one element id, and Supplier Price Tracker's detail is *many* sibling `<tr>`s, so pointing it at the first would assert something untrue about the rest.

**The history is the reason this paragraph exists at all.** The rule was carried in `.impeccable/design.json`'s don't-list and **only** there — it had never been written into this file. So nothing a human or an agent actually reads said it, and it was copied forward into four tables: `SupplierPriceTracker.js`, `OutstandingPayables.js`, `VendorReport.js`, and then `SupplierContribution.js` on 2026-08-19/S594, by an accessibility fix reaching for the incumbent shape in good faith — trading a mouse-only row for one that no longer announced its own columns. All four moved to `RowDisclosure` in S595. **A rule that lives only in the machine-readable sidecar is a rule nobody reads**; if it belongs to the system, it belongs in this file's prose.

**A cell holding two things collapses first, and the auto layout decides that, not you** (added 2026-08-27/S614). `table-layout` is `auto`, so a column's width is bid for against its neighbours — and a neighbour carrying `white-space: nowrap` always wins. The Purchases bill list is the reference case: its Item cell holds the item name *and* its category badge, the Vendor cell beside it is `nowrap`, so the Item column was the one squeezed — a two-word name broke over two lines with the badge dropping onto a third, and the row stood three lines tall to show one line of figures. **The fix is `nowrap` on the unbreakable ATOM, not a width — and not the whole cell** (corrected 2026-08-30/S646). Same failure with no second element at all — a Day cell holding `2026-08-17` collapsed to the widest *unbreakable fragment*, `2026-`, and broke the date at every hyphen. But a cell holding a name *and* a badge takes the nowrap on the name only; pinning the cell makes the badge unbreakable too, for no reason.

**Which column absorbs the squeeze is a decision, and text is the only honest candidate** (added 2026-08-30/S649). S646 elected the Item column because its category badge could drop to a second line, and the reported screen still sliced the Del button: with the badge removed the *names* were the wall — a real "BHAT BHATENI CHICKEN SAUSAGE" is 239px of unbreakable text, "Bhat Bhateni Super Market" 186px. Sample data taken from a screenshot measured 1030px min-content where invented data had measured 912, which is the lesson on its own: **measure with the longest values the client actually has.** Both names now wrap and everything else in the row stays `nowrap` — a day, a figure, a unit, an invoice ref, an expiry and a button are each things a line break corrupts or cuts, and a name is not. A word stays atomic, so a name never breaks mid-word. No horizontal scroll from 1152px up, the Actions column holds its full width at every size, and nothing wraps at all at 1440+.

**A table where every column is `nowrap` can only overflow** (added 2026-08-30/S646, the fix above is what caused it). Each nowrap is individually right, but they accumulate — and `.data-table th` is `nowrap` **globally**, so every header is load-bearing width too. The same Purchases bill list reached nine columns with not one able to give width back: min-content **1134px against 1086px of room at a 1440px window**, so it had been overflowing at every ordinary desktop size and needed 1382px before it fit at all. Three rules come out of it. **A table needs at least one column that can absorb the squeeze**, chosen rather than discovered — the widest text column, with the nowrap pushed down onto the fragment that genuinely cannot break (Item went `nowrap` → `normal` with the name in a nowrap span: the name never breaks, the badge drops to a second line only when there is no room). **A long header is a column width, and it may be two lines** — `Bill Total (incl. VAT)` cost 150px to label 75px figures; a `display: block` child inside the `th` breaks the line despite the inherited nowrap, so nothing has to be deleted to halve the column. The same trick moves supporting detail off a body cell's single line (`#3066 · 5 items` under a vendor name rather than trailing it: 223px → 122px). And **measure it** — every figure here came from the real `Layout.css` and a representative row rendered headless and queried for `scrollWidth` vs `clientWidth` per viewport. A table that fits on the machine it was built on says nothing about the one it was reported from. Result: min-content 912px, rows unchanged at 52–56px.

**Row density is a table-level decision, made once.** The global `td` padding is 11px vertical; a table read as a dense ledger rather than a report of a dozen rows opts down through its own scoped class (`table.purchases-table`, 7px) rather than by hand per cell — a per-cell inline padding is the shape that leaves one row taller than its neighbours the first time someone adds a column.

### Day labels in a period-scoped table (added 2026-08-27/S614)
A Day column showing a bare `1` is legible only while the page header that names the month is on screen. Print the sheet, scroll past the header, or read it back a month later and the number says nothing. Every period-scoped Day column renders `formatBsDay(day, bsMonth)` from `src/utils/bsCalendar.js` — **"1st Bhadra"** — and `bsDayOrdinal(day)` alone where the month is already stated beside it.

It is deliberately **not** the full-date form (`1 Bhadra 2083`, what `DemandForecast` and the pickers render): this one names a day *inside the period you already chose*, so it carries no year, and the ordinal is what marks it as a day rather than a count. Two behaviours are load-bearing: an absent or out-of-range month **degrades to the bare ordinal rather than naming the wrong month**, and day 0 (Sales' Bulk-entry sentinel) returns `''` so each caller keeps its own dash. Excel exports keep the **numeric** Day column — text breaks a spreadsheet's sorting and filtering, and the letterhead already states the period.

**Expanding a row shows detail in place, directly beneath it** — a `<tr className="detail-row">` with a full-width `colSpan` cell, never a panel appended after the table (added 2026-08-12, `TadaClaims.jsx`). Two cascade notes, because both bit on the first implementation: `table.data-table tr:hover td` is a *descendant* selector, so without the two `.detail-row` overrides in `Layout.css` hovering an expanded detail tints its own cell **and** every cell of any table nested inside it, lighting the whole panel up as though it were one hoverable row. And if the parent row toggles the expansion on click, every control inside the row must call `stopPropagation()` or acting on the record also collapses the panel you were reading.

## Motion

Motion is functional here, not expressive: this is an Operate surface, so it acknowledges an action, explains a state change, or preserves continuity — and otherwise stays out of the way. There is no page-load choreography anywhere in the app, and adding some to a data screen would be a regression, not a polish pass.

### Tokens

A closed set of four, defined in `Layout.css`'s `:root` (added to the system in stages — `--motion-fast`/`--ease-standard` with the 2026-07-12 sidebar rewrite, `--motion-slow`/`--ease-entrance` on 2026-08-11 when `ChartCard`'s expand sequence needed a second, genuinely different role):

- **`--motion-fast` (160ms) + `--ease-standard` (`cubic-bezier(0.4, 0, 0.2, 1)`)** — a state change *in place*: hover, active, focus, a nav item lighting up. Symmetrical curve, because nothing is arriving or leaving.
- **`--motion-slow` (260ms) + `--ease-entrance` (`cubic-bezier(0.16, 1, 0.3, 1)`)** — something *arriving* that wasn't on screen: a modal panel, a stat pill resolving in. The near-flat tail reads as settling rather than stopping.

Anything longer than `--motion-slow` on a working screen reads as latency, not motion. Exit faster than entrance, or instantly — a dismissal that makes you wait is worse than one that just happens.

*This prose is the normative source for motion. The machine-readable copy lives in `.impeccable/design.json` under `extensions.motion`, not in this file's frontmatter — the DESIGN.md schema has no top-level `motion:` group, so a copy up there is silently invalid. See the note above the `components:` key.*

### Named Rules

**Every animation must be switch-off-able by `prefers-reduced-motion`, which means it cannot be an inline style.** Inline `style={{ animation }}` beats any stylesheet rule, so a media query cannot reach it — the animation is then unconditional for every user regardless of their OS preference. `ChartCard`'s expand sequence shipped this way and went unguarded until 2026-08-11. Put animations in a class; put the class in the reduced-motion block at the foot of its section in `Layout.css`.

**Recharts is a second motion system that shares none of these tokens, on purpose.** It interpolates SVG attributes in JavaScript, so no CSS rule — including the reduced-motion guard above — reaches a chart series. Every series goes through `src/shared/chartMotion.js` instead, which is the *only* place the reduced-motion gate for charts can live. It cannot use `--ease-entrance`: Recharts accepts only `ease|ease-in|ease-out|ease-in-out|linear`, and a `cubic-bezier()` there is invalid. The two systems are aligned on duration band (450ms series vs 260ms shell) and deliberately not on curve.

**Stagger describes a list, or it is decoration.** The only staggered sequence in the app is `ChartCard`'s expanded stat strip (`.chart-stat-strip`, three steps at 60/105/150ms) — a row of peers that genuinely appears as a row. Cap the total delay; a stagger that outlasts the container it rides in on reads as the UI being slow. Do not reinterpret scrolled sections, table rows, or card grids as staggered lists.

**One accepted exception, unchanged:** the sidebar collapse animates `width`/`margin-left` (layout properties) rather than `transform`. See Navigation for why — `.sidebar-wrap` is `position: fixed`, so real space has to be reserved, and the animation fires only on a rare manual toggle. The `/impeccable` hook flags both lines on every edit to `Layout.css`; they are correct as written.

## Do's and Don'ts

### Do:
- **Do** use the theme's `accent-text` token as the foreground on any accent-colored background - it changes per preset and a hardcoded color will fail contrast on at least one of the two presets.
- **Do** keep tonal alpha-tints (`table-hover`, `focus-ring`, badge backgrounds) at 2-18% opacity - enough to register as a state, never opaque enough to compete with real content.
- **Do** wrap every wide table in the horizontal-scroll container rather than shrinking columns.
- **Do** reserve the rationed 4th color (purple) for a genuine 4th/5th categorical need, not as a second accent.
- **Do** put labels above form fields, always - never a placeholder standing in for a label.
- **Do** give every status message a live region - `role="alert"` for errors, `role="status"` for confirmations. A message that is only *shown* announces nothing, and on a destructive surface that means no confirmation an action ran at all.
- **Do** use the `*-text` variant whenever a signal colour is set as `color:` — and check the ternaries, which is where about half the real sites are.
- **Do** keep a legend swatch identical to the series it labels, and let the adjacent label text carry the readable contrast.
- **Do** give any modal the full dialog contract: role, `aria-modal`, a labelled title, initial focus, a Tab trap, Escape, and focus restored to the trigger.
- **Do** disclose an estimate where it is read, inline and visible, not in a hover tooltip — a figure carrying a red/amber/green verdict has to say what it is built from.
- **Do** render a report's could-not-load state as its own thing, never as the empty state, and never above a KPI strip that is still showing zeros (added 2026-08-19/S594 — see Report shell).
- **Do** put a validation message under the box it names, with `aria-invalid` on the control and `aria-describedby` pointing at the message — one string for the whole form tells a screen-reader user that a save failed and never which control to fix (added 2026-08-23/S603 — see Inputs / Fields).

### Don't:
- **Don't** build dense, hierarchy-less layouts in the name of "fitting more in" - that's the legacy-ERP failure mode this product is explicitly positioned against.
- **Don't** reach for purple gradients, Inter-everywhere, or a templated hero-plus-three-cards layout - the generic-AI-SaaS look PRODUCT.md names directly as an anti-reference.
- **Don't** invent a stronger/different shadow to mean "important" or "premium." Card elevation (`--theme-card-shadow`) is now uniform policy across every card, not a decoration budget to spend more of - the floating-action and live-pulse shadows are the only two that still carry extra meaning (see Elevation).
- **Don't** hardcode white or black as text on an accent background - use the paired `accent-text` token.
- **Don't** use a second saturated brand color alongside Aged Brass on the same screen; if a fourth category is genuinely needed, that's what the rationed purple token is for. (No exceptions remain; Bright's colorful KPI badges were the only named one, retired with that preset in S607.)
- **Don't** build a multi-series chart palette from the semantic tokens — they are five *roles*, not five validated hues, and nothing measures them as a series set. Both earlier justifications have now expired (accent/purple being one hex died with those presets in S607; Light's `red`/`amber` ΔE 3.1 was fixed in S608), which is itself the argument: the tokens move for reasons that have nothing to do with series separation. Use the validated fixed-hex sets (`CHART_COLORS`, `COST_BREAKDOWN_COLORS`) and re-measure when you touch them — S608 found `CHART_COLORS` slots 3 and 5 at **ΔE 0.4** under deuteranopia, i.e. two identical lines on any chart with five or more series, and nobody had noticed.
- **Don't** dim a row with `opacity` to de-emphasise it; opacity multiplies through the text colour and takes it below AA. Label the state instead.
- **Don't** put `role="button"` on a `<tr>`. It removes the row from the table's structure, so the cells stop being associated with their column headers. Put a real `<button>` in the first cell (see Data Tables).
- **Don't** paint a verdict colour on a figure that has not settled yet — early in a period a lumpy-numerator ratio is arithmetic, not signal.
- **Don't** let a page compute a number it then shows before the read has returned. A KPI painted during load is a claim the page cannot yet support, and on a green token it reads as a healthy one.
- **Don't** signal a failing field with colour alone, and don't give it a styling hook separate from `aria-invalid` — the two drift, and a form that looks validated then reads as unlabelled.
- **Don't** put a `position: sticky` element in the body flow and assume it sticks — `index.css`'s `html, body { overflow-x: hidden }` makes body its own scrollport, and it had silently killed three of them. Give the page root its own scroll container and measure it (see Layout).
- **Don't** dim a disabled *field* the way a disabled button is dimmed. A button's label is a verb; a field's content is data, and a locked period's figures have to stay legible precisely because they can no longer be corrected — flatten the surface instead (see Inputs / Fields).
