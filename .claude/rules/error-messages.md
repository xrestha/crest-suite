---
paths:
  - "src/shared/errorText.js"
  - "src/components/ActionError.jsx"
  - "src/components/FieldError.jsx"
  - "src/modules/hr/selfservice/employeeError.js"
  - "src/modules/ims/**"
---

# An error surfaced as `error.message` is not a message (S619)

`src/shared/errorText.js` is the ONE table turning a Supabase/Postgres error into a sentence its
reader can act on. `errorText(err, audience)` / `errorInfo(err, audience)` → `{ text, detail }`.
Reported live from Add Item: a red `TypeError: Failed to fetch` under a valid entry — that is what
supabase-js hands back for any dead connection (PostgrestBuilder stringifies the thrown `TypeError`
into `error.message` rather than rethrowing, so it flows through every ordinary
`if (error) setError(error.message)` path untouched).

**`errorLine(err, audience = 'operator')` is the third form, added S682** — `text` plus the detail
in parentheses, as one string. It exists for the pages built on the `setMsg('error:' + ...)`
convention, which have exactly one status line and nowhere to put `ActionError`'s fine print; HR is
almost entirely that shape, and ~40 sites there were rendering a raw Postgres string into it. Reach
for `errorInfo`/`ActionError` wherever there is room for two lines and `errorLine` only where there
is not -- the detail must survive either way. Its audience defaults to `'operator'` rather than
`'staff'`, because every page on that convention is a manager's screen.

- **Two audiences, because the same failure has two different next steps.** `'staff'` (default —
  the HR Self-Service wording, which is why `employeeError.js` is now a four-line delegate) speaks
  to someone who can only escalate; `'operator'` speaks to the Owner/manager who *is* the person
  who fixes it. "Tell your manager" is as useless to an Owner as `PGRST202` is to a waiter.
- **No message claims a failed write did not land.** A dead fetch does not prove that — the
  response can be lost after the server committed — and on a table with no unique index the retry
  then silently creates a second row. Say "check your internet and try again", never "nothing was
  saved"; a test asserts that string never appears. **`items` was the worked example and is no
  longer one**: S707 added `items_client_name_key`, so a retry there is refused as a duplicate name
  rather than doubling the master row. That does not soften the rule — it narrows it to the tables
  that still have nothing, which is most of them — and it is worth noting for the opposite reason:
  the *presence* of a unique index is what lets `Items.js` say something specific about a retry, so
  a call site can only make that claim where it can point at the index that backs it.
- **A refusal that says nothing was written may only say so when nothing was.** `force_delete_item`
  earns it — the whole clear-and-delete is one transaction, so a failure genuinely rolls back — and
  the message says so explicitly, because the browser loop it replaced could not and had shipped a
  half-destroyed item book under a "try again". Atomicity is not a detail to leave out of the copy:
  it is the difference between "retry safely" and "check what survived". A BEFORE DELETE trigger earns the
  same claim for free and for a different reason — it raises before the statement writes anything,
  so `vendor_has_references` and `item_has_references` can both say the record is untouched. **The
  claim is earned by WHERE the refusal happens, not by how confident the message is**: the same
  words are a lie in a `catch` around a write whose response was lost.
- **Never destroy the technical detail.** `detail` (`code · message`) is returned alongside for a
  fine-print line, never the headline — whoever diagnoses it still needs it.
- **`ActionError` is where that sentence goes (S658).** `src/components/ActionError.jsx` +
  `asActionError(err, audience)` render the pair — headline plus a quiet monospace detail line —
  and complete the family `FieldError` (one control) and `ReportLoadError` (a whole report) already
  formed. Convert at the CALL SITE, never at render: the audience is a fact about who is looking at
  that screen, and running a hand-written validation string through the table flattens it into
  "that didn't work", so a plain string passes through untouched. Do not hand-roll
  `{error && <p style={{ color: 'var(--theme-red-text)', fontSize: 13 }}>{error}</p>}` — that shape
  stood at ~20 sites in IMS and at most of them was handed `error.message` verbatim.
- **`ReportLoadError` is the one channel that converts at RENDER (S682).** The product-wide audit
  found every one of its ~70 callers handing it either the Supabase error object or the raw
  `error.message` string (`firstError()` returns the latter), so the card printed "TypeError:
  Failed to fetch" as the body of a report. The call-site rule exists because the AUDIENCE is a
  fact about who is looking; a report is only ever read by the operator, so that decision is the
  same at every site and making it inside the component closed all of them at once instead of the
  ones a grep happened to find. It runs `errorInfo(error, 'operator')` on whatever it is handed and
  keeps the raw text as the `.action-error-detail` fine-print line. Pass the error OBJECT where you
  can (the code survives into the detail); a string still works. `ActionError` does NOT do this —
  it renders hand-written validation copy verbatim, which is why its conversion stays at the call
  site.
