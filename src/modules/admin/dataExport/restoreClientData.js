// Rebuilds a client's data from the .json artifact produced by exportClientData.js.
//
// Insert order: a table goes in after EVERY parent its foreign keys name, whatever their delete
// action (S809 DATABASE-3). This used to be described as "the reverse of deleteClientData's delete
// order", which holds only for a NO ACTION key: a SET NULL key lets the delete run in either order,
// and reversing it put pos_parking_slips before pos_orders and pos_cash_movements before
// pos_credit_notes. A linked slip and a credit-note refund then failed their table's first chunk, and
// the loop below abandons a table there: every parking slip, and every Cash In / Out of every shift,
// left out of a restore reported as done. restoreClientData.test.js reads every foreign key in
// supabase/migrations and fails on a child placed before its parent, so the next key added to a
// restored table fails a test instead of a restore. The two exceptions are the second passes at the
// end (DEFERRED_LINKS) and the attribution columns, which are restored empty.
//
// Scope: this restores DATA. Logins are a separate concern (reprovisionAccounts.js) because
// passwords live in GoTrue and are not exportable at any privilege level.
//
// `ims_count_assignments` is DELIBERATELY not in the order below (S737), for the same reason
// `legal_acceptances` is not: every row keys on `profile_id`, and the restore re-provisions staff
// accounts as NEW auth users with new ids — so the rows would either fail their FK or, worse,
// point at whoever happened to inherit the id. Stock-count section assignments are half a dozen
// ticks in Stock Count → Settings and are re-made by the manager after a restore; the alternative
// is a silently wrong answer to "who counts the bar".
//
// `onboarding_progress` is left out for the same reason (S790): every row keys on `user_id`, a
// profiles id that does not survive a restore. It is personal UI state (which checklist steps one
// person opened, ticked, skipped or dismissed), so a restored client simply starts its checklist
// again. It is still exported, since it is in CLIENT_SCOPED_TABLES and harmless to carry.
//
// `pos_guest_order_requests` and `pos_payment_confirmations` are left out too (S809 DATABASE-6).
// Both are live state with no client INSERT at all: a guest's QR order waits for the till to accept
// or decline it, and a payment confirmation is written by the payment provider alone
// (pos_payment_confirmations_guard). Every restore of a QR-ordering client reported the request
// table as failed, which taught the operator to read past the list where real losses appear.
// Nothing reads an old request or confirmation, and both stay in the backup file.
//
// A restore never reports success while rows stay behind (S809 DATABASE-3): a table that fails says
// how many of its rows did not come back and why, every table a backup carries has a step here or a
// stated reason in RESTORE_LEFT_OUT, and ClientDrawer shows any gap as an error.
import { supabase } from '../../../supabaseClient'
import { runChunkedByIds } from '../../../shared/fetchAllRows'
import { formatAdAsBs } from '../../../utils/bsCalendar'

