# Handoff: Crest Suite — Modernist theme (light + dark)

## Overview
Redesign of the Crest Suite public login page and app-wide theme in the **Modernist** design system: Archivo type, flat surfaces, zero corner radius, strong 2px rules, flush-left labels, one red accent used sparingly. Two schemes — **Modernist Light** (option 3a) and **Modernist Night** (3b) — designed as a `dark`/`light` preset pair so the existing `system` mode keeps working.

## About the design files
`Login Redesign.dc.html` in this bundle is a **design reference created in HTML** — a prototype showing intended look, not production code. The task is to **recreate it in the existing React codebase** (`crest-suite`) using its established patterns: `ThemeContext.js` presets, `Login.css` / `Layout.css` variables, existing components (`PivotTable`, `StatPill`, `ChartCard`…). `modernist-tokens.css` is the design system's raw token sheet for reference.

## Fidelity
**High-fidelity.** Colors, type sizes, weights, spacing and states below are final. Options 3a (light) and 3b (dark) are the approved pair; earlier options (1a-2b) in the HTML are rejected explorations — ignore them.

## Theme presets — drop-in for `src/context/ThemeContext.js` PRESETS

Keyed exactly to the existing token names. Signal colours (`green/red/amber/purple` + `*Text`) are **deliberately carried over unchanged** from the current presets — they were tuned for AA and colour-blind separation (S551/S608/S683); Modernist only replaces ground, ink and accent.

### `dark` → Modernist Night (3b)
```js
dark: {
  name: 'Modernist Night', description: 'Ink & signal red',
  bg: '#191817', card: '#242221', border: '#3a3836', borderLt: '#2c2a29', sidebar: '#141312',
  text1: '#f3f2f2', text2: '#bab6b6', text3: '#9b9797',
  accent: '#ff563c', accentHover: '#ff9783', accentText: '#201e1d',
  accentInk: '#ff9783',
  inputBg: '#1e1d1c', tableHover: 'rgba(255,255,255,0.04)', focusRing: 'rgba(255,86,60,0.15)',
  green: '#34d399', red: '#f87171', amber: '#fbbf24', purple: '#a78bfa',
  cardShadow: 'inset 0 1px 0 0 rgba(243,242,242,0.05), 0 10px 24px -8px rgba(0,0,0,0.55), 0 3px 8px -3px rgba(0,0,0,0.4)',
},
```
Notes: accent is the ramp's 500 step (`#ff563c`) — the base `#ec3013` is too dark on ink. Hover goes one step LIGHTER (`#ff9783`, accent-400) per the system's dark-ground rule. `accentText` is ink, not white (5.2:1 on the fill). `accentInk` declared for the same reason the current Tokyo Night/Dracula/Nord do.

### `light` → Modernist Light (3a)
```js
light: {
  name: 'Modernist Light', description: 'Paper & signal red',
  bg: '#f3f2f2', card: '#eae9e9', border: '#d7d3d3', borderLt: '#e5e3e3', sidebar: '#eae9e9',
  text1: '#201e1d', text2: '#605d5d', text3: '#7d7979',
  accent: '#ec3013', accentHover: '#dd2b0f', accentText: '#ffffff',
  accentInk: '#ae1800',
  inputBg: '#ffffff', tableHover: '#e6e4e4', focusRing: 'rgba(236,48,19,0.12)',
  green: '#15803d', red: '#dc2626', amber: '#b45309', purple: '#7c3aed',
  greenText: '#116b33', redText: '#8f2440', amberText: '#964900', purpleText: '#6d28d9',
  cardShadow: '0 1px 2px rgba(45,43,43,0.14)',
},
```
⚠ Contrast note, measure before shipping: white on `#ec3013` is ~4.2:1 — fine for the ≥15px/600 button labels this design uses, but below 4.5:1 for small text on accent fills. If any small-text-on-accent surface exists, either bump those labels to 15px/600+ or use `#dd2b0f` as the fill (white clears 4.75:1 there). `accentInk #ae1800` (accent-as-text) clears 4.5:1 on bg and card. Danger `red #dc2626` sits near the brand red by design intent — danger states should lean on `redText #8f2440` + iconography, not hue alone (already the S608 practice).