- **A message names the CONSEQUENCE, not the constraint.** Most of what S658 replaced were two-write
  sequences where the FIRST write had already committed — a purchase bill left holding both versions
  of its lines and double-counted in every purchase figure, a requisition header with no items, an
  item whose references were all cleared before the delete failed, a PO whose line items were gone.
  `duplicate key value violates…` told the reader none of it. Say what state the record is in now
  and how to get out of it, then the technical sentence. Same family as the "two writes in one
  function can diverge" rule above — that one is about what the CODE may not infer, this is about
  what the USER must be told.
- **A discarded write error reads as "that did nothing".** `Vendors`' hide/delete and
  `PurchaseOrders`' Mark Sent/Cancel/Delete each dropped their error and reloaded the row unchanged,
  which a user reads as the row already being in that state. Note where the message can appear
  before assuming a page has a slot: on all three of those pages the existing `error` state renders
  inside a modal, and every one of those actions fires from the LIST.
- **A message must not offer a retry that cannot work (S706).** Item Master's force-delete failure
  said "Try the delete again" — but the reason the final delete was refused was a reference the
  clearing loop could not remove, so retrying repeats the same refusal forever while the history it
  already destroyed stays destroyed. The next step is part of the consequence: name what was
  removed, name what is still holding the record, and say plainly when retrying will not get past
  it. **"Try again" is a claim about the future**, and it is only honest where the failure is
  plausibly transient.
- **"Try again" is a promise the CODE has to keep (S716).** S706 is about not offering a retry that
  cannot work; this is the case where it can work and the handler takes it away. Overheads' save
  clears the period and re-inserts, so after a failed insert the only surviving copy of the figures
  is the unsaved React state on screen — and the function's last line was `await loadOverheads()`,
  which reloads, finds nothing, and seeds the previous month's numbers over them. The message says
  "everything you entered is still on screen and has NOT been lost — press Save again. Do not
  reload the page first", and the early return that skips the reload is what makes each of those
  three claims true. **Write the sentence and the recovery path in the same edit**, and name the
  thing that would destroy it — a reload is not obviously dangerous, so a reader who is not told
  will do it.
- **The best consequence message is the one you delete by making the state impossible (S709).**
  "A PO whose line items were gone" above was a real half-deleted state with a carefully worded
  apology attached — and it existed only because `deletePoNow` hand-rolled a cascade the FK already
  performs, in two round trips that could stop between them. Deleting through the cascade removed
  the state and the sentence together. Before wording a consequence, check whether the two-write
  sequence that produces it needs to exist: the same session replaced the PO receipt's four writes
  with one RPC and six messages became one honest set of refusals.
- **Six of those refusals may say "nothing was received" (S709)**, and it is worth being precise
  about why: `receive_purchase_order` raises `po_period_closed` / `po_not_receivable` /
  `po_over_receive` / `po_receipt_stale` inside the single transaction that would write the bills,
  so the rollback is a property of where they are raised. The message the user sees after a dropped
  connection to the *same* RPC says no such thing — it falls to the network rule, which claims
  nothing about what landed. Both paths point at the same next step instead: reopen the order,
  because what it shows as outstanding is what actually recorded. **When you cannot promise what
  happened, name the place that can tell them.** `errorText.test.js` asserts both halves.
- **A refusal the page WROTE must not be run back through the table (S714).** `errorInfo` only
  recognises Supabase/Postgres *shapes*; a hand-written English sentence matches no rule and comes
  back as the FALLBACK — "That didn't work, and the reason isn't one we recognise" — with the real
  sentence demoted to the fine print. `Recipes.js`'s `save()` reports every failure by throwing and
  surfacing it from one `catch (err) { setError(asActionError(err)) }`, so **every carefully worded
  refusal in that function was reaching the user as that shrug**: the duplicate Product Code, both
  halves of S707's mirror name clash (written specifically to say which side already holds the
  name), and S711's "saved, but the previous ingredient list could not be removed". Each named a
  consequence; each arrived as a generic apology. `ActionError` already draws this line one layer
  down — a plain string passes through untouched — and a throw/catch needs the same distinction
  made explicitly: a tagged error class (`SaveRefusal`) carrying `{ text, detail }` for copy we
  wrote, `asActionError` for everything else. **The tell is a `catch` that converts, in a function
  that throws its own prose.** Related: `throw new Error(error.message)` on a Supabase error
  discards `error.code`, so the code-keyed rules (23514, 23502, 22P02) can never match — rethrow
  the error object.
- Distinct from the report rule above: that one is about a figure a page *did not compute*; this
  one is about the sentence shown once something has already failed. Rules only get added here for
  shapes genuinely recognisable from the error — everything else takes an honest fallback.