// Parents before children, so every FK target exists first (header).
export const RESTORE_ORDER = [
  // Foundations
  'categories', 'vendors', 'items', 'recipes', 'recipe_ingredients', 'recipe_suggestions',
  // Crest Customization (S758): groups before options before their ingredients (composite FKs);
  // the attachment needs recipes and groups AND pos_options (default_option_id). Items and recipes
  // are above, which pos_option_ingredients' item_id / sub_recipe_id point at.
  'pos_option_groups', 'pos_options', 'pos_option_ingredients', 'pos_recipe_option_groups',
  // Combos (S839): a combo before its picks before the dishes in them; each dish names a recipe (above).
  'pos_combos', 'pos_combo_groups', 'pos_combo_items',
  'monthly_periods', 'monthly_owner_reports',
  // Fixed assets
  'assets_categories', 'assets_register', 'assets_repair_expenses',
  // D40: before the runs, so its lock trigger (a posted run for its year or later) never sees one.
  'assets_tax_pool_openings',
  // S849 (ASSETS SU7 b): the record of each correction to a locked opening (old → new, reason). It
  // names no other table but clients; the operator's restore inserts it as it was.
  'assets_tax_pool_opening_corrections',
  'assets_tax_pool_runs', 'assets_tax_pool_lines',
  'assets_depreciation_runs', 'assets_depreciation_schedule',
  // IMS operational
  'overheads', 'par_levels', 'purchase_orders', 'purchase_order_items',
  'requisitions', 'requisition_lines', 'ims_gate_passes',
  'demand_forecast_run_log', 'demand_forecast_daily',
  'purchase_entries', 'payable_payments', 'vendor_returns',
  'opening_stock', 'closing_stock', 'wastages', 'staff_meals', 'budgets',
  // Stock transfers between outlets (S849, PNL-8): after items and monthly_periods (both NO ACTION
  // keys), the header before its lines. A backup holds this outlet's own lines (every leg) and the
  // transfers it SENT; never the headers of transfers it received, which are the sender's rows.
  // transferHeadersForRestore / transferLinesForRestore empty a link to an outlet, a month or a header
  // that is not there, which is what each key's ON DELETE SET NULL would have done.
  'ims_stock_transfers', 'ims_stock_transfer_lines',
  // HR setup then transactions
  'hr_shift_types', 'hr_holiday_calendar', 'hr_leave_types', 'hr_employees',
  'hr_salary_components', 'hr_roster', 'hr_roster_publish_state', 'hr_shift_swap_requests',
  'hr_incentive_configs', 'hr_incentives',
  'hr_advances', 'hr_festival_allowances',
  'hr_overtime_entries', 'hr_leave_requests', 'hr_attendance',
  'hr_payroll_runs', 'hr_payslips', 'hr_final_settlements',
  // AFTER the runs and settlements (S752): a repayment carries payroll_run_id and
  // final_settlement_id, and a TADA claim final_settlement_id — all non-deferrable FKs. Restoring
  // them first refused the first chunk holding a payroll or settlement recovery and, this loop
  // breaking a table on its first failing chunk, dropped the whole repayment ledger: every advance
  // came back fully owed. hr_salary_payments (S782) likewise references a run and an employee.
  'hr_advance_repayments', 'hr_salary_payments', 'hr_tada_claims', 'hr_tada_claim_items',
  // POS — tables/customers before orders; credit notes after orders (circular FK, see below)
  // Membership types (S843) before the customers who hold one.
  'pos_tables', 'pos_loyalty_schemes', 'pos_membership_types', 'pos_customers', 'pos_shifts',
  // pos_order_item_options (S758) right after the lines it snapshots — FKs to the order and the line.
  'pos_orders', 'pos_order_items', 'pos_order_item_options', 'pos_order_payments', 'pos_kot_log', 'pos_kot_removals',
  // Customer payment receipts (S843) after the shifts and the bills they name, and their split over
  // bills after the receipts. guard_pos_credit_receipts / _lines let the operator's restore insert rows
  // dated before it and refuse every other client write; received_by and cancelled_by are attribution,
  // restored empty with their names kept in the file. A receipt's Cash In / cancellation Cash Out names
  // it (credit_receipt_id), so pos_cash_movements stays below.
  'pos_credit_receipts', 'pos_credit_receipt_lines',
  // Move, join and split tables (S836), after pos_tables and pos_orders, which both name. A join names
  // its table and the open bill it joined; the record of a move names the bills it moved between (SET
  // NULL, so one a join or put-back deleted is already empty in the file). joined_by and moved_by are
  // attribution, restored empty with their names kept in the file. Both tables' guards let the
  // operator's restore insert rows dated before it, and refuse every other client write.
  'pos_table_joins', 'pos_table_moves',
  // A slip names the bill it was stamped against (order_id), so after the orders (S809 DATABASE-3).
  // pos_parking_slips_guard keeps a restored slip's number, issuer and times as they were.
  'pos_parking_slips',
  'pos_loyalty_ledger',
  // Reservations reference pos_orders (order_id) and pos_tables (via the join table), both above.
  'pos_reservations', 'pos_reservation_tables',
  // A waitlist party seated on a bill names it (order_id), so after the orders too (S854).
  'pos_waitlist',
  // A booking deposit names its booking, its bill and its shift, and the cash entries below name it
  // (S854). pos_booking_deposits_guard lets the operator's restore insert a row taken before it.
  'pos_booking_deposits',
  'pos_credit_notes',
  // After the shifts, the orders AND the credit notes (S809 DATABASE-3): a refund names its note.
  // A restored note's own trigger (pos_credit_note_settle, S809 2e) links its bill and writes no
  // refund, so the refund the backup carries is restored here exactly once. And after the receipts
  // (S843), whose cash entries name them.
  'pos_cash_movements',
  // sales_entries AFTER the POS tables (S747), not beside the other IMS transactions. Its
  // pos_order_id (20260818170000) and pos_credit_note_id (20260914140200) are foreign keys, and
  // restoring it before pos_orders refused the first chunk carrying a POS bill's revenue — which,
  // since this loop breaks a table on its first failing chunk, dropped the client's whole sales
  // history from the restore. Nothing references sales_entries, so moving it down is free.
  'sales_entries',
  'stock_movements',
  // Config last — harmless either way, and keeps the noisy tables at the end of the log
  'feature_flags',
]

