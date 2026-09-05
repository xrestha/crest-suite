# Product

## Platform

web

## Users

Primary: restaurant and hotel owners and managers in Nepal, tracking cost, stock, and staff day to day, mostly across the IMS and HR modules and now POS. They're in the app to make operational calls, not to audit numbers line by line.

Secondary: accountants and bookkeepers doing reconciliation and compliance, verifying purchase entries, vendor payables, TDS/SSF figures, and payroll accuracy rather than making operational decisions. Same data, different intent: they need to trust the exact figure, not just the trend.

## Product Purpose

Crest Suite is a SaaS platform for the Nepal F&B market, covering inventory and costing (purchasing, recipes, variance, stock counts), HR (payroll, attendance, roster, leave, TADA), and POS (ordering, billing) in one product. Success looks like an owner trusting the margin and labor-cost numbers enough to act on them, and an accountant trusting the same numbers enough to file on them.

## Positioning

Cost intelligence plus integrated HR, in one product, where competitors only do one or the other. POS-first rivals (Aegis, Restronp, RestroX) mainly handle billing without real costing depth; outsourced-service competitors (Silverline) provide human bookkeeping instead of software. Crest's edge is combining costing rigor and HR in a single tool an owner actually runs the business from.

## Brand Personality

Approachable, modern, and empowering: the goal is to make a traditionally intimidating domain (accounting, payroll, compliance) feel usable by a non-technical restaurant owner, without diluting the precision the accountant-facing side depends on. Confidence should come from clarity, not decoration.

## Anti-references

Not like legacy Nepali accounting/ERP software: dense, dated, Windows-95-era layouts with no visual hierarchy. Not like generic AI-generated SaaS: purple gradients, Inter-everywhere, templated hero-plus-three-cards layouts that could belong to any product.

## Design Principles

Tool-first, not marketing-first: nearly every screen serves an operational task. There are two deliberate brand-facing exceptions and they are the SIGNED-OUT surfaces — GuestMenu.jsx, which a paying customer sees, and /login, whose job is that a visitor decides and acts rather than completes a task (it carries a real lighting model as of 2026-08-31/S659; /pricing is the obvious third and has not had it yet). Its pitch was rewritten on 2026-09-01/S667 to cover all three modules in POS → IMS → HR order rather than the IMS-only product it had been selling; the module names are deliberately NOT shown as headings, because the labels cost more column height than the page's one-screen budget had left. Copy there is held to a hard constraint worth respecting on any future edit — problem then relief, under ~16 words, two short sentences, no subclauses — because most buyers read English as a second or third language and the failure mode is a subclause a sharp operator skims past, not simplicity. Neither is the norm to extend into the authenticated app without discussion: a dense table under an atmospheric wash is worse than one on a flat ground, which is the whole reason this principle is written down. A third signed-out surface arrived in S672 and is deliberately NOT brand-facing in the same sense: `/legal/terms` and `/legal/privacy` are a contract between Bloom Hospitality Pvt. Ltd. and the customer, so they are the one public surface that does not white-label — the provider names itself there, because the alternative is a filed contract carrying the trading name of the party it binds (S678). The same second-language reader shapes those pages too (S679): each document opens with an "In short" box — five or six plain sentences, each naming the clause it paraphrases — that is page chrome and says so, because the contract text is hashed and every acceptance records that hash, so a reader's aid must never cost a re-acceptance. The summary is a courtesy; the numbered sections are the agreement, and the page says which is which.

Precision over polish: numbers (TDS, SSF, variance, payroll) must read as exact and trustworthy first; approachable framing must never soften or obscure the actual figure.

Serve two literacy levels on one screen: the same page has to satisfy an operationally-minded owner scanning for a decision and a compliance-minded accountant verifying a figure.

Bikram Sambat is the native calendar, not a translation layer: periods, payroll months, roster days and every date a user types are BS first, and a day is *named* the way a Nepali operator says it ("1st Bhadra") rather than reduced to an index into a month the screen has stopped showing. AD appears alongside it where a bank, a vendor or the IRD will ask for it — never instead of it.

Modernize the category on Crest's own terms: differentiate from both the dated local-ERP look and the generic AI-template look, rather than drifting toward either by default.

## Data Ownership

A client's data is theirs and is never destroyed silently. Any client can be exported in full to an Excel workbook plus a restorable file, on request and regardless of subscription state; every destructive admin action takes a backup first and aborts if it cannot; and a departing client is archived (data cleared, logins and record kept, fully restorable) rather than deleted. This is a positioning asset as much as a safety one — "what happens to my data if I stop paying?" is a real objection in this market, and the answer is that it is kept, and can be handed back.

## Accessibility & Inclusion

Standard WCAG AA baseline (contrast, keyboard operability, touch targets). No specific accommodation or regulatory requirement has come up yet.
