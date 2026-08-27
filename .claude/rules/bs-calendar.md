---
paths:
  - "src/utils/bsCalendar.js"
  - "src/utils/bsCalendar.test.js"
  - "src/components/BsCalendarPicker.js"
---

# BS calendar: how the lookup table was verified, and how to extend it

> Moved out of the root CLAUDE.md (2026-08-27 /doctor pass) so it loads only when working on
> these files. Root CLAUDE.md keeps the universal invariants.

**S559 extended `BS_CALENDAR` back to 2000 BS (~1943 AD) after a real bug in the sister HSS app**: an employee's date of birth, 30 Dec 1979, displayed as "15 Poush 2036" and round-tripped back to 4 Jan 1980 — five days out, and since `adToBs`/`bsToAd` don't throw outside the verified table, the *wrong AD date was being stored*, not just shown. The added 2000–2078 rows were cross-checked against four independent open-source BS↔AD converters (`nepali-date-converter`, `@sbmdkl/nepali-date-converter`, `bikram-sambat`, `nepali-datetime`), which agree unanimously on all 79 added years and reproduce the S352-verified 2079–2083 rows exactly — then verified by round-tripping all 32,000+ consecutive days from 14 Apr 1943 to 1 Jan 2031 through AD→BS→AD with zero mismatches (`bsCalendar.test.js`). **2084–2087 are deliberately left alone** — the four libraries disagree with each other from 2084 onward, since the BS calendar is astronomically determined and officially published year by year, so a far-future row is an extrapolation no library's guess outranks another's; don't "fix" them to match whichever library you happen to consult.

`BS_YEAR_MIN`/`BS_YEAR_MAX` (derived from the table's own keys, so a future extension widens them for free) and `adToBsSafe(adDate)` are the actual fix, not just the wider table — `adToBsSafe` returns `null` instead of a silently-wrong date when the result falls outside the verified range, so a caller can render the raw AD date instead of a confident wrong BS one. **`BsCalendarPicker` adopted it in S569** — the one shared component every DOB/join-date/arbitrary-date field goes through now resolves its value via `adToBsSafe` (an out-of-range value displays as its truthful `YYYY-MM-DD (AD)` form instead of an approximated BS date), its year dropdown is clamped to `BS_YEAR_MIN..BS_YEAR_MAX` (it used to offer 2088–2090, which would have *stored* wrong AD dates via approximated `bsToAd`), and month navigation stops at the table's edges. The remaining direct `adToBs(` call sites all convert operational timestamps (`closed_at`, roster days, period dates) that are inside the verified range by construction — a *new* call site that renders a stored arbitrary date should still reach for `adToBsSafe`.