// Generated columns cannot appear in an INSERT payload at all — Postgres rejects the statement
// rather than ignoring the field.
// pos_customers.phone_canonical was missing here from the day the restore shipped (S545) — the
// export carried it (select('*')) and Postgres refuses a generated column in an INSERT, so every
// restore of the customer book was rejected while the backup looked complete. Found S677 while
// registering pos_reservations, which carries the same generated column.
// restoreClientData.test.js reads every migration for `GENERATED ALWAYS AS` and fails on a column
// missing here, so the next one cannot repeat that (S849: assets_register.total_cost had been missing
// since the asset register shipped, ASSETS-3).
export const GENERATED_COLUMNS = {
  items: ['per_uom_rate'],
  pos_customers: ['phone_canonical'],
  pos_reservations: ['phone_canonical'],
  assets_register: ['total_cost'],
  ims_stock_transfer_lines: ['value'],
}

// pos_orders.credit_note_id -> pos_credit_notes.id, while pos_credit_notes.order_id ->
// pos_orders.id. Neither cascades, so one of the two must be inserted with the link empty and
// patched afterwards. Same shape as the null-first step deleteClientData does in reverse.
// hr_employees.supervisor_id -> hr_employees.id (S798 DATABASE-4) is the self-referencing case: a
// supervisor in a later 500-row chunk than their team would fail the FK, so it goes in afterwards too.
export const DEFERRED_LINKS = { pos_orders: ['credit_note_id'], hr_employees: ['supervisor_id'] }

// pos_orders.part_of_order_id -> pos_orders.id (S836): a part bill names the bill it was split off. It
// is the other self-reference, and deliberately NOT a DEFERRED_LINKS second pass: guard_pos_order_close
// keeps an open bill's part_of_order_id as it was and refuses any change to a closed bill outside its
// short allow-list, so the second-pass UPDATE would do nothing on the one and fail bill_locked on the
// other. So the link goes in with its row, and the rows go in parents first, so no chunk holds a part
// bill whose parent waits in a later one (inside one INSERT the order does not matter: the key is
// checked at the end of the statement). One level is the whole of it: split_pos_part_bill refuses a
// part bill, and a join keeps the bill that is not one. A link to a bill the backup does not hold is
// emptied, which is what the key's ON DELETE SET NULL does when that bill goes; left in, it would
// refuse its chunk and, this loop breaking a table there, every bill after it. An OPEN part bill keeps
// its link too: guard_pos_order_insert empties part_of_order_id on an open order a client session
// inserts, except the operator's (20261014120000), which is the restore.
export function partBillsAfterParents(rows) {
  const ids = new Set(rows.map(r => r.id))
  const parents = []
  const parts = []
  for (const r of rows) {
    if (!r.part_of_order_id) parents.push(r)
    else if (ids.has(r.part_of_order_id)) parts.push(r)
    else parents.push({ ...r, part_of_order_id: null })
  }
  return [...parents, ...parts]
}

// Stock transfer headers (S849, PNL-8). A header is the SENDER's row, so a backup holds only the
// transfers this outlet sent. Three links can point outside what is restored:
//   * to_client_id — the receiving outlet may no longer exist (SET NULL key). Emptied when it is not
//     in `existingClientIds`; the stored to_name stands in, and an on-the-way one can still be cancelled.
//   * ended_period_id — a RECEIVED transfer's ending month is the receiver's, never in this backup
//     (SET NULL key). Emptied when it is not one of `backupPeriodIds`; the stored ended_bs_* label
//     stands in. A cancelled or refused one ended in this outlet's own month and keeps it.
//   * sent_period_id — NOT NULL, NO ACTION, and always the sender's own month, so a whole backup
//     always holds it. When it does not (a damaged or partial file), the header cannot be inserted at
//     all, and one such row would refuse its chunk and, this loop breaking a table there, every
//     transfer after it. So it is left out and counted in `dropped`, which the restore reports as rows
//     not restored; the lines that named it keep their figures, unlinked (transferLinesForRestore).
// Pure, for the test.
export function transferHeadersForRestore(rows, existingClientIds, backupPeriodIds) {
  const clientsHere = new Set(existingClientIds || [])
  const periodsHere = new Set(backupPeriodIds || [])
  const kept = []
  let dropped = 0
  for (const r of rows || []) {
    if (!r.sent_period_id || !periodsHere.has(r.sent_period_id)) { dropped += 1; continue }
    const out = { ...r }
    if (out.to_client_id && !clientsHere.has(out.to_client_id)) out.to_client_id = null
    if (out.ended_period_id && !periodsHere.has(out.ended_period_id)) out.ended_period_id = null
    kept.push(out)
  }
  return { rows: kept, dropped }
}

