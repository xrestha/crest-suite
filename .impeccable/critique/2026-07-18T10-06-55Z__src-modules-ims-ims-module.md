---
target: IMS module (src/modules/ims)
total_score: 24
p0_count: 0
p1_count: 2
p2_count: 2
timestamp: 2026-07-18T10-06-55Z
slug: src-modules-ims-ims-module
---
Method: dual-agent (A: a75cd50199c0e9661 · B: ad7e453cb810bafc3), plus a supplementary authenticated live-browser verification pass by the parent (login credentials supplied mid-run to check pages that were auth-gated during the isolated assessments).

## Design Health Score — Nielsen's 10 Heuristics

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Stock Count's offline-sync banner and Save/Saved toggles are excellent; most other destructive actions (Vendors delete/toggle) give no inline confirmation beyond a silent reload |
| 2 | Match Between System and Real World | 3 | Domain language (BS calendar, FC%, COGS, VAT) is fluent and Tip-annotated; a few unexplained abbreviations slip through (GRN, "CA Summary") |
| 3 | User Control and Freedom | 2 | No undo anywhere; every delete is one `window.confirm()` from irreversible, including whole-period wipes |
| 4 | Consistency and Standards | 2 | Weakest heuristic — identical "expandable row" pattern is keyboard-accessible in one file and not in two siblings; a real CSS class typo ships an unstyled loading state |
| 5 | Error Prevention | 3 | Strong in money-critical paths (returns-over-qty, PO over-receive, requisition-over-stock checks); backstopped only by generic confirm dialogs for the highest-stakes actions |
| 6 | Recognition Rather Than Recall | 3 | `<Tip>` tooltips used with real discipline almost everywhere; icon-only row actions lean on hover-title text |
| 7 | Flexibility and Efficiency of Use | 1 | Zero keyboard shortcuts anywhere; the one real accelerator (Save-and-Next chaining) exists in only 2 of many equally-repetitive entry forms; no bulk actions beyond two nuclear "Delete All" buttons |
| 8 | Aesthetic and Minimalist Design | 3 | Individual pages are well-composed (Overheads.js is a standout); ~5 files independently hand-roll the same explainer-banner styling instead of sharing a component |
| 9 | Error Recovery | 2 | Specific, actionable inline errors exist in places (Items delete-blocked message); other paths use jarring native `alert()` |
| 10 | Help and Documentation | 2 | Help lives entirely in a separate page per convention; no in-context "what is this report for" beyond a one-line subtitle |
| **Total** | | **24/40** | **Acceptable band — competent, dense, real craft in money-critical flows, held back by consistency gaps and near-zero power-user tooling** |

## Anti-Patterns Verdict

**Start here: does this look AI-generated? No.** Both assessments agree — no gradient text, no glassmorphism, no templated hero-plus-cards layout, no numbered marketing eyebrows. Stat-grids size to their own report's real metric count (3–6 cards) rather than a fixed template. This is bespoke, dense, operator-facing software, closer to the "Back-of-House Command Center" north star than to generic SaaS scaffolding.

What both assessments found instead is more interesting and more actionable: **real, specific drift from Crest's own documented DESIGN.md rules**, not hypothetical slop tropes.

**LLM design review (Assessment A)** flagged four concrete rule violations, and I verified two of them live, in the running app, under both the account's actual theme (Bright) and the Dark default:

