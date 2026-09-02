# Cross-repo ledger — crest-suite ↔ hss-suite

**Why this file exists.** A sister app, **hss-suite** (an internal operations platform for a
Kathmandu hospitality-support company, at `C:\HSS`), was built by copying this repo's HR module,
payroll engine, settlement and `src/utils/bsCalendar.js`. Copies only stay cheap if fixes flow back.
Until 2026-09-02 nothing on this side recorded that relationship at all — this repo's `CLAUDE.md`
did not mention hss-suite once — so defects found over there had nowhere to land here.

**The rule** (also in `CLAUDE.md` on both sides): *a bug fixed there is still open here until it is
filed in `docs/CROSS-REPO.md` on this side.* The mirror of this file is `c:\HSS\docs\CROSS-REPO.md`.

**Format.** One row per item. *Found in* is where it surfaced, *Affects* is which repo has to act.
Newest at the top; never delete a closed row — a shared defect that came back is worth seeing twice.

## Open — this repo has to act

| Date | Found in | Affects | Item | Status |
| --- | --- | --- | --- | --- |
| 2026-09-02 | crest-suite | crest-suite | **Settlement Reopen is gated on `isAdmin`, locking out the person accountable for it.** `src/modules/hr/settlement/FinalSettlement.jsx:1009` renders the Reopen button behind `{isAdmin && (`. Here `isAdmin` is `profile.role === 'admin'`, the **Crest platform operator** — the tenant's own Owner is `isOwner` — so a client cannot reopen their own finalized settlement and has to contact support. **This is a missed sibling, not a new discovery**: `PayrollRun.jsx:536`, `FestivalAllowance.jsx:282` and `IncentiveRun.jsx:287` were already fixed to `hasHrAccess('manager')` and each carries a comment explaining exactly this reasoning. `FinalSettlement.jsx` is the only bare `isAdmin` permission gate left in `src/modules/hr/`. hss-suite fixed the same class of bug in four files on 2026-07-29. | **OPEN** |
| 2026-09-02 | hss-suite | crest-suite | **Display sites still call `adToBs()` instead of `adToBsSafe()`.** `bsCalendar.js:192` states the rule in its own comment — *"Anything that DISPLAYS a converted date must go through `adToBsSafe()`, not `adToBs()`"* — and `adToBsSafe` exists (line 201), but the call sites were left as a "separate follow-up" when the table was extended. Counted 2026-09-02: **65 raw `adToBs(` call sites against 11 `adToBsSafe(`**, across POS print HTML, credit notes, KOT/Covers reports, IMS vendor confirmations, Roster, Leave, TADA, Advances and self-service. Not all 65 are display — several are computation (`taxPoolCompute.js`, `useSalesPivotData.js`, `backfillPosToIms.js` bucket by BS day and are fine) — so this is an audit, not a find-and-replace. Out of range, `adToBs()` does not throw; it returns a confident wrong date. | **OPEN** |
| 2026-09-02 | hss-suite | crest-suite | **Delete the dummy `BHATTI CHOILA` client row.** hss-suite's `it-crest-sync` is create-if-missing, so deleting the row on the HSS side does not stick — the next sync recreates it from this repo's `billing-export` payload. It has to go from crest's `clients` table. **No code change is needed here**: `billing-export` already sends `is_active`, `is_trial` and `billable` unfiltered (`supabase/functions/billing-export/index.ts:96,158-159`), which is what HSS's churn handling needs. | **OPEN** |
| 2026-09-02 | hss-suite | crest-suite | **The BS calendar's correctness check is four anchors; the round-trip sweep is not a second one.** `src/utils/bsCalendar.test.js` walks every day from 1943 to 2031 (>32,000) and requires `AD → BS → AD` to round-trip. That proves the converter pair is a **bijection**, not that the table is right: both directions read the same `BS_CALENDAR`, so a mistyped month length round-trips perfectly while every date after it is off by a day. The test's own comment calls the sweep "the real guard", which overstates it. Reality is checked only by the 4 `ANCHORS` (line ~124), of which two are Baisakh 1. A single non-compensating bad row between 1943 and 2022 *is* caught by the 2022 anchor, but it localizes nothing, and a compensating pair (+1 in one month, −1 in another) or a bad row after 2083 is caught by nothing. **Proposal: add Baisakh 1 for every BS year 2000–2083 against the published Nepali New Year AD dates** — 84 independent reality anchors, which localize a bad row to a single year. Leave 2084–2087 out: they are deliberate extrapolations in both repos. | **OPEN** |

