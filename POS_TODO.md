# Crest POS — Consolidated To-Do List

Open POS work only. Everything shipped, and everything deliberately decided against, moved to
[POS_DECISIONS.md](POS_DECISIONS.md) on 2026-09-01 with its rationale intact — nothing was deleted.
That file, not this one, is the record of what has already been considered.

**When an item here ships, move it to `POS_DECISIONS.md` in the same commit** rather than striking it
through in place, or this file goes back to being 92% history and stops being read as a to-do list.

**Status key:** 🔴 Missing · 🟡 Partial · 🔵 Deferred (decided to postpone) · ⚪ Open question (not engineering)

Last updated: 2026-10-09 (S809 — stages 1 and 2 complete: every slice 1a–1l and 2a–2h shipped live; stage 3 next)

---

# S809 re-analysis (2026-10-08)

The second whole-module review of Crest POS, 24 days after S754. About twenty sessions had added POS code
since then that no whole-module review had seen:

- S755's five gap fixes;
- Crest Customization and build-your-own (S758–S760);
- the Billing station (S762) and guest-order alerts (S763);
- the guest menu in the restaurant's name (S767);
- the S776 critique fixes.

Fourteen read-only area reviews covered checkout, order flow, access, shifts, credit notes, the IMS handoff,
reports, the floor and kitchen, guest QR ordering, reservations, customers and parking, Customization, the
database and the docs. A completeness pass then covered three gaps between them: multi-outlet groups
(GAP-OUTLETS), the Crest operator inside a tenant (GAP-OPERATOR), and a till living across a release or
offline (GAP-RELEASE).

Each area ran reviewer → adversarial verifier/judge. The verifier re-read the code and the LIVE function,
trigger, policy and grant bodies, and re-checked every P0 and P1 live. The main session re-checked the P0
against the live catalog itself. Nothing was written to the live database. The evidence for each ID is in
`docs/pos-review-s809/<AREA>.md`: where, what happens, evidence, fix, confidence, verification.

**Live exposure is small.** Only BLOOM CAFE (a test outlet) has POS bills: 40 closed. No POS client is
VAT-registered, none has Customization on, and only 1 booking-table link exists. So most findings are code
findings that bite once a real outlet runs the till. The few seen in live data are marked "live".

**172 findings** (165 in the fourteen area files and 7 in `GAPS.md`) make **171 rows** after merging
ORDER-FLOW-1 = CHECKOUT-9, kept at P1. That is **1 P0 · 7 P1 · 70 P2 · 93 P3**. 65 rows need a migration, and
27 owner decisions (Q1–Q27) are in S809.1. None was rejected outright. The verifiers changed about a fifth
of the severities and corrected most "What happens" lines; each file's "Verified:" lines say what.

## S809.0 Index

Stage: 1 = security, tenant boundaries and REST holes; 2 = bills, tax and stock stored or printed wrong;
3 = the floor, kitchen, guests, bookings, loyalty and report figures (lost work and wrong figures);
4 = P3 copy, docs and polish. Within a stage, P0/P1 rows go first. Mig = needs a migration.

### P0 (0 open; RESERVATIONS-1 shipped in slice 1a, see POS_DECISIONS.md)

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |

### P1 (1 open; CHECKOUT-2, DATABASE-1, ORDER-FLOW-2 shipped in slices 1c–1d, ACCESS-1 in 1e, ORDER-FLOW-1 in 2a, CHECKOUT-1 in 2a–2b)

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |
| GUEST-1 | A guest's "Note for the kitchen", an allergy for example, never reaches the kitchen: it shows grey on the waiter's banner and Accept drops it | 3 | Q11 | no |

### P2 (34 open; shipped in stage 1: CHECKOUT-8, GUEST-4, RESERVATIONS-3, RESERVATIONS-4, DATABASE-4, DATABASE-5, CUSTOMERS-PARKING-7, SHIFTS-2, ACCESS-2, ACCESS-3, ACCESS-4, DOCS-1; in stage 2: CHECKOUT-5, CHECKOUT-7, CHECKOUT-3, CHECKOUT-4, CHECKOUT-10, CREDIT-NOTES-4, SHIFTS-1, CHECKOUT-6, REPORTS-1, CREDIT-NOTES-1, CREDIT-NOTES-2, SHIFTS-3, IMS-HANDOFF-2, IMS-HANDOFF-3, CUSTOMERS-PARKING-1, CUSTOMERS-PARKING-2, CUSTOMERS-PARKING-3, CUSTOMIZATION-1, CUSTOMIZATION-3)

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |
| ACCESS-5 | Deleting a cashier's POS login wipes their name from past bills, shifts and credit notes, though the confirm says names stay | 3 | Q17 | no |
| ACCESS-6 | A page reload restarts the idle lock with 3 fresh minutes in the absent waiter's session | 3 | — | no |
| ACCESS-7 | Locking one till signs that waiter out of every other till, and the other till loses its unsent order | 3 | Q18 | yes |
| CREDIT-NOTES-3 | A note that couldn't reach Inventory waits for "a manager" in Periods. A POS manager can't open Periods, and an IMS supervisor is told nothing is waiting | 3 | Q12 | yes |
| CUSTOMERS-PARKING-4 | A regular's points are found only when the phone is typed exactly as on the first bill | 3 | — | yes |
| CUSTOMERS-PARKING-5 | "Ask the Owner to add the points" leads nowhere: no screen can add or correct a balance | 3 | Q13 | yes |
| CUSTOMERS-PARKING-6 | A lost Settle reply ends in "already settled", so the cashier believes a colleague took the money | 3 | — | no |
| CUSTOMERS-PARKING-8 | Customers → Loyalty lists only the first 1,000 customers | 3 | — | no |
| CUSTOMIZATION-2 | Hiding a sold-out choice mid-service blocks the whole table's order on the till | 3 | — | no |
| DATABASE-2 | "Clear POS Transactions" deletes every Inventory stock movement, manual ones included, and "Clear IMS" has the mirror fault. Operator-only, never run | 3 | — | no |
| DATABASE-3 | A restore reports success while dropping parking slips, and once a cash refund exists, every Cash In/Out | 3 | — | no |
| DOCS-2 | Help tells a cashier to void and re-ring to fix a split payment, which re-sends the food and books a void; ↩ Undo already does it | 3 | — | no |
| FLOOR-KITCHEN-1 | A waiting QR order is never announced loudly on a till: Orders chimes once and the PIN screen hears nothing (S763 left Orders quiet for the floor view) | 3 | Q14 | yes |
| FLOOR-KITCHEN-2 | A ticket with every dish pulled stays in New and keeps alarming; clearing it fakes Start/Ready and shows the floor false "Ready" | 3 | — | no |
| FLOOR-KITCHEN-3 | An all-Kitchen ticket routing is saved but ignored: Beverage still goes to the Bar ticket and board | 3 | Q15 | no |
| GUEST-2 | A lost Place Order reply plus a retry sends the guest order twice once staff took the first | 3 | — | yes |
| GUEST-3 | The server lets a second decision overwrite the first, so a dismissed guest order can be accepted and doubled (server half of ORDER-FLOW-11) | 3 | — | yes |
| IMS-HANDOFF-1 | Only the Owner and operator can post waiting till bills into Inventory; an IMS supervisor is told nothing waits (one decision with CREDIT-NOTES-3) | 3 | Q12 | yes |
| IMS-HANDOFF-4 | The Owner Report's POS section fails above roughly 200–400 bills a month, and drops credit-noted bills | 3 | — | no |
| ORDER-FLOW-3 | A lost Send reply plus most kinds of retry leaves dishes "✓ sent" with no ticket printed | 3 | — | no |
| ORDER-FLOW-4 | Two tablets pressing KOT for the same unsent dishes both print a ticket | 3 | — | yes |
| ORDER-FLOW-5 | Send, Update, KOT and BOT have no time limit: one stalled request freezes every send and Payment on that till | 3 | — | no |
| ORDER-FLOW-6 | Wi-Fi up but internet down: the till can't send anything, because offline mode waits for the browser to say offline (KNOWN B3) | 3 | Q16 | no |
| ORDER-FLOW-7 | A table opened offline gets its kitchen tickets logged twice when two uploads overlap | 3 | — | no |
| ORDER-FLOW-8 | Dishes fired offline onto a bill another till closed leave no trace once the conflict is dismissed | 3 | — | no |
| ORDER-FLOW-9 | An instruction added after a dish was sent ("no peanuts — allergy") reaches the paper ticket but never the Kitchen Display | 3 | — | no |
| ORDER-FLOW-10 | If the order a till lock interrupted was billed meanwhile, the whole old cart returns as "not sent" | 3 | — | no |
| ORDER-FLOW-11 | An accepted guest order returns to the banner within 5 s with Accept live; a second Accept doubles the dishes | 3 | — | no |
| REPORTS-2 | 1L+ (Annexure 13) loses past fiscal years once an outlet passes about 1,00,000 bills, and a failure is wiped by the tab's own load | 3 | — | yes |
| REPORTS-3 | The POS Dashboard and Home count takeaway/delivery bills as guests, so covers disagree with the Covers Report (live) | 3 | — | no |
| REPORTS-4 | The Customization Report costs a size-scaled choice from one arbitrary bill's portion | 3 | — | no |
| RESERVATIONS-2 | An Arrived party seen outside its booking window gets no "Seat" prompt, stays Arrived for good and counts as walk-in | 3 | — | no |
| RESERVATIONS-5 | Three recovery instructions send staff to controls that don't exist, or say closing the bill completes a booking | 3 | — | no |
| SHIFTS-4 | When a Credit-bill cash settlement misses the drawer, Customers' instructions make the drawer read wrong | 3 | — | no |

