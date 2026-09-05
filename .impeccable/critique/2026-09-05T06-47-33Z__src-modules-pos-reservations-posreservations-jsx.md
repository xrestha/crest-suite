---
target: reservation page
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-09-05T06-47-33Z
slug: src-modules-pos-reservations-posreservations-jsx
---
**Method: dual-agent (A: design review · B: detector + browser evidence)**. Both ran from source; no dev server was up and the route needs a login, so neither had a rendered page. Run one day after S680's `/impeccable audit` fixes landed (btn-sm base rule, Tip host mode, aria-busy rows).

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Requests poll every 15s, but the day list never does — a colleague's "Arrived" on another device is invisible until this device acts. |
| 2 | Match System / Real World | 3 | Adjacent headers "Guest" / "Guests". "Covers", "Via", "×4" are trade shorthand for a second-language host. |
| 3 | User Control and Freedom | 2 | No-show, Completed and Cancelled are dead ends (`TRANSITIONS`). "Done" closes a booking permanently in one tap, no confirm. |
| 4 | Consistency and Standards | 3 | Request band and empty state are hand-rolled `.card`s; `ConfirmModal.js:32` Cancel is a bare `btn` with no variant. |
| 5 | Error Prevention | 3 | Stale-write guard and busy-table lockout strong; no confirm on Done, no same-phone duplicate check. |
| 6 | Recognition Rather Than Recall | 3 | Notes and occasion behind a `RowDisclosure` — "cake at 8" needs a click on the night. |
| 7 | Flexibility and Efficiency | 3 | No search by name or phone. |
| 8 | Aesthetic and Minimalist Design | 2 | A booked row carries six identical `btn-ghost btn-sm`; subtitle repeats the title Tip. |
| 9 | Error Recovery | 4 | Every failure names the consequence and the recovery. |
| 10 | Help and Documentation | 3 | `<th>` Tips on Tables/Status have no ⓘ — unreachable on touch. |
| **Total** | | **29/40** | **Good** |

## Design Specificity Verdict

Authored for this product, on a generic scaffold. Crest-only and load-bearing: BS-first dates with AD in parentheses even inside the WhatsApp `{date}`; WhatsApp as the confirmation rail with "nothing is sent automatically"; the capacity strip against the room's real seats per hour, warn-only by stated stance; the phone-blur lookup (visits, unsettled credit, prior no-shows); the status ladder spending amber on exactly Requested and Arrived. Generic/translated: Occasions (no Bhoj, no Tihar/Dashain dinner), the Western `CANCEL_REASONS`, the 💬 platform emoji standing in for WhatsApp.

Deterministic scan: 0 findings on PosReservations.jsx / ReservationModal.jsx / SeatTableModal.jsx and on Tip.js / Modal.js / RowDisclosure.jsx / Fab.js, configured and `--no-config`. No inline ignores. Regex-mode only — nothing about rendered contrast, tap size or overflow.

Visual overlays: none. Browser visualization skipped — no dev server running, route requires an authenticated session, no credentials.

## Overall Impression

The most honest page in POS: every failure path names its consequence, every signal colour means one thing, the form knows what the host would otherwise type. The biggest opportunity is the row: a flat bar of six identical 12px buttons where the two irreversible moves sit beside the routine ones, and nothing on the page says what happened after a press.

## What's Working

- Consequence-first dialogs (No-show lists three effects; Decline says what the guest's phone shows; partial-save names the fix). Nothing says "Are you sure?".
- Signal vocabulary applied: Requested/Arrived the only ambers, No-show the only red, `△ late` with grace minutes.
- `SeatTableModal`: held tables first, busy tables disabled and labelled, consequence before the tap.

## Priority Issues

**[P0] Terminal states are dead ends, and one is a single unconfirmed tap away.** `no_show: []`, `completed: []`, `cancelled: []` in `reservationStatus.js`; "Done" calls `transition(r,'completed')` with no confirm. A no-show is recorded against a phone number forever. Fix: `no_show → arrived` and `cancelled → booked` on the booking's own day, clearing the stamp; route Done through `ConfirmModal`. → `/impeccable harden`

**[P1] Decline reuses `CANCEL_REASONS`; terminal rows still offer 💬 with the booking-confirmation template.** "Guest cancelled" shown on the phone of a guest who requested is false; a confirmation message to a completed/no-show guest is nonsense. Fix: `DECLINE_REASONS` picked when `status === 'requested'`; hide 💬 on `completed|cancelled|no_show` or per-status templates. → `/impeccable clarify`

**[P1] The row action cluster is a flat six-button bar per row** (`rowActions()`), progress and ending moves interleaved, Cancel ghost like Confirm. Fix: one next-step button per row + 💬, with No-show/Cancel/Done in a `⋯` overflow (`aria-haspopup="menu"`); minimum a hairline before the ending actions and `btn-danger` on both. → `/impeccable distill`

**[P1] Accept has no success signal and the accepted row can vanish** — requests are unfiltered by day while the list is bounded to `dayIso`. Fix: transient `role="status"` line after every transition ("Sharma ×4 confirmed for 3rd Bhadra") with a jump-to-day link when the day differs. → `/impeccable clarify`

**[P2] Words, and the hidden note.** "Guests" → "Party"; "Covers booked" → "Guests expected"; "Via" → "Booked by". Occasion as `badge-yellow` chip and first line of notes as `.cell-sub` under the name. → `/impeccable clarify`

## Persona Red Flags

- Power host, 60 covers: 150+ identical buttons; no name/phone search; notes behind a chevron; day list doesn't poll; every Seat leaves the page; `isLate` ignores `arrived`.
- First-timer with the link just on: empty state names no action, link or QR; requests explained only once one exists; "set table capacity in Tables" is plain text.
- Owner on a phone: four stat cards before the list; seven columns scroll and the action cluster scrolls off; seven-control header wraps to three lines at 390px; capacity strip suppressed in "Next 7 days".

## Minor Observations

- `ConfirmModal.js:32` bare `className="btn"` (S678 UA-chrome bug, shared component).
- `actionBtn` stacks `btn-ghost` + `btn-danger`; works only by declaration order.
- Request band is `.card` + inline amber border (a fourth banner shape); empty state hand-rolls padding instead of `.empty-state`.
- Phone rendered as typed, unnormalised.
- Time cell uses three inline sizes (11/13/10) where `.cell-sub` exists.
- Two tooltip idioms: ⓘ everywhere except the two `<th>` Tips.
- Subtitle duplicates the 39-word title Tip; PRODUCT.md's copy constraint is two short sentences.

## Questions to Consider

- Why is the book a table, when a host reads it by time against seats — the thing the capacity strip already computes?
- Should Seat leave the page at all?
- Who forgives a no-show? The mark is permanent, on every future form, with no reversal or decay.
