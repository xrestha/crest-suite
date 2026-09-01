# Original README head — archived

The head of `README.md` exactly as it stood before the file was split: lines 1—164
of the 15,364-line original, at commit `198d20a`. Kept verbatim and **not corrected**.

**Every claim below is stale.** The business name, the App Overview, the Plans table,
the Routes table and the "Pending Features" backlog all describe an IMS-only product
that stopped being what this app is somewhere around S193. It is archived rather than
edited because a wrong table is easier to recognise as history than as a correction
nobody re-checked — `DOCS-REMEDIATION.md` T2 replaces the route table and the
commercial table on their own terms.

Do not cite anything below as current. For what is true now: `README.md` for the map,
`CLAUDE.md` and `.claude/rules/` for architecture, `PRODUCT.md` for positioning,
`src/data/pricingPlans.js` for pricing.

---

# Crest Suite — Project README

**Client:** Aashish Shrestha | **Business:** Crest Hospitality | **Pilot:** Casa Acai Cafe, Kathmandu  
**Stack:** React (CRA) · Supabase (PostgreSQL + Auth) · Vercel · SheetJS · Recharts  
**Repo:** `C:\crest-suite` | **E Drive Backup:** `E:\CREST SUITE MANAGEMENT\`

---

## Quick Start

```bash
npm start           # Dev server → http://localhost:3000
npm run build       # Production build (this is what Vercel runs)
npm run build:verify  # Same build, for checking a change locally: clears the stale
                      # ESLint cache first and treats warnings as errors. Use this
                      # while `npm start` is running — the two share
                      # node_modules/.cache, and a dev server writing stale entries
                      # back is what produces build errors that are not in the code.
