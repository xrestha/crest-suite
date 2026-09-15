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
export function isNetworkError(err) {
  if (!err) return false
  const e = typeof err === 'string' ? { message: err } : err
  return NETWORK_ERROR_RE.test(e.message || '')
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
  // into `error.message` by PostgrestBuilder rather than thrown.
  {
    test: e => NETWORK_ERROR_RE.test(e.message || ''),
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
  {
    test: e => hasCode(e, 'stale_order'),
    staff: 'This order was changed on another device since you opened it. Nothing was saved — reload the order and add your changes again.',
    operator: 'This order was changed on another device since it was opened here, so this save was refused rather than overwrite theirs. Nothing was saved — reload the order and make the change again.',
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
  {
    test: e => hasCode(e, 'line_not_on_menu'),
    staff: 'Something on this order is no longer on the menu. Nothing was saved — remove it and save again.',
    operator: 'A dish on this order is no longer on the menu (named in the detail below), so the order was not saved. Remove it from the order and save again — or put the dish back on the POS menu in Menu Pricing first.',
  },
  {
    test: e => hasCode(e, 'award_window_closed'),
    staff: 'This bill closed too long ago for points to be added from the till. The bill itself is fine — ask the owner to add the points.',
    operator: 'Loyalty points are added as a bill closes, and this one closed more than 10 minutes ago, so none were added. The bill is unaffected; the Owner can add the points.',
  },
  {
    test: e => hasCode(e, 'redeem_exceeds_bill'),
    staff: 'Those points are worth more than this bill. None were redeemed — redeem fewer.',
    operator: 'Those points are worth more than this bill, so none were redeemed. Redeem fewer points.',
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
  {
    test: e => hasCode(e, 'pos_table_has_open_order'),
    staff: 'That table still has an open bill, so it cannot be deleted. Nothing was removed.',
    operator: 'That table still has an open bill (its order number is in the detail below), so it was not deleted — the bill would vanish from the floor with nobody able to reach it. Bill or void that order first.',
  },
  // S755 (migration 20260917100000). Both are raised by a trigger in the statement that wrote, so
  // the statement rolled back and each may say this write did not land.
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
    // charged with — never something a retry fixes.
    test: e => hasCode(e, 'credit_note_amounts'),
    staff: 'The amounts on this Credit Note do not match the bill, so no note was issued. Close this, reload the bill and try again — tell your manager if it happens again.',
    operator: 'The Credit Note’s amounts do not match the bill it credits (both sets are in the detail below), so no note was issued and nothing was numbered. A note credits exactly what the bill charged: reload the bill and issue it again. If the outlet’s VAT registration changed since the bill was printed, the note cannot be issued from the till — contact support.',
  },
  {
    test: e => hasCode(e, 'pos_tables_rank'),
    staff: 'Only the owner or a POS manager can add, rename, move or delete tables. Nothing was changed.',
    operator: 'Only the Owner or a POS manager can add, rename, move or delete tables, so nothing was changed. Marking a table occupied or free from the floor is unaffected.',
  },
  {
    test: e => hasCode(e, 'pos_setup_rank'),
    staff: 'Only the owner or a POS manager can change the till setup. Nothing was saved.',
    operator: 'Only the Owner or a POS manager can change the till setup (the setting is named in the detail below), so nothing was saved.',
  },
  {
    test: e => hasCode(e, 'invoice_settings_rank'),
    staff: 'Only the owner can change the invoice and VAT details printed on bills. Nothing was saved.',
    operator: 'Only the Owner can change the invoice and VAT details printed on bills, so nothing was saved. They are read when any bill or Credit Note is printed — reprints of old ones included — which is why they are fenced.',
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
  // rank_required is one hint for several rank refusals; the recipe price guard and the loyalty
  // award have consequences worth naming, the rest share the generic sentence.
  {
    test: e => hasCode(e, 'rank_required') && onTable(e, 'recipes'),
    staff: 'Only a manager or the owner can change a menu price, its VAT rate or whether a dish is on the POS menu. Nothing was saved.',
    operator: 'A menu price, its VAT rate and whether a dish is on the POS menu are set by a manager or the Owner, so this save was refused and nothing was changed. Ask one to change it in Menu Pricing.',
  },
  {
    test: e => hasCode(e, 'rank_required') && /person who closed it/i.test(e.message || ''),
    staff: 'Points for a bill are added by whoever closed it, as it closes. The bill itself is fine — ask the owner to add the points.',
    operator: 'Loyalty points for a bill are added by the person who closed it, as it closes, so none were added from this login. The bill is unaffected; the Owner can add the points.',
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
    test: e => /self_service_blocked/i.test(e.message || ''),
    staff: 'Your access to the Staff app has been turned off. Speak to your manager if you think this is a mistake.',
    operator: 'This employee\'s Staff app access is turned off, so the request was refused. Turn it back on in Employees if they should still use it.',
  },
  {
    test: e => /settlement_rank/i.test(e.message || ''),
    staff: 'Only the owner or an HR manager can do that to a settlement. Nothing was changed.',
    operator: 'Finalizing or reopening a Final Settlement needs the Owner or an HR manager, so nothing was changed.',
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
    staff: 'Someone else has already counted this item, so your figure was not saved. A supervisor can change it.',
    operator: 'This item was already counted by another staff member and recount protection is on, so nothing was overwritten. A supervisor, manager or Owner can enter the corrected figure — or switch the protection off in Stock Count → Settings.',
  },

  // ── receive_purchase_order (S709) ─────────────────────────────────────────────────────────
  // Every one of these is raised BEFORE or INSIDE the one transaction that writes the bills, the
  // received quantities and the PO's status together — so unlike a dropped fetch, each of them
  // genuinely does prove nothing landed, and saying so is what makes the delivery safe to re-enter.
  // That guarantee is the function's whole reason for existing (the old path wrote the bills first
  // and could stop before the quantities), so these messages are allowed to state it.
  // ── The IMS guards (S756, migration 20260918100000) ───────────────────────────────────────────
  // Each is raised by a BEFORE trigger on the row it names, so the statement that carried it did
  // not change that row — but a page that writes several tables in a row (a bill, then its
  // payment) may have landed the earlier ones, so none of these claims the whole action is undone.
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
    operator: 'This is your own record, so someone else — another manager or the Owner — has to approve, reject or write it off. Nothing was changed.',
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
  {
    test: e => /payroll_run_empty|payroll_run_not_found/i.test(e.message || ''),
    staff: 'That payroll run has no payslips any more. Reload the page.',
    operator: 'Nothing was finalized: the run has no payslips, or no longer exists. Reload the page.',
  },
  {
    test: e => /repayment_ledger_locked/i.test(e.message || ''),
    staff: 'That repayment was recorded by payroll or a settlement and cannot be changed here. Nothing was changed.',
    operator: 'That repayment was recorded by a payroll run or a Final Settlement, so it can only be undone by reopening that run or settlement — deleting it by hand would make a recovered advance look owed again. Nothing was changed.',
  },
  {
    test: e => /run_has_settled_employee/i.test(e.message || ''),
    staff: 'Someone on that payroll has already been paid through a Final Settlement. Nothing was finalized.',
    operator: 'The run was not finalized: someone on it already has a finalized Final Settlement that pays this month (named in the detail below). Regenerate the run — it leaves settled leavers out — and finalize again.',
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
    staff: 'One of you already works the other day.',
    operator: 'One of the two employees is already rostered on the day they would be moving onto, so the swap would give them two shifts on one day. The roster was not changed. Adjust the roster first, or reject the swap.',
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
