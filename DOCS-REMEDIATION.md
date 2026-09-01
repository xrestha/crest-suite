# DOCS-REMEDIATION.md

Work order for the Crest Suite repo. Thirteen tasks, ordered. Each has acceptance criteria that can
be checked mechanically. Do not reorder — T1 must land before T2, and T6 is the only one that is
allowed to jump the queue if a launch date is set.

**Scope note:** T1–T5 and T9–T10 are documentation and tooling only. No app code changes, no
migration, no service-worker version bump. T6–T8 do change app code and shipping setup.

---

## Context: what already exists, and must not be duplicated

Before doing anything below, note what the repo already has. This plan was first written without
sight of these files and has been corrected against them.

- **`CLAUDE.md`** (51,761 chars) — stack, access control and the three gate types, tier thesis,
  multi-outlet, subscription access, the four S531 privilege invariants, multi-tenant isolation and
  `scopedDb`, staff role axes, BS calendar rules, page-splitting, Supabase/DB traps.
- **`.claude/rules/*.md`** (25 files, ~418k chars) — everything scoped by `paths:`, loaded only when
  a matching file is open.
- **`.claude/skills/new-feature-checklist/SKILL.md`** — the eight-step ship checklist.
- **`DESIGN.md`** (61,149 chars) — full design system: token set for both presets, the scoped guest
  menu palette, print ramp, typography, layout, components, do/don't.
- **`PRODUCT.md`** (4,312 chars) — platform, users (owner/manager primary, accountant secondary),
  purpose, competitive positioning, brand personality, anti-references, design principles, data
  ownership, accessibility.
- **`POS_TODO.md`** (48,595 chars) — a real backlog for the POS module: status key, sections by
  origin, an explicit out-of-scope section, and a shipped history. Five open items, 59 done. See T5.

**The architecture documentation problem is already solved.** Do **not** create an `ARCHITECTURE.md`.
A fourth copy of the gate model and the isolation rules would drift from the three that exist, and
`CLAUDE.md`'s own opening section is a rule against exactly this.

---

## Context: what is wrong right now

`README.md` is 1,801,834 characters across 15,364 lines. Claude Code warns on a memory file at
40,000 characters, so this file is roughly 45× that threshold. It cannot be read end to end by
anything, including a person.

Its structure is 164 lines of live reference material (Quick Start, App Overview, Plans, Routes,
Pending Features) followed by 15,200 lines of session log (S34 → S663). The 164 useful lines are
stale; the 15,200 accurate lines are unreadable. Both halves fail for opposite reasons.

Specific staleness confirmed by grep against the file itself:

| Claim in the head of the file | What the log says | Evidence |
| --- | --- | --- |
| "Business: Crest Hospitality" | Entity is Bloom Hospitality Pvt. Ltd. | `bloom` appears 2× in 15,364 lines |
| App Overview: "inventory & food cost management SaaS" | IMS + POS + HR + Group Console | `/hr/` 232×, `payroll` 263×, `attendance` 138×, `Group Console` 18× |
| Routes table: no HR routes, no Group Console, no kitchen board | All three exist | `kitchen board` 4× |
| Plans table: IMS-only Starter/Growth/Pro | Packaging reframed POS-led | Plans table unchanged since early sessions |
| Quick Start: no module layout | Pages moved `src/pages/` → `src/modules/` | `src/modules` 743× vs `src/pages` 688× |
| Pending Features = backlog | 1 genuine Open item across 644 sessions | S606 only |

---

## T1 — Split `README.md` into a map and a changelog

**DONE — S666, 2026-09-01, commits `e38b22d` and `bc24fe2`.** `README.md` is 90 lines / 5,288
chars. The log is 16 range files under `CHANGELOG/`, largest 148,309 chars, plus an index and
`CHANGELOG/S000-ORIGINAL-HEAD.md` holding the stale head verbatim. All four acceptance criteria
verified; criterion 3 was upgraded to reconstruction *by* this task and passed byte-identical at
1,801,834 bytes. The spec below is kept as a record and corrected only where it named files that
do not exist. What the split found is in `CHANGELOG/S650-S699.md`.

**What shipped.** The single file became:

```
README.md            90 lines / 5,288 chars (spec: ≤ 200 lines, < 12,000 chars). Quick Start,
                     env vars, repo layout, and a MAP: one line each pointing at CLAUDE.md,
                     .claude/rules/, the new-feature checklist, DESIGN.md, PRODUCT.md,
                     POS_TODO.md, POS_DECISIONS.md, CHANGELOG/ and this file. It restates
                     none of them.
CHANGELOG/           Session log split by S-range: CHANGELOG/S023-S099.md ... S650-S699.md,
                     16 files, largest 148,309 chars. CHANGELOG/README.md is the index -- each
                     range with its date span, plus the convention for adding an entry and
                     when to start a new file. CHANGELOG/S000-ORIGINAL-HEAD.md holds the
                     pre-split head verbatim and uncorrected.
```

That is the whole split. `ARCHITECTURE.md` is not created — `CLAUDE.md` plus `.claude/rules/` is
already that document, and it is better than anything this pass would write. `PRODUCT.md` already
exists and is only extended, in T2.

**The original spec listed `BACKLOG.md` and `DEBT.md` in the map. Neither is there, because
neither exists.** T5b creates the three module backlogs and T9 creates the debt register; the
session that lands either adds its pointer to `README.md` then. A map line pointing at a file that
does not exist is the lying-stub failure T4 automates against, one level up — and a map is exactly
where it would do the most damage, since a map is read by someone who does not yet know what is
there. `POS_TODO.md` and `POS_DECISIONS.md` took those two slots because they are real (S665).

**The new README's job is to be a map, not a summary.** Every line that describes rather than points
is a line that will be stale in a month. That is the failure mode this whole document exists to fix.

**Acceptance criteria.**

