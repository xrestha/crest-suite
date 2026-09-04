---
name: Crest Suite
description: Cost intelligence and HR for Nepal's F&B operators, in one instrument
colors:
  # The DEFAULT (Dark) preset, which is what `:root` in Layout.css paints before ThemeContext
  # hydrates. The product ships exactly two presets — Dark and Light — plus a `system` mode that
  # resolves to one of them. Where a token's Light value differs materially it is named in the
  # Colors prose below. Never resolve one of these to a literal in a component; read the token.
  aged-brass: "#c9a84c"
  aged-brass-hover: "#d4b96a"
  accent-text: "#0f1117"
  accent-ink: "#c9a84c"
  ink-bg: "#0f1117"
  ink-card: "#181c27"
  ink-sidebar: "#0e1117"
  ink-border: "#2a2f3d"
  ink-border-lt: "#1e2330"
  input-bg: "#0f1117"
  table-hover: "rgba(255,255,255,0.03)"
  focus-ring: "rgba(201,168,76,0.15)"
  focus-outline: "#c9a84c"
  text-primary: "#e8e0d0"
  text-secondary: "#9ca3af"
  text-tertiary: "#8a92a3"
  signal-success: "#34d399"
  signal-danger: "#f87171"
  signal-warning: "#fbbf24"
  signal-categorical: "#a78bfa"
  # On a dark preset every *-text variant resolves to its own base colour (`applyTheme` does
  # `t.greenText || t.green`), so these repeating is correct and not a redundancy to clean up.
  # They diverge only on Light, which is the entire reason the variants exist.
  signal-success-text: "#34d399"
  signal-danger-text: "#f87171"
  signal-warning-text: "#fbbf24"
  signal-categorical-text: "#a78bfa"
  # ── Print. None of the palette above survives onto paper (@media print forces white on black),
  # so the letterhead templates share one literal grayscale ramp for their ink/rule/label
  # hierarchy. It is a real, reused scale rather than per-file drift, and it has to be declared
  # here or every print template reads as a page of undocumented literals.
  print-ink: "#000000"          # headings, rule dividers (PurchaseOrders.js's #111 is this role)
  print-text: "#333333"         # body copy needing more weight than a label
  print-notes: "#444444"        # notes/callout box text
  print-label: "#555555"        # secondary meta lines (dates, addresses, PAN/VAT)
  print-label-lt: "#777777"     # field labels, table body secondary text
  print-muted: "#888888"        # uppercase section eyebrows, footer columns
  print-rule-strong: "#999999"  # bordered chips, e.g. a status pill outline
  print-faint: "#aaaaaa"        # generated-by footers, least emphasis
  print-rule: "#cccccc"         # table header/footer rules
  print-rule-lt: "#dddddd"      # notes-box border
  print-rule-xlt: "#eeeeee"     # table row divider
  print-fill: "#f3f3f3"         # table header row background
  # Recharts axis ticks, labels and reference lines. A literal because var() does not resolve in
  # an SVG presentation attribute — the same exemption the chart series palette relies on.
  chart-tick: "#6b7280"
  # ── The guest menu: bone and pine, the one surface a paying customer sees ────────────────────
  # A scoped token set, not a preset. `.guest-menu` re-declares the --theme-* properties for its
  # own subtree, so every shared class the page borrows re-skins from these. Nothing here may be
  # reached for from a staff screen. See the Colors prose for why it exists at all.
  guest-paper: "#F0EDE5"
  guest-ground: "#E7E3D8"
  guest-pine: "#004643"
  guest-pine-deep: "#00312F"
  guest-ink: "#1C1B17"
  guest-sage: "#4A5C58"
  guest-sage-lt: "#566762"
  guest-rule: "#D3CCBC"
  guest-control: "#4A7A75"
  guest-veg: "#4C7A2E"
  guest-nonveg: "#A63A2B"
  guest-success: "#2F6B2A"
  guest-warn: "#8A5A17"
  guest-danger: "#A03328"
typography:
  # The prose Hierarchy below names the nine roles a designer reasons in. This block is the
  # COMPLETE ramp, because it is also what tooling checks a literal against — measured across the
  # source, the scale in use is 9/10/11/12/13/14/15/16/17/18/20/22/24/32 and a size off it is
  # drift. Documenting only the readable subset is what turns a real tokenised size (the sidebar's
  # own --font-size-micro, --font-size-chevron) into a false "outside the type ramp" finding.
  display:
    fontFamily: "Poppins, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(24px, 3.4vw, 32px)"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.025em"
  figure-lg:
    fontSize: "32px"
    fontWeight: 700
  page-heading:
    fontSize: "20px"
    fontWeight: 700
  section-heading:
    fontSize: "18px"
    fontWeight: 700
  rail-icon:
    fontSize: "17px"
  touch-input:
    fontSize: "16px"
    fontWeight: 400
  card-heading:
    fontSize: "15px"
    fontWeight: 600
  subtitle:
    fontSize: "14px"
    fontWeight: 600
  micro:
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.08em"
  chevron:
    fontSize: "9px"
  wordmark:
    fontFamily: "Georgia, serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.04em"
  title:
    fontFamily: "Poppins, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.3
  figure:
    fontFamily: "Poppins, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.15
    fontFeature: "tabular-nums"
  body:
    fontFamily: "Poppins, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Poppins, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "0.04em"
  column-header:
    fontFamily: "Poppins, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    letterSpacing: "0.08em"
  mono:
    fontFamily: "source-code-pro, Menlo, Monaco, Consolas, Courier New, monospace"
    fontSize: "11px"
    lineHeight: 1.4
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.aged-brass}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.aged-brass-hover}"
    textColor: "{colors.accent-text}"
  button-ghost:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.signal-danger-text}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
  badge:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.ink-card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "24px"
  stat-card:
    backgroundColor: "{colors.ink-card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "20px"
  input:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
  select:
    backgroundColor: "{colors.input-bg}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  tab-pill:
    backgroundColor: "{colors.ink-card}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
  tab-pill-active:
    backgroundColor: "{colors.focus-ring}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
  period-scope:
    backgroundColor: "{colors.focus-ring}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  nav-link:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
  nav-link-active:
    backgroundColor: "{colors.focus-ring}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
---

# Design System: Crest Suite

## Overview

**Creative North Star: "The Lit Instrument"**

Crest Suite is an instrument a restaurant is run from, and it is lit by exactly one source. Aged
Brass is that light: it falls on the thing you are working in — the active route, the live table,
the period this report covers, the button that commits — and everything else sits in an unlit,
even charcoal. Depth here is not a stack of shadows; it is the difference between what the light
reaches and what it does not. On the signed-out pages that metaphor is literal (three warm radial
lights over an otherwise dead ground); inside the app it is disciplined down to a single accent
that never spends itself twice on one screen.

The instrument half is the constraint on all of it. Two people read the same figure: an owner
deciding between services, and an accountant who has to file on it. So a number is never dressed
up, never approximated for effect, and never coloured unless the colour is a verdict the product
is prepared to defend. Signal green, red and amber are reserved for that verdict and spent
nowhere else — a category, a rank, a delivery partner and a close type are facts, not judgments,
and they take brass or grey. Where a verdict is shown it carries a shape mark as well as a hue,
because roughly one man in twelve cannot separate the hues and every one of these screens gets
printed in monochrome eventually.

