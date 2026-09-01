# Crest Suite

Multi-tenant hospitality SaaS for Nepal's F&B industry. One React app on one Supabase project;
inventory, HR and POS are modules toggled per client.

**Repo:** `C:\crest-suite` · **E-drive backup:** `E:\CREST SUITE MANAGEMENT\`

**This file is a map, not a summary.** Everything below points somewhere; nothing here restates
what it points at. A line that describes rather than points is a line that goes stale without
anyone noticing — that is how this file reached 1.8 million characters (see S666). Add new
material to the file that owns the subject, and add a pointer here only if there is nowhere else.

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
npm test            # Jest suite
npm run check:docs  # Rules-glob, rules-stub and CLAUDE.md-size checks. Also run by
                    # build:verify, so a rule that silently stopped loading fails a
                    # pre-push check rather than waiting for the next /doctor pass.
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

## Repo layout

| Path | What lives there |
| --- | --- |
| `src/modules/` | The product, one directory per area: `ims/`, `hr/`, `pos/`, `admin/`, `dashboard/`, `ownerReport/` |
| `src/pages/` | Routes belonging to no single module — login, pricing, help, settings, periods |
| `src/shared/` | Cross-module code: the scoped data-access layer, paged reads, error text, hooks |
| `src/components/` | Reusable UI, and the route guards every protected route stacks |
| `src/context/` | Auth, settings and theme providers. Singular `context` — the plural is a glob that has already rotted once |
| `src/utils/` | Standalone helpers: BS calendar, expression evaluator, subscription state, timeouts |
| `src/data/` | `pricingPlans.js` — the single source of truth for plans and prices |
| `supabase/` | Migrations and Edge Functions |
| `scripts/` | Build, audit and docs-check scripts, all reachable from `package.json` |
| `public/` | PWA shell and service worker, plus the second manifest for the staff app |

---

## Map

| Read this | For |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | Architecture and the rules that must be known before you think to ask: the gate model, tenant isolation, the privilege invariants, the Supabase traps. Loaded on every request of every session. |
| [`.claude/rules/`](.claude/rules/) | The same kind of rule, scoped by a `paths:` glob so it loads only when a matching file is open. Check `npm run check:docs` still passes after moving a file. |
| [`.claude/skills/new-feature-checklist/`](.claude/skills/new-feature-checklist/) | The steps between "it works" and "it shipped". Invoke it before any new page, report or module feature. |
| [`DESIGN.md`](DESIGN.md) | The design system as it actually exists in the code: tokens, scales, components, and the named rules that are already enforced. |
| [`PRODUCT.md`](PRODUCT.md) | Who buys this and why — users, positioning, brand personality, anti-references. |
| [`POS_TODO.md`](POS_TODO.md) | POS open items. Shipping something listed there closes the entry in the same commit. |
| [`POS_DECISIONS.md`](POS_DECISIONS.md) | POS shipped history and everything decided *against*, rationale intact. Read before proposing POS work. |
| [`CHANGELOG/`](CHANGELOG/) | The session log, S023 to now, split by S-range. [`CHANGELOG/README.md`](CHANGELOG/README.md) is the index and holds the convention for adding an entry. |
| [`DOCS-REMEDIATION.md`](DOCS-REMEDIATION.md) | The open work order this layout came from. T1–T13, with mechanical acceptance criteria. |

There is no `ARCHITECTURE.md` and there should not be. `CLAUDE.md` plus `.claude/rules/` already is
that document, and a fourth copy of the gate model would drift from the three that exist.

---

## Conventions worth knowing before the first commit

- **Line endings.** `.gitattributes` normalises the tree to LF. Do not write files with PowerShell's
  `Set-Content -Encoding utf8` — it emits a BOM — or read them with `Get-Content`, which reads ANSI
  and mangles every em dash. Use `[System.IO.File]::ReadAllText` / `WriteAllText`, or a shell that
  is not PowerShell.
- **The service worker caches aggressively.** Any JS or CSS change that existing users must actually
  receive needs `CACHE_NAME` bumped in `public/service-worker.js`. `CLAUDE.md` explains why a plain
  deploy is not enough.
- **Every session gets a changelog entry**, written into the newest `CHANGELOG/` range file. The
  convention, including when to start a new range, is in `CHANGELOG/README.md`.