1. `README.md` is under 200 lines and under 12,000 characters.
2. No `CHANGELOG/*.md` file exceeds 200,000 characters.
3. **Reconstruction, not line membership.** Assert that the archived head plus every
   `CHANGELOG/*.md` range file, concatenated in file order with each file's generated header
   removed, reproduces the pre-change `README.md` **byte for byte**. Done on the S666 split:
   1,801,834 bytes in, 1,801,834 identical bytes back.

   **This replaces the line-membership check this criterion used to specify** — the S663 method,
   which was the right tool for a file being rewritten and the wrong one for a file only being
   cut. Reconstruction is strictly stronger and cheaper to write. A set-membership check **cannot
   see a line that moved to the wrong place**: a session block spliced into the wrong range file,
   or a paragraph landing above the heading it belongs under, satisfies “every line still appears
   somewhere” perfectly. It equally cannot see reordering, duplication, or a line that survived
   only because some unrelated file happened to contain the same text — and across 644
   near-identically-shaped entries that last one is not hypothetical. Reconstruction catches all
   four, and because it compares raw bytes it needs no whitespace normalisation and so cannot be
   fooled by one either.

   **It costs one constraint: the split must be byte-preserving by construction.** Cut only at
   block boundaries, never reflow, never `rstrip` a block's trailing blank lines, and add new
   material only in a header that can be mechanically removed. S666 lost 15 blank lines to a stray
   `rstrip` on the first attempt and reconstruction caught it on the spot; line membership would
   have passed, because blank lines are not compared.

   **Keep line membership as the fallback for anything genuinely rewritten in transit**, where
   reconstruction has nothing to compare against — and if you run it, use
   `grep -qxF -e "$line"`, with the `-e`, from the start. Without it, any line beginning
   with `-` — every `- [x]` bullet, every `--flag` in a code block — is parsed as an option and
   `grep` dies with `unknown option`, which the loop then reports as an unaccounted line. On this
   file the printed report is the only thing anyone reads, so a false "unaccounted" sends the next
   session hunting for a loss that never happened. Hit live while splitting `POS_TODO.md` (T5a):
   the `comm` set arithmetic was correct throughout and only the display loop lied.

   **Negative-test whichever check you rely on, before trusting it** — drop one line from
   `README.md` **and** one from a `CHANGELOG/*.md` file, confirm each is flagged and the script
   exits non-zero, then restore and `cmp` to prove the restore was byte-identical. Test both
   sides, not one: a loop that reads only the file it was named after passes happily over
   everything it never opened. A check nobody has seen fail is not evidence.

   **S666 found that the `README.md` half of that test proves nothing, and a third test had to be
   invented.** The whole pre-change head is archived verbatim in `CHANGELOG/S000-ORIGINAL-HEAD.md`,
   so every line of the new `README.md` also exists there and deleting one still passes. What
   actually demonstrates the check reads `README.md` is to drop the line from **both**, confirm it
   is flagged, then restore **only** `README.md` and confirm it passes. Before designing a negative
   test, check that the line you are deleting has exactly one home. A negative test that cannot
   fail is not a negative test, and it is the more dangerous outcome, because it is recorded as a
   pass.
4. `git log` shows the original file preserved in history before the split commit.

**To-do carried into this task: two sessions are not in the log.** `README.md`'s newest entry is
S663. Both of the sessions since then shipped deliberately without one — writing an entry into the
15,364-line log this task is about to split would have put it in a place this task then has to move.
**The session that lands T1 must write both into the correct `CHANGELOG/` range as part of its own
work**, along with any session between S665 and that one:

- **S664** — the three rules-corpus checks (T3/T4/T11: `scripts/check-rules-globs.mjs`,
  `check-rules-stubs.mjs`, `check-claude-size.mjs`), plus `.gitattributes`.
- **S665** — T5a/T5c: `POS_TODO.md` split into open items (2,676 chars) and `POS_DECISIONS.md`
  (the shipped history and every struck-through entry, rationale intact); the stale guest-QR entry
  corrected and moved across; and two corrections back into this file — T5c's `submit_guest_order`
  "both overloads" claim, and the `grep -qxF -e` trap in acceptance criterion 3 above.

Note that acceptance criterion 3 cannot catch either absence, and the move to reconstruction
does not change that — if anything it makes it plainer. Both methods measure the split against
the *pre-change* file, and neither entry was ever in it, so both pass vacuously. They have to be added by hand
and confirmed by hand. This is the same shape as the guard problem `CLAUDE.md` names about truncated
reads: a check that only compares against what was already there cannot see what was never there.

**Keep this list current.** Every further session that ships before T1 lands adds a bullet here, for
the same reason and with the same blind spot — the check will not miss it for you.

**Windows encoding trap — this task will hit it.** PowerShell 5.1 `Get-Content` reads ANSI by
default and `Set-Content -Encoding utf8` writes a BOM. Splitting this file with those cmdlets will
turn every `—` into mojibake and prefix each output file with `EF BB BF`. Use
`[System.IO.File]::ReadAllText` / `WriteAllText` with `UTF8Encoding($false)`. Verify with a
byte-level comparison before committing, not a visual one.

Related: with `core.autocrlf=true` and no `.gitattributes`, writing LF into a tracked file leaves
`git status` marking it modified while `git diff` shows nothing. Add a `.gitattributes` in this
task while you are here.

---

## T2 — The two things genuinely homeless: the route table and the commercial table

Everything else in the stale head of `README.md` is covered better elsewhere. These two are not
covered anywhere, and both were being carried only by a table nobody has updated in months.

### T2a — Generate the route table; do not hand-write it

`CLAUDE.md` documents how the gates work in depth and never lists a single route. The route
table is wrong: no HR routes at all despite 232 references to `/hr/` in the log, no Group
Console, no kitchen board, no guest menu, no `/owner-dashboard`, no `/hr/self-service`. Since
the S666 split it lives at `CHANGELOG/S000-ORIGINAL-HEAD.md:69–108`, archived verbatim rather
than corrected, because this task replaces it outright.

