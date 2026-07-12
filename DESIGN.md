---
name: Crest Inventory
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
  text-secondary: "#8a92a3"
  text-tertiary: "#9ca3af"
  signal-success: "#34d399"
  signal-danger: "#f87171"
  signal-warning: "#fbbf24"
  signal-categorical: "#a78bfa"
typography:
  wordmark:
    fontFamily: "Georgia, serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.04em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.08em"
rounded:
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
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
  card:
    backgroundColor: "{colors.ink-card}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
---

# Design System: Crest Inventory

## 1. Overview

**Creative North Star: "The Back-of-House Command Center"**

Crest Inventory is operated, not visited. An owner is checking margin between service rushes; an accountant is reconciling TDS figures before a filing deadline. Neither has time for the interface to perform. The system is built around **legibility under pressure**: dense tables that stay scannable, a single restrained accent, and status communicated through color and position rather than decoration.

This deliberately rejects two things named in PRODUCT.md: the dated, hierarchy-less density of legacy Nepali ERP software, and the templated purple-gradient look of generic AI-generated SaaS. The system solves density the same problem legacy ERPs were trying to solve, but with real typographic hierarchy, a single accent used sparingly, and consistent spacing instead of cramming.

The product runs across ten interchangeable theme presets (dark charcoal-and-gold is the shipped default; Tokyo Night, Dracula, Nord, Catppuccin, Latte, Rosé Dawn, Solarized, and Light are the other nine; **Bright** — a crisp cool-blue light theme, added 2026-07-12 — is the newest). All ten are built from the same token set. Every rule below is written against the default preset's values, but the *relationships* between tokens (accent used sparingly except where a preset deliberately breaks that — see Bright below, borders and lightness-shift carrying hierarchy, alpha-blended status tints) hold across all ten, even where the literal shape values (radius, shadow) no longer do — see Elevation.

