---
paths:
  - "src/pages/**"
  - "src/modules/**"
---

# Page layout: the rules a JSX edit needs

Rule statements only, extracted from `.claude/rules/design-system.md` (S770). That file holds the full class list, tokens, motion and the reasoning behind each rule, and auto-loads for CSS files and `src/components/**`; read it before restyling anything.

## Page shell

- The page root takes no padding and no `maxWidth` (`.main-content` already pads it). Open with `.page-header`, adding `page-header--split` when actions sit on the right; never a hand-rolled `<h2>`.
- Fine print under a table or form is `<p className="page-footnote">`: at most two sentences, the problem then the relief. A rule about one control goes on that control (a `Tip`, a confirm body); the rest goes to Help (S805).
- A new POS page is a report unless it is operated during service, and a report gets the product shell (`page-header`, `stat-grid`, `tab-bar`), not a full-screen till layer.

## Stat grids

- Never pin a KPI strip's column count: no inline `gridTemplateColumns: 'repeat(N, 1fr)'`. `.stat-grid` is `auto-fit` over a `minmax` floor; if a tile needs more room, raise the floor in CSS.
- An IMS report's strip takes `stat-grid stat-grid--pair`: two across under 480px, the default 24px value stepped to 18px (S796). HR and POS are not on it yet.
- Build `stat-card` / `stat-label` / `stat-value` / `stat-sub` from `<div>`s, never `<p>`. For the dense tier use `stat-card--compact`; never re-type the card's box properties inline.
- A KPI value never wraps. A text value in a tile takes `nowrap` + ellipsis + `title`. 10px is the floor for real text.
- Dashboard spacing is `dash-section` / `dash-row`; a grid that is also a section takes `stat-grid dash-section`.
- A stat card that opens a page wraps its figure in `button.stat-card__open`; the card keeps the mouse click (S803).
- A form's fields go in `.field-grid` (`.field-grid__wide` for a field that needs two columns), side-by-side panels in `.panel-grid`, a form beside its live summary in `.split-pane`; never an inline track list (S803).

## Tables

- Wrap a wide table in `table-wrap`, plus `table-wrap--fab-clear` when the page also renders a `Fab` (phone-only clearance since S797; `.fab-clear` for a card grid or list). The `Fab` itself goes last in the page header's action group, never at the foot of the page.
- `nowrap` goes on the atom (a date, code, invoice ref, phone, figure, unit, button), never on a whole cell and never as a fixed width. Every table needs one column that can wrap; let names wrap.
- Give the identity column a `min-width` only if that column is also sticky.
- Row density is a table-level class (e.g. `table.purchases-table`), never per-cell inline padding.
- A row given a background tint to flag it takes `className="row-tinted"`, which re-points `--theme-text3` to text2 inside it: Light's text3 fails AA on any tint (S794).
- A long header can take two lines: a `display: block` child inside the `th`.
- A day column names the month: `formatBsDay(day, bsMonth)`, never a bare number. Excel exports keep the numeric column.
- A sortable heading uses `th-sort`, with the `<button>` inside `Tip` and `aria-sort` on the `<th>`.
- Print hides every `<button>`, so a label, heading, badge or value promoted to a button needs its print override in the same change.
- Sorting on a figure computed from an unsaved draft: rows with no draft sort last in both directions; freeze row order when the input takes focus and do not release it on blur; a figure column opens descending.
- When a search hides rows, show "N of M" and make the empty state tell "no match" apart from "nothing here yet".
- Judge fit by measuring `scrollWidth` against `clientWidth` at a resized viewport, using the client's longest real values, never by eye.
- A table whose bottom-line figure falls past a phone's edge gets a `.phone-cards` list beside it (`.phone-only`), and the table takes `.phone-hide` (S796, Purchases' bills and Recipes). One row per record, the figure it exists for on the first line at the right edge, details in a `<details>`, actions last. Feed it the table's own data so the two cannot disagree; it never prints.

## Sticky headers and scroll containers