**A hand-maintained route table is a value that moves embedded in a permanent document** — the exact
failure `CLAUDE.md`'s "Never embed a value that moves" rule names. So generate it.

**Do.** Add `scripts/gen-routes.mjs`:

- Parse `src/App.js` for every `<Route>`, its `ModuleGate module=`, `PremiumGate featureKey=` /
  `minPlan=`, and any `SuiteGate` wrapper.
- Cross-reference `src/components/Layout.js` for the nav entry's `minPlan` / `minPosRole` /
  `minImsRole` / `minHrRole` tag.
- Emit a markdown table to `ROUTES.md`, marked generated-do-not-edit.
- **Fail non-zero on the three-way mismatch `CLAUDE.md` warns about**: a feature whose key set in
  `AuthContext.js`, whose `minPlan` on the route, and whose `minPlan` on the nav item disagree. That
  produces a page that is reachable-but-hidden or visible-but-blocked, and right now nothing catches
  it. This check is worth more than the table it prints.

**Wire into `npm run build:verify` as a REGENERATE-AND-DIFF, not just as the mismatch check.** Commit
`ROUTES.md`, then have the verify step re-run the generator against the working tree and compare its
output byte-for-byte with the committed file, failing non-zero on any difference and printing it.

A committed generated table is a value that moves the moment someone adds a route without re-running
the generator — the same failure the table was extracted from `README.md` to escape. The gate-mismatch
check does not cover this: a new route can be perfectly self-consistent across `AuthContext.js`, its
`minPlan` and its nav tag, pass the mismatch check cleanly, and still be absent from `ROUTES.md`. Only
the diff catches that. Give the generator a `--check` flag for the verify path and a plain write mode
for the fix, so the failure message can say exactly which command resolves it.

### T2b — `PRODUCT.md` says who buys and why, never what they buy or what it costs

`PRODUCT.md` is a good positioning document. It covers users, purpose, competitors, brand, design
principles, data ownership. It contains zero occurrences of `NPR` and no plan table.

**Pricing is not homeless — it is duplicated and contradictory.** `README.md` carries two pricing
tables that disagree:

- **`CHANGELOG/S000-ORIGINAL-HEAD.md:59–65` — STALE. Do not carry it forward.** Starter 5,000 / Growth 8,000 / Pro 12,000, one-month
  trial, IMS features only. These are the same figures that were once hardcoded in Admin Settings >
  Plan Pricing and showed a Growth client on all three modules as NPR 24,000 monthly value against a
  real 7,200 — a 3–4× overstatement.
- **`CHANGELOG/S000-ORIGINAL-HEAD.md:152–170` — current**, and it names the canonical source: `src/data/pricingPlans.js`,
  which also feeds Help's Plan & Pricing tab, the public `/pricing` page and Admin Settings > Plan
  Pricing (S380). `DEFAULT_PLAN_PRICES` is derived from `IMS_TIERS`/`HR_PRICING`/`POS_PRICING`
  specifically so admin analytics can never drift independently again.

Current: IMS tiered 2,000 / 2,600 / 3,500. HR flat 2,600. POS flat 2,000. Crest Suite Pro a
per-outlet add-on at +2,000 (annual +1,500), requires IMS, `suite_plan` is `NULL | 'pro'`. Annual is
25% off uniformly.

Meanwhile the **tier thesis** (Starter = Record & Comply, Growth = Control, Pro = Strategy, Suite
Pro = Synthesis) and its two derived rules — a feature must produce a number on its own tier's data,
and a statutory obligation never gates above the base tier — sit in `CLAUDE.md`, where a person
deciding what to charge will not look.

**Do.** Add a `## Plans and packaging` section to `PRODUCT.md`:

- The tier thesis, moved out of `CLAUDE.md` (leave a pointer stub — the placement rule is
  reachability, and pricing decisions are not reached from a code edit). Note that `clients.plan`
  applies to **IMS only**; HR and POS are yes/no modules with no tiers.
- Suite as a per-outlet add-on, explicitly not a bundle, with its seven features.
- **Point at `src/data/pricingPlans.js` for the numbers rather than restating them.** A price table
  in a doc is a third copy of something that already has one canonical home and one derived one.
- Trial length: point at the `TRIAL_DAYS` constant, do not restate it.

**A commercial question this surfaces, for the record rather than for this pass.** POS is priced flat
at NPR 2,000/mo, roughly what a standalone billing app charges in this market — while POS's actual
differentiator (recipe-level depletion on bill close, comps valued at food cost, attribution enforced
at the database) is something no billing app can do. Worth a deliberate decision rather than
inheriting the number.

### T2c — Entity name

Replace "Crest Hospitality" with "Bloom Hospitality Pvt. Ltd." in the head material of `README.md`
and in `PRODUCT.md` if it appears. Leave `CHANGELOG/` untouched; historical entries record what was
true at the time.

**Acceptance criteria.** `ROUTES.md` generated and matching the router in both directions. The
three-way gate mismatch check runs clean or reports real mismatches. `npm run build:verify`
regenerates `ROUTES.md` and fails on any diff against the committed copy — verify by deleting a row
from the committed file and confirming the run goes red. `PRODUCT.md` has a plans section. Zero
occurrences of "Crest Hospitality" outside `CHANGELOG/`.

---

## T3 — Automate the rotted-glob check

**DONE — S664, 2026-09-01, commit `341d920`.** `scripts/check-rules-globs.mjs`, wired into
`npm run check:docs` and `npm run build:verify`. Runs clean. The count of globs it covers moves
every session and is deliberately not recorded here — the script prints it.

S663 found `accounts-and-logins.md` scoped to `src/contexts/AuthContext.js` when the directory is
`src/context`, singular. That rule had never once loaded for the file it is most about. Four more
globs pointed at moved or non-existent paths. All five were found by hand.

**Do.** Add `scripts/check-rules-globs.mjs`:

- Parse the `paths:` frontmatter of every `.claude/rules/*.md`.
- Resolve each glob against the working tree.
- Exit non-zero listing any glob that matches **zero** files.

