// One rule table turning a Supabase/Postgres error into a sentence its reader can act on.
//
// The failures that matter reach the screen as `error.message` and stop there. "TypeError: Failed
// to fetch" in a red line under the Add Item form (S618, reported live) tells a restaurant owner
// nothing about what happened, whether the item was written, or what to do next — and it is the
// most common failure of all, because it is every dropped connection.
//
// TWO AUDIENCES, because the same failure has two different next steps. A waiter on HR
// Self-Service can only escalate; an Owner adding an item IS the person who fixes it. Telling an
// Owner to "tell your manager" is as useless as "PGRST202" is to a waiter. Pick with the
// `audience` argument — 'staff' (default, the Self-Service wording that shipped first) or
// 'operator'.
//
// Two rules this follows:
//   * Never claim more than we know. Only genuinely recognisable shapes get a specific message;
//     everything else gets an honest generic one rather than a confident guess. In particular a
//     dead fetch does NOT prove the write never landed — the response can be lost after the
//     server committed it — so no message here says "nothing was saved".
//   * Never destroy the technical detail — an owner or admin still has to diagnose it. It is
//     returned alongside as `detail`, for a title attribute or a fine-print line, never the
//     headline.

const rules = [
  // Offline / DNS / CORS — supabase-js surfaces these as a bare TypeError from fetch, stringified
  // into `error.message` by PostgrestBuilder rather than thrown.
  {
    test: e => /failed to fetch|networkerror|load failed|network request failed/i.test(e.message || ''),
    staff: "You're offline, or the connection dropped. Check your signal and try again.",
    operator: "Couldn't reach the server — you're offline, or the connection dropped. Check your internet and try again.",
  },

  // A function or column the deployed frontend expects but the database does not have yet — i.e.
  // an unapplied migration. This project applies migrations by hand, so it is a real state.
  {
    test: e => e.code === 'PGRST202' || e.code === '42883' || e.code === '42703'
      || /schema cache/i.test(e.message || ''),
    staff: "This part of the app isn't ready yet. Tell your manager — there's nothing you can do from here.",
    operator: "This part of the app is ahead of the database — a migration hasn't been applied yet. Retrying won't help.",
  },

  // Session gone (expired JWT, signed out elsewhere).
  {
    test: e => e.code === 'PGRST301' || /jwt|token is expired|invalid claim/i.test(e.message || ''),
    staff: 'Your session has ended. Sign in again to continue.',
    operator: 'Your session has ended. Sign in again to continue.',
  },

  // The submit_my_* RPCs raise this literal when profiles.hr_self_service is off or unlinked.
  {
    test: e => /not authorized/i.test(e.message || ''),
    staff: "Your self-service access isn't set up. Ask your manager to check it.",
    operator: "That account isn't authorized for this action.",
  },

  // RLS refused, or EXECUTE was never granted on a new function signature.
  {
    test: e => e.code === '42501' || /permission denied|row-level security|violates row-level/i.test(e.message || ''),
    staff: "You're not allowed to do that. If that seems wrong, tell your manager.",
    operator: "You're not allowed to do that — this account doesn't have access to that record.",
  },

  // A purchase bill with vendor payments recorded against it cannot be deleted or edited (S698):
  // payable_payments cascades off purchase_entries, so either would silently erase money that
  // actually left the bank. Raised by the purchase_entries delete trigger and save_purchase_bill.
  {
    test: e => /purchase_bill_has_payments/i.test(e.message || ''),
    staff: 'This bill has payments recorded against it, so it cannot be changed or deleted. Ask your manager.',
    operator: 'This bill has vendor payments recorded against it, so it cannot be changed or deleted. Remove the payments in Outstanding Payables first, then try again.',
  },

  // save_purchase_bill found fewer lines to replace than the form was opened on — someone else
  // edited or deleted the bill in the meantime. Nothing was written.
  {
    test: e => /purchase_bill_stale/i.test(e.message || ''),
    staff: 'This bill changed while you were editing it. Nothing was saved — reopen it from the list and try again.',
    operator: 'This bill changed while you were editing it (another user edited or deleted it). Nothing was saved — reopen it from the list and try again.',
  },

  // The items BEFORE DELETE guard (S707). Ahead of the 23503/23505 rules below because it is
  // neither: it is a P0001 the trigger raises for the three ON DELETE CASCADE tables, where
  // Postgres raises nothing at all and the delete used to SUCCEED, silently taking the
  // requisition lines, staff meals and vendor returns with it.
  {
    test: e => /item_has_references/i.test(e.message || ''),
    staff: 'That item is used on records that already exist, so it cannot be deleted. Ask your manager to hide it instead.',
    operator: 'That item already appears on purchases, counts, requisitions or recipes, and deleting it would take those records with it. Hide it instead — it stops being offered on new entries and keeps every record it is already on.',
  },

  // force_delete_item refused. Both of its refusals happen BEFORE anything is written, which is
  // the one thing worth saying: the previous browser-side loop could not promise that.
  {
    test: e => /force_delete_item_not_permitted/i.test(e.message || ''),
    staff: 'You do not have permission to do that.',
    operator: 'Only a Crest operator can force-delete an item along with its records. Nothing was removed. Hide the item instead — it keeps every record it is already on.',
  },
  {
    test: e => /force_delete_item_missing/i.test(e.message || ''),
    staff: 'That item is no longer there.',
    operator: 'That item no longer exists — someone else may have deleted it already. Nothing was removed. Reload Item Master.',
  },

  // One item name per client, case-insensitive, mirrors and hidden items included (S707). Ahead of
  // the generic 23505 because "that already exists" says nothing about WHAT splits if you proceed.
  {
    test: e => /items_client_name_key/i.test(e.message || ''),
    staff: 'An item with that name already exists. Ask your manager which one to use.',
    operator: 'This client already has an item — or a sub-recipe, which is stock-counted alongside items — with that name. Two rows with one name split that ingredient’s purchases and stock between them. Rename one of them, or use the existing row.',
  },

  // Something already exists on a unique index.
  {
    test: e => e.code === '23505' || /duplicate key|already exists/i.test(e.message || ''),
    staff: 'That has already been recorded.',
    operator: 'That already exists — a record with the same key is already saved.',
  },

  // A CHECK or NOT NULL the form should have caught first — worth its own message, because
  // "try again" is exactly the wrong advice when the same input will fail the same way.
  {
    test: e => e.code === '23514' || e.code === '23502' || e.code === '22P02',
    staff: 'Something in the form was not accepted. Check the dates and amounts and try again.',
    operator: 'The database rejected a value in this form. Check the dates and amounts — the same entry will fail the same way.',
  },
]