// Stock transfer lines (S849, PNL-8). A line stands without its header: it carries the counterpart's
// name, the item, qty and rate. Its transfer_id is emptied when the header is not among those being
// restored (always so for a 'received' line, whose header is the sender's), as the SET NULL key
// would. A line whose own month is not in the backup cannot be inserted (period_id NOT NULL, NO
// ACTION), so it is left out and counted rather than refusing every line after it. Pure, for the test.
export function transferLinesForRestore(rows, headerIdsInBackup, backupPeriodIds) {
  const headers = new Set(headerIdsInBackup || [])
  const periodsHere = backupPeriodIds ? new Set(backupPeriodIds) : null
  const kept = []
  let dropped = 0
  for (const r of rows || []) {
    if (periodsHere && !periodsHere.has(r.period_id)) { dropped += 1; continue }
    kept.push(r.transfer_id && !headers.has(r.transfer_id) ? { ...r, transfer_id: null } : r)
  }
  return { rows: kept, dropped }
}

// ── The client row (S849 DATABASE-7) ────────────────────────────────────────────────────────────
// Delete → recreate → Restore used to bring back the data and none of the client row, silently: the
// Suite add-on, its date and the outlet group were simply gone. A restore must not change what a
// client PAYS, or which group's Owners reach it (GROUP-11), on its own, so it writes neither: it fills
// only the identity and legal details the target has left blank, and NAMES every commercial and
// structural value the backup had that the target does not, so the operator re-enters what still
// applies in Billing.
export const CLIENT_IDENTITY_COLUMNS = [
  'location', 'contact_person', 'contact_phone', 'legal_name', 'pan_no', 'registered_address',
  'signatory_name', 'signatory_title',
]
export const CLIENT_ROW_RESTORE_SELECT = [
  'id', ...CLIENT_IDENTITY_COLUMNS,
  'plan', 'billing_cycle', 'subscription_ends_at', 'ims_enabled', 'ims_ends_at', 'hr_enabled', 'hr_ends_at',
  'pos_enabled', 'pos_ends_at', 'customization_enabled', 'customization_ends_at', 'suite_plan', 'suite_ends_at',
  'is_internal', 'group_id',
].join(', ')

const blankValue = v => v == null || String(v).trim() === ''
const tierName = plan => ({ starter: 'Starter', growth: 'Growth', pro: 'Pro' }[plan] || 'Starter')

