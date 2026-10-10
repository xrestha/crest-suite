# pos-billing.md: archived sections

Moved word for word out of .claude/rules/pos-billing.md in the S770 context pass (2026-09-17). This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file, usually with a pointer here. Line numbers refer to the rules file before the move.

---

_Original lines 541–637:_

## Still open from the phase 6 critique

Recorded so they aren't rediscovered from scratch:

- **The close-time guards (discount cap, void, item comp) are closed**, applied and smoke-tested
  (S577–S579). **S754 found what they left open: the closed bill itself, and every other POS table
  a rank gated only on screen** (both sections above). Its migrations were applied live on
  2026-09-14. S755 (`20260917100000`, live 2026-09-15) closed its known gaps: a
  same-second double table hold, Clear Occupied skipping the pulled-item record, credit-note amounts
  trusted as sent, archived outlets keeping their tablet keys, and the refund method printed on the
  note. What remains open is in `POS_TODO.md` A2. The
  payment-QR work stays blocked on FonePay/eSewa merchant onboarding, which is a business
  relationship rather than engineering.
- ~~**The mechanical sweep.**~~ **Closed across S576–S578**, with a fourth pass in S603. Labels: 0
  bare `<label>` vs 54 `htmlFor`, every `<select>` named. Colour: 117 base-signal-token `color:` sites converted, 0
  remain, 128 contrast-variant references now. Modals: all 9 hand-rolled overlays are on the
  shared `Modal`. Three shapes recur here and are worth copying rather than rediscovering — a
  caption over a button group or a read-only figure must be a `<span>` plus
  `role="group"`/`aria-labelledby` (a `<label>` naming no labelable element announces a name the
  browser never binds); a label for a conditionally-rendered control still pairs by `id`, since
  `SearchableSelect` and `BsCalendarPicker` both forward one; and a dialog opened from the order
  screen or the KDS needs `Modal`'s `zIndex` prop, because those are `position: fixed` layers at
  1000 and therefore their own stacking contexts — that single fact is why POS grew nine
  hand-rolled overlays instead of using the component.

  **S604 was the guest menu's own critique (23/40).** Three of its findings are worth carrying:
  the public menu applied `vat_rate` unconditionally while the till gates it on
  `settings.is_vat_registered`, so a non-registered outlet advertised every dish ~13% above what it
  billed — `get_guest_menu` now returns the flag (migration `20260823100000`) and `priceIncVat`
  takes it as a REQUIRED argument, so a call site that forgets it fails toward no-VAT rather than
  toward over-charging. The 5s status poll dropped `error`, so a failed read rendered identically
  to "no open order" — the S594 rule on the guest surface, where the cost is a diner watching a
  tracker that has silently stopped; it now keeps the last known stage and says so. And a raw
  `err.message` from `submit_guest_order` was rendered to an anonymous member of the public.

  **S746 re-analysed it from Admin → Guest Menu, and found the public surface disagreeing with the
  floor.** Three rules, each decided with Aashish:
  - **An inactive table's QR shows the menu and takes no orders.** Both guest RPCs ignored
    `pos_tables.status` while `PosOrders.jsx` makes an inactive tile unclickable, so a guest order
    lit up a table nobody could open. `get_guest_menu` returns `guest_ordering_enabled = false` for
    it and `submit_guest_order` refuses it — the flag alone would be advisory. Status is nullable,
    so the test is `IS DISTINCT FROM 'inactive'`: a NULL-status table was never taken out of service.
  - **A dish with no selling price is not on the public menu** (`selling_price > 0` in both RPCs).
    It rendered NPR 0 and went into a request snapshot with a NULL `unit_price`.
  - **The admin preview frame cannot place an order.** `GuestMenu` detects it is framed
    (`window.self !== window.top`; `frame-ancestors 'self'` means only this app can frame it) and
    swaps Place Order for a disabled button and a note. A guest's phone never frames the page.
  **Any new guest-side refusal needs both halves** — the flag the page reads to hide a control, and
  the check inside `submit_guest_order` — and `pos_enabled` stays the first gate in both (S632).
  The admin page states every one of these above the frame, because a menu that is switched off,
  empty, or order-less looks identical to a broken one from inside it.

  **S767 was the guest menu's third critique (24/40), fixed in full — decisions taken with Aashish.**
  Migration `20260921100000` (applied live 2026-09-16). Rules to keep:
  - **The tracker follows THIS guest's order, never the table's.** `get_guest_order_progress(request)`
    reads the bill that took the request (`pos_guest_order_requests.order_id`, written by
    `PosOrders.jsx` performSave on accept, with a `PGRST204` retry without the column for a stale
    till), only tickets sent after the request was made that carry one of its dishes, and whether that
    bill is closed. It used to combine the request status with `get_guest_table_status` — the least
    advanced ticket on the table's CURRENT bill — so a second-round order nobody had accepted showed
    the first round's "Ready", and a paid bill fell back to "heading to the kitchen" and chimed. The
    page never moves a stage backwards (`laterStage`) and ends on "Your bill is closed" when
    `order_closed`. A cancelled ticket is excluded; the table read counted it as 'new' forever.
    `get_guest_table_status` stays for a guest who never ordered from this phone.
  - **A new accept path must write `order_id` too**, or its guest's tracker falls back to the
    table-based lookup (the earliest bill on the table still open when the request was created).
  - **The restaurant's name and logo are the Owner's**: `settings.guest_menu_name` /
    `guest_menu_logo_url`, set in POS Setup → Guest Menu (`GuestMenuSetup.jsx`), fenced by
    `settings_guard_staff_roles` (`guest_menu_brand_rank`). The logo uploads into `dish-photos` under
    `<client>/guest-menu-logo-<epoch>`; that bucket's policies already admit the Owner. Unset, the
    menu shows `clients.name` through `tidyName` (all-capitals → normal capitals). **The public
    booking page shows the same name and logo** — `get_booking_page` returns `menu_name` /
    `logo_url` since `20260921110000`. A new public page that names the restaurant reads them too,
    rather than `clients.name`.
  - **Allergen warnings reach every client's guests** (no longer gated on the Nutrition flag);
    nutrient figures still are. The filter sheet says the list is built from recorded ingredients and
    to ask staff about a serious allergy — a missing record must not read as "free of it".
  - **Menu sections follow `settings.recipe_categories`** (or `DEFAULT_RECIPE_CATS`), editable in
    Settings → Recipe Categories and in POS Setup → Guest Menu, which a POS-only client without Recipe
    Costing can reach.
  - **Both guest pages wear the default preset**, pinned in `ThemeContext` (`isPinnedGuestSurface`,
    `/pos/menu/` and `/pos/book/`) — see DESIGN.md → "The guest pages". A new public customer route
    joins that list.
  - **The submit is bounded** (`withTimeout`, 20 s) and a timeout reads as "can't tell if it was
    sent", the same as a dropped connection; the order sheet locks while sending.
  - **Back closes a sheet** (`useBackToClose` in `GuestMenu.jsx`: one history entry per open stack,
    popped for the topmost sheet only; off inside the admin preview frame).

  **S603's pass was the input classes.** POS carried 20 of the 62 text controls in the product that
  were wearing `className="form-select"` — a `<select>` class, so `cursor: pointer`, so a text box
  announcing itself as a menu — across `PosTableManagement`, `PosShifts`, `PosStaff`,
  `PosCustomers`, `CreditNotes`, `CoversReport` and the parking slip modal. All on `.form-input`
  now, with `.form-input--auto` where the control sizes to a toolbar rather than filling a field.
  The same pass gave the whole app the 16px `pointer: coarse` floor it had never had, which matters
  more on this module than any other: **the till is a tablet**, and every field on it was 13px, i.e.
  under the threshold at which iOS Safari zooms the viewport on focus and never zooms back.

