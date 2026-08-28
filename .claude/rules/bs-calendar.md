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

## Fixing the table does not fix the dates already written with it (S620)

`BsCalendarPicker` does not store what the user picked. Line 148 is
`onChange(formatAd(bsToAd(navYear, navMonth, day)))` — the user selects a **BS** date and an **AD**
date string is committed. So correcting the table corrects every display and **cannot** correct a
value already saved: re-reading such a row now shows a different BS date than the person chose, and
nothing ever raises an error, because a wrong AD date is still a perfectly valid AD date.

Two separate faults have been shipped, giving four eras:

| Era | Until | Fault |
| --- | --- | --- |
| E1 | 2026-07-11 13:54 | `EPOCH_AD` 2 days off (12 Apr 2022, should be 14 Apr) + bad 2080/2082/2083 |
| E2 | 2026-07-11 14:44 | 2083 fixed (`4e3a4c1`); epoch and 2080/2082 still wrong (~50 min window) |
| E3 | 2026-08-15 14:31 | 2079+ correct (`060822e`), but the table STARTED at 2079 and older years fell through to a flat 30-day approximation that returns a plausible wrong date rather than failing |
| E4 | now | Table covers 2000–2087 (`dfd785b`). Correct. |

So a transaction date in BS 2079+ is suspect only before 2026-07-11, while **a date of birth or a
long-tenured join date is suspect right up to 2026-08-15** — that is the E3 case, and it is the one
worth remembering, because it is silent and large (5 days on the measured example).

`scripts/bs-date-audit.mjs` is the audit and repair. Three properties of it are the point:

- **The repair is exact, not heuristic.** A row written in era E holding AD date `D` was produced by
  that era's own `bsToAd`, so the picked date is `E.adToBs(D)` and the correct value is
  `current.bsToAd(E.adToBs(D))`.
- **The historical converters are loaded FROM GIT** (`git show <rev>^:src/utils/bsCalendar.js`),
  never retyped. A transcription slip in the old table would produce a confident wrong repair —
  the same class of bug being cleaned up.
- **It refuses what it cannot prove.** Applying the transform to an already-correct date corrupts
  it, and a row created before a fix whose date was later re-picked is already correct with nothing
  in the row to say so. Where `updated_at` postdates the fix the row is reported, never repaired;
  tables with only `created_at` need an explicit `--include-unverifiable`.

**Only unlocked pickers are at risk.** Purchases and Requisitions pass `lockYear`/`lockMonth`, so
`onChange` hands back a day NUMBER within an already-chosen period and no AD date is derived. When
adding a picker, that distinction decides whether the value can rot.

**RUN against production 2026-08-28 (S620). Nothing needed repair.** 64 rows across six tables;
12 dates flagged, every one confirmed correct by the owner against the real records. Two of them —
a leaver's `end_date` and `retirement_date` — the script itself cleared once it read the audit log.
Do not re-run expecting a clean sheet to mean the script is idle; it means the data is good.

**The near-miss is the reusable lesson.** The first version keyed the era off the ROW's
`created_at` and guarded with `updated_at`. Both were wrong. A field's write time is not the row's —
a leaver's `end_date` is set months after hire, and one written *after* the fix was already correct
while the row's creation date said otherwise. And `updated_at` is **dead in this schema**: no
trigger maintains it and `EmployeeForm` never writes it, so it equals `created_at` forever and the
guard could not fire even once. It printed "0 need review" and meant nothing by it — the same
vacuous-guard shape the root `CLAUDE.md` records for dropped read errors. **Before relying on
`updated_at` anywhere, check that something actually writes it.**

`log_audit()` snapshots the whole row per change, so the true per-field write time is in
`audit_logs` — walk an id's history newest-first and take the first entry where that COLUMN
changed. Only `hr_employees` and `hr_leave_requests` carry audit triggers, so everything else can
never be proven and is report-only. Audit logging began 2026-08-04, which is *after* the July
converter fix, so fields written before that date cannot be dated from it either — they are
reported for a human rather than guessed at.

**Name that key `SUPABASE_SERVICE_ROLE_KEY`, with NO `REACT_APP_` prefix.** CRA inlines every
`REACT_APP_*` variable into the production bundle, so a service-role key under that prefix is
published in plain text to every visitor on the next `npm run build` — full read/write across every
tenant, readable from View Source. The script accepts the prefixed name so an existing `.env.local`
keeps working, but warns. `scripts/backfill-credit-note-reversals.mjs` still reads only the prefixed
name and carries the same hazard.