// → { fill, notes }: `fill` = the blank identity columns to write; `notes` = one line naming what was
// not restored, or null. `groupName` is the backup's outlet group by name (the export annotates it).
// Pure, for the test.
export function clientRowRestorePlan(exported, target, { groupName } = {}) {
  if (!exported) return { fill: {}, notes: null }
  const t = target || {}
  const fill = {}
  for (const col of CLIENT_IDENTITY_COLUMNS) {
    if (!blankValue(exported[col]) && blankValue(t[col])) fill[col] = exported[col]
  }
  const until = d => (d ? ` to ${formatAdAsBs(d)}` : '')
  const same = (a, b) => (a ?? null) === (b ?? null)
  const parts = []
  const imsOn = exported.ims_enabled !== false
  if (imsOn && (t.ims_enabled === false || !same(exported.plan, t.plan) || !same(exported.ims_ends_at, t.ims_ends_at))) {
    parts.push(`IMS ${tierName(exported.plan)}${until(exported.ims_ends_at)}`)
  }
  if (exported.subscription_ends_at && !same(exported.subscription_ends_at, t.subscription_ends_at)) {
    parts.push(`the subscription date${until(exported.subscription_ends_at)}`)
  }
  if (exported.billing_cycle === 'annual' && t.billing_cycle !== 'annual') parts.push('annual billing')
  const moduleLine = (label, on, end, tOn, tEnd) => {
    if (on && (!tOn || !same(end, tEnd))) parts.push(`${label} on${until(end)}`)
  }
  moduleLine('HR', !!exported.hr_enabled, exported.hr_ends_at, !!t.hr_enabled, t.hr_ends_at)
  moduleLine('POS', !!exported.pos_enabled, exported.pos_ends_at, !!t.pos_enabled, t.pos_ends_at)
  moduleLine('Customization', !!exported.customization_enabled, exported.customization_ends_at, !!t.customization_enabled, t.customization_ends_at)
  if (exported.suite_plan === 'pro' && (t.suite_plan !== 'pro' || !same(exported.suite_ends_at, t.suite_ends_at))) {
    parts.push(`Crest Suite Pro${exported.suite_ends_at ? until(exported.suite_ends_at) : ' (no end date)'}`)
  }
  if (exported.is_internal === true && t.is_internal !== true) parts.push('the "Demo outlet, not a customer" switch')
  if (exported.group_id && !same(exported.group_id, t.group_id)) {
    parts.push(groupName ? `outlet group '${groupName}'` : 'an outlet group that no longer exists')
  }
  const notes = parts.length
    ? `Not restored, re-enter in Billing if this client should still have them: ${parts.join(', ')}.`
    : null
  return { fill, notes }
}

// Tables a backup carries that the loop below deliberately does not insert, each with the reason
// the operator is shown when the backup holds rows of it (header). A table in neither list is
// reported as not restored (restoreCoverage), so a new exported table cannot drop out silently.
export const RESTORE_LEFT_OUT = {
  ims_count_assignments:     'stock-count sections are ticked again by the manager, because the logins they named come back with new ids',
  onboarding_progress:       "each person's setup checklist starts again, because it keys on logins that come back with new ids",
  pos_guest_order_requests:  "guests' QR orders are live till traffic, accepted or declined at the time, and are kept in the backup file only",
  pos_payment_confirmations: "QR payment confirmations are the payment provider's own record, kept in the backup file only",
}
// Restored by their own steps rather than the loop: the client row and settings (below), and the
// logins with their PIN vault (restore_staff_accounts / relink_staff_accounts in ClientDrawer).
export const RESTORED_ELSEWHERE = ['clients', 'settings', 'profiles', 'staff_pin_vault']

// What the backup holds that no step restores: the left-out tables with rows (a note, not a
// failure) and any table nothing here knows (a failure, so it is said). Pure, for the test.
export function restoreCoverage(data) {
  const leftOut = []
  const unknown = []
  for (const [table, rows] of Object.entries(data || {})) {
    if (!Array.isArray(rows) || rows.length === 0) continue
    if (RESTORE_ORDER.includes(table) || RESTORED_ELSEWHERE.includes(table)) continue
    if (RESTORE_LEFT_OUT[table]) leftOut.push({ table, rows: rows.length, why: RESTORE_LEFT_OUT[table] })
    else unknown.push({ table, rows: rows.length })
  }
  return { leftOut, unknown }
}

// The line for a table whose rows did not all come back: which table, how many rows, and the
// database's own reason (the operator reads it; S809 DATABASE-3).
export function lostRowsLine(table, total, restored, reason) {
  const missing = total - restored
  return `${table}: ${missing.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} row${total === 1 ? '' : 's'} not restored (${reason})`
}

const CHUNK = 500

// Must match exportClientData.js's list. supervisor_id left it in S798 (DATABASE-4): it is an
// employee id, restored by the second pass below, not a profiles id.
export function isAttributionColumn(key) {
  return key.endsWith('_by') || key === 'custodian_user_id'
}

