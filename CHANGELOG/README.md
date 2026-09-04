# Changelog

The Crest Suite session log. It was the back 15,198 lines of `README.md`, which reached
1,801,834 characters — about 45× the size at which Claude Code warns about a memory file, and
past what a person or a tool can read end to end. S666 split it here and gave `README.md` back
its job as a map.

## Session Log

654 entries, S023 to S674, across 16 files. **Newest first**, both inside each file and
down this table.

| Range | Entries | Dates | Size |
| --- | ---: | --- | ---: |
| [S650–S674](S650-S699.md) | 24 | 2026-08-30 → 2026-09-04 | 150 KB |
| [S625–S649](S625-S649.md) | 25 | 2026-08-28 → 2026-08-30 | 84 KB |
| [S600–S624](S600-S624.md) | 27 | 2026-08-22 → 2026-08-28 | 124 KB |
| [S575–S599](S575-S599.md) | 25 | 2026-08-19 → 2026-08-22 | 102 KB |
| [S550–S574](S550-S574.md) | 25 | 2026-08-13 → 2026-08-18 | 92 KB |
| [S525–S549](S525-S549.md) | 25 | 2026-08-06 → 2026-08-12 | 146 KB |
| [S500–S524](S500-S524.md) | 25 | 2026-08-03 → 2026-08-05 | 63 KB |
| [S450–S499](S450-S499.md) | 50 | 2026-07-27 → 2026-08-03 | 141 KB |
| [S400–S449](S400-S449.md) | 50 | 2026-07-15 → 2026-07-27 | 128 KB |
| [S350–S399](S350-S399.md) | 50 | 2026-07-11 → 2026-07-15 | 144 KB |
| [S300–S349](S300-S349.md) | 50 | 2026-07-07 → 2026-07-11 | 96 KB |
| [S250–S299](S250-S299.md) | 50 | 2026-07-05 → 2026-07-07 | 90 KB |
| [S200–S249](S200-S249.md) | 50 | 2026-07-01 → 2026-07-05 | 139 KB |
| [S150–S199](S150-S199.md) | 52 | 2026-06-25 → 2026-07-01 | 86 KB |
| [S100–S149](S100-S149.md) | 50 | 2026-06-21 → 2026-06-25 | 89 KB |
| [S023–S099](S023-S099.md) | 76 | 2026-06-17 → 2026-06-21 (+6 undated) | 128 KB |

Plus [`S000-ORIGINAL-HEAD.md`](S000-ORIGINAL-HEAD.md) (11 KB): the head of `README.md` as it
stood before the split — App Overview, the Plans table, the Routes table, "Pending Features" —
kept verbatim and **not corrected**. Every claim in it is stale. It is history, not reference.

## What the split did not do

**Nothing was reordered.** Every cut is at a session heading and every file holds one unbroken
run of the original, so the head archive plus these files concatenated in order reproduce the
pre-split `README.md` byte for byte. That was asserted, not assumed.

The consequence is that two long-standing oddities are still here, because they were always here:

- **The tail is out of order.** Inside `S023–S099.md`, after `S47` comes `S23`, `S24`, `S24/S25`,
  `S26`, `S27`, `S28`, `S45`, `S46`, `S31`, `S30`, `S29`, `S44`, `S43`, `S42`, `S41`, `S33`,
  `S32`, `S40`, `S39`, `S38`, `S37`, `S36`, `S35`, `S34`. Six of those carry no date at all,
  only `2026 (earlier)`.
- **`S197` appears three times**, on three genuinely distinct entries, in `S150–S199.md`.

Sorting either would have meant a split that could no longer be checked against the original, to
fix something no reader has ever been misled by.

## Adding an entry

1. Prepend it to the **newest** range file, above the entry currently at the top. The heading is
   `### S<n> — YYYY-MM-DD — what changed`, in the past tense, saying what is different now
   rather than what was worked on.
2. State explicitly whether app code changed, and whether the service worker was bumped. A reader
   six months from now cannot otherwise tell a docs-only session from a shipping one.
3. Run `npm run changelog:index`. It rewrites this table and each range file's header from the
   files themselves, so no count here is ever typed by hand.

**Start a new range file when the current one passes about 150,000 characters.** The ceiling is
200,000 — the point at which a file stops being readable by the things that need to read it —
and the margin exists so one long session cannot breach it. Name the file for the 50-session block
it opens, not for the sessions it currently holds, so it need not be renamed as it fills.