```

**Env vars required:**

```text
REACT_APP_SUPABASE_URL
REACT_APP_SUPABASE_ANON_KEY
REACT_APP_USDA_API_KEY
REACT_APP_VAPID_PUBLIC_KEY
```

`REACT_APP_SUPABASE_SERVICE_ROLE_KEY` must never be set here or in Vercel — admin operations go through the `admin-user-ops` Supabase Edge Function instead (see S311).

---

## App Overview

Hospitality inventory & food cost management SaaS for Nepal's F&B industry.  
Works natively in Bikram Sambat (BS) calendar · NPR currency · FonePay payment tracking.

### Plans

| Plan | Monthly | Annual /mo | Includes |
| --- | --- | --- | --- |
| Starter | NPR 5,000 | NPR 3,750 | Dashboard, Items, Vendors, Periods, Purchases, Stock, Help + Sales Entry, Payment Summary, Monthly Summary, Annual Summary, Reorder Report, Stock Movements, VAT Report, Non-VAT Report, Wastage Report, Settings, Stock Report, Menu Pricing |
| Growth | NPR 8,000 | NPR 6,000 | + Recipes, Variance, Budget vs Actual, Best Sellers, Purchase Orders, Requisitions, Dead Stock, Recipe Margin, Outstanding Payables, Staff Meals, Menu Repricing |
| Pro | NPR 12,000 | NPR 9,000 | + Menu Engineering, FIFO, Vendor Report, Vendor Balance Confirmation, Supplier Price Tracker, Overheads, Period Comparison, Theoretical Variance, Shrinkage Report, Fixed Assets |

Starter: 1-month free trial. Annual = 25% off monthly.

---

## Routes

| Route | Plan | Feature Flag |
| --- | --- | --- |
| `/dashboard` | All | — |
| `/periods` | All | — |
| `/items` | All | — |
| `/vendors` | All | — |
| `/purchases` | All | — |
| `/stock` | All | — |
| `/help` | All | — |
| `/pricing` | Public (no auth) | — |
| `/sales` | **Starter+** | `sales_entry` |
| `/payments` | **Starter+** | `payment_summary` |
| `/summary` | **Starter+** | `monthly_summary` |
| `/annual-summary` | **Starter+** | `annual_summary` |
| `/reorder` | **Starter+** | `reorder_report` |
| `/stock-movements` | **Starter+** | `stock_movement_log` |
| `/vat-report` | **Starter+** | `vat_report` |
| `/non-vat-report` | **Starter+** | `non_vat_report` |
| `/wastage-report` | **Starter+** | `wastage_report` |
| `/settings` | **Starter+** | `settings` |
| `/recipes` | Growth+ | `recipe_costing` |
| `/variance` | Growth+ | `variance_report` |
| `/payables` | Growth+ | `outstanding_payables` |
| `/budget` | Growth+ | `budget_vs_actual` |
| `/requisitions` | Growth+ | `requisitions` |
| `/dead-stock` | Growth+ | `dead_stock` |
| `/recipe-margin` | Growth+ | `recipe_margin` |
| `/best-sellers` | Growth+ | `best_sellers` |
| `/purchase-orders` | Growth+ | `purchase_orders` |
| `/period-comparison` | Pro | `period_comparison` |
| `/shrinkage` | Pro | `shrinkage_report` |
| `/menu-engineering` | Pro | `menu_engineering` |
| `/fifo` | Pro | `fifo_report` |
| `/vendors-report` | Pro | `vendor_report` |
| `/supplier-prices` | Pro | `price_tracker` |
| `/overheads` | Pro | `overheads` |
| `/theoretical-variance` | Pro | `theoretical_variance` |
| `/admin/clients` | Admin only | — |
| `/admin/audit` | Admin only | — |
| `/stock-report` | **Starter+** | `stock_report` |
| `/menu-pricing` | **Starter+** | `menu_pricing` |
| `/menu-repricing` | Growth+ | `menu_repricing` |
| `/pos` | posEnabled (manager+) | — |
| `/pos/login` | Public (no auth) | — |
| `/pos/tables` | posEnabled (supervisor+) | — |
| `/pos/staff` | posEnabled (manager+) | — |

---

## Pending Features

### Reports Backlog

- **Done (S62):** Wastage Report — `/wastage-report`, Starter+, period wastage by item/category with NPR value and % of total
- **Done (S62):** Dead Stock / Slow Movers — `/dead-stock`, Growth, Dead=Used=0 / Slow=Used<20% of available; Value at Risk
- **Done (S63):** Recipe Contribution Margin — `/recipe-margin`, Growth, (Selling Price − Food Cost) × Qty Sold; sort by contribution/margin/FC%
- **Done (S63):** Period-over-Period Comparison — `/period-comparison`, Pro, FC%/COGS/Revenue side-by-side; ↑↓ pp trend vs prev period
- **Done:** Annual Summary — `/annual-summary`, Starter+, rollup of all monthly_periods in a BS fiscal year
- **Done:** Outstanding Payables — `/payables`, Growth, aging buckets (Current/31–60/61–90/90+), grouped by vendor, Mark Paid button. DB migration run ✓ (`paid_at date` column added to `purchase_entries`)
- **Done:** Shrinkage Report — `/shrinkage`, Pro, last 3/6/12 closed periods selector, actual vs theoretical usage, Consistent/Occasional/Once/Clear status badges. No DB change needed.

### Features Backlog

- **Done (S61):** PWA — installable shell. `manifest.json` updated (name, colors, scope), `public/service-worker.js` added (cache-first for assets, network-first for navigation, never caches Supabase calls), registered in `src/index.js`. Icons: replace `public/logo192.png` + `public/logo512.png` with actual Crest logo at those sizes.
- **Done (S97):** PWA offline stock count — IndexedDB cache + sync queue; counts entered offline are queued and flushed automatically on reconnect
- **Done (S93):** Staff meal & complimentary tracking — `staff_meals` table, new tab in Stock Count, deducted from Used/COGS separately from wastage. Staff Meals column added to Stock Summary and Monthly Summary. Variance updated. Growth plan, `staff_meals` flag. DB migration run ✓
- **Done (S96):** Mobile-first stock count UX — responsive sidebar (hamburger + overlay), card list, category pill strip, progress bar, fixed Save All bar on mobile
- **Open (S606):** White-label logo on public pages — `Login.js`, `ResetPassword.js` and `Pricing.js` render the `Hexagon` fallback unconditionally while still reading `settings.app_name`, so a white-labelled client sees their own brand name beside Crest’s generic mark on the page they log in through. The sidebar already has the `settings.logo_url` conditional; these three never adopted it.
- **Deferred (client):** Owner Dashboard — mobile-first single-page P&L view
- **Deferred (client):** Role-based users Owner/Manager

### Crest Suite — One Codebase, Three Modules

Architecture: single React app, single Supabase project, feature flags per client. Sell IMS / HR / POS individually or as a bundle.

| Module | Status | Routes |
| --- | --- | --- |
| Crest IMS | ✅ Live | All existing routes |
| Crest HR | ✅ Live | `/hr/dashboard`, `/hr/employees`, `/hr/pay-setup`, `/hr/attendance`, `/hr/leave`, `/hr/holidays`, `/hr/overtime`, `/hr/payroll`, `/hr/reports`, `/hr/festival`, `/hr/advances`, `/hr/gratuity`, `/hr/settlement`, `/hr/roster` |
| Crest POS | 🔧 Building | `/pos` (setup/activation, manager+), `/pos/login` (public PIN picker), `/pos/tables` (supervisor+), `/pos/staff` (manager+); Orders, KOT, Billing, Shifts next |

**Pricing** (single source of truth: `src/data/pricingPlans.js` — also feeds Help's Plan & Pricing tab, the public `/pricing` page, and Admin Settings > Plan Pricing, S380):

| Module | Starter | Growth | Pro |
| --- | --- | --- | --- |
| Crest IMS (tiered) | NPR 2,000/mo | NPR 2,600/mo | NPR 3,500/mo |
| Crest HR (flat, no tiers) | NPR 2,600/mo | — | — |
| Crest POS (flat, no tiers) | NPR 2,000/mo | — | — |

| Add-on | Monthly | Annual /mo |
| --- | --- | --- |
| **Crest Suite Pro** (per outlet, requires IMS) | +NPR 2,000 | +NPR 1,500 |

Crest Suite Pro is an **add-on bought on top of the modules above**, not a bundle that contains
them (changed S548). It was three tiers priced at ~20% off the sum of all three modules, but both
`SuiteGate` call sites were `minTier="growth"` — so **Suite Starter unlocked nothing at all**, and
Suite Pro added nothing over Suite Growth on its own axis. `suite_plan` is now `NULL | 'pro'`.

It carries seven features: Owner Dashboard, Monthly Owner/Manager Report, Multi-Outlet Group
Console, Demand Forecast, Fixed Assets, Consolidated P&L (`/pnl`, S581 — per outlet and
consolidated) — plus scheduled report delivery, the one still on the roadmap. Sold **per outlet**, including inside a group: the Group Console rolls up exactly
those outlets whose `suite_plan = 'pro'` and names the ones it excluded.

Annual = 25% off monthly, applied uniformly everywhere annual pricing appears.

**Module flags on `clients` table:** `ims_enabled` (DEFAULT true), `hr_enabled` (DEFAULT false), `pos_enabled` (DEFAULT false, column added S193). Tier lives in `clients.plan` and applies to **IMS only** — HR and POS are yes/no modules with no tiers. `hr_plan`/`pos_plan` still exist as columns but are vestigial and read by nothing (S548); `ims_plan` was listed here for a long time and **has never existed at all**.  
**Admin UI:** AdminClients → **card module strip** — toggle IMS/HR/POS directly on each client card; Billing tab = live toggles + plan selector + subscription date per module (POS wired S193)  
**Route guard:** `src/components/ModuleGate.js` — wraps all IMS, HR, and POS routes in App.js; redirects to `/dashboard` when module is off (admin always bypasses)  
**POS role system (added S195):** `pos_role` column on `profiles` (`staff` / `supervisor` / `manager`). `hasPosAccess(minLevel)` in AuthContext. POS sidebar hidden entirely for users with no role. Tables → supervisor+; Staff → manager+. Crest admin always bypasses.

---