### P3 (81 open; shipped in stage 1: RESERVATIONS-12, CREDIT-NOTES-6, ACCESS-8, ACCESS-9, CHECKOUT-16, DATABASE-9, CHECKOUT-12, CUSTOMERS-PARKING-13; in stage 2: SHIFTS-7, CREDIT-NOTES-5)

| ID | Finding | Stage | Decision | Mig |
| --- | --- | --- | --- | --- |
| ACCESS-10 | A dead till says a POS manager can re-activate it, but a POS manager can't sign in on a dead tablet | 4 | — | no |
| ACCESS-11 | Deactivating the tablet you are signed in on with a PIN turns its idle lock off | 4 | — | no |
| ACCESS-12 | A correct PIN can land the waiter on the Owner's email login with no message | 4 | — | no |
| CHECKOUT-11 | A reprint from Recent Bills takes HSC codes and "Cashier" from the wrong bill | 4 | — | no |
| CHECKOUT-13 | A PAN bill's Net Amount doesn't add up on paper (no Round Off line), and a Credit bill prints a "Tender" | 4 | — | no |
| CHECKOUT-14 | The Complimentary tab says the slip shows no outlet name; it does | 4 | — | no |
| CHECKOUT-15 | A save refused while split payments are recorded closes the payment window and silently drops them | 4 | — | no |
| CREDIT-NOTES-7 | Searching notes by invoice number lists every fiscal year's match with no year shown | 4 | — | no |
| CREDIT-NOTES-8 | The printed note loses a customized line's choices | 4 | — | no |
| CREDIT-NOTES-9 | The Credit Notes page and the note's "Invoice Date" use the viewer's clock zone | 4 | — | no |
| CREDIT-NOTES-10 | An unconfirmed cash refund's warning sends the manager to record it on the wrong shift. Since 2e the refund is written with the note, so only a page older than crest-v420 can still show that warning | 4 | — | no |
| CUSTOMERS-PARKING-9 | An unpaid Credit bill earns spendable points at close, though the guide says points follow payment | 4 | Q19 | yes |
| CUSTOMERS-PARKING-10 | Nothing shows what points are worth per bill, and changing the point value re-prices every balance unwarned (BLOOM CAFE's test schemes give back 100% and 400%) | 4 | — | no |
| CUSTOMERS-PARKING-11 | The payment window promises points to customers who will earn none | 4 | — | no |
| CUSTOMERS-PARKING-12 | A scheme's rate box keeps a change the database refused; clearing it saves 0 and stops earning | 4 | — | no |
| CUSTOMERS-PARKING-14 | A blocked pop-up loses the parking token silently; the guest's only token reads "REPRINT #2" | 4 | — | no |
| CUSTOMERS-PARKING-15 | Parking re-reads every slip ever issued on each open and Mark Exited | 4 | — | no |
| CUSTOMERS-PARKING-16 | An overlapping Settle load can store the previous bill's commission and post the wrong cash | 4 | — | no |
| CUSTOMIZATION-4 | The till's price for a size-scaled topping is a paisa off the server's on about 1 price in 25 | 4 | — | no |
| CUSTOMIZATION-5 | A "No …" choice uses up a free pick and a place under the maximum | 4 | Q20 | yes |
| CUSTOMIZATION-6 | Sizes are stored as a difference from the dish price, so a dish price rise silently raises every size | 4 | — | yes |
| CUSTOMIZATION-7 | Changing a group's kind keeps old per-dish pick rules, so a Size can be skipped or picked twice | 4 | — | yes |
| CUSTOMIZATION-8 | Hiding options can leave a "must pick 2" group with one option, taking the dish off the till unwarned | 4 | — | no |
| DATABASE-6 | Every restore of a QR-ordering client reports the guest-order table as failed | 4 | — | no |
| DATABASE-7 | Bills and lines have no FK to their client; a deleted client's open order is still in the live table (KNOWN) | 4 | — | yes |
| DATABASE-8 | The floor, KDS and nav badges re-read the whole order and ticket history every poll; no index matches | 4 | — | yes |
| DOCS-3 | Help gives six wrong answers about who may do what at the till | 4 | — | no |
| DOCS-4 | Help still calls Guest QR ordering a Pro switch an admin turns on | 4 | — | no |
| DOCS-5 | The POS guide still says S754's database rules and tablet keys are not live, plus three more stale sentences | 4 | — | no |
| DOCS-6 | Help, the guide, the alerts rules and a comment say Orders shows a waiting guest order (copy half of FLOOR-KITCHEN-1) | 4 | — | no |
| DOCS-7 | Sales Report's help promises each day reconciles to that day's shift; a shift is not a day | 4 | — | no |
| DOCS-8 | Credit-note copy points managers the wrong way twice ("price correction" credits the whole bill) | 4 | — | no |
| DOCS-9 | Periods says the frozen Owner Report waits for "an admin"; the Owner can regenerate it | 4 | — | no |
| DOCS-10 | pos-billing.md still says the till calls `get_next_pos_comp_slip_no` per Charge (untrue since S286) | 4 | — | no |
| DOCS-11 | Seven rule sentences and code comments describe mechanisms that no longer hold; two would steer a change wrong | 4 | — | no |
| DOCS-12 | This file keeps a shipped S792 item open and the webhook secret's old home; POS_DECISIONS states two superseded rules | 4 | — | no |
| FLOOR-KITCHEN-4 | A voided order's tickets vanish from the KDS mid-cook with no word to the kitchen | 4 | — | yes |
| FLOOR-KITCHEN-5 | A Ready ticket drops off the KDS after 10 minutes but is never marked served; the floor keeps saying Ready | 4 | — | no |
| FLOOR-KITCHEN-6 | The KDS poll has no stale-answer guard and its taps no time limit | 4 | — | no |
| FLOOR-KITCHEN-7 | A table can be marked Inactive with an open bill; the floor then refuses it silently | 4 | — | yes |
| FLOOR-KITCHEN-8 | Two tables can share a name, and a mid-meal rename splits one order's tickets | 4 | — | yes |
| FLOOR-KITCHEN-9 | A KDS reloaded by the browser makes no sound until touched, and says nothing | 4 | — | no |
| FLOOR-KITCHEN-10 | On the Billing station, a guest-order banner covers the bill's top bar | 4 | — | no |
| GUEST-5 | A paid choice is silently dropped when a dish's last choices are switched off while the menu is open | 4 | — | yes |
| GUEST-6 | The guest menu's first load has no time limit and no "Try again" | 4 | — | no |
| GUEST-7 | Anyone who ever scanned a table's QR can order to it from anywhere, for as long as the table exists | 4 | Q21 | yes |
| GUEST-8 | Saving the guest-menu logo on a slow connection can end with no message | 4 | — | no |
| IMS-HANDOFF-5 | Ending a month never asks whether its till bills reached Inventory | 4 | — | no |
| IMS-HANDOFF-6 | Stock Movements shows a till sale that added stock as one that took it away (live at BLOOM CAFE) | 4 | — | no |
| IMS-HANDOFF-7 | The Inventory Dashboard's manual Sales by Category and Sales Mix count a credit note's reversal; Sales Mix subtracts it twice | 4 | — | no |
| IMS-HANDOFF-8 | A till bill is filed in Inventory under the tablet's date at post time, not its close time (KNOWN, IMS_TODO) | 4 | — | no |
| IMS-HANDOFF-9 | A till on a client without IMS writes Inventory rows in month one, then says every bill "was not posted" | 4 | — | no |
| IMS-HANDOFF-10 | Inventory takes a closing bill's lines from the till's screen, not the stored bill | 4 | — | no |
| ORDER-FLOW-12 | Unsent items kept by the till lock are lost if the order can't be read at sign-in | 4 | — | no |
| ORDER-FLOW-13 | Pull, save, add back prints "CHANGE ONLY" instead of "+1", so the dish is never re-fired | 4 | — | no |
| ORDER-FLOW-14 | The cover count is written outside the "changed on another device" check | 4 | — | no |
| ORDER-FLOW-15 | A queued offline order carries no outlet and replays into whichever client is signed in | 4 | — | no |
| ORDER-FLOW-16 | An offline upload finishing after the waiter moved tables stamps its version onto the table on screen | 4 | — | no |
| ORDER-FLOW-17 | A cart line's kitchen timer is matched by dish, not line | 4 | — | no |
| ORDER-FLOW-18 | A guest order accepted onto a table another tablet changed shows "accepted" even if its dishes were refused | 4 | — | no |
| ORDER-FLOW-19 | The order-delete pulled-item record groups by dish, not line | 4 | — | yes |
| REPORTS-5 | The POS Dashboard and Home drop a credited bill from its own day and never subtract the note | 4 | Q22 | no |
| REPORTS-6 | Delivery Partners' Outstanding goes negative, or counts a cancelled bill, across date ranges | 4 | — | no |
| REPORTS-7 | Comped Bills values a comp with VAT, Exceptions without: 13% apart | 4 | — | no |
| REPORTS-8 | Home's POS and kitchen cards show and cache zeros on a failed read | 4 | — | no |
| REPORTS-9 | POS Sales by Category names no month or basis, follows the open Inventory month and never refreshes. Its arithmetic (credited bills dropped, bill discount ignored, days by the viewer's clock, `useSalesPivotData.js:67-111`) also belongs here: REPORTS and IMS-HANDOFF each handed it to the other | 4 | — | no |
| REPORTS-10 | Covers' RevPASH divides by inactive tables' seats | 4 | — | no |
| REPORTS-11 | Between midnight and 6 AM the dashboards drop tickets the KDS still shows late | 4 | — | no |
| REPORTS-12 | The Customization Report judges choices against today's menu, not as billed | 4 | — | no |
| RESERVATIONS-6 | "Clear every occupied table" with a booking-seated table deletes lines, then fails | 4 | — | no |
| RESERVATIONS-7 | A booking cancelled by mistake can't be restored before its day, though the dialog says it can | 4 | Q23 | no |
| RESERVATIONS-8 | At midnight a late booking still in play vanishes from the floor and the default views | 4 | — | no |
| RESERVATIONS-9 | An unanswered online request never expires, and that phone stays blocked | 4 | — | yes |
| RESERVATIONS-10 | Seating from Reservations onto a table another device just opened puts the host on that bill | 4 | — | no |
| RESERVATIONS-11 | A booking whose table is deleted or made inactive is flagged nowhere | 4 | — | no |
| SHIFTS-5 | The Z-report's Voided Value includes VAT; Exceptions excludes it | 4 | — | no |
| SHIFTS-6 | A void is stamped with the till's cached shift, which may be closed | 4 | — | no |
| SHIFTS-8 | Shift History shows no dates | 4 | — | no |
| SHIFTS-9 | Shift open/close and cash entries have no time limit, and a lost Open reply reads "not opened" | 4 | — | no |
| SHIFTS-10 | Current Shift's totals never refresh, and Close does nothing once another device closed the shift | 4 | — | no |
| SHIFTS-11 | A failed first read leaves the Shifts page on "Loading…" for good | 4 | — | no |

### Gaps (3 open: 1 P2, 2 P3; GAP-RELEASE-1 shipped in slice 1b, GAP-OUTLETS-1 in 1g, GAP-OPERATOR-1 in 1l, GAP-OUTLETS-2 in 2h)

| ID | Finding | Sev | Stage | Decision | Mig |
| --- | --- | --- | --- | --- | --- |
| GAP-OUTLETS-3 | The Group Console counts takeaway and delivery bills as guests (REPORTS-3's rule), cuts the month at 05:45 Nepal time, and its Revenue tip over-promises | P2 | 3 | — | yes |
| GAP-OPERATOR-2 | Inside a client's POS the operator gets every module on, whatever the client bought, so the operator's till behaves unlike the restaurant's | P3 | 4 | — | no |
| GAP-OPERATOR-3 | What the operator does in a client's POS shows to the Owner as nobody: bills, voids, tickets, a shift and a credit note carry "—" | P3 | 4 | — | yes |

## S809.1 Owner decisions (Q1–Q27)

Each has a recommended answer. Answering "all as recommended" is enough to start; name any you want
different.

**Answered 2026-10-08 (S809): every stage-1 question, all as recommended.** Q1 (b), Q2 (a), Q3 (a),
Q4 (a), Q5 (a), Q6 (a), Q7 (a), Q24 (a), Q26 (a), Q27 (c).

**Answered 2026-10-09 (S809): every stage-2 question, all as recommended** (asked in plain words).
Q8 (a), Q9 (a), Q10 (a), Q25 (a). Q11–Q23 are still open.

**Stage 1**

- **Q1 (DATABASE-1) Who is named on a kitchen ticket?** Offline, a ticket is uploaded later by whoever is
  signed in then. (a) Always the login that uploads it: cannot be forged, but an offline ticket is credited
  to the uploader. **(b) Recommended:** keep the waiter the till recorded when that is a POS login of the
  same outlet, otherwise the uploader. This still closes the rewrite and delete holes.
- **Q2 (GUEST-4, RESERVATIONS-3) What should a locked or deactivated outlet's QR menu and booking page
  show?** **(a) Recommended:** nothing to order or book, the same page as POS switched off. (b) The menu,
  view-only, with "ordering is off right now". (c) Leave it.
- **Q3 (RESERVATIONS-4) The limit on online booking requests for the whole outlet.** **(a)
  Recommended:** keep it, but count only requests that became bookings. (b) Drop it and rely on the
  per-phone and per-connection limits. (c) Leave it.
- **Q4 (ACCESS-2) Who may stay signed in on the Kitchen Display?** **(a) Recommended:** only Kitchen/Bar
  team logins; a Front of House login there locks after 3 minutes like a till. (b) Any login, but Exit goes
  back to the PIN screen after 3 idle minutes. (c) Leave it.
- **Q5 (ACCESS-3) May a POS manager reset the PIN of someone with more powers than their own?** **(a)
  Recommended:** no, the Owner does those (the S754 rule applied to resets). (b) Yes, but every reset is
  recorded and shown to the Owner. (c) Leave it.
- **Q6 (DOCS-1) Should a PIN reset end a lockout?** **(a) Recommended:** yes; the new PIN gets five fresh
  tries. (b) No, and the till says "wait until {time}; a reset does not shorten it".
- **Q7 (ACCESS-8) Switch the old shared till key off for every client now?** No till has used it since
  2026-09-14. **(a) Recommended:** yes, all at once. (b) One client at a time by hand. (c) Leave it.

**Stage 2**

- **Q8 (CHECKOUT-1) How does a supervisor without Void clear a table rung by mistake?** **(a)
  Recommended:** an emptied bill is refused and the till says "ask someone with Void"; revisit with the
  table-move build. (b) Allow saving an empty order and let Clear Occupied remove it. (c) Let an emptied
  order close as a void for any supervisor.
- **Q9 (CHECKOUT-5) Buyer details on a Tax Invoice above NPR 10,000.** **(a) Recommended:** require name
  and address, as the till's tip already says. (b) Require them only when the guest gives a PAN. (c) Only
  warn. Worth one question to the accountant, since the research note is from secondary sources.
- **Q10 (CREDIT-NOTES-1) When a note cancels a bill because it is re-billed or was a duplicate, should
  the food go back on the shelf in Inventory?** **(a) Recommended:** the note asks "Was this food served to
  this customer, or is it billed again / a duplicate?", and the second answer puts the stock back. (b) A
  "Re-issue to the right customer" action instead, still needing (a) for duplicates. (c) Keep it, and tell
  owners Variance reads low by that food.

**Stage 3**

- **Q11 (GUEST-1) Where does a guest's order-wide note go?** **(a) Recommended:** onto each dish of that
  order. No migration, and it reaches the ticket and the KDS today; a long note repeats per dish. (b) A
  ticket-level note printed once at the top (a new field on the ticket log). (c) The guest page takes a
  note per dish instead.
- **Q12 (CREDIT-NOTES-3, IMS-HANDOFF-1) Who posts waiting till bills and credit notes into Inventory?**
  **(a) Recommended:** the Owner and the operator, now. Hide the button from IMS-role logins and reword the
  instructions. Add a server-side post later. (b) IMS supervisors and managers too, through a new database
  function (migration). (c) POS managers too, from the POS side.
- **Q13 (CUSTOMERS-PARKING-5) Who may add or correct a points balance by hand?** **(a) Recommended:** the
  Owner only; a point is money at the till. (b) The Owner and POS managers.
- **Q14 (FLOOR-KITCHEN-1) Should a locked till announce a waiting guest order?** **(1) Recommended:** yes;
  the PIN screen checks through the tablet's own key, since it is every PIN till's resting state. (2) No;
  the Kitchen Display raises guest orders and the cook calls the floor. (3) No change; Help says one
  email-login device must stay off the Orders page.
- **Q15 (FLOOR-KITCHEN-3) What does "every category to Kitchen" mean?** **(1) Recommended:** exactly that;
  Beverage stops going to the bar. (2) Keep Beverage to the bar, and POS Setup refuses an all-Kitchen save
  with a sentence saying why.
- **Q16 (ORDER-FLOW-6) Wi-Fi up but internet down: should a failed send queue and print anyway?**
  **Recommended: yes**, the Stock Count answer from S731. The kitchen gets its ticket, and the replay is
  already safe against conflicts. The alternative is to keep refusing until the browser itself says offline.
- **Q17 (ACCESS-5) What does removing a leaver's POS login do?** **(a) Recommended:** block the login and
  keep the name on past bills; Delete only a login with no bills. (b) Keep Delete, but the confirm says the
  name leaves past bills. (c) Copy the staff name onto bills and shifts (migration).
- **Q18 (ACCESS-7) Should locking one till sign the waiter out of the others?** **(a) Recommended:** no;
  a lock ends only that till's session, and revoking a tablet ends the sessions opened on it. (b) Yes, but
  the other till notices at once and keeps its cart. (c) Leave it.

**Stage 4**

- **Q19 (CUSTOMERS-PARKING-9) When does a Credit (tab) bill earn points?** (a) At the close, as now, with
  the guide corrected. **(b) Recommended:** when it is settled, since points follow money received, as the
  guide already promises. (c) At the close, but not spendable until settled.
- **Q20 (CUSTOMIZATION-5) Should a "No onion" use up a free pick or a place under the maximum?** **(a)
  Recommended:** no; removals never count. (b) Keep the rule and document it. (c) Refuse removals in a group
  with free picks.
- **Q21 (GUEST-7) A table QR link that can be revoked?** **(a) Recommended:** a per-table token with a
  "New QR code" button; only the reprinted table changes. (b) QR ordering only while the table has an open
  bill. (c) Accept it; staff Accept is the check.
- **Q22 (REPORTS-5) Should the dashboards follow the Sales Report's credit-note rule?** **(a)
  Recommended:** yes; the bill stays on its day and the note is a minus on its issue day. (b) Keep dropping
  credited bills, but correct the comments and say so on the tile.
- **Q23 (RESERVATIONS-7) May a mistaken cancel be undone before the booking's day?** **(a) Recommended:**
  yes, until the end of the booking's day, as the dialog already promises. (b) Keep the own-day rule and
  reword the dialog.

**From the gap pass**

- **Q24 (GAP-OUTLETS-1, stage 1) Should a till follow its login to another outlet at all?** **(a)
  Recommended:** never. It stops with a notice until the login is switched back, because the tablet knows
  which counter it stands at and the login does not. Help and the group guide add: a till that must keep
  billing while the Owner looks at another outlet needs a login of its own. (b) It follows, but parks the
  cart and names the till in the notice. (c) Leave it, and tell group Owners to run tills on PIN logins only.
- **Q25 (GAP-OUTLETS-2, stage 2) After an HQ push, whose call is "On POS" for a dish?** **(a)
  Recommended:** the branch's own. (b) HQ's, but never on a dish with no price. (c) A separate "menu
  availability" in the push, off by default.
- **Q26 (GAP-OPERATOR-1, stage 1) May Crest support issue a credit note or record drawer cash that the
  database refuses to the Owner?** **(a) Recommended:** no. Outside a restore, the operator meets the same
  integrity checks; the operator stays exempt from rank rules (S754). These checks protect the tax record,
  not a rank boundary. (b) Yes, but the screen warns first.
- **Q27 (GAP-RELEASE-1, stage 1) How eagerly should a till take a new release?** (a) It reloads itself at
  the PIN screen and on an idle floor. (b) A "New version — reload" banner, and staff choose. **(c)
  Recommended:** (a), plus a database check that tells a too-old till to reload before it writes under
  changed rules (migration), for releases that change what the till sends.

## S809.2 Fix stages

Split each stage into slices of one migration each before starting, as S798 did, one short chat per slice.
Rows that touch the same table or function ship together:

- CHECKOUT-8 with CREDIT-NOTES-6;
- CHECKOUT-4 with CREDIT-NOTES-4;
- GUEST-4 with RESERVATIONS-3;
- GUEST-3 with ORDER-FLOW-11;
- SHIFTS-5 with REPORTS-7.

- **Stage 1: close the doors.** RESERVATIONS-1 first, then CHECKOUT-2, DATABASE-1, ORDER-FLOW-2 and
  ACCESS-1. After those, the remaining stage-1 rows above.
- **Stage 2: bills, tax and stock right.** CHECKOUT-1 and ORDER-FLOW-1 first.
- **Stage 3: the floor, kitchen, guests, bookings, loyalty and report figures.** GUEST-1 first, with
  ORDER-FLOW-9 (both are allergy notes not reaching the kitchen).
- **Stage 4: P3 copy, docs and polish.** Pull a P3 forward into an earlier slice when that slice already
  edits its file.

**Stage 1 slices (owner approved 2026-10-08).** GAP-RELEASE-1 moved up to slice 2. Every later slice
changes what the database accepts, and a tablet still running the old code would start having its saves
refused mid-service. RESERVATIONS-1 changes nothing the till sends, so it still goes first. After slice 2
ships, reload every till by hand once. Each slice re-reads the live body of any function an earlier slice
changed.

| # | IDs | Migration | Edge Function | Decisions |
| --- | --- | --- | --- | --- |
| 1a ✅ | RESERVATIONS-1, RESERVATIONS-12 (shipped 2026-10-08, `20261008120000` live) | hold guard, composite FKs, `order_id` same-client trigger, `created_by` stamp | — | — |
| 1b ✅ | GAP-RELEASE-1 (shipped 2026-10-09, `20261009100000` live) | `pos_min_till_build()` floor (NULL) + `pos_till_build_gate` statement triggers; the till reloads itself | — | Q27 |
| 1c ✅ | CHECKOUT-2, CHECKOUT-8, CREDIT-NOTES-6 (shipped 2026-10-09, `20261009110000` live) | `guard_pos_order_close` A+B, `pos_orders` CHECK, `guard_pos_credit_note` | — | — |
| 1d ✅ | DATABASE-1, ORDER-FLOW-2 (shipped 2026-10-09, `20261009120000` live) | `pos_kot_log` / `pos_kot_removals` guards, `save_pos_order_items`, `guard_pos_item_price` | — | Q1 |
| 1e ✅ | ACCESS-1, ACCESS-2 (shipped 2026-10-09, app only) | none | — | Q4 |
| 1f ✅ | ACCESS-3, DOCS-1 (shipped 2026-10-09) | none | `admin-user-ops` | Q5, Q6 |
| 1g ✅ | ACCESS-4, GAP-OUTLETS-1 (shipped 2026-10-09, `20261009130000`; pos-staff-login left alone, owner 2026-10-09) | `set_active_outlet`, `set_outlet_access` | — | Q24 |
| 1h ✅ | GUEST-4, RESERVATIONS-3, RESERVATIONS-4 (shipped 2026-10-09, `20261009140000` live; five guest functions gated, not three) | access helper, 3 guest-menu and 3 booking functions | — | Q2, Q3 |
| 1i ✅ | DATABASE-4, DATABASE-5, CUSTOMERS-PARKING-7 (shipped 2026-10-09, `20261009150000` live) | `guard_pos_order_payments_closed`, `pos_customers_guard_loyalty`, ledger FK | — | — |
| 1j ✅ | ACCESS-8, ACCESS-9, CHECKOUT-16, DATABASE-9 (shipped 2026-10-09, `20261009160000` live) | retire the shared key, drop 2 dead RPCs, rank checks, comp quantity | — | Q7 |
| 1k ✅ | CHECKOUT-12, CUSTOMERS-PARKING-13 (shipped 2026-10-09, `20261009170000` live) | payment-confirmation guard, parking-slip trigger and unique number | — | — |
| 1l ✅ | SHIFTS-2, GAP-OPERATOR-1 (shipped 2026-10-09, `20261009180000` live) | `pos_shifts_guard` or `close_pos_shift`, `pos_cash_movements_guard`, `guard_pos_credit_note`, restore flag | — | Q26 |

ACCESS-8 needs a migration (it drops `get_pos_device_secret`), although the index above says no. If 1l is
too big for one chat, split it: SHIFTS-2 with the operator change for the two shift guards, then the
remaining guards.

**Stage 2 slices (owner approved 2026-10-09; Q8, Q9, Q10, Q25 all (a)).** 2a goes first: it fixes both P1s
in the browser with no migration. `guard_pos_order_close` changes in 2b, 2c and 2g, so those three ship in
that order and each starts from the live body the one before left. Two P3s and three S809.4 items are pulled
forward because their functions are rebuilt here anyway.

| # | IDs | Migration | Decisions |
| --- | --- | --- | --- |
| 2a ✅ | CHECKOUT-1 (till half), ORDER-FLOW-1 (= CHECKOUT-9), CHECKOUT-5 (shipped 2026-10-09, app only, crest-v417) | none: the till's settings read, the Bill Register view, `closeBlocker` | Q8, Q9 |
| 2b ✅ | CHECKOUT-1 (server half), CHECKOUT-3, CHECKOUT-4, CREDIT-NOTES-4, CHECKOUT-10, SHIFTS-1 (database half), SHIFTS-7 (P3); S809.4: `apply_pos_item_comps`' skipped partial row (shipped 2026-10-09, `20261009190000` live, crest-v419) | `guard_pos_order_close` (empty bill, open shift `FOR SHARE`, invoice year from the Nepal date), `guard_pos_credit_note` (year), `apply_pos_item_comps` (year, `comped` filter), `pos_cash_movements_guard` (`FOR SHARE`), `pos_shifts_guard` (`closed_at := now()`) | Q8 |
| 2c ✅ | CHECKOUT-6, REPORTS-1, CREDIT-NOTES-5 (P3) (shipped 2026-10-09, `20261009200000` live, crest-v420) | `pos_orders.vat_registered`, stamped at the close (after 2b) | — |
| 2d ✅ | CHECKOUT-7 (shipped 2026-10-09, app only, crest-v418) | none: the close read-back path | — |
| 2e ✅ | CREDIT-NOTES-1, CREDIT-NOTES-2, SHIFTS-3; S809.4: a note's `created_at` is the server's (shipped 2026-10-09, `20261009210000` live, crest-v420) | link trigger on `pos_credit_notes`; a restock `sales_entries` source and `ims_stock_movements_guard` | Q10 |
| 2f ✅ | IMS-HANDOFF-2, IMS-HANDOFF-3 (shipped 2026-10-09, `20261009220000` live, crest-v420; BLOOM's bill 40 was gone, so the repair marked 0) | `sales_entries` stamp trigger (and BLOOM bill 40's stamp); DEFINER depletion and comp-cost reads | — |
| 2g ✅ | CUSTOMERS-PARKING-1, -2, -3 (shipped 2026-10-09, `20261009230000` live, crest-v421; BLOOM's 188 partner points were already gone with the data clear) | `award_loyalty_points` / `redeem_loyalty_points`; `guard_pos_order_close` (a standing Loyalty leg, after 2c); point value > 0 | — |
| 2h ✅ | CUSTOMIZATION-1, CUSTOMIZATION-3, GAP-OUTLETS-2; S809.4: comped rows in `before_sent`/`stored_sent` (shipped 2026-10-09, `20261009240000` live, crest-v421) | `save_pos_order_items` (a must-choose dish with no choices, an unpriced new line), `push_master_data` (the branch keeps On POS and Active) | Q25 |

## S809.3 Outside POS, filed here

- **IMS count PIN:** a reset leaves the lockout in place, as DOCS-1 does for POS (re-checked by the 1f
  drafter, 2026-10-09: `reset_ims_pin` clears no lock). Same fix as 1f: `record_ims_pin_attempt(true)`
  after `updateUserById`, an audit row (`kind: 'ims_count'`), `ImsStaff.jsx` handling `lockout_cleared:
  false`; `Help.js` ("reset their PIN immediately") and `ImsCountLogin.jsx` are untrue until then. **HR
  Self-Service has no such gap here** (no reset action: Remove + Enable makes a new login); check
  hss-suite's own reset path on its side before filing anything in CROSS-REPO.
- **IMS gate passes have the parking slip's numbering hole** (found by the 1k drafter):
  `ims_gate_pass_void_guard` does not clear a browser-sent `pass_no`, there is no `UNIQUE (client_id,
  pass_no)` (live: 3 rows, 0 duplicates), and vehicle, notes and print count are editable.
- **Trial signup gives a working login before approval** (part of RESERVATIONS-1's reach): RLS honours a
  pending trial's JWT. This is the documented "UI gate, not a security boundary" (`subscription-access.md`).
  RESERVATIONS-1 does not need it changed, but any other cross-tenant read would be reachable the same way.

## S809.4 Found while fixing stage 1 (2026-10-09, not fixed)

- **Legacy shared-key code** (1j): every client's shared key is now off, so delete `pos-staff-login`'s
  legacy branch and PGRST202 fallback, PosLogin's `get_pos_staff` path, the Pos.js legacy notice and the
  Till Devices shared-key panel, then drop `get_pos_staff`, `verify_pos_legacy_device`,
  `retire_pos_legacy_device_key`, `pos_legacy_device_key_status` (after the deploys; `auth-and-pins.md`).
- `settings_guard_staff_roles`' HR, IMS, travel-claim and weather-city lines still test raw ranks, so a
  settlement-blocked login passes them for the hour its token lives (1j did the POS lines).
- ~~`apply_pos_item_comps` skips a `p_partial` row whose line is not found (`CONTINUE`) and still returns an
  NC number, so the till could print an empty comp slip (1j).~~ Fixed in 2b: the whole call is refused
  (`pos_comp_line_missing`).
- `pos_payment_confirmations.matched_order_id` is NO ACTION: once auto-confirm is live, Clear Occupied of a
  bill holding an unused matched confirmation is refused by that key. `pos-payment-webhook` drops the error
  of both its reads (1k).
- Grants hygiene (the S782 trap): `anon` MAINTAIN on `pos_parking_slips` / `pos_payment_confirmations`,
  and TRUNCATE/REFERENCES/TRIGGER on `pos_cash_movements` (1k, 1l).
- `pos_customers` has no audit trigger, so enrolment changes leave no record; `supabase-sql.md`'s
  `updated_at` table is wrong about it (the till's upsert writes it from the tablet clock) (1i).
- Credit Note Book reprint labels from the list loaded at page open, so two managers reprinting one note
  print the same copy number (the stored count is right since 1c) (1c).
- Kitchen stage times (`started_at`/`ready_at`/`served_at`) are still tablet-supplied, so prep times
  can be shaded (1d).
- Admin → Guest Menu Preview quotes "This menu isn't available right now"; the guest page says "This menu
  isn't available" (1h).
- ~~One-line pulls-forward, now that their functions were rebuilt: SHIFTS-7 (`NEW.closed_at := now()` in
  `pos_shifts_guard`) and SHIFTS-1's database half (`FOR SHARE` on the shift read in
  `pos_cash_movements_guard`) (1l).~~ Both shipped in 2b.
- Sign-out scope: the Owner's and admin's account-menu Sign out, and Crest Staff's (shared with
  hss-suite), are still `global`, so signing out on a shared device ends that login on every device
  (ACCESS-7's shape). An Owner left on a wall KDS never locks, and its Exit opens the till as the
  Owner; Help should steer wall screens onto a Kitchen login (1e).
- A Release reload restarts the idle clock, so a till locks at about 4 minutes once per release
  (ACCESS-6, stage 3) (1e).
- The Owner cannot see who reset a PIN: the new `staff_pin_vault` UPDATE row is in the admin-only
  Audit Log. The page labels its field "Pin Reset" (`FIELD_LABELS` in `AuditLog.js`). The till's
  lockout line now differs from `SelfServiceLogin.jsx`'s (HR, shared with hss-suite) (1f).
- `set_active_outlet` refuses an allowlisted non-Owner who asks for their HOME outlet by id ("no
  access"), because Outlet Access stores no home row, so the top-bar switcher's home entry fails for
  allowlisted staff (latent, 0 rows). The till's new buttons send NULL. Fix: `outletSwitchArg` inside
  `switchOutlet`, or home-by-id as the reset in SQL (1g).
- **Found while drafting stage 2 (2026-10-09, not fixed):**
  - The close write does not pin the lines it priced: `guard_pos_order_close` accepts a close whose
    `items_version` moved since `paid_amount` was worked out (a second press's save landing before a
    late first try). Fix: send `items_version` with the close and refuse a mismatch; first check what
    bumps it (`apply_pos_item_comps`?) so a normal close is never refused. Since 2d the till says so on
    the floor when the stored lines don't add up to the money (2d).
  - Unknown-close marks live in memory only: a PIN lock, leaving Orders or a reload forgets them (2d).
    ~~The lock still hands back a standing redemption.~~ Fixed in 2g: the lock skips it while a try at
    that bill is unsettled, and the close itself returns forgotten points.
  - A 5xx from the gateway on the close write is reported to the cashier as a refusal, though the
    database may still commit it (2d).
  - The Billing station shows no loyalty note, and has no way to Recent Bills, though many messages say
    "reprint it from Recent Bills" (2d).
  - A Split bill's payment legs are inserted in a request after the close, so 2b's shift lock does not
    cover them: a Close Shift between the two can freeze a report without that bill's cash leg. Fix:
    `pos_shifts_guard` refuses a close while a Split bill closed in the last 10 minutes on that shift has
    legs short of `paid_amount` ("press Close Shift again in a moment") (2b).
  - ~~A Credit Note inserted by a client session keeps a sent `created_at`, which backdates its printed
    date: set `NEW.created_at := now()` on the non-restore path, with slice 2e (2b).~~ Fixed in 2e.
  - ~~`save_pos_order_items` leaves comped rows out of `before_sent` and `stored_sent`, so after a cancelled
    close the folded, already-sent comped dish reads as not sent and could print on a KOT again (main
    session, 2b review).~~ Fixed in 2h: comped rows count in both.
  - Raise `pos_min_till_build()` to crest-v417 so a till older than 2a cannot charge an emptied cart, but
    only after checking that `x-crest-build` reaches `request.headers` through PostgREST in production
    (1b's open check); every till would be refused otherwise (2b).
  - On a server `no_open_shift` the till keeps its cached shift id until the next press (cosmetic, 2b).
  - `viewPosBill.js`' `get_client_profile_names` read drops its error (blank Cashier), and its reads have
    no time limit; `reprintItemCompSlip` drops both read errors and prints nothing silently (2a).
- **Found while drafting stage 2, wave 2 (2c, 2e, 2f; 2026-10-09, not fixed):**
  - The Owner Report's POS section (`computeMonthlyReport.js`) still works out past bills with the VAT
    flag read when the report is generated, so a month generated after a VAT change loses its VAT. Fix:
    add `vat_registered` to its `pos_orders` select and pass `billVatRegistered(o, vatReg)` (2c).
  - CREDIT-NOTES-5's server half: `guard_pos_credit_note` accepts any sent `original_invoice_no`,
    `original_invoice_label` and `original_invoice_date_bs`. Set them from the bill (`v_order.invoice_no`,
    the TI/PB label from `v_order.vat_registered`); no note column needed (2c).
  - `PosCustomers.jsx`' settings comment says `is_vat_registered` moves the delivery commission base by
    about 13 points. It does not: taxable + non-taxable is ex-VAT under either flag (2c).
  - Do not switch an outlet's VAT status before every till has reloaded to crest-v420: an older till
    prints under its old setting while the bill is stamped with the new one (2c).
  - `openBilling` and `openCompTab` never catch a failed cost read, so the comp cost silently shows
    NPR 0 (S695 says callers must) (2f).
  - `imsPostWarning` is a local counter that never goes down: a timed-out post that later lands (now
    marked by the database) still shows "1 not posted" until the page reloads (2f).
  - `writeSalesEntries` links rows by the screen's `orderId`, not `updated.id`; equal on every path that
    posts today, but fragile (2f).
  - Same cause as IMS-HANDOFF-3, not switched: Sales Report's and Sales Exceptions' comp food cost (one
    line each, `posFoodCosts`), `viewPosBill.js` (also opened by IMS logins with no POS rank, which
    `pos_recipe_book` refuses, so it needs a fallback) and the Customization report (`loadDeltaExplosion`)
    (2f).
  - A note's takeback has the race bills had (a late post after a Periods post); no refusal for notes
    yet. `creditNotePosting.js`' comment at its mark write and `posted: true` when only the mark failed
    are moot now (2f).
  - "Manual Sales by Category" (`useSalesPivotData.js`) excludes only `pos`/`pos_comp`, so it counts
    `pos_credit` and `pos_credit_restock` rows as hand-entered sales (2e, predates it).
  - `buildUsageMap` clamps a recipe's net sold at 0 for the base recipe but not for choice extras
    (`ingredient_deltas`); matters only for a negative month (2e).
  - A "not served" note on a bill from an earlier Inventory month puts the food back in the note's
    month; the screen warns that the earlier month's count already settled it, but does not block (2e).
  - Drafting briefs should give each parallel drafter its own scratchpad subfolder and local Postgres
    port: two drafters overwrote each other's replica scripts (2c, 2e).
- A held non-till laptop that is RELOADED with queued POS orders comes back in the login's new outlet,
  and Orders would replay the queue there (ORDER-FLOW-15, queue entries carrying their client) (1g).
  ~~The cart save on an outlet move also tries to cancel a standing points redemption, which fails once
  the login has moved.~~ Fixed in 2g: an outlet move leaves the points for that bill's own close.
- **Found while drafting stage 2, wave 3 (2g, 2h; 2026-10-09, not fixed):**
  - A guest whose points stand on an open bill from an earlier try sees a lower balance on another till
    and cannot use them there until that bill closes; a line like "N points held on bill 12" would help
    (2g).
  - Customers → Loyalty still offers a delivery partner's customer row for enrolment; enrolling it now
    does nothing (cosmetic, 2g).
  - Menu Pricing (both branches) lets a manager tick On POS on a dish with no price, and IMS recipes
    default to `pos_enabled = true`; such a dish now just stays off the till, so Menu Pricing should say
    "not on the till until it has a price" (2h).
  - `push_master_data`'s preview for a dish matched by name on the first push never says its price is
    overwritten when Selling prices is ticked; its plan table has no `DROP … IF EXISTS`, so two calls in
    one transaction fail with 42P07 (tests only) (2h).
  - The till's menu read requires `is_active`/`pos_enabled = true` while `save_pos_order_items` accepts
    NULL (0 NULL rows, latent), and the till's `option_count` message names no dish though the server
    sends one (CUSTOMIZATION-2 would help) (2h).

---

## A. Next builds — ranked by the owner (S754, 2026-09-14)

In this order. Service charge was offered and **not** chosen.

- [ ] 🔴 **Table move / merge / split.** Moving a running order to another table, joining two
  tables onto one bill, and splitting one table's order across bills. S754 added a unique index
  allowing one open order per table (`pos_orders_one_open_per_table`), so a merge has to close or
  re-point the second order in the same transaction rather than leave two open.
- [ ] 🟡 **Crest Customization — release 1 SHIPPED (S758, critique pass S759); open follow-ups
  only.** The shipped entry, with its migrations and the browser smoke test, is in
  [POS_DECISIONS.md](POS_DECISIONS.md) → Shipped. Still open:
  - The Complimentary slip costs a comped dish at its recipe cost only; a customized dish's choice
    stock lines are not added to that figure yet.
  - Stock Movements' Sub-Recipes tab does not walk a choice's sub-recipe stock line (release 1);
    the tab says so.
  - `computeInventoryVariance` / `computeInventoryShrinkageTrend` (owner report) still sum sales
    without the POS-supersedes-manual rule the live pages apply (pre-existing), so a dish entered
    both ways counts its choices twice there, as it already did its recipe.
  - Not yet pressed on a real till after S759: the cart's choices line and the choice window's
    scroll-to-short-group on a refused Add. (The guest sheet's sticky header WAS pressed in S767 —
    it clipped the content under it, and was fixed.)
  - Release 2: combos / build-your-own bundles.
  - **S760 build-your-own: applied live 2026-09-15.** The GUEST steps were pressed in a browser in
    S767 on BHATTI CHOILA's VEG MOMO (size step, Review, Change back to Review). Still to do: the
    template on CASA ACAI CAFE, a Large bowl on the till, scaled stock at bill close, and the cost
    range on Recipe Costing and Menu Pricing (IMS branch).
  - `push_master_data` does not carry `recipes.is_build_your_own`, nor option groups at all, so a
    branch receives a build-your-own dish as an ordinary one.
  - The Complimentary slip and Menu Pricing's POS-only branch show no build-your-own cost range (the
    POS-only branch has no costs at all).
  - Deleting a **sub-recipe** that an option's stock line uses is refused by the plain FK
    `pos_option_ingredients.sub_recipe_id` with a generic message — `deleteRecipe`'s pre-check only
    looks at `recipe_ingredients.sub_recipe_id`. Safe direction (nothing is lost); needs the wording.
- [ ] 🔴 **Kitchen and bar printers.** Routing KOT/BOT to a network printer per station instead of
  the till's own print dialog. `pos_bot_categories` already decides the station.

## A2. Known gaps left by S754

The S754 migrations (`20260916100000`, `20260916110000`, `20260916120000`) and Edge Functions
(`pos-staff-login`, `admin-user-ops`) were written and tested but **not applied or deployed live**
when these were filed. Every item below assumes they are.

- [x] **Two bookings saved in the same second can hold the same table** — closed S755:
  `guard_pos_reservation_table_hold` refuses an overlapping live hold under a per-table advisory lock
  (`table_hold_overlap`), on a table link, a window move and a revival.
- [x] **Clear Occupied left no pulled-item record** — closed S755: deleting a fired open line outside
  `save_pos_order_items` writes `pos_kot_removals` ("Table cleared"), and the row now outlives its
  order (`order_id` SET NULL, `order_no`/`table_name` snapshotted).
- [x] **Credit-note amounts were trusted as sent** — closed S755: `guard_pos_credit_note` checks gross
  against the charged lines, discount and net against the bill, and the VAT split, with no second
  copy of the VAT formula (`credit_note_amounts`).
- [ ] 🟡 **The public booking rate limit trusts the first hop of `x-forwarded-for`**
  (`submit_reservation_request`), which a caller can set. S754 deliberately left it alone, because
  nobody has confirmed which hop Supabase's proxy chain appends as trusted. Confirm that first, then
  key the limit on that hop.
- [ ] 🔵 **Remove the legacy shared device key once every client has switched it off.** Code to
  remove: the `verify_pos_legacy_device` branch in `pos-staff-login`, its `PGRST202` fallback, and
  `get_pos_staff`'s secret comparison. Till Devices shows when each client's shared key was last used.
- [x] **Archiving a client did not revoke its tablet keys** — closed S755: `deleteClientDataFor` in
  `admin-user-ops` (Archive, Clear Client Data, Delete Client, the trial purge) revokes every live
  `pos_devices` key and rotates/retires the shared key first; a restored client re-activates tablets.
- [x] **A credit note's reason line printed "(no money returned)"** — closed S755: the answer is
  `pos_credit_notes.refund_method`, shown in the Credit Note Book, never printed. Notes issued before
  S755 keep their reason text as printed.
- [ ] 🟡 **Deleting an open order that still has lines is refused as "this bill is closed and
  printed"** (found S755, measured rolled back on live). `guard_pos_order_items_closed_del` is an
  AFTER STATEMENT trigger, so inside the `pos_orders` cascade it fires as `authenticated` and its
  LEFT JOIN reads the just-deleted parent as not open. Fail-closed and reached by no app path (Clear
  Occupied deletes the lines first), but the message is wrong and a direct REST delete of an open
  order cannot succeed. Fix: tell a deleted parent from a closed one inside a SECURITY DEFINER lookup
  (the S749 pattern). `record_pos_kot_removals_on_order_delete` already records that path once it can.

## B. Reports — compliance-adjacent

- [ ] 🟡 `sales_entries`/`purchase_entries` hard-delete on edit (accepted risk — only matters near the NRs 5 crore certification tier). **`pos_orders` itself cannot be deleted or edited once billed, enforced by the database since S754** (`guard_pos_order_delete` plus the closed-bill lock in `guard_pos_order_close`, migration `20260916100000`, applied live 2026-09-14). Before that it was only true because no screen offered it: a till login could delete a billed order over REST. **Narrowed by S698 on the purchases side, not closed:** the replacement is now one transaction inside `save_purchase_bill` rather than two requests, so a bill can no longer end up holding both versions, and a bill with `payable_payments` against it is refused outright by a `BEFORE DELETE` trigger. The lines themselves are still replaced rather than superseded, so an audit trail beyond `audit_logs` would still need a version column. `sales_entries` is unchanged.
- [ ] ⚪ Tier-1 software-certification legal question (needs an accountant's answer, not code)
- [ ] 🟡 `pos_order_items.recipe_id` has **no foreign key at all** (found S711 while enumerating what
  references `recipes`). Every other referencing column is constrained one way or another —
  `sales_entries` refuses the delete, three tables cascade, `pos_kot_removals` sets null — and this
  one lets a recipe be deleted out from under its bill lines, which then point at an id that no
  longer exists. The bill itself still prints, because a line carries its own `name` and `price`
  snapshot; what breaks is anything joining back to `recipes` for a COST, so a comp on the POS
  exception report or a margin on the sales report silently values those lines at zero.
  **The page-level guard added in S711 covers the delete path in the app** (Recipe Costing counts
  POS lines before allowing a delete), which is why this is 🟡 and not 🔴 — but per S707's own
  lesson, a guard that lives only in the page is a guard on the page: the REST API still accepts
  the delete. The fix is a migration adding the FK, which has to decide between `ON DELETE SET NULL`
  (matching `pos_kot_removals`, keeps the bill line and loses the link) and a plain FK (refuses,
  matching `sales_entries` — probably right, since the two tables are the same fact recorded twice).
  Check for pre-existing orphans before adding either, or the migration fails on live data.

## B3. Quality passes on POS itself (added S652–S654, 2026-08-30)

- [ ] 🟡 **A failed offline sync tells the cashier nothing it can act on.**
  `flushPosOrderQueue` catches per order, leaves the order queued for the next flush, and reports
  the reason with `console.error` — a log, not a breadcrumb. Better placed than Stock Count was
  before S731 (`pendingOrderIds` and the conflict list are real UI, and the shape here is a retry
  rather than a silent drop), which is why this is 🟡: the order is not lost. But a sync that keeps
  failing for a reason someone could act on — a closed period, a refused RLS write, a table another
  device has since billed — says the same "still pending" as one that is merely waiting for signal,
  for ever. **Stock Count is the worked precedent, S731/S732**: collect the failures rather than
  dropping them, convert with `asActionError` at the call site, and surface them where the person
  is looking, keeping `console.error` as the floor for anything they cannot act on. Two things
  from that fix apply here and one does not — POS orders already carry a `client_id` through
  `scopedUpsert`, so the shared-device replay problem does not arise, but `navigator.onLine` is
  just as unreliable on the floor as it is in the storeroom, and `save_pos_order_items` is an
  atomic RPC, so a network failure around it is as safe to re-queue as Stock Count's upserts.
  Closes the POS half of `DOCS-REMEDIATION.md` T6 item 3.
- [ ] 🟢 **The Crest Suite tab's UNENTITLED branch was never seen (S763).** `suiteEntitled` is
  `isAdmin || suitePlan === 'pro'`, so an admin session is entitled by definition and cannot reach
  the other path. Verified on a Suite client: the tab renders, its panel carries the five reachable
  items, every Suite path selects it, and the Crest Suite group is gone from the module panels.
  **Unverified:** that a client WITHOUT Suite still sees the PRO-badged group in each module panel
  and no top-row tab, in both the bar and the phone drawer. One sign-in as a non-Suite client's
  Owner answers it — the code path is `suiteUpsellInPanels`.

- [ ] 🟢 **Two guards on the Billing station (S762) were never clicked.** The list, both Bill
  paths (a table and a takeaway), the payment window opening on the right order and ← returning to
  the list were all verified live on BHATTI CHOILA. Two were not, for want of a second actor:
  (1) a Staff-rank PIN typing `/pos/billing` should land back on `/pos/orders` — the component
  carries `if (billingStation && !hasPosAccess('supervisor'))`, read but not exercised; (2) the
  `existingOnly` refusal, where a bill listed here was settled on another till between the load and
  the tap, should say so and refresh rather than open the covers numpad. Both are single clicks
  once a staff PIN and a second device are to hand.

- [ ] 🟢 **Four S776 behaviours were verified in code and tests but never pressed live** (S776,
  2026-09-17), each for want of a real till or live service on the dummy client:
  (1) **the idle lock on a real PIN session** — keep and restore were exercised by firing the lock
  event by hand as the Owner, and the PIN screen's note by a render test, because the browser was not
  an activated till; one activated tablet and a staff PIN left idle for 3 minutes answers it;
  (2) **the KDS estimate presets starting a ticket in one tap** — no New ticket was on the board;
  (3) **the unified variance display** (✓/▲/△) on a closed shift;
  (4) **the Billing station's "Find a table…"**, which needs two or more open bills.
- [ ] 🟡 **`admin-user-ops` still defaults an unnamed discount limit to NULL (= unlimited) for admin
  and Owner callers.** The S776 owner decision (a new POS login starts at 0%) is enforced by POS
  Staff sending `pos_discount_limit: 0`; a create from any other caller still lands unlimited. Making
  the Edge Function default 0 closes it, and needs a deploy.

## B4. Timezone follow-ups left by S670

S670 pinned every clock-time *render* to `Asia/Kathmandu` (`src/shared/nepalTime.js`). Two things in
the same family were deliberately not taken, because each changes a figure rather than a label:

Both items that stood here — the Sales Report's runtime-local range bounds and `closed_at` written
by the till — were closed by S754 and moved to `POS_DECISIONS.md`.

- [ ] 🟡 **Covers Report's Avg Turn Time silently shrinks its sample.** `if (mins < 0) continue`
  drops skewed pairs with nothing on screen saying how many, and drops nothing for an absurdly large
  positive (a bill left open for days). A footnote naming the excluded count would make it honest.

## C. Reservations — later phases (Phase 1 shipped S677, see POS_DECISIONS.md)

- [ ] 🔵 **Paid SMS confirmations / reminders** (Sparrow or Aakash, ~NPR 1.5 per SMS). Opt-in per
  client; the client must first register a sender ID with the telcos under NTA rules (business
  documents, generic IDs prohibited). Build as an Edge Function `pos-sms` holding the token in
  `client_secrets` (privilege invariant 4). Not before a client with a registered sender ID asks.
- [ ] 🔵 **Deposits / advances for party bookings.** Two things settle the shape before it is built:
  it must be a TENDER, never a discount (`payment_method` CHECKs on two tables plus the two display
  lists — the S618 loyalty rule), and Nepal VAT Act s.16 arguably makes an advance taxable when
  RECEIVED, which needs an accountant's answer and its own receipt document.
- [ ] 🔵 **Walk-in waitlist** (quote a wait, notify when ready). Shares `pos_reservations`
  (`source='walk_in'`, no fixed time); needs a notify channel, which is the SMS item above.
- [ ] ⚪ **Phone verification on the public booking page** — impossible without an SMS rail; today
  the staff WhatsApp/call IS the verification. Revisit with the SMS item.

## D. Known roadmap items

- [ ] 🟡 QR payment auto-confirmation — receiver scaffold + admin UI shipped S271/S272, 2026-07-06 (`pos_payment_webhook` Edge Function, `settings.pos_webhook_secret` config in Manage Clients → QR tab). Still needs real FonePay/eSewa merchant onboarding + their actual signature scheme before anything goes live — low priority, blocked on merchant credentials, not engineering.
- [ ] 🔴 Barcode support (structural, no current need identified)

## Not on this list (deliberately out of scope)

Full double-entry accounting / Chart of Accounts / Debtors-Creditors, multi-warehouse, batch/lot tracking, Production Entry transactions — confirmed general-ERP scope creep, not aligned with Crest's F&B cost-intelligence positioning.

## Two of these five are not engineering

⚪ Tier-1 software-certification needs an accountant's answer; 🟡 QR payment auto-confirmation needs
FonePay/eSewa merchant onboarding. Neither can be closed by a coding session, which is why both have
sat here for months being scrolled past. They belong on a business to-do list — they are kept here
only so the POS picture stays complete.

---

Shipped history and closed decisions: **[POS_DECISIONS.md](POS_DECISIONS.md)**
