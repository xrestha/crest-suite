# dashboards.md: archived sections

Moved word for word out of .claude/rules/dashboards.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 76–81:_

/owner-dashboard, /owner-report and /pnl are rendered in Layout.js only for `isAdmin || isOwner`,
but SuiteGate checks `suite_plan` and ProtectedRoute checks a session — neither checks a role. Two
of the three had no route guard, and because the staff-isolation policies are RESTRICTIVE SELECT
filters (empty result, no error), a POS PIN account got a full P&L reading Net Profit = Revenue at
100% margin rather than an access error. All three now carry
`if (!isAdmin && !isOwner) return <Navigate to="/dashboard" replace />` after their hooks.
