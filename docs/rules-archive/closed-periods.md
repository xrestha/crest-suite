# closed-periods.md: archived sections

Moved word for word out of .claude/rules/closed-periods.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 255–263:_

- **Closing a period is preflighted on the closing count (S613).** The close locks the month *and*
  mints the frozen Monthly Report, and COGS subtracts closing stock — so an uncounted month freezes
  "closing = 0 for every item" into an artifact nothing recomputes. All three close paths in
  `Periods.js` now run `closingCountPreflight()` and state what it found inside the ConfirmModal,
  red when nothing is counted. It **informs and never blocks** (an admin correcting history
  legitimately closes uncounted months), a failed preflight says it could not check rather than
  blocking, and it counts the same `physical_qty IS NOT NULL` rows `carryForwardOpeningStock` uses
  so the sentence and the carry-forward cannot disagree. Full reasoning in
  `.claude/rules/owner-report.md`.