- `position: sticky` never sticks in the body flow, because `index.css` sets `overflow-x: hidden` on `html, body`. Pages inside the app shell are unaffected.
- A page that renders straight into the body (guest menu, `/login`, `/pricing`) needs its own scrollport: `height: 100dvh; overflow-y: auto; overscroll-behavior: contain`, and no `min-height: 100vh`. Then pass that container as an `IntersectionObserver` root.
- Verify sticky with `getBoundingClientRect().top` across real scroll positions, never by eye.
- A table too wide for one screen gets three sticky anchors: the header (`top: 0`), the identity column (`left: 0`) and the bottom-line column (`right: 0`), as on `Stock.js`'s Summary item table (Item, COGS), `Purchases.js`'s Daily Register (`Total`) and `Sales.js`'s pivot (item name). The corner cell takes the highest `zIndex`, and every sticky cell an opaque `var(--theme-card)` background so scrolled columns don't show through.
- Mute a no-activity row by weight and the anchor cells' colour, never by row opacity, which takes the row below AA (S613).
- State a table's currency once (a `Tip` on the first header, e.g. "All figures in NPR."), never "(NPR)" in every column header.
- Clearance on an `overflow: auto` element is margin, never padding: padding pushes its scrollbar away from the content.
- A layout with a fixed track count, or a flex row of controls, goes in a class with a `screen and (max-width: …)` step (`.bill-header-grid`, `.pair-grid`) or wraps; an inline `gridTemplateColumns` track list, a no-wrap toolbar or `flexShrink: 0` inside a `page-header--split` is how six IMS pages clipped controls on a phone (S794).
- A scroll container around page content prints as one screenful unless the print block resets it to `height: auto; overflow: visible`; a shell breakpoint is `screen and (max-width: …)`, because paper matches a bare width query (S778).
- History: docs/rules-archive/dashboards.md#stock-summary-table-density

## Overlays and scrims

- A scrim belongs only to a dialog that owns a decision (`Modal`). A tool for reading or acting on the page underneath gets no scrim.
- Such a floating panel needs `role="dialog"` without `aria-modal`, a `zIndex` above the dialogs it can open over (the Calculator is 2500, below `Tip`'s 9999), `no-print`, and its own shadow.
- A draggable panel uses `setPointerCapture` on its handle with `touchAction: 'none'`, clamps to the live element size on open and on resize, keeps its position in component state only, and has a separate focusable grip that moves it with the arrow keys.
- A card that holds controls takes no `role="button"`; put the affordance on its children.

## Controls

- `.btn` always takes a colour variant (`btn-primary`, `btn-ghost`, `btn-danger`, `btn-danger--strong`); alone it renders as browser chrome.
- A text input uses `.form-input` (plus `form-input--auto` where it sizes to a toolbar), never `.form-select`, which is for `<select>`.
- The badge set is complete: `badge-green|red|amber|yellow|purple|gray`. `badge-amber` means warning; `badge-yellow` means category in POS only.
- In IMS and HR a figure or a category takes no colour (IMS S796, HR S804; DESIGN.md → The One Signal Meaning Rule): figures `--theme-text1`, codes `--theme-text2`, category chips `badge-gray`, red/amber/green only from a band, threshold or status word, the accent only for what can be pressed or is current. A how-to or plain-fact banner is `.note-banner`.
- On the POS order screen an inline-styled control takes `.till-hit` (square) or `.till-hit--row` for the 44px touch floor and the focus pair, a menu tile `.till-tile`; never an inline `minWidth`/`minHeight`, which beats the class (S776).
- A precondition on an action button is `aria-disabled` plus a press that says what is missing, never `disabled` alone; `disabled` is for an action in flight (S776, the S759 pattern).
- There is no global link style, so an `<a>` sets its own colour: a bare one is the browser's blue, 1.69:1 on the Dark card (S784). Use `--theme-text2` + underline for a quiet in-text link, `--theme-accent-ink` for one that is the action.

## Money and time

- Money goes through `src/shared/nepalMoney.js` (`npr`, `nprInt`, `npr2`, `nprExact`, `nprOrDash`, `nprWords`). Never a local formatter, `en-NP`, or a bare `toLocaleString()` on a number. A missing figure is `—`, never `NPR 0`.
- A clock time goes through `src/shared/nepalTime.js` (`nepalTime` on screen, `nepalTime24` in a spreadsheet cell, `nepalDateAd` on a printed slip), never `toLocaleTimeString`.
- A cell showing a time dates it with `nepalBs(...)`, not `adToBs(new Date(...))`; bucket with `nepalHour` / `nepalCivilDate`, never `.getHours()`. Two times on different days each carry a date.
