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

- **Two audiences, because the same failure has two different next steps.** `'staff'` (default —
  the HR Self-Service wording, which is why `employeeError.js` is now a four-line delegate) speaks
  to someone who can only escalate; `'operator'` speaks to the Owner/manager who *is* the person
  who fixes it. "Tell your manager" is as useless to an Owner as `PGRST202` is to a waiter.
- **No message claims a failed write did not land.** A dead fetch does not prove that — the
  response can be lost after the server committed — and `items` has no `UNIQUE(client_id, name)`,
  so a retry over a committed insert silently creates a second item. Say "check your internet and
  try again", never "nothing was saved"; a test asserts that string never appears.
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
- Distinct from the report rule above: that one is about a figure a page *did not compute*; this
  one is about the sentence shown once something has already failed. Rules only get added here for
  shapes genuinely recognisable from the error — everything else takes an honest fallback.
