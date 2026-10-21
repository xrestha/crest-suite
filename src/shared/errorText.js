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

// Offline / DNS / CORS. Named and exported because two callers need the PREDICATE, not the
// sentence: a caller that can retry later (Stock Count queues the write instead of losing it)
// has to tell a dropped connection from a refusal, and a second copy of this regex is how the
// two answers start disagreeing.
const NETWORK_ERROR_RE = /failed to fetch|networkerror|load failed|network request failed/i

/** True when the failure was the connection, not the server's answer. */
/** True for withTimeout giving up (S776). One predicate, shared with ReportLoadError (S852). */
export function isTimeoutError(err) {
  if (!err) return false
  const e = typeof err === 'string' ? { message: err } : err
  return e.name === 'TimeoutError' || /timed out after \d+s/i.test(e.message || '')
}

export function isNetworkError(err) {
  if (!err) return false
  const e = typeof err === 'string' ? { message: err } : err
  return e.name === 'FunctionsFetchError' || NETWORK_ERROR_RE.test(e.message || '')
}

// A stable machine code raised by a guard (S754). The POS guards put it in the Postgres HINT, which
// PostgREST returns as `hint` and supabase-js keeps as `error.hint`; most of them also lead the
// message with it (`pos_shift_rank: …`). Either is accepted, so an error that reached a page as a
// bare message string — or through a wrapper that dropped `hint` — still matches. Word boundaries,
// so `pos_cash_movement_rank` never matches `pos_cash_movement_locked`.
function hasCode(e, ...codes) {
  if (codes.includes(e.hint)) return true
  const msg = e.message || ''
  return codes.some(c => new RegExp(`(^|[^a-z_])${c}([^a-z_]|$)`, 'i').test(msg))
}

// Which table a POS guard refused on. Every S754 message leads with it (`pos_credit_notes: …`),
// and one hint (bill_locked) is shared by refusals whose consequences differ by table.
const onTable = (e, table) => new RegExp(`^${table}:`, 'i').test(e.message || '')