Density is deliberate and non-negotiable: 13px body, 11px column headers, tight table rows, 32px
page padding, no reading measure anywhere. This is a working surface, not a document. The softness
that keeps it from reading as legacy Nepali ERP comes from the radius scale (8/12/18/24px) and the
warm neutral ground, not from whitespace the data cannot spare.

**Key Characteristics:**

- One accent (Aged Brass), one rationed fourth-category hue (violet), four semantic signals.
- Two presets — Dark (default) and Light — plus a `system` mode that follows the device.
- Colour is never the only carrier: a band ships a `✓`/`△`/`▲` mark, a state ships a word.
- Flat, tinted chips over solid fills; a card's elevation is uniform policy, not a highlight.
- Five surfaces, one system: the app shell, the signed-out pages, the Crest Staff phone app, the
  guest menu and paper. They do not share a density or, in two cases, a palette — and they must
  not leak into each other.
- Every value is a `--theme-*` custom property, so the whole product re-tones from one place.

## Colors

Warm metal on cold ink. The palette is one brass accent over a near-neutral charcoal (Dark) or
warm white (Light), with four semantic signals held in reserve.

### Primary

- **Aged Brass** (`#c9a84c` Dark / `#b07d2b` Light): the product's only brand colour. It marks the
  active route, the live/occupied state, the primary action, a categorical tag and the period
  chip. Hover steps to `#d4b96a` / `#946720`.
- **Brass Ink** (`accent-ink`, `#c9a84c` Dark / `#7a561e` Light): the accent used **as text** — a
  link, an active nav item, a `.stat-value.gold`, a `.btn-linklike` in a table cell. On Light the
  base accent measured 4.45:1 as an active nav label: below AA, and *less* legible than the
  inactive items around it, which inverts the one signal that state exists to send.
- **Brass on Brass** (`accent-text`, `#0f1117` Dark / `#241a08` Light): the foreground that sits
  **on** an accent fill. Not interchangeable with `accent-ink` — this one pairs with a filled
  surface, that one is type on a normal ground.

### Secondary

- **Violet** (`#a78bfa` Dark / `#7c3aed` Light): the rationed fourth category, for the cases where
  green, red and amber are all spoken for and a fourth is genuinely needed — an "Updated" audit
  row beside Added and Deleted, the KOT station chip, the loyalty surfaces. It is not a second
  brand colour and never appears beside brass as a peer.

### Neutral

- **Ink** (`#0f1117` Dark / `#f6f3ef` Light): the page ground, and also the input well — a field
  is a recess in the card, not a raised object on it.
- **Card** (`#181c27` Dark / `#ffffff` Light): every surface that holds content. One tone lifted
  off the page on Dark; a distinct warm-white plane on Light.
- **Sidebar** (`#0e1117` Dark / `#ece6dd` Light): one step *darker* than the page on Dark, so the
  shell recedes behind the work rather than framing it.
- **Border** (`#2a2f3d` / `#ddd6cf`) is structural — card edges, the table header rule, input
  outlines. **Border Light** (`#1e2330` / `#ece6df`) is internal — row dividers, ghost button
  edges. They are not interchangeable (see Shapes).
- **Parchment** (`text1`, `#e8e0d0` / `#1c1917`): every figure, every table cell, every value.
- **Fog** (`text2`, `#9ca3af` / `#5c554e`): the secondary tier — labels, column headers,
  subtitles, `badge-gray`'s foreground. Measured 6.70:1 on the Dark card.
- **Slate** (`text3`, `#8a92a3` / `#6b655e`): the quietest tier — placeholders, stat labels,
  micro-captions, the empty state. Measured 5.45:1 on the Dark card.

  The ladder is parchment > fog > slate. Both lower tiers clear AA, so the ordering is *hierarchy*
  rather than accessibility — which is exactly why an inversion between them once survived every
  contrast audit unnoticed, with each quietest-tier hint outranking every secondary label.

### Signal colors

Four hues, each with a paired `*-text` variant. The base token is a **fill** (chart series, badge
tint, border, dot, a floor-tile strip); the `*-text` variant is **type**. On Dark they resolve to
the same value; on Light they diverge, and that divergence is the entire reason the pair exists.

- **Green** (fill `#34d399`; text `#137538` on Light): finished, and finished right.
- **Red** (fill `#f87171`; text `#8f2440` on Light): wrong, and it costs money or breaks a rule.
- **Amber** (fill `#fbbf24`; text `#a85200` on Light): open — something is still required of
  someone, right now.
- **Violet** (fill `#a78bfa`; text `#7c3aed` on Light): the rationed category, as above.

Two more colour-shaped tokens. `focus-ring` (`rgba(201,168,76,0.15)`) is a **tint** that doubles as
the active-state background for nav links, module tabs and rail buttons, so its alpha must stay
low — measured alone it composited to 1.15:1, 2.6x below WCAG 2.2's 3:1 floor for a focus
indicator. `focus-outline` is the solid 2px indicator that actually satisfies that floor. A new
focusable control pairs the two; the ring alone is not a focus indicator.

### The guest menu — a scoped palette, not a preset

The QR menu is the only surface in the product a paying customer ever sees, and it is the one
deliberate brand-facing exception in the system: **bone and pine**, a printed menu card rather than
a back-office instrument. It had to stop reading the global tokens for two reasons, and the second
is the sharp one — the theme is read from `localStorage` *before* the per-surface default applies,
so a phone that had ever opened the admin app rendered a restaurant's public menu in whatever
preset that staff member had picked. A restaurant's customer-facing surface was inheriting a
private staff setting.

`.guest-menu` re-declares the `--theme-*` properties for its own subtree, which wins over
`applyTheme`'s inline style on `<html>` (specificity only contests declarations on the *same*
element), so every shared class the page borrows re-skins with no change to `Layout.css` and no
possible leak into the admin app. Bone (`#F0EDE5`) is the paper the dish is read on and the ground
sits one step behind it, so a card lifts off the page the way a menu card lifts off a table; pine
(`#004643`) is rationed to brand, price, category and every call to action, at 9.17:1 against bone
— AAA in both directions. Body copy is a warm ink, not pine: **the ink does the reading, the colour
does the pointing**, which is how a printed menu actually works. Veg/non-veg stay green and red
because that is a market convention rather than a palette choice, retuned to sit on bone. Contrast
is measured on the **ground**, not the paper — the ground is the tighter of the two surfaces, and
measuring only the paper is how one role shipped at 4.39:1 reading as if it passed everywhere it
was checked. One inversion is deliberate and scoped: `--theme-border-lt` is the *stronger* rule
here, because it is what `.btn-ghost` borders with and every ghost button on this page is a control
a thumb must find. Do not carry that anywhere else.

### Named Rules

**The One Accent Rule.** Aged Brass is the only non-semantic colour on any screen. A second
"brand" hue is a mistake, not a design choice. This has been violated seven times by the same
undocumented indigo (`#60a5fa` / `#818cf8`), most instructively as a drifted `var()` **fallback** —
`var(--theme-purple, #8b5cf6)` reads as correct because the token name beside it is correct, and it
only paints in the instant before hydration, which is precisely when nobody is looking. Check the
fallback half of a `var()` as carefully as a standalone literal.