**Why it matters more than it looks.** A scoped rule whose glob matches nothing does not error, does
not warn, and looks identical to a session where the rule simply did not apply. It fails silently
and permanently. This is the highest-value ten lines of code in this document.

**Acceptance criteria.** Script exists, runs clean on the current tree, and is wired into
`npm run build:verify` so it runs on every pre-push check.

---

## T4 — Automate the lying-stub check

**DONE — S664, 2026-09-01, commit `341d920`.** `scripts/check-rules-stubs.mjs`, a separate script
rather than an extension of T3, wired alongside it. Runs clean. It asserts the destination exists
**and** carries content, so a pointer chain to another stub fails too. T14 records what it still
does not cover: every path written in prose that is not this one stub pattern.

Three pointer stubs in S663 named a destination file that had never received the content. A stub
that names a destination is worse than no stub, because it reads as available.

**Do.** Extend the T3 script, or add `scripts/check-rules-stubs.mjs`:

- Find every line in `CLAUDE.md` and `.claude/rules/*.md` matching the stub pattern
  (`…is in \`.claude/rules/<file>\``).
- Assert the named file exists.
- Assert it contains a heading or content block plausibly matching the stub's subject — at minimum,
  that the file is not a stub itself, which would make it a pointer chain to nothing.

**Acceptance criteria.** Runs clean. Wired into `build:verify` alongside T3.

---

## T5 — Extend the POS backlog pattern to the rest of the product (revised)

**Correction to an earlier draft.** This task previously said no forward-looking backlog existed
anywhere. That was wrong. `POS_TODO.md` is a real, well-built backlog: a status key
(🔴 Missing / 🟡 Partial / 🔵 Deferred / ⚪ Open question), sections by origin (Nepal-market research,
IRD compliance, competitor audit, self-critique), an explicit **"Not on this list (deliberately out
of scope)"** section, and a `Last updated` stamp. The scope section in particular is the part most
backlogs lack and the part that stops the same argument being re-had.

Five items are genuinely open across 59 done. Two of those five are **not engineering**:

- ⚪ Tier-1 software-certification legal question — needs an accountant's answer.
- 🟡 QR payment auto-confirmation — blocked on FonePay/eSewa merchant onboarding, not code.

Both have sat open for months because neither can be closed by a coding session. They belong on a
business to-do list, not an engineering one, or they will keep being scrolled past.

### T5a — The file has the disease it was built to avoid

**DONE — S665, 2026-09-01, commit `a5d5cc4`.** `POS_TODO.md` 48,595 → 2,676 chars (target was
under 6,000): header, status key, scope section, open items. `POS_DECISIONS.md` holds the shipped
history and every struck-through entry with its rationale intact. Cross-linked both ways, and both
carry the rule that a shipped item moves across in the same commit.

`POS_TODO.md` is 48,595 chars across 200 lines, and roughly 92% of it is completed history. Several
`Shipped` entries run to a full screen each. The header states the intent — *"completed items are
struck through, not deleted, so this stays a full history of what was considered"* — and that intent
is **correct and worth preserving**: B3 exists specifically so the same ground is not re-walked, and
several entries record why a thing was decided against, which is exactly the knowledge that
evaporates otherwise.

But this is structurally the same failure as `README.md`'s `Pending Features`: the actionable part is
buried under history, so the file stops being read as a to-do list.

**Do.** Split rather than delete:

- `POS_TODO.md` keeps the header, status key, scope section and **open items only**. Target under
  6,000 chars.
- `POS_DECISIONS.md` (or `CHANGELOG/pos-shipped.md`) takes the Shipped section and every struck-through
  entry, with the rationale intact.
- Cross-link both ways.

### T5b — Three modules have no backlog at all

POS has one. IMS, HR and platform-level work have nothing. That asymmetry is why the roadmap for
two-thirds of the product still exists only in your head, which is the real risk when the Twine
contractor starts.

**Do.** Create `IMS_TODO.md`, `HR_TODO.md` and `PLATFORM_TODO.md` using `POS_TODO.md`'s exact shape —
same status key, same origin sections, same "deliberately out of scope" section. Seed each from the
open work you are carrying mentally. `PLATFORM_TODO.md` is where T6/T7/T11 and S606 belong.

Do not merge them into one file. `POS_TODO.md` works partly because it is scoped to one module and
one reader-context.

### T5c — Stale entry to fix while you are in there

**DONE — the guest-QR entry in S665, commit `a5d5cc4`; the checklist rule in S666.** The
second half was missed at the time and is worth naming: S665 corrected the stale
entry but never added the rule below to the new-feature checklist, and the task read as complete
for a day because the visible half had shipped. It is now step 9 of
`.claude/skills/new-feature-checklist/SKILL.md`, with the guest-QR entry as its worked example.
**A partly-done task marked done is the same defect as a stale backlog entry**, which is what this
sub-task was about.

`POS_TODO.md:13` says the guest QR menu shipped **view-only** with self-order deferred. Self-ordering
shipped: `submit_guest_order` is live (rate-limited in S373, hardened in S604 with table-binding at
commit and an order-status stepper), and `CLAUDE.md` records S632 settling that Guest QR Ordering
comes with the POS module on `pos_enabled` alone.

**Corrected 2026-09-01:** an earlier draft of this task said "both overloads" exist. They do not.
`20260707230000` appended a defaulted `p_covers` believing that was `CREATE OR REPLACE`-compatible,
but Postgres keys the replace on the full argument-type signature, so it created a SECOND function;
both were live and anon-executable from 2026-07-07 and every later fix landed only on the 4-arg
body. `20260829120000` dropped the 3-arg one and asserts exactly one survives. The "both overloads"
phrasing was true when the S532 grant-trap audit wrote it on 2026-08-10 and stopped being true three
weeks later — which is the same decay this whole document exists to fix, reproduced inside the fix.

The line is wrong in the file whose whole purpose is to stop ground being re-walked — which is
exactly how a shipped feature gets rebuilt, or gets left off a pricing page because the backlog said
it was deferred.