## Open — waiting on hss-suite

| Date | Found in | Affects | Item | Status |
| --- | --- | --- | --- | --- |
| 2026-09-02 | crest-suite | hss-suite | **Every clock time is rendered in the viewer's timezone, not Nepal's.** Crest had 18 byte-identical inline `toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })` call sites and zero occurrences of `Asia/Kathmandu` in `src/`; each rendered in the **runtime's** zone, so an operator viewing a tenant's data from outside Nepal saw every time 5h45m out with nothing on the page saying so. HR is the ported module, so check attendance/roster/self-service time renders there — `rosterHelpers.js:fmtTime` is NOT affected (it formats a Postgres `time` string, not an instant), but anything formatting a `timestamptz` is. Two further traps came out of the fix: (1) pinning the time forces pinning the DATE beside it, since `adToBs()` reads a Date's local getters and a 00:15 Kathmandu instant otherwise renders under the previous BS day; (2) `.getHours()` used for hourly bucketing has the same fault and shifts a whole distribution. Crest's fix is `src/shared/nepalTime.js` — deliberately NOT in `bsCalendar.js`, because that file is mirrored byte-for-byte and a time helper there would have to land in both repos at once. Copy the module or write an equivalent; do not add it to the shared calendar file. | **OPEN** |
| — | — | — | Nothing open. | — |

## Closed

| Date | Found in | Affects | Item | Status |
| --- | --- | --- | --- | --- |
| 2026-08-13 | hss-suite | both | `BS_CALENDAR` covered only BS 2079–2087. Outside that range the converters do not throw — `bsYearLength()` fell back to a flat 365 and `daysInBsMonth()` to a flat 30, so they returned a confident *wrong* date, worsening the further back you went. Surfaced there on a date of birth (`1980-01-04` displaying as `15 Poush 2036`, which is really 30 Dec 1979). This repo held the same table and the same bug. | **APPLIED here 2026-08-15** (`dfd785b`), extending the table to BS 2000–2087. Verified 2026-09-02: 88 year rows, all identical to hss-suite's. |

## What is shared, and what is not

Shared, so a fix on either side is a candidate for this ledger:

- `src/utils/bsCalendar.js` — the BS↔AD converters and `BS_CALENDAR` (**all 88 year rows identical
  across the two repos**, verified 2026-09-02). **Rows 2084–2087 are extrapolations in both** and
  must not be "corrected" against another library on either side.
- `src/modules/hr/**` — payroll, settlement, leave, roster, TADA, advances.
- The payroll engine's Nepal constants (SSF, TDS slabs) — both companies are NPR/Nepal Pvt. Ltd.

**Not** shared, so a difference is intentional and not a defect to file:

- **Tenancy.** This repo is multi-tenant (`client_id` everywhere, `useScopedDb()`); hss-suite is a
  single company and keeps a shim with the same API that ignores the `client_id` argument.
- **Roles.** Here `isAdmin` is the platform operator and the tenant's Owner is `isOwner`; there,
  `isAdmin` is a compat alias for `isMd`, that one company's Owner. **A permission gate copied
  verbatim between the repos changes meaning** — which is precisely the first open item above.
- This repo's IMS and POS modules, and hss-suite's revenue verticals, Finance and Admin — neither
  exists on the other side.
