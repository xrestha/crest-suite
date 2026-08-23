---
target: guest menu
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-22T16-11-34Z
slug: src-modules-pos-guestmenu-guestmenu-jsx
---
Method: dual-agent (A: design review · B: detector + browser evidence)

**Process disclosure:** the target's palette was rewritten mid-run while both agents measured it.
Both caught it and labelled findings pre/post-redesign; A re-verified everything load-bearing in a
clean isolated context.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Order tracker excellent; sticky nav dead; 5s status poll drops `error` so a failed read renders identically to "no open order" |
| 2 | Match System / Real World | 2 | Menu section named "OTHER", POS-master ALL-CAPS dish names, sections alphabetical (Beverage before Food) |
| 3 | User Control and Freedom | 3 | Cart survives reload/table-switch; emptying it dead-ends; no "call a waiter" |
| 4 | Consistency and Standards | 3 | Palette rigorous; two solid-pine CTAs can co-exist; inline-styled buttons fall through to UA focus outline |
| 5 | Error Prevention | 2 | Nothing binds the order to a table at commit; admin preview creates genuine live orders guarded only by prose |
| 6 | Recognition Rather Than Recall | 2 | No images, no descriptions, no search; Filters only renders if data exists |
| 7 | Flexibility and Efficiency | 2 | No search, no repeat-order, no per-item note; only IA device is the chip bar, which does not work |
| 8 | Aesthetic and Minimalist Design | 4 | Rationed accent, honest ink ramp, paper elevation |
| 9 | Error Recovery | 2 | Load failure has real Retry; "unavailable" conflates three causes; submit failure shows raw Postgres text |
| 10 | Help and Documentation | 1 | Nothing states VAT inclusion, payment flow, or offers Nepali on a bilingual market's only public page |
| **Total** | | **23/40** | **Acceptable — the surface is beautiful and under-informed** |

## Design Specificity Verdict

The composition is now authored; the content is still generic, and nothing on this page belongs to
the restaurant. The bone/pine system reads as a printed menu card, not a template. But a diner
receives seven ALL-CAPS strings and seven prices in four alphabetically-ordered sections, one named
`OTHER`. The live RPC returns `description: null, image_url: null, is_veg: null` on every row; the
page supports all three and the product never asks the operator for them. `<title>` is "Crest Suite"
with no `og:` tags, so sharing the link previews B2B inventory software to a diner.

**Deterministic scan:** zero findings across GuestMenu.jsx, AdminGuestMenu.jsx and guestMenu.css.
Verified not-vacuous by a positive control (a probe file returned exit 2, 4 findings) and by
rebuilding the project with `ignoreValues: []` — still clean. Clean on merit, not by exception. All
14 palette tokens were independently recomputed to within 0.05 of the ratios DESIGN.md claims.

**Visual overlays:** injection succeeded on the second attempt. 8 findings, all false positives for
this page (7x `.card` border+shadow, 1x `body` transition), all traced to Layout.css shell rules the
page merely inherits. Live server confirmed stopped three ways.

**Measurement conflict resolved:** A measured touch targets under `pointer: coarse`, B did not.
Layout.css:1170-1173 gives `.btn` a 44px coarse floor and :1204-1206 gives `.tab-btn` only 32px, so
A's numbers apply to a real phone. B's "11/11 under 44px" is a fine-pointer artifact.

## What's Working

- **The order tracker** (GuestMenu.jsx:580-639) — five stages fusing request status with KOT status;
  the chime fires only on a real stage change and never on mount; the ETA reads "about N min left"
  and is suppressed once non-positive, so nobody gets a negative countdown on late food.
- **Cart durability** (:143-164) — survives a phone lock, and clears when switching to a different
  table's QR so it cannot be submitted against the wrong one.
- **The palette fixed an ownership bug, not a taste problem** — the public menu could previously
  inherit whatever preset a staff phone had saved in localStorage.

## Priority Issues

**[P0] The sticky category bar has never stuck — the menu's only navigation is dead.**
Measured twice independently: barTop 131 -> -219 -> -284. Cause is index.css:1-3
`html, body { overflow-x: hidden }` — body becomes its own scroll container sized to content, so a
sticky child has a scrollport that never scrolls. The IntersectionObserver, the -60px rootMargin and
`--guest-menu-nav-h` all pay for a feature that does not run.
Fix: own scroll container on `.guest-menu`, or scope out the body rule for this route.
Suggested command: /impeccable adapt