**Add a rule to `CLAUDE.md`'s new-feature checklist:** shipping a feature that appears in any
`*_TODO.md` closes that entry in the same commit.

---

## T6 — Production error monitoring

**This is the only task on this list that is a launch blocker.**

Zero occurrences of `Sentry`, `monitoring`, or `error boundary` in 15,364 lines. A POS is going into
live restaurant service with no error reporting. When a terminal throws at 8pm on a Friday, the
detection mechanism is currently the client phoning you, and there is no stack trace waiting when
they do.

**Do.**

1. Add a React error boundary at the router level and a second one wrapping the POS floor
   specifically. The POS boundary must **never** unmount the order state — it renders a recoverable
   error panel with a retry, not a blank screen. A POS that white-screens mid-service costs the
   client more than the annual subscription.
2. Wire an error reporting service (Sentry free tier is sufficient at this scale). Tag every event
   with `client_id`, `module`, `route`, and `role`. Do **not** send PII, item-level bill contents,
   or anything from `hr_` payroll tables.
3. Add a client-side breadcrumb for offline-queue flush failures. Queued writes that fail to sync
   are currently invisible and are the highest-consequence silent failure in the product.

**Acceptance criteria.** A deliberately thrown error in POS surfaces in the dashboard within 60
seconds, tagged, with no PII in the payload.

---

## T7 — Staging environment

One mention of `staging` in the entire log. Deploys go straight to production. This is survivable
for a solo developer with your session discipline. It is not survivable with a contractor who does
not have it.

**Do.**

- A `staging` branch with its own Vercel deployment.
- A **separate Supabase project** for staging. Not a separate schema in the same project — a
  separate project, so a bad migration cannot touch client data.
- A seed script that populates staging with synthetic data. No production data copied to staging,
  ever; that is client financial and payroll data.
- Document the promote path in `README.md`: staging → verify → main.

**Acceptance criteria.** Staging URL live, pointed at the staging Supabase project, verified to have
zero production rows.

---

## T8 — Money-math test coverage (revised: a suite already exists)

**Correction to an earlier draft of this document.** This task previously claimed there was
effectively no test suite, based on a grep for `jest` that returned 9 hits. That was wrong. The
S532-era security verification records **16 test suites / 207 tests passing** alongside
`CI=true npm run build` exiting 0. The suite exists and runs in CI.

So the question is not "write tests" but **which of the 207 cover the paths where a silent wrong
answer is a legal or financial problem rather than a cosmetic one.**

**Do.** Audit coverage against this list, and fill only the gaps:

- VAT 13% computation and the VAT / non-VAT report split (note S146: 0% VAT was once silently
  coerced to 13%).
- Food cost percentage, COGS, and theoretical vs actual variance.
- Recipe costing: `qty_per_portion`, sub-recipe yield division, the PATH-set cycle guard, and
  overhead allocation filtered to `bucket = 'overhead'` (broken once, S35).
- FIFO valuation.
- Payroll: TDS, SSF (enrolment flag **and** `ssf_no`), gratuity offset derivation, and **both**
  `join_date` and `end_date` proration — end-date proration was undocumented and its absence paid a
  leaver's final month at roughly 1.5× (S600).
- BS ↔ AD conversion at fiscal year boundaries, and the `bsToAd` → `.toISOString()` trap that has
  shipped twice.

**Acceptance criteria.** Each item above has at least one boundary case (fiscal year rollover, zero
quantity, null yield, a mid-month leaver). Report which were already covered — that list is worth
knowing.

---

## T9 — `DEBT.md`

There is no written list of known technical debt anywhere. Create one. Seed it with:

- **CRA is unmaintained.** 47 mentions of CRA, 11 of Vite, so the migration has been considered.
  Do not migrate now — it is a large change with no client-visible benefit and it would land in the
  middle of a launch. Record it with a trigger condition: migrate when CRA blocks a dependency
  upgrade you actually need.
- Pages still under `src/pages/` that were meant to move to `src/modules/`.
- `eslint-disable-line react-hooks/exhaustive-deps` sites — there are many, most intentional to
  avoid re-render loops. List them so a contractor does not "fix" one and cause an infinite loop.
- Any table without an index that is queried by date range in a report.

**Format.** Each entry needs a trigger condition, not a date. "When X happens, do Y" survives; "Q3
2026" does not.

---

## T10 — Reconstruct the origin note

The log starts at S34 on 2026-06-17. S1 through S33 are absent, which means the founding schema
decisions — table naming, the `shared_` / `ims_` / `pos_` / `hr_` prefix scheme, the multi-tenant
isolation model, the choice of `client_id` as the tenancy key — are undocumented.

**Do.** Add an `## Origins` section to `PRODUCT.md`, after the plans section T2b adds: a short
record of those decisions and, where you can still recall it, why. Mark anything uncertain as
uncertain rather than guessing. An honest "the reason for this is no longer recorded" is more useful
to a contractor than a plausible invention.

**Why `PRODUCT.md` and not a new file.** This document forbids creating `ARCHITECTURE.md` twice over,
and the origins note is not an exception to that rule — it is a handful of paragraphs, and a file
created to hold them would attract the fourth copy of the gate model within two sessions. It is not
`CLAUDE.md` either: per that file's own placement rule, a founding-decision record is not reachable
from a code edit and would be resident cost on every request. `PRODUCT.md` is already the
non-code-facing document a new reader is pointed at, and T2b is already opening it.

---

## T11 — Make the `CLAUDE.md` ceiling mechanical, so there is no fifth `/doctor` pass

**DONE — S664, 2026-09-01, commit `341d920`.** `scripts/check-claude-size.mjs`, ceiling 53,000 as
a committed constant that only ever goes down, failing with the three largest sections named and a
pointer at "Where a new rule goes". Wired alongside T3 and T4. The `.gitattributes` in the same
commit is part of this task, not incidental: without `text=auto eol=lf` the same file measures 455
bytes larger on Windows than on Linux, so the ceiling would mean something different per
contributor. The `DESIGN.md` side-question was answered — nothing auto-loads it, it is fine as is
— and chasing that answer is what produced T13.