- **`src/modules/ims/reports/Overheads.js:31`** hardcodes `#60a5fa` for the "Labor Costs" bucket and reuses it at ~4 more call sites (KPI card, tab, P&L bar, per-cover breakdown) as a persistent UI color, not confined to an SVG chart. **I verified this live**: on the account's default Bright theme this blue coincidentally matches the theme's own accent, masking the bug — but switching to the Dark preset (`crest_theme` → `dark`) shows "Fixed Overheads" correctly rendering in the gold accent and "Tax & Fees" correctly in the purple categorical token, while "Labor Costs" stays a rogue blue matching neither. This is exactly the class of bug DESIGN.md calls out by name as having shipped and been fixed once already (a FAB with hardcoded white text, then 4 more components in a dedicated audit) — a third occurrence.
- **`Overheads.js:564`** hardcodes `#0f1117` — the *literal Dark preset's* own `ink-bg` value — as a text color, which will fail contrast on every light-leaning preset (Bright, Latte, Light, Solarized).
- **`src/modules/ims/stockcount/Stock.js`** uses `var(--theme-purple)` for two unrelated categorical columns at once — Staff Meals and Requisitioned. **I verified this live** via computed styles on the Summary tab: both `STAFF MEALS` and `REQUISITIONED` column headers render at the exact same `rgb(167, 139, 250)`. DESIGN.md's rule is that purple carries *one* genuine 4th-category meaning per screen; here a user scanning by color can't tell the two apart without reading every header.
- **`src/modules/ims/reports/VendorReport.js:23`** hardcodes 4 hex values for a plain `<div style={{background}}>` bar segment, justified in a code comment by analogy to the Recharts SVG exception — but the exception's actual stated reason (`var()` doesn't resolve inside SVG presentation attributes) doesn't apply to a div's inline style. Not independently re-verified live in this pass.

**Deterministic scan (Assessment B)**: `detect.mjs --json src/modules/ims` exits 2, 74 findings across 12 of ~49 files. The two assessments independently converged on the same Overheads.js finding from different methods (LLM code-reading vs. static rule match) — good corroboration. The detector's breakdown:

| Rule | Count | Verdict |
|---|---|---|
| `design-system-color` | 61 | **~45 are false positives** — confirmed by reading source: dedicated A4 print-only templates (`GatePassPrint.jsx`, `PurchaseBillPrint.jsx`, `RecipeCostCardPrint.jsx`) and `PurchaseOrders.js`'s print block correctly use literal black/gray for physical paper, which must render the same regardless of on-screen theme — this deserves the same explicit exception CLAUDE.md already grants Recharts SVG props, just not yet written down. A few (`MenuEngineering.js` Recharts props) are the already-documented exception. The **genuine** remainder is `Overheads.js`'s `#60a5fa`/`#0f1117` (confirmed live above) plus a handful of `rgba(107,114,128,·)` "no-data" gray tints used consistently across `BudgetVsActual.js`/`MonthlySummary.js`/`Items.js` — low-risk drift, not slop.
| `design-system-radius` / `font-size` | 10 | `stockcount/Stock.css`'s mobile touch-target values (20px/6px/10px radius, 12/15/20px font) don't map onto DESIGN.md's 8/12/18px radius or Title/Body/Label font ramp — looks like practical mobile-sizing that predates or bypassed the token system, not AI-slop. Real but minor.
| `layout-transition` | 2 | Both are progress-bar `transition: width` (should be `transform: scaleX`) — real instance of the anti-pattern, low real-world impact for a single small bar.
| `side-tab` | 1 | `MenuEngineering.js`'s 4-item BCG-quadrant legend card — a deliberate categorical color-code, not the generic "every card gets a stripe" tell. Likely a false positive given the context.

**Visual/browser evidence**: The actual IMS screens sit behind Supabase auth — neither isolated assessment had credentials, correctly declined to guess or bypass login, and reported this as an expected constraint of an authenticated SaaS product rather than a gap. Assessment B's browser pass was limited to the public `/login` page (detector found 3 unrelated heuristic hits there: `tiny-text` 11px body copy, `overused-font` roboto/arial mix, `gpt-thin-border-wide-shadow` on the card — worth a separate glance but out of scope for this IMS-module critique since `/login` isn't part of the module). After credentials were supplied mid-run, I ran a supplementary live pass myself (outside the two isolated assessments) and directly confirmed the Overheads.js and Stock.js findings above with real computed-style evidence, both under the account's actual Bright theme and after forcing Dark.

## Overall Impression

