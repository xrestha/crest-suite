# STOCK — physical count (Stock.js), offline queue/replay, month lifecycle (close / carry-forward / closed-month lock)
Files reviewed (so far, 14): src/modules/ims/stockcount/Stock.js (all 2215 lines, by range), src/utils/offlineQueue.js,
src/pages/periods/closePeriod.js, src/pages/Periods.js (close/reopen/resync/backfill/rename paths, row actions),
src/pages/dashboard/ClientDashboard.jsx (End-month button + askPeriodClose/closeAndAdvancePeriod),
src/shared/errorText.js (rule order), src/shared/imsFormulas.js (computeUsed/COGS_FORMULA),
src/modules/ims/reports/periodCost.js, git diffs of S758/S761/S765 on Stock.js/StockMovements.js/subRecipeUsage.js,
migrations 20260918100000 (closed-period guard, monthly_periods guard), 20260910120000 (scope policies, recount guard),
baseline schema for opening_stock/closing_stock/wastages/staff_meals constraints.
Skipped / light: Stock.css (S765 visual only), StockMovements.js beyond the S758/S765 diffs (S721 re-analysed it),
StockCountSettings.jsx (manager config, not counting). Also read: src/context/SettingsContext.js (offline fallback),
src/shared/uncountedItems.js. errorText rule order verified by executing a copy of the module under node in the scratchpad.
Status: COMPLETE. (Findings are numbered in the order found; the list is ordered by severity.)