**The Text-vs-Fill Rule.** If the colour is text, use the `*-text` variant; if it fills, use the
base token. The `.badge-*` classes already do this, so anything using them gets it free — the
alpha tint stays the base colour and only the foreground changes. Three things the variants must
**not** be applied to: a fill, a chart series, and a border.

**The Accent-Text Pairing Rule.** Any element with an accent-coloured background takes
`accent-text` as its foreground, never a hardcoded `#fff` or `#000` — a hardcoded foreground
silently fails contrast on one of the two presets. Treat any `#000`/`#fff`/`white`/`black` sitting
next to `var(--theme-accent)` as a near-certain instance of this bug on sight.

**The Signal Separation Rule.** Two signal colours a reader compares must stay distinguishable
**without hue**, measured under deuteranopia (~6% of men) and protanopia (~2%), not judged by eye.
Light's danger and warning text shipped at ΔE 3.2 — one colour for a red-green colour-blind
reader — and were retuned to `#8f2440` / `#a85200`, the only pair of 120 searched that clears both
axes while every variant still holds 4.5:1 on card and page. Tritanopia is deliberately not
chased: separating on the blue-yellow axis fights separating on red-green, and it is ~0.01%
against ~8%.

**The One Signal Meaning Rule.** A signal colour carries exactly one meaning across a module, and
a category never takes a signal colour at all. The vocabulary is written down twice — HR's
`HR_REQUEST_STATUS` / `TADA_REQUEST_STATUS` (`payrollConstants.js`) and POS's `posSignals.js` — and
both say the same thing: **amber** = open, waiting on a person; **brass** = decided but the money
has not moved, plus every plain category (a rank, a close type, a table state, a period);
**green** = closed and good; **red** = closed and refused, or wrong and expensive; **grey** = inert
or a plain identity. Before this was one file, "Pending" was brass on two HR queues, grey on a
third and amber in the employee app, and amber alone carried eight distinct meanings across POS —
including "Foodmandu" and "supervisor". A button is exempt: it is an instruction, not a verdict, so
the Void button stays red while the *record* it writes reads as a close type in brass.

**Loudness tracks demand for action, not importance.** The loudest mark on a POS floor tile used to
be "Occupied" — a full table, the outcome you want — while "you have not fired these three dishes"
was a thin pill. A tile's 6px strip now answers the one question a waiter crossing the room cannot
answer with their own eyes (`tableStripColor`), and a kitchen card's strip carries lateness rather
than the stage it is already sorted into (`ticketStripColor`).

**The Chart Palette Rule.** Chart series never come from the semantic tokens — they are five
*roles*, not five validated hues, and nothing measures them as a series set. Use the fixed literal
palettes (`CHART_COLORS`, `COST_BREAKDOWN_COLORS`; `var()` does not resolve in SVG presentation
attributes anyway) and re-measure when you touch them: `CHART_COLORS` carried a **ΔE 0.4**
deuteranopia collision between two of its eight slots — two identical lines on any chart with five
or more series — from the day it was written until it was measured. Prefer **encoding a
relationship over adding a hue**: a projection shares its metric's colour and is distinguished by a
dash; a derived total reads as a dashed composite, not a fifth peer.

**A banded ratio has one definition, marks included.** Food Cost % bands through `fcBand(pct,
settings)` and variance through `varianceBand()` (`shared/imsFormulas.js`); Labour Cost %, Prime
Cost % and Net Margin % through `lcBand` / `pcBand` / `nmBand` (`shared/operatingBands.js`); staff
rank through `STAFF_LEVEL_BADGE` (`shared/staffLevelBadge.js`). Never a local threshold — Labour
Cost was banded three ways at once, so a day at 34% read "fine" on the roster board and "watch" on
both dashboards. `fcFigure()` / `bandFigure()` return the number **with its mark already
appended**, specifically so a call site cannot take the colour and drop the `✓`/`△`/`▲`. Those
marks separate by fill rather than hue, so they survive greyscale and a monochrome print. A figure
a person reads and acts on carries the mark; a chart axis or a sparkline may take colour alone.

**Signal polarity is per metric.** A figure compared against a target is coloured by whether it
moved in the *good* direction for that metric, not by which side of the line it landed on.
Purchases running under the spending pace is the outcome you wanted; painting it red because the
arrow points down is a lie told in the one colour the owner trusts most. Keep `▲`/`▼` literal so
shape agrees with the line on screen, and invert the colour per metric.

**Brass is a range, not one value, on the signed-out pages.** `Login.css` derives every colour on
the page from `--theme-accent` by `color-mix` — a wash (6%), a tint (12%), a rule (24%), an edge
(80%), and the three light layers at 34/17/11%. That is the One Accent Rule taken literally: no
second hue anywhere, only more and less of the one that was already there.

## Typography

**Body Font:** Poppins (Google Font, 400/500/600/700 + italic 400), falling back to
`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`.
**Signature Font:** Georgia, serif — the wordmark, the two full-page interstitials (`PremiumGate`,
`SubscriptionLock`), the guest menu's brand line, and every print letterhead (gate pass, purchase
bill, PO, recipe cost card, vendor balance confirmation).
**Mono:** `source-code-pro, Menlo, Monaco, Consolas, "Courier New", monospace` — scoped to `<code>`
and to `.action-error-detail`. Monospace is for code, data and measurement here; it is not
available as a "technical-looking" costume.

**Character:** A restrained geometric sans for every working surface, interrupted by a serif that
only ever appears where the product is speaking as itself rather than showing you your data.

### Hierarchy

- **Display** (800, `clamp(24px, 3.4vw, 32px)`, 1.1, `-0.025em`): the signed-out hero headline.
  The only place in the product with a fluid type size. **Its line breaks are authored, not left to
  the measure** (S667): the headline is block spans, one per line, with `text-wrap: balance` on the
  remainder. Unforced, a 375px phone broke it after "the" — an orphaned article reads as a mistake
  rather than as a clause, and at this weight and size the break is as visible as the words. Break
  the line before shrinking the type; the type size here is load-bearing against a measured
  viewport budget.
- **Wordmark** (Georgia 700, 16px sidebar / 20px signed-out, 1.2, `0.04em`): the client's own
  white-labelled brand name. This is the customer's identity, not ours.
- **Title** (600, 22px): `.page-title`, one per route.
- **Figure** (600, 24px, 1.15, tabular): `.stat-value` — the headline number on a KPI card. The
  line-height is explicit because inheriting body's 1.5 puts a 24px numeral in a 36px box, so the
  8px and 4px margins the class declares are never the intervals that render.
- **Body** (400, 13px, 1.5): table cells, buttons, inputs, selects, `.page-subtitle`, prose.
- **Label** (500, 12px, `0.04em`): field labels, `.tab-btn`.
- **Column header** (500, 11px, `0.08em`, uppercase): `.data-table th`. Also the badge size.
- **Stat label** (11px, `0.1em`, uppercase, slate): the caption over a KPI figure.
- **Micro** (10px): non-interactive captions only — the brand subline, a sidebar group label.

### Named Rules

**The Signature Serif Rule.** Georgia never sets a heading, a callout or emphasis inside a working
screen. It appears where the product speaks in its own voice — a wordmark, a gate that has taken
the whole viewport, a document printed on letterhead — and nowhere else. One serif on a screen is
a signature; two make it an affectation.

