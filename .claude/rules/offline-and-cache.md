---
paths:
  - "src/shared/sessionDataCache.js"
  - "src/utils/offlineQueue.js"
  - "src/context/AuthContext.js"
  - "src/pages/dashboard/dashboardCache.js"
  - "src/modules/hr/employees/EmployeeList.jsx"
  - "src/modules/hr/roster/Roster.jsx"
  - "src/modules/ims/assets/AssetRegisterTab.js"
  - "src/modules/ims/assets/DepreciationRunTab.js"
  - "src/modules/ims/items/Items.js"
  - "src/modules/ims/purchases/**"
  - "src/modules/ims/recipes/Recipes.js"
  - "src/modules/ims/sales/Sales.js"
  - "src/modules/ims/vendors/Vendors.js"
  - "src/modules/ims/stockcount/**"
  - "src/modules/pos/orders/PosOrders.jsx"
---

# Page-revisit caching, session-scoped caches and offline

Split out of `.claude/rules/frontend-performance.md` word for word (S770 context pass, 2026-09-17), so it loads only where a cache or the offline queue is in play. The rest of the performance rules still load on every module file.

## Page-revisit caching (`src/shared/sessionDataCache.js`, added S460)

Migrated from the root `CLAUDE.md` (S663).

Route-level pages unmount on navigation, wiping local `useState` — so revisiting a page (Dashboard → Stock → Dashboard) re-fetches everything from scratch by default, which is a real chunk of the app's felt slowness on top of the usual network latency. `sessionDataCache.js` is a deliberately dumb `sessionStorage` key-value cache (`readPageCache(page, section, clientId)` / `writePageCache(...)`, 10-minute max age, keys namespaced per page so two pages can each have their own `items` section without colliding) — it does no calculation of its own, just storage, so adopting it never touches a page's actual data-fetching or math. The pattern: seed each relevant `useState`'s initial value from the cache (`useState(() => readPageCache(...) ?? fallback)`) so a revisit paints instantly, and wrap the existing setter calls in a small local `setAndCache(setter, section, value)` helper that also persists to the cache — no other change to the load function.