**[P0] "Total NPR 500" is an unqualified promise the page does not control.**
GuestMenu.jsx:12 applies `vat_rate` unconditionally; the till gates it on `is_vat_registered`;
`get_guest_menu` never returns that flag. A non-registered client shows every price ~13% above what
it bills. Found independently by two reviewers.
Fix: return the flag, gate `priceIncVat`, add one disclosure line under the Total.
Suggested command: /impeccable clarify

**[P1] It is a price list, and the product never asks the operator to make it a menu.**
Photography is the largest conversion lever on a QR menu; a description is the only way a tourist
knows what choila is. Fix: have the admin preview state coverage out loud ("0 of 7 dishes have a
photo") with a link into Recipes, and design the no-image card deliberately rather than letting it
collapse to a text row.
Suggested command: /impeccable onboard

**[P1] Nothing binds the order to the table at commit.**
The table name appears once as 13px tertiary text and never again; the review modal never says where
the food is going. QR stickers get moved and guests scan neighbouring codes.
Fix: "Sending to <Table>" above Place Order, repeated in the confirmation card.
Suggested command: /impeccable clarify

**[P1] The status poll drops `error`, so a failed read looks like "no open order".**
GuestMenu.jsx:185 destructures `{ data }` only. This is the S594 rule — a failed read is not an
empty period — on the guest surface. The poll also never pauses: ~55 requests observed in one
sitting, 720/hr per open tab, no visibilitychange gating.
Suggested command: /impeccable harden

**[P2] Touch and focus, on the one surface that is 100% touch.**
Category chips 32px, Stepper 40x40, modal close 34.6x24 — all under the 44px target. The cart bar is
`bottom: 16` with no `env(safe-area-inset-bottom)` while viewport-fit=cover ships, so the primary CTA
sits in the home-indicator gesture strip. Inline-styled buttons carry no `.btn` class and fall
through to the UA focus outline. The textarea is 13px (iOS zooms and never returns) and has no
accessible name at all.
Suggested command: /impeccable audit

## Persona Red Flags

**Tourist who has never eaten choila** — gets a name and a number. No photo, no description, no veg
mark, and Filters does not render because there is no data behind it.

**Nepali diner, 50s, dim cafe** — 32px chips in a horizontal scroller they must discover, ALL-CAPS
names, no Nepali anywhere. `<html lang="en">` is fixed and `recipes` has one `name` column, so
bilingual is structurally impossible today — a roadmap decision, not a bug.

**Screen-reader user** — the S569/S576 label sweep never reached this file: unnamed textarea, four
steppers sharing two labels, covers caption a bare span with no role="group".

**The cafe owner sharing their own QR link** — the preview card advertises their supplier's
back-office software.

## Minor Observations

- Empty-cart modal is a dead end with no action and no auto-close.
- Raw Postgres err.message is rendered to the diner on submit failure.
- The review modal is a centre-floating card, not a bottom sheet; its close control sits at the far
  end of a one-handed reach. Modal now supports a `sheet` variant.
- AdminGuestMenu.jsx:25 uses `.neq('status','inactive')` on a nullable column — the documented .neq
  trap, silently dropping NULL-status tables.
- AdminGuestMenu.jsx:23-32 drops `error` and renders "This client has no tables set up yet" on a
  failed read. A cold-load bug was also reproduced where it claims no client is selected despite
  localStorage holding one.
- The admin preview renders a phone page at 1134px, so the person who could ask for the mobile fixes
  never sees them.
- guestMenu.css:81 inverts `--theme-border-lt` to mean stronger. Documented and scoped, still a
  landmine for the next editor.
- One unattributed state change was logged (cart went to 3 items during a tab-through), not
  reproducible, attributed to overlay probing — inference, not measurement.

## Questions to Consider

1. If the restaurant's name is the only thing here that belongs to the restaurant, is this a menu
   product or a menu renderer?
2. The tracker is delightful and the browsing experience is a price list — Crest built the part a
   guest sees for 30 seconds and skipped the part they read for five minutes. Decision, or did
   engineering-shaped work displace content-shaped work?
3. A section called "OTHER" is a database default reaching a paying customer. What review step would
   have caught it?
4. If the sticky nav has never worked in production, has anyone browsed this page on a phone, at a
   table, past the fold, with a real menu behind it?