const FALLBACK = {
  staff: "That didn't work. Try again — and tell your manager if it keeps happening.",
  operator: "That didn't work, and the reason isn't one we recognise. The technical detail is below.",
}

// → { text, detail }. `text` is always safe to show; `detail` may be empty.
export function errorInfo(err, audience = 'staff') {
  const key = audience === 'operator' ? 'operator' : 'staff'
  if (!err) return { text: FALLBACK[key], detail: '' }
  const e = typeof err === 'string' ? { message: err } : err
  const detail = [e.code, e.message].filter(Boolean).join(' · ')
  const hit = rules.find(r => r.test(e))
  return { text: hit ? hit[key] : FALLBACK[key], detail }
}

// Convenience for the call sites that only have room for one string.
export const errorText = (err, audience = 'staff') => errorInfo(err, audience).text

// The one-string form that still keeps the detail: `text (code · message)`. For the pages that
// carry a single status line (HR's `setMsg('error:' + …)` convention) and have no ActionError
// slot — the sentence leads, the raw detail rides along in parentheses, never destroyed (S619).
// Defaults to the operator audience, because every page on that convention is a manager's screen.
export const errorLine = (err, audience = 'operator') => {
  const { text, detail } = errorInfo(err, audience)
  return detail ? `${text} (${detail})` : text
}
