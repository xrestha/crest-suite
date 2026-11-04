# Product

## Platform

web

## Users

Primary: restaurant and hotel owners and managers in Nepal, tracking cost, stock, and staff day to day, mostly across the IMS and HR modules and now POS. They're in the app to make operational calls, not to audit numbers line by line. Some run more than one outlet as a group, a café with a Pokhara branch or a central kitchen feeding satellites, and need every outlet on one screen without a second login.

Tertiary: floor and store staff — a waiter on the till, a cashier on the counter, an employee checking a payslip, a store-keeper counting a shelf. They reach the product on a shared device with a 4-digit PIN, do one task, and are the only users who never chose it. The waiter and the cashier are not one person in a busy outlet and their screens should not be one screen — the waiter is standing at a table with the order open, the cashier is holding a guest who just asked for the bill (S762). Design for the thumb, the interruption and the person who will not report a bug: a control they cannot use is not a smaller problem than a wrong number, it is the same problem arriving as "the app is broken".

Secondary: accountants and bookkeepers doing reconciliation and compliance, verifying purchase entries, vendor payables, TDS/SSF figures, and payroll accuracy rather than making operational decisions. Same data, different intent: they need to trust the exact figure, not just the trend.

## Product Purpose

Crest Suite is a SaaS platform for the Nepal F&B market, covering inventory and costing (purchasing, recipes, variance, stock counts, and stock transfers between a group's outlets), HR (payroll, attendance, roster, leave, TADA), and POS (ordering, billing, and — as the paid Crest Customization add-on — sizes, extras, build-your-own dishes guests assemble, and combos sold at one price) in one product. On top sits Crest Suite Pro, a paid owner layer priced per outlet: the Owner Dashboard, the frozen Monthly Owner Report, Consolidated P&L, the multi-outlet Group Console, Demand Forecast and Fixed Assets. These are the pages that read across modules and outlets. Success looks like an owner trusting the margin and labor-cost numbers enough to act on them, and an accountant trusting the same numbers enough to file on them.

## Positioning

Cost intelligence plus integrated HR, in one product, where competitors only do one or the other. POS-first rivals (Aegis, Restronp, RestroX) mainly handle billing without real costing depth; outsourced-service competitors (Silverline) provide human bookkeeping instead of software. Crest's edge is combining costing rigor and HR in a single tool an owner actually runs the business from.

## Plans and packaging

What a client buys, and why each piece sits where it does (S879). This section names no prices on purpose: Crest support changes them on Admin → Settings → Plan Pricing, so a figure written here would be wrong the first time someone repriced, and someone would quote it.

**What is sold.**

- **Crest IMS** comes in three plans: Starter, Growth and Pro. "The client's plan" (`clients.plan`) always means the IMS plan and nothing else.
- **Crest HR** and **Crest POS** are each switched on or off, with no plans of their own: one flat price each.
- **Crest Customization** (sizes, extras, build-your-own dishes, combos) is a flat add-on on top of POS.
- **Crest Suite Pro** is an add-on charged per outlet, on top of whatever modules the outlet has. It is not a bundle that replaces them. It needs IMS switched on, and says nothing about which IMS plan, or whether HR or POS is on. It has one level only. It holds the six owner pages: Owner Dashboard, Monthly Owner Report, Consolidated P&L, Group Console, Demand Forecast and Fixed Assets.
- **Paying yearly** gives the same discount on every line, Suite included.
- **A new self-service signup** gets a short free trial (`TRIAL_DAYS`; 7 days when this was written) and waits for Crest to approve it.

**What each plan is for.** Each plan sells one job:

- **Starter = Record and Comply.** Write down what happened and stay legal: sales, purchases, stock counts, wastage, the VAT and non-VAT reports, the vendor balance confirmation (IRD Annexure 13), payables.
- **Growth = Control.** Keep cost in check day to day: recipe costing, variance, reorder levels, budgets, purchase orders, requisitions, overheads.
- **Pro = Strategy.** Decide what to change: menu engineering, period comparison, shrinkage, supplier analysis, stock ageing.
- **Crest Suite Pro = Synthesis.** Read across modules and outlets at the owner's level.

Three rules follow, and each was broken once before it was written down:

- **A feature sits in a plan whose own data can produce its number.** A report built on recipes cannot be Starter, because Starter has no recipes; Starter clients were once sold a Reorder Report that could never show a figure.
- **A legal obligation is never above Starter.** Filing VAT or Annexure 13 is not an upsell.
- **A page where data is typed in never sits above a figure that reads it.** Otherwise the figure shows blank on the cheaper plan with no explanation.

**Where the facts live.**

- **Live prices:** Admin → Settings → Plan Pricing. They are laid over the shipped defaults in `src/data/pricingPlans.js`, and every screen that shows money reads the result. The money a client pays each month is worked out in `src/shared/clientMrr.js` only.
- **Which plan each page needs:** [ROUTES.md](ROUTES.md), generated from the code. `npm run check:docs` fails when a page's plan disagrees between the plan lists, the page and the menu.
- **The detailed reasoning** behind the plans: `.claude/rules/access-control.md`.

**Moving a feature to a higher plan.** Clients who already use it must keep it: grant it to them through their feature switches in the same release.

**Open question: the POS price (recorded 2026-11-04, nothing decided).** POS is one flat monthly fee, about what a plain billing app charges in this market. But Crest's POS does things a billing app cannot:

- each closed bill takes its stock down by the recipe;
- a free dish is valued at what it cost;
- the database itself records who gave each discount, void or free dish.

Whether the price should say so is a decision for the owner. The figure itself is changed on the Plan Pricing screen, with no code change.

## Origins

*Rebuilt from the code history on 2026-11-04, not from memory; the owner has been asked to read and correct it. Where a reason was never written down, this says "the reason is not recorded".*

**What survives.** The first commit, "Initial commit - Crest Inventory v1", is dated 2026-06-10. The next one (2026-06-19, `deb836e`) bundles everything built since. The work log has short entries for S23 to S33 and full ones from S34 (2026-06-17); S1 to S22 are not recorded anywhere.

**1. From Crest Inventory to Crest Suite.** It began as Crest Inventory, a stock and food-cost tool (IMS), piloted at Casa Acai Cafe, Kathmandu. On 2026-06-18 (S57) the plan was for HR and POS to be *separate products*. Two days later (S83, `8a83d6f`) a planning document reversed that: "One codebase. One database. Feature flags per client." S100 (2026-06-21) confirmed one React app, one Supabase project, one Vercel deployment, and started HR. POS followed from S193 (2026-06-30). The app was renamed Crest Suite on 2026-07-13 (`d9675f6`). Why the separate-products plan was dropped: the reason is not recorded.

**2. One shared database, many businesses.** The product was never single-client. The very first schema already had a `clients` table, a `client_id` on each login's profile and on every main table, an admin role that sees all clients, and Row Level Security on all 13 tables, using a helper, `my_client_id()`, that reads the signed-in user's client. Child rows (stock counts, purchases, daily sales, recipe ingredients) had no `client_id` and took it from their parent month or recipe; they still work that way. Each login belonged to one client until 2026-08-12 (`6392252`), when multi-outlet groups added `profiles.active_client_id` so one login can switch between outlets in its group (each outlet is its own client row); that migration records why. The shared browser-side filter (`useScopedDb`) arrived on 2026-07-05; before that every page wrote its own. Why one shared database rather than one per business: the reason is not recorded.

**3. Table names.** There is no single prefix scheme. The 2026-06-20 planning document proposed `shared_`, `ims_`, `pos_` and `hr_` prefixes "to avoid naming conflicts", but that scheme was never built (the log says so at S250). What exists: the original inventory and core tables have no prefix (`clients`, `profiles`, `items`, `vendors`, `purchase_entries`). HR tables start `hr_`, POS tables `pos_`. A few inventory tables added from July 2026 use `ims_` (the first was `ims_gate_passes`), and fixed assets use `assets_`. No `shared_` table has ever existed. Why the inventory tables were never renamed: the reason is not recorded.

**4. The stack.** Create React App, React 19 and Supabase are in the first commit. Vercel has hosted it since the first production deploy (S74, 2026-06-19); `vercel.json` was added two days later because browsers kept loading an old copy of the app (S95). Why these three were chosen: the reason is not recorded.

**5. Bikram Sambat.** BS was there from the first commit. A trading month is a BS year and month, and entries store the BS day (1 to 32) as a number. The exact BS month-length table (`src/utils/bsCalendar.js`) arrived by S41 (2026-06-17), and the Nepal fiscal year (Shrawan to Ashadh) first appeared in Annual Summary (S84, 2026-06-20). The planning document lists BS as a critical Nepal requirement; nothing fuller is recorded. The original monthly tables store BS numbers; some later tables store ordinary dates converted from BS, so check each table.

**6. "Admin" means Crest, not the customer.** The first version had two roles, `admin` and `client`, and the admin's sidebar read "Consultant"; S40 (2026-06-17) made it a "pure consultant account" tied to no business. That is why `isAdmin` means the Crest operator, and the business owner is a separate, later idea.

**7. Schema history before 2026-07-05 is not in migration files.** Until then, database changes were pasted into the Supabase SQL editor by hand. S249 dumped the live database into the baseline migration because the old schema file had gone stale. Anything older can be traced only through the work log.

**Gaps the owner may be able to fill.** Why one shared database rather than one per business; what changed the
plan from separate HR and POS apps to one app in two days; why Create React App, Supabase and Vercel; whether
leaving the original inventory tables without a prefix was a choice; and what sessions S1 to S22 built.

## Brand Personality

Approachable, modern, and empowering: the goal is to make a traditionally intimidating domain (accounting, payroll, compliance) feel usable by a non-technical restaurant owner, without diluting the precision the accountant-facing side depends on. Confidence should come from clarity, not decoration.

## Anti-references

Not like legacy Nepali accounting/ERP software: dense, dated, Windows-95-era layouts with no visual hierarchy. Not like generic AI-generated SaaS: purple gradients, Inter-everywhere, templated hero-plus-three-cards layouts that could belong to any product.

## Design Principles

Tool-first, not marketing-first: nearly every screen serves an operational task. There are two deliberate brand-facing exceptions and they are the SIGNED-OUT surfaces — GuestMenu.jsx, which a paying customer sees, and /login, whose job is that a visitor decides and acts rather than completes a task (/pricing is the obvious third). /login carried a real lighting model from 2026-08-31/S659 until the Modernist re-theme removed it on 2026-09-07/S689: three radial layers, each a percentage mix of the accent, which read as light under a muted brass and as a brown cast the moment the accent became a saturated red. **A rig built as percentages of the accent is only ever as neutral as the accent is** — worth knowing before the next one is proposed. What carries the page now is rule WEIGHT (2px section, 1px row) on a flat ground, which is the whole Modernist thesis and survives a palette change. Its pitch was rewritten on 2026-09-01/S667 to cover all three modules in POS → IMS → HR order rather than the IMS-only product it had been selling; the module names are deliberately NOT shown as headings, because the labels cost more column height than the page's one-screen budget had left. Copy there is held to a hard constraint worth respecting on any future edit — problem then relief, under ~16 words, two short sentences, no subclauses — because most buyers read English as a second or third language and the failure mode is a subclause a sharp operator skims past, not simplicity. Neither is the norm to extend into the authenticated app without discussion: a dense table under an atmospheric wash is worse than one on a flat ground, which is the whole reason this principle was written down — and as of S689 the signed-out pages are flat too, so the gap it guarded is now one of density and copy rather than of atmosphere. A third signed-out surface arrived in S672 and is deliberately NOT brand-facing in the same sense: `/legal/terms` and `/legal/privacy` are a contract between Bloom Hospitality Pvt. Ltd. and the customer, so they are the one public surface that does not white-label — the provider names itself there, because the alternative is a filed contract carrying the trading name of the party it binds (S678). The same second-language reader shapes those pages too (S679): each document opens with an "In short" box — five or six plain sentences, each naming the clause it paraphrases — that is page chrome and says so, because the contract text is hashed and every acceptance records that hash, so a reader's aid must never cost a re-acceptance. The summary is a courtesy; the numbered sections are the agreement, and the page says which is which.

Precision over polish: numbers (TDS, SSF, variance, payroll) must read as exact and trustworthy first; approachable framing must never soften or obscure the actual figure.

Serve two literacy levels on one screen: the same page has to satisfy an operationally-minded owner scanning for a decision and a compliance-minded accountant verifying a figure.

Teach by doing, for someone new to computers (S790): many owners in this market run their lives on a phone and meet a desktop-style app for the first time with Crest. Guidance ticks when the real thing is saved, never when a page was merely opened, because looking at a screen feels like learning without being learning; it is a short list, one part at a time, never a tour that starts by itself; every step can be skipped and the list put away; and the person to call is one tap away, because for a first-time user a human helper beats any screen. English feature names stay exactly as the screen prints them, so owner, staff and support say the same words. The setup guide (`src/shared/onboarding/`) is the worked example.

Bikram Sambat is the native calendar, not a translation layer: periods, payroll months, roster days and every date a user types are BS first, and a day is *named* the way a Nepali operator says it ("1st Bhadra") rather than reduced to an index into a month the screen has stopped showing. AD appears alongside it where a bank, a vendor or the IRD will ask for it — never instead of it.

Modernize the category on Crest's own terms: differentiate from both the dated local-ERP look and the generic AI-template look, rather than drifting toward either by default.

## Data Ownership

A client's data is theirs and is never destroyed silently. Any client can be exported in full to an Excel workbook plus a restorable file, on request and regardless of subscription state; every destructive admin action takes a backup first and aborts if it cannot; and a departing client is archived (data cleared, logins and record kept, fully restorable) rather than deleted. This is a positioning asset as much as a safety one — "what happens to my data if I stop paying?" is a real objection in this market, and the answer is that it is kept, and can be handed back.

## Accessibility & Inclusion

Standard WCAG AA baseline (contrast, keyboard operability, touch targets). No specific accommodation or regulatory requirement has come up yet.