**The Brand Lockup Rule.** The mark and the wordmark name the same brand, or neither is shown. All
four surfaces that draw the lockup — the sidebar and the three signed-out pages (`/login`,
`/pricing`, `/reset-password`) — resolve both halves from one source: `settings.logo_url` if the
client has uploaded a mark, Crest's `Hexagon` in the accent if not, beside
`settings.app_name || 'Crest Suite'`. 26px on `/login` and `/reset-password`, 22px in the sidebar
and on `/pricing`, `objectFit: contain` on a 4px corner. Only the sidebar carried that conditional
for its first year; the public pages drew Crest's hexagon unconditionally *while naming the client*,
so a white-labelled operator met their own name beside somebody else's mark on the page they log in
through — and on the page a password-reset email lands them on, where a mismatched brand reads as a
phishing tell rather than as a bug (S606, fixed S667). **The mark is always `alt=""` and
`aria-hidden`**: the wordmark beside it already names the brand, and a labelled mark announces it
twice. Product names are not the client's to rebrand — Pricing's plan names stay "Crest IMS" and
"Crest HR".

**Form controls do not inherit `font-family` and must be told to.** Every browser substitutes its
own UA default into `<input>`, `<button>`, `<select>` and `<textarea>`. Measured before the single
rule in `index.css` existed: all 14 controls on the login page, all 13 pricing CTAs and **every
`.btn` in the product** rendered in Arial — the product's typeface reached its prose and none of
its controls. `optgroup` is in that selector list because Firefox styles it separately from
`select`. Do not re-add per-class `font-family: inherit` patches.

**Numbers are tabular.** Poppins' default figures are proportional, so a right-aligned currency
column does not line up digit for digit and a page of money reads ragged. Every
`.data-table` cell, every `tfoot` cell and `.stat-value` carry `font-variant-numeric: tabular-nums`
from one rule. Only digits are affected; text cells are unchanged.

**No interactive control below 12px.** Chips and buttons in dense list rows sit at 12–12.5px with
5–7px of vertical padding. 10px is for genuinely non-interactive micro-labels.

## Layout

**The shell is a fixed sidebar plus a flowing content column.** `.sidebar-wrap` is
`position: fixed` at 240px (56px collapsed) and `.main-content` reserves that space with a matching
`margin-left` on the same two values; the two animate in lockstep. Content padding is 32px on every
page and nothing is centred in a reading measure — every screen here is a working surface rather
than a document.

**Spacing rhythm is a 4/8/16/24 scale, applied by convention rather than by token.** There are no
`--spacing-*` custom properties, so the scale lives in the frontmatter and in usage. 16px is the
default gap between peers (grid gaps, button rows, field stacks); 24px is `.card`'s internal
padding and the gap between major sections; 28px is the standing bottom margin under a
`.page-header` and a `.stat-grid`; 8px and 4px are chip-level and intra-control. A value off this
scale in new work is drift, the same way an off-ramp font size is.

**The page root takes no padding of its own, and the header is `.page-header`.** `.main-content`
already owns the 32px; a page that adds its own doubles it. `.page-header--split` is the
title-block-left / actions-right shape that ~50 of the 78 header sites were hand-rolling inline,
and it carries two properties neither hand-rolled version had complete: `flex-wrap` and the mobile
hamburger clearance. Measured at 390px, an unclassed header put 40x33px of the fixed hamburger
*over* the title — `elementFromPoint` at the title's first character returned the button — while a
no-wrap header squeezed that title from 298px to 154px and one carrying a period `<select>`
overflowed its container by 29.7px into the clip from `html { overflow-x: hidden }`.

**KPI rows are auto-fitting grids, not fixed columns.** `.stat-grid` is
`repeat(auto-fit, minmax(200px, 1fr))` with a 16px gap, so four cards reflow to 2x2 and then to one
column without a media query. The 200px floor is set by what a card *holds*, not by taste: at 24px
/700, a Nepali-grouped `NPR 12,48,650` is 13 characters and wraps below ~200px — measured wrapping
at 1280px, 900px, 414px and 430px, i.e. on an ordinary laptop, a tablet and the two commonest large
phones. Shrinking the figure to 20px also fixes it and was rejected: it de-emphasises the headline
number on every KPI in the product to solve a grid problem. Raise the floor, never let the value
wrap.

**One breakpoint: 768px.** No tablet tier and no desktop max-width. Below it the sidebar leaves the
flow entirely (`translateX(-100%)` plus a 44px fixed hamburger and a 55%-black overlay),
`.main-content` drops its reserved margin and takes 16px padding, and every multi-column dashboard
grid collapses to one column.

**Touch sizing is scoped to the input method, not to a width.** `@media (pointer: coarse)` gives
`.btn` 44px and tunes every control down from there — `.sidebar-link` and `.module-tab` 44,
`.btn-sm` / `.tab-btn` / an in-table `.btn` 32, the chart controls 44x44 — plus the shell controls a
finger actually hits, which were in no coarse rule at all until they were measured (the outlet
switcher, the control that re-scopes the whole tenant session, at 95x20px; sidebar search at
27x25). A narrow desktop window keeps its own density, which a width breakpoint could not express.

**Under a coarse pointer every text field goes to 16px, with `!important`, and that is load
bearing.** Below 16px iOS Safari zooms the viewport on focus and never zooms back, so tapping any
field turned "enter the quantity" into "now pan sideways to find Save" — and the POS till and the
stock count are tablet surfaces by design. The `!important` is not laziness: 266 form controls
across 46 files set their font-size in an inline `style` object, and no selector beats an inline
style, so without it the rule would close the gap for the controls that least needed it and skip
every one that did. Checkbox, radio, range, colour, file and the button-shaped input types are
deliberately excluded. A control on a class is still the better answer — it also wins the
`[aria-invalid]` and `:disabled` hooks — but the floor must not wait on that sweep.

**Wide tables scroll; they do not compress.** `.table-wrap` is `overflow-x: auto` around every wide
table and the data keeps its native column widths. Pair it with `.table-wrap--fab-clear` on any
page that also renders a `Fab` — the Fab is fixed with no reserved space, so without it the button
sits on top of the last row's actions.

**A page that renders into the body flow needs its own scrollport.** `index.css` sets
`html, body { overflow-x: hidden }` as an app-wide horizontal guard; because html's overflow is
then not `visible`, body becomes its own scroll container sized to its content and a
`position: sticky` child of the body has a scrollport that never scrolls. Every screen inside the
app shell is immune because the shell scrolls its own div — the exceptions are the pages that
render directly into the body (`/login`, `/pricing`, the guest menu), and all three had a sticky
bar that had never once stuck. Measured at 390x780, `.login-nav`'s viewport `top` went
0 → −250 → −600, moving 1:1 with the content. The fix is per page: `height: 100dvh; overflow-y:
auto; overscroll-behavior: contain` on the page root, **and delete the `min-height: 100vh` it was
carrying**. Use `dvh`, not `vh` — on a phone `100vh` is the tallest the viewport ever gets, so the
fold lands under the URL bar.

### The Crest Staff phone app

`/hr/self-service` is a second, installable PWA at a different altitude: a phone held one-handed by
someone checking whether they work tomorrow. Everything is scoped under `.self-service` and
**nothing may leak into the admin app**, whose ~36px table rows would be inflated by these floors.

- 44px minimum on every `.btn`, `.tab-btn`, input, select and textarea — a flat floor, where the
  app shell tiers its controls and leaves `.tab-btn` at 32px. This surface is 100% touch.