const rules = [
  // Offline / DNS / CORS — supabase-js surfaces these as a bare TypeError from fetch, stringified
  // into `error.message` by PostgrestBuilder rather than thrown. An Edge Function call that got no
  // answer is a FunctionsFetchError, and adminOp keeps that name on what it rethrows (S852).
  {
    test: e => isNetworkError(e),
    staff: "You're offline, or the connection dropped. Check your signal and try again.",
    operator: "Couldn't reach the server — you're offline, or the connection dropped. Check your internet and try again.",
  },

  // withTimeout gave up (S776). The request may still land after the clock ran out, so neither
  // wording says it did not happen.
  {
    test: e => isTimeoutError(e),
    staff: 'The server took too long to answer. Check your signal, then check whether it went through before trying again.',
    operator: "The server took too long to answer, so it isn't known whether this went through. Check your connection, then check before trying again.",
  },

  // fetchAllRows reached its row ceiling (S792, TAX-13). It used to return the rows so far as a
  // success, a short total with nothing to say so. Matched on the message too, because firstError()
  // hands a report only `error.message`. Retrying reads the same rows, so neither wording offers it.
  {
    test: e => hasCode(e, 'crest_row_cap') || /too long to read in full/i.test(e.message || ''),
    staff: 'This list is too long for Crest to read in full, so it was not shown. Tell your manager.',
    operator: 'This report has more rows than Crest reads in one go, so it was stopped rather than shown with a short total. Contact Crest support to raise the limit.',
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

  // ── POS money path and rank guards (S754, migrations 20260916100000 + 20260916110000) ───────
  // Every one of these is raised by a BEFORE trigger, a statement trigger or inside the RPC before
  // it writes — the statement rolls back — so each may say nothing was changed. They sit ahead of
  // the generic 42501 / 23505 rules below, which could only say "not allowed" / "already exists".
  // Keyed on the hint code, never on the prose, so rewording a migration message cannot unhook one.
  //
  // bill_locked is one hint for four different refusals; the table the message names picks which.
  {
    test: e => hasCode(e, 'bill_locked') && onTable(e, 'pos_credit_notes') && /issued against a paid bill/i.test(e.message || ''),
    staff: 'Only a paid bill can be credited — not a void or a complimentary bill. No Credit Note was issued.',
    operator: 'A Credit Note can only be issued against a paid bill of this outlet — not a voided or complimentary one — so no note was issued and nothing was numbered.',
  },
  {
    test: e => hasCode(e, 'bill_locked') && onTable(e, 'pos_credit_notes'),
    staff: 'An issued Credit Note is a numbered tax document, so it cannot be changed or deleted. Nothing was changed.',
    operator: 'An issued Credit Note is a numbered tax document, so it cannot be edited or deleted — nothing was changed. If it was issued in error, the correction is a new bill, not a change to the note.',
  },
  {
    test: e => hasCode(e, 'bill_locked') && /already has a credit note|not issued against it/i.test(e.message || ''),
    staff: 'This bill already has a Credit Note linked to it. Nothing was changed.',
    operator: 'This bill already has a Credit Note linked to it, or the note was not issued against this bill, so the link was not changed. A bill is credited once — find its note in the Credit Note Book.',
  },
  {
    test: e => hasCode(e, 'bill_locked') && /unsettled credit bill/i.test(e.message || ''),
    staff: 'This bill has already been settled. Nothing was changed — reload the list.',
    operator: 'This bill is not an unsettled Credit bill any more — it was probably settled on another device a moment ago — so nothing was recorded twice. Reload the list to see where it stands.',
  },
  {
    test: e => hasCode(e, 'bill_locked'),
    staff: 'This bill is closed and printed, so it can no longer be changed. Nothing was changed — ask a manager about a Credit Note if it needs correcting.',
    operator: 'This bill is closed and printed, so it is locked for everyone and nothing was changed. To correct it, issue a Credit Note. It may have been closed on another device a moment ago — reload to see it.',
  },
  {
    test: e => hasCode(e, 'credit_note_exists'),
    staff: 'This bill has already been credited, so no second Credit Note was issued.',
    operator: 'This bill already has a Credit Note — a bill is credited once — so no second note was issued and nothing was numbered. Find the existing note in the Credit Note Book; another manager may have issued it a moment ago.',
  },
  // S809 2e (migration 20261009210000). Raised by pos_credit_note_settle, the trigger that finishes a
  // note inside its own INSERT, so the note rolled back with it: nothing was issued or numbered.
  {
    test: e => hasCode(e, 'credit_note_refund_no_shift'),
    staff: 'No shift is open, so the cash refund has nowhere to go. No Credit Note was issued — ask a supervisor to open a shift, or choose Other or None.',
    operator: 'No shift is open, so a cash refund has no drawer count to come out of, and no Credit Note was issued (nothing was numbered). Open a shift and issue it again, or choose Other or None if the money did not come out of the till.',
  },
  {
    test: e => hasCode(e, 'credit_note_link_failed'),
    staff: 'The bill could not be marked as credited, so no Credit Note was issued. Close this, open the bill again and try again.',
    operator: 'The bill could not be marked as credited, so no Credit Note was issued and nothing was numbered. Reload the bill and issue it again; if it happens again, contact Crest support.',
  },
  // ── S843 (migration 20261015120000): customer payments on Credit bills, each a numbered receipt ──
  // record_credit_receipt and cancel_credit_receipt raise every one of these before they write, in
  // one transaction, and the receipt guards are BEFORE triggers — so each may say nothing was
  // recorded, cancelled or changed. A dropped connection to the same functions falls to the network
  // rule above, which claims nothing (a replay of the same press returns the first receipt).
  // rank_required is shared with every other rank refusal, so these two are told apart by the code
  // their message leads with, and sit ahead of the generic rank sentence further down.
  {
    test: e => hasCode(e, 'rank_required') && /(^|[^a-z_])credit_receipt_rank/i.test(e.message || ''),
    staff: 'Taking or cancelling a customer payment needs a supervisor or a manager. Nothing was recorded or cancelled — ask one of them to do it.',
    operator: 'Recording or cancelling a customer payment needs a POS supervisor, a POS manager or the Owner, so nothing was recorded or cancelled from this login. Raise its rank on POS Staff if this person should take payments.',
  },
  {
    test: e => hasCode(e, 'rank_required') && /pos_credit_receipt_rank/i.test(e.message || ''),
    staff: 'Reprinting a payment receipt needs a supervisor or a manager, so this login cannot reprint it — ask one of them.',
    operator: 'Reprinting a payment receipt needs a POS supervisor, a POS manager or the Owner, so this login cannot reprint it. Ask one of them to reprint it from the customer\'s receipts.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_auth'),
    staff: 'This login is not signed in to the outlet, so nothing was recorded or cancelled. Sign in again, then try again.',
    operator: 'This login is not signed in to an outlet, so the payment was neither recorded nor cancelled — nothing was changed. Sign in again, then try again.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_bad'),
    staff: 'The payment could not be recorded as entered, so nothing was recorded. Check the amount and the bills it covers (the reason is in the small print), then try again.',
    operator: 'The payment was refused as entered (the reason is in the detail below), so nothing was recorded and no receipt was numbered. Check the amount, the method and the bills it is split over, then record it again.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_no_shift'),
    staff: 'No shift is open, so the cash has no drawer to go in and the payment was not recorded. Ask a supervisor to open a shift, or pick the method the money really came by if it was not cash.',
    operator: 'Cash goes onto the open shift\'s drawer count, and no shift is open at this outlet, so the payment was not recorded and no receipt was numbered. Open a shift in POS → Shifts and record it again, or pick the method the money really came by if it was not cash.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_stale'),
    staff: 'One of these bills was paid or credited since the list was loaded, so nothing was recorded. Reload the list and take the payment again.',
    operator: 'One of the bills in this payment is no longer an unpaid Credit bill — it was paid or credited on another device a moment ago — so nothing was recorded and no receipt was numbered. Reload the list to see what is still owed, then record the payment again.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_party'),
    staff: 'One of these bills belongs to a different customer, so nothing was recorded. Reload the list and pick this customer\'s bills.',
    operator: 'One of the bills in this payment belongs to a different customer or delivery partner (the list was out of date), so nothing was recorded and no receipt was numbered. Reload this customer\'s bills and record the payment again.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_over'),
    staff: 'That is more than is still owed on a bill, so nothing was recorded. Reload the list to see what is owed, and take no more than that.',
    operator: 'A payment can never be more than is still owed (no advances), and one bill was given more than it still owes — another payment may have landed a moment ago; the figures are in the detail below. Nothing was recorded and no receipt was numbered. Reload the list and record what is owed.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_cancel_reason'),
    staff: 'Say why the payment is being cancelled (3 to 300 characters). It was not cancelled.',
    operator: 'A cancelled payment keeps its reason on the record, so one is needed (3 to 300 characters). The payment was not cancelled — add the reason, then cancel it again.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_missing'),
    staff: 'That payment is not on this outlet\'s records, so nothing was cancelled. Reload the list.',
    operator: 'That payment is not one of this outlet\'s (it may belong to an outlet this login has switched away from), so nothing was cancelled. Reload the page and find the payment again.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_cancel_credited'),
    staff: 'A Credit Note has been issued on one of this payment\'s bills, so the payment stands and was not cancelled.',
    operator: 'A Credit Note has been issued on one of this payment\'s bills, and the note settled that money, so the payment stands and was not cancelled. Cancelling it again will be refused the same way; any money given back to the customer belongs on the note.',
  },
  {
    test: e => hasCode(e, 'credit_receipt_cancel_no_shift'),
    staff: 'No shift is open, so the cash cannot be taken back out of a drawer and the payment was not cancelled. Ask a supervisor to open a shift first.',
    operator: 'Cancelling a cash payment takes its cash back out of the open shift\'s drawer, and no shift is open at this outlet, so the payment was not cancelled. Open a shift in POS → Shifts, then cancel it again.',
  },
  {
    test: e => hasCode(e, 'pos_credit_receipt_locked'),
    staff: 'A payment receipt cannot be changed or deleted. Nothing was changed — a mistake is cancelled with a reason instead.',
    operator: 'A payment receipt is written only by Receive payment and is never edited or deleted, so nothing was changed. A payment entered by mistake is cancelled with a reason (a supervisor or manager can); if a page sent this, reload it.',
  },
  // credit_use_receipts is raised twice: by guard_pos_order_close on the old whole-bill Settle, and by
  // pos_cash_movements_guard on the old settlement Cash In. The second can follow a settle that landed,
  // so only the first may say the bill was not settled.
  {
    test: e => hasCode(e, 'credit_use_receipts') && /pos_cash_settlement_receipts/i.test(e.message || ''),
    staff: 'This bill\'s payments are recorded with receipts, which put their own cash on the drawer, so this cash entry was not recorded. Tell your manager before recording any cash by hand.',
    operator: 'This bill\'s payments are recorded with receipts, which put their own cash on the drawer, so this cash entry was not recorded. Reload the page and check the bill on Customers → Outstanding Credit before recording any cash by hand: a Cash In on top would count it twice.',
  },
  {
    test: e => hasCode(e, 'credit_use_receipts'),
    staff: 'This bill has part payments recorded, so the rest is taken with Receive payment. Nothing was settled — reload Crest if that button is missing.',
    operator: 'This bill already has part payments recorded, so the rest is taken with Receive payment on Customers → Outstanding Credit, not settled whole. Nothing was settled and no cash was recorded. If Receive payment is missing, this page is an older version of Crest: reload it.',
  },
  {
    test: e => hasCode(e, 'pos_cash_receipt_direct'),
    staff: 'A customer payment\'s cash goes on the drawer by itself, so this entry was not recorded. Nothing was changed.',
    operator: 'A customer payment\'s cash goes on the drawer by itself when the payment is recorded, and comes off by itself when it is cancelled, so it cannot be entered directly — this entry was not recorded. Take the payment from Customers → Outstanding Credit instead.',
  },
  // S843 membership (migration 20261015130000). Each is raised by a BEFORE trigger, or is the unique
  // index refusing the row, so nothing was written; the two indexes sit ahead of the generic 23505.
  // Its three rank refusals share rank_required, told apart by the table and what the message names.
  {
    test: e => hasCode(e, 'rank_required') && onTable(e, 'pos_membership_types'),
    staff: 'Membership types are set up by the owner or a POS manager. Nothing was changed — ask one of them.',
    operator: 'Membership types are added, changed and deleted by the Owner or a POS manager, so nothing was changed from this login. Raise its rank on POS Staff if this person should set them up.',
  },
  {
    test: e => hasCode(e, 'rank_required') && onTable(e, 'pos_customers') && /membership card|credit limit/i.test(e.message || ''),
    staff: 'A membership card or a credit limit is given or changed by the owner or a POS manager. Nothing was saved — ask one of them.',
    operator: 'A customer\'s membership card and credit limit are given, changed and taken away by the Owner or a POS manager, so nothing was saved from this login. Raise its rank on POS Staff if this person should.',
  },
  {
    test: e => hasCode(e, 'rank_required') && onTable(e, 'pos_customers') && /birthday|anniversary/i.test(e.message || ''),
    staff: 'A customer\'s birthday, anniversary and their agreement to keep them are recorded by a supervisor or a manager. Nothing was saved — ask one of them.',
    operator: 'A customer\'s birthday, anniversary and their agreement to keep them are recorded by a POS supervisor, a POS manager or the Owner, so nothing was saved from this login. Raise its rank on POS Staff if this person should.',
  },
  {
    test: e => hasCode(e, 'membership_type_in_use'),
    staff: 'Customers still hold this membership type, so it was not removed. Nothing was changed — a manager can switch it off instead.',
    operator: 'Customers still hold this membership type, so it cannot be deleted and nothing was changed. Switch it off instead: it is then given to no one new, and the customers who hold it keep it.',
  },
  {
    test: e => hasCode(e, 'membership_type_invalid'),
    staff: 'That membership type cannot be given — it is switched off, or not this outlet\'s. Nothing was saved; pick another.',
    operator: 'A customer can only be given one of this outlet\'s own membership types, and only one that is switched on, so nothing was saved. Pick another type, or switch this one on in the membership types first.',
  },
  {
    test: e => hasCode(e, 'membership_type_outlet_locked'),
    staff: 'A membership type belongs to the outlet that made it, so it cannot be moved. Nothing was changed.',
    operator: 'A membership type belongs to the outlet that made it and cannot be moved to another, so nothing was changed. Make a new type at the other outlet instead.',
  },
  {
    test: e => hasCode(e, 'consent_required'),
    staff: 'A birthday or an anniversary is kept only when the customer has agreed to it. Nothing was saved — tick that they agreed, or clear both dates.',
    operator: 'A birthday or an anniversary is kept only when the customer has agreed to it, so nothing was saved. Record that they agreed, or, to withdraw their agreement, clear both dates in the same save.',
  },
  {
    test: e => hasCode(e, 'pos_membership_types_client_name_key'),
    staff: 'This outlet already has a membership type with that name, so nothing was saved. Use another name.',
    operator: 'This outlet already has a membership type with that name (names are matched ignoring capitals), so nothing was saved. Use another name, or change the existing type.',
  },
  {
    test: e => hasCode(e, 'pos_customers_client_card_no_key'),
    staff: 'That card number is already given to another customer of this outlet, so nothing was saved. Check the number on the card.',
    operator: 'That membership card number is already given to another customer of this outlet, so nothing was saved. Check the number on the card; if the card moved to this customer, take it off the other one first.',
  },
  {
    test: e => hasCode(e, 'stale_order'),
    staff: 'This order was changed on another device since you opened it. Nothing was saved — reload the order and add your changes again.',
    operator: 'This order was changed on another device since it was opened here, so this save was refused rather than overwrite theirs. Nothing was saved — reload the order and make the change again.',
  },
  // S809 1b: pos_till_build_gate refuses a bill write from a page older than the database's floor.
  // It raises before writing anything, so "nothing was saved" is earned. A till screen reloads itself
  // a few seconds later (releaseWatch.js), the order screen keeping its unsent items first.
  {
    test: e => hasCode(e, 'pos_till_build_too_old'),
    staff: 'This till is on an old version of Crest, so nothing was saved. It reloads itself in a few seconds and keeps any items you had not sent. Then try again.',
    operator: 'This page runs an older version of Crest than bills now need, so nothing was saved. A till reloads itself in a few seconds and keeps its unsent items; on any other screen, reload the page. Then try again. If it is refused again straight after a reload, contact Crest support.',
  },
  {
    test: e => hasCode(e, 'order_not_open'),
    staff: 'This bill has already been closed, so it cannot be changed. Nothing was changed — reload the floor.',
    operator: 'This bill is already closed (possibly on another device), so it can no longer be changed and nothing was changed. Reload the floor to see it.',
  },
  {
    test: e => hasCode(e, 'order_not_closed'),
    staff: 'That can only be recorded once the bill is closed. Nothing was changed.',
    operator: 'Credit Note, settlement and close details can only be recorded on a closed bill, and this one is still open — nothing was changed.',
  },
  // S809 1c (migration 20261009110000). guard_pos_order_close refuses a close whose status and close
  // type disagree, or that has no close type: such a bill left every money report, and "voided"
  // with no close type got past Allow Void. Raised by a BEFORE trigger on an open order, so the
  // bill is still open and nothing was changed. No till sends one; a hand-made request does.
  {
    test: e => hasCode(e, 'pos_close_mismatch'),
    staff: 'This bill could not be closed that way. A bill is closed as paid, complimentary or void, and nothing was changed. Reload the bill and close it from the Payment screen.',
    operator: 'A bill closes as Paid, Complimentary or Void, and its status has to say the same. This close did not, so it was refused and the bill is still open. Nothing was changed. Close it from the Payment screen; if a till sent this, reload that till.',
  },
  // S809 2b (migration 20261009190000). guard_pos_order_close decides what a Charge or a Complimentary
  // close stands on. Each is raised by the BEFORE trigger on the still-open order, so the bill is
  // still open and nothing was charged or numbered. pos_bill_empty is owner decision Q8 (a): an emptied
  // bill is refused, and clearing it is a Void. no_open_shift is the shift a till read a moment ago
  // having been closed on another device before the bill landed.
  {
    test: e => hasCode(e, 'pos_bill_empty'),
    staff: 'There is nothing on this bill, so it was not closed and nothing was charged. Add the items back, or ask someone with Void to void it.',
    operator: 'This bill has nothing on it to charge (no items, or only complimentary ones), so it was not closed and no number was used. Add the items back, or void it: voiding needs a login with Allow Void, or the Owner.',
  },
  {
    test: e => hasCode(e, 'no_open_shift'),
    staff: 'No shift is open on this till\'s outlet, so the bill was not closed and nothing was charged. Open a shift in Shifts, then charge the bill again.',
    operator: 'Every bill is charged onto the open shift so its money lands on a drawer count, and no shift is open at this outlet (it may have been closed on another device a moment ago). The bill is still open and nothing was charged. Open a shift in POS → Shifts, then charge it again.',
  },
  // S809 2c (migration 20261009200000). The close stamps the bill's VAT status from settings, and a
  // till that loaded its settings before the Owner switched VAT registration worked the total out
  // under the other one. Raised by the BEFORE trigger on the still-open order: nothing was charged.
  {
    test: e => hasCode(e, 'pos_vat_status_changed'),
    staff: 'The restaurant\'s VAT setting was changed since this till loaded it, so the bill was not charged. The till is loading the new setting — check the new total with the guest, then charge again.',
    operator: 'This outlet\'s VAT registration was switched in Settings after this till loaded it, so the total on screen was worked out the other way and the bill was not charged. Nothing was charged or numbered. Wait for the till to reload its settings (or reload the page), check the new total, then charge again.',
  },
  // S823 5c (migration 20261013100000). The close carries the version of the lines its total was
  // worked out from, and guard_pos_order_close refuses it when another save landed in between.
  // Raised by the BEFORE trigger on the still-open order, so nothing was charged or numbered. The
  // till loads the latest order itself; this is the wording anywhere else it surfaces.
  {
    test: e => hasCode(e, 'pos_bill_lines_changed'),
    staff: 'The items on this bill were changed on another device while it was being charged, so nothing was charged. Open the order again to see the latest items, check the total, then charge it again.',
    operator: 'Another device saved this order after this till worked out its total, so the items stored on the bill are not the ones the total was worked out from. The bill was not closed and nothing was charged or numbered. Open the order again to see the latest items, check the total, then charge it again.',
  },
  // Raised by guard_pos_order_close, guard_pos_credit_note and apply_pos_item_comps before they write,
  // when Nepal's date is past the end of the bs_months table (2031-04-13 as of 2026), so no year can
  // be given to number a bill, an NC slip or a Credit Note. Retrying cannot help.
  {
    test: e => hasCode(e, 'pos_fiscal_year_unknown'),
    staff: 'Crest\'s Nepali calendar does not reach today\'s date, so this could not be numbered and nothing was saved. Tell your manager to contact Crest support.',
    operator: 'Today\'s date is past the end of Crest\'s Nepali calendar, so no bill, complimentary or Credit Note number can be given and nothing was saved. Trying again will not help: contact Crest support to extend the calendar.',
  },
  {
    test: e => hasCode(e, 'option_edit_rank'),
    staff: 'Only the Owner or a manager can change customization options and combos. Nothing was changed.',
    operator: 'Only the Owner, a POS manager or an IMS manager can change customization options and combos, and this login is none of those — nothing was changed.',
  },
  {
    test: e => hasCode(e, 'customization_off'),
    staff: 'Crest Customization is not switched on for this outlet. Nothing was changed.',
    operator: 'Crest Customization is not switched on for this outlet (or its POS is off), so options and combos cannot be changed — nothing was changed. Ask Crest to switch it on.',
  },
  {
    test: e => hasCode(e, 'option_ingredient_foreign'),
    staff: 'That ingredient could not be added. Nothing was changed.',
    operator: 'That ingredient is not one of this outlet\'s stock items or sub-recipes (a prep item is added as its sub-recipe, not as its stock item), so it was not added. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'byo_template_name_taken'),
    staff: 'The template could not be created. Nothing was changed.',
    operator: 'Groups with the template names already exist for this dish, so the template was not created and nothing was changed. Use a different name, or open the existing groups on the Groups tab.',
  },
  {
    test: e => hasCode(e, 'byo_dish_not_found'),
    staff: 'That dish could not be found. Nothing was changed.',
    operator: 'That dish could not be found or marked, so no groups were created. Reload the page and try again.',
  },
  {
    test: e => hasCode(e, 'option_factor_not_size'),
    staff: 'That portion could not be saved. Nothing was changed.',
    operator: 'A portion (Small 0.75, Large 1.5) can only be set on an option in a Size group, so this option was not saved. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'group_kind_has_factors'),
    staff: 'That group could not be changed. Nothing was changed.',
    operator: 'This Size group still has sizes with a portion set, so it cannot become an Add-ons or Choice group yet. Nothing was changed — clear the Portion on each size first, then change the kind.',
  },
  {
    test: e => hasCode(e, 'option_attach_foreign', 'option_default_foreign'),
    staff: 'That option group could not be attached. Nothing was changed.',
    operator: 'That group could not be attached to this dish — the dish or the default option belongs somewhere else. Nothing was changed; reload the page and try again.',
  },
  {
    test: e => hasCode(e, 'customization_requires_pos'),
    staff: 'Crest Customization needs Crest POS switched on. Nothing was changed.',
    operator: 'Crest Customization sits on top of Crest POS, so it cannot be switched on for a client whose POS is off. Nothing was changed — switch POS on first, then Customization.',
  },
  {
    test: e => hasCode(e, 'order_options_off'),
    staff: 'Dishes cannot be ordered with options at this outlet. Nothing was saved — ask a manager.',
    operator: 'Crest Customization is not switched on for this outlet (or its POS is off), so a dish with options could not be added and the order was not saved. Remove the options, or ask Crest to switch Customization on.',
  },
  {
    test: e => hasCode(e, 'option_not_on_menu'),
    staff: 'One of the choices on a dish is no longer offered. Nothing was saved — change the choices and save again.',
    operator: 'An option chosen for a dish (named in the detail below) is hidden, deleted, or no longer attached to that dish, so the order was not saved. Change the choices and save again — or turn the option back on in Customization → Option Groups.',
  },
  {
    test: e => hasCode(e, 'option_count'),
    staff: 'A dish on this order is missing a choice it must have (a size, a base…) or has too many. Nothing was saved — tap Choices on that dish, pick, and save again.',
    operator: 'The choices on a dish break its rule — too few picks (or none) in a group that must be chosen, or too many (named in the detail below) — so the order was not saved. Change the choices and save again.',
  },
  // ── Combos (S839, docs/pos-combos.md) ────────────────────────────────────────────────────────
  {
    test: e => hasCode(e, 'combo_incomplete'),
    staff: 'A combo on this order is missing a dish, or its dishes are at different quantities. Nothing was saved — swap a dish within its pick, or remove the whole combo, and save again.',
    operator: 'A combo on this order (named in the detail below) needs one dish for each of its picks, all at the same quantity, so the order was not saved. Swap a dish within its pick, or remove the whole combo and add the dishes on their own.',
  },
  {
    test: e => hasCode(e, 'combo_dish_not_offered'),
    staff: 'A dish picked in a combo is no longer offered in it. Nothing was saved — choose again and save.',
    operator: 'A dish picked in a combo (named in the detail below) is no longer one of its pick\'s dishes, so the order was not saved. Choose again, or add the dish back to the combo in Customization → Combos.',
  },
  {
    test: e => hasCode(e, 'combo_unavailable'),
    staff: 'A combo on this order is not offered any more. Nothing was saved — remove it and save again.',
    operator: 'A combo on this order (named in the detail below) is switched off or deleted, or Crest Customization is off here, so the order was not saved. Remove the combo, or switch it back on in Customization → Combos.',
  },
  {
    test: e => hasCode(e, 'combo_comp_whole'),
    staff: 'A combo is made complimentary as a whole — every dish of it. Nothing was made complimentary: tick the whole combo.',
    operator: 'A combo is made complimentary as a whole, every dish of it by the same number, so nothing was made complimentary. Comp the whole combo, or none of it.',
  },
  {
    test: e => hasCode(e, 'combo_move_whole'),
    staff: 'A combo moves as a whole — every dish of it. Nothing was moved: move the whole combo.',
    operator: 'A combo moves to another bill as a whole, every dish of it by the same number, so nothing was moved. Move the whole combo, or leave it.',
  },
  {
    test: e => hasCode(e, 'discount_on_combo'),
    staff: 'A combo is already a deal, so a bill discount cannot come off it. Nothing was charged — lower the discount to what the other dishes come to.',
    operator: 'A bill discount never comes off a combo, and this one is more than the rest of the bill comes to (the detail below says how much), so the bill was not charged. Lower the discount and charge again.',
  },
  {
    test: e => hasCode(e, 'combo_name_taken'),
    staff: 'That combo name is taken or empty. Nothing was saved.',
    operator: 'Another combo already has that name (or the name is empty), so the combo was not saved. Give it a different name.',
  },
  {
    test: e => hasCode(e, 'combo_price_invalid'),
    staff: 'A combo needs a price above zero. Nothing was saved.',
    operator: 'A combo\'s price must be an amount above zero, to the paisa, so it was not saved. Enter the price the guest pays.',
  },
  {
    test: e => hasCode(e, 'combo_needs_picks', 'combo_pick_empty'),
    staff: 'Every pick of a combo needs a name and at least one dish. Nothing was saved.',
    operator: 'A combo needs at least one pick, and every pick a name and at least one dish (the detail below names any that has none), so the combo was not saved.',
  },
  {
    test: e => hasCode(e, 'combo_pick_name_taken', 'combo_default_twice'),
    staff: 'Two picks have the same name, or a pick has the same dish twice or two defaults. Nothing was saved.',
    operator: 'Two picks of this combo have the same name, or a pick lists a dish twice or has two defaults (named in the detail below), so the combo was not saved.',
  },
  {
    test: e => hasCode(e, 'combo_dish_unavailable'),
    staff: 'A dish in this combo cannot be used. Nothing was saved.',
    operator: 'A dish in this combo (named in the detail below) is inactive, a sub-recipe or another outlet\'s, or its extra charge is not an amount, so the combo was not saved. Take it out or fix it.',
  },
  {
    test: e => hasCode(e, 'line_not_on_menu'),
    staff: 'Something on this order is no longer on the menu, or has no price yet. Nothing was saved — remove it and save again.',
    operator: 'A dish on this order is no longer on the menu or has no menu price yet (named in the detail below), so the order was not saved. Remove it from the order and save again — or put the dish back on the POS menu, with a price, in Menu Pricing first.',
  },
  {
    test: e => hasCode(e, 'award_window_closed'),
    staff: 'This bill closed too long ago for points to be added from the till. The bill itself is fine — the owner or a POS manager can add the points in Customers → Loyalty.',
    operator: 'Loyalty points are added as a bill closes, and this one closed more than 10 minutes ago, so none were added from the till. The bill is unaffected; add them from the customer’s History in Customers → Loyalty.',
  },
  {
    test: e => hasCode(e, 'redeem_exceeds_bill'),
    staff: 'Those points are worth more than this bill. None were redeemed — redeem fewer.',
    operator: 'Those points are worth more than this bill, so none were redeemed. Redeem fewer points.',
  },
  // S809 2g (migration 20261009230000). redeem_loyalty_points refuses to spend points on a bill tagged
  // to a delivery partner or carrying a partner's phone: the platform owes the bill and pays it later,
  // so it neither earns nor spends points. Raised before the redemption is written, so none was.
  {
    test: e => hasCode(e, 'pos_points_delivery_partner'),
    staff: 'This bill is on a delivery partner’s phone (Foodmandu, Pathao and the like), and a delivery partner does not earn or spend points. No points were used — undo the points and take the payment another way.',
    operator: 'This bill carries a delivery partner’s phone, or is marked as a partner’s order. The partner owes the bill and pays it later, so it does not earn or spend loyalty points, and none were used. Undo the points and take the payment another way; a guest’s own points need the guest’s own phone on the bill.',
  },
  // S809 3k (migration 20261010110000, owner decision Q13 b). adjust_loyalty_points: the Owner or a POS
  // manager adds or takes off points by hand in Customers → Loyalty. Every refusal is raised before the
  // ledger row is written, so each may say no points were changed.
  {
    test: e => hasCode(e, 'pos_points_adjust_rank'),
    staff: 'Only the owner or a POS manager can add or take off points by hand. No points were changed.',
    operator: 'Only the Owner or a POS manager can add or take off loyalty points by hand, so no points were changed. A POS manager who has left (their Final Settlement is done) cannot either.',
  },
  {
    test: e => hasCode(e, 'pos_points_adjust_amount'),
    staff: 'Enter how many points, as a whole number. No points were changed.',
    operator: 'Enter how many points to add or take off, as a whole number above 0 (at most 10,00,000 at a time), so no points were changed.',
  },
  {
    test: e => hasCode(e, 'pos_points_adjust_reason'),
    staff: 'Say why the points are being changed. No points were changed.',
    operator: 'Say in a few words why the points are being changed (300 characters at most) — the reason is kept with the correction — so no points were changed.',
  },
  {
    test: e => hasCode(e, 'pos_points_adjust_below_zero'),
    staff: 'That would take this customer below 0 points. No points were changed.',
    operator: 'That would take this customer below 0 points, so no points were changed. A balance is never taken below 0 by hand — take off at most what the customer holds now (their points may have been spent at a till since this page loaded; reload to see).',
  },
  {
    test: e => hasCode(e, 'pos_points_adjust_partner'),
    staff: 'A delivery partner’s number cannot be given points. No points were changed.',
    operator: 'This is a delivery partner’s number (Foodmandu, Pathao and the like). A partner owes its bills and pays later, so it does not earn or spend points, and none were added. Points already on it can be taken off.',
  },
  {
    test: e => hasCode(e, 'pos_points_adjust_no_customer'),
    staff: 'That customer is no longer in the book. No points were changed.',
    operator: 'That customer is no longer in the customer book (deleted since this page loaded), so no points were changed. Reload the page.',
  },
  // S815 4g (migration 20261012100000). Q19 (c): a Credit bill earns at its close and its points can be
  // spent once it is settled; redeem_loyalty_points refuses the held part before writing anything.
  {
    test: e => hasCode(e, 'pos_points_held'),
    staff: 'Some of this customer’s points came from a Credit bill that is not paid yet, so they cannot be spent until it is settled. No points were used — redeem fewer.',
    operator: 'Some of this customer’s points were earned on a Credit bill that has not been paid yet, and they can be spent once it is settled in Customers → Outstanding Credit. No points were used; redeem fewer.',
  },
  // The one-tap "add the points this bill earned" (award_loyalty_points after the till's window).
  {
    test: e => hasCode(e, 'pos_points_before_enrolment'),
    staff: 'That bill closed before the customer joined their points scheme, so it earns no points.',
    operator: 'That bill closed before the customer joined their points scheme, so it earns no points and none were added. Only bills since they joined can have their points added.',
  },
  // move_loyalty_points (owner addition). Every refusal is raised inside the one transaction that would
  // write both rows, so each may say no points were moved.
  {
    test: e => hasCode(e, 'pos_points_move_rank'),
    staff: 'Only the owner or a POS manager can move points to a new number. No points were moved.',
    operator: 'Only the Owner or a POS manager can move loyalty points to a new number, so no points were moved.',
  },
  {
    test: e => hasCode(e, 'pos_points_move_reason'),
    staff: 'Say why the points are moving. No points were moved.',
    operator: 'Say in a few words why the points are moving (300 characters at most) — the reason is kept on both numbers — so no points were moved.',
  },
  {
    test: e => hasCode(e, 'pos_points_move_number'),
    staff: 'Type the new number in full. No points were moved.',
    operator: 'Type the new phone number in full (7 digits or more), so no points were moved. If it was typed in full, try again.',
  },
  {
    test: e => hasCode(e, 'pos_points_move_same'),
    staff: 'That is this customer’s own number. No points were moved.',
    operator: 'That is this customer’s own number, written another way, so no points were moved.',
  },
  {
    test: e => hasCode(e, 'pos_points_move_partner'),
    staff: 'A delivery partner’s number does not earn or spend points. No points were moved.',
    operator: 'One of the two numbers is a delivery partner’s (Foodmandu, Pathao and the like). A partner does not earn or spend points, so points cannot move off its number or onto it, and none were moved.',
  },
  {
    test: e => hasCode(e, 'pos_points_move_held'),
    staff: 'All of this customer’s points are waiting on an unpaid Credit bill. No points were moved.',
    operator: 'All of this customer’s points were earned on a Credit bill that is not paid yet, so they can be moved once it is settled in Customers → Outstanding Credit. No points were moved.',
  },
  {
    test: e => hasCode(e, 'pos_points_move_nothing'),
    staff: 'This customer has no points to move.',
    operator: 'This customer holds no points to move (they may have been spent at a till since this page loaded), so nothing was moved. Reload to see the balance.',
  },
  {
    test: e => hasCode(e, 'pos_points_move_no_customer'),
    staff: 'That customer is no longer in the book. No points were moved.',
    operator: 'That customer is no longer in the customer book (deleted since this page loaded), so no points were moved. Reload the page.',
  },
  // S809 2g: the CHECK settings_pos_loyalty_point_value_positive. Customers → Loyalty already refuses 0
  // before saving, so only a hand-made request reaches it. A 23514, so it sits above the generic rule.
  {
    test: e => /settings_pos_loyalty_point_value_positive/i.test(e.message || ''),
    staff: 'A point has to be worth more than NPR 0. Nothing was changed.',
    operator: 'The value of one loyalty point has to be more than NPR 0 (at 0 a guest would spend points and get nothing off the bill), so it was not changed. Enter what one point takes off a bill, for example 1.',
  },
  // S809 1j (migration 20261009160000). apply_pos_item_comps raises it before it writes, in the one
  // transaction that comps every line of the call, so "nothing was made complimentary" is earned.
  // The till never sends such a number from a bill it just saved; seeing it means the bill changed.
  {
    test: e => hasCode(e, 'pos_comp_qty_invalid'),
    staff: 'The number of complimentary items did not match the bill, so nothing was made complimentary. Check the Items list on the payment screen and confirm again.',
    operator: 'Part of a dish can be made complimentary from 1 up to one less than the number on the bill (the dish and numbers are in the detail below), so nothing was made complimentary and no NC number was used. To make a whole dish complimentary, set it to the full number. If the numbers look right, the bill may have changed on another device — reopen it and try again.',
  },
  // S809 2b (migration 20261009190000). apply_pos_item_comps refuses the whole call when a dish it was
  // asked to comp is not on the bill as a line it can still comp. It used to skip it and still return
  // an NC number, so the till printed an empty Complimentary Slip and charged the bill short. Raised
  // inside the one transaction that comps every line of the call, so nothing was made complimentary.
  {
    test: e => hasCode(e, 'pos_comp_line_missing'),
    staff: 'A dish you chose to make complimentary is not on this bill as it was (it may have been changed on another device), so nothing was made complimentary. Go back to the floor, open the bill again and check the items.',
    operator: 'A dish chosen to be made complimentary (named in the detail below) is not on this bill as an item that can still be made complimentary, so nothing was made complimentary and no NC number was used. The bill may have changed on another device: reopen it, check the items, and try again.',
  },
  {
    test: e => hasCode(e, 'pos_cash_refund_rank'),
    staff: 'Paying a refund out of the drawer needs a manager. No refund was recorded.',
    operator: 'Paying a Credit Note refund out of the drawer needs a POS manager or the Owner, so no refund was recorded on the shift.',
  },
  {
    test: e => hasCode(e, 'pos_cash_refund_over'),
    staff: 'That refund is more than the Credit Note. No refund was recorded.',
    operator: 'The cash refund is more than the Credit Note is worth, so it was not recorded. Refund at most the note’s net amount.',
  },
  {
    test: e => hasCode(e, 'pos_cash_refund_note'),
    staff: 'A refund has to be tied to a Credit Note. No refund was recorded.',
    operator: 'A cash refund must name a Credit Note of this outlet, and this one did not, so no refund was recorded.',
  },
  {
    test: e => hasCode(e, 'pos_cash_movement_rank'),
    staff: 'Recording cash in or out of the drawer needs a supervisor. Nothing was recorded.',
    operator: 'Recording cash in or out of the drawer needs a POS supervisor, a POS manager or the Owner, so nothing was recorded.',
  },
  {
    test: e => hasCode(e, 'pos_cash_movement_locked'),
    staff: 'A cash entry cannot be changed or deleted once recorded. Nothing was changed.',
    operator: 'A cash movement is a drawer record, so it cannot be edited or deleted — nothing was changed. Record a correcting Cash In or Cash Out instead.',
  },
  {
    test: e => hasCode(e, 'pos_cash_movement_shift_closed', 'pos_cash_movement_no_shift'),
    staff: 'There is no open shift for this cash to go on. Nothing was recorded — a supervisor has to open a shift first.',
    operator: 'Cash can only be recorded against an open shift, and this one is closed (or none is open), so nothing was recorded. Open a shift, then record it again.',
  },
  {
    test: e => hasCode(e, 'pos_shift_rank'),
    staff: 'Opening or closing a shift needs a supervisor. Nothing was changed.',
    operator: 'Opening or closing a shift needs a POS supervisor, a POS manager or the Owner, so nothing was changed.',
  },
  {
    test: e => hasCode(e, 'pos_shift_closed'),
    staff: 'This shift is already closed. Nothing was changed — reload the page.',
    operator: 'This shift is already closed and its settlement slip is signed, so it cannot be changed and nothing was changed. It was probably closed on another device — reload to see the closed shift.',
  },
  {
    test: e => hasCode(e, 'pos_shift_locked'),
    staff: 'A shift cannot be deleted. Nothing was removed.',
    operator: 'A shift is a cash record and cannot be deleted — every bill and cash movement on it would lose its shift. Nothing was removed.',
  },
  {
    test: e => hasCode(e, 'pos_shift_must_open'),
    staff: 'A shift has to start open. Nothing was saved.',
    operator: 'A shift starts open and is closed with Close Shift, so this was not saved.',
  },
  // S809 1l (migration 20261009180000). As a shift closes, pos_shifts_guard adds up the shift's own
  // stored cash bills and Cash In / Out and refuses a closing report whose cash figures differ. The
  // Shifts page meets it only when a bill or a cash entry landed after its last re-read. It is raised
  // before the write, so the shift is still open, and the close dialog keeps the count, so pressing
  // Close Shift again re-reads and works. Raised as P0001, so no generic rule below claims it.
  {
    test: e => hasCode(e, 'pos_shift_figures_changed'),
    staff: 'A bill or a cash entry reached this shift while the drawer was being counted, so the cash it should hold has changed. The shift is still open and your count is still on screen — press Close Shift again to see the new figures.',
    operator: 'A bill or a cash entry reached this shift after its figures were read, so its Expected Cash has changed, and Crest will not file a closing report that leaves it out. The shift is still open and the count you entered is still on screen: press Close Shift again to count against the new figures.',
  },
  // S823 5c (migration 20261013100000). A Split bill's payment lines reach the database a moment after
  // the bill closes, and pos_shifts_guard will not close the shift in that gap (for up to 11 minutes
  // after the bill). Raised before the write, so the shift is still open; the close dialog keeps the
  // count. The bill's time and the time the hold ends are in the detail (the server's sentence).
  {
    test: e => hasCode(e, 'pos_shift_split_pending'),
    staff: 'A Split bill closed a moment ago is still recording how it was paid, so the shift was not closed. Your count is still on screen — press Close Shift again in a minute.',
    operator: 'A Split bill on this shift closed a moment ago and its payments have not reached the shift yet, so Crest did not close it: the drawer report would have left that bill\'s cash out. The shift is still open and the count you entered is still on screen. Press Close Shift again in a minute. If the till that closed the bill went offline, the hold ends 11 minutes after that bill closed (the time is in the detail below).',
  },
  // S809 1l. The counted total (or the opening float) must be the notes counted. The Shifts screen
  // works the total out from the notes it sends, so only a write made some other way meets this.
  // Raised with 23514, so it must stay above the generic CHECK rule at the end.
  {
    test: e => hasCode(e, 'pos_shift_count_mismatch'),
    staff: 'The cash total does not add up from the notes counted, so it was not saved. Reload the Shifts page and count the drawer again.',
    operator: 'The cash total sent does not add up from the notes counted (₨1000 down to ₨1), so nothing was saved. Reload the Shifts page and enter the count there — it works the total out from the notes.',
  },
  {
    test: e => hasCode(e, 'pos_table_has_open_order'),
    staff: 'That table still has an open bill, so it cannot be deleted. Nothing was removed.',
    operator: 'That table still has an open bill (its order number is in the detail below), so it was not deleted — the bill would vanish from the floor with nobody able to reach it. Bill or void that order first.',
  },
  // S835 (migration 20261014110000, D41): pos_tables_guard_open_order_delete, a BEFORE trigger, so
  // nothing was removed. After the open-bill rule, which the same trigger raises first.
  {
    test: e => hasCode(e, 'pos_table_has_bills'),
    staff: 'That table has bills on record, so it cannot be deleted. Nothing was removed — a POS manager can take it out of service instead.',
    operator: 'That table has bills on record, so it was not deleted — its bills would be left pointing at a table that no longer exists. Nothing was removed. Take it out of service instead (set its Status to Inactive): it leaves the floor and keeps its history.',
  },
  // S835 (migration 20261014110000, FLOOR-KITCHEN-7's server half): guard_pos_order_insert, raised
  // before the insert, so no order was opened. The till says it in its own words first (S817).
  {
    test: e => hasCode(e, 'pos_table_inactive_new_order'),
    // S836: the table moves raise it too, so it says nothing was opened OR moved there.
    staff: 'That table is out of service, so nothing was opened or moved onto it. Pick another table.',
    operator: 'That table is out of service (perhaps taken out on another device a moment ago), so nothing was opened or moved onto it. Pick another table, or bring this one back in POS Setup first.',
  },
  // S817 4i (migration 20261012120000): pos_tables_guard_open_bill, a BEFORE trigger, so nothing changed.
  {
    test: e => hasCode(e, 'pos_table_inactive_open_bill'),
    staff: 'That table still has an open bill, so it was not taken out of service. Nothing was changed.',
    operator: 'That table still has an open bill (its order number is in the detail below), so it was not taken out of service — the floor would refuse every tap on it while the bill is still open. Bill or void that order first.',
  },
  {
    test: e => hasCode(e, 'pos_table_rename_open_bill'),
    staff: 'That table still has an open bill, so it was not renamed. Nothing was changed.',
    operator: 'That table still has an open bill (its order number is in the detail below), so it was not renamed — the bill and the tickets already sent would keep the old name while new ones took the new one. Rename it once the bill is closed.',
  },
  // S817 4i: two tables in service never share a name (a retired table's name may be used again).
  // Ahead of the generic 23505 rule, which could only say "already exists".
  {
    test: e => /pos_tables_client_name_live_key/i.test(e.message || ''),
    staff: 'Another table already has that name. Nothing was saved.',
    operator: 'Another table in service already has that name (capitals and spaces aside), so nothing was saved — two tables with one name cannot be told apart on a kitchen ticket or a bill. Give this one another name, or take the other out of service first.',
  },
  // ── Table move, join and split (S836, migration 20261014120000) ──────────────────────────────
  // Each is raised inside one of the six SECURITY DEFINER move functions before it returns, or by a
  // BEFORE trigger (the two _direct guards, and pos_table_joined from guard_pos_order_insert), so the
  // call rolled back whole and each may say nothing moved. pos_move_rank and the _direct guards carry
  // 42501 and pos_table_joined 23514, so this block stays above the generic rules for both. The move
  // functions also raise stale_order, order_not_open and pos_table_inactive_new_order, worded above.
  {
    test: e => hasCode(e, 'pos_move_rank'),
    staff: 'This login cannot move, join or split tables at this outlet, so nothing was moved. Sign in with your own POS PIN for this outlet, or ask a manager.',
    operator: 'Moving, joining or splitting a table needs the Owner or a POS login of this outlet (any rank). This login is neither, or its POS access is blocked, so nothing was moved. Sign in with a POS PIN of this outlet, or check the login under POS Staff.',
  },
  {
    test: e => hasCode(e, 'pos_move_order_missing'),
    staff: 'A bill in this move is no longer open — it was closed or cleared on another device — so nothing was moved. Go back to the floor to see where it stands.',
    operator: 'One of the bills in this move is no longer open (the detail below says which): it was closed or cleared on another device, so nothing was moved. Reload the floor to see where it stands.',
  },
  {
    test: e => hasCode(e, 'pos_part_bill_locked'),
    staff: 'This is a part bill: it can only be paid, or put back on its table\'s bill. Nothing was moved.',
    operator: 'A part bill (dishes split off a table\'s bill to be paid now) is either paid or put back on its table\'s bill. It does not move, no table joins it, none of its dishes move and it is not split again, so nothing was changed. Take payment on it, or put it back.',
  },
  {
    test: e => hasCode(e, 'pos_move_table_missing'),
    staff: 'That table is not on the floor plan any more, so nothing was moved. Go back to the floor and pick another table.',
    operator: 'That table is no longer on this outlet\'s floor plan (it may have been deleted on another device a moment ago), so nothing was moved. Reload the floor and pick another table.',
  },
  {
    test: e => hasCode(e, 'pos_move_same_table'),
    staff: 'This bill is already on that table, so nothing was moved. Pick a different table.',
    operator: 'This bill is already on that table, so nothing was moved. Pick another table to move it to; to bring another table onto this bill, join it instead.',
  },
  {
    test: e => hasCode(e, 'pos_move_table_busy'),
    staff: 'That table already has a bill. Join the two bills instead. Nothing was moved.',
    operator: 'That table already has an open bill, and a table holds one open bill, so this bill was not moved there and nothing was changed. To put both parties on one bill, join the two tables instead; or move this bill to a free table.',
  },
  {
    test: e => hasCode(e, 'pos_table_joined'),
    staff: 'That table is joined to another table\'s bill, so nothing was put on it. Open that bill, or release the table from it first.',
    operator: 'That table is joined to another table\'s bill (its guests are on that bill), so no new bill was opened on it and nothing was moved onto it. Open the bill it is joined to, pick another table, or release the table from that bill first.',
  },
  {
    test: e => hasCode(e, 'pos_join_needs_table'),
    staff: 'A takeaway has no table for another table to join, so nothing was joined. Move it to a table first, then join.',
    operator: 'A takeaway has no table, so there is nothing for another table to join, and nothing was changed. Move the takeaway to a table first, then join the other table to it.',
  },
  {
    test: e => hasCode(e, 'pos_join_already'),
    staff: 'That table is already on this bill. Nothing was changed.',
    operator: 'That table is already on this bill (it is the bill\'s own table, or already joined to it), so nothing was changed.',
  },
  {
    test: e => hasCode(e, 'pos_join_points_held'),
    staff: 'The other table\'s bill has loyalty points taken off it, so nothing was joined. Hand the points back on that bill first, then join.',
    operator: 'The bill on the table being joined has loyalty points redeemed on it, so the tables were not joined and nothing was moved: those points were redeemed for that bill alone. Open that bill and hand the points back, join the tables, then redeem again when the joined bill is paid.',
  },
  {
    test: e => hasCode(e, 'pos_move_points_held'),
    staff: 'This bill has loyalty points taken off it, so nothing was moved. Hand the points back first, then try again.',
    operator: 'This bill has loyalty points redeemed on it, so its dishes were not moved or split and nothing was changed: the points were redeemed against the whole bill. Hand the points back on this bill, make the move or the split, then redeem again when it is paid.',
  },
  {
    test: e => hasCode(e, 'pos_move_nothing'),
    staff: 'Pick at least one dish to move, each once, with how many of it. Nothing was moved.',
    operator: 'No dish was picked, or one was picked twice, so nothing was moved. Pick each dish to move once, with how many of it to move.',
  },
  {
    test: e => hasCode(e, 'pos_move_line_missing'),
    staff: 'A dish you picked is no longer on this bill — it changed on another device. Nothing was moved: reload the bill and try again.',
    operator: 'A dish picked to move is no longer on this bill: the bill changed on another device, so nothing was moved. Reload the bill and pick the dishes again.',
  },
  {
    test: e => hasCode(e, 'pos_move_line_comped'),
    staff: 'A complimentary dish stays on its own bill, so nothing was moved. Leave it out and move the rest.',
    operator: 'A complimentary dish stays on the bill it was given on, so nothing was moved (the detail below names the dish). Leave it out of the move and move the rest.',
  },
  {
    test: e => hasCode(e, 'pos_move_qty_invalid'),
    staff: 'You can move from 1 up to as many of a dish as the bill has. Nothing was moved — check how many and try again.',
    operator: 'A dish can be moved from 1 up to as many as the bill holds (the detail below names the dish and the most), so nothing was moved. Correct the number and move it again.',
  },
  {
    test: e => hasCode(e, 'pos_move_all_lines'),
    staff: 'That is every dish on this bill, so nothing was moved. Use Move to move the whole bill.',
    operator: 'Those are all the dishes on this bill (a complimentary dish left behind does not count), so nothing was moved. Use Move to move the whole bill: it keeps its number and its kitchen tickets together.',
  },
  {
    test: e => hasCode(e, 'pos_part_all_lines'),
    staff: 'That is the whole bill, so nothing was split off. Take payment on the bill itself.',
    operator: 'Those are all the dishes on this bill (a complimentary dish left behind does not count), so no part bill was made and nothing was changed. Take payment on the bill itself.',
  },
  {
    test: e => hasCode(e, 'pos_move_same_bill'),
    staff: 'That table is on this same bill, so nothing was moved. Pick a free table, or one with another bill.',
    operator: 'That table is on this same bill (it is the bill\'s own table, or joined to it), so nothing was moved. Pick a free table, or one with another bill.',
  },
  {
    test: e => hasCode(e, 'pos_move_retry'),
    staff: 'A table in this move changed on another device just now, so nothing was moved. Try again.',
    operator: 'A table or bill in this move changed on another device at the same moment, so nothing was moved rather than act on the old picture. Try again; if it is refused again, reload the floor first.',
  },
  {
    test: e => hasCode(e, 'pos_part_delivery'),
    staff: 'A delivery platform\'s order is paid as one bill, so it cannot be split. Nothing was changed.',
    operator: 'A delivery platform\'s order is paid, and settled with the platform, as one bill, so it cannot be split into part bills and nothing was changed.',
  },
  {
    test: e => hasCode(e, 'pos_part_parent_closed'),
    staff: 'The table\'s bill is already closed, so this part bill cannot go back on it. Nothing was moved — take payment on this part bill instead.',
    operator: 'The bill this part bill was split from is already closed, so there is nothing to put it back on, and nothing was moved. Take payment on the part bill itself.',
  },
  {
    test: e => hasCode(e, 'pos_part_bill_has_tickets'),
    staff: 'This part bill sent food of its own to the kitchen, so it cannot be put back. Nothing was moved — take payment on it instead.',
    operator: 'This part bill sent food of its own to the kitchen or bar, so it has kitchen tickets of its own and is paid on its own; nothing was moved. Take payment on it.',
  },
  {
    test: e => hasCode(e, 'pos_part_not_part'),
    staff: 'This bill was not split off another bill, so there is nothing to put it back on. Nothing was changed.',
    operator: 'This bill was not split off another bill, so putting it back does not apply and nothing was changed. Reload the bill to see where it stands.',
  },
  {
    test: e => hasCode(e, 'pos_release_not_joined'),
    staff: 'That table is not joined to a bill any more — it may have been released on another device. Nothing was changed: go back to the floor.',
    operator: 'That table is no longer joined to a bill (it was released, or its bill closed, on another device a moment ago), so nothing was changed. Reload the floor to see where it stands.',
  },
  {
    test: e => hasCode(e, 'pos_table_move_direct'),
    staff: 'A table move is recorded by the move itself, so it cannot be written, changed or deleted here. Nothing was changed.',
    operator: 'The record of table moves (which bill or dish moved, between which tables, who moved it and when) is written only by the move itself, so it cannot be added, edited or deleted directly. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'pos_table_join_direct'),
    staff: 'Tables are joined and released from the order screen. Nothing was changed.',
    operator: 'A join is written only by joining or releasing a table on the order screen, so it cannot be added, edited or deleted directly. Nothing was changed.',
  },
  // S755 (migration 20260917100000). Both are raised by a trigger in the statement that wrote, so
  // the statement rolled back and each may say this write did not land.
  // S835 (migration 20261014110000, D23's server half): pos_reservations_guard_no_show, raised before
  // the update, so the booking is unchanged. The page offers No-show only from the booked time; a
  // tablet whose clock runs ahead meets this.
  {
    test: e => hasCode(e, 'reservation_no_show_early'),
    staff: 'That booking\'s time has not come yet, so it was not marked a no-show. The booking is unchanged. If the guest called to say they are not coming, Cancel it instead.',
    operator: 'That booking\'s time has not come yet, so it was not marked a no-show — the booking is unchanged. A party is a no-show only once its booked time has passed. If the guest said they will not come, Cancel it instead; if this tablet\'s clock is ahead, check its time.',
  },
  {
    // guard_pos_reservation_table_hold. ReservationModal and PosReservations word it themselves
    // from the structured DETAIL (reservationConflicts.describeHoldRefusal); this is the fallback.
    test: e => hasCode(e, 'table_hold_overlap'),
    staff: 'That table is already booked for an overlapping time — probably on another device a moment ago. This change was not saved; refresh the list, then pick another table or change the time.',
    operator: 'Another live booking holds one of these tables at an overlapping time (named in the detail below), so this change was refused rather than double-book the table. Refresh the list, then pick another table or move one of the bookings.',
  },
  {
    // guard_pos_credit_note's amount check. The modal computes the note from the bill's lines; a
    // mismatch means the lines, the discount or the VAT setting it read are not what the bill was
    // charged with — never something a retry fixes. Since S809 1l (GAP-OPERATOR-1) it refuses Crest
    // support's screen too, so the VAT-change sentence no longer sends the reader to a screen that
    // would issue the wrong note: support issues it with the bill's own amounts, which the check passes.
    test: e => hasCode(e, 'credit_note_amounts'),
    staff: 'The amounts on this Credit Note do not match the bill, so no note was issued. Close this, reload the bill and try again — tell your manager if it happens again.',
    operator: 'The Credit Note’s amounts do not match the bill it credits (both sets are in the detail below), so no note was issued and nothing was numbered. A note credits exactly what the bill charged: reload the bill and issue it again. If the outlet’s VAT registration changed since the bill was printed, the Credit Note screen works the note out under today’s VAT setting, so it is refused from every login, Crest support’s included — contact Crest support, who can issue it with the bill’s own VAT.',
  },
  // S809 1d (migration 20261009120000): the kitchen-ticket log and the pulled-item record. Each is
  // raised by a BEFORE trigger, so the statement rolled back and each may say nothing was changed.
  // No screen writes any of these on purpose; they are what a stale tablet or a hand-made request
  // meets.
  {
    test: e => hasCode(e, 'pos_kot_ticket_locked'),
    staff: 'A kitchen ticket cannot be deleted or edited once it is sent — only moved along on the Kitchen Display. Nothing was changed.',
    operator: 'A kitchen ticket is the record of what went to the kitchen or bar, so it cannot be deleted or edited — only its stage (started, ready, served) moves. An order with a ticket cannot be deleted either. Nothing was changed: to stop an order, void it; to take a dish off, remove it on the order screen, which records who pulled it.',
  },
  {
    test: e => hasCode(e, 'pos_kot_other_outlet'),
    staff: 'That ticket is for an order at another outlet, so it was not logged. Go back to the floor and open the table again.',
    operator: 'A kitchen ticket can only be logged against an order of this outlet, and this one named another outlet’s order, so it was not logged. Reload the order screen; if it happens again, the till is signed in to a different outlet than the order it shows.',
  },
  {
    test: e => hasCode(e, 'pos_kot_cancel_rank'),
    staff: 'Only a supervisor can cancel a kitchen ticket. Nothing was changed — to stop the food, a supervisor voids the order.',
    operator: 'A kitchen ticket is cancelled when its order is voided, or by a POS supervisor or above, and this login is neither — so the ticket was left as it was.',
  },
  // S809 3d (migration 20261010130000): a kitchen login's Clear is checked against the ORDER, not the
  // board. Raised by the BEFORE trigger, so nothing changed.
  {
    test: e => hasCode(e, 'pos_kot_clear_food_left'),
    staff: 'The order still has some of the food on this ticket, so it was not cleared. Nothing was changed — make what is still ordered, or ask a supervisor to clear it.',
    operator: 'The kitchen can clear a ticket only once every dish on it has been taken off the order, and this order still holds some of what the ticket carries (or food that never reached a ticket), so nothing was changed. Check the order on the till: take the dish off there with a reason, or clear the ticket with a supervisor login.',
  },
  {
    test: e => hasCode(e, 'pos_kot_status_backwards'),
    staff: 'A kitchen ticket only moves forward, and a cancelled one stays cancelled. Nothing was changed — reload the screen.',
    operator: 'A kitchen ticket only moves forward (new → started → ready → served), and a cancelled one stays cancelled, so this change was refused. Reload to see where it stands; if the dish has to be made again, send it again from the order screen.',
  },
  {
    test: e => hasCode(e, 'pos_kot_removal_direct'),
    staff: 'A pulled-item record is written by the order screen when a sent dish is taken off. Nothing was recorded.',
    operator: 'A pulled-item record is written by the order screen itself when a dish that was already sent comes off the bill — with the login, the time and the reason — so it cannot be added, edited or deleted directly. Nothing was recorded.',
  },
  {
    test: e => hasCode(e, 'pos_item_sent_lowered'),
    staff: 'A dish already sent to the kitchen cannot be marked as not sent. Nothing was changed — to take it off, remove it on the order screen and give a reason.',
    operator: 'A dish already sent to the kitchen or bar cannot be marked as not sent, so nothing was changed. To take it off the bill, remove it on the order screen: that records who pulled it and why under KOT Log → Pulled Items.',
  },
  {
    test: e => hasCode(e, 'pos_tables_rank'),
    staff: 'Only the owner or a POS manager can add, rename, move or delete tables, or take one out of service or back. Nothing was changed.',
    operator: 'Only the Owner or a POS manager can add, rename, move or delete tables, or take one out of service or bring it back, so nothing was changed. Marking a table occupied or free from the floor is unaffected.',
  },
  // S809 3b (migration 20261010120000): guard_pos_guest_order_request, a BEFORE UPDATE trigger, so the
  // statement rolled back and each may say nothing was changed. The till writes an answer only while a
  // guest order still waits, so it meets none of these in normal service; they are what an older till
  // (a second answer to the same order) or a hand-made request meets.
  {
    test: e => hasCode(e, 'pos_guest_order_decided'),
    staff: 'That guest order was already answered on another till, so nothing was changed. Check this table’s order before you send anything.',
    operator: 'This guest QR order was already accepted or turned away. A guest order is answered once and that answer stands, so nothing was changed. If it was turned away by mistake, add the dishes on the till, or ask the guest to send it again.',
  },
  {
    test: e => hasCode(e, 'pos_guest_order_frozen'),
    staff: 'A guest’s QR order can’t be changed once it is sent — staff only accept it or turn it away. Nothing was changed.',
    operator: 'A guest’s QR order stays exactly as the guest sent it — dishes, table, covers and note — so this change was refused and nothing was changed. Accept it and change the order on the till, or turn it away.',
  },
  {
    test: e => hasCode(e, 'pos_guest_order_other_outlet'),
    staff: 'That guest order belongs to another outlet’s table, so it was not added to this bill. Go back to the floor and open the table again.',
    operator: 'A guest QR order can only go onto a bill of its own outlet, and this one named another outlet’s bill, so nothing was changed. Reload the till; if it happens again, the till is signed in to a different outlet than the table it shows.',
  },
  {
    test: e => hasCode(e, 'pos_setup_rank'),
    staff: 'Only the owner or a POS manager can change the till setup. Nothing was saved.',
    operator: 'Only the Owner or a POS manager can change the till setup (the setting is named in the detail below), so nothing was saved.',
  },
  // S809 ACCESS-4 (20261009130000): a till PIN login stays at its own outlet. Both raised before the
  // function writes anything, so each may say nothing changed. Ahead of the generic 42501 sentence.
  {
    test: e => hasCode(e, 'pos_pin_outlet_pinned'),
    staff: 'A till PIN works only at its own outlet, so this login cannot switch to another one. Nothing was changed.',
    operator: 'A till PIN login works only at the outlet whose tablets it signs in on, so it cannot switch outlet and nothing was changed. Someone who also works at another outlet needs a PIN login there: add them under that outlet’s POS Staff.',
  },
  {
    test: e => hasCode(e, 'outlet_access_pin_login'),
    staff: 'A till PIN works only at its own outlet, so it cannot be given another one. Nothing was saved.',
    operator: 'A till PIN login works only at its own outlet, so it cannot be given another one here and nothing was saved. If this person also works at another outlet, add them under that outlet’s POS Staff with a PIN of their own.',
  },
  {
    test: e => hasCode(e, 'invoice_settings_rank'),
    staff: 'Only the owner can change the invoice and VAT details printed on bills. Nothing was saved.',
    operator: 'Only the Owner can change the invoice and VAT details printed on bills, so nothing was saved. They are read when any bill or Credit Note is printed — reprints of old ones included — which is why they are fenced.',
  },
  // S767 (20260921100000): the restaurant's name and logo on its guest QR menu.
  {
    test: e => hasCode(e, 'guest_menu_brand_rank'),
    staff: 'Only the owner can change the restaurant name and logo guests see. Nothing was saved.',
    operator: 'Only the account Owner can change the restaurant name and logo on the guest menu, so nothing was saved. They are what every guest sees at the top of every table’s QR menu.',
  },
  // S786 (20260923130000): the outlet's weather city, and the Owner's rainy-day sales figure.
  {
    test: e => hasCode(e, 'weather_city_rank'),
    staff: 'Only the owner or a manager can change the weather city. Nothing was saved.',
    operator: 'Only the Owner or a manager (POS, HR or Inventory) can change the outlet’s weather city, so nothing was saved.',
  },
  {
    test: e => hasCode(e, 'weather_rain_rank'),
    staff: 'Only the owner can change how rain affects the sales forecast. Nothing was saved.',
    operator: 'Only the account Owner can change how rain affects the sales forecast, so nothing was saved.',
  },
  {
    test: e => hasCode(e, 'loyalty_enrol_rank'),
    staff: 'Only the owner or a POS manager can enrol a customer in a loyalty scheme. Nothing was changed.',
    operator: 'Only the Owner or a POS manager can enrol a customer in a loyalty scheme or take them out of one, so the enrolment was not changed.',
  },
  {
    test: e => hasCode(e, 'loyalty_rank'),
    staff: 'Only the owner or a POS manager can change loyalty schemes. Nothing was changed.',
    operator: 'Only the Owner or a POS manager can create, change or delete a loyalty scheme, so nothing was changed.',
  },
  // S809 1i (migration 20261009150000): the points line on a bill and the customer book. Raised by
  // the payment-line statement trigger and a BEFORE row trigger on pos_customers, inside the
  // statement, so each may say nothing was changed. No screen reaches them; a REST write does.
  {
    test: e => hasCode(e, 'pos_payment_line_locked'),
    staff: 'Payment lines are written by the till itself, so they cannot be changed or removed by hand. Nothing was changed — to take points off this bill, press Undo on the points in the payment window.',
    operator: 'A bill’s payment lines are written only by the till — the points line when points are redeemed, the rest as the bill closes — so they cannot be edited or deleted by hand, and nothing was changed. To take points off an open bill, press Undo on the points in the payment window, which also gives the customer their points back.',
  },
  {
    test: e => hasCode(e, 'pos_customer_has_points_history'),
    staff: 'This customer has a loyalty points history, so they cannot be deleted. Nothing was changed.',
    operator: 'This customer has a loyalty points history — every point earned and spent, and which bills spent them — so the customer cannot be deleted and nothing was changed. To stop them earning points, take them off their scheme in Customers → Loyalty instead.',
  },
  {
    test: e => hasCode(e, 'pos_customer_delete_rank'),
    staff: 'Only the owner or a POS manager can remove a customer who is in a loyalty scheme. Nothing was changed.',
    operator: 'This customer is enrolled in a loyalty scheme, and only the Owner or a POS manager can take a customer out of one, so the customer was not deleted.',
  },
  {
    test: e => hasCode(e, 'pos_customer_phone_locked'),
    staff: 'A customer’s phone number cannot be changed, because their points belong to that number. Nothing was changed. A new number becomes a new customer the first time a bill is closed with it; the owner or a POS manager can move the points to it with Move to a new number.',
    operator: 'A customer’s phone number is what their loyalty points and bill history belong to, so it cannot be changed, and nothing was changed. A customer on a new number becomes a new record the first time a bill is closed with it. To take their points there, use Move to a new number (the ⋯ on their row in Customers → Loyalty): the points move in one step, with the reason kept on both numbers.',
  },
  // S809 1k (migration 20261009170000). Raised by BEFORE triggers on pos_parking_slips and
  // pos_payment_confirmations, so the statement rolled back and each may say nothing was changed.
  // Issuing a slip and linking its bill reach the New Parking Slip window (staff copy, after "No slip
  // was printed."); the others are reached only over REST or by a sweep that words its own refusal.
  {
    test: e => hasCode(e, 'pos_parking_slip_rank'),
    staff: 'Issuing a parking slip needs a supervisor or the owner — ask one to issue it.',
    operator: 'Issuing a parking slip needs a POS supervisor, a POS manager or the Owner, so no slip was issued. Raise this login’s rank on POS Staff if this person should issue slips.',
  },
  {
    test: e => hasCode(e, 'pos_parking_slip_bill'),
    staff: 'That bill is not one of this outlet’s bills, so the slip was not issued. Pick the bill again from today’s list, or issue the slip without one.',
    operator: 'A parking slip can only be linked to a bill of this outlet, and that one is not, so no slip was issued. Pick the bill from today’s list, or issue the slip without a bill.',
  },
  {
    test: e => hasCode(e, 'pos_parking_slip_locked'),
    staff: 'An issued parking slip cannot be changed — it can only be printed again or marked exited. Nothing was changed.',
    operator: 'An issued parking slip is the guest’s claim ticket, so its number, vehicle, times and names cannot be changed — it can only be reprinted or marked exited. Nothing was changed. If it is wrong, mark it exited and issue a new slip.',
  },
  {
    test: e => hasCode(e, 'pos_parking_slip_closed'),
    staff: 'This parking slip is already closed, and a closed slip cannot be reopened. Nothing was changed.',
    operator: 'A closed parking slip stays closed, so it was not reopened and nothing was changed. If the vehicle is still in the car park, issue a new slip for it.',
  },
  {
    test: e => hasCode(e, 'pos_parking_slip_not_stale'),
    staff: 'Only a slip from an earlier day closes on its own. Mark this vehicle exited instead. Nothing was changed.',
    operator: 'Only a slip from before 6 AM today (Nepal time) is closed automatically, so this one was not, and nothing was changed. Mark the vehicle exited instead, which records who confirmed it left.',
  },
  {
    test: e => hasCode(e, 'pos_payment_confirmation_locked'),
    staff: 'A payment confirmation comes from the payment provider and cannot be changed here. Nothing was changed.',
    operator: 'A QR payment confirmation is written by the payment provider. The till can only mark it used, once, after the bill it paid is closed, so nothing was changed.',
  },
  // rank_required is one hint for several rank refusals; the recipe price guard and the loyalty
  // award have consequences worth naming, the rest share the generic sentence.
  {
    test: e => hasCode(e, 'rank_required') && onTable(e, 'recipes'),
    staff: 'Only a manager or the owner can change a menu price, its VAT rate or whether a dish is on the POS menu. Nothing was saved.',
    operator: 'A menu price, its VAT rate and whether a dish is on the POS menu are set by a manager or the Owner, so this save was refused and nothing was changed. Ask one to change it in Menu Pricing.',
  },
  {
    test: e => hasCode(e, 'rank_required') && /person who closed it/i.test(e.message || ''),
    staff: 'Points for a bill are added by whoever closed it, as it closes. The bill itself is fine — the owner or a POS manager can add the points in Customers → Loyalty.',
    operator: 'Loyalty points for a bill are added by the person who closed it as it closes, or later by the Owner or a POS manager, so none were added from this login. The bill is unaffected; the Owner or a POS manager adds them from the customer’s History in Customers → Loyalty.',
  },
  // post_waiting_pos_bills (S830 5f-2): the Owner and Crest support post any month, a POS manager the
  // open one. Refused before anything was posted.
  {
    test: e => hasCode(e, 'rank_required') && /post_waiting_pos_bills/.test(e.message || ''),
    staff: 'Waiting bills are posted to Inventory by the owner, or by a POS manager while their month is open. Nothing was posted — ask one of them.',
    operator: 'Waiting till bills are posted to Inventory by the Owner, or by a POS manager of this outlet while their month is still open, so nothing was posted from this login. A closed month’s bills are the Owner’s to post, from Periods.',
  },
  // post_waiting_credit_notes (S832 5f-4): the same people, the same rule, for waiting credit notes.
  {
    test: e => hasCode(e, 'rank_required') && /post_waiting_credit_notes/.test(e.message || ''),
    staff: 'Waiting credit notes are posted to Inventory by the owner, or by a POS manager while their month is open. Nothing was posted — ask one of them.',
    operator: 'Waiting credit notes are posted to Inventory by the Owner, or by a POS manager of this outlet while their month is still open, so nothing was posted from this login. A closed month’s notes are the Owner’s to post, from Periods.',
  },
  {
    test: e => hasCode(e, 'rank_required'),
    staff: 'Your login does not have the rank for that. Nothing was changed — ask a supervisor or manager.',
    operator: 'This login’s POS rank is too low for that (the rank it needs is in the detail below), so nothing was changed. Raise it on POS Staff if this person should be able to.',
  },

  // The submit_my_* RPCs raise this literal when profiles.hr_self_service is off or unlinked.
  {
    test: e => /not authorized/i.test(e.message || ''),
    staff: "Your self-service access isn't set up. Ask your manager to check it.",
    operator: "That account isn't authorized for this action.",
  },

  // The section-scope lock on closing_stock (S737). Ahead of the generic RLS rule below because
  // that one can only say "you're not allowed" — true, but it sends a counter to their manager to
  // ask about a permission when the real answer is that this item belongs to someone else's
  // section, or to nobody's. An RLS refusal carries no policy name, so the table is the only
  // thing to key on; every other write to closing_stock goes through the same page.
  {
    test: e => /row-level security|violates row-level/i.test(e.message || '') && /closing_stock/i.test(e.message || ''),
    staff: 'That item is not in a section you have been given to count, so it was not saved. Ask your manager which sections are yours.',
    operator: 'This account is limited to its assigned sections and that item is in another one — or in no category at all, which cannot be assigned. Nothing was saved. Change it in Stock Count → Settings → Who counts what, or file the item into a category in Item Master.',
  },

  // S752 rank refusals raised with ERRCODE 42501 — ahead of the generic permission rule, which
  // could only say "you're not allowed" without saying who is.
  {
    test: e => /staff_roles_rank/i.test(e.message || ''),
    staff: 'Only the owner or a manager can change the role list. Nothing was changed.',
    operator: 'Only the Owner, or a manager of that module, can change its role list, so nothing was saved. The list decides every login\'s access level, which is why it is fenced.',
  },
  {
    test: e => /tada_settings_rank/i.test(e.message || ''),
    staff: 'Only the owner or an HR manager can change the travel claim settings. Nothing was changed.',
    operator: 'Only the Owner or an HR manager can change the travel claim settings (per-km rates, purposes, start points), so nothing was saved.',
  },
  {
    test: e => /payroll_rank/i.test(e.message || ''),
    staff: 'Only the owner or an HR manager can finalize or reopen payroll. Nothing was changed.',
    operator: 'Finalizing or reopening payroll needs the Owner or an HR manager, so nothing was changed.',
  },
  {
    test: e => /salary_payment_rank/i.test(e.message || ''),
    staff: 'Only the owner or an HR manager can mark salaries paid. Nothing was changed.',
    operator: 'Marking salaries paid, or undoing a payment, needs the Owner or an HR manager, so nothing was recorded.',
  },
  {
    test: e => /self_service_blocked/i.test(e.message || ''),
    staff: 'Your access to the Staff app has been turned off. Speak to your manager if you think this is a mistake.',
    operator: 'This employee\'s Staff app access is turned off, so the request was refused. Turn it back on in Employees if they should still use it.',
  },
  {
    test: e => /settlement_rank/i.test(e.message || ''),
    staff: 'Only the owner or an HR manager can do that to a settlement. Nothing was changed.',
    operator: 'Finalizing or reopening a Final Settlement needs the Owner or an HR manager, so nothing was changed.',
  },

  // ── A login tied to its owner's employee record (S798 3f-1, migration 20261003160000, H6) ──────────
  // link_hr_login / unlink_hr_login raise every one of these before they write, in one function call,
  // so "nothing was changed" is true. login_link_rank and login_link_outlet carry 42501, so they sit
  // above the generic 42501 rule.
  {
    test: e => /login_link_rank/i.test(e.message || ''),
    staff: 'Only the Owner links a login to an employee record. Nothing was changed.',
    operator: 'Only the Owner links or unlinks a login, because the link decides whose leave, claims and pay that login may never decide. Nothing was changed.',
  },
  {
    test: e => /login_link_outlet/i.test(e.message || ''),
    staff: 'That employee belongs to another outlet. Nothing was changed.',
    operator: 'That employee record belongs to another outlet. Switch to that outlet, then link the login there. Nothing was changed.',
  },
  {
    test: e => /login_link_not_hr/i.test(e.message || ''),
    staff: 'Only an HR staff login can be linked here. Nothing was changed.',
    operator: 'Only an HR staff login is linked from HR Staff. Nothing was changed.',
  },
  {
    test: e => /login_link_employee_taken/i.test(e.message || ''),
    staff: 'That employee already has an HR login linked. Nothing was changed.',
    operator: 'That employee record already has another HR login linked (named in the line below). One person has one HR login: unlink the other one first. Nothing was changed.',
  },
  {
    test: e => /login_link_taken/i.test(e.message || ''),
    staff: 'That login is already linked to someone else here. Nothing was changed.',
    operator: 'This login is already linked to another employee record at this outlet. Unlink it first, then link it to the right record. Nothing was changed.',
  },
  {
    test: e => /login_link_no_access/i.test(e.message || ''),
    staff: 'That login cannot open this outlet. Nothing was changed.',
    operator: 'This login cannot open this outlet, so it cannot be linked to a record here. Tick this outlet for them in Outlet Access on the Group Console first. Nothing was changed.',
  },
  {
    test: e => /login_link_missing/i.test(e.message || ''),
    staff: 'That login or employee record no longer exists. Reload the page. Nothing was changed.',
    operator: 'That login or employee record no longer exists — someone may have deleted it. Reload the page. Nothing was changed.',
  },

  // ── The IMS guards (S756, migration 20260918100000) ───────────────────────────────────────────
  // Each is raised by a BEFORE trigger on the row it names, so the statement that carried it did
  // not change that row — but a page that writes several tables in a row (a bill, then its
  // payment) may have landed the earlier ones, so none of these claims the whole action is undone.
  // They are raised with ERRCODE 42501, so they must sit ABOVE the generic 42501 rule below: S756
  // appended them after it, and every one of them read "You're not allowed to do that" until S792
  // moved them (STOCK-2). errorText.test.js pins each hint with its real code.
  {
    test: e => hasCode(e, 'period_closed'),
    staff: 'That month is closed, so it cannot be changed from your login. Ask the account owner if something in it needs fixing.',
    operator: 'That month is closed, so this change was refused. Only the account owner (or a Crest operator) can change a closed month — open it from the owner\'s login, fix it there, then Regenerate Snapshot on that month\'s Monthly Report.',
  },
  {
    test: e => hasCode(e, 'period_rank'),
    staff: 'Starting or closing a month needs the account owner or an inventory supervisor. Nothing about the month was changed.',
    operator: 'Only the account owner or an inventory supervisor or manager can start or close a month, and only the owner can reopen or rename one — so the month was not changed.',
  },
  {
    test: e => hasCode(e, 'recipe_delete_rank'),
    staff: 'Deleting a dish needs an inventory manager. Hide it instead, which takes it off the menu and keeps its history.',
    operator: 'Deleting a dish needs an inventory manager or the account owner, so it is still there. Use Hide to take it off the menu and the till — its sales history stays intact.',
  },
  {
    test: e => hasCode(e, 'recipe_hide_rank'),
    staff: 'Hiding or showing a dish needs an inventory supervisor. The dish was not changed.',
    operator: 'Hiding or showing a dish needs an inventory supervisor or manager, so the dish is still in the state it was.',
  },
  {
    test: e => hasCode(e, 'ims_settings_rank'),
    staff: 'The inventory thresholds can only be changed by an inventory manager or the account owner.',
    operator: 'The food-cost and variance thresholds and the code prefixes can only be changed by an inventory manager or the account owner, so they were not changed.',
  },
  {
    test: e => hasCode(e, 'ims_rank'),
    staff: 'Your login does not have the inventory rank for this. Nothing was changed — ask your manager.',
    operator: 'This needs a higher inventory rank than this login has, so it was refused. An inventory manager or the account owner can do it, or raise this login\'s role on IMS Staff.',
  },
  // S792 (migration 20260928140000), by hint. Each carries its own hint rather than 'ims_rank', so
  // their order against the rule above does not matter; being above the generic 42501 rule does.
  {
    test: e => hasCode(e, 'item_unit_locked'),
    staff: 'This item already has purchases or counts recorded in its unit, so the unit cannot change. Nothing was changed — ask your manager.',
    operator: 'This item already has purchases, counts or recipe lines recorded in its unit, so the unit cannot change — every one of them would be re-read in the new unit. Nothing was changed. Hide this item once its stock is used up and create a new one in the new unit.',
  },
  {
    test: e => hasCode(e, 'ims_count_settings_rank'),
    staff: 'Only the owner or an inventory manager can change how stock counts are set up. Nothing was changed.',
    operator: 'Only the account owner or an inventory manager can change section scoping, blind count or recount protection, so they were not changed. These are the switches that fence each counter, which is why they are.',
  },
  {
    test: e => hasCode(e, 'po_receipt_only'),
    staff: 'A received quantity is recorded only by receiving the delivery. Nothing was changed.',
    operator: 'Received quantities and the received status are recorded only by Receive on the order, which books the bill at the same time — so this change was refused and the order is as it was.',
  },
  {
    test: e => hasCode(e, 'snapshot_frozen'),
    staff: 'This month\'s target is already set. Nothing was changed.',
    operator: 'This month\'s dashboard target is already set, and only a newer forecast version can replace it, so it was left as it was.',
  },
  // S792 stage 3 (migration 20260928180000). Not 42501, so their place against the rule below does
  // not matter; being above the generic 23514 constraint rule at the end does. The trigger's message
  // names the two dishes, and it rides along as the fine print.
  {
    test: e => hasCode(e, 'recipe_cycle'),
    staff: 'That sub-recipe already contains this dish, so it cannot also go inside it. The ingredient list was not saved — ask your manager.',
    operator: 'That sub-recipe already contains this dish, directly or through another sub-recipe, so adding it here would make each an ingredient of the other and its cost could never be worked out. The ingredient list was not saved. Remove the line, or take this dish out of that sub-recipe first.',
  },
  {
    test: e => hasCode(e, 'item_other_client'),
    staff: 'That item belongs to another business, so it cannot be used here. Nothing was saved.',
    operator: 'That item belongs to another business on Crest, so this business cannot record it. Nothing was saved. Reload the page and pick the item again from this business\'s own list.',
  },
  // S809 2f (migration 20261009220000, sales_entries_stamp_pos_source): a till bill's sales reach
  // Inventory once, under the closed bill they came from. 23505 / 23514, so being above the generic
  // constraint rules at the end is what matters.
  {
    test: e => hasCode(e, 'pos_bill_already_posted'),
    staff: "This bill's sales are already in Inventory, so they were not added again. Nothing needs doing.",
    operator: "This bill's sales were already in Inventory — another device or Post POS bills got there first — so they were not added a second time, and the bill is marked posted. Nothing needs doing.",
  },
  // S809 3j (migration 20261010140000): a Credit Note's Inventory reversal goes in once, as a bill's
  // sales do. 23505, so above the generic duplicate rule too.
  {
    test: e => hasCode(e, 'pos_credit_note_already_posted'),
    staff: 'This credit note is already taken off Inventory sales, so it was not taken off again. Nothing needs doing.',
    operator: 'This credit note was already taken off Inventory sales — another device, or Post to Inventory on the floor or in Periods, got there first — so it was not taken off a second time, and the note is marked posted. Nothing needs doing.',
  },
  {
    test: e => hasCode(e, 'pos_sale_unlinked'),
    staff: 'This sale did not name the closed bill it came from, so it was not added to Inventory. Tell your manager.',
    operator: "A till sale is added to Inventory under the closed bill it came from, at this outlet, and this one was not, so nothing was added. Post it with Post to Inventory on the POS Orders floor while its month is open in Inventory, or (the Owner) Periods → Post POS bills to Inventory; both post each closed bill from what is stored on it.",
  },
  // S809 2e (migration 20261009210000): a Credit Note's Inventory posting must follow the note's own
  // answer to "was the food served?". Both raised by a BEFORE trigger (42501), so above the generic
  // 42501 rule below; nothing was written.
  {
    test: e => hasCode(e, 'credit_note_restock_mismatch'),
    staff: 'This Credit Note said its food was not served, and this page is older than that, so nothing was posted to Inventory. Reload the page and post it again.',
    operator: 'This Credit Note said its food was not served (billed again, or a duplicate), so posting it to Inventory must also put that food back — and this page is older than that rule. Nothing was posted and the note is still waiting: reload the page, then post it again.',
  },
  {
    test: e => hasCode(e, 'pos_credit_restock_invalid'),
    staff: 'Stock can only be put back by a Credit Note that said its food was not served. Nothing was recorded.',
    operator: 'Food goes back into Inventory only through a Credit Note that said the bill\'s food was not served, and only as stock added back. Nothing was recorded.',
  },
  // S828 5d (migration 20261013140000, ims_sales_entries_guard): a sale in Inventory names only its
  // own record, a till's sales go only to an outlet with Inventory, and a note's reversal only to its
  // own outlet's month. 42501 from a BEFORE trigger, so above the generic 42501 rule; nothing written.
  {
    test: e => hasCode(e, 'sales_entry_link_mismatch'),
    staff: 'This sale named the wrong kind of record, so it was not added to Inventory. Tell your manager.',
    operator: "A sale in Inventory names only its own record (a till sale its bill, a credit note's reversal its note, a hand-entered sale neither), and this one did not, so nothing was recorded. Reload the page and post it again; if it happens again, contact Crest support.",
  },
  {
    test: e => hasCode(e, 'pos_outlet_no_ims'),
    staff: 'This outlet does not use Crest Inventory, so nothing was sent there. Nothing needs doing.',
    operator: 'This outlet does not have Crest Inventory switched on, so its till sales and credit notes are not posted to Inventory and nothing was recorded. They stay in every POS report.',
  },
  {
    test: e => hasCode(e, 'pos_credit_note_other_outlet'),
    staff: "This credit note belongs to another outlet, so it was not taken off this outlet's Inventory sales. Tell your manager.",
    operator: "A credit note's reversal is recorded in its own outlet's Inventory month, and this one named a note of another outlet, so nothing was recorded. Switch to the note's outlet and post it there.",
  },

  // ── S849 (Crest Suite batch). Every rule below is matched by its HINT (each RAISE also leads its
  // message with it), and every one is raised before the statement or function writes anything, in
  // one transaction, so "nothing was …" is true of each. They sit ABOVE the generic 42501 rule and
  // every generic FK / constraint rule further down, which would otherwise answer first.
  // errorText.s849.test.js pins each code with its real errcode.

  // A record pointing at another business's record (DATABASE-3, 20261019100000; 23503).
  {
    test: e => hasCode(e, 'suite_other_client'),
    staff: 'That record belongs to another business, so it was not saved.',
    operator: 'That record belongs to another business, so it was not saved. Reload the page and pick it again from this business\'s own list.',
  },
  // The Monthly Owner Report is frozen by the database (OR-4, 20261019100100).
  {
    test: e => hasCode(e, 'owner_report_locked'),
    staff: 'This report was not changed: a frozen report can only be regenerated, never edited or deleted.',
    operator: 'This report was not changed: a frozen report can only be regenerated, never edited or deleted.',
  },
  {
    test: e => hasCode(e, 'owner_report_owner_only'),
    staff: 'Only the Owner or Crest support can make or regenerate this report.',
    operator: 'Only the Owner or Crest support can make or regenerate this report.',
  },
  {
    test: e => hasCode(e, 'owner_report_period_open'),
    staff: 'No report was made: the month is still open. It is made when the month is closed.',
    operator: 'No report was made: the month is still open. It is made when the month is closed.',
  },
  {
    test: e => hasCode(e, 'owner_report_other_client'),
    staff: 'No report was made: that month belongs to another outlet. Reload the page and pick the month again.',
    operator: 'No report was made: that month belongs to another outlet. Reload the page and pick the month again.',
  },
  // The dashboard's monthly target is captured only by the Owner's, the operator's or an IMS login's
  // dashboard (OD DATABASE-8, 20261019100200). Its sibling snapshot_frozen is further up.
  {
    test: e => hasCode(e, 'snapshot_rank'),
    staff: 'This month\'s target is set from the account owner\'s or an inventory login\'s dashboard, so nothing was changed. Nothing needs doing.',
    operator: 'This month\'s dashboard target is captured only from the account owner\'s, Crest support\'s or an IMS login\'s dashboard (never a till or count PIN), so it was left as it was. Nothing needs doing.',
  },
  // Multi-outlet (GROUP, 20261019100500).
  {
    test: e => hasCode(e, 'group_hq_outside'),
    staff: 'This group\'s HQ outlet is no longer in the group, so nothing was pushed. Ask the account owner to contact Crest support.',
    operator: 'This group\'s HQ outlet is no longer in the group, so nothing was pushed. Ask Crest support to set a new HQ outlet.',
  },
  {
    test: e => hasCode(e, 'ims_count_pin_outlet_pinned'),
    staff: 'A stock-count PIN works only at its own outlet, so this login cannot switch to another one. Nothing was changed.',
    operator: 'A stock-count PIN login works only at its own outlet, so it cannot switch to another one and nothing was changed. Someone who also counts at another outlet needs a count PIN there, from that outlet\'s Stock Count → Settings.',
  },
  {
    test: e => hasCode(e, 'outlet_access_count_pin'),
    staff: 'A stock-count PIN works only at its own outlet, so it cannot be given another one. Nothing was saved.',
    operator: 'A stock-count PIN login works only on its own outlet\'s tablets, so it cannot be given another outlet and nothing was saved. Give the person a count PIN at the other outlet too, from its Stock Count → Settings.',
  },
  {
    test: e => hasCode(e, 'outlet_access_self_service'),
    staff: 'A Crest Staff self-service login works only at its own outlet, so it cannot be given another one. Nothing was saved.',
    operator: 'A Crest Staff self-service login works only at its own outlet, so it cannot be given another one. Nothing was saved.',
  },
  // Crest support reading a group by id (ACCESS-8 support view): get_group_summary,
  // get_group_item_prices, get_group_outlet_access, get_group_pnl and get_group_labour_inputs all raise
  // this one sentence for an unknown group id.
  {
    test: e => e.code === 'P0002' && /outlet group does not exist/i.test(e.message || ''),
    staff: 'That outlet group no longer exists. Reload the page.',
    operator: 'That outlet group no longer exists. Reload Admin → Clients.',
  },
  // Stock transfers between outlets of a group (PNL-8, 20261019100400). The 42501 and 23503 ones must
  // stay above the generic rules below; the 22023 ones need no particular place but live together.
  {
    test: e => hasCode(e, 'stock_transfer_rank'),
    staff: 'Only an Inventory supervisor or manager of the outlet, or the Owner, can do that. Nothing was changed.',
    operator: 'This login can\'t do that. Stock is sent by the sending outlet\'s Inventory supervisor or manager, received or refused by the receiving outlet\'s, and cancelled by the sending outlet\'s manager — or by the Owner of the group. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_not_sibling'),
    staff: 'Stock can only be sent to another outlet in your group. Nothing was sent.',
    operator: 'Stock can only move between two different outlets of the same group, and this login must belong to that group. Nothing was sent.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_rpc_only'),
    staff: 'Stock transfers are recorded only from Stock Transfers. Nothing was saved.',
    operator: 'Stock transfer records are written only by Stock Transfers (send, receive, cancel, refuse) and the operator\'s restore. Nothing was saved.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_period_other_client'),
    staff: "That didn't work. Nothing was saved.",
    operator: 'A stock transfer line named a month of another outlet, so it was refused. Nothing was saved. If this came from a restore, the backup\'s months and lines belong to different outlets.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_no_inventory'),
    staff: 'Both outlets need Crest Inventory to move stock between them. Nothing was sent.',
    operator: 'Both outlets need Crest Inventory switched on to move stock between them. Nothing was sent.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_no_open_period'),
    staff: 'That outlet has no open month in Inventory, so the stock can\'t be recorded there yet. Nothing was changed — ask your manager to open the month.',
    operator: 'That outlet has no open month in Inventory (its name is in the detail below), so the stock can\'t be recorded there. Nothing was changed. Open the month in Periods, then try again.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_month_ahead'),
    staff: 'That outlet\'s open month hasn\'t started yet, so today\'s stock can\'t go in it. Nothing was changed.',
    operator: 'That outlet has opened a month that hasn\'t started yet, so stock moved today can\'t be recorded in it. Nothing was changed. Try again once the month begins.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_empty'),
    staff: 'Add at least one item to send. Nothing was sent.',
    operator: 'Add at least one item to send. Nothing was sent.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_too_many_lines'),
    staff: 'A transfer can hold at most 500 lines. Send it as two transfers. Nothing was sent.',
    operator: 'A transfer can hold at most 500 lines (the detail says how many this one had). Split it into two transfers. Nothing was sent.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_item_hidden'),
    staff: 'An item on this transfer is hidden at the sending outlet, so the stock can\'t go back onto it yet. Ask the sending outlet to show the item in Item Master, then try again. Nothing was changed.',
    operator: 'The stock would go back onto an item that is hidden at the sending outlet (named in the detail), where Stock Count could never count it. Nothing was changed. Show the item again in that outlet\'s Item Master, then cancel or refuse again.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_lines_bad'),
    staff: 'Some lines can\'t be sent. Press Preview to see which and why. Nothing was sent.',
    operator: 'Some lines can\'t be sent (no matching item at the other outlet, a different unit, a prep item or no price). Press Preview to see each reason. Nothing was sent.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_bad'),
    staff: 'That request was incomplete. Reload Stock Transfers and try again. Nothing was changed.',
    operator: 'The request was incomplete or reused an old transfer number. Reload Stock Transfers and try again. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_not_found'),
    staff: 'That transfer is no longer there. Reload Stock Transfers. Nothing was changed.',
    operator: 'That transfer is no longer there. Reload Stock Transfers. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_not_on_the_way'),
    staff: 'That transfer was already received, cancelled or refused, so it can\'t be changed now. Nothing was changed.',
    operator: 'That transfer is no longer on the way — it was already received, cancelled or refused (the detail says which). Nothing was changed. Reload Stock Transfers to see where it stands.',
  },
  // Operator only in practice: every other login is refused with stock_transfer_rank first, because
  // the receiver no longer exists. The staff key still has a sentence, since every rule needs both.
  {
    test: e => hasCode(e, 'stock_transfer_outlet_gone'),
    staff: 'The receiving outlet no longer exists. Ask the sending outlet\'s manager to cancel this transfer.',
    operator: 'The receiving outlet no longer exists, so this transfer can only be cancelled, which puts the stock back on the sending outlet\'s books. Nothing was received.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_receiver_behind'),
    staff: 'Your outlet is still on an earlier month than the one this stock was sent in. Close that month first, then press Received. Nothing was received.',
    operator: 'The receiving outlet\'s open month is earlier than the month the stock was sent in, so receiving now would count it there before it left. Close that month in Periods, then press Received. Nothing was received.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_sender_behind'),
    staff: 'The sending outlet has an earlier month open than the one the stock was sent in, so the stock can\'t go back yet. Nothing was changed.',
    operator: 'The sending outlet has reopened an earlier month than the one the stock was sent in, so the stock can\'t be put back yet. Nothing was changed. Close that month again (so the later month is open), then try again.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_item_changed'),
    staff: 'An item on this transfer has changed at your outlet since it was sent. Refuse the transfer, say why, and ask for it to be sent again. Nothing was received.',
    operator: 'An item on this transfer was hidden, deleted, made a prep item or given a different unit at the receiving outlet since it was sent, so it can\'t be received as it is. Nothing was received. Refuse it with that reason and send it again.',
  },
  {
    test: e => hasCode(e, 'stock_transfer_reason'),
    staff: 'Say why in a few words. Nothing was changed.',
    operator: 'A reason of at least 3 characters is needed to cancel or refuse a transfer. Nothing was changed.',
  },
  // Demand Forecast's history read (FORECAST-1, 20261019100300): both raised before any write.
  {
    test: e => hasCode(e, 'demand_forecast_forbidden'),
    staff: "You can't rebuild the demand forecast. Ask the Owner or an inventory supervisor or manager. Nothing was changed.",
    operator: 'Only the Owner, or an inventory supervisor or manager of this outlet, can rebuild its demand forecast. Nothing was changed; the forecast below is the last one made.',
  },
  {
    test: e => hasCode(e, 'demand_forecast_range'),
    staff: 'The forecast asked the server for a history length it does not allow, so nothing was rebuilt. Reload the page and try again.',
    operator: 'The forecast asked the server for a history length it does not allow, so nothing was rebuilt. Reload the page and try again.',
  },
  // Fixed Assets (ASSETS, 20261019100600). dep_run_duplicate and ims_rank already have rules.
  {
    test: e => hasCode(e, 'asset_run_posted'),
    staff: 'A posted run cannot be changed or deleted. Nothing was changed.',
    operator: 'A posted depreciation run or tax schedule is final, so it was not changed or deleted. To correct it, post a new run instead.',
  },
  {
    test: e => hasCode(e, 'asset_code_locked'),
    staff: 'Crest numbers each asset itself, and an asset\'s code never changes. Nothing was saved.',
    operator: 'Crest numbers each asset itself, and an asset\'s code never changes once given, so nothing was saved. Describe the asset in its name or notes instead.',
  },
  {
    test: e => hasCode(e, 'asset_other_client'),
    staff: 'That record belongs to another business, so it was not saved.',
    operator: 'That category, asset or run belongs to another business on Crest, so nothing was saved. Reload the page and pick it again from this business\'s own list.',
  },
  {
    test: e => hasCode(e, 'dep_run_asset_not_active'),
    staff: 'An asset in this run is no longer active, so nothing was posted. Reload the page and preview the run again.',
    operator: 'An asset in this run (named in the detail below) is no longer active — disposed, written off or archived since the preview — so nothing was posted. Reload the Depreciation Runs tab and preview again.',
  },
  {
    test: e => hasCode(e, 'tax_run_duplicate'),
    staff: 'This tax schedule was posted moments ago, so it was not posted again.',
    operator: 'This tax pool schedule was posted moments ago — from this page or another tab — so it was not posted a second time. Reload the Tax Depreciation tab to see it.',
  },
  {
    test: e => hasCode(e, 'tax_pool_fy_format'),
    staff: 'The fiscal year must be written like 83/84. Nothing was saved.',
    operator: 'The fiscal year must be written like 83/84 (two short years with a slash), so nothing was saved.',
  },
  {
    test: e => hasCode(e, 'tax_pool_no_lines'),
    staff: 'This tax schedule has no pool lines, so nothing was posted. Preview it again.',
    operator: 'A tax pool schedule needs its pool lines and this one had none, so nothing was posted. Preview the schedule again, then post it.',
  },
  {
    test: e => hasCode(e, 'tax_pool_correction_denied'),
    staff: 'This login cannot correct tax pool opening values. Nothing was changed.',
    operator: 'This login cannot correct this business\'s tax pool opening values, so nothing was changed. An IMS manager or the account owner of this outlet can.',
  },
  {
    test: e => hasCode(e, 'tax_pool_correction_reason'),
    staff: 'Give a reason of 10 to 500 characters. Nothing was changed.',
    operator: 'A correction needs a reason of 10 to 500 characters, which is kept with it. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'tax_pool_correction_values'),
    staff: 'Some of the values were not valid. Nothing was changed.',
    operator: 'Some values were not valid (each of Pool A to D at most once, amounts of 0 or more; the detail below names the problem), so nothing was changed.',
  },
  {
    test: e => hasCode(e, 'tax_pool_correction_unchanged'),
    staff: 'Every value is the one already saved, so nothing was changed.',
    operator: 'Every value sent is the one already saved, so nothing was changed.',
  },
  {
    test: e => hasCode(e, 'tax_pool_opening_unused'),
    staff: 'That year opens from the schedule posted for the year before, so its opening values were not changed.',
    operator: 'That fiscal year opens from the schedule posted for the year before, not from typed values, so nothing was changed. Correct the earlier year\'s schedule instead.',
  },
  {
    test: e => hasCode(e, 'tax_pool_opening_not_locked'),
    staff: 'No posted schedule uses that year yet, so change the values on the card instead. Nothing was changed.',
    operator: 'No posted schedule uses that fiscal year yet, so its opening values are still open: change them on the card instead. Nothing was changed.',
  },
  {
    test: e => hasCode(e, 'tax_pool_opening_year'),
    staff: 'That pool\'s opening value is saved for a different year. Nothing was changed.',
    operator: 'That pool\'s opening value is saved for a different fiscal year (the detail below names both), so nothing was changed.',
  },
  {
    test: e => hasCode(e, 'tax_pool_opening_locked'),
    staff: 'That opening value is locked because a posted schedule carries it forward. Nothing was changed — ask your manager.',
    operator: 'That opening value is locked because a posted schedule carries it forward, so nothing was changed. If it was typed wrong, use Correct these values on the Tax Depreciation tab (a reason is recorded), then post the years it lists again.',
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
  // S756 stage 3 (D14, D11). Each is raised by a BEFORE trigger on the row it names, or by the
  // deferred pair check at commit, which rolls the whole statement back.
  {
    test: e => hasCode(e, 'requisition_rejected'),
    staff: 'This requisition was rejected and can\'t be changed. Raise a new one if the items are still needed.',
    operator: 'This requisition was rejected, so it can\'t be changed, issued or have items added. If the department still needs the items, raise a new requisition.',
  },
  {
    test: e => hasCode(e, 'requisition_not_draft'),
    staff: 'Only a draft requisition can be rejected. This one has already been issued — ask a supervisor.',
    operator: 'Only a draft requisition can be rejected. This one has already been issued, so the stock has left the store — a supervisor can Correct Quantities or delete it instead.',
  },
  {
    test: e => /requisitions_rejected_reason/i.test(e.message || ''),
    staff: 'A rejected requisition needs a reason. Nothing was changed.',
    operator: 'A rejected requisition needs a reason, so nothing was changed. Type why it was rejected and try again.',
  },
  {
    test: e => hasCode(e, 'supplier_credit_unbalanced') || /payable_payments_credit_mode_matches_link|payable_payments_amount_sign/i.test(e.message || ''),
    staff: 'The supplier credit could not be recorded. Nothing was changed — ask your manager.',
    operator: 'The supplier credit was not recorded — its two entries (one on the bill giving the credit, one on the bill using it) must be saved and deleted together, so neither was kept. Reload the page; both bills show their last saved state.',
  },
  // S756 (D26). Raised by save_purchase_bill before it touches a row, so the bill really is as it was.
  {
    test: e => /purchase_bill_has_returns/i.test(e.message || ''),
    staff: 'This bill has goods returned against it, so it cannot be edited. The bill is unchanged — ask your manager.',
    operator: 'This bill has goods returned against it, so it cannot be edited — editing would detach the return and put its amount back on what you owe the supplier. The bill is unchanged. Remove the return on the Returns tab first, edit the bill, then record the return again.',
  },
  {
    test: e => /purchase_entries_discount_nonnegative/i.test(e.message || ''),
    staff: 'A bill discount cannot be below zero. Fix the discount and save again.',
    operator: 'A bill discount cannot be below zero, so the database refused this bill. Fix the discount and save again.',
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

  // The vendors BEFORE DELETE guard (S708), same shape and here for the same two tables Postgres
  // stays silent on: vendor_returns and ims_gate_passes are ON DELETE SET NULL, so the delete used
  // to SUCCEED and strip the supplier off them. Vendors.js pre-checks and words its own refusal, so
  // this fires on the race that pre-check cannot close — a bill entered on another till between the
  // check and the delete — which is why it says the record is new rather than that they misread the
  // page. There is no force-delete to point at: Archive is the way through, and it loses nothing.
  {
    test: e => /vendor_has_references/i.test(e.message || ''),
    staff: 'That supplier now has records against it, so it cannot be deleted. Nothing was removed.',
    operator: 'That supplier has purchases, orders, returns or gate passes recorded against it — possibly entered just now on another device — and deleting it would take that history with it. Nothing was removed. Deactivate it and then archive it: it leaves the Vendors page and every dropdown, and every past record keeps its supplier.',
  },

  // A POS table that has ever taken a QR guest order (S754). pos_guest_order_requests.table_id is
  // a plain FK, so Postgres refuses the delete inside the statement — the table is untouched, and
  // the reservation links that would have cascaded are rolled back with it. Keyed on the child
  // table's name as well as 23503 so no other foreign-key refusal inherits this wording. Inactive
  // is the lossless way through: the floor tile stops opening and the QR stops taking orders.
  {
    test: e => e.code === '23503' && /pos_guest_order_requests/i.test(e.message || ''),
    staff: 'That table has QR guest orders on record, so it cannot be deleted. Ask your manager to mark it Inactive instead.',
    operator: 'This table has taken QR guest orders, which stay on record against it, so it cannot be deleted — retrying will not get past this. Mark it Inactive instead: it can no longer be opened on the Orders floor, its QR stops taking orders, and its history is kept.',
  },

  // The closing_stock recount guard (S737). Names who holds the row and what to do about it,
  // rather than the trigger — the counter's next move is to fetch a supervisor, not to retry.
  // The count itself is safe either way: this is a BEFORE trigger, so nothing was overwritten.
  {
    test: e => /closing_count_locked/i.test(e.message || ''),
    staff: 'Someone else has already counted this item, so your figure did not replace theirs. Choose Add yours if you counted a different place; only a supervisor can replace their count.',
    operator: 'This item was already counted by another staff member and recount protection is on, so nothing was overwritten. A supervisor, manager or Owner can enter the corrected figure — or switch the protection off in Stock Count → Settings.',
  },

  // ── receive_purchase_order (S709) ─────────────────────────────────────────────────────────
  // Every one of these is raised BEFORE or INSIDE the one transaction that writes the bills, the
  // received quantities and the PO's status together — so unlike a dropped fetch, each of them
  // genuinely does prove nothing landed, and saying so is what makes the delivery safe to re-enter.
  // That guarantee is the function's whole reason for existing (the old path wrote the bills first
  // and could stop before the quantities), so these messages are allowed to state it.
  {
    test: e => /po_period_closed/i.test(e.message || ''),
    staff: 'That month is closed, so this delivery cannot be recorded against it. Nothing was received — ask your manager.',
    operator: 'The period this purchase order belongs to is closed, so nothing was received and no stock moved. A Crest operator can enter it into the closed month; otherwise receive the delivery into the open period instead.',
  },
  {
    test: e => /po_not_receivable/i.test(e.message || ''),
    staff: 'This order is already closed off, so nothing more can be received against it. Nothing was received.',
    operator: 'This purchase order is cancelled or already fully received, so nothing was received and no stock moved. Raise a new order for anything still needed from this supplier.',
  },
  {
    test: e => /dep_run_duplicate/i.test(e.message || '') || e.hint === 'dep_run_duplicate',
    staff: 'This depreciation run was posted moments ago, so it was not posted again.',
    operator: 'This depreciation run was posted moments ago — from this page or another tab — so it was not charged a second time. Reload the Depreciation Runs tab to see it.',
  },
  {
    test: e => /po_over_receive/i.test(e.message || ''),
    staff: 'That is more than the order still has outstanding — someone may have received part of it already. Nothing was received; reopen the order to see what is left.',
    operator: 'The quantity entered is more than this order still has outstanding, measured at the moment you confirmed — another device may have received against it since you opened this screen. Nothing was received and no stock moved. Reopen the order; it will show what is genuinely left.',
  },
  {
    test: e => /po_receipt_stale|po_not_found/i.test(e.message || ''),
    staff: 'This order changed while you were receiving it. Nothing was received — reopen it from the list and try again.',
    operator: 'This purchase order changed while the receive screen was open (another user edited, cancelled or deleted it). Nothing was received and no stock moved. Reopen it from the list and try again.',
  },

  // The purchase_orders BEFORE DELETE guard (S709), the third of its kind after items (S707) and
  // vendors (S708). Both refusals are raised by the trigger inside the DELETE statement, so the
  // order is still there, whole.
  {
    test: e => /po_delete_not_permitted/i.test(e.message || ''),
    staff: 'You do not have permission to delete a purchase order. Nothing was removed.',
    operator: 'Only a Crest operator can delete a purchase order. Nothing was removed. Cancel it instead — it stays on the list as a record and can no longer be received against.',
  },
  {
    test: e => /po_has_receipts/i.test(e.message || ''),
    staff: 'Goods have already been received against this order, so it cannot be deleted. Nothing was removed.',
    operator: 'Bills have already been received against this purchase order, and deleting it would cut them loose from the order they came from. Nothing was removed. Cancel the order instead — it keeps the record and stops further receiving — or delete those bills in Purchases first.',
  },

  // ── HR: Roster, Attendance, Leave, Overtime (S749) ──────────────────────────────────────────
  // Every one of these is raised by a BEFORE trigger or inside approve_shift_swap's single
  // transaction, so the record is exactly as it was — which is what lets each of them say so.
  {
    test: e => /hr_month_finalized/i.test(e.message || ''),
    staff: "Payroll for that month has already been finalized, so it can't be changed. Nothing was changed — ask your manager.",
    operator: 'Payroll for that month is finalized and its payslips were built from these records, so nothing was changed. Reopen the payroll run for that month first if it really needs correcting, then finalize it again.',
  },
  // S791 (20260928110000): a finalized Final Settlement paid the leaver's last month, so nothing
  // recorded for that month or a later one would be paid by anything.
  {
    test: e => /hr_month_settled/i.test(e.message || ''),
    staff: "That person's Final Settlement has already paid that month, so it can't be changed. Nothing was changed — ask your manager.",
    operator: "Nothing was changed: this employee's Final Settlement is finalized and already paid their last month (named in the detail below), so overtime or attendance recorded for that month or a later one would never be paid. If they have rejoined, record their new join date on their employee record first; if the settlement was a mistake, reopen it.",
  },
  // ── Payroll money pages (S751, migration 20260914210000) ──────────────────────────────────
  {
    test: e => /hr_run_finalized/i.test(e.message || ''),
    staff: 'That payroll is already finalized, so it cannot be changed. Nothing was changed — ask your manager.',
    operator: 'This payroll run is finalized, so its payslips are locked and nothing was changed. Reopen the run first if it really needs correcting — another tab may have finalized it after this page loaded, so reload to see its real state.',
  },
  {
    test: e => /period_has_finalized_payroll/i.test(e.message || ''),
    staff: 'That month has finalized payroll, so it cannot be deleted. Nothing was changed.',
    operator: 'That month has a finalized payroll run, and deleting the month would erase its payslips — so it was not deleted.',
  },
  {
    test: e => /bonus_finalized/i.test(e.message || ''),
    staff: 'That run is already finalized, so it cannot be changed. Nothing was changed.',
    operator: 'This run is finalized, so its amounts are locked and nothing was changed. Reopen it first if it needs correcting — another tab may have finalized it after this page loaded, so reload to see its real state.',
  },
  {
    test: e => /bonus_name_blank/i.test(e.message || ''),
    staff: 'Give the run a name first. Nothing was saved.',
    operator: 'The run needs a name (for example "Dashain" or "Tihar Bonus"). Nothing was saved.',
  },
  {
    test: e => /advance_has_repayments/i.test(e.message || ''),
    staff: 'That advance already has repayments, so it cannot be deleted. Nothing was changed.',
    operator: 'This advance already has repayments recorded against it — some from payroll — so deleting it would erase that history. It was not deleted. If the money will not come back, write the balance off instead.',
  },
  {
    test: e => /advance_amount_below_repaid/i.test(e.message || ''),
    staff: 'More than that has already been repaid. Nothing was saved.',
    operator: 'More than that amount has already been repaid on this advance, so the change was not saved.',
  },
  {
    test: e => /advance_not_repaid/i.test(e.message || ''),
    staff: 'Money is still owed on that advance, so it was not marked settled.',
    operator: 'Money is still owed on this advance, so it was not marked settled. Record the repayment, or use Write off if the balance will not be repaid.',
  },
  {
    test: e => /write_off_reason_required/i.test(e.message || ''),
    staff: 'Say why the balance is being written off. Nothing was changed.',
    operator: 'A write-off needs a reason, so nothing was changed. Say why the balance will not be repaid.',
  },
  {
    test: e => /write_off_nothing_owed/i.test(e.message || ''),
    staff: 'Nothing is owed on that advance. Nothing was changed.',
    operator: 'Nothing is owed on this advance, so there is nothing to write off.',
  },
  {
    test: e => /repayment_exceeds_outstanding/i.test(e.message || ''),
    staff: 'That is more than is still owed. Nothing was saved.',
    operator: 'That repayment is more than is still owed on this advance (the amount still owed is in the technical detail), so it was not recorded.',
  },
  {
    test: e => /advance_not_found/i.test(e.message || ''),
    staff: 'That advance no longer exists. Nothing was saved — reload the page.',
    operator: 'That advance no longer exists (it may have been deleted on another screen), so nothing was recorded. Reload the page.',
  },
  {
    test: e => /employee_not_found/i.test(e.message || ''),
    staff: "That employee could not be found. Nothing was saved — reload the page.",
    operator: 'That employee could not be found (removed, or not part of this business), so the claim was not saved. Reload the page and pick the employee again.',
  },
  {
    test: e => /repayment_advance_mismatch/i.test(e.message || ''),
    staff: "That repayment doesn't match the advance. Nothing was saved.",
    operator: 'That repayment does not belong to this advance (different employee), so it was not recorded. Reload the page and try again.',
  },
  {
    test: e => /advance_not_active/i.test(e.message || ''),
    staff: 'That advance is closed, so nothing can be repaid on it. Nothing was saved.',
    operator: 'This advance is settled or written off, so no repayment can be recorded on it. Reactivate it first if money really came back.',
  },
  {
    test: e => /tada_own_claim/i.test(e.message || ''),
    staff: 'You cannot approve or reject your own claim. Nothing was changed — ask another manager.',
    operator: 'This is your own claim, so someone else has to approve or reject it. Nothing was changed.',
  },
  {
    test: e => /tada_pay_rank/i.test(e.message || ''),
    staff: 'Only an HR manager can mark a claim paid. Nothing was changed.',
    operator: 'Marking a claim paid needs an HR manager, so nothing was changed.',
  },
  {
    test: e => /tada_paid_method_required/i.test(e.message || ''),
    staff: 'Choose how the claim was paid. Nothing was changed.',
    operator: 'Choose how the claim was paid (cash, bank…). Nothing was changed.',
  },
  {
    test: e => /tada_claim_locked|tada_transition_invalid|tada_claim_must_start_pending/i.test(e.message || ''),
    staff: 'That claim has already been decided, so it cannot be changed that way. Nothing was changed.',
    operator: 'That claim has already moved on (approved, rejected or paid — possibly from another screen), so this change was not made. Reload to see where it is now.',
  },
  {
    test: e => /tada_dates_invalid/i.test(e.message || ''),
    staff: 'The trip ends before it starts — check the dates. Nothing was sent.',
    operator: 'The trip end date is before its start date, so the claim was not saved.',
  },
  {
    test: e => /tada_amount_invalid/i.test(e.message || ''),
    staff: 'One of the amounts is not a real figure. Check them and try again. Nothing was sent.',
    operator: 'One of the expense amounts was negative or not a number, so the claim was not saved.',
  },
  {
    test: e => /tada_duplicate/i.test(e.message || ''),
    staff: 'You have already sent this claim — same dates and same amount. It was not sent again.',
    operator: 'An identical claim (same employee, dates and amount) already exists, so this one was not saved again.',
  },
  // ── HR Staff, Final Settlement and self-approval (S752, migration 20260914230000) ──────────
  {
    test: e => /hr_own_request/i.test(e.message || ''),
    staff: 'That request is your own, so someone else has to decide it. Nothing was changed.',
    // S798: also cancelling your own approved leave, changing your own approved overtime or advance,
    // deleting your own advance, and recording a repayment on it.
    operator: 'This is your own record, so someone else — another manager or the Owner — has to decide, change or cancel it. Nothing was changed.',
  },
  // S798 3a (20261002140000, owner decision H2): your own pay is the Owner's to set, and a run that pays
  // you is the Owner's to finalize and reopen.
  {
    test: e => /hr_own_pay/i.test(e.message || ''),
    staff: 'That is your own pay, so the Owner changes it. Nothing was saved.',
    operator: 'This is your own employee record, so the Owner sets its pay, bank, SSF and email details. Nothing was saved.',
  },
  {
    test: e => /hr_own_run/i.test(e.message || ''),
    staff: 'That run pays you, so the Owner finalizes it. Nothing was changed.',
    operator: 'This run pays you, so the Owner finalizes and reopens it. Nothing was changed — ask the Owner to press it.',
  },
  {
    test: e => /tada_undo_rank/i.test(e.message || ''),
    staff: 'Only an HR manager or the Owner can put a decided claim back to pending. Nothing was changed.',
    operator: 'Putting a decided claim back to pending needs an HR manager or the Owner, so nothing was changed.',
  },
  // S798 (20260930120000): a decided leave request keeps its employee, type, dates and day type, and
  // only a pending one can be deleted.
  {
    test: e => /leave_request_locked/i.test(e.message || ''),
    staff: 'That leave has already been decided, so it cannot be changed that way. Nothing was changed.',
    operator: 'That leave request has already been decided, so its employee, type and dates stay as they were decided, and it cannot be deleted — cancel it instead, or file a new request for different dates. Nothing was changed.',
  },
  {
    test: e => /hr_backfill_forbidden|hr_backfill_no_period|hr_backfill_no_calendar/i.test(e.message || ''),
    staff: 'Approved leave could not be marked from this login. Nothing was written — ask your manager.',
    operator: 'Approved leave could not be marked on that month from this login — the Owner, an HR supervisor or manager, or an IMS supervisor or manager can. Nothing was written.',
  },
  {
    test: e => /payroll_run_stale|payroll_repayments_mismatch|payroll_repayment_invalid/i.test(e.message || ''),
    staff: 'The payroll changed while it was being finalized. Nothing was finalized — reload and try again.',
    operator: 'Nothing was finalized. Something changed between the check and the finalize — the run was regenerated in another tab, or an advance was repaid, written off or edited — so the figures on screen were no longer the ones in the database. Reload the page and finalize again.',
  },
  {
    test: e => /payroll_tada_changed/i.test(e.message || ''),
    staff: 'A travel claim on this payroll changed. Nothing was finalized.',
    operator: 'Nothing was finalized: a travel claim this payroll pays is no longer Approved — it was rejected or paid by hand in TADA Claims after the run was generated. Regenerate the run and finalize again.',
  },
  {
    test: e => /payroll_already_finalized|payroll_not_finalized/i.test(e.message || ''),
    staff: 'This payroll was changed in another tab. Reload the page.',
    operator: 'Nothing was changed by this click — the run was finalized or reopened in another tab a moment ago. Reload the page to see where it stands.',
  },
  // S791 (20260928100000): Reopen refuses over an advance written off since this run recovered from
  // it, and a run's status never changes except through Finalize or Reopen.
  {
    test: e => /payroll_reopen_written_off/i.test(e.message || ''),
    staff: 'An advance this payroll recovered was written off since. Nothing was reopened.',
    operator: 'Nothing was reopened: an advance this payroll recovered money from has since been written off (named in the detail below). Reopening would take that recovery back and quietly grow the write-off. Put the advance back into recovery with Advances & Loans → Reactivate, then reopen.',
  },
  {
    test: e => /payroll_status_direct/i.test(e.message || ''),
    staff: 'A payroll can only be finalized or reopened from the Payroll page. Nothing was changed.',
    operator: 'A payroll run is finalized with Finalize and reopened with Reopen on the Payroll page, never by changing its status directly — those two also record the advance recoveries and travel claims. Nothing was changed.',
  },
  // S798 stage 2b (20261001140000): a run stays in its month, and a payslip's net pay is its own parts.
  {
    test: e => /payroll_period_fixed/i.test(e.message || ''),
    staff: 'A payroll run cannot be moved to another month. Nothing was changed.',
    operator: 'A payroll run stays in the month it was generated for — moving it would take its payslips, payments and month lock with it and open the original month for a second payroll. Delete the draft and generate the other month instead. Nothing was changed.',
  },
  {
    test: e => /payslip_net_mismatch/i.test(e.message || ''),
    staff: 'A payslip\'s net pay does not add up. Nothing was saved — ask your manager.',
    operator: 'Nothing was saved or finalized: a payslip\'s net pay is not its pay less its deductions, which nothing on the Payroll page writes — it was changed some other way. Press Regenerate to rebuild the payslips from current data, then try again.',
  },
  {
    test: e => /payroll_run_empty|payroll_run_not_found/i.test(e.message || ''),
    staff: 'That payroll run has no payslips any more. Reload the page.',
    operator: 'Nothing was finalized: the run has no payslips, or no longer exists. Reload the page.',
  },
  // ── Salary payments (S782, migration 20260923100000) ────────────────────────────────────────
  // Every refusal below is raised inside record_salary_payments / void_salary_payment before or in
  // place of their one write, so "nothing was recorded" is true of each. The rank refusal sits with
  // payroll_rank above, ahead of the generic 42501 rule.
  {
    test: e => /salary_payment_(nothing_due|no_payslip|not_finalized|already_voided|not_found|run_missing)/i.test(e.message || ''),
    staff: 'That payroll changed on another screen. Reload the page.',
    operator: 'Nothing was recorded — this payroll changed since the page loaded: someone was marked paid or a payment was undone in another tab, or the run was reopened or regenerated. Reload the page to see who is still to be paid.',
  },
  {
    test: e => /salary_payment_(method|date|reference|void_reason|nobody)/i.test(e.message || ''),
    staff: 'Something in the payment details was not accepted. Nothing was changed.',
    operator: 'Nothing was recorded: the payment details were not accepted — the date cannot be in the future, a payment method must be chosen, the reference is at most 100 characters and an undo needs a reason. The detail below says which.',
  },
  {
    test: e => /salary_payment_ledger_locked/i.test(e.message || ''),
    staff: 'Salary payments can only be changed from the Payroll page. Nothing was changed.',
    operator: 'Salary payments are recorded with Mark paid and undone with Undo payment on the Payroll page, never edited directly, so the record of who was paid stays complete. Nothing was changed.',
  },
  {
    test: e => /repayment_ledger_locked/i.test(e.message || ''),
    staff: 'That repayment was recorded by payroll or a settlement and cannot be changed here. Nothing was changed.',
    operator: 'That repayment was recorded by a payroll run or a Final Settlement, so it can only be undone by reopening that run or settlement — deleting it by hand would make a recovered advance look owed again. Nothing was changed.',
  },
  {
    test: e => /run_has_settled_employee/i.test(e.message || ''),
    staff: 'Someone on that payroll has already been paid through a Final Settlement. Nothing was finalized.',
    operator: 'The run was not finalized: someone on it left in a finalized Final Settlement that paid their last month itself (named in the detail below), so a payslip in this month or a later one would pay them twice. If they have rejoined, record their new join date on their employee record; if the settlement was a mistake, reopen it; otherwise Regenerate the run, which leaves settled leavers out, and finalize again.',
  },
  {
    test: e => /settlement_stale_advances/i.test(e.message || ''),
    staff: 'That employee\'s advances changed since the settlement was worked out. Nothing was finalized.',
    operator: 'Nothing was finalized: the employee\'s outstanding advances changed since this settlement was calculated (a payroll recovery, a repayment or a write-off landed). Reload the page so the settlement recovers what is really owed, then finalize again.',
  },
  {
    test: e => /settlement_stale_tada/i.test(e.message || ''),
    staff: 'That employee\'s travel claims changed since the settlement was worked out. Nothing was finalized.',
    operator: 'Nothing was finalized: the employee\'s approved travel claims changed since this settlement was calculated (one was approved, paid or rejected meanwhile). Reload the page and finalize again.',
  },
  // S791: both sit ahead of the generic settlement_stale rule below, which would otherwise catch them.
  {
    test: e => /settlement_stale_ot/i.test(e.message || ''),
    staff: "That employee's overtime changed since the settlement was worked out. Nothing was finalized.",
    operator: "Nothing was finalized: overtime for the last month changed since this settlement was calculated (an entry was approved, edited or re-typed, or attendance overtime changed — the detail below compares the two). Payroll leaves a settled leaver out, so that overtime would be paid by nothing. Reload the page so the settlement includes it, then finalize again.",
  },
  // S798 stage 2a. stale_attendance must also sit ahead of the generic settlement_stale rule.
  {
    test: e => /settlement_stale_attendance/i.test(e.message || ''),
    staff: "That employee's attendance changed since the settlement was worked out. Nothing was finalized.",
    operator: "Nothing was finalized: attendance for the last month changed on another screen after this settlement was calculated (a day was marked absent, on leave or present — the detail below compares the two). The month locks once the settlement is finalized, so it would have paid the old figures. Press Recalculate now in the Finalize box, or reload the page, check the statement, then finalize again.",
  },
  {
    test: e => /settlement_rehired/i.test(e.message || ''),
    staff: 'That settlement belongs to an earlier employment and cannot be changed. Nothing was changed.',
    operator: 'Nothing was changed: this employee was taken back after this settlement\'s last working day, so it belongs to their earlier employment. Reworking it would use the new employment\'s dates, pay the old one wrongly and mark them as left again. Pay any correction by hand and keep a note of it.',
  },
  {
    test: e => /settlement_festival_paid/i.test(e.message || ''),
    staff: 'That employee was already paid a festival allowance this year. Nothing was finalized.',
    operator: 'Nothing was finalized: this employee was paid a festival allowance this fiscal year (named below), and this settlement also pays a festival share — the festival would be paid twice. Tick "Festival allowance paid this FY", save the draft, then finalize.',
  },
  {
    test: e => /festival_paid_by_settlement/i.test(e.message || ''),
    staff: 'Someone in this run was already paid a festival share by their Final Settlement. Nothing more was finalized.',
    operator: 'The run stopped: someone in it (named below) left in a Final Settlement that already paid a festival share this fiscal year, so this allowance would pay them twice. Rows before them may already be finalized — reload to see what is stored, take that person out of the run, then finalize again.',
  },
  // S824: a festival allowance or incentive paid WITH a month's salary (hr_bonus_rows_guard,
  // finalize_payroll_run, finalize_final_settlement; migration 20261013120000). Every one is raised
  // before the row or run is written, so each may say what was not done.
  {
    test: e => /bonus_payroll_finalized/i.test(e.message || ''),
    staff: "That month's payroll is already finalized, so this festival or bonus money cannot be added to it or taken off it. Nothing was changed for that person.",
    operator: "Not done for the person named below: the payroll of that month is finalized, and this festival allowance or incentive is set to be paid with that salary. Reopen that month's payroll first, or pick another Paid in month, or pay the run separately. Rows before them may already be done — reload to see what is stored.",
  },
  {
    test: e => /bonus_payroll_leaving/i.test(e.message || ''),
    staff: "That person is leaving by that month, so their festival or bonus money cannot go on that payroll. Nothing was changed for them.",
    operator: "Not finalized for the person named below: their Final Settlement takes them off that month's payroll, so no payslip would carry this money. Reload the page and finalize again: anyone leaving is then paid separately, from this page's bank file. Rows before them may already be finalized — reload to see what is stored.",
  },
  {
    test: e => /bonus_payroll_not_employed/i.test(e.message || ''),
    staff: "That person is not employed in that month, so their festival or bonus money cannot go on that payroll. Nothing was changed for them.",
    operator: "Not finalized for the person named below: they are not employed in that month (their join or end date falls outside it), so no payslip would carry this money. Pay the run separately, or take them out of it. Rows before them may already be finalized — reload to see what is stored.",
  },
  {
    test: e => /payroll_bonus_no_payslip/i.test(e.message || ''),
    staff: 'Someone has festival or bonus money waiting on this payroll but no payslip in it. Nothing was finalized.',
    operator: 'Payroll was not finalized: the person named below has a festival allowance or incentive set to be paid with this salary but no payslip in this run, so nothing would pay it. Regenerate the run if they belong on it; if not, reopen that festival or bonus run and finalize it again, so they are paid separately.',
  },
  {
    test: e => /payroll_bonus_stale/i.test(e.message || ''),
    staff: 'A festival or bonus run changed since this payroll was made. Nothing was finalized.',
    operator: 'Payroll was not finalized: a festival allowance or incentive run was finalized, reopened or switched since this payroll was generated, so the payslip named below does not carry the money now set to be paid with it. Press Regenerate, then Finalize.',
  },
  {
    test: e => /settlement_bonus_on_payroll/i.test(e.message || ''),
    staff: "That employee has festival or bonus money set to be paid with a salary the settlement stops. Nothing was finalized.",
    operator: "Nothing was finalized: this employee has a festival allowance or incentive (named below) set to be paid with a month's salary, and this settlement takes them off that payroll, so nothing would pay it. Save this settlement as a draft, reopen that run on its page and finalize it again — anyone leaving is then paid separately — then finalize this settlement.",
  },
  {
    test: e => /payroll_tds_check|hr_payslips_bonus_check/i.test(e.message || ''),
    staff: 'That income tax is more than the amount it is taken from. Nothing was saved.',
    operator: 'Not saved: a festival allowance or incentive paid with the salary cannot have more income tax than its own amount — the tax would come out of the salary. Lower the tax, or pay the run separately.',
  },
  {
    test: e => /settlement_salary_paid/i.test(e.message || ''),
    staff: "That employee's salary for the last month is already recorded as paid. Nothing was finalized.",
    operator: "Nothing was finalized: this employee's salary for the last month (or a later one) is recorded as paid, and the settlement pays that month itself, so it would be paid twice. Undo that payment on the Payroll page first (Undo payment, with a reason), then finalize — the settlement then pays the month.",
  },
  // S798 stage 3b. Every finalize refusal is raised inside the one transaction, before any write.
  {
    test: e => /settlement_prior_month_open/i.test(e.message || ''),
    staff: "An earlier month's payroll is not finished for that employee. Nothing was finalized.",
    operator: "Nothing was finalized: payroll for an earlier month (named below) is still a draft, has not been run, or was finalized without this employee. The settlement works out the year's tax and the gratuity from finalized months only, so that month would be taxed apart and its gratuity paid twice. Finalize that payroll first (reopen and Regenerate a month that left them out), then press Recalculate and finalize the settlement.",
  },
  {
    test: e => /settlement_pending_requests/i.test(e.message || ''),
    staff: 'That employee has leave or overtime still waiting for a decision. Nothing was finalized.',
    operator: 'Nothing was finalized: this employee has leave or overtime up to their last working day still waiting for a decision (counted below). Pending leave would be paid as worked and paid out again, pending overtime would be paid by nobody, and neither can be approved once the settlement locks the month. Approve or reject each in Leave and Overtime, press Recalculate, then finalize.',
  },
  {
    test: e => /settlement_pending_tada/i.test(e.message || ''),
    staff: 'That employee has a travel claim still waiting for a decision. Nothing was finalized.',
    operator: 'Nothing was finalized: this employee has a travel claim still waiting for a decision (counted below). The settlement pays approved claims only and no payroll will include them again, so a claim approved afterwards would be paid by nobody. Approve or reject it in TADA Claims, press Recalculate, then finalize.',
  },
  {
    test: e => /settlement_manager_login/i.test(e.message || ''),
    staff: 'Only the Owner can finalize that settlement. Nothing was finalized.',
    operator: 'Nothing was finalized: this employee holds an HR Manager login (named below), and finalizing blocks it. Only the Owner changes an HR manager\'s login, so only the Owner can finalize this settlement. The draft is saved; ask the Owner to finalize it.',
  },
  {
    test: e => /settlement_paid_record/i.test(e.message || ''),
    staff: 'That settlement was paid before it was reopened, so it cannot be deleted. Nothing was deleted.',
    operator: 'Nothing was deleted: this settlement was paid before it was reopened, and it is the only record of that payment. Correct it and finalize it again; any difference then shows as still to pay or overpaid.',
  },
  {
    test: e => /settlement_payroll_skipped/i.test(e.message || ''),
    staff: 'Payroll left that employee out because this settlement was paying them. Nothing was deleted.',
    operator: 'Nothing was deleted: payroll for the months named below was finalized without this employee because this settlement was paying them, so deleting it would leave that pay to nobody. Finalize the settlement again, or reopen that payroll and Regenerate so they are paid there, then delete the draft.',
  },
  {
    test: e => /settlement_no_difference/i.test(e.message || ''),
    staff: 'There is nothing to record on that settlement. Nothing was changed.',
    operator: 'Nothing was recorded: this settlement has no difference between what it pays and what was paid, or is not finalized and paid yet (the detail below says which). Reload the page to see where it stands.',
  },
  {
    test: e => /settlement_stale/i.test(e.message || ''),
    staff: 'That settlement needs to be opened and saved again first. Nothing was finalized.',
    operator: 'Nothing was finalized: this draft was saved by an older version of the page, or its month no longer matches its last working date. Open it, check the figures, press Update draft, then finalize.',
  },
  {
    test: e => /settlement_month_paid/i.test(e.message || ''),
    staff: 'Payroll has already paid that month. Nothing was finalized.',
    operator: 'Nothing was finalized: a finalized payroll run already pays this employee for the final month (or a later one), so the settlement would pay that month twice. Reopen that payroll run and regenerate it without them, or move the last working date.',
  },
  {
    test: e => /settlement_overlap|hr_final_settlements_one_finalized_per_spell/i.test(e.message || ''),
    staff: 'That employee already has a finalized settlement. Nothing was finalized.',
    operator: 'Nothing was finalized: this employee already has a finalized settlement for this spell of service, and a second would pay the same gratuity again. Reopen the existing one instead, or add a new employee record for a rehire.',
  },
  {
    test: e => /settlement_already_finalized|settlement_not_finalized/i.test(e.message || ''),
    staff: 'That settlement changed on another screen. Reload to see it.',
    operator: 'This settlement was finalized or reopened on another screen while it was open here, so nothing was changed. Reload the page to see its real state.',
  },
  {
    test: e => /settlement_reopen_written_off/i.test(e.message || ''),
    staff: 'An advance this settlement recovered was written off since. Nothing was reopened.',
    operator: 'Nothing was reopened: an advance this settlement recovered has since been written off (named in the detail below). Reopening would forgive the recovered money silently. Put that advance back to Active in Advances & Loans first.',
  },
  {
    test: e => /settlement_reopen_reason/i.test(e.message || ''),
    staff: 'Say why the settlement is being reopened. Nothing was changed.',
    operator: 'Write down why this settlement is being reopened — the reason is kept on the record. Nothing was changed.',
  },
  {
    test: e => /settlement_finalized|settlement_finalize_path|settlement_must_start_draft/i.test(e.message || ''),
    staff: 'That settlement is finalized, so it cannot be changed. Nothing was changed.',
    operator: 'This settlement is finalized, so its figures are locked and nothing was changed. Reopen it first if it needs correcting — another tab may have finalized it after this page loaded, so reload to see its real state.',
  },
  {
    test: e => /settlement_employee_missing|settlement_not_found/i.test(e.message || ''),
    staff: 'That settlement or employee no longer exists. Reload the page.',
    operator: 'This settlement or its employee record no longer exists, so nothing was changed. Reload the page.',
  },
  {
    test: e => /leave_overlap/i.test(e.message || ''),
    staff: 'You already have a leave request covering some of those days. Nothing was sent — cancel or change that one first.',
    operator: 'This employee already has a pending or approved leave request covering some of those days, so nothing was saved. Two requests over one day would both count against the balance. Cancel or reject the other request first.',
  },
  {
    test: e => /leave_dates_invalid|leave_half_day_range|leave_range_too_long/i.test(e.message || ''),
    staff: 'Those dates were not accepted — check the start and end date (a half day is a single date). Nothing was sent.',
    operator: 'Those dates were not accepted — the end date must not be before the start date, a half-day request covers a single date, and one request covers at most a year. Nothing was saved.',
  },
  {
    test: e => /leave_all_holidays/i.test(e.message || ''),
    staff: 'Every day you picked is a public holiday, so there is no leave to take. Nothing was sent.',
    operator: 'Every day in this request is a public holiday in the Holiday Calendar, so it charges no leave and was not saved. Public holidays inside a leave are not counted against the balance.',
  },
  {
    test: e => /swap_day_past/i.test(e.message || ''),
    staff: 'One of those days has already gone, so it cannot be swapped. Nothing was sent.',
    operator: 'One of those days has already passed, so the swap was not requested.',
  },
  {
    test: e => /swap_day_unpublished/i.test(e.message || ''),
    staff: "That day's roster hasn't been published yet, so it cannot be swapped. Nothing was sent.",
    operator: 'That day of the roster has not been published, so the swap was not requested.',
  },
  // S798 3d (20261003140000, ROSTER-3, H23 (a)): a request to someone who could never answer it.
  {
    test: e => /swap_coworker_unavailable/i.test(e.message || ''),
    staff: "That coworker can't answer a swap in the Staff app, so it wasn't sent. Ask your manager to swap you on the roster instead.",
    operator: 'That coworker has no Crest Staff login, has left, or is blocked, so they could never answer the request. Nothing was sent. Swap them on the Roster board instead.',
  },
  // S798 4e (20261005120000, DOCS-7): the roster moved while the swap sheet was open. Both were plain
  // text that read as "Try again", and sending again failed the same way. The page re-reads what
  // changed, which is what makes the staff wording's "refreshed" true.
  {
    test: e => /swap_own_shift_gone/i.test(e.message || ''),
    staff: 'Your shift on that day has changed since you opened this, so nothing was sent. Close this and check your roster.',
    operator: 'The employee no longer has a working shift on that day, so the swap was not requested.',
  },
  {
    test: e => /swap_coworker_shift_gone/i.test(e.message || ''),
    staff: 'Their shift on that day has changed since you opened this, so nothing was sent. Their days have been refreshed — pick again.',
    operator: 'The coworker no longer has a working shift on that day, so the swap was not requested.',
  },
  // S798 3d (ROSTER-1, H12 (a)): split_shift_type — the shift type and the roster are unchanged on every one.
  {
    test: e => /shift_split_replaced/i.test(e.message || ''),
    staff: 'That shift was already changed from a later day. Reload and edit the current one.',
    operator: 'That shift type already hands its name over to a newer one, so it was not changed. Reload the page and edit the current shift type instead. Nothing was changed.',
  },
  {
    test: e => /shift_split_bad_day/i.test(e.message || ''),
    staff: "That day isn't in the calendar.",
    operator: 'That day is outside the calendar Crest knows, so the shift was not changed. Pick another day. Nothing was changed.',
  },
  {
    test: e => /shift_split_name/i.test(e.message || ''),
    staff: 'Both shifts need a name.',
    operator: 'The shift and its earlier version both need a name, so nothing was changed.',
  },
  {
    test: e => /shift_split_not_permitted|shift_split_not_found/i.test(e.message || ''),
    staff: "You're not allowed to do that.",
    operator: 'This account could not change the shift type or move its roster days (that needs HR supervisor rank or above), or the shift type was deleted meanwhile. Nothing was changed.',
  },
  {
    test: e => /swap_already_requested/i.test(e.message || ''),
    staff: 'One of those shifts already has a swap waiting. Wait for it to be decided, or withdraw it first. Nothing was sent.',
    operator: 'One of those shifts already has a swap request waiting, so a second one was not created.',
  },
  {
    test: e => /leave_type_invalid/i.test(e.message || ''),
    staff: "That leave type isn't available any more. Reopen the form and pick another. Nothing was sent.",
    operator: 'That leave type is not one of this client’s active types. Nothing was saved.',
  },
  {
    test: e => /shift_type_in_use/i.test(e.message || ''),
    staff: 'That shift is still on the roster, so it cannot be deleted.',
    operator: 'That shift type is still used on the roster, so it was not deleted — deleting it would blank those days, and Generate from Roster would then mark them Off. Untick Active instead: it disappears from the picker and every assigned day keeps its shift.',
  },
  // S798 (20261001160000, DATABASE-3): the leave-type twin of shift_type_in_use.
  {
    test: e => /leave_type_in_use/i.test(e.message || ''),
    staff: 'That leave type is still used by leave requests, so it cannot be deleted.',
    operator: 'That leave type is used by leave requests or a final settlement, so it was not deleted — those requests would stop counting against anyone\'s balance, and the leave would be paid out again at settlement. Untick Active instead: it disappears from the picker and every request keeps its type.',
  },
  {
    test: e => /hr_shift_types_client_name_key/i.test(e.message || ''),
    staff: 'A shift with that name already exists.',
    operator: 'A shift type with that name already exists for this client. Use a different name (for example "Morning – Kitchen"), or edit the existing one.',
  },
  {
    test: e => /hr_overtime_entries_employee_day_key/i.test(e.message || ''),
    staff: 'Overtime is already recorded for that person on that day.',
    operator: 'This employee already has an overtime entry for that day, so nothing was saved — each approved entry is paid, so a second one would pay the same day twice. Edit the existing entry and add the hours to it.',
  },
  {
    test: e => /swap_not_pending|swap_not_found/i.test(e.message || ''),
    staff: 'That swap has already been decided or withdrawn.',
    operator: 'That swap is no longer waiting for approval — it was withdrawn, or someone else decided it first. The roster was not changed. The list has been refreshed.',
  },
  {
    test: e => /swap_shift_changed|swap_shift_missing/i.test(e.message || ''),
    staff: 'The roster changed after that swap was asked for.',
    operator: 'The roster has changed since this swap was requested — one of those days no longer carries the shift the two employees agreed to trade. The roster was not changed. Reject the swap and ask them to request it again from the new roster.',
  },
  {
    test: e => /swap_day_taken/i.test(e.message || ''),
    staff: 'One of you already works, or is on leave, on the other day. Pick a day you are both free.',
    operator: 'One of the two employees already works, or is on leave, on the day they would be moving onto, so the swap would give them two shifts on one day or overwrite their leave. A Day Off there is fine — it changes hands the other way. The roster was not changed. Adjust the roster first, or reject the swap.',
  },
  {
    test: e => /swap_not_permitted/i.test(e.message || ''),
    staff: "You're not allowed to do that.",
    operator: 'This account could not change the roster or the swap request — approving a swap needs HR supervisor rank or above. The roster was not changed.',
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
  // S849 (PNL-8): an item on a stock transfer between outlets. Removing one outlet's half of a
  // movement would leave the other half standing, so it is hidden instead.
  {
    test: e => /force_delete_item_transferred/i.test(e.message || ''),
    staff: 'That item can\'t be deleted.',
    operator: 'This item was sent or received between outlets, so it can\'t be force-deleted — both outlets keep the transfer on their books. Nothing was removed. Hide the item instead.',
  },

  // One item name per client, case-insensitive, mirrors and hidden items included (S707). Ahead of
  // the generic 23505 because "that already exists" says nothing about WHAT splits if you proceed.
  {
    test: e => /items_client_name_key/i.test(e.message || ''),
    staff: 'An item with that name already exists. Ask your manager which one to use.',
    operator: 'This client already has an item — or a sub-recipe, which is stock-counted alongside items — with that name. Two rows with one name split that ingredient’s purchases and stock between them. Rename one of them, or use the existing row.',
  },

  // Crest Customization's own name indexes (S758) — say WHICH name clashed, not just "exists".
  {
    test: e => /pos_option_groups_client_name_key/i.test(e.message || ''),
    staff: 'An option group with that name already exists.',
    operator: 'An option group with that name already exists for this outlet — nothing was saved. Use the existing group, or give this one a different name.',
  },
  {
    test: e => /pos_options_group_name_key/i.test(e.message || ''),
    staff: 'That group already has an option with that name.',
    operator: 'This group already has an option with that name — nothing was saved. Edit the existing option, or give this one a different name.',
  },
  {
    test: e => /pos_recipe_option_groups_recipe_group_key/i.test(e.message || ''),
    staff: 'That group is already on this dish.',
    operator: 'That group is already attached to this dish — nothing was changed.',
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
