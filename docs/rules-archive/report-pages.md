# report-pages.md: archived sections

Moved word for word out of .claude/rules/report-pages.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 259–267:_

`ConsolidatedPnl.jsx` passed its whole table as `ReportPage`'s `children`. `ReportPage` renders
`children` only once the page has loaded — but **JSX children are an ARGUMENT**: the expression is
fully evaluated by the parent and handed over as a finished element tree, so the gate inside the
wrapper never gets a say. `pnl` is `useState(null)` and `loading` is `useState(true)`, so
`LINES.map(l => … pnl[l.key] …)` ran on the first render and threw on `revenue`. It crashed on
**every** visit for a single-outlet client, before `SuiteGate` even rendered — so the entitlement
gate could not stop it either. Only an early return, a guard at the call site (`{!stmt ? null : …}`),
or a render prop can protect it. The same applies to `banners`/`stats`/`note`/`filters`/`footnote`:
`ReportPage` suppresses them while loading or after an error, but the caller still *evaluates* them.