- 16px on every field here too, and **an inline `fontSize` beats this rule** (it carries no
  `!important`, unlike the app-wide floor), so any control that sets its own size must set 16 too.
  Pinning the viewport with `maximum-scale` is the wrong fix and is deliberately absent from
  `index.html` — it blocks pinch-zoom for everyone.
- Its own type scale, not the desktop scale with bigger buttons: an 11px badge that reads fine in a
  desktop table is a squint at arm's length.
- It defaults to `system` (the device's own light/dark setting), because a self-service account is
  bounced away from every admin route and can never reach Settings → Appearance.

### Print

Paper is a real output here — stock count sheets, payslips, purchase bills, KOTs, gate passes,
recipe cost cards, POs — and none of the palette survives onto it. `@media print` forces a white
ground and black text, strips the sidebar and every `button`, flattens `.card` and `.stat-card` to
a 1px `#ccc` rectangle with no radius and no shadow, and normalises every cell to 12px with a
`#ccc` rule. Two print-only affordances: `.print-blank-input` prints the box and neither its value
nor its placeholder (Chrome prints placeholders as if they were values), so a sheet can be handed
over and filled in with a pen; `.print-hide-row` prints only the rows a user checked. Letterhead
documents set Georgia and their own grayscale ink ramp rather than reading theme tokens.

**The print reset targets the CELL, which is why a supporting line needs `.cell-sub`.**
`@media print` sets `th, td { color: black !important }` — inheritance, so any descendant `<span>`
carrying its own colour inline **wins** and prints in theme ink on white paper. Every secondary line
inside a table cell in this product was inline-styled that way, so none of them had ever printed
legibly, and nobody had noticed because nobody had printed from a dark preset. `.cell-sub` is the
class for that line and carries its own print override. Do not reach for the tempting
`th *, td * { color: black }` — it would flatten every deliberately-coloured figure inside a cell
across every printed report.

### Named Rules

**The Auto-Fit-First Rule.** Reach for `repeat(auto-fit, minmax(<floor>, 1fr))` before declaring a
column count. A fixed count is a claim that the grouping matters at every width; if it does not,
the fixed count is just a media query you now have to maintain.

**The Measured-Floor Rule.** When a row of chips or badges repeats down a list, give each a
`minWidth` taken from the **measured** widest real label plus `textAlign: 'center'`. Content-width
chips vary on incidental things — `IMS · Starter` is wider than `IMS · Pro` — so every column
anchored after them slides from row to row. Measure with `getBoundingClientRect().width` rather
than guessing.

**A scroll container's clearance is margin, never padding.** `.table-wrap--fab-clear` reserved its
88px with `padding-bottom` for a year: inside the scroll container, so the horizontal scrollbar
rendered 88px *below* the last row — off the fold on any table long enough to scroll the page, and
with Windows' overlay scrollbars not on screen at all. A too-wide table therefore did not read as
scrollable, it read as content sliced off at the right edge. Generalise it: **any padding on an
`overflow: auto` element pushes its scrollbar away from the content it scrolls.**

**`space-between` on two controls in a wide container is an anti-pattern.** It does not distribute,
it banishes — two 10px buttons at opposite ends of a 1000px card with dead space between. Group
related controls with a `gap` and let the container's alignment place the group.

## Elevation & Depth

Depth is carried primarily by **background lightness**, with shadow as a secondary, per-preset
layer on top. A card is one tone lighter than the page (Dark) or a distinct surface tone from it
(Light) — that is the main cue, especially on Dark where a literal black shadow would be nearly
invisible against an already near-black ground. Every preset then adds a real `box-shadow` through
its own `--theme-card-shadow`, generated from that preset's `bg`/`text1` rather than a flat black:
Dark layers an inset top highlight with two soft drops, Light uses a tight contact shadow plus one
diffuse drop.

Card elevation is **uniform policy** — every preset, every card — so it is not a budget to spend
more of on something important. Only two shadows still carry extra meaning: the `Fab`'s
`0 6px 20px rgba(0,0,0,0.45)`, which lifts a fixed control off scrolling content, and the guest-order
pulse, which is an alarm rather than a depth cue.

### Shadow Vocabulary

- **Card** (`var(--theme-card-shadow)`): every `.card` and `.stat-card`. Per preset, never
  hand-written.
- **Floating action** (`0 6px 20px rgba(0,0,0,0.45)`): the `Fab` only.
- **Focus** (`0 0 0 2px var(--theme-focus-outline), 0 0 0 5px var(--theme-focus-ring)`): a solid
  indicator inside a soft ring. This is the standing pair for every focusable control.
- **Live pulse** (`0 0 0 0 → 0 0 0 6px rgba(251,191,36,0.5→0.18)`): a guest QR order waiting to be
  accepted. Amber, because a submitted guest order is waiting on a person.

### Named Rules

**Shadow tells you what surface you are on, not that a page is polished.** Do not invent a third
meaning — a stronger shadow for "important" or "premium". If something needs to stand out, that is
a job for the accent colour or for position.

**The signed-out surfaces carry a light source; the app does not.** `/login` and `/pricing` are lit
by three brass radial layers on the scrollport itself — a key breaking over the sign-in card's
top-right shoulder, a rim grazing the right edge, a weak bounce lifting the pitch column out of
flat black. Two things there were measured rather than guessed. **Radii are percentages of the box,
not pixels**: in px the rim was 680px wide, which on a 390px phone is nearly two screens across —
it stopped being a rim and flooded the lower half of the page. And a fourth "shade" layer mixing
toward `--theme-sidebar` was removed because on Dark it was mathematically inert (`#0e1117` over
`#0f1117`), spending half the depth budget on nothing. **Unlit ground is the shadow here.** Do not
carry any of this into the app: a dense table under an atmospheric wash is worse than one on a flat
card.

**The one authored moment on the login page is a state, not an entrance.** The card's top edge
highlight widens and brightens on `:focus-within`, so it tracks what the user is actually doing
instead of playing once on load and never meaning anything again.

## Shapes

**Six radius steps, and they are a closed set:** 4px (`--radius-xs`, micro-elements only), 8px
(`--radius-sm`), 12px (`--radius-md`), 18px (`--radius-lg`), 24px (`--radius-xl`), 999px
(`--radius-full`). Radius does not vary per preset — the shape scale is theme-invariant while
colour and shadow are not.

**Radius tracks the element's size class, not its importance.** Chip-sized things take `sm` (badges,
small icon buttons); control-sized things take `md` (buttons, inputs, selects, tab pills, nav
links); surface-sized things take `lg` (cards, stat cards, table containers); `xl` is for the
largest panels only (the sign-in card, the chart expand modal). This is why a badge and a card do
not share a radius even though both are "containers": the corner has to stay proportional to the
box, or a small chip reads as a lozenge and a large card reads as a rectangle.

**`full` (999px) is reserved, not available.** It belongs to the sidebar module switcher's pill
signature, the period chip, and shapes whose radius is genuinely half their own height (the 6px
scrollbar thumb). `.tab-btn` deliberately stays at `md` — two pill treatments on one screen would
dilute the switcher from a signature into a pattern.

**Borders carry structure, and the two weights are not interchangeable.** `--theme-border` is
structural (card edges, the table header rule, input outlines); `--theme-border-lt` is internal
(row dividers, ghost button edges). Using the structural weight for a row divider makes a dense
table read as a grid of boxes, which is precisely the legacy-ERP failure mode.