This is a genuinely competent, densely-functional internal tool, not a template. Its best moments (Overheads.js's break-even panel, the offline-first Stock Count flow, the near-universal explanatory-banner + Tip-tooltip discipline) show real design craft aimed squarely at PRODUCT.md's brand promise — making an intimidating domain (P&L, variance, compliance) legible to a non-technical owner without diluting precision for the accountant reading the same number. The gap isn't taste, it's **discipline drift at scale**: a design system with real, well-reasoned rules (One Accent, rationed purple, Accent-Text Pairing) that a ~49-file, ~9-subdirectory module has quietly broken in a handful of specific, fixable spots, plus near-zero investment in power-user acceleration despite this being the screen a daily user lives in for months. The single biggest opportunity: this module doesn't need a redesign, it needs its own best page (Overheads.js) promoted to reference-implementation status for the others, and its documented token rules actually enforced/lint-checked rather than re-discovered per file.

## What's Working

1. **`Overheads.js` is a genuine design high point** — traffic-light P&L bars, a plain-language break-even sentence, and "Cost per Cover" translating abstract fixed costs into "every sale must earn at least NPR X to break even" do real financial-literacy work for a non-accountant owner. This is the brand promise executed, not just stated.
2. **The explanatory-banner + `<Tip>` tooltip convention is applied with real discipline**, not decoratively — nearly every non-obvious column across the variance/reports cluster carries a specific, concrete explanation (e.g. Items.js's Yield% tooltip gives real examples: "Whole chicken = 70%, Spinach = 60%"), exactly what CLAUDE.md's tooltip rule asks for.
3. **The offline-first Stock Count implementation is production-grade UX engineering** — per-field save serialization to prevent race conditions, a visible pending-sync count, auto-flush on reconnect, and a genuinely separate mobile-card layout solve a real physical-world problem (counting stock in a walk-in freezer with no signal) with obvious empathy for the actual task conditions.

## Priority Issues

**[P1] Inconsistent keyboard/interaction support for the identical "expandable row" pattern across sibling report pages**
- **Why it matters**: `SupplierPriceTracker.js` (lines 365–377) fully implements keyboard accessibility (`role="button"`, `tabIndex`, `onKeyDown`, `aria-expanded`) for its expand-on-click rows; the structurally identical pattern in `VendorReport.js:786` and `OutstandingPayables.js:304` is mouse-click-only. A keyboard-only or screen-reader user is silently locked out of two of the module's most finance-critical drilldowns while the third works fine — a textbook Consistency-and-Standards violation as much as an accessibility one.
- **Fix**: Extract the expand/collapse row into one shared component/hook carrying the SupplierPriceTracker.js treatment; retrofit the other two.
- **Suggested command**: `/impeccable harden`

**[P1] No differentiated confirmation for catastrophic vs. routine destructive actions**
- **Why it matters**: `Purchases.js:184` (`deleteAllPurchases`) and `:191` (`deleteAllReturns`) wipe an entire period's financial history behind one `window.confirm()`, styled identically to a routine single-row delete. There's no typed-confirmation step, no "this affects N records" preview beyond a count in the dialog text, and no soft-delete/undo window — the single highest-consequence gap in the module's error-prevention story.
- **Fix**: Reserve a heavier, distinct confirmation UI (type-the-period-name, or a two-click "Yes, really delete") specifically for whole-period/cascade deletes, separate from routine single-record deletes.
- **Suggested command**: `/impeccable harden`

**[P2] Purple (`--theme-purple`) is overloaded to carry two distinct meanings on the same Stock Count Summary table** *(live-verified: `STAFF MEALS` and `REQUISITIONED` headers both compute to `rgb(167,139,250)`)*
- **Why it matters**: DESIGN.md's rationed-4th-color rule exists precisely so purple reads as "this one specific other thing." Using it for two unrelated data series on the same table dilutes it back into a generic tint and defeats the scan-by-color affordance the badge/token system is built around.
- **Fix**: Keep purple for Staff Meals (already established elsewhere per DESIGN.md); give Requisitioned a neutral/tertiary-text treatment instead.
- **Suggested command**: `/impeccable colorize`

**[P2] Hardcoded, non-token colors in persistent UI in `Overheads.js`, repeating a bug class the codebase already fixed twice** *(live-verified on both Bright and Dark themes)*
- **Why it matters**: `#60a5fa` for Labor (KPI card, tab, P&L bar, per-cover breakdown) and `#0f1117` (the literal Dark-preset ink color) as text both bypass the theme system entirely. On the account's actual Bright theme this happens to look fine by coincidence; forcing Dark shows Labor as a rogue blue next to the correctly-themed gold/purple siblings, and the hardcoded dark text will fail contrast the moment it sits on a light-preset background it wasn't validated against.
- **Fix**: Route Labor through the theme's registered secondary/tertiary token instead of a new ad hoc hex; replace the hardcoded `#0f1117` text with the theme's `accent-text` token per DESIGN.md's existing named rule.
- **Suggested command**: `/impeccable harden`

**[P3] Repeated inline-style duplication has already produced one shipped visual regression**
- **Why it matters**: The amber "how to read this" banner is independently hand-rolled with near-identical (not identical) values in at least 5 files. Separately, `WastageReport.js:196` uses `className="loading-state"`, which does not exist anywhere in `Layout.css` — a live, currently-shipped unstyled loading state, and a preview of where the banner duplication is headed next.
- **Fix**: Extract a shared `<InfoBanner>` component; fix `WastageReport.js`'s loading/empty-state classNames to match the sibling-report convention.
- **Suggested command**: `/impeccable distill`

## Persona Red Flags

**Alex (Power User)** — IMS is exactly the repeated-daily-task surface an expert lives in.
- Zero keyboard shortcuts anywhere across 38 IMS routes.
- The one real accelerator that exists — Save-and-Next/Prev chaining in `Items.js` and `Vendors.js` — isn't extended to Recipes.js's edit form, Purchase Orders, or Requisitions, equally repetitive entry tasks.
- No bulk actions beyond the two nuclear "Delete All" buttons; `Overheads.js`'s per-row category dropdown requires a click-type-tab sequence per line with no paste-from-Excel path, unlike the dedicated Sales/Recipe import flows.

**Sam (Accessibility-Dependent User)** — dense data-table admin surface, the biggest structural risks are linear tab order and color-only signaling.
- The expandable-row inconsistency above (P1) is Sam's primary failure mode.
- `TheoreticalVariance.js`'s row-level variance color-coding (red >5%, amber <-5%, green otherwise) is the *primary* signal for a critical financial finding, with the percentage as the only non-color backup.
- Native `alert()`/`window.confirm()` (31 occurrences across 13 files) break out of the page's themed focus management entirely.

## Minor Observations

- Several files (`Overheads.js`, `Recipes.js`, `Purchases.js`) reinvent the same tab-bar visual treatment with slightly different inline styles instead of the documented `.tab-bar`/`.tab-btn` classes that other files (`WastageReport.js`, `GatePasses.jsx`) already use correctly.
- `stockcount/Stock.css`'s mobile touch-target radius/font values (20px/6px/10px radius, 12/15/20px font) don't map onto DESIGN.md's documented 8/12/18px radius scale or Title/Body/Label font ramp — likely predates or bypassed the token system for practical mobile sizing; worth reconciling rather than treating as an intentional deviation.
- Two `transition: width` progress-bar animations (`Overheads.js:502`, `Stock.css:44`) should be `transform: scaleX` to avoid layout-property animation — low impact, easy fix.
- `VendorReport.js:23`'s 4 hardcoded hex values for a `<div>` background bar misapply the Recharts-SVG exception's actual reasoning to a non-SVG element.
- The print-only templates (`GatePassPrint.jsx`, `PurchaseBillPrint.jsx`, `RecipeCostCardPrint.jsx`, `PurchaseOrders.js`'s print block) legitimately need literal hex for physical paper — worth adding this as an explicit named exception in CLAUDE.md/DESIGN.md alongside the Recharts one, so future detector runs and future contributors don't flag or "fix" it by mistake.
- Not part of the IMS module itself, but the detector's live pass over the public `/login` page found `tiny-text` (11px body copy), an `overused-font` roboto/arial split, and a wide-blur+thin-border combo — worth a separate look since it's the very first thing every user sees, unauthenticated or not.

## Questions to Consider

1. Overheads.js is clearly the module's best-executed page — what would it look like to treat it as the reference implementation (explainer-banner pattern, stat-card sizing, break-even framing) for Variance, Monthly Summary, and VAT Report, instead of each report having independently reinvented its own version of the same idea?
2. If Alex is running this module every day for months, what's the single highest-leverage accelerator — keyboard shortcuts, bulk edit, or extending the existing Save-and-Next pattern to Recipes/POs/Requisitions — that would actually earn their loyalty?
3. Is "Delete All Purchases for this period" a real, frequently-needed feature or a leftover dev-era escape hatch that now sits one confirm dialog away from destroying financial history — and if it's rare, should it be this reachable from where routine editing happens?
