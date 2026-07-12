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
  sm: "4px"
  md: "6px"
  lg: "10px"
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

The product runs across nine interchangeable theme presets (dark charcoal-and-gold is the shipped default; Tokyo Night, Dracula, Nord, Catppuccin, and five others are user-selectable), all built from the same token set. Every rule below is written against the default preset's values, but the *relationships* between tokens (accent used sparingly, borders over shadows, alpha-blended status tints) hold across all nine.

**Key Characteristics:**
- Flat by default: borders and tonal fills carry hierarchy, not shadows
- One accent color per screen, applied sparingly (buttons, active states, focus rings) never as a wash
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
**The One Accent Rule.** Aged Brass is the only non-semantic color on any screen. If a second "brand" color shows up anywhere outside the rationed purple exception, it's a mistake, not a design choice.

**The Accent-Text Pairing Rule.** Any element with an Aged-Brass background uses the theme's paired `accent-text` token for its foreground (`#0f1117` in the default preset), never a hardcoded white or black. Because the accent color changes per theme preset, a hardcoded foreground color will silently fail contrast on at least one of the nine presets. This is a real bug the codebase shipped and fixed once already (a floating action button used a hardcoded white label) - treat it as the standing rule, not a one-off fix.

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

Flat by default. The system conveys depth through a one-step background shift (card is one tone lighter than page background) and 1px borders, not box-shadow. This holds across all nine presets, including the light ones, where cards are pure white against a warm-gray page rather than shadow-lifted.

Shadow is reserved for two narrow cases: fixed/floating elements that genuinely sit above the page (a floating cart-summary button on the guest ordering page), and live-status pulse animations (a soft glow-ring pulse on a newly-arrived order, using the theme's own accent or red at low alpha - never a generic black shadow).

### Shadow Vocabulary
- **Floating action** (`box-shadow: 0 4px 16px rgba(0,0,0,0.3)`): the one static elevation shadow in the system, for content fixed above the page (e.g. a bottom-anchored cart button).
- **Live pulse (status)** (`box-shadow: 0 0 0 0 rgba(<signal-color>, 0.5)` animating to `0 0 0 6px rgba(<signal-color>, 0.18)`): a breathing ring on elements needing real-time attention (a new order banner, a live badge). Uses the relevant signal color's own alpha, never a neutral glow.

### Named Rules
**The Flat-By-Default Rule.** A card, table, or panel gets a background shift and a border. It does not also get a shadow "for polish." Shadow is a signal (this thing floats, or this thing needs your attention right now), not decoration.

## 5. Components

### Buttons
- **Shape:** 6px radius, no exceptions across variants.
- **Primary:** Aged Brass background, `accent-text` foreground (never hardcoded), 700 weight, 8px 16px padding, 13px label.
- **Hover:** background steps to the theme's `accent-hover` token; no scale/transform, no color-only state changes on interactive elements otherwise.
- **Ghost:** input-bg background, primary text color, 1px `border-lt`; hover shifts to `table-hover` tint with the border color stepping to accent - a quiet way of saying "this became interactive."
- **Danger:** input-bg background, red text, red border at low alpha; hover fills to a red tint. Reserved for destructive actions only (delete, void), never for "important" as a stand-in for danger.
- Feel: tactile and confident. Transitions are short (0.13s) background/color fades, no bounce, no elastic easing, no scale-on-press - firmness comes from color contrast and weight, not physics.

### Badges / Status Chips
- **Shape:** 4px radius, 2px 8px padding, 11px label, capitalized.
- **Style:** each semantic color renders as a ~10-12% alpha tint of itself as background, full-opacity as text - never a solid fill with white text. This keeps a table full of status badges calm even when every row has one.
- **Roles:** green (paid/approved/healthy), red (overdue/rejected), amber (pending/low), gray (neutral/cancelled).

### Cards / Containers
- **Corner style:** 10px radius (gently rounded, not sharp, not pill-shaped).
- **Background:** one step lighter than the page background; no gradient, no tint toward the accent.
- **Shadow strategy:** none (see Elevation). Depth is border + background-shift only.
- **Border:** 1px, structural border color.
- **Internal padding:** 24px, consistent regardless of card content density.

### Inputs / Fields
- **Style:** input-bg background (typically matches or nears the page background, one step darker than card), 1px border, 6px radius, 13px text, label sits above the field (never a placeholder standing in for a label).
- **Focus:** border steps to accent color, plus a soft 3px ring in the theme's own `focus-ring` token (an alpha-blended version of the accent, not a generic browser-blue ring). This focus ring is themed - it changes hue with every preset.
- **Error/Disabled:** not yet formalized as a distinct token; errors currently surface as inline red text below the field rather than a red field border.

### Tabs (pill filters)
- **Style:** 5px radius, 1px border, 4px 12px padding, 12px label, secondary text color at rest.
- **Active state:** accent-colored text, accent border at 50% alpha, `focus-ring` token as background fill, weight steps up to 600. The active tab looks "selected," not "pressed" - it's a persistent state, not a momentary one.

### Navigation
- **Style:** a fixed 56px icon rail plus an expandable flyout panel, sidebar background matched to the active theme (dark sidebar on dark themes, light on light themes) so it never reads as a fixed dark strip on a light theme. Nav items use the accent color for active/hover state, 160ms `cubic-bezier(0.4, 0, 0.2, 1)` transitions - the one formalized motion timing in the system, reused for every sidebar interaction rather than invented per-component.

### Data Tables (signature component)
Dense, functional, and the component most of the product's screens are actually built around. Column headers are 11px uppercase labels at wide tracking; rows are 13px body text with a light bottom border between them (no border on the last row); row hover applies a barely-there tint (`table-hover`, 2-8% alpha depending on theme) rather than a solid highlight. Wide tables always live inside a horizontal-scroll wrapper rather than compressing columns to fit - the data stays legible at native width instead of getting cramped to avoid a scrollbar.

## 6. Do's and Don'ts

### Do:
- **Do** use the theme's `accent-text` token as the foreground on any accent-colored background - it changes per preset and a hardcoded color will fail contrast on at least one of the nine themes.
- **Do** keep tonal alpha-tints (`table-hover`, `focus-ring`, badge backgrounds) at 2-18% opacity - enough to register as a state, never opaque enough to compete with real content.
- **Do** wrap every wide table in the horizontal-scroll container rather than shrinking columns.
- **Do** reserve the rationed 4th color (purple) for a genuine 4th/5th categorical need, not as a second accent.
- **Do** put labels above form fields, always - never a placeholder standing in for a label.

### Don't:
- **Don't** build dense, hierarchy-less layouts in the name of "fitting more in" - that's the legacy-ERP failure mode this product is explicitly positioned against.
- **Don't** reach for purple gradients, Inter-everywhere, or a templated hero-plus-three-cards layout - the generic-AI-SaaS look PRODUCT.md names directly as an anti-reference.
- **Don't** add box-shadow to a card or panel "for polish." Shadow means floating-above-the-page or needs-attention-now; it is not a decoration budget.
- **Don't** hardcode white or black as text on an accent background - use the paired `accent-text` token.
- **Don't** use a second saturated brand color alongside Aged Brass on the same screen; if a fourth category is genuinely needed, that's what the rationed purple token is for.