**Key Characteristics:**
- Depth comes primarily from a one-step background-lightness shift, with a per-preset shadow as a secondary cue (added 2026-07-12 — see Elevation; previously flat-only, see that section's history note)
- One accent color per screen, applied sparingly (buttons, active states, focus rings) never as a wash — **Bright** is a deliberate, scoped exception (see Elevation and the Bright preset note below)
- A serif wordmark is the one deliberate ornamental choice in an otherwise all-sans, all-functional system
- Status (paid / pending / overdue, veg / non-veg, stock health) is color-coded consistently: green success, red danger, amber caution, gray neutral, with a rationed 4th color (purple) reserved for a genuine fourth or fifth category when green/red/amber aren't enough

## 2. Colors

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
- **Slate Text** (#8a92a3): Secondary text - labels, metadata, table headers.
- **Fog Text** (#9ca3af): Tertiary text - the quietest tier, timestamps and disabled-adjacent copy.

### Signal colors
- **Success Green** (#34d399): Paid, approved, healthy stock, positive variance.
- **Danger Red** (#f87171): Overdue, rejected, negative variance, destructive actions.
- **Warning Amber** (#fbbf24): Pending, low stock, needs-attention.
- **Categorical Purple** (#a78bfa): A rationed 4th/5th categorical color for when green/red/amber genuinely aren't enough (e.g. Staff Meals as a distinct expense category, a sub-recipe tab underline). Not a general-purpose accent - reach for it only when a page needs one more distinct hue than the semantic three provide.

### Named Rules
**The One Accent Rule.** Aged Brass (or the active preset's own accent) is the only non-semantic color on any screen. If a second "brand" color shows up anywhere outside the rationed purple exception, it's a mistake, not a design choice. **Bright's `ClientDashboard.jsx` KPI badges are the one named, scoped exception** (see Badges / Status Chips) - everywhere else, on every preset including Bright itself, the rule holds as written.

**The Accent-Text Pairing Rule.** Any element with an accent-colored background uses the theme's paired `accent-text` token for its foreground (`#0f1117` in the Dark preset, `#ffffff` in Bright), never a hardcoded white or black. Because the accent color changes per theme preset, a hardcoded foreground color will silently fail contrast on at least one of the ten presets. This is a real bug the codebase shipped and fixed once already (a floating action button used a hardcoded white label) - treat it as the standing rule, not a one-off fix. A 2026-07-12 audit found the same class of bug in four more shared components (`SearchableSelect.js`, `BsCalendarPicker.js`, `PremiumGate.js`, `ProtectedRoute.js`) that had been hardcoding the Dark preset's exact hex values since before the theme system existed - fixed to read theme tokens, so they now actually respect every preset instead of only working by coincidence on Dark.

## 3. Typography

**Display Font:** Georgia, serif (fallback: serif) - reserved for the wordmark only.
**Body Font:** -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, sans-serif.
**Label/Mono Font:** none distinct; labels use the body stack at a smaller size and wider tracking instead of a separate typeface.

**Character:** A restrained system sans for every working surface, broken exactly once by a serif wordmark. The serif is a signature, not a typographic system - it never appears on a second element.

### Hierarchy
- **Display** (700, 16-20px depending on placement, line-height 1.2, letter-spacing 0.04em, Georgia serif): the "Crest" wordmark only - sidebar brand mark and the login screen. Nowhere else.
- **Title** (700, 14-15px, line-height 1.4): card headings, section titles ("Submit Leave Request", stat card values).
- **Body** (400-500, 13px, line-height 1.5): table cells, form values, the default size for nearly everything a user reads.
- **Label** (500, 11px, letter-spacing 0.08-0.1em, uppercase, Slate Text or Fog Text): table column headers, stat card labels, section eyebrows. Sparse by necessity - this is a data-dense product, not a marketing page, so uppercase labels earn their place as literal column headers rather than decorative kickers.

### Named Rules
**The One Serif Rule.** Georgia appears exactly once per screen (the wordmark, if visible at all). It is never used for a heading, a callout, or emphasis - that would dilute it from signature to affectation.

## 4. Elevation

**History note (2026-07-12):** this section previously documented a strict "Flat-By-Default Rule" — no card shadows anywhere, depth from background-lightness and borders only. That rule is retired as of the Bright theme + sidebar redesign session: every preset now gets a real `box-shadow` on cards via a per-preset `--theme-card-shadow` token, at the user's explicit request. What's below is the model that replaced it — read this section as current, not the old rule plus an exception list.

**The model: background-lightness stays primary, shadow is a secondary, per-preset-tuned layer — not inverted, not uniform.** A card is still one tone lighter than the page (dark presets) or a distinct surface tone from the page (light presets) — that hasn't changed and is still the main depth cue, especially on dark presets where a literal black shadow would be nearly invisible against an already-near-black page. Shadow is layered on top, generated by formula from each preset's own `bg`/`text1` values rather than a flat black:

- **Dark-leaning presets** (Dark, Tokyo Night, Dracula, Nord, Catppuccin): `inset 0 1px 0 0 rgba({text1}, 0.06), 0 10px 24px -8px rgba({bg}, 0.55), 0 3px 8px -3px rgba({bg}, 0.4)` — a faint light-tinted rim highlight plus a deep, theme-colored (not neutral-black) shadow, so e.g. Tokyo Night's indigo cast or Dracula's purple cast survives instead of flattening to generic black.
- **Light-leaning presets** (Latte, Rosé Dawn, Solarized, Light, Bright): `0 1px 2px rgba({text1}, 0.06), 0 10px 24px -8px rgba({text1}, 0.1)` — a classic soft shadow, tinted from the preset's own ink color rather than pure black.
- **Bright** breaks the light-preset formula once more, deliberately: its shadow's outer layer is tinted from the accent blue (`rgba(58,109,240,0.16)`) rather than neutral ink, consistent with Bright being the one preset where the accent is allowed to show up more than "sparingly" elsewhere too (see the Colors section's One Accent Rule exception, and the badge exception below).

Shadow was already in real use before this change beyond the two cases previously documented here (a floating cart button, live-status pulse rings) — `.sidebar-dropdown-panel`'s popover, `RailTip`'s hover tooltip, and `ChartCard`'s expand-modal all had their own shadows already. Those are unchanged; the new per-preset `--theme-card-shadow` token is additionally applied to `.card`, `.stat-card`, and the three main dashboards' inline `kpiCard()` panels.

### Shadow Vocabulary
- **Card elevation** (`box-shadow: var(--theme-card-shadow)`): the default for `.card`/`.stat-card` and equivalent panels, per-preset-tuned per the model above.
- **Floating action** (`box-shadow: 0 4px 16px rgba(0,0,0,0.3)`): unchanged — a fixed/floating element genuinely above the page (e.g. the bottom-anchored cart button, `Fab.js`).
- **Live pulse (status)** (`box-shadow: 0 0 0 0 rgba(<signal-color>, 0.5)` animating to `0 0 0 6px rgba(<signal-color>, 0.18)`): unchanged — a breathing ring on elements needing real-time attention, using the relevant signal color's own alpha.

### Named Rules
**Shadow tells you what surface you're on, not that a page is "polished."** Card elevation is now uniform policy (every preset, every card), so it no longer functions as a special signal the way the floating-action and live-pulse shadows still do — don't invent a *third* meaning for it (e.g. a stronger shadow to mean "important"). If something needs to stand out, that's a job for the accent color or position, same as always.

## 5. Components

### Buttons
- **Shape:** 12px radius (`--radius-md`; bumped from 6px 2026-07-12), no exceptions across variants.
- **Primary:** Aged Brass background, `accent-text` foreground (never hardcoded), 700 weight, 8px 16px padding, 13px label.
- **Hover:** background steps to the theme's `accent-hover` token; no scale/transform, no color-only state changes on interactive elements otherwise.
- **Ghost:** input-bg background, primary text color, 1px `border-lt`; hover shifts to `table-hover` tint with the border color stepping to accent - a quiet way of saying "this became interactive."
- **Danger:** input-bg background, red text, red border at low alpha; hover fills to a red tint. Reserved for destructive actions only (delete, void), never for "important" as a stand-in for danger.
- Feel: tactile and confident. Transitions are short (0.13s) background/color fades, no bounce, no elastic easing, no scale-on-press - firmness comes from color contrast and weight, not physics.

### Badges / Status Chips
- **Shape:** 8px radius (`--radius-sm`; bumped from 4px 2026-07-12), 2px 8px padding, 11px label, capitalized.
- **Style:** each semantic color renders as a ~10-12% alpha tint of itself as background, full-opacity as text - never a solid fill with white text. This keeps a table full of status badges calm even when every row has one.
- **Roles:** green (paid/approved/healthy), red (overdue/rejected), amber (pending/low), gray (neutral/cancelled).
- **Bright-only exception (2026-07-12):** `ClientDashboard.jsx`'s five headline KPI cards (Net Purchases, Revenue, Food Cost %, Fixed Costs %, Est. Net Margin %) get a colorful per-category icon badge (blue/green/amber square, `kpiIcon()`) when the active preset is Bright, gated on `themeKey === 'bright'`. This is a deliberate, narrowly-scoped exception to the One Accent Rule for one page and one preset — every other preset, and every other stat-grid page (35+ report pages, `OwnerDashboard.jsx`, `AdminDashboardOverview.jsx`), keeps plain text-only stat cards. Don't propagate this pattern elsewhere by analogy; it was a specific design call for this one dashboard, not a new baseline.

### Cards / Containers
- **Corner style:** 18px radius (`--radius-lg`; bumped from 10px 2026-07-12) - noticeably rounded, still not pill-shaped.
- **Background:** one step lighter than the page background; no gradient, no tint toward the accent.
- **Shadow strategy:** `var(--theme-card-shadow)` (added 2026-07-12 - see Elevation). Depth is background-shift + border + a per-preset-tuned shadow, no longer border-only.
- **Border:** 1px, structural border color.
- **Internal padding:** 24px, consistent regardless of card content density.

### Inputs / Fields
- **Style:** input-bg background (typically matches or nears the page background, one step darker than card), 1px border, 12px radius (`--radius-md`; bumped from 6px 2026-07-12), 13px text, label sits above the field (never a placeholder standing in for a label).
- **Focus:** border steps to accent color, plus a soft 3px ring in the theme's own `focus-ring` token (an alpha-blended version of the accent, not a generic browser-blue ring). This focus ring is themed - it changes hue with every preset.
- **Error/Disabled:** not yet formalized as a distinct token; errors currently surface as inline red text below the field rather than a red field border.

### Tabs (pill filters)
- **Style:** 12px radius (`--radius-md`; bumped from 5px 2026-07-12 - see the pill-shape note below), 1px border, 4px 12px padding, 12px label, secondary text color at rest.
- **Active state:** accent-colored text, accent border at 50% alpha, `focus-ring` token as background fill, weight steps up to 600. The active tab looks "selected," not "pressed" - it's a persistent state, not a momentary one.
- **Not pill-shaped, on purpose:** the sidebar's module switcher (see Navigation) is true pill-shaped (`border-radius: 999px`) as its own deliberate, singular signature. `.tab-btn` deliberately stays at the standard `--radius-md` rather than also going full pill - two different pill treatments on the same screen would dilute the switcher from "one special treatment" to "just another pill row," the same restraint problem the One Serif Rule guards against for the wordmark.

### Navigation
**Rewritten 2026-07-12** — the sidebar was restructured from a 56px icon rail + separate 220px flyout panel into one unified column.
- **Structure:** `.sidebar-shell`, one column, 240px expanded / 56px collapsed (`--main-content` margin-left tracks the same two values). Top to bottom: brand (logo + wordmark, Georgia serif per the One Serif Rule + Ctrl-K search trigger) → module switcher (see below) → scrollable nav content (client badge, nav groups, footer) → a fixed bottom row (Help / collapse toggle / Sign out), always visible regardless of collapsed state.
- **Module switcher:** a horizontal pill row (`.module-switcher`/`.module-tab`, `border-radius: 999px`-adjacent full-pill shape) when expanded, one tab per module the user can see (Admin/IMS/HR/POS - 1 to 4 tabs depending on role and what the client has enabled). Collapses to a vertical icon-only column (same buttons, `flex-direction` flip) when the sidebar is collapsed - visually equivalent to the pre-2026-07-12 icon rail. **Hidden entirely when only one module is visible** - a one-pill switcher reads as broken UI, not a real choice.
- **Collapsed state:** a CSS class toggle (`.sidebar-wrap--collapsed`), not a JSX unmount - the nav content stays mounted and is hidden via `display:none`, so scroll position and any open dropdown state survive a collapse/expand toggle instead of resetting.
- **Style:** sidebar background matched to the active theme (dark sidebar on dark themes, light on light themes) so it never reads as a fixed dark strip on a light theme. Nav items use the accent color for active/hover state, 160ms `cubic-bezier(0.4, 0, 0.2, 1)` transitions - the one formalized motion timing in the system, reused for every sidebar interaction rather than invented per-component.
- **Accepted exception:** `.sidebar-shell`'s collapse toggle animates `width`, and `.main-content`'s tracks it by animating `margin-left` (`Layout.css`, both `transition: ... 0.22s ease`) rather than `transform`/`opacity`. Normally a layout-property animation, flagged as such. Kept as-is (confirmed 2026-07-12, reasoning unchanged from the original single-rail version): `.sidebar-wrap` is `position: fixed`, so real space must be reserved for whichever width the sidebar currently is - a `transform`-only fix would mean restructuring the sidebar's positioning strategy app-wide, and the animation only fires on a rare, manual, user-triggered toggle, not a continuous or scroll-linked one, so the real jank risk is low. Revisit only if the sidebar's positioning mechanism changes for other reasons.

### Data Tables (signature component)
Dense, functional, and the component most of the product's screens are actually built around. Column headers are 11px uppercase labels at wide tracking; rows are 13px body text with a light bottom border between them (no border on the last row); row hover applies a barely-there tint (`table-hover`, 2-8% alpha depending on theme) rather than a solid highlight. Wide tables always live inside a horizontal-scroll wrapper rather than compressing columns to fit - the data stays legible at native width instead of getting cramped to avoid a scrollbar.

## 6. Do's and Don'ts

### Do:
- **Do** use the theme's `accent-text` token as the foreground on any accent-colored background - it changes per preset and a hardcoded color will fail contrast on at least one of the ten themes.
- **Do** keep tonal alpha-tints (`table-hover`, `focus-ring`, badge backgrounds) at 2-18% opacity - enough to register as a state, never opaque enough to compete with real content.
- **Do** wrap every wide table in the horizontal-scroll container rather than shrinking columns.
- **Do** reserve the rationed 4th color (purple) for a genuine 4th/5th categorical need, not as a second accent.
- **Do** put labels above form fields, always - never a placeholder standing in for a label.

### Don't:
- **Don't** build dense, hierarchy-less layouts in the name of "fitting more in" - that's the legacy-ERP failure mode this product is explicitly positioned against.
- **Don't** reach for purple gradients, Inter-everywhere, or a templated hero-plus-three-cards layout - the generic-AI-SaaS look PRODUCT.md names directly as an anti-reference.
- **Don't** invent a stronger/different shadow to mean "important" or "premium." Card elevation (`--theme-card-shadow`) is now uniform policy across every card, not a decoration budget to spend more of - the floating-action and live-pulse shadows are the only two that still carry extra meaning (see Elevation).
- **Don't** hardcode white or black as text on an accent background - use the paired `accent-text` token.
- **Don't** use a second saturated brand color alongside Aged Brass on the same screen; if a fourth category is genuinely needed, that's what the rationed purple token is for. (Bright's colorful KPI badges on `ClientDashboard.jsx` are the one named exception - see Badges / Status Chips.)