S663 landed the root file at 51,745 chars and called it the honest floor. It is **51,761 today**. The
file's own text records that between the second and third pass it regrew 7,052 chars in three days —
and correctly diagnoses why: *"a new rule has one obvious home and no single session can see that it
is the fortieth to pick it."*

That diagnosis is right, and it means the problem cannot be solved by any single session's judgement.
Four `/doctor` passes have now been spent on it. The fifth is already scheduled by arithmetic.

**Do.** Add `scripts/check-claude-size.mjs`:

- Read a ceiling from a committed constant, initially **53,000** — the current size plus a small
  working margin, not the 40,000 aspiration. A ceiling that is already breached gets disabled.
- Fail non-zero when `CLAUDE.md` exceeds it, with a message naming the three largest `##`/`###`
  sections by character count and pointing at the "Where a new rule goes" section.
- Wire into `npm run build:verify` alongside T3 and T4.
- Ratchet: when a `/doctor` pass lowers the file, lower the constant in the same commit. It only
  ever goes down.

**Why a ceiling and not a target.** The migration decision needs the whole corpus in view, which a
session editing one module does not have. A hard stop does not require that view — it just refuses
the write and points at the rule. This converts a recurring manual audit into a one-time cost.

**Also worth checking in this task.** `DESIGN.md` is 61,149 chars, larger than `CLAUDE.md` itself.
Confirm what actually loads it. If any `.claude/rules/*.md` `paths:` glob pulls it in wholesale, it
is a bigger resident cost than the file S663 spent a session halving, and it belongs in the same
ceiling check. If nothing loads it automatically, it is fine as-is and this is a five-minute
confirmation.

---

## T12 — Login page copy: headline and bullets

**DONE — S667, 2026-09-01, commit `d8ff95d`.** Copy replaced, S606 closed on all three public
pages, service worker bumped to `crest-v179`. Two departures from the spec below, both measured
rather than chosen:

- **The POS / IMS / HR module headings were built and then removed.** They cost ~93px of column
  height, and this page is laid out to fit one screen (S553, tightened S560) — a budget the new
  copy already overran. The bullets still arrive in module order and the source still holds them
  grouped; they simply no longer announce it on screen. What was given up is precisely the spec's
  second reason for grouping, that it is also how a visitor learns Crest is three products.