// Strips what must not be inserted, and re-points the row at the target client.
//
// Attribution UUIDs are nulled because they reference profiles rows that may no longer exist
// (a full delete removes the auth users first), which would otherwise raise a FK violation on
// nearly every table. Safe because S543 established by grep that no *_by column is ever filtered
// on — they are display lookups. The readable half survives in the artifact's *_by_name fields.
function prepareRow(table, row, clientId) {
  const out = {}
  for (const [k, v] of Object.entries(row)) {
    // The export's `<column>_name` beside each attribution id is an annotation, not a column. Testing
    // only `_by_name` let `custodian_user_id_name` through, which would fail the whole table (S798).
    if (k.endsWith('_name') && isAttributionColumn(k.slice(0, -'_name'.length))) continue
    if ((GENERATED_COLUMNS[table] || []).includes(k)) continue
    if ((DEFERRED_LINKS[table] || []).includes(k)) continue
    out[k] = isAttributionColumn(k) ? null : v
  }
  if ('client_id' in row) out.client_id = clientId
  // Items are stored in their smallest unit — purchase_qty is always 1, so `rate` is the price of
  // one base unit. A backup taken before that rule could carry a pack size, which would restore as
  // a row whose `rate` means something different from every other item's (and trip the CHECK).
  // Value-preserving: per_uom_rate is rate / purchase_qty either way, so no figure a restore
  // rebuilds moves.
  if (table === 'items' && parseFloat(out.purchase_qty) > 1 && out.rate != null) {
    out.rate = parseFloat((parseFloat(out.rate) / parseFloat(out.purchase_qty)).toFixed(6))
    out.purchase_qty = 1
  }
  return out
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// `items_client_name_key` (S707) is one name per client, case-insensitive, covering sub-recipe
// mirrors and hidden items. Every backup taken before that index existed can carry duplicates —
// they were exactly what the index was added to stop — and this loop breaks a table on its first
// failing chunk, so ONE such pair would abandon the client's entire item book and then every table
// that references it.
//
// So the artifact is deduped on the way in, with the same '-DUP<n>' rename the migration uses:
// a restore must never lose a row, and a renamed item keeps its id, so every purchase, count and
// recipe line still points at it. The names are returned so the operator is told rather than left
// to find them — a '-DUP2' is a real pre-existing split that someone now has to merge or retire.
function dedupeItemNames(rows) {
  const taken = new Set()
  const renamed = []
  const out = rows.map(row => {
    const original = String(row.name ?? '')
    let name = original
    let n = 1
    while (taken.has(name.trim().toLowerCase())) {
      n += 1
      name = `${original}-DUP${n}`
    }
    taken.add(name.trim().toLowerCase())
    if (name !== original) renamed.push(name)
    return name === original ? row : { ...row, name }
  })
  return { rows: out, renamed }
}

// Refuses to write into a client that already holds data.
//
// These are inserts, not upserts, so restoring over a live client would duplicate every row and
// silently double their books — a worse outcome than the data loss a restore is meant to undo.
// Clearing first (Danger Zone) is the deliberate, separately-confirmed path to a true replace.
async function assertEmpty(clientId) {
  const probes = ['items', 'recipes', 'monthly_periods', 'hr_employees', 'pos_orders']
  const counts = {}
  let probesRun = 0
  for (const table of probes) {
    const { count, error } = await supabase
      .from(table).select('id', { count: 'exact', head: true }).eq('client_id', clientId)
    if (error) continue // one failing probe is not evidence either way — but see the check below
    probesRun++
    counts[table] = count || 0
  }
  // Fail CLOSED when nothing could be verified. The old `continue` alone meant five failing
  // probes let the restore proceed into a possibly-live client and duplicate every row —
  // the guard the rules file states as absolute held only when a probe both ran and hit (S574).
  if (probesRun === 0) {
    throw new Error('Could not verify this client is empty (all emptiness checks failed) — not restoring. Check the connection and retry.')
  }

  // "+ New Client" seeds one open monthly_periods row, so the natural recovery path — deleted by
  // mistake → recreate → restore — used to dead-end here on "1 rows in monthly_periods", pointing
  // the operator at a destructive Danger Zone action against a brand-new client. A single period
  // with nothing in it is indistinguishable from that seed, so it is removed rather than treated
  // as data; the backup's own periods are inserted in its place (S574).
  if (counts.monthly_periods === 1 && probes.every(t => t === 'monthly_periods' || counts[t] === 0)) {
    const { data: seedPeriods } = await supabase
      .from('monthly_periods').select('id').eq('client_id', clientId)
    const seedId = seedPeriods?.[0]?.id
    if (seedId) {
      const { count: pe } = await supabase
        .from('purchase_entries').select('id', { count: 'exact', head: true }).eq('period_id', seedId)
      const { count: se } = await supabase
        .from('sales_entries').select('id', { count: 'exact', head: true }).eq('period_id', seedId)
      if ((pe || 0) === 0 && (se || 0) === 0) {
        const { error: delErr } = await supabase.from('monthly_periods').delete().eq('id', seedId)
        if (!delErr) counts.monthly_periods = 0
      }
    }
  }

  for (const table of probes) {
    if ((counts[table] || 0) > 0) {
      throw new Error(
        `This client already has data (${counts[table]} rows in ${table}). Restore only into an empty client — ` +
        `clear it from the Danger Zone first if you intend to replace it.`,
      )
    }
  }
}

/**
 * @param clientId  target client — must be empty
 * @param parsed    the parsed .json artifact ({ manifest, data })
 * @returns { inserted, tables, skipped, notes, renamed } — `skipped` lists only what did NOT come
 *   back (any entry means the restore is incomplete); `notes` are expected, nothing lost.
 */
export async function restoreClientData(clientId, parsed, { onProgress = () => {} } = {}) {
  if (!clientId) throw new Error('restoreClientData: clientId is required')
  const { manifest, data } = parsed || {}
  if (!data || manifest?.schema !== 'crest-client-export') {
    throw new Error('Not a Crest client export file.')
  }

  await assertEmpty(clientId)

  let inserted = 0
  let tables = 0
  const skipped = []
  // Lines that are not a loss: the kept feature flags, and tables left out by design (S809 DATABASE-6).
  const notes = []
  // Rows that landed under a changed name. Separate from `skipped`, which means "did not restore":
  // these DID restore, and reporting them as skipped would say the opposite of what happened.
  const renamed = []
  let done = 0
  // The stock transfer headers this restore inserts, for the lines' links (S849).
  let restoredTransferIds = []

  const coverage = restoreCoverage(data)
  for (const t of coverage.unknown) {
    skipped.push(lostRowsLine(t.table, t.rows, 0, 'this restore has no step for that table'))
  }
  for (const t of coverage.leftOut) {
    notes.push(`${t.table} (${t.rows.toLocaleString('en-IN')} row${t.rows === 1 ? '' : 's'}) not restored by design: ${t.why}.`)
  }

  for (const table of RESTORE_ORDER) {
    done++
    let rows = data[table]
    if (!rows || rows.length === 0) continue
    onProgress(table, done, RESTORE_ORDER.length)

    if (table === 'items') {
      const deduped = dedupeItemNames(rows)
      rows = deduped.rows
      renamed.push(...deduped.renamed)
    }
    if (table === 'pos_orders') rows = partBillsAfterParents(rows)
    // Stock transfers (S849): empty the links that point outside what is restored, and leave out a
    // row whose month the backup does not hold (it could not be inserted), saying how many.
    if (table === 'ims_stock_transfers' || table === 'ims_stock_transfer_lines') {
      const periodIds = (data.monthly_periods || []).map(p => p.id)
      let shaped
      if (table === 'ims_stock_transfers') {
        const toIds = [...new Set(rows.map(r => r.to_client_id).filter(Boolean))]
        let existing = []
        if (toIds.length) {
          const { data: found, error: findErr } = await supabase.from('clients').select('id').in('id', toIds)
          // A failed read is not "every receiver is gone": keep the links and let the key decide, so
          // nothing is emptied on a guess. A gone receiver then refuses its chunk, which is reported.
          if (findErr) console.error('restore ims_stock_transfers: receiving outlets read failed:', findErr.message)
          existing = findErr ? toIds : (found || []).map(c => c.id)
        }
        shaped = transferHeadersForRestore(rows, existing, periodIds)
        restoredTransferIds = shaped.rows.map(r => r.id)
      } else {
        shaped = transferLinesForRestore(rows, restoredTransferIds, periodIds)
      }
      if (shaped.dropped) {
        skipped.push(lostRowsLine(table, rows.length, rows.length - shaped.dropped,
          "its month is not in this backup's own months, so it cannot be put back"))
      }
      rows = shaped.rows
      if (!rows.length) continue
    }

    let tableFailed = false
    let tableRestored = 0
    for (const part of chunk(rows, CHUNK)) {
      const payload = part.map(r => prepareRow(table, r, clientId))
      const { error } = await supabase.from(table).insert(payload)
      if (error) {
        // One unrestorable table must not abandon the other sixty. Report it and continue —
        // a partial restore that names its gaps is far more useful than an aborted one.
        console.error(`restore ${table}:`, error.message)
        if (table === 'feature_flags' && /duplicate key/i.test(error.message)) {
          // Expected on every Archive → Restore: the live flags row was deliberately kept and
          // deliberately wins. The raw constraint name read as a failure at the end of the
          // product's own recommended recovery path (S574). A note, not a loss.
          notes.push("feature_flags (kept this client's existing feature access).")
        } else {
          // How many rows stayed behind, not only which table (S809 DATABASE-3): the chunks before
          // this one did land.
          skipped.push(lostRowsLine(table, rows.length, tableRestored, error.message))
        }
        tableFailed = true
        break
      }
      inserted += payload.length
      tableRestored += payload.length
    }
    if (!tableFailed) tables++
  }

  // Settings — exported by every backup and, until S574, restored by nothing: a Delete →
  // recreate → Restore round trip silently came back with default branding, no VAT number, no
  // invoice prefix (POS invoice numbering keys off it) and no payment QR. Not in RESTORE_ORDER
  // because it needs update-or-insert against the row createClient seeds, not a bare insert.
  const settingsRows = (data.settings || []).filter(r => r.client_id)
  if (settingsRows.length) {
    const src = settingsRows[0]
    const { id: _id, client_id: _cid, ...fields } = src
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).limit(1)
    const op = existing?.length
      ? supabase.from('settings').update(fields).eq('id', existing[0].id)
      : supabase.from('settings').insert({ ...fields, client_id: clientId })
    const { error: setErr } = await op
    if (setErr) skipped.push(`settings (${setErr.message})`)
    else { inserted += 1; tables++ }
  }

  // The client row (S849 DATABASE-7): fill the identity details the target left blank, and name the
  // commercial and structural values this restore does not write (clientRowRestorePlan).
  const exportedClient = (data.clients || [])[0] || null
  if (exportedClient) {
    const { data: target, error: targetErr } = await supabase
      .from('clients').select(CLIENT_ROW_RESTORE_SELECT).eq('id', clientId).single()
    if (targetErr) {
      skipped.push(`clients (this client's details could not be read, so its blank contact and legal details were not filled: ${targetErr.message})`)
    } else {
      let groupName = exportedClient.group_name_exported || null
      if (!groupName && exportedClient.group_id) {
        const { data: grp, error: grpErr } = await supabase
          .from('client_groups').select('name').eq('id', exportedClient.group_id).maybeSingle()
        if (grpErr) console.error('restore: outlet group name read failed:', grpErr.message)
        groupName = grp?.name || null
      }
      const plan = clientRowRestorePlan(exportedClient, target, { groupName })
      if (Object.keys(plan.fill).length) {
        const { error: fillErr } = await supabase.from('clients').update(plan.fill).eq('id', clientId)
        if (fillErr) skipped.push(`clients (blank contact and legal details not filled: ${fillErr.message})`)
      }
      if (plan.notes) notes.push(plan.notes)
    }
  }

  // Second pass for the circular POS link, now that both sides exist. Since S809 2e a restored
  // note's own trigger (pos_credit_note_settle) links its bill as it is inserted, so this writes the
  // value already there, which guard_pos_order_close lets through unchanged; it stays for a link the
  // trigger did not make.
  const orderLinks = (data.pos_orders || []).filter(o => o.credit_note_id)
  for (const order of orderLinks) {
    const { error } = await supabase
      .from('pos_orders').update({ credit_note_id: order.credit_note_id }).eq('id', order.id)
    if (error) skipped.push(`pos_orders.credit_note_id for ${order.id} (${error.message})`)
  }

  // Second pass for "Reports to" (S798 DATABASE-4), now that every employee exists. One update per
  // supervisor rather than per employee, chunked because the ids travel in the URL.
  const teams = new Map()
  for (const e of data.hr_employees || []) {
    if (!e.supervisor_id) continue
    if (!teams.has(e.supervisor_id)) teams.set(e.supervisor_id, [])
    teams.get(e.supervisor_id).push(e.id)
  }
  for (const [supervisorId, ids] of teams) {
    const { error } = await runChunkedByIds(ids, part =>
      supabase.from('hr_employees').update({ supervisor_id: supervisorId }).in('id', part))
    if (error) skipped.push(`hr_employees.supervisor_id for ${ids.length} employee(s) (${error.message})`)
  }

  return { inserted, tables, skipped, notes, renamed }
}