**Before adding this to a new page, check whether anything on it batch-saves "every visible row" trusting current on-screen state as the baseline** — that's the one shape where this pattern is actively dangerous, not just ineffective. `Stock.js`'s "Save All" (writes every visible item's currently-shown count, not just user-edited ones) and `Sales.js`'s per-mode save (merges typed edits against "the current saved value" as a fallback for every *other* item) both have this shape, and for a POS-enabled client `sales_entries` keeps changing in the background all day as bills close — so a stale cached number reaching one of these saves could silently overwrite a real figure. `Sales.js` only caches `periods`/`recipes` (the menu/period list, never a save-time baseline) for exactly this reason; `Stock.js` was left with no caching at all, since on that page essentially everything load-bearing is save-sensitive — and S695 found the same shape without any cache: a FAILED read rendered every cell blank, and Save All then deleted the server's real rows, so that page now renders nothing below its error card (see `ims-figures.md`). Pages where saving only ever writes the one record being edited (`Purchases.js`, `Recipes.js`, `Items.js`, `Vendors.js`, `ClientDashboard.jsx` which never saves at all) are safe for the full treatment — confirm which shape a new page has before wiring this in, don't assume.

`AuthContext.js`'s own `fetchProfile()` waterfall (`profiles` → `clients` → `feature_flags`) was also part of this same pass — `clients` and `feature_flags` only depend on `client_id`, not on each other, so they now run as `Promise.all` instead of two sequential round trips.

## Whether a page can adopt `sessionDataCache`

Two independent tests, and a page must pass **both**:

1. **Nothing on the page batch-saves using on-screen state as a baseline.** This is the existing
   rule in `CLAUDE.md` (Stock's "Save All", Sales' per-mode save). Purchase Orders fails it too —
   `confirmReceive` writes `qty_received + receiving`, so a stale cached row double-counts a
   delivery.
2. **The cached sections must be able to shorten the skeleton.** Caching a page's reference lists
   while its *core content* still blocks on a fresh read buys nothing visible — the skeleton waits
   for the core read regardless. That is dead code carrying a staleness risk, so don't wire it.

Items and Vendors pass both (their saves write only the record being edited, and the list *is* the
page). Purchase Orders and Variance fail both and are deliberately unwired, with the reasoning left
in a comment at the state declarations so the next sweep doesn't re-attempt it.

**A DERIVED figure is the best thing this cache ever holds (S693).** Roster's Labor Forecast caches
the labour standard — one small object — and never the ~15k rows of attendance, roster and sales it
was computed from, which would blow sessionStorage's budget on its own. It passes both tests
cleanly: the tab batch-saves nothing from on-screen state, and the standard IS the content of the
cells it fills, so a revisit genuinely skips a second load rather than shortening a skeleton that
was waiting on something else anyway. The 10-minute max age is generous for it — a figure learned
from 120 days does not move in ten minutes.

## A cache outlives the session that filled it (S731)

Three stores here survive a sign-out, and each had assumed it did not. A fourth — the purchase-bill draft (S779, below) — survives one **on purpose**, and pays this rule's price in its key.

**`sessionDataCache` keys on `page_section_clientId` — no user id — and `sessionStorage` lives as
long as the TAB, not the session.** So signing out and back in as a *different account of the same
client* in the same tab read the previous account's cached page data straight back. That is not
cosmetic staleness: the staff-isolation policies are RESTRICTIVE SELECT filters, so the rows an IMS
`staff` rank must not see are exactly the ones an Owner's cache would hand them. `switchOutlet()`
already cleared `sessionStorage` for the outlet version of this; **`signOut()` now does too, and
that call is load-bearing** — the file's own header used to claim the problem was impossible.

**A queued offline write must carry the client it was made for.** `sync_queue` in
`src/utils/offlineQueue.js` is one IndexedDB store shared by every account that has ever used the
device, and a Stock Count op used to carry only a period id. After a sign-out on a shared counting
tablet, the next session's `init()` replayed the previous one's counts under its own JWT, where RLS
refuses them. `switchOutlet()` in `AuthContext` refuses to switch outlet while either queue is
non-empty for precisely this reason; sign-out has no such guard, so the op now carries `clientId`
and `flushQueue()` leaves anything belonging elsewhere alone.

**A replay that swallows its failures is not resilience.** `flushQueue()` had a bare `catch (_) {}`,
so a count queued against a month that was closed while the device was offline was retried on every
page load, for ever, and said nothing — and the "N pending" badge it inflates renders only inside
the offline banner, so once back online the stuck entries were invisible from every screen. The
same rule as everywhere else in this codebase applies to a background replay: fail loudly, retry,
or genuinely swallow, decided per site. Here the counter can act on it, so it is surfaced.

**And the local store is an accelerator, never the data path.** `init()` on Stock Count is async
and nothing awaits it, so a rejection inside it was an unhandled rejection: `setLoading(false)`
never ran and the page sat on "Loading…" with no error anywhere. Every IndexedDB call can reject —
Firefox private browsing refuses `indexedDB.open` outright — and because `flushQueue()` is the
FIRST thing `init()` does, an unusable local cache took the **online** path down with it. Give any
such boot a top-level `.catch()` that sets the page's real error state, and wrap the cache reads so
a missing store degrades to "no cache" rather than to a dead page.

## A long form must survive the page dying (S779)

`sessionDataCache` above answers a page the USER navigated away from. This answers the page that
was taken away from them, which is a different problem with a different store.

`PurchaseBillForm` held an entire vendor bill — vendor, day, discount, the supplier's printed
figures and a row per item — in React state and nowhere else until Save, and a bill keyed off paper
is commonly 10–20 lines. Reported live: switch to another app, come back, start again. The reporter
added that Chrome had auto-updated itself, which is the whole story. **The page can end at any time
and nothing warns first** — a browser restarting for an update, a phone or tablet discarding a
backgrounded tab to reclaim memory, Chrome's memory saver on a laptop, and this app's own
`recoverFromChunkError()` reload when a deploy lands mid-entry.

`src/modules/ims/purchases/purchaseBillDraft.js` is the pattern. Before copying it, note which
decisions are load-bearing:

- **`localStorage`, not `sessionStorage`.** A browser that restarts itself opens a NEW session, so
  `sessionStorage` is empty in exactly the case that reported this. That is the opposite of the
  `sessionDataCache` choice above, and for a reason: that cache wants to expire with the tab.
- **Not the offline queue.** `offlineQueue.js` REPLAYS writes. A half-typed bill must never be
  written by anything but the person who finishes it, so a draft is a restore, never a send.
- **Two write triggers, because they cover different deaths.** A debounce (400ms) catches typing
  without writing per keystroke; `visibilitychange` (hidden) and `pagehide` write immediately,
  because hidden is the last event a page is guaranteed to see before it is discarded, and the
  debounce would not have fired for the last fraction of a second of typing. A debounce alone loses
  exactly the keystrokes the reader typed just before switching away.
- **Keyed by the record AND by the login.** This is the S731 rule above applied to a store that
  deliberately outlives a session. Crest runs on shared store-room and counting tablets where a PIN
  session ends on an idle lock, so surviving the sign-out is the point — but keyed by record alone
  the NEXT login is handed someone else's half-typed bill under the words "what you were typing",
  and can save it under their own name. `posLockedCart.js` had already reached this answer for an
  unsent till cart. **A store that survives a sign-out must name the session it belongs to, whether
  it survives one by accident or by design.** Fail closed: no login means no draft.
- **Store the DIFFERENCE from the record as opened, not the record.** On a new bill that means "the
  reader has typed something"; on an edit, "there are unsaved corrections". Opening and touching
  nothing, or undoing back to the start, then leaves nothing to restore — which is what keeps the
  restore notice honest.
- **Cleared when the save lands and when the reader cancels.** Cancel has always meant "throw this
  away", so leaving the draft would offer back the very record just abandoned. Anything restored is
  then, by construction, still unsaved.
- **Restore in the `useState` initialiser, never an effect.** An effect mounts the blank form and
  then replaces it, and a keystroke landing in that gap is typed into state about to be discarded.
- **Never restore silently.** The reader left expecting to have lost the work, so lines appearing
  unannounced are lines they did not knowingly type — and on a form that writes money that is a
  record someone will save without reading. A `role="status"` bar names what came back and when,
  says plainly that nothing is recorded yet, and offers the other answer (start clean / discard the
  changes) rather than making them empty the rows by hand.

**Which forms want this**: the ones a human legitimately spends minutes in before pressing Save —
the same list `sessionKeepAlive.js` was written for (Purchases, Stock Count, Sales Entry), which is
not a coincidence. Both files exist because this product's entry screens are long. Stock Count has
the offline queue and saves per row, so it is already covered by a different mechanism; **Sales
Entry's bulk grid is not, and has the same shape.**

## `navigator.onLine` is a claim about a network interface, not about the server (S731)

It is true on a restaurant wifi with no upstream, and it stays true when the signal dies between
pressing Save and the request landing. So a page that branches on it — Stock Count is the only one
that does — takes the DIRECT path, fails, and reports a lost count while the offline queue that
exists for exactly this situation is never consulted.

The fix is to treat the failure, not the flag: catch the write, ask `isNetworkError(err)` from
`src/shared/errorText.js` (exported as a predicate so the queue decision and the sentence shown to
the user come from one regex), and queue on a dropped connection only. **An RLS refusal, a
closed-period trigger or a constraint violation is a decision the server made** — queueing one
retries a refusal for ever, which is the defect in the section above wearing the other hat.

Two things make this safe to do, and both are worth checking before copying the pattern:

- **The write must be idempotent.** Opening and closing are upserts; wastage and staff meal are
  delete-then-insert over the same key. Re-running one converges on the same rows whether or not
  the original landed — which matters because a dead fetch never proves the write did not land, it
  only proves we did not hear back.
- **A queued write is not a saved write, and the success flash must not say it is.** The helpers
  return `'queued'` as a third answer beside `true`/`false`; flashing "✓ Saved" over a notice
  saying the connection dropped is the same contradiction the page already fixed one state along.
  And because the browser still believes it is online, the amber offline banner never renders — so
  the pending count needs its own banner with a **Sync Now** button, or the held entries are
  invisible from every screen and nothing sends them until the next page load.