**No clipping, no masks, no non-rectangular silhouettes.** Every surface is a rounded rectangle.
The only recurring non-rectangular shape is the circular status dot and its pulse ring, which is a
signal rather than a container.

### Named Rules

**The Proportional Corner Rule.** If a new element needs a radius, pick the step by asking how big
the box is, not how important it is. An important card does not get a larger corner; it gets the
accent colour or a better position.

**The Closed-Scale Rule.** A radius, a type size or a spacing value that is not on its scale is
drift. When the system is genuinely missing a step, add it to the scale and to this file — that is
how `--radius-xs` arrived, after 38 sites had independently reached for a 2–4px literal because a
10x10 legend swatch reads as a circle at 8px.

## Components

Reach for a global class before an inline style. An inline-styled control escapes the `:disabled`
treatment, the `[aria-invalid]` hook, the coarse-pointer touch floor and the focus pairing — all
four of which live on the class and none of which announce their absence.

### Buttons

- **Shape:** control-sized corners (12px, `--radius-md`), `8px 16px` padding, 13px/500, a 6px gap
  for an icon. Transitions background and colour at 0.13s.
- **Primary:** accent fill with `accent-text` at 700. The one filled control in the system.
- **Ghost:** the input ground with a `border-lt` edge; on hover it takes the table-hover tint and
  an accent border. This is the default for anything that is not the page's single commit action.
- **Danger:** the input ground, `red-text` foreground, a 45%-alpha red border, and a 12% red tint
  on hover. Deliberately **not** a solid red fill — there is no paired foreground token for red.
- **Danger (escalated):** `--strong` raises the tint to 16%/24% and the weight to 700, for the one
  action in a destructive group that is irreversible in a way its neighbours are not.
- **Link-like:** a `<td>` control that reads as a link and behaves as a button, for where the row's
  identity *is* the action (an outlet name that switches to that outlet). Accent-ink, underlined at
  1px, thickening to 2px on hover.
- **Icon-only (`.btn-icon`):** a 30px square holding a 15px glyph, worn *over* `.btn` plus a
  variant so it keeps the focus ring, the disabled treatment and the coarse touch floor. For a
  row's Actions column, where a set of text buttons is a column width rather than a control: on
  Vendors, four of them measured **314px** and pushed the table's min-content to 1115px against
  934px of room at a 1280px window — and the column that scrolled out of view to pay for them was
  the one naming the row. **An icon has no accessible name, so `aria-label` is required on every
  one**, with the same string on `title` for the pointer.
- **`.btn` alone is the BOX, and carries no background and no colour.** It declares padding,
  radius, size, weight, cursor, transition and the focus ring; a variant supplies the two things
  that make it visible. Written without one it inherits, which on a `<button>` means the browser's
  own chrome (`#f0f0f0` fill, black label — a light button on a charcoal card) and on an `<a>`
  means the UA link colour: the Terms page's current-document link rendered `#0000EE` underlined,
  measuring **1.81:1** on the Dark nav card against AA's 4.5:1, so the page you were already on
  was both the least legible thing in the header and the only one that looked clickable. Exactly
  the badge-box failure one section down, on the class it was never applied to — **CSS has no
  error for a class that does half a job**, and `btn btn-sm` reads as complete because `btn-sm` is
  real. Treat a bare `className="btn"` as a bug on sight.
- **Disabled:** one treatment for every variant — `opacity: 0.55` plus `not-allowed`. Before this
  lived on the class, each call site carried its own inline `opacity`, so a button that used the
  class alone had no disabled state at all: it simply stopped responding while looking unchanged.
- **Focus:** `0 0 0 2px` solid outline inside a `0 0 0 5px` ring, shared with `.tab-btn` and
  `.tip-trigger`. Before this existed, 11 of 16 focusable elements on a measured page fell back to
  the browser's own outline, which on a dark card is close to invisible.

### Badges / Status Chips

- **Shape:** 8px radius, `2px 8px`, 11px/500, capitalized.
- **Style:** each colour renders as a ~10–12% alpha tint of itself as the background with the
  `*-text` variant as the foreground — never a solid fill with white text. This keeps a table full
  of status badges calm even when every row carries one.
- **The box lives on every variant, not just `.badge`.** `badge-green` written alone had been used
  103 times across 22 files; without the box declarations it rendered as bare inherited-size text
  with no padding, radius or weight, and nothing in the markup said the class pair was incomplete.
  CSS has no error for a class that does half a job — which is also why there is **no
  `badge-gold`**, and never was.
- **A badge carrying a SENTENCE takes `.badge-sentence`.** The box sets `text-transform:
  capitalize`, which is right for `paid` or `pending` and wrong for anything with a verb in it: a
  two-sentence operator warning on the admin Legal tab rendered "Do Not Send An Agreement To A
  Client Until These Are Filled In", and Help → Legal's draft chip read "Draft — Not Yet In Force".
  The modifier turns the transform off and nothing else. It is a release valve, not an invitation
  — a chip that needs a sentence is usually a banner wearing the wrong class.
- **Roles:** green (paid/approved/ready), red (overdue/rejected/void), amber (pending/open), grey
  (inert/cancelled/a plain identity), violet (the rationed fourth category), and **`badge-yellow`,
  which is the accent tint, not amber** — the categorical tag. A category, an item type, a staff
  rank, a period, a close type and a delivery partner all live here. It is a genuinely different
  class from `.badge-amber`, and confusing the two is how "Foodmandu" came to be the same colour as
  an unfired dish.