## Global style changes (both schemes)

- **Font**: Archivo everywhere (replaces current fonts). Load `https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&display=swap`. Headings weight **800**, tight tracking (−.01em to −.02em); UI labels/buttons **600**; body 400, 15px, line-height 1.55.
- **Radius**: **0 everywhere** — buttons, cards, inputs, tags, dialogs, chips. Remove/zero every `border-radius`.
- **Rules**: section dividers are **2px** at 40% ink (`rgba(32,30,29,.4)` light / `rgba(243,242,242,.4)` dark); row rules **1px** at 15%.
- **Buttons**: labels **flush left**, never centered. Wide/block buttons: `display:flex; justify-content:space-between` with label left and `→` trailing right. Primary = solid accent fill; secondary = 1px `border` outline, transparent fill; hover per preset (`accentHover` fill / 5-8% ink tint for outlined).
- **Cards**: surface-filled (`card` token), no border on light (shadow-sm only), 1px `rgba(243,242,242,.12)` border on dark. No decorations.
- **Form fields**: labels 11px / 600 / uppercase / .08em tracking / `text2`; inputs 44px, 1px `border` at 30% ink, `inputBg` fill, radius 0; focus = `2px solid accent` outline, offset 2px (keep `--theme-focus-outline` wiring).
- **KPI stat cards**: 1px bordered cells **sharing edges** (border-right:0 between siblings — one drawn grid, not floating cards); kicker 11px uppercase `text2`, value 24px/800.
- **Icons**: Lucide, default stroke. Photography grayscale if any appears.

## Screens / views

### 1. Login page (`src/pages/Login.js` / `Login.css`)
Layout as today (sticky header, hero grid `1fr 420px` gap 64, footer) with these changes:
- **Trial signup form moves to its own page/route** (e.g. `/signup`). In its place: a slim band between hero and footer — 2px top rule, left: "New to Crest Suite?" (18px/800) + "Starter plan, free for 7 days · No credit card · Nothing to install" (`text2`), right: outlined accent button "Start your free trial →". Header CTA and this button both navigate to the signup page. Keep `?trial=1` deep-link → signup page autofocus.
- **Eyebrow**: `{TRIAL_DAYS}-day free trial · No credit card needed` — 13px/600 uppercase .08em, `accentInk` (light) / `accentInk` (dark). No pill background.
- **H1**: 44px/800, line-height 1.05, flush left, no forced break needed at this size (the two-`<span>` structure can stay).
- **Highlights list**: replaces bullet beads with **numbered rows** — `01`…`06` (13px/600, `accentInk`) in a 26px column, 1px row rules above/below each row (top rule on the list container). Copy verbatim, POS→IMS→HR order preserved.
- **Data promise**: outside the list as today; 10px solid accent square in the number column, text 600 weight.
- **Sign-in card**: `card` fill, 32px padding, no radius. "Welcome back" 26px/800, sub 14px `text2`. Email + password fields per global field spec; "Forgot password?" stays in the label row, 13px `accentInk`, underlined. Show-password checkbox `accent-color: accent`. Actions stacked full-width (not side-by-side): primary "Sign in →" (46px, accent fill, label left / arrow right), secondary "Staff Login →" (46px outlined). Keep caps-lock hint, error line (`redText`), forgot-mode swap, all aria wiring unchanged.
- **Footer**: unchanged content; 12.5px `text2`.