- **That one-screen budget is no longer met, and the two places asserting it now carry the
  re-measured numbers** (`Login.css` and `.claude/rules/auth-and-pins.md`, which had also been
  saying the sign-in card rather than the pitch column drives the hero's height — now the reverse):
  1920x950 fits with 0px to spare, 1920x912 scrolls 21px, 1536x864 scrolls 61px, 1366x768 scrolls
  146px, 1366x613 fits with 0px. Bounded and checked — the sign-in card stays above the fold at
  every one of those sizes, so what falls below is the trial band, which the header CTA already
  anchor-links to.

On the two blockers: the upsell claim was confirmed live (the "Pair with" strip renders on the
order screen with PAIRED badges), so that bullet shipped as written. **The payroll-duration line
shipped as specified and was NOT separately re-verified** — its caveat below still stands, that
"done in one evening" holds where attendance is already in the system.

The spec below is kept as a record.

The signed-out surface still sells the IMS-only product. `Login.js` currently carries "Smarter
menus. Better margins." above six bullets, three of which restate one idea (Menu Repricing,
Theoretical Variance and dish affinity all read to an owner as "we tell you which dishes lose
money"), while POS gets one indirect mention despite being the lead product, and multi-outlet,
guest ordering and the data-ownership promise appear nowhere.

Per `PRODUCT.md`, `/login` is one of two deliberate brand-facing surfaces — its job is that a
visitor decides and acts, not that they complete a task. Copy is in scope for that reason.

### The replacement copy

Headline and subhead:

> **Your business, on one screen, one system for the cash, the store and the staff.**
> Built for Nepal's F&B industry.

Bullets, grouped under module headings (the grouping is deliberate — it is also how a visitor
learns Crest is three products):

**POS**
> - One free plate looks small. Crest shows what they add up to.
> - Guests spend more when the suggestion is right. Crest shows your staff what sells together.

**IMS**
> - Ingredient prices move every month. Your menu prices don't. Crest shows the gap.
> - You know what a plate sells for. Crest shows what it costs you to make.

**HR**
> - Staff quit without notice. Crest works out the final payment for you.
> - No HR person? Payroll for the whole team, done in one evening.

Ungrouped, last:
> - Your data stays yours. Ask any time and we hand it all back.

### The constraint the copy was written to, and why it must hold on any future edit

**Under ~16 words per bullet, two short sentences, no subclauses, Class-10 English.** Most buyers
read English as a second or third language. The failure mode is not simplicity, it is a 27-word
sentence with two subclauses that a sharp operator skims past. Every bullet is problem-then-relief
in that order, including within each module group — check this if any bullet is reordered.

### Three claims that were deliberately NOT made

1. **Nothing claims live or real-time food cost.** `writeSalesEntries` swallows depletion failures
   by design so a stock problem never blocks a bill closing, which means a bill can carry revenue
   with no `stock_movements` row (S573). That trade-off is correct, and it makes running food cost
   best-effort. Do not put a real-time accuracy claim on a signed-out page that has a known silent
   failure mode behind it.
2. **The data bullet says "Ask", not "Export any time".** Every file in the export path lives under
   `src/modules/admin/dataExport/` and the buttons are in Admin → Clients. There is no client-facing
   self-serve export. `PRODUCT.md` says "on request" and is correct; an earlier draft of this bullet
   dropped those two words and would have promised a button that does not exist.
3. **Nothing promises restore.** Export is well tested. Restore is not: the S545 live round-trip
   moved a single row, so FK ordering across populated tables remains unproven. Sell getting data
   out, which is verified. Do not yet sell putting it back.

### Blockers — resolve before shipping

- **Verify the upsell claim renders where the bullet says it does.** S210 built the upsell/cross-sell
  engine in three layers, but it is not clear from the log whether suggestions appear on the waiter's
  order screen during service or only in a manager-facing report. This is the only bullet on the page
  promising something a staff member sees mid-shift. If it is report-only, the line becomes
  *"Crest shows you what to push next."*
- **Verify the payroll duration claim.** "Done in one evening" is the only elapsed-time promise in
  the set and it holds only where attendance is already in the system. A café still on paper
  attendance has a short payroll night because the typing happened earlier.
- **Trial length: the badge is right, the old README head was wrong.**
  `CHANGELOG/S000-ORIGINAL-HEAD.md:65` says "Starter: 1-month free trial". The page says 7 days.
  The pricing page previously stated the trial four different ways — including an FAQ asking
  about a one-month trial and answering seven days — and it was collapsed to a single
  `TRIAL_DAYS` constant. Read the value from that constant; do not copy from either. T1 has
  landed, so that claim is archived history now rather than a live document.
- **Do not copy pricing from the old README head table either.**
  `CHANGELOG/S000-ORIGINAL-HEAD.md:61` shows the superseded NPR 5,000/8,000/12,000 bundle
  figures. Canonical pricing is `src/data/pricingPlans.js`:
  IMS tiered 2,000/2,600/3,500, HR flat 2,600, POS flat 2,000, Suite Pro a per-outlet add-on at
  +2,000 requiring IMS, annual 25% off.

### Fix S606 in the same commit

The one open backlog item is on this exact page. `Login.js`, `ResetPassword.js` and `Pricing.js`
render the `Hexagon` fallback unconditionally while still reading `settings.app_name`, so a
white-labelled client sees their own brand name beside Crest's generic mark on the page they log in
through. `Layout.js` already has the `settings.logo_url` conditional; these three never adopted it.
Editing `Login.js` for copy without fixing this means touching the file twice.

### Design constraints that apply

`/login` carries a real lighting model as of S659 and is one of two sanctioned brand-facing
surfaces. Per `DESIGN.md`'s One Accent Rule, Aged Brass is the only non-semantic colour on the page —
S659 already collapsed four CTAs in three hues down to one. A copy change must not reintroduce a
second accent to mark the new module headings. Use type weight and spacing to separate POS / IMS / HR,
not colour.

Also note the headline may wrap to three lines on mobile at this length. If it reads heavy, break
after "screen" rather than shrinking the type.

---

## T13 — Audit the rules corpus for effective resident cost

**Finding, not a task. Recorded because it was measured; the decision it leads to is deliberately
left open.**

T11 puts a mechanical ceiling on `CLAUDE.md` because everything in that file loads on every
request. Confirming the T11 side-question about `DESIGN.md` — nothing auto-loads it, it is fine as
is — surfaced that the ceiling may be measuring the wrong file.

`.claude/rules/*.md` is 411,319 characters across 25 files. None of it is always-on, which is the
whole point of the split. But "loads only when a matching file is open" is not the same as "rarely
loads", and nothing has ever measured the difference. Size alone is the wrong metric: a large rule
scoped to four files is cheap, and a small rule scoped to the whole of `src/` is not.

**The metric is size × glob reach** — characters multiplied by the number of files in the tree the
rule's `paths:` globs actually match. Measured 2026-09-01 against 363 files under `src/`:

| Rule file | Chars | Files matched | Share of corpus resident cost |
| --- | --- | --- | --- |
| `design-system.md` | 65,384 | 282 | **41.1%** |
| `frontend-performance.md` | 32,884 | 204 | 15.0% |
| `supabase-sql.md` | 37,494 | 154 | 12.9% |
| `component-library.md` | 16,516 | 279 | 10.3% |
| `hr-payroll.md` | 29,687 | 77 | 5.1% |
| `pos-billing.md` | 45,301 | 41 | 4.1% |

**The case that prompted this.** `design-system.md` is 65,384 chars — larger than `CLAUDE.md`
itself at 51,027 — and its globs are `src/**/*.css`, `src/components/**`, `src/pages/**` and
`src/modules/**`. That is 282 of 363 files under `src/`, so it loads on roughly four out of five
frontend edits. `component-library.md` carries nearly the same glob set. Together they are ~81,900
chars resident on most frontend sessions.

Four `/doctor` passes have been spent fighting over `CLAUDE.md`, and S663 halved it to reach 51k.
A rule file that loads on 78% of frontend edits and is 28% *larger* than the file those passes were
about has never been counted at all. `pos-billing.md` is the mirror image and shows the metric is
doing real work: at 45,301 chars it is the second-largest file in the corpus, but it is scoped to
41 files and costs 4.1%.

**Why this is not being fixed here.** Splitting `design-system.md` is not obviously right. A design
system may be a legitimate exception: unlike a module rule, its content is genuinely reachable from
any component or page, which is exactly the test `CLAUDE.md`'s "Where a new rule goes" prescribes —
and by that test the current glob set is correct rather than lazy. Narrowing it to buy resident
cost would be choosing a number over the rule that governs placement, and would reintroduce the
S663 failure in a new place: a design rule that stops loading for the files it is most about.

The alternatives are real but each has a cost, and choosing between them needs the whole corpus in
view:

- Split by concern — tokens and colour (always relevant) apart from component-specific guidance
  (reachable from fewer files). Risks a stub chain, which T4 now at least detects.
- Leave it and accept the cost as the price of a design system that is genuinely global.
- Narrow only `component-library.md`, the cheaper half of the pair, and leave the design tokens
  alone.

**Do, when it is picked up.** Add the metric to `scripts/check-rules-globs.mjs` as a reported
figure — printed on every run, failing nothing. A number that is visible every build does not need
a fifth audit to rediscover it. Set a ceiling only after the `design-system.md` question is
answered, because a ceiling set first would force that answer by arithmetic rather than by
judgement, which is precisely the mistake this entry exists to avoid.

**Not scheduled.** It is a decision about what the design system is for, not a defect with a
correct fix, so it does not belong in the ordered list below.

---

## T14 — Prose path and line-number references rot exactly like globs, and nothing checks them

**Finding, not a task. Recorded because it was measured. Deliberately not fixed.**

T3 exists because a `paths:` glob that matches nothing fails silently and permanently. A path
written in *prose* — `` `src/shared/errorText.js` `` in a rule file, `` `README.md:41–47` `` in this
document — has exactly the same failure mode and none of the coverage. `check-rules-stubs.mjs`
catches one narrow form, the `` …is in `.claude/rules/<file>` `` pointer, and nothing else.

**T1 proved the point on itself.** Landing the split broke three references the same afternoon:
this document's two pointers into `README.md:41–47` and `README.md:134–152`, and
`accounts-and-logins.md`'s "see S430 in the README session log". All three were repaired in S666,
by hand, because the session that broke them happened to be looking. Nothing would have reported
them.

**Measured 2026-09-01** across `CLAUDE.md`, the 25 rule files, and the seven root documents: **209
backticked repo paths and 10 `file:line` references.** 22 of the 209 do not resolve literally —
but only **one** is genuine rot: `POS_DECISIONS.md` cites `src/pages/PurchaseOneLakhAboveReport.js`
twice, and the file has been at `src/modules/ims/reports/PurchaseOneLakhAboveReport.js` since the
`src/pages/` → `src/modules/` migration — the same migration that rotted three globs in S663.

**The other 21 are the reason this is not the ten lines T3 was.** They fall into five kinds, and a
naive checker flags every one of them:

- **Relative shorthand.** `shared/errorText.js` means `src/shared/errorText.js`;
  `admin-user-ops/index.ts` means `supabase/functions/admin-user-ops/index.ts`. Both are clearer
  in context than the full path would be.
- **A wrong path quoted on purpose.** `CLAUDE.md` and this file both contain
  `src/contexts/AuthContext.js` — the S663 rot, quoted verbatim *because* it was the bug. A
  checker would flag the one place in the repo where that rot is documented.
- **Files that do not exist yet.** `scripts/gen-routes.mjs` (T2a), `CHANGELOG/pos-shipped.md` (a
  rejected T5a naming option).
- **Paths outside the repo.** `scripts/validate_palette.js` belongs to the `dataviz` skill.
- **Build artefacts.** `/static/js/bundle.js`.

So the check is not "assert the path exists". It is "assert the path exists, unless it is
shorthand, hypothetical, external, an artefact, or deliberately wrong" — and every one of those
exemptions is an allow-list that goes stale on its own. **The honest fix is a convention, not a
script**: write repo-root-relative paths in docs and drop line numbers entirely, then the check
becomes trivial. That is a decision about how to write, which is why it is recorded here rather
than done.

**Line numbers are the worse half.** A path breaks only when a file moves. A line number breaks on
any edit *above* it, in a file nobody thinks of as having moved at all, and there is no revision to
the reference for anyone to notice — it simply starts pointing at a different line and keeps
looking correct. Ten of them are live in the corpus today.

**And a dead prose reference is worse than a dead glob in one specific way.** A glob that matches
nothing is invisible: the rule silently does not load. A path that does not resolve is *visible and
confidently wrong* — a reader follows it, finds nothing, and generalises to the documentation as a
whole. That is the failure this entire document was written to stop, arriving through a door no
check is watching.
---

## Explicitly do not do in this pass

- **Do not create `ARCHITECTURE.md`.** `CLAUDE.md` + `.claude/rules/` already is it.
- **Do not restate anything from `CLAUDE.md`, `DESIGN.md` or `PRODUCT.md` in the new `README.md`.**
  Point at them. A summary is a copy that rots.
- **T12 is copy and the S606 logo fix only.** Do not redesign `/login`. It already carries a real
  lighting model (S659) and was audited clean against `DESIGN.md`/`PRODUCT.md`; a rip-and-replace
  would regress working code. Do not add a second accent colour for the module headings.
- Do not migrate CRA → Vite.
- Do not restructure `src/modules/`.
- Do not change RLS policies. The S37 audit result (18/18 tables RLS on, zero `USING(true)`) is
  a good state; leave it alone in a documentation pass.
- Do not bump the service worker version for T1–T5, T9, T10. No user-visible change ships from
  those tasks.
- Do not delete the original `README.md` content anywhere except from the working tree after the
  T1 completeness check has passed and been committed.

---

## Suggested order of work

1. ~~T3 + T4 + T11 (glob, stub and size checks)~~ — **DONE, S664.** All three land in `build:verify`
   together, and they protect the rules corpus before anything else touches it.
2. ~~T1 (split `README.md`)~~ — **DONE, S666.** Everything else is easier afterwards.
3. T2a (generated route table) — the gate-mismatch check is the real prize here.
4. T2b + T2c (plans section in `PRODUCT.md`, entity name).
5. ~~**T12 (login copy + S606)**~~ — **DONE, S667.** Copy replaced, S606 closed on all three public
   pages, service worker bumped. The module headings the copy specifies were built and then removed:
   they cost ~93px against the page one-screen budget, which the new copy already overran. That
   budget is no longer met (1536x864 scrolls 61px) and the comments in `Login.css` and
   `.claude/rules/auth-and-pins.md` were updated to the re-measured numbers rather than left
   asserting a fit the page no longer achieves.
6. T5 (backlog) — **T5a and T5c DONE, S665/S666. T5b outstanding**, before the contractor starts.
7. T6 (monitoring) — before launch. Jump the queue if a launch date lands.
8. T7 (staging) — before the contractor starts.
9. T8 (money-math coverage audit).
10. T9, T10 (debt register, origins).

T13 and T14 are findings, not tasks — each is a decision about how the corpus should be
written, not a defect with a correct fix, so neither is scheduled here.