---

_Original lines 1136–1136:_

**A lockout the client calls around an operation is not a lockout.** POS and HR Self-Service both had `check_*_pin_lock` before and `record_*_pin_attempt` after, in the browser, with nothing server-side consulting them — so skipping the two RPCs walked a 4-digit PIN unimpeded. Both now run **inside** `pos-staff-login` / `hr-selfservice-login`, on the same request that signs in. Corollary: the frontend must **not** also call `record_*_pin_attempt`, or every failure double-counts and locks a fat-fingered employee out in 3 attempts instead of 5. Same reasoning applies to any future server-side check — if the browser can skip the call, it is advisory.
---

## S809 stage 3 wave 4 move (2026-10-10)

Two sections that repeated rules this file states elsewhere (the S577/S579 close and comp guards, and the IMS handoff's "`sales_entries` and `stock_movements` can diverge"), moved word for word when wave 4's additions took the POS rules load past its +15% warning. Line numbers refer to the rules file before the move.

## POS write-guards copy

_Original lines 1096–1101:_

## The POS write-guards (S531 invariant 3, S576, S579)

Migrated from the root `CLAUDE.md` (S663). The invariant itself — *a lockout the client calls around an operation is not a lockout* — stays resident there; this is the full POS-side detail behind it.

The invariant itself (a PIN lockout the browser calls around the login is not a lockout: attempts are recorded inside `pos-staff-login` / `hr-selfservice-login`, and the frontend must not also call `record_*_pin_attempt`) is stated once, in `.claude/rules/supabase-sql.md`, invariant 3. **The POS close was the same shape and was fixed the same way in S576** — the discount cap (`pos_discount_limit`) and the void permission (`pos_allow_void`) were both React, over a plain same-client `FOR ALL` policy that hands every till session UPDATE on its own orders. It is now `guard_pos_order_close()`, a BEFORE UPDATE trigger rather than the `close_pos_order(...)` RPC the critique proposed: an RPC protects only the callers that choose to call it and leaves the open policy in place, while a trigger sees every write to the table. Note what it deliberately does *not* enforce — `paid_amount`, because re-deriving the bill total in SQL would be a second copy of the VAT-and-rounding arithmetic, and a drifted copy would reject real bills mid-service rather than merely misreport a number. **Item-level comp was the third and last of the family (S579)**: `guard_pos_item_comp()` fences the comp columns on `pos_order_items` while `apply_pos_item_comps` stays `SECURITY DEFINER` and so remains the only write path — and that RPC now checks Supervisor *rank* (it had only ever checked client) and derives `comped_by` from `auth.uid()` instead of a caller-supplied parameter. **Attribution the subject of the attribution can choose is not attribution**; `comped_by` is what the Sales Exception Report ranks staff by, so a caller able to pass any uuid could comp under a colleague's name.

## Two writes diverge

_Original lines 1170–1181:_

## Two writes in one function can diverge, so one is never evidence of the other (S573)

Moved verbatim from the root `CLAUDE.md` (S769 context-reduction pass). The root keeps only the one-line rule.

A pattern worth recognising beyond POS. `writeSalesEntries` writes revenue to `sales_entries` and
then depletion to `stock_movements` inside a try/catch that swallows failures — deliberately, so a
depletion problem never blocks a bill closing. The consequence is that **a bill can have revenue
and no movements**, and a later guard that inferred "has this already posted?" from
`stock_movements` was therefore *wrong* rather than merely incomplete: it re-posted two bills'
revenue on real data (S573). Whenever a best-effort second write follows a primary one, the second
one's absence proves nothing — give each table its own link back to the source row and ask the
table you actually mean.
