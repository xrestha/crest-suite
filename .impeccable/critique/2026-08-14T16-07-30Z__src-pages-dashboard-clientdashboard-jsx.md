---
target: dashboard
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 1
timestamp: 2026-08-14T16-07-30Z
slug: src-pages-dashboard-clientdashboard-jsx
---
Method: dual-agent (A: design-review agent · B: detector/browser-evidence agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|:---:|-----------|
| 1 | Visibility of System Status | 3 | Skeletons and a live-region loading announcement are solid, but `closeAndAdvancePeriod` has no try/catch — a failed write leaves the button reading "Closing…" forever with zero feedback. |
| 2 | Match Between System and Real World | 4 | Tooltip prose translates accounting mechanics into plain restaurant-owner language while keeping the exact figure front and center. |
| 3 | User Control and Freedom | 2 | The one genuinely consequential action on the page — closing the fiscal period — has no confirmation dialog, and a non-admin can't self-service "reopen" once a newer period exists. |
| 4 | Consistency and Standards | 3 | Strong shared-component adoption (`kpiCard()`, `ChartCard`, `Tip`), but the Category/Items tab implements `role="tablist"`/`role="tab"` without the roving-tabIndex/`aria-controls`/tabpanel wiring DESIGN.md's own Tabs section requires — confirmed independently by both assessments. |
| 5 | Error Prevention | 2 | The partial-period neutral-grey logic is exemplary error prevention for reads; the page's one write action has none of that rigor. |
| 6 | Recognition Rather Than Recall | 4 | Dense, well-written `Tip` coverage on every non-obvious figure. |
| 7 | Flexibility and Efficiency of Use | 2 | Fully keyboard-operable, but no shortcuts, no multi-period comparison in-page, and the tab switch is effectively mouse-only despite its ARIA role promising arrow-key support. |
| 8 | Aesthetic and Minimalist Design | 2 | Individually disciplined components, but a 2-3 module client's composition runs to roughly 19 equal-weight KPI tiles plus 8+ charts/tables with no dominant focal point. |
| 9 | Help Users Recognize, Diagnose, and Recover from Errors | 3 | Section-level error banners are plain-language and retryable — but neither that banner nor the subscription-expiry banner carries `aria-live`/`role="alert"`, so a screen-reader user isn't told either one appeared. |
| 10 | Help and Documentation | 3 | `Tip` tooltips function as real contextual help; no bridge from a tooltip's short gloss to Help.js for a figure an accountant needs to verify in full. |
| **Total** | | **28/40** | **Good — solid foundation; period-close safety and page-level density matter most.** |

## Design Specificity Verdict

**LLM assessment:** Unambiguously authored for Crest Suite, not a reskinned template. BS-calendar weekday ticks computed from `bsToAd(...).getDay()`, NPR formatting throughout, a periodic-inventory-aware "settles at month end" caveat built directly into KPI copy, Nepal F&B benchmark ranges quoted inline in tooltips, and a chart-color system whose reasoning is argued from this product's own semantic palette with measured contrast thresholds per theme preset. The KPI-tile-plus-ChartCard grammar is standard SaaS vocabulary, but DESIGN.md explicitly frames this as "tool-first, not marketing-first," so that's appropriate rather than a specificity failure.

**Deterministic scan:** The CLI detector returned **zero findings** — but that is not the clean bill of health it sounds like, and Assessment B traced exactly why through the detector's own source rather than taking the number at face value. `.jsx` files route to a regex engine, not the full cascade engine used for `.html`/`.astro`/etc.: all 7 page-level analyzers (`single-font`, `flat-type-hierarchy`, `monotonous-spacing`, etc.) are hard-disabled for this extension, most `REGEX_MATCHERS` target literal CSS or Tailwind class strings this file doesn't use, the DESIGN.md color-check only fires when a hex sits directly after a `color:`/`background:`/`fill:` key (this file's chart-palette hexes sit on plain object keys like `purchases: '#c9a84c'`, invisible to that pattern), and the font-size check requires a *quoted* `fontSize:` value while every instance here is a bare number. Only the border-radius check meaningfully applied and passed for real reasons (all 11 `borderRadius` values are `var(--radius-*)` tokens). Net: the automated 0 reflects tool blind spots on this file shape, not confirmed cleanliness — which is exactly why Assessment B's manual structural pass (below) is doing real work the tool couldn't.

**False positives:** None from the CLI (nothing to cross-reference against 0 findings), but B proactively flagged two patterns a naive reviewer *would* flag that DESIGN.md explicitly pre-authorizes: the chart-palette hex values outside the documented color list (justified at length both in DESIGN.md's Colors section and in this file's own inline comments — chart series deliberately take fixed literal hex since `var()` doesn't resolve in SVG), and the Bright-theme-only colorful KPI badges (a named, scoped exception in DESIGN.md's Badges section). Both check out as intentional, not drift.

**Visual overlays:** No user-visible overlay exists this run. Both assessments independently concluded `/dashboard` sits behind Supabase auth with no test credentials available — but rather than stop at that inference, Assessment B actually stood up the real production build behind a static server, drove a real headless Chrome (via the project's own installed Playwright) to `/dashboard` unauthenticated, and confirmed the concrete result: a clean client-side redirect to `/login`, landing on the real public pricing/trial page, zero console errors. No credentials or session state were fabricated. So this is verified behavior, not speculation — just not a screenshot of the dashboard itself, which remains correctly unreachable without a real login.

## Overall Impression

This is well-crafted, product-specific work with real domain empathy — the partial-period verdict logic and the tooltip literacy bridge solve genuine, previously-shipped anxiety problems, not generic polish. But two structural gaps undercut it. First, the one truly consequential click on the page — closing the fiscal period — has less friction than dismissing a tooltip. Second, the page's own growth across modules (six separate inline KPI-grid reimplementations, none reusing the shared `.stat-grid` class, some with different constants than the ones DESIGN.md documents) has quietly pushed "the quick glance page" toward a second working tool, which is exactly the drift the codebase's own architecture notes warn against for this specific route.

## What's Working

1. **The partial-period `verdict()` mechanism.** Withholding red/amber/green judgment on Food Cost %/Net Margin % until day 10 of a period is sophisticated, product-specific empathy — it fixes a real, previously-shipped anxiety bug (an owner buying a month of rice on day 3 shouldn't see a false "investigate immediately" figure), not a generic safeguard.
2. **`Tip` tooltip coverage as a literacy bridge.** Tooltips translate accounting mechanics into plain restaurant-operator language while keeping the exact number visible — directly executing PRODUCT.md's "serve two literacy levels on one screen" principle rather than just stating it.
3. **The chart color-encoding discipline**, and it's now evidence-backed twice over: a projection line shares its metric's hue and is told apart by dash pattern, a frozen target deliberately breaks that rule with its own hue plus a dotted glyph — reasoned at length in the file's own comments, and independently confirmed by Assessment B as matching DESIGN.md's own documented exception for chart palettes, not undocumented drift.

## Priority Issues

**[P0] Closing the fiscal period has no confirmation and no error handling**
- **What:** The period-close button calls `closeAndAdvancePeriod()` directly on click, with no confirmation dialog beforehand and no try/catch around its two writes.
- **Why it matters:** This is the single highest-stakes state change reachable from this page — and per this codebase's own documented behavior, a non-admin can't self-service "reopen" a past period once a newer one is open, so a mis-click locks the owner into a state only admin can undo. If either write throws, the busy flag never resets and the button is stuck reading "Closing…" forever with no error shown.
- **Fix:** Gate the click behind a real confirmation using the shared `Modal` component (matching how other destructive actions confirm in this codebase), and wrap the writes in try/catch/finally so the busy state always resolves and a failure surfaces the same retryable error pattern already used for this page's read failures.
- **Suggested command:** /impeccable harden

**[P1] Page-level density at 2-3 modules undercuts the page's own "quick glance" purpose**
- **What:** A multi-module client's composition can run to roughly 19 KPI tiles across separate pill rows plus 8+ charts and tables, all rendered with identical visual weight.
- **Why it matters:** This route is documented elsewhere in the codebase as "the quick glance one," explicitly distinct from HR's "working tool" and Owner Dashboard's "strategic" surface. A 2-3 module owner glancing between service rushes gets a long, undifferentiated scroll instead — the aesthetic-minimalism failure DESIGN.md warns against, playing out at composition scale rather than per-component.
- **Fix:** Give each module section one headline tile with more visual weight than its peers, and consider collapsing the denser secondary KPI row behind a disclosure so the default glance is shorter — applying the same progressive-disclosure instinct `ChartCard`'s own compact/expand pattern already uses well.
- **Suggested command:** /impeccable distill

**[P2] Screen-reader navigation breaks at three compounding points**
- **What:** Three independent gaps stack on the same user journey: every `ChartCard` title (Daily Purchases vs Sales, Spend by Category, etc.) renders as a styled `<div>`, not a real heading; when a page has only one module, it also skips straight from the page's one `<h1>` to `<h3>`s with no `<h2>` in between; and the Category/Items tab row sets `role="tablist"`/`role="tab"`/`aria-selected` but has no `aria-controls`, no `role="tabpanel"` on the content, and no roving `tabIndex` — so arrow keys do nothing despite the ARIA role implying they should.
- **Why it matters:** A screen-reader user navigating by heading structure has no jump-path to any chart on the page at all, and a keyboard user who reaches the tab row gets an accessibility contract the markup doesn't deliver on. DESIGN.md's own Tabs section names this exact roving-tabIndex gap as a known, previously-warned-about failure mode.
- **Fix:** Have `ChartCard` render its title as an `<h3>` (matching one level under the module `<h2>`s), and complete the tablist wiring — `aria-controls`/`id`/`role="tabpanel"`/`aria-labelledby`, plus roving `tabIndex` with arrow-key handling.
- **Suggested command:** /impeccable harden

**[P2] Two async status banners appear with no live region**
- **What:** The per-section load-error banner and the subscription-expiry banner both render conditionally after an async fetch resolves, but neither message carries `role="alert"`/`role="status"`/`aria-live` — unlike this same page's initial loading state, which correctly uses `role="status" aria-live="polite"`.
- **Why it matters:** A screen-reader user gets no signal that either banner appeared — on a page whose whole premise is trusting the numbers enough to act on them, silently missing a "this data may be stale" or "your subscription is expiring" notice is a real gap, not a cosmetic one.
- **Fix:** Add the same `role="status"`/`aria-live="polite"` (or `role="alert"` for the error case) already used correctly elsewhere on this exact page.
- **Suggested command:** /impeccable harden

**[P2] Six KPI grids bypass the shared `.stat-grid` class and reimplement it with different constants**
- **What:** None of this page's KPI grids reference the documented `.stat-grid` class; instead six separate inline blocks each hand-roll `repeat(auto-fit, minmax(140px, 1fr))` at `gap: 10`, versus `.stat-grid`'s documented `minmax(180px, 1fr)` at 16px gap.
- **Why it matters:** This is real, silent design-system drift with a maintenance cost: a future tuning pass on `.stat-grid` (spacing, floor width) will never reach this page's KPI rows, and the 10/12/14px gaps used throughout sit off DESIGN.md's documented 4/8/16/24 spacing scale.
- **Fix:** Point these six blocks at the shared `.stat-grid` class (or give it a documented variant if 140px/10px is genuinely the right density here — but make that a deliberate, named exception rather than six silent reimplementations).
- **Suggested command:** /impeccable layout

## Persona Red Flags

**Alex (Power User):** The KPI row gives no fast entry point — five to six headline cards share identical sizing with nothing signaling which number to check first. Opening a chart requires a mouse click on its expand icon with no shortcut, and charts can only be read one at a time. The Daily Purchases vs Sales legend can carry six conditional chips across three stroke styles over two hues — a lot to decode for what's meant to be a fast read. No in-page way to compare against a prior period; leaving the page is required.

**Sam (Accessibility-Dependent):** KPI cards get a real, correctly-styled focus ring on tab — genuinely solid. But the Food Cost %/Net Margin % verdict colors (good/watch/high) are conveyed by color alone on the headline card itself, with the text legend for that scale living on a different chart several sections away. The chart's expand-to-modal flow has real dialog semantics (focus trap, Escape, focus restore) — another genuine strength. But as above: no heading path to any chart, and the tab row's ARIA promises keyboard behavior it doesn't deliver.

**Riley (Stress-Tester):** `CHART_COLORS` is a fixed 8-hex array cycled by index for both the category pie and the top-items bar — any client with 9+ purchase categories (entirely plausible: produce/dairy/meat/dry goods/beverage/packaging/cleaning/paper/spices) gets a 9th category rendered in the exact same color as its 1st. Nearly every read path on this page threads a stale-response guard to survive an admin "view as" client switch mid-fetch — a pattern that exists because this bug was found and fixed before — but the period-close write path has no equivalent guard, worth stress-testing specifically.

## Minor Observations

- Cached figures (via `dashboardCache`) repaint silently on a background refresh — no timestamp, no transition, nothing distinguishing a stale number from a fresh one before or after the swap, on a page whose value proposition is trusting the numbers.
- `chart-stat-strip`'s stagger animation is only defined for its first 3 children in CSS, but the expanded Daily Purchases vs Sales strip can render up to 7 `StatPill`s — items 4-7 likely pop in at 0ms while 1-3 stagger, reading as unfinished rather than deliberate.
- Up to four independently-conditioned banners (load error, subscription expiry, first-run/no-period, period-expired) aren't mutually exclusive as a set — a new trial client with a load failure could see all four stacked before any real content.
- `netMarginCard` has no upsell fallback where sibling cards do; on inspection this looks intentional (a neighboring card's copy already covers both metrics in one message), but that combined message doesn't appear in the trimmed multi-module top row where `netMarginCard` itself is missing from.

## Questions to Consider

1. The codebase's own documentation calls this route "the quick glance one," distinct from HR's "working tool" and Owner Dashboard's "strategic" surface — does a 3-module, ~19-tile composition still earn that name, or has incremental per-module addition quietly turned it into a second working tool with nothing left playing the fast-daily-check role?
2. `verdict()` goes to real lengths to prevent a false alarm on a KPI color — what's the equivalent safeguard for the one unambiguously consequential click on this page?
3. If a screen-reader user can already get a full narrative of every chart via the existing `sr-only` summaries, why do the two headline verdict colors — arguably the numbers an owner most needs a plain-language read on — rely on color alone?