- A tier or add-on above the module set takes the accent at a heavier fill plus a mark
  (`★ SUITE` at 0.20 against the module pills' 0.10), never a fourth hue.

### Cards / Containers

- **Corner:** 18px (`--radius-lg`). **Background:** `--theme-card`. **Border:** 1px
  `--theme-border`. **Shadow:** `--theme-card-shadow`, uniform policy. **Padding:** 24px.
- **Stat card:** the same surface at 20px padding, holding an 11px uppercase slate label, a 24px
  figure and an optional 12px sub-line.
- **`.interactive-card`** adds the focus outline to a card or row that is clickable but is not a
  real `<button>`.
- **Report error** (`.report-error`) is a card tinted 8% red with a red border: deliberately *not*
  the empty state, because "nothing to show" and "could not load" are different facts and only one
  of them means the figures on screen are real.

### Inputs / Fields

- **Style:** the input well (`--theme-input-bg`) inside a 1px `--theme-border`, 12px radius,
  `9px 12px`, 13px. `.form-field` stacks a 12px/500 label over the control with a 6px gap.
- **`.form-input` vs `.form-select`:** a text input takes `.form-input`. `.form-select` carries
  `cursor: pointer`, so a text field wearing it announces itself as a menu — 60 inputs across 22
  files had done exactly that. `.form-input--auto` is the width escape hatch for a filter toolbar,
  because width is layout, not control identity.
- **Focus:** accent border plus the soft ring on `:focus`, and the solid indicator layered on top
  for `:focus-visible`. Both are needed: the `:focus` rule's specificity would otherwise shadow the
  bare backstop and leave a keyboard user with only the 1.15:1 tint.
- **Invalid:** `aria-invalid="true"` is **both** the assistive-tech signal and the styling hook, so
  a field cannot be shown as failing without also being announced as failing. The rule sits *after*
  the `:focus` rules deliberately — same specificity, so source order decides, and the border must
  stay red while focused: that is precisely when the signal must not disappear. Pair it with a
  `.field-error` message carrying `role="alert"`; the border is reinforcement, never the message.
- **Disabled and read-only render identically, and the state is carried by the SURFACE, never by
  the value.** The well flattens to transparent and the border steps down to `border-lt`; the text
  stays exactly as readable as it was. This is deliberately not `.btn:disabled`'s dimming: a
  button's label is a verb you may not press, while a field's content is data, and a locked period
  still shows a real month of real figures that have to stay legible precisely because they can no
  longer be corrected. WebKit needs `-webkit-text-fill-color` and `opacity: 1` explicitly or the UA
  stylesheet greys the value anyway.

### The error family — three channels, three scopes

- **`FieldError`** speaks for one control, under the input it belongs to.
- **`ActionError`** speaks for the thing the user just pressed. Deliberately not a card: it sits
  under a form the reader is still looking at, where a filled panel reads as a second section
  rather than as a consequence of the click. Two parts, because the failure has two readers — a
  13px sentence the owner can act on, and an 11px monospace `detail` line holding the code and raw
  message for whoever eventually diagnoses it. `.action-error--top` places it above the fields
  where the message must be read first.
- **`ReportLoadError`** speaks for a whole report that could not be read and has to outweigh a page
  of figures.

Convert an error to a sentence at the **call site**, via `shared/errorText.js`, which has two
audiences: `staff` (someone who can only escalate) and `operator` (the person who fixes it).
`error.message` is not a message — supabase-js renders every dropped connection as
`TypeError: Failed to fetch`, which names a JavaScript type where the reader needed to know
whether their bill saved.

### Tabs — two families that do not mix

- **`.tab-btn` (pill):** a filter or sort control that changes what one view shows. Card ground, a
  border, 12px radius, `4px 12px`. Hover takes a 25% accent border; active takes a 50% border, the
  focus-ring tint as its fill and `accent-ink` as its text (the base accent failed AA here on most
  presets). Hover and active read as a progression, not two unrelated states.
- **`.panel-tab` (underline):** a *section* within one surface, typically a modal panel. Rest is
  fog; active is accent text plus a 2px accent underline at 600; a danger section keeps red in both
  states.
- **`.panel-tab-bar` and `.tab-bar` own the wrap.** An overflowing tab row silently hides its
  **last** tab, which is how a `⚠ Danger` section went missing for a release, and how a seven-tab
  hand-rolled row put "Print Sheet" at risk. Wrapping belongs to the class so no page has to
  remember it. `.tab-bar--scroll` is the deliberate single-row exception for a category strip.
- **Any tab row needs real tablist semantics**: `role="tablist"` on the row, `role="tab"` +
  `aria-selected` + `aria-controls` per tab, `role="tabpanel"` + `aria-labelledby` on the body, and
  a **roving `tabIndex`** so the row is one stop with arrows (plus Home/End) moving inside it.
  Without the roving index, reaching the eighth tab costs eight Tab presses — and the eighth tab is
  where the destructive actions live.

### Navigation

- **The shell** is one fixed column: wordmark, module switcher, nav, footer. It collapses to a 56px
  icon rail where labels are hidden (not truncated — clipped labels rendered "IM / HR / PO") and
  `RailTip` supplies the name on hover.
- **The module switcher** is the signature: a horizontal pill row expanded, an icon column
  collapsed, same buttons and data. Active takes `accent-ink` on the focus-ring tint with a 1px
  ring of the same tint.
- **Nav links** are 13px fog at `4px 12px` with a 12px radius; active takes `accent-ink` on the
  focus-ring tint at 600. Hover is the table-hover tint. A pin-to-favourites star appears on
  `:hover` **and `:focus-within`**, since it is keyboard-reachable.
- **The skip link** is WCAG 2.4.1 and not optional here: 41 focusable controls sit inside the
  sidebar before the main content.
- **The context bar** answers "which tenant, which period" on every route as a hairline and a row
  of text, not a card.
- **Collapse is a class toggle, not an unmount.** `.sidebar-wrap--collapsed` hides the nav content
  with `display: none`, so scroll position and any open dropdown survive a collapse/expand instead
  of resetting.

**The one accepted layout-property animation.** `.sidebar-shell` animates `width` and
`.main-content` tracks it with `margin-left`, both at `0.22s ease` — normally an anti-pattern, and
correctly flagged as one by any detector. It stays, and the reasoning has held through two
sidebar rewrites: `.sidebar-wrap` is `position: fixed`, so **real space has to be reserved** for
whichever width the sidebar currently is. A `transform`-only version would slide the sidebar over
the content rather than resizing the column, so avoiding it means restructuring the shell's
positioning strategy app-wide. The animation also fires only on a rare, manual, user-triggered
toggle — never continuously and never scroll-linked — so the actual jank risk is low. Revisit only
if the positioning mechanism changes for other reasons. Both values are recorded in
`.impeccable/config.json`'s `ignoreValues`; this paragraph is why.

### Data Tables (signature component)

- **Header:** 11px/500 fog, uppercase, `0.08em`, left-aligned, `10px 5px`, a structural bottom
  rule, `nowrap`.
- **Body:** 13px parchment on `11px 5px` with `border-lt` dividers; the last row drops its
  divider; `tr:hover td` takes the table-hover tint.
- **Totals:** `tfoot td` gets a 2px top rule at 700 and never takes the hover tint — it is not a
  data row. Before this rule existed, three report pages written in one week produced three
  different totals treatments.
- **`.data-table--sticky-first`** pins the first column for a matrix whose first column is the row
  label (one column per outlet), so scrolling right does not leave the reader matching numbers to
  remembered row order.
- **Row actions belong on the row**, and the disclosure control is a real `<button>` inside a
  `<td>` (`RowDisclosure`). **Never `role="button"` on a `<tr>`** — that overrides the row's
  implicit `row` role, which takes the row out of the table's structure and stops a screen reader
  associating its cells with their column headers. On tables that are almost entirely currency
  columns, that is the whole content. This was copied forward four times, most recently by an
  accessibility fix reaching for the incumbent shape in good faith.

- **`.cell-sub`** is the supporting line under a cell's main value — a clock time under a date,
  an AD date under a BS one, an invoice ref under a vendor name. 11px, `text3`, its own block. Use
  it instead of an inline style: it is the only version that survives the print reset (see Print
  above), and it keeps the seven-or-so places that do this from drifting apart.

**Which column absorbs the squeeze is a decision, and text is the only honest candidate.**
`white-space: nowrap` goes on the unbreakable atom — a date, a figure, a unit, an invoice ref, an
action button — never on the whole cell, and never on every column: a table where everything is
`nowrap` can only overflow, which is not the same thing as scrolling. The purchases bill list is
the worked example, rewritten three times before it settled: pinning the item cell made the table
overflow at every ordinary desktop width (min-content 1134px against 1086px of room at 1440px), and
the reader saw a sliced Edit button rather than a scrollbar. Now the two name columns wrap and
everything else holds, with no horizontal scroll from 1152px up.

### Report shell

`ReportPage` is the frame every report renders inside: title, scope, optional banners, a KPI strip,
filters, body, footnote. Its load-bearing rules: **the KPI strip does not render while loading or
after a failure** (a figure painted during load is a claim the page cannot yet support, and on a
green token it reads as a healthy one), and a failed read renders `ReportLoadError` rather than a
page of zeros.

**JSX children are an argument, not a gate.** `ReportPage` renders `children` only once loaded, but
the expression is fully evaluated by the *parent* before it is handed over — so a table built from
`useState(null)` data throws on the first render, before any wrapper or entitlement gate can
intervene. Only an early return, a guard at the call site, or a render prop protects it. The same
applies to `banners`, `stats`, `note`, `filters` and `footnote`.

### The period a report covers

`PeriodScope` is a chip in the page header, not the tail of a sentence. Across the IMS report
family the scope had been written into `.page-subtitle` as prose, so the one fact an operator must
verify before trusting any figure — which month is this? — was the last few words of a 13px fog
sentence styled identically to the description in front of it.

It introduces **no colour**: the chip is the accent at the same low tint `.badge-yellow` uses for a
categorical tag, because a period is exactly that. The label is 600 `accent-ink`, the state is 11px
uppercase fog — two weights, because a single-weight chip made the reader parse both halves to find
one.

**Open is structural, not a hue, and that was measured rather than chosen.** Tinting the chip amber
put its label at **4.19:1 on Light** on 12px text, and every tint from 6% to 12% lands between 4.19
and 4.54 — there is no amber fill here that is both visible and safe. Worse, it was not working
anyway: against the closed chip it separated by ΔE 6.0 on Dark and 2.6 on Light, both under the
floor. So the provisional state is a **dashed edge** — shape, which survives greyscale, every form
of colour blindness and a monochrome print, and cannot fail a contrast check because it is not
text — joined by the word OPEN and a `△`. `provisionalWhenOpen` is opt-in, because on a data-entry
screen an open period is the normal working state and flagging it would be noise.

### Page-state banners

Red says you cannot; amber says you can, but this is not the usual case. An amber banner is what an
admin editing a closed month gets — the action is permitted and the notice must not read as a
block.

### Empty states

`.empty-state` is centred slate at `48px 24px` with a 32px glyph. It must never stand in for a
failed read. And it must not name a control that is not on the page: eighteen IMS pages defaulted
to the open period, and with no periods at all rendered a `<select>` containing zero options with
either no empty state or one naming a button that was gated off — which is the first ten minutes of
every new customer. `NoPeriodState` is what they render instead, and it links to `/periods`.

### Motion

Four tokens, and they are the whole vocabulary: `--motion-fast` (160ms) and `--motion-slow` (260ms),
`--ease-standard` (`cubic-bezier(0.4, 0, 0.2, 1)`) for a state changing in place, and
`--ease-entrance` (`cubic-bezier(0.16, 1, 0.3, 1)`) for something arriving that was not on screen
before, where the near-flat tail reads as settling rather than stopping. Anything longer than
`--motion-slow` on a working surface is latency, not motion.

- **Every animation must be switchable off by `prefers-reduced-motion`, which means it cannot be an
  inline style.** A `style={{ animation }}` cannot be reached by the media query. Use a class.
- **Recharts is a second motion system that shares none of these tokens, on purpose.** It
  interpolates SVG attributes in JavaScript, so no stylesheet rule reaches it — a user who asked
  their OS for less motion still got the full 1500ms default on every chart. `chartMotion()`
  (`shared/chartMotion.js`) is the only place that gate can live; spread it onto every series.
  450ms and `ease-out`, because Recharts accepts only five easing keywords and a `cubic-bezier()`
  string is not valid there.
- **Stagger describes a list, or it is decoration.** The chart expand sequence steps its three
  stat pills at 60/105/150ms because they arrive as peers; nothing else in the product staggers.

## Do's and Don'ts

### Do:

- **Do** read every colour from a `--theme-*` token, and check the fallback half of a `var()` as
  carefully as a standalone literal — a drifted fallback paints in the one instant nobody is
  watching and reads as correct in review.
- **Do** take the `*-text` variant when a signal colour is type, and the base token when it fills.
- **Do** band a ratio through its shared function (`fcBand`, `varianceBand`, `lcBand`, `pcBand`,
  `nmBand`, `STAFF_LEVEL_BADGE`) and render it through `fcFigure` / `bandFigure`, so the mark
  cannot be dropped.
- **Do** pair the soft focus ring with the solid `--theme-focus-outline` on every new focusable
  control. The ring alone measures 1.15:1 and is not an indicator.
- **Do** reach for a global class (`.btn`, `.badge-*`, `.card`, `.form-input`, `.form-select`,
  `.page-header--split`, `.tab-btn`, `.panel-tab-bar`, `.data-table`) before an inline style.
- **Do** use `aria-invalid="true"` as both the styling hook and the announcement, and pair it with
  a `role="alert"` message.
- **Do** put `white-space: nowrap` on the unbreakable atom and let a text column absorb the squeeze.
- **Do** state a scope everywhere the report goes — the `PeriodScope` chip, the print header, the
  workbook and the filename.
- **Do** give a page that renders into the body flow its own `100dvh` scrollport, and delete the
  `min-height: 100vh` it was carrying.
- **Do** measure a chip's floor width in the browser before pinning it.
- **Do** treat print as a real surface: check that a new report prints as a flat document, not as a
  screenshot of cards.
- **Do** keep the Crest Staff app's floors (44px controls, 16px fields) scoped under
  `.self-service`, and set 16px inline too on any control that sets its own size.

### Don't:

- **Don't** introduce a second brand colour. If a fourth category is genuinely needed, that is what
  the rationed violet is for.
- **Don't** build a multi-series chart palette from the semantic tokens. They are five roles, not
  five validated hues, and they move for reasons that have nothing to do with series separation.
- **Don't** paint a signal colour on a category — a rank, a close type, a delivery partner, a
  payment method and a table state are facts, not verdicts.
- **Don't** paint a verdict colour on a figure that has not settled yet: early in a period a
  lumpy-numerator ratio is arithmetic, not signal.
- **Don't** let a page show a number it has not computed. A KPI painted during load is a claim the
  page cannot support, and on a green token it reads as a healthy one.
- **Don't** render a failed read as an empty state. They are different facts, and only one of them
  means the figures on screen are real.
- **Don't** hardcode white or black as text on an accent background — use `accent-text`.
- **Don't** invent a stronger shadow to mean "important". Card elevation is uniform policy.
- **Don't** dim a row with `opacity` to de-emphasise it: opacity multiplies through the text colour
  and takes it below AA. Label the state instead.
- **Don't** dim a disabled *field* the way a disabled button is dimmed. Flatten the surface and
  leave the value legible.
- **Don't** put `role="button"` on a `<tr>` — it removes the row from the table's structure and its
  cells lose their column headers. Put a real `<button>` in a cell.
- **Don't** write an animation as an inline style; `prefers-reduced-motion` cannot reach it.
- **Don't** assume a `position: sticky` element in the body flow sticks. Measure
  `getBoundingClientRect().top` across real scroll positions — it computes as `sticky` in devtools
  either way.
- **Don't** put padding on an `overflow: auto` element to clear a fixed control. Use margin, or the
  scrollbar ends up somewhere the reader will never find it.
- **Don't** show a user `error.message`. Convert at the call site through `errorText.js`, and never
  claim a failed write did not land — a dropped connection does not prove that.