### STOCK-1 [P1] Offline replay runs outside the per-cell lock and out of order — an older queued figure overwrites a newer save, and wastage/staff meals can double
- Where: src/modules/ims/stockcount/Stock.js:731-792 (flushQueue), :272 (`online` handler calls flushQueue with no re-entry guard), :679-705 (persistValue/persistLocks), :609-617 (wastage/staff_meal delete-then-insert)
- What happens:
  (a) Counter is offline, counts Rice = 5 (queued). Connection returns; the `online` event starts flushQueue, which replays the queue one op at a time (1–2 requests + dequeue each; a 60-item offline count is tens of seconds). Meanwhile the counter corrects Rice to 6 → saveRow → persistValue goes DIRECT (online) and lands 6, markStored(6). flushQueue then reaches the old op and writes 5. The card flips to "✓ Saved" showing 6 (storedRef says 6); the server holds 5. The correction is silently lost.
  (b) Same shape within one flush: op1 (Rice 5) fails with a network error, op2 (Rice 6, a later correction) succeeds and is dequeued; the loop `continue`s past failures, so op1 stays queued and the next flush (reload / online event) writes 5 over 6.
  (c) Two flushes at once: flushQueue has no in-progress guard (`syncing` is state, never checked at entry), and a flapping connection fires `online` more than once (or `online` fires while init()'s own flush is still running). Both runs getQueue() the same ops and both replay them. For a wastage or staff-meal op this is delete→delete→insert→insert across the two runs: two catch-all rows, wastage/staff meals doubled in Used/COGS. wastages/staff_meals have NO unique constraint (baseline schema; only opening/closing have `(period_id,item_id)` UNIQUE), so nothing refuses the duplicate. The persistLocks comment (:634-640) describes exactly this interleaving as the thing the lock exists to stop — the replay path bypasses it.
- Evidence: flushQueue calls `persistValueDirect(item.periodId, …)` directly, never through `persistLocks`; `catch (err) { … failures++; lastErr = err }` then continues the `for` loop; `const up = () => { setIsOnline(true); flushRef.current?.() }` with no guard; getQueue returns autoIncrement order.
- Status: missed by S756 (S731 added the refusal handling; S756 the changed-cells rule; neither touched replay ordering/locking)
- Fix: run each replay op through the same per-key chain (`persistLocks`) and skip an op when a later op for the same (period,item,field) exists or a direct write has landed since it was queued (drop superseded ops at enqueue — keep only the newest per key); stop the loop on the first network failure; a ref guard so only one flush runs.
- Confidence: Confirmed (code path); frequency depends on flaky connectivity, which is the case the queue exists for.

### STOCK-2 [P2] Every S756 IMS database refusal shows the generic "You're not allowed" sentence — the closed-month, month-rank and IMS-rank messages are unreachable
- Where: src/shared/errorText.js:396 (generic `e.code === '42501'` rule) precedes :503-531 (`period_closed`, `period_rank`, `recipe_*_rank`, `ims_rank`); raised by migration 20260918100000:119-120, :325-358 with `ERRCODE = '42501'`
- What happens: the page never re-reads the month's status, so a tablet left open on Bhadra keeps treating it as open after the Owner closes it from the Dashboard — every save is refused one at a time. A staff counter whose tablet still shows last month (closed by the Owner this morning) saves a count → trigger refuses (42501, hint period_closed) → the page says "The closing count figure for Rice was not saved — … Re-enter it and save again. You're not allowed to do that — this account doesn't have access to that record." instead of "That month is closed … only the account owner can change a closed month … Regenerate Snapshot". Same for a staff login pressing close on a month (period_rank) and every ims_rank refusal (bills, returns, payments, pars) module-wide.
- Evidence: `errorInfo` uses `rules.find(r => r.test(e))` (first match wins). Ran the real module under node against the real error shapes: `{code:'42501', hint:'period_closed'}` → "You're not allowed to do that — this account doesn't have access to that record." (operator) / "You're not allowed to do that. If that seems wrong, tell your manager." (staff); identical for period_rank and ims_rank. `closing_count_locked` (P0001) does reach its own rule. No test in errorText.test.js covers period_closed/period_rank/ims_rank with code 42501.
- Status: missed by S756 (the S752 block at :361 was deliberately placed "ahead of the generic permission rule"; the S756 block was appended after it)
- Fix: move the S756 IMS-guard rules (period_closed, period_rank, recipe_delete_rank, recipe_hide_rank, ims_rank, and any other hint-coded 42501 rule below :396) above the generic 42501 rule; add a test per hint with `code: '42501'`.
- Confidence: Confirmed (executed)

### STOCK-3 [P2] After a failed sync the page tells the counter to "Press Sync Now" and hides the Sync Now button; in a mixed failure the held counts vanish from view
- Where: src/modules/ims/stockcount/Stock.js:1410 (Sync Now banner gated `!syncFailed`), :1418 (ActionError has no button), :775-791 (message text; the closed-month branch `return`s before the other-failures branch)
- What happens: (a) any failed replay sets syncFailed → "…still waiting on this device. Press Sync Now to try again…" — but the only Sync Now button renders when `!syncFailed`, and ActionError renders no action; the counter can only reload. (b) A queue holding 3 counts for a month closed meanwhile plus 7 that failed for another reason (network, recount lock, section scope): the message names only the 3 closed-month figures and returns; the 7 are never mentioned, `pendingSync` (7) renders only inside the hidden Sync Now banner or the offline banner — the S731 "invisible from every screen" state, back for this case.
- Evidence: `{isOnline && !syncing && !syncFailed && pendingSync > 0 && (…Sync Now…)}`; `if (refusedClosed.length > 0) { … setSyncFailed({…}); return }` precedes `if (failures > 0)`.
- Status: missed by S756 / S731 residue
- Fix: render Sync Now beside the failure (or drop `!syncFailed` from the banner gate); build one message that covers both refusedClosed and failures.
- Confidence: Confirmed (code)

### STOCK-4 [P2] Offline counts replayed under the Owner's (or admin's) login land in a month closed meanwhile — silently, after its carry-forward (partial REGRESSION of D1 "refused and surfaced, not landed")
- Where: Stock.js:731-792 (no client-side period-status check before replay); migration 20260918100000:105 (`caller_can_edit_closed_period()` lets Owner/admin through)
- What happens: counts queued offline for Bhadra (by the Owner, or by a staff counter on a shared tablet the Owner later opens) replay after Bhadra was closed and Ashwin opened with the carry-forward. For a staff session D1 holds (refused, named). For an Owner/admin session the trigger lets them in: they land in Bhadra's closing_stock with no notice. Bhadra's frozen Monthly Report is now stale and — the costly half — Ashwin's opening stock was carried BEFORE these rows existed, so those items open Ashwin at 0 (or the old figure): Ashwin's COGS understated / FC% flattering until someone happens to run Resync. The owner is never told a replay touched a closed month.
- Evidence: flushQueue only special-cases a `period_closed` refusal; the queued op carries `periodLabel` but the replay never compares it to the current period list.
- Status: missed by S756 (D1's text says offline replay into a closed month is refused and surfaced; the Owner carve-out made that true only for staff sessions)
- Fix: before replaying, check the op's period against the freshly read periods; for a closed one, never replay silently — either hold it and show the named list with "Add to Bhadra and carry into Ashwin" (runs the write + carryForwardOpeningStock), or treat it like the staff path. See Owner question 2.
- Confidence: Confirmed code path; Plausible frequency (needs an Owner/admin session to be the one replaying)

### STOCK-9 [P2] The replay keeps every refusal except a closed month, retries it for ever as a "connection" problem, and later lands it under whoever outranks the counter
- Where: Stock.js:753-772 (only `period_closed` leaves the queue), :786-790 (message: "…still waiting on this device. Press Sync Now to try again once the connection is steady"); migration 20260910120000:139-155 (`ims_count_scope_allows` keys on the SESSION's rank and assignments), :248-265 (recount guard compares `OLD.counted_by` with the SESSION's uid); src/context/SettingsContext.js:131-133 (a failed settings read falls back to DEFAULT_SETTINGS, where scope and blind count are off)
- What happens: three ordinary ways a queued count meets a refusal that no retry can pass —
  (1) a scoped counter opens Stock Count with no connection: the settings read fails, `settings` becomes the defaults, `scopeOn` is false, so every item is on screen and their counts for other sections queue; (2) on a shared tablet counter A's queued ops replay under counter B's login (B's sections, B's uid); (3) with recount protection on, someone else counted the item before the replay. Each op is refused by the scope policy or `closing_count_locked`, stays in the queue, is retried on every load, and the page calls it a connection problem. Then the day a supervisor, manager or the Owner opens Stock Count on that tablet, flushQueue replays it under THEIR session — scope and recount both let a supervisor through — and the stale figure silently overwrites what the rightful counter entered since, stamped with the original counter's name (`countedBy` is replayed as queued).
- Evidence: `if (e?.hint === 'period_closed' || …) { refusedClosed.push(item); dequeue … continue }` — every other error is `failures++` and stays queued; the replay passes `item.countedBy` but runs under the current JWT.
- Status: missed by S756 (S731 wrote the rule "an RLS refusal … is a decision the server made — queueing one retries a refusal for ever" and applied it only to the closed-month refusal)
- Fix: classify replay errors with `isNetworkError`; anything else is a server decision — dequeue it and name it like the closed-month list ("Milk 3 — counted offline by Ram, not saved: someone else counted it / not your section"). Optionally refuse to replay ops whose `countedBy` is not the current user unless the user is a supervisor+ who confirms.
- Confidence: Confirmed code path; (1) additionally assumes the tablet booted without a connection, which the offline cache is built for.

### STOCK-5 [P2] KNOWN+ Correcting a closed month's closing count on Stock Count leaves the next month's opening stock stale, and nothing on the page says so
- Where: Stock.js:1384-1386 (only the red `isLocked` banner; nothing for `canEditClosedPeriods && closed`), :593-617 / :880-936 (closing writes), src/pages/Periods.js:1201 (Resync lives only on Periods); Stock.js:781 (closed-month replay message)
- What happens: the known ⚪ item is "Stock Count renders no closed-period banner". The material consequence beyond the missing banner: the carry-forward ran at close, so an Owner who fixes Bhadra's count (the sanctioned D1 path) — including the figures the closed-month sync message tells counters to "give to the account owner" — changes Bhadra's COGS but not Ashwin's opening. Ashwin's COGS is then wrong by the corrected amount until someone remembers Periods → Resync Opening Stock (or Pull from last month on Ashwin). The counter-facing message (:781) sends figures to the owner without mentioning the carry; the owner lands on Stock Count with no banner and no prompt; Regenerate Snapshot is not mentioned either.
- Evidence: no reference to Resync/carryForward anywhere in Stock.js; ClosedPeriodBanner rendered only when `isLocked`.
- Status: KNOWN+ (IMS_TODO §3 "Stock Count … still render no closed-period banner")
- Fix: render `<ClosedPeriodBanner canEdit note=…>` for Owner/admin on a closed month, and after a closing write into a closed month show "Ashwin opened with the old figure — Carry this count into Ashwin" (carryForwardOpeningStock(period, nextExistingPeriod)) plus the Regenerate Snapshot pointer.
- Confidence: Confirmed

### STOCK-6 [P2] Switching month on Stock Count shows the previous month's figures under the new month's name, and Export is live through it
- Where: Stock.js:528-561 (handlePeriodChange sets selectedPeriod at once, never sets `loading`), :1572 (Export disabled only on `biz.error`), :1999-2075 (touch card list has no `loading` branch at all), :1293/:1298 (scope line and filename from `selectedPeriod`), :809 (saveRow silently returns during the window)
- What happens: pick Shrawan from the dropdown on the Summary tab and press Export before the seven paged reads return → a workbook named `Stock-Register-2083-4.xlsx`, scope line "Period : Shrawan 2083 (period closed)", holding Bhadra's register (S728 rule: a control that emits a file must be gated on loading). During the same window the grids and the touch cards show last month's quantities (cards even show "✓ Saved") under the new month's chip; a figure typed then is dropped without a word by the `storedRef.periodId !== selectedPeriod.id` early return and replaced when the load lands.
- Evidence: no `setLoading(true)` in handlePeriodChange; `disabled={!!biz.error}` on Export; only the desktop grid branch reads `loading`.
- Status: missed by S756
- Fix: a `periodLoading` flag set in handlePeriodChange (cleared after loadStockData), gating the Summary, Export, Print, the touch list and Save All; or clear stockData to blank at switch.
- Confidence: Confirmed (code); window is the length of one load (≈1–3 s)

### STOCK-7 [P3] A refused count always says "Re-enter it and save again", including refusals no retry can pass
- Where: Stock.js:624-632 (noteSaveFailure)
- What happens: closed month (period_closed), recount protection (closing_count_locked), section scope (RLS) all get the prefix "…Re-enter it and save again." — retrying repeats the refusal (S706 rule: "try again" is a claim about the future). With STOCK-2, the closed-month case reads "Re-enter it and save again. You're not allowed to do that…".
- Status: missed by S756
- Fix: only add the retry sentence when `isNetworkError`/timeout; otherwise lead with the errorText sentence.
- Confidence: Confirmed

### STOCK-8 [P3] A stale "End month" click re-runs the carry-forward into the month that is already open
- Where: src/pages/periods/closePeriod.js:212 (status update has no `.eq('status','open')`/`.select('id')`), :227-241 (23505 → carry into the existing next period)
- What happens: two people see the Dashboard's "Bhadra has ended" banner; one closes. The other's dashboard still shows the button (no reload). Pressed hours later: the update matches (closed→closed, trigger passes with no changed column), the Ashwin insert 23505s, the code finds Ashwin and upserts Bhadra's closing into Ashwin's opening again — reverting any opening figure edited on Ashwin in the meantime (Pull, manual fix) — and reports success.
- Fix: `.eq('status','open').select('id')`; zero rows → "already closed by someone else, nothing changed".
- Confidence: Plausible (needs a stale dashboard + an edit to the new month's opening in between)

## GAPs
1. **One item kept in two places cannot be counted by two people.** Rice in the store room and Rice in the kitchen: the second tablet's save REPLACES the first (upsert on period+item), with no "add to what's already counted". With recount protection on, a staff counter is simply refused. The only workaround is one person typing `12+8` in the box. Common in any outlet with a bar fridge and a store.
2. **Closing the month cannot see counts still sitting on a tablet.** The close dialog says "N of M items counted" from the server only; a storekeeper's offline or unsynced counts are invisible to the Owner pressing "End Bhadra" (and, afterwards, either refused — staff — or landed silently — Owner session, STOCK-4).
3. **A counter on a tablet left open is never told the month has closed.** The page keeps the status it loaded; each save then fails on its own (with the generic message, STOCK-2) instead of the page switching to "Bhadra is closed — count into Ashwin".
4. **Recount history is invisible to the Owner.** Only the last counter's name shows ("counted by Sita"); who counted what first, and what the figure was before a supervisor corrected it, is only in the admin-only audit log — exactly the question recount protection exists to answer.
5. **No NPR on a counter's entry grid, but an email-login staff counter still sees full NPR on Summary and Daily Wastage** (S761 hid value "for anyone counting" only on the entry grid/cards). Display rule either way; worth a sentence on the Settings tab if the owner expects values hidden everywhere for staff.

## Owner questions
1. **Two people count the same item (store room and kitchen). What should the second save do?**
   (a) Replace the first count (today). (b) Add to it. (c) Ask: "Ram already counted 12 kg at 10:42 — replace, or add yours?"
   Recommendation: (c). It keeps a genuine recount possible and makes a two-location count safe.
2. **Figures counted offline arrive after the month was closed, and the person syncing is the Owner. What should happen?**
   (a) Land them in the closed month silently (today, for Owner/admin logins). (b) Refuse and list them, as for staff (D1's wording). (c) Show the list and offer one button: "Add these to Bhadra and carry them into Ashwin's opening stock".
   Recommendation: (c) — the count belongs to Bhadra, and the next month's opening must follow it.
3. **When the Owner corrects a closed month's closing count, should the next month's opening stock follow?**
   (a) Leave it; the Owner remembers Periods → Resync (today). (b) Update it automatically. (c) After the save, show "Ashwin opened with the old figure — update it?" with one button.
   Recommendation: (c). Automatic is surprising if Ashwin's opening was deliberately changed; silent is how next month's food cost goes wrong.

## Checked and fine
- S756 Save All / on-blur write changed cells only: storedRef/isChanged/markStored hold; tabbing through untouched cells writes nothing; in-flight cells still written (Stock.js:231-255, :799-832).
- S756 offline replay into closed month, staff session: `period_closed` refusal is dequeued and named per figure (item, field, qty, month) (:748-783) — hint matching works (`e.hint === 'period_closed'`).
- S756 bare selects: items read paged with id tiebreak (:376); Pull from last month paged by item_id (:1047).
- S756 Summary purchases through allocateBillDiscounts, returns at own rate (:498-516) — same basis as periodCost.valuePeriodItems; COGS via computeUsed in getUsed/getCogsValue; COGS_FORMULA printed.
- S756 closePeriod counted-vs-active mismatch: `items!inner(is_active)` on the counted side (closePeriod.js:84).
- Carry-forward paged with item_id tiebreak (closePeriod.js:155); failures ordered and surfaced via closeFailureText.
- D2: Dashboard End button `isOwner || hasImsAccess('supervisor')` (ClientDashboard.jsx:1179); DB guard ims_monthly_periods_guard (create/close supervisor+, reopen/relabel Owner) with COALESCE'd rank helper.
- D1 DB lock on opening_stock/closing_stock/wastages/staff_meals via ims_closed_period_guard, period status read past RLS.
- D6 on Stock Summary: UncountedItemsBanner above Totals, per-row "not counted" badge, "NOT COUNTED" column in export (:1492, :1648, :1281).
- 0-vs-blank (S695): toQty/isNoRow/sameStored used by every save path including queue and pull.
- Queue ops carry clientId; flush filters to the current client (:741). init() has a top-level catch (:287).
- S761: count PIN gets one tab; blindOn hides Summary and Print Sheet reference qty; hideValues hides NPR on the entry grid.
- S765: touch gate is `(pointer: coarse)`; card states derive from storedRef/pendingItems (typed vs saved vs queued distinct).
- Recount-guard refusal (P0001 `closing_count_locked`) reaches its own errorText rule (verified by executing errorInfo).
- BS dates: Daily Wastage day clamped with daysInBsMonth (:297-301); picker locked to period year/month (stores a day number); print date via nepalBs.
- Failed load blocks everything below the error card (:1422) and clears stored record (:446-453).
- StockMovements.js: init claims the page (`periodReq.begin`), stale catch guarded, ledger and sales reads paged, recipe_ingredients chunked, Print/Export gated on `loading || loadError`; S758 note that customized choices are recipe-only on the Sub-Recipes tab is present.
- subRecipeUsage.js: S758 change is a comment only; recipe-only by stated design.
- Summary vs Monthly Summary arithmetic: both computeUsed over the same valuation rules (stock at per_uom_rate, purchases net of bill discount, returns at own rate); the only population difference is sub-recipes (documented on the page). staff_meals read `type='staff'` here and all types elsewhere — equivalent today (nothing writes `'comp'`; CHECK allows it).
- Periods.js: Reopen admin-only with 23505 explained; rename `.eq('status','open').select('id')` zero-row branch; Resync uses nextExistingPeriod, busy + withTimeout; POS backfill shown to admin/Owner on closed rows (D1) and names Regenerate Snapshot.
- closing_stock.physical_qty is NOT NULL DEFAULT 0, so the `physical_qty IS NOT NULL` filters are always true (harmless; "no row" is the uncounted state).