### 2. Signup page (new)
Same header/footer chrome. One column, max-width ~720px, flush left: h1 "Start your free trial" (800), sub "Starter plan, free for {TRIAL_DAYS} days · No credit card · Nothing to install". The existing trial form grid (Business Name, Business email, Create a password + show-password, Your Name (optional), Phone, submit) with the same validation, consent checkbox and legal links — all logic from today's `handleTrialSignup` moves here untouched. Submit = block primary "Start Free Trial →", label flush left.

### 3. Dashboard (`ClientDashboard.jsx` + `Layout.css`)
No structural changes — theme only:
- Top bar: 2px bottom rule; module tabs 13px/600 uppercase, active = `text1` + 2px accent underline, inactive `text3`; period chip = 1px outline tag, radius 0.
- KPI cards: shared-edge bordered cells (see global). Positive delta figures use `accentInk`-style emphasis or `greenText` per existing semantics — don't introduce new signal colours.
- ChartCard: card fill, title 15px/800, legend swatches 8px squares; series colours — sales/primary series `accent`, comparison series `neutral` (`#bab6b6` light / `#605d5d` dark); keep the projection/target hue rules from the existing chart comments (fixed hexes in `ClientDashboard.jsx`'s `DAILY_TREND_COLORS` should be re-pointed: purchases `#9b9797`, sales `#ec3013`/`#ff563c` per scheme — Recharts needs resolved hexes from `useTheme`, not CSS vars).
- Baseline axis under bar/line charts: 2px rule.

### 4. Pivot tables (`PivotTable.jsx` / `SalesPivot`)
- Header row: 11px/600 uppercase `text2`, **2px rule below**.
- Body rows: 14px, 1px rules; labels flush left, numbers right-aligned.
- Totals: **2px rule above the totals row**; totals 600; grand total 800 in `accentInk`. Red is reserved for the single grand total / genuine emphasis — never per-cell decoration. Empty cells: `—` in `text3`.

## Interactions & behavior
All existing behavior is preserved (auth flows, validation, caps-lock hints, error taxonomy, redirects, consent recording). Only visual changes + the signup-page split. Transitions: keep them minimal/instant — Modernist doesn't animate decoration; 100-150ms ease on background-color hovers is enough.

## Design tokens summary
- Grounds: light `#f3f2f2` / `#eae9e9`; dark `#191817` / `#242221`
- Ink ladders: light `#201e1d` / `#605d5d` / `#7d7979`; dark `#f3f2f2` / `#bab6b6` / `#9b9797`
- Accent ramp (from the DS): 100 `#fff2ef` · 200 `#ffe0d9` · 300 `#ffc4b8` · 400 `#ff9783` · 500 `#ff563c` · base `#ec3013` · 600 `#dd2b0f` · 700 `#ae1800` · 800 `#7c1405` · 900 `#4d170e`
- Neutral ramp: 100 `#f8f4f4` … 400 `#bab6b6` · 500 `#9b9797` · 600 `#7d7979` · 700 `#605d5d` · 800 `#444141` · 900 `#2d2b2b`
- Spacing: 4 / 8 / 12 / 16 / 24 / 32
- Radius: 0 / 0 / 0
- Shadows: sm `0 1px 2px rgba(45,43,43,.14)` · md `0 3px 10px rgba(45,43,43,.16)` · lg `0 12px 32px rgba(45,43,43,.22)`
- Type: Archivo 400/600/800

## Assets
No imagery in these screens. Brand mark rendered as a plain 14px accent square in the mocks — if the hexagon mark stays, render it in `accent` at Lucide stroke width. White-label `logo_url` behavior unchanged.

## Files
- `Login Redesign.dc.html` — the design canvas; **options 3a and 3b at the top are the approved pair** (login + dashboard strip + Sales Pivot each). 1a-2b below are rejected explorations.
- `modernist-tokens.css` — the Modernist design-system token sheet (source of the ramps above).
- `3a-modernist-light.png` / `3b-modernist-night.png` — screenshots of the approved pair (login + dashboard strip + Sales Pivot).
